/**
 * Automatic trace context propagation.
 *
 * Keeps the "current trace / span" in AsyncLocalStorage so that wrapped LLM
 * calls automatically belong to (nest under) the surrounding trace without
 * explicitly passing a traceId. Without this, the trace UI and storage would
 * stay empty in real-world use even though they are fully implemented, since
 * IDs would have to be threaded through by hand.
 *
 * ## Runtime constraints
 * AsyncLocalStorage is standard in Node 12+; on Cloudflare Workers it requires
 * the `nodejs_als` (or `nodejs_compat`) compatibility flag. Because user
 * runtimes vary, failure to obtain it falls back gracefully to the static
 * behavior (config.traceId only, as before) with a single warning.
 *
 * Initially only `withTrace` was exposed (grouping multiple LLM calls into one
 * trace). `withSpan`, which represents intermediate spans, and observation
 * emission were added later, once observation storage landed.
 */

import { generateId } from "./ids.js";
import type { ObservationRecord, ObservationType } from "./types.js";

/** Destination for observations (satisfied by Recorder; accepted as an interface to avoid a circular import).
 * routingKey identifies the account this sink sends to (the api_key); observationsEnabled says whether sending is active. */
export interface ObservationSink {
  recordObservation(obs: ObservationRecord): void;
  readonly observationsEnabled: boolean;
  readonly observationsRoutingKey: string | undefined;
}

const observationSinks: ObservationSink[] = [];
let warnedMultiAccount = false;

/**
 * Registers a destination for the observations withSpan emits (wrap()
 * registers its own recorder here). Wrapping multiple clients does not create
 * duplicate registrations. The destination is chosen at emit time, so wrapping
 * another client later stays consistent.
 */
export function _registerObservationSink(sink: ObservationSink): void {
  if (!observationSinks.includes(sink)) observationSinks.push(sink);
}

/** Test-only: clears the sink registry (not used in production, which assumes one wrap per process). */
export function _resetObservationSinks(): void {
  observationSinks.length = 0;
  warnedMultiAccount = false;
}

/**
 * Picks a single destination for observations. If the enabled sinks all belong
 * to one account (same routingKey), send there. When multiple accounts
 * (different api_keys) are mixed, nothing is sent and a single warning is
 * emitted, to avoid leaking data into the wrong account — this structurally
 * prevents split traces and cross-account sends such as the generation going
 * to client A while the observation goes to client B.
 */
function pickObservationSink(): ObservationSink | null {
  const enabled = observationSinks.filter((s) => s.observationsEnabled);
  if (enabled.length === 0) return null;
  const keys = new Set(enabled.map((s) => s.observationsRoutingKey));
  if (keys.size > 1) {
    if (!warnedMultiAccount) {
      warnedMultiAccount = true;
      // eslint-disable-next-line no-console
      console.warn(
        "[argosvix] withSpan: multiple wrapped clients with different API keys detected — " +
          "observations are not emitted to avoid sending them to the wrong account. " +
          "Use one wrapped client per process for span observations.",
      );
    }
    return null;
  }
  return enabled[0] ?? null;
}

export interface TraceContext {
  traceId: string;
  /** Current parent span. Generations directly inside use this as their parentSpanId; undefined at the trace root. */
  spanId?: string;
}

interface AsyncLocalStorageLike<T> {
  getStore(): T | undefined;
  run<R>(store: T, callback: () => R): R;
}

let warned = false;

type AlsCtor = new <T>() => AsyncLocalStorageLike<T>;

/**
 * Resolves AsyncLocalStorage without any static import specifier. This cuts
 * off the path where bundlers (targeting Workers / Next Edge / browsers) try
 * to resolve node:async_hooks at build time and fail — top-level await
 * combined with `import("node:...")` causes bundle failures.
 *   1. Cloudflare Workers (nodejs_als / nodejs_compat): AsyncLocalStorage appears as a global
 *   2. Node 22.3+: process.getBuiltinModule obtains the builtin in a form static analysis cannot see
 * On runtimes with neither (old Node / Edge / browsers), returns null and falls back gracefully to the static behavior.
 */
