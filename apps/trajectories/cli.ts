#!/usr/bin/env bun
import { resolve } from 'node:path';

import { TrajectoryStore } from './reader';

function option(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
}

/** Repeatable flag values, e.g. `--exclude calibration --exclude smoke`. */
function optionList(argv: readonly string[], name: string): string[] {
  return argv.flatMap((arg, index) => (arg === name && argv[index + 1] ? [argv[index + 1]!] : []));
}

function printTable(store: TrajectoryStore, runFilter: string | undefined): void {
  const index = store.index();
  process.stdout.write(`Input: ${index.input}\n\n`);

  const runs = index.runs.filter((run) => runFilter === undefined || run.id === runFilter);
  if (runs.length === 0) {
    throw new Error(`Unknown run: ${runFilter}`);
  }

  for (const run of runs) {
    const accuracy = run.tasks === 0 ? 0 : run.correctAnswers / run.tasks;
    process.stdout.write(
      `${run.id}  [${run.status ?? 'unknown'}]  chunks=${run.chunks} tasks=${run.tasks} accuracy=${accuracy.toFixed(3)} cost=$${run.totalCost.toFixed(6)}\n`,
    );
    for (const file of index.files.filter((item) => item.run === run.id)) {
      const primary = file.primaryScore as { value?: number } | undefined;
      const score = typeof primary?.value === 'number' ? primary.value : file.accuracy;
      process.stdout.write(
        `    ${file.task.padEnd(20)} score=${score.toFixed(4)} tasks=${file.correctAnswers}/${file.totalQuestions} cost=$${file.totalCost.toFixed(6)} ${file.file}\n`,
      );
    }
    process.stdout.write('\n');
  }

  process.stdout.write('Samples:\n');
  for (const sample of index.samples.filter((item) => runFilter === undefined || item.run === runFilter)) {
    process.stdout.write(
      `${sample.score}  ${sample.task.replace(/^search_/u, '').padEnd(11)} searches=${String(sample.searchCalls).padStart(2)}/${String(sample.searchAttempts).padStart(2)} sources=${String(sample.uniqueCitations).padStart(3)}  ${sample.sampleId.padEnd(18)} ${sample.id}\n`,
    );
  }
}

async function main(argv: readonly string[]): Promise<void> {
  const input = option(argv, '--input') ?? argv.find((arg) => !arg.startsWith('--'));
  if (input === undefined) {
    throw new Error(
      'Usage: bun run cli.ts --input <parquet-or-runs-dir> [--run <id>] [--sample <id>] [--id <row-id>] [--json] [--exclude <substring>]',
    );
  }
  const store = await TrajectoryStore.load(resolve(input), {
    excludeRuns: optionList(argv, '--exclude'),
  });
  process.stderr.write('Warning: raw trajectories may contain benchmark targets and judge output.\n');

  const sampleId = option(argv, '--sample');
  const rowId = option(argv, '--id');
  const runFilter = option(argv, '--run');

  if (sampleId !== undefined) {
    const samples = store
      .findSamples(sampleId)
      .filter((sample) => runFilter === undefined || sample.run === runFilter);
    process.stdout.write(`${JSON.stringify(samples, null, 2)}\n`);
    return;
  }
  if (rowId !== undefined) {
    const sample = store.sample(rowId);
    if (sample === undefined) {
      throw new Error(`Unknown row id: ${rowId}`);
    }
    process.stdout.write(`${JSON.stringify(sample, null, 2)}\n`);
    return;
  }
  if (argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(store.index(), null, 2)}\n`);
    return;
  }
  printTable(store, runFilter);
}

await main(process.argv.slice(2));
