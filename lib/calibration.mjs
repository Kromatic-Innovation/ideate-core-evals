// calibration.mjs — derive a token-cost model from the results store (issue #169).
//
// WHY THIS EXISTS
//
// `--max-spend` is enforced against a projection. Until #169 that projection
// came entirely from a two-row constant table keyed on `arm.mode`
// (lib/price.mjs's PLAN_TOKEN_ESTIMATE: panel 16k/9k, solo 2.5k/1.5k). It had
// no model of `effort`, no model of N, and no memory of what any arm had
// actually cost. The Stage 1c re-collect projected $41.59 against an actual
// $105.22 — a 2.5x under-projection, concentrated in `S1C-RICH`, the one arm
// carrying `effort: max` slots (docs/PREREGISTRATION.md Appendix L item 7,
// issue #169).
//
// The under-projection is the more interesting half of the bug. The store
// ALREADY HELD the answer: that re-collect was a re-collect — every one of
// those arms had been run before under a prior configHash, with real token
// counts sitting in `costRows`. The projection ignored them and consulted a
// constant instead.
//
// So this module fits the projection to the store:
//
//   TIER 1 — per-arm empirical tokens. For any arm with at least
//     `minCellsPerArm` completed cells anywhere in the store (ANY configHash —
//     see "Why any configHash" below), the mean measured input/output tokens
//     per cell. Exact for a re-collect, which is the case that burned us.
//
//   TIER 2 — per-effort output multipliers, for arms the store has never run.
//     Fitted from arms whose slots are HOMOGENEOUS in effort, by comparing
//     each level's mean per-slot output tokens against the `high` baseline.
//     Falls back to lib/price.mjs's documented static EFFORT_OUTPUT_MULTIPLIER
//     when the store cannot support a fit, and SAYS SO in `warnings` — never
//     silently to 1.0, which is the shape of the original defect.
//
// WHAT THIS DELIBERATELY DOES NOT MODEL
//
// N (`panel.ideasPerAgent` / an arm's total ideas requested) is unmodeled at
// tier 2. The store shows it matters — S1-N10 979, S1-C0 (N=30) 2,392,
// S1-N60 4,177 mean output tokens, same model and effort — but a two-parameter
// fit over three points from one arm family is not a model, it is a curve
// drawn through the only data there is. Tier 1 subsumes N for any arm the
// store has seen; for an arm it has not, the projection is reported as a FLOOR
// (lib/price.mjs's UNCALIBRATED_HIGH_FACTOR and the `calibrated: false` flag),
// which is the honest treatment issue #169 explicitly authorises.
//
// WHY ANY configHash
//
// `configHash` gates COMPARABILITY of results — two cells under different
// hashes must never be pooled as data (lib/manifest.mjs). It does not gate
// what a cell COST. A prompt-constant edit re-keys every cell without changing
// how many tokens the arm burns, and the re-collect that motivated this issue
// was exactly that. Restricting the fit to the current hash would have made
// this module blind in precisely the situation it exists for.
//
// COST
//
// This reads and JSON-parses every stored body, the same whole-store read
// `spendToDate` performs (see its own COST NOTE). Call it once per invocation,
// at plan time, and only when a ceiling is active.

import { EFFORT_OUTPUT_MULTIPLIER } from "./price.mjs";

/** Minimum completed cells for an arm before its measured tokens are trusted. */
export const DEFAULT_MIN_CELLS_PER_ARM = 3;

/** Minimum cells behind ONE effort level before that level's multiplier is fitted. */
export const DEFAULT_MIN_CELLS_PER_EFFORT = 10;

/**
 * The effort level an arm's slots agree on, or null if they disagree.
 *
 * A mixed-effort arm (S1C-RICH: two `max`, two `high`, one `low`) is excluded
 * from the effort FIT — its costRows report tokens per MODEL, not per slot, so
 * there is no honest way to attribute its output tokens to one level. It is
 * still eligible for a tier-1 per-arm fit, which needs no attribution at all.
 *
 * A slot with no `effort` key counts as `high`: docs/PREREGISTRATION.md
 * Appendix F item 5 registers the two as behaviourally equivalent, and
 * lib/price.mjs's `effortOutputMultiplier` resolves them identically.
 */
export function armEffortLevel(arm) {
  const slots = (arm && arm.slots) || [];
  if (slots.length === 0) return null;
  const levels = new Set(slots.map((s) => s.effort || "high"));
  return levels.size === 1 ? [...levels][0] : null;
}

