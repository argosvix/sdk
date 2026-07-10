import { getRecorder } from "./client.js";

/**
 * Helper for short-lived runtimes (Cloudflare Workers, AWS Lambda, Vercel Edge)
 * that explicitly flushes a wrapped client's buffer and awaits backend delivery.
 *
 * In these runtimes, outstanding fire-and-forget fetches are killed when the
 * handler returns. The SDK's auto-flush fires when `bufferMaxSize` is reached
 * (default 100) or on the idle timer (`flushIntervalMs`, default 5000ms) — but
 * a short-lived handler typically exits before either fires, so a single
 * request with a few LLM calls would lose its records on context exit.
 * Awaiting this helper in the handler's `finally` block guarantees that the
 * buffered records reach the backend before exit.
 *
 * @example
 *   import Anthropic from "@anthropic-ai/sdk";
 *   import { wrap, flushClient } from "@argosvix/sdk";
 *
 *   export default {
 *     async scheduled(_event, env) {
 *       const client = wrap(new Anthropic({ apiKey: env.ANTHROPIC_API_KEY }), {
 *         apiKey: env.ARGOSVIX_API_KEY,
 *       });
 *       try {
 *         await client.messages.create({ ... });
 *       } finally {
 *         await flushClient(client);
 *       }
 *     },
 *   };
 */
export async function flushClient(client: object): Promise<void> {
  const recorder = getRecorder(client);
  if (!recorder) return;
  try {
    await recorder.flush();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[argosvix] flushClient failed:", err);
  }
}
