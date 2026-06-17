# Run summaries (verification artifacts)

One `summary.json` per benchmark cell for the three published ladders
(`glm-v1`, `nemotron-v1`, `nano-v1`), mirroring the run-directory names under
`runs/`. These let anyone verify the headline numbers — `completed_tasks` (the
graded sample size), `total_correct` / `total_failed`, the failed-as-zero and
failed-excluded scores, per-stage cost, and latency — without the multi-GB raw
traces.

**What's here:** metrics only. No questions, gold answers, search results, or
model outputs — so this stays clear of the gated benchmark datasets
(browsecomp / hle). The full per-task traces live under `runs/`, which is
gitignored (same convention as upstream `perplexityai/search_evals`).

To regenerate the human-readable report from a full local `runs/` tree:

```bash
uv run python scripts/benchmark_report.py report --bench glm-v1 --out reports/glm-v1 --png
```