function loadAls<T>(): AsyncLocalStorageLike<T> | null {
  try {
    const g = globalThis as {
      AsyncLocalStorage?: AlsCtor;
      process?: { getBuiltinModule?: (m: string) => { AsyncLocalStorage?: AlsCtor } };
    };
    let ctor: AlsCtor | undefined = g.AsyncLocalStorage;
    if (!ctor && typeof g.process?.getBuiltinModule === "function") {
      ctor = g.process.getBuiltinModule("node:async_hooks")?.AsyncLocalStorage;
    }
    return ctor ? new ctor<T>() : null;
  } catch {
    return null;
  }
}

const als: AsyncLocalStorageLike<TraceContext> | null = loadAls<TraceContext>();

function resolveAls(): AsyncLocalStorageLike<TraceContext> | null {
  return als;
}

function warnUnavailableOnce(): void {
  if (warned) return;
  warned = true;
  // eslint-disable-next-line no-console
  console.warn(
    "[argosvix] AsyncLocalStorage unavailable — automatic trace context is disabled. " +
      "On Cloudflare Workers add compatibility_flags = [\"nodejs_als\"]. " +
      "Calls still record; pass config.traceId to group them manually.",
  );
}

/**
 * Propagates the prompt version ID to LLM calls.
 * Wrapped LLM calls made inside withPrompt automatically receive a `prompt`
 * tag (e.g. "support-bot@v3"). This enables per-version quality/cost
 * comparison and a direct correlation between quality drift and deployments
 * (previously only temporal correlation was possible). Uses an
 * AsyncLocalStorage independent of the trace one, so withPrompt works on its
 * own.
 */
interface PromptContext {
  promptTag: string;
}

const promptAls: AsyncLocalStorageLike<PromptContext> | null = loadAls<PromptContext>();

/** The current ambient prompt tag (non-undefined when inside withPrompt). */
export function getAmbientPromptTag(): string | undefined {
  return promptAls?.getStore()?.promptTag;
}

/**
 * Opens a prompt boundary. Wrapped LLM calls inside fn automatically get
 * `{name}@v{version}` as tags.prompt (an explicit tags.prompt from the caller
 * takes precedence). The return value of resolvePrompt() can be passed in
 * directly. On runtimes without AsyncLocalStorage, fn runs as-is (recording
 * continues but tagging is disabled, with a single warning).
 */
export function withPrompt<T>(
  prompt: string | { name: string; version: number | string },
  fn: () => T,
): T {
  const promptTag =
    typeof prompt === "string" ? prompt : `${prompt.name}@v${prompt.version}`;
  if (!promptAls) {
    warnUnavailableOnce();
    return fn();
  }
  return promptAls.run({ promptTag }, fn);
}

/** The current ambient trace context (non-undefined when inside withTrace). */
export function getAmbientTraceContext(): TraceContext | undefined {
  const store = resolveAls();
  if (!store) return undefined;
  return store.getStore();
}

/**
 * Opens a trace boundary. Wrapped LLM calls inside fn automatically belong to
 * the same traceId, grouping one agent run / one request into one trace. When
 * nested (withTrace inside withTrace), the inner traceId wins. On runtimes
 * without AsyncLocalStorage, fn runs as-is (recording continues but automatic
 * grouping is disabled, with a single warning).
 *
 * @param fn The work to run (sync or async)
 * @param opts.traceId Explicit traceId (auto-generated when omitted)
 */
export function withTrace<T>(fn: () => T, opts?: { traceId?: string }): T {
  const store = resolveAls();
  if (!store) {
    warnUnavailableOnce();
    return fn();
  }
  const traceId = opts?.traceId ?? generateId();
  // A new trace boundary has no parent span (generations directly inside become the trace root).
  return store.run({ traceId }, fn);
}

