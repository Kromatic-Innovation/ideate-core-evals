// score.test.mjs — hermetic tests for the judge's live scoring call (issue #21).
// No network, no live key, no timers that actually wait: AnthropicJudgeProvider's
// fetchImpl/sleep seams are faked exactly like anthropic-batch.test.mjs fakes
// AnthropicBatchProvider, so this file loads under CI's `node --test` with an
// empty node_modules (the hermetic-CI invariant, see evals/harness/provider.mjs).

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  AnthropicJudgeProvider,
  OpenAIJudgeProvider,
  MockJudgeProvider,
  buildJudgeScoringPrompt,
  parseAxisScores,
  runJudgeMatrix,
  judgePaymentRefusal,
  recordJudgeScores,
  judgeScoresKey,
  judgeScoresForAxis,
  computeJudgeHash,
  MAX_JUDGE_TOKENS,
} from "./score.mjs";
import { JUDGE_AXES, judgePromptHash, JUDGE_PROMPT } from "./prompt.mjs";
import { validateJudge } from "./gate.mjs";
import { configHash, cellKey } from "../../lib/manifest.mjs";
import { makeTempStore } from "../../lib/store.mjs";
import { JUDGE_MODELS as REGISTERED_JUDGE_MODELS } from "./config.mjs";

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

// ── #82 (A1/A2): the batch path submitted no assertion on model/max_tokens —
// a mutated judgeModel or a dropped maxTokens (falling back to the provider
// helper's 2048 default) shipped green. Pin what is ACTUALLY submitted on
// the wire, not merely what score() returns — mirrors the OpenAI fixture's
// F1 fix (score.test.mjs, post-#79) rather than inventing a second shape.

