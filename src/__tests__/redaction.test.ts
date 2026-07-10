import { describe, it, expect } from "vitest";
import { redactPii, redactToolCall } from "../redaction.js";

describe("redactPii", () => {
  it("returns empty string for null", () => {
    expect(redactPii(null)).toBe("");
  });

  it("returns empty string for undefined", () => {
    expect(redactPii(undefined)).toBe("");
  });

  it("returns empty string for empty input", () => {
    expect(redactPii("")).toBe("");
  });

  it("redacts a single email address", () => {
    expect(redactPii("contact me at alice@example.com please")).toBe(
      "contact me at [REDACTED_EMAIL] please",
    );
  });

  it("redacts multiple email addresses in one string", () => {
    expect(redactPii("from a@b.co to c+tag@d.io")).toBe(
      "from [REDACTED_EMAIL] to [REDACTED_EMAIL]",
    );
  });

  it("redacts a credit card number with hyphens", () => {
    expect(redactPii("card 4111-1111-1111-1111")).toBe("card [REDACTED_CC]");
  });

  it("redacts a credit card number with spaces", () => {
    expect(redactPii("card 4111 1111 1111 1111")).toBe("card [REDACTED_CC]");
  });

  it("redacts a credit card number without separators", () => {
    expect(redactPii("card 4111111111111111")).toBe("card [REDACTED_CC]");
  });

  it("audit round2 M31 = redacts a dot-separated credit card fully (no last-4 leak)", () => {
    const out = redactPii("card 4111.1111.1111.1111");
    expect(out).toBe("card [REDACTED_CC]");
    expect(out).not.toContain("1111");
  });

  it("redacts a Japanese mobile phone number", () => {
    expect(redactPii("call 090-1234-5678")).toBe("call [REDACTED_PHONE]");
  });

  it("redacts an international phone number with country code", () => {
    expect(redactPii("call +81 90 1234 5678")).toBe("call [REDACTED_PHONE]");
  });

  it("redacts an IPv4 address", () => {
    expect(redactPii("server at 192.168.1.1 is down")).toBe(
      "server at [REDACTED_IPV4] is down",
    );
  });

  it("redacts an IPv6 address (full form)", () => {
    expect(redactPii("from 2001:0db8:85a3:0000:0000:8a2e:0370:7334")).toBe(
      "from [REDACTED_IPV6]",
    );
  });

  it("redacts an IPv6 loopback (::1)", () => {
    const out = redactPii("loopback ::1 confirmed");
    expect(out).toContain("[REDACTED_IPV6]");
    expect(out).not.toContain("::1 confirmed");
  });

  it("redacts an IPv6 link-local shortened (fe80::1234)", () => {
    const out = redactPii("from fe80::1234 here");
    expect(out).toContain("[REDACTED_IPV6]");
    expect(out).not.toContain("fe80::1234");
  });

  it("redacts a credit card number split across a newline", () => {
    const out = redactPii("card 4111-1111-\n1111-1111 end");
    expect(out).toContain("[REDACTED_CC]");
    expect(out).not.toContain("4111-1111");
  });

  it("redacts a マイナンバー (12-digit number)", () => {
    // The CC pattern covers 13-19 digits; exactly 12 digits routes to MYNUMBER.
    // In the PATTERNS array order (Email → CC → MYNUMBER → Phone → IPv4 → IPv6)
    // CC is evaluated first, but 12 digits do not match its
    // \b(?:\d[ -]?){13,19}\b, so they fall through and the subsequent MYNUMBER
    // pattern replaces them.
    expect(redactPii("番号 123456789012 です")).toBe("番号 [REDACTED_MYNUMBER] です");
  });

  it("passes through text with no PII unchanged", () => {
    expect(redactPii("Hello world, today is a fine day.")).toBe(
      "Hello world, today is a fine day.",
    );
  });

  it("redacts mixed PII in one prompt", () => {
    const input =
      "User alice@example.com (phone 090-1234-5678) reports 4111-1111-1111-1111 issue from 10.0.0.1.";
    const out = redactPii(input);
    expect(out).toContain("[REDACTED_EMAIL]");
    expect(out).toContain("[REDACTED_PHONE]");
    expect(out).toContain("[REDACTED_CC]");
    expect(out).toContain("[REDACTED_IPV4]");
    expect(out).not.toContain("alice@example.com");
    expect(out).not.toContain("4111-1111-1111-1111");
  });

  it("coerces non-string input via String() defensively", () => {
    // @ts-expect-error testing defensive coercion
    expect(redactPii(12345)).toBe("12345");
  });
});

