import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  requestApproval,
  getApproval,
  waitForApproval,
  ArgosvixApprovalError,
} from "../approvals.js";

const BASE = { apiKey: "argk_test", endpoint: "https://gate.test/v1/ingest" };

function approvalJson(status = "pending") {
  return {
    approval: {
      id: "apr_0123456789abcdef0123456789abcdef",
      action: "delete_user",
      summary: "x",
      metadata: null,
      status,
      expiresAt: "2099-01-01T00:00:00Z",
      decidedAt: null,
      decidedBy: null,
      createdAt: "2026-06-10T00:00:00Z",
    },
  };
}

function okResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("approvals SDK API", () => {
  it("requestApproval = POST /v1/gate/approvals (endpoint prefix 導出込み)", async () => {
    fetchMock.mockResolvedValue(okResponse(approvalJson()));
    const approval = await requestApproval({
      ...BASE,
      action: "delete_user",
      summary: "x",
      timeoutSeconds: 600,
    });
    expect(approval.status).toBe("pending");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://gate.test/v1/gate/approvals");
    expect((init as RequestInit).method).toBe("POST");
    const sent = JSON.parse(String((init as RequestInit).body));
    expect(sent.action).toBe("delete_user");
    expect(sent.timeoutSeconds).toBe(600);
  });

  it("getApproval = GET 単票", async () => {
    fetchMock.mockResolvedValue(okResponse(approvalJson("approved")));
    const approval = await getApproval({
      ...BASE,
      id: "apr_0123456789abcdef0123456789abcdef",
    });
    expect(approval.status).toBe("approved");
  });

  it("4xx は ArgosvixApprovalError(status 付き)", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({ error: "approval gate is a Pro+ feature" }),
    } as unknown as Response);
    await expect(
      requestApproval({ ...BASE, action: "x", summary: "y" }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("waitForApproval = pending → approved を polling で拾う", async () => {
    let calls = 0;
    fetchMock.mockImplementation(async () => {
      calls++;
      return okResponse(approvalJson(calls >= 3 ? "approved" : "pending"));
    });
    const status = await waitForApproval({
      ...BASE,
      id: "apr_0123456789abcdef0123456789abcdef",
      pollIntervalMs: 1000,
      timeoutMs: 60_000,
    });
    expect(status).toBe("approved");
    expect(calls).toBe(3);
  }, 15_000);

  it("waitForApproval = 待機上限超過は expired (= default-deny)", async () => {
    fetchMock.mockResolvedValue(okResponse(approvalJson("pending")));
    const status = await waitForApproval({
      ...BASE,
      id: "apr_0123456789abcdef0123456789abcdef",
      pollIntervalMs: 1000,
      timeoutMs: 1,
    });
    expect(status).toBe("expired");
  });

  it("waitForApproval = 5xx / network error は再試行、404 は即 throw", async () => {
    let calls = 0;
    fetchMock.mockImplementation(async () => {
      calls++;
      if (calls === 1) {
        return { ok: false, status: 500, json: async () => ({}) } as unknown as Response;
      }
      return okResponse(approvalJson("denied"));
    });
    const status = await waitForApproval({
      ...BASE,
      id: "apr_0123456789abcdef0123456789abcdef",
      pollIntervalMs: 1000,
      timeoutMs: 60_000,
    });
    expect(status).toBe("denied");

    fetchMock.mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({ error: "approval not found" }),
    } as unknown as Response);
    await expect(
      waitForApproval({
        ...BASE,
        id: "apr_0123456789abcdef0123456789abcdef",
        pollIntervalMs: 1000,
        timeoutMs: 60_000,
      }),
    ).rejects.toBeInstanceOf(ArgosvixApprovalError);
  }, 15_000);
});
