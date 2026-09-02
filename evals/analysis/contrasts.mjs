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
// H2: E >= D. docs/PREREGISTRATION.md §6.1/§6.2 registers a DIRECTION only —
//     no numeric margin appears anywhere in the registration. The faithful
//     reading is the one-sided delta=0 test (H0: E - D <= 0), structurally
//     identical to H3's IUT sub-tests. delta=0 is therefore the REGISTERED
//     DEFAULT here. A caller may still pass an explicit delta (a margin may
//     be registered later via the pilot per §B2), but that is a DEVIATION
//     from the current registration, not the registered test itself — it is
//     recorded on the result as `deltaDeviatesFromRegistration: true` rather
//     than silently absorbed. (Previously this was framed as
//     "non-inferiority" with no default, which meant the delta=0 test never
//     actually ran; every real invocation fell through to a two-sided
//     Wald-vs-zero p that was never registered. See #46 QA re-review.)
// H3: G > max(D, H) is NOT one linear contrast, but it IS a single
//     registered hypothesis (docs/PREREGISTRATION.md:223: "5 registered
//     hypotheses ... Holm-Bonferroni on the registered set"). Modeled as an
//     intersection-union test (IUT): the null is "G <= D OR G <= H"; reject
//     only if BOTH one-sided sub-contrasts (G-D, G-H) reject. By Berger's
//     IUT result, rejecting the intersection null iff every component
//     rejects at level alpha is ITSELF a level-alpha test of that
//     intersection null — so H3 needs no within-hypothesis multiplicity
//     adjustment and legitimately consumes exactly ONE Holm slot, with
//     p = max(p_G-D, p_G-H). Do not re-split this into two slots; see
//     buildRegisteredFamily()'s H3 entry and registeredFamilySlotCount().
// H4: same delta=0-default one-sided treatment as H2, for B >= D.
//
// ── ARM SUBSETS AND THE REGISTERED FAMILY (issue #97) ────────────────────
// The registered family names arms D, E, G, H (H2: E vs D, H3: G vs D/H,
// H4: B vs D). A run over an arm SUBSET -- the #8 smoke study (arms A/B),
// the Phase 2 pilot, a single-arm debug pass, a re-analysis of a partial
// store -- cannot estimate a contrast whose arms are absent. Three things
// could be done about that, and only one of them is defensible:
//
//   1. SUBSTITUTE a present arm for the absent one. DEFINITELY WRONG: it
//      answers a different question under a registered hypothesis's name.
//      This is why no CLI flag for h2Pair/h3TargetVsBest/h4Pair exists --
//      see analysis.mjs's parseArgs().
//   2. DROP the entry from the family. Also wrong: it silently changes the
//      registered family (docs/PREREGISTRATION.md §6.2 / Appendix B item 6
//      register m = 5) with no record, and makes the family size a function
//      of which cells happened to arrive -- a data-dependent family
//      definition, exactly what §11 (optional stopping) forbids.
//   3. RECORD it as NOT ESTIMABLE and keep its slot with p = 1. What this
//      module does.
//
// (3) is not a new convention here: it is the SAME treatment H5 already
// receives when no judge-score fit exists, and H1 when no rarefied fit
// exists (analysis.mjs) -- "a registered quantity that cannot be computed
// -> named record -> report as not-computed, still occupying its slot".
// Keeping the slot is strictly CONSERVATIVE: Holm at m = 5 with p = 1
// placeholders adjusts every real p-value by a LARGER factor than a
// shrunken family would (5*p1 >= 2*p1), so FWER stays <= alpha. It costs
// power, which is the correct direction to err for a run that is by
// construction not the confirmatory analysis (§11: the confirmatory
// analysis of H1-H5 runs ONCE, at the pre-registered n).
//
// H1 has one extra wrinkle. Its registered form is mean(panel arms) - A.
// With exactly ONE panel arm present, that expression is arithmetically
// (armX - A) -- a PER-ARM comparison, which docs/PREREGISTRATION.md
// (Appendix B item 5) explicitly moves to the §6.3 EXPLORATORY section,
// BH-corrected, and says is "never folded into the confirmatory Holm
// family". Computing it would put an exploratory contrast inside the Holm
// family wearing H1's registered name, so H1 is recorded NOT ESTIMABLE
// whenever fewer than two panel arms are present.
//
// H5: same-provider judging inflates scores — a judge_provider /
//     judge_provider x generator_provider bias term from the JUDGE-SCORE
//     model (B6), which is a different frame than the distinct_k lane H1-H4
//     use (evals/analysis/judgeScoreFrame.mjs, evals/analysis/fit.mjs's
//     runJudgeScoreLadder()). buildRegisteredFamily() always returns the
//     same 5-slot family; whether H5's entry is `unimplemented` depends on
//     `opts.h5Wired` (default false, preserving the pre-#80 stub for any
//     caller that hasn't built a judge-score fit for this run) -- wiring
//     the fit changes only WHETHER this slot can reject, never how many
//     slots exist (registeredFamilySlotCount() is independent of it; see
//     contrasts.test.mjs). See evals/analysis/analysis.mjs's main() for the
//     real (non-test) caller that builds the judge-score ladder and passes
//     `h5Wired: true` when it succeeds.

