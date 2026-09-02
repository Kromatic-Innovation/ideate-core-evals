// analysis.main.test.mjs — issue #73 fix round, BLOCKING 1. Exercises
// analysis.mjs's `main()` ITSELF (the actual CLI orchestrator), not a
// hand-rolled composition of the modules it calls. Before this file existed,
// nothing imported analysis.mjs at all — deleting the rarefied lane from
// main(), making H1 read the full-pool fit unconditionally, or broadening
// the PoolsUnavailableError catch to `if (true)` all left the rest of the
// suite green (verified; see this issue's PR description for the exact
// counts). This file is the one that must go red for those three mutations.
//
// Hermetic: `main()` takes an injectable second argument (`deps.runner`)
// added in this fix round specifically so this file never spawns the real
// Python sidecar — the CLI entrypoint at the bottom of analysis.mjs never
// passes it, so production behavior (always the real spawned sidecar) is
// unchanged.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { main } from "./analysis.mjs";
import { ResultsStore } from "../../lib/store.mjs";
import { recordJudgeScores } from "../judge/score.mjs";
import { cellKey, configHash } from "../../lib/manifest.mjs";
import { distinctK } from "../metrics/clustering.mjs";
import { buildRegisteredFamily, evaluateSpec } from "./contrasts.mjs";

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeCategoricalPool(categoryCount, n, seed) {
  const rng = mulberry32(seed);
  const pool = [];
  for (let i = 0; i < n; i++) {
    const category = Math.floor(rng() * categoryCount);
    const vec = new Array(categoryCount).fill(0);
    vec[category] = 1;
    pool.push(vec);
  }
  return pool;
}

const THRESHOLD = 0.5;
const CATEGORY_COUNT = 50;
const N_A = 30;
const N_PANEL = 60;
const BRIEFS = ["b1", "b2", "b3", "b4"];

// The fixture config. As of issue #91 its CONTENT no longer has to match
// anything the CLI computes: analysis.mjs derives the configHash from the
// store itself (evals/analysis/storeConfig.mjs), so any config produces a
// store the CLI can read, and --cluster-distance-threshold no longer
// influences selection at all. Both variants are kept because the fixtures
// below still exercise the threshold's OTHER (real) effect -- rarefaction.
//
// Before #91 this helper was load-bearing in the opposite direction: the
// CLI had a flag for exactly ONE of lib/manifest.mjs's nine CONFIG_FIELDS,
// so a fixture cfg had to be hand-matched to `{}`-plus-maybe-the-threshold
// or every seeded row read back as `stale`. That constraint is what made
// the CLI unable to select evals/run.mjs's real cells; see
// storeConfig.test.mjs for the round trip that now pins it.
function configFor(withThreshold) {
  return withThreshold ? { clusterDistanceThreshold: THRESHOLD } : {};
}

/** A fake sidecar runner: fits per-arm means as OLS coefficients (ignoring
 *  random effects entirely — this is a TEST DOUBLE, not a statistics
 *  engine). Real enough that full-pool vs rarefied response data produce
 *  DIFFERENT coefficients, which is exactly what the discriminating tests
 *  below need — a fake that always returned zeros would pass even with the
 *  wiring removed. */
async function fakeSidecarRunner(request) {
  const others = request.armLevels.filter((a) => a !== request.referenceArm);
  const names = ["Intercept", ...others.map((a) => `arm[T.${a}]`)];
  const byArm = new Map();
  for (const r of request.rows) {
    if (!byArm.has(r.arm)) byArm.set(r.arm, []);
    byArm.get(r.arm).push(r.y);
  }
  const mean = (arr) => arr.reduce((s, v) => s + v, 0) / arr.length;
  const refMean = mean(byArm.get(request.referenceArm) || [0]);
  const coefficients = names.map((name) => {
    if (name === "Intercept") return refMean;
    const arm = /^arm\[T\.(.+)\]$/.exec(name)[1];
    return mean(byArm.get(arm) || [refMean]) - refMean;
  });
  const k = names.length;
  const vcov = Array.from({ length: k }, (_, i) => Array.from({ length: k }, (_, j) => (i === j ? 0.05 : 0)));
  return {
    converged: true,
    coefficients,
    coefficientNames: names,
    vcov,
    varianceComponents: {},
    n: request.rows.length,
    toolchain: { fake: "analysis.main.test.mjs" },
  };
}

// buildRegisteredFamily()'s DEFAULTS name arms B, D, E, G, H directly
// (H2: E vs D, H3: G vs D/H, H4: B vs D), so this fixture uses the REAL
// registered arm set (reference A + the five registered panel arms).
//
// Until issue #97 that was not a choice but a constraint: a smaller store
// made the family name arms the fit did not carry, and the run died as
// `contrastVector: unknown coefficient 'arm[T.E]'`. #97 fixed that -- see
// the two-arm end-to-end test at the bottom of this file, which is the
// #8 smoke study's shape (arms A and B only).
const ARMS = ["A", "B", "D", "E", "G", "H"];

