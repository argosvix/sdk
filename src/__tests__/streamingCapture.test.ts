import { describe, it, expect, vi } from "vitest";

import { wrap, getRecorder } from "../client.js";
import { INGEST_MAX_BODY_UNITS } from "../recorder.js";
import type { LlmCallRecord } from "../types.js";

/**
 * Streaming plaintext capture tests.
 *
 * promptBody = entry snapshot; completionBody = text deltas accumulated in the
 * existing stream wrapper (256KB cap + truncated marker). Redaction rides on
 * the blanket application at Recorder flush. Pins each provider's happy path /
 * cap overflow / mid-stream exception / captureContent disabled / redaction.
 */

const TRUNCATED = "…[truncated]";

async function* asyncIterOf<T>(items: T[]): AsyncGenerator<T> {
  for (const item of items) yield item;
}

// --- OpenAI Chat ------------------------------------------------------------

function oaChunk(text: string): unknown {
  return { model: "gpt-5.5", choices: [{ delta: { content: text } }] };
}

const oaUsageChunk = {
  model: "gpt-5.5",
  usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
  choices: [],
};

function openAIClientWith(chunks: unknown[]) {
  const create = vi.fn(async () => asyncIterOf(chunks));
  return { chat: { completions: { create } } };
}

async function drain(stream: unknown): Promise<void> {
  for await (const _chunk of stream as AsyncIterable<unknown>) {
    // drain
  }
}

describe("streaming capture: OpenAI Chat", () => {
  const messages = [{ role: "user", content: "hi" }];

  it("正常系: delta 3 片を結合して completionBody、promptBody は入口 snapshot", async () => {
    const client = wrap(openAIClientWith([oaChunk("Hel"), oaChunk("lo "), oaChunk("world"), oaUsageChunk]), {
      captureContent: true,
    });
    const stream = await client.chat.completions.create({
      model: "gpt-5.5",
      messages,
      stream: true,
    });
    await drain(stream);
    const records = await getRecorder(client)!.flush();
    expect(records).toHaveLength(1);
    expect(records[0]!.promptBody).toBe(JSON.stringify(messages));
    expect(records[0]!.completionBody).toBe("Hello world");
    // Usage aggregation is unchanged (accumulation does not break the existing finalize)
    expect(records[0]!.promptTokens).toBe(10);
    expect(records[0]!.completionTokens).toBe(3);
  });

  it("captureContent 無効(未指定)では promptBody / completionBody を付与しない", async () => {
    const client = wrap(openAIClientWith([oaChunk("Hello"), oaUsageChunk]));
    const stream = await client.chat.completions.create({
      model: "gpt-5.5",
      messages,
      stream: true,
    });
    await drain(stream);
    const records = await getRecorder(client)!.flush();
    expect(records[0]!.promptBody).toBeUndefined();
    expect(records[0]!.completionBody).toBeUndefined();
  });

  it("上限超過: 蓄積は 256KB(メモリ防御)、flush される record は ingest 上限 64K units に切り詰め", async () => {
    // The backend rejects outright any record whose body exceeds 64 * 1024 code
    // units, so the sent body must fit within 64K units, marker included, via
    // truncateBodyForIngest (the old 256KB contract remains only as a memory cap).
    // Spaces are interleaved (the redaction email regex goes quadratic on very long contiguous tokens).
    const big = ("a".repeat(99) + " ").repeat(1_200); // 120,000 bytes; 3 chunks = 360KB > 262,144
    const client = wrap(openAIClientWith([oaChunk(big), oaChunk(big), oaChunk(big), oaUsageChunk]), {
      captureContent: true,
    });
    const stream = await client.chat.completions.create({
      model: "gpt-5.5",
      messages,
      stream: true,
    });
    await drain(stream);
    const records = await getRecorder(client)!.flush();
    const body = records[0]!.completionBody!;
    expect(body.endsWith(TRUNCATED)).toBe(true);
    // ASCII = 1 code unit per char. Exactly the ingest cap, marker included.
    expect(body.length).toBe(INGEST_MAX_BODY_UNITS);
  });

  it("途中例外: そこまでの本文 + truncated マーカーが error record に載る", async () => {
    const create = vi.fn(async () =>
      (async function* () {
        yield oaChunk("part1 ");
        yield oaChunk("part2");
        throw new Error("mid-stream boom");
      })(),
    );
    const client = wrap({ chat: { completions: { create } } }, { captureContent: true });
    const stream = await client.chat.completions.create({
      model: "gpt-5.5",
      messages,
      stream: true,
    });
    await expect(drain(stream)).rejects.toThrow("mid-stream boom");
    const records = await getRecorder(client)!.flush();
    expect(records).toHaveLength(1);
    expect(records[0]!.error).toBe("mid-stream boom");
    expect(records[0]!.promptBody).toBe(JSON.stringify(messages));
    expect(records[0]!.completionBody).toBe(`part1 part2${TRUNCATED}`);
  });

  it("早期 break(中断): 部分本文 + truncated マーカーで 1 回だけ記録", async () => {
    const client = wrap(openAIClientWith([oaChunk("first "), oaChunk("second"), oaUsageChunk]), {
      captureContent: true,
    });
    const stream = (await client.chat.completions.create({
      model: "gpt-5.5",
      messages,
      stream: true,
    })) as AsyncIterable<unknown>;
    for await (const _chunk of stream) {
      break; // stop after 1 chunk
    }
    const records = await getRecorder(client)!.flush();
    expect(records).toHaveLength(1);
    expect(records[0]!.completionBody).toBe(`first ${TRUNCATED}`);
  });

  it("redaction: 蓄積本文の PII が flush 時にマスクされる", async () => {
    const client = wrap(
      openAIClientWith([oaChunk("reach me at "), oaChunk("taro@example.com"), oaUsageChunk]),
      { captureContent: true },
    );
    const stream = await client.chat.completions.create({
      model: "gpt-5.5",
      messages: [{ role: "user", content: "mail is hana@example.jp" }],
      stream: true,
    });
    await drain(stream);
    const records = await getRecorder(client)!.flush();
    expect(records[0]!.completionBody).toBe("reach me at [REDACTED_EMAIL]");
    expect(records[0]!.promptBody).toContain("[REDACTED_EMAIL]");
    expect(records[0]!.promptBody).not.toContain("hana@example.jp");
  });
});

