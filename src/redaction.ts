/**
 * Plaintext PII redaction for the captureContent opt-in path.
 *
 * Helper that automatically masks email addresses / credit card numbers /
 * phone numbers / Japanese My Number / IP addresses before prompt and
 * completion bodies are sent verbatim under the Pro+ plaintext storage
 * feature's SDK-side opt-in.
 *
 * Design policy:
 *   - False-positive tolerant, false negatives strictly avoided (over-masking
 *     is OK; missing PII is not). This function always runs unless the user
 *     explicitly disables it with disablePiiRedaction:true.
 *   - Pure function with no side effects. Same input always yields same output.
 *   - An empty string or null / undefined input is returned as-is.
 *   - Non-string input (objects etc.) is stringified with String() before
 *     replacement; the original type is not preserved — a string is returned.
 *
 * Known limitations:
 *   - International phone number formats are too diverse to cover fully.
 *     Conservative patterns focus on the major Japanese forms
 *     (+81-XX-XXXX-XXXX / 090-XXXX-XXXX etc.) and the North American
 *     (123) 456-7890 form.
 *   - Credit card numbers are not Luhn-checked (false-positive tolerant).
 *     Any run of 13-19 digits (including space and hyphen separators) is
 *     replaced uniformly.
 *   - My Number is 12 digits. Where it collides with the credit card pattern,
 *     the 12-digit run may match the CC pattern first — either way both get
 *     replaced, so there is no PII-leak risk (only the masking category may
 *     be inaccurate).
 */

/**
 * Each pattern carries a type tag so we can aggregate a counts JSON into the
 * backend's redaction_metadata column — each regex declares which category it
 * belongs to. metadata = { email: N, creditCard: N, ... }.
 */
