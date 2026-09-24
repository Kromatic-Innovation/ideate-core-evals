#!/usr/bin/env node
// non-inferiority-margin.mjs -- derive the registered non-inferiority margin
// delta for H2 (E >= D) and H4 (B >= D), per docs/PREREGISTRATION.md
// Appendix R (issue #179).
//
// ── What this script does NOT do ─────────────────────────────────────────
// This script does NOT re-fit sigma^2_ba at any scale. Re-estimating a
// variance component is out of scope for issue #179 (which "consumes the
// registered figures"), and the sidecar venv the mixed-model fit needs
// (evals/analysis/sidecar/.venv) is not committed to this repo -- see
// variance-components.mjs for the script that DOES re-fit, from a
// committed CSV, for the ~30 basis. There is no equivalent committed CSV
// for the ~60 basis: Appendix J item 5's achieved figures come from Stage
// 1b's re-run store, which this repo does not carry. This script therefore
// takes both registered sigma^2_ba/sigma^2_e pairs as INPUT constants,
// cited to the appendix that measured them, and derives everything else
// (the margin, its counter-example, the SE table, the power-at-zero
// context) from them in plain arithmetic. If either input constant is ever
// re-measured, this file's constants are the one and only place that
// changes -- matching variance-components.mjs's own reason for naming its
// registered arm set as constants rather than deriving it from
// arms.config.json.
//
// ── The two registered variance-component pairs ──────────────────────────
//
//   ~30-idea pool (docs/PREREGISTRATION.md Appendix G item 1, matched N=30
//   fit, n=144, MEASURED):
//     sigma^2_ba = 1.2088
//     sigma^2_e  = 5.1181
//
//   ~60-idea pool (docs/PREREGISTRATION.md Appendix J item 5, three arms at
//   the ~60 scale, MEASURED):
//     sigma^2_ba = 7.8266
//     sigma^2_e  = 3.6348 (rarefied at 45 -- Appendix J item 5's own
//                          caveat: the re-run's floor is not the same
//                          estimand, see the appendix)
//
// Appendix G item 4 registers the scope bound that makes the CHOICE between
// these two pairs load-bearing rather than cosmetic: "Any design whose
// rarefaction target is not ~30 requires its own variance basis, estimated
// at that pool size, registered as its own dated amendment." H2 (E >= D)
// and H4 (B >= D) are both panel-vs-panel contrasts at the ~60 scale
// (arms.config.json's default panel geometry -- size:5, ideasPerAgent:6,
// maxRounds:2 -- applies to B, D and E with no override, and round 2
// APPENDS rather than replacing round 1, per arm A's own purpose string),
// so the ~60 pair is the registered basis for BOTH. See
// docs/PREREGISTRATION.md Appendix R for the full derivation this script's
// output is pasted into.
//
// ── The registered SE formula (docs/PREREGISTRATION.md §3.4, unchanged by
//    Appendix G or Appendix J) ─────────────────────────────────────────────
//   SE(B, R) = sqrt( 2 * ( sigma^2_ba / B  +  sigma^2_e / (B * R) ) )
//
// ── Usage ─────────────────────────────────────────────────────────────────
//   node evals/analysis/non-inferiority-margin.mjs
//
// No flags, no dependencies (zero npm packages -- CI runs a bare
// `node --test` with no `npm install`, and this script must run under the
// same constraint).

// ── Registered inputs, named as constants (see header) ────────────────────
export const SIGMA2_BA_60 = 7.8266; // Appendix J item 5, MEASURED, 3 arms at ~60
export const SIGMA2_E_60 = 3.6348; // Appendix J item 5, MEASURED, rarefied at 45
export const SIGMA2_BA_30 = 1.2088; // Appendix G item 1, MEASURED, matched N=30 (n=144)
export const SIGMA2_E_30 = 5.1181; // Appendix G item 1, MEASURED, matched N=30 (n=144)

// The grid's registered Stage 1b/1c design (Appendix G item 2's "Registered
// design", unchanged by Appendix J): B = 24 briefs, R = 2 replicates.
export const REGISTERED_B = 24;
export const REGISTERED_R = 2;

