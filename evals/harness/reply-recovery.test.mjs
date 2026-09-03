// reply-recovery.test.mjs — hermetic tests for issue #93: arm-correlated cell
// loss in the #8 smoke study (arm A lost 9 of 10 cells to `empty_pool`; every
// panel arm lost 0).
//
// No network, no real ideate-core, no real timers — same discipline as
// anthropic-batch.test.mjs / openai-batch.test.mjs, and for the same reason:
// CI runs `node --test` with an EMPTY node_modules.
//
// ── The two fixtures are the two REAL failure shapes ────────────────────────
// Both come from a live 6-sample probe of arm A's exact round-1 request
// (persona "solo", ideasPerAgent 30, max_tokens 2048, claude-sonnet-5), which
// failed 2 of 6 by two different mechanisms:
//
//   1. TRUNCATED — `stop_reason: "max_tokens"` at 2048 output tokens, JSON cut
//      mid-string ("Unterminated string in JSON at position 1249"). Clean
//      30-idea replies run 1597–1857 output tokens, i.e. 78–91% of the old
//      flat 2048 cap: arm A was riding the limit, panel arms (6 ideas) were
//      nowhere near it.
//   2. COMPLETE BUT MALFORMED — `stop_reason: "end_turn"` at 1833 tokens (the
//      model FINISHED) and still failed JSON.parse with "Expected ',' or '}'
//      after property value". Raising max_tokens alone would not save this
//      cell, which is why salvage exists.
//
// `malformedCompleteReply()` and `truncatedReply()` below reproduce those two
// shapes exactly.
//
// ── What these tests are actually pinning ───────────────────────────────────
// The helper-level tests are details. The load-bearing ones are the
// PROVIDER-level tests: they drive `generate()` with a fake ideateImpl that
// mimics ideate-core's real extraction contract (JSON.parse the reply, keep
// objects with a non-empty string `.text`) and assert that a malformed or
// truncated reply now yields a COMPLETED cell with a non-empty pool, and that
// when a pool genuinely is empty the ledger `detail` says WHICH of the three
// causes it was.

import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";

import {
  AnthropicBatchProvider,
  OpenAIBatchProvider,
  buildAnthropicMessageParams,
  buildOpenAIChatParams,
  classifyPoolFailure,
  MAX_DETAIL_CHARS,
  maxTokensForCell,
  normalizeOpenAIFinishReason,
  resolveIdeateAgents,
  summarizeReply,
  withCellMaxTokens,
} from "./provider.mjs";
import {
  DEFAULT_TOKENS_PER_IDEA,
  LEGACY_MAX_TOKENS,
  MAX_TOKENS_HEADROOM,
  TOKENS_PER_IDEA_BY_MODEL,
  maxTokensForIdeas,
  promptTemplateHash,
  salvageCandidateArray,
} from "./prompts.mjs";

const armsConfigJson = JSON.parse(await fs.readFile(new URL("../../arms.config.json", import.meta.url), "utf8"));

const CORPUS = [{ id: "brief-1", text: "Design a better bus stop." }];
const noopSleep = async () => {};
const silentLogger = () => {};

/** The observed worst-case clean output length for a 30-idea arm-A reply. */
const OBSERVED_MAX_OUTPUT_TOKENS_30 = 1857;

function armsConfigFor(...armIds) {
  const arms = {};
  for (const id of armIds) arms[id] = armsConfigJson.arms[id];
  return { panel: armsConfigJson.panel, arms };
}

function cellFor(armId, briefId = "brief-1") {
  return { key: `arm=${armId}|brief=${briefId}|rep=0|cfg=abc`, armId, briefId, replicate: 0, cfg: "abc" };
}

// ── Fixtures: the two real failure shapes ───────────────────────────────────

/** A well-formed reply of `n` `{"text": ...}` objects. */
function cleanReply(n) {
  return JSON.stringify(Array.from({ length: n }, (_, i) => ({ text: `idea number ${i} for the brief` })));
}

/**
 * A reply that stopped on `end_turn` (COMPLETE) but is syntactically invalid:
 * object #7 is missing the comma between two properties, which is exactly the
 * "Expected ',' or '}' after property value" shape the probe caught. Every
 * other object is perfect, so 29 of 30 ideas are recoverable.
 */
