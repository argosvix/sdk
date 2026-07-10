import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { wrap, getRecorder } from "../client.js";
import { withPrompt } from "../context.js";
import { resolvePrompt, _clearPromptCache } from "../prompts.js";

/**
 * Prompt version ID propagation to calls (2026-07-02). Pins that calls wrapped
 * inside withPrompt automatically get tags.prompt ({name}@v{version}), and the
 * resolvePrompt TTL cache / stale fallback behavior.
 */

function makeOpenAIMock() {
  const create = vi.fn(async () => ({
    model: "gpt-5.5",
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    choices: [{ message: { content: "ok" } }],
  }));
  return { chat: { completions: { create } } };
}

describe("withPrompt → tags.prompt 自動付与", () => {
  it("withPrompt({name, version}) の内側の呼び出しに prompt タグが付く", async () => {
    const client = wrap(makeOpenAIMock());
    await withPrompt({ name: "support-bot", version: 3 }, async () => {
      await client.chat.completions.create({
        model: "gpt-5.5",
        messages: [{ role: "user", content: "hi" }],
      });
    });
    const records = await getRecorder(client)!.flush();
    expect(records[0]?.tags?.prompt).toBe("support-bot@v3");
  });

  it("文字列形(タグ直指定)も受ける", async () => {
    const client = wrap(makeOpenAIMock());
    await withPrompt("faq@v12", async () => {
      await client.chat.completions.create({
        model: "gpt-5.5",
        messages: [{ role: "user", content: "hi" }],
      });
    });
    const records = await getRecorder(client)!.flush();
    expect(records[0]?.tags?.prompt).toBe("faq@v12");
  });

  it("明示 tags.prompt が ambient より優先", async () => {
    const client = wrap(makeOpenAIMock(), { tags: { prompt: "manual@v1" } });
    await withPrompt({ name: "support-bot", version: 3 }, async () => {
      await client.chat.completions.create({
        model: "gpt-5.5",
        messages: [{ role: "user", content: "hi" }],
      });
    });
    const records = await getRecorder(client)!.flush();
    expect(records[0]?.tags?.prompt).toBe("manual@v1");
  });

  it("withPrompt の外側では prompt タグは付かない", async () => {
    const client = wrap(makeOpenAIMock());
    await client.chat.completions.create({
      model: "gpt-5.5",
      messages: [{ role: "user", content: "hi" }],
    });
    const records = await getRecorder(client)!.flush();
    expect(records[0]?.tags?.prompt).toBeUndefined();
  });
});

describe("resolvePrompt", () => {
  const PROMPT_BODY = {
    prompt: {
      id: "pr_1",
      name: "support-bot",
      version: 3,
      template: "You are a support agent.",
      variables: ["tone"],
    },
    label: "production",
  };

  beforeEach(() => {
    _clearPromptCache();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("resolve API を叩いて tag 付きの版を返す", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(PROMPT_BODY)));
    vi.stubGlobal("fetch", fetchMock);
    const p = await resolvePrompt("support-bot", { apiKey: "argk_x" });
    expect(p.version).toBe(3);
    expect(p.template).toContain("support agent");
    expect(p.tag).toBe("support-bot@v3");
    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain("/v1/prompts/resolve?name=support-bot&label=production");
  });

  it("TTL 内の再呼び出しは fetch しない(キャッシュ)", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(PROMPT_BODY)));
    vi.stubGlobal("fetch", fetchMock);
    await resolvePrompt("support-bot", { apiKey: "argk_x" });
    await resolvePrompt("support-bot", { apiKey: "argk_x" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("ネットワーク断でも stale キャッシュがあればそれを返す", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(PROMPT_BODY)))
      .mockRejectedValue(new Error("network down"));
    vi.stubGlobal("fetch", fetchMock);
    // TTL ~0 = always expired → the second fetch fails → stale fallback
    const first = await resolvePrompt("support-bot", { apiKey: "argk_x", cacheTtlMs: 1 });
    await new Promise((r) => setTimeout(r, 5));
    const second = await resolvePrompt("support-bot", { apiKey: "argk_x", cacheTtlMs: 1 });
    expect(second.tag).toBe(first.tag);
  });

  it("キャッシュ無しの 404 は throw(存在しないデプロイを黙って握りつぶさない)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "not found" }), { status: 404 })),
    );
    await expect(resolvePrompt("missing", { apiKey: "argk_x" })).rejects.toThrow("404");
  });
});
