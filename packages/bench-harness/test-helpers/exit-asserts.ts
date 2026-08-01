import type { Exit, Failure, Success } from 'effect/Exit';

import assert from 'node:assert';

import { isFailure, isSuccess } from 'effect/Exit';

/**
 * Assert an {@link Exit} is a {@link Success} and narrow its type so subsequent
 * `exit.value` reads typecheck. Kept as a single un-nested call so it does not
 * trip the `missedPipeableOpportunity` diagnostic that `assert(isSuccess(exit))`
 * would (whose pipeable form `exit.pipe(isSuccess, assert)` loses the
 * `asserts exit is Success` narrowing that makes `exit.value` reachable).
 */
export function assertSuccess<A, E>(exit: Exit<A, E>): asserts exit is Success<A, E> {
  if (isSuccess(exit)) {
    return;
  }
  assert.fail('expected Exit to be Success');
}

/**
 * Symmetric to {@link assertSuccess}: assert an {@link Exit} is a {@link Failure}
 * and narrow its type so subsequent `exit.cause` / `exit.error` reads typecheck.
 */
export function assertFailure<A, E>(exit: Exit<A, E>): asserts exit is Failure<A, E> {
  if (isFailure(exit)) {
    return;
  }
  assert.fail('expected Exit to be Failure');
}
