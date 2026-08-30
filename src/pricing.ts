import type { PricingEntry, Provider } from "./types.js";

const warnedUnknownModels = new Set<string>();

/**
 * USD pricing per 1M tokens.
 * Sourced from each provider's official pricing page. Prices fluctuate
 * quarterly — re-verify before any production launch.
 *
 * Sources (base snapshot 2026-06-12; per-provider re-verification dates are
 * noted inline — OpenAI 2026-07-12, Mistral 2026-07-13):
 * - OpenAI:    https://developers.openai.com/api/docs/pricing
 * - Anthropic: https://platform.claude.com/docs/en/docs/about-claude/pricing
 * - Google:    https://ai.google.dev/gemini-api/docs/pricing
 * - Mistral:   https://mistral.ai/pricing/api
 */
export const PRICING: Record<Provider, Record<string, PricingEntry>> = {
  openai: {
    // GPT-5.6 family (GA 2026-07-09; verified 2026-07-12 on the official pricing page).
    // 段階単価(各モデルのページで 2026-07-26 照合)。公式の文言は
    // "Prompts with >272K input tokens are priced at 2x input and 1.5x output for the
    // full request." = **超えたら**なので、閾値は 272_001 で持つ。
    // 🔴 **キャッシュ入力を 2 倍にするかは公式に明記が無い**(入力・出力しか書いていない)。
    //    ここは推測で 2 倍にしている。xAI と Gemini はどちらもキャッシュ入力を明示的に
    //    2 倍にしているので、そろえた。⚠ 実請求と突き合わせる機会があれば確認する。
    // 以下は段階を持たないモデルについての元コメント:
    // Long-context tiers (e.g. Sol $10/$45 above the threshold) are not modeled — we do
    // not track per-call context size, so the standard short-context rate applies
    // (same accepted limitation as gemini-2.5-pro below).
    // Plain "gpt-5.6" is an official alias for gpt-5.6-sol (models page, 2026-07-12)
    "gpt-5.6": { inputPer1M: 4.0, outputPer1M: 20.0, cachedInputPer1M: 0.4 , longContext: { thresholdPromptTokens: 272_001, inputPer1M: 8.0, outputPer1M: 30.0, cachedInputPer1M: 0.8 } },
    "gpt-5.6-sol": { inputPer1M: 4.0, outputPer1M: 20.0, cachedInputPer1M: 0.4 , longContext: { thresholdPromptTokens: 272_001, inputPer1M: 8.0, outputPer1M: 30.0, cachedInputPer1M: 0.8 } },
    "gpt-5.6-terra": { inputPer1M: 2.0, outputPer1M: 12.0, cachedInputPer1M: 0.2 , longContext: { thresholdPromptTokens: 272_001, inputPer1M: 4.0, outputPer1M: 18.0, cachedInputPer1M: 0.4 } },
    "gpt-5.6-luna": { inputPer1M: 0.2, outputPer1M: 1.2, cachedInputPer1M: 0.02 , longContext: { thresholdPromptTokens: 272_001, inputPer1M: 0.4, outputPer1M: 1.8, cachedInputPer1M: 0.04 } },
    "gpt-5.5": { inputPer1M: 5.0, outputPer1M: 30.0, cachedInputPer1M: 0.5 , longContext: { thresholdPromptTokens: 272_001, inputPer1M: 10.0, outputPer1M: 45.0, cachedInputPer1M: 1.0 } },
    // xAI Grok fallback (primary entries live under the "xai" provider block below;
    // kept here for legacy SDKs / unknown-host OpenAI-compatible calls).
    // ⚠ createOpenAI({ baseURL: "https://api.x.ai/v1" }) のような経路は provider が
    //    "openai" のまま届くので、ここに無いとコスト 0 の行になる(2026-07-26 追加)。
    "grok-4.6": { inputPer1M: 2.0, outputPer1M: 6.0, cachedInputPer1M: 0.5 , longContext: { thresholdPromptTokens: 200_000, inputPer1M: 4.0, outputPer1M: 12.0, cachedInputPer1M: 1.0 } },
    "grok-4.5": { inputPer1M: 2.0, outputPer1M: 6.0, cachedInputPer1M: 0.3 , longContext: { thresholdPromptTokens: 200_000, inputPer1M: 4.0, outputPer1M: 12.0, cachedInputPer1M: 0.6 } },
    "grok-4.3": { inputPer1M: 1.25, outputPer1M: 2.5, cachedInputPer1M: 0.2 , longContext: { thresholdPromptTokens: 200_000, inputPer1M: 2.5, outputPer1M: 5.0, cachedInputPer1M: 0.4 } },
    "grok-4.20-reasoning": { inputPer1M: 1.25, outputPer1M: 2.5, cachedInputPer1M: 0.2 , longContext: { thresholdPromptTokens: 200_000, inputPer1M: 2.5, outputPer1M: 5.0, cachedInputPer1M: 0.4 } },
    "grok-4.20-non-reasoning": { inputPer1M: 1.25, outputPer1M: 2.5, cachedInputPer1M: 0.2 , longContext: { thresholdPromptTokens: 200_000, inputPer1M: 2.5, outputPer1M: 5.0, cachedInputPer1M: 0.4 } },
    "grok-4.20-0309-reasoning": { inputPer1M: 1.25, outputPer1M: 2.5, cachedInputPer1M: 0.2 , longContext: { thresholdPromptTokens: 200_000, inputPer1M: 2.5, outputPer1M: 5.0, cachedInputPer1M: 0.4 } },
    "grok-4.20-0309-non-reasoning": { inputPer1M: 1.25, outputPer1M: 2.5, cachedInputPer1M: 0.2 , longContext: { thresholdPromptTokens: 200_000, inputPer1M: 2.5, outputPer1M: 5.0, cachedInputPer1M: 0.4 } },
    "grok-4.20-multi-agent-0309": { inputPer1M: 1.25, outputPer1M: 2.5, cachedInputPer1M: 0.2 , longContext: { thresholdPromptTokens: 200_000, inputPer1M: 2.5, outputPer1M: 5.0, cachedInputPer1M: 0.4 } },
    "grok-build-0.1": { inputPer1M: 1.0, outputPer1M: 2.0, cachedInputPer1M: 0.2 , longContext: { thresholdPromptTokens: 200_000, inputPer1M: 2.0, outputPer1M: 4.0, cachedInputPer1M: 0.4 } },
    "grok-latest": { inputPer1M: 1.25, outputPer1M: 2.5, cachedInputPer1M: 0.2 , longContext: { thresholdPromptTokens: 200_000, inputPer1M: 2.5, outputPer1M: 5.0, cachedInputPer1M: 0.4 } },
    "grok-build-latest": { inputPer1M: 2.0, outputPer1M: 6.0, cachedInputPer1M: 0.3 , longContext: { thresholdPromptTokens: 200_000, inputPer1M: 4.0, outputPer1M: 12.0, cachedInputPer1M: 0.6 } },
    // ⚠ grok-build-0.1 の別名は名前が似ている grok-build-latest ではなく grok-code-fast-*。
    //    別名は「どのモデルのページに載っているか」で決まる。名前の形で判断しない
    //    (2026-07-26 に同じ間違いを 2 回した)。
    "grok-code-fast-1": { inputPer1M: 1.0, outputPer1M: 2.0, cachedInputPer1M: 0.2 , longContext: { thresholdPromptTokens: 200_000, inputPer1M: 2.0, outputPer1M: 4.0, cachedInputPer1M: 0.4 } },
    "grok-code-fast": { inputPer1M: 1.0, outputPer1M: 2.0, cachedInputPer1M: 0.2 , longContext: { thresholdPromptTokens: 200_000, inputPer1M: 2.0, outputPer1M: 4.0, cachedInputPer1M: 0.4 } },
    "grok-code-fast-1-0825": { inputPer1M: 1.0, outputPer1M: 2.0, cachedInputPer1M: 0.2 , longContext: { thresholdPromptTokens: 200_000, inputPer1M: 2.0, outputPer1M: 4.0, cachedInputPer1M: 0.4 } },
    // 4.20 系の別名(公式 3 ページから読んだ 27 件。単価はどれも同一)
    "grok-4.20-reasoning-latest": { inputPer1M: 1.25, outputPer1M: 2.5, cachedInputPer1M: 0.2 , longContext: { thresholdPromptTokens: 200_000, inputPer1M: 2.5, outputPer1M: 5.0, cachedInputPer1M: 0.4 } },
    "grok-4.20": { inputPer1M: 1.25, outputPer1M: 2.5, cachedInputPer1M: 0.2 , longContext: { thresholdPromptTokens: 200_000, inputPer1M: 2.5, outputPer1M: 5.0, cachedInputPer1M: 0.4 } },
    "grok-4.20-0309": { inputPer1M: 1.25, outputPer1M: 2.5, cachedInputPer1M: 0.2 , longContext: { thresholdPromptTokens: 200_000, inputPer1M: 2.5, outputPer1M: 5.0, cachedInputPer1M: 0.4 } },
    "grok-4.20-beta-0309-reasoning": { inputPer1M: 1.25, outputPer1M: 2.5, cachedInputPer1M: 0.2 , longContext: { thresholdPromptTokens: 200_000, inputPer1M: 2.5, outputPer1M: 5.0, cachedInputPer1M: 0.4 } },
    "grok-4.20-beta": { inputPer1M: 1.25, outputPer1M: 2.5, cachedInputPer1M: 0.2 , longContext: { thresholdPromptTokens: 200_000, inputPer1M: 2.5, outputPer1M: 5.0, cachedInputPer1M: 0.4 } },
    "grok-4.20-beta-0309": { inputPer1M: 1.25, outputPer1M: 2.5, cachedInputPer1M: 0.2 , longContext: { thresholdPromptTokens: 200_000, inputPer1M: 2.5, outputPer1M: 5.0, cachedInputPer1M: 0.4 } },
    "grok-4.20-beta-latest": { inputPer1M: 1.25, outputPer1M: 2.5, cachedInputPer1M: 0.2 , longContext: { thresholdPromptTokens: 200_000, inputPer1M: 2.5, outputPer1M: 5.0, cachedInputPer1M: 0.4 } },
    "grok-4.20-beta-latest-reasoning": { inputPer1M: 1.25, outputPer1M: 2.5, cachedInputPer1M: 0.2 , longContext: { thresholdPromptTokens: 200_000, inputPer1M: 2.5, outputPer1M: 5.0, cachedInputPer1M: 0.4 } },
    "grok-4.20-beta-reasoning": { inputPer1M: 1.25, outputPer1M: 2.5, cachedInputPer1M: 0.2 , longContext: { thresholdPromptTokens: 200_000, inputPer1M: 2.5, outputPer1M: 5.0, cachedInputPer1M: 0.4 } },
    "grok-4.20-experimental-beta-0304-reasoning": { inputPer1M: 1.25, outputPer1M: 2.5, cachedInputPer1M: 0.2 , longContext: { thresholdPromptTokens: 200_000, inputPer1M: 2.5, outputPer1M: 5.0, cachedInputPer1M: 0.4 } },
    "grok-4.20-experimental-beta-0304": { inputPer1M: 1.25, outputPer1M: 2.5, cachedInputPer1M: 0.2 , longContext: { thresholdPromptTokens: 200_000, inputPer1M: 2.5, outputPer1M: 5.0, cachedInputPer1M: 0.4 } },
    "grok-4.20-experimental-beta-reasoning-latest": { inputPer1M: 1.25, outputPer1M: 2.5, cachedInputPer1M: 0.2 , longContext: { thresholdPromptTokens: 200_000, inputPer1M: 2.5, outputPer1M: 5.0, cachedInputPer1M: 0.4 } },
    "grok-4.20-experimental-beta-latest": { inputPer1M: 1.25, outputPer1M: 2.5, cachedInputPer1M: 0.2 , longContext: { thresholdPromptTokens: 200_000, inputPer1M: 2.5, outputPer1M: 5.0, cachedInputPer1M: 0.4 } },
    "grok-4.20-reasoning-gv2": { inputPer1M: 1.25, outputPer1M: 2.5, cachedInputPer1M: 0.2 , longContext: { thresholdPromptTokens: 200_000, inputPer1M: 2.5, outputPer1M: 5.0, cachedInputPer1M: 0.4 } },
    "grok-4.20-non-reasoning-latest": { inputPer1M: 1.25, outputPer1M: 2.5, cachedInputPer1M: 0.2 , longContext: { thresholdPromptTokens: 200_000, inputPer1M: 2.5, outputPer1M: 5.0, cachedInputPer1M: 0.4 } },
    "grok-4.20-beta-non-reasoning": { inputPer1M: 1.25, outputPer1M: 2.5, cachedInputPer1M: 0.2 , longContext: { thresholdPromptTokens: 200_000, inputPer1M: 2.5, outputPer1M: 5.0, cachedInputPer1M: 0.4 } },
    "grok-4.20-beta-latest-non-reasoning": { inputPer1M: 1.25, outputPer1M: 2.5, cachedInputPer1M: 0.2 , longContext: { thresholdPromptTokens: 200_000, inputPer1M: 2.5, outputPer1M: 5.0, cachedInputPer1M: 0.4 } },
    "grok-4.20-experimental-beta-0304-non-reasoning": { inputPer1M: 1.25, outputPer1M: 2.5, cachedInputPer1M: 0.2 , longContext: { thresholdPromptTokens: 200_000, inputPer1M: 2.5, outputPer1M: 5.0, cachedInputPer1M: 0.4 } },
    "grok-4.20-experimental-beta-non-reasoning-latest": { inputPer1M: 1.25, outputPer1M: 2.5, cachedInputPer1M: 0.2 , longContext: { thresholdPromptTokens: 200_000, inputPer1M: 2.5, outputPer1M: 5.0, cachedInputPer1M: 0.4 } },
    "grok-4.20-beta-0309-non-reasoning": { inputPer1M: 1.25, outputPer1M: 2.5, cachedInputPer1M: 0.2 , longContext: { thresholdPromptTokens: 200_000, inputPer1M: 2.5, outputPer1M: 5.0, cachedInputPer1M: 0.4 } },
    "grok-4.20-non-reasoning-gv2": { inputPer1M: 1.25, outputPer1M: 2.5, cachedInputPer1M: 0.2 , longContext: { thresholdPromptTokens: 200_000, inputPer1M: 2.5, outputPer1M: 5.0, cachedInputPer1M: 0.4 } },
    "grok-4.20-multi-agent": { inputPer1M: 1.25, outputPer1M: 2.5, cachedInputPer1M: 0.2 , longContext: { thresholdPromptTokens: 200_000, inputPer1M: 2.5, outputPer1M: 5.0, cachedInputPer1M: 0.4 } },
    "grok-4.20-multi-agent-latest": { inputPer1M: 1.25, outputPer1M: 2.5, cachedInputPer1M: 0.2 , longContext: { thresholdPromptTokens: 200_000, inputPer1M: 2.5, outputPer1M: 5.0, cachedInputPer1M: 0.4 } },
    "grok-4.20-multi-agent-beta-latest": { inputPer1M: 1.25, outputPer1M: 2.5, cachedInputPer1M: 0.2 , longContext: { thresholdPromptTokens: 200_000, inputPer1M: 2.5, outputPer1M: 5.0, cachedInputPer1M: 0.4 } },
    "grok-4.20-multi-agent-experimental-beta-0304": { inputPer1M: 1.25, outputPer1M: 2.5, cachedInputPer1M: 0.2 , longContext: { thresholdPromptTokens: 200_000, inputPer1M: 2.5, outputPer1M: 5.0, cachedInputPer1M: 0.4 } },
    "grok-4.20-multi-agent-experimental-beta-latest": { inputPer1M: 1.25, outputPer1M: 2.5, cachedInputPer1M: 0.2 , longContext: { thresholdPromptTokens: 200_000, inputPer1M: 2.5, outputPer1M: 5.0, cachedInputPer1M: 0.4 } },
    "grok-4.20-multi-agent-beta-0309": { inputPer1M: 1.25, outputPer1M: 2.5, cachedInputPer1M: 0.2 , longContext: { thresholdPromptTokens: 200_000, inputPer1M: 2.5, outputPer1M: 5.0, cachedInputPer1M: 0.4 } },

    // Moonshot Kimi K3 fallback (unknown-host OpenAI-compatible calls still arrive as
    // "openai"; primary entry lives under the "moonshot" provider block below)
    "kimi-k3": { inputPer1M: 3.0, outputPer1M: 15.0, cachedInputPer1M: 0.3 },
    // Qwen fallback (unknown-host OpenAI-compatible calls; primary entry lives
    // under the "alibaba" provider block below)
    "qwen3.8-max": { inputPer1M: 2.0, outputPer1M: 6.0, cachedInputPer1M: 0.25 },
    "qwen3.8-flash": { inputPer1M: 0.16, outputPer1M: 0.47, cachedInputPer1M: 0.016 },
    // Z.ai GLM-5.3-Flash(docs.z.ai/guides/overview/pricing、2026-08-27 照合)。
    // 標準単価を採る。2026-09-09 24:00 UTC+8 まで半額プロモ($0.075/$0.25)が
    // 走っているが期限付きのため表には載せない。z.ai の baseURL 判別は未対応なので
    // OpenAI 互換呼び出しは "openai" として届く(判別を足したら実プロバイダー化する)
    "glm-5.3-flash": { inputPer1M: 0.15, outputPer1M: 0.5, cachedInputPer1M: 0.03 },
    // DeepSeek fallback (legacy SDKs / unknown-host OpenAI-compatible calls;
    // primary entries live under the "deepseek" provider block below)
    "deepseek-v4-flash": { inputPer1M: 0.14, outputPer1M: 0.28, cachedInputPer1M: 0.0028 },
    "deepseek-v4-pro": { inputPer1M: 0.435, outputPer1M: 0.87, cachedInputPer1M: 0.003625 },
    "deepseek-chat": { inputPer1M: 0.14, outputPer1M: 0.28, cachedInputPer1M: 0.0028 },
    "deepseek-reasoner": { inputPer1M: 0.14, outputPer1M: 0.28, cachedInputPer1M: 0.0028 },
    "gpt-5.4": { inputPer1M: 2.5, outputPer1M: 15.0, cachedInputPer1M: 0.25 },
    "gpt-5.4-mini": { inputPer1M: 0.75, outputPer1M: 4.5, cachedInputPer1M: 0.075 },
    "gpt-5.4-nano": { inputPer1M: 0.2, outputPer1M: 1.25, cachedInputPer1M: 0.02 },
    "gpt-5.3-codex": { inputPer1M: 1.75, outputPer1M: 14.0, cachedInputPer1M: 0.175 },
    "gpt-5-mini": { inputPer1M: 0.15, outputPer1M: 0.6 },
    "gpt-5-nano": { inputPer1M: 0.05, outputPer1M: 0.2 },
    "gpt-4o": { inputPer1M: 2.5, outputPer1M: 10.0 },
    "gpt-4o-mini": { inputPer1M: 0.15, outputPer1M: 0.6 },
    "o1": { inputPer1M: 15.0, outputPer1M: 60.0 },
    "o1-mini": { inputPer1M: 3.0, outputPer1M: 12.0 },
  },
  // 2026-07-17: OpenAI 互換勢の実プロバイダー(SDK が baseURL から判別して送る)
  xai: {
    // 2026-08-12 リリース(x.ai/news/grok-4-6)。docs.x.ai/docs/models/grok-4.6 で
    // 2026-08-13 照合。4.5 と違いキャッシュ入力の段階($0.50 / $1.00)まで公式ページに
    // 明記あり(推測ではない)。別名の記載なし(載ったら追加する)
    "grok-4.6": { inputPer1M: 2.0, outputPer1M: 6.0, cachedInputPer1M: 0.5 , longContext: { thresholdPromptTokens: 200_000, inputPer1M: 4.0, outputPer1M: 12.0, cachedInputPer1M: 1.0 } },
    // $2/M in, $6/M out (docs.x.ai、2026-07-09 照合)
    "grok-4.5": { inputPer1M: 2.0, outputPer1M: 6.0, cachedInputPer1M: 0.3 , longContext: { thresholdPromptTokens: 200_000, inputPer1M: 4.0, outputPer1M: 12.0, cachedInputPer1M: 0.6 } },
    // 2026-07-26 追加(docs.x.ai/docs/models で照合)。フレームワーク経由の判別を
    // 足したことで、これらの型が実際に "xai" として届くようになった。載っていないと
    // コスト 0 の行が積み上がる。⚠ 20 万トークン超は単価が上がるが、表は段階を
    // 持たないので低い方(既存の grok-4.5 と同じ扱い)。
    "grok-4.3": { inputPer1M: 1.25, outputPer1M: 2.5, cachedInputPer1M: 0.2 , longContext: { thresholdPromptTokens: 200_000, inputPer1M: 2.5, outputPer1M: 5.0, cachedInputPer1M: 0.4 } },
    "grok-4.20-reasoning": { inputPer1M: 1.25, outputPer1M: 2.5, cachedInputPer1M: 0.2 , longContext: { thresholdPromptTokens: 200_000, inputPer1M: 2.5, outputPer1M: 5.0, cachedInputPer1M: 0.4 } },
    "grok-4.20-non-reasoning": { inputPer1M: 1.25, outputPer1M: 2.5, cachedInputPer1M: 0.2 , longContext: { thresholdPromptTokens: 200_000, inputPer1M: 2.5, outputPer1M: 5.0, cachedInputPer1M: 0.4 } },
    "grok-4.20-0309-reasoning": { inputPer1M: 1.25, outputPer1M: 2.5, cachedInputPer1M: 0.2 , longContext: { thresholdPromptTokens: 200_000, inputPer1M: 2.5, outputPer1M: 5.0, cachedInputPer1M: 0.4 } },
    "grok-4.20-0309-non-reasoning": { inputPer1M: 1.25, outputPer1M: 2.5, cachedInputPer1M: 0.2 , longContext: { thresholdPromptTokens: 200_000, inputPer1M: 2.5, outputPer1M: 5.0, cachedInputPer1M: 0.4 } },
    "grok-4.20-multi-agent-0309": { inputPer1M: 1.25, outputPer1M: 2.5, cachedInputPer1M: 0.2 , longContext: { thresholdPromptTokens: 200_000, inputPer1M: 2.5, outputPer1M: 5.0, cachedInputPer1M: 0.4 } },
    "grok-build-0.1": { inputPer1M: 1.0, outputPer1M: 2.0, cachedInputPer1M: 0.2 , longContext: { thresholdPromptTokens: 200_000, inputPer1M: 2.0, outputPer1M: 4.0, cachedInputPer1M: 0.4 } },
    // ⚠ 別名は「最新版だろう」と推測せず、公式の各モデルページに載っている一覧を見る。
    //    docs.x.ai/docs/models/grok-4.3 に「grok-4.3-latest, grok-latest」、
    //    同 grok-4.5 に「grok-4.5-latest, grok-build-latest」と明記されている。
    //    ⚠ grok-latest が指すのは 4.5 ではなく **4.3**(2026-07-26 に取り違えた)。
    //    grok-build-latest も、剥がすと "grok-build" になって表に無い = 0 円になるので明示する。
    "grok-latest": { inputPer1M: 1.25, outputPer1M: 2.5, cachedInputPer1M: 0.2 , longContext: { thresholdPromptTokens: 200_000, inputPer1M: 2.5, outputPer1M: 5.0, cachedInputPer1M: 0.4 } },
    "grok-build-latest": { inputPer1M: 2.0, outputPer1M: 6.0, cachedInputPer1M: 0.3 , longContext: { thresholdPromptTokens: 200_000, inputPer1M: 4.0, outputPer1M: 12.0, cachedInputPer1M: 0.6 } },
    // ⚠ grok-build-0.1 の別名は名前が似ている grok-build-latest ではなく grok-code-fast-*。
    //    別名は「どのモデルのページに載っているか」で決まる。名前の形で判断しない
    //    (2026-07-26 に同じ間違いを 2 回した)。
    "grok-code-fast-1": { inputPer1M: 1.0, outputPer1M: 2.0, cachedInputPer1M: 0.2 , longContext: { thresholdPromptTokens: 200_000, inputPer1M: 2.0, outputPer1M: 4.0, cachedInputPer1M: 0.4 } },
    "grok-code-fast": { inputPer1M: 1.0, outputPer1M: 2.0, cachedInputPer1M: 0.2 , longContext: { thresholdPromptTokens: 200_000, inputPer1M: 2.0, outputPer1M: 4.0, cachedInputPer1M: 0.4 } },
    "grok-code-fast-1-0825": { inputPer1M: 1.0, outputPer1M: 2.0, cachedInputPer1M: 0.2 , longContext: { thresholdPromptTokens: 200_000, inputPer1M: 2.0, outputPer1M: 4.0, cachedInputPer1M: 0.4 } },
    // 4.20 系の別名(公式 3 ページから読んだ 27 件。単価はどれも同一)
    "grok-4.20-reasoning-latest": { inputPer1M: 1.25, outputPer1M: 2.5, cachedInputPer1M: 0.2 , longContext: { thresholdPromptTokens: 200_000, inputPer1M: 2.5, outputPer1M: 5.0, cachedInputPer1M: 0.4 } },
    "grok-4.20": { inputPer1M: 1.25, outputPer1M: 2.5, cachedInputPer1M: 0.2 , longContext: { thresholdPromptTokens: 200_000, inputPer1M: 2.5, outputPer1M: 5.0, cachedInputPer1M: 0.4 } },
    "grok-4.20-0309": { inputPer1M: 1.25, outputPer1M: 2.5, cachedInputPer1M: 0.2 , longContext: { thresholdPromptTokens: 200_000, inputPer1M: 2.5, outputPer1M: 5.0, cachedInputPer1M: 0.4 } },
    "grok-4.20-beta-0309-reasoning": { inputPer1M: 1.25, outputPer1M: 2.5, cachedInputPer1M: 0.2 , longContext: { thresholdPromptTokens: 200_000, inputPer1M: 2.5, outputPer1M: 5.0, cachedInputPer1M: 0.4 } },
    "grok-4.20-beta": { inputPer1M: 1.25, outputPer1M: 2.5, cachedInputPer1M: 0.2 , longContext: { thresholdPromptTokens: 200_000, inputPer1M: 2.5, outputPer1M: 5.0, cachedInputPer1M: 0.4 } },
    "grok-4.20-beta-0309": { inputPer1M: 1.25, outputPer1M: 2.5, cachedInputPer1M: 0.2 , longContext: { thresholdPromptTokens: 200_000, inputPer1M: 2.5, outputPer1M: 5.0, cachedInputPer1M: 0.4 } },
    "grok-4.20-beta-latest": { inputPer1M: 1.25, outputPer1M: 2.5, cachedInputPer1M: 0.2 , longContext: { thresholdPromptTokens: 200_000, inputPer1M: 2.5, outputPer1M: 5.0, cachedInputPer1M: 0.4 } },
    "grok-4.20-beta-latest-reasoning": { inputPer1M: 1.25, outputPer1M: 2.5, cachedInputPer1M: 0.2 , longContext: { thresholdPromptTokens: 200_000, inputPer1M: 2.5, outputPer1M: 5.0, cachedInputPer1M: 0.4 } },
    "grok-4.20-beta-reasoning": { inputPer1M: 1.25, outputPer1M: 2.5, cachedInputPer1M: 0.2 , longContext: { thresholdPromptTokens: 200_000, inputPer1M: 2.5, outputPer1M: 5.0, cachedInputPer1M: 0.4 } },
    "grok-4.20-experimental-beta-0304-reasoning": { inputPer1M: 1.25, outputPer1M: 2.5, cachedInputPer1M: 0.2 , longContext: { thresholdPromptTokens: 200_000, inputPer1M: 2.5, outputPer1M: 5.0, cachedInputPer1M: 0.4 } },
    "grok-4.20-experimental-beta-0304": { inputPer1M: 1.25, outputPer1M: 2.5, cachedInputPer1M: 0.2 , longContext: { thresholdPromptTokens: 200_000, inputPer1M: 2.5, outputPer1M: 5.0, cachedInputPer1M: 0.4 } },
    "grok-4.20-experimental-beta-reasoning-latest": { inputPer1M: 1.25, outputPer1M: 2.5, cachedInputPer1M: 0.2 , longContext: { thresholdPromptTokens: 200_000, inputPer1M: 2.5, outputPer1M: 5.0, cachedInputPer1M: 0.4 } },
    "grok-4.20-experimental-beta-latest": { inputPer1M: 1.25, outputPer1M: 2.5, cachedInputPer1M: 0.2 , longContext: { thresholdPromptTokens: 200_000, inputPer1M: 2.5, outputPer1M: 5.0, cachedInputPer1M: 0.4 } },
    "grok-4.20-reasoning-gv2": { inputPer1M: 1.25, outputPer1M: 2.5, cachedInputPer1M: 0.2 , longContext: { thresholdPromptTokens: 200_000, inputPer1M: 2.5, outputPer1M: 5.0, cachedInputPer1M: 0.4 } },
    "grok-4.20-non-reasoning-latest": { inputPer1M: 1.25, outputPer1M: 2.5, cachedInputPer1M: 0.2 , longContext: { thresholdPromptTokens: 200_000, inputPer1M: 2.5, outputPer1M: 5.0, cachedInputPer1M: 0.4 } },
    "grok-4.20-beta-non-reasoning": { inputPer1M: 1.25, outputPer1M: 2.5, cachedInputPer1M: 0.2 , longContext: { thresholdPromptTokens: 200_000, inputPer1M: 2.5, outputPer1M: 5.0, cachedInputPer1M: 0.4 } },
    "grok-4.20-beta-latest-non-reasoning": { inputPer1M: 1.25, outputPer1M: 2.5, cachedInputPer1M: 0.2 , longContext: { thresholdPromptTokens: 200_000, inputPer1M: 2.5, outputPer1M: 5.0, cachedInputPer1M: 0.4 } },
    "grok-4.20-experimental-beta-0304-non-reasoning": { inputPer1M: 1.25, outputPer1M: 2.5, cachedInputPer1M: 0.2 , longContext: { thresholdPromptTokens: 200_000, inputPer1M: 2.5, outputPer1M: 5.0, cachedInputPer1M: 0.4 } },
    "grok-4.20-experimental-beta-non-reasoning-latest": { inputPer1M: 1.25, outputPer1M: 2.5, cachedInputPer1M: 0.2 , longContext: { thresholdPromptTokens: 200_000, inputPer1M: 2.5, outputPer1M: 5.0, cachedInputPer1M: 0.4 } },
    "grok-4.20-beta-0309-non-reasoning": { inputPer1M: 1.25, outputPer1M: 2.5, cachedInputPer1M: 0.2 , longContext: { thresholdPromptTokens: 200_000, inputPer1M: 2.5, outputPer1M: 5.0, cachedInputPer1M: 0.4 } },
    "grok-4.20-non-reasoning-gv2": { inputPer1M: 1.25, outputPer1M: 2.5, cachedInputPer1M: 0.2 , longContext: { thresholdPromptTokens: 200_000, inputPer1M: 2.5, outputPer1M: 5.0, cachedInputPer1M: 0.4 } },
    "grok-4.20-multi-agent": { inputPer1M: 1.25, outputPer1M: 2.5, cachedInputPer1M: 0.2 , longContext: { thresholdPromptTokens: 200_000, inputPer1M: 2.5, outputPer1M: 5.0, cachedInputPer1M: 0.4 } },
    "grok-4.20-multi-agent-latest": { inputPer1M: 1.25, outputPer1M: 2.5, cachedInputPer1M: 0.2 , longContext: { thresholdPromptTokens: 200_000, inputPer1M: 2.5, outputPer1M: 5.0, cachedInputPer1M: 0.4 } },
    "grok-4.20-multi-agent-beta-latest": { inputPer1M: 1.25, outputPer1M: 2.5, cachedInputPer1M: 0.2 , longContext: { thresholdPromptTokens: 200_000, inputPer1M: 2.5, outputPer1M: 5.0, cachedInputPer1M: 0.4 } },
    "grok-4.20-multi-agent-experimental-beta-0304": { inputPer1M: 1.25, outputPer1M: 2.5, cachedInputPer1M: 0.2 , longContext: { thresholdPromptTokens: 200_000, inputPer1M: 2.5, outputPer1M: 5.0, cachedInputPer1M: 0.4 } },
    "grok-4.20-multi-agent-experimental-beta-latest": { inputPer1M: 1.25, outputPer1M: 2.5, cachedInputPer1M: 0.2 , longContext: { thresholdPromptTokens: 200_000, inputPer1M: 2.5, outputPer1M: 5.0, cachedInputPer1M: 0.4 } },
    "grok-4.20-multi-agent-beta-0309": { inputPer1M: 1.25, outputPer1M: 2.5, cachedInputPer1M: 0.2 , longContext: { thresholdPromptTokens: 200_000, inputPer1M: 2.5, outputPer1M: 5.0, cachedInputPer1M: 0.4 } },
  },
  moonshot: {
    // platform.kimi.ai/docs/pricing/chat-k3(2026-07-17 照合)
    "kimi-k3": { inputPer1M: 3.0, outputPer1M: 15.0, cachedInputPer1M: 0.3 },
  },
  deepseek: {
    // api-docs.deepseek.com/quick_start/pricing(2026-07-21 照合)。
    // 旧名 deepseek-chat / deepseek-reasoner は 2026-07-24 15:59 UTC 廃止予定で、
    // それぞれ v4-flash の非思考 / 思考モードに対応(公式に同一単価)。
    "deepseek-v4-flash": { inputPer1M: 0.14, outputPer1M: 0.28, cachedInputPer1M: 0.0028 },
    "deepseek-v4-pro": { inputPer1M: 0.435, outputPer1M: 0.87, cachedInputPer1M: 0.003625 },
    "deepseek-chat": { inputPer1M: 0.14, outputPer1M: 0.28, cachedInputPer1M: 0.0028 },
    "deepseek-reasoner": { inputPer1M: 0.14, outputPer1M: 0.28, cachedInputPer1M: 0.0028 },
  },
  alibaba: {
    // qwencloud.com/models/qwen3.8-max(2026-08-05 照合)。1M コンテキスト全域で
    // 単一単価(段階なし)。cachedInputPer1M は implicit cache の読み単価 $0.25。
    // 明示キャッシュ(作成 $2.5 / 読み $0.17)は別機能で usage に乗らないため対象外
    "qwen3.8-max": { inputPer1M: 2.0, outputPer1M: 6.0, cachedInputPer1M: 0.25 },
    // qwencloud.com/models/qwen3.8-flash(2026-08-27 照合)。Qwen3.8-Flash-Next の
    // 本番提供名。1M コンテキスト全域で単一単価(段階なし)。cachedInputPer1M は
    // implicit cache の読み単価 $0.016。明示キャッシュ(作成 $0.2 / 読み $0.016)は
    // usage に乗らないため対象外
    "qwen3.8-flash": { inputPer1M: 0.16, outputPer1M: 0.47, cachedInputPer1M: 0.016 },
  },
  anthropic: {
    // Claude 5 series
    "claude-fable-5": { inputPer1M: 10.0, outputPer1M: 50.0 },
    // ⚠ Sonnet 5 introductory pricing ($2/$10) runs through 2026-08-31;
    //   the official standard rate becomes $3/$15 on 2026-09-01 — update then.
    "claude-sonnet-5": { inputPer1M: 2.0, outputPer1M: 10.0 },
    "claude-mythos-5": { inputPer1M: 10.0, outputPer1M: 50.0 },
    // Opus 5(2026-07-24 リリース。単価は Opus 4.8 と同額 $5/$25)
    "claude-opus-5": { inputPer1M: 5.0, outputPer1M: 25.0 },
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
    // 3.6-flash / 3.5-flash-lite = API 提供開始 2026-07-21(公式単価表で 2026-07-22 照合)
    "gemini-3.6-flash": { inputPer1M: 1.5, outputPer1M: 7.5 },
    "gemini-3.5-flash-lite": { inputPer1M: 0.3, outputPer1M: 2.5 },
    "gemini-3.5-flash": { inputPer1M: 1.5, outputPer1M: 9.0 },
    // 3.1-pro has context-size pricing tiers; we use the ≤200k default (preview IDs resolve via prefix match)
    // 段階単価(ai.google.dev/gemini-api/docs/pricing、2026-07-26 照合)。
    // ⚠ 公式の表記は「prompts > 200k」= **超えたら**。xAI の「到達したら」とは境界が
    //    1 トークン違う。閾値は「高い方になる最初の値」で持つので 200_001。
    "gemini-3.1-pro": {
      inputPer1M: 2.0,
      outputPer1M: 12.0,
      cachedInputPer1M: 0.2,
      longContext: {
        thresholdPromptTokens: 200_001,
        inputPer1M: 4.0,
        outputPer1M: 18.0,
        cachedInputPer1M: 0.4,
      },
    },
    "gemini-3-flash": { inputPer1M: 0.5, outputPer1M: 3.0 },
    // Gemini 2.5 series (corrected 2026-05 against the official pricing page)
    // 2.5-pro has context-size pricing tiers; we use the ≤200k default (we do not track context size)
    "gemini-2.5-pro": {
      inputPer1M: 1.25,
      outputPer1M: 10.0,
      cachedInputPer1M: 0.125,
      longContext: {
        thresholdPromptTokens: 200_001,
        inputPer1M: 2.5,
        outputPer1M: 15.0,
        cachedInputPer1M: 0.25,
      },
    },
    "gemini-2.5-flash": { inputPer1M: 0.3, outputPer1M: 2.5 },
    // Gemini 2 series
    "gemini-2.0-flash": { inputPer1M: 0.1, outputPer1M: 0.4 },
    "gemini-2.0-pro": { inputPer1M: 1.25, outputPer1M: 5.0 },
    // Gemini 1.5 series (kept for legacy records)
    "gemini-1.5-pro": { inputPer1M: 1.25, outputPer1M: 5.0 },
    "gemini-1.5-flash": { inputPer1M: 0.075, outputPer1M: 0.3 },
  },
  mistral: {
    // Verified against https://mistral.ai/pricing/api on 2026-07-13 (the 2026-05
    // estimates were stale after Mistral's price revision; Large 3 is now cheaper
    // than Medium 3.5 per the official table).
    // Current production aliases (API-recommended IDs)
    "mistral-large-latest": { inputPer1M: 0.5, outputPer1M: 1.5 },
    "mistral-medium-latest": { inputPer1M: 1.5, outputPer1M: 7.5 },
    "mistral-small-latest": { inputPer1M: 0.15, outputPer1M: 0.6 },
    "ministral-8b-latest": { inputPer1M: 0.15, outputPer1M: 0.15 },
    "ministral-3b-latest": { inputPer1M: 0.1, outputPer1M: 0.1 },
    // Retired 2026-05-31; kept for legacy records (no longer on the pricing page)
    "pixtral-large-latest": { inputPer1M: 2.0, outputPer1M: 6.0 },
    "codestral-latest": { inputPer1M: 0.3, outputPer1M: 0.9 },
    // Open models
    "open-mistral-nemo": { inputPer1M: 0.15, outputPer1M: 0.15 },
    "open-mixtral-8x7b": { inputPer1M: 0.7, outputPer1M: 0.7 },
    "open-mixtral-8x22b": { inputPer1M: 2.0, outputPer1M: 6.0 },
    // Shorthand fallbacks (caught by prefix match against longer model IDs)
    "mistral-large": { inputPer1M: 0.5, outputPer1M: 1.5 },
    "mistral-small": { inputPer1M: 0.15, outputPer1M: 0.6 },
    "mistral-medium": { inputPer1M: 1.5, outputPer1M: 7.5 },
    "ministral-8b": { inputPer1M: 0.15, outputPer1M: 0.15 },
    "ministral-3b": { inputPer1M: 0.1, outputPer1M: 0.1 },
    "pixtral-large": { inputPer1M: 2.0, outputPer1M: 6.0 },
    "codestral": { inputPer1M: 0.3, outputPer1M: 0.9 },
  },
};

