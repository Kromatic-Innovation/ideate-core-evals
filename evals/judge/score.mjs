// score.mjs — the judge's LIVE scoring call (issue #21).
//
// ── The seam #4 left ────────────────────────────────────────────────────────
// #4 (PR #18) built everything AROUND the scoring step and nothing that does
// it: prompt.mjs (the frozen, hashed rubric), deidentify.mjs (strip generator
// identity), order.mjs (seeded presentation-order randomization), matrix.mjs
// (the cross-judge schedule), distinct.mjs (assertEvaluatorDistinct), gate.mjs
// (validateJudge, which takes `judgeScores` as an INPUT array). Nothing in that
// list calls a model. `validateJudge` cannot be exercised because there is no
// code path that turns a de-identified, order-randomized pool into scores. This
// module is that path: assembleJudgePayload -> per-axis scores in the store, via
// a real model call.
//
// ── Reuse, don't reinvent (the issue's own instruction) ─────────────────────
// "Reuse the generation adapter's provider interface and its batch path where
// possible — judging is 2 judges x N pools and is the larger half of the
// projected spend, so batch it." AnthropicJudgeProvider therefore drives the
// SAME Anthropic Messages / Message Batches transport as
// evals/harness/provider.mjs's AnthropicBatchProvider — the shared helpers
// (buildAnthropicMessageParams, anthropicHeaders, anthropicFetchWithRetry,
// extractAnthropicText, classify*) are imported from there, not copied. In
// particular buildAnthropicMessageParams FORCE-STRIPS sampling params for every
// model (§3.3), so a judge call can never reintroduce the confound the
// generation path eliminated. Every seam that would touch the network
// (fetchImpl) or a timer (sleep) is injectable with a live default, so the
// tests run with zero network and an empty node_modules — the hermetic-CI
// invariant the rest of this repo depends on.
//
// ── §5.3 hygiene, end to end ────────────────────────────────────────────────
// A live judge call MUST preserve every control #4 built:
//   - de-identify: the payload comes from assembleJudgePayload (deidentifyPool),
//     so no arm/model/persona label reaches the judge — text only.
//   - order-randomize: candidates are presented in a seeded, replayable
//     permutation (order.mjs), so presentation position is not a systematic
//     signal. Scores are mapped BACK to input order before returning, so a
//     caller never has to know the presentation order.
//   - frozen hashed prompt: the rubric text is JUDGE_PROMPT (prompt.mjs), and
//     the judge model id + JUDGE_PROMPT's hash feed configHash via computeJudgeHash
//     — a changed rubric or a changed judge model gives cells a different
//     cellKey and can never be silently pooled (§5.3, §11).
//   - score-only: the prompt asks for the 2-axis JSON object and nothing else;
//     novelty (originality) and feasibility stay SEPARATE axes and are never
//     averaged (assertAxesNotCollapsed is re-run on every parsed score).
//
// ── Never throws for a transport/parse failure ──────────────────────────────
// Like the generation adapter, score() classifies every catchable failure into
// lib/accounting.mjs's FAILURE_KINDS and RETURNS it (terminalState "failed")
// rather than throwing — a judge transport error is a datum, not a crash, and
// must be distinguishable from a genuine harness bug (harness_error).

import { createHash } from "node:crypto";

import { JUDGE_PROMPT, JUDGE_AXES, assertAxesNotCollapsed, judgePromptHash } from "./prompt.mjs";
import { assembleJudgePayload } from "./deidentify.mjs";
import { orderCandidates } from "./order.mjs";
import { assertEvaluatorDistinct } from "./distinct.mjs";
import { buildJudgeMatrix } from "./matrix.mjs";
import { meterJudgeCall } from "./gate.mjs";
import { priceRowsByProvider, RATE_TABLE as DEFAULT_RATE_TABLE } from "../../lib/price.mjs";
import {
  buildAnthropicMessageParams,
  anthropicHeaders,
  anthropicFetchWithRetry,
  extractAnthropicText,
  classifyTransportOutcome,
  classifyTransportKind,
  pickFailureKind,
} from "../harness/provider.mjs";

/** A score-only reply is a tiny JSON object; 256 tokens is generous headroom
 *  for `{"originality":n,"feasibility":n}` even
 *  with whitespace, and small enough that a model tempted to "explain" its
 *  score runs out of room rather than producing reasoning-then-score drift the
 *  §5 rubric forbids. */
