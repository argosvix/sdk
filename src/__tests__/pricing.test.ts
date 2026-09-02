import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  calculateCost,
  calculateCostWithCache,
  PRICING,
  __resetPricingWarnings,
} from "../pricing.js";

describe("calculateCost", () => {
  it("exact model match で USD cost を計算する", () => {
    // gpt-5.5 = $5/1M input + $30/1M output (verified against official pricing 2026-06-12)
    // ⚠ 閾値(272K)未満で測る。超えると入力 2 倍・出力 1.5 倍になる
    const cost = calculateCost("openai", "gpt-5.5", 200_000, 100_000);
    expect(cost).toBeCloseTo(1.0 + 3.0, 6);
  });

  it("prefix match で version suffix 付き model を解決する", () => {
    const cost = calculateCost("openai", "gpt-4o-2024-08-06", 1_000_000, 1_000_000);
    expect(cost).toBeCloseTo(2.5 + 10.0, 6);
  });

  it("unknown provider / model は 0 を返す(過小 estimate より明示優先)", () => {
    expect(calculateCost("openai", "non-existent-model-xyz", 1000, 1000)).toBe(0);
    expect(
      calculateCost("openai" as never, "gpt-5.5", 1000, 1000) === 0
        ? 0
        : calculateCost("openai", "gpt-5.5", 1000, 1000),
    ).not.toBe(0);
  });

  it("PRICING table の主要 model entry が定義されている", () => {
    expect(PRICING.openai["gpt-5.5"]).toBeDefined();
    expect(PRICING.openai["gpt-5.4"]).toBeDefined();
    expect(PRICING.openai["gpt-5.3-codex"]).toBeDefined();
    expect(PRICING.anthropic["claude-fable-5"]).toBeDefined();
    expect(PRICING.anthropic["claude-opus-4-8"]).toBeDefined();
    expect(PRICING.anthropic["claude-haiku-4-5"]).toBeDefined();
    expect(PRICING.anthropic["claude-opus-4-1"]).toBeDefined();
    expect(PRICING.anthropic["claude-sonnet-4"]).toBeDefined();
    expect(PRICING.gemini["gemini-3.1-pro"]).toBeDefined();
    expect(PRICING.gemini["gemini-2.0-flash"]).toBeDefined();
  });

  it("Moonshot Kimi K3(OpenAI 互換経由)はキャッシュヒット入力を別単価で計算する", () => {
    // $3/1M input + $15/1M output + $0.3/1M cached input
    // (platform.kimi.ai/docs/pricing/chat-k3 で 2026-07-17 照合)
    const plain = calculateCost("openai", "kimi-k3", 1_000_000, 1_000_000);
    expect(plain).toBeCloseTo(3.0 + 15.0, 6);
    // promptTokens はキャッシュ分込みの総入力(OpenAI usage と同じ意味論)
    const cached = calculateCostWithCache("openai", "kimi-k3", 1_000_000, 1_000_000, 500_000, 0);
    // 非キャッシュ入力 500k × $3/1M + キャッシュ入力 500k × $0.3/1M + 出力 1M × $15/1M
    expect(cached.costUsd).toBeCloseTo(1.5 + 0.15 + 15.0, 6);
    // 節約額 = 500k × ($3 - $0.3)/1M
    expect(cached.cacheSavingsUsd).toBeCloseTo(1.35, 6);
  });

  it("dated model ID は最長 prefix で解決する (gpt-5.4-mini が gpt-5.4 に化けない)", () => {
    const mini = calculateCost("openai", "gpt-5.4-mini-2026-01-15", 1_000_000, 1_000_000);
    expect(mini).toBeCloseTo(0.75 + 4.5, 6);
    const opus48 = calculateCost("anthropic", "claude-opus-4-8-20260301", 1_000_000, 1_000_000);
    expect(opus48).toBeCloseTo(5.0 + 25.0, 6);
  });

  describe("resource-prefixed model names (H-4)", () => {
    it("models/ prefix を strip して PRICING lookup する", () => {
      const cost1 = calculateCost("gemini", "gemini-2.0-flash", 1_000_000, 1_000_000);
      const cost2 = calculateCost("gemini", "models/gemini-2.0-flash", 1_000_000, 1_000_000);
      expect(cost2).toBe(cost1);
      expect(cost2).toBeGreaterThan(0);
    });

    it("publishers/google/models/ prefix を strip", () => {
      const cost1 = calculateCost("gemini", "gemini-2.0-flash", 100_000, 100_000);
      const cost2 = calculateCost(
        "gemini",
        "publishers/google/models/gemini-2.0-flash",
        100_000,
        100_000,
      );
      expect(cost2).toBe(cost1);
    });

    it("Vertex full resource path も terminal model 部分で lookup", () => {
      const cost1 = calculateCost("gemini", "gemini-2.0-pro", 100_000, 100_000);
      const cost2 = calculateCost(
        "gemini",
        "projects/p/locations/us-central1/publishers/google/models/gemini-2.0-pro",
        100_000,
        100_000,
      );
      expect(cost2).toBe(cost1);
    });
  });

  describe("unknown model warn", () => {
    let warnSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      __resetPricingWarnings();
      warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    });

    afterEach(() => {
      warnSpy.mockRestore();
    });

    it("unknown model = 1 度だけ warn (= 重複 noise 防止)", () => {
      calculateCost("openai", "unknown-model-1", 100, 50);
      calculateCost("openai", "unknown-model-1", 200, 100);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0]?.[0]).toContain("unknown openai model");
    });

    it("異なる unknown model はそれぞれ warn", () => {
      calculateCost("openai", "unknown-model-1", 100, 50);
      calculateCost("openai", "unknown-model-2", 100, 50);
      expect(warnSpy).toHaveBeenCalledTimes(2);
    });
  });
});