/**
 * Per-provider prompt-cache price multipliers (as a ratio of the input rate).
 *   read  = cache read (discounted) / write = cache write (premium, Anthropic only)
 * Verified 2026-06-27 against each provider's official pricing:
 *   - OpenAI automatic caching: 4o-era models read at 50% of input; 5.x models
 *     publish per-model cached prices at 10% of input (carried on each entry's
 *     cachedInputPer1M, verified 2026-07-12). GPT-5.6 also lists cache writes at
 *     125%, but OpenAI usage does not report cache-write tokens, so no write
 *     cost can be computed until the API exposes them (documented limitation).
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
  // xai / moonshot は per-model の cachedInputPer1M を持つため read 比率は未使用の
  // 保守値。write キャッシュの概念は公表なし = 1.0
  xai: { read: 1.0, write: 1.0 },
  moonshot: { read: 1.0, write: 1.0 },
  // deepseek も per-model の cachedInputPer1M(公式のキャッシュヒット単価)を持つ
  deepseek: { read: 1.0, write: 1.0 },
  // alibaba(Qwen)も per-model の cachedInputPer1M(implicit cache の読み単価)を持つ
  alibaba: { read: 1.0, write: 1.0 },
};

/**
 * Calculate USD cost for a single LLM call.
 *
 * Unknown models return 0 — preferring an explicit zero over a guessed
 * under-estimate. A separate "unknown model alert" path is planned before launch.
 */