import { tQuantile, tTwoSidedP, tUpperTailP } from "./distributions.mjs";
import { JUDGE_SCORE_BIAS_COEFFICIENT } from "./judgeScoreFrame.mjs";

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

/** Inverse of armCoefficientName() for the offset case -- "arm[T.E]" -> "E".
 *  Returns null for anything that is not an arm-offset coefficient name
 *  ("Intercept", the judge-score bias term, a typo). Used to keep the
 *  not-estimable path (issue #97) scoped to MISSING ARMS and to leave every
 *  other unknown coefficient name a hard error, which is what
 *  contrastVector()'s typo guard exists for. */
export function armIdFromCoefficientName(name) {
  const m = /^arm\[T\.(.+)\]$/.exec(name);
  return m ? m[1] : null;
}

/**
 * The record a registered hypothesis carries when this run's arm set cannot
 * estimate it (issue #97). Shaped to reuse the `unimplemented` plumbing that
 * already exists for H5-without-a-judge-fit and H1-without-a-rarefied-fit:
 * evaluateSpec() returns p = 1, the entry KEEPS its Holm slot, and
 * applyHolmVerdicts()/report.mjs render it without a verdict. `notEstimable`
 * plus `missingArms`/`availableArms` make it machine-readable and
 * distinguishable from "that lane's fit did not run".
 */
function notEstimableSpec({ id, description, kind, missingArms, availableArms, why }) {
  return {
    id,
    description,
    kind,
    unimplemented: true,
    notEstimable: true,
    missingArms,
    availableArms,
    reason:
      `NOT ESTIMABLE under this arm subset: the registered ${id} contrast (${description}) ` +
      // An entry can be unreachable WITHOUT naming an absent arm -- H1 over
      // a single panel arm is degenerate rather than missing anything --
      // and claiming it "names arms []" would be false.
      (missingArms.length
        ? `names arm${missingArms.length === 1 ? "" : "s"} [${missingArms.join(", ")}], which ${missingArms.length === 1 ? "is" : "are"} ` +
          `not among the arms available in this run [${availableArms.join(", ")}]. `
        : `cannot be formed from the arms available in this run [${availableArms.join(", ")}]. `) +
      `${why} No substitute arm is used and the entry is NOT dropped -- it keeps its ` +
      `Holm slot with p=1, so the registered family stays 5 slots (docs/PREREGISTRATION.md §6.2 / Appendix B item 6).`,
  };
}

