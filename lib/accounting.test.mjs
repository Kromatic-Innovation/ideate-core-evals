// Tests for the anti-swallow guarantee and the repriceable cost ledger.
// Hermetic: no network, no provider calls, no keys.
import { test } from "node:test";
import assert from "node:assert/strict";
import { RunAccount, costRow, FAILURE_KINDS } from "./accounting.mjs";

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

test("a cost row for an unplanned cell is rejected", () => {
  const acct = new RunAccount(KEYS);
  assert.throws(
    () => acct.addCost(costRow({ cellKey: "arm=Z|brief=b9|rep=0|cfg=abc", timestamp: TS, billing_mode: "api", model: "m" })),
    /unplanned cell/,
  );
});
