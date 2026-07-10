import { describe, it, expect, vi } from "vitest";

import { argosvixMiddleware } from "../aiSdkMiddleware.js";
import { getRecorder } from "../client.js";
import { flushClient } from "../flush.js";

/**
 * Vercel AI SDK integration (argosvixMiddleware). Verifies that wrapGenerate /
 * wrapStream normalize the provider correctly, emit exactly one record from
 * usage (cost / tokens / TTFT / cache / reasoning), and pass the original
 * result through untouched.
 */

function model(provider: string, modelId = "gpt-5.5") {
  return { provider, modelId };
}

function streamFrom(parts: unknown[]): ReadableStream<unknown> {
  return new ReadableStream({
    start(controller) {
      for (const p of parts) controller.enqueue(p);
      controller.close();
    },
  });
}

async function drain(stream: ReadableStream<unknown>): Promise<unknown[]> {
  const out: unknown[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out.push(value);
  }
  return out;
}

describe("argosvixMiddleware: wrapGenerate", () => {
  it("成功 call で record を 1 件残す (provider 寄せ + cost + tokens)", async () => {
    const mw = argosvixMiddleware({ tags: { service: "ai-sdk" } });
    const result = await mw.wrapGenerate({
      model: model("openai.chat"),
      params: { prompt: "hi" },
      doGenerate: async () => ({
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
        response: { modelId: "gpt-5.5" },
      }),
    });
    // Original result passes through
    expect((result as { response?: { modelId?: string } }).response?.modelId).toBe("gpt-5.5");
    const records = await mw.recorder.flush();
    expect(records).toHaveLength(1);
    const r = records[0]!;
    expect(r.provider).toBe("openai");
    expect(r.model).toBe("gpt-5.5");
    expect(r.promptTokens).toBe(100);
    expect(r.completionTokens).toBe(50);
    expect(r.totalTokens).toBe(150);
    expect(r.costUsd).toBeGreaterThan(0);
    expect(r.tags.service).toBe("ai-sdk");
    expect(r.error).toBeUndefined();
  });

  it("error 時も record を残し rethrow する", async () => {
    const mw = argosvixMiddleware({});
    await expect(
      mw.wrapGenerate({
        model: model("anthropic.messages"),
        params: {},
        doGenerate: async () => {
          throw new Error("boom");
        },
      }),
    ).rejects.toThrow("boom");
    const records = await mw.recorder.flush();
    expect(records).toHaveLength(1);
    expect(records[0]?.provider).toBe("anthropic");
    expect(records[0]?.error).toBe("boom");
    expect(records[0]?.costUsd).toBe(0);
  });

  it("サポート外 provider は記録せず素通り + 1 回だけ警告", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const mw = argosvixMiddleware({});
    const out = await mw.wrapGenerate({
      model: model("cohere.chat"),
      params: {},
      doGenerate: async () => ({ usage: { inputTokens: 10, outputTokens: 5 } }),
    });
    expect((out as { usage?: unknown }).usage).toBeDefined();
    const records = await mw.recorder.flush();
    expect(records).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("cohere.chat"));
    warn.mockRestore();
  });

  it("provider 文字列を 4 種へ正しく寄せる", async () => {
    const cases: Array<[string, string]> = [
      ["openai.chat", "openai"],
      ["azure.openai", "openai"],
      ["anthropic.messages", "anthropic"],
      ["google.generative-ai", "gemini"],
      ["google.vertex", "gemini"],
      ["mistral.chat", "mistral"],
    ];
    for (const [raw, expected] of cases) {
      const mw = argosvixMiddleware({});
      await mw.wrapGenerate({
        model: model(raw),
        params: {},
        doGenerate: async () => ({ usage: { inputTokens: 1, outputTokens: 1 } }),
      });
      const records = await mw.recorder.flush();
      expect(records[0]?.provider).toBe(expected);
    }
  });

  it("config.provider 明示でサポート外 provider でも記録する", async () => {
    const mw = argosvixMiddleware({ provider: "openai" });
    await mw.wrapGenerate({
      model: model("groq.chat"),
      params: {},
      doGenerate: async () => ({ usage: { inputTokens: 10, outputTokens: 5 } }),
    });
    const records = await mw.recorder.flush();
    expect(records).toHaveLength(1);
    expect(records[0]?.provider).toBe("openai");
  });

  it('"openai-compatible" 等の紛らわしい provider は誤って openai に寄せない', async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const mw = argosvixMiddleware({});
    await mw.wrapGenerate({
      model: model("openai-compatible.chat"),
      params: {},
      doGenerate: async () => ({ usage: { inputTokens: 1, outputTokens: 1 } }),
    });
    const records = await mw.recorder.flush();
    expect(records).toHaveLength(0);
    warn.mockRestore();
  });

  it("trace 軸 (traceId/spanId) + requestMeta を carry する", async () => {
    const mw = argosvixMiddleware({ traceId: "tr_1", sessionId: "se_1" });
    await mw.wrapGenerate({
      model: model("openai.chat"),
      params: { prompt: [{ role: "user" }], temperature: 0.5, maxOutputTokens: 256 },
      doGenerate: async () => ({ usage: { inputTokens: 10, outputTokens: 5 } }),
    });
    const r = (await mw.recorder.flush())[0]!;
    expect(r.traceId).toBe("tr_1");
    expect(typeof r.spanId).toBe("string");
    expect(r.sessionId).toBe("se_1");
    expect(r.requestMeta?.messagesCount).toBe(1);
    expect(r.requestMeta?.temperature).toBe(0.5);
    expect(r.requestMeta?.maxTokens).toBe(256);
  });

  it("新形式の cache / reasoning 内訳を記録する", async () => {
    const mw = argosvixMiddleware({});
    await mw.wrapGenerate({
      model: model("openai.chat", "gpt-5.5"),
      params: {},
      doGenerate: async () => ({
        usage: {
          inputTokens: 1000,
          outputTokens: 200,
          totalTokens: 1200,
          inputTokenDetails: { cacheReadTokens: 400 },
          outputTokenDetails: { reasoningTokens: 80 },
        },
      }),
    });
    const records = await mw.recorder.flush();
    const r = records[0]!;
    expect(r.cachedReadTokens).toBe(400);
    expect(r.reasoningTokens).toBe(80);
  });

  it("旧形式の cachedInputTokens / reasoningTokens も読む", async () => {
    const mw = argosvixMiddleware({});
    await mw.wrapGenerate({
      model: model("openai.chat"),
      params: {},
      doGenerate: async () => ({
        usage: {
          inputTokens: 500,
          outputTokens: 100,
          cachedInputTokens: 200,
          reasoningTokens: 30,
        },
      }),
    });
    const r = (await mw.recorder.flush())[0]!;
    expect(r.cachedReadTokens).toBe(200);
    expect(r.reasoningTokens).toBe(30);
  });

  it("ai@7 のオブジェクト形状 usage を正規化して記録する", async () => {
    const mw = argosvixMiddleware({});
    await mw.wrapGenerate({
      model: model("openai.chat", "gpt-5.5"),
      params: {},
      doGenerate: async () => ({
        usage: {
          inputTokens: { total: 1000, noCache: 600, cacheRead: 400 },
          outputTokens: { total: 200, text: 120, reasoning: 80 },
          totalTokens: 1200,
          raw: { prompt_tokens: 1000, completion_tokens: 200 },
        },
      }),
    });
    const r = (await mw.recorder.flush())[0]!;
    expect(r.promptTokens).toBe(1000);
    expect(r.completionTokens).toBe(200);
    expect(r.totalTokens).toBe(1200); // must not become "[object Object][object Object]"
    expect(r.cachedReadTokens).toBe(400);
    expect(r.reasoningTokens).toBe(80);
    expect(typeof r.costUsd).toBe("number");
    expect(Number.isFinite(r.costUsd)).toBe(true);
    expect(r.costUsd).toBeGreaterThan(0);
  });

  it("ai@7 で cacheWrite を持つ provider (Anthropic 等) の内訳も読む", async () => {
    const mw = argosvixMiddleware({});
    await mw.wrapGenerate({
      model: model("anthropic.messages", "claude-fable-5"),
      params: {},
      doGenerate: async () => ({
        usage: {
          inputTokens: { total: 500, noCache: 100, cacheRead: 300, cacheWrite: 100 },
          outputTokens: { total: 50, text: 50, reasoning: 0 },
        },
      }),
    });
    const r = (await mw.recorder.flush())[0]!;
    expect(r.promptTokens).toBe(500);
    expect(r.completionTokens).toBe(50);
    expect(r.totalTokens).toBe(550);
    expect(r.cachedReadTokens).toBe(300);
    expect(r.cachedWriteTokens).toBe(100);
    expect(r.reasoningTokens).toBeUndefined(); // 0 is treated as unset
  });

  it("ai@7 で total 欠落時は内訳の和に fallback する", async () => {
    const mw = argosvixMiddleware({});
    await mw.wrapGenerate({
      model: model("openai.chat"),
      params: {},
      doGenerate: async () => ({
        usage: {
          inputTokens: { noCache: 60, cacheRead: 40 },
          outputTokens: { text: 15, reasoning: 5 },
        },
      }),
    });
    const r = (await mw.recorder.flush())[0]!;
    expect(r.promptTokens).toBe(100);
    expect(r.completionTokens).toBe(20);
    expect(r.totalTokens).toBe(120);
  });

  it("旧 v4 系 (promptTokens/completionTokens 命名) も読む", async () => {
    const mw = argosvixMiddleware({});
    await mw.wrapGenerate({
      model: model("openai.chat"),
      params: {},
      doGenerate: async () => ({
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      }),
    });
    const r = (await mw.recorder.flush())[0]!;
    expect(r.promptTokens).toBe(10);
    expect(r.completionTokens).toBe(5);
    expect(r.totalTokens).toBe(15);
  });

  it("未知形状の usage は 0 に defensive fallback する (NaN / 文字列連結を出さない)", async () => {
    const mw = argosvixMiddleware({});
    await mw.wrapGenerate({
      model: model("openai.chat"),
      params: {},
      doGenerate: async () => ({
        usage: {
          inputTokens: "many" as unknown as number,
          outputTokens: { unexpected: true } as unknown as number,
          totalTokens: Number.NaN,
        },
      }),
    });
    const r = (await mw.recorder.flush())[0]!;
    expect(r.promptTokens).toBe(0);
    expect(r.completionTokens).toBe(0);
    expect(r.totalTokens).toBe(0);
    expect(Number.isFinite(r.costUsd)).toBe(true);
  });
});

