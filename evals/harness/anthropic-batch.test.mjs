// anthropic-batch.test.mjs — hermetic tests for AnthropicBatchProvider
// (issue #19). No network, no real ideate-core call, no timers that actually
// wait -- every seam AnthropicBatchProvider exposes (fetchImpl, ideateImpl,
// sleep) is faked here, which is what keeps this file loadable under CI's
// `node --test` with an EMPTY node_modules (see the hermetic-CI invariant
// documented at the top of evals/harness/provider.mjs).
//
// Two kinds of fake `ideateImpl` are used below:
//   - `soloIdeateImpl` / `panelIdeateImpl`: mimic just enough of the REAL
//     ideate-core's calling convention (call `deps.complete({model, prompt,
//     temperature, ...})` once per agent, per round) to exercise the
//     provider's actual `complete` closure (the barrier-batcher, force-strip,
//     token capture) end-to-end, without importing ideate-core itself.
//   - a raw fake for the empty-pool / all-agents-failed cases, which just
//     returns a canned ideateCore-shaped result directly.
import { test } from "node:test";
import assert from "node:assert/strict";

import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  AnthropicBatchProvider,
  resolveIdeateAgents,
  buildAnthropicMessageParams,
  DEFAULT_MAX_POLL_MS,
} from "./provider.mjs";
import { runSpec } from "./runner.mjs";
import { ResultsStore } from "../../lib/store.mjs";
import { cellKey, configHash, planRun } from "../../lib/manifest.mjs";

const armsConfigJson = JSON.parse(
  await (await import("node:fs")).promises.readFile(new URL("../../arms.config.json", import.meta.url), "utf8"),
);

const CORPUS = [{ id: "brief-1", text: "Design a better bus stop." }];

function armsConfigFor(...armIds) {
  const arms = {};
  for (const id of armIds) arms[id] = armsConfigJson.arms[id];
  return { panel: armsConfigJson.panel, arms };
}

function cellFor(armId, briefId = "brief-1") {
  return { key: `arm=${armId}|brief=${briefId}|rep=0|cfg=abc`, armId, briefId, replicate: 0, cfg: "abc" };
}

const noopSleep = async () => {};
const silentLogger = () => {};

/**
 * A fake ideateImpl that drives deps.complete like ideate-core's real round-1
 * loop does: fire every agent CONCURRENTLY via Promise.all (so the provider's
 * barrier-batcher sees them all pushed within one microtask tick, exactly
 * like the real engine), parse each reply as a JSON array of {text}, and
 * return the ideateCore-shaped {candidates, agents, meta} result. No round 2.
 */
async function fakeIdeateImpl(input, deps) {
  const { complete, agents } = deps;
  const results = await Promise.all(
    agents.map((agent) =>
      complete({
        model: agent.model,
        prompt: `${deps.buildRound1Prompt({ context: input.context, persona: agent.persona, ideasPerAgent: agent.ideasPerAgent })}`,
        temperature: 0.7, // ideate-core ALWAYS sends this -- see DEFAULT_PERSONAS; the adapter must ignore it
        top_p: 0.9,
        maxTokens: 2048,
        persona: agent.persona,
      }),
    ),
  );
  const candidates = [];
  let agentsFailed = 0;
  results.forEach((res, i) => {
    if (!res || res.ok !== true) {
      agentsFailed++;
      return;
    }
    let raw;
    try {
      raw = JSON.parse(res.text);
    } catch {
      raw = [];
    }
    for (const c of raw) {
      if (c && typeof c.text === "string" && c.text) {
        candidates.push({ id: `${agents[i].id}-${candidates.length}`, text: c.text, agentId: agents[i].id, model: agents[i].model, persona: agents[i].persona, round: 1, origin: "generated" });
      }
    }
  });
  return {
    candidates,
    agents,
    meta: { agentsAttempted: agents.length, agentsFailed },
  };
}

// ── Arm -> ideate-core invocation mapping ────────────────────────────────────

test("resolveIdeateAgents: Arm A (solo) maps to a single agent, ideasPerAgent from totalIdeasRequested, maxRounds 1", () => {
  const arm = armsConfigJson.arms.A;
  const { agents, maxRounds } = resolveIdeateAgents(arm, armsConfigJson);
  assert.equal(agents.length, 1);
  assert.equal(agents[0].model, "claude-sonnet-5");
  assert.equal(agents[0].ideasPerAgent, 30);
  assert.equal(maxRounds, 1);
});

