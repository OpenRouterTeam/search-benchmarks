import type { RunManifest } from './bench';

import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';

import { ScoreValue } from './core';
import { runResultToParquet } from './parquet';
import { publishedRunDirectory, publishRunBundle } from './publish-run';
import { benchmarkConfigForSuite, DATASET_CONTRACTS, parseRunSpec, sha256 } from './run-spec';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');
let temporary: string | undefined;

afterEach(() => {
  if (temporary !== undefined) {
    rmSync(temporary, { recursive: true, force: true });
    temporary = undefined;
  }
});

const SPEC = `
version = 1
title = "Published test"
description = "Safe export"
model = "openai/gpt-5.4-nano"
suites = ["browsecomp"]
limit = 1
budget_usd = 1

[search]
engine = "exa"
max_agent_turns = 3

[cost_estimates]
browsecomp = 0.05
dsqa = 0.07
widesearch = 0.16

[publish]
include_inputs = false
include_answers = false
include_search_queries = false
`;

const SPEC_WITH_INPUTS = SPEC.replace('include_inputs = false', 'include_inputs = true');

describe('published run bundle', () => {
  it('groups published runs by search engine', () => {
    expect(publishedRunDirectory('/repo', 'published-test', parseRunSpec(SPEC))).toBe(
      '/repo/published-runs/exa/published-test',
    );
  });

  it('keeps useful search traces while excluding targets and judge details', async () => {
    temporary = mkdtempSync(join(tmpdir(), 'bench-publish-'));
    const runDir = join(temporary, 'run');
    const publishDir = join(temporary, 'published');
    const rawDir = join(runDir, 'raw', 'browsecomp');
    mkdirSync(rawDir, { recursive: true });
    const artifact = join(rawDir, '000000-000001.parquet');
    const spec = parseRunSpec(SPEC);
    const config = benchmarkConfigForSuite(spec, 'browsecomp');
    const buffer = runResultToParquet({
      result: {
        metrics: { accuracy: 1, totalQuestions: 1, correctAnswers: 1, skippedQuestions: 0 },
        usage: {
          inputTokens: 10,
          outputTokens: 2,
          totalTokens: 12,
          reasoningTokens: 1,
          totalCost: 0.01,
          generationTimeMs: 100,
        },
        sampleScores: [
          {
            sampleId: 'browsecomp-0',
            epoch: 0,
            input: 'secret question',
            target: 'secret target',
            score: {
              value: ScoreValue.Correct,
              answer: 'model answer',
              explanation: 'quotes secret target',
              trajectory: { kind: 'judge_runs', runs: [{ secret: 'judge output' }] },
            },
            responseItems: [
              { role: 'user', content: 'secret question' },
              {
                type: 'openrouter:web_search',
                id: 'search-1',
                status: 'completed',
                action: {
                  type: 'search',
                  query: 'safe query',
                  sources: [{ type: 'url', url: 'https://example.com/source' }],
                },
              },
            ],
            generationIds: ['gen-1'],
            requestBody: {
              model: 'openai/gpt-5.6-sol',
              instructions: 'secret question appears in the system prompt too',
              input: [{ role: 'user', content: 'secret question' }],
              maxToolCalls: 5,
              tools: [{ type: 'openrouter:web_search', parameters: { maxUses: 5 } }],
            },
            metadata: {
              search: {
                citations: [
                  {
                    url: 'https://example.com/secret-question?q=secret#answer',
                    title: 'Secret question and answer',
                  },
                ],
              },
              verdict: { secret: 'metadata judge output' },
            },
          },
        ],
      },
      meta: {
        task: 'search_browsecomp',
        model: config.model,
        epochs: 1,
        temperature: 0,
        benchmarkConfig: config,
        createdAt: '2026-07-30T00:00:00.000Z',
      },
      extraScores: [
        { name: 'browsecomp', metrics: { mean_stated_confidence: { value: 90 } } },
      ],
    });
    writeFileSync(artifact, buffer);
    writeFileSync(join(runDir, 'run.toml'), SPEC);
    const manifest: RunManifest = {
      version: 1,
      runId: 'published-test',
      title: spec.title,
      description: spec.description,
      createdAt: '2026-07-30T00:00:00.000Z',
      updatedAt: '2026-07-30T00:01:00.000Z',
      status: 'complete',
      specSha256: sha256(SPEC),
      executionFingerprint: 'fingerprint',
      repositoryCommit: 'repo',
      repositoryDirty: false,
      resolvedConfigs: { browsecomp: config, dsqa: null, widesearch: null },
      datasetContracts: DATASET_CONTRACTS,
      approvedCostUsd: 1,
      estimatedCostUsd: 0.05,
      effectiveConcurrency: 1,
      chunks: [
        {
          suite: 'browsecomp',
          start: 0,
          end: 1,
          sessionId: 'session',
          artifact: relative(REPO_ROOT, artifact),
          sha256: sha256(buffer),
          bytes: buffer.byteLength,
          completedAt: '2026-07-30T00:01:00.000Z',
          summary: {
            accuracy: 1,
            totalQuestions: 1,
            correctAnswers: 1,
            skippedQuestions: 0,
            inputTokens: 10,
            outputTokens: 2,
            totalTokens: 12,
            reasoningTokens: 1,
            totalCost: 0.01,
            generationTimeMs: 100,
            temperature: 0,
            epochResults: [
              { epoch: 0, accuracy: 1, totalQuestions: 1, correctAnswers: 1, skippedQuestions: 0 },
            ],
          },
        },
      ],
    };
    writeFileSync(join(runDir, 'manifest.json'), JSON.stringify(manifest));

    const summary = await publishRunBundle({ runDir, publishDir });
    expect(summary.suites.browsecomp?.score).toBe(1);
    const redacted = readFileSync(join(publishDir, 'samples.redacted.jsonl'), 'utf8');
    expect(redacted).toContain('"sourceCount":1');
    expect(redacted).not.toContain('safe query');
    expect(redacted).not.toContain('model answer');
    expect(redacted).not.toContain('secret question');
    expect(redacted).not.toContain('secret target');
    expect(redacted).not.toContain('judge output');
    expect(redacted).toContain('"url":"https://example.com/"');
    expect(redacted).toContain('"title":"example.com"');
    expect(redacted).not.toContain('secret-question');
    expect(redacted).not.toContain('Secret question and answer');
    /* The request body publishes by default so bundles stay auditable, but its
     * two text-bearing fields (instructions, input) are stripped unless the spec
     * opts into inputs — the loop below proves no file carries them. */
    expect(redacted).toContain('"maxToolCalls":5');
    expect(redacted).toContain('"maxUses":5');
    expect(redacted).not.toContain('system prompt too');
    const publishedManifest = readFileSync(join(publishDir, 'manifest.json'), 'utf8');
    expect(publishedManifest).toContain(sha256(buffer));
    expect(publishedManifest).not.toContain(artifact);
    const firstChecksums = readFileSync(join(publishDir, 'checksums.txt'), 'utf8');
    expect(firstChecksums).toContain('summary.json');
    const generatedReadme = readFileSync(join(publishDir, 'README.md'), 'utf8');
    expect(generatedReadme).not.toContain('| Score |');
    expect(generatedReadme).not.toContain('$0.01');
    for (const name of readdirSync(publishDir)) {
      const content = readFileSync(join(publishDir, name), 'utf8');
      expect(content).not.toContain('secret question');
      expect(content).not.toContain('secret target');
      expect(content).not.toContain('judge output');
    }
    await publishRunBundle({ runDir, publishDir });
    expect(readFileSync(join(publishDir, 'checksums.txt'), 'utf8')).toBe(firstChecksums);

    const tampered = readFileSync(artifact);
    tampered[10] = (tampered[10] ?? 0) ^ 0xff;
    writeFileSync(artifact, tampered);
    await expect(publishRunBundle({ runDir, publishDir })).rejects.toThrow(
      'artifact checksum mismatch',
    );
    expect(readFileSync(join(publishDir, 'checksums.txt'), 'utf8')).toBe(firstChecksums);
  });

  it('publishes the full request body only when the spec opts into inputs', async () => {
    temporary = mkdtempSync(join(tmpdir(), 'bench-publish-inputs-'));
    const runDir = join(temporary, 'run');
    const publishDir = join(temporary, 'published');
    const rawDir = join(runDir, 'raw', 'browsecomp');
    mkdirSync(rawDir, { recursive: true });
    const artifact = join(rawDir, '000000-000001.parquet');
    const spec = parseRunSpec(SPEC_WITH_INPUTS);
    const config = benchmarkConfigForSuite(spec, 'browsecomp');
    const buffer = runResultToParquet({
      result: {
        metrics: { accuracy: 1, totalQuestions: 1, correctAnswers: 1, skippedQuestions: 0 },
        usage: {
          inputTokens: 10,
          outputTokens: 2,
          totalTokens: 12,
          reasoningTokens: 1,
          totalCost: 0.01,
          generationTimeMs: 100,
        },
        sampleScores: [
          {
            sampleId: 'browsecomp-0',
            epoch: 0,
            input: 'the question',
            target: 'the target',
            score: { value: ScoreValue.Correct, answer: 'model answer', explanation: '' },
            requestBody: {
              model: 'openai/gpt-5.6-sol',
              instructions: 'the system prompt',
              input: [{ role: 'user', content: 'the question' }],
              maxToolCalls: 5,
            },
          },
        ],
      },
      meta: {
        task: 'search_browsecomp',
        model: config.model,
        epochs: 1,
        temperature: 0,
        benchmarkConfig: config,
        createdAt: '2026-07-30T00:00:00.000Z',
      },
    });
    writeFileSync(artifact, buffer);
    writeFileSync(join(runDir, 'run.toml'), SPEC_WITH_INPUTS);
    writeFileSync(
      join(runDir, 'manifest.json'),
      JSON.stringify({
        version: 1,
        runId: 'published-test-inputs',
        title: 'Published test',
        description: 'Safe export',
        createdAt: '2026-07-30T00:00:00.000Z',
        updatedAt: '2026-07-30T00:00:00.000Z',
        status: 'complete',
        specSha256: sha256(SPEC_WITH_INPUTS),
        executionFingerprint: 'fingerprint',
        repositoryCommit: 'abc',
        repositoryDirty: false,
        estimatedCostUsd: 0.05,
        approvedCostUsd: 1,
        effectiveConcurrency: 1,
        resolvedConfigs: { browsecomp: config, dsqa: null, widesearch: null },
        datasetContracts: DATASET_CONTRACTS,
        chunks: [
          {
            suite: 'browsecomp',
            start: 0,
            end: 1,
            sessionId: 'session',
            artifact: relative(REPO_ROOT, artifact),
            sha256: sha256(buffer),
            bytes: buffer.byteLength,
            completedAt: '2026-07-30T00:00:00.000Z',
            summary: {
              accuracy: 1,
              totalQuestions: 1,
              correctAnswers: 1,
              skippedQuestions: 0,
              inputTokens: 10,
              outputTokens: 2,
              totalTokens: 12,
              reasoningTokens: 1,
              totalCost: 0.01,
              generationTimeMs: 100,
              temperature: 0,
              epochResults: [
                { epoch: 0, accuracy: 1, totalQuestions: 1, correctAnswers: 1, skippedQuestions: 0 },
              ],
            },
          },
        ],
      } satisfies RunManifest),
    );

    await publishRunBundle({ runDir, publishDir });
    const redacted = readFileSync(join(publishDir, 'samples.redacted.jsonl'), 'utf8');
    expect(redacted).toContain('"maxToolCalls":5');
    /* Opted in, so the body keeps its text-bearing fields. */
    expect(redacted).toContain('the system prompt');
    expect(redacted).toContain('"input":[{"role":"user","content":"the question"}]');
  });
});