describe("calculateCostWithCache", () => {
  it("cache なし = calculateCost と一致 + 節約 0", () => {
    const { costUsd, cacheSavingsUsd } = calculateCostWithCache(
      "openai",
      "gpt-5.5",
      1_000_000,
      500_000,
      0,
      0,
    );
    expect(costUsd).toBeCloseTo(calculateCost("openai", "gpt-5.5", 1_000_000, 500_000), 6);
    expect(cacheSavingsUsd).toBe(0);
  });

  it("OpenAI 5.x cached read = モデル別公式単価 (gpt-5.5 は $0.5/1M = 10%)", () => {
    // gpt-5.5 input $5/1M, cached input $0.50/1M (official, verified 2026-07-12).
    // ⚠ 閾値(272K)未満で測る。20 万のうち 10 万がキャッシュ:
    //    10 万*$5 + 10 万*$0.5 = 0.5 + 0.05 = 0.55
    const { costUsd, cacheSavingsUsd } = calculateCostWithCache(
      "openai",
      "gpt-5.5",
      200_000,
      0,
      100_000,
      0,
    );
    expect(costUsd).toBeCloseTo(0.55, 6);
    // Savings = 10 万*($5 - $0.5)/1M = 0.45
    expect(cacheSavingsUsd).toBeCloseTo(0.45, 6);
  });

  it("OpenAI 4o 系は従来どおり provider 係数 50% (モデル別単価なし)", () => {
    // gpt-4o input $2.5/1M. uncached 500k*$2.5 + cached 500k*$2.5*0.5 = 1.25 + 0.625 = 1.875
    const { costUsd, cacheSavingsUsd } = calculateCostWithCache(
      "openai",
      "gpt-4o",
      1_000_000,
      0,
      500_000,
      0,
    );
    expect(costUsd).toBeCloseTo(1.875, 6);
    expect(cacheSavingsUsd).toBeCloseTo(0.625, 6);
  });

  it("GPT-5.6 family: モデル別キャッシュ単価が効く (sol $0.4 / luna $0.02)", () => {
    const sol = calculateCostWithCache("openai", "gpt-5.6-sol", 100_000, 0, 100_000, 0);
    // ⚠ 閾値(272K)未満で測る。超えると段階が上がって別の話になる
    // sol は 2026-08-23 の値下げ後(cached $0.5 → $0.4/1M)
    expect(sol.costUsd).toBeCloseTo(0.04, 6); // 全部 cached = $0.4/1M の 10 万ぶん
    // luna は 2026-07-30 の値下げ後(cached $0.02/1M)
    const luna = calculateCostWithCache("openai", "gpt-5.6-luna", 100_000, 0, 100_000, 0);
    expect(luna.costUsd).toBeCloseTo(0.002, 6);
  });

  it("Anthropic cache read=10% + write=125% (prompt_tokens は総入力)", () => {
    // claude-opus-4-8 input $5/1M. Total input 1M = uncached 600k + read 300k + write 100k.
    // 600k*$5 + 300k*$5*0.1 + 100k*$5*1.25 = 3.0 + 0.15 + 0.625 = 3.775
    const { costUsd, cacheSavingsUsd } = calculateCostWithCache(
      "anthropic",
      "claude-opus-4-8",
      1_000_000,
      0,
      300_000,
      100_000,
    );
    expect(costUsd).toBeCloseTo(3.775, 6);
    // Savings = read 300k*$5*(1-0.1) = 1.35 (the write surcharge does not count as savings)
    expect(cacheSavingsUsd).toBeCloseTo(1.35, 6);
  });

  it("Gemini cached read = 10% 割引(2026-06 改定後)", () => {
    // gemini-3-flash input $0.5/1M. 400k of the 1M are cached.
    // 600k*$0.5 + 400k*$0.5*0.1 = 0.3 + 0.02 = 0.32
    const { costUsd, cacheSavingsUsd } = calculateCostWithCache(
      "gemini",
      "gemini-3-flash",
      1_000_000,
      0,
      400_000,
      0,
    );
    expect(costUsd).toBeCloseTo(0.32, 6);
    expect(cacheSavingsUsd).toBeCloseTo(400_000 * (0.5 / 1_000_000) * 0.9, 6);
  });

  it("負の cached トークンは 0 にクランプ", () => {
    const { costUsd, cacheSavingsUsd } = calculateCostWithCache(
      "openai",
      "gpt-5.5",
      200_000,
      0,
      -100,
      -50,
    );
    // 20 万 × $5/1M = 1.0(閾値未満)
    expect(costUsd).toBeCloseTo(1.0, 6);
    expect(cacheSavingsUsd).toBe(0);
  });
});

