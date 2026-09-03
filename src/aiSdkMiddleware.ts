import type { ArgosvixConfig, LlmCallRecord, Provider } from "./types.js";
import { _registerRecorderFor } from "./client.js";
import { _registerObservationSink, getAmbientTraceContext } from "./context.js";
import { generateId } from "./ids.js";
import { calculateCostWithCache } from "./pricing.js";
import { Recorder } from "./recorder.js";

/**
 * Vercel AI SDK (`ai` package) integration.
 *
 * Returns a LanguageModel middleware (compatible with ai@5-7) that can be
 * passed to the AI SDK's `wrapLanguageModel({ model, middleware })`. All calls
 * made through the AI SDK — `generateText` / `streamText` / `generateObject`
 * and so on — become observable without wrap()ing the provider SDK directly.
 * In other words: yes, calls originating inside the AI SDK are recorded too,
 * for every supported provider (the namespaces listed in mapProvider below).
 *
 * There is no hard dependency on the AI SDK (types are defined structurally;
 * `ai` is never imported). The middleware shape (wrapGenerate / wrapStream) is
 * the same across ai@5-7. Differences in usage shape (v7: inputTokens /
 * outputTokens as object breakdowns; v5-6: numbers plus cachedInputTokens /
 * inputTokenDetails etc.; the even older v4 line: promptTokens /
 * completionTokens) are normalized by extractTokens().
 *
 * Design principle: observation code must never break the host's LLM call.
 * Recording is best-effort (exceptions while recording are swallowed and only
 * logged). Success recording happens outside the doGenerate try block, so a
 * recording exception can never turn a successful call into an error.
 *
 * @example
 *   import { openai } from "@ai-sdk/openai";
 *   import { wrapLanguageModel, generateText } from "ai";
 *   import { argosvixMiddleware, flushClient } from "@argosvix/sdk";
 *
 *   const observed = argosvixMiddleware({ apiKey: process.env.ARGOSVIX_API_KEY });
 *   const model = wrapLanguageModel({ model: openai("gpt-5.5"), middleware: observed });
 *   try {
 *     await generateText({ model, prompt: "hi" });
 *   } finally {
 *     await flushClient(observed); // or: await observed.flush()
 *   }
 */

// ── Structural types for the AI SDK (provider-spec level — the shapes the middleware sees) ────────────
interface AiSdkModelLike {
  modelId?: string;
  provider?: string;
}

/** The object breakdown carried by usage.inputTokens / usage.outputTokens in ai@7. */
interface AiSdkTokenBreakdown {
  total?: number;
  // input side
  noCache?: number;
  cacheRead?: number;
  cacheWrite?: number; // presumed present for some providers (e.g. Anthropic); read defensively
  // output side
  text?: number;
  reasoning?: number;
}

interface AiSdkUsage {
  // ai@5-6: number; ai@7: object breakdown
  inputTokens?: number | AiSdkTokenBreakdown;
  outputTokens?: number | AiSdkTokenBreakdown;
  totalTokens?: number;
  // older v4 line (promptTokens/completionTokens naming)
  promptTokens?: number;
  completionTokens?: number;
  // ai@5-6 top-level breakdown
  cachedInputTokens?: number;
  reasoningTokens?: number;
  // ai@5-6 nested breakdown (adapter-dependent)
  inputTokenDetails?: { cacheReadTokens?: number; cacheWriteTokens?: number };
  outputTokenDetails?: { reasoningTokens?: number };
  // ai@7 carries the provider's raw usage here (not used for normalization)
  raw?: unknown;
}

interface AiSdkGenerateResult {
  usage?: AiSdkUsage;
  response?: { modelId?: string };
  finishReason?: string;
}

interface AiSdkStreamPart {
  type?: string;
  usage?: AiSdkUsage;
  finishReason?: string;
  // the response-metadata part sometimes carries the actual model ID
  modelId?: string;
  id?: string;
}

interface AiSdkStreamResult {
  stream: ReadableStream<AiSdkStreamPart>;
  [key: string]: unknown;
}

interface WrapGenerateOptions {
  doGenerate: () => Promise<AiSdkGenerateResult>;
  params: unknown;
  model?: AiSdkModelLike;
}

interface WrapStreamOptions {
  doStream: () => Promise<AiSdkStreamResult>;
  params: unknown;
  model?: AiSdkModelLike;
}

