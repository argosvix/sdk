import type { ArgosvixConfig } from "./types.js";
import { scanPolicyViolation } from "./policyScan.js";

/**
 * Runtime budget gate — the SDK-side enforcement half of the runtime control plane.
 *
 * When opted in via `config.budgetGate: true`, each LLM call made through a
 * wrapped client is evaluated locally against the backend `/v1/gate/budget`
 * configuration plus the current month's spend; if the monthly limit is
 * exceeded, an `ArgosvixBudgetExceededError` is thrown and the call is blocked.
 *
 * Design:
 *   - Configuration and spend are cached with a TTL (the backend response's
 *     ttlSeconds, default 60s). There is no round trip per call.
 *   - stale-while-revalidate: while a snapshot exists, evaluation happens
 *     immediately even when stale, and the refresh runs in the background so
 *     the fetch RTT never sits on the hot path. A synchronous await happens in
 *     only two situations: the very first call before any snapshot exists, and
 *     a stale snapshot with a fail_closed gate.
 *   - Failure backoff: after a failed fetch, no retry happens for
 *     FAILURE_RETRY_MS. This prevents a 3-second blocking fetch on every call
 *     while the backend is down.
 *   - Spend accrued between TTL refreshes is compensated by local accumulation
 *     via the recorder. On a successful fetch, only the amount accumulated as
 *     of fetch start is subtracted, so spend recorded while the fetch was in
 *     flight is not silently dropped.
 *   - Time is measured on a monotonic clock (performance.now). This prevents
 *     the cache from staying fresh forever when the wall clock steps backwards
 *     (NTP step / VM resume).
 *   - fail_open (default): when the backend is unreachable or configuration has
 *     not been fetched, calls pass through.
 *   - fail_closed: when the backend gate is configured fail_closed and the
 *     cache is stale beyond MAX_STALE_MULTIPLIER x TTL, throw
 *     ArgosvixBudgetGateUnavailableError. Behavior before the first successful
 *     fetch is chosen via `config.budgetGateFailClosed` (default false).
 *   - Calls blocked by the gate are still ingested as error records through the
 *     wrapper, so "how many calls were blocked" is visible in the dashboard and
 *     chat.
 *
 * Known limitation:
 *   - Methods the SDK does not wrap (e.g. Anthropic `messages.stream()`,
 *     Python's `generate_content_stream`) are neither observed nor enforced.
 *     See the budgetGate doc comment in types.ts for details.
 */

const DEFAULT_GATE_ENDPOINT = "https://ingest.argosvix.com/v1/gate/config";
const INGEST_SUFFIX = "/v1/ingest";

const FETCH_TIMEOUT_MS = 3_000;
const DEFAULT_TTL_MS = 60_000;
// Minimum retry interval after a failed fetch (protects the hot path during outages)
const FAILURE_RETRY_MS = 30_000;
// If the cache has not been refreshed within this multiple of the TTL, treat the gate state as unknown
const MAX_STALE_MULTIPLIER = 5;

/**
 * Canonical form of a model name. Strips the "models/" provider prefix that
 * Gemini-family SDKs keep (e.g. "models/gemini-pro") so allowlist comparison
 * behaves identically in the TypeScript and Python SDKs. Exported for tests
 * and for cross-verification against the Python implementation.
 */
export function canonicalizeModelName(model: string): string {
  return model.startsWith("models/") ? model.slice("models/".length) : model;
}

export class ArgosvixBudgetExceededError extends Error {
  readonly spentUsd: number;
  readonly limitUsd: number;
  constructor(spentUsd: number, limitUsd: number) {
    super(
      `[argosvix] budget gate: monthly spend $${spentUsd.toFixed(4)} reached the limit $${limitUsd.toFixed(2)}; call blocked before the provider request`,
    );
    this.name = "ArgosvixBudgetExceededError";
    this.spentUsd = spentUsd;
    this.limitUsd = limitUsd;
  }
}

export class ArgosvixBudgetGateUnavailableError extends Error {
  constructor() {
    super(
      "[argosvix] runtime gate: gate state is unavailable and enforce mode is fail_closed; call blocked",
    );
    this.name = "ArgosvixBudgetGateUnavailableError";
  }
}

export type PolicyViolationReason =
  | "model_not_allowed"
  | "pii_detected"
  | "secret_detected";