test("resolveIdeateAgents: a panel arm maps one agent per slot, panel.ideasPerAgent/maxRounds from armsConfig", () => {
  const arm = armsConfigJson.arms.E; // tiered mix -- 2xHaiku, 2xSonnet, 1xOpus
  const { agents, maxRounds } = resolveIdeateAgents(arm, armsConfigJson);
  assert.equal(agents.length, 5);
  assert.deepEqual(agents.map((a) => a.model), ["claude-haiku-4-5", "claude-haiku-4-5", "claude-sonnet-5", "claude-sonnet-5", "claude-opus-5"]);
  assert.equal(maxRounds, armsConfigJson.panel.maxRounds);
  assert.ok(agents.every((a) => a.ideasPerAgent === armsConfigJson.panel.ideasPerAgent));
  // agent ids are unique even though two slots share persona "proposer_1" across
  // DIFFERENT arms is not the case here, but WITHIN one arm ids must still be
  // distinguishable per spec (`${slot.persona}#${i}`).
  assert.equal(new Set(agents.map((a) => a.id)).size, 5);
});

test("generate() covers the solo path (Arm A) end-to-end via a fake ideateImpl and completes", async () => {
  const fetchImpl = async (url, opts) => {
    const body = JSON.parse(opts.body);
    return jsonResponse(200, { id: "batch_1", processing_status: "ended", results_url: "https://fake/results" });
  };
  // Not exercised directly -- generate() below routes to #completeBatched,
  // which needs both the submit AND the results fetch; build a routing fake.
  const provider = new AnthropicBatchProvider({
    apiKey: "test-key",
    corpus: CORPUS,
    armsConfig: armsConfigFor("A"),
    fetchImpl: routingFetch({
      onSubmit: (body) => ({
        id: "batch_1",
        processing_status: "ended",
        results_url: "https://fake/results",
      }),
      onResults: (body, submitted) => submitted.requests.map((r) => resultLine(r.custom_id, textResult(`[{"text":"idea for ${r.custom_id}"}]`))),
    }),
    ideateImpl: fakeIdeateImpl,
    sleep: noopSleep,
    logger: silentLogger,
  });

  const resp = await provider.generate(cellFor("A"), armsConfigJson.arms.A, { mode: "batch", timestamp: "2026-08-02T00:00:00Z" });
  assert.equal(resp.terminalState, "completed");
  assert.equal(resp.result.candidates.length, 1); // solo: one agent, one reply of one candidate in this fake
});

test("generate() covers the panel path end-to-end via a fake ideateImpl and completes", async () => {
  const provider = new AnthropicBatchProvider({
    apiKey: "test-key",
    corpus: CORPUS,
    armsConfig: armsConfigFor("B"),
    fetchImpl: routingFetch({
      onSubmit: () => ({ id: "batch_2", processing_status: "ended", results_url: "https://fake/results" }),
      onResults: (body, submitted) =>
        submitted.requests.map((r) => resultLine(r.custom_id, textResult(`[{"text":"idea A"},{"text":"idea B"}]`))),
    }),
    ideateImpl: fakeIdeateImpl,
    sleep: noopSleep,
    logger: silentLogger,
  });

  const resp = await provider.generate(cellFor("B"), armsConfigJson.arms.B, { mode: "batch", timestamp: "2026-08-02T00:00:00Z" });
  assert.equal(resp.terminalState, "completed");
  // Arm B is a 5-agent homogeneous-Haiku panel; each agent's fake reply has 2 candidates.
  assert.equal(resp.result.candidates.length, 10);
});

// ── Force-strip: no temperature/top_p/top_k for ANY model, Haiku included ───

test("buildAnthropicMessageParams never carries temperature/top_p/top_k, for every model in arms.config.json (Haiku included)", () => {
  const modelIds = new Set();
  for (const arm of Object.values(armsConfigJson.arms)) {
    for (const slot of arm.slots || []) {
      if (slot.model && slot.model.startsWith("claude-")) modelIds.add(slot.model); // Anthropic ids only -- OpenAI is a separate adapter/issue
    }
  }
  assert.ok(modelIds.has("claude-haiku-4-5"), "sanity: Haiku must be among the models under test");
  for (const model of modelIds) {
    const params = buildAnthropicMessageParams({ model, prompt: "hi", temperature: 0.9, top_p: 0.8, top_k: 40, maxTokens: 111 });
    assert.equal(params.model, model);
    assert.equal(params.max_tokens, 111);
    assert.ok(!("temperature" in params), `model ${model} must not carry temperature`);
    assert.ok(!("top_p" in params), `model ${model} must not carry top_p`);
    assert.ok(!("top_k" in params), `model ${model} must not carry top_k`);
  }
});

