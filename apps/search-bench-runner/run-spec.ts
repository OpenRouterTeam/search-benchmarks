import type { SearchBenchmarkConfig } from '@openrouter/bench-harness/benchmarks/benchmark-config';

import { createHash } from 'node:crypto';

import { parse as parseToml } from 'smol-toml';
import { z } from 'zod';

import {
  BenchmarkRunConfigSchema,
  isSearchBenchmarkConfig,
} from '@openrouter/bench-harness/benchmarks/benchmark-config';
import { getSearchBenchmarkProvenance } from '@openrouter/bench-harness/benchmarks/search/provenance';

const WEB_SEARCH_DEFAULT_MAX_RESULTS = 5;
const WEB_SEARCH_DEFAULT_MAX_TOTAL_RESULTS = 50;
const DSQA_GRADER_PROMPT_SOURCE =
  'https://www.kaggle.com/code/andrewmingwang/deepsearchqa-starter-code?scriptVersionId=285323691';

export const RUN_SPEC_VERSION = 1 as const;

export const SUITE_NAMES = ['browsecomp', 'dsqa', 'widesearch'] as const;
export type SuiteName = (typeof SUITE_NAMES)[number];

const WebFetchSpecSchema = z.object({
  engine: z.enum(['auto', 'native', 'openrouter', 'firecrawl', 'exa', 'parallel']).optional(),
  max_uses: z.number().int().positive().optional(),
  max_content_tokens: z.number().int().positive().optional(),
}).strict();

const RunSpecSchema = z.object({
  version: z.literal(RUN_SPEC_VERSION).default(RUN_SPEC_VERSION),
  title: z.string().min(1),
  description: z.string().default(''),
  model: z.string().min(1),
  suites: z.array(z.enum(SUITE_NAMES)).min(1),
  start: z.number().int().min(0).default(0),
  limit: z.number().int().positive().optional(),
  epochs: z.number().int().positive().default(1),
  concurrency: z.number().int().positive().default(5),
  chunk_size: z.number().int().positive().default(10),
  budget_usd: z.number().positive().optional(),
  inference: z
    .object({
      temperature: z.number().default(0),
      reasoning_effort: z.enum(['xhigh', 'high', 'medium', 'low', 'minimal', 'none']).optional(),
      cost_tier: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
      timeout_ms: z.number().int().positive().optional(),
      max_tokens: z.number().int().positive().optional(),
      max_retries: z.number().int().min(0).optional(),
      sort: z.enum(['price', 'throughput', 'latency', 'exacto']).optional(),
      provider_order: z.array(z.string().min(1)).optional(),
      provider_only: z.array(z.string().min(1)).optional(),
      allow_fallbacks: z.boolean().optional(),
    }).strict()
    .default({ temperature: 0 }),
  search: z.object({
    surface: z.enum(['server-tool', 'plugin']).default('server-tool'),
    engine: z.enum(['auto', 'native', 'exa', 'firecrawl', 'parallel', 'perplexity']),
    max_agent_turns: z.number().int().min(1).max(30).optional(),
    max_results: z.number().int().min(1).max(25).optional(),
    max_total_results: z.number().int().positive().optional(),
    search_context_size: z.enum(['low', 'medium', 'high']).optional(),
    max_characters: z.number().int().min(1).max(100_000).optional(),
    allowed_domains: z.array(z.string()).optional(),
    excluded_domains: z.array(z.string()).optional(),
    search_prompt: z.string().optional(),
    web_fetch: WebFetchSpecSchema.optional(),
  }).strict(),
  cost_estimates: z
    .object({
      browsecomp: z.number().positive(),
      dsqa: z.number().positive(),
      widesearch: z.number().positive(),
    })
    .strict()
    .optional(),
  publish: z
    .object({
      include_inputs: z.boolean().default(false),
      include_answers: z.boolean().default(false),
      include_search_queries: z.boolean().default(false),
    }).strict()
    .default({ include_inputs: false, include_answers: false, include_search_queries: false }),
}).strict();

export type RunSpec = z.infer<typeof RunSpecSchema>;

