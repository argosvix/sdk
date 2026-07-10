import type { ArgosvixConfig, LlmCallRecord, ObservationRecord } from "./types.js";
import { BudgetGate } from "./budgetGate.js";
import {
  hasAnyRedaction,
  mergeRedactionCounts,
  redactPii,
  redactPiiWithCounts,
  redactToolCall,
  type RedactionCounts,
} from "./redaction.js";
import { SDK_VERSION } from "./version.js";

/**
 * Plaintext body limit for backend ingest (same value as
 * MAX_PLAINTEXT_BODY_BYTES = 64 * 1024 in the backend's ingest handler). The
 * backend checks `promptBody.length` (UTF-16 code unit count), so the SDK
 * counts in the same unit (not UTF-8 bytes — the name says BYTES but the
 * actual check is in code units).
 */
export const INGEST_MAX_BODY_UNITS = 64 * 1024;
/** Marker in the same format as the streaming capture (client.ts STREAM_TRUNCATED_MARKER). */
export const BODY_TRUNCATED_MARKER = "…[truncated]";

/**
 * Truncate a body before sending. The backend rejects an over-limit record
 * wholesale, so records with 64KB-256KB bodies used to disappear silently.
 * Fit within the limit including the marker, and never split a surrogate pair
 * at the cut point (do not send a broken lone surrogate).
 */
export function truncateBodyForIngest(text: string): string {
  if (text.length <= INGEST_MAX_BODY_UNITS) return text;
  let end = INGEST_MAX_BODY_UNITS - BODY_TRUNCATED_MARKER.length;
  const code = text.charCodeAt(end - 1);
  // If the char just before the cut point is a high surrogate, we are mid-pair — cut one unit earlier.
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return text.slice(0, end) + BODY_TRUNCATED_MARKER;
}

/**
 * Per-wrap() instance-based recorder.
 * Avoids module-level global state to keep test isolation clean and to let
 * parallel wrapped clients maintain independent buffers.
 *
 * Backend delivery uses fetch POST to `config.endpoint`. If `apiKey` is unset
 * or `disabled` is true, the recorder runs in local-only mode and skips POST.
 */
export class Recorder {
  private buffer: LlmCallRecord[] = [];
  // Parallel buffer for observations (non-LLM nodes emitted by withSpan). Sent
  // alongside records through the same flush path, as observations[] in the ingest body.
  private obsBuffer: ObservationRecord[] = [];
  private readonly config: ArgosvixConfig;
  /**
   * Tracks the most recently started flush so that callers can serialize behind it.
   * A fire-and-forget `void this.flush()` from `record()` (triggered when the buffer
   * fills) starts an in-flight POST that `flushClient()` must wait on; otherwise
   * Workers / Lambda may return while that POST is still in flight, killing it.
   */
  private inFlightFlush: Promise<LlmCallRecord[]> | null = null;
  /**
   * One-shot timer for periodic flushes (armed only when the buffer goes from
   * empty to non-empty). A permanent setInterval is avoided because it blocks
   * GC and a forgotten unref keeps the Node process alive. Cleared when a
   * flush starts. On short-lived host runtimes (Workers/Edge) timer delivery
   * is not guaranteed, so an explicit flushClient() remains required, as documented.
   */
  private idleFlushTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Runtime budget gate (active only when config.budgetGate is opted in;
   * otherwise a complete no-op). The wrapper awaits check() before each LLM call.
   */
  readonly budgetGate: BudgetGate;

  constructor(config: ArgosvixConfig = {}) {
    this.config = config;
    this.budgetGate = new BudgetGate(config);
  }

  /**
   * While records sit in the buffer, schedule exactly one flush after
   * flushIntervalMs. Does nothing if already scheduled, disabled, without an
   * apiKey, or with an interval of 0.
   */
  private scheduleIdleFlush(): void {
    if (this.idleFlushTimer != null) return;
    if (this.config.disabled || !this.config.apiKey) return;
    const intervalMs = this.config.flushIntervalMs ?? 5000;
    if (intervalMs <= 0) return;
    try {
      const timer = setTimeout(() => {
        this.idleFlushTimer = null;
        if (this.buffer.length > 0 || this.obsBuffer.length > 0) {
          void this.flush();
        }
      }, intervalMs);
      // Node: don't keep the process alive just for this timer. Workers/Edge have no unref.
      (timer as { unref?: () => void }).unref?.();
      this.idleFlushTimer = timer;
    } catch {
      // Environments without setTimeout don't support periodic flush — they rely on an explicit flushClient().
    }
  }

