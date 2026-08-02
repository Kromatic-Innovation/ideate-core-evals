// embedder.test.mjs — hermetic tests for the embedder interface: the fixture
// lookup embedder's contract (including that it throws on unknown text —
// the property that makes it safe to use in a control) and the live Voyage
// client's contract, exercised entirely through an injected FAKE `fetchImpl`
// so this file never makes a real network call (see embedder.mjs's
// "Hermetic-CI safety" header note — voyageEmbedder is network-capable, never
// network-eager).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { fixtureEmbedder, voyageEmbedder } from "./embedder.mjs";

const FIXTURES = JSON.parse(readFileSync(new URL("./fixtures/embeddings.json", import.meta.url), "utf8"));

// L2 norm helper for asserting returned vectors are unit-length.
function l2Norm(vec) {
  return Math.sqrt(vec.reduce((sum, x) => sum + x * x, 0));
}

// A fake `fetchImpl` standing in for api.voyageai.com/v1/embeddings: given a
// chunk of `input` texts, returns one deterministic (non-unit, to actually
// exercise voyageEmbedder's normalization step) vector per text, in the SAME
// order as the request unless `reverseOrder` is set — which lets a test prove
// voyageEmbedder reassembles by `index`, not by response array position.
function makeFakeFetch({ reverseOrder = false, tokensPerCall = 10 } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const body = JSON.parse(init.body);
    const data = body.input.map((text, i) => ({
      index: i,
      // A cheap deterministic, non-unit vector derived from the text so
      // distinct texts get distinct (but reproducible) embeddings, and the
      // magnitude is deliberately != 1 so the L2-normalize step is actually
      // exercised (a fake that only ever returned unit vectors couldn't
      // catch a broken/missing normalization step).
      embedding: [text.length + 1, text.length + 2, text.length + 3],
    }));
    const ordered = reverseOrder ? [...data].reverse() : data;
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({ data: ordered, usage: { total_tokens: tokensPerCall } }),
    };
  };
  return { fetchImpl, calls };
}

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

// ── Voyage production embedder: live HTTP client, exercised via a fake fetchImpl ──

test("voyageEmbedder does not require an API key to construct (fails at call time, not construction)", () => {
  assert.doesNotThrow(() => voyageEmbedder());
  assert.equal(voyageEmbedder().modelId, "voyage-4-lite");
});

test("voyageEmbedder.embed() with NO key throws a clear VOYAGE_API_KEY error, without touching the network", async () => {
  const { fetchImpl, calls } = makeFakeFetch();
  const embedder = voyageEmbedder({ fetchImpl }); // no apiKey
  await assert.rejects(() => embedder.embed(["some idea text"]), /VOYAGE_API_KEY/);
  assert.equal(calls.length, 0, "no HTTP call should be attempted when the key is absent");
});

test("voyageEmbedder.embed() rejects empty/non-array input before touching the network", async () => {
  const { fetchImpl, calls } = makeFakeFetch();
  const embedder = voyageEmbedder({ apiKey: "fake-key", fetchImpl });
  await assert.rejects(() => embedder.embed([]), /non-empty array/);
  assert.equal(calls.length, 0);
});

test("voyageEmbedder.embed() with a fake fetchImpl returns one L2-normalized vector per text, in order", async () => {
  const { fetchImpl, calls } = makeFakeFetch();
  const embedder = voyageEmbedder({ apiKey: "fake-key", fetchImpl });
  const texts = ["alpha", "beta idea", "gamma concept text"];
  const vecs = await embedder.embed(texts);

  assert.equal(vecs.length, texts.length);
  for (const vec of vecs) {
    assert.ok(Math.abs(l2Norm(vec) - 1) < 1e-9, `expected unit-norm vector, got norm ${l2Norm(vec)}`);
  }
  assert.equal(calls.length, 1, "all 3 texts fit in one default-sized batch");
  assert.equal(embedder.dim, 3);
});

test("voyageEmbedder.embed() reorders correctly when the response's `data` array is out of index order", async () => {
  const { fetchImpl } = makeFakeFetch({ reverseOrder: true });
  const embedder = voyageEmbedder({ apiKey: "fake-key", fetchImpl });
  const texts = ["short", "a medium length text", "an even longer piece of text than that one"];
  const vecs = await embedder.embed(texts);

  // Reassembly must follow `index`, not response array position — each
  // returned vector should correspond to ITS OWN text (derivable here since
  // the fake's embedding is a deterministic function of text length), even
  // though the fake server returned them reversed.
  texts.forEach((t, i) => {
    const raw = [t.length + 1, t.length + 2, t.length + 3];
    const norm = Math.sqrt(raw.reduce((s, x) => s + x * x, 0));
    const expected = raw.map((x) => x / norm);
    vecs[i].forEach((component, j) => {
      assert.ok(Math.abs(component - expected[j]) < 1e-9, `vector ${i} component ${j} mismatched after reorder`);
    });
  });
});

test("voyageEmbedder.embed() batches across batchSize and still returns all vectors in order", async () => {
  const { fetchImpl, calls } = makeFakeFetch();
  const embedder = voyageEmbedder({ apiKey: "fake-key", fetchImpl, batchSize: 2 });
  const texts = ["one", "two", "three", "four", "five"];
  const vecs = await embedder.embed(texts);

  assert.equal(vecs.length, 5);
  assert.equal(calls.length, 3, "5 texts at batchSize=2 -> 3 requests (2,2,1)");
  texts.forEach((t, i) => {
    const raw = [t.length + 1, t.length + 2, t.length + 3];
    const norm = Math.sqrt(raw.reduce((s, x) => s + x * x, 0));
    const expected = raw.map((x) => x / norm);
    vecs[i].forEach((component, j) => assert.ok(Math.abs(component - expected[j]) < 1e-9));
  });
});

test("voyageEmbedder.usage.total_tokens accumulates the fake usage across batches", async () => {
  const { fetchImpl } = makeFakeFetch({ tokensPerCall: 7 });
  const embedder = voyageEmbedder({ apiKey: "fake-key", fetchImpl, batchSize: 2 });
  assert.equal(embedder.usage.total_tokens, 0);
  await embedder.embed(["one", "two", "three", "four", "five"]); // 3 batches
  assert.equal(embedder.usage.total_tokens, 21);
});

test("voyageEmbedder.embed() sends the documented request shape (url, headers, body)", async () => {
  const { fetchImpl, calls } = makeFakeFetch();
  const embedder = voyageEmbedder({ apiKey: "secret-123", fetchImpl, model: "voyage-4-lite", inputType: "document" });
  await embedder.embed(["hello world"]);

  assert.equal(calls.length, 1);
  const { url, init } = calls[0];
  assert.equal(url, "https://api.voyageai.com/v1/embeddings");
  assert.equal(init.method, "POST");
  assert.equal(init.headers.Authorization, "Bearer secret-123");
  assert.equal(init.headers["content-type"], "application/json");
  const body = JSON.parse(init.body);
  assert.deepEqual(body, { input: ["hello world"], model: "voyage-4-lite", input_type: "document" });
});

test("voyageEmbedder.embed() omits input_type entirely when not supplied", async () => {
  const { fetchImpl, calls } = makeFakeFetch();
  const embedder = voyageEmbedder({ apiKey: "secret-123", fetchImpl });
  await embedder.embed(["hello world"]);
  const body = JSON.parse(calls[0].init.body);
  assert.equal("input_type" in body, false);
});