const PATTERNS: Array<{ regex: RegExp; replacement: string; type: RedactionType }> = [
  // Email, RFC 5322 based. An earlier ASCII-only pattern missed IDN domains
  // (e.g. Japanese-script domains under .jp) and non-ASCII local parts.
  // Following the false-positive-tolerant policy, local/domain/TLD are widened
  // to any non-whitespace, non-@ characters so internationalized addresses are
  // also captured.
  {
    regex: /[^\s@]+@[^\s@]+\.[^\s@]{2,}/g,
    replacement: "[REDACTED_EMAIL]",
    type: "email",
  },
  // Credit card (also covers numbers spanning newlines and whitespace).
  // A "\d sep \d sep ..." structure would make the trailing separator demand a
  // following digit, breaking the match for newline-spanning cases like
  // 4111-1111-\n1111-1111 (found in review). Using a leading \d followed by
  // (sep* \d){12,18} allows multiple consecutive separators, so newlines and
  // repeated spaces are swallowed too.
  {
    // '.' added to the separator set (found in review): the old pattern only
    // allowed space/tab/newline/hyphen, so dot-separated numbers
    // (4111.1111.1111.1111) did not match as CC, got partially consumed by the
    // later phone pattern, and left the last 4 digits in plaintext. Since CC
    // runs before phone, including dots as CC separators redacts all digits
    // (false-positive-tolerant policy).
    regex: /\b\d(?:[ \t\r\n.-]*\d){12,18}\b/g,
    replacement: "[REDACTED_CC]",
    type: "creditCard",
  },
  // Japanese My Number = 12 digits, delimited by word boundaries
  // (the CC pattern above runs first, so 12-13 digit overlaps are handled as CC)
  {
    regex: /\b\d{12}\b/g,
    replacement: "[REDACTED_MYNUMBER]",
    type: "myNumber",
  },
  // Phone numbers = representative patterns for major countries:
  //   - Japan mobile: 090-XXXX-XXXX / 080-XXXX-XXXX / 070-XXXX-XXXX
  //   - Japan landline: 03-XXXX-XXXX / 06-XXXX-XXXX etc.
  //   - International: +81 90 XXXX XXXX / +1 (123) 456-7890
  //   - Fullwidth hyphens and middle dots are out of scope (ASCII assumed)
  {
    regex: /\+?\d{1,3}[-.\s]?\(?\d{2,4}\)?[-.\s]?\d{2,4}[-.\s]?\d{3,4}/g,
    replacement: "[REDACTED_PHONE]",
    type: "phone",
  },
  // IPv4 = 4 octets; the 0-255 range is not strictly checked — kept conservative
  {
    regex: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
    replacement: "[REDACTED_IPV4]",
    type: "ipv4",
  },
  // IPv6 (full + shortened forms). To also catch shortened notations like
  // `::1` (found in review), each hex group allows 0-4 digits (an empty group
  // matches "::"), with lookbehind / lookahead providing the word boundaries.
  // `(?:[0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{1,4}` bundles `::1` / `fe80::1234`
  // and the ordinary 8-group form (false-positive tolerant, false negatives
  // strictly avoided).
  {
    regex: /(?<![\w:.])(?:[0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{1,4}(?![\w:.])/g,
    replacement: "[REDACTED_IPV6]",
    type: "ipv6",
  },
];

/**
 * Redaction type tag: the category recorded in redaction_metadata. Stored in
 * the backend's redaction_metadata JSON in the shape { [type]: count }.
 */
export type RedactionType =
  | "email"
  | "creditCard"
  | "myNumber"
  | "phone"
  | "ipv4"
  | "ipv6";

export type RedactionCounts = Partial<Record<RedactionType, number>>;

/**
 * Apply PII redaction patterns to a plaintext string.
 *
 * @param input The raw text to redact. If empty / null / undefined, returns "" or the input.
 * @returns The text with PII patterns replaced by [REDACTED_*] markers.
 */
/**
 * Normalize fullwidth digits (U+FF10..FF19) to ASCII. Fullwidth credit card
 * numbers, My Number, phone numbers, and IPs typed via a Japanese IME slipped
 * straight past the \d (ASCII [0-9]) based PII patterns — a false negative.
 * Normalizing before matching reliably captures fullwidth PII too (the side
 * effect that non-PII fullwidth digits become halfwidth is accepted under the
 * false-positive-tolerant policy).
 */
function normalizeFullwidthDigits(s: string): string {
  return s.replace(/[０-９]/g, (c) =>
    String.fromCharCode(c.charCodeAt(0) - 0xfee0),
  );
}

export function redactPii(input: string | null | undefined): string {
  if (input == null) return "";
  if (typeof input !== "string") {
    // Caller guarantee broken; coerce defensively rather than throw.
    input = String(input);
  }
  if (input.length === 0) return input;
  let result = normalizeFullwidthDigits(input);
  for (const { regex, replacement } of PATTERNS) {
    result = result.replace(regex, replacement);
  }
  return result;
}

/**
 * Perform the same redaction while simultaneously counting how many
 * replacements occurred per type. Feeds the backend redaction_metadata JSON
 * and the SDK-side "did this contain PII" decision (the piiRedacted boolean).
 *
 * Counts are taken via match, then the replacement is applied. The regexes use
 * the g flag, so running them twice has no side effects.
 */
export function redactPiiWithCounts(
  input: string | null | undefined,
): { text: string; counts: RedactionCounts } {
  if (input == null) return { text: "", counts: {} };
  if (typeof input !== "string") input = String(input);
  if (input.length === 0) return { text: input, counts: {} };
  const counts: RedactionCounts = {};
  let result = normalizeFullwidthDigits(input);
  for (const { regex, replacement, type } of PATTERNS) {
    const matches = result.match(regex);
    const n = matches ? matches.length : 0;
    if (n > 0) counts[type] = (counts[type] ?? 0) + n;
    result = result.replace(regex, replacement);
  }
  return { text: result, counts };
}

/**
 * Helper that sums the counts from multiple redaction results (prompt /
 * completion / each tool call).
 */
export function mergeRedactionCounts(
  base: RedactionCounts,
  addition: RedactionCounts,
): RedactionCounts {
  const out: RedactionCounts = { ...base };
  for (const k of Object.keys(addition) as RedactionType[]) {
    out[k] = (out[k] ?? 0) + (addition[k] ?? 0);
  }
  return out;
}

/**
 * Whether the counts object contains at least one redaction.
 * The basis for the piiRedacted boolean field.
 */
export function hasAnyRedaction(counts: RedactionCounts): boolean {
  for (const v of Object.values(counts)) {
    if ((v ?? 0) > 0) return true;
  }
  return false;
}

/**
 * Apply PII redaction recursively to a tool call's arguments and result fields.
 * Used by Recorder to scrub structured tool call data before send.
 */
export function redactToolCall(call: {
  name: string;
  arguments?: string;
  result?: string;
}): { name: string; arguments?: string; result?: string } {
  const out: { name: string; arguments?: string; result?: string } = {
    name: call.name,
  };
  if (call.arguments !== undefined) {
    out.arguments = redactPii(call.arguments);
  }
  if (call.result !== undefined) {
    out.result = redactPii(call.result);
  }
  return out;
}
