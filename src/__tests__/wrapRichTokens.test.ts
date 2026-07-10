import { describe, expect, it, vi } from "vitest";

import { wrap, getRecorder } from "../index.js";

/**
 * Defense gate for rich token capture (reasoning / audio) + TTFT. Verifies
 * extraction from OpenAI usage details and first-token timing for streaming.
 */

describe("リッチなトークン / TTFT(OpenAI)", () => {
  it("非 streaming = reasoning / audio を usage details から取得(入力+出力 audio 合算)", async () => {
    const create = vi.fn(async () => ({
      model: "o3",
      usage: {
        prompt_tokens: 100,
        completion_tokens: 50,
        total_tokens: 150,
        completion_tokens_details: { reasoning_tokens: 40, audio_tokens: 3 },
        prompt_tokens_details: { audio_tokens: 7 },
      },
      choices: [{ message: { content: "x" } }],
    }));
    const client = wrap({ chat: { completions: { create } } });
    await client.chat.completions.create({
      model: "o3",
      messages: [{ role: "user", content: "hi" }],
    });
    const records = await getRecorder(client)!.flush();
    expect(records[0]?.reasoningTokens).toBe(40);
    expect(records[0]?.audioTokens).toBe(10);
    expect(records[0]?.ttftMs).toBeUndefined();
  });

  it("reasoning / audio が無い通常応答では未設定(後方互換)", async () => {
    const create = vi.fn(async () => ({
      model: "gpt-5.5",
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      choices: [{ message: { content: "hi" } }],
    }));
    const client = wrap({ chat: { completions: { create } } });
    await client.chat.completions.create({
      model: "gpt-5.5",
      messages: [{ role: "user", content: "hi" }],
    });
    const records = await getRecorder(client)!.flush();
    expect(records[0]?.reasoningTokens).toBeUndefined();
    expect(records[0]?.audioTokens).toBeUndefined();
  });

  it("streaming = TTFT を計測し、 最終チャンクの reasoning / audio も取得", async () => {
    const chunks = [
      { model: "gpt-5.5", choices: [{ delta: { content: "he" } }] },
      { choices: [{ delta: { content: "llo" } }] },
      {
        choices: [{ delta: {}, finish_reason: "stop" }],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 50,
          total_tokens: 150,
          completion_tokens_details: { reasoning_tokens: 12 },
          prompt_tokens_details: { audio_tokens: 4 },
        },
      },
    ];
    const create = vi.fn(async () => {
      async function* gen() {
        for (const c of chunks) yield c;
      }
      return gen();
    });
    const client = wrap({ chat: { completions: { create } } });
    const stream = (await client.chat.completions.create({
      model: "gpt-5.5",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    })) as AsyncIterable<unknown>;
    for await (const _chunk of stream) {
      void _chunk;
    }
    const records = await getRecorder(client)!.flush();
    expect(records).toHaveLength(1);
    expect(records[0]?.ttftMs).toBeTypeOf("number");
    expect(records[0]!.ttftMs!).toBeGreaterThanOrEqual(0);
    expect(records[0]?.reasoningTokens).toBe(12);
    expect(records[0]?.audioTokens).toBe(4);
    expect(records[0]?.completionTokens).toBe(50);
  });

  it("streaming = role のみの先頭 delta では TTFT を立てない(本文が無ければ未設定)", async () => {
    const chunks = [
      { model: "gpt-5.5", choices: [{ delta: { role: "assistant" } }] },
      {
        choices: [{ delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      },
    ];
    const create = vi.fn(async () => {
      async function* gen() {
        for (const c of chunks) yield c;
      }
      return gen();
    });
    const client = wrap({ chat: { completions: { create } } });
    const stream = (await client.chat.completions.create({
      model: "gpt-5.5",
      messages: [],
      stream: true,
    })) as AsyncIterable<unknown>;
    for await (const _chunk of stream) {
      void _chunk;
    }
    const records = await getRecorder(client)!.flush();
    expect(records[0]?.ttftMs).toBeUndefined(); // role-only = first token never arrived
  });
});