function malformedCompleteReply(n = 30, badIndex = 7) {
  const objects = Array.from({ length: n }, (_, i) =>
    i === badIndex
      ? `{"text": "idea number ${i} for the brief" "note": "unterminated property list"}`
      : `{"text": "idea number ${i} for the brief"}`,
  );
  return `[${objects.join(",")}]`;
}

/**
 * A reply cut off mid-string by `max_tokens`, the way the probe's biz-01 #2
 * sample was: `n` complete objects, then a partial one, and no closing `]`.
 */
function truncatedReply(n = 28) {
  const objects = Array.from({ length: n }, (_, i) => `{"text": "idea number ${i} for the brief"}`);
  return `[${objects.join(",")},{"text": "idea number ${n} which was cut off mid-sen`;
}

// ── Fake ideateImpl: ideate-core's REAL extraction contract ─────────────────
//
// node_modules is empty under `node --test`, so the real extractCandidates is
// unavailable. This mimics the contract prompts.mjs's header quotes from
// ideate-core@0.4.0's source: parse the reply as ONE JSON document, and keep
// each raw candidate whose `.text` is a non-empty string
// (`const text = typeof raw.text === "string" ? raw.text.trim() : "";
//   if (!text) return null;`). One malformed object therefore costs the WHOLE
// pool unless the provider repaired the reply first — which is the bug.
function ideateImplLikeIdeateCore(input, deps) {
  const { complete, agents } = deps;
  return Promise.all(
    agents.map((agent) =>
      complete({
        model: agent.model,
        prompt: deps.buildRound1Prompt({ context: input.context, persona: agent.persona, ideasPerAgent: agent.ideasPerAgent }),
        temperature: 0.7,
        persona: agent.persona,
      }),
    ),
  ).then((results) => {
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
        agentsFailed++;
        return; // the whole reply is discarded — exactly ideate-core's behaviour
      }
      if (!Array.isArray(raw)) return;
      for (const c of raw) {
        const text = c && typeof c.text === "string" ? c.text.trim() : "";
        if (!text) continue;
        candidates.push({ id: `${agents[i].id}-${candidates.length}`, text, agentId: agents[i].id, model: agents[i].model, round: 1 });
      }
    });
    return { candidates, agents, meta: { agentsAttempted: agents.length, agentsFailed } };
  });
}

// ── Anthropic fake transport ────────────────────────────────────────────────

function jsonResponse(status, obj) {
  return { ok: status >= 200 && status < 300, status, json: async () => obj, text: async () => JSON.stringify(obj) };
}
function textResponse(text, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => text, json: async () => JSON.parse(text) };
}

/**
 * Routes the Message Batches flow and lets a test dictate each reply's text,
 * stop_reason and usage. `capture.requests` holds the submitted params array,
 * so a test can assert on the ACTUAL max_tokens that went out.
 */
function anthropicBatchFetch({ reply, stopReason = "end_turn", usage = { input_tokens: 100, output_tokens: 1833 }, capture = {} }) {
  let submitted;
  return async (url, opts) => {
    const u = String(url);
    if (u.endsWith("/v1/messages/batches")) {
      submitted = JSON.parse(opts.body);
      capture.requests = submitted.requests;
      return jsonResponse(200, { id: "batch_1", processing_status: "ended", results_url: "https://fake/results" });
    }
    if (u.includes("/v1/messages/batches/")) {
      return jsonResponse(200, { id: "batch_1", processing_status: "ended", results_url: "https://fake/results" });
    }
    if (u === "https://fake/results") {
      const lines = submitted.requests.map((r) => ({
        custom_id: r.custom_id,
        result: { type: "succeeded", message: { content: [{ type: "text", text: reply }], stop_reason: stopReason, usage } },
      }));
      return textResponse(lines.map((l) => JSON.stringify(l)).join("\n"));
    }
    throw new Error(`anthropicBatchFetch: unexpected URL ${u}`);
  };
}

function anthropicProvider(armId, fetchImpl) {
  return new AnthropicBatchProvider({
    apiKey: "test-key",
    corpus: CORPUS,
    armsConfig: armsConfigFor(armId),
    fetchImpl,
    ideateImpl: ideateImplLikeIdeateCore,
    sleep: noopSleep,
    logger: silentLogger,
  });
}

function runArm(armId, fetchImpl) {
  return anthropicProvider(armId, fetchImpl).generate(cellFor(armId), armsConfigJson.arms[armId], { mode: "batch" });
}

