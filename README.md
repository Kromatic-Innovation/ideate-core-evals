# ideate-core-evals

A comparative research study for [`ideate-core`](https://github.com/Kromatic-Innovation/ideate-core): **which generator-model configuration produces the most usefully diverse idea pool per dollar — and does the multi-agent machinery beat a single model call at all?**

Not a regression suite. Not wired into CI as a gate. It is a pre-registered experiment that can, and is designed to, **refute the product it tests**.

## The question

`ideate-core` claims that N independent persona-differentiated agents produce a more diverse idea pool than one call asking for N ideas. This repo tests that claim, and ranks model configurations — Haiku vs Sonnet vs Opus, homogeneous vs mixed-tier, single-provider vs cross-provider — on **distinct ideas per dollar**.

## Design in one paragraph

The unit of analysis is the **pool**, not the idea — ideate-core's claims are pool-level, and scoring ideas individually destroys the property under test. The primary metric is `distinct_k` (semantic equivalence classes occupied), adopted from [NoveltyBench](https://arxiv.org/abs/2504.05228) rather than invented. The LLM judge is **validated against 79 expert reviewers' scores** from [Si et al. 2024](https://github.com/NoviScl/AI-Researcher) and gated on a pre-registered correlation floor — if it fails, idea-level metrics are dropped rather than reported. Self-preference bias is **estimated as a model coefficient** via a cross-judge matrix, not assumed away. Analysis is mixed-effects with brief as a random effect, reporting effect sizes with CIs.

Full design, hypotheses, threats to validity, and the analysis plan: **[`docs/PREREGISTRATION.md`](docs/PREREGISTRATION.md)**.

## Two invariants this repo enforces in code

**1. Nothing is silently swallowed.** `ideate-core`'s engine deliberately drops a failing agent — correct for a library, fatal for a study. A harness that quietly loses cells reports a mean over "the runs that happened to work," biased in favour of whichever models fail most. `lib/accounting.mjs` requires every planned cell to reach exactly one terminal state (`completed` / `failed` / `skipped`) and **throws** on reconcile if any is unaccounted for. Failures are classified data, not absences.

**2. Results are additive, never silently pooled.** `lib/manifest.mjs` keys each cell by `(arm, brief, replicate)` plus a `configHash` over everything affecting comparability. Re-running reuses completed cells and queues only what's missing; changing the engine SHA or a prompt changes the hash, so old results are surfaced as `stale` rather than quietly mixed into new ones.

See [`docs/PREREGISTRATION.md` §11](docs/PREREGISTRATION.md) for why accumulation creates an **optional-stopping hazard**, and the rule that resolves it.

## Cost

Both providers offer 50% Batch API discounts and evals are latency-insensitive, so the study is batch-first. Projected **~$79** for the full grid; **~$160** with contingency. A `--max-spend` pre-flight prices the planned grid and refuses to start if it would exceed the ceiling.

Cost rows conform to the CFO contract (cwc#1639 / cron-fleet#75): they record **tokens × model × timestamp × billing regime** and never a derived dollar figure. Pricing is applied at read time from a pinned, dated rate table, so a rate change is a re-price, not a re-collection.

## Status

Scaffold. The accounting and manifest layers are implemented and tested; the runner, metrics, judge, and analysis are tracked as issues. Nothing has been run — every number in the pre-registration is a projection.

## Development

```bash
npm test   # node --test — hermetic, no network, no API keys
```

Requires Node.js >= 20. Branch from and PR against `develop` (this repo has no `main` — there is nothing to deploy or publish).