/**
 * Evaluate one linear contrast c'β against a fit's coefficients + vcov:
 * estimate = c'β, se = sqrt(c'Vc), a two-sided Wald z-test, and a 95% CI.
 *
 * R0/R1 (Wald-z, the sidecar's asymptotic REML SEs) leave `fit.df` unset,
 * so this always uses the normal reference for those rungs — correct per
 * #46 QA SHOULD (only R2's CR2 needs the small-cluster t reference). R2
 * (fitR2()) sets `fit.df = clusters - 1`; whenever it's present and
 * finite/positive, this switches BOTH the CI and the two-sided p to the
 * Student-t reference (distributions.mjs) instead of the normal one.
 *
 * @param {{coefficients: number[], coefficientNames: string[], vcov: number[][], df?: number}} fit
 * @param {number[]} c    dense contrast vector, same length/order as
 *                        fit.coefficientNames (build with contrastVector())
 * @param {number} [confidenceLevel=0.95]
 * @returns {{estimate: number, se: number, z: number, p: number,
 *            ci: [number, number], confidenceLevel: number, df?: number}}
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
  const useT = Number.isFinite(fit.df) && fit.df > 0;
  const p = useT ? tTwoSidedP(z, fit.df) : 2 * (1 - stdNormalCdf(Math.abs(z)));
  const crit = useT ? tQuantile(1 - (1 - confidenceLevel) / 2, fit.df) : zQuantile(1 - (1 - confidenceLevel) / 2);
  const ci = [estimate - crit * se, estimate + crit * se];

  return useT ? { estimate, se, z, p, ci, confidenceLevel, df: fit.df } : { estimate, se, z, p, ci, confidenceLevel };
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
 *   @param {number} [opts.delta=0]         H2/H4 margin. The registration
 *     (§6.1/§6.2) supplies no numeric margin, so 0 is the REGISTERED
 *     default — passing an explicit value is a deviation from that
 *     registration, recorded on the H2/H4 results as
 *     `deltaDeviatesFromRegistration: true`.
 *   @param {string[]} [opts.availableArms]  issue #97. The arm ids this run
 *     can actually estimate, defaulting to `[referenceArm, ...panelArms]` --
 *     which is the right default because `panelArms` is DEFINED as every
 *     non-reference arm id present. Any registered entry naming an arm
 *     outside this set is returned as a NOT-ESTIMABLE record (see
 *     notEstimableSpec()) instead of a weights map that would blow up as
 *     `contrastVector: unknown coefficient 'arm[T.E]'` four modules later.
 *   @param {boolean} [opts.h5Wired=false]  issue #80. When true, H5's entry
 *     is a real weights-based spec (targeting JUDGE_SCORE_BIAS_COEFFICIENT)
 *     instead of the `{unimplemented: true}` stub — the caller is asserting
 *     it has a real judge-score fit ready to evaluateSpec() H5 against. Does
 *     NOT change registeredFamilySlotCount()'s output either way (always 5).
 * @returns {Array<object>} 5 entries, H1..H5 in order
 */
