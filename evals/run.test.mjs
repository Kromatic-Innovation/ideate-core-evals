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
import { parseArgs, main, formatSpendSummary } from "./run.mjs";
import { runnerPriceGrid } from "../lib/price.mjs";
import { JUDGE_MODELS } from "./judge/config.mjs";
import { judgeLegsFor } from "./judge/matrix.mjs";
import armsConfigJson from "../arms.config.json" with { type: "json" };

// A stand-in store: main()'s wiring is under test here, not ResultsStore
// itself (see lib/store.test.mjs for that) -- the spy runSpecFn below never
// touches it, so a bare object is sufficient and keeps these tests
// filesystem-free.
const FAKE_STORE = {};

// getInstalledEngineVersion() does a real `require.resolve("ideate-core")`
// -- CI runs bare `node --test` with no `npm ci`, so node_modules never
// exists there (see run.mjs's hermetic-CI comments). Stub the injectable
// seam so these main() tests stay filesystem/dependency-free like every
// other test in this repo. See evals/run.mjs main()'s deps destructuring.
const STUB_ENGINE_VERSION = () => "0.0.0-test";

function spyRunSpec() {
  const calls = [];
  const fn = async (spec, opts) => {
    calls.push({ spec, opts });
    return { summary: {}, account: { states: new Map() } };
  };
  fn.calls = calls;
  return fn;
}

/** Like spyRunSpec, but returns a caller-supplied `summary` -- for testing
 *  what main() does with runSpec's result, not just what it passes in. */
function spyRunSpecWithSummary(summary) {
  const calls = [];
  const fn = async (spec, opts) => {
    calls.push({ spec, opts });
    return { summary, account: { states: new Map() } };
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
  await main(["--dry-run", "--max-spend-anthropic", "5", "--max-spend-openai", "7"], { runSpecFn, store: FAKE_STORE, getEngineVersion: STUB_ENGINE_VERSION });

  assert.equal(runSpecFn.calls.length, 1);
  assert.deepEqual(runSpecFn.calls[0].opts.maxSpendByProviderUsd, { anthropic: 5, openai: 7 });
});

test("main() wires a REAL, RATE_TABLE-backed priceGrid (lib/price.mjs's runnerPriceGrid), not the interim estimator or nothing at all", async () => {
  const runSpecFn = spyRunSpec();
  await main(["--dry-run"], { runSpecFn, store: FAKE_STORE, getEngineVersion: STUB_ENGINE_VERSION });

  const { priceGrid } = runSpecFn.calls[0].opts;
  assert.equal(typeof priceGrid, "function", "priceGrid must be wired -- dropping it entirely must fail this test");

  // Compare the wired priceGrid's output against a freshly-constructed
  // runnerPriceGrid() on an identical planned cell -- proves main() is
  // calling the real pinned-rate-table pricer, not merely SOME function.
  // Also wired with judgeLegsFor (issue #63) -- main() passes the SAME
  // judge-selection logic evals/judge/matrix.mjs's real cross-judge matrix
  // uses, plus arms.config.json's own panel shape, so the pre-flight prices
  // planned judging too; dropping that wiring would make `actual` cheaper
  // than `expected` and fail this test.
  const [armId, arm] = Object.entries(armsConfigJson.arms)[0];
  const cell = { key: "probe-cell", armId };
  const legsFor = judgeLegsFor({ judgeModels: JUDGE_MODELS, panelConfig: armsConfigJson.panel });
  const expected = runnerPriceGrid(undefined, { judgeLegsFor: legsFor })([cell], armsConfigJson.arms, { batch: true });
  const actual = priceGrid([cell], armsConfigJson.arms, { batch: true });
  assert.deepEqual(actual, expected);

  // Pin the judge term ABSOLUTELY, not only by comparison to a second
  // `runnerPriceGrid(undefined, { judgeLegsFor: legsFor })` call that could
  // be constructed the same wrong way -- dropping `judgeLegsFor` from
  // main()'s real wiring must fail THIS assertion even if `expected` above
  // were (mistakenly) built the same way `actual` is. Arm A (the first arm
  // in arms.config.json) is all-Anthropic (claude-sonnet-5, solo), so its
  // projection carries an `openai` bucket ONLY if the judge roster's OpenAI
  // leg was actually wired in.
  const noJudge = runnerPriceGrid()([cell], armsConfigJson.arms, { batch: true });
  assert.ok(actual.usd > noJudge.usd, "main() must wire the judge legs into the pre-flight (issue #63) -- dropping judgeLegsFor makes this equal, not greater");
  assert.ok(actual.breakdown[0].byProvider.openai > 0, "the OpenAI judge leg must reach the projection even for arm A, an all-Anthropic arm");

  // BLOCKING 1 (fix round): the judge term must respect `batch` -- a
  // batch=false projection must NOT equal the batch=true projection.
  const actualNoBatch = priceGrid([cell], armsConfigJson.arms, { batch: false });
  assert.notEqual(actualNoBatch.usd, actual.usd, "dropping the batch discount from the judge term must fail this assertion");
  assert.ok(actualNoBatch.usd > actual.usd, "batch=false must project MORE than batch=true, for judging same as generation");
});