// ════════════════════════════════════════════════════════════════════════════
// AC 1 — max_tokens scales with what the arm asks for
// ════════════════════════════════════════════════════════════════════════════

test("#93 AC1: maxTokensForIdeas gives a 30-idea Sonnet request 2x-3x headroom over the observed 1857-token worst case", () => {
  const solo = maxTokensForIdeas(30, "claude-sonnet-5");
  assert.ok(solo >= 2 * OBSERVED_MAX_OUTPUT_TOKENS_30, `${solo} must be at least 2x ${OBSERVED_MAX_OUTPUT_TOKENS_30}`);
  assert.ok(solo <= 3 * OBSERVED_MAX_OUTPUT_TOKENS_30, `${solo} must be at most 3x ${OBSERVED_MAX_OUTPUT_TOKENS_30}`);
  // And explicitly NOT the "+10%" the issue body ruled out.
  assert.ok(solo > 1.1 * LEGACY_MAX_TOKENS);
  assert.equal(solo, Math.ceil(30 * TOKENS_PER_IDEA_BY_MODEL["claude-sonnet-5"] * MAX_TOKENS_HEADROOM));
});

test("#93 AC1: a 6-idea (panel) Sonnet request still computes to EXACTLY the legacy 2048 — comparability with run #8", () => {
  // The floor is the whole comparability argument: arms B–H and A' must send
  // byte-identical requests to the ones run #8 sent, so only arm A's cells
  // become non-comparable. If this ever fails, every arm's #8 data is affected.
  assert.equal(maxTokensForIdeas(armsConfigJson.panel.ideasPerAgent, "claude-sonnet-5"), LEGACY_MAX_TOKENS);
  assert.equal(maxTokensForIdeas(6, "claude-sonnet-5"), 2048);
});

test("#93 AC1: maxTokensForCell degrades safely on an empty/garbage agent list (never -Infinity or NaN)", () => {
  // Math.max(...[]) is -Infinity; a max_tokens of -Infinity would be a live
  // 400 from the API on every call, so this is guarded explicitly.
  for (const input of [[], undefined, null, [null], [{}], [{ ideasPerAgent: 0 }], [{ ideasPerAgent: "thirty" }]]) {
    const v = maxTokensForCell(input);
    assert.ok(Number.isFinite(v) && v >= LEGACY_MAX_TOKENS, `maxTokensForCell(${JSON.stringify(input)}) = ${v}`);
  }
  assert.equal(
    maxTokensForCell([{ ideasPerAgent: 6, model: "claude-sonnet-5" }, { ideasPerAgent: 30, model: "claude-sonnet-5" }]),
    maxTokensForIdeas(30, "claude-sonnet-5"),
  );
});

test("#93 AC1: arm A's live batch request carries the scaled max_tokens; arm B's carries its own (Haiku-fallback) ceiling", async () => {
  const capA = {};
  await runArm("A", anthropicBatchFetch({ reply: cleanReply(30), capture: capA }));
  assert.equal(capA.requests.length, 1);
  assert.equal(capA.requests[0].params.max_tokens, maxTokensForIdeas(30, "claude-sonnet-5"));
  assert.ok(capA.requests[0].params.max_tokens >= 3700);

  // Arm B (homogeneous Haiku) has no measured Haiku rate (issue #122 -- not
  // remeasured, see prompts.mjs's header comment), so it falls back to
  // DEFAULT_TOKENS_PER_IDEA, the same generous ceiling Opus gets. That is
  // NOT "arm B now behaves like arm D" -- Haiku still writes whatever it
  // writes; only the unused CEILING moved, which costs nothing (see
  // prompts.mjs: "max_tokens is a CEILING, not a target").
  const capB = {};
  await runArm("B", anthropicBatchFetch({ reply: cleanReply(6), capture: capB }));
  assert.equal(capB.requests.length, 5);
  for (const r of capB.requests) assert.equal(r.params.max_tokens, maxTokensForIdeas(6, "claude-haiku-4-5"));
});