/**
 * Mean input/output tokens per completed cell, per arm, read from the store.
 *
 * Non-provider models (the `voyage-*` embedder) are excluded: they are not
 * what a generation slot's rate prices, and folding them into a per-slot token
 * mean would misattribute embedder tokens to the generation model's rate.
 *
 * @param {object} store  a ResultsStore (lib/store.mjs)
 * @returns {Map<string, {inputTokens: number, outputTokens: number, n: number}>}
 */
export function measureArmTokens(store) {
  if (!store) throw new Error("measureArmTokens: store is required");
  // A store that cannot be enumerated yields no fit, not a throw. This is a
  // projection REFINEMENT: losing it costs fidelity (the run falls back to the
  // structural estimate and says so), never correctness. The ENFORCEMENT path
  // -- `spendToDate` -- still throws loudly on a store it cannot read, because
  // a ceiling genuinely cannot be enforced against an unreadable ledger. The
  // two have different failure modes on purpose.
  if (typeof store.list !== "function" || typeof store.get !== "function") return new Map();
  const acc = new Map();
  for (const entry of store.list()) {
    if (entry.state !== "completed") continue;
    if (!entry.armId) continue;
    let body;
    try {
      body = store.get(entry.key);
    } catch {
      // A body this module cannot read is skipped, NOT thrown on — unlike
      // `spendToDate`, which must throw because a ceiling cannot be enforced
      // against a ledger it cannot read. This is a calibration refinement: a
      // missing body costs fidelity (one fewer cell in a mean), never
      // correctness, and the count that survives is reported in `basis` so a
      // thin fit is visible rather than implied.
      continue;
    }
    let inTok = 0;
    let outTok = 0;
    for (const row of body.costRows || []) {
      for (const [model, t] of Object.entries(row.tokens_by_model || {})) {
        if (model.startsWith("voyage-")) continue;
        inTok += t.input_tokens || 0;
        outTok += t.output_tokens || 0;
      }
    }
    if (outTok <= 0) continue; // a stored cell with no generation tokens tells us nothing
    const cur = acc.get(entry.armId) || { inputTokens: 0, outputTokens: 0, n: 0 };
    cur.inputTokens += inTok;
    cur.outputTokens += outTok;
    cur.n += 1;
    acc.set(entry.armId, cur);
  }
  const out = new Map();
  for (const [armId, v] of acc) {
    out.set(armId, { inputTokens: v.inputTokens / v.n, outputTokens: v.outputTokens / v.n, n: v.n });
  }
  return out;
}

/**
 * Fit a plan-time cost model to the store.
 *
 * @param {object} store  a ResultsStore
 * @param {object} armsConfig  the parsed arms.config.json (needs `.arms`)
 * @param {object} [opts]
 *   @param {number} [opts.minCellsPerArm=DEFAULT_MIN_CELLS_PER_ARM]
 *   @param {number} [opts.minCellsPerEffort=DEFAULT_MIN_CELLS_PER_EFFORT]
 *   @param {object} [opts.staticEffortMultipliers=EFFORT_OUTPUT_MULTIPLIER]
 * @returns {{
 *   perArm: Object<string, {inputTokens:number, outputTokens:number, n:number}>,
 *   effortMultipliers: Object<string, number>,
 *   effortSource: "store"|"static",
 *   basis: {armCells: Object<string,number>, effortPerSlotOut: Object<string,{perSlotOut:number,n:number,arms:string[]}>},
 *   warnings: string[]
 * }}
 */
