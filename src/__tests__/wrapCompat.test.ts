/**
 * Regression tests for the fully-compatible wrap (2026-07 full-compat).
 *
 * - Non-stream + gate disabled = the original APIPromise is returned as-is (identity)
 * - stream = .tee() detection: the user branch gets the real Stream, the observation branch records
 * - With usage injection (no stream_options given) the legacy path is used (prevents injected-chunk leaks)
 * - .withResponse() stays alive even on the gate-enabled deferred path
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { wrap, getRecorder, flushClient } from "../index.js";

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ records: [] }),
  }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Real Promise with withResponse (simulates an APIPromise). */
function makeFakeAPIPromise<T>(value: T): Promise<T> & { withResponse: () => Promise<unknown> } {
  const p = Promise.resolve(value) as Promise<T> & {
    withResponse: () => Promise<unknown>;
  };
  p.withResponse = () =>
    p.then((data) => ({ data, response: { status: 200 }, request_id: "req_x" }));
  return p;
}

const chatResponse = {
  id: "c1",
  model: "gpt-5.5",
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  choices: [{ message: { content: "hi" } }],
};

function chunksOf(...texts: string[]): unknown[] {
  const out: unknown[] = texts.map((t) => ({
    model: "gpt-5.5",
    choices: [{ delta: { content: t } }],
  }));
  // Real OpenAI usage-only chunks have an empty choices array (the injection filter's criterion).
  out.push({
    model: "gpt-5.5",
    choices: [],
    usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
  });
  return out;
}

/** Simulates an openai-node Stream: async iterable + .tee(). */
class FakeStream {
  constructor(private chunks: unknown[]) {}
  async *[Symbol.asyncIterator]() {
    for (const c of this.chunks) yield c;
  }
  tee(): [FakeStream, FakeStream] {
    return [new FakeStream(this.chunks), new FakeStream(this.chunks)];
  }
}

describe("full-compat: 非 stream identity fast path", () => {
  it("gate 無効なら元の APIPromise がそのまま返る(withResponse 生存)", async () => {
    const apiPromise = makeFakeAPIPromise(chatResponse);
    const client = wrap(
      { chat: { completions: { create: () => apiPromise } } },
      { apiKey: "argosvix_live_test" },
    );
    const ret = client.chat.completions.create({
      model: "gpt-5.5",
      messages: [{ role: "user", content: "x" }],
    });
    expect(ret).toBe(apiPromise); // same object = identity preserved
    const { data } = (await (
      ret as unknown as { withResponse: () => Promise<{ data: unknown }> }
    ).withResponse()) as { data: unknown };
    expect(data).toBe(chatResponse);
    const records = await getRecorder(client)!.flush();
    expect(records).toHaveLength(1);
    expect(records[0]?.promptTokens).toBe(10);
  });

  it("gate 有効(deferred)でも withResponse が委譲で生きる + gate check が create より先", async () => {
    const order: string[] = [];
    fetchMock.mockImplementation(async () => {
      order.push("gate-fetch");
      return { ok: true, status: 200, json: async () => ({}) };
    });
    const create = vi.fn(() => {
      order.push("create");
      return makeFakeAPIPromise(chatResponse);
    });
    const client = wrap(
      { chat: { completions: { create } } },
      { apiKey: "argosvix_live_test", budgetGate: true },
    );
    const ret = client.chat.completions.create({
      model: "gpt-5.5",
      messages: [{ role: "user", content: "x" }],
    }) as unknown as {
      withResponse: () => Promise<{ data: unknown; response: unknown }>;
    } & PromiseLike<unknown>;
    const res = await ret;
    expect(res).toBe(chatResponse);
    // The gate fetch runs before create (no gate bypass)
    expect(order.indexOf("gate-fetch")).toBeLessThan(order.indexOf("create"));
    const wr = await ret.withResponse();
    expect(wr.data).toBe(chatResponse);
    const records = await flushClient(client).then(() => getRecorder(client)!.flush());
    // The record is written exactly once on the settled chain
    expect(create).toHaveBeenCalledTimes(1);
  });
});

