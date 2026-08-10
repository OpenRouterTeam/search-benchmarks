#!/usr/bin/env bun
import type { CohortBundle, PublishedSummary, RedactedSample } from './publish-run';
import type { SuiteName } from './run-spec';

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

import { mergeCohortBundles } from './publish-run';
import { sha256 } from './run-spec';

interface MergeArgs {
  readonly original: string;
  readonly incremental: string;
  readonly output: string;
  readonly suites: readonly SuiteName[];
}

function parseArgs(argv: readonly string[]): MergeArgs {
  const value = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index === -1 ? undefined : argv[index + 1];
  };
  const original = value('--original');
  const incremental = value('--incremental');
  const output = value('--output');
  const rawSuites = value('--suites');
  if (original === undefined || incremental === undefined || output === undefined || rawSuites === undefined) {
    throw new Error('Usage: cohort-merge.ts --original DIR --incremental DIR --output DIR --suites browsecomp,dsqa');
  }
  const suites = rawSuites.split(',');
  if (suites.length === 0 || suites.some((suite) => !['browsecomp', 'dsqa', 'widesearch'].includes(suite))) {
    throw new Error('--suites must contain known comma-separated suite names');
  }
  return {
    original: resolve(original),
    incremental: resolve(incremental),
    output: resolve(output),
    suites: suites as SuiteName[],
  };
}

function verifyChecksums(directory: string): string {
  const checksumPath = join(directory, 'checksums.txt');
  const checksumText = readFileSync(checksumPath, 'utf8');
  for (const line of checksumText.trim().split('\n')) {
    const match = /^(?<digest>[a-f0-9]{64})  (?<name>[A-Za-z0-9._-]+)$/u.exec(line);
    if (match?.groups === undefined) {
      throw new Error(`Invalid checksum line in ${checksumPath}`);
    }
    const path = join(directory, match.groups['name']!);
    if (!existsSync(path) || sha256(readFileSync(path)) !== match.groups['digest']) {
      throw new Error(`Checksum mismatch for ${path}`);
    }
  }
  return sha256(checksumText);
}

function readSamples(path: string): RedactedSample[] {
  const text = readFileSync(path, 'utf8').trim();
  return text === '' ? [] : text.split('\n').map((line) => JSON.parse(line) as RedactedSample);
}

function readCohort(label: string, directory: string, suites: readonly SuiteName[]): CohortBundle {
  verifyChecksums(directory);
  const summary = JSON.parse(readFileSync(join(directory, 'summary.json'), 'utf8')) as PublishedSummary;
  const present = Object.keys(summary.suites).toSorted();
  if (JSON.stringify(present) !== JSON.stringify([...suites].toSorted())) {
    throw new Error(`${label} suites do not match the approved merge contract`);
  }
  return {
    label,
    summary,
    samples: readSamples(join(directory, 'samples.redacted.jsonl')),
  };
}

function writeBundle(args: MergeArgs, merged: ReturnType<typeof mergeCohortBundles>): void {
  const staging = `${args.output}.staging-${process.pid}`;
  if (existsSync(args.output)) {
    throw new Error(`Refusing to replace existing cumulative bundle ${args.output}`);
  }
  mkdirSync(staging, { recursive: true });
  try {
    const source = {
      original: {
        directory: basename(args.original),
        checksums_sha256: verifyChecksums(args.original),
      },
      incremental: {
        directory: basename(args.incremental),
        checksums_sha256: verifyChecksums(args.incremental),
      },
      merge: 'offline-only',
      suites: args.suites,
    };
    const files: Record<string, string> = {
      'summary.json': `${JSON.stringify(merged.summary, null, 2)}\n`,
      'samples.redacted.jsonl': merged.samples.map((sample) => JSON.stringify(sample)).join('\n') + '\n',
      'validation.json': `${JSON.stringify(merged.validation, null, 2)}\n`,
      'provenance.json': `${JSON.stringify(source, null, 2)}\n`,
    };
    for (const [name, contents] of Object.entries(files)) {
      writeFileSync(join(staging, name), contents);
    }
    const checksums = Object.keys(files).toSorted()
      .map((name) => `${sha256(readFileSync(join(staging, name)))}  ${name}`)
      .join('\n');
    writeFileSync(join(staging, 'checksums.txt'), `${checksums}\n`);
    mkdirSync(dirname(args.output), { recursive: true });
    renameSync(staging, args.output);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

export function mergeCohortDirectories(args: MergeArgs): void {
  const original = readCohort('original', args.original, args.suites);
  const incremental = readCohort('incremental', args.incremental, args.suites);
  writeBundle(args, mergeCohortBundles(original, incremental));
}

if (import.meta.main) {
  mergeCohortDirectories(parseArgs(process.argv.slice(2)));
}
