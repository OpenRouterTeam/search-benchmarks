#!/usr/bin/env bun
import type { SearchBenchmarkConfig } from '@openrouter/bench-harness/benchmarks/benchmark-config';
import type { ChunkResultSummary } from '@openrouter/bench-harness/parquet';
import type { RunSpec, SuiteName } from './run-spec';

import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

import * as Either from 'effect/Either';

import { asyncBufferFromBytes, readResultRows, summarizeChunkRows } from '@openrouter/bench-harness/parquet';
import { makeProgressReporter } from '@openrouter/bench-harness/progress';
import { runBenchmarkById } from '@openrouter/bench-harness/run-benchmark-by-id';
import { makeDeterministicResultStore } from './deterministic-result-store';
import { clampMaxOutputTokens, resolveModelLimits } from './model-limits';
import { publishedRunDirectory, publishRunBundle } from './publish-run';
import {
  benchmarkConfigForSuite,
  DATASET_CONTRACTS,
  estimatedRunCost,
  parseRunSpec,
  resolveMaxTotalResults,
  selectedTaskCount,
  sha256,
  stableJson,
} from './run-spec';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');
const VENDOR_ROOT = join(REPO_ROOT, 'packages', 'bench-harness');
const DEFAULT_SEARCH_MAX_OUTPUT_TOKENS = 128_000;
const MANIFEST_VERSION = 1 as const;

interface CliArgs {
  readonly specPath: string;
  readonly runId: string;
  readonly dryRun: boolean;
  readonly approveCostUsd?: number;
  /** Resume a run after the harness changed, recording the change in the manifest. */
  readonly allowHarnessChange: boolean;
  /** Execution-only override for in-flight tasks; does not change the spec hash. */
  readonly concurrency?: number;
}

export interface RunChunkRecord {
  readonly suite: SuiteName;
  readonly start: number;
  readonly end: number;
  readonly sessionId: string;
  readonly artifact: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly completedAt: string;
  readonly summary: ChunkResultSummary;
}

export interface RunManifest {
  readonly version: typeof MANIFEST_VERSION;
  readonly runId: string;
  readonly title: string;
  readonly description: string;
  readonly createdAt: string;
  updatedAt: string;
  status: 'running' | 'complete' | 'budget-stopped' | 'failed';
  readonly specSha256: string;
  executionFingerprint: string;
  /** Appended whenever a resume crosses a harness build, for auditability. */
  harnessChanges?: { readonly at: string; readonly from: string; readonly to: string }[];
  readonly repositoryCommit: string | null;
  readonly repositoryDirty: boolean;
  readonly resolvedConfigs: Readonly<Record<SuiteName, SearchBenchmarkConfig | null>>;
  readonly datasetContracts: typeof DATASET_CONTRACTS;
  readonly approvedCostUsd: number;
  readonly estimatedCostUsd: number | null;
  /** Tasks in flight; may differ from the spec when overridden at run time. */
  effectiveConcurrency: number;
  chunks: RunChunkRecord[];
  error?: string;
}

function parseArgs(argv: readonly string[]): CliArgs {
  const value = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index === -1 ? undefined : argv[index + 1];
  };
  const specPath = value('--spec');
  const runId = value('--run-id');
  if (specPath === undefined || runId === undefined) {
    throw new Error(
      'Usage: bun run bench.ts --spec <run.toml> --run-id <slug> [--dry-run | --approve-cost-usd N] [--concurrency N] [--allow-harness-change]',
    );
  }
  if (!/^[a-z0-9][a-z0-9._-]*$/u.test(runId)) {
    throw new Error('--run-id must be a lowercase filesystem-safe slug');
  }
  const rawConcurrency = value('--concurrency');
  const concurrency = rawConcurrency === undefined ? undefined : Number(rawConcurrency);
  if (concurrency !== undefined && (!Number.isInteger(concurrency) || concurrency < 1)) {
    throw new Error('--concurrency must be a positive integer');
  }
  const rawApproval = value('--approve-cost-usd');
  const approveCostUsd = rawApproval === undefined ? undefined : Number(rawApproval);
  if (approveCostUsd !== undefined && (!Number.isFinite(approveCostUsd) || approveCostUsd <= 0)) {
    throw new Error('--approve-cost-usd must be a positive number');
  }
  return {
    specPath: resolve(specPath),
    runId,
    dryRun: argv.includes('--dry-run'),
    allowHarnessChange: argv.includes('--allow-harness-change'),
    ...(concurrency !== undefined && { concurrency }),
    ...(approveCostUsd !== undefined && { approveCostUsd }),
  };
}