test("AnthropicJudgeProvider batch: submits the exact judgeModel and MAX_JUDGE_TOKENS on every request, never a different model or the transport helper's default budget (A1/A2)", async () => {
  const capture = [];
  const provider = new AnthropicJudgeProvider({ apiKey: "k", fetchImpl: judgeBatchFetch({ capture }), sleep: noopSleep, logger: silentLogger });
  const payload = { briefText: BRIEF, candidates: poolOf("a", "b", "c") };
  const resp = await provider.score(payload, { judgeModel: "claude-sonnet-5", mode: "batch", seed: 2 });
  assert.equal(resp.terminalState, "completed");
  assert.equal(capture.length, 3, "one submitted request per candidate");
  for (const req of capture) {
    assert.equal(req.params.model, "claude-sonnet-5", "the submitted request must use the exact judgeModel passed in, not a different/wrong model");
    assert.equal(req.params.max_tokens, MAX_JUDGE_TOKENS, "the submitted request must use MAX_JUDGE_TOKENS, not the transport helper's default budget");
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

test("AnthropicJudgeProvider single: submits the exact judgeModel and MAX_JUDGE_TOKENS, never a different model or the transport helper's default budget (A1/A2)", async () => {
  const capturedBodies = [];
  const provider = new AnthropicJudgeProvider({
    apiKey: "k",
    fetchImpl: async (url, opts) => {
      capturedBodies.push(JSON.parse(opts.body));
      return jsonResponse(200, { content: [{ type: "text", text: scoreJsonForIndex(0) }], usage: { input_tokens: 4, output_tokens: 2 }, stop_reason: "end_turn" });
    },
    sleep: noopSleep,
    logger: silentLogger,
  });
  const resp = await provider.score({ briefText: BRIEF, candidates: poolOf("only one") }, { judgeModel: "claude-sonnet-5", mode: "single", seed: 1 });
  assert.equal(resp.terminalState, "completed");
  assert.equal(capturedBodies.length, 1);
  assert.equal(capturedBodies[0].model, "claude-sonnet-5", "single mode must submit the exact judgeModel passed in, not a different/wrong model");
  assert.equal(capturedBodies[0].max_tokens, MAX_JUDGE_TOKENS, "single mode must submit MAX_JUDGE_TOKENS, not the transport helper's default budget");
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

// ── #82 (A3): a batch result row without result.type === "succeeded" must
// never be parsed as if it had succeeded — an errored row carries no
// `message`, so treating `row.result` truthy as sufficient (dropping the
// `.type === "succeeded"` check) silently reads an errored row's absent
// text as an empty reply instead of surfacing the real classified failure.

test("AnthropicJudgeProvider batch: a result row without result.type === 'succeeded' is never treated as a success (A3)", async () => {
  const provider = new AnthropicJudgeProvider({
    apiKey: "k",
    fetchImpl: async (url) => {
      const u = String(url);
      if (u.endsWith("/v1/messages/batches")) return jsonResponse(200, { id: "jbatch_1", processing_status: "ended", results_url: "https://fake/jresults" });
      // The ONLY result row is ERRORED, not succeeded — it carries no `message`.
      const row = { custom_id: "cand-0", result: { type: "errored", error: { type: "rate_limit_error" } } };
      return textResponse(JSON.stringify(row));
    },
    sleep: noopSleep,
    logger: silentLogger,
  });
  const resp = await provider.score({ briefText: BRIEF, candidates: poolOf("only one") }, { judgeModel: "claude-sonnet-5", mode: "batch", seed: 1 });
  assert.equal(resp.terminalState, "failed", "an errored row must never be accepted as a successful reply");
  assert.equal(resp.failureKind, "rate_limited", "the errored row's rate_limit_error type must be classified — a row.result truthy check alone would instead treat the row as a (missing) success and fail later as an unrelated parse_failure");
});

// ── #82 (A4): silent score mis-attribution. A batch result row whose
// custom_id is not in the request set must be DROPPED, never attributed to
// a real candidate by line position — asserting the STRONG invariant (every
// candidate keeps its OWN score) rather than merely "the pool fails", which
// a `requests[0]`-style positional fallback can satisfy for the wrong reason
// (it can only overwrite an already-filled slot, so replies.size still comes
// up short and the pool still fails — but via the partial-reply guard, not
// because the unmatched row was actually rejected).

test("AnthropicJudgeProvider batch: an unmatched custom_id in the output is dropped, never attributed to a real candidate by line position (A4)", async () => {
  const provider = new AnthropicJudgeProvider({
    apiKey: "k",
    fetchImpl: async (url) => {
      const u = String(url);
      if (u.endsWith("/v1/messages/batches")) return jsonResponse(200, { id: "jbatch_1", processing_status: "ended", results_url: "https://fake/jresults" });
      if (u.includes("/v1/messages/batches/")) return jsonResponse(200, { id: "jbatch_1", processing_status: "ended", results_url: "https://fake/jresults" });
      if (u === "https://fake/jresults") {
        const lines = [
          resultLine("cand-0", scoreJsonForIndex(0)),
          resultLine("cand-1", scoreJsonForIndex(1)),
          // An UNMATCHED custom_id, appended LAST — under a positional-
          // fallback bug, a wraparound line index would silently OVERWRITE
          // whichever real candidate landed at requests[0] with this 10/10.
          resultLine("cand-does-not-exist", JSON.stringify({ originality: 10, feasibility: 10 })),
        ];
        return textResponse(lines.map((l) => JSON.stringify(l)).join("\n"));
      }
      throw new Error(`unexpected URL ${u}`);
    },
    sleep: noopSleep,
    logger: silentLogger,
  });
  const resp = await provider.score({ briefText: BRIEF, candidates: poolOf("a", "b") }, { judgeModel: "claude-sonnet-5", mode: "batch", seed: 3 });
  assert.equal(resp.terminalState, "completed");
  resp.scores.forEach((s, i) => assert.equal(s.originality, i + 1, `candidate ${i} must keep its OWN score, never the unmatched line's 10/10`));
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

// ── OpenAIJudgeProvider (issue #77) ──────────────────────────────────────────
// Same interface + FLAT metering contract as AnthropicJudgeProvider, but the
// OpenAI Batches transport: upload -> create -> poll -> download, keyed by
// custom_id. Deliberately a REAL provider driven through an injected
// fetchImpl (never MockJudgeProvider), so a regression that returns OpenAI's
// generation-shaped `tokens_by_model` instead of flat input_tokens/
// output_tokens fails these tests -- MockJudgeProvider always returns the
// flat shape regardless of what the real provider does, which is exactly the
// blind spot issue #77 flags in the runJudgeMatrix tests above.

function openaiJudgeResultLine(custom_id, contentObj, usage = { prompt_tokens: 10, completion_tokens: 5 }) {
  return { custom_id, response: { status_code: 200, body: { choices: [{ message: { content: JSON.stringify(contentObj) } }], usage } }, error: null };
}

/**
 * A batch fetchImpl for the OpenAI judge transport: submit (upload+create)
 * reports "completed" immediately; the output file echoes, per custom_id
 * `cand-<i>`, a score whose originality encodes i — returned in REVERSED
 * order, so the test proves the provider keys by custom_id (not line
 * position) AND maps scores back to input order.
 *
 * `capture`, when supplied, is filled with what was ACTUALLY submitted over
 * the wire: the upload form's `purpose` and per-line JSONL bodies (F1 fix —
 * previously this fixture read only `custom_id` back out of the upload and
 * never inspected the request body itself, so a corrupted prompt/model/
 * maxTokens/purpose/endpoint could ship and every batch test stayed green).
 */
function openaiJudgeBatchFetch({ usage, capture } = {}) {
  let submitted = [];
  return async (url, opts) => {
    const u = String(url);
    if (u === "https://api.openai.com/v1/files" && opts.method === "POST") {
      const text = await opts.body.get("file").text(); // FormData -> Blob -> JSONL
      submitted = text.split("\n").filter(Boolean).map((l) => JSON.parse(l));
      if (capture) {
        capture.purpose = opts.body.get("purpose");
        capture.uploadUrl = u;
        capture.uploadMethod = opts.method;
        capture.lines = submitted;
      }
      return jsonResponse(200, { id: "ofile_1" });
    }
    if (u === "https://api.openai.com/v1/batches" && opts.method === "POST") {
      if (capture) {
        capture.createBody = JSON.parse(opts.body);
        capture.createUrl = u;
        capture.createMethod = opts.method;
      }
      return jsonResponse(200, { id: "obatch_1", status: "completed", output_file_id: "oout_1" });
    }
    if (u.startsWith("https://api.openai.com/v1/batches/")) {
      return jsonResponse(200, { id: "obatch_1", status: "completed", output_file_id: "oout_1" });
    }
    if (u === "https://api.openai.com/v1/files/oout_1/content") {
      const lines = submitted
        .map((r) => {
          const i = Number(r.custom_id.replace("cand-", ""));
          return openaiJudgeResultLine(r.custom_id, JSON.parse(scoreJsonForIndex(i)), usage);
        })
        .reverse();
      return textResponse(lines.map((l) => JSON.stringify(l)).join("\n"));
    }
    throw new Error(`openaiJudgeBatchFetch: unexpected URL ${u}`);
  };
}

test("OpenAIJudgeProvider.score (batch) turns a pool into per-axis scores, un-permuted to INPUT order", async () => {
  const provider = new OpenAIJudgeProvider({ apiKey: "k", fetchImpl: openaiJudgeBatchFetch(), sleep: noopSleep, logger: silentLogger });
  const resp = await provider.score({ briefText: BRIEF, candidates: poolOf("a", "b", "c") }, { judgeModel: "gpt-5.6-terra", mode: "batch", seed: 3 });
  assert.equal(resp.terminalState, "completed");
  assert.equal(resp.scores.length, 3);
  resp.scores.forEach((s, i) => assert.equal(s.originality, i + 1, `score ${i} must be un-permuted back to input order`));
});

// ── F1 (review-round fix): the batch fixture above only ever read
// `custom_id` back out of the upload — it never inspected WHAT was actually
// submitted. That let a corrupted prompt/model/maxTokens/purpose/endpoint
// ship silently (batch is the default mode and what the study runs). This
// test pins every one of those fields on the request actually sent over the
// wire, not on what score() merely returns.
test("OpenAIJudgeProvider.score (batch) submits the real frozen rubric prompt, the exact judgeModel, MAX_JUDGE_TOKENS, and the correct purpose/url/method/endpoint", async () => {
  const capture = {};
  const provider = new OpenAIJudgeProvider({ apiKey: "k", fetchImpl: openaiJudgeBatchFetch({ capture }), sleep: noopSleep, logger: silentLogger });
  const resp = await provider.score({ briefText: BRIEF, candidates: poolOf("a", "b") }, { judgeModel: "gpt-5.6-terra", mode: "batch", seed: 3 });
  assert.equal(resp.terminalState, "completed");

  // Upload leg: purpose must be "batch" (not e.g. "fine-tune"), hit the
  // right URL with POST.
  assert.equal(capture.purpose, "batch");
  assert.equal(capture.uploadUrl, "https://api.openai.com/v1/files");
  assert.equal(capture.uploadMethod, "POST");
  assert.ok(capture.lines.length === 2, "one JSONL line per candidate");
  for (const line of capture.lines) {
    assert.equal(line.method, "POST");
    assert.equal(line.url, "/v1/chat/completions");
    // The REAL §5 rubric text must reach the judge -- not a substring so weak
    // that the literal "score this" would pass. JUDGE_PROMPT.instructions is
    // the frozen rubric's own wording (prompt.mjs), so this can only pass if
    // buildJudgeScoringPrompt's actual output reached the wire.
    assert.ok(line.body.messages[0].content.includes(JUDGE_PROMPT.instructions), "the submitted prompt must carry the frozen §5 rubric instructions verbatim");
    assert.ok(line.body.messages[0].content.includes(JUDGE_PROMPT.outputFormat), "the submitted prompt must carry the frozen rubric's output-format text");
    assert.equal(line.body.model, "gpt-5.6-terra", "the submitted request must use the exact judgeModel passed in, not a different/default model");
    assert.equal(line.body.max_completion_tokens, MAX_JUDGE_TOKENS, "the submitted request must use MAX_JUDGE_TOKENS, not a default budget");
  }

  // Create-batch leg: correct endpoint, URL, method.
  assert.equal(capture.createBody.endpoint, "/v1/chat/completions");
  assert.equal(capture.createUrl, "https://api.openai.com/v1/batches");
  assert.equal(capture.createMethod, "POST");
});

test("OpenAIJudgeProvider tokens are FLAT (model,input_tokens,output_tokens) — never tokens_by_model — and prompt_tokens/completion_tokens are TRANSLATED, never forwarded under their native names", async () => {
  const provider = new OpenAIJudgeProvider({
    apiKey: "k",
    fetchImpl: openaiJudgeBatchFetch({ usage: { prompt_tokens: 100, completion_tokens: 50 } }),
    sleep: noopSleep,
    logger: silentLogger,
  });
  const resp = await provider.score({ briefText: BRIEF, candidates: poolOf("a", "b") }, { judgeModel: "gpt-5.6-terra", mode: "batch", seed: 1 });
  assert.equal(resp.terminalState, "completed");
  assert.equal(resp.tokens.model, "gpt-5.6-terra");
  assert.equal(resp.tokens.input_tokens, 200, "2 candidates x 100 prompt_tokens each");
  assert.equal(resp.tokens.output_tokens, 100, "2 candidates x 50 completion_tokens each");
  assert.ok(!("tokens_by_model" in resp.tokens), "the judge tokens shape must be flat, never nested under tokens_by_model");
  assert.ok(!("prompt_tokens" in resp.tokens) && !("completion_tokens" in resp.tokens), "OpenAI's native field names must never be forwarded verbatim");
});

test("OpenAIJudgeProvider score (single) hits /v1/chat/completions directly, not the Batches API, and submits the real rubric prompt/model/maxTokens", async () => {
  const calledUrls = [];
  const capturedBodies = [];
  const fetchImpl = async (url, opts) => {
    calledUrls.push(String(url));
    capturedBodies.push(JSON.parse(opts.body));
    return jsonResponse(200, { choices: [{ message: { content: scoreJsonForIndex(0) } }], usage: { prompt_tokens: 7, completion_tokens: 3 } });
  };
  const provider = new OpenAIJudgeProvider({ apiKey: "k", fetchImpl, sleep: noopSleep, logger: silentLogger });
  const resp = await provider.score({ briefText: BRIEF, candidates: poolOf("a") }, { judgeModel: "gpt-5.6-terra", mode: "single", seed: 1 });
  assert.equal(resp.terminalState, "completed");
  assert.deepEqual(calledUrls, ["https://api.openai.com/v1/chat/completions"]);
  assert.equal(resp.tokens.input_tokens, 7);
  assert.equal(resp.tokens.output_tokens, 3);
  // F1: pin what was actually SUBMITTED, not just what score() returns — the
  // real §5 rubric, the exact judgeModel, and MAX_JUDGE_TOKENS.
  assert.equal(capturedBodies.length, 1);
  assert.ok(capturedBodies[0].messages[0].content.includes(JUDGE_PROMPT.instructions), "single mode must submit the frozen §5 rubric instructions verbatim");
  assert.ok(capturedBodies[0].messages[0].content.includes(JUDGE_PROMPT.outputFormat), "single mode must submit the frozen rubric's output-format text");
  assert.equal(capturedBodies[0].model, "gpt-5.6-terra", "single mode must submit the exact judgeModel passed in");
  assert.equal(capturedBodies[0].max_completion_tokens, MAX_JUDGE_TOKENS, "single mode must submit MAX_JUDGE_TOKENS, not a default budget");
});

test("no apiKey: OpenAIJudgeProvider.score() returns a classified harness_error rather than throwing", async () => {
  const provider = new OpenAIJudgeProvider({ apiKey: undefined, fetchImpl: async () => { throw new Error("must not be called"); }, sleep: noopSleep, logger: silentLogger });
  const resp = await provider.score({ briefText: BRIEF, candidates: poolOf("a") }, { judgeModel: "gpt-5.6-terra", mode: "batch", seed: 1 });
  assert.equal(resp.terminalState, "failed");
  assert.equal(resp.failureKind, "harness_error");
});

test("OpenAIJudgeProvider: an empty candidate pool classifies as empty_pool (nothing to score), never throws", async () => {
  const provider = new OpenAIJudgeProvider({ apiKey: "k", fetchImpl: async () => { throw new Error("must not be called"); }, sleep: noopSleep, logger: silentLogger });
  const resp = await provider.score({ briefText: BRIEF, candidates: [] }, { judgeModel: "gpt-5.6-terra", mode: "batch", seed: 1 });
  assert.equal(resp.terminalState, "failed");
  assert.equal(resp.failureKind, "empty_pool");
});

test("OpenAIJudgeProvider: an unseeded (non-integer) seed is a classified harness_error", async () => {
  const provider = new OpenAIJudgeProvider({ apiKey: "k", fetchImpl: async () => { throw new Error("must not be called"); }, sleep: noopSleep, logger: silentLogger });
  const resp = await provider.score({ briefText: BRIEF, candidates: poolOf("a") }, { judgeModel: "gpt-5.6-terra", mode: "batch" });
  assert.equal(resp.terminalState, "failed");
  assert.equal(resp.failureKind, "harness_error");
});

test("OpenAIJudgeProvider: a 500 on file upload classifies as transport_error, never throws; tokens shape still present and flat", async () => {
  const provider = new OpenAIJudgeProvider({ apiKey: "k", fetchImpl: async () => jsonResponse(500, {}), sleep: noopSleep, maxRetries: 0, logger: silentLogger });
  const resp = await provider.score({ briefText: BRIEF, candidates: poolOf("a", "b") }, { judgeModel: "gpt-5.6-terra", mode: "batch", seed: 1 });
  assert.equal(resp.terminalState, "failed");
  assert.equal(resp.failureKind, "transport_error");
  assert.deepEqual(resp.tokens, { model: "gpt-5.6-terra", input_tokens: 0, output_tokens: 0 });
});

test("OpenAIJudgeProvider: a persistent 429 classifies as rate_limited", async () => {
  const provider = new OpenAIJudgeProvider({ apiKey: "k", fetchImpl: async () => jsonResponse(429, {}), sleep: noopSleep, maxRetries: 1, logger: silentLogger });
  const resp = await provider.score({ briefText: BRIEF, candidates: poolOf("a") }, { judgeModel: "gpt-5.6-terra", mode: "batch", seed: 1 });
  assert.equal(resp.terminalState, "failed");
  assert.equal(resp.failureKind, "rate_limited");
});

test("OpenAIJudgeProvider: a batch that never completes before the poll ceiling classifies as timeout", async () => {
  const provider = new OpenAIJudgeProvider({
    apiKey: "k",
    fetchImpl: async (url, opts) => {
      const u = String(url);
      if (u === "https://api.openai.com/v1/files" && opts.method === "POST") return jsonResponse(200, { id: "f1" });
      return jsonResponse(200, { id: "b1", status: "in_progress" });
    },
    sleep: noopSleep,
    maxPollMs: -1, // deadline already past on the first check
    logger: silentLogger,
  });
  const resp = await provider.score({ briefText: BRIEF, candidates: poolOf("a") }, { judgeModel: "gpt-5.6-terra", mode: "batch", seed: 1 });
  assert.equal(resp.terminalState, "failed");
  assert.equal(resp.failureKind, "timeout");
});

test("OpenAIJudgeProvider: a failed leg that consumed tokens before failing still reports those tokens (failure paths meter)", async () => {
  // single mode, 2 candidates: one succeeds (consumes tokens) and one hits a
  // persistent 500 — the pool still fails overall (partial-reply guard), but
  // the tokens actually spent by the succeeding call must survive on `tokens`
  // so the caller can still meter real spend for a failed leg.
  const fetchImpl = async (url, opts) => {
    const body = JSON.parse(opts.body);
    if (body.messages[0].content.includes("fail-me")) return jsonResponse(500, {});
    return jsonResponse(200, { choices: [{ message: { content: scoreJsonForIndex(0) } }], usage: { prompt_tokens: 20, completion_tokens: 10 } });
  };
  const provider = new OpenAIJudgeProvider({ apiKey: "k", fetchImpl, sleep: noopSleep, maxRetries: 0, logger: silentLogger });
  const resp = await provider.score(
    { briefText: BRIEF, candidates: poolOf("succeeds fine", "fail-me please") },
    { judgeModel: "gpt-5.6-terra", mode: "single", seed: 1 },
  );
  assert.equal(resp.terminalState, "failed");
  assert.equal(resp.failureKind, "transport_error");
  assert.equal(resp.tokens.input_tokens, 20, "the succeeding call's real spend is still reported on a failed leg");
  assert.equal(resp.tokens.output_tokens, 10);
});

// ── F2 (review-round fix): batch result rows were accepted without real
// validation -- an unknown custom_id could fall back to a positional match
// (candidate X's score silently attached to candidate Y), and the row's
// error/status_code fields could be ignored as long as `response.body` was
// merely present. These tests pin both, plus the token-accounting
// implication of a duplicate custom_id.

test("OpenAIJudgeProvider batch: an unmatched custom_id in the output is dropped, never attributed to a real candidate by line position (F2)", async () => {
  let submitted = [];
  const fetchImpl = async (url, opts) => {
    const u = String(url);
    if (u === "https://api.openai.com/v1/files" && opts.method === "POST") {
      const text = await opts.body.get("file").text();
      submitted = text.split("\n").filter(Boolean).map((l) => JSON.parse(l));
      return jsonResponse(200, { id: "ofile_1" });
    }
    if (u === "https://api.openai.com/v1/batches" && opts.method === "POST") return jsonResponse(200, { id: "obatch_1", status: "completed", output_file_id: "oout_1" });
    if (u.startsWith("https://api.openai.com/v1/batches/")) return jsonResponse(200, { id: "obatch_1", status: "completed", output_file_id: "oout_1" });
    if (u === "https://api.openai.com/v1/files/oout_1/content") {
      const lines = submitted.map((r) => {
        const i = Number(r.custom_id.replace("cand-", ""));
        return openaiJudgeResultLine(r.custom_id, JSON.parse(scoreJsonForIndex(i)));
      });
      // An UNMATCHED custom_id, appended LAST -- under a positional-fallback
      // bug (`req = requests[lineNo % requests.length]`), lineNo === requests.length
      // wraps to index 0 and this line's 10/10 score would silently
      // OVERWRITE whichever real candidate landed at requests[0].
      lines.push(openaiJudgeResultLine("cand-does-not-exist", { originality: 10, feasibility: 10 }));
      return textResponse(lines.map((l) => JSON.stringify(l)).join("\n"));
    }
    throw new Error(`unexpected URL ${u}`);
  };
  const provider = new OpenAIJudgeProvider({ apiKey: "k", fetchImpl, sleep: noopSleep, logger: silentLogger });
  const resp = await provider.score({ briefText: BRIEF, candidates: poolOf("a", "b") }, { judgeModel: "gpt-5.6-terra", mode: "batch", seed: 3 });
  assert.equal(resp.terminalState, "completed");
  resp.scores.forEach((s, i) => assert.equal(s.originality, i + 1, `candidate ${i} must keep its OWN score, never the unmatched line's 10/10`));
});

test("OpenAIJudgeProvider batch: a result row carrying `error` is never treated as a success, even if `response.body` is well-formed (F2)", async () => {
  const fetchImpl = async (url, opts) => {
    const u = String(url);
    if (u === "https://api.openai.com/v1/files" && opts.method === "POST") return jsonResponse(200, { id: "ofile_1" });
    if (u === "https://api.openai.com/v1/batches" && opts.method === "POST") return jsonResponse(200, { id: "obatch_1", status: "completed", output_file_id: "oout_1" });
    if (u.startsWith("https://api.openai.com/v1/batches/")) return jsonResponse(200, { id: "obatch_1", status: "completed", output_file_id: "oout_1" });
    if (u === "https://api.openai.com/v1/files/oout_1/content") {
      const row = {
        custom_id: "cand-0",
        error: { message: "server-side error" },
        response: { status_code: 200, body: { choices: [{ message: { content: scoreJsonForIndex(0) } }], usage: { prompt_tokens: 10, completion_tokens: 5 } } },
      };
      return textResponse(JSON.stringify(row));
    }
    throw new Error(`unexpected URL ${u}`);
  };
  const provider = new OpenAIJudgeProvider({ apiKey: "k", fetchImpl, sleep: noopSleep, logger: silentLogger });
  const resp = await provider.score({ briefText: BRIEF, candidates: poolOf("a") }, { judgeModel: "gpt-5.6-terra", mode: "batch", seed: 1 });
  assert.equal(resp.terminalState, "failed", "a row.error must never be masked by a well-formed response.body");
  assert.equal(resp.failureKind, "transport_error");
});

test("OpenAIJudgeProvider batch: a non-2xx status_code is never treated as success, even when response.body is present (F2)", async () => {
  const fetchImpl = async (url, opts) => {
    const u = String(url);
    if (u === "https://api.openai.com/v1/files" && opts.method === "POST") return jsonResponse(200, { id: "ofile_1" });
    if (u === "https://api.openai.com/v1/batches" && opts.method === "POST") return jsonResponse(200, { id: "obatch_1", status: "completed", output_file_id: "oout_1" });
    if (u.startsWith("https://api.openai.com/v1/batches/")) return jsonResponse(200, { id: "obatch_1", status: "completed", output_file_id: "oout_1" });
    if (u === "https://api.openai.com/v1/files/oout_1/content") {
      const row = {
        custom_id: "cand-0",
        error: null,
        response: { status_code: 500, body: { choices: [{ message: { content: scoreJsonForIndex(0) } }], usage: { prompt_tokens: 10, completion_tokens: 5 } } },
      };
      return textResponse(JSON.stringify(row));
    }
    throw new Error(`unexpected URL ${u}`);
  };
  const provider = new OpenAIJudgeProvider({ apiKey: "k", fetchImpl, sleep: noopSleep, logger: silentLogger });
  const resp = await provider.score({ briefText: BRIEF, candidates: poolOf("a") }, { judgeModel: "gpt-5.6-terra", mode: "batch", seed: 1 });
  assert.equal(resp.terminalState, "failed", "a non-2xx status_code must never be treated as success merely because response.body exists");
  assert.equal(resp.failureKind, "transport_error");
});

test("OpenAIJudgeProvider batch: a duplicate custom_id in the output still meters ALL matched lines' usage, even though the pool fails from too few distinct replies (F2)", async () => {
  const fetchImpl = async (url, opts) => {
    const u = String(url);
    if (u === "https://api.openai.com/v1/files" && opts.method === "POST") return jsonResponse(200, { id: "ofile_1" });
    if (u === "https://api.openai.com/v1/batches" && opts.method === "POST") return jsonResponse(200, { id: "obatch_1", status: "completed", output_file_id: "oout_1" });
    if (u.startsWith("https://api.openai.com/v1/batches/")) return jsonResponse(200, { id: "obatch_1", status: "completed", output_file_id: "oout_1" });
    if (u === "https://api.openai.com/v1/files/oout_1/content") {
      // Only 2 distinct custom_ids reply for a 3-candidate pool; cand-0 is
      // DUPLICATED. The pool must still fail (a genuine missing reply for
      // the 3rd candidate), but tokens actually consumed by BOTH cand-0
      // lines are real spend and must both be metered -- not deduplicated.
      const lines = [
        openaiJudgeResultLine("cand-0", { originality: 1, feasibility: 3 }),
        openaiJudgeResultLine("cand-0", { originality: 1, feasibility: 3 }), // duplicate reply
        openaiJudgeResultLine("cand-1", { originality: 2, feasibility: 3 }),
      ];
      return textResponse(lines.map((l) => JSON.stringify(l)).join("\n"));
    }
    throw new Error(`unexpected URL ${u}`);
  };
  const provider = new OpenAIJudgeProvider({ apiKey: "k", fetchImpl, sleep: noopSleep, logger: silentLogger });
  const resp = await provider.score({ briefText: BRIEF, candidates: poolOf("a", "b", "c") }, { judgeModel: "gpt-5.6-terra", mode: "batch", seed: 1 });
  assert.equal(resp.terminalState, "failed", "only 2/3 distinct candidates replied -- the pool must fail (partial-reply guard)");
  assert.equal(resp.failureKind, "transport_error");
  assert.equal(resp.tokens.input_tokens, 30, "BOTH cand-0 lines' usage is metered even though one is a duplicate reply -- real tokens were spent");
  assert.equal(resp.tokens.output_tokens, 15);
});

// ── F3 (review-round fix): the OpenAI batch poll loop was never exercised --
// every other batch test's fetchImpl returns "completed" straight from
// CREATE, so the `while (batchStatus.status !== "completed")` body never
// ran, and the terminal `failed | expired | cancelled` branch had no test
// covering it at all. These tests pin the normal submit -> in_progress ->
// completed lifecycle, and each terminal failure state.

test("OpenAIJudgeProvider batch: the normal lifecycle actually polls (submit in_progress -> poll in_progress -> poll completed) (F3)", async () => {
  let pollCount = 0;
  const fetchImpl = async (url, opts) => {
    const u = String(url);
    if (u === "https://api.openai.com/v1/files" && opts.method === "POST") return jsonResponse(200, { id: "ofile_1" });
    if (u === "https://api.openai.com/v1/batches" && opts.method === "POST") return jsonResponse(200, { id: "obatch_1", status: "in_progress" });
    if (u.startsWith("https://api.openai.com/v1/batches/")) {
      pollCount++;
      if (pollCount < 2) return jsonResponse(200, { id: "obatch_1", status: "in_progress" });
      return jsonResponse(200, { id: "obatch_1", status: "completed", output_file_id: "oout_1" });
    }
    if (u === "https://api.openai.com/v1/files/oout_1/content") {
      return textResponse(JSON.stringify(openaiJudgeResultLine("cand-0", JSON.parse(scoreJsonForIndex(0)))));
    }
    throw new Error(`unexpected URL ${u}`);
  };
  const provider = new OpenAIJudgeProvider({ apiKey: "k", fetchImpl, sleep: noopSleep, logger: silentLogger });
  const resp = await provider.score({ briefText: BRIEF, candidates: poolOf("a") }, { judgeModel: "gpt-5.6-terra", mode: "batch", seed: 1 });
  assert.equal(resp.terminalState, "completed");
  assert.ok(pollCount >= 2, "the poll loop must actually run more than once before reaching completed -- proves poll results are genuinely read, not shortcut to completed on the first check");
});

for (const terminalState of ["failed", "expired", "cancelled"]) {
  test(`OpenAIJudgeProvider batch: a batch that reaches OpenAI terminal state "${terminalState}" classifies as transport_error, never hangs or silently succeeds (F3)`, async () => {
    const fetchImpl = async (url, opts) => {
      const u = String(url);
      if (u === "https://api.openai.com/v1/files" && opts.method === "POST") return jsonResponse(200, { id: "ofile_1" });
      if (u === "https://api.openai.com/v1/batches" && opts.method === "POST") return jsonResponse(200, { id: "obatch_1", status: "in_progress" });
      if (u.startsWith("https://api.openai.com/v1/batches/")) return jsonResponse(200, { id: "obatch_1", status: terminalState });
      throw new Error(`unexpected URL ${u}`);
    };
    // maxPollMs is bounded so that a mutation deleting the terminal-state
    // branch (which would otherwise hot-spin on Date.now() > deadline against
    // the LIVE 15-minute default) fails this test in ~1s via a classified
    // "timeout" instead of hanging the suite for 15 real minutes.
    const provider = new OpenAIJudgeProvider({ apiKey: "k", fetchImpl, sleep: noopSleep, maxPollMs: 1000, logger: silentLogger });
    const resp = await provider.score({ briefText: BRIEF, candidates: poolOf("a") }, { judgeModel: "gpt-5.6-terra", mode: "batch", seed: 1 });
    assert.equal(resp.terminalState, "failed");
    assert.equal(resp.failureKind, "transport_error", `a batch reaching OpenAI's "${terminalState}" state must be classified, not treated as completed or left to poll forever`);
  });
}

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

// ── issue #119: runJudgeMatrix's `mode` reaches meterJudgeCall, so every
// judge-call cost row (a FLAT, non-tokens_by_model shape) carries its own
// pricing_regime rather than staying on meterJudgeCall's default forever. ──
test("issue #119: runJudgeMatrix threads `mode` onto every judge-call costRow's pricing_regime", async () => {
  const store = makeTempStore("judge-matrix-mode-");
  const anthropic = new MockJudgeProvider();
  const openai = new MockJudgeProvider();
  const pools = [poolEntry("arm=B|brief=biz-01|rep=0|cfg=x", "B", "b idea 1", "b idea 2")];
  const { costRows } = await runJudgeMatrix({
    pools,
    judgeModels: JUDGE_MODELS,
    providers: { anthropic, openai },
    store,
    seed: 1,
    mode: "single",
    timestamp: "2026-08-02T00:00:00Z",
  });
  assert.ok(costRows.length > 0);
  for (const row of costRows) {
    assert.equal(row.pricing_regime, "single", "the composition's own mode, not meterJudgeCall's default");
    assert.ok(!("tokens_by_model" in row), "a judge-call row is the FLAT shape, not tokens_by_model");
  }
});

test("runJudgeMatrix does NOT silently drop the OpenAI leg when its provider is absent — it records it deferred", async () => {
  const store = makeTempStore("judge-defer-");
  const anthropic = new MockJudgeProvider();
  const pools = [poolEntry("arm=B|brief=biz-01|rep=0|cfg=x", "B", "b idea 1", "b idea 2")];
  const { results, deferred } = await runJudgeMatrix({ pools, judgeModels: JUDGE_MODELS, providers: { anthropic }, store, seed: 1, timestamp: "2026-08-02T00:00:00Z" });
  assert.equal(results.filter((r) => r.state === "completed" && r.judge_provider === "anthropic").length, 1);
  assert.equal(deferred.length, 1);
  assert.equal(deferred[0].judge_provider, "openai");
  assert.match(deferred[0].reason, /issue #77/i);
});

// #81 — this test's ORIGINAL name ("enforces distinctness at CALL time") was
// false: buildJudgeMatrix refuses to SCHEDULE here (no distinct Haiku
// candidate exists for all-Haiku arm B), so runJudgeMatrix's per-row loop —
// and the call-time assertEvaluatorDistinct at score.mjs:880 — is never
// reached. `assert.rejects` here is satisfied by buildJudgeMatrix's own
// thrown error. This is still a legitimate, worth-keeping test — it just
// verifies schedule-time refusal SURFACED THROUGH runJudgeMatrix, not
// call-time enforcement. Renamed to say that; see the next test for actual
// call-time coverage.
test("runJudgeMatrix surfaces buildJudgeMatrix's SCHEDULE-time refusal when no candidate judge is distinct from the arm's generators (not call-time — see the next test for that)", async () => {
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

// #81 — actual CALL-time coverage. The belt (score.mjs:880's
// assertEvaluatorDistinct call inside the per-row loop) is separately
// reachable from the suspenders (buildJudgeMatrix's schedule-time refusal)
// whenever the arm a row was SCHEDULED against diverges from the arm looked
// up for that row at CALL time. That divergence is reachable today without
// any production change: runJudgeMatrix's `poolByKey` Map is keyed by
// `poolKey` alone (score.mjs:863-867, "for (const p of pools)
// poolByKey.set(p.poolKey, p)"), last-write-wins — while buildJudgeMatrix
// schedules each pool ENTRY independently against its OWN arm
// (matrix.mjs's pickDistinctJudge runs per entry, not per unique poolKey).
// So two pool entries sharing one poolKey but carrying DIFFERENT arms both
// schedule successfully (each against its own arm — buildJudgeMatrix never
// refuses), but every row for that poolKey is then looked up against
// whichever entry's arm was written LAST. This test builds exactly that:
// arm B (all-Haiku) and arm D (all-Opus) share one poolKey; an Opus judge is
// scheduled for the arm-B entry (distinct from Haiku) and a Sonnet judge for
// the arm-D entry (Opus isn't distinct from Opus, so pickDistinctJudge falls
// through to Sonnet) — buildJudgeMatrix returns normally. But poolByKey
// resolves EVERY row for this poolKey to the arm-D entry, so the row
// scheduled with the Opus judge is checked at call time against arm D
// (all-Opus generators) — only score.mjs:880 can catch that.
test("runJudgeMatrix enforces distinctness at CALL time: a row's arm can diverge from what it was scheduled against, and only the call-time assert catches it (#81)", async () => {
  const store = makeTempStore("judge-distinct-calltime-");
  const poolKey = "arm=B|brief=biz-01|rep=0|cfg=x";
  const pools = [
    { poolKey, arm: { id: "B", ...armsConfigJson.arms.B }, briefText: BRIEF, candidates: poolOf("b idea 1") },
    { poolKey, arm: { id: "D", ...armsConfigJson.arms.D }, briefText: BRIEF, candidates: poolOf("d idea 1") },
  ];
  await assert.rejects(
    () =>
      runJudgeMatrix({
        pools,
        judgeModels: { anthropic: ["claude-opus-5", "claude-sonnet-5"], openai: ["gpt-5.6-terra"] },
        providers: { anthropic: new MockJudgeProvider(), openai: new MockJudgeProvider() },
        store,
        seed: 1,
        timestamp: "2026-08-02T00:00:00Z",
      }),
    /also a generator model in this arm/i,
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
  const costRecord = store.get(`judge-call|cell=${poolKey}|judge=claude-sonnet-5|attempt=0`);
  assert.equal(costRecord.costRows.length, 1);
  assert.equal(costRecord.costRows[0].model, "claude-sonnet-5");
});

// ── issue #63: judge cost rows reach the ledger + per-provider attribution ──

test("runJudgeMatrix returns a costRow for every completed judge call — this is RED on the pre-#63 code (no costRows field at all)", async () => {
  const store = makeTempStore("judge-costrows-");
  const anthropic = new MockJudgeProvider();
  const openai = new MockJudgeProvider();
  const poolKey = "arm=B|brief=biz-01|rep=0|cfg=x";
  const pools = [poolEntry(poolKey, "B", "b idea 1", "b idea 2")];
  const { costRows } = await runJudgeMatrix({ pools, judgeModels: JUDGE_MODELS, providers: { anthropic, openai }, store, seed: 1, timestamp: "2026-08-02T00:00:00Z" });

  assert.equal(costRows.length, 2, "one costRow per scheduled judge leg (anthropic + openai)");
  for (const row of costRows) {
    assert.equal(row.cellKey, poolKey);
    assert.equal(row.billing_mode, "api");
    assert.ok(typeof row.model === "string" && row.model.length > 0, "a judge row is single-model, per costRow()'s contract");
    assert.ok(!("cost_usd" in row) && !("notional_usd" in row), "never a stored dollar figure");
  }
  // The SAME row objects the store actually persisted — never a second,
  // independently-built row (double-count guard).
  const stored = store.get(`judge-call|cell=${poolKey}|judge=${costRows[0].model}|attempt=0`);
  assert.deepEqual(stored.costRows[0], costRows.find((r) => r.model === stored.costRows[0].model));
});

test("runJudgeMatrix attributes an OpenAI judge leg's spend to the openai bucket even when the pool's generating arm is all-Anthropic", async () => {
  const store = makeTempStore("judge-provider-attr-");
  const anthropic = new MockJudgeProvider();
  const openai = new MockJudgeProvider();
  // Arm B (arms.config.json) is homogeneous Haiku — 100% Anthropic generators.
  // If provider attribution were ever derived from the GENERATING arm instead
  // of the judge model itself, the openai judge leg's spend would wrongly
  // land in (or be absent from) the anthropic bucket.
  const poolKey = "arm=B|brief=biz-01|rep=0|cfg=x";
  const pools = [poolEntry(poolKey, "B", "b idea 1", "b idea 2")];
  const { spendByProvider, hasMissingRate } = await runJudgeMatrix({
    pools,
    judgeModels: REGISTERED_JUDGE_MODELS,
    providers: { anthropic, openai },
    store,
    seed: 1,
    timestamp: "2026-08-02T00:00:00Z",
  });

  assert.equal(hasMissingRate, false, "the registered judge roster's preferred models all carry a RATE_TABLE row");
  assert.ok(spendByProvider.anthropic > 0, "the Anthropic judge leg contributes to the anthropic bucket");
  assert.ok(spendByProvider.openai > 0, "the OpenAI judge leg contributes to the openai bucket, driven by the JUDGE model, not the all-Anthropic generating arm");
});

test("runJudgeMatrix attributes a cross-provider generating arm (G) correctly — judge spend is independent of the arm's own provider mix", async () => {
  const store = makeTempStore("judge-arm-g-");
  const anthropic = new MockJudgeProvider();
  const openai = new MockJudgeProvider();
  const poolKey = "arm=G|brief=biz-01|rep=0|cfg=x";
  const pools = [poolEntry(poolKey, "G", "g idea 1", "g idea 2")];
  const { costRows, spendByProvider } = await runJudgeMatrix({
    pools,
    judgeModels: REGISTERED_JUDGE_MODELS,
    providers: { anthropic, openai },
    store,
    seed: 1,
    timestamp: "2026-08-02T00:00:00Z",
  });

  assert.equal(costRows.length, 2);
  assert.ok(spendByProvider.anthropic > 0 && spendByProvider.openai > 0, "both judge legs on the cross-provider arm G attribute correctly");
});

test("runJudgeMatrix surfaces a judge model with no RATE_TABLE row via hasMissingRate/missingRateModels — never silently prices it at $0", async () => {
  const store = makeTempStore("judge-missing-rate-");
  const anthropic = new MockJudgeProvider();
  const openai = new MockJudgeProvider();
  const poolKey = "arm=B|brief=biz-01|rep=0|cfg=x";
  const pools = [poolEntry(poolKey, "B", "b idea 1", "b idea 2")];
  // JUDGE_MODELS (this file's local fixture) uses gpt-5.4 for the OpenAI leg —
  // present in lib/price.mjs's OPENAI_PRICE_VERIFICATION record but NOT
  // promoted to a RATE_TABLE row.
  const { hasMissingRate, missingRateModels, spendByProvider } = await runJudgeMatrix({
    pools,
    judgeModels: JUDGE_MODELS,
    providers: { anthropic, openai },
    store,
    seed: 1,
    timestamp: "2026-08-02T00:00:00Z",
  });

  assert.equal(hasMissingRate, true);
  assert.ok(missingRateModels.includes("gpt-5.4"));
  // The rate-less model contributes NOTHING to openai's bucket (never a
  // silent $0-and-continue folded invisibly into a real total) — the key is
  // ABSENT entirely, not present-as-zero (priceRowByProvider `continue`s
  // before touching the bucket for a missing-rate model).
  assert.ok(!("openai" in spendByProvider), "a rate-less judge model contributes no bucket at all, not a zero-valued one");
});

test("runJudgeMatrix still meters (and returns a costRow for) a judge leg that FAILS after consuming tokens", async () => {
  const store = makeTempStore("judge-failed-meters-");
  const anthropic = new MockJudgeProvider({ failFor: new Map([["claude-sonnet-5", { failureKind: "parse_failure" }]]) });
  const openai = new MockJudgeProvider();
  const poolKey = "arm=B|brief=biz-01|rep=0|cfg=x";
  const pools = [poolEntry(poolKey, "B", "b idea 1", "b idea 2")];
  const { results, costRows } = await runJudgeMatrix({ pools, judgeModels: JUDGE_MODELS, providers: { anthropic, openai }, store, seed: 1, timestamp: "2026-08-02T00:00:00Z" });

  const failedLeg = results.find((r) => r.judge_model === "claude-sonnet-5");
  assert.equal(failedLeg.state, "failed");
  const failedRow = costRows.find((r) => r.model === "claude-sonnet-5");
  assert.ok(failedRow, "a failed judge call that consumed tokens still contributes a costRow — spend is real regardless of the outcome");
});

// ── F5 (review-round fix): the failure-path metering test above uses
// MockJudgeProvider for BOTH legs, and always fails the ANTHROPIC leg -- so
// a mutation that gates the meter-on-failure branch to skip the openai
// provider specifically (`row.judge_provider !== "openai" && resp.tokens...`)
// would stay green there. This test uses a REAL OpenAIJudgeProvider whose
// OPENAI leg fails after consuming real tokens, run through runJudgeMatrix,
// and pins that it still meters.

test("runJudgeMatrix meters a REAL OpenAIJudgeProvider leg that FAILS after consuming tokens -- metering is not provider-conditional (F5)", async () => {
  const store = makeTempStore("judge-openai-fail-meters-");
  const anthropic = new MockJudgeProvider();
  const fetchImpl = async (url, opts) => {
    const body = JSON.parse(opts.body);
    if (body.messages[0].content.includes("fail-me")) return jsonResponse(500, {});
    return jsonResponse(200, { choices: [{ message: { content: scoreJsonForIndex(0) } }], usage: { prompt_tokens: 20, completion_tokens: 10 } });
  };
  const openai = new OpenAIJudgeProvider({ apiKey: "k", fetchImpl, sleep: noopSleep, maxRetries: 0, logger: silentLogger });
  const poolKey = "arm=B|brief=biz-01|rep=0|cfg=x";
  const pools = [poolEntry(poolKey, "B", "succeeds fine", "fail-me please")];
  const { results, costRows } = await runJudgeMatrix({ pools, judgeModels: JUDGE_MODELS, providers: { anthropic, openai }, store, seed: 1, mode: "single", timestamp: "2026-08-02T00:00:00Z" });

  const openaiResult = results.find((r) => r.judge_provider === "openai");
  assert.equal(openaiResult.state, "failed");
  const openaiRow = costRows.find((r) => r.model === openaiResult.judge_model);
  assert.ok(openaiRow, "a failed OpenAI leg that consumed real tokens must still contribute a costRow -- metering must not be conditional on judge_provider");
  assert.ok(openaiRow.input_tokens > 0 || openaiRow.output_tokens > 0, "the costRow must carry the real tokens actually consumed before the leg failed");
  // The persisted store row must carry the same real spend.
  const stored = store.get(`judge-call|cell=${poolKey}|judge=${openaiResult.judge_model}|attempt=0`);
  assert.ok(stored, "a judge-call cost record must exist for the failed openai leg");
  assert.equal(stored.costRows[0].input_tokens, openaiRow.input_tokens);
});

// ── issue #77's specific trap: a REAL OpenAIJudgeProvider run through
//    runJudgeMatrix must persist FLAT token counts, never the generation
//    path's nested tokens_by_model shape. This is deliberately NOT
//    MockJudgeProvider — Mock always returns the flat shape regardless of
//    what OpenAIJudgeProvider itself does, so it cannot catch this defect.
//    Expected totals are computed from the KNOWN usage-per-candidate fixture
//    below, never from provider.calls[0].n (OpenAIJudgeProvider carries no
//    such call log at all — that would be reading the implementation's own
//    account of itself).

test("runJudgeMatrix + a REAL OpenAIJudgeProvider persists FLAT input_tokens/output_tokens on the store's cost row, and spendByProvider.openai is non-zero", async () => {
  const store = makeTempStore("judge-openai-real-");
  const USAGE_PER_CANDIDATE = { prompt_tokens: 100, completion_tokens: 50 };
  const N_CANDIDATES = 2;
  // Independently-derived expectation — NOT read from the provider's own call log.
  const EXPECTED_INPUT = USAGE_PER_CANDIDATE.prompt_tokens * N_CANDIDATES;
  const EXPECTED_OUTPUT = USAGE_PER_CANDIDATE.completion_tokens * N_CANDIDATES;

  const anthropic = new MockJudgeProvider();
  const openai = new OpenAIJudgeProvider({ apiKey: "k", fetchImpl: openaiJudgeBatchFetch({ usage: USAGE_PER_CANDIDATE }), sleep: noopSleep, logger: silentLogger });
  const poolKey = "arm=B|brief=biz-01|rep=0|cfg=x";
  const pools = [poolEntry(poolKey, "B", "b idea 1", "b idea 2")];
  const { results, costRows, spendByProvider } = await runJudgeMatrix({
    pools,
    judgeModels: REGISTERED_JUDGE_MODELS,
    providers: { anthropic, openai },
    store,
    seed: 1,
    timestamp: "2026-08-02T00:00:00Z",
  });

  const openaiResult = results.find((r) => r.judge_provider === "openai");
  assert.equal(openaiResult.state, "completed");

  // The PERSISTED store row — not the in-memory costRows return value — must
  // carry flat, non-zero token counts.
  const stored = store.get(`judge-call|cell=${poolKey}|judge=${openaiResult.judge_model}|attempt=0`);
  const storedRow = stored.costRows[0];
  assert.equal(storedRow.model, openaiResult.judge_model);
  assert.equal(storedRow.input_tokens, EXPECTED_INPUT, "persisted row must carry FLAT input_tokens, translated from OpenAI's prompt_tokens");
  assert.equal(storedRow.output_tokens, EXPECTED_OUTPUT, "persisted row must carry FLAT output_tokens, translated from OpenAI's completion_tokens");
  assert.ok(!("tokens_by_model" in storedRow), "a judge row must never carry the generation path's nested tokens_by_model shape");

  // The SAME row is what runJudgeMatrix returned (double-count guard).
  const returnedRow = costRows.find((r) => r.model === openaiResult.judge_model);
  assert.deepEqual(returnedRow, storedRow);

  assert.ok(spendByProvider.openai > 0, "spendByProvider.openai must be non-zero — a row carrying model+tokens_by_model-but-no-flat-counts would silently price to $0 here");
});

// ── AC: a pool judged by both providers produces two legs, ZERO deferrals,
//    for a fully-wired arm (narrowed scope: not the H5 model-fit itself,
//    which is out of scope for this issue — see the issue's own note) ──────

test("a cross-provider generating arm (G) judges cleanly on BOTH legs with REAL providers — zero deferrals, both legs metered", async () => {
  const store = makeTempStore("judge-arm-g-real-");
  const anthropic = new AnthropicJudgeProvider({ apiKey: "k", fetchImpl: judgeBatchFetch(), sleep: noopSleep, logger: silentLogger });
  const openai = new OpenAIJudgeProvider({ apiKey: "k", fetchImpl: openaiJudgeBatchFetch(), sleep: noopSleep, logger: silentLogger });
  const poolKey = "arm=G|brief=biz-01|rep=0|cfg=x";
  const pools = [poolEntry(poolKey, "G", "g idea 1", "g idea 2")];
  const { results, deferred, costRows, spendByProvider } = await runJudgeMatrix({
    pools,
    judgeModels: REGISTERED_JUDGE_MODELS,
    providers: { anthropic, openai },
    store,
    seed: 7,
    timestamp: "2026-08-02T00:00:00Z",
  });

  assert.equal(deferred.length, 0, "a fully-wired arm (both providers present) must produce zero deferrals");
  assert.equal(results.length, 2, "both the anthropic and openai legs were scheduled and executed");
  assert.ok(results.every((r) => r.state === "completed"), "both legs complete end to end against the real providers");
  assert.equal(costRows.length, 2, "both legs are metered — a cost row for each");
  assert.ok(spendByProvider.anthropic > 0 && spendByProvider.openai > 0, "both legs' spend is attributed to their own provider bucket");
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

// ── issue #106: a payment refusal on a JUDGE leg ──────────────────────────
//
// PART 1 — DETECTION. The issue was filed believing a judge leg already
// classified `payment_required` and merely failed to stop anything. It did
// not: both judge providers called classifyTransportOutcome WITHOUT the
// `errorBody` the fetch helpers return, and isBillingRefusal keys on the
// BODY (never on status alone — 400 and 429 are far too overloaded). So
// `paymentRequired` was unreachable on every judge leg, and #88's abort had
// nothing to fire on. Every test below is RED before this change: the
// anthropic ones classified `transport_error`, the openai ones
// `rate_limited` — both TRANSIENT, i.e. "re-run me", which is the worst
// possible answer to an unfunded account.
//
// Bodies are the ones evals/harness/provider.mjs's isBillingRefusal actually
// documents: the Anthropic one is capture-verified there; the OpenAI one is
// its documented `insufficient_quota` on a 429.

const ANTHROPIC_BILLING_BODY = {
  type: "error",
  error: {
    type: "invalid_request_error",
    message: "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.",
  },
};
const OPENAI_QUOTA_BODY = {
  error: {
    message: "You exceeded your current quota, please check your plan and billing details.",
    type: "insufficient_quota",
    code: "insufficient_quota",
  },
};

test("issue #106: an Anthropic judge leg (single) classifies a credit-balance refusal as payment_required, not transport_error", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return jsonResponse(400, ANTHROPIC_BILLING_BODY);
  };
  const provider = new AnthropicJudgeProvider({ apiKey: "k", fetchImpl, sleep: noopSleep, maxRetries: 3, logger: silentLogger });
  const resp = await provider.score({ briefText: BRIEF, candidates: poolOf("a") }, { judgeModel: "claude-sonnet-5", mode: "single", seed: 1 });
  assert.equal(resp.terminalState, "failed");
  assert.equal(resp.failureKind, "payment_required", "the judge provider must forward errorBody to the classifier -- without it this is an untyped transport_error");
  assert.equal(calls, 1, "a billing refusal is not retried -- burning the backoff ladder against an account that cannot pay is the futile retry #88 fixed");
});

test("issue #106: an Anthropic judge leg (batch) classifies a per-request credit refusal in the RESULT ROWS as payment_required", async () => {
  let submitted;
  const fetchImpl = async (url, opts) => {
    const u = String(url);
    if (u.endsWith("/v1/messages/batches")) {
      submitted = JSON.parse(opts.body);
      return jsonResponse(200, { id: "jb1", processing_status: "ended", results_url: "https://fake/jresults" });
    }
    if (u === "https://fake/jresults") {
      const lines = submitted.requests.map((r) => ({ custom_id: r.custom_id, result: { type: "errored", error: ANTHROPIC_BILLING_BODY.error } }));
      return textResponse(lines.map((l) => JSON.stringify(l)).join("\n"));
    }
    throw new Error(`unexpected URL ${u}`);
  };
  const provider = new AnthropicJudgeProvider({ apiKey: "k", fetchImpl, sleep: noopSleep, maxRetries: 0, logger: silentLogger });
  const resp = await provider.score({ briefText: BRIEF, candidates: poolOf("a", "b") }, { judgeModel: "claude-sonnet-5", mode: "batch", seed: 1 });
  assert.equal(resp.terminalState, "failed");
  assert.equal(resp.failureKind, "payment_required", "an errored batch ROW carrying a credit refusal is a payment failure, not an undifferentiated transport_error");
});

test("issue #106: an OpenAI judge leg (single) classifies a 429/insufficient_quota as payment_required, NOT rate_limited", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return jsonResponse(429, OPENAI_QUOTA_BODY);
  };
  const provider = new OpenAIJudgeProvider({ apiKey: "k", fetchImpl, sleep: noopSleep, maxRetries: 3, logger: silentLogger });
  const resp = await provider.score({ briefText: BRIEF, candidates: poolOf("a") }, { judgeModel: "gpt-5.6-terra", mode: "single", seed: 1 });
  assert.equal(resp.terminalState, "failed");
  assert.equal(
    resp.failureKind,
    "payment_required",
    "OpenAI delivers quota exhaustion as a 429 -- classifying it `rate_limited` (transient) is what marched every remaining pool into the same wall",
  );
  assert.equal(calls, 1, "not retried: the body says the account cannot pay, so the 429 retry ladder is futile");
});

test("issue #106: an OpenAI judge leg (batch) classifies an insufficient_quota OUTPUT ROW as payment_required, NOT rate_limited", async () => {
  let submitted = [];
  const fetchImpl = async (url, opts) => {
    const u = String(url);
    if (u === "https://api.openai.com/v1/files" && opts.method === "POST") {
      const text = await opts.body.get("file").text();
      submitted = text.split("\n").filter(Boolean).map((l) => JSON.parse(l));
      return jsonResponse(200, { id: "ofile_1" });
    }
    if (u === "https://api.openai.com/v1/batches") return jsonResponse(200, { id: "ob_1", status: "completed", output_file_id: "ofile_out" });
    if (u === "https://api.openai.com/v1/files/ofile_out/content") {
      const lines = submitted.map((l) => ({ custom_id: l.custom_id, response: { status_code: 429, body: OPENAI_QUOTA_BODY } }));
      return textResponse(lines.map((l) => JSON.stringify(l)).join("\n"));
    }
    throw new Error(`unexpected URL ${u}`);
  };
  const provider = new OpenAIJudgeProvider({ apiKey: "k", fetchImpl, sleep: noopSleep, maxRetries: 0, logger: silentLogger });
  const resp = await provider.score({ briefText: BRIEF, candidates: poolOf("a", "b") }, { judgeModel: "gpt-5.6-terra", mode: "batch", seed: 1 });
  assert.equal(resp.terminalState, "failed");
  assert.equal(resp.failureKind, "payment_required", "the 429 branch must not swallow a body that says insufficient_quota");
});

// PART 2 — THE ABORT. runSpec() calls runJudgeMatrix once per completed pool,
// so the loop below (one call per pool, the SAME provider instances
// throughout) is the shape a real run has. The whole point of the issue is
// what happens on calls 2..N.

const PAYMENT_FAIL_OPENAI = new Map(JUDGE_MODELS.openai.map((m) => [m, { failureKind: "payment_required" }]));

test("issue #106: after ONE judge-leg payment refusal, the refusing provider is never called again -- across pools, not just within one call", async () => {
  const store = makeTempStore("judge-payment-abort-");
  const anthropic = new MockJudgeProvider();
  const openai = new MockJudgeProvider({ failFor: PAYMENT_FAIL_OPENAI });
  const poolKeys = ["arm=B|brief=biz-01|rep=0|cfg=x", "arm=B|brief=biz-02|rep=0|cfg=x", "arm=B|brief=biz-03|rep=0|cfg=x"];
  const runs = [];
  for (const poolKey of poolKeys) {
    runs.push(
      await runJudgeMatrix({
        pools: [poolEntry(poolKey, "B", "b idea 1", "b idea 2")],
        judgeModels: JUDGE_MODELS,
        providers: { anthropic, openai },
        store,
        seed: 1,
        timestamp: "2026-08-02T00:00:00Z",
      }),
    );
  }

  // THE bug: without the abort this is 3 -- one pointless, correctly-classified
  // refusal per pool, a few hundred of them on the real ~200-cell grid.
  assert.equal(openai.calls.length, 1, "the openai judge is called for the FIRST pool only; every later leg is short-circuited before the call");
  assert.equal(anthropic.calls.length, 3, "a refusal on the OPENAI account must not stop ANTHROPIC judging -- two vendors, two balances");

  // Pool 1: an attempted leg that was refused.
  const first = runs[0].results.find((r) => r.judge_provider === "openai");
  assert.equal(first.state, "failed");
  assert.equal(first.failureKind, "payment_required");
  assert.equal(first.attempted, true, "the leg that SET the sticky flag really was called");
  assert.equal(runs[0].paymentSkipped.length, 0, "nothing was short-circuited yet on the first pool");

  // Pools 2-3: unattempted, but NOT silently absent -- one terminal record each.
  for (const run of runs.slice(1)) {
    assert.equal(run.results.length, 2, "both legs of the pool are still reported -- an unattempted leg that vanishes is the hole a reconciliation gate exists to catch");
    const skippedLeg = run.results.find((r) => r.judge_provider === "openai");
    assert.equal(skippedLeg.state, "failed");
    assert.equal(skippedLeg.failureKind, "payment_required", "one category for the whole abort, so a summary groups it as payment_required=N");
    assert.equal(skippedLeg.attempted, false, "self-describing: this leg was never called");
    assert.match(skippedLeg.detail, /^payment_required: /, "the reason carries the #88-style colon-prefix category");
    assert.match(skippedLeg.detail, /NOT attempted/);
    assert.equal(run.paymentSkipped.length, 1, "the short-circuited legs are also listed separately, for a caller that wants to record them as a skip");
    assert.equal(run.paymentSkipped[0].judge_provider, "openai");
    assert.equal(run.results.find((r) => r.judge_provider === "anthropic").state, "completed");
  }

  // The sticky record is per PROVIDER INSTANCE and names where it happened.
  const refusal = judgePaymentRefusal(openai);
  assert.ok(refusal, "the refusal is recorded against the openai provider instance");
  assert.equal(refusal.poolKey, poolKeys[0], "it names the pool where the account first refused");
  assert.equal(judgePaymentRefusal(anthropic), null, "the anthropic instance is untouched -- the abort is per provider, never global");
  assert.deepEqual(Object.keys(runs[2].paymentRefusals), ["openai"], "the return surfaces the abort so a caller can log it without re-deriving it");
});

test("issue #106: spend already incurred survives the abort, and a short-circuited leg spends (and stores) nothing", async () => {
  const store = makeTempStore("judge-payment-spend-");
  const anthropic = new MockJudgeProvider();
  const openai = new MockJudgeProvider({ failFor: PAYMENT_FAIL_OPENAI });
  const poolKeys = ["arm=B|brief=biz-01|rep=0|cfg=x", "arm=B|brief=biz-02|rep=0|cfg=x"];
  const runs = [];
  for (const poolKey of poolKeys) {
    runs.push(
      await runJudgeMatrix({
        pools: [poolEntry(poolKey, "B", "b idea 1", "b idea 2")],
        judgeModels: JUDGE_MODELS,
        providers: { anthropic, openai },
        store,
        seed: 1,
        timestamp: "2026-08-02T00:00:00Z",
      }),
    );
  }

  // The REFUSED call consumed tokens before being refused -- that is real
  // money and meterJudgeCall's attempt-scoped row must exist for it.
  const refusedLeg = runs[0].results.find((r) => r.judge_provider === "openai");
  const refusedRow = runs[0].costRows.find((r) => r.model === refusedLeg.judge_model);
  assert.ok(refusedRow, "a refused judge call that consumed tokens still contributes a costRow -- spend is real regardless of the outcome");
  assert.ok(store.get(`judge-call|cell=${poolKeys[0]}|judge=${refusedLeg.judge_model}|attempt=0`), "and it is durably stored");

  // The SHORT-CIRCUITED leg never called anything, so it must produce no cost
  // row and no store record -- a $0 row for a call that never happened would
  // be a fabricated datum, and a second row under the same key would trip
  // lib/store.mjs's byte-identical-or-throw guard.
  const skippedLeg = runs[1].results.find((r) => r.judge_provider === "openai");
  assert.equal(skippedLeg.attempted, false);
  assert.equal(
    runs[1].costRows.filter((r) => r.model === skippedLeg.judge_model).length,
    0,
    "a leg that was never called contributes no cost row -- not even a $0 one",
  );
  assert.ok(
    !store.keys().includes(`judge-call|cell=${poolKeys[1]}|judge=${skippedLeg.judge_model}|attempt=0`),
    "and nothing is written under its judge-call key",
  );
  // The anthropic leg of the SAME pool judged and metered normally.
  const anthropicLeg = runs[1].results.find((r) => r.judge_provider === "anthropic");
  assert.equal(anthropicLeg.state, "completed");
  assert.ok(runs[1].costRows.find((r) => r.model === anthropicLeg.judge_model), "the unaffected provider's spend is unaffected");
});

// The two abort tests above drive the refusing leg with MockJudgeProvider.
// This file's own F5 comment (above) records why that is not always enough:
// a defect conditional on the real provider stays green under the Mock. The
// sticky-set reads only `resp.failureKind`, so the risk is small — but the
// end-to-end path (real transport → real classification → abort) is the one
// an operator actually runs, so pin it once with a REAL OpenAIJudgeProvider.

test("issue #106: a REAL OpenAIJudgeProvider quota refusal sets the abort and short-circuits the next pool -- not just the Mock", async () => {
  const store = makeTempStore("judge-payment-real-");
  const anthropic = new MockJudgeProvider();
  let openaiHttpCalls = 0;
  const fetchImpl = async () => {
    openaiHttpCalls++;
    return jsonResponse(429, OPENAI_QUOTA_BODY);
  };
  const openai = new OpenAIJudgeProvider({ apiKey: "k", fetchImpl, sleep: noopSleep, maxRetries: 0, logger: silentLogger });
  const poolKeys = ["arm=B|brief=biz-01|rep=0|cfg=x", "arm=B|brief=biz-02|rep=0|cfg=x"];
  const runs = [];
  for (const poolKey of poolKeys) {
    runs.push(
      await runJudgeMatrix({
        pools: [poolEntry(poolKey, "B", "b idea 1")],
        judgeModels: JUDGE_MODELS,
        providers: { anthropic, openai },
        store,
        seed: 1,
        mode: "single",
        timestamp: "2026-08-02T00:00:00Z",
      }),
    );
  }

  assert.equal(runs[0].results.find((r) => r.judge_provider === "openai").failureKind, "payment_required");
  assert.equal(openaiHttpCalls, 1, "the second pool's openai leg makes NO HTTP request at all -- the abort happens before the transport");
  const second = runs[1].results.find((r) => r.judge_provider === "openai");
  assert.equal(second.failureKind, "payment_required");
  assert.equal(second.attempted, false);
  assert.equal(runs[1].results.find((r) => r.judge_provider === "anthropic").state, "completed", "the anthropic leg of the same pool still judged");
});
