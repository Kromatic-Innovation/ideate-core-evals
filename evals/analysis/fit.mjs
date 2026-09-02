// fit.mjs — the sidecar boundary and the B7 fallback ladder (#44 Appendix
// B7 / #46). This is the ONLY module that talks to Python, and even here
// Python's job is minimal: fit R0 or R1 and hand back coefficients + the
// FULL vcov matrix + diagnostics. Every other registered statistic
// (contrasts, multiplicity, Pareto, CR2) lives in Node — see contrasts.mjs
// and pareto.mjs.
//
// ── The ladder ────────────────────────────────────────────────────────────
//   R0: y ~ arm + (1|brief) + (1|brief:arm)   -- sidecar (MixedLM)
//   R1: y ~ arm + (1|brief)                    -- sidecar (MixedLM)
//   R2: OLS + CR2 cluster-robust SEs, cluster=brief  -- pure Node (this file)
//   R3: no confirmatory inference; descriptive only
//
// Rung is selected from FIT DIAGNOSTICS ALONE, per lane, BEFORE any contrast
// is computed -- never from a p-value. Descent criteria (R0->R1, R1->R2):
// `converged === false` OR any non-finite/<=0 vcov diagonal OR any NaN
// coefficient SE. R2 is ADDITIONALLY computed and reported at every rung as
// a standing robustness check, not only as the R1-failure fallback -- it
// changes the estimand weighting (see `robustnessCheck` on the returned
// ladder result).
//
// A BOUNDARY VARIANCE COMPONENT IS A FINDING, NOT AN ERROR: `(1|brief:arm)`
// estimating at/near zero means no arm x brief interaction and is reported
// as such -- it does NOT trigger a descent. Only non-convergence / NaN /
// non-finite triggers one. See runLadder()'s descent check, which never
// inspects `varianceComponents`.
//
// ── Sidecar-unavailable is a HARD FAILURE, not R3 (a deliberate resolution
//    of a wording tension between #44 and #46) ───────────────────────────
// #44's R3 row literally reads "R0-R2 all fail, or sidecar unavailable."
// #46 and this issue's brief are explicit and non-negotiable: "Sidecar
// absence is a hard failure ... exit non-zero with a named error, emit no
// numbers. There is no silent degradation." Resolution: sidecar-unavailable
// (missing venv, import error, non-zero exit, schema-invalid response) is a
// SEPARATE hard-fail path OUTSIDE the ladder, thrown as SidecarUnavailableError
// before any rung is even attempted -- it never produces an R3 result object.
// R3 is reachable ONLY when the sidecar ran successfully for R0 and R1 (both
// failed their descent criteria) AND R2 (computed entirely in Node, needs no
// sidecar) also fails -- e.g. fewer clusters (briefs) than fixed-effect
// parameters, making the CR2 sandwich uncomputable.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { invert, multiply, transpose, symmetricInverseSqrt } from "./linalg.mjs";
import { JUDGE_SCORE_BIAS_COEFFICIENT } from "./judgeScoreFrame.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const SIDECAR_SCRIPT_PATH = join(__dirname, "sidecar", "fit_mixedlm.py");
export const SIDECAR_VENV_PYTHON = join(__dirname, "sidecar", ".venv", "bin", "python3");

export class SidecarUnavailableError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = "SidecarUnavailableError";
    this.cause = cause;
  }
}

export class SidecarSchemaError extends Error {
  constructor(message) {
    super(message);
    this.name = "SidecarSchemaError";
  }
}

// ── Design / expected coefficient naming (must match contrasts.mjs) ────────

function expectedCoefficientNames(armLevels, referenceArm) {
  if (!armLevels.includes(referenceArm)) {
    throw new Error(`expectedCoefficientNames: referenceArm '${referenceArm}' is not in armLevels [${armLevels.join(", ")}]`);
  }
  const others = armLevels.filter((a) => a !== referenceArm);
  return ["Intercept", ...others.map((a) => `arm[T.${a}]`)];
}

function buildDesignMatrix(rows, armLevels, referenceArm) {
  const names = expectedCoefficientNames(armLevels, referenceArm);
  const X = rows.map((r) => {
    const row = new Array(names.length).fill(0);
    row[0] = 1; // Intercept
    if (r.armId !== referenceArm) {
      const idx = names.indexOf(`arm[T.${r.armId}]`);
      if (idx === -1) throw new Error(`buildDesignMatrix: row references arm '${r.armId}' not in armLevels`);
      row[idx] = 1;
    }
    return row;
  });
  return { X, coefficientNames: names };
}

