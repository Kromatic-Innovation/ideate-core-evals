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
**Date:** 2026-07-30 · **Target engine:** ideate-core `@0.5.0` (npm, published 2026-09-07) — pinned.

> _Amended 2026-08-02 ([Appendix A](#appendix-a--amendments-dated-2026-08-02), item 1). Was: `Target SHA: ideate-core develop @ 920c086 + fix A1`. That SHA predates the remediation; `ideate-core@0.4.0` contains the fixes for **both** registered blockers (B1, B2). The runtime `engineSha` in the manifest is now the resolved package version (`ideate-core@0.4.0`) rather than the `"unpinned"` literal `evals/run.mjs` originally shipped._

> _Amended 2026-09-08 ([Appendix E](#appendix-e--amendments-dated-2026-09-08), item 9). Was: `ideate-core@0.4.0`. Bumped to **`ideate-core@0.5.0`** (`ideate-core-evals#134`, merged `94be181`) — the release that ships the per-agent `effort` field this very amendment's item 3 depends on. No manual `configHash` bump was made or needed: `engineSha` is derived from the installed version at runtime, so `configHash` moved on its own (`1a62e8d92d34` → `119708570b71`). See the appendix for the full verification and what else 0.5.0 contains._

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

> _Amended 2026-09-02 ([Appendix D](#appendix-d--amendments-dated-2026-09-02), item 2). Exception (1) below is **narrowed**, not closed: issue #103 makes the harness re-poll a surrendered batch handle on a later invocation and meter its recovered replies, so an abandoned batch's spend is now absent from the ledger only until it is re-polled rather than permanently. The same item registers a second, distinct hazard resume makes reachable — batch-produced spend priced at the single-call rate — and how it is made unreachable._
>
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

> _Amended 2026-09-08 ([Appendix E](#appendix-e--amendments-dated-2026-09-08), item 2). The fixed panel geometry above is now the **default**, not the only option: `size` / `ideasPerAgent` / `maxRounds` / `sharing` are per-arm overrides in `arms.config.json`, inherited field-by-field from the global `panel` block when an arm doesn't set them. No arm registered in this document exercises the override today — every panel arm above still runs 5/6/2 — so this changes what the harness can express, not what any arm currently does. See the appendix for the mechanism and why `sharing` carries no global default._

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

> _Amended 2026-09-08 ([Appendix E](#appendix-e--amendments-dated-2026-09-08), item 6). A tenth arm is registered: **AS** — solo baseline, stance-neutral control. Arm A above is **unmodified**; it remains the registered baseline. AS exists because arm A is not neutral (§3.3/#128): its slot persona `solo` is not a `DEFAULT_PERSONAS` name, so ideate-core falls through to `DEFAULT_PERSONAS[0]` (PRAGMATIST, strategy `direct`). See the appendix for the full construction, including why the arm is deliberately named `solo_b` rather than something descriptive._

> _Amended 2026-09-08 ([Appendix F](#appendix-f--amendments-dated-2026-09-08), item 2). Eight Study 1 screening arms are registered for Stage 1a: `S1-C0`, `S1-N10`, `S1-N60`, `S1-ELOW`, `S1-EMAX`, `S1-SPRAG`, `S1-SCONTRA`, `S1-DIRECT`. Arms A–H, A′ and AS above are **unmodified**. See the appendix for the design, the centre point, and the held-constant factors._

> _Amended 2026-09-08 ([Appendix I](#appendix-i--amendments-dated-2026-09-08), item 1). Three Study 1 **Stage 1b** arms are registered: `S1B-SOLO60` (solo, N=60), `S1B-PANEL` (the first panel this study runs) and `S1B-APRIME` (its persona ablation), model held at `claude-sonnet-5` throughout. Arms A–H, A′, AS and the eight `S1-*` arms above are **unmodified**. Adding them moves `armsConfigHash` `ea1849cd1ac8` → `0c05795c6b00`, so every existing cell goes stale and `S1-N60`'s 24 cells are **not** reusable — which is why `S1B-SOLO60` re-collects that condition. See the appendix for the design and the hash cost._

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

> _Amended 2026-09-08 ([Appendix E](#appendix-e--amendments-dated-2026-09-08), items 4 and 5). The corpus is expanded again, **24 → 48 briefs, 12 per stratum**, corpus hash **`55e05c2811a7` → `bb26bebbf00f`**. The expansion is additive — the original 24 retain byte-identical content hashes and `preAmendmentCorpusHash` still reconstructs `55e05c2811a7` — and the product stratum gains an externally-published comparability anchor (`prod-07`, Meincke et al.'s "Base Prompt"). **Business remains the one stratum with no external anchor**, disclosed explicitly rather than left as a code comment. See the appendix for the anchor's citation, verification, and comparability caveats, none of which are as strong as issue #129 originally claimed._

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

> _Amended 2026-09-08 ([Appendix E](#appendix-e--amendments-dated-2026-09-08), items 1 and 3). `effort` is registered as a settable sampling lever, forwarded per slot alongside the `stance`/`strategy`/`personaDisabled` levers #128 already forwarded. Both request builders now emit it — Anthropic as a nested `output_config.effort`, OpenAI as top-level `reasoning_effort` — verified first-party, and the resolved per-cell setting enters `configHash`. The two providers' effort ladders are **not identical**; see the appendix for the asymmetry and the two-part registration (omitted universally across arms, first-class ordinal factor within one model)._

> _Amended 2026-09-08 ([Appendix F](#appendix-f--amendments-dated-2026-09-08), item 1). Appendix E item 1's third bullet — `strategy` "recorded, not rendered — yet" — is superseded: `strategy` is now a **rendered** prompt lever, with the CoT template registered verbatim. This changes the prompt actually submitted not only by the new Study 1 arms but by **arm A′** and by **every panel arm (B–H)** whose slots fall through to `DEFAULT_PERSONAS`. See the appendix for the template text and the hash consequence._
>
> _Amended 2026-09-08 ([Appendix F](#appendix-f--amendments-dated-2026-09-08), item 6). `max_tokens` becomes per-(model, effort), measured live 2026-09-08. The previous single per-model constant was under-sized for every effort-bearing call and for Sonnet's effort-free call too. See the appendix for the measurements and the resolution order for unmeasured pairs._

### 3.4 Replication and power

**Why replicate at all:** a single run per (arm × brief) measures one draw from a stochastic process. Sampling variance in LLM generation is large relative to the between-arm effects we care about; without replication we'd be ranking noise.

- **n = 4 independent runs per (arm × brief).** 9 arms × 12 briefs × 4 = **432 runs**.
- Runs differ only by run index (no seed control is possible — the APIs don't expose one; this is a limitation, not a choice).
- **Power:** run a **pilot** (§8, Phase 1) at 2 arms × 4 briefs × 4 reps to estimate the between-run variance component, then _recompute_ required n before committing to the full grid. Do not trust the n=4 figure until the pilot says so — it is a placeholder chosen for budget, not derived from a variance estimate we have.

> _Amended 2026-09-08 ([Appendix E](#appendix-e--amendments-dated-2026-09-08), item 7). The pilot's variance-component derivation and the resulting SE-vs-(briefs, replicates) table are registered, with **B = 48 briefs / R = 2 replicates as the current best estimate — explicitly provisional**, bound to Study 1's re-estimate of the dominant variance component. The n = 4 figure above is superseded by this table, not by a frozen final design. See the appendix for the derivation and why it must stay provisional._

> _Amended 2026-09-08 ([Appendix F](#appendix-f--amendments-dated-2026-09-08), item 2). Stage 1a is the run that re-estimates `σ²_ba`, the exact figure Appendix E item 7 above made B = 48 / R = 2 provisional on. See the appendix for the registered screening design that produces the re-estimate._
>
> _Amended 2026-09-08 ([Appendix G](#appendix-g--amendments-dated-2026-09-08), items 1–4). Stage 1a has run, and the re-estimate the amendment above promised is in: `σ²_ba` is **1.21**, not 77.85 — a factor of 64. **Appendix E item 7's B = 48 / R = 2 table is superseded**, re-derived on the same SE formula from the new components, and the recommended design becomes **B = 24 briefs / R = 2 replicates** — chosen on brief-coverage and estimability grounds, not on power, because power stopped being the binding constraint. The table is valid only for contrasts rarefied at a ~30-idea pool; a design targeting ~60 needs its own variance basis. See the appendix for the derivation, the two verification checks, and the scope bound._
>
> _Amended 2026-09-08 ([Appendix I](#appendix-i--amendments-dated-2026-09-08), item 3). The separate basis the scope bound above demands is registered, for Stage 1b's ~60-pool contrasts. **`σ²_e` = 4.7917 is MEASURED** at `S1-N60`; **`σ²_ba` = 2.3562 is TRANSPORTED** from the matched-N=30 fit by a ratio of 1.949 and is a registered **assumption**, because an interaction term at that pool size needs two or more arms there and Stage 1a ran exactly one. The registered design is **B = 24 / R = 2**, SE 0.629, **MDE 1.94** at Holm m = 2. The formula is unchanged. See the appendix for the ratio's justification, its 95% interval (0.595–6.387), the independent count-variance corroboration, and the sizing's sensitivity across that interval._

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

> _Amended 2026-09-01 ([Appendix C](#appendix-c--amendments-dated-2026-09-01), item 3). In any Arm-A contrast (§3.1): `distinct_k` and `poolFlexibility` (an identity pass-through of `distinct_k`) are rarefied (registered rule: Appendix C item 2); `poolFluency` and collapse rate are **excluded** from the contrast entirely and reported full-pool as descriptives — `poolFluency` is identical to pool size, so rarefying it is a constant with no test statistic, and a coherent rarefied collapse rate needs raw pre-dedup candidate data the harness does not yet retain; pool diversity and `distinct_k` per dollar are computed on the **full pool**. See the appendix for the per-metric rationale._

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

> _Amended 2026-09-01 ([Appendix C](#appendix-c--amendments-dated-2026-09-01), item 8). "Under almost any threshold" above is true but under-specified. The duplicate pool passes over the entire threshold domain, unconditionally. The random pool passes for roughly (0, 0.730) on the committed MiniLM fixture — ~1.5× the MiniLM-space threshold it was measured against (the registered same-space robustness factor); this does not convert into a ratio against the production Voyage-space threshold (0.2314), since cosine distances don't transfer across embedders (Appendix B item 8). Reported, not verified against a committed artifact in this repo. See the appendix item for the full numbers, including the one control that did not clear widely._

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

> _Amended 2026-09-08 ([Appendix I](#appendix-i--amendments-dated-2026-09-08), items 4 and 5). Stage 1b registers **its own two-contrast family** — `S1B-PANEL` − `S1B-SOLO60` and `S1B-PANEL` − `S1B-APRIME`, Holm at m = 2 — and **does not build the H1–H5 family above**, the same posture Appendix F item 7 took for Stage 1a. H1's question is Stage 1b's question, but H1's **contrast** is `mean(A′, B–H) − A` over eight model configurations, and substituting a differently-scoped quantity under a registered name is the hazard `#145` exists to refuse; H1's form would also average the ablation into the effect the run measures. H1 is recorded not estimable for this store, and `REGISTERED_H1_ARM_SETS` gains **no new key**. The appendix also registers, in advance, what a **null** licenses — the panel issues ten model calls to the solo arm's one, so bounding its advantage below ≈ 4% of a 49-idea pool is a decisive result on §4.1's per-dollar metric, not a failed one._

### 6.2 Model

Runs are **nested** (runs within brief within arm) and briefs are crossed with arms. A t-test on arm means ignores that structure and inflates false positives.

```
distinct_k ~ arm + (1 | brief) + (1 | brief:arm)
```

Mixed-effects (random intercept for brief; random arm-slope-by-brief to allow arm effects to vary by task type). Cost analyses use the same form with `log(cost)` as an offset. Judge-score models add `judge_provider` and `judge_provider × generator_provider` to estimate H5's bias term.

- **Effect sizes with 95% CIs are the headline**, not p-values. "Arm E yields 3.1 more distinct ideas (95% CI 1.8–4.4)" is decision-relevant; "p < 0.05" is not.
- **Multiplicity:** 5 registered hypotheses + pairwise arm contrasts → **Holm–Bonferroni** on the registered set; Benjamini–Hochberg on exploratory contrasts, reported separately and **labeled exploratory**.
- **Pre-registered stopping rule:** the full grid runs to completion. No peeking-and-stopping.

> _Amended 2026-09-08 ([Appendix F](#appendix-f--amendments-dated-2026-09-08), item 7). Study 1, Stage 1a runs **no hypothesis tests** and does not enter the Holm family: it is a screening run reporting effect sizes with confidence intervals. **H1–H5 above are untouched** — every unreachable contrast against a solo-only design is recorded as explicitly not estimable, never substituted. See the appendix for what Stage 1a does and does not license._

### 6.3 What we will NOT do

- Not report a single "best model" — the output is a **cost/diversity Pareto frontier**; the right pick depends on budget
- Not collapse novelty and feasibility into one score
- Not drop failed runs silently — parse failures and refusals are _findings_ (§4.3), reported per arm
- Not re-run an arm that "looks wrong" without registering the re-run

---

## 7. Cost accounting — conforms to the cron-fleet / CFO contract

The harness emits a ledger row per run matching **cwc#1639 / cron-fleet#35 / #75** requirements (read at `code-workspace-config` cwc#1639 and `cron-fleet/lib/cron-health/fleet-cost.mjs`):

1. **Price at READ TIME from `model` + token counts + billing regime.** The ledger stores the _fact_ (tokens × model × timestamp), never a derived dollar figure as authoritative — the exact defect cron-fleet#75 exists to fix.
2. **Row carries** `model`, `input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`, `billing_mode`, `pricing_regime`, timestamp. **No `cost_usd` column.**
3. **`billing_mode: "api"`** for this study (real metered spend). A subscription-mode row would carry `notional_usd`, never `cost_usd` — and the report must name the regime for any dollar figure it shows.
3a. **`pricing_regime: "batch"|"single"`** (added issue #119) is a SECOND, independent fact recorded on the row — which read-time rate (batch API vs. realtime) this call's tokens must price at. It is orthogonal to `billing_mode` (see #2: `billing_mode` is "api"/"subscription"; batch-vs-single is a lever WITHIN "api" spend) and, like every other field in this ledger, it is still a FACT about the call, never a derived dollar figure — `lib/price.mjs` still applies it at read time. A row written before this field existed omits it and is priced under a named, recorded fallback (`lib/price.mjs`'s `LEGACY_PRICING_REGIME_FALLBACK`), never a silent guess.
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

> _Amended 2026-09-08 ([Appendix H](#appendix-h--amendments-dated-2026-09-08), items 1-2). **The Claude Sonnet 5 row above is superseded: the rate is $2.00 / $10.00 per MTok, flat, with no introductory regime.** The `3.00 (2.00 intro → 2026-08-31)` reading came from a cached second-hand table; the announced 2026-09-01 increase was cancelled and $2/$10 has been the price throughout. Verified first-party 2026-09-08 against `platform.claude.com/docs/en/about-claude/pricing`, which also confirms Opus 5, Haiku 4.5 and (for the judge roster) Sonnet 4.6 as written. Every dollar figure this study has reported for a Sonnet-containing arm was **50% overstated**; Stage 1a's ledger reprices from $19.6927 to **$15.7902**._

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

- A `--max-spend` pre-flight that prices the _planned_ grid from the pinned rate table and admission-controls cells once the running total would cross the ceiling (§12's own description is authoritative on the precise semantics -- it does not refuse to start the process outright)
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
| A partially-failed round yields an undersized pool      | A cell whose pool was built from fewer agents than its arm specifies **fails**; it is never stored `completed` (issue #102) | Real, and arm-correlated in the opposite direction: a panel arm has ~5× the exposure to "at least one agent dropped out", so panel arms lose (or permanently fail) more cells than Arm A. See the registered note below |

> **_Registered 2026-09-02 (issue #102) — what a `completed` cell means._** A panel arm issues one request per agent per round. If some of those agents drop out — a 429 on three of five, a refusal, a reply that comes back unparseable — while the rest return, `ideate-core` still resolves cleanly with whatever arrived: it tolerates per-agent failure **by design** (`onAgentError` resolves to `null` rather than throwing). Before this amendment the harness stored that as a `completed` cell carrying a real but **undersized** pool.
>
> **The registered rule: a cell whose pool was assembled from fewer agents than its arm specifies does not complete.** There is no completeness threshold and no "complete but flagged" middle ground.
>
> - **Why not a threshold.** Any cut-off is a tunable that would itself have to be justified and registered, and every value for it still admits a biased pool — it only changes the size of the bias. `distinct_k` scales with pool size, so the residual stays arm-correlated.
> - **Why not "complete, and record the realized count".** Nothing in `evals/analysis/` conditions on such a field, and an unread field is the same as no field: the cell is still counted as data. The realized counts **are** retained on the record (below), but as a diagnostic on a cell whose state already tells the truth — never as the mechanism that makes an undersized pool safe.
> - **Why this and not something narrower.** §10's own precedent: a pool missing a whole ROUND (round 1 returned, round 2 blew the batch poll ceiling) already fails `timeout` rather than storing short (issue #92). A pool missing three of five AGENTS is the same defect through a different trigger. Completing one while failing the other would be an inconsistency in what `completed` means, not a policy.
> - **Why H1 specifically.** A panel arm makes ~5× the generation calls per cell that Arm A does, so it has ~5× the exposure to a partial failure, and the resulting `distinct_k` under-count is therefore concentrated on exactly the panel arms H1 compares against solo.
>
> **What is retained.** Every stored cell — completed, or failed for a cell-intrinsic reason — carries `agentsAttempted` / `agentsFailed` / `agentsRealized` when the provider reports them. Their **absence** means "not reported", never "nothing failed".
>
> **The residual, stated plainly.** This rule converts a silent bias into visible cell loss, and cell loss is not free:
>
> 1. For an **environmental** cause (rate limit, 5xx, timeout, batch abandonment) the failure is classified transient, so per issue #90 nothing is written under the cell key, the cell is re-planned on the next invocation, and its spend is preserved. The cost is a **delay**, not a hole — this is the property the whole rule rests on.
> 2. For an **intrinsic** cause (a partial refusal, a partial parse failure) the cell is stored `failed` and is **not** re-attempted, because re-attempting it would be resampling until the arm looks better than it is. This means **one refusing agent out of five now makes the whole cell a failed cell**, where before it completed with a four-agent pool. That **inflates the measured per-arm failure rate (§4.3), and does so arm-correlated** — a panel arm has ~5× the exposure to "at least one agent refused" that Arm A has. §4.3's failure-rate comparisons across arms must be read with this in mind: post-#102, a panel arm's failure rate counts partial refusals that Arm A structurally cannot have.
> 3. What is **not** in scope: an agent that contributed *fewer ideas* than requested (a truncation from which issue #93's salvage recovered most of the reply). That is an idea-count axis; #93 registered that trade deliberately and this rule does not re-open it.
> 4. **This rule is not retroactive, and cannot be made so.** A `completed` cell stored *before* this amendment carries no agent counts — retaining them is part of this same change — so an undersized cell already in a store is not identifiable after the fact. Any pre-#102 completed cell must therefore be treated as possibly undersized. Cells collected from this point forward are not.
>
> Implemented in `evals/harness/provider.mjs` (`classifyUndersizedPool`, both provider adapters) with a provider-agnostic backstop in `evals/harness/runner.mjs`; tested in `evals/harness/undersized-pool.test.mjs` and `evals/harness/integration.test.mjs`.

> _Amended 2026-09-01 ([Appendix C](#appendix-c--amendments-dated-2026-09-01), item 7). "DAT replication as validity check" (row: "Embedding model shapes diversity metric") is real but weaker than the phrasing implies — reported, not verified against a committed artifact in this repo: the DAT ordering is a three-point check that holds one time in six under a null; over 3,000 seeds, a semantics-free SHA-512-of-text embedder cleared it 16.4% of the time (null 16.7%) and cleared all three negative controls together 1.9% of the time (reproducible witness: seed 97) — i.e. Phase 0 rejects a semantics-free embedder roughly five times in six on the ordering alone. See the appendix item for the full construction._

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

### How the pilot's non-reuse is enforced: store separation

The "not reused" condition in the variance-estimation row above is enforced **structurally, by running the pilot into its own results store** — `node evals/run.mjs --results-dir results-pilot ...` — while the confirmatory grid runs into the default `results/`. `evals/analysis/analysis.mjs --results-dir` reads whichever of the two is named.

> _Amended 2026-09-08 ([Appendix F](#appendix-f--amendments-dated-2026-09-08), item 8). Study 1, Stage 1a uses this same mechanism: it collects into its own store, `--results-dir results-study1`, kept out of `results/` so Study 1's independently-moving configuration never stales Studies 2–4's cells or vice versa. The additive-accumulation and non-reuse rules above apply within the Stage 1a store exactly as they do within `results/`. See the appendix for the full record._

This is the only mechanism that works, and the reason is worth stating because the alternatives all look plausible:

- **Not a different `configHash`.** A variance estimate transfers to the grid only if the pilot ran at the grid's configuration, so identical configuration is a _requirement_ of the pilot, not an oversight. `planRun` therefore classifies every pilot cell as `reuse` for the grid, and correctly: the never-silently-pool guarantee fires on config _change_, and here there is no change to detect.
- **Not pruning the pilot's cells before the grid.** That is enforcement by intention — one forgotten command away from a contaminated confirmatory fit, and the contamination is invisible afterwards, because pooled cells look like ordinary cells.
- **Not a `phase` label on the cell.** That puts the guarantee inside the analysis path, where every future reader of the frame has to remember to honour it.

Two stores cannot pool at any `configHash`, under any analysis path, whether or not anyone remembers the rule. That is what "structural" means here, and it is the mechanism §8.3 Phase 2a's "explicitly excluded if not" now names.

One consequence follows for §7/§8 accounting and is registered with it: `spendToDate()` is cumulative **over the store in use**, so a pilot invocation and a confirmatory invocation report separate study-to-date totals, and `--max-spend` gates each against its own. `evals/run.mjs` therefore names the store it opened in its own report. The study's total spend is the **sum across the stores**, never either figure alone.

---

## 12. Configurability

Every knob the study varies is config, not code:

| Knob                       | Flag                                                      | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| -------------------------- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Spend ceiling              | `--max-spend <usd>`                                       | Pre-flight prices the planned grid from the pinned rate table. This does **not** refuse to start the process outright -- it admission-controls cells: the planned grid is walked in order and a cell is skipped, recorded as `skipped: budget_exceeded`, the moment admitting it would cross the ceiling, so every planned cell still reaches a terminal, reconciled state and none is silently dropped. **Cumulative across invocations (issue #64):** before any admission decision, spend-to-date is reconstructed at READ TIME from the store's own cost rows (`evals/harness/runner.mjs`'s `spendToDate`, backed by `lib/price.mjs`'s `priceRows`/`priceRowsByProvider`) -- summed across **every** configHash the store holds, not just the one this invocation is running under, because a harness/prompt bump does not refund money already spent. A resumed run's ceiling therefore gates the STUDY's total spend, not just one invocation's. **Basis (PR #72 review): `--max-spend` gates on ALL priced spend, embedder included** -- it is a total-dollars backstop, not scoped to any provider, so `priorSpend.totalUsd` (which `priceRows()` computes over every stored row regardless of provider) is exactly the figure it compares against. `summary.cumulativeSpendUsd` reports that SAME total (provider spend plus non-provider/embedder spend) for the same reason -- so the number that stopped a run and the number reported afterward never disagree. Compare this to the per-provider row below, whose basis is deliberately narrower. Only computed (and the store's history only read) when a ceiling is actually requested this invocation -- `summary.cumulativeSpendByProvider`/`cumulativeSpendUsd`/`cumulativeNonProviderSpendUsd`/`cumulativeNonProviderModels` are `null` (never a fabricated `0`) on a run with no `--max-spend`/`--max-spend-<provider>` at all. **Printed at the CLI, not just returned from the API:** `evals/run.mjs`'s `main()` prints this-invocation and cumulative spend (by provider, the excluded non-provider line by name, and the grand total) after every non-dry-run invocation via `formatSpendSummary()` -- previously `summary` was computed and discarded, so under the study's REGISTERED configuration (`--max-spend-anthropic 300 --max-spend-openai 150`, no global ceiling) an operator saw no spend figure at all. **What "spend-to-date" does and does not include, given issue #68:** this sums whatever cost rows the store actually holds; `runJudgeMatrix`/`runJudgeValidation` have no caller on the `runSpec()` path yet (issue #68), so no judge cost row is ever written here, and none is fabricated as if it were measured -- once #68 wires judging in, its rows are picked up automatically. **A separate, still-open blind spot:** the pre-flight judging _projection_ below only estimates `plan.todo` cells; a cell reused this session (already generated in an earlier session, not yet judged) contributes no judging estimate to the ceiling either, actual or projected -- a resumed run can still under-project real exposure for exactly that reason, and this control does not compensate for it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Per-provider spend ceiling | `--max-spend-anthropic <usd>`, `--max-spend-openai <usd>` | Same admission-control semantics as `--max-spend` above, evaluated independently per provider (issue #51 -- a single global ceiling cannot express an asymmetric budget), and **cumulative across invocations exactly the same way (issue #64)** -- `spendToDate`'s per-provider totals, summed across every configHash, are added to each provider's running total before any cell is admitted. A tripped ceiling names its provider: `skipped: budget_exceeded:<provider>`. **Embedder spend (Phase 0/#69) is tracked but excluded from both provider buckets:** Phase 0 writes real `voyage-4-lite` cost rows into the SAME store these ceilings read from; `lib/price.mjs`'s `isNonProviderModel()` recognizes it as a KNOWN non-provider model and routes it around `providerOf()` before that function's throw is ever reached, so a correctly-written embedder row never hard-fails a resumed study on the very path meant to stop an unbounded bill. Embedder spend is still real money (Voyage is free-tier only as of this table's rate date) and is still summed into the study's grand total and surfaced explicitly (`spendToDate`'s/`priceRowsByProvider`'s `excludedNonProviderUsd`/`excludedNonProviderModels`, `summary.cumulativeNonProviderSpendUsd`/`cumulativeNonProviderModels`, and named on its own CLI line by `evals/run.mjs`'s `formatSpendSummary()`) -- it is simply not gated by `--max-spend-anthropic`/`--max-spend-openai`, which are provider-attributable-spend ceilings by definition (contrast the GLOBAL `--max-spend` row above, whose basis deliberately DOES include it). An UNRECOGNIZED model id (neither a known provider prefix nor `voyage-*`) still throws through `providerOf()` exactly as before -- this exclusion narrows what throws, it does not weaken the guard that catches a typo'd or unregistered model id. Attribution differs by path: the **pre-flight projection** (before a cell has run) splits a coarse token estimate evenly per model slot (`lib/price.mjs`'s `runnerPriceGrid`); the **actual running total**, tracked as cells complete (this invocation) and reconstructed from the store (prior invocations), is derived from each cell's real `tokens_by_model`, never a flat per-cell assignment -- so a cross-provider cell (arm G) is estimated evenly pre-flight but attributed by real usage once it has actually run. **Judge spend, partially fixed by issue #63:** the **pre-flight projection** now prices planned judging too -- `lib/price.mjs`'s `runnerPriceGrid`, when passed a `judgeLegsFor(cell, arm)` callback (`evals/run.mjs` wires `evals/judge/matrix.mjs`'s `judgeLegsFor` factory, which reuses the real cross-judge matrix's own `pickDistinctJudge` selection), adds each resolved judge leg's estimated cost to every planned **todo cell** -- priced per-model through the same rate table, with the same batch discount, and the same fail-loud-on-a-missing-rate guarantee a generation slot gets (never a flat per-leg guess, and never a silent $0 for a rate-less judge model) -- so `--max-spend`/`--max-spend-openai` see the study's planned judging before any cell runs. The per-leg token count (in/out per candidate x an estimated candidate count) is itself a documented, UNVALIDATED estimate (`lib/price.mjs`'s `JUDGE_TOKEN_ESTIMATE_PER_CANDIDATE`/`JUDGE_POOL_SIZE_FALLBACK`) -- the same caveat the generation projection's own `PLAN_TOKEN_ESTIMATE` (§8.2) carries, and the gap issue #49 exists to close with corpus-derived figures; it errs toward over-projection, the safe pre-flight direction. **Still open:** the cross-judge matrix (`evals/judge/matrix.mjs`/`evals/judge/score.mjs`'s `runJudgeMatrix`) is not itself invoked from `evals/run.mjs`'s `runSpec()` path (issue #68), so neither the actual running total NOR the cumulative spend-to-date this invocation is gated against includes real judge spend -- only the pre-flight estimate for `plan.todo` cells does, and that estimate is silent for any reused cell. Judge spend is roughly half the OpenAI-provider total and the dominant OpenAI cost driver, so this gap remains consequential until #68 lands. |
| Which arms                 | `--arms A,B,E`                                            | Subset the grid                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Which models               | `arms.config.json`                                        | Model IDs per persona slot, per arm                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Replicates                 | `--replicates <n>`                                        | Additive — raising it queues only new cells                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Briefs                     | `--briefs <ids>`                                          | Subset the corpus                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Phase                      | `--phase <0-4>`                                           | Gated; see §8.3                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Dry run                    | `--dry-run`                                               | Prints the plan, the reuse/todo/stale split, and the cost projection. Calls nothing.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

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

| Metric                                         | Treatment                                                | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------------------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `distinct_k`                                   | **Rarefied**                                             | Monotone non-decreasing in pool size (§0 of issue #70)                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `poolFluency`                                  | **Excluded** from Arm-A contrasts; full-pool descriptive | `poolFluency(pool) === pool.length` (`operational.mjs:172`) — rarefying it is identical to reporting `rarefiedN`, a constant with zero variance and no test statistic. Being pool size is why it CANNOT be rarefied into a comparable quantity, not a reason to rarefy it — the earlier reasoning ("rarefied — it IS the pool size") was backwards.                                                                                                                                                 |
| `poolFlexibility`                              | Follows `distinct_k`'s treatment exactly (rarefied)      | `poolFlexibility(k) === k` identically (`operational.mjs:204`) — an identity pass-through of `distinct_k`, not a separate quantity. Perfect collinearity with `distinct_k` (already recorded elsewhere in this document); never usable as its own dependent variable.                                                                                                                                                                                                                               |
| Collapse rate                                  | **Excluded** from Arm-A contrasts; full-pool descriptive | A coherent rarefied collapse rate needs the PRE-DEDUP raw candidate list (stage 1), which the shipped harness does not retain — `collapseRate()` (`diversity.mjs:61`) spans stage-3 clusters over stage-1 raw candidates, but `rarefyPools` only ever has stage-2 (post-dedup) pools to subsample. Rarefying the numerator against the arm's full raw-candidate denominator would spuriously inflate the panel arm's collapse rate. See Item 6 for what #8 must capture to make this implementable. |
| Pool diversity (mean pairwise cosine distance) | Full-pool                                                | The point estimate is a mean, roughly n-robust (unbiased for `E[d(X,Y)]`, independent of n) — but its VARIANCE still scales ~1/n, so Arm A's diversity estimate is noisier than a panel arm's even though neither is biased. See Item 6.                                                                                                                                                                                                                                                            |
| `distinct_k` per dollar                        | Full-pool, self-correcting                               | The extra generation the panel arms run is paid for on the cost side already                                                                                                                                                                                                                                                                                                                                                                                                                        |

### Item 4 — scope: every arm-A contrast, A′ included; H2/H3/H4 unaffected

**What's registered.** The rarefaction rule (Item 2) applies to **every contrast that includes Arm A**, not only H1:

- **H1** (mean(panel arms) − A, §6.1/Appendix B item 5) — the confound this appendix exists to fix.
- **Per-arm exploratory breakdowns** (armX − A for one arm at a time, §6.3/Appendix B item 5) — same confound, same fix.
- **A′ (the persona-ablation arm, §3.1)** — A′ is a **panel** (identical models, disabled persona lever), so it resolves to `maxRounds: 2` and an ≈60 pool exactly like every other panel arm. The A-vs-A′ comparison — "the question a skeptical reviewer asks first" per §3.1 — is unmatched in exactly the same way H1 is, and is rarefied by the same rule.

**H2 (E vs D), H3 (G vs D/H) and H4 (B vs D) are unaffected.** No **structural** pool-size asymmetry exists between panel arms — every arm on both sides of these contrasts shares the same registered panel shape (`panel: {size: 5, ideasPerAgent: 6, maxRounds: 2}` for all of B/D/E/G/H), unlike Arm A's `maxRounds: 1`. This is a claim about the registered shape, not about observed post-dedup pool size: `ideate-core.mjs:354` dedupes by normalized text, and different panel arms could plausibly dedupe by different amounts (a Haiku panel producing more near-duplicates than an Opus panel, say) — exactly the round-1-requests-vs-pool-level distinction Item 1 corrects for Arm A. #8 (Phase 2a) will measure observed pool size per arm; if panel-vs-panel pool sizes turn out to differ materially, extending this rule to panel-vs-panel contrasts is a separate, dated amendment, not something this item pre-empts.

**This gap is already covered by how the rule is written, not left open.** `minPoolSize` (Item 2) is defined on the **observed** pool sizes actually present in a contrast, never on arm identity or registered shape — so if #8 finds that H2/H3/H4's panel arms do end up with materially different post-dedup pool sizes, `rarefyPools()` rarefies them exactly as it already does for any arm-A contrast, with no code change and no further amendment required. The rule as registered therefore already accounts for a risk this item cannot yet rule out.

### Item 5 — both values are reported

**What's registered.** For every rarefied contrast (Item 4), `REPORT.md` reports **both**:

- **Rarefied `distinct_k`** — H1's (and A′'s, and the per-arm breakdowns') registered estimand.
- **Full-pool `distinct_k`** — a secondary descriptive, never substituted for the registered estimand, reported so a reader can see what the unmatched comparison would have shown.

**What's implemented today, and what is not.** `rarefyPools()`'s return shape (`{poolSize, rarefiedN, distinctKFullPool, distinctKRarefied}` per pool) is built so that a caller cannot produce one number without the other — but `evals/analysis/rarefaction.mjs` has **no importer yet**. `frame.mjs`, `contrasts.mjs`, and `report.mjs` do not call it, and `frame.mjs`'s own header comment already scopes "populating the per-cell response" as out of scope pending #49/#50 — this study has no real pools to rarefy until #8 (Phase 2a) runs. Wiring `rarefyPools()` into the actual `distinct_k` frame/fit/contrast pipeline, so rarefied `distinct_k` genuinely becomes the quantity §6.2's Holm-corrected family is tested on, is tracked separately at **#73**.

### Item 6 — §3.4/§8.3: consequences for the pilot (#49)

**What's registered.** Variance of a count scales with the count, so a between-run variance estimate collected from a 30-pool arm (Arm A) does not transfer to a 60-pool arm (every panel arm) — the two arms' `distinct_k` have structurally different sampling variance even before any model effect. §3.4/§8.3's pilot (Phase 2, "estimate variance → recompute n") is registered to derive H1's required `n` from the **rarefied** `distinct_k` variance, computed at the contrast's rarefaction target, never from the raw full-pool variance of either side.

**This makes H1 noisier than the full-pool comparison, by construction, and that is registered in advance.** Rarefaction discards information (Item 2); averaging over `R = 1000` draws only **partly** recovers what a single full-pool measurement at the true (larger) pool size would have given. A pilot-derived `n` for H1 must therefore be derived from data that has itself already been rarefied — deriving it from full-pool variance and applying that `n` to a rarefied confirmatory test would understate H1's true required sample size.

**#8 (Phase 2a) must record observed post-dedup pool size per arm, not only for Arm A.** This is now the measurement that determines whether H2/H3/H4's panel-vs-panel contrasts need rarefaction at all (Item 4's covered-but-unmeasured gap) — Arm A's pool size alone was never sufficient to answer that question, and every arm's observed size is required input to `minPoolSize` (Item 2) regardless of which contrast it feeds.

**#8 must also capture the raw, PRE-dedup candidate count per pool, alongside the post-dedup pool size above.** Item 3 registers collapse rate as excluded from Arm-A contrasts because a coherent rarefied collapse rate needs to subsample the raw candidate list (stage 1, before `ideate-core.mjs:354`'s text dedup), and the shipped harness does not currently retain it — only the post-dedup pool (stage 2) is available to `rarefyPools`. Without this measurement, rarefied collapse rate stays unimplementable regardless of any change to `evals/analysis/`; #8 is the first point in the pipeline where retaining it is possible.

### Item 7 — §10: Phase 0's power against a semantics-free embedder, and the DAT mitigation's strength

**What's registered.** §10's threat table lists "DAT replication as validity check" as the mitigation for "Embedding model shapes diversity metric." This entry quantifies how strong that mitigation actually is.

**Reported, not verified against a committed artifact in this repo** — measured during the QA review of PR #69, reproducible from the construction described, not independently re-run in this session:

- The DAT replication control (§4.4) is a 3-point ordering (`low < avg < high`), which holds **1-in-6 (16.7%) under a null** with no semantic signal at all.
- Measured over **3,000 seeds** with a pure SHA-512-of-text embedder (deterministic, text-dependent, carrying **zero semantics**): the DAT ordering held **16.4%** of the time (null expectation 16.7% — consistent with the embedder carrying no real signal, as constructed).
- **All three negative controls (duplicate pool, random pool, DAT ordering) passed together 1.9% of the time** over the same 3,000 seeds. A reproducible witness: **seed 97** — `low 0.9481 < avg 0.9594 < high 0.9738`, `distinct_k` 1 (duplicate pool) and 30 (random pool) — a fully semantics-free embedder that nonetheless clears every registered control simultaneously, at that seed.
- Only the DAT control has power against this failure mode: a text-hash embedder passes the duplicate-pool control **exactly** (identical text → identical vector → all pairwise distances exactly 0) and the random-text control **trivially** (unrelated sentences hash to unrelated, well-separated vectors) by construction, regardless of whether the embedder carries any semantics.

**§10's "DAT replication as validity check" mitigation is real, but far weaker than the phrasing implies.** The DAT replication control is a three-point ordering, so under a null it holds one time in six. Measured over 3,000 seeds with a pure SHA-512-of-text embedder (deterministic, text-dependent, semantically empty): the ordering held 16.4% of the time against a null expectation of 16.7%, and all three controls passed together 1.9% of the time (witness: seed 97). Phase 0 therefore rejects a semantics-free embedder roughly **five times in six**, on the strength of the ordering alone — real power, not zero, but not the kind of margin "validity check" suggests either. §10's table is corrected (see the §10 marker) to say so rather than presenting DAT replication as closing the threat.

### Item 8 — §4.4: the two degenerate negative controls are nearly threshold-free

**What's registered.** §4.4's qualitative note that the duplicate-pool and random-pool controls pass "under almost any threshold" is true but under-specified. This entry registers the numbers.

**Reported, not verified against a committed artifact in this repo** — measured during the QA review of PR #69, reproducible from the construction described, not independently re-run in this session:

- **Duplicate pool.** Passes (`distinct_k = 1`, `diversity < 0.05`) over the **entire** threshold domain, unconditionally: identical text embeds to an identical vector, so every pairwise distance is exactly 0 regardless of where the threshold is set.
- **Random pool.** Passes for every threshold in roughly **(0, 0.730)**, measured on the committed MiniLM fixture — retained as reported because it is the measurement actually executed. The registered robustness factor is the **same-space** ratio: **~1.5×** the MiniLM-space threshold the 0.730 figure was itself measured against (0.730 / 0.4923). The production Voyage-space `clusterDistanceThreshold` (0.2314) is a **different embedding space** and this measurement does **not** convert into a Voyage-space robustness factor — Appendix B item 8 registers that cosine-distance distributions do not transfer across embedders, so a ratio of a MiniLM-measured band to a Voyage-space threshold would compare incommensurable quantities. No such ratio is registered here. Corrupting the registered threshold constant to anything in **[1e-9, 0.9]** leaves the whole negative-control suite green.
- **The one control that did NOT clear widely: the random-pool diversity margin.** `0.7525 / 0.6970 = 1.080` — an **8%** margin against a floor self-calibrated from `dat.high` in the same run. Named here because it is the one number in this item that is close to failing, not comfortably far from it like the other two.

See the §4.4 marker for the registered summary of this item.

---

## Appendix D — Amendments (dated 2026-09-02)

Per the amendment rule at the top of this document. This appendix registers a
**change to `configHash`'s field set** (§11) and the invalidation it causes,
in advance of the run that will carry it (item 1), a **narrowing of one of
§1's named residual threats** (item 2), and the **mechanism by which §11's
pilot/confirmatory non-reuse condition is enforced** (item 3). Nothing in §6
is changed.

### Item 1 — §3.1/§11: `arms.config.json` now participates in `configHash` as `armsConfigHash`; `ideasPerAgent`/`maxRounds` are retired (issue #101)

**The defect.** §11 registers `configHash` as covering "everything that could
change the measurement (engine SHA, prompt hash, judge hash, embedder, panel
shape)". **Panel shape and model assignment were not in fact covered** —
`arms.config.json` was hashed nowhere at all. §3.1's design intent is that
_the only thing varying between arms is model assignment_, so the single
variable this study manipulates was invisible to the mechanism that decides
which cells are comparable. Editing arm C from `claude-sonnet-5` to
`claude-opus-5` produced cells with an identical `configHash`; `planRun`
classified them `reuse` and the frame pooled two different experiments with no
`stale` warning — the exact outcome §11's never-silently-pool guarantee exists
to prevent. This item makes §11's existing words true rather than changing
what they claim.

**What changed.** `lib/manifest.mjs` gains `armsConfigHash()`, a sha256-12 over
the parsed `arms.config.json`, declared in `CONFIG_FIELDS` and stamped by
`evals/run.mjs`. It covers every arm's model assignment and slot ORDER, each
arm's `mode`/`personaDisabled`/`totalIdeasRequested`, and the `panel` block's
`size`/`ideasPerAgent`/`maxRounds`.

**What it excludes, and why.** Documentation-only keys — any `_`-prefixed key
(`_comment`, `_modelIdSource`) plus `label` and `purpose` — are not hashed.
Editing them changes what a reader is _told_ about an arm, never what was
_measured_ of it, and hashing them would falsely mark every stored cell
`stale` on a typo fix. This is the same measured-vs-described distinction
Appendix B item 15 draws when it keeps `analysisHash` out of `configHash`.
The exclusion is a **denylist of named prose fields, not an allowlist of
measurement fields**: a field added to `arms.config.json` later is hashed by
default, so the failure mode is a conservative over-invalidation rather than
silent under-coverage.

**Two `CONFIG_FIELDS` entries retired.** `ideasPerAgent` and `maxRounds` are
removed. Neither had ever been set by any caller, and neither could honestly
be: `spec.config` is per-spec while both values are **per-arm** (the panel
block registers `ideasPerAgent: 6` / `maxRounds: 2`, but arm A is a single
solo call with `maxRounds: 1`, §3.1). Stamping the panel constant into a
per-spec slot would have made `configHash` claim coverage of a value it did
not pin. `armsConfigHash` covers both, per-arm, as written. A
declared-but-never-set field is worse than an absent one, because it reads as
covered.

**Two further absent fields, now populated.** `judgeHash` is set from
`evals/judge/score.mjs`'s `computeJudgeHash()` over the registered judge
roster — the mechanism has existed since issue #21 and simply had no caller on
the run path. It is populated rather than removed because **Appendix B item 3
already registers, in advance, that `judgeHash` is a `CONFIG_FIELDS` entry and
that `judgeHash` → `configHash` → `cellKey` is "correct and intended"**;
removing it would be a deviation from that registration, not a code cleanup.
The registered cost is accepted explicitly: **swapping a judge model now
invalidates GENERATION cells, which must be re-generated rather than merely
re-scored.** That is the conservative direction, and it is what §5.3/§11
already register — a cell's result is comparable to another's only if the
judge that could score it is identical too.

`clusterDistanceThreshold` (Appendix B item 8) is likewise now stamped into
`spec.config` by `evals/run.mjs`, settling the ownership question on the
**generation** side: since issue #85 wired pool metrics into `runSpec`,
`distinct_k` is a stored generation artifact and a direct function of the
threshold. It is set **unconditionally**, never gated on whether a live
embedder was wired, so `--dry-run` projects the same `configHash` the real run
stamps. `evals/analysis/` is deliberately unchanged: per issue #91 it computes
no hash at all, reading the store's own `cfg` instead, and its
`--cluster-distance-threshold` flag survives as a _recomputation_ parameter
for the rarefied lane, where a value disagreeing with what generation used
already fails loudly (`buildRarefiedFrame` recomputes full-pool `distinct_k`
and throws on a mismatch with the stored scalar).

**Second consequence, registered in advance: adding or removing an arm
invalidates EVERY arm's cells.** The hash is over the whole file, so editing
`arms.config.json` to introduce an arm `I` moves `armsConfigHash` and marks
every stored cell for arms A–H `stale` — including cells for arms whose own
definition did not change. This is **accepted rather than fixed**. `spec.config`
is per-spec, so a per-arm hash cannot live in it (the same constraint that
retired `ideasPerAgent`/`maxRounds` above), and the only finer-grained
alternative — hashing just the arms a given spec runs — is strictly worse: it
would make arm A's cells from `--arms A,B` incomparable to arm A's cells from
`--arms A,C`, which breaks §11's additive design far more severely than
over-invalidation does. Operators should therefore **introduce arms before a
phase begins, not during one**, and should expect a full re-collection if they
do not. This matters because §8.3 defines phases 1–4 as a human-gated sequence
and nothing in the repo codifies which arms belong to which phase, so
introducing an arm between phases is the expected shape of the work.

The reassuring counterpart, also registered: **`--arms` SCOPING does not move
the hash.** Running a subset of arms is not a config change, so a scoped run's
cells stay comparable to an unscoped run's. Both properties are pinned by test
(`lib/manifest.test.mjs`, `evals/run.test.mjs`).

**Consequence, registered in advance.** `configHash` moves to
**`0000daa58e5a`**, from `5ce5478956e5` (the value the #8 smoke store carries)
via `ed73fc14eb48` (issue #99's prompt-hash fix). The full hashed input:

```
harnessVersion            0.0.1
engineSha                 ideate-core@0.4.0
promptHash                4a3460df3dc6
judgeHash                 ee4836950521
embedderId                voyage-4-lite
corpusHash                55e05c2811a7
armsConfigHash            61ed0026c2a0
clusterDistanceThreshold  0.23141118234233987
```

Every pre-existing stored cell becomes `stale` rather than being reused, per
`planRun`. **This is correct and intended**, and the timing is the argument:
the only data in any store is the #8 smoke study, whose results are discarded
from confirmatory analysis by construction (§8.3). Absorbing the invalidation
now costs one smoke run; after Phase 2's grid exists it would cost the grid.

### Item 2 — §1/Appendix B item 4: the batch-poll-timeout exception is NARROWED, not closed (issue #103)

**What this item does.** Appendix B item 4 closed blocker **B3** ("no token
accounting in ideate-core") with two named exceptions carried forward as
residual threats. Exception 1 read:

> **Batch-poll timeout.** A client-side batch-poll timeout can return control
> to the caller while a submitted batch is still billing server-side. That
> spend is real and eventually appears at the provider, but the harness's own
> ledger has no row for it **until (if ever) it polls again**.

Issue #103 builds the "polls again". This item registers what that changes
about the exception and, equally, what it does not.

**What changed in the code.** `evals/harness/provider.mjs` persists the durable
batch handle of every batch surrendered at the poll ceiling, together with a
map from each submitted `custom_id` back to a **content-derived** id and the
model it was billed against. A later invocation re-polls that handle before
re-entering the engine, downloads whatever the provider still holds, and
**meters every recovered `succeeded` reply into `tokens_by_model` at the moment
of recovery** — not at the moment the reply is later replayed into a prompt.
The distinction is deliberate and is the part that matters for accounting: a
reply the harness pulled down but the engine never asked for is still money the
provider charged, and metering on replay would silently drop it. The recovered
tokens then flow through the same `costRowsFor` → `store.put` path as any other
spend, so `spendToDate()` sees them.

**The exception is narrowed to a strictly smaller set.** Before #103, an
abandoned batch's spend was *unconditionally* absent from the ledger, because
nothing ever re-polled. After #103 it is absent only while it has not yet been
re-polled — and a re-poll happens automatically on the next invocation that
plans the cell. What remains outside the ledger is therefore:

1. **The window between abandonment and the next invocation.** Real, and
   unchanged in kind: client-side polling cannot observe server-side billing it
   is not watching. It is now a delay rather than a permanent hole.
2. **A batch never re-polled at all** — the cell is never re-planned (the grid
   was reduced, the `configHash` moved), the handle passes the provider's
   results-retention window (**29 days** Anthropic, **30 days** OpenAI —
   verified 2026-09-02 against `platform.claude.com/docs/en/build-with-claude/batch-processing`
   and `developers.openai.com/api/docs/guides/batch`, and note that the 24-hour
   figure both APIs document is the **processing** window, not the results
   window), or `--no-resume` was passed.
3. **`--no-batch` invocations replaying nothing.** See the next paragraph.

**A second, distinct accounting hazard, registered because #103 is what makes
it reachable.** §7 point 2 stores `billing_mode` on every cost row, and §7
point 3 fixes it to `"api"` for this study. `billing_mode` is the metering
REGIME. Batch-vs-single is a different axis: a **pricing lever within the "api"
regime**, applied by `lib/price.mjs`'s `priceRow(row, table, { batch })` from a
flag the CALLER passes, because the ledger carries no per-row record of which
lever a row ran under. `spendToDate()` consequently passes ONE flag for the
whole store. That is survivable while a whole invocation is one mode, which it
has been. Resume is the first mechanism that could straddle the boundary:
replies produced under the batch API, replayed into a `--no-batch` invocation,
would be priced at roughly **twice** what they cost — not double-counted, which
a reconciliation would catch, but attributed at the **wrong rate**, which looks
entirely plausible in a total.

This is made **unreachable rather than detected**: each durable replay record
carries the `pricingLever` its replies were produced under, and the loader
declines to replay across a mismatch (choosing to re-spend over to mis-price),
while resume is inert in single mode on the provider side as well. Pinned by
test in `evals/harness/batch-resume.test.mjs`.

**What is NOT done here, and what it would take.** The principled fix is a
per-row pricing lever on `lib/accounting.mjs`'s `costRow()`, so `priceRows` can
read the lever off each row instead of being told once for the whole store.
That is a ledger schema change, it is not made by #103, and until it is made
**any store that mixes batch and non-batch spend is priced at a single lever
for all of it** — a pre-existing property of `--no-batch`, not something resume
introduced. Recorded here so a reader checking the code against the
registration finds the gap named rather than discovering it.

**Registered impact.** Nil on any hypothesis, metric, or analysis. This item
touches §7's accounting mechanics and §1's residual-threat list only. It is
recorded because Appendix B item 4 put the exception on the record, and an
exception that has changed shape must say so in the same place.

### Item 3 — §11/§8.3: the pilot's non-reuse is enforced by store separation, and `evals/run.mjs` gains `--results-dir` (issue #120)

**What was missing.** §11's optional-stopping table permits variance
estimation from a pilot on the condition that "the pilot's own data is then
**not reused** in the confirmatory test", and #49 AC5 restates that as
"enforce the exclusion structurally, not by intention". **No mechanism
existed.** `evals/run.mjs` hardcoded its results store to `results/` at all
three of its store-construction sites, so a pilot could only be run into the
same store the confirmatory grid reads. Phase 2 (§8.3) was therefore not
runnable without either violating §11 or hand-waving the exclusion.

**Why no configuration-level separation was available.** The pilot's variance
estimate transfers to the grid only if the pilot ran at the grid's
configuration. Identical configuration is thus a requirement of the pilot,
which means `planRun` classifies every pilot cell `reuse` for the grid and
`buildFrame` pools them — and §11's never-silently-pool guarantee does not
help, because it fires on config _change_ and there is correctly no change to
detect. This is the case the accumulation machinery cannot see.

**What changed in the code.** `evals/run.mjs` accepts `--results-dir`,
defaulting to `results/` and honoured by every mode it has (a real run,
`--dry-run`, `--prune`, `--phase 0`) — mirroring the flag
`evals/analysis/analysis.mjs` has always accepted, and resolved the same way
(relative to the working directory), so a pilot written by one is analysed by
the other under the same path. A path that does not exist is created, matching
`ResultsStore`'s behaviour for `results/`; a path that exists and is not a
store is refused rather than initialised over. The guarantee is asserted
directly in `evals/run.test.mjs`: two invocations at the same `configHash`
against two different `--results-dir` values, where the second reports **0
reuse** and the first (same store) reuses every cell as the control.

**What this changes about accounting, registered with it.** `spendToDate()` is
cumulative over the store in use, so the pilot and the confirmatory grid now
have separate study-to-date totals and `--max-spend` gates each against its
own. `evals/run.mjs` names the store it opened in every mode's report, and the
cumulative figure carries its store as its basis, so neither total can be read
as the other's. §8's budget is the sum across the two stores.

**Registered impact.** Nil on any hypothesis, metric, or threshold. This item
adds an enforcement mechanism for a condition §11 already registered; it does
not change the condition. It supersedes §8.3 Phase 2a's "explicitly excluded
if not" as folk knowledge — that clause's exclusion is now the store boundary.
Not in scope, and explicitly still unwired: `--phase 2` as a real alias, which
`evals/run.mjs` continues to refuse rather than silently map.

---

## Appendix E — Amendments (dated 2026-09-08)

Per the amendment rule at the top of this document. This appendix registers the six-part amendment issue `#129` asked for — prompt levers made settable, per-arm panel geometry, `effort` as a registered sampling lever, an externally-published comparability anchor, a corpus expansion, and a stance-neutral solo control — plus the §3.4 replication update those changes require, the engine-pin bump (`#134`) that made `effort` reachable in the first place, and the `configHash`/`armsConfigHash` invalidation cost of registering all of it. Landed in **`#134`** (`94be181`, engine pin), **`#139`** (`020ed8a`, corpus + anchor), and **`#140`** (`d951302`, effort/geometry/control). **Nothing in §6 (hypotheses and analysis plan) is changed by any entry below.**

Every claim below was checked against `develop @ d951302`, not against issue `#129`'s own body — `#129` is stale in several places (noted per item), and this appendix records what actually shipped.

### Item 1 — §3.3: prompt levers made settable per slot (issue #129 amendment A)

**What changed.** `resolveIdeateAgents` (`evals/harness/provider.mjs`) now forwards a slot's `effort`, on both the solo and panel paths, read from the raw slot (never from the `personaDisabled` uniform-persona overlay — a test pins this) so `undefined` stays distinguishable from an explicit value all the way to the request builders.

**Correction to `#129`'s own premise.** The issue text claims `resolveIdeateAgents` "forwards only `{id, persona, model, ideasPerAgent}`" and that "the harness cannot vary any prompt-side lever at all." That was true when `#129` was filed but is stale by the time this amendment landed: `stance`, `temperature`, `strategy`, and `personaDisabled` were already forwarded, by `#128`, before this issue closed. `effort` was the one genuinely missing lever; this item closes it.

**Forwarding is not rendering — the three pre-existing levers are not equally load-bearing, and `provider.mjs`'s own header comment says so:**

- **`stance` reaches the wire.** `evals/harness/prompts.mjs`'s `buildRound1Prompt`/`buildRound2Prompt` render a stance line from it, so a slot-level stance genuinely changes the submitted prompt.
- **`temperature` is recorded, not sent.** §3.3's universal strip means neither request builder ever reads it for any model; it still rides the agent record and `ideate-core`'s `normalizeExtra` context, which is why forwarding it correctly still matters — stored cells used to record five index-derived temperatures that were never actually submitted.
- **`strategy` is recorded, not rendered — yet.** `ideate-core` passes it into the prompt-builder context, but this harness's own `buildRound1Prompt`/`buildRound2Prompt` override `ideate-core`'s and do not branch on it, so direct-vs-CoT is still not a live lever at the prompt. Making it one is a registered prompt change, not a harness fix, and is explicitly out of scope for this amendment. Pinned by a test so this boundary cannot silently rot back into a no-consumer field. This matters for Item 6 below: AS is built to differ from arm A in stance only, and part of why that claim holds is that overriding `strategy` currently has no prompt-level effect to confound it with.
- **`effort` (this item) reaches the wire.** `ideate-core@0.5.0` forwards a slot's `effort` to `complete()` by plain assignment (`effort: agent.effort` / `effort: spec.effort`), deliberately not the `spec.X || base.X` fallback its siblings use, and both request builders forward it verbatim.

### Item 2 — §3.1: panel geometry becomes per-arm, not only global (issue #129 amendment B)

**What changed.** `arms.config.json`'s global `panel { size, ideasPerAgent, maxRounds }` block remains the registered default. `size`, `ideasPerAgent`, `maxRounds`, and now `sharing` are per-arm overrides, resolved by `resolvePanelGeometry(arm, armsConfig)` (`evals/harness/provider.mjs`), which inherits each field independently — an arm can override just one field and inherit the rest from the global block.

**`sharing` has no global default.** `armsConfig.panel.sharing` is never set in the merged `arms.config.json`, and `resolvePanelGeometry` falls through to `undefined` when neither the arm nor the global block sets it. `buildIdeateRounds(maxRounds, sharing)` returns `undefined` for an `undefined` `sharing`, which means the harness sends no `deps.rounds` override to ideate-core at all — round 2 runs under ideate-core's own blind-then-pool behavior, unmodified. Absence is not "off" in any special harness sense; it is simply not overriding the library default.

**Nothing in the registered study currently exercises this.** No arm in the merged `arms.config.json` sets `arm.panel` — every panel arm (B–H, A′) still runs the registered 5/6/2, and A/AS are solo (which throws if `arm.panel` is set at all — solo arms have no panel geometry to override, enforced by `resolveIdeateAgents`). This item registers a mechanism the follow-on sub-studies (Study 1's effort sweep, Study 3's geometry sweep) will use, not a behavior change to any arm registered in this document today.

### Item 3 — §3.3: `effort` registered as the sampling lever, wire shapes verified first-party (issue #129 amendment C)

**What changed.** Both request builders emit `effort` explicitly when a slot sets one, and the resolved per-cell setting enters `configHash`.

- **Anthropic.** `buildAnthropicMessageParams` emits a **nested** `output_config: { effort }`, verified first-party against `platform.claude.com/docs/en/build-with-claude/effort` (fetched 2026-09-08). A bare top-level `effort` field — the shape `#129`'s own acceptance criteria left ambiguous — would be silently ignored by the API: wrong experiment, no error. Ladder for Anthropic: `low | medium | high | xhigh | max`. **Haiku 4.5 is not on the documented supported-model list** and is expected to reject `output_config.effort`; the builder throws if a slot sets `effort` on a model outside `ANTHROPIC_EFFORT_SUPPORTED_MODELS`. No arm sets `effort` on a Haiku slot today. A config-level sweep test (`evals/harness/anthropic-batch.test.mjs`, mirroring the existing `temperature` force-strip sweep) fails at `npm test` if any arm ever does — before any spend, not merely at request-build time on a live run.
- **OpenAI.** `buildOpenAIChatParams` emits a **top-level** `reasoning_effort`, verified first-party against `developers.openai.com/api/docs/api-reference/chat/create` (fetched 2026-09-08): "Currently supported values are none, minimal, low, medium, high, xhigh, and max."
- **The setting enters `configHash` via the declared config, not via a separately-resolved runtime value.** There is no dedicated "resolved effort" field stamped by `evals/run.mjs` — `arms.config.json` is the only place a slot's `effort` is declared today, and `armsConfigHash` (Appendix D item 1) hashes the entire file, so any arm's `effort` setting is covered by construction. This is coverage of the *declaration*, not of what a live call actually resolved to; the two coincide only because `arms.config.json` is currently the sole source of a slot's `effort`. A future config source for `effort` (a CLI override, an environment default) would need its own path into `configHash` — none exists today, and none is registered here.

**The two ladders are verified but NOT identical — this is what `#129`'s "ladder not yet verified against first-party docs; do not assume it maps" now resolves to.** OpenAI's ladder has two rungs (`none`, `minimal`) below Anthropic's floor (`low`). Cross-provider effort therefore remains confounded at the bottom of the range, even though both ladders are now implementable and documented. The two-part rule `#129` specified is registered as written:

1. **Across arms (Studies 2–4): `effort` is omitted universally**, exactly as `temperature` is force-stripped (§3.3). Bias direction stated the same way §3.3 states it for temperature: a model comparison at provider defaults compares *shipped defaults*, which may be the decision-relevant quantity, but it is not a matched-effort comparison and must not be reported as one.
2. **Within one model (Study 1): `effort` is a first-class ordinal factor**, never crossed across model families — the asymmetry above is exactly why crossing it would confound model with ladder position.

### Item 4 — §3.2: an externally-published comparability anchor, `prod-07` (issue #129 amendment D)

**What changed.** A verbatim brief, `prod-07`, is registered in the **product** stratum (not a standalone stratum — folding it into `product` is what gives that stratum an external anchor at all), `provenance: "verbatim"`. Text: Meincke, Mollick & Terwiesch's "Base Prompt," transcribed from arXiv:2402.01727v1.

**Citation correction, made explicit rather than silently fixed.** `#129`'s own body cites the originating 2023 working paper as "Girotra, Terwiesch & Ulrich" — three authors. The actual citation is **Girotra, K., Meincke, L., Terwiesch, C., & Ulrich, K. T. (2023)**, *Ideas Are Dimes A Dozen*, Mack Institute working paper, SSRN 4526071 — **four** authors; the issue text drops Meincke. `evals/corpus/briefs.mjs`'s `ANCHOR_SOURCE` records both the corrected four-author citation and the secondary citation (Meincke, Mollick & Terwiesch 2024, arXiv:2402.01727) the registered text was actually transcribed from, with an explicit comment: "#129's own citation text is WRONG (drops Meincke as an author of the 2023 paper) and must not be copied from the issue body."

**Verification.** The registered string was diffed character-by-character against the retrieved PDF text. Both labelled occurrences of the "Base Prompt" row (p.12 inline, and the Appendix D prompt table, pp. 24–25) are byte-identical: both hash to **md5 `4f7d9191488a5e9f0eb6162dca94582f`**, confirming the straight apostrophe in "I'd" and the hyphen in "40-80" are genuine transcription, not extraction artifacts.

**The comparability claim is ordering-only, and `#129`'s stated rationale is partly wrong.** `#129` calls this "the single most directly comparable prior result." That is only true of the *ordering* of strategies. Meincke et al. measured diversity with Google's Universal Sentence Encoder; this study uses Voyage. The paper itself warns (p.6): "changing the embeddings model could yield dramatically different results depending on the training even if it was optimized for the same purpose." Their published cosine-similarity values — Base Prompt 0.377, Chain-of-Thought 0.255, Group of Students 0.243 — are therefore **NOT comparable to this study's numbers**; only the relative ordering of strategies may transfer, not the magnitudes. `evals/corpus/briefs.mjs`'s `comparabilityCaveat` states this plainly, and this appendix does not repeat `#129`'s uncorrected framing.

**No human-comparable instrument is implied.** The human-subject prompt is not available verbatim — Girotra et al. state only that they gave ChatGPT-4 "essentially the same prompt we gave the students," the authors' own characterization, not a transcript. Registered as `humanPromptCaveat` so nothing downstream treats this brief as a verbatim human baseline.

**Version risk is scoped to the originating citation, not the registered string.** SSRN 4526071 (Girotra et al. 2023) has since been revised — retitled, expanded author list — and returns HTTP 403 as of 2026-09-08; its current version is unverified. That risk attaches to the *originating* citation only. The registered prompt text was transcribed from arXiv:2402.01727v1, a stable, versioned submission, re-retrievable at the exact identifier recorded in `ANCHOR_SOURCE.retrievedFrom` — no version risk attaches to the string actually registered.

### Item 5 — §3.2: corpus expanded 24 → 48 briefs, 12 per stratum (issue #129 amendment E)

**What changed.** `CORPUS_HASH` moves **`55e05c2811a7` → `bb26bebbf00f`**. The corpus grows from 24 briefs (6 per stratum) to **48 briefs, 12 per stratum** (business / product / scientific / aut), verified directly against `evals/corpus/briefs.mjs`.

**The expansion is additive.** The original 24 briefs retain their ids, text, and content hashes byte-identical — `corpus.test.mjs` guards this — and `preAmendmentCorpusHash(CORPUS)` still reconstructs `55e05c2811a7`. Verified directly: calling `preAmendmentCorpusHash` against the current `CORPUS` returns `55e05c2811a7`. The pre-amendment corpus therefore stays derivable from the current one; nothing was re-rolled or reworded.

**Parity, not weighting toward external sources — a correction made during authoring, disclosed here.** A first draft of this expansion weighted the scientific stratum to maximize the count of externally-traceable briefs, which the code comments in `briefs.mjs` record as a wrong reading of §3.2/§6.2: an unequal split would let brief-level variance (and the headline effect estimate) be dominated by whichever stratum has the most briefs, since `§6.2`'s model treats briefs as exchangeable random effects. The shipped corpus keeps strict 12/12/12/12 parity; "weight toward externally-traceable sources" is satisfied instead by which strata *gain* an anchor — scientific, aut, and now product (via `prod-07`) — 3 of 4 strata, up from 1 of 4.

**Business is the one stratum with no external anchor.** No external instrument exists for it — the code comment in `briefs.mjs` disclosed this only as a comment before this amendment; this appendix is now the authoritative registration surface for that gap, per the task's requirement that the absence not be left as code-only disclosure.

**Business/product briefs' authorship.** As already registered (Appendix B item 13), the original business/product briefs are authored by the product's owner. The 6 newly authored briefs in each of those strata carry the same disclosed conflict of interest; they are demoted to secondary relative to the externally-anchored briefs in the same strata (the LiveIdeaBench-sampled scientific briefs, the AUT-paradigm briefs, and `prod-07`).

### Item 6 — §3.1: a stance-neutral solo control, arm AS (issue #129 amendment F)

**What changed.** A tenth arm, **AS**, is registered: `mode: "solo"`, `personaDisabled: true`, with an explicit `uniformPersona`. Verified directly against `arms.config.json`.

**Arm A is unmodified.** Diffed field-by-field against `arms.config.json` as it stood at `8e8c174` (the commit immediately preceding `#139`): arm A's entry — `label`, `mode`, `personaDisabled`, `purpose` prose included, `slots`, `totalIdeasRequested` — is byte-identical. Arm A remains the registered baseline; AS is additive, not a replacement.

**Why arm A is not neutral, and why AS is needed.** Arm A's slot persona `solo` is not a `DEFAULT_PERSONAS` name, so ideate-core falls through to `DEFAULT_PERSONAS[0]` — PRAGMATIST, stance-assigned, strategy `direct` (the only non-CoT configuration in the grid). Against every panel arm, arm A therefore varies in stance **and** strategy **and** rounds **and** model, all at once (per `#128`). AS isolates the stance lever: `personaDisabled` (plus `uniformPersona`) forces the same explicit, perspective-free stance arm A′'s panel ablation uses, and overrides temperature/strategy back to PRAGMATIST's own values (0.4 / `direct`) rather than the uniform-persona default's CoT-leaning values — so AS is built to differ from arm A in stance only. Same model (`claude-sonnet-5`), same `totalIdeasRequested` (30), same `maxRounds` (1) as arm A.

**Why the persona name is deliberately inert.** The persona *name* is transmitted verbatim into the round-1 prompt (`evals/harness/prompts.mjs`). AS's `uniformPersona.persona` is `"solo_b"` — no reference to "stance," "neutral," or the experimental construct anywhere in the string the model sees. An earlier draft used a descriptive name (`"solo_stance_neutral"`); naming the experimental construct in the prompt text the model reads would be a demand characteristic, so the shipped value is deliberately inert.

### Item 7 — §3.4: replication derivation registered, B = 48 / R = 2 explicitly provisional

**What's registered.** The variance-component method and the resulting SE-vs-(briefs, replicates) table from `#129`'s own analysis of the Phase 2a smoke (`results/`, cfg `0000daa58e5a`, 20 cells). **Reported, not verified against a committed artifact in this repo** — transcribed from `#129`'s issue body, not independently re-run in this session:

- `brief` variance component: 21.99
- `brief:arm` (interaction) variance component: **77.85**
- Pooled within-(arm × brief) residual variance: 6.82 (sd 2.61)

The interaction dominates the residual by more than 10×, so briefs buy far more power than replicates:

| B (briefs) | R=1  | R=2  | R=3  | R=5  |
| ---------- | ---- | ---- | ---- | ---- |
| 6          | 5.31 | 5.20 | 5.17 | 5.14 |
| 12         | 3.76 | 3.68 | 3.65 | 3.63 |
| 24         | 2.66 | 2.60 | 2.58 | 2.57 |
| 48         | 1.88 | 1.84 | 1.83 | 1.82 |

**B = 48, R = 2 is registered as the current best estimate — explicitly, deliberately provisional, not a frozen design parameter.** `#129` itself flags `σ²_ba = 77.85` as "the least stable number in the study," estimated from **two briefs** in the Phase 2a smoke. Every MDE downstream of this table scales with that one number. Freezing B=48/R=2 as a binding replication target would launder a two-brief variance estimate into a settled design decision, which is precisely what §11's non-reuse and additive-accumulation machinery exists to prevent doing quietly. **This table is bound to Study 1's re-estimate of `σ²_ba`**: Study 1 re-estimates the dominant variance component from a materially larger brief count (the 48-brief corpus, Item 5), and the final replication numbers are whatever that re-estimate implies via the same SE formula — not the row above. Until Study 1 reports, the table above is the working estimate the study plans around, registered as provisional so a reader cannot mistake it for a frozen commitment.

### Item 8 — cost of this amendment: `armsConfigHash` moves, invalidating every arm's cells

**What's registered.** Registering arm AS (Item 6) changes `arms.config.json`, which moves `armsConfigHash` — a hash over the whole file (Appendix D item 1) — which by that item's already-registered rule invalidates **every** arm's stored cells, not only AS's. This is the same "introduce arms before a phase begins, not during one" consequence Appendix D item 1 registered in advance; this item records that it actually fired, and what it cost.

**Verified decomposition of `results-pilot/index.jsonl`'s 59 records**, discriminated by the sentinel `armId` values the store actually uses (`__batch-replay__`, `__judge-call__`, `__judge-scores__`), not by any assumption about `cfg` string shape:

| `armId`            | `state`     | count |
| ------------------ | ----------- | ----- |
| `B`                 | `completed` | 16    |
| `D`                 | `failed`    | 3     |
| `__batch-replay__`  | `skipped`   | 3     |
| `__judge-call__`    | `completed` | 23    |
| `__judge-scores__`  | `completed` | 14    |

That is **19 generation cells** (16 arm-B completed, 3 arm-D already `failed` before this amendment) at `cfg=0000daa58e5a`, plus 3 skipped `__batch-replay__` records and 37 judge-bookkeeping records (23 `__judge-call__` + 14 `__judge-scores__`) — 59 total, matching the file's line count exactly.

**The data actually lost to re-collection is the 16 completed arm-B generation cells.** The 3 arm-D cells were already `failed` and cost nothing beyond their original (already-sunk) spend. The judge-bookkeeping and batch-replay records key off the generation cells they describe and carry no independent value once those cells go stale. Leading with 19 would overstate the loss; 16 is the number that matters, with 19 given for the full split.

`results-pilot/` is **tracked and committed** on `develop` (since `399bcc5`, landed via `#137`) — this is not a description of untracked local state; the pilot store the harness produced is part of the repository's history, and its 16 lost cells are a real, git-visible cost of this amendment rather than an ephemeral one.

**Not a second, separate invalidation.** `#134`'s engine-pin bump (Item 9) also moved `configHash` — at `94be181`, before arm AS existed — and registering AS then moved `armsConfigHash` again. Both changes make the same 16 completed arm-B cells stale; a cell invalidated once cannot be invalidated a second time for a bigger loss. The 16-cell cost above is the total cost of reaching the post-amendment state, not an amount to be added to a separate figure for Item 9.

### Item 9 — §0: engine pin bumped `ideate-core@0.4.0` → `ideate-core@0.5.0` (issue #134)

**What changed.** §0's `Target engine` moves from `ideate-core@0.4.0` to **`ideate-core@0.5.0`**, landed via `ideate-core-evals#134` (merged `94be181`). Verified: `package.json`/`package-lock.json` pin `0.5.0`; `ideate-core@0.5.0` is published on the public npm registry (dist-tag `latest`; registry timestamp `2026-09-08T03:10 UTC`, `CHANGELOG.md` dates the release `2026-09-07`) and tagged `v0.5.0` in `Kromatic-Innovation/ideate-core` (`e8e0c4c`, tag date `2026-09-08T03:09 UTC`) — the small UTC/local discrepancy is noted rather than smoothed over, since the appendix's own discipline is to state the number actually measured, not the rounder one.

**Why this belongs in this appendix rather than a separate one.** §0's pin is the registered statement of which engine produced the data, and `engineSha` feeds `configHash` (Appendix A item 1: pinning the real version "is what makes `configHash` actually change when the engine changes — the whole point of pinning it"). Leaving §0 at `0.4.0` after `#134` landed would mean the registration named a different engine than the one every future cell actually runs under.

**No manual `configHash` bump was needed or made — verified, not merely asserted.** `engineSha` is derived from the *installed* version at runtime (`evals/run.mjs`'s `getEngineVersion()` / `IDEATE_CORE_ENGINE_SHA || `ideate-core@${engineVersion}``), so the hash moves on its own when the pin changes. `IDEATE_CORE_ENGINE_SHA` is confirmed unset in this environment, so the derivation is real rather than an env override. Reconstructed directly against the tree at `94be181` (a temporary worktree, all six other `CONFIG_FIELDS` inputs — `promptHash`, `judgeHash`, `embedderId`, `corpusHash`, `armsConfigHash`, `clusterDistanceThreshold` — held to their actual values at that commit, since only `package.json`/`package-lock.json` changed in `#134`):

```
configHash(engineSha: ideate-core@0.4.0, ...)  →  1a62e8d92d34
configHash(engineSha: ideate-core@0.5.0, ...)  →  119708570b71
```

matching the pre-registered numbers exactly.

**What `0.5.0` contains that this study can now reach.** Most directly relevant: the per-agent `effort` field (`ideate-core#146`) — `deps.agents[i].effort` forwarded verbatim to that agent's `complete()` call by plain assignment, not a `spec.X || base.X` fallback, so `undefined` stays distinguishable from an explicit value. **This is the precondition Item 3 above depends on** — the two items are otherwise registered separately in this appendix, so the dependency is stated here explicitly rather than left implicit. `0.5.0` also ships `meta.agentErrors` failure reporting (`ideate-core#154`, `ideate-core#157`) and routing parity for `effort`/`model` in the bundled adapters (`ideate-core#149`, `ideate-core#151`) — neither is exercised by this study's harness today, but both are part of what the pinned version now provides.

**Interaction with Item 8's cost accounting.** This bump moved `configHash` at `94be181`, before arm AS was registered; registering AS then moved `armsConfigHash` again. Both changes stale the same 16 completed arm-B pilot cells — see the note at the end of Item 8. This item adds no additional data loss beyond what Item 8 already accounts for.

---

## Appendix F — Amendments (dated 2026-09-08)

Per the amendment rule at the top of this document. This appendix registers **Study 1 (`#130`), Stage 1a** — the screening run — and the two harness changes it requires but the registration did not previously authorize: making `strategy` a rendered prompt lever, and sizing `max_tokens` for calls that carry an `effort` setting. It also records two corrections to `#130`'s own body, made explicit rather than silently absorbed.

Every claim below was checked against `develop`, not against `#130`'s body. **Nothing in §6 (hypotheses and analysis plan) is changed by any entry below**; Stage 1a is a screening run reporting estimates with intervals, and Item 7 registers what that does and does not license.

### Item 1 — §3.3: `strategy` becomes a rendered prompt lever, and the CoT template is registered verbatim

**What changed.** `evals/harness/prompts.mjs`'s `buildRound1Prompt` / `buildRound2Prompt` now branch on `strategy`. Landed in `#142` (`296bbae`).

**This supersedes Appendix E item 1's third bullet.** That item registered `strategy` as "recorded, not rendered — yet," pinned by a test, and stated that making it a live lever "is a registered prompt change, not a harness fix" and was out of scope for `#129`. This item is that registered prompt change. Study 1's centre point is `strategy: "cot"`, so without it every Stage 1a condition would have run `direct` while being labelled otherwise — a study that answers a different question under its own registered name.

**The template text is the manipulation, so it is registered here verbatim rather than described.** When `strategy === "cot"` — and only for that exact string; `"direct"`, an unknown value, and `undefined` all render nothing — the following paragraph is inserted after the stance line and immediately before the "Generate exactly N…" sentence.

Round 1:

> Work through the brief before you commit to any idea: first name the distinct dimensions along which responses to this brief could differ; then consider what a response at each end of each dimension would look like; only then decide which ideas to submit. Do not include this reasoning in your reply.

Round 2 (the build-on analogue):

> Work through the shared pool before you commit to any idea: first name what the existing ideas have in common; then consider which dimensions they leave unexplored; only then decide which new ideas to submit. Do not include this reasoning in your reply.

The closing sentence of each is load-bearing, not stylistic: the reply contract is a bare JSON array (`{"text": "…"}` objects, no surrounding prose), and `salvageCandidateArray`'s recovery walk begins at the first `[` or `{` in the reply. Reasoning emitted *into* the reply would put braces ahead of the array and could take structural text with it. Both builders keep their JSON-only contract sentence unchanged under both strategies.

**`ideate-core` ships no CoT copy of its own.** `DEFAULT_PERSONAS` assigns each persona a `strategy` string (`direct` for pragmatist, `cot` for the other four), but the library supplies no prompt text — `ideateCore` requires `deps.buildRound1Prompt` from its caller and never renders prompts itself. The wording above is therefore this harness's authored operationalization of "CoT," not a reproduction of the product's, and Study 1's `strategy` factor measures *this* template. That distinction matters for any claim that transfers to `ideate-core`'s shipped behavior: what the product ships is the *label*, and each caller supplies the text behind it.

**This is not an additive change, and the affected arms are named.** `UNIFORM_PERSONA.strategy` is `"cot"`, and four of five `DEFAULT_PERSONAS` are `"cot"`. Rendering the branch therefore changes the prompt actually submitted by **arm A′** and by **every panel arm (B–H)** whose slots fall through to `DEFAULT_PERSONAS` — not only by the Study 1 arms registered below. That is the intended consequence of Appendix E item 1's amendment reaching the prompt, but it is a behavior change to arms registered in this document today, and it is recorded as one.

**`promptTemplateHash()` moves `0fb497a4a61d` → `b529182bea28`**, so `configHash` moves, so every stored cell becomes `stale`. See Item 8.

**The hash covers both branches, by construction.** `promptTemplateHash()`'s probe arguments previously carried no `strategy`, so a single render would have left the CoT wording outside the hash — a prompt change that does not move `configHash` is precisely the defect the hash exists to prevent. Both builders are now rendered twice into the hash payload, once per strategy, as separate keys, with the existing no-argument default renders retained. Pinned by a mutation-verified test.

### Item 2 — §3.1/§3.2: Study 1, Stage 1a — the registered screening design

**What is registered.** A one-factor-at-a-time screening sweep from a centre point, within one model, on a 12-brief subset of the registered 48-brief corpus, at 2 replicates.

**Held constant across every condition:** `claude-sonnet-5`; `mode: "solo"` (one call, no panel, no rounds — `maxRounds` 1); `personaDisabled: true` with an explicit `uniformPersona`; the persona **name** `solo_b`; `temperature` 0.4 (recorded, never sent — §3.3's universal strip stands); no sampling parameters; the same corpus subset, embedder, and clustering threshold.

**The persona name is held constant deliberately.** `buildRound1Prompt` interpolates the persona name into the prompt verbatim, so a name that varied with the condition — `s1_contrarian`, say — would leak the manipulation into the text and reintroduce the demand characteristic arm AS's inert `solo_b` was chosen to remove. Every Study 1 condition carries the same inert name; the stance factor varies **only** the `stance` text.

**Centre point:** N=30, `effort: "high"`, stance neutral, `strategy: "cot"`.

| Arm id | N | `effort` | stance | `strategy` |
| --- | --- | --- | --- | --- |
| `S1-C0` (centre) | 30 | `high` | neutral | `cot` |
| `S1-N10` | **10** | `high` | neutral | `cot` |
| `S1-N60` | **60** | `high` | neutral | `cot` |
| `S1-ELOW` | 30 | **`low`** | neutral | `cot` |
| `S1-EMAX` | 30 | **`max`** | neutral | `cot` |
| `S1-SPRAG` | 30 | `high` | **PRAGMATIST** | `cot` |
| `S1-SCONTRA` | 30 | `high` | **CONTRARIAN** | `cot` |
| `S1-DIRECT` | 30 | `high` | neutral | **`direct`** |

**8 conditions × 12 briefs × 2 replicates = 192 cells.** See Item 4 for why this is 8 and 192 rather than `#130`'s 9 and 216.

**Stance texts are registered verbatim, and their source is the point of the study.** The neutral stance is arm AS's registered text: *"No particular perspective is assigned for this task. Approach the brief however you judge best."* PRAGMATIST and CONTRARIAN are `ideate-core@0.5.0`'s `DEFAULT_PERSONAS[0]` and `[1]` stance strings, transcribed verbatim. This is what unbundles the persona lever: `DEFAULT_PERSONAS` ships stance and strategy *together* (pragmatist/`direct`, contrarian/`cot`), so a "persona effect" measured on the main grid is un-attributable between perspective and prompt strategy. Stage 1a holds `strategy` at the centre value while moving stance alone, and moves `strategy` alone in `S1-DIRECT`.

**`S1-DIRECT` is behaviourally equivalent to arm AS, and that is deliberate.** Same model, same `totalIdeasRequested` (30), same `maxRounds` (1), same persona name `solo_b`, same stance, same temperature, and the same resolved `max_tokens` bucket. The two differ in exactly one respect: arm AS omits `effort` entirely, while `S1-DIRECT` sets it explicitly to `high` — which Item 5's first-party source documents as producing *"exactly the same behavior as omitting the `effort` parameter entirely."* The requests are therefore not byte-identical, and this appendix does not claim they are; they are equivalent by documented API behaviour. That gives Stage 1a a consistency check against the main grid at the cost of one condition's duplicate cells, and it makes the documented equivalence itself something the run can observe rather than merely assume — if `S1-DIRECT` and a later arm-AS cell diverge beyond replicate noise, the equivalence claim is what to doubt.

### Item 3 — §3.2: the Stage 1a brief subset, and why it is not "the first three per stratum"

**What is registered.** Twelve briefs, three per stratum:

| Stratum | Briefs |
| --- | --- |
| business | `biz-01`, `biz-02`, `biz-07` |
| product | `prod-01`, `prod-07`, `prod-08` |
| scientific | `sci-01`, `sci-02`, `sci-07` |
| aut | `aut-01`, `aut-07`, `aut-08` |

**The rule is an exact split across the corpus expansion, not an id prefix.** Appendix E item 5 grew the corpus additively: ids `-01` through `-06` in each stratum are the pre-amendment 24, `-07` through `-12` are the 24 added by `#129`. The obvious deterministic rule — the first three ids per stratum — would have drawn **11 of 12** briefs from the pre-amendment half. Stage 1a exists to re-estimate `σ²_ba`, and Appendix E item 7 binds every downstream MDE in §3.4 to that one number; estimating it from a subset that is 92% one half of the corpus would inherit whatever that half's composition happens to be and propagate it through the entire replication plan. The registered subset is **6 pre-amendment and 6 post-amendment**, balanced across strata (business and scientific take 2+1; product and aut take 1+2), deterministic, and reproducible by inspection with no RNG.

**`prod-07` is included, and it is the anchor.** Appendix E item 4's externally-published comparability anchor falls inside the subset by construction rather than by exception.

> _Amended 2026-09-08 ([Appendix I](#appendix-i--amendments-dated-2026-09-08), item 2). Stage 1b registers **24 briefs** on the same reasoning — the first three ids from each half of each stratum (`-01`, `-02`, `-03`, `-07`, `-08`, `-09`), six per stratum, three pre-amendment and three post. The Stage 1a subset above is **unmodified** and is contained in it exactly, so the two stages are directly comparable on the overlapping twelve._

### Item 4 — correction to `#130`: the screening run is 8 conditions and 192 cells, not 9 and 216

**What is corrected.** `#130` specifies a fractional design that varies "one factor at a time from a centre point" and states **"9 conditions"** and **"216 cells"** (12 briefs × 2 replicates). A one-factor-at-a-time design's condition count is one centre point plus the sum of each factor's off-centre levels. The factors have 3, 3, 3, and 2 levels respectively (N: 10/30/60; effort: low/high/max; stance: neutral/PRAGMATIST/CONTRARIAN; strategy: `direct`/`cot`), giving 1 + 2 + 2 + 2 + **1** = **8** conditions and **192** cells. `#130`'s 9 counts `strategy` as contributing two off-centre levels; it has one, because it has two levels in total.

**This is arithmetic, not design.** No factor, level, brief, or replicate registered in `#130` is dropped, added, or altered — the corrected count describes exactly the design that issue specifies. It is registered here rather than fixed silently because the 216 figure appears in `#130`'s own cell budget and would otherwise read as a missing condition when the run reports 192.

**No ninth condition is added to preserve the figure**, and specifically no separate "engine-default effort" reference condition is needed — Item 5 records why the centre point already is one.

### Item 5 — §3.3/§8: `effort` interacts with `max_tokens`, and the existing sizing was measured without it

**The wire fact, verified first-party** against `platform.claude.com/docs/en/build-with-claude/effort` (fetched 2026-09-08): `max_tokens` is *"a hard limit on total output (thinking plus response text)"*, and effort *"affects **all tokens** in the response,"* thinking included.

**Why that is a threat to this study specifically.** `evals/harness/prompts.mjs`'s `TOKENS_PER_IDEA_BY_MODEL` sizes `max_tokens` from live measurements taken with **no `effort` set at all** — Sonnet's 62 tokens/idea (`#93`, 2026-09-02) and Opus's 558 (`#122`, 2026-09-03) both predate `effort` being reachable from this harness. Stage 1a sets `effort` explicitly on every cell and runs `max` on one full condition. An under-sized cap does not degrade gracefully: the reply stops on `max_tokens` mid-JSON, and while `salvageCandidateArray` recovers the complete objects before the cut, a cap consumed largely by thinking yields a short pool or an `empty_pool` — a *systematic* loss concentrated in the highest-effort condition, which is precisely the condition the study is trying to measure. That is the `#93` failure mode (arm A losing 9 of 10 cells) with a new cause.

**A second, documented fact that resolves Item 4's ninth-condition question.** The same page states: *"Setting `effort` to `"high"` produces exactly the same behavior as omitting the `effort` parameter entirely,"* and Claude Sonnet 5's API default is `high` (confirmed against the model-comparison table's "Default effort" row, same date). The Stage 1a centre point is therefore already request-equivalent to the effort-free arms A and AS, by documentation rather than by assumption — so the sweep needs no separate no-effort anchor condition to connect it to the main grid.

### Item 6 — §3.3: `max_tokens` becomes per-(model, effort), measured live before the run

**What was measured.** 20 live `claude-sonnet-5` calls on 2026-09-08, driving `evals/harness/prompts.mjs`'s real `buildRound1Prompt` at the exact Stage 1a request shape (solo, round 1, neutral stance, persona `solo_b`), at `max_tokens: 32000` so nothing truncated and the true distribution was observable. Briefs were drawn from the registered Stage 1a subset. Every reply ended on `stop_reason: "end_turn"`.

| Condition | n | output tokens (min–max) | per idea (min–max) | cap the current sizing would have applied |
| --- | --- | --- | --- | --- |
| N=30, `low`, cot | 2 | 1,340–2,425 | 44.7–80.8 | 4,650 |
| N=30, `high`, cot | 2 | 2,204–3,598 | 73.5–119.9 | 4,650 |
| N=30, `high`, direct | 2 | 2,478–2,991 | 82.6–99.7 | 4,650 |
| N=10, `high`, cot | 2 | 949–1,318 | 94.9–131.8 | 2,048 |
| **N=60, `high`, cot** | 6 | 3,177–**10,451** | 53.0–**174.2** | **9,300** |
| **N=30, `max`, cot** | 6 | 5,924–**23,269** | 197.5–**775.6** | **4,650** |

**Two conditions would have failed systematically.** `N=30, max` ran to 23,269 output tokens — **5.0×** the cap the current constants would have set — and `N=60, high` to 10,451 against 9,300. Those replies would have stopped on `max_tokens` mid-JSON. `salvageCandidateArray` recovers the complete objects before the cut, so the failure is not total, but it is *systematic and concentrated in the highest-effort condition* — the very condition the effort factor exists to measure. A short pool at `max` and a full pool at `low` would have been read as a dose-response effect of effort on `distinct_k` when it was an artifact of the cap. That is `#93`'s arm-A failure (9 of 10 cells lost) with a new cause, and it is the specific way this study could have produced a confidently wrong headline number.

**The existing Sonnet constant is under-measured even with no `effort` set.** `TOKENS_PER_IDEA_BY_MODEL["claude-sonnet-5"] = 62` comes from `#93`'s 2026-09-02 probe (1,857 / 30 ideas). Because `high` is request-equivalent to omitting `effort` (Item 5), the `N=30, high` rows above measure the same request `#93` measured, and they run to 119.9 tokens/idea — and the `direct` rows, which do not carry Item 1's CoT paragraph, still reach 99.7. So this is not solely an artifact of the new template: the pinned 62 was already leaving arms A, AS, and C riding their cap, exactly the shape `#93` itself named as dangerous.

**What is registered.** `TOKENS_PER_IDEA` becomes keyed by **(model, effort)**, with `undefined` effort resolving to the `high` bucket — the documented equivalence, not an assumption. Each rate is the **top** of that bucket's observed per-idea distribution, never its mean; `MAX_TOKENS_HEADROOM` stays 2.5× and `LEGACY_MAX_TOKENS` (2,048) stays a floor.

| Model | effort bucket | tokens/idea | provenance |
| --- | --- | --- | --- |
| `claude-sonnet-5` | `low` | 81 | measured 2026-09-08, n=2 |
| `claude-sonnet-5` | `high` (and unset) | 175 | measured 2026-09-08, n=10 |
| `claude-sonnet-5` | `max` | 776 | measured 2026-09-08, n=6 |
| `claude-opus-5` | effort-free | 558 | `#122`, measured 2026-09-03 |

**Resolution order for an unmeasured pair**, in order: the exact (model, effort) rate; else the model's **highest** measured rate across efforts; else `DEFAULT_TOKENS_PER_IDEA`, the highest rate measured for any model at any effort — now **776**, up from 558. Every fallback is upward, because `max_tokens` is a ceiling billed as generated, so over-sizing an unmeasured pair costs nothing while under-sizing it reproduces this exact defect on the next model or the next effort level. Sonnet at `medium` and `xhigh` are unmeasured and unused by any registered arm; both resolve upward to 776.

**Consequences to arms already registered in this document.** This raises the cap for arms **A**, **AS**, and **C** (Sonnet, effort unset → the `high` bucket's 175), and for every arm running an unmeasured model (**B**, **A′**, **G**, **H**) via the raised default. No request shrinks. `max_tokens` is a ceiling, not a target, so no reply gets longer merely because the cap did — but the sizing constants are inputs to `promptTemplateHash()`, so this moves the hash a second time. See Item 9.

**Sizing stays inside the model's limits.** The largest cap this produces is `N=30, max` at 58,200 tokens (30 × 776 × 2.5), against Claude Sonnet 5's documented 128K max output (same source, same date).

### Item 7 — §6: what Stage 1a does and does not license

**Stage 1a is a screening run. It reports effect sizes with confidence intervals and runs no hypothesis tests**, exactly as `#130` specifies. Its purposes are, in order: re-estimate `σ²_ba` on 12 briefs rather than the two the Phase 2a smoke used; confirm that `effort` and stance actually move `distinct_k` before a powered run spends against them; and confirm the new plumbing records what it should.

**No entry in §6's registered hypothesis family (H1–H5) is tested, adjusted, or answered by this run**, and the Holm family is not entered. The family is defined over arms A–H and A′; a solo-only sweep does not carry those coefficients, and `buildRegisteredFamily()` records each unreachable contrast as explicitly **not estimable** rather than substituting a present arm for an absent one. That recorded not-estimable state is the correct and expected output of a Stage 1a analysis run, not a failure of it.

**Judge scores are collected but not analyzed, and are not reportable.** Judging cannot be disabled from the CLI — `evals/run.mjs` always supplies the registered `JUDGE_MODELS` roster, and `buildJudgeMatrix` assigns every pool two legs (one Anthropic, one OpenAI, each selected distinct from the generator), so Stage 1a's 192 cells carry 384 judge calls costing more than the generation they score. That spend is accepted rather than engineered around: exercising the judge path end to end is one of Stage 1a's three stated purposes, and `judgePoolIfEnabled` judges already-generated cells in a later session anyway, so neither collecting nor deferring forecloses anything. What the scores may NOT do is enter a result. §5.1's judge-validation gate has not been run, and Appendix B item 11 holds idea-level metrics exploratory until it passes; these rows are stored data awaiting that gate, and their presence in `results-study1/` is not evidence about any idea-level quantity.

**One way this run could fabricate a registered result, recorded so it is not discovered later.** `buildRegisteredFamily()` derives H1 as `mean(panelArms) − referenceArm` from whatever arm set the caller supplies, rather than by naming specific arms as H2–H5 do. Invoked as `--panel-arms <the seven off-centre S1 arms> --reference-arm S1-C0`, it therefore returns H1 as an *estimable* contrast — the mean of N=10, N=60, `low`, `max`, two stances and `direct`, tested against the centre point — which is not the registered panel-versus-solo comparison but an arbitrary average wearing its name, complete with a Holm slot and a p-value. Verified directly: under that invocation H2–H5 each return `notEstimable: true` naming their missing arms, and H1 alone does not. **Stage 1a's analysis therefore does not build the registered family at all.** It reports each off-centre condition against the centre point as an estimate with a confidence interval, and the Holm family is not entered — which is what Item 7's "no hypothesis tests" means operationally, not merely as an intention. This is the same hazard `contrasts.mjs`'s own "ARM SUBSETS AND THE REGISTERED FAMILY" header warns about for re-pairing — answering a different question under a pre-registered hypothesis's name — reached through a parameterized contrast rather than a substituted arm.

**The primary response is rarefied `distinct_k`**, per Appendix C item 3's registered treatment — mandatory here rather than merely preferred, because N is an experimental factor and raw `distinct_k` across different N is a comparison of pool sizes. The reference condition for contrasts is the centre point `S1-C0`, not arm A. Raw `distinct_k` and the `distinct_k`-vs-N curve are **also** reported, per Appendix C item 5's both-values rule.

**A measured caveat on the dose-response curve.** The pool a call returns is not the N it was asked for: the probe in Item 6 observed 85 ideas returned for N=60 and 61 for another N=60 call, 40 for an N=30 call, and 31 for another N=30. The curve `#130` calls "the deliverable" is therefore a curve against *requested* N, whose realized pool sizes vary — which is precisely why the rarefied response, not the raw one, carries the comparison.

**One further observed risk, recorded before the run rather than discovered in the results.** One of the six `N=60` probe replies failed a direct `JSON.parse` and lost 14 of its objects to `salvageCandidateArray`, ending on `end_turn` — malformation, not truncation, and so not fixable by the cap Item 6 raises. This is `#93`'s cause 2 at a higher rate than the smaller-N conditions showed (1 of 6 at N=60; 0 of 14 elsewhere). If `S1-N60`'s realized pools come in systematically short, malformation at large N is the first thing to check, and it is a property of the arm rather than of the night.

### Item 8 — §11/§8.3: Stage 1a collects into a separate store

**What is registered.** Stage 1a runs with `--results-dir results-study1`, keeping its cells out of `results/`. This is Appendix D item 3's store-separation mechanism, applied for the reason that item registered it: the studies' configurations will keep moving independently, and one shared store makes every Study 1 config edit stale Studies 2–4's cells and vice versa. §11's additive-accumulation and non-reuse rules apply within the Stage 1a store exactly as they do within `results/`.

### Item 9 — cost of this amendment: two hash moves, and what was already stale

**`promptTemplateHash()` moves twice** — once for Item 1's CoT branch (`0fb497a4a61d` → `b529182bea28`) and once for Item 6's sizing constants, which are inputs to the same hash. `configHash` moves with it, so every stored cell is `stale`.

**Nothing further is lost.** Appendix E item 8 already accounted for the 16 completed arm-B pilot cells, staled by `#134`'s engine-pin bump and again by arm AS's `armsConfigHash` move. A cell invalidated then cannot be invalidated again for a larger loss, and no cells have been collected since. Registering the Study 1 arms (Item 2) moves `armsConfigHash` a third time, with the same nil incremental cost.

**Ordering note, stated rather than smoothed over.** Item 1's code landed in `#142` (`296bbae`) before this appendix was written. The rule that matters is that **no data was collected under the unregistered design** — no run has executed since `#142` merged, and the 20 calls in Item 6 were a sizing probe whose results go nowhere near the results store. The registration is in place before the first Stage 1a cell, which is the guarantee §11 exists to give.

---

## Appendix G — Amendments (dated 2026-09-08)

Per the amendment rule at the top of this document. Appendix E item 7 registered `σ²_ba = 77.85` as **provisional** and bound its B = 48 / R = 2 table to "Study 1's re-estimate of `σ²_ba`." Study 1, Stage 1a has now run (191 of 192 cells completed; raw records at `data/study1-stage1a/cells.jsonl`, per-cell metrics at `docs/study1-stage1a-cells.csv`). **This appendix is that re-estimate, and the table it supersedes.**

It registers the recomputed design **before any run sized by it**. No cells have been collected since Stage 1a. **Nothing in §6 (hypotheses and analysis plan) is changed by any entry below** — this is a design-size amendment to §3.4, not an analysis-plan change.

### Item 1 — §3.4: the variance components, re-estimated from 12 briefs

**What's registered.** The R0 fit (`evals/analysis/sidecar/fit_mixedlm.py`, `referenceArm: "S1-C0"`, response `distinct_k`), run over the **matched-N=30 subset** of Stage 1a: the six arms whose `totalIdeasRequested` is 30 (`S1-C0`, `S1-ELOW`, `S1-EMAX`, `S1-SPRAG`, `S1-SCONTRA`, `S1-DIRECT`) × 12 briefs × 2 replicates = **144 cells, complete and balanced** — Stage 1a's single failed cell was `S1-N10`, outside this subset, so no cell is missing from it. Converged.

| Component                                     | Registered (Appendix E item 7) | **Stage 1a, matched N=30 (n = 144)** | Stage 1a, pooled across N (n = 191) |
| --------------------------------------------- | ------------------------------ | ------------------------------------ | ----------------------------------- |
| `brief:arm` (`σ²_ba`)                         | 77.85                          | **1.2088**                           | 2.4885                              |
| `brief`                                       | 21.99                          | **4.9786**                           | 5.5447                              |
| Pooled within-(arm × brief) residual (`σ²_e`) | 6.82 (sd 2.61)                 | **5.1181** (sd 2.262, df 72)         | 4.5421 (sd 2.131, df 95)            |

`σ²_ba` is smaller than the registered figure by a factor of **64**. Appendix E item 7 called 77.85 "the least stable number in the study," estimated from two briefs; that judgement is now measured rather than suspected.

**The matched-N=30 fit is the registered basis, and the reason is a property of the response, not a preference.** `distinct_k` is a count, and the variance of a count scales with the count — the same principle Appendix E item 6 already registered when it ruled that a 30-pool arm's variance does not transfer to a 60-pool arm. Stage 1a measures it directly: the pooled within-cell residual is **0.50** at `S1-N10`, **2.46** at the N=30 centre point and **4.79** at `S1-N60`, and raw `distinct_k` sd across all cells of an arm runs 1.53 / 2.81 / 5.40 across the same three. Fitting one model across all three pool sizes forces a single residual and a single interaction term to absorb that heteroscedasticity, and the interaction is where it lands: **2.49 pooled versus 1.21 matched**. That inflation is very likely the mechanism behind 77.85 itself — the Phase 2a smoke pooled arm A (~30 ideas, `maxRounds: 1`) with arm B (~60 ideas, `maxRounds: 2`), exactly the mixed-pool-size fit this item declines to use. Both fits are recorded above; only the matched one is the basis.

### Item 2 — §3.4: the re-derived SE table, on the same formula

**The formula is unchanged.** Appendix E item 7 registered a method, not just a table; the standard error of a two-arm contrast under the R0 model is

```
SE(B, R) = sqrt( 2 · ( σ²_ba / B  +  σ²_e / (B · R) ) )
```

for B briefs and R replicates per (arm × brief).

**Two verification checks, both passed — this is what makes the supersession auditable rather than asserted.**

1. **The formula reproduces the superseded table.** Fed the registered components (77.85, 6.82), it returns all sixteen cells of Appendix E item 7's table to the two decimals that table prints — 5.31/5.20/5.17/5.14, 3.76/3.68/3.65/3.63, 2.66/2.60/2.58/2.57, 1.88/1.84/1.83/1.82. The formula being applied here is therefore the one already registered, not a new one wearing its name.
2. **The formula reproduces Stage 1a's own achieved SE.** At B = 12, R = 2 the new components give **0.7925**, and the matched fit's `vcov` reports the off-centre arm contrasts' standard error as **0.7925**. The design-size arithmetic and the fitted model agree to four decimals on the one design actually executed.

**The registered table**, on `σ²_ba = 1.2088` and `σ²_e = 5.1181`:

| B (briefs) | R=1  | R=2  | R=3  | R=5  |
| ---------- | ---- | ---- | ---- | ---- |
| 6          | 1.45 | 1.12 | 0.99 | 0.86 |
| 12         | 1.03 | 0.79 | 0.70 | 0.61 |
| 24         | 0.73 | 0.56 | 0.49 | 0.43 |
| 48         | 0.51 | 0.40 | 0.35 | 0.30 |

**Registered design: B = 24 briefs, R = 2 replicates.** SE 0.56; the corresponding MDE at 80% power and α = 0.05 two-sided (multiplier ≈ 2.8) is **1.57 distinct ideas**, against the **5.15** the superseded B = 48 / R = 2 row predicted. The MDE is **reported, not targeted** — §3.4 has never registered an MDE floor, and inventing one here to justify a design would be the move §5.1 explicitly refuses when it sets the judge gate to the human-human figure "rather than to a number we like."

**What actually pins B and R, now that power does not.** At these components every design in the table above is far inside the effect sizes this study is about, so the binding constraints are the other two:

- **B = 24 is a coverage decision.** Appendix F item 3 registered the 12-brief Stage 1a subset with an exact 6-pre-amendment / 6-post-amendment split, for the stated reason that a composition-biased subset propagates through everything downstream. Sizing B on SE alone re-opens precisely that. B = 24 is **6 briefs per stratum, 12 pre-amendment and 12 post-amendment**, balanced by the same rule — the smallest brief count that gives every stratum a within-stratum estimate rather than a pair of draws, on a 48-brief corpus, at half the cell count of the superseded B = 48.
- **R = 2 is an estimability decision.** R = 1 is the cheaper design and, per Item 3 below, the cost-optimal one; it is rejected because at R = 1 `σ²_e` and `σ²_ba` are confounded and **this table could never be re-derived again**. Appendix E item 7 made 77.85 provisional precisely so a variance estimate could be re-measured rather than inherited; a design that cannot re-measure its own components forfeits that. R = 2 is the minimum that keeps the re-estimation path open, and it is chosen for that, not by inertia from the superseded row.

**Multiplicity is not in these numbers, deliberately.** The table applies the same SE formula §3.4 registers, whose MDE multiplier (≈ 2.8) is uncorrected. §6's Holm family over H1–H5 moves the effective multiplier to roughly 3.4, scaling every MDE above by about 1.2×. That is stated here in prose rather than folded into the table, because baking it in would quietly re-register the formula under cover of a re-estimate.

**Cost.** Relative to B = 48 / R = 2, the confirmatory grid halves. §8's ledger is not restated here — `#143` has the model-price row wrong for `claude-sonnet-5` ($3/$15 per MTok applied against a first-party $2/$10), so a re-priced budget belongs in that fix, not in a variance amendment.

### Item 3 — §3.4: what inverted, and what did not

**Recorded because the obvious reading of Item 1 is wrong and expensive.** Appendix E item 7's stated rationale was that "the interaction dominates the residual by more than 10×, so briefs buy far more power than replicates." The first clause no longer holds: `σ²_e` (5.12) now exceeds `σ²_ba` (1.21) by about 4×, the reverse ordering. Replicates are consequently no longer inert **at fixed B** — at B = 12, going R = 1 → 2 moves SE from 1.03 to 0.79 (a 23% reduction), where under the superseded components the same step moved 3.76 → 3.68 (2%).

**The design principle nevertheless did not invert.** At a fixed total cell budget C = B · R, substituting B = C/R gives

```
SE² = (2/C) · ( R · σ²_ba  +  σ²_e )
```

which is increasing in R for any positive `σ²_ba`. **Per cell spent, briefs win at every ratio, and did so under the registered components too.** The second clause of item 7's rationale therefore survives its first. A reader who takes "replicates now buy real power" as licence to spend budget on R rather than B builds a design strictly worse than the one being superseded here, and this item exists so that reading is closed off in the registration rather than discovered in a run.

### Item 4 — §3.4: the scope bound on this basis, stated so it is not transferred

**This table is registered for contrasts whose rarefaction target is a ~30-idea pool, and for no others.** Appendix C's rarefaction rule applies per contrast at the minimum pool size on the two sides, which for the registered arm-A-versus-panel contrast is ~30 — the scale the matched-N=30 basis is estimated at, which is what makes it the right basis for the design §3.4 sizes today.

**It is not the right basis for a ~60-pool contrast.** Stage 1a measures the gap in the same run: within-cell residual **2.46** at N=30 against **4.79** at `S1-N60`. A contrast rarefied at ~60 sized on the components above would understate `σ²_e` by roughly 2× and SE by roughly 1.4×, and would under-power itself by exactly the mechanism Item 1 attributes 77.85 to. **Any design whose rarefaction target is not ~30 requires its own variance basis, estimated at that pool size, registered as its own dated amendment.**

This is stated explicitly because the transfer is the failure mode this appendix exists to correct. 77.85 became binding on a whole replication plan by being carried from the design that produced it to designs that did not share its scale; 1.21 is a better number and would fail in exactly the same way if carried the same distance.

### Item 5 — reproduction

**The script that produced every number above is committed**: `evals/analysis/variance-components.mjs`. Run `node evals/analysis/variance-components.mjs --all-arms` to reproduce both fits, the residual, the achieved SE and item 2's table from the committed CSV. This is deliberate rather than incidental — the figure this appendix supersedes was "reported, not verified against a committed artifact in this repo," transcribed from an issue body and never independently re-run, which is exactly how a two-brief estimate became binding on an entire replication plan. A number that replaces it on those grounds ships with its derivation, not with a prose description of a derivation someone else would have to reimplement. The registered arm set and reference arm are named as constants in that file rather than derived from `arms.config.json`, so a later arm edit cannot silently change which cells reproduce a registered number.

**What it runs**, stated here too so the appendix stands on its own:

- Inputs: `docs/study1-stage1a-cells.csv`, rows with `state == "completed"`; response `y = distinct_k`; the matched subset is the six arms named in Item 1.
- Fit: `evals/analysis/sidecar/.venv/bin/python evals/analysis/sidecar/fit_mixedlm.py`, rung `R0`, `referenceArm: "S1-C0"`, `armLevels` the fitted arm set. `varianceComponents` gives `brief` and `brief:arm`; the diagonal of `vcov` gives the achieved contrast SE.
- `σ²_e` is **not** a sidecar output and is not read from one: it is the pooled within-(arm × brief) variance across replicate pairs — Σ(y − cell mean)² / Σ(cell n − 1) — computed directly from the same rows, which is the quantity Appendix E item 7's own "pooled within-(arm × brief) residual variance" line names. df 72 over 72 complete replicate pairs for the matched subset; df 95 over 95 for the pooled one.

**No judge score enters anything above.** Appendix F item 7 holds Stage 1a's judge rows as stored data awaiting §5.1's gate; the response fitted here is `distinct_k`, a pool-level metric, throughout.

---

## Appendix H — Amendments (dated 2026-09-08)

Raised as `#143` while pricing Stage 1a by hand. §8.1's Anthropic rates were never verified first-party — they were transcribed from a cached model table dated 2026-06-24 — and one of the four rows was wrong in the direction that matters most, on the model the study uses most. This appendix records the verification, the correction, and what the correction does and does not move.

This is a **re-price, not a re-collection.** §7's cost contract records tokens × model × timestamp × billing regime and never a derived dollar figure, and pricing is applied at read time from the dated table. No collected cell is invalidated and nothing is re-run; this is the change that contract exists to absorb.

### Item 1 — §8.1: the Anthropic rates, verified first-party

Checked 2026-09-08 against `platform.claude.com/docs/en/about-claude/pricing` (the model-pricing table) and `.../models/overview` (the model-comparison table). The check is recorded in code as `ANTHROPIC_PRICE_VERIFICATION` in `lib/price.mjs`, alongside the `OPENAI_PRICE_VERIFICATION` record Appendix A item 5 established the precedent for, so it travels with the table it backs.

| Model | §8.1 as registered | **Verified 2026-09-08** | Moves? |
|---|---|---|---|
| Claude Opus 5 | 5.00 / 25.00 | **5.00 / 25.00** | no |
| Claude Sonnet 5 | 3.00 (2.00 intro → 2026-08-31) / 15.00 (10.00 intro) | **2.00 / 10.00**, flat | **yes — −33% on every Sonnet dollar** |
| Claude Haiku 4.5 | 1.00 / 5.00 | **1.00 / 5.00** | no |
| Claude Sonnet 4.6 (judge roster, not in §8.1's table) | 3.00 / 15.00 | **3.00 / 15.00** | no |

The three unchanged rows are recorded as **checked and correct**, not merely left alone: `#143` item 2 asks for exactly that, because the whole table shared one provenance and one date, and "only the row someone happened to notice" is not a verification. The Batch API discount is confirmed on the same page at 50% on both input and output, unchanged.

**One row is still second-hand.** `voyage-4-lite` (0.02 / —) is a Voyage AI product priced on a different vendor's page and is outside this check; it keeps its 2026-06-24 cached provenance and is named as `notCovered` in the verification record rather than quietly implied to have been checked.

### Item 2 — §8.1: the introductory regime is removed rather than kept as history

`#143` item 3 proposed keeping the expired `introUntil` / `introRate` pair on the Sonnet 5 row as history, on the principle that a cell collected during an introductory window must still price at the rate that actually billed it. **That principle is right and this is not a case of it.** The pricing page's own note records that the $2/$10 launch pricing, announced as introductory through 2026-08-31, is now the standard price, and that the scheduled 2026-09-01 increase to $3/$15 will not occur.

So Sonnet 5 has billed at $2/$10 for its entire life. The registered row described a **rate change that never happened**; keeping the regime would preserve a fiction, and removing it reprices no historical row, because both sides of that boundary were always $2/$10.

The dated-regime machinery itself is retained in `lib/price.mjs` (`resolveBaseRate`) and in the fold's straddle guard, because the first genuine vendor rate change puts a regime back on a row and §7's read-time pricing is built on being able to represent one. No live row carries one today, so those guards are now exercised against an injected fixture table rather than the live one.

### Item 3 — §7/§4.1: what the correction moves

**Stage 1a's ledger, repriced from the same stored rows:**

| | As reported 2026-09-08 | **Repriced** |
|---|---|---|
| Anthropic | $14.4655 | **$10.5630** |
| OpenAI | $5.2238 | $5.2238 (unchanged) |
| Excluded (embedder) | $0.0034 | $0.0034 |
| **Total** | **$19.6927** | **$15.7902** |

Every Stage 1a cost row is timestamped 2026-09-08 — after the former boundary — so every one of them priced at the overstated $3/$15. The arithmetic is one fact stated three ways, and it is worth stating precisely because two of the three readings are easy to write down wrong: the rate was **50% too high**, the dollar figure falls by **33% on the Sonnet share** (19.8% of this run's total, the rest being Haiku and OpenAI), and `distinct_k` **per dollar** — §4.1's headline metric and the README's leading claim — rises by **1.5× on a Sonnet-only figure**, 1.25× on this run's total.

**Arm rankings on the cost/diversity Pareto frontier move non-uniformly**, since Sonnet appears at different weights across the registered arms; the error is not a constant offset and cannot be divided out of a published ranking after the fact.

**`--max-spend` pre-flight projections over-projected**, which is the safe direction — a run refuses earlier than it needs to, never later — and is why this was not a blocker for Stage 1a. `evals/harness/runner.mjs`'s coarse `INTERIM_RATES_USD_PER_MTOK` estimator mirrored the same stale figure and is corrected in the same change. **§8.2's projection table is not restated here**: it prices the original A–H grid, whose design Appendix F and Appendix G have already superseded, and re-deriving it would register a budget for a run this study is no longer planning. Any future run's cost note is derived at the corrected rates from that run's own registered design.

### Item 4 — the provenance failure, named

A dated pin makes staleness **detectable**; nothing in this repo **detected** it. The row carried an honest source and an honest date and was simply wrong for ten weeks, surfacing only because a run happened to be priced by hand. That is the same second-hand-source shape Appendix A item 5 corrected once already for the OpenAI rows.

What this amendment adds is narrower than a fix for that: the rates are now first-party with the check recorded in code, and a test holds the table and its verification record to each other, so a half-applied correction fails loudly. **It does not detect a vendor-side change** — nothing offline can. §8.1's rates are hereby registered as requiring **re-verification against the vendor's own page, with the date recorded, before any run that reports a dollar figure**, rather than being trusted to age quietly.

---

## Appendix I — Amendments (dated 2026-09-08)

**Study 1, Stage 1b: the panel benchmark.** Registered here in full, before its first cell.

> _Amended 2026-09-09 by Appendix J: this design ran (`docs/status-2026-09-09.md`) under a `max_tokens` ceiling too low for its panel arms, and is re-collected at B=48, R=3. The arms, the contrast family and the null clause below are unchanged; the ceiling, the size and the variance basis are amended there._

Stage 1a established a **denominator, not a comparison**. Only pool size moved `distinct_k` — rarefied to a matched pool of 30, N=30 and N=60 were indistinguishable (26.58 vs 26.45), and effort, stance and chain-of-thought each had a confidence interval containing zero. And **every Stage 1a condition was a solo call: no panel has ever run in this study.** One solo call at N=60 yields ≈ **49.4** distinct ideas. A panel produces a ~60-idea pool from **five agents over two rounds**. Whether the panel clears 49.4 is the question this study exists to answer, and it is untested.

Stage 1b answers it, and nothing else. It is deliberately not `#131` (model comparison) and not `#132`'s four-factor process design: ranking models through machinery that has never been shown to do anything ranks a difference we have no evidence exists, and a factorial over panel size, stance, sharing and rounds prices a design whose simplest cell is still unrun. Both become worth their cost once this run reports.

> Consequence for the issue graph: `#131`'s "blocked by Study 1" now means **blocked until Stage 1b**, not Stage 1a.

### Item 1 — §3.1: three Stage 1b arms

| Arm | Configuration | Purpose |
| --- | --- | --- |
| **`S1B-SOLO60`** | Solo, `totalIdeasRequested: 60`, `claude-sonnet-5`, `effort: high`, neutral persona (`solo_b`) | The benchmark. Configured identically to `S1-N60`. |
| **`S1B-PANEL`** | Panel, 5 agents × `ideasPerAgent: 6` × `maxRounds: 2` (blind → pool), every slot `claude-sonnet-5`, **differentiated** personas | The first panel this study has run. Pool ~60, matched to the solo arm by construction. |
| **`S1B-APRIME`** | Same panel geometry and model, `personaDisabled: true` under one explicit neutral persona | Arm A′'s construction at Stage 1b's model. Separates "the personas did it" from "we sampled five times". |

**Model is held constant at `claude-sonnet-5` across all three arms**, so the contrast is process and not model. That is the whole reason `#131` is not this run: a model comparison inside an unvalidated panel confounds the two.

**`S1B-APRIME` is not optional.** Without it, a panel-beats-solo result cannot distinguish the product's persona claim from the effect of issuing five requests instead of one — and Stage 1a's own finding that a stance barely changes what *one* agent produces weakens the prior for the persona claim without testing it. Three arms is the minimum design that answers the question asked.

**Cost of this amendment: `armsConfigHash` moves, and every existing cell goes stale.** Verified rather than assumed — `armsConfigHash` hashes the whole `arms.config.json` (Appendix D item 1's registered rule), and adding these three arms moves it from `ea1849cd1ac8` to `0c05795c6b00`, which moves `configHash` and therefore every cell key. **`S1-N60`'s 24 cells are not reusable**, which is why `S1B-SOLO60` re-collects that condition rather than citing it: panel-versus-solo is then a within-run contrast under one hash, not a comparison across two.

**Appendix G's derivation is unaffected.** `evals/analysis/variance-components.mjs` reads the committed CSV and names its arms as constants precisely so a config edit cannot move a registered number; a stale store does not restale a published figure.

### Item 2 — §3.2: the 24-brief subset, and the rule

> _Amended 2026-09-09 by Appendix J item 4: retired. The re-run uses all 48 briefs, so there is no subset rule left to justify._

**B = 24: six per stratum, `-01`, `-02`, `-03`, `-07`, `-08`, `-09`.**

| Stratum | Briefs |
| --- | --- |
| business | `biz-01`, `biz-02`, `biz-03`, `biz-07`, `biz-08`, `biz-09` |
| product | `prod-01`, `prod-02`, `prod-03`, `prod-07`, `prod-08`, `prod-09` |
| scientific | `sci-01`, `sci-02`, `sci-03`, `sci-07`, `sci-08`, `sci-09` |
| aut | `aut-01`, `aut-02`, `aut-03`, `aut-07`, `aut-08`, `aut-09` |

The rule is **the first three ids from each half of each stratum** — `-01..-06` being the pre-amendment 24 and `-07..-12` the 24 added by `#129` (Appendix E item 5). It carries forward Appendix F item 3's reasoning without restating it: a subset drawn 92% from one half of the corpus would inherit that half's composition. It is deterministic, reproducible by inspection, needs no RNG, contains `prod-07` (Appendix E item 4's externally-published anchor), and **contains Stage 1a's twelve briefs exactly**, so Stage 1a's per-brief results are directly comparable on the overlapping half.

**R = 2 replicates. 3 arms × 24 briefs × 2 = 144 cells.**

### Item 3 — §3.4: the ~60-pool variance basis

> _Amended 2026-09-09 by Appendix J item 5: superseded. `σ²_ba` no longer has to be transported — this run measured it directly at the ~60 scale across three arms, at **7.8266**, which is 3.3× the 2.3562 assumed below. The assumption was wrong in the direction that flattered the design._

Appendix G item 4 registered that its table is valid for contrasts rarefied at a ~30-idea pool **and for no others**, and required any design at another scale to register its own basis. Stage 1b's contrasts rarefy at ~60. This is that basis.

**The SE formula is unchanged** — §3.4's, as Appendix G item 2 re-derives it:

```
SE(B, R) = sqrt( 2 · ( σ²_ba / B  +  σ²_e / (B · R) ) )
```

**One of its two inputs is measured and the other is assumed.** That distinction is the most important line in this appendix:

| Quantity | Value at ~60 | Status |
| --- | --- | --- |
| `σ²_e` | **4.7917** (sd 2.189, df 12) | **MEASURED**, directly at `S1-N60`. No scaling. |
| `σ²_ba` | **2.3562** | **TRANSPORTED** from the matched-N=30 fit's 1.2088 by a ratio of 1.9492. A registered assumption. |

`σ²_ba` is **not estimable at this pool size from Stage 1a**: a `brief:arm` interaction needs two or more arms at the scale in question, and Stage 1a ran exactly one (`S1-N60`). No amount of care recovers it from data that cannot contain it, so it is registered as an assumption and labelled as one wherever it appears.

**Why the ratio is `S1-N60` ÷ `S1-C0` and not ÷ the pooled matched residual.** Those two arms differ in pool size and in nothing else — same model, effort, stance, strategy, briefs, replicates — with df 12 each. The pooled matched residual (5.1181) is dominated by `S1-SPRAG`, whose within-cell variance is **18.17**, roughly four times any other arm's. That is a *stance* effect on output stability at the *same* N, and it has no business in a pool-size scaling ratio. Using it as denominator gives a ratio of **0.936** — below one, for a quantity we are arguing grows with pool size. The contamination is the argument for the single-factor comparison, not merely a preference for it.

> Recorded, not reopened: the same `S1-SPRAG` contribution inflates Appendix G's own registered `σ²_e` of 5.1181, which makes that appendix's SE table **conservative**. Appendix G stands as registered.

**An independent mechanism predicts the same number.** `distinct_k` is a **count**, and if its variance tracks its mean the variance ratio should sit near the mean ratio. Mean `distinct_k` is 26.79 at the centre and 49.38 at `S1-N60` — a ratio of **1.843**, against a measured variance ratio of **1.949**. Appendix G item 1 already invokes count-variance scaling to explain the inflated pooled interaction term; here the same mechanism corroborates the transport by a second route. Two routes to ≈ 1.9 is materially better evidence than one empirical ratio.

**The assumption's precision, stated rather than implied.** A variance ratio on df 12 against df 12 is imprecise: the two-sided 95% interval is **0.595 to 6.387**. The sizing inherits that, and the appendix registers the ratio *with* its interval.

**SE at the ~60 basis:**

| B (briefs) | R=1 | R=2 | R=3 |
| --- | --- | --- | --- |
| 6 | 1.544 | 1.259 | 1.148 |
| 12 | 1.091 | 0.890 | 0.812 |
| **24** | 0.772 | **0.629** | 0.574 |
| 36 | 0.630 | 0.514 | 0.469 |
| 48 | 0.546 | 0.445 | 0.406 |

**The registered design is B = 24 / R = 2**, matching Appendix G item 2's recommendation: B on brief-coverage grounds (six per stratum, balanced across the corpus expansion), R = 2 on estimability grounds — at R = 1, `σ²_e` and `σ²_ba` are confounded and this table could never be re-derived from the run that used it.

**MDE = 1.94 distinct ideas**, at 80% power. That is the **Holm-adjusted** figure: two registered contrasts (item 4) means Holm's first step spends α = 0.025, a multiplier of 3.08 rather than the unadjusted 2.80 — quoting 1.76 would be quoting an MDE no test in this run will actually be read against.

**Sensitivity across the assumption's interval**, so the run is not sized on a point estimate presented as certain:

| Ratio | `σ²_ba` at ~60 | SE at B=24, R=2 | MDE (Holm) |
| --- | --- | --- | --- |
| 0.595 (lower) | 0.719 | 0.509 | **1.57** |
| 1.949 (point) | 2.356 | 0.629 | **1.94** |
| 6.387 (upper) | 7.721 | 0.918 | **2.83** |

The registered design's MDE is between 1.6 and 2.8 across the full interval. Item 5 turns on that range being small relative to what a positive result would have to be, so the imprecision does not undermine the design — but it is registered, not hidden.

### Item 4 — §6: Stage 1b's contrast family, and why H1–H5 is not built

**Two registered confirmatory contrasts, on rarefied `distinct_k`, brief as a random effect, Holm-Bonferroni at m = 2:**

| # | Contrast | What it settles |
| --- | --- | --- |
| **S1b-1** | `S1B-PANEL` − `S1B-SOLO60` | Does the panel beat one call at matched pool size? |
| **S1b-2** | `S1B-PANEL` − `S1B-APRIME` | Is any difference the personas, or is it sampling five times? |

Both two-sided at α = 0.05, Holm-corrected across the pair. `S1B-APRIME` − `S1B-SOLO60` is reported as an **exploratory** estimate with a confidence interval, BH-corrected alongside the other exploratory contrasts per §6.3 — it is the second arm of a decomposition whose two confirmatory halves are already registered, and promoting it would spend a third Holm slot to learn nothing the pair does not already carry.

**The registered H1–H5 family is NOT built for this run**, the same posture Appendix F item 7 took for Stage 1a. This needs saying plainly, because Stage 1b's primary contrast is unmistakably **H1's question**:

- H1 is registered as `mean(panel arms) − A`, where the panel arms are §3.1's `A′` and B–H — **eight different model configurations**. Stage 1b has one panel configuration and its ablation. Evaluating `mean(S1B-PANEL, S1B-APRIME) − S1B-SOLO60` under H1's name would substitute a differently-scoped quantity for the registered one: exactly the hazard `#145` names, one layer up from where it was found.
- H1's *form* is also wrong for this design, independent of registration. `S1B-APRIME` is the **ablation**: averaging it with the panel dilutes the effect the run exists to measure. If personas do nothing, panel ≈ A′ and the mean is harmless; if personas do everything, the mean halves the estimate. The two pairwise contrasts are the decisive ones and the mean of them is not.
- So H1 is recorded **not estimable** for Stage 1b, keeping its Holm slot at p = 1 if the family is ever built over this store, and Stage 1b's own two-contrast family is what is registered and reported.

`#145`'s guard is what makes that a fact about the code and not a promise: since it landed, H1's arm set is registered data (`REGISTERED_H1_ARM_SETS` in `evals/analysis/contrasts.mjs`) and its weights come from that set rather than from whatever arms a run happens to carry, so a Stage 1b store **cannot** produce an estimable H1 by accident. **No new key is added to that constant by this appendix**, deliberately: the mechanism exists so a future A–H-shaped run can extend the registration, not so that each run can rename its own contrast into H1's slot.

### Item 5 — §6: what a null result licenses, registered before the run

**The likely outcome of this run is no detectable difference, and that is a decisive result rather than a failed one.** Registering the interpretation now is the point of registering it at all — afterwards, a null reads as an underpowered non-answer.

The asymmetry that makes it decisive: at matched pool size, `S1B-PANEL` issues **5 agents × 2 rounds = 10 model calls** where `S1B-SOLO60` issues **one**. The panel is not asked to be better per idea; it is asked to be better at all, at ten times the requests.

So:

- **If S1b-1 is null**, the run bounds the panel's advantage below **1.94 distinct ideas** (1.6–2.8 across the assumption's interval) on a ~49-idea pool — under 4% — **at 10× the calls**. On §4.1's registered `distinct_k`-per-dollar metric the panel then loses outright, and that conclusion is licensed by this run without further data.
- **A null on S1b-1 also makes `#131` and `#132` cheaper questions, not urgent ones**: ranking models through the panel, or crossing four process factors over it, both presuppose the machinery does something. `#132`'s Stage 3a would then be re-scoped to ask whether *any* configuration of it clears the benchmark, rather than which configuration is best.
- **If S1b-1 is positive and S1b-2 is null**, the gain is sampling five times, not persona engineering — the cheapest reproduction of the product's benefit is repeated sampling, and that is a finding about the product, not about this harness.
- **If both are positive**, the persona lever is doing real work and `#132`'s factorial is the right next spend.

For comparison against the MDE: Stage 1a's rarefied N=30-versus-N=60 difference was **0.13**. This design cannot see effects of that size and is not meant to; it is sized to see whether ten calls beat one by an amount anyone would pay for.

### Item 6 — three limitations that belong in the registration, not in a footnote afterwards

**1. Panel arms are differentiated by stance and strategy only — never temperature.** §3.3 strips sampling parameters universally, and both request builders are allowlists that never send `temperature`. Shipped `ideate-core`'s `DEFAULT_PERSONAS` varies temperature across personas (0.4 / 0.9 / 0.6 / 1.0 / 1.0). **`S1B-PANEL` is therefore less differentiated than the product it measures**, and a null on S1b-2 is confounded with that. The strip is deliberate — it exists so H4's bias direction is not inverted — so this is a **stated limitation, not a thing to change**, and any report of a Stage 1b persona result states it.

**2. The persona ablation moves one slot's `strategy` as well as its stance, and the size of that is known.** `S1B-PANEL`'s five slots fall through to `DEFAULT_PERSONAS`, of which **four carry `strategy: "cot"` and one — `pragmatist` — carries `"direct"`**. `strategy` reaches the wire as a rendered prompt lever (Appendix F item 1): `"cot"` inserts the registered chain-of-thought paragraph and `"direct"` inserts nothing. `S1B-APRIME`'s uniform bundle is `"cot"` — chosen as the panel's own modal value rather than to make the arms match — so **one slot in five differs in strategy as well as in stance**, and S1b-2 is not a perfectly clean single-lever ablation.

This is registered rather than removed, because removing it is worse: pinning every `S1B-PANEL` slot to `"cot"` would make the panel *less* like the product it measures, and stance and strategy are bundled together in `DEFAULT_PERSONAS` exactly as they ship. **The confound's magnitude is already bounded by Stage 1a's own measurement**: `strategy: direct` versus `cot`, solo, moved `distinct_k` by **−0.58 [−2.14, 0.97]** — an effect indistinguishable from zero, here carried by one agent of five. It is registered so a Stage 1b result is read against a stated bound rather than an unstated assumption.

**3. §5.1's judge-validation gate has never run** (`#16`). Every idea-level metric therefore stays exploratory and unreportable per Appendix B item 11, and Stage 1b's primary response is **rarefied `distinct_k`** per Appendix C item 3, exactly as Stage 1a's was. Judge rows collected during Stage 1b are stored data awaiting that gate, not results.

### Item 7 — §8: cost, at the corrected rates

> _Amended 2026-09-09 by Appendix J item 6: superseded for the re-run (432 cells, projection $55.04, ceiling `--max-spend 90`). The realized cost of the run registered here — **$15.3969** against this projection's $18.35 — is what calibrates the estimator's 1.19× over-projection factor there._

Priced at Appendix H's corrected `claude-sonnet-5` rate ($2/$10 per MTok), for the registered 144 cells:

| | Batch | No-batch |
| --- | --- | --- |
| Harness pre-flight projection (`--dry-run`) | **$18.35** | $36.69 |

That is `interimPriceGrid`'s coarse estimator, which prices a *plan* from §8.2's assumed ~16k in / 9k out per run. Stage 1a's realized per-cell costs are the better anchor and say the estimator **over-projects**: `S1-N60` actually cost **$0.0425** per cell un-batched against the estimator's $0.093, because the realized token shape was ~365 in / ~4,000 out, not 16k/9k. Anchored on those realized figures, generation should land near **$5–6 batched**, with judging (two judges per cell, unbatched, ~$0.021 per judge call at Stage 1a's realized rate, scaling with pool size) adding roughly **$6–9**, and embeddings effectively free — so an expected **$12–$15** against a projection of $18.35.

Over-projection is the safe direction: `--max-spend` refuses earlier than it needs to, never later. **The registered ceiling is `--max-spend 45`**, the same as Stage 1a's, which clears both the projection and the expected actual with room for re-runs.

**This run uses batch mode.** Stage 1a forfeited the 50% batch discount by running `--no-batch`, because the harness submitted one Message Batch per cell and serialized 192 queue waits (`#148`). That is fixed, so the discount is available and the projection above assumes it. Concurrency starts at `--cell-concurrency 4` to `8` and no higher: judging and metric computation run inside the per-cell task, so concurrency K puts up to K embedder calls and 2K unbatched judge calls in flight. Nothing is lost if they throttle — `rate_limited` is transient and the cell re-plans — but the run can thrash.

### Item 8 — reproduction

`node evals/analysis/variance-components.mjs --n60-scale` reproduces item 3 in full from the committed CSV: both measured residuals, the ratio and its interval, the mean-ratio corroboration, the transported `σ²_ba`, every arm's within-cell variance (so the choice of denominator is inspectable rather than asserted), the SE table and the sensitivity rows.

The arm names it uses are constants in that file rather than reads of `arms.config.json`, for the reason Appendix G item 5 gives: a registered number must not move when a config does. `N60_ARM` and `N30_CENTRE_ARM` join `MATCHED_N30_ARMS` on that footing.

The pre-flight cost figures in item 7 are reproduced by:

```
node evals/run.mjs --dry-run \
  --arms S1B-SOLO60,S1B-PANEL,S1B-APRIME \
  --briefs aut-01,aut-02,aut-03,aut-07,aut-08,aut-09,biz-01,biz-02,biz-03,biz-07,biz-08,biz-09,prod-01,prod-02,prod-03,prod-07,prod-08,prod-09,sci-01,sci-02,sci-03,sci-07,sci-08,sci-09 \
  --replicates 2
```

**No cell of this design has been collected.** This appendix is the registration, and it lands first.

---

## Appendix J — Amendments (dated 2026-09-09)

**Study 1, Stage 1b is re-collected.** Appendix I's run completed (141/144 cells, `docs/status-2026-09-09.md`) under a `max_tokens` ceiling that was too low for the panel arms. This appendix registers the corrected ceiling, the re-sized design, and the residual the correction does *not* fix — before any cell of the re-run is collected.

Appendix I is **not withdrawn**. Its design, its arms, its contrast family and its "what a null licenses" clause all stand unchanged. What changes here is the request ceiling (item 1), the design's size (item 4), the basis that sizes it (item 5), and the rule for reading a rarefaction floor this design does not get to choose (item 8).

### Item 1 — §4: the sizing defect, measured

`maxTokensForIdeas` sized the panel arms' requests at `6 × 175 × 2.5 = 2625` output tokens. **19 of 45 `S1B-PANEL` cells returned pools short of the 60 the arm specifies, against 3 of 48 for `S1B-SOLO60` — the matched solo arm at the same nominal pool size.** The asymmetry is the finding: the shortfall is a property of the request *shape*, not of the pool size.

A live probe of that exact shape (49 replies, `claude-sonnet-5` effort `high`, `ideasPerAgent: 6`, rounds 1 and 2, briefs `sci-08`/`sci-09`/`biz-01`/`prod-07`/`aut-01`, 2026-09-09):

| bucket | n | output tokens | per-idea |
| --- | --- | --- | --- |
| round 1 / cot | 20 | 604–2631 | 100.7–438.5 |
| round 1 / direct | 5 | — | 129.7–207.8 |
| round 2 / cot | 19 | 1066–2749 | 245.3–458.2 |
| round 2 / direct | 5 | — | 177.7–391.8 |

**Two of 49 replies exceeded the 2625 cap.** ~4% per reply.

**The defect is the unit, not the number.** `ideas × rate` treats output as proportional to the ideas asked for; a reply has a fixed cost — framing, reasoning, the JSON scaffold — that does not shrink with the request. The probe shows this without appeal to any other probe: **at a fixed 6 ideas, round-1 output ran 604–2631 tokens, a 4.4× spread at constant idea count.** Idea count cannot explain a spread it is held constant across.

So the instrument is a per-**request** floor, not a larger per-idea rate. `MIN_REQUEST_MAX_TOKENS = ceil(2749 × 2.5) = 6873` — the top of the observed distribution times the existing `MAX_TOKENS_HEADROOM`, the same convention every rate in `prompts.mjs` already uses. No new multiplier is introduced. An inflated *rate* would reach the same 6-idea ceiling and silently re-size the 30- and 60-idea solo calls, where the unit is sound and which are this study's comparator (`#160`, merged as `ce7a06e`).

What the evidence does **not** support: that `sci-08` and `sci-09` are special briefs. `biz-01` topped out at 2596, within 6% of `sci-09`'s maximum. The supportable claim is the weaker and sufficient one — **several briefs ride the cap and two crossed it.**

### Item 2 — §3.1: why a 4% per-reply rate cost 42% of the panel's cells

A solo cell is **one** call. A 5-slot, 2-round panel cell is **ten**. A per-reply failure rate `p` therefore reaches a panel cell at `1 − (1−p)¹⁰`: 4% per reply becomes **~34% per cell**, against the ~42% short-pool rate observed.

This is registered as a structural property of any multi-agent arm, not as a tuning note about this one run. **A panel's exposure to any per-reply failure is an order of magnitude greater than a solo arm's, by construction.** Two consequences follow, and both are registered rather than left to be rediscovered:

1. Sizing rules for panel arms must be conservative in a way solo arms never needed. "Over-sizing is free" (`max_tokens` is a ceiling billed as generated) is not merely a convenience here — it is the only reason a 10× exposure is affordable.
2. It scales with panel size. `#132`'s factorial varies exactly that parameter, so this multiplier is an input to its design, not a footnote of this one.

### Item 3 — §5: the format-failure residual, measured and registered as a baseline

**The corrected ceiling does not fix every reply-level failure, and this appendix refuses to let the next run's losses be read as truncation returning.**

The same 49-reply probe recorded **two replies that stopped on `stop_reason: "end_turn"` and still yielded nothing usable**: one unparseable at 2032 tokens, and one that returned a single idea at 2311 tokens. The model finished; the output was malformed or degenerate. **~4% per reply, unaffected by any ceiling.** This is the same failure mode as Stage 1a's single loss and as `#93` cause 2 (which is why `salvageCandidateArray` exists).

Registered consequences:

- **The re-run's expected format-failure rate is ~4% per reply.** A residual at or below that rate is the baseline behaving as measured, not a new defect.
- The degenerate 1-idea reply is excluded from the per-idea denominator in item 1. Including it would have reported a rate of 2311/idea and set the ceiling from an artefact rather than from output length. **It is a format failure wearing a truncation costume, and it must not size anything.**
- **Its blast radius is bounded, and this was checked rather than assumed.** `classifyUndersizedPool` (`evals/harness/provider.mjs`) counts a reply as non-contributing only when `d.candidateCount === 0`, so a *partially salvaged* truncation never triggers `#102`'s undersized-pool discard. That matches the run: 141 of 144 cells **completed**. Truncation degraded pool size; it did not destroy cells. A format failure that yields zero candidates *does* trigger the discard, which is why its rate is registered here as a number to check the re-run against.

### Item 4 — §3.2: B = 48, R = 3

**All 48 briefs, three replicates. 3 arms × 48 briefs × 3 = 432 cells.**

Appendix I item 2's 24-brief subset rule is **retired, not amended**: at B = 48 the design uses the entire corpus, so there is no selection rule left to justify and no composition question to answer. Stage 1a's twelve briefs remain contained, trivially.

Why the size moves at all is item 5. What it costs is item 6.

### Item 5 — §3.4: the basis is now ACHIEVED, not transported — the one thing the failed run bought

Appendix I item 3 had to *transport* `σ²_ba` from a matched-N=30 fit by a ratio of 1.9492, and registered that as an assumption in as many words. **That is no longer necessary.** Appendix I's run fitted both components directly at the ~60 scale, across three arms — which is exactly the condition Stage 1a could not satisfy (only one arm ran at N=60, and a `brief:arm` interaction needs two or more).

| Quantity | Appendix I (registered) | Appendix I (achieved) | Status now |
| --- | --- | --- | --- |
| `σ²_ba` | 2.3562 (transported) | **7.8266** | **MEASURED**, three arms at the ~60 scale |
| `σ²_e` | 4.7917 | **3.6348** | **MEASURED**, rarefied |

The transported figure understated `σ²_ba` by 3.3×. That is the whole reason Appendix I's design was under-powered, and it is registered plainly rather than buried: **the assumption was wrong in the direction that flatters the design**, which is the direction an assumption is most dangerous in.

On §3.4's unchanged formula, `SE(B,R) = sqrt(2·(σ²_ba/B + σ²_e/(B·R)))`, with the achieved components:

| Design | cells | SE | MDE (Holm, m=2) | power vs. the −1.767 observed |
| --- | --- | --- | --- | --- |
| B=24, R=2 (Appendix I) | 144 | 0.897 | 2.761 | **39%** |
| B=48, R=2 | 288 | 0.634 | 1.952 | 71% |
| **B=48, R=3 (registered here)** | **432** | **0.614** | **1.890** | **74%** |

Repeating Appendix I's size would have had **39% power against the effect Appendix I's own run measured** — it would very likely have returned "unresolved" a second time, at full cost. B=48 restores the MDE Appendix I registered (1.94). R=3 is a deliberate purchase of the remaining margin; it buys little (`σ²_ba` dominates and only `B` divides it) and that is registered as known in advance, not discovered afterwards.

**A note on what the re-run's effect size may be.** The −1.767 above is contaminated in a known direction: `S1B-PANEL` truncated at 19/45 while `S1B-SOLO60` truncated at 3/48, so the panel was penalised and the contrast is a **lower bound** on panel performance. The re-run's point estimate may move toward zero or past it. Sizing against −1.767 is therefore sizing against the best available estimate, not a prediction — and this paragraph is here so that a smaller effect in the re-run is read as the correction working, not as a surprise.

The truncation also cost the analysis a second way, registered so it is not repeated: rarefaction takes the **minimum** pool present in a contrast (Appendix C item 2), so the panel's short pools dragged the common rarefaction floor from 60 down to **45 for every arm** — including the two that had not truncated. Item 8 registers how that floor is to be read for the re-run, before the re-run can determine it.

**A caveat on `σ²_e`, stated rather than left implicit in the table above.** The 3.6348 is the **rarefied-at-45** residual, measured under truncation. Two things follow, and neither is a reason to re-size, but both bear on how the table should be read:

- The corrected ceiling should *reduce* panel `σ²_e`, because truncation was itself injecting variance. If it does, `R = 3` buys even less than the 3 points the table credits it with — `R` divides only the `σ²_e/(B·R)` term, which is already the smaller of the two.
- The re-run rarefies at a higher floor (item 8), so its `σ²_e` is **not the same estimand** as the 3.6348 being used to size it. The transfer is an approximation, and it is the *second* input to this table that does not transfer cleanly — which is precisely the class of thing Appendix I item 3 got caught by.

`σ²_ba` — the term that actually decides the design, at 7.8266 against `σ²_e`'s 3.6348 — is the measured one and is unaffected by this. The design is sized on the term that dominates it; `R = 3` is registered as a deliberate purchase of margin whose marginal value may prove smaller than 3 points, and that is known here rather than discovered afterwards.

### Item 6 — §8: cost, and the hash consequence

**`promptTemplateHash()` moves `c6c2a60a4fe8` → `12b0a1a414c2`**, because `MIN_REQUEST_MAX_TOKENS` is a sizing constant and joins its payload — a change to it is a change to what was requested. That moves `configHash`, so **every Appendix I cell is stale and Stage 1b re-collects in full.** This is the same consequence Appendix F item 6 recorded for `#122`, and it is the intended one: the run being replaced is the one whose ceiling was wrong, and pooling cells across the two ceilings would be pooling two different experiments.

The re-run writes to a **fresh store, `results-study1b-r2/`**, rather than reusing `results-study1b/`. The stale check would have excluded the old cells correctly, but keeping the defective run intact and separately inspectable is worth more than the disk.

| | Batch | No-batch |
| --- | --- | --- |
| Harness pre-flight projection (`--dry-run`, 432 cells) | **$55.04** | $110.07 |

The estimator over-projects, and Appendix I's run now measures by how much: it projected $18.35 for 144 cells and the run cost **$15.3969** — a factor of 1.19. Applied here, expected actual is **~$46**, plus a small increase for the panel replies that will now run to completion instead of being cut (~4% of replies, each by a modest amount — so a few percent, not a quarter). Call it **$46–$52**.

**The registered ceiling is `--max-spend 90`**, which clears the projection and leaves room for a re-plan without a second registration.

`--cell-concurrency 4` to `8` and no higher, for Appendix I item 7's unchanged reason.

### Item 7 — what survives from Appendix I's run, and what does not

Registered before the re-run so that the re-run cannot be read selectively afterwards:

- **S1b-1 (`S1B-PANEL − S1B-SOLO60`) is re-collected, not superseded by fiat.** Its Appendix I value (−1.7672, Holm p 0.052) stands as what was measured under the defective ceiling. The re-run replaces it.
- **S1b-2 (`S1B-PANEL − S1B-APRIME`, +14.9052, p ≈ 0) survives directionally.** `S1B-PANEL` truncated more than `S1B-APRIME` (19/45 vs 6/48), so the defect penalised the arm the contrast favours: the true effect is at least this large. The re-run measures it cleanly, but a reversal is not a live possibility.
- **All five of H1–H5 remain NOT ESTIMABLE**, for `#145`'s reason — the registered panel arms `A′, B…H` are not in this arm set. That is unaffected by anything here and is not revisited.
- **Appendix I item 6's three limitations carry forward unchanged**, including that §5.1's judge gate has never run (`#16`), so idea-level metrics stay unreportable.

### Item 8 — §4.1: the rarefaction floor is data-determined, and here is the rule for reading it

**This item exists because the registration would otherwise be ambiguous about what number the run produces**, and the whole point of landing an appendix before collection is that this class of question is answered while no data exists to answer it with.

Appendix C item 2 rarefies every pool in a contrast to **the minimum pool size present**. That rule is unchanged and is not amended here: every rarefied figure this study has published — all of Stage 1a's — uses it, and pinning a fixed target for one run would make that run non-comparable with all of them. The consequence is that the re-run's rarefaction floor is **determined by its own worst cell**, not by design.

And item 3 registers that a ~4% per-reply format-failure residual survives the ceiling correction, so at least one panel cell landing short is expected, not exceptional. **The floor will therefore be below 60, and the design does not get to choose where.**

Registered before collection:

1. **The achieved rarefaction floor is reported alongside every contrast**, with the cell that set it identified by key. It is a result, not a parameter.
2. **A floor of 48 or above (80% of the design pool) makes the contrast primary as registered.** 48 is chosen so the re-run cannot be *worse* than the run it replaces — Appendix I's run achieved 45 — and so that the loss of a single agent's contribution from a single cell does not disqualify a design that expects exactly that at a ~4% rate.
3. **A floor below 48 is reported, not discarded, and is explicitly marked as not comparable to the registered target**, naming the cell responsible. It does not license a re-plan of that cell to raise the floor: re-planning the cell that sets the floor, *because* it sets the floor, would be selecting on the outcome.
4. The full-pool `distinct_k` remains the secondary descriptive it is under Appendix C item 5, and is reported whatever the floor does. It is the check that a low floor is a rarefaction artefact rather than a real collapse in pool quality.

### Item 9 — reproduction

```
node evals/run.mjs --dry-run \
  --arms S1B-SOLO60,S1B-PANEL,S1B-APRIME \
  --replicates 3
```

reproduces item 6's projection (432 todo, $55.0368 batched). The brief list is omitted because the design is the whole corpus.

The sizing constant and its derivation are pinned in `evals/harness/prompts.test.mjs` (`#160`): the floor must equal `ceil(2749 × MAX_TOKENS_HEADROOM)`, must bind at the panel shape, and must be inert at 30 and 60 ideas. Mutations that derive it from a mid-distribution reply, that drop the headroom, or that reach the same 6-idea ceiling through a per-idea *rate* bump instead all fail — the last of which is what makes item 1's floor-versus-rate argument a tested claim rather than a stated preference.

**No cell of the re-run has been collected.** This appendix is the registration, and it lands first.

> _Amended 2026-09-09 by Appendix K: the re-run drops batch mode. Item 6's ceiling rises to `--max-spend 120`. Nothing else in this appendix changes — batch mode is not a `CONFIG_FIELD`, so the estimand, the arms, the design and the analysis are all untouched._

---

## Appendix K — Amendments (dated 2026-09-09)

**The Stage 1b re-run drops batch mode.** Registered before its first cell, for the same reason Appendix J was: a spend ceiling and a transport choice are both registered parameters, and neither is changed in place.

### Item 1 — §8: what the Message Batches queue actually costs

Appendix I's run took **5.82 hours** of cell completions (141 cells, 02:03Z–07:52Z) — ~24 cells/hour. The store's timestamps say where that went: the median gap between consecutive completions was 69s, p90 400s, max 49 min, and **5.26 of the 5.82 hours sit inside gaps longer than two minutes.** The run was waiting, not computing. Batch polling is not the cause (`pollIntervalMs` is 2s); the Message Batches queue is.

A probe on 2026-09-09 submitted batches of **1, 6 and 30** requests at the same instant, at the re-run's real request shape (`claude-sonnet-5`, effort `high`, `ideasPerAgent: 6`, `max_tokens` 6873):

| submission | wait |
| --- | --- |
| batch of 1 | **20.9 min** |
| batch of 6 | **260.4 min** (4.3 h) |
| batch of 30 | **406.9 min** (6.8 h) — 29 of 30 succeeded, 1 errored |
| direct call, no batch | **12.8s**, **14.0s** |

> _Completed 2026-09-09. This table originally registered the size-6 and size-30 rows as "> 55 min, still `in_progress`", because the probe's own 45-minute ceiling expired before they ended. They were left running to completion and the true figures are above: **12x and 19x the size-1 wait**. The conclusion this appendix rests on is not merely supported but understated — batch latency scales hard with batch size, so coalescing more cells per batch is actively punitive, not neutral._

This is consistent with the four size-1 batches already recorded above `DEFAULT_MAX_POLL_MS` in `evals/harness/provider.mjs` (2m24s, 9m53s, 21m07s, one past 20m).

**Two caveats, stated because they bound what the table proves.** The probe did not cancel batches that hit its own 45-minute ceiling, so the size-6 and size-30 batches kept running and contended with a later trial; and two orphaned batches (31 requests) from an aborted smoke test were draining when these were submitted. **The absolute waits are therefore inflated by contention the probe itself created.** What contention does *not* explain is the ordering: all three batches entered the same queue at the same instant, and the size-1 batch finished while neither of the others had scheduled a single request.

**The consequence that decides this amendment:** batch wait **grows with batch size** rather than being amortized by it. So raising `--batch-window-ms` to coalesce more cells per batch — the lever `#148` built and the obvious first thing to try — buys no throughput. That was the hypothesis this probe was run to test, and it failed.

### Item 2 — what this changes, and what it provably does not

**Batch mode is not a `CONFIG_FIELD`** (`lib/manifest.mjs`). It is a transport and pricing choice: the same `params` object reaches the same model either way. So dropping it moves neither `configHash` nor any cell key, and **the estimand, the three arms, B=48/R=3, the contrast family, the rarefaction rule and every limitation registered in Appendix J are untouched.** Stage 1a ran `--no-batch` throughout; this returns the re-run to that footing.

What it changes is exactly two things:

| | Batch (Appendix J) | No-batch (registered here) |
| --- | --- | --- |
| Projected cost, 432 cells | $55.04 | **$110.07** |
| Expected actual (÷1.19 over-projection) | ~$46 | **~$92** |
| Expected wall clock | ~18 h | **~2 h** |

The 50% batch discount is real and is being given up deliberately. It is registered as a **priced trade, not an oversight**: ~$46 of additional spend to convert an 18-hour run into a 2-hour one, on a study whose last run needed re-collecting and may need it again.

### Item 3 — §8: the revised ceiling and the exact invocation

**`--max-spend 120`**, replacing Appendix J item 6's 90. It clears the $110.07 projection and leaves room for a re-plan without a third registration. `--cell-concurrency` stays within Appendix J's registered 4–8 band, for its unchanged reason: judging and metric computation run inside the per-cell task, so concurrency K puts K embedder calls and 2K unbatched judge calls in flight.

```
node evals/run.mjs \
  --arms S1B-SOLO60,S1B-PANEL,S1B-APRIME \
  --replicates 3 \
  --results-dir results-study1b-r2 \
  --no-batch --max-spend 120 --cell-concurrency 8
```

**No cell of the re-run has been collected.** This appendix lands first.

---

## Appendix L — Amendments (dated 2026-09-09)

**Study 1, Stage 1c: does a richly differentiated panel clear one call?** Registered in full, before its first cell.

Stage 1b (`docs/status-2026-09-09b.md`) found the panel **loses** to a single solo call at matched pool size — `S1b-1` = −2.1338, Holm p 0.0007. Attributing every cluster to the agent that produced it located the whole deficit precisely:

| Arm | merged clusters: **cross-agent** | within-one-agent | distinct_k |
| --- | --- | --- | --- |
| `S1B-SOLO60` | **0** (single agent) | 6.18 | 53.3 |
| `S1B-PANEL` | **5.30** | 2.31 | 49.2 |
| `S1B-APRIME` | **13.68** | 0.11 | 27.9 |

**The deficit (4.1 distinct ideas) is smaller than the cross-agent duplication causing it (5.30).** And differentiation demonstrably suppresses that duplication — it is the entire difference between A′'s 13.68 and the panel's 5.30. Stage 1b's panel was differentiated only by one-sentence stances falling through to `DEFAULT_PERSONAS`. Stage 1c turns differentiation up on every axis reachable and asks whether that closes the gap.

### Item 1 — §3.1: `S1C-SOLO60`, the benchmark and the cross-run bridge

Solo, `totalIdeasRequested: 60`, neutral persona — byte-identical in what it sends to `S1B-SOLO60`. Adding the Stage 1c arms moves `armsConfigHash` (`0c05795c6b00` → `9e282a29467f`), staling every Stage 1b cell, so this condition re-collects. See item 4 for the second job it does.

### Item 2 — §3.1: `S1C-SOLO6X10`, the control Stage 1b lacked

`mode: panel`, per-arm geometry override `{size: 10, ideasPerAgent: 6, maxRounds: 1}`, `personaDisabled: true`. **Ten identical agents, six ideas each, one round, blind, pooled only at the end.**

`S1b-1` confounded four things at once: agent count (1 vs 5), ideas per call (60 vs 6), rounds (1 vs 2) and visibility (none vs pooled). This arm holds agent count and ideas-per-call at the panel's values while removing **both** rounds and sharing. Without it, "the panel loses to one call" cannot be separated from **"ten small calls lose to one big call"** — a materially different and more actionable claim. Stage 1a showed per-idea distinctness is flat between N=30 and N=60, but 6 is far below that range and untested.

It uses the per-arm panel override registered by `#129` amendment B, so **no harness change is required by this appendix.**

### Item 3 — §3.1: `S1C-RICH`, the treatment

Five slots, all `claude-sonnet-5`, differentiated on **stance text, `strategy` and `effort` simultaneously**:

| # | persona | strategy | effort |
| --- | --- | --- | --- |
| 1 | `weirdo` | cot | **max** |
| 2 | `philosopher` | cot | high |
| 3 | `mba` | direct | **low** |
| 4 | `poet` | direct | high |
| 5 | `product-manager` | cot | **max** |

The stances are registered **verbatim in `arms.config.json`** rather than restated here, so the registration and the executed config cannot drift; `armsConfigHash` covers them.

Three design decisions, registered so they are not re-litigated after the result:

- **The MBA slot is deliberately the conventional pole.** Its job is not to produce good ideas but to occupy the obvious region so the other four are pushed off it. `direct` + `effort: low` reinforce that. A panel whose members all reach for novelty may re-correlate on "novel-sounding", which is the failure mode being tested.
- **`weirdo`'s stance says "weird but mechanically coherent".** That clause is load-bearing: without it the instruction degenerates toward word salad, which would **inflate `distinct_k` while making the arm meaningless**, since an incoherent idea still occupies its own semantic cluster.
- **The `product-manager` domain is fixed across all 48 briefs**, so it fits the `prod` stratum and mismatches the other three. That mismatch is the registered price of deferring topic-specific personas, which would need new harness machinery and would risk authoring personas against briefs whose results are already known.

**`temperature` is absent by necessity, not choice.** `claude-sonnet-5` rejects it outright (`"temperature is deprecated for this model"`, verified live against the API 2026-09-09), so it is unavailable to the shipped product on this model too. See `#165`, whose original premise this corrected.

### Item 4 — §6: the two-contrast family, and the SOLO60 bridge

```
S1c-1 = S1C-RICH − S1C-SOLO60      does a richly differentiated panel beat one call?
S1c-2 = S1C-RICH − S1C-SOLO6X10    is it the personas, or just ten small calls?
```

Holm at **m = 2**. H1–H5 remain NOT ESTIMABLE for `#145`'s reason and no slot may be occupied by a differently-based contrast.

**The thin `S1B-PANEL` is deliberately NOT re-run.** A `RICH`-vs-`PANEL` comparison would therefore cross a `configHash` boundary, which is forbidden as a primary. `S1C-SOLO60` is what makes a secondary one defensible, and the rule is registered **now, with its threshold, before the data exists**:

- If `S1C-SOLO60`'s rarefied mean reproduces Stage 1b's **44.570** within its CI **and** the rarefaction floors match (Stage 1b's was 50), then `RICH` vs `S1B-PANEL` is reportable as a **clearly-labelled secondary** comparison.
- If it does not reproduce, **that claim is not made at all** — we will have learned the two runs are not comparable, which is itself a result.

`evals/analysis/stage1c.mjs` computes and prints this check; it is not left to judgement.

### Item 5 — the prediction, registered in advance

**If rich differentiation drives cross-agent duplication toward zero, `S1C-RICH` should clear `S1C-SOLO60`.** The arithmetic: the thin panel trailed by 4.1 while losing 5.30 to cross-agent duplication, so eliminating that duplication puts it near 54.5 against solo's 53.3.

**If `S1C-RICH` does not clear it, the panel ARCHITECTURE — not persona thinness — is the binding constraint**, because this arm exhausts the differentiation available on this model. That is the more consequential outcome for the product, and it is registered here so it cannot be reframed afterwards as "the personas still weren't rich enough."

### Item 6 — the three axes are BUNDLED BY DESIGN

`S1C-RICH` varies stance, `strategy` and `effort` together. **If it wins, no single-axis claim may be read from the result.** This is the right trade for a first "does rich differentiation work at all" test — it maximises the chance of detecting an effect that exists — but decomposing it belongs to `#132`'s factorial. Registered so the bundling cannot be forgotten when the result is written up.

### Item 7 — §8: cost, and why the projection under-states it

`--dry-run` projects **$55.04** batched / **$110.07** un-batched for 432 cells. **That projection is known to be too low here**, and the reason is registered rather than discovered: `interimPriceGrid` prices a plan from a flat assumed token shape and **has no model of `effort`**. Stage 1a measured `effort: max` at roughly **4.5×** the output tokens of `high`, and `S1C-RICH` runs two of its five slots at `max` and one at `low`.

Anchoring instead on Stage 1b's realized **$0.2172 per cell all-in** and scaling `S1C-RICH`'s generation by its effort mix gives an expected **$120–$135**.

**The registered ceiling is `--max-spend 180`.** It clears that estimate with room for a re-plan, and over-projection is the safe direction: `--max-spend` refuses earlier than it needs to, never later.

The run uses `--no-batch` for Appendix K's measured reason, and `--cell-concurrency 8`, the top of Appendix I item 7's registered band.

### Item 8 — what this run still cannot say

Unchanged from Stage 1b and repeated because this arm makes the first one **more** consequential, not less:

- **Idea-level quality is untested.** §5.1's judge gate has never run (`#16`). `distinct_k` counts semantic clusters, and an incoherent idea occupies one as readily as a brilliant one. `weirdo` and `poet` are the two slots most likely to produce unusable output, so this run can report that the rich panel produces more distinct ideas **without being able to say they are better**. `#16` is the binding constraint on every remaining claim in this study.
- The panel remains less differentiated than a human panel in the way that matters to the product's pitch: five instances of one model, not five people.

### Item 9 — reproduction

```
./scripts/run-study1c.sh --dry-run     # plan and price, collects nothing
./scripts/run-study1c.sh               # the registered run
node evals/analysis/stage1c.mjs --results-dir results-study1c
```

The arms, replicate count, store, ceiling and concurrency are baked into that script because they are **registered values, not operator choices** — and because Stage 1b's first headline numbers came from an uncommitted script and could not be reproduced from the repo. The script refuses to start on a dirty working tree, so the `armsConfigHash` stamped on every cell is always one a commit reproduces.

**No cell of this design has been collected.** This appendix is the registration, and it lands first.

---

## Appendix M — Amendments (dated 2026-09-09)

Stage 1c ran and **lost 139 of 144 `S1C-RICH` cells**. This appendix registers the instrument fix, what is deliberately *not* changed, and the rule under which the surviving control data is reused. It lands **before** the re-collect.

### Item 1 — What happened, and why it is an instrument defect and not a result

The run completed 293 of 432 cells for **$117.4871**. Both control arms finished (144 each). `S1C-RICH` completed **5**.

Every one of the 139 failures is the same record: `parse_failure`, `cause=partial_truncated`, with **all five agents replying** and a **healthy pool** discarded —

```
agents_attempted=5 agents_failed=0 agents_realized=5
replies=10 truncated=1 unparseable=0 refused=0
discarding an UNDERSIZED pool of 54 candidate(s)
```

Across the 139, discarded pools ran 32–56 candidates (median 48), and truncated replies per cell ran 1–4 — **never more than 4**, which is exactly the number of `effort: max` replies the arm makes (2 max slots × 2 rounds). Truncation is confined to the max-effort replies.

The amplification is `classifyUndersizedPool` (#102) meeting panel geometry: one truncated reply of ten discards the cell, so an 18.5% per-reply rate became a 96.5% per-cell rate. **That rule is correct and is not being changed** — see item 4.

### Item 2 — The measured ceiling, and a correction to Appendix J

The first diagnosis — that `maxTokensForIdeas` has no model of `effort` — was **wrong**, and is recorded here rather than quietly dropped. `TOKENS_PER_IDEA_BY_MODEL` *is* effort-keyed (`claude-sonnet-5: {low: 81, high: 175, max: 776}`), so those replies were sized at 6 × 776 × 2.5 = **11,640** and truncated anyway.

The actual defect is narrower. #160's `MIN_REQUEST_MAX_TOKENS = 6873` is right that a reply carries a **fixed** cost that does not shrink with the ideas asked for — but **that fixed cost is itself a function of `effort`, and #160's probe ran entirely at `high`.** The flat floor is a `high` measurement wearing a flat name. Appendix L item 5 recorded the same blind spot on the *cost* side (`interimPriceGrid` has no model of `effort`) and did not carry it to the token ceiling.

A 30-reply probe of the exact `S1C-RICH` shape (3 briefs × 5 slots × 2 rounds, `claude-sonnet-5`, `ideasPerAgent` 6, `max_tokens` 60000 so nothing truncates, **every reply `stop_reason: end_turn`** so the top is observed and not censored, 2026-09-09):

| effort | n | output tokens | median | over the cap in force |
|---|---|---|---|---|
| low | 6 | 454–814 | 667 | 0/6 (cap 6,873) |
| high | 12 | 771–2,980 | 1,782 | **0/12** (cap 6,873) |
| max | 12 | 6,586–**18,209** | 12,917 | **6/12** (cap 11,640) |

50% per reply across 4 max-effort replies predicts **6.25%** cell survival; **3.5%** was observed. The arithmetic closes, which is what makes this a diagnosed defect rather than a hypothesis.

**Registered:** `MIN_REQUEST_MAX_TOKENS_BY_EFFORT = { max: 45523 }`, from 18,209 × `MAX_TOKENS_HEADROOM` — the same top-of-observed-distribution convention every other number in `prompts.mjs` uses. No new multiplier and no new mechanism: this is #160's floor, keyed.

A floor rather than a larger `max` **rate**, because the cost is fixed per reply: lifting the rate would inflate a 60-idea max-effort solo call by the same multiple, which is #160's own error one level up.

### Item 3 — `low` and `high` are deliberately NOT raised

The probe cleared the existing floor in both buckets outright. Raising them on symmetry grounds would stale every cell in the study for a change **no measurement asked for**, and would break the control-arm invariance item 5 depends on. Pinned by test, so a future tidy-up cannot do it silently.

This also **falsifies a worry raised before the probe**: post-#160 Stage 1b panel cells short of 60 fell 42% → 22%, and 22% looked like a ceiling still biting. At `high` it is not — 0/12 over cap. Whatever the Stage 1b residual is, it is not truncation, and Appendix J item 3's format-failure residual remains the standing explanation.

### Item 4 — `classifyUndersizedPool` is NOT touched

The #102 discard rule is what converted a 18.5% per-reply defect into a 96.5% per-cell loss, and loosening it would "recover" all 139 cells at a stroke. **It is not being loosened.** Editing an inclusion criterion after discovering that it killed the treatment arm is the same failure as re-planning the rarefaction floor-setting cell (Appendix J item 8) — selecting on the outcome. The instrument gets fixed; the rule stands.

If `S1C-RICH` still shows differential attrition after the ceiling is correct, that is a **finding about the arm**, and `buildFrame`'s `DifferentialAttritionError` is expected to refuse the analysis rather than quietly fit a selected subset.

### Item 5 — The hash moves; the control cells are reused, per-arm and by name

`promptTemplateHash()` moves **`12b0a1a414c2` → `52989c87b3e9`**, so `configHash` moves and all 432 stored cells read as stale.

**They are not all re-collected.** `configHash` is coarse — it folds nine `CONFIG_FIELDS` into one value, so it stales cells whose actual requests did not change. Both control arms run entirely at `high`, which item 3 leaves untouched, so they send **byte-identical requests** across the move:

| arm | shape | `max_tokens` before | after |
|---|---|---|---|
| `S1C-SOLO60` | 60 ideas, high | 26,250 (rate-decided) | **26,250** |
| `S1C-SOLO6X10` | 6 ideas, high | 6,873 (floor-decided) | **6,873** |

This is asserted in `prompts.test.mjs` against **hard-coded pre-#168 literals** rather than recomputed constants — a recomputed comparison would pass no matter what the change did. Mutation-checked: keying the floor to `high` instead of `max` fails that test.

`--config-hash` therefore accepts an explicit **list**, pooling the named hashes. Refusal stays the default: an *unnamed* two-hash store throws exactly as before. This is **not** "ignore the hash" — two of the nine fields, `embedderId` and `clusterDistanceThreshold`, *are* the definition of `distinct_k`, and pooling across a change to either would average ideas counted by two different rulers. The operator names the hashes, so the pooling is visible in the invocation.

**The pooling is PER ARM, and this is load-bearing.** The 5 surviving `S1C-RICH` cells sit under the old hash, and they are precisely the cells in which **none of the four max-effort replies truncated** — the most outcome-selected subset in the store. Pooling both hashes wholesale would fold that censored subsample into the corrected treatment arm. Registered rule:

> **`S1C-SOLO60` and `S1C-SOLO6X10` are taken from `12b0a1a414c2` only; `S1C-RICH` is taken from `52989c87b3e9` only.** The 5 old-hash `S1C-RICH` cells are excluded from every contrast. They are retained in the store as evidence of the defect, never pruned, and never analysed.

### Item 6 — Cost

`--max-spend` is **cumulative over the store**, not per-invocation — a fact Appendix L item 7 did not state, and which meant the $180 ceiling was never the binding constraint (the account balance was, at $39.50). Raised to **$220**: $117.49 already spent + ~$85 for `S1C-RICH`'s 144 cells + headroom.

The corrected arm costs **more** per cell than the broken one, not less: a max-effort reply now runs to completion (~18k output tokens) instead of being cut off at 11,640. Any projection from `evals/run.mjs --dry-run` remains a **floor, not a forecast**, for the reason Appendix L item 5 gives.

### Item 7 — What was NOT looked at

**No `distinct_k` value from any Stage 1c cell has been inspected**, and no contrast has been computed. The diagnosis in this appendix rests entirely on pool sizes, token counts, failure kinds and `stop_reason` — operational fields, not the response variable. In particular the 5 surviving `S1C-RICH` cells have not been scored, which is what makes item 5's exclusion a rule set in advance rather than a reaction to what they said.

### Item 8 — Reproduction

```bash
./scripts/run-study1c.sh S1C-RICH          # treatment arm only; controls are reused
node evals/analysis/stage1c.mjs --results-dir results-study1c
```

The arm override exists because a bare resume would re-collect the 288 physically-identical control cells. The analysis applies item 5's per-arm hash rule itself, so the reproduction command carries no hashes by hand.

### Item 9 — Result of the corrected re-collect (added 2026-09-09, after the run)

The re-collect completed **143 of 144** `S1C-RICH` cells against 5 of 144 before, at `configHash` **`9b17e4ba0734`**. One residual `parse_failure` / `cause=partial_truncated` remains (0.7% of cells), which is consistent with a ceiling set at 2.5× the top of a 12-sample distribution and is left standing as the measured residual rather than chased.

**Registered family (Holm, m=2), rarefied `distinct_k`, floor 50 set by `arm=S1C-RICH|brief=sci-05|rep=2` — ≥ 48, so PRIMARY as registered:**

| ID | Contrast | Estimate | SE | 95% CI | Holm p |
|---|---|---|---|---|---|
| S1c-1 | `S1C-RICH − S1C-SOLO60` | **+1.6728** | 0.6931 | [0.314, 3.031] | 0.0158 |
| S1c-2 | `S1C-RICH − S1C-SOLO6X10` | **+30.2126** | 0.6931 | [28.854, 31.571] | <0.0001 |

Rarefied means: RICH **46.025** (n=143), SOLO60 **44.369** (n=144), SOLO6X10 **15.829** (n=144). Full-pool: 54.161 / 53.160 / 17.201. Mean cost: **$0.6178** / $0.0430 / $0.0915.

**The registered prediction resolves in the direction Appendix L registered as the alternative.** Stage 1b's thin-stance panel was **−2.1338** against the same reference; the richly differentiated panel is **+1.6728**. The sign reverses.

**The SOLO60 bridge (Appendix L item 4) holds.** This run's `S1C-SOLO60` rarefied mean is 44.369 against Stage 1b's 44.570, a difference of −0.201, and both runs' rarefaction floors are 50. Both conditions registered for the bridge are met, so **RICH 46.025 vs Stage 1b's `S1B-PANEL` 42.495 is reportable as clearly-labelled SECONDARY.**

**`S1C-SOLO6X10` is the study's cleanest single result.** Ten blind, identical, unshared agents produce a full 60-idea pool that clusters to ~15 distinct ideas — a 75% collapse, verified on a raw stored cell rather than inferred from the mean. Undifferentiated parallel sampling is worth less than a third of one solo call at matched pool size.

#### What this result does NOT support

1. **It is not attributable to personas.** Appendix L item 4 bundles three axes — stance text, strategy and effort — by design. `+1.6728` is the bundle's effect. No decomposition is available and none should be asserted.
2. **It is not a quality claim.** `distinct_k` measures distinctness, not merit. Issue #16's judge gate has never been run, and it is now the binding constraint on every claim this study makes. The `weirdo` stance is explicitly prompted for strangeness and is the one slot that could buy distinctness with incoherence.
3. **The effect is below the design's own MDE.** Appendix J registered MDE **1.89** at Holm m=2; the observed effect is **1.67**. It reached significance, but this design would miss an effect of this size a substantial fraction of the time — which argues for replication, not against the finding.
4. **Holm applied no correction to S1c-1.** It is the larger of the two p-values, so `0.0158` is the raw p, not an adjusted one.
5. **The economics are thin.** A **14.4×** cost increase ($0.6178 vs $0.0430) buys **+3.8%** rarefied distinct ideas. Statistical significance and practical value are different questions and this appendix asserts only the first.

#### An unregistered robustness check, reported because it was run

S1c-1's SE is estimated from a single-σ fit pooling all three arms, including `S1C-SOLO6X10` at a mean of 15.8. Refitting S1c-1 on `S1C-RICH + S1C-SOLO60` alone gives estimate **1.6713**, SE **0.5318**, CI [0.629, 2.714], p **0.0017**.

The concern that motivated the check — that floor effects at 15.8 would compress that arm's variance and *deflate* the pooled SE — is **falsified**: per-arm variance is RICH 9.41, SOLO60 12.69, **SOLO6X10 32.91**, so pooling it *inflated* the SE by ~30%. **The registered three-arm figure is the conservative one**, and it remains the primary result; the two-arm fit was not pre-specified and is recorded here only so the check cannot be re-run selectively later.

---

## Appendix N — Amendments (dated 2026-09-09)

Registers the §5.1 judge-validation run (#16) **before it is run**, and registers a separate, explicitly non-confirmatory quality read of the Stage 1c pools. Appendix L item 4 and Appendix M item 9 both name the unrun judge gate as the binding constraint on every claim this study makes; this appendix is the attempt to unbind it, and it registers in advance what happens in both branches.

### Item 1 — What was already settled, and what is actually left

Issue #16's own history records two blockers that are **no longer live**, and this item states that plainly so the run is not re-litigated against a stale reading of the issue:

1. **The axis↔column mapping is registered.** Appendix A item 7 registers the judge's **`originality`** axis against the Si et al. **`overall_score`** column. The 2026-08-02 kickback described this as an unregistered methodology decision; it was registered afterwards. That kickback also described the judge as emitting *four* axes — it emits **two**, `originality` and `feasibility` (`prompt.mjs` `JUDGE_AXES`). Both statements in that comment are stale.
2. **The slice join is repaired.** The kickback recorded `readSiEtAlSlice()` failing closed with *"99 idea file(s) did not resolve to an idea_id"*. Verified on `develop` at `cbb74a7`: the join is total — **98 ideas, 228 reviews**, `nearMisses: 0`, with `AI_Rerank` carried as a named exclusion (49 files, issue #35).

The remaining scope of #16 is therefore exactly its fourth checklist item: **run the validation and record the record.** Nothing about the instrument is changed by this appendix.

### Item 2 — The answer key is under-powered, and this is registered before the verdict

`evals/judge/reproduce-si-et-al.mjs` was run against the real slice. It reproduces the committed #47 figure **bit-for-bit** (only the timestamp differs), so this is a verification, not a new measurement — but the figure has never been carried into the gate's own registration, and it governs how the verdict may be read:

| Quantity | Value |
|---|---|
| Human–human balanced accuracy, our 98-idea slice | **0.5534** |
| Bootstrap 95% CI (2000 draws, resampling ideas) | **[0.4483, 0.6702]** |
| Registered floor (Appendix A item 4) | 0.561 |
| Chance | 0.500 |

**The CI does not exclude chance.** The expert answer key, measured against itself at n=98, cannot be distinguished from a coin flip. The registered 0.561 floor sits inside the CI and is therefore not contradicted — but a `pass`/`drop` verdict computed at n=98 carries roughly ±0.11 of bootstrap uncertainty, so a judge at 0.60 and a judge at 0.50 land in the same interval.

**Registered consequence:** the verdict is reported **with this CI beside it**, and is described as **power-limited by the answer key, not only by the judge**. This is registered now, before the verdict is known, precisely so it cannot be deployed selectively as an excuse for a `drop` or waved away on a `pass`.

### Item 3 — Comparators, registered before the run

Appendix A item 4 registers **53.3%** as the "best LLM evaluator" comparator. That figure is Si et al.'s Claude-3.5 **Pairwise** ranker. This study's judge is a **direct, score-only** scorer, whose shape-matched comparator is Claude-3.5 **Direct** at **51.7%**. Registering only the pairwise figure invites a comparison against a differently-shaped evaluator.

**Both are registered as comparators**, with 51.7% named as the shape-matched one. Neither is a floor; the floor remains 56.1%.

**A construction difference is registered alongside them:** Si et al. threshold LLM evaluators at their **median** score, whereas `balancedAccuracyTopBottom` ranks the labelled set and splits top-k/bottom-k. These are not the same computation, and any comparison drawn against 51.7% or 53.3% must say so.

### Item 4 — Run parameters, fixed before the first judge call

- **Axis:** `originality` (Appendix A item 7)
- **Expert column:** `overall_score` (Appendix A item 7)
- **Metric / construction:** `balanced-accuracy` / `si-et-al-2024/split-half-top-bottom-25pct-balanced-accuracy` (Appendix A item 4)
- **Floor:** `0.561`
- **Slice:** Human + AI, n = 98; `AI_Rerank` excluded and carried in the record's `exclusions`
- **Store:** a **dedicated** store, not `results-study1c`

The store choice is load-bearing rather than cosmetic. `recordValidation` writes its record under `cfg: <judgeHash>`. `results-study1c`'s configHash tally is what `resolveS1cArmHashes` reads, and it throws when it finds more than one non-pre-#168 hash — so writing the validation record into that store would **break the Stage 1c analysis merged as #168**. The validation record goes elsewhere.

**No sweep.** The judge is run at the registered mapping only. A judge-vs-column or judge-vs-axis sweep would select the gate on its own outcome; Appendix A item 7 closed the question and this appendix does not reopen it.

### Item 5 — A construct tension, disclosed and NOT acted on

The Si et al. release carries a **`novelty_score`** column. On construct grounds it is a closer match to the judge's `originality` axis than `overall_score` is.

**The registered mapping stands.** The 56.1% floor is human–human agreement on `overall_score` and on no other column; validating against `novelty_score` would require a second floor and a second amendment. This is recorded as a **limitation of the registered gate**, not as a proposed change — and it is recorded *after* item 2's 0.5534 was already known, which is exactly the circumstance in which switching columns would be selecting on the outcome.

### Item 6 — The Stage 1c quality read is DESCRIPTIVE and non-confirmatory

The question the study actually needs answered — whether the rich panel's extra distinct ideas are *better* ideas, and whether `weirdo` buys distinctness with incoherence — is registered here as a **separate, explicitly non-confirmatory** exercise, run **outside** the §5.1 gate.

- It scores already-stored Stage 1c candidate texts. No cells are re-collected.
- Scores are written to a **sidecar keyed by cellKey**, never back into `results-study1c` under a new `configHash`. `judgeHash` is a `CONFIG_FIELDS` entry, so writing judge output in-store would restate every cell's identity and strand the 431 cells already collected.
- It is run **regardless of the gate's verdict**, and every artifact it produces is labelled descriptive. Per §5.4 a `drop` verdict removes idea-level metrics from *the study's confirmatory claims*; it does not forbid looking at the ideas and saying what is there.
- **It is a look, not a test.** A small stratified pilot has no power for an arm contrast, and no p-value is computed from it.

Registering this in advance is what stops a `drop` verdict from silently deleting the user-facing answer, and stops a descriptive read from being promoted to a confirmatory one after the fact.

### Item 7 — Instrument amendment: the judge was not the direct scorer §5 assumes

**Registered after the first attempt failed and before any verdict existed**, which is the only ordering under which this amendment is legitimate.

The first real run of the gate died on `parseAxisScores: empty judge reply`. It was not a refusal. Probing the failing call: `stop_reason: "max_tokens"`, `output_tokens: 256`, of which **`thinking_tokens: 255`** — the model spent the entire budget thinking and never emitted the JSON. `buildAnthropicMessageParams` never sets `thinking`, so every judge call this study has ever made inherited the API's **adaptive** default.

`MAX_JUDGE_TOKENS`'s own doc comment already stated the intent this violates — 256 is *"small enough that a model tempted to 'explain' its score runs out of room rather than producing reasoning-then-score drift the §5 rubric forbids."* Adaptive thinking bypassed that ceiling's purpose: the model reasoned anyway, inside the budget meant to prevent it.

**The load-bearing observation is not the crash.** In that topic group, **8 of 10** replies returned `thinking_tokens: 0` and **2** returned 255. Under adaptive thinking the instrument was **heterogeneous across ideas**, and the ideas it chose to think about are plausibly the ambiguous ones whose expert scores are hardest to predict — a bias surface in the gate itself, not merely a failure mode.

**Registered change:** every judge call sets `thinking: {type: "disabled"}`. This restores the direct, score-only scorer item 3 registers and makes the instrument uniform across ideas. The ceiling is **not** raised; raising it would make this a reasoning judge, matching neither registered comparator.

**Whether thinking shifts the scores is UNMEASURED.** Replaying one failing candidate gave `originality` 6 disabled, 4 at `max_tokens` 2048, 5 at 4096 — one candidate, one draw each, no temperature set. That is consistent with sampling noise and is **not** evidence of an instrument effect. It is recorded so the question stays visibly open.

### Item 8 — A hash gap, and where the protection actually lives (#170)

`judgeHash` folds the prompt hash and the model roster. It covers **neither** `MAX_JUDGE_TOKENS` **nor** the thinking mode. Since `validationKey` is exactly `{judgeHash, sliceId}`, a thinking judge and a direct judge collide on one key — and `attachIdeaLevelScores` licenses idea-level metrics off **any** record whose verdict is `pass`.

**Not folded into the hash.** Doing so changes `judgeHash` → `configHash` → the `cellKey` of all **431 collected Stage 1c cells**, re-keying paid data over a constant that did not exist when it was collected. That trade is worse than the gap. Filed as **#170**.

**Writing the test for the gap corrected the concern.** The feared path — a `drop` followed by a differently-shaped `pass` silently unlocking the confirmatory metrics — **is already closed**, by `ResultsStore.put`'s append-only guard, which refuses a second write under an existing key with different content. The backstop is the store's invariant, not the hash. Recorded because the protection lives somewhere no reader would look for it. `recordValidation` additionally stamps `requestShape` so a verdict names its own instrument.

### Item 9 — Result: the §5.1 gate has run, and it PASSES

First execution of the judge-validation gate in the study's history. Ran 2026-09-09 against the real slice; **$0.577**.

| Field | Value |
|---|---|
| metric | `balanced-accuracy` |
| construction | `si-et-al-2024/split-half-top-bottom-25pct-balanced-accuracy` |
| axis ↔ column | `originality` ↔ `overall_score` |
| n | **98** |
| accuracy | **0.5833** |
| floor | 0.561 |
| **verdict** | **`pass`** |
| rho (descriptive) | 0.2141 |
| requestShape | `{maxTokens: 256, thinking: {type: "disabled"}}` |
| judgeHash | `16812833fcd2` |

**Per §5.4, idea-level metrics are therefore licensed** rather than dropped. That is the constraint Appendix L item 4 and Appendix M item 9 both named as binding on every claim this study makes.

#### How far this verdict may be pushed — registered in item 2, before it was known

1. **It is power-limited by the answer key, not only by the judge.** Human–human balanced accuracy on this same 98-idea slice is **0.5534, bootstrap 95% CI [0.4483, 0.6702]** — a CI that does not exclude chance. The judge's 0.5833 sits inside that interval. The honest statement is that **the judge is not distinguishable from the human reviewers on this metric at this n**, which is what clearing a human-agreement floor means; it is not evidence that the judge is *good*.
2. **It clears both registered comparators** (item 3): 0.5833 > 0.533 pairwise and > 0.517 Claude-3.5 Direct, the shape-matched one. The construction difference registered in item 3 — Si et al. threshold LLM evaluators at their median, `balancedAccuracyTopBottom` splits top-k/bottom-k — applies to both comparisons and is not waived by the pass.
3. **The margin is 2.2 points over the floor.** Nothing in this design distinguishes 0.5833 from 0.561.
4. **`rho` is not stable across runs; the verdict is.** Two independent runs of the identical committed invocation returned accuracy **0.5833 both times** and rho **0.2291 then 0.2141**. The gate metric is robust to the judge's residual sampling variation; the retained descriptive statistic is not, and should not be quoted to three decimals.
5. **The construct tension of item 5 is unresolved by a pass.** `originality` was validated against `overall_score`, not against `novelty_score`.

#### Two defects in this appendix's own tooling, recorded rather than quietly fixed

The **first** stored validation record carried `requestShape: null`. `runJudgeValidation` built the shape and never passed it to `recordValidation`; the unit test on `recordValidation` asserted the field is written *when supplied* and passed, so the mutation ledger was green while the wiring was dead. **A unit test on the callee is not a test of the wiring.** Fixed, a composition-level test added, and the defective record preserved outside the store before it was re-derived. The re-derivation reproduced accuracy, judgeHash and spend exactly.

The **second**: the runner printed the full-roster `judgeHash` while `runJudgeValidation` keys the record by the single model that actually ran — so the operator was shown a key the store does not contain. Fixed.

### Item 10 — Judge refusals are MISSING scores, not low ones

**Registered before any quality mean was computed or inspected.** The first quality-read run scored 10 of 12 cells and then aborted; the abort happened before any summary was produced, and no per-arm or per-persona figure had been looked at when this rule was written. That ordering is the only thing that makes it a rule rather than a rationalisation.

The abort was a second, distinct cause of `parse_failure: empty judge reply`, unrelated to item 7's thinking defect — which had already been fixed and held for 600 consecutive candidates. This one is **`stop_reason: "refusal"`**: the judge declined to score a candidate. The candidate was `"Build agent-based immune system simulations capturing T-cell and pathogen co-evolution to explore vaccination strategies that minimize resistance emergence"` — an unremarkable computational-biology proposal.

**The hazard.** As written, one refusal aborted an entire 61-candidate cell. That is precisely the shape of the `classifyUndersizedPool` trap Appendix M item 4 refused to loosen — a per-reply failure escalating to destroy a whole cell — reappearing on the judge leg. And it is worse here, because refusals are **not** independent of the outcome: the judge refuses on content, so discarding refused candidates silently conditions the quality means on what the judge was willing to look at.

**Registered handling:**

1. A refusal records `originality: null, feasibility: null` for **that candidate only**. The cell is kept.
2. Refused candidates are **excluded from means and never imputed** — not as zero, not as the cell mean. A refusal is missing data.
3. **The refusal count is reported as a first-class number**, per arm and per persona, alongside every mean. A quality figure computed over a pool the judge partly declined to read must carry that fact next to it.
4. If refusals are **unevenly distributed across arms or personas**, that asymmetry is reported as a finding in its own right — it is a measurement of what the instrument will not measure, and it bears directly on the `weirdo` question, since a persona prompted for strangeness is the one most likely to trip a refusal.

The pilot is re-run from scratch under this rule rather than patched over the 10 stored cells, so every cell in the sidecar is produced by one instrument under one policy.

### Item 11 — Result of the quality read: a sharp trade, not a free lunch

**DESCRIPTIVE. No contrast, no p-value, no confirmatory claim.** 12 cells, 6 matched briefs, replicate 1, 729 candidates, **$0.98**. One refusal (0.14%), excluded and not imputed.

| arm | n | scored | originality | feasibility | refused |
|---|---|---|---|---|---|
| `S1C-RICH` | 358 | 358 | **6.092** | 6.087 | 0 |
| `S1C-SOLO60` | 371 | 370 | **2.803** | **8.214** | 1 |

The originality gap holds in **all six briefs** with the same sign (RICH 5.63–6.48 vs SOLO60 1.89–3.57), so it is not a single-brief artefact. The distributions barely overlap: **no** `S1C-SOLO60` idea scored ≥ 8 on originality; 111 `S1C-RICH` ideas did.

**The rich panel does not produce better ideas. It produces more original and less feasible ones**, and the solo call the reverse. Stage 1c's `distinct_k` finding sat on top of this trade without being able to see it.

#### The `weirdo` question, answered — and the hypothesis half-corrected

| persona | n | originality | feasibility |
|---|---|---|---|
| `weirdo` | 72 | **7.972** | **4.819** |
| `philosopher` | 71 | 7.099 | 5.606 |
| `poet` | 72 | 6.569 | 6.014 |
| `product-manager` | 72 | 4.806 | 7.708 |
| `mba` | 71 | 4.000 | 6.282 |

`weirdo` is exactly what it was suspected of being on the numbers: **highest originality, lowest feasibility**, and the single largest contributor of high-originality ideas (59 of the 111 at ≥ 8). Removing it drops RICH's originality from 6.092 to 5.619 — still far above SOLO60's 2.803, so **the effect is not carried by `weirdo` alone.**

**But low feasibility is not incoherence,** and the numeric judge cannot tell them apart. That is what the blind review below was for.

#### The blind review — an independent reader who never saw the arms

40 ideas (20 per arm, 2 briefs, deterministically shuffled, arm and persona stripped) were reviewed for substance / usefulness / **coherence** by a reader told only the brief. Joining its verdicts to the key it never saw:

- **Every incoherence and vacuity flag it raised — all six — is `S1C-RICH`. Zero from `S1C-SOLO60`.**
- **But `poet`, not `weirdo`, is the worse offender**: 4 of the 6 flags (`IDEA-14`, `-21`, `-22`, `-36`) are `poet`; 2 (`IDEA-16`, `-30`) are `weirdo`.
- The clearest failure is `weirdo`'s: a subscription "tontine" whose stated mechanism is arithmetically self-refuting — fixed costs split among *fewer* payers were claimed to lower each share. It is wrong in a way a reader enjoying the prose does not notice.
- **`weirdo` also produced one of the reviewer's five BEST ideas** (`IDEA-33`, a vacancy-chain scheduling analogy it called the strongest of the analogical items). The persona generates both tails.
- Reviewing blind, it identified an "extended-metaphor" style cluster that is **100% `S1C-RICH`** (4 `poet`, 4 `weirdo`) and a "terse textbook one-liner" cluster that is **100% `S1C-SOLO60`** — perfect arm discrimination from style alone, with no labels.
- Its five best split **3 `S1C-SOLO60` / 2 `S1C-RICH`**; its five worst split **4 `S1C-RICH` / 1 `S1C-SOLO60`**.

#### The caveat that limits all of the above, raised by the reviewer itself

> "a single-clause idea cannot contradict itself"

**Coherence only bites on elaborated ideas.** `S1C-SOLO60` produces one-liners; `S1C-RICH` produces paragraphs. So RICH's monopoly on incoherence flags is **partly an artefact of having enough text to be wrong in**, not purely a quality difference — and any aggregate that pools one-liners with elaborated items washes out the very effect being looked for. This is the sharpest limitation on the section and it came from the instrument, not from us.

#### A second instrument caveat: the two axes are not independent

Per-idea correlation between `originality` and `feasibility` is **r = −0.61** within `S1C-RICH`, **−0.45** within `S1C-SOLO60`, **−0.72** pooled. `assertAxesNotCollapsed` enforces that the axes are separate *fields*; it cannot enforce that they are separate *constructs*. Some of the "originality up, feasibility down" pattern is therefore built into the instrument, and the pooled figure is further inflated by the arm separation itself. The per-arm figures are the ones to read.

#### What this licenses

A reader may now say that the rich panel trades feasibility for originality, that the trade is large and consistent across briefs, and that its ideas fail coherence in a way the solo call's do not — with the length confound stated. A reader may **not** yet say the rich panel is better or worse overall: that is 12 cells, one replicate, two briefs for the blind read, and no contrast was computed.

### Item 12 — The operator's own blind read, and what it found that the metrics could not

The operator read the same 40-idea blind packet (arm and persona stripped) and left free-text notes rather than ratings. Deliberately not a scale: two numeric instruments already scored these ideas, and what neither can supply is the reasoning behind a verdict. The notes were written before the key was seen.

#### A third independent instrument, agreeing

Classifying the operator's notes and joining them to the key:

| operator verdict | `S1C-RICH` | `S1C-SOLO60` |
|---|---|---|
| "unique" / "novel" | **5** | **0** |
| "nonsense" / "doesn't make sense" | **4** | **0** |
| "good, standard" | 4 | **12** |

**Perfect separation on both tails, from a reader who saw no labels.** The LLM judge, the blind reviewer and the operator are three instruments of different kinds, and all three independently reproduce the same structure — including the double tail: the rich panel owns the uniques *and* the incoherence. The operator's four flags were 2 `poet`, 1 `philosopher`, 1 `weirdo`, again pointing away from the registered `weirdo` suspicion and toward `poet` (item 11).

#### The finding that bears on METHOD, not on the arms

**The operator rated the tontine (`IDEA-16`, `weirdo`) "Unique idea" and did not catch its defect.** Its stated mechanism is arithmetically self-refuting — fixed costs split among *fewer* survivors raise each share, so the claimed cause produces the opposite of the claimed effect. The blind reviewer caught it; a careful human reader who was *specifically looking for this failure mode* did not.

This is registered as a first-class result: **vivid framing buys a pass on incoherence from human spot-check.** It is the precise hazard §5 exists to guard against, observed happening to the study's own operator. Human review alone is therefore **not** a sufficient control for this class, and any future design that leans on operator spot-check as the coherence check should be considered unsound on this evidence.

#### A limit on human spot-check, from the same source

**9 of the operator's 20 `sci-05` notes are "can't evaluate this but sounds cool."** That is the correct answer for domain-technical research proposals, and it bounds what operator review can contribute: on the technical brief its discriminating power is near zero, while on `biz-02` — the brief the operator judged the *weaker* test — the notes are decisive. Human spot-check is domain-bounded and should be deployed where the operator has standing, not uniformly.

#### Brief genericness is real and measurable

The operator's first observation was that `biz-02` is generic and has a bounded answer space. The store confirms it directly, and it had not been looked at before the claim was made:

| brief | `S1C-RICH` collapse | `S1C-SOLO60` collapse |
|---|---|---|
| `biz-02` | **13.3%** | **16.7%** |
| `sci-05` | 3.3% | 1.6% |

`biz-02` collapses **4–10× harder**. Brief genericness is a measurable property of a cell, it varies enormously across the corpus, and nothing in the study currently models it.

#### The dissociation: `distinct_k` and quality are near-orthogonal at the cell level

Comparing the two metrics on the **same twelve cells**:

| brief | `distinct_k` gap (RICH − SOLO60) | originality gap |
|---|---|---|
| `biz-02` | **+2** | +3.83 |
| `biz-07` | **+1** | +3.06 |
| `prod-03` | **−3** | +3.75 |
| `prod-07` | **+8** | +3.73 |
| `sci-05` | **−2** | +2.68 |
| `sci-08` | **−5** | +2.78 |

**The `distinct_k` gap changes sign three times and averages roughly zero. The originality gap is positive in all six briefs, between +2.68 and +3.83.** On `biz-02` the two arms are nearly identical on `distinct_k` (52 vs 50) and three points apart on originality; on `sci-08` `S1C-SOLO60` *wins* `distinct_k` (61 vs 56) while losing originality by 2.78.

**Twelve competent one-liners and twelve genuinely varied approaches both count as ~50 distinct ideas, because they are ~50 distinct ideas.** `distinct_k` measures how many different things were said, and is constitutionally unable to see how good they were. This is the clearest available evidence that the study's headline metric and the thing the product actually claims are not the same quantity.

**What this does NOT do is revise Appendix M item 9.** These `distinct_k` values are **raw, unrarefied, single-replicate** figures from 6 of 48 briefs; the registered **+1.6728** is a rarefied estimate over 48 briefs × 3 replicates and stands unchanged. The claim here is narrower and about *dissociation*, not magnitude: on the very same cells, the two metrics rank the arms differently, so a `distinct_k` result cannot be read as a quality result in either direction.

#### Provenance

Every observation in this item originated with the operator's read of the packet, not with the analysis. The measurements were run afterwards to test claims the operator had already made — which is the ordering that makes them tests rather than illustrations.

### Item 10 — The spend ceiling did not bind, again

Final cumulative spend was **$222.7198** against a `--max-spend` of **$220**. `--max-spend` is evaluated against a *projection* before cells are dispatched, not enforced mid-flight, so it overshoots when the projection is low — and `interimPriceGrid` has no model of `effort` (Appendix L item 5), which is exactly the condition this arm runs under. Combined with Appendix K's finding that the ceiling sat above the account balance, **the ceiling has now failed to bind twice for two different reasons.** Filed as **#169** rather than fixed here; no result in item 9 depends on it. For the record, the pre-flight projection for the 144-cell re-collect was **$41.59** against an actual **$105.22** — a 2.5× underestimate, concentrated in exactly the max-effort condition where a ceiling most needs to work.


## Appendix O — Amendments (dated 2026-09-10)

Two amendments, neither of which retracts a registered result. **Items 1–5** resolve **#165** (§3.3, the universal `temperature` strip) — the issue's central claim does not hold for the contrast it is about, and what replaces it is a **tighter** bound on `S1b-1` than the caveat the issue asked for. **Items 6–8** record that **#170**'s hash gap is **CLOSED** (merged as `7f3f359`, PR #173) and supersede, by dated cross-reference, the two statements in [Appendix N](#appendix-n--amendments-dated-2026-09-09) item 8 that the merge made false.

### Item 1 — §3.3: the `temperature` strip is not a bias against panel arms (#165)

**A live probe.** Run 2026-09-10 against `api.anthropic.com/v1/messages`, one 4-token request per model carrying `temperature: 0.9`:

| model | result |
| --- | --- |
| `claude-sonnet-5` | **HTTP 400** — ``temperature` is deprecated for this model.` |
| `claude-opus-5` | **HTTP 400** — same message |
| `claude-haiku-4-5` | **HTTP 200** — accepted |

This **confirms §3.3 finding B2**, recorded 2026-07-31, and adds one first-party word worth registering: the API says **"deprecated,"** not "unsupported."

**Every Study 1 arm runs on `claude-sonnet-5`.** Re-verified against `arms.config.json` at `7f3f359`, over the full arm set — `S1-C0`, `S1-N10`, `S1-N60`, `S1-ELOW`, `S1-EMAX`, `S1-SPRAG`, `S1-SCONTRA`, `S1-DIRECT`, `S1B-SOLO60`, `S1B-PANEL`, `S1B-APRIME`, `S1C-SOLO60`, `S1C-SOLO6X10`, `S1C-RICH`. Every slot of every one of those fourteen arms resolves to `claude-sonnet-5`. **There is no Haiku slot anywhere in Study 1.**

**Therefore #165's central claim does not hold for the contrast it is about.** #165 argues that force-stripping `temperature` *biases* panel arms against solo arms. **A bias requires a foregone alternative.** On `claude-sonnet-5` there is none: a panel on that model could never have carried a temperature axis, because the API rejects the parameter outright. **The strip changed nothing for any Stage 1b or Stage 1c arm.**

**§3.3's registered bias direction is UNAFFECTED and stands.** It is written against the **Haiku** arms **B / E / F**, where the force-strip does override a real `modelAcceptsSamplingParams` → `true` (the implementation fact recorded in [Appendix A](#appendix-a--amendments-dated-2026-08-02) item 3). That is a model on which the parameter is accepted, so there the foregone alternative is real. #165's extension of that direction to the panel-vs-solo contrast is what does not hold — because that contrast never ran on a model that accepts the parameter.

### Item 2 — #165's two proposed fixes are WITHDRAWN as unimplementable

Registered explicitly so neither is re-litigated:

1. **"Forward per-slot `temperature` where the API accepts it."** It is accepted **nowhere** in Study 1. On this model class the forwarding forwards nothing. The issue's supporting argument — that §3.3's model-versus-sampling-policy objection may not apply because Stage 1b holds model constant — is sound reasoning and **moot**: the parameter cannot be sent at all.
2. **"Run a differentiated-temperature panel arm as its own registered comparison."** It could only run on **Haiku 4.5**, which reintroduces exactly the **model-versus-sampling-policy confound §3.3 rejected**, and would answer a different question from the one `S1b-1` reports on.

Both remain live only for a future arm set on a model that accepts the parameter (e.g. `#132`'s factorial, `#131`'s mixed-model panel). Nothing about Study 1 changes.

### Item 3 — #165 item 3 was already satisfied; cross-referenced, NOT re-registered

#165 asks for "a solo agent making ten independent 6-idea calls, pooled, no sharing."

That is **`S1C-SOLO6X10`**, registered in [Appendix L](#appendix-l--amendments-dated-2026-09-09) **item 2** under the heading *"THE MISSING CONTROL"* — `{size: 10, ideasPerAgent: 6, maxRounds: 1}`, `personaDisabled: true`, blind, pooled only at the end — collected, and reported in [Appendix M](#appendix-m--amendments-dated-2026-09-09) item 9. The gap was real when the issue was filed and was closed the same afternoon, before the issue was acted on.

**This item registers nothing new.** It records only that the request is already met, so no second registration of the same arm exists in this document.

### Item 4 — What survives, registered as a claim-breadth bound on `S1b-1`

**The strip is not an artefact of the study. It is a faithful reproduction of what the product can do on this model class.**

`DEFAULT_PERSONAS` ships a deliberate **0.4–1.0** temperature spread as its per-agent diversity lever. On `claude-sonnet-5` and `claude-opus-5` that lever **does not exist**. The values ride the agent record and the config but are never submitted: §3.3's universal strip drops them client-side ([Appendix E](#appendix-e--amendments-dated-2026-09-08) item 1, "recorded, not sent" — "neither request builder ever reads it for any model"), and on this model class the API would reject them if they were sent. **The strip therefore removed nothing that could have been sent** — item 1's finding restated at the level of the product.

So a panel on a frontier Anthropic model differentiates on **stance alone** — and **Stage 1a measured stance as inert** for a solo agent, every confidence interval containing zero.

**Registered bound on `S1b-1`:** the honest statement is **not** *"this panel lost with one lever switched off"* but ***"on this model class the panel has only one differentiation lever, and that lever has already been measured as weak."***

Two things follow, and both are the point of this item:

- This bounds `S1b-1` **more tightly** than the caveat #165 asked for. "We disabled temperature" invites the reply *"then re-run it enabled"*; this statement forecloses that reply on this model class.
- It bounds `S1b-1` as a **fact about the shipped product**, not as a limitation of the experiment. The differentiation the product advertises is not available where the study ran it.

### Item 5 — This does NOT retract `S1b-1`, `S1c-1` or `S1c-2`

Stated explicitly so item 4 is not read as a withdrawal. The contrasts are **correctly computed and correctly registered**, and every figure reported for them stands unchanged. What item 4 changes is the **breadth of claim they license**, and nothing else. The cluster attribution that located Stage 1b's deficit — cross-agent duplication of 5.30 merges/cell against solo's 0, a deficit (4.1 distinct ideas) smaller than the duplication causing it — was **measured rather than inferred** and never depended on temperature.

### Item 6 — §5: the hash gap is CLOSED, and two statements in Appendix N item 8 are SUPERSEDED (#170)

#170 merged as **`7f3f359`** (PR #173). [Appendix N](#appendix-n--amendments-dated-2026-09-09) item 8 is **not edited**; the two statements below are superseded here, by dated cross-reference.

**Superseded statement 1.** Item 8 states that `validationKey` is *"exactly `{judgeHash, sliceId}`"*. It is now **`{judgeHash, judgeRequestHash, sliceId}`**. `judgeRequestHash` is **optional on `validationKey` only** — omitting it reproduces the pre-#170 key byte-for-byte, which is what keeps the one stored record reachable (Appendix N item 8's own concern; see item 8 of this appendix for the verification).

**Superseded statement 2.** Item 8 states that *"a thinking judge and a direct judge collide on one key."* They no longer do. `computeJudgeRequestHash` covers `{maxTokens, thinking}` — the two halves whose **interaction** broke the first real §5.1 run (Appendix N item 7) — so two instruments occupy two keys.

**What in item 8 is NOT superseded, and is reaffirmed:**

- Its observation that **the real backstop was `ResultsStore.put`'s append-only invariant** is still true and still worth preserving. The key now **separates instruments in addition to** that guard, rather than replacing it.
- Its **decision not to fold the request shape into `judgeHash`** was upheld, not reversed. #170 shipped Option 1: a **separate** hash, not a `CONFIG_FIELDS` entry, never folded into `configHash`.

**Verified: `configHash` did not move.** `computeJudgeHash`'s canonical payload is **byte-identical** to its pre-#170 form — the merge changed only the comment block above the function — and it still produces the golden **`16812833fcd2`** that the stored §5.1 verdict is keyed under. **None of the 431 collected Stage 1c cells were re-keyed.** That is the whole reason Option 1 was chosen.

### Item 7 — The current instrument's `judgeRequestHash`, as an addition to Appendix N item 9

Appendix N item 9's record table carries a `judgeHash` row and a `requestShape` row. It gains one figure, **recorded here rather than in that table**:

| Field | Value |
| --- | --- |
| `judgeHash` | `16812833fcd2` (unchanged) |
| **`judgeRequestHash`** | **`d1554a8ca60c`** |
| `requestShape` | `{maxTokens: 256, thinking: {type: "disabled"}}` |

The two hashes together are the full instrument identity of the passing 0.5833 verdict. `d1554a8ca60c` is the hash **a run happening now would write**, and it is also the hash of the **stored** record's `requestShape` — which is the fact item 8 below turns on.

### Item 8 — The existing §5.1 verdict remains valid, and the gate does NOT need re-running

**This is the load-bearing claim of the #170 half of this appendix, and it was verified against the merged code rather than inferred from the change description.**

- **The stored record is not migrated.** It keeps its pre-#170 key, `judge-validation|judge=16812833fcd2|slice=si-et-al|axis=originality|expert=overall_score`, with no `req=` segment. Rewriting it would break the very append-only invariant Appendix N item 8 identified as the real backstop.
- **It is still reachable.** Everything that finds a validation record scans the prefix `judge-validation|judge=${judgeHash}|`, which matches both key shapes. `req=` was placed **between** `judge=` and `slice=` precisely because `sliceId` itself embeds `|` and must stay last.
- **It reconciles as a MATCH against the current instrument.** A pre-#170 record carries `requestShape` and no `judgeRequestHash`, so it is reconciled on the shape. The stored shape is `{maxTokens: 256, thinking: {type: "disabled"}}` — identical, key-sorted, to the current `{maxTokens: MAX_JUDGE_TOKENS, ...JUDGE_REQUEST_SHAPE}`, and hashing to the same `d1554a8ca60c`. Verified by calling `attachIdeaLevelScores` against a copy of the real store at `7f3f359`: it returns the idea-level scores.
- **Therefore idea-level metrics remain licensed under §5.4, and the §5.1 gate does not need re-running.** No re-run, no re-spend, no re-registration.

**One precondition, registered because it is a real obligation on the analysis:** the reconciliation happens only when the caller passes **`requestShape` alongside `judgeRequestHash`**. A caller supplying the hash alone gets a **named refusal** — *"no current requestShape was supplied … Nothing has necessarily changed"* — distinct from the genuine changed-instrument diagnosis. That is a missing argument at a call site, **not** a stale verdict, and it must not be read as one.

**And the forward-looking consequence:** a future re-run under the current instrument writes under the **`req=`** key, which is a *different* key from the stored record's. It therefore **adds a second record rather than colliding** with the first. That is the concrete sense in which the key now separates instruments in addition to the append-only guard — the failure mode Appendix N item 8 feared (a `drop` and a `pass` sharing one key) can no longer arise, and a re-run no longer fails with a collision instead of a diagnosis.

---

## Appendix P — Amendments (dated 2026-09-10)

**`--max-spend` is now a limit rather than an estimate (#169, merged as `0c8b52f`, PR #174).** This appendix supersedes, by dated cross-reference, three registration statements the merge made false, and registers one thing that was never registered at all and matters more than the other three: **the ceiling is not exact, and its bound is now stated.**

**Nothing here is edited in place.** [Appendix L](#appendix-l--amendments-dated-2026-09-09), [Appendix M](#appendix-m--amendments-dated-2026-09-09) and [Appendix N](#appendix-n--amendments-dated-2026-09-09) are left exactly as written, including one mis-citation and one misfiled heading, both disclosed below rather than corrected in the text they occur in.

**No Stage 1a, Stage 1b or Stage 1c result depends on any of this**, and item 9 substantiates that against the merge diff rather than against the PR's description of itself.

### Item 1 — §8: Appendix L item 7's "no model of `effort`" is SUPERSEDED

[Appendix L](#appendix-l--amendments-dated-2026-09-09) **item 7** records that the projection `interimPriceGrid` "prices a plan from a flat assumed token shape and **has no model of `effort`**." That was true when written and is no longer true of the pricer a run actually uses. **Item 7 is not edited**; the statement is superseded here.

**The live path is `runnerPriceGrid`, not `interimPriceGrid`.** `runnerPriceGrid` is imported in `evals/run.mjs` and injected into `runSpec` as `priceGrid`. `interimPriceGrid` — which still lives in `evals/harness/runner.mjs` and whose own header calls it the "INTERIM default pricer" awaiting the real one — is `runSpec`'s default only when nothing is injected, and nothing in production reaches it. It is genuinely unchanged by the merge. **Registered explicitly because #169 names `interimPriceGrid` by name**, and a reader who greps the function the issue names will find it untouched and conclude, wrongly, that nothing shipped.

**The model is two-tier** (`lib/calibration.mjs`):

- **Tier 1 — per-arm empirical tokens.** For any arm with at least three completed cells anywhere in the store, the mean measured input/output tokens per cell. **Deliberately across any `configHash`**: a hash gates whether two cells may be *pooled as data*, not what a cell *cost*, and the re-collect that caused this defect was a re-collect of arms the store had already priced exactly. Restricting the fit to the current hash would have blinded the module in precisely the case it exists for. This is exact for a re-collect.
- **Tier 2 — per-slot `effort` output multipliers**, for arms the store has never run. Fitted from the store's **effort-homogeneous** arms where the store can support a fit, and otherwise from a static table derived from this study's own one-factor screening arms — same model, same N, 24 cells each:

| arm | `effort` | mean output tokens/cell | multiplier |
| --- | --- | --- | --- |
| `S1-ELOW` | low | 1,307 | 0.55× |
| `S1-C0` | high | 2,392 | 1.00× (baseline) |
| `S1-EMAX` | max | 14,745 | **6.16×** |

Only the **output** half scales; input held flat at ~362 tokens across all three levels, so a whole cell's ratio is below the multiplier (a solo cell prices `max` at roughly 4.9× `high`, not 6.16×). `S1C-RICH` is excluded from the effort *fit* because its slots are mixed (`max`/`max`/`high`/`high`/`low`) and stored cost rows are per **model**, not per slot — there is no honest attribution — while remaining eligible for a tier-1 fit, which needs none. A level the store cannot support keeps its **static** multiplier and says so, rather than falling through to 1.0, which is the original defect's exact shape.

### Item 2 — What remains UNMODELED: N — disclosed, not fixed

Registered because the honest treatment of an unmodeled term is disclosure, and because a silent fallback is what produced #169 in the first place.

**N — an arm's requested idea count — is unmodeled at tier 2.** The store shows it matters at the same model and effort: `S1-N10` 979, `S1-C0` (N=30) 2,392, `S1-N60` 4,177 mean output tokens. **Three points from one arm family is a curve drawn through the only data there is, not a model**, and it is not fitted.

The registered consequence: **a projection containing any tier-2 cell reports `usdHigh` and labels itself a FLOOR, not an estimate**, naming the arms it could not calibrate. `usdHigh` is the point estimate times `UNCALIBRATED_HIGH_FACTOR` = 2.5, the observed miss on the Stage 1c re-collect ($41.59 projected against $105.22 actual). Tier 1 subsumes N for any arm the store has seen. **Mid-flight admission compares against `usdHigh`, never the point estimate** — over-projection stops a run early and a `budget_exceeded` skip is store-absent and re-plans, whereas under-projection spends money that does not come back.

### Item 3 — §8: Appendix L item 7's cumulative gap was DOCUMENTATION, not behaviour

The second stale statement in [Appendix L](#appendix-l--amendments-dated-2026-09-09) **item 7** is what it does *not* say. Item 7 registers `--max-spend 180` — raised to **$220** by [Appendix M](#appendix-m--amendments-dated-2026-09-09) **item 6, "Cost"** — without recording that the ceiling is **cumulative**: it counts every prior invocation and every `configHash` in the store, not just the current invocation. That Appendix M item states the cumulative fact in passing, and correctly attributes the omission to Appendix L **item 7**; what it does not do is put the fact anywhere an operator reads at run time.

**That behaviour is correct, was correct then, and is unchanged.** The operator who filed #169 read it as per-invocation on the first Stage 1c run. What shipped is documentation of what already happened — a `--help` section headed `THE CEILING IS CUMULATIVE, NOT PER-INVOCATION` (there was no `--help` at all before; usage lived in a header comment no operator sees), a new `docs/spend-ceilings.md`, and a run-time log line naming `spent-to-date` as that history and printing the remaining headroom.

**Registered plainly: the gap was in the documentation, not in the instrument.** No cell was priced differently before and after, and the escape hatch was always `--results-dir`.

### Item 4 — **The ceiling is NOT exact.** The overshoot bound, registered

**This is the most consequential item in this appendix, and it registers something no prior appendix stated.** [Appendix L](#appendix-l--amendments-dated-2026-09-09) item 7's language — "`--max-spend` refuses earlier than it needs to, never later" — implies an exact ceiling. **It is not one, and this is the bound.**

**A cell already dispatched when the ceiling trips is allowed to COMPLETE. It is not aborted.** The money is spent the moment the provider accepts the request, so aborting discards work already paid for and buys nothing back; and a partial write into an append-only store whose `put()` contract is byte-identical-or-throw is a durable hazard, not a saving. The harness answers this the same way everywhere else it arises.

**The guarantee `--max-spend` therefore makes:**

> **ceiling + the actual cost of everything that was in flight when it tripped**, bounded by `--cell-concurrency` cells.

At the default `--cell-concurrency 1` that is at most one cell. **`scripts/run-study1c.sh` runs at `CONCURRENCY=8`** ([Appendix I](#appendix-i--amendments-dated-2026-09-08) item 7's registered 4–8 band, at its top), **so for the registered Stage 1c run the bound is the ceiling plus up to eight cells' actual cost.** A reader who takes away "at most one cell" will size a ceiling wrong.

**Every ceiling-gated run now prints that worst-case bound before it dispatches anything**, computed from the concurrency actually in force and the `cellConcurrency` **most expensive** planned cells — any subset of that size can be the one in flight — and priced at `usdHigh` wherever the projection is tier-2, because a bound built on a floor is not a bound:

```
[max-spend] worst-case stop=$224.9400 (ceiling $220.0000 + up to 8 in-flight
            cell(s) at --cell-concurrency 8, worth $4.9400). A cell already
            dispatched when the ceiling trips is allowed to COMPLETE rather
            than be discarded, so this -- not the ceiling -- is the number to
            size against.
```

**Registered as a design decision, not an implementation detail.** The alternative — strict abort — buys a hard ceiling at the price of discarded paid-for work and possibly half-written records. Complete-the-cell buys a deterministic, bounded, concurrency-proportional overshoot with a consistent store. That trade is made deliberately, and the reason it is *printed at plan time* rather than only documented is that #169's complaint is that `--max-spend` reads as absolute and is not: an overshoot discovered only afterwards reproduces the same complaint in a smaller form.

### Item 5 — Two review findings fixed before merge, because both bear on how the number is read

Registered rather than left in a merged PR's review thread, because each one changes what a printed figure means.

**(a) The judge-leg check double-counted a settled cell against itself.** The mid-flight gate compares `spent-to-date + runningTotal + inFlightTotal + this leg`. A cell that had settled sat in `runningTotal` **and** still held its `inFlightTotal` reservation, so its cost was counted twice and the effective ceiling ratcheted downward for every remaining cell of the run. Fixed by releasing the reservation on settlement — after the actual cost is posted, so there is no window in which a cell's money is counted by neither term, and idempotently, so a cell that returned before ever being admitted (a payment abort, a budget skip) can be released unconditionally.

**(b) The pre-flight verdict word disagreed with the gate.** The banner computed "within budget" / "over budget" on the **point estimate** while admission gated on **`usdHigh`**. A run could print "within budget" and then immediately start skipping cells. Fixed by computing the verdict word on the admission basis. The point estimate stays visible in the line as the honest centre of the range, with the upper bound named next to it; only the pass/fail word moved onto the binding arithmetic.

**And the nuance that governs how the word should be read.** **"Over budget" means *"priced the way admission will price it, this plan crosses the ceiling."*** It is **not** a spend prediction. Where the projection is a floor, the verdict is deliberately computed on a bound that is expected to over-state, because the error direction is asymmetric: refusing early is recoverable and over-spending is not.

### Item 6 — Appendix M item 10's two failures are CLOSED — and where that item actually is

**A locating note first, because the heading is ambiguous in the rendered document.** The item superseded here is the one titled **"The spend ceiling did not bind, again"**. It belongs to [Appendix M](#appendix-m--amendments-dated-2026-09-09), and it is the item this document has cited as **Appendix M item 10**. It was appended at the **file tail** rather than into Appendix M's section, so it sits after [Appendix N](#appendix-n--amendments-dated-2026-09-09) item 12 and immediately before [Appendix O](#appendix-o--amendments-dated-2026-09-10), and therefore **renders under Appendix N's heading**. Appendix N has its own `### Item 10`, titled **"Judge refusals are MISSING scores, not low ones"**, which is a **different item and is not touched by this appendix.**

**It is deliberately NOT moved.** Append-only discipline is the whole point of this document, and a reader diffing the file must never find historical registration text relocated — that is indistinguishable from tampering. Cite the two by title, never by "item 10" alone.

**Both failures that item records as open are now addressed:**

1. **Mid-flight enforcement, extended to judge legs.** Stated precisely so it is not read as more than it is: **mid-flight enforcement for generation cells already existed** — per-cell gating since #51/#62, against *actual* accumulated spend since PR #76. **Judge legs were entirely unguarded.** A leg was dispatched unconditionally and its cost recorded only afterwards, so a run could stop admitting generation cells at the ceiling and keep spending on judging indefinitely. That was the real gap, and judge spend is the dominant OpenAI cost driver. Legs are now gated in the same shape a generation cell is — actual-so-far + in-flight + this leg's projection — priced with the **real** candidate count rather than a plan-time estimate, and skipped as a classified `budget_exceeded`, store-absent so the leg re-plans.
2. **The ceiling checked against funding.** [Appendix K](#appendix-k--amendments-dated-2026-09-09)'s finding was that the ceiling sat above the account balance. **No readable balance endpoint exists on either provider, and the absence is itself the registered finding.** Anthropic's public API exposes no remaining-balance or credit endpoint an API key can read — its Admin API covers members, workspaces, keys and *historical* cost reports, and requires an admin key the harness does not hold; OpenAI's dashboard billing figures come from session-authenticated endpoints, not API keys. So no balance is queried and none is faked. The nearest honest instrument is an **operator-asserted** `--account-balance USD` (or `IDEATE_ACCOUNT_BALANCE_USD`), compared at plan time against **headroom** (`ceiling − spent-to-date`), not against the raw ceiling — most of a cumulative ceiling may already be paid for, and comparing the ceiling itself would cry wolf on every resumed run. **Omitting it is announced out loud** rather than passing silently.

### Item 7 — A citation correction, recorded and NOT applied in place

**Every statement superseded by items 1 and 3 of this appendix lives in [Appendix L](#appendix-l--amendments-dated-2026-09-09) item 7, "§8: cost, and why the projection under-states it."** Appendix L **item 5** is "the prediction, registered in advance" — the arithmetic predicting `S1C-RICH` should clear `S1C-SOLO60`. It contains no pricing statement, **it is untouched by this appendix, and it stands.**

This matters because the wrong citation propagated into **five** places. The item titled "The spend ceiling did not bind, again" cites "(Appendix L item 5)" for the `effort` statement; [Appendix M](#appendix-m--amendments-dated-2026-09-09) item 6 cites it for the floor-not-a-forecast reasoning; and so do #169, PR #174's own amendment note, and `lib/calibration.mjs`'s header comment. **None of those are edited** — the appendix text because this document is append-only, the code comment because this amendment touches `docs/PREREGISTRATION.md` and nothing else.

**The hazard being closed is concrete:** a reader following that citation lands on a live, unsuperseded *prediction* and may read it as retracted. It is not. **Where any of those five places says "Appendix L item 5" in connection with pricing or `effort`, read "Appendix L item 7."**

**A second, independent mis-citation, recorded for the same reason.** `scripts/run-study1c.sh`'s `MAX_SPEND` constant is annotated `# Appendix L item 7, amended by Appendix M item 5`. The first half is right; the $220 amendment is [Appendix M](#appendix-m--amendments-dated-2026-09-09) **item 6, "Cost"** — item 5 is "The hash moves; the control cells are reused, per-arm and by name," which sets the per-arm `configHash` pooling rule and contains no ceiling. The script is **not edited by this appendix**; the correction is registered here.

### Item 8 — [Appendix L](#appendix-l--amendments-dated-2026-09-09) item 9's reproduction command stands; its projected figure does not

Registered because it is the one place a reader is most likely to try to reproduce a number and quietly fail to.

The command is unchanged and still correct: `./scripts/run-study1c.sh --dry-run`. **What it prints has changed, for two independent reasons**, and neither is a regression:

1. The `--dry-run` branch passed **neither `--results-dir` nor `--max-spend`**, so it priced against the **default** store — a different, near-empty ledger — reporting neither this study's spent-to-date nor the projection the real invocation is admission-controlled against. A dry run that prices the wrong store reads as a rehearsal and is not one. Fixed in the same merge; the script's real invocation was never affected.
2. The pricer itself now carries item 1's calibration, and the dry run additionally prints a `[max-spend]` banner, a `[calibration]` basis, a `[balance]` line and item 4's worst-case bound.

**Consequence, stated so it is not mistaken for a result changing:** Appendix L item 7's **$55.04 batched / $110.07 un-batched** projection for 432 cells is a **historical record of what the instrument said on 2026-09-09**, not a figure the current tree reproduces. Item 7's own reasoning about why that projection was too low is exactly what item 1 fixes. **No collected cell, no arm and no reported contrast is affected** — only the plan-time readout.

### Item 9 — This retracts NO result, and no cell is re-keyed

Stated last and explicitly, as [Appendix O](#appendix-o--amendments-dated-2026-09-10) item 5 does, so nothing above is read as a withdrawal.

**Verified against the merge diff at `0c8b52f`, not against the PR's description of itself.** The commit touches thirteen files: `.gitignore`, `README.md`, `docs/spend-ceilings.md`, `evals/run.mjs`, `evals/harness/runner.mjs`, `lib/price.mjs`, `lib/calibration.mjs`, `scripts/run-study1c.sh` and five test files. **`arms.config.json`, `prompts.mjs`, the judge prompt and the corpus are absent from the diff**, and `harnessVersion` is unchanged.

`configHash` covers `harnessVersion` / `engineSha` / `promptHash` / `judgeHash` / `embedderId` / `armsConfigHash` / `corpusHash` / `clusterDistanceThreshold`. **`engineSha` is checked separately and explicitly**, because `evals/run.mjs` *is* in the diff and a source-derived engine hash would have re-keyed the whole store: it resolves to `ideate-core@${engineVersion}` — the **resolved `ideate-core` dependency version**, not a hash over harness source — and the merge changes no dependency (`package.json` is absent from the diff). **No hashed input moved. No stored cell is re-keyed. No Stage 1a, Stage 1b or Stage 1c result depends on anything in this appendix**, including the registered contrasts `S1b-1`, `S1c-1` and `S1c-2`, [Appendix M](#appendix-m--amendments-dated-2026-09-09) item 9's **+1.6728**, and [Appendix N](#appendix-n--amendments-dated-2026-09-09) item 9's passing §5.1 verdict.

What changed is **how much a future run is permitted to spend and how honestly it says so beforehand** — an instrument-safety property, not a measurement.
