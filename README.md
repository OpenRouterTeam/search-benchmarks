# OpenRouter Search Benchmarks

> **Runner / harness:** Use the [search campaign runner](apps/search-campaign/README.md) for TOML specs, cost approval, resumable runs, and publication. Model execution comes from the exact vendored [OpenRouter benchmark harness](packages/bench-harness/README.md).

Standalone TypeScript tooling for running and inspecting OpenRouter search
benchmarks. The harness supports BrowseComp, DeepSearchQA, and WideSearch over
the public OpenRouter Responses API and server tools.

## Open The Trajectory Viewer

```bash
cd apps/trajectories
bun install
bun run web -- --input demo.parquet --open
```

The checked-in `demo.parquet` is synthetic. To inspect a real run, replace it
with a Parquet file or run directory such as `../../runs/ts/<run-id>`.

## Add A Search Engine Layer

Branch from the reusable harness, keep engine-specific specs under
`run-specs/<engine>/`, and commit reviewed bundles under
`published-runs/<engine>/`:

```bash
git switch -c <engine> ayush/harness-port
cd apps/search-campaign
bun run bench -- --spec ../../run-specs/<engine>/<spec>.toml --run-id <run-id> --dry-run
```

The spec's `search.engine` automatically selects
`published-runs/<engine>/<run-id>/` for generated bundles. The `perplexity`
branch is the first engine layer and can be used as the stack example.

## Repository

- [`packages/bench-harness`](packages/bench-harness/README.md) is an exact
  vendored snapshot of the canonical benchmark library, datasets, and graders.
- [`apps/search-campaign`](apps/search-campaign/README.md) owns TOML run specs,
  cost approval, resumable chunks, and redacted publication.
- [`apps/trajectories`](apps/trajectories/README.md) provides terminal and local
  web interfaces for inspecting raw Parquet trajectories.
- [`run-specs`](run-specs/README.md) contains reviewable TOML configurations,
  grouped by search engine, for reproducible runs.
- [`published-runs`](published-runs/README.md) contains intentionally tracked,
  redacted result bundles grouped by search engine.

The retired Python runner, historical sweep configurations, reports, and raw
run artifacts remain available in Git history.

## Update The Vendored Harness

Benchmark implementation changes land in
[`OpenRouterTeam/benchmark-harness`](https://github.com/OpenRouterTeam/benchmark-harness)
first. Pull a reviewed upstream ref and verify the exact tree from the repository
root:

```bash
scripts/subtree-pull-benchmark-harness.sh <ref>
bun scripts/check-benchmark-harness-subtree.ts
```

The recorded commit and tree live in `packages/bench-harness.upstream.json`.
Never patch `packages/bench-harness` downstream.

## Setup

Requirements:

- [Bun](https://bun.sh/)
- An `OPENROUTER_API_KEY` for paid benchmark execution
- A Hugging Face token when a dataset requires authenticated access

```bash
cd apps/search-campaign
bun install
bun run typecheck
bun test
```

The trajectory viewer has its own checks:

```bash
cd apps/trajectories
bun run typecheck
bun test
```

## Run A Benchmark

Start with a committed TOML spec and a free dry run:

```bash
cd apps/search-campaign
bun run bench -- \
  --spec ../../run-specs/example-partner-search.toml \
  --run-id partner-search-smoke \
  --dry-run
```

Every non-dry run makes paid API calls and requires an explicit planning
ceiling. Do not start one without approving its scope and cost:

```bash
set -a && source ../../.env && set +a
bun run bench -- \
  --spec ../../run-specs/example-partner-search.toml \
  --run-id partner-search-smoke \
  --approve-cost-usd 2.00
```

Raw chunks and event logs are written under `runs/ts/<run-id>/` and ignored by
Git. Completed chunks are checksum-validated on resume. After every chunk, the
runner writes a reviewable redacted bundle under
`published-runs/<engine>/<run-id>/`.

## Inspect Trajectories

```bash
cd apps/trajectories
bun run cli -- --input ../../runs/ts/<run-id>
bun run web -- --input ../../runs/ts/<run-id> --open
```

Raw trajectories contain benchmark inputs, targets, model answers, and grader
details. Keep the viewer local and share only reviewed `published-runs/`
bundles.

## Scoring

| Suite | Primary metric |
| --- | --- |
| BrowseComp | Accuracy |
| DeepSearchQA | Macro F1 |
| WideSearch | F1 by item |

DeepSearchQA also reports strict Fully Correct accuracy plus macro precision,
recall, and the paper's four categorical rates.

See [`THIRD_PARTY_DATASETS.md`](THIRD_PARTY_DATASETS.md) for dataset sources and
licenses. Runner code is released under the [MIT License](LICENSE).
