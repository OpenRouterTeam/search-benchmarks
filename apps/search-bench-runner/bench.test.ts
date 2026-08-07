import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { acquireRunLock } from './bench';

let temporary: string | undefined;

afterEach(() => {
  if (temporary !== undefined) {
    rmSync(temporary, { recursive: true, force: true });
    temporary = undefined;
  }
});

describe('run locking', () => {
  it('prevents concurrent writers and releases cleanly', () => {
    temporary = mkdtempSync(join(tmpdir(), 'bench-lock-'));
    const path = join(temporary, '.run.lock');
    const release = acquireRunLock(path);
    expect(() => acquireRunLock(path)).toThrow('Run is already active');
    release();
    const releaseAgain = acquireRunLock(path);
    releaseAgain();
  });
});
