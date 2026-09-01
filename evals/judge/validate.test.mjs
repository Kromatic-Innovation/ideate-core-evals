// Tests for runJudgeValidation (issue #36) — fully HERMETIC: a synthetic slice
// fixture (>= MIN_IDEAS_N ideas) + MockJudgeProvider + a temp store. No network,
// no read of the real gitignored data/si-et-al/.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runJudgeValidation, judgeValidationSliceId } from "./validate.mjs";
import { MockJudgeProvider, computeJudgeHash } from "./score.mjs";
import { makeTempStore } from "../../lib/store.mjs";
import { validationKey } from "./gate.mjs";
import { JUDGE_VALIDATION_AXIS, SI_ET_AL_EXPERT_SCORE_FIELD } from "./config.mjs";

const HUMAN = 12;
const AI = 12;
const N = HUMAN + AI; // 24 >= MIN_IDEAS_N (20)
const JUDGE_MODEL = "claude-sonnet-5";

const pad = (i) => String(i).padStart(2, "0");

// Expert overall_score per idea, in slice.ideas order (Human 00..11, then AI
// 00..11 — both directory-sorted). Distinct, strictly increasing, so a perfectly
// aligned judge scores balanced accuracy 1.0 and a reversed judge scores 0.0.
const EXPERT_BY_INDEX = Array.from({ length: N }, (_, i) => i + 1);

// Build a synthetic slice of the real shape. AI rows use a `.json`-with-trailing-
// space mapping value (issue #35), so the composition exercises the extension
// normalization too. AI_Rerank is present and excluded by default.
function writeValidationFixture(root, { topicFor = () => "bias" } = {}) {
  fs.mkdirSync(root, { recursive: true });
  const humanDir = path.join(root, "Human_Ideas_Txt_Processed");
  const aiDir = path.join(root, "AI_AI_Ideas_Processed");
  const rerankDir = path.join(root, "AI_Human_Ideas_Txt");
  for (const d of [humanDir, aiDir, rerankDir]) fs.mkdirSync(d, { recursive: true });

  const csvRows = ["ID,Title / Filename"];
  const reviews = { idea_id: [], condition: [], topic: [], overall_score: [] };

  for (let i = 0; i < HUMAN; i++) {
    const id = `H${pad(i)}`;
    const title = `Human Idea ${pad(i)}`;
    csvRows.push(`${id},${title}`);
    fs.writeFileSync(path.join(humanDir, `HumanIdeaForm_${pad(i)}.txt`), `Title: ${title}\nA human idea body.\n`);
    const s = EXPERT_BY_INDEX[i];
    const topic = topicFor(i);
    reviews.idea_id.push(id, id);
    reviews.condition.push("Human", "Human");
    // Default topicFor returns a single constant topic for every idea --
    // keeps the DEFAULT (topic-grouping) path a single group/single judge
    // call, so the existing alignment assertions (provider.calls.length===1
    // etc.) hold. Multi-topic grouping is exercised by a dedicated test
    // below with a topicFor that varies.
    reviews.topic.push(topic, topic);
    reviews.overall_score.push(s, s);
  }
  for (let j = 0; j < AI; j++) {
    const id = `A${pad(j)}`;
    const slug = `ai_idea_${pad(j)}`;
    csvRows.push(`${id},${slug}.json `); // filename value with a trailing space
    fs.writeFileSync(path.join(aiDir, `${slug}.txt`), `Title: An AI Idea Number ${pad(j)}\nAn AI idea body.\n`);
    const s = EXPERT_BY_INDEX[HUMAN + j];
    const topic = topicFor(HUMAN + j);
    reviews.idea_id.push(id, id);
    reviews.condition.push("AI", "AI");
    reviews.topic.push(topic, topic);
    reviews.overall_score.push(s, s);
  }
  // An AI_Rerank review with no mapping row / idea file — excluded by default, so
  // it must not break the join.
  reviews.idea_id.push("R00");
  reviews.condition.push("AI_Rerank");
  reviews.topic.push("bias");
  reviews.overall_score.push(5);

  fs.writeFileSync(path.join(root, "id_title_mapping.csv"), csvRows.join("\n"));
  fs.writeFileSync(path.join(root, "data_points_all_anonymized.json"), JSON.stringify(reviews));
}

