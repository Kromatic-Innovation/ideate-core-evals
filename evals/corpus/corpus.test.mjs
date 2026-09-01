// corpus.test.mjs — hermetic tests for the frozen 24-brief corpus (issues #2, #43).
//
// Hermetic on purpose: these tests exercise the FROZEN keyword snapshot in
// ./liveideabench-keywords.mjs, never the network. The reproducibility claim
// (AC3) is exactly that re-running the same algorithm+seed over the same
// frozen input reproduces the same output — a live fetch here would test
// "does the source repo still agree with itself today," a different and much
// less stable question than the one this corpus needs answered at test time.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { BRIEFS, CORPUS, CORPUS_HASH, corpusHash, briefContentHash, validateCorpus } from "./index.mjs";
import { LIVEIDEABENCH_KEYWORDS, SOURCE as LIVEIDEABENCH_SOURCE } from "./liveideabench-keywords.mjs";
import {
  sampleKeywords,
  mulberry32,
  SCIENTIFIC_SAMPLE_SEED,
  SCIENTIFIC_SAMPLE_COUNT,
} from "./sample.mjs";
import { configHash } from "../../lib/manifest.mjs";

// ── AC1: 12 briefs, correct stratum split, provenance recorded ─────────────

test("the corpus has exactly 24 briefs", () => {
  assert.equal(BRIEFS.length, 24);
  assert.equal(CORPUS, BRIEFS, "CORPUS is the same frozen array BRIEFS exports");
});

test("stratum counts are exactly 6 business / 6 product / 6 scientific / 6 aut", () => {
  const counts = { business: 0, product: 0, scientific: 0, aut: 0 };
  for (const b of BRIEFS) counts[b.stratum] = (counts[b.stratum] || 0) + 1;
  assert.deepEqual(counts, { business: 6, product: 6, scientific: 6, aut: 6 });
});

test("every brief id is unique and stable (string)", () => {
  const ids = BRIEFS.map((b) => b.id);
  assert.equal(new Set(ids).size, 24, "all 24 ids are distinct");
  for (const id of ids) assert.equal(typeof id, "string");
});

test("every brief carries provenance, and sampled briefs carry a source", () => {
  for (const b of BRIEFS) {
    assert.ok(b.provenance === "authored" || b.provenance === "sampled", `${b.id} has valid provenance`);
    if (b.provenance === "sampled") {
      assert.ok(b.selection, `${b.id} is sampled and must carry selection metadata`);
      assert.ok(b.selection.source, `${b.id} is sampled and must carry a source reference`);
      assert.equal(typeof b.selection.algorithm, "string");
      assert.equal(typeof b.selection.seed, "number");
    } else {
      assert.equal(b.selection, undefined, `${b.id} is authored and should not carry sampling metadata`);
    }
  }
});

test("authored strata (business, product, aut) are all provenance: authored", () => {
  for (const b of BRIEFS) {
    if (b.stratum === "business" || b.stratum === "product" || b.stratum === "aut") {
      assert.equal(b.provenance, "authored", `${b.id} (${b.stratum}) should be authored`);
    }
  }
});

test("the scientific stratum is provenance: sampled, sourced from LiveIdeaBench", () => {
  const sci = BRIEFS.filter((b) => b.stratum === "scientific");
  assert.equal(sci.length, 6);
  for (const b of sci) {
    assert.equal(b.provenance, "sampled");
    assert.equal(b.selection.source.repo, "x66ccff/liveideabench");
    assert.equal(b.selection.source.arxiv, "2412.17596");
    assert.ok(b.selection.source.commitSha, `${b.id} records a source commit SHA`);
    assert.ok(b.selection.source.keyword, `${b.id} records which keyword it sampled`);
  }
});

test("validateCorpus accepts the frozen corpus and rejects malformed ones", () => {
  assert.doesNotThrow(() => validateCorpus(BRIEFS));
  assert.throws(() => validateCorpus(BRIEFS.slice(0, 23)), /expected exactly 24/);
  const withDuplicateId = [...BRIEFS.slice(0, 23), { ...BRIEFS[23], id: BRIEFS[0].id }];
  assert.throws(() => validateCorpus(withDuplicateId), /duplicate brief id/);

  const wrongStratum = BRIEFS.slice(0, 23).concat([{ ...BRIEFS[23], stratum: "business" }]);
  assert.throws(() => validateCorpus(wrongStratum), /expected \d+/);
});

// ── AC2: per-brief content hash + corpus hash ───────────────────────────────

