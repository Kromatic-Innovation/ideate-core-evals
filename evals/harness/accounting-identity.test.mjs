// accounting-identity.test.mjs — an ACCOUNTING IDENTITY, not a snapshot
// (issue #53 / registered blocker B3).
//
// ── What this guards ──────────────────────────────────────────────────────
// B3 says "no token accounting in ideate-core". provider.mjs's own addUsage
// bookkeeping is easy to verify by inspection -- but that is a happy-path
// read. The real risk is a provider call that never reaches addUsage at all:
// an internal dedup pass, an evaluator step, a retry inside safeComplete,
// or (found while auditing this issue) a caller that invokes the judge
// provider directly and forgets to meter it (evals/judge/validate.mjs,
// fixed alongside this test -- see runJudgeValidation).
//
// A snapshot assertion ("this run costs exactly 1500 tokens") only proves
// today's fixture produces that number; it says nothing about whether every
// REQUEST that crossed the network was counted. An IDENTITY does: count
// requests independently at the one seam every real provider call MUST
// cross -- fetchImpl -- and assert summed tokens_by_model reproduces exactly
// that count x the known per-request usage. If a future code path calls the
// transport without going through addUsage, or addUsage drops/double-counts
// a call, the identity breaks; nothing about the fixture's specific numbers
// needs to be predicted in advance.
//
// Every seam here is faked (fetchImpl / ideateImpl / sleep), matching the
// hermetic-CI invariant documented in provider.mjs's header (CI runs
// `node --test` with an EMPTY node_modules, no `npm install` step -- see
// .github/workflows/ci.yml).

import { test } from "node:test";
import assert from "node:assert/strict";

import { AnthropicBatchProvider, OpenAIBatchProvider } from "./provider.mjs";

const CORPUS = [{ id: "brief-1", text: "Design a better bus stop." }];
const noopSleep = async () => {};
const silentLogger = () => {};

function cellFor(armId, briefId = "brief-1") {
  return { key: `arm=${armId}|brief=${briefId}|rep=0|cfg=abc`, armId, briefId, replicate: 0, cfg: "abc" };
}

function jsonResponse(status, obj) {
  return { ok: status >= 200 && status < 300, status, json: async () => obj, text: async () => JSON.stringify(obj) };
}

/**
 * A fake ideateImpl that mimics ideate-core's REAL two-round cadence: every
 * agent fires CONCURRENTLY via Promise.all for round 1, and again (if a
 * round-2 builder is supplied and round 1 produced candidates) for round 2
 * -- exactly the shape the barrier-batcher in provider.mjs is built to
 * handle (one flush per round). Every `deps.complete` invocation is counted
 * in `counter` BEFORE it resolves -- this is the independent count of
 * "provider calls the run made" the identity is checked against.
 */
function makeTwoRoundIdeateImpl(counter) {
  return async function twoRoundIdeateImpl(input, deps) {
    const { complete, agents, buildRound2Prompt } = deps;
    const round1 = await Promise.all(
      agents.map((agent) => {
        counter.n++;
        return complete({ model: agent.model, prompt: `r1 for ${agent.id}`, maxTokens: 2048 });
      }),
    );
    const candidates = [];
    round1.forEach((res, i) => {
      if (res && res.ok) candidates.push({ id: `r1-${i}`, text: `idea-r1-${i}`, model: agents[i].model, round: 1, origin: "generated" });
    });

    let round2 = [];
    if (buildRound2Prompt && candidates.length) {
      round2 = await Promise.all(
        agents.map((agent) => {
          counter.n++;
          return complete({ model: agent.model, prompt: `r2 for ${agent.id}`, maxTokens: 2048 });
        }),
      );
    }
    round2.forEach((res, i) => {
      if (res && res.ok) candidates.push({ id: `r2-${i}`, text: `idea-r2-${i}`, model: agents[i].model, round: 2, origin: "generated" });
    });

    return { candidates, agents, meta: { agentsAttempted: agents.length, agentsFailed: 0 } };
  };
}

/** One Anthropic Message-Batches JSONL result row, keyed by custom_id. */
function succeeded(custom_id, usage) {
  return { custom_id, result: { type: "succeeded", message: { content: [{ type: "text", text: '[{"text":"idea"}]' }], usage } } };
}

/**
 * A fetchImpl that routes Anthropic batch submit/results and, independently
 * of provider.mjs's own addUsage bookkeeping, tallies every request line it
 * ever answers with usage into `tally` -- the identity's other side.
 */