export class ArgosvixPolicyViolationError extends Error {
  readonly reason: PolicyViolationReason;
  readonly detail: string;
  constructor(reason: PolicyViolationReason, detail: string) {
    super(`[argosvix] policy gate: ${detail}; call blocked before the provider request`);
    this.name = "ArgosvixPolicyViolationError";
    this.reason = reason;
    this.detail = detail;
  }
}

interface PolicySnapshot {
  allow: Set<string> | null;
  blockPii: boolean;
  blockSecrets: boolean;
  enforceMode: "fail_open" | "fail_closed";
}

interface GateSnapshot {
  fetchedAtMs: number;
  ttlMs: number;
  /** Account-wide budget gate (projectId null + enabled). Null when not configured. */
  gate: { limitUsd: number; enforceMode: "fail_open" | "fail_closed" } | null;
  spentUsd: number;
  /**
   * The enabled project gate matching this client's config.projectId.
   * Null when not applicable (no projectId, or no matching gate). Evaluated
   * with AND semantics alongside the account gate: exceeding either one blocks
   * the call (the strictest limit wins).
   */
  projectGate: { limitUsd: number; enforceMode: "fail_open" | "fail_closed" } | null;
  /** This project's current-month spend (spentUsdByProject[projectId]). */
  projectSpentUsd: number;
  /**
   * Per-tag budget gates (enabled only). When a call's tags contain
   * tagKey===tagValue, that gate is evaluated with AND semantics alongside the
   * account/project gates (the strictest limit wins). spentUsd is the per-tag
   * current-month spend returned by the backend.
   */
  tagGates: Array<{
    tagKey: string;
    tagValue: string;
    limitUsd: number;
    enforceMode: "fail_open" | "fail_closed";
    spentUsd: number;
  }>;
  /** Policy gate (kept only when enabled). Null when not configured or disabled. */
  policy: PolicySnapshot | null;
}

/** Call context the wrapper passes to check(). */
export interface GateCheckContext {
  /** Model name of the request (backfilled from the payload on paths where it is not directly available). */
  model?: string | undefined;
  /** Request payload sent to the provider (subject to the policy gate's PII / secret scan). */
  payload?: unknown;
  /** Effective tags of this call (used to decide which tag gates apply). */
  tags?: Record<string, string> | undefined;
}

/** Local-spend key for a tag gate (tagKey and tagValue joined via JSON encoding). */
function tagSpendKey(tagKey: string, tagValue: string): string {
  return JSON.stringify([tagKey, tagValue]);
}

export class RuntimeGate {
  private readonly config: ArgosvixConfig;
  private snapshot: GateSnapshot | null = null;
  private inflight: Promise<void> | null = null;
  private lastAttemptMs: number | null = null;
  private lastAttemptFailed = false;
  private warnedEndpoint = false;
  private warnedNoPolicy = false;
  /** Spend recorded by this process since the last successful fetch (local compensation). */
  private localSpendUsd = 0;
  /** Per-tag local spend compensation (key = JSON([tagKey,tagValue])). */
  private tagLocalSpend = new Map<string, number>();

  constructor(config: ArgosvixConfig) {
    this.config = config;
  }

  /** Monotonic clock; unaffected by wall-clock regressions (NTP step / VM resume). */
  private now(): number {
    return typeof performance !== "undefined" ? performance.now() : Date.now();
  }

  /**
   * Whether the gate can actually enforce anything (used by the fully
   * compatible wrap to decide its identity fast path). When false, check()
   * returns immediately, so the pre-call await can be skipped and the original
   * APIPromise returned as-is.
   */
  get isActive(): boolean {
    return this.active;
  }

  /** Active only when opted in and configured for sending; otherwise a complete no-op. */
  private get active(): boolean {
    return (
      (this.config.budgetGate === true || this.config.policyGate === true) &&
      this.config.disabled !== true &&
      typeof this.config.apiKey === "string" &&
      this.config.apiKey.length > 0
    );
  }

