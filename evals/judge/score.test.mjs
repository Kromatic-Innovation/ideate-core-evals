// score.test.mjs — hermetic tests for the judge's live scoring call (issue #21).
// No network, no live key, no timers that actually wait: AnthropicJudgeProvider's
// fetchImpl/sleep seams are faked exactly like anthropic-batch.test.mjs fakes
// AnthropicBatchProvider, so this file loads under CI's `node --test` with an
// empty node_modules (the hermetic-CI invariant, see evals/harness/provider.mjs).

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  AnthropicJudgeProvider,
  MockJudgeProvider,
  buildJudgeScoringPrompt,
  parseAxisScores,
  runJudgeMatrix,
  recordJudgeScores,
  judgeScoresKey,
  judgeScoresForAxis,
  computeJudgeHash,
} from "./score.mjs";
import { JUDGE_AXES, judgePromptHash } from "./prompt.mjs";
import { validateJudge } from "./gate.mjs";
import { configHash, cellKey } from "../../lib/manifest.mjs";
import { makeTempStore } from "../../lib/store.mjs";

const armsConfigJson = JSON.parse(
  await (await import("node:fs")).promises.readFile(new URL("../../arms.config.json", import.meta.url), "utf8"),
);
const noopSleep = async () => {};
const silentLogger = () => {};

const BRIEF = "Design a low-cost coral reef health monitoring approach.";

/** A valid 4-axis score JSON for a candidate whose original index is `i`
 *  (originality encodes i+1 so a test can prove scores are un-permuted back to
 *  INPUT order). i must be <= 9 so the value stays within the [1,10] scale. */
function scoreJsonForIndex(i) {
  return JSON.stringify({ originality: i + 1, feasibility: 3 });
}

function jsonResponse(status, obj) {
  return { ok: status >= 200 && status < 300, status, json: async () => obj, text: async () => JSON.stringify(obj) };
}
function textResponse(text, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => text, json: async () => JSON.parse(text) };
}
function resultLine(custom_id, messageText, usage = { input_tokens: 10, output_tokens: 5 }) {
  return { custom_id, result: { type: "succeeded", message: { content: [{ type: "text", text: messageText }], usage } } };
}

/**
 * A batch fetchImpl for the judge: submit reports ended immediately; results
 * echo, per custom_id `cand-<i>`, a score whose originality encodes i — and are
 * returned in REVERSED order, so the test proves the provider keys by custom_id
 * (not line position) AND maps scores back to input order.
 */
function judgeBatchFetch({ capture } = {}) {
  let submittedBody;
  return async (url, opts) => {
    const u = String(url);
    if (u.endsWith("/v1/messages/batches")) {
      submittedBody = JSON.parse(opts.body);
      if (capture) capture.push(...submittedBody.requests);
      return jsonResponse(200, { id: "jbatch_1", processing_status: "ended", results_url: "https://fake/jresults" });
    }
    if (u.includes("/v1/messages/batches/")) {
      return jsonResponse(200, { id: "jbatch_1", processing_status: "ended", results_url: "https://fake/jresults" });
    }
    if (u === "https://fake/jresults") {
      const lines = submittedBody.requests.map((r) => {
        const i = Number(r.custom_id.replace("cand-", ""));
        return resultLine(r.custom_id, scoreJsonForIndex(i));
      });
      lines.reverse();
      return textResponse(lines.map((l) => JSON.stringify(l)).join("\n"));
    }
    throw new Error(`judgeBatchFetch: unexpected URL ${u}`);
  };
}

function poolOf(...texts) {
  return texts.map((t) => ({ text: t }));
}

// ── buildJudgeScoringPrompt / parseAxisScores ───────────────────────────────

