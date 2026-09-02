// batch-resume.test.mjs — hermetic tests for issue #103: re-poll an in-flight
// batch instead of re-submitting and paying twice.
//
// Same hermetic invariant as every other file in this directory: no network,
// no real ideate-core, no timer that actually waits. Every seam is injected.
//
// ── What these tests are actually pinning ───────────────────────────────────
// The expensive failure is not "resume doesn't work". It is "resume half
// works, and is trusted". So the assertions are deliberately about what did
// NOT happen on the second invocation -- how many batches were submitted, how
// many requests were in them, and what the ledger totals to -- rather than
// only about the cell coming back completed. A resume that quietly re-submits
// still produces a completed cell.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  AnthropicBatchProvider,
  OpenAIBatchProvider,
  contentCustomId,
  batchResultsExpired,
  normalizeResumeState,
  buildAnthropicMessageParams,
  ANTHROPIC_RESULTS_RETENTION_DAYS,
  OPENAI_RESULTS_RETENTION_DAYS,
} from "./provider.mjs";
import { runSpec, spendToDate, planPrune, ATTEMPT_FAMILIES } from "./runner.mjs";
import {
  ResultsStore,
  BATCH_RESUME_FAMILY,
  ATTEMPT_KEY_FAMILIES,
  parseAttemptKey,
  readBatchResumeRecord,
  writeBatchResumeRecord,
} from "../../lib/store.mjs";

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

function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), "resume-store-"));
  return { store: new ResultsStore(dir), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function jsonResponse(status, obj) {
  return { ok: status >= 200 && status < 300, status, json: async () => obj, text: async () => JSON.stringify(obj) };
}
function textResponse(text, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => text, json: async () => JSON.parse(text) };
}

/** Ideas text an agent "returns" -- a JSON array of {text}, per the prompt contract. */
function ideasJson(tag, n = 6) {
  return JSON.stringify(Array.from({ length: n }, (_, i) => ({ text: `${tag} idea ${i}` })));
}

/** A `succeeded` Anthropic batch result row. */
function anthropicSucceeded(customId, text, usage = { input_tokens: 100, output_tokens: 50 }) {
  return JSON.stringify({ custom_id: customId, result: { type: "succeeded", message: { content: [{ type: "text", text }], stop_reason: "end_turn", usage } } });
}
/** A `canceled` row -- what cancel-on-abandon produces for a request the model
 *  never saw. Documented as NOT billed. */
function anthropicCanceled(customId) {
  return JSON.stringify({ custom_id: customId, result: { type: "canceled" } });
}

/**
 * A single-round fake ideate-core. Mirrors the real engine's calling
 * convention closely enough to exercise the barrier-batcher: every agent's
 * `complete()` is fired inside ONE `Promise.all`, so they all land in the same
 * flush.
 */
async function soloRoundIdeate(input, deps) {
  const { complete, agents } = deps;
  const results = await Promise.all(
    agents.map((agent) =>
      complete({
        model: agent.model,
        prompt: deps.buildRound1Prompt({ context: input.context, persona: agent.persona, ideasPerAgent: agent.ideasPerAgent }),
        maxTokens: 2048,
        persona: agent.persona,
      }),
    ),
  );
  return collect(results, agents, 1);
}

/**
 * A TWO-round fake ideate-core, and the shape that matters most for #103.
 * Round 2's prompt is built from round 1's candidate texts in AGENT order --
 * which is exactly the determinism property provider.mjs's BATCH RESUME
 * section documents about ideate-core@0.4.0, and the thing that makes a
 * content-derived custom_id reproduce across a re-issue.
 */
async function twoRoundIdeate(input, deps) {
  const { complete, agents } = deps;
  const r1 = await Promise.all(
    agents.map((agent) =>
      complete({
        model: agent.model,
        prompt: deps.buildRound1Prompt({ context: input.context, persona: agent.persona, ideasPerAgent: agent.ideasPerAgent }),
        maxTokens: 2048,
        persona: agent.persona,
      }),
    ),
  );
  const round1 = collect(r1, agents, 1);
  if (!round1.candidates.length) return round1;

  const seeds = round1.candidates;
  const r2 = await Promise.all(
    agents.map((agent) =>
      complete({
        model: agent.model,
        prompt: deps.buildRound2Prompt({ context: input.context, persona: agent.persona, seeds, ideasPerAgent: agent.ideasPerAgent }),
        maxTokens: 2048,
        persona: agent.persona,
      }),
    ),
  );
  const round2 = collect(r2, agents, 2);
  return {
    candidates: [...round1.candidates, ...round2.candidates],
    agents,
    meta: { agentsAttempted: agents.length, agentsFailed: round2.meta.agentsFailed },
  };
}

function collect(results, agents, round) {
  const candidates = [];
  let agentsFailed = 0;
  results.forEach((res, i) => {
    if (!res || res.ok !== true) {
      agentsFailed += 1;
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
        candidates.push({ id: `r${round}-${agents[i].id}-${candidates.length}`, text: c.text, agentId: agents[i].id, model: agents[i].model, persona: agents[i].persona, round, origin: "generated" });
      }
    }
  });
  return { candidates, agents, meta: { agentsAttempted: agents.length, agentsFailed } };
}

// ═══════════════════════════════════════════════════════════════════════════
// AC1 — custom_ids are content-derived and stable across re-issue
// ═══════════════════════════════════════════════════════════════════════════

test("#103 AC1: contentCustomId is a pure function of the request params -- the same request re-issued derives the same id", () => {
  const params = buildAnthropicMessageParams({ model: "claude-haiku-4-5", prompt: "hello", maxTokens: 2048 });
  const first = contentCustomId(params, new Map());
  const second = contentCustomId(params, new Map());
  assert.equal(first, second, "a re-issued request must derive its own prior id, or nothing can be matched back to it");

  // Property order must not matter: the same request built with its keys in a
  // different order is the SAME request.
  const reordered = { messages: params.messages, max_tokens: params.max_tokens, model: params.model };
  assert.equal(contentCustomId(reordered, new Map()), first);
});

test("#103 AC1: a different request derives a different id (prompt, model and max_tokens all participate)", () => {
  const base = buildAnthropicMessageParams({ model: "claude-haiku-4-5", prompt: "hello", maxTokens: 2048 });
  const id = contentCustomId(base, new Map());
  for (const variant of [
    { model: "claude-sonnet-5", prompt: "hello", maxTokens: 2048 },
    { model: "claude-haiku-4-5", prompt: "hello there", maxTokens: 2048 },
    { model: "claude-haiku-4-5", prompt: "hello", maxTokens: 4650 },
  ]) {
    assert.notEqual(contentCustomId(buildAnthropicMessageParams(variant), new Map()), id);
  }
});

