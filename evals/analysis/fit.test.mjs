// fit.test.mjs — layer 2: fit.mjs tested with an INJECTED FAKE runner
// returning canned sidecar JSON. No Python involved anywhere in this file —
// full ladder coverage without the sidecar present. See fit.integration.test.mjs
// for the ANALYSIS_SIDECAR=1-gated layer-3 test against a real sidecar.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runLadder, needsDescent, fitViaSidecar, fitR2, SidecarUnavailableError, analysisHash, SIDECAR_SCRIPT_PATH } from "./fit.mjs";

const ARM_LEVELS = ["A", "B", "D"];
const REFERENCE = "A";
const COEF_NAMES = ["Intercept", "arm[T.B]", "arm[T.D]"];

function toolchain() {
  return { python: "3.11.15", numpy: "2.1.3", scipy: "1.14.1", pandas: "2.2.3", statsmodels: "0.15.0" };
}

function goodVcov(diag = [0.1, 0.2, 0.2]) {
  return diag.map((d, i) => diag.map((_, j) => (i === j ? d : 0)));
}

function makeRows() {
  const rows = [];
  for (const arm of ARM_LEVELS) {
    for (const brief of ["b1", "b2", "b3", "b4"]) {
      for (let rep = 0; rep < 2; rep++) {
        rows.push({ armId: arm, briefId: brief, response: 10 + (arm === "B" ? 2 : arm === "D" ? 4 : 0) });
      }
    }
  }
  return rows;
}

// ── needsDescent(): the diagnostics-only gate ───────────────────────────────

test("needsDescent: a converged fit with a healthy vcov does not descend", () => {
  const fit = { converged: true, coefficients: [10, 2, 4], vcov: goodVcov() };
  assert.equal(needsDescent(fit).descend, false);
});

test("needsDescent: converged === false forces a descent", () => {
  const fit = { converged: false, coefficients: [10, 2, 4], vcov: goodVcov() };
  const r = needsDescent(fit);
  assert.equal(r.descend, true);
  assert.match(r.reason, /did not converge/);
});

test("needsDescent: a non-finite vcov diagonal forces a descent", () => {
  const vcov = goodVcov();
  vcov[1][1] = Infinity;
  const fit = { converged: true, coefficients: [10, 2, 4], vcov };
  const r = needsDescent(fit);
  assert.equal(r.descend, true);
  assert.match(r.reason, /non-finite or non-positive/);
});

test("needsDescent: a <= 0 vcov diagonal forces a descent", () => {
  const vcov = goodVcov();
  vcov[2][2] = 0;
  const fit = { converged: true, coefficients: [10, 2, 4], vcov };
  assert.equal(needsDescent(fit).descend, true);
});

test("needsDescent: NaN in a coefficient's SE forces a descent", () => {
  const vcov = goodVcov();
  vcov[1][1] = NaN;
  const fit = { converged: true, coefficients: [10, 2, 4], vcov };
  assert.equal(needsDescent(fit).descend, true);
});

test("needsDescent: does NOT descend on its own for a boundary variance component (a finding, not a failure)", () => {
  // (1|brief:arm) estimating at zero -- needsDescent never even looks at
  // varianceComponents, so this must hold regardless of what it says.
  const fit = { converged: true, coefficients: [10, 2, 4], vcov: goodVcov(), varianceComponents: { brief: 1.2, "brief:arm": 0 } };
  assert.equal(needsDescent(fit).descend, false);
});

// ── fitViaSidecar(): schema validation + the injectable runner ─────────────

test("fitViaSidecar: a well-formed response passes through", async () => {
  const runner = async () => ({
    converged: true,
    coefficients: [10, 2, 4],
    coefficientNames: COEF_NAMES,
    vcov: goodVcov(),
    varianceComponents: { brief: 1.1, "brief:arm": 0.4 },
    n: 24,
    toolchain: toolchain(),
  });
  const fit = await fitViaSidecar("R0", makeRows(), ARM_LEVELS, REFERENCE, runner);
  assert.equal(fit.rung, "R0");
  assert.equal(fit.converged, true);
});

test("fitViaSidecar: coefficientNames mismatch is a hard SidecarUnavailableError, never a positional guess", async () => {
  const runner = async () => ({
    converged: true,
    coefficients: [10, 2, 4],
    coefficientNames: ["Intercept", "arm[T.D]", "arm[T.B]"], // swapped order
    vcov: goodVcov(),
    varianceComponents: {},
    n: 24,
    toolchain: toolchain(),
  });
  await assert.rejects(() => fitViaSidecar("R0", makeRows(), ARM_LEVELS, REFERENCE, runner), SidecarUnavailableError);
});

