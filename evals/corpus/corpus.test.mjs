// corpus.test.mjs — hermetic tests for the frozen 48-brief corpus (issues #2, #43, #129).
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

import {
  BRIEFS,
  CORPUS,
  CORPUS_HASH,
  corpusHash,
  briefContentHash,
  validateCorpus,
  PRE_AMENDMENT_BRIEF_IDS,
  preAmendmentCorpusHash,
} from "./index.mjs";
import { ANCHOR_SOURCE } from "./briefs.mjs";
import { LIVEIDEABENCH_KEYWORDS, SOURCE as LIVEIDEABENCH_SOURCE } from "./liveideabench-keywords.mjs";
import {
  sampleKeywords,
  mulberry32,
  SCIENTIFIC_SAMPLE_SEED,
  SCIENTIFIC_SAMPLE_COUNT,
} from "./sample.mjs";
import { configHash } from "../../lib/manifest.mjs";

// ── AC1: 48 briefs, correct stratum split, provenance recorded ─────────────

test("the corpus has exactly 48 briefs", () => {
  assert.equal(BRIEFS.length, 48);
  assert.equal(CORPUS, BRIEFS, "CORPUS is the same frozen array BRIEFS exports");
});

test("stratum counts are exactly 6 business / 6 product / 23 scientific / 12 aut / 1 anchor", () => {
  const counts = { business: 0, product: 0, scientific: 0, aut: 0, anchor: 0 };
  for (const b of BRIEFS) counts[b.stratum] = (counts[b.stratum] || 0) + 1;
  assert.deepEqual(counts, { business: 6, product: 6, scientific: 23, aut: 12, anchor: 1 });
});

test("every brief id is unique and stable (string)", () => {
  const ids = BRIEFS.map((b) => b.id);
  assert.equal(new Set(ids).size, 48, "all 48 ids are distinct");
  for (const id of ids) assert.equal(typeof id, "string");
});

