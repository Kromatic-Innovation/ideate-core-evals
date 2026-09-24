# Human-anchor panel — scoping and costing (issue #52)

## 1. What this is, and what it is not

This is a **scoping and costing document.** It prices a crowdsourced Prolific
rating panel, determines the ethics/consent path, and registers where the
panel's result sits (confirmatory or exploratory) — the three things issue
#52's acceptance criteria ask to be settled before anyone decides to run it.

**It commits no spend.** No Prolific study is created, no wallet is funded, no
participant is recruited. **It collects no data.** Nothing here changes
`configHash`, touches a results store, or affects any registered contrast in
`docs/PREREGISTRATION.md`. The go/no-go decision — whether the panel actually
runs — stays with the operator, per issue #52's own framing. §6 below states
this document's recommendation; it is a recommendation, not an authorization.

## 2. The gap it closes

Per issue #52 and the 2026-09-01 adversarial review it cites: **no human ever
evaluates the study's own outputs.** Every number the study reports is
embedding-derived (`distinct_k`, DAT) or LLM-derived (the judge). `distinct_k`
is validated against NoveltyBench's *definition* and against DAT *ordering*,
and the judge is calibrated against Si et al. — but neither check puts a human
in front of this study's own pools and asks the question `distinct_k` claims
to operationalize: "how many genuinely different ideas are in this pool?" The
Si et al. key calibrates the **judge** on multi-page NLP research proposals;
it says nothing about whether pool-level clustering matches human judgement on
this study's own briefs. This document does not re-argue that gap further —
see the issue body for the full case.

## 3. The instrument as scoped

- **Platform: Prolific, not Mechanical Turk** — screened participants, the
  academic-work default, and (§4 below) a documentable ethics path.
- **~40 pools**, de-identified, sampled across arms and strata from the
  study's actual generated pools (this panel runs on real output, not
  synthetic pairs — see §6).
