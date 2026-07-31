import type { BenchmarkResultRow } from '@openrouter/bench-harness/parquet-schema';

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';

import { asyncBufferFromBytes, readResultRows } from '@openrouter/bench-harness/parquet';

export interface TrajectoryRunSummary {
  readonly id: string;
  readonly title: string | null;
  readonly status: string | null;
  readonly suites: readonly string[];
  readonly chunks: number;
  readonly tasks: number;
  readonly correctAnswers: number;
  readonly totalCost: number;
  readonly totalTokens: number;
}

export interface TrajectoryFileSummary {
  readonly run: string;
  readonly file: string;
  readonly task: string;
  readonly model: string;
  readonly createdAt: string;
  readonly accuracy: number;
  readonly totalQuestions: number;
  readonly correctAnswers: number;
  readonly totalCost: number;
  readonly totalTokens: number;
  readonly primaryScore: unknown;
  readonly extraScores: unknown;
  readonly benchmarkConfig: unknown;
}

export interface TrajectorySampleSummary {
  /** Stable identity across reloads: run, chunk file, sample, and epoch. */
  readonly id: string;
  readonly run: string;
  readonly file: string;
  readonly task: string;
  readonly sampleId: string;
  readonly epoch: number;
  readonly score: string;
  readonly answerPreview: string;
  readonly searchAttempts: number;
  readonly searchCalls: number;
  readonly citations: number;
  readonly uniqueCitations: number;
  /** WideSearch per-item F1 (the suite's primary metric); null elsewhere. */
  readonly itemF1: number | null;
  readonly rowF1: number | null;
  readonly successRate: number | null;
}

export interface TrajectorySampleDetail extends TrajectorySampleSummary {
  readonly input: string | null;
  readonly target: string | null;
  readonly answer: string | null;
  readonly explanation: string | null;
  readonly scorerTrajectory: unknown;
  readonly responseItems: unknown;
  /** The request body actually built for this sample; undefined on pre-column runs. */
  readonly requestBody: unknown;
  readonly messages: unknown;
  readonly metadata: unknown;
  readonly generationIds: unknown;
  readonly benchmarkConfig: unknown;
}

export interface TrajectoryIndex {
  readonly input: string;
  /** ISO timestamp of the last successful data reload. */
  readonly updatedAt: string;
  readonly runs: readonly TrajectoryRunSummary[];
  readonly files: readonly TrajectoryFileSummary[];
  readonly samples: readonly TrajectorySampleSummary[];
}

interface CachedFile {
  readonly path: string;
  readonly run: string;
  readonly file: string;
  readonly mtimeMs: number;
  readonly size: number;
  readonly rows: readonly BenchmarkResultRow[];
}

function parseJson(raw: string | null | undefined): unknown {
  if (raw === null || raw === undefined) {
    return undefined;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return { parse_error: true, raw };
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function searchCallCounts(raw: string | null | undefined): {
  readonly attempts: number;
  readonly executions: number;
} {
  const items = parseJson(raw);
  if (!Array.isArray(items)) {
    return { attempts: 0, executions: 0 };
  }
  const calls = items.filter((item) => {
    const type = record(item)?.['type'];
    return type === 'web_search_call' || type === 'openrouter:web_search';
  });
  return {
    attempts: calls.length,
    executions: calls.filter((item) => {
      const action = record(record(item)?.['action']);
      return Array.isArray(action?.['sources']) && action['sources'].length > 0;
    }).length,
  };
}

/*
 * WideSearch grades a filled table, so a strict correct/incorrect verdict throws
 * away most of the signal: an answer can be 90% right and still score I. The
 * suite's primary metric is `f1_by_item`, recorded per sample by the grader.
 */
function widesearchMetrics(raw: string | null | undefined): {
  readonly itemF1: number | null;
  readonly rowF1: number | null;
  readonly successRate: number | null;
} {
  const trajectory = record(parseJson(raw));
  const runs = trajectory?.['runs'];
  const empty = { itemF1: null, rowF1: null, successRate: null };
  if (!Array.isArray(runs)) {
    return empty;
  }
  const grade = runs.find((item) => record(item)?.['kind'] === 'widesearch_grade');
  const metrics = record(record(grade)?.['metrics']);
  if (metrics === undefined) {
    return empty;
  }
  const number = (key: string): number | null =>
    typeof metrics[key] === 'number' ? (metrics[key] as number) : null;
  return {
    itemF1: number('f1_by_item'),
    rowF1: number('f1_by_row'),
    successRate: number('success_rate'),
  };
}

function citationCounts(raw: string | null | undefined): {
  readonly total: number;
  readonly unique: number;
} {
  const metadata = record(parseJson(raw));
  const search = record(metadata?.['search']);
  const citations = search?.['citations'];
  if (!Array.isArray(citations)) {
    return { total: 0, unique: 0 };
  }
  const urls = citations.flatMap((item) => {
    const citation = record(item);
    return typeof citation?.['url'] === 'string' ? [citation['url']] : [];
  });
  return { total: citations.length, unique: new Set(urls).size };
}

export function discoverParquetFiles(input: string): readonly string[] {
  const absolute = resolve(input);
  const stats = statSync(absolute);
  if (stats.isFile()) {
    if (extname(absolute) !== '.parquet') {
      throw new Error(`Expected a .parquet file: ${absolute}`);
    }
    return [absolute];
  }
  if (!stats.isDirectory()) {
    throw new Error(`Input is neither a file nor directory: ${absolute}`);
  }
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        visit(path);
      } else if (entry.isFile() && extname(entry.name) === '.parquet') {
        files.push(path);
      }
    }
  };
  visit(absolute);
  files.sort();
  if (files.length === 0) {
    throw new Error(`No Parquet files found under ${absolute}`);
  }
  return files;
}