test("buildJudgeScoringPrompt embeds the frozen rubric axes, the brief, and the candidate; asks for JSON-only", () => {
  const p = buildJudgeScoringPrompt(BRIEF, "A cheap buoy with a camera.");
  for (const axis of JUDGE_AXES) assert.ok(p.includes(axis), `prompt must name axis ${axis}`);
  assert.ok(p.includes(BRIEF));
  assert.ok(p.includes("A cheap buoy with a camera."));
  assert.ok(/ONLY that JSON object/i.test(p));
});

test("parseAxisScores reads both axes as distinct numbers and tolerates a ```json fence", () => {
  const s = parseAxisScores('```json\n{"originality":8,"feasibility":3}\n```');
  assert.deepEqual(s, { originality: 8, feasibility: 3 });
});

test("parseAxisScores rejects a COLLAPSED scalar (novelty/feasibility never averaged, §4.3/§5)", () => {
  assert.throws(() => parseAxisScores("5"), /distinct per-axis fields|must be an object/);
  assert.throws(() => parseAxisScores('{"overallScore":5}'), /originality|feasibility/);
});

test("parseAxisScores rejects an out-of-range axis and a non-numeric axis", () => {
  assert.throws(() => parseAxisScores('{"originality":11,"feasibility":3}'), /outside the \[1, 10\]/);
  // A non-numeric axis is rejected up front by assertAxesNotCollapsed (which
  // requires every JUDGE_AXES entry present as a distinct numeric field).
  assert.throws(() => parseAxisScores('{"originality":8,"feasibility":"high"}'), /axis 'feasibility'|must be present|distinct/);
});

// ── AC1 + AC4: a pool goes assembleJudgePayload -> per-axis scores via a real
//    (faked) model call, batch path; de-id + order randomization applied ─────

test("AnthropicJudgeProvider.score (batch) turns a pool into per-axis scores, un-permuted to INPUT order", async () => {
  const provider = new AnthropicJudgeProvider({ apiKey: "test-key", fetchImpl: judgeBatchFetch(), sleep: noopSleep, logger: silentLogger });
  const payload = { briefText: BRIEF, candidates: poolOf("idea a", "idea b", "idea c", "idea d") };
  const resp = await provider.score(payload, { judgeModel: "claude-sonnet-5", mode: "batch", seed: 7 });
  assert.equal(resp.terminalState, "completed");
  assert.equal(resp.scores.length, 4);
  // originality encodes the ORIGINAL index (i+1) — proves scores are mapped back
  // to input order despite a randomized presentation order and reversed results.
  resp.scores.forEach((s, i) => assert.equal(s.originality, i + 1, `candidate ${i} must keep its own score`));
  // novelty (originality) and feasibility are stored as DISTINCT fields.
  assert.ok(resp.scores.every((s) => typeof s.originality === "number" && typeof s.feasibility === "number"));
  assert.equal(resp.tokens.model, "claude-sonnet-5");
  assert.ok(resp.tokens.input_tokens > 0 && resp.tokens.output_tokens > 0);
});

test("order randomization is applied and seeded: a non-identity presentation order, reproducible from the seed", async () => {
  const captureA = [];
  const p1 = new AnthropicJudgeProvider({ apiKey: "k", fetchImpl: judgeBatchFetch({ capture: captureA }), sleep: noopSleep, logger: silentLogger });
  const payload = { briefText: BRIEF, candidates: poolOf("c0", "c1", "c2", "c3", "c4", "c5") };
  await p1.score(payload, { judgeModel: "claude-sonnet-5", mode: "batch", seed: 42 });
  const orderA = captureA.map((r) => r.custom_id);

  const captureB = [];
  const p2 = new AnthropicJudgeProvider({ apiKey: "k", fetchImpl: judgeBatchFetch({ capture: captureB }), sleep: noopSleep, logger: silentLogger });
  await p2.score(payload, { judgeModel: "claude-sonnet-5", mode: "batch", seed: 42 });
  const orderB = captureB.map((r) => r.custom_id);

  assert.deepEqual(orderA, orderB, "same seed must reproduce the exact presentation order");
  const identity = payload.candidates.map((_, i) => `cand-${i}`);
  assert.notDeepEqual(orderA, identity, "presentation order must be randomized, not the input order");
  assert.equal(new Set(orderA).size, payload.candidates.length, "every candidate must be presented exactly once");
});