function anthropicIdentityFetch(tally, usagePerCall) {
  let lastSubmitted = [];
  return async (url, opts) => {
    const u = String(url);
    if (u.endsWith("/v1/messages/batches")) {
      lastSubmitted = JSON.parse(opts.body).requests;
      return jsonResponse(200, { id: `batch-${tally.batches.length}`, processing_status: "ended", results_url: `https://fake/results-${tally.batches.length}` });
    }
    if (u.startsWith("https://fake/results-")) {
      const lines = lastSubmitted.map((r) => {
        tally.requests += 1;
        tally.input_tokens += usagePerCall.input_tokens;
        tally.output_tokens += usagePerCall.output_tokens;
        return succeeded(r.custom_id, usagePerCall);
      });
      tally.batches.push(lines.length);
      return { ok: true, status: 200, text: async () => lines.map((l) => JSON.stringify(l)).join("\n") };
    }
    throw new Error(`anthropicIdentityFetch: unexpected URL ${u}`);
  };
}

function sumTokensByModel(tokensByModel, field) {
  return Object.values(tokensByModel).reduce((acc, row) => acc + (row[field] || 0), 0);
}

test("accounting identity (Anthropic, batch mode, 2 rounds x 5-agent panel): summed tokens_by_model == independently-counted provider calls x per-call usage", async () => {
  const counter = { n: 0 };
  const tally = { requests: 0, input_tokens: 0, output_tokens: 0, batches: [] };
  const usagePerCall = { input_tokens: 37, output_tokens: 11 };

  const provider = new AnthropicBatchProvider({
    apiKey: "test-key",
    corpus: CORPUS,
    armsConfig: { panel: { ideasPerAgent: 6, maxRounds: 2 }, arms: {} },
    fetchImpl: anthropicIdentityFetch(tally, usagePerCall),
    ideateImpl: makeTwoRoundIdeateImpl(counter),
    sleep: noopSleep,
    logger: silentLogger,
  });

  const arm = {
    mode: "panel",
    slots: [
      { persona: "p1", model: "claude-haiku-4-5" },
      { persona: "p2", model: "claude-haiku-4-5" },
      { persona: "p3", model: "claude-sonnet-5" },
      { persona: "p4", model: "claude-sonnet-5" },
      { persona: "p5", model: "claude-opus-5" },
    ],
  };

  const resp = await provider.generate(cellFor("Z"), arm, { mode: "batch", timestamp: "2026-09-01T00:00:00Z" });
  assert.equal(resp.terminalState, "completed");

  // Independent count: 5 agents x 2 rounds (round 1 always runs; round 2 runs
  // because round 1 produced candidates and buildRound2Prompt is truthy).
  assert.equal(counter.n, 10, "sanity: the fake engine made exactly 10 provider calls (5 agents x 2 rounds)");
  assert.equal(tally.requests, 10, "sanity: exactly 10 requests crossed the fetchImpl transport boundary");
  assert.deepEqual(tally.batches, [5, 5], "one batch flush per round, 5 requests each");

  // The identity: what addUsage recorded must equal what independently
  // crossed the transport, with NO adjustment or fudge factor.
  const byModel = resp.tokens.tokens_by_model;
  assert.equal(sumTokensByModel(byModel, "input_tokens"), tally.input_tokens);
  assert.equal(sumTokensByModel(byModel, "output_tokens"), tally.output_tokens);
  assert.equal(sumTokensByModel(byModel, "input_tokens"), counter.n * usagePerCall.input_tokens);
  assert.equal(sumTokensByModel(byModel, "output_tokens"), counter.n * usagePerCall.output_tokens);

  // Per-model breakdown must also add up exactly: 2 calls/agent x per-model
  // agent count x usagePerCall, for every model in the panel.
  assert.equal(byModel["claude-haiku-4-5"].input_tokens, 2 * 2 * usagePerCall.input_tokens); // 2 haiku agents
  assert.equal(byModel["claude-sonnet-5"].input_tokens, 2 * 2 * usagePerCall.input_tokens); // 2 sonnet agents
  assert.equal(byModel["claude-opus-5"].input_tokens, 2 * 1 * usagePerCall.input_tokens); // 1 opus agent
});