test("fitViaSidecar: a missing required field is a hard failure", async () => {
  const runner = async () => ({ converged: true, coefficients: [10, 2, 4], coefficientNames: COEF_NAMES, vcov: goodVcov() }); // no n, no toolchain
  await assert.rejects(() => fitViaSidecar("R0", makeRows(), ARM_LEVELS, REFERENCE, runner), SidecarUnavailableError);
});

test("fitViaSidecar: runner throwing (missing venv / import error) is a hard failure, zero numbers", async () => {
  const runner = async () => {
    throw new Error("spawn ENOENT: sidecar/.venv/bin/python3 not found");
  };
  await assert.rejects(() => fitViaSidecar("R0", makeRows(), ARM_LEVELS, REFERENCE, runner), SidecarUnavailableError);
});

test("fitViaSidecar: non-JSON / invalid stdout surfaces as a hard failure", async () => {
  const runner = async () => {
    throw new Error("sidecar stdout was not valid JSON: Unexpected token");
  };
  await assert.rejects(() => fitViaSidecar("R0", makeRows(), ARM_LEVELS, REFERENCE, runner), SidecarUnavailableError);
});

// ── fitR2(): pure-Node OLS + CR2 ────────────────────────────────────────────

test("fitR2: converges and returns a positive-definite vcov on a well-behaved balanced grid", () => {
  const rows = makeRows();
  const fit = fitR2(rows, ARM_LEVELS, REFERENCE);
  assert.equal(fit.rung, "R2");
  assert.equal(fit.converged, true);
  assert.equal(fit.coefficientNames.length, 3);
  for (let i = 0; i < 3; i++) assert.ok(fit.vcov[i][i] > 0);
});

test("fitR2: recovers the known arm offsets on a noiseless grid", () => {
  const rows = makeRows(); // B is +2, D is +4 over A by construction, zero noise
  const fit = fitR2(rows, ARM_LEVELS, REFERENCE);
  assert.ok(Math.abs(fit.coefficients[0] - 10) < 1e-8);
  assert.ok(Math.abs(fit.coefficients[1] - 2) < 1e-8);
  assert.ok(Math.abs(fit.coefficients[2] - 4) < 1e-8);
});

// #46 QA MUST #4: the only prior CR2 coverage was `vcov[i][i] > 0` on a
// PERFECTLY-BALANCED, zero-residual grid (fitR2's other test above) --
// degenerate for CR2 (zero residuals -> zero meat -> the sandwich's
// numerator vanishes, so a bug in the meat accumulation could pass
// silently). This fixture has genuine non-zero residuals, and the expected
// vcov below is hand-derived by explicit CR2 scalar arithmetic (H_g, I-H_g,
// its inverse-sqrt, u_g, v_g, the meat, the sandwich) worked independently
// in the PR description/commit, not by calling fitR2 or linalg.mjs.
test("fitR2: CR2 vcov matches an independently hand-derived reference on a small, non-degenerate fixture", () => {
  // 2 params (Intercept, arm[T.B]), 3 clusters (briefs), 1 obs/arm/brief --
  // every cluster has the SAME leverage by symmetry (H_g = (1/3)*I for
  // every g), which is what makes the by-hand CR2 derivation tractable:
  //   beta = [3, 4]  (OLS: Intercept = mean(A) = 3, arm[T.B] = mean(B) - mean(A) = 4)
  //   residuals: b1 (A=-1, B=-2), b2 (A=1, B=-1), b3 (A=0, B=3)
  //   H_g = [[1/3, 0], [0, 1/3]] for every g -> I-H_g = (2/3)*I
  //   A_g = (I-H_g)^(-1/2) = sqrt(3/2)*I
  //   w_g = [e_A+e_B, e_B]: w1=[-3,-2], w2=[0,-1], w3=[3,3]
  //   meat = (3/2) * sum(w_g w_g') = [[27, 22.5], [22.5, 21]]
  //   vcov = (X'X)^-1 * meat * (X'X)^-1, (X'X)^-1 = [[1/3,-1/3],[-1/3,2/3]]
  //        = [[1/3, -1/6], [-1/6, 7/3]]
  const rows = [
    { armId: "A", briefId: "b1", response: 2 },
    { armId: "B", briefId: "b1", response: 5 },
    { armId: "A", briefId: "b2", response: 4 },
    { armId: "B", briefId: "b2", response: 6 },
    { armId: "A", briefId: "b3", response: 3 },
    { armId: "B", briefId: "b3", response: 10 },
  ];
  const fit = fitR2(rows, ["A", "B"], "A");
  assert.equal(fit.converged, true);
  assert.equal(fit.df, 2); // 3 clusters - 1
  assert.ok(Math.abs(fit.coefficients[0] - 3) < 1e-9, `Intercept ${fit.coefficients[0]} vs 3`);
  assert.ok(Math.abs(fit.coefficients[1] - 4) < 1e-9, `arm[T.B] ${fit.coefficients[1]} vs 4`);

  const expectedVcov = [
    [1 / 3, -1 / 6],
    [-1 / 6, 7 / 3],
  ];
  for (let i = 0; i < 2; i++) {
    for (let j = 0; j < 2; j++) {
      assert.ok(
        Math.abs(fit.vcov[i][j] - expectedVcov[i][j]) < 1e-6,
        `vcov[${i}][${j}] = ${fit.vcov[i][j]}, expected ${expectedVcov[i][j]}`,
      );
    }
  }
});

