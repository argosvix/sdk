import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ArgosvixQueryError,
  queryAggregate,
  queryCalls,
} from "../query.js";

/**
 * Mocks fetch to verify endpoint / Bearer header / body forwarding.
 * Also covers status / error paths to guard against regressions.
 */

const originalFetch = globalThis.fetch;

describe("queryCalls", () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn() as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("default endpoint + Bearer + filter body を carry", async () => {
    const json = vi.fn().mockResolvedValue({ records: [] });
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      json,
    });

    const out = await queryCalls({
      apiKey: "argosvix_live_TEST",
      filter: { provider: "openai", limit: 25 },
    });

    expect(out).toEqual({ records: [] });
    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(url).toBe("https://ingest.argosvix.com/v1/query/calls");
    expect((init as RequestInit).method).toBe("POST");
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer argosvix_live_TEST");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({
      provider: "openai",
      limit: 25,
    });
  });

  it("filter 未指定なら 空 object body", async () => {
    const json = vi.fn().mockResolvedValue({ records: [] });
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      json,
    });
    await queryCalls({ apiKey: "k" });
    const [, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({});
  });

  it("endpoint override が効く", async () => {
    const json = vi.fn().mockResolvedValue({ records: [] });
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      json,
    });
    await queryCalls({ apiKey: "k", endpoint: "http://localhost:8787" });
    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("http://localhost:8787/v1/query/calls");
  });

  it("非 200 status は ArgosvixQueryError を throw", async () => {
    const json = vi.fn().mockResolvedValue({ error: "invalid limit" });
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 400,
      json,
    });
    await expect(queryCalls({ apiKey: "k" })).rejects.toThrow(
      ArgosvixQueryError,
    );
    await expect(queryCalls({ apiKey: "k" })).rejects.toThrow(
      /invalid limit/,
    );
  });

  it("error body が JSON でなくても generic message で throw", async () => {
    const json = vi.fn().mockRejectedValue(new Error("bad json"));
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 500,
      json,
    });
    await expect(queryCalls({ apiKey: "k" })).rejects.toThrow(/HTTP 500/);
  });
});

describe("queryAggregate", () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn() as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("groupBy + metric を carry + result を そのまま返す", async () => {
    const expected = {
      groups: [{ key: "openai", value: 0.05, count: 5 }],
      total: { value: 0.05, count: 5 },
    };
    const json = vi.fn().mockResolvedValue(expected);
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      json,
    });

    const out = await queryAggregate({
      apiKey: "k",
      filter: { groupBy: "day", metric: "cost" },
    });

    expect(out).toEqual(expected);
    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(url).toBe("https://ingest.argosvix.com/v1/query/aggregate");
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({
      groupBy: "day",
      metric: "cost",
    });
  });

  it("401 で ArgosvixQueryError + status carry", async () => {
    const json = vi.fn().mockResolvedValue({ error: "missing Bearer" });
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 401,
      json,
    });
    try {
      await queryAggregate({ apiKey: "wrong" });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ArgosvixQueryError);
      expect((err as ArgosvixQueryError).status).toBe(401);
    }
  });
});
