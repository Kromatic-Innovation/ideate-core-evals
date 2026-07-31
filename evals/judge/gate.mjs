// gate.mjs — the ρ validation gate: fails closed, and lives in the store as a
// RECORD, not a runtime flag (issue #4, AC7/AC8/AC10).
//
// ── Why a store record, not a flag ──────────────────────────────────────────
// docs/PREREGISTRATION.md §5's rule — "you cannot measure with an uncalibrated
// instrument" — has to be ENFORCED, not just documented, or an unvalidated
// judge could sit in the tree looking ready (exactly the anti-pattern the
// issue's kickback/re-scope discussion names). A runtime flag (e.g. an env
// var or an in-memory boolean some caller sets) can't be constructed by a
// test without also faking the code path that would set it, and it vanishes
// between process runs. A STORE RECORD (via the same `lib/store.mjs`
// ResultsStore every other cell goes through) makes "has this judge been
// validated, and did it pass" a durable, replayable, test-constructible fact:
// a test can `store.put()` a validation record directly and assert the
// scoring path honors (or refuses to honor) it, with no special-cased mock.
//
// ── The validation record's key and shape ───────────────────────────────────
// Key: `judge-validation|judge=${judgeHash}|slice=${sliceId}` — reserved,
// namespaced so it can never collide with a real cell's `arm=...|brief=...`
// key shape (lib/manifest.mjs's cellKey), and scoped per judge-prompt-version
// (judgeHash) and per validation slice (sliceId identifies WHICH held-out
// expert-scored slice validated this judge — e.g. a Si et al. subset id).
// Record shape, matching ResultsStore.put()'s required fields exactly:
//   result          = { kind: "judge-validation", rho, floor, verdict }
//   resolvedModels  = { judge: <judgeModelId or "mixed"> }
//   accounting      = { state: "completed" }
//   costRows        = []  (a validation record's OWN accounting is separate
//                          from the token cost of the calls that produced the
//                          rho estimate; see meterJudgeCall for how the judge
//                          calls THEMSELVES are metered)
//
// ── Fails closed: three-way disposition in attachIdeaLevelScores ────────────
//   1. no validation record for this judgeHash at all       -> THROW
//   2. a record exists, verdict "drop" (rho < floor)        -> pool-level only
//   3. a record exists, verdict "pass" (rho >= floor)        -> attach idea-level
// "Fails closed" means the ABSENCE of a record is treated exactly like a
// KNOWN failure for the purpose of withholding idea-level scores — never
// like an implicit pass.

import { resolveRhoFloor } from "./config.mjs";
import { costRow } from "../../lib/accounting.mjs";

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
 * Compute the ρ gate's verdict for one judge, over one validation slice.
 * Reads the floor via resolveRhoFloor(config) — throws if unset (AC9).
 *
 * @param {object} o
 *   @param {number[]} o.judgeScores    judge's scores/ranking basis for the slice
 *   @param {number[]} o.expertScores   Si et al. expert scores/ranking basis, same order
 *   @param {object} o.config           passed through to resolveRhoFloor
 * @returns {{rho: number, floor: number, verdict: "pass"|"drop"}}
 */
export function validateJudge({ judgeScores, expertScores, config }) {
  const floor = resolveRhoFloor(config);
  const rho = spearmanRho(judgeScores, expertScores);
  const verdict = rho >= floor ? "pass" : "drop";
  return { rho, floor, verdict };
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
 * about "is this judge validated" exists anywhere else in memory or in
 * config — only what has been put() here.
 *
 * @param {object} store  a lib/store.mjs ResultsStore
 * @param {object} o
 *   @param {string} o.judgeHash
 *   @param {string} o.sliceId
 *   @param {number} o.rho
 *   @param {number} o.floor
 *   @param {"pass"|"drop"} o.verdict
 *   @param {string} [o.judgeModel]  the judge model id, or omit/pass "mixed"
 *     when the validated judge spans multiple models (cross-judge matrix).
 */
export function recordValidation(store, { judgeHash, sliceId, rho, floor, verdict, judgeModel = "mixed" }) {
  if (!store) throw new Error("recordValidation: store is required");
  if (verdict !== "pass" && verdict !== "drop") {
    throw new Error(`recordValidation: verdict must be "pass" or "drop", got ${JSON.stringify(verdict)}`);
  }
  const key = validationKey({ judgeHash, sliceId });
  return store.put({
    key,
    armId: "__judge-validation__",
    briefId: sliceId,
    replicate: 0,
    cfg: judgeHash,
    result: { kind: "judge-validation", rho, floor, verdict },
    resolvedModels: { judge: judgeModel },
    accounting: { state: "completed" },
    costRows: [],
  });
}

/**
 * Look up every validation record for `judgeHash` via the store's INDEX only
 * (store.list() — never reads a body just to answer "is there a passing
 * record"). Returns the parsed { rho, floor, verdict } bodies... actually
 * verdict/rho/floor are NOT in the index (list() only returns index
 * metadata: key/state/armId/briefId/replicate/cfg/storedAt — see
 * lib/store.mjs), so this reads the matching bodies via store.get(), but
 * only for entries whose key already matches the judge-validation namespace
 * for this judgeHash — i.e. it still never scans/reads unrelated cells'
 * bodies, it just isn't index-only for the (small, O(1)-per-judge) set of
 * validation records themselves.
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
 * If multiple validation records exist for this judgeHash (e.g. across
 * multiple slices), ANY passing record is sufficient to attach — the study
 * only needs one confirmed calibration to trust the instrument; a dropped
 * record from a DIFFERENT slice does not retroactively invalidate a pass.
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
    // Every record on file for this judge is a "drop" — pool-level-only
    // output, idea-level metrics explicitly marked dropped rather than just
    // omitted (so a downstream report can distinguish "we chose not to
    // compute this" from "this field is simply absent").
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
 * @returns {{key: string, written: boolean}}
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
  const key = `judge-call|cell=${cellKey}|judge=${judgeModel}`;
  return store.put({
    key,
    armId: "__judge-call__",
    briefId: cellKey,
    replicate: 0,
    cfg: judgeModel,
    result: { kind: "judge-call", cellKey, judgeModel },
    resolvedModels: { judge: judgeModel },
    accounting: { state: "completed" },
    costRows: [row],
  });
}
