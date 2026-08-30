import type { ArgosvixConfig, LlmCallRecord, Provider } from "./types.js";
import { _registerRecorderFor } from "./client.js";
import { _registerObservationSink, getAmbientTraceContext } from "./context.js";
import { generateId } from "./ids.js";
import { calculateCostWithCache } from "./pricing.js";
import { Recorder } from "./recorder.js";

/**
 * LangChain.js integration (callback handler).
 *
 * `argosvixLangChainHandler()` returns a callback handler that can be passed
 * to LangChain's `callbacks` array. Placed in the `{ callbacks: [...] }` of a
 * model.invoke / chain / agent, it observes every LLM call made through
 * LangChain — including calls that chains and agents issue internally:
 * provider / model / tokens / cost / latency / TTFT / cache / reasoning.
 *
 * There is no hard dependency on LangChain (`@langchain/core` is never
 * imported). LangChain accepts plain objects with handler methods in
 * `callbacks`, not only BaseCallbackHandler instances.
 *
 * Same design principle as the AI SDK middleware: observation code must never
 * break the host's call (recording is best-effort).
 *
 * @example
 *   import { ChatOpenAI } from "@langchain/openai";
 *   import { argosvixLangChainHandler, flushClient } from "@argosvix/sdk";
 *
 *   const handler = argosvixLangChainHandler({ apiKey: process.env.ARGOSVIX_API_KEY });
 *   const model = new ChatOpenAI({ model: "gpt-5.5" });
 *   try {
 *     await model.invoke("hi", { callbacks: [handler] });
 *   } finally {
 *     await flushClient(handler); // or: await handler.flush()
 *   }
 */

// ── Structural types for LangChain (the shapes the handler receives; defined minimally without importing) ────
interface LcSerialized {
  id?: unknown;
  name?: unknown;
}

interface LcExtraParams {
  invocation_params?: {
    model?: unknown;
    model_name?: unknown;
    modelName?: unknown;
  };
}

interface LcUsageMetadata {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  input_token_details?: { cache_read?: number; cache_creation?: number };
  output_token_details?: { reasoning?: number };
}

interface LcLLMResult {
  generations?: Array<
    Array<{ message?: { usage_metadata?: LcUsageMetadata } } | undefined> | undefined
  >;
  llmOutput?: {
    model_name?: unknown;
    tokenUsage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
    usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
  };
}

type TraceMeta = Pick<LlmCallRecord, "traceId" | "spanId" | "parentSpanId" | "sessionId">;

interface RunState {
  start: number;
  model: string;
  provider: Provider;
  traceMeta: TraceMeta;
  ttftMs?: number;
}

/**
 * The LangChain handler object type (a plain object that can go into the
 * callbacks array). Exposes flush() / recorder directly (flushClient(handler)
 * works as well).
 */
export interface ArgosvixLangChainHandler {
  name: string;
  handleLLMStart: (llm: LcSerialized, prompts: unknown, runId: string, parentRunId?: string, extraParams?: LcExtraParams) => void;
  handleChatModelStart: (llm: LcSerialized, messages: unknown, runId: string, parentRunId?: string, extraParams?: LcExtraParams) => void;
  handleLLMNewToken: (token: string, idx?: unknown, runId?: string) => void;
  handleLLMEnd: (output: LcLLMResult, runId: string) => void;
  handleLLMError: (err: unknown, runId: string) => void;
  flush: () => Promise<void>;
  readonly recorder: Recorder;
}

/** Recording is best-effort. Exceptions thrown here never break the host's call. */
function safeRun(fn: () => void): void {
  try {
    fn();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[argosvix] LangChain handler recording failed (non-fatal):", err);
  }
}

/**
 * Maps LangChain's serialized id (e.g. ["langchain","chat_models","openai",
 * "ChatOpenAI"]) or class name onto Argosvix's providers. The primary
 * check is exact segment equality, avoiding substring false positives. The
 * last segment (the class name, e.g. ChatOpenAI) is additionally checked with
 * includes, so custom wrappers that only expose a class name are still picked
 * up (side effect: a custom class whose name contains a provider name will be
 * mapped to it). No match returns null: matching the backend's strict enum
 * validation, recording is skipped rather than fabricating a provider
 * (overridable via config.provider).
 */