export function buildRegisteredFamily(opts = {}) {
  const referenceArm = opts.referenceArm || "A";
  const panelArms = opts.panelArms;
  if (!Array.isArray(panelArms) || panelArms.length === 0) {
    throw new Error("buildRegisteredFamily: opts.panelArms is required (every non-reference arm id)");
  }
  if (new Set(panelArms).size !== panelArms.length) {
    throw new Error(`buildRegisteredFamily: opts.panelArms contains duplicates [${panelArms.join(", ")}] -- a duplicate silently rescales H1's weights (1/panelArms.length no longer matches the deduped coefficient set)`);
  }
  const [h2Challenger, h2Baseline] = opts.h2Pair || ["E", "D"];
  const [h4Challenger, h4Baseline] = opts.h4Pair || ["B", "D"];
  const [h3Challenger, ...h3Baselines] = opts.h3TargetVsBest || ["G", "D", "H"];
  const deltaDeviatesFromRegistration = opts.delta !== undefined && opts.delta !== null;
  const delta = deltaDeviatesFromRegistration ? opts.delta : 0;

  // Guard against the H1-intercept bug's unguarded siblings (issue #46 QA
  // MUST #3): armCoefficientName(referenceArm, referenceArm) resolves to
  // "Intercept", which IS a valid coefficient name -- contrastVector()'s
  // "unknown coefficient" check can never catch a reference arm smuggled
  // into a contrast member, because "Intercept" always exists. Refuse it
  // here, at spec-build time, for every slot that names an arm directly
  // (panelArms for H1; the H2/H3/H4 challenger/baseline members) rather
  // than letting it silently put +/-1 weight on Intercept.
  const contrastMembers = [...panelArms, h2Challenger, h2Baseline, h4Challenger, h4Baseline, h3Challenger, ...h3Baselines];
  for (const arm of contrastMembers) {
    if (arm === referenceArm) {
      throw new Error(
        `buildRegisteredFamily: reference arm '${referenceArm}' cannot also appear as a contrast member -- ` +
          `armCoefficientName() would resolve it to "Intercept", silently putting contrast weight on the ` +
          `reference arm's own mean instead of an offset (the H1-intercept bug, verbatim)`,
      );
    }
  }

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

  // ── Arm-subset scoping (issue #97) ────────────────────────────────────
  // `panelArms` IS "every non-reference arm id" present in this run, so
  // [referenceArm, ...panelArms] is the estimable arm set unless a caller
  // says otherwise. Any registered entry naming an arm outside it is
  // recorded not-estimable rather than emitting weights that cannot be
  // aligned to the fit's coefficient names. See this module's header for
  // why record-and-keep-the-slot, not drop and not substitute.
  const availableArms = opts.availableArms || [referenceArm, ...panelArms];
  const availableSet = new Set(availableArms);
  const absentAmong = (arms) => Array.from(new Set(arms.filter((a) => !availableSet.has(a))));

  const h1Description = `mean(panel arms) - ${referenceArm}`;
  const h2Description = `${h2Challenger} >= ${h2Baseline} (one-sided, delta=${delta}${deltaDeviatesFromRegistration ? ", DEVIATES from registration" : " -- registered default"})`;
  const h3Description = `${h3Challenger} > max(${h3Baselines.join(", ")}) -- intersection-union test (IUT): one Holm slot, p = max over the one-sided sub-contrast p-values (Berger's IUT result -- see module doc comment)`;
  const h4Description = `${h4Challenger} >= ${h4Baseline} (one-sided, delta=${delta}${deltaDeviatesFromRegistration ? ", DEVIATES from registration" : " -- registered default"})`;

  const h2Missing = absentAmong([h2Challenger, h2Baseline]);
  const h3Missing = absentAmong([h3Challenger, ...h3Baselines]);
  const h4Missing = absentAmong([h4Challenger, h4Baseline]);

  return [
    // H1 is not estimable with fewer than TWO panel arms: mean(panel arms)
    // over a single arm is arithmetically (armX - referenceArm), a PER-ARM
    // comparison that Appendix B item 5 assigns to the §6.3 exploratory,
    // BH-corrected section and says is never folded into the Holm family.
    // Computing it would put an exploratory contrast inside the registered
    // family under H1's name -- see this module's header.
    panelArms.length < 2
      ? notEstimableSpec({
          id: "H1",
          description: h1Description,
          kind: "superiority",
          missingArms: [],
          availableArms,
          why:
            `H1 is registered as mean(panel arms) - ${referenceArm}; with only ${panelArms.length} panel arm ` +
            `[${panelArms.join(", ")}] that mean collapses to a single PER-ARM comparison, which ` +
            "docs/PREREGISTRATION.md Appendix B item 5 assigns to the §6.3 exploratory (BH-corrected) section and " +
            "explicitly excludes from the confirmatory Holm family.",
        })
      : {
          id: "H1",
          description: h1Description,
          kind: "superiority",
          weights: h1Weights,
        },
    h2Missing.length
      ? notEstimableSpec({
          id: "H2",
          description: h2Description,
          kind: "one-sided-margin",
          missingArms: h2Missing,
          availableArms,
          why: "H2 is registered as a comparison between those two specific arms.",
        })
      : {
          id: "H2",
          description: h2Description,
          kind: "one-sided-margin",
          delta,
          deltaDeviatesFromRegistration,
          weights: {
            [armCoefficientName(h2Challenger, referenceArm)]: 1,
            [armCoefficientName(h2Baseline, referenceArm)]: -1,
          },
        },
    h3Missing.length
      ? notEstimableSpec({
          id: "H3",
          description: h3Description,
          kind: "iut-max-p",
          missingArms: h3Missing,
          availableArms,
          why:
            "H3 is an intersection-union test over ALL of its sub-contrasts -- dropping the sub-contrast whose " +
            "baseline is missing would silently weaken the null from 'G beats both' to 'G beats the one that happened to be run'.",
        })
      : {
      id: "H3",
      description: h3Description,
      kind: "iut-max-p",
      // Both sub-contrasts are evaluated, but by Berger's IUT result
      // "reject iff every component rejects" is itself a level-alpha test
      // of the intersection null, so this occupies exactly ONE Holm slot
      // (p = max(component p)), not two -- see registeredFamilySlotCount()
      // and evaluateSpec()'s `kind === "iut-max-p"` branch.
      components: h3Baselines.map((baseline) => ({
        id: `H3:${h3Challenger}-${baseline}`,
        weights: {
          [armCoefficientName(h3Challenger, referenceArm)]: 1,
          [armCoefficientName(baseline, referenceArm)]: -1,
        },
      })),
    },
    h4Missing.length
      ? notEstimableSpec({
          id: "H4",
          description: h4Description,
          kind: "one-sided-margin",
          missingArms: h4Missing,
          availableArms,
          why: "H4 is registered as a comparison between those two specific arms.",
        })
      : {
          id: "H4",
          description: h4Description,
          kind: "one-sided-margin",
          delta,
          deltaDeviatesFromRegistration,
          weights: {
            [armCoefficientName(h4Challenger, referenceArm)]: 1,
            [armCoefficientName(h4Baseline, referenceArm)]: -1,
          },
        },
    {
      id: "H5",
      description: "same-provider judging inflates scores (judge_provider x generator_provider bias term, judge-score model, #80)",
      kind: "bias-term",
      // Always occupies a Holm family slot (see registeredFamilySlotCount()
      // / evaluateSpec()) regardless of whether it is wired for THIS run --
      // wiring this hypothesis's fit must not change the OTHER four
      // hypotheses' Holm multiplier, because the slot was never absent to
      // begin with. Targets the SINGLE derived bias coefficient
      // judgeScoreFrame.mjs's buildJudgeScoreFrame()/fit.mjs's
      // buildJudgeScoreDesignMatrix() produce for the judge_provider x
      // generator_provider interaction (see judgeScoreFrame.mjs's header for
      // why that interaction reduces to one coefficient for this study).
      // `unimplemented: true` only when the caller has NO judge-score fit
      // for this run (opts.h5Wired falsy, the default) -- see this module's
      // header comment above buildRegisteredFamily() imports.
      weights: { [JUDGE_SCORE_BIAS_COEFFICIENT]: 1 },
      ...(opts.h5Wired ? {} : { unimplemented: true }),
    },
  ];
}

