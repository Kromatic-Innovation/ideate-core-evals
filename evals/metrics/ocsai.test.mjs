// ocsai.test.mjs — hermetic tests for the OCSAI adapter (issue #17). No live
// network call anywhere in this file — every test injects a fake `fetchImpl`
// and a no-op `sleepImpl`, per evals/metrics/embedder.mjs's pattern.
import { test } from "node:test";
import assert from "node:assert/strict";

import { OcsaiProvider, runOcsaiForAutStratum, ocsaiStoreKey, putOcsaiScore } from "./ocsai.mjs";
import { makeTempStore } from "../../lib/store.mjs";

function makeFakeFetch(script) {
  const calls = [];
  let i = 0;
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const step = script[Math.min(i, script.length - 1)];
    i += 1;
    if (typeof step === "number") {
      return { ok: false, status: step, statusText: `status ${step}` };
    }
    return { ok: true, status: 200, json: async () => step };
  };
  return { fetchImpl, calls };
}

function autCell(overrides = {}) {
  return {
    key: "cell-1",
    stratum: "aut",
    briefId: "aut-brick",
    briefText: "What are some uses for a brick?",
    result: { candidates: ["prop a door", "build a wall"] },
    ...overrides,
  };
}

function noSleep() {
  const calls = [];
  const sleepImpl = async (ms) => {
    calls.push(ms);
  };
  return { sleepImpl, calls };
}

// ── Interface contract ───────────────────────────────────────────────────────

test("generate() returns a completed response with scores + cite on success", async () => {
  const { fetchImpl } = makeFakeFetch([{ item: [{ originality: 3.2 }], cite: "Organisciak et al. 2023" }]);
  const { sleepImpl } = noSleep();
  const provider = new OcsaiProvider({ fetchImpl, sleepImpl, logger: () => {} });

  const resp = await provider.generate(autCell(), {}, { mode: "single" });

  assert.equal(resp.terminalState, "completed");
  assert.equal(resp.result.cite, "Organisciak et al. 2023");
  assert.deepEqual(resp.result.scores.item, [{ originality: 3.2 }]);
});

test("generate() never throws for a transport error — returns a classified failure", async () => {
  const fetchImpl = async () => {
    throw new Error("ECONNRESET");
  };
  const { sleepImpl } = noSleep();
  const provider = new OcsaiProvider({ fetchImpl, sleepImpl, logger: () => {}, maxRetries: 1 });

  const resp = await provider.generate(autCell(), {}, {});
  assert.equal(resp.terminalState, "failed");
  assert.ok(["transport_error", "rate_limited"].includes(resp.failureKind));
});

test("generate() never throws on a non-2xx after retries — classified transport_error", async () => {
  const { fetchImpl } = makeFakeFetch([500, 500]);
  const { sleepImpl } = noSleep();
  const provider = new OcsaiProvider({ fetchImpl, sleepImpl, logger: () => {}, maxRetries: 1 });

  const resp = await provider.generate(autCell(), {}, {});
  assert.equal(resp.terminalState, "failed");
  assert.equal(resp.failureKind, "transport_error");
});

test("empty candidate pool fails as empty_pool without calling the network", async () => {
  const { fetchImpl, calls } = makeFakeFetch([{ cite: "x" }]);
  const provider = new OcsaiProvider({ fetchImpl, sleepImpl: noSleep().sleepImpl, logger: () => {} });

  const resp = await provider.generate(autCell({ result: { candidates: [] } }), {}, {});
  assert.equal(resp.terminalState, "failed");
  assert.equal(resp.failureKind, "empty_pool");
  assert.equal(calls.length, 0);
});

// ── AUT-stratum gate ──────────────────────────────────────────────────────────

test("generate() itself refuses non-AUT strata without calling the network", async () => {
  const { fetchImpl, calls } = makeFakeFetch([{ cite: "x" }]);
  const provider = new OcsaiProvider({ fetchImpl, sleepImpl: noSleep().sleepImpl, logger: () => {} });

  for (const stratum of ["business", "product", "scientific"]) {
    const resp = await provider.generate(autCell({ stratum }), {}, {});
    assert.equal(resp.terminalState, "failed");
    assert.equal(resp.failureKind, "harness_error");
  }
  assert.equal(calls.length, 0, "no network call for any non-AUT stratum");
});

test("runOcsaiForAutStratum is never invoked on business, product, or scientific cells", async () => {
  const { fetchImpl } = makeFakeFetch([{ cite: "x" }]);
  const provider = new OcsaiProvider({ fetchImpl, sleepImpl: noSleep().sleepImpl, logger: () => {} });

  const cells = [
    autCell({ key: "aut-1", stratum: "aut" }),
    autCell({ key: "biz-1", stratum: "business" }),
    autCell({ key: "prod-1", stratum: "product" }),
    autCell({ key: "sci-1", stratum: "scientific" }),
    autCell({ key: "aut-2", stratum: "aut" }),
  ];

  await runOcsaiForAutStratum(cells, {}, provider, {});

  assert.deepEqual(
    provider.calls.map((c) => c.key),
    ["aut-1", "aut-2"],
    "provider.generate must only have been called for the AUT cells",
  );
  for (const call of provider.calls) {
    assert.equal(call.stratum, "aut");
  }
});