describe("redactToolCall", () => {
  it("preserves name and applies redaction to arguments and result", () => {
    const out = redactToolCall({
      name: "send_email",
      arguments: '{"to":"alice@example.com","subject":"hello"}',
      result: "Email sent to alice@example.com",
    });
    expect(out.name).toBe("send_email");
    expect(out.arguments).toContain("[REDACTED_EMAIL]");
    expect(out.arguments).not.toContain("alice@example.com");
    expect(out.result).toContain("[REDACTED_EMAIL]");
    expect(out.result).not.toContain("alice@example.com");
  });

  it("omits arguments and result when not provided", () => {
    const out = redactToolCall({ name: "ping" });
    expect(out).toEqual({ name: "ping" });
    expect(out.arguments).toBeUndefined();
    expect(out.result).toBeUndefined();
  });
});

// redactPiiWithCounts + helpers (added in v0.4.1, 2026-06-02)
import {
  hasAnyRedaction,
  mergeRedactionCounts,
  redactPiiWithCounts,
} from "../redaction.js";

describe("redactPiiWithCounts", () => {
  it("空文字 / null / undefined → counts 空 + text そのまま", () => {
    expect(redactPiiWithCounts("")).toEqual({ text: "", counts: {} });
    expect(redactPiiWithCounts(null)).toEqual({ text: "", counts: {} });
    expect(redactPiiWithCounts(undefined)).toEqual({ text: "", counts: {} });
  });

  it("email 2 件 + phone 1 件を count", () => {
    const { text, counts } = redactPiiWithCounts(
      "Reach me at alice@example.com or bob@example.com, my phone is 090-1234-5678.",
    );
    expect(text).not.toContain("alice@example.com");
    expect(text).not.toContain("bob@example.com");
    expect(text).not.toContain("090-1234-5678");
    expect(counts.email).toBe(2);
    expect(counts.phone).toBeGreaterThanOrEqual(1);
  });

  it("PII なし → counts 空 + 元 text", () => {
    const { text, counts } = redactPiiWithCounts("Hello world, no PII here.");
    expect(text).toBe("Hello world, no PII here.");
    expect(Object.keys(counts).length).toBe(0);
  });
});

describe("mergeRedactionCounts", () => {
  it("複数 counts を加算合成", () => {
    const a = { email: 1, phone: 2 };
    const b = { email: 3, ipv4: 1 };
    const merged = mergeRedactionCounts(a, b);
    expect(merged.email).toBe(4);
    expect(merged.phone).toBe(2);
    expect(merged.ipv4).toBe(1);
  });

  it("空 + 空 = 空", () => {
    expect(mergeRedactionCounts({}, {})).toEqual({});
  });
});

describe("hasAnyRedaction", () => {
  it("いずれかの count > 0 → true", () => {
    expect(hasAnyRedaction({ email: 1 })).toBe(true);
    expect(hasAnyRedaction({ email: 0, phone: 1 })).toBe(true);
  });

  it("全 0 / 空 → false", () => {
    expect(hasAnyRedaction({})).toBe(false);
    expect(hasAnyRedaction({ email: 0, phone: 0 })).toBe(false);
  });
});

describe("redactPii audit round2 regressions", () => {
  it("全角数字のクレジットカード番号をマスクする (#16)", () => {
    const out = redactPii("カード番号は ４１１１１１１１１１１１１１１１ です");
    expect(out).toContain("[REDACTED_CC]");
    expect(out).not.toContain("４１１１");
  });

  it("全角数字のマイナンバー (12桁) をマスクする (#16)", () => {
    const out = redactPii("マイナンバー １２３４５６７８９０１２");
    expect(out).toMatch(/REDACTED_(CC|MYNUMBER)/);
    expect(out).not.toContain("１２３４");
  });

  it("IDN ドメインのメールアドレスをマスクする (#17)", () => {
    const out = redactPii("連絡先 user@例え.jp まで");
    expect(out).toContain("[REDACTED_EMAIL]");
    expect(out).not.toContain("例え.jp");
  });

  it("非ASCII local-part のメールをマスクする (#17)", () => {
    const out = redactPii("山田@example.com に連絡");
    expect(out).toContain("[REDACTED_EMAIL]");
    expect(out).not.toContain("@example.com");
  });
});
