// pareto.mjs — the cost/diversity Pareto frontier (§6.3: "not report a
// single best model — the output is a cost/diversity Pareto frontier"), and
// the DESCRIPTIVE cost lane B6 replaces §6.2's log(cost)-offset model with.
//
// ── Why the cost lane is descriptive, not modeled ────────────────────────
// B6: "log(cost) as an offset does not parse under a Gaussian identity
// link -- an offset is a log-link concept. Further, cost varies negligibly
// WITHIN arm, so the offset is effectively an arm-level constant and GEE
// machinery adds nothing." Registered instead: a descriptive
// distinct_k/cost RATIO per arm, with CLUSTER-BOOTSTRAP CIs over briefs
// (briefs are the unit of resampling because they're the source of
// between-cell correlation the model would otherwise have to account for --
// resampling briefs with replacement and recomputing the ratio propagates
// that correlation into the CI without needing a model at all). Always
// labelled "descriptive" in its return value so a report can never present
// it as a confirmatory contrast.

/**
 * 2D Pareto frontier over (cost, response): minimize cost, maximize
 * response. Pure — takes per-arm summaries, returns the same objects
 * annotated with `onFrontier`.
 *
 * @param {Array<{armId: string, meanCostUsd: number, meanResponse: number}>} arms
 * @returns {Array<{armId: string, meanCostUsd: number, meanResponse: number, onFrontier: boolean}>}
 */
export function paretoFrontier(arms) {
  if (!Array.isArray(arms) || arms.length === 0) {
    throw new Error("paretoFrontier: arms must be a non-empty array");
  }
  return arms.map((a) => {
    const dominated = arms.some((b) => {
      if (b === a) return false;
      const atLeastAsGood = b.meanCostUsd <= a.meanCostUsd && b.meanResponse >= a.meanResponse;
      const strictlyBetter = b.meanCostUsd < a.meanCostUsd || b.meanResponse > a.meanResponse;
      return atLeastAsGood && strictlyBetter;
    });
    return { ...a, onFrontier: !dominated };
  });
}

/**
 * Derive a numeric PRNG seed from a configHash string (or any string) —
 * deterministic, never wall-clock. `costDiversityRatio()`'s default
 * (`opts.seed ?? 1`) is only a fallback for callers that don't pass one
 * (e.g. a unit test fixture with no real configHash); analysis.mjs wires
 * this in for the real pipeline (#46 QA SHOULD — the seed must actually be
 * derived from configHash, not just documented as if it were).
 *
 * @param {string} str
 * @returns {number}  a 32-bit unsigned int seed
 */
export function seedFromString(str) {
  let h = 0x811c9dc5; // FNV-1a
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Deterministic PRNG (mulberry32) — bootstrap resampling must be
 *  reproducible from `seed` (derived from configHash, never wall-clock; see
 *  frame.mjs / fit.mjs's determinism requirements), so this module never
 *  calls Math.random(). */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Descriptive distinct_k/cost ratio for ONE arm, with a cluster-bootstrap
 * CI over briefs (resample the arm's briefs with replacement, recompute the
 * pooled ratio over the resampled rows, repeat `iterations` times, take a
 * percentile CI).
 *
 * @param {Array<{briefId: string, response: number, costUsd: number}>} armRows
 *   every row (cell) for one arm — one entry per (brief, replicate)
 * @param {object} [opts]
 *   @param {number} [opts.iterations=2000]
 *   @param {number} [opts.seed=1]              deterministic PRNG seed
 *   @param {number} [opts.confidenceLevel=0.95]
 * @returns {{
 *   ratio: number, ciLower: number, ciUpper: number, iterations: number,
 *   confidenceLevel: number, descriptive: true,
 * }}
 */
export function costDiversityRatio(armRows, opts = {}) {
  if (!Array.isArray(armRows) || armRows.length === 0) {
    throw new Error("costDiversityRatio: armRows must be a non-empty array");
  }
  const iterations = opts.iterations ?? 2000;
  const confidenceLevel = opts.confidenceLevel ?? 0.95;
  const rng = mulberry32(opts.seed ?? 1);

  const pooledRatio = (rows) => {
    const totalResponse = rows.reduce((s, r) => s + r.response, 0);
    const totalCost = rows.reduce((s, r) => s + r.costUsd, 0);
    if (totalCost <= 0) throw new Error("costDiversityRatio: total cost is non-positive — cannot compute a distinct_k/cost ratio");
    return totalResponse / totalCost;
  };

  const briefIds = Array.from(new Set(armRows.map((r) => r.briefId)));
  const byBrief = new Map(briefIds.map((id) => [id, armRows.filter((r) => r.briefId === id)]));

  const ratio = pooledRatio(armRows);

  const samples = [];
  for (let it = 0; it < iterations; it++) {
    const resampledRows = [];
    for (let i = 0; i < briefIds.length; i++) {
      const pick = briefIds[Math.floor(rng() * briefIds.length)];
      resampledRows.push(...byBrief.get(pick));
    }
    samples.push(pooledRatio(resampledRows));
  }
  samples.sort((a, b) => a - b);
  const alpha = 1 - confidenceLevel;
  const lo = samples[Math.max(0, Math.floor((alpha / 2) * samples.length))];
  const hi = samples[Math.min(samples.length - 1, Math.ceil((1 - alpha / 2) * samples.length) - 1)];

  return { ratio, ciLower: lo, ciUpper: hi, iterations, confidenceLevel, descriptive: true };
}

/**
 * costDiversityRatio() for every arm present in `frame.rows`, keyed by armId.
 *
 * @param {import("./frame.mjs").buildFrame extends (...a: any) => infer R ? R : never} frame
 * @param {object} [opts]  forwarded to costDiversityRatio per arm
 * @returns {Record<string, ReturnType<typeof costDiversityRatio>>}
 */
export function costDiversityRatioByArm(frame, opts = {}) {
  const byArm = new Map();
  for (const row of frame.rows) {
    if (!byArm.has(row.armId)) byArm.set(row.armId, []);
    byArm.get(row.armId).push(row);
  }
  const out = {};
  for (const [armId, rows] of byArm) {
    out[armId] = costDiversityRatio(rows, opts);
  }
  return out;
}
