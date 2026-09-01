// frame.mjs — the ONLY module in evals/analysis/ that knows ResultsStore's
// shape (issue #46). Every other analysis module (contrasts, fit, pareto,
// report) works on the tidy frame this module produces, never on a store
// directly — that boundary is what keeps a store-schema change a one-file
// diff instead of a scavenger hunt.
//
// ── Two registered inclusion rules (issue #46) ───────────────────────────────
// 1. Only `state === "completed"` cells enter the fit. `failed` (classified
//    by kind) and `skipped` cells are never silently dropped — §6.3 of the
//    pre-registration forbids it, because a per-arm imbalance in failure
//    rate is differential attrition and a stated threat to validity. They
//    are counted PER ARM and returned alongside the frame, not folded into
//    it.
// 2. Fit only cells whose `cfg` matches the caller-declared `configHash`
//    (lib/manifest.mjs). A stored cell under a DIFFERENT cfg is `stale` —
//    reported, never pooled (§11: pooling across a config change is exactly
//    the silent-mixing failure the additive design exists to prevent).
//
// ── Pricing ───────────────────────────────────────────────────────────────
// A cell's cost is never read as a stored dollar figure — there isn't one;
// costRows are token-level (lib/accounting.mjs's costRow() shape). Cost is
// computed HERE, at read time, via lib/price.mjs:priceRows(). This study's
// billing_mode is "api" throughout (§7), so `totalUsd` is the number used;
// `totalNotionalUsd` would only be nonzero for a subscription-mode row,
// which this frame never expects to see and does not silently fold in.
//
// ── Determinism ───────────────────────────────────────────────────────────
// Rows are sorted by `cellKey` (a stable, readable string — see
// lib/manifest.mjs) so two runs over the same store produce byte-identical
// row order. Factor level order (which arms/briefs exist and in what order)
// is NEVER inferred from the order cells happen to appear in the index —
// callers pass it explicitly (or it is derived from the fixed arm/brief ids
// actually present, sorted) so the contrast basis in contrasts.mjs never
// silently permutes if the store happens to be iterated in a different
// order on a different machine.
//
// ── The response column is a parameter, not a constant ──────────────────────
// This issue's scope is the `distinct_k` lane, but §6.2/B6 also register a
// judge-score model (with `(1|run)`, `judge_provider`, and
// `judge_provider × generator_provider` terms — see B6/H5). Hardcoding
// `distinct_k` as the response field would structurally preclude that
// second lane from ever sharing this frame-building code. `buildFrame()`
// therefore takes `responseField` (a dotted path into a completed cell's
// `result`, e.g. "distinct_k") rather than assuming it. Building the actual
// judge-score frame (extra columns: run id, judge_provider,
// generator_provider) is out of scope here — follow-up per #45/B5.

import { priceRows } from "../../lib/price.mjs";
import { configHash as computeConfigHash } from "../../lib/manifest.mjs";

/**
 * Thrown by buildFrame() when an arm level has ZERO completed rows (every
 * cell for that arm failed and/or was skipped) — differential attrition
 * (§6.3's own named validity threat), never allowed to surface downstream
 * as fit.mjs's SidecarUnavailableError / a coefficientNames mismatch (#46
 * QA SHOULD: that failure mode is badly misleading about what actually
 * happened — the design was never sent to the sidecar with a level that
 * has no data). Named and thrown HERE, at the frame boundary, where the
 * failure/skip tallies that explain WHY are already in hand.
 */
export class DifferentialAttritionError extends Error {
  constructor(armId, failuresByArm, skippedByArm) {
    const failed = failuresByArm[armId] || {};
    const failedStr = Object.entries(failed).map(([k, c]) => `${k}: ${c}`).join(", ") || "none";
    const skipped = skippedByArm[armId] || 0;
    super(
      `buildFrame: arm '${armId}' has zero completed rows (every cell failed and/or was skipped) — ` +
        `differential attrition, not a modeling failure (failed: ${failedStr}; skipped: ${skipped}). ` +
        `Fitting this arm's level would produce a singular design (R2) or a coefficientNames mismatch ` +
        `(R0/R1) that reads as SidecarUnavailableError but is actually this.`,
    );
    this.name = "DifferentialAttritionError";
    this.armId = armId;
  }
}

/** Read a dotted path (e.g. "distinct_k" or "judge.score") off an object.
 *  Returns undefined if any segment is missing — never throws, so callers
 *  can distinguish "missing" (a named error) from "present but falsy". */