/**
 * A run directory is the nearest ancestor holding `manifest.json`, so a single
 * run directory, a directory of runs, and a bare `.parquet` file all resolve.
 */
function findRunDirectory(fileDirectory: string, inputRoot: string): string | undefined {
  let current = fileDirectory;
  for (;;) {
    if (existsSync(join(current, 'manifest.json'))) {
      return current;
    }
    if (current === inputRoot || current === dirname(current)) {
      return undefined;
    }
    current = dirname(current);
  }
}

export interface TrajectoryStoreOptions {
  /** Case-insensitive substrings; matching runs are omitted entirely. */
  readonly excludeRuns?: readonly string[];
}

export class TrajectoryStore {
  readonly #input: string;
  readonly #inputIsDirectory: boolean;
  readonly #excludeRuns: readonly string[];
  readonly #cache = new Map<string, CachedFile>();
  #manifests = new Map<string, { title: string | null; status: string | null }>();
  #files: readonly TrajectoryFileSummary[] = [];
  #runs: readonly TrajectoryRunSummary[] = [];
  #samples: readonly TrajectorySampleSummary[] = [];
  #details = new Map<string, { run: string; file: string; row: BenchmarkResultRow }>();
  #updatedAt = new Date(0).toISOString();
  #checkedAt = 0;

  private constructor(
    input: string,
    inputIsDirectory: boolean,
    excludeRuns: readonly string[],
  ) {
    this.#input = input;
    this.#inputIsDirectory = inputIsDirectory;
    this.#excludeRuns = excludeRuns.map((pattern) => pattern.toLowerCase());
  }

  static async load(input: string, options: TrajectoryStoreOptions = {}): Promise<TrajectoryStore> {
    const absoluteInput = resolve(input);
    const store = new TrajectoryStore(
      absoluteInput,
      statSync(absoluteInput).isDirectory(),
      options.excludeRuns ?? [],
    );
    await store.refresh(0);
    if (store.index().samples.length === 0) {
      throw new Error(`Parquet input has no result rows: ${absoluteInput}`);
    }
    return store;
  }