test("de-identification: no arm/model/persona label reaches the judge prompt", async () => {
  const capture = [];
  const provider = new AnthropicJudgeProvider({ apiKey: "k", fetchImpl: judgeBatchFetch({ capture }), sleep: noopSleep, logger: silentLogger });
  // Raw pool carries identity fields — assembleJudgePayload must strip them.
  const { assembleJudgePayload } = await import("./deidentify.mjs");
  const rawPool = [
    { text: "idea one", model: "claude-opus-5", persona: "proposer_3", arm: "D" },
    { text: "idea two", model: "claude-haiku-4-5", persona: "proposer_1", arm: "D" },
  ];
  const payload = assembleJudgePayload({ pool: rawPool, arm: armsConfigJson.arms.D, briefText: BRIEF });
  await provider.score(payload, { judgeModel: "claude-sonnet-5", mode: "batch", seed: 1 });
  const allPrompts = capture.map((r) => r.params.messages[0].content).join("\n");
  for (const leak of ["claude-opus-5", "claude-haiku-4-5", "proposer_3", "proposer_1", '"arm"', "arm: D"]) {
    assert.ok(!allPrompts.includes(leak), `judge prompt must not leak '${leak}'`);
  }
});

// ── single mode ─────────────────────────────────────────────────────────────

test("score (single) hits /v1/messages (not /batches) and scores each candidate", async () => {
  const urls = [];
  const provider = new AnthropicJudgeProvider({
    apiKey: "k",
    fetchImpl: async (url, opts) => {
      urls.push(String(url));
      const content = JSON.parse(opts.body).messages[0].content;
      const m = content.match(/MARKER_(\d+)/);
      const i = m ? Number(m[1]) : 0;
      return jsonResponse(200, { content: [{ type: "text", text: scoreJsonForIndex(i) }], usage: { input_tokens: 4, output_tokens: 2 }, stop_reason: "end_turn" });
    },
    sleep: noopSleep,
    logger: silentLogger,
  });
  const payload = { briefText: BRIEF, candidates: poolOf("MARKER_0 idea", "MARKER_1 idea", "MARKER_2 idea") };
  const resp = await provider.score(payload, { judgeModel: "claude-sonnet-5", mode: "single", seed: 3 });
  assert.equal(resp.terminalState, "completed");
  resp.scores.forEach((s, i) => assert.equal(s.originality, i + 1));
  assert.ok(urls.every((u) => u === "https://api.anthropic.com/v1/messages"));
  assert.ok(!urls.some((u) => u.includes("/batches")));
});

// ── AC6: judge failures are classified into FAILURE_KINDS, never thrown ──────

test("a non-JSON judge reply classifies as parse_failure (not a thrown error)", async () => {
  const provider = new AnthropicJudgeProvider({
    apiKey: "k",
    fetchImpl: async (url) => {
      const u = String(url);
      if (u.endsWith("/v1/messages/batches")) return jsonResponse(200, { id: "b", processing_status: "ended", results_url: "https://fake/jresults" });
      return textResponse(JSON.stringify(resultLine("cand-0", "I think this idea is pretty good, honestly.")));
    },
    sleep: noopSleep,
    logger: silentLogger,
  });
  const resp = await provider.score({ briefText: BRIEF, candidates: poolOf("only one") }, { judgeModel: "claude-sonnet-5", mode: "batch", seed: 1 });
  assert.equal(resp.terminalState, "failed");
  assert.equal(resp.failureKind, "parse_failure");
  assert.equal(resp.tokens.model, "claude-sonnet-5");
});

