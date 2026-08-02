// Tests for the Si et al. slice reader (issue #24) — fully HERMETIC: every test
// builds a SYNTHETIC fixture of the slice's shape in a temp dir and never
// touches the real (gitignored, never-committed) data/si-et-al/ payload.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readSiEtAlSlice, sliceToJudgePool, normalizeTitle, stripMappingExtension } from "./slice.mjs";
import { deidentifyPool } from "./deidentify.mjs";

// The fixture mirrors the real layout, including the deliberate AI/AI_Rerank
// filename COLLISION (both carry gamma_idea.txt / delta_idea.txt) so the
// (directory, filename) join key is exercised, and human files NOT named by
// title (so the Title:-line join is exercised).
function writeFixture(root, { extraReviewIdeaId, extraHumanFile } = {}) {
  fs.mkdirSync(root, { recursive: true });
  const csv = [
    "ID,Title",
    "H1,Alpha Title",
    "H2,Beta Title",
    "A1,Gamma Idea",
    "A2,Delta Idea",
    "R1,Gamma Idea",
    "R2,Delta Idea",
  ].join("\n");
  fs.writeFileSync(path.join(root, "id_title_mapping.csv"), csv);

  const reviews = {
    idea_id: ["H1", "H1", "H2", "H2", "A1", "A1", "A2", "A2", "R1", "R1", "R2", "R2"],
    condition: ["Human", "Human", "Human", "Human", "AI", "AI", "AI", "AI", "AI_Rerank", "AI_Rerank", "AI_Rerank", "AI_Rerank"],
    overall_score: [4, 5, 3, 2, 7, 8, 6, 6, 5, 5, 9, 7],
  };
  if (extraReviewIdeaId) {
    reviews.idea_id.push(extraReviewIdeaId);
    reviews.condition.push("Human");
    reviews.overall_score.push(5);
  }
  fs.writeFileSync(path.join(root, "data_points_all_anonymized.json"), JSON.stringify(reviews));

  const dirs = {
    Human_Ideas_Txt_Processed: [
      ["HumanIdeaForm_Aryaman.txt", "Title: Alpha Title\nA human-written idea body. No name in the body.\n"],
      ["IdeaGeneration_Abe.txt", "Title: Beta Title\nAnother human idea body.\n"],
    ],
    AI_AI_Ideas_Processed: [
      ["gamma_idea.txt", "Title: Gamma Idea\nAn AI idea body.\n"],
      ["delta_idea.txt", "Title: Delta Idea\nAnother AI idea body.\n"],
    ],
    AI_Human_Ideas_Txt: [
      ["gamma_idea.txt", "Title: Gamma Idea\nA reranked idea body.\n"],
      ["delta_idea.txt", "Title: Delta Idea\nAnother reranked idea body.\n"],
    ],
  };
  if (extraHumanFile) {
    dirs.Human_Ideas_Txt_Processed.push(["IdeaGeneration_Zed.txt", "Title: Unlisted Title\nAn idea with no CSV entry.\n"]);
  }
  for (const [dir, files] of Object.entries(dirs)) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
    for (const [name, body] of files) fs.writeFileSync(path.join(root, dir, name), body);
  }
}

function tmpRoot(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `si-slice-${tag}-`));
}

test("normalizeTitle bridges slug and human-typed titles", () => {
  assert.equal(normalizeTitle("Gamma Idea"), "gamma idea");
  assert.equal(normalizeTitle("gamma_idea"), "gamma idea");
  assert.equal(normalizeTitle("  Bias, few-shot!  "), "bias few shot");
});

