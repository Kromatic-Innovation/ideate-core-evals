// openai-batch.test.mjs — hermetic tests for OpenAIBatchProvider (issue #22).
// No network, no real ideate-core, no timers that wait: fetchImpl / ideateImpl
// / sleep are all faked, so this loads under CI's `node --test` with an empty
// node_modules (the hermetic-CI invariant, see evals/harness/provider.mjs).
//
// The OpenAI Batches flow (upload JSONL file -> create batch -> poll ->
// download output file) is modeled by `openaiBatchFetch`, which reads the
// submitted requests back out of the multipart upload's FormData so the fake
// output file can echo one result per custom_id.

import { test } from "node:test";
import assert from "node:assert/strict";

import { OpenAIBatchProvider, buildOpenAIChatParams, DEFAULT_MAX_POLL_MS } from "./provider.mjs";
import { interimPriceGrid } from "./runner.mjs";
import { runnerPriceGrid } from "../../lib/price.mjs";

const armsConfigJson = JSON.parse(
  await (await import("node:fs")).promises.readFile(new URL("../../arms.config.json", import.meta.url), "utf8"),
);
const CORPUS = [{ id: "brief-1", text: "Design a better bus stop." }];
const noopSleep = async () => {};
const silentLogger = () => {};

function armsConfigFor(...armIds) {
  const arms = {};
  for (const id of armIds) arms[id] = armsConfigJson.arms[id];
  return { panel: armsConfigJson.panel, arms };
}
function cellFor(armId, briefId = "brief-1") {
  return { key: `arm=${armId}|brief=${briefId}|rep=0|cfg=abc`, armId, briefId, replicate: 0, cfg: "abc" };
}

function jsonResponse(status, obj) {
  return { ok: status >= 200 && status < 300, status, json: async () => obj, text: async () => JSON.stringify(obj) };
}
function textResponse(text, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => text, json: async () => JSON.parse(text) };
}

/** One OpenAI batch output line: a succeeded chat completion for `custom_id`. */
function okResultLine(custom_id, content, usage = { prompt_tokens: 10, completion_tokens: 5 }) {
  return { custom_id, response: { status_code: 200, body: { choices: [{ message: { content } }], usage } }, error: null };
}

/**
 * Fake the whole OpenAI Batches flow. Reads the submitted request lines back
 * out of the multipart FormData upload, then builds the output file from
 * `resultFor(requestLine)`. `capture` (if given) collects the submitted lines.
 */
function openaiBatchFetch({ capture, resultFor, reverse = false } = {}) {
  let submitted = [];
  const build = resultFor || ((r) => okResultLine(r.custom_id, `[{"text":"idea for ${r.custom_id}"}]`));
  return async (url, opts) => {
    const u = String(url);
    if (u === "https://api.openai.com/v1/files" && opts.method === "POST") {
      const text = await opts.body.get("file").text(); // FormData -> Blob -> JSONL
      submitted = text.split("\n").filter(Boolean).map((l) => JSON.parse(l));
      if (capture) capture.push(...submitted);
      return jsonResponse(200, { id: "file_1", object: "file" });
    }
    if (u === "https://api.openai.com/v1/batches" && opts.method === "POST") {
      return jsonResponse(200, { id: "batch_1", status: "completed", output_file_id: "out_1" });
    }
    if (u.startsWith("https://api.openai.com/v1/batches/")) {
      return jsonResponse(200, { id: "batch_1", status: "completed", output_file_id: "out_1" });
    }
    if (u === "https://api.openai.com/v1/files/out_1/content") {
      const lines = submitted.map(build);
      if (reverse) lines.reverse();
      return textResponse(lines.map((l) => JSON.stringify(l)).join("\n"));
    }
    throw new Error(`openaiBatchFetch: unexpected URL ${u}`);
  };
}

/** A fake ideateImpl that drives deps.complete concurrently (like ideate-core),
 *  parses each reply as a JSON array of {text}, returns {candidates, agents, meta}. */