test("a 500 on batch submit classifies as transport_error, never throws; tokens shape still present", async () => {
  const provider = new AnthropicJudgeProvider({ apiKey: "k", fetchImpl: async () => jsonResponse(500, {}), sleep: noopSleep, maxRetries: 0, logger: silentLogger });
  const resp = await provider.score({ briefText: BRIEF, candidates: poolOf("a", "b") }, { judgeModel: "claude-sonnet-5", mode: "batch", seed: 1 });
  assert.equal(resp.terminalState, "failed");
  assert.equal(resp.failureKind, "transport_error");
  assert.equal(resp.tokens.model, "claude-sonnet-5");
});

test("a persistent 429 classifies as rate_limited", async () => {
  const provider = new AnthropicJudgeProvider({ apiKey: "k", fetchImpl: async () => jsonResponse(429, {}), sleep: noopSleep, maxRetries: 1, logger: silentLogger });
  const resp = await provider.score({ briefText: BRIEF, candidates: poolOf("a") }, { judgeModel: "claude-sonnet-5", mode: "batch", seed: 1 });
  assert.equal(resp.terminalState, "failed");
  assert.equal(resp.failureKind, "rate_limited");
});

test("a batch that never ends before the poll ceiling classifies as timeout", async () => {
  const provider = new AnthropicJudgeProvider({
    apiKey: "k",
    fetchImpl: async (url) => {
      const u = String(url);
      if (u.endsWith("/v1/messages/batches")) return jsonResponse(200, { id: "b", processing_status: "in_progress" });
      return jsonResponse(200, { id: "b", processing_status: "in_progress" });
    },
    sleep: noopSleep,
    maxPollMs: -1, // deadline already past on the first check
    logger: silentLogger,
  });
  const resp = await provider.score({ briefText: BRIEF, candidates: poolOf("a") }, { judgeModel: "claude-sonnet-5", mode: "batch", seed: 1 });
  assert.equal(resp.terminalState, "failed");
  assert.equal(resp.failureKind, "timeout");
});

test("no apiKey: score() returns a classified harness_error rather than throwing", async () => {
  const provider = new AnthropicJudgeProvider({ apiKey: undefined, fetchImpl: async () => { throw new Error("must not be called"); }, sleep: noopSleep, logger: silentLogger });
  const resp = await provider.score({ briefText: BRIEF, candidates: poolOf("a") }, { judgeModel: "claude-sonnet-5", mode: "batch", seed: 1 });
  assert.equal(resp.terminalState, "failed");
  assert.equal(resp.failureKind, "harness_error");
});

test("an empty candidate pool classifies as empty_pool (nothing to score), never throws", async () => {
  const provider = new AnthropicJudgeProvider({ apiKey: "k", fetchImpl: async () => { throw new Error("must not be called"); }, sleep: noopSleep, logger: silentLogger });
  const resp = await provider.score({ briefText: BRIEF, candidates: [] }, { judgeModel: "claude-sonnet-5", mode: "batch", seed: 1 });
  assert.equal(resp.terminalState, "failed");
  assert.equal(resp.failureKind, "empty_pool");
});

test("an unseeded (non-integer) seed is a classified harness_error — an unseeded order can't be replayed", async () => {
  const provider = new AnthropicJudgeProvider({ apiKey: "k", fetchImpl: async () => { throw new Error("must not be called"); }, sleep: noopSleep, logger: silentLogger });
  const resp = await provider.score({ briefText: BRIEF, candidates: poolOf("a") }, { judgeModel: "claude-sonnet-5", mode: "batch" });
  assert.equal(resp.terminalState, "failed");
  assert.equal(resp.failureKind, "harness_error");
});

// ── AC3: the cross-judge matrix schedule is actually EXECUTED, and
//    assertEvaluatorDistinct is enforced at CALL time ─────────────────────────

const JUDGE_MODELS = { anthropic: ["claude-sonnet-5", "claude-opus-5"], openai: ["gpt-5.4", "gpt-5-mini"] };