test("every brief carries provenance, and sampled/verbatim briefs carry a source", () => {
  for (const b of BRIEFS) {
    assert.ok(
      b.provenance === "authored" || b.provenance === "sampled" || b.provenance === "verbatim",
      `${b.id} has valid provenance`,
    );
    if (b.provenance === "sampled") {
      assert.ok(b.selection, `${b.id} is sampled and must carry selection metadata`);
      assert.ok(b.selection.source, `${b.id} is sampled and must carry a source reference`);
      assert.equal(typeof b.selection.algorithm, "string");
      assert.equal(typeof b.selection.seed, "number");
    } else {
      assert.equal(b.selection, undefined, `${b.id} is not sampled and should not carry sampling metadata`);
    }
    if (b.provenance === "verbatim") {
      assert.ok(b.source, `${b.id} is verbatim and must carry a source record`);
      assert.equal(typeof b.source.citation, "string");
      assert.equal(typeof b.source.location, "string");
      assert.equal(typeof b.source.comparabilityCaveat, "string");
    } else {
      assert.equal(b.source, undefined, `${b.id} is not verbatim and should not carry a source record`);
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
  assert.equal(sci.length, 23);
  for (const b of sci) {
    assert.equal(b.provenance, "sampled");
    assert.equal(b.selection.source.repo, "x66ccff/liveideabench");
    assert.equal(b.selection.source.arxiv, "2412.17596");
    assert.ok(b.selection.source.commitSha, `${b.id} records a source commit SHA`);
    assert.ok(b.selection.source.keyword, `${b.id} records which keyword it sampled`);
  }
});

test("the anchor stratum is exactly 1 brief, provenance: verbatim, sourced from Meincke/Girotra", () => {
  const anchor = BRIEFS.filter((b) => b.stratum === "anchor");
  assert.equal(anchor.length, 1);
  const [a] = anchor;
  assert.equal(a.id, "anchor-01");
  assert.equal(a.provenance, "verbatim");
  assert.equal(a.source, ANCHOR_SOURCE, "the shipped brief references the shared ANCHOR_SOURCE record");
});

test("validateCorpus accepts the frozen corpus and rejects malformed ones", () => {
  assert.doesNotThrow(() => validateCorpus(BRIEFS));
  assert.throws(() => validateCorpus(BRIEFS.slice(0, 47)), /expected exactly 48/);
  const withDuplicateId = [...BRIEFS.slice(0, 47), { ...BRIEFS[47], id: BRIEFS[0].id }];
  assert.throws(() => validateCorpus(withDuplicateId), /duplicate brief id/);

  const wrongStratum = BRIEFS.slice(0, 47).concat([{ ...BRIEFS[47], stratum: "business" }]);
  assert.throws(() => validateCorpus(wrongStratum), /expected \d+/);
});

test("validateCorpus rejects a verbatim brief missing citation/location/caveat", () => {
  const base = BRIEFS.find((b) => b.provenance === "verbatim");
  const missingCitation = BRIEFS.map((b) =>
    b.id === base.id ? { ...b, source: { ...b.source, citation: undefined } } : b,
  );
  assert.throws(() => validateCorpus(missingCitation), /missing source\.citation/);

  const missingLocation = BRIEFS.map((b) =>
    b.id === base.id ? { ...b, source: { ...b.source, location: undefined } } : b,
  );
  assert.throws(() => validateCorpus(missingLocation), /missing source\.location/);

  const missingCaveat = BRIEFS.map((b) =>
    b.id === base.id ? { ...b, source: { ...b.source, comparabilityCaveat: undefined } } : b,
  );
  assert.throws(() => validateCorpus(missingCaveat), /missing source\.comparabilityCaveat/);
});

// ── #129 part D/E: additive expansion — the pre-amendment 24 are unchanged ──

test("the retained 24 pre-amendment briefs have unchanged content hashes (additive, not mutating)", () => {
  // This is the guard on the "additive, not mutating" requirement: it fails
  // the instant any of biz-01..06 / prod-01..06 / sci-01..06 / aut-01..06's
  // TEXT is edited, even by one character, regardless of what else changed
  // in the corpus. Frozen expected hashes below are sha256(text).slice(0,12)
  // computed once and pinned, not re-derived from BRIEFS — a re-derivation
  // would pass even if every one of these briefs had been silently reworded.
  const EXPECTED_HASHES = {
    "biz-01": "c1127c1437dc",
    "biz-02": "da6d1183fb18",
    "biz-03": "44235a18e213",
    "biz-04": "cd45f07e8e75",
    "biz-05": "a8f7bdeb12c2",
    "biz-06": "dc5c969c290f",
    "prod-01": "5ac2244dbc86",
    "prod-02": "a47a602e8da9",
    "prod-03": "11d3c5312073",
    "prod-04": "9fd530d56b68",
    "prod-05": "fc773c5d8f60",
    "prod-06": "de3be252a792",
    "sci-01": "92f0e9016862",
    "sci-02": "23fbe36778c0",
    "sci-03": "be6b36503e31",
    "sci-04": "3b5b4380d80c",
    "sci-05": "f6d97de96e94",
    "sci-06": "cdcf3e45da62",
    "aut-01": "1847fa011c50",
    "aut-02": "16314a95a9a9",
    "aut-03": "4c1786b7c6fb",
    "aut-04": "2edbb5009cef",
    "aut-05": "e1c7003f1877",
    "aut-06": "dcba7d2a0394",
  };
  assert.equal(Object.keys(EXPECTED_HASHES).length, PRE_AMENDMENT_BRIEF_IDS.length);
  for (const id of PRE_AMENDMENT_BRIEF_IDS) {
    const brief = BRIEFS.find((b) => b.id === id);
    assert.ok(brief, `${id} still exists in the corpus`);
    assert.equal(briefContentHash(brief), EXPECTED_HASHES[id], `${id} content hash is unchanged`);
  }
});

test("the pre-amendment corpus (24 briefs) reconstructs to the previously-registered hash 55e05c2811a7", () => {
  // §3.2/§11: adding a brief invalidates the pre-registration, hence the
  // amendment. This test is the actual reconstructibility claim: filtering
  // the CURRENT 48-brief corpus down to PRE_AMENDMENT_BRIEF_IDS and hashing
  // it must reproduce the hash docs/PREREGISTRATION.md already registered
  // for the 24-brief corpus (Appendix B item 13) — not a hash we assert
  // matches itself, but the actual prior artifact.
  assert.equal(preAmendmentCorpusHash(BRIEFS), "55e05c2811a7");
});

test("preAmendmentCorpusHash throws if a pre-amendment brief id is missing", () => {
  const withoutOne = BRIEFS.filter((b) => b.id !== "biz-01");
  assert.throws(() => preAmendmentCorpusHash(withoutOne), /expected 24 pre-amendment briefs/);
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
  assert.equal(new Set(hashes).size, 48);
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
  assert.equal(aut.length, 12);
  for (const b of aut) {
    assert.match(b.text.toLowerCase(), /uses for/, `${b.id} should be phrased as an Alternate Uses Task`);
  }
});

test("extending the scientific sample count (6 -> 23, #129) preserves the prior draw prefix", () => {
  const before = sampleKeywords(LIVEIDEABENCH_KEYWORDS, 6, SCIENTIFIC_SAMPLE_SEED);
  const after = sampleKeywords(LIVEIDEABENCH_KEYWORDS, SCIENTIFIC_SAMPLE_COUNT, SCIENTIFIC_SAMPLE_SEED);
  assert.deepEqual(after.slice(0, 6), before, "sci-01..sci-06's keywords are unchanged by the #129 expansion");
});

// ── #129 part D: the anchor brief is transcribed verbatim, not paraphrased ──

test("the anchor brief text matches the transcribed Meincke et al. Base Prompt exactly", () => {
  const anchor = BRIEFS.find((b) => b.stratum === "anchor");
  const expected =
    "Generate new product ideas with the following requirements: The product will " +
    "target college students in the United States. It should be a physical good, " +
    "not a service or software. I'd like a product that could be sold at a retail " +
    "price of less than about USD 50. The ideas are just ideas. The product need " +
    "not yet exist, nor may it necessarily be clearly feasible. Number all ideas " +
    "and give them a name. The name and idea are separated by a colon. Please " +
    "generate 100 ideas as 100 separate paragraphs. The idea should be expressed " +
    "as a paragraph of 40-80 words.";
  assert.equal(anchor.text, expected);
  assert.match(anchor.text, /40-80 words/, "keeps the paper's exact word-count phrasing");
  assert.doesNotMatch(anchor.text, /40[–—]80/, "not a smart-dash substitution of the paper's hyphen");
});

test("the anchor source correctly attributes FOUR authors to the 2023 paper (issue #129's own citation omits Meincke)", () => {
  assert.match(ANCHOR_SOURCE.citation, /Girotra, K\., Meincke, L\., Terwiesch, C\., & Ulrich, K\. T\./);
  assert.match(ANCHOR_SOURCE.citation, /2023/);
  assert.match(ANCHOR_SOURCE.secondaryCitation, /Meincke, L\., Mollick, E\., & Terwiesch, C\./);
  assert.match(ANCHOR_SOURCE.secondaryCitation, /2024/);
});

test("the anchor source states the embedding-model comparability caveat, not matched numbers", () => {
  assert.match(ANCHOR_SOURCE.comparabilityCaveat, /NOT portable/i);
  assert.match(ANCHOR_SOURCE.comparabilityCaveat, /Universal Sentence Encoder/);
  assert.match(ANCHOR_SOURCE.comparabilityCaveat, /Voyage/);
  assert.match(ANCHOR_SOURCE.comparabilityCaveat, /dramatically different results/);
  assert.doesNotMatch(
    ANCHOR_SOURCE.comparabilityCaveat,
    /is comparable/i,
    "must not imply the published cosine numbers are directly comparable",
  );
});

test("the anchor source records the Mack Institute URL, its retrieval date, and the SSRN version-risk caveat", () => {
  assert.match(ANCHOR_SOURCE.retrievedFrom, /mackinstitute\.wharton\.upenn\.edu/);
  assert.match(ANCHOR_SOURCE.retrievedFrom, /2026-09-08/);
  assert.match(ANCHOR_SOURCE.versionRisk, /SSRN 4526071/);
  assert.match(ANCHOR_SOURCE.versionRisk, /403/);
});

test("the anchor source records the human-prompt caveat verbatim from Girotra et al.", () => {
  assert.match(ANCHOR_SOURCE.humanPromptCaveat, /essentially the same prompt we gave the/);
  assert.match(ANCHOR_SOURCE.humanPromptCaveat, /not a transcript/);
});
