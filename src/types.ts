// xai / moonshot = OpenAI 互換 API 経由の実プロバイダー(2026-07-17、baseURL 判別)
export type Provider = "openai" | "anthropic" | "gemini" | "mistral" | "xai" | "moonshot" | "deepseek" | "alibaba";

export interface ArgosvixConfig {
  /** Argosvix API key used to authenticate ingest POSTs. */
  apiKey?: string;
  /** Argosvix backend ingest endpoint (default: https://ingest.argosvix.com/v1/ingest). */
  endpoint?: string;
  /** Tags attached to every record (e.g. service / env / userId). */
  tags?: Record<string, string>;
  /**
   * Whether to automatically map the provider's opaque end-user identifier
   * (OpenAI: safety_identifier, Anthropic: metadata.user_id) into the `userId`
   * tag. Defaults to true. Apps already passing these to the provider get the
   * dashboard's per-user aggregation (/users) with zero configuration. The
   * legacy OpenAI `user` field is excluded because it tends to contain PII
   * (pass an explicit `tags.userId` if needed). An explicit `tags.userId`
   * takes precedence (it is never overwritten). Set false only to disable the
   * automatic capture.
   */
  captureUserId?: boolean;
  /**
   * Automatic trace-context propagation. On by default. LLM calls wrapped
   * inside `withTrace(fn)` are automatically grouped into the same trace
   * without an explicit traceId. Setting false ignores the ambient context and
   * builds traces only from an explicit config.traceId, as before.
   * Automatically disabled on runtimes without AsyncLocalStorage (e.g. Workers
   * without the nodejs_als flag).
   */
  autoContext?: boolean;
  /** Disable record submission entirely (e.g. for local dev). Defaults to false. */
  disabled?: boolean;
  /**
   * Periodic flush interval in milliseconds for long-lived processes (e.g. a
   * Node server). When records are buffered, a one-shot timer flushes them after
   * this delay even if `bufferMaxSize` is not reached. Defaults to 5000; set to 0
   * to disable. This is a best-effort convenience for long-lived runtimes, NOT a
   * shutdown guarantee — short-lived runtimes (Cloudflare Workers, Vercel Edge,
   * Lambda) do not reliably deliver timers, so you must still call `flushClient()`
   * before the handler returns.
   */
  flushIntervalMs?: number;
  /** Maximum number of records held in-memory before auto-flush. Defaults to 100. */
  bufferMaxSize?: number;
  /**
   * Total flush() retry attempts including the initial try. Defaults to 2 (initial + 1 retry).
   * 5xx and network errors are retried; 4xx (client errors) are not.
   * Backoff is exponential-ish: 200ms * attempt#.
   */
  flushRetryAttempts?: number;
  /**
   * Explicit provider override. Use this for composite or adapter clients where
   * shape-based fingerprinting is ambiguous. Omit to let the SDK auto-detect.
   */
  provider?: Provider;
  /**
   * Trace ID = the trace axis of the OTel subset (the group of related LLM
   * calls within one user request / job). When passed to wrap(), it is
   * automatically attached to every call record from this client (one wrap =
   * one trace). To share a trace across a multi-call chain, wrap with the same
   * traceId; for a different chain, use a separate wrap or the override
   * option. The format is up to the user (OTel hex / UUID / ULID / arbitrary
   * string), max 128 chars.
   */
  traceId?: string;
  /**
   * Span ID = the span identifier for the LLM calls issued by the wrapped
   * client. Deriving it dynamically per call is usually cleaner than fixing it
   * per wrap (a per-call option is planned for a later phase). The MVP allows
   * one wrap = one span via the wrap option (sub-calls inherit automatically),
   * though in practice a traceId alone is often sufficient.
   */
  spanId?: string;
  /**
   * Parent span ID = the span_id of this call's upstream / preceding call.
   * Fixing it per wrap targets the simple case where all sub LLM calls of a
   * given step share the same parent.
   */
  parentSpanId?: string;
  /**
   * Session ID = an arbitrary user-defined grouping axis (a continuous
   * conversation / the same daily session / the same job). A higher-level
   * concept than a trace (the OTel-style call group within one request); one
   * session may contain multiple traces. When passed to wrap(), it is
   * automatically attached to every call record and flows through the backend
   * /v1/query/session/:id into the dashboard's conversation thread view. The
   * format is up to the user (UUID / ULID / arbitrary string), max 128 chars
   * [A-Za-z0-9_-].
   *
   * Added 2026-06-02 in v0.4.0 (SDK side of session tracking).
   */
  sessionId?: string;
  /**
   * Enable plaintext content capture (the SDK-side opt-in for the Pro+
   * plaintext storage feature). Default false. When true, each wrapper
   * extracts the prompt / completion bodies and tool call arguments/results,
   * attaches them to the record, and sends them to the backend. They are
   * stored encrypted only when account.plaintext_storage_optin = 1 on the
   * backend (a global gate via the PLAINTEXT_STORAGE_ENABLED env is also applied).
   *
   * Before setting this flag to true, you must enable the plaintext storage
   * feature in the dashboard settings and give explicit consent in the consent
   * dialog. See https://argosvix.com/ja/docs/plaintext for details.
   */
  captureContent?: boolean;
  /**
   * Disable the built-in PII redaction filter that masks email / credit card /
   * phone / Japanese My Number / IP address before send. Default false
   * (redaction is ON). When true, content is sent unmodified — the user bears
   * the risk of personal data exposure (Terms of Service, Article 4-2,
   * Paragraph 7).
   *
   * When captureContent is false, no plaintext is sent at all, so this flag
   * has no effect.
   */
  disablePiiRedaction?: boolean;
  /**
   * Project ID. Used when observing multiple products under one account,
   * switching between them. Pro = up to 5 projects, Team = unlimited. When
   * passed to wrap(), it is automatically attached to the backend ingest path
   * as the `X-Project-Id` header (records get associated with that project).
   * When unset, records attach to the account's default project.
   *
   * A project_id not belonging to the account or already archived returns 404
   * from the backend; a malformed one (outside /^[A-Za-z0-9_-]{1,128}$/)
   * returns 400 (fail-closed).
   *
   * Details: https://argosvix.com/ja/docs/projects, or get the project list
   * and IDs from the dashboard under Settings → Projects.
   */
  projectId?: string;
  /**
   * Opt-in for the runtime budget gate (part of the runtime control plane).
   * When true, before each LLM call on a wrapped client, the SDK locally
   * evaluates the monthly budget settings plus current-month spend from the
   * backend `/v1/gate/budget`, and if the limit is exceeded it throws
   * ArgosvixBudgetExceededError to stop the call. Settings and spend use a TTL
   * cache (default 60s) — no round trip per call. A no-op on accounts without
   * a configured gate. Default false.
   *
   * Known limitation: methods the SDK does not wrap (e.g. Anthropic
   * `messages.stream()`, paths outside observation) are also outside
   * enforcement. See the README for the list of wrapped methods. To enforce
   * limits reliably, use only wrapped methods.
   */
  budgetGate?: boolean;
  /**
   * Opt-in for the runtime policy gate (part of the runtime control plane).
   * When true, before each LLM call the SDK locally evaluates the backend's
   * policy settings (model allowlist / PII block / secret block) and on a
   * violation throws ArgosvixPolicyViolationError to stop the call. Evaluation
   * runs inside the customer's process, not through a proxy. A no-op on
   * accounts without a policy. Can be opted into independently of budgetGate;
   * both share the same settings fetch (/v1/gate/config). Default false.
   */
  policyGate?: boolean;
  /**
   * Behavior while budgetGate / policyGate is true but the gate settings have
   * never been fetched from the backend. Default false (fail-open, calls pass).
   * When true, all calls are stopped with ArgosvixBudgetGateUnavailableError
   * until the fetch succeeds (a strict-operation opt-in). After the fetch, the
   * backend-side gate's enforceMode applies.
   */
  budgetGateFailClosed?: boolean;
  /**
   * Strict cold-start opt-in for policyGate. The backend's enforceMode
   * (fail_closed) can only be determined by the SDK after a snapshot has been
   * fetched once, so failures before the first fetch default to fail-open.
   * When true, all calls are stopped with ArgosvixBudgetGateUnavailableError
   * until the fetch succeeds. Same semantics as budgetGateFailClosed, for
   * setups using only the policy gate.
   */
  policyGateFailClosed?: boolean;
  /**
   * Override for where budget gate settings are fetched from (for self-hosting
   * / tests). When unset, /v1/gate/budget on the same origin as `endpoint`;
   * failing that, https://ingest.argosvix.com/v1/gate/budget.
   */
  gateEndpoint?: string;
}