test("#93/#122 AC1: every panel arm in arms.config.json sends its OWN model's computed ceiling; only models above the floor change", () => {
  for (const [id, arm] of Object.entries(armsConfigJson.arms)) {
    const { agents } = resolveIdeateAgents(arm, armsConfigJson);
    const got = maxTokensForCell(agents);
    if (arm.mode === "solo") {
      assert.equal(got, maxTokensForIdeas(arm.totalIdeasRequested, agents[0].model), `arm ${id}`);
    } else {
      // Per-model max across the panel's slots. Only claude-sonnet-5 has its
      // own measured rate that computes BELOW the floor at ideasPerAgent 6
      // (930 < 2048) -- every other model (Opus: measured above the floor;
      // Haiku/GPT tiers: no measurement, so DEFAULT_TOKENS_PER_IDEA, which
      // also computes above the floor) raises the cell's ceiling. So arm C
      // (pure Sonnet) is the ONLY panel arm unchanged from run #8; every arm
      // with even one non-Sonnet slot (B, D, E, F, G, H, A') is raised.
      const expected = Math.max(...agents.map((a) => maxTokensForIdeas(a.ideasPerAgent, a.model)));
      assert.equal(got, expected, `arm ${id}`);
      const allSonnet = agents.every((a) => a.model === "claude-sonnet-5");
      if (allSonnet) assert.equal(got, LEGACY_MAX_TOKENS, `arm ${id} is pure Sonnet and must be unchanged from run #8`);
      else assert.ok(got > LEGACY_MAX_TOKENS, `arm ${id} has a non-Sonnet slot and must be raised above the floor`);
    }
  }
});

test("#93: withCellMaxTokens never shrinks a request the engine deliberately sized larger", () => {
  assert.equal(withCellMaxTokens({ model: "m" }, 4650).maxTokens, 4650);
  assert.equal(withCellMaxTokens({ model: "m", maxTokens: 2048 }, 4650).maxTokens, 4650);
  assert.equal(withCellMaxTokens({ model: "m", maxTokens: 9000 }, 4650).maxTokens, 9000);
  // A missing/garbage cell ceiling leaves the request untouched.
  assert.equal(withCellMaxTokens({ model: "m", maxTokens: 111 }, undefined).maxTokens, 111);
  // The param builders' own contract is unchanged: an explicit maxTokens wins.
  assert.equal(buildAnthropicMessageParams({ model: "m", prompt: "p", maxTokens: 111 }).max_tokens, 111);
  assert.equal(buildOpenAIChatParams({ model: "m", prompt: "p", maxTokens: 111 }).max_completion_tokens, 111);
});

// ════════════════════════════════════════════════════════════════════════════
// AC 2 — extraction survives a syntactically invalid but COMPLETE reply
// ════════════════════════════════════════════════════════════════════════════

test("#93 AC2: salvageCandidateArray recovers 29 of 30 from the complete-but-malformed shape", () => {
  const s = salvageCandidateArray(malformedCompleteReply(30, 7));
  assert.equal(s.parsedDirectly, false);
  assert.equal(s.salvaged, true);
  assert.equal(s.objects.length, 29);
  assert.equal(s.dropped, 1);
  assert.match(s.error, /Expected ',' or '}'/);
  assert.equal(s.objects[0].text, "idea number 0 for the brief");
  assert.ok(!s.objects.some((o) => o.text.includes("number 7")));
});

test("#93 AC2: salvageCandidateArray recovers every complete object from a truncated reply", () => {
  const s = salvageCandidateArray(truncatedReply(28));
  assert.equal(s.objects.length, 28);
  assert.equal(s.dropped, 1); // the cut-off trailing object
  assert.equal(s.salvaged, true);
});

test("#93 AC2: a clean reply is passed through untouched (the happy path is not perturbed)", () => {
  const s = salvageCandidateArray(cleanReply(30));
  assert.equal(s.parsedDirectly, true);
  assert.equal(s.salvaged, false);
  assert.equal(s.dropped, 0);
  assert.equal(s.objects.length, 30);
});

test("#93 AC2: salvage is string-aware — braces and brackets inside an idea are not read as structure", () => {
  const reply = '[{"text": "use the {curly} form, see [beta] docs"},{"text": "escaped \\" quote and a } brace"}]';
  const s = salvageCandidateArray(reply);
  assert.equal(s.parsedDirectly, true);
  assert.equal(s.objects.length, 2);

  // Same content, but truncated: the char-walk must still recover the first
  // object rather than mis-trimming at the ']' inside the idea's own prose.
  const cut = '[{"text": "use the {curly} form, see [beta] docs"},{"text": "escaped';
  const t = salvageCandidateArray(cut);
  assert.equal(t.objects.length, 1);
  assert.equal(t.objects[0].text, "use the {curly} form, see [beta] docs");
});

