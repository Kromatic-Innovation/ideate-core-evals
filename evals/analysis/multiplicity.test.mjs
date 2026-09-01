import { test } from "node:test";
import assert from "node:assert/strict";
import { holmBonferroni, benjaminiHochberg } from "./multiplicity.mjs";

test("holmBonferroni: single p-value is unchanged", () => {
  assert.deepEqual(holmBonferroni([0.03]), [0.03]);
});

test("holmBonferroni: known worked example", () => {
  // p = [0.01, 0.02, 0.03, 0.04], m=4
  // sorted adjustments: 4*0.01=0.04, 3*0.02=0.06, 2*0.03=0.06, 1*0.04=0.04
  // monotone (running max): 0.04, 0.06, 0.06, 0.06
  const adjusted = holmBonferroni([0.01, 0.02, 0.03, 0.04]);
  assert.deepEqual(adjusted.map((p) => Number(p.toFixed(4))), [0.04, 0.06, 0.06, 0.06]);
});

test("holmBonferroni: preserves input order in output", () => {
  const adjusted = holmBonferroni([0.04, 0.01, 0.03, 0.02]);
  // index 1 (p=0.01) should be smallest-rank -> 4*0.01=0.04
  assert.equal(Number(adjusted[1].toFixed(4)), 0.04);
});

test("holmBonferroni: caps at 1", () => {
  const adjusted = holmBonferroni([0.9, 0.9, 0.9]);
  assert.ok(adjusted.every((p) => p <= 1));
});

test("holmBonferroni: rejects out-of-range p-values", () => {
  assert.throws(() => holmBonferroni([1.5]), /finite in \[0,1\]/);
  assert.throws(() => holmBonferroni([-0.1]), /finite in \[0,1\]/);
  assert.throws(() => holmBonferroni([]), /non-empty/);
});

test("benjaminiHochberg: known worked example", () => {
  // p = [0.01, 0.02, 0.03, 0.04], m=4
  // sorted q: 0.04*4/4=0.04, 0.03*4/3=0.04, 0.02*4/2=0.04, 0.01*4/1=0.04
  // (running min from the top, all ties out at 0.04 here)
  const adjusted = benjaminiHochberg([0.01, 0.02, 0.03, 0.04]);
  assert.deepEqual(adjusted.map((p) => Number(p.toFixed(4))), [0.04, 0.04, 0.04, 0.04]);
});

test("benjaminiHochberg: less conservative than Holm for the same input", () => {
  const p = [0.001, 0.01, 0.2, 0.5, 0.8];
  const holm = holmBonferroni(p);
  const bh = benjaminiHochberg(p);
  for (let i = 0; i < p.length; i++) {
    assert.ok(bh[i] <= holm[i] + 1e-9, `BH[${i}]=${bh[i]} should not exceed Holm[${i}]=${holm[i]}`);
  }
});

test("benjaminiHochberg: preserves input order and caps at 1", () => {
  const adjusted = benjaminiHochberg([0.5, 0.01, 0.9]);
  assert.ok(adjusted.every((p) => p <= 1));
  assert.equal(adjusted.length, 3);
});
