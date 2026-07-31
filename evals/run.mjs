#!/usr/bin/env node
// run.mjs — CLI entry point for the runner (issue #5, pre-registration §9/§12).
//
// Usage:
//   node evals/run.mjs --dry-run
//   node evals/run.mjs --max-spend 50 --arms A,B --briefs biz-01,biz-02 --replicates 2
//   node evals/run.mjs --phase 0
//
// This file is intentionally thin: it parses argv, loads the corpus + arm
// config + a results store rooted at `results/` (gitignored, per-deployment --
// see lib/store.mjs), builds the real spec, and hands off to
// evals/harness/runner.mjs's runSpec(). All the actual planning/accounting/
// pricing logic lives there and in the lib/ modules it composes, which is why
// the test suite exercises runSpec() directly with a hermetic temp store +
// mock provider rather than shelling out to this CLI for most coverage (see
// evals/harness/runner.test.mjs and evals/harness/integration.test.mjs).
// `parseArgs` IS exported and unit-tested (see run.test.mjs) -- flag parsing
// looks trivial but a malformed numeric flag silently becoming NaN is exactly
// the kind of "thin CLI glue" bug that slips past a "no logic worth testing"
// assumption (a NaN --max-spend compares false against every projection,
// silently DISABLING the budget gate instead of erroring).
//
// NOT wired into CI (per docs/PREREGISTRATION.md §9: "Not wired into CI...
// Runs on demand via node evals/run.mjs --phase N").

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { CORPUS, CORPUS_HASH } from "./corpus/index.mjs";
import { ResultsStore } from "../lib/store.mjs";
import { runSpec } from "./harness/runner.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");

// Parse argv[i+1] as a required numeric value for flag `name`, throwing
// loudly on a missing or non-numeric argument rather than letting
// `Number(undefined)`/`Number("abc")` silently become NaN. This matters most
// for --max-spend: a NaN ceiling compares false against every projection
// (NaN comparisons are always false), which would silently DISABLE the
// spend gate instead of erroring -- exactly backwards for a budget-safety
// flag whose entire job is to refuse to start over-budget.
function parseRequiredNumber(argv, i, name) {
  const raw = argv[i];
  const value = Number(raw);
  if (raw === undefined || Number.isNaN(value)) {
    throw new Error(`run.mjs: ${name} requires a numeric argument, got ${JSON.stringify(raw)}`);
  }
  return value;
}

export function parseArgs(argv) {
  const args = { dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--dry-run":
        args.dryRun = true;
        break;
      case "--max-spend":
        args.maxSpendUsd = parseRequiredNumber(argv, ++i, "--max-spend");
        break;
      case "--arms":
        args.arms = argv[++i].split(",").map((s) => s.trim()).filter(Boolean);
        break;
      case "--briefs":
        args.briefs = argv[++i].split(",").map((s) => s.trim()).filter(Boolean);
        break;
      case "--replicates":
        args.replicates = parseRequiredNumber(argv, ++i, "--replicates");
        break;
      case "--phase":
        args.phase = parseRequiredNumber(argv, ++i, "--phase");
        break;
      case "--no-batch":
        args.noBatch = true;
        break;
      default:
        throw new Error(`run.mjs: unrecognized flag '${a}'`);
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // --phase is accepted (per §12's flag table) but NOT YET wired to a
  // phase->arms/briefs mapping: docs/PREREGISTRATION.md §8.3 defines phases
  // (0 negative-controls, 1 judge validation, 2 pilot, 3 full grid, 4
  // analysis) as a HUMAN-GATED sequence ("no phase starts without an
  // explicit go"), and nothing in this repo yet codifies which arms/briefs
  // belong to which phase -- that mapping is a judgment call for whoever
  // runs the study, made via --arms/--briefs/--replicates directly. Failing
  // loudly here (rather than silently ignoring --phase or guessing a
  // mapping) keeps a mistaken "I passed --phase so I'm scoped correctly"
  // assumption from quietly running the full grid.
  if (args.phase !== undefined) {
    throw new Error(
      "run.mjs: --phase is accepted by the flag parser (pre-registration §12) but no phase->arms/briefs " +
        "mapping exists yet in this repo -- use --arms/--briefs/--replicates directly to scope a phase " +
        "manually (see docs/PREREGISTRATION.md §8.3 for what each phase should cover).",
    );
  }

  const armsConfig = JSON.parse(readFileSync(join(REPO_ROOT, "arms.config.json"), "utf8"));
  const armIds = Object.keys(armsConfig.arms);

  // The engine/prompt/judge/embedder identity feeding configHash is left as
  // TBD placeholders here -- the harness (evals/harness/runner.mjs) treats
  // config identity as an opaque input, and the real values are populated by
  // whichever issue wires the engine call (out of scope for #5, which is
  // provider-agnostic via dependency injection). corpusHash IS real, since
  // evals/corpus/ (#2) already ships it.
  const spec = {
    arms: armIds.map((id) => ({ id })),
    briefs: CORPUS.map((b) => ({ id: b.id })),
    replicates: args.replicates ?? 1,
    config: {
      harnessVersion: "0.0.1",
      engineSha: process.env.IDEATE_CORE_ENGINE_SHA || "unpinned",
      promptHash: "unpinned",
      corpusHash: CORPUS_HASH,
    },
  };

  const store = new ResultsStore(join(REPO_ROOT, "results"));

  await runSpec(spec, {
    store,
    armsConfig,
    // No provider wired at the CLI layer yet -- real Anthropic/OpenAI Batch
    // adapters are documented stubs in evals/harness/provider.mjs (out of
    // scope for #5). --dry-run works today; a real run will throw until a
    // provider is supplied here in a follow-up issue.
    provider: args.dryRun ? undefined : (() => {
      throw new Error(
        "run.mjs: no live provider is wired yet -- evals/harness/provider.mjs's " +
          "AnthropicBatchProvider/OpenAIBatchProvider are documented stubs, not " +
          "implementations. Use --dry-run, or inject a provider programmatically " +
          "via runSpec() (see evals/harness/*.test.mjs for the pattern).",
      );
    })(),
    batch: !args.noBatch,
    dryRun: args.dryRun,
    maxSpendUsd: args.maxSpendUsd,
    armIds: args.arms,
    briefIds: args.briefs,
    replicates: args.replicates,
  });
}

// Only auto-run when this file is the actual entry point (`node evals/run.mjs
// ...`), not when it's imported for its exports (e.g. `parseArgs` from
// run.test.mjs). Without this guard, importing this module in a test would
// immediately execute `main()` -- parsing the real process.argv, touching the
// real filesystem, and setting process.exitCode on any failure -- entirely
// outside the test's control.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err.stack || err.message);
    process.exitCode = 1;
  });
}
