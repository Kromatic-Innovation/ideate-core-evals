# Study 1 Stage 1a — raw results (2026-09-08)

The complete result store from the Stage 1a screening run registered in
[`docs/PREREGISTRATION.md` Appendix F](../../docs/PREREGISTRATION.md#appendix-f--amendments-dated-2026-09-08).
**956 records** — 192 planned generation cells (191 `completed`, 1 `failed`), plus every judge
call and judge-score record. Written as one JSON object per line: `{index, body}`, where
`index` is the store's index row and `body` is the stored body.

Summary of the run and its analysis: [`docs/status-2026-09-08.md`](../../docs/status-2026-09-08.md).
Per-cell metrics as a flat table: [`docs/study1-stage1a-cells.csv`](../../docs/study1-stage1a-cells.csv).

## What is here, and the one thing that is not

Every generated idea, every judge call and score, each cell's terminal accounting state, and
the token-level cost rows are present verbatim.

**`result.pool` — the Voyage-4-lite embedding vectors — has been removed.** It was **97.9%** of
the store (124.3 MB of 127.0 MB); the idea text is 1.7 MB and all other metadata 1.0 MB.
Stripping it takes the artifact from 130 MB to 2.9 MB.

That is a safe removal because the vectors are **derived, not primary**: they are a deterministic
function of the candidate text under the pinned embedder and registered threshold, and
re-embedding this entire run cost **$0.0034** (the `excluded (non-provider)` line in the run's
own spend report). Any metric defined over embeddings — `distinct_k`, `poolDiversity`, and the
rarefaction in Appendix C — can be recomputed from what is here for well under a cent. The
computed values are also already stored per cell (`result.distinct_k`, `result.poolDiversity`,
`result.collapseRate`), so the headline numbers need no recomputation at all.

## Why this lives in `data/` rather than as a tracked store

`.gitignore` excludes `results/` with the stated reason "Never commit raw provider replies (they
can be large and may echo brief text under NDA)". Sibling stores created by `--results-dir`
(Appendix D item 3) were never added to that rule, so `results-study1/` slipped past it; the
pattern is now extended. The local store remains the harness's working copy — additive,
resumable, and holding the vectors — while this file is the publishable artifact.

The NDA half of that warning does not bind here: every brief in the 48-brief corpus is already
public in this repository (`evals/corpus/briefs.mjs`), and `prod-07` is a verbatim published
prompt. The size half did bind, and this is the response to it.

## Reproducing the analysis

`state: "completed"` generation records carry `result.distinct_k` directly. The failed record
(`arm=S1-N10|brief=prod-07|rep=1`) carries its classification in `accounting.detail` — a
`parse_failure` where the model returned one JSON object containing all ten ideas as a numbered
list, with a raw control character in the string; it stopped on `end_turn`, so it is format
collapse rather than truncation.

The mixed-effects fits reported in the status document take
`{arm, brief, y: distinct_k}` rows into `evals/analysis/sidecar/fit_mixedlm.py` at rung `R0`
with `referenceArm: "S1-C0"`. Note that the registered H1–H5 family is deliberately **not**
built for this run — Appendix F item 7 records why, and issue `#145` records the hazard that
makes it matter.
