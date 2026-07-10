import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  ArgosvixBudgetExceededError,
  ArgosvixBudgetGateUnavailableError,
  ArgosvixPolicyViolationError,
  BudgetGate,
} from "../budgetGate.js";
import { wrap, getRecorder } from "../client.js";

function gateResponse(opts: {
  limitUsd?: number;
  spentUsd?: number;
  enforceMode?: string;
  enabled?: boolean;
  noGate?: boolean;
  ttlSeconds?: number;
}) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      gates: opts.noGate
        ? []
        : [
            {
              id: "bg_1",
              projectId: null,
              monthlyLimitUsd: opts.limitUsd ?? 100,
              enforceMode: opts.enforceMode ?? "fail_open",
              enabled: opts.enabled ?? true,
            },
          ],
      spentUsdThisMonth: opts.spentUsd ?? 0,
      monthStart: "2026-06-01T00:00:00.000Z",
      ttlSeconds: opts.ttlSeconds ?? 60,
    }),
  } as unknown as Response;
}

const GATE_URL = "https://gate.test/v1/gate/budget";

function activeConfig(extra: Record<string, unknown> = {}) {
  return {
    apiKey: "argk_test",
    budgetGate: true,
    gateEndpoint: GATE_URL,
    ...extra,
  };
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

describe("BudgetGate (unit)", () => {
  it("budgetGate 未指定 = 完全 no-op で fetch しない", async () => {
    const gate = new BudgetGate({ apiKey: "argk_test" });
    await gate.check();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("apiKey なし = opt-in でも no-op", async () => {
    const gate = new BudgetGate({ budgetGate: true });
    await gate.check();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("上限超過で ArgosvixBudgetExceededError を投げる", async () => {
    fetchMock.mockResolvedValue(gateResponse({ limitUsd: 10, spentUsd: 10.5 }));
    const gate = new BudgetGate(activeConfig());
    await expect(gate.check()).rejects.toBeInstanceOf(ArgosvixBudgetExceededError);
  });

  it("上限未満なら素通し", async () => {
    fetchMock.mockResolvedValue(gateResponse({ limitUsd: 10, spentUsd: 3 }));
    const gate = new BudgetGate(activeConfig());
    await expect(gate.check()).resolves.toBeUndefined();
  });

  it("gate 未設定 account (= gates 空) は enforce なし", async () => {
    fetchMock.mockResolvedValue(gateResponse({ noGate: true }));
    const gate = new BudgetGate(activeConfig());
    await expect(gate.check()).resolves.toBeUndefined();
  });

  it("無効化済 gate (enabled false) は enforce なし", async () => {
    fetchMock.mockResolvedValue(
      gateResponse({ limitUsd: 10, spentUsd: 99, enabled: false }),
    );
    const gate = new BudgetGate(activeConfig());
    await expect(gate.check()).resolves.toBeUndefined();
  });

  it("fetch 失敗 + default (fail-open) = 素通し", async () => {
    fetchMock.mockRejectedValue(new Error("network down"));
    const gate = new BudgetGate(activeConfig());
    await expect(gate.check()).resolves.toBeUndefined();
  });

  it("fetch 失敗 + budgetGateFailClosed = ArgosvixBudgetGateUnavailableError", async () => {
    fetchMock.mockRejectedValue(new Error("network down"));
    const gate = new BudgetGate(activeConfig({ budgetGateFailClosed: true }));
    await expect(gate.check()).rejects.toBeInstanceOf(
      ArgosvixBudgetGateUnavailableError,
    );
  });

  it("503 (= migration 未適用等) は snapshot なし扱いで fail-open", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 503 } as Response);
    const gate = new BudgetGate(activeConfig());
    await expect(gate.check()).resolves.toBeUndefined();
  });

  it("TTL 内の連続 check は再 fetch しない", async () => {
    fetchMock.mockResolvedValue(gateResponse({ limitUsd: 10, spentUsd: 1 }));
    const gate = new BudgetGate(activeConfig());
    await gate.check();
    await gate.check();
    await gate.check();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("noteSpend のローカル補正で TTL 窓内でも超過を検知する", async () => {
    fetchMock.mockResolvedValue(gateResponse({ limitUsd: 1, spentUsd: 0.95 }));
    const gate = new BudgetGate(activeConfig());
    await gate.check(); // snapshot fetched; 0.95 < 1 so it passes
    gate.noteSpend(0.1); // local adjustment brings it to 1.05
    await expect(gate.check()).rejects.toBeInstanceOf(ArgosvixBudgetExceededError);
  });

  it("fail_closed gate は cache が MAX_STALE × TTL を超えると止める", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    fetchMock.mockResolvedValue(
      gateResponse({ limitUsd: 10, spentUsd: 1, enforceMode: "fail_closed", ttlSeconds: 60 }),
    );
    const gate = new BudgetGate(activeConfig());
    await gate.check(); // initial fetch succeeds
    // Backend is down from here on
    fetchMock.mockRejectedValue(new Error("network down"));
    // Advance past TTL × 5 = 300s so the cache is stale (moves the monotonic clock)
    vi.advanceTimersByTime(360_000);
    await expect(gate.check()).rejects.toBeInstanceOf(
      ArgosvixBudgetGateUnavailableError,
    );
  });

  it("fail_open gate は stale でも素通し (= stale-while-revalidate)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    fetchMock.mockResolvedValue(
      gateResponse({ limitUsd: 10, spentUsd: 1, enforceMode: "fail_open", ttlSeconds: 60 }),
    );
    const gate = new BudgetGate(activeConfig());
    await gate.check();
    fetchMock.mockRejectedValue(new Error("network down"));
    vi.advanceTimersByTime(360_000);
    await expect(gate.check()).resolves.toBeUndefined();
  });

  it("fetch 失敗後は FAILURE_RETRY_MS まで再試行しない (= 障害中の hot path 保護、R65b SB-1)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    fetchMock.mockRejectedValue(new Error("network down"));
    const gate = new BudgetGate(activeConfig());
    await gate.check(); // first fetch fails
    await gate.check(); // within the backoff window = no re-fetch
    await gate.check();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Retries once 30s have elapsed
    vi.advanceTimersByTime(31_000);
    await gate.check();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("fail_open の stale refresh は hot path を block しない (= 遅い fetch 中も即時評価)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    fetchMock.mockResolvedValue(
      gateResponse({ limitUsd: 10, spentUsd: 1, enforceMode: "fail_open", ttlSeconds: 60 }),
    );
    const gate = new BudgetGate(activeConfig());
    await gate.check(); // snapshot fetched
    // Subsequent fetches stay pending forever (simulates a slow backend)
    fetchMock.mockImplementation(() => new Promise(() => {}));
    vi.advanceTimersByTime(61_000); // past TTL (within MAX_STALE)
    // Resolves immediately from the stale snapshot without awaiting the pending fetch
    await expect(gate.check()).resolves.toBeUndefined();
  });

  it("fetch 中に noteSpend された分は reset で握り潰されない (= R65b M-1)", async () => {
    let resolveFetch: ((r: Response) => void) | null = null;
    fetchMock.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    const gate = new BudgetGate(activeConfig());
    const checking = gate.check(); // fetch starts (pending)
    gate.noteSpend(0.2); // spend recorded while the fetch is in flight
    resolveFetch!(gateResponse({ limitUsd: 1, spentUsd: 0.9 }));
    // Only the local adjustment as of fetch start (0) is subtracted; the 0.2 spent mid-fetch remains.
    // → 0.9 + 0.2 = 1.1 >= 1, so this first check itself blocks.
    await expect(checking).rejects.toBeInstanceOf(ArgosvixBudgetExceededError);
  });

  it("endpoint override から gate URL を同 prefix で導出する (= R65b M-2)", async () => {
    fetchMock.mockResolvedValue(gateResponse({ noGate: true }));
    const gate = new BudgetGate({
      apiKey: "argk_test",
      budgetGate: true,
      endpoint: "https://proxy.corp.example/argosvix/v1/ingest",
    });
    await gate.check();
    expect(fetchMock.mock.calls[0]![0]).toBe(
      "https://proxy.corp.example/argosvix/v1/gate/config",
    );
  });

  it("導出不能な custom endpoint では production に fallback せず gate 無効", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchMock.mockResolvedValue(gateResponse({ noGate: true }));
    const gate = new BudgetGate({
      apiKey: "argk_test",
      budgetGate: true,
      endpoint: "https://proxy.corp.example/custom-path",
    });
    await gate.check();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  it("fetch には Bearer apiKey が乗る", async () => {
    fetchMock.mockResolvedValue(gateResponse({ noGate: true }));
    const gate = new BudgetGate(activeConfig());
    await gate.check();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(GATE_URL);
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: "Bearer argk_test",
    });
  });
});