describe("full-compat: stream tee 経路", () => {
  it("stream_options 明示なら tee のユーザー枝(本物 Stream)が返り、観測枝が記録する", async () => {
    const raw = new FakeStream(chunksOf("Hello ", "world"));
    const client = wrap(
      { chat: { completions: { create: () => makeFakeAPIPromise(raw) } } },
      { apiKey: "argosvix_live_test", captureContent: true },
    );
    const stream = (await client.chat.completions.create({
      model: "gpt-5.5",
      messages: [{ role: "user", content: "q" }],
      stream: true,
      stream_options: { include_usage: true }, // explicit = no injection = tee path
    })) as FakeStream;
    expect(stream).toBeInstanceOf(FakeStream); // still the real Stream (tee branch)
    expect(typeof stream.tee).toBe("function"); // advanced API survives
    const seen: unknown[] = [];
    for await (const c of stream) seen.push(c);
    expect(seen).toHaveLength(3); // user branch passes through (incl. the usage chunk = the caller opted in)
    await new Promise((r) => setTimeout(r, 0)); // wait for the observation branch to finish draining
    const records = await getRecorder(client)!.flush();
    expect(records).toHaveLength(1);
    expect(records[0]?.promptTokens).toBe(7); // the observation branch records the usage
    expect(records[0]?.completionBody).toBe("Hello world");
  });

  it("ユーザーが途中 break しても観測枝は完走し usage が完全記録される", async () => {
    const raw = new FakeStream(chunksOf("a", "b", "c"));
    const client = wrap(
      { chat: { completions: { create: () => makeFakeAPIPromise(raw) } } },
      { apiKey: "argosvix_live_test" },
    );
    const stream = (await client.chat.completions.create({
      model: "gpt-5.5",
      messages: [],
      stream: true,
      stream_options: { include_usage: true },
    })) as FakeStream;
    for await (const _c of stream) break; // stop after 1 chunk
    // The (independent) observation branch runs to completion: spin microtasks to let it drain
    await new Promise((r) => setTimeout(r, 0));
    const records = await getRecorder(client)!.flush();
    expect(records).toHaveLength(1);
    expect(records[0]?.promptTokens).toBe(7); // was 0 in the old implementation (shared generator)
  });

  it("stream_options 未指定(usage 注入)は tee せず従来経路(注入チャンクがユーザーに漏れない)", async () => {
    const raw = new FakeStream(chunksOf("x"));
    const client = wrap(
      { chat: { completions: { create: () => makeFakeAPIPromise(raw) } } },
      { apiKey: "argosvix_live_test" },
    );
    const stream = (await client.chat.completions.create({
      model: "gpt-5.5",
      messages: [],
      stream: true, // no stream_options = include_usage gets injected
    })) as AsyncIterable<unknown>;
    expect(stream).not.toBeInstanceOf(FakeStream); // legacy wrap (no tee)
    const seen: unknown[] = [];
    for await (const c of stream) seen.push(c);
    expect(seen).toHaveLength(1); // the usage-only chunk is filtered out (no regression)
    const records = await getRecorder(client)!.flush();
    expect(records[0]?.promptTokens).toBe(7);
  });
});

describe("full-compat: responses API", () => {
  it("非 stream identity + tee stream の両方が responses でも動く", async () => {
    const nonStream = makeFakeAPIPromise({
      model: "gpt-5.5",
      usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 },
      output_text: "ok",
    });
    const client = wrap(
      { responses: { create: () => nonStream } },
      { apiKey: "argosvix_live_test" },
    );
    const ret = client.responses.create({ model: "gpt-5.5", input: "q" });
    expect(ret).toBe(nonStream); // identity
    await ret;
    const records = await getRecorder(client)!.flush();
    expect(records[0]?.promptTokens).toBe(4);
  });

  it("responses stream: tee のユーザー枝が本物のまま、観測枝が completed usage を記録", async () => {
    const events = [
      { type: "response.output_text.delta", delta: "Hi" },
      {
        type: "response.completed",
        response: {
          model: "gpt-5.5",
          usage: { input_tokens: 9, output_tokens: 4, total_tokens: 13 },
        },
      },
    ];
    const raw = new FakeStream(events);
    const client = wrap(
      { responses: { create: () => makeFakeAPIPromise(raw) } },
      { apiKey: "argosvix_live_test", captureContent: true },
    );
    const stream = (await client.responses.create({
      model: "gpt-5.5",
      input: "q",
      stream: true,
    })) as FakeStream;
    expect(stream).toBeInstanceOf(FakeStream);
    const seen: unknown[] = [];
    for await (const e of stream) seen.push(e);
    expect(seen).toHaveLength(2); // all events pass through
    await new Promise((r) => setTimeout(r, 0));
    const records = await getRecorder(client)!.flush();
    expect(records).toHaveLength(1);
    expect(records[0]?.promptTokens).toBe(9);
    expect(records[0]?.completionBody).toBe("Hi");
  });
});