function seedStore(config, { withPools, arms = ARMS }) {
  const dir = mkdtempSync(join(tmpdir(), "ideate-store-main-"));
  const store = new ResultsStore(dir);
  const cfg = configHash(config);
  let seed = 30000;
  for (const briefId of BRIEFS) {
    for (const armId of arms) {
      const n = armId === "A" ? N_A : N_PANEL; // Arm A: maxRounds 1 (~30); every panel arm: maxRounds 2 (~60)
      const pool = makeCategoricalPool(CATEGORY_COUNT, n, seed++);
      const key = cellKey({ armId, briefId, replicate: 0, cfg });
      const result = { distinct_k: distinctK(pool, THRESHOLD) };
      if (withPools) result.pool = pool;
      // costDiversityRatioByArm() (pareto.mjs) requires a positive priced
      // cost per arm -- a real cost row, not an empty array, so the Pareto
      // / cost lane (which stays on the full-pool frame regardless of
      // rarefaction) has something to divide by.
      const costRows = [
        { cellKey: key, timestamp: "2026-09-01T00:00:00Z", billing_mode: "api", model: "claude-haiku-4-5", input_tokens: 500, output_tokens: 200 },
      ];
      store.put({
        key,
        armId,
        briefId,
        replicate: 0,
        cfg,
        resolvedModels: { proposer: "claude-haiku-4-5" },
        costRows,
        result,
        accounting: { state: "completed" },
      });
    }
  }
  return dir;
}

function tmpOutDir() {
  return mkdtempSync(join(tmpdir(), "ideate-out-main-"));
}

/** Same fixture as seedStore(..., {withPools: true}), except exactly ONE
 *  cell (arm H, brief b1) has no pool while every sibling does -- a real
 *  bug (MixedPoolCoverageError), never the ordinary pre-#8 "no pools
 *  anywhere" state. ResultsStore refuses re-putting an existing key with
 *  different content (see store.test.mjs), so this is built as its own
 *  seed rather than mutating a cell after seedStore() already wrote it. */
function seedStoreMixedPoolCoverage(config) {
  const dir = mkdtempSync(join(tmpdir(), "ideate-store-main-mixed-"));
  const store = new ResultsStore(dir);
  const cfg = configHash(config);
  let seed = 40000;
  for (const briefId of BRIEFS) {
    for (const armId of ARMS) {
      const n = armId === "A" ? N_A : N_PANEL;
      const pool = makeCategoricalPool(CATEGORY_COUNT, n, seed++);
      const key = cellKey({ armId, briefId, replicate: 0, cfg });
      const result = { distinct_k: distinctK(pool, THRESHOLD) };
      if (!(armId === "H" && briefId === "b1")) result.pool = pool; // the one deliberate hole
      const costRows = [
        { cellKey: key, timestamp: "2026-09-01T00:00:00Z", billing_mode: "api", model: "claude-haiku-4-5", input_tokens: 500, output_tokens: 200 },
      ];
      store.put({
        key,
        armId,
        briefId,
        replicate: 0,
        cfg,
        resolvedModels: { proposer: "claude-haiku-4-5" },
        costRows,
        result,
        accounting: { state: "completed" },
      });
    }
  }
  return dir;
}