test("briefContentHash is deterministic sha256(text) truncated to 12 hex chars", () => {
  const b = BRIEFS[0];
  const expected = createHash("sha256").update(b.text).digest("hex").slice(0, 12);
  assert.equal(briefContentHash(b), expected);
  assert.equal(briefContentHash(b), briefContentHash({ ...b }), "recomputing gives the same hash");
  assert.match(briefContentHash(b), /^[0-9a-f]{12}$/);
});

test("every brief has a distinct content hash (no accidental duplicate briefs)", () => {
  const hashes = BRIEFS.map(briefContentHash);
  assert.equal(new Set(hashes).size, 24);
});

test("corpusHash is deterministic and order-independent over brief array position", () => {
  const h1 = corpusHash(BRIEFS);
  const h2 = corpusHash(BRIEFS.slice().reverse());
  assert.equal(h1, h2, "reordering the array (same set of briefs) must not change corpusHash");
  assert.equal(h1, CORPUS_HASH, "the exported CORPUS_HASH matches recomputing corpusHash(BRIEFS)");
  assert.match(h1, /^[0-9a-f]{12}$/);
});

test("editing a brief's text changes both its content hash and the corpus hash", () => {
  const original = BRIEFS[0];
  const edited = { ...original, text: original.text + " (edited)" };
  const corpusWithEdit = [edited, ...BRIEFS.slice(1)];

  assert.notEqual(briefContentHash(edited), briefContentHash(original), "content hash must change");
  assert.notEqual(corpusHash(corpusWithEdit), corpusHash(BRIEFS), "corpus hash must change");
});

test("adding a brief changes the corpus hash", () => {
  const extra = { id: "extra-99", stratum: "aut", provenance: "authored", text: "Generate uses for a shoe." };
  const widened = [...BRIEFS, extra];
  assert.notEqual(corpusHash(widened), corpusHash(BRIEFS));
});

test("corpusHash feeds configHash via lib/manifest.mjs CONFIG_FIELDS (load-bearing AC)", () => {
  const baseConfig = { harnessVersion: "0.0.1", engineSha: "920c086", promptHash: "p1" };
  const withCorpus = configHash({ ...baseConfig, corpusHash: CORPUS_HASH });
  const withoutCorpus = configHash(baseConfig);
  assert.notEqual(withCorpus, withoutCorpus, "supplying the corpus hash changes configHash");

  const editedCorpusHash = corpusHash([{ ...BRIEFS[0], text: BRIEFS[0].text + " (edited)" }, ...BRIEFS.slice(1)]);
  const withEditedCorpus = configHash({ ...baseConfig, corpusHash: editedCorpusHash });
  assert.notEqual(withEditedCorpus, withCorpus, "editing a brief changes configHash end-to-end");
});

// ── AC3: LiveIdeaBench sampling is reproducible (procedure + seed, not just result) ─

test("the frozen LiveIdeaBench keyword snapshot has the documented shape", () => {
  assert.equal(LIVEIDEABENCH_KEYWORDS.length, 1180, "matches the paper's reported prompt count");
  assert.equal(new Set(LIVEIDEABENCH_KEYWORDS).size, 1180, "no duplicate keywords in the snapshot");
  assert.equal(LIVEIDEABENCH_SOURCE.repo, "x66ccff/liveideabench");
  assert.equal(LIVEIDEABENCH_SOURCE.path, "csvs/kws.csv");
  assert.ok(LIVEIDEABENCH_SOURCE.commitSha, "a commit SHA is recorded for the fetched snapshot");
  assert.equal(LIVEIDEABENCH_SOURCE.arxiv, "2412.17596");
});

test("mulberry32 is a deterministic PRNG: same seed -> same sequence", () => {
  const a = mulberry32(42);
  const b = mulberry32(42);
  const seqA = Array.from({ length: 5 }, () => a());
  const seqB = Array.from({ length: 5 }, () => b());
  assert.deepEqual(seqA, seqB);
  for (const x of seqA) {
    assert.ok(x >= 0 && x < 1, "output is in [0, 1)");
  }
});

test("mulberry32 with different seeds diverges", () => {
  const a = mulberry32(1)();
  const b = mulberry32(2)();
  assert.notEqual(a, b);
});

