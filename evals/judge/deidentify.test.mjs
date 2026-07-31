// Tests for judge-payload de-identification (issue #4, AC3): the judge must
// never see arm/model/persona provenance, only candidate text.
import { test } from "node:test";
import assert from "node:assert/strict";
import { deidentifyPool, assembleJudgePayload } from "./deidentify.mjs";

const LABELED_POOL = [
  { text: "Use a swarm of low-cost drones for reef survey", arm: "D", model: "claude-opus-5", persona: "proposer_3" },
  { text: "Deploy citizen-science phone photography", arm: "B", model: "claude-haiku-4-5", persona: "proposer_1" },
  { text: "Satellite hyperspectral imaging pipeline", arm: "G", model: "openai-large-tier", persona: "proposer_5" },
];

test("deidentifyPool strips arm/model/persona from every candidate", () => {
  const out = deidentifyPool(LABELED_POOL, { id: "D" });
  assert.equal(out.length, LABELED_POOL.length);
  for (const c of out) {
    assert.deepEqual(Object.keys(c), ["text"], "only `text` may survive de-identification");
  }
});

test("AC3 — none of the identity strings appear anywhere in the assembled judge payload", () => {
  const payload = assembleJudgePayload({ pool: LABELED_POOL, arm: { id: "D" }, briefText: "Design a low-cost coral reef health monitoring approach." });
  const serialized = JSON.stringify(payload);

  const identityStrings = ["D", "B", "G", "claude-opus-5", "claude-haiku-4-5", "openai-large-tier", "proposer_3", "proposer_1", "proposer_5"];
  for (const s of identityStrings) {
    // "D", "B", "G" are short enough to false-positive-match inside prose
    // (e.g. the word "Deploy" contains a capital D... no, actually contains
    // lowercase; but "Design" contains "D" nowhere as a token) — so check
    // them as whole-field values, i.e. assert they never appear as a bare
    // JSON string value `"D"` etc., not merely as any substring.
    if (s.length <= 2) {
      assert.ok(!serialized.includes(`"${s}"`), `bare identity value "${s}" must not appear as a JSON string in the payload`);
    } else {
      assert.ok(!serialized.includes(s), `identity string '${s}' must not appear anywhere in the assembled judge payload`);
    }
  }
});

test("deidentifyPool accepts bare-string candidates", () => {
  const out = deidentifyPool(["just an idea, no labels"]);
  assert.deepEqual(out, [{ text: "just an idea, no labels" }]);
});

test("deidentifyPool preserves order and length", () => {
  const out = deidentifyPool(LABELED_POOL);
  assert.equal(out.length, 3);
  assert.equal(out[0].text, LABELED_POOL[0].text);
  assert.equal(out[2].text, LABELED_POOL[2].text);
});

test("deidentifyPool never mutates the input pool", () => {
  const clone = JSON.parse(JSON.stringify(LABELED_POOL));
  deidentifyPool(LABELED_POOL);
  assert.deepEqual(LABELED_POOL, clone, "the original labeled pool must survive untouched for accounting/analysis paths that still need it");
});

test("deidentifyPool throws on malformed candidates", () => {
  assert.throws(() => deidentifyPool("not-an-array"), /pool must be an array/);
  assert.throws(() => deidentifyPool([42]), /string or an object with a \.text field/);
  assert.throws(() => deidentifyPool([{ arm: "D" }]), /missing a string \.text field/);
});

test("assembleJudgePayload requires brief text", () => {
  assert.throws(() => assembleJudgePayload({ pool: LABELED_POOL, briefText: "" }), /briefText must be a non-empty string/);
  assert.throws(() => assembleJudgePayload({ pool: LABELED_POOL }), /briefText must be a non-empty string/);
});
