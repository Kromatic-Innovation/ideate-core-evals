// Tests for run.mjs's argv parsing. Deliberately narrow in scope -- the
// actual planning/accounting/pricing logic is tested exhaustively against
// evals/harness/runner.mjs directly (see evals/harness/runner.test.mjs and
// integration.test.mjs). This file exists because "thin CLI glue" is not the
// same as "no logic worth testing": a malformed --max-spend value silently
// becoming NaN would disable the entire budget-safety gate (see the fix this
// test guards -- Number(undefined)/Number("abc") both yield NaN, and NaN
// compares false against every projection, so an unvalidated NaN ceiling lets
// every cell through unthrottled instead of erroring).
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseArgs, main } from "./run.mjs";
import { runnerPriceGrid } from "../lib/price.mjs";
import armsConfigJson from "../arms.config.json" with { type: "json" };

// A stand-in store: main()'s wiring is under test here, not ResultsStore
// itself (see lib/store.test.mjs for that) -- the spy runSpecFn below never
// touches it, so a bare object is sufficient and keeps these tests
// filesystem-free.
const FAKE_STORE = {};

function spyRunSpec() {
  const calls = [];
  const fn = async (spec, opts) => {
    calls.push({ spec, opts });
    return { summary: {}, account: { states: new Map() } };
  };
  fn.calls = calls;
  return fn;
}

test("parseArgs accepts a well-formed set of flags", () => {
  const args = parseArgs(["--dry-run", "--arms", "A,B", "--briefs", "b1,b2", "--replicates", "3", "--max-spend", "50"]);
  assert.equal(args.dryRun, true);
  assert.deepEqual(args.arms, ["A", "B"]);
  assert.deepEqual(args.briefs, ["b1", "b2"]);
  assert.equal(args.replicates, 3);
  assert.equal(args.maxSpendUsd, 50);
});

test("parseArgs rejects a missing --max-spend value instead of silently producing NaN", () => {
  assert.throws(() => parseArgs(["--max-spend"]), /--max-spend requires a numeric argument/);
});

test("parseArgs rejects a non-numeric --max-spend value instead of silently producing NaN", () => {
  assert.throws(() => parseArgs(["--max-spend", "not-a-number"]), /--max-spend requires a numeric argument/);
});

test("parseArgs rejects a non-numeric --replicates and --phase the same way", () => {
  assert.throws(() => parseArgs(["--replicates", "abc"]), /--replicates requires a numeric argument/);
  assert.throws(() => parseArgs(["--phase", "abc"]), /--phase requires a numeric argument/);
});

test("parseArgs accepts --max-spend 0 as a legitimate (extreme) ceiling, not a missing value", () => {
  const args = parseArgs(["--max-spend", "0"]);
  assert.equal(args.maxSpendUsd, 0);
});

test("parseArgs rejects an unrecognized flag", () => {
  assert.throws(() => parseArgs(["--not-a-real-flag"]), /unrecognized flag/);
});

test("parseArgs supports --no-batch as a boolean flag with no value", () => {
  const args = parseArgs(["--no-batch"]);
  assert.equal(args.noBatch, true);
});

// ── issue #62 BLOCKER 2: exercise main()'s WIRING, not just parseArgs ───────
// The mutation table from the QA review found `main()` itself entirely
// untested -- dropping `maxSpendByProviderUsd` or `priceGrid` from its
// runSpec call left every existing test green. --dry-run keeps these
// filesystem/network-free (no ANTHROPIC_API_KEY needed, no real store).

test("main() passes --max-spend-anthropic/--max-spend-openai through to runSpec as maxSpendByProviderUsd -- dropping this wiring must fail this test", async () => {
  const runSpecFn = spyRunSpec();
  await main(["--dry-run", "--max-spend-anthropic", "5", "--max-spend-openai", "7"], { runSpecFn, store: FAKE_STORE });

  assert.equal(runSpecFn.calls.length, 1);
  assert.deepEqual(runSpecFn.calls[0].opts.maxSpendByProviderUsd, { anthropic: 5, openai: 7 });
});

test("main() wires a REAL, RATE_TABLE-backed priceGrid (lib/price.mjs's runnerPriceGrid), not the interim estimator or nothing at all", async () => {
  const runSpecFn = spyRunSpec();
  await main(["--dry-run"], { runSpecFn, store: FAKE_STORE });

  const { priceGrid } = runSpecFn.calls[0].opts;
  assert.equal(typeof priceGrid, "function", "priceGrid must be wired -- dropping it entirely must fail this test");

  // Compare the wired priceGrid's output against a freshly-constructed
  // runnerPriceGrid() on an identical planned cell -- proves main() is
  // calling the real pinned-rate-table pricer, not merely SOME function.
  const [armId, arm] = Object.entries(armsConfigJson.arms)[0];
  const cell = { key: "probe-cell", armId };
  const expected = runnerPriceGrid()([cell], armsConfigJson.arms, { batch: true });
  const actual = priceGrid([cell], armsConfigJson.arms, { batch: true });
  assert.deepEqual(actual, expected);
});

test("main() forwards --max-spend as maxSpendUsd and --arms/--briefs/--replicates through to runSpec", async () => {
  const runSpecFn = spyRunSpec();
  await main(["--dry-run", "--max-spend", "42", "--arms", "A,B", "--briefs", "b1", "--replicates", "2"], { runSpecFn, store: FAKE_STORE });

  const { opts } = runSpecFn.calls[0];
  assert.equal(opts.maxSpendUsd, 42);
  assert.deepEqual(opts.armIds, ["A", "B"]);
  assert.deepEqual(opts.briefIds, ["b1"]);
  assert.equal(opts.replicates, 2);
  assert.equal(opts.dryRun, true);
  assert.equal(opts.store, FAKE_STORE, "the injected store reaches runSpec unchanged");
});
