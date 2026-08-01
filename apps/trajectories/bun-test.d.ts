declare module 'bun:test' {
  type TestFunction = () => void | Promise<void>;
  interface Test {
    (name: string, test: TestFunction, timeout?: number): void;
  }
  interface Expect {
    (actual: unknown, message?: string): any;
  }
  export const describe: (name: string, suite: () => void) => void;
  export const expect: Expect;
  export const it: Test;
  export const afterEach: (fn: TestFunction, timeout?: number) => void;
}
