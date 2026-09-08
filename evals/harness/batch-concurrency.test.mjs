// batch-concurrency.test.mjs -- issue #148: one Message Batch per CELL.
//
// The defect these tests pin is invisible to every other batch test in this
// repo, and for a structural reason worth stating: batch mechanics are
// exercised against an injected `fetchImpl` where queue latency is ZERO, so a
// run that submits N one-request batches and a run that submits one N-request
// batch produce identical RESULTS at identical speed. The only thing that
// separates them is how many times POST /v1/messages/batches was called.
//
// So these tests count SUBMISSIONS, never results. A test that asserted only
// "every cell completed" would pass against the exact behaviour that spent
// 2h34m on Study 1 Stage 1a collecting nothing.
//
// Hermetic throughout: no network, no real ideate-core, no timer that waits
// longer than the coalescing window under test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { AnthropicBatchProvider, OpenAIBatchProvider, MockProvider, DEFAULT_MAX_BATCH_REQUESTS } from "./provider.mjs";
import { runSpec, runCellsWithConcurrency } from "./runner.mjs";
import { ResultsStore } from "../../lib/store.mjs";
import { configHash } from "../../lib/manifest.mjs";

const armsConfigJson = JSON.parse(await (await import("node:fs")).promises.readFile(new URL("../../arms.config.json", import.meta.url), "utf8"));

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "ideate-batch-concurrency-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const silentLog = () => {};
const noopSleep = async () => {};

// Four briefs, so a run has four cells to coalesce (or not).
const CORPUS = [
  { id: "brief-1", text: "Design a better bus stop." },
  { id: "brief-2", text: "Design a better park bench." },
  { id: "brief-3", text: "Design a better crosswalk." },
  { id: "brief-4", text: "Design a better bike rack." },
];

const CFG = { harnessVersion: "0.0.1", engineSha: "test-sha", promptHash: "test-prompt", corpusHash: "test-corpus" };

// Arm A is the repo's registered SOLO arm -- one slot, one round, so exactly
// one request per cell. That is the shape #148 is about: a panel arm already
// produced 5-request batches and hid the defect in every smoke run.
const SOLO_ARMS = { panel: armsConfigJson.panel, arms: { A: armsConfigJson.arms.A } };
const SOLO_SPEC = { arms: [{ id: "A" }], briefs: CORPUS.map((b) => ({ id: b.id })), replicates: 1, config: CFG };

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}
function textResponse(body) {
  return { ok: true, status: 200, json: async () => ({}), text: async () => body };
}

/**
 * A fetchImpl that records EVERY batch submission (not just the last) and
 * answers each one with results for the custom_ids that submission actually
 * carried. Recording every submission is the whole point: `submissions` is the
 * observable that distinguishes one batch of N from N batches of 1.
 */
function recordingFetch(submissions) {
  const resultsByBatch = new Map();
  return async (url, opts) => {
    const u = String(url);
    if (u === "https://api.anthropic.com/v1/messages/batches") {
      const body = JSON.parse(opts.body);
      const batchId = `batch_${submissions.length}`;
      submissions.push(body.requests);
      resultsByBatch.set(
        batchId,
        body.requests.map((r) => ({
          custom_id: r.custom_id,
          result: {
            type: "succeeded",
            message: { content: [{ type: "text", text: JSON.stringify([{ text: `idea for ${r.custom_id}` }]) }], usage: { input_tokens: 10, output_tokens: 5 } },
          },
        })),
      );
      return jsonResponse(200, { id: batchId, processing_status: "ended", results_url: `https://fake/results/${batchId}` });
    }
    if (u.startsWith("https://fake/results/")) {
      const batchId = u.slice("https://fake/results/".length);
      return textResponse((resultsByBatch.get(batchId) || []).map((l) => JSON.stringify(l)).join("\n"));
    }
    if (u.includes("/v1/messages/batches/")) {
      const batchId = u.split("/").pop();
      return jsonResponse(200, { id: batchId, processing_status: "ended", results_url: `https://fake/results/${batchId}` });
    }
    throw new Error(`recordingFetch: unexpected URL ${u}`);
  };
}