test("force-strip end-to-end: a fake fetchImpl captures every submitted batch request and none carries temperature/top_p/top_k, across a Haiku panel", async () => {
  const captured = [];
  const provider = new AnthropicBatchProvider({
    apiKey: "test-key",
    corpus: CORPUS,
    armsConfig: armsConfigFor("B"), // Arm B: homogeneous Haiku -- the case §3.3 is about
    fetchImpl: routingFetch({
      onSubmit: (body) => {
        captured.push(...body.requests);
        return { id: "batch_3", processing_status: "ended", results_url: "https://fake/results" };
      },
      onResults: (body, submitted) => submitted.requests.map((r) => resultLine(r.custom_id, textResult(`[{"text":"x"}]`))),
    }),
    ideateImpl: fakeIdeateImpl,
    sleep: noopSleep,
    logger: silentLogger,
  });

  await provider.generate(cellFor("B"), armsConfigJson.arms.B, { mode: "batch", timestamp: "2026-08-02T00:00:00Z" });
  assert.equal(captured.length, 5); // 5-agent panel
  for (const req of captured) {
    assert.ok(!("temperature" in req.params), "no submitted request may carry temperature, Haiku included");
    assert.ok(!("top_p" in req.params));
    assert.ok(!("top_k" in req.params));
  }
});

// ── custom_id keying: reversed result order still maps correctly ───────────

test("custom_id keying: batch results returned in REVERSED order still map to the correct agent", async () => {
  const provider = new AnthropicBatchProvider({
    apiKey: "test-key",
    corpus: CORPUS,
    armsConfig: armsConfigFor("B"),
    fetchImpl: routingFetch({
      onSubmit: () => ({ id: "batch_4", processing_status: "ended", results_url: "https://fake/results" }),
      onResults: (body, submitted) => {
        // Distinguishable text per request (echo the custom_id back), then
        // return the lines in REVERSED order -- must still map correctly
        // because the provider keys by custom_id, not array/line position.
        const lines = submitted.requests.map((r) => resultLine(r.custom_id, textResult(`[{"text":"idea-from-${r.custom_id}"}]`)));
        return lines.reverse();
      },
    }),
    ideateImpl: fakeIdeateImpl,
    sleep: noopSleep,
    logger: silentLogger,
  });

  const resp = await provider.generate(cellFor("B"), armsConfigJson.arms.B, { mode: "batch", timestamp: "2026-08-02T00:00:00Z" });
  assert.equal(resp.terminalState, "completed");
  const texts = resp.result.candidates.map((c) => c.text);
  // Every agent's own distinguishable idea shows up despite reversed results.
  assert.equal(texts.length, 5);
  assert.equal(new Set(texts).size, 5, "each agent's reply must be distinct and correctly attributed");
});

// ── no-throw transport failure ──────────────────────────────────────────────

test("a rejecting fetchImpl on batch submit resolves generate() with a classified transport_error, never throws", async () => {
  const provider = new AnthropicBatchProvider({
    apiKey: "test-key",
    corpus: CORPUS,
    armsConfig: armsConfigFor("A"),
    fetchImpl: async () => {
      throw new Error("ECONNRESET");
    },
    ideateImpl: fakeIdeateImpl,
    sleep: noopSleep,
    maxRetries: 0,
    logger: silentLogger,
  });

  const resp = await provider.generate(cellFor("A"), armsConfigJson.arms.A, { mode: "batch", timestamp: "2026-08-02T00:00:00Z" });
  assert.equal(resp.terminalState, "failed");
  assert.equal(resp.failureKind, "transport_error");
});

test("a 500 on batch submit resolves generate() with a classified transport_error, never throws", async () => {
  const provider = new AnthropicBatchProvider({
    apiKey: "test-key",
    corpus: CORPUS,
    armsConfig: armsConfigFor("A"),
    fetchImpl: async () => jsonResponse(500, { error: "boom" }),
    ideateImpl: fakeIdeateImpl,
    sleep: noopSleep,
    maxRetries: 0,
    logger: silentLogger,
  });

  const resp = await provider.generate(cellFor("A"), armsConfigJson.arms.A, { mode: "batch", timestamp: "2026-08-02T00:00:00Z" });
  assert.equal(resp.terminalState, "failed");
  assert.equal(resp.failureKind, "transport_error");
});

// ── rate_limited ─────────────────────────────────────────────────────────────

