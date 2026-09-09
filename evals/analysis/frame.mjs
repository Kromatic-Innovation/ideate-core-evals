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
//
// ── The pool column is OPTIONAL and off by default (issue #73) ─────────────
// docs/PREREGISTRATION.md Appendix C registers rarefied `distinct_k` as H1's
// estimand, which needs the per-cell EMBEDDED POOL (the vectors), not just
// the stored scalar response. No stored cell carries one today — Appendix C
// item 5 and this module's own header above both say so: populating it is
// #49/#50/#8 (Phase 2a)'s job, not this frame's. `buildFrame()` therefore
// takes an OPTIONAL `poolField` (dotted path into a completed cell's
// `result`, e.g. "pool") — omitted, every row is unchanged from before this
// issue. When supplied, a completed row's `pool` is read the same way
// `response` is, but unlike `response` it is allowed to be ABSENT (undefined)
// on any given row, since no cell has one yet; only a PRESENT-but-malformed
// value (not a non-empty array) is a hard error. Deciding what to do about
// partial/absent pool coverage is the rarefied-frame builder's job
// (evals/analysis/rarefiedFrame.mjs), not this one's — buildFrame() only
// ever reports what it found.

import { priceRows } from "../../lib/price.mjs";
import { configHash as computeConfigHash } from "../../lib/manifest.mjs";
import { isStudyCellKey } from "./storeConfig.mjs";

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
 *   @param {object} [opts.config]        the config object whose hash marks
 *                                         which stored cells are comparable
 *                                         (passed to lib/manifest.mjs:configHash)
 *   @param {string} [opts.configHash]    an ALREADY-RESOLVED config hash, used
 *                                         verbatim instead of hashing
 *                                         `opts.config`. This is how
 *                                         analysis.mjs selects cells (issue
 *                                         #91): it reads the hash off the
 *                                         store's own index rather than
 *                                         recomputing it from a config the
 *                                         operator retyped by hand, which is
 *                                         a config that drifts. Mutually
 *                                         exclusive with `opts.config`.
 *   @param {string} [opts.responseField="distinct_k"]  dotted path into a
 *                                         completed cell's `result` naming
 *                                         the numeric response to fit
 *   @param {string} [opts.poolField]     dotted path into a completed cell's
 *                                         `result` naming its embedded pool
 *                                         (vectors), for rarefaction (issue
 *                                         #73). Omitted by default — no
 *                                         existing caller's rows gain a
 *                                         `pool` field. When given, a row's
 *                                         `pool` is present only if the cell
 *                                         actually has one (no cell does
 *                                         today; see this module's header).
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
 *     replicate: number, cfg: string, response: number, costUsd: number,
 *     pool?: number[][]}>,
 *   armLevels: string[],
 *   briefLevels: string[],
 *   responseField: string,
 *   poolField: string|undefined,
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
  const poolField = opts.poolField;
  if (opts.configHash !== undefined && opts.config !== undefined) {
    throw new Error(
      "buildFrame: pass EITHER opts.config (hash it here) OR opts.configHash (already resolved, e.g. read off the " +
        "store by evals/analysis/storeConfig.mjs) — never both, since the two could disagree and only one can win",
    );
  }
  // `opts.configHash` may be a single hash or a LIST (issue #168 -- see
  // storeConfig.mjs's "Naming SEVERAL is allowed" for why a list is the
  // operator choosing out loud rather than this module guessing). Normalized
  // to a Set here so the per-entry test below stays one comparison either way.
  const cfgList =
    opts.configHash !== undefined ? [].concat(opts.configHash) : [computeConfigHash(opts.config || {})];
  const cfgSet = new Set(cfgList);
  // The single-hash face of the selection, for `frame.configHash` and every
  // message built from it. With a pooled list this understates the selection,
  // which is why `frame.configHashes` carries the whole set.
  const cfg = cfgList[0];

  const rows = [];
  const excluded = { failed: [], skipped: [], stale: [] };
  const failuresByArm = {};
  const skippedByArm = {};
  const seenArms = new Set();
  const seenBriefs = new Set();

  // list() reads only index.jsonl — cheap, whole-index metadata, no bodies.
  const entries = store.list().sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  for (const entry of entries) {
    // Only STUDY CELLS are arms. A store also holds records that borrow the
    // cell-key grammar without being cells -- `judge-call|cell=<cellKey>|...`,
    // `judge-scores|...`, and `batch-replay|cell=<cellKey>|attempt=N` -- and
    // each carries a SENTINEL armId (`__judge-call__`, `__batch-replay__`)
    // precisely so it can never be mistaken for a real arm.
    //
    // Without this filter a `batch-replay` record is: state `skipped`, cfg
    // equal to the run's real configHash (it is derived from the cell key it
    // resumes), armId `__batch-replay__`. It therefore survives the stale
    // check, enters `seenArms`, and contributes zero completed rows --
    // so the differential-attrition guard at the end of this function fires
    // on a PSEUDO-ARM and refuses to build the frame at all. Every real arm
    // can be perfectly healthy and the analysis still dies, with a message
    // about attrition that describes nothing that happened.
    //
    // Found on Study 1 Stage 1b: 141 of 144 cells completed, three panel
    // cells failed, each leaving one batch-replay resume record, and the
    // registered analysis could not run. Stage 1a never hit it only because
    // it ran `--no-batch` and so wrote no such records -- fixing #148 (batch
    // mode submitting one Message Batch per cell) is what made this
    // reachable.
    //
    // The check sits AFTER the stale test on purpose, and the ordering is
    // load-bearing rather than incidental. A judge-call record's index `cfg`
    // is a judge MODEL ID, so it is already excluded as stale, and
    // storeConfig.test.mjs pins that: the "store holds" candidate list drops
    // it while the raw stale COUNT still reports it, so an operator reading
    // "N excluded as stale" is told about everything that was set aside.
    // Moving this filter above the stale test would silently change that
    // count. The bug being fixed is narrower than that contract, so the fix
    // is too.
    //
    // `isStudyCellKey(key, entry.cfg)` -- the entry's OWN cfg, matching
    // storeConfig.mjs's tallyStoredConfigs -- asks "is this a well-formed
    // cell key whose embedded cfg agrees with its index entry". A
    // batch-replay record fails the key shape, so it lands in NO bucket,
    // which is right: it is not a study cell in any config, and it is not
    // recoverable by passing --config-hash.
    if (!cfgSet.has(entry.cfg)) {
      excluded.stale.push({ key: entry.key, armId: entry.armId, briefId: entry.briefId, cfg: entry.cfg });
      continue;
    }
    if (!isStudyCellKey(entry.key, entry.cfg)) continue;

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

    const row = {
      cellKey: entry.key,
      armId: entry.armId,
      briefId: entry.briefId,
      replicate: entry.replicate,
      cfg: entry.cfg,
      response,
      costUsd,
    };

    if (poolField) {
      const pool = getPath(body.result, poolField);
      if (pool !== undefined && (!Array.isArray(pool) || pool.length === 0)) {
        throw new Error(
          `buildFrame: completed cell '${entry.key}' has an invalid ${poolField} — expected a non-empty array ` +
            `of embedded vectors, or the field entirely absent (no cell carries one until #8/Phase 2a), got ${JSON.stringify(pool)}`,
        );
      }
      row.pool = pool; // undefined on any row whose cell predates #8 — allowed
    }

    rows.push(row);
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
    poolField,
    configHash: cfg,
    configHashes: cfgList,
    excluded,
    failuresByArm,
    skippedByArm,
  };
}

/**
 * Thrown when a frame selected ZERO rows — every stored cell was excluded.
 *
 * Issue #91: this state used to travel silently. `buildFrame()` reports it
 * honestly (`rows: []`, `armLevels: []`, the whole store in `excluded.stale`),
 * but the first thing to NOTICE was contrasts.mjs, four modules downstream,
 * complaining that `referenceArm 'A' is not in armLevels []` — which reads as
 * a bad `--reference-arm` argument rather than as "your entire dataset was
 * excluded, under a config hash nothing in the store carries".
 *
 * `storeConfig.mjs` now makes the common cause (a config hash the store does
 * not hold) unreachable from the CLI. This assert is the belt-and-braces
 * behind it: it names the outcome AS ITSELF, and reports the expected hash
 * against what the store actually holds. Deliberately a separate assert
 * rather than a throw inside `buildFrame()` — a zero-row frame is a legitimate
 * intermediate for other callers (frame.test.mjs builds several), and the
 * never-silently-pool rule this protects is about REPORTING the exclusion,
 * not about forbidding it.
 */
export class NoCellsSelectedError extends Error {
  constructor(frame) {
    // Study cells only: a real store's `stale` pile also holds judge-call and
    // phase0 records whose `cfg` is a judge model id / an object (see
    // storeConfig.mjs), and listing those as candidate config hashes would
    // send the reader chasing a hash that never existed.
    const staleByCfg = new Map();
    for (const s of frame.excluded.stale) {
      if (!isStudyCellKey(s.key, s.cfg)) continue;
      staleByCfg.set(s.cfg, (staleByCfg.get(s.cfg) || 0) + 1);
    }
    const held =
      Array.from(staleByCfg.entries())
        .sort((a, b) => (a[0] < b[0] ? -1 : 1))
        .map(([cfg, n]) => `${cfg} (${n})`)
        .join(", ") || "no cells at all";
    const stale = frame.excluded.stale.length;
    const failed = frame.excluded.failed.length;
    const skipped = frame.excluded.skipped.length;
    super(
      `buildFrame selected 0 cells: ${stale} excluded as stale, ${failed} as failed, ${skipped} as skipped; ` +
        `expected cfg ${frame.configHash}, store holds ${held}. ` +
        `This is an EXCLUSION outcome, not a modelling one — nothing downstream was ever given data to fit.`,
    );
    this.name = "NoCellsSelectedError";
    this.configHash = frame.configHash;
  }
}

/** Throw NoCellsSelectedError if `frame` has no rows. Called at the CLI
 *  boundary (analysis.mjs), so total exclusion is reported where the operator
 *  can act on it. */
export function assertCellsSelected(frame) {
  if (!frame.rows.length) throw new NoCellsSelectedError(frame);
  return frame;
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
