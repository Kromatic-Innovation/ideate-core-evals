// stage1c.test.mjs -- Appendix M item 5's per-arm configHash rule.
//
// The rule exists to keep 5 specific cells OUT of the treatment arm. Stage 1c's
// first run lost 139 of 144 S1C-RICH cells to a max-effort truncation defect
// (#168); the 5 that survived are exactly the cells in which none of the four
// max-effort replies truncated. They are the most outcome-selected subset in
// the store, and pooling the pre- and post-#168 hashes wholesale would fold
// them into the corrected arm.
//
// Hermetic -- no store, no network. Both functions under test are pure over a
// frame/tally shape.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PRE_168_CONFIG_HASH,
  resolveS1cArmHashes,
  applyArmHashRule,
  computeS1cCostLane,
  formatCostLane,
  S1C_REFERENCE_ARM,
  S1C_PANEL_ARM,
  S1C_CONTROL_ARM,
} from "./stage1c.mjs";
import { buildRarefiedFrame } from "./rarefiedFrame.mjs";
import { summarizeByArm } from "./frame.mjs";
import { costDiversityRatio } from "./pareto.mjs";
import { distinctK } from "../metrics/clustering.mjs";

/** A synthetic stand-in for the post-#168 configHash, NOT the real one. These
 *  tests must not pin what the corrected run happens to write -- the rule under
 *  test is "the treatment arm comes from whichever hash is not the pre-#168
 *  one", and hard-coding the real value would test the fixture instead. (For
 *  the record, the run wrote 9b17e4ba0734.) */
const POST = "post168hash0";

/** A tally in the shape tallyStoredConfigs returns. */
const tallyOf = (...cfgs) => cfgs.map((cfg) => ({ cfg, count: 1, states: ["completed"] }));

/** A frame carrying the real Stage 1c contamination: controls under the OLD
 *  hash, corrected RICH under the NEW one, and the outcome-selected RICH
 *  survivors under the OLD one. */
function contaminatedFrame() {
  const rows = [];
  for (let i = 0; i < 3; i++) rows.push({ armId: S1C_REFERENCE_ARM, briefId: `b${i}`, cfg: PRE_168_CONFIG_HASH, response: 44, costUsd: 0.25 });
  for (let i = 0; i < 3; i++) rows.push({ armId: S1C_CONTROL_ARM, briefId: `b${i}`, cfg: PRE_168_CONFIG_HASH, response: 40, costUsd: 0.5 });
  for (let i = 0; i < 4; i++) rows.push({ armId: S1C_PANEL_ARM, briefId: `b${i}`, cfg: POST, response: 47, costUsd: 0.5 });
  // The survivors. Given a DIFFERENT response so a test can prove they are gone
  // by their effect on the mean, not merely by a row count.
  for (let i = 0; i < 2; i++) rows.push({ armId: S1C_PANEL_ARM, briefId: `s${i}`, cfg: PRE_168_CONFIG_HASH, response: 99, costUsd: 0.5 });
  return {
    rows,
    armLevels: [S1C_REFERENCE_ARM, S1C_CONTROL_ARM, S1C_PANEL_ARM],
    configHash: PRE_168_CONFIG_HASH,
    configHashes: [PRE_168_CONFIG_HASH, POST],
    excluded: { failed: [], skipped: [], stale: [] },
  };
}

/** `costUsd` is a power of two on every fixture row (0.25 / 0.5), so each
 *  expected ratio below is exactly representable and the assertions can use
 *  `assert.equal` rather than an epsilon. */
const RICH_RATIO_RULE_APPLIED = (47 * 4) / (0.5 * 4); // 188 / 2 = 94
const RICH_RATIO_SURVIVORS_IN = (47 * 4 + 99 * 2) / (0.5 * 6); // 386 / 3

// ── resolveS1cArmHashes ─────────────────────────────────────────────────────

test("Appendix M item 5: controls resolve to the pre-#168 hash and S1C-RICH to the post-#168 one", () => {
  const { armHashes, post } = resolveS1cArmHashes(tallyOf(PRE_168_CONFIG_HASH, POST));
  assert.equal(post, POST);
  assert.equal(armHashes[S1C_REFERENCE_ARM], PRE_168_CONFIG_HASH);
  assert.equal(armHashes[S1C_CONTROL_ARM], PRE_168_CONFIG_HASH);
  assert.equal(armHashes[S1C_PANEL_ARM], POST);
  // The property the whole rule rests on: the treatment arm is NOT read from
  // the hash its contaminated survivors are stored under.
  assert.notEqual(armHashes[S1C_PANEL_ARM], PRE_168_CONFIG_HASH);
});

test("Appendix M item 5: a store with only the pre-#168 hash returns null -- the re-collect has not run", () => {
  assert.equal(resolveS1cArmHashes(tallyOf(PRE_168_CONFIG_HASH)), null);
});