test("readSiEtAlSlice — full join (no exclusions): total join, (dir,filename)-keyed conditions, per-idea expert scores", () => {
  const root = tmpRoot("happy");
  writeFixture(root);
  // Exercise the full three-condition join (incl. the AI/AI_Rerank collision)
  // by opting OUT of the default AI_Rerank exclusion.
  const slice = readSiEtAlSlice({ root, excludedConditions: [] });

  assert.equal(slice.ideaCount, 6);
  assert.equal(slice.reviewCount, 12);
  assert.equal(slice.nearMisses.length, 0);
  assert.equal(slice.exclusions.length, 0);

  const byId = new Map(slice.ideas.map((i) => [i.ideaId, i]));
  // The AI/AI_Rerank filename collision resolves to DISTINCT ideas via the
  // directory (condition) key.
  assert.equal(byId.get("A1").condition, "AI");
  assert.equal(byId.get("R1").condition, "AI_Rerank");
  assert.deepEqual(byId.get("A1").expertScores, [7, 8]);
  assert.deepEqual(byId.get("R2").expertScores, [9, 7]);
  // Human join ran off the Title: line, not the (name-bearing) filename.
  assert.equal(byId.get("H1").condition, "Human");
  assert.deepEqual(byId.get("H1").expertScores, [4, 5]);
  assert.ok(byId.get("H1").text.includes("human-written idea body"));

  // Leakage boundary: the reader output carries NO filename/path field.
  for (const idea of slice.ideas) {
    assert.deepEqual(Object.keys(idea).sort(), ["condition", "expertScores", "ideaId", "text"]);
  }
});

test("readSiEtAlSlice — FAILS LOUD when the slice is absent (never falls back)", () => {
  const missing = path.join(os.tmpdir(), "si-slice-does-not-exist-" + process.pid);
  assert.throws(() => readSiEtAlSlice({ root: missing }), /slice is not present/);
});

test("readSiEtAlSlice — throws when a required slice file is missing", () => {
  const root = tmpRoot("incomplete");
  writeFixture(root);
  fs.rmSync(path.join(root, "id_title_mapping.csv"));
  assert.throws(() => readSiEtAlSlice({ root }), /required slice file missing/);
});

test("readSiEtAlSlice — totality: a review idea_id with no idea file THROWS (no silent shrink)", () => {
  const root = tmpRoot("partial-reviews");
  writeFixture(root, { extraReviewIdeaId: "X9" });
  assert.throws(() => readSiEtAlSlice({ root }), /resolved to no idea file/);
});

test("readSiEtAlSlice — totality: an idea file that resolves to no idea_id THROWS", () => {
  const root = tmpRoot("near-miss");
  writeFixture(root, { extraHumanFile: true });
  assert.throws(() => readSiEtAlSlice({ root }), /did not resolve to an idea_id/);
});

test("sliceToJudgePool + deidentifyPool — the judge sees TEXT ONLY; no filename/condition/path leaks", () => {
  const root = tmpRoot("leak");
  writeFixture(root);
  const slice = readSiEtAlSlice({ root });
  const pool = sliceToJudgePool(slice);
  const judgeInputs = deidentifyPool(pool); // re-assert text-only at the choke point

  const serialized = JSON.stringify(judgeInputs);
  // The strong guarantee is STRUCTURAL: the condition label is not a field on
  // the judge input — it was dropped, not merely omitted. (A substring scan for
  // "AI"/"Human" would false-positive on idea prose that legitimately discusses
  // AI — which is exactly why the structural drop, not a text scrub, is the
  // control here; cf. PREREGISTRATION §5.3 and deidentify.mjs.)
  for (const idea of judgeInputs) {
    assert.deepEqual(Object.keys(idea), ["text"], "a judge input must carry only text");
  }
  // No filename / directory / idea_id (none of which appear in the idea prose)
  // reaches the judge payload.
  for (const leak of ["HumanIdeaForm_Aryaman", "IdeaGeneration_Abe", "gamma_idea", "delta_idea", "AI_AI_Ideas_Processed", "H1", "A1", "R1"]) {
    assert.ok(!serialized.includes(leak), `identifier '${leak}' must not reach the judge payload`);
  }
});

// ── issue #35: the join repair ──────────────────────────────────────────────

test("stripMappingExtension — strips a .json/.txt extension and stray whitespace, leaving prose titles alone", () => {
  assert.equal(stripMappingExtension("temporal_bias_decay_simulation.json "), "temporal_bias_decay_simulation");
  assert.equal(stripMappingExtension("  foo.txt"), "foo");
  assert.equal(stripMappingExtension("A Prose Title"), "A Prose Title"); // untouched
  assert.equal(stripMappingExtension("ends.in.dots"), "ends.in.dots"); // only .json/.txt stripped
});

