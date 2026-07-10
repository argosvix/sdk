/**
 * SDK-side resolution of deployed prompts.
 *
 * Calls the backend GET /v1/prompts/resolve?name=&label= (available on the
 * Free plan) and returns the current version for (name, label). Combined with
 * withPrompt(), LLM calls made with that prompt automatically get a `prompt`
 * tag ({name}@v{version}), enabling per-version quality/cost comparison.
 *
 *   const p = await resolvePrompt("support-bot", { apiKey: process.env.ARGOSVIX_API_KEY! });
 *   await withPrompt(p, async () => {
 *     await client.chat.completions.create({ ... p.template ... });
 *   });
 *
 * Design:
 *   - TTL cache (default 60 seconds) avoids a resolve fetch on every call
 *     (production hot path).
 *   - On fetch failure, a stale fallback returns the cached value even if it
 *     has expired (a transient prompt-fetch outage must not stop the app's
 *     main flow). If there is no cache either, it throws.
 */

const DEFAULT_ENDPOINT = "https://ingest.argosvix.com";
const DEFAULT_LABEL = "production";
const DEFAULT_TTL_MS = 60_000;

export interface ResolvePromptOptions {
  /** Argosvix API key (argk_...). */
  apiKey: string;
  /** Deployment environment label. Defaults to "production". */
  label?: string;
  /** Backend endpoint. Defaults to https://ingest.argosvix.com. */
  endpoint?: string;
  /** Cache TTL in ms. 0 disables caching. Defaults to 60000. */
  cacheTtlMs?: number;
  signal?: AbortSignal;
}

export interface ResolvedPrompt {
  /** Version ID in the prompt registry. */
  id: string;
  name: string;
  version: number;
  /** Prompt body (template). */
  template: string;
  /** List of {{var}} variable names (if specified at registration). */
  variables: string[] | null;
  label: string;
  /** Tag value used by withPrompt / tags.prompt ({name}@v{version}). */
  tag: string;
}

interface CacheEntry {
  value: ResolvedPrompt;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

/** Test-only: clears the cache. */
export function _clearPromptCache(): void {
  cache.clear();
}

export async function resolvePrompt(
  name: string,
  options: ResolvePromptOptions,
): Promise<ResolvedPrompt> {
  const endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
  const label = options.label ?? DEFAULT_LABEL;
  const ttl = options.cacheTtlMs ?? DEFAULT_TTL_MS;
  // Include the apiKey in the cache key: in setups where a single process uses
  // keys for multiple accounts, this prevents cross-account contamination where
  // one account picks up another account's cached prompt (same reasoning as the
  // observation sink's cross-account guard). In-memory only; never persisted.
  const key = `${options.apiKey}|${endpoint}|${name}|${label}`;

  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.value;

  let res: Response;
  // Default 10-second timeout (mirroring the Python SDK). A hanging resolve
  // would block the app's main flow (fetch the prompt, then call the LLM), so
  // always enforce an upper bound. A caller-provided signal takes precedence.
  const ctrl = options.signal ? null : new AbortController();
  const timer = ctrl ? setTimeout(() => ctrl.abort(), 10_000) : null;
  try {
    const url =
      `${endpoint}/v1/prompts/resolve?name=${encodeURIComponent(name)}` +
      `&label=${encodeURIComponent(label)}`;
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${options.apiKey}` },
      signal: options.signal ?? ctrl!.signal,
    });
  } catch (err) {
    if (hit) return hit.value; // network failure / timeout = stale fallback
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (!res.ok) {
    if (hit && res.status >= 500) return hit.value; // stale allowed only for server failures
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(
      `resolvePrompt(${name}, ${label}) failed (${res.status}): ${body.error ?? ""}`,
    );
  }
  const body = (await res.json().catch(() => null)) as {
    prompt?: {
      id?: unknown;
      name?: unknown;
      version?: unknown;
      template?: unknown;
      variables?: unknown;
    };
    label?: unknown;
  } | null;
  const p = body?.prompt;
  if (
    !p ||
    typeof p.id !== "string" ||
    typeof p.name !== "string" ||
    typeof p.version !== "number" ||
    typeof p.template !== "string"
  ) {
    throw new Error("resolvePrompt: unexpected response shape");
  }
  const value: ResolvedPrompt = {
    id: p.id,
    name: p.name,
    version: p.version,
    template: p.template,
    variables: Array.isArray(p.variables) ? (p.variables as string[]) : null,
    label,
    tag: `${p.name}@v${p.version}`,
  };
  if (ttl > 0) cache.set(key, { value, expiresAt: Date.now() + ttl });
  return value;
}
