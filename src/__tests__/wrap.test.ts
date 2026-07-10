import { describe, it, expect, vi } from "vitest";
import { wrap, getRecorder, __resetStreamHelperWarning } from "../client.js";

describe("audit round2 M27: 高レベル stream() helper の gate bypass 警告", () => {
  it("budgetGate 有効 + messages.stream() あり = wrap 時に警告", () => {
    __resetStreamHelperWarning();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = {
      messages: { create: vi.fn(async () => ({})), stream: vi.fn() },
    };
    wrap(client, { budgetGate: true });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("messages.stream()"),
    );
    warn.mockRestore();
  });

  it("gate 無効なら警告しない", () => {
    __resetStreamHelperWarning();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = {
      messages: { create: vi.fn(async () => ({})), stream: vi.fn() },
    };
    wrap(client, {});
    expect(
      warn.mock.calls.some((c) => String(c[0]).includes("audit M27")),
    ).toBe(false);
    warn.mockRestore();
  });

  it("stream() helper が無ければ警告しない", () => {
    __resetStreamHelperWarning();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = { messages: { create: vi.fn(async () => ({})) } };
    wrap(client, { budgetGate: true });
    expect(
      warn.mock.calls.some((c) => String(c[0]).includes("audit M27")),
    ).toBe(false);
    warn.mockRestore();
  });
});

interface MockResponse {
  id: string;
  model: string;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  choices: Array<{ message: { content: string } }>;
}

function makeMockOpenAI(response: MockResponse, shouldThrow = false) {
  const create = vi.fn(async () => {
    if (shouldThrow) {
      throw new Error("mock api error");
    }
    return response;
  });
  return {
    chat: { completions: { create } },
    _create: create,
  };
}

const baseResponse: MockResponse = {
  id: "chatcmpl-test",
  model: "gpt-5.5",
  usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
  choices: [{ message: { content: "hello" } }],
};

