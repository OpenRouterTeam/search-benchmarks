#!/usr/bin/env bun
import type { ServerResponse } from 'node:http';

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';

import { TrajectoryStore } from './reader';

const UI_DIR = join(import.meta.dirname, 'ui');

/** Static asset allowlist: no request path ever reaches the filesystem directly. */
const ASSETS = new Map<string, { readonly file: string; readonly type: string }>([
  ['/', { file: 'index.html', type: 'text/html; charset=utf-8' }],
  ['/app.css', { file: 'app.css', type: 'text/css; charset=utf-8' }],
  ['/app.js', { file: 'app.js', type: 'text/javascript; charset=utf-8' }],
]);

const SECURITY_HEADERS = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'content-security-policy':
    "default-src 'none'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'",
} as const;

function option(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
}

/** Repeatable flag values, e.g. `--exclude calibration --exclude smoke`. */
function optionList(argv: readonly string[], name: string): string[] {
  return argv.flatMap((arg, index) => (arg === name && argv[index + 1] ? [argv[index + 1]!] : []));
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { ...SECURITY_HEADERS, 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
}

function sendAsset(response: ServerResponse, asset: { file: string; type: string }): void {
  /* Read per request so UI edits appear on refresh without restarting the server. */
  response.writeHead(200, { ...SECURITY_HEADERS, 'content-type': asset.type });
  response.end(readFileSync(join(UI_DIR, asset.file)));
}

async function main(argv: readonly string[]): Promise<void> {
  const input = option(argv, '--input') ?? argv.find((arg) => !arg.startsWith('--'));
  if (input === undefined) {
    throw new Error('Usage: bun run web.ts --input <parquet-or-run-dir> [--port 4177] [--open] [--exclude <substring>]');
  }
  const port = Number(option(argv, '--port') ?? 4177);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('--port must be an integer between 1 and 65535');
  }
  const store = await TrajectoryStore.load(resolve(input), {
    excludeRuns: optionList(argv, '--exclude'),
  });

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`);
    if (request.method !== 'GET') {
      sendJson(response, 405, { error: 'method not allowed' });
      return;
    }
    if (url.pathname === '/api/index') {
      /* Re-scan so chunks written by a live run appear on refresh. */
      void store
        .refresh()
        .catch(() => false)
        .then(() => sendJson(response, 200, store.index()));
      return;
    }
    if (url.pathname === '/api/sample') {
      const id = url.searchParams.get('id');
      const sample = id === null ? undefined : store.sample(id);
      sendJson(response, sample === undefined ? 404 : 200, sample ?? { error: 'sample not found' });
      return;
    }
    const asset = ASSETS.get(url.pathname);
    if (asset !== undefined) {
      sendAsset(response, asset);
      return;
    }
    sendJson(response, 404, { error: 'not found' });
  });

  server.listen(port, '127.0.0.1');
  const address = `http://127.0.0.1:${port}`;
  process.stdout.write(`Trajectory reader: ${address}\nInput: ${resolve(input)}\n`);
  if (argv.includes('--open')) {
    spawn('open', [address], { stdio: 'ignore', detached: true }).unref();
  }
}

await main(process.argv.slice(2));