  /**
   * Called from recorder.record(). Local spend compensation within the TTL
   * window. Tag gates are matched against config.tags: every call made by
   * this client carries config.tags, so all calls accrue to the matching tag
   * gates, just like the project gate.
   */
  noteSpend(costUsd: number): void {
    if (this.config.budgetGate !== true || !this.active) return;
    if (!(Number.isFinite(costUsd) && costUsd > 0)) return;
    this.localSpendUsd += costUsd;
    const tags = this.config.tags;
    if (tags && this.snapshot) {
      for (const tg of this.snapshot.tagGates) {
        if (tags[tg.tagKey] === tg.tagValue) {
          const k = tagSpendKey(tg.tagKey, tg.tagValue);
          this.tagLocalSpend.set(k, (this.tagLocalSpend.get(k) ?? 0) + costUsd);
        }
      }
    }
  }

  /**
   * Enforcement right before the LLM call. Throws when the limit is exceeded,
   * passes through otherwise. Backend outages fail open or fail closed
   * according to the enforce mode.
   */
  async check(ctx: GateCheckContext = {}): Promise<void> {
    if (!this.active) return;

    const snap = this.snapshot;
    if (!snap) {
      // First call (or nothing fetched yet). Inside the backoff window, skip the fetch and evaluate as-is.
      if (this.attemptAllowed()) await this.refresh();
    } else if (this.isStale(snap)) {
      if (this.attemptAllowed()) {
        const p = this.refresh();
        const anyFailClosed =
          (this.config.budgetGate === true &&
            snap.gate?.enforceMode === "fail_closed") ||
          (this.config.budgetGate === true &&
            snap.projectGate?.enforceMode === "fail_closed") ||
          (this.config.budgetGate === true &&
            snap.tagGates.some((t) => t.enforceMode === "fail_closed")) ||
          (this.config.policyGate === true &&
            snap.policy?.enforceMode === "fail_closed");
        if (anyFailClosed) {
          // fail_closed may block on stale data, so refresh synchronously and prioritize accuracy
          await p;
        } else {
          // fail_open uses stale-while-revalidate (keeps the fetch RTT off the hot path)
          p.catch(() => {});
        }
      }
    }
    this.evaluate(ctx);
  }

  private evaluate(ctx: GateCheckContext): void {
    const snap = this.snapshot;
    if (!snap) {
      // Nothing has ever been fetched, so the server-side enforce mode is
      // unknown. Fail closed only via the local opt-ins
      // (budgetGateFailClosed / policyGateFailClosed): even if the backend is
      // configured fail_closed, the SDK cannot know that on a cold start, so
      // strict operation requires an explicit opt-in.
      if (
        (this.config.budgetGateFailClosed === true ||
          this.config.policyGateFailClosed === true) &&
        this.lastAttemptFailed
      ) {
        throw new ArgosvixBudgetGateUnavailableError();
      }
      return;
    }

    const ageMs = this.now() - snap.fetchedAtMs;
    const isUnknownStale = ageMs < 0 || ageMs > snap.ttlMs * MAX_STALE_MULTIPLIER;

    if (this.config.budgetGate === true && snap.gate) {
      const gate = snap.gate;
      if (isUnknownStale && gate.enforceMode === "fail_closed") {
        throw new ArgosvixBudgetGateUnavailableError();
      }
      const spent = snap.spentUsd + this.localSpendUsd;
      if (spent >= gate.limitUsd) {
        throw new ArgosvixBudgetExceededError(spent, gate.limitUsd);
      }
    }

    // The project gate is also evaluated with AND semantics (the strictest
    // limit wins). Every call from this client belongs to config.projectId,
    // so localSpendUsd counts toward the project spend as well.
    if (this.config.budgetGate === true && snap.projectGate) {
      const pg = snap.projectGate;
      if (isUnknownStale && pg.enforceMode === "fail_closed") {
        throw new ArgosvixBudgetGateUnavailableError();
      }
      const projectSpent = snap.projectSpentUsd + this.localSpendUsd;
      if (projectSpent >= pg.limitUsd) {
        throw new ArgosvixBudgetExceededError(projectSpent, pg.limitUsd);
      }
    }

    // Tag gates matching this client's config.tags are evaluated with AND
    // semantics. Matching is fixed to config.tags, the same basis noteSpend
    // uses: mixing in ctx.tags would create an asymmetric loophole where spend
    // accrues under config.tags but a call slips through because ctx.tags does
    // not match. Like the project gate, tag gates are evaluated against the
    // client's fixed tags by design.
    const tags = this.config.tags;
    if (this.config.budgetGate === true && snap.tagGates.length > 0 && tags) {
      for (const tg of snap.tagGates) {
        if (tags[tg.tagKey] !== tg.tagValue) continue;
        if (isUnknownStale && tg.enforceMode === "fail_closed") {
          throw new ArgosvixBudgetGateUnavailableError();
        }
        const k = tagSpendKey(tg.tagKey, tg.tagValue);
        const tagSpent = tg.spentUsd + (this.tagLocalSpend.get(k) ?? 0);
        if (tagSpent >= tg.limitUsd) {
          throw new ArgosvixBudgetExceededError(tagSpent, tg.limitUsd);
        }
      }
    }

    if (this.config.policyGate === true && snap.policy) {
      const policy = snap.policy;
      if (isUnknownStale && policy.enforceMode === "fail_closed") {
        throw new ArgosvixBudgetGateUnavailableError();
      }
      this.evaluatePolicy(policy, ctx);
    }
  }