export const MAX_JUDGE_TOKENS = 256;

/** Judge scores are on the rubric's 1-10 scale (prompt.mjs JUDGE_PROMPT). */
const AXIS_MIN = 1;
const AXIS_MAX = 10;

/**
 * Build the score-only judge prompt for ONE candidate against ONE brief, from
 * the frozen JUDGE_PROMPT (prompt.mjs). Deliberately assembles the rubric text
 * from the frozen object rather than restating it inline, so the wording the
 * model sees is exactly what judgePromptHash() hashes — there is no second copy
 * of the rubric to drift out of sync with the hash.
 *
 * @param {string} briefText      the research brief the idea responds to
 * @param {string} candidateText  the (already de-identified) idea text
 * @returns {string}
 */
export function buildJudgeScoringPrompt(briefText, candidateText) {
  if (typeof briefText !== "string" || briefText.length === 0) {
    throw new Error("buildJudgeScoringPrompt: briefText must be a non-empty string");
  }
  if (typeof candidateText !== "string" || candidateText.length === 0) {
    throw new Error("buildJudgeScoringPrompt: candidateText must be a non-empty string");
  }
  const axisLines = JUDGE_AXES.map((axis) => {
    const a = JUDGE_PROMPT.axes[axis];
    return `- ${a.label} (${axis}): ${a.definition}`;
  }).join("\n");

  return (
    `${JUDGE_PROMPT.instructions}\n\n` +
    `RESEARCH BRIEF:\n${briefText}\n\n` +
    `AXES (score each independently, 1-10):\n${axisLines}\n\n` +
    `CANDIDATE IDEA:\n${candidateText}\n\n` +
    `${JUDGE_PROMPT.outputFormat}\n` +
    `Reply with ONLY that JSON object — no surrounding prose, no markdown fence, no combined score.`
  );
}

/**
 * Parse a judge reply into a per-axis score object, validating it hard:
 *   - JSON object (a leading/trailing ```json fence is tolerated and stripped —
 *     a live model occasionally wraps JSON despite the instruction);
 *   - every JUDGE_AXES entry present as distinct numeric fields (never a collapsed
 *     scalar — assertAxesNotCollapsed enforces the §4.3/§5 novelty!=feasibility
 *     rule);
 *   - every axis a finite number within [1, 10].
 * Throws on any violation; the caller turns that into a classified `parse_failure`
 * (never a thrown transport error).
 *
 * @param {string} text  the model's reply text
 * @returns {{originality:number, feasibility:number}}
 */
export function parseAxisScores(text) {
  if (typeof text !== "string" || text.trim().length === 0) {
    throw new Error("parseAxisScores: empty judge reply");
  }
  let stripped = text.trim();
  // Tolerate a ```json ... ``` (or bare ``` ... ```) fence a live model may add.
  const fence = stripped.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence) stripped = fence[1].trim();

  let obj;
  try {
    obj = JSON.parse(stripped);
  } catch (err) {
    throw new Error(`parseAxisScores: reply is not valid JSON: ${err && err.message}`);
  }
  // Reject the collapsed-scalar / missing-axis shapes BEFORE reading values —
  // this is the same guard the rubric (prompt.mjs) exports so a judge reply can
  // never smuggle in an averaged novelty/feasibility number.
  assertAxesNotCollapsed(obj);

  const scores = {};
  for (const axis of JUDGE_AXES) {
    const v = obj[axis];
    if (typeof v !== "number" || !Number.isFinite(v)) {
      throw new Error(`parseAxisScores: axis '${axis}' must be a finite number, got ${JSON.stringify(v)}`);
    }
    if (v < AXIS_MIN || v > AXIS_MAX) {
      throw new Error(`parseAxisScores: axis '${axis}' = ${v} is outside the [${AXIS_MIN}, ${AXIS_MAX}] rubric scale`);
    }
    scores[axis] = v;
  }
  return scores;
}

/**
 * Turn a payload into per-candidate judge requests, in a seeded RANDOMIZED
 * presentation order (order.mjs), each tagged with its ORIGINAL index so the
 * scores can be mapped back to input order regardless of presentation order or
 * (in batch mode) the arbitrary order results come back in.
 *
 * @param {{briefText: string, candidates: Array<{text:string}>}} payload
 * @param {number} seed  explicit integer seed (order.mjs requires it)
 * @returns {Array<{origIndex:number, customId:string, prompt:string}>} presentation-ordered
 */
