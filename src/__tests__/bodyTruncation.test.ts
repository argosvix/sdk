/**
 * Pre-send 64KB body truncation (truncateBodyForIngest + Recorder integration).
 *
 * The ingest backend rejects outright any record whose promptBody /
 * completionBody exceeds MAX_PLAINTEXT_BODY_BYTES = 64 * 1024. The check uses
 * `.length` = UTF-16 code unit count (not bytes). The SDK truncates to fit
 * within the limit, marker included, before sending.
 */
import { describe, it, expect } from "vitest";
import {
  BODY_TRUNCATED_MARKER,
  INGEST_MAX_BODY_UNITS,
  Recorder,
  truncateBodyForIngest,
} from "../recorder.js";
import type { LlmCallRecord } from "../types.js";

const LIMIT = INGEST_MAX_BODY_UNITS; // 65536
const MARKER = BODY_TRUNCATED_MARKER; // "…[truncated]" = 12 code units

const baseRecord: LlmCallRecord = {
  id: "rec_trunc",
  provider: "openai",
  model: "gpt-4o",
  promptTokens: 10,
  completionTokens: 5,
  totalTokens: 15,
  costUsd: 0.0001,
  latencyMs: 200,
  timestamp: "2026-07-10T00:00:00.000Z",
  tags: {},
};

describe("truncateBodyForIngest — 境界", () => {
  it("ちょうど上限(65536 code units)は無加工", () => {
    const body = "a".repeat(LIMIT);
    expect(truncateBodyForIngest(body)).toBe(body);
  });

  it("上限 + 1 は切り詰め、マーカー込みでちょうど上限に収まる", () => {
    const out = truncateBodyForIngest("a".repeat(LIMIT + 1));
    expect(out.length).toBe(LIMIT);
    expect(out.endsWith(MARKER)).toBe(true);
    expect(out.startsWith("aaa")).toBe(true);
  });

  it("判定単位は UTF-16 code unit(UTF-8 バイトではない): 全角 65536 文字は無加工", () => {
    // "あ" is 3 bytes in UTF-8 (~192KB total here) but only 1 code unit.
    const body = "あ".repeat(LIMIT);
    expect(truncateBodyForIngest(body)).toBe(body);
  });

  it("切断点が surrogate pair をまたぐ場合は pair ごと落とす(lone surrogate を作らない)", () => {
    // 65523 leading 'a's followed immediately by emoji (2 code units each).
    // The cut point at 65524 falls in the middle of an emoji pair.
    const cutPoint = LIMIT - MARKER.length; // 65524
    const body = "a".repeat(cutPoint - 1) + "😀".repeat(16);
    const out = truncateBodyForIngest(body);
    expect(out.length).toBeLessThanOrEqual(LIMIT);
    expect(out.endsWith(MARKER)).toBe(true);
    const kept = out.slice(0, -MARKER.length);
    // No lone high surrogate must remain (only the 'a's are kept).
    expect(kept).toBe("a".repeat(cutPoint - 1));
  });

  it("絵文字のみでちょうど上限(32768 個 = 65536 units)は無加工", () => {
    const body = "😀".repeat(LIMIT / 2);
    expect(truncateBodyForIngest(body)).toBe(body);
  });
});

describe("Recorder 統合 — 送信 record の本文が backend 上限内に収まる", () => {
  it("captureContent=true(redaction ON)で 64KB 超の両本文が切り詰められる", async () => {
    const recorder = new Recorder({ captureContent: true });
    recorder.record({
      ...baseRecord,
      promptBody: "p".repeat(LIMIT + 5000),
      completionBody: "c".repeat(LIMIT + 5000),
    });
    const flushed = await recorder.flush();
    expect(flushed).toHaveLength(1);
    expect(flushed[0]!.promptBody!.length).toBeLessThanOrEqual(LIMIT);
    expect(flushed[0]!.promptBody!.endsWith(MARKER)).toBe(true);
    expect(flushed[0]!.completionBody!.length).toBeLessThanOrEqual(LIMIT);
    expect(flushed[0]!.completionBody!.endsWith(MARKER)).toBe(true);
  });

  it("disablePiiRedaction=true でも切り詰めは行われる", async () => {
    const recorder = new Recorder({
      captureContent: true,
      disablePiiRedaction: true,
    });
    recorder.record({
      ...baseRecord,
      promptBody: "p".repeat(LIMIT + 1),
      completionBody: "short",
    });
    const flushed = await recorder.flush();
    expect(flushed[0]!.promptBody!.length).toBe(LIMIT);
    expect(flushed[0]!.promptBody!.endsWith(MARKER)).toBe(true);
    // Bodies within the limit stay untouched (preserving the raw pass-through promise).
    expect(flushed[0]!.completionBody).toBe("short");
  });

  it("上限内の本文は無加工でマーカーも付かない", async () => {
    const recorder = new Recorder({ captureContent: true });
    recorder.record({
      ...baseRecord,
      promptBody: "hello prompt",
      completionBody: "hello completion",
    });
    const flushed = await recorder.flush();
    expect(flushed[0]!.promptBody).toBe("hello prompt");
    expect(flushed[0]!.completionBody).toBe("hello completion");
  });

  it("redaction で伸びた本文も最終送信長で切り詰められる(redaction 後判定)", async () => {
    const recorder = new Recorder({ captureContent: true });
    // "a@b.co" (6 units) → "[REDACTED_EMAIL]" (16 units): the body first exceeds
    // the limit only after redaction (raw = 65,200 units ≤ limit, redacted = 66,200 units > limit).
    const emails = Array.from({ length: 100 }, () => "a@b.co").join(" ");
    const filler = "x".repeat(64_500);
    recorder.record({ ...baseRecord, promptBody: filler + " " + emails });
    const flushed = await recorder.flush();
    expect(flushed[0]!.promptBody!.length).toBeLessThanOrEqual(LIMIT);
    expect(flushed[0]!.promptBody!.endsWith(MARKER)).toBe(true);
  });
});
