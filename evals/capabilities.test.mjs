// capabilities.test.mjs — the ledger's teeth (issue #25).
//
// Asserts the pre-registration-required capabilities are all LEDGERED, every
// `live` entry resolves to a producer that is invocable at its safe surface
// WITHOUT throwing, and — the load-bearing part — that an `absent` capability
// (a producer that does not exist) is CAUGHT when something claims it `live`.
// That is the judge-shaped gap the #8 stub-sweep missed: an absence has no
// sentinel, so the ledger has to be keyed to what MUST exist, not to what
// stubs were discovered.
//
// Hermetic: every probe hits a provider/factory at a surface that never touches
// the network (construct with an empty key; the generation/judge providers then
// return a classified failure rather than calling out, and voyageEmbedder()
// construction never fetches). No live keys, no node_modules dependency.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const LEDGER = JSON.parse(readFileSync(new URL("./capabilities.json", import.meta.url), "utf8"));

/**
 * The pre-registration's required LIVE capabilities — the "what must exist"
 * list this ledger is KEYED TO (issue #25). Hardcoded here, in the test, so the
 * ledger cannot be trimmed to hide a gap: drop a required capability from
 * capabilities.json and this list still demands it (AC: "fails when a required
 * capability is missing from the ledger"). Adding a genuinely new required
 * capability is a deliberate edit to BOTH this list and the ledger.
 */
const REQUIRED_CAPABILITIES = [
  "generation",
  "engine-under-study",
  "embedding",
  "judge-scoring",
  "judge-scoring-openai-leg",
];

const byId = new Map(LEDGER.capabilities.map((c) => [c.id, c]));

/** Resolve a capability's producer (its `export` from its `module`). Throws if
 *  the module cannot be imported or the export is undefined — which is exactly
 *  how a `live` claim on an ABSENT producer is caught. */
async function resolveProducer(entry) {
  if (!entry.module) throw new Error(`capability '${entry.id}': no module (an absent producer cannot be resolved)`);
  const mod = await import(new URL(entry.module, import.meta.url));
  const producer = mod[entry.export];
  if (typeof producer === "undefined") {
    throw new Error(`capability '${entry.id}': export '${entry.export}' does not exist in ${entry.module}`);
  }
  return producer;
}

/**
 * Invoke a `live` capability at its safe surface and assert it does not throw.
 * Throws if the producer is absent (via resolveProducer) OR its probe throws —
 * so "claimed live but actually absent/broken" fails loudly.
 */
async function assertLiveInvocable(entry) {
  const producer = await resolveProducer(entry);
  switch (entry.probe) {
    case "provider": {
      const p = new producer({ apiKey: "" });
      assert.equal(typeof p.generate, "function", `${entry.id}: provider must expose generate()`);
      const r = await p.generate({ briefId: "x" }, { slots: [] }, { mode: "batch" });
      assert.equal(r.terminalState, "failed", `${entry.id}: generate() with no key must return a classified failure, not throw`);
      break;
    }
    case "judge": {
      const j = new producer({ apiKey: "" });
      assert.equal(typeof j.score, "function", `${entry.id}: judge scorer must expose score()`);
      const r = await j.score({ briefText: "b", candidates: [{ text: "x" }] }, { judgeModel: "claude-sonnet-5", seed: 1 });
      assert.equal(r.terminalState, "failed", `${entry.id}: score() with no key must return a classified failure, not throw`);
      break;
    }
    case "factory": {
      const e = producer();
      assert.equal(typeof e.embed, "function", `${entry.id}: embedder factory must produce an object with embed()`);
      break;
    }
    case "engine-wiring": {
      // The engine (ideate-core) is imported by the wiring module only at CALL
      // time, so under CI (empty node_modules) we can only assert the wiring
      // producer exists and is constructible — not import ideate-core itself.
      assert.equal(typeof producer, "function", `${entry.id}: engine wiring producer must be a constructible function`);
      assert.doesNotThrow(() => new producer({ apiKey: "" }), `${entry.id}: constructing the wiring must not throw`);
      break;
    }
    default:
      throw new Error(`capability '${entry.id}': unknown probe '${entry.probe}'`);
  }
}

// ── completeness (AC2) ──────────────────────────────────────────────────────

test("every pre-registration-required capability has a ledger entry", () => {
  const missing = REQUIRED_CAPABILITIES.filter((id) => !byId.has(id));
  assert.deepEqual(missing, [], `capabilities.json is missing required capability(ies): ${missing.join(", ")}`);
});

test("every ledger entry carries a valid status and cites what requires it", () => {
  for (const c of LEDGER.capabilities) {
    assert.ok(["live", "stub", "absent"].includes(c.status), `${c.id}: status must be live|stub|absent, got ${c.status}`);
    assert.equal(typeof c.requiredBy, "string", `${c.id}: must cite requiredBy`);
    assert.ok(c.requiredBy.length > 0, `${c.id}: requiredBy must be non-empty`);
  }
});

// ── every `live` entry is really invocable (AC3) ────────────────────────────

test("every entry marked `live` resolves to a producer that is invocable without throwing", async () => {
  for (const c of LEDGER.capabilities.filter((c) => c.status === "live")) {
    await assertLiveInvocable(c); // throws (fails the test) if absent or if the probe throws
  }
});

// ── `absent` is representable and honest (AC4, first half) ───────────────────

test("an `absent` entry has NO resolvable producer — the ledger cannot hide a live producer behind an absent label", async () => {
  const absent = LEDGER.capabilities.filter((c) => c.status === "absent");
  assert.ok(absent.length >= 1, "the ledger should surface at least one genuinely-absent required capability (the OpenAI judge leg)");
  for (const c of absent) {
    assert.equal(c.module, null, `${c.id}: an absent capability must not name an implementing module`);
    await assert.rejects(() => resolveProducer(c), `${c.id}: an absent producer must not resolve`);
  }
});

// ── the judge-shaped case: a capability with NO implementing module, claimed
//    `live`, is CAUGHT (AC4, the load-bearing half) ──────────────────────────

test("claiming `live` on a producer that does not exist is caught (the judge-shaped gap a stub-sweep misses)", async () => {
  // This synthetic entry is exactly the #8 failure mode: a required capability
  // whose producer simply does not exist. There is no stub to mark, no sentinel
  // to grep -- an absence. The validator must reject it rather than pass it.
  const phantom = { id: "judge-scoring-phantom", module: "./judge/does-not-exist-scorer.mjs", export: "scorePool", probe: "judge", status: "live" };
  await assert.rejects(() => assertLiveInvocable(phantom), "a `live` claim on a non-existent producer must fail loudly");

  // And an EXISTING module missing the CLAIMED export is caught too.
  const wrongExport = { id: "generation-wrong-export", module: "./harness/provider.mjs", export: "NoSuchProvider", probe: "provider", status: "live" };
  await assert.rejects(() => assertLiveInvocable(wrongExport), "a `live` claim on a missing export must fail loudly");
});

// ── the ledger actually catches the real judge gap it was built for ─────────

test("the judge-scoring capability (the one #8 missed entirely) is now ledgered and live", async () => {
  const judge = byId.get("judge-scoring");
  assert.ok(judge, "judge-scoring must be in the ledger");
  assert.equal(judge.status, "live", "judge-scoring is live as of #21");
  await assertLiveInvocable(judge);
});
