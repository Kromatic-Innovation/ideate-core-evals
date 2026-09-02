// Tests for the provider interface contract and the hermetic MockProvider.
// No network, no timers, no real provider calls -- this is what makes the
// runner tests in runner.test.mjs / integration.test.mjs hermetic.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MockProvider,
  assertValidProviderResponse,
  AnthropicBatchProvider,
  OpenAIBatchProvider,
  isBillingRefusal,
  classifyTransportKind,
  classifyTransportOutcome,
  pickFailureKind,
} from "./provider.mjs";

const ARM = {
  mode: "panel",
  slots: [
    { persona: "proposer_1", model: "claude-haiku-4-5" },
    { persona: "proposer_2", model: "claude-haiku-4-5" },
  ],
};
const CELL = { key: "arm=B|brief=b1|rep=0|cfg=abc", armId: "B", briefId: "b1", replicate: 0, cfg: "abc" };

test("assertValidProviderResponse rejects a 'skipped' terminalState -- providers never skip, the runner does", () => {
  assert.throws(
    () => assertValidProviderResponse({ terminalState: "skipped" }),
    /"completed" or "failed"/,
  );
});

test("assertValidProviderResponse requires a recognized failureKind on a failed response", () => {
  assert.throws(
    () => assertValidProviderResponse({ terminalState: "failed", failureKind: "made_up_kind" }),
    /unrecognized failureKind/,
  );
  assert.doesNotThrow(() => assertValidProviderResponse({ terminalState: "failed", failureKind: "timeout" }));
});

test("assertValidProviderResponse requires a result object on a completed response", () => {
  assert.throws(
    () => assertValidProviderResponse({ terminalState: "completed" }),
    /must carry a result object/,
  );
});

test("MockProvider.generate returns a completed response by default and records the call", async () => {
  const provider = new MockProvider();
  const resp = await provider.generate(CELL, ARM, { mode: "batch" });
  assert.equal(resp.terminalState, "completed");
  assert.ok(resp.result.candidates.length > 0);
  assert.ok(resp.tokens.tokens_by_model["claude-haiku-4-5"]);
  assert.deepEqual(provider.calls, [{ key: CELL.key, armId: "B", mode: "batch" }]);
});

test("MockProvider honors per-cell overrides to script a forced failure", async () => {
  const overrides = new Map([[CELL.key, { terminalState: "failed", failureKind: "refusal", detail: "stop_reason=refusal" }]]);
  const provider = new MockProvider({ overrides });
  const resp = await provider.generate(CELL, ARM, { mode: "batch" });
  assert.equal(resp.terminalState, "failed");
  assert.equal(resp.failureKind, "refusal");
});

test("MockProvider records the mode it was called with -- how the runner's batch-vs-single choice is observable", async () => {
  const provider = new MockProvider();
  await provider.generate(CELL, ARM, { mode: "single" });
  assert.equal(provider.calls[0].mode, "single");
});

test("OpenAIBatchProvider is no longer a stub -- constructing it does not throw, and a missing key returns a classified failure rather than throwing (issue #22)", async () => {
  assert.doesNotThrow(() => new OpenAIBatchProvider({ apiKey: "test-key", corpus: [], armsConfig: { arms: {} } }));
  // Explicit falsy key so this does not depend on process.env.OPENAI_API_KEY.
  const resp = await new OpenAIBatchProvider({ apiKey: "" }).generate({ briefId: "b" }, { slots: [] }, { mode: "batch" });
  assert.equal(resp.terminalState, "failed");
  assert.equal(resp.failureKind, "harness_error");
});

test("AnthropicBatchProvider is no longer a stub -- constructing it does not throw (issue #19)", () => {
  assert.doesNotThrow(() => new AnthropicBatchProvider({ apiKey: "test-key", corpus: [], armsConfig: { arms: {} } }));
});

// ── issue #88: billing/credit refusal detection ─────────────────────────────
// Keyed on the response BODY, never on status: 400 covers a malformed request,
// an oversized max_tokens and an unfunded account alike, and 429 covers both an
// ordinary rate limit and (on OpenAI) quota exhaustion.