function buildJudgeRequests(payload, seed) {
  const { briefText, candidates } = payload;
  // Randomize the ORDER of indices, not the candidates themselves, so the
  // original index survives the shuffle and the scores can be un-permuted.
  const presentation = orderCandidates(
    candidates.map((_, i) => i),
    seed,
  );
  return presentation.map((origIndex) => ({
    origIndex,
    customId: `cand-${origIndex}`,
    prompt: buildJudgeScoringPrompt(briefText, candidates[origIndex].text),
  }));
}

/** Sum a usage object into a { input_tokens, output_tokens, ... } accumulator. */
function addUsageInto(acc, usage) {
  if (!usage) return;
  acc.input_tokens += usage.input_tokens || 0;
  acc.output_tokens += usage.output_tokens || 0;
  if (usage.cache_read_input_tokens) acc.cache_read_input_tokens = (acc.cache_read_input_tokens || 0) + usage.cache_read_input_tokens;
  if (usage.cache_creation_input_tokens) acc.cache_creation_input_tokens = (acc.cache_creation_input_tokens || 0) + usage.cache_creation_input_tokens;
}

/**
 * AnthropicJudgeProvider — the real judge scorer for `claude-*` judge models.
 *
 * `score(payload, opts)` returns, mirroring the generation interface:
 *   { terminalState: "completed"|"failed", scores?, tokens, failureKind?, detail? }
 *     scores  : on completed — an array aligned to payload.candidates INPUT order,
 *               each { originality, feasibility } in [1,10].
 *     tokens  : { model: judgeModel, input_tokens, output_tokens, ... } — one
 *               judge model per call, so the single-model costRow shape (not
 *               tokens_by_model). Present even on failure (whatever was consumed).
 *     failureKind : on failed — a FAILURE_KINDS value.
 * Never throws for a transport/parse failure.
 */
export class AnthropicJudgeProvider {
  /**
   * @param {object} [opts]
   *   @param {string}   [opts.apiKey]        defaults to ANTHROPIC_API_KEY; a
   *     missing key returns a classified harness_error on the first call rather
   *     than throwing (mirrors AnthropicBatchProvider — safe to construct directly).
   *   @param {typeof fetch} [opts.fetchImpl] injected in tests; defaults to global fetch.
   *   @param {Function} [opts.sleep]         (ms)=>Promise; injectable for instant retry/poll tests.
   *   @param {number}   [opts.pollIntervalMs] batch-poll interval (live default 2000ms).
   *   @param {number}   [opts.maxPollMs]      poll ceiling before classifying `timeout` (live default 15 min).
   *   @param {number}   [opts.maxRetries]     429/5xx retry budget (default 3).
   *   @param {(msg:string)=>void} [opts.logger] defaults to console.error; tests inject a silent logger.
   */
  constructor({
    apiKey = process.env.ANTHROPIC_API_KEY,
    fetchImpl = globalThis.fetch,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    pollIntervalMs = 2000,
    maxPollMs = 15 * 60 * 1000,
    maxRetries = 3,
    logger = (msg) => console.error(msg),
  } = {}) {
    this.apiKey = apiKey;
    this.fetchImpl = fetchImpl;
    this.sleep = sleep;
    this.pollIntervalMs = pollIntervalMs;
    this.maxPollMs = maxPollMs;
    this.maxRetries = maxRetries;
    this.logger = logger;
  }