test("HTTP 429 that persists after retries classifies as rate_limited", async () => {
  const provider = new AnthropicBatchProvider({
    apiKey: "test-key",
    corpus: CORPUS,
    armsConfig: armsConfigFor("A"),
    fetchImpl: async () => jsonResponse(429, { error: "slow down" }),
    ideateImpl: fakeIdeateImpl,
    sleep: noopSleep,
    maxRetries: 2,
    logger: silentLogger,
  });

  const resp = await provider.generate(cellFor("A"), armsConfigJson.arms.A, { mode: "batch", timestamp: "2026-08-02T00:00:00Z" });
  assert.equal(resp.terminalState, "failed");
  assert.equal(resp.failureKind, "rate_limited");
});

// ── empty_pool ───────────────────────────────────────────────────────────────

test("ideateImpl resolving with candidates: [] classifies as failed/empty_pool", async () => {
  const provider = new AnthropicBatchProvider({
    apiKey: "test-key",
    corpus: CORPUS,
    armsConfig: armsConfigFor("A"),
    fetchImpl: async () => {
      throw new Error("should not be called -- ideateImpl never calls complete() in this fake");
    },
    ideateImpl: async () => ({ candidates: [], agents: [], meta: { agentsAttempted: 1, agentsFailed: 0 } }),
    sleep: noopSleep,
    logger: silentLogger,
  });

  const resp = await provider.generate(cellFor("A"), armsConfigJson.arms.A, { mode: "batch", timestamp: "2026-08-02T00:00:00Z" });
  assert.equal(resp.terminalState, "failed");
  assert.equal(resp.failureKind, "empty_pool");
});

test("ideateImpl resolving with an empty pool AND every agent failed classifies as refusal", async () => {
  const provider = new AnthropicBatchProvider({
    apiKey: "test-key",
    corpus: CORPUS,
    armsConfig: armsConfigFor("A"),
    fetchImpl: async () => {
      throw new Error("should not be called");
    },
    ideateImpl: async () => ({ candidates: [], agents: [], meta: { agentsAttempted: 1, agentsFailed: 1 } }),
    sleep: noopSleep,
    logger: silentLogger,
  });

  const resp = await provider.generate(cellFor("A"), armsConfigJson.arms.A, { mode: "batch", timestamp: "2026-08-02T00:00:00Z" });
  assert.equal(resp.terminalState, "failed");
  assert.equal(resp.failureKind, "refusal");
});

// ── token capture ────────────────────────────────────────────────────────────

test("a completed cell returns tokens.tokens_by_model with per-model input/output sums matching the fake usage", async () => {
  const provider = new AnthropicBatchProvider({
    apiKey: "test-key",
    corpus: CORPUS,
    armsConfig: armsConfigFor("E"), // mixed tier: 2xHaiku, 2xSonnet, 1xOpus
    fetchImpl: routingFetch({
      onSubmit: () => ({ id: "batch_5", processing_status: "ended", results_url: "https://fake/results" }),
      onResults: (body, submitted) =>
        submitted.requests.map((r) =>
          resultLine(
            r.custom_id,
            textResult(`[{"text":"x"}]`, { input_tokens: 100, output_tokens: 50 }),
          ),
        ),
    }),
    ideateImpl: fakeIdeateImpl,
    sleep: noopSleep,
    logger: silentLogger,
  });

  const resp = await provider.generate(cellFor("E"), armsConfigJson.arms.E, { mode: "batch", timestamp: "2026-08-02T00:00:00Z" });
  assert.equal(resp.terminalState, "completed");
  const byModel = resp.tokens.tokens_by_model;
  // Arm E: 2xHaiku, 2xSonnet, 1xOpus -- each contributing agent's usage sums per model.
  assert.equal(byModel["claude-haiku-4-5"].input_tokens, 200);
  assert.equal(byModel["claude-haiku-4-5"].output_tokens, 100);
  assert.equal(byModel["claude-sonnet-5"].input_tokens, 200);
  assert.equal(byModel["claude-opus-5"].input_tokens, 100);
  assert.equal(byModel["claude-opus-5"].output_tokens, 50);
});

test("tokens are captured even on a failed cell (whatever was consumed before the failure)", async () => {
  let call = 0;
  const provider = new AnthropicBatchProvider({
    apiKey: "test-key",
    corpus: CORPUS,
    armsConfig: armsConfigFor("A"),
    fetchImpl: async (url) => {
      call++;
      if (String(url).includes("/batches") && !String(url).includes("results")) {
        // submit succeeds
        if (call === 1) return jsonResponse(200, { id: "batch_6", processing_status: "ended", results_url: "https://fake/results" });
      }
      // results fetch fails
      return jsonResponse(500, {});
    },
    ideateImpl: fakeIdeateImpl,
    sleep: noopSleep,
    maxRetries: 0,
    logger: silentLogger,
  });

  const resp = await provider.generate(cellFor("A"), armsConfigJson.arms.A, { mode: "batch", timestamp: "2026-08-02T00:00:00Z" });
  assert.equal(resp.terminalState, "failed");
  assert.ok(resp.tokens && resp.tokens.tokens_by_model, "tokens shape must always be present, even on failure");
});

