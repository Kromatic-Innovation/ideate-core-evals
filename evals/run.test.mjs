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
import { parseArgs, main, formatSpendSummary, formatPhase0Report, formatPrunePlan, resolveStoreDir, DEFAULT_RESULTS_DIR } from "./run.mjs";
// The real judge-call writer (issue #108) -- the CLI prune tests below use it
// rather than hand-built keys, so the fixture cannot drift from the writer.
import { meterJudgeCall } from "./judge/gate.mjs";
import { runnerPriceGrid } from "../lib/price.mjs";
import { JUDGE_MODELS } from "./judge/config.mjs";
import { judgeLegsFor } from "./judge/matrix.mjs";
import { AnthropicJudgeProvider, OpenAIJudgeProvider } from "./judge/score.mjs";
import { AnthropicBatchProvider, DEFAULT_MAX_POLL_MS } from "./harness/provider.mjs";
import { promptTemplateHash } from "./harness/prompts.mjs";
import { CONFIG_FIELDS, armsConfigHash, configHash } from "../lib/manifest.mjs";
import { computeJudgeHash } from "./judge/score.mjs";
import { VOYAGE_CLUSTER_DISTANCE_THRESHOLD } from "./metrics/voyage-calibration.mjs";
import { createHash } from "node:crypto";
import { CORPUS } from "./corpus/index.mjs";
import armsConfigJson from "../arms.config.json" with { type: "json" };

// --prune (issue #98) is the one CLI mode that touches a REAL store rather
// than being handed to a spy runSpec, so these tests build a genuine temp
// ResultsStore. Still hermetic: temp dirs, no provider, no network.
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ResultsStore, BATCH_RESUME_FAMILY, writeBatchResumeRecord } from "../lib/store.mjs";
import { cellKey } from "../lib/manifest.mjs";
import { TRANSIENT_FAILURE_KINDS, INTRINSIC_FAILURE_KINDS, PAYMENT_FAILURE_KINDS } from "../lib/accounting.mjs";

const PRUNE_CFG = "abcdef012345";
const pruneTempDirs = [];
process.on("exit", () => {
  for (const dir of pruneTempDirs) rmSync(dir, { recursive: true, force: true });
});

/** One transient failure (arm A / b1), one completed cell (arm A / b2), and
 *  eight generation-attempt records for a third cell — enough for a prune to
 *  have something to evict, something to refuse, and something to compact. */
function pruneFixtureStore() {
  const dir = mkdtempSync(join(tmpdir(), "ideate-run-prune-"));
  pruneTempDirs.push(dir);
  const store = new ResultsStore(dir);
  const put = (key, accounting, rows) =>
    store.put({
      key,
      armId: "A",
      briefId: "b",
      replicate: 0,
      cfg: PRUNE_CFG,
      result: { candidates: [] },
      resolvedModels: { proposer: "claude-haiku-4-5" },
      accounting,
      costRows: rows,
    });
  const rowFor = (k) => [{ cellKey: k, timestamp: "2026-09-01T00:00:00Z", billing_mode: "api", model: "claude-haiku-4-5", input_tokens: 1000, output_tokens: 200 }];

  const transient = cellKey({ armId: "A", briefId: "b1", replicate: 0, cfg: PRUNE_CFG });
  put(transient, { state: "failed", kind: "rate_limited", detail: "429" }, rowFor(transient));
  const completed = cellKey({ armId: "A", briefId: "b2", replicate: 0, cfg: PRUNE_CFG });
  put(completed, { state: "completed" }, rowFor(completed));
  const busy = cellKey({ armId: "A", briefId: "b3", replicate: 0, cfg: PRUNE_CFG });
  for (let n = 0; n < 8; n++) {
    const k = `generation-attempt|cell=${busy}|attempt=${n}`;
    put(k, { state: "failed", kind: "rate_limited", detail: "429" }, rowFor(busy));
  }
  return store;
}

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

// ── issue #103: batch resume, and the two off-switches ─────────────────────

test("parseArgs accepts --no-resume and --no-cancel-on-abandon (issue #103)", () => {
  assert.equal(parseArgs(["--no-resume"]).noResume, true);
  assert.equal(parseArgs(["--no-cancel-on-abandon"]).noCancelOnAbandon, true);
  // Both are OFF-switches. There is deliberately no `--resume` / `--cancel-on-
  // abandon`: an on-switch for a default-on behaviour is a flag that only ever
  // gets typed by someone who has misread the default.
  assert.throws(() => parseArgs(["--resume"]), /unrecognized flag/);
  assert.throws(() => parseArgs(["--cancel-on-abandon"]), /unrecognized flag/);
  assert.equal(parseArgs([]).noResume, undefined);
  assert.equal(parseArgs([]).noCancelOnAbandon, undefined);
});

test("main() wires the #103 off-switches to the provider AND to runSpec, and leaves both behaviours ON by default", async (t) => {
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

  // Default: both on. #103 did NOT flip cancel-on-abandon -- the premise that
  // cancelling destroys the handle resume re-polls is false (a `canceled`
  // result means only "never sent to the model", and those are not billed,
  // while everything already sent still succeeds and stays in the results
  // file for 29 days). The two are complements.
  const dflt = spyRunSpec();
  await main(["--max-spend", "999"], { runSpecFn: dflt, store: FAKE_STORE, getEngineVersion: STUB_ENGINE_VERSION });
  assert.equal(dflt.calls[0].opts.provider.resume, true);
  assert.equal(dflt.calls[0].opts.provider.cancelOnAbandon, true);
  assert.equal(dflt.calls[0].opts.resume, true, "runSpec's own resume gate must agree with the provider's");

  const off = spyRunSpec();
  await main(["--max-spend", "999", "--no-resume", "--no-cancel-on-abandon"], { runSpecFn: off, store: FAKE_STORE, getEngineVersion: STUB_ENGINE_VERSION });
  assert.equal(off.calls[0].opts.provider.resume, false);
  assert.equal(off.calls[0].opts.provider.cancelOnAbandon, false);
  assert.equal(off.calls[0].opts.resume, false);
});

