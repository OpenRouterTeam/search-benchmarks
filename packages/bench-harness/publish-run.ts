#!/usr/bin/env bun
import type { BenchmarkResultRow } from './parquet-schema';
import type { RunChunkRecord, RunManifest } from './bench';
import type { RunSpec, SuiteName } from './run-spec';

import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';

import { asyncBufferFromBytes, readResultRows } from './parquet';
import {
  benchmarkConfigForSuite,
  DATASET_CONTRACTS,
  parseRunSpec,
  selectedTaskCount,
  sha256,
  stableJson,
} from './run-spec';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');
const PUBLISHED_FORMAT_VERSION = 1 as const;
const PUBLISHED_FILES = [
  'README.md',
  'checksums.txt',
  'manifest.json',
  'report.html',
  'run.toml',
  'samples.redacted.jsonl',
  'summary.json',
] as const;

interface SuiteSummary {
  readonly benchmarkId: string;
  readonly primaryMetric: 'accuracy' | 'f1_by_item';
  readonly score: number;
  readonly accuracy: number;
  readonly selectedTasks: number;
  readonly completedTasks: number;
  readonly correctAnswers: number;
  readonly skippedQuestions: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly reasoningTokens: number;
  readonly generationTimeMs: number;
  readonly totalCost: number;
  readonly metrics: Readonly<Record<string, number>>;
  readonly chunks: number;
}

export interface PublishedSummary {
  readonly version: typeof PUBLISHED_FORMAT_VERSION;
  readonly runId: string;
  readonly title: string;
  readonly status: RunManifest['status'];
  readonly generatedAt: string;
  readonly model: string;
  readonly totalCost: number;
  readonly totalTokens: number;
  readonly suites: Readonly<Partial<Record<SuiteName, SuiteSummary>>>;
}

interface RedactedSample {
  readonly suite: SuiteName;
  readonly sampleId: string;
  readonly epoch: number;
  readonly score: string;
  readonly answer?: string | null;
  readonly input?: string | null;
  readonly citations: readonly { readonly url: string; readonly title: string }[];
  readonly searchCalls: readonly Readonly<Record<string, unknown>>[];
  readonly requestBody?: Readonly<Record<string, unknown>>;
}

function parseJson(raw: string | null | undefined): unknown {
  if (raw === null || raw === undefined) {
    return undefined;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/*
 * The persisted request body proves what the run actually asked for — search
 * budget, routing, effective blocklist — which is the audit-relevant part and
 * carries no ground truth. Two fields do carry it: `instructions` (the suite
 * system prompt) and `input` (the raw benchmark question). Those are dropped
 * unless the spec opts into publishing inputs, rather than withholding the
 * whole body, so bundles stay auditable by default.
 */
function requestBodyFromRow(
  row: BenchmarkResultRow,
  includeInputs: boolean,
): Readonly<Record<string, unknown>> | undefined {
  const body = record(parseJson(row.request_body));
  if (body === undefined) {
    return undefined;
  }
  if (includeInputs) {
    return body;
  }
  const { instructions: _instructions, input: _input, ...rest } = body;
  return rest;
}

function publicCitation(url: string): { url: string; title: string } | undefined {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return undefined;
    }
    return { url: `${parsed.origin}/`, title: parsed.hostname };
  } catch {
    return undefined;
  }
}

function citationsFromRow(row: BenchmarkResultRow): readonly { url: string; title: string }[] {
  const metadata = record(parseJson(row.metadata));
  const search = record(metadata?.['search']);
  const citations = search?.['citations'];
  if (!Array.isArray(citations)) {
    return [];
  }
  return citations.flatMap((item) => {
    const citation = record(item);
    if (typeof citation?.['url'] !== 'string') {
      return [];
    }
    const sanitized = publicCitation(citation['url']);
    return sanitized === undefined ? [] : [sanitized];
  });
}

function searchCallsFromRow(
  row: BenchmarkResultRow,
  includeQueries: boolean,
): readonly Readonly<Record<string, unknown>>[] {
  const items = parseJson(row.response_items);
  if (!Array.isArray(items)) {
    return [];
  }
  return items.flatMap((item) => {
    const value = record(item);
    if (value?.['type'] !== 'web_search_call' && value?.['type'] !== 'openrouter:web_search') {
      return [];
    }
    const action = record(value['action']);
    const sources = Array.isArray(action?.['sources'])
      ? action['sources'].flatMap((source) => {
          const item = record(source);
          return typeof item?.['url'] === 'string' ? [item['url']] : [];
        })
      : [];
    return [
      {
        ...(typeof value['id'] === 'string' && { id: value['id'] }),
        ...(typeof value['status'] === 'string' && { status: value['status'] }),
        ...(typeof action?.['type'] === 'string' && { action: action['type'] }),
        executed: sources.length > 0,
        sourceCount: sources.length,
        ...(includeQueries && typeof action?.['query'] === 'string' && { query: action['query'] }),
        ...(includeQueries && sources.length > 0 && { sources }),
      },
    ];
  });
}