test("fitR2: fails cleanly (does not throw) when clusters <= parameters", () => {
  // Only 2 briefs but 3 parameters (Intercept, arm[T.B], arm[T.D]).
  const rows = [];
  for (const arm of ARM_LEVELS) {
    for (const brief of ["b1", "b2"]) {
      rows.push({ armId: arm, briefId: brief, response: 10 });
    }
  }
  const fit = fitR2(rows, ARM_LEVELS, REFERENCE);
  assert.equal(fit.converged, false);
  assert.match(fit.failureReason, /fewer clusters/);
});

// ── runLadder(): full ladder orchestration with fixtures per rung ──────────

function makeRunner(responses) {
  // responses: { R0: respOrThrow, R1: respOrThrow }
  return async (request) => {
    const entry = responses[request.rung];
    if (entry instanceof Error) throw entry;
    if (typeof entry === "function") return entry(request);
    return entry;
  };
}

test("runLadder: R0 converges cleanly -> stays at R0, R2 still computed as a standing robustness check", async () => {
  const rows = makeRows();
  const runner = makeRunner({
    R0: {
      converged: true,
      coefficients: [10, 2, 4],
      coefficientNames: COEF_NAMES,
      vcov: goodVcov(),
      varianceComponents: { brief: 1.1, "brief:arm": 0.4 },
      n: rows.length,
      toolchain: toolchain(),
    },
  });
  const result = await runLadder({ rows, armLevels: ARM_LEVELS, referenceArm: REFERENCE, runner });
  assert.equal(result.rung, "R0");
  assert.ok(result.fit);
  assert.equal(result.robustnessCheck.rung, "R2");
  assert.equal(result.robustnessCheck.converged, true);
  assert.deepEqual(result.history.map((h) => h.rung), ["R0"]);
});

test("runLadder: a boundary variance component (brief:arm ~ 0) with a healthy vcov stays at R0 -- a finding, not a descent", async () => {
  const rows = makeRows();
  const runner = makeRunner({
    R0: {
      converged: true,
      coefficients: [10, 2, 4],
      coefficientNames: COEF_NAMES,
      vcov: goodVcov(),
      varianceComponents: { brief: 1.1, "brief:arm": 0 }, // boundary, but converged + healthy vcov
      n: rows.length,
      toolchain: toolchain(),
    },
  });
  const result = await runLadder({ rows, armLevels: ARM_LEVELS, referenceArm: REFERENCE, runner });
  assert.equal(result.rung, "R0");
  assert.equal(result.fit.varianceComponents["brief:arm"], 0);
});

test("runLadder: R0 non-convergence descends to R1, which converges", async () => {
  const rows = makeRows();
  const runner = makeRunner({
    R0: { converged: false, coefficients: [NaN, NaN, NaN], coefficientNames: COEF_NAMES, vcov: goodVcov(), varianceComponents: {}, n: rows.length, toolchain: toolchain() },
    R1: { converged: true, coefficients: [10, 2, 4], coefficientNames: COEF_NAMES, vcov: goodVcov(), varianceComponents: { brief: 1.0 }, n: rows.length, toolchain: toolchain() },
  });
  const result = await runLadder({ rows, armLevels: ARM_LEVELS, referenceArm: REFERENCE, runner });
  assert.equal(result.rung, "R1");
  assert.deepEqual(result.history.map((h) => h.rung), ["R0", "R1"]);
  assert.equal(result.history[0].descended, true);
});

test("runLadder: R1 NaN SE descends to R2 (pure Node, no sidecar call)", async () => {
  const rows = makeRows();
  const nanVcov = goodVcov();
  nanVcov[1][1] = NaN;
  const runner = makeRunner({
    R0: { converged: false, coefficients: [10, 2, 4], coefficientNames: COEF_NAMES, vcov: goodVcov(), varianceComponents: {}, n: rows.length, toolchain: toolchain() },
    R1: { converged: true, coefficients: [10, 2, 4], coefficientNames: COEF_NAMES, vcov: nanVcov, varianceComponents: { brief: 1.0 }, n: rows.length, toolchain: toolchain() },
  });
  const result = await runLadder({ rows, armLevels: ARM_LEVELS, referenceArm: REFERENCE, runner });
  assert.equal(result.rung, "R2");
  assert.equal(result.fit.method, "OLS+CR2");
  assert.deepEqual(result.history.map((h) => h.rung), ["R0", "R1", "R2"]);
});