// claude-sonnet-5 の単価。当初は「$2/$10 は 8/31 までの導入価格、9/1 に $3/$15 へ」の
// 予定だったが、2026-09-01 に Anthropic が値上げ撤回を公式発表(platform.claude.com の
// pricing 注記 = 導入価格がそのまま標準価格に、9/1 の $3/$15 への引き上げは行わない)。
// よって $2/$10 が恒久の標準価格。撤回確認済みのため固定期待値に戻した。
describe("pricing revision reminders", () => {
  it("claude-sonnet-5 は $2/$10(2026-09-01 に値上げ撤回が公式発表され恒久化)", () => {
    const entry = PRICING.anthropic["claude-sonnet-5"];
    expect(entry).toBeDefined();
    expect(entry.inputPer1M).toBe(2.0);
    expect(entry.outputPer1M).toBe(10.0);
  });
});

// Opus 5(2026-07-24 リリース)の回帰。publish ゲートで Codex が
// 「SDK の prefix match が緩く feature 派生まで標準単価で課金する」SHIP_BLOCKER を
// 検出したため、厳格化(key + "-" + 数字のみ)と単価を固定する。
describe("claude-opus-5 pricing (2026-07-24)", () => {
  it("exact id costs $7.50 for 1M in + 0.1M out", () => {
    expect(calculateCost("anthropic", "claude-opus-5", 1_000_000, 100_000)).toBeCloseTo(7.5, 6);
  });
  it("dated variant resolves via strict prefix", () => {
    expect(calculateCost("anthropic", "claude-opus-5-20260724", 1_000_000, 100_000)).toBeCloseTo(7.5, 6);
  });
  it("feature variant is fail-closed (not billed at base rate)", () => {
    expect(calculateCost("anthropic", "claude-opus-5-audio-preview", 1_000_000, 100_000)).toBe(0);
  });
  it("does not swallow claude-opus-4-8", () => {
    expect(calculateCost("anthropic", "claude-opus-4-8", 1_000_000, 100_000)).toBeCloseTo(7.5, 6);
  });
  // 隣接 key の版番号くっつき(2 度目の publish ゲートで検出)。素の最長一致だと
  // 存在しない claude-opus-4-80 が旧世代 claude-opus-4($15/$75)に吸われて
  // 過大課金になっていた。backend livePricing.test.ts と同じ期待値。
  it("adjacent-key numeric collision is fail-closed", () => {
    // 2 桁も 3 桁も、より長い既知 key(claude-opus-4-8)の未知派生として弾く。
    // 素の最長一致だと旧世代 claude-opus-4($15/$75)に吸われて過大課金だった。
    expect(calculateCost("anthropic", "claude-opus-4-80", 1_000_000, 100_000)).toBe(0);
    expect(calculateCost("anthropic", "claude-opus-4-800", 1_000_000, 100_000)).toBe(0);
  });
  it("real legacy claude-opus-4 still resolves", () => {
    expect(calculateCost("anthropic", "claude-opus-4", 1_000_000, 100_000)).toBeCloseTo(22.5, 6);
  });
});