describe("BudgetGate (wrap 統合)", () => {
  function makeMockOpenAI() {
    const create = vi.fn(async () => ({
      id: "chatcmpl-x",
      model: "gpt-5.5",
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      choices: [{ message: { content: "hi" } }],
    }));
    return { chat: { completions: { create } }, _create: create };
  }

  it("超過 gate で provider 呼び出し前に block + error record が残る", async () => {
    fetchMock.mockImplementation(async (url: unknown) => {
      if (String(url) === GATE_URL) {
        return gateResponse({ limitUsd: 5, spentUsd: 9 });
      }
      return { ok: true, status: 200, json: async () => ({}) } as Response;
    });
    const mock = makeMockOpenAI();
    const client = wrap(mock, activeConfig() as Parameters<typeof wrap>[1]);
    await expect(
      client.chat.completions.create({
        model: "gpt-5.5",
        messages: [{ role: "user", content: "hi" }],
      }),
    ).rejects.toBeInstanceOf(ArgosvixBudgetExceededError);
    // The provider's original method is never called (enforced before execution)
    expect(mock._create).not.toHaveBeenCalled();
    // Blocked calls are still observed as error records
    const recorder = getRecorder(client)!;
    expect(recorder.getBufferSize()).toBe(1);
  });

  it("under-limit gate では透過して通常 record が残る", async () => {
    fetchMock.mockImplementation(async (url: unknown) => {
      if (String(url) === GATE_URL) {
        return gateResponse({ limitUsd: 100, spentUsd: 1 });
      }
      return { ok: true, status: 200, json: async () => ({}) } as Response;
    });
    const mock = makeMockOpenAI();
    const client = wrap(mock, activeConfig() as Parameters<typeof wrap>[1]);
    const res = await client.chat.completions.create({
      model: "gpt-5.5",
      messages: [{ role: "user", content: "hi" }],
    });
    expect((res as { id: string }).id).toBe("chatcmpl-x");
    expect(mock._create).toHaveBeenCalledOnce();
  });
});