// ── Diagnostics: the ONLY thing rung selection is allowed to read ──────────

/**
 * Does this fit's diagnostics require a descent? Reads ONLY convergence +
 * vcov diagonal + coefficient SEs -- never varianceComponents (a boundary
 * VC estimate is a finding, not a failure) and never a p-value.
 *
 * @param {{converged: boolean, coefficients: number[], vcov: number[][]}} fit
 * @returns {{descend: boolean, reason?: string}}
 */
export function needsDescent(fit) {
  if (fit.converged === false) return { descend: true, reason: "did not converge" };
  const k = fit.coefficients.length;
  for (let i = 0; i < k; i++) {
    const d = fit.vcov[i][i];
    if (!Number.isFinite(d) || d <= 0) {
      return { descend: true, reason: `non-finite or non-positive vcov diagonal at index ${i}` };
    }
    if (!Number.isFinite(Math.sqrt(d))) {
      return { descend: true, reason: `NaN coefficient SE at index ${i}` };
    }
  }
  return { descend: false };
}

// ── R0 / R1: sidecar calls ──────────────────────────────────────────────────

const EXPECTED_TOP_LEVEL_FIELDS = ["converged", "coefficients", "coefficientNames", "vcov", "varianceComponents", "n", "toolchain"];

function validateSidecarResponse(resp, expectedNames) {
  if (!resp || typeof resp !== "object") {
    throw new SidecarSchemaError("sidecar response is not a JSON object");
  }
  for (const field of EXPECTED_TOP_LEVEL_FIELDS) {
    if (!(field in resp)) throw new SidecarSchemaError(`sidecar response missing required field '${field}'`);
  }
  if (!Array.isArray(resp.coefficientNames) || resp.coefficientNames.length !== expectedNames.length ||
      resp.coefficientNames.some((n, i) => n !== expectedNames[i])) {
    throw new SidecarSchemaError(
      `sidecar coefficientNames [${(resp.coefficientNames || []).join(", ")}] do not match the requested ` +
        `[${expectedNames.join(", ")}] -- refusing to align a coefficient vector positionally against a name mismatch`,
    );
  }
  if (!Array.isArray(resp.coefficients) || resp.coefficients.length !== expectedNames.length) {
    throw new SidecarSchemaError("sidecar coefficients length does not match coefficientNames length");
  }
  if (!Array.isArray(resp.vcov) || resp.vcov.length !== expectedNames.length || resp.vcov.some((row) => !Array.isArray(row) || row.length !== expectedNames.length)) {
    throw new SidecarSchemaError("sidecar vcov is not a square matrix matching coefficientNames length");
  }
  return resp;
}

/**
 * Call the sidecar for one rung (R0 or R1) via the injected runner.
 *
 * @param {"R0"|"R1"} rung
 * @param {Array<{armId: string, briefId: string, response: number}>} rows
 * @param {string[]} armLevels
 * @param {string} referenceArm
 * @param {(request: object) => Promise<object>} runner
 * @returns {Promise<{rung: string, converged: boolean, coefficients: number[],
 *   coefficientNames: string[], vcov: number[][], varianceComponents: object,
 *   n: number, toolchain: object}>}
 */
export async function fitViaSidecar(rung, rows, armLevels, referenceArm, runner) {
  if (rung !== "R0" && rung !== "R1") throw new Error(`fitViaSidecar: rung must be R0 or R1, got '${rung}'`);
  if (typeof runner !== "function") throw new Error("fitViaSidecar: runner must be an injectable function(request) -> response");

  const expectedNames = expectedCoefficientNames(armLevels, referenceArm);
  const request = {
    rung,
    formula: rung === "R0" ? "y ~ arm + (1|brief) + (1|brief:arm)" : "y ~ arm + (1|brief)",
    rows: rows.map((r) => ({ arm: r.armId, brief: r.briefId, y: r.response })),
    armLevels,
    referenceArm,
  };

  let raw;
  try {
    raw = await runner(request);
  } catch (err) {
    throw new SidecarUnavailableError(`sidecar runner threw for rung ${rung}: ${err.message}`, err);
  }

  let resp;
  try {
    resp = validateSidecarResponse(raw, expectedNames);
  } catch (err) {
    if (err instanceof SidecarSchemaError) {
      throw new SidecarUnavailableError(`sidecar response for rung ${rung} failed schema validation: ${err.message}`, err);
    }
    throw err;
  }

  return { rung, ...resp };
}

