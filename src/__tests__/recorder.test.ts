import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Recorder } from "../recorder.js";
import type { LlmCallRecord } from "../types.js";

function makeRecord(overrides: Partial<LlmCallRecord> = {}): LlmCallRecord {
  return {
    id: "test-id",
    provider: "openai",
    model: "gpt-5.5",
    promptTokens: 100,
    completionTokens: 50,
    totalTokens: 150,
    costUsd: 0.001,
    latencyMs: 250,
    timestamp: new Date().toISOString(),
    tags: {},
    ...overrides,
  };
}

describe("Recorder", () => {
  it("record() で buffer に entry を追加し getBufferSize に反映する", () => {
    const r = new Recorder();
    expect(r.getBufferSize()).toBe(0);
    r.record(makeRecord());
    expect(r.getBufferSize()).toBe(1);
  });

  it("disabled config の場合 record しない", () => {
    const r = new Recorder({ disabled: true });
    r.record(makeRecord());
    expect(r.getBufferSize()).toBe(0);
  });

  it("flush() は buffer を空にして records を返す", async () => {
    const r = new Recorder();
    r.record(makeRecord({ id: "a" }));
    r.record(makeRecord({ id: "b" }));
    const flushed = await r.flush();
    expect(flushed).toHaveLength(2);
    expect(flushed[0]?.id).toBe("a");
    expect(r.getBufferSize()).toBe(0);
  });

  it("並列 Recorder instance 間で buffer は完全独立 (= test isolation)", () => {
    const r1 = new Recorder();
    const r2 = new Recorder();
    r1.record(makeRecord({ id: "r1" }));
    r2.record(makeRecord({ id: "r2-a" }));
    r2.record(makeRecord({ id: "r2-b" }));
    expect(r1.getBufferSize()).toBe(1);
    expect(r2.getBufferSize()).toBe(2);
  });

  describe("backend POST", () => {
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      fetchMock = vi.fn(async () =>
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
      );
      vi.stubGlobal("fetch", fetchMock);
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("apiKey 未設定 = local-only mode = fetch を呼ばない", async () => {
      const r = new Recorder({});
      r.record(makeRecord());
      await r.flush();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("apiKey 設定 + flush = config.endpoint に Bearer 認証で POST する", async () => {
      const r = new Recorder({
        apiKey: "test-key",
        endpoint: "https://api.example.com/ingest",
      });
      r.record(makeRecord({ id: "x" }));
      await r.flush();
      expect(fetchMock).toHaveBeenCalledOnce();
      const [url, init] = fetchMock.mock.calls[0]!;
      expect(url).toBe("https://api.example.com/ingest");
      expect(init.method).toBe("POST");
      expect((init.headers as Record<string, string>).Authorization).toBe(
        "Bearer test-key",
      );
      const body = JSON.parse(init.body as string);
      expect(body.records).toHaveLength(1);
      expect(body.records[0].id).toBe("x");
    });

    it("POST 失敗時も throw しない (= production inline error 防止)", async () => {
      fetchMock.mockImplementationOnce(async () => {
        throw new Error("network down");
      });
      const r = new Recorder({ apiKey: "k", endpoint: "https://x" });
      r.record(makeRecord());
      await expect(r.flush()).resolves.toBeDefined();
    });

    it("bufferMaxSize 到達で auto flush する", () => {
      const r = new Recorder({ bufferMaxSize: 2 });
      r.record(makeRecord({ id: "1" }));
      expect(r.getBufferSize()).toBe(1);
      r.record(makeRecord({ id: "2" }));
      expect(r.getBufferSize()).toBe(0);
    });

    it("5xx error で retry する (= initial + 1 retry = total 2 calls)", async () => {
      fetchMock
        .mockResolvedValueOnce(new Response("err", { status: 503 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
      const r = new Recorder({
        apiKey: "k",
        endpoint: "https://x",
        flushRetryAttempts: 2,
      });
      r.record(makeRecord());
      await r.flush();
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("4xx error は retry しない (= client error は retry 無駄)", async () => {
      fetchMock.mockResolvedValue(new Response("bad", { status: 400 }));
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const r = new Recorder({
        apiKey: "k",
        endpoint: "https://x",
        flushRetryAttempts: 3,
      });
      r.record(makeRecord());
      await r.flush();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      errSpy.mockRestore();
    });

    it("auto-flush と explicit flush が serialize される", async () => {
      // Reaching bufferMaxSize=2 triggers an auto-flush; even if an additional
      // record + explicit flush arrive while that fetch is still in flight, the
      // next flush must wait for the in-flight one to complete. Order is
      // preserved and both batches reach the backend.
      let firstResolve!: (value: Response) => void;
      const firstFetchPromise = new Promise<Response>((resolve) => {
        firstResolve = resolve;
      });
      fetchMock
        .mockImplementationOnce(() => firstFetchPromise)
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ ok: true }), { status: 200 }),
        );

      const r = new Recorder({
        apiKey: "k",
        endpoint: "https://x",
        bufferMaxSize: 2,
      });
      // Auto-flush fires the moment the 1st and 2nd records land (fetch in flight)
      r.record(makeRecord({ id: "first-batch-1" }));
      r.record(makeRecord({ id: "first-batch-2" }));
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // Add a 3rd record and call explicit flush. No 2nd fetch while the 1st is in flight
      r.record(makeRecord({ id: "second-batch" }));
      const explicitFlush = r.flush();

      // The 2nd fetch has not fired immediately
      await Promise.resolve();
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // Completing the 1st fetch lets the 2nd one run
      firstResolve(
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
      );
      await explicitFlush;
      expect(fetchMock).toHaveBeenCalledTimes(2);

      // Order check: sent as 1st batch → 2nd batch
      const firstBody = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
      const secondBody = JSON.parse(fetchMock.mock.calls[1]![1].body as string);
      expect(firstBody.records.map((r: { id: string }) => r.id)).toEqual([
        "first-batch-1",
        "first-batch-2",
      ]);
      expect(secondBody.records.map((r: { id: string }) => r.id)).toEqual([
        "second-batch",
      ]);
    });
  });

  it("process global 不在の edge runtime でも record() が throw しない", () => {
    // Some Cloudflare Workers modes and Vercel Edge do not expose Node's `process`
    // global. If record() read `process.env[...]` unconditionally it would throw and
    // take the wrapped LLM call down with it. With the typeof guard in place it must
    // not throw.
    const originalProcess = (globalThis as { process?: unknown }).process;
    try {
      delete (globalThis as { process?: unknown }).process;
      const r = new Recorder();
      expect(() => r.record(makeRecord())).not.toThrow();
      expect(r.getBufferSize()).toBe(1);
    } finally {
      (globalThis as { process?: unknown }).process = originalProcess;
    }
  });

  it("ARGOSVIX_DEBUG=1 のログは redaction 後(sanitized)を出す(finding 4 回帰)", () => {
    const prev = process.env["ARGOSVIX_DEBUG"];
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      process.env["ARGOSVIX_DEBUG"] = "1";
      const r = new Recorder({ captureContent: true });
      r.record(
        makeRecord({
          promptBody: "私のメールは taro@example.com です",
          completionBody: "了解しました",
        }),
      );
      const logged = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      // Raw PII must not appear in the log (only the post-redaction mask).
      expect(logged).not.toContain("taro@example.com");
      expect(logged).toContain("[argosvix]");
    } finally {
      logSpy.mockRestore();
      if (prev === undefined) delete process.env["ARGOSVIX_DEBUG"];
      else process.env["ARGOSVIX_DEBUG"] = prev;
    }
  });

  it("flushIntervalMs: buffer 未満でも interval 後に自動 flush される(finding 2 回帰)", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const r = new Recorder({
        apiKey: "k",
        endpoint: "https://x",
        flushIntervalMs: 5000,
        bufferMaxSize: 100, // never reached
      });
      r.record(makeRecord());
      expect(fetchMock).not.toHaveBeenCalled(); // interval has not elapsed yet
      await vi.advanceTimersByTimeAsync(5000);
      expect(fetchMock).toHaveBeenCalledOnce(); // auto-flushes once the interval elapses
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it("flushIntervalMs=0 は periodic flush を無効化する", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const r = new Recorder({
        apiKey: "k",
        endpoint: "https://x",
        flushIntervalMs: 0,
        bufferMaxSize: 100,
      });
      r.record(makeRecord());
      await vi.advanceTimersByTimeAsync(60000);
      expect(fetchMock).not.toHaveBeenCalled(); // 0 = no timer is set
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });
});
