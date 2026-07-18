# search_evals

An OpenRouter-first framework for evaluating search-capable model systems. It
runs a model and search configuration against BrowseComp, Humanity's Last Exam,
DeepSearchQA, and WideSearch, then produces a self-contained report with
quality, cost, latency, confidence intervals, and run metadata.

This repository is based on Perplexity's
[`search_evals`](https://github.com/perplexityai/search_evals) project. The fork
adds OpenRouter search surfaces, engine selection, resumable sampled sweeps,
provider-reported cost tracking, and Pi agent support.

## Latest Report

The latest report evaluates **GLM 5.2 Nitro through the Pi agent** across Exa,
Parallel, and Perplexity. It compares the plugin, 1-turn, 5-turn, and 25-turn
search surfaces on 100 seeded tasks from each suite.

[Open the interactive HTML report](reports/latest/benchmark-report.html) or
[view the full PNG](reports/latest/benchmark-report.png).

[![Pi + GLM 5.2 benchmark report](reports/latest/benchmark-report-preview.png)](reports/latest/benchmark-report.png)

The matrix contains 48 benchmark cells and 4,793 graded tasks out of 4,800.
At the 25-turn depth, Exa has the highest point estimate on BrowseComp (0.59),
HLE (0.50), and WideSearch (0.732 F1), while Perplexity has the highest point
estimate on DeepSearchQA (0.67). The report includes confidence intervals; the
leading engine estimates overlap on these 100-task samples.

These are **web-search-only** results. Page fetch and code tools are disabled,
so the absolute scores should not be compared directly with full multi-tool
agent benchmarks. Use the report to compare search engines and search depth
under the same harness.

## Setup

Requirements:

- Python 3.12+
- [`uv`](https://docs.astral.sh/uv/)
- An `OPENROUTER_API_KEY`
- Node.js and npm when using the Pi harness
- Hugging Face access to [`cais/hle`](https://huggingface.co/datasets/cais/hle)
  when running HLE

```bash
uv sync
npm install                         # Pi harness only
export OPENROUTER_API_KEY=...
uv run python -m search_evals download-datasets
uv run python -m search_evals list
```

## Run An Evaluation

Systems are defined in [`systems.toml`](systems.toml). A system combines a
model, harness, search surface, engine, and search budget. For example:

```toml
[systems.my-pi-search-system]
harness = "pi"
model = "z-ai/glm-5.2:nitro"
provider = "openrouter"
thinking_level = "high"
no_tools = "all"
web_search = "server-tool"
search_backend = "exa"
max_results_per_search = "default"
max_tool_calls = 5
```

Start with a five-task smoke test:

```bash
uv run python -m search_evals run \
  --system my-pi-search-system \
  --suite browsecomp \
  --limit 5
```

For representative comparisons, use seeded random samples rather than
`--limit`. Samples are nested: increasing the sample size with the same seed
reuses completed tasks and pays only for the additional work.

```bash
uv run python -m search_evals run \
  --system my-pi-search-system \
  --suite browsecomp \
  --sample 100 \
  --sample-seed 0
```

All evaluation and grading commands make paid API calls. Review the dry-run
plan and cost estimate before starting a matrix sweep:

```bash
uv run python scripts/benchmark_report.py sweep \
  --spec benchmarks/pi-glm-5-2-ladder-defaults.toml \
  --dry-run
```

Remove `--dry-run` only after confirming the scope and budget.

## Reports

Run artifacts are resumable directories under `runs/`. Generate an HTML and
PNG report from an existing benchmark without making API calls:

```bash
RUN_SUFFIX=my-benchmark-v1
uv run python scripts/benchmark_report.py report \
  --bench "$RUN_SUFFIX" \
  --out "reports/$RUN_SUFFIX" \
  --png
```

Useful commands:

```bash
uv run python scripts/benchmark_report.py status
uv run python scripts/benchmark_report.py debug
uv run python -m pytest tests/ -q
```

## Scoring

| Suite | Primary metric |
| --- | --- |
| BrowseComp | Accuracy |
| HLE | Accuracy |
| DeepSearchQA | Accuracy |
| WideSearch | F1 by item |

Headline scores count exhausted tasks as zero. The report also shows the score
excluding failed tasks, 95% confidence intervals, provider-reported cost, and
agent latency. Compared rows use the same dataset fingerprint and the default
grader, `openai/gpt-4.1` through OpenRouter.

See [`THIRD_PARTY_DATASETS.md`](THIRD_PARTY_DATASETS.md) for dataset sources and
licenses. This project is released under the [MIT License](LICENSE).
