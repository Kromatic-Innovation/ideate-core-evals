# ideate-core — Comparative Ideation Study (eval spec v0.1)

> ## 🔒 Pre-registration
>
> **This document is a pre-registration: it states the hypotheses, metrics, and analysis plan BEFORE any data is collected.** That is what makes a confirmatory result meaningful rather than a story fitted to whatever the data happened to show.
>
> Its credibility rests on being verifiably prior. This repository is public and the git history is the timestamp — the commit that introduced this file predates every result in `REPORT.md`, and anyone can check that.
>
> **Amendment rule.** Changes to §6 (hypotheses and analysis plan) after data collection begins are _amendments_, not edits. They must be added as a dated appendix that states what changed and why, never applied in place. A silently rewritten analysis plan is not a pre-registration.
>
> Nothing has been run. Every number below is a projection.

**Status:** pre-registration draft.
**Date:** 2026-07-30 · **Target engine:** ideate-core `@0.4.0` (npm, published 2026-08-02) — pinned.

> _Amended 2026-08-02 ([Appendix A](#appendix-a--amendments-dated-2026-08-02), item 1). Was: `Target SHA: ideate-core develop @ 920c086 + fix A1`. That SHA predates the remediation; `ideate-core@0.4.0` contains the fixes for **both** registered blockers (B1, B2). The runtime `engineSha` in the manifest is now the resolved package version (`ideate-core@0.4.0`) rather than the `"unpinned"` literal `evals/run.mjs` originally shipped._

---

## 0. What this is, and what it is not

This is **not** a regression eval of a fixed configuration. It is a **comparative research study** whose output is a ranked, statistically defensible answer to:

> Which generator-model configuration produces the most _usefully diverse_ idea pool per dollar, and does ideate-core's multi-agent machinery beat a single call at all?

Two consequences follow, and they shape everything below:

1. **The unit of analysis is the POOL, not the idea.** ideate-core's claims are pool-level (diversity, non-duplication, cross-theme coverage). Scoring individual ideas and averaging destroys exactly the property under test — a pool of 30 excellent near-identical ideas scores well per-idea and is worthless. Standard idea-level benchmarks are used here only as _calibration instruments_, never as the primary outcome.
2. **The study must be able to refute the product.** The single-call baseline (Arm A) exists so that "multi-agent beats one call" is a _finding_, not an assumption. If Arm A wins on cost-adjusted diversity, that is a publishable result about ideate-core and we report it.

### The user's prompt is unknowable — and that's fine

The app takes an arbitrary user brief, so we cannot eval "the prompt." We hold the prompt **constant across arms** and vary only the model configuration. The brief becomes a random effect in the statistical model (§6), which is precisely how you generalize beyond the specific briefs tested. We are measuring the _engine_, controlling for the prompt — not measuring the prompt.

---

## 1. Blockers — do not run before these land

| #   | Blocker                                                                       | Why it invalidates the study                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1  | **Audit finding IC-01** (duplicate candidate IDs when agents share a persona) | Mixed-tier arms (E, F, G) assign the same persona to different models. At the original SHA that collides IDs and **silently deletes candidates downstream** (verified: 7 in → 5 out). Every diversity metric would be computed on a silently truncated pool, biased _against_ the mixed arms — i.e. it would fake a result. Fix = the verified one-liner in the audit (`ctx.temperature` → `ctx.agentId`). **✅ CLOSED — `ideate-core#87`, 2026-07-31; shipped in `ideate-core@0.4.0`** (Appendix A, item 2). |
| B2  | **`temperature` is rejected by current frontier models**                      | Opus 5, Sonnet 5, Opus 4.8/4.7 and Fable 5 return **HTTP 400** if `temperature` is sent. `DEFAULT_PERSONAS` sets `temperature: 0.4…1.0` and `safeComplete` forwards it. Haiku 4.5 still accepts it. So a mixed haiku/sonnet/opus panel **400s on 3 of 5 agents** unless the adapter strips the parameter per-model. See §3.3. **✅ CLOSED — `ideate-core#89`, 2026-07-31; `ideate-core@0.4.0` exports the strip-and-warn helper at `ideate-core/integrations/sampling-params`** (Appendix A, item 2).         |
| B3  | **No token accounting in ideate-core**                                        | The cost ledger (§7) needs per-call token counts. The engine currently discards the provider's `usage` object entirely. The adapter must capture it (no core change required — the adapter owns the client). **✅ CLOSED, with two named exceptions — `#53`'s routing audit; see [Appendix B, item 4](#appendix-b--amendments-dated-2026-09-01)**.                                                                                                                                                            |

B2 is also a **finding about the library**, not just the eval: ideate-core documents temperature as a per-agent diversity lever, and that lever is now unavailable on most current Anthropic models. Persona is the only surviving structural lever — which happens to be what the literature says is stronger anyway (Wang et al. 2023), but the docs should say "unavailable on current frontier models," not present it as a live knob. _(2026-08-02: `ideate-core` now has **zero** open issues — the 20-finding audit `ideate-core#86` that produced B1 and B2 is fully remediated, including its two cross-repo template items. See Appendix A, item 2.)_

> _Amended 2026-09-01 ([Appendix B](#appendix-b--amendments-dated-2026-09-01), item 4). B3 above is marked CLOSED, conditional on `#53`'s routing audit (merged `#56`) fixing a real judge-validation metering bypass. Two exceptions are named and remain residual threats, not closed: (1) a client-side batch-poll timeout can leave a still-billing server-side batch unaccounted; (2) `ideate-core`'s opt-in evaluator/embedder hooks are unwired today but would need explicit metering if enabled. See the appendix item for the full record._

---

## 2. Prior work — what we can reuse as an answer key

Verified against current sources (2026-07-30). **These are the assets that turn this from a vibes-comparison into a calibrated measurement.**

| Asset                                                                                                                                                                                                    | What it gives us                                                                                                                                                                                                                  | How we use it                                                                                                                                                                                                                   | License / access                                             |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| **NoveltyBench** (arXiv [2504.05228](https://arxiv.org/abs/2504.05228), [site](https://novelty-bench.github.io/))                                                                                        | `distinct_k` — cluster k generations into semantic equivalence classes, count occupied classes. Published finding: SOTA models yield **<4 distinct responses in 10 samples**, and **novelty scales _inversely_ with model size**. | **Primary metric.** `distinct_k` is conceptually identical to ideate-core's dedup+cluster stage, so we adopt their metric rather than inventing one. Their inverse-scaling finding becomes registered hypothesis **H4**.        | Public                                                       |
| **Si, Yang & Hashimoto 2024** — _Can LLMs Generate Novel Research Ideas?_ (arXiv [2409.04109](https://arxiv.org/abs/2409.04109), code [NoviScl/AI-Researcher](https://github.com/NoviScl/AI-Researcher)) | ~300 ideas across 3 conditions (Human / AI / AI+Rerank) with blind reviews from **79 expert reviewers**, numerical scores + rationales. MIT-licensed repo; idea/review payloads on Google Drive.                                  | **Human answer key for judge validation (§5).** Our LLM judge must reproduce expert _rankings_ on a held-out slice before it is allowed to score our pools. Also supplies a **human novelty baseline** to anchor the scale.     | MIT (repo); verify Drive payload terms before redistribution |
| **OCSAI** — Open Creativity Scoring w/ AI ([openscoring.du.edu](https://openscoring.du.edu/))                                                                                                            | Fine-tuned scorer trained on **27,000 human-judged** divergent-thinking responses; **r = 0.81 with human raters**; originality on a 1–5 scale; free API.                                                                          | **Pre-calibrated second judge.** Its human correlation is _published_, so it is an instrument with known error — far stronger than an uncalibrated LLM judge. Used on the AUT-style probe items (§4.2).                         | Free API; confirm rate limits + ToS for programmatic use     |
| **LiveIdeaBench** (arXiv [2412.17596](https://arxiv.org/abs/2412.17596), _Nature Communications_; [code](https://github.com/x66ccff/liveideabench))                                                      | 1,180 single-keyword prompts across 18 scientific domains; 4-axis rubric (originality / feasibility / fluency / flexibility).                                                                                                     | **Brief corpus source** for the science-domain stratum, and the **rubric wording** for our judge prompt (reusing a peer-reviewed rubric beats writing our own).                                                                 | Public repo                                                  |
| **Divergent Association Task** (Olson et al. 2021, PNAS; [code](https://github.com/jayolson/divergent-association-task))                                                                                 | Semantic-distance creativity measure with published human norms.                                                                                                                                                                  | **Sanity check on our diversity metric.** Run DAT through our embedding pipeline; if our pool-diversity number doesn't reproduce DAT's ordering on its own normed data, our metric is broken before we point it at ideate-core. | Public                                                       |

**Honest limits of the answer keys.** Si et al. is _research ideation by NLP experts_ — a narrow domain, and our briefs are mostly business/product. It calibrates the _judge_, not the task. OCSAI is trained on Alternate-Uses responses, which are much shorter than our candidates; treat its absolute scores as suspect and use it only for _relative_ ordering. Neither is a ground truth for "good marketing idea." Stated so the report can't overclaim.

---

## 3. Design

### 3.1 Arms (9 configurations)

Panel size fixed at **5 agents**, `ideasPerAgent: 6`, `maxRounds: 2` (blind → pool) for every panel arm, so the _only_ thing varying is model assignment.

| Arm   | Configuration                                                                            | Purpose                                                                                                                                                               |
| ----- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A** | **Solo baseline** — 1 call, "generate 30 genuinely different ideas", no panel, no rounds | **The control that can falsify the product.** This is the "most ideation wrappers are one call" strawman the README claims to beat. Matched on total ideas requested. |
| **B** | Homogeneous **Haiku 4.5** ×5                                                             | Cheap floor; tests NoveltyBench inverse-scaling (H4)                                                                                                                  |
| **C** | Homogeneous **Sonnet 5** ×5                                                              | Mid tier                                                                                                                                                              |
| **D** | Homogeneous **Opus 5** ×5                                                                | Expensive ceiling                                                                                                                                                     |
| **E** | **Anthropic tiered mix** — 2×Haiku, 2×Sonnet, 1×Opus                                     | The "combination" hypothesis (H2): does heterogeneity buy diversity cheaply?                                                                                          |
| **F** | **Anthropic inverted mix** — 2×Opus, 3×Haiku                                             | Separates _heterogeneity_ from _average capability_: E and F differ in tier mix at similar spread                                                                     |
| **G** | **Cross-provider mix** — 3×Anthropic (H/S/O), 2×OpenAI                                   | The cross-provider claim (H3)                                                                                                                                         |
| **H** | Homogeneous **OpenAI** ×5                                                                | Control for G — isolates "cross-provider" from "OpenAI is just different"                                                                                             |

**Ablation arm (cheap, high value):** **A′** — panel of 5 identical models with _identical personas_ (persona lever disabled). Isolates how much of the panel's benefit is persona engineering vs. merely sampling 5 times. Costs one extra arm; answers the question a skeptical reviewer asks first.

> _Amended 2026-09-01 ([Appendix C](#appendix-c--amendments-dated-2026-09-01), items 1 and 4). Arm A's row above says "Matched on total ideas requested" — true of round-1 requests only. At the pool level (the unit `distinct_k` is computed over) Arm A's pool is ~30 and every panel arm's is ~60, including **A′** above, which is itself a panel. See the appendix for the correction and the registered rarefaction rule that operationalizes §6.1's "at matched idea count" clause against this gap._

### 3.2 Items (briefs) — n = 12, stratified

Held constant across arms. Stratified so results generalize across task type, not just one domain:

| Stratum                    | n   | Source                                                       |
| -------------------------- | --- | ------------------------------------------------------------ |
| Business / go-to-market    | 4   | Authored; the actual use case                                |
| Product / feature ideation | 3   | Authored                                                     |
| Scientific                 | 3   | Sampled from LiveIdeaBench keyword set (traceable, external) |
| Classic divergent-thinking | 2   | AUT-style ("uses for X") — the only stratum OCSAI can score  |

Briefs are **frozen and hashed** into the run manifest. Adding a brief mid-study invalidates the pre-registration.

> _Amended 2026-09-01 ([Appendix B](#appendix-b--amendments-dated-2026-09-01), item 13). The corpus above (n = 12, 4/3/3/2 per stratum) is expanded to **24 briefs, 6 per stratum** (`evals/corpus/briefs.mjs`, issue #43), corpus hash `55e05c2811a7`. The 3 original scientific keywords are preserved as an exact prefix under the same seed — only 3 additional scientific briefs were appended, none re-rolled. Business and product-stratum briefs are authored by the product's owner — disclosed here. See the appendix for the full record._

### 3.3 Held constant (and the awkward part)

Same prompt builders, same `ideasPerAgent`, same personas, same rounds, same embedder, same judge panel, same seed for all non-model randomness.

> _Amended 2026-09-01 ([Appendix C](#appendix-c--amendments-dated-2026-09-01), item 1). "Same rounds" above is false: Arm A runs `maxRounds: 1`; every panel arm runs `maxRounds: 2`. See the appendix for the correction and its consequences._

**Temperature cannot be held constant, and this is a real threat to validity.** Per B2, Haiku 4.5 accepts `temperature`; Opus 5 / Sonnet 5 reject it with a 400. So we cannot run all arms at matched temperature. Options, with the honest trade-off:

| Option                          | Trade-off                                                                                                                                                   | **Chosen** |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| Strip `temperature` everywhere  | Haiku runs at its default instead of the persona's tuned value — _removes_ a diversity lever the haiku arms would otherwise have, biasing **against** B/E/F | ✅ **Yes** |
| Send temperature where accepted | Confounds model with sampling policy — B's advantage would be uninterpretable                                                                               | No         |

We strip it universally and **state the bias direction explicitly**: if the haiku arms still win on diversity, they did so with one lever disabled, which strengthens rather than weakens the finding. If they lose, the result is confounded and must be reported as such. This is registered in advance so it can't be rationalized after the fact.

> **Implementation note (2026-08-02, [Appendix A](#appendix-a--amendments-dated-2026-08-02) item 3). The registered universal-strip decision above is UNCHANGED.** Recorded so a reader can see the code matches the registered decision rather than the library default: `ideate-core@0.4.0` ships `modelAcceptsSamplingParams` (at `ideate-core/integrations/sampling-params`), which strips **per-model** and returns `true` for Haiku. Using that helper unmodified would leave the Haiku arms the diversity lever and **invert** the registered bias direction — which materially affects **H4** (Haiku panel ≥ Opus panel). The generation adapter therefore **force-strips on every model**, Haiku included, rather than deferring to the helper's per-model default.

### 3.4 Replication and power

**Why replicate at all:** a single run per (arm × brief) measures one draw from a stochastic process. Sampling variance in LLM generation is large relative to the between-arm effects we care about; without replication we'd be ranking noise.

- **n = 4 independent runs per (arm × brief).** 9 arms × 12 briefs × 4 = **432 runs**.
- Runs differ only by run index (no seed control is possible — the APIs don't expose one; this is a limitation, not a choice).
- **Power:** run a **pilot** (§8, Phase 1) at 2 arms × 4 briefs × 4 reps to estimate the between-run variance component, then _recompute_ required n before committing to the full grid. Do not trust the n=4 figure until the pilot says so — it is a placeholder chosen for budget, not derived from a variance estimate we have.

---

## 4. Metrics

### 4.1 Primary (pool-level)

| Metric                      | Definition                                                                                                                                                                                                | Provenance                                                                                                                       |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| **`distinct_k`**            | Number of semantic equivalence classes occupied by the pool, via embedding clustering                                                                                                                     | NoveltyBench                                                                                                                     |
| **`distinct_k` per dollar** | `distinct_k` ÷ run cost                                                                                                                                                                                   | **The headline metric.** Answers the question actually asked.                                                                    |
| **Pool diversity**          | Mean pairwise cosine _distance_ across the embedded pool                                                                                                                                                  | ideate-core's own `poolDiversity` — tests the library's own metric                                                               |
| **Collapse rate**           | 1 − (semantic-dedup survivors ÷ raw candidates)                                                                                                                                                           | Direct mode-collapse measure                                                                                                     |
| **Fluency / Flexibility**   | LiveIdeaBench axes: count of valid candidates emitted; breadth of distinct categories (clusters) covered — pool properties, computed by `evals/metrics/operational.mjs` (`poolFluency`/`poolFlexibility`) | See §4.2 amendment below — moved here from the idea-level table ([Appendix B](#appendix-b--amendments-dated-2026-09-01), item 2) |

> _Amended 2026-09-01 ([Appendix C](#appendix-c--amendments-dated-2026-09-01), item 3). In any Arm-A contrast (§3.1), `distinct_k`, `poolFluency`, and collapse rate are computed on the **rarefied** pool (registered rule: Appendix C item 2); pool diversity and `distinct_k` per dollar are computed on the **full pool**. See the appendix for the per-metric rationale._

### 4.2 Secondary (idea-level, split axes — never collapsed)

| Metric                        | Notes                                                                                          |
| ----------------------------- | ---------------------------------------------------------------------------------------------- |
| **Novelty** (judged, 1–5)     | Split-axis per Rietzschel et al. 2010 — _never_ averaged with feasibility into a single "best" |
| **Feasibility** (judged, 1–5) | Same                                                                                           |
| **OCSAI originality**         | AUT stratum only; instrument with published r = 0.81 to humans                                 |
| **Fluency / Flexibility**     | LiveIdeaBench axes: valid candidates emitted; distinct categories covered                      |

> _Amended 2026-09-01 ([Appendix B](#appendix-b--amendments-dated-2026-09-01), items 1–2). Novelty/Feasibility's registered scale was 1–5; the judge implementation (`evals/judge/prompt.mjs`) scores 1–10, and the code is kept (more resolution, the gate is rank-based) rather than narrowed to match this table. Fluency/Flexibility are POOL properties (count of valid candidates, breadth of distinct categories), not per-idea judgments — a per-idea judge scoring them was never coherent (it sees one candidate at a time, never the pool) — moved to §4.1 as operational metrics. See the appendix for the full record._
>
> _Amended 2026-09-01 ([Appendix B](#appendix-b--amendments-dated-2026-09-01), item 11). The OCSAI row above is demoted: no longer a registered comparator with claimed calibration, registered instead as exploratory, relative-ordering only, obtained under a self-imposed conservative throttle (issue #17). Report request count, throttle, and date alongside any OCSAI number. See the appendix for the full record._

### 4.3 Operational (the ones that bite in production)

| Metric                      | Why it matters                                                                                                                                  |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| **Parse-failure rate**      | Fraction of agent replies from which `extractCandidates` recovered nothing. Directly measures the robustness ideate-core advertises, per model. |
| **Empty-pool rate**         | Runs returning `candidates: []` — the silent-failure mode from audit IC-08                                                                      |
| **Refusal rate**            | Opus 5 / Sonnet 5 can return `stop_reason: "refusal"`; must be counted, not silently dropped                                                    |
| **Latency (p50 / p95)**     | Wall-clock per run                                                                                                                              |
| **Tokens in / out / cache** | Per model. Feeds the cost ledger (§7)                                                                                                           |

### 4.4 Negative controls (do these first — they catch a broken harness)

A study that can't fail its own sanity checks isn't measuring anything.

| Control                                                                         | Expected result                                      | Catches                                 |
| ------------------------------------------------------------------------------- | ---------------------------------------------------- | --------------------------------------- |
| **Duplicate pool** — 30 copies of one idea                                      | `distinct_k` = 1, diversity ≈ 0                      | Broken dedup/embedding wiring           |
| **Random-text pool** — 30 unrelated sentences                                   | `distinct_k` ≈ 30, diversity near max                | Metric saturation / clustering collapse |
| **Shuffled-label control** — judge the same pool twice with arm labels permuted | No score difference                                  | Label leakage into the judge            |
| **DAT replication**                                                             | Reproduces published DAT ordering on its normed data | Embedding pipeline validity (§2)        |

> _Amended 2026-09-01 ([Appendix B](#appendix-b--amendments-dated-2026-09-01), item 12). The shuffled-label control above is vacuous by construction — `deidentify.mjs` enforces that the judge never sees arm/model/persona labels, so permuting labels it never receives cannot change its score. Replaced with a judge test-retest repeatability control: the same de-identified pool scored twice, reporting test-retest ρ. See the appendix for the full record._

---

## 5. The judge — validate the instrument before using it

**You cannot measure with an uncalibrated instrument.** The judge is validated _first_, and gated.

### 5.1 Validation gate

1. Hold out a slice of Si et al. ideas with expert scores.
2. Judge scores them blind.
3. **Gate:** Spearman ρ between judge and expert _rankings_ must clear a pre-registered floor (**ρ ≥ 0.4**, in the neighborhood of the human-human inter-rater agreement Si et al. themselves report — confirm their reported figure and set the floor to it, rather than to a number we like).
4. **If the gate fails, the idea-level metrics are dropped from the study** and we report pool-level metrics only. We do not proceed with a judge we know doesn't track humans. This is registered in advance.

> **⚠️ Amended 2026-08-02 ([Appendix A](#appendix-a--amendments-dated-2026-08-02), item 4) — the gate metric and floor in point 3 are SUPERSEDED. Point 4's consequence is unchanged.**
>
> **Si et al. 2024 do not report a human-human Spearman ρ** (verified against arXiv:2409.04109 on 2026-08-02; footnote 11 explicitly rejects correlation-style agreement metrics like Krippendorff's α for their non-overlapping reviews). The number point 3 reaches for **does not exist**, so the `ρ ≥ 0.4` placeholder rests on a false premise and is **withdrawn**.
>
> **Registered replacement.** The gate metric becomes Si et al.'s **own** split-half top/bottom-25% **balanced-accuracy** construction (Lu et al. 2024; Si et al. Section 5 / Table 11), floored at their reported **human-human figure, 56.1%** — the faithful reading of point 3's own instruction to "confirm their reported figure and set the floor to it." Spearman ρ is **retained as a descriptive statistic** (still computed and reported) but is no longer the gate. Three registered consequences, all recorded before any data is collected — see Appendix A item 4 for the full construction and the 53.3% Claude-3.5 comparator.
>
> **Which axis, against which column ([Appendix A](#appendix-a--amendments-dated-2026-08-02) item 7).** Point 1's "expert scores" is one column and point 2's "judge scores them" is one of four axes — the mapping between them was never registered. Item 7 registers it: the judge's **`originality`** axis validates against the Si et al. **`overall_score`** column, with the construct mismatch disclosed. It also records the shape-matched **51.7%** (Claude-3.5 _Direct_) comparator alongside the existing 53.3% (_Pairwise_), and the median-threshold / split-count construction deviations.

### 5.2 Self-preference bias — measured, not assumed

Wataoka et al. 2024: models rate their own output higher. Every arm here is scored by _some_ model, so this is a live confound.

**Design:** full **cross-judge matrix** — every pool scored by both an Anthropic judge and an OpenAI judge, neither of which may be a generator in that arm (enforced by ideate-core's own `assertEvaluatorDistinct`). The bias term is then _estimated_ as a model coefficient (§6) rather than hoped away. Registered hypothesis **H5** predicts a non-zero same-provider bias; if we find one, all cross-provider comparisons are reported **bias-adjusted**.

### 5.3 Judging hygiene

- Ideas **de-identified** — no model/persona/arm label reaches the judge
- Presentation **order randomized** per judge call (position bias)
- Judge prompt **frozen and hashed**; changing it restarts the study
- **Score-only, no reasoning-then-score drift**: identical rubric wording per call, drawn from LiveIdeaBench's published axes

---

## 6. Analysis plan (frozen before data collection)

### 6.1 Registered hypotheses

| ID     | Hypothesis                                                                     | Direction                | Falsifies what                                                                                                                                               |
| ------ | ------------------------------------------------------------------------------ | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **H1** | Any panel arm > Arm A (solo) on `distinct_k` at matched idea count             | Panel > solo             | **The product's core claim.** If null, ideate-core's machinery isn't earning its complexity.                                                                 |
| **H2** | Mixed-tier (E) ≥ homogeneous-Opus (D) on `distinct_k` at materially lower cost | E ≥ D, cost(E) < cost(D) | The "combination" pitch                                                                                                                                      |
| **H3** | Cross-provider (G) > best within-provider (D or H) on `distinct_k`             | G > max(D,H)             | The heterogeneity claim (Wataoka)                                                                                                                            |
| **H4** | Haiku panel (B) ≥ Opus panel (D) on `distinct_k`                               | B ≥ D                    | NoveltyBench inverse-scaling, **replicated on pools**. A genuinely surprising prediction — registering it in advance is what makes confirming it meaningful. |
| **H5** | Same-provider judging inflates scores vs cross-provider                        | bias > 0                 | Judge validity                                                                                                                                               |

> _Amended 2026-09-01 ([Appendix C](#appendix-c--amendments-dated-2026-09-01), item 2). H1's "at matched idea count" clause above is unchanged — this is a specification of how it is operationalized, not an amendment to the hypothesis: rarefy every pool in an Arm-A contrast to the minimum pool size present, `distinct_k` averaged over `RAREFACTION_R = 1000` random subsamples at seed `RAREFACTION_SEED = 20260901` (`evals/analysis/rarefaction.mjs`). See the appendix for the full rule, why no pool size is hardcoded, and why truncation to the first n is ruled out._

### 6.2 Model

Runs are **nested** (runs within brief within arm) and briefs are crossed with arms. A t-test on arm means ignores that structure and inflates false positives.

```
distinct_k ~ arm + (1 | brief) + (1 | brief:arm)
```

Mixed-effects (random intercept for brief; random arm-slope-by-brief to allow arm effects to vary by task type). Cost analyses use the same form with `log(cost)` as an offset. Judge-score models add `judge_provider` and `judge_provider × generator_provider` to estimate H5's bias term.

- **Effect sizes with 95% CIs are the headline**, not p-values. "Arm E yields 3.1 more distinct ideas (95% CI 1.8–4.4)" is decision-relevant; "p < 0.05" is not.
- **Multiplicity:** 5 registered hypotheses + pairwise arm contrasts → **Holm–Bonferroni** on the registered set; Benjamini–Hochberg on exploratory contrasts, reported separately and **labeled exploratory**.
- **Pre-registered stopping rule:** the full grid runs to completion. No peeking-and-stopping.

### 6.3 What we will NOT do

- Not report a single "best model" — the output is a **cost/diversity Pareto frontier**; the right pick depends on budget
- Not collapse novelty and feasibility into one score
- Not drop failed runs silently — parse failures and refusals are _findings_ (§4.3), reported per arm
- Not re-run an arm that "looks wrong" without registering the re-run

---

## 7. Cost accounting — conforms to the cron-fleet / CFO contract

The harness emits a ledger row per run matching **cwc#1639 / cron-fleet#35 / #75** requirements (read at `code-workspace-config` cwc#1639 and `cron-fleet/lib/cron-health/fleet-cost.mjs`):

1. **Price at READ TIME from `model` + token counts + billing regime.** The ledger stores the _fact_ (tokens × model × timestamp), never a derived dollar figure as authoritative — the exact defect cron-fleet#75 exists to fix.
2. **Row carries** `model`, `input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`, `billing_mode`, timestamp. **No `cost_usd` column.**
3. **`billing_mode: "api"`** for this study (real metered spend). A subscription-mode row would carry `notional_usd`, never `cost_usd` — and the report must name the regime for any dollar figure it shows.
4. Multi-model runs use **`tokens_by_model`** (the schema-v2 field for a run spanning models) — mandatory for the mixed arms E/F/G.

A separate `price.mjs` applies a **pinned, dated rate table** at read time. Re-pricing the whole study after a rate change is then a one-line re-run, not a re-collection.

---

## 8. Budget

### 8.1 Rates (verified 2026-07-30)

| Model                             | In $/MTok                      | Out $/MTok          | Source                                                                       |
| --------------------------------- | ------------------------------ | ------------------- | ---------------------------------------------------------------------------- |
| Claude Opus 5                     | 5.00                           | 25.00               | claude-api skill (cached 2026-06-24)                                         |
| Claude Sonnet 5                   | 3.00 (2.00 intro → 2026-08-31) | 15.00 (10.00 intro) | same                                                                         |
| Claude Haiku 4.5                  | 1.00                           | 5.00                | same                                                                         |
| OpenAI `gpt-5.6-terra` (mid tier) | 2.00                           | 12.00               | **developers.openai.com/api/docs/pricing — verified first-party 2026-08-02** |
| OpenAI `gpt-5.6-sol` (large tier) | 5.00                           | 30.00               | same                                                                         |
| Voyage-4-lite embeddings          | 0.02                           | —                   | + **200M free tokens/account**; batch −33%                                   |

> _Amended 2026-08-02 ([Appendix A](#appendix-a--amendments-dated-2026-08-02), item 5). The OpenAI row previously read `~2.00–5.00 / ~12.00–30.00` sourced from "aggregator sites, not openai.com — must verify before running". Now verified first-party against `developers.openai.com/api/docs/pricing` (2026-08-02); the **50% Batch API discount** is confirmed on the same page. The full per-model OpenAI rate table lives with the OpenAI adapter (#22) and in `lib/price.mjs`'s dated `RATE_TABLE` + `OPENAI_PRICE_VERIFICATION` record. **Anthropic rates are correct as written and are unchanged.**_

**Two levers cut this roughly in half:**

- **Anthropic Batch API: −50%.** Evals are latency-insensitive → ideal fit. (Not available on Bedrock/Vertex; first-party only.)
- **OpenAI Batch API: −50%**, same rationale.

Embeddings are **effectively free** under Voyage's 200M-token free allocation.

### 8.2 Projection

Per-run estimate ≈ 16k input / 9k output tokens (5 agents × 2 rounds, pool-sharing inflates round-2 input).

| Arm                                                      | Batch cost/run (est.) | Runs    | Subtotal  |
| -------------------------------------------------------- | --------------------- | ------- | --------- |
| A (solo)                                                 | ~$0.02                | 48      | $1        |
| A′, B (haiku)                                            | ~$0.03                | 96      | $3        |
| C (sonnet)                                               | ~$0.06                | 48      | $3        |
| D (opus)                                                 | ~$0.15                | 48      | $7        |
| E, F (mixed)                                             | ~$0.08                | 96      | $8        |
| G, H (openai)                                            | ~$0.09                | 96      | $9        |
| **Generation subtotal**                                  |                       | **432** | **~$31**  |
| Judging (2 judges × 432 pools, batched)                  | ~$0.05/pool           | 864     | ~$43      |
| Judge validation (§5.1)                                  | one-off               | —       | ~$5       |
| Embeddings                                               | free tier             | —       | ~$0       |
| **Projected total**                                      |                       |         | **~$79**  |
| **With 2× contingency** (pilot, re-runs, failed batches) |                       |         | **~$160** |

**Under the $200 ceiling with real headroom.** The contingency is not padding — a pilot that changes n (§3.4) is the single most likely reason this grows, and it should be allowed to.

**Hard cost controls in the harness:**

- A `--max-spend` pre-flight that prices the _planned_ grid from the pinned rate table and **refuses to start** if the projection exceeds the ceiling
- Per-batch spend logged to the ledger as it lands; running total checked between phases
- Phase gates (§8.3) — no phase starts without an explicit go

### 8.3 Phased execution

| Phase | What                                       | Cost | Gate                                  |
| ----- | ------------------------------------------ | ---- | ------------------------------------- |
| **0** | Negative controls (§4.4) + DAT replication | ~$0  | All controls pass, or stop            |
| **1** | Judge validation vs Si et al.              | ~$5  | ρ ≥ floor, or drop idea-level metrics |
| **2** | Pilot: 2 arms × 4 briefs × 4 reps          | ~$5  | Estimate variance → **recompute n**   |
| **3** | Full grid                                  | ~$70 | —                                     |
| **4** | Analysis + report                          | $0   | —                                     |

---

## 9. Deliverables

| Artifact             | Description                                                                    |
| -------------------- | ------------------------------------------------------------------------------ |
| `evals/harness/`     | Runner: arm configs, batch submission, ledger emission, resume-on-failure      |
| `evals/metrics/`     | `distinct_k`, diversity, collapse rate, DAT check, negative controls           |
| `evals/judge/`       | Judge prompts (frozen + hashed), cross-judge matrix, Si et al. validation      |
| `evals/corpus/`      | 12 frozen briefs + hashes + provenance                                         |
| `evals/analysis/`    | Mixed-effects model, contrasts, Pareto frontier plot                           |
| `evals/ledger/`      | Repriceable cost rows (§7) + `price.mjs` with dated rate table                 |
| `REPORT.md`          | Findings, effect sizes + CIs, Pareto frontier, registered-vs-exploratory split |
| `PREREGISTRATION.md` | This document, frozen and hashed at run start                                  |

**Not wired into CI** (per instruction). Runs on demand via `node evals/run.mjs --phase N`. The negative controls (Phase 0) are hermetic and _could_ run in CI later at zero cost — flagged as an option, not built.

---

## 10. Threats to validity — stated up front

| Threat                                                  | Mitigation                                                       | Residual                                                           |
| ------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------ |
| Temperature unavailable on frontier models (B2)         | Strip universally; state bias direction                          | Real. Biases against haiku arms; can't be eliminated               |
| Judge ≠ human                                           | Validate vs Si et al.; gate on ρ                                 | Si et al. is research-ideation, not business ideation              |
| Self-preference bias                                    | Cross-judge matrix; estimate bias term                           | Only two providers judged; a third would triangulate better        |
| Model versions drift                                    | Pin exact model IDs in manifest; record at run time              | Providers can change a model behind a stable ID                    |
| Embedding model shapes diversity metric                 | DAT replication as validity check; single embedder held constant | An embedder that can't separate our domain would compress all arms |
| 12 briefs may not generalize                            | Stratified; brief as random effect                               | Still 12. Report per-stratum effects                               |
| Prompt builders tuned (unintentionally) to one provider | Same builder everywhere; generic wording                         | Untested — could add a prompt-variant robustness check             |

> _Amended 2026-09-01 ([Appendix C](#appendix-c--amendments-dated-2026-09-01), item 7). "DAT replication as validity check" (row: "Embedding model shapes diversity metric") is a real but weak mitigation — reported, not verified against a committed artifact in this repo: over 3,000 seeds, a semantics-free SHA-512-of-text embedder cleared the DAT ordering 16.4% of the time (null 16.7%) and cleared all three negative controls together 1.9% of the time (reproducible witness: seed 97). About 0.8 bits of evidence, not a guarantee the embedder carries real semantics. See the appendix item for the full construction._

---

## 11. Additive accumulation — and the statistical hazard it creates

Results **accumulate**. A run contributes cells to a durable store rather than replacing it, so replicate count grows across sessions instead of being re-collected. `lib/manifest.mjs` implements this: a cell is `(arm, brief, replicate)` keyed by a `configHash` over everything that could change the measurement (engine SHA, prompt hash, judge hash, embedder, panel shape).

Three properties, all tested in `lib/manifest.test.mjs`:

- **Reuse** — completed cells under the same config are never re-run.
- **Extend** — raising `replicates` or adding an arm queues _only_ the new cells.
- **Never silently pool** — change the engine SHA or a brief and the config hash changes, so prior cells get a different key. They are not reused, and they are not deleted; `planRun` returns them as `stale` for the analysis to consider explicitly.

### ⚠️ The hazard: optional stopping

**Accumulating data and re-analyzing after each batch is [optional stopping](https://en.wikipedia.org/wiki/Optional_stopping_theorem), and it inflates false-positive rates badly** — with naive repeated testing at α = 0.05, the probability of eventually crossing significance approaches 1 as you keep adding data. "Run 20, look, run 200, look again" is exactly the shape that breaks a fixed-α analysis.

This is a real tension with the additive design, and it is resolved by _separating the two things accumulation is good for_:

| Use of accumulated data                                                  | Allowed?                        | Why                                                                                                  |
| ------------------------------------------------------------------------ | ------------------------------- | ---------------------------------------------------------------------------------------------------- |
| **Precision** — tighter CIs on an effect whose n was fixed in advance    | ✅ Yes                          | Estimation, not testing. More data narrows the interval; no α is being spent.                        |
| **Variance estimation** — pilot informs the n for the confirmatory phase | ✅ Yes                          | This is the pilot's _purpose_. The pilot's own data is then **not reused** in the confirmatory test. |
| **Exploration** — new arms, new briefs, hypothesis generation            | ✅ Yes, **labeled exploratory** | Reported in a separate section with BH correction and no confirmatory claims.                        |
| **Testing a registered hypothesis, then adding data, then re-testing**   | ❌ **No**                       | Optional stopping. This is the one that manufactures false findings.                                 |

**The rule this repo enforces:** the confirmatory analysis of H1–H5 runs **once**, at the pre-registered n determined by the pilot. Everything after that is estimation or exploration, and is labeled as such in `REPORT.md`. If a later run genuinely needs to re-test a registered hypothesis, it requires either a **fresh pre-registration** (new hypothesis, new data) or an **alpha-spending / group-sequential** design declared up front — not a quiet re-run of the same test on a bigger pile.

Both the "pilot for the pilot" (§8.3 Phase 2a) and the additive store are compatible with this, because neither is used to _test_ a confirmatory hypothesis.

---

## 12. Configurability

Every knob the study varies is config, not code:

| Knob                       | Flag                                                      | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| -------------------------- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Spend ceiling              | `--max-spend <usd>`                                       | Pre-flight prices the planned grid from the pinned rate table. This does **not** refuse to start the process outright -- it admission-controls cells: the planned grid is walked in order and a cell is skipped, recorded as `skipped: budget_exceeded`, the moment admitting it would cross the ceiling, so every planned cell still reaches a terminal, reconciled state and none is silently dropped. **Per-invocation, not cumulative:** the running total resets to zero on every invocation, so a resumed run's ceiling gates only what THAT invocation spends, not the study's total spend across every invocation run so far (issue #62 MEDIUM; tracked separately, not fixed by this control).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Per-provider spend ceiling | `--max-spend-anthropic <usd>`, `--max-spend-openai <usd>` | Same admission-control semantics and same per-invocation-only scope as `--max-spend` above, evaluated independently per provider (issue #51 -- a single global ceiling cannot express an asymmetric budget). A tripped ceiling names its provider: `skipped: budget_exceeded:<provider>`. Attribution differs by path: the **pre-flight projection** (before a cell has run) splits a coarse token estimate evenly per model slot (`lib/price.mjs`'s `runnerPriceGrid`); the **actual running total**, tracked as cells complete, is derived from each cell's real `tokens_by_model`, never a flat per-cell assignment -- so a cross-provider cell (arm G) is estimated evenly pre-flight but attributed by real usage once it has actually run. **Undisclosed blind spot, now disclosed:** neither ceiling currently sees the cross-judge matrix's spend (`evals/judge/matrix.mjs` -- every pool is scored by both an Anthropic and an OpenAI judge). Judge spend is roughly half the OpenAI-provider total and the dominant OpenAI cost driver, so `--max-spend-openai` today gates only arm-slot spend, not the study's actual OpenAI exposure. Tracked at issue #63; not fixed by this control. |
| Which arms                 | `--arms A,B,E`                                            | Subset the grid                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Which models               | `arms.config.json`                                        | Model IDs per persona slot, per arm                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Replicates                 | `--replicates <n>`                                        | Additive — raising it queues only new cells                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Briefs                     | `--briefs <ids>`                                          | Subset the corpus                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Phase                      | `--phase <0-4>`                                           | Gated; see §8.3                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Dry run                    | `--dry-run`                                               | Prints the plan, the reuse/todo/stale split, and the cost projection. Calls nothing.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

### Phase 2a — the pilot for the pilot

Before the ~200-run grid, a **~20-run smoke study** (2 arms × 2 briefs × 5 reps, cheapest models) runs end-to-end: generation → metrics → judge → ledger → reconcile → analysis. Its purpose is **not** to measure anything about models. It is to prove the harness produces a complete, reconciled, repriceable dataset and that no stage silently swallows a cell. Its results are discarded from the confirmatory analysis by construction (different `configHash` if anything changed; explicitly excluded if not).

---

## Appendix A — Amendments (dated 2026-08-02)

Per the amendment rule at the top of this document, substantive changes made after the pre-registration was first committed are recorded here as dated entries stating **what changed and why**, never applied silently in place. Each entry is cross-linked from the section it amends.

**Nothing in §6 (hypotheses and analysis plan) is changed by any entry below.** The registered hypotheses H1–H5, the mixed-effects model, the multiplicity correction, and the stopping rule are all exactly as first registered. The amendment rule binds §6; no §6 edit is proposed.

### Item 1 — §0: pin the real engine version (was a stale SHA)

**What changed.** §0's `Target SHA: ideate-core develop @ 920c086 + fix A1` → **`ideate-core@0.4.0`** (npm, published 2026-08-02), pinned. The manifest's runtime `engineSha` is now the resolved package version rather than the `"unpinned"` literal `evals/run.mjs` originally shipped.

**Why.** `920c086` predates the remediation of the registered blockers. `ideate-core@0.4.0` is published and contains the fixes for **both** B1 and B2 (item 2). Pinning the real version is what makes `configHash` (§11) actually change when the engine changes — the whole point of pinning it.

### Item 2 — §1: blockers B1 and B2 are closed; B3 remains open

**What changed.** B1 and B2 are marked **CLOSED** with their issue references; B3 remains **OPEN**.

- **B1** (IC-01, duplicate candidate IDs when agents share a persona — would silently truncate mixed-arm pools and fake a result against arms E/F/G) — fixed, **`ideate-core#87`**, closed 2026-07-31; shipped in `ideate-core@0.4.0`.
- **B2** (`temperature` rejected with HTTP 400 by current frontier models) — fixed, **`ideate-core#89`**, closed 2026-07-31; `ideate-core@0.4.0` exports the strip-and-warn helper at `ideate-core/integrations/sampling-params` (see item 3).
- **B3** (no token accounting in `ideate-core`) — **still open**, and correctly homed in the adapter: it closes when the generation adapter captures the provider's `usage` object. Left standing until then.

**Why.** §1's own instruction is "do not run before these land." B1 and B2 have landed; recording it (with references) is what lets a reader confirm the run is now unblocked on those two. Also worth recording, since §1 framed B2 as "a finding about the library": `ideate-core` now has **zero** open issues — the 20-finding audit `ideate-core#86` that produced B1 and B2 is fully remediated, including its two cross-repo template items.

### Item 3 — §3.3: the shipped strip helper diverges from the library default (decision unchanged)

**What changed.** Nothing in the registered decision — §3.3 still registers stripping `temperature` **universally**, with the stated bias direction (against the Haiku arms). This entry records an **implementation** fact only.

**Why it must be recorded.** `ideate-core@0.4.0` ships `modelAcceptsSamplingParams` (at `ideate-core/integrations/sampling-params`), which strips **per-model** and returns `true` for Haiku. Using that helper unmodified would leave the Haiku arms the diversity lever and **invert** the registered bias direction — which materially affects **H4** (Haiku panel ≥ Opus panel). The generation adapter therefore **force-strips on every model**, Haiku included, so the implementation matches the _registered_ decision rather than the library's per-model default. Recorded so a reader can see the code matches §3.3 rather than silently diverging from it.

### Item 4 — §5.1: the ρ floor rests on a false premise; the gate metric and floor are replaced (**the substantive amendment**)

**What changed.** §5.1's gate metric changes from **Spearman ρ (floored at the placeholder ρ ≥ 0.4)** to **Si et al.'s own split-half top/bottom-25% balanced-accuracy construction, floored at their reported human-human figure of 56.1%**. The arbitrary `0.4` is **withdrawn**. §5.1 point 4's consequence (a failed gate drops idea-level metrics and reports pool-level only) is **unchanged**.

**Why.** **Si et al. 2024 do not report a human-human Spearman ρ** (verified against arXiv:2409.04109 on 2026-08-02). Footnote 11 explicitly rejects correlation-style agreement metrics: the balanced-accuracy metric "avoids the limitations of other agreement metrics like Krippendorff's alpha, which require overlapping reviews and would result in a sparse matrix" — their reviews do not overlap enough to support a correlation statistic. The number §5.1 point 3 reaches for does not exist, so the gate cannot be instantiated as registered.

What they **do** report (Section 5 / Table 11) is a split-half balanced accuracy: reviewers of each paper are randomly split in half; one half ranks the top and bottom 25% of ideas; agreement is measured against the held-out half.

| Comparison                                                  | Balanced accuracy |
| ----------------------------------------------------------- | ----------------- |
| **Si et al. expert reviewers (human-human)**                | **56.1%**         |
| NeurIPS 2021 consistency experiment                         | 66.0%             |
| ICLR 2024 LM-related submissions (1.2K)                     | 71.9%             |
| Best LLM evaluator they tested (Claude-3.5 pairwise ranker) | 53.3%             |

Study size: N = 79 expert reviewers, 298 unique reviews, 49 ideas.

**Three consequences, all registered in advance:**

1. **Spearman ρ is retained as a descriptive statistic** (`evals/judge/gate.mjs`'s `spearmanRho` stays and is still reported), but it is **no longer the gate**. The arbitrary 0.4 is withdrawn.
2. **The floor is demanding, deliberately.** Si et al.'s own best LLM evaluator scored 53.3% and would fail the 56.1% floor. Per §5.1 point 4 the registered consequence is that idea-level metrics are dropped and only pool-level results are reported — an acceptable, pre-registered outcome, provided it comes from a real measurement rather than an unrun gate.
3. **53.3% becomes a registered comparator.** Because Table 11 measures the best LLM evaluator on the _same_ metric, we can state in advance whether our judge beats it, rather than deciding after we look.

The implementing code change (`resolveRhoFloor` → the registered balanced-accuracy floor, `validateJudge` reading the new metric and constant) lands with **#16 / #24**, not here. This entry is the pre-registration record of the decision.

### Item 5 — §8.1: OpenAI rates were aggregator-sourced; now verified first-party

**What changed.** §8.1's OpenAI row (previously `~2.00–5.00 / ~12.00–30.00`, flagged "aggregator sites, not openai.com — must verify before running") is replaced with **first-party verified per-model rates**: `gpt-5.6-terra` (mid) at 2.00 / 12.00 and `gpt-5.6-sol` (large) at 5.00 / 30.00, verified against `developers.openai.com/api/docs/pricing` on 2026-08-02. The **50% Batch API discount** the batch-first budget assumes is confirmed on the same page. **Anthropic rates are correct as written and are unchanged** (Opus 5 $5/$25, Sonnet 5 $3/$15 with the $2/$10 introductory rate through 2026-08-31, Haiku 4.5 $1/$5).

**Why.** §8.1 itself flagged the OpenAI row as unverified and forbade running against it. The full per-model OpenAI table and its verification record live with the OpenAI adapter (#22) and in `lib/price.mjs`'s dated `RATE_TABLE` + `OPENAI_PRICE_VERIFICATION`.

### Item 6 — §3.1 heading: count fix (cosmetic)

**What changed.** The §3.1 heading "Arms (**8** configurations)" → "Arms (**9** configurations)".

**Why.** The arm table is A–H (8) **plus** the A′ ablation, and §3.4 and the epic both say 9 arms. A one-character count correction, folded in with the substantive amendments above rather than spending a separate change on it.

### Item 7 — §5.1: register the judge-axis ↔ expert-column validation mapping, correct the LLM comparator, state the construction deviations

_Registered 2026-08-02, before any judge results are seen — a pre-registration act, not a post-hoc choice._

**What changed.** §5.1's validation gate now registers **which** judge axis is validated against **which** Si et al. expert-review column: the judge's **`originality`** axis ↔ the **`overall_score`** column. The mapping lives as named constants (`JUDGE_VALIDATION_AXIS` / `SI_ET_AL_EXPERT_SCORE_FIELD` in `evals/judge/config.mjs`), and the composition that runs it (`runJudgeValidation`, `evals/judge/validate.mjs`) threads `readSiEtAlSlice → sliceToJudgePool → judge.score → judgeScoresForAxis → validateJudge → recordValidation`, recording the axis and expert column actually used.

**Why `originality` ↔ `overall_score`.**

1. **Why `originality`.** Novelty is the study's primary idea-level metric (§4.2) and Si et al.'s own headline finding, so `originality` is the axis whose validity most needs establishing.
2. **Why `overall_score`.** The registered 56.1% floor (item 4) is human-human split-half agreement on **one column**. The floor is **coupled to the column**: validating against `novelty_score` instead would require deriving and registering a _different_ floor — a second pre-registration act. `overall_score` is the only choice whose floor is already registered.
3. **The construct mismatch is real and is DISCLOSED, not hidden.** This validates a _novelty_ judgment against an _overall-quality_ answer key. `REPORT.md` must state this plainly as a limitation. It is registered here so the limitation is on record before any number is seen. (`feasibility` ↔ `feasibility_score` is a plausible future addition, but it needs its own derived floor and is **not** registered here.)

**Comparator correction — the shape-matched figure is 51.7%, not 53.3%.** Item 4's table registers **53.3%** as "best LLM evaluator". Verified against arXiv:2409.04109 Table 11 (2026-08-02): that figure is **Claude-3.5 Pairwise**. **Claude-3.5 Direct is 51.7%.** Our judge is a _direct, score-only_ scorer, so **51.7% is the apples-to-apples comparator** for our shape; 53.3% remains valid as "their best evaluator of any shape". Both are now registered as named constants (`SI_ET_AL_LLM_COMPARATOR_DIRECT = 0.517`, `SI_ET_AL_LLM_COMPARATOR_PAIRWISE = 0.533`) and both are reported, so the comparison is not misleading.

| Comparison                                                           | Balanced accuracy | Shape         |
| -------------------------------------------------------------------- | ----------------- | ------------- |
| **Si et al. expert reviewers (human-human)** — the floor             | **56.1%**         | —             |
| Claude-3.5 **Pairwise** ranker (their best LLM evaluator, any shape) | 53.3%             | ranker        |
| Claude-3.5 **Direct** score-only (shape-matched to our judge)        | **51.7%**         | direct scorer |

**Construction deviations, stated rather than silently differed.** Our balanced-accuracy construction differs from Si et al.'s in two ways that must be disclosed before any comparison is drawn:

- **Thresholding.** Si et al. threshold LLM evaluators at their **median score**; `balancedAccuracyTopBottom` ranks the labelled top-k/bottom-k set and splits there. Different construction.
- **Split count.** Footnote 11 states they average **20** random splits; `balancedAccuracySplitHalf` defaults to `splits = 100` and `reproduce-si-et-al.mjs` passes **1000**. State the seed and the count with any reported number (item 4 point 1 / `docs/fetching-si-et-al.md`).

**What lands where.** The registered constants (`config.mjs`) and the composition + its hermetic tests (`validate.mjs`, `validate.test.mjs`) land with **#36**. Running the composition against the **real** slice needs the live judge key and metered spend and stays on **#16**; it also depends on the #35 slice-join repair landing first (native `blocked_by` edge). This entry is the pre-registration record of the decision.

---

## Appendix B — Amendments (dated 2026-09-01)

Per the amendment rule at the top of this document. **Nothing in §6 is changed by either entry below.**

### Item 1 — §4.2: judged-axis scale corrected 1–5 → 1–10 (code and registration must agree)

**What changed.** §4.2 registered Novelty and Feasibility as judged on a **1–5** scale. `evals/judge/prompt.mjs`'s `JUDGE_PROMPT` has always scored **1–10**. The registration is corrected to match the code: **1–10**, kept for the judge's extra resolution rather than narrowing the code to 1–5. The original 1–5 text in §4.2 is left in place, marked amended, per the amendment rule.

**Why.** A registered value that disagreed with the shipped code would silently misdescribe every judge score in `REPORT.md`. Caught during the review pass on issue #45.

### Item 2 — §4.1/§4.2: Fluency/Flexibility are pool properties, moved out of the per-idea table

**What changed.** §4.2's **Fluency / Flexibility** row ("LiveIdeaBench axes: valid candidates emitted; distinct categories covered") is left in place, marked amended. The metric itself moves to §4.1 (pool-level) as `evals/metrics/operational.mjs`'s `poolFluency`/`poolFlexibility`, and is **no longer scored per idea by the judge**.

**Why.** An earlier draft had the per-idea judge score Fluency/Flexibility. That is undefined for a scorer that sees one candidate at a time and never sees the pool — "breadth of distinct categories covered" is a property of the whole pool, not of any single idea. Caught during the review pass on issue #45 (item 2).

**What lands where.** Both corrections land with the same code change registering §4.2 item 3 (`prompt.mjs` — the judge prompt continuing to score 1–10, and no longer asked for fluency/flexibility per idea) and the pool metrics module. This entry is the pre-registration record of the decision, not the implementation.

### Item 3 — §4.2/§11: the item 2 code change bumps `judgePromptHash`/`judgeHash`/`configHash` (registered so the consequence is on record)

**What changed.** `evals/judge/prompt.mjs`'s `JUDGE_PROMPT.version` moves from `liveideabench-4axis-v1` to `liveideabench-2axis-v2` and the fluency/flexibility axis definitions are dropped from the frozen prompt object (item 2). Because `judgePromptHash()` hashes the whole frozen prompt object, this changes the hash:

|                                   | `judgePromptHash()` |
| --------------------------------- | ------------------- |
| Before (`liveideabench-4axis-v1`) | `36963b8959ba`      |
| After (`liveideabench-2axis-v2`)  | `6bd11b4fceb4`      |

**Consequence, registered in advance.** `judgeHash` is a `CONFIG_FIELDS` entry (`lib/manifest.mjs`), so `judgePromptHash` feeding `computeJudgeHash` changes `judgeHash`, which changes every run's `configHash`, which changes every `cellKey` (§11). This is **correct and intended** — the rubric genuinely changed, and the whole point of hashing it into `configHash` is that a rubric change must not be silently pooled with cells scored under the old rubric. Per `planRun`, any pre-existing stored cell keyed under the old `configHash` becomes `stale` rather than being reused. **Impact today is nil** — no data has been collected under either hash — but the record is the deliverable: this is what a reader checking whether the code matches the registration should find.

### Item 4 — §1: blocker B3 closed, with two named exceptions (issue #44 item B1)

**What changed.** §1's blocker **B3** ("No token accounting in ideate-core") is marked **CLOSED**, conditional on **#53**'s routing audit, with two named exceptions carried forward as residual threats rather than closed away.

**Why.** #53 traced provider calls into `ideate-core@0.4.0` and found a real, now-fixed bypass: `runJudgeValidation` (`evals/judge/validate.mjs`) called `judgeProvider.score()` without metering, so the §8.3 Phase 1 judge-validation spend would have been billed but absent from the ledger — fixed on every call path, including the failure path (merged **#53** → **#56**, commit `5a5e273`). Round-1/round-2 `safeComplete` calls inside `ideate-core` route through `deps.complete` → `addUsage`, so the multi-agent overhead H1 measures is accounted. The Anthropic adapter accumulates `input_tokens`/`output_tokens`/`cache_read_input_tokens`/`cache_creation_input_tokens` into `tokens_by_model` on every path including failures (`evals/harness/provider.mjs`), and `lib/accounting.mjs:costRow()` refuses a row that cannot be repriced.

**Two named exceptions, not closed by the above:**

1. **Batch-poll timeout.** A client-side batch-poll timeout can return control to the caller while a submitted batch is still billing server-side. That spend is real and eventually appears at the provider, but the harness's own ledger has no row for it until (if ever) it polls again. Not a defect in the fix above — a residual gap in what client-side polling can observe.
2. **Unwired opt-in hooks.** `ideate-core`'s opt-in evaluator/embedder hooks are unwired in this study today (we call the generation path only). If they are ever enabled, they would need explicit metering of their own — nothing in the current audit covers a code path that isn't exercised.

This entry does not independently re-verify #53's provider-call trace (reported from that PR's diff and its merge to `develop`, reproducible there).

### Item 5 — §6.1/§6.2: H2 and H4 register the one-sided δ = 0 test; no margin is registered (issue #44 item B2)

**What changed.** §6.1 registers H2 as **"E ≥ D"** and H4 as **"B ≥ D"** — a direction, with **no numeric margin anywhere in §6.1 or §6.2**. This entry registers the faithful reading of that text: the **one-sided δ = 0 test** (H0: difference ≤ 0), structurally identical to H3's IUT sub-contrasts, tested at α = 0.025 one-sided within the Holm family (§6.2). **No pilot-derived margin is registered here or implied by the existing text.** An earlier draft of this appendix treated a pilot-derived δ as though it were already the registered reading of "≥" — it was not; §6.1/§6.2 as written contain no margin. If a margin is ever wanted, that is a **separate, dated amendment**, made explicitly (the registration contained no margin, a margin is being added, with the derivation stated) — not folded into this entry.

`evals/analysis/contrasts.mjs` implements this: `buildRegisteredFamily()` runs **δ = 0 as the registered default** for both H2 and H4. A caller-supplied non-zero δ is accepted but recorded on the result as `deltaDeviatesFromRegistration: true` (and rendered as "DEVIATES from registration" in `report.mjs`), so the artifact and the registration stay in agreement — a run with an explicit δ is legible as a deviation, never silently absorbed as the default.

**H1 restated as a single registered contrast.** §6.1 registers H1 as "any panel arm > Arm A" — an uncorrected 8-way maximum, since a "best of 8" comparison is not a single test. H1 is restated here as **one registered contrast: mean(panel arms) − Arm A**, tested once within the Holm family. Per-arm comparisons (armX − Arm A for one arm at a time) move to the **exploratory** section (§6.3), Benjamini–Hochberg corrected, and are never folded into the confirmatory Holm family. `evals/analysis/contrasts.mjs` implements the single mean-of-panel-arms contrast as the registered H1 slot.

**Why this mattered in practice.** With no δ passed, H2 and H4 previously fell into an unregistered two-sided Wald-vs-zero branch, which then contaminated the shared Holm family and drove every other hypothesis's verdict. Measured against the corrected one-sided δ = 0 test, H4's contaminating p-value was roughly 7× smaller than its correct value. This entry does not re-derive that measurement; it is reported from the #60 review pass and reproducible against that PR's diff.

### Item 6 — §6.2: the Holm family is 5 hypotheses, not 6 — H3 is an intersection-union test (issue #44)

**What changed.** Nothing in §6.2's text. §6.2 already states **"5 registered hypotheses"**, and that is correct as written. This entry records the reasoning so a future reviewer does not "fix" it back to 6, which an earlier (reverted) review pass had proposed.

**Why m = 5, not 6.** H3 ("G > max(D, H)") is not one linear contrast — it compares G against the better of two arms. But it is still **one** registered hypothesis: the null is **"G ≤ D or G ≤ H"** (i.e. G does not beat _both_), and H3 is rejected only when **both** one-sided sub-contrasts (G − D, G − H) reject at level α. By **Berger's intersection-union test (IUT) result**, rejecting an intersection null if and only if every component test rejects at level α is _itself_ already a level-α test of that intersection null. No within-H3 multiplicity adjustment is required or applied. `evals/analysis/contrasts.mjs` computes H3's p-value as **`max(p_G-D, p_G-H)`**, and it consumes exactly **one** Holm slot — see `registeredFamilySlotCount()` and the file's header comment, which registers this exact reasoning at the point of implementation.

### Item 7 — §5.1/§5 (judge validation): idea-level metrics are exploratory by construction; the human-human floor recomputation and its correction (issue #44 item B3)

**What changed.** §5.1 point 4 already registers that a failed validation gate drops idea-level metrics to pool-level-only reporting — an acceptable, pre-registered outcome. This entry **reaches that outcome directly, for a stated pre-data reason, rather than through the gate**: **idea-level metrics (novelty, feasibility) are registered as exploratory by construction**, because the available answer key lacks the resolution to validate the judge at all. This supersedes the earlier framing in this appendix's issue thread (#44) that treated the gate itself as the mechanism; that framing is superseded, not the §5.1 point 4 consequence, which stands.

**Why — the human-human floor cannot exclude chance at this slice size.** #47 recomputed human–human split-half balanced accuracy on our own 98-idea slice (Human + AI conditions, `AI_Rerank` excluded — see below — 228 reviews), under a construction registered before the run. The durable record is `docs/si-et-al-human-human-floor.json`; the corrected numbers, read directly from that artifact, are:

| Construction parameter   | Value                                                                            |
| ------------------------ | -------------------------------------------------------------------------------- |
| `scoreColumn`            | `overall_score`                                                                  |
| `quantile`               | 0.25                                                                             |
| `splitRule`              | split-half of each idea's own reviews (no reviewer id in the anonymized release) |
| `splitSeed`              | 1                                                                                |
| `splitCount`             | 1000                                                                             |
| `bootstrapSeed`          | 2                                                                                |
| `bootstrapDraws`         | 2000                                                                             |
| `bootstrapSplitsPerDraw` | 200                                                                              |

| Result                                                   | Value                |
| -------------------------------------------------------- | -------------------- |
| Mean balanced accuracy                                   | **0.5534**           |
| Split distribution p05 / p95                             | 0.500 / 0.625        |
| Bootstrap 95% CI                                         | **[0.4483, 0.6702]** |
| Overlaps the registered 56.1% floor (Appendix A item 4)? | Yes                  |
| Excludes chance (0.50)?                                  | **No**               |

**A correction to this appendix's own prior draft.** An earlier comment on issue #44 reported this bootstrap CI as `[0.4167, 0.7083]`, computed with a defective estimator (one split per bootstrap resample, compared against a point estimate that is itself a mean over 1000 splits). `docs/si-et-al-human-human-floor.json` carries the corrected construction and the corrected CI above. **Both of the earlier comment's conclusions are unchanged by the correction** — the interval still overlaps the registered floor and still does not exclude chance — but the appendix registers the corrected figure, not the stale one, so a reader checking the number against the durable artifact finds agreement.

**What this means for validation.** At this slice size, 105 of the 147 Si et al. ideas carry exactly 2 reviews (#47-reported; this count is not itself a field in `docs/si-et-al-human-human-floor.json`), so a split-half on those is one reviewer against one. The interval **does not exclude chance (0.50)**. That is a stronger result than "the floor is the wrong constant": if the answer key itself is statistically indistinguishable from chance at this n, no comparison of a judge's accuracy against it is informative, and swapping in a recomputed floor would only relabel the problem rather than rescue the instrument.

**Registered reporting (descriptive, not a gate).** Idea-level results are still reported, as **descriptive statistics with bootstrap CIs**, never as a pass/fail claim:

- Judge-vs-expert balanced accuracy and Spearman ρ, with bootstrap CIs (resampling ideas).
- The recomputed human–human distribution above (#47 / `docs/si-et-al-human-human-floor.json`).
- The registered comparators, each **labelled as to population**:
  - **56.1%** — Si et al.'s own paper-reported human-human figure. Labelled **"paper-reported, different population and different split scheme"** — 147 ideas / 3 conditions / 337 reviews, reviewer split-half — **never "reproduced."**
  - **51.7%** (Claude-3.5 Direct, shape-matched to our judge) and **53.3%** (Claude-3.5 Pairwise, their best evaluator of any shape) — Si et al. Table 11, their paper population.

**Why this exclusion.** `AI_Rerank` (49 files) is excluded from the recomputed slice: only 18 of its 49 files are recoverable by filename against the AI condition; the remaining 31 draw from a larger generated pool than the AI condition's 49 sampled ideas and cannot be recovered from the released `id_title_mapping.csv` at all. Including only the recoverable 18 would represent the condition by a non-random 37% subsample, so Human + AI (98 ideas, 228 reviews) is used instead (recorded in `docs/si-et-al-human-human-floor.json`'s `slice.exclusions`).

**A reportable finding in its own right.** This is registered as a finding, not merely absorbed as a limitation: **the released anonymized Si et al. review data cannot support LLM-judge validation at useful precision**, because it ships no reviewer identifier and most ideas (105 of 147, #47-reported) carry exactly two reviews. It is checkable, it concerns a widely-cited public dataset, and — unlike the per-dollar model ranking this study produces — it does not expire when the model lineup changes.

This entry does not independently re-run #47's bootstrap. The construction parameters and result numbers in the tables above are read verbatim from the committed `docs/si-et-al-human-human-floor.json`; the "105 of 147" review-count figure is not a field in that JSON (the Si et al. raw data itself is gitignored and not committed to this repo) and is reported here as #47's finding, not independently traceable to a committed artifact.

**`MIN_IDEAS_N` is left unaddressed, deliberately.** §5's original B3 draft also asked to "raise and register" `MIN_IDEAS_N` (still `20`, `evals/judge/gate.mjs:106`) because the sampling SE on a binary pass/fail gate at n=20 is too large for the gate to mean anything. Once idea-level metrics are exploratory by construction (this item), there is no longer a pass/fail gate for `MIN_IDEAS_N` to gate the reliability of — raising it would be tuning a threshold on a mechanism this entry retires. `MIN_IDEAS_N` is therefore left at its current value, unraised, by the same reasoning that retires the gate itself.

### Item 8 — §4.1/§3.4/§12: the equivalence threshold is calibrated in Voyage space, with numbers, hash, and disclosed provenance (issue #44 item B4)

**What changed.** §4.1's `distinct_k` — the headline metric — is a direct function of `CLUSTER_DISTANCE_THRESHOLD`. §4.1 registers no numeric threshold, so this entry registers one, calibrated in the embedding space production actually uses (**Voyage-4-lite**), replacing the MiniLM-derived threshold that §4.1 never numerically pinned. Values below are read verbatim from the committed `evals/metrics/fixtures/voyage-calibration-result.json` (issue #42).

| Field                                                  | Value                                                                                                                                                                                                                                                 |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Embedder ID                                            | `voyage-4-lite`                                                                                                                                                                                                                                       |
| Selection rule                                         | midpoints of consecutive sorted observed pairwise distances; select the threshold maximising balanced accuracy (mean of sensitivity, specificity) on the same/different pair labels; ties broken by the midpoint of the widest run of tied candidates |
| **Registered `clusterDistanceThreshold`**              | **0.23141118234233987**                                                                                                                                                                                                                               |
| Calibration pair-set hash                              | `4be4622bfbad`                                                                                                                                                                                                                                        |
| Calibration pair-set size                              | 108 pairs, all 4 strata                                                                                                                                                                                                                               |
| Achieved balanced accuracy (Voyage-selected threshold) | **96.5%**                                                                                                                                                                                                                                             |

**The empirical result the MiniLM-derived threshold was tested against.** The MiniLM threshold (0.49234346496597087, the midpoint used by the original 8-pair fixture) scores **58.3%** balanced accuracy on the same 108-pair hard-negative set — barely better than chance. Hard negatives in that set are _distinct ideas answering the same brief_, which is exactly what a 30-idea pool consists of, so the failing case is not an edge case — it is the entire measurement `distinct_k` performs in this study. The old 8-pair fixture passed because it compared ideas across unrelated topics, a much easier separation, which is why nothing caught the mismatch earlier.

**Disclosure: the calibration pairs are model-generated, not human-labelled.** All 108 pairs (text and same/different label) were authored by an LLM (`claude-sonnet-5`, 2026-09-01), not collected from human raters (`voyage-calibration-result.json`'s `pairSetProvenance`). A threshold calibrated against model judgement is weaker evidence than one calibrated against human judgement, and this appendix states that plainly rather than presenting the pair set as ground truth. **#52's planned crowdsourced rating panel is the natural future anchor** for a human-labelled recalibration (see Item 13 below on why #52 itself is registered as exploratory).

**Sensitivity and a threshold-free companion metric.** Register a **±0.05 sensitivity analysis**, reporting H1–H4 at threshold ± 0.05 around the value above (`evals/metrics/fixtures/voyage-calibration-result.json`'s `deviationNotes` records that the ±0.05 band is a MiniLM-era registered figure, not re-derived from the Voyage same/different gap — report it as a fraction of the observed gap alongside any sensitivity result, not as an independently-derived Voyage-space figure). Register **mean pairwise distance** as a threshold-free companion metric alongside `distinct_k`, so the headline number is never the only diversity signal reported.

**Consequence, registered in advance.** `clusterDistanceThreshold` is now a `CONFIG_FIELDS` entry (`lib/manifest.mjs`), so a threshold change invalidates cells the same way a prompt or judge change does — it changes `configHash` (§11) and any pre-existing cell under the old threshold becomes `stale` rather than silently reused.

### Item 9 — §6.2: judge-score model adds `(1|run)`; cost lane registered as descriptive (issue #44 item B6)

**What changed.** Two defects in §6.2's model, both registered as corrections rather than §6.2 edits:

1. **Pseudoreplication.** §5.2 scores every pool with two judges (2 rows per pool), but §6.2's model as written has no run-level intercept, so H5's bias-term CI is too narrow by roughly the within-pool correlation. Register **`(1|run)`** on the judge-score model, alongside the existing `judge_provider` and `judge_provider × generator_provider` terms. `evals/analysis/frame.mjs` and `evals/analysis/contrasts.mjs` document this in their header comments as the registered judge-score model shape. Wiring the actual fit that produces H5's coefficient (the judge-score model itself, as opposed to the `distinct_k` model H1–H4 use) is separate, not-yet-scheduled implementation work — no open issue currently tracks it; #45 (closed) covered the judge scale/axes repair, not this.
2. **Cost is descriptive, not a Gaussian-offset term.** `log(cost)` as a model offset does not parse under a Gaussian identity link — an offset is a log-link concept — and cost varies negligibly _within_ an arm, so the offset would be effectively an arm-level constant contributing nothing. Register the cost lane instead as a **descriptive `distinct_k`/cost ratio per arm, with cluster-bootstrap CIs over briefs**, explicitly labelled descriptive because there is no within-arm cost variation to model. `evals/analysis/report.mjs` and `analysis.mjs` already carry a `costRatioByArm` field through the report, consistent with this registration.

**Why.** Both are analysis-plan corrections that must be on record before any data exists, per the amendment rule — neither changes what is measured, only how it is modeled.

### Item 10 — §6.2/§9: convergence-failure ladder, registered rung-by-rung (issue #44 item B7)

**What changed.** Register a **machine-checkable convergence ladder**, selected from fit diagnostics alone, before any contrast is computed, per lane, and reported in `REPORT.md` with the criterion that triggered it:

| Rung | Model                                                        | Descent criterion                                                          |
| ---- | ------------------------------------------------------------ | -------------------------------------------------------------------------- |
| R0   | `y ~ arm + (1\|brief) + (1\|brief:arm)`                      | `converged === false` OR non-finite/≤0 vcov diagonal OR NaN coefficient SE |
| R1   | `y ~ arm + (1\|brief)`                                       | same criteria                                                              |
| R2   | OLS + CR2 cluster-robust SEs, cluster = brief                | reached only if R1 also fails                                              |
| R3   | no confirmatory inference; study reported as **descriptive** | R0–R2 all fail                                                             |

**A boundary variance component is a finding, not an error.** `(1|brief:arm)` estimating at zero means no arm×brief interaction — that is reported as a finding, and the analysis stays at R0. Descent happens only on non-convergence or NaN, never on a boundary estimate. **R2 is additionally a standing robustness check reported at every rung**, not only as the R1-failure fallback, since it changes the estimand weighting relative to the mixed-effects fit. Holm–Bonferroni (Item 6 above) is applied across the 5 registered hypotheses regardless of which rung each lane lands on.

**Sidecar-unavailable is NOT R3 — it is a separate hard failure that produces no rung and no numbers.** This appendix's original draft (issue #44) worded R3's descent criterion as "R0–R2 all fail, or sidecar unavailable," which would make a missing Python venv silently degrade to a weaker-but-still-publishable descriptive result — exactly the failure mode a pre-registration exists to prevent. `evals/analysis/fit.mjs` (#46) resolves this the other way, and its resolution is the one registered here: when the sidecar cannot be reached at all, `fitViaSidecar`/`makeSidecarRunner` throw `SidecarUnavailableError` **before any rung is attempted** — no R0/R1/R2/R3 result is produced, and the run cannot proceed to a descriptive report on that basis alone. `runLadder` returns an **R3** result only after R0, R1, and R2 have each been attempted and each failed their descent criteria with the sidecar reachable throughout. The table above is corrected to match this: R3's criterion is "R0–R2 all fail" and sidecar-unavailability is out of the ladder entirely.

**Verified.** `evals/analysis/fit.mjs` implements the ladder as corrected above (`runLadder`, `fitViaSidecar` for R0/R1, `fitR2` for the CR2 fallback, `SidecarUnavailableError` as the separate hard-fail path) — checked by reading `fit.mjs`'s header comment and `runLadder`'s body, not independently re-executed here. The CI job **"Analysis sidecar (ANALYSIS_SIDECAR=1)"** (`.github/workflows/ci.yml`) runs the real statsmodels REML fit against the closed-form ANOVA oracle (`evals/analysis/fit.integration.test.mjs`, `anova-oracle.mjs`) — confirmed present and `success` on the latest `develop` CI run via `gh run view --json jobs` at the time of this writing. That job is a **separate CI job with its own Python venv**, distinct from the default `node --test` job (which never sets `ANALYSIS_SIDECAR` and so never exercises the real sidecar comparison). With that job green, the statistical core is verified on every push to `develop`; without it, `node --test` alone would only verify "the code ran," not "the statistics were checked."

### Item 11 — §4.2: OCSAI demoted to exploratory, relative-ordering only (issue #44 item B8)

**What changed.** Remove OCSAI from §4.2's secondary-metric table as a registered comparator with claimed calibration; register it instead as **exploratory, relative-ordering only**. §4.2's current row ("OCSAI originality — AUT stratum only; instrument with published r = 0.81 to humans") is left in place, marked amended, per the amendment rule — the published r = 0.81 figure is from OCSAI's own training population, not verified against this study's AUT-stratum items.

**Why.** OCSAI's free API publishes no numeric rate limit. Using it under a **self-imposed conservative throttle** (issue #17) is a reasonable operational choice, but it means OCSAI scores in this study are obtained under a constraint the published r = 0.81 correlation was not measured under. Report OCSAI as ordering only (does judge A rank higher than judge B), never as an absolute score compared against the published correlation. Report **request count, throttle, and date** alongside any OCSAI number, so a reader can see the operating conditions.

### Item 12 — §4.4: negative control replaced — shuffled-label control is vacuous by construction (issue #44 item B9)

**What changed.** §4.4's **shuffled-label control** ("judge the same pool twice with arm labels permuted → expect no score difference") is replaced with a **judge test-retest repeatability control**: the same pool scored twice, reporting **test-retest ρ**. §4.4's shuffled-label row is left in place, marked amended, per the amendment rule.

**Why.** The shuffled-label control cannot catch anything: `deidentify.mjs` enforces that the judge never sees arm/model/persona labels in the first place (§5.3), so permuting labels the judge never receives cannot produce a different score by construction — the control tests nothing. Test-retest repeatability (score the same de-identified pool twice, independently) tests something real: whether the judge is a repeatable instrument at all, which is a precondition for every downstream comparison in §6.

### Item 13 — §3.2/§0: corpus expanded to 24 briefs, 6 per stratum; provenance disclosed (issue #44, corpus)

**What changed.** §3.2 registers **n = 12** briefs, 4/3/3/2 per stratum. The corpus has been expanded to **24 briefs, 6 per stratum** (business / product / scientific / classic divergent-thinking), landed in `evals/corpus/briefs.mjs` (#43). §3.2's table is left in place, marked amended.

|                                                                                         | Value                                                                                        |
| --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Brief count                                                                             | 24 (was 12)                                                                                  |
| Per-stratum count                                                                       | 6/6/6/6 (was 4/3/3/2)                                                                        |
| Corpus hash before expansion                                                            | `6b487e8470d5` (as reported when #43 landed; superseded, not independently re-verified here) |
| Corpus hash after expansion (verified against `evals/corpus/index.mjs`'s `CORPUS_HASH`) | **`55e05c2811a7`**                                                                           |

**The 3 original scientific keywords are preserved as a prefix under the same seed** — only 3 additional scientific briefs were appended, none of the original 3 were re-rolled — so the previously-registered scientific briefs are provably unchanged. The keywords are not hand-typed into `evals/corpus/briefs.mjs`; they are computed at module load by `sampleKeywords(LIVEIDEABENCH_KEYWORDS, SCIENTIFIC_SAMPLE_COUNT, SCIENTIFIC_SAMPLE_SEED)` (`evals/corpus/sample.mjs`, `SCIENTIFIC_SAMPLE_SEED = 20260731`, `SCIENTIFIC_SAMPLE_COUNT = 6`). To reproduce the claim: call `sampleKeywords` with `count = 3` under the same seed and confirm the result is the exact first-3 prefix of the `count = 6` result — the prefix property follows from the sampler's partial Fisher–Yates draw, and can be checked directly against `evals/corpus/sample.mjs`.

**Disclosure.** The business and product-stratum briefs are authored by the product's owner (the same person driving this study), not sampled from an external corpus the way the scientific stratum is (LiveIdeaBench keyword set) or structurally fixed the way the AUT stratum is. This is disclosed here rather than left implicit, since it is a source of potential bias in what "business ideation" and "product ideation" look like in this study's corpus.

### Item 14 — new: #52's crowdsourced human rating panel is registered as exploratory (issue #44)

**What's registered.** The planned crowdsourced (Prolific) human distinct-idea rating panel (issue **#52**) runs **after** the confirmatory grid completes and is **exploratory, not confirmatory**. It is not part of the registered H1–H5 family (§6.1), is not Holm-corrected, and any comparison it produces is reported in the exploratory section (§6.3) with Benjamini–Hochberg correction, labelled exploratory.

**Why this belongs in this appendix.** Everything else in #52 (design, cost, Prolific mechanics) is an implementation detail with no pre-data expiry — it can be decided at any time before the panel runs. Its **confirmatory-vs-exploratory status** is different: that is a pre-data decision, and per this document's own rule (§11, optional stopping), deciding it _after_ seeing any grid or panel result would not be legitimate. Registering it now, while no study data exists, is what makes "exploratory" mean something rather than being a label applied conveniently after the fact.

### Item 15 — §10/§11: analysis toolchain pinned as `analysisHash`, separate from `configHash` (issue #44 item B10, scope note)

**What changed.** §10/§11 register `configHash` as covering everything that changes **the measurement** (engine SHA, prompt hash, judge hash, embedder, panel shape, and now `corpusHash` / `clusterDistanceThreshold`, Items 13/8 above). This entry registers a **separate `analysisHash`** — the analysis toolchain's Python/numpy/scipy/statsmodels versions plus `sha256(fit_mixedlm.py)` — stamped in `REPORT.md` alongside `configHash`, explicitly **not folded into `configHash`**: a toolchain version bump changes how the numbers are _computed_, not what was _measured_, and folding it into `configHash` would falsely mark old cells `stale` on a pure tooling change. `evals/analysis/fit.mjs`'s `analysisHash()` and `report.mjs`'s rendered `analysisHash:` line implement exactly this separation.

**Scope, population, and rate-table date (§10, remainder of B10).** Register the study's population as **the briefs actually tested** (§3.2, now 24 briefs, Item 13) — drop any claim of generalization across task type beyond per-stratum reporting (§10 already lists "12 briefs may not generalize" as a threat; this stands, updated for 24). Pin the dated rate table used for the ledger (§8.1) and record that **Sonnet 5's introductory rate ($2.00/$10.00) expired 2026-08-31** (§8.1's own text already states this expiry date; verify first-party against the live rate card before pinning a run that starts after that date, rather than assuming the intro rate still applies).

---

## Appendix C — Amendments (dated 2026-09-01)

Per the amendment rule at the top of this document. **Nothing in §6 is changed by any entry below.** §6.1 already registers H1 as "at matched idea count" — that clause has been in the frozen text since this document's first commit. This appendix **specifies how an already-registered clause is operationalized**; it is not an amendment to H1, and no entry here proposes different words for §6.1's hypothesis table.

### Item 1 — §3.1/§3.3: two claims about Arm A were false; corrected here

**What changed.** Two frozen-text claims are corrected (left in place, marked amended, per the amendment rule):

- §3.1's arm-A row states _"Matched on total ideas requested."_ True of **round-1** requests only (30 vs 30). At the **pool** level — the unit `distinct_k` is computed over — it is **~30 vs ~60**: Arm A resolves to `maxRounds: 1`; every panel arm resolves to `maxRounds: 2` (`arms.config.json`'s `panel: {size: 5, ideasPerAgent: 6, maxRounds: 2}`, `evals/harness/provider.mjs:496-516`'s `resolveIdeateAgents`), and round 2 **appends** candidates to the shared pool rather than replacing round 1 (`ideate-core.mjs:271` accumulates, `:338` appends, `:354` returns the deduped union with no cap).
- §3.3 lists **"same rounds"** under _Held constant_. Arm A runs 1 round; every panel arm runs 2. Not held constant.

**Why.** Caught during the QA review of PR #69 (issue #70). Both corrected here, at pool level, rather than at the round-1-request level the original text implicitly measured.

**Verification status.** Traced from `resolveIdeateAgents` and `arms.config.json`, not measured — **no generation has ever been run**. ≈60 is a traced upper bound: `ideate-core.mjs:354` dedupes the panel pool by normalized text, and round 2 is only _prompted_ for new ideas (`evals/harness/prompts.mjs:96`: `` `Generate exactly ${n} NEW candidate ideas` ``), not guaranteed to produce them — the true observed panel pool size may be well under 60. This is exactly why Item 2's rule never hardcodes a number.

### Item 2 — §6.1: how "at matched idea count" is operationalized — the rarefaction rule (the substantive item)

**What this specifies.** §6.1's H1 reads: _"Any panel arm > Arm A (solo) on `distinct_k` **at matched idea count**."_ The matching clause was already registered; Item 1 shows the implementation did not enforce it. This item registers the operationalization.

**The registered rule.** For every arm-A contrast (see Item 4 for which contrasts that is): rarefy every pool in the contrast down to the **minimum pool size present in that contrast**, and take `distinct_k` as the **mean over R random subsamples**, drawn without replacement, uniformly over the whole pool, at that minimum size.

**No hardcoded pool size — registered as a rule, not a number.** The rule is "rarefy to the minimum pool size actually present in the contrast," never "rarefy to 30." No generation has ever been run (Item 1); ≈60 is a traced upper bound, not an observation, and the true panel pool size is unknown until #8 (Phase 2a) measures it. A rule that hardcoded a number would need re-amending the moment that measurement lands; "the minimum actually observed" does not.

**Truncation to the first n is explicitly ruled out.** The first 30 ideas of a panel pool ARE that arm's round-1 output — round 2 appends, it does not rewrite (`ideate-core.mjs:271`/`:338`, Item 1). Truncating to the first n would therefore discard exactly the build-on-each-other mechanism ideate-core's multi-agent machinery exists to test, biasing the rarefied comparison **against** the panel arms — the opposite direction from the pool-size confound this appendix exists to remove. It is also not the registered comparison: §6.1 asks about the panel's finished pool, not its round-1 output alone. Every subsample this rule draws is a uniform random draw over the **whole** pool; there is no first-n code path.

**R and the seed, registered.** Named constants in `evals/analysis/rarefaction.mjs`, cited here by name rather than by value so the document and the code cannot silently drift apart:

- `RAREFACTION_R = 1000` — number of random subsamples averaged per rarefied `distinct_k` estimate.
- `RAREFACTION_SEED = 20260901` — explicit integer seed for the subsampling PRNG (mulberry32, vendored per this repo's convention — see `order.mjs`/`sample.mjs`/`pareto.mjs`). Never wall-clock, so a reported rarefied value is exactly reproducible.

Averaging over `R` draws only **partly recovers** the information a single full-pool measurement would carry — this is registered as a noisier estimator than the full-pool `distinct_k`, not a free lunch (Item 6).

**Implementation.** `evals/analysis/rarefaction.mjs`: `minPoolSize` (the target-size rule), `sampleIndicesWithoutReplacement` (the only sampling primitive — no truncation path), `rarefiedDistinctK` (one pool → its rarefied estimate), `rarefyPools` (a whole contrast → both rarefied and full-pool values per pool, Item 5). Tested in `evals/analysis/rarefaction.test.mjs`:

- The KEY discriminating test (`KEY: rarefaction removes a pool-size confound that raw distinct_k is sensitive to`) constructs two pools from an **identical** generative process at different sizes and shows raw `distinct_k` is sensitive to the size difference (a real, large gap) while the rarefied value is not, within sampling tolerance.
- A separate test (`R controls estimator variance`) makes `R` itself load-bearing on the property it exists for — estimator variance across seeds — rather than only on input validation: at the registered `R`, five independent seeds on the same pool agree tightly (spread ≈ 0.2 on the observed fixture); at `r=2` (the function's floor), the same five seeds disagree by ≈4 — a real, measured gap, not an assumed one.

Verified by targeted mutation (each reverted before commit): hardcoding `R=1` is refused outright by `rarefiedDistinctK`'s `r >= 2` input guard (7 of 16 tests fail on the thrown error, not on a statistical disagreement); a second, **guard-surviving** mutation — the averaging loop and divisor capped at `min(r, 2)` regardless of the caller's `r` — passes every other test but is caught specifically by the `R controls estimator variance` test, which is the one built to have power against exactly this failure mode independent of input validation. Using max instead of min in `minPoolSize` fails 3 tests; silently ignoring the seed fails 2; dropping the min-size computation inside `rarefyPools` (hardcoding a pool size) fails 1. Every targeted mutation goes red.

### Item 3 — §4.1: which primary metrics receive the rarefied treatment

**What's registered**, per §4.1 primary metric, in any arm-A contrast — `RAREFACTION_TREATMENT` in `evals/analysis/rarefaction.mjs` is the code-side record of this table, so the two cannot drift apart:

| Metric                                         | Treatment                  | Why                                                                          |
| ---------------------------------------------- | -------------------------- | ---------------------------------------------------------------------------- |
| `distinct_k`                                   | **Rarefied**               | Monotone non-decreasing in pool size (§0 of issue #70)                       |
| `poolFluency`                                  | **Rarefied**               | It _is_ the pool size                                                        |
| Collapse rate                                  | **Rarefied**               | A larger pool has more chances of internal duplication                       |
| Pool diversity (mean pairwise cosine distance) | Full-pool                  | A mean, roughly n-robust                                                     |
| `distinct_k` per dollar                        | Full-pool, self-correcting | The extra generation the panel arms run is paid for on the cost side already |

### Item 4 — scope: every arm-A contrast, A′ included; H2/H3/H4 unaffected

**What's registered.** The rarefaction rule (Item 2) applies to **every contrast that includes Arm A**, not only H1:

- **H1** (mean(panel arms) − A, §6.1/Appendix B item 5) — the confound this appendix exists to fix.
- **Per-arm exploratory breakdowns** (armX − A for one arm at a time, §6.3/Appendix B item 5) — same confound, same fix.
- **A′ (the persona-ablation arm, §3.1)** — A′ is a **panel** (identical models, disabled persona lever), so it resolves to `maxRounds: 2` and an ≈60 pool exactly like every other panel arm. The A-vs-A′ comparison — "the question a skeptical reviewer asks first" per §3.1 — is unmatched in exactly the same way H1 is, and is rarefied by the same rule.

**H2 (E vs D), H3 (G vs D/H) and H4 (B vs D) are unaffected.** No **structural** pool-size asymmetry exists between panel arms — every arm on both sides of these contrasts shares the same registered panel shape (`panel: {size: 5, ideasPerAgent: 6, maxRounds: 2}` for all of B/D/E/G/H), unlike Arm A's `maxRounds: 1`. This is a claim about the registered shape, not about observed post-dedup pool size: `ideate-core.mjs:354` dedupes by normalized text, and different panel arms could plausibly dedupe by different amounts (a Haiku panel producing more near-duplicates than an Opus panel, say) — exactly the round-1-requests-vs-pool-level distinction Item 1 corrects for Arm A. #8 (Phase 2a) will measure observed pool size per arm; if panel-vs-panel pool sizes turn out to differ materially, extending this rule to panel-vs-panel contrasts is a separate, dated amendment, not something this item pre-empts.

### Item 5 — both values are reported

**What's registered.** For every rarefied contrast (Item 4), `REPORT.md` reports **both**:

- **Rarefied `distinct_k`** — H1's (and A′'s, and the per-arm breakdowns') registered estimand, the quantity §6.2's Holm-corrected family is tested on.
- **Full-pool `distinct_k`** — a secondary descriptive, never substituted for the registered estimand, reported so a reader can see what the unmatched comparison would have shown.

`rarefyPools()`'s return shape (`{poolSize, rarefiedN, distinctKFullPool, distinctKRarefied}` per pool) carries both numbers through by construction — there is no code path that produces one without the other.

### Item 6 — §3.4/§8.3: consequences for the pilot (#49)

**What's registered.** Variance of a count scales with the count, so a between-run variance estimate collected from a 30-pool arm (Arm A) does not transfer to a 60-pool arm (every panel arm) — the two arms' `distinct_k` have structurally different sampling variance even before any model effect. §3.4/§8.3's pilot (Phase 2, "estimate variance → recompute n") is registered to derive H1's required `n` from the **rarefied** `distinct_k` variance, computed at the contrast's rarefaction target, never from the raw full-pool variance of either side.

**This makes H1 noisier than the full-pool comparison, by construction, and that is registered in advance.** Rarefaction discards information (Item 2); averaging over `R = 1000` draws only **partly** recovers what a single full-pool measurement at the true (larger) pool size would have given. A pilot-derived `n` for H1 must therefore be derived from data that has itself already been rarefied — deriving it from full-pool variance and applying that `n` to a rarefied confirmatory test would understate H1's true required sample size.

### Item 7 — §10: Phase 0's power against a semantics-free embedder, and the DAT mitigation's strength

**What's registered.** §10's threat table lists "DAT replication as validity check" as the mitigation for "Embedding model shapes diversity metric." This entry quantifies how strong that mitigation actually is.

**Reported, not verified against a committed artifact in this repo** — measured during the QA review of PR #69, reproducible from the construction described, not independently re-run in this session:

- The DAT replication control (§4.4) is a 3-point ordering (`low < avg < high`), which holds **1-in-6 (16.7%) under a null** with no semantic signal at all.
- Measured over **3,000 seeds** with a pure SHA-512-of-text embedder (deterministic, text-dependent, carrying **zero semantics**): the DAT ordering held **16.4%** of the time (null expectation 16.7% — consistent with the embedder carrying no real signal, as constructed).
- **All three negative controls (duplicate pool, random pool, DAT ordering) passed together 1.9% of the time** over the same 3,000 seeds. A reproducible witness: **seed 97** — `low 0.9481 < avg 0.9594 < high 0.9738`, `distinct_k` 1 (duplicate pool) and 30 (random pool) — a fully semantics-free embedder that nonetheless clears every registered control simultaneously, at that seed.
- Only the DAT control has power against this failure mode: a text-hash embedder passes the duplicate-pool control **exactly** (identical text → identical vector → all pairwise distances exactly 0) and the random-text control **trivially** (unrelated sentences hash to unrelated, well-separated vectors) by construction, regardless of whether the embedder carries any semantics.

**The mitigation therefore carries only about 0.8 bits of evidence against a semantics-free embedder, not a validity guarantee.** This figure is carried over verbatim from the PR #69 QA review; it is **reported, not re-derived or independently verified in this session** — a naive `log2(1/0.164) ≈ 2.6` (surprisal of a single DAT pass under this null) does not obviously reproduce 0.8 bits on its own, and the exact derivation (e.g. relative to a different reference distribution) is not restated here. Treat the bit figure as a labelled estimate from that review, not a computed one; the pass-rate numbers above it (16.4%, 1.9%) are the load-bearing, directly-stated measurements. Either way, the qualitative conclusion is unaffected: a control a semantics-free embedder clears roughly 1 time in 6 is weak evidence, not a validity guarantee. §10's table is corrected below to say so rather than presenting DAT replication as closing the threat.

> _Amended 2026-09-01 ([Appendix C](#appendix-c--amendments-dated-2026-09-01), item 7). "DAT replication as validity check" (row: "Embedding model shapes diversity metric") is a real but weak mitigation — reported, not verified against a committed artifact in this repo: over 3,000 seeds, a semantics-free SHA-512-of-text embedder cleared the DAT ordering 16.4% of the time (null 16.7%) and cleared all three negative controls together 1.9% of the time (reproducible witness: seed 97). Carried over as "about 0.8 bits of evidence" from that review; this session did not independently re-derive that figure from the pass rates above (see the appendix item). Not a guarantee the embedder carries real semantics either way. See the appendix item for the full construction._

### Item 8 — §4.4: the two degenerate negative controls are nearly threshold-free

**What's registered.** §4.4's qualitative note that the duplicate-pool and random-pool controls pass "under almost any threshold" is true but under-specified. This entry registers the numbers.

**Reported, not verified against a committed artifact in this repo** — measured during the QA review of PR #69, reproducible from the construction described, not independently re-run in this session:

- **Duplicate pool.** Passes (`distinct_k = 1`, `diversity < 0.05`) over the **entire** threshold domain, unconditionally: identical text embeds to an identical vector, so every pairwise distance is exactly 0 regardless of where the threshold is set.
- **Random pool.** Passes for every threshold in roughly **(0, 0.730)**, measured on the committed MiniLM fixture. Two ratios, not one, because the band is MiniLM-measured and two different thresholds are registered in two different embedding spaces (Appendix B item 8 is explicit that cosine-distance distributions do not transfer across embedders): **~3×** the production Voyage-space `clusterDistanceThreshold` (0.730 / 0.2314) — a cross-space ratio, not a same-space robustness factor — and **~1.5×** the MiniLM-space threshold the 0.730 figure was itself measured against (0.730 / 0.4923). Corrupting the registered threshold constant to anything in **[1e-9, 0.9]** leaves the whole negative-control suite green.
- **The one control that did NOT clear widely: the random-pool diversity margin.** `0.7525 / 0.6970 = 1.080` — an **8%** margin against a floor self-calibrated from `dat.high` in the same run. Named here because it is the one number in this item that is close to failing, not comfortably far from it like the other two.

> _Amended 2026-09-01 ([Appendix C](#appendix-c--amendments-dated-2026-09-01), item 8). The duplicate-pool and random-pool negative controls (§4.4 table) are both nearly threshold-free: the duplicate pool passes over the entire threshold domain unconditionally; the random pool passes for roughly (0, 0.730) on the MiniLM fixture — ~3× the production Voyage-space threshold (0.2314) or ~1.5× the MiniLM-space threshold it was measured against (0.4923), the two ratios disclosed separately because the band is MiniLM-measured and cosine distances don't transfer across embedding spaces (Appendix B item 8) — and the whole suite stays green with the threshold corrupted to anywhere in [1e-9, 0.9]. The one control that did not clear widely was the random-pool diversity margin itself: 0.7525/0.6970 = 1.080, an 8% margin. Reported, not verified against a committed artifact in this repo. See the appendix item for the full construction._

---
