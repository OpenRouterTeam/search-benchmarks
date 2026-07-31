import type { Dataset } from '../dataset';
import type { RetryConfig } from '../retry';
import type { RunResult } from '../run';
import type { Scorer } from '../scorer';
import type { Solver } from '../solver';
import type { BenchmarkRunConfig } from './benchmark-config';
import type { HttpClient } from '@effect/platform';
import type { Layer } from 'effect/Layer';

export interface BenchmarkRunInput {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly benchmarkConfig: BenchmarkRunConfig;
  readonly sessionId: string;
  readonly datasetRetry?: RetryConfig;
  readonly modelRetry?: RetryConfig;
  /**
   * The model's advertised output-token ceiling. Deliberately separate from
   * `benchmarkConfig`: that object is persisted verbatim as the parquet
   * `benchmark_config` column and re-derived from the spec at publish time to
   * validate artifacts, so a runtime-resolved value must not enter it. The
   * effective budget is recorded in the `request_body` column instead.
   */
  readonly maxOutputTokensCeiling?: number;
}

export interface BenchmarkPrimaryScore {
  readonly value: number;
  readonly weight: number;
}

export interface Benchmark {
  readonly id: string;
  readonly makeDatasetLayer: (retryConfig?: RetryConfig) => Layer<Dataset>;
  readonly makeLayer: (
    input: BenchmarkRunInput,
  ) => Layer<Dataset | Solver | Scorer, Error, HttpClient.HttpClient>;
  readonly temperature: number;
  readonly defaultEpochs: number;
  readonly runLevelScores?: (result: RunResult) => readonly {
    readonly name: string;
    readonly metrics: Readonly<Record<string, { readonly value: number }>>;
  }[];
  readonly primaryScore?: (result: RunResult) => BenchmarkPrimaryScore | undefined;
}