// ── R2: pure-Node OLS + CR2 cluster-robust SEs (cluster = brief) ───────────

/**
 * OLS fit with CR2 (bias-reduced linearization) cluster-robust SEs,
 * clustered by brief. Entirely Node/pure-JS -- registered inferential
 * logic never leaves this file's process. Returns the SAME shape as a
 * sidecar fit (`converged`, `coefficients`, `coefficientNames`, `vcov`, ...)
 * so `needsDescent()` and contrasts.mjs's evaluateContrast() work
 * identically regardless of which rung produced the fit.
 *
 * CR2 (MacKinnon & White 1985 / Bell & McCaffrey 2002 bias-reduced
 * linearization): for cluster g with design rows X_g and hat submatrix
 * H_g = X_g (X'X)^-1 X_g', the adjustment A_g = (I - H_g)^(-1/2) is applied
 * to that cluster's residuals before forming the sandwich meat -- this is
 * what "CR2" means as opposed to the simpler (and more biased) CR1.
 *
 * @param {Array<{armId: string, briefId: string, response: number}>} rows
 * @param {string[]} armLevels
 * @param {string} referenceArm
 * @returns {{rung: "R2", converged: boolean, coefficients: number[],
 *   coefficientNames: string[], vcov: number[][], varianceComponents: object,
 *   n: number, toolchain: object, method: "OLS+CR2", failureReason?: string}}
 */
export function fitR2(rows, armLevels, referenceArm) {
  const { X, coefficientNames } = buildDesignMatrix(rows, armLevels, referenceArm);
  const k = coefficientNames.length;
  const n = rows.length;
  const y = rows.map((r) => r.response);
  const briefIds = rows.map((r) => r.briefId);
  const uniqueClusters = Array.from(new Set(briefIds));

  // df = G - 1 (clusters, i.e. briefs, minus 1) — the standard G-1 t
  // reference for cluster-robust inference at a small cluster count (#46 QA
  // SHOULD). This is NOT full Bell-McCaffrey Satterthwaite df (that needs
  // every cluster's leverage-adjusted variance contribution); contrasts.mjs
  // consumes this as `fit.df` and switches its CI/p to the Student-t
  // reference whenever it's present and finite/positive (see
  // distributions.mjs and contrasts.mjs's evaluateContrast()).
  const df = uniqueClusters.length - 1;

  const base = {
    rung: "R2",
    coefficientNames,
    n,
    df,
    varianceComponents: {},
    toolchain: { node: process.version, method: "OLS+CR2 (pure JS, evals/analysis/linalg.mjs)" },
    method: "OLS+CR2",
  };

  if (uniqueClusters.length <= k) {
    return {
      ...base,
      converged: false,
      coefficients: new Array(k).fill(NaN),
      vcov: Array.from({ length: k }, () => new Array(k).fill(NaN)),
      failureReason: `fewer clusters (${uniqueClusters.length}, brief) than parameters (${k}) -- CR2 sandwich is not identified`,
    };
  }

  let XtXinv, beta, residuals;
  try {
    const Xt = transpose(X);
    const XtX = multiply(Xt, X);
    XtXinv = invert(XtX);
    const XtY = multiply(Xt, y.map((v) => [v]));
    const betaCol = multiply(XtXinv, XtY);
    beta = betaCol.map((row) => row[0]);
    const fitted = multiply(X, betaCol).map((row) => row[0]);
    residuals = y.map((v, i) => v - fitted[i]);
  } catch (err) {
    return {
      ...base,
      converged: false,
      coefficients: new Array(k).fill(NaN),
      vcov: Array.from({ length: k }, () => new Array(k).fill(NaN)),
      failureReason: `design matrix is singular: ${err.message}`,
    };
  }

  const meat = Array.from({ length: k }, () => new Array(k).fill(0));
  try {
    for (const cluster of uniqueClusters) {
      const idx = [];
      for (let i = 0; i < n; i++) if (briefIds[i] === cluster) idx.push(i);
      const m = idx.length;
      const Xg = idx.map((i) => X[i]);
      const eg = idx.map((i) => [residuals[i]]);

      // H_g = X_g (X'X)^-1 X_g'
      const Hg = multiply(multiply(Xg, XtXinv), transpose(Xg));
      const IminusHg = Array.from({ length: m }, (_, i) => Array.from({ length: m }, (_, j) => (i === j ? 1 : 0) - Hg[i][j]));
      const Ag = symmetricInverseSqrt(IminusHg);
      const ug = multiply(Ag, eg); // (m x 1)
      const v = multiply(transpose(Xg), ug); // (k x 1) = X_g' * u_g
      for (let a = 0; a < k; a++) {
        for (let b = 0; b < k; b++) {
          meat[a][b] += v[a][0] * v[b][0];
        }
      }
    }
  } catch (err) {
    return {
      ...base,
      converged: false,
      coefficients: beta,
      vcov: Array.from({ length: k }, () => new Array(k).fill(NaN)),
      failureReason: `CR2 sandwich computation failed: ${err.message}`,
    };
  }

  const vcov = multiply(multiply(XtXinv, meat), XtXinv);

  return { ...base, converged: true, coefficients: beta, vcov };
}

