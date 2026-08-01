/**
 * Test-only assertion helpers for Effect `Either` values.
 */

import { Either } from './either';

/** Assert `e` is a `Right`, narrowing it so `.right` is accessible. */
export function assertRight<A, E>(e: Either.Either<A, E>): asserts e is Either.Right<E, A> {
  if (Either.isLeft(e)) {
    throw new Error(`Expected Right, got Left: ${JSON.stringify(e.left)}`);
  }
}

/** Assert `e` is a `Left`, narrowing it so `.left` is accessible. */
export function assertLeft<A, E>(e: Either.Either<A, E>): asserts e is Either.Left<E, A> {
  if (Either.isRight(e)) {
    throw new Error(`Expected Left, got Right: ${JSON.stringify(e.right)}`);
  }
}