// ── batch vs single mode ────────────────────────────────────────────────────

test("mode: 'single' hits /v1/messages, not /v1/messages/batches", async () => {
  const urls = [];
  const provider = new AnthropicBatchProvider({
    apiKey: "test-key",
    corpus: CORPUS,
    armsConfig: armsConfigFor("A"),
    fetchImpl: async (url) => {
      urls.push(String(url));
      return jsonResponse(200, { content: [{ type: "text", text: '[{"text":"idea"}]' }], usage: { input_tokens: 10, output_tokens: 5 } });
    },
    ideateImpl: fakeIdeateImpl,
    sleep: noopSleep,
    logger: silentLogger,
  });

  const resp = await provider.generate(cellFor("A"), armsConfigJson.arms.A, { mode: "single", timestamp: "2026-08-02T00:00:00Z" });
  assert.equal(resp.terminalState, "completed");
  assert.ok(urls.every((u) => u === "https://api.anthropic.com/v1/messages"));
  assert.ok(!urls.some((u) => u.includes("/batches")));
});

test("mode: 'batch' hits /v1/messages/batches, not the plain /v1/messages endpoint", async () => {
  const urls = [];
  const baseFetch = routingFetch({
    onSubmit: () => ({ id: "batch_7", processing_status: "ended", results_url: "https://fake/results" }),
    onResults: (body, submitted) => submitted.requests.map((r) => resultLine(r.custom_id, textResult('[{"text":"x"}]'))),
  });
  const provider = new AnthropicBatchProvider({
    apiKey: "test-key",
    corpus: CORPUS,
    armsConfig: armsConfigFor("A"),
    fetchImpl: async (url, opts) => {
      urls.push(String(url));
      return baseFetch(url, opts);
    },
    ideateImpl: fakeIdeateImpl,
    sleep: noopSleep,
    logger: silentLogger,
  });

  const resp = await provider.generate(cellFor("A"), armsConfigJson.arms.A, { mode: "batch", timestamp: "2026-08-02T00:00:00Z" });
  assert.equal(resp.terminalState, "completed");
  assert.ok(urls.some((u) => u === "https://api.anthropic.com/v1/messages/batches"));
  assert.ok(!urls.includes("https://api.anthropic.com/v1/messages"));
});

// ── ANTHROPIC_API_KEY guard ──────────────────────────────────────────────────

test("no apiKey: generate() returns a classified failure rather than throwing", async () => {
  const provider = new AnthropicBatchProvider({
    apiKey: undefined,
    corpus: CORPUS,
    armsConfig: armsConfigFor("A"),
    fetchImpl: async () => {
      throw new Error("must never be called with no apiKey");
    },
    ideateImpl: fakeIdeateImpl,
    sleep: noopSleep,
    logger: silentLogger,
  });
  const resp = await provider.generate(cellFor("A"), armsConfigJson.arms.A, { mode: "batch" });
  assert.equal(resp.terminalState, "failed");
  assert.equal(resp.failureKind, "harness_error");
});

// ── issue #92: the batch poll ceiling ───────────────────────────────────────
//
// Everything below is hermetic: `stuckBatchFetch` models a batch that never
// leaves `in_progress`, and `maxPollMs: -1` puts the deadline in the past so
// the ceiling fires on the first check. No timers wait, no network is touched.

test("#92: the live default poll ceiling is 60 minutes (DEFAULT_MAX_POLL_MS), not the old 15", () => {
  assert.equal(DEFAULT_MAX_POLL_MS, 60 * 60 * 1000);
  const provider = new AnthropicBatchProvider({ apiKey: "test-key", logger: silentLogger });
  assert.equal(provider.maxPollMs, DEFAULT_MAX_POLL_MS, "the constructor default must BE the constant, not a second hardcoded number");
  assert.notEqual(provider.maxPollMs, 15 * 60 * 1000, "15 minutes is shorter than observed batch latency -- issue #92");
});