// ── Judge-score lane (H5, issue #80 / docs/PREREGISTRATION.md Appendix B item
//    6): judge_provider + judge_provider x generator_provider + (1|run). A
//    SEPARATE, smaller ladder from the arm-based R0-R3 above -- one sidecar
//    rung (J0, a MixedLM random intercept on `run`) then one pure-Node
//    fallback (J1, OLS + CR2 clustered by `run`), never the R0-R3 rungs
//    above (those fit a completely different design: arm dummies against a
//    brief-clustered response, not judge_provider/sameProvider against a
//    run-clustered one). See report.mjs's own note that H1's rung and
//    H2-H5's rung are never the same statement -- this ladder is a THIRD,
//    independent one again, for H5 alone. ───────────────────────────────────
//
// Design, in Node rather than a patsy formula string (deliberate -- see
// judgeScoreFrame.mjs's header on why the registered "judge_provider x
// generator_provider" interaction reduces to ONE derived binary coefficient,
// JUDGE_SCORE_BIAS_COEFFICIENT): coefficients are
//   ["Intercept", "judge_provider[T.<other judge providers>]", ...,
//    JUDGE_SCORE_BIAS_COEFFICIENT]
// -- a judge_provider main effect (one dummy per non-reference judge_provider
// level) plus the single same-provider bias term. Sent to the sidecar as an
// already-materialized design matrix (X + coefficientNames), never a formula
// string, so there is no patsy-vs-Node naming ambiguity to keep in sync.

/**
 * @param {Array<{judgeProvider: string, sameProvider: boolean}>} rows
 * @param {string[]} judgeProviderLevels
 * @param {string} referenceJudgeProvider
 * @returns {{X: number[][], coefficientNames: string[]}}
 */
export function buildJudgeScoreDesignMatrix(rows, judgeProviderLevels, referenceJudgeProvider) {
  if (!judgeProviderLevels.includes(referenceJudgeProvider)) {
    throw new Error(`buildJudgeScoreDesignMatrix: referenceJudgeProvider '${referenceJudgeProvider}' is not in judgeProviderLevels [${judgeProviderLevels.join(", ")}]`);
  }
  const others = judgeProviderLevels.filter((p) => p !== referenceJudgeProvider);
  const coefficientNames = ["Intercept", ...others.map((p) => `judge_provider[T.${p}]`), JUDGE_SCORE_BIAS_COEFFICIENT];
  const X = rows.map((r) => {
    const row = new Array(coefficientNames.length).fill(0);
    row[0] = 1; // Intercept
    if (r.judgeProvider !== referenceJudgeProvider) {
      const idx = coefficientNames.indexOf(`judge_provider[T.${r.judgeProvider}]`);
      if (idx === -1) throw new Error(`buildJudgeScoreDesignMatrix: row references judge_provider '${r.judgeProvider}' not in judgeProviderLevels`);
      row[idx] = 1;
    }
    row[coefficientNames.length - 1] = r.sameProvider ? 1 : 0;
    return row;
  });
  return { X, coefficientNames };
}

