/**
 * Argosvix Query API client (helper for fetching call history and aggregates).
 *
 * Exposed endpoints:
 *   - POST /v1/query/calls     call history (filter + up to 200 records)
 *   - POST /v1/query/aggregate aggregation by provider / model / day
 *
 * Auth: Bearer API key (the key shown exactly once at dashboard /verify).
 *
 * Usage:
 *   import { queryCalls, queryAggregate } from "@argosvix/sdk";
 *
 *   const { records } = await queryCalls({
 *     apiKey: process.env.ARGOSVIX_API_KEY!,
 *     filter: { provider: "openai", limit: 100 },
 *   });
 *
 *   const { groups, total } = await queryAggregate({
 *     apiKey: process.env.ARGOSVIX_API_KEY!,
 *     filter: { groupBy: "day", metric: "cost" },
 *   });
 *
 * fetch is natively available on Node 18+ / Workers / browsers. To target a
 * different endpoint (self-hosted / staging), pass `endpoint`.
 */

import type { Provider } from "./types.js";

const DEFAULT_ENDPOINT = "https://ingest.argosvix.com";

export interface QueryCallsFilter {
  /** ISO 8601 UTC timestamp (inclusive) */
  startTime?: string;
  /** ISO 8601 UTC timestamp (inclusive) */
  endTime?: string;
  provider?: Provider;
  /** Exact model name match (1-128 chars) */
  model?: string;
  /** 1-200 (default 50) */
  limit?: number;
}

export interface CallRecord {
  id: string;
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number;
  /** ms */
  latencyMs: number;
  /** ISO 8601 UTC */
  timestamp: string;
  tags: Record<string, string>;
  error: string | null;
  errorDetails: Record<string, unknown> | null;
  requestMeta: Record<string, unknown> | null;
}

export interface QueryCallsOptions {
  apiKey: string;
  /** default = https://ingest.argosvix.com */
  endpoint?: string;
  filter?: QueryCallsFilter;
  /** Optional AbortController signal */
  signal?: AbortSignal;
}

export interface QueryCallsResponse {
  records: CallRecord[];
}

export type AggregateGroupBy = "provider" | "model" | "day";
export type AggregateMetric = "cost" | "latency" | "tokens" | "count";

export interface QueryAggregateFilter {
  startTime?: string;
  endTime?: string;
  provider?: Provider;
  /** default = "provider" */
  groupBy?: AggregateGroupBy;
  /** default = "cost" */
  metric?: AggregateMetric;
}

export interface AggregateGroup {
  /** Provider name / model name / date (YYYY-MM-DD) */
  key: string;
  value: number;
  count: number;
}

export interface QueryAggregateOptions {
  apiKey: string;
  endpoint?: string;
  filter?: QueryAggregateFilter;
  signal?: AbortSignal;
}

export interface QueryAggregateResponse {
  groups: AggregateGroup[];
  total: { value: number; count: number };
}

/**
 * Small helper that throws the { error: string } JSON returned by the Argosvix
 * backend as an Error. Every non-200 status is treated as an Error.
 */
export class ArgosvixQueryError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ArgosvixQueryError";
    this.status = status;
  }
}

async function postJson<T>(
  url: string,
  apiKey: string,
  body: unknown,
  signal: AbortSignal | undefined,
): Promise<T> {
  const fetchInit: RequestInit = {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  };
  if (signal) fetchInit.signal = signal;
  const res = await fetch(url, fetchInit);
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const payload = (await res.json()) as { error?: string };
      if (payload.error) detail = `${detail}: ${payload.error}`;
    } catch {
      /* keep generic */
    }
    throw new ArgosvixQueryError(res.status, detail);
  }
  return (await res.json()) as T;
}

/**
 * Fetch call history.
 */
export async function queryCalls(
  options: QueryCallsOptions,
): Promise<QueryCallsResponse> {
  const endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
  return postJson<QueryCallsResponse>(
    `${endpoint}/v1/query/calls`,
    options.apiKey,
    options.filter ?? {},
    options.signal,
  );
}

/**
 * Fetch call aggregates.
 */
export async function queryAggregate(
  options: QueryAggregateOptions,
): Promise<QueryAggregateResponse> {
  const endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
  return postJson<QueryAggregateResponse>(
    `${endpoint}/v1/query/aggregate`,
    options.apiKey,
    options.filter ?? {},
    options.signal,
  );
}

export type PercentileMetric = "latency" | "cost";

export interface QueryPercentilesFilter {
  startTime?: string;
  endTime?: string;
  provider?: Provider;
  model?: string;
  /** default = "latency" */
  metric?: PercentileMetric;
}

export interface QueryPercentilesOptions {
  apiKey: string;
  endpoint?: string;
  filter?: QueryPercentilesFilter;
  signal?: AbortSignal;
}

export interface QueryPercentilesResponse {
  metric: PercentileMetric;
  /** 50th percentile (null when there are no records) */
  p50: number | null;
  p95: number | null;
  p99: number | null;
  count: number;
}

/**
 * Fetch percentiles (p50/p95/p99) for latency_ms / cost_usd.
 * A debugging aid for understanding outlier distributions that averages hide.
 */
export async function queryPercentiles(
  options: QueryPercentilesOptions,
): Promise<QueryPercentilesResponse> {
  const endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
  return postJson<QueryPercentilesResponse>(
    `${endpoint}/v1/query/percentiles`,
    options.apiKey,
    options.filter ?? { metric: "latency" },
    options.signal,
  );
}
