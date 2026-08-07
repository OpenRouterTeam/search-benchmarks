import type { ResultStoreService } from '@openrouter/bench-harness/result-store';

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { modelFromConfig } from '@openrouter/bench-harness/benchmarks/benchmark-config';
import { runResultToParquet } from '@openrouter/bench-harness/parquet';
import { succeed } from 'effect/Effect';

export function makeDeterministicResultStore(path: string): ResultStoreService {
  return {
    write: ({ result, benchmark, benchmarkConfig, epochs }) => {
      const extraScores = benchmark.runLevelScores?.(result);
      const primaryScore = benchmark.primaryScore?.(result);
      const bytes = runResultToParquet({
        result,
        meta: {
          task: benchmarkConfig.benchmarkId,
          model: modelFromConfig(benchmarkConfig) ?? benchmarkConfig.benchmarkId,
          epochs,
          temperature: benchmark.temperature,
          benchmarkConfig,
        },
        ...(extraScores !== undefined && { extraScores }),
        ...(primaryScore !== undefined && { primaryScore }),
      });
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, bytes);
      return succeed(path);
    },
  };
}
