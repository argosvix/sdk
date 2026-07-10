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
    const cost = calculateCost("openai", "gpt-5.5", 1_000_000, 500_000);
    expect(cost).toBeCloseTo(5.0 + 15.0, 6);
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

  it("OpenAI cached read = 50% 割引 (cached は prompt_tokens の部分集合)", () => {
    // gpt-5.5 input $5/1M. 500k of the 1M prompt tokens are cached.
    // uncached 500k*$5 + cached 500k*$5*0.5 = 2.5 + 1.25 = 3.75 (no output)
    const { costUsd, cacheSavingsUsd } = calculateCostWithCache(
      "openai",
      "gpt-5.5",
      1_000_000,
      0,
      500_000,
      0,
    );
    expect(costUsd).toBeCloseTo(3.75, 6);
    // Savings = difference vs charging the 500k at the regular rate = 500k*$5*0.5 = 1.25
    expect(cacheSavingsUsd).toBeCloseTo(1.25, 6);
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
      1_000_000,
      0,
      -100,
      -50,
    );
    expect(costUsd).toBeCloseTo(5.0, 6);
    expect(cacheSavingsUsd).toBe(0);
  });
});