  /** ObservationSink: whether this recorder can send observations (not when disabled or without an apiKey). */
  get observationsEnabled(): boolean {
    return !this.config.disabled && !!this.config.apiKey;
  }

  /** ObservationSink: routing key (the api_key) used to prevent cross-account sends. */
  get observationsRoutingKey(): string | undefined {
    return this.config.apiKey;
  }

  record(record: LlmCallRecord): void {
    if (this.config.disabled) return;
    // Observation is best-effort: never leak a synchronous throw from the
    // recording path into the host app. In particular, when called from a
    // stream wrapper's finally block, a throw here would propagate through the
    // generator's .return() into the customer's break/abandon path, violating
    // the public promise that recording never breaks the customer's app.
    try {
      // Local spend adjustment within the TTL cache window (only added when budgetGate is opted in).
      this.budgetGate.noteSpend(record.costUsd);
      // SDK-side opt-in for the Pro+ plaintext storage feature. When
      // captureContent is false (the default), the recorder reliably strips
      // plaintext even if a wrapper mistakenly attached it (a second safety
      // net against wrapper bugs). When captureContent is true, PII is
      // automatically masked unless disablePiiRedaction is explicitly true.
      const sanitized = this.sanitizeContent(record);
      this.buffer.push(sanitized);

      // Guard `process` access — some edge runtimes (Cloudflare Workers in
      // certain modes, Vercel Edge) do not expose a Node `process` global, and
      // an unguarded `process.env[...]` reference would throw and break the
      // host LLM call we are wrapping.
      if (
        typeof process !== "undefined" &&
        process.env != null &&
        process.env["ARGOSVIX_DEBUG"] === "1"
      ) {
        // Log the sanitized payload (what is actually sent). Logging the raw
        // record would leak pre-redaction PII / plaintext into the customer's
        // logging infrastructure. With disablePiiRedaction=true the sanitized
        // payload is also raw — that is the customer's explicit choice.
        try {
          // eslint-disable-next-line no-console
          console.log("[argosvix]", JSON.stringify(sanitized));
        } catch {
          // Even if stringify throws (circular references etc.), never break the host for the sake of a debug log.
        }
      }

      const maxSize = this.config.bufferMaxSize ?? 100;
      if (this.buffer.length >= maxSize) {
        void this.flush();
      } else {
        // Schedule a periodic flush when the buffer goes from empty to non-empty
        // (prevents silent loss on low-traffic, long-lived Node processes where
        // records never reach bufferMaxSize and vanish at shutdown).
        this.scheduleIdleFlush();
      }
    } catch {
      // Observation must not break the host app. Swallow exceptions from the recording path.
    }
  }

  /** Buffer an observation (a typed node emitted by withSpan).
   * The error field is auto-collected from exception messages and can contain
   * prompt fragments / PII / secrets, so like records it goes through
   * redaction (opt-out possible) plus a length cap before sending. */
  recordObservation(obs: ObservationRecord): void {
    if (this.config.disabled) return;
    let safe = obs;
    if (typeof obs.error === "string" && obs.error.length > 0) {
      const disableRedaction = this.config.disablePiiRedaction === true;
      const cleaned = disableRedaction ? obs.error : redactPii(obs.error);
      safe = { ...obs, error: cleaned.slice(0, 2000) };
    }
    this.obsBuffer.push(safe);
    const maxSize = this.config.bufferMaxSize ?? 100;
    if (this.obsBuffer.length >= maxSize) {
      void this.flush();
    } else {
      // As in record(), schedule a periodic flush so even low-traffic buffers are sent within a bounded time.
      this.scheduleIdleFlush();
    }
  }