export interface LlmCallRecord {
  /** Unique call ID (ULID-compatible string). */
  id: string;
  provider: Provider;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** Prompt-cache read tokens (a subset of promptTokens, billed at a discount). 0 if none. */
  cachedReadTokens?: number;
  /** Prompt-cache write tokens (Anthropic only, billed at a premium). 0 if none. */
  cachedWriteTokens?: number;
  /** USD value with 6 decimal places (sufficient for GPT-4o input $5 / 1M tokens granularity). */
  costUsd: number;
  /** USD saved by cache reads (the difference versus uncached input). 0 if none. */
  cacheSavingsUsd?: number;
  /** End-to-end call latency in milliseconds. */
  latencyMs: number;
  /** Time to first token in ms (streaming only; unset for non-streaming). */
  ttftMs?: number;
  /** Reasoning tokens (thinking models; e.g. OpenAI completion_tokens_details.reasoning_tokens). Unset if none. */
  reasoningTokens?: number;
  /** Audio tokens (input + output combined). Unset if none. */
  audioTokens?: number;
  /** ISO 8601 UTC timestamp. */
  timestamp: string;
  /** Merge of ArgosvixConfig.tags and any per-call tags. */
  tags: Record<string, string>;
  /** Error message string (only populated when the call threw). */
  error?: string;
  /**
   * Structured error info extracted from provider SDK errors (e.g. OpenAI APIError).
   * Includes statusCode / code / type / param — the metadata required for observability.
   */
  errorDetails?: {
    statusCode?: number;
    code?: string;
    type?: string;
    param?: string;
    retryAfter?: number;
  };
  /** Request payload overview. The full payload is intentionally NOT recorded to avoid storing prompt / completion bodies. Only safe metadata such as model name, message count, temperature, and max tokens. */
  requestMeta?: {
    messagesCount?: number;
    temperature?: number;
    maxTokens?: number;
  };
  /** OTel-subset trace axis — aggregated on the backend and shown in the waterfall view. */
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
  /**
   * Session axis = an arbitrary user-defined group above traces (a continuous
   * conversation / the same daily session / the same job). The backend
   * /v1/query/session/:id fetches the calls sharing a session_id, rendered
   * chronologically in the dashboard's conversation thread view.
   */
  sessionId?: string;
  /**
   * Plaintext prompt body (only set when ArgosvixConfig.captureContent is
   * true). The text body the user sent to the LLM API. If PII redaction is
   * enabled, email addresses, card numbers, etc. have been replaced with
   * [REDACTED_*].
   */
  promptBody?: string;
  /**
   * Plaintext completion body (only set when ArgosvixConfig.captureContent is
   * true). The response text body from the LLM API. PII redaction applied.
   */
  completionBody?: string;
  /**
   * Tool call (function calling) names, arguments, and results.
   * Only set when captureContent is true. The SDK extracts these from the
   * response's tool_calls / function_call fields. Arguments and results are
   * strings after PII redaction (possibly JSON strings).
   */
  toolCalls?: Array<{
    name: string;
    arguments?: string;
    result?: string;
  }>;
  /**
   * Flag set when at least one PII redaction was applied. True when the
   * SDK-side primary redaction (redactPiiWithCounts) detected and replaced any
   * of email / creditCard / myNumber / phone / ipv4 / ipv6. Stored in the
   * backend's llm_calls.pii_redacted column. Naturally false / unset when
   * disablePiiRedaction = true (content passed through unmodified).
   */
  piiRedacted?: boolean;
  /**
   * Per-category redaction counts plus the redactor identifier, as JSON.
   * Stored as-is in the backend's llm_calls.redaction_metadata column and
   * surfaced by the dashboard / MCP server for the audit display of which
   * types were detected and how many times.
   *
   * Example: { email: 2, phone: 1, creditCard: 0, redactor: "argosvix-sdk" }
   */
  redactionMetadata?: Record<string, unknown>;
}

