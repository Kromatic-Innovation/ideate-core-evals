// calibration.test.mjs — issue #169.
//
// The projection `--max-spend` is enforced against used to come from a
// two-row constant table with no model of `effort` and no memory of what an
// arm had already cost. These tests pin the fit that replaces it.
//
// Fixtures are hand-built stores rather than a real results directory: the
// live stores (results-study1c/ and friends) are gitignored operator data, so
// a test calibrated against them would not reproduce anywhere else. The
// numbers below are shaped after the real one-factor screening arms
// (docs/PREREGISTRATION.md Appendix F item 2) but are not those measurements.

import { test } from "node:test";
import assert from "node:assert/strict";

import { calibrateFromStore, measureArmTokens, armEffortLevel, DEFAULT_MIN_CELLS_PER_ARM, formatCalibration } from "./calibration.mjs";
import { EFFORT_OUTPUT_MULTIPLIER } from "./price.mjs";

/**
 * A minimal ResultsStore stand-in: `list()` yields index entries, `get(key)`
 * yields the body. Only the two methods measureArmTokens actually calls.
 */
function fakeStore(cells) {
  const bodies = new Map();
  const entries = [];
  for (const c of cells) {
    const key = `arm=${c.armId}|brief=${c.briefId || "b1"}|rep=${c.rep || 0}|cfg=${c.cfg || "abc"}`;
    entries.push({ key, armId: c.armId, state: c.state || "completed" });
    bodies.set(key, {
      costRows: [
        {
          cellKey: key,
          tokens_by_model: { [c.model || "claude-sonnet-5"]: { input_tokens: c.in, output_tokens: c.out } },
        },
        // The embedder row every real cell carries. Must NOT reach the fit:
        // voyage tokens are not what a generation slot's rate prices.
        { cellKey: key, model: "voyage-4-lite", input_tokens: 99999 },
      ],
    });
  }
  return { list: () => entries, get: (k) => bodies.get(k) };
}

function cells(armId, n, { in: i, out, model } = {}) {
  return Array.from({ length: n }, (_, k) => ({ armId, briefId: `b${k}`, in: i, out, model }));
}

const SOLO = (effort) => ({ mode: "solo", slots: [{ persona: "solo", model: "claude-sonnet-5", effort }] });

test("armEffortLevel: homogeneous arms report their level; a mixed arm reports null", () => {
  assert.equal(armEffortLevel(SOLO("max")), "max");
  assert.equal(armEffortLevel(SOLO(undefined)), "high", "an effort-free slot IS high -- Appendix F item 5's registered equivalence");
  assert.equal(
    armEffortLevel({ mode: "panel", slots: [{ model: "m", effort: "max" }, { model: "m", effort: "low" }] }),
    null,
    "S1C-RICH's shape: costRows are per-MODEL, so a mixed-effort arm cannot be attributed to one level",
  );
  assert.equal(armEffortLevel({ slots: [] }), null);
});

test("measureArmTokens: means per completed cell, embedder rows excluded, non-completed rows excluded", () => {
  const store = fakeStore([
    { armId: "X", in: 100, out: 1000 },
    { armId: "X", in: 300, out: 3000 },
    { armId: "X", in: 200, out: 2000, state: "failed" },
  ]);
  const m = measureArmTokens(store);
  assert.equal(m.get("X").n, 2, "the failed cell is not a measurement of what a completed cell costs");
  assert.equal(m.get("X").inputTokens, 200);
  assert.equal(m.get("X").outputTokens, 2000, "99999 embedder input tokens per cell never entered the mean");
});

test("measureArmTokens: a store that cannot be enumerated yields no fit rather than throwing", () => {
  // Deliberate asymmetry with spendToDate, which DOES throw on an unreadable
  // ledger. This is a projection refinement; that is the enforcement path.
  assert.equal(measureArmTokens({}).size, 0);
});

test("tier 1: an arm with enough completed cells is fitted from the store, and a thin one is not", () => {
  const store = fakeStore([...cells("FAT", DEFAULT_MIN_CELLS_PER_ARM, { in: 400, out: 5000 }), ...cells("THIN", DEFAULT_MIN_CELLS_PER_ARM - 1, { in: 400, out: 5000 })]);
  const armsConfig = { arms: { FAT: SOLO("high"), THIN: SOLO("high") } };
  const c = calibrateFromStore(store, armsConfig);
  assert.equal(c.perArm.FAT.outputTokens, 5000);
  assert.equal(c.perArm.FAT.n, DEFAULT_MIN_CELLS_PER_ARM);
  assert.ok(!("THIN" in c.perArm), "below the threshold an arm is NOT fitted -- a mean of two cells is not a model");
  assert.equal(c.basis.armCells.THIN, DEFAULT_MIN_CELLS_PER_ARM - 1, "but its cell count is still reported, so the thinness is visible");
});

test("tier 2: effort multipliers are FITTED from the store's effort-homogeneous arms, anchored at high = 1.0", () => {
  // Shaped after S1-ELOW / S1-C0 / S1-EMAX: one factor, same model, same N.
  const store = fakeStore([
    ...cells("ELOW", 12, { in: 360, out: 1300 }),
    ...cells("C0", 12, { in: 360, out: 2600 }),
    ...cells("EMAX", 12, { in: 360, out: 13000 }),
  ]);
  const armsConfig = { arms: { ELOW: SOLO("low"), C0: SOLO("high"), EMAX: SOLO("max") } };
  const c = calibrateFromStore(store, armsConfig);

  assert.equal(c.effortSource, "store");
  assert.equal(c.effortMultipliers.high, 1.0);
  assert.equal(c.effortMultipliers.low, 0.5, "1300 / 2600");
  assert.equal(c.effortMultipliers.max, 5.0, "13000 / 2600 -- the fit, not the static 6.16");
  assert.deepEqual(c.warnings, [], "a complete fit warns about nothing");
});

