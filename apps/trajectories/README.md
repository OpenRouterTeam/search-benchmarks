# Trajectory Reader

Local tooling for inspecting raw bench-harness Parquet trajectories. It accepts
either one `.parquet` file or a complete `runs/ts/<run-id>` directory and
recursively loads all chunk files.

Raw trajectories contain benchmark inputs, targets, grader explanations, and
judge output. This application binds only to `127.0.0.1`; do not expose it as a
hosted partner artifact. Use `published-runs/` for sanitized sharing.

## Quick Start

```bash
bun install
bun run web -- --input demo.parquet --open
```

`demo.parquet` contains synthetic data and is safe to commit. Replace it with a
real Parquet file or `runs/ts/<run-id>` directory when inspecting a benchmark.

## Terminal

```bash
cd apps/trajectories
bun install
bun run cli -- --input ../../runs/ts
bun run cli -- --input demo.parquet
bun run cli -- --input ../../runs/ts --exclude calibration
bun run cli -- --input ../../runs/ts --run <run-id>
bun run cli -- --input ../../runs/ts --sample browsecomp-0
bun run cli -- --input ../../runs/ts --id '<run>::<chunk>::<sample>::<epoch>'
```

## Web

```bash
bun run web -- --input ../../runs/ts --exclude calibration --open
```

`--exclude <substring>` is repeatable and drops matching runs from the reader
entirely, which keeps short calibration runs out of the picker without deleting
them from disk.

Point `--input` at `runs/ts` to browse every run, or at one run directory to
scope the reader to it. A run is identified by the nearest ancestor directory
containing `manifest.json`, so run title and status come from the manifest.

Run is the primary filter, followed by suite, score, and free text. With
multiple runs loaded, sample groups are labeled `run · suite`.

The interface has two independently scrolling regions: a sample rail and a
detail pane. Sample detail is split into tabs so raw JSON never dominates the
page.

- **Overview** — question, ground-truth target, model answer, grader
  explanation, and deduplicated cited sources.
- **Search** — per-call timeline separating executed searches from calls blocked
  by the search budget, with source hosts and links.
- **Grading** — decoded judge verdicts, WideSearch metric bars, and the scorer
  trajectory.
- **Raw** — Responses items, messages, metadata, resolved config, and generation
  IDs, each with a copy button.

`Run overview` aggregates the selected run: graded tasks, provider cost, tokens,
per-suite accuracy and primary score, and a chunk table. With `All runs`
selected it lists every run so you can compare and click into one. It is useful
while a benchmark is still writing chunks.

Run and suite use a custom listbox showing task counts and run status, since a
native select cannot render that detail. It supports arrow keys, `Enter`,
`Escape`, and click-outside dismissal.

Filters and shortcuts:

- Filter by run, suite, score, and free text.
- `/` focuses the filter input.
- `j` / `k` or arrow keys move between samples.
- `1`–`4` switch tabs.
- `g` opens the run overview.
- `r` or the `↻` button reloads immediately.

## Live runs

The server re-scans the input on each index request and reloads only chunk files
whose size or mtime changed, so a benchmark that is still writing chunks streams
into the reader. The browser also polls every ten seconds and the footer shows
the last update. Rows are addressed by a stable
`run::chunk::sample::epoch` identifier, so the selected sample never shifts when
new chunks land.

## Styling

The viewer uses a standalone neutral palette and a text monogram defined in
`app.css` and `index.html`. It contains no external fonts, logos, or brand
assets.

## Layout

```text
cli.ts      terminal inspector
web.ts      localhost server (static assets + JSON API)
reader.ts   shared Parquet loader
ui/         index.html, app.css, app.js
```

The server serves an explicit asset allowlist and sends a strict
`Content-Security-Policy` with no inline scripts or styles. UI files are read
per request, so refreshing the browser picks up edits without a restart.