/** A minimal ideate-core stand-in: one `complete()` per agent, one round. */
async function soloIdeateImpl(input, deps) {
  const { complete, agents } = deps;
  const replies = await Promise.all(
    agents.map((agent) =>
      complete({
        model: agent.model,
        prompt: deps.buildRound1Prompt({ context: input.context, persona: agent.persona, ideasPerAgent: agent.ideasPerAgent }),
        persona: agent.persona,
        effort: agent.effort,
      }),
    ),
  );
  const candidates = [];
  for (const reply of replies) {
    if (!reply || reply.ok !== true) continue;
    for (const c of JSON.parse(reply.text)) candidates.push({ text: c.text });
  }
  return { candidates, agents: agents.map((a) => ({ persona: a.persona, model: a.model })), meta: {} };
}

function anthropicProvider(opts = {}) {
  return new AnthropicBatchProvider({
    apiKey: "test-key",
    corpus: CORPUS,
    armsConfig: SOLO_ARMS,
    ideateImpl: soloIdeateImpl,
    sleep: noopSleep,
    logger: silentLog,
    ...opts,
  });
}

// A fixed price per cell so a ceiling test is exact arithmetic rather than a
// function of the mock's token counts.
const DOLLAR_PER_CELL = (plannedCells) => ({
  usd: plannedCells.length,
  breakdown: plannedCells.map((c) => ({ cellKey: c.key, usd: 1, byProvider: { anthropic: 1 } })),
});

// ── The defect itself ────────────────────────────────────────────────────────

test("issue #148 (the defect): at the default concurrency, four solo cells submit FOUR batches of ONE request each", async (t) => {
  const submissions = [];
  const { summary } = await runSpec(SOLO_SPEC, {
    store: new ResultsStore(tempDir(t)),
    armsConfig: SOLO_ARMS,
    provider: anthropicProvider({ fetchImpl: recordingFetch(submissions) }),
    log: silentLog,
  });

  assert.equal(summary.completed, 4);
  // This is the behaviour that cost 2h34m for zero cells in production. It is
  // pinned deliberately: the default must stay byte-for-byte what it was, and
  // a future change that alters it should have to change this assertion and
  // say why.
  assert.equal(submissions.length, 4, "one batch per cell -- the defect, at the unchanged default");
  assert.deepEqual(submissions.map((s) => s.length), [1, 1, 1, 1], "each batch carries exactly one request");
});

test("issue #148 (the fix): with cellConcurrency 4 and a coalescing window, the SAME four cells submit ONE batch of four", async (t) => {
  const submissions = [];
  const { summary } = await runSpec(SOLO_SPEC, {
    store: new ResultsStore(tempDir(t)),
    armsConfig: SOLO_ARMS,
    provider: anthropicProvider({ fetchImpl: recordingFetch(submissions), batchWindowMs: 40 }),
    cellConcurrency: 4,
    log: silentLog,
  });

  assert.equal(summary.completed, 4, "every cell still reaches its own terminal state");
  assert.equal(submissions.length, 1, "one batch, not four -- this is the assertion the whole issue is about");
  assert.equal(submissions[0].length, 4, "and it carries all four cells' requests");
});

test("issue #148: a zero window coalesces only cells that arrive together -- STAGGERED cells fan back out to one batch each", async (t) => {
  // Worth stating precisely, because the happy case above is misleading. At
  // batchWindowMs 0 the barrier closes on the next macrotask, so it coalesces
  // whatever has arrived by then. Four cells started in one burst against a
  // zero-latency fake all arrive in that window, so the zero window LOOKS
  // sufficient -- but that is a property of every cell starting at the same
  // instant, which is true only of the very first batch of a run.
  //
  // In steady state cells start staggered: a worker picks up its next cell only
  // when its previous one's batch comes back, minutes later. Model that with a
  // per-cell start delay and the zero window collapses to one batch per cell,
  // while a real window still coalesces all four. That is the difference the
  // window exists for, and this test is what stops `batchWindowMs` from being
  // deleted as apparently-redundant.
  const stagger = { "brief-1": 0, "brief-2": 15, "brief-3": 30, "brief-4": 45 };
  const yieldingIdeate = async (input, deps) => {
    await new Promise((r) => setTimeout(r, stagger[input.context && input.context.slug] ?? 0));
    return soloIdeateImpl(input, deps);
  };

  const zeroWindow = [];
  await runSpec(SOLO_SPEC, {
    store: new ResultsStore(tempDir(t)),
    armsConfig: SOLO_ARMS,
    provider: anthropicProvider({ fetchImpl: recordingFetch(zeroWindow), batchWindowMs: 0, ideateImpl: yieldingIdeate }),
    cellConcurrency: 4,
    log: silentLog,
  });
  assert.equal(zeroWindow.length, 4, "a zero window cannot span cells that arrive at different times");

  const realWindow = [];
  await runSpec(SOLO_SPEC, {
    store: new ResultsStore(tempDir(t)),
    armsConfig: SOLO_ARMS,
    provider: anthropicProvider({ fetchImpl: recordingFetch(realWindow), batchWindowMs: 200, ideateImpl: yieldingIdeate }),
    cellConcurrency: 4,
    log: silentLog,
  });
  assert.equal(realWindow.length, 1, "the same staggered run with a 200ms window submits one batch of four");
  assert.equal(realWindow[0].length, 4);
});

