/**
 * Thin Zod helpers used throughout the standalone harness.
 */

import type { ZodError, ZodType } from 'zod';

import { z } from 'zod';

import { Either } from './either';

export { z };

export type ZodShape<T> = {
  [key in keyof T]: ZodType<T[key]>;
};

/** Parse `value` against `schema`, returning an `Either` instead of throwing. */
export function parseSchema<Input, Output>(
  schema: ZodType<Output, Input>,
  value: unknown,
): Either.Either<Output, ZodError> {
  const ret = schema.safeParse(value);
  if (!ret.success) {
    return Either.left(ret.error);
  }
  return Either.right(ret.data);
}

/** Format the first Zod issue as `path: message` (or the raw message). */
export function firstZodIssueMessage(error: ZodError): string {
  const issue = error.issues[0];
  if (!issue) {
    return error.message;
  }
  const path = issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
  return `${path}${issue.message}`;
}

export function zInt(): z.ZodNumber {
  return z.number().int();
}