// --- Anthropic ---------------------------------------------------------------

describe("streaming capture: Anthropic", () => {
  function antEvents(texts: string[]): unknown[] {
    return [
      {
        type: "message_start",
        message: {
          model: "claude-opus-4-8",
          usage: { input_tokens: 20, output_tokens: 1 },
        },
      },
      ...texts.map((t) => ({
        type: "content_block_delta",
        delta: { type: "text_delta", text: t },
      })),
      { type: "message_delta", usage: { output_tokens: 9 } },
    ];
  }

  it("正常系: content_block_delta の text_delta を結合して completionBody", async () => {
    const create = vi.fn(async () => asyncIterOf(antEvents(["こん", "にち", "は"])));
    const client = wrap({ messages: { create } }, { captureContent: true });
    const stream = await client.messages.create({
      model: "claude-opus-4-8",
      messages: [{ role: "user", content: "挨拶して" }],
      stream: true,
    });
    await drain(stream);
    const records = await getRecorder(client)!.flush();
    expect(records).toHaveLength(1);
    expect(records[0]!.promptBody).toBe(JSON.stringify([{ role: "user", content: "挨拶して" }]));
    expect(records[0]!.completionBody).toBe("こんにちは");
    expect(records[0]!.completionTokens).toBe(9);
  });

  it("ツール引数系 delta(text_delta 以外)は蓄積しない", async () => {
    const events = [
      { type: "content_block_delta", delta: { type: "text_delta", text: "ok" } },
      { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: '{"a":1}' } },
    ];
    const create = vi.fn(async () => asyncIterOf(events));
    const client = wrap({ messages: { create } }, { captureContent: true });
    const stream = await client.messages.create({
      model: "claude-opus-4-8",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    });
    await drain(stream);
    const records = await getRecorder(client)!.flush();
    expect(records[0]!.completionBody).toBe("ok");
  });

  it("途中例外: 部分本文 + truncated マーカー", async () => {
    const create = vi.fn(async () =>
      (async function* () {
        yield { type: "content_block_delta", delta: { type: "text_delta", text: "途中まで" } };
        throw new Error("anthropic boom");
      })(),
    );
    const client = wrap({ messages: { create } }, { captureContent: true });
    const stream = await client.messages.create({
      model: "claude-opus-4-8",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    });
    await expect(drain(stream)).rejects.toThrow("anthropic boom");
    const records = await getRecorder(client)!.flush();
    expect(records[0]!.error).toBe("anthropic boom");
    expect(records[0]!.completionBody).toBe(`途中まで${TRUNCATED}`);
  });

  it("captureContent 無効では body を付与しない", async () => {
    const create = vi.fn(async () => asyncIterOf(antEvents(["hello"])));
    const client = wrap({ messages: { create } });
    const stream = await client.messages.create({
      model: "claude-opus-4-8",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    });
    await drain(stream);
    const records = await getRecorder(client)!.flush();
    expect(records[0]!.promptBody).toBeUndefined();
    expect(records[0]!.completionBody).toBeUndefined();
  });
});