test("sampleKeywords is reproducible: same seed -> same selection", () => {
  const run1 = sampleKeywords(LIVEIDEABENCH_KEYWORDS, SCIENTIFIC_SAMPLE_COUNT, SCIENTIFIC_SAMPLE_SEED);
  const run2 = sampleKeywords(LIVEIDEABENCH_KEYWORDS, SCIENTIFIC_SAMPLE_COUNT, SCIENTIFIC_SAMPLE_SEED);
  assert.deepEqual(run1, run2, "identical seed and input reproduce identical, order-preserved output");
});

test("sampleKeywords with a different seed generally selects differently", () => {
  const run1 = sampleKeywords(LIVEIDEABENCH_KEYWORDS, SCIENTIFIC_SAMPLE_COUNT, SCIENTIFIC_SAMPLE_SEED);
  const run2 = sampleKeywords(LIVEIDEABENCH_KEYWORDS, SCIENTIFIC_SAMPLE_COUNT, SCIENTIFIC_SAMPLE_SEED + 1);
  assert.notDeepEqual(run1, run2);
});

test("extending the scientific sample count preserves the original draw prefix (issue #43)", () => {
  // The corpus expansion bumped SCIENTIFIC_SAMPLE_COUNT 3 -> 6 under the SAME
  // seed. Because sampleKeywords is a sequential draw-without-replacement walk,
  // the first 3 draws of the count=6 run must be byte-identical to the
  // original count=3 run — sci-01..03's keyword/drawIndex are preserved, not
  // re-rolled, by the expansion.
  const original = sampleKeywords(LIVEIDEABENCH_KEYWORDS, 3, SCIENTIFIC_SAMPLE_SEED);
  const expanded = sampleKeywords(LIVEIDEABENCH_KEYWORDS, SCIENTIFIC_SAMPLE_COUNT, SCIENTIFIC_SAMPLE_SEED);
  assert.deepEqual(expanded.slice(0, 3), original, "the original 3-draw prefix is unchanged by the expansion");
});

test("sampleKeywords samples without replacement and validates its inputs", () => {
  const picked = sampleKeywords(LIVEIDEABENCH_KEYWORDS, 20, 7);
  assert.equal(picked.length, 20);
  assert.equal(new Set(picked).size, 20, "no repeats");

  assert.throws(() => sampleKeywords([], 1, 1), /non-empty array/);
  assert.throws(() => sampleKeywords(["a"], -1, 1), /non-negative integer/);
  assert.throws(() => sampleKeywords(["a"], 2, 1), /exceeds the size/);
});

test("the corpus's scientific stratum reproduces sampleKeywords(...) from the registered seed", () => {
  // This is the crux of AC3: the 3 briefs actually shipped in the corpus are
  // not a hand-picked list independent of the documented procedure — they ARE
  // what the documented procedure (frozen snapshot + algorithm + seed)
  // produces. Re-deriving and comparing closes the loop.
  const expected = sampleKeywords(LIVEIDEABENCH_KEYWORDS, SCIENTIFIC_SAMPLE_COUNT, SCIENTIFIC_SAMPLE_SEED);
  const actual = BRIEFS.filter((b) => b.stratum === "scientific")
    .sort((a, b) => a.selection.drawIndex - b.selection.drawIndex)
    .map((b) => b.selection.source.keyword);
  assert.deepEqual(actual, expected);
});

// ── AC4: domain-agnostic wording (documented neutrality, spot-checked) ─────

test("authored briefs avoid obvious brand/framework names and marketing buzzwords", () => {
  // Not a proof of neutrality (see the note in briefs.mjs) — a cheap
  // regression guard against the easiest way to violate it: pasting in a
  // named methodology or a vendor/brand name.
  const bannedTerms = [
    "lean startup", "jobs to be done", "okrs", "agile", "scrum",
    "salesforce", "hubspot", "shopify", "aws", "google", "microsoft", "apple",
    "synerg", "disrupt", "growth hack", "10x", "paradigm shift",
  ];
  for (const b of BRIEFS) {
    if (b.provenance !== "authored") continue;
    const lower = b.text.toLowerCase();
    for (const term of bannedTerms) {
      assert.ok(!lower.includes(term), `${b.id} should not mention '${term}' (keeps briefs domain-agnostic)`);
    }
  }
});

test("the classic divergent-thinking stratum uses AUT ('uses for X') phrasing", () => {
  const aut = BRIEFS.filter((b) => b.stratum === "aut");
  assert.equal(aut.length, 6);
  for (const b of aut) {
    assert.match(b.text.toLowerCase(), /uses for/, `${b.id} should be phrased as an Alternate Uses Task`);
  }
});