// ----------------------------------------------------------------------
// Policy gate (/v1/gate/config unified shape + local evaluation)
// ----------------------------------------------------------------------

function configResponse(opts: {
  budget?: { limitUsd: number; spentUsd: number } | null;
  policy?: {
    modelAllowlist?: string[] | null;
    blockPii?: boolean;
    blockSecrets?: boolean;
    enforceMode?: string;
    enabled?: boolean;
  } | null;
}) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      budget: {
        gates: opts.budget
          ? [
              {
                id: "bg_1",
                projectId: null,
                monthlyLimitUsd: opts.budget.limitUsd,
                enforceMode: "fail_open",
                enabled: true,
              },
            ]
          : [],
        spentUsdThisMonth: opts.budget?.spentUsd ?? 0,
        monthStart: "2026-06-01T00:00:00.000Z",
      },
      policy: opts.policy
        ? {
            id: "pg_1",
            modelAllowlist: opts.policy.modelAllowlist ?? null,
            blockPii: opts.policy.blockPii ?? false,
            blockSecrets: opts.policy.blockSecrets ?? false,
            enforceMode: opts.policy.enforceMode ?? "fail_open",
            enabled: opts.policy.enabled ?? true,
          }
        : null,
      ttlSeconds: 60,
    }),
  } as unknown as Response;
}

function policyConfig(extra: Record<string, unknown> = {}) {
  return {
    apiKey: "argk_test",
    policyGate: true,
    gateEndpoint: GATE_URL,
    ...extra,
  };
}

