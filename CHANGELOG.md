# Changelog

All notable changes to `@argosvix/sdk` are documented in this file.
The format is loosely based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.5.13 (2026-08-28)

- peerDependencies: `@anthropic-ai/sdk` を `^0.120.0` から `>=0.120.0` に、`@google/genai` を `^2.18.0` から `>=2.18.0` に拡大(v1 系 / 新 major の利用者が npm ERESOLVE を踏まないように。wrapper は provider SDK を import しない duck-typing のため構造依存なし)
- README: 冒頭の状態表記を「Alpha released」から「Live」に更新(表記のみ、機能変更なし)

## 0.5.12 (2026-08-23)

- pricing: GPT-5.6 Sol の値下げを反映(入力 $5→$4 / 出力 $30→$20 / キャッシュ入力 $0.5→$0.4、長文コンテキストは 2x/1.5x 規則のまま $8/$30/$0.8)。公式モデルページ・料金ページの実読で照合。プロモ価格(少なくとも 2026-11-21 まで)である旨は公式に明記


## [0.5.11] - 2026-08-05

### Added
- Alibaba Qwen support (8th provider). `wrap()` detects DashScope hosts
  (`dashscope.aliyuncs.com` / `dashscope-intl.aliyuncs.com` and other
  `dashscope*.aliyuncs.com` / `*.dashscope.aliyuncs.com` / `*.maas.aliyuncs.com`
  subdomains, plus `api.qwencloud.com` and `*.qwencloud.com`) and records with
  provider "alibaba". Pricing for `qwen3.8-max`: $2 in / $6 out / $0.25
  implicit-cache read per 1M tokens (single tier across the 1M context window,
  verified against qwencloud.com on 2026-08-05). Cache-hit input arrives via
  the OpenAI-compatible `usage.prompt_tokens_details.cached_tokens` and is
  priced separately.
- AI SDK middleware maps the `alibaba` / `qwen` / `dashscope` namespaces, and
  the LangChain callback maps `ChatAlibabaTongyi` / Qwen community wrappers,
  to provider "alibaba".

## [0.5.10] - 2026-07-31

### Changed
- Pricing: OpenAI cut GPT-5.6 Luna by 80% and Terra by 20% on 2026-07-30; the
  built-in pricing table now matches the official page. Luna: $0.20 in / $0.02
  cached / $1.20 out per 1M (long context $0.40 / $0.04 / $1.80). Terra: $2.00 in /
  $0.20 cached / $12.00 out per 1M (long context $4.00 / $0.40 / $18.00). Sol and
  GPT-5.5 are unchanged. Verified against developers.openai.com/api/docs/pricing.

## [0.5.9] - 2026-07-29

### Added
- `QueryAggregateFilter.tzOffsetMinutes` (TypeScript): typed support for local-day
  bucketing on `queryAggregate` with `groupBy: "day"` (integer minutes, -840..840,
  e.g. Tokyo = +540). The backend accepted the field already; this makes it part of
  the typed SDK surface. Python release 0.5.9 is a lockstep version bump with no
  functional change (the Python SDK has no query helper).

## [0.4.7-alpha.0] - 2026-06-27

### Added
- **`withSpan` — typed nested observations from your code.** Wrap a retrieval / tool /
  agent / chain step in `withSpan(type, name, fn)` and it records a typed observation
  (start, latency, status, error) while nesting any LLM calls made inside it under that
  span — so your trace shows the full agent tree, not just the LLM calls. Works sync and
  async; auto-opens a trace if none is active.
  - New exports: `withSpan`, `ObservationRecord`, `ObservationType`.
  - The span's `error` is auto-captured and PII-redacted + length-capped before sending
    (unless `disablePiiRedaction`). `metadata` is for non-sensitive structured attributes
    only (counts, sizes) — do not put raw content there.
  - Observations are sent on the same ingest path as call records. With multiple wrapped
    clients using different API keys, span observations are not emitted (to avoid sending
    to the wrong account); use one wrapped client per process for spans.

## [0.4.6-alpha.0] - 2026-06-27