- **De-identification is already guaranteed by the harness, not by this
  panel's design.** `evals/judge/deidentify.mjs`'s `deidentifyPool(pool, arm)`
  is the single choke point every candidate passes through before it reaches
  a judge: it whitelists the candidate's `.text` field and drops
  `arm`/`model`/`persona` (and any future identity-bearing field, since it
  whitelists rather than blacklists), never mutating the input pool. Built for
  the LLM judge (issue #4, so H5's same-provider bias term is testable), it
  produces exactly the label-free pool shape a Prolific rater must see. Note
  the actual path is `evals/judge/deidentify.mjs` — an earlier draft of this
  scoping work cited `evals/harness/deidentify.mjs`, which does not exist.
- **Presentation order randomized** — `evals/judge/order.mjs` already seeds a
  deterministic shuffle for judge calls for the same position-bias reason
  (§5, PREREGISTRATION.md); the same mechanism applies candidate order for a
  rater as it does for the judge.
- **2 raters per pool**, so inter-rater agreement is reportable — one rater
  cannot support a reliability claim.
- **Task: count semantically distinct ideas in the pool.** Deliberately
  simple, matches `distinct_k`'s construct directly, and needs no rater
  training — which is what makes it crowdsourceable at all.
- **Report:** correlation between the human distinct-count and `distinct_k`,
  plus inter-rater agreement between the two raters per pool.

## 4. AC1 — verified per-rater cost and total

**Base design:** 40 pools × 2 raters = **80 submissions**. At ~5 minutes per
submission: 80 × 5 = **400 rater-minutes = 6.667 rater-hours**.

### Verified Prolific rates (retrieved 2026-09-24)

Read from Prolific's published researcher documentation via search-result
extracts on 2026-09-24, restricted to `prolific.com` /
`researcher-help.prolific.com`. These are **not** loaded live from the pages
themselves, and Prolific can change them — re-check with Prolific's own
calculator (https://www.prolific.com/calculator) before actually launching.

| Fact | Value | Source |
| --- | --- | --- |
| Minimum reward Prolific allows | £6.00 / $8.00 per hour | https://researcher-help.prolific.com/en/articles/445266-how-much-should-i-pay-participants |
| **Recommended** reward | £9.00 / $12.00 per hour | https://researcher-help.prolific.com/en/articles/445266-how-much-should-i-pay-participants |
| Platform fee (commercial/corporate) | **42.8%**, added on top of the reward | https://researcher-help.prolific.com/en/articles/445239-what-is-your-pricing |
| Platform fee (academic/non-profit) | **33.3%**, added on top of the reward — requires an institutional email domain | https://researcher-help.prolific.com/en/articles/445239-what-is-your-pricing |
| Contract terms | Pay-as-you-go: no subscription, no contract, no stated minimum study spend | https://researcher-help.prolific.com/en/articles/445129-study-cost |
| VAT | May apply depending on researcher location/VAT status; shown separately on the quote | https://www.prolific.com/pricing |

`package.json`'s `author` field names **Kromatic Innovation** — a company,
not a university — so the **42.8% commercial rate is the one that applies**
unless the panel is run under an academic or non-profit collaborator's own
Prolific account with an institutional email domain (§5, §7).

### The arithmetic, step by step

**At the recommended rate (£9.00 / $12.00 per hour):**

| Step | GBP | USD |
| --- | --- | --- |
| Per-submission reward (5 min at the hourly rate) | £9.00 × 5/60 = **£0.75** | $12.00 × 5/60 = **$1.00** |
| Reward subtotal (80 submissions) | 80 × £0.75 = **£60.00** | 80 × $1.00 = **$80.00** |
| + platform fee, commercial (×1.428) | £60.00 × 1.428 = **£85.68** | $80.00 × 1.428 = **$114.24** |
| + platform fee, academic/non-profit (×1.333) | £60.00 × 1.333 = **£79.98** | $80.00 × 1.333 = **$106.64** |

VAT is **excluded** from every figure above and may be added on top, depending
on the researcher's location and VAT status.

**At the floor rate (£6.00 / $8.00 per hour) — for comparison only:**

| Step | GBP |
| --- | --- |
| Per-submission reward | £6.00 × 5/60 = **£0.50** |
| Reward subtotal | 80 × £0.50 = **£40.00** |
| + platform fee, commercial | £40.00 × 1.428 = **£57.12** |
| + platform fee, academic | £40.00 × 1.333 = **£53.32** |

**The study should pay the recommended rate, not the floor.** The delta
between recommended and floor, fee-loaded, is small in absolute terms — about
£26–29 depending on fee tier (£28.56 commercial, £26.66 academic) — against
two things that matter more than the saving: data quality (the minimum rate
selects for speed over the attention this task specifically needs — counting
distinct ideas is a judgement call, not a click-through) and the ethics story
(§5) a reviewer will read the same way a reviewer reads a citation: the
recommended rate is Prolific's own quality signal, and paying the minimum
against a task requiring judgement invites exactly the "did you actually
try" question raised by the AC1 in the first place.

### Verdict against the issue's own estimate

Issue #52 estimated **$100–150**, from unverified general knowledge, flagged
in the issue body itself as unchecked (cwc#2064). The verified figure —
**≈$114.24 commercial / ≈$106.64 academic, both ex-VAT** — lands at the **low
end** of that range. The order of magnitude in the issue holds. What the
issue never had, and this document now supplies: **the per-submission
figure is £0.75 / $1.00**, and the total is driven almost entirely by the
platform fee, not the reward — the reward subtotal alone is £60.00/$80.00,
and the fee adds roughly £26–34 on top depending on tier.

### Sensitivity

At 5 minutes per submission the binding cost is **attention, not money** —
the whole panel is under $115. Two directions confirm the number stays small
even under a materially larger design, both computed at the recommended
$12.00/hour commercial rate:

| Scenario | Submissions | Rater-hours | Commercial total (ex-VAT) |
| --- | --- | --- | --- |
| Base (5 min, 2 raters) | 80 | 6.667 | **$114.24** |
| 10 min per pool (2 raters) | 80 | 13.333 | $160.00 × 1.428 = **$228.48** |
| 5 min, 3 raters | 120 | 10.000 | $120.00 × 1.428 = **$171.36** |

Both variants stay under ~$250.

## 5. AC2 — ethics/consent path, determined

This is a determination, not a menu, and it is written down here so
"we didn't think we needed it" — the answer issue #52 calls unacceptable —
is never the true answer.

**The facts this reasons from:** this is human-subjects data collection, run
by a company (Kromatic Innovation), not federally funded, with no
institutional IRB of record.

**The determination.** No institutional IRB exists to grant or deny
approval for this panel, so there is no approval to obtain. What there is,
and what this section is, is a **documented exemption determination made by
the operator's own reasoning** — never an IRB approval, and it must never be
described as one anywhere the panel is discussed.

**Why the panel is minimal-risk.** Participants read de-identified idea text
(no arm, model, or persona label — §3) and return a count. No personally
identifiable information is collected from participants beyond Prolific's own
participant ID (needed only to pay them, and handled per the data rule
below). No sensitive category of information is touched. There is no
deception — the task is exactly what the consent screen says it is — and no
intervention on the participant beyond the rating task itself.

**Consent screen — required content:**

- Who is running the panel and why (a research/product-quality study of an
  idea-generation tool).
- What the task is: read a set of short idea descriptions and count how many
  are genuinely distinct ideas.
- How long it takes (~5 minutes) and what it pays (§4).
- That participation is voluntary and may be withdrawn at any time without
  penalty.
- That only Prolific's own participant ID is retained, and what it is
  retained for (payment and, until aggregation, response matching).
- That no free text is collected beyond the distinct-idea count — or, if a
  free-text justification field is added later, that it is screened before
  any human review and never entered into a committed artifact verbatim.
- A contact address for questions (an operator-designated address; not named
  in this document, since it is public and this content is not final until
  launch — §7).

**Data handling rule, registered here:** **no Prolific participant ID, and no
other participant identifier, enters the results store, `REPORT.md`, or any
committed artifact.** Only aggregate counts (per-pool distinct-count,
inter-rater agreement statistics, the correlation against `distinct_k`) are
committed. If a raw export is retained at all, it is retained **outside this
repository** — never committed — and only the derived, de-identified table is
checked in.

**Superseding condition.** If this panel is ever run under an academic
collaborator's own Prolific account (§4's academic fee tier), that
collaborator's institutional IRB becomes the governing body for the panel,
and this determination is superseded by theirs — this document's reasoning
no longer applies once a real IRB exists to apply instead.

## 6. AC4 — go/no-go recommendation for the operator

**Recommendation: GO**, sequenced **after the grid completes and before
`REPORT.md` is finalized**, at the verified commercial cost of **£85.68 /
≈$114.24, ex-VAT** (§4).

This follows the operator's own 2026-09-02 decision on issue #52: the panel
"gates no phase" and "needs the study's own pools as input, which do not
exist until generation has run" — running it earlier would have been
backwards regardless of cost. The recommended sequencing point — after the
grid, before the report is written — is the earliest point at which the
panel's inputs (real, sampled pools across arms and strata) exist, and the
latest point at which its result can still change what `REPORT.md` says.

**What the £85.68/$114.24 buys, concretely:**

1. **An external anchor for `distinct_k`** on the study's actual generated
   pools, rather than on synthetic pairs — the specific gap §2 describes.
2. **A human-labelled check on the model-generated clustering threshold.**
   The registered `clusterDistanceThreshold` (`0.23141118234233987`) is
   calibrated in Voyage embedding space and registered in
   `docs/PREREGISTRATION.md` **Appendix B, Item 8** ("§4.1/§3.4/§12: the
   equivalence threshold is calibrated in Voyage space, with numbers, hash,
   and disclosed provenance," issue #44 item B4) — its 108 calibration pairs
   are model-generated (disclosed there). The panel is the natural place to
   test whether that threshold agrees with a human's judgement of
   "genuinely different idea." **Note:** issue #52's own 2026-09-02 operator
   comment attributes this threshold's registration to issue #42; grepping
   `clusterDistanceThreshold` in `docs/PREREGISTRATION.md` finds it
   registered under **Appendix B, Item 8, issue #44 item B4** instead — this
   document cites what was actually found.
3. **Inter-rater agreement** between the panel's two raters per pool — the
   figure a reviewer at a creativity-focused venue (ICCC, C&C, CHI) asks for
   first, per issue #52.

**No-go fallback, stated explicitly.** If the operator declines to run the
panel, the limitation does not disappear — it is carried forward as a
standing entry in §10's threats-to-validity table, registered in
`docs/PREREGISTRATION.md` Appendix Q, Item 2 (dated 2026-09-24): "no human
evaluates the study's own outputs" stands as a real, undischarged residual
until this panel (or an equivalent) actually runs.

## 7. Open items that remain the operator's

- **A live Prolific quote at launch.** The rates in §4 are 2026-09-24
  documentation figures, not a quote — re-check against
  https://www.prolific.com/calculator before funding the study.
- **Whether an academic collaborator runs it.** This changes both the fee
  tier (§4: 42.8% vs 33.3%) and the ethics path (§5: this document's
  determination vs a real IRB).
- **Final pool sample size and stratification** — ~40 is this document's
  scoping figure; the exact count and how it is drawn across arms/strata is
  an operator call once the grid's actual pool inventory is known.
- **The consent text's final wording** (§5 lists required content, not final
  copy) and the contact address to publish on it.