export function calibrateFromStore(store, armsConfig, opts = {}) {
  const {
    minCellsPerArm = DEFAULT_MIN_CELLS_PER_ARM,
    minCellsPerEffort = DEFAULT_MIN_CELLS_PER_EFFORT,
    staticEffortMultipliers = EFFORT_OUTPUT_MULTIPLIER,
  } = opts;
  if (!armsConfig || !armsConfig.arms) {
    throw new Error("calibrateFromStore: armsConfig (arms.config.json shape, with an .arms map) is required");
  }
  const warnings = [];
  const measured = measureArmTokens(store);

  // ── Tier 1 ────────────────────────────────────────────────────────────────
  const perArm = {};
  const armCells = {};
  for (const [armId, m] of measured) {
    armCells[armId] = m.n;
    if (m.n >= minCellsPerArm) perArm[armId] = m;
  }

  // ── Tier 2 ────────────────────────────────────────────────────────────────
  // Per-slot output tokens by effort level, pooled across every
  // effort-homogeneous arm the store has run. Per-SLOT (not per-cell) so a
  // 1-slot solo arm and a 5-slot panel arm can be pooled at the same level.
  const bySlotOut = new Map(); // effort -> { sum, n, arms:Set }
  for (const [armId, m] of measured) {
    const arm = armsConfig.arms[armId];
    if (!arm) continue; // an arm in the store but no longer in config — not fittable
    const level = armEffortLevel(arm);
    if (!level) continue; // mixed-effort: no honest attribution, see armEffortLevel
    const slotCount = (arm.slots || []).length;
    if (slotCount === 0) continue;
    const cur = bySlotOut.get(level) || { sum: 0, n: 0, arms: new Set() };
    // Weighted by cell count so an arm with 144 cells does not count the same
    // as one with 3.
    cur.sum += (m.outputTokens / slotCount) * m.n;
    cur.n += m.n;
    cur.arms.add(armId);
    bySlotOut.set(level, cur);
  }

  const effortPerSlotOut = {};
  for (const [level, v] of bySlotOut) {
    effortPerSlotOut[level] = { perSlotOut: v.sum / v.n, n: v.n, arms: [...v.arms].sort() };
  }

  let effortMultipliers = { ...staticEffortMultipliers };
  let effortSource = "static";
  const baseline = effortPerSlotOut.high;
  if (!baseline || baseline.n < minCellsPerEffort) {
    warnings.push(
      `[calibration] effort multipliers: STATIC (lib/price.mjs's EFFORT_OUTPUT_MULTIPLIER) -- the store has ` +
        `${baseline ? baseline.n : 0} completed cell(s) at effort 'high' across effort-homogeneous arms, ` +
        `below the ${minCellsPerEffort} needed to anchor a fit. The 'high' level IS the baseline; without it ` +
        `no other level can be expressed as a ratio.`,
    );
  } else {
    // Anchor at high === 1.0 by construction: it is the level PLAN_TOKEN_ESTIMATE
    // itself was calibrated at, so every other level is a ratio against it.
    const fitted = { high: 1.0 };
    for (const [level, v] of Object.entries(effortPerSlotOut)) {
      if (level === "high") continue;
      if (v.n < minCellsPerEffort) {
        warnings.push(
          `[calibration] effort '${level}': only ${v.n} completed cell(s) (arms: ${v.arms.join(", ")}), ` +
            `below the ${minCellsPerEffort} needed -- kept the static multiplier ` +
            `${staticEffortMultipliers[level]} rather than fitting to a thin sample.`,
        );
        continue;
      }
      fitted[level] = v.perSlotOut / baseline.perSlotOut;
    }
    // A level the store has no data for at all keeps its static value. It must
    // never fall through to 1.0 -- that is the original defect's exact shape.
    effortMultipliers = { ...staticEffortMultipliers, ...fitted };
    effortSource = "store";
    for (const level of Object.keys(staticEffortMultipliers)) {
      if (!(level in fitted)) {
        warnings.push(
          `[calibration] effort '${level}': the store holds no completed cells at this level in an ` +
            `effort-homogeneous arm -- kept the static multiplier ${staticEffortMultipliers[level]}.`,
        );
      }
    }
  }

  return {
    perArm,
    effortMultipliers,
    effortSource,
    basis: { armCells, effortPerSlotOut },
    warnings,
  };
}

/**
 * Operator-facing lines describing what the calibration was fitted to.
 *
 * The projection is a budget-safety number, so its BASIS has to be legible:
 * "$41.59" told the operator nothing about the fact that it was a constant
 * from a table. These lines say which arms were fitted, on how many cells,
 * where the effort multipliers came from, and what stayed static.
 *
 * @param {object} calibration  the return value of calibrateFromStore
 * @returns {string[]}
 */
export function formatCalibration(calibration) {
  if (!calibration) return [];
  const lines = [];
  const fittedArms = Object.entries(calibration.perArm).sort(([a], [b]) => a.localeCompare(b));
  if (fittedArms.length === 0) {
    lines.push("[calibration] per-arm token fit: NONE -- no arm in the store has enough completed cells. Every cell is priced from the structural estimate.");
  } else {
    lines.push(`[calibration] per-arm token fit from the store (${fittedArms.length} arm(s)):`);
    for (const [armId, m] of fittedArms) {
      lines.push(`[calibration]   ${armId}: ${Math.round(m.inputTokens)} in / ${Math.round(m.outputTokens)} out tokens per cell, mean of ${m.n} completed cell(s)`);
    }
  }
  const mult = Object.entries(calibration.effortMultipliers)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${Number(v).toFixed(2)}x`)
    .join(", ");
  lines.push(`[calibration] effort output multipliers (${calibration.effortSource}): ${mult}`);
  for (const w of calibration.warnings) lines.push(w);
  return lines;
}