function getPath(obj, path) {
  return path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

/**
 * Build the tidy analysis frame from a ResultsStore.
 *
 * @param {import("../../lib/store.mjs").ResultsStore} store
 * @param {object} opts
 *   @param {object} opts.config          the config object whose hash marks
 *                                         which stored cells are comparable
 *                                         (passed to lib/manifest.mjs:configHash)
 *   @param {string} [opts.responseField="distinct_k"]  dotted path into a
 *                                         completed cell's `result` naming
 *                                         the numeric response to fit
 *   @param {string[]} [opts.armLevels]   explicit, pinned arm id order. If
 *                                         omitted, derived from the arm ids
 *                                         actually present in `included`,
 *                                         sorted lexicographically (still
 *                                         deterministic, but callers who
 *                                         care about a REGISTERED level
 *                                         order — e.g. Arm A first, per the
 *                                         contrast basis in contrasts.mjs —
 *                                         should pass this explicitly).
 *   @param {string[]} [opts.briefLevels] same, for brief ids.
 *   @param {object} [opts.rateTable]     forwarded to lib/price.mjs:priceRows
 * @returns {{
 *   rows: Array<{cellKey: string, armId: string, briefId: string,
 *     replicate: number, cfg: string, response: number, costUsd: number}>,
 *   armLevels: string[],
 *   briefLevels: string[],
 *   responseField: string,
 *   configHash: string,
 *   excluded: {
 *     failed: Array<{key: string, armId: string, briefId: string, kind: string}>,
 *     skipped: Array<{key: string, armId: string, briefId: string, detail: string}>,
 *     stale: Array<{key: string, armId: string, briefId: string, cfg: string}>,
 *   },
 *   failuresByArm: Record<string, Record<string, number>>,   // armId -> kind -> count
 *   skippedByArm: Record<string, number>,                    // armId -> count
 * }}
 */
export function buildFrame(store, opts = {}) {
  if (!store || typeof store.list !== "function" || typeof store.get !== "function") {
    throw new Error("buildFrame: opts.store must be a ResultsStore (or duck-typed equivalent with .list()/.get())");
  }
  const responseField = opts.responseField || "distinct_k";
  const cfg = computeConfigHash(opts.config || {});

  const rows = [];
  const excluded = { failed: [], skipped: [], stale: [] };
  const failuresByArm = {};
  const skippedByArm = {};
  const seenArms = new Set();
  const seenBriefs = new Set();

  // list() reads only index.jsonl — cheap, whole-index metadata, no bodies.
  const entries = store.list().sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  for (const entry of entries) {
    if (entry.cfg !== cfg) {
      excluded.stale.push({ key: entry.key, armId: entry.armId, briefId: entry.briefId, cfg: entry.cfg });
      continue;
    }
    seenArms.add(entry.armId);
    seenBriefs.add(entry.briefId);

    if (entry.state === "failed") {
      // get() only for cells we actually need — a failed cell's kind lives
      // on the body's `accounting`, not the index entry, so we do have to
      // open it. This is still "get() only for included keys" in spirit:
      // a failed cell IS included, just in the failure tally, not the frame.
      const body = store.get(entry.key);
      const kind = body.accounting && body.accounting.kind;
      excluded.failed.push({ key: entry.key, armId: entry.armId, briefId: entry.briefId, kind });
      failuresByArm[entry.armId] = failuresByArm[entry.armId] || {};
      failuresByArm[entry.armId][kind] = (failuresByArm[entry.armId][kind] || 0) + 1;
      continue;
    }

    if (entry.state === "skipped") {
      const body = store.get(entry.key);
      const detail = body.accounting && body.accounting.detail;
      excluded.skipped.push({ key: entry.key, armId: entry.armId, briefId: entry.briefId, detail });
      skippedByArm[entry.armId] = (skippedByArm[entry.armId] || 0) + 1;
      continue;
    }

    if (entry.state !== "completed") {
      throw new Error(`buildFrame: '${entry.key}' has unrecognized state '${entry.state}' — expected completed/failed/skipped`);
    }

    const body = store.get(entry.key);
    const response = getPath(body.result, responseField);
    if (typeof response !== "number" || !Number.isFinite(response)) {
      throw new Error(
        `buildFrame: completed cell '${entry.key}' has no numeric result.${responseField} — a completed cell entering ` +
          `the fit must carry the response it's being fit on (populating it is out of scope for evals/analysis/; see #49/#50)`,
      );
    }

    const priced = priceRows(body.costRows || [], opts.rateTable, { batch: false });
    const costUsd = priced.totalUsd;

    rows.push({
      cellKey: entry.key,
      armId: entry.armId,
      briefId: entry.briefId,
      replicate: entry.replicate,
      cfg: entry.cfg,
      response,
      costUsd,
    });
  }

  const armLevels = opts.armLevels || Array.from(seenArms).sort();
  const briefLevels = opts.briefLevels || Array.from(seenBriefs).sort();

  // A factor level with zero rows because every one of its cells failed
  // and/or was skipped must never reach the fit — it would surface later as
  // fit.mjs's SidecarUnavailableError (a coefficientNames mismatch) or a
  // singular R2 design, both badly misleading about the actual cause. Catch
  // it here, where the failure/skip tallies that explain why are in hand.
  // Scoped to `seenArms` (an arm with at least one cfg-matching cell) —
  // NOT all of `armLevels`, so a caller-pinned level that was simply never
  // run (opts.armLevels naming an arm the store has no cells for at all)
  // stays a normal, allowed "not yet run" state, not attrition.
  const rowCountByArm = new Map();
  for (const row of rows) rowCountByArm.set(row.armId, (rowCountByArm.get(row.armId) || 0) + 1);
  for (const armId of armLevels) {
    if (seenArms.has(armId) && !rowCountByArm.get(armId)) {
      throw new DifferentialAttritionError(armId, failuresByArm, skippedByArm);
    }
  }

  return {
    rows,
    armLevels,
    briefLevels,
    responseField,
    configHash: cfg,
    excluded,
    failuresByArm,
    skippedByArm,
  };
}

/**
 * Per-arm summary the Pareto frontier and cost lane need: mean response and
 * mean cost, plus n (rows contributing). Pure over `frame.rows` — does not
 * touch the store.
 *
 * @param {ReturnType<typeof buildFrame>} frame
 * @returns {Array<{armId: string, n: number, meanResponse: number, meanCostUsd: number}>}
 */
export function summarizeByArm(frame) {
  const byArm = new Map();
  for (const row of frame.rows) {
    if (!byArm.has(row.armId)) byArm.set(row.armId, []);
    byArm.get(row.armId).push(row);
  }
  return frame.armLevels
    .filter((armId) => byArm.has(armId))
    .map((armId) => {
      const rows = byArm.get(armId);
      const meanResponse = rows.reduce((s, r) => s + r.response, 0) / rows.length;
      const meanCostUsd = rows.reduce((s, r) => s + r.costUsd, 0) / rows.length;
      return { armId, n: rows.length, meanResponse, meanCostUsd };
    });
}