const tmpRoot = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `si-validate-${tag}-`));

// A mock whose originality axis is set from a per-slice-index array, so the
// alignment between judge and expert is exactly controlled.
function mockWithOriginality(byIndex) {
  return new MockJudgeProvider({
    // The non-primary axis VARIES per idea (not constant), so validateJudge's
    // spearmanRho has non-zero rank variance whichever axis a test selects.
    scoreFor: (_text, { index }) => ({
      originality: byIndex[index],
      feasibility: (index % 7) + 1,
    }),
  });
}

test("runJudgeValidation — end-to-end PASS: threads slice→pool→judge→axis→gate→record, self-describing (issue #36)", async () => {
  const root = tmpRoot("pass");
  writeValidationFixture(root);
  const store = makeTempStore("judge-validate-pass-");
  // Judge originality perfectly aligned with expert overall_score → accuracy 1.0.
  const provider = mockWithOriginality(EXPERT_BY_INDEX.slice());

  const out = await runJudgeValidation({ store, judgeProvider: provider, judgeModel: JUDGE_MODEL, sliceRoot: root });

  // Defaults are the registered mapping.
  assert.equal(out.axis, JUDGE_VALIDATION_AXIS); // "originality"
  assert.equal(out.expertColumn, SI_ET_AL_EXPERT_SCORE_FIELD); // "overall_score"
  assert.equal(out.n, N); // AI_Rerank excluded: 24 (12 Human + 12 AI), not 25
  assert.equal(out.metric, "balanced-accuracy");
  assert.equal(out.floor, 0.561);
  assert.equal(out.verdict, "pass");
  assert.ok(out.accuracy >= out.floor);

  // The exclusion rides through to the composition's result.
  assert.equal(out.exclusions.length, 1);
  assert.equal(out.exclusions[0].condition, "AI_Rerank");

  // The judge scored exactly the 24 included ideas (AI_Rerank never reached it).
  assert.equal(provider.calls.length, 1);
  assert.equal(provider.calls[0].n, N);

  // The stored record is self-describing: axis + expert column actually used.
  const judgeHash = computeJudgeHash({ judgeModels: { anthropic: [JUDGE_MODEL] } });
  const sliceId = judgeValidationSliceId({ axis: JUDGE_VALIDATION_AXIS, expertScoreField: SI_ET_AL_EXPERT_SCORE_FIELD });
  assert.equal(out.judgeHash, judgeHash);
  assert.equal(out.sliceId, sliceId);
  const stored = store.get(validationKey({ judgeHash, sliceId }));
  assert.equal(stored.result.kind, "judge-validation");
  assert.equal(stored.result.axis, "originality");
  assert.equal(stored.result.expertColumn, "overall_score");
  assert.equal(stored.result.verdict, "pass");
  assert.equal(stored.result.n, N);
});

test("runJudgeValidation — end-to-end DROP: an anti-aligned judge fails the floor and is recorded 'drop'", async () => {
  const root = tmpRoot("drop");
  writeValidationFixture(root);
  const store = makeTempStore("judge-validate-drop-");
  // Reverse the alignment → balanced accuracy 0.0 → below the 56.1% floor.
  const reversed = EXPERT_BY_INDEX.slice().reverse();
  const provider = mockWithOriginality(reversed);

  const out = await runJudgeValidation({ store, judgeProvider: provider, judgeModel: JUDGE_MODEL, sliceRoot: root });
  assert.equal(out.verdict, "drop");
  assert.ok(out.accuracy < out.floor);

  const judgeHash = computeJudgeHash({ judgeModels: { anthropic: [JUDGE_MODEL] } });
  const stored = store.get(validationKey({ judgeHash, sliceId: out.sliceId }));
  assert.equal(stored.result.verdict, "drop");
});

test("runJudgeValidation — a non-default (axis, expert column) is threaded into the record's sliceId and fields", async () => {
  const root = tmpRoot("custom-axis");
  writeValidationFixture(root);
  const store = makeTempStore("judge-validate-axis-");
  const provider = mockWithOriginality(EXPERT_BY_INDEX.slice());

  // Validate the 'feasibility' axis (varies per idea in the mock) against overall_score.
  const out = await runJudgeValidation({
    store,
    judgeProvider: provider,
    judgeModel: JUDGE_MODEL,
    axis: "feasibility",
    sliceRoot: root,
  });
  assert.equal(out.axis, "feasibility");
  assert.equal(out.expertColumn, "overall_score");
  assert.equal(out.sliceId, judgeValidationSliceId({ axis: "feasibility", expertScoreField: "overall_score" }));

  const judgeHash = computeJudgeHash({ judgeModels: { anthropic: [JUDGE_MODEL] } });
  const stored = store.get(validationKey({ judgeHash, sliceId: out.sliceId }));
  assert.equal(stored.result.axis, "feasibility");
});