test("#93 AC2: salvage tolerates a markdown fence and surrounding prose", () => {
  assert.equal(salvageCandidateArray('```json\n[{"text":"a"}]\n```').objects.length, 1);
  assert.equal(salvageCandidateArray('Sure! Here they are:\n[{"text":"a"},{"text":"b"}]\nHope that helps.').objects.length, 2);
  assert.deepEqual(salvageCandidateArray("").objects, []);
  assert.deepEqual(salvageCandidateArray(undefined).objects, []);
  assert.deepEqual(salvageCandidateArray("I'd rather not answer that.").objects, []);
});

test("#93 AC2 (the AC itself): arm A's complete-but-malformed reply now COMPLETES with 29 of 30 ideas", async () => {
  // Before #93 this cell classified `empty_pool` and the whole paid pool was
  // discarded: ideate-core parses the reply as ONE document, so object #7's
  // missing comma took all 30 ideas with it. The fake ideateImpl above
  // reproduces that contract exactly — so this test fails without salvage.
  const resp = await runArm(
    "A",
    anthropicBatchFetch({ reply: malformedCompleteReply(30, 7), stopReason: "end_turn", usage: { input_tokens: 100, output_tokens: 1833 } }),
  );
  assert.equal(resp.terminalState, "completed");
  assert.equal(resp.result.candidates.length, 29);
  assert.equal(resp.diagnostics.length, 1);
  assert.equal(resp.diagnostics[0].parse, "salvaged");
  assert.equal(resp.diagnostics[0].stopReason, "end_turn");
  assert.equal(resp.diagnostics[0].truncated, false);
  assert.equal(resp.diagnostics[0].droppedCount, 1);
});

test("#93 AC2: arm A's TRUNCATED reply completes with a short pool rather than losing the cell", async () => {
  const resp = await runArm(
    "A",
    anthropicBatchFetch({ reply: truncatedReply(28), stopReason: "max_tokens", usage: { input_tokens: 100, output_tokens: 2048 } }),
  );
  assert.equal(resp.terminalState, "completed");
  assert.equal(resp.result.candidates.length, 28);
  // Still recorded as truncated — a short pool is recovered, not excused.
  assert.equal(resp.diagnostics[0].truncated, true);
  assert.equal(resp.diagnostics[0].stopReason, "max_tokens");
  assert.equal(resp.diagnostics[0].outputTokens, 2048);
});

test("#93: a clean reply reaches ideate-core byte-for-byte (no re-serialization on the happy path)", async () => {
  const seen = [];
  const provider = new AnthropicBatchProvider({
    apiKey: "test-key",
    corpus: CORPUS,
    armsConfig: armsConfigFor("A"),
    fetchImpl: anthropicBatchFetch({ reply: cleanReply(30) }),
    ideateImpl: async (input, deps) => {
      const res = await deps.complete({ model: "claude-sonnet-5", prompt: "p" });
      seen.push(res.text);
      return { candidates: [{ text: "x" }], agents: deps.agents, meta: { agentsAttempted: 1, agentsFailed: 0 } };
    },
    sleep: noopSleep,
    logger: silentLogger,
  });
  await provider.generate(cellFor("A"), armsConfigJson.arms.A, { mode: "batch" });
  assert.equal(seen[0], cleanReply(30));
});

// ════════════════════════════════════════════════════════════════════════════
// AC 3 — stop_reason and enough raw reply are retained; truncated vs
//        unparseable are DISTINGUISHABLE in the ledger
// ════════════════════════════════════════════════════════════════════════════

/** A reply that is unrecoverable: no object ever closes. */
const HOPELESS_TRUNCATED = '[{"text": "an idea that was cut off immediately';
/** Complete (end_turn) but nothing parseable at all. */
const HOPELESS_MALFORMED = "[{text: idea one, text: idea two}]";

