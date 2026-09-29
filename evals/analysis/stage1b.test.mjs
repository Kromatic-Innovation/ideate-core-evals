// stage1b.test.mjs -- #182: Stage 1b's registered headline metric lane.
//
// §4.1 registers distinct_k/cost as "The headline metric. Answers the question
// actually asked."; Appendix C item 3 registers its basis as "full-pool,
// self-correcting"; §6.3 registers the cost/diversity Pareto frontier as the
// companion output; amendment B6 registers the cluster-bootstrap CI and that
// the lane is always labelled descriptive.
//
// pareto.test.mjs already covers the arithmetic of paretoFrontier() and
// costDiversityRatio(). What is untested without this file is the WIRING: that
// Stage 1b computes the lane, and computes it on the FULL-POOL frame rather
// than the rarefied one the contrasts are fit on.
//
// Hermetic -- no store, no network, no `results*/` read. computeS1bCostLane is
// pure over a frame shape, which is why it is exported.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  computeS1bCostLane,
  formatCostLane,
  S1B_REFERENCE_ARM,
  S1B_PANEL_ARM,
  S1B_APRIME_ARM,
} from "./stage1b.mjs";
import { buildRarefiedFrame } from "./rarefiedFrame.mjs";
import { summarizeByArm } from "./frame.mjs";
import { costDiversityRatio } from "./pareto.mjs";
import { distinctK } from "../metrics/clustering.mjs";

const CFG = "s1bcfg000001";

/** Stage 1b's three arms with distinct cost/diversity profiles.
 *
 *  `costUsd` is a power of two on every row (0.25 / 0.5), so every expected
 *  ratio below is exactly representable and the assertions can use
 *  `assert.equal` rather than an epsilon. */
function s1bFrame() {
  const rows = [];
  const add = (armId, response, costUsd) => {
    for (let i = 0; i < 3; i++) {
      rows.push({
        cellKey: `${armId}|b${i}|0`,
        armId,
        briefId: `b${i}`,
        replicate: 0,
        cfg: CFG,
        response,
        costUsd,
      });
    }
  };
  add(S1B_REFERENCE_ARM, 44, 0.25); // cheap, fewer ideas
  add(S1B_PANEL_ARM, 52, 0.5); // dearer, more ideas -- a genuine tradeoff
  add(S1B_APRIME_ARM, 40, 0.5); // dearer AND fewer -- strictly dominated
  return {
    rows,
    armLevels: [S1B_REFERENCE_ARM, S1B_PANEL_ARM, S1B_APRIME_ARM],
    briefLevels: ["b0", "b1", "b2"],
    responseField: "distinct_k",
    configHash: CFG,
    configHashes: [CFG],
    excluded: { failed: [], skipped: [], stale: [] },
    failuresByArm: {},
    skippedByArm: {},
  };
}

test("#182: Stage 1b reports a distinct_k-per-dollar ratio for every arm, labelled descriptive (B6)", () => {
  const lane = computeS1bCostLane(s1bFrame(), { iterations: 100 });

  assert.deepEqual(Object.keys(lane.costRatioByArm).sort(), [S1B_APRIME_ARM, S1B_PANEL_ARM, S1B_REFERENCE_ARM].sort());
  assert.equal(lane.costRatioByArm[S1B_REFERENCE_ARM].ratio, (44 * 3) / (0.25 * 3));
  assert.equal(lane.costRatioByArm[S1B_PANEL_ARM].ratio, (52 * 3) / (0.5 * 3));
  assert.equal(lane.costRatioByArm[S1B_APRIME_ARM].ratio, (40 * 3) / (0.5 * 3));

  for (const r of Object.values(lane.costRatioByArm)) {
    // B6: never presentable as a confirmatory contrast, and the CI must
    // bracket the point estimate.
    assert.equal(r.descriptive, true);
    assert.ok(r.ciLower <= r.ratio && r.ratio <= r.ciUpper);
  }
});

test("#182: Stage 1b reports the §6.3 Pareto frontier over its own three arms", () => {
  const lane = computeS1bCostLane(s1bFrame(), { iterations: 50 });

  assert.deepEqual(
    lane.paretoPoints.map((p) => p.armId).sort(),
    [S1B_APRIME_ARM, S1B_PANEL_ARM, S1B_REFERENCE_ARM].sort(),
  );
  // S1B-APRIME costs what the panel costs and returns fewer ideas than either
  // other arm, so it is strictly dominated. The other two are the tradeoff
  // §6.3 exists to report instead of a single "best model".
  assert.equal(lane.paretoPoints.find((p) => p.armId === S1B_APRIME_ARM).onFrontier, false);
  assert.equal(lane.paretoPoints.find((p) => p.armId === S1B_REFERENCE_ARM).onFrontier, true);
  assert.equal(lane.paretoPoints.find((p) => p.armId === S1B_PANEL_ARM).onFrontier, true);
});

test("#182: the Stage 1b lane is deterministic -- same frame, same numbers, no wall-clock seed", () => {
  assert.deepEqual(
    computeS1bCostLane(s1bFrame(), { iterations: 100 }),
    computeS1bCostLane(s1bFrame(), { iterations: 100 }),
  );
  // The default seed derives from the frame's configHash (#46 QA SHOULD), not
  // a hardcoded constant.
  assert.notEqual(
    computeS1bCostLane(s1bFrame()).seed,
    computeS1bCostLane({ ...s1bFrame(), configHashes: ["otherhash001"] }).seed,
  );
});