test("#92: a non-finite maxPollMs is rejected at construction -- a NaN ceiling would never expire, hanging the poll loop forever", () => {
  assert.throws(() => new AnthropicBatchProvider({ apiKey: "k", maxPollMs: NaN }), /maxPollMs must be a finite number/);
  assert.throws(() => new AnthropicBatchProvider({ apiKey: "k", maxPollMs: undefined_but_string() }), /maxPollMs must be a finite number/);
  // An explicit zero/negative ceiling is a legitimate "give up immediately"
  // (the tests below rely on it) and must NOT be rejected.
  assert.equal(new AnthropicBatchProvider({ apiKey: "k", maxPollMs: -1 }).maxPollMs, -1);
});
function undefined_but_string() {
  return "not-a-number";
}

test("#92: a batch that outruns the ceiling fails as `timeout` and the ledger detail says POLL_CEILING_REACHED with the abandoned handle", async () => {
  const provider = new AnthropicBatchProvider({
    apiKey: "test-key",
    corpus: CORPUS,
    armsConfig: armsConfigFor("A"),
    maxPollMs: -1,
    fetchImpl: stuckBatchFetch(),
    ideateImpl: fakeIdeateImpl,
    sleep: noopSleep,
    logger: silentLogger,
  });

  const resp = await provider.generate(cellFor("A"), armsConfigJson.arms.A, { mode: "batch" });
  assert.equal(resp.terminalState, "failed");
  assert.equal(resp.failureKind, "timeout");
  // THE discriminator the issue asks for: an operator reading the ledger must
  // be able to tell "we gave up waiting" from "the API failed". Both would be
  // `timeout`-shaped without this token, and a transport failure carries no
  // batch handle to recover from.
  assert.match(resp.detail, /POLL_CEILING_REACHED/);
  assert.match(resp.detail, /gave up waiting; the API did NOT fail/);
  assert.match(resp.detail, /batch_stuck/, "the durable batch handle is in the ledger, so the operator can re-poll or cancel it by hand");
  assert.match(resp.detail, /"max_poll_ms":-1/);
  assert.match(resp.detail, /"last_status":"in_progress"/);
});

test("#92: abandoning a batch CANCELS it (POST .../cancel) so it cannot bill unattended, and records the cancel outcome", async () => {
  const cancels = [];
  const provider = new AnthropicBatchProvider({
    apiKey: "test-key",
    corpus: CORPUS,
    armsConfig: armsConfigFor("A"),
    maxPollMs: -1,
    fetchImpl: stuckBatchFetch({ onCancel: (u) => cancels.push(u) }),
    ideateImpl: fakeIdeateImpl,
    sleep: noopSleep,
    logger: silentLogger,
  });

  const resp = await provider.generate(cellFor("A"), armsConfigJson.arms.A, { mode: "batch" });
  assert.deepEqual(cancels, ["https://api.anthropic.com/v1/messages/batches/batch_stuck/cancel"]);
  assert.match(resp.detail, /"cancelled":true/);
});

test("#92: cancelOnAbandon: false leaves the handle live for a manual re-poll and records cancelled: null", async () => {
  const cancels = [];
  const provider = new AnthropicBatchProvider({
    apiKey: "test-key",
    corpus: CORPUS,
    armsConfig: armsConfigFor("A"),
    maxPollMs: -1,
    cancelOnAbandon: false,
    fetchImpl: stuckBatchFetch({ onCancel: (u) => cancels.push(u) }),
    ideateImpl: fakeIdeateImpl,
    sleep: noopSleep,
    logger: silentLogger,
  });

  const resp = await provider.generate(cellFor("A"), armsConfigJson.arms.A, { mode: "batch" });
  assert.deepEqual(cancels, [], "no cancel is issued when the operator opted out");
  assert.equal(resp.failureKind, "timeout");
  assert.match(resp.detail, /"cancelled":null/);
});

test("#92: a cancel that FAILS never changes the failure kind, and says so in the ledger so the operator knows a batch may still bill", async () => {
  const provider = new AnthropicBatchProvider({
    apiKey: "test-key",
    corpus: CORPUS,
    armsConfig: armsConfigFor("A"),
    maxPollMs: -1,
    fetchImpl: stuckBatchFetch({ cancelStatus: 500 }),
    ideateImpl: fakeIdeateImpl,
    sleep: noopSleep,
    logger: silentLogger,
  });

  const resp = await provider.generate(cellFor("A"), armsConfigJson.arms.A, { mode: "batch" });
  assert.equal(resp.failureKind, "timeout", "a failed cancel is not a different failure -- the cell still timed out");
  assert.match(resp.detail, /"cancelled":false/);
});