function poolEntry(poolKey, armId, ...texts) {
  return { poolKey, arm: { id: armId, ...armsConfigJson.arms[armId] }, briefText: BRIEF, candidates: poolOf(...texts) };
}

test("runJudgeMatrix executes BOTH legs of every pool when both providers are wired", async () => {
  const store = makeTempStore("judge-matrix-");
  const anthropic = new MockJudgeProvider();
  const openai = new MockJudgeProvider();
  const pools = [poolEntry("arm=B|brief=biz-01|rep=0|cfg=x", "B", "b idea 1", "b idea 2"), poolEntry("arm=A|brief=biz-01|rep=0|cfg=x", "A", "a idea 1")];
  const { rows, results, deferred } = await runJudgeMatrix({ pools, judgeModels: JUDGE_MODELS, providers: { anthropic, openai }, store, seed: 5, timestamp: "2026-08-02T00:00:00Z" });
  assert.equal(rows.length, 4, "2 pools x 2 providers = 4 scheduled judge rows");
  assert.equal(deferred.length, 0);
  assert.equal(results.filter((r) => r.state === "completed").length, 4);
  // Every judge model actually used is DISTINCT from that pool's own generators.
  for (const r of results) {
    const arm = pools.find((p) => p.poolKey === r.poolKey).arm;
    const generators = new Set((arm.slots || []).map((s) => s.model));
    assert.ok(!generators.has(r.judge_model), `judge ${r.judge_model} must not be a generator in arm ${arm.id}`);
  }
  // Both providers were actually driven (the schedule was executed, not just built).
  assert.ok(anthropic.calls.length === 2 && openai.calls.length === 2);
});

