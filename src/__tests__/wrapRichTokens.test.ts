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

  it("Moonshot Kimi 形(usage トップレベルの cached_tokens)もキャッシュ入力として拾う", async () => {
    // platform.kimi.ai/docs/api/chat の usage 形: { prompt_tokens, completion_tokens,
    // total_tokens, cached_tokens }(prompt_tokens_details なし)。Codex 2026-07-17
    // publish blocker: この形を読まないと cache hit 分が全額課金で計算される
    const create = vi.fn(async () => ({
      model: "kimi-k3",
      usage: {
        prompt_tokens: 1_000_000,
        completion_tokens: 1_000_000,
        total_tokens: 2_000_000,
        cached_tokens: 500_000,
      },
      choices: [{ message: { content: "x" } }],
    }));
    const client = wrap({ chat: { completions: { create } } });
    await client.chat.completions.create({
      model: "kimi-k3",
      messages: [{ role: "user", content: "hi" }],
    });
    const records = await getRecorder(client)!.flush();
    expect(records[0]?.cachedReadTokens).toBe(500_000);
    // 非キャッシュ 500k × $3/1M + キャッシュ 500k × $0.3/1M + 出力 1M × $15/1M
    expect(records[0]?.costUsd).toBeCloseTo(16.65, 6);
    expect(records[0]?.cacheSavingsUsd).toBeCloseTo(1.35, 6);
  });

  it("baseURL が Moonshot / xAI なら実プロバイダーで記録する(2026-07-17 判別)", async () => {
    const make = (baseURL: string, model: string) => ({
      baseURL,
      chat: {
        completions: {
          create: vi.fn(async () => ({
            model,
            usage: { prompt_tokens: 1_000_000, completion_tokens: 1_000_000, total_tokens: 2_000_000 },
            choices: [{ message: { content: "x" } }],
          })),
        },
      },
    });
    const kimi = wrap(make("https://api.moonshot.ai/v1", "kimi-k3"));
    await kimi.chat.completions.create({ model: "kimi-k3", messages: [] });
    const kimiRec = (await getRecorder(kimi)!.flush())[0];
    expect(kimiRec?.provider).toBe("moonshot");
    expect(kimiRec?.costUsd).toBeCloseTo(18.0, 6);

    const grok = wrap(make("https://api.x.ai/v1", "grok-4.5"));
    await grok.chat.completions.create({ model: "grok-4.5", messages: [] });
    const grokRec = (await getRecorder(grok)!.flush())[0];
    expect(grokRec?.provider).toBe("xai");
    // ⚠ プロンプト 100 万 = 長文脈の段階(20 万以上)。公式は「到達したら全トークンが
    //    高い方」なので $4/M + $12/M(2026-07-26 に段階単価へ対応)。
    expect(grokRec?.costUsd).toBeCloseTo(4.0 + 12.0, 6);

    // 未知ホストは従来どおり openai(fallback 単価で計算は成立)
    const other = wrap(make("https://my-proxy.example.com/v1", "kimi-k3"));
    await other.chat.completions.create({ model: "kimi-k3", messages: [] });
    const otherRec = (await getRecorder(other)!.flush())[0];
    expect(otherRec?.provider).toBe("openai");
    expect(otherRec?.costUsd).toBeCloseTo(18.0, 6);
  });

  it("baseURL が DashScope なら alibaba、DashScope 以外の aliyuncs.com は openai のまま(2026-08-05)", async () => {
    const make = (baseURL: string, model: string, cached = 0) => ({
      baseURL,
      chat: {
        completions: {
          create: vi.fn(async () => ({
            model,
            usage: {
              prompt_tokens: 1_000_000,
              completion_tokens: 1_000_000,
              total_tokens: 2_000_000,
              // DashScope の OpenAI 互換応答は cached_tokens をこの形で返す
              // (qwencloud.com の Context Cache docs で確認)
              prompt_tokens_details: { cached_tokens: cached },
            },
            choices: [{ message: { content: "x" } }],
          })),
        },
      },
    });
    const qwen = wrap(make("https://dashscope-intl.aliyuncs.com/compatible-mode/v1", "qwen3.8-max"));
    await qwen.chat.completions.create({ model: "qwen3.8-max", messages: [] });
    const qwenRec = (await getRecorder(qwen)!.flush())[0];
    expect(qwenRec?.provider).toBe("alibaba");
    // 入力 1M × $2 + 出力 1M × $6
    expect(qwenRec?.costUsd).toBeCloseTo(8.0, 6);

    // implicit cache: 50 万キャッシュ = 非キャッシュ 500k × $2/1M + キャッシュ 500k × $0.25/1M + 出力 $6
    const cachedClient = wrap(make("https://dashscope.aliyuncs.com/compatible-mode/v1", "qwen3.8-max", 500_000));
    await cachedClient.chat.completions.create({ model: "qwen3.8-max", messages: [] });
    const cachedRec = (await getRecorder(cachedClient)!.flush())[0];
    expect(cachedRec?.provider).toBe("alibaba");
    expect(cachedRec?.costUsd).toBeCloseTo(1.0 + 0.125 + 6.0, 6);

    // positive: 公式 Base URL 一覧の region / workspace / trial 形も alibaba
    //    (alibabacloud.com/help/en/model-studio/base-url、2026-08-05 実照合)
    for (const h of [
      "https://cn-hongkong.dashscope.aliyuncs.com/compatible-mode/v1",
      "https://ws-1234.ap-southeast-1.maas.aliyuncs.com/v1",
      "https://trial.cn-beijing.maas.aliyuncs.com/v1",
    ]) {
      const c = wrap(make(h, "qwen3.8-max"));
      await c.chat.completions.create({ model: "qwen3.8-max", messages: [] });
      const rec = (await getRecorder(c)!.flush())[0];
      expect(rec?.provider, h).toBe("alibaba");
    }

    // ⚠ negative: DashScope でない aliyuncs.com(例 = OSS 互換 gateway)は alibaba に
    //    しない(Codex 2026-08-05 MEDIUM = 過度包摂の防止)
    const oss = wrap(make("https://oss-cn-hangzhou.aliyuncs.com/v1", "qwen3.8-max"));
    await oss.chat.completions.create({ model: "qwen3.8-max", messages: [] });
    const ossRec = (await getRecorder(oss)!.flush())[0];
    expect(ossRec?.provider).toBe("openai");
    // openai fallback ブロックにも qwen3.8-max があるため計算は成立する
    expect(ossRec?.costUsd).toBeCloseTo(8.0, 6);
  });

  it("config.provider の明示指定(moonshot / xai)でも wrap が成立し実プロバイダーで記録する", async () => {
    // Codex 2026-07-17 blocker 1: 明示指定が switch に case を持たず wrap 未適用に
    // なっていた回帰の防御ゲート(baseURL なしでも明示指定で記録できること)
    const create = vi.fn(async () => ({
      model: "kimi-k3",
      usage: { prompt_tokens: 1_000_000, completion_tokens: 1_000_000, total_tokens: 2_000_000 },
      choices: [{ message: { content: "x" } }],
    }));
    const client = wrap({ chat: { completions: { create } } }, { provider: "moonshot" });
    await client.chat.completions.create({ model: "kimi-k3", messages: [] });
    const rec = (await getRecorder(client)!.flush())[0];
    expect(rec?.provider).toBe("moonshot");
    expect(rec?.costUsd).toBeCloseTo(18.0, 6);
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