test("#93 AC3: a truncated total loss classifies parse_failure with cause=truncated in the detail", async () => {
  const resp = await runArm(
    "A",
    anthropicBatchFetch({ reply: HOPELESS_TRUNCATED, stopReason: "max_tokens", usage: { input_tokens: 100, output_tokens: 2048 } }),
  );
  assert.equal(resp.terminalState, "failed");
  assert.equal(resp.failureKind, "parse_failure"); // NOT empty_pool
  assert.match(resp.detail, /cause=truncated/);
  assert.match(resp.detail, /truncated=1/);
  assert.match(resp.detail, /unparseable=0/);
  assert.match(resp.detail, /sample_stop_reason=max_tokens/);
  assert.match(resp.detail, /sample_output_tokens=2048/);
  // Enough of the raw reply to diagnose without a paid re-run.
  assert.match(resp.detail, /sample_head=/);
  assert.ok(resp.detail.includes("cut off immediately"));
});

test("#93 AC3: a complete-but-unparseable total loss classifies parse_failure with cause=unparseable_complete", async () => {
  const resp = await runArm(
    "A",
    anthropicBatchFetch({ reply: HOPELESS_MALFORMED, stopReason: "end_turn", usage: { input_tokens: 100, output_tokens: 1833 } }),
  );
  assert.equal(resp.terminalState, "failed");
  assert.equal(resp.failureKind, "parse_failure");
  assert.match(resp.detail, /cause=unparseable_complete/);
  assert.match(resp.detail, /truncated=0/);
  assert.match(resp.detail, /unparseable=1/);
  assert.match(resp.detail, /sample_stop_reason=end_turn/);
  assert.match(resp.detail, /sample_parse_error="/);
});

test("#93 AC3: a genuinely empty pool still classifies empty_pool with cause=genuinely_empty", async () => {
  const resp = await runArm("A", anthropicBatchFetch({ reply: "[]", stopReason: "end_turn", usage: { input_tokens: 100, output_tokens: 12 } }));
  assert.equal(resp.terminalState, "failed");
  assert.equal(resp.failureKind, "empty_pool");
  assert.match(resp.detail, /cause=genuinely_empty/);
  assert.match(resp.detail, /empty_valid=1/);
});

test("#93 AC3 (the AC itself): the three empty-pool causes produce three DIFFERENT ledger details", async () => {
  const details = [];
  for (const [reply, stopReason] of [
    [HOPELESS_TRUNCATED, "max_tokens"],
    [HOPELESS_MALFORMED, "end_turn"],
    ["[]", "end_turn"],
  ]) {
    const resp = await runArm("A", anthropicBatchFetch({ reply, stopReason }));
    details.push(resp.detail);
  }
  assert.equal(new Set(details).size, 3, "truncated / unparseable / genuinely-empty must be distinguishable");
  // Before #93 all three produced the literal string below, with no way to
  // tell them apart — which is why diagnosing this required a paid probe.
  for (const d of details) assert.notEqual(d, "AnthropicBatchProvider: ideateCore returned an empty candidate pool");
});

test("#93 AC3: the detail stays single-line, bounded, and greppable even for a pathological reply", () => {
  const huge = `[{"text": "${"x".repeat(50000)}\nwith\na\nnewline and a \\" quote`;
  const diag = summarizeReply({
    model: "claude-sonnet-5",
    stopReason: "max_tokens",
    usage: { output_tokens: 2048 },
    text: huge,
    salvage: salvageCandidateArray(huge),
  });
  const { detail } = classifyPoolFailure([diag], { providerName: "AnthropicBatchProvider" });
  assert.ok(detail.length <= MAX_DETAIL_CHARS, `detail was ${detail.length} chars`);
  assert.ok(!detail.includes("\n"), "raw newlines would break a line-oriented grep over the ledger");
  assert.match(detail, /^AnthropicBatchProvider: .* cause=truncated kind=parse_failure replies=1 /);
});

test("#93 AC3: transport-level signals still outrank the new reply-level classification", async () => {
  // A rate-limited batch must still report rate_limited, not parse_failure —
  // pickFailureKind's precedence is unchanged by #93.
  const provider = new AnthropicBatchProvider({
    apiKey: "test-key",
    corpus: CORPUS,
    armsConfig: armsConfigFor("A"),
    fetchImpl: async () => ({ ok: false, status: 429, json: async () => ({}), text: async () => "" }),
    ideateImpl: ideateImplLikeIdeateCore,
    sleep: noopSleep,
    logger: silentLogger,
    maxRetries: 0,
  });
  const resp = await provider.generate(cellFor("A"), armsConfigJson.arms.A, { mode: "batch" });
  assert.equal(resp.terminalState, "failed");
  assert.equal(resp.failureKind, "rate_limited");
});

test("#93 AC3: classifyPoolFailure reports refusal when every reply was a refusal", () => {
  const diag = summarizeReply({ model: "m", stopReason: "refusal", usage: {}, text: "", salvage: salvageCandidateArray("") });
  const out = classifyPoolFailure([diag], { providerName: "p" });
  assert.equal(out.kind, "refusal");
  assert.equal(out.cause, "refusal");
});

test("#93 AC3: classifyPoolFailure with no replies at all falls back to empty_pool/no_replies", () => {
  const out = classifyPoolFailure([], { providerName: "p" });
  assert.equal(out.kind, "empty_pool");
  assert.equal(out.cause, "no_replies");
  assert.match(out.detail, /replies=0/);
});

test("#93 AC3: ideate-core's allRefused signal keeps its pre-#93 meaning, but loses to a specific reply-level cause", () => {
  // Pre-#93, agentsFailed === agentsAttempted classified `refusal`. That must
  // survive when there is nothing more specific...
  assert.equal(classifyPoolFailure([], { allRefused: true }).kind, "refusal");
  assert.equal(classifyPoolFailure([], { allRefused: true }).cause, "agents_all_failed");

  // ...and must lose to truncation, which is strictly more specific and more
  // actionable: "every agent failed" is a symptom, "the reply was cut off at
  // max_tokens" is the cause.
  const truncatedDiag = summarizeReply({
    model: "m",
    stopReason: "max_tokens",
    usage: { output_tokens: 2048 },
    text: HOPELESS_TRUNCATED,
    salvage: salvageCandidateArray(HOPELESS_TRUNCATED),
  });
  const out = classifyPoolFailure([truncatedDiag], { allRefused: true });
  assert.equal(out.kind, "parse_failure");
  assert.equal(out.cause, "truncated");
});

// ════════════════════════════════════════════════════════════════════════════
// The mirrored OpenAI change (arms G/H were never exercised by the #8 study)
// ════════════════════════════════════════════════════════════════════════════

test("#93 OpenAI: finish_reason is normalized to the Anthropic stop_reason vocabulary", () => {
  // Without this, `truncated: stopReason === "max_tokens"` would never fire on
  // the OpenAI path and the mirrored fix would detect nothing.
  assert.equal(normalizeOpenAIFinishReason({ choices: [{ finish_reason: "length" }] }), "max_tokens");
  assert.equal(normalizeOpenAIFinishReason({ choices: [{ finish_reason: "content_filter" }] }), "refusal");
  assert.equal(normalizeOpenAIFinishReason({ choices: [{ finish_reason: "stop" }] }), "end_turn");
  assert.equal(normalizeOpenAIFinishReason({ choices: [{ finish_reason: "tool_calls" }] }), "tool_calls");
  assert.equal(normalizeOpenAIFinishReason({}), null);
  assert.equal(normalizeOpenAIFinishReason(undefined), null);
});

/**
 * Single-mode OpenAI transport fake. `#completeBatched` applies the SAME
 * `withCellMaxTokens(entry.req, entry.ctx.cellMaxTokens)` call, so single mode
 * is the compact way to pin the request shape without faking a multipart
 * file upload.
 */
function openaiSingleFetch({ reply, finishReason = "stop", capture = {} }) {
  return async (url, opts) => {
    capture.body = JSON.parse(opts.body);
    return jsonResponse(200, {
      choices: [{ finish_reason: finishReason, message: { content: reply } }],
      usage: { prompt_tokens: 100, completion_tokens: 1833 },
    });
  };
}

function openaiProvider(armId, fetchImpl) {
  return new OpenAIBatchProvider({
    apiKey: "test-key",
    corpus: CORPUS,
    armsConfig: armsConfigFor(armId),
    fetchImpl,
    ideateImpl: ideateImplLikeIdeateCore,
    sleep: noopSleep,
    logger: silentLogger,
  });
}

test("#93/#122 OpenAI: a panel arm requests its model's computed ceiling (gpt-5.6-terra is unmeasured -> the generous fallback)", async () => {
  const capture = {};
  const resp = await openaiProvider("H", openaiSingleFetch({ reply: cleanReply(6), capture })).generate(
    cellFor("H"),
    armsConfigJson.arms.H,
    { mode: "single" },
  );
  assert.equal(resp.terminalState, "completed");
  assert.equal(capture.body.max_completion_tokens, maxTokensForIdeas(6, "gpt-5.6-terra"));
});

test("#93 OpenAI: a solo-shaped arm gets the scaled ceiling, and salvage + truncation detection both work", async () => {
  // arms.config.json has no OpenAI solo arm (and must not be edited), so drive
  // the OpenAI provider with arm A's SHAPE — the sizing and diagnostics code is
  // provider-agnostic and this is what proves the mirror is real, not cosmetic.
  const capture = {};
  const resp = await openaiProvider("A", openaiSingleFetch({ reply: truncatedReply(28), finishReason: "length", capture })).generate(
    cellFor("A"),
    armsConfigJson.arms.A,
    { mode: "single" },
  );
  assert.equal(capture.body.max_completion_tokens, maxTokensForIdeas(30, "claude-sonnet-5"));
  assert.equal(resp.terminalState, "completed");
  assert.equal(resp.result.candidates.length, 28);
  assert.equal(resp.diagnostics[0].truncated, true);
  assert.equal(resp.diagnostics[0].stopReason, "max_tokens");
});

test("#93 OpenAI: an unrecoverable truncated reply classifies parse_failure/cause=truncated too", async () => {
  const resp = await openaiProvider("A", openaiSingleFetch({ reply: HOPELESS_TRUNCATED, finishReason: "length" })).generate(
    cellFor("A"),
    armsConfigJson.arms.A,
    { mode: "single" },
  );
  assert.equal(resp.failureKind, "parse_failure");
  assert.match(resp.detail, /^OpenAIBatchProvider: /);
  assert.match(resp.detail, /cause=truncated/);
});

// ════════════════════════════════════════════════════════════════════════════
// Comparability — promptTemplateHash
// ════════════════════════════════════════════════════════════════════════════

test("#93 comparability: promptTemplateHash is a real, stable sha256/12 hash — not the literal 'unpinned'", () => {
  const h = promptTemplateHash();
  assert.match(h, /^[0-9a-f]{12}$/);
  assert.notEqual(h, "unpinned");
  assert.equal(h, promptTemplateHash(), "must be deterministic across calls");
});

test("#93 comparability: promptTemplateHash covers prompt TEXT, the sizing constants and SALVAGE_VERSION", async () => {
  // The hash is computed over a JSON payload assembled from those inputs, so
  // rather than mutating module constants (impossible for an ESM export), this
  // pins that every one of them is actually IN the payload: recomputing the
  // documented payload by hand must reproduce the exported hash, and perturbing
  // any single field must change it.
  const { createHash } = await import("node:crypto");
  const prompts = await import("./prompts.mjs");
  const probe = {
    context: { slug: "hash-probe", brief: "HASH PROBE BRIEF" },
    persona: "hash_probe_persona",
    stance: "HASH PROBE STANCE",
    ideasPerAgent: 7,
    seeds: [{ text: "hash probe seed" }],
    buildOnDirective: "HASH PROBE DIRECTIVE",
  };
  const fields = {
    round1: prompts.buildRound1Prompt(probe),
    round2: prompts.buildRound2Prompt(probe),
    round1Defaults: prompts.buildRound1Prompt(),
    round2Defaults: prompts.buildRound2Prompt(),
    tokensPerIdeaByModel: prompts.TOKENS_PER_IDEA_BY_MODEL,
    defaultTokensPerIdea: prompts.DEFAULT_TOKENS_PER_IDEA,
    maxTokensHeadroom: prompts.MAX_TOKENS_HEADROOM,
    legacyMaxTokens: prompts.LEGACY_MAX_TOKENS,
    salvageVersion: prompts.SALVAGE_VERSION,
  };
  const hashOf = (o) => createHash("sha256").update(JSON.stringify(o)).digest("hex").slice(0, 12);
  assert.equal(hashOf(fields), promptTemplateHash());

  for (const key of Object.keys(fields)) {
    const perturbed = { ...fields, [key]: `${JSON.stringify(fields[key])}-perturbed` };
    assert.notEqual(hashOf(perturbed), promptTemplateHash(), `changing ${key} must move the hash`);
  }
});