describe("wrap (OpenAI)", () => {
  it("元 method の return を透過する", async () => {
    const mock = makeMockOpenAI(baseResponse);
    const client = wrap(mock);
    const res = await client.chat.completions.create({
      model: "gpt-5.5",
      messages: [{ role: "user", content: "hi" }],
    });
    expect((res as MockResponse).id).toBe("chatcmpl-test");
    expect(mock._create).toHaveBeenCalledOnce();
  });

  it("成功 call で recorder に LlmCallRecord を 1 件追加する", async () => {
    const mock = makeMockOpenAI(baseResponse);
    const client = wrap(mock, { tags: { service: "test-bot" } });
    await client.chat.completions.create({
      model: "gpt-5.5",
      messages: [{ role: "user", content: "hi" }],
      temperature: 0.7,
    });
    const recorder = getRecorder(client);
    expect(recorder).not.toBeNull();
    const records = await recorder!.flush();
    expect(records).toHaveLength(1);
    const record = records[0]!;
    expect(record.provider).toBe("openai");
    expect(record.model).toBe("gpt-5.5");
    expect(record.promptTokens).toBe(100);
    expect(record.completionTokens).toBe(50);
    expect(record.totalTokens).toBe(150);
    expect(record.costUsd).toBeGreaterThan(0);
    expect(record.tags.service).toBe("test-bot");
    expect(record.requestMeta?.messagesCount).toBe(1);
    expect(record.requestMeta?.temperature).toBe(0.7);
    expect(record.error).toBeUndefined();
  });

  it("API error 時も record を残し error を rethrow する", async () => {
    const mock = makeMockOpenAI(baseResponse, true);
    const client = wrap(mock);
    await expect(
      client.chat.completions.create({
        model: "gpt-5.5",
        messages: [{ role: "user", content: "hi" }],
      }),
    ).rejects.toThrow("mock api error");
    const recorder = getRecorder(client);
    const records = await recorder!.flush();
    expect(records).toHaveLength(1);
    expect(records[0]?.error).toBe("mock api error");
    expect(records[0]?.costUsd).toBe(0);
  });

  // Verifies that the wrap option's trace fields are propagated to all
  // records across success / error and every provider.
  it("wrap option の traceId / spanId / parentSpanId が record に carry される", async () => {
    const mock = makeMockOpenAI(baseResponse);
    const client = wrap(mock, {
      traceId: "trace_F2",
      spanId: "span_F2",
      parentSpanId: "span_parent_F2",
    });
    await client.chat.completions.create({
      model: "gpt-5.5",
      messages: [{ role: "user", content: "hi" }],
    });
    const records = await getRecorder(client)!.flush();
    expect(records).toHaveLength(1);
    expect(records[0]?.traceId).toBe("trace_F2");
    expect(records[0]?.spanId).toBe("span_F2");
    expect(records[0]?.parentSpanId).toBe("span_parent_F2");
  });

  it("wrap option の sessionId が record に引き継がれる (session tracking)", async () => {
    const mock = makeMockOpenAI(baseResponse);
    const client = wrap(mock, {
      sessionId: "sess_conversation_abc",
    });
    await client.chat.completions.create({
      model: "gpt-5.5",
      messages: [{ role: "user", content: "hi" }],
    });
    const records = await getRecorder(client)!.flush();
    expect(records).toHaveLength(1);
    expect(records[0]?.sessionId).toBe("sess_conversation_abc");
  });

  it("trace 軸を指定しない場合は record に traceId 等が undefined のまま (後方互換)", async () => {
    const mock = makeMockOpenAI(baseResponse);
    const client = wrap(mock);
    await client.chat.completions.create({
      model: "gpt-5.5",
      messages: [{ role: "user", content: "hi" }],
    });
    const records = await getRecorder(client)!.flush();
    expect(records).toHaveLength(1);
    expect(records[0]?.traceId).toBeUndefined();
    expect(records[0]?.spanId).toBeUndefined();
    expect(records[0]?.parentSpanId).toBeUndefined();
  });

  it("traceId 指定 + API error でも record に traceId が carry される", async () => {
    const mock = makeMockOpenAI(baseResponse, true);
    const client = wrap(mock, { traceId: "trace_err" });
    await expect(
      client.chat.completions.create({
        model: "gpt-5.5",
        messages: [{ role: "user", content: "hi" }],
      }),
    ).rejects.toThrow("mock api error");
    const records = await getRecorder(client)!.flush();
    expect(records[0]?.traceId).toBe("trace_err");
    expect(records[0]?.error).toBe("mock api error");
  });

  it("同一 client への重複 wrap は idempotent = nested record 発生しない", async () => {
    const mock = makeMockOpenAI(baseResponse);
    const wrapped1 = wrap(mock, { tags: { v: "1" } });
    const wrapped2 = wrap(mock, { tags: { v: "2" } });
    expect(wrapped1).toBe(wrapped2);
    await wrapped1.chat.completions.create({
      model: "gpt-5.5",
      messages: [{ role: "user", content: "hi" }],
    });
    const records = await getRecorder(wrapped1)!.flush();
    expect(records).toHaveLength(1);
    expect(records[0]?.tags.v).toBe("1");
  });

  it("並列 client は独立 recorder を持つ (= test/prod isolation)", async () => {
    const mockA = makeMockOpenAI(baseResponse);
    const mockB = makeMockOpenAI(baseResponse);
    const clientA = wrap(mockA, { tags: { instance: "A" } });
    const clientB = wrap(mockB, { tags: { instance: "B" } });
    await clientA.chat.completions.create({
      model: "gpt-5.5",
      messages: [{ role: "user", content: "x" }],
    });
    const recA = getRecorder(clientA)!;
    const recB = getRecorder(clientB)!;
    expect(recA.getBufferSize()).toBe(1);
    expect(recB.getBufferSize()).toBe(0);
  });

  describe("responses API", () => {
    interface ResponsesMockResponse {
      id: string;
      model: string;
      usage: { input_tokens: number; output_tokens: number; total_tokens: number };
      output: Array<{ content: string }>;
    }

    function makeResponsesMock(response: ResponsesMockResponse, shouldThrow = false) {
      const create = vi.fn(async () => {
        if (shouldThrow) throw new Error("responses mock error");
        return response;
      });
      return { responses: { create }, _create: create };
    }

    const baseResponsesResponse: ResponsesMockResponse = {
      id: "resp-test",
      model: "gpt-5.5",
      usage: { input_tokens: 80, output_tokens: 30, total_tokens: 110 },
      output: [{ content: "hi" }],
    };

    it("responses.create を hook して record する (= input_tokens → promptTokens 変換)", async () => {
      const mock = makeResponsesMock(baseResponsesResponse);
      const client = wrap(mock, { tags: { v: "responses" } });
      await client.responses.create({
        model: "gpt-5.5",
        input: "hello",
      });
      const records = await getRecorder(client)!.flush();
      expect(records).toHaveLength(1);
      expect(records[0]?.promptTokens).toBe(80);
      expect(records[0]?.completionTokens).toBe(30);
      expect(records[0]?.totalTokens).toBe(110);
      expect(records[0]?.tags.v).toBe("responses");
    });

    it("captureContent: true で input が string のとき promptBody / completionBody / toolCalls を 抽出", async () => {
      const responseWithText = {
        id: "resp-cap-1",
        model: "gpt-5.5",
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
        output_text: "hello back",
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text: "hello back" }],
          },
          {
            type: "function_call",
            name: "get_weather",
            arguments: '{"city":"Tokyo"}',
          },
        ],
      };
      const create = vi.fn(async () => responseWithText);
      const client = wrap({ responses: { create } }, { captureContent: true });
      await client.responses.create({ model: "gpt-5.5", input: "hello" });
      const records = await getRecorder(client)!.flush();
      expect(records).toHaveLength(1);
      expect(records[0]?.promptBody).toBe("hello");
      expect(records[0]?.completionBody).toBe("hello back");
      expect(records[0]?.toolCalls).toEqual([
        { name: "get_weather", arguments: '{"city":"Tokyo"}' },
      ]);
    });

    it("captureContent: true で input が array のとき JSON 文字列化、 output_text 不在なら output[].content[].text を join", async () => {
      const responseArr = {
        id: "resp-cap-2",
        model: "gpt-5.5",
        usage: { input_tokens: 12, output_tokens: 6, total_tokens: 18 },
        output: [
          {
            type: "message",
            content: [
              { type: "output_text", text: "part1" },
              { type: "output_text", text: "part2" },
            ],
          },
        ],
      };
      const create = vi.fn(async () => responseArr);
      const client = wrap({ responses: { create } }, { captureContent: true });
      await client.responses.create({
        model: "gpt-5.5",
        input: [{ role: "user", content: "structured" }],
      });
      const records = await getRecorder(client)!.flush();
      expect(records[0]?.promptBody).toBe(
        JSON.stringify([{ role: "user", content: "structured" }]),
      );
      expect(records[0]?.completionBody).toBe("part1\npart2");
      expect(records[0]?.toolCalls).toBeUndefined();
    });

    it("captureContent: 未指定 (default false) では Responses でも promptBody / completionBody / toolCalls を set しない", async () => {
      const mock = makeResponsesMock(baseResponsesResponse);
      const client = wrap(mock);
      await client.responses.create({ model: "gpt-5.5", input: "hello" });
      const records = await getRecorder(client)!.flush();
      expect(records[0]?.promptBody).toBeUndefined();
      expect(records[0]?.completionBody).toBeUndefined();
      expect(records[0]?.toolCalls).toBeUndefined();
    });

    it("chat.completions と responses 両方 hook できる (= 同一 client)", async () => {
      const create_chat = vi.fn(async () => ({
        model: "gpt-5.5",
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }));
      const create_responses = vi.fn(async () => baseResponsesResponse);
      const mock = {
        chat: { completions: { create: create_chat } },
        responses: { create: create_responses },
      };
      const client = wrap(mock);
      await client.chat.completions.create({
        model: "gpt-5.5",
        messages: [{ role: "user", content: "x" }],
      });
      await client.responses.create({ model: "gpt-5.5", input: "y" });
      const records = await getRecorder(client)!.flush();
      expect(records).toHaveLength(2);
    });

    // --- Responses streaming (implemented for both SDKs at once, 2026-07) ---

    function makeResponsesStream(
      events: unknown[],
      shouldThrow = false,
    ) {
      const create = vi.fn(async () => {
        if (shouldThrow) throw new Error("responses stream mock error");
        return (async function* () {
          for (const e of events) yield e;
        })();
      });
      return { responses: { create } };
    }

    const streamEvents = [
      { type: "response.created" },
      { type: "response.output_text.delta", delta: "Hello " },
      { type: "response.output_text.delta", delta: "world" },
      {
        type: "response.completed",
        response: {
          model: "gpt-5.5",
          usage: { input_tokens: 12, output_tokens: 7, total_tokens: 19 },
        },
      },
    ];

    it("responses stream: 完走で completed の usage を記録", async () => {
      const client = wrap(makeResponsesStream(streamEvents));
      const stream = (await client.responses.create({
        model: "gpt-5.5",
        input: "hi",
        stream: true,
      })) as AsyncIterable<unknown>;
      const seen: unknown[] = [];
      for await (const e of stream) seen.push(e);
      expect(seen).toHaveLength(4); // all events pass through
      const records = await getRecorder(client)!.flush();
      expect(records).toHaveLength(1);
      expect(records[0]?.promptTokens).toBe(12);
      expect(records[0]?.completionTokens).toBe(7);
    });

    it("responses stream: 早期 break でも finally で 1 回記録(記録が消えない)", async () => {
      const client = wrap(makeResponsesStream(streamEvents));
      const stream = (await client.responses.create({
        model: "gpt-5.5",
        input: "hi",
        stream: true,
      })) as AsyncIterable<unknown>;
      for await (const _e of stream) break; // stop after 1 event = .return()
      const records = await getRecorder(client)!.flush();
      expect(records).toHaveLength(1);
      expect(records[0]?.promptTokens).toBe(0); // completed never reached = usage 0
    });

    it("responses stream: captureContent で delta を completionBody に蓄積", async () => {
      const client = wrap(makeResponsesStream(streamEvents), { captureContent: true });
      const stream = (await client.responses.create({
        model: "gpt-5.5",
        input: "質問",
        stream: true,
      })) as AsyncIterable<unknown>;
      for await (const _e of stream) void _e;
      const records = await getRecorder(client)!.flush();
      expect(records[0]?.completionBody).toBe("Hello world");
      expect(records[0]?.promptBody).toBe("質問");
    });

    it("responses stream: error イベントは 0-token success でなく error record", async () => {
      const client = wrap(
        makeResponsesStream([
          { type: "response.output_text.delta", delta: "partial" },
          { type: "error", message: "rate limited" },
        ]),
      );
      const stream = (await client.responses.create({
        model: "gpt-5.5",
        input: "hi",
        stream: true,
      })) as AsyncIterable<unknown>;
      for await (const _e of stream) void _e;
      const records = await getRecorder(client)!.flush();
      expect(records[0]?.error).toBe("rate limited");
      expect(records[0]?.promptTokens).toBe(0);
    });

    it("responses stream: completed 未到達の EOF は truncated 扱い", async () => {
      const client = wrap(
        makeResponsesStream([{ type: "response.output_text.delta", delta: "Hello" }]),
        { captureContent: true },
      );
      const stream = (await client.responses.create({
        model: "gpt-5.5",
        input: "q",
        stream: true,
      })) as AsyncIterable<unknown>;
      for await (const _e of stream) void _e;
      const records = await getRecorder(client)!.flush();
      expect(records[0]?.completionBody).toContain("[truncated]");
    });

    it("responses stream: refusal.delta も completionBody に", async () => {
      const client = wrap(
        makeResponsesStream([
          { type: "response.refusal.delta", delta: "can't help with that" },
          {
            type: "response.completed",
            response: {
              model: "gpt-5.5",
              usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
            },
          },
        ]),
        { captureContent: true },
      );
      const stream = (await client.responses.create({
        model: "gpt-5.5",
        input: "q",
        stream: true,
      })) as AsyncIterable<unknown>;
      for await (const _e of stream) void _e;
      const records = await getRecorder(client)!.flush();
      expect(records[0]?.completionBody).toBe("can't help with that");
    });
  });

  describe("Anthropic", () => {
    interface AnthropicMockResponse {
      id: string;
      model: string;
      usage: { input_tokens: number; output_tokens: number };
      content: Array<{ type: string; text: string }>;
    }

    function makeAnthropicMock(response: AnthropicMockResponse, shouldThrow = false) {
      const create = vi.fn(async () => {
        if (shouldThrow) throw new Error("anthropic mock error");
        return response;
      });
      return { messages: { create }, _create: create };
    }

    const baseAnthropicResponse: AnthropicMockResponse = {
      id: "msg_test",
      model: "claude-opus-4-7",
      usage: { input_tokens: 120, output_tokens: 80 },
      content: [{ type: "text", text: "hello" }],
    };

    it("messages.create を hook (= input_tokens → promptTokens 変換)", async () => {
      const mock = makeAnthropicMock(baseAnthropicResponse);
      const client = wrap(mock, { tags: { v: "ant" } });
      await client.messages.create({
        model: "claude-opus-4-7",
        max_tokens: 1024,
        messages: [{ role: "user", content: "hi" }],
      });
      const records = await getRecorder(client)!.flush();
      expect(records).toHaveLength(1);
      expect(records[0]?.provider).toBe("anthropic");
      expect(records[0]?.model).toBe("claude-opus-4-7");
      expect(records[0]?.promptTokens).toBe(120);
      expect(records[0]?.completionTokens).toBe(80);
      expect(records[0]?.totalTokens).toBe(200);
      expect(records[0]?.costUsd).toBeGreaterThan(0);
      expect(records[0]?.requestMeta?.maxTokens).toBe(1024);
    });

    it("Anthropic streaming: message_start + message_delta から usage 累積 + record", async () => {
      const events = [
        {
          type: "message_start",
          message: {
            model: "claude-opus-4-7",
            usage: { input_tokens: 50, output_tokens: 0 },
          },
        },
        { type: "content_block_delta", delta: { text: "hi" } },
        { type: "message_delta", usage: { output_tokens: 25 } },
        { type: "message_stop" },
      ];
      const mock = {
        messages: {
          create: vi.fn(async () => {
            return (async function* (): AsyncGenerator<Record<string, unknown>> {
              for (const e of events) yield e;
            })();
          }),
        },
      };
      const client = wrap(mock);
      const stream = await client.messages.create({
        model: "claude-opus-4-7",
        max_tokens: 1024,
        stream: true,
        messages: [{ role: "user", content: "x" }],
      });
      for await (const _event of stream as AsyncIterable<Record<string, unknown>>) {
        // drain stream
      }
      const records = await getRecorder(client)!.flush();
      expect(records).toHaveLength(1);
      expect(records[0]?.promptTokens).toBe(50);
      expect(records[0]?.completionTokens).toBe(25);
      expect(records[0]?.totalTokens).toBe(75);
    });

    it("Anthropic API error 時も record + rethrow", async () => {
      const mock = makeAnthropicMock(baseAnthropicResponse, true);
      const client = wrap(mock);
      await expect(
        client.messages.create({
          model: "claude-opus-4-7",
          max_tokens: 100,
          messages: [{ role: "user", content: "x" }],
        }),
      ).rejects.toThrow("anthropic mock error");
      const records = await getRecorder(client)!.flush();
      expect(records).toHaveLength(1);
      expect(records[0]?.error).toBe("anthropic mock error");
      expect(records[0]?.provider).toBe("anthropic");
    });

    // Verifies trace-field propagation for a provider other than OpenAI.
    // All providers share the buildTraceMeta path, so one representative
    // provider is enough to detect regressions in the propagation mechanism.
    it("Anthropic でも wrap option の trace 軸が record に carry される", async () => {
      const mock = makeAnthropicMock(baseAnthropicResponse);
      const client = wrap(mock, {
        traceId: "trace_anthropic_F2",
        parentSpanId: "span_root",
      });
      await client.messages.create({
        model: "claude-opus-4-7",
        max_tokens: 100,
        messages: [{ role: "user", content: "x" }],
      });
      const records = await getRecorder(client)!.flush();
      expect(records[0]?.traceId).toBe("trace_anthropic_F2");
      expect(records[0]?.parentSpanId).toBe("span_root");
      // A generation that belongs to a trace automatically gets its own span id
      // (becoming a node of the trace), distinct from the parent (span_root).
      expect(records[0]?.spanId).toBeTruthy();
      expect(records[0]?.spanId).not.toBe("span_root");
    });
  });

  describe("Mistral", () => {
    interface MistralMockResponse {
      id: string;
      model: string;
      usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
      choices: Array<{ message: { content: string } }>;
    }

    const baseMistralResponse: MistralMockResponse = {
      id: "mistral-test",
      model: "mistral-large",
      usage: { prompt_tokens: 60, completion_tokens: 40, total_tokens: 100 },
      choices: [{ message: { content: "ok" } }],
    };

    function makeMistralMock(response: MistralMockResponse, shouldThrow = false) {
      const complete = vi.fn(async () => {
        if (shouldThrow) throw new Error("mistral mock error");
        return response;
      });
      return { chat: { complete } };
    }

    it("chat.complete を hook (= prompt_tokens / completion_tokens 取得)", async () => {
      const mock = makeMistralMock(baseMistralResponse);
      const client = wrap(mock, { tags: { v: "mistral" } });
      await client.chat.complete({
        model: "mistral-large",
        messages: [{ role: "user", content: "hi" }],
      });
      const records = await getRecorder(client)!.flush();
      expect(records).toHaveLength(1);
      expect(records[0]?.provider).toBe("mistral");
      expect(records[0]?.promptTokens).toBe(60);
      expect(records[0]?.completionTokens).toBe(40);
      expect(records[0]?.totalTokens).toBe(100);
      expect(records[0]?.costUsd).toBeGreaterThan(0);
    });

    it("chat.stream を hook (= 累積 chunk から usage 取得)", async () => {
      const chunks = [
        { data: { model: "mistral-large", choices: [{ delta: { content: "h" } }] } },
        { data: { choices: [{ delta: { content: "i" } }] } },
        {
          data: {
            choices: [{ finish_reason: "stop" }],
            usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 },
          },
        },
      ];
      const mock = {
        chat: {
          complete: vi.fn(),
          stream: vi.fn(async () => {
            return (async function* () {
              for (const c of chunks) yield c;
            })();
          }),
        },
      };
      const client = wrap(mock);
      const stream = await client.chat.stream({
        model: "mistral-large",
        messages: [{ role: "user", content: "x" }],
      });
      for await (const _chunk of stream as AsyncIterable<unknown>) {
        // drain
      }
      const records = await getRecorder(client)!.flush();
      expect(records).toHaveLength(1);
      expect(records[0]?.promptTokens).toBe(12);
      expect(records[0]?.completionTokens).toBe(5);
    });

    it("Mistral API error 時も record + rethrow", async () => {
      const mock = makeMistralMock(baseMistralResponse, true);
      const client = wrap(mock);
      await expect(
        client.chat.complete({
          model: "mistral-large",
          messages: [{ role: "user", content: "x" }],
        }),
      ).rejects.toThrow("mistral mock error");
      const records = await getRecorder(client)!.flush();
      expect(records).toHaveLength(1);
      expect(records[0]?.error).toBe("mistral mock error");
    });

    it("L-1: Mistral stream 途中 throw = 部分 usage + error を record + rethrow", async () => {
      const mock = {
        chat: {
          complete: vi.fn(),
          stream: vi.fn(async () => {
            return (async function* () {
              yield { data: { model: "mistral-large", choices: [{ delta: { content: "h" } }] } };
              yield {
                data: {
                  choices: [{ delta: { content: "i" } }],
                  usage: { prompt_tokens: 8, completion_tokens: 1 },
                },
              };
              throw new Error("mid-stream broken");
            })();
          }),
        },
      };
      const client = wrap(mock);
      const stream = await client.chat.stream({
        model: "mistral-large",
        messages: [{ role: "user", content: "x" }],
      });
      await expect(
        (async () => {
          for await (const _chunk of stream as AsyncIterable<unknown>) {
            // drain until throw
          }
        })(),
      ).rejects.toThrow("mid-stream broken");
      const records = await getRecorder(client)!.flush();
      expect(records).toHaveLength(1);
      expect(records[0]?.error).toBe("mid-stream broken");
      expect(records[0]?.promptTokens).toBe(8);
      expect(records[0]?.completionTokens).toBe(1);
    });

    it("M-3: mistral-small-latest 等 production model 名で cost 計算可能", async () => {
      const mock = makeMistralMock({
        ...baseMistralResponse,
        model: "mistral-small-latest",
      });
      const client = wrap(mock);
      await client.chat.complete({
        model: "mistral-small-latest",
        messages: [{ role: "user", content: "x" }],
      });
      const records = await getRecorder(client)!.flush();
      expect(records[0]?.model).toBe("mistral-small-latest");
      expect(records[0]?.costUsd).toBeGreaterThan(0);
    });
  });

  describe("provider override + detection (H-1)", () => {
    it("config.provider override で composite client も明示 hook 可能", async () => {
      // Composite mock with an OpenAI shape plus Anthropic-like messages
      const create = vi.fn(async () => ({
        model: "gpt-5.5",
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }));
      const mock = {
        chat: { completions: { create } },
        messages: { create: vi.fn() }, // shape ambiguity
      };
      const client = wrap(mock, { provider: "openai" });
      await client.chat.completions.create({
        model: "gpt-5.5",
        messages: [{ role: "user", content: "x" }],
      });
      const records = await getRecorder(client)!.flush();
      expect(records).toHaveLength(1);
      expect(records[0]?.provider).toBe("openai");
    });
  });

  describe("Mistral stream init error (H-2)", () => {
    it("chat.stream() 自体が throw した場合も record + rethrow する", async () => {
      const mock = {
        chat: {
          complete: vi.fn(),
          stream: vi.fn(async () => {
            throw new Error("stream init failed");
          }),
        },
      };
      const client = wrap(mock);
      await expect(
        client.chat.stream({
          model: "mistral-large",
          messages: [{ role: "user", content: "x" }],
        }),
      ).rejects.toThrow("stream init failed");
      const records = await getRecorder(client)!.flush();
      expect(records).toHaveLength(1);
      expect(records[0]?.provider).toBe("mistral");
      expect(records[0]?.error).toBe("stream init failed");
    });
  });

  describe("Gemini legacy idempotency (C-1)", () => {
    it("同じ model instance を 2 回返す getGenerativeModel = 重複 wrap しない", async () => {
      const sharedInstance = {
        generateContent: vi.fn(async () => ({
          response: {
            usageMetadata: {
              promptTokenCount: 10,
              candidatesTokenCount: 5,
              totalTokenCount: 15,
            },
          },
        })),
      };
      const mock = {
        getGenerativeModel: vi.fn(() => sharedInstance),
      };
      const client = wrap(mock);
      const m1 = client.getGenerativeModel({ model: "gemini-2.0-flash" });
      const m2 = client.getGenerativeModel({ model: "gemini-2.0-flash" });
      expect(m1).toBe(m2);
      await m1.generateContent("hi");
      const records = await getRecorder(client)!.flush();
      // 1 call only = confirms nested wrapping does not produce 2x records
      expect(records).toHaveLength(1);
    });
  });

  describe("Gemini legacy streaming (C-2)", () => {
    it("generateContentStream は stream 完了後 response Promise で record (= 同期的)", async () => {
      const chunks = [
        { text: () => "h" },
        { text: () => "i" },
      ];
      const usageMetadata = {
        promptTokenCount: 30,
        candidatesTokenCount: 10,
        totalTokenCount: 40,
      };
      const modelInstance = {
        generateContent: vi.fn(),
        generateContentStream: vi.fn(async () => {
          return {
            stream: (async function* () {
              for (const c of chunks) yield c;
            })(),
            response: Promise.resolve({ usageMetadata }),
          };
        }),
      };
      const mock = { getGenerativeModel: vi.fn(() => modelInstance) };
      const client = wrap(mock);
      const model = client.getGenerativeModel({ model: "gemini-2.0-flash" });
      const result = await model.generateContentStream("hi");
      // Draining the wrapped stream causes the record to be written
      for await (const _chunk of result.stream as AsyncIterable<unknown>) {
        // drain
      }
      const records = await getRecorder(client)!.flush();
      expect(records).toHaveLength(1);
      expect(records[0]?.promptTokens).toBe(30);
      expect(records[0]?.completionTokens).toBe(10);
      expect(records[0]?.totalTokens).toBe(40);
    });
  });

  describe("Gemini new SDK @google/genai (H-3)", () => {
    it("client.models.generateContent を hook (= response.usageMetadata 直 access)", async () => {
      const generateContent = vi.fn(async () => ({
        text: "ok",
        usageMetadata: {
          promptTokenCount: 25,
          candidatesTokenCount: 12,
          totalTokenCount: 37,
        },
      }));
      const mock = { models: { generateContent } };
      const client = wrap(mock, { tags: { v: "newgenai" } });
      await client.models.generateContent({
        model: "gemini-2.0-flash",
        contents: "hi",
      });
      const records = await getRecorder(client)!.flush();
      expect(records).toHaveLength(1);
      expect(records[0]?.provider).toBe("gemini");
      expect(records[0]?.model).toBe("gemini-2.0-flash");
      expect(records[0]?.promptTokens).toBe(25);
      expect(records[0]?.completionTokens).toBe(12);
      expect(records[0]?.totalTokens).toBe(37);
    });

    it("client.models.generateContentStream は AsyncGenerator wrap で record", async () => {
      const chunks = [
        { text: "h", usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 1 } },
        { text: "i", usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2, totalTokenCount: 12 } },
      ];
      const generateContentStream = vi.fn(async () => {
        return (async function* () {
          for (const c of chunks) yield c;
        })();
      });
      const mock = {
        models: {
          generateContent: vi.fn(),
          generateContentStream,
        },
      };
      const client = wrap(mock);
      const stream = await client.models.generateContentStream({
        model: "gemini-2.0-flash",
        contents: "hi",
      });
      for await (const _chunk of stream as AsyncIterable<unknown>) {
        // drain
      }
      const records = await getRecorder(client)!.flush();
      expect(records).toHaveLength(1);
      expect(records[0]?.promptTokens).toBe(10);
      expect(records[0]?.completionTokens).toBe(2);
      expect(records[0]?.totalTokens).toBe(12);
    });

    it("@google/genai stream init error も record + rethrow", async () => {
      const generateContentStream = vi.fn(async () => {
        throw new Error("genai stream init failed");
      });
      const mock = {
        models: {
          generateContent: vi.fn(),
          generateContentStream,
        },
      };
      const client = wrap(mock);
      await expect(
        client.models.generateContentStream({
          model: "gemini-2.0-flash",
          contents: "x",
        }),
      ).rejects.toThrow("genai stream init failed");
      const records = await getRecorder(client)!.flush();
      expect(records).toHaveLength(1);
      expect(records[0]?.error).toBe("genai stream init failed");
    });

    it("L-2: @google/genai stream 途中 throw も 部分 usage + error record", async () => {
      const mock = {
        models: {
          generateContent: vi.fn(),
          generateContentStream: vi.fn(async () => {
            return (async function* () {
              yield {
                text: "h",
                usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 1 },
              };
              throw new Error("genai mid-stream error");
            })();
          }),
        },
      };
      const client = wrap(mock);
      const stream = await client.models.generateContentStream({
        model: "gemini-2.0-flash",
        contents: "x",
      });
      await expect(
        (async () => {
          for await (const _chunk of stream as AsyncIterable<unknown>) {
            // drain until throw
          }
        })(),
      ).rejects.toThrow("genai mid-stream error");
      const records = await getRecorder(client)!.flush();
      expect(records).toHaveLength(1);
      expect(records[0]?.error).toBe("genai mid-stream error");
      expect(records[0]?.promptTokens).toBe(5);
      expect(records[0]?.completionTokens).toBe(1);
    });

    it("L-2: legacy generateContentStream で response Promise reject も record", async () => {
      const modelInstance = {
        generateContent: vi.fn(),
        generateContentStream: vi.fn(async () => {
          return {
            stream: (async function* () {
              yield { text: () => "h" };
            })(),
            response: Promise.reject(new Error("response promise rejected")),
          };
        }),
      };
      const mock = { getGenerativeModel: vi.fn(() => modelInstance) };
      const client = wrap(mock);
      const model = client.getGenerativeModel({ model: "gemini-2.0-flash" });
      const result = await model.generateContentStream("hi");
      await expect(
        (async () => {
          for await (const _chunk of result.stream as AsyncIterable<unknown>) {
            // drain triggers response.await on completion
          }
        })(),
      ).rejects.toThrow("response promise rejected");
      const records = await getRecorder(client)!.flush();
      expect(records).toHaveLength(1);
      expect(records[0]?.error).toBe("response promise rejected");
    });
  });

  describe("Gemini", () => {
    function makeGeminiMock(
      usageMetadata: {
        promptTokenCount: number;
        candidatesTokenCount: number;
        totalTokenCount: number;
      },
      shouldThrow = false,
    ) {
      const generateContent = vi.fn(async () => {
        if (shouldThrow) throw new Error("gemini mock error");
        return {
          response: {
            text: () => "ok",
            usageMetadata,
          },
        };
      });
      const modelInstance = { generateContent };
      const getGenerativeModel = vi.fn(({ model: _m }: { model: string }) => modelInstance);
      return { getGenerativeModel, _modelInstance: modelInstance };
    }

    it("getGenerativeModel().generateContent を hook (= usageMetadata 取得)", async () => {
      const mock = makeGeminiMock({
        promptTokenCount: 40,
        candidatesTokenCount: 20,
        totalTokenCount: 60,
      });
      const client = wrap(mock, { tags: { v: "gemini" } });
      const model = client.getGenerativeModel({ model: "gemini-2.0-flash" });
      await model.generateContent("hi");
      const records = await getRecorder(client)!.flush();
      expect(records).toHaveLength(1);
      expect(records[0]?.provider).toBe("gemini");
      expect(records[0]?.model).toBe("gemini-2.0-flash");
      expect(records[0]?.promptTokens).toBe(40);
      expect(records[0]?.completionTokens).toBe(20);
      expect(records[0]?.totalTokens).toBe(60);
      expect(records[0]?.costUsd).toBeGreaterThan(0);
    });

    it("Gemini API error 時も record + rethrow", async () => {
      const mock = makeGeminiMock(
        { promptTokenCount: 0, candidatesTokenCount: 0, totalTokenCount: 0 },
        true,
      );
      const client = wrap(mock);
      const model = client.getGenerativeModel({ model: "gemini-2.0-flash" });
      await expect(model.generateContent("x")).rejects.toThrow("gemini mock error");
      const records = await getRecorder(client)!.flush();
      expect(records).toHaveLength(1);
      expect(records[0]?.error).toBe("gemini mock error");
      expect(records[0]?.provider).toBe("gemini");
    });

    it("複数 model instance を 1 GoogleGenAI client から取得しても全 record される", async () => {
      const usage = {
        promptTokenCount: 10,
        candidatesTokenCount: 5,
        totalTokenCount: 15,
      };
      const generateContent1 = vi.fn(async () => ({
        response: { text: () => "a", usageMetadata: usage },
      }));
      const generateContent2 = vi.fn(async () => ({
        response: { text: () => "b", usageMetadata: usage },
      }));
      const instances: Record<string, { generateContent: typeof generateContent1 }> = {
        "gemini-2.0-flash": { generateContent: generateContent1 },
        "gemini-2.0-pro": { generateContent: generateContent2 },
      };
      const mock = {
        getGenerativeModel: vi.fn(({ model: m }: { model: string }) => instances[m]!),
      };
      const client = wrap(mock);
      const m1 = client.getGenerativeModel({ model: "gemini-2.0-flash" });
      const m2 = client.getGenerativeModel({ model: "gemini-2.0-pro" });
      await m1.generateContent("a");
      await m2.generateContent("b");
      const records = await getRecorder(client)!.flush();
      expect(records).toHaveLength(2);
      expect(records.map((r) => r.model).sort()).toEqual([
        "gemini-2.0-flash",
        "gemini-2.0-pro",
      ]);
    });
  });

  describe("streaming", () => {
    function makeStreamMock(chunks: Array<Record<string, unknown>>, shouldThrow = false) {
      const create = vi.fn(async (_args: unknown) => {
        if (shouldThrow) throw new Error("stream init failed");
        return (async function* (): AsyncGenerator<Record<string, unknown>> {
          for (const chunk of chunks) {
            yield chunk;
          }
        })();
      });
      return { chat: { completions: { create } } };
    }

    it("stream:true で AsyncIterable を pass-through + 最終 chunk で record", async () => {
      const chunks = [
        { model: "gpt-5.5", choices: [{ delta: { content: "h" } }] },
        { choices: [{ delta: { content: "i" } }] },
        {
          choices: [{ delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
        },
      ];
      const mock = makeStreamMock(chunks);
      const client = wrap(mock);
      const stream = await client.chat.completions.create({
        model: "gpt-5.5",
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      });
      const collected: Array<Record<string, unknown>> = [];
      for await (const chunk of stream as AsyncIterable<Record<string, unknown>>) {
        collected.push(chunk);
      }
      expect(collected).toHaveLength(3);
      const records = await getRecorder(client)!.flush();
      expect(records).toHaveLength(1);
      expect(records[0]?.promptTokens).toBe(10);
      expect(records[0]?.completionTokens).toBe(2);
      expect(records[0]?.totalTokens).toBe(12);
      expect(records[0]?.error).toBeUndefined();
    });

    it("stream 途中で error 発生 = 部分 token + error を record + rethrow", async () => {
      const mock = {
        chat: {
          completions: {
            create: vi.fn(async () => {
              return (async function* (): AsyncGenerator<Record<string, unknown>> {
                yield { model: "gpt-5.5", choices: [{ delta: { content: "h" } }] };
                throw new Error("stream broken");
              })();
            }),
          },
        },
      };
      const client = wrap(mock);
      const stream = await client.chat.completions.create({
        model: "gpt-5.5",
        stream: true,
        messages: [{ role: "user", content: "x" }],
      });
      const collected: Array<Record<string, unknown>> = [];
      await expect(
        (async () => {
          for await (const chunk of stream as AsyncIterable<Record<string, unknown>>) {
            collected.push(chunk);
          }
        })(),
      ).rejects.toThrow("stream broken");
      expect(collected).toHaveLength(1);
      const records = await getRecorder(client)!.flush();
      expect(records).toHaveLength(1);
      expect(records[0]?.error).toBe("stream broken");
    });
  });
});