// ── Appendix C item 3: the FULL-POOL basis ─────────────────────────────────
//
// Built with the real buildRarefiedFrame, not a hand-faked marker, so the
// fixture cannot drift away from the shape the CLI actually produces.

/** Local PRNG for FIXTURE construction only -- the same vendored copy, and the
 *  same reason, as rarefiedFrame.test.mjs / rarefaction.test.mjs. */
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

const POOL_THRESHOLD = 0.5;

/** Two arms with DIFFERENT pool sizes, so rarefying to the minimum genuinely
 *  moves the larger arm's distinct_k away from its full-pool value. */
function pooledS1bFrame() {
  const rows = [];
  const add = (armId, poolSize, costUsd, seedBase) => {
    for (let i = 0; i < 3; i++) {
      const pool = makeCategoricalPool(60, poolSize, seedBase + i);
      rows.push({
        cellKey: `${armId}|b${i}|0`,
        armId,
        briefId: `b${i}`,
        replicate: 0,
        cfg: CFG,
        response: distinctK(pool, POOL_THRESHOLD),
        costUsd,
        pool,
      });
    }
  };
  add(S1B_PANEL_ARM, 60, 0.5, 100); // the big pool
  add(S1B_REFERENCE_ARM, 12, 0.25, 200); // sets the floor
  return {
    rows,
    armLevels: [S1B_REFERENCE_ARM, S1B_PANEL_ARM],
    briefLevels: ["b0", "b1", "b2"],
    responseField: "distinct_k",
    poolField: "pool",
    configHash: CFG,
    configHashes: [CFG],
    excluded: { failed: [], skipped: [], stale: [] },
    failuresByArm: {},
    skippedByArm: {},
  };
}

test("#182 / Appendix C item 3: the Stage 1b ratio is the FULL-POOL value, not the rarefied one", () => {
  const frame = pooledS1bFrame();
  const rarefied = buildRarefiedFrame(frame, {
    armIds: [S1B_REFERENCE_ARM, S1B_PANEL_ARM],
    threshold: POOL_THRESHOLD,
    metric: "distinct_k",
  });

  // The fixture is only meaningful if the two bases actually disagree.
  const fullPoolMean = summarizeByArm(frame).find((a) => a.armId === S1B_PANEL_ARM).meanResponse;
  const rarefiedMean = summarizeByArm(rarefied).find((a) => a.armId === S1B_PANEL_ARM).meanResponse;
  assert.notEqual(fullPoolMean, rarefiedMean, "fixture must make the full-pool and rarefied values differ");

  const lane = computeS1bCostLane(frame, { iterations: 100 });

  const panelRows = frame.rows.filter((r) => r.armId === S1B_PANEL_ARM);
  const expectedFullPool =
    panelRows.reduce((s, r) => s + r.response, 0) / panelRows.reduce((s, r) => s + r.costUsd, 0);
  assert.equal(lane.costRatioByArm[S1B_PANEL_ARM].ratio, expectedFullPool);

  // And it is NOT the number the rarefied frame would have produced.
  const rarefiedRatio = costDiversityRatio(
    rarefied.rows.filter((r) => r.armId === S1B_PANEL_ARM),
    { iterations: 10 },
  ).ratio;
  assert.notEqual(lane.costRatioByArm[S1B_PANEL_ARM].ratio, rarefiedRatio);
  assert.equal(lane.basis, "full-pool");
});

test("#182 / Appendix C item 3: handing the Stage 1b lane a RAREFIED frame is refused, not silently reported", () => {
  const rarefied = buildRarefiedFrame(pooledS1bFrame(), {
    armIds: [S1B_REFERENCE_ARM, S1B_PANEL_ARM],
    threshold: POOL_THRESHOLD,
    metric: "distinct_k",
  });
  // The wiring mistake this guard exists to catch: the two frames are
  // structurally identical, so nothing downstream could tell the headline
  // metric had quietly changed estimand.
  assert.throws(() => computeS1bCostLane(rarefied), /refusing a RAREFIED frame/);
  assert.throws(() => computeS1bCostLane(rarefied), /full-pool/);
});

test("#182: an empty Stage 1b frame is refused rather than reported as a ratio", () => {
  assert.throws(() => computeS1bCostLane({ rows: [], armLevels: [] }), /frame.rows is empty/);
});

// ── The CLI surface (AC: Stage 1b "gets the same two sections") ────────────

test("#182: the Stage 1b CLI renders both sections, with a ratio AND a CI for every arm", () => {
  const frame = s1bFrame();
  const text = formatCostLane(computeS1bCostLane(frame, { iterations: 100 })).join("\n");

  assert.match(text, /=== cost\/diversity Pareto frontier/);
  assert.match(text, /=== distinct_k per dollar/);
  assert.match(text, /DESCRIPTIVE per amendment B6/);
  assert.match(text, /basis: full-pool/);
  for (const armId of frame.armLevels) {
    assert.match(text, new RegExp(`${armId}\\s+mean cost=\\$`), `${armId} missing from the frontier section`);
    assert.match(text, new RegExp(`${armId}\\s+ratio=[\\d.]+\\s+95% CI \\[[\\d.]+, [\\d.]+\\]`), `${armId} missing a ratio+CI`);
  }
  assert.match(text, new RegExp(`${S1B_PANEL_ARM}\\s+ratio=${((52 * 3) / (0.5 * 3)).toFixed(3)}\\b`));
});
