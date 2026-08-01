/* oxlint-disable no-console -- standalone commands log to the console. */

/**
 * Minimal structured logging helpers.
 */

type LogContext = Record<string, unknown>;

export function iLog(message: string, context?: LogContext): void {
  console.info(message, context ?? {});
}

export function wLog(message: string, context?: LogContext): void {
  console.warn(message, context ?? {});
}

export function eLog(message: string, context?: LogContext): void {
  console.error(message, context ?? {});
}
