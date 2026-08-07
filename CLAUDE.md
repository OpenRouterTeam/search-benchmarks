# OpenRouter search benchmarks - agent notes

This repository vendors the canonical TypeScript benchmark harness and adds a
search campaign runner plus local trajectory viewer. It supports BrowseComp,
DeepSearchQA, and WideSearch through the public OpenRouter Responses API.

All benchmark runs make paid API calls. Never start one without explicit user
approval of both scale and cost. Tests, typechecks, publication from existing
artifacts, and `--dry-run` do not make paid inference calls.

## Commands

```bash
cd apps/search-campaign
bun install
bun run typecheck
bun test
bun run bench -- --spec ../../run-specs/<engine>/<spec>.toml --run-id <id> --dry-run
bun run publish -- --run-id <id>

cd packages/bench-harness
bun install --frozen-lockfile
bun run typecheck
bun test

cd apps/trajectories
bun install
bun run typecheck
bun test
bun run cli -- --input ../../runs/ts
bun run web -- --input ../../runs/ts --open
```

Credentials come from `.env`. Paid runs require `OPENROUTER_API_KEY`; dataset
downloads may use `HF_TOKEN`. Never edit `packages/bench-harness` directly;
land changes upstream and update the recorded subtree snapshot.

## Run discipline

- Keep reproducible inputs in `run-specs/<engine>/*.toml`.
- Start with a one-task, one-task-chunk calibration when measured per-suite cost
  rates are unavailable.
- Update `[cost_estimates]` and `budget_usd` from measured task costs before
  scaling.
- Run `--dry-run`, then get explicit approval for `--approve-cost-usd` before
  removing `--dry-run`.
- Raw artifacts under `runs/` are ignored and disposable. Redacted bundles under
  `published-runs/<engine>/` are the only result artifacts intended for version
  control.
- Review every published bundle before sharing it.
- DeepSearchQA's headline metric is macro `f1_score`, not Fully Correct accuracy.
- WideSearch's headline metric is `f1_by_item`, not strict all-cells accuracy.
- Keep benchmark prompts, graders, dataset revisions, and score calculations
  stable unless a change is documented and regression-tested.

The retired Python harness and its reports remain in Git history; do not
reintroduce dependencies on them.
