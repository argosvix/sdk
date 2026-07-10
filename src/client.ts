import type { ArgosvixConfig, LlmCallRecord, Provider } from "./types.js";
import { calculateCost, calculateCostWithCache } from "./pricing.js";
import { Recorder } from "./recorder.js";
import { generateId } from "./ids.js";
import { getAmbientTraceContext, getAmbientPromptTag, _registerObservationSink } from "./context.js";

const wrappedClients = new WeakMap<object, Recorder>();
const wrappedGeminiModels = new WeakSet<object>();

/**
 * Wrap an AI provider SDK client to transparently record every call.
 *
 * Supported: OpenAI (chat.completions + responses), Anthropic (messages),
 * Mistral (chat.complete + chat.stream), Gemini (legacy `@google/generative-ai`
 * + current `@google/genai`).
 *
 * Provider detection: constructor-name fingerprint with shape-based fallback.
 * For composite or adapter clients, pass `config.provider` to override detection.
 *
 * Idempotency: wrapping the same client twice is a no-op.
 *
 * @example
 * import OpenAI from "openai";
 * import { wrap, getRecorder } from "@argosvix/sdk";
 *
 * const client = wrap(new OpenAI(), { apiKey: "...", tags: { service: "bot" } });
 * const recorder = getRecorder(client);
 */
export function wrap<T extends object>(client: T, config: ArgosvixConfig = {}): T {
  if (wrappedClients.has(client)) {
    return client;
  }

  const provider = detectProvider(client, config.provider);
  if (provider === "unknown") {
    return client;
  }

  const recorder = new Recorder(config);
  // Register this recorder as the sink for observations emitted by withSpan
  // (observations[] are sent through this recorder's ingest path).
  _registerObservationSink(recorder);
  switch (provider) {
    case "openai": {
      if (isOpenAIChatLike(client)) wrapOpenAIChat(client, recorder, config);
      if (isOpenAIResponsesLike(client)) wrapOpenAIResponses(client, recorder, config);
      break;
    }
    case "anthropic": {
      if (isAnthropicLike(client)) wrapAnthropic(client, recorder, config);
      break;
    }
    case "mistral": {
      if (isMistralLike(client)) wrapMistral(client, recorder, config);
      break;
    }
    case "gemini": {
      if (isGeminiLegacyLike(client)) wrapGeminiLegacy(client, recorder, config);
      if (isGeminiNewLike(client)) wrapGeminiNew(client, recorder, config);
      break;
    }
  }
  // Plaintext capture coverage (streaming support added 2026-07): in addition to
  // the non-streaming success path of all 4 providers, promptBody / completionBody
  // are also extracted on the streaming paths that have an existing stream wrapper
  // (OpenAI Chat / Anthropic / Mistral / Gemini legacy + new SDK). OpenAI Responses
  // streaming has no stream wrapper yet, so plaintext capture is unsupported there too.
  wrappedClients.set(client, recorder);
  return client;
}

export function getRecorder(client: object): Recorder | null {
  return wrappedClients.get(client) ?? null;
}

/**
 * Internal: registration hook for integrations that do not go through wrap()
 * (e.g. the Vercel AI SDK middleware) to put their own Recorder into the WeakMap
 * used by flushClient() / getRecorder(). This lets `flushClient(middleware)`
 * work through the same path as wrapped clients.
 */
export function _registerRecorderFor(obj: object, recorder: Recorder): void {
  wrappedClients.set(obj, recorder);
}

/**
 * Resolve provider. config.provider override has priority; otherwise
 * constructor name fingerprint, with shape-based check as final fallback.
 * Returns "unknown" if no provider can be reliably identified.
 */
function detectProvider(client: object, override?: Provider): Provider | "unknown" {
  if (override) return override;

  const ctorName = ((client as { constructor?: { name?: string } }).constructor?.name ?? "").toLowerCase();
  if (ctorName.includes("openai")) return "openai";
  if (ctorName.includes("anthropic")) return "anthropic";
  if (ctorName.includes("mistral")) return "mistral";
  if (
    ctorName.includes("googlegenai") ||
    ctorName.includes("googlegenerativeai") ||
    ctorName === "genai" ||
    ctorName === "ai"
  ) {
    return "gemini";
  }

  // Shape fallback for cases where constructor name is unavailable (e.g. generic Object).
  if (isGeminiLegacyLike(client) || isGeminiNewLike(client)) return "gemini";
  if (isAnthropicLike(client) && !isOpenAIChatLike(client) && !isMistralLike(client)) {
    return "anthropic";
  }
  if (isMistralLike(client) && !isOpenAIChatLike(client)) return "mistral";
  if (isOpenAIChatLike(client) || isOpenAIResponsesLike(client)) return "openai";

  return "unknown";
}

/**
 * Helper that places the trace fields passed in the wrap config (traceId /
 * spanId / parentSpanId) onto each record. It is spread into every provider's
 * record() call so the fields propagate uniformly. Unspecified fields are
 * omitted from the object (keeps the JSON payload small and spares the backend
 * from distinguishing undefined vs NULL).
 */
type TraceMeta = Pick<
  LlmCallRecord,
  "traceId" | "spanId" | "parentSpanId" | "sessionId"
>;

function buildTraceMeta(config: ArgosvixConfig): TraceMeta {
  const meta: TraceMeta = {};
  // Automatic context propagation: traceId resolution order is explicit config
  // first, then ambient (inside withTrace). autoContext:false ignores the
  // ambient context and restores the previous static behavior.
  const ambient =
    config.autoContext === false ? undefined : getAmbientTraceContext();
  const traceId = config.traceId ?? ambient?.traceId;
  if (traceId) {
    meta.traceId = traceId;
    // A call that belongs to a trace gets its own span (it becomes a node of the trace). An explicit spanId takes priority.
    meta.spanId = config.spanId ?? generateId();
    // Parent resolution: explicit config first, then the ambient span (set by withSpan etc.; undefined when directly under the trace).
    const parentSpanId = config.parentSpanId ?? ambient?.spanId;
    if (parentSpanId) meta.parentSpanId = parentSpanId;
  } else {
    // Standalone call without a trace context: previous behavior (only explicitly provided values are forwarded).
    if (config.spanId) meta.spanId = config.spanId;
    if (config.parentSpanId) meta.parentSpanId = config.parentSpanId;
  }
  if (config.sessionId) meta.sessionId = config.sessionId;
  return meta;
}

/**
 * Automatic end-user identifier capture (added 2026-06-17, refined in review).
 * For each provider, only fields designed to hold opaque identifiers are read,
 * and the value is forwarded to aggregation as the userId tag:
 *   - OpenAI:    safety_identifier (OpenAI's recommended stable identifier; hashing recommended)
 *   - Anthropic: metadata.user_id (per spec: no PII, must be opaque, max 256 chars)
 * The legacy OpenAI `user` field is excluded from automatic capture: it often
 * carries PII (emails / raw IDs), so auto-forwarding it could leak data beyond
 * what was consented to (pass an explicit tags.userId if needed).
 * Providers are matched explicitly; Gemini / Mistral are always a no-op (so we
 * never mistakenly pick up another provider's field names). Values are trimmed
 * to 256 characters to match the backend limit.
 */
function pickEndUserId(provider: Provider, requestArgs: unknown): string | undefined {
  if (!requestArgs || typeof requestArgs !== "object") return undefined;
  let cand: unknown;
  if (provider === "openai") {
    const r = requestArgs as { safety_identifier?: unknown };
    if (typeof r.safety_identifier === "string" && r.safety_identifier.length > 0) {
      cand = r.safety_identifier;
    }
  } else if (provider === "anthropic") {
    const r = requestArgs as { metadata?: { user_id?: unknown } | null };
    if (
      r.metadata &&
      typeof r.metadata === "object" &&
      typeof r.metadata.user_id === "string" &&
      r.metadata.user_id.length > 0
    ) {
      cand = r.metadata.user_id;
    }
  }
  return typeof cand === "string" ? cand.slice(0, 256) : undefined;
}

/**
 * Build the tags placed on a record. Starting from config.tags, the userId is
 * filled in from the provider-specific field unless captureUserId is explicitly
 * false. An existing explicit config.tags.userId takes priority (automatic
 * capture never overwrites it).
 *
 * Call this exactly once at each wrapper's entry point and share the resolved
 * tags across all success / error / stream records: requestArgs must not be
 * re-read after an await, so a caller that reuses or mutates the request object
 * cannot cause the call to be recorded under another user's userId.
 */
function buildTags(
  config: ArgosvixConfig,
  provider: Provider,
  requestArgs: unknown,
): Record<string, string> {
  const tags: Record<string, string> = { ...(config.tags ?? {}) };
  if (config.captureUserId !== false && tags.userId === undefined) {
    const native = pickEndUserId(provider, requestArgs);
    if (native !== undefined) tags.userId = native;
  }
  // Inside withPrompt(), the prompt tag ({name}@v{version}) is attached
  // automatically. An explicit tags.prompt takes priority (never overwritten).
  // This is the basis for per-version quality/cost comparison (2026-07-02).
  if (tags.prompt === undefined) {
    const ambientPrompt = getAmbientPromptTag();
    if (ambientPrompt !== undefined) tags.prompt = ambientPrompt;
  }
  return tags;
}

/**
 * SDK-side opt-in extraction helpers for the Pro+ plaintext storage feature.
 *
 * Called by the wrappers when captureContent is true; extracts prompt /
 * completion / tool calls as strings (and JSON strings) from each provider's
 * request / response shapes. PII redaction is applied centrally in the
 * Recorder, so these helpers only return the raw strings.
 *
 * Supported providers (extended 2026-07-02 to cover non-streaming for all 4):
 *   - openai (Chat Completions + Responses): prompt + completion + tool calls
 *   - anthropic (Messages): prompt + completion
 *   - mistral (chat.complete): prompt + completion
 *   - gemini (legacy generateContent + new SDK models.generateContent): prompt + completion
 *   - streaming paths (added 2026-07): the existing stream wrappers' finalize
 *     step attaches promptBody (snapshotted at entry) + completionBody
 *     (accumulated text deltas, 256KB cap). Streaming assembly of tool-call
 *     arguments is out of scope. OpenAI Responses streaming is unsupported
 *     because it has no stream wrapper.
 */
function extractOpenAIChatPromptBody(requestArgs: OpenAIRequest): string | undefined {
  if (!Array.isArray(requestArgs.messages) || requestArgs.messages.length === 0) {
    return undefined;
  }
  try {
    return JSON.stringify(requestArgs.messages);
  } catch {
    return undefined;
  }
}