### Added
- **Automatic trace context propagation** (`withTrace`). Wrap a unit of work in
  `withTrace(fn)` and every LLM call inside it is automatically grouped under one trace —
  no manual `traceId` threading — with each call assigned its own span, so chained agent
  steps nest correctly. Works across `await` via `AsyncLocalStorage`.
  - New exports: `withTrace`, `getAmbientTraceContext`, `TraceContext`.
  - Precedence: explicit `config.traceId` > ambient `withTrace` > none (standalone calls
    are unchanged). Opt out with `config.autoContext = false`.
  - Resolves `AsyncLocalStorage` without a static `node:async_hooks` import (uses the
    Workers global when present, else `process.getBuiltinModule` on Node 22+), so bundling
    for Edge/browser never breaks; degrades to no-op (calls still record) where unavailable.
  - Streaming calls snapshot their trace at call entry, so a stream created in `withTrace`
    but consumed later is still attributed correctly.

## [0.4.5-alpha.0] - 2026-06-27

### Added
- **Prompt-caching cost & savings tracking.** The wrapper now captures cached read/write
  tokens from each provider and records the discounted cost plus the amount saved by
  caching, across all OpenAI (chat non-stream/stream + Responses), Anthropic
  (non-stream/stream), and Gemini (legacy + new, non-stream/stream) call paths. Mistral
  has no prompt caching and is unaffected.
  - New `LlmCallRecord` fields: `cachedReadTokens`, `cachedWriteTokens`, `cacheSavingsUsd`.
  - New helper `calculateCostWithCache()`; `calculateCost()` delegates to it unchanged.
  - Per-provider cache multipliers (read/write vs base input rate), verified against
    official pricing on 2026-06-27: OpenAI 0.5/1.0, Anthropic 0.1/1.25 (5-min write TTL),
    Gemini 0.1/1.0, Mistral 1.0/1.0. Provider conventions for whether `promptTokens`
    includes cached tokens (OpenAI/Gemini: subset; Anthropic: separate) are handled.
  - Known approximation: Anthropic 1-hour cache writes (200%) are billed at the 5-minute
    rate (125%) since the token breakdown isn't carried; impact is small (writes are
    one-time, reads dominate savings).

## [0.4.4-alpha.0] - 2026-06-17

### Added
- **Automatic end-user attribution** (`captureUserId`, default on): the wrapper reads
  each provider's opaque end-user identifier and records it as the `userId` tag, so
  per-user breakdowns in the dashboard (`/users`) work with zero extra config when the
  app already passes one. Captured fields: OpenAI `safety_identifier`, Anthropic
  `metadata.user_id`.
  - The legacy OpenAI `user` field is intentionally **not** auto-captured (it commonly
    holds PII such as email / raw IDs). Pass `tags.userId` explicitly to record it.
  - An explicit `tags.userId` always wins; values are truncated to 256 chars; Gemini /
    Mistral are no-ops (no native field). Set `captureUserId: false` to disable.
  - The `userId` is resolved once at call entry and shared across success / error /
    stream records, so reusing or mutating the request object mid-call cannot misattribute it.

## [0.4.1-alpha.1] - 2026-06-02

### Added
- **PII redaction metadata** on every captured record (= v1.5 Round D 第1段):
  - `LlmCallRecord.piiRedacted` — `true` when at least one PII match was redacted
    in the prompt body, completion body, or any tool call argument/result.
  - `LlmCallRecord.redactionMetadata` — `Record<string, unknown>` carrying
    per-category counts plus a redactor identifier, e.g.
    `{ email: 2, phone: 1, redactor: "argosvix-sdk" }`.
  - Three new helpers: `redactPiiWithCounts(text)`, `mergeRedactionCounts(a, b)`,
    `hasAnyRedaction(counts)`. Existing `redactPii(text)` keeps the prior
    single-return-value shape for backwards compatibility.
- Per-pattern `type` tag on the redaction patterns (`email` / `creditCard` /
  `myNumber` / `phone` / `ipv4` / `ipv6`) so backend / dashboard can surface
  category-level audit information.

### Changed
- `Recorder.sanitizeContent` now uses `redactPiiWithCounts` instead of plain
  `redactPii`, aggregating counts across `promptBody`, `completionBody`, and
  every tool call's `arguments` / `result`. When any redaction happens, the
  record gains `piiRedacted = true` and `redactionMetadata`.

### Notes
- Backwards compatible: records that contain no PII still ship without the new
  fields (= backend reads them as NULL / falsy).
- Backend `argosvix-ingest` already has the `pii_redacted` / `redaction_metadata`
  columns on `llm_calls` (migration 0042). Ingest acceptance + query surface +
  dashboard badge are the follow-up commits.

## [0.4.0-alpha.1] - 2026-06-02

