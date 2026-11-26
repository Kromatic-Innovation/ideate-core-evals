# Findings — comparative ideation study, 2026-11

**Status as of 2026-11-26.** This report covers what was run, what it found, how that compares with [`PREREGISTRATION.md`](PREREGISTRATION.md), and which registered experiments were never run. It makes no new claims. Every number below is read from a committed status brief, a dated appendix, or a committed data file, and the source is named next to it. Where a number cannot be re-derived from what is committed, the report says so.

**No paid provider run was made to write this report.** The only commands run were reads of committed files and offline `node evals/run.mjs --dry-run` pricing calls, made with `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` and `VOYAGE_API_KEY` unset, against an empty throwaway store outside the repo. `--dry-run` calls no provider and writes nothing (`evals/harness/runner.mjs`, the `dryRun` branch of `runSpec`).

## Summary

1. **The registered study did not run.** The A–H grid of §3.1 (plus A′ and AS) has no reportable cell. H1–H5 are **not estimable**.
2. **What ran instead is Study 1**, four stages, all on one generator model (`claude-sonnet-5`), each registered in advance by its own dated appendix (F, I, J/K, L/M, N). Every Study 1 result comes from real, metered provider calls.
3. **Findings on the registered primary metric, rarefied `distinct_k`:**
   - A thin-stance five-agent panel produces **fewer** distinct ideas than one solo call: −2.13 [−3.37, −0.90], Holm p 0.0007 (Stage 1b re-run).
   - A richly differentiated panel produces **more**: +1.67 [0.31, 3.03], Holm p 0.0158 (Stage 1c). That is below the design's registered MDE of 1.89, at 14.4× the cost.
   - Ten blind, undifferentiated solo calls collapse a 60-idea pool to about 15 distinct ideas (Stage 1c).
4. **On quality (descriptive only), the rich panel is not better. It trades feasibility for originality** (Appendix N item 11).
5. **Spend was about $349 against a §8.2 projection of ~$79 (~$160 with contingency) and a $200 ceiling.**

## 1. Provenance per arm: real provider runs or mocks/fixtures