/** VERBATIM, as observed 2026-09-02 -- request_id req_011CeejUhYyYfutJc9YTHFnd. */
const CREDIT_EXHAUSTED_400 = {
  type: "error",
  error: {
    type: "invalid_request_error",
    message:
      "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.",
  },
  request_id: "req_011CeejUhYyYfutJc9YTHFnd",
};

test("issue #88: isBillingRefusal recognizes the real Anthropic credit-exhaustion body", () => {
  assert.equal(isBillingRefusal(400, CREDIT_EXHAUSTED_400), true);
  // Same body arriving as raw text (a helper that could not parse the JSON)
  // is still recognized -- the message is the signal.
  assert.equal(isBillingRefusal(400, JSON.stringify(CREDIT_EXHAUSTED_400)), true);
});

test("issue #88: isBillingRefusal recognizes OpenAI's insufficient_quota (documentation-derived signature)", () => {
  assert.equal(
    isBillingRefusal(429, {
      error: {
        message: "You exceeded your current quota, please check your plan and billing details.",
        type: "insufficient_quota",
        param: null,
        code: "insufficient_quota",
      },
    }),
    true,
  );
});

test("issue #88: isBillingRefusal says no to every non-billing failure, and never throws on junk input", () => {
  // Other 400s -- the exact overloading that makes status-keying wrong.
  assert.equal(isBillingRefusal(400, { type: "error", error: { type: "invalid_request_error", message: "max_tokens: 999999 > 8192" } }), false);
  assert.equal(isBillingRefusal(401, { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }), false);
  // An ordinary rate limit must stay rate_limited, or every 429 aborts the run.
  assert.equal(isBillingRefusal(429, { type: "error", error: { type: "rate_limit_error", message: "Number of requests has exceeded your rate limit" } }), false);
  assert.equal(isBillingRefusal(500, { error: "boom" }), false);
  // Junk: a rejected fetch's Error, no body at all, a bare string, a null.
  // A detector that can crash the classifier is worse than the bug it fixes.
  assert.equal(isBillingRefusal(undefined, new Error("ECONNRESET")), false);
  assert.equal(isBillingRefusal(400, undefined), false);
  assert.equal(isBillingRefusal(400, null), false);
  assert.equal(isBillingRefusal(400, "Bad Request"), false);
  assert.equal(isBillingRefusal(400, 42), false);
});

test("issue #88: classifyTransportKind returns payment_required on a billing body and is unchanged otherwise", () => {
  assert.equal(classifyTransportKind(400, CREDIT_EXHAUSTED_400), "payment_required");
  assert.equal(classifyTransportKind(429, CREDIT_EXHAUSTED_400), "payment_required", "the body outranks a retryable status");
  assert.equal(classifyTransportKind(429), "rate_limited");
  assert.equal(classifyTransportKind(500), "transport_error");
  assert.equal(classifyTransportKind(400), "transport_error");
});

test("issue #88: classifyTransportOutcome flags paymentRequired instead of rateLimited/transportError", () => {
  const billing = {};
  classifyTransportOutcome(429, undefined, billing, CREDIT_EXHAUSTED_400);
  assert.deepEqual(billing, { paymentRequired: true });

  const limited = {};
  classifyTransportOutcome(429, undefined, limited, { error: { type: "rate_limit_error", message: "slow down" } });
  assert.deepEqual(limited, { rateLimited: true });

  const transport = {};
  classifyTransportOutcome(500, undefined, transport, { error: "boom" });
  assert.deepEqual(transport, { transportError: true });
});

test("issue #88: pickFailureKind ranks payment_required above every other flag, timeout included", () => {
  // A cell that both blew the poll ceiling AND saw a credit refusal must
  // report the refusal -- otherwise the runner's abort never fires and the
  // run reads as a slow night rather than an unpayable account.
  assert.equal(pickFailureKind({ paymentRequired: true, timedOut: true, rateLimited: true, transportError: true }, "empty_pool"), "payment_required");
  assert.equal(pickFailureKind({ timedOut: true, rateLimited: true }, "empty_pool"), "timeout");
  assert.equal(pickFailureKind({}, "empty_pool"), "empty_pool");
});