test("--prune and --phase 0 both REFUSE the #103 flags rather than silently dropping them", async () => {
  await assert.rejects(() => main(["--prune", "--no-resume"], { store: FAKE_STORE }), /--prune does not accept .*--no-resume/);
  await assert.rejects(() => main(["--prune", "--no-cancel-on-abandon"], { store: FAKE_STORE }), /--prune does not accept .*--no-cancel-on-abandon/);
  await assert.rejects(() => main(["--phase", "0", "--no-resume"], { store: FAKE_STORE }), /--phase 0 does not accept .*--no-resume/);
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
    // issue #122: promptTemplateHash()'s payload folds in the per-model
    // rate map (and its fallback), not the single pre-#122 constant.
    tokensPerIdeaByModel: prompts.TOKENS_PER_IDEA_BY_MODEL,
    defaultTokensPerIdea: prompts.DEFAULT_TOKENS_PER_IDEA,
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

// issue #106's judge-side payment-abort notice used to be printed from here
// (evals/run.mjs), and these two tests pinned it -- driving a MOCKED
// runSpecFn returning a synthetic summary, so runner.mjs itself never ran.
// #112 added its own, strictly better notice in evals/harness/runner.mjs
// (the real refused/skipped split this file's notice could never compute),
// so a real judge-side billing refusal printed `[run] JUDGING ABORTED:`
// TWICE, and this file's copy carried a claim #112 made false ("cannot say
// how the total splits"). #116 deleted evals/run.mjs's notice entirely (see
// its comment there) and, with it, deleted these two tests -- there is no
// longer any code path here for them to cover. The printed-notice coverage,
// including the "no refusal -> no notice" guarantee the second test held,
// now lives in evals/harness/judging.test.mjs (search `issue #116`), against
// the real emitter instead of a mock.

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

// ── issue #119 AC3: the report surface names WHEN the cumulative total is
// not entirely fact-based ────────────────────────────────────────────────
test("formatSpendSummary surfaces legacyPricingRowCount as a NOTE next to the cumulative total", () => {
  const summary = {
    spendByProvider: { anthropic: 0.5 },
    cumulativeSpendByProvider: { anthropic: 1.5 },
    cumulativeSpendUsd: 1.75,
    cumulativeNonProviderSpendUsd: 0.25,
    cumulativeNonProviderModels: [],
    cumulativeLegacyPricingRowCount: 7,
    cumulativeLegacyPricingFallbackRegime: "single",
  };
  const joined = formatSpendSummary(summary).join("\n");
  assert.match(joined, /NOTE: 7 cost row\(s\) in this store predate the per-row pricing regime/);
  assert.match(joined, /'single'/);
});

test("formatSpendSummary emits no legacy-pricing note when every row carried its own regime", () => {
  const summary = {
    spendByProvider: { anthropic: 0.5 },
    cumulativeSpendByProvider: { anthropic: 1.5 },
    cumulativeSpendUsd: 1.75,
    cumulativeNonProviderSpendUsd: 0.25,
    cumulativeNonProviderModels: [],
    cumulativeLegacyPricingRowCount: 0,
    cumulativeLegacyPricingFallbackRegime: "single",
  };
  const joined = formatSpendSummary(summary).join("\n");
  assert.doesNotMatch(joined, /NOTE: \d+ cost row/);
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
    // Filtered to `[spend]` rather than asserting an empty array: since #120
    // every mode announces which store it opened (a `[store]` line), and
    // --phase 0 persists to one like any other mode. The invariant this test
    // exists for is unchanged -- NO spend summary, because there is no
    // runSpec summary to render.
    assert.deepEqual(
      lines.filter((l) => l.startsWith("[spend]")),
      [],
      "formatSpendSummary's [spend] lines must never appear for --phase 0 -- it has no runSpec summary to render, only formatPhase0Report's own (console.log-only) report",
    );
    assert.deepEqual(
      lines.filter((l) => !l.startsWith("[store]")),
      [],
      "and nothing OTHER than the store announcement reaches the injected log either",
    );
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

// ── --prune (issue #98) ─────────────────────────────────────────────────────
// The prune is the only CLI mode that DELETES, so its argv handling gets the
// same scrutiny --max-spend does, and for a sharper reason: a mis-parsed
// budget flag spends money, a mis-parsed prune flag destroys measurements.

test("parseArgs accepts --prune and its selectors", () => {
  const args = parseArgs(["--prune", "--cfg", "5ce5478956e5", "--arms", "A,B", "--briefs", "b1", "--kinds", "rate_limited,timeout", "--keep-attempts", "3", "--apply"]);
  assert.equal(args.prune, true);
  assert.equal(args.apply, true);
  assert.equal(args.cfg, "5ce5478956e5");
  assert.deepEqual(args.arms, ["A", "B"]);
  assert.deepEqual(args.briefs, ["b1"]);
  assert.deepEqual(args.kinds, ["rate_limited", "timeout"]);
  assert.equal(args.keepAttempts, 3);
  assert.equal(args.allowCompleted, undefined);
});

test("--kinds expands the three set names lib/accounting.mjs already defines", () => {
  assert.deepEqual(parseArgs(["--prune", "--kinds", "transient"]).kinds, [...TRANSIENT_FAILURE_KINDS]);
  assert.deepEqual(parseArgs(["--prune", "--kinds", "intrinsic"]).kinds, [...INTRINSIC_FAILURE_KINDS]);
  assert.deepEqual(parseArgs(["--prune", "--kinds", "payment"]).kinds, [...PAYMENT_FAILURE_KINDS]);
  // Mixed, de-duplicated.
  assert.deepEqual(
    parseArgs(["--prune", "--kinds", "transient,rate_limited,refusal"]).kinds,
    [...TRANSIENT_FAILURE_KINDS, "refusal"],
  );
});

test("--kinds refuses an unknown token rather than silently ignoring it", () => {
  // A kind this command silently drops is a cell that stays unretryable --
  // the exact failure mode the whole issue is about.
  assert.throws(() => parseArgs(["--prune", "--kinds", "rate_limitd"]), /neither a failure kind/);
  assert.throws(() => parseArgs(["--prune", "--kinds", ""]), /--kinds requires/);
});

test("--states validates against the real terminal states", () => {
  assert.deepEqual(parseArgs(["--prune", "--states", "failed,completed"]).states, ["failed", "completed"]);
  assert.throws(() => parseArgs(["--prune", "--states", "borked"]), /valid terminal states/);
});

test("--keep-attempts refuses zero, a fraction and a non-number", () => {
  assert.throws(() => parseArgs(["--prune", "--keep-attempts", "0"]), /positive integer/);
  assert.throws(() => parseArgs(["--prune", "--keep-attempts", "1.5"]), /positive integer/);
  assert.throws(() => parseArgs(["--prune", "--keep-attempts", "lots"]), /numeric argument/);
});

test("parseArgs accepts --keep-batch-replays, its own knob from --keep-attempts (#117)", () => {
  const args = parseArgs(["--prune", "--keep-attempts", "3", "--keep-batch-replays", "2", "--apply"]);
  assert.equal(args.keepAttempts, 3);
  assert.equal(args.keepBatchReplays, 2);
});

test("--keep-batch-replays refuses zero, a fraction and a non-number", () => {
  assert.throws(() => parseArgs(["--prune", "--keep-batch-replays", "0"]), /positive integer/);
  assert.throws(() => parseArgs(["--prune", "--keep-batch-replays", "1.5"]), /positive integer/);
  assert.throws(() => parseArgs(["--prune", "--keep-batch-replays", "lots"]), /numeric argument/);
});

test("--prune is dry-run by default: main() reports a plan and writes nothing", async () => {
  const store = pruneFixtureStore();
  const before = store.keys();
  const lines = [];
  await main(["--prune", "--kinds", "transient"], { store, log: (m) => lines.push(m), getEngineVersion: STUB_ENGINE_VERSION, runSpecFn: spyRunSpec() });

  assert.deepEqual(store.keys(), before, "a dry run modifies nothing");
  assert.ok(lines.some((l) => l.includes("EVICT would remove")), lines.join("\n"));
  assert.ok(lines.some((l) => l.includes("DRY RUN")), lines.join("\n"));
});

test("--prune --apply removes the cell, and reports the spend it verified", async () => {
  const store = pruneFixtureStore();
  const lines = [];
  await main(["--prune", "--kinds", "transient", "--apply"], { store, log: (m) => lines.push(m), getEngineVersion: STUB_ENGINE_VERSION, runSpecFn: spyRunSpec() });

  assert.equal(store.keys().some((k) => k.startsWith("arm=A|brief=b1|")), false, "the transient cell is gone");
  assert.ok(store.keys().some((k) => k.startsWith("pruned-cell|")), "its spend is not");
  assert.ok(lines.some((l) => l.includes("EVICT removed")), lines.join("\n"));
  assert.ok(lines.some((l) => /spend-to-date after/.test(l)), lines.join("\n"));
  assert.equal(lines.some((l) => l.includes("DRY RUN")), false);
});

// ── #117: --prune reaches superseded batch-replay records too ──────────────

/** pruneFixtureStore() plus five real batch-replay records for one cell,
 *  written through lib/store.mjs's own writer. */
function replayFixtureStore() {
  const store = pruneFixtureStore();
  const replayed = cellKey({ armId: "A", briefId: "b5", replicate: 0, cfg: PRUNE_CFG });
  for (let n = 0; n < 5; n++) {
    writeBatchResumeRecord(store, {
      cellKey: replayed,
      cfg: PRUNE_CFG,
      replies: { [`r${n}`]: { model: "claude-haiku-4-5", text: `reply ${n}` } },
      pricingLever: "batch",
    });
  }
  return { store, replayed };
}

test("--prune dry-run reports what a supersede WOULD remove, and modifies nothing", async () => {
  const { store } = replayFixtureStore();
  const before = store.keys();
  const lines = [];
  await main(["--prune"], { store, log: (m) => lines.push(m), getEngineVersion: STUB_ENGINE_VERSION, runSpecFn: spyRunSpec() });

  assert.deepEqual(store.keys(), before, "a dry run modifies nothing");
  assert.ok(lines.some((l) => l.includes("SUPERSEDE would remove") && l.includes("batch-replay")), lines.join("\n"));
  assert.ok(lines.some((l) => l.includes("DRY RUN")), lines.join("\n"));
});

test("--prune --apply removes superseded batch-replay records and keeps the newest, no selector needed", async () => {
  const { store, replayed } = replayFixtureStore();
  const lines = [];
  await main(["--prune", "--apply"], { store, log: (m) => lines.push(m), getEngineVersion: STUB_ENGINE_VERSION, runSpecFn: spyRunSpec() });

  const remaining = store.keys().filter((k) => k.startsWith(BATCH_RESUME_FAMILY));
  assert.deepEqual(remaining, [`${BATCH_RESUME_FAMILY}|cell=${replayed}|attempt=4`], "only the highest-attempt record survives");
  assert.ok(lines.some((l) => l.includes("SUPERSEDE removed") && l.includes("batch-replay")), lines.join("\n"));
  assert.ok(lines.some((l) => /spend-to-date after/.test(l)), lines.join("\n"));
});

test("--keep-batch-replays raises the retention window, independent of --keep-attempts", async () => {
  const { store, replayed } = replayFixtureStore();
  await main(["--prune", "--keep-batch-replays", "2", "--apply"], { store, log: () => {}, getEngineVersion: STUB_ENGINE_VERSION, runSpecFn: spyRunSpec() });

  const remaining = store.keys().filter((k) => k.startsWith(`${BATCH_RESUME_FAMILY}|cell=${replayed}|`));
  assert.equal(remaining.length, 2);
});

// ── #108 AC5: judge-call records, same command ────────────────────────────
// The acceptance criterion is about the INTERFACE, so it is asserted at the
// CLI: the same `--prune [--keep-attempts N] --apply`, no judge-specific
// flag, and no `--allow-completed` even though judge-call records are stored
// `completed`. That last part is the one an operator would otherwise learn
// the hard way, and passing that flag habitually is how a real measurement
// eventually gets deleted.

/** pruneFixtureStore() plus six real judge-call records for one
 *  (cell, judge model) pair, written through gate.mjs's own metering path. */
function judgeCallFixtureStore() {
  const store = pruneFixtureStore();
  const judged = cellKey({ armId: "A", briefId: "b4", replicate: 0, cfg: PRUNE_CFG });
  for (let n = 0; n < 6; n++) {
    meterJudgeCall({
      store,
      cellKey: judged,
      judgeModel: "claude-opus-5",
      tokens: { input_tokens: 900 + n, output_tokens: 120 },
      timestamp: "2026-09-01T00:00:00Z",
    });
  }
  return { store, judged };
}

test("#108 AC5: --prune --keep-attempts compacts judge-call records through the same command, with no extra flag", async () => {
  const { store, judged } = judgeCallFixtureStore();
  const before = store.keys().length;
  const lines = [];
  // No --kinds, no --cfg, no --allow-completed, no judge selector.
  await main(["--prune", "--keep-attempts", "2", "--apply"], { store, log: (m) => lines.push(m), getEngineVersion: STUB_ENGINE_VERSION, runSpecFn: spyRunSpec() });

  assert.ok(store.keys().length < before, "the store shrinks");
  assert.ok(store.has(`judge-call-compacted|cell=${judged}|judge=claude-opus-5|through=3`), store.keys().join("\n"));
  for (const n of [4, 5]) assert.ok(store.has(`judge-call|cell=${judged}|judge=claude-opus-5|attempt=${n}`), `attempt ${n} is inside the retention window`);
  assert.ok(lines.some((l) => l.includes("COMPACT removed") && l.includes("judge-call")), lines.join("\n"));
  // The same invocation reached the generation-attempt family too -- one
  // command, every family, which is the whole criterion.
  assert.ok(lines.some((l) => l.includes("COMPACT removed") && l.includes("generation-attempt")), lines.join("\n"));
  assert.ok(lines.some((l) => /spend-to-date after/.test(l)), lines.join("\n"));
});

test("#108: a judge-call compaction is visible in the dry run before anything is written", async () => {
  const { store } = judgeCallFixtureStore();
  const before = store.keys();
  const lines = [];
  await main(["--prune", "--keep-attempts", "2"], { store, log: (m) => lines.push(m), getEngineVersion: STUB_ENGINE_VERSION, runSpecFn: spyRunSpec() });
  assert.deepEqual(store.keys(), before, "still a dry run");
  assert.ok(lines.some((l) => l.includes("COMPACT would remove") && l.includes("judge-call")), lines.join("\n"));
  assert.ok(lines.some((l) => l.includes("DRY RUN")), lines.join("\n"));
});

test("--prune never calls runSpec, never resolves the engine version, and needs no API key", async () => {
  const store = pruneFixtureStore();
  const runSpecFn = spyRunSpec();
  // A repair command that cannot run on a machine missing a dependency it
  // will never call is a repair command that is unavailable exactly when it
  // is needed. Throwing from the engine-version seam proves main() never
  // reaches it.
  await main(["--prune"], {
    store,
    log: () => {},
    runSpecFn,
    getEngineVersion: () => {
      throw new Error("engine version must not be resolved for a prune");
    },
  });
  assert.equal(runSpecFn.calls.length, 0);
});

test("--prune rejects run-only flags rather than silently ignoring them", async () => {
  const base = { store: pruneFixtureStore(), log: () => {}, getEngineVersion: STUB_ENGINE_VERSION, runSpecFn: spyRunSpec() };
  await assert.rejects(() => main(["--prune", "--max-spend", "10"], base), /--prune does not accept --max-spend/);
  await assert.rejects(() => main(["--prune", "--replicates", "2"], base), /--prune does not accept --replicates/);
  await assert.rejects(() => main(["--prune", "--no-batch"], base), /--prune does not accept --no-batch/);
});

test("--prune refuses --dry-run and --apply together", async () => {
  await assert.rejects(
    () => main(["--prune", "--dry-run", "--apply"], { store: pruneFixtureStore(), log: () => {}, getEngineVersion: STUB_ENGINE_VERSION, runSpecFn: spyRunSpec() }),
    /contradict each other/,
  );
});

test("--prune --apply on a completed cell refuses without --allow-completed, and complies with it", async () => {
  const store = pruneFixtureStore();
  const completedKey = store.keys().find((k) => k.startsWith("arm=A|brief=b2|"));
  const lines = [];
  await main(["--prune", "--states", "completed", "--apply"], { store, log: (m) => lines.push(m), getEngineVersion: STUB_ENGINE_VERSION, runSpecFn: spyRunSpec() });
  assert.ok(store.has(completedKey), "paid-for data survives a prune that did not ask for it");
  assert.ok(lines.some((l) => l.includes("REFUSED")), lines.join("\n"));

  await main(["--prune", "--states", "completed", "--allow-completed", "--apply"], { store, log: () => {}, getEngineVersion: STUB_ENGINE_VERSION, runSpecFn: spyRunSpec() });
  assert.equal(store.has(completedKey), false);
});

test("prune-only flags on a REAL run are rejected, not silently ignored", async () => {
  // The mirror of --prune's own run-only-flag rejection. The hazard is an
  // edit rather than a typo: drop `--prune` from a prune command line and
  // the remaining flags read like scoping while the run spends real money.
  const base = { store: FAKE_STORE, log: () => {}, getEngineVersion: STUB_ENGINE_VERSION, runSpecFn: spyRunSpec() };
  await assert.rejects(() => main(["--cfg", "abc"], base), /only meaningful with --prune/);
  await assert.rejects(() => main(["--kinds", "transient"], base), /only meaningful with --prune/);
  await assert.rejects(() => main(["--apply"], base), /only meaningful with --prune/);
  await assert.rejects(() => main(["--allow-completed"], base), /only meaningful with --prune/);
  await assert.rejects(() => main(["--keep-attempts", "3"], base), /only meaningful with --prune/);
  await assert.rejects(() => main(["--keep-batch-replays", "2"], base), /only meaningful with --prune/);
  await assert.rejects(() => main(["--states", "failed"], base), /only meaningful with --prune/);
});

test("formatPrunePlan names the no-selector case explicitly rather than reporting an empty eviction list", () => {
  const lines = formatPrunePlan({ keysBefore: 3, keysAfter: 3, selectorsGiven: false, evictions: [], refused: [], compactions: [] });
  assert.ok(lines.some((l) => l.includes("no cell selector given")), lines.join("\n"));
  assert.ok(lines.some((l) => l.includes("nothing to compact")), lines.join("\n"));
  assert.ok(lines.some((l) => l.includes("DRY RUN")), lines.join("\n"));
});

test("formatPrunePlan surfaces an unfolded compaction group and says why", () => {
  const lines = formatPrunePlan(
    {
      keysBefore: 9,
      keysAfter: 4,
      selectorsGiven: false,
      evictions: [],
      refused: [],
      compactions: [
        {
          family: "generation-attempt",
          cellKey: "arm=A|brief=b1|rep=0|cfg=abc",
          newKey: "generation-attempt-compacted|cell=arm=A|brief=b1|rep=0|cfg=abc|through=4",
          removeKeys: ["a", "b", "c", "d", "e"],
          keptKeys: ["f", "g"],
          rows: [1, 2, 3, 4, 5],
          rowsBefore: 5,
          rowsFolded: false,
          foldSkippedReason: "folding these rows would reprice them",
        },
      ],
    },
    { applied: true },
  );
  assert.ok(lines.some((l) => l.includes("kept UNFOLDED")), lines.join("\n"));
  assert.ok(lines.some((l) => l.includes("COMPACT removed")), lines.join("\n"));
  assert.equal(lines.some((l) => l.includes("DRY RUN")), false);
});

// ── issue #101: the four absent CONFIG_FIELDS, and the arms.config.json gap ──
//
// lib/manifest.test.mjs pins that armsConfigHash() itself reacts to a model
// edit. That is NOT the regression these guard: the defect lived in run.mjs,
// which declared nine CONFIG_FIELDS and populated five. So these cover
// run.mjs's own seam -- reading spec.config off a main() invocation -- the
// same way the #99 tests above do. A test that only re-checked
// lib/manifest.mjs would stay green while run.mjs regressed.

test("issue #101: main() stamps every CONFIG_FIELDS entry -- no field is declared-but-never-set", async () => {
  const runSpecFn = spyRunSpec();
  await main(["--dry-run"], { runSpecFn, store: FAKE_STORE, getEngineVersion: STUB_ENGINE_VERSION });

  const { spec } = runSpecFn.calls[0];
  // The census this issue was filed over: five of nine set. A field that is
  // `undefined` is SKIPPED by configHash(), so it never participates in the
  // hash while still reading, in CONFIG_FIELDS, as though it were covered.
  const absent = CONFIG_FIELDS.filter((f) => spec.config[f] === undefined);
  assert.deepEqual(absent, [], `every declared CONFIG_FIELDS entry must be populated; absent: ${absent.join(", ")}`);
  // And nothing extra: a key in spec.config that CONFIG_FIELDS does not
  // declare is silently dropped from the hash, which is the same lie.
  const undeclared = Object.keys(spec.config).filter((k) => !CONFIG_FIELDS.includes(k));
  assert.deepEqual(undeclared, [], `spec.config carries keys configHash ignores: ${undeclared.join(", ")}`);
});

test("issue #101: THE regression guard -- changing an arm's model assignment moves the configHash of the spec run.mjs builds", async () => {
  const runSpecFn = spyRunSpec();
  await main(["--dry-run"], { runSpecFn, store: FAKE_STORE, getEngineVersion: STUB_ENGINE_VERSION });
  const { spec } = runSpecFn.calls[0];

  assert.equal(spec.config.armsConfigHash, armsConfigHash(armsConfigJson), "the spec must carry the REAL arms.config.json hash");

  // The issue's worked example: arm C, homogeneous Sonnet, promoted to Opus.
  // Before #101 this produced an IDENTICAL configHash, so planRun classified
  // the new cells `reuse` and the frame pooled two different experiments.
  const edited = JSON.parse(JSON.stringify(armsConfigJson));
  edited.arms.C.slots[0].model = "claude-opus-5";
  assert.notEqual(
    configHash({ ...spec.config, armsConfigHash: armsConfigHash(edited) }),
    configHash(spec.config),
    "editing an arm's model assignment MUST move the configHash run.mjs stamps -- the single variable this study manipulates",
  );

  // And the negative half, which is what makes the design legible: a
  // documentation-only edit must NOT invalidate the dataset.
  const proseEdited = JSON.parse(JSON.stringify(armsConfigJson));
  proseEdited._comment += " (typo fixed)";
  proseEdited.arms.C.label = "Homogeneous Sonnet 5 (mid tier)";
  assert.equal(
    configHash({ ...spec.config, armsConfigHash: armsConfigHash(proseEdited) }),
    configHash(spec.config),
    "a prose edit changes what a reader is told, not what was measured",
  );
});

test("issue #101: judgeHash is populated from computeJudgeHash over the REGISTERED judge roster", async () => {
  const runSpecFn = spyRunSpec();
  await main(["--dry-run"], { runSpecFn, store: FAKE_STORE, getEngineVersion: STUB_ENGINE_VERSION });
  const { spec } = runSpecFn.calls[0];

  // Populated, not removed: docs/PREREGISTRATION.md Appendix B item 3
  // registers IN ADVANCE that judgeHash is a CONFIG_FIELDS entry and that
  // judgeHash -> configHash -> cellKey is "correct and intended".
  assert.match(spec.config.judgeHash, /^[0-9a-f]{12}$/);
  assert.equal(
    spec.config.judgeHash,
    computeJudgeHash({ judgeModels: JUDGE_MODELS }),
    "the SAME roster the pre-flight prices and the matrix judges against -- what is hashed and what judges can never diverge",
  );

  // The consequence that matters: swapping a judge model moves configHash.
  const swapped = computeJudgeHash({ judgeModels: { ...JUDGE_MODELS, anthropic: ["claude-haiku-4-5"] } });
  assert.notEqual(swapped, spec.config.judgeHash, "sanity: the swapped roster hashes differently");
  assert.notEqual(
    configHash({ ...spec.config, judgeHash: swapped }),
    configHash(spec.config),
    "a changed judge roster must change configHash",
  );
});

test("issue #101: clusterDistanceThreshold is stamped into spec.config, unconditionally", async () => {
  const runSpecFn = spyRunSpec();
  await main(["--dry-run"], { runSpecFn, store: FAKE_STORE, getEngineVersion: STUB_ENGINE_VERSION });
  const { spec } = runSpecFn.calls[0];

  // It was already passed as a runSpec() OPTION but never into spec.config,
  // so the CONFIG_FIELDS entry Appendix B item 8 registers never reached the
  // hash. Since #85 wired pool metrics into runSpec, distinct_k -- a stored
  // GENERATION artifact -- is a direct function of this threshold.
  assert.equal(spec.config.clusterDistanceThreshold, VOYAGE_CLUSTER_DISTANCE_THRESHOLD);
  assert.notEqual(
    configHash({ ...spec.config, clusterDistanceThreshold: 0.5 }),
    configHash(spec.config),
    "a threshold change must change configHash",
  );

  // Unconditional on purpose. This is a --dry-run, which wires no embedder at
  // all; had the field been gated on the embedder's presence, --dry-run would
  // project a different configHash than the real run it exists to project.
  assert.equal(runSpecFn.calls[0].opts.embedder, undefined, "sanity: --dry-run wires no embedder");
});

test("issue #101: --arms scoping does NOT move armsConfigHash -- the hash is over the FILE, not over spec.arms", async () => {
  // The reassuring half of the whole-file hash, and what makes its costly
  // half tolerable (adding an arm invalidates EVERY arm's cells -- registered
  // as Appendix D item 1, pinned in lib/manifest.test.mjs): running a SUBSET
  // of arms is not a config change, so a scoped run's cells stay comparable
  // to an unscoped run's. Were the hash taken over the arms a spec happens to
  // run, arm A's cells from `--arms A,B` would be incomparable to arm A's
  // cells from `--arms A,C` -- which would break the additive design far more
  // severely than over-invalidation does.
  const unscoped = spyRunSpec();
  await main(["--dry-run"], { runSpecFn: unscoped, store: FAKE_STORE, getEngineVersion: STUB_ENGINE_VERSION });

  const scoped = spyRunSpec();
  await main(["--dry-run", "--arms", "A,B"], { runSpecFn: scoped, store: FAKE_STORE, getEngineVersion: STUB_ENGINE_VERSION });

  // Sanity, and worth naming because it is not the obvious seam: `--arms`
  // never narrows `spec.arms` (which is always every arm in the file). It is
  // a runSpec() OPTION, applied downstream. So arm scoping cannot reach
  // configHash by that route either -- the two independent reasons the hash
  // is unmoved happen to agree.
  assert.deepEqual(scoped.calls[0].opts.armIds, ["A", "B"], "sanity: the scoped run really did narrow the arms runSpec will execute");
  assert.equal(unscoped.calls[0].opts.armIds, undefined, "sanity: the unscoped run narrows nothing");
  assert.equal(
    scoped.calls[0].spec.config.armsConfigHash,
    unscoped.calls[0].spec.config.armsConfigHash,
    "arm scoping is not a config change",
  );
  assert.equal(
    configHash(scoped.calls[0].spec.config),
    configHash(unscoped.calls[0].spec.config),
    "and so the whole configHash is unmoved -- a scoped run's cells remain comparable to a full run's",
  );
});

// ── --results-dir (issue #120): store separation as the §11 mechanism ───────
// docs/PREREGISTRATION.md §11 permits a pilot to inform the confirmatory n
// only if "the pilot's own data is then not reused in the confirmatory test",
// and #49 AC5 requires that exclusion be STRUCTURAL. The pilot must run at
// the grid's configHash for its variance estimate to transfer, so nothing in
// the config machinery can separate them -- two stores can.

/** An empty temp directory, cleaned up on exit like the prune fixtures. */
function tempStoreDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  pruneTempDirs.push(dir);
  return dir;
}

test("parseArgs accepts --results-dir, and refuses a missing or flag-shaped value", () => {
  assert.equal(parseArgs(["--results-dir", "results-pilot"]).resultsDir, "results-pilot");
  assert.equal(parseArgs([]).resultsDir, undefined, "absent means the default store, not an empty string");
  assert.throws(() => parseArgs(["--results-dir"]), /--results-dir requires a directory argument/);
  assert.throws(
    () => parseArgs(["--results-dir", "--prune"]),
    /looks like a flag, not a directory/,
    "a swallowed next-flag would create a store in a directory called '--prune' and then run unpruned",
  );
});

test("resolveStoreDir defaults to REPO_ROOT/results, resolves a relative flag value against cwd (matching analysis.mjs), and creates nothing", () => {
  assert.equal(resolveStoreDir(undefined), DEFAULT_RESULTS_DIR);
  const missing = join(tempStoreDir("ideate-run-store-"), "not-yet");
  assert.equal(resolveStoreDir(missing), missing, "a non-existent directory is accepted -- ResultsStore mkdirs it, exactly as it does for results/");
  assert.equal(existsSync(missing), false, "resolveStoreDir itself never creates anything");
  // The cwd-relative resolution is the compatibility contract with
  // evals/analysis/analysis.mjs, which hands its own --results-dir value
  // straight to `new ResultsStore(...)`. If these two diverged, an operator
  // passing the same relative path to both commands would write a pilot in
  // one directory and analyse an empty store in another.
  assert.equal(resolveStoreDir("results-pilot"), resolve(process.cwd(), "results-pilot"));
});

test("issue #120 AC3: --results-dir refuses a path that exists but is not a store, rather than initialising over it", async () => {
  const notAStore = tempStoreDir("ideate-run-notastore-");
  writeFileSync(join(notAStore, "PREREGISTRATION.md"), "# not a results store\n");
  assert.throws(() => resolveStoreDir(notAStore), /is not a results store/);
  assert.throws(() => resolveStoreDir(notAStore), /Refusing to initialise a store over it/);

  const aFile = join(tempStoreDir("ideate-run-file-"), "store.txt");
  writeFileSync(aFile, "x");
  assert.throws(() => resolveStoreDir(aFile), /exists and is not a directory/);

  // The message names WHICH store, and never reports a flag the operator did
  // not pass. The guard applies to the default store too -- a results/ that
  // has lost its index.jsonl would otherwise be silently re-initialised, and
  // every paid-for cell re-planned as `todo`.
  assert.throws(() => resolveStoreDir(notAStore), new RegExp(`--results-dir '${notAStore}'`));
  assert.doesNotMatch(
    (() => {
      try {
        resolveStoreDir(notAStore);
      } catch (e) {
        return e.message;
      }
    })(),
    /the default results store/,
  );

  // An EXISTING store is accepted -- the guard is about junk, not about
  // refusing to append to the store this flag exists to build up. An EMPTY
  // directory is accepted too (tempStoreDir's own dirs, used throughout).
  const real = tempStoreDir("ideate-run-real-");
  new ResultsStore(real);
  assert.equal(resolveStoreDir(real), real);

  // And it fires through the CLI, not only through the helper.
  await assert.rejects(
    () => main(["--dry-run", "--results-dir", notAStore], { runSpecFn: spyRunSpec(), log: () => {}, getEngineVersion: STUB_ENGINE_VERSION }),
    /is not a results store/,
  );
});

test("issue #120 AC2: --results-dir composes with a real run, --dry-run, --prune and --phase 0 -- it is in none of the ignored-flag rejection lists", async () => {
  // --dry-run / a real run: the store runSpec receives is rooted at the flag.
  const runSpecFn = spyRunSpec();
  const dryDir = tempStoreDir("ideate-run-dry-");
  await main(["--dry-run", "--results-dir", dryDir], { runSpecFn, log: () => {}, getEngineVersion: STUB_ENGINE_VERSION });
  assert.equal(runSpecFn.calls[0].opts.store.dir, dryDir, "--dry-run must not silently plan against results/");

  // --prune: the mode whose live code path DELETES. A --results-dir it
  // ignored would prune the wrong store.
  const pruneDir = tempStoreDir("ideate-run-prunedir-");
  const seeded = new ResultsStore(pruneDir);
  const key = cellKey({ armId: "A", briefId: "b1", replicate: 0, cfg: PRUNE_CFG });
  seeded.put({
    key,
    armId: "A",
    briefId: "b1",
    replicate: 0,
    cfg: PRUNE_CFG,
    result: { candidates: [] },
    resolvedModels: { proposer: "claude-haiku-4-5" },
    accounting: { state: "failed", kind: "rate_limited", detail: "429" },
    costRows: [],
  });
  const pruneLines = [];
  await main(["--prune", "--kinds", "transient", "--apply", "--results-dir", pruneDir], {
    log: (m) => pruneLines.push(m),
    getEngineVersion: STUB_ENGINE_VERSION,
    runSpecFn: spyRunSpec(),
  });
  assert.equal(new ResultsStore(pruneDir).has(key), false, "--prune operated on the flagged store");
  assert.ok(pruneLines.some((l) => l.includes(pruneDir)), "and said which store it read");

  // --phase 0: persists its controls to a store like every other mode.
  const prior = process.env.VOYAGE_API_KEY;
  process.env.VOYAGE_API_KEY = "test-key-123";
  const priorExitCode = process.exitCode;
  process.exitCode = undefined;
  try {
    const phase0Dir = tempStoreDir("ideate-run-phase0-");
    const runPhase0Fn = spyRunPhase0(PASSING_PHASE0_SUMMARY);
    await main(["--phase", "0", "--results-dir", phase0Dir], { runPhase0Fn, log: () => {}, getEngineVersion: STUB_ENGINE_VERSION });
    assert.equal(runPhase0Fn.calls[0].store.dir, phase0Dir, "--phase 0 must not silently persist to results/");
  } finally {
    if (prior === undefined) delete process.env.VOYAGE_API_KEY;
    else process.env.VOYAGE_API_KEY = prior;
    process.exitCode = priorExitCode;
  }
});

test("issue #120 AC4: every mode says which store it opened, and the cumulative spend figure carries its store as its basis", async () => {
  const dir = tempStoreDir("ideate-run-label-");
  const summary = {
    spendByProvider: { anthropic: 0.5 },
    cumulativeSpendByProvider: { anthropic: 1.5 },
    cumulativeSpendUsd: 1.75,
    cumulativeNonProviderSpendUsd: 0.25,
    cumulativeNonProviderModels: ["voyage-4-lite"],
  };
  const lines = [];
  await main(["--dry-run", "--max-spend-anthropic", "300", "--results-dir", dir], {
    runSpecFn: spyRunSpecWithSummary(summary),
    getEngineVersion: STUB_ENGINE_VERSION,
    log: (m) => lines.push(m),
  });
  const joined = lines.join("\n");
  assert.ok(lines.includes(`[store] results store: ${dir} (--results-dir)`), joined);
  // The cumulative total is what --max-spend gates on and what an operator
  // reads as "study spend". spendToDate() is cumulative over the store IN
  // USE, so the number without its store is a number that can be read as the
  // wrong study's.
  assert.ok(joined.includes(`cumulative (study-to-date in store ${dir}`), joined);
  assert.match(joined, /in THAT store only/);

  // ... and the NOT-COMPUTED branch carries it too, so the basis is never
  // separated from the (absent) number either.
  assert.match(
    formatSpendSummary({}, { storeDir: "/tmp/x" }).join("\n"),
    /cumulative \(study-to-date in store \/tmp\/x\) --- NOT COMPUTED/,
  );
});

test("issue #120: --results-dir and an injected store are mutually exclusive rather than one silently winning", async () => {
  await assert.rejects(
    () => main(["--dry-run", "--results-dir", tempStoreDir("ideate-run-both-")], { store: FAKE_STORE, runSpecFn: spyRunSpec(), log: () => {}, getEngineVersion: STUB_ENGINE_VERSION }),
    /mutually exclusive/,
  );
});

// ── THE §11 assertion ────────────────────────────────────────────────
// Two invocations, two --results-dir values, IDENTICAL configHash. The second
// must report 0 reuse. This runs the REAL runSpec (dry-run: it calls nothing)
// so that planRun -- the thing that would classify a pilot cell `reuse` -- is
// the code under test, not a spy.

test("issue #120 AC5 / PREREGISTRATION §11: a second invocation against a DIFFERENT --results-dir reuses none of the first store's cells, at the same configHash", async () => {
  const pilotDir = tempStoreDir("ideate-run-pilot-");
  const gridDir = tempStoreDir("ideate-run-grid-");
  const scope = ["--dry-run", "--arms", "A", "--briefs", "biz-01", "--replicates", "2"];

  // 1. Plan against the (empty) pilot store to learn the real cells and the
  //    real configHash this CLI builds -- never a hand-invented one.
  const first = await main([...scope, "--results-dir", pilotDir], { log: () => {}, getEngineVersion: STUB_ENGINE_VERSION });
  const planned = first.dryRun.plan.todo;
  assert.ok(planned.length > 0, "the scoped plan must have cells, or the 0-reuse assertion below is vacuous");

  // 2. Fill the PILOT store with completed cells -- i.e. the pilot ran.
  const pilotStore = new ResultsStore(pilotDir);
  for (const cell of planned) {
    pilotStore.put({
      key: cell.key,
      armId: cell.armId,
      briefId: cell.briefId,
      replicate: cell.replicate,
      cfg: cell.cfg,
      result: { candidates: [] },
      resolvedModels: { proposer: "claude-haiku-4-5" },
      accounting: { state: "completed" },
      costRows: [],
    });
  }

  // 3. THE CONTROL. Re-planning against the pilot store reuses every one of
  //    them -- which is exactly the contamination §11 forbids, and proves the
  //    0 below is caused by store separation rather than by an empty plan or
  //    a drifted config.
  const rerun = await main([...scope, "--results-dir", pilotDir], { log: () => {}, getEngineVersion: STUB_ENGINE_VERSION });
  assert.equal(rerun.dryRun.plan.reuse.length, planned.length, "same store, same config: every pilot cell is reused");
  assert.equal(rerun.dryRun.plan.todo.length, 0);

  // 4. THE GUARANTEE. Same flags, same configHash, a DIFFERENT store.
  const confirmatory = await main([...scope, "--results-dir", gridDir], { log: () => {}, getEngineVersion: STUB_ENGINE_VERSION });
  assert.equal(
    confirmatory.dryRun.plan.reuse.length,
    0,
    "PREREGISTRATION §11: the pilot's own data must not be reused in the confirmatory test",
  );
  assert.equal(confirmatory.dryRun.plan.todo.length, planned.length, "and every cell is planned afresh -- the 0 above is separation, not an empty plan");
  assert.equal(confirmatory.dryRun.plan.stale.length, 0, "nor is it a config change: the pilot cells are not even visible as stale from the other store");

  // 5. And the configHash really is identical across the two, so the pilot's
  //    variance estimate transfers (which is the whole reason the config
  //    machinery CANNOT be the separation mechanism -- issue #120).
  const cfgOf = (r) => [...new Set([...r.dryRun.plan.todo, ...r.dryRun.plan.reuse].map((c) => c.cfg))];
  assert.deepEqual(cfgOf(rerun), cfgOf(confirmatory), "same configHash in both stores -- the separation is structural, not a config divergence");

  // 6. The pilot store is untouched by the confirmatory invocation.
  assert.equal(new ResultsStore(pilotDir).keys().length, planned.length);
});