test("issue #148: maxBatchRequests flushes early -- four concurrent cells under a bound of 2 submit two batches of two", async (t) => {
  const submissions = [];
  await runSpec(SOLO_SPEC, {
    store: new ResultsStore(tempDir(t)),
    armsConfig: SOLO_ARMS,
    // A window long enough that the timer would never be what fires: if the
    // size bound did not work, this test would hang rather than mis-count.
    provider: anthropicProvider({ fetchImpl: recordingFetch(submissions), batchWindowMs: 5000, maxBatchRequests: 2 }),
    cellConcurrency: 4,
    log: silentLog,
  });

  assert.equal(submissions.length, 2);
  assert.deepEqual(submissions.map((s) => s.length), [2, 2]);
});

// ── Configuration guards ─────────────────────────────────────────────────────

test("issue #148: a non-finite or negative batchWindowMs fails loud rather than silently coercing to the broken default", () => {
  for (const bad of [NaN, -1, "2000", undefined]) {
    // `undefined` is the one exception: it means "not set", so the default 0
    // applies and construction must succeed.
    if (bad === undefined) {
      assert.doesNotThrow(() => anthropicProvider({ batchWindowMs: undefined }));
      continue;
    }
    assert.throws(() => anthropicProvider({ batchWindowMs: bad }), /batchWindowMs must be a finite, non-negative number/, `batchWindowMs=${String(bad)}`);
    assert.throws(
      () => new OpenAIBatchProvider({ apiKey: "k", corpus: CORPUS, armsConfig: SOLO_ARMS, batchWindowMs: bad }),
      /batchWindowMs must be a finite, non-negative number/,
      `OpenAI batchWindowMs=${String(bad)}`,
    );
  }
});

test("issue #148: maxBatchRequests must be a positive integer -- 0 would flush on every push, restoring one-request batches", () => {
  for (const bad of [0, -1, 1.5, NaN]) {
    assert.throws(() => anthropicProvider({ maxBatchRequests: bad }), /maxBatchRequests must be a positive integer/, `maxBatchRequests=${String(bad)}`);
  }
  assert.ok(Number.isInteger(DEFAULT_MAX_BATCH_REQUESTS) && DEFAULT_MAX_BATCH_REQUESTS > 1);
});

// ── runCellsWithConcurrency ──────────────────────────────────────────────────

test("runCellsWithConcurrency: concurrency 1 is strictly sequential -- never two cells in flight", async () => {
  let inFlight = 0;
  let peak = 0;
  const order = [];
  await runCellsWithConcurrency(
    [1, 2, 3, 4].map((n) => ({ key: `c${n}` })),
    1,
    async (cell) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      order.push(cell.key);
      inFlight -= 1;
    },
  );
  assert.equal(peak, 1, "the default must remain the historical sequential loop");
  assert.deepEqual(order, ["c1", "c2", "c3", "c4"], "and in plan order");
});

test("runCellsWithConcurrency: concurrency 3 actually overlaps, and never exceeds its bound", async () => {
  let inFlight = 0;
  let peak = 0;
  await runCellsWithConcurrency(
    Array.from({ length: 9 }, (_, i) => ({ key: `c${i}` })),
    3,
    async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 2));
      inFlight -= 1;
    },
  );
  assert.equal(peak, 3, "exactly the bound -- not 1 (no overlap) and not 9 (unbounded)");
});

test("runCellsWithConcurrency: onSettled fires for a cell whose runOne THREW -- a leaked reservation ratchets every later ceiling", async () => {
  const settled = [];
  await assert.rejects(
    () =>
      runCellsWithConcurrency(
        [{ key: "boom" }],
        1,
        async () => {
          throw new Error("cell exploded");
        },
        (key) => settled.push(key),
      ),
    /cell exploded/,
  );
  assert.deepEqual(settled, ["boom"], "the release must be in a finally, not on the success path");
});

