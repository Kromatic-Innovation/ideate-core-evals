// rarefiedFrame.mjs — wires evals/analysis/rarefaction.mjs's registered rule
// into a frame.mjs frame, for one arm-A contrast (issue #73,
// docs/PREREGISTRATION.md Appendix C items 2-5).
//
// ── Why row-grain, not arm-grain ────────────────────────────────────────────
// rarefaction.mjs's rarefyPools() takes an arbitrary {label: pool} map and
// rarefies every entry to the MINIMUM pool size present. Appendix C item 2
// registers the target as "the minimum pool size present in that contrast" —
// item 4 is explicit this is defined on OBSERVED SIZES, "never on arm
// identity". A frame.mjs frame is one row per (arm, brief, replicate) CELL,
// each with its own pool — not one pool per arm. So this module labels
// rarefyPools()'s input by `cellKey` (one label per row), not by `armId`:
// minPoolSize is computed over every cell actually in the contrast, exactly
// as registered, and every cell gets its own rarefied response for the fit.
//
// ── Why this is a SEPARATE frame from the full-pool one ─────────────────────
// Appendix C item 4 registers rarefaction per CONTRAST: H1 (mean(panel) -
// A), the A' ablation (A vs A'), and each per-arm exploratory breakdown
// (armX vs A) each have their OWN minimum-pool-size target, because each
// draws from a different set of arms. The same cell can therefore carry a
// DIFFERENT rarefied value depending which contrast it is being rarefied
// for. buildRarefiedFrame() takes an explicit `armIds` (the contrast's arm
// set) rather than assuming "every arm in the base frame" for exactly this
// reason — a caller building H1's frame passes [referenceArm, ...panelArms];
// a caller building the A' ablation's frame later would pass
// [referenceArm, "A'"] instead. H2/H3/H4 never call this module at all (item
// 4: "unaffected") — they keep fitting the base, full-pool frame.
//
// ── Never a silent full-pool substitute (Appendix C item 5) ─────────────────
// No stored cell carries a pool today (frame.mjs's own header, Appendix C
// item 5) — every real invocation of this module currently hits
// PoolsUnavailableError. That is a deliberate, named, loud failure: the
// defect Appendix C exists to close is exactly "a registered claim with no
// code path" (issue #73's own description) / "the registered estimand
// silently reported as the full-pool one". Callers MUST catch
// PoolsUnavailableError and report H1 as NOT COMPUTED (e.g. via the same
// `{unimplemented: true, p: 1}` shape contrasts.mjs already uses for H5) —
// never fall through to evaluating H1 against the full-pool fit.
//
// A cell in the contrast with SOME sibling cells carrying a pool and others
// not is refused outright (MixedPoolCoverageError): Appendix C rarefies the
// WHOLE contrast to one target, so a partial pool inventory cannot produce a
// partially rarefied result — there is no coherent way to average some cells
// at n and leave others at their raw, larger size.

import { rarefyPools, RAREFACTION_TREATMENT } from "./rarefaction.mjs";

export class PoolsUnavailableError extends Error {
  constructor(armIds, metric) {
    super(
      `buildRarefiedFrame: no per-cell pools present for the [${armIds.join(", ")}] contrast — rarefied ${metric} ` +
        `NOT COMPUTED. Every stored cell was measured before #8 (Phase 2a) populates embedded pools, so there is ` +
        `nothing to rarefy yet. This must never be treated as license to report the full-pool ${metric} under the ` +
        `rarefied label (docs/PREREGISTRATION.md Appendix C item 5) — the caller must report this hypothesis as ` +
        `not computed (p=1, unimplemented), the same convention already used for H5.`,
    );
    this.name = "PoolsUnavailableError";
    this.armIds = armIds;
    this.metric = metric;
  }
}

export class MixedPoolCoverageError extends Error {
  constructor(armIds, withPoolKeys, withoutPoolKeys) {
    super(
      `buildRarefiedFrame: ${withoutPoolKeys.length} of ${withPoolKeys.length + withoutPoolKeys.length} cells in the ` +
        `[${armIds.join(", ")}] contrast have no pool while the rest do — a partially rarefied contrast is incoherent ` +
        `(Appendix C item 2 rarefies the WHOLE contrast to one minimum-pool-size target). Cells missing a pool: ` +
        `${withoutPoolKeys.join(", ")}.`,
    );
    this.name = "MixedPoolCoverageError";
    this.armIds = armIds;
    this.withPoolKeys = withPoolKeys;
    this.withoutPoolKeys = withoutPoolKeys;
  }
}

