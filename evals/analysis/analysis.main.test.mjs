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

// analysis.mjs's CLI has no flag to set harnessVersion/engineSha/promptHash
// (a pre-existing gap, independent of this issue) -- args.config is always
// `{}` except for whatever --cluster-distance-threshold adds. The store
// fixture's cfg must match EXACTLY what buildFrame() will compute from
// that same args.config, or every seeded row reads back as `stale`.
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

// buildRegisteredFamily()'s DEFAULTS (analysis.mjs never overrides them --
// no CLI flag exists for h2Pair/h3TargetVsBest/h4Pair, a pre-existing gap
// independent of this issue) name arms B, D, E, G, H directly (H2: E vs D,
// H3: G vs D/H, H4: B vs D). A minimal 2-arm A/P store makes
// buildRegisteredFamily() throw on those defaults before H1 is ever
// reached -- so this fixture uses the REAL registered arm set (reference A
// + the five registered panel arms) instead of inventing a smaller one.
const ARMS = ["A", "B", "D", "E", "G", "H"];

function seedStore(config, { withPools }) {
  const dir = mkdtempSync(join(tmpdir(), "ideate-store-main-"));
  const store = new ResultsStore(dir);
  const cfg = configHash(config);
  let seed = 30000;
  for (const briefId of BRIEFS) {
    for (const armId of ARMS) {
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
    assert.doesNotMatch(reportMd, /NOT COMPUTED/);

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
