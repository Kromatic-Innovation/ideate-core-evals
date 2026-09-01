// contrasts.mjs — the H1..H5 contrast matrix as DATA, plus the pure Wald
// machinery (estimate, SE, CI, z, p) that turns a fit's {coefficients,
// coefficientNames, vcov} into a decision. This is registered inferential
// logic (§6.2) and stays entirely in Node — the sidecar (fit.mjs) hands
// back coefficients + the full vcov matrix and nothing else; every contrast
// computed from them is computed here, inside `node --test`.
//
// ── Coefficient naming convention ────────────────────────────────────────
// Treatment (dummy) coding with an explicit reference level, matching
// patsy/statsmodels' own `C(arm, Treatment(reference=...))` convention:
//   "Intercept"        -> the reference arm's mean
//   "arm[T.<armId>]"    -> that arm's offset from the reference arm
// fit.mjs requests this exact naming from the sidecar (see its stdin
// schema) so a contrast vector built here always lines up against real
// coefficient names, never a positional guess.
//
// ── H1..H5, as registered in #44 Appendix B (not §6.2's original wording) ──
// H1: single registered contrast = mean(panel arms) - referenceArm. Any
//     PER-ARM breakdown (armX - referenceArm for one arm at a time) is a
//     SEPARATE, exploratory contrast — BH-corrected, never folded into the
//     Holm-corrected registered family.
// H2: E >= D, restated as non-inferiority: CI-lower-bound(E - D) > -delta.
//     delta is a REGISTERED margin with NO built-in default (§B2: "delta is
//     derived from the Phase 2 pilot variance estimate and registered before
//     the confirmatory grid runs") — callers must supply it explicitly. If
//     omitted, the contrast is still estimated (point + CI) but flagged
//     `deltaUnregistered: true` instead of a pass/fail non-inferiority
//     verdict, since a non-inferiority claim with no margin is not a claim.
// H3: G > max(D, H) is NOT one linear contrast. Registered here as TWO
//     contrasts (G-D, G-H); H3 is "supported" only if BOTH lower bounds
//     (after Holm adjustment, since both are part of the registered family)
//     exceed 0. This is a registered decision, not an implementation
//     shortcut — see buildRegisteredFamily()'s H3 entry.
// H4: same non-inferiority treatment as H2, for B >= D.
// H5: same-provider judging inflates scores — a judge_provider /
//     judge_provider x generator_provider bias term from the JUDGE-SCORE
//     model (B6), which is a different frame than the distinct_k lane this
//     issue builds. Represented here as contrast DATA (the coefficient name
//     it targets) so the registered family always has 5 slots; wiring the
//     fit that actually produces that coefficient is #45/B5's job.

/**
 * Build a dense contrast vector aligned to `coefficientNames`, from a sparse
 * map of {coefficientName: weight}. Any name in `weights` not present in
 * `coefficientNames` is a hard error — a silently-ignored typo'd
 * coefficient name would produce a contrast that quietly means something
 * other than what it claims to.
 *
 * @param {string[]} coefficientNames
 * @param {Record<string, number>} weights
 * @returns {number[]}
 */
export function contrastVector(coefficientNames, weights) {
  for (const name of Object.keys(weights)) {
    if (!coefficientNames.includes(name)) {
      throw new Error(`contrastVector: unknown coefficient '${name}' — not in [${coefficientNames.join(", ")}]`);
    }
  }
  return coefficientNames.map((name) => weights[name] || 0);
}

/** The dummy-coded coefficient name for one arm's offset from the reference. */
export function armCoefficientName(armId, referenceArm) {
  return armId === referenceArm ? "Intercept" : `arm[T.${armId}]`;
}

/**
 * Evaluate one linear contrast c'β against a fit's coefficients + vcov:
 * estimate = c'β, se = sqrt(c'Vc), a two-sided Wald z-test, and a 95% CI.
 *
 * @param {{coefficients: number[], coefficientNames: string[], vcov: number[][]}} fit
 * @param {number[]} c    dense contrast vector, same length/order as
 *                        fit.coefficientNames (build with contrastVector())
 * @param {number} [confidenceLevel=0.95]
 * @returns {{estimate: number, se: number, z: number, p: number,
 *            ci: [number, number], confidenceLevel: number}}
 */
