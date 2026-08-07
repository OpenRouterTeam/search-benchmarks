# Search Campaign Review Checklist

- Preserve full Responses output items, judge trajectories, answers, and usage
  in Parquet. Do not truncate evidence used to justify a score.
- Keep `packages/bench-harness` byte-identical to its recorded upstream tree;
  benchmark behavior changes land upstream first.
- Preserve dry-run, measured-cost, explicit-approval, and chunk budget gates.
- Depend only on public `@openrouter/bench-harness` exports.
- Keep manifests sensitive to changes in both this campaign app and the vendored
  harness.
- Validate specs, resumable chunks, checksums, and publication redaction.
