// embedder.test.mjs — hermetic tests for the embedder interface: the fixture
// lookup embedder's contract (including that it throws on unknown text —
// the property that makes it safe to use in a control) and the Voyage stub's
// documented refusal to silently produce fake output.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { fixtureEmbedder, voyageEmbedder } from "./embedder.mjs";

const FIXTURES = JSON.parse(readFileSync(new URL("./fixtures/embeddings.json", import.meta.url), "utf8"));

test("fixtureEmbedder returns the exact committed vector for a known text", async () => {
  const embedder = fixtureEmbedder(FIXTURES);
  const someText = Object.keys(FIXTURES.vectors)[0];
  const [vec] = await embedder.embed([someText]);
  assert.deepEqual(vec, FIXTURES.vectors[someText]);
});

test("fixtureEmbedder preserves input order across multiple texts", async () => {
  const embedder = fixtureEmbedder(FIXTURES);
  const texts = Object.keys(FIXTURES.vectors).slice(0, 3);
  const vecs = await embedder.embed(texts);
  assert.equal(vecs.length, 3);
  texts.forEach((t, i) => assert.deepEqual(vecs[i], FIXTURES.vectors[t]));
});

test("fixtureEmbedder THROWS on an unknown text — cannot silently embed garbage", async () => {
  const embedder = fixtureEmbedder(FIXTURES);
  await assert.rejects(
    () => embedder.embed(["this text was never embedded by regen-fixtures.mjs, it is not in the fixture map"]),
    /no fixture vector for text/,
  );
});

test("fixtureEmbedder THROWS on a single unknown text even amid known ones (no partial silent success)", async () => {
  const embedder = fixtureEmbedder(FIXTURES);
  const known = Object.keys(FIXTURES.vectors)[0];
  await assert.rejects(() => embedder.embed([known, "definitely-not-a-fixture-text-xyz123"]), /no fixture vector for text/);
});

test("fixtureEmbedder rejects malformed construction and empty input", async () => {
  assert.throws(() => fixtureEmbedder(null), /parsed embeddings\.json payload/);
  assert.throws(() => fixtureEmbedder({}), /parsed embeddings\.json payload/);
  const embedder = fixtureEmbedder(FIXTURES);
  await assert.rejects(() => embedder.embed([]), /non-empty array/);
});

test("fixtureEmbedder exposes modelId and dim from the fixture payload", () => {
  const embedder = fixtureEmbedder(FIXTURES);
  assert.equal(embedder.modelId, FIXTURES.modelId);
  assert.equal(embedder.dim, FIXTURES.dim);
});

// ── Voyage production-embedder stub: documented, unimplemented, never fakes output ──

test("voyageEmbedder.embed() throws rather than silently returning fake vectors", async () => {
  const embedder = voyageEmbedder({ apiKey: "not-a-real-key" });
  await assert.rejects(() => embedder.embed(["some idea text"]), /not implemented/);
});

test("voyageEmbedder does not require an API key to construct (fails at call time, not construction)", () => {
  assert.doesNotThrow(() => voyageEmbedder());
  assert.equal(voyageEmbedder().modelId, "voyage-4-lite");
});