  /**
   * @param {{briefText:string, candidates:Array<{text:string}>}} payload  from assembleJudgePayload
   * @param {object} opts
   *   @param {string}  opts.judgeModel  the judge model id (a `claude-*` id here)
   *   @param {"batch"|"single"} [opts.mode]  batch-first, like the generation path
   *   @param {number}  opts.seed        explicit integer seed for presentation order
   *   @param {string}  [opts.timestamp] ISO 8601, forwarded for symmetry (unused in the call itself)
   */
  async score(payload, { judgeModel, mode = "batch", seed } = {}) {
    const tokens = { model: judgeModel, input_tokens: 0, output_tokens: 0 };
    if (!this.apiKey) {
      return { terminalState: "failed", failureKind: "harness_error", detail: "AnthropicJudgeProvider: no apiKey (ANTHROPIC_API_KEY unset) — refusing to call the network with no credential", tokens };
    }
    if (!judgeModel || typeof judgeModel !== "string") {
      return { terminalState: "failed", failureKind: "harness_error", detail: "AnthropicJudgeProvider: judgeModel is required", tokens };
    }
    if (!payload || !Array.isArray(payload.candidates)) {
      return { terminalState: "failed", failureKind: "harness_error", detail: "AnthropicJudgeProvider: payload.candidates must be an array (from assembleJudgePayload)", tokens };
    }
    if (payload.candidates.length === 0) {
      // Nothing to score — the upstream pool was empty. Classified, not thrown,
      // so it reconciles like any other cell rather than crashing the matrix.
      return { terminalState: "failed", failureKind: "empty_pool", detail: "AnthropicJudgeProvider: empty candidate pool — nothing to score", tokens };
    }
    if (!Number.isInteger(seed)) {
      return { terminalState: "failed", failureKind: "harness_error", detail: `AnthropicJudgeProvider: seed must be an explicit integer (an unseeded presentation order can't be replayed), got ${JSON.stringify(seed)}`, tokens };
    }

    let requests;
    try {
      requests = buildJudgeRequests(payload, seed);
    } catch (err) {
      return { terminalState: "failed", failureKind: "harness_error", detail: `AnthropicJudgeProvider: could not build judge requests: ${err && err.message}`, tokens };
    }

    const classification = { transportError: false, rateLimited: false, timedOut: false };
    // origIndex -> reply text (or a marker), collected in whatever order calls resolve.
    const replies = new Map();
    try {
      if (mode === "single") {
        await this.#scoreSingle(requests, judgeModel, { tokens, classification, replies });
      } else {
        await this.#scoreBatched(requests, judgeModel, { tokens, classification, replies });
      }
    } catch (err) {
      // Any escape from the transport layer is our bug (the helpers are
      // no-throw), so classify it rather than crashing the matrix.
      return { terminalState: "failed", failureKind: pickFailureKind(classification, "harness_error"), detail: `AnthropicJudgeProvider: ${err && err.message}`, tokens };
    }

    // A transport failure on ANY candidate fails the whole pool's scoring: a
    // partially-scored pool is exactly the silent-truncation bias the rest of
    // this harness refuses (a mean over "the candidates that happened to score"
    // is a biased sample). Report the most specific classification observed.
    if (replies.size < requests.length) {
      return { terminalState: "failed", failureKind: pickFailureKind(classification, "transport_error"), detail: `AnthropicJudgeProvider: only ${replies.size}/${requests.length} candidates returned a reply`, tokens };
    }

    // Parse every reply; any unparseable/collapsed reply fails the pool with a
    // classified parse_failure (never a thrown error), tokens preserved.
    const scores = new Array(requests.length);
    for (let i = 0; i < requests.length; i++) {
      const origIndex = i; // scores are stored in INPUT order (un-permuted)
      const replyText = replies.get(origIndex);
      try {
        scores[origIndex] = parseAxisScores(replyText);
      } catch (err) {
        return { terminalState: "failed", failureKind: "parse_failure", detail: `AnthropicJudgeProvider: candidate ${origIndex} — ${err && err.message}`, tokens };
      }
    }

    return { terminalState: "completed", scores, tokens };
  }