/**
 * Build a rarefied frame for one arm-A contrast: every row's `response`
 * becomes its rarefied distinct_k (mean over RAREFACTION_R subsamples at the
 * contrast's minimum observed pool size), with the original full-pool value
 * preserved as `responseFullPool` so a caller/report can show both
 * (Appendix C item 5).
 *
 * Only metrics registered "rarefied" in RAREFACTION_TREATMENT
 * (rarefaction.mjs) may be passed — `poolFluency`/`collapseRate` (excluded)
 * and `poolDiversity`/`distinctKPerDollar` (full-pool) all throw, per
 * Appendix C item 3. `poolFlexibility` is accepted and treated IDENTICALLY
 * to `distinct_k`: it is registered as an identity pass-through of
 * distinct_k's clustering count (operational.mjs's `poolFlexibility(k) ===
 * k`), not a separately computed quantity — there is no second clustering
 * pass to run for it.
 *
 * @param {ReturnType<typeof import("./frame.mjs").buildFrame>} frame  a base
 *   frame built with a `poolField` (frame.mjs) so rows may carry `.pool`
 * @param {object} opts
 *   @param {string[]} opts.armIds     this contrast's arm set (must include
 *                                     every arm the contrast weighs — e.g.
 *                                     [referenceArm, ...panelArms] for H1)
 *   @param {number} opts.threshold   clustering distance threshold — MUST be
 *                                     the same threshold `distinct_k` was
 *                                     originally measured at (this study's
 *                                     registered `clusterDistanceThreshold`,
 *                                     lib/manifest.mjs CONFIG_FIELDS) or the
 *                                     free full-pool-agreement check below
 *                                     will (correctly) refuse to proceed.
 *   @param {string} [opts.metric="distinct_k"]  which §4.1 metric this is —
 *                                     gates against RAREFACTION_TREATMENT.
 *   @param {object} [opts.rarefyOpts]  forwarded to rarefyPools() (r, seed) —
 *                                     omit to use the registered
 *                                     RAREFACTION_R / RAREFACTION_SEED.
 * @returns {ReturnType<typeof import("./frame.mjs").buildFrame>}  same shape
 *   as the input frame, restricted to `armIds`' rows, with `response`
 *   replaced by the rarefied value and `responseFullPool`/`rarefiedN`/
 *   `poolSize` added per row.
 */
