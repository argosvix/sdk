/**
 * Scan used for the policy gate's block decision (part of the runtime control
 * plane; separated and redesigned from the earlier reuse of redaction.ts).
 *
 * The PATTERNS in redaction.ts are designed to be false-positive tolerant
 * (over-masking is acceptable). Reusing them as a blocking predicate would stop
 * legitimate calls in production (timestamps treated as card numbers, numeric
 * IDs as phone numbers, base64 as secrets). This module takes the opposite
 * stance: false negatives are tolerated, false positives are strictly avoided:
 *
 *   - The scan target is not the JSON stringification of the payload but only
 *     the string values collected by recursively walking the object (numeric
 *     fields / TypedArrays are excluded from the start; this also fixes the
 *     problem where JSON escaping broke detection across newlines)
 *   - The base64 body of data: URLs and very long strings containing no
 *     whitespace are treated as binary and skipped (prevents probabilistic
 *     false positives on images / file blobs and wasted CPU)
 *   - Card numbers are verified with a Luhn checksum (rejects e.g. 13-digit
 *     epoch-ms values)
 *   - Phone numbers / Japanese My Number only match separator-delimited forms
 *     (no match on runs of consecutive digits)
 *   - Secrets require boundaries on both sides (prevents partial matches
 *     inside base64 or ID strings)
 *
 * On detection, returns which field matched (JSON path) plus a masked snippet
 * so customers can debug false positives (plaintext is never returned).
 */

export interface PolicyScanHit {
  kind: "pii" | "secret";
  pattern: string;
  /** JSON path of the detected string value (e.g. messages[2].content). */
  path: string;
  /** Masked snippet (e.g. "al***om"). Never contains plaintext. */
  snippet: string;
}

const MAX_DEPTH = 8;
const MAX_STRINGS = 500;
// Per-string scan cap (anything beyond it only has its head scanned; CPU cap for the hot path)
const MAX_STRING_SCAN_CHARS = 262_144;
// Threshold above which a long string with no whitespace is treated as binary / base64 and skipped
const BINARY_LIKE_MIN_CHARS = 4_096;

// ---- PII (for blocking; false positives strictly avoided) ----

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
// Card number candidates (13-19 digits, with or without separators). Luhn-verified after matching.
const CC_CANDIDATE_RE = /(?<![\d-])(?:\d[ -]?){12,18}\d(?![\d-])/g;
// Phone forms requiring separators (JP leading-0 form + international form). Does not match runs of consecutive digits.
const PHONE_JP_RE = /(?<!\d)0\d{1,4}[- ]\d{1,4}[- ]\d{3,4}(?!\d)/;
const PHONE_INTL_RE = /(?<![\dA-Za-z])\+\d{1,3}[- ]\d{1,4}(?:[- ]\d{2,4}){1,3}(?!\d)/;
// Japanese My Number only in the 4-4-4 separated form (12 consecutive digits are indistinguishable from IDs, so excluded)
const MY_NUMBER_RE = /(?<![\d-])\d{4}-\d{4}-\d{4}(?![\d-])/;
// IPv4 validates octet values (0-255)
const IPV4_RE =
  /(?<![\d.])(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?![\d.])/;
// IPv6 (detection added in a later revision). Kept conservative to strictly avoid
// false positives; limited to:
//   - the full form (8 groups / 7 colons), or
//   - the "::" compressed form with 2+ groups on the left (e.g. 2001:db8::1)
// Does not match times like "12:34:56" (3 groups, no "::"), C++ "std::vector"
// (non-hex), or MACs "00:1A:..." (6 groups, no "::"). Compressed forms with a
// single left group like "fe80::1" are intentionally excluded (a short hex::hex
// can occur incidentally in code).
const IPV6_RE =
  /(?<![0-9A-Fa-f:])(?:(?:[0-9A-Fa-f]{1,4}:){7}[0-9A-Fa-f]{1,4}|(?:[0-9A-Fa-f]{1,4}:){2,6}:(?:[0-9A-Fa-f]{1,4}(?::[0-9A-Fa-f]{1,4}){0,5})?)(?![0-9A-Fa-f:])/;

// ---- secrets (bounded on both sides) ----