// Automatically captures the provider's native end-user identifier into the
// userId tag (zero-config per-user aggregation on the dashboard /users page).
describe("エンドユーザー識別子の自動取得 (captureUserId)", () => {
  function makeAnthropicMock() {
    const create = vi.fn(async () => ({
      id: "msg_u",
      model: "claude-opus-4-8",
      usage: { input_tokens: 10, output_tokens: 5 },
      content: [{ type: "text", text: "ok" }],
    }));
    return { messages: { create }, _create: create };
  }

  it("OpenAI safety_identifier を userId タグに自動取得する", async () => {
    const client = wrap(makeMockOpenAI(baseResponse));
    await client.chat.completions.create({
      model: "gpt-5.5",
      messages: [{ role: "user", content: "hi" }],
      safety_identifier: "user_hash_abc",
    });
    const records = await getRecorder(client)!.flush();
    expect(records[0]?.tags.userId).toBe("user_hash_abc");
  });

  it("OpenAI 旧 user パラメータは PII 懸念のため自動取得しない", async () => {
    const client = wrap(makeMockOpenAI(baseResponse));
    await client.chat.completions.create({
      model: "gpt-5.5",
      messages: [{ role: "user", content: "hi" }],
      user: "legacy_user_1",
    });
    const records = await getRecorder(client)!.flush();
    expect(records[0]?.tags.userId).toBeUndefined();
  });

  it("safety_identifier は採用し、 旧 user は無視する", async () => {
    const client = wrap(makeMockOpenAI(baseResponse));
    await client.chat.completions.create({
      model: "gpt-5.5",
      messages: [{ role: "user", content: "hi" }],
      safety_identifier: "preferred",
      user: "legacy",
    });
    const records = await getRecorder(client)!.flush();
    expect(records[0]?.tags.userId).toBe("preferred");
  });

  it("明示の tags.userId は自動取得より優先される (= 上書きしない)", async () => {
    const client = wrap(makeMockOpenAI(baseResponse), {
      tags: { userId: "explicit_id" },
    });
    await client.chat.completions.create({
      model: "gpt-5.5",
      messages: [{ role: "user", content: "hi" }],
      safety_identifier: "native_id",
    });
    const records = await getRecorder(client)!.flush();
    expect(records[0]?.tags.userId).toBe("explicit_id");
  });

  it("captureUserId: false で自動取得を無効化できる", async () => {
    const client = wrap(makeMockOpenAI(baseResponse), { captureUserId: false });
    await client.chat.completions.create({
      model: "gpt-5.5",
      messages: [{ role: "user", content: "hi" }],
      safety_identifier: "should_not_capture",
    });
    const records = await getRecorder(client)!.flush();
    expect(records[0]?.tags.userId).toBeUndefined();
  });

  it("ネイティブ項目が無い call では userId タグを付けない", async () => {
    const client = wrap(makeMockOpenAI(baseResponse));
    await client.chat.completions.create({
      model: "gpt-5.5",
      messages: [{ role: "user", content: "hi" }],
    });
    const records = await getRecorder(client)!.flush();
    expect(records[0]?.tags.userId).toBeUndefined();
  });

  it("OpenAI では Anthropic 用の metadata.user_id を拾わない (provider 限定)", async () => {
    const client = wrap(makeMockOpenAI(baseResponse));
    await client.chat.completions.create({
      model: "gpt-5.5",
      messages: [{ role: "user", content: "hi" }],
      metadata: { user_id: "ant_field_on_openai" },
    });
    const records = await getRecorder(client)!.flush();
    expect(records[0]?.tags.userId).toBeUndefined();
  });

  it("Anthropic metadata.user_id を userId タグに自動取得する", async () => {
    const client = wrap(makeAnthropicMock());
    await client.messages.create({
      model: "claude-opus-4-8",
      max_tokens: 64,
      messages: [{ role: "user", content: "hi" }],
      metadata: { user_id: "ant_user_9" },
    });
    const records = await getRecorder(client)!.flush();
    expect(records[0]?.tags.userId).toBe("ant_user_9");
  });

  it("256 文字を超える識別子は丸める", async () => {
    const client = wrap(makeMockOpenAI(baseResponse));
    await client.chat.completions.create({
      model: "gpt-5.5",
      messages: [{ role: "user", content: "hi" }],
      safety_identifier: "x".repeat(300),
    });
    const records = await getRecorder(client)!.flush();
    expect(records[0]?.tags.userId?.length).toBe(256);
  });

  it("API error の record にも自動取得した userId が carry される", async () => {
    const client = wrap(makeMockOpenAI(baseResponse, true));
    await expect(
      client.chat.completions.create({
        model: "gpt-5.5",
        messages: [{ role: "user", content: "hi" }],
        safety_identifier: "err_user",
      }),
    ).rejects.toThrow("mock api error");
    const records = await getRecorder(client)!.flush();
    expect(records[0]?.tags.userId).toBe("err_user");
  });

  it("stream は wrapper 入口で確定した userId を使う (消費前の request 変更に影響されない)", async () => {
    const events = [
      {
        model: "gpt-5.5",
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        choices: [{ delta: { content: "hi" } }],
      },
    ];
    const mock = {
      chat: {
        completions: {
          create: vi.fn(async () =>
            (async function* (): AsyncGenerator<Record<string, unknown>> {
              for (const e of events) yield e;
            })(),
          ),
        },
      },
    };
    const client = wrap(mock);
    const req: Record<string, unknown> = {
      model: "gpt-5.5",
      messages: [{ role: "user", content: "x" }],
      stream: true,
      safety_identifier: "user_A",
    };
    const stream = await client.chat.completions.create(req);
    // Even if the caller mutates the same request object before consumption starts, the entry-time value is used
    req.safety_identifier = "user_B";
    for await (const _chunk of stream as AsyncIterable<unknown>) {
      // drain
    }
    const records = await getRecorder(client)!.flush();
    expect(records[0]?.tags.userId).toBe("user_A");
  });
});