The live-versus-stub ledger is `evals/capabilities.json` (#25). Its rows for `generation`, `engine-under-study`, `embedding` and `judge-scoring` are `live`. The row `judge-scoring-openai-leg` still reads `absent`, but the producer exists: `OpenAIJudgeProvider` at `evals/judge/score.mjs:530`, wired into the CLI at `evals/run.mjs:1257`. The ledger is stale; the capability is not missing. Stage 1a's OpenAI spend ($5.22, `docs/status-2026-09-08.md`) is judge spend, since the generator was Sonnet.

The hermetic test suite runs on `MockProvider` (`evals/harness/provider.mjs`) and on the fixtures under `evals/metrics/fixtures/`. **None of that output appears in any result below.**

| Arm(s) | Registered in | Source of results | Committed data | Checked for this report |
| --- | --- | --- | --- | --- |
| **A, A′, B, C, D, E, F, G, H, AS** (the registered grid) | §3.1, App. E item 6 | **None. Never run.** | — | — |
| B (16 cells), D (3 failed) | Phase 2a smoke | Real provider calls | `results-pilot/` | Yes. All 58 cost rows are `billing_mode: api`. D's 3 cells all failed. Stale `configHash` and superseded (App. E item 8), so **not a finding.** |
| `S1-*`, 8 arms (Stage 1a) | App. F | Real provider calls | `data/study1-stage1a/cells.jsonl` (956 records), `docs/study1-stage1a-cells.csv` | Yes. 8 arms × 24 cells, 955 completed, 1 failed. All 765 cost rows are `billing_mode: api`, with per-model token counts. |
| `S1B-*`, 3 arms (Stage 1b, first run) | App. I | Real provider calls | `docs/study1-stage1b-cells.csv` (per-cell metrics only; the raw store is not committed) | Arm means read from `docs/status-2026-09-09.md`. Superseded by the re-run. |
| `S1B-*`, 3 arms (Stage 1b **re-run**, the reportable one) | App. J, App. K | Real provider calls, per `docs/status-2026-09-09b.md` (431/432 cells, $93.85) | **None.** `results-study1b-r2` is gitignored | Brief only. Cannot be re-derived from the repo. |
| `S1C-*`, 3 arms (Stage 1c) | App. L, App. M | Real provider calls, per `docs/status-2026-09-09c.md` | **None.** `results-study1c` is not committed (App. R item 2 confirms) | Brief only. Cannot be re-derived from the repo. |
| §5.1 judge gate and the Stage 1c quality read | App. N items 9, 11, 12 | Real provider calls ($0.577 and $0.98) | None | Appendix only. |
| Phase 0 negative controls | §4.4, README | Real (live Voyage embeddings), per the README | None (`results/` is gitignored) | README only. |

**What this means for the write-up.** No mocked or fixture result is reported as a finding. The real provenance gap is **reproducibility**: the two headline results (Stage 1b re-run, Stage 1c) and the judge gate have no committed data. Their numbers can be checked against the analysis scripts (`evals/analysis/stage1b.mjs`, `evals/analysis/stage1c.mjs`) only on the machine that holds the stores.

## 2. Results compared with the pre-registration

### 2.1 Registered hypotheses (§6.1)

| ID | Registered as | Status |
| --- | --- | --- |
| **H1** | Any panel arm > Arm A at matched idea count (contrast over A′, B–H vs A) | **Not estimable.** No grid arm ran. Study 1 asked the same question with differently scoped contrasts, which by registration may not fill H1's slot (App. I item 4, #145). |
| **H2** | Mixed-tier E ≥ Opus D, at lower cost; δ = 2.7976 (App. R item 3) | **Not estimable.** Neither E nor D ran. |
| **H3** | Cross-provider G > max(D, H) | **Not estimable.** No OpenAI generation arm ran in any reportable cell. |
| **H4** | Haiku B ≥ Opus D; δ = 2.7976 (App. R item 3) | **Not estimable.** Only the stale pilot's B cells exist. |
| **H5** | Same-provider judging inflates scores | **Not estimated.** The `judge_provider × generator_provider` term of §6.2 was never fitted. Every generator was Anthropic, so the interaction cannot be identified from the data that exists. |

### 2.2 What Study 1 found

All contrasts are on rarefied `distinct_k` (App. C items 2–5), brief as a random effect.

| Stage | Contrast | Estimate [95% CI] | Holm p | Source |
| --- | --- | --- | --- | --- |
| 1a (screen; no tests by registration, App. F item 7) | effort low / effort max / stance PRAGMATIST / stance CONTRARIAN / strategy `direct`, each vs the centre point | +0.04 / +0.88 / −1.54 / 0.00 / −0.58. Every CI contains 0 | — | `status-2026-09-08.md` |
| 1a | N=60 vs N=30, rarefied to 30 | 26.45 vs 26.58. **N buys pool size, not distinctness** | — | same |
| 1b, first run | `S1B-PANEL − S1B-SOLO60` | −1.77 [−3.55, +0.02] | 0.052 | `status-2026-09-09.md` |
| **1b re-run** | `S1B-PANEL − S1B-SOLO60` | **−2.13 [−3.37, −0.90]** | **0.0007** | `status-2026-09-09b.md` |
| 1b re-run | `S1B-PANEL − S1B-APRIME` (persona ablation) | +17.08 [15.85, 18.32] | <0.0001 | same |
| **1c** | `S1C-RICH − S1C-SOLO60` | **+1.67 [0.31, 3.03]** | **0.0158** | `status-2026-09-09c.md` |
| 1c | `S1C-RICH − S1C-SOLO6X10` (ten blind identical calls) | +30.21 [28.85, 31.57] | <0.0001 | same |

**Cost lane** (descriptive by registration, App. B item 9). Mean cost is generation cost per cell. Distinct ideas per dollar is `distinct_k` ÷ mean cost, on each basis. The full-pool column reproduces the figures the brief reports (~1168 and ~256, `status-2026-09-09b.md`). The rarefied column uses the registered estimand and was computed for this report.

| Stage | Arm | Rarefied `distinct_k` | Full-pool `distinct_k` | Mean cost/cell | Distinct/$ (full pool) | Distinct/$ (rarefied) |
| --- | --- | --- | --- | --- | --- | --- |
| 1b re-run | `S1B-SOLO60` | 44.57 | 53.25 | $0.0456 | 1168 | 977 |
| 1b re-run | `S1B-PANEL` | 42.50 | 49.16 | $0.1920 | 256 | 221 |
| 1b re-run | `S1B-APRIME` | 25.35 | 27.94 | $0.1504 | 186 | 169 |
| 1c | `S1C-SOLO60` | 44.37 | 53.16 | $0.0430 | 1236 | 1032 |
| 1c | `S1C-RICH` | 46.03 | 54.16 | $0.6178 | 88 | 74 |
| 1c | `S1C-SOLO6X10` | 15.83 | 17.20 | $0.0915 | 188 | 173 |

The rich panel costs **14.4×** the solo call for **+3.8%** rarefied distinct ideas (`status-2026-09-09c.md`).

**Quality** (App. N; descriptive, 12 cells, 6 briefs, one replicate, no contrast computed):

- **Judge gate (§5.1) passed, narrowly.** Balanced accuracy was 0.5833 against a 0.561 floor (n = 98). Human–human agreement on the same slice is 0.5534 [0.4483, 0.6702], an interval that includes chance. The honest reading is "not distinguishable from the human reviewers", not "a good judge" (App. N item 9).
- **Originality against feasibility.** `S1C-RICH` scored originality 6.09 and feasibility 6.09; `S1C-SOLO60` scored 2.80 and 8.21. The originality gap has the same sign in all six briefs (App. N item 11).
- **Coherence.** In a blind read of 40 ideas, all six incoherence or vacuity flags came from `S1C-RICH` (`poet` 4, `weirdo` 2). Length is a confound: a one-line idea cannot contradict itself (App. N item 11).
- **The axes are correlated**: per-idea r = −0.61 within RICH and −0.45 within SOLO60. Part of the trade is built into the instrument.

### 2.3 Reading for the write-up

1. **Undifferentiated parallelism is nearly worthless.** Sixty ideas from ten identical blind calls cluster to about 15 distinct ideas.
2. **Thin one-sentence stances recover most of that loss, but the panel still loses to one call.** The deficit is cross-agent duplication (5.30 merged clusters per cell against solo's 0; `status-2026-09-09b.md`).
3. **Rich personas edge past one call on distinctness**, at a cost that does not pay on that metric. What they buy is originality at the expense of feasibility.
4. **On frontier Anthropic models, stance is the only differentiation lever.** The API rejects `temperature` on `claude-sonnet-5` and `claude-opus-5` (HTTP 400, "deprecated"), so the shipped 0.4–1.0 temperature spread cannot be sent. Stage 1a measured stance as weak for a solo agent. App. O items 1 and 4 register this as a bound on `S1b-1`. It supersedes the brief's "half its differentiation machinery disabled" framing (`status-2026-09-09b.md`), because nothing that could have been sent was removed.
5. **`distinct_k` and quality are different quantities.** The study's headline metric measures distinctness. The quality read shows the panel's real effect sits on a different axis.

### 2.4 Deviations from the pre-registration

Each item is recorded in a dated appendix, so none was absorbed silently. The write-up should still list them all.

1. **Phase 3 (the full grid) never ran.** Study 1 replaced it (App. F onward). The confirmatory family H1–H5 is unanswered.
2. **One generator model throughout.** Every Study 1 slot resolves to `claude-sonnet-5` (App. O item 1). The study's titular question, which model configuration wins per dollar, is unaddressed. Haiku, Opus and OpenAI never generated in a reportable cell.
3. **New contrast families.** Stages 1b and 1c each registered their own two-contrast Holm family (m = 2), outside §6.2's m = 5 family (App. I item 4, App. L).
4. **Re-run against §6.2's "no peeking" rule.** Stage 1b was re-run at B = 48 / R = 3 after the first run returned p = 0.052. The re-run was registered before its first cell (App. J), which satisfies §6.3's "register the re-run". It is still the one place a reader may raise optional stopping (§11), so name it.
5. **Batch mode dropped** (App. K, #148). Every result was bought at full price, against a projection that assumed batch pricing throughout.
6. **Stage 1c's treatment arm was re-collected** after a max-effort `max_tokens` defect lost 139 of 144 cells (App. M). The five surviving old-hash cells were excluded, and the inclusion rule was not loosened.
7. **The judge gate metric was replaced** (ρ → balanced accuracy, App. A item 4). Idea-level metrics are exploratory (App. B item 7), and the quality read is descriptive (App. N item 6).
8. **Under-powered headline.** Stage 1c's +1.67 is below its registered MDE of 1.89, and the brief asks for replication (`status-2026-09-09c.md`).
9. **Budget overrun.** §8.2 projected ~$79 (~$160 with contingency) under a $200 ceiling. Reported spend, by source:

   | Item | Spend | Source |
   | --- | --- | --- |
   | Stage 1a | $15.79 (repriced, #143) | `status-2026-09-08.md` |
   | Stage 1b, first run | $15.40 | `status-2026-09-09.md` |
   | Stage 1b re-run | $93.85 | `status-2026-09-09b.md` |
   | Stage 1c, all collection | $222.72 | `status-2026-09-09c.md` |
   | Judge gate and quality read | $1.56 | App. N items 9, 11 |
   | **Total** | **≈ $349** | |

   `--max-spend` failed to bind twice (App. K; App. N item 10). It was fixed and its overshoot bound registered in App. P. Pilot (Phase 2a) and Phase 0 spend is not included; neither has a committed total.
10. **§9's `REPORT.md` has not been written** (#10, open). This document is a findings report, not that deliverable.
11. **No human evaluated the study's own outputs.** App. Q item 2's threat row stands, because the human-anchor panel (`docs/human-anchor-panel.md`) never ran.
12. **The convergence stage was never exercised.** No cell tested ideate-core's narrowing stage (#133).

## 3. Experiments left undone, with estimated cost

### 3.1 Why the README's projection cannot be used as is

The README's **~$79 / ~$160** and §8.2's table assume batch pricing (dropped, App. K), a Sonnet rate of $3/$15 (`lib/price.mjs` now pins $2/$10), and ~16k/9k tokens per run, measured before `effort` and the per-request `max_tokens` floors existed.

The figures in 3.2 come from the harness's own pricer, run offline against `arms.config.json` (`node evals/run.mjs --dry-run --arms … --results-dir <empty dir>`). That pricer includes the planned judge legs (`evals/run.mjs`, `runnerPriceGrid` with `judgeLegsFor`). Against an empty store every arm is **uncalibrated**, so each figure is a point estimate whose registered upper bound is 2.5× (`UNCALIBRATED_HIGH_FACTOR`, `lib/price.mjs`). That factor is the 2.53× miss observed on the Stage 1c re-collect. As a check: the uncalibrated per-cell price for Arm C (Sonnet panel, $0.289) sits close to the measured Stage 1b re-run cost per cell ($93.85 / 431 = $0.218), so the point estimates are plausible for `high`-effort arms.

### 3.2 The registered grid, priced from `arms.config.json`

The dry-run plans 48 cells per arm (48 briefs × 1 replicate). That matches App. G's B = 24 / R = 2 cell count.

| Arm | Configuration | Cells | Unbatched point estimate |
| --- | --- | --- | --- |
| A | solo | 48 | $4.96 |
| AS | solo, stance-neutral | 48 | $4.96 |
| A′ | persona-disabled panel | 48 | $13.53 |
| B | Haiku panel | 48 | $13.53 |
| C | Sonnet panel | 48 | $13.86 |
| D | Opus panel | 48 | $25.24 |
| E | tiered mix 2H/2S/1O | 48 | $19.63 |
| F | inverted mix 3H/2O | 48 | $18.21 |
| G | cross-provider | 48 | $17.71 |
| H | OpenAI panel | 48 | $25.44 |
| **Grid total** | | **480** | **$157.07 unbatched** (upper bound $392.67); **$78.53 if batched** |

The batched figure reproduces the README's ~$79. The README's number is therefore the batched point estimate, and it does not describe how Study 1 was actually run. Opus arm D carries the most truncation risk (#122: the pilot's D cells all failed).

### 3.3 Everything left undone

| Undone | Issue / state | Registered size | Estimated cost | Basis |
| --- | --- | --- | --- | --- |
| **Registered A–H grid (+A′, AS); H1–H5** | #1 (open epic) | 480 cells | **$157 unbatched** (to $393); $79 batched | Dry-run, 3.2 above |
| **Study 2: solo model comparison, six tier-matched conditions** | #131, open, `~operator` | 48 briefs × 2 = 288 cells | **≈ $40–60 unbatched** | Not in `arms.config.json`, so it cannot be dry-run. Estimate: measured solo generation $0.043–0.046/cell at Sonnet, scaled by tier rate (`lib/price.mjs`), plus ≈ $0.09/cell judging. Judging is the Stage 1b re-run total minus its arm generation means, ≈ $38 over 431 cells. The "best solo configuration" it depends on was never designated (App. R item 2). |
| **Study 3: process factors** (size, stance, sharing, rounds) | #132, open, `~operator` | 3a ≈ 120 cells; 3b = 24 conditions × 48 briefs × 2 = 2304 cells | **3a ≈ $20–25; 3b ≈ $300–450 unbatched** | Not in `arms.config.json`. Estimate: Haiku-held panel (#132 holds the cheapest adequate model) ≈ $0.10/cell generation plus ≈ $0.09/cell judging. 3b is the largest remaining item. |
| **Study 4: convergence vs random-k** | #133, open, `~planning` | Not designed | **Unpriced** | Needs a quality instrument first. |
| **Human-anchor panel** | #52 (closed: scoped and costed, not run) | see `docs/human-anchor-panel.md` | see that document's costing | Exploratory only (App. Q item 1). |
| **Stage 1c replication** (+1.67 is below its MDE) | not filed | 3 arms × 48 × 3 = 432 cells | **≈ $105–136 unbatched** | Dry-run of `S1C-RICH,S1C-SOLO60,S1C-SOLO6X10 --replicates 3`: $135.66 point estimate. The measured treatment-arm re-collect cost $105.22 (App. M). |
| **`REPORT.md`** (§9) | #10, open, `~operator` | — | $0 | Writing only. |

The figures for Study 2, Study 3 and the Stage 1c replication are this report's estimates on a stated basis, not registered projections. Before committing spend on any of them, the authoritative number is a `--dry-run` against the store the run will use. A populated store calibrates the projection (`lib/calibration.mjs`).

## 4. Open decisions for the operator

These are recorded for #185, not decided here.

- **Is the registered grid still owed?** Three options: run it (§3.2); run Study 2 only, which answers "which model" without panel confounds; or close H1–H5 formally in a final dated appendix. If the last, the write-up must say the registered study was **replaced**, not completed.
- **Is the Study 1 verdict enough to stop?** The verdict: differentiation is the whole game; panels do not pay on distinctness; rich personas trade feasibility for originality. If the narrowing stage is the product's real value claim (#133), nothing collected so far tests it.
- **Commit the Stage 1b re-run and Stage 1c stores?** If they were committed, stripped of embedding vectors as Stage 1a's was (`status-2026-09-08.md`, "Store handling"), anyone could check the two headline results rather than only the operator.
