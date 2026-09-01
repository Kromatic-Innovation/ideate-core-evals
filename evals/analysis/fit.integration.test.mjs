// fit.integration.test.mjs — layer 3: the REAL sidecar (spawned from
// evals/analysis/sidecar/.venv), asserting R0's fit agrees with the pure-JS
// balanced-ANOVA oracle (anova-oracle.mjs) to a tight tolerance. On a
// COMPLETE BALANCED design this oracle is a mathematical identity, not an
// approximation — that's how the sidecar gets validated without lme4/R on
// the host (see fit.mjs and anova-oracle.mjs headers).
//
// SKIPPED BY DEFAULT: gated on ANALYSIS_SIDECAR=1 so `node --test` stays
// green with no Python installed. Run explicitly with:
//   ANALYSIS_SIDECAR=1 node --test evals/analysis/fit.integration.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { fitViaSidecar, makeSidecarRunner, needsDescent } from "./fit.mjs";
import { balancedAnovaOracle } from "./anova-oracle.mjs";

const RUN = process.env.ANALYSIS_SIDECAR === "1";

// #46 QA MUST #4 (the "denominator" requirement): a green `node --test`
// must never let a reader assume the statistics were checked when the
// real-sidecar layer was skipped. This test ALWAYS runs (never gated on
// ANALYSIS_SIDECAR) and prints an unmissable, greppable line naming exactly
// which layer ran. It intentionally does no assertion of its own beyond
// "this line was printed" -- the actual verification is the gated test
// below; this one exists purely so CI output can never be silently
// ambiguous about whether layer 3 executed.
test("test-layer denominator: report whether the real-sidecar layer (layer 3) ran or was skipped", () => {
  const line = RUN
    ? "ANALYSIS TEST LAYERS: layer1=identity-oracle RAN, layer2=fake-runner RAN, layer3=real-sidecar RAN (ANALYSIS_SIDECAR=1)"
    : "ANALYSIS TEST LAYERS: layer1=identity-oracle RAN, layer2=fake-runner RAN, layer3=real-sidecar SKIPPED " +
      "(ANALYSIS_SIDECAR unset -- CR2/REML NOT verified against the real sidecar this run; " +
      "set ANALYSIS_SIDECAR=1 to run it)";
  console.log(line);
  assert.ok(line.includes("layer3="));
});

const ARM_LEVELS = ["A", "B", "D"];
const BRIEF_LEVELS = ["b1", "b2", "b3", "b4"];
const REPLICATES = 3;
const REFERENCE = "A";

// A synthetic, but non-trivial, balanced grid: real (non-zero) arm effects,
// brief effects, a real brief:arm interaction, and residual noise from a
// deterministic PRNG (mulberry32-style) — not Math.random(), so the fixture
// (and therefore the oracle's closed-form answer) is exactly reproducible.
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

function buildSyntheticGrid() {
  const rng = mulberry32(12345);
  const armEffect = { A: 0, B: 2.5, D: 4.5 };
  const briefEffect = { b1: 0, b2: 1.2, b3: -0.8, b4: 0.4 };
  // Small, structured interaction terms (not all zero, but modest, so R0
  // should converge cleanly on a balanced grid this size).
  const interaction = {};
  for (const arm of ARM_LEVELS) {
    for (const brief of BRIEF_LEVELS) {
      interaction[`${arm}|${brief}`] = ((rng() - 0.5) * 0.6);
    }
  }
  const rows = [];
  for (const arm of ARM_LEVELS) {
    for (const brief of BRIEF_LEVELS) {
      for (let rep = 0; rep < REPLICATES; rep++) {
        const noise = (rng() - 0.5) * 0.4;
        rows.push({
          armId: arm,
          briefId: brief,
          response: 10 + armEffect[arm] + briefEffect[brief] + interaction[`${arm}|${brief}`] + noise,
        });
      }
    }
  }
  return rows;
}

test("layer 3: real sidecar R0 fit agrees with the balanced-ANOVA oracle", { skip: !RUN }, async () => {
  const rows = buildSyntheticGrid();
  const oracle = balancedAnovaOracle(rows, ARM_LEVELS, BRIEF_LEVELS);

  const runner = makeSidecarRunner();
  const fit = await fitViaSidecar("R0", rows, ARM_LEVELS, REFERENCE, runner);

  assert.equal(needsDescent(fit).descend, false, `sidecar R0 fit should converge cleanly on this balanced grid, got: ${JSON.stringify(fit)}`);

  // Coefficients: Intercept ~= arm A's mean, arm[T.B]/arm[T.D] ~= the arm
  // mean differences from A. Compare against the oracle's arm means.
  const tol = 1e-4; // REML numerics vs. closed-form moment estimators agree
  // to ~1e-5 per #46's Specify-pass verification; 1e-4 leaves headroom for
  // solver-tolerance jitter while still failing loud on a real divergence.
  const bIdx = fit.coefficientNames.indexOf("arm[T.B]");
  const dIdx = fit.coefficientNames.indexOf("arm[T.D]");
  const oracleBDiff = oracle.armMeans.B - oracle.armMeans.A;
  const oracleDDiff = oracle.armMeans.D - oracle.armMeans.A;

  assert.ok(
    Math.abs(fit.coefficients[bIdx] - oracleBDiff) < tol,
    `arm[T.B] coefficient ${fit.coefficients[bIdx]} vs oracle ${oracleBDiff}`,
  );
  assert.ok(
    Math.abs(fit.coefficients[dIdx] - oracleDDiff) < tol,
    `arm[T.D] coefficient ${fit.coefficients[dIdx]} vs oracle ${oracleDDiff}`,
  );

  // SE of the B-vs-A contrast: sqrt(vcov[Intercept,Intercept] contribution)
  // -- here just Var(arm[T.B] coefficient), since arm[T.B] IS the B-vs-A
  // contrast under Treatment coding with reference A.
  const seB = Math.sqrt(fit.vcov[bIdx][bIdx]);
  const oracleSeB = oracle.armContrastSE("A", "B");
  assert.ok(
    Math.abs(seB - oracleSeB) < 1e-2,
    `arm[T.B] SE ${seB} vs oracle armContrastSE ${oracleSeB} (looser tolerance: REML's SE estimate ` +
      `is asymptotic, not an exact identity like the point estimate is on a balanced design)`,
  );
});