describe("PolicyGate (unit)", () => {
  it("allowlist 外の model は block、内は通す", async () => {
    fetchMock.mockResolvedValue(
      configResponse({ policy: { modelAllowlist: ["gpt-5.5"] } }),
    );
    const gate = new BudgetGate(policyConfig());
    await expect(
      gate.check({ model: "gpt-4o-mini", payload: { model: "gpt-4o-mini" } }),
    ).rejects.toMatchObject({ reason: "model_not_allowed" });
    await expect(
      gate.check({ model: "gpt-5.5", payload: { model: "gpt-5.5" } }),
    ).resolves.toBeUndefined();
  });

  it("R72b MEDIUM 3: models/ prefix は allowlist 側・候補側どちらでも正規化して一致", async () => {
    // Allowlist has the bare name; the candidate is "models/gemini-pro" (Python legacy SDK form)
    fetchMock.mockResolvedValue(
      configResponse({ policy: { modelAllowlist: ["gemini-pro"] } }),
    );
    const gate = new BudgetGate(policyConfig());
    await expect(
      gate.check({ model: "models/gemini-pro" }),
    ).resolves.toBeUndefined();
    // An allowlist entry stored with the prefix still matches the bare name
    fetchMock.mockResolvedValue(
      configResponse({ policy: { modelAllowlist: ["models/gemini-pro"] } }),
    );
    const gate2 = new BudgetGate(policyConfig());
    await expect(gate2.check({ model: "gemini-pro" })).resolves.toBeUndefined();
    // A different model is still blocked
    await expect(
      gate2.check({ model: "models/gemini-flash" }),
    ).rejects.toMatchObject({ reason: "model_not_allowed" });
  });

  it("R72b HIGH 1: policyGateFailClosed = cold start 取得失敗で block", async () => {
    fetchMock.mockRejectedValue(new Error("network down"));
    const gate = new BudgetGate({
      ...policyConfig(),
      policyGateFailClosed: true,
    });
    await expect(gate.check({ model: "gpt-5.5" })).rejects.toBeInstanceOf(
      ArgosvixBudgetGateUnavailableError,
    );
  });

  it("model は payload からも補完される", async () => {
    fetchMock.mockResolvedValue(
      configResponse({ policy: { modelAllowlist: ["gpt-5.5"] } }),
    );
    const gate = new BudgetGate(policyConfig());
    await expect(
      gate.check({ payload: { model: "claude-fable-5" } }),
    ).rejects.toBeInstanceOf(ArgosvixPolicyViolationError);
  });

  it("QA M-5: allowlist 設定済 + model 解決不能 = fail_closed なら block", async () => {
    fetchMock.mockResolvedValue(
      configResponse({
        policy: { modelAllowlist: ["gpt-5.5"], enforceMode: "fail_closed" },
      }),
    );
    const gate = new BudgetGate(policyConfig());
    // Neither ctx.model nor payload.model is present = cannot match → blocked under fail_closed
    await expect(
      gate.check({ payload: { messages: [{ role: "user", content: "hi" }] } }),
    ).rejects.toMatchObject({ reason: "model_not_allowed" });
  });

  it("QA M-5: allowlist 設定済 + model 解決不能 = fail_open は従来どおり素通し", async () => {
    fetchMock.mockResolvedValue(
      configResponse({
        policy: { modelAllowlist: ["gpt-5.5"], enforceMode: "fail_open" },
      }),
    );
    const gate = new BudgetGate(policyConfig());
    await expect(
      gate.check({ payload: { messages: [{ role: "user", content: "hi" }] } }),
    ).resolves.toBeUndefined();
  });

  it("blockPii = payload 中の email を検知して block", async () => {
    fetchMock.mockResolvedValue(configResponse({ policy: { blockPii: true } }));
    const gate = new BudgetGate(policyConfig());
    await expect(
      gate.check({
        payload: {
          model: "gpt-5.5",
          messages: [{ role: "user", content: "contact alice@example.com" }],
        },
      }),
    ).rejects.toMatchObject({ reason: "pii_detected" });
    // Content without PII passes
    await expect(
      gate.check({
        payload: { model: "gpt-5.5", messages: [{ role: "user", content: "hello" }] },
      }),
    ).resolves.toBeUndefined();
  });

  it("blockSecrets = API key らしき token を検知して block", async () => {
    fetchMock.mockResolvedValue(
      configResponse({ policy: { blockSecrets: true } }),
    );
    const gate = new BudgetGate(policyConfig());
    await expect(
      gate.check({
        payload: {
          model: "gpt-5.5",
          messages: [
            { role: "user", content: "use key sk-abcdefghijklmnopqrstuvwx123456" },
          ],
        },
      }),
    ).rejects.toMatchObject({ reason: "secret_detected" });
    await expect(
      gate.check({
        payload: { model: "gpt-5.5", messages: [{ role: "user", content: "no secrets" }] },
      }),
    ).resolves.toBeUndefined();
  });

  it("policy 無効 (enabled false) / 未設定は素通し", async () => {
    fetchMock.mockResolvedValue(
      configResponse({
        policy: { modelAllowlist: ["only-this"], enabled: false },
      }),
    );
    const gate = new BudgetGate(policyConfig());
    await expect(
      gate.check({ model: "anything", payload: { model: "anything" } }),
    ).resolves.toBeUndefined();
  });

  it("policyGate opt-in なしでは policy が設定されていても評価しない", async () => {
    fetchMock.mockResolvedValue(
      configResponse({
        budget: { limitUsd: 100, spentUsd: 1 },
        policy: { modelAllowlist: ["only-this"] },
      }),
    );
    const gate = new BudgetGate(activeConfig()); // budgetGate only
    await expect(
      gate.check({ model: "other-model", payload: { model: "other-model" } }),
    ).resolves.toBeUndefined();
  });

  it("budgetGate opt-in なしでは budget 超過でも policy だけ評価する", async () => {
    fetchMock.mockResolvedValue(
      configResponse({
        budget: { limitUsd: 1, spentUsd: 99 },
        policy: { modelAllowlist: ["gpt-5.5"] },
      }),
    );
    const gate = new BudgetGate(policyConfig());
    await expect(
      gate.check({ model: "gpt-5.5", payload: { model: "gpt-5.5" } }),
    ).resolves.toBeUndefined(); // budget is not evaluated
  });

  it("budget + policy 同時 opt-in で両方評価する", async () => {
    fetchMock.mockResolvedValue(
      configResponse({
        budget: { limitUsd: 1, spentUsd: 99 },
        policy: { modelAllowlist: ["gpt-5.5"] },
      }),
    );
    const gate = new BudgetGate(
      policyConfig({ budgetGate: true }),
    );
    await expect(
      gate.check({ model: "gpt-5.5", payload: { model: "gpt-5.5" } }),
    ).rejects.toBeInstanceOf(ArgosvixBudgetExceededError);
  });

  it("wrap 統合: allowlist 違反は provider 到達前に block + error record", async () => {
    fetchMock.mockImplementation(async (url: unknown) => {
      if (String(url) === GATE_URL) {
        return configResponse({ policy: { modelAllowlist: ["allowed-model"] } });
      }
      return { ok: true, status: 200, json: async () => ({}) } as Response;
    });
    const create = vi.fn(async () => ({ id: "x", model: "gpt-5.5", usage: {}, choices: [] }));
    const mock = { chat: { completions: { create } }, _create: create };
    const client = wrap(mock, policyConfig() as Parameters<typeof wrap>[1]);
    await expect(
      client.chat.completions.create({
        model: "gpt-5.5",
        messages: [{ role: "user", content: "hi" }],
      }),
    ).rejects.toBeInstanceOf(ArgosvixPolicyViolationError);
    expect(create).not.toHaveBeenCalled();
    expect(getRecorder(client)!.getBufferSize()).toBe(1);
  });
});