function redactRow(row: BenchmarkResultRow, suite: SuiteName, spec: RunSpec): RedactedSample {
  return {
    suite,
    sampleId: row.sample_id,
    epoch: row.epoch,
    score: row.score_value,
    ...(spec.publish.include_answers && { answer: row.answer }),
    ...(spec.publish.include_inputs && { input: row.input }),
    citations: citationsFromRow(row),
    searchCalls: searchCallsFromRow(row, spec.publish.include_search_queries),
    ...(() => {
      const requestBody = requestBodyFromRow(row, spec.publish.include_inputs);
      return requestBody === undefined ? {} : { requestBody };
    })(),
  };
}

async function readArtifactRows(repoRelativePath: string): Promise<readonly BenchmarkResultRow[]> {
  const bytes = readFileSync(join(REPO_ROOT, repoRelativePath));
  return readResultRows(asyncBufferFromBytes(bytes));
}

function weightedMetric(
  values: readonly { readonly value: number; readonly weight: number }[],
): number {
  const weight = values.reduce((total, item) => total + item.weight, 0);
  return weight === 0
    ? 0
    : values.reduce((total, item) => total + item.value * item.weight, 0) / weight;
}

async function summarizeSuite(
  suite: SuiteName,
  chunks: readonly RunChunkRecord[],
  spec: RunSpec,
): Promise<{ summary: SuiteSummary; samples: RedactedSample[] }> {
  const rowsByChunk = await Promise.all(chunks.map((chunk) => readArtifactRows(chunk.artifact)));
  const samples = rowsByChunk
    .flatMap((rows) => rows.map((row) => redactRow(row, suite, spec)))
    .toSorted((left, right) =>
      left.sampleId === right.sampleId
        ? left.epoch - right.epoch
        : left.sampleId.localeCompare(right.sampleId),
    );
  const accuracy = weightedMetric(
    chunks.map((chunk) => ({
      value: chunk.summary.accuracy,
      weight: chunk.summary.totalQuestions,
    })),
  );
  const primaryScore = weightedMetric(
    chunks.map((chunk) => ({
      value: chunk.summary.primaryScore?.value ?? chunk.summary.accuracy,
      weight: chunk.summary.primaryScore?.weight ?? chunk.summary.totalQuestions,
    })),
  );
  const metricValues = new Map<string, { value: number; weight: number }[]>();
  for (let index = 0; index < chunks.length; index++) {
    const first = rowsByChunk[index]?.[0];
    const extraScores = parseJson(first?.extra_scores);
    if (!Array.isArray(extraScores)) {
      continue;
    }
    const weight = chunks[index]!.summary.primaryScore?.weight ?? chunks[index]!.summary.totalQuestions;
    for (const group of extraScores) {
      const metrics = record(record(group)?.['metrics']);
      const judgedSamples = record(metrics?.['samples_judged'])?.['value'];
      for (const [name, raw] of Object.entries(metrics ?? {})) {
        const value = record(raw)?.['value'];
        if (typeof value === 'number') {
          const existing = metricValues.get(name) ?? [];
          existing.push({
            value,
            weight:
              name === 'mean_stated_confidence' && typeof judgedSamples === 'number'
                ? judgedSamples
                : weight,
          });
          metricValues.set(name, existing);
        }
      }
    }
  }
  const completedTasks = new Set(chunks.flatMap((chunk) => {
    const ids: string[] = [];
    for (let index = chunk.start; index < chunk.end; index++) {
      ids.push(`${suite}:${index}`);
    }
    return ids;
  })).size;
  return {
    summary: {
      benchmarkId: DATASET_CONTRACTS[suite].benchmarkId,
      primaryMetric: suite === 'widesearch' ? 'f1_by_item' : 'accuracy',
      score: suite === 'widesearch' ? primaryScore : accuracy,
      accuracy,
      selectedTasks: selectedTaskCount(spec, suite),
      completedTasks,
      correctAnswers: chunks.reduce((total, chunk) => total + chunk.summary.correctAnswers, 0),
      skippedQuestions: chunks.reduce((total, chunk) => total + chunk.summary.skippedQuestions, 0),
      inputTokens: chunks.reduce((total, chunk) => total + chunk.summary.inputTokens, 0),
      outputTokens: chunks.reduce((total, chunk) => total + chunk.summary.outputTokens, 0),
      totalTokens: chunks.reduce((total, chunk) => total + chunk.summary.totalTokens, 0),
      reasoningTokens: chunks.reduce((total, chunk) => total + chunk.summary.reasoningTokens, 0),
      generationTimeMs: chunks.reduce((total, chunk) => total + chunk.summary.generationTimeMs, 0),
      totalCost: chunks.reduce((total, chunk) => total + chunk.summary.totalCost, 0),
      metrics: Object.fromEntries(
        [...metricValues.entries()].map(([name, values]) => [
          name,
          name === 'samples_judged'
            ? values.reduce((total, item) => total + item.value, 0)
            : weightedMetric(values),
        ]),
      ),
      chunks: chunks.length,
    },
    samples,
  };
}

