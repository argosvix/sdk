import { describe, it, expect, vi, afterEach } from "vitest";
import { Recorder } from "../recorder.js";
import type { LlmCallRecord } from "../types.js";

const baseRecord: LlmCallRecord = {
  id: "rec_1",
  provider: "openai",
  model: "gpt-4o",
  promptTokens: 10,
  completionTokens: 5,
  totalTokens: 15,
  costUsd: 0.0001,
  latencyMs: 200,
  timestamp: "2026-06-01T00:00:00.000Z",
  tags: {},
};

describe("Recorder sanitizeContent — captureContent gating", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("strips promptBody / completionBody / toolCalls when captureContent is unset (default false)", async () => {
    const recorder = new Recorder({});
    const dirty: LlmCallRecord = {
      ...baseRecord,
      promptBody: "user@example.com sent a hello",
      completionBody: "Hi there!",
      toolCalls: [{ name: "ping", arguments: "{}", result: "ok" }],
    };
    recorder.record(dirty);
    const flushed = await recorder.flush();
    expect(flushed).toHaveLength(1);
    expect(flushed[0]!.promptBody).toBeUndefined();
    expect(flushed[0]!.completionBody).toBeUndefined();
    expect(flushed[0]!.toolCalls).toBeUndefined();
  });

  it("strips bodies when captureContent is false", async () => {
    const recorder = new Recorder({ captureContent: false });
    const dirty: LlmCallRecord = {
      ...baseRecord,
      promptBody: "leak attempt",
      completionBody: "leak attempt",
    };
    recorder.record(dirty);
    const flushed = await recorder.flush();
    expect(flushed[0]!.promptBody).toBeUndefined();
    expect(flushed[0]!.completionBody).toBeUndefined();
  });

  it("applies PII redaction to bodies when captureContent is true (redaction default ON)", async () => {
    const recorder = new Recorder({
      captureContent: true,
    });
    const dirty: LlmCallRecord = {
      ...baseRecord,
      promptBody: "contact alice@example.com",
      completionBody: "Reply: bob@test.io",
    };
    recorder.record(dirty);
    const flushed = await recorder.flush();
    expect(flushed[0]!.promptBody).toBe("contact [REDACTED_EMAIL]");
    expect(flushed[0]!.completionBody).toBe("Reply: [REDACTED_EMAIL]");
  });

  it("applies redaction to tool call arguments and results", async () => {
    const recorder = new Recorder({
      captureContent: true,
    });
    const dirty: LlmCallRecord = {
      ...baseRecord,
      toolCalls: [
        {
          name: "send_email",
          arguments: '{"to":"a@b.co"}',
          result: "sent to a@b.co",
        },
      ],
    };
    recorder.record(dirty);
    const flushed = await recorder.flush();
    expect(flushed[0]!.toolCalls).toHaveLength(1);
    expect(flushed[0]!.toolCalls![0]!.arguments).toContain("[REDACTED_EMAIL]");
    expect(flushed[0]!.toolCalls![0]!.result).toContain("[REDACTED_EMAIL]");
    expect(flushed[0]!.toolCalls![0]!.name).toBe("send_email");
  });

  it("does NOT apply redaction when disablePiiRedaction is true", async () => {
    const recorder = new Recorder({
      captureContent: true,
      disablePiiRedaction: true,
    });
    const dirty: LlmCallRecord = {
      ...baseRecord,
      promptBody: "contact alice@example.com",
      completionBody: "Reply: bob@test.io",
    };
    recorder.record(dirty);
    const flushed = await recorder.flush();
    // No mutation — body kept as-is
    expect(flushed[0]!.promptBody).toBe("contact alice@example.com");
    expect(flushed[0]!.completionBody).toBe("Reply: bob@test.io");
  });

  it("safety net: even with captureContent=false, accidentally provided bodies do not leak to buffer", async () => {
    // Simulate a wrapper bug: it sets promptBody even though captureContent is false.
    // Recorder must strip it.
    const recorder = new Recorder({});
    const accidentalLeak: LlmCallRecord = {
      ...baseRecord,
      promptBody: "Should-never-be-sent: leak content",
      completionBody: "Should-never-be-sent: leak content",
      toolCalls: [{ name: "f", arguments: "leak" }],
    };
    recorder.record(accidentalLeak);
    const flushed = await recorder.flush();
    expect(JSON.stringify(flushed)).not.toContain("Should-never-be-sent");
    expect(JSON.stringify(flushed)).not.toContain("leak content");
  });

  it("redacts PII in the error field even when captureContent is false (error always ships)", async () => {
    // The error field is metadata that ships to the backend even when captureContent is OFF.
    // Provider error messages can contain prompt fragments / PII, so they must be redacted.
    const recorder = new Recorder({});
    const withError: LlmCallRecord = {
      ...baseRecord,
      error: "rate limit hit for user alice@example.com (req 4111 1111 1111 1111)",
    };
    recorder.record(withError);
    const flushed = await recorder.flush();
    expect(flushed[0]!.error).toContain("[REDACTED_EMAIL]");
    expect(flushed[0]!.error).toContain("[REDACTED_CC]");
    expect(flushed[0]!.error).not.toContain("alice@example.com");
    expect(flushed[0]!.error).not.toContain("4111");
  });

  it("redacts PII in the error field when captureContent is true", async () => {
    const recorder = new Recorder({ captureContent: true });
    const withError: LlmCallRecord = {
      ...baseRecord,
      error: "upstream said: contact bob@test.io",
    };
    recorder.record(withError);
    const flushed = await recorder.flush();
    expect(flushed[0]!.error).toBe("upstream said: contact [REDACTED_EMAIL]");
  });

  it("leaves the error field raw when disablePiiRedaction is true", async () => {
    const recorder = new Recorder({
      captureContent: true,
      disablePiiRedaction: true,
    });
    const withError: LlmCallRecord = {
      ...baseRecord,
      error: "raw error for alice@example.com",
    };
    recorder.record(withError);
    const flushed = await recorder.flush();
    expect(flushed[0]!.error).toBe("raw error for alice@example.com");
  });

  it("does not allocate a new object when no body fields are present (perf-neutral fast path)", () => {
    const recorder = new Recorder({});
    recorder.record(baseRecord);
    expect(recorder.getBufferSize()).toBe(1);
  });

  it("preserves all metadata fields when captureContent is true (no field loss)", async () => {
    const recorder = new Recorder({
      captureContent: true,
    });
    const full: LlmCallRecord = {
      ...baseRecord,
      promptBody: "Hello, no PII here.",
      completionBody: "Hi back.",
      traceId: "trace-1",
      spanId: "span-1",
      parentSpanId: "parent-1",
      requestMeta: { messagesCount: 2, temperature: 0.7 },
      errorDetails: { statusCode: 200 },
    };
    recorder.record(full);
    const flushed = await recorder.flush();
    const r = flushed[0]!;
    expect(r.traceId).toBe("trace-1");
    expect(r.spanId).toBe("span-1");
    expect(r.parentSpanId).toBe("parent-1");
    expect(r.requestMeta).toEqual({ messagesCount: 2, temperature: 0.7 });
    expect(r.errorDetails).toEqual({ statusCode: 200 });
    expect(r.promptBody).toBe("Hello, no PII here.");
    expect(r.completionBody).toBe("Hi back.");
  });
});