test("readSiEtAlSlice — AI_Rerank is excluded by default, explicitly and reportedly (issue #35)", () => {
  const root = tmpRoot("exclude");
  writeFixture(root);
  const slice = readSiEtAlSlice({ root }); // default excludedConditions = ["AI_Rerank"]

  // Only Human + AI survive; AI_Rerank (R1, R2) is dropped whole — not near-missed.
  assert.equal(slice.ideaCount, 4);
  assert.ok(slice.ideas.every((i) => i.condition !== "AI_Rerank"));
  assert.equal(slice.nearMisses.length, 0);

  // The exclusion is REPORTED, not swallowed: condition, dir, reason, fileCount —
  // so it reaches the validation record and REPORT.md downstream.
  assert.equal(slice.exclusions.length, 1);
  const ex = slice.exclusions[0];
  assert.equal(ex.condition, "AI_Rerank");
  assert.equal(ex.dir, "AI_Human_Ideas_Txt");
  assert.equal(ex.fileCount, 2);
  assert.match(ex.reason, /AI_Rerank excluded/);
});

test("readSiEtAlSlice — exclusion is NOT a 'drop what doesn't join' path: an unresolved INCLUDED-condition file still throws", () => {
  const root = tmpRoot("exclude-failclosed");
  writeFixture(root, { extraHumanFile: true }); // an unlisted Human (included) file
  // AI_Rerank is excluded by default, but the fail-closed contract survives for
  // the INCLUDED Human condition: the unresolved file throws.
  assert.throws(() => readSiEtAlSlice({ root }), /did not resolve to an idea_id/);
});

test("readSiEtAlSlice — AI '.json'-filename mapping value (with trailing space) joins via extension normalization (issue #35)", () => {
  const root = tmpRoot("json-value");
  fs.mkdirSync(root, { recursive: true });
  // The AI row's second column is a `.json` FILENAME with a trailing space —
  // exactly the released mapping's shape — not the prose title the file carries.
  const csv = ["ID,Title / Filename", "A1,temporal_bias_decay_simulation.json "].join("\n");
  fs.writeFileSync(path.join(root, "id_title_mapping.csv"), csv);
  fs.writeFileSync(
    path.join(root, "data_points_all_anonymized.json"),
    JSON.stringify({ idea_id: ["A1", "A1"], condition: ["AI", "AI"], overall_score: [7, 8] }),
  );
  // Title: line is PROSE (would not match the `.json` value); the filename stem
  // is the slug that matches once the extension + trailing space are stripped.
  fs.mkdirSync(path.join(root, "AI_AI_Ideas_Processed"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "AI_AI_Ideas_Processed", "temporal_bias_decay_simulation.txt"),
    "Title: Temporal Bias Decay via Adaptive Simulation\nAn AI idea body.\n",
  );
  fs.mkdirSync(path.join(root, "Human_Ideas_Txt_Processed"), { recursive: true });
  fs.mkdirSync(path.join(root, "AI_Human_Ideas_Txt"), { recursive: true }); // excluded

  const slice = readSiEtAlSlice({ root });
  assert.equal(slice.ideaCount, 1);
  assert.equal(slice.ideas[0].ideaId, "A1");
  assert.equal(slice.ideas[0].condition, "AI");
  assert.deepEqual(slice.ideas[0].expertScores, [7, 8]);
});

test("readSiEtAlSlice — a hand-resolved override binds a straggler whose Title: line matches nothing (issue #35, Soham-shaped)", () => {
  const root = tmpRoot("handresolved");
  fs.mkdirSync(root, { recursive: true });
  const csv = ["ID,Title", "H1,Alpha Title", "S1,Some Registered Title"].join("\n");
  fs.writeFileSync(path.join(root, "id_title_mapping.csv"), csv);
  fs.writeFileSync(
    path.join(root, "data_points_all_anonymized.json"),
    JSON.stringify({ idea_id: ["H1", "S1"], condition: ["Human", "Human"], overall_score: [4, 6] }),
  );
  fs.mkdirSync(path.join(root, "Human_Ideas_Txt_Processed"), { recursive: true });
  fs.writeFileSync(path.join(root, "Human_Ideas_Txt_Processed", "HumanIdeaForm_A.txt"), "Title: Alpha Title\nbody\n");
  // The straggler: its Title: line and filename stem normalize to nothing in the
  // mapping — the IdeaGeneration_Soham.txt shape.
  fs.writeFileSync(path.join(root, "Human_Ideas_Txt_Processed", "IdeaGeneration_Soham.txt"), "Title: Untitled Draft\nbody\n");
  fs.mkdirSync(path.join(root, "AI_AI_Ideas_Processed"), { recursive: true });
  fs.mkdirSync(path.join(root, "AI_Human_Ideas_Txt"), { recursive: true });

  // Without an override the straggler is fail-closed.
  assert.throws(() => readSiEtAlSlice({ root }), /did not resolve to an idea_id/);

  // With a hand-resolved override it binds DIRECTLY to the review idea_id.
  const slice = readSiEtAlSlice({
    root,
    handResolved: { "Human_Ideas_Txt_Processed/IdeaGeneration_Soham.txt": "S1" },
  });
  assert.equal(slice.ideaCount, 2);
  const soham = slice.ideas.find((i) => i.ideaId === "S1");
  assert.ok(soham, "the straggler must resolve via the override");
  assert.deepEqual(soham.expertScores, [6]);
});