/**
 * Call the sidecar for the judge-score lane's one rung (J0): MixedLM with a
 * random intercept on `run`, over an already-materialized design matrix
 * (never a formula string -- see this section's header). Same hard-fail
 * contract as fitViaSidecar(): a missing venv / non-zero exit / schema
 * mismatch surfaces as SidecarUnavailableError, never a silent fallback.
 *
 * @param {Array<{judgeProvider: string, sameProvider: boolean, run: string, response: number}>} rows
 * @param {string[]} judgeProviderLevels
 * @param {string} referenceJudgeProvider
 * @param {(request: object) => Promise<object>} runner
 */
export async function fitJudgeScoreViaSidecar(rows, judgeProviderLevels, referenceJudgeProvider, runner) {
  if (typeof runner !== "function") throw new Error("fitJudgeScoreViaSidecar: runner must be an injectable function(request) -> response");
  const { X, coefficientNames } = buildJudgeScoreDesignMatrix(rows, judgeProviderLevels, referenceJudgeProvider);
  const request = {
    rung: "J0",
    y: rows.map((r) => r.response),
    X,
    coefficientNames,
    groups: rows.map((r) => r.run),
  };

  let raw;
  try {
    raw = await runner(request);
  } catch (err) {
    throw new SidecarUnavailableError(`sidecar runner threw for rung J0 (judge-score lane): ${err.message}`, err);
  }

  let resp;
  try {
    resp = validateSidecarResponse(raw, coefficientNames);
  } catch (err) {
    if (err instanceof SidecarSchemaError) {
      throw new SidecarUnavailableError(`sidecar response for rung J0 (judge-score lane) failed schema validation: ${err.message}`, err);
    }
    throw err;
  }

  return { rung: "J0", ...resp };
}

/**
 * J1: pure-Node OLS + CR2 cluster-robust SEs, clustered by `run` -- the
 * judge-score lane's fallback when J0 (the sidecar MixedLM) fails its
 * descent criteria. Structurally identical to fitR2() above (same CR2
 * algebra, evals/analysis/linalg.mjs), just over the judge-score design and
 * clustered by `run` instead of `briefId` -- kept as a separate function
 * rather than a generalized shared one so the arm lane's R2 and the
 * judge-score lane's J1 can never accidentally drift onto the same clustering
 * column by a parameter-order mistake.
 *
 * @param {Array<{judgeProvider: string, sameProvider: boolean, run: string, response: number}>} rows
 * @param {string[]} judgeProviderLevels
 * @param {string} referenceJudgeProvider
 * @returns {{rung: "J1", converged: boolean, coefficients: number[],
 *   coefficientNames: string[], vcov: number[][], varianceComponents: object,
 *   n: number, toolchain: object, method: "OLS+CR2", failureReason?: string}}
 */
export function fitJudgeScoreR1(rows, judgeProviderLevels, referenceJudgeProvider) {
  const { X, coefficientNames } = buildJudgeScoreDesignMatrix(rows, judgeProviderLevels, referenceJudgeProvider);
  const k = coefficientNames.length;
  const n = rows.length;
  const y = rows.map((r) => r.response);
  const runIds = rows.map((r) => r.run);
  const uniqueClusters = Array.from(new Set(runIds));

  const df = uniqueClusters.length - 1;

  const base = {
    rung: "J1",
    coefficientNames,
    n,
    df,
    varianceComponents: {},
    toolchain: { node: process.version, method: "OLS+CR2 (pure JS, evals/analysis/linalg.mjs), clustered by run" },
    method: "OLS+CR2",
  };

  if (uniqueClusters.length <= k) {
    return {
      ...base,
      converged: false,
      coefficients: new Array(k).fill(NaN),
      vcov: Array.from({ length: k }, () => new Array(k).fill(NaN)),
      failureReason: `fewer clusters (${uniqueClusters.length}, run) than parameters (${k}) -- CR2 sandwich is not identified`,
    };
  }

  let XtXinv, beta, residuals;
  try {
    const Xt = transpose(X);
    const XtX = multiply(Xt, X);
    XtXinv = invert(XtX);
    const XtY = multiply(Xt, y.map((v) => [v]));
    const betaCol = multiply(XtXinv, XtY);
    beta = betaCol.map((row) => row[0]);
    const fitted = multiply(X, betaCol).map((row) => row[0]);
    residuals = y.map((v, i) => v - fitted[i]);
  } catch (err) {
    return {
      ...base,
      converged: false,
      coefficients: new Array(k).fill(NaN),
      vcov: Array.from({ length: k }, () => new Array(k).fill(NaN)),
      failureReason: `design matrix is singular: ${err.message}`,
    };
  }

  const meat = Array.from({ length: k }, () => new Array(k).fill(0));
  try {
    for (const cluster of uniqueClusters) {
      const idx = [];
      for (let i = 0; i < n; i++) if (runIds[i] === cluster) idx.push(i);
      const m = idx.length;
      const Xg = idx.map((i) => X[i]);
      const eg = idx.map((i) => [residuals[i]]);

      const Hg = multiply(multiply(Xg, XtXinv), transpose(Xg));
      const IminusHg = Array.from({ length: m }, (_, i) => Array.from({ length: m }, (_, j) => (i === j ? 1 : 0) - Hg[i][j]));
      const Ag = symmetricInverseSqrt(IminusHg);
      const ug = multiply(Ag, eg);
      const v = multiply(transpose(Xg), ug);
      for (let a = 0; a < k; a++) {
        for (let b = 0; b < k; b++) {
          meat[a][b] += v[a][0] * v[b][0];
        }
      }
    }
  } catch (err) {
    return {
      ...base,
      converged: false,
      coefficients: beta,
      vcov: Array.from({ length: k }, () => new Array(k).fill(NaN)),
      failureReason: `CR2 sandwich computation failed: ${err.message}`,
    };
  }

  const vcov = multiply(multiply(XtXinv, meat), XtXinv);

  return { ...base, converged: true, coefficients: beta, vcov };
}