test("main(): wires the rarefied lane end to end -- H1 is fit on a DIFFERENT fit than H2-H4's, REPORT.md and reproducibility artifacts show it", async () => {
  const config = configFor(true);
  const resultsDir = seedStore(config, { withPools: true });
  const outDir = tmpOutDir();
  try {
    const result = await main(
      ["--results-dir", resultsDir, "--out-dir", outDir, "--reference-arm", "A", "--cluster-distance-threshold", String(THRESHOLD)],
      { runner: fakeSidecarRunner },
    );

    assert.ok(result.rarefiedFrame, "rarefiedFrame must be built when the store carries pools");
    assert.ok(result.rarefiedLadder && result.rarefiedLadder.fit, "the rarefied ladder must produce a fit");

    const h1 = result.registeredResults.find((r) => r.id === "H1");
    assert.ok(!h1.unimplemented, "H1 must be computed, not reported unimplemented, when pools are present");
    assert.ok(Number.isFinite(h1.estimate));

    // H1 must have been evaluated against the RAREFIED fit, not the
    // full-pool one -- prove it by independently evaluating H1's spec
    // against the full-pool `ladder.fit` and showing the two disagree.
    const family = buildRegisteredFamily({ referenceArm: "A", panelArms: ["B", "D", "E", "G", "H"] });
    const h1Spec = family.find((s) => s.id === "H1");
    const fullPoolH1 = evaluateSpec(h1Spec, result.ladder.fit);
    assert.notEqual(
      h1.estimate,
      fullPoolH1.estimate,
      "H1's estimate must differ from what evaluating the SAME spec against the full-pool fit would give -- otherwise main() is silently using the full-pool fit for H1",
    );

    const reportMd = readFileSync(join(outDir, "REPORT.md"), "utf8");
    assert.match(reportMd, /## Rarefaction/);
    // Scoped to the Rarefaction section specifically (issue #80 fix round):
    // this fixture seeds no judge-scores records, so H5's OWN, independent
    // lane is expected to report itself not computed (its reason text
    // legitimately contains "NOT COMPUTED") even though H1's rarefied lane
    // above is fully computed -- the two lanes' not-computed states are
    // unrelated (see fit.mjs's header on H1's rung and H2-H5's rung never
    // being the same statement; H5's is a third, independent lane again).
    const rarefactionSection = reportMd.slice(reportMd.indexOf("## Rarefaction"), reportMd.indexOf("## Cost / diversity"));
    assert.doesNotMatch(rarefactionSection, /NOT COMPUTED/);

    assert.ok(existsSync(join(outDir, "analysis-data-rarefied.csv")), "rarefied reproducibility CSV must be written");
    assert.ok(existsSync(join(outDir, "lme4-fit-rarefied.R")), "rarefied reproducibility R script must be written");

    // CONTENT, not just presence (issue #73 fix round, BLOCKING) -- the prior
    // round's existsSync-only assertions could not see that lme4-fit-rarefied.R
    // was byte-identical to lme4-fit.R and hardcoded to read the full-pool
    // CSV under H1's label. Read both artifacts and pin what they say.
    const fullCsv = readFileSync(join(outDir, "analysis-data.csv"), "utf8");
    const rarefiedCsv = readFileSync(join(outDir, "analysis-data-rarefied.csv"), "utf8");
    assert.notEqual(fullCsv, rarefiedCsv, "the rarefied CSV must not be byte-identical to the full-pool CSV");
    assert.match(
      rarefiedCsv.split("\n")[0],
      /distinct_k_rarefied/,
      "the rarefied CSV's response column must be named distinctly from the full-pool count column (non-blocking rider)",
    );

    const fullR = readFileSync(join(outDir, "lme4-fit.R"), "utf8");
    const rarefiedR = readFileSync(join(outDir, "lme4-fit-rarefied.R"), "utf8");
    assert.notEqual(fullR, rarefiedR, "lme4-fit-rarefied.R must not be byte-identical to lme4-fit.R -- that was the shipped bug");
    assert.match(rarefiedR, /read\.csv\("analysis-data-rarefied\.csv"\)/, "the rarefied script must read the RAREFIED csv");
    assert.doesNotMatch(rarefiedR, /read\.csv\("analysis-data\.csv"\)/, "the rarefied script must never read the full-pool csv");
    assert.match(fullR, /read\.csv\("analysis-data\.csv"\)/, "the full-pool script must still read the full-pool csv, unchanged");

    const fitJson = JSON.parse(readFileSync(join(outDir, "fit.json"), "utf8"));
    assert.ok(fitJson.rarefied && fitJson.rarefied.fit, "fit.json must carry the rarefied lane's own fit");
  } finally {
    rmSync(resultsDir, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("main(): a MixedPoolCoverageError (some cells have pools, some don't) is a hard failure -- never silently reported as H1 NOT COMPUTED", async () => {
  // This is the discriminator for BLOCKING 1's mutation 3 (broadening
  // main()'s `catch (err) { if (err instanceof PoolsUnavailableError) ... }`
  // to swallow every error): with that mutation, THIS scenario -- a real
  // bug, not the ordinary pre-#8 pool-less state -- would silently degrade
  // to "H1 not computed" instead of aborting the run.
  const config = configFor(true);
  const resultsDir = seedStoreMixedPoolCoverage(config);
  const outDir = tmpOutDir();
  try {
    await assert.rejects(
      () =>
        main(["--results-dir", resultsDir, "--out-dir", outDir, "--reference-arm", "A", "--cluster-distance-threshold", String(THRESHOLD)], {
          runner: fakeSidecarRunner,
        }),
      /MixedPoolCoverageError|partially rarefied contrast is incoherent/,
      "a mixed pool coverage bug must abort the run, never degrade to a silent NOT COMPUTED H1",
    );
  } finally {
    rmSync(resultsDir, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("main(): pool-less store, documented CLI invocation (NO --cluster-distance-threshold) -- completes and writes every artifact with H1 reported NOT COMPUTED, never aborts (BLOCKING 2)", async () => {
  const config = configFor(false);
  const resultsDir = seedStore(config, { withPools: false });
  const outDir = tmpOutDir();
  try {
    const result = await main(
      ["--results-dir", resultsDir, "--out-dir", outDir, "--reference-arm", "A"], // no --cluster-distance-threshold, matching the pre-fix documented usage
      { runner: fakeSidecarRunner },
    );

    assert.equal(result.rarefiedFrame, null);
    const h1 = result.registeredResults.find((r) => r.id === "H1");
    assert.equal(h1.unimplemented, true);
    assert.equal(h1.p, 1);

    assert.ok(existsSync(join(outDir, "REPORT.md")));
    assert.ok(existsSync(join(outDir, "fit.json")));
    assert.ok(existsSync(join(outDir, "analysis-data.csv")));
    assert.ok(!existsSync(join(outDir, "analysis-data-rarefied.csv")), "no rarefied CSV when rarefaction was never computed");

    const reportMd = readFileSync(join(outDir, "REPORT.md"), "utf8");
    assert.match(reportMd, /NOT COMPUTED/);
  } finally {
    rmSync(resultsDir, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});

/** Same fixture as seedStore(..., {withPools: true}), except one cell's
 *  `result.pool` is PRESENT but malformed (`[]`, not a non-empty array) --
 *  a corrupt cell claiming to have a pool, distinct from the ordinary
 *  pre-#8 "no pool at all" state seedStore(..., {withPools:false}) builds. */
function seedStoreMalformedPool(config) {
  const dir = mkdtempSync(join(tmpdir(), "ideate-store-main-malformed-"));
  const store = new ResultsStore(dir);
  const cfg = configHash(config);
  let seed = 50000;
  for (const briefId of BRIEFS) {
    for (const armId of ARMS) {
      const n = armId === "A" ? N_A : N_PANEL;
      const pool = makeCategoricalPool(CATEGORY_COUNT, n, seed++);
      const key = cellKey({ armId, briefId, replicate: 0, cfg });
      const result = { distinct_k: distinctK(pool, THRESHOLD) };
      result.pool = armId === "H" && briefId === "b1" ? [] : pool; // one deliberately malformed pool
      const costRows = [
        { cellKey: key, timestamp: "2026-09-01T00:00:00Z", billing_mode: "api", model: "claude-haiku-4-5", input_tokens: 500, output_tokens: 200 },
      ];
      store.put({
        key,
        armId,
        briefId,
        replicate: 0,
        cfg,
        resolvedModels: { proposer: "claude-haiku-4-5" },
        costRows,
        result,
        accounting: { state: "completed" },
      });
    }
  }
  return dir;
}

test("main(): poolField on by default (issue #73 fix round, STATED DECISION) -- a malformed pool on a completed cell is a hard failure on the DEFAULT analysis path, not something a caller must opt into --pool-field to discover", async () => {
  const config = configFor(true);
  const resultsDir = seedStoreMalformedPool(config);
  const outDir = tmpOutDir();
  try {
    await assert.rejects(
      () =>
        main(["--results-dir", resultsDir, "--out-dir", outDir, "--reference-arm", "A", "--cluster-distance-threshold", String(THRESHOLD)], {
          runner: fakeSidecarRunner,
        }),
      /invalid pool/,
      "a malformed result.pool must hard-fail main() by default -- poolField defaulting to \"pool\" in analysis.mjs is a deliberate fail-loud choice, not a side effect of turning rarefaction on",
    );
  } finally {
    rmSync(resultsDir, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});

// ── H5's judge-score lane, wired end to end (issue #80) ─────────────────────

/** Runner that handles BOTH request shapes main() can send it: the arm
 *  lane's R0/R1 (delegates to fakeSidecarRunner's logic) and the judge-score
 *  lane's J0 (always reports non-converged, so runJudgeScoreLadder() falls
 *  through to J1 -- fitJudgeScoreR1(), REAL production Node CR2, never
 *  faked). */
async function fakeSidecarRunnerWithJudgeScore(request) {
  if (request.rung === "J0") {
    return {
      converged: false,
      coefficients: request.coefficientNames.map(() => NaN),
      coefficientNames: request.coefficientNames,
      vcov: request.coefficientNames.map(() => request.coefficientNames.map(() => NaN)),
      varianceComponents: {},
      n: request.y.length,
      toolchain: { fake: "analysis.main.test.mjs (J0, always non-converged)" },
    };
  }
  return fakeSidecarRunner(request);
}

test("main(): H5's judge-score lane reaching J2 (no confirmatory inference) reports H5 not-computed, WITHOUT aborting the whole run -- H1-H4 still compute", async () => {
  const config = configFor(true);
  const resultsDir = seedStore(config, { withPools: true });
  const store = new ResultsStore(resultsDir);
  const cfg = configHash(config);

  // Exactly 2 pools worth of judge-score records (2 runs -- fewer clusters
  // than the judge-score design's 3 parameters), so fitJudgeScoreR1() (the
  // REAL J1 fallback, not faked) genuinely cannot identify the CR2 sandwich
  // and reports converged: false -- a true J2, not a contrived one.
  //
  // One pool from arm A (Anthropic generators) and one from arm G (the only
  // provider-MIXED arm) so H5's bias term IS identifiable and this test
  // still reaches the J2 it is about (issue #97). Two arm-A pools would now
  // be refused one step earlier, by name, as a non-identifiable bias term --
  // correctly, but that is the other test's subject, not this one's.
  for (const armId of ["A", "G"]) {
    const poolKey = cellKey({ armId, briefId: "b1", replicate: 0, cfg });
    recordJudgeScores(store, {
      poolKey,
      judgeModel: "claude-sonnet-5",
      judgeProvider: "anthropic",
      scores: [{ originality: 5, feasibility: 6 }],
    });
    recordJudgeScores(store, {
      poolKey,
      judgeModel: "gpt-5.6-terra",
      judgeProvider: "openai",
      scores: [{ originality: 4, feasibility: 5 }],
    });
  }

  const outDir = tmpOutDir();
  try {
    const result = await main(
      ["--results-dir", resultsDir, "--out-dir", outDir, "--reference-arm", "A", "--cluster-distance-threshold", String(THRESHOLD)],
      { runner: fakeSidecarRunnerWithJudgeScore },
    );

    const h1 = result.registeredResults.find((r) => r.id === "H1");
    const h2 = result.registeredResults.find((r) => r.id === "H2");
    const h5 = result.registeredResults.find((r) => r.id === "H5");
    assert.ok(!h1.unimplemented, "H1 must still be computed -- H5's J2 must not take down the rest of the run");
    assert.ok(!h2.unimplemented, "H2 must still be computed");
    assert.equal(h5.unimplemented, true, "H5 must report not-computed when its ladder reaches J2");
    assert.equal(h5.p, 1);
    assert.match(h5.reason, /J2/, "the not-computed reason should name the rung reached, not a generic message");

    const reportMd = readFileSync(join(outDir, "REPORT.md"), "utf8");
    assert.match(reportMd, /\| H5 \|.*unimplemented \|/);
  } finally {
    rmSync(resultsDir, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("main(): H5 is COMPUTED end to end when judge-score records cover every pool -- a real estimate/CI/verdict, sourced from arms.config.json's own generator-provider set", async () => {
  const config = configFor(true);
  const resultsDir = seedStore(config, { withPools: true });
  const store = new ResultsStore(resultsDir);
  const cfg = configHash(config);

  // Every (arm x brief) pool gets both judge legs -- 6 arms x 4 briefs = 24
  // runs, well over the judge-score design's 3 parameters, so J1 (real
  // fitJudgeScoreR1(), never faked) converges. Scores vary by brief/arm so
  // the fit isn't a degenerate constant.
  let s = 0;
  for (const armId of ARMS) {
    for (const briefId of BRIEFS) {
      const poolKey = cellKey({ armId, briefId, replicate: 0, cfg });
      s += 1;
      recordJudgeScores(store, {
        poolKey,
        judgeModel: "claude-sonnet-5",
        judgeProvider: "anthropic",
        scores: [{ originality: 4 + (s % 5), feasibility: 5 + (s % 3) }],
      });
      recordJudgeScores(store, {
        poolKey,
        judgeModel: "gpt-5.6-terra",
        judgeProvider: "openai",
        scores: [{ originality: 3 + (s % 4), feasibility: 6 + (s % 2) }],
      });
    }
  }

  const outDir = tmpOutDir();
  try {
    const result = await main(
      ["--results-dir", resultsDir, "--out-dir", outDir, "--reference-arm", "A", "--cluster-distance-threshold", String(THRESHOLD)],
      { runner: fakeSidecarRunnerWithJudgeScore },
    );

    assert.ok(result.judgeScoreLadder && result.judgeScoreLadder.fit, "a judge-score fit must have been produced");
    assert.equal(result.judgeScoreLadder.rung, "J1"); // J0 always non-converged in this fixture's runner

    const h5 = result.registeredResults.find((r) => r.id === "H5");
    assert.equal(h5.unimplemented, undefined, "H5 must be computed, not reported unimplemented, when judge scores are present");
    assert.ok(Number.isFinite(h5.estimate));
    assert.ok(Number.isFinite(h5.holmP));
    assert.ok(h5.significant === true || h5.significant === false); // a real verdict was assigned, not left undefined

    const reportMd = readFileSync(join(outDir, "REPORT.md"), "utf8");
    assert.doesNotMatch(reportMd, /\| H5 \|.*unimplemented \|/);
  } finally {
    rmSync(resultsDir, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});

// ── issue #91: the CLI boundary itself ──────────────────────────────────
//
// storeConfig.test.mjs pins the run -> analysis round trip at the module
// level. These pin it where it actually broke: main()'s own argv handling.
// Before #91, main() computed its configHash from a config it had one flag
// for, so a store written under evals/run.mjs's five-field config was
// entirely invisible to it — every cell `stale`, `armLevels []`, and a
// downstream complaint about --reference-arm.

/** evals/run.mjs's real spec.config shape (the five CONFIG_FIELDS it sets).
 *  Values are placeholders; the point is the FIELD SET — none of which the
 *  CLI has, or should need, a flag for. */
const RUNNER_CONFIG = {
  harnessVersion: "0.0.1",
  engineSha: "ideate-core@0.4.0",
  promptHash: "unpinned",
  embedderId: "voyage-4-lite",
  corpusHash: "55e05c2811a7",
};

test("main(): selects cells written under evals/run.mjs's OWN config, with no config flag passed at all (issue #91)", async () => {
  const resultsDir = seedStore(RUNNER_CONFIG, { withPools: false });
  const outDir = tmpOutDir();
  try {
    const result = await main(["--results-dir", resultsDir, "--out-dir", outDir, "--reference-arm", "A"], {
      runner: fakeSidecarRunner,
    });
    assert.equal(result.frame.configHash, configHash(RUNNER_CONFIG));
    assert.equal(result.frame.rows.length, BRIEFS.length * ARMS.length);
    assert.deepEqual(result.frame.armLevels, ARMS.slice().sort());
    assert.equal(result.frame.excluded.stale.length, 0);
  } finally {
    rmSync(resultsDir, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("main(): --cluster-distance-threshold does not change WHICH cells are selected (issue #91's second-order trap)", async () => {
  // run.mjs passes clusterDistanceThreshold as a runSpec() option, never into
  // spec.config, so it is absent from every stored cell's cfg. The CLI used
  // to fold it into the hash — meaning that after adding the five missing
  // flags, passing this one would have reintroduced the very mismatch #91 is
  // about. It now feeds rarefaction only.
  const resultsDir = seedStore(RUNNER_CONFIG, { withPools: false });
  const outDir = tmpOutDir();
  try {
    const result = await main(
      ["--results-dir", resultsDir, "--out-dir", outDir, "--reference-arm", "A", "--cluster-distance-threshold", String(THRESHOLD)],
      { runner: fakeSidecarRunner },
    );
    assert.equal(result.frame.configHash, configHash(RUNNER_CONFIG));
    assert.notEqual(result.frame.configHash, configHash({ ...RUNNER_CONFIG, clusterDistanceThreshold: THRESHOLD }));
    assert.equal(result.frame.rows.length, BRIEFS.length * ARMS.length);
  } finally {
    rmSync(resultsDir, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("main(): a store holding two configHashes is refused by name, and --config-hash resolves it (issue #91)", async () => {
  // Two incomparable experiments in one store. Picking between them is the
  // silent-pooling judgment call lib/manifest.mjs exists to forbid, so the
  // CLI refuses — and says which hashes it found.
  const resultsDir = seedStore(RUNNER_CONFIG, { withPools: false });
  const outDir = tmpOutDir();
  const otherConfig = { ...RUNNER_CONFIG, engineSha: "ideate-core@0.5.0" };
  try {
    const store = new ResultsStore(resultsDir);
    const otherCfg = configHash(otherConfig);
    store.put({
      key: cellKey({ armId: "A", briefId: BRIEFS[0], replicate: 0, cfg: otherCfg }),
      armId: "A",
      briefId: BRIEFS[0],
      replicate: 0,
      cfg: otherCfg,
      result: { distinct_k: 3 },
      resolvedModels: { proposer: "claude-haiku-4-5" },
      accounting: { state: "completed" },
      costRows: [],
    });

    await assert.rejects(
      () => main(["--results-dir", resultsDir, "--out-dir", outDir, "--reference-arm", "A"], { runner: fakeSidecarRunner }),
      (err) => {
        assert.equal(err.name, "AmbiguousStoredConfigError");
        assert.match(err.message, new RegExp(configHash(RUNNER_CONFIG)));
        assert.match(err.message, new RegExp(otherCfg));
        assert.match(err.message, /--config-hash/);
        return true;
      },
    );

    const result = await main(
      ["--results-dir", resultsDir, "--out-dir", outDir, "--reference-arm", "A", "--config-hash", configHash(RUNNER_CONFIG)],
      { runner: fakeSidecarRunner },
    );
    assert.equal(result.frame.configHash, configHash(RUNNER_CONFIG));
    assert.equal(result.frame.rows.length, BRIEFS.length * ARMS.length);
  } finally {
    rmSync(resultsDir, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("main(): a --config-hash the store does not hold is reported as the exclusion it is, not as armLevels [] (issue #91)", async () => {
  const resultsDir = seedStore(RUNNER_CONFIG, { withPools: false });
  const outDir = tmpOutDir();
  try {
    await assert.rejects(
      () =>
        main(["--results-dir", resultsDir, "--out-dir", outDir, "--reference-arm", "A", "--config-hash", "560d764366bc"], {
          runner: fakeSidecarRunner,
        }),
      (err) => {
        assert.equal(err.name, "UnknownStoredConfigError");
        assert.match(err.message, /expected cfg 560d764366bc/);
        assert.match(err.message, new RegExp(`holds ${configHash(RUNNER_CONFIG)}`));
        // The symptom this replaces.
        assert.doesNotMatch(err.message, /armLevels/);
        return true;
      },
    );
  } finally {
    rmSync(resultsDir, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});

// ── Issue #97: analysis over a TWO-ARM store, end to end ─────────────────
// The #8 smoke study's shape: arms A and B only. Before #97 this run got
// past cell selection (#91), through the full-pool and rarefied ladders,
// and then died on `contrastVector: unknown coefficient 'arm[T.E]' -- not
// in [Intercept, arm[T.B]]` -- because --panel-arms scoped the model fit
// but not the registered contrast family. These two tests are the ones
// that must go red if that scoping is removed.

const TWO_ARMS = ["A", "B"];

test("main(): #97 -- a TWO-ARM store analyses end to end, recording the unreachable registered hypotheses instead of dying on 'unknown coefficient'", async () => {
  const resultsDir = seedStore(RUNNER_CONFIG, { withPools: false, arms: TWO_ARMS });
  const outDir = tmpOutDir();
  try {
    // No --panel-arms: the operator's actual path. panelArms is derived
    // from the frame's own armLevels, so the family scopes itself.
    const result = await main(["--results-dir", resultsDir, "--out-dir", outDir, "--reference-arm", "A"], {
      runner: fakeSidecarRunner,
    });

    // Selection and the full-pool fit both worked -- this is a real run,
    // not an early bail that happens to avoid the contrast.
    assert.equal(result.frame.rows.length, BRIEFS.length * TWO_ARMS.length);
    assert.deepEqual(result.frame.armLevels, ["A", "B"]);
    assert.ok(result.ladder.fit, "the full-pool ladder must still produce a fit");
    assert.deepEqual(result.ladder.fit.coefficientNames, ["Intercept", "arm[T.B]"]);

    // Every registered slot is present and each names why it could not be
    // reached -- naming the arm, the entry, and the arms available.
    assert.deepEqual(result.registeredResults.map((r) => r.id), ["H1", "H2", "H3", "H4", "H5"]);
    for (const id of ["H2", "H3", "H4"]) {
      const entry = result.registeredResults.find((r) => r.id === id);
      assert.equal(entry.notEstimable, true, `${id} must be recorded not-estimable, not computed against a substitute arm`);
      assert.equal(entry.p, 1);
      assert.match(entry.reason, /NOT ESTIMABLE/);
      assert.match(entry.reason, /\[A, B\]/, `${id}'s reason must name the arms actually available`);
      assert.doesNotMatch(entry.reason, /unknown coefficient/);
    }
    assert.deepEqual(result.registeredResults.find((r) => r.id === "H2").missingArms, ["E", "D"]);
    assert.deepEqual(result.registeredResults.find((r) => r.id === "H4").missingArms, ["D"]);

    // H1: a single panel arm collapses mean(panel arms) - A into a per-arm
    // comparison, which Appendix B item 5 keeps OUT of the Holm family.
    const h1 = result.registeredResults.find((r) => r.id === "H1");
    assert.equal(h1.notEstimable, true);
    assert.equal(h1.estimate, undefined, "H1 must not silently become an exploratory per-arm contrast under a registered name");

    // Multiplicity: still the REGISTERED 5 slots, not the estimated count.
    assert.equal(result.holmAdjusted.length, 5);
    assert.equal(result.estimability.slots, 5);
    assert.deepEqual(result.estimability.notEstimable.map((e) => e.id), ["H1", "H2", "H3", "H4"]);

    // And the report says all of it out loud.
    const reportMd = readFileSync(join(outDir, "REPORT.md"), "utf8");
    assert.match(reportMd, /REGISTERED FAMILY ONLY PARTLY ESTIMABLE/);
    assert.match(reportMd, /4 of 5 registered/);
    assert.match(reportMd, /- \*\*H2\*\* — NOT ESTIMABLE/);
    // The H1 row must NOT be attributed to a rarefaction failure -- it was
    // never estimable for this arm subset in the first place.
    assert.match(reportMd, /NOT a rarefaction failure/);
    assert.doesNotMatch(reportMd, /unknown coefficient/);

    // The rest of the pipeline still ran: Pareto/cost and the artifacts.
    assert.ok(existsSync(join(outDir, "analysis-data.csv")));
    assert.ok(existsSync(join(outDir, "pareto.svg")));
    assert.ok(existsSync(join(outDir, "fit.json")));
    assert.ok(Object.keys(result.costRatioByArm).length > 0);
  } finally {
    rmSync(resultsDir, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("main(): #97 -- judge scores on a TWO-ARM store degrade H5 to not-estimable instead of aborting the whole run on `Singular matrix`", async () => {
  const resultsDir = seedStore(RUNNER_CONFIG, { withPools: false, arms: TWO_ARMS });
  const store = new ResultsStore(resultsDir);
  const cfg = configHash(RUNNER_CONFIG);

  // Both judge legs on every pool, so the judgeProviderLevels < 2 guard does
  // NOT fire. Arms A and B are both all-Anthropic generators, so
  // `sameProvider` IS judge_provider restated and the bias column is
  // collinear -- the sidecar answers `Singular matrix`, which used to come
  // back as SidecarUnavailableError and take H1-H4 and the Pareto/cost lanes
  // down with it. Observed against the real #8 store.
  let s = 0;
  for (const armId of TWO_ARMS) {
    for (const briefId of BRIEFS) {
      const poolKey = cellKey({ armId, briefId, replicate: 0, cfg });
      s += 1;
      recordJudgeScores(store, { poolKey, judgeModel: "claude-sonnet-5", judgeProvider: "anthropic", scores: [{ originality: 4 + (s % 5), feasibility: 5 + (s % 3) }] });
      recordJudgeScores(store, { poolKey, judgeModel: "gpt-5.6-terra", judgeProvider: "openai", scores: [{ originality: 3 + (s % 4), feasibility: 6 + (s % 2) }] });
    }
  }

  const outDir = tmpOutDir();
  try {
    const result = await main(["--results-dir", resultsDir, "--out-dir", outDir, "--reference-arm", "A"], {
      runner: fakeSidecarRunnerWithJudgeScore,
    });

    // The run COMPLETED -- that is the whole point.
    assert.ok(result.ladder.fit, "the full-pool lane must still produce a fit");
    assert.ok(existsSync(join(outDir, "REPORT.md")));

    const h5 = result.registeredResults.find((r) => r.id === "H5");
    assert.equal(h5.notEstimable, true, "H5's arm-subset non-identifiability must be recorded as such");
    assert.equal(h5.p, 1);
    assert.match(h5.reason, /NOT IDENTIFIABLE/);
    assert.match(h5.reason, /arm G/, "must say what a run would need to estimate H5");
    assert.doesNotMatch(h5.reason, /Singular matrix/, "the report must name the CAUSE, not the sidecar's symptom");

    // All five slots, and H5 now joins the arm-subset banner.
    assert.equal(result.holmAdjusted.length, 5);
    assert.deepEqual(result.estimability.notEstimable.map((e) => e.id), ["H1", "H2", "H3", "H4", "H5"]);
    assert.match(readFileSync(join(outDir, "REPORT.md"), "utf8"), /5 of 5 registered/);
  } finally {
    rmSync(resultsDir, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("main(): #97 -- explicit --panel-arms B converges on the same result as deriving it from the store", async () => {
  const resultsDir = seedStore(RUNNER_CONFIG, { withPools: false, arms: TWO_ARMS });
  const outDirA = tmpOutDir();
  const outDirB = tmpOutDir();
  try {
    const derived = await main(["--results-dir", resultsDir, "--out-dir", outDirA, "--reference-arm", "A"], { runner: fakeSidecarRunner });
    const explicit = await main(["--results-dir", resultsDir, "--out-dir", outDirB, "--reference-arm", "A", "--panel-arms", "B"], {
      runner: fakeSidecarRunner,
    });
    assert.deepEqual(
      explicit.registeredResults.map((r) => [r.id, Boolean(r.notEstimable), r.p]),
      derived.registeredResults.map((r) => [r.id, Boolean(r.notEstimable), r.p]),
    );
    assert.deepEqual(explicit.estimability, derived.estimability);
  } finally {
    rmSync(resultsDir, { recursive: true, force: true });
    rmSync(outDirA, { recursive: true, force: true });
    rmSync(outDirB, { recursive: true, force: true });
  }
});
