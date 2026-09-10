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

  // ONE candidate per score() call -- Appendix N item 10.
  //
  // The first run scored a whole cell in one call and a SINGLE refusal aborted
  // all 61 candidates. That is the classifyUndersizedPool trap (Appendix M item
  // 4) reappearing on the judge leg, and worse here: the judge refuses on
  // CONTENT, so letting a refusal take the cell would condition the quality
  // means on what the judge was willing to read.
  //
  // In `single` mode the provider already issues one POST per candidate, and
  // buildJudgeScoringPrompt renders one candidate against the brief, so
  // splitting the loop changes no prompt the model sees -- with a pool of one
  // there is simply no presentation position for order randomization (§5.3) to
  // neutralize. What it changes is the blast radius of a single refusal.
  const ideas = [];
  for (const c of candidates) {
    const resp = await provider.score(
      { briefText: brief, candidates: [{ text: c.text }] }, // TEXT ONLY over the wire; persona stays here
      { judgeModel: JUDGE_MODEL, mode: MODE, seed: 1, timestamp },
    );
    const ok = resp.terminalState === "completed" && Array.isArray(resp.scores) && resp.scores.length === 1;
    ideas.push({
      id: c.id,
      persona: c.persona ?? null,
      round: c.round ?? null,
      // null, never 0 and never an imputed mean: a refusal is MISSING data.
      originality: ok ? resp.scores[0].originality : null,
      feasibility: ok ? resp.scores[0].feasibility : null,
      refused: !ok,
      refusalDetail: ok ? undefined : String(resp.detail || resp.failureKind || resp.terminalState),
    });
  }
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
  const refused = ideas.filter((i) => i.refused).length;
  console.error(`  scored ${t.key} (${candidates.length}${refused ? `, ${refused} REFUSED` : ""})`);
}

// Means are taken over SCORED candidates only. Refusals are excluded and never
// imputed, and the refusal count rides alongside every mean (Appendix N item
// 10) -- a quality figure over a pool the judge partly declined to read must
// carry that fact next to it, not in a footnote.
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const fmt = (x) => (Number.isFinite(x) ? x.toFixed(3) : "n/a");
const scoredOf = (ideas, axis) => ideas.filter((i) => !i.refused && Number.isFinite(i[axis])).map((i) => i[axis]);

function reportRow(label, ideas) {
  const orig = scoredOf(ideas, "originality");
  const feas = scoredOf(ideas, "feasibility");
  const refused = ideas.filter((i) => i.refused).length;
  const pct = ideas.length ? ((refused / ideas.length) * 100).toFixed(1) : "0.0";
  console.log(
    `${label.padEnd(18)} ${String(ideas.length).padEnd(6)} ${String(orig.length).padEnd(7)} ${fmt(mean(orig)).padEnd(13)} ${fmt(mean(feas)).padEnd(13)} ${refused} (${pct}%)`,
  );
}

const HEAD = `${"".padEnd(18)} ${"n".padEnd(6)} ${"scored".padEnd(7)} ${"originality".padEnd(13)} ${"feasibility".padEnd(13)} refused`;

console.log("\n=== by arm (DESCRIPTIVE; no contrast, no p-value) ===");
console.log(HEAD);
for (const arm of ARMS) reportRow(arm, scored.filter((s) => s.armId === arm).flatMap((s) => s.ideas));

console.log("\n=== S1C-RICH by persona -- the `weirdo` question ===");
console.log(HEAD);
const rich = scored.filter((s) => s.armId === "S1C-RICH").flatMap((s) => s.ideas);
for (const persona of [...new Set(rich.map((i) => i.persona))].sort()) {
  reportRow(String(persona), rich.filter((i) => i.persona === persona));
}

const allRefused = scored.flatMap((s) => s.ideas).filter((i) => i.refused);
if (allRefused.length) {
  console.log(`\n=== refusals (${allRefused.length}) -- reported, never imputed ===`);
  for (const r of allRefused) console.log(`  ${r.id}  persona=${r.persona}  ${r.refusalDetail}`);
}

console.log(`\nStored ${scored.length} cells in ${OUT_STORE}. Descriptive only -- Appendix N item 6.`);
