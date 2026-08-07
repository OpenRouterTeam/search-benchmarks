# Search Benchmark Runner Review Checklist

- Preserve full Responses output items, judge trajectories, answers, and usage
  in Parquet. Do not truncate evidence used to justify a score.
- Keep the `@openrouter/bench-harness` dependency pinned to an immutable merged
  upstream commit; benchmark behavior changes land upstream first.
- Preserve dry-run, measured-cost, explicit-approval, and chunk budget gates.
- Depend only on public `@openrouter/bench-harness` exports.
- Keep manifests sensitive to the campaign code and pinned dependency lock.
- Validate specs, resumable chunks, checksums, and publication redaction.