// ----------------------------------------------------------------------
// Fix-bundle verification (false-positive prevention + Gemini legacy + failure paths)
// ----------------------------------------------------------------------

describe("PolicyGate negative corpus (= 正当 payload を block しない、R66b SB-2/H-2/H-3)", () => {
  const legitPayloads: Array<[string, unknown]> = [
    ["epoch ms timestamp", { model: "gpt-5.5", messages: [{ role: "user", content: "event at 1765432101234 please summarize" }] }],
    ["seed 数値 (string)", { model: "gpt-5.5", messages: [{ role: "user", content: "use seed 12345678 for retry" }] }],
    ["時刻文字列", { model: "gpt-5.5", messages: [{ role: "user", content: "log shows 12:34:56 error spike" }] }],
    ["uuid", { model: "gpt-5.5", messages: [{ role: "user", content: "trace 550e8400-e29b-41d4-a716-446655440000" }] }],
    ["task- 系 ID", { model: "gpt-5.5", messages: [{ role: "user", content: "see task-9f8b7c6d5e4f3a2b1c0d for details" }] }],
    ["数値 field", { model: "gpt-5.5", seed: 1765432101234, max_tokens: 4096, messages: [{ role: "user", content: "hi" }] }],
    ["C++ namespace (= :: が IPv6 扱いされない)", { model: "gpt-5.5", messages: [{ role: "user", content: "use std::vector and absl::flat_hash_map here" }] }],
    ["MAC address (= 6 group / :: なし)", { model: "gpt-5.5", messages: [{ role: "user", content: "device 00:1A:2B:3C:4D:5E rebooted" }] }],
    ["Luhn 不成立の 13 桁", { model: "gpt-5.5", messages: [{ role: "user", content: "order id 1234567890123" }] }],
    ["base64 data URL", { model: "gpt-5.5", messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: `data:image/png;base64,${"sk".repeat(3000)}` } }] }] }],
  ];

  for (const [label, payload] of legitPayloads) {
    it(`block しない: ${label}`, async () => {
      fetchMock.mockResolvedValue(
        configResponse({ policy: { blockPii: true, blockSecrets: true } }),
      );
      const gate = new BudgetGate(policyConfig());
      await expect(gate.check({ payload })).resolves.toBeUndefined();
    });
  }

  it("block する: IPv6 (完全形 + 左 2 group 以上の :: 圧縮形) (R72b MEDIUM 3)", async () => {
    fetchMock.mockResolvedValue(configResponse({ policy: { blockPii: true } }));
    for (const addr of [
      "2001:0db8:85a3:0000:0000:8a2e:0370:7334",
      "2001:db8::1",
    ]) {
      const gate = new BudgetGate(policyConfig());
      await expect(
        gate.check({
          payload: { model: "gpt-5.5", messages: [{ role: "user", content: `client ip ${addr} logged` }] },
        }),
      ).rejects.toMatchObject({ reason: "pii_detected" });
    }
  });

  it("block する: Luhn 成立カード番号 (改行/区切り跨ぎ含む)", async () => {
    fetchMock.mockResolvedValue(configResponse({ policy: { blockPii: true } }));
    const gate = new BudgetGate(policyConfig());
    await expect(
      gate.check({
        payload: { model: "gpt-5.5", messages: [{ role: "user", content: "card 4111-1111-1111-1111 expires soon" }] },
      }),
    ).rejects.toMatchObject({ reason: "pii_detected" });
  });

  it("block する: 実改行入り text 中のカード番号 (= JSON escape 非依存)", async () => {
    fetchMock.mockResolvedValue(configResponse({ policy: { blockPii: true } }));
    const gate = new BudgetGate(policyConfig());
    await expect(
      gate.check({
        payload: { model: "gpt-5.5", messages: [{ role: "user", content: "card:\n4111 1111 1111 1111" }] },
      }),
    ).rejects.toMatchObject({ reason: "pii_detected" });
  });

  it("sk-ant- は anthropic_api_key として告知される (= dead pattern 解消)", async () => {
    fetchMock.mockResolvedValue(configResponse({ policy: { blockSecrets: true } }));
    const gate = new BudgetGate(policyConfig());
    await expect(
      gate.check({
        payload: { model: "gpt-5.5", messages: [{ role: "user", content: "key sk-ant-abcdefghijklmnopqrstuv" }] },
      }),
    ).rejects.toMatchObject({ detail: expect.stringContaining("anthropic_api_key") });
  });

  it("violation detail に JSON path + masked snippet が載る (= 平文は載らない)", async () => {
    fetchMock.mockResolvedValue(configResponse({ policy: { blockPii: true } }));
    const gate = new BudgetGate(policyConfig());
    const err = await gate
      .check({
        payload: { model: "gpt-5.5", messages: [{ role: "user", content: "mail alice@example.com" }] },
      })
      .then(() => null)
      .catch((e: unknown) => e as ArgosvixPolicyViolationError);
    expect(err).not.toBeNull();
    expect(err!.detail).toContain("messages[0].content");
    expect(err!.detail).not.toContain("alice@example.com");
  });

  it("circular payload は検査不能として素通し (= fail-open 方向)", async () => {
    fetchMock.mockResolvedValue(
      configResponse({ policy: { blockPii: true, blockSecrets: true } }),
    );
    const gate = new BudgetGate(policyConfig());
    const payload: Record<string, unknown> = { model: "gpt-5.5" };
    payload["self"] = payload;
    await expect(gate.check({ payload })).resolves.toBeUndefined();
  });

  it("model_not_allowed の error message は model を sanitize する", async () => {
    fetchMock.mockResolvedValue(
      configResponse({ policy: { modelAllowlist: ["gpt-5.5"] } }),
    );
    const gate = new BudgetGate(policyConfig());
    const err = await gate
      .check({ model: "秘密の prompt 本文 <script>", payload: {} })
      .then(() => null)
      .catch((e: unknown) => e as ArgosvixPolicyViolationError);
    expect(err).not.toBeNull();
    expect(err!.detail).not.toContain("秘密");
    expect(err!.detail).not.toContain("<script>");
  });

  it("policy の stale fail_closed は budget と同様に block する", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    fetchMock.mockResolvedValue(
      configResponse({
        policy: { modelAllowlist: ["gpt-5.5"], enforceMode: "fail_closed" },
      }),
    );
    const gate = new BudgetGate(policyConfig());
    await gate.check({ model: "gpt-5.5", payload: { model: "gpt-5.5" } });
    fetchMock.mockRejectedValue(new Error("down"));
    vi.advanceTimersByTime(360_000);
    await expect(
      gate.check({ model: "gpt-5.5", payload: { model: "gpt-5.5" } }),
    ).rejects.toBeInstanceOf(ArgosvixBudgetGateUnavailableError);
  });

  it("旧 budget shape + policyGate opt-in は 1 回だけ warn (= silent no-op の告知)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchMock.mockResolvedValue(gateResponse({ noGate: true })); // legacy shape
    const gate = new BudgetGate(policyConfig());
    await gate.check({ payload: { model: "x" } });
    await gate.check({ payload: { model: "x" } });
    const policyWarns = warnSpy.mock.calls.filter((c) =>
      String(c[0]).includes("policy gate"),
    );
    expect(policyWarns).toHaveLength(1);
    warnSpy.mockRestore();
  });
});