async function fakeIdeateImpl(input, deps) {
  const { complete, agents } = deps;
  const results = await Promise.all(
    agents.map((agent) =>
      complete({
        model: agent.model,
        prompt: deps.buildRound1Prompt({ context: input.context, persona: agent.persona, ideasPerAgent: agent.ideasPerAgent }),
        temperature: 0.7, // ideate-core always sends this; the adapter must ignore it
        top_p: 0.9,
        maxTokens: 2048,
        persona: agent.persona,
      }),
    ),
  );
  const candidates = [];
  let agentsFailed = 0;
  results.forEach((res, i) => {
    if (!res || res.ok !== true) { agentsFailed++; return; }
    let raw;
    try { raw = JSON.parse(res.text); } catch { raw = []; }
    for (const c of raw) if (c && typeof c.text === "string" && c.text) candidates.push({ text: c.text, model: agents[i].model, persona: agents[i].persona });
  });
  return { candidates, agents, meta: { agentsAttempted: agents.length, agentsFailed } };
}

function makeProvider(overrides = {}) {
  return new OpenAIBatchProvider({
    apiKey: "test-key",
    corpus: CORPUS,
    armsConfig: armsConfigFor("H", "G", "A"),
    ideateImpl: fakeIdeateImpl,
    sleep: noopSleep,
    logger: silentLogger,
    ...overrides,
  });
}

// ── batch path end-to-end (arm H, homogeneous OpenAI) ───────────────────────

test("generate() (batch) completes arm H end-to-end via a fake ideateImpl + OpenAI Batches flow", async () => {
  const provider = makeProvider({ fetchImpl: openaiBatchFetch() });
  const resp = await provider.generate(cellFor("H"), armsConfigJson.arms.H, { mode: "batch" });
  assert.equal(resp.terminalState, "completed");
  assert.equal(resp.result.candidates.length, 5); // 5-agent homogeneous OpenAI panel, one candidate each
});

test("usage is captured into tokens_by_model (prompt/completion mapped to input/output)", async () => {
  const provider = makeProvider({
    fetchImpl: openaiBatchFetch({ resultFor: (r) => okResultLine(r.custom_id, '[{"text":"x"}]', { prompt_tokens: 100, completion_tokens: 50 }) }),
  });
  const resp = await provider.generate(cellFor("H"), armsConfigJson.arms.H, { mode: "batch" });
  assert.equal(resp.terminalState, "completed");
  const byModel = resp.tokens.tokens_by_model;
  // Arm H: 5x gpt-5.6-terra, each 100 in / 50 out.
  assert.equal(byModel["gpt-5.6-terra"].input_tokens, 500);
  assert.equal(byModel["gpt-5.6-terra"].output_tokens, 250);
});

// ── force-strip (§3.3) on the OpenAI path ───────────────────────────────────

test("buildOpenAIChatParams never carries temperature/top_p/top_k, and uses max_completion_tokens", () => {
  const params = buildOpenAIChatParams({ model: "gpt-5.6-terra", prompt: "hi", temperature: 0.9, top_p: 0.8, top_k: 40, maxTokens: 123 });
  assert.equal(params.model, "gpt-5.6-terra");
  assert.equal(params.max_completion_tokens, 123);
  assert.ok(!("temperature" in params));
  assert.ok(!("top_p" in params));
  assert.ok(!("top_k" in params));
});

test("force-strip end-to-end: no submitted batch request body carries a sampling param", async () => {
  const captured = [];
  const provider = makeProvider({ fetchImpl: openaiBatchFetch({ capture: captured }) });
  await provider.generate(cellFor("H"), armsConfigJson.arms.H, { mode: "batch" });
  assert.equal(captured.length, 5);
  for (const line of captured) {
    assert.equal(line.url, "/v1/chat/completions");
    assert.ok(!("temperature" in line.body), "no submitted request may carry temperature");
    assert.ok(!("top_p" in line.body));
    assert.ok(!("top_k" in line.body));
  }
});

// ── keyed by custom_id, not line position ───────────────────────────────────

test("results returned in REVERSED order still map to the correct request (keyed by custom_id)", async () => {
  const provider = makeProvider({
    fetchImpl: openaiBatchFetch({ resultFor: (r) => okResultLine(r.custom_id, `[{"text":"idea-${r.custom_id}"}]`), reverse: true }),
  });
  const resp = await provider.generate(cellFor("H"), armsConfigJson.arms.H, { mode: "batch" });
  assert.equal(resp.terminalState, "completed");
  const texts = resp.result.candidates.map((c) => c.text);
  assert.equal(texts.length, 5);
  assert.equal(new Set(texts).size, 5, "each agent's reply must be distinct and correctly attributed");
});

// ── classified failures, never thrown ───────────────────────────────────────

