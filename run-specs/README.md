# Run Specifications

> **Runner / harness:** These specs are executed by the [search campaign runner](../apps/search-campaign/README.md), which delegates model execution to the exact vendored [OpenRouter benchmark harness](../packages/bench-harness/README.md).

Commit one TOML spec per reproducible benchmark configuration under its search
engine subdirectory. A spec is the reviewable source of truth for model,
suites, selected range, inference/search knobs, chunking, publication
redaction, and the approved planning budget.

Per-task estimates must come from comparable measured runs and should be
refreshed before scaling. When no rates exist, use a one-task spec with
`limit = 1`, `chunk_size = 1`, and `epochs = 1`, then pass a small explicitly
approved planning ceiling. Copy the measured per-suite costs into
`[cost_estimates]` before running a larger spec.

Do not derive estimates only from token prices. Search volume, retries, and
WideSearch judge fan-out dominate task-level variance.

The approved amount is a planning threshold rather than a provider-side hard
cap. A running task cannot be interrupted based on cost that has not yet been
reported; use one-task chunks when budget exposure must stay narrow.

`max_agent_turns` sets both the request-level `max_tool_calls` (agent rounds)
and the web-search tool's `max_uses` (executed searches). Rounds alone are not a
search budget, because models issue several searches in parallel within one
round. See `apps/search-campaign/README.md` for the per-engine enforcement
differences.
