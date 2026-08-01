/**
 * Effect `Either` surface for the bench-harness. The harness models synchronous
 * fallible values as `Either.Either<A, E>` and async fallible values as
 * `AsyncEither<A, E>`. This module is the single place
 * the harness reaches into `effect/Either`, so every other file imports the
 * `Either` namespace from here.
 */

import type { Either as EitherType } from 'effect/Either';

import { left, right } from 'effect/Either';

export * as Either from 'effect/Either';

/** A promise of an `Either` — the async analogue of `Either.Either`. */
export type AsyncEither<A, E = unknown> = Promise<EitherType<A, E>>;

/**
 * Run an async thunk and capture success/failure as an `Either`, mirroring
 * `Either.try` for promises. The thrown value becomes the `Left`.
 */
export async function tryPromiseEither<A>(thunk: () => Promise<A>): AsyncEither<A> {
  try {
    return right(await thunk());
  } catch (error) {
    return left(error);
  }
}