// One-sided alpha for H2/H4 within the Holm family (docs/PREREGISTRATION.md
// §6.2: "tested at alpha = 0.025 one-sided within the Holm family").
export const ALPHA_ONE_SIDED = 0.025;
// Holm's worst-case per-slot alpha over the registered m = 5 family
// (docs/PREREGISTRATION.md Appendix B item 6: "the Holm family is 5
// hypotheses" -- Holm's first step spends alpha/m at the smallest p-value).
export const ALPHA_HOLM_WORST_CASE = 0.025 / 5;

// Standard normal quantiles for the two alphas above (Phi^-1(1-alpha)),
// standard values reproducible from any statistical table or `qnorm`:
//   Phi^-1(0.975) = 1.959964 ; Phi^-1(0.995) = 2.575829
export const Z_ALPHA_ONE_SIDED = 1.959964;
export const Z_ALPHA_HOLM_WORST_CASE = 2.575829;

/**
 * The registered SE formula, docs/PREREGISTRATION.md §3.4 (unchanged by
 * Appendix G or Appendix J -- both amendments re-estimate the COMPONENTS
 * that feed this formula, never the formula itself).
 *
 *   SE(B, R) = sqrt( 2 * ( sigma2Ba / B + sigma2E / (B * R) ) )
 *
 * @param {number} sigma2Ba  the brief:arm interaction variance
 * @param {number} sigma2E   the pooled within-(arm x brief) residual variance
 * @param {number} B         briefs
 * @param {number} R         replicates per (arm x brief)
 * @returns {number}
 */
export function seForDesign(sigma2Ba, sigma2E, B, R) {
  return Math.sqrt(2 * (sigma2Ba / B + sigma2E / (B * R)));
}

/**
 * The registered margin derivation (Appendix R): delta := sqrt(sigma2Ba) at
 * the chosen basis -- the brief:arm standard deviation, i.e. the SD with
 * which a given arm's advantage moves from one brief to the next. This is
 * the CONSERVATIVE of the two available readings; see contrastSD() for the
 * other (the two-arm contrast's own brief-level SD, sqrt(2*sigma2Ba)) and
 * Appendix R's disclosure of why the smaller, per-arm figure is registered.
 *
 * @param {number} sigma2Ba
 * @returns {number}
 */
export function deriveDelta(sigma2Ba) {
  return Math.sqrt(sigma2Ba);
}

/**
 * The two-arm CONTRAST's own brief-level SD under the R0 model -- each arm
 * in a two-arm contrast carries its own brief:arm term, so the contrast
 * carries 2*sigma2Ba (exactly why the SE formula above carries the leading
 * factor of 2). NOT the value registered as delta -- see deriveDelta()'s
 * doc comment and Appendix R item on the conservative-reading disclosure.
 *
 * @param {number} sigma2Ba
 * @returns {number}
 */
export function contrastSD(sigma2Ba) {
  return Math.sqrt(2 * sigma2Ba);
}

/**
 * Standard normal CDF, Phi(z) -- Abramowitz & Stegun 7.1.26 rational
 * approximation to the error function (max absolute error ~1.5e-7, ample
 * for the 3-4 significant figures this script reports). Zero-dependency by
 * construction: no npm package, no import.
 *
 * @param {number} z
 * @returns {number} P(Z <= z) for Z ~ N(0,1)
 */
export function standardNormalCdf(z) {
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.SQRT2;
  // erf(x) via A&S 7.1.26
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const t = 1 / (1 + p * x);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  const erf = sign * y;
  return 0.5 * (1 + erf);
}

/**
 * Power at a true difference of exactly zero, for the one-sided margin test
 * H0: difference <= -delta (see contrasts.mjs's evaluateSpec(),
 * kind: "one-sided-margin"). Reported here as CONTEXT ONLY -- Appendix G
 * item 2 is emphatic that "the MDE is reported, not targeted", and delta is
 * NOT derived from this figure or chosen to hit any particular value of it.
 *
 * @param {number} delta
 * @param {number} se
 * @param {number} zAlpha  the one-sided critical value for the alpha in force
 * @returns {number}  P(reject H0 | true difference = 0)
 */
