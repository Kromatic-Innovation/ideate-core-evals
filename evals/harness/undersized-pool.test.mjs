// undersized-pool.test.mjs — issue #102: a partially-failed round must not
// store an undersized pool as a `completed` cell.
//
// #92 closed this for the poll-ceiling case (a pool missing a whole ROUND).
// This file covers the case it deliberately scoped out: a pool missing some of
// its AGENTS, whether they were lost to a 429 (the issue's motivating case) or
// to a refusal / an unparseable reply (the shape the issue asked to check and
// explicitly had not checked).
//
// Hermetic, like every other file under evals/harness/: no network, no timers
// that wait, no real ideate-core. `node --test` runs this with an EMPTY
// node_modules, so every seam is faked — the fake `ideateImpl`s below drive the
// providers' real `complete()` closure (barrier-batcher, diagnostics capture,
// token accounting) end-to-end without importing the engine.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  AnthropicBatchProvider,
  OpenAIBatchProvider,
  MockProvider,
  classifyUndersizedPool,
  realizedAgents,
} from "./provider.mjs";
import { runSpec } from "./runner.mjs";
import { ResultsStore } from "../../lib/store.mjs";
import { configHash, cellKey, planRun } from "../../lib/manifest.mjs";
import { isTransientFailure } from "../../lib/accounting.mjs";

const armsConfigJson = JSON.parse(
  await (await import("node:fs")).promises.readFile(new URL("../../arms.config.json", import.meta.url), "utf8"),
);

const CORPUS = [{ id: "brief-1", text: "Design a better bus stop." }];
const noopSleep = async () => {};
const silentLogger = () => {};
const silentLog = () => {};

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "ideate-undersized-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function armsConfigFor(...armIds) {
  const arms = {};
  for (const id of armIds) arms[id] = armsConfigJson.arms[id];
  return { panel: armsConfigJson.panel, arms };
}

function cellFor(armId, briefId = "brief-1") {
  return { key: `arm=${armId}|brief=${briefId}|rep=0|cfg=abc`, armId, briefId, replicate: 0, cfg: "abc" };
}

// ── Fake ideate-core ────────────────────────────────────────────────────────
//
// Drives `deps.complete` exactly as the real engine's round-1 loop does: fire
// every agent CONCURRENTLY via Promise.all, so the providers' barrier-batcher
// sees the whole round pushed within one microtask tick. ONE round only —
// nothing in this file's subject matter depends on round 2, and keeping it to
// one round keeps each fixture's expected counts readable.
//
// `countUnparseableAsAgentFailure` exists because this repo CANNOT verify which
// way the real ideate-core@0.4.0 answers that question (empty node_modules; the
// two pre-existing fake ideateImpls in this suite — anthropic-batch.test.mjs's
// and reply-recovery.test.mjs's — disagree with each other on exactly it). So
// the tests below pin BOTH answers, and the fix must hold under either.
function makeFakeIdeate({ countUnparseableAsAgentFailure = false } = {}) {
  return async function fakeIdeateImpl(input, deps) {
    const { complete, agents } = deps;
    const results = await Promise.all(
      agents.map((agent) =>
        complete({
          model: agent.model,
          prompt: deps.buildRound1Prompt({ context: input.context, persona: agent.persona, ideasPerAgent: agent.ideasPerAgent }),
          temperature: 0.7,
          persona: agent.persona,
        }),
      ),
    );
    const candidates = [];
    let agentsFailed = 0;
    results.forEach((res, i) => {
      if (!res || res.ok !== true) {
        // The request itself never produced a usable reply — a 429, a 5xx, a
        // surrendered batch. Every fake ideateImpl in this repo agrees this is
        // an agent failure, and so does the real engine's `onAgentError`.
        agentsFailed++;
        return;
      }
      let raw;
      try {
        raw = JSON.parse(res.text);
      } catch {
        if (countUnparseableAsAgentFailure) agentsFailed++;
        return;
      }
      if (!Array.isArray(raw)) return;
      for (const c of raw) {
        const text = c && typeof c.text === "string" ? c.text.trim() : "";
        if (!text) continue;
        candidates.push({ id: `${agents[i].id}-${candidates.length}`, text, agentId: agents[i].id, model: agents[i].model, round: 1 });
      }
    });
    return { candidates, agents, meta: { agentsAttempted: agents.length, agentsFailed } };
  };
}

// ── Anthropic fake transport ────────────────────────────────────────────────

