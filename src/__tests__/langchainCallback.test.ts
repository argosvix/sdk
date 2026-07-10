import { describe, it, expect, vi } from "vitest";

import { argosvixLangChainHandler } from "../langchainCallback.js";
import { getRecorder } from "../client.js";
import { flushClient } from "../flush.js";

/**
 * LangChain.js integration (callback handler). Verifies start→end correlation,
 * provider normalization, usage_metadata (standard) / llmOutput.tokenUsage
 * (fallback), TTFT, error handling, and flush.
 */

function serialized(...id: string[]) {
  return { id, name: id[id.length - 1] };
}

describe("argosvixLangChainHandler", () => {
  it("chat model の start→end で record を 1 件残す (usage_metadata 標準形)", async () => {
    const h = argosvixLangChainHandler({ tags: { service: "lc" } });
    h.handleChatModelStart(serialized("langchain", "chat_models", "openai", "ChatOpenAI"), [], "run1", undefined, {
      invocation_params: { model: "gpt-5.5" },
    });
    h.handleLLMEnd(
      {
        generations: [[{ message: { usage_metadata: { input_tokens: 100, output_tokens: 40, total_tokens: 140 } } }]],
      },
      "run1",
    );
    const records = await h.recorder.flush();
    expect(records).toHaveLength(1);
    const r = records[0]!;
    expect(r.provider).toBe("openai");
    expect(r.model).toBe("gpt-5.5");
    expect(r.promptTokens).toBe(100);
    expect(r.completionTokens).toBe(40);
    expect(r.totalTokens).toBe(140);
    expect(r.costUsd).toBeGreaterThan(0);
    expect(r.tags.service).toBe("lc");
  });

  it("llmOutput.tokenUsage(fallback)も読む + model_name を採用", async () => {
    const h = argosvixLangChainHandler({});
    h.handleLLMStart(serialized("langchain", "llms", "openai", "OpenAI"), [], "r2", undefined, {
      invocation_params: { model: "gpt-5.5" },
    });
    h.handleLLMEnd(
      { llmOutput: { model_name: "gpt-5.5-mini", tokenUsage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } } },
      "r2",
    );
    const r = (await h.recorder.flush())[0]!;
    expect(r.promptTokens).toBe(10);
    expect(r.completionTokens).toBe(5);
    expect(r.model).toBe("gpt-5.5-mini");
  });

  it("usage_metadata + llmOutput.model_name 併存時も model を拾い cost を出す", async () => {
    const h = argosvixLangChainHandler({});
    // Do not pass invocation_params.model at start (simulates an integration where the model is unknown)
    h.handleChatModelStart(serialized("langchain", "chat_models", "openai", "ChatOpenAI"), [], "rm", undefined, {});
    h.handleLLMEnd(
      {
        generations: [[{ message: { usage_metadata: { input_tokens: 100, output_tokens: 40 } } }]],
        llmOutput: { model_name: "gpt-5.5" },
      },
      "rm",
    );
    const r = (await h.recorder.flush())[0]!;
    expect(r.model).toBe("gpt-5.5");
    expect(r.costUsd).toBeGreaterThan(0);
  });

  it("cache / reasoning 内訳 (usage_metadata details) を記録", async () => {
    const h = argosvixLangChainHandler({});
    h.handleChatModelStart(serialized("langchain", "chat_models", "openai", "ChatOpenAI"), [], "r3", undefined, {
      invocation_params: { model: "gpt-5.5" },
    });
    h.handleLLMEnd(
      {
        generations: [
          [
            {
              message: {
                usage_metadata: {
                  input_tokens: 1000,
                  output_tokens: 200,
                  total_tokens: 1200,
                  input_token_details: { cache_read: 400 },
                  output_token_details: { reasoning: 60 },
                },
              },
            },
          ],
        ],
      },
      "r3",
    );
    const r = (await h.recorder.flush())[0]!;
    expect(r.cachedReadTokens).toBe(400);
    expect(r.reasoningTokens).toBe(60);
  });

  it("handleLLMNewToken で TTFT を記録する", async () => {
    const h = argosvixLangChainHandler({});
    h.handleChatModelStart(serialized("langchain", "chat_models", "anthropic", "ChatAnthropic"), [], "r4", undefined, {
      invocation_params: { model: "claude-x" },
    });
    h.handleLLMNewToken("he", 0, "r4");
    h.handleLLMNewToken("llo", 1, "r4");
    h.handleLLMEnd(
      { generations: [[{ message: { usage_metadata: { input_tokens: 5, output_tokens: 5 } } }]] },
      "r4",
    );
    const r = (await h.recorder.flush())[0]!;
    expect(r.provider).toBe("anthropic");
    expect(typeof r.ttftMs).toBe("number");
  });

  it("error 時も record を残す", async () => {
    const h = argosvixLangChainHandler({});
    h.handleChatModelStart(serialized("langchain", "chat_models", "mistralai", "ChatMistralAI"), [], "r5", undefined, {
      invocation_params: { model: "mistral-large" },
    });
    h.handleLLMError(new Error("rate limited"), "r5");
    const records = await h.recorder.flush();
    expect(records).toHaveLength(1);
    expect(records[0]?.provider).toBe("mistral");
    expect(records[0]?.error).toBe("rate limited");
    expect(records[0]?.costUsd).toBe(0);
  });

  it("provider セグメントを 4 種へ寄せる (google_genai → gemini)", async () => {
    const h = argosvixLangChainHandler({});
    h.handleChatModelStart(serialized("langchain", "chat_models", "google_genai", "ChatGoogleGenerativeAI"), [], "r6", undefined, {
      invocation_params: { model: "gemini-2.0" },
    });
    h.handleLLMEnd(
      { generations: [[{ message: { usage_metadata: { input_tokens: 5, output_tokens: 5 } } }]] },
      "r6",
    );
    const r = (await h.recorder.flush())[0]!;
    expect(r.provider).toBe("gemini");
  });

  it("サポート外 provider は start を登録せず end も no-op + 1 回警告", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const h = argosvixLangChainHandler({});
    h.handleChatModelStart(serialized("langchain", "chat_models", "cohere", "ChatCohere"), [], "r7", undefined, {
      invocation_params: { model: "command" },
    });
    h.handleLLMEnd(
      { generations: [[{ message: { usage_metadata: { input_tokens: 5, output_tokens: 5 } } }]] },
      "r7",
    );
    const records = await h.recorder.flush();
    expect(records).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("cohere"));
    warn.mockRestore();
  });

  it("config.provider 明示でサポート外 provider でも記録", async () => {
    const h = argosvixLangChainHandler({ provider: "openai" });
    h.handleChatModelStart(serialized("langchain", "chat_models", "groq", "ChatGroq"), [], "r8", undefined, {
      invocation_params: { model: "gpt-5.5" },
    });
    h.handleLLMEnd(
      { generations: [[{ message: { usage_metadata: { input_tokens: 5, output_tokens: 5 } } }]] },
      "r8",
    );
    const records = await h.recorder.flush();
    expect(records).toHaveLength(1);
    expect(records[0]?.provider).toBe("openai");
  });

  it("flushClient(handler) / getRecorder(handler) が動く", async () => {
    const h = argosvixLangChainHandler({});
    expect(getRecorder(h)).toBe(h.recorder);
    h.handleChatModelStart(serialized("langchain", "chat_models", "openai", "ChatOpenAI"), [], "r9", undefined, {
      invocation_params: { model: "gpt-5.5" },
    });
    h.handleLLMEnd(
      { generations: [[{ message: { usage_metadata: { input_tokens: 1, output_tokens: 1 } } }]] },
      "r9",
    );
    await expect(flushClient(h)).resolves.toBeUndefined();
    expect(h.recorder.getBufferSize()).toBe(0);
  });
});