// --- Mistral ------------------------------------------------------------------

describe("streaming capture: Mistral", () => {
  function mistralChunks(texts: string[]): unknown[] {
    return [
      ...texts.map((t) => ({ data: { choices: [{ delta: { content: t } }] } })),
      {
        data: {
          model: "mistral-large",
          usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 },
          choices: [],
        },
      },
    ];
  }

  it("正常系: data.choices[0].delta.content を結合して completionBody", async () => {
    const client = wrap(
      {
        chat: {
          complete: vi.fn(async () => ({})),
          stream: vi.fn(async () => asyncIterOf(mistralChunks(["bon", "jour", "!"]))),
        },
      },
      { captureContent: true },
    );
    const stream = await client.chat.stream!({
      model: "mistral-large",
      messages: [{ role: "user", content: "salut" }],
    });
    await drain(stream);
    const records = await getRecorder(client)!.flush();
    expect(records).toHaveLength(1);
    expect(records[0]!.promptBody).toBe(JSON.stringify([{ role: "user", content: "salut" }]));
    expect(records[0]!.completionBody).toBe("bonjour!");
    expect(records[0]!.promptTokens).toBe(5);
  });

  it("途中例外: 部分本文 + truncated マーカー", async () => {
    const client = wrap(
      {
        chat: {
          complete: vi.fn(async () => ({})),
          stream: vi.fn(async () =>
            (async function* () {
              yield { data: { choices: [{ delta: { content: "partiel" } }] } };
              throw new Error("mistral boom");
            })(),
          ),
        },
      },
      { captureContent: true },
    );
    const stream = await client.chat.stream!({
      model: "mistral-large",
      messages: [{ role: "user", content: "salut" }],
    });
    await expect(drain(stream)).rejects.toThrow("mistral boom");
    const records = await getRecorder(client)!.flush();
    expect(records[0]!.error).toBe("mistral boom");
    expect(records[0]!.completionBody).toBe(`partiel${TRUNCATED}`);
  });

  it("captureContent 無効では body を付与しない", async () => {
    const client = wrap({
      chat: {
        complete: vi.fn(async () => ({})),
        stream: vi.fn(async () => asyncIterOf(mistralChunks(["x"]))),
      },
    });
    const stream = await client.chat.stream!({
      model: "mistral-large",
      messages: [{ role: "user", content: "salut" }],
    });
    await drain(stream);
    const records = await getRecorder(client)!.flush();
    expect(records[0]!.promptBody).toBeUndefined();
    expect(records[0]!.completionBody).toBeUndefined();
  });
});

// --- Gemini legacy (@google/generative-ai) -------------------------------------

