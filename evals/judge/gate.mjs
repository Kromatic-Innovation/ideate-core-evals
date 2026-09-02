// gate.mjs — the judge validation gate: fails closed, and lives in the store as
// a RECORD, not a runtime flag (issue #4, AC7/AC8/AC10; re-scoped by #24).
//
// ── What the gate measures (re-scoped, #24) ─────────────────────────────────
// docs/PREREGISTRATION.md §5.1 originally registered a **Spearman ρ ≥ 0.4**
// gate, "in the neighborhood of the human-human inter-rater agreement Si et al.
// themselves report — confirm their reported figure and set the floor to it."
// Verified against the paper on 2026-08-02 (#24): Si et al. do **not** report a
// human-human Spearman ρ, and footnote 11 explicitly rejects correlation-style
// agreement metrics for their data. The number the ρ gate reached for does not
// exist, so the gate cannot be instantiated as registered.
//
// The registered decision (recorded on #16, tracked into the pre-registration by
// #23) replaces the metric with Si et al.'s OWN: the split-half top/bottom-25%
// **balanced accuracy** construction of Lu et al. (2024), floored at Si et al.'s
// reported human-human figure, **56.1%** (SI_ET_AL_BALANCED_ACCURACY_FLOOR
// below). `spearmanRho` is **retained** — still computed and stored alongside
// the gate result as a descriptive statistic — it is simply no longer what the
// gate reads.
//
// ── The construction (Si et al. 2024, Section 5 / Table 11) ─────────────────
//   1. Rank the ideas by a REFERENCE signal (for the gate: the expert-consensus
//      score per idea; for the human-human floor: one random half of each
//      idea's reviews).
//   2. Take the top `quantile` and bottom `quantile` of ideas as the positive
//      and negative classes (default 25% each; the middle 50% is discarded —
//      too near the boundary to make a clean top/bottom decision).
//   3. Have an EVALUATOR signal (for the gate: our judge's score; for the floor:
//      the held-out other half of reviews) rank those same 2k labelled ideas,
//      and predict its own top-k as positive / bottom-k as negative.
//   4. Balanced accuracy = (sensitivity + specificity) / 2 over that 2k set.
// It is NOT a rank correlation rescaled to look like an accuracy — it is the
// genuine top/bottom-quartile balanced-accuracy metric.
//
// ── The validation record's key and shape ───────────────────────────────────
// Key: `judge-validation|judge=${judgeHash}|slice=${sliceId}` — reserved,
// namespaced so it can never collide with a real cell's `arm=...|brief=...`
// key shape (lib/manifest.mjs's cellKey), and scoped per judge-prompt-version
// (judgeHash) and per validation slice (sliceId identifies WHICH held-out
// expert-scored slice validated this judge — e.g. a Si et al. subset id).
// Record shape (#24 widened it from `{ rho, floor, verdict }` so a reader can
// confirm WHICH computation produced the verdict):
//   result = { kind: "judge-validation", metric, construction, n, accuracy,
//              floor, verdict, rho }
//     metric        = "balanced-accuracy" (the gate metric)
//     construction  = human-readable id of the exact split (see CONSTRUCTION_ID)
//     n             = number of ideas the accuracy was computed over
//     accuracy      = the balanced accuracy the gate read
//     floor         = the registered floor (SI_ET_AL_BALANCED_ACCURACY_FLOOR)
//     verdict       = "pass" (accuracy >= floor) | "drop"
//     rho           = Spearman ρ, retained as a descriptive statistic only
//   resolvedModels  = { judge: <judgeModelId or "mixed"> }
//   accounting      = { state: "completed" }
//   costRows        = []  (a validation record's OWN accounting is separate
//                          from the token cost of the calls that produced the
//                          judge scores; see meterJudgeCall)
//
// ── Fails closed: three-way disposition in attachIdeaLevelScores ────────────
//   1. no validation record for this judgeHash at all       -> THROW
//   2. a record exists, verdict "drop" (accuracy < floor)   -> pool-level only
//   3. a record exists, verdict "pass" (accuracy >= floor)  -> attach idea-level
// "Fails closed" means the ABSENCE of a record is treated exactly like a
// KNOWN failure for the purpose of withholding idea-level scores — never
// like an implicit pass.