  /**
   * Reload changed or new chunk files so a live benchmark run appears without a
   * restart. `maxAgeMs` throttles filesystem checks for bursty request patterns.
   */
  async refresh(maxAgeMs = 2000): Promise<boolean> {
    const now = Date.now();
    if (maxAgeMs > 0 && now - this.#checkedAt < maxAgeMs) {
      return false;
    }
    this.#checkedAt = now;

    let paths: readonly string[];
    try {
      paths = discoverParquetFiles(this.#input);
    } catch {
      return false;
    }

    let changed = false;
    const included = paths.filter((path) => !this.#isExcluded(this.#runIdFor(path)));
    for (const path of included) {
      const stats = statSync(path);
      const cached = this.#cache.get(path);
      if (cached !== undefined && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) {
        continue;
      }
      const rows = await readResultRows(asyncBufferFromBytes(readFileSync(path)));
      if (rows.length === 0) {
        continue;
      }
      const runDirectory = findRunDirectory(dirname(path), this.#input);
      const run = this.#runIdFor(path);
      const file =
        runDirectory === undefined
          ? this.#inputIsDirectory
            ? relative(this.#input, path)
            : basename(path)
          : relative(runDirectory, path);
      this.#cache.set(path, { path, run, file, mtimeMs: stats.mtimeMs, size: stats.size, rows });
      changed = true;
    }

    const known = new Set(included);
    for (const path of [...this.#cache.keys()]) {
      if (!known.has(path)) {
        this.#cache.delete(path);
        changed = true;
      }
    }

    const manifests = this.#readManifests(included);
    if (JSON.stringify([...manifests]) !== JSON.stringify([...this.#manifests])) {
      this.#manifests = manifests;
      changed = true;
    }

    if (changed) {
      this.#rebuild();
      this.#updatedAt = new Date(now).toISOString();
    }
    return changed;
  }

  #runIdFor(path: string): string {
    const runDirectory = findRunDirectory(dirname(path), this.#input);
    if (runDirectory !== undefined) {
      return basename(runDirectory);
    }
    return this.#inputIsDirectory ? basename(this.#input) : basename(path, '.parquet');
  }

  #isExcluded(run: string): boolean {
    const id = run.toLowerCase();
    return this.#excludeRuns.some((pattern) => id.includes(pattern));
  }

  #readManifests(paths: readonly string[]): Map<string, { title: string | null; status: string | null }> {
    const manifests = new Map<string, { title: string | null; status: string | null }>();
    for (const path of paths) {
      const runDirectory = findRunDirectory(dirname(path), this.#input);
      if (runDirectory === undefined) {
        continue;
      }
      const run = basename(runDirectory);
      if (manifests.has(run)) {
        continue;
      }
      const manifest = record(parseJson(readFileSync(join(runDirectory, 'manifest.json'), 'utf8')));
      manifests.set(run, {
        title: typeof manifest?.['title'] === 'string' ? manifest['title'] : null,
        status: typeof manifest?.['status'] === 'string' ? manifest['status'] : null,
      });
    }
    return manifests;
  }

  #rebuild(): void {
    const cached = [...this.#cache.values()].toSorted((left, right) =>
      left.path.localeCompare(right.path),
    );

    this.#files = cached.flatMap((entry) => {
      const first = entry.rows[0];
      if (first === undefined) {
        return [];
      }
      return [
        {
          run: entry.run,
          file: entry.file,
          task: first.task,
          model: first.model,
          createdAt: first.created_at,
          accuracy: first.accuracy,
          totalQuestions: first.total_questions,
          correctAnswers: first.correct_answers,
          totalCost: first.total_cost,
          totalTokens: first.total_tokens,
          primaryScore: parseJson(first.primary_score),
          extraScores: parseJson(first.extra_scores),
          benchmarkConfig: parseJson(first.benchmark_config),
        },
      ];
    });

    this.#runs = [...new Set(this.#files.map((file) => file.run))].toSorted().map((id) => {
      const runFiles = this.#files.filter((file) => file.run === id);
      const manifest = this.#manifests.get(id);
      return {
        id,
        title: manifest?.title ?? null,
        status: manifest?.status ?? null,
        suites: [...new Set(runFiles.map((file) => file.task))].toSorted(),
        chunks: runFiles.length,
        tasks: runFiles.reduce((total, file) => total + file.totalQuestions, 0),
        correctAnswers: runFiles.reduce((total, file) => total + file.correctAnswers, 0),
        totalCost: runFiles.reduce((total, file) => total + file.totalCost, 0),
        totalTokens: runFiles.reduce((total, file) => total + file.totalTokens, 0),
      };
    });

    const samples: TrajectorySampleSummary[] = [];
    const details = new Map<string, { run: string; file: string; row: BenchmarkResultRow }>();
    for (const entry of cached) {
      for (const row of entry.rows) {
        const id = `${entry.run}::${entry.file}::${row.sample_id}::${row.epoch}`;
        const search = searchCallCounts(row.response_items);
        const citations = citationCounts(row.metadata);
        const widesearch = widesearchMetrics(row.scorer_trajectory);
        samples.push({
          id,
          run: entry.run,
          file: entry.file,
          task: row.task,
          sampleId: row.sample_id,
          epoch: row.epoch,
          score: row.score_value,
          answerPreview:
            row.answer === null ? '' : row.answer.replaceAll(/\s+/gu, ' ').slice(0, 180),
          searchAttempts: search.attempts,
          searchCalls: search.executions,
          citations: citations.total,
          uniqueCitations: citations.unique,
          itemF1: widesearch.itemF1,
          rowF1: widesearch.rowF1,
          successRate: widesearch.successRate,
        });
        details.set(id, { run: entry.run, file: entry.file, row });
      }
    }
    this.#samples = samples;
    this.#details = details;
  }

  index(): TrajectoryIndex {
    return {
      input: this.#input,
      updatedAt: this.#updatedAt,
      runs: this.#runs,
      files: this.#files,
      samples: this.#samples,
    };
  }

  sample(id: string): TrajectorySampleDetail | undefined {
    const detail = this.#details.get(id);
    const summary = this.#samples.find((item) => item.id === id);
    if (detail === undefined || summary === undefined) {
      return undefined;
    }
    const { row } = detail;
    return {
      ...summary,
      input: row.input,
      target: row.target,
      answer: row.answer,
      explanation: row.explanation,
      scorerTrajectory: parseJson(row.scorer_trajectory),
      responseItems: parseJson(row.response_items),
      requestBody: parseJson(row.request_body),
      messages: parseJson(row.messages),
      metadata: parseJson(row.metadata),
      generationIds: parseJson(row.generation_ids),
      benchmarkConfig: parseJson(row.benchmark_config),
    };
  }

  findSamples(sampleId: string): readonly TrajectorySampleDetail[] {
    return this.#samples
      .filter((sample) => sample.sampleId === sampleId)
      .map((sample) => this.sample(sample.id)!)
      .filter((sample) => sample !== undefined);
  }
}