test("main() forwards --max-spend as maxSpendUsd and --arms/--briefs/--replicates through to runSpec", async () => {
  const runSpecFn = spyRunSpec();
  await main(["--dry-run", "--max-spend", "42", "--arms", "A,B", "--briefs", "b1", "--replicates", "2"], { runSpecFn, store: FAKE_STORE, getEngineVersion: STUB_ENGINE_VERSION });

  const { opts } = runSpecFn.calls[0];
  assert.equal(opts.maxSpendUsd, 42);
  assert.deepEqual(opts.armIds, ["A", "B"]);
  assert.deepEqual(opts.briefIds, ["b1"]);
  assert.equal(opts.replicates, 2);
  assert.equal(opts.dryRun, true);
  assert.equal(opts.store, FAKE_STORE, "the injected store reaches runSpec unchanged");
});

// ── issue #64 follow-up (PR #72 review, HIGH): main() must actually PRINT the
// spend summary -- before this, `await runSpecFn(spec, runSpecOpts);` never
// captured or used its result, so `grep 'summary\.' evals/run.mjs` returned
// nothing and an operator running the study's REGISTERED configuration
// (--max-spend-anthropic 300 --max-spend-openai 150, no global --max-spend)
// saw no spend figure at all. ──

test("main() prints an end-of-run spend summary via the injected log -- the ONLY place summary.* reaches the operator", async () => {
  // A realistic (non-dry-run-shaped) summary -- the spy stands in for
  // runSpec regardless of the --dry-run flag below (which is passed only to
  // skip main()'s ANTHROPIC_API_KEY/provider-construction requirement in
  // this hermetic test), so it is deliberately given the shape a REAL run
  // with an active per-provider ceiling would produce.
  const summary = {
    spendByProvider: { anthropic: 0.5 },
    cumulativeSpendByProvider: { anthropic: 1.5 },
    cumulativeSpendUsd: 1.75,
    cumulativeNonProviderSpendUsd: 0.25,
    cumulativeNonProviderModels: ["voyage-4-lite"],
  };
  const runSpecFn = spyRunSpecWithSummary(summary);
  const lines = [];
  await main(["--dry-run", "--max-spend-anthropic", "300"], {
    runSpecFn,
    store: FAKE_STORE,
    getEngineVersion: STUB_ENGINE_VERSION,
    log: (msg) => lines.push(msg),
  });

  const joined = lines.join("\n");
  assert.match(joined, /anthropic=\$0\.5000/, "this-invocation actual spend is printed");
  assert.match(joined, /anthropic=\$1\.5000/, "cumulative per-provider spend is printed");
  assert.match(joined, /excluded \(non-provider, e\.g\. embedder\): \$0\.2500 \(voyage-4-lite\)/, "the excluded non-provider (embedder) spend is printed BY NAME, not silently folded away");
  assert.match(joined, /TOTAL.*\$1\.7500/, "the cumulative grand total is printed");
});

test("main() prints an explicit 'NOT COMPUTED' line for cumulative spend, never a fabricated $0, when no ceiling was requested this invocation", async () => {
  const runSpecFn = spyRunSpec(); // returns { summary: {} } -- no ceiling, so cumulative fields are absent, matching the real null case
  const lines = [];
  await main(["--dry-run"], { runSpecFn, store: FAKE_STORE, getEngineVersion: STUB_ENGINE_VERSION, log: (msg) => lines.push(msg) });

  const joined = lines.join("\n");
  assert.match(joined, /NOT COMPUTED/);
  assert.doesNotMatch(joined, /TOTAL/, "no fabricated grand total when cumulative spend was never computed");
});

test("formatSpendSummary returns no lines for a dry-run result (no summary at all)", () => {
  assert.deepEqual(formatSpendSummary(undefined), []);
  assert.deepEqual(formatSpendSummary(null), []);
});