test("#103 AC1: the id satisfies Anthropic's documented custom_id constraint ^[a-zA-Z0-9_-]{1,64}$", () => {
  const counts = new Map();
  const params = buildAnthropicMessageParams({ model: "claude-opus-5", prompt: "x".repeat(50000), maxTokens: 4650 });
  for (let i = 0; i < 3; i += 1) {
    const id = contentCustomId(params, counts);
    assert.match(id, /^[a-zA-Z0-9_-]{1,64}$/);
    assert.ok(id.length <= 64);
  }
});

test("#103 AC1: two identical requests in one cell get distinct ids, assigned deterministically by call order", () => {
  const params = buildAnthropicMessageParams({ model: "claude-haiku-4-5", prompt: "same", maxTokens: 2048 });
  const runOnce = () => {
    const counts = new Map();
    return [contentCustomId(params, counts), contentCustomId(params, counts)];
  };
  const [a0, a1] = runOnce();
  assert.notEqual(a0, a1, "duplicate ids in one batch would be rejected by the API");
  // Deterministic across re-issue -- which is the whole point. A per-BATCH
  // counter would renumber these on a resume where the first was served from
  // cache; the counter is per-cell precisely so it does not.
  assert.deepEqual(runOnce(), [a0, a1]);
});

// ═══════════════════════════════════════════════════════════════════════════
// AC2 — the handle and enough context to match results back are persisted
// ═══════════════════════════════════════════════════════════════════════════

test("#103 AC2: a resume record uses the established attempt-key grammar and is numbered max+1, never by a count", () => {
  const { store, cleanup } = tempStore();
  try {
    const cellKey = "arm=A|brief=brief-1|rep=0|cfg=abc";
    writeBatchResumeRecord(store, { cellKey, cfg: "abc", replies: { rX: { model: "m", text: "t" } }, pricingLever: "batch" });
    writeBatchResumeRecord(store, { cellKey, cfg: "abc", replies: { rY: { model: "m", text: "t" } }, pricingLever: "batch" });

    const keys = store.keys().filter((k) => k.startsWith(BATCH_RESUME_FAMILY));
    assert.deepEqual(keys.sort(), [
      `${BATCH_RESUME_FAMILY}|cell=${cellKey}|attempt=0`,
      `${BATCH_RESUME_FAMILY}|cell=${cellKey}|attempt=1`,
    ]);

    const parsed = parseAttemptKey(keys[0]);
    assert.equal(parsed.family, BATCH_RESUME_FAMILY);
    assert.equal(parsed.cellKey, cellKey);

    // Highest attempt wins -- supersession in an append-only store.
    assert.deepEqual(Object.keys(readBatchResumeRecord(store, cellKey).replies), ["rY"]);
  } finally {
    cleanup();
  }
});

test("#103 AC2/AC4: a resume record NEVER carries money -- the invariant that makes it safe to drop", () => {
  const { store, cleanup } = tempStore();
  try {
    const cellKey = "arm=A|brief=brief-1|rep=0|cfg=abc";
    writeBatchResumeRecord(store, {
      cellKey,
      cfg: "abc",
      replies: { rX: { model: "claude-haiku-4-5", text: "t", usage: { input_tokens: 999999, output_tokens: 999999 } } },
      pricingLever: "batch",
    });
    const key = store.keys().find((k) => k.startsWith(BATCH_RESUME_FAMILY));
    assert.deepEqual(store.get(key).costRows, []);
    // The tokens sitting inside `replies` are a REPLAY payload, not a ledger
    // row: they must contribute nothing to spend, or recovery would count
    // them a second time on top of the attempt record that already carries them.
    assert.equal(spendToDate(store).totalUsd, 0);
  } finally {
    cleanup();
  }
});

test("#103 AC2: writeBatchResumeRecord refuses a record whose pricing lever is unknown", () => {
  const { store, cleanup } = tempStore();
  try {
    assert.throws(
      () => writeBatchResumeRecord(store, { cellKey: "arm=A|brief=b|rep=0|cfg=abc", replies: {}, pricingLever: undefined }),
      /pricingLever must be "batch" or "single"/,
    );
  } finally {
    cleanup();
  }
});

test("#103: the resume family shares the attempt-key grammar but is NOT in the compaction set", () => {
  assert.ok(ATTEMPT_KEY_FAMILIES.includes(BATCH_RESUME_FAMILY), "it must parse and number like the others");
  assert.ok(!ATTEMPT_FAMILIES.includes(BATCH_RESUME_FAMILY), "compaction rewrites a body as its cost rows -- it would destroy the batch handle");
});