test("runLadder: R0 and R1 both fail, and R2 also fails (too few clusters) -> R3, no confirmatory inference", async () => {
  // Only 2 briefs (< 3 parameters) so fitR2 internally fails too.
  const rows = [];
  for (const arm of ARM_LEVELS) {
    for (const brief of ["b1", "b2"]) {
      rows.push({ armId: arm, briefId: brief, response: 10 });
    }
  }
  const runner = makeRunner({
    R0: { converged: false, coefficients: [10, 2, 4], coefficientNames: COEF_NAMES, vcov: goodVcov(), varianceComponents: {}, n: rows.length, toolchain: toolchain() },
    R1: { converged: false, coefficients: [10, 2, 4], coefficientNames: COEF_NAMES, vcov: goodVcov(), varianceComponents: {}, n: rows.length, toolchain: toolchain() },
  });
  const result = await runLadder({ rows, armLevels: ARM_LEVELS, referenceArm: REFERENCE, runner });
  assert.equal(result.rung, "R3");
  assert.equal(result.fit, null);
  assert.equal(result.robustnessCheck.converged, false);
});

test("runLadder: sidecar unavailable at R0 is a HARD FAILURE, never silently treated as R3", async () => {
  const rows = makeRows();
  const runner = makeRunner({ R0: new Error("ENOENT: sidecar/.venv/bin/python3 not found") });
  await assert.rejects(() => runLadder({ rows, armLevels: ARM_LEVELS, referenceArm: REFERENCE, runner }), SidecarUnavailableError);
});

test("runLadder: sidecar unavailable at R1 (after an R0 descent) is also a hard failure, not R3", async () => {
  const rows = makeRows();
  const runner = makeRunner({
    R0: { converged: false, coefficients: [10, 2, 4], coefficientNames: COEF_NAMES, vcov: goodVcov(), varianceComponents: {}, n: rows.length, toolchain: toolchain() },
    R1: new Error("sidecar exited 1: ModuleNotFoundError: statsmodels"),
  });
  await assert.rejects(() => runLadder({ rows, armLevels: ARM_LEVELS, referenceArm: REFERENCE, runner }), SidecarUnavailableError);
});

// ── analysisHash: live inputs, never hardcoded, never folded into configHash ─

test("analysisHash: changes when the toolchain versions change, for the same script", () => {
  const fitA = { toolchain: toolchain() };
  const fitB = { toolchain: { ...toolchain(), statsmodels: "0.16.0" } };
  assert.notEqual(analysisHash(fitA, SIDECAR_SCRIPT_PATH), analysisHash(fitB, SIDECAR_SCRIPT_PATH));
});

test("analysisHash: is order-independent over the toolchain object's keys", () => {
  const fitA = { toolchain: { python: "3.11.15", numpy: "2.1.3" } };
  const fitB = { toolchain: { numpy: "2.1.3", python: "3.11.15" } };
  assert.equal(analysisHash(fitA, SIDECAR_SCRIPT_PATH), analysisHash(fitB, SIDECAR_SCRIPT_PATH));
});

test("analysisHash: is deterministic given the same inputs", () => {
  const fit = { toolchain: toolchain() };
  assert.equal(analysisHash(fit, SIDECAR_SCRIPT_PATH), analysisHash(fit, SIDECAR_SCRIPT_PATH));
});

// ── Determinism: runLadder() is a pure function of its inputs given a fixed
//    fake runner — NOT a claim about re-running against the same on-disk
//    store (that would need buildFrame()/priceRows()/a real ResultsStore in
//    the loop, none of which this file touches; see #46 QA SHOULD, which
//    flagged the old name as overclaiming a "re-run on the same store"
//    property this test cannot support). ─────────────────────────────────

test("runLadder: is a pure function of its inputs — same fixture twice produces byte-identical JSON, no wall-clock, no absolute paths", async () => {
  const rows = makeRows();
  const runner = makeRunner({
    R0: {
      converged: true,
      coefficients: [10, 2, 4],
      coefficientNames: COEF_NAMES,
      vcov: goodVcov(),
      varianceComponents: { brief: 1.1, "brief:arm": 0.4 },
      n: rows.length,
      toolchain: toolchain(),
    },
  });
  const a = await runLadder({ rows, armLevels: ARM_LEVELS, referenceArm: REFERENCE, runner });
  const b = await runLadder({ rows, armLevels: ARM_LEVELS, referenceArm: REFERENCE, runner });
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  assert.ok(!JSON.stringify(a).match(/\d{4}-\d{2}-\d{2}T/), "no ISO timestamp in the emitted ladder JSON");
  assert.ok(!JSON.stringify(a).includes(process.cwd()), "no absolute path baked into the emitted ladder JSON");
});
