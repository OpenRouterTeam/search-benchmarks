/**
 * Public API enum and limit values used by the standalone harness.
 */

import type { ValueOf } from './guards';

export enum ProviderSort {
  Price = 'price',
  Throughput = 'throughput',
  Latency = 'latency',
  Exacto = 'exacto',
}

export const WebFetchEngine = {
  OpenRouter: 'openrouter',
  Firecrawl: 'firecrawl',
  Exa: 'exa',
  Parallel: 'parallel',
} as const;

export type WebFetchEngine = ValueOf<typeof WebFetchEngine>;

export enum WebSearchEngine {
  Native = 'native',
  Exa = 'exa',
  Firecrawl = 'firecrawl',
  Parallel = 'parallel',
  Perplexity = 'perplexity',
}

export const MAX_SERVER_TOOL_CALLS = 30;

/**
 * Server defaults applied when the corresponding web-search parameter is
 * omitted. Mirrored here so a caller can reason about the effective search
 * budget locally; the server remains the source of truth.
 */
export const WEB_SEARCH_DEFAULT_MAX_RESULTS = 5;
export const WEB_SEARCH_DEFAULT_MAX_TOTAL_RESULTS = 50;
export const WEB_SEARCH_MAX_RESULTS_MAX = 25;
export const WEB_SEARCH_MAX_CHARACTERS_MAX = 100_000;
