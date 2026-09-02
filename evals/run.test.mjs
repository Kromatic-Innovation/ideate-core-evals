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
import { parseArgs, main, formatSpendSummary, formatPhase0Report } from "./run.mjs";
import { runnerPriceGrid } from "../lib/price.mjs";
import { JUDGE_MODELS } from "./judge/config.mjs";
import { judgeLegsFor } from "./judge/matrix.mjs";
import { AnthropicJudgeProvider, OpenAIJudgeProvider } from "./judge/score.mjs";
import { AnthropicBatchProvider, DEFAULT_MAX_POLL_MS } from "./harness/provider.mjs";
import { promptTemplateHash } from "./harness/prompts.mjs";
import { configHash } from "../lib/manifest.mjs";
import { createHash } from "node:crypto";
import { CORPUS } from "./corpus/index.mjs";
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

// ── issue #92: the batch poll ceiling is settable from the CLI ─────────────

test("parseArgs accepts --max-poll-minutes and rejects the values that would break the poll loop", () => {
  assert.equal(parseArgs(["--max-poll-minutes", "90"]).maxPollMinutes, 90);
  // NaN is the dangerous one: `Date.now() > NaN` is always false, so a NaN
  // ceiling would make the poll loop spin forever rather than expire.
  assert.throws(() => parseArgs(["--max-poll-minutes", "abc"]), /--max-poll-minutes requires a numeric argument/);
  assert.throws(() => parseArgs(["--max-poll-minutes"]), /--max-poll-minutes requires a numeric argument/);
  assert.throws(() => parseArgs(["--max-poll-minutes", "0"]), /must be greater than 0/);
  assert.throws(() => parseArgs(["--max-poll-minutes", "-5"]), /must be greater than 0/);
});

