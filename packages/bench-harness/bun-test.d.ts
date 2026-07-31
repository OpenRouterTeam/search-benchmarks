declare module 'bun:test' {
  type TestFunction = () => void | Promise<void>;
  interface Test {
    (name: string, test: TestFunction, timeout?: number): void;
    each: <T extends readonly unknown[]>(
      cases: readonly T[],
    ) => (name: string, test: (...args: T) => void | Promise<void>, timeout?: number) => void;
  }
  interface Describe {
    (name: string, suite: () => void): void;
    each: <T extends readonly unknown[]>(
      cases: readonly T[],
    ) => (name: string, suite: (...args: T) => void | Promise<void>) => void;
  }
  interface Expect {
    (actual: unknown, message?: string): any;
    objectContaining(expected: Record<string, unknown>): unknown;
    arrayContaining(expected: readonly unknown[]): unknown;
    stringContaining(expected: string): unknown;
    anything(): unknown;
  }
  export const describe: Describe;
  export const expect: Expect;
  export const it: Test;
  export const beforeAll: (fn: TestFunction, timeout?: number) => void;
  export const afterEach: (fn: TestFunction, timeout?: number) => void;
}