export function evaluateContrast(fit, c, confidenceLevel = 0.95) {
  const { coefficients, vcov } = fit;
  if (!Array.isArray(coefficients) || !Array.isArray(vcov)) {
    throw new Error("evaluateContrast: fit.coefficients and fit.vcov are required");
  }
  if (c.length !== coefficients.length) {
    throw new Error(`evaluateContrast: contrast vector length ${c.length} does not match ${coefficients.length} coefficients`);
  }

  let estimate = 0;
  for (let i = 0; i < c.length; i++) estimate += c[i] * coefficients[i];

  // c' V c
  let variance = 0;
  for (let i = 0; i < c.length; i++) {
    if (c[i] === 0) continue;
    for (let j = 0; j < c.length; j++) {
      if (c[j] === 0) continue;
      variance += c[i] * vcov[i][j] * c[j];
    }
  }
  if (!Number.isFinite(variance) || variance <= 0) {
    throw new Error("evaluateContrast: non-finite or non-positive contrast variance — the fit's vcov cannot support this contrast (should have triggered a ladder descent before reaching here)");
  }
  const se = Math.sqrt(variance);
  const z = estimate / se;
  const p = 2 * (1 - stdNormalCdf(Math.abs(z)));
  const zStar = zQuantile(1 - (1 - confidenceLevel) / 2);
  const ci = [estimate - zStar * se, estimate + zStar * se];

  return { estimate, se, z, p, ci, confidenceLevel };
}

/** Standard normal CDF via the Abramowitz-Stegun erf approximation
 *  (max error ~1.5e-7 — comfortably below anything a 95% CI needs). */
function stdNormalCdf(x) {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

function erf(x) {
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x);
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const t = 1 / (1 + p * x);
  const y = 1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return sign * y;
}

/** Standard normal quantile (inverse CDF) via Acklam's rational
 *  approximation — accurate to ~1e-9, more than sufficient for a 95%/99%
 *  CI z-star (1.959964.../2.575829...). */