test("runCellsWithConcurrency: the first error is rethrown and no further cells are started", async () => {
  const started = [];
  await assert.rejects(
    () =>
      runCellsWithConcurrency(
        Array.from({ length: 6 }, (_, i) => ({ key: `c${i}` })),
        1,
        async (cell) => {
          started.push(cell.key);
          if (cell.key === "c1") throw new Error("fail loud");
        },
      ),
    /fail loud/,
  );
  assert.deepEqual(started, ["c0", "c1"], "workers stop pulling once a cell has failed -- the run does not march the rest into the same wall");
});

test("runCellsWithConcurrency: a non-positive or non-integer concurrency fails loud", async () => {
  for (const bad of [0, -1, 1.5, NaN, "2"]) {
    await assert.rejects(() => runCellsWithConcurrency([{ key: "a" }], bad, async () => {}), /concurrency must be a positive integer/, `concurrency=${String(bad)}`);
  }
});

// ── Admission control under concurrency ──────────────────────────────────────

test("issue #148: in-flight reservations keep a per-provider ceiling exact under concurrency -- without them K cells' spend is invisible to admission", async (t) => {
  // Four cells, each projected at $1 of Anthropic spend, against a $2 ceiling.
  // MockProvider's ACTUAL spend is a fraction of a cent, so `already` grows
  // negligibly from real spend alone -- which is exactly why the reservation
  // is load-bearing: with three peers in flight and nothing reserved, every
  // one of the four cells would look affordable and all four would run,
  // spending 4x a 2x ceiling.
  const { summary } = await runSpec(SOLO_SPEC, {
    store: new ResultsStore(tempDir(t)),
    armsConfig: SOLO_ARMS,
    provider: new MockProvider(),
    priceGrid: DOLLAR_PER_CELL,
    maxSpendByProviderUsd: { anthropic: 2 },
    cellConcurrency: 4,
    log: silentLog,
  });

  assert.equal(summary.completed, 2, "only as many cells as the ceiling can hold are admitted");
  assert.equal(summary.skipped, 2, "the rest are recorded as classified skips, never dropped");
  assert.equal(summary.planned, 4, "and every planned cell still reached exactly one terminal state");
});

test("issue #148: the same reservation guards the GLOBAL --max-spend ceiling, not only the per-provider one", async (t) => {
  const { summary } = await runSpec(SOLO_SPEC, {
    store: new ResultsStore(tempDir(t)),
    armsConfig: SOLO_ARMS,
    provider: new MockProvider(),
    priceGrid: DOLLAR_PER_CELL,
    maxSpendUsd: 2,
    cellConcurrency: 4,
    log: silentLog,
  });

  assert.equal(summary.completed, 2);
  assert.equal(summary.skipped, 2);
});

test("issue #148: a reservation is RELEASED once its cell settles -- a run of many cells under a wide ceiling is not throttled by stale holds", async (t) => {
  // Four cells, $1 each, ceiling $4. If reservations were never released, the
  // third and fourth cells would see $3 held against a $4 ceiling and skip.
  const { summary } = await runSpec(SOLO_SPEC, {
    store: new ResultsStore(tempDir(t)),
    armsConfig: SOLO_ARMS,
    provider: new MockProvider(),
    priceGrid: DOLLAR_PER_CELL,
    maxSpendByProviderUsd: { anthropic: 4 },
    cellConcurrency: 1, // sequential, so every peer has settled before the next admission
    log: silentLog,
  });

  assert.equal(summary.completed, 4, "a released reservation leaves the ceiling where it started");
  assert.equal(summary.skipped, 0);
});

test("issue #148: the accounting identity survives concurrency -- every planned cell reaches exactly one terminal state", async (t) => {
  const store = new ResultsStore(tempDir(t));
  const { summary } = await runSpec(SOLO_SPEC, {
    store,
    armsConfig: SOLO_ARMS,
    provider: new MockProvider(),
    cellConcurrency: 4,
    log: silentLog,
  });

  // reconcile() throws unless the identity holds, so reaching this line is
  // itself the assertion -- these make the counts explicit.
  assert.equal(summary.planned, 4);
  assert.equal(summary.completed + summary.failed + summary.skipped, summary.planned);
  assert.equal(configHash(CFG).length > 0, true);
});