// ── Throttle ──────────────────────────────────────────────────────────────────

test("throttle: serial calls sleep to maintain >= throttleMs spacing", async () => {
  const { fetchImpl } = makeFakeFetch([{ cite: "x" }]);
  const sleeps = [];
  const sleepImpl = async (ms) => sleeps.push(ms);
  let clock = 0;
  const now = () => clock;

  const provider = new OcsaiProvider({ fetchImpl, sleepImpl, now, throttleMs: 2000, logger: () => {} });

  await provider.generate(autCell({ key: "a" }), {}, {});
  // Simulate barely any wall-clock time passing between calls.
  clock += 5;
  await provider.generate(autCell({ key: "b" }), {}, {});

  assert.equal(sleeps.length, 1, "second call must throttle");
  assert.ok(sleeps[0] >= 1900 && sleeps[0] <= 2000, `expected ~2000ms wait, got ${sleeps[0]}`);
});

test("throttle: default is <= 1 request per 2 seconds", () => {
  const provider = new OcsaiProvider({ fetchImpl: async () => ({ ok: true, json: async () => ({}) }) });
  assert.ok(provider.throttleMs >= 2000, "default throttle must be no faster than 1 req/2s");
});

test("throttle config is reportable", () => {
  const provider = new OcsaiProvider({ throttleMs: 3000, maxRequests: 42, maxRetries: 4 });
  const cfg = provider.throttleConfig();
  assert.equal(cfg.throttleMs, 3000);
  assert.equal(cfg.maxRequests, 42);
  assert.equal(cfg.maxRetries, 4);
  assert.equal(cfg.requestCount, 0);
});

test("hard request cap: once reached, further calls fail closed with budget_exceeded and no network call", async () => {
  const { fetchImpl, calls } = makeFakeFetch([{ cite: "x" }]);
  const provider = new OcsaiProvider({
    fetchImpl,
    sleepImpl: noSleep().sleepImpl,
    logger: () => {},
    maxRequests: 1,
  });

  const first = await provider.generate(autCell({ key: "a" }), {}, {});
  assert.equal(first.terminalState, "completed");
  assert.equal(calls.length, 1);

  const second = await provider.generate(autCell({ key: "b" }), {}, {});
  assert.equal(second.terminalState, "failed");
  assert.equal(second.failureKind, "budget_exceeded");
  assert.equal(calls.length, 1, "the capped call must not touch the network");
});

test("backoff on 429 then succeeds", async () => {
  const { fetchImpl, calls } = makeFakeFetch([429, { cite: "x" }]);
  const sleeps = [];
  const sleepImpl = async (ms) => sleeps.push(ms);
  const provider = new OcsaiProvider({ fetchImpl, sleepImpl, logger: () => {}, maxRetries: 3, baseDelayMs: 1000 });

  const resp = await provider.generate(autCell(), {}, {});
  assert.equal(resp.terminalState, "completed");
  assert.equal(calls.length, 2, "one retry after the 429");
  assert.ok(sleeps.length >= 1, "backoff sleep must have been invoked");
});

// ── Store: distinct metric, never averaged with the judge's axes ────────────

test("OCSAI scores are stored under a distinct key, structurally separate from a judge record for the same cell", () => {
  const store = makeTempStore();
  const cellKey = "cell-abc123";

  // A judge record for the SAME generation cell key, with its own axes.
  store.put({
    key: cellKey,
    result: { axes: { novelty: 4, feasibility: 3 } },
    resolvedModels: { judge: "claude-sonnet" },
    accounting: { state: "completed" },
    costRows: [],
  });

  putOcsaiScore(store, cellKey, {
    scores: { item: [{ originality: 3.2 }] },
    cite: "Organisciak et al. 2023",
    armId: "arm-a",
    briefId: "aut-brick",
    replicate: 1,
  });

  assert.equal(ocsaiStoreKey(cellKey), `ocsai:${cellKey}`);
  assert.notEqual(ocsaiStoreKey(cellKey), cellKey);

  const judgeRecord = store.get(cellKey);
  const ocsaiRecord = store.get(ocsaiStoreKey(cellKey));

  // The judge record is untouched by the OCSAI write.
  assert.deepEqual(judgeRecord.result.axes, { novelty: 4, feasibility: 3 });
  assert.equal(judgeRecord.result.ocsai, undefined);

  // The OCSAI record carries its own scores, never merged/averaged into axes.
  assert.equal(ocsaiRecord.result.ocsai.cite, "Organisciak et al. 2023");
  assert.deepEqual(ocsaiRecord.result.ocsai.scores.item, [{ originality: 3.2 }]);
  assert.equal(ocsaiRecord.result.axes, undefined);
});
