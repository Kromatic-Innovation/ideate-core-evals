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
import { parseArgs } from "./run.mjs";

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