test("main() wires --max-poll-minutes through to the real AnthropicBatchProvider, and the DEFAULT is the provider's 60-minute constant when the flag is absent (issue #92)", async (t) => {
  const priorKey = process.env.ANTHROPIC_API_KEY;
  const priorVoyageKey = process.env.VOYAGE_API_KEY;
  process.env.ANTHROPIC_API_KEY = "test-key-not-real";
  process.env.VOYAGE_API_KEY = "test-voyage-key-not-real";
  t.after(() => {
    if (priorKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = priorKey;
    if (priorVoyageKey === undefined) delete process.env.VOYAGE_API_KEY;
    else process.env.VOYAGE_API_KEY = priorVoyageKey;
  });

  // Not --dry-run: dry-run constructs no provider at all, so the wiring under
  // test would not exist. runSpecFn is a spy, so nothing reaches the network.
  const withFlag = spyRunSpec();
  await main(["--max-spend", "999", "--max-poll-minutes", "90"], { runSpecFn: withFlag, store: FAKE_STORE, getEngineVersion: STUB_ENGINE_VERSION });
  assert.ok(withFlag.calls[0].opts.provider instanceof AnthropicBatchProvider);
  assert.equal(withFlag.calls[0].opts.provider.maxPollMs, 90 * 60 * 1000, "minutes on the CLI, milliseconds on the provider");

  const noFlag = spyRunSpec();
  await main(["--max-spend", "999"], { runSpecFn: noFlag, store: FAKE_STORE, getEngineVersion: STUB_ENGINE_VERSION });
  assert.equal(noFlag.calls[0].opts.provider.maxPollMs, DEFAULT_MAX_POLL_MS, "an unset flag falls through to the provider's own default, not a second copy of the number in run.mjs");
});

// ── issue #99: promptHash is a real hash in the SPEC run.mjs builds ─────────
//
// evals/harness/reply-recovery.test.mjs already pins that promptTemplateHash()
// itself reacts to a template edit. That is NOT the regression this guards:
// the defect was a placeholder in run.mjs, so the test has to cover run.mjs's
// own seam -- reading spec.config off a main() invocation. A test that only
// re-checked prompts.mjs would stay green while run.mjs regressed.

test("issue #99: main() sets spec.config.promptHash from promptTemplateHash(), never the literal 'unpinned'", async () => {
  const runSpecFn = spyRunSpec();
  await main(["--dry-run"], { runSpecFn, store: FAKE_STORE, getEngineVersion: STUB_ENGINE_VERSION });

  const { spec } = runSpecFn.calls[0];
  assert.notEqual(spec.config.promptHash, "unpinned", "a constant can never change, so a prompt edit would be invisible to the staleness machinery");
  assert.equal(spec.config.promptHash, promptTemplateHash(), "and it must be THE generation-prompt hash, not some other stable-looking string");
  assert.match(spec.config.promptHash, /^[0-9a-f]{12}$/);
});

test("issue #99: editing a generation prompt template moves the configHash of the spec run.mjs builds -- the actual regression guard", async () => {
  const runSpecFn = spyRunSpec();
  await main(["--dry-run"], { runSpecFn, store: FAKE_STORE, getEngineVersion: STUB_ENGINE_VERSION });
  const { spec } = runSpecFn.calls[0];

  // Recompute promptTemplateHash()'s documented payload with ONE template
  // edited (an ESM export cannot be mutated in place), then feed that hash
  // back through the config run.mjs actually built. If run.mjs ever reverts to
  // a placeholder, spec.config.promptHash stops depending on the templates and
  // these two hashes collapse to equal.
  const prompts = await import("./harness/prompts.mjs");
  const probe = {
    context: { slug: "hash-probe", brief: "HASH PROBE BRIEF" },
    persona: "hash_probe_persona",
    stance: "HASH PROBE STANCE",
    ideasPerAgent: 7,
    seeds: [{ text: "hash probe seed" }],
    buildOnDirective: "HASH PROBE DIRECTIVE",
  };
  const payload = {
    round1: prompts.buildRound1Prompt(probe),
    round2: prompts.buildRound2Prompt(probe),
    round1Defaults: prompts.buildRound1Prompt(),
    round2Defaults: prompts.buildRound2Prompt(),
    tokensPerIdea: prompts.TOKENS_PER_IDEA,
    maxTokensHeadroom: prompts.MAX_TOKENS_HEADROOM,
    legacyMaxTokens: prompts.LEGACY_MAX_TOKENS,
    salvageVersion: prompts.SALVAGE_VERSION,
  };
  const hashOf = (o) => createHash("sha256").update(JSON.stringify(o)).digest("hex").slice(0, 12);
  assert.equal(hashOf(payload), spec.config.promptHash, "sanity: the spec's promptHash IS this payload's hash");

  const editedTemplateHash = hashOf({ ...payload, round1: `${payload.round1}\nOne extra instruction line.` });
  assert.notEqual(
    configHash({ ...spec.config, promptHash: editedTemplateHash }),
    configHash(spec.config),
    "a one-line edit to a generation prompt must move configHash -- otherwise cells from before and after the edit share a cellKey and are pooled as comparable data",
  );

  // And the placeholder case, stated directly: pinning the hash is what makes
  // the #8 smoke-study cells stale. That is the intended, priced consequence.
  assert.notEqual(configHash({ ...spec.config, promptHash: "unpinned" }), configHash(spec.config));
});

test("--phase 0 REFUSES --max-poll-minutes rather than silently dropping it (issue #92)", async () => {
  await assert.rejects(() => main(["--phase", "0", "--max-poll-minutes", "90"], { store: FAKE_STORE }), /--phase 0 does not accept .*--max-poll-minutes/);
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

// ── issue #68: judging must be wired into a REAL CLI invocation ────────────
// The verification bar calls out exactly this failure shape from tonight's
// PRs: "a wiring assertion that passed even when the wiring was removed".
// This asserts main() passes a REAL AnthropicJudgeProvider instance (not
// just "some object"), the registered JUDGE_MODELS roster, and the real
// CORPUS through to runSpec -- delete any one of the three lines that wire
// them in evals/run.mjs and this test must fail.

test("main() wires a REAL AnthropicJudgeProvider + OpenAIJudgeProvider + the registered JUDGE_MODELS roster + CORPUS through to runSpec (issue #68 anthropic leg, #77 openai leg) -- judging is reachable from a real invocation, not only from a test", async (t) => {
  const runSpecFn = spyRunSpec();
  const priorKey = process.env.ANTHROPIC_API_KEY;
  const priorOpenaiKey = process.env.OPENAI_API_KEY;
  const priorVoyageKey = process.env.VOYAGE_API_KEY;
  process.env.ANTHROPIC_API_KEY = "test-key-not-real";
  process.env.OPENAI_API_KEY = "test-openai-key-not-real";
  // issue #85: a genuine (non-dry-run) invocation now also constructs a real
  // embedder, which requires VOYAGE_API_KEY -- set here so this test still
  // exercises the judge-wiring assertions below without tripping that
  // unrelated pre-flight guard.
  process.env.VOYAGE_API_KEY = "test-voyage-key-not-real";
  t.after(() => {
    if (priorKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = priorKey;
    if (priorOpenaiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = priorOpenaiKey;
    if (priorVoyageKey === undefined) delete process.env.VOYAGE_API_KEY;
    else process.env.VOYAGE_API_KEY = priorVoyageKey;
  });

  // Deliberately NOT --dry-run: dry-run's early return in runSpec() never
  // reaches the judging pass, so main() must wire real judge providers for a
  // GENUINE invocation regardless -- runSpecFn is a spy, so the network is
  // never actually touched even though main() takes the real-run branch.
  await main(["--max-spend", "999"], { runSpecFn, store: FAKE_STORE, getEngineVersion: STUB_ENGINE_VERSION });

  const { opts } = runSpecFn.calls[0];
  assert.deepEqual(opts.judgeModels, JUDGE_MODELS, "the registered judge-model roster (evals/judge/config.mjs) reaches runSpec unchanged");
  assert.deepEqual(opts.corpus, CORPUS, "the real CORPUS (brief text) reaches runSpec, so a pool's judge call has something to score against");
  assert.ok(opts.judgeProviders && opts.judgeProviders.anthropic instanceof AnthropicJudgeProvider, "a REAL AnthropicJudgeProvider instance is wired for the anthropic leg -- not a stub, not omitted");
  assert.ok(opts.judgeProviders && opts.judgeProviders.openai instanceof OpenAIJudgeProvider, "a REAL OpenAIJudgeProvider instance is wired for the openai leg -- not a stub, not omitted");
  // Each leg must be constructed with ITS OWN provider's key -- not the other
  // provider's key, and not a silently-dropped empty string. Without this, a
  // mutation swapping ANTHROPIC_API_KEY<->OPENAI_API_KEY (or blanking either)
  // at the construction site in run.mjs is invisible to an instanceof-only check.
  assert.equal(opts.judgeProviders.anthropic.apiKey, "test-key-not-real", "the anthropic judge leg must be constructed with ANTHROPIC_API_KEY, not the openai key or blank");
  assert.equal(opts.judgeProviders.openai.apiKey, "test-openai-key-not-real", "the openai judge leg must be constructed with OPENAI_API_KEY, not the anthropic key or blank");
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

// ── --phase 0 wiring (issue #48) ────────────────────────────────────────────
// The actual controls logic lives in evals/metrics/phase0.mjs and is tested
// there (phase0.test.mjs); these tests exercise main()'s WIRING of it --
// same rationale as the --max-spend-anthropic/priceGrid tests above (issue
// #62 BLOCKER 2): dropping the apiKey/store forwarding, or the VOYAGE_API_KEY
// pre-flight check, would leave every OTHER test here green.

function spyRunPhase0(result) {
  const calls = [];
  const fn = async (deps) => {
    calls.push(deps);
    return result;
  };
  fn.calls = calls;
  return fn;
}

const PASSING_PHASE0_SUMMARY = {
  dat: { low: 0.1, average: 0.2, high: 0.3, orderingHolds: true, margin: 0.2 },
  controls: {
    duplicate: { distinctK: 1, diversity: 0, collapseRate: 1 },
    random: { distinctK: 30, diversity: 0.5, collapseRate: 0 },
  },
  duplicatePassed: true,
  dupVerdict: { distinctKPass: true, diversityPass: true, passed: true },
  randomVerdict: { distinctKPass: true, floorVerdict: "pass", failed: false },
  allPassed: true,
  embedderId: "voyage-4-lite",
  totalTokens: 42,
  threshold: 0.23141118234233987,
  runId: "2026-09-02T01:43:26.641Z-abcd1234",
  datKey: "phase0/dat-replication@2026-09-02T01:43:26.641Z-abcd1234",
  controlsKey: "phase0/negative-controls@2026-09-02T01:43:26.641Z-abcd1234",
  gitSha: "deadbeef",
};

test("main() --phase 0 requires VOYAGE_API_KEY and never invents one", async () => {
  const prior = process.env.VOYAGE_API_KEY;
  delete process.env.VOYAGE_API_KEY;
  try {
    const runPhase0Fn = spyRunPhase0(PASSING_PHASE0_SUMMARY);
    await assert.rejects(
      () => main(["--phase", "0"], { runPhase0Fn, getEngineVersion: STUB_ENGINE_VERSION }),
      /VOYAGE_API_KEY is not set/,
    );
    assert.equal(runPhase0Fn.calls.length, 0, "must fail BEFORE calling runPhase0 -- never a network call with no key");
  } finally {
    if (prior !== undefined) process.env.VOYAGE_API_KEY = prior;
  }
});

test("main() rejects --dry-run combined with --phase 0", async () => {
  const prior = process.env.VOYAGE_API_KEY;
  process.env.VOYAGE_API_KEY = "test-key";
  try {
    const runPhase0Fn = spyRunPhase0(PASSING_PHASE0_SUMMARY);
    await assert.rejects(
      () => main(["--dry-run", "--phase", "0"], { runPhase0Fn, getEngineVersion: STUB_ENGINE_VERSION }),
      /--dry-run is not supported with --phase 0/,
    );
    assert.equal(runPhase0Fn.calls.length, 0);
  } finally {
    if (prior === undefined) delete process.env.VOYAGE_API_KEY;
    else process.env.VOYAGE_API_KEY = prior;
  }
});

test("main() --phase 0 forwards apiKey/store to runPhase0Fn and does not touch the arms/briefs pipeline", async () => {
  const prior = process.env.VOYAGE_API_KEY;
  process.env.VOYAGE_API_KEY = "test-key-123";
  const priorExitCode = process.exitCode;
  process.exitCode = undefined;
  try {
    const runPhase0Fn = spyRunPhase0(PASSING_PHASE0_SUMMARY);
    await main(["--phase", "0"], { runPhase0Fn, store: FAKE_STORE, getEngineVersion: STUB_ENGINE_VERSION });

    assert.equal(runPhase0Fn.calls.length, 1);
    assert.equal(runPhase0Fn.calls[0].apiKey, "test-key-123");
    assert.equal(runPhase0Fn.calls[0].store, FAKE_STORE);
    assert.notEqual(process.exitCode, 1, "a passing Phase 0 must not set a failing exit code");
  } finally {
    if (prior === undefined) delete process.env.VOYAGE_API_KEY;
    else process.env.VOYAGE_API_KEY = prior;
    process.exitCode = priorExitCode;
  }
});

test("main() --phase 0 prints NO spend summary via the injected log -- it never calls runSpec, so there is no summary to render (merge of #64/PR #72 and #69/Phase 0)", async () => {
  const prior = process.env.VOYAGE_API_KEY;
  process.env.VOYAGE_API_KEY = "test-key-123";
  const priorExitCode = process.exitCode;
  process.exitCode = undefined;
  try {
    const runPhase0Fn = spyRunPhase0(PASSING_PHASE0_SUMMARY);
    const runSpecFn = spyRunSpec(); // must NEVER be called for --phase 0
    const lines = [];
    await main(["--phase", "0"], {
      runPhase0Fn,
      runSpecFn,
      store: FAKE_STORE,
      getEngineVersion: STUB_ENGINE_VERSION,
      log: (msg) => lines.push(msg),
    });

    assert.equal(runSpecFn.calls.length, 0, "--phase 0 must never call runSpec -- it has no arms/briefs grid");
    assert.deepEqual(lines, [], "formatSpendSummary's [spend] lines must never appear for --phase 0 -- it has no runSpec summary to render, only formatPhase0Report's own (console.log-only) report");
  } finally {
    if (prior === undefined) delete process.env.VOYAGE_API_KEY;
    else process.env.VOYAGE_API_KEY = prior;
    process.exitCode = priorExitCode;
  }
});

test("main() --phase 0 sets a non-zero exit code when a control fails, and never throws to paper over it", async () => {
  const prior = process.env.VOYAGE_API_KEY;
  process.env.VOYAGE_API_KEY = "test-key-123";
  const priorExitCode = process.exitCode;
  process.exitCode = undefined;
  try {
    const failingSummary = { ...PASSING_PHASE0_SUMMARY, allPassed: false, duplicatePassed: false };
    const runPhase0Fn = spyRunPhase0(failingSummary);
    await main(["--phase", "0"], { runPhase0Fn, store: FAKE_STORE, getEngineVersion: STUB_ENGINE_VERSION });
    assert.equal(process.exitCode, 1, "§8.3: 'all controls pass, or stop' -- a failed control must be reported via a failing exit code");
  } finally {
    if (prior === undefined) delete process.env.VOYAGE_API_KEY;
    else process.env.VOYAGE_API_KEY = prior;
    process.exitCode = priorExitCode;
  }
});

test("main() --phase for any value other than 0 still fails loudly (no phase->arms/briefs mapping exists yet)", async () => {
  await assert.rejects(
    () => main(["--phase", "2"], { getEngineVersion: STUB_ENGINE_VERSION }),
    /only --phase 0 is wired to a real mapping/,
  );
});

test("formatPhase0Report names all three in-scope controls and never claims the judge test-retest control ran", () => {
  const { lines, allPassed } = formatPhase0Report(PASSING_PHASE0_SUMMARY);
  const text = lines.join("\n");
  assert.equal(allPassed, true);
  assert.match(text, /DAT replication/);
  assert.match(text, /duplicate pool/);
  assert.match(text, /random-text pool/);
  assert.match(text, /judge test-retest.*NOT run/i);
});

test("formatPhase0Report reports the failing outcome honestly when allPassed is false", () => {
  const { lines, allPassed } = formatPhase0Report({ ...PASSING_PHASE0_SUMMARY, allPassed: false });
  assert.equal(allPassed, false);
  assert.match(lines.join("\n"), /AT LEAST ONE FAILED/);
});

test("formatPhase0Report labels margin as descriptive only, not a gating result", () => {
  const { lines } = formatPhase0Report(PASSING_PHASE0_SUMMARY);
  assert.match(lines.join("\n"), /margin.*DESCRIPTIVE ONLY/i);
});

// ── --phase 0 rejects every other flag (Quine smaller item, PR #69) ────────
test("main() --phase 0 rejects --max-spend instead of silently ignoring it", async () => {
  const prior = process.env.VOYAGE_API_KEY;
  process.env.VOYAGE_API_KEY = "test-key";
  try {
    const runPhase0Fn = spyRunPhase0(PASSING_PHASE0_SUMMARY);
    await assert.rejects(
      () => main(["--phase", "0", "--max-spend", "50"], { runPhase0Fn, getEngineVersion: STUB_ENGINE_VERSION }),
      /--phase 0 does not accept --max-spend/,
    );
    assert.equal(runPhase0Fn.calls.length, 0);
  } finally {
    if (prior === undefined) delete process.env.VOYAGE_API_KEY;
    else process.env.VOYAGE_API_KEY = prior;
  }
});

test("main() --phase 0 rejects --max-spend-anthropic and --max-spend-openai instead of silently ignoring them", async () => {
  const prior = process.env.VOYAGE_API_KEY;
  process.env.VOYAGE_API_KEY = "test-key";
  try {
    const runPhase0Fn = spyRunPhase0(PASSING_PHASE0_SUMMARY);
    await assert.rejects(
      () => main(["--phase", "0", "--max-spend-anthropic", "50"], { runPhase0Fn, getEngineVersion: STUB_ENGINE_VERSION }),
      /--phase 0 does not accept --max-spend-anthropic\/--max-spend-openai/,
    );
    await assert.rejects(
      () => main(["--phase", "0", "--max-spend-openai", "20"], { runPhase0Fn, getEngineVersion: STUB_ENGINE_VERSION }),
      /--phase 0 does not accept --max-spend-anthropic\/--max-spend-openai/,
    );
    assert.equal(runPhase0Fn.calls.length, 0);
  } finally {
    if (prior === undefined) delete process.env.VOYAGE_API_KEY;
    else process.env.VOYAGE_API_KEY = prior;
  }
});

test("main() --phase 0 rejects --arms/--briefs/--replicates/--no-batch the same way", async () => {
  const prior = process.env.VOYAGE_API_KEY;
  process.env.VOYAGE_API_KEY = "test-key";
  try {
    const runPhase0Fn = spyRunPhase0(PASSING_PHASE0_SUMMARY);
    await assert.rejects(
      () => main(["--phase", "0", "--arms", "A"], { runPhase0Fn, getEngineVersion: STUB_ENGINE_VERSION }),
      /--phase 0 does not accept --arms/,
    );
    await assert.rejects(
      () => main(["--phase", "0", "--briefs", "b1"], { runPhase0Fn, getEngineVersion: STUB_ENGINE_VERSION }),
      /--phase 0 does not accept --briefs/,
    );
    await assert.rejects(
      () => main(["--phase", "0", "--replicates", "2"], { runPhase0Fn, getEngineVersion: STUB_ENGINE_VERSION }),
      /--phase 0 does not accept --replicates/,
    );
    await assert.rejects(
      () => main(["--phase", "0", "--no-batch"], { runPhase0Fn, getEngineVersion: STUB_ENGINE_VERSION }),
      /--phase 0 does not accept --no-batch/,
    );
    assert.equal(runPhase0Fn.calls.length, 0);
  } finally {
    if (prior === undefined) delete process.env.VOYAGE_API_KEY;
    else process.env.VOYAGE_API_KEY = prior;
  }
});
