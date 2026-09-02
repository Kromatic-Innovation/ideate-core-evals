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

## Phase 0 — negative controls + DAT replication (issue #48)

§8.3 registers Phase 0 as the study's first gate: **"all controls pass, or stop."** It is wired and has been run against the live Voyage-4-lite embedder:

```bash
VOYAGE_API_KEY=$(op read "op://Infrastructure/voyage-api-key/credential") node evals/run.mjs --phase 0
```

`VOYAGE_API_KEY` is required and never invented/defaulted; `--dry-run` and every arms/briefs/spend flag are rejected in combination with `--phase 0` (it is a fixed, embeddings-only run — see `evals/run.mjs`). It runs the THREE controls in the table below against the registered Voyage-calibrated threshold (issue #42, read from `evals/metrics/voyage-calibration.mjs`, never hardcoded) and writes both results to the results store (`results/`, gitignored) as first-class rows, not console-only output — see `evals/metrics/phase0.mjs` for the store schema (run-discriminated keys, token-based cost rows, index-visible `cfg.passed`).

| Control | Expected |
| --- | --- |
| Duplicate pool — 30 copies of one idea | `distinct_k = 1`, diversity < 0.05 |
| Random-text pool — 30 unrelated sentences | `distinct_k` ≥ 90% of pool, diversity clears the live DAT-high floor |
| DAT replication | Reproduces the published DAT ordering (low < average < high) |

The fourth control in §4.4's table (judge test-retest, Appendix B item 12) is **not** run by `--phase 0` — it needs #63/#64 (judge cost accounting + cumulative spend ceiling) landed first so judge spend is fully observable.

A passing Phase 0 is validity evidence for the embedding *pipeline*, not evidence that the threshold itself is correct — that is issue #42's claim, not Phase 0's.

## Status

Scaffold. The accounting and manifest layers are implemented and tested; Phase 0 has been run (above); the rest of the runner, metrics, judge, and analysis are tracked as issues.

## Development

```bash
npm test   # node --test — hermetic, no network, no API keys
```

Requires Node.js >= 20. Branch from and PR against `develop` (this repo has no `main` — there is nothing to deploy or publish).
