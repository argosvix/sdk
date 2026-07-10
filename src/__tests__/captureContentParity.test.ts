import { describe, it, expect, vi } from "vitest";

import { wrap, getRecorder } from "../client.js";

/**
 * Parity fix (2026-07-02): pins that captureContent extracts promptBody /
 * completionBody on the non-streaming success path for Mistral / Gemini
 * (legacy + new SDK) as well. Redaction rides on the Recorder-side blanket
 * application (see captureContent.test.ts).
 */
describe("captureContent parity (Mistral / Gemini)", () => {
  it("Mistral: captureContent=true で promptBody / completionBody を抽出", async () => {
    const complete = vi.fn(async () => ({
      model: "mistral-large",
      usage: { prompt_tokens: 6, completion_tokens: 4, total_tokens: 10 },
      choices: [{ message: { content: "bonjour" } }],
    }));
    const client = wrap({ chat: { complete } }, { captureContent: true });
    await client.chat.complete({
      model: "mistral-large",
      messages: [{ role: "user", content: "hi" }],
    });
    const records = await getRecorder(client)!.flush();
    expect(records[0]?.promptBody).toBe(JSON.stringify([{ role: "user", content: "hi" }]));
    expect(records[0]?.completionBody).toBe("bonjour");
  });

  it("Mistral: captureContent 未指定では body を付与しない", async () => {
    const complete = vi.fn(async () => ({
      model: "mistral-large",
      usage: { prompt_tokens: 6, completion_tokens: 4, total_tokens: 10 },
      choices: [{ message: { content: "bonjour" } }],
    }));
    const client = wrap({ chat: { complete } });
    await client.chat.complete({
      model: "mistral-large",
      messages: [{ role: "user", content: "hi" }],
    });
    const records = await getRecorder(client)!.flush();
    expect(records[0]?.promptBody).toBeUndefined();
    expect(records[0]?.completionBody).toBeUndefined();
  });

  it("Gemini 新 SDK: candidates[].content.parts[].text を join して completionBody に", async () => {
    const generateContent = vi.fn(async () => ({
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3, totalTokenCount: 8 },
      candidates: [{ content: { parts: [{ text: "hello" }, { text: "world" }] } }],
    }));
    const client = wrap({ models: { generateContent } }, { captureContent: true });
    await client.models.generateContent({
      model: "gemini-2.5-pro",
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
    });
    const records = await getRecorder(client)!.flush();
    expect(records[0]?.promptBody).toBe(
      JSON.stringify([{ role: "user", parts: [{ text: "hi" }] }]),
    );
    expect(records[0]?.completionBody).toBe("hello\nworld");
  });

  it("Gemini legacy: result.response 側の candidates から抽出する", async () => {
    const generateContent = vi.fn(async () => ({
      response: {
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3, totalTokenCount: 8 },
        candidates: [{ content: { parts: [{ text: "legacy ok" }] } }],
      },
    }));
    const modelInstance = { generateContent };
    const mock = { getGenerativeModel: vi.fn(() => modelInstance) };
    const client = wrap(mock, { captureContent: true });
    const model = client.getGenerativeModel({ model: "gemini-2.0-flash" });
    await model.generateContent("prompt text");
    const records = await getRecorder(client)!.flush();
    expect(records[0]?.promptBody).toBe("prompt text");
    expect(records[0]?.completionBody).toBe("legacy ok");
  });

  it("Mistral: 抽出した body にも PII redaction がかかる(Recorder 側一括)", async () => {
    const complete = vi.fn(async () => ({
      model: "mistral-large",
      usage: { prompt_tokens: 6, completion_tokens: 4, total_tokens: 10 },
      choices: [{ message: { content: "reach me at taro@example.com" } }],
    }));
    const client = wrap({ chat: { complete } }, { captureContent: true });
    await client.chat.complete({
      model: "mistral-large",
      messages: [{ role: "user", content: "hi" }],
    });
    const records = await getRecorder(client)!.flush();
    expect(records[0]?.completionBody).toContain("[REDACTED_EMAIL]");
    expect(records[0]?.completionBody).not.toContain("taro@example.com");
  });
});