### Added
- **`ArgosvixConfig.sessionId`** — wrap-level session identifier. When supplied, every
  record produced by the wrapped client carries a `sessionId` field, enabling the
  backend `/v1/query/session/:id` endpoint and the upcoming dashboard conversation
  thread view to group calls across multiple traces (= same user conversation /
  daily session / long-running job).
- **`LlmCallRecord.sessionId`** — corresponding optional field on every record.
- `buildTraceMeta` helper now propagates `sessionId` alongside `traceId` / `spanId` /
  `parentSpanId` on the success and error paths of every provider wrapper.

### Notes
- Backwards compatible: omitting `sessionId` keeps the prior behavior (= no field
  set, backend stores `session_id` as NULL).
- Session id format: free-form string up to 128 chars, `[A-Za-z0-9_-]`. Caller is
  free to use UUID / ULID / short slug etc.
- Backend ingest path has accepted `sessionId` since 2026-05-31 (migration 0036),
  so this release is the SDK-side carry that closes the v1.5 "session tracking"
  end-to-end on the SDK + backend axis.

## [0.3.0-alpha.2] - 2026-06-02

Pre-release extending Pro+ plaintext capture to **OpenAI Responses API**.

### Added
- `wrapOpenAIResponses`: when `captureContent: true`, the SDK now extracts
  `promptBody`, `completionBody`, and `toolCalls` from the OpenAI Responses
  API response (non-stream success path). `input` is captured as-is when it
  is a string, or JSON-stringified when it is an array (multi-modal /
  structured input). `completionBody` prefers `response.output_text` when
  present, falling back to joining every `output_text` item inside
  `response.output[].content[]`. Tool calls are extracted from
  `output[]` items of `type === "function_call"`.

### Changed
- The one-time `console.warn` for unsupported providers no longer mentions
  "openai (Responses API)" — that path is now first-class.

### Provider coverage in this release
- **New:** OpenAI Responses (non-stream success path): prompt body,
  completion body, tool calls.
- Unchanged: OpenAI Chat Completions, Anthropic Messages.
- Still pending: Mistral, Gemini (Legacy / New), all streaming paths.

## [0.3.0-alpha.1] - 2026-06-01

Pre-release adding the **Pro+ plaintext content capture** feature. The SDK can
optionally send prompt and completion bodies in addition to metadata when the
user explicitly opts in via dashboard consent. The Argosvix backend is now
deployed with the storage feature enabled (`PLAINTEXT_STORAGE_ENABLED = true`
+ `PLAINTEXT_MASTER_KEY` secret seeded), so accounts that pass the dashboard
ConsentModal will have their captured bodies encrypted with AES-256-GCM and
stored in D1. The decrypt API (`GET /v1/calls/:id/plaintext`) and the
dashboard "Pro+ plaintext content" panel are also live, and every read
creates an entry in `plaintext_access_log` for auditing.

### Added
- `ArgosvixConfig.captureContent` (default `false`). When set to `true`, the
  SDK extracts prompt / completion text from supported providers and forwards
  them on the ingest payload. Without this flag, no plaintext is ever sent.
- `ArgosvixConfig.disablePiiRedaction` (default `false`). When `captureContent`
  is `true`, the SDK runs a built-in PII redaction pass (email, credit card,
  phone, マイナンバー, IPv4, IPv6) over the captured bodies before send.
  Setting this flag disables the filter at the user's own risk.
- `LlmCallRecord.promptBody`, `completionBody`, and `toolCalls` fields populated
  only when `captureContent` is `true`.
- New `redaction.ts` module with `redactPii()` and `redactToolCall()` helpers.
- Double safety net inside `Recorder.record()`: even if a wrapper accidentally
  attaches `promptBody` while `captureContent` is `false`, the recorder strips
  the field before buffering. This makes wrapper bugs non-leaky.

### Provider coverage in this release
- OpenAI Chat Completions (non-stream success path): prompt body, completion
  body, and tool calls captured.
- Anthropic Messages (non-stream success path): prompt body and completion body
  captured (tool calls in a follow-up).
- OpenAI Responses, Mistral, Gemini (Legacy and New): metadata still recorded,
  but `promptBody` / `completionBody` are omitted. A one-time `console.warn`
  fires when `captureContent` is enabled to make this visible.
- All streaming paths across every provider: same as above. Coverage will
  expand in `0.3.0-alpha.2+`.

### Notes
- This is an `alpha` pre-release published under the `alpha` dist-tag. `npm
  install @argosvix/sdk@alpha` to opt in. The `latest` dist-tag remains on
  0.2.0 (metadata-only) until the Pro+ feature graduates to a stable release.