  /**
   * Flush the buffer to the backend with retry.
   * 5xx and network errors are retried; 4xx (client errors) are not.
   * Backoff is 200ms * attempt# (so 200, 400, 600, ...).
   * If all attempts fail the records are dropped and logged via console.error
   * (durable persistence is intentionally out of scope for the MVP).
   * Errors are never thrown — backend outages must not break the host application.
   *
   * Concurrent flush calls are serialized via `inFlightFlush`. An auto-flush
   * triggered by `bufferMaxSize` and a subsequent explicit `flushClient()`
   * both await the same promise instead of racing.
   */
  async flush(): Promise<LlmCallRecord[]> {
    // Cancel any scheduled idle flush timer (this flush sweeps the buffer, so a second firing is unnecessary).
    if (this.idleFlushTimer != null) {
      clearTimeout(this.idleFlushTimer);
      this.idleFlushTimer = null;
    }
    // Wait behind any in-flight flush so callers (e.g. flushClient in a Worker
    // handler's `finally`) cannot return before earlier records reach the backend.
    if (this.inFlightFlush) {
      try {
        await this.inFlightFlush;
      } catch {
        // Errors from the prior flush are already logged inside doFlush; swallow here.
      }
    }
    if (this.buffer.length === 0 && this.obsBuffer.length === 0) return [];
    const records = this.buffer.splice(0);
    const observations = this.obsBuffer.splice(0);

    const promise = this.doFlush(records, observations);
    this.inFlightFlush = promise;
    try {
      return await promise;
    } finally {
      if (this.inFlightFlush === promise) {
        this.inFlightFlush = null;
      }
    }
  }

