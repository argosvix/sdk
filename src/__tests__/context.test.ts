import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  wrap,
  getRecorder,
  withTrace,
  withSpan,
  observe,
  getAmbientTraceContext,
} from "../index.js";
// The observation sink registry accumulates at module level, so reset it between tests
// (production assumes one wrap per process; only tests wrap repeatedly, which would
// leave the previous test's recorder behind).
import { _resetObservationSinks } from "../context.js";

type RecorderInternals = {
  buffer: Array<{ spanId?: string; parentSpanId?: string; traceId?: string }>;
  obsBuffer: Array<{
    type: string;
    status?: string;
    spanId: string;
    parentSpanId?: string;
    traceId: string;
    name?: string;
    error?: string;
  }>;
};

/**
 * Defense gate for automatic trace-context propagation. Verifies that multiple
 * LLM calls wrapped inside withTrace are automatically grouped into the same
 * trace without an explicit traceId, each with its own span id.
 */

interface OAResp {
  model: string;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}
const baseResp: OAResp = {
  model: "gpt-5.5",
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
};

function makeOpenAIMock() {
  const create = vi.fn(async () => baseResp);
  return { chat: { completions: { create } } };
}

describe("withTrace 自動コンテキスト伝播", () => {
  beforeEach(() => {
    _resetObservationSinks();
  });

  it("withTrace 内の複数呼び出しが同じ traceId にまとまり、 spanId は各々別", async () => {
    const client = wrap(makeOpenAIMock(), {
      apiKey: "argosvix_live_test",
      flushIntervalMs: 60_000,
    });
    await withTrace(async () => {
      await client.chat.completions.create({
        model: "gpt-5.5",
        messages: [{ role: "user", content: "a" }],
      });
      await client.chat.completions.create({
        model: "gpt-5.5",
        messages: [{ role: "user", content: "b" }],
      });
    });
    const records = await getRecorder(client)!.flush();
    expect(records).toHaveLength(2);
    // Same trace
    expect(records[0]?.traceId).toBeTruthy();
    expect(records[0]?.traceId).toBe(records[1]?.traceId);
    // Each has its own span (separate nodes)
    expect(records[0]?.spanId).toBeTruthy();
    expect(records[1]?.spanId).toBeTruthy();
    expect(records[0]?.spanId).not.toBe(records[1]?.spanId);
    // Directly under the trace = no parent
    expect(records[0]?.parentSpanId).toBeUndefined();
  });

  it("明示 traceId を withTrace に渡すとそれが使われる", async () => {
    const client = wrap(makeOpenAIMock(), {
      apiKey: "argosvix_live_test",
      flushIntervalMs: 60_000,
    });
    await withTrace(
      async () => {
        await client.chat.completions.create({
          model: "gpt-5.5",
          messages: [{ role: "user", content: "a" }],
        });
      },
      { traceId: "trace_explicit_1" },
    );
    const records = await getRecorder(client)!.flush();
    expect(records[0]?.traceId).toBe("trace_explicit_1");
  });

  it("withTrace の外(standalone)は trace を持たない = 従来挙動", async () => {
    const client = wrap(makeOpenAIMock(), {
      apiKey: "argosvix_live_test",
      flushIntervalMs: 60_000,
    });
    await client.chat.completions.create({
      model: "gpt-5.5",
      messages: [{ role: "user", content: "a" }],
    });
    const records = await getRecorder(client)!.flush();
    expect(records[0]?.traceId).toBeUndefined();
    expect(records[0]?.spanId).toBeUndefined();
  });

  it("config.traceId(明示)は ambient より優先", async () => {
    const client = wrap(makeOpenAIMock(), {
      apiKey: "argosvix_live_test",
      flushIntervalMs: 60_000,
      traceId: "trace_config_wins",
    });
    await withTrace(async () => {
      await client.chat.completions.create({
        model: "gpt-5.5",
        messages: [{ role: "user", content: "a" }],
      });
    });
    const records = await getRecorder(client)!.flush();
    expect(records[0]?.traceId).toBe("trace_config_wins");
  });

  it("autoContext:false は ambient を無視する", async () => {
    const client = wrap(makeOpenAIMock(), {
      apiKey: "argosvix_live_test",
      flushIntervalMs: 60_000,
      autoContext: false,
    });
    await withTrace(async () => {
      await client.chat.completions.create({
        model: "gpt-5.5",
        messages: [{ role: "user", content: "a" }],
      });
    });
    const records = await getRecorder(client)!.flush();
    expect(records[0]?.traceId).toBeUndefined();
  });

  it("getAmbientTraceContext は withTrace 内でのみ trace を返す", async () => {
    expect(getAmbientTraceContext()).toBeUndefined();
    let inside: string | undefined;
    await withTrace(async () => {
      inside = getAmbientTraceContext()?.traceId;
    });
    expect(inside).toBeTruthy();
    expect(getAmbientTraceContext()).toBeUndefined();
  });

  it("withTrace 内で作った stream を外で消費しても入口の trace が付く(entry-snapshot)", async () => {
    function makeStreamMock() {
      async function* gen() {
        yield { model: "gpt-5.5" } as Record<string, unknown>;
        yield {
          model: "gpt-5.5",
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        } as Record<string, unknown>;
      }
      const create = vi.fn(async (args: { stream?: boolean }) => {
        if (args?.stream) return gen();
        return baseResp;
      });
      return { chat: { completions: { create } } };
    }
    const client = wrap(makeStreamMock(), {
      apiKey: "argosvix_live_test",
      flushIntervalMs: 60_000,
    });
    let stream: AsyncIterable<unknown> | undefined;
    await withTrace(
      async () => {
        stream = (await client.chat.completions.create({
          model: "gpt-5.5",
          messages: [{ role: "user", content: "a" }],
          stream: true,
        })) as AsyncIterable<unknown>;
      },
      { traceId: "t_entry" },
    );
    // Consumed after leaving withTrace (ambient is already undefined)
    expect(getAmbientTraceContext()).toBeUndefined();
    for await (const _ of stream!) {
      // drain
    }
    const records = await getRecorder(client)!.flush();
    expect(records).toHaveLength(1);
    expect(records[0]?.traceId).toBe("t_entry");
  });

  it("withSpan が observation を emit し、 配下の generation がその span にネストする(#1 R4)", async () => {
    const client = wrap(makeOpenAIMock(), {
      apiKey: "argosvix_live_test",
      flushIntervalMs: 60_000,
    });
    await withTrace(async () => {
      await withSpan("retrieval", "retrieve_docs", async () => {
        await client.chat.completions.create({ model: "gpt-5.5", messages: [] });
      });
    });
    const rec = getRecorder(client)! as unknown as RecorderInternals;
    expect(rec.obsBuffer).toHaveLength(1);
    const obs = rec.obsBuffer[0]!;
    expect(obs.type).toBe("retrieval");
    expect(obs.name).toBe("retrieve_docs");
    expect(obs.status).toBe("ok");
    // The generation is a child of the span (parentSpanId === the span's spanId), same trace
    expect(rec.buffer).toHaveLength(1);
    expect(rec.buffer[0]!.parentSpanId).toBe(obs.spanId);
    expect(rec.buffer[0]!.traceId).toBe(obs.traceId);
  });

  it("withSpan の fn が throw すると observation は status=error", async () => {
    const client = wrap(makeOpenAIMock(), {
      apiKey: "argosvix_live_test",
      flushIntervalMs: 60_000,
    });
    let threw = false;
    try {
      await withTrace(async () => {
        await withSpan("tool", "do_thing", async () => {
          throw new Error("tool failed");
        });
      });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    const rec = getRecorder(client)! as unknown as RecorderInternals;
    expect(rec.obsBuffer).toHaveLength(1);
    expect(rec.obsBuffer[0]!.status).toBe("error");
    expect(rec.obsBuffer[0]!.error).toContain("tool failed");
  });

  it("observe = 関数を span として計装し、 戻り値 / 引数を素通し、 配下がネストする(#1)", async () => {
    const client = wrap(makeOpenAIMock(), {
      apiKey: "argosvix_live_test",
      flushIntervalMs: 60_000,
    });
    const retrieve = observe(
      async (q: string) => {
        await client.chat.completions.create({ model: "gpt-5.5", messages: [] });
        return `docs for ${q}`;
      },
      { type: "retrieval", name: "retrieve_docs" },
    );
    const result = await withTrace(() => retrieve("hello"));
    expect(result).toBe("docs for hello"); // return value passes through
    const rec = getRecorder(client)! as unknown as RecorderInternals;
    expect(rec.obsBuffer).toHaveLength(1);
    expect(rec.obsBuffer[0]!.type).toBe("retrieval");
    expect(rec.obsBuffer[0]!.name).toBe("retrieve_docs");
    expect(rec.obsBuffer[0]!.status).toBe("ok");
    // The nested generation is a child of the observe span
    expect(rec.buffer[0]!.parentSpanId).toBe(rec.obsBuffer[0]!.spanId);
  });

  it("observe = name 省略時は関数名、 例外時は status=error で再 throw", async () => {
    const client = wrap(makeOpenAIMock(), {
      apiKey: "argosvix_live_test",
      flushIntervalMs: 60_000,
    });
    async function myTool(): Promise<void> {
      throw new Error("boom");
    }
    const wrapped = observe(myTool);
    let threw = false;
    try {
      await withTrace(() => wrapped());
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    const rec = getRecorder(client)! as unknown as RecorderInternals;
    expect(rec.obsBuffer).toHaveLength(1);
    expect(rec.obsBuffer[0]!.name).toBe("myTool"); // function name becomes the default name
    expect(rec.obsBuffer[0]!.type).toBe("span"); // default type
    expect(rec.obsBuffer[0]!.status).toBe("error");
  });

  it("observe = 同期関数もそのまま計装", async () => {
    wrap(makeOpenAIMock(), { apiKey: "argosvix_live_test", flushIntervalMs: 60_000 });
    const add = observe((a: number, b: number) => a + b, { name: "add" });
    const sum = withTrace(() => add(2, 3));
    expect(sum).toBe(5);
  });

  it("observe = メソッドに使っても this(receiver)を保つ", () => {
    wrap(makeOpenAIMock(), { apiKey: "argosvix_live_test", flushIntervalMs: 60_000 });
    const obj = {
      base: 10,
      compute(this: { base: number }, n: number): number {
        return this.base + n;
      },
    };
    obj.compute = observe(obj.compute, { name: "compute" });
    const out = withTrace(() => obj.compute(5));
    expect(out).toBe(15); // this.base (10) + 5 = 15; `this` is still obj
  });

  it("並行する withTrace が互いの record を汚染しない", async () => {
    const client = wrap(makeOpenAIMock(), {
      apiKey: "argosvix_live_test",
      flushIntervalMs: 60_000,
    });
    const one = (tid: string) =>
      withTrace(
        async () => {
          await client.chat.completions.create({ model: "gpt-5.5", messages: [] });
          await new Promise((r) => setTimeout(r, 0));
          await client.chat.completions.create({ model: "gpt-5.5", messages: [] });
        },
        { traceId: tid },
      );
    await Promise.all([one("traceA"), one("traceB")]);
    const records = await getRecorder(client)!.flush();
    expect(records).toHaveLength(4);
    const counts: Record<string, number> = {};
    for (const r of records) counts[r.traceId ?? "none"] = (counts[r.traceId ?? "none"] ?? 0) + 1;
    expect(counts).toEqual({ traceA: 2, traceB: 2 });
  });
});
