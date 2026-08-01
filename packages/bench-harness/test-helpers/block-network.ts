/**
 * Replace `globalThis.fetch` with a stub that rejects every request, then
 * return a restore function. Used by tests that dispatch a benchmark end-to-end
 * but must not touch the network (e.g. the HF Dataset Viewer): the dataset
 * fetch fails fast and the run resolves to a `Result` error, keeping the test
 * hermetic and instant instead of hanging on a real round-trip.
 */
export function blockNetwork(): () => void {
  const original = globalThis.fetch;
  const stub: typeof fetch = (input) => {
    const url = input instanceof Request ? input.url : String(input);
    return Promise.reject(new Error(`network disabled in test: ${url}`));
  };
  globalThis.fetch = stub;
  return () => {
    globalThis.fetch = original;
  };
}
