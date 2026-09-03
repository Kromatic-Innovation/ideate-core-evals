// Tests for the anti-swallow guarantee and the repriceable cost ledger.
// Hermetic: no network, no provider calls, no keys.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  RunAccount,
  costRow,
  FAILURE_KINDS,
  INTRINSIC_FAILURE_KINDS,
  TRANSIENT_FAILURE_KINDS,
  PAYMENT_FAILURE_KINDS,
  isTransientFailure,
  isPaymentFailure,
} from "./accounting.mjs";

const KEYS = ["arm=A|brief=b1|rep=0|cfg=abc", "arm=A|brief=b2|rep=0|cfg=abc"];
const TS = "2026-07-30T12:00:00Z";

// ── The core guarantee: a dropped cell is a hard error, not a quiet gap ──────

test("reconcile THROWS when a planned cell never reached a terminal state", () => {
  const acct = new RunAccount(KEYS);
  acct.complete(KEYS[0], { distinct_k: 7 });
  // KEYS[1] deliberately left unrecorded — the silent-drop scenario.
  assert.throws(
    () => acct.reconcile(),
    (e) => /never reached a terminal state/.test(e.message) && e.message.includes(KEYS[1]),
    "an unaccounted cell must fail loudly and name itself",
  );
});

test("reconcile passes only when every planned cell is terminal, and counts them", () => {
  const acct = new RunAccount(KEYS);
  acct.complete(KEYS[0], { distinct_k: 7 });
  acct.fail(KEYS[1], "empty_pool", "candidates: []");
  const summary = acct.reconcile();
  assert.deepEqual(summary, {
    planned: 2, completed: 1, failed: 1, skipped: 0, byKind: { empty_pool: 1 }, skippedByReason: {},
  });
});

// ── issue #85 fix round (PR #86 review): skip reasons must not be conflated ──
// `metrics_failed` and `budget_exceeded` mean opposite things to an operator
// ("the embedder is failing" vs "you hit your ceiling") and Phase 2a's
// written go/no-go depends on telling them apart -- a single undifferentiated
// `summary.skipped` count would make that judgement unreadable.
test("reconcile groups skip reasons by their category (the text before the first colon), never merging distinct reasons into one bucket", () => {
  const keys = ["arm=A|brief=b1|rep=0|cfg=abc", "arm=A|brief=b2|rep=0|cfg=abc", "arm=A|brief=b3|rep=0|cfg=abc", "arm=A|brief=b4|rep=0|cfg=abc"];
  const acct = new RunAccount(keys);
  acct.skip(keys[0], "budget_exceeded");
  acct.skip(keys[1], "budget_exceeded:anthropic"); // same category, different dynamic suffix
  acct.skip(keys[2], "metrics_failed: pool metrics failed for cell 'x': embedder threw");
  acct.skip(keys[3], "metrics_failed: a completely different embedder error message");
  const summary = acct.reconcile();
  assert.equal(summary.skipped, 4);
  assert.deepEqual(
    summary.skippedByReason,
    { budget_exceeded: 2, metrics_failed: 2 },
    "two distinct reason categories must each keep their own count, even though each category's own two instances carry different dynamic detail text",
  );
});

test("a failure is retained as a classified datum, never discarded", () => {
  const acct = new RunAccount(KEYS);
  acct.fail(KEYS[0], "refusal", "stop_reason=refusal category=cyber");
  acct.fail(KEYS[1], "parse_failure", "extractCandidates returned []");
  const s = acct.reconcile();
  assert.equal(s.failed, 2);
  assert.deepEqual(s.byKind, { refusal: 1, parse_failure: 1 });
});

test("an unclassified failure kind is rejected", () => {
  const acct = new RunAccount(KEYS);
  assert.throws(() => acct.fail(KEYS[0], "went_wrong"), /unknown failure kind/);
  assert.ok(FAILURE_KINDS.includes("empty_pool"));
  assert.ok(FAILURE_KINDS.includes("harness_error"), "our own bugs must be classifiable, not absorbed");
});

test("completing with no payload is rejected — a success with no result is a silent drop", () => {
  const acct = new RunAccount(KEYS);
  assert.throws(() => acct.complete(KEYS[0]), /needs a result object/);
  assert.throws(() => acct.complete(KEYS[0], null), /needs a result object/);
});

test("a cell cannot be recorded twice, and an unplanned cell cannot be recorded at all", () => {
  const acct = new RunAccount(KEYS);
  acct.complete(KEYS[0], { distinct_k: 3 });
  assert.throws(() => acct.fail(KEYS[0], "timeout"), /already terminal/);
  assert.throws(() => acct.complete("arm=Z|brief=b9|rep=0|cfg=abc", {}), /never planned/);
});