export async function buildPublishedSummary(
  manifest: RunManifest,
  spec: RunSpec,
): Promise<{ summary: PublishedSummary; samples: readonly RedactedSample[] }> {
  const suites: Partial<Record<SuiteName, SuiteSummary>> = {};
  const samples: RedactedSample[] = [];
  for (const suite of spec.suites) {
    const chunks = manifest.chunks
      .filter((chunk) => chunk.suite === suite)
      .toSorted((left, right) => left.start - right.start);
    const result = await summarizeSuite(suite, chunks, spec);
    suites[suite] = result.summary;
    samples.push(...result.samples);
  }
  return {
    summary: {
      version: PUBLISHED_FORMAT_VERSION,
      runId: manifest.runId,
      title: manifest.title,
      status: manifest.status,
      generatedAt: manifest.updatedAt,
      model: spec.model,
      totalCost: Object.values(suites).reduce((total, suite) => total + suite.totalCost, 0),
      totalTokens: Object.values(suites).reduce((total, suite) => total + suite.totalTokens, 0),
      suites,
    },
    samples,
  };
}

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function reportHtml(summary: PublishedSummary, manifest: RunManifest): string {
  const cards = Object.entries(summary.suites)
    .map(
      ([suite, value]) => `<article class="card">
        <div class="eyebrow">${escapeHtml(value.primaryMetric)}</div>
        <h2>${escapeHtml(suite)}</h2>
        <div class="score">${(value.score * 100).toFixed(1)}%</div>
        <dl><dt>Tasks</dt><dd>${value.completedTasks}/${value.selectedTasks}</dd><dt>Cost</dt><dd>$${value.totalCost.toFixed(4)}</dd><dt>Tokens</dt><dd>${value.totalTokens.toLocaleString()}</dd></dl>
      </article>`,
    )
    .join('\n');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(summary.title)}</title>
<style>
:root{color-scheme:light;font-family:Inter,ui-sans-serif,system-ui,sans-serif;background:#f7f7fb;color:#17171d}body{margin:0}.wrap{max-width:1080px;margin:auto;padding:56px 24px 80px}.top{display:flex;justify-content:space-between;gap:20px;border-bottom:1px solid #dedee8;padding-bottom:18px}.brand{font-weight:750}.status{font:600 12px ui-monospace,SFMono-Regular,monospace;text-transform:uppercase;color:#d24f2a}h1{font-size:clamp(36px,7vw,72px);letter-spacing:-.055em;line-height:.96;margin:64px 0 18px;max-width:850px}.lede{font-size:18px;color:#5d5d6b;max-width:720px;line-height:1.55}.meta{font:12px ui-monospace,SFMono-Regular,monospace;color:#77778a;margin:28px 0 42px}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}.card{background:white;border:1px solid #e4e4ec;border-radius:14px;padding:24px}.eyebrow{text-transform:uppercase;letter-spacing:.14em;font-size:10px;color:#d24f2a;font-weight:700}.card h2{text-transform:capitalize;margin:8px 0 30px}.score{font-size:48px;font-weight:750;letter-spacing:-.05em}dl{display:grid;grid-template-columns:1fr auto;gap:8px;margin:24px 0 0;font-size:12px}dt{color:#77778a}dd{margin:0;font-variant-numeric:tabular-nums}.footer{margin-top:32px;padding-top:20px;border-top:1px solid #dedee8;font-size:12px;color:#77778a}@media(max-width:760px){.grid{grid-template-columns:1fr}.top{flex-direction:column}h1{margin-top:42px}}
</style></head><body><main class="wrap"><header class="top"><div class="brand">OpenRouter Search Benchmarks</div><div class="status">${escapeHtml(summary.status)}</div></header>
<h1>${escapeHtml(summary.title)}</h1><p class="lede">${escapeHtml(manifest.description)}</p>
<div class="meta">${escapeHtml(summary.model)} · run ${escapeHtml(summary.runId)} · $${summary.totalCost.toFixed(4)} provider-reported</div>
<section class="grid">${cards}</section><footer class="footer">Generated ${escapeHtml(summary.generatedAt)} · targets and judge trajectories excluded from this published bundle</footer></main></body></html>`;
}

function readme(summary: PublishedSummary, manifest: RunManifest): string {
  return `# ${summary.title}

${manifest.description}

- Status: \`${summary.status}\`
- Model: \`${summary.model}\`
- Full configuration: [\`run.toml\`](run.toml)
- Machine-readable summary: [\`summary.json\`](summary.json)
- Redacted trajectories: [\`samples.redacted.jsonl\`](samples.redacted.jsonl)
- Self-contained report: [\`report.html\`](report.html)

The published trajectory export excludes benchmark targets, grader details,
raw inputs, model answers, search queries, session IDs, and generation IDs by
default. Optional content must be explicitly enabled in the run spec and reviewed
before sharing. Raw Parquet artifacts are identified by checksum in
\`manifest.json\` and remain outside Git.
`;
}