test("Appendix M item 5: a store missing the pre-#168 hash is refused, not guessed at", () => {
  assert.throws(() => resolveS1cArmHashes(tallyOf(POST)), /does not hold the pre-#168 configHash/);
});

test("Appendix M item 5: THREE hashes are refused -- this tool will not choose which is S1C-RICH's", () => {
  assert.throws(
    () => resolveS1cArmHashes(tallyOf(PRE_168_CONFIG_HASH, POST, "cccccccccccc")),
    /will not choose between them/,
  );
});

// ── applyArmHashRule ────────────────────────────────────────────────────────

test("Appendix M item 5: the outcome-selected old-hash S1C-RICH rows are dropped from the treatment arm", () => {
  const { armHashes } = resolveS1cArmHashes(tallyOf(PRE_168_CONFIG_HASH, POST));
  const frame = applyArmHashRule(contaminatedFrame(), armHashes);

  const rich = frame.rows.filter((r) => r.armId === S1C_PANEL_ARM);
  assert.equal(rich.length, 4, "only the post-#168 RICH rows survive");
  assert.ok(rich.every((r) => r.cfg === POST));
  // The stronger assertion: the survivors' distinctive response is gone, so
  // this cannot pass by dropping the wrong rows and keeping the count right.
  assert.ok(!rich.some((r) => r.response === 99), "no outcome-selected survivor may reach the treatment arm");
  assert.equal(frame.droppedByArmHashRule.filter((r) => r.armId === S1C_PANEL_ARM).length, 2);
});

test("Appendix M item 5: both control arms are REUSED in full -- the point of the rule is to keep them", () => {
  const { armHashes } = resolveS1cArmHashes(tallyOf(PRE_168_CONFIG_HASH, POST));
  const frame = applyArmHashRule(contaminatedFrame(), armHashes);
  for (const arm of [S1C_REFERENCE_ARM, S1C_CONTROL_ARM]) {
    const rows = frame.rows.filter((r) => r.armId === arm);
    assert.equal(rows.length, 3, `${arm} keeps every pre-#168 row`);
    assert.ok(rows.every((r) => r.cfg === PRE_168_CONFIG_HASH));
  }
  assert.equal(frame.droppedByArmHashRule.filter((r) => r.armId !== S1C_PANEL_ARM).length, 0);
});

test("Appendix M item 5: the input frame is not mutated", () => {
  const original = contaminatedFrame();
  const before = original.rows.length;
  const { armHashes } = resolveS1cArmHashes(tallyOf(PRE_168_CONFIG_HASH, POST));
  applyArmHashRule(original, armHashes);
  assert.equal(original.rows.length, before);
});

test("Appendix M item 5: an arm left with no rows drops out of armLevels rather than lingering empty", () => {
  // The state a store in mid-re-collect is in: RICH's new-hash cells have not
  // landed yet, so every RICH row is an old-hash survivor and all are dropped.
  const frame = contaminatedFrame();
  frame.rows = frame.rows.filter((r) => r.cfg === PRE_168_CONFIG_HASH);
  const out = applyArmHashRule(frame, {
    [S1C_REFERENCE_ARM]: PRE_168_CONFIG_HASH,
    [S1C_CONTROL_ARM]: PRE_168_CONFIG_HASH,
    [S1C_PANEL_ARM]: POST,
  });
  assert.ok(!out.armLevels.includes(S1C_PANEL_ARM), "an empty arm must not linger as a level");
  assert.deepEqual(out.armLevels, [S1C_REFERENCE_ARM, S1C_CONTROL_ARM]);
});

test("Appendix M item 5: an arm with no assigned hash is passed through untouched", () => {
  // Defensive: the rule names three arms, and a store holding a fourth (a
  // future arm, or a sentinel that slipped the cell-key filter) must not be
  // silently deleted by a rule that says nothing about it.
  const frame = contaminatedFrame();
  frame.rows.push({ armId: "S1C-FUTURE", briefId: "b0", cfg: "ffffffffffff", response: 1 });
  frame.armLevels.push("S1C-FUTURE");
  const { armHashes } = resolveS1cArmHashes(tallyOf(PRE_168_CONFIG_HASH, POST));
  const out = applyArmHashRule(frame, armHashes);
  assert.equal(out.rows.filter((r) => r.armId === "S1C-FUTURE").length, 1);
});

// ── #182: the registered headline metric, distinct_k per dollar ─────────────
//
// §4.1 registers distinct_k/cost as the headline metric and Appendix C item 3
// registers its basis as "full-pool, self-correcting". Both properties are
// wiring, not arithmetic -- pareto.test.mjs already covers the arithmetic --
// so these tests assert WHICH FRAME the lane is computed on.

test("#182: the cost lane runs on the post-hash-rule frame -- the excluded old-hash S1C-RICH rows do not reach the ratio", () => {
  const { armHashes } = resolveS1cArmHashes(tallyOf(PRE_168_CONFIG_HASH, POST));
  const frame = applyArmHashRule(contaminatedFrame(), armHashes);

  const lane = computeS1cCostLane(frame, { iterations: 100 });

  assert.equal(lane.costRatioByArm[S1C_PANEL_ARM].ratio, RICH_RATIO_RULE_APPLIED);
  // The assertion that matters: the survivors' distinctive response/cost is
  // absent from the reported ratio, so this cannot pass on a frame that kept
  // them.
  assert.notEqual(lane.costRatioByArm[S1C_PANEL_ARM].ratio, RICH_RATIO_SURVIVORS_IN);
  // ... and the pooled pre-rule frame really would have reported the other
  // number, so the difference is the rule's doing and not a fixture accident.
  const pooledLane = computeS1cCostLane(contaminatedFrame(), { iterations: 100 });
  assert.equal(pooledLane.costRatioByArm[S1C_PANEL_ARM].ratio, RICH_RATIO_SURVIVORS_IN);

  // The control arms are untouched by the rule, so their ratios are the same
  // either way -- the contamination is specific to the treatment arm.
  assert.equal(lane.costRatioByArm[S1C_REFERENCE_ARM].ratio, (44 * 3) / (0.25 * 3));
  assert.equal(lane.costRatioByArm[S1C_CONTROL_ARM].ratio, (40 * 3) / (0.5 * 3));
});

test("#182: the Pareto frontier is computed over the post-hash-rule arms", () => {
  const { armHashes } = resolveS1cArmHashes(tallyOf(PRE_168_CONFIG_HASH, POST));
  const frame = applyArmHashRule(contaminatedFrame(), armHashes);
  const lane = computeS1cCostLane(frame, { iterations: 50 });

  assert.deepEqual(
    lane.paretoPoints.map((p) => p.armId).sort(),
    [S1C_CONTROL_ARM, S1C_PANEL_ARM, S1C_REFERENCE_ARM].sort(),
  );
  // S1C-SOLO6X10 costs more per cell than S1C-SOLO60 AND has a lower mean
  // distinct_k, so it is strictly dominated. S1C-SOLO60 (cheap, fewer ideas)
  // and S1C-RICH (dearer, more ideas) are a genuine tradeoff -- §6.3's whole
  // point that there is no single "best model".
  assert.equal(lane.paretoPoints.find((p) => p.armId === S1C_CONTROL_ARM).onFrontier, false);
  assert.equal(lane.paretoPoints.find((p) => p.armId === S1C_REFERENCE_ARM).onFrontier, true);
  assert.equal(lane.paretoPoints.find((p) => p.armId === S1C_PANEL_ARM).onFrontier, true);
  // The RICH mean response must be the post-rule one (47), not a blend that
  // includes the dropped survivors' 99.
  assert.equal(lane.paretoPoints.find((p) => p.armId === S1C_PANEL_ARM).meanResponse, 47);
  assert.equal(lane.paretoPoints.find((p) => p.armId === S1C_PANEL_ARM).meanCostUsd, 0.5);
});

test("#182: the lane is deterministic -- same frame, same numbers, no wall-clock seed", () => {
  const { armHashes } = resolveS1cArmHashes(tallyOf(PRE_168_CONFIG_HASH, POST));
  const frame = applyArmHashRule(contaminatedFrame(), armHashes);
  assert.deepEqual(computeS1cCostLane(frame, { iterations: 100 }), computeS1cCostLane(frame, { iterations: 100 }));
  // The default seed is derived from the frame's configHash set (#46 QA
  // SHOULD), never a hardcoded constant.
  const other = applyArmHashRule({ ...contaminatedFrame(), configHashes: ["deadbeefcafe", POST] }, armHashes);
  assert.notEqual(computeS1cCostLane(frame).seed, computeS1cCostLane(other).seed);
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
function pooledFrame() {
  const rows = [];
  for (let i = 0; i < 3; i++) {
    const pool = makeCategoricalPool(60, 60, 100 + i); // the big pool
    rows.push({
      cellKey: `${S1C_PANEL_ARM}|b${i}|0`,
      armId: S1C_PANEL_ARM,
      briefId: `b${i}`,
      replicate: 0,
      cfg: POST,
      response: distinctK(pool, POOL_THRESHOLD),
      costUsd: 0.5,
      pool,
    });
  }
  for (let i = 0; i < 3; i++) {
    const pool = makeCategoricalPool(60, 12, 200 + i); // sets the floor
    rows.push({
      cellKey: `${S1C_REFERENCE_ARM}|b${i}|0`,
      armId: S1C_REFERENCE_ARM,
      briefId: `b${i}`,
      replicate: 0,
      cfg: PRE_168_CONFIG_HASH,
      response: distinctK(pool, POOL_THRESHOLD),
      costUsd: 0.25,
      pool,
    });
  }
  return {
    rows,
    armLevels: [S1C_REFERENCE_ARM, S1C_PANEL_ARM],
    briefLevels: ["b0", "b1", "b2"],
    responseField: "distinct_k",
    poolField: "pool",
    configHash: PRE_168_CONFIG_HASH,
    configHashes: [PRE_168_CONFIG_HASH, POST],
    excluded: { failed: [], skipped: [], stale: [] },
    failuresByArm: {},
    skippedByArm: {},
  };
}

test("#182 / Appendix C item 3: the ratio is the FULL-POOL value, not the rarefied one", () => {
  const frame = pooledFrame();
  const rarefied = buildRarefiedFrame(frame, {
    armIds: [S1C_REFERENCE_ARM, S1C_PANEL_ARM],
    threshold: POOL_THRESHOLD,
    metric: "distinct_k",
  });

  // The fixture is only meaningful if the two bases actually disagree.
  const fullPoolMean = summarizeByArm(frame).find((a) => a.armId === S1C_PANEL_ARM).meanResponse;
  const rarefiedMean = summarizeByArm(rarefied).find((a) => a.armId === S1C_PANEL_ARM).meanResponse;
  assert.notEqual(fullPoolMean, rarefiedMean, "fixture must make the full-pool and rarefied values differ");

  const lane = computeS1cCostLane(frame, { iterations: 100 });

  const richRows = frame.rows.filter((r) => r.armId === S1C_PANEL_ARM);
  const expectedFullPool =
    richRows.reduce((s, r) => s + r.response, 0) / richRows.reduce((s, r) => s + r.costUsd, 0);
  assert.equal(lane.costRatioByArm[S1C_PANEL_ARM].ratio, expectedFullPool);

  // And it is NOT the number the rarefied frame would have produced.
  const rarefiedRatio = costDiversityRatio(
    rarefied.rows.filter((r) => r.armId === S1C_PANEL_ARM),
    { iterations: 10 },
  ).ratio;
  assert.notEqual(lane.costRatioByArm[S1C_PANEL_ARM].ratio, rarefiedRatio);
  assert.equal(lane.basis, "full-pool");
});

test("#182 / Appendix C item 3: handing the lane a RAREFIED frame is refused, not silently reported", () => {
  const rarefied = buildRarefiedFrame(pooledFrame(), {
    armIds: [S1C_REFERENCE_ARM, S1C_PANEL_ARM],
    threshold: POOL_THRESHOLD,
    metric: "distinct_k",
  });
  // The wiring mistake this guard exists to catch: the two frames are
  // structurally identical, so nothing downstream could tell the headline
  // metric had quietly changed estimand.
  assert.throws(() => computeS1cCostLane(rarefied), /refusing a RAREFIED frame/);
  assert.throws(() => computeS1cCostLane(rarefied), /full-pool/);
});

test("#182: an empty frame is refused rather than reported as a ratio", () => {
  assert.throws(
    () => computeS1cCostLane({ rows: [], armLevels: [] }),
    /frame.rows is empty/,
  );
});

// ── The CLI surface (AC: "its CLI prints a Pareto-frontier section and a
//    distinct_k-per-dollar section (ratio plus CI per arm)") ────────────────

test("#182: the CLI renders both sections, with a ratio AND a CI for every arm", () => {
  const { armHashes } = resolveS1cArmHashes(tallyOf(PRE_168_CONFIG_HASH, POST));
  const frame = applyArmHashRule(contaminatedFrame(), armHashes);
  const lane = computeS1cCostLane(frame, { iterations: 100 });
  const text = formatCostLane(lane).join("\n");

  assert.match(text, /=== cost\/diversity Pareto frontier/);
  assert.match(text, /=== distinct_k per dollar/);
  assert.match(text, /DESCRIPTIVE per amendment B6/);
  assert.match(text, /basis: full-pool/);
  for (const armId of frame.armLevels) {
    assert.match(text, new RegExp(`${armId}\\s+mean cost=\\$`), `${armId} missing from the frontier section`);
    assert.match(text, new RegExp(`${armId}\\s+ratio=[\\d.]+\\s+95% CI \\[[\\d.]+, [\\d.]+\\]`), `${armId} missing a ratio+CI`);
  }
  // The number a reader acts on must be the reported one, not a re-rounded
  // copy: the RICH ratio here is the post-hash-rule value.
  assert.match(text, new RegExp(`${S1C_PANEL_ARM}\\s+ratio=${RICH_RATIO_RULE_APPLIED.toFixed(3)}\\b`));
});