/**
 * Run the judge-score lane's ladder: J0 (sidecar MixedLM, (1|run)) -> J1
 * (Node CR2, clustered by run) -> not computed. Sidecar-unavailable is the
 * same hard failure it is for the arm lane (SidecarUnavailableError,
 * propagated uncaught -- never silently degrades to J1).
 *
 * @param {object} opts
 *   @param {Array<{judgeProvider: string, sameProvider: boolean, run: string, response: number}>} opts.rows
 *   @param {string[]} opts.judgeProviderLevels
 *   @param {string} opts.referenceJudgeProvider
 *   @param {(request: object) => Promise<object>} opts.runner
 * @returns {Promise<{rung: "J0"|"J1"|"J2", fit: object|null, history: Array<object>}>}
 */
export async function runJudgeScoreLadder(opts) {
  const { rows, judgeProviderLevels, referenceJudgeProvider, runner } = opts;
  const history = [];

  const j0 = await fitJudgeScoreViaSidecar(rows, judgeProviderLevels, referenceJudgeProvider, runner);
  const j0Descent = needsDescent(j0);
  history.push({ rung: "J0", descended: j0Descent.descend, reason: j0Descent.reason });

  if (!j0Descent.descend) {
    return { rung: "J0", fit: j0, history };
  }

  const j1 = fitJudgeScoreR1(rows, judgeProviderLevels, referenceJudgeProvider);
  const j1Descent = needsDescent(j1);
  history.push({ rung: "J1", descended: j1Descent.descend, reason: j1Descent.reason || j1.failureReason });

  if (!j1Descent.descend) {
    return { rung: "J1", fit: j1, history };
  }

  return { rung: "J2", fit: null, history };
}

// ── The ladder orchestrator ─────────────────────────────────────────────────

/**
 * Run the full B7 ladder for one lane (one response column already reduced
 * to `rows`). Selects a rung from diagnostics ALONE, always also computes
 * R2 as a standing robustness check (per B7), and returns the selected
 * fit plus every rung's diagnostics for the report.
 *
 * Throws SidecarUnavailableError if the sidecar is unreachable/invalid at
 * ANY point R0/R1 are attempted -- that is a hard failure outside the
 * ladder, never an R3 result (see this file's header).
 *
 * @param {object} opts
 *   @param {Array<{armId: string, briefId: string, response: number}>} opts.rows
 *   @param {string[]} opts.armLevels
 *   @param {string} opts.referenceArm
 *   @param {(request: object) => Promise<object>} opts.runner  injected sidecar runner
 * @returns {Promise<{
 *   rung: "R0"|"R1"|"R2"|"R3",
 *   fit: object|null,               // null only for R3
 *   history: Array<{rung: string, descended: boolean, reason?: string}>,
 *   robustnessCheck: object,        // R2, always computed
 * }>}
 */
