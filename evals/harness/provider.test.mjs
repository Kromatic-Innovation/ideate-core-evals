// Tests for the provider interface contract and the hermetic MockProvider.
// No network, no timers, no real provider calls -- this is what makes the
// runner tests in runner.test.mjs / integration.test.mjs hermetic.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MockProvider, assertValidProviderResponse, AnthropicBatchProvider, OpenAIBatchProvider } from "./provider.mjs";

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
