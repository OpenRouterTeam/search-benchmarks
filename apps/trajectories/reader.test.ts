import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ScoreValue } from '@openrouter/bench-harness/core';
import { runResultToParquet } from '@openrouter/bench-harness/parquet';

import { discoverParquetFiles, effectiveReasoningEffort, TrajectoryStore } from './reader';

let temporary: string | undefined;

afterEach(() => {
  if (temporary !== undefined) {
    rmSync(temporary, { recursive: true, force: true });
    temporary = undefined;
  }
});

function parquetFixture(sampleId = 'browsecomp-0'): Buffer {
  return runResultToParquet({
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
          sampleId,
          epoch: 0,
          input: 'question',
          target: 'target',
          score: { value: ScoreValue.Correct, answer: 'answer', explanation: 'matches' },
          responseItems: [
            {
              type: 'openrouter:web_search',
              id: 'search-1',
              status: 'completed',
              action: {
                type: 'search',
                query: 'query',
                sources: [{ type: 'url', url: 'https://example.com' }],
              },
            },
          ],
          metadata: {
            search: { citations: [{ url: 'https://example.com', title: 'Example' }] },
          },
        },
      ],
    },
    meta: {
      task: 'search_browsecomp',
      model: 'openai/gpt-5.6-sol',
      epochs: 1,
      benchmarkConfig: {
        benchmarkId: 'search_browsecomp',
        model: 'openai/gpt-5.6-sol',
        lane: { webSearch: 'server-tool', engine: 'auto' },
      },
    },
  });
}

describe('trajectory reader', () => {
  it('reports explicit reasoning effort and GPT-5.6 defaults', () => {
    expect(
      effectiveReasoningEffort(
        { model: 'openai/gpt-5.6-sol', reasoningEffort: 'high' },
        undefined,
      ),
    ).toBe('high');
    expect(effectiveReasoningEffort({ model: 'openai/gpt-5.6-sol' }, undefined)).toBe(
      'medium (model default)',
    );
    expect(effectiveReasoningEffort({ model: 'other/model' }, undefined)).toBe(
      'provider default',
    );
  });

  it('loads the checked-in synthetic demo', async () => {
    const store = await TrajectoryStore.load(fileURLToPath(new URL('./demo.parquet', import.meta.url)));
    expect(store.index().samples).toHaveLength(1);
    expect(store.index().samples[0]).toMatchObject({ sampleId: 'demo-0', searchCalls: 1 });
  });

  it('discovers chunk files and exposes parsed sample details', async () => {
    temporary = mkdtempSync(join(tmpdir(), 'trajectory-reader-'));
    const nested = join(temporary, 'raw', 'browsecomp');
    mkdirSync(nested, { recursive: true });
    const path = join(nested, '000000-000001.parquet');
    writeFileSync(path, parquetFixture());

    expect(discoverParquetFiles(temporary)).toEqual([path]);
    const store = await TrajectoryStore.load(temporary);
    expect(store.index().files).toHaveLength(1);
    expect(store.index().samples[0]).toMatchObject({
      sampleId: 'browsecomp-0',
      searchAttempts: 1,
      searchCalls: 1,
      citations: 1,
      uniqueCitations: 1,
    });
    const summary = store.index().samples[0]!;
    expect(summary.id).toEndWith('::raw/browsecomp/000000-000001.parquet::browsecomp-0::0');
    expect(store.sample(summary.id)).toMatchObject({
      input: 'question',
      target: 'target',
      answer: 'answer',
      reasoningEffort: 'medium (model default)',
    });
    expect(store.findSamples('browsecomp-0')).toHaveLength(1);
  });

  it('derives run identity from the nearest manifest directory', async () => {
    temporary = mkdtempSync(join(tmpdir(), 'trajectory-runs-'));
    for (const runId of ['run-a', 'run-b']) {
      const chunkDir = join(temporary, runId, 'raw', 'browsecomp');
      mkdirSync(chunkDir, { recursive: true });
      writeFileSync(join(temporary, runId, 'manifest.json'), JSON.stringify({ title: `Title ${runId}`, status: 'complete' }));
      writeFileSync(join(chunkDir, '000000-000001.parquet'), parquetFixture(runId));
    }

    const store = await TrajectoryStore.load(temporary);
    const index = store.index();
    expect(index.runs.map((run) => run.id)).toEqual(['run-a', 'run-b']);
    expect(index.runs[0]).toMatchObject({ title: 'Title run-a', status: 'complete', chunks: 1, tasks: 1 });
    expect(index.samples.map((sample) => sample.run)).toEqual(['run-a', 'run-b']);
    expect(index.files.map((file) => file.file)).toEqual([
      'raw/browsecomp/000000-000001.parquet',
      'raw/browsecomp/000000-000001.parquet',
    ]);
  });

  it('picks up new chunk files on refresh without a restart', async () => {
    temporary = mkdtempSync(join(tmpdir(), 'trajectory-live-'));
    const chunkDir = join(temporary, 'live-run', 'raw', 'browsecomp');
    mkdirSync(chunkDir, { recursive: true });
    writeFileSync(join(temporary, 'live-run', 'manifest.json'), JSON.stringify({ status: 'running' }));
    writeFileSync(join(chunkDir, '000000-000001.parquet'), parquetFixture('browsecomp-0'));

    const store = await TrajectoryStore.load(temporary);
    expect(store.index().samples).toHaveLength(1);

    writeFileSync(join(chunkDir, '000001-000002.parquet'), parquetFixture('browsecomp-1'));
    writeFileSync(join(temporary, 'live-run', 'manifest.json'), JSON.stringify({ status: 'complete' }));

    expect(await store.refresh(0)).toBe(true);
    const index = store.index();
    expect(index.samples.map((sample) => sample.sampleId)).toEqual(['browsecomp-0', 'browsecomp-1']);
    expect(index.runs[0]?.status).toBe('complete');
    expect(await store.refresh(0)).toBe(false);
  });

  it('omits runs matching an exclusion pattern', async () => {
    temporary = mkdtempSync(join(tmpdir(), 'trajectory-exclude-'));
    for (const runId of ['ladder-5turn', 'ladder-5turn-calibration']) {
      const chunkDir = join(temporary, runId, 'raw', 'browsecomp');
      mkdirSync(chunkDir, { recursive: true });
      writeFileSync(join(temporary, runId, 'manifest.json'), JSON.stringify({ status: 'complete' }));
      writeFileSync(join(chunkDir, '000000-000001.parquet'), parquetFixture());
    }

    const all = await TrajectoryStore.load(temporary);
    expect(all.index().runs.map((run) => run.id)).toEqual(['ladder-5turn', 'ladder-5turn-calibration']);

    const filtered = await TrajectoryStore.load(temporary, { excludeRuns: ['calibration'] });
    expect(filtered.index().runs.map((run) => run.id)).toEqual(['ladder-5turn']);
    expect(filtered.index().samples.every((sample) => sample.run === 'ladder-5turn')).toBe(true);
  });

  it('rejects directories without parquet artifacts', () => {
    temporary = mkdtempSync(join(tmpdir(), 'trajectory-reader-empty-'));
    expect(() => discoverParquetFiles(temporary!)).toThrow('No Parquet files');
  });
});