function jsonResponse(status, obj) {
  return { ok: status >= 200 && status < 300, status, json: async () => obj, text: async () => JSON.stringify(obj) };
}
function textResponse(text, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => text, json: async () => JSON.parse(text) };
}

const OK_IDEAS = JSON.stringify([{ text: "a heated shelter" }, { text: "a live arrivals board" }]);

/**
 * An Anthropic batch fetch whose per-request outcome is chosen by index, so a
 * test can say "requests 0,1,2 are rate-limited and 3,4 succeed" — which is
 * exactly the partially-rate-limited round the issue describes, at the only
 * layer where the API actually expresses it (a per-row `errored` entry in the
 * batch results JSONL).
 *
 * `outcomeFor(i)` returns either `{ ok: text }` or `{ errored: {type, message} }`.
 */
function anthropicBatchFetchByIndex(outcomeFor) {
  let submitted;
  return async (url, opts) => {
    const u = String(url);
    if (u.endsWith("/v1/messages/batches")) {
      submitted = JSON.parse(opts.body);
      return jsonResponse(200, { id: "batch_1", processing_status: "ended", results_url: "https://fake/results" });
    }
    if (u === "https://fake/results") {
      const lines = submitted.requests.map((r, i) => {
        const outcome = outcomeFor(i);
        if (outcome.errored) return { custom_id: r.custom_id, result: { type: "errored", error: outcome.errored } };
        return {
          custom_id: r.custom_id,
          result: {
            type: "succeeded",
            message: {
              content: [{ type: "text", text: outcome.ok }],
              stop_reason: outcome.stopReason || "end_turn",
              usage: { input_tokens: 100, output_tokens: 50 },
            },
          },
        };
      });
      return textResponse(lines.map((l) => JSON.stringify(l)).join("\n"));
    }
    if (u.includes("/v1/messages/batches/")) {
      return jsonResponse(200, { id: "batch_1", processing_status: "ended", results_url: "https://fake/results" });
    }
    throw new Error(`anthropicBatchFetchByIndex: unexpected URL ${u}`);
  };
}