/**
 * Typed / nested observation nodes (non-LLM steps). Beyond generations
 * (LlmCallRecord), span / event / retrieval / tool / agent / chain nodes are
 * emitted via `withSpan` and stored in the backend's observations table.
 * Warning: metadata must contain only non-sensitive structured attributes
 * (counts / sizes etc.).
 */
export type ObservationType =
  | "span"
  | "event"
  | "retrieval"
  | "tool"
  | "agent"
  | "chain";

export interface ObservationRecord {
  id: string;
  type: ObservationType;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name?: string;
  status?: "ok" | "error";
  startTime: string; // ISO 8601 UTC
  endTime?: string;
  latencyMs?: number;
  error?: string;
  metadata?: Record<string, unknown>;
  tags?: Record<string, string>;
}

export interface PricingEntry {
  /** USD per 1M input tokens. */
  inputPer1M: number;
  /** USD per 1M output tokens. */
  outputPer1M: number;
  /**
   * USD per 1M cached (read) input tokens, when the provider publishes a
   * per-model cached price that differs from the provider-wide multiplier
   * (e.g. OpenAI 5.x models read at 10% of input while 4o-era models read at
   * 50%). When absent, the provider-level CACHE_MULTIPLIERS ratio applies.
   */
  cachedInputPer1M?: number;
  /**
   * 長文脈の段階単価。⚠ **プロンプトが閾値に到達したら、その要求の全トークン**が
   * 高い方の単価になる(超えた分だけではない)。x.ai の表記は "requests whose prompt
   * reaches the listed token threshold are billed at the higher rate for all tokens
   * in the request"。
   *
   * これを持たないモデルは段階が無いか、まだ未対応(低い方で計算する)。
   */
  longContext?: {
    /** この値**以上**のプロンプトで高い段階になる。 */
    thresholdPromptTokens: number;
    inputPer1M: number;
    outputPer1M: number;
    cachedInputPer1M?: number;
  };
}
