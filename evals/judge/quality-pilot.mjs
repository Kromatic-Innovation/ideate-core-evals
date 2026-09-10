#!/usr/bin/env node
// The Stage 1c QUALITY read -- docs/PREREGISTRATION.md Appendix N item 6.
//
//   node evals/judge/quality-pilot.mjs --dry-run   # plan and price, calls nothing
//   node evals/judge/quality-pilot.mjs             # run it
//
// WHAT THIS IS, AND WHAT IT IS NOT.
//
// Stage 1c established that a rich panel yields ~1.67 more DISTINCT ideas than
// one solo call (Appendix M item 9). `distinct_k` is distinctness, not merit,
// and the `weirdo` persona -- prompted for strangeness, and the single largest
// contributor of output tokens in the arm -- is exactly the slot that could be
// buying distinctness with incoherence. Nothing in the study measures that.
//
// This does. It is registered as DESCRIPTIVE AND NON-CONFIRMATORY (Appendix N
// item 6) and everything about it is built to keep it that way:
//
//   - It computes NO p-value and NO contrast. A handful of cells has no power
//     for an arm difference. It is a look, not a test.
//   - It re-scores ALREADY-STORED candidate text. No cell is re-collected and
//     no generation call is made.
//   - It writes to its OWN store, keyed by the source cellKey. Judge output
//     never goes back into results-study1c: judgeHash is a CONFIG_FIELDS entry,
//     so writing it in-store would restate every cell's identity and strand the
//     431 cells already paid for.
//   - It runs regardless of the §5.1 gate's verdict. Per §5.4 a `drop` removes
//     idea-level metrics from the study's CONFIRMATORY claims; it does not
//     forbid looking at the ideas and saying what is there.
//
// The judge is the one validated in Appendix N item 9 (pass, 0.5833 vs a 0.561
// floor) -- the same prompt, model and request shape, reached through the same
// provider. Its limits travel with it: that pass sits inside the answer key's
// own bootstrap CI, so it means the judge is not distinguishable from human
// reviewers at n=98, not that it is good.
//
// DE-IDENTIFICATION. Only candidate TEXT reaches the judge (§5.3). Persona is
// held locally, by index, and joined back to the scores afterwards -- so a
// per-persona breakdown is possible without the judge ever seeing a label.
import { ResultsStore } from "../../lib/store.mjs";
import { AnthropicJudgeProvider, computeJudgeHash } from "./score.mjs";
import { JUDGE_MODELS } from "./config.mjs";
import { BRIEFS } from "../corpus/briefs.mjs";

const SOURCE_STORE = "results-study1c";
const OUT_STORE = "results-quality-pilot";
const JUDGE_MODEL = JUDGE_MODELS.anthropic[0];
const MODE = "single";

// The arms compared. S1C-SOLO6X10 is deliberately omitted: its pool collapses
// to ~15 distinct ideas out of 60, so a per-candidate quality mean over it is
// dominated by near-duplicates and answers a different question.
const ARMS = ["S1C-RICH", "S1C-SOLO60"];

// Matched briefs, one replicate each, spanning all three corpus strata so the
// read is not an artefact of one kind of problem. Fixed here rather than
// sampled at run time: a "look" that draws different cells each invocation is
// not reproducible, and picking cells after seeing scores would be selection.
const BRIEF_IDS = ["biz-02", "biz-07", "sci-05", "sci-08", "prod-03", "prod-07"];
const REPLICATE = 1;

const dryRun = process.argv.includes("--dry-run");
const briefText = new Map(BRIEFS.map((b) => [b.id, b.text]));
const src = new ResultsStore(SOURCE_STORE);

// Collect the target cells. `state === "completed"` only -- a failed cell has no
// pool to score.
const targets = [];
for (const entry of src.list()) {
  if (!ARMS.includes(entry.armId)) continue;
  if (!BRIEF_IDS.includes(entry.briefId)) continue;
  if (entry.replicate !== REPLICATE) continue;
  if (entry.state !== "completed") continue;
  targets.push(entry);
}
targets.sort((a, b) => a.key.localeCompare(b.key));

let totalCandidates = 0;
for (const t of targets) totalCandidates += src.get(t.key).result.candidates.length;