/**
 * How many Holm family slots `buildRegisteredFamily()`'s output occupies --
 * ONE p-value per hypothesis, H3 included: H3's two sub-contrasts (G-D, G-H)
 * are combined into a single IUT p-value (p = max) at evaluation time (see
 * evaluateSpec()'s `kind === "iut-max-p"` branch and the module doc comment
 * on Berger's IUT result), so H3 never expands past its one registered slot.
 * Computed from the family DATA rather than hardcoded, so wiring H5
 * (removing `unimplemented`) can never silently change the family size out
 * from under multiplicity.mjs's own assertion.
 *
 * @param {Array<object>} family  buildRegisteredFamily() output
 * @returns {number}
 */
export function registeredFamilySlotCount(family) {
  return family.length;
}

/**
 * Summarize which registered slots this run could actually estimate (issue
 * #97), for callers and reports that need the fact WITHOUT scanning five
 * entries. Deliberately does NOT feed multiplicity: `slots` is and stays
 * `registeredFamilySlotCount()`, i.e. 5. `estimated` is reported so a reader
 * can see the family was only partly estimable -- it is never used to shrink
 * the Holm multiplier, because a family size that depends on which cells
 * happened to arrive is a data-dependent family definition
 * (docs/PREREGISTRATION.md §11) and shrinking it is the anti-conservative
 * direction. See this module's header.
 *
 * @param {Array<object>} results  evaluated family (or the specs themselves)
 * @returns {{slots: number, estimated: number, notEstimable: Array<{id: string, missingArms: string[], reason: string}>}}
 */
export function familyEstimability(results) {
  const notEstimable = results
    .filter((r) => r && r.notEstimable)
    .map((r) => ({ id: r.id, missingArms: r.missingArms || [], reason: r.reason }));
  return {
    slots: results.length,
    // Entries that produced a real estimate -- i.e. NOT unimplemented for
    // ANY reason, which is broader than "estimable given this run's arms".
    // On the full grid with no pools and no judging yet, H1 and H5 are
    // unimplemented for reasons that have nothing to do with arms, so this
    // reads 3 while `notEstimable` is correctly empty. The report's
    // arm-subset banner keys off `notEstimable`, never off this.
    estimated: results.length - results.filter((r) => r && r.unimplemented).length,
    notEstimable,
  };
}

/** One-sided upper-tail p-value: P(Z > z) — Student-t (fit.df) if a finite
 *  positive df is present (R2's CR2, per #46 QA SHOULD), else standard
 *  normal (R0/R1's Wald-z). */
function oneSidedUpperP(z, fit) {
  if (fit && Number.isFinite(fit.df) && fit.df > 0) return tUpperTailP(z, fit.df);
  return 1 - stdNormalCdf(z);
}