  /** Local evaluation of the policy gate (model allowlist / PII / secrets). */
  private evaluatePolicy(policy: PolicySnapshot, ctx: GateCheckContext): void {
    const model =
      ctx.model ??
      (ctx.payload && typeof ctx.payload === "object"
        ? (ctx.payload as { model?: unknown }).model
        : undefined);
    if (policy.allow) {
      if (typeof model === "string" && model.length > 0) {
        if (!policy.allow.has(canonicalizeModelName(model))) {
          // The model name can be an arbitrary string coming from the payload,
          // so it is sanitized before appearing in the error message: allowed
          // charset only, capped at 128 characters. This is a structural
          // defense against plaintext such as prompts leaking into error
          // records.
          const safeModel = model.replace(/[^A-Za-z0-9._:/-]/g, "?").slice(0, 128);
          throw new ArgosvixPolicyViolationError(
            "model_not_allowed",
            `model "${safeModel}" is not in the configured allowlist`,
          );
        }
      } else if (policy.enforceMode === "fail_closed") {
        // An allowlist is configured but the model cannot be resolved (neither
        // ctx.model nor payload.model is available on this path). fail_open
        // passes the call through as before (the default forbids false
        // positives), but fail_closed blocks under the strict semantics "stop
        // any call that cannot be checked against the allowlist" — closing an
        // earlier no-block gap via opt-in.
        throw new ArgosvixPolicyViolationError(
          "model_not_allowed",
          "request model could not be resolved to check against the allowlist (fail_closed)",
        );
      }
    }

    if ((policy.blockPii || policy.blockSecrets) && ctx.payload !== undefined) {
      const hit = scanPolicyViolation(ctx.payload, {
        pii: policy.blockPii,
        secrets: policy.blockSecrets,
      });
      if (hit) {
        throw new ArgosvixPolicyViolationError(
          hit.kind === "secret" ? "secret_detected" : "pii_detected",
          `request payload contains ${hit.kind === "secret" ? "a credential-like token" : "PII"} (${hit.pattern}) at ${hit.path || "payload"} ("${hit.snippet}")`,
        );
      }
    }
  }

  private isStale(snap: GateSnapshot): boolean {
    const age = this.now() - snap.fetchedAtMs;
    return age < 0 || age >= snap.ttlMs;
  }

  /** If the last fetch failed, do not retry until FAILURE_RETRY_MS has elapsed. */
  private attemptAllowed(): boolean {
    if (this.lastAttemptMs === null || !this.lastAttemptFailed) return true;
    return this.now() - this.lastAttemptMs >= FAILURE_RETRY_MS;
  }

  private refresh(): Promise<void> {
    if (!this.inflight) {
      this.lastAttemptMs = this.now();
      this.inflight = this.fetchOnce().finally(() => {
        this.inflight = null;
      });
    }
    return this.inflight;
  }

