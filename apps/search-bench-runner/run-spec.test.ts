import { describe, expect, it } from 'bun:test';

import {
  DATASET_CONTRACTS,
  benchmarkConfigForSuite,
  estimatedRunCost,
  parseRunSpec,
  resolveMaxTotalResults,
  selectedTaskCount,
} from './run-spec';

const SPEC = `
version = 1
title = "Test run"
model = "openai/gpt-5.4-nano"
suites = ["browsecomp", "widesearch"]
start = 2
limit = 3
epochs = 2
concurrency = 4
chunk_size = 1
budget_usd = 10

[inference]
temperature = 0
reasoning_effort = "high"

[search]
surface = "server-tool"
engine = "exa"
max_agent_turns = 3
max_results = 10

[cost_estimates]
browsecomp = 0.05
dsqa = 0.07
widesearch = 0.16
`;

describe('run spec', () => {
  it('resolves a TOML lane into the benchmark config', () => {
    const spec = parseRunSpec(SPEC);
    expect(benchmarkConfigForSuite(spec, 'browsecomp')).toEqual({
      benchmarkId: 'search_browsecomp',
      model: 'openai/gpt-5.4-nano',
      temperature: 0,
      reasoningEffort: 'high',
      lane: {
        webSearch: 'server-tool',
        engine: 'exa',
        maxAgentTurns: 3,
        maxResults: 10,
      },
    });
    expect(selectedTaskCount(spec, 'browsecomp')).toBe(3);
    expect(estimatedRunCost(spec)).toBeCloseTo(1.26, 8);
  });

  it('rejects duplicate suites and unknown keys', () => {
    expect(() => parseRunSpec(SPEC.replace('["browsecomp", "widesearch"]', '["browsecomp", "browsecomp"]'))).toThrow(
      'must not contain duplicates',
    );
    expect(() => parseRunSpec(`${SPEC}\nunknown = true\n`)).toThrow('Invalid run spec');
  });

  it('supports calibration-required plans and public provider selection', () => {
    const withoutCosts = SPEC.replace('budget_usd = 10\n', '').replace(
      /\[cost_estimates\]\nbrowsecomp = 0\.05\ndsqa = 0\.07\nwidesearch = 0\.16\n/u,
      '',
    ).replace('reasoning_effort = "high"', 'reasoning_effort = "high"\nprovider_only = ["OpenAI"]\nallow_fallbacks = false');
    const spec = parseRunSpec(withoutCosts);
    expect(estimatedRunCost(spec)).toBeUndefined();
    expect(benchmarkConfigForSuite(spec, 'widesearch')).toMatchObject({
      providerOnly: ['OpenAI'],
      allowFallbacks: false,
    });
  });

  it('records the official DSQA judge provenance', () => {
    expect(DATASET_CONTRACTS.dsqa).toMatchObject({
      judgeModel: 'google/gemini-2.5-flash',
      judgePromptSource:
        'https://www.kaggle.com/code/andrewmingwang/deepsearchqa-starter-code?scriptVersionId=285323691',
      judgePromptSha256:
        '9bdd0b9198244de8a78bf256b5332805d00c140e85b713f0e1878b3e4aa605a0',
    });
  });
});

describe('cumulative result budget', () => {
  const withSearch = (block: string): string =>
    SPEC.replace(
      /\[search\][\s\S]*?\n\n/u,
      `[search]\nsurface = "server-tool"\nengine = "exa"\n${block}\n\n`,
    );

  it('leaves the server default in place when depth cannot exceed it', () => {
    const spec = parseRunSpec(withSearch('max_agent_turns = 5'));
    expect(resolveMaxTotalResults(spec)).toBeUndefined();
    expect(benchmarkConfigForSuite(spec, 'browsecomp').lane.maxTotalResults).toBeUndefined();
  });

  it('derives the budget from depth once the default would truncate it', () => {
    const spec = parseRunSpec(withSearch('max_agent_turns = 25'));
    expect(resolveMaxTotalResults(spec)).toBe(125);
    expect(benchmarkConfigForSuite(spec, 'browsecomp').lane.maxTotalResults).toBe(125);
  });

  it('scales the derived budget with an explicit per-search result cap', () => {
    const spec = parseRunSpec(withSearch('max_agent_turns = 25\nmax_results = 10'));
    expect(resolveMaxTotalResults(spec)).toBe(250);
  });

  it('always prefers an explicit cumulative cap', () => {
    const spec = parseRunSpec(withSearch('max_agent_turns = 25\nmax_total_results = 60'));
    expect(resolveMaxTotalResults(spec)).toBe(60);
  });
});