describe("claude-fable-5-1 / mythos-5-1 の単価(2026-09-01 リリース)", () => {
  // 入出力は Fable 5 と同額($10/$50)だが、キャッシュ読みだけ $0.25 = 入力の 0.025 倍。
  // 提供元一律の 0.1 倍(CACHE_MULTIPLIERS.anthropic)では表せないので per-model で持つ。
  it("uncached cost equals Fable 5", () => {
    expect(calculateCost("anthropic", "claude-fable-5-1", 1_000_000, 100_000)).toBeCloseTo(15.0, 6);
    expect(calculateCost("anthropic", "claude-fable-5", 1_000_000, 100_000)).toBeCloseTo(15.0, 6);
  });
  it("cache read is billed at $0.25/1M, not the provider-wide 10%", () => {
    // 100 万トークン全部がキャッシュ読み → $0.25。Fable 5 なら $1.00。
    const v51 = calculateCostWithCache("anthropic", "claude-fable-5-1", 1_000_000, 0, 1_000_000, 0);
    expect(v51.costUsd).toBeCloseTo(0.25, 6);
    expect(v51.cacheSavingsUsd).toBeCloseTo(9.75, 6);
    const v5 = calculateCostWithCache("anthropic", "claude-fable-5", 1_000_000, 0, 1_000_000, 0);
    expect(v5.costUsd).toBeCloseTo(1.0, 6);
  });
  it("cache write still uses the provider-wide 125%", () => {
    const r = calculateCostWithCache("anthropic", "claude-fable-5-1", 1_000_000, 0, 0, 1_000_000);
    expect(r.costUsd).toBeCloseTo(12.5, 6);
  });
  it("mythos-5-1 shares the same table row", () => {
    const a = calculateCostWithCache("anthropic", "claude-mythos-5-1", 500_000, 10_000, 400_000, 0);
    const b = calculateCostWithCache("anthropic", "claude-fable-5-1", 500_000, 10_000, 400_000, 0);
    expect(a).toEqual(b);
  });
  // 明示キーが無いと前方一致で claude-fable-5 に吸われ、キャッシュ読みが 4 倍に出る。
  // 日付つき派生は 5-1 側(より長い既知 key)に解決することを固定する。
  it("dated variant resolves to 5-1, not to the shorter fable-5 key", () => {
    const dated = calculateCostWithCache("anthropic", "claude-fable-5-1-20260901", 1_000_000, 0, 1_000_000, 0);
    expect(dated.costUsd).toBeCloseTo(0.25, 6);
  });
  it("feature variant is fail-closed", () => {
    expect(calculateCost("anthropic", "claude-fable-5-1-audio-preview", 1_000_000, 100_000)).toBe(0);
  });
});

describe("xAI の単価(2026-07-26 publish ゲートで見つかった穴)", () => {
  it("⚠ 「-latest」の別名を、同じ系列の単価で計算する", () => {
    // 各社が使う別名。剥がさないと、別名で呼んだ利用者だけコスト 0 の行になる。
    // ⚠ 閾値(20 万)未満で測る。超えると段階が上がって別の話になる
    const base = calculateCost("xai", "grok-4.3", 100_000, 100_000);
    const alias = calculateCost("xai", "grok-4.3-latest", 100_000, 100_000);
    expect(alias).toBeCloseTo(base, 10);
    expect(alias).toBeCloseTo(0.375, 6);
  });

  it("grok-latest は元になる key が無いので明示している", () => {
    // ⚠ 「最新版だから 4.5 だろう」と推測して間違えた。公式の一覧では 4.3 の別名
    //    ($1.25/M in, $2.50/M out)。下の別名テストが正で、ここは 0 円に落ちない確認。
    expect(calculateCost("xai", "grok-latest", 100_000, 100_000)).toBeCloseTo(0.375, 6);
  });

  it("⚠ キャッシュ済み入力の単価を使う(通常入力で課金しない)", () => {
    // 公式は grok-4.3 のキャッシュ入力を $0.20/M と定めている。
    // 単価を持たないと、キャッシュ分も $1.25/M で課金して割高に出る。
    // ⚠ 閾値未満で測る(10 万のうち 5 万がキャッシュ)
    const r = calculateCostWithCache("xai", "grok-4.3", 100_000, 0, 50_000, 0);
    // 素の 5 万 × $1.25/M + キャッシュ 5 万 × $0.20/M
    expect(r.costUsd).toBeCloseTo(0.0625 + 0.01, 6);
    expect(r.cacheSavingsUsd).toBeGreaterThan(0);
  });
});

