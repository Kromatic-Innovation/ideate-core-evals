// distributions.mjs — the Student's-t machinery contrasts.mjs needs for R2's
// CR2 cluster-robust SEs (#46 QA SHOULD: "Wald z is used for R2's CR2 SEs
// ... at ~12 briefs the Satterthwaite/t reference is what makes it work").
// This module implements the (G-1) t reference, NOT full Bell-McCaffrey
// Satterthwaite degrees of freedom -- fitR2() sets `df = uniqueClusters.length
// - 1` (see fit.mjs), a standard, honest, low-cost approximation; a true
// Satterthwaite df would need every cluster's individual leverage-adjusted
// variance contribution, which is out of scope here. Naming this "G-1"
// rather than "Satterthwaite" throughout is deliberate (#46 QA review).
//
// Regularized incomplete beta function (Lanczos log-gamma + Numerical
// Recipes' continued-fraction betacf/betai) is the standard closed-form
// route from a Student-t statistic to its CDF/tail probability — this file
// has no other job than that one relationship, plus a bisection to invert
// it for a quantile (there's no closed-form t inverse-CDF).

function logGamma(x) {
  const g = 7;
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (x < 0.5) {
    return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  }
  x -= 1;
  let a = c[0];
  const t = x + g + 0.5;
  for (let i = 1; i < g + 2; i++) a += c[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

function betacf(a, b, x) {
  const MAXIT = 200, EPS = 3e-14, FPMIN = 1e-300;
  const qab = a + b, qap = a + 1, qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAXIT; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

/** Regularized incomplete beta function I_x(a, b), x in [0,1]. */
function betai(a, b, x) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  if (x < (a + 1) / (a + b + 2)) {
    return (bt * betacf(a, b, x)) / a;
  }
  return 1 - (bt * betacf(b, a, 1 - x)) / b;
}

/** Student's-t CDF: P(T <= t) for `df` degrees of freedom. */
export function tCdf(t, df) {
  if (!(df > 0)) throw new Error(`tCdf: df must be > 0, got ${df}`);
  const x = df / (df + t * t);
  const half = 0.5 * betai(df / 2, 0.5, x);
  return t >= 0 ? 1 - half : half;
}

/** One-sided upper-tail probability: P(T > t) for `df` degrees of freedom. */
export function tUpperTailP(t, df) {
  return 1 - tCdf(t, df);
}

/** Two-sided p-value: P(|T| > |t|) for `df` degrees of freedom. */
export function tTwoSidedP(t, df) {
  if (!(df > 0)) throw new Error(`tTwoSidedP: df must be > 0, got ${df}`);
  const x = df / (df + t * t);
  return betai(df / 2, 0.5, x);
}

/**
 * Student's-t quantile (inverse CDF) via bisection on tCdf — there is no
 * closed form, and df is always small/integer-ish here (cluster counts),
 * so bisection to double precision is both simple and cheap.
 *
 * @param {number} p    target cumulative probability, in (0, 1)
 * @param {number} df   degrees of freedom, > 0
 * @returns {number}
 */
export function tQuantile(p, df) {
  if (p <= 0 || p >= 1) throw new Error(`tQuantile: p must be in (0,1), got ${p}`);
  if (!(df > 0)) throw new Error(`tQuantile: df must be > 0, got ${df}`);
  if (p === 0.5) return 0;
  const sign = p > 0.5 ? 1 : -1;
  const target = sign > 0 ? p : 1 - p;
  let lo = 0, hi = 1;
  while (tCdf(hi, df) < target) hi *= 2;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (tCdf(mid, df) < target) lo = mid;
    else hi = mid;
    if (hi - lo < 1e-12) break;
  }
  return sign * (lo + hi) / 2;
}
