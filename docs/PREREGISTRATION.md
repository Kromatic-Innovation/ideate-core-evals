# ideate-core — Comparative Ideation Study (eval spec v0.1)

**Status:** pre-registration draft. Nothing has been run. Numbers below are cost *projections*, not measurements.
**Date:** 2026-07-30 · **Target SHA:** ideate-core `develop` @ `920c086` + fix A1 (see Blockers)

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
| B1 | **Audit finding IC-01** (duplicate candidate IDs when agents share a persona) | Mixed-tier arms (E, F, G) assign the same persona to different models. At this SHA that collides IDs and **silently deletes candidates downstream** (verified: 7 in → 5 out). Every diversity metric would be computed on a silently truncated pool, biased *against* the mixed arms — i.e. it would fake a result. Fix = the verified one-liner in the audit (`ctx.temperature` → `ctx.agentId`). |
| B2 | **`temperature` is rejected by current frontier models** | Opus 5, Sonnet 5, Opus 4.8/4.7 and Fable 5 return **HTTP 400** if `temperature` is sent. `DEFAULT_PERSONAS` sets `temperature: 0.4…1.0` and `safeComplete` forwards it. Haiku 4.5 still accepts it. So a mixed haiku/sonnet/opus panel **400s on 3 of 5 agents** unless the adapter strips the parameter per-model. See §3.3. |
| B3 | **No token accounting in ideate-core** | The cost ledger (§7) needs per-call token counts. The engine currently discards the provider's `usage` object entirely. The adapter must capture it (no core change required — the adapter owns the client). |

B2 is also a **finding about the library**, not just the eval: ideate-core documents temperature as a per-agent diversity lever, and that lever is now unavailable on most current Anthropic models. Persona is the only surviving structural lever — which happens to be what the literature says is stronger anyway (Wang et al. 2023), but the docs should say "unavailable on current frontier models," not present it as a live knob.

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

### 3.1 Arms (8 configurations)

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
| OpenAI (mid/large tiers) | ~2.00–5.00 | ~12.00–30.00 | ⚠️ **aggregator sites, not openai.com** — must verify before running |
| Voyage-4-lite embeddings | 0.02 | — | + **200M free tokens/account**; batch −33% |

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