  // ── single mode: one POST /v1/messages per candidate ────────────────────────
  async #scoreSingle(requests, judgeModel, { tokens, classification, replies }) {
    await Promise.all(
      requests.map(async (req) => {
        const params = buildAnthropicMessageParams({ model: judgeModel, prompt: req.prompt, maxTokens: MAX_JUDGE_TOKENS });
        const { ok, status, json, error } = await anthropicFetchWithRetry(
          this.fetchImpl,
          "https://api.anthropic.com/v1/messages",
          anthropicHeaders(this.apiKey),
          params,
          { maxRetries: this.maxRetries, sleep: this.sleep, logger: this.logger },
        );
        if (!ok) {
          classifyTransportOutcome(status, error, classification);
          return; // absent from `replies` — counted as a missing reply above
        }
        addUsageInto(tokens, json && json.usage);
        // A refusal (stop_reason "refusal", no text) yields an empty reply here,
        // which parseAxisScores rejects as a parse_failure below — the pool's
        // scoring fails, classified, rather than silently scoring a refusal as 0s.
        replies.set(req.origIndex, extractAnthropicText(json));
      }),
    );
  }

  // ── batch mode: submit all candidate requests as ONE Message Batch ─────────
  async #scoreBatched(requests, judgeModel, { tokens, classification, replies }) {
    const batchRequests = requests.map((req) => ({
      custom_id: req.customId,
      params: buildAnthropicMessageParams({ model: judgeModel, prompt: req.prompt, maxTokens: MAX_JUDGE_TOKENS }),
    }));
    const byCustomId = new Map(requests.map((req) => [req.customId, req]));

    const submit = await anthropicFetchWithRetry(
      this.fetchImpl,
      "https://api.anthropic.com/v1/messages/batches",
      anthropicHeaders(this.apiKey),
      { requests: batchRequests },
      { maxRetries: this.maxRetries, sleep: this.sleep, logger: this.logger },
    );
    if (!submit.ok) {
      classifyTransportOutcome(submit.status, submit.error, classification);
      return;
    }

    const batchId = submit.json.id;
    const deadline = Date.now() + this.maxPollMs;
    let batchStatus = submit.json;
    while (batchStatus.processing_status !== "ended") {
      if (Date.now() > deadline) {
        classification.timedOut = true;
        return;
      }
      await this.sleep(this.pollIntervalMs);
      const poll = await anthropicFetchWithRetry(
        this.fetchImpl,
        `https://api.anthropic.com/v1/messages/batches/${batchId}`,
        anthropicHeaders(this.apiKey),
        undefined,
        { method: "GET", maxRetries: this.maxRetries, sleep: this.sleep, logger: this.logger },
      );
      if (!poll.ok) {
        classifyTransportOutcome(poll.status, poll.error, classification);
        return;
      }
      batchStatus = poll.json;
    }

    const results = await anthropicFetchWithRetry(
      this.fetchImpl,
      batchStatus.results_url,
      anthropicHeaders(this.apiKey),
      undefined,
      { method: "GET", raw: true, maxRetries: this.maxRetries, sleep: this.sleep, logger: this.logger },
    );
    if (!results.ok) {
      classifyTransportOutcome(results.status, results.error, classification);
      return;
    }

    // JSONL, one line per custom_id in ARBITRARY order — key by custom_id, never
    // by line position (same requirement as the generation batch path).
    for (const line of results.text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let row;
      try {
        row = JSON.parse(trimmed);
      } catch {
        continue; // a malformed JSONL line is a per-result hiccup, not a whole-batch failure
      }
      const req = byCustomId.get(row.custom_id);
      if (!req) continue;
      if (row.result && row.result.type === "succeeded") {
        const message = row.result.message;
        addUsageInto(tokens, message && message.usage);
        replies.set(req.origIndex, extractAnthropicText(message));
      } else if (row.result && row.result.type === "errored") {
        const err = row.result.error || {};
        if (err.type === "rate_limit_error") classification.rateLimited = true;
        else classification.transportError = true;
        // absent from `replies` — a missing reply, classified above
      } else {
        classification.transportError = true;
      }
    }
  }
}

/**
 * MockJudgeProvider — the hermetic double for runJudgeMatrix tests. No network.
 * Records every call (a spy the matrix tests assert against) and returns
 * deterministic per-axis scores, so a test can prove the matrix executed both
 * legs and enforced distinctness without going near the Anthropic transport.
 *
 * @param {object} [opts]
 *   @param {(candidateText:string, ctx:{judgeModel:string, index:number}) => object} [opts.scoreFor]
 *     returns the axis-score object for one candidate; defaults to a fixed valid score.
 *   @param {Map<string, object>} [opts.failFor]  judgeModel -> { failureKind } to force a failure.
 */
export class MockJudgeProvider {
  constructor({ scoreFor, failFor = new Map() } = {}) {
    this.scoreFor = scoreFor || (() => ({ originality: 5, feasibility: 4 }));
    this.failFor = failFor;
    this.calls = [];
  }

  async score(payload, { judgeModel, mode = "batch", seed } = {}) {
    this.calls.push({ judgeModel, mode, seed, n: payload && payload.candidates ? payload.candidates.length : 0 });
    const tokens = { model: judgeModel, input_tokens: 10 * (payload.candidates.length || 0), output_tokens: 5 * (payload.candidates.length || 0) };
    const forced = this.failFor.get(judgeModel);
    if (forced) return { terminalState: "failed", failureKind: forced.failureKind, detail: `MockJudgeProvider: forced ${forced.failureKind}`, tokens };
    const scores = payload.candidates.map((c, index) => this.scoreFor(c.text, { judgeModel, index }));
    return { terminalState: "completed", scores, tokens };
  }
}