  private async doFlush(
    records: LlmCallRecord[],
    observations: ObservationRecord[] = [],
  ): Promise<LlmCallRecord[]> {
    if (this.config.disabled || !this.config.apiKey) {
      return records;
    }

    const endpoint = this.config.endpoint ?? "https://ingest.argosvix.com/v1/ingest";
    const attempts = this.config.flushRetryAttempts ?? 2;

    // Send X-Project-Id as an ingest header: when config.projectId is set the
    // backend associates the records with that project; when unset the backend
    // falls back to the account's default project.
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.config.apiKey}`,
    };
    if (this.config.projectId) {
      headers["X-Project-Id"] = this.config.projectId;
    }

    for (let i = 0; i < attempts; i++) {
      try {
        const res = await fetch(endpoint, {
          method: "POST",
          headers,
          // If there are observations, send them in the same POST (when empty, send records only, as before).
          body: JSON.stringify(
            observations.length > 0 ? { records, observations } : { records },
          ),
        });
        if (res.ok) {
          // Surface partial rejects when the backend returns 200 + rejected[].
          try {
            const body = (await res.json()) as {
              accepted?: number;
              rejected?: Array<{ id: string; reason: string }>;
            };
            if (body.rejected && body.rejected.length > 0) {
              // eslint-disable-next-line no-console
              console.warn(
                `[argosvix] backend rejected ${body.rejected.length} record(s):`,
                body.rejected,
              );
            }
          } catch {
            // Ignore body parse failures — be tolerant of backend shape drift.
          }
          return records;
        }
        if (res.status >= 500 && i < attempts - 1) {
          await new Promise((r) => setTimeout(r, 200 * (i + 1)));
          continue;
        }
        // 429 = monthly quota reached. Because sends are fire-and-forget the app
        // never sees this, and recording would silently stop at end of month —
        // so warn explicitly, once (added 2026-07-03).
        if (res.status === 429) {
          warnQuotaExceededOnce();
          return records;
        }
        // eslint-disable-next-line no-console
        console.error(
          `[argosvix] flush POST returned ${res.status} (attempt ${i + 1}/${attempts})`,
        );
        return records;
      } catch (err) {
        if (i < attempts - 1) {
          await new Promise((r) => setTimeout(r, 200 * (i + 1)));
          continue;
        }
        // eslint-disable-next-line no-console
        console.error(
          `[argosvix] flush POST failed after ${attempts} attempts:`,
          err,
        );
        return records;
      }
    }
    return records;
  }

  /**
   * Process the record's plaintext fields (promptBody / completionBody /
   * toolCalls) according to the captureContent / disablePiiRedaction combination:
   *
   *   captureContent = false (default) → remove all plaintext fields
   *   captureContent = true, disablePiiRedaction = false (default) → apply redaction
   *   captureContent = true, disablePiiRedaction = true → pass through unmodified
   */
  private sanitizeContent(record: LlmCallRecord): LlmCallRecord {
    const capture = this.config.captureContent === true;
    const disableRedaction = this.config.disablePiiRedaction === true;
    // The error field is metadata that is always sent to the backend regardless
    // of captureContent, and provider error messages can contain prompt
    // fragments / PII / secrets. So as long as redaction is enabled, redact the
    // error even with captureContent OFF (a previous implementation only
    // processed promptBody/completionBody/toolCalls and let error pass through untouched).
    const redactedError =
      !disableRedaction && typeof record.error === "string"
        ? redactPii(record.error)
        : undefined;
    if (!capture) {
      const noBodies =
        record.promptBody === undefined &&
        record.completionBody === undefined &&
        record.toolCalls === undefined;
      if (noBodies && (redactedError === undefined || redactedError === record.error)) {
        return record;
      }
      const stripped: LlmCallRecord = { ...record };
      delete stripped.promptBody;
      delete stripped.completionBody;
      delete stripped.toolCalls;
      if (redactedError !== undefined) stripped.error = redactedError;
      return stripped;
    }
    if (disableRedaction) {
      // Capture ON + redaction OFF = pass through unmodified (the user explicitly
      // opted out). The error field stays raw under the same policy. However,
      // exceeding the backend's 64KB limit rejects the whole record (silent
      // loss), so body truncation is still applied even with redaction OFF.
      const p =
        record.promptBody !== undefined
          ? truncateBodyForIngest(record.promptBody)
          : undefined;
      const c =
        record.completionBody !== undefined
          ? truncateBodyForIngest(record.completionBody)
          : undefined;
      if (p === record.promptBody && c === record.completionBody) return record;
      const untouched: LlmCallRecord = { ...record };
      if (p !== undefined) untouched.promptBody = p;
      if (c !== undefined) untouched.completionBody = c;
      return untouched;
    }
    const out: LlmCallRecord = { ...record };
    if (redactedError !== undefined) out.error = redactedError;
    // Aggregate each field's redaction result and counts, and attach
    // piiRedacted + redactionMetadata to the record. This feeds the backend's
    // llm_calls.pii_redacted and redaction_metadata columns.
    let totalCounts: RedactionCounts = {};
    if (record.promptBody !== undefined) {
      const r = redactPiiWithCounts(record.promptBody);
      // Truncate after redaction (replacement changes the length, so judge by the final sent length).
      out.promptBody = truncateBodyForIngest(r.text);
      totalCounts = mergeRedactionCounts(totalCounts, r.counts);
    }
    if (record.completionBody !== undefined) {
      const r = redactPiiWithCounts(record.completionBody);
      out.completionBody = truncateBodyForIngest(r.text);
      totalCounts = mergeRedactionCounts(totalCounts, r.counts);
    }
    if (record.toolCalls !== undefined) {
      out.toolCalls = record.toolCalls.map((call) => {
        const redacted = redactToolCall(call);
        if (call.arguments !== undefined) {
          const r = redactPiiWithCounts(call.arguments);
          totalCounts = mergeRedactionCounts(totalCounts, r.counts);
        }
        if (call.result !== undefined) {
          const r = redactPiiWithCounts(call.result);
          totalCounts = mergeRedactionCounts(totalCounts, r.counts);
        }
        return redacted;
      });
    }
    if (hasAnyRedaction(totalCounts)) {
      out.piiRedacted = true;
      // Embed the SDK version in the redactor identifier so the dashboard and
      // backend can audit which SDK version performed the redaction (e.g. to
      // trace cases where an older SDK missed patterns introduced after its
      // release, such as new gTLDs). From a data-minimization standpoint the
      // SDK version is not PII, so this is unproblematic.
      out.redactionMetadata = { ...totalCounts, redactor: `argosvix-sdk@${SDK_VERSION}` };
    } else {
      // To let the backend distinguish "redaction ran but found nothing", we
      // could set piiRedacted = false here. For compatibility with existing
      // records we leave it unset (undefined), which the backend interprets as
      // a null fallback.
    }
    return out;
  }

  getBufferSize(): number {
    return this.buffer.length;
  }

  /**
   * Test-only helper. Do not call from production code.
   * The underscore prefix marks this as internal-only.
   */
  __resetForTesting(): void {
    this.buffer.splice(0);
    this.inFlightFlush = null;
  }
}

// Warn-once for 429 (monthly quota reached). Repeating on every flush would pollute logs, so once per process.
let quotaWarned = false;
function warnQuotaExceededOnce(): void {
  if (quotaWarned) return;
  quotaWarned = true;
  // eslint-disable-next-line no-console
  console.warn(
    "[argosvix] monthly quota exceeded — new records are being rejected until the next billing month. " +
      "Check usage at https://dashboard.argosvix.com/settings/billing",
  );
}

/** Test-only: resets the warn-once flag. */
export function _resetQuotaWarn(): void {
  quotaWarned = false;
}