describe("「-latest」剥がしが既存の値を壊さない", () => {
  it("⚠ もともと表に載っている -latest は、剥がさずその値を使う", () => {
    // Anthropic と Mistral は "-latest" を実際のモデル名として使っていて、表にも
    // 載っている。剥がす処理を足したので、そちらが先に当たることを固定する
    // (剥がした先と値が違う日に、黙って別の単価になるのを防ぐ)。
    const listed = Object.entries(PRICING).flatMap(([provider, models]) =>
      Object.keys(models)
        .filter((m) => m.endsWith("-latest"))
        .map((m) => [provider, m] as const),
    );
    expect(listed.length).toBeGreaterThan(5);
    for (const [provider, model] of listed) {
      const entry = (PRICING as Record<string, Record<string, { inputPer1M: number }>>)[
        provider
      ]![model]!;
      // ⚠ 閾値未満で測る。100 万トークンだと段階が上がる提供元がある
      const cost = calculateCost(
        provider as Parameters<typeof calculateCost>[0],
        model,
        100_000,
        0,
      );
      expect(cost).toBeCloseTo(entry.inputPer1M / 10, 6);
    }
  });
});

describe("xAI の別名とキャッシュ単価を、公式の一覧どおりに固定する", () => {
  // ⚠ ここは「推測で埋めて 1 度間違えた」場所。docs.x.ai の各モデルページに
  //    載っている一覧が正で、grok-latest は 4.5 ではなく 4.3 を指す。
  // 🔴 別名は「どのモデルのページに載っているか」で決まる。**名前の形で判断しない。**
  //    今日 2 回間違えた: grok-latest を 4.5 だと思った(実際は 4.3)、
  //    grok-build-latest を grok-build-0.1 だと思った(実際は 4.5 のページに載っている)。
  //    出典は各モデルの公式ページ:
  //      docs.x.ai/docs/models/grok-4.3      → grok-4.3-latest, grok-latest
  //      docs.x.ai/docs/models/grok-4.5      → grok-4.5-latest, grok-build-latest
  //      docs.x.ai/docs/models/grok-build-0.1 → grok-code-fast-1, grok-code-fast,
  //                                             grok-code-fast-1-0825
  const ALIASES: Array<[string, string]> = [
    ["grok-latest", "grok-4.3"],
    ["grok-4.3-latest", "grok-4.3"],
    ["grok-4.5-latest", "grok-4.5"],
    ["grok-build-latest", "grok-4.5"],
    ["grok-code-fast-1", "grok-build-0.1"],
    ["grok-code-fast", "grok-build-0.1"],
    ["grok-code-fast-1-0825", "grok-build-0.1"],
  ];

  it("別名は、指している型と同じコストになる", () => {
    // ⚠ 実プロバイダー側と後方互換側の両方を見る。片方だけ見ていると、baseURL を
    //    差し替えた経路(openai として届く)の値がずれても気づけない。
    //    実際、片方しか見ていない状態で mutation が素通りした(3 round 目)。
    for (const provider of ["xai", "openai"] as const) {
      for (const [alias, target] of ALIASES) {
        const a = calculateCost(provider, alias, 100_000, 100_000);
        const t = calculateCost(provider, target, 100_000, 100_000);
        expect(a, `${provider}:${alias}`).toBeGreaterThan(0); // 0 円に落ちない
        expect(a, `${provider}:${alias}`).toBeCloseTo(t, 10);
      }
    }
  });

  it("⚠ 別名は、指し先の型と全項目が一致する(片方だけ直す取りこぼしを防ぐ)", () => {
    // 2 回続けて別名で間違えた。値の一致だけでなく、キャッシュ単価まで同じかを見る。
    // ⚠ x.ai が grok-latest を将来 grok-5 に付け替えたら、指し先を変えるまでここは
    //    「一致している」ままになる。それは検出できない(公式ページを読む以外にない)。
    //    ここが守るのは「指し先を変えたときに片方だけ直す」取りこぼしの方。
    // ⚠ 表に載せている別名だけを見る(載っていないものは剥がして解決するので、
    //    上の「同じコストになる」テストが担当)。
    for (const provider of ["xai", "openai"] as const) {
      const table = PRICING[provider] as Record<string, Record<string, number>>;
      for (const [alias, target] of ALIASES) {
        if (!table[alias]) continue;
        expect(table[alias], `${provider}:${alias}`).toEqual(table[target]);
      }
    }
  });

  it("⚠ 4.20 系の別名が 27 件そろっていて、どれも同じ単価になる", () => {
    // 公式は 3 ページに分かれて別名を載せている(reasoning / non-reasoning /
    // multi-agent)。1 ページだけ見ると取りこぼす。単価は 3 グループとも同一。
    const xai = PRICING.xai as Record<string, { inputPer1M: number }>;
    const family = Object.keys(xai).filter((k) => k.startsWith("grok-4.20"));
    // 内訳 = 公式の実体 3(0309-reasoning / 0309-non-reasoning / multi-agent-0309)
    //      + AI SDK の型に出る 2(4.20-reasoning / 4.20-non-reasoning)+ 別名 27
    expect(family.length).toBe(32);
    for (const k of family) {
      expect(calculateCost("xai", k, 100_000, 100_000), k).toBeCloseTo(0.375, 6);
    }
  });

  it("⚠ xAI の全キーがキャッシュ単価を持つ(1 つでも欠けると割高に出る)", () => {
    // 後方互換側にも同じ型が並んでいるので、両方まとめて見る
    const xai = Object.fromEntries([
      ...Object.entries(PRICING.xai),
      ...Object.entries(PRICING.openai).filter(([k]) => k.startsWith("grok-")),
    ]) as Record<string, { inputPer1M: number; cachedInputPer1M?: number }>;
    const missing = Object.entries(xai)
      .filter(([, v]) => v.cachedInputPer1M === undefined)
      .map(([k]) => k);
    expect(missing).toEqual([]);
    // 公式の比率(4.3 系 = 入力の 16%、4.5 = 15%、4.6 = 25% ちょうど)から
    // 大きく外れていないこと。上限は 4.6 の公式明記値($0.50 / $2.00)を含める
    for (const [name, v] of Object.entries(xai)) {
      const ratio = v.cachedInputPer1M! / v.inputPer1M;
      expect(ratio, name).toBeGreaterThan(0.1);
      expect(ratio, name).toBeLessThanOrEqual(0.25);
    }
  });
});