describe("full-compat: レビュー指摘の回帰", () => {
  it("identity fast path の asResponse は無傷のまま(実 openai の withResponse が内部で呼ぶため上書き禁止)", async () => {
    const originalAsResponse = async () => ({ status: 200 });
    const apiPromise = makeFakeAPIPromise(chatResponse) as ReturnType<
      typeof makeFakeAPIPromise<typeof chatResponse>
    > & { asResponse: () => Promise<unknown> };
    apiPromise.asResponse = originalAsResponse;
    const client = wrap(
      { chat: { completions: { create: () => apiPromise } } },
      { apiKey: "argosvix_live_test" },
    );
    const ret = client.chat.completions.create({
      model: "gpt-5.5",
      messages: [],
    }) as unknown as { asResponse: () => unknown };
    expect(ret.asResponse).toBe(originalAsResponse); // left completely untouched
  });

  it("deferred compat の asResponse() は明確な TypeError(record の parse と両立しないため)", async () => {
    const client = wrap(
      { chat: { completions: { create: () => makeFakeAPIPromise(chatResponse) } } },
      { apiKey: "argosvix_live_test", budgetGate: true }, // gate enabled = deferred path
    );
    const ret = client.chat.completions.create({
      model: "gpt-5.5",
      messages: [],
    }) as unknown as { asResponse: () => unknown };
    expect(() => ret.asResponse()).toThrow(/asResponse/);
    await (ret as unknown as Promise<unknown>); // cleanup (wait for the record to complete)
  });

  it("deferred 経路の返り値は本物の Promise(instanceof 互換)+ 未 await でも unhandledRejection しない", async () => {
    const client = wrap(
      {
        chat: {
          completions: {
            create: () => Promise.reject(new Error("boom")),
          },
        },
      },
      { apiKey: "argosvix_live_test", budgetGate: true }, // gate enabled = deferred path
    );
    const ret = client.chat.completions.create({ model: "gpt-5.5", messages: [] });
    expect(ret).toBeInstanceOf(Promise); // must be a real Promise (instanceof-compatible)
    // Even if the user never awaits it, the sacrificial catch on the settled chain
    // holds the rejection. (vitest turns unhandledRejection into a process error,
    // so this test completing at all is itself the verification.)
    await new Promise((r) => setTimeout(r, 10));
    // Awaiting still delivers the rejection to the user
    await expect(ret as Promise<unknown>).rejects.toThrow("boom");
  });

  it("abort された stream は clean success でなく truncated として記録", async () => {
    const chunks = [
      { model: "gpt-5.5", choices: [{ delta: { content: "par" } }] },
    ];
    class AbortedStream extends FakeStream {
      controller = { signal: { aborted: true } }; // simulates an already-aborted shared controller
      // Real openai tee branches share the controller (so does the mock)
      tee(): [AbortedStream, AbortedStream] {
        return [new AbortedStream(chunks), new AbortedStream(chunks)];
      }
    }
    const raw = new AbortedStream(chunks);
    const client = wrap(
      { chat: { completions: { create: () => makeFakeAPIPromise(raw) } } },
      { apiKey: "argosvix_live_test", captureContent: true },
    );
    const stream = (await client.chat.completions.create({
      model: "gpt-5.5",
      messages: [],
      stream: true,
      stream_options: { include_usage: true },
    })) as FakeStream;
    for await (const _c of stream) void _c;
    await new Promise((r) => setTimeout(r, 0));
    const records = await getRecorder(client)!.flush();
    expect(records).toHaveLength(1);
    // aborted = not treated as a clean finish → the capture gets a truncated marker
    expect(records[0]?.completionBody).toContain("[truncated]");
  });

  it("tee() が同期 throw するカスタム stream は従来経路に fallback して記録される", async () => {
    const chunks = chunksOf("ok");
    class BrokenTeeStream extends FakeStream {
      tee(): [FakeStream, FakeStream] {
        throw new Error("tee not really supported");
      }
    }
    const raw = new BrokenTeeStream(chunks);
    const client = wrap(
      { chat: { completions: { create: () => makeFakeAPIPromise(raw) } } },
      { apiKey: "argosvix_live_test" },
    );
    const stream = (await client.chat.completions.create({
      model: "gpt-5.5",
      messages: [],
      stream: true,
      stream_options: { include_usage: true },
    })) as AsyncIterable<unknown>;
    const seen: unknown[] = [];
    for await (const c of stream) seen.push(c);
    expect(seen.length).toBeGreaterThan(0); // still passes through on the fallback
    const records = await getRecorder(client)!.flush();
    expect(records[0]?.promptTokens).toBe(7); // recording still works
  });
});
