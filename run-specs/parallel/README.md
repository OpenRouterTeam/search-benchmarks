# GPT-5.6 Sol Parallel Ladder

These specs define the historical 1-, 5-, and 25-turn Parallel runs plus their one-task calibrations. The checked-in result bundles predate PR #6; rerunning these specs now uses the canonical harness and produces a new evaluation series.

Run the benchmark runner from `apps/search-bench-runner`:

```bash
bun run bench -- --spec ../../run-specs/parallel/<name>.toml --run-id <slug> --dry-run
```
