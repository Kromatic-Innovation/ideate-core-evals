// anova-oracle.mjs — a pure-JS closed-form balanced two-way mixed-ANOVA
// oracle: y ~ arm(fixed) + brief(random) + brief:arm(random), on a COMPLETE
// BALANCED design (every arm x brief cell has the same replicate count).
// On such a design the moment (method-of-moments) variance-component
// estimators are a mathematical IDENTITY, not an approximation to REML —
// this is what lets fit.integration.test.mjs validate the real Python
// sidecar's MixedLM/REML fit without lme4 or R on the host (see fit.mjs's
// header and #46's testing-layer-3 note).
//
// ── The one easy-to-get-wrong step: the arm contrast SE ─────────────────────
// Because briefs are CROSSED with arm (every brief is observed under every
// arm) and brief:arm is a random interaction NESTED under brief, the random
// brief effect cancels exactly out of any arm-vs-arm mean DIFFERENCE — so
// Var(mean_a - mean_a') is driven by the interaction term, not by MSE:
//   Var(ybar_a - ybar_a') = 2 * (sigma_ab^2 + sigma_e^2/r) / k
//                          = 2 * MS_AB / (k * r)     (since E[MS_AB] = sigma_e^2 + r*sigma_ab^2)
// Using MSE here instead of MS_AB is the standard mistake this file exists
// to avoid — see fitR2's CR2 and fit_mixedlm.py's REML fit, both of which
// this oracle validates against for exactly this quantity.

function mean(xs) {
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}

/**
 * @param {Array<{armId: string, briefId: string, response: number}>} rows
 *   a COMPLETE balanced grid: every (arm, brief) pair present with the same
 *   replicate count `r`.
 * @param {string[]} armLevels
 * @param {string[]} briefLevels
 * @returns {{
 *   a: number, k: number, r: number,
 *   msA: number, msB: number, msAB: number, msE: number,
 *   sigmaE2: number, sigmaAB2: number, sigmaB2: number,
 *   grandMean: number,
 *   armMeans: Record<string, number>,
 *   armContrastSE: (armX: string, armY: string) => number,
 * }}
 */
export function balancedAnovaOracle(rows, armLevels, briefLevels) {
  const a = armLevels.length;
  const k = briefLevels.length;

  const byCell = new Map(); // "arm|brief" -> response[]
  for (const row of rows) {
    const key = `${row.armId}|${row.briefId}`;
    if (!byCell.has(key)) byCell.set(key, []);
    byCell.get(key).push(row.response);
  }

  let r = null;
  for (const arm of armLevels) {
    for (const brief of briefLevels) {
      const cell = byCell.get(`${arm}|${brief}`);
      if (!cell || cell.length === 0) throw new Error(`balancedAnovaOracle: missing cell (${arm}, ${brief}) — design is not complete/balanced`);
      if (r === null) r = cell.length;
      else if (cell.length !== r) throw new Error(`balancedAnovaOracle: cell (${arm}, ${brief}) has ${cell.length} replicates, expected ${r} — design is not balanced`);
    }
  }

  const cellMean = (arm, brief) => mean(byCell.get(`${arm}|${brief}`));
  const armMean = (arm) => mean(briefLevels.flatMap((brief) => byCell.get(`${arm}|${brief}`)));
  const briefMean = (brief) => mean(armLevels.flatMap((arm) => byCell.get(`${arm}|${brief}`)));
  const grandMean = mean(rows.map((row) => row.response));

  const armMeans = {};
  for (const arm of armLevels) armMeans[arm] = armMean(arm);
  const briefMeans = {};
  for (const brief of briefLevels) briefMeans[brief] = briefMean(brief);

  let ssA = 0;
  for (const arm of armLevels) ssA += (armMeans[arm] - grandMean) ** 2;
  ssA *= k * r;
  const dfA = a - 1;

  let ssB = 0;
  for (const brief of briefLevels) ssB += (briefMeans[brief] - grandMean) ** 2;
  ssB *= a * r;
  const dfB = k - 1;

  let ssAB = 0;
  for (const arm of armLevels) {
    for (const brief of briefLevels) {
      const term = cellMean(arm, brief) - armMeans[arm] - briefMeans[brief] + grandMean;
      ssAB += term ** 2;
    }
  }
  ssAB *= r;
  const dfAB = (a - 1) * (k - 1);

  let ssE = 0;
  for (const arm of armLevels) {
    for (const brief of briefLevels) {
      const cm = cellMean(arm, brief);
      for (const y of byCell.get(`${arm}|${brief}`)) ssE += (y - cm) ** 2;
    }
  }
  const dfE = a * k * (r - 1);

  const msA = ssA / dfA;
  const msB = ssB / dfB;
  const msAB = ssAB / dfAB;
  const msE = dfE > 0 ? ssE / dfE : 0;

  const sigmaE2 = msE;
  const sigmaAB2 = Math.max(0, (msAB - msE) / r);
  const sigmaB2 = Math.max(0, (msB - msAB) / (a * r));

  return {
    a, k, r,
    msA, msB, msAB, msE,
    sigmaE2, sigmaAB2, sigmaB2,
    grandMean,
    armMeans,
    armContrastSE(armX, armY) {
      if (armX === armY) return 0;
      return Math.sqrt((2 * msAB) / (k * r));
    },
  };
}
