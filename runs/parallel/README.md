# Parallel Trajectories

> **Historical provenance:** These trajectories were generated before the canonical harness dependency merged in PR #6. DSQA uses strict Fully Correct accuracy rather than macro F1, and WideSearch uses the `2025-01-01` grading reference date. Preserve the run artifacts byte-for-byte; reruns under current `main` are a different evaluation series.

This directory contains the three complete 100-task Parallel ladder runs used
by the local trajectory viewer:

- `gpt-5.6-sol-parallel-1turn`
- `gpt-5.6-sol-parallel-5turn`
- `gpt-5.6-sol-parallel-25turn`

Open all three from a checkout of the `parallel` branch:

```bash
git clone --depth 1 --single-branch --branch parallel \
  https://github.com/OpenRouterTeam/search-benchmarks.git
cd search-benchmarks/apps/trajectories
bun install
bun run web -- --input ../../runs/parallel --open
```

These files contain raw benchmark inputs, targets, answers, search activity,
and grader output. Keep them within the repository's intended access boundary;
use `published-runs/parallel/` for redacted sharing.