describe("Gemini legacy × allowlist (= R66b H-1)", () => {
  it("legacy 経路でも modelName で allowlist 評価される", async () => {
    fetchMock.mockImplementation(async (url: unknown) => {
      if (String(url) === GATE_URL) {
        return configResponse({ policy: { modelAllowlist: ["allowed-model"] } });
      }
      return { ok: true, status: 200, json: async () => ({}) } as Response;
    });
    const generateContent = vi.fn(async () => ({
      response: { usageMetadata: {} },
    }));
    const legacyModel = { generateContent, model: "gemini-pro" };
    const client = {
      getGenerativeModel: vi.fn(() => legacyModel),
    };
    Object.defineProperty(client.constructor, "name", { value: "GoogleGenerativeAI" });
    const wrapped = wrap(client, policyConfig() as Parameters<typeof wrap>[1]);
    const model = wrapped.getGenerativeModel({ model: "gemini-pro" });
    await expect(
      model.generateContent("hello"),
    ).rejects.toBeInstanceOf(ArgosvixPolicyViolationError);
    expect(generateContent).not.toHaveBeenCalled();
  });
});

describe("BudgetGate per-project", () => {
  const PROJ = "proj_" + "a".repeat(32);

  function projGateResponse(opts: {
    accountLimit?: number;
    accountSpent?: number;
    projectLimit?: number;
    projectSpent?: number;
    projectEnforce?: string;
  }) {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        gates: [
          {
            id: "bg_acct",
            projectId: null,
            monthlyLimitUsd: opts.accountLimit ?? 1000,
            enforceMode: "fail_open",
            enabled: true,
          },
          {
            id: "bg_proj",
            projectId: PROJ,
            monthlyLimitUsd: opts.projectLimit ?? 10,
            enforceMode: opts.projectEnforce ?? "fail_open",
            enabled: true,
          },
        ],
        spentUsdThisMonth: opts.accountSpent ?? 0,
        spentUsdByProject: { [PROJ]: opts.projectSpent ?? 0 },
        monthStart: "2026-06-01T00:00:00.000Z",
        ttlSeconds: 60,
      }),
    } as unknown as Response;
  }

  it("project 上限超過で block(account は余裕でも)", async () => {
    fetchMock.mockResolvedValue(
      projGateResponse({ accountLimit: 1000, accountSpent: 5, projectLimit: 10, projectSpent: 10.5 }),
    );
    const gate = new BudgetGate(activeConfig({ projectId: PROJ }));
    await expect(gate.check()).rejects.toBeInstanceOf(ArgosvixBudgetExceededError);
  });

  it("project 上限未満なら素通し", async () => {
    fetchMock.mockResolvedValue(
      projGateResponse({ projectLimit: 10, projectSpent: 3 }),
    );
    const gate = new BudgetGate(activeConfig({ projectId: PROJ }));
    await expect(gate.check()).resolves.toBeUndefined();
  });

  it("config.projectId が無ければ project gate は適用しない(account のみ)", async () => {
    fetchMock.mockResolvedValue(
      projGateResponse({ accountLimit: 1000, accountSpent: 5, projectLimit: 10, projectSpent: 50 }),
    );
    const gate = new BudgetGate(activeConfig()); // no projectId specified
    await expect(gate.check()).resolves.toBeUndefined();
  });

  it("localSpend が project 上限を押し上げて block", async () => {
    fetchMock.mockResolvedValue(
      projGateResponse({ projectLimit: 10, projectSpent: 9.5 }),
    );
    const gate = new BudgetGate(activeConfig({ projectId: PROJ }));
    await gate.check(); // 9.5 < 10 so it passes
    gate.noteSpend(0.6); // 10.1 exceeds the limit
    await expect(gate.check()).rejects.toBeInstanceOf(ArgosvixBudgetExceededError);
  });

  it("account 上限超過は project に余裕でも block(最も厳しい上限が勝つ)", async () => {
    fetchMock.mockResolvedValue(
      projGateResponse({ accountLimit: 10, accountSpent: 10.5, projectLimit: 1000, projectSpent: 1 }),
    );
    const gate = new BudgetGate(activeConfig({ projectId: PROJ }));
    await expect(gate.check()).rejects.toBeInstanceOf(ArgosvixBudgetExceededError);
  });
});