function mapProvider(llm: LcSerialized | undefined): Provider | null {
  const segments: string[] = [];
  if (llm && Array.isArray(llm.id)) {
    for (const s of llm.id) if (typeof s === "string") segments.push(s.toLowerCase());
  }
  if (llm && typeof llm.name === "string") segments.push(llm.name.toLowerCase());
  const has = (...keys: string[]): boolean =>
    segments.some((seg) => keys.some((k) => seg === k));
  // class names (ChatOpenAI etc.) are matched by substring
  const cls = segments[segments.length - 1] ?? "";
  if (has("openai", "azure_openai", "azureopenai") || cls.includes("openai")) return "openai";
  if (has("anthropic") || cls.includes("anthropic")) return "anthropic";
  if (
    has("google_genai", "google_vertexai", "googlegenerativeai", "google", "vertexai") ||
    cls.includes("google") ||
    cls.includes("gemini") ||
    cls.includes("vertex")
  ) {
    return "gemini";
  }
  if (has("mistralai", "mistral") || cls.includes("mistral")) return "mistral";
  // ⚠ These segments were read from langchainjs itself
  //    (libs/providers/langchain-{xai,deepseek}/src, lc_namespace), not guessed.
  //    Checked before "openai" is not needed: ChatXAI / ChatDeepSeek class names
  //    do not contain "openai", and their namespaces are distinct.
  if (has("xai") || cls.includes("chatxai")) return "xai";
  if (has("deepseek") || cls.includes("deepseek")) return "deepseek";
  // langchainjs has no first-party Moonshot package; community wrappers use these.
  if (has("moonshot", "moonshotai") || cls.includes("moonshot")) return "moonshot";
  // Qwen / DashScope: community wrappers (@langchain/community ChatAlibabaTongyi,
  // chatqwen 系). Segments read from community sources, not guessed.
  if (has("alibaba", "dashscope", "qwen") || cls.includes("alibabatongyi") || cls.includes("qwen")) {
    return "alibaba";
  }
  return null;
}

function resolveModel(extraParams: LcExtraParams | undefined): string {
  const ip = extraParams?.invocation_params;
  const cand = ip?.model ?? ip?.model_name ?? ip?.modelName;
  return typeof cand === "string" && cand.length > 0 ? cand : "unknown";
}

/** Extracts normalized tokens from an LLMResult. Prefers the standard usage_metadata; falls back to llmOutput.tokenUsage. */
function extractTokens(output: LcLLMResult): {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedReadTokens: number;
  cachedWriteTokens: number;
  reasoningTokens: number;
  modelName?: string;
} {
  // The model name is taken from llmOutput.model_name regardless of the token
  // source, so integrations that lack invocation_params at start do not end up
  // with an unknown model and a cost of 0.
  const modelName =
    typeof output.llmOutput?.model_name === "string" ? output.llmOutput.model_name : undefined;
  const modelSpread = modelName !== undefined ? { modelName } : {};
  // Standard usage_metadata: the provider-agnostic normalized form carried on the AIMessage
  const meta = output.generations?.[0]?.[0]?.message?.usage_metadata;
  if (meta && (typeof meta.input_tokens === "number" || typeof meta.output_tokens === "number")) {
    const promptTokens = meta.input_tokens ?? 0;
    const completionTokens = meta.output_tokens ?? 0;
    return {
      promptTokens,
      completionTokens,
      totalTokens: meta.total_tokens ?? promptTokens + completionTokens,
      cachedReadTokens: meta.input_token_details?.cache_read ?? 0,
      cachedWriteTokens: meta.input_token_details?.cache_creation ?? 0,
      reasoningTokens: meta.output_token_details?.reasoning ?? 0,
      ...modelSpread,
    };
  }
  // Fallback: the OpenAI-shaped llmOutput.tokenUsage
  const tu = output.llmOutput?.tokenUsage ?? output.llmOutput?.usage;
  const promptTokens = tu?.promptTokens ?? 0;
  const completionTokens = tu?.completionTokens ?? 0;
  return {
    promptTokens,
    completionTokens,
    totalTokens: tu?.totalTokens ?? promptTokens + completionTokens,
    cachedReadTokens: 0,
    cachedWriteTokens: 0,
    reasoningTokens: 0,
    ...modelSpread,
  };
}

