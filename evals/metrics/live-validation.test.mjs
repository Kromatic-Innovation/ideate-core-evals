// live-validation.test.mjs — hermetic coverage for live-validation.mjs's
// gating rule, reached WITHOUT a live embedder. live-validation.mjs is an
// opt-in, billed, network CLI (see its header); it is importable here only
// because it now carries the `import.meta.url` main-guard, so importing it does
// NOT fire main() / a real Voyage run. This file makes no network call and
// imports no embedder — it drives the extracted pure reporter directly.
//
// Why this exists: before the extraction, live-validation.mjs re-derived its
// run-fail `ok` inline (two separate sites) while validation.test.mjs asserted
// `randomPoolVerdict().failed` — a field production ignored. The script's ACTUAL
// gating therefore had zero coverage and could drift from the tested rule on any
// edit. renderRandomPoolReport now makes the shipped rule (its `failed`) the
// SAME `verdict.failed` the tests assert; these cases pin the three floorVerdict
// branches — including INCONCLUSIVE, which no live run has ever exercised.
import { test } from "node:test";
import assert from "node:assert/strict";

import { renderRandomPoolReport } from "./live-validation.mjs";

test("renderRandomPoolReport: distinct_k passes and diversity clears the floor -> PASS/PASS, run does not fail", () => {
  const { lines, verdict, failed } = renderRandomPoolReport({
    distinctK: 28,
    diversity: 0.75,
    poolSize: 30,
    datHigh: 0.6,
    orderingHolds: true,
  });
  assert.equal(verdict.floorVerdict, "pass");
  assert.equal(failed, false);
  assert.equal(failed, verdict.failed, "the run-fail decision IS verdict.failed");
  assert.equal(lines.length, 2);
  assert.ok(lines.every((l) => l.level === "log"));
  assert.match(lines[0].text, /PASS: random pool stays overwhelmingly distinct/);
  assert.match(lines[1].text, /PASS: random pool diversity clears the live DAT-high/);
});

test("renderRandomPoolReport: ordering holds but diversity is below the floor -> floor FAIL sets failed", () => {
  const { lines, verdict, failed } = renderRandomPoolReport({
    distinctK: 28,
    diversity: 0.5,
    poolSize: 30,
    datHigh: 0.6,
    orderingHolds: true,
  });
  assert.equal(verdict.floorVerdict, "fail");
  assert.equal(failed, true);
  assert.equal(lines[1].level, "error");
  assert.match(lines[1].text, /FAIL: random pool diversity .* did not clear the live DAT-high floor/);
});

test("renderRandomPoolReport: ordering broken -> INCONCLUSIVE floor, printed but never fails the run on its own", () => {
  const { lines, verdict, failed } = renderRandomPoolReport({
    distinctK: 28,
    diversity: 0.4, // below the (uncalibrated) floor, yet must NOT fail
    poolSize: 30,
    datHigh: 0.6,
    orderingHolds: false,
  });
  assert.equal(verdict.floorVerdict, "inconclusive");
  assert.equal(failed, false, "an uncalibrated floor must not fail the run — the DAT-ordering FAIL does that");
  assert.equal(lines[1].level, "log");
  assert.match(lines[1].text, /INCONCLUSIVE: diversity=.* not judged against the live DAT-high/);
});

test("renderRandomPoolReport: INCONCLUSIVE even when diversity is ABOVE the broken floor", () => {
  const { verdict, failed } = renderRandomPoolReport({
    distinctK: 28,
    diversity: 0.9,
    poolSize: 30,
    datHigh: 0.6,
    orderingHolds: false,
  });
  assert.equal(verdict.floorVerdict, "inconclusive");
  assert.equal(failed, false);
});

test("renderRandomPoolReport: distinct_k below the 90% bound fails the run regardless of the floor verdict", () => {
  const { lines, verdict, failed } = renderRandomPoolReport({
    distinctK: 25, // Math.ceil(30 * 0.9) = 27, so 25 fails
    diversity: 0.9,
    poolSize: 30,
    datHigh: 0.6,
    orderingHolds: true,
  });
  assert.equal(verdict.distinctKPass, false);
  assert.equal(failed, true);
  assert.equal(lines[0].level, "error");
  assert.match(lines[0].text, /FAIL: random pool did not stay distinct enough/);
});

test("renderRandomPoolReport: floorVerdict takes all three values across inputs (pass, fail, inconclusive)", () => {
  const seen = new Set(
    [
      { distinctK: 28, diversity: 0.75, poolSize: 30, datHigh: 0.6, orderingHolds: true }, // pass
      { distinctK: 28, diversity: 0.5, poolSize: 30, datHigh: 0.6, orderingHolds: true }, // fail
      { distinctK: 28, diversity: 0.4, poolSize: 30, datHigh: 0.6, orderingHolds: false }, // inconclusive
    ].map((args) => renderRandomPoolReport(args).verdict.floorVerdict),
  );
  assert.deepEqual([...seen].sort(), ["fail", "inconclusive", "pass"]);
});