test("skip requires a stated reason", () => {
  const acct = new RunAccount(KEYS);
  assert.throws(() => acct.skip(KEYS[0]), /requires a reason/);
  acct.skip(KEYS[0], "over --max-spend ceiling");
  acct.skip(KEYS[1], "provider key absent");
  assert.equal(acct.reconcile().skipped, 2);
});

// ── Cost ledger conforms to the CFO contract (cwc#1639 / cron-fleet#75) ──────

test("costRow records tokens x model x timestamp and REFUSES a dollar figure", () => {
  const row = costRow({
    cellKey: KEYS[0], timestamp: TS, billing_mode: "api",
    model: "claude-haiku-4-5", input_tokens: 1200, output_tokens: 800,
  });
  assert.equal(row.model, "claude-haiku-4-5");
  assert.equal(row.input_tokens, 1200);
  assert.equal(row.billing_mode, "api");
  assert.ok(!("cost_usd" in row), "the ledger must never persist a derived dollar figure");

  assert.throws(
    () => costRow({ cellKey: KEYS[0], timestamp: TS, billing_mode: "api", model: "m", cost_usd: 0.12 }),
    /dollar figures are never stored/,
  );
});

test("costRow requires model or tokens_by_model — an unrepriceable row is rejected", () => {
  assert.throws(
    () => costRow({ cellKey: KEYS[0], timestamp: TS, billing_mode: "api", input_tokens: 10 }),
    /can never be repriced/,
  );
  // Mixed-tier arms span models, so per-model token counts are the only
  // shape that stays repriceable when one model's rate changes.
  const row = costRow({
    cellKey: KEYS[0], timestamp: TS, billing_mode: "api",
    tokens_by_model: {
      "claude-haiku-4-5": { input_tokens: 900, output_tokens: 600 },
      "claude-opus-5": { input_tokens: 400, output_tokens: 300 },
    },
  });
  assert.equal(Object.keys(row.tokens_by_model).length, 2);
});

test("costRow preserves null token counts rather than coercing them to zero", () => {
  const row = costRow({
    cellKey: KEYS[0], timestamp: TS, billing_mode: "api",
    model: "m", input_tokens: null, output_tokens: 42,
  });
  assert.equal(row.input_tokens, null, "'not reported' must stay distinct from 'zero used'");
  assert.equal(row.output_tokens, 42);
});

test("costRow rejects an unknown billing_mode and a missing timestamp", () => {
  assert.throws(() => costRow({ cellKey: KEYS[0], timestamp: TS, billing_mode: "free", model: "m" }), /billing_mode/);
  assert.throws(() => costRow({ cellKey: KEYS[0], billing_mode: "api", model: "m" }), /timestamp is required/);
});

// ── issue #119: pricing_regime -- optional, validated, independent of billing_mode ──

test("costRow accepts an optional pricing_regime, independent of billing_mode", () => {
  const batchRow = costRow({
    cellKey: KEYS[0], timestamp: TS, billing_mode: "api", pricing_regime: "batch",
    model: "claude-haiku-4-5", input_tokens: 100, output_tokens: 50,
  });
  assert.equal(batchRow.pricing_regime, "batch");
  assert.equal(batchRow.billing_mode, "api", "pricing_regime does not replace or collapse into billing_mode");

  const singleRow = costRow({
    cellKey: KEYS[0], timestamp: TS, billing_mode: "api", pricing_regime: "single",
    model: "claude-haiku-4-5", input_tokens: 100, output_tokens: 50,
  });
  assert.equal(singleRow.pricing_regime, "single");
});

test("costRow omits pricing_regime entirely when not given -- a legacy row, not an error", () => {
  const row = costRow({ cellKey: KEYS[0], timestamp: TS, billing_mode: "api", model: "m", input_tokens: 1 });
  assert.ok(!("pricing_regime" in row), "absence must be a real absence, not a stored null/undefined");
});

test("costRow rejects an invalid pricing_regime value", () => {
  assert.throws(
    () => costRow({ cellKey: KEYS[0], timestamp: TS, billing_mode: "api", pricing_regime: "batched", model: "m" }),
    /pricing_regime must be "batch" or "single"/,
  );
});

test("a cost row for an unplanned cell is rejected", () => {
  const acct = new RunAccount(KEYS);
  assert.throws(
    () => acct.addCost(costRow({ cellKey: "arm=Z|brief=b9|rep=0|cfg=abc", timestamp: TS, billing_mode: "api", model: "m" })),
    /unplanned cell/,
  );
});

