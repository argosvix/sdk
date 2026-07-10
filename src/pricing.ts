import type { PricingEntry, Provider } from "./types.js";

const warnedUnknownModels = new Set<string>();

/**
 * USD pricing per 1M tokens, snapshot as of 2026-06-12.
 * Sourced from each provider's official pricing page. Prices fluctuate
 * quarterly — re-verify before any production launch.
 *
 * Sources (verified 2026-06-12):
 * - OpenAI:    https://developers.openai.com/api/docs/pricing
 * - Anthropic: https://platform.claude.com/docs/en/docs/about-claude/pricing
 * - Google:    https://ai.google.dev/gemini-api/docs/pricing
 */
export const PRICING: Record<Provider, Record<string, PricingEntry>> = {
  openai: {
    "gpt-5.5": { inputPer1M: 5.0, outputPer1M: 30.0 },
    // xAI Grok (arrives with provider "openai" because it is called via the OpenAI-compatible API)
    "grok-4.5": { inputPer1M: 2.0, outputPer1M: 6.0 },
    "gpt-5.4": { inputPer1M: 2.5, outputPer1M: 15.0 },
    "gpt-5.4-mini": { inputPer1M: 0.75, outputPer1M: 4.5 },
    "gpt-5.4-nano": { inputPer1M: 0.2, outputPer1M: 1.25 },
    "gpt-5.3-codex": { inputPer1M: 1.75, outputPer1M: 14.0 },
    "gpt-5-mini": { inputPer1M: 0.15, outputPer1M: 0.6 },
    "gpt-5-nano": { inputPer1M: 0.05, outputPer1M: 0.2 },
    "gpt-4o": { inputPer1M: 2.5, outputPer1M: 10.0 },
    "gpt-4o-mini": { inputPer1M: 0.15, outputPer1M: 0.6 },
    "o1": { inputPer1M: 15.0, outputPer1M: 60.0 },
    "o1-mini": { inputPer1M: 3.0, outputPer1M: 12.0 },
  },
  anthropic: {
    // Claude 5 series
    "claude-fable-5": { inputPer1M: 10.0, outputPer1M: 50.0 },
    "claude-mythos-5": { inputPer1M: 10.0, outputPer1M: 50.0 },
    // Claude 4.5-4.8 series (dateless aliases cover dated IDs via prefix match)
    "claude-opus-4-8": { inputPer1M: 5.0, outputPer1M: 25.0 },
    "claude-opus-4-7": { inputPer1M: 5.0, outputPer1M: 25.0 },
    "claude-opus-4-6": { inputPer1M: 5.0, outputPer1M: 25.0 },
    "claude-opus-4-5": { inputPer1M: 5.0, outputPer1M: 25.0 },
    "claude-sonnet-4-6": { inputPer1M: 3.0, outputPer1M: 15.0 },
    "claude-sonnet-4-5": { inputPer1M: 3.0, outputPer1M: 15.0 },
    "claude-haiku-4-5": { inputPer1M: 1.0, outputPer1M: 5.0 },
    // Claude 4-4.1 series
    "claude-opus-4-1-20250805": { inputPer1M: 15.0, outputPer1M: 75.0 },
    "claude-opus-4-1": { inputPer1M: 15.0, outputPer1M: 75.0 },
    "claude-opus-4-20250514": { inputPer1M: 15.0, outputPer1M: 75.0 },
    "claude-opus-4": { inputPer1M: 15.0, outputPer1M: 75.0 },
    "claude-sonnet-4-20250514": { inputPer1M: 3.0, outputPer1M: 15.0 },
    "claude-sonnet-4": { inputPer1M: 3.0, outputPer1M: 15.0 },
    // Claude 3.5 series
    "claude-3-5-sonnet-latest": { inputPer1M: 3.0, outputPer1M: 15.0 },
    "claude-3-5-sonnet-20241022": { inputPer1M: 3.0, outputPer1M: 15.0 },
    "claude-3-5-sonnet": { inputPer1M: 3.0, outputPer1M: 15.0 },
    "claude-3-5-haiku-latest": { inputPer1M: 0.8, outputPer1M: 4.0 },
    "claude-3-5-haiku-20241022": { inputPer1M: 0.8, outputPer1M: 4.0 },
    "claude-3-5-haiku": { inputPer1M: 0.8, outputPer1M: 4.0 },
    // Claude 3 series
    "claude-3-opus": { inputPer1M: 15.0, outputPer1M: 75.0 },
    "claude-3-sonnet": { inputPer1M: 3.0, outputPer1M: 15.0 },
    "claude-3-haiku": { inputPer1M: 0.25, outputPer1M: 1.25 },
  },
  gemini: {
    // Gemini 3 series (GA 2026-05-19; verified against ai.google.dev/pricing)
    "gemini-3.5-flash": { inputPer1M: 1.5, outputPer1M: 9.0 },
    // 3.1-pro has context-size pricing tiers; we use the ≤200k default (preview IDs resolve via prefix match)
    "gemini-3.1-pro": { inputPer1M: 2.0, outputPer1M: 12.0 },
    "gemini-3-flash": { inputPer1M: 0.5, outputPer1M: 3.0 },
    // Gemini 2.5 series (corrected 2026-05 against the official pricing page)
    // 2.5-pro has context-size pricing tiers; we use the ≤200k default (we do not track context size)
    "gemini-2.5-pro": { inputPer1M: 1.25, outputPer1M: 10.0 },
    "gemini-2.5-flash": { inputPer1M: 0.3, outputPer1M: 2.5 },
    // Gemini 2 series
    "gemini-2.0-flash": { inputPer1M: 0.1, outputPer1M: 0.4 },
    "gemini-2.0-pro": { inputPer1M: 1.25, outputPer1M: 5.0 },
    // Gemini 1.5 series (kept for legacy records)
    "gemini-1.5-pro": { inputPer1M: 1.25, outputPer1M: 5.0 },
    "gemini-1.5-flash": { inputPer1M: 0.075, outputPer1M: 0.3 },
  },
  mistral: {
    // Mistral prices must be re-verified before launch using the official docs
    // (https://docs.mistral.ai/getting-started/models/). Values below are 2026-05
    // estimates — a mix of aliases and date-stamped IDs.
    // Current production aliases (API-recommended IDs)
    "mistral-large-latest": { inputPer1M: 2.0, outputPer1M: 6.0 },
    "mistral-medium-latest": { inputPer1M: 2.7, outputPer1M: 8.1 },
    "mistral-small-latest": { inputPer1M: 0.2, outputPer1M: 0.6 },
    "ministral-8b-latest": { inputPer1M: 0.1, outputPer1M: 0.1 },
    "ministral-3b-latest": { inputPer1M: 0.04, outputPer1M: 0.04 },
    "pixtral-large-latest": { inputPer1M: 2.0, outputPer1M: 6.0 },
    "codestral-latest": { inputPer1M: 0.2, outputPer1M: 0.6 },
    // Open models
    "open-mistral-nemo": { inputPer1M: 0.15, outputPer1M: 0.15 },
    "open-mixtral-8x7b": { inputPer1M: 0.7, outputPer1M: 0.7 },
    "open-mixtral-8x22b": { inputPer1M: 2.0, outputPer1M: 6.0 },
    // Shorthand fallbacks (caught by prefix match against longer model IDs)
    "mistral-large": { inputPer1M: 2.0, outputPer1M: 6.0 },
    "mistral-small": { inputPer1M: 0.2, outputPer1M: 0.6 },
    "mistral-medium": { inputPer1M: 2.7, outputPer1M: 8.1 },
    "ministral-8b": { inputPer1M: 0.1, outputPer1M: 0.1 },
    "ministral-3b": { inputPer1M: 0.04, outputPer1M: 0.04 },
    "pixtral-large": { inputPer1M: 2.0, outputPer1M: 6.0 },
    "codestral": { inputPer1M: 0.2, outputPer1M: 0.6 },
  },
};