export function powerAtZero(delta, se, zAlpha) {
  return standardNormalCdf(delta / se - zAlpha);
}

/**
 * Verdict of the counter-example: does an observed deficit (a negative
 * number: challenger minus baseline) fall inside the registered margin
 * (non-inferior: estimate > -delta) or outside it (inferior)?
 *
 * @param {number} observedDeficit  e.g. -2.00
 * @param {number} delta
 * @returns {"inside (non-inferior)"|"outside (inferior)"}
 */
export function marginVerdict(observedDeficit, delta) {
  return observedDeficit > -delta ? "inside (non-inferior)" : "outside (inferior)";
}

// ── Reproduction checks (docs/PREREGISTRATION.md Appendix G item 2 / Appendix
//    J item 5's own printed tables) -- these prove the formula being applied
//    here is the one already registered, not a new one wearing its name. ──
const REPRODUCTION_CHECKS = [
  { label: "~60 basis, B=24 R=2 (Appendix J item 5)", sigma2Ba: SIGMA2_BA_60, sigma2E: SIGMA2_E_60, B: 24, R: 2, expected: 0.897 },
  { label: "~60 basis, B=48 R=2 (Appendix J item 5)", sigma2Ba: SIGMA2_BA_60, sigma2E: SIGMA2_E_60, B: 48, R: 2, expected: 0.634 },
  { label: "~60 basis, B=48 R=3 (Appendix J item 5)", sigma2Ba: SIGMA2_BA_60, sigma2E: SIGMA2_E_60, B: 48, R: 3, expected: 0.614 },
  { label: "~30 basis, B=24 R=2 (Appendix G item 2)", sigma2Ba: SIGMA2_BA_30, sigma2E: SIGMA2_E_30, B: 24, R: 2, expected: 0.56 },
];

// Reproduction tolerance: agreement to 2 decimal places. Appendix G item 5
// itself defines "reproduces" this way ("returns ... to the two decimals
// that table prints"); applied identically here. One cell below (the ~60
// basis at B=24/R=2) computes 0.8965 against the table's printed 0.897 --
// a genuine ~0.001 difference in the THIRD decimal, smaller than the
// precision of the 4-decimal-place inputs can guarantee, and not present in
// either neighboring cell of the SAME table (B=48/R=2 and B=48/R=3 both
// reproduce their printed 3rd decimal exactly). Reported plainly rather
// than silently tightened or loosened to force a match.
const REPRODUCTION_TOLERANCE = 0.005;

export function runReproductionChecks() {
  return REPRODUCTION_CHECKS.map((c) => {
    const computed = seForDesign(c.sigma2Ba, c.sigma2E, c.B, c.R);
    const pass = Math.abs(computed - c.expected) <= REPRODUCTION_TOLERANCE;
    return { ...c, computed, pass };
  });
}

