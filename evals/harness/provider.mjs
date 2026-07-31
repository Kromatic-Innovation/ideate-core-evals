// provider.mjs — the provider INTERFACE the runner drives, plus a hermetic
// mock implementation, plus documented (unimplemented) stubs for the real
// Anthropic/OpenAI adapters.
//
// ── Why an interface at all ──────────────────────────────────────────────────
// Issue #5 is batch-first BY DESIGN, but it does not call real provider batch
// APIs -- that is out of scope here (no network, no invented secrets in a
// hermetic test suite). Instead the batch-vs-single choice is modeled as a
// field on the call the runner makes to a provider: every provider function
// receives `{ mode }` where mode is "batch" or "single". A real adapter reads
// that field and picks the Anthropic/OpenAI Batches endpoint vs. the plain
// Messages endpoint; the mock and the tests can assert which mode the runner
// requested without any of them touching a network socket.
//
// ── The interface ────────────────────────────────────────────────────────────
//   generate(cell, arm, opts) -> { result, tokens, terminalState, failureKind? }
//     cell   : the planned cell { key, armId, briefId, replicate, cfg }
//     arm    : the arm's resolved config from arms.config.json (id, slots, ...)
//     opts   : { mode: "batch" | "single", timestamp }
//   Returns:
//     result          : arbitrary payload if terminalState === "completed"
//                        (e.g. candidate pool); required by RunAccount.complete
//                        and ResultsStore.put on that path.
//     tokens          : { input_tokens, output_tokens, ... } OR
//                        { tokens_by_model: {...} } for a multi-model cell,
//                        matching lib/accounting.mjs costRow()'s two shapes.
//     terminalState   : "completed" | "failed" -- this call never returns
//                        "skipped" (skip is a runner-side budget decision,
//                        made BEFORE any provider call happens -- see runner.mjs).
//     failureKind     : required when terminalState === "failed"; must be one
//                        of lib/accounting.mjs FAILURE_KINDS.
//
// A provider that throws is treated by the runner as `harness_error` (our bug
// -- see FAILURE_KINDS) rather than a modeled provider failure; a well-behaved
// provider should catch its own transport/parse errors and RETURN a failed
// terminalState with the right kind instead of throwing, so those failures are
// distinguishable from a genuine harness defect.

import { FAILURE_KINDS } from "../../lib/accounting.mjs";

/**
 * Validate a provider's return shape against the interface contract above.
 * Runner-internal helper, exported so tests can reuse it if they hand-roll a
 * provider double instead of using MockProvider.
 */
export function assertValidProviderResponse(resp) {
  if (!resp || typeof resp !== "object") {
    throw new Error("provider.generate: must return an object");
  }
  if (resp.terminalState !== "completed" && resp.terminalState !== "failed") {
    throw new Error(
      `provider.generate: terminalState must be "completed" or "failed", got ${JSON.stringify(resp.terminalState)} ` +
        `(a provider never returns "skipped" -- skip decisions are made by the runner before any call)`,
    );
  }
  if (resp.terminalState === "failed") {
    if (!FAILURE_KINDS.includes(resp.failureKind)) {
      throw new Error(`provider.generate: failed response has unrecognized failureKind '${resp.failureKind}'`);
    }
  }
  if (resp.terminalState === "completed" && (!resp.result || typeof resp.result !== "object")) {
    throw new Error("provider.generate: a completed response must carry a result object");
  }
  return resp;
}

/**
 * MockProvider — the hermetic double the test suite drives. No network, no
 * timers, deterministic. Supports scripted per-cell overrides so a test can
 * force a specific cell to fail with a specific kind (AC4) while every other
 * cell completes normally.
 *
 * @param {object} [opts]
 *   @param {Map<string,object>} [opts.overrides]  key -> partial response to
 *     merge over the default completed response (e.g. force a failure).
 *   @param {number} [opts.latencyMs]  recorded on every completed result, so
 *     evals/metrics/operational.mjs's latencyPercentiles() has something to
 *     read in an integration test.
 */
export class MockProvider {
  constructor({ overrides = new Map(), latencyMs = 1 } = {}) {
    this.overrides = overrides;
    this.latencyMs = latencyMs;
    /** Every call this mock received, in order -- the spy the ACs assert against
     *  (e.g. "--dry-run calls nothing" asserts this stays empty). */
    this.calls = [];
  }

  async generate(cell, arm, opts = {}) {
    this.calls.push({ key: cell.key, armId: cell.armId, mode: opts.mode });

    const override = this.overrides.get(cell.key);
    if (override) {
      return assertValidProviderResponse({ ...defaultCompletion(cell, arm, this.latencyMs), ...override });
    }
    return assertValidProviderResponse(defaultCompletion(cell, arm, this.latencyMs));
  }
}

function defaultCompletion(cell, arm, latencyMs) {
  // A minimal, deterministic "pool" -- just enough shape for downstream
  // metrics/store code to have something real to store. Content is not the
  // point of this mock; call-accounting and state-machine correctness are.
  const slots = (arm && arm.slots) || [];
  const tokens_by_model = {};
  for (const slot of slots) {
    tokens_by_model[slot.model] = tokens_by_model[slot.model] || { input_tokens: 0, output_tokens: 0 };
    tokens_by_model[slot.model].input_tokens += 500;
    tokens_by_model[slot.model].output_tokens += 300;
  }
  return {
    terminalState: "completed",
    result: {
      candidates: [`mock-idea-1-${cell.key}`, `mock-idea-2-${cell.key}`],
      latencyMs,
    },
    tokens: { tokens_by_model },
  };
}

// ── Real adapters: documented stubs, not implemented ────────────────────────
//
// These are where the real Anthropic Batch API / OpenAI Batch API adapters
// plug in. They are deliberately NOT implemented here -- issue #5 has no
// network access requirement and must stay hermetically testable; wiring a
// live key is out of scope (and this repo's own instructions forbid inventing
// secrets). A future issue implements these against the real batch endpoints:
//
//   AnthropicBatchProvider.generate(cell, arm, { mode: "batch", ... })
//     -> POST /v1/messages/batches (batch mode, the DEFAULT -- see
//        SKILL.md/claude-api "Message Batches" for the request/poll/results
//        shape) or plain POST /v1/messages (single/fallback mode, used only
//        when --no-batch is passed or a cell needs low latency).
//
//   OpenAIBatchProvider.generate(cell, arm, { mode: "batch", ... })
//     -> OpenAI Batches API (analogous 50%-discount batch submission), single
//        mode falling back to a plain chat completion.
//
// Both would resolve the `model` string per persona slot from arms.config.json
// (already wired -- see runner.mjs's resolveModels()), capture the provider's
// `usage` object into the `tokens`/`tokens_by_model` shape this interface
// requires (per docs/PREREGISTRATION.md §7 -- "adapter must capture it"), and
// translate provider-side failures (refusal, rate limit, timeout, transport
// error) into the FAILURE_KINDS taxonomy rather than throwing.
export class AnthropicBatchProvider {
  async generate() {
    throw new Error(
      "AnthropicBatchProvider is a documented stub -- issue #5 does not call real provider APIs. " +
        "Implement against POST /v1/messages/batches (batch mode) / POST /v1/messages (single mode) in a follow-up issue.",
    );
  }
}

export class OpenAIBatchProvider {
  async generate() {
    throw new Error(
      "OpenAIBatchProvider is a documented stub -- issue #5 does not call real provider APIs. " +
        "Implement against the OpenAI Batches API (batch mode) / chat completions (single mode) in a follow-up issue.",
    );
  }
}