// ── issue #90: the transient / cell-intrinsic split ─────────────────────────
// This taxonomy is what evals/harness/runner.mjs consults to decide whether a
// failed cell is written under cell.key (permanent, because the store is
// append-only and planRun sees only keys) or kept out of it so a later run
// re-attempts it. Both directions of a mistake are silent, so the membership
// itself is asserted rather than left to a comment.

test("issue #90 / #88: FAILURE_KINDS is exactly the union of the intrinsic, transient and payment sets -- every kind is classified, none twice", () => {
  assert.deepEqual(
    FAILURE_KINDS,
    [...INTRINSIC_FAILURE_KINDS, ...TRANSIENT_FAILURE_KINDS, ...PAYMENT_FAILURE_KINDS],
    "evals/harness/provider.mjs validates every provider-reported failureKind against FAILURE_KINDS -- it must stay the whole vocabulary",
  );
  assert.equal(new Set(FAILURE_KINDS).size, FAILURE_KINDS.length, "no kind appears in two sets");
  for (const kind of FAILURE_KINDS) {
    const memberships = [INTRINSIC_FAILURE_KINDS, TRANSIENT_FAILURE_KINDS, PAYMENT_FAILURE_KINDS].filter((s) =>
      s.includes(kind),
    ).length;
    assert.equal(
      memberships,
      1,
      `'${kind}' must be in exactly one of the three sets -- an unclassified kind is an unanswered retryability question`,
    );
  }
});

// ── issue #88: payment is a third category, not a member of either set ──────
test("issue #88: payment_required is neither transient nor cell-intrinsic", () => {
  assert.equal(FAILURE_KINDS.includes("payment_required"), true);
  assert.equal(isPaymentFailure("payment_required"), true);
  // NOT transient: retrying it inside this invocation is futile -- the
  // runner must abort the remaining plan, not re-attempt into the same wall.
  assert.equal(isTransientFailure("payment_required"), false);
  // NOT intrinsic: an empty credit balance says nothing about the arm, so it
  // must never be stored under cell.key. (The runner enforces the
  // store-absent half; see runner.test.mjs.)
  assert.equal(INTRINSIC_FAILURE_KINDS.includes("payment_required"), false);
});

test("issue #88: an unknown kind is NOT a payment failure -- a taxonomy gap must never silently abort a run", () => {
  assert.equal(isPaymentFailure("went_wrong"), false);
  assert.equal(isPaymentFailure(undefined), false);
  assert.equal(isPaymentFailure(""), false);
});

test("issue #88: payment_required is an ordinary failure on the account -- it counts in byKind like any other", () => {
  const acct = new RunAccount(["k1"]);
  acct.fail("k1", "payment_required", "anthropic: credit balance too low");
  const summary = acct.reconcile();
  assert.equal(summary.failed, 1);
  assert.equal(summary.byKind.payment_required, 1);
});

test("issue #90: an environmental fault is transient; an observation about the arm is not", () => {
  // Transient: facts about the night we ran, not about the arm. Freezing one
  // into the dataset bricks a cell nothing was wrong with -- and does so
  // arm-correlated (a panel arm makes ~5x the calls, so it eats rate limits
  // preferentially), which confounds H1.
  for (const kind of ["rate_limited", "timeout", "transport_error", "budget_exceeded", "harness_error"]) {
    assert.equal(isTransientFailure(kind), true, `${kind} must not permanently consume its cell`);
  }
  // Intrinsic: real measurements. Retrying one is resampling until the arm
  // looks better than it is, and reports a failure rate of zero for a
  // genuine behaviour of the model.
  for (const kind of ["parse_failure", "empty_pool", "refusal"]) {
    assert.equal(isTransientFailure(kind), false, `${kind} is a datum about the arm and must store as terminal`);
  }
});

test("issue #90: an unknown kind is NOT transient -- a taxonomy gap fails toward terminal, never toward an infinite re-spending retry loop", () => {
  assert.equal(isTransientFailure("went_wrong"), false);
  assert.equal(isTransientFailure(undefined), false);
  assert.equal(isTransientFailure(""), false);
});

test("issue #90: both sets are still ordinary failures on the account -- the split governs persistence, not accounting", () => {
  const acct = new RunAccount(KEYS);
  acct.fail(KEYS[0], "rate_limited", "429 after retries");
  acct.fail(KEYS[1], "refusal", "stop_reason=refusal");
  const s = acct.reconcile();
  assert.equal(s.failed, 2, "a transient failure is still a failure for THIS invocation -- it is never a silent drop");
  assert.deepEqual(s.byKind, { rate_limited: 1, refusal: 1 });
});
