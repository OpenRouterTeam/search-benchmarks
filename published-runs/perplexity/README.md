# Perplexity Published Runs

## Corrected WideSearch Runs

These bundles use benchmark harness `77483ab` with corrected judge verdict
handling:

- `gpt-5.6-sol-perplexity-widesearch-1turn-v2`
- `gpt-5.6-sol-perplexity-widesearch-5turn-v2`
- `gpt-5.6-sol-perplexity-widesearch-25turn-v2`

## Historical Runs

The older bundles were generated before the canonical harness dependency
merged in PR #6. Their DSQA headline is strict Fully Correct accuracy, not
macro F1, and their WideSearch grading reference date is `2025-01-01`.

The generated bundle directories below are preserved byte-for-byte with their original checksums. Do not relabel them as post-PR #6 results or regenerate them during branch maintenance.