function atomicWrite(path: string, content: string | Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, content);
  renameSync(temporary, path);
}

function acquirePublishLock(path: string): () => void {
  if (existsSync(path)) {
    const pid = Number(readFileSync(path, 'utf8'));
    try {
      process.kill(pid, 0);
      throw new Error(`Publication is already active under process ${pid}`);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Publication is already active')) {
        throw error;
      }
      unlinkSync(path);
    }
  }
  const descriptor = openSync(path, 'wx');
  writeFileSync(descriptor, String(process.pid));
  closeSync(descriptor);
  let released = false;
  return () => {
    if (!released) {
      released = true;
      try {
        unlinkSync(path);
      } catch {
        // The parent directory may have been removed by a test caller.
      }
    }
  };
}

async function validateRawArtifacts(
  manifest: RunManifest,
  spec: RunSpec,
  specText: string,
): Promise<void> {
  if (manifest.specSha256 !== sha256(specText)) {
    throw new Error('Refusing to publish: run.toml does not match the manifest checksum');
  }
  for (const chunk of manifest.chunks) {
    const path = join(REPO_ROOT, chunk.artifact);
    const bytes = readFileSync(path);
    if (bytes.byteLength !== chunk.bytes || statSync(path).size !== chunk.bytes) {
      throw new Error(`Refusing to publish: artifact size mismatch for ${chunk.artifact}`);
    }
    if (sha256(bytes) !== chunk.sha256) {
      throw new Error(`Refusing to publish: artifact checksum mismatch for ${chunk.artifact}`);
    }
    const rows = await readResultRows(asyncBufferFromBytes(bytes));
    if (rows.length !== (chunk.end - chunk.start) * spec.epochs) {
      throw new Error(`Refusing to publish: artifact row count mismatch for ${chunk.artifact}`);
    }
    const first = rows[0];
    const expectedConfig = benchmarkConfigForSuite(spec, chunk.suite);
    const persistedConfig = parseJson(first?.benchmark_config);
    if (
      first?.task !== DATASET_CONTRACTS[chunk.suite].benchmarkId ||
      stableJson(persistedConfig) !== stableJson(expectedConfig)
    ) {
      throw new Error(`Refusing to publish: artifact config mismatch for ${chunk.artifact}`);
    }
  }
}

function publishedManifest(manifest: RunManifest): unknown {
  return {
    version: manifest.version,
    run_id: manifest.runId,
    status: manifest.status,
    created_at: manifest.createdAt,
    updated_at: manifest.updatedAt,
    source_spec_sha256: manifest.specSha256,
    execution_fingerprint: manifest.executionFingerprint,
    harness_changes: manifest.harnessChanges ?? [],
    repository_commit: manifest.repositoryCommit,
    repository_dirty: manifest.repositoryDirty,
    estimated_cost_usd: manifest.estimatedCostUsd,
    approved_cost_usd: manifest.approvedCostUsd,
    effective_concurrency: manifest.effectiveConcurrency,
    resolved_configs: manifest.resolvedConfigs,
    dataset_contracts: manifest.datasetContracts,
    raw_artifacts: manifest.chunks.map((chunk) => ({
      suite: chunk.suite,
      range: [chunk.start, chunk.end],
      filename: basename(chunk.artifact),
      sha256: chunk.sha256,
      bytes: chunk.bytes,
    })),
  };
}

