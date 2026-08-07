#!/usr/bin/env bun
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

interface UpstreamRecord {
  readonly repository: string;
  readonly commit: string;
  readonly tree: string;
}

function git(args: readonly string[], cwd: string): string {
  const result = spawnSync('git', [...args], { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `git ${args.join(' ')} failed`);
  }
  return result.stdout.trim();
}

const root = git(['rev-parse', '--show-toplevel'], process.cwd());
const record = JSON.parse(
  readFileSync(join(root, 'packages', 'bench-harness.upstream.json'), 'utf8'),
) as UpstreamRecord;

if (spawnSync('git', ['diff', '--quiet', '--', 'packages/bench-harness'], { cwd: root }).status !== 0) {
  throw new Error('Vendored benchmark-harness has unstaged changes');
}

const indexTree = git(['write-tree'], root);
const vendoredTree = git(['rev-parse', `${indexTree}:packages/bench-harness`], root);
if (vendoredTree !== record.tree) {
  throw new Error(`Vendored tree ${vendoredTree} does not match recorded tree ${record.tree}`);
}

git(['fetch', '--no-tags', record.repository, record.commit], root);
const upstreamTree = git(['rev-parse', 'FETCH_HEAD^{tree}'], root);
if (upstreamTree !== record.tree) {
  throw new Error(`Upstream tree ${upstreamTree} does not match recorded tree ${record.tree}`);
}

process.stdout.write(`benchmark-harness ${record.commit} verified at tree ${record.tree}\n`);