/** Reserved, namespaced store key for a pool's judge scores under one judge —
 *  never collides with a real cell key (which starts `arm=`) nor with the
 *  judge-validation / judge-call records in gate.mjs. */
export function judgeScoresKey({ poolKey, judgeModel }) {
  if (!poolKey || !judgeModel) throw new Error("judgeScoresKey: poolKey and judgeModel are both required");
  return `judge-scores|pool=${poolKey}|judge=${judgeModel}`;
}

/**
 * Persist one pool's per-axis judge scores (issue #21 AC1: "a pool goes from
 * assembleJudgePayload to per-axis scores in the STORE"). The judge axes are
 * stored as distinct fields per candidate; assertAxesNotCollapsed is re-run on
 * every score first, so a collapsed/averaged score can never be written.
 */
export function recordJudgeScores(store, { poolKey, judgeModel, judgeProvider, scores }) {
  if (!store) throw new Error("recordJudgeScores: store is required");
  if (!Array.isArray(scores)) throw new Error("recordJudgeScores: scores must be an array (one per candidate)");
  for (const s of scores) assertAxesNotCollapsed(s);
  const key = judgeScoresKey({ poolKey, judgeModel });
  return store.put({
    key,
    armId: "__judge-scores__",
    briefId: poolKey,
    replicate: 0,
    cfg: judgeModel,
    result: { kind: "judge-scores", poolKey, judgeModel, judgeProvider, scores },
    resolvedModels: { judge: judgeModel },
    accounting: { state: "completed" },
    costRows: [],
  });
}

/**
 * Extract one axis as a flat per-candidate array — the shape gate.mjs's
 * validateJudge({ judgeScores, expertScores }) expects (issue #21 AC: "validateJudge
 * CAN be run for real against expert scores once #16 supplies the answer key").
 * WHICH axis to validate against Si et al.'s expert-consensus score is a
 * methodology decision that belongs to #16 (the real-data validation run), NOT
 * here — so this helper is deliberately axis-agnostic and never averages
 * anything (that would be the exact novelty/feasibility collapse §4.3 forbids).
 *
 * @param {Array<object>} scores  per-candidate axis-score objects
 * @param {string} axis           one of JUDGE_AXES
 * @returns {number[]}
 */
export function judgeScoresForAxis(scores, axis) {
  if (!JUDGE_AXES.includes(axis)) {
    throw new Error(`judgeScoresForAxis: '${axis}' is not one of the JUDGE_AXES (${JUDGE_AXES.join(", ")})`);
  }
  if (!Array.isArray(scores)) throw new Error("judgeScoresForAxis: scores must be an array");
  return scores.map((s) => {
    if (!s || typeof s[axis] !== "number") throw new Error(`judgeScoresForAxis: a score is missing numeric axis '${axis}'`);
    return s[axis];
  });
}

/**
 * The judge identity that feeds configHash (issue #21 AC: "judge model IDs +
 * prompt hash feed configHash"). A cell's result is only comparable to another's
 * if the judge that could score it is identical too — a changed rubric OR a
 * changed judge model set must give cells a different cellKey (§5.3, §11). This
 * folds BOTH into a single 12-hex `judgeHash` a caller passes as
 * `config.judgeHash` (a CONFIG_FIELDS entry lib/manifest.mjs already reserves).
 *
 * @param {object} o
 *   @param {{anthropic?: string[], openai?: string[]}} o.judgeModels  candidate judge
 *     model ids per provider (the matrix's judgeModels shape). Order-insensitive.
 *   @param {object} [o.promptObject]  defaults to the frozen JUDGE_PROMPT.
 * @returns {string} 12 hex chars
 */
export function computeJudgeHash({ judgeModels, promptObject } = {}) {
  if (!judgeModels || typeof judgeModels !== "object") {
    throw new Error("computeJudgeHash: judgeModels ({ anthropic: [...], openai: [...] }) is required");
  }
  const models = [];
  for (const list of Object.values(judgeModels)) {
    if (Array.isArray(list)) for (const m of list) if (typeof m === "string") models.push(m);
  }
  const canonical = JSON.stringify({ prompt: judgePromptHash(promptObject), models: [...new Set(models)].sort() });
  return createHash("sha256").update(canonical).digest("hex").slice(0, 12);
}