/**
 * Per-provider prompt-cache price multipliers (as a ratio of the input rate).
 *   read  = cache read (discounted) / write = cache write (premium, Anthropic only)
 * Verified 2026-06-27 against each provider's official pricing:
 *   - OpenAI automatic caching: reads at 50% of input; no write charge
 *   - Anthropic explicit caching: reads at 10% / writes at 125% (5-minute TTL
 *     default). Note: 1-hour-TTL writes cost 200%, but we lack a token
 *     breakdown column, so we bill at the default 5-minute rate of 125%
 *     (write cost is slightly underestimated only when the 1h cache is used).
 *   - Gemini context cache: reads at 10% (revised from 25% to 10% in 2026-06,
 *     officially verified)
 *   - Mistral: no cache pricing
 */
const CACHE_MULTIPLIERS: Record<Provider, { read: number; write: number }> = {
  openai: { read: 0.5, write: 1.0 },
  anthropic: { read: 0.1, write: 1.25 },
  gemini: { read: 0.1, write: 1.0 },
  mistral: { read: 1.0, write: 1.0 },
};

/**
 * Calculate USD cost for a single LLM call.
 *
 * Unknown models return 0 — preferring an explicit zero over a guessed
 * under-estimate. A separate "unknown model alert" path is planned before launch.
 */