// OpenAI streaming token undercount fix + record-once on early break (found in review, 2026-06-28).
describe("audit 2026-06-28: OpenAI streaming usage capture", () => {
  function makeOpenAiStreamMock(chunks: Record<string, unknown>[]) {
    const calls: Record<string, unknown>[] = [];
    const mock = {
      chat: {
        completions: {
          create: vi.fn(async (args: Record<string, unknown>) => {
            calls.push(args);
            if (args.stream !== true) return { model: "gpt-5.5", usage: {}, choices: [] };
            return (async function* (): AsyncGenerator<Record<string, unknown>> {
              for (const c of chunks) yield c;
            })();
          }),
        },
      },
      _calls: calls,
    };
    return mock;
  }

  it("stream:true で stream_options.include_usage を自動注入する", async () => {
    const mock = makeOpenAiStreamMock([{ choices: [{ delta: { content: "hi" } }] }]);
    const client = wrap(mock);
    const stream = await client.chat.completions.create({
      model: "gpt-5.5",
      stream: true,
      messages: [{ role: "user", content: "x" }],
    });
    for await (const _c of stream as AsyncIterable<unknown>) {
      void _c;
    }
    const passed = mock._calls[0] as { stream_options?: { include_usage?: boolean } };
    expect(passed.stream_options?.include_usage).toBe(true);
  });

  it("caller が include_usage:false を明示したら尊重する", async () => {
    const mock = makeOpenAiStreamMock([{ choices: [{ delta: { content: "hi" } }] }]);
    const client = wrap(mock);
    const stream = await client.chat.completions.create({
      model: "gpt-5.5",
      stream: true,
      stream_options: { include_usage: false },
      messages: [{ role: "user", content: "x" }],
    });
    for await (const _c of stream as AsyncIterable<unknown>) {
      void _c;
    }
    const passed = mock._calls[0] as { stream_options?: { include_usage?: boolean } };
    expect(passed.stream_options?.include_usage).toBe(false);
  });

  it("非 stream には stream_options を足さない", async () => {
    const mock = makeOpenAiStreamMock([]);
    const client = wrap(mock);
    await client.chat.completions.create({
      model: "gpt-5.5",
      messages: [{ role: "user", content: "x" }],
    });
    const passed = mock._calls[0] as { stream_options?: unknown };
    expect(passed.stream_options).toBeUndefined();
  });

  it("早期 break でも観測済みトークンで record を 1 件だけ残す", async () => {
    const chunks = [
      { model: "gpt-5.5", choices: [{ delta: { content: "a" } }] },
      { model: "gpt-5.5", choices: [{ delta: { content: "b" } }] },
      { model: "gpt-5.5", usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }, choices: [] },
    ];
    const mock = makeOpenAiStreamMock(chunks);
    const client = wrap(mock);
    const stream = await client.chat.completions.create({
      model: "gpt-5.5",
      stream: true,
      messages: [{ role: "user", content: "x" }],
    });
    let seen = 0;
    for await (const _c of stream as AsyncIterable<unknown>) {
      void _c;
      seen++;
      if (seen === 1) break;
    }
    const records = await getRecorder(client)!.flush();
    expect(records).toHaveLength(1);
  });
});