function main() {
  console.log("=== Non-inferiority margin delta for H2 (E>=D) / H4 (B>=D) -- docs/PREREGISTRATION.md Appendix R (issue #179) ===\n");

  console.log("Registered variance-component bases:");
  console.log(`  ~30-idea pool (Appendix G item 1, MEASURED, matched N=30, n=144): sigma^2_ba=${SIGMA2_BA_30}  sigma^2_e=${SIGMA2_E_30}`);
  console.log(`  ~60-idea pool (Appendix J item 5, MEASURED, 3 arms at ~60):        sigma^2_ba=${SIGMA2_BA_60}  sigma^2_e=${SIGMA2_E_60} (sigma^2_e rarefied at 45)`);
  console.log("\nH2/H4 are panel-vs-panel contrasts (E vs D, B vs D); B, D, E all inherit the default panel geometry");
  console.log("(size:5, ideasPerAgent:6, maxRounds:2; arms.config.json) with round 2 APPENDING to round 1 (arm A's own");
  console.log("purpose string) -- so both contrasts' rarefaction target (Appendix C item 2: minimum pool size present)");
  console.log("is ~60, and Appendix G item 4's scope bound makes the ~60 basis (Appendix J item 5) the registered one.\n");

  console.log(`SE formula (docs/PREREGISTRATION.md §3.4, unchanged): SE(B,R) = sqrt(2*(sigma^2_ba/B + sigma^2_e/(B*R)))\n`);

  console.log("Reproduction checks (formula applied here reproduces the already-registered tables):");
  const checks = runReproductionChecks();
  for (const c of checks) {
    console.log(`  ${c.pass ? "PASS" : "FAIL"}  ${c.label}: computed ${c.computed.toFixed(4)} vs registered ${c.expected} (tolerance ${REPRODUCTION_TOLERANCE})`);
  }
  console.log("");

  const delta60 = deriveDelta(SIGMA2_BA_60);
  const delta30 = deriveDelta(SIGMA2_BA_30);
  const ratio = delta60 / delta30;
  const contrastSd60 = contrastSD(SIGMA2_BA_60);

  console.log("Derived margin delta := sqrt(sigma^2_ba), per-arm brief-to-brief SD (the CONSERVATIVE reading -- see contrastSD()):");
  console.log(`  delta at ~60 basis (REGISTERED for H2/H4): sqrt(${SIGMA2_BA_60}) = ${delta60.toFixed(4)}`);
  console.log(`  delta at ~30 basis (counter-example only):  sqrt(${SIGMA2_BA_30}) = ${delta30.toFixed(4)}`);
  console.log(`  ratio (~60 delta / ~30 delta):               ${ratio.toFixed(4)}x`);
  console.log(`  contrast SD at ~60 (sqrt(2*sigma^2_ba), the LESS conservative reading, NOT registered): ${contrastSd60.toFixed(4)}\n`);

  const deficit = -2.0;
  console.log(`Counter-example: an observed deficit of ${deficit.toFixed(2)} rarefied distinct ideas --`);
  console.log(`  under the registered ~60-basis delta (${delta60.toFixed(4)}): ${marginVerdict(deficit, delta60)}`);
  console.log(`  under the transported ~30-basis delta (${delta30.toFixed(4)}): ${marginVerdict(deficit, delta30)}`);
  console.log("  Same data, opposite verdicts -- the choice of basis is load-bearing, not cosmetic.\n");

  const se6024x2 = seForDesign(SIGMA2_BA_60, SIGMA2_E_60, REGISTERED_B, REGISTERED_R);
  const powerOneSided = powerAtZero(delta60, se6024x2, Z_ALPHA_ONE_SIDED);
  const powerHolmWorst = powerAtZero(delta60, se6024x2, Z_ALPHA_HOLM_WORST_CASE);
  console.log(`Resolvability context at the registered design (B=${REGISTERED_B}, R=${REGISTERED_R}, ~60 basis) -- REPORTED, NOT TARGETED`);
  console.log("(Appendix G item 2: \"the MDE is reported, not targeted\" -- delta above was NOT chosen to hit either figure below):");
  console.log(`  SE = sqrt(2*(${SIGMA2_BA_60}/${REGISTERED_B} + ${SIGMA2_E_60}/${REGISTERED_B * REGISTERED_R})) = ${se6024x2.toFixed(4)}`);
  console.log(`  power at true difference = 0, one-sided alpha=${ALPHA_ONE_SIDED} (z=${Z_ALPHA_ONE_SIDED}): Phi(${(delta60 / se6024x2).toFixed(4)} - ${Z_ALPHA_ONE_SIDED}) = Phi(${(delta60 / se6024x2 - Z_ALPHA_ONE_SIDED).toFixed(4)}) = ${powerOneSided.toFixed(4)} (~${(powerOneSided * 100).toFixed(0)}%)`);
  console.log(`  power at true difference = 0, Holm worst-case per-slot alpha=${ALPHA_HOLM_WORST_CASE} (z=${Z_ALPHA_HOLM_WORST_CASE}): Phi(${(delta60 / se6024x2 - Z_ALPHA_HOLM_WORST_CASE).toFixed(4)}) = ${powerHolmWorst.toFixed(4)} (~${(powerHolmWorst * 100).toFixed(0)}%)`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