export interface DatasetContract {
  readonly benchmarkId: SearchBenchmarkConfig['benchmarkId'];
  readonly source: string;
  readonly revision?: string;
  readonly sha256: string;
  readonly rows: number;
  readonly promptSha256: string;
  readonly judgeModel: string;
  readonly judgePromptSource?: string;
  readonly judgePromptSha256?: string;
  readonly gradingReferenceDate?: string;
}

function provenance(benchmarkId: DatasetContract['benchmarkId']) {
  const value = getSearchBenchmarkProvenance(benchmarkId);
  if (value === undefined) {
    throw new Error(`Missing search benchmark provenance for ${benchmarkId}`);
  }
  return value;
}

function contract(
  benchmarkId: DatasetContract['benchmarkId'],
  options: { readonly judgePromptSource?: string; readonly revisionPrefix?: string } = {},
): DatasetContract {
  const value = provenance(benchmarkId);
  const revision =
    value.dataset.revision === null
      ? undefined
      : `${options.revisionPrefix ?? ''}${value.dataset.revision}`;
  const judge = value.judges[0];
  if (judge === undefined) {
    throw new Error(`Missing judge provenance for ${benchmarkId}`);
  }
  return {
    benchmarkId,
    source: value.dataset.source,
    ...(revision !== undefined && { revision }),
    sha256: value.dataset.sha256,
    rows: value.dataset.rowCount,
    promptSha256: value.generationPrompt.sha256,
    judgeModel: judge.model,
    ...(options.judgePromptSource !== undefined && {
      judgePromptSource: options.judgePromptSource,
      judgePromptSha256: judge.prompt.sha256,
    }),
    ...(value.gradingReferenceDate !== null && {
      gradingReferenceDate: value.gradingReferenceDate,
    }),
  };
}

export const DATASET_CONTRACTS: Readonly<Record<SuiteName, DatasetContract>> = {
  browsecomp: contract('search_browsecomp'),
  dsqa: contract('search_dsqa', { judgePromptSource: DSQA_GRADER_PROMPT_SOURCE }),
  widesearch: contract('search_widesearch', { revisionPrefix: 'ByteDance-Seed/WideSearch@' }),
};

export function parseRunSpec(text: string): RunSpec {
  let raw: unknown;
  try {
    raw = parseToml(text);
  } catch (error) {
    throw new Error(`Run spec is not valid TOML: ${String(error)}`);
  }
  const parsed = RunSpecSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.length ? `${issue.path.join('.')}: ` : '';
    throw new Error(`Invalid run spec: ${path}${issue?.message ?? parsed.error.message}`);
  }
  if (new Set(parsed.data.suites).size !== parsed.data.suites.length) {
    throw new Error('Invalid run spec: suites must not contain duplicates');
  }
  for (const suite of parsed.data.suites) {
    if (selectedTaskCount(parsed.data, suite) === 0) {
      throw new Error(`Invalid run spec: start is outside the ${suite} dataset`);
    }
  }
  if (parsed.data.search.surface === 'plugin') {
    const serverOnly = [
      parsed.data.search.max_agent_turns,
      parsed.data.search.max_total_results,
      parsed.data.search.search_context_size,
      parsed.data.search.max_characters,
      parsed.data.search.web_fetch,
    ];
    if (serverOnly.some((value) => value !== undefined)) {
      throw new Error('Invalid run spec: plugin surface includes server-tool-only search options');
    }
  }
  return parsed.data;
}

/**
 * Cumulative result budget for a lane. The server caps total results per request
 * (default {@link WEB_SEARCH_DEFAULT_MAX_TOTAL_RESULTS}), which silently
 * truncates a deep search budget: at 25 turns the cap binds around turn ten and
 * later searches return nothing. When the requested depth would exceed that
 * default, derive the budget from the depth so search depth stays the only
 * binding limit. An explicit `max_total_results` always wins.
 */
export function resolveMaxTotalResults(spec: RunSpec): number | undefined {
  if (spec.search.max_total_results !== undefined) {
    return spec.search.max_total_results;
  }
  if (spec.search.max_agent_turns === undefined) {
    return undefined;
  }
  const perSearch = spec.search.max_results ?? WEB_SEARCH_DEFAULT_MAX_RESULTS;
  const requested = spec.search.max_agent_turns * perSearch;
  return requested > WEB_SEARCH_DEFAULT_MAX_TOTAL_RESULTS ? requested : undefined;
}