describe("streaming capture: Gemini legacy", () => {
  function legacyClient(chunks: unknown[], usage = { promptTokenCount: 7, candidatesTokenCount: 2 }) {
    const modelInstance = {
      generateContent: vi.fn(async () => ({})),
      generateContentStream: vi.fn(async () => ({
        stream: asyncIterOf(chunks),
        response: Promise.resolve({ usageMetadata: usage }),
      })),
    };
    return { getGenerativeModel: vi.fn(() => modelInstance) };
  }

  it("正常系: chunk.text()(関数)の delta を結合して completionBody", async () => {
    const chunks = [{ text: () => "レガ" }, { text: () => "シー" }, { text: () => "対応" }];
    const client = wrap(legacyClient(chunks), { captureContent: true });
    const model = client.getGenerativeModel({ model: "gemini-2.0-flash" });
    const result = (await model.generateContentStream!("prompt text")) as {
      stream: AsyncIterable<unknown>;
    };
    await drain(result.stream);
    const records = await getRecorder(client)!.flush();
    expect(records).toHaveLength(1);
    expect(records[0]!.promptBody).toBe("prompt text");
    expect(records[0]!.completionBody).toBe("レガシー対応");
  });

  it("途中例外: 部分本文 + truncated マーカー", async () => {
    const modelInstance = {
      generateContent: vi.fn(async () => ({})),
      generateContentStream: vi.fn(async () => ({
        stream: (async function* () {
          yield { text: () => "途中" };
          throw new Error("legacy boom");
        })(),
        response: Promise.resolve({ usageMetadata: {} }),
      })),
    };
    const client = wrap(
      { getGenerativeModel: vi.fn(() => modelInstance) },
      { captureContent: true },
    );
    const model = client.getGenerativeModel({ model: "gemini-2.0-flash" });
    const result = (await model.generateContentStream!("prompt text")) as {
      stream: AsyncIterable<unknown>;
    };
    await expect(drain(result.stream)).rejects.toThrow("legacy boom");
    const records = await getRecorder(client)!.flush();
    expect(records[0]!.error).toBe("legacy boom");
    expect(records[0]!.completionBody).toBe(`途中${TRUNCATED}`);
  });

  it("captureContent 無効では body を付与しない", async () => {
    const client = wrap(legacyClient([{ text: () => "x" }]));
    const model = client.getGenerativeModel({ model: "gemini-2.0-flash" });
    const result = (await model.generateContentStream!("prompt text")) as {
      stream: AsyncIterable<unknown>;
    };
    await drain(result.stream);
    const records = await getRecorder(client)!.flush();
    expect(records[0]!.promptBody).toBeUndefined();
    expect(records[0]!.completionBody).toBeUndefined();
  });

  it("早期 break(中断): 記録が消えず 1 回だけ + truncated マーカー(finding 1 回帰)", async () => {
    const client = wrap(
      legacyClient([{ text: () => "レガ" }, { text: () => "シー" }, { text: () => "対応" }]),
      { captureContent: true },
    );
    const model = client.getGenerativeModel({ model: "gemini-2.0-flash" });
    const result = (await model.generateContentStream!("prompt text")) as {
      stream: AsyncIterable<unknown>;
    };
    for await (const _chunk of result.stream) {
      break; // stop after 1 chunk = the generator's .return()
    }
    const records = await getRecorder(client)!.flush();
    // The old implementation (no finally) recorded 0 entries. With finally + recordOnce exactly 1 is recorded.
    expect(records).toHaveLength(1);
    expect(records[0]!.completionBody).toBe(`レガ${TRUNCATED}`);
  });
});

// --- Gemini new (@google/genai) -------------------------------------------------