test("runJudgeValidation — a failed judge run throws, never records a validation", async () => {
  const root = tmpRoot("judge-fail");
  writeValidationFixture(root);
  const store = makeTempStore("judge-validate-fail-");
  const provider = new MockJudgeProvider({ failFor: new Map([[JUDGE_MODEL, { failureKind: "transport" }]]) });

  await assert.rejects(
    () => runJudgeValidation({ store, judgeProvider: provider, judgeModel: JUDGE_MODEL, sliceRoot: root }),
    /did not complete scoring/,
  );
  // No validation record was written.
  assert.equal(store.list().filter((e) => e.key.startsWith("judge-validation|")).length, 0);
});

test("runJudgeValidation — a score/idea count mismatch throws rather than validating misaligned vectors", async () => {
  const root = tmpRoot("misaligned");
  writeValidationFixture(root);
  const store = makeTempStore("judge-validate-mis-");
  // A provider that drops the last score → 23 scores for 24 ideas.
  const provider = {
    calls: [],
    async score(payload, { judgeModel }) {
      const scores = payload.candidates
        .slice(0, -1)
        .map(() => ({ originality: 5, feasibility: 4 }));
      return { terminalState: "completed", scores, tokens: { model: judgeModel, input_tokens: 1, output_tokens: 1 } };
    },
  };
  await assert.rejects(
    () => runJudgeValidation({ store, judgeProvider: provider, judgeModel: JUDGE_MODEL, sliceRoot: root }),
    /misaligned/,
  );
});

test("runJudgeValidation — supplies the non-empty RESEARCH BRIEF the real judge requires (regression: #36 Seer CRITICAL)", async () => {
  const root = tmpRoot("brief");
  writeValidationFixture(root);
  const store = makeTempStore("judge-validate-brief-");
  // Enforce the real AnthropicJudgeProvider contract: the payload MUST carry a
  // non-empty briefText, or buildJudgeScoringPrompt throws. (MockJudgeProvider
  // ignores briefText, which is exactly why it missed this — hence this stub.)
  let seenBrief = null;
  const provider = {
    async score(payload, { judgeModel }) {
      if (typeof payload.briefText !== "string" || payload.briefText.length === 0) {
        throw new Error("stub judge: payload.briefText must be a non-empty string");
      }
      seenBrief = payload.briefText;
      const scores = payload.candidates.map((_c, index) => ({
        originality: EXPERT_BY_INDEX[index],
        feasibility: 4,
      }));
      return { terminalState: "completed", scores, tokens: { model: judgeModel, input_tokens: 1, output_tokens: 1 } };
    },
  };
  const out = await runJudgeValidation({ store, judgeProvider: provider, judgeModel: JUDGE_MODEL, sliceRoot: root });
  assert.equal(out.verdict, "pass");
  assert.ok(seenBrief && seenBrief.length > 0, "the judge must receive a non-empty research brief");
  // Default (no explicit briefText override): the brief is the idea's own
  // topic (issue #45 item 3), not a generic shared brief.
  assert.equal(seenBrief, "bias");

  // An explicitly empty briefText is rejected rather than sent to the judge.
  await assert.rejects(
    () => runJudgeValidation({ store, judgeProvider: provider, judgeModel: JUDGE_MODEL, sliceRoot: root, briefText: "" }),
    /briefText must be a non-empty string/,
  );
});

// ── issue #45 item 3: per-topic grouping ─────────────────────────────────────