describe("argosvixMiddleware: wrapStream", () => {
  it("stream を透過しつつ finish の usage で record を 1 件残す + TTFT", async () => {
    const mw = argosvixMiddleware({});
    const parts = [
      { type: "stream-start" },
      { type: "response-metadata", modelId: "gpt-5.5" },
      { type: "text-delta", delta: "he" },
      { type: "text-delta", delta: "llo" },
      { type: "finish", finishReason: "stop", usage: { inputTokens: 80, outputTokens: 20, totalTokens: 100 } },
    ];
    const { stream } = await mw.wrapStream({
      model: model("openai.chat"),
      params: {},
      doStream: async () => ({ stream: streamFrom(parts) as ReadableStream<never> }),
    });
    const passed = await drain(stream);
    // All parts pass through
    expect(passed).toHaveLength(parts.length);
    expect((passed[2] as { delta?: string }).delta).toBe("he");
    const records = await mw.recorder.flush();
    expect(records).toHaveLength(1);
    const r = records[0]!;
    expect(r.provider).toBe("openai");
    expect(r.model).toBe("gpt-5.5");
    expect(r.promptTokens).toBe(80);
    expect(r.completionTokens).toBe(20);
    expect(r.costUsd).toBeGreaterThan(0);
    expect(typeof r.ttftMs).toBe("number");
  });

  it("ai@7 のオブジェクト形状 usage を finish パートから正規化して記録する", async () => {
    const mw = argosvixMiddleware({});
    const parts = [
      { type: "stream-start" },
      { type: "text-delta", delta: "hi" },
      {
        type: "finish",
        finishReason: "stop",
        usage: {
          inputTokens: { total: 800, noCache: 500, cacheRead: 300 },
          outputTokens: { total: 60, text: 40, reasoning: 20 },
          totalTokens: 860,
          raw: { prompt_tokens: 800, completion_tokens: 60 },
        },
      },
    ];
    const { stream } = await mw.wrapStream({
      model: model("openai.chat"),
      params: {},
      doStream: async () => ({ stream: streamFrom(parts) as ReadableStream<never> }),
    });
    const passed = await drain(stream);
    expect(passed).toHaveLength(parts.length);
    const r = (await mw.recorder.flush())[0]!;
    expect(r.promptTokens).toBe(800);
    expect(r.completionTokens).toBe(60);
    expect(r.totalTokens).toBe(860);
    expect(r.cachedReadTokens).toBe(300);
    expect(r.reasoningTokens).toBe(20);
    expect(Number.isFinite(r.costUsd)).toBe(true);
    expect(r.costUsd).toBeGreaterThan(0);
  });

  it("消費中(mid-stream)のエラーも error record として残す", async () => {
    const mw = argosvixMiddleware({});
    let i = 0;
    const parts = [
      { type: "text-delta", delta: "a" },
      { type: "text-delta", delta: "b" },
    ];
    const errorStream = new ReadableStream({
      pull(controller) {
        if (i < parts.length) controller.enqueue(parts[i++]);
        else controller.error(new Error("mid-stream boom"));
      },
    });
    const { stream } = await mw.wrapStream({
      model: model("openai.chat"),
      params: {},
      doStream: async () => ({ stream: errorStream as ReadableStream<never> }),
    });
    await expect(drain(stream)).rejects.toThrow("mid-stream boom");
    const records = await mw.recorder.flush();
    expect(records).toHaveLength(1);
    expect(records[0]?.error).toBe("mid-stream boom");
  });

  it("stream 初期化失敗も error record として残す", async () => {
    const mw = argosvixMiddleware({});
    await expect(
      mw.wrapStream({
        model: model("mistral.chat"),
        params: {},
        doStream: async () => {
          throw new Error("stream init failed");
        },
      }),
    ).rejects.toThrow("stream init failed");
    const records = await mw.recorder.flush();
    expect(records).toHaveLength(1);
    expect(records[0]?.provider).toBe("mistral");
    expect(records[0]?.error).toBe("stream init failed");
  });
});

describe("argosvixMiddleware: flush 統合", () => {
  it("flushClient(middleware) / getRecorder(middleware) が動く", async () => {
    const mw = argosvixMiddleware({});
    expect(getRecorder(mw)).toBe(mw.recorder);
    await mw.wrapGenerate({
      model: model("openai.chat"),
      params: {},
      doGenerate: async () => ({ usage: { inputTokens: 5, outputTokens: 5 } }),
    });
    // No apiKey is configured, so flushClient drains the buffer without POSTing (and does not throw).
    await expect(flushClient(mw)).resolves.toBeUndefined();
    expect(mw.recorder.getBufferSize()).toBe(0);
  });
});