test("a 500 on the file upload classifies as transport_error, never throws", async () => {
  const provider = makeProvider({ fetchImpl: async () => jsonResponse(500, {}), maxRetries: 0 });
  const resp = await provider.generate(cellFor("H"), armsConfigJson.arms.H, { mode: "batch" });
  assert.equal(resp.terminalState, "failed");
  assert.equal(resp.failureKind, "transport_error");
  assert.ok(resp.tokens && resp.tokens.tokens_by_model);
});

test("a 429 on upload classifies as rate_limited", async () => {
  const provider = makeProvider({ fetchImpl: async () => jsonResponse(429, {}), maxRetries: 1 });
  const resp = await provider.generate(cellFor("H"), armsConfigJson.arms.H, { mode: "batch" });
  assert.equal(resp.terminalState, "failed");
  assert.equal(resp.failureKind, "rate_limited");
});

test("a batch that reports status 'failed' classifies as transport_error", async () => {
  const provider = makeProvider({
    fetchImpl: async (url, opts) => {
      const u = String(url);
      if (u === "https://api.openai.com/v1/files") return jsonResponse(200, { id: "file_1" });
      if (u === "https://api.openai.com/v1/batches" && opts.method === "POST") return jsonResponse(200, { id: "batch_1", status: "failed" });
      return jsonResponse(200, { id: "batch_1", status: "failed" });
    },
  });
  const resp = await provider.generate(cellFor("H"), armsConfigJson.arms.H, { mode: "batch" });
  assert.equal(resp.terminalState, "failed");
  assert.equal(resp.failureKind, "transport_error");
});

test("a batch that never completes before the poll ceiling classifies as timeout", async () => {
  const provider = makeProvider({
    maxPollMs: -1,
    fetchImpl: async (url, opts) => {
      const u = String(url);
      if (u === "https://api.openai.com/v1/files") return jsonResponse(200, { id: "file_1" });
      if (u === "https://api.openai.com/v1/batches" && opts.method === "POST") return jsonResponse(200, { id: "batch_1", status: "in_progress" });
      return jsonResponse(200, { id: "batch_1", status: "in_progress" });
    },
  });
  const resp = await provider.generate(cellFor("H"), armsConfigJson.arms.H, { mode: "batch" });
  assert.equal(resp.terminalState, "failed");
  assert.equal(resp.failureKind, "timeout");
});

test("ideateImpl resolving with candidates: [] classifies as empty_pool", async () => {
  const provider = makeProvider({
    ideateImpl: async () => ({ candidates: [], agents: [], meta: { agentsAttempted: 1, agentsFailed: 0 } }),
    fetchImpl: async () => { throw new Error("complete() never called in this fake"); },
  });
  const resp = await provider.generate(cellFor("H"), armsConfigJson.arms.H, { mode: "batch" });
  assert.equal(resp.terminalState, "failed");
  assert.equal(resp.failureKind, "empty_pool");
});

test("no apiKey: generate() returns a classified harness_error rather than throwing", async () => {
  // Pass an explicit falsy key ("") rather than `undefined` — `undefined` would
  // trigger the constructor's `= process.env.OPENAI_API_KEY` default and make
  // this test depend on whether a key happens to be set in the environment.
  const provider = makeProvider({ apiKey: "", fetchImpl: async () => { throw new Error("must never be called"); } });
  const resp = await provider.generate(cellFor("H"), armsConfigJson.arms.H, { mode: "batch" });
  assert.equal(resp.terminalState, "failed");
  assert.equal(resp.failureKind, "harness_error");
});

// ── single mode hits chat/completions, not batches ──────────────────────────

test("mode: 'single' hits /v1/chat/completions, not /v1/batches", async () => {
  const urls = [];
  const provider = makeProvider({
    fetchImpl: async (url, opts) => {
      urls.push(String(url));
      const content = JSON.parse(opts.body).messages[0].content;
      assert.ok(content.length > 0);
      return jsonResponse(200, { choices: [{ message: { content: '[{"text":"idea"}]' } }], usage: { prompt_tokens: 4, completion_tokens: 2 } });
    },
  });
  const resp = await provider.generate(cellFor("H"), armsConfigJson.arms.H, { mode: "single" });
  assert.equal(resp.terminalState, "completed");
  assert.ok(urls.every((u) => u === "https://api.openai.com/v1/chat/completions"));
  assert.ok(!urls.some((u) => u.includes("/batches")));
});