function gitOutput(args: readonly string[]): string | null {
  const result = spawnSync('git', [...args], { cwd: REPO_ROOT, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() || null : null;
}

function executionFingerprint(): string {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (
        ['node_modules', 'bench-results', '.effect-tsgo', 'dist'].includes(entry.name) ||
        entry.name.endsWith('.tsbuildinfo')
      ) {
        continue;
      }
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(path);
      } else if (entry.isFile()) {
        files.push(path);
      }
    }
  };
  visit(import.meta.dirname);
  visit(VENDOR_ROOT);
  return sha256(
    files
      .toSorted()
      .map((path) => `${relative(REPO_ROOT, path)}:${sha256(readFileSync(path))}`)
      .join('\n'),
  );
}

export function acquireRunLock(path: string): () => void {
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) {
    const pid = Number(readFileSync(path, 'utf8'));
    try {
      process.kill(pid, 0);
      throw new Error(`Run is already active under process ${pid}`);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Run is already active')) {
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
        // The run directory may have been removed by the caller.
      }
    }
  };
}

function atomicWriteJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temporary, path);
}

function chunkRanges(spec: RunSpec, suite: SuiteName): readonly { start: number; end: number }[] {
  const count = selectedTaskCount(spec, suite);
  const end = spec.start + count;
  const ranges: { start: number; end: number }[] = [];
  for (let start = spec.start; start < end; start += spec.chunk_size) {
    ranges.push({ start, end: Math.min(start + spec.chunk_size, end) });
  }
  return ranges;
}

function chunkFilename(start: number, end: number): string {
  return `${String(start).padStart(6, '0')}-${String(end).padStart(6, '0')}.parquet`;
}

async function readChunk(
  path: string,
  config: SearchBenchmarkConfig,
  expectedRows: number,
): Promise<{ rows: Awaited<ReturnType<typeof readResultRows>>; summary: ChunkResultSummary }> {
  const bytes = readFileSync(path);
  const rows = await readResultRows(asyncBufferFromBytes(bytes));
  if (rows.length !== expectedRows) {
    throw new Error(`Invalid resumable chunk ${path}: expected ${expectedRows} rows, got ${rows.length}`);
  }
  const first = rows[0];
  if (first === undefined || first.task !== config.benchmarkId) {
    throw new Error(`Invalid resumable chunk ${path}: benchmark id mismatch`);
  }
  const persistedConfig = first.benchmark_config == null ? null : JSON.parse(first.benchmark_config);
  if (stableJson(persistedConfig) !== stableJson(config)) {
    throw new Error(`Invalid resumable chunk ${path}: benchmark config mismatch`);
  }
  const summary = summarizeChunkRows(rows);
  if (summary === null) {
    throw new Error(`Invalid resumable chunk ${path}: no rows`);
  }
  return { rows, summary };
}

function makeManifest(
  args: CliArgs,
  spec: RunSpec,
  specText: string,
  approvedCostUsd: number,
  estimatedCostUsd: number | null,
): RunManifest {
  const resolvedConfigs = Object.fromEntries(
    (['browsecomp', 'dsqa', 'widesearch'] as const).map((suite) => [
      suite,
      spec.suites.includes(suite) ? benchmarkConfigForSuite(spec, suite) : null,
    ]),
  ) as Readonly<Record<SuiteName, SearchBenchmarkConfig | null>>;
  const now = new Date().toISOString();
  return {
    version: MANIFEST_VERSION,
    runId: args.runId,
    title: spec.title,
    description: spec.description,
    createdAt: now,
    updatedAt: now,
    status: 'running',
    specSha256: sha256(specText),
    executionFingerprint: executionFingerprint(),
    repositoryCommit: gitOutput(['rev-parse', 'HEAD']),
    repositoryDirty: gitOutput(['status', '--porcelain']) !== null,
    resolvedConfigs,
    datasetContracts: DATASET_CONTRACTS,
    approvedCostUsd,
    estimatedCostUsd,
    effectiveConcurrency: args.concurrency ?? spec.concurrency,
    chunks: [],
  };
}

