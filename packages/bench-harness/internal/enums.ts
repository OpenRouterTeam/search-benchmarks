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
 * Effective limits observed from the public web-search API when the
 * corresponding parameter is omitted, recorded so a caller can reason about its
 * search budget before sending a request. These are observations, not a
 * contract: the API is the source of truth and may change.
 */
export const WEB_SEARCH_DEFAULT_MAX_RESULTS = 5;
export const WEB_SEARCH_DEFAULT_MAX_TOTAL_RESULTS = 50;
export const WEB_SEARCH_MAX_RESULTS_MAX = 25;
export const WEB_SEARCH_MAX_CHARACTERS_MAX = 100_000;