describe("長文脈の段階単価", () => {
  it("🔴 閾値に到達したら、その要求の全トークンが高い方になる", () => {
    // 公式の表記は "requests whose prompt reaches the listed token threshold are
    // billed at the higher rate for all tokens in the request"。超えた分だけではない。
    // grok-4.3、プロンプト 25 万・出力 5 万:
    //   25 万 × $2.50/M + 5 万 × $5.00/M = 0.625 + 0.25 = $0.875
    expect(calculateCost("xai", "grok-4.3", 250_000, 50_000)).toBeCloseTo(0.875, 6);
    // 低い段階のまま計算するとちょうど半額になる(直す前の実測値)
    expect(calculateCost("xai", "grok-4.3", 250_000, 50_000)).not.toBeCloseTo(0.4375, 6);
  });

  it("⚠ 境界はちょうどの値も高い方(reaches = 到達)", () => {
    // ちょうど 20 万 = 高い方($2.50/M)、1 つ手前 = 低い方($1.25/M)
    expect(calculateCost("xai", "grok-4.3", 200_000, 0)).toBeCloseTo(0.5, 9);
    // ⚠ コストは 6 桁で丸められるので、その桁で比べる
    expect(calculateCost("xai", "grok-4.3", 199_999, 0)).toBeCloseTo(0.249999, 6);
  });

  it("キャッシュ済み入力も高い方の段階になる", () => {
    // 25 万のうち 10 万がキャッシュ: 15 万 × $2.50/M + 10 万 × $0.40/M
    const r = calculateCostWithCache("xai", "grok-4.3", 250_000, 0, 100_000, 0);
    expect(r.costUsd).toBeCloseTo(0.375 + 0.04, 6);
  });

  it("⚠ 段階を持つ xAI の全キーが、閾値超えでちょうど 2 倍になる", () => {
    // 公式の表は 3 グループとも「高い方 = 低い方の 2 倍」。1 件でも取り違えると
    // そのモデルだけ請求とずれる。
    const xai = PRICING.xai as Record<string, { longContext?: unknown }>;
    const withTier = Object.keys(xai).filter((k) => xai[k]!.longContext);
    expect(withTier.length).toBeGreaterThan(30);
    for (const k of withTier) {
      const low = calculateCost("xai", k, 100_000, 100_000);
      const high = calculateCost("xai", k, 300_000, 300_000);
      expect(high / low, k).toBeCloseTo(6, 6); // 3 倍の量 × 2 倍の単価
    }
  });
});