/**
 * Return value of argosvixMiddleware(). Usable as an AI SDK middleware, and
 * additionally exposes flush() / recorder directly for short-lived runtimes.
 * flushClient(middleware) works as well.
 */
export interface ArgosvixAiSdkMiddleware {
  wrapGenerate: (opts: WrapGenerateOptions) => Promise<AiSdkGenerateResult>;
  wrapStream: (opts: WrapStreamOptions) => Promise<AiSdkStreamResult>;
  /** Flushes the buffer to the backend and waits for the send to complete (for finally blocks on Workers / Lambda / Edge). */
  flush: () => Promise<void>;
  /** The Recorder this middleware uses (equivalent to getRecorder). */
  readonly recorder: Recorder;
}

type TraceMeta = Pick<LlmCallRecord, "traceId" | "spanId" | "parentSpanId" | "sessionId">;

/**
 * Maps the AI SDK's provider string (e.g. "openai.chat" /
 * "anthropic.messages" / "google.generative-ai" / "mistral.chat" /
 * "xai.chat" / "moonshotai.chat" / "deepseek.chat" / "alibaba.chat" /
 * "meta.chat") onto Argosvix's nine providers.
 *
 * The xai / moonshotai / deepseek namespaces were read from the AI SDK's own
 * provider sources (packages/{xai,moonshotai,deepseek}/src/*-provider.ts on
 * vercel/ai main), not guessed from the package names.
 *
 * Matching is an exact comparison on the namespace (the part before the first
 * "."). Substring matching is deliberately avoided because it would wrongly
 * map "openai-compatible" / "not-openai" to openai. No match returns null:
 * the backend validates provider against a strict enum, so instead of
 * fabricating an unsupported provider, recording is skipped.
 */
function mapProvider(raw: string | undefined): Provider | null {
  if (!raw) return null;
  const ns = raw.toLowerCase().split(".")[0];
  if (ns === "openai" || ns === "azure" || ns === "azure-openai") return "openai";
  if (ns === "anthropic") return "anthropic";
  if (ns === "google" || ns === "google-vertex" || ns === "vertex" || ns === "gemini") {
    return "gemini";
  }
  if (ns === "mistral") return "mistral";
  if (ns === "xai") return "xai";
  // The official package is @ai-sdk/moonshotai and reports "moonshotai.*";
  // "moonshot" is accepted for community providers that drop the suffix.
  if (ns === "moonshotai" || ns === "moonshot") return "moonshot";
  if (ns === "deepseek") return "deepseek";
  // Qwen 系 community provider は "qwen" / "alibaba" 名義の両方が流通している
  if (ns === "alibaba" || ns === "qwen" || ns === "dashscope") return "alibaba";
  // Meta Model API に公式 @ai-sdk パッケージは無く(2026-09-03 時点)、
  // createOpenAICompatible({ name: "meta", baseURL: "https://api.meta.ai/v1" })
  // の name がそのまま namespace になる。AI Gateway 経由("gateway" namespace +
  // modelId "meta/muse-spark-*")はここでは拾わない = 他 provider と同じく config.provider で上書き
  if (ns === "meta") return "meta";
  return null;
}

let warnedUnsupportedProviders: Set<string> | null = null;
function warnUnsupportedProvider(raw: string | undefined): void {
  const label = raw ?? "unknown";
  if (warnedUnsupportedProviders === null) warnedUnsupportedProviders = new Set();
  if (warnedUnsupportedProviders.has(label)) return;
  warnedUnsupportedProviders.add(label);
  // eslint-disable-next-line no-console
  console.warn(
    `[argosvix] AI SDK provider "${label}" is not one of ` +
      `openai/anthropic/gemini/mistral/xai/moonshot/deepseek/alibaba/meta; ` +
      `the call runs normally but is not recorded. Pass config.provider to override.`,
  );
}

/** Recording is best-effort. Exceptions thrown here never break the host's call. */
function safeRun(fn: () => void): void {
  try {
    fn();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[argosvix] AI SDK middleware recording failed (non-fatal):", err);
  }
}