test("runJudgeMatrix does NOT silently drop the OpenAI leg when its provider is absent — it records it deferred", async () => {
  const store = makeTempStore("judge-defer-");
  const anthropic = new MockJudgeProvider();
  const pools = [poolEntry("arm=B|brief=biz-01|rep=0|cfg=x", "B", "b idea 1", "b idea 2")];
  const { results, deferred } = await runJudgeMatrix({ pools, judgeModels: JUDGE_MODELS, providers: { anthropic }, store, seed: 1, timestamp: "2026-08-02T00:00:00Z" });
  assert.equal(results.filter((r) => r.state === "completed" && r.judge_provider === "anthropic").length, 1);
  assert.equal(deferred.length, 1);
  assert.equal(deferred[0].judge_provider, "openai");
  assert.match(deferred[0].reason, /issue #22|not dropped/i);
});

test("runJudgeMatrix enforces distinctness at CALL time: the guarantee holds end-to-end", async () => {
  const store = makeTempStore("judge-distinct-");
  // Arm B is all-Haiku, so a Haiku judge would be non-distinct. Give the matrix
  // ONLY Haiku as an anthropic candidate → buildJudgeMatrix must refuse to
  // schedule, and runJudgeMatrix surfaces that rather than judging with a same-model judge.
  const pools = [poolEntry("arm=B|brief=biz-01|rep=0|cfg=x", "B", "b idea 1")];
  await assert.rejects(
    () => runJudgeMatrix({ pools, judgeModels: { anthropic: ["claude-haiku-4-5"], openai: ["gpt-5.4"] }, providers: { anthropic: new MockJudgeProvider(), openai: new MockJudgeProvider() }, store, seed: 1, timestamp: "2026-08-02T00:00:00Z" }),
    /no distinct anthropic judge|generator model/i,
  );
});

test("runJudgeMatrix stores per-axis scores and meters each judge call", async () => {
  const store = makeTempStore("judge-store-");
  const anthropic = new MockJudgeProvider();
  const openai = new MockJudgeProvider();
  const poolKey = "arm=B|brief=biz-01|rep=0|cfg=x";
  const pools = [poolEntry(poolKey, "B", "b idea 1", "b idea 2")];
  await runJudgeMatrix({ pools, judgeModels: JUDGE_MODELS, providers: { anthropic, openai }, store, seed: 1, timestamp: "2026-08-02T00:00:00Z" });
  // A judge-scores record exists per leg, carrying distinct per-axis fields.
  const rec = store.get(judgeScoresKey({ poolKey, judgeModel: "claude-sonnet-5" }));
  assert.equal(rec.result.kind, "judge-scores");
  assert.equal(rec.result.scores.length, 2);
  assert.ok(rec.result.scores.every((s) => typeof s.originality === "number" && typeof s.feasibility === "number"));
  // A judge-call cost record was written too (meterJudgeCall).
  const costRecord = store.get(`judge-call|cell=${poolKey}|judge=claude-sonnet-5`);
  assert.equal(costRecord.costRows.length, 1);
  assert.equal(costRecord.costRows[0].model, "claude-sonnet-5");
});

// ── AC5 + AC7: validateJudge can be run against the scorer's output; judge
//    identity feeds configHash ─────────────────────────────────────────────

test("judgeScoresForAxis feeds validateJudge without averaging any axes", () => {
  // A 24-idea synthetic set (>= MIN_IDEAS_N). Judge originality tracks expert score.
  const n = 24;
  const expert = Array.from({ length: n }, (_, i) => i + 1);
  const scores = expert.map((e) => ({ originality: e, feasibility: 5 }));
  const judgeScores = judgeScoresForAxis(scores, "originality");
  assert.deepEqual(judgeScores, expert);
  const record = validateJudge({ judgeScores, expertScores: expert });
  assert.equal(record.metric, "balanced-accuracy");
  assert.equal(record.verdict, "pass"); // perfectly aligned -> accuracy 1.0 >= 0.561 floor
  assert.throws(() => judgeScoresForAxis(scores, "overall"), /not one of the JUDGE_AXES/);
});

test("computeJudgeHash folds the prompt hash AND the judge model ids; a changed judge model changes configHash and the cell key", () => {
  const base = computeJudgeHash({ judgeModels: JUDGE_MODELS });
  assert.equal(base, computeJudgeHash({ judgeModels: { anthropic: ["claude-opus-5", "claude-sonnet-5"], openai: ["gpt-5-mini", "gpt-5.4"] } }), "order-insensitive");
  const changedModel = computeJudgeHash({ judgeModels: { anthropic: ["claude-sonnet-5", "claude-haiku-4-5"], openai: ["gpt-5.4", "gpt-5-mini"] } });
  assert.notEqual(base, changedModel, "a different judge model set must change the judge hash");
  // And the judge hash actually participates in configHash + cellKey.
  const cfgA = configHash({ harnessVersion: "0.0.1", judgeHash: base });
  const cfgB = configHash({ harnessVersion: "0.0.1", judgeHash: changedModel });
  assert.notEqual(cfgA, cfgB);
  assert.notEqual(
    cellKey({ armId: "B", briefId: "biz-01", replicate: 0, cfg: cfgA }),
    cellKey({ armId: "B", briefId: "biz-01", replicate: 0, cfg: cfgB }),
  );
  // A changed rubric would change it too (proven via a mutated prompt object hash).
  const changedPrompt = computeJudgeHash({ judgeModels: JUDGE_MODELS, promptObject: { version: "different", axes: {} } });
  assert.notEqual(base, changedPrompt);
  assert.notEqual(judgePromptHash(), judgePromptHash({ version: "different", axes: {} }));
});

// ── hermeticity: recordJudgeScores refuses to store a collapsed score ───────

test("recordJudgeScores refuses to store a collapsed/averaged score", () => {
  const store = makeTempStore("judge-collapsed-");
  assert.throws(
    () => recordJudgeScores(store, { poolKey: "arm=B|brief=x|rep=0|cfg=x", judgeModel: "claude-sonnet-5", scores: [{ overallScore: 5 }] }),
    /originality|feasibility|distinct/,
  );
});
