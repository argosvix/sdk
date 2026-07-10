/**
 * ID generation utility. Extracted into a shared module because both client.ts
 * and context.ts use it (avoids a circular import). Record IDs, trace IDs, and
 * span IDs are all issued by this single implementation.
 */
export function generateId(): string {
  const timePrefix = Date.now().toString(36);
  // globalThis.crypto is available in Workers / Node 18+ / modern browsers. The SDK tsconfig does
  // not include the DOM lib, so access it structurally instead of relying on the Crypto type.
  const c = (
    globalThis as {
      crypto?: {
        randomUUID?: () => string;
        getRandomValues?: (a: Uint8Array) => Uint8Array;
      };
    }
  ).crypto;
  if (c?.randomUUID) {
    return `${timePrefix}-${c.randomUUID()}`;
  }
  if (c?.getRandomValues) {
    const bytes = new Uint8Array(16);
    c.getRandomValues(bytes);
    let hex = "";
    for (const b of bytes) hex += b.toString(16).padStart(2, "0");
    return `${timePrefix}-${hex}`;
  }
  // Final fallback for runtimes without crypto (concatenating two random strings gives more entropy than the previous behavior, lowering collision probability).
  return `${timePrefix}-${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
}
