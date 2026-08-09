# Corrected Perplexity WideSearch Trajectories

This directory contains the corrected 100-task WideSearch reruns generated with
benchmark harness `77483ab`:

- `gpt-5.6-sol-perplexity-widesearch-1turn-v2`
- `gpt-5.6-sol-perplexity-widesearch-5turn-v2`
- `gpt-5.6-sol-perplexity-widesearch-25turn-v2`

Open all three from a checkout of the `perplexity` branch:

```bash
cd apps/trajectories
bun install
bun run web -- --input ../../runs/ts --open
```

These raw Parquet files contain benchmark inputs, targets, answers, search
activity, and grader output. Keep them within the repository's intended access
boundary. Use `published-runs/perplexity/` for redacted sharing.
