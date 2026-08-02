# Fetching the Si et al. 2024 expert-score slice

The judge validation gate (`evals/judge/gate.mjs`, `docs/PREREGISTRATION.md` §5)
is floored on Si et al.'s reported human-human agreement and validated against a
held-out slice of their expert-scored ideas. That slice is **fetched locally and
never redistributed in this repository** — it lives under the gitignored
`data/si-et-al/` (see `.gitignore`). This document is enough to reproduce the
fetch and the join without shipping the payload. It does **not** contain any of
the payload itself.

## Source

| | |
|---|---|
| Paper | Si, Yang & Hashimoto 2024, *Can LLMs Generate Novel Research Ideas?* |
| arXiv | [2409.04109](https://arxiv.org/abs/2409.04109) |
| Code (MIT) | [NoviScl/AI-Researcher](https://github.com/NoviScl/AI-Researcher) |
| Review data | `reviews_ideation/data_points_all_anonymized.json` (scores + rationales), `reviews_ideation/id_title_mapping.csv` (ID → title) — in the MIT-licensed repo |
| Idea payloads | Google Drive archives linked from the repo README (the three condition directories below) |

## Terms

- The **code repository** (`NoviScl/AI-Researcher`), including the review JSON and
  the id→title mapping, is **MIT-licensed** — attribution retained; not
  redistributed here only because it is large and out of this study's scope, not
  because of a licence restriction.
- The **Google Drive idea archives** carry no bundled README, LICENSE, or terms
  file in any of the three archives (checked on fetch, #16). Absent explicit
  terms, we treat them as **fetch-for-research, do-not-redistribute**: they are
  used locally for validation and never committed or echoed into logs, the
  store, or `REPORT.md`. Verify the Drive terms before any redistribution — this
  is the "verify Drive payload terms before redistribution" caveat recorded in
  `docs/PREREGISTRATION.md` §4.

## Layout under `data/si-et-al/`

```
data/si-et-al/
  id_title_mapping.csv                 ID → Title (e.g. `Bias_1_Human,Mitigating first name biases…`)
  data_points_all_anonymized.json      column-oriented reviews (a dict of equal-length arrays)
  Human_Ideas_Txt_Processed/    49 files   condition = Human       (NOT named by title)
  AI_AI_Ideas_Processed/        49 files   condition = AI          (named by slugified title)
  AI_Human_Ideas_Txt/           49 files   condition = AI_Rerank   (named by slugified title)
```

49 × 3 = **147**, matching the 147 unique `idea_id` values in the reviews.

`data_points_all_anonymized.json` is **column-oriented** — a dict of ~20
equal-length lists (`overall_score`, `novelty_score`, `feasibility_score`,
`effectiveness_score`, `excitement_score`, `confidence_score`, a `*_rationale`
per axis, `topic`, `condition`, `idea_id`, `timestamp`, `consent`, `no_ai`,
`familiarity`, `experience`, `minutes`) — not a list of records. The gate reads
`overall_score` as the expert signal by default (`slice.mjs` `DEFAULT_SCORE_FIELD`).

## The join (implemented in `evals/judge/slice.mjs`)

- **Key is `(directory, filename)`, not filename alone.** `AI_AI_Ideas_Processed/`
  and `AI_Human_Ideas_Txt/` contain **identical filenames** (e.g. both hold
  `adaptive_confidence-guided_prompting.txt`); the directory is the only thing
  distinguishing AI from AI_Rerank, so it is part of the key and it determines
  the condition.
- **Human condition joins by the file's `Title:` line**, because the human files
  are named `HumanIdeaForm_<name>.txt` / `IdeaGeneration_<name>.txt`, not by
  title. The reader reads the `Title:` first line → normalizes (case,
  punctuation, whitespace; `normalizeTitle`) → matches `id_title_mapping.csv` →
  `idea_id`. AI/AI_Rerank files resolve through the same normalized-title lookup
  (their `Title:` line, falling back to the filename slug).
- **The mapping's second column is `Title / Filename` — a title for Human rows,
  a *filename* for the AI rows (issue #35).** The AI rows hold a `.json`
  filename, sometimes with a trailing space, e.g.
  `temporal_bias_decay_simulation.json ` — not a prose title. Before comparison
  the reader strips a trailing `.json`/`.txt` extension and surrounding
  whitespace from the mapping value (`stripMappingExtension`), so the
  filename-style value normalizes to the same token stream as the idea file's
  `.txt` stem and joins. One source `idea_id` also carries a stray internal
  space (`'Bias_1 _AI_Rerank'`); it falls in the excluded condition (below), but
  the parser tolerates it.
- **Totality is asserted both directions.** Every idea file in an *included*
  condition must resolve to an `idea_id`, and every `idea_id` in the reviews
  *under an included condition* must resolve to exactly one idea file. A partial
  join **throws** rather than silently shrinking the slice.

### Excluded conditions (issue #35)

The reader drops a whole condition only by **explicit, named configuration**
(`DEFAULT_EXCLUDED_CONDITIONS` in `slice.mjs`, default `["AI_Rerank"]`). An
excluded condition's directory is skipped whole and its review `idea_id`s are
removed from **both** totality checks; the exclusion and its reason are returned
in the read result (`exclusions`) so they reach the validation record and
`REPORT.md`. This is the **only** carve-out — an unresolved file in an included
condition still throws; exclusion is never a general "drop what doesn't join".

- **`AI_Rerank` (`AI_Human_Ideas_Txt/`, 49 files) — excluded.** Operator
  decision, 2026-08-02. Of its 49 filenames, only **18** also appear in
  `AI_AI_Ideas_Processed/` and are suffix-swap recoverable; the other **31** draw
  from a larger generated pool than the AI condition's 49 sampled ideas and
  **cannot have their `idea_id` recovered from the released mapping at all**
  (the mapping contains zero `*_AI_Rerank` rows — 54 review idea_ids appear
  nowhere in it). Including only the recoverable 18 would represent the condition
  by a non-random 37% subsample. Validation needs a *reliable* expert-scored set,
  not a complete one — **Human + AI (98 ideas)** is sufficient. To include it
  later (e.g. if a source for the 31 is found), pass `excludedConditions: []` (or
  a narrower list) and register the recovery.

### Hand-resolved near-misses

A genuine straggler in an *included* condition — one whose `Title:` line and
filename stem normalize to no mapping value — is bound by an explicit
`HAND_RESOLVED_IDEA_IDS` override in `slice.mjs` (`<dir>/<filename>` → `idea_id`,
validated against the reviews so a mistyped override throws rather than silently
mis-binding). The default map is **empty**.

- **`Human_Ideas_Txt_Processed/IdeaGeneration_Soham.txt`** — the one Human file
  (of 49) that the other 48 `HumanIdeaForm_*` files' `Title:`-line join does not
  cover (issue #35). The `stripMappingExtension` normalization above resolves it
  automatically **iff** its mapping value is a filename; the real-data run (#16)
  confirms this. **If it is still unresolved there,** the operator adds one line
  to `HAND_RESOLVED_IDEA_IDS`, e.g.
  `"Human_Ideas_Txt_Processed/IdeaGeneration_Soham.txt": "<its idea_id>"`, and
  records the reason here, so the mapping stays auditable and reproducible.

> **Operator confirmation still required (issue #35).** The acceptance criteria
> that reference the *real* slice — all 49 AI files resolve, all 49 Human files
> (incl. Soham) resolve, and `readSiEtAlSlice()` returns 98 ideas with non-empty
> `expertScores` — can only be checked with `data/si-et-al/` present. The build
> lane implemented and **hermetically** tested the mechanisms (extension
> normalization, named exclusion, hand-resolution override); running the real
> join and confirming the counts (and adding the Soham override if the automatic
> resolution does not cover it) is the operator's step, on #16.

## Two leakage hazards (closed; `PREREGISTRATION.md` §5.3)

1. **Filename format reveals condition.** `HumanIdeaForm_*` / `IdeaGeneration_*`
   vs a slugified-title filename tells you human-vs-AI before a word is read.
2. **Human idea writers' first names are in the human filenames** (the review
   data is anonymized by the authors; the idea *filenames* were not — contents
   were spot-checked clean).

Both are closed structurally: `slice.mjs` returns idea **text** (contents) plus
condition on the **harness** side; `sliceToJudgePool()` yields **text-only**
judge inputs (re-asserted by `deidentify.mjs`), and no path, filename, directory,
or condition label is ever part of a judge payload, the store, a log, or
`REPORT.md`. Condition is joined back only **after** scoring.

## Reproducing the 56.1% floor (the #16 real-data run — out of scope for the build)

The registered floor is Si et al.'s reported **56.1%** human-human split-half
top/bottom-25% balanced accuracy (`SI_ET_AL_BALANCED_ACCURACY_FLOOR`). The
construction is implemented as `balancedAccuracySplitHalf()` in `gate.mjs` and is
exercised hermetically on a synthetic fixture here. **Reproducing 56.1% from the
real released reviews requires the payload above and is the human-gated #16
real-data run** — it cannot run in CI (the payload is never committed), and it is
deliberately not part of this build (issue #24 "Out of scope": *running the
validation for real against the fetched slice*).

Two things must be settled in that run before the reproduced number is trusted:

- **The split is random.** Report the **distribution** across repeated splits
  (state the seed), not a single lucky draw. `balancedAccuracySplitHalf` returns
  every draw plus the mean for exactly this reason.
- **Review-count discrepancy — 337 vs 298.** The release carries **337** reviews;
  the paper states **N = 298 unique reviews**. This gap must be **investigated
  and its resolution documented here before any reproduction is claimed** — it
  may be a filtering step the paper applies and the release does not, and
  applying it (or not) could move the reproduced accuracy. **Do not tune until
  56.1% appears.** If the gap cannot be explained, say so and hold the floor
  unregistered rather than registering a number matched by accident.

Until that run lands, the floor is registered at 0.561 on the strength of the
paper's reported figure; if the reproduction fails, the floor is revisited (#16),
not silently kept.
