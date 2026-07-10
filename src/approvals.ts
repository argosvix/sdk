/**
 * Human approval gate SDK API (part of the runtime control plane).
 *
 * Call this before a dangerous agent operation (deletion, money transfer,
 * account cancellation, etc.). It creates an approval request on the Argosvix
 * backend and sends an email notification to the account owner.
 * `waitForApproval()` blocks until a human approves or denies the request via
 * the dashboard (/approvals) or the email link.
 *
 * Design:
 *   - An explicit API independent of wrap() (scoped per operation, not per
 *     LLM call)
 *   - A backend-side timeout or an exceeded waitForApproval wait returns
 *     "expired" / "denied" — i.e. default-deny. Callers must abort the
 *     operation for any status other than "approved".
 *   - Polling defaults to a 5-second interval plus jitter. The backend read
 *     rate limit is 60/min per account, so only about ~5 approvals can be
 *     awaited concurrently (excess polls get 429 and retry on the next tick,
 *     which is safe but slower).
 *
 * @example
 * import { requestApproval, waitForApproval } from "@argosvix/sdk";
 *
 * const approval = await requestApproval({
 *   apiKey: "argk_...",
 *   action: "delete_user",
 *   summary: "Delete user usr_123 (LTV $0, inactive for 90 days)",
 * });
 * const status = await waitForApproval({ apiKey: "argk_...", id: approval.id });
 * if (status !== "approved") throw new Error(`not approved: ${status}`);
 */

const DEFAULT_API_BASE = "https://ingest.argosvix.com";
const INGEST_SUFFIX = "/v1/ingest";
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const MIN_POLL_INTERVAL_MS = 1_000;
const DEFAULT_WAIT_TIMEOUT_MS = 3_600_000;
const REQUEST_TIMEOUT_MS = 10_000;

export type ApprovalStatus = "pending" | "approved" | "denied" | "expired";

export interface ApprovalRequestShape {
  id: string;
  action: string;
  summary: string;
  metadata: unknown;
  status: ApprovalStatus;
  expiresAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
  createdAt: string;
}

export class ArgosvixApprovalError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null = null) {
    super(`[argosvix] approval: ${message}`);
    this.name = "ArgosvixApprovalError";
    this.status = status;
  }
}

export interface ApprovalClientOptions {
  /** Argosvix API key (required). */
  apiKey: string;
  /**
   * API base override (for self-hosting / tests). Defaults to
   * https://ingest.argosvix.com. If an ArgosvixConfig.endpoint value
   * (.../v1/ingest) is passed, the prefix is derived from it.
   */
  endpoint?: string;
  /**
   * Project to associate approvals with (sent as the X-Project-Id header, the
   * same mechanism as a record's projectId). When unset, the backend falls
   * back to the account's default project (backward compatible).
   */
  projectId?: string;
}

function apiBase(opts: ApprovalClientOptions): string {
  const ep = opts.endpoint;
  if (!ep) return DEFAULT_API_BASE;
  if (ep.endsWith(INGEST_SUFFIX)) return ep.slice(0, -INGEST_SUFFIX.length);
  return ep.replace(/\/$/, "");
}

async function callApi(
  opts: ApprovalClientOptions,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${apiBase(opts)}${path}`, {
      method: init.method ?? "GET",
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
        ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(opts.projectId ? { "X-Project-Id": opts.projectId } : {}),
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      signal: controller.signal,
    });
  } catch (err) {
    throw new ArgosvixApprovalError(
      `network error: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    clearTimeout(timer);
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok) {
    const message =
      body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string"
        ? ((body as { error: string }).error)
        : `HTTP ${res.status}`;
    throw new ArgosvixApprovalError(message, res.status);
  }
  return body;
}

export interface RequestApprovalParams extends ApprovalClientOptions {
  /** Operation identifier (1-128 chars, [A-Za-z0-9._: -]). Example: "delete_user" */
  action: string;
  /** One-line human-readable description (1-500 chars). Shown verbatim in the approval email. */
  summary: string;
  /** Supplementary JSON object (up to 4KB, optional). */
  metadata?: Record<string, unknown>;
  /** Approval deadline in seconds (60-86400, default 3600). Expiry means "expired", treated as deny. */
  timeoutSeconds?: number;
}

/** Create an approval request. Sends an email notification to the account owner. */
export async function requestApproval(
  params: RequestApprovalParams,
): Promise<ApprovalRequestShape> {
  const body: Record<string, unknown> = {
    action: params.action,
    summary: params.summary,
  };
  if (params.metadata !== undefined) body["metadata"] = params.metadata;
  if (params.timeoutSeconds !== undefined) body["timeoutSeconds"] = params.timeoutSeconds;
  const res = (await callApi(params, "/v1/gate/approvals", {
    method: "POST",
    body,
  })) as { approval?: ApprovalRequestShape };
  if (!res || !res.approval) {
    throw new ArgosvixApprovalError("unexpected response shape");
  }
  return res.approval;
}

/** Fetch the current state of an approval request once. */
export async function getApproval(
  params: ApprovalClientOptions & { id: string },
): Promise<ApprovalRequestShape> {
  const res = (await callApi(
    params,
    `/v1/gate/approvals/${encodeURIComponent(params.id)}`,
  )) as { approval?: ApprovalRequestShape };
  if (!res || !res.approval) {
    throw new ArgosvixApprovalError("unexpected response shape");
  }
  return res.approval;
}

export interface WaitForApprovalParams extends ApprovalClientOptions {
  id: string;
  /** Polling interval in ms (default 5000, minimum 1000). */
  pollIntervalMs?: number;
  /**
   * Maximum wait in ms (default 1 hour). On exceeding it, returns "expired"
   * — i.e. default-deny. Independent of the backend-side request timeout
   * (whichever is shorter takes effect first).
   */
  timeoutMs?: number;
}

/**
 * Poll until the request is approved, denied, or expired, then return the
 * final status. If anything other than "approved" is returned, the caller
 * must not execute the operation (default-deny).
 */
export async function waitForApproval(
  params: WaitForApprovalParams,
): Promise<Exclude<ApprovalStatus, "pending">> {
  const baseInterval = Math.max(
    MIN_POLL_INTERVAL_MS,
    params.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
  );
  const deadline = Date.now() + (params.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS);
  for (;;) {
    let status: ApprovalStatus | null = null;
    try {
      const approval = await getApproval(params);
      status = approval.status;
    } catch (err) {
      // Transient network errors / 429 are retried on the next poll; permanent 4xx errors are thrown.
      if (
        err instanceof ArgosvixApprovalError &&
        err.status !== null &&
        err.status !== 429 &&
        err.status < 500
      ) {
        throw err;
      }
    }
    if (status && status !== "pending") return status;
    if (Date.now() >= deadline) return "expired";
    // Jitter (0-20%) prevents multiple agents' polls from synchronizing and pinning the rate limit.
    const jitter = baseInterval * 0.2 * Math.random();
    await new Promise((resolve) => setTimeout(resolve, baseInterval + jitter));
  }
}