console.log("Stage 1c quality read -- DESCRIPTIVE, non-confirmatory (Appendix N item 6)");
console.log(`  source store  : ${SOURCE_STORE}`);
console.log(`  arms          : ${ARMS.join(", ")}`);
console.log(`  briefs        : ${BRIEF_IDS.join(", ")}  (replicate ${REPLICATE})`);
console.log(`  cells         : ${targets.length}`);
console.log(`  candidates    : ${totalCandidates}  (= judge calls)`);
console.log(`  judge         : ${JUDGE_MODEL}  mode=${MODE}  thinking=disabled`);
console.log(`  judgeHash     : ${computeJudgeHash({ judgeModels: { anthropic: [JUDGE_MODEL] } })}`);
console.log(`  out store     : ${OUT_STORE}`);
for (const t of targets) console.log(`    - ${t.key}`);
console.log();
console.log("  NO p-value and NO contrast is computed. A handful of cells has no power for");
console.log("  an arm difference; this is a look, not a test.");
console.log();

if (dryRun) {
  console.log("--dry-run: nothing was called and nothing was stored.");
  process.exit(0);
}
if (!process.env.ANTHROPIC_API_KEY) {
  console.error("FATAL: ANTHROPIC_API_KEY is empty.");
  process.exit(1);
}

const out = new ResultsStore(OUT_STORE);
const provider = new AnthropicJudgeProvider({});
const timestamp = new Date().toISOString();
const scored = [];

for (const t of targets) {
  const cell = src.get(t.key);
  const candidates = cell.result.candidates;
  const brief = briefText.get(t.briefId);
  if (!brief) throw new Error(`quality-pilot: no brief text for '${t.briefId}'`);

  // TEXT ONLY over the wire. persona stays here.
  const resp = await provider.score(
    { briefText: brief, candidates: candidates.map((c) => ({ text: c.text })) },
    { judgeModel: JUDGE_MODEL, mode: MODE, seed: 1, timestamp },
  );
  if (resp.terminalState !== "completed") {
    throw new Error(`quality-pilot: judge failed on ${t.key}: ${resp.detail || resp.failureKind}`);
  }
  if (resp.scores.length !== candidates.length) {
    throw new Error(`quality-pilot: ${resp.scores.length} scores for ${candidates.length} candidates on ${t.key}`);
  }

  const ideas = candidates.map((c, i) => ({
    id: c.id,
    persona: c.persona ?? null,
    round: c.round ?? null,
    originality: resp.scores[i].originality,
    feasibility: resp.scores[i].feasibility,
  }));
  scored.push({ key: t.key, armId: t.armId, briefId: t.briefId, ideas });

  out.put({
    key: `quality-pilot|src=${t.key}`,
    armId: t.armId,
    briefId: t.briefId,
    replicate: t.replicate,
    cfg: computeJudgeHash({ judgeModels: { anthropic: [JUDGE_MODEL] } }),
    result: { kind: "quality-pilot", sourceKey: t.key, confirmatory: false, ideas },
    resolvedModels: { judge: JUDGE_MODEL },
    accounting: { state: "completed" },
    costRows: [],
  });
  console.error(`  scored ${t.key} (${candidates.length})`);
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const fmt = (x) => (Number.isFinite(x) ? x.toFixed(3) : "n/a");

console.log("\n=== by arm (descriptive; no contrast, no p-value) ===");
console.log("arm            n     originality  feasibility");
for (const arm of ARMS) {
  const ideas = scored.filter((s) => s.armId === arm).flatMap((s) => s.ideas);
  console.log(`${arm.padEnd(14)} ${String(ideas.length).padEnd(5)} ${fmt(mean(ideas.map((i) => i.originality))).padEnd(12)} ${fmt(mean(ideas.map((i) => i.feasibility)))}`);
}

console.log("\n=== S1C-RICH by persona -- the `weirdo` question ===");
console.log("persona            n     originality  feasibility");
const rich = scored.filter((s) => s.armId === "S1C-RICH").flatMap((s) => s.ideas);
for (const persona of [...new Set(rich.map((i) => i.persona))].sort()) {
  const ideas = rich.filter((i) => i.persona === persona);
  console.log(`${String(persona).padEnd(18)} ${String(ideas.length).padEnd(5)} ${fmt(mean(ideas.map((i) => i.originality))).padEnd(12)} ${fmt(mean(ideas.map((i) => i.feasibility)))}`);
}

console.log(`\nStored ${scored.length} cells in ${OUT_STORE}. Descriptive only -- Appendix N item 6.`);
