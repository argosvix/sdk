# @argosvix/sdk

Transparent observability wrapper for AI provider SDKs. Wrap a single line of code and get cost, latency, token, and error records for every LLM call across OpenAI, Anthropic, Gemini, Mistral, xAI Grok, Moonshot Kimi, DeepSeek, Alibaba Qwen, and Meta Muse Spark.

> 🟢 **Live** — backend ingest (`ingest.argosvix.com`) and dashboard (`dashboard.argosvix.com`) are live. Published on npm as `@argosvix/sdk`. The entire sign-up to API-key flow runs in the browser; a Free plan and paid plans (Pro / Team) are available.
>
> Design principles:
> - **No end-user PII is sent.** By default, prompt and completion bodies are never recorded; only token counts, cost, latency, and error codes leave your process. Content capture is a separate opt-in (`captureContent`, see below) and always applies PII masking before send.
> - **Idempotent wrap.** Wrapping the same client twice is a no-op; we track instances via WeakMap / WeakSet.
> - **No global monkey-patching.** Only the client argument you pass in is mutated; the global namespace is untouched.

## Supported providers

| Provider | Hook | Streaming | Notes |
|---|---|---|---|
| **OpenAI** chat.completions | ✅ | ✅ | `chat.completions.create` |
| **OpenAI** responses | ✅ | warn + skip (planned) | `responses.create` |
| **Anthropic** | ✅ | ✅ | `messages.create` (accumulates `message_start` + `message_delta`) |
| **Mistral** | ✅ | ✅ | `chat.complete` + `chat.stream` |
| **Gemini legacy** (`@google/generative-ai`) | ✅ | ✅ | `getGenerativeModel({...}).generateContent` / `generateContentStream` |
| **Gemini current** (`@google/genai`) | ✅ | ✅ | `client.models.generateContent` / `generateContentStream` |
| **xAI Grok** | ✅ | ✅ | Through the OpenAI-compatible endpoint. Detected from `baseURL` (`api.x.ai`), or set `provider: "xai"` explicitly |
| **Moonshot Kimi** | ✅ | ✅ | Through the OpenAI-compatible endpoint. Detected from `baseURL` (`api.moonshot.ai` / `.cn`), or set `provider: "moonshot"` |
| **DeepSeek** | ✅ | ✅ | Through the OpenAI-compatible endpoint. Detected from `baseURL` (`api.deepseek.com`), or set `provider: "deepseek"` |
| **Alibaba Qwen** | ✅ | ✅ | Through the OpenAI-compatible endpoint. Detected from `baseURL` (`dashscope.aliyuncs.com` / `dashscope-intl.aliyuncs.com`), or set `provider: "alibaba"` |
| **Meta Muse Spark** | ✅ | ✅ | Through the OpenAI-compatible endpoint. Detected from `baseURL` (`api.meta.ai`), or set `provider: "meta"` |

Grok, Kimi, DeepSeek, Qwen, and Muse Spark reuse the OpenAI wrapper because they serve an
OpenAI-compatible API. You wrap the same `OpenAI` client you already have; the
record carries the real provider so cost is priced with that provider's rates.

## Install

```bash
npm install @argosvix/sdk openai
# Also install the SDKs for any other providers you use (Anthropic, Gemini, Mistral).
# Grok / Kimi / DeepSeek / Qwen / Muse Spark need no extra SDK — they use the OpenAI client.
```

### Obtain an API key

1. Sign up at <https://dashboard.argosvix.com/en/signup> with an email address and password.
2. Open the verification link sent to your inbox.
3. Create an API key from the dashboard's API keys page. The raw key (`argk_…`) is displayed **once** at creation — copy and store it safely. You can create additional keys or revoke a key from the same page at any time.

Alternatively, run `npx @argosvix/cli init` — it opens the browser for a one-time approval, issues a least-privilege key, and writes it to `.env` for you.

```bash
export ARGOSVIX_API_KEY=argk_...
# Default ingest endpoint = https://ingest.argosvix.com
# Override with ARGOSVIX_API_BASE if you route requests through a proxy.
```

## Quick start