describe("段階単価は提供元ごとに境界が違う", () => {
  it("🔴 OpenAI は「272K を超えたら」= 272,000 ちょうどはまだ低い方", () => {
    // 公式: "Prompts with >272K input tokens are priced at 2x input and 1.5x output
    //        for the full request."(各モデルのページ、2026-07-26 照合)
    // gpt-5.5 は $5/$30。272,000 ちょうど = $5、272,001 = $10
    expect(calculateCost("openai", "gpt-5.5", 272_000, 0)).toBeCloseTo(1.36, 6);
    expect(calculateCost("openai", "gpt-5.5", 272_001, 0)).toBeCloseTo(2.72001, 5);
    // 出力は 1.5 倍(2 倍ではない)
    expect(calculateCost("openai", "gpt-5.5", 300_000, 1_000_000)).toBeCloseTo(
      3.0 + 45.0,
      6,
    );
  });

  it("🔴 Gemini は「200k を超えたら」= 200,000 ちょうどはまだ低い方", () => {
    // 公式の表記は "prompts <= 200k" / "prompts > 200k"。
    // ⚠ xAI は「到達したら」なので 200,000 ちょうどが高い方。**境界が 1 トークン違う。**
    expect(calculateCost("gemini", "gemini-2.5-pro", 200_000, 0)).toBeCloseTo(0.25, 6);
    expect(calculateCost("gemini", "gemini-2.5-pro", 200_001, 0)).toBeCloseTo(0.500003, 5);
    // 同じ 200,000 でも xAI は高い方になる
    expect(calculateCost("xai", "grok-4.3", 200_000, 0)).toBeCloseTo(0.5, 6);
  });

  it("Gemini の出力は 1.5 倍、キャッシュ入力は 2 倍(公式の表どおり)", () => {
    // gemini-3.1-pro: 入力 $2→$4、出力 $12→$18、キャッシュ $0.20→$0.40
    const r = calculateCostWithCache("gemini", "gemini-3.1-pro", 300_000, 100_000, 100_000, 0);
    // 素の 20 万 × $4/M + キャッシュ 10 万 × $0.40/M + 出力 10 万 × $18/M
    expect(r.costUsd).toBeCloseTo(0.8 + 0.04 + 1.8, 6);
  });
});

describe("段階の取りこぼしを機械で止める", () => {
  it("⚠ 段階を持つ提供元では、全キーが段階を持つ", () => {
    // 2026-07-26: Python 側で複数行のエントリだけ漏れ、TS と値が食い違った。
    // 目視では防げないので、両言語に同じ検査を置く。
    const xai = PRICING.xai as Record<string, { longContext?: unknown }>;
    expect(Object.entries(xai).filter(([, v]) => !v.longContext).map(([k]) => k)).toEqual(
      [],
    );
    const fallback = Object.entries(
      PRICING.openai as Record<string, { longContext?: unknown }>,
    )
      .filter(([k, v]) => k.startsWith("grok-") && !v.longContext)
      .map(([k]) => k);
    expect(fallback).toEqual([]);
  });
});

describe("キャッシュ数がプロンプト数を超えたとき(2026-07-27 の publish 前レビュー)", () => {
  it("🔴 キャッシュ読みはプロンプト数で頭打ちにする", () => {
    // 提供元がプロンプトより大きいキャッシュ数を返すことがある。頭打ちが無いと、
    // すでに数えたぶんの上に追加で課金されて金額が静かに大きく出る。
    const 正常 = calculateCostWithCache("xai", "grok-4.3", 100_000, 0, 100_000, 0);
    const 過大 = calculateCostWithCache("xai", "grok-4.3", 100_000, 0, 999_999, 0);
    expect(過大.costUsd).toBe(正常.costUsd);
  });

  it("🔴 読みと書きの合計もプロンプト数を超えない", () => {
    const r = calculateCostWithCache("anthropic", "claude-sonnet-4-5", 1_000, 0, 800, 800);
    // 読み 800 で頭打ち後、書きに残るのは 200 まで。全部が「書き」単価にはならない。
    const 上限 = calculateCostWithCache("anthropic", "claude-sonnet-4-5", 1_000, 0, 800, 200);
    expect(r.costUsd).toBe(上限.costUsd);
  });

  it("プロンプトが負の値でも金額が負にならない", () => {
    const r = calculateCostWithCache("openai", "gpt-5.5", -100, 0, 50, 0);
    expect(r.costUsd).toBeGreaterThanOrEqual(0);
  });
});