/**
 * Coerce a token count that came out of a provider response into a usable number.
 *
 * Every one of these is reachable from real traffic, and each used to fail differently:
 * - Non-numeric (a string, an object): the `??` fallbacks at the call sites only catch
 *   null and undefined, so the value reached the arithmetic and turned the whole cost into
 *   NaN. NaN serialises to null, and ingest rejects the record as "invalid costUsd" — one
 *   odd usage field from an OpenAI-compatible host silently dropped the call.
 * - NaN specifically: `NaN >= threshold` is false, so it also picked the cheaper
 *   short-context tier without erroring.
 * - Negative: produced a negative cost, which ingest rejects the same way.
 *
 * Verified 2026-07-27 against the backend, which already clamped all three.
 */
function tokenCount(v: number): number {
  if (typeof v === "number") return Number.isFinite(v) && v > 0 ? v : 0;
  // 数字だけの文字列は受ける。OpenAI 互換のホストがトークン数を文字列で返すことがあり、
  // 捨てるとキャッシュ割引が消えて金額が実際より高く出る。
  //
  // ⚠ **言語の既定の変換に任せない。** JavaScript の Number は "0x10" を 16 に、Python の
  // float は "1_000" を 1000 にする。どちらも相手側では別の答えになるので、両方で同じに
  // 書ける形(空白を除いた 10 進数のみ)に絞る。指数表記も受けない。
  if (typeof v === "string" && /^\s*\d+(\.\d+)?\s*$/.test(v)) {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }
  return 0;
}

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
  const base = matchPricingEntry(providerPricing, normalized);
  if (!base) {
    warnOnceUnknown(`${provider}:${model}`, `unknown ${provider} model "${model}"`);
    return { costUsd: 0, cacheSavingsUsd: 0 };
  }
  const mult = CACHE_MULTIPLIERS[provider];
  // ⚠ 段階を選ぶ前にトークン数を整える。NaN は `>=` が常に false になるので、整えずに
  //    渡すと**静かに安い方の段階が選ばれる**(エラーにならない)。
  const prompt = tokenCount(promptTokens);
  // ⚠ 段階を先に選ぶ。プロンプトが閾値に**到達**したら、その要求の全トークンが高い方
  //    (超えた分だけではない)。低い方で計算すると、25 万トークンの要求がちょうど
  //    半額になり、呼び出し前の予算ゲートが止めるべき支出を通す(2026-07-26 実測)。
  const entry = selectTier(base, prompt);

  // Cached tokens are a subset of the prompt, so clamp them to it. Providers
  // occasionally report cached counts larger than the prompt itself; without the
  // clamp those extra tokens get billed on top of a prompt that already counted
  // them, and the cost silently comes out high. `uncached` alone does not catch
  // it because it floors at 0 while read/write keep their inflated values.
  // The backend table already clamps, so leaving it out here also made the same
  // call price differently depending on where it was computed.
  const read = Math.min(tokenCount(cachedReadTokens), prompt);
  const write = Math.min(tokenCount(cachedWriteTokens), prompt - read);
  const uncached = prompt - read - write;
  const inRate = entry.inputPer1M / 1_000_000;
  // Per-model cached price wins over the provider-wide ratio (OpenAI 5.x = 10%
  // of input vs the 4o-era 50%; carried per entry, verified 2026-07-12).
  const readRate =
    entry.cachedInputPer1M !== undefined
      ? entry.cachedInputPer1M / 1_000_000
      : inRate * mult.read;
  const inputCost =
    uncached * inRate + read * readRate + write * inRate * mult.write;
  const outputCost = (tokenCount(completionTokens) / 1_000_000) * entry.outputPer1M;
  const cacheSavingsUsd = read * (inRate - readRate);
  return {
    costUsd: Math.round((inputCost + outputCost) * 1_000_000) / 1_000_000,
    cacheSavingsUsd: Math.round(cacheSavingsUsd * 1_000_000) / 1_000_000,
  };
}