test("#92: a PARTIAL pool whose later round outran the ceiling is FAILED, never stored as a completed (silently truncated) pool", async () => {
  // Panel arms run panel.maxRounds (2) rounds. Round 1's batch ends normally;
  // round 2's never does. Without the guard this test pins, ideate-core
  // resolves with round 1's candidates and the cell stores as `completed`
  // carrying half a pool -- an arm-correlated under-count of distinct_k on
  // exactly the panel arms H1 compares against solo.
  let batchSeq = 0;
  let round1CustomIds = [];
  const fetchImpl = async (url, opts) => {
    const u = String(url);
    if (u.endsWith("/v1/messages/batches")) {
      batchSeq += 1;
      if (batchSeq === 1) {
        round1CustomIds = JSON.parse(opts.body).requests.map((r) => r.custom_id);
        return jsonResponse(200, { id: "batch_round1", processing_status: "ended", results_url: "https://fake/results" });
      }
      return jsonResponse(200, { id: "batch_stuck", processing_status: "in_progress" });
    }
    if (u.includes("/v1/messages/batches/")) return jsonResponse(200, { id: "batch_stuck", processing_status: "in_progress" });
    if (u === "https://fake/results") {
      return textResponse(round1CustomIds.map((id) => JSON.stringify(resultLine(id, textResult('[{"text":"round-1 idea"}]')))).join("\n"));
    }
    throw new Error(`unexpected URL ${u}`);
  };

  const provider = new AnthropicBatchProvider({
    apiKey: "test-key",
    corpus: CORPUS,
    armsConfig: armsConfigFor("A"),
    maxPollMs: -1,
    fetchImpl,
    // A two-round engine: round 1 resolves, round 2 is abandoned at the
    // ceiling, and the engine (like the real one) still returns round 1's work.
    ideateImpl: async (input, deps) => {
      const agent = deps.agents[0];
      const r1 = await deps.complete({ model: agent.model, prompt: "round 1", persona: agent.persona });
      await deps.complete({ model: agent.model, prompt: "round 2", persona: agent.persona });
      const candidates = r1 && r1.ok ? [{ text: "round-1 idea", model: agent.model }] : [];
      return { candidates, agents: deps.agents, meta: { agentsAttempted: 1, agentsFailed: 0 } };
    },
    sleep: noopSleep,
    logger: silentLogger,
  });

  const resp = await provider.generate(cellFor("A"), armsConfigJson.arms.A, { mode: "batch" });
  assert.equal(resp.terminalState, "failed", "a pool assembled while a paid-for batch was still outstanding is not a measurement");
  assert.equal(resp.failureKind, "timeout");
  assert.match(resp.detail, /POLL_CEILING_REACHED/);
  assert.match(resp.detail, /discarding a PARTIAL pool of 1 candidate/);
});

test("#92: once a cell has abandoned a batch, a LATER round submits no second batch -- the ceiling is a per-cell bound, not a per-batch one", async () => {
  // Without the short-circuit this pins, a 2-round panel cell whose round-1
  // batch blew the ceiling would submit round 2 as a fresh batch and poll it
  // for another full maxPollMs -- paying real money for a pool the
  // partial-pool guard has already decided to discard.
  const submits = [];
  const provider = new AnthropicBatchProvider({
    apiKey: "test-key",
    corpus: CORPUS,
    armsConfig: armsConfigFor("A"),
    maxPollMs: -1,
    fetchImpl: async (url, opts) => {
      const u = String(url);
      if (u.endsWith("/v1/messages/batches")) submits.push(u);
      return stuckBatchFetch()(url, opts);
    },
    ideateImpl: async (input, deps) => {
      const agent = deps.agents[0];
      await deps.complete({ model: agent.model, prompt: "round 1", persona: agent.persona });
      await deps.complete({ model: agent.model, prompt: "round 2", persona: agent.persona });
      return { candidates: [], agents: deps.agents, meta: { agentsAttempted: 1, agentsFailed: 1 } };
    },
    sleep: noopSleep,
    logger: silentLogger,
  });

  const resp = await provider.generate(cellFor("A"), armsConfigJson.arms.A, { mode: "batch" });
  assert.equal(resp.failureKind, "timeout");
  assert.equal(submits.length, 1, "exactly ONE batch was submitted -- round 2 must not re-submit for a cell already given up on");
});