/**
 * Drive the cross-judge matrix as a LIVE scoring pass (issue #21 AC: "the
 * cross-judge matrix schedule from matrix.mjs is actually EXECUTED;
 * assertEvaluatorDistinct is enforced at CALL time, not just at schedule time").
 *
 * For every pool, buildJudgeMatrix schedules exactly one Anthropic and one
 * OpenAI judge, each already verified distinct from the pool's own generators.
 * This function then, per scheduled row:
 *   1. RE-asserts assertEvaluatorDistinct(judge_model, arm) at call time — the
 *      belt to the schedule's suspenders, so a judge can never score its own
 *      output even if the schedule were built with a stale arm.
 *   2. de-identifies + order-randomizes the pool (assembleJudgePayload + the
 *      provider's seeded order) and calls the provider for that leg's provider.
 *   3. on success: stores the per-axis scores (recordJudgeScores) and meters the
 *      call's tokens (meterJudgeCall) — a judge call is accounted like any other.
 *
 * The OpenAI leg's PROVIDER is supplied by the caller (issue #22 implements
 * OpenAIJudgeProvider). If a leg's provider is absent, the row is recorded as
 * `deferred` with a reason — NEVER silently dropped, because H5's self-preference
 * bias term needs both legs (#21's own note: "do not silently drop the OpenAI
 * leg"). The Anthropic leg lands now; the OpenAI leg lands with #22.
 *
 * @param {object} o
 *   @param {Array<{poolKey:string, arm:object, briefText:string, candidates:Array}>} o.pools
 *     each pool's resolved arm (arms.config.json shape, with .slots and .id) plus its RAW
 *     candidate pool (identity fields still on it — de-identification happens here).
 *   @param {{anthropic:string[], openai:string[]}} o.judgeModels  candidate judge models per provider.
 *   @param {{anthropic?:object, openai?:object}} o.providers  a JudgeProvider per provider (score()).
 *   @param {object} o.store   a lib/store.mjs ResultsStore.
 *   @param {number} o.seed    base integer seed; each (pool, provider) leg gets a distinct derived seed.
 *   @param {"batch"|"single"} [o.mode]  batch-first, defaults to "batch".
 *   @param {string} o.timestamp  ISO 8601, caller-supplied (meterJudgeCall requires it — replayability).
 *
 * ── Cost rows and per-provider attribution (issue #63) ──────────────────────
 * Every judge call meterJudgeCall() records (completed OR failed — tokens
 * consumed by a failed call are still spend) is collected into the returned
 * `costRows`, so a caller (the ledger, a future spend pre-flight) can see
 * judge spend WITHOUT re-reading the store. Each row is built exactly ONCE
 * by meterJudgeCall itself and handed back via its `row` field — never
 * rebuilt here, so a judge call's cost can never be double-counted between
 * the store and this return value. `spendByProvider` attributes those SAME
 * rows per provider via lib/price.mjs's priceRowsByProvider (which reduces
 * to providerOf(judgeModel) for a judge row — single-model, never assumed
 * from the pool's generating arm), so a cross-provider generating arm (e.g.
 * arm G) does not put an OpenAI judge's spend in the anthropic bucket just
 * because most of that arm's slots are Anthropic. `hasMissingRate`/
 * `missingRateModels` surface a judge model with no lib/price.mjs RATE_TABLE
 * row rather than silently pricing it at $0.
 *
 * @param {object} [o.rateTable=lib/price.mjs's RATE_TABLE]  used only to
 *   compute `spendByProvider` from the recorded rows; never affects what is
 *   stored (store rows are always token counts, priced at READ time).
 * @returns {Promise<{rows:Array, results:Array, deferred:Array, costRows:Array,
 *   spendByProvider: Object<string, number>, hasMissingRate: boolean,
 *   missingRateModels: string[]}>}
 */