  /**
   * Resolves the gate endpoint. When the ingest endpoint is overridden, the
   * gate endpoint is derived from the same prefix; if it cannot be derived
   * (a custom URL not ending in /v1/ingest), the gate is disabled instead.
   * This avoids sending a Bearer key meant for another environment to
   * production.
   */
  private gateEndpoint(): string | null {
    if (this.config.gateEndpoint) return this.config.gateEndpoint;
    const endpoint = this.config.endpoint;
    if (endpoint) {
      if (endpoint.endsWith(INGEST_SUFFIX)) {
        return endpoint.slice(0, -INGEST_SUFFIX.length) + "/v1/gate/config";
      }
      if (!this.warnedEndpoint) {
        this.warnedEndpoint = true;
        // eslint-disable-next-line no-console
        console.warn(
          "[argosvix] budget gate: cannot derive gate endpoint from custom ingest endpoint; set config.gateEndpoint explicitly. Gate enforcement is disabled.",
        );
      }
      return null;
    }
    return DEFAULT_GATE_ENDPOINT;
  }

  private async fetchOnce(): Promise<void> {
    const url = this.gateEndpoint();
    if (url === null) {
      this.lastAttemptFailed = true;
      return;
    }
    // To avoid dropping spend noted via noteSpend while the fetch is in
    // flight, capture the compensation amount at fetch start and subtract only
    // that delta on success.
    const localAtStart = this.localSpendUsd;
    // Copy the per-tag local spend at fetch start for the same rebase, mirroring the account-level approach.
    const tagLocalAtStart = new Map(this.tagLocalSpend);
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      let res: Response;
      try {
        res = await fetch(url, {
          method: "GET",
          headers: { Authorization: `Bearer ${this.config.apiKey}` },
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      if (!res.ok) {
        // Consume the body so connection reuse is not blocked
        await res.arrayBuffer().catch(() => {});
        this.lastAttemptFailed = true;
        return; // keep the old snapshot; evaluate() decides based on the enforce mode
      }

      const raw = (await res.json()) as Record<string, unknown> | null;
      // Accept the /v1/gate/config shape { budget: {...}, policy: {...},
      // ttlSeconds } first, and also the older /v1/gate/budget shape
      // { gates, spentUsdThisMonth, ttlSeconds } (a configuration where
      // gateEndpoint is overridden to point at the budget endpoint).
      const isObj = (v: unknown): v is Record<string, unknown> =>
        !!v && typeof v === "object" && !Array.isArray(v);
      const root = isObj(raw) ? raw : {};
      const budgetPart = isObj(root["budget"]) ? (root["budget"] as Record<string, unknown>) : root;
      const policyPart = isObj(root["policy"]) ? (root["policy"] as Record<string, unknown>) : null;
      if (
        this.config.policyGate === true &&
        !("policy" in root) &&
        !this.warnedNoPolicy
      ) {
        // With gateEndpoint pointed at the older /v1/gate/budget shape the
        // policy section is never received and the policy gate would be a
        // silent no-op, so warn about it once.
        this.warnedNoPolicy = true;
        // eslint-disable-next-line no-console
        console.warn(
          "[argosvix] policy gate: gate endpoint response has no policy section; point gateEndpoint at /v1/gate/config to enable policy enforcement.",
        );
      }

      const gates = Array.isArray(budgetPart["gates"])
        ? (budgetPart["gates"] as Array<Record<string, unknown>>)
        : [];
      const accountGate =
        gates.find(
          (g) =>
            isObj(g) &&
            (g["projectId"] === null || g["projectId"] === undefined) &&
            g["enabled"] === true &&
            typeof g["monthlyLimitUsd"] === "number" &&
            Number.isFinite(g["monthlyLimitUsd"]),
        ) ?? null;

      // Resolve the gate tied to this client's project (only when config.projectId is set).
      const projectId =
        typeof this.config.projectId === "string" && this.config.projectId.length > 0
          ? this.config.projectId
          : null;
      const projectGateRaw = projectId
        ? (gates.find(
            (g) =>
              isObj(g) &&
              g["projectId"] === projectId &&
              g["enabled"] === true &&
              typeof g["monthlyLimitUsd"] === "number" &&
              Number.isFinite(g["monthlyLimitUsd"]),
          ) ?? null)
        : null;
      const byProject = isObj(budgetPart["spentUsdByProject"])
        ? (budgetPart["spentUsdByProject"] as Record<string, unknown>)
        : {};
      const projectSpentRaw = projectId ? byProject[projectId] : undefined;

      // Resolve per-tag gates and join them with spentUsdByTag.
      const byTag = Array.isArray(budgetPart["spentUsdByTag"])
        ? (budgetPart["spentUsdByTag"] as Array<Record<string, unknown>>)
        : [];
      const tagSpentLookup = (tk: string, tv: string): number => {
        const hit = byTag.find(
          (e) => isObj(e) && e["tagKey"] === tk && e["tagValue"] === tv,
        );
        const v = hit ? hit["spentUsd"] : undefined;
        return typeof v === "number" && Number.isFinite(v) ? v : 0;
      };
      const tagGates = gates
        .filter(
          (g) =>
            isObj(g) &&
            typeof g["tagKey"] === "string" &&
            typeof g["tagValue"] === "string" &&
            g["enabled"] === true &&
            typeof g["monthlyLimitUsd"] === "number" &&
            Number.isFinite(g["monthlyLimitUsd"]),
        )
        .map((g) => ({
          tagKey: g["tagKey"] as string,
          tagValue: g["tagValue"] as string,
          limitUsd: g["monthlyLimitUsd"] as number,
          enforceMode: (g["enforceMode"] === "fail_closed" ? "fail_closed" : "fail_open") as
            | "fail_open"
            | "fail_closed",
          spentUsd: tagSpentLookup(g["tagKey"] as string, g["tagValue"] as string),
        }));

      let policy: PolicySnapshot | null = null;
      if (policyPart && policyPart["enabled"] === true) {
        const allowRaw = policyPart["modelAllowlist"];
        // Compare both the allowlist entries and the candidate in canonical
        // form (leading "models/" stripped). Some legacy Gemini SDKs keep the
        // model name as "models/gemini-pro" (the Python SDK's model_name)
        // while the TypeScript side sees the raw input value, which previously
        // caused a drift where only one side was blocked.
        const allow = Array.isArray(allowRaw)
          ? new Set(
              allowRaw
                .filter((m): m is string => typeof m === "string")
                .map(canonicalizeModelName),
            )
          : null;
        policy = {
          allow: allow && allow.size > 0 ? allow : null,
          blockPii: policyPart["blockPii"] === true,
          blockSecrets: policyPart["blockSecrets"] === true,
          enforceMode:
            policyPart["enforceMode"] === "fail_closed" ? "fail_closed" : "fail_open",
        };
      }

      const ttlSeconds = root["ttlSeconds"] ?? budgetPart["ttlSeconds"];
      const spentRaw = budgetPart["spentUsdThisMonth"];
      this.snapshot = {
        fetchedAtMs: this.now(),
        ttlMs:
          typeof ttlSeconds === "number" &&
          Number.isFinite(ttlSeconds) &&
          ttlSeconds > 0
            ? ttlSeconds * 1000
            : DEFAULT_TTL_MS,
        gate: accountGate
          ? {
              limitUsd: accountGate["monthlyLimitUsd"] as number,
              enforceMode:
                accountGate["enforceMode"] === "fail_closed"
                  ? "fail_closed"
                  : "fail_open",
            }
          : null,
        spentUsd:
          typeof spentRaw === "number" && Number.isFinite(spentRaw) ? spentRaw : 0,
        projectGate: projectGateRaw
          ? {
              limitUsd: projectGateRaw["monthlyLimitUsd"] as number,
              enforceMode:
                projectGateRaw["enforceMode"] === "fail_closed"
                  ? "fail_closed"
                  : "fail_open",
            }
          : null,
        projectSpentUsd:
          typeof projectSpentRaw === "number" && Number.isFinite(projectSpentRaw)
            ? projectSpentRaw
            : 0,
        tagGates,
        policy,
      };
      this.localSpendUsd = Math.max(0, this.localSpendUsd - localAtStart);
      // Also subtract the fetch-start amounts from the per-tag locals to avoid double counting (same approach as the account level).
      for (const [k, v] of this.tagLocalSpend) {
        this.tagLocalSpend.set(k, Math.max(0, v - (tagLocalAtStart.get(k) ?? 0)));
      }
      this.lastAttemptFailed = false;
    } catch {
      // Network error / timeout / malformed JSON: keep the old snapshot.
      // fail_open passes calls through; fail_closed is stopped by the
      // staleness check in evaluate().
      this.lastAttemptFailed = true;
    }
  }
}

// Backward-compatible alias for the originally published name (from when the gate was budget-only).
export { RuntimeGate as BudgetGate };
