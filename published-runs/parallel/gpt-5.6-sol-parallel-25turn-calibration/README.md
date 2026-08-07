# GPT-5.6 Sol with Parallel search, 25-turn calibration

One task per suite to measure cost before the 100-task run.

- Status: `complete`
- Model: `openai/gpt-5.6-sol`
- Full configuration: [`run.toml`](run.toml)
- Machine-readable summary: [`summary.json`](summary.json)
- Redacted trajectories: [`samples.redacted.jsonl`](samples.redacted.jsonl)
- Self-contained report: [`report.html`](report.html)

The published trajectory export excludes benchmark targets, grader details,
raw inputs, model answers, search queries, session IDs, and generation IDs by
default. Optional content must be explicitly enabled in the run spec and reviewed
before sharing. Raw Parquet artifacts are identified by checksum in
`manifest.json` and remain outside Git.