describe("streaming capture: Gemini 新 SDK", () => {
  it("正常系: chunk.text(property)の delta を結合、promptBody は contents", async () => {
    const chunks = [
      { text: "新SDK " },
      {
        text: "です",
        usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2, totalTokenCount: 6 },
      },
    ];
    const client = wrap(
      {
        models: {
          generateContent: vi.fn(async () => ({})),
          generateContentStream: vi.fn(async () => asyncIterOf(chunks)),
        },
      },
      { captureContent: true },
    );
    const stream = await client.models.generateContentStream!({
      model: "gemini-2.5-pro",
      contents: "streaming の調子は?",
    });
    await drain(stream);
    const records = await getRecorder(client)!.flush();
    expect(records).toHaveLength(1);
    expect(records[0]!.promptBody).toBe("streaming の調子は?");
    expect(records[0]!.completionBody).toBe("新SDK です");
    expect(records[0]!.promptTokens).toBe(4);
  });

  it("text が無ければ candidates[0].content.parts[].text にフォールバック", async () => {
    const chunks = [
      { candidates: [{ content: { parts: [{ text: "parts " }] } }] },
      { candidates: [{ content: { parts: [{ text: "経由" }] } }] },
    ];
    const client = wrap(
      {
        models: {
          generateContent: vi.fn(async () => ({})),
          generateContentStream: vi.fn(async () => asyncIterOf(chunks)),
        },
      },
      { captureContent: true },
    );
    const stream = await client.models.generateContentStream!({
      model: "gemini-2.5-pro",
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
    });
    await drain(stream);
    const records = await getRecorder(client)!.flush();
    expect(records[0]!.completionBody).toBe("parts 経由");
    expect(records[0]!.promptBody).toBe(JSON.stringify([{ role: "user", parts: [{ text: "hi" }] }]));
  });

  it("途中例外: 部分本文 + truncated マーカー", async () => {
    const client = wrap(
      {
        models: {
          generateContent: vi.fn(async () => ({})),
          generateContentStream: vi.fn(async () =>
            (async function* () {
              yield { text: "半分" };
              throw new Error("genai boom");
            })(),
          ),
        },
      },
      { captureContent: true },
    );
    const stream = await client.models.generateContentStream!({
      model: "gemini-2.5-pro",
      contents: "hi",
    });
    await expect(drain(stream)).rejects.toThrow("genai boom");
    const records = await getRecorder(client)!.flush();
    expect(records[0]!.error).toBe("genai boom");
    expect(records[0]!.completionBody).toBe(`半分${TRUNCATED}`);
  });

  it("captureContent 無効では body を付与しない", async () => {
    const client = wrap({
      models: {
        generateContent: vi.fn(async () => ({})),
        generateContentStream: vi.fn(async () => asyncIterOf([{ text: "x" }])),
      },
    });
    const stream = await client.models.generateContentStream!({
      model: "gemini-2.5-pro",
      contents: "hi",
    });
    await drain(stream);
    const records = await getRecorder(client)!.flush();
    expect(records[0]!.promptBody).toBeUndefined();
    expect(records[0]!.completionBody).toBeUndefined();
  });

  it("早期 break(中断): 記録が消えず 1 回だけ + truncated マーカー(finding 1 回帰)", async () => {
    const client = wrap(
      {
        models: {
          generateContent: vi.fn(async () => ({})),
          generateContentStream: vi.fn(async () =>
            asyncIterOf([{ text: "新SDK " }, { text: "です" }, { text: "続き" }]),
          ),
        },
      },
      { captureContent: true },
    );
    const stream = await client.models.generateContentStream!({
      model: "gemini-2.5-pro",
      contents: "hi",
    });
    for await (const _chunk of stream) {
      break; // stop after 1 chunk = the generator's .return()
    }
    const records = await getRecorder(client)!.flush();
    // The old implementation (no finally) recorded 0 entries. With finally + recordOnce exactly 1 is recorded.
    expect(records).toHaveLength(1);
    expect(records[0]!.completionBody).toBe(`新SDK ${TRUNCATED}`);
  });
});

// --- captureContent=false safety net (consistency with the Recorder-side strip) --

describe("streaming capture: Recorder 安全網との整合", () => {
  it("multibyte 本文でも ingest 上限(UTF-16 unit 換算)で丸められ、文字境界が壊れない", async () => {
    // "あああ " = 10 bytes / 4 chars. 3 chunks = 375,000 bytes > 262,144 bytes.
    // After accumulation (256KB = memory guard), flush truncates to the 64K-unit ingest cap.
    // Spaces are interleaved (the redaction email regex goes quadratic on very long contiguous tokens).
    const jp = "あああ ".repeat(12_500);
    const client = wrap(openAIClientWith([oaChunk(jp), oaChunk(jp), oaChunk(jp), oaUsageChunk]), {
      captureContent: true,
    });
    const stream = await client.chat.completions.create({
      model: "gpt-5.5",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    });
    await drain(stream);
    const records = await getRecorder(client)!.flush();
    const body = records[0]!.completionBody!;
    expect(body.endsWith(TRUNCATED)).toBe(true);
    const textPart = body.slice(0, -TRUNCATED.length);
    // "あ" is BMP = 1 code unit. Fits exactly at the ingest cap, marker included.
    expect(body.length).toBe(INGEST_MAX_BODY_UNITS);
    expect(textPart.includes("�")).toBe(false);
  });

  it("flush された record が LlmCallRecord 型のまま送れる(型回帰なし)", async () => {
    const client = wrap(openAIClientWith([oaChunk("ok"), oaUsageChunk]), {
      captureContent: true,
    });
    const stream = await client.chat.completions.create({
      model: "gpt-5.5",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    });
    await drain(stream);
    const records: LlmCallRecord[] = await getRecorder(client)!.flush();
    expect(records[0]!.completionBody).toBe("ok");
  });
});