export async function publishRunBundle(opts: {
  readonly runDir: string;
  readonly publishDir: string;
}): Promise<PublishedSummary> {
  const manifestPath = join(opts.runDir, 'manifest.json');
  const specPath = join(opts.runDir, 'run.toml');
  if (!existsSync(manifestPath) || !existsSync(specPath)) {
    throw new Error(`Run bundle is missing manifest.json or run.toml: ${opts.runDir}`);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as RunManifest;
  const specText = readFileSync(specPath, 'utf8');
  const spec = parseRunSpec(specText);
  mkdirSync(dirname(opts.publishDir), { recursive: true });
  const releaseLock = acquirePublishLock(`${opts.publishDir}.lock`);
  const staging = mkdtempSync(join(dirname(opts.publishDir), `.${basename(opts.publishDir)}.staging-`));
  let backup: string | undefined;
  try {
    await validateRawArtifacts(manifest, spec, specText);
    const { summary, samples } = await buildPublishedSummary(manifest, spec);
    if (existsSync(opts.publishDir)) {
      const unexpected = readdirSync(opts.publishDir).filter(
        (name) => !PUBLISHED_FILES.includes(name as (typeof PUBLISHED_FILES)[number]),
      );
      if (unexpected.length > 0) {
        throw new Error(`Refusing to replace a published bundle with unexpected files: ${unexpected.join(', ')}`);
      }
    }
    atomicWrite(join(staging, 'run.toml'), specText);
    atomicWrite(join(staging, 'manifest.json'), `${JSON.stringify(publishedManifest(manifest), null, 2)}\n`);
    atomicWrite(join(staging, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
    atomicWrite(
      join(staging, 'samples.redacted.jsonl'),
      samples.map((sample) => JSON.stringify(sample)).join('\n') + (samples.length > 0 ? '\n' : ''),
    );
    atomicWrite(join(staging, 'report.html'), reportHtml(summary, manifest));
    atomicWrite(join(staging, 'README.md'), readme(summary, manifest));
    const checksumFiles = PUBLISHED_FILES.filter((name) => name !== 'checksums.txt').toSorted();
    const checksums = checksumFiles
      .map((name) => `${sha256(readFileSync(join(staging, name)))}  ${name}`)
      .join('\n');
    atomicWrite(join(staging, 'checksums.txt'), `${checksums}\n`);

    if (existsSync(opts.publishDir)) {
      backup = `${opts.publishDir}.backup-${process.pid}`;
      renameSync(opts.publishDir, backup);
    }
    renameSync(staging, opts.publishDir);
    if (backup !== undefined) {
      rmSync(backup, { recursive: true, force: true });
      backup = undefined;
    }
    return summary;
  } catch (error) {
    if (backup !== undefined && existsSync(backup) && !existsSync(opts.publishDir)) {
      renameSync(backup, opts.publishDir);
      backup = undefined;
    }
    throw error;
  } finally {
    rmSync(staging, { recursive: true, force: true });
    if (backup !== undefined) {
      rmSync(backup, { recursive: true, force: true });
    }
    releaseLock();
  }
}

export function publishedRunDirectory(repoRoot: string, runId: string, spec: RunSpec): string {
  return join(repoRoot, 'published-runs', spec.search.engine, runId);
}

function runIdArg(argv: readonly string[]): string {
  const index = argv.indexOf('--run-id');
  const runId = index === -1 ? undefined : argv[index + 1];
  if (runId === undefined || !/^[a-z0-9][a-z0-9._-]*$/u.test(runId)) {
    throw new Error('Usage: bun run publish-run.ts --run-id <slug>');
  }
  return runId;
}

if (import.meta.main) {
  const runId = runIdArg(process.argv.slice(2));
  const runDir = join(REPO_ROOT, 'runs', 'ts', runId);
  const spec = parseRunSpec(readFileSync(join(runDir, 'run.toml'), 'utf8'));
  const publishDir = publishedRunDirectory(REPO_ROOT, runId, spec);
  const summary = await publishRunBundle({
    runDir,
    publishDir,
  });
  process.stdout.write(`Published ${relative(REPO_ROOT, publishDir)} (${summary.status})\n`);
}