function zQuantile(p) {
  if (p <= 0 || p >= 1) throw new Error(`zQuantile: p must be in (0,1), got ${p}`);
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
  const pLow = 0.02425, pHigh = 1 - pLow;
  let q, r;
  if (p < pLow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > pHigh) {
    q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  q = p - 0.5;
  r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
    (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

/**
 * Build the registered H1-H5 family for the distinct_k lane, as contrast
 * SPECS (name, description, and either a weights map or an explicit
 * two-contrast pair for H3) — DATA, not yet evaluated against a fit.
 *
 * @param {object} opts
 *   @param {string} opts.referenceArm      Arm A's id (the solo baseline)
 *   @param {string[]} opts.panelArms       every non-reference arm id
 *   @param {[string,string]} [opts.h2Pair=["E","D"]]
 *   @param {[string,string]} [opts.h4Pair=["B","D"]]
 *   @param {[string,string]} [opts.h3TargetVsBest=["G","D","H"]]  [challenger, ...bestOf]
 *   @param {number} [opts.delta]           non-inferiority margin (H2/H4); no default
 * @returns {Array<object>} 5 entries, H1..H5 in order
 */
export function buildRegisteredFamily(opts = {}) {
  const referenceArm = opts.referenceArm || "A";
  const panelArms = opts.panelArms;
  if (!Array.isArray(panelArms) || panelArms.length === 0) {
    throw new Error("buildRegisteredFamily: opts.panelArms is required (every non-reference arm id)");
  }
  const [h2Challenger, h2Baseline] = opts.h2Pair || ["E", "D"];
  const [h4Challenger, h4Baseline] = opts.h4Pair || ["B", "D"];
  const [h3Challenger, ...h3Baselines] = opts.h3TargetVsBest || ["G", "D", "H"];
  const delta = opts.delta;

  // mean(panel arms) - referenceArm, expressed purely in terms of each panel
  // arm's dummy-coded OFFSET from the reference (armCoefficientName(arm,
  // referenceArm) for arm !== referenceArm) — under Treatment coding the
  // reference arm's own mean IS the Intercept, so "mean(panel) - reference"
  // is exactly the average of the panel arms' offset coefficients. It must
  // NOT also subtract Intercept: offset_X already equals (mean(armX) -
  // mean(referenceArm)), so an extra "- Intercept" term would double-count
  // the reference arm's mean and silently flip/shift every H1 estimate.
  const h1Weights = {};
  for (const arm of panelArms) h1Weights[armCoefficientName(arm, referenceArm)] = 1 / panelArms.length;

  return [
    {
      id: "H1",
      description: `mean(panel arms) - ${referenceArm}`,
      kind: "superiority",
      weights: h1Weights,
    },
    {
      id: "H2",
      description: `${h2Challenger} >= ${h2Baseline} (non-inferiority, margin delta)`,
      kind: "non-inferiority",
      delta,
      weights: {
        [armCoefficientName(h2Challenger, referenceArm)]: 1,
        [armCoefficientName(h2Baseline, referenceArm)]: -1,
      },
    },
    {
      id: "H3",
      description: `${h3Challenger} > max(${h3Baselines.join(", ")}) — two contrasts, both lower bounds must exceed 0`,
      kind: "pairwise-max",
      // Two sub-contrasts, evaluated and Holm-adjusted together (each
      // consumes one slot's worth of the family's multiplicity budget —
      // see fit.mjs / report.mjs for how the 5-slot family expands H3 into
      // 2 p-values while H1/H2/H4/H5 each contribute 1).
      subcontrasts: h3Baselines.map((baseline) => ({
        id: `H3:${h3Challenger}-${baseline}`,
        weights: {
          [armCoefficientName(h3Challenger, referenceArm)]: 1,
          [armCoefficientName(baseline, referenceArm)]: -1,
        },
      })),
    },
    {
      id: "H4",
      description: `${h4Challenger} >= ${h4Baseline} (non-inferiority, margin delta)`,
      kind: "non-inferiority",
      delta,
      weights: {
        [armCoefficientName(h4Challenger, referenceArm)]: 1,
        [armCoefficientName(h4Baseline, referenceArm)]: -1,
      },
    },
    {
      id: "H5",
      description: "same-provider judging inflates scores (judge_provider bias term)",
      kind: "bias-term",
      // Targets a coefficient from the JUDGE-SCORE model (a different frame
      // — run-level (1|run), judge_provider, judge_provider x
      // generator_provider — than the distinct_k lane this issue builds).
      // Left as a named target rather than a weights map: wiring the frame
      // and fit that produce this coefficient is #45/B5's follow-up.
      targetCoefficient: "judge_provider[T.same]",
      unimplemented: true,
    },
  ];
}

/**
 * Evaluate one contrast spec (from buildRegisteredFamily, or an ad hoc
 * exploratory one) against a fit. For an H3-shaped spec (subcontrasts),
 * evaluates both and returns an array; for everything else, returns a
 * single result. Non-inferiority specs (H2/H4) get a `supported` verdict
 * only when `delta` is set; otherwise `deltaUnregistered: true`.
 *
 * @param {object} spec    one entry from buildRegisteredFamily()
 * @param {{coefficients: number[], coefficientNames: string[], vcov: number[][]}} fit
 * @returns {object|object[]}
 */
export function evaluateSpec(spec, fit) {
  if (spec.unimplemented) {
    return { id: spec.id, unimplemented: true, reason: "judge-score frame not wired in this issue (#45/B5)" };
  }
  if (spec.subcontrasts) {
    return spec.subcontrasts.map((sub) => {
      const c = contrastVector(fit.coefficientNames, sub.weights);
      const result = evaluateContrast(fit, c);
      return { id: sub.id, parentId: spec.id, ...result, supported: result.ci[0] > 0 };
    });
  }

  const c = contrastVector(fit.coefficientNames, spec.weights);
  const result = evaluateContrast(fit, c);
  if (spec.kind === "non-inferiority") {
    if (spec.delta === undefined || spec.delta === null) {
      return { id: spec.id, description: spec.description, ...result, deltaUnregistered: true };
    }
    return { id: spec.id, description: spec.description, ...result, delta: spec.delta, supported: result.ci[0] > -spec.delta };
  }
  return { id: spec.id, description: spec.description, ...result };
}