function anthropicProvider(fetchImpl, { armId = "C", ideate } = {}) {
  return new AnthropicBatchProvider({
    apiKey: "test-key",
    corpus: CORPUS,
    armsConfig: armsConfigFor(armId),
    fetchImpl,
    ideateImpl: ideate || makeFakeIdeate(),
    sleep: noopSleep,
    logger: silentLogger,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. The motivating case: a partially RATE-LIMITED round
// ─────────────────────────────────────────────────────────────────────────────

test("issue #102: 3 of 5 panel agents 429 and 2 return -- the cell FAILS rate_limited instead of storing an undersized pool", async () => {
  // Arm C: a real 5-slot homogeneous panel from arms.config.json.
  const provider = anthropicProvider(
    anthropicBatchFetchByIndex((i) => (i < 3 ? { errored: { type: "rate_limit_error", message: "rate limited" } } : { ok: OK_IDEAS })),
  );

  const resp = await provider.generate(cellFor("C"), armsConfigJson.arms.C, { mode: "batch", timestamp: new Date().toISOString() });

  // THE assertion this issue exists for. Pre-fix, this was `completed` with a
  // pool of 4 candidates built from 2 of 5 agents.
  assert.equal(resp.terminalState, "failed");
  // The transport signal wins over the reply-derived fallback, via
  // pickFailureKind -- so the ledger says "rate limits", which is the operator
  // action (#90 re-plans it; re-run the same command).
  assert.equal(resp.failureKind, "rate_limited");
  assert.ok(isTransientFailure(resp.failureKind), "a rate-limited shortfall must be TRANSIENT so #90 re-plans the cell");

  // The realized-agent counts are on the record (AC2), greppable, in the same
  // `key=value` shape classifyPoolFailure already uses.
  assert.match(resp.detail, /agents_attempted=5/);
  assert.match(resp.detail, /agents_failed=3/);
  assert.match(resp.detail, /agents_realized=2/);
  // And it says what was thrown away, so the loss is legible rather than implied.
  assert.match(resp.detail, /discarded_candidates=4/);
  assert.match(resp.detail, /UNDERSIZED/);

  // Money is still reported (the 2 successful agents really did spend) -- this
  // is what keeps #90's attempt record able to carry it.
  assert.equal(resp.tokens.tokens_by_model["claude-sonnet-5"].input_tokens, 200);
  assert.equal(resp.tokens.tokens_by_model["claude-sonnet-5"].output_tokens, 100);
  // meta is carried on the FAILED response too, so the runner can retain the
  // counts on whatever it stores.
  assert.deepEqual(resp.meta, { agentsAttempted: 5, agentsFailed: 3 });
});

test("issue #102: a FULL-SIZE panel round still completes -- the guard is not a blanket failure", async () => {
  const provider = anthropicProvider(anthropicBatchFetchByIndex(() => ({ ok: OK_IDEAS })));
  const resp = await provider.generate(cellFor("C"), armsConfigJson.arms.C, { mode: "batch", timestamp: new Date().toISOString() });

  assert.equal(resp.terminalState, "completed");
  assert.equal(resp.result.candidates.length, 10); // 5 agents x 2 ideas
  assert.deepEqual(resp.result.meta, { agentsAttempted: 5, agentsFailed: 0 });
});

test("issue #102: a partially rate-limited SOLO cell (arm A) is unaffected -- one agent means the pool is empty, not short", async () => {
  // The solo arm cannot produce a PARTIAL pool: its one agent either returns or
  // it does not. This pins that the new guard does not change arm A's
  // classification, which matters because arm A is H1's comparison baseline.
  const provider = anthropicProvider(
    anthropicBatchFetchByIndex(() => ({ errored: { type: "rate_limit_error", message: "rate limited" } })),
    { armId: "A" },
  );
  const resp = await provider.generate(cellFor("A"), armsConfigJson.arms.A, { mode: "batch", timestamp: new Date().toISOString() });

  assert.equal(resp.terminalState, "failed");
  assert.equal(resp.failureKind, "rate_limited");
  // Routed through the EMPTY-pool branch (classifyPoolFailure), not the
  // undersized one -- the detail vocabulary proves which branch answered.
  assert.match(resp.detail, /empty candidate pool/);
  assert.doesNotMatch(resp.detail, /UNDERSIZED/);
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. The AC the issue author explicitly did not check: partial `refusal`
//    and partial `parse_failure`
// ─────────────────────────────────────────────────────────────────────────────

test("issue #102 AC5: partial REFUSAL has the same shape -- 2 of 5 agents refuse, the cell fails `refusal` rather than completing", async () => {
  // A refusal reply comes back with stop_reason "refusal" and no usable
  // candidates. Note `countUnparseableAsAgentFailure: false`: the engine does
  // NOT count these agents as failed, so `meta.agentsFailed === 0`. A fix that
  // tested only `meta.agentsFailed > 0` would MISS this case entirely -- which
  // is why the reply-level channel exists.
  const provider = anthropicProvider(
    anthropicBatchFetchByIndex((i) => (i < 2 ? { ok: "I can't help with that.", stopReason: "refusal" } : { ok: OK_IDEAS })),
    { ideate: makeFakeIdeate({ countUnparseableAsAgentFailure: false }) },
  );
  const resp = await provider.generate(cellFor("C"), armsConfigJson.arms.C, { mode: "batch", timestamp: new Date().toISOString() });

  assert.equal(resp.terminalState, "failed");
  assert.equal(resp.failureKind, "refusal");
  assert.match(resp.detail, /cause=partial_refusal/);
  assert.match(resp.detail, /non_contributing_replies=2/);
  // The engine reported no agent failures at all -- the shortfall was found in
  // the replies. This assertion is the whole point of the second channel.
  assert.match(resp.detail, /agents_failed=0/);
  assert.match(resp.detail, /discarded_candidates=6/); // 3 surviving agents x 2 ideas
});

test("issue #102 AC5: partial PARSE_FAILURE has the same shape -- 2 of 5 replies are unparseable, the cell fails `parse_failure`", async () => {
  const provider = anthropicProvider(
    anthropicBatchFetchByIndex((i) => (i < 2 ? { ok: "Sure! Here are some ideas: 1) a bench 2) a roof" } : { ok: OK_IDEAS })),
    { ideate: makeFakeIdeate({ countUnparseableAsAgentFailure: false }) },
  );
  const resp = await provider.generate(cellFor("C"), armsConfigJson.arms.C, { mode: "batch", timestamp: new Date().toISOString() });

  assert.equal(resp.terminalState, "failed");
  assert.equal(resp.failureKind, "parse_failure");
  assert.match(resp.detail, /cause=partial_unparseable_complete/);
  assert.match(resp.detail, /non_contributing_replies=2/);
});

test("issue #102 AC5: partial parse_failure is caught under EITHER ideate-core agent-counting semantics", async () => {
  // Same fixture as above, but with the engine counting an unparseable reply as
  // an agent failure (reply-recovery.test.mjs's reading of ideate-core). The
  // classification must not depend on which reading is right, because this repo
  // cannot verify it -- see makeFakeIdeate's own comment.
  const provider = anthropicProvider(
    anthropicBatchFetchByIndex((i) => (i < 2 ? { ok: "Sure! Here are some ideas: 1) a bench 2) a roof" } : { ok: OK_IDEAS })),
    { ideate: makeFakeIdeate({ countUnparseableAsAgentFailure: true }) },
  );
  const resp = await provider.generate(cellFor("C"), armsConfigJson.arms.C, { mode: "batch", timestamp: new Date().toISOString() });

  assert.equal(resp.terminalState, "failed");
  assert.equal(resp.failureKind, "parse_failure");
  assert.match(resp.detail, /agents_failed=2/);
});

test("issue #102: a TRUNCATED reply that #93's salvage rescued does NOT fail the cell -- the idea-count axis stays out of scope", async () => {
  // The boundary this fix deliberately does not cross. A reply cut off by
  // max_tokens from which salvage recovered its complete objects is an agent
  // that CONTRIBUTED, just fewer ideas than asked. #93 registered that trade on
  // purpose; failing the cell here would silently re-litigate it.
  const salvageable = '[{"text":"a heated shelter"},{"text":"a live arrivals board"},{"text":"a cut-off idea';
  const provider = anthropicProvider(
    anthropicBatchFetchByIndex((i) => (i === 0 ? { ok: salvageable, stopReason: "max_tokens" } : { ok: OK_IDEAS })),
  );
  const resp = await provider.generate(cellFor("C"), armsConfigJson.arms.C, { mode: "batch", timestamp: new Date().toISOString() });

  assert.equal(resp.terminalState, "completed");
  assert.equal(resp.result.meta.agentsFailed, 0);
  assert.equal(resp.result.candidates.length, 10); // salvage kept the 2 complete objects
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. The OpenAI path gets the same rule (arm H, and arm G's OpenAI slots)
// ─────────────────────────────────────────────────────────────────────────────

/** An OpenAI batch fetch: file upload -> batch create -> poll -> results JSONL. */
function openaiBatchFetchByIndex(outcomeFor) {
  let submittedLines = [];
  return async (url, opts) => {
    const u = String(url);
    if (u.endsWith("/v1/files")) {
      // The JSONL body arrives as multipart form-data; recover the lines from it.
      const body = opts.body;
      const text = typeof body === "string" ? body : await new Response(body).text();
      submittedLines = text
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.startsWith("{") && l.includes("custom_id"))
        .map((l) => JSON.parse(l));
      return jsonResponse(200, { id: "file_1" });
    }
    if (u.endsWith("/v1/batches")) {
      return jsonResponse(200, { id: "batch_1", status: "completed", output_file_id: "outfile_1" });
    }
    if (u.includes("/v1/batches/")) {
      return jsonResponse(200, { id: "batch_1", status: "completed", output_file_id: "outfile_1" });
    }
    if (u.includes("/v1/files/outfile_1/content")) {
      const lines = submittedLines.map((r, i) => {
        const outcome = outcomeFor(i);
        if (outcome.errored) {
          return { custom_id: r.custom_id, error: outcome.errored, response: { status_code: 429, body: { error: outcome.errored } } };
        }
        return {
          custom_id: r.custom_id,
          response: {
            status_code: 200,
            body: {
              choices: [{ message: { content: outcome.ok }, finish_reason: outcome.finishReason || "stop" }],
              usage: { prompt_tokens: 100, completion_tokens: 50 },
            },
          },
        };
      });
      return textResponse(lines.map((l) => JSON.stringify(l)).join("\n"));
    }
    throw new Error(`openaiBatchFetchByIndex: unexpected URL ${u}`);
  };
}

test("issue #102: the OpenAI path (arm H) gets the identical rule -- a partial round fails rather than completing short", async () => {
  const provider = new OpenAIBatchProvider({
    apiKey: "test-key",
    corpus: CORPUS,
    armsConfig: armsConfigFor("H"),
    fetchImpl: openaiBatchFetchByIndex((i) =>
      i < 3 ? { errored: { type: "rate_limit_exceeded", message: "rate limited" } } : { ok: OK_IDEAS },
    ),
    ideateImpl: makeFakeIdeate(),
    sleep: noopSleep,
    logger: silentLogger,
  });

  const resp = await provider.generate(cellFor("H"), armsConfigJson.arms.H, { mode: "batch", timestamp: new Date().toISOString() });
  assert.equal(resp.terminalState, "failed");
  assert.match(resp.detail, /UNDERSIZED/);
  assert.match(resp.detail, /agents_failed=3/);
  assert.ok(isTransientFailure(resp.failureKind), `expected a transient kind, got ${resp.failureKind}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. The classifier and the meta reader, directly
// ─────────────────────────────────────────────────────────────────────────────

test("classifyUndersizedPool: returns null for a healthy pool -- it is a detector, not a formatter", () => {
  const healthy = { meta: { agentsAttempted: 5, agentsFailed: 0 } };
  const diagnostics = [{ truncated: false, parse: "ok", stopReason: "end_turn", candidateCount: 6 }];
  assert.equal(classifyUndersizedPool(healthy, diagnostics, { candidateCount: 30 }), null);
});

test("classifyUndersizedPool: a legitimately EMPTY but well-formed reply is the arm's answer, not a shortfall", () => {
  // `classifyPoolFailure`'s `genuinely_empty` case, at the reply level: an agent
  // that returned a valid `[]` really did answer. Counting it as a dropout would
  // convert one of the behaviours the study exists to MEASURE into a failed cell.
  const result = { meta: { agentsAttempted: 5, agentsFailed: 0 } };
  const diagnostics = [
    { truncated: false, parse: "ok", stopReason: "end_turn", candidateCount: 0 },
    { truncated: false, parse: "ok", stopReason: "end_turn", candidateCount: 6 },
  ];
  assert.equal(classifyUndersizedPool(result, diagnostics, { candidateCount: 6 }), null);
});

test("classifyUndersizedPool: an unexplained shortfall is harness_error (transient), never an intrinsic claim about the arm", () => {
  // Agents failed, but nothing in the replies says why and no transport signal
  // was raised. Asserting `refusal` here would record a property of the arm on
  // the strength of no evidence; `harness_error` is transient, so the cell is
  // re-planned instead.
  const result = { meta: { agentsAttempted: 5, agentsFailed: 2 } };
  const diagnostics = [{ truncated: false, parse: "ok", stopReason: "end_turn", candidateCount: 6 }];
  const out = classifyUndersizedPool(result, diagnostics, { candidateCount: 18 });
  assert.equal(out.kind, "harness_error");
  assert.equal(out.cause, "partial_unexplained");
  assert.ok(isTransientFailure(out.kind));
});

test("realizedAgents: an unreported or malformed meta is `null` -- 'cannot verify', never 'nothing failed'", () => {
  assert.equal(realizedAgents(undefined), null);
  assert.equal(realizedAgents({}), null);
  assert.equal(realizedAgents({ meta: {} }), null);
  assert.equal(realizedAgents({ meta: { agentsAttempted: 5 } }), null);
  assert.equal(realizedAgents({ meta: { agentsAttempted: 5, agentsFailed: 6 } }), null, "failed > attempted is nonsense, not a shortfall of -1");
  assert.equal(realizedAgents({ meta: { agentsAttempted: 5, agentsFailed: "2" } }), null);
  assert.deepEqual(realizedAgents({ meta: { agentsAttempted: 5, agentsFailed: 2 } }), { attempted: 5, failed: 2, realized: 3 });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. The runner backstop, and what reaches the STORE
// ─────────────────────────────────────────────────────────────────────────────

const CFG = { harnessVersion: "0.0.1", engineSha: "test-sha", promptHash: "test-prompt", corpusHash: "test-corpus" };
const CFG_HASH = configHash(CFG);
const RUNNER_ARMS = {
  arms: {
    P: {
      mode: "panel",
      slots: [
        { persona: "proposer_1", model: "claude-haiku-4-5" },
        { persona: "proposer_2", model: "claude-haiku-4-5" },
      ],
    },
  },
};
const RUNNER_SPEC = { arms: [{ id: "P" }], briefs: [{ id: "b1" }], replicates: 1, config: CFG };

test("issue #102: the runner BACKSTOP refuses a completed response whose pool is short, and keeps the cell retryable", async (t) => {
  const store = new ResultsStore(tempDir(t));
  const key = cellKey({ armId: "P", briefId: "b1", replicate: 0, cfg: CFG_HASH });
  // A provider that does NOT self-police -- the case this backstop exists for.
  const overrides = new Map([
    [
      key,
      {
        terminalState: "completed",
        result: { candidates: ["one idea"], latencyMs: 1, meta: { agentsAttempted: 2, agentsFailed: 1 } },
      },
    ],
  ]);
  const provider = new MockProvider({ overrides });

  const { summary } = await runSpec(RUNNER_SPEC, { store, armsConfig: RUNNER_ARMS, provider, log: silentLog });

  assert.equal(summary.completed, 0);
  assert.equal(summary.failed, 1);
  assert.equal(summary.byKind.harness_error, 1);

  // Nothing under cell.key -- so planRun re-plans it. This is the property that
  // makes "fail the cell" affordable: the loss is a delay, not a hole.
  assert.equal(store.has(key), false);
  assert.equal(planRun(RUNNER_SPEC, store.keys()).todo.length, 1);

  // ...and the money the generation call really spent is durable under an
  // attempt-scoped key (#90's mechanism, reused rather than reinvented).
  const attemptKeys = store.keys().filter((k) => k.startsWith(`generation-attempt|cell=${key}|`));
  assert.equal(attemptKeys.length, 1);
  const attempt = store.get(attemptKeys[0]);
  assert.equal(attempt.accounting.kind, "harness_error");
  assert.ok(attempt.costRows.length > 0, "the generation tokens must survive the discarded cell");
  assert.match(attempt.accounting.detail, /agents_attempted=2 agents_failed=1 agents_realized=1/);
});

test("issue #102 AC2: a completed cell RETAINS its realized agent count on the stored record", async (t) => {
  const store = new ResultsStore(tempDir(t));
  const key = cellKey({ armId: "P", briefId: "b1", replicate: 0, cfg: CFG_HASH });
  const overrides = new Map([
    [key, { terminalState: "completed", result: { candidates: ["a", "b"], latencyMs: 1, meta: { agentsAttempted: 2, agentsFailed: 0 } } }],
  ]);

  await runSpec(RUNNER_SPEC, { store, armsConfig: RUNNER_ARMS, provider: new MockProvider({ overrides }), log: silentLog });

  const stored = store.get(key);
  assert.equal(stored.accounting.state, "completed");
  assert.equal(stored.result.agentsAttempted, 2);
  assert.equal(stored.result.agentsFailed, 0);
  assert.equal(stored.result.agentsRealized, 2);
});

test("issue #102 AC2: a stored INTRINSIC failure retains the counts too -- 'all five refused' must be legible from 'two of five did'", async (t) => {
  const store = new ResultsStore(tempDir(t));
  const key = cellKey({ armId: "P", briefId: "b1", replicate: 0, cfg: CFG_HASH });
  const overrides = new Map([
    [
      key,
      {
        terminalState: "failed",
        failureKind: "refusal",
        detail: "partial refusal",
        result: undefined,
        meta: { agentsAttempted: 2, agentsFailed: 1 },
      },
    ],
  ]);

  await runSpec(RUNNER_SPEC, { store, armsConfig: RUNNER_ARMS, provider: new MockProvider({ overrides }), log: silentLog });

  // `refusal` is INTRINSIC, so unlike the transient cases it IS stored under
  // cell.key -- it is a real observation about the arm.
  const stored = store.get(key);
  assert.equal(stored.accounting.state, "failed");
  assert.equal(stored.accounting.kind, "refusal");
  assert.equal(stored.result.agentsAttempted, 2);
  assert.equal(stored.result.agentsFailed, 1);
  assert.equal(stored.result.agentsRealized, 1);
});

test("issue #102: a provider that reports no counts at all is passed through -- 'cannot verify' is stated, not faked", async (t) => {
  // MockProvider's default completion carries no `meta`. The backstop cannot
  // check such a provider, and must not invent an answer in either direction:
  // the cell completes, and the record simply carries no agent-count fields.
  const store = new ResultsStore(tempDir(t));
  const key = cellKey({ armId: "P", briefId: "b1", replicate: 0, cfg: CFG_HASH });

  const { summary } = await runSpec(RUNNER_SPEC, { store, armsConfig: RUNNER_ARMS, provider: new MockProvider(), log: silentLog });

  assert.equal(summary.completed, 1);
  const stored = store.get(key);
  assert.equal("agentsRealized" in stored.result, false, "absence of the field IS the 'unverified' signal");
});