/** Only finite numbers pass (NaN / Infinity / objects / strings become 0). A guard against polluting records. */
function toCount(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/**
 * Normalizes AI SDK usage out of all three shapes seen across ai@5-7.
 *
 * - ai@7: inputTokens/outputTokens are objects
 *   ({ total, noCache, cacheRead(, cacheWrite) } / { total, text, reasoning }).
 *   total is the cache-read-inclusive sum, so it is used directly as
 *   promptTokens; cacheRead maps to cachedReadTokens and reasoning to
 *   reasoningTokens
 * - ai@5-6: inputTokens/outputTokens are numbers (cache-read-inclusive input
 *   total). Breakdowns come from the top-level cachedInputTokens /
 *   reasoningTokens or from inputTokenDetails / outputTokenDetails
 * - older v4 line: numbers under the promptTokens/completionTokens naming
 *
 * Unknown shapes fall back defensively to 0 (NaN / "[object Object]" must
 * never end up in a record). promptTokens is returned as the
 * cache-read-inclusive input total, as calculateCostWithCache expects.
 */
function extractTokens(usage: AiSdkUsage | undefined): {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedReadTokens: number;
  cachedWriteTokens: number;
  reasoningTokens: number;
} {
  let promptTokens = 0;
  let completionTokens = 0;
  let cachedReadTokens = 0;
  let cachedWriteTokens = 0;
  let reasoningTokens = 0;

  const input = usage?.inputTokens;
  if (typeof input === "number") {
    // ai@5-6: a number (cache-read-inclusive input total)
    promptTokens = toCount(input);
  } else if (input !== null && typeof input === "object") {
    // ai@7: object breakdown
    cachedReadTokens = toCount(input.cacheRead);
    cachedWriteTokens = toCount(input.cacheWrite);
    promptTokens =
      typeof input.total === "number" && Number.isFinite(input.total)
        ? input.total
        : toCount(input.noCache) + cachedReadTokens + cachedWriteTokens;
  } else {
    // older v4 line (0 when input is undefined)
    promptTokens = toCount(usage?.promptTokens);
  }

  const output = usage?.outputTokens;
  if (typeof output === "number") {
    completionTokens = toCount(output);
  } else if (output !== null && typeof output === "object") {
    reasoningTokens = toCount(output.reasoning);
    completionTokens =
      typeof output.total === "number" && Number.isFinite(output.total)
        ? output.total
        : toCount(output.text) + reasoningTokens;
  } else {
    completionTokens = toCount(usage?.completionTokens);
  }

  // ai@5-6 breakdown fallback (never overwrites values already taken from the v7 object)
  if (cachedReadTokens === 0) {
    cachedReadTokens =
      toCount(usage?.cachedInputTokens) || toCount(usage?.inputTokenDetails?.cacheReadTokens);
  }
  if (cachedWriteTokens === 0) {
    cachedWriteTokens = toCount(usage?.inputTokenDetails?.cacheWriteTokens);
  }
  if (reasoningTokens === 0) {
    reasoningTokens =
      toCount(usage?.reasoningTokens) || toCount(usage?.outputTokenDetails?.reasoningTokens);
  }

  const rawTotal = usage?.totalTokens;
  const totalTokens =
    typeof rawTotal === "number" && Number.isFinite(rawTotal)
      ? rawTotal
      : promptTokens + completionTokens;

  return {
    promptTokens,
    completionTokens,
    totalTokens,
    cachedReadTokens,
    cachedWriteTokens,
    reasoningTokens,
  };
}

/** Whether a stream part carries a "first token" (text / reasoning / tool) — used for TTFT. */
function partHasOutput(part: AiSdkStreamPart): boolean {
  const t = part.type;
  if (!t) return false;
  return (
    t === "text-delta" ||
    t === "text" ||
    t === "reasoning-delta" ||
    t === "reasoning" ||
    t === "tool-call" ||
    t === "tool-input-start" ||
    t === "tool-input-delta"
  );
}

/** Best-effort extraction of status / code from AI SDK errors (APICallError etc.). */
function extractErrorDetails(err: unknown): LlmCallRecord["errorDetails"] | undefined {
  if (!err || typeof err !== "object") return undefined;
  const e = err as { statusCode?: number; status?: number; code?: unknown; name?: unknown };
  const details: NonNullable<LlmCallRecord["errorDetails"]> = {};
  const status = e.statusCode ?? e.status;
  if (typeof status === "number") details.statusCode = status;
  if (typeof e.code === "string") details.code = e.code;
  if (typeof e.name === "string") details.type = e.name;
  return Object.keys(details).length > 0 ? details : undefined;
}

export function argosvixMiddleware(config: ArgosvixConfig = {}): ArgosvixAiSdkMiddleware {
  const recorder = new Recorder(config);
  // Register as a destination for the observations withSpan emits (same treatment as wrap()).
  _registerObservationSink(recorder);
  const callTags: Record<string, string> = { ...(config.tags ?? {}) };

  // Trace fields are snapshotted at call entry, so nothing is misattributed even if the ambient context is gone after an await.
  function buildTraceMeta(): TraceMeta {
    const meta: TraceMeta = {};
    const ambient = config.autoContext === false ? undefined : getAmbientTraceContext();
    const traceId = config.traceId ?? ambient?.traceId;
    if (traceId) {
      meta.traceId = traceId;
      meta.spanId = config.spanId ?? generateId();
      const parent = config.parentSpanId ?? ambient?.spanId;
      if (parent) meta.parentSpanId = parent;
    } else {
      if (config.spanId) meta.spanId = config.spanId;
      if (config.parentSpanId) meta.parentSpanId = config.parentSpanId;
    }
    if (config.sessionId) meta.sessionId = config.sessionId;
    return meta;
  }

  function buildRequestMeta(params: unknown): LlmCallRecord["requestMeta"] | undefined {
    if (!params || typeof params !== "object") return undefined;
    const p = params as {
      prompt?: unknown;
      temperature?: number;
      maxOutputTokens?: number;
      maxTokens?: number;
    };
    const meta: NonNullable<LlmCallRecord["requestMeta"]> = {};
    if (Array.isArray(p.prompt)) meta.messagesCount = p.prompt.length;
    if (typeof p.temperature === "number") meta.temperature = p.temperature;
    const maxT = p.maxOutputTokens ?? p.maxTokens;
    if (typeof maxT === "number") meta.maxTokens = maxT;
    return Object.keys(meta).length > 0 ? meta : undefined;
  }

  function recordError(
    id: string,
    provider: Provider,
    model: string,
    start: number,
    traceMeta: TraceMeta,
    requestMeta: LlmCallRecord["requestMeta"] | undefined,
    err: unknown,
  ): void {
    const errorDetails = extractErrorDetails(err);
    safeRun(() =>
      recorder.record({
        id,
        provider,
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
        ...(requestMeta ? { requestMeta } : {}),
      }),
    );
  }

  function recordSuccess(
    id: string,
    provider: Provider,
    model: string,
    start: number,
    usage: AiSdkUsage | undefined,
    ttftMs: number | undefined,
    traceMeta: TraceMeta,
    requestMeta: LlmCallRecord["requestMeta"] | undefined,
  ): void {
    safeRun(() => {
      const t = extractTokens(usage);
      const cost = calculateCostWithCache(
        provider,
        model,
        t.promptTokens,
        t.completionTokens,
        t.cachedReadTokens,
        t.cachedWriteTokens,
      );
      const record: LlmCallRecord = {
        id,
        provider,
        model,
        promptTokens: t.promptTokens,
        completionTokens: t.completionTokens,
        totalTokens: t.totalTokens,
        costUsd: cost.costUsd,
        latencyMs: Date.now() - start,
        timestamp: new Date().toISOString(),
        tags: callTags,
        ...traceMeta,
        ...(t.cachedReadTokens > 0 ? { cachedReadTokens: t.cachedReadTokens } : {}),
        ...(t.cachedWriteTokens > 0 ? { cachedWriteTokens: t.cachedWriteTokens } : {}),
        ...(cost.cacheSavingsUsd > 0 ? { cacheSavingsUsd: cost.cacheSavingsUsd } : {}),
        ...(t.reasoningTokens > 0 ? { reasoningTokens: t.reasoningTokens } : {}),
        ...(ttftMs !== undefined ? { ttftMs } : {}),
        ...(requestMeta ? { requestMeta } : {}),
      };
      recorder.record(record);
    });
  }

  /** Explicit config.provider wins over inference from model.provider. Returns null when inference fails. */
  function resolveProvider(model: AiSdkModelLike | undefined): Provider | null {
    if (config.provider) return config.provider;
    return mapProvider(model?.provider);
  }

  const middleware: ArgosvixAiSdkMiddleware = {
    async wrapGenerate({ doGenerate, params, model }) {
      const provider = resolveProvider(model);
      const modelId = model?.modelId ?? "unknown";
      if (provider === null) {
        warnUnsupportedProvider(model?.provider);
        return doGenerate();
      }
      const start = Date.now();
      const id = generateId();
      const traceMeta = buildTraceMeta();
      const requestMeta = buildRequestMeta(params);

      // Budget / policy gate (only active when opted in). A block is recorded as an error and rethrown.
      try {
        await recorder.budgetGate.check({ model: modelId, payload: params });
      } catch (err) {
        recordError(id, provider, modelId, start, traceMeta, requestMeta, err);
        throw err;
      }

      let result: AiSdkGenerateResult;
      try {
        result = await doGenerate();
      } catch (err) {
        recordError(id, provider, modelId, start, traceMeta, requestMeta, err);
        throw err;
      }
      // Success recording stays outside the try block so a recording exception cannot turn a successful call into an error.
      const usedModel = result.response?.modelId ?? modelId;
      recordSuccess(id, provider, usedModel, start, result.usage, undefined, traceMeta, requestMeta);
      return result;
    },

    async wrapStream({ doStream, params, model }) {
      const provider = resolveProvider(model);
      const modelId = model?.modelId ?? "unknown";
      if (provider === null) {
        warnUnsupportedProvider(model?.provider);
        return doStream();
      }
      const start = Date.now();
      const id = generateId();
      const traceMeta = buildTraceMeta();
      const requestMeta = buildRequestMeta(params);

      try {
        await recorder.budgetGate.check({ model: modelId, payload: params });
      } catch (err) {
        recordError(id, provider, modelId, start, traceMeta, requestMeta, err);
        throw err;
      }

      let streamResult: AiSdkStreamResult;
      try {
        streamResult = await doStream();
      } catch (err) {
        // Stream initialization failures (auth / validation / connection) are observed too.
        recordError(id, provider, modelId, start, traceMeta, requestMeta, err);
        throw err;
      }

      const { stream, ...rest } = streamResult;
      const reader = stream.getReader();
      let usedModel = modelId;
      let finishUsage: AiSdkUsage | undefined; // prefer the finish part's usage
      let lastUsage: AiSdkUsage | undefined; // fallback for adapters without a finish part
      let ttftMs: number | undefined;
      let recorded = false; // guards against double recording

      // Hand-rolled pump: record exactly once whether the stream completes
      // normally or errors mid-consumption. (TransformStream.flush is not used
      // because it does not fire on error.)
      const observed = new ReadableStream<AiSdkStreamPart>({
        async pull(controller) {
          let chunk: Awaited<ReturnType<typeof reader.read>>;
          try {
            chunk = await reader.read();
          } catch (err) {
            if (!recorded) {
              recorded = true;
              recordError(id, provider, usedModel, start, traceMeta, requestMeta, err);
            }
            controller.error(err);
            return;
          }
          if (chunk.done) {
            if (!recorded) {
              recorded = true;
              recordSuccess(
                id,
                provider,
                usedModel,
                start,
                finishUsage ?? lastUsage,
                ttftMs,
                traceMeta,
                requestMeta,
              );
            }
            controller.close();
            return;
          }
          const part = chunk.value;
          if (ttftMs === undefined && partHasOutput(part)) {
            ttftMs = Date.now() - start;
          }
          if (part.type === "response-metadata" && typeof part.modelId === "string") {
            usedModel = part.modelId;
          }
          if (part.usage) {
            lastUsage = part.usage;
            if (part.type === "finish") finishUsage = part.usage;
          }
          controller.enqueue(part);
        },
        cancel(reason) {
          // A mid-stream cancel by the consumer means usage was never finalized, so nothing is recorded (tokens are unknowable by spec).
          return reader.cancel(reason);
        },
      });

      return { ...rest, stream: observed };
    },

    async flush() {
      try {
        await recorder.flush();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("[argosvix] middleware flush failed:", err);
      }
    },

    recorder,
  };

  // Makes flushClient(middleware) / getRecorder(middleware) work through the same path as wrapped clients.
  _registerRecorderFor(middleware, recorder);
  return middleware;
}