import { costRow } from "../../lib/accounting.mjs";
// Shared attempt-record key grammar (issues #98, #108). Imported from the
// store module rather than evals/harness/runner.mjs -- where the prune policy
// that consumes it lives -- because runner.mjs already reaches this module
// (runner -> evals/judge/score.mjs -> gate.mjs) and the reverse edge would
// close a cycle. See lib/store.mjs's own block on that.
import { nextAttemptNumber } from "../../lib/store.mjs";

/**
 * Si et al. 2024's reported human-human balanced accuracy — the floor this gate
 * is registered at.
 *
 * 56.1% = the split-half top/bottom-25% balanced accuracy between Si et al.'s
 * own expert reviewers (Si, Yang & Hashimoto 2024, "Can LLMs Generate Novel
 * Research Ideas?", arXiv:2409.04109, Section 5 / Table 11 — the "Si et al.
 * expert reviewers (human-human)" row). It is the human agreement ceiling for
 * this task: an LLM judge that clears it tracks humans at least as well as
 * humans track each other on the very metric the paper uses.
 *
 * This value is REGISTERED and PAPER-REPORTED ONLY — it is never recomputed
 * or revised from our own data. #47's evals/judge/reproduce-si-et-al.mjs
 * computes a human-human balanced accuracy on OUR 98-idea slice (Human + AI
 * conditions; 147-idea/3-condition AI_Rerank population excluded) using a
 * different split rule (halves of each idea's REVIEWS — the anonymized
 * release carries no reviewer id to split by, unlike Si et al.'s own
 * reviewer-split-half). That is a same-construction, DIFFERENT-population
 * comparator, structurally incapable of reproducing this exact figure even
 * with a perfect implementation — see docs/fetching-si-et-al.md and the
 * header comment of reproduce-si-et-al.mjs. It is reported alongside this
 * constant for context, never treated as a pass/fail reproduction of it.
 */
export const SI_ET_AL_BALANCED_ACCURACY_FLOOR = 0.561;

/**
 * Minimum number of ideas the gate will compute a balanced accuracy over.
 *
 * The metric splits ideas into a top and a bottom `quantile` (25% each). Below
 * some n, each side holds so few ideas that a single idea's classification
 * swings the reported accuracy by an unacceptable amount, and "top/bottom 25%"
 * stops being a meaningful split. We require at least 20 ideas — at the default
 * 0.25 quantile that is 5 ideas per side, so no single idea can move balanced
 * accuracy by more than 10 points. The study's real validation slice carries
 * 147 ideas (37 per side; comment on #24), comfortably above this floor; the
 * minimum exists only to REFUSE a degenerate tiny slice loudly rather than
 * emit a number computed on too few ideas to trust.
 */
export const MIN_IDEAS_N = 20;

/** Default top/bottom quantile for the classes (Si et al. use 25%). */
export const DEFAULT_QUANTILE = 0.25;

/** Human-readable id of the exact construction, carried in the record. */
export const CONSTRUCTION_ID = "si-et-al-2024/split-half-top-bottom-25pct-balanced-accuracy";

/**
 * Rank an array of numbers, assigning TIED values the AVERAGE of the ranks
 * they'd occupy (standard tie-handling for Spearman ρ, e.g. two values tied
 * for 2nd/3rd place both get rank 2.5). Ranks are 1-indexed.
 */