export function calculateCost(
  provider: Provider,
  model: string,
  promptTokens: number,
  completionTokens: number,
): number {
  return calculateCostWithCache(provider, model, promptTokens, completionTokens, 0, 0)
    .costUsd;
}

/**
 * USD cost accounting for cache tokens, plus the cache savings amount.
 *
 * promptTokens is the total input including cache reads and writes. Breakdown:
 *   uncached = promptTokens − cachedReadTokens − cachedWriteTokens (floored at 0)
 *   cost = uncached×input + cachedRead×input×readMult + cachedWrite×input×writeMult + completion×output
 *   savings = cachedRead×input×(1 − readMult)  ← value of the read discount (the write premium is not included in savings)
 * Unknown models return {0, 0}.
 */
export function calculateCostWithCache(
  provider: Provider,
  model: string,
  promptTokens: number,
  completionTokens: number,
  cachedReadTokens: number,
  cachedWriteTokens: number,
): { costUsd: number; cacheSavingsUsd: number } {
  const providerPricing = PRICING[provider];
  if (!providerPricing) {
    warnOnceUnknown(`${provider}:${model}`, `unknown provider "${provider}"`);
    return { costUsd: 0, cacheSavingsUsd: 0 };
  }

  const normalized = normalizeModelName(model);
  const entry = matchPricingEntry(providerPricing, normalized);
  if (!entry) {
    warnOnceUnknown(`${provider}:${model}`, `unknown ${provider} model "${model}"`);
    return { costUsd: 0, cacheSavingsUsd: 0 };
  }

  const mult = CACHE_MULTIPLIERS[provider];
  const read = Math.max(0, cachedReadTokens);
  const write = Math.max(0, cachedWriteTokens);
  const uncached = Math.max(0, promptTokens - read - write);
  const inRate = entry.inputPer1M / 1_000_000;
  const inputCost =
    uncached * inRate + read * inRate * mult.read + write * inRate * mult.write;
  const outputCost = (completionTokens / 1_000_000) * entry.outputPer1M;
  const cacheSavingsUsd = read * inRate * (1 - mult.read);
  return {
    costUsd: Math.round((inputCost + outputCost) * 1_000_000) / 1_000_000,
    cacheSavingsUsd: Math.round(cacheSavingsUsd * 1_000_000) / 1_000_000,
  };
}

/**
 * Strip resource-path prefixes from a model name so PRICING lookup succeeds.
 *
 * Handles:
 * - "models/gemini-2.0-flash" → "gemini-2.0-flash"
 * - "publishers/google/models/gemini-2.0-flash" → "gemini-2.0-flash"
 * - "projects/p/locations/l/publishers/google/models/gemini-2.0-flash" → "gemini-2.0-flash"
 * - "tunedModels/abc-123" → "abc-123" (unknown model = warn + 0 later)
 */
export function normalizeModelName(model: string): string {
  if (!model.includes("/")) return model;
  const parts = model.split("/");
  return parts[parts.length - 1] ?? model;
}

function warnOnceUnknown(key: string, message: string): void {
  if (warnedUnknownModels.has(key)) return;
  warnedUnknownModels.add(key);
  // eslint-disable-next-line no-console
  console.warn(
    `[argosvix] ${message} — pricing returned 0. Cost for this model will not be tracked` +
      ` until the SDK's pricing table is updated. Check for a newer @argosvix/sdk release.`,
  );
}

/** Test-only helper: reset the warn-once state. Do not call from production code. */
export function __resetPricingWarnings(): void {
  warnedUnknownModels.clear();
}

/**
 * Pricing lookup: exact match first, then longest-prefix match.
 * Handles version-suffixed model IDs such as "gpt-4o-2024-08-06" → "gpt-4o".
 */
function matchPricingEntry(
  providerPricing: Record<string, PricingEntry>,
  model: string,
): PricingEntry | null {
  if (providerPricing[model]) return providerPricing[model];

  let bestPrefix = "";
  for (const knownModel of Object.keys(providerPricing)) {
    if (model.startsWith(knownModel) && knownModel.length > bestPrefix.length) {
      bestPrefix = knownModel;
    }
  }
  return bestPrefix ? (providerPricing[bestPrefix] ?? null) : null;
}