/**
 * Evaluate one contrast spec (from buildRegisteredFamily, or an ad hoc
 * exploratory one) against a fit. For an H3-shaped spec (`kind ===
 * "iut-max-p"`), evaluates both components internally but returns a SINGLE
 * result (one Holm slot) -- see the `components` field for the two
 * underlying sub-contrasts.
 *
 * The `p` this returns is ALWAYS the p-value for the hypothesis actually
 * being registered, not a one-size-fits-all two-sided test against zero --
 * that is what lets a single Holm-Bonferroni correction over the flattened
 * family (see multiplicity.mjs / applyHolmVerdicts()) drive every verdict:
 *   - superiority (H1): two-sided p against 0 (kind: "superiority").
 *   - one-sided margin (H2/H4, kind: "one-sided-margin"): a ONE-SIDED
 *     margin-test p against -delta (H0: estimate <= -delta), matching
 *     "CI lower bound > -delta" at alpha=0.025 -- the one-sided equivalent
 *     of a 95% two-sided CI's exclusion test. delta defaults to 0 (the
 *     registered default -- see buildRegisteredFamily()); a caller-supplied
 *     nonzero delta is carried through as `deltaDeviatesFromRegistration:
 *     true` so it is never silently absorbed into what looks like the
 *     registered test. `oneSided: true` so applyHolmVerdicts() knows the
 *     threshold is 0.025, not 0.05.
 *   - H3 (kind: "iut-max-p", `oneSided: true`): both one-sided sub-contrast
 *     p-values (H0: estimate <= 0 for each) are computed, and the result's
 *     `p` is their MAX -- the intersection-union test (Berger): rejecting
 *     iff both components reject at level alpha is itself a level-alpha
 *     test of the intersection null "G <= D OR G <= H", so this needs no
 *     separate multiplicity correction and stays ONE Holm slot. The result's
 *     `estimate`/`se`/`ci` are the BINDING component's (the one with the
 *     larger p -- the weaker sub-claim, whose rejection status determines
 *     H3's own verdict); both components are still available in `components`
 *     for transparency.
 *   - H5 (unimplemented): still occupies its Holm slot with p = 1 (an
 *     untested hypothesis cannot be rejected), so wiring it later changes
 *     only ITS OWN result, never the other four's adjusted p-values.
 * `supported`/`significant` verdicts are NOT set here -- see
 * applyHolmVerdicts(), which needs the whole family's Holm-adjusted
 * p-values before any verdict can be assigned.
 *
 * @param {object} spec    one entry from buildRegisteredFamily()
 * @param {{coefficients: number[], coefficientNames: string[], vcov: number[][]}} fit
 * @returns {object}
 */