let warnedUnsupported: Set<string> | null = null;
function warnUnsupported(llm: LcSerialized | undefined): void {
  const label =
    llm && Array.isArray(llm.id)
      ? llm.id.filter((s) => typeof s === "string").join(".")
      : typeof llm?.name === "string"
        ? llm.name
        : "unknown";
  if (warnedUnsupported === null) warnedUnsupported = new Set();
  if (warnedUnsupported.has(label)) return;
  warnedUnsupported.add(label);
  // eslint-disable-next-line no-console
  console.warn(
    `[argosvix] LangChain model "${label}" is not one of openai/anthropic/gemini/mistral/xai/moonshot/deepseek/alibaba; ` +
      `the call runs normally but is not recorded. Pass config.provider to override.`,
  );
}

export function argosvixLangChainHandler(
  config: ArgosvixConfig = {},
): ArgosvixLangChainHandler {
  const recorder = new Recorder(config);
  _registerObservationSink(recorder);
  const callTags: Record<string, string> = { ...(config.tags ?? {}) };
  // Per-runId start state (registered on start; consumed and deleted on end/error).
  const runs = new Map<string, RunState>();
  // Cap the map so runs whose end/error never arrives (e.g. after an abort)
  // do not accumulate forever. Map preserves insertion order, so on overflow
  // the oldest entry is evicted FIFO.
  const MAX_PENDING_RUNS = 10000;

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

  function onStart(
    llm: LcSerialized,
    runId: string,
    extraParams: LcExtraParams | undefined,
  ): void {
    const provider = config.provider ?? mapProvider(llm);
    if (provider === null) {
      warnUnsupported(llm);
      return;
    }
    if (runs.size >= MAX_PENDING_RUNS) {
      const oldest = runs.keys().next().value;
      if (oldest !== undefined) runs.delete(oldest);
    }
    runs.set(runId, {
      start: Date.now(),
      model: resolveModel(extraParams),
      provider,
      traceMeta: buildTraceMeta(),
    });
  }

  const handler: ArgosvixLangChainHandler = {
    name: "argosvix_handler",

    handleLLMStart(llm, _prompts, runId, _parentRunId, extraParams) {
      safeRun(() => onStart(llm, runId, extraParams));
    },

    handleChatModelStart(llm, _messages, runId, _parentRunId, extraParams) {
      safeRun(() => onStart(llm, runId, extraParams));
    },

    handleLLMNewToken(_token, _idx, runId) {
      safeRun(() => {
        if (!runId) return;
        const state = runs.get(runId);
        if (state && state.ttftMs === undefined) {
          state.ttftMs = Date.now() - state.start;
        }
      });
    },

    handleLLMEnd(output, runId) {
      const state = runs.get(runId);
      if (!state) return; // no start state (e.g. unsupported provider)
      runs.delete(runId);
      safeRun(() => {
        const t = extractTokens(output);
        const model = t.modelName ?? state.model;
        const cost = calculateCostWithCache(
          state.provider,
          model,
          t.promptTokens,
          t.completionTokens,
          t.cachedReadTokens,
          t.cachedWriteTokens,
        );
        const record: LlmCallRecord = {
          id: generateId(),
          provider: state.provider,
          model,
          promptTokens: t.promptTokens,
          completionTokens: t.completionTokens,
          totalTokens: t.totalTokens,
          costUsd: cost.costUsd,
          latencyMs: Date.now() - state.start,
          timestamp: new Date().toISOString(),
          tags: callTags,
          ...state.traceMeta,
          ...(t.cachedReadTokens > 0 ? { cachedReadTokens: t.cachedReadTokens } : {}),
          ...(t.cachedWriteTokens > 0 ? { cachedWriteTokens: t.cachedWriteTokens } : {}),
          ...(cost.cacheSavingsUsd > 0 ? { cacheSavingsUsd: cost.cacheSavingsUsd } : {}),
          ...(t.reasoningTokens > 0 ? { reasoningTokens: t.reasoningTokens } : {}),
          ...(state.ttftMs !== undefined ? { ttftMs: state.ttftMs } : {}),
        };
        recorder.record(record);
      });
    },

    handleLLMError(err, runId) {
      const state = runs.get(runId);
      if (!state) return;
      runs.delete(runId);
      safeRun(() =>
        recorder.record({
          id: generateId(),
          provider: state.provider,
          model: state.model,
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
          costUsd: 0,
          latencyMs: Date.now() - state.start,
          timestamp: new Date().toISOString(),
          tags: callTags,
          ...state.traceMeta,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    },

    async flush() {
      try {
        await recorder.flush();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("[argosvix] LangChain handler flush failed:", err);
      }
    },

    recorder,
  };

  _registerRecorderFor(handler, recorder);
  return handler;
}