export async function runLadder(opts) {
  const { rows, armLevels, referenceArm, runner } = opts;
  const history = [];

  const r0 = await fitViaSidecar("R0", rows, armLevels, referenceArm, runner);
  const r0Descent = needsDescent(r0);
  history.push({ rung: "R0", descended: r0Descent.descend, reason: r0Descent.reason });

  const robustnessCheck = fitR2(rows, armLevels, referenceArm);

  if (!r0Descent.descend) {
    return { rung: "R0", fit: r0, history, robustnessCheck };
  }

  const r1 = await fitViaSidecar("R1", rows, armLevels, referenceArm, runner);
  const r1Descent = needsDescent(r1);
  history.push({ rung: "R1", descended: r1Descent.descend, reason: r1Descent.reason });

  if (!r1Descent.descend) {
    return { rung: "R1", fit: r1, history, robustnessCheck };
  }

  const r2Descent = needsDescent(robustnessCheck);
  history.push({ rung: "R2", descended: r2Descent.descend, reason: r2Descent.reason || robustnessCheck.failureReason });

  if (!r2Descent.descend) {
    return { rung: "R2", fit: robustnessCheck, history, robustnessCheck };
  }

  return { rung: "R3", fit: null, history, robustnessCheck };
}

// ── Production sidecar runner (spawns the in-repo venv) ────────────────────

/**
 * The real production runner: spawns `sidecar/.venv/bin/python3
 * sidecar/fit_mixedlm.py`, writes the request JSON to stdin, parses exactly
 * one JSON object from stdout. A missing venv, non-zero exit, or unparsable
 * stdout all surface as a thrown error, which fitViaSidecar() wraps as
 * SidecarUnavailableError -- the hard-fail path, never a silent fallback.
 *
 * @returns {(request: object) => Promise<object>}
 */
export function makeSidecarRunner() {
  return async function sidecarRunner(request) {
    const result = spawnSync(SIDECAR_VENV_PYTHON, [SIDECAR_SCRIPT_PATH], {
      input: JSON.stringify(request),
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    if (result.error) {
      throw new Error(`failed to spawn sidecar python (${SIDECAR_VENV_PYTHON}): ${result.error.message}`);
    }
    if (result.status !== 0) {
      throw new Error(`sidecar exited ${result.status}: ${(result.stderr || "").slice(0, 2000)}`);
    }
    try {
      return JSON.parse(result.stdout);
    } catch (err) {
      throw new Error(`sidecar stdout was not valid JSON: ${err.message}`);
    }
  };
}

// ── analysisHash: toolchain versions + sha256(fit_mixedlm.py), NEVER folded
//    into lib/manifest.mjs's configHash (see #46/#44 B10) ──────────────────

/**
 * `analysisHash` -- computed from LIVE inputs at analysis run time, not
 * hardcoded: sha256 of the sidecar script's actual on-disk contents,
 * concatenated with the toolchain version strings the sidecar itself
 * reported (python/numpy/scipy/pandas/statsmodels). Deliberately separate
 * from lib/manifest.mjs's configHash -- folding a statistics-library patch
 * bump into configHash would re-key every stored cell for no measurement
 * reason (see fit.mjs's header and lib/manifest.mjs's CONFIG_FIELDS, which
 * this function must never touch).
 *
 * @param {{toolchain: Record<string,string>}} fit  a completed R0/R1/R2 fit
 *   (toolchain comes from the sidecar's own response for R0/R1, or
 *   fitR2()'s `{node: process.version, ...}` for R2)
 * @param {string} [scriptPath=SIDECAR_SCRIPT_PATH]
 * @returns {string} sha256 hex, truncated to 12 chars (matches configHash's convention)
 */
export function analysisHash(fit, scriptPath = SIDECAR_SCRIPT_PATH) {
  const scriptSha = createHash("sha256").update(readFileSync(scriptPath)).digest("hex");
  const toolchain = fit && fit.toolchain ? fit.toolchain : {};
  const toolchainStr = JSON.stringify(Object.keys(toolchain).sort().reduce((o, k) => ((o[k] = toolchain[k]), o), {}));
  return createHash("sha256").update(scriptSha).update(toolchainStr).digest("hex").slice(0, 12);
}