test("readSiEtAlSlice — a review idea_id with an UNKNOWN (unlabeled) condition is fail-closed, not silently dropped (issue #35)", () => {
  const root = tmpRoot("undef-condition");
  fs.mkdirSync(root, { recursive: true });
  const csv = ["ID,Title", "H1,Alpha Title", "U1,Unknown Title"].join("\n");
  fs.writeFileSync(path.join(root, "id_title_mapping.csv"), csv);
  // U1's review carries a null (label-lost) condition — neither a known condition
  // nor an excluded one. It must still resolve to a file — or the join throws.
  fs.writeFileSync(
    path.join(root, "data_points_all_anonymized.json"),
    JSON.stringify({ idea_id: ["H1", "U1"], condition: ["Human", null], overall_score: [4, 6] }),
  );
  fs.mkdirSync(path.join(root, "Human_Ideas_Txt_Processed"), { recursive: true });
  fs.writeFileSync(path.join(root, "Human_Ideas_Txt_Processed", "HumanIdeaForm_A.txt"), "Title: Alpha Title\nbody\n");
  fs.mkdirSync(path.join(root, "AI_AI_Ideas_Processed"), { recursive: true });
  fs.mkdirSync(path.join(root, "AI_Human_Ideas_Txt"), { recursive: true });

  // U1 has no idea file and is NOT excluded → the reverse totality assertion
  // catches it rather than the exclusion filter bypassing it.
  assert.throws(() => readSiEtAlSlice({ root }), /resolved to no idea file/);
});

test("readSiEtAlSlice — a hand-resolved override to an unknown or wrong-condition idea_id throws (no silent mis-bind)", () => {
  const root = tmpRoot("handresolved-bad");
  fs.mkdirSync(root, { recursive: true });
  const csv = ["ID,Title", "H1,Alpha Title", "A1,Gamma Idea"].join("\n");
  fs.writeFileSync(path.join(root, "id_title_mapping.csv"), csv);
  fs.writeFileSync(
    path.join(root, "data_points_all_anonymized.json"),
    JSON.stringify({ idea_id: ["H1", "A1"], condition: ["Human", "AI"], overall_score: [4, 7] }),
  );
  fs.mkdirSync(path.join(root, "Human_Ideas_Txt_Processed"), { recursive: true });
  fs.writeFileSync(path.join(root, "Human_Ideas_Txt_Processed", "HumanIdeaForm_A.txt"), "Title: Alpha Title\nbody\n");
  fs.writeFileSync(path.join(root, "Human_Ideas_Txt_Processed", "IdeaGeneration_Soham.txt"), "Title: Untitled\nbody\n");
  fs.mkdirSync(path.join(root, "AI_AI_Ideas_Processed"), { recursive: true });
  fs.writeFileSync(path.join(root, "AI_AI_Ideas_Processed", "gamma_idea.txt"), "Title: Gamma Idea\nbody\n");
  fs.mkdirSync(path.join(root, "AI_Human_Ideas_Txt"), { recursive: true });

  // Unknown idea_id.
  assert.throws(
    () => readSiEtAlSlice({ root, handResolved: { "Human_Ideas_Txt_Processed/IdeaGeneration_Soham.txt": "NOPE" } }),
    /not present in the reviews/,
  );
  // Wrong condition (binds a Human file to an AI review).
  assert.throws(
    () => readSiEtAlSlice({ root, handResolved: { "Human_Ideas_Txt_Processed/IdeaGeneration_Soham.txt": "A1" } }),
    /binds a file in condition 'Human' to a review under condition 'AI'/,
  );
});