function rankWithTies(values) {
  const indexed = values.map((v, i) => ({ v, i }));
  indexed.sort((a, b) => a.v - b.v);
  const ranks = new Array(values.length);
  let i = 0;
  while (i < indexed.length) {
    let j = i;
    while (j + 1 < indexed.length && indexed[j + 1].v === indexed[i].v) j++;
    // Positions i..j (0-indexed into the sorted array) are tied; their rank
    // is the average of the 1-indexed positions i+1 .. j+1.
    const avgRank = (i + 1 + j + 1) / 2;
    for (let k = i; k <= j; k++) ranks[indexed[k].i] = avgRank;
    i = j + 1;
  }
  return ranks;
}

/**
 * Spearman rank correlation between two equal-length numeric arrays: rank
 * both (average ranks for ties), then Pearson correlation on the ranks.
 *
 * Retained (#24) as a DESCRIPTIVE statistic reported alongside the gate — it is
 * no longer what the gate reads.
 *
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number} ρ in [-1, 1]
 */
export function spearmanRho(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
    throw new Error("spearmanRho: a and b must be equal-length arrays");
  }
  if (a.length < 2) {
    throw new Error("spearmanRho: needs at least 2 paired observations to compute a correlation");
  }
  const ra = rankWithTies(a);
  const rb = rankWithTies(b);
  const n = ra.length;
  const meanA = ra.reduce((s, x) => s + x, 0) / n;
  const meanB = rb.reduce((s, x) => s + x, 0) / n;
  let cov = 0, varA = 0, varB = 0;
  for (let i = 0; i < n; i++) {
    const da = ra[i] - meanA;
    const db = rb[i] - meanB;
    cov += da * db;
    varA += da * da;
    varB += db * db;
  }
  if (varA === 0 || varB === 0) {
    throw new Error("spearmanRho: at least one input has zero variance in rank (all values tied) — correlation is undefined");
  }
  return cov / Math.sqrt(varA * varB);
}

/**
 * Order indices of `scores` by value ASCENDING, breaking ties by index
 * ascending so the ordering — and therefore the top/bottom membership — is
 * deterministic and hand-reproducible regardless of the input's original order.
 */
function orderByScoreAsc(scores) {
  return scores
    .map((v, i) => ({ v, i }))
    .sort((a, b) => (a.v - b.v) || (a.i - b.i))
    .map((x) => x.i);
}

/**
 * The shared metric: split-half top/bottom-`quantile` balanced accuracy.
 *
 * `referenceScores` and `evaluatorScores` are aligned per-idea signals (same
 * length, same idea order). The reference defines the ground-truth top/bottom
 * classes; the evaluator predicts them.
 *
 *   k          = floor(n * quantile) ideas per side
 *   positives  = the k ideas with the HIGHEST reference score (top quantile)
 *   negatives  = the k ideas with the LOWEST reference score (bottom quantile)
 *   the middle n - 2k ideas are discarded (not scored)
 *   prediction = rank the 2k labelled ideas by EVALUATOR score; the evaluator's
 *                own top-k are predicted positive, bottom-k predicted negative
 *   balanced accuracy = (TP/k + TN/k) / 2, i.e. (sensitivity + specificity)/2
 *
 * @param {object} o
 *   @param {number[]} o.referenceScores  per-idea reference (ground-truth) score
 *   @param {number[]} o.evaluatorScores  per-idea evaluator (predictor) score
 *   @param {number}   [o.quantile]       top/bottom fraction (default 0.25)
 * @returns {{ accuracy: number, k: number, n: number, sensitivity: number, specificity: number }}
 */