test("runJudgeValidation — DEFAULT groups by each idea's own topic: one judge.score() call PER TOPIC, and scores stay aligned to their own idea", async () => {
  const root = tmpRoot("multi-topic");
  // Alternate between two topics by index parity, so the two topic groups
  // interleave through the flat slice order (0,2,4,... vs 1,3,5,...) rather
  // than occupying contiguous ranges -- this is what makes a group-local-index
  // vs. original-slice-index mixup (scores[j] vs scores[origIndex]) visible.
  writeValidationFixture(root, { topicFor: (i) => (i % 2 === 0 ? "bias" : "coding") });
  const store = makeTempStore("judge-validate-multitopic-");

  // Recover each candidate's ORIGINAL (pre-grouping) slice index from its text
  // -- the fixture's titles ("Human Idea NN" / "An AI Idea Number NN") encode
  // it -- and score it with EXACTLY that idea's own expert score. Since
  // EXPERT_BY_INDEX is strictly increasing and distinct per idea, a judge that
  // reproduces it exactly can ONLY do so if every score actually landed back
  // on its own idea after the per-topic score() calls are re-assembled; any
  // misalignment (e.g. writing to the group-local index instead of the
  // original slice index) scrambles the vector and balanced accuracy drops
  // below a perfect 1.0.
  const decodeIndex = (text) => {
    const human = text.match(/Human Idea (\d+)/);
    if (human) return Number(human[1]);
    const ai = text.match(/AI Idea Number (\d+)/);
    if (ai) return HUMAN + Number(ai[1]);
    throw new Error(`test fixture text didn't match either title pattern: ${text}`);
  };

  const briefsSeen = [];
  const provider = {
    calls: [],
    async score(payload, { judgeModel }) {
      this.calls.push({ briefText: payload.briefText, n: payload.candidates.length });
      briefsSeen.push(payload.briefText);
      const scores = payload.candidates.map((c) => ({
        originality: EXPERT_BY_INDEX[decodeIndex(c.text)],
        feasibility: 4,
      }));
      return { terminalState: "completed", scores, tokens: { model: judgeModel, input_tokens: 1, output_tokens: 1 } };
    },
  };

  const out = await runJudgeValidation({ store, judgeProvider: provider, judgeModel: JUDGE_MODEL, sliceRoot: root });

  // Exactly one call per distinct topic, never one call for the whole slice.
  assert.equal(provider.calls.length, 2, "two distinct topics -> two judge.score() calls");
  assert.deepEqual(new Set(briefsSeen), new Set(["bias", "coding"]), "each call's briefText is the topic itself");
  // Every idea in the (24-idea) slice reached SOME call, split across the two
  // topic groups (12 even-indexed "bias", 12 odd-indexed "coding").
  const totalScored = provider.calls.reduce((sum, c) => sum + c.n, 0);
  assert.equal(totalScored, N);
  assert.deepEqual(provider.calls.map((c) => c.n).sort(), [12, 12]);

  // THE alignment assertion: a judge score vector that is a per-idea-perfect
  // reproduction of the (strictly increasing, all-distinct) expert vector
  // scores balanced accuracy exactly 1.0 -- and can only do so if re-assembly
  // put each topic-group score back at its own idea's original slice index.
  assert.equal(out.accuracy, 1.0, "judge scores must land back on their own idea after per-topic re-assembly");
  assert.equal(out.verdict, "pass");
});

test("runJudgeValidation — a missing topic on an included idea fails loud (no silent fallback to a generic brief)", async () => {
  const root = tmpRoot("no-topic");
  writeValidationFixture(root, { topicFor: (i) => (i === 0 ? "" : "bias") }); // idea 0 has no topic
  const store = makeTempStore("judge-validate-notopic-");
  const provider = mockWithOriginality(EXPERT_BY_INDEX.slice());
  await assert.rejects(
    () => runJudgeValidation({ store, judgeProvider: provider, judgeModel: JUDGE_MODEL, sliceRoot: root }),
    /has no non-empty 'topic'/,
  );
});

test("runJudgeValidation — validates its arguments", async () => {
  const store = makeTempStore("judge-validate-args-");
  const provider = mockWithOriginality(EXPERT_BY_INDEX.slice());
  await assert.rejects(() => runJudgeValidation({ judgeProvider: provider, judgeModel: JUDGE_MODEL }), /store is required/);
  await assert.rejects(() => runJudgeValidation({ store, judgeModel: JUDGE_MODEL }), /judgeProvider with a \.score/);
  await assert.rejects(() => runJudgeValidation({ store, judgeProvider: provider }), /judgeModel is required/);
});