// ── issue #92: the batch poll ceiling, mirrored from the Anthropic path ─────
//
// Arm H and arm G's OpenAI slots were never exercised by the #8 smoke study,
// so this provider has never met a real batch ceiling. It gets the same fix
// and the same tests rather than waiting to reproduce the bug on a second
// provider.

test("#92: the live default poll ceiling is 60 minutes (DEFAULT_MAX_POLL_MS), not the old 15", () => {
  const provider = makeProvider({ fetchImpl: async () => { throw new Error("never called"); } });
  assert.equal(provider.maxPollMs, DEFAULT_MAX_POLL_MS);
  assert.notEqual(provider.maxPollMs, 15 * 60 * 1000);
});

test("#92: a non-finite maxPollMs is rejected at construction (a NaN ceiling never expires)", () => {
  assert.throws(() => new OpenAIBatchProvider({ apiKey: "k", maxPollMs: NaN }), /maxPollMs must be a finite number/);
});

test("#92: a batch that outruns the ceiling says POLL_CEILING_REACHED, names the handle, and cancels it", async () => {
  const cancels = [];
  const provider = makeProvider({
    maxPollMs: -1,
    fetchImpl: stuckOpenAIBatchFetch({ onCancel: (u) => cancels.push(u) }),
  });
  const resp = await provider.generate(cellFor("H"), armsConfigJson.arms.H, { mode: "batch" });
  assert.equal(resp.terminalState, "failed");
  assert.equal(resp.failureKind, "timeout");
  assert.match(resp.detail, /POLL_CEILING_REACHED/);
  assert.match(resp.detail, /batch_stuck/);
  assert.match(resp.detail, /"last_status":"in_progress"/);
  assert.deepEqual(cancels, ["https://api.openai.com/v1/batches/batch_stuck/cancel"], "an abandoned OpenAI batch is cancelled too");
  assert.match(resp.detail, /"cancelled":true/);
});

test("#92: cancelOnAbandon: false issues no cancel and records cancelled: null", async () => {
  const cancels = [];
  const provider = makeProvider({
    maxPollMs: -1,
    cancelOnAbandon: false,
    fetchImpl: stuckOpenAIBatchFetch({ onCancel: (u) => cancels.push(u) }),
  });
  const resp = await provider.generate(cellFor("H"), armsConfigJson.arms.H, { mode: "batch" });
  assert.deepEqual(cancels, []);
  assert.match(resp.detail, /"cancelled":null/);
});

/** An OpenAI batch that uploads and creates fine, then never leaves `in_progress`. */
function stuckOpenAIBatchFetch({ onCancel } = {}) {
  return async (url, opts) => {
    const u = String(url);
    if (u.endsWith("/cancel")) {
      if (onCancel) onCancel(u);
      return jsonResponse(200, { id: "batch_stuck", status: "cancelling" });
    }
    if (u === "https://api.openai.com/v1/files" && opts.method === "POST") return jsonResponse(200, { id: "file_1", object: "file" });
    if (u === "https://api.openai.com/v1/batches" && opts.method === "POST") return jsonResponse(200, { id: "batch_stuck", status: "in_progress" });
    if (u.startsWith("https://api.openai.com/v1/batches/")) return jsonResponse(200, { id: "batch_stuck", status: "in_progress" });
    throw new Error(`stuckOpenAIBatchFetch: unexpected URL ${u}`);
  };
}

// ── AC: arms G and H plan and price correctly under --dry-run (hermetic) ────

test("arms G and H plan and price without throwing, under both the interim pricer and runnerPriceGrid", () => {
  const cells = [
    { key: "arm=G|brief=biz-01|rep=0|cfg=x", armId: "G" },
    { key: "arm=H|brief=biz-01|rep=0|cfg=x", armId: "H" },
  ];
  const interim = interimPriceGrid(cells, armsConfigJson.arms, { batch: true });
  assert.ok(interim.usd > 0);
  assert.equal(interim.breakdown.length, 2);
  const authoritative = runnerPriceGrid()(cells, armsConfigJson.arms, { batch: true });
  assert.ok(authoritative.usd > 0);
  assert.equal(authoritative.breakdown.length, 2);
  // G is a multi-model (cross-provider) arm; its two OpenAI slots must price
  // via the real gpt-5.6-* rate rows, not throw as an unpriced placeholder.
  assert.ok(authoritative.breakdown.every((b) => b.usd > 0));
});