export function buildRarefiedFrame(frame, opts = {}) {
  const armIds = opts.armIds;
  const metric = opts.metric || "distinct_k";

  // ── Structural guards: always a caller bug, independent of pool
  // availability -- these fire regardless of whether pools exist, because
  // they describe a malformed CALL, not the (today, expected) state of the
  // store. ─────────────────────────────────────────────────────────────────
  if (!Array.isArray(armIds) || armIds.length < 2) {
    throw new Error("buildRarefiedFrame: opts.armIds must name at least two arms (the contrast this rarefies)");
  }
  const treatment = RAREFACTION_TREATMENT[metric];
  if (treatment !== "rarefied") {
    throw new Error(
      `buildRarefiedFrame: '${metric}' is registered '${treatment || "unknown"}' in RAREFACTION_TREATMENT (rarefaction.mjs), ` +
        `not "rarefied" — docs/PREREGISTRATION.md Appendix C item 3 forbids rarefying this metric for an arm-A contrast`,
    );
  }

  const contrastRows = frame.rows.filter((r) => armIds.includes(r.armId));
  if (contrastRows.length === 0) {
    throw new Error(`buildRarefiedFrame: no rows in the frame belong to any of [${armIds.join(", ")}]`);
  }

  // ── Pool-coverage check comes BEFORE the threshold requirement, on
  // purpose (issue #73 fix round). Today, EVERY real store is pool-less
  // (Appendix C item 5 -- #8/Phase 2a hasn't run) -- that is the expected,
  // registered state, not a misconfiguration, and it needs no threshold at
  // all: there is nothing to cluster. Requiring a valid threshold before
  // even checking whether there's anything to rarefy would turn today's
  // ordinary "not computed yet" case into an indistinguishable-from-a-bug
  // thrown Error the moment a caller (analysis.mjs) forgets to pass
  // --cluster-distance-threshold -- which is exactly the documented CLI
  // invocation before this fix. A threshold is only demanded once there is
  // real work to do with it, below. ──────────────────────────────────────
  const withPool = contrastRows.filter((r) => r.pool !== undefined);
  const withoutPool = contrastRows.filter((r) => r.pool === undefined);

  if (withPool.length === 0) {
    throw new PoolsUnavailableError(armIds, metric);
  }
  if (withoutPool.length > 0) {
    throw new MixedPoolCoverageError(
      armIds,
      withPool.map((r) => r.cellKey),
      withoutPool.map((r) => r.cellKey),
    );
  }

  // Pools ARE present -- there is real work to do, so a threshold is now
  // required. Missing/invalid here is a genuine misconfiguration and must
  // keep hard-failing (uncaught by analysis.mjs's narrow PoolsUnavailableError
  // catch), never silently degrade to "not computed".
  const threshold = opts.threshold;
  if (!Number.isFinite(threshold)) {
    throw new Error(
      "buildRarefiedFrame: opts.threshold (the registered clusterDistanceThreshold, lib/manifest.mjs CONFIG_FIELDS) is required — " +
        "there is no default, because a wrong threshold would silently make the rarefied and full-pool numbers incommensurable",
    );
  }

  // Row-grain labeling (see module header): minPoolSize inside rarefyPools()
  // is computed over every cell actually in THIS contrast, not per arm.
  const poolsByLabel = {};
  for (const r of contrastRows) poolsByLabel[r.cellKey] = r.pool;
  const rarefied = rarefyPools(poolsByLabel, threshold, opts.rarefyOpts || {});

  // Free invariant (issue #73 review): rarefyPools() recomputes each pool's
  // FULL-pool distinct_k straight from the vectors. It must agree with the
  // scalar `response` frame.mjs already read off the stored cell — if it
  // doesn't, either `threshold` here doesn't match what generation used, or
  // `poolField` points at the wrong data, or the stored scalar is stale.
  // Catching that here, at the one seam where both numbers are in hand, is
  // strictly cheaper than a reader noticing two disagreeing "distinct_k"
  // columns in REPORT.md.
  for (const r of contrastRows) {
    const rec = rarefied[r.cellKey];
    if (Math.abs(rec.distinctKFullPool - r.response) > 1e-9) {
      throw new Error(
        `buildRarefiedFrame: cell '${r.cellKey}' full-pool ${metric} recomputed from its stored pool ` +
          `(${rec.distinctKFullPool}) disagrees with the stored result (${r.response}) — likely opts.threshold does ` +
          `not match the threshold this cell was originally measured at, or opts.poolField/opts.metric points at ` +
          `mismatched data. Refusing to rarefy on top of an already-inconsistent full-pool number.`,
      );
    }
  }

  const rows = contrastRows.map((r) => {
    const rec = rarefied[r.cellKey];
    return {
      ...r,
      responseFullPool: r.response,
      response: rec.distinctKRarefied,
      rarefiedN: rec.rarefiedN,
      poolSize: rec.poolSize,
    };
  });

  // Deliberately NOT `{...frame, rows, ...}`: `frame.excluded` /
  // `failuresByArm` / `skippedByArm` describe the FULL base frame's whole
  // population (every arm, every failure/skip tally), while `rows` here is
  // a CONTRAST-SCOPED SUBSET. Spreading them in would silently attach
  // full-frame tallies to a filtered frame — a latent trap for any future
  // caller that reads `rarefiedFrame.excluded`/`.failuresByArm` expecting
  // them to describe this contrast (issue #73 fix round). There is no
  // contrast-scoped equivalent to compute (a contrast only ever sees
  // completed cells to begin with — failures/skips never reach `frame.rows`
  // in the first place), so those fields are omitted entirely rather than
  // guessed at. A caller that needs the full population's failure/skip
  // tallies reads them off the ORIGINAL base frame, not this one.
  // responseField is named `<metric>_rarefied`, NOT `frame.responseField`
  // verbatim (issue #73 fix round, non-blocking rider): the values under it
  // are RAREFIED MEANS (an average over RAREFACTION_R subsamples), not the
  // raw integer counts `frame.responseField` (e.g. "distinct_k") names
  // elsewhere. Reusing the same column name would leave a rarefied mean
  // sitting under a count's label in analysis-data-rarefied.csv and
  // lme4-fit-rarefied.R -- both consume this field directly (reproducibility.mjs
  // is metric-name-agnostic; it just needs SOME field name, this one says
  // what the numbers under it actually are).
  return {
    rows,
    armLevels: frame.armLevels.filter((a) => armIds.includes(a)),
    briefLevels: frame.briefLevels,
    responseField: `${metric}_rarefied`,
    poolField: frame.poolField,
    configHash: frame.configHash,
    rarefied: true,
    rarefiedMetric: metric,
    rarefiedArmIds: armIds,
  };
}