function extractOpenAIChatCompletionBody(response: unknown): string | undefined {
  if (!response || typeof response !== "object") return undefined;
  const choices = (response as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return undefined;
  const first = choices[0] as { message?: { content?: unknown } } | undefined;
  const content = first?.message?.content;
  if (typeof content === "string") return content;
  // When content is an array (multi-modal), forward it as a JSON string
  if (Array.isArray(content)) {
    try {
      return JSON.stringify(content);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function extractOpenAIChatToolCalls(response: unknown): Array<{ name: string; arguments?: string }> | undefined {
  if (!response || typeof response !== "object") return undefined;
  const choices = (response as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return undefined;
  const first = choices[0] as { message?: { tool_calls?: unknown } } | undefined;
  const toolCalls = first?.message?.tool_calls;
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) return undefined;
  const result: Array<{ name: string; arguments?: string }> = [];
  for (const tc of toolCalls) {
    if (!tc || typeof tc !== "object") continue;
    const fn = (tc as { function?: { name?: unknown; arguments?: unknown } }).function;
    const name = typeof fn?.name === "string" ? fn.name : "unknown";
    const args =
      typeof fn?.arguments === "string"
        ? fn.arguments
        : fn?.arguments !== undefined
          ? safeStringify(fn.arguments)
          : undefined;
    result.push(args !== undefined ? { name, arguments: args } : { name });
  }
  return result.length > 0 ? result : undefined;
}

/**
 * captureContent extraction for the OpenAI Responses API (added in v0.3.0-alpha.2).
 *
 *   - request.input is either a string (a simple prompt) or an array
 *     (multi-modal / structured). Strings are forwarded as-is; arrays are
 *     JSON-stringified.
 *   - response.output_text (aggregated text, introduced in SDK 0.4.x) is the
 *     first choice; otherwise walk the response.output array and join the text
 *     of output_text-type items.
 *   - Tool calls are extracted (name + arguments) from items with
 *     type === "function_call" inside response.output.
 */
function extractOpenAIResponsesPromptBody(requestArgs: OpenAIResponsesRequest): string | undefined {
  if (requestArgs.input === undefined || requestArgs.input === null) return undefined;
  if (typeof requestArgs.input === "string") return requestArgs.input;
  if (Array.isArray(requestArgs.input)) {
    try {
      return JSON.stringify(requestArgs.input);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function extractOpenAIResponsesCompletionBody(response: unknown): string | undefined {
  if (!response || typeof response !== "object") return undefined;
  const r = response as { output_text?: unknown; output?: unknown };
  if (typeof r.output_text === "string") return r.output_text;
  if (Array.isArray(r.output)) {
    const texts: string[] = [];
    for (const item of r.output) {
      if (!item || typeof item !== "object") continue;
      const content = (item as { content?: unknown }).content;
      if (Array.isArray(content)) {
        for (const c of content) {
          if (c && typeof c === "object") {
            const type = (c as { type?: unknown }).type;
            const text = (c as { text?: unknown }).text;
            if (type === "output_text" && typeof text === "string") texts.push(text);
          }
        }
      }
    }
    if (texts.length > 0) return texts.join("\n");
    try {
      return JSON.stringify(r.output);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function extractOpenAIResponsesToolCalls(
  response: unknown,
): Array<{ name: string; arguments?: string }> | undefined {
  if (!response || typeof response !== "object") return undefined;
  const output = (response as { output?: unknown }).output;
  if (!Array.isArray(output)) return undefined;
  const result: Array<{ name: string; arguments?: string }> = [];
  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    const type = (item as { type?: unknown }).type;
    if (type !== "function_call") continue;
    const name = (item as { name?: unknown }).name;
    const args = (item as { arguments?: unknown }).arguments;
    const nameStr = typeof name === "string" ? name : "unknown";
    const argsStr =
      typeof args === "string"
        ? args
        : args !== undefined
          ? safeStringify(args)
          : undefined;
    result.push(argsStr !== undefined ? { name: nameStr, arguments: argsStr } : { name: nameStr });
  }
  return result.length > 0 ? result : undefined;
}

function extractAnthropicPromptBody(requestArgs: AnthropicRequest): string | undefined {
  if (!Array.isArray(requestArgs.messages) || requestArgs.messages.length === 0) {
    return undefined;
  }
  try {
    return JSON.stringify(requestArgs.messages);
  } catch {
    return undefined;
  }
}

function extractAnthropicCompletionBody(response: unknown): string | undefined {
  if (!response || typeof response !== "object") return undefined;
  // Anthropic response shape = { content: [{ type: "text", text: "..." }, ...] }
  const content = (response as { content?: unknown }).content;
  if (Array.isArray(content)) {
    const texts: string[] = [];
    for (const block of content) {
      if (block && typeof block === "object") {
        const t = (block as { type?: unknown; text?: unknown }).type;
        const txt = (block as { text?: unknown }).text;
        if (t === "text" && typeof txt === "string") {
          texts.push(txt);
        }
      }
    }
    if (texts.length > 0) return texts.join("\n");
    // If there is no text block, forward the whole content as a JSON string
    try {
      return JSON.stringify(content);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * Parity fix (2026-07-02): captureContent extraction was added to the
 * non-streaming success paths of Mistral / Gemini as well (same level as
 * OpenAI / Anthropic). PII redaction is still applied centrally in the Recorder.
 */
function extractMistralPromptBody(requestArgs: MistralRequest): string | undefined {
  // Mistral chat.complete takes an OpenAI-Chat-compatible messages array.
  if (!Array.isArray(requestArgs.messages) || requestArgs.messages.length === 0) {
    return undefined;
  }
  return safeStringify(requestArgs.messages);
}

function extractMistralCompletionBody(response: unknown): string | undefined {
  if (!response || typeof response !== "object") return undefined;
  const choices = (response as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return undefined;
  const content = (choices[0] as { message?: { content?: unknown } } | undefined)
    ?.message?.content;
  if (typeof content === "string") return content;
  // ContentChunk[] (multi-modal) is forwarded as a JSON string
  if (Array.isArray(content)) return safeStringify(content);
  return undefined;
}

/**
 * Gemini prompt extraction. The legacy `@google/generative-ai` generateContent
 * accepts a string or { contents }; the new `@google/genai` takes
 * { model, contents }. In both cases the contents (or the raw string) are
 * stringified and forwarded.
 */
function extractGeminiPromptBody(requestArgs: unknown): string | undefined {
  if (typeof requestArgs === "string") return requestArgs;
  if (!requestArgs || typeof requestArgs !== "object") return undefined;
  const contents = (requestArgs as { contents?: unknown }).contents;
  if (contents === undefined || contents === null) return undefined;
  if (typeof contents === "string") return contents;
  return safeStringify(contents);
}

/**
 * Gemini completion extraction. On legacy it is result.response; on the new SDK
 * the result itself holds { candidates: [{ content: { parts: [{ text }] } }] },
 * so the caller passes whichever object carries candidates. Text parts are
 * joined; if there are none, the parts are forwarded as a JSON string.
 */
function extractGeminiCompletionBody(response: unknown): string | undefined {
  if (!response || typeof response !== "object") return undefined;
  const candidates = (response as { candidates?: unknown }).candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) return undefined;
  const parts = (candidates[0] as { content?: { parts?: unknown } } | undefined)
    ?.content?.parts;
  if (!Array.isArray(parts)) return undefined;
  const texts: string[] = [];
  for (const p of parts) {
    const text = p && typeof p === "object" ? (p as { text?: unknown }).text : undefined;
    if (typeof text === "string") texts.push(text);
  }
  if (texts.length > 0) return texts.join("\n");
  return safeStringify(parts);
}

function safeStringify(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

// ============================================================
// Streaming plaintext capture (designed 2026-07)
//
// promptBody is snapshotted at stream entry via the existing extract*PromptBody
// helpers; completionBody is obtained by simply adding text-delta accumulation
// to the existing stream wrappers (which already observe every chunk for usage
// aggregation) — no new interception points are introduced.
// Redaction is still applied centrally at Recorder flush time.
// ============================================================

/**
 * Accumulation buffer cap (262,144 bytes = 256KB), aligned with the ingest-side
 * body limit. Structurally prevents a runaway stream from letting the wrapper
 * eat the host application's memory.
 */
const STREAM_CAPTURE_MAX_BYTES = 262_144;
const STREAM_TRUNCATED_MARKER = "…[truncated]";

/**
 * Count the UTF-8 byte length by scanning UTF-16 code units (avoids a
 * TextEncoder allocation per delta). A surrogate pair counts as one code point
 * of 4 bytes.
 */
function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      // Surrogate pair: 4 bytes (consumes the following low surrogate)
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
}

/**
 * Accumulation buffer for streaming text deltas. Anything beyond the 256KB cap
 * is dropped, and result() returns the body with a truncated marker appended.
 */
class StreamTextAccumulator {
  private parts: string[] = [];
  private bytes = 0;
  private truncated = false;

  push(text: string | undefined | null): void {
    if (typeof text !== "string" || text.length === 0 || this.truncated) return;
    const size = utf8ByteLength(text);
    if (this.bytes + size <= STREAM_CAPTURE_MAX_BYTES) {
      this.parts.push(text);
      this.bytes += size;
      return;
    }
    // A delta that crosses the cap is appended up to a code point boundary as far as it fits; the rest is dropped.
    let remaining = STREAM_CAPTURE_MAX_BYTES - this.bytes;
    let head = "";
    for (const ch of text) {
      const chBytes = utf8ByteLength(ch);
      if (chBytes > remaining) break;
      head += ch;
      remaining -= chBytes;
    }
    if (head.length > 0) {
      this.parts.push(head);
      this.bytes = STREAM_CAPTURE_MAX_BYTES - remaining;
    }
    this.truncated = true;
  }

  /**
   * Return the accumulated body (undefined if empty, i.e. not placed on the record).
   * interrupted: when returning the body captured so far after an exception or
   * early termination, the truncated marker is always appended.
   */
  result(interrupted = false): string | undefined {
    if (this.parts.length === 0) return undefined;
    const body = this.parts.join("");
    return this.truncated || interrupted ? body + STREAM_TRUNCATED_MARKER : body;
  }
}

/** Capture state passed to stream wrappers (created only when captureContent=true). */
interface StreamCapture {
  promptBody?: string;
  acc: StreamTextAccumulator;
}

/**
 * Create the capture state at stream entry. When captureContent is not enabled,
 * returns undefined so both extraction and accumulation cost stay at zero
 * (promptBody extraction is deferred behind a thunk).
 */
function buildStreamCapture(
  config: ArgosvixConfig,
  extractPromptBody: () => string | undefined,
): StreamCapture | undefined {
  if (config.captureContent !== true) return undefined;
  const capture: StreamCapture = { acc: new StreamTextAccumulator() };
  const promptBody = extractPromptBody();
  if (promptBody !== undefined) capture.promptBody = promptBody;
  return capture;
}

/**
 * Attach promptBody / completionBody to a stream finalize / error record.
 * Redaction happens not here but centrally at Recorder flush time (same policy
 * as the non-streaming path).
 */
function applyStreamCapture(
  record: LlmCallRecord,
  capture: StreamCapture | undefined,
  interrupted: boolean,
): void {
  if (!capture) return;
  if (capture.promptBody !== undefined) record.promptBody = capture.promptBody;
  const completionBody = capture.acc.result(interrupted);
  if (completionBody !== undefined) record.completionBody = completionBody;
}

/** Text delta of an OpenAI Chat stream chunk (choices[0].delta.content, strings only). */
function extractOpenAIStreamDeltaText(chunk: OpenAIStreamChunk): string | undefined {
  const delta = chunk.choices?.[0]?.delta as { content?: unknown } | undefined;
  const content = delta?.content;
  return typeof content === "string" && content.length > 0 ? content : undefined;
}

/**
 * Text delta of a Gemini stream chunk. The new SDK exposes chunk.text (a string
 * property); legacy exposes chunk.text() (a function that may throw, e.g. on a
 * safety block). If neither yields text, concatenate
 * candidates[0].content.parts[].text (no JSON fallback — deltas only).
 */
function extractGeminiStreamChunkText(chunk: unknown): string | undefined {
  if (!chunk || typeof chunk !== "object") return undefined;
  const t = (chunk as { text?: unknown }).text;
  if (typeof t === "string" && t.length > 0) return t;
  if (typeof t === "function") {
    try {
      const v = (t as () => unknown).call(chunk);
      if (typeof v === "string" && v.length > 0) return v;
    } catch {
      // Legacy chunk.text() throws when there is no candidate etc. Give up on accumulating and continue.
    }
  }
  const candidates = (chunk as { candidates?: unknown }).candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) return undefined;
  const parts = (candidates[0] as { content?: { parts?: unknown } } | undefined)
    ?.content?.parts;
  if (!Array.isArray(parts)) return undefined;
  const texts: string[] = [];
  for (const p of parts) {
    const text = p && typeof p === "object" ? (p as { text?: unknown }).text : undefined;
    if (typeof text === "string" && text.length > 0) texts.push(text);
  }
  return texts.length > 0 ? texts.join("") : undefined;
}

function extractErrorDetails(err: unknown): LlmCallRecord["errorDetails"] | undefined {
  if (!err || typeof err !== "object") return undefined;
  const e = err as {
    status?: number;
    statusCode?: number;
    code?: string;
    type?: string;
    param?: string;
    headers?: Record<string, string>;
  };
  const details: NonNullable<LlmCallRecord["errorDetails"]> = {};
  const status = e.status ?? e.statusCode;
  if (typeof status === "number") details.statusCode = status;
  if (typeof e.code === "string") details.code = e.code;
  if (typeof e.type === "string") details.type = e.type;
  if (typeof e.param === "string") details.param = e.param;
  const retryAfterHeader = e.headers?.["retry-after"] ?? e.headers?.["Retry-After"];
  if (retryAfterHeader) {
    const n = Number(retryAfterHeader);
    if (!Number.isNaN(n)) details.retryAfter = n;
  }
  return Object.keys(details).length > 0 ? details : undefined;
}

// ============================================================
// OpenAI Chat Completions
// ============================================================

interface OpenAIChatLike {
  // unknown because the full-compat wrap returns the original APIPromise / a
  // compat thenable (a thenable that is not necessarily a Promise; the caller's
  // await works with either).
  chat: { completions: { create: (...args: unknown[]) => unknown } };
}

function isOpenAIChatLike(client: unknown): client is OpenAIChatLike {
  const c = client as Partial<OpenAIChatLike>;
  return typeof c?.chat?.completions?.create === "function";
}

interface OpenAIUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number; audio_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number; audio_tokens?: number };
}

interface OpenAIResponse {
  model?: string;
  usage?: OpenAIUsage;
}

interface OpenAIStreamChunk {
  model?: string;
  usage?: OpenAIUsage;
  choices?: Array<{ delta?: unknown; finish_reason?: string | null }>;
}

/**
 * Extract reasoning / audio tokens from OpenAI usage (undefined when absent).
 * Audio is the sum of input (prompt) and output (completion) tokens. Zero
 * values are not recorded (keeps the column NULL).
 */
function extractRichTokens(usage: OpenAIUsage | undefined): {
  reasoningTokens?: number;
  audioTokens?: number;
} {
  const out: { reasoningTokens?: number; audioTokens?: number } = {};
  const reasoning = usage?.completion_tokens_details?.reasoning_tokens;
  if (typeof reasoning === "number" && reasoning > 0) out.reasoningTokens = reasoning;
  const inAudio = usage?.prompt_tokens_details?.audio_tokens ?? 0;
  const outAudio = usage?.completion_tokens_details?.audio_tokens ?? 0;
  const audio = inAudio + outAudio;
  if (audio > 0) out.audioTokens = audio;
  return out;
}

/**
 * Whether a streaming chunk carries the "first token" (content / tool / audio /
 * refusal). Not triggered by the leading role-only delta (so TTFT is measured
 * correctly).
 */
function chunkHasStreamedOutput(chunk: OpenAIStreamChunk): boolean {
  const choices = chunk.choices;
  if (!Array.isArray(choices) || choices.length === 0) return false;
  const delta = choices[0]?.delta as
    | {
        content?: unknown;
        tool_calls?: unknown;
        function_call?: unknown;
        audio?: unknown;
        refusal?: unknown;
      }
    | undefined;
  if (delta == null) return false;
  if (typeof delta.content === "string" && delta.content.length > 0) return true;
  if (typeof delta.refusal === "string" && delta.refusal.length > 0) return true;
  return delta.tool_calls != null || delta.function_call != null || delta.audio != null;
}

interface OpenAIRequest {
  model?: string;
  messages?: unknown[];
  temperature?: number;
  max_tokens?: number;
  max_completion_tokens?: number;
  stream?: boolean;
  stream_options?: { include_usage?: boolean };
}

/**
 * The high-level streaming helpers (Anthropic messages.stream() /
 * OpenAI chat.completions.stream()) are not wrapped and bypass the budget/policy
 * gate. They return synchronously (event-emitter style), which makes it hard to
 * safely insert an async gate internally, so when a gate is configured we warn
 * once at wrap time and suggest switching to .create({ stream: true }) (the
 * gated path). .create stream:true and Responses streaming are already gated.
 */
let warnedGateStreamHelper = false;
/** Test-only: reset the stream-helper warn-once flag. Do not call from production. */
export function __resetStreamHelperWarning(): void {
  warnedGateStreamHelper = false;
}
function warnIfGatedStreamHelper(
  config: ArgosvixConfig,
  hasStreamHelper: boolean,
  label: string,
): void {
  if (warnedGateStreamHelper || !hasStreamHelper) return;
  if (config.budgetGate !== true && config.policyGate !== true) return;
  warnedGateStreamHelper = true;
  // eslint-disable-next-line no-console
  console.warn(
    `[argosvix] ${label} bypasses the budget/policy gate (not wrapped). ` +
      `Use .create({ stream: true }) for gated streaming.`,
  );
}

/** Compatible with openai-node's Stream (has .tee()). tee duplicates one stream into two branches. */
interface TeeCapableStream {
  tee(): [unknown, unknown];
}

function hasTee(v: unknown): v is TeeCapableStream {
  return (
    v !== null &&
    typeof v === "object" &&
    typeof (v as { tee?: unknown }).tee === "function"
  );
}

function isThenable(v: unknown): v is PromiseLike<unknown> {
  return (
    v !== null &&
    (typeof v === "object" || typeof v === "function") &&
    typeof (v as { then?: unknown }).then === "function"
  );
}

interface APIPromiseLike {
  withResponse?: () => Promise<unknown>;
}

/** Box that protects an APIPromise from Promise thenable-flattening. */
interface APIPromiseBox {
  api: unknown;
}

/**
 * Deferred return value of the full-compat wrap (2026-07).
 *
 * Paths involving a gate wait or a stream tee transform cannot return the
 * original APIPromise as-is. Even then, .withResponse() is preserved via
 * delegation in addition to then/catch/finally (data goes through mapData —
 * for streams it is swapped for the user branch of the tee). Only
 * .asResponse() (direct reads of the raw Response) remains unsupported, since
 * it is structurally incompatible with observation (parsing); this is
 * disclosed in the docs.
 */
function makeCompatAPIPromise(
  result: Promise<unknown>,
  sourceBox: Promise<APIPromiseBox>,
  mapData: (v: unknown) => unknown,
): Promise<unknown> {
  // Return a real Promise (compatible with instanceof Promise / util.types.isPromise).
  const out = result.then((v) => v) as Promise<unknown> & {
    withResponse: () => Promise<unknown>;
    asResponse: () => never;
  };
  // Sacrificial catch: prevents the rejection of the always-attached settled
  // chain (used for recording) from becoming a Node unhandledRejection when
  // the user only uses withResponse() or never awaits at all. The user's own
  // await still receives the same rejection.
  void out.catch(() => {});
  out.withResponse = () =>
    sourceBox.then((box) => {
      const api = box.api as APIPromiseLike;
      if (!api || typeof api.withResponse !== "function") {
        throw new TypeError(
          "withResponse() is not supported by the wrapped client",
        );
      }
      return api.withResponse().then((res: unknown) => {
        if (res && typeof res === "object" && "data" in (res as object)) {
          const r = res as { data: unknown } & Record<string, unknown>;
          return { ...r, data: mapData(r.data) };
        }
        return res;
      });
    });
  out.asResponse = () => {
    throw new TypeError(UNSUPPORTED_AS_RESPONSE);
  };
  return out;
}

/**
 * Error for asResponse() on the deferred compat object. An API that lets the
 * user read the raw Response body directly is structurally incompatible with
 * the parse needed for recording (the body would be consumed twice), so on the
 * compat side we fail loudly instead of breaking silently.
 * Warning: do not touch asResponse on the original APIPromise returned by the
 * identity fast path — the real openai-node withResponse() calls asResponse()
 * internally, so overriding it would break withResponse too (caught in a smoke
 * test against the real package). That case is handled by docs disclosure.
 */
const UNSUPPORTED_AS_RESPONSE =
  "[argosvix] asResponse() is not supported on wrapped clients (the raw body " +
  "would be consumed twice). Use withResponse(), or call this endpoint on an " +
  "unwrapped client.";

/**
 * Run a recording generator (wrapOpenAIStream etc.) to completion in the
 * background. Used solely to consume the observation branch of a tee.
 * Recording and error recording are fully handled inside the generator, so
 * this just spins it silently.
 */
async function drainRecordingStream(gen: AsyncIterable<unknown>): Promise<void> {
  try {
    for await (const _chunk of gen) {
      /* Consume the observation branch only (yielded values are discarded) */
    }
  } catch {
    /* Error recording is already done inside the generator */
  }
}

function wrapOpenAIChat(client: object, recorder: Recorder, config: ArgosvixConfig): void {
  const c = client as unknown as OpenAIChatLike;
  const originalCreate = c.chat.completions.create.bind(c.chat.completions);
  warnIfGatedStreamHelper(
    config,
    typeof (c.chat.completions as { stream?: unknown }).stream === "function",
    "openai chat.completions.stream()",
  );

  c.chat.completions.create = function (...args: unknown[]): unknown {
    const start = Date.now();
    const requestArgs = (args[0] as OpenAIRequest) || {};
    const callTags = buildTags(config, "openai", requestArgs);
    const id = generateId();
    const isStream = requestArgs.stream === true;

    // Without stream_options.include_usage, OpenAI returns no usage at all for
    // streams, so streaming calls would be recorded as 0 tokens / $0 — silently
    // under-counting cost (and letting streaming pass the budget gate). Inject
    // include_usage for streams (respecting an explicit client setting).
    // Warning: when we injected it, the trailing usage-only chunk OpenAI appends
    // (choices=[]) is not yielded to the host, so naive consumers that assume
    // choices[0] don't break. (2026-06-28)
    const usageInjected =
      isStream && requestArgs.stream_options?.include_usage === undefined;
    if (usageInjected) {
      args = [...args];
      args[0] = {
        ...requestArgs,
        stream_options: { ...requestArgs.stream_options, include_usage: true },
      };
    }

    const traceMeta = buildTraceMeta(config);

    const recordSuccess = (response: unknown): void => {
      try {
      const r = response as OpenAIResponse;
      const latencyMs = Date.now() - start;
      const model = r.model || requestArgs.model || "unknown";
      const promptTokens = r.usage?.prompt_tokens ?? 0;
      const completionTokens = r.usage?.completion_tokens ?? 0;
      // OpenAI: prompt_tokens is the total including cached tokens; cached is a subset.
      const cachedReadTokens = r.usage?.prompt_tokens_details?.cached_tokens ?? 0;
      const cost = calculateCostWithCache(
        "openai",
        model,
        promptTokens,
        completionTokens,
        cachedReadTokens,
        0,
      );
      const record: LlmCallRecord = {
        id,
        provider: "openai",
        model,
        promptTokens,
        completionTokens,
        totalTokens: r.usage?.total_tokens ?? promptTokens + completionTokens,
        cachedReadTokens,
        cacheSavingsUsd: cost.cacheSavingsUsd,
        costUsd: cost.costUsd,
        latencyMs,
        ...extractRichTokens(r.usage),
        timestamp: new Date().toISOString(),
        tags: callTags,
        ...buildTraceMeta(config),
        requestMeta: buildOpenAIRequestMeta(requestArgs),
      };
      if (config.captureContent === true) {
        const promptBody = extractOpenAIChatPromptBody(requestArgs);
        if (promptBody !== undefined) record.promptBody = promptBody;
        const completionBody = extractOpenAIChatCompletionBody(response);
        if (completionBody !== undefined) record.completionBody = completionBody;
        const toolCalls = extractOpenAIChatToolCalls(response);
        if (toolCalls !== undefined) record.toolCalls = toolCalls;
      }
      recorder.record(record);
      } catch {
        /* Recording is best-effort — never break the host's call */
      }
    };

    const recordFailure = (err: unknown): void => {
      try {
        const errorDetails = extractErrorDetails(err);
        recorder.record({
          id,
          provider: "openai",
          model: requestArgs.model || "unknown",
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
          costUsd: 0,
          latencyMs: Date.now() - start,
          timestamp: new Date().toISOString(),
          tags: callTags,
          ...traceMeta,
          error: err instanceof Error ? err.message : String(err),
          ...(errorDetails ? { errorDetails } : {}),
          requestMeta: buildOpenAIRequestMeta(requestArgs),
        });
      } catch {
        /* Recording is best-effort */
      }
    };

    // ---- Non-stream + gate disabled: identity fast path ----
    // Return the original APIPromise as-is (.withResponse() / .asResponse() stay real).
    // Recording is done via an observer .then (multiple thens on the same promise are safe).
    if (!isStream && !recorder.budgetGate.isActive) {
      let ret: unknown;
      try {
        ret = originalCreate(...args);
      } catch (err: unknown) {
        recordFailure(err);
        throw err;
      }
      if (isThenable(ret)) {
        ret.then(
          (res) => recordSuccess(res),
          (err) => recordFailure(err),
        );
        return ret;
      }
      recordSuccess(ret);
      return ret;
    }

    // ---- Deferred path (gate enabled or stream) ----
    // An async function's return auto-flattens thenables, which would erase the
    // APIPromise, so wrap it in an { api } box to preserve its identity (for
    // withResponse delegation).
    const sourceBox: Promise<APIPromiseBox> = (async () => {
      await recorder.budgetGate.check({ model: requestArgs.model, payload: requestArgs });
      return { api: originalCreate(...args) };
    })();

    if (!isStream) {
      const settled = sourceBox
        .then((box) => Promise.resolve(box.api))
        .then(
          (res) => {
            recordSuccess(res);
            return res;
          },
          (err: unknown) => {
            recordFailure(err);
            throw err;
          },
        );
      return makeCompatAPIPromise(settled, sourceBox, (v) => v);
    }

    // ---- stream ----
    const capture = buildStreamCapture(config, () =>
      extractOpenAIChatPromptBody(requestArgs),
    );
    const wrapForRecord = (raw: unknown): AsyncGenerator<unknown> =>
      wrapOpenAIStream(
        raw as AsyncIterable<OpenAIStreamChunk>,
        recorder,
        requestArgs,
        start,
        id,
        callTags,
        traceMeta,
        usageInjected,
        capture,
      );
    // The tee transform runs exactly once across paths (await / withResponse().data).
    let transformDone = false;
    let transformedValue: unknown;
    const transformOnce = (raw: unknown): unknown => {
      if (transformDone) return transformedValue;
      // Do not tee when usage was injected: the injected usage-only chunk
      // (choices=[]) would pass straight through to the user branch and break
      // naive consumers (regression guard, 2026-06-28).
      if (!usageInjected && hasTee(raw)) {
        try {
          const [obs, user] = raw.tee();
          // Commit the flag only after tee succeeds (so a custom stream that throws synchronously cannot poison it).
          transformDone = true;
          transformedValue = user;
          // Drain the observation branch with the existing recording generator
          // (no duplication of recording logic). The user branch stays a real
          // Stream, so .tee() / .toReadableStream() / .controller all keep
          // working. Even if the user breaks early, the observation branch runs
          // to completion, so usage is fully recorded.
          // Memory note: while the observation branch drains ahead, all chunks
          // for the unconsumed user branch pile up in tee's internal queue
          // (bounded by the whole response). Accepted as a trade-off for
          // reliable recording (disclosed in the docs).
          void drainRecordingStream(wrapForRecord(obs));
          return user;
        } catch {
          /* tee failed — fall back to the legacy path */
        }
      }
      transformDone = true;
      transformedValue = wrapForRecord(raw);
      return transformedValue;
    };
    const settled = sourceBox
      .then((box) => Promise.resolve(box.api))
      .then(
        (raw) => transformOnce(raw),
        (err: unknown) => {
          recordFailure(err);
          throw err;
        },
      );
    return makeCompatAPIPromise(settled, sourceBox, transformOnce);
  };
}

async function* wrapOpenAIStream(
  stream: AsyncIterable<OpenAIStreamChunk>,
  recorder: Recorder,
  requestArgs: OpenAIRequest,
  start: number,
  id: string,
  // The stream record's userId must come from the callTags resolved at the
  // wrapper entry, not at generator consumption start (eliminates re-reading
  // requestArgs after an await).
  callTags: Record<string, string>,
  // The trace fields also use the meta snapshotted at entry, so consuming the
  // stream outside withTrace can neither lose the ambient context nor attribute
  // the call to the wrong trace.
  traceMeta: TraceMeta,
  // Whether we injected include_usage. When true, the trailing usage-only chunk
  // is observed but not yielded to the host (keeps the consumer's stream shape
  // unchanged).
  usageInjected = false,
  // Streaming plaintext capture (passed only when captureContent=true).
  capture?: StreamCapture,
): AsyncGenerator<OpenAIStreamChunk> {
  let finalModel = requestArgs.model || "unknown";
  let promptTokens = 0;
  let completionTokens = 0;
  let cachedReadTokens = 0;
  let reportedTotal: number | undefined;
  let lastUsage: OpenAIUsage | undefined;
  // TTFT: arrival time of the first chunk carrying a content delta, minus start time.
  let ttftMs: number | undefined;
  // Whether the stream ran to completion (stays false on early break / abandon → the body gets the truncated marker).
  let completed = false;

  // If the consumer breaks early or abandons the stream, the generator gets
  // .return()ed at the yield and the post-loop recording is skipped, so a
  // billed call would never be recorded (and the budget gate's spend would
  // leak too). With finally + the recorded flag, the call is recorded exactly
  // once with the observed tokens on normal completion, error, and early
  // termination alike (matches the Python SDK). (2026-06-28)
  let recorded = false;
  const recordOnce = (): void => {
    if (recorded) return;
    recorded = true;
    const streamCost = calculateCostWithCache(
      "openai",
      finalModel,
      promptTokens,
      completionTokens,
      cachedReadTokens,
      0,
    );
    const record: LlmCallRecord = {
      id,
      provider: "openai",
      model: finalModel,
      promptTokens,
      completionTokens,
      totalTokens: reportedTotal ?? promptTokens + completionTokens,
      cachedReadTokens,
      cacheSavingsUsd: streamCost.cacheSavingsUsd,
      costUsd: streamCost.costUsd,
      latencyMs: Date.now() - start,
      ...(ttftMs !== undefined ? { ttftMs } : {}),
      ...extractRichTokens(lastUsage),
      timestamp: new Date().toISOString(),
      tags: callTags,
      ...traceMeta,
      requestMeta: buildOpenAIRequestMeta(requestArgs),
    };
    applyStreamCapture(record, capture, !completed);
    recorder.record(record);
  };

  try {
    for await (const chunk of stream) {
      if (ttftMs === undefined && chunkHasStreamedOutput(chunk)) {
        // The first chunk carrying content / tool / audio counts as the first
        // token. Not triggered by the leading role-only chunk (avoids
        // underestimating TTFT).
        ttftMs = Date.now() - start;
      }
      capture?.acc.push(extractOpenAIStreamDeltaText(chunk));
      if (chunk.model) finalModel = chunk.model;
      if (chunk.usage) {
        lastUsage = chunk.usage;
        promptTokens = chunk.usage.prompt_tokens ?? promptTokens;
        completionTokens = chunk.usage.completion_tokens ?? completionTokens;
        if (typeof chunk.usage.total_tokens === "number") {
          reportedTotal = chunk.usage.total_tokens;
        }
        if (typeof chunk.usage.prompt_tokens_details?.cached_tokens === "number") {
          cachedReadTokens = chunk.usage.prompt_tokens_details.cached_tokens;
        }
      }
      // The trailing usage-only chunk (empty choices) produced by the
      // include_usage we injected is observed only and not passed to the host
      // (if we did not inject it — the client set it themselves — it is
      // yielded as-is).
      if (usageInjected && chunk.usage != null && (chunk.choices?.length ?? 0) === 0) {
        continue;
      }
      yield chunk;
    }
    // The openai-node Stream swallows controller.abort() and treats it as a
    // normal end, so execution reaches here. Record it as truncated rather than
    // a clean success (prevents recording under-counted usage as a success).
    const aborted =
      (stream as { controller?: { signal?: { aborted?: boolean } } }).controller
        ?.signal?.aborted === true;
    completed = !aborted;
    recordOnce();
  } catch (err: unknown) {
    recorded = true; // finalized by the error record (suppresses recordOnce in finally)
    const errorDetails = extractErrorDetails(err);
    const errorRecord: LlmCallRecord = {
      id,
      provider: "openai",
      model: finalModel,
      promptTokens,
      completionTokens,
      totalTokens: reportedTotal ?? promptTokens + completionTokens,
      costUsd: calculateCost("openai", finalModel, promptTokens, completionTokens),
      latencyMs: Date.now() - start,
      timestamp: new Date().toISOString(),
      tags: callTags,
      ...traceMeta,
      error: err instanceof Error ? err.message : String(err),
      ...(errorDetails ? { errorDetails } : {}),
      requestMeta: buildOpenAIRequestMeta(requestArgs),
    };
    // When cut off by an exception, put the body captured so far + the truncated marker on the record.
    applyStreamCapture(errorRecord, capture, true);
    recorder.record(errorRecord);
    throw err;
  } finally {
    // Early break / abandon path. No-op if the stream already completed normally or errored.
    recordOnce();
  }
}

function buildOpenAIRequestMeta(
  requestArgs: OpenAIRequest,
): NonNullable<LlmCallRecord["requestMeta"]> {
  const meta: NonNullable<LlmCallRecord["requestMeta"]> = {};
  if (Array.isArray(requestArgs.messages)) meta.messagesCount = requestArgs.messages.length;
  if (typeof requestArgs.temperature === "number") meta.temperature = requestArgs.temperature;
  const maxTokens = requestArgs.max_tokens ?? requestArgs.max_completion_tokens;
  if (typeof maxTokens === "number") meta.maxTokens = maxTokens;
  return meta;
}

// ============================================================
// OpenAI Responses API
// ============================================================

interface OpenAIResponsesLike {
  // unknown because the full-compat wrap returns the original APIPromise / a compat thenable.
  responses: { create: (...args: unknown[]) => unknown };
}

function isOpenAIResponsesLike(client: unknown): client is OpenAIResponsesLike {
  const c = client as Partial<OpenAIResponsesLike>;
  return typeof c?.responses?.create === "function";
}

interface OpenAIResponsesResponse {
  model?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
    // Prompt caching: the Responses API exposes cached_tokens under input_tokens_details.
    input_tokens_details?: { cached_tokens?: number };
  };
}

interface OpenAIResponsesRequest {
  model?: string;
  input?: unknown;
  temperature?: number;
  max_output_tokens?: number;
  stream?: boolean;
}

function wrapOpenAIResponses(
  client: object,
  recorder: Recorder,
  config: ArgosvixConfig,
): void {
  const c = client as unknown as OpenAIResponsesLike;
  const originalCreate = c.responses.create.bind(c.responses);

  c.responses.create = function (...args: unknown[]): unknown {
    const start = Date.now();
    const requestArgs = (args[0] as OpenAIResponsesRequest) || {};
    const callTags = buildTags(config, "openai", requestArgs);
    const id = generateId();
    const isStream = requestArgs.stream === true;
    const traceMeta = buildTraceMeta(config);

    const recordFailure = (err: unknown): void => {
      try {
        const errorDetails = extractErrorDetails(err);
        recorder.record({
          id,
          provider: "openai",
          model: requestArgs.model || "unknown",
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
          costUsd: 0,
          latencyMs: Date.now() - start,
          timestamp: new Date().toISOString(),
          tags: callTags,
          ...traceMeta,
          error: err instanceof Error ? err.message : String(err),
          ...(errorDetails ? { errorDetails } : {}),
          requestMeta: buildResponsesRequestMeta(requestArgs),
        });
      } catch {
        /* Recording is best-effort */
      }
    };

    const recordSuccess = (response0: unknown): void => {
      try {
        const response = response0 as OpenAIResponsesResponse;
        const latencyMs = Date.now() - start;
        const model = response.model || requestArgs.model || "unknown";
        const promptTokens = response.usage?.input_tokens ?? 0;
        const completionTokens = response.usage?.output_tokens ?? 0;
        const cachedReadTokens = response.usage?.input_tokens_details?.cached_tokens ?? 0;
        const cost = calculateCostWithCache(
          "openai",
          model,
          promptTokens,
          completionTokens,
          cachedReadTokens,
          0,
        );
        const record: LlmCallRecord = {
          id,
          provider: "openai",
          model,
          promptTokens,
          completionTokens,
          totalTokens: response.usage?.total_tokens ?? promptTokens + completionTokens,
          ...(cachedReadTokens > 0 ? { cachedReadTokens } : {}),
          costUsd: cost.costUsd,
          ...(cost.cacheSavingsUsd > 0 ? { cacheSavingsUsd: cost.cacheSavingsUsd } : {}),
          latencyMs,
          timestamp: new Date().toISOString(),
          tags: callTags,
          ...traceMeta,
          requestMeta: buildResponsesRequestMeta(requestArgs),
        };
        if (config.captureContent === true) {
          const promptBody = extractOpenAIResponsesPromptBody(requestArgs);
          if (promptBody !== undefined) record.promptBody = promptBody;
          const completionBody = extractOpenAIResponsesCompletionBody(response);
          if (completionBody !== undefined) record.completionBody = completionBody;
          const toolCalls = extractOpenAIResponsesToolCalls(response);
          if (toolCalls !== undefined) record.toolCalls = toolCalls;
        }
        recorder.record(record);
      } catch {
        /* Recording is best-effort */
      }
    };

    // ---- Non-stream + gate disabled: identity fast path (same shape as chat) ----
    if (!isStream && !recorder.budgetGate.isActive) {
      let ret: unknown;
      try {
        ret = originalCreate(...args);
      } catch (err: unknown) {
        recordFailure(err);
        throw err;
      }
      if (isThenable(ret)) {
        ret.then(
          (res) => recordSuccess(res),
          (err) => recordFailure(err),
        );
        return ret;
      }
      recordSuccess(ret);
      return ret;
    }

    // ---- Deferred path (gate enabled or stream) ----
    const sourceBox: Promise<APIPromiseBox> = (async () => {
      await recorder.budgetGate.check({ model: requestArgs.model, payload: requestArgs });
      return { api: originalCreate(...args) };
    })();

    if (!isStream) {
      const settled = sourceBox
        .then((box) => Promise.resolve(box.api))
        .then(
          (res) => {
            recordSuccess(res);
            return res;
          },
          (err: unknown) => {
            recordFailure(err);
            throw err;
          },
        );
      return makeCompatAPIPromise(settled, sourceBox, (v) => v);
    }

    // ---- stream ----
    const capture = buildStreamCapture(config, () =>
      extractOpenAIResponsesPromptBody(requestArgs),
    );
    const wrapForRecord = (raw: unknown): AsyncGenerator<unknown> =>
      wrapOpenAIResponsesStream(
        raw as AsyncIterable<unknown>,
        recorder,
        requestArgs,
        start,
        id,
        callTags,
        traceMeta,
        capture,
      );
    let transformDone = false;
    let transformedValue: unknown;
    const transformOnce = (raw: unknown): unknown => {
      if (transformDone) return transformedValue;
      if (hasTee(raw)) {
        try {
          const [obs, user] = raw.tee();
          transformDone = true;
          transformedValue = user;
          void drainRecordingStream(wrapForRecord(obs));
          return user;
        } catch {
          /* tee failed — fall back to the legacy path */
        }
      }
      transformDone = true;
      transformedValue = wrapForRecord(raw);
      return transformedValue;
    };
    const settled = sourceBox
      .then((box) => Promise.resolve(box.api))
      .then(
        (raw) => transformOnce(raw),
        (err: unknown) => {
          recordFailure(err);
          throw err;
        },
      );
    return makeCompatAPIPromise(settled, sourceBox, transformOnce);
  };
}

/**
 * Recording generator for Responses API streams (extracted from inline code in
 * 2026-07). Accumulates response.output_text.delta / refusal.delta and
 * finalizes with the usage from response.completed. Also handles error /
 * response.failed / response.incomplete events. On the full-compat path this
 * drains the tee's observation branch while the user branch stays the real
 * Stream that is returned.
 */
async function* wrapOpenAIResponsesStream(
  stream: AsyncIterable<unknown>,
  recorder: Recorder,
  requestArgs: OpenAIResponsesRequest,
  start: number,
  id: string,
  callTags: Record<string, string>,
  traceMeta: TraceMeta,
  capture: StreamCapture | undefined,
): AsyncGenerator<unknown> {
  {
    {
      {
        let model = requestArgs.model || "unknown";
        let usage: OpenAIResponsesResponse["usage"] | undefined;
        let completed = false;
        let recorded = false;
        // Handle terminal failures arriving as stream events, and the case where completion was never observed.
        let sawCompleted = false;
        let incomplete = false;
        let streamError: string | undefined;
        const recordOnce = (): void => {
          if (recorded) return;
          recorded = true;
          // Turn error/failed stream events into an error record and suppress the success record.
          if (streamError !== undefined) {
            const errRecord: LlmCallRecord = {
              id,
              provider: "openai",
              model,
              promptTokens: 0,
              completionTokens: 0,
              totalTokens: 0,
              costUsd: 0,
              latencyMs: Date.now() - start,
              timestamp: new Date().toISOString(),
              tags: callTags,
              ...traceMeta,
              error: streamError,
              requestMeta: buildResponsesRequestMeta(requestArgs),
            };
            applyStreamCapture(errRecord, capture, true);
            recorder.record(errRecord);
            return;
          }
          const promptTokens = usage?.input_tokens ?? 0;
          const completionTokens = usage?.output_tokens ?? 0;
          const cachedReadTokens = usage?.input_tokens_details?.cached_tokens ?? 0;
          const cost = calculateCostWithCache(
            "openai",
            model,
            promptTokens,
            completionTokens,
            cachedReadTokens,
            0,
          );
          const record: LlmCallRecord = {
            id,
            provider: "openai",
            model,
            promptTokens,
            completionTokens,
            totalTokens: usage?.total_tokens ?? promptTokens + completionTokens,
            ...(cachedReadTokens > 0 ? { cachedReadTokens } : {}),
            costUsd: cost.costUsd,
            ...(cost.cacheSavingsUsd > 0 ? { cacheSavingsUsd: cost.cacheSavingsUsd } : {}),
            latencyMs: Date.now() - start,
            timestamp: new Date().toISOString(),
            tags: callTags,
            ...traceMeta,
            requestMeta: buildResponsesRequestMeta(requestArgs),
          };
          const truncated = !completed || !sawCompleted || incomplete;
          applyStreamCapture(record, capture, truncated);
          recorder.record(record);
        };
        try {
          for await (const event of stream) {
            const ev = event as {
              type?: string;
              delta?: unknown;
              message?: unknown;
              code?: unknown;
              response?: OpenAIResponsesResponse & { error?: { message?: unknown } };
            };
            // Content deltas include both output_text and refusal (refusal was missing originally).
            if (
              (ev.type === "response.output_text.delta" ||
                ev.type === "response.refusal.delta") &&
              typeof ev.delta === "string"
            ) {
              capture?.acc.push(ev.delta);
            } else if (
              (ev.type === "response.completed" || ev.type === "response.incomplete") &&
              ev.response
            ) {
              if (ev.response.model) model = ev.response.model;
              if (ev.response.usage) usage = ev.response.usage;
              sawCompleted = true;
              incomplete = ev.type === "response.incomplete";
            } else if (ev.type === "error" || ev.type === "response.failed") {
              // Record terminal errors that arrive as stream events.
              const respErr = ev.response?.error?.message;
              streamError =
                typeof respErr === "string"
                  ? respErr
                  : typeof ev.message === "string"
                    ? ev.message
                    : typeof ev.code === "string"
                      ? ev.code
                      : "responses stream error event";
            }
            yield event;
          }
          const aborted =
            (stream as { controller?: { signal?: { aborted?: boolean } } })
              .controller?.signal?.aborted === true;
          completed = !aborted;
          recordOnce();
        } catch (err: unknown) {
          recorded = true;
          const errorDetails = extractErrorDetails(err);
          const errorRecord: LlmCallRecord = {
            id,
            provider: "openai",
            model,
            promptTokens: 0,
            completionTokens: 0,
            totalTokens: 0,
            costUsd: 0,
            latencyMs: Date.now() - start,
            timestamp: new Date().toISOString(),
            tags: callTags,
            ...traceMeta,
            error: err instanceof Error ? err.message : String(err),
            ...(errorDetails ? { errorDetails } : {}),
            requestMeta: buildResponsesRequestMeta(requestArgs),
          };
          applyStreamCapture(errorRecord, capture, true);
          recorder.record(errorRecord);
          throw err;
        } finally {
          recordOnce();
        }
      }
    }
  }
}

function buildResponsesRequestMeta(
  requestArgs: OpenAIResponsesRequest,
): NonNullable<LlmCallRecord["requestMeta"]> {
  const meta: NonNullable<LlmCallRecord["requestMeta"]> = {};
  if (Array.isArray(requestArgs.input)) meta.messagesCount = requestArgs.input.length;
  else if (typeof requestArgs.input === "string") meta.messagesCount = 1;
  if (typeof requestArgs.temperature === "number") meta.temperature = requestArgs.temperature;
  if (typeof requestArgs.max_output_tokens === "number") meta.maxTokens = requestArgs.max_output_tokens;
  return meta;
}

// ============================================================
// Anthropic
// ============================================================

interface AnthropicLike {
  messages: { create: (...args: unknown[]) => Promise<unknown> };
}

function isAnthropicLike(client: unknown): client is AnthropicLike {
  const c = client as Partial<AnthropicLike>;
  return typeof c?.messages?.create === "function";
}

interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

interface AnthropicResponse {
  model?: string;
  usage?: AnthropicUsage;
}

interface AnthropicStreamEvent {
  type?: string;
  message?: {
    model?: string;
    usage?: AnthropicUsage;
  };
  usage?: AnthropicUsage;
  // On content_block_delta this holds { type: "text_delta", text } (used for plaintext capture).
  delta?: { type?: string; text?: unknown };
}

interface AnthropicRequest {
  model?: string;
  messages?: unknown[];
  max_tokens?: number;
  temperature?: number;
  stream?: boolean;
}

function wrapAnthropic(client: object, recorder: Recorder, config: ArgosvixConfig): void {
  const c = client as unknown as AnthropicLike;
  const originalCreate = c.messages.create.bind(c.messages);
  warnIfGatedStreamHelper(
    config,
    typeof (c.messages as { stream?: unknown }).stream === "function",
    "anthropic messages.stream()",
  );

  c.messages.create = async function (...args: unknown[]): Promise<unknown> {
    const start = Date.now();
    const requestArgs = (args[0] as AnthropicRequest) || {};
    const callTags = buildTags(config, "anthropic", requestArgs);
    const id = generateId();
    const isStream = requestArgs.stream === true;

    try {
      await recorder.budgetGate.check({ model: requestArgs.model, payload: requestArgs });
      const response = await originalCreate(...args);
      if (isStream) {
        return wrapAnthropicStream(
          response as AsyncIterable<AnthropicStreamEvent>,
          recorder,
          requestArgs,
          start,
          id,
          callTags,
          buildTraceMeta(config),
          buildStreamCapture(config, () => extractAnthropicPromptBody(requestArgs)),
        );
      }
      const r = response as AnthropicResponse;
      const latencyMs = Date.now() - start;
      const model = r.model || requestArgs.model || "unknown";
      // Anthropic: input_tokens counts only non-cached input. Cache reads/writes
      // are reported separately, so add them back into promptTokens (total input).
      const cachedReadTokens = r.usage?.cache_read_input_tokens ?? 0;
      const cachedWriteTokens = r.usage?.cache_creation_input_tokens ?? 0;
      const promptTokens =
        (r.usage?.input_tokens ?? 0) + cachedReadTokens + cachedWriteTokens;
      const completionTokens = r.usage?.output_tokens ?? 0;
      const cost = calculateCostWithCache(
        "anthropic",
        model,
        promptTokens,
        completionTokens,
        cachedReadTokens,
        cachedWriteTokens,
      );
      const record: LlmCallRecord = {
        id,
        provider: "anthropic",
        model,
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
        cachedReadTokens,
        cachedWriteTokens,
        cacheSavingsUsd: cost.cacheSavingsUsd,
        costUsd: cost.costUsd,
        latencyMs,
        timestamp: new Date().toISOString(),
        tags: callTags,
        ...buildTraceMeta(config),
        requestMeta: buildAnthropicRequestMeta(requestArgs),
      };
      if (config.captureContent === true) {
        const promptBody = extractAnthropicPromptBody(requestArgs);
        if (promptBody !== undefined) record.promptBody = promptBody;
        const completionBody = extractAnthropicCompletionBody(response);
        if (completionBody !== undefined) record.completionBody = completionBody;
      }
      recorder.record(record);
      return response;
    } catch (err: unknown) {
      const errorDetails = extractErrorDetails(err);
      recorder.record({
        id,
        provider: "anthropic",
        model: requestArgs.model || "unknown",
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        costUsd: 0,
        latencyMs: Date.now() - start,
        timestamp: new Date().toISOString(),
        tags: callTags,
        ...buildTraceMeta(config),
        error: err instanceof Error ? err.message : String(err),
        ...(errorDetails ? { errorDetails } : {}),
        requestMeta: buildAnthropicRequestMeta(requestArgs),
      });
      throw err;
    }
  };
}

async function* wrapAnthropicStream(
  stream: AsyncIterable<AnthropicStreamEvent>,
  recorder: Recorder,
  requestArgs: AnthropicRequest,
  start: number,
  id: string,
  callTags: Record<string, string>,
  traceMeta: TraceMeta,
  // Streaming plaintext capture (passed only when captureContent=true).
  capture?: StreamCapture,
): AsyncGenerator<AnthropicStreamEvent> {
  let model = requestArgs.model || "unknown";
  // Anthropic: input_tokens counts only non-cached input. Cache reads/writes are reported separately.
  let inputTokens = 0;
  let cachedReadTokens = 0;
  let cachedWriteTokens = 0;
  let completionTokens = 0;
  // Whether the stream ran to completion (stays false on early break / abandon → the body gets the truncated marker).
  let completed = false;

  // Record exactly once with the observed tokens even on early break (same as OpenAI; 2026-06-28).
  let recorded = false;
  const recordOnce = (): void => {
    if (recorded) return;
    recorded = true;
    const promptTokens = inputTokens + cachedReadTokens + cachedWriteTokens;
    const cost = calculateCostWithCache(
      "anthropic",
      model,
      promptTokens,
      completionTokens,
      cachedReadTokens,
      cachedWriteTokens,
    );
    const record: LlmCallRecord = {
      id,
      provider: "anthropic",
      model,
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
      ...(cachedReadTokens > 0 ? { cachedReadTokens } : {}),
      ...(cachedWriteTokens > 0 ? { cachedWriteTokens } : {}),
      costUsd: cost.costUsd,
      ...(cost.cacheSavingsUsd > 0 ? { cacheSavingsUsd: cost.cacheSavingsUsd } : {}),
      latencyMs: Date.now() - start,
      timestamp: new Date().toISOString(),
      tags: callTags,
      ...traceMeta,
      requestMeta: buildAnthropicRequestMeta(requestArgs),
    };
    applyStreamCapture(record, capture, !completed);
    recorder.record(record);
  };

  try {
    for await (const event of stream) {
      if (
        capture &&
        event.type === "content_block_delta" &&
        event.delta?.type === "text_delta" &&
        typeof event.delta.text === "string"
      ) {
        // Accumulate text deltas only (tool-argument input_json_delta etc. are out of scope).
        capture.acc.push(event.delta.text);
      }
      if (event.type === "message_start" && event.message) {
        if (event.message.model) model = event.message.model;
        if (event.message.usage) {
          inputTokens = event.message.usage.input_tokens ?? inputTokens;
          cachedReadTokens =
            event.message.usage.cache_read_input_tokens ?? cachedReadTokens;
          cachedWriteTokens =
            event.message.usage.cache_creation_input_tokens ?? cachedWriteTokens;
          completionTokens = event.message.usage.output_tokens ?? completionTokens;
        }
      }
      if (event.type === "message_delta" && event.usage) {
        completionTokens = event.usage.output_tokens ?? completionTokens;
      }
      yield event;
    }
    completed = true;
    recordOnce();
  } catch (err: unknown) {
    recorded = true;
    const errorDetails = extractErrorDetails(err);
    const promptTokens = inputTokens + cachedReadTokens + cachedWriteTokens;
    const errorRecord: LlmCallRecord = {
      id,
      provider: "anthropic",
      model,
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
      costUsd: calculateCost("anthropic", model, promptTokens, completionTokens),
      latencyMs: Date.now() - start,
      timestamp: new Date().toISOString(),
      tags: callTags,
      ...traceMeta,
      error: err instanceof Error ? err.message : String(err),
      ...(errorDetails ? { errorDetails } : {}),
      requestMeta: buildAnthropicRequestMeta(requestArgs),
    };
    // When cut off by an exception, put the body captured so far + the truncated marker on the record.
    applyStreamCapture(errorRecord, capture, true);
    recorder.record(errorRecord);
    throw err;
  } finally {
    recordOnce();
  }
}

function buildAnthropicRequestMeta(
  requestArgs: AnthropicRequest,
): NonNullable<LlmCallRecord["requestMeta"]> {
  const meta: NonNullable<LlmCallRecord["requestMeta"]> = {};
  if (Array.isArray(requestArgs.messages)) meta.messagesCount = requestArgs.messages.length;
  if (typeof requestArgs.temperature === "number") meta.temperature = requestArgs.temperature;
  if (typeof requestArgs.max_tokens === "number") meta.maxTokens = requestArgs.max_tokens;
  return meta;
}

// ============================================================
// Mistral
// ============================================================

interface MistralLike {
  chat: {
    complete: (...args: unknown[]) => Promise<unknown>;
    stream?: (...args: unknown[]) => Promise<unknown>;
  };
}

function isMistralLike(client: unknown): client is MistralLike {
  const c = client as Partial<MistralLike>;
  return typeof c?.chat?.complete === "function";
}

interface MistralResponse {
  model?: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

interface MistralStreamChunk {
  data?: {
    model?: string;
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    choices?: Array<{ delta?: unknown; finish_reason?: string | null }>;
  };
  model?: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  choices?: Array<{ delta?: unknown; finish_reason?: string | null }>;
}

interface MistralRequest {
  model?: string;
  messages?: unknown[];
  temperature?: number;
  max_tokens?: number;
}

function wrapMistral(client: object, recorder: Recorder, config: ArgosvixConfig): void {
  const c = client as unknown as MistralLike;
  const originalComplete = c.chat.complete.bind(c.chat);

  c.chat.complete = async function (...args: unknown[]): Promise<unknown> {
    const start = Date.now();
    const requestArgs = (args[0] as MistralRequest) || {};
    const callTags = buildTags(config, "mistral", requestArgs);
    const id = generateId();
    try {
      await recorder.budgetGate.check({ model: requestArgs.model, payload: requestArgs });
      const response = (await originalComplete(...args)) as MistralResponse;
      const latencyMs = Date.now() - start;
      const model = response.model || requestArgs.model || "unknown";
      const promptTokens = response.usage?.prompt_tokens ?? 0;
      const completionTokens = response.usage?.completion_tokens ?? 0;
      const record: LlmCallRecord = {
        id,
        provider: "mistral",
        model,
        promptTokens,
        completionTokens,
        totalTokens: response.usage?.total_tokens ?? promptTokens + completionTokens,
        costUsd: calculateCost("mistral", model, promptTokens, completionTokens),
        latencyMs,
        timestamp: new Date().toISOString(),
        tags: callTags,
        ...buildTraceMeta(config),
        requestMeta: buildMistralRequestMeta(requestArgs),
      };
      if (config.captureContent === true) {
        const promptBody = extractMistralPromptBody(requestArgs);
        if (promptBody !== undefined) record.promptBody = promptBody;
        const completionBody = extractMistralCompletionBody(response);
        if (completionBody !== undefined) record.completionBody = completionBody;
      }
      recorder.record(record);
      return response;
    } catch (err: unknown) {
      const errorDetails = extractErrorDetails(err);
      recorder.record({
        id,
        provider: "mistral",
        model: requestArgs.model || "unknown",
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        costUsd: 0,
        latencyMs: Date.now() - start,
        timestamp: new Date().toISOString(),
        tags: callTags,
        ...buildTraceMeta(config),
        error: err instanceof Error ? err.message : String(err),
        ...(errorDetails ? { errorDetails } : {}),
        requestMeta: buildMistralRequestMeta(requestArgs),
      });
      throw err;
    }
  };

  if (typeof c.chat.stream === "function") {
    const originalStream = c.chat.stream.bind(c.chat);
    c.chat.stream = async function (...args: unknown[]): Promise<unknown> {
      const start = Date.now();
      const requestArgs = (args[0] as MistralRequest) || {};
      const callTags = buildTags(config, "mistral", requestArgs);
      const id = generateId();
      try {
        await recorder.budgetGate.check({ model: requestArgs.model, payload: requestArgs });
        const stream = (await originalStream(...args)) as AsyncIterable<MistralStreamChunk>;
        return wrapMistralStream(
          stream,
          recorder,
          requestArgs,
          start,
          id,
          callTags,
          buildTraceMeta(config),
          buildStreamCapture(config, () => extractMistralPromptBody(requestArgs)),
        );
      } catch (err: unknown) {
        // Stream initialization error (auth/validation/connection)
        const errorDetails = extractErrorDetails(err);
        recorder.record({
          id,
          provider: "mistral",
          model: requestArgs.model || "unknown",
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
          costUsd: 0,
          latencyMs: Date.now() - start,
          timestamp: new Date().toISOString(),
          tags: callTags,
        ...buildTraceMeta(config),
          error: err instanceof Error ? err.message : String(err),
          ...(errorDetails ? { errorDetails } : {}),
          requestMeta: buildMistralRequestMeta(requestArgs),
        });
        throw err;
      }
    };
  }
}

async function* wrapMistralStream(
  stream: AsyncIterable<MistralStreamChunk>,
  recorder: Recorder,
  requestArgs: MistralRequest,
  start: number,
  id: string,
  callTags: Record<string, string>,
  traceMeta: TraceMeta,
  // Streaming plaintext capture (passed only when captureContent=true).
  capture?: StreamCapture,
): AsyncGenerator<MistralStreamChunk> {
  let model = requestArgs.model || "unknown";
  let promptTokens = 0;
  let completionTokens = 0;
  let reportedTotal: number | undefined;
  // Whether the stream ran to completion (stays false on early break / abandon → the body gets the truncated marker).
  let completed = false;

  // Record exactly once with the observed tokens even on early break (same as OpenAI; 2026-06-28).
  let recorded = false;
  const recordOnce = (): void => {
    if (recorded) return;
    recorded = true;
    const record: LlmCallRecord = {
      id,
      provider: "mistral",
      model,
      promptTokens,
      completionTokens,
      totalTokens: reportedTotal ?? promptTokens + completionTokens,
      costUsd: calculateCost("mistral", model, promptTokens, completionTokens),
      latencyMs: Date.now() - start,
      timestamp: new Date().toISOString(),
      tags: callTags,
      ...traceMeta,
      requestMeta: buildMistralRequestMeta(requestArgs),
    };
    applyStreamCapture(record, capture, !completed);
    recorder.record(record);
  };

  try {
    for await (const chunk of stream) {
      const inner = chunk.data ?? chunk;
      if (capture) {
        // Mistral uses the OpenAI-Chat-compatible delta shape (choices[0].delta.content, strings only).
        const delta = inner.choices?.[0]?.delta as { content?: unknown } | undefined;
        if (typeof delta?.content === "string") capture.acc.push(delta.content);
      }
      if (inner.model) model = inner.model;
      if (inner.usage) {
        promptTokens = inner.usage.prompt_tokens ?? promptTokens;
        completionTokens = inner.usage.completion_tokens ?? completionTokens;
        if (typeof inner.usage.total_tokens === "number") {
          reportedTotal = inner.usage.total_tokens;
        }
      }
      yield chunk;
    }
    completed = true;
    recordOnce();
  } catch (err: unknown) {
    recorded = true;
    const errorDetails = extractErrorDetails(err);
    const errorRecord: LlmCallRecord = {
      id,
      provider: "mistral",
      model,
      promptTokens,
      completionTokens,
      totalTokens: reportedTotal ?? promptTokens + completionTokens,
      costUsd: calculateCost("mistral", model, promptTokens, completionTokens),
      latencyMs: Date.now() - start,
      timestamp: new Date().toISOString(),
      tags: callTags,
      ...traceMeta,
      error: err instanceof Error ? err.message : String(err),
      ...(errorDetails ? { errorDetails } : {}),
      requestMeta: buildMistralRequestMeta(requestArgs),
    };
    // When cut off by an exception, put the body captured so far + the truncated marker on the record.
    applyStreamCapture(errorRecord, capture, true);
    recorder.record(errorRecord);
    throw err;
  } finally {
    recordOnce();
  }
}

function buildMistralRequestMeta(
  requestArgs: MistralRequest,
): NonNullable<LlmCallRecord["requestMeta"]> {
  const meta: NonNullable<LlmCallRecord["requestMeta"]> = {};
  if (Array.isArray(requestArgs.messages)) meta.messagesCount = requestArgs.messages.length;
  if (typeof requestArgs.temperature === "number") meta.temperature = requestArgs.temperature;
  if (typeof requestArgs.max_tokens === "number") meta.maxTokens = requestArgs.max_tokens;
  return meta;
}

// ============================================================
// Gemini Legacy (@google/generative-ai)
// ============================================================

interface GeminiLegacyLike {
  getGenerativeModel: (params: { model: string }) => GeminiLegacyModelLike;
}

interface GeminiLegacyModelLike {
  generateContent: (...args: unknown[]) => Promise<unknown>;
  generateContentStream?: (...args: unknown[]) => Promise<unknown>;
}

function isGeminiLegacyLike(client: unknown): client is GeminiLegacyLike {
  const c = client as Partial<GeminiLegacyLike>;
  return typeof c?.getGenerativeModel === "function";
}

interface GeminiUsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
  // Prompt caching: cached tokens are included in promptTokenCount (a subset).
  cachedContentTokenCount?: number;
}

function wrapGeminiLegacy(
  client: object,
  recorder: Recorder,
  config: ArgosvixConfig,
): void {
  const c = client as unknown as GeminiLegacyLike;
  const originalGetModel = c.getGenerativeModel.bind(c);

  c.getGenerativeModel = function (params: { model: string }): GeminiLegacyModelLike {
    const modelInstance = originalGetModel(params);
    // Idempotent re-wrap: track model instances via WeakSet to avoid double-wrap.
    if (wrappedGeminiModels.has(modelInstance)) {
      return modelInstance;
    }
    wrappedGeminiModels.add(modelInstance);
    wrapGeminiLegacyModel(modelInstance, params.model, recorder, config);
    return modelInstance;
  };
}

function wrapGeminiLegacyModel(
  model: GeminiLegacyModelLike,
  modelName: string,
  recorder: Recorder,
  config: ArgosvixConfig,
): void {
  const originalGenerate = model.generateContent.bind(model);

  model.generateContent = async function (...args: unknown[]): Promise<unknown> {
    const start = Date.now();
    const id = generateId();
    const requestArgs = args[0];
    const callTags = buildTags(config, "gemini", requestArgs);
    try {
      await recorder.budgetGate.check({ model: modelName, payload: requestArgs });
      const result = (await originalGenerate(...args)) as {
        response?: { usageMetadata?: GeminiUsageMetadata };
      };
      const usage = result.response?.usageMetadata;
      const promptTokens = usage?.promptTokenCount ?? 0;
      const completionTokens = usage?.candidatesTokenCount ?? 0;
      const cachedReadTokens = usage?.cachedContentTokenCount ?? 0;
      const cost = calculateCostWithCache(
        "gemini",
        modelName,
        promptTokens,
        completionTokens,
        cachedReadTokens,
        0,
      );
      const record: LlmCallRecord = {
        id,
        provider: "gemini",
        model: modelName,
        promptTokens,
        completionTokens,
        totalTokens: usage?.totalTokenCount ?? promptTokens + completionTokens,
        ...(cachedReadTokens > 0 ? { cachedReadTokens } : {}),
        costUsd: cost.costUsd,
        ...(cost.cacheSavingsUsd > 0 ? { cacheSavingsUsd: cost.cacheSavingsUsd } : {}),
        latencyMs: Date.now() - start,
        timestamp: new Date().toISOString(),
        tags: callTags,
        ...buildTraceMeta(config),
        requestMeta: buildGeminiRequestMeta(requestArgs),
      };
      if (config.captureContent === true) {
        const promptBody = extractGeminiPromptBody(requestArgs);
        if (promptBody !== undefined) record.promptBody = promptBody;
        const completionBody = extractGeminiCompletionBody(result.response);
        if (completionBody !== undefined) record.completionBody = completionBody;
      }
      recorder.record(record);
      return result;
    } catch (err: unknown) {
      const errorDetails = extractErrorDetails(err);
      recorder.record({
        id,
        provider: "gemini",
        model: modelName,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        costUsd: 0,
        latencyMs: Date.now() - start,
        timestamp: new Date().toISOString(),
        tags: callTags,
        ...buildTraceMeta(config),
        error: err instanceof Error ? err.message : String(err),
        ...(errorDetails ? { errorDetails } : {}),
        requestMeta: buildGeminiRequestMeta(requestArgs),
      });
      throw err;
    }
  };

  if (typeof model.generateContentStream === "function") {
    const originalStream = model.generateContentStream.bind(model);
    model.generateContentStream = async function (...args: unknown[]): Promise<unknown> {
      const start = Date.now();
      const id = generateId();
      const requestArgs = args[0];
      const callTags = buildTags(config, "gemini", requestArgs);
      try {
        await recorder.budgetGate.check({ model: modelName, payload: requestArgs });
        const result = (await originalStream(...args)) as {
          stream?: AsyncIterable<unknown>;
          response?: Promise<{ usageMetadata?: GeminiUsageMetadata }>;
        };
        if (!result.stream) return result;
        // If the consumer breaks early or abandons the stream, the generator
        // gets .return()ed and the post-loop recording is skipped, so a billed
        // call would never be recorded (as with the other 3 providers,
        // recordOnce() + finally record exactly once on completion, error, or
        // early termination).
        const originalStreamRef = result.stream;
        // The trace fields are snapshotted at stream creation (the entry point, where the ambient context is still active).
        const traceMeta = buildTraceMeta(config);
        // Streaming plaintext capture: promptBody snapshotted at entry + delta accumulation.
        const capture = buildStreamCapture(config, () =>
          extractGeminiPromptBody(requestArgs),
        );
        const wrappedStream = (async function* () {
          let completed = false;
          let recorded = false;
          // Legacy Gemini only exposes usage via result.response after the
          // stream completes, so on early break we record 0 tokens (+ the
          // truncated marker). result.response is awaited only on full
          // completion (awaiting it after an early break can hang or consume
          // extra).
          let promptTokens = 0;
          let completionTokens = 0;
          let cachedReadTokens = 0;
          let totalTokens: number | undefined;
          const recordOnce = (): void => {
            if (recorded) return;
            recorded = true;
            const cost = calculateCostWithCache(
              "gemini",
              modelName,
              promptTokens,
              completionTokens,
              cachedReadTokens,
              0,
            );
            const record: LlmCallRecord = {
              id,
              provider: "gemini",
              model: modelName,
              promptTokens,
              completionTokens,
              totalTokens: totalTokens ?? promptTokens + completionTokens,
              ...(cachedReadTokens > 0 ? { cachedReadTokens } : {}),
              costUsd: cost.costUsd,
              ...(cost.cacheSavingsUsd > 0 ? { cacheSavingsUsd: cost.cacheSavingsUsd } : {}),
              latencyMs: Date.now() - start,
              timestamp: new Date().toISOString(),
              tags: callTags,
              ...traceMeta,
              requestMeta: buildGeminiRequestMeta(requestArgs),
            };
            applyStreamCapture(record, capture, !completed);
            recorder.record(record);
          };
          try {
            for await (const chunk of originalStreamRef) {
              capture?.acc.push(extractGeminiStreamChunkText(chunk));
              yield chunk;
            }
            const finalResponse = await result.response;
            const usage = finalResponse?.usageMetadata;
            promptTokens = usage?.promptTokenCount ?? 0;
            completionTokens = usage?.candidatesTokenCount ?? 0;
            cachedReadTokens = usage?.cachedContentTokenCount ?? 0;
            totalTokens = usage?.totalTokenCount;
            completed = true;
            recordOnce();
          } catch (err: unknown) {
            recorded = true;
            const errorDetails = extractErrorDetails(err);
            const errorRecord: LlmCallRecord = {
              id,
              provider: "gemini",
              model: modelName,
              promptTokens: 0,
              completionTokens: 0,
              totalTokens: 0,
              costUsd: 0,
              latencyMs: Date.now() - start,
              timestamp: new Date().toISOString(),
              tags: callTags,
              ...traceMeta,
              error: err instanceof Error ? err.message : String(err),
              ...(errorDetails ? { errorDetails } : {}),
              requestMeta: buildGeminiRequestMeta(requestArgs),
            };
            // When cut off by an exception, put the body captured so far + the truncated marker on the record.
            applyStreamCapture(errorRecord, capture, true);
            recorder.record(errorRecord);
            throw err;
          } finally {
            // Early break / abandon path. No-op if the stream already completed normally or errored.
            recordOnce();
          }
        })();
        return { ...result, stream: wrappedStream };
      } catch (err: unknown) {
        const errorDetails = extractErrorDetails(err);
        recorder.record({
          id,
          provider: "gemini",
          model: modelName,
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
          costUsd: 0,
          latencyMs: Date.now() - start,
          timestamp: new Date().toISOString(),
          tags: callTags,
        ...buildTraceMeta(config),
          error: err instanceof Error ? err.message : String(err),
          ...(errorDetails ? { errorDetails } : {}),
          requestMeta: buildGeminiRequestMeta(requestArgs),
        });
        throw err;
      }
    };
  }
}

// ============================================================
// Gemini New (@google/genai)
// ============================================================

interface GeminiNewLike {
  models: {
    generateContent: (...args: unknown[]) => Promise<unknown>;
    generateContentStream?: (...args: unknown[]) => Promise<unknown>;
  };
}

function isGeminiNewLike(client: unknown): client is GeminiNewLike {
  const c = client as Partial<GeminiNewLike>;
  return typeof c?.models?.generateContent === "function";
}

interface GeminiNewRequest {
  model?: string;
  contents?: unknown;
  config?: unknown;
}

function wrapGeminiNew(client: object, recorder: Recorder, config: ArgosvixConfig): void {
  const c = client as unknown as GeminiNewLike;
  const originalGenerate = c.models.generateContent.bind(c.models);

  c.models.generateContent = async function (...args: unknown[]): Promise<unknown> {
    const start = Date.now();
    const id = generateId();
    const requestArgs = (args[0] as GeminiNewRequest) || {};
    const callTags = buildTags(config, "gemini", requestArgs);
    const modelName = requestArgs.model || "unknown";
    try {
      await recorder.budgetGate.check({ model: modelName, payload: requestArgs });
      const result = (await originalGenerate(...args)) as {
        usageMetadata?: GeminiUsageMetadata;
      };
      const usage = result.usageMetadata;
      const promptTokens = usage?.promptTokenCount ?? 0;
      const completionTokens = usage?.candidatesTokenCount ?? 0;
      const cachedReadTokens = usage?.cachedContentTokenCount ?? 0;
      const cost = calculateCostWithCache(
        "gemini",
        modelName,
        promptTokens,
        completionTokens,
        cachedReadTokens,
        0,
      );
      const record: LlmCallRecord = {
        id,
        provider: "gemini",
        model: modelName,
        promptTokens,
        completionTokens,
        totalTokens: usage?.totalTokenCount ?? promptTokens + completionTokens,
        ...(cachedReadTokens > 0 ? { cachedReadTokens } : {}),
        costUsd: cost.costUsd,
        ...(cost.cacheSavingsUsd > 0 ? { cacheSavingsUsd: cost.cacheSavingsUsd } : {}),
        latencyMs: Date.now() - start,
        timestamp: new Date().toISOString(),
        tags: callTags,
        ...buildTraceMeta(config),
        requestMeta: buildGeminiNewRequestMeta(requestArgs),
      };
      if (config.captureContent === true) {
        const promptBody = extractGeminiPromptBody(requestArgs);
        if (promptBody !== undefined) record.promptBody = promptBody;
        const completionBody = extractGeminiCompletionBody(result);
        if (completionBody !== undefined) record.completionBody = completionBody;
      }
      recorder.record(record);
      return result;
    } catch (err: unknown) {
      const errorDetails = extractErrorDetails(err);
      recorder.record({
        id,
        provider: "gemini",
        model: modelName,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        costUsd: 0,
        latencyMs: Date.now() - start,
        timestamp: new Date().toISOString(),
        tags: callTags,
        ...buildTraceMeta(config),
        error: err instanceof Error ? err.message : String(err),
        ...(errorDetails ? { errorDetails } : {}),
        requestMeta: buildGeminiNewRequestMeta(requestArgs),
      });
      throw err;
    }
  };

  if (typeof c.models.generateContentStream === "function") {
    const originalStream = c.models.generateContentStream.bind(c.models);
    c.models.generateContentStream = async function (...args: unknown[]): Promise<unknown> {
      const start = Date.now();
      const id = generateId();
      const requestArgs = (args[0] as GeminiNewRequest) || {};
      const callTags = buildTags(config, "gemini", requestArgs);
      const modelName = requestArgs.model || "unknown";
      try {
        await recorder.budgetGate.check({ model: modelName, payload: requestArgs });
        const stream = (await originalStream(...args)) as AsyncIterable<{
          usageMetadata?: GeminiUsageMetadata;
        }>;
        // Fix: AsyncGenerator wrap with finally-record + error handling tied to consumption
        // The trace fields are snapshotted at stream creation (the entry point, where the ambient context is still active).
        const traceMeta = buildTraceMeta(config);
        // Streaming plaintext capture: promptBody snapshotted at entry + delta accumulation.
        const capture = buildStreamCapture(config, () =>
          extractGeminiPromptBody(requestArgs),
        );
        return (async function* () {
          let lastUsage: GeminiUsageMetadata | undefined;
          let completed = false;
          let recorded = false;
          const recordOnce = (): void => {
            if (recorded) return;
            recorded = true;
            const promptTokens = lastUsage?.promptTokenCount ?? 0;
            const completionTokens = lastUsage?.candidatesTokenCount ?? 0;
            const cachedReadTokens = lastUsage?.cachedContentTokenCount ?? 0;
            const cost = calculateCostWithCache(
              "gemini",
              modelName,
              promptTokens,
              completionTokens,
              cachedReadTokens,
              0,
            );
            const record: LlmCallRecord = {
              id,
              provider: "gemini",
              model: modelName,
              promptTokens,
              completionTokens,
              totalTokens: lastUsage?.totalTokenCount ?? promptTokens + completionTokens,
              ...(cachedReadTokens > 0 ? { cachedReadTokens } : {}),
              costUsd: cost.costUsd,
              ...(cost.cacheSavingsUsd > 0 ? { cacheSavingsUsd: cost.cacheSavingsUsd } : {}),
              latencyMs: Date.now() - start,
              timestamp: new Date().toISOString(),
              tags: callTags,
              ...traceMeta,
              requestMeta: buildGeminiNewRequestMeta(requestArgs),
            };
            applyStreamCapture(record, capture, !completed);
            recorder.record(record);
          };
          try {
            for await (const chunk of stream) {
              capture?.acc.push(extractGeminiStreamChunkText(chunk));
              if (chunk.usageMetadata) lastUsage = chunk.usageMetadata;
              yield chunk;
            }
            completed = true;
            recordOnce();
          } catch (err: unknown) {
            recorded = true;
            const errorDetails = extractErrorDetails(err);
            const errorRecord: LlmCallRecord = {
              id,
              provider: "gemini",
              model: modelName,
              promptTokens: lastUsage?.promptTokenCount ?? 0,
              completionTokens: lastUsage?.candidatesTokenCount ?? 0,
              totalTokens:
                lastUsage?.totalTokenCount ??
                (lastUsage?.promptTokenCount ?? 0) +
                  (lastUsage?.candidatesTokenCount ?? 0),
              costUsd: 0,
              latencyMs: Date.now() - start,
              timestamp: new Date().toISOString(),
              tags: callTags,
              ...traceMeta,
              error: err instanceof Error ? err.message : String(err),
              ...(errorDetails ? { errorDetails } : {}),
              requestMeta: buildGeminiNewRequestMeta(requestArgs),
            };
            // When cut off by an exception, put the body captured so far + the truncated marker on the record.
            applyStreamCapture(errorRecord, capture, true);
            recorder.record(errorRecord);
            throw err;
          } finally {
            // Early break / abandon path. No-op if the stream already completed normally or errored.
            recordOnce();
          }
        })();
      } catch (err: unknown) {
        const errorDetails = extractErrorDetails(err);
        recorder.record({
          id,
          provider: "gemini",
          model: modelName,
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
          costUsd: 0,
          latencyMs: Date.now() - start,
          timestamp: new Date().toISOString(),
          tags: callTags,
        ...buildTraceMeta(config),
          error: err instanceof Error ? err.message : String(err),
          ...(errorDetails ? { errorDetails } : {}),
          requestMeta: buildGeminiNewRequestMeta(requestArgs),
        });
        throw err;
      }
    };
  }
}

function buildGeminiRequestMeta(
  requestArgs: unknown,
): NonNullable<LlmCallRecord["requestMeta"]> {
  const meta: NonNullable<LlmCallRecord["requestMeta"]> = {};
  if (typeof requestArgs === "string") meta.messagesCount = 1;
  else if (Array.isArray(requestArgs)) meta.messagesCount = requestArgs.length;
  else if (
    requestArgs &&
    typeof requestArgs === "object" &&
    "contents" in requestArgs &&
    Array.isArray((requestArgs as { contents: unknown[] }).contents)
  ) {
    meta.messagesCount = (requestArgs as { contents: unknown[] }).contents.length;
  }
  return meta;
}

function buildGeminiNewRequestMeta(
  requestArgs: GeminiNewRequest,
): NonNullable<LlmCallRecord["requestMeta"]> {
  const meta: NonNullable<LlmCallRecord["requestMeta"]> = {};
  if (Array.isArray(requestArgs.contents)) {
    meta.messagesCount = requestArgs.contents.length;
  } else if (typeof requestArgs.contents === "string") {
    meta.messagesCount = 1;
  }
  return meta;
}

/**
 * Time-ordered record ID generator.
 *
 * Fix: the previous implementation used a `Date.now()` prefix + a
 * `Math.random().toString(36).slice(2,10)` suffix, which had two weaknesses:
 * (1) non-cryptographic randomness, and (2) depending on the value the suffix
 * could be shorter than 8 characters, dropping the effective entropy well
 * below 41 bits. The backend silently skips collisions via
 * `INSERT ... ON CONFLICT(account_id, id) DO NOTHING`, so a real call that
 * collides would vanish from billing, quota, and observation. Cryptographic
 * randomness (crypto.getRandomValues / randomUUID) raises collision resistance
 * to the 128-bit class. The leading time prefix is kept so ordering stays
 * chronological.
 */