function loadOrCreateManifest(
  path: string,
  args: CliArgs,
  spec: RunSpec,
  specText: string,
  approvedCostUsd: number,
  estimatedCostUsd: number | null,
): RunManifest {
  if (!existsSync(path)) {
    return makeManifest(args, spec, specText, approvedCostUsd, estimatedCostUsd);
  }
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as RunManifest;
  if (manifest.version !== MANIFEST_VERSION || manifest.runId !== args.runId) {
    throw new Error(`Existing run manifest at ${path} is incompatible`);
  }
  if (manifest.specSha256 !== sha256(specText)) {
    throw new Error(`Run ${args.runId} already exists with a different spec`);
  }
  const fingerprint = executionFingerprint();
  if (manifest.executionFingerprint !== fingerprint) {
    if (!args.allowHarnessChange) {
      throw new Error(
        `Run ${args.runId} was created by a different harness build; pass --allow-harness-change to resume and record the change`,
      );
    }
    manifest.harnessChanges = [
      ...(manifest.harnessChanges ?? []),
      { at: new Date().toISOString(), from: manifest.executionFingerprint, to: fingerprint },
    ];
    manifest.executionFingerprint = fingerprint;
  }
  return {
    ...manifest,
    approvedCostUsd,
    effectiveConcurrency: args.concurrency ?? spec.concurrency,
    status: 'running',
    error: undefined,
  };
}

function printPlan(spec: RunSpec, runId: string, concurrency: number): void {
  const estimate = estimatedRunCost(spec);
  process.stdout.write(`Run: ${runId}\nModel: ${spec.model}\n`);
  for (const suite of spec.suites) {
    const tasks = selectedTaskCount(spec, suite);
    const chunks = chunkRanges(spec, suite).length;
    const rate = spec.cost_estimates?.[suite];
    process.stdout.write(
      `  ${suite.padEnd(11)} tasks=${tasks} chunks=${chunks} estimated=${rate === undefined ? 'calibration-required' : `$${(tasks * spec.epochs * rate).toFixed(4)}`}\n`,
    );
  }
  process.stdout.write(`Total estimate: ${estimate === undefined ? 'calibration-required' : `$${estimate.toFixed(4)}`}\n`);
  process.stdout.write(`Spec budget: ${spec.budget_usd === undefined ? 'not-set' : `$${spec.budget_usd.toFixed(2)}`}\n`);
  process.stdout.write(`Concurrency: ${concurrency}${concurrency === spec.concurrency ? '' : ` (spec ${spec.concurrency})`}\n`);
  const totalResults = resolveMaxTotalResults(spec);
  process.stdout.write(
    `Search: ${spec.search.engine} · ${spec.search.max_agent_turns ?? 'server-default'} turns · cumulative results ${totalResults ?? 'server default (50)'}${spec.search.max_total_results === undefined && totalResults !== undefined ? ' (derived from depth)' : ''}\n`,
  );
}

/*
 * Clamp the output-token budget to what the model advertises. The lanes share
 * one DEFAULT_SEARCH_MAX_OUTPUT_TOKENS constant, which is only safe while the
 * model's ceiling is at least that large; over-asking is either silently
 * clamped or rejected as a 400 that looks like transient retry noise. A
 * catalogue miss leaves the default in place rather than failing the run.
 *
 * Resolved before the dry-run gate so a preview reports the real budget. The
 * catalogue is a free public read and needs no key.
 */
async function resolveOutputTokenBudget(
  spec: RunSpec,
  apiKey?: string,
): Promise<{ readonly ceiling: number | undefined; readonly effective: number }> {
  const limits = await resolveModelLimits({
    model: spec.model,
    ...(apiKey !== undefined && { apiKey }),
    ...(spec.inference.provider_only !== undefined && {
      providerOnly: spec.inference.provider_only,
    }),
  });
  const ceiling = limits?.maxCompletionTokens;
  const requested = DEFAULT_SEARCH_MAX_OUTPUT_TOKENS;
  const effective = clampMaxOutputTokens(requested, ceiling);

  if (ceiling === undefined) {
    process.stdout.write(
      `Output tokens: ${requested} (no ceiling advertised for ${spec.model}; server decides)\n`,
    );
  } else {
    const from = limits?.source === 'endpoints' ? 'narrowest routable endpoint' : 'model ceiling';
    process.stdout.write(
      `Output tokens: ${effective}${
        effective === requested
          ? ` (at ${from})`
          : ` (clamped from ${requested} by ${from})`
      }\n`,
    );
    /* Endpoint ceilings can differ by an order of magnitude, so show the spread
     * that forced the clamp rather than just the winning number. */
    if (limits?.source === 'endpoints' && limits.endpointCeilings !== undefined) {
      const spread = limits.endpointCeilings
        .map((item) => `${item.provider}=${item.ceiling}`)
        .join(' · ');
      process.stdout.write(`  endpoint ceilings: ${spread}\n`);
    }
  }
  return { ceiling, effective };
}