describe("BudgetGate per-tag", () => {
  function tagGateResponse(opts: {
    tagKey?: string;
    tagValue?: string;
    tagLimit?: number;
    tagSpent?: number;
    tagEnforce?: string;
  }) {
    const tk = opts.tagKey ?? "service";
    const tv = opts.tagValue ?? "checkout";
    return {
      ok: true,
      status: 200,
      json: async () => ({
        gates: [
          {
            id: "bg_acct",
            projectId: null,
            tagKey: null,
            tagValue: null,
            monthlyLimitUsd: 1000,
            enforceMode: "fail_open",
            enabled: true,
          },
          {
            id: "bg_tag",
            projectId: null,
            tagKey: tk,
            tagValue: tv,
            monthlyLimitUsd: opts.tagLimit ?? 10,
            enforceMode: opts.tagEnforce ?? "fail_open",
            enabled: true,
          },
        ],
        spentUsdThisMonth: 5,
        spentUsdByProject: {},
        spentUsdByTag: [{ tagKey: tk, tagValue: tv, spentUsd: opts.tagSpent ?? 0 }],
        monthStart: "2026-06-01T00:00:00.000Z",
        ttlSeconds: 60,
      }),
    } as unknown as Response;
  }

  it("config.tags が gate に一致 + 超過で block", async () => {
    fetchMock.mockResolvedValue(tagGateResponse({ tagLimit: 10, tagSpent: 10.5 }));
    const gate = new BudgetGate(activeConfig({ tags: { service: "checkout" } }));
    await expect(gate.check()).rejects.toBeInstanceOf(ArgosvixBudgetExceededError);
  });

  it("一致 + 未満なら素通し", async () => {
    fetchMock.mockResolvedValue(tagGateResponse({ tagLimit: 10, tagSpent: 3 }));
    const gate = new BudgetGate(activeConfig({ tags: { service: "checkout" } }));
    await expect(gate.check()).resolves.toBeUndefined();
  });

  it("config.tags が gate の tag と不一致なら tag gate は適用しない", async () => {
    fetchMock.mockResolvedValue(tagGateResponse({ tagLimit: 10, tagSpent: 50 }));
    const gate = new BudgetGate(activeConfig({ tags: { service: "search" } })); // not checkout
    await expect(gate.check()).resolves.toBeUndefined();
  });

  it("tags 未設定なら tag gate は適用しない", async () => {
    fetchMock.mockResolvedValue(tagGateResponse({ tagLimit: 10, tagSpent: 50 }));
    const gate = new BudgetGate(activeConfig());
    await expect(gate.check()).resolves.toBeUndefined();
  });

  it("localSpend が tag 上限を押し上げて block", async () => {
    fetchMock.mockResolvedValue(tagGateResponse({ tagLimit: 10, tagSpent: 9.5 }));
    const gate = new BudgetGate(activeConfig({ tags: { service: "checkout" } }));
    await gate.check(); // 9.5 < 10
    gate.noteSpend(0.6); // 10.1
    await expect(gate.check()).rejects.toBeInstanceOf(ArgosvixBudgetExceededError);
  });
});
