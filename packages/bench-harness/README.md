# OpenRouter Search Bench Harness

Standalone TypeScript/Effect harness for three search benchmarks:

- `search_browsecomp`
- `search_dsqa`
- `search_widesearch`

The package is a standalone, public-dependency-only implementation of the
OpenRouter search benchmark runner. It contains the runner, Responses transport,
search requests, prompts, grading, datasets, and Parquet persistence needed by
the three supported suites.

The standalone patch intentionally changes only package boundaries and three
validation defects found during the port:

- Official DSQA rows with null answers are normalized to the canonical `None`
  target instead of failing dataset validation.
- Incomplete or empty search responses are retried instead of being scored as
  model answers.
- The declared benchmark temperature (`0`) is sent on generation requests even
  when the CLI config omits an explicit override.

## Setup

```bash
cd packages/bench-harness
bun install
bun run typecheck
bun test
```

## Run

The recommended workflow is a committed TOML spec, a free dry run, explicit
cost approval, resumable raw chunks, and an automatically generated partner
bundle:

```bash
bun run bench -- \
  --spec ../../run-specs/example-partner-search.toml \
  --run-id 2026-07-30-partner-search-smoke \
  --dry-run

set -a && source ../../.env && set +a
bun run bench -- \
  --spec ../../run-specs/example-partner-search.toml \
  --run-id 2026-07-30-partner-search-smoke \
  --approve-cost-usd 2.00
```

The approval is a planning threshold, not a provider-side hard spending cap.
The runner refuses to begin when its measured-rate estimate exceeds either the
spec budget or approved amount, checks remaining estimates before each chunk,
and stops after a chunk reaches the threshold. One in-flight chunk can exceed
its estimate, so use `chunk_size = 1` for tightly controlled runs.

Raw outputs land in `runs/ts/<run-id>/` and are gitignored:

```text
run.toml
manifest.json
logs/events.jsonl
raw/<suite>/<start>-<end>.parquet
```

Completed chunks are checksum- and config-validated on resume, so rerunning the
same command pays only for missing chunks. Publication runs after every chunk
and can also be regenerated without API calls:

```bash
bun run publish -- --run-id 2026-07-30-partner-search-smoke
```

The tracked `published-runs/<engine>/<run-id>/` bundle contains `run.toml`,
resolved provenance, `summary.json`, a self-contained HTML report, checksums,
and redacted JSONL trajectories. It excludes targets, judge
prompts/explanations, raw inputs, model answers, search queries, session IDs,
and generation IDs by default. Raw artifact filenames and SHA-256 values remain
in the published manifest. Published citations retain only the URL origin and
hostname; paths, query parameters, fragments, and upstream titles are removed.
Raw artifacts remain in the gitignored run directory. Review generated content
before committing or sharing it.

The lower-level `bun run cli.ts` interface remains useful for one-off debugging,
but it does not provide chunk resumption or a redacted publication boundary.
DeepSearchQA's headline metric is macro `f1_score`; its binary accuracy is the
strict Fully Correct rate. WideSearch's headline metric is `f1_by_item`, not
binary accuracy.

Raw Parquet files can be inspected with the companion reader in
[`apps/trajectories`](../../apps/trajectories/README.md).

## Search budgets: `max_tool_calls` vs `max_uses`

These bound different things, and sending only one silently changes what a
"turn budget" means:

- `max_tool_calls` (request level) bounds **agent rounds**.
- `max_uses` (web-search tool parameter) bounds **executed searches**.

Models fan several searches out in parallel inside a single round, so
`max_tool_calls: 1` alone permits many searches in that one round. Only
`max_uses: 1` caps execution at one; further calls return
`max_uses_reached` with empty results. This harness therefore sends both, and
derives them from one `max_agent_turns` knob so a rung means the same thing
everywhere.

Enforcement differs by engine, which is the other reason to send both:

| Engine | `max_uses` | `max_tool_calls` |
| --- | --- | --- |
| `exa`, `firecrawl`, `parallel`, `perplexity` | enforced by OpenRouter's tool loop | bounds rounds |
| `native` (Anthropic) | forwarded to the provider | falls back to `max_uses` when unset |
| `native` (others, e.g. OpenAI) | ignored, no equivalent parameter | the only usable bound |

So on server-tool engines a rung is capped by both rounds and searches; on
native engines it is effectively rounds only, except on Anthropic. Compare
across engines with that asymmetry in mind. Note also that blocked calls still
cost tokens: the model pays to emit the query and to reason over an empty
result.

## Architecture

```text
cli.ts
  -> run-benchmark-by-id.ts
  -> benchmarks/registry.ts
  -> benchmarks/search/{browsecomp,dsqa,widesearch}
  -> benchmarks/search/core (Responses request + search solver)
  -> judge/judge.ts
  -> run.ts
  -> result-store.ts -> parquet.ts
```

The package uses public npm dependencies only and contains no private workspace
imports or unresolved local dependency protocols.