export function benchmarkConfigForSuite(
  spec: RunSpec,
  suite: SuiteName,
): SearchBenchmarkConfig {
  const raw = {
    benchmarkId: DATASET_CONTRACTS[suite].benchmarkId,
    model: spec.model,
    temperature: spec.inference.temperature,
    ...(spec.inference.reasoning_effort !== undefined && {
      reasoningEffort: spec.inference.reasoning_effort,
    }),
    ...(spec.inference.cost_tier !== undefined && { costTier: spec.inference.cost_tier }),
    ...(spec.inference.timeout_ms !== undefined && { timeoutMs: spec.inference.timeout_ms }),
    ...(spec.inference.max_tokens !== undefined && { maxTokens: spec.inference.max_tokens }),
    ...(spec.inference.max_retries !== undefined && { maxRetries: spec.inference.max_retries }),
    ...(spec.inference.sort !== undefined && { sort: spec.inference.sort }),
    ...(spec.inference.provider_order !== undefined && {
      providerOrder: spec.inference.provider_order,
    }),
    ...(spec.inference.provider_only !== undefined && {
      providerOnly: spec.inference.provider_only,
    }),
    ...(spec.inference.allow_fallbacks !== undefined && {
      allowFallbacks: spec.inference.allow_fallbacks,
    }),
    lane: {
      webSearch: spec.search.surface,
      engine: spec.search.engine,
      ...(spec.search.max_agent_turns !== undefined && {
        maxAgentTurns: spec.search.max_agent_turns,
      }),
      ...(spec.search.max_results !== undefined && { maxResults: spec.search.max_results }),
      ...(resolveMaxTotalResults(spec) !== undefined && {
        maxTotalResults: resolveMaxTotalResults(spec),
      }),
      ...(spec.search.search_context_size !== undefined && {
        searchContextSize: spec.search.search_context_size,
      }),
      ...(spec.search.max_characters !== undefined && {
        maxCharacters: spec.search.max_characters,
      }),
      ...(spec.search.allowed_domains !== undefined && {
        allowedDomains: spec.search.allowed_domains,
      }),
      ...(spec.search.excluded_domains !== undefined && {
        excludedDomains: spec.search.excluded_domains,
      }),
      ...(spec.search.search_prompt !== undefined && { searchPrompt: spec.search.search_prompt }),
      ...(spec.search.web_fetch !== undefined && {
        webFetch: {
          ...(spec.search.web_fetch.engine !== undefined && {
            fetchEngine: spec.search.web_fetch.engine,
          }),
          ...(spec.search.web_fetch.max_uses !== undefined && {
            maxFetchUses: spec.search.web_fetch.max_uses,
          }),
          ...(spec.search.web_fetch.max_content_tokens !== undefined && {
            maxFetchContentTokens: spec.search.web_fetch.max_content_tokens,
          }),
        },
      }),
    },
  };
  const parsed = BenchmarkRunConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.length ? `${issue.path.join('.')}: ` : '';
    throw new Error(
      `Invalid resolved ${suite} config: ${path}${issue?.message ?? parsed.error.message}`,
    );
  }
  if (!isSearchBenchmarkConfig(parsed.data)) {
    throw new Error(`Resolved ${suite} config is not a search benchmark`);
  }
  return parsed.data;
}

export function selectedTaskCount(spec: RunSpec, suite: SuiteName): number {
  const available = Math.max(0, DATASET_CONTRACTS[suite].rows - spec.start);
  return Math.min(spec.limit ?? available, available);
}

export function estimatedRunCost(spec: RunSpec): number | undefined {
  const costEstimates = spec.cost_estimates;
  if (costEstimates === undefined) {
    return undefined;
  }
  return spec.suites.reduce(
    (total, suite) =>
      total + selectedTaskCount(spec, suite) * spec.epochs * costEstimates[suite],
    0,
  );
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}