- The dashboard ConsentModal (2-page consent dialog with 5 checkboxes), the
  per-account opt-in toggle, the legal documents (v2.1 with the new Article
  4-2 governing plaintext storage), and the decrypt + display path in the
  call detail screen are all live in production as of this release.
- Existing users who do not set `captureContent` are unaffected. The default
  behavior — metadata-only ingest — is byte-identical to 0.2.0.

## [0.1.2] - 2026-05-22

Documentation-only release that aligns the npm README with global SaaS norms.

### Changed
- README is now fully English. The prior version mixed Japanese and English in
  the same sections, which is unusual for a globally distributed npm package
  and weakened the first-impression signal on the npm registry page. Japanese
  speakers can read the same content (and more) at https://argosvix.com which
  ships JA / EN locales.

### Added
- Listed the new `examples/workers-anthropic/` integration alongside the
  existing Next.js / Express / Lambda examples.

### Notes
- No SDK code changes. The compiled `dist/` output is byte-identical to
  v0.1.1 except for the bundled README inside the tarball.

## [0.1.1] - 2026-05-21

Patch release that hardens short-lived runtime delivery and matches the SDK's
default endpoint to the live backend.

### Fixed
- **Workers / Lambda fire-and-forget loss (HIGH).** When `bufferMaxSize` was
  reached, `record()` started a background `flush()` whose `fetch` could be
  killed by the runtime before completing. `flushClient()` now waits behind
  any in-flight flush via an internal `inFlightFlush` promise, so records
  buffered before the handler returned are guaranteed to reach the backend
  in order.
- **Edge runtime crash on `process.env` (HIGH).** `record()` no longer assumes
  a Node `process` global exists; environments without it (Cloudflare Workers
  in some modes, Vercel Edge) used to throw and break the wrapped LLM call.
- **Default endpoint corrected to `https://ingest.argosvix.com/v1/ingest`.**
  The previous default pointed to a non-existent subdomain
  (`api.argosvix.com`), which would have failed for any user who omitted an
  explicit `endpoint` in their `ArgosvixConfig`.

### Added
- Regression tests for the two `Recorder` fixes above (concurrent flush
  serialization, missing `process` global).

### Documentation
- Source comments rewritten to English ahead of wider distribution.

## [0.1.0] - 2026-05-21

Initial public release on npm under the `alpha` dist-tag.

### Added
- `wrap(client, config?)`: transparent observability wrapper for AI provider
  SDK clients. Supported targets:
  - OpenAI `chat.completions.create` (sync + streaming) and `responses.create`
    (sync; streaming is deferred to a later release).
  - Anthropic `messages.create` (sync + streaming, with `message_start` /
    `message_delta` accumulation).
  - Mistral `chat.complete` and `chat.stream`.
  - Gemini legacy SDK (`@google/generative-ai`) `getGenerativeModel(...)`
    plus `generateContent` and `generateContentStream`.
  - Gemini current SDK (`@google/genai`) `models.generateContent` and
    `models.generateContentStream`.
- `getRecorder(client)`: retrieve the per-client `Recorder` instance.
- `flushClient(client)`: short-lived runtime helper that resolves only after
  the buffer is delivered to the backend.
- `Recorder` class with `record()`, `flush()`, retry on 5xx/network with
  exponential-ish backoff, and per-instance buffer isolation.
- `calculateCost(provider, model, prompt, completion)` and the public
  `PRICING` table covering 2026-05 OpenAI / Anthropic / Gemini / Mistral
  prices, with prefix matching for version-suffixed model IDs.
- TypeScript types: `Provider`, `ArgosvixConfig`, `LlmCallRecord`,
  `PricingEntry`.
- Idempotency: wrapping the same client twice is a no-op (`WeakMap` for
  clients, `WeakSet` for Gemini model instances).

### Notes
- The SDK does **not** record prompt or completion bodies. Only token counts,
  cost, latency, tags, error metadata, and a small request-meta overview are
  sent to the backend.
- `peerDependencies` for every provider SDK are marked optional — install
  only the ones you actually use.
- License: MIT.

[0.1.2]: https://www.npmjs.com/package/@argosvix/sdk/v/0.1.2
[0.1.1]: https://www.npmjs.com/package/@argosvix/sdk/v/0.1.1
[0.1.0]: https://www.npmjs.com/package/@argosvix/sdk/v/0.1.0