test("#92 + #90 END TO END: a cell lost to the poll ceiling is NOT stored under cell.key and is re-planned todo on the next invocation", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ideate-poll-ceiling-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const cfg = { harnessVersion: "0.0.1", engineSha: "test-sha", promptHash: "test-prompt" };
  const spec = { arms: [{ id: "A" }], briefs: [{ id: "brief-1" }], replicates: 1, config: cfg };
  const key = cellKey({ armId: "A", briefId: "brief-1", replicate: 0, cfg: configHash(cfg) });

  const provider = new AnthropicBatchProvider({
    apiKey: "test-key",
    corpus: CORPUS,
    armsConfig: armsConfigFor("A"),
    maxPollMs: -1,
    fetchImpl: stuckBatchFetch(),
    ideateImpl: fakeIdeateImpl,
    sleep: noopSleep,
    logger: silentLogger,
  });

  const store = new ResultsStore(dir);
  const { summary } = await runSpec(spec, { store, armsConfig: armsConfigFor("A"), provider, log: () => {} });
  assert.equal(summary.failed, 1);
  assert.deepEqual(summary.byKind, { timeout: 1 });

  // The #90 property, verified against the REAL ceiling path rather than
  // assumed from `timeout` being in TRANSIENT_FAILURE_KINDS: nothing under
  // cell.key, so planRun re-plans it instead of classifying it `reuse` forever.
  assert.equal(store.has(key), false, "the ceiling must not permanently consume the cell");
  const store2 = new ResultsStore(dir);
  assert.deepEqual(planRun(spec, store2.keys()).todo.map((c) => c.key), [key], "the next invocation re-plans it todo");

  // And the reason is durable: the attempt record carries the kind AND the
  // abandoned batch handle, so "why is this cell todo again?" is answerable
  // from the store alone.
  const attempt = store2.get(`generation-attempt|cell=${key}|attempt=0`);
  assert.equal(attempt.accounting.kind, "timeout");
  assert.match(attempt.accounting.detail, /POLL_CEILING_REACHED/);
  assert.match(attempt.accounting.detail, /batch_stuck/);
});

// ── test fixtures/helpers ────────────────────────────────────────────────────

/**
 * A batch that submits fine and then never leaves `in_progress` -- the exact
 * shape `msgbatch_01F9QXDpNptrrGfD4z3RzpGX` had when the #8 smoke run was
 * killed. `onCancel` records the cancel URL; `cancelStatus` forces the cancel
 * call to fail so the "cancel failed" path is exercised.
 */
function stuckBatchFetch({ onCancel, cancelStatus = 200 } = {}) {
  return async (url) => {
    const u = String(url);
    if (u.endsWith("/cancel")) {
      if (onCancel) onCancel(u);
      return jsonResponse(cancelStatus, { id: "batch_stuck", processing_status: "canceling" });
    }
    if (u.endsWith("/v1/messages/batches")) return jsonResponse(200, { id: "batch_stuck", processing_status: "in_progress" });
    if (u.includes("/v1/messages/batches/")) return jsonResponse(200, { id: "batch_stuck", processing_status: "in_progress" });
    throw new Error(`stuckBatchFetch: unexpected URL ${u}`);
  };
}


function jsonResponse(status, obj) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => obj,
    text: async () => JSON.stringify(obj),
  };
}

function textResponse(text, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
    json: async () => JSON.parse(text),
  };
}

/** One JSONL result row keyed by custom_id, per the Message Batches results shape. */
function resultLine(custom_id, result) {
  return { custom_id, result };
}

/** A "succeeded" batch result entry wrapping a text-content Anthropic message. */
function textResult(jsonArrayText, usage = { input_tokens: 10, output_tokens: 5 }) {
  return { type: "succeeded", message: { content: [{ type: "text", text: jsonArrayText }], usage } };
}

/**
 * Build a fetchImpl that routes POST .../batches (submit) to `onSubmit`,
 * GET .../batches/:id (poll) to an immediate "ended" (submit already reports
 * ended in these tests -- no separate poll roundtrip needed), and GET the
 * results_url to `onResults`, returning them as a JSONL body -- exactly the
 * shape #flush() expects to parse.
 */
function routingFetch({ onSubmit, onResults }) {
  let submittedBody;
  return async (url, opts) => {
    const u = String(url);
    if (u.endsWith("/v1/messages/batches")) {
      submittedBody = JSON.parse(opts.body);
      const out = onSubmit(submittedBody);
      return jsonResponse(200, out);
    }
    if (u.includes("/v1/messages/batches/")) {
      // poll -- not exercised in these fixtures since onSubmit already
      // reports processing_status: "ended"; return the same shape defensively.
      return jsonResponse(200, { id: "batch", processing_status: "ended", results_url: "https://fake/results" });
    }
    if (u === "https://fake/results") {
      const lines = onResults(null, submittedBody);
      return textResponse(lines.map((l) => JSON.stringify(l)).join("\n"));
    }
    throw new Error(`routingFetch: unexpected URL ${u}`);
  };
}
