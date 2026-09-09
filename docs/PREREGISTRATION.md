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

