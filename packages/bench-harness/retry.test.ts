import { describe, expect, it } from 'bun:test';

import { fail, retry, runPromise, runPromiseExit, succeed, suspend } from 'effect/Effect';

import { ModelError, SolverError } from './core';
import { rateLimitRetrySchedule } from './retry';
import { assertFailure } from './test-helpers/exit-asserts';

// Zero base delay so retries don't actually sleep in tests.
const schedule = rateLimitRetrySchedule({ maxRetries: 5, baseDelayMs: 0 });
const rateLimit = new ModelError({ status: 429, message: '429' });
const serverError = new ModelError({ status: 503, message: '503' });
const clientError = new ModelError({ status: 400, message: '400' });

describe('rateLimitRetrySchedule', () => {
  it('retries 429s until the effect succeeds', async () => {
    let attempts = 0;
    const flaky = suspend(() => {
      attempts++;
      return attempts < 3 ? fail(rateLimit) : succeed(attempts);
    });
    const result = await runPromise(flaky.pipe(retry(schedule)));
    expect(result).toBe(3); // succeeds on the 3rd attempt (2 retries)
  });

  it('retries transient 5xx errors', async () => {
    let attempts = 0;
    const flaky = suspend(() => {
      attempts++;
      return attempts < 3 ? fail(serverError) : succeed(attempts);
    });
    const result = await runPromise(flaky.pipe(retry(schedule)));
    expect(result).toBe(3);
  });

  it('does not retry non-retryable 4xx (other than 429)', async () => {
    let attempts = 0;
    const program = suspend(() => {
      attempts++;
      return fail(clientError);
    }).pipe(retry(schedule));

    const exit = await runPromiseExit(program);
    assertFailure(exit);
    expect(attempts).toBe(1); // 400 is not transient — stop immediately
  });

  it('does not retry SolverError', async () => {
    let attempts = 0;
    const program = suspend(() => {
      attempts++;
      return fail(new SolverError({ message: 'boom' }));
    }).pipe(retry(schedule));

    const exit = await runPromiseExit(program);
    assertFailure(exit);
    expect(attempts).toBe(1);
  });

  it('gives up after maxRetries consecutive errors', async () => {
    let attempts = 0;
    const program = suspend(() => {
      attempts++;
      return fail(rateLimit);
    }).pipe(retry(rateLimitRetrySchedule({ maxRetries: 2, baseDelayMs: 0 })));

    const exit = await runPromiseExit(program);
    assertFailure(exit);
    expect(attempts).toBe(3); // 1 initial + 2 retries
  });
});