export function balancedAccuracyTopBottom({ referenceScores, evaluatorScores, quantile = DEFAULT_QUANTILE }) {
  if (!Array.isArray(referenceScores) || !Array.isArray(evaluatorScores)) {
    throw new Error("balancedAccuracyTopBottom: referenceScores and evaluatorScores must be arrays");
  }
  if (referenceScores.length !== evaluatorScores.length) {
    throw new Error("balancedAccuracyTopBottom: referenceScores and evaluatorScores must be equal length (aligned per idea)");
  }
  if (!(quantile > 0 && quantile <= 0.5)) {
    throw new Error(`balancedAccuracyTopBottom: quantile must be in (0, 0.5], got ${quantile}`);
  }
  const n = referenceScores.length;
  const k = Math.floor(n * quantile);
  if (k < 1) {
    throw new Error(
      `balancedAccuracyTopBottom: quantile ${quantile} of n=${n} rounds to 0 ideas per side — ` +
        "cannot form a top/bottom split",
    );
  }
  const refOrder = orderByScoreAsc(referenceScores);
  const negatives = new Set(refOrder.slice(0, k)); // lowest-k reference scores
  const positives = new Set(refOrder.slice(n - k)); // highest-k reference scores

  // The labelled set is exactly positives ∪ negatives (disjoint: 2k <= n since
  // quantile <= 0.5). Rank ONLY those ideas by evaluator score; predict the
  // evaluator's own top-k positive, bottom-k negative.
  const labelled = [...negatives, ...positives];
  const labelledByEval = labelled
    .map((idx) => ({ idx, v: evaluatorScores[idx] }))
    .sort((a, b) => (a.v - b.v) || (a.idx - b.idx));
  const predNegative = new Set(labelledByEval.slice(0, k).map((x) => x.idx));
  const predPositive = new Set(labelledByEval.slice(k).map((x) => x.idx));

  let tp = 0, tn = 0;
  for (const idx of positives) if (predPositive.has(idx)) tp++;
  for (const idx of negatives) if (predNegative.has(idx)) tn++;
  const sensitivity = tp / k;
  const specificity = tn / k;
  return { accuracy: (sensitivity + specificity) / 2, k, n, sensitivity, specificity };
}

/** Deterministic PRNG (mulberry32) so the split-half derivation is
 *  reproducible from a seed — required for hermetic tests and for stating the
 *  seed of any reported number rather than reporting a single lucky draw. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** In-place Fisher–Yates shuffle of `arr` using `rand` (returns arr). */