export async function runJudgeMatrix({ pools, judgeModels, providers, store, seed = 1, mode = "batch", timestamp, rateTable = DEFAULT_RATE_TABLE }) {
  if (!Array.isArray(pools)) throw new Error("runJudgeMatrix: pools must be an array");
  if (!store) throw new Error("runJudgeMatrix: store is required");
  if (!timestamp) throw new Error("runJudgeMatrix: timestamp is required (caller-supplied ISO 8601, for meterJudgeCall replayability)");
  const poolByKey = new Map();
  for (const p of pools) {
    if (!p || !p.poolKey || !p.arm) throw new Error("runJudgeMatrix: every pool must carry { poolKey, arm, briefText, candidates }");
    poolByKey.set(p.poolKey, p);
  }

  const rows = buildJudgeMatrix(
    pools.map((p) => ({ poolKey: p.poolKey, arm: p.arm })),
    { judgeModels },
  );

  const results = [];
  const deferred = [];
  const costRows = [];
  for (const row of rows) {
    const pool = poolByKey.get(row.poolKey);
    // (1) Enforce distinctness at CALL time, not just schedule time.
    assertEvaluatorDistinct(row.judge_model, pool.arm);

    const provider = providers && providers[row.judge_provider];
    if (!provider) {
      const reason = `no ${row.judge_provider} judge provider wired — this leg is deferred (issue #22 supplies OpenAIJudgeProvider). NOT dropped: H5's self-preference bias term needs both legs.`;
      deferred.push({ poolKey: row.poolKey, judge_provider: row.judge_provider, judge_model: row.judge_model, reason });
      continue;
    }

    // (2) de-identify + assemble; the provider applies the seeded order.
    const payload = assembleJudgePayload({ pool: pool.candidates, arm: pool.arm, briefText: pool.briefText });
    // Distinct, replayable per-leg seed derived from the base seed + a stable
    // hash of (poolKey, provider) so two legs of the same pool don't share an order.
    const legSeed = (seed ^ hashToInt(`${row.poolKey}|${row.judge_provider}`)) | 0;
    const resp = await provider.score(payload, { judgeModel: row.judge_model, mode, seed: legSeed, timestamp });

    if (resp.terminalState === "completed") {
      for (const s of resp.scores) assertAxesNotCollapsed(s); // defense: never store a collapsed score
      // Money-first (PR #76 fix round, mirrors issue #74's generation-loop
      // ordering): meter BEFORE recording scores. Real tokens were already
      // spent by the call above; if the process dies between these two
      // writes, money-first means the SURVIVING write is the spend record
      // (meterJudgeCall's attempt-scoped judge-call row -- see gate.mjs),
      // never the scores. A resumed run (evals/harness/runner.mjs's
      // judgePoolIfEnabled) decides "already judged" purely from whether
      // SCORES exist, so a crash here is recoverable by re-scoring (cheap,
      // recomputable) -- the alternative ordering risked losing the ALREADY-
      // SPENT judge-call row instead (not recomputable; real money gone).
      const metered = meterJudgeCall({ store, cellKey: row.poolKey, judgeModel: row.judge_model, tokens: resp.tokens, timestamp });
      costRows.push(metered.row);
      recordJudgeScores(store, { poolKey: row.poolKey, judgeModel: row.judge_model, judgeProvider: row.judge_provider, scores: resp.scores });
      results.push({ poolKey: row.poolKey, judge_provider: row.judge_provider, judge_model: row.judge_model, state: "completed", scores: resp.scores });
    } else {
      // A classified judge failure is a datum, surfaced — never a silent drop.
      // Tokens consumed by a failed call are still spend, so it still meters
      // and still contributes a costRow — the ledger must not undercount spend
      // just because the call didn't complete.
      if (resp.tokens && (resp.tokens.input_tokens || resp.tokens.output_tokens)) {
        const metered = meterJudgeCall({ store, cellKey: row.poolKey, judgeModel: row.judge_model, tokens: resp.tokens, timestamp });
        costRows.push(metered.row);
      }
      results.push({ poolKey: row.poolKey, judge_provider: row.judge_provider, judge_model: row.judge_model, state: "failed", failureKind: resp.failureKind, detail: resp.detail });
    }
  }

  const { byProvider: spendByProvider, hasMissingRate, missingRateModels } = priceRowsByProvider(costRows, rateTable, { batch: mode === "batch" });

  return { rows, results, deferred, costRows, spendByProvider, hasMissingRate, missingRateModels };
}

/** Tiny stable string->int32 hash for deriving a per-leg order seed. Not
 *  cryptographic — its only job is to give the two legs of one pool distinct,
 *  reproducible presentation orders from one base seed. */
function hashToInt(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return h;
}