export function evaluateSpec(spec, fit) {
  if (spec.unimplemented) {
    return {
      id: spec.id,
      ...(spec.description ? { description: spec.description } : {}),
      unimplemented: true,
      // issue #97: carry the not-estimable record through verbatim so the
      // report and any programmatic caller can tell "this run's arms cannot
      // estimate the registered contrast" apart from "that lane's fit did
      // not run". Absent for the H5 stub, which is the latter.
      ...(spec.notEstimable
        ? { notEstimable: true, missingArms: spec.missingArms || [], availableArms: spec.availableArms || [] }
        : {}),
      reason: spec.reason || "judge-score model not available for this run (see #80) — no judge-score fit was supplied",
      p: 1,
    };
  }

  // Belt behind buildRegisteredFamily()'s arm-subset scoping (issue #97).
  // A spec's arms are checked against `[referenceArm, ...panelArms]` at
  // build time, but H1 is evaluated against the RAREFIED fit and H2-H4
  // against the FULL-POOL fit (analysis.mjs), and those two fits' arm sets
  // can differ. Rather than reconcile them upstream, catch a missing ARM
  // coefficient here, at the only place that sees both the spec and the fit
  // it is being evaluated against, and return the same not-estimable record.
  //
  // Scoped to ARM-shaped coefficient names on purpose: an unknown name that
  // is NOT an arm offset (a typo, or H5's bias term against a fit that has
  // no such column) still falls through to contrastVector()'s hard error,
  // which is exactly the typo guard that error exists to be.
  const specWeights = spec.kind === "iut-max-p" ? Object.assign({}, ...spec.components.map((c) => c.weights)) : spec.weights;
  const missingArms = Object.keys(specWeights)
    .filter((name) => !fit.coefficientNames.includes(name))
    .map(armIdFromCoefficientName)
    .filter((armId) => armId !== null);
  if (missingArms.length) {
    const availableArms = fit.coefficientNames.map(armIdFromCoefficientName).filter((a) => a !== null);
    return {
      id: spec.id,
      description: spec.description,
      unimplemented: true,
      notEstimable: true,
      missingArms,
      availableArms,
      reason:
        `NOT ESTIMABLE against this fit: the registered ${spec.id} contrast (${spec.description}) names ` +
        `arm${missingArms.length === 1 ? "" : "s"} [${missingArms.join(", ")}], which the fitted model does not carry ` +
        `(fitted non-reference arms: [${availableArms.join(", ")}]; coefficients: [${fit.coefficientNames.join(", ")}]). ` +
        "No substitute arm is used and the entry is NOT dropped -- it keeps its Holm slot with p=1.",
      p: 1,
    };
  }

  if (spec.kind === "iut-max-p") {
    const components = spec.components.map((comp) => {
      const c = contrastVector(fit.coefficientNames, comp.weights);
      const result = evaluateContrast(fit, c);
      const p = oneSidedUpperP(result.estimate / result.se, fit);
      return { id: comp.id, oneSided: true, ...result, p };
    });
    // Binding component = the one with the LARGER p (the weaker sub-claim);
    // H3 as a whole is rejected only once every component is, so this is
    // the component whose own rejection is the last to clear.
    const binding = components.reduce((worst, r) => (r.p > worst.p ? r : worst));
    return {
      id: spec.id,
      description: spec.description,
      kind: spec.kind,
      oneSided: true,
      components,
      estimate: binding.estimate,
      se: binding.se,
      ci: binding.ci,
      p: binding.p,
    };
  }

  const c = contrastVector(fit.coefficientNames, spec.weights);
  const result = evaluateContrast(fit, c);
  if (spec.kind === "one-sided-margin") {
    const marginP = oneSidedUpperP((result.estimate + spec.delta) / result.se, fit);
    return {
      id: spec.id,
      description: spec.description,
      kind: spec.kind,
      oneSided: true,
      ...result,
      p: marginP,
      delta: spec.delta,
      deltaDeviatesFromRegistration: spec.deltaDeviatesFromRegistration || false,
    };
  }
  return { id: spec.id, description: spec.description, kind: spec.kind, ...result };
}

/**
 * Assign `supported`/`significant` verdicts to a flattened, evaluated
 * family AFTER Holm-Bonferroni correction -- the step evaluateSpec()
 * deliberately leaves undone, so a verdict can never be computed from a raw
 * (un-corrected) p-value or CI. Mutates nothing; returns new objects.
 *
 * Threshold: alpha=0.05 two-sided (`oneSided` falsy, e.g. H1) or alpha=0.025
 * one-sided (`oneSided: true` -- H2/H4, H3), matching the exact alpha each
 * entry's `p` in evaluateSpec() was already computed at (a two-sided 95% CI's
 * exclusion test IS a two-sided alpha=0.05 test; a one-sided "CI lower bound
 * exceeds a threshold" test is alpha=0.025 one-sided). Note this is mixed
 * alphas on a single Holm sequence, not textbook (unweighted) Holm -- the
 * step-down algebra is still valid (the rejection set is a strict subset of
 * Holm-at-0.05, so FWER <= 0.05), but a reader should not assume this reduces
 * to the textbook single-alpha procedure. This is the ONLY thing this
 * function changes relative to the old CI-based check: the comparison
 * happens at the Holm-adjusted p, not the raw one.
 *
 * @param {Array<object>} flatResults    registeredResults.flat() -- same
 *                                        order fed to holmBonferroni()
 * @param {number[]} holmAdjusted        holmBonferroni() output, same order
 * @returns {Array<object>}
 */
export function applyHolmVerdicts(flatResults, holmAdjusted) {
  if (flatResults.length !== holmAdjusted.length) {
    throw new Error(`applyHolmVerdicts: flatResults length ${flatResults.length} does not match holmAdjusted length ${holmAdjusted.length}`);
  }
  return flatResults.map((r, i) => {
    if (r.unimplemented) return r;
    const holmP = holmAdjusted[i];
    const alpha = r.oneSided ? 0.025 : 0.05;
    const rejected = holmP < alpha;
    return r.oneSided ? { ...r, holmP, supported: rejected } : { ...r, holmP, significant: rejected };
  });
}
