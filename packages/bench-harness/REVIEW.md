# Bench Harness Review Checklist

- Preserve full Responses output items, judge trajectories, answers, and usage
  in Parquet. Do not truncate evidence used to justify a score.
- Keep benchmark prompts, datasets, graders, and metric calculations immutable
  unless a change is documented and covered by a regression test.
- Reject incomplete and empty generation responses before grading.
- Keep the package standalone: no internal OpenRouter workspace imports or
  dependency protocols.
- Validate all external data through the local Zod helpers.
