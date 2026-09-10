#!/usr/bin/env node
// The §5.1 judge-validation run -- issue #16's fourth and final checklist item.
//
//   node evals/judge/run-validation.mjs --dry-run   # plan and price, calls nothing
//   node evals/judge/run-validation.mjs             # run it for real
//
// WHY THIS FILE EXISTS. `runJudgeValidation` has been a composition with no
// caller since #24 landed it; the run it exists to perform is the one thing
// standing between Study 1 and any claim about idea QUALITY (Appendix L item 4,
// Appendix M item 9). A run whose invocation lives only in a chat transcript is
// a run nobody can reproduce -- Stage 1b's first headline numbers came from an
// uncommitted script and could not be re-derived from the repo. So every
// registered parameter is baked in here rather than passed by hand, exactly as
// scripts/run-study1c.sh does for Stage 1c.
//
// EVERY VALUE BELOW IS REGISTERED, NOT AN OPERATOR CHOICE:
//   axis / column  Appendix A item 7  -- originality <-> overall_score
//   floor          Appendix A item 4  -- 0.561, Si et al.'s human-human figure
//   construction   Appendix A item 4  -- split-half top/bottom-25% bal. accuracy
//   slice          issue #35          -- Human + AI, n=98; AI_Rerank excluded
//   store          Appendix N item 4  -- NOT results-study1c; see below
//
// THE STORE IS LOAD-BEARING. `recordValidation` writes its record under
// `cfg: <judgeHash>`. `results-study1c`'s configHash tally is what
// `resolveS1cArmHashes` reads, and it throws when it finds more than one
// non-pre-#168 hash -- so writing this record into that store would break the
// Stage 1c analysis merged as #168. It goes in its own store and always has.
import { ResultsStore } from "../../lib/store.mjs";
import { AnthropicJudgeProvider } from "./score.mjs";
import { computeJudgeHash } from "./score.mjs";
import { JUDGE_MODELS, JUDGE_VALIDATION_MAPPING } from "./config.mjs";
import { SI_ET_AL_BALANCED_ACCURACY_FLOOR } from "./gate.mjs";
import { readSiEtAlSlice } from "./slice.mjs";
import { runJudgeValidation, judgeValidationSliceId } from "./validate.mjs";

const STORE_DIR = "results-judge-validation";

// The judge model. JUDGE_MODELS.anthropic[0] rather than a literal, so this
// tracks the registered roster instead of drifting from it.
const JUDGE_MODEL = JUDGE_MODELS.anthropic[0];

// mode: "single", not the provider's "batch" default. Appendix K measured the
// Message Batches queue at 10-15x the wall clock of direct calls, and batch wait
// GROWS with batch size. This run is ~7 topic groups; batching buys nothing.
const MODE = "single";

// seed 1 -- the `runJudgeValidation` default, restated so it is a registered
// value in the file rather than an inherited one. Presentation order inside each
// topic group is deterministic in it (issue #46's order control).
const SEED = 1;

const dryRun = process.argv.includes("--dry-run");

// JUDGE_VALIDATION_MAPPING names its second field `expertColumn`, while
// runJudgeValidation's parameter is `expertScoreField`. Destructuring the
// parameter's name off the mapping yields `undefined` -- and `undefined` is
// exactly what runJudgeValidation defaults to SI_ET_AL_EXPERT_SCORE_FIELD, so
// the run would still have scored the right column while every line this file
// prints, and the sliceId the record is stored under, said `expert=undefined`.
// Renamed on the way out rather than aliased silently, so the mismatch is
// visible to the next reader.
const { axis, expertColumn: expertScoreField } = JUDGE_VALIDATION_MAPPING;
const slice = readSiEtAlSlice({ scoreField: expertScoreField });
const topics = new Set(slice.ideas.map((i) => i.topic));
const judgeHash = computeJudgeHash({ judgeModels: JUDGE_MODELS });

console.log("judge validation -- docs/PREREGISTRATION.md §5.1, Appendix N");
console.log(`  axis / column   : ${axis} <-> ${expertScoreField}   (Appendix A item 7)`);
console.log(`  floor           : ${SI_ET_AL_BALANCED_ACCURACY_FLOOR}   (Appendix A item 4)`);
console.log(`  slice           : n=${slice.ideaCount} ideas, ${slice.reviewCount} reviews`);
for (const x of slice.exclusions) console.log(`  excluded        : ${x.condition} (${x.fileCount} files)`);
console.log(`  judge model     : ${JUDGE_MODEL}  mode=${MODE}  seed=${SEED}`);
console.log(`  judge calls     : ${topics.size} (one per topic group)`);
console.log(`  judgeHash       : ${judgeHash}`);
console.log(`  store           : ${STORE_DIR}`);
console.log(`  sliceId         : ${judgeValidationSliceId({ axis, expertScoreField })}`);
console.log();

// The answer key's own precision, printed BESIDE the verdict rather than after
// it. Appendix N item 2: human-human balanced accuracy on this same 98-idea
// slice is 0.5534 with bootstrap 95% CI [0.4483, 0.6702] -- a CI that does not
// exclude chance. A pass/drop verdict at n=98 is power-limited by the answer
// key, not only by the judge, and this run refuses to report one without saying
// so. The figures come from docs/si-et-al-human-human-floor.json (#47).
console.log("  answer-key precision (Appendix N item 2, from #47):");
console.log("    human-human balanced accuracy on this slice : 0.5534");
console.log("    bootstrap 95% CI                            : [0.4483, 0.6702]  <- does NOT exclude chance");
console.log("    registered floor                            : 0.561");
console.log("    comparators (Appendix N item 3)             : 0.517 Claude-3.5 Direct (shape-matched), 0.533 Pairwise");
console.log();

if (dryRun) {
  console.log("--dry-run: nothing was called and nothing was stored.");
  process.exit(0);
}

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("FATAL: ANTHROPIC_API_KEY is empty.");
  process.exit(1);
}

const store = new ResultsStore(STORE_DIR);
const provider = new AnthropicJudgeProvider({});

const out = await runJudgeValidation({
  store,
  judgeProvider: provider,
  judgeModel: JUDGE_MODEL,
  axis,
  expertScoreField,
  mode: MODE,
  seed: SEED,
  timestamp: new Date().toISOString(),
});

console.log("=== validation record ===");
console.log(JSON.stringify(out, null, 2));
console.log();
console.log(`VERDICT: ${out.verdict}   accuracy ${out.accuracy?.toFixed(4)} vs floor ${out.floor}   (n=${out.n})`);
console.log("Read that verdict against the answer-key CI printed above -- Appendix N item 2.");