describe("段階単価とキャッシュの組み合わせ(backend との一致)", () => {
  it("🔴 長文脈に入ってもモデル固有のキャッシュ単価を使う", () => {
    // 段階側に cached を持たせ忘れると、提供元一律の比率(入力の 50%)に落ちて
    // 金額が跳ね上がる。backend が実際にこの状態だった(SDK 2.1 / backend 2.5)。
    const r = calculateCostWithCache("openai", "gpt-5.5", 300_000, 0, 100_000, 0);
    // 長文脈: 入力 $10/M・キャッシュ $1/M。非キャッシュ 20 万 × $10/M = $2.00、
    // キャッシュ 10 万 × $1/M = $0.10。
    expect(r.costUsd).toBeCloseTo(2.1, 6);
  });
});

describe("提供元が壊れた値を返したとき(2026-07-27 の round 7)", () => {
  it("🔴 数値でないキャッシュ数で金額が NaN にならない", () => {
    // NaN は JSON では null になり、取り込みで「invalid costUsd」として record ごと
    // 弾かれる。互換 API の 1 項目が変な形をしているだけで呼び出しが消えていた。
    const r = calculateCostWithCache(
      "openai",
      "gpt-5.5",
      1000,
      100,
      "abc" as unknown as number,
      0,
    );
    expect(Number.isFinite(r.costUsd)).toBe(true);
    expect(r.costUsd).toBeGreaterThan(0);
  });

  it("🔴 NaN のプロンプト数で安い段階が選ばれない", () => {
    // NaN は閾値との比較が常に偽になるので、整えずに渡すと静かに短文脈の単価が使われる。
    const r = calculateCostWithCache("openai", "gpt-5.5", NaN, 0, 0, 0);
    expect(r.costUsd).toBe(0);
  });

  it("負の完了トークン数で金額が負にならない", () => {
    expect(calculateCostWithCache("openai", "gpt-5.5", 0, -1000, 0, 0).costUsd).toBe(0);
  });

  it("Infinity のキャッシュ数は 0 として扱う(全部キャッシュ扱いにしない)", () => {
    // 壊れた値で「全部キャッシュでした」と読むと、金額が実際より安く出る。番人としては
    // 安く出るほうが危ない側なので、キャッシュの主張自体を捨てる。
    const 壊れ = calculateCostWithCache("openai", "gpt-5.5", 1000, 100, Infinity, 0);
    const 素 = calculateCostWithCache("openai", "gpt-5.5", 1000, 100, 0, 0);
    expect(壊れ.costUsd).toBe(素.costUsd);
  });

  it("キャッシュなしの計算も同じ規則で整える", () => {
    expect(calculateCost("mistral", "mistral-large-latest", -1, 0)).toBe(0);
  });
});

describe("トークン数の文字列(2026-07-27 の round 8)", () => {
  // 🔴 round 7 で「3 実装で規則を揃えた」と書いたが、実際は文字列で大きく割れていた。
  //    Python の float は "1000" を通し、TS は 0 にしていた。同じ応答で金額が変わる。
  it("数字だけの文字列はトークン数として受ける", () => {
    const 文字列 = calculateCostWithCache("openai", "gpt-5.5", 1000, 0, "500" as unknown as number, 0);
    const 数値 = calculateCostWithCache("openai", "gpt-5.5", 1000, 0, 500, 0);
    expect(文字列.costUsd).toBe(数値.costUsd);
  });

  it("前後の空白は無視する", () => {
    const a = calculateCostWithCache("openai", "gpt-5.5", 1000, 0, " 500 " as unknown as number, 0);
    const b = calculateCostWithCache("openai", "gpt-5.5", 1000, 0, 500, 0);
    expect(a.costUsd).toBe(b.costUsd);
  });

  it("🔴 言語ごとに解釈が割れる書き方は受けない", () => {
    // Number は "0x10" を 16 に、Python の float は "1_000" を 1000 にする。どちらも
    // 相手側では別の答えになるので、両方とも 0 として扱う。
    const 素 = calculateCostWithCache("openai", "gpt-5.5", 1000, 0, 0, 0).costUsd;
    for (const v of ["0x10", "1_000", "1e3", "abc", ""]) {
      expect(calculateCostWithCache("openai", "gpt-5.5", 1000, 0, v as unknown as number, 0).costUsd).toBe(素);
    }
  });

  it("真偽値はトークン数として受けない", () => {
    const 素 = calculateCostWithCache("openai", "gpt-5.5", 1000, 0, 0, 0).costUsd;
    expect(
      calculateCostWithCache("openai", "gpt-5.5", 1000, 0, true as unknown as number, 0).costUsd,
    ).toBe(素);
  });
});