const B = "(?<![A-Za-z0-9_-])"; // Left boundary (prevents partial matches inside base64 / ID strings)
const SECRET_PATTERNS: Array<{ name: string; re: RegExp }> = [
  // anthropic before openai (otherwise sk-ant- would be classified as openai, making that pattern dead)
  { name: "anthropic_api_key", re: new RegExp(`${B}sk-ant-[A-Za-z0-9_-]{20,}`) },
  { name: "openai_api_key", re: new RegExp(`${B}sk-(?!ant-)[A-Za-z0-9_-]{20,}`) },
  { name: "aws_access_key", re: new RegExp(`${B}AKIA[0-9A-Z]{16}(?![A-Za-z0-9])`) },
  { name: "github_token", re: new RegExp(`${B}gh[pousr]_[A-Za-z0-9]{36,}`) },
  { name: "slack_token", re: new RegExp(`${B}xox[baprs]-[A-Za-z0-9-]{10,}`) },
  { name: "google_api_key", re: new RegExp(`${B}AIza[0-9A-Za-z_-]{35}(?![A-Za-z0-9_-])`) },
  { name: "stripe_key", re: new RegExp(`${B}[sr]k_(?:live|test)_[A-Za-z0-9]{20,}`) },
  { name: "private_key_block", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "argosvix_api_key", re: new RegExp(`${B}argk_[a-z0-9]{20,}`) },
];

/** Luhn checksum (validates that a card number is plausible). */
export function luhnValid(digits: string): boolean {
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (alt) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0;
}

function maskSnippet(match: string): string {
  if (match.length <= 4) return "****";
  return `${match.slice(0, 2)}***${match.slice(-2)}`;
}

function isBinaryLike(text: string): boolean {
  if (text.startsWith("data:") && text.includes(";base64,")) return true;
  // A very long string with no whitespace at all is treated as base64 / a blob / concatenated tokens
  if (text.length >= BINARY_LIKE_MIN_CHARS && !/\s/.test(text)) return true;
  return false;
}

interface TextValue {
  path: string;
  text: string;
}

/** Recursively collect only string values from the payload object, with their paths. */
export function collectTextValues(payload: unknown): TextValue[] {
  const out: TextValue[] = [];
  const seen = new Set<object>();
  const walk = (value: unknown, path: string, depth: number): void => {
    if (out.length >= MAX_STRINGS) return;
    if (typeof value === "string") {
      if (value.length === 0 || isBinaryLike(value)) return;
      out.push({
        path,
        text:
          value.length > MAX_STRING_SCAN_CHARS
            ? value.slice(0, MAX_STRING_SCAN_CHARS)
            : value,
      });
      return;
    }
    if (!value || typeof value !== "object" || depth >= MAX_DEPTH) return;
    if (seen.has(value as object)) return; // guard against circular references
    seen.add(value as object);
    if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return;
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        walk(value[i], `${path}[${i}]`, depth + 1);
      }
      return;
    }
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      walk(v, path ? `${path}.${k}` : k, depth + 1);
    }
  };
  walk(payload, "", 0);
  return out;
}

function scanTextForPii(text: string): { pattern: string; match: string } | null {
  const email = EMAIL_RE.exec(text);
  if (email) return { pattern: "email", match: email[0] };

  CC_CANDIDATE_RE.lastIndex = 0;
  let ccMatch: RegExpExecArray | null;
  while ((ccMatch = CC_CANDIDATE_RE.exec(text)) !== null) {
    const digits = ccMatch[0].replace(/[ -]/g, "");
    if (luhnValid(digits)) {
      return { pattern: "credit_card", match: ccMatch[0] };
    }
  }

  const phoneJp = PHONE_JP_RE.exec(text);
  if (phoneJp) return { pattern: "phone", match: phoneJp[0] };
  const phoneIntl = PHONE_INTL_RE.exec(text);
  if (phoneIntl) return { pattern: "phone", match: phoneIntl[0] };

  const myNumber = MY_NUMBER_RE.exec(text);
  if (myNumber) return { pattern: "my_number", match: myNumber[0] };

  const ipv4 = IPV4_RE.exec(text);
  if (ipv4) return { pattern: "ipv4", match: ipv4[0] };

  const ipv6 = IPV6_RE.exec(text);
  if (ipv6) return { pattern: "ipv6", match: ipv6[0] };

  return null;
}

function scanTextForSecret(text: string): { pattern: string; match: string } | null {
  for (const { name, re } of SECRET_PATTERNS) {
    const m = re.exec(text);
    if (m) return { pattern: name, match: m[0] };
  }
  return null;
}

/**
 * Walk the payload and return the first violation, or null if none detected.
 * Secrets are evaluated before PII (credentials are more severe than PII, so
 * they take reporting priority).
 */
export function scanPolicyViolation(
  payload: unknown,
  opts: { pii: boolean; secrets: boolean },
): PolicyScanHit | null {
  if (!opts.pii && !opts.secrets) return null;
  const values = collectTextValues(payload);
  for (const { path, text } of values) {
    if (opts.secrets) {
      const hit = scanTextForSecret(text);
      if (hit) {
        return { kind: "secret", pattern: hit.pattern, path, snippet: maskSnippet(hit.match) };
      }
    }
    if (opts.pii) {
      const hit = scanTextForPii(text);
      if (hit) {
        return { kind: "pii", pattern: hit.pattern, path, snippet: maskSnippet(hit.match) };
      }
    }
  }
  return null;
}