/**
 * Whether this model resolves to a pricing entry (exactly, or via the alias / dated-suffix
 * rules). Mirrors the backend's `isPriced`.
 *
 * ⚠ Use this instead of `calculateCost(...) > 0` when you mean "do we know this model".
 * A cost of 0 is also what a genuinely free model would return, so the two questions are not
 * the same, and conflating them makes a promotional zero-rate model look unknown
 * (2026-07-27 round 9).
 *
 * @internal ⚠ **公開 API ではない。** パッケージの入口(index.ts)からは出していない。
 * 料金表の照合スクリプトが直接この module を読むためだけに export している。公開すると
 * 未来永劫支える約束になるので、増やすなら意図して増やす(2026-07-27 round 10)。
 */
export function isPricedModel(provider: Provider, model: string): boolean {
  const table = PRICING[provider];
  if (!table) return false;
  return matchPricingEntry(table, normalizeModelName(model)) !== null;
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
/**
 * プロンプトの量から段階を選ぶ。段階を持たないモデルはそのまま返す。
 *
 * ⚠ 比較は「以上」。公式の表記が reaches(到達)なので、ちょうど閾値の要求は
 * 高い方になる。ここを「超えたら」にすると、境界ちょうどの要求だけ半額になる。
 */
export function selectTier(entry: PricingEntry, promptTokens: number): PricingEntry {
  const t = entry.longContext;
  if (!t || !(promptTokens >= t.thresholdPromptTokens)) return entry;
  return t.cachedInputPer1M === undefined
    ? { inputPer1M: t.inputPer1M, outputPer1M: t.outputPer1M }
    : {
        inputPer1M: t.inputPer1M,
        outputPer1M: t.outputPer1M,
        cachedInputPer1M: t.cachedInputPer1M,
      };
}

function matchPricingEntry(
  providerPricing: Record<string, PricingEntry>,
  model: string,
): PricingEntry | null {
  if (providerPricing[model]) return providerPricing[model];

  // ⚠ 「-latest」は各社が使う別名で、同じ系列の最新版を指す(x.ai は「<名前>-latest は
  //    最新版」と明記)。剥がして同じ系列の値で計算する。剥がさないと、別名で呼んだ
  //    利用者だけコスト 0 の行になる(2026-07-26 publish ゲートで検出)。
  if (model.endsWith("-latest")) {
    const base = model.slice(0, -"-latest".length);
    if (providerPricing[base]) return providerPricing[base];
  }

  // prefix match は「version/date 派生」だけに限定する(backend livePricing の
  // matchPricing と同一規則)。素の startsWith は feature 派生(-audio-preview /
  // -fast 等)や未知の派生まで base の低単価で吸収し、実コストと乖離する
  // (2026-07-24 Opus 5 publish ゲートで Codex が検出。backend は厳格、SDK は
  // 緩いという不整合だった)。key の直後が「- + 数字」の時だけ許可 =
  // claude-opus-5-20260724 は解決、claude-opus-5-audio-preview は未知に倒す。
  // prefix match は「version/date 派生」だけに限定する(backend livePricing の
  // matchPricing と同一規則: key の直後が「- + 数字」)。加えて SDK 側は旧世代の
  // 裸 key(claude-opus-4 等)を持つため、存在しない claude-opus-4-80 /-800 が
  // 旧世代の高単価($15/$75)に吸われる衝突が起きる。より長い既知 key と同じ
  // 前置きを共有する model は「その長い key の未知派生」とみなして fail-closed に
  // 倒す(2026-07-24 Opus 5 publish ゲートで 2 度検出。backend の期待値と一致)。
  const keys = Object.keys(providerPricing);
  let bestPrefix = "";
  for (const knownModel of keys) {
    if (!model.startsWith(`${knownModel}-`)) continue;
    const next = model.charAt(knownModel.length + 1);
    if (next < "0" || next > "9") continue;
    // 例: model=claude-opus-4-800 / knownModel=claude-opus-4 のとき、
    // claude-opus-4-8 という「より長い既知 key」が model の前置きを共有する
    // → 4-8 の未知派生とみなして採用しない。
    const shadowedByLonger = keys.some(
      (other) =>
        other !== knownModel &&
        other.length > knownModel.length &&
        other.startsWith(`${knownModel}-`) &&
        model.startsWith(other),
    );
    if (shadowedByLonger) continue;
    if (knownModel.length > bestPrefix.length) bestPrefix = knownModel;
  }
  return bestPrefix ? (providerPricing[bestPrefix] ?? null) : null;
}