function shuffleInPlace(arr, rand) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * The human-human construction that PRODUCES the 56.1% floor: randomly split
 * each idea's reviews into two halves, aggregate each half to a per-idea mean,
 * and measure balanced accuracy of one half predicting the other's top/bottom
 * classes. Because the split is random, repeat it `splits` times and report the
 * DISTRIBUTION (mean + all draws), not a single lucky number.
 *
 * This is the load-bearing reproduction of Si et al.'s figure. Reproducing
 * 56.1% requires their real released reviews (data/si-et-al/, gitignored, #16) —
 * this function is exercised hermetically here on a synthetic fixture with a
 * known answer, and against the real reviews only in the #16 real-data run.
 *
 * @param {object} o
 *   @param {number[][]} o.ideaReviews  per-idea array of expert review scores
 *     (each idea needs >= 2 reviews so it can be split into two non-empty halves)
 *   @param {number}   [o.quantile]     top/bottom fraction (default 0.25)
 *   @param {number}   [o.splits]       number of random half-splits (default 100)
 *   @param {number}   [o.seed]         PRNG seed (default 1) — state it, don't tune it
 * @returns {{ mean: number, values: number[], splits: number, n: number, quantile: number, seed: number }}
 */
export function balancedAccuracySplitHalf({ ideaReviews, quantile = DEFAULT_QUANTILE, splits = 100, seed = 1 }) {
  if (!Array.isArray(ideaReviews)) {
    throw new Error("balancedAccuracySplitHalf: ideaReviews must be an array of per-idea review-score arrays");
  }
  const n = ideaReviews.length;
  if (n < MIN_IDEAS_N) {
    throw new Error(
      `balancedAccuracySplitHalf: n=${n} ideas is below the minimum ${MIN_IDEAS_N} — refusing to compute a ` +
        "top/bottom split on too few ideas (see MIN_IDEAS_N).",
    );
  }
  for (let i = 0; i < n; i++) {
    if (!Array.isArray(ideaReviews[i]) || ideaReviews[i].length < 2) {
      throw new Error(
        `balancedAccuracySplitHalf: idea at index ${i} has fewer than 2 reviews — cannot split into two ` +
          "non-empty halves (Si et al.'s construction splits the reviewers of each idea).",
      );
    }
  }
  const rand = mulberry32(seed);
  const values = [];
  for (let s = 0; s < splits; s++) {
    const refMeans = new Array(n);
    const evalMeans = new Array(n);
    for (let i = 0; i < n; i++) {
      const reviews = ideaReviews[i].slice();
      shuffleInPlace(reviews, rand);
      const half = Math.floor(reviews.length / 2);
      const refHalf = reviews.slice(0, half);
      const evalHalf = reviews.slice(half);
      refMeans[i] = refHalf.reduce((a, b) => a + b, 0) / refHalf.length;
      evalMeans[i] = evalHalf.reduce((a, b) => a + b, 0) / evalHalf.length;
    }
    const { accuracy } = balancedAccuracyTopBottom({ referenceScores: refMeans, evaluatorScores: evalMeans, quantile });
    values.push(accuracy);
  }
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return { mean, values, splits, n, quantile, seed };
}

/**
 * Compute the judge gate's verdict for one judge, over one validation slice.
 *
 * The gate reads the split-half top/bottom-25% BALANCED ACCURACY of the judge
 * against the expert-consensus ranking, and compares it to the registered floor
 * (SI_ET_AL_BALANCED_ACCURACY_FLOOR, overridable via config.judge.accuracyFloor).
 * `spearmanRho` is retained and returned as a descriptive statistic only.
 *
 * Refuses (throws) below MIN_IDEAS_N rather than reporting a number computed on
 * too few ideas.
 *
 * @param {object} o
 *   @param {number[]} o.judgeScores    judge's per-idea score, same idea order as expertScores
 *   @param {number[]} o.expertScores   Si et al. expert-consensus per-idea score
 *   @param {object}   [o.config]       config.judge.accuracyFloor overrides the floor; config.judge.quantile the quantile
 * @returns {{ metric: string, construction: string, n: number, accuracy: number, floor: number, verdict: "pass"|"drop", rho: number }}
 */
export function validateJudge({ judgeScores, expertScores, config }) {
  if (!Array.isArray(judgeScores) || !Array.isArray(expertScores)) {
    throw new Error("validateJudge: judgeScores and expertScores must be arrays");
  }
  if (judgeScores.length !== expertScores.length) {
    throw new Error("validateJudge: judgeScores and expertScores must be equal length (aligned per idea)");
  }
  const n = judgeScores.length;
  if (n < MIN_IDEAS_N) {
    throw new Error(
      `validateJudge: n=${n} ideas is below the minimum ${MIN_IDEAS_N} — refusing to compute a top/bottom ` +
        "balanced accuracy on too few ideas (see MIN_IDEAS_N). Widen the validation slice.",
    );
  }
  const quantile = config && config.judge && typeof config.judge.quantile === "number" ? config.judge.quantile : DEFAULT_QUANTILE;
  const floor = resolveAccuracyFloor(config);
  const { accuracy } = balancedAccuracyTopBottom({ referenceScores: expertScores, evaluatorScores: judgeScores, quantile });
  const rho = spearmanRho(judgeScores, expertScores);
  const verdict = accuracy >= floor ? "pass" : "drop";
  return { metric: "balanced-accuracy", construction: CONSTRUCTION_ID, n, accuracy, floor, verdict, rho };
}

/**
 * Resolve the balanced-accuracy floor. Unlike the (now descriptive-only) ρ
 * floor, this floor IS registered — Si et al.'s reported 56.1% — so the
 * default is the registered constant, and config may override it only with an
 * explicit finite number.
 */
export function resolveAccuracyFloor(config) {
  const override = config && config.judge ? config.judge.accuracyFloor : undefined;
  if (override === undefined) return SI_ET_AL_BALANCED_ACCURACY_FLOOR;
  if (typeof override !== "number" || !Number.isFinite(override)) {
    throw new Error(
      `resolveAccuracyFloor: config.judge.accuracyFloor must be a finite number when set, got ${JSON.stringify(override)}`,
    );
  }
  return override;
}

/** Reserved, namespaced key for a judge-validation record — never collides
 *  with a real cell key (lib/manifest.mjs's cellKey always starts `arm=`). */
export function validationKey({ judgeHash, sliceId }) {
  if (!judgeHash || !sliceId) {
    throw new Error("validationKey: judgeHash and sliceId are both required");
  }
  return `judge-validation|judge=${judgeHash}|slice=${sliceId}`;
}

/**
 * Write a judge-validation record into the store. This IS the gate: nothing
 * about "is this judge validated" exists anywhere else in memory or in config —
 * only what has been put() here. The record body (#24) carries the full
 * computation so a reader can confirm which metric produced the verdict.
 *
 * @param {object} store  a lib/store.mjs ResultsStore
 * @param {object} o
 *   @param {string} o.judgeHash
 *   @param {string} o.sliceId
 *   @param {number} o.accuracy   the balanced accuracy the gate read
 *   @param {number} o.floor
 *   @param {"pass"|"drop"} o.verdict
 *   @param {number} o.n          number of ideas the accuracy was computed over
 *   @param {number} o.rho        Spearman ρ, retained as a descriptive statistic
 *   @param {string} [o.metric]        default "balanced-accuracy"
 *   @param {string} [o.construction]  default CONSTRUCTION_ID
 *   @param {string} [o.judgeModel]    judge model id, or "mixed" (default)
 *   @param {string} [o.axis]          judge axis validated (issue #36) — stored
 *     in the record when supplied, so the record is self-describing.
 *   @param {string} [o.expertColumn]  the Si et al. expert column the axis was
 *     validated against (issue #36) — stored when supplied.
 */
export function recordValidation(store, { judgeHash, sliceId, accuracy, floor, verdict, n, rho, metric = "balanced-accuracy", construction = CONSTRUCTION_ID, judgeModel = "mixed", axis, expertColumn }) {
  if (!store) throw new Error("recordValidation: store is required");
  if (verdict !== "pass" && verdict !== "drop") {
    throw new Error(`recordValidation: verdict must be "pass" or "drop", got ${JSON.stringify(verdict)}`);
  }
  if (typeof accuracy !== "number" || !Number.isFinite(accuracy)) {
    throw new Error("recordValidation: accuracy must be a finite number (the balanced accuracy the gate read)");
  }
  if (typeof n !== "number" || !Number.isInteger(n) || n <= 0) {
    throw new Error("recordValidation: n must be a positive integer (the idea count the accuracy was computed over)");
  }
  const key = validationKey({ judgeHash, sliceId });
  // axis/expertColumn are added ONLY when supplied, so a record written without
  // them (pre-#36 callers) keeps its exact prior shape.
  const result = { kind: "judge-validation", metric, construction, n, accuracy, floor, verdict, rho };
  if (axis !== undefined) result.axis = axis;
  if (expertColumn !== undefined) result.expertColumn = expertColumn;
  return store.put({
    key,
    armId: "__judge-validation__",
    briefId: sliceId,
    replicate: 0,
    cfg: judgeHash,
    result,
    resolvedModels: { judge: judgeModel },
    accounting: { state: "completed" },
    costRows: [],
  });
}

/**
 * Look up every validation record for `judgeHash`. Reads only the bodies whose
 * key already matches the judge-validation namespace for this judgeHash — it
 * never scans/reads unrelated cells' bodies.
 */
function findValidationRecords(store, judgeHash) {
  const prefix = `judge-validation|judge=${judgeHash}|`;
  return store
    .list()
    .filter((entry) => entry.key.startsWith(prefix))
    .map((entry) => store.get(entry.key));
}

/**
 * Attach idea-level judge scores to study pools — but FAILS CLOSED (AC8):
 *   - no validation record for judgeHash at all           -> throws
 *   - a record exists with verdict "drop"                 -> pool-level only
 *   - a record exists with verdict "pass"                 -> idea-level attached
 * If multiple validation records exist for this judgeHash (e.g. across multiple
 * slices), ANY passing record is sufficient to attach — the study only needs one
 * confirmed calibration to trust the instrument; a dropped record from a
 * DIFFERENT slice does not retroactively invalidate a pass.
 *
 * @param {object} o
 *   @param {object} o.store         lib/store.mjs ResultsStore
 *   @param {string} o.judgeHash
 *   @param {Array}  o.pools         pool-level rows/metrics (opaque to this fn)
 *   @param {Array}  o.ideaLevelScores  idea-level judge scores to attach
 * @returns {{ pools: Array, ideas?: Array, idea_level_metrics?: "dropped" }}
 */
export function attachIdeaLevelScores({ store, judgeHash, pools, ideaLevelScores }) {
  if (!store) throw new Error("attachIdeaLevelScores: store is required");
  if (!judgeHash) throw new Error("attachIdeaLevelScores: judgeHash is required");

  const records = findValidationRecords(store, judgeHash);
  if (records.length === 0) {
    throw new Error(
      `attachIdeaLevelScores: no validation record found for judgeHash '${judgeHash}' — an unvalidated judge ` +
        "must not attach idea-level scores (docs/PREREGISTRATION.md §5: 'you cannot measure with an " +
        "uncalibrated instrument'). Run validateJudge()+recordValidation() against a held-out expert slice first.",
    );
  }

  const passing = records.find((r) => r.result && r.result.verdict === "pass");
  if (!passing) {
    // Every record on file for this judge is a "drop" — pool-level-only output,
    // idea-level metrics explicitly marked dropped rather than just omitted (so
    // a downstream report can distinguish "we chose not to compute this" from
    // "this field is simply absent").
    return { idea_level_metrics: "dropped", pools };
  }

  return { pools, ideas: ideaLevelScores };
}

/**
 * Meter one judge call through lib/accounting.mjs like any other cell (AC10):
 * build a costRow (billing_mode "api", tokens x model, never cost_usd) and
 * record it in the store as a small, independent record keyed off the
 * generating cell's key plus the judge model — separate from the generating
 * cell's own record so a judge call's cost is never silently folded into (or
 * mistaken for) the underlying generation call's cost.
 *
 * @param {object} o
 *   @param {object} o.store       lib/store.mjs ResultsStore
 *   @param {string} o.cellKey     the pool/cell this judge call scored
 *   @param {string} o.judgeModel  judge model id
 *   @param {object} o.tokens      token usage: { input_tokens, output_tokens, ... }
 *   @param {string} o.timestamp   ISO 8601, caller-supplied (see lib/accounting.mjs costRow)
 *
 * `row` (issue #63) is the SAME costRow() object stored in `costRows` below,
 * handed back to the caller so it can be surfaced upward (e.g.
 * runJudgeMatrix's own `costRows` return, or a caller's per-provider spend
 * attribution via lib/price.mjs's priceRowsByProvider) WITHOUT building a
 * second row for the same call — exactly one costRow() per judge call, ever.
 *
 * ── Attempt-scoped key (PR #76 fix round, blocking) ──────────────────────
 * A judge leg's transport call can fail AFTER consuming real tokens --
 * AnthropicJudgeProvider threads ONE mutable `tokens` accumulator through
 * its whole call and classifies the outcome only afterward, so a
 * rate_limited/timeout/transport_error/parse_failure leaves REAL usage on
 * `resp.tokens` (see score.mjs's AnthropicJudgeProvider#score). A caller
 * that resumes and retries that SAME leg (evals/harness/runner.mjs's
 * judgePoolIfEnabled, keyed on whether judge-SCORES exist, never on
 * whether a judge-CALL row exists) is making a SECOND real API call that
 * spends REAL money again -- not a replay of the first attempt. A fixed,
 * deterministic key (the pre-fix `judge-call|cell=...|judge=...`, no
 * discriminator) collided on that retry: lib/store.mjs's append-only,
 * byte-identical-or-throw put() rejected the new (different-timestamp) row
 * outright, permanently bricking the store (no delete API) on the very
 * first judge-side transport hiccup. Mirrors phase0.mjs's identical fix for
 * its own re-run/retry collision (see that module's header) -- an attempt
 * discriminator, scanning the store for how many attempts already exist
 * under this (cellKey, judgeModel) pair and suffixing the NEXT integer, so
 * every attempt's spend gets its own durable, non-colliding row. This is
 * the honest model, not a workaround: a retry genuinely spent more money
 * and deserves its own cost row, exactly the family of defect issue #74
 * exists to close (collapsing two billed attempts into one row
 * under-counts real spend).
 * @returns {{key: string, written: boolean, row: object}}
 */
export function meterJudgeCall({ store, cellKey, judgeModel, tokens, timestamp }) {
  if (!store) throw new Error("meterJudgeCall: store is required");
  if (!cellKey) throw new Error("meterJudgeCall: cellKey is required");
  if (!judgeModel) throw new Error("meterJudgeCall: judgeModel is required");
  const row = costRow({
    cellKey,
    timestamp,
    billing_mode: "api",
    model: judgeModel,
    ...tokens,
  });
  // ── Numbering: MAX+1, never a count (issue #108) ────────────────────────
  // This was `store.keys().filter(k => k.startsWith(prefix)).length` until
  // #108, and the count was correct only for as long as nothing could ever
  // leave the store. #98 gave the store a removal path and a compaction that
  // folds older attempt records into one -- at which point a count is a
  // collision generator: fold attempts 0..4 into a single compacted record
  // and the count says "1 record, so the next attempt is 1", writing on top
  // of the retained attempt 5. put() throws on same-key/different-content,
  // so that lands as a hard, store-bricking failure rather than a silent
  // one, which is exactly why judge-call records could not be compacted at
  // all before this change.
  //
  // nextAttemptNumber takes the maximum across BOTH the raw
  // (`|attempt=N`) and compacted (`-compacted|…|through=N`) shapes, so it is
  // correct under every mix of folded and unfolded records and is identical
  // to the old count for the un-compacted 0..n-1 case. `store.keys()` is
  // index-only (cheap; lib/store.mjs) and reflects every attempt durably
  // recorded for this exact (cellKey, judgeModel) pair, including ones from
  // a PRIOR session (a fresh ResultsStore instance reads index.jsonl from
  // disk) -- so the number is correct across process and session boundaries.
  //
  // The identity attempts are numbered per is the (cellKey, judgeModel)
  // PAIR, and it is passed as the composite `<cellKey>|judge=<model>`. That
  // is not an encoding trick: it is literally the substring of the key
  // between `|cell=` and `|attempt=`, which is what parseAttemptKey returns
  // as `cellKey`. Two judge models scoring the same pool are two independent
  // attempt sequences and two independent compaction groups.
  const attemptScope = `${cellKey}|judge=${judgeModel}`;
  const attempt = nextAttemptNumber(store, "judge-call", attemptScope);
  const key = `judge-call|cell=${attemptScope}|attempt=${attempt}`;
  const result = store.put({
    key,
    armId: "__judge-call__",
    briefId: cellKey,
    replicate: 0,
    cfg: judgeModel,
    result: { kind: "judge-call", cellKey, judgeModel, attempt },
    resolvedModels: { judge: judgeModel },
    accounting: { state: "completed" },
    costRows: [row],
  });
  return { ...result, row };
}