/**
 * Opens an intermediate span (retrieval / tool / agent / chain / event / span)
 * and emits an observation. Wrapped LLM calls inside fn nest as children of
 * this span. When fn completes (sync and async both supported), status and
 * latency are finalized and the observation is recorded.
 *
 * If there is no trace context, a new trace is opened automatically (this span
 * becomes the trace root). On runtimes without AsyncLocalStorage nesting is
 * not possible, but the observation itself is still emitted.
 *
 * @param type Observation type
 * @param name Display name (e.g. "retrieve_docs")
 * @param fn The work to run
 * @param opts.metadata Non-sensitive structured attributes only (counts, sizes, etc. — never raw content or PII)
 */
export function withSpan<T>(
  type: ObservationType,
  name: string,
  fn: () => T,
  opts?: { metadata?: Record<string, unknown>; tags?: Record<string, string> },
): T {
  const store = resolveAls();
  const ambient = store?.getStore();
  const traceId = ambient?.traceId ?? generateId();
  const spanId = generateId();
  const parentSpanId = ambient?.spanId;
  const startTime = new Date().toISOString();
  const start = Date.now();
  let emitted = false;
  const emit = (status: "ok" | "error", error?: string): void => {
    if (emitted) return;
    emitted = true;
    const sink = pickObservationSink();
    if (!sink) return;
    sink.recordObservation({
      id: spanId,
      type,
      traceId,
      spanId,
      ...(parentSpanId ? { parentSpanId } : {}),
      name,
      status,
      startTime,
      endTime: new Date().toISOString(),
      latencyMs: Date.now() - start,
      ...(error ? { error } : {}),
      ...(opts?.metadata ? { metadata: opts.metadata } : {}),
      ...(opts?.tags ? { tags: opts.tags } : {}),
    });
  };
  const invoke = (): T => (store ? store.run({ traceId, spanId }, fn) : fn());
  const isThenable = (v: unknown): v is Promise<unknown> =>
    v != null &&
    (typeof v === "object" || typeof v === "function") &&
    typeof (v as { then?: unknown }).then === "function";
  try {
    const result = invoke();
    if (isThenable(result)) {
      return (result as Promise<unknown>).then(
        (v) => {
          emit("ok");
          return v;
        },
        (e: unknown) => {
          emit("error", e instanceof Error ? e.message : String(e));
          throw e;
        },
      ) as unknown as T;
    }
    emit("ok");
    return result;
  } catch (e) {
    emit("error", e instanceof Error ? e.message : String(e));
    throw e;
  }
}

/**
 * Wrapper that instruments an arbitrary function as a span (the higher-order
 * function form of `withSpan`).
 *
 * Decorator syntax (TC39 / legacy) varies too much across runtime
 * configurations, so this is provided as a portable higher-order function.
 * Every call of the wrapped function runs inside `withSpan`, and wrapped LLM
 * calls inside it nest as children of this span. Handles both sync and async
 * functions as-is (async completion is included in the latency).
 *
 * Usage:
 *   const retrieve = observe(async (q: string) => db.search(q), { type: "retrieval" });
 *   await withTrace(() => retrieve("hello"));
 *
 * @param fn The function to instrument
 * @param opts.name Display name (defaults to fn.name, or "anonymous" if unnamed)
 * @param opts.type Observation type (default "span")
 * @param opts.metadata Non-sensitive structured attributes only (never raw content or PII)
 */
export function observe<A extends unknown[], R>(
  fn: (...args: A) => R,
  opts?: {
    name?: string;
    type?: ObservationType;
    metadata?: Record<string, unknown>;
    tags?: Record<string, string>;
  },
): (...args: A) => R {
  const name = opts?.name || fn.name || "anonymous";
  const type: ObservationType = opts?.type ?? "span";
  // Use a regular function plus apply so the receiver (this) is preserved when
  // used on a method — with obj.m = observe(obj.m), this still refers to obj.
  return function (this: unknown, ...args: A): R {
    return withSpan(type, name, () => fn.apply(this, args), {
      ...(opts?.metadata ? { metadata: opts.metadata } : {}),
      ...(opts?.tags ? { tags: opts.tags } : {}),
    });
  };
}