test("accounting identity (Anthropic, single mode): every fetch call's usage is captured exactly once, even across a partial-failure cell", async () => {
  const counter = { n: 0 };
  let succeededCalls = 0;
  let seenCalls = 0;
  const usagePerCall = { input_tokens: 20, output_tokens: 9 };

  const provider = new AnthropicBatchProvider({
    apiKey: "test-key",
    corpus: CORPUS,
    armsConfig: { panel: { ideasPerAgent: 6, maxRounds: 1 }, arms: {} },
    fetchImpl: async () => {
      seenCalls += 1;
      // Every 3rd underlying call fails transport (never returns usage) --
      // the identity must hold over the SURVIVING calls only.
      if (seenCalls % 3 === 0) return jsonResponse(500, {});
      succeededCalls += 1;
      return jsonResponse(200, { content: [{ type: "text", text: '[{"text":"idea"}]' }], usage: usagePerCall });
    },
    ideateImpl: makeTwoRoundIdeateImpl(counter), // maxRounds:1 in armsConfig, but resolveIdeateAgents controls that -- here we bypass resolveIdeateAgents entirely since we build `arm`/agents ourselves via a raw fake ideateImpl call
    maxRetries: 0,
    sleep: noopSleep,
    logger: silentLogger,
  });

  const arm = {
    mode: "panel",
    slots: Array.from({ length: 9 }, (_, i) => ({ persona: `p${i}`, model: "claude-sonnet-5" })),
  };

  const resp = await provider.generate(cellFor("Z2"), arm, { mode: "single", timestamp: "2026-09-01T00:00:00Z" });
  // round 1 only (no round2 fake invoked because ideateImpl here still tries
  // round 2, but only if round1 produced candidates -- some agents fail, some
  // succeed, so round 2 still runs; that's fine, the identity holds regardless
  // of how many calls were made, only that every SUCCESSFUL one is counted).
  assert.ok(resp.terminalState === "completed" || resp.terminalState === "failed");

  const byModel = resp.tokens.tokens_by_model;
  assert.equal(sumTokensByModel(byModel, "input_tokens"), succeededCalls * usagePerCall.input_tokens);
  assert.equal(sumTokensByModel(byModel, "output_tokens"), succeededCalls * usagePerCall.output_tokens);
  assert.ok(succeededCalls > 0 && succeededCalls < seenCalls, "sanity: the fixture actually mixed successes and failures");
});

test("accounting identity (OpenAI, batch mode): summed tokens_by_model == independently-counted provider calls x per-call usage", async () => {
  const counter = { n: 0 };
  const tally = { requests: 0, prompt_tokens: 0, completion_tokens: 0 };
  const usagePerCall = { prompt_tokens: 44, completion_tokens: 13 };
  let submittedLines = [];

  const fetchImpl = async (url, opts) => {
    const u = String(url);
    if (u === "https://api.openai.com/v1/files" && opts.method === "POST") {
      const text = await opts.body.get("file").text();
      submittedLines = text.split("\n").filter(Boolean).map((l) => JSON.parse(l));
      return jsonResponse(200, { id: "file_1" });
    }
    if (u === "https://api.openai.com/v1/batches" && opts.method === "POST") {
      return jsonResponse(200, { id: "batch_1", status: "completed", output_file_id: "out_1" });
    }
    if (u === "https://api.openai.com/v1/files/out_1/content") {
      const lines = submittedLines.map((r) => {
        tally.requests += 1;
        tally.prompt_tokens += usagePerCall.prompt_tokens;
        tally.completion_tokens += usagePerCall.completion_tokens;
        return { custom_id: r.custom_id, response: { status_code: 200, body: { choices: [{ message: { content: '[{"text":"idea"}]' } }], usage: usagePerCall } }, error: null };
      });
      return { ok: true, status: 200, text: async () => lines.map((l) => JSON.stringify(l)).join("\n") };
    }
    throw new Error(`unexpected OpenAI URL ${u}`);
  };

  const provider = new OpenAIBatchProvider({
    apiKey: "test-key",
    corpus: CORPUS,
    armsConfig: { panel: { ideasPerAgent: 6, maxRounds: 1 }, arms: {} },
    fetchImpl,
    ideateImpl: makeTwoRoundIdeateImpl(counter),
    sleep: noopSleep,
    logger: silentLogger,
  });

  const arm = {
    mode: "panel",
    slots: [
      { persona: "p1", model: "gpt-5.6-terra" },
      { persona: "p2", model: "gpt-5.6-terra" },
      { persona: "p3", model: "gpt-5.6-sol" },
    ],
  };

  const resp = await provider.generate(cellFor("Z3"), arm, { mode: "batch", timestamp: "2026-09-01T00:00:00Z" });
  assert.equal(resp.terminalState, "completed");

  const byModel = resp.tokens.tokens_by_model;
  // OpenAI usage maps prompt_tokens/completion_tokens -> input_tokens/output_tokens.
  assert.equal(sumTokensByModel(byModel, "input_tokens"), tally.requests * usagePerCall.prompt_tokens);
  assert.equal(sumTokensByModel(byModel, "output_tokens"), tally.requests * usagePerCall.completion_tokens);
  assert.equal(tally.requests, counter.n, "every provider call the fake engine made crossed the transport exactly once");
});