```typescript
import OpenAI from "openai";
import { wrap, getRecorder } from "@argosvix/sdk";

const client = wrap(new OpenAI(), {
  apiKey: process.env.ARGOSVIX_API_KEY,
  tags: { service: "support-bot", env: "production" },
});

// Use the wrapped client exactly like the original.
const response = await client.chat.completions.create({
  model: "gpt-5.5",
  messages: [{ role: "user", content: "Hello" }],
});

// Optional: graceful flush before process exit.
const recorder = getRecorder(client);
if (recorder) await recorder.flush();
```

Each call automatically records:

- Prompt and completion token counts (`promptTokens` / `completionTokens`, camelCase).
- USD cost, computed from the bundled per-provider pricing table. Resource-prefixed model names such as `models/gemini-2.0-flash` are normalized to their terminal model name.
- Latency in milliseconds.
- Streaming responses produce a record once the final usage chunk is observed (synced with consumer completion).
- Arbitrary tags (`tags: { service: "X", env: "prod" }`).
- Structured error details (`statusCode`, `code`, `type`, `retryAfter`).

**Not recorded by default:** prompt bodies, completion bodies, system messages, or tool-call argument bodies. Only the metadata required for aggregation is sent. To record bodies as well, see [Content capture (opt-in)](#content-capture-opt-in) below.

## Content capture (opt-in)

By default only metadata leaves your process. Set `captureContent: true` to also record prompt and completion bodies (and tool-call arguments / results) — useful for quality review, eval datasets, and debugging:

```typescript
const client = wrap(new OpenAI(), {
  apiKey: process.env.ARGOSVIX_API_KEY,
  captureContent: true,
});
```

- **Coverage:** non-streaming calls on all four providers — OpenAI (Chat Completions + Responses), Anthropic, Gemini (legacy + current SDK), and Mistral. Streaming calls keep recording metadata as usual, but bodies are not captured.
- **PII masking before send:** emails, credit-card numbers, phone numbers, IP addresses, etc. are replaced with `[REDACTED_*]` inside your process, before the record leaves it. (`disablePiiRedaction: true` turns the filter off — at your own risk.)
- **Server-side consent gate:** unless the account is on a paid plan (Pro or higher) **and** plaintext storage has been explicitly enabled in the dashboard settings (consent dialog), the backend discards the bodies. Flipping the SDK flag alone stores nothing.

See <https://argosvix.com/en/docs/sdk-reference> for details.

## Short-lived runtimes (Cloudflare Workers / AWS Lambda / Vercel Edge)

These runtimes kill any outstanding fire-and-forget `fetch` the moment the handler returns. The SDK normally buffers records in memory and flushes them only when `bufferMaxSize` is reached (default 100), so a single request with a few LLM calls would lose its records on context exit.

Mitigation: await `flushClient(client)` in the handler's `finally` block.

```typescript
import Anthropic from "@anthropic-ai/sdk";
import { wrap, flushClient } from "@argosvix/sdk";

export default {
  async scheduled(_event, env) {
    const client = wrap(new Anthropic({ apiKey: env.ANTHROPIC_API_KEY }), {
      apiKey: env.ARGOSVIX_API_KEY,
    });
    try {
      const res = await client.messages.create({
        model: "claude-opus-4-1",
        max_tokens: 200,
        messages: [{ role: "user", content: "..." }],
      });
      // ...
    } finally {
      await flushClient(client); // Required: guarantees backend delivery before exit.
    }
  },
};
```

Long-running Node processes (Express, Next.js dev server, classic servers) do not need this — the buffer auto-flushes well before process exit.

## Runtime control plane

Observability tells you what an agent *did*. The runtime control plane lets a human
bound what an agent *can do* — enforced inside your process, configured from the
dashboard / chat / MCP without touching agent code.

There are three gates. The first two are enforced inside `wrap(...)` by evaluating
cached backend config locally (no proxy, no per-call round trip). The third is an
explicit request/await pair around a sensitive operation.

Full usage details live in the docs: <https://argosvix.com/en/docs/sdk-reference>.

### Budget gate

Opt in with `budgetGate: true`. Before each wrapped LLM call, the SDK evaluates the
account's monthly limit + spend (cached, TTL from the backend, default 60s). Over the
limit throws `ArgosvixBudgetExceededError` *before* the provider request — so a runaway
loop can't burn the budget.

```typescript
import { wrap, ArgosvixBudgetExceededError } from "@argosvix/sdk";

const openai = wrap(new OpenAI(), {
  apiKey: process.env.ARGOSVIX_API_KEY,
  budgetGate: true,
});

try {
  await openai.chat.completions.create({ model: "gpt-5-mini", messages });
} catch (err) {
  if (err instanceof ArgosvixBudgetExceededError) {
    // err.spentUsd / err.limitUsd — blocked before reaching the provider
  }
}
```

The gate is configured from the dashboard / chat ("create a $5/month budget gate"). On an
account with no gate it's a complete no-op. `enforceMode: "fail_open"` (default) lets
calls through when the backend is unreachable; `"fail_closed"` blocks while the cached
state is stale (`ArgosvixBudgetGateUnavailableError`). Set `budgetGateFailClosed: true`
to also block before the first successful fetch.

> Budget-gate accuracy: the gate's local spend correction is best-effort. It can only
> account for calls whose cost the SDK can compute. Calls with an unknown model, or calls
> that error before returning usage, are recorded at $0 and therefore do not accrue toward
> the local cap between server refreshes. For streaming, the SDK auto-enables OpenAI usage
> reporting (see Cost accuracy below) so streamed spend is counted.

### Cost accuracy notes

- **Streaming (OpenAI):** the SDK automatically enables `stream_options.include_usage` for
  streamed calls so token usage and cost are captured (OpenAI omits usage from streams
  otherwise). The extra usage-only chunk OpenAI emits is consumed internally and **not**
  yielded to your code, so your stream shape is unchanged. If you set `include_usage`
  yourself, the SDK respects it and passes the chunk through.
- **Anthropic 1-hour prompt cache:** cache-creation tokens are accounted at the 5-minute
  write rate (1.25× input). If you use the 1-hour cache TTL (2× input), the recorded cost
  for those creation tokens is an under-estimate — Anthropic's usage object does not
  distinguish the two TTLs.

### Policy gate

Opt in with `policyGate: true` (shares the same config fetch). Before each call the SDK
checks the request payload against the account's policy — model allowlist, PII block,
secret block — and throws `ArgosvixPolicyViolationError` on a hit. The scan runs in your
process; only the field path + a masked snippet are surfaced, never the plaintext.

```typescript
import { wrap, ArgosvixPolicyViolationError } from "@argosvix/sdk";

const openai = wrap(new OpenAI(), {
  apiKey: process.env.ARGOSVIX_API_KEY,
  policyGate: true,
});
// err.reason is "model_not_allowed" | "pii_detected" | "secret_detected"
```

### Approval gate

For destructive or irreversible operations (delete / refund / send), request a human
approval and wait. The owner/admins get an email; a human approves in the dashboard
`/approvals` or via the email link. **API keys cannot approve** — the agent can't
self-approve. Anything other than `"approved"` (denied / expired / timeout) is
default-deny.

```typescript
import { requestApproval, waitForApproval } from "@argosvix/sdk";

const approval = await requestApproval({
  apiKey: process.env.ARGOSVIX_API_KEY!,
  action: "delete_user",
  summary: "Delete inactive user usr_123 (90 days no login)",
  timeoutSeconds: 3600,
});
const status = await waitForApproval({ apiKey, id: approval.id });
if (status !== "approved") return; // default-deny
// ...perform the operation...
```

## Composite client / explicit provider

When auto-detection is ambiguous (e.g. for composite or adapter clients), set `config.provider` explicitly:

```typescript
const client = wrap(myCompositeClient, { provider: "openai" });
```

## Vercel AI SDK (`ai` package)

If your app calls models through the Vercel AI SDK (`generateText` / `streamText` /
`generateObject`), wrap the model with `argosvixMiddleware()` instead of wrapping a provider
client. Every call made through the AI SDK — including calls issued internally by the AI SDK
(tool loops, multi-step agents) — is then recorded: provider, model, tokens, cost, latency,
TTFT (streaming), cache and reasoning tokens.

```typescript
import { openai } from "@ai-sdk/openai";
import { wrapLanguageModel, generateText } from "ai";
import { argosvixMiddleware, flushClient } from "@argosvix/sdk";

const observed = argosvixMiddleware({ apiKey: process.env.ARGOSVIX_API_KEY });

const model = wrapLanguageModel({
  model: openai("gpt-5.5"),
  middleware: observed,
});

try {
  await generateText({ model, prompt: "Summarize this PR." });
} finally {
  // Short-lived runtimes (Workers / Lambda / Edge): flush before the handler returns.
  await flushClient(observed); // or: await observed.flush()
}
```

Notes:
- Supported providers are the same four as `wrap()` (OpenAI / Anthropic / Google Gemini /
  Mistral). The middleware maps the AI SDK provider id (`openai.chat`, `anthropic.messages`,
  `google.generative-ai`, `mistral.chat`, Azure OpenAI) to the right pricing table. Calls
  through other providers run normally but are not recorded — pass `config.provider` to force a
  mapping.
- Works with both `ai@5` (LanguageModelV2) and `ai@6` (V4) middleware shapes, and both the old
  (`cachedInputTokens`) and new (`inputTokenDetails.cacheReadTokens`) usage layouts.
- Budget / policy gates (`config.budgetGate` / `config.policyGate`) and automatic trace grouping
  (`withTrace`) apply here exactly as with `wrap()`.
- Recording is best-effort: an error inside the middleware never breaks your model call.
  A stream that the consumer cancels mid-way is not recorded (token usage is only final at the
  stream's `finish`).

## LangChain.js

If your app uses LangChain.js, attach `argosvixLangChainHandler()` as a callback. Every LLM call
made through LangChain — including calls issued inside chains and agents — is recorded: provider,
model, tokens, cost, latency, TTFT (streaming), cache and reasoning tokens.

```typescript
import { ChatOpenAI } from "@langchain/openai";
import { argosvixLangChainHandler, flushClient } from "@argosvix/sdk";

const handler = argosvixLangChainHandler({ apiKey: process.env.ARGOSVIX_API_KEY });
const model = new ChatOpenAI({ model: "gpt-5.5" });

try {
  // Per-call:
  await model.invoke("Summarize this PR.", { callbacks: [handler] });
  // Or attach once at construction: new ChatOpenAI({ ..., callbacks: [handler] });
} finally {
  await flushClient(handler); // or: await handler.flush()
}
```

Notes:
- Supported providers are the same four as `wrap()` (OpenAI / Anthropic / Google Gemini /
  Mistral). The handler maps the LangChain model class (e.g. `ChatOpenAI`, `ChatAnthropic`,
  `ChatGoogleGenerativeAI`, `ChatMistralAI`) to the right pricing table. Other providers run
  normally but are not recorded — pass `config.provider` to force a mapping.
- Token usage is read from the standard `usage_metadata` on the message (with `llmOutput.tokenUsage`
  as a fallback), so cache/reasoning breakdowns are captured where the provider reports them.
- Budget / policy gates and automatic trace grouping (`withTrace`) apply here too.
- Recording is best-effort: a callback never throws into your LangChain run.

## Automatic trace grouping

Wrap a unit of work in `withTrace` and every wrapped LLM call inside it is grouped under one
trace automatically — no manual `traceId` threading. Each call gets its own span, so chained
agent steps nest in the dashboard's trace view.

```typescript
import { wrap, withTrace } from "@argosvix/sdk";

const client = wrap(openai);

await withTrace(async () => {
  // both calls share one auto-generated traceId; each is its own span
  await client.chat.completions.create({ model: "gpt-5.5", messages: [...] });
  await client.chat.completions.create({ model: "gpt-5.5", messages: [...] });
});
```

- Precedence: explicit `config.traceId` > ambient `withTrace` > none. Calls made outside any
  `withTrace` behave exactly as before. Opt out with `wrap(client, { autoContext: false })`.
- Built on `AsyncLocalStorage`, resolved without a static `node:async_hooks` import, so it
  never breaks Edge/browser bundles; it self-disables (calls still record) where unavailable
  — on Cloudflare Workers enable the `nodejs_als` compatibility flag to turn it on.

Use `withSpan` to record non-LLM steps (retrieval / tool / agent / chain) and nest the LLM
calls inside them — your trace then shows the full agent tree, not just the generations:

```typescript
import { withTrace, withSpan } from "@argosvix/sdk";

await withTrace(async () => {
  const docs = await withSpan("retrieval", "vector_search", async () => search(query));
  // this generation nests under the retrieval span
  await client.chat.completions.create({ model: "gpt-5.5", messages: buildPrompt(docs) });
});
```

`withSpan` records the step's latency/status/error automatically. Keep `metadata` to
non-sensitive structured attributes (counts, sizes) — don't put raw documents or args there.

## Deployed prompts (`resolvePrompt` / `withPrompt`)

If you manage prompts in Argosvix (prompt registry + deployments), `resolvePrompt` fetches the
currently deployed version of a prompt at runtime, and `withPrompt` tags every wrapped LLM call
inside it with `prompt: {name}@v{version}` — so quality and cost can be compared per prompt
version in the dashboard:

```typescript
import { resolvePrompt, withPrompt } from "@argosvix/sdk";

const p = await resolvePrompt("support-bot", { apiKey: process.env.ARGOSVIX_API_KEY! });
// p.template = prompt body · p.version = deployed version · p.tag = "support-bot@v3"

await withPrompt(p, async () => {
  // this call is tagged prompt:support-bot@v3 automatically
  await client.chat.completions.create({
    model: "gpt-5.5",
    messages: [{ role: "system", content: p.template }, { role: "user", content: input }],
  });
});
```

- `resolvePrompt(name, options)` resolves the current version for a deploy label (default
  `"production"`, override with `options.label`). Results are cached in-memory with a
  60-second TTL (`cacheTtlMs`, `0` disables), so it is safe on the hot path.
- Stale fallback: on network errors / timeouts / 5xx an expired cache entry is returned
  instead of failing, so a transient backend outage doesn't stop your app. With no cached
  value the error is thrown. 4xx (e.g. a deployment that doesn't exist) always throws.
- `withPrompt` accepts the `resolvePrompt` result, a `{ name, version }` object, or a raw
  tag string. An explicit `tags.prompt` on the call wins over the ambient tag.

## Tags + aggregation

Tags are persisted per record. The backend dashboard supports cross-dimension aggregation such as "cost trend for `service=support-bot`" (Phase C dashboard and beyond).

## Streaming

```typescript
const stream = await client.chat.completions.create({
  model: "gpt-5.5",
  messages: [...],
  stream: true,
});

for await (const chunk of stream) {
  // Consume as a normal AsyncIterable.
  process.stdout.write(chunk.choices[0]?.delta?.content ?? "");
}
// A record is POSTed to the backend once the stream completes.
```

## Examples

Integration guides for common stacks (Next.js App Router, Express with streaming and SIGTERM flush, AWS Lambda with `@google/genai`, Cloudflare Workers with the `flushClient` pattern) are available in the docs: <https://argosvix.com/en/docs/guides>.

## Alert webhooks

Argosvix can deliver alert notifications to any HTTPS endpoint of your choice (in addition to email and Slack). Configure a webhook channel from <https://dashboard.argosvix.com/en/alerts>; this section documents the public contract so you can implement a receiver.

### Delivery

- Method: `POST`
- Content-Type: `application/json`
- Timeout: 5 seconds (no retry — the next evaluator cycle will re-fire if the condition still holds)
- Redirects: disabled (`fetch redirect: "error"`)
- URL constraints: HTTPS only; private / loopback / link-local / cloud-metadata IPs and URLs with credentials are rejected at registration time

### Headers

| Header | Value |
|---|---|
| `User-Agent` | `Argosvix-Webhook/1.0` |
| `X-Argosvix-Event` | `alert.triggered` (only event type for now) |
| `X-Argosvix-Signature` | `sha256=<hex>` — present only when a signing secret is configured |
| `X-Argosvix-Timestamp` | ISO-8601 UTC — present only when a signing secret is configured |

### Payload

```jsonc
{
  "alertId": "01HXZ...",
  "name": "monthly cost > $50",
  "alertType": "monthly_budget",   // cost_threshold | error_rate | latency_degradation | monthly_budget
  "thresholdValue": 50,
  "observedValue": 64.20,
  "windowMinutes": 60,
  "windowDescription": "60 min",
  "filterProvider": "openai",       // or null
  "filterModel": null,              // or string
  "comparison": "exceeded threshold",
  "triggeredAt": "2026-05-25T10:23:45.678Z",
  "dashboardUrl": "https://dashboard.argosvix.com/en/alerts?alertId=01HXZ..."
}
```

`thresholdValue` and `observedValue` units are USD for cost alerts, percent for `error_rate`, and milliseconds for `latency_degradation`. Schema is stable: new fields may be added (additive only); existing fields keep their names and semantics.

### Verifying the signature

When a signing secret is configured, the signature header is computed as:

```
X-Argosvix-Signature = "sha256=" + hex(HMAC_SHA256(secret, X-Argosvix-Timestamp + "." + body))
```

Reject any request whose signature does not match (and optionally drop requests with a timestamp older than your replay window).

```typescript
// Node 18+ — verifyArgosvixSignature.ts
import { createHmac, timingSafeEqual } from "node:crypto";

export function verifyArgosvixSignature(
  secret: string,
  body: string,            // raw request body string
  signatureHeader: string, // "sha256=<hex>"
  timestampHeader: string, // ISO-8601 string
  maxAgeMs = 5 * 60 * 1000,
): boolean {
  const ts = Date.parse(timestampHeader);
  if (Number.isNaN(ts) || Math.abs(Date.now() - ts) > maxAgeMs) return false;

  const expected = "sha256=" +
    createHmac("sha256", secret).update(`${timestampHeader}.${body}`).digest("hex");
  const a = Buffer.from(signatureHeader, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}
```

```python
# Python 3 — verify_argosvix_signature.py
import hashlib, hmac, time
from datetime import datetime, timezone

def verify_argosvix_signature(secret: str, body: str,
                              signature_header: str, timestamp_header: str,
                              max_age_seconds: int = 300) -> bool:
    try:
        ts = datetime.fromisoformat(timestamp_header.replace("Z", "+00:00"))
    except ValueError:
        return False
    if abs(time.time() - ts.timestamp()) > max_age_seconds:
        return False
    expected = "sha256=" + hmac.new(
        secret.encode(), f"{timestamp_header}.{body}".encode(), hashlib.sha256
    ).hexdigest()
    return hmac.compare_digest(signature_header, expected)
```

### Tag-key conventions

Tag keys used in queries (`channelTargets.webhook.url` request paths, dashboard filters, etc.) must match `^[A-Za-z0-9_](?:[A-Za-z0-9_-]{0,62}[A-Za-z0-9_])?$` — alphanumeric plus `_` `-`, no leading/trailing hyphen, 1–64 characters. Sticking to this in the SDK `tags: { ... }` map keeps every downstream filter / aggregation usable.

### Residual SSRF risk (DNS rebinding)

Hostname validation happens at registration and at delivery time, but Cloudflare Workers does not expose connect-level IP control, so an attacker-controlled DNS that flips a public name to an RFC1918 / metadata IP between checks can still bypass the policy. Treat webhook receivers as part of your trust boundary; do not host them inside private networks that your perimeter would otherwise protect.

## API

### `wrap<T>(client: T, config?: ArgosvixConfig): T`
Transparently wraps an AI SDK client. Returns the same client (mutated) so the call-site shape is unchanged.

### `getRecorder(client: object): Recorder | null`
Retrieves the `Recorder` instance associated with a wrapped client.

### `flushClient(client: object): Promise<void>`
Helper for short-lived runtimes (Cloudflare Workers, AWS Lambda, Vercel Edge). Awaiting this in a `finally` block explicitly flushes the SDK buffer and waits for backend delivery. Failures are logged via `console.error` only — never thrown — to avoid breaking the host application.

### `class Recorder`
- `record(record: LlmCallRecord): void`
- `flush(): Promise<LlmCallRecord[]>` — POSTs the buffer to the backend. Retries on 5xx and network errors; 4xx errors are not retried. On `429` (monthly ingest quota reached) the SDK logs a warning once per process, so records don't stop silently at the end of the month.
- `getBufferSize(): number`

### `resolvePrompt(name: string, options: ResolvePromptOptions): Promise<ResolvedPrompt>`
Fetches the currently deployed version of a registered prompt (60 s TTL cache + stale fallback on backend failure). See "Deployed prompts" above.

### `withPrompt(prompt, fn)`
Runs `fn` with an ambient prompt tag; every wrapped call inside gets `tags.prompt = "{name}@v{version}"` automatically.

### `calculateCost(provider, model, promptTokens, completionTokens): number`
Internal pricing calculator returning USD. Exported for unit tests and custom-pricing experimentation. Resource-prefixed model names (e.g. `models/gemini-2.0-flash`) are looked up by their terminal model name.

### Types
`Provider` · `ArgosvixConfig` · `LlmCallRecord` · `PricingEntry` · `ResolvedPrompt` · `ResolvePromptOptions`

## License

MIT
