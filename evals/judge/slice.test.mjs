// Tests for the Si et al. slice reader (issue #24) — fully HERMETIC: every test
// builds a SYNTHETIC fixture of the slice's shape in a temp dir and never
// touches the real (gitignored, never-committed) data/si-et-al/ payload.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readSiEtAlSlice, sliceToJudgePool, normalizeTitle } from "./slice.mjs";
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

test("readSiEtAlSlice — happy path: total join, (dir,filename)-keyed conditions, per-idea expert scores", () => {
  const root = tmpRoot("happy");
  writeFixture(root);
  const slice = readSiEtAlSlice({ root });

  assert.equal(slice.ideaCount, 6);
  assert.equal(slice.reviewCount, 12);
  assert.equal(slice.nearMisses.length, 0);

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