test("tier 2: a mixed-effort arm is EXCLUDED from the effort fit -- its tokens cannot be attributed to one level", () => {
  const store = fakeStore([
    ...cells("C0", 12, { in: 360, out: 2600 }),
    ...cells("EMAX", 12, { in: 360, out: 13000 }),
    // A huge mixed-effort arm. If it leaked into the `high` bucket (or any
    // other), it would drag the baseline and every ratio with it.
    ...cells("RICH", 100, { in: 20000, out: 57000 }),
  ]);
  const armsConfig = {
    arms: {
      C0: SOLO("high"),
      EMAX: SOLO("max"),
      RICH: { mode: "panel", slots: [{ model: "claude-sonnet-5", effort: "max" }, { model: "claude-sonnet-5", effort: "low" }] },
    },
  };
  const c = calibrateFromStore(store, armsConfig);
  assert.equal(c.effortMultipliers.max, 5.0, "unchanged by the 100-cell mixed arm");
  assert.deepEqual(c.basis.effortPerSlotOut.high.arms, ["C0"], "RICH is in no effort bucket at all");
  assert.ok(c.perArm.RICH, "it is still tier-1 fittable, which needs no attribution");
});

test("a level the store cannot support keeps its STATIC multiplier and says so -- never a silent 1.0", () => {
  // The original defect's exact shape: an unmodeled effort level priced at the
  // base rate. `low` is absent from the store entirely here.
  const store = fakeStore([...cells("C0", 12, { in: 360, out: 2600 }), ...cells("EMAX", 12, { in: 360, out: 13000 })]);
  const armsConfig = { arms: { C0: SOLO("high"), EMAX: SOLO("max") } };
  const c = calibrateFromStore(store, armsConfig);

  assert.equal(c.effortMultipliers.low, EFFORT_OUTPUT_MULTIPLIER.low);
  assert.notEqual(c.effortMultipliers.low, 1.0, "the whole point: an unfittable level must not fall through to the base rate");
  assert.ok(
    c.warnings.some((w) => w.includes("effort 'low'") && w.includes("no completed cells")),
    "and the operator is told which level stayed static",
  );
});

test("a thin `high` baseline aborts the whole effort fit and falls back to static, loudly", () => {
  const store = fakeStore([...cells("C0", 2, { in: 360, out: 2600 }), ...cells("EMAX", 40, { in: 360, out: 13000 })]);
  const armsConfig = { arms: { C0: SOLO("high"), EMAX: SOLO("max") } };
  const c = calibrateFromStore(store, armsConfig);

  assert.equal(c.effortSource, "static");
  assert.deepEqual(c.effortMultipliers, { ...EFFORT_OUTPUT_MULTIPLIER });
  assert.ok(c.warnings.some((w) => w.includes("STATIC")), "the fallback is announced, not silent");
});

test("a thin OFF-BASELINE level keeps its static multiplier while the rest of the fit proceeds", () => {
  const store = fakeStore([...cells("C0", 12, { in: 360, out: 2600 }), ...cells("EMAX", 2, { in: 360, out: 13000 })]);
  const armsConfig = { arms: { C0: SOLO("high"), EMAX: SOLO("max") } };
  const c = calibrateFromStore(store, armsConfig);

  assert.equal(c.effortSource, "store");
  assert.equal(c.effortMultipliers.max, EFFORT_OUTPUT_MULTIPLIER.max, "2 cells is not a fit");
  assert.ok(c.warnings.some((w) => w.includes("effort 'max'") && w.includes("only 2")));
});

test("the effort fit is PER SLOT, so a panel arm and a solo arm pool at the same level", () => {
  // 5-slot panel at 13,000 output tokens/cell is 2,600 per slot -- exactly the
  // solo arm's per-cell figure. Without the per-slot normalisation the panel
  // would read as a 5x effort effect that is really just slot count.
  const store = fakeStore([...cells("SOLOHI", 12, { in: 360, out: 2600 }), ...cells("PANELHI", 12, { in: 360, out: 13000 })]);
  const armsConfig = {
    arms: {
      SOLOHI: SOLO("high"),
      PANELHI: { mode: "panel", slots: Array.from({ length: 5 }, () => ({ model: "claude-sonnet-5", effort: "high" })) },
    },
  };
  const c = calibrateFromStore(store, armsConfig);
  assert.equal(c.basis.effortPerSlotOut.high.perSlotOut, 2600);
});

test("formatCalibration reports the basis -- which arms, how many cells, and where the multipliers came from", () => {
  const store = fakeStore(cells("FAT", 5, { in: 400, out: 5000 }));
  const c = calibrateFromStore(store, { arms: { FAT: SOLO("high") } });
  const lines = formatCalibration(c).join("\n");
  assert.match(lines, /FAT: 400 in \/ 5000 out tokens per cell, mean of 5 completed cell\(s\)/);
  assert.match(lines, /effort output multipliers \(static\)/);
});

test("an empty store produces no fit at all, and says that too", () => {
  const c = calibrateFromStore(fakeStore([]), { arms: { A: SOLO("high") } });
  assert.deepEqual(c.perArm, {});
  assert.match(formatCalibration(c).join("\n"), /per-arm token fit: NONE/);
});

test("calibrateFromStore requires an armsConfig -- an effort fit without arm definitions is not possible", () => {
  assert.throws(() => calibrateFromStore(fakeStore([]), null), /armsConfig/);
});
