# ideate-core — Comparative Ideation Study (eval spec v0.1)

> ## 🔒 Pre-registration
>
> **This document is a pre-registration: it states the hypotheses, metrics, and analysis plan BEFORE any data is collected.** That is what makes a confirmatory result meaningful rather than a story fitted to whatever the data happened to show.
>
> Its credibility rests on being verifiably prior. This repository is public and the git history is the timestamp — the commit that introduced this file predates every result in `REPORT.md`, and anyone can check that.
>
> **Amendment rule.** Changes to §6 (hypotheses and analysis plan) after data collection begins are *amendments*, not edits. They must be added as a dated appendix that states what changed and why, never applied in place. A silently rewritten analysis plan is not a pre-registration.
>
> Nothing has been run. Every number below is a projection.

**Status:** pre-registration draft.
**Date:** 2026-07-30 · **Target engine:** ideate-core `@0.4.0` (npm, published 2026-08-02) — pinned.
> *Amended 2026-08-02 ([Appendix A](#appendix-a--amendments-dated-2026-08-02), item 1). Was: `Target SHA: ideate-core develop @ 920c086 + fix A1`. That SHA predates the remediation; `ideate-core@0.4.0` contains the fixes for **both** registered blockers (B1, B2). The runtime `engineSha` in the manifest is now the resolved package version (`ideate-core@0.4.0`) rather than the `"unpinned"` literal `evals/run.mjs` originally shipped.*

---

## 0. What this is, and what it is not

This is **not** a regression eval of a fixed configuration. It is a **comparative research study** whose output is a ranked, statistically defensible answer to:

> Which generator-model configuration produces the most *usefully diverse* idea pool per dollar, and does ideate-core's multi-agent machinery beat a single call at all?

Two consequences follow, and they shape everything below:

1. **The unit of analysis is the POOL, not the idea.** ideate-core's claims are pool-level (diversity, non-duplication, cross-theme coverage). Scoring individual ideas and averaging destroys exactly the property under test — a pool of 30 excellent near-identical ideas scores well per-idea and is worthless. Standard idea-level benchmarks are used here only as *calibration instruments*, never as the primary outcome.
2. **The study must be able to refute the product.** The single-call baseline (Arm A) exists so that "multi-agent beats one call" is a *finding*, not an assumption. If Arm A wins on cost-adjusted diversity, that is a publishable result about ideate-core and we report it.

### The user's prompt is unknowable — and that's fine

The app takes an arbitrary user brief, so we cannot eval "the prompt." We hold the prompt **constant across arms** and vary only the model configuration. The brief becomes a random effect in the statistical model (§6), which is precisely how you generalize beyond the specific briefs tested. We are measuring the *engine*, controlling for the prompt — not measuring the prompt.

---

## 1. Blockers — do not run before these land

| # | Blocker | Why it invalidates the study |
|---|---|---|
| B1 | **Audit finding IC-01** (duplicate candidate IDs when agents share a persona) | Mixed-tier arms (E, F, G) assign the same persona to different models. At the original SHA that collides IDs and **silently deletes candidates downstream** (verified: 7 in → 5 out). Every diversity metric would be computed on a silently truncated pool, biased *against* the mixed arms — i.e. it would fake a result. Fix = the verified one-liner in the audit (`ctx.temperature` → `ctx.agentId`). **✅ CLOSED — `ideate-core#87`, 2026-07-31; shipped in `ideate-core@0.4.0`** (Appendix A, item 2). |
| B2 | **`temperature` is rejected by current frontier models** | Opus 5, Sonnet 5, Opus 4.8/4.7 and Fable 5 return **HTTP 400** if `temperature` is sent. `DEFAULT_PERSONAS` sets `temperature: 0.4…1.0` and `safeComplete` forwards it. Haiku 4.5 still accepts it. So a mixed haiku/sonnet/opus panel **400s on 3 of 5 agents** unless the adapter strips the parameter per-model. See §3.3. **✅ CLOSED — `ideate-core#89`, 2026-07-31; `ideate-core@0.4.0` exports the strip-and-warn helper at `ideate-core/integrations/sampling-params`** (Appendix A, item 2). |
| B3 | **No token accounting in ideate-core** | The cost ledger (§7) needs per-call token counts. The engine currently discards the provider's `usage` object entirely. The adapter must capture it (no core change required — the adapter owns the client). **⏳ Still OPEN — correctly homed in the adapter: closes when the generation adapter captures `usage`** (Appendix A, item 2). |

B2 is also a **finding about the library**, not just the eval: ideate-core documents temperature as a per-agent diversity lever, and that lever is now unavailable on most current Anthropic models. Persona is the only surviving structural lever — which happens to be what the literature says is stronger anyway (Wang et al. 2023), but the docs should say "unavailable on current frontier models," not present it as a live knob. *(2026-08-02: `ideate-core` now has **zero** open issues — the 20-finding audit `ideate-core#86` that produced B1 and B2 is fully remediated, including its two cross-repo template items. See Appendix A, item 2.)*

---

## 2. Prior work — what we can reuse as an answer key

Verified against current sources (2026-07-30). **These are the assets that turn this from a vibes-comparison into a calibrated measurement.**

| Asset | What it gives us | How we use it | License / access |
|---|---|---|---|
| **NoveltyBench** (arXiv [2504.05228](https://arxiv.org/abs/2504.05228), [site](https://novelty-bench.github.io/)) | `distinct_k` — cluster k generations into semantic equivalence classes, count occupied classes. Published finding: SOTA models yield **<4 distinct responses in 10 samples**, and **novelty scales *inversely* with model size**. | **Primary metric.** `distinct_k` is conceptually identical to ideate-core's dedup+cluster stage, so we adopt their metric rather than inventing one. Their inverse-scaling finding becomes registered hypothesis **H4**. | Public |
| **Si, Yang & Hashimoto 2024** — *Can LLMs Generate Novel Research Ideas?* (arXiv [2409.04109](https://arxiv.org/abs/2409.04109), code [NoviScl/AI-Researcher](https://github.com/NoviScl/AI-Researcher)) | ~300 ideas across 3 conditions (Human / AI / AI+Rerank) with blind reviews from **79 expert reviewers**, numerical scores + rationales. MIT-licensed repo; idea/review payloads on Google Drive. | **Human answer key for judge validation (§5).** Our LLM judge must reproduce expert *rankings* on a held-out slice before it is allowed to score our pools. Also supplies a **human novelty baseline** to anchor the scale. | MIT (repo); verify Drive payload terms before redistribution |
| **OCSAI** — Open Creativity Scoring w/ AI ([openscoring.du.edu](https://openscoring.du.edu/)) | Fine-tuned scorer trained on **27,000 human-judged** divergent-thinking responses; **r = 0.81 with human raters**; originality on a 1–5 scale; free API. | **Pre-calibrated second judge.** Its human correlation is *published*, so it is an instrument with known error — far stronger than an uncalibrated LLM judge. Used on the AUT-style probe items (§4.2). | Free API; confirm rate limits + ToS for programmatic use |
| **LiveIdeaBench** (arXiv [2412.17596](https://arxiv.org/abs/2412.17596), *Nature Communications*; [code](https://github.com/x66ccff/liveideabench)) | 1,180 single-keyword prompts across 18 scientific domains; 4-axis rubric (originality / feasibility / fluency / flexibility). | **Brief corpus source** for the science-domain stratum, and the **rubric wording** for our judge prompt (reusing a peer-reviewed rubric beats writing our own). | Public repo |
| **Divergent Association Task** (Olson et al. 2021, PNAS; [code](https://github.com/jayolson/divergent-association-task)) | Semantic-distance creativity measure with published human norms. | **Sanity check on our diversity metric.** Run DAT through our embedding pipeline; if our pool-diversity number doesn't reproduce DAT's ordering on its own normed data, our metric is broken before we point it at ideate-core. | Public |

**Honest limits of the answer keys.** Si et al. is *research ideation by NLP experts* — a narrow domain, and our briefs are mostly business/product. It calibrates the *judge*, not the task. OCSAI is trained on Alternate-Uses responses, which are much shorter than our candidates; treat its absolute scores as suspect and use it only for *relative* ordering. Neither is a ground truth for "good marketing idea." Stated so the report can't overclaim.

---

## 3. Design

### 3.1 Arms (9 configurations)

Panel size fixed at **5 agents**, `ideasPerAgent: 6`, `maxRounds: 2` (blind → pool) for every panel arm, so the *only* thing varying is model assignment.

| Arm | Configuration | Purpose |
|---|---|---|
| **A** | **Solo baseline** — 1 call, "generate 30 genuinely different ideas", no panel, no rounds | **The control that can falsify the product.** This is the "most ideation wrappers are one call" strawman the README claims to beat. Matched on total ideas requested. |
| **B** | Homogeneous **Haiku 4.5** ×5 | Cheap floor; tests NoveltyBench inverse-scaling (H4) |
| **C** | Homogeneous **Sonnet 5** ×5 | Mid tier |
| **D** | Homogeneous **Opus 5** ×5 | Expensive ceiling |
| **E** | **Anthropic tiered mix** — 2×Haiku, 2×Sonnet, 1×Opus | The "combination" hypothesis (H2): does heterogeneity buy diversity cheaply? |
| **F** | **Anthropic inverted mix** — 2×Opus, 3×Haiku | Separates *heterogeneity* from *average capability*: E and F differ in tier mix at similar spread |
| **G** | **Cross-provider mix** — 3×Anthropic (H/S/O), 2×OpenAI | The cross-provider claim (H3) |
| **H** | Homogeneous **OpenAI** ×5 | Control for G — isolates "cross-provider" from "OpenAI is just different" |

**Ablation arm (cheap, high value):** **A′** — panel of 5 identical models with *identical personas* (persona lever disabled). Isolates how much of the panel's benefit is persona engineering vs. merely sampling 5 times. Costs one extra arm; answers the question a skeptical reviewer asks first.

### 3.2 Items (briefs) — n = 12, stratified

Held constant across arms. Stratified so results generalize across task type, not just one domain:

| Stratum | n | Source |
|---|---|---|
| Business / go-to-market | 4 | Authored; the actual use case |
| Product / feature ideation | 3 | Authored |
| Scientific | 3 | Sampled from LiveIdeaBench keyword set (traceable, external) |
| Classic divergent-thinking | 2 | AUT-style ("uses for X") — the only stratum OCSAI can score |

Briefs are **frozen and hashed** into the run manifest. Adding a brief mid-study invalidates the pre-registration.

### 3.3 Held constant (and the awkward part)

Same prompt builders, same `ideasPerAgent`, same personas, same rounds, same embedder, same judge panel, same seed for all non-model randomness.

**Temperature cannot be held constant, and this is a real threat to validity.** Per B2, Haiku 4.5 accepts `temperature`; Opus 5 / Sonnet 5 reject it with a 400. So we cannot run all arms at matched temperature. Options, with the honest trade-off:

| Option | Trade-off | **Chosen** |
|---|---|---|
| Strip `temperature` everywhere | Haiku runs at its default instead of the persona's tuned value — *removes* a diversity lever the haiku arms would otherwise have, biasing **against** B/E/F | ✅ **Yes** |
| Send temperature where accepted | Confounds model with sampling policy — B's advantage would be uninterpretable | No |

We strip it universally and **state the bias direction explicitly**: if the haiku arms still win on diversity, they did so with one lever disabled, which strengthens rather than weakens the finding. If they lose, the result is confounded and must be reported as such. This is registered in advance so it can't be rationalized after the fact.

> **Implementation note (2026-08-02, [Appendix A](#appendix-a--amendments-dated-2026-08-02) item 3). The registered universal-strip decision above is UNCHANGED.** Recorded so a reader can see the code matches the registered decision rather than the library default: `ideate-core@0.4.0` ships `modelAcceptsSamplingParams` (at `ideate-core/integrations/sampling-params`), which strips **per-model** and returns `true` for Haiku. Using that helper unmodified would leave the Haiku arms the diversity lever and **invert** the registered bias direction — which materially affects **H4** (Haiku panel ≥ Opus panel). The generation adapter therefore **force-strips on every model**, Haiku included, rather than deferring to the helper's per-model default.

### 3.4 Replication and power

**Why replicate at all:** a single run per (arm × brief) measures one draw from a stochastic process. Sampling variance in LLM generation is large relative to the between-arm effects we care about; without replication we'd be ranking noise.

- **n = 4 independent runs per (arm × brief).** 9 arms × 12 briefs × 4 = **432 runs**.
- Runs differ only by run index (no seed control is possible — the APIs don't expose one; this is a limitation, not a choice).
- **Power:** run a **pilot** (§8, Phase 1) at 2 arms × 4 briefs × 4 reps to estimate the between-run variance component, then *recompute* required n before committing to the full grid. Do not trust the n=4 figure until the pilot says so — it is a placeholder chosen for budget, not derived from a variance estimate we have.

---

## 4. Metrics

### 4.1 Primary (pool-level)

| Metric | Definition | Provenance |
|---|---|---|
| **`distinct_k`** | Number of semantic equivalence classes occupied by the pool, via embedding clustering | NoveltyBench |
| **`distinct_k` per dollar** | `distinct_k` ÷ run cost | **The headline metric.** Answers the question actually asked. |
| **Pool diversity** | Mean pairwise cosine *distance* across the embedded pool | ideate-core's own `poolDiversity` — tests the library's own metric |
| **Collapse rate** | 1 − (semantic-dedup survivors ÷ raw candidates) | Direct mode-collapse measure |

### 4.2 Secondary (idea-level, split axes — never collapsed)

| Metric | Notes |
|---|---|
| **Novelty** (judged, 1–5) | Split-axis per Rietzschel et al. 2010 — *never* averaged with feasibility into a single "best" |
| **Feasibility** (judged, 1–5) | Same |
| **OCSAI originality** | AUT stratum only; instrument with published r = 0.81 to humans |
| **Fluency / Flexibility** | LiveIdeaBench axes: valid candidates emitted; distinct categories covered |

### 4.3 Operational (the ones that bite in production)

| Metric | Why it matters |
|---|---|
| **Parse-failure rate** | Fraction of agent replies from which `extractCandidates` recovered nothing. Directly measures the robustness ideate-core advertises, per model. |
| **Empty-pool rate** | Runs returning `candidates: []` — the silent-failure mode from audit IC-08 |
| **Refusal rate** | Opus 5 / Sonnet 5 can return `stop_reason: "refusal"`; must be counted, not silently dropped |
| **Latency (p50 / p95)** | Wall-clock per run |
| **Tokens in / out / cache** | Per model. Feeds the cost ledger (§7) |

### 4.4 Negative controls (do these first — they catch a broken harness)

A study that can't fail its own sanity checks isn't measuring anything.

| Control | Expected result | Catches |
|---|---|---|
| **Duplicate pool** — 30 copies of one idea | `distinct_k` = 1, diversity ≈ 0 | Broken dedup/embedding wiring |
| **Random-text pool** — 30 unrelated sentences | `distinct_k` ≈ 30, diversity near max | Metric saturation / clustering collapse |
| **Shuffled-label control** — judge the same pool twice with arm labels permuted | No score difference | Label leakage into the judge |
| **DAT replication** | Reproduces published DAT ordering on its normed data | Embedding pipeline validity (§2) |

---

## 5. The judge — validate the instrument before using it

**You cannot measure with an uncalibrated instrument.** The judge is validated *first*, and gated.

### 5.1 Validation gate

1. Hold out a slice of Si et al. ideas with expert scores.
2. Judge scores them blind.
3. **Gate:** Spearman ρ between judge and expert *rankings* must clear a pre-registered floor (**ρ ≥ 0.4**, in the neighborhood of the human-human inter-rater agreement Si et al. themselves report — confirm their reported figure and set the floor to it, rather than to a number we like).
4. **If the gate fails, the idea-level metrics are dropped from the study** and we report pool-level metrics only. We do not proceed with a judge we know doesn't track humans. This is registered in advance.

> **⚠️ Amended 2026-08-02 ([Appendix A](#appendix-a--amendments-dated-2026-08-02), item 4) — the gate metric and floor in point 3 are SUPERSEDED. Point 4's consequence is unchanged.**
>
> **Si et al. 2024 do not report a human-human Spearman ρ** (verified against arXiv:2409.04109 on 2026-08-02; footnote 11 explicitly rejects correlation-style agreement metrics like Krippendorff's α for their non-overlapping reviews). The number point 3 reaches for **does not exist**, so the `ρ ≥ 0.4` placeholder rests on a false premise and is **withdrawn**.
>
> **Registered replacement.** The gate metric becomes Si et al.'s **own** split-half top/bottom-25% **balanced-accuracy** construction (Lu et al. 2024; Si et al. Section 5 / Table 11), floored at their reported **human-human figure, 56.1%** — the faithful reading of point 3's own instruction to "confirm their reported figure and set the floor to it." Spearman ρ is **retained as a descriptive statistic** (still computed and reported) but is no longer the gate. Three registered consequences, all recorded before any data is collected — see Appendix A item 4 for the full construction and the 53.3% Claude-3.5 comparator.
>
> **Which axis, against which column ([Appendix A](#appendix-a--amendments-dated-2026-08-02) item 7).** Point 1's "expert scores" is one column and point 2's "judge scores them" is one of four axes — the mapping between them was never registered. Item 7 registers it: the judge's **`originality`** axis validates against the Si et al. **`overall_score`** column, with the construct mismatch disclosed. It also records the shape-matched **51.7%** (Claude-3.5 *Direct*) comparator alongside the existing 53.3% (*Pairwise*), and the median-threshold / split-count construction deviations.

### 5.2 Self-preference bias — measured, not assumed

Wataoka et al. 2024: models rate their own output higher. Every arm here is scored by *some* model, so this is a live confound.

**Design:** full **cross-judge matrix** — every pool scored by both an Anthropic judge and an OpenAI judge, neither of which may be a generator in that arm (enforced by ideate-core's own `assertEvaluatorDistinct`). The bias term is then *estimated* as a model coefficient (§6) rather than hoped away. Registered hypothesis **H5** predicts a non-zero same-provider bias; if we find one, all cross-provider comparisons are reported **bias-adjusted**.

### 5.3 Judging hygiene

- Ideas **de-identified** — no model/persona/arm label reaches the judge
- Presentation **order randomized** per judge call (position bias)
- Judge prompt **frozen and hashed**; changing it restarts the study
- **Score-only, no reasoning-then-score drift**: identical rubric wording per call, drawn from LiveIdeaBench's published axes

---

## 6. Analysis plan (frozen before data collection)

### 6.1 Registered hypotheses

| ID | Hypothesis | Direction | Falsifies what |
|---|---|---|---|
| **H1** | Any panel arm > Arm A (solo) on `distinct_k` at matched idea count | Panel > solo | **The product's core claim.** If null, ideate-core's machinery isn't earning its complexity. |
| **H2** | Mixed-tier (E) ≥ homogeneous-Opus (D) on `distinct_k` at materially lower cost | E ≥ D, cost(E) < cost(D) | The "combination" pitch |
| **H3** | Cross-provider (G) > best within-provider (D or H) on `distinct_k` | G > max(D,H) | The heterogeneity claim (Wataoka) |
| **H4** | Haiku panel (B) ≥ Opus panel (D) on `distinct_k` | B ≥ D | NoveltyBench inverse-scaling, **replicated on pools**. A genuinely surprising prediction — registering it in advance is what makes confirming it meaningful. |
| **H5** | Same-provider judging inflates scores vs cross-provider | bias > 0 | Judge validity |

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
- Not drop failed runs silently — parse failures and refusals are *findings* (§4.3), reported per arm
- Not re-run an arm that "looks wrong" without registering the re-run

---

## 7. Cost accounting — conforms to the cron-fleet / CFO contract

The harness emits a ledger row per run matching **cwc#1639 / cron-fleet#35 / #75** requirements (read at `code-workspace-config` cwc#1639 and `cron-fleet/lib/cron-health/fleet-cost.mjs`):

1. **Price at READ TIME from `model` + token counts + billing regime.** The ledger stores the *fact* (tokens × model × timestamp), never a derived dollar figure as authoritative — the exact defect cron-fleet#75 exists to fix.
2. **Row carries** `model`, `input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`, `billing_mode`, timestamp. **No `cost_usd` column.**
3. **`billing_mode: "api"`** for this study (real metered spend). A subscription-mode row would carry `notional_usd`, never `cost_usd` — and the report must name the regime for any dollar figure it shows.
4. Multi-model runs use **`tokens_by_model`** (the schema-v2 field for a run spanning models) — mandatory for the mixed arms E/F/G.

A separate `price.mjs` applies a **pinned, dated rate table** at read time. Re-pricing the whole study after a rate change is then a one-line re-run, not a re-collection.

---

## 8. Budget

### 8.1 Rates (verified 2026-07-30)

| Model | In $/MTok | Out $/MTok | Source |
|---|---|---|---|
| Claude Opus 5 | 5.00 | 25.00 | claude-api skill (cached 2026-06-24) |
| Claude Sonnet 5 | 3.00 (2.00 intro → 2026-08-31) | 15.00 (10.00 intro) | same |
| Claude Haiku 4.5 | 1.00 | 5.00 | same |
| OpenAI `gpt-5.6-terra` (mid tier) | 2.00 | 12.00 | **developers.openai.com/api/docs/pricing — verified first-party 2026-08-02** |
| OpenAI `gpt-5.6-sol` (large tier) | 5.00 | 30.00 | same |
| Voyage-4-lite embeddings | 0.02 | — | + **200M free tokens/account**; batch −33% |

> *Amended 2026-08-02 ([Appendix A](#appendix-a--amendments-dated-2026-08-02), item 5). The OpenAI row previously read `~2.00–5.00 / ~12.00–30.00` sourced from "aggregator sites, not openai.com — must verify before running". Now verified first-party against `developers.openai.com/api/docs/pricing` (2026-08-02); the **50% Batch API discount** is confirmed on the same page. The full per-model OpenAI rate table lives with the OpenAI adapter (#22) and in `lib/price.mjs`'s dated `RATE_TABLE` + `OPENAI_PRICE_VERIFICATION` record. **Anthropic rates are correct as written and are unchanged.***

**Two levers cut this roughly in half:**
- **Anthropic Batch API: −50%.** Evals are latency-insensitive → ideal fit. (Not available on Bedrock/Vertex; first-party only.)
- **OpenAI Batch API: −50%**, same rationale.

Embeddings are **effectively free** under Voyage's 200M-token free allocation.

### 8.2 Projection

Per-run estimate ≈ 16k input / 9k output tokens (5 agents × 2 rounds, pool-sharing inflates round-2 input).

| Arm | Batch cost/run (est.) | Runs | Subtotal |
|---|---|---|---|
| A (solo) | ~$0.02 | 48 | $1 |
| A′, B (haiku) | ~$0.03 | 96 | $3 |
| C (sonnet) | ~$0.06 | 48 | $3 |
| D (opus) | ~$0.15 | 48 | $7 |
| E, F (mixed) | ~$0.08 | 96 | $8 |
| G, H (openai) | ~$0.09 | 96 | $9 |
| **Generation subtotal** | | **432** | **~$31** |
| Judging (2 judges × 432 pools, batched) | ~$0.05/pool | 864 | ~$43 |
| Judge validation (§5.1) | one-off | — | ~$5 |
| Embeddings | free tier | — | ~$0 |
| **Projected total** | | | **~$79** |
| **With 2× contingency** (pilot, re-runs, failed batches) | | | **~$160** |

**Under the $200 ceiling with real headroom.** The contingency is not padding — a pilot that changes n (§3.4) is the single most likely reason this grows, and it should be allowed to.

**Hard cost controls in the harness:**
- A `--max-spend` pre-flight that prices the *planned* grid from the pinned rate table and **refuses to start** if the projection exceeds the ceiling
- Per-batch spend logged to the ledger as it lands; running total checked between phases
- Phase gates (§8.3) — no phase starts without an explicit go

### 8.3 Phased execution

| Phase | What | Cost | Gate |
|---|---|---|---|
| **0** | Negative controls (§4.4) + DAT replication | ~$0 | All controls pass, or stop |
| **1** | Judge validation vs Si et al. | ~$5 | ρ ≥ floor, or drop idea-level metrics |
| **2** | Pilot: 2 arms × 4 briefs × 4 reps | ~$5 | Estimate variance → **recompute n** |
| **3** | Full grid | ~$70 | — |
| **4** | Analysis + report | $0 | — |

---

## 9. Deliverables

| Artifact | Description |
|---|---|
| `evals/harness/` | Runner: arm configs, batch submission, ledger emission, resume-on-failure |
| `evals/metrics/` | `distinct_k`, diversity, collapse rate, DAT check, negative controls |
| `evals/judge/` | Judge prompts (frozen + hashed), cross-judge matrix, Si et al. validation |
| `evals/corpus/` | 12 frozen briefs + hashes + provenance |
| `evals/analysis/` | Mixed-effects model, contrasts, Pareto frontier plot |
| `evals/ledger/` | Repriceable cost rows (§7) + `price.mjs` with dated rate table |
| `REPORT.md` | Findings, effect sizes + CIs, Pareto frontier, registered-vs-exploratory split |
| `PREREGISTRATION.md` | This document, frozen and hashed at run start |

**Not wired into CI** (per instruction). Runs on demand via `node evals/run.mjs --phase N`. The negative controls (Phase 0) are hermetic and *could* run in CI later at zero cost — flagged as an option, not built.

---

## 10. Threats to validity — stated up front

| Threat | Mitigation | Residual |
|---|---|---|
| Temperature unavailable on frontier models (B2) | Strip universally; state bias direction | Real. Biases against haiku arms; can't be eliminated |
| Judge ≠ human | Validate vs Si et al.; gate on ρ | Si et al. is research-ideation, not business ideation |
| Self-preference bias | Cross-judge matrix; estimate bias term | Only two providers judged; a third would triangulate better |
| Model versions drift | Pin exact model IDs in manifest; record at run time | Providers can change a model behind a stable ID |
| Embedding model shapes diversity metric | DAT replication as validity check; single embedder held constant | An embedder that can't separate our domain would compress all arms |
| 12 briefs may not generalize | Stratified; brief as random effect | Still 12. Report per-stratum effects |
| Prompt builders tuned (unintentionally) to one provider | Same builder everywhere; generic wording | Untested — could add a prompt-variant robustness check |

---

## 11. Additive accumulation — and the statistical hazard it creates

Results **accumulate**. A run contributes cells to a durable store rather than replacing it, so replicate count grows across sessions instead of being re-collected. `lib/manifest.mjs` implements this: a cell is `(arm, brief, replicate)` keyed by a `configHash` over everything that could change the measurement (engine SHA, prompt hash, judge hash, embedder, panel shape).

Three properties, all tested in `lib/manifest.test.mjs`:

- **Reuse** — completed cells under the same config are never re-run.
- **Extend** — raising `replicates` or adding an arm queues *only* the new cells.
- **Never silently pool** — change the engine SHA or a brief and the config hash changes, so prior cells get a different key. They are not reused, and they are not deleted; `planRun` returns them as `stale` for the analysis to consider explicitly.

### ⚠️ The hazard: optional stopping

**Accumulating data and re-analyzing after each batch is [optional stopping](https://en.wikipedia.org/wiki/Optional_stopping_theorem), and it inflates false-positive rates badly** — with naive repeated testing at α = 0.05, the probability of eventually crossing significance approaches 1 as you keep adding data. "Run 20, look, run 200, look again" is exactly the shape that breaks a fixed-α analysis.

This is a real tension with the additive design, and it is resolved by *separating the two things accumulation is good for*:

| Use of accumulated data | Allowed? | Why |
|---|---|---|
| **Precision** — tighter CIs on an effect whose n was fixed in advance | ✅ Yes | Estimation, not testing. More data narrows the interval; no α is being spent. |
| **Variance estimation** — pilot informs the n for the confirmatory phase | ✅ Yes | This is the pilot's *purpose*. The pilot's own data is then **not reused** in the confirmatory test. |
| **Exploration** — new arms, new briefs, hypothesis generation | ✅ Yes, **labeled exploratory** | Reported in a separate section with BH correction and no confirmatory claims. |
| **Testing a registered hypothesis, then adding data, then re-testing** | ❌ **No** | Optional stopping. This is the one that manufactures false findings. |

**The rule this repo enforces:** the confirmatory analysis of H1–H5 runs **once**, at the pre-registered n determined by the pilot. Everything after that is estimation or exploration, and is labeled as such in `REPORT.md`. If a later run genuinely needs to re-test a registered hypothesis, it requires either a **fresh pre-registration** (new hypothesis, new data) or an **alpha-spending / group-sequential** design declared up front — not a quiet re-run of the same test on a bigger pile.

Both the "pilot for the pilot" (§8.3 Phase 2a) and the additive store are compatible with this, because neither is used to *test* a confirmatory hypothesis.

---

## 12. Configurability

Every knob the study varies is config, not code:

| Knob | Flag | Notes |
|---|---|---|
| Spend ceiling | `--max-spend <usd>` | Pre-flight prices the planned grid from the pinned rate table and **refuses to start** if the projection exceeds it. Cells skipped for budget are recorded as `skipped: budget_exceeded`, never dropped. |
| Which arms | `--arms A,B,E` | Subset the grid |
| Which models | `arms.config.json` | Model IDs per persona slot, per arm |
| Replicates | `--replicates <n>` | Additive — raising it queues only new cells |
| Briefs | `--briefs <ids>` | Subset the corpus |
| Phase | `--phase <0-4>` | Gated; see §8.3 |
| Dry run | `--dry-run` | Prints the plan, the reuse/todo/stale split, and the cost projection. Calls nothing. |

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

**Why it must be recorded.** `ideate-core@0.4.0` ships `modelAcceptsSamplingParams` (at `ideate-core/integrations/sampling-params`), which strips **per-model** and returns `true` for Haiku. Using that helper unmodified would leave the Haiku arms the diversity lever and **invert** the registered bias direction — which materially affects **H4** (Haiku panel ≥ Opus panel). The generation adapter therefore **force-strips on every model**, Haiku included, so the implementation matches the *registered* decision rather than the library's per-model default. Recorded so a reader can see the code matches §3.3 rather than silently diverging from it.

### Item 4 — §5.1: the ρ floor rests on a false premise; the gate metric and floor are replaced (**the substantive amendment**)

**What changed.** §5.1's gate metric changes from **Spearman ρ (floored at the placeholder ρ ≥ 0.4)** to **Si et al.'s own split-half top/bottom-25% balanced-accuracy construction, floored at their reported human-human figure of 56.1%**. The arbitrary `0.4` is **withdrawn**. §5.1 point 4's consequence (a failed gate drops idea-level metrics and reports pool-level only) is **unchanged**.

**Why.** **Si et al. 2024 do not report a human-human Spearman ρ** (verified against arXiv:2409.04109 on 2026-08-02). Footnote 11 explicitly rejects correlation-style agreement metrics: the balanced-accuracy metric "avoids the limitations of other agreement metrics like Krippendorff's alpha, which require overlapping reviews and would result in a sparse matrix" — their reviews do not overlap enough to support a correlation statistic. The number §5.1 point 3 reaches for does not exist, so the gate cannot be instantiated as registered.

What they **do** report (Section 5 / Table 11) is a split-half balanced accuracy: reviewers of each paper are randomly split in half; one half ranks the top and bottom 25% of ideas; agreement is measured against the held-out half.

| Comparison | Balanced accuracy |
|---|---|
| **Si et al. expert reviewers (human-human)** | **56.1%** |
| NeurIPS 2021 consistency experiment | 66.0% |
| ICLR 2024 LM-related submissions (1.2K) | 71.9% |
| Best LLM evaluator they tested (Claude-3.5 pairwise ranker) | 53.3% |

Study size: N = 79 expert reviewers, 298 unique reviews, 49 ideas.

**Three consequences, all registered in advance:**

1. **Spearman ρ is retained as a descriptive statistic** (`evals/judge/gate.mjs`'s `spearmanRho` stays and is still reported), but it is **no longer the gate**. The arbitrary 0.4 is withdrawn.
2. **The floor is demanding, deliberately.** Si et al.'s own best LLM evaluator scored 53.3% and would fail the 56.1% floor. Per §5.1 point 4 the registered consequence is that idea-level metrics are dropped and only pool-level results are reported — an acceptable, pre-registered outcome, provided it comes from a real measurement rather than an unrun gate.
3. **53.3% becomes a registered comparator.** Because Table 11 measures the best LLM evaluator on the *same* metric, we can state in advance whether our judge beats it, rather than deciding after we look.

The implementing code change (`resolveRhoFloor` → the registered balanced-accuracy floor, `validateJudge` reading the new metric and constant) lands with **#16 / #24**, not here. This entry is the pre-registration record of the decision.

### Item 5 — §8.1: OpenAI rates were aggregator-sourced; now verified first-party

**What changed.** §8.1's OpenAI row (previously `~2.00–5.00 / ~12.00–30.00`, flagged "aggregator sites, not openai.com — must verify before running") is replaced with **first-party verified per-model rates**: `gpt-5.6-terra` (mid) at 2.00 / 12.00 and `gpt-5.6-sol` (large) at 5.00 / 30.00, verified against `developers.openai.com/api/docs/pricing` on 2026-08-02. The **50% Batch API discount** the batch-first budget assumes is confirmed on the same page. **Anthropic rates are correct as written and are unchanged** (Opus 5 $5/$25, Sonnet 5 $3/$15 with the $2/$10 introductory rate through 2026-08-31, Haiku 4.5 $1/$5).

**Why.** §8.1 itself flagged the OpenAI row as unverified and forbade running against it. The full per-model OpenAI table and its verification record live with the OpenAI adapter (#22) and in `lib/price.mjs`'s dated `RATE_TABLE` + `OPENAI_PRICE_VERIFICATION`.

### Item 6 — §3.1 heading: count fix (cosmetic)

**What changed.** The §3.1 heading "Arms (**8** configurations)" → "Arms (**9** configurations)".

**Why.** The arm table is A–H (8) **plus** the A′ ablation, and §3.4 and the epic both say 9 arms. A one-character count correction, folded in with the substantive amendments above rather than spending a separate change on it.

### Item 7 — §5.1: register the judge-axis ↔ expert-column validation mapping, correct the LLM comparator, state the construction deviations

*Registered 2026-08-02, before any judge results are seen — a pre-registration act, not a post-hoc choice.*

**What changed.** §5.1's validation gate now registers **which** judge axis is validated against **which** Si et al. expert-review column: the judge's **`originality`** axis ↔ the **`overall_score`** column. The mapping lives as named constants (`JUDGE_VALIDATION_AXIS` / `SI_ET_AL_EXPERT_SCORE_FIELD` in `evals/judge/config.mjs`), and the composition that runs it (`runJudgeValidation`, `evals/judge/validate.mjs`) threads `readSiEtAlSlice → sliceToJudgePool → judge.score → judgeScoresForAxis → validateJudge → recordValidation`, recording the axis and expert column actually used.

**Why `originality` ↔ `overall_score`.**

1. **Why `originality`.** Novelty is the study's primary idea-level metric (§4.2) and Si et al.'s own headline finding, so `originality` is the axis whose validity most needs establishing.
2. **Why `overall_score`.** The registered 56.1% floor (item 4) is human-human split-half agreement on **one column**. The floor is **coupled to the column**: validating against `novelty_score` instead would require deriving and registering a *different* floor — a second pre-registration act. `overall_score` is the only choice whose floor is already registered.
3. **The construct mismatch is real and is DISCLOSED, not hidden.** This validates a *novelty* judgment against an *overall-quality* answer key. `REPORT.md` must state this plainly as a limitation. It is registered here so the limitation is on record before any number is seen. (`feasibility` ↔ `feasibility_score` is a plausible future addition, but it needs its own derived floor and is **not** registered here.)

**Comparator correction — the shape-matched figure is 51.7%, not 53.3%.** Item 4's table registers **53.3%** as "best LLM evaluator". Verified against arXiv:2409.04109 Table 11 (2026-08-02): that figure is **Claude-3.5 Pairwise**. **Claude-3.5 Direct is 51.7%.** Our judge is a *direct, score-only* scorer, so **51.7% is the apples-to-apples comparator** for our shape; 53.3% remains valid as "their best evaluator of any shape". Both are now registered as named constants (`SI_ET_AL_LLM_COMPARATOR_DIRECT = 0.517`, `SI_ET_AL_LLM_COMPARATOR_PAIRWISE = 0.533`) and both are reported, so the comparison is not misleading.

| Comparison | Balanced accuracy | Shape |
|---|---|---|
| **Si et al. expert reviewers (human-human)** — the floor | **56.1%** | — |
| Claude-3.5 **Pairwise** ranker (their best LLM evaluator, any shape) | 53.3% | ranker |
| Claude-3.5 **Direct** score-only (shape-matched to our judge) | **51.7%** | direct scorer |

**Construction deviations, stated rather than silently differed.** Our balanced-accuracy construction differs from Si et al.'s in two ways that must be disclosed before any comparison is drawn:

- **Thresholding.** Si et al. threshold LLM evaluators at their **median score**; `balancedAccuracyTopBottom` ranks the labelled top-k/bottom-k set and splits there. Different construction.
- **Split count.** Footnote 11 states they average **20** random splits; `balancedAccuracySplitHalf` defaults to `splits = 100` and `reproduce-si-et-al.mjs` passes **1000**. State the seed and the count with any reported number (item 4 point 1 / `docs/fetching-si-et-al.md`).

**What lands where.** The registered constants (`config.mjs`) and the composition + its hermetic tests (`validate.mjs`, `validate.test.mjs`) land with **#36**. Running the composition against the **real** slice needs the live judge key and metered spend and stays on **#16**; it also depends on the #35 slice-join repair landing first (native `blocked_by` edge). This entry is the pre-registration record of the decision.