async function run(args: CliArgs): Promise<void> {
  const specText = readFileSync(args.specPath, 'utf8');
  const spec = parseRunSpec(specText);
  printPlan(spec, args.runId, args.concurrency ?? spec.concurrency);
  const { ceiling } = await resolveOutputTokenBudget(spec, process.env['OPENROUTER_API_KEY']);
  if (args.dryRun) {
    process.stdout.write('Dry run: no API calls made.\n');
    return;
  }

  const estimate = estimatedRunCost(spec);
  const costEstimates = spec.cost_estimates;
  const budgetUsd = spec.budget_usd;
  const isUnestimatedCalibration =
    estimate === undefined && spec.limit === 1 && spec.chunk_size === 1 && spec.epochs === 1;
  if ((estimate === undefined || costEstimates === undefined || budgetUsd === undefined) && !isUnestimatedCalibration) {
    throw new Error(
      'Paid runs require measured [cost_estimates] and budget_usd; run a one-task calibration first',
    );
  }
  if (estimate !== undefined && budgetUsd !== undefined && estimate > budgetUsd) {
    throw new Error(
      `Estimated cost $${estimate.toFixed(4)} exceeds spec budget $${budgetUsd.toFixed(2)}`,
    );
  }
  if (args.approveCostUsd === undefined) {
    throw new Error('Paid runs require --approve-cost-usd with the explicitly approved ceiling');
  }
  if (estimate !== undefined && args.approveCostUsd < estimate) {
    throw new Error(
      `Approved ceiling $${args.approveCostUsd.toFixed(2)} is below estimated cost $${estimate.toFixed(4)}`,
    );
  }
  const approvedCostUsd = Math.min(args.approveCostUsd, budgetUsd ?? args.approveCostUsd);
  const apiKey = process.env['OPENROUTER_API_KEY'];
  if (apiKey === undefined || apiKey === '') {
    throw new Error('Set OPENROUTER_API_KEY');
  }

  const runDir = join(REPO_ROOT, 'runs', 'ts', args.runId);
  const publishDir = publishedRunDirectory(REPO_ROOT, args.runId, spec);
  const releaseLock = acquireRunLock(join(runDir, '.run.lock'));
  process.once('exit', releaseLock);
  const manifestPath = join(runDir, 'manifest.json');
  const eventsPath = join(runDir, 'logs', 'events.jsonl');
  mkdirSync(join(runDir, 'raw'), { recursive: true });
  mkdirSync(dirname(eventsPath), { recursive: true });
  const copiedSpecPath = join(runDir, 'run.toml');
  if (existsSync(copiedSpecPath) && readFileSync(copiedSpecPath, 'utf8') !== specText) {
    throw new Error(`Run ${args.runId} already contains a different run.toml`);
  }
  writeFileSync(copiedSpecPath, specText);

  const manifest = loadOrCreateManifest(
    manifestPath,
    args,
    spec,
    specText,
    approvedCostUsd,
    estimate ?? null,
  );
  atomicWriteJson(manifestPath, manifest);

  const event = (type: string, detail: Readonly<Record<string, unknown>>): void => {
    appendFileSync(eventsPath, `${JSON.stringify({ at: new Date().toISOString(), type, ...detail })}\n`);
  };

  try {
    for (const suite of spec.suites) {
      const config = benchmarkConfigForSuite(spec, suite);
      for (const range of chunkRanges(spec, suite)) {
        const suiteDir = join(runDir, 'raw', suite);
        const artifactPath = join(suiteDir, chunkFilename(range.start, range.end));
        const expectedRows = (range.end - range.start) * spec.epochs;
        const existing = manifest.chunks.find(
          (chunk) => chunk.suite === suite && chunk.start === range.start && chunk.end === range.end,
        );
        if (existsSync(artifactPath)) {
          const { summary } = await readChunk(artifactPath, config, expectedRows);
          const bytes = readFileSync(artifactPath);
          if (existing !== undefined && existing.sha256 !== sha256(bytes)) {
            throw new Error(`Resumable chunk checksum mismatch: ${relative(REPO_ROOT, artifactPath)}`);
          }
          if (existing === undefined) {
            manifest.chunks.push({
              suite,
              ...range,
              sessionId: 'recovered',
              artifact: relative(REPO_ROOT, artifactPath),
              sha256: sha256(bytes),
              bytes: bytes.byteLength,
              completedAt: new Date().toISOString(),
              summary,
            });
            atomicWriteJson(manifestPath, manifest);
          }
          process.stdout.write(`Reused ${suite} ${range.start}:${range.end}\n`);
          continue;
        }
        if (existing !== undefined) {
          throw new Error(
            `Recorded artifact is missing for ${suite} ${range.start}:${range.end}; use a new run id to rerun without erasing historical spend`,
          );
        }

        const spent = manifest.chunks.reduce((total, chunk) => total + chunk.summary.totalCost, 0);
        const rate = costEstimates?.[suite];
        const nextEstimate = rate === undefined ? 0 : (range.end - range.start) * spec.epochs * rate;
        if (spent + nextEstimate > approvedCostUsd) {
          manifest.status = 'budget-stopped';
          manifest.updatedAt = new Date().toISOString();
          atomicWriteJson(manifestPath, manifest);
          await publishRunBundle({ runDir, publishDir });
          process.stdout.write(
            `Stopped before ${suite} ${range.start}:${range.end}: approved cost ceiling reached.\n`,
          );
          releaseLock();
          return;
        }

        mkdirSync(suiteDir, { recursive: true });
        const sessionId = crypto.randomUUID();
        event('chunk-start', { suite, ...range, sessionId });
        process.stdout.write(`Running ${suite} ${range.start}:${range.end}\n`);
        const result = await runBenchmarkById({
          benchmarkId: DATASET_CONTRACTS[suite].benchmarkId,
          apiKey,
          ...(process.env['OPENROUTER_BASE_URL'] !== undefined && {
            baseUrl: process.env['OPENROUTER_BASE_URL'],
          }),
          benchmarkConfig: config,
          ...(ceiling !== undefined && { maxOutputTokensCeiling: ceiling }),
          epochs: spec.epochs,
          maxConcurrency: manifest.effectiveConcurrency,
          range,
          sessionId,
           resultStore: makeDeterministicResultStore(artifactPath),
          progressReporter: makeProgressReporter({
            onSampleStart: (sample) => event('sample-start', { suite, ...sample }),
            onSampleEnd: (sample) => event('sample-end', { suite, ...sample }),
            onAgentStep: (step, sampleId, epoch) =>
              event('agent-step', { suite, sampleId, epoch, ...step }),
          }),
        });
        if (Either.isLeft(result)) {
          throw new Error(`${suite} ${range.start}:${range.end} failed: ${result.left}`);
        }
        if (result.right.resultsPath === null || !existsSync(artifactPath)) {
          throw new Error(`${suite} ${range.start}:${range.end} completed without a persisted artifact`);
        }
        const { summary } = await readChunk(artifactPath, config, expectedRows);
        const bytes = readFileSync(artifactPath);
        const record: RunChunkRecord = {
          suite,
          ...range,
          sessionId,
          artifact: relative(REPO_ROOT, artifactPath),
          sha256: sha256(bytes),
          bytes: statSync(artifactPath).size,
          completedAt: new Date().toISOString(),
          summary,
        };
        manifest.chunks = manifest.chunks.filter(
          (chunk) => !(chunk.suite === suite && chunk.start === range.start && chunk.end === range.end),
        );
        manifest.chunks.push(record);
        manifest.updatedAt = record.completedAt;
        atomicWriteJson(manifestPath, manifest);
        event('chunk-complete', { suite, ...range, cost: summary.totalCost });
        await publishRunBundle({ runDir, publishDir });
        const spentAfterChunk = manifest.chunks.reduce(
          (total, chunk) => total + chunk.summary.totalCost,
          0,
        );
        if (spentAfterChunk >= approvedCostUsd) {
          manifest.status = 'budget-stopped';
          manifest.updatedAt = new Date().toISOString();
          atomicWriteJson(manifestPath, manifest);
          await publishRunBundle({ runDir, publishDir });
          process.stdout.write(
            `Stopped after ${suite} ${range.start}:${range.end}: provider-reported spend reached the approved planning threshold.\n`,
          );
          releaseLock();
          return;
        }
      }
    }
    manifest.status = 'complete';
    manifest.updatedAt = new Date().toISOString();
    atomicWriteJson(manifestPath, manifest);
    await publishRunBundle({ runDir, publishDir });
    const spent = manifest.chunks.reduce((total, chunk) => total + chunk.summary.totalCost, 0);
    process.stdout.write(`Complete. Report: ${relative(REPO_ROOT, join(publishDir, 'report.html'))}\n`);
    process.stdout.write(`Provider-reported cost: $${spent.toFixed(6)}\n`);
    releaseLock();
  } catch (error) {
    manifest.status = 'failed';
    manifest.updatedAt = new Date().toISOString();
    manifest.error = String(error);
    atomicWriteJson(manifestPath, manifest);
    event('run-failed', { error: String(error) });
    await publishRunBundle({ runDir, publishDir });
    releaseLock();
    throw error;
  }
}

if (import.meta.main) {
  await run(parseArgs(process.argv.slice(2)));
}