describe("audit 2026-06-28: injected usage chunk is not yielded to host", () => {
  it("注入した usage-only チャンク(choices 空)は host に渡さず、 usage は record に反映する", async () => {
    const chunks = [
      { model: "gpt-5.5", choices: [{ delta: { content: "a" } }] },
      { model: "gpt-5.5", choices: [{ delta: { content: "b" } }] },
      { model: "gpt-5.5", usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 }, choices: [] },
    ];
    const calls: Record<string, unknown>[] = [];
    const mock = {
      chat: {
        completions: {
          create: vi.fn(async (args: Record<string, unknown>) => {
            calls.push(args);
            return (async function* (): AsyncGenerator<Record<string, unknown>> {
              for (const c of chunks) yield c;
            })();
          }),
        },
      },
    };
    const client = wrap(mock);
    const stream = await client.chat.completions.create({
      model: "gpt-5.5",
      stream: true,
      messages: [{ role: "user", content: "x" }],
    });
    const yielded: unknown[] = [];
    for await (const c of stream as AsyncIterable<unknown>) yielded.push(c);
    // Because the SDK injected it, the usage-only chunk is invisible to the consumer (only the 2 content chunks).
    expect(yielded).toHaveLength(2);
    // The usage is still reflected in the record.
    const records = await getRecorder(client)!.flush();
    expect(records).toHaveLength(1);
    expect(records[0]?.promptTokens).toBe(100);
    expect(records[0]?.completionTokens).toBe(20);
  });

  it("caller が include_usage を明示したら usage チャンクも host に渡す", async () => {
    const chunks = [
      { model: "gpt-5.5", choices: [{ delta: { content: "a" } }] },
      { model: "gpt-5.5", usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 }, choices: [] },
    ];
    const mock = {
      chat: {
        completions: {
          create: vi.fn(async () =>
            (async function* (): AsyncGenerator<Record<string, unknown>> {
              for (const c of chunks) yield c;
            })(),
          ),
        },
      },
    };
    const client = wrap(mock);
    const stream = await client.chat.completions.create({
      model: "gpt-5.5",
      stream: true,
      stream_options: { include_usage: true },
      messages: [{ role: "user", content: "x" }],
    });
    const yielded: unknown[] = [];
    for await (const c of stream as AsyncIterable<unknown>) yielded.push(c);
    // When the caller set it themselves, all chunks pass through as before.
    expect(yielded).toHaveLength(2);
  });
});