test("#103: planPrune never proposes compacting resume records, however many pile up", () => {
  const { store, cleanup } = tempStore();
  try {
    const cellKey = "arm=A|brief=brief-1|rep=0|cfg=abc";
    for (let i = 0; i < 9; i += 1) {
      writeBatchResumeRecord(store, {
        cellKey,
        cfg: "abc",
        replies: { [`r${i}`]: { model: "m", text: "t" } },
        outstanding: [{ provider: "anthropic", batchId: `msgbatch_${i}`, submitToCustom: {} }],
        pricingLever: "batch",
      });
    }
    const plan = planPrune(store, { keepAttempts: 2 });
    assert.equal(plan.compactions.length, 0, "a compacted resume record would lose the batch id -- a slower way to pay twice");
    // And the handle is still readable after a prune plan, as the batch id it must stay.
    assert.equal(readBatchResumeRecord(store, cellKey).outstanding[0].batchId, "msgbatch_8");
  } finally {
    cleanup();
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC3 — a later invocation re-polls instead of re-submitting
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Session 1: the batch is submitted and never leaves `in_progress`, so the
 * poll ceiling is blown and the batch is abandoned (and cancelled). Records
 * what was submitted so the second session can assert against it.
 */
function abandoningFetch({ batchId = "msgbatch_A", record }) {
  return async (url, opts) => {
    const u = String(url);
    if (u.endsWith("/cancel")) return jsonResponse(200, { id: batchId, processing_status: "canceling" });
    if (u.endsWith("/v1/messages/batches")) {
      record.submits.push(JSON.parse(opts.body));
      return jsonResponse(200, { id: batchId, processing_status: "in_progress", created_at: new Date().toISOString() });
    }
    if (u.includes("/v1/messages/batches/")) return jsonResponse(200, { id: batchId, processing_status: "in_progress" });
    throw new Error(`abandoningFetch: unexpected URL ${u}`);
  };
}

test("#103 AC3: session 1 abandons at the ceiling and hands back the durable handle plus the id map", async () => {
  const record = { submits: [] };
  const provider = new AnthropicBatchProvider({
    apiKey: "k",
    corpus: CORPUS,
    armsConfig: armsConfigFor("A"),
    fetchImpl: abandoningFetch({ record }),
    ideateImpl: soloRoundIdeate,
    sleep: noopSleep,
    maxPollMs: 1,
    pollIntervalMs: 1,
    logger: silentLogger,
  });
  const resp = await provider.generate(cellFor("A"), armsConfigJson.arms.A, { mode: "batch" });

  assert.equal(resp.terminalState, "failed");
  assert.equal(resp.failureKind, "timeout");
  assert.equal(resp.resume.outstanding.length, 1);
  const handle = resp.resume.outstanding[0];
  assert.equal(handle.batchId, "msgbatch_A");
  assert.equal(handle.provider, "anthropic");
  assert.ok(handle.submittedAt, "the 29-day results-retention check in a later process needs this");

  // The submitted custom_id maps back to a CONTENT id, and carries the model
  // the request was billed against.
  const submittedId = record.submits[0].requests[0].custom_id;
  assert.ok(handle.submitToCustom[submittedId], "without this map a recovered result row cannot be matched to a request");
  assert.equal(handle.submitToCustom[submittedId].model, "claude-sonnet-5");
});

test("#103 AC3: session 2 re-polls the durable handle, recovers the reply, and submits NOTHING", async () => {
  // Session 1.
  const record = { submits: [] };
  const p1 = new AnthropicBatchProvider({
    apiKey: "k",
    corpus: CORPUS,
    armsConfig: armsConfigFor("A"),
    fetchImpl: abandoningFetch({ record }),
    ideateImpl: soloRoundIdeate,
    sleep: noopSleep,
    maxPollMs: 1,
    pollIntervalMs: 1,
    logger: silentLogger,
  });
  const first = await p1.generate(cellFor("A"), armsConfigJson.arms.A, { mode: "batch" });
  assert.equal(first.failureKind, "timeout");
  const submittedId = record.submits[0].requests[0].custom_id;

  // Session 2: the batch has since ended. Nothing may be POSTed.
  const calls = [];
  const p2 = new AnthropicBatchProvider({
    apiKey: "k",
    corpus: CORPUS,
    armsConfig: armsConfigFor("A"),
    fetchImpl: async (url, opts) => {
      const u = String(url);
      calls.push(`${(opts && opts.method) || "POST"} ${u}`);
      if (u.endsWith("/results")) return textResponse(anthropicSucceeded(submittedId, ideasJson("recovered", 30)));
      if (u.includes("/v1/messages/batches/")) {
        return jsonResponse(200, { id: "msgbatch_A", processing_status: "ended", results_url: "https://api.anthropic.com/results" });
      }
      throw new Error(`session 2 must not reach ${u}`);
    },
    ideateImpl: soloRoundIdeate,
    sleep: noopSleep,
    maxPollMs: 60000,
    pollIntervalMs: 1,
    logger: silentLogger,
  });
  const second = await p2.generate(cellFor("A"), armsConfigJson.arms.A, { mode: "batch", resume: first.resume });

  assert.equal(second.terminalState, "completed");
  assert.equal(second.result.candidates.length, 30);
  assert.ok(second.result.candidates[0].text.startsWith("recovered"), "the pool must be the RECOVERED reply, not a fresh one");

  // THE assertion: no new batch was created.
  assert.equal(calls.filter((c) => c.endsWith("/v1/messages/batches")).length, 0, "a fresh submit here is paying twice -- the whole defect #103 exists to close");
  assert.equal(second.resume.outstanding.length, 0, "a fully recovered handle is spent and must not be re-polled forever");

  // And the recovered spend IS metered -- exactly once, on the session that
  // recovered it. This is what closes docs/PREREGISTRATION.md Appendix B item
  // 4's exception 1: before resume, this batch's tokens never reached the
  // ledger at all.
  assert.equal(second.tokens.tokens_by_model["claude-sonnet-5"].input_tokens, 100);
  assert.equal(second.tokens.tokens_by_model["claude-sonnet-5"].output_tokens, 50);
  assert.equal(first.tokens.tokens_by_model["claude-sonnet-5"], undefined, "session 1 abandoned before any reply arrived, so it metered nothing");
});

test("#103 AC3 (the hard case): a panel cell that finished round 1 and lost round 2 replays round 1 FREE and re-polls round 2", async () => {
  const arm = armsConfigJson.arms.B; // a 5-slot panel arm, 2 rounds
  const armsConfig = armsConfigFor("B");
  const cell = cellFor("B");

  // ── Session 1: round 1 ends normally; round 2 never leaves in_progress ──
  const s1 = { submits: [] };
  let round = 0;
  const p1 = new AnthropicBatchProvider({
    apiKey: "k",
    corpus: CORPUS,
    armsConfig,
    fetchImpl: async (url, opts) => {
      const u = String(url);
      if (u.endsWith("/cancel")) return jsonResponse(200, { id: "msgbatch_R2", processing_status: "canceling" });
      if (u.endsWith("/v1/messages/batches")) {
        round += 1;
        const body = JSON.parse(opts.body);
        s1.submits.push(body);
        return round === 1
          ? jsonResponse(200, { id: "msgbatch_R1", processing_status: "ended", results_url: "https://api.anthropic.com/r1", created_at: new Date().toISOString() })
          : jsonResponse(200, { id: "msgbatch_R2", processing_status: "in_progress", created_at: new Date().toISOString() });
      }
      if (u.endsWith("/r1")) {
        return textResponse(s1.submits[0].requests.map((r, i) => anthropicSucceeded(r.custom_id, ideasJson(`r1a${i}`))).join("\n"));
      }
      if (u.includes("/v1/messages/batches/")) return jsonResponse(200, { id: "msgbatch_R2", processing_status: "in_progress" });
      throw new Error(`session 1 unexpected URL ${u}`);
    },
    ideateImpl: twoRoundIdeate,
    sleep: noopSleep,
    maxPollMs: 1,
    pollIntervalMs: 1,
    logger: silentLogger,
  });
  const first = await p1.generate(cell, arm, { mode: "batch" });

  assert.equal(first.failureKind, "timeout", "round 2 blew the ceiling, so the cell is a transient failure per #92");
  assert.equal(Object.keys(first.resume.replies).length, 5, "round 1's five replies were paid for and must be remembered");
  assert.equal(first.resume.outstanding.length, 1, "round 2's handle must survive");

  // ── Session 2: round 2's batch has ended. Round 1 must NOT be re-issued. ──
  const s2 = { submits: [] };
  const r2SubmittedIds = s1.submits[1].requests.map((r) => r.custom_id);
  const p2 = new AnthropicBatchProvider({
    apiKey: "k",
    corpus: CORPUS,
    armsConfig,
    fetchImpl: async (url, opts) => {
      const u = String(url);
      if (u.endsWith("/v1/messages/batches")) {
        s2.submits.push(JSON.parse(opts.body));
        return jsonResponse(200, { id: "msgbatch_NEW", processing_status: "ended", results_url: "https://api.anthropic.com/new" });
      }
      if (u.endsWith("/r2")) {
        return textResponse(r2SubmittedIds.map((id, i) => anthropicSucceeded(id, ideasJson(`r2a${i}`))).join("\n"));
      }
      if (u.includes("/v1/messages/batches/msgbatch_R2")) {
        return jsonResponse(200, { id: "msgbatch_R2", processing_status: "ended", results_url: "https://api.anthropic.com/r2" });
      }
      throw new Error(`session 2 unexpected URL ${u}`);
    },
    ideateImpl: twoRoundIdeate,
    sleep: noopSleep,
    maxPollMs: 60000,
    pollIntervalMs: 1,
    logger: silentLogger,
  });
  const second = await p2.generate(cell, arm, { mode: "batch", resume: first.resume });

  assert.equal(second.terminalState, "completed");
  // 5 agents x 6 ideas x 2 rounds.
  assert.equal(second.result.candidates.length, 60);
  // Round 1's candidates are the REPLAYED ones -- byte-identical to session 1's.
  assert.ok(second.result.candidates[0].text.startsWith("r1a0"));
  // Round 2's are the recovered ones, not a fresh submit.
  assert.ok(second.result.candidates.some((c) => c.text.startsWith("r2a0")));
  assert.equal(s2.submits.length, 0, "not one request was re-issued: round 1 replayed, round 2 recovered");

  // Money: session 2 meters ONLY round 2's five recovered replies. Round 1's
  // tokens were metered by session 1 and live on its attempt record; metering
  // them again here is the double count AC4 names.
  assert.equal(second.tokens.tokens_by_model["claude-haiku-4-5"].input_tokens, 5 * 100);
  assert.equal(first.tokens.tokens_by_model["claude-haiku-4-5"].input_tokens, 5 * 100);
});

test("#103: a PARTIAL recovery re-issues only the requests that were never answered -- the cancel-on-abandon case", async () => {
  const arm = armsConfigJson.arms.B;
  const armsConfig = armsConfigFor("B");
  const cell = cellFor("B");

  const s1 = { submits: [] };
  const p1 = new AnthropicBatchProvider({
    apiKey: "k",
    corpus: CORPUS,
    armsConfig,
    fetchImpl: abandoningFetch({ batchId: "msgbatch_P", record: s1 }),
    ideateImpl: soloRoundIdeate,
    sleep: noopSleep,
    maxPollMs: 1,
    pollIntervalMs: 1,
    logger: silentLogger,
  });
  const first = await p1.generate(cell, arm, { mode: "batch" });
  const ids = s1.submits[0].requests.map((r) => r.custom_id);
  assert.equal(ids.length, 5);

  // Cancelled mid-flight: 3 requests had already reached the model and
  // `succeeded` (billed, and still in the results file); 2 came back
  // `canceled` (never sent, explicitly not billed).
  const s2 = { submits: [] };
  const p2 = new AnthropicBatchProvider({
    apiKey: "k",
    corpus: CORPUS,
    armsConfig,
    fetchImpl: async (url, opts) => {
      const u = String(url);
      if (u.endsWith("/v1/messages/batches")) {
        const body = JSON.parse(opts.body);
        s2.submits.push(body);
        return jsonResponse(200, { id: "msgbatch_FRESH", processing_status: "ended", results_url: "https://api.anthropic.com/fresh" });
      }
      if (u.endsWith("/fresh")) {
        return textResponse(s2.submits[0].requests.map((r) => anthropicSucceeded(r.custom_id, ideasJson("fresh"))).join("\n"));
      }
      if (u.endsWith("/p")) {
        return textResponse([...ids.slice(0, 3).map((id) => anthropicSucceeded(id, ideasJson("kept"))), ...ids.slice(3).map(anthropicCanceled)].join("\n"));
      }
      if (u.includes("/v1/messages/batches/msgbatch_P")) {
        return jsonResponse(200, { id: "msgbatch_P", processing_status: "ended", results_url: "https://api.anthropic.com/p" });
      }
      throw new Error(`unexpected URL ${u}`);
    },
    ideateImpl: soloRoundIdeate,
    sleep: noopSleep,
    maxPollMs: 60000,
    pollIntervalMs: 1,
    logger: silentLogger,
  });
  const second = await p2.generate(cell, arm, { mode: "batch", resume: first.resume });

  assert.equal(second.terminalState, "completed");
  assert.equal(s2.submits.length, 1, "the two unanswered requests still need a batch");
  assert.equal(s2.submits[0].requests.length, 2, "ONLY the two that came back `canceled` -- the other three were already paid for");
  // Three replayed + two fresh.
  assert.equal(second.result.candidates.filter((c) => c.text.startsWith("kept")).length, 18);
  assert.equal(second.result.candidates.filter((c) => c.text.startsWith("fresh")).length, 12);
});

// ═══════════════════════════════════════════════════════════════════════════
// AC4 — money is never double-counted, and never counted at the wrong RATE
// ═══════════════════════════════════════════════════════════════════════════

test("#103 AC4: across an abandon-then-resume pair, every token reaches the ledger exactly once", async () => {
  const { store, cleanup } = tempStore();
  try {
    const cell = cellFor("A");
    const arm = armsConfigJson.arms.A;
    const armsConfig = armsConfigFor("A");

    // Session 1 -- round 1 succeeds and IS metered, then the run is abandoned
    // by a second batch. (Modelled directly: one succeeded batch whose spend
    // is recorded on an attempt record, plus an outstanding handle.)
    const s1 = { submits: [] };
    const p1 = new AnthropicBatchProvider({
      apiKey: "k",
      corpus: CORPUS,
      armsConfig,
      fetchImpl: abandoningFetch({ record: s1 }),
      ideateImpl: soloRoundIdeate,
      sleep: noopSleep,
      maxPollMs: 1,
      pollIntervalMs: 1,
      logger: silentLogger,
    });
    const first = await p1.generate(cell, arm, { mode: "batch" });
    const submittedId = s1.submits[0].requests[0].custom_id;

    // The abandoned batch metered NOTHING (no reply ever arrived), so there is
    // no attempt-record spend for it. That is the premise the whole
    // no-double-count story rests on, and it is asserted rather than assumed.
    assert.deepEqual(first.tokens.tokens_by_model, {});

    writeBatchResumeRecord(store, { cellKey: cell.key, cfg: cell.cfg, replies: first.resume.replies, outstanding: first.resume.outstanding, pricingLever: "batch" });
    const spendAfterSession1 = spendToDate(store).totalUsd;
    assert.equal(spendAfterSession1, 0);

    // Session 2 recovers 100/50 tokens and meters them once.
    const p2 = new AnthropicBatchProvider({
      apiKey: "k",
      corpus: CORPUS,
      armsConfig,
      fetchImpl: async (url) => {
        const u = String(url);
        if (u.endsWith("/results")) return textResponse(anthropicSucceeded(submittedId, ideasJson("recovered", 30)));
        if (u.includes("/v1/messages/batches/")) return jsonResponse(200, { id: "msgbatch_A", processing_status: "ended", results_url: "https://api.anthropic.com/results" });
        throw new Error(`unexpected ${u}`);
      },
      ideateImpl: soloRoundIdeate,
      sleep: noopSleep,
      maxPollMs: 60000,
      pollIntervalMs: 1,
      logger: silentLogger,
    });
    const stored = readBatchResumeRecord(store, cell.key);
    const second = await p2.generate(cell, arm, { mode: "batch", resume: { replies: stored.replies, outstanding: stored.outstanding } });
    assert.equal(second.terminalState, "completed");

    // A THIRD invocation replaying the same cached replies must add nothing.
    const p3 = new AnthropicBatchProvider({
      apiKey: "k",
      corpus: CORPUS,
      armsConfig,
      fetchImpl: async (u) => {
        throw new Error(`session 3 must make no network call, but reached ${u}`);
      },
      ideateImpl: soloRoundIdeate,
      sleep: noopSleep,
      logger: silentLogger,
    });
    const third = await p3.generate(cell, arm, { mode: "batch", resume: second.resume });
    assert.equal(third.terminalState, "completed");
    assert.deepEqual(third.tokens.tokens_by_model, {}, "a REPLAYED reply was already metered by whoever recovered it -- metering it again is the double count");
  } finally {
    cleanup();
  }
});

test("#103 AC4 (wrong RATE, not double count): batch-produced replies are NOT replayed into a --no-batch invocation", () => {
  const { store, cleanup } = tempStore();
  try {
    const cell = cellFor("A");
    writeBatchResumeRecord(store, {
      cellKey: cell.key,
      cfg: cell.cfg,
      replies: { rABC: { model: "claude-sonnet-5", text: "t", usage: { input_tokens: 100, output_tokens: 50 } } },
      outstanding: [{ provider: "anthropic", batchId: "msgbatch_A", submitToCustom: {} }],
      pricingLever: "batch",
    });
    const record = readBatchResumeRecord(store, cell.key);

    // The record knows the lever its replies were produced under. `billing_mode`
    // could not have expressed this: it is "api" either way. And lib/price.mjs
    // resolves batch-vs-single from a flag the CALLER passes, with spendToDate
    // passing ONE flag for the whole store -- so replaying these into a
    // single-mode run would price them at ~2x what they cost, plausibly.
    assert.equal(record.pricingLever, "batch");

    // The provider half of the guard: resume is inert in single mode, so even
    // a caller that hands the state over anyway cannot replay it.
    const provider = new AnthropicBatchProvider({ apiKey: "k", corpus: CORPUS, armsConfig: armsConfigFor("A"), logger: silentLogger });
    const state = normalizeResumeState({ replies: record.replies, outstanding: record.outstanding });
    assert.equal(Object.keys(state.replies).length, 1);
    assert.equal(provider.resume, true, "resume is on by default; it is MODE that makes it inert, not a second switch");
  } finally {
    cleanup();
  }
});

test("#103 AC4: single mode never consults or produces resume state, so no batch-billed reply can be priced at the single rate", async () => {
  const provider = new AnthropicBatchProvider({
    apiKey: "k",
    corpus: CORPUS,
    armsConfig: armsConfigFor("A"),
    fetchImpl: async () => jsonResponse(200, { content: [{ type: "text", text: ideasJson("single", 30) }], stop_reason: "end_turn", usage: { input_tokens: 7, output_tokens: 3 } }),
    ideateImpl: soloRoundIdeate,
    sleep: noopSleep,
    logger: silentLogger,
  });
  const poisoned = { replies: { rDEADBEEF: { model: "claude-sonnet-5", text: ideasJson("REPLAYED", 30) } }, outstanding: [] };
  const resp = await provider.generate(cellFor("A"), armsConfigJson.arms.A, { mode: "single", resume: poisoned });

  assert.equal(resp.terminalState, "completed");
  assert.ok(resp.result.candidates[0].text.startsWith("single"), "a single-mode run must call the network, not replay batch-rate replies");
  assert.equal(resp.resume, undefined, "and it produces no resume state to be replayed back into a batch run");
});

// ═══════════════════════════════════════════════════════════════════════════
// AC5 — cancel-on-abandon's default, revisited
// ═══════════════════════════════════════════════════════════════════════════

test("#103 AC5: cancel-on-abandon still defaults ON -- resume and cancellation are complements, not alternatives", async () => {
  for (const Provider of [AnthropicBatchProvider, OpenAIBatchProvider]) {
    const p = new Provider({ apiKey: "k", corpus: CORPUS, armsConfig: armsConfigFor("A"), logger: silentLogger });
    assert.equal(p.cancelOnAbandon, true, `${Provider.name}: cancelling caps unattended billing and PRESERVES already-succeeded results`);
    assert.equal(p.resume, true, `${Provider.name}: paying twice should never require a flag to avoid`);
  }
});

test("#103 AC5: a cancelled batch is still re-polled -- the handle survives cancellation", async () => {
  const record = { submits: [] };
  let cancelled = false;
  const p1 = new AnthropicBatchProvider({
    apiKey: "k",
    corpus: CORPUS,
    armsConfig: armsConfigFor("A"),
    fetchImpl: async (url, opts) => {
      const u = String(url);
      if (u.endsWith("/cancel")) {
        cancelled = true;
        return jsonResponse(200, { id: "msgbatch_C", processing_status: "canceling" });
      }
      if (u.endsWith("/v1/messages/batches")) {
        record.submits.push(JSON.parse(opts.body));
        return jsonResponse(200, { id: "msgbatch_C", processing_status: "in_progress", created_at: new Date().toISOString() });
      }
      if (u.includes("/v1/messages/batches/")) return jsonResponse(200, { id: "msgbatch_C", processing_status: "in_progress" });
      throw new Error(u);
    },
    ideateImpl: soloRoundIdeate,
    sleep: noopSleep,
    maxPollMs: 1,
    pollIntervalMs: 1,
    logger: silentLogger,
  });
  const first = await p1.generate(cellFor("A"), armsConfigJson.arms.A, { mode: "batch" });

  assert.equal(cancelled, true, "the default cancelled it");
  assert.equal(first.resume.outstanding.length, 1, "and the handle was kept anyway -- cancelling does not destroy it");
  assert.equal(first.resume.outstanding[0].cancelled, true);
});

// ═══════════════════════════════════════════════════════════════════════════
// AC6 — an expired handle degrades to a fresh submit, never to an error
// ═══════════════════════════════════════════════════════════════════════════

test("#103 AC6: the retention window is the RESULTS window (29d Anthropic / 30d OpenAI), not the 24h processing window", () => {
  // The issue's own line said "Anthropic expires batches at 24h -- confirm the
  // current figure". Confirmed 2026-09-02: 24h is the PROCESSING window;
  // results stay downloadable for 29 days. Taking 24h on trust would have
  // discarded every handle older than a day while its results were still there.
  assert.equal(ANTHROPIC_RESULTS_RETENTION_DAYS, 29);
  assert.equal(OPENAI_RESULTS_RETENTION_DAYS, 30);

  const day = 24 * 60 * 60 * 1000;
  const now = Date.UTC(2026, 8, 2);
  const iso = (msAgo) => new Date(now - msAgo).toISOString();
  assert.equal(batchResultsExpired(iso(2 * day), 29 * day, now), false, "a two-day-old handle is squarely inside the results window");
  assert.equal(batchResultsExpired(iso(28 * day), 29 * day, now), false);
  assert.equal(batchResultsExpired(iso(30 * day), 29 * day, now), true);
  // An unknown timestamp is NOT treated as expired: guessing "dead" throws
  // away a recoverable batch and re-spends for it; guessing "live" costs one GET.
  assert.equal(batchResultsExpired(undefined, 29 * day, now), false);
  assert.equal(batchResultsExpired("not-a-date", 29 * day, now), false);
});

test("#103 AC6: a handle the API no longer knows (404) degrades to a fresh submit, not an error", async () => {
  const submits = [];
  const provider = new AnthropicBatchProvider({
    apiKey: "k",
    corpus: CORPUS,
    armsConfig: armsConfigFor("A"),
    fetchImpl: async (url, opts) => {
      const u = String(url);
      if (u.endsWith("/v1/messages/batches")) {
        submits.push(JSON.parse(opts.body));
        return jsonResponse(200, { id: "msgbatch_NEW", processing_status: "ended", results_url: "https://api.anthropic.com/new" });
      }
      if (u.endsWith("/new")) return textResponse(anthropicSucceeded(submits[0].requests[0].custom_id, ideasJson("fresh", 30)));
      if (u.includes("/v1/messages/batches/msgbatch_GONE")) return jsonResponse(404, { error: { type: "not_found_error", message: "not found" } });
      throw new Error(u);
    },
    ideateImpl: soloRoundIdeate,
    sleep: noopSleep,
    maxPollMs: 60000,
    pollIntervalMs: 1,
    maxRetries: 0,
    logger: silentLogger,
  });
  const resp = await provider.generate(cellFor("A"), armsConfigJson.arms.A, {
    mode: "batch",
    resume: { replies: {}, outstanding: [{ provider: "anthropic", batchId: "msgbatch_GONE", submittedAt: new Date().toISOString(), submitToCustom: {} }] },
  });

  assert.equal(resp.terminalState, "completed", "a dead handle must not fail the cell");
  assert.equal(submits.length, 1, "it degrades to exactly one fresh submit");
  assert.equal(resp.resume.outstanding.length, 0, "and the dead handle is dropped rather than re-polled forever");
});

test("#103 AC6: a handle past the documented results retention is dropped WITHOUT a network call", async () => {
  const seen = [];
  const provider = new AnthropicBatchProvider({
    apiKey: "k",
    corpus: CORPUS,
    armsConfig: armsConfigFor("A"),
    fetchImpl: async (url, opts) => {
      const u = String(url);
      seen.push(u);
      if (u.endsWith("/v1/messages/batches")) {
        const body = JSON.parse(opts.body);
        return jsonResponse(200, { id: "msgbatch_NEW", processing_status: "ended", results_url: `https://api.anthropic.com/new?${body.requests[0].custom_id}` });
      }
      if (u.includes("/new?")) return textResponse(anthropicSucceeded(u.split("?")[1], ideasJson("fresh", 30)));
      throw new Error(`no call should have been made to ${u}`);
    },
    ideateImpl: soloRoundIdeate,
    sleep: noopSleep,
    maxPollMs: 60000,
    pollIntervalMs: 1,
    logger: silentLogger,
  });
  const ancient = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
  const resp = await provider.generate(cellFor("A"), armsConfigJson.arms.A, {
    mode: "batch",
    resume: { replies: {}, outstanding: [{ provider: "anthropic", batchId: "msgbatch_OLD", submittedAt: ancient, submitToCustom: {} }] },
  });

  assert.equal(resp.terminalState, "completed");
  assert.ok(!seen.some((u) => u.includes("msgbatch_OLD")), "a handle known to be past retention is not worth a round trip");
});

test("#103: a resumed batch that is STILL running re-abandons cheaply -- it re-polls and submits nothing new", async () => {
  const calls = [];
  const provider = new AnthropicBatchProvider({
    apiKey: "k",
    corpus: CORPUS,
    armsConfig: armsConfigFor("B"),
    fetchImpl: async (url) => {
      const u = String(url);
      calls.push(u);
      if (u.endsWith("/v1/messages/batches")) throw new Error("a still-running batch must not trigger a fresh submit");
      if (u.includes("/v1/messages/batches/msgbatch_SLOW")) return jsonResponse(200, { id: "msgbatch_SLOW", processing_status: "in_progress" });
      throw new Error(u);
    },
    ideateImpl: soloRoundIdeate,
    sleep: noopSleep,
    maxPollMs: 1,
    pollIntervalMs: 1,
    logger: silentLogger,
  });
  const resp = await provider.generate(cellFor("B"), armsConfigJson.arms.B, {
    mode: "batch",
    resume: { replies: {}, outstanding: [{ provider: "anthropic", batchId: "msgbatch_SLOW", submittedAt: new Date().toISOString(), submitToCustom: {} }] },
  });

  assert.equal(resp.terminalState, "failed");
  assert.equal(resp.failureKind, "timeout");
  assert.equal(resp.resume.outstanding.length, 1, "the handle is retained -- it may still pay off");
  assert.deepEqual(resp.tokens.tokens_by_model, {}, "and this attempt cost nothing at all");
});

// ════════════════════════════════════════════════════════════════════════════
// End to end through runSpec() -- the wiring, not just the pieces
// ════════════════════════════════════════════════════════════════════════════

const SPEC_CONFIG = { harnessVersion: "0.0.1", engineSha: "test-sha", promptHash: "test-prompt" };
/** The one-cell spec runSpec plans against, matching planCells()'s shape. */
function oneCellSpec() {
  return { arms: [{ id: "A" }], briefs: [{ id: "brief-1" }], replicates: 1, config: SPEC_CONFIG };
}

test("#103 end-to-end: runSpec persists the handle on the abandoned run and REPLAYS it on the next one", async (t) => {
  const { store, cleanup } = tempStore();
  t.after(cleanup);
  const { cellKey, configHash } = await import("../../lib/manifest.mjs");
  const armsConfig = armsConfigFor("A");
  const spec = oneCellSpec();
  const key = cellKey({ armId: "A", briefId: "brief-1", replicate: 0, cfg: configHash(SPEC_CONFIG) });

  // ── Invocation 1: the batch never ends, so the cell fails `timeout` ─────
  const s1 = { submits: [] };
  const p1 = new AnthropicBatchProvider({
    apiKey: "k",
    corpus: CORPUS,
    armsConfig,
    fetchImpl: abandoningFetch({ record: s1 }),
    ideateImpl: soloRoundIdeate,
    sleep: noopSleep,
    maxPollMs: 1,
    pollIntervalMs: 1,
    logger: silentLogger,
  });
  const run1 = await runSpec(spec, { store, armsConfig, provider: p1, log: silentLogger });
  assert.equal(run1.summary.failed, 1);
  assert.ok(!store.has(key), "a transient failure is never written under the cell key (#90)");

  // The handle is durable across the process boundary, which is the point.
  const persisted = readBatchResumeRecord(store, key);
  assert.ok(persisted, "runSpec must persist the replay state, or the handle dies with the process");
  assert.equal(persisted.pricingLever, "batch");
  assert.equal(persisted.outstanding.length, 1);
  assert.equal(persisted.outstanding[0].batchId, "msgbatch_A");

  // ── Invocation 2: the batch has ended. Nothing may be submitted. ────────
  const submittedId = s1.submits[0].requests[0].custom_id;
  const posted = [];
  const p2 = new AnthropicBatchProvider({
    apiKey: "k",
    corpus: CORPUS,
    armsConfig,
    fetchImpl: async (url, opts) => {
      const u = String(url);
      if (u.endsWith("/v1/messages/batches")) posted.push(u);
      if (u.endsWith("/results")) return textResponse(anthropicSucceeded(submittedId, ideasJson("recovered", 30)));
      if (u.includes("/v1/messages/batches/")) return jsonResponse(200, { id: "msgbatch_A", processing_status: "ended", results_url: "https://api.anthropic.com/results" });
      throw new Error(`invocation 2 must not reach ${u}`);
    },
    ideateImpl: soloRoundIdeate,
    sleep: noopSleep,
    maxPollMs: 60000,
    pollIntervalMs: 1,
    logger: silentLogger,
  });
  const run2 = await runSpec(spec, { store, armsConfig, provider: p2, log: silentLogger });

  assert.equal(run2.summary.completed, 1, "the recovered results must reach the cell");
  assert.equal(posted.length, 0, "a fresh submit here is paying twice");
  assert.ok(store.has(key));
  assert.ok(store.get(key).result.candidates[0].text.startsWith("recovered"));

  // AC4, end to end: the store's total is the ONE batch that was actually
  // billed -- 100 in / 50 out on claude-sonnet-5 -- counted once.
  const spend = spendToDate(store);
  const rows = store
    .list()
    .flatMap((e) => store.get(e.key).costRows)
    .filter((r) => r.tokens_by_model && r.tokens_by_model["claude-sonnet-5"]);
  const input = rows.reduce((n, r) => n + r.tokens_by_model["claude-sonnet-5"].input_tokens, 0);
  const output = rows.reduce((n, r) => n + r.tokens_by_model["claude-sonnet-5"].output_tokens, 0);
  assert.equal(input, 100, "the recovered reply's input tokens are in the ledger exactly once");
  assert.equal(output, 50);
  assert.ok(spend.totalUsd > 0);
  assert.equal(spend.hasMissingRate, false);

  // ── Invocation 3: the cell is `reuse` now, so nothing runs and nothing is
  // spent. This is what bounds the replay records: a completed cell can never
  // re-enter the loop, so it never writes another one.
  const before = store.keys().length;
  const p3 = new AnthropicBatchProvider({
    apiKey: "k",
    corpus: CORPUS,
    armsConfig,
    fetchImpl: async (u) => {
      throw new Error(`invocation 3 must call nothing, but reached ${u}`);
    },
    ideateImpl: soloRoundIdeate,
    sleep: noopSleep,
    logger: silentLogger,
  });
  const run3 = await runSpec(spec, { store, armsConfig, provider: p3, log: silentLogger });
  assert.equal(run3.summary.completed, 1, "the stored cell is reused, not re-run -- the fetchImpl above would have thrown");
  assert.equal(store.keys().length, before, "a reused cell writes no new records at all");
  assert.equal(spendToDate(store).totalUsd, spend.totalUsd, "and spends nothing");
});

test("#103 end-to-end: --no-resume makes runSpec re-submit rather than replay, and records nothing", async (t) => {
  const { store, cleanup } = tempStore();
  t.after(cleanup);
  const armsConfig = armsConfigFor("A");
  const spec = oneCellSpec();

  const s1 = { submits: [] };
  const p1 = new AnthropicBatchProvider({
    apiKey: "k",
    corpus: CORPUS,
    armsConfig,
    fetchImpl: abandoningFetch({ record: s1 }),
    ideateImpl: soloRoundIdeate,
    sleep: noopSleep,
    maxPollMs: 1,
    pollIntervalMs: 1,
    resume: false,
    logger: silentLogger,
  });
  await runSpec(spec, { store, armsConfig, provider: p1, resume: false, log: silentLogger });

  assert.equal(
    store.keys().filter((k) => k.startsWith(BATCH_RESUME_FAMILY)).length,
    0,
    "--no-resume must not quietly accumulate replay records the operator asked not to keep",
  );
});

// ════════════════════════════════════════════════════════════════════════════
// OpenAI: the same contract, verified against OpenAI's own semantics
// ════════════════════════════════════════════════════════════════════════════

function openaiSucceeded(customId, text, usage = { prompt_tokens: 100, completion_tokens: 50 }) {
  return JSON.stringify({
    custom_id: customId,
    response: { status_code: 200, body: { choices: [{ message: { content: text }, finish_reason: "stop" }], usage } },
  });
}

test("#103 OpenAI: session 2 re-polls the abandoned batch, reads its output file, and submits nothing", async () => {
  const arm = armsConfigJson.arms.H;
  const armsConfig = armsConfigFor("H");
  const cell = cellFor("H");

  // Session 1 -- batch created, never leaves in_progress.
  let uploaded;
  const p1 = new OpenAIBatchProvider({
    apiKey: "k",
    corpus: CORPUS,
    armsConfig,
    fetchImpl: async (url, opts) => {
      const u = String(url);
      if (u.endsWith("/v1/files")) {
        uploaded = await opts.body.get("file").text();
        return jsonResponse(200, { id: "file_in" });
      }
      if (u.endsWith("/v1/batches")) return jsonResponse(200, { id: "batch_O", status: "in_progress", created_at: Math.floor(Date.now() / 1000) });
      if (u.endsWith("/cancel")) return jsonResponse(200, { id: "batch_O", status: "cancelling" });
      if (u.includes("/v1/batches/")) return jsonResponse(200, { id: "batch_O", status: "in_progress" });
      throw new Error(u);
    },
    ideateImpl: soloRoundIdeate,
    sleep: noopSleep,
    maxPollMs: 1,
    pollIntervalMs: 1,
    logger: silentLogger,
  });
  const first = await p1.generate(cell, arm, { mode: "batch" });
  assert.equal(first.failureKind, "timeout");
  assert.equal(first.resume.outstanding.length, 1);
  const submittedIds = uploaded.split("\n").map((l) => JSON.parse(l).custom_id);

  // Session 2 -- the batch has since completed and has an output file.
  const calls = [];
  const p2 = new OpenAIBatchProvider({
    apiKey: "k",
    corpus: CORPUS,
    armsConfig,
    fetchImpl: async (url) => {
      const u = String(url);
      calls.push(u);
      if (u.endsWith("/v1/files/file_out/content")) {
        return textResponse(submittedIds.map((id, i) => openaiSucceeded(id, ideasJson(`recovered${i}`))).join("\n"));
      }
      if (u.includes("/v1/batches/batch_O")) return jsonResponse(200, { id: "batch_O", status: "completed", output_file_id: "file_out" });
      throw new Error(`session 2 must not reach ${u}`);
    },
    ideateImpl: soloRoundIdeate,
    sleep: noopSleep,
    maxPollMs: 60000,
    pollIntervalMs: 1,
    logger: silentLogger,
  });
  const second = await p2.generate(cell, arm, { mode: "batch", resume: first.resume });

  assert.equal(second.terminalState, "completed");
  assert.ok(second.result.candidates[0].text.startsWith("recovered"));
  assert.equal(calls.filter((c) => c.endsWith("/v1/files")).length, 0, "no new input file was uploaded");
  assert.equal(calls.filter((c) => c.endsWith("/v1/batches")).length, 0, "no new batch was created");
  // OpenAI reports prompt_tokens/completion_tokens; the ledger shape is input/output.
  const model = arm.slots[0].model;
  assert.equal(second.tokens.tokens_by_model[model].input_tokens, submittedIds.length * 100);
});

test("#103 OpenAI: a terminal batch with no output_file_id recovers nothing and degrades to a fresh submit", async () => {
  // OpenAI documents that a cancelling batch lets in-flight requests complete,
  // but does NOT document whether an output file is produced for them. This
  // path therefore assumes nothing -- which is correct either way.
  const arm = armsConfigJson.arms.H;
  let created = 0;
  let uploadedIds = [];
  const provider = new OpenAIBatchProvider({
    apiKey: "k",
    corpus: CORPUS,
    armsConfig: armsConfigFor("H"),
    fetchImpl: async (url, opts) => {
      const u = String(url);
      if (u.endsWith("/v1/files")) {
        uploadedIds = (await opts.body.get("file").text()).split("\n").map((l) => JSON.parse(l).custom_id);
        return jsonResponse(200, { id: "file_in2" });
      }
      if (u.endsWith("/v1/batches")) {
        created += 1;
        return jsonResponse(200, { id: "batch_NEW", status: "completed", output_file_id: "file_out2", created_at: Math.floor(Date.now() / 1000) });
      }
      if (u.endsWith("/v1/files/file_out2/content")) {
        return textResponse(uploadedIds.map((id) => openaiSucceeded(id, ideasJson("fresh"))).join("\n"));
      }
      if (u.includes("/v1/batches/batch_CANCELLED")) return jsonResponse(200, { id: "batch_CANCELLED", status: "cancelled" });
      throw new Error(u);
    },
    ideateImpl: soloRoundIdeate,
    sleep: noopSleep,
    maxPollMs: 60000,
    pollIntervalMs: 1,
    logger: silentLogger,
  });

  const resp = await provider.generate(cellFor("H"), arm, {
    mode: "batch",
    resume: { replies: {}, outstanding: [{ provider: "openai", batchId: "batch_CANCELLED", submittedAt: new Date().toISOString(), submitToCustom: {} }] },
  });

  assert.equal(resp.terminalState, "completed");
  assert.equal(created, 1, "nothing recoverable, so exactly one fresh batch");
  assert.equal(resp.resume.outstanding.length, 0);
});
