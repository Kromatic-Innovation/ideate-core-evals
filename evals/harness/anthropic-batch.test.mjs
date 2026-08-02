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

import {
  AnthropicBatchProvider,
  resolveIdeateAgents,
  buildAnthropicMessageParams,
} from "./provider.mjs";

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

// ── test fixtures/helpers ────────────────────────────────────────────────────

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
