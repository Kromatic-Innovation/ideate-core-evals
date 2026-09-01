#!/usr/bin/env node
// run.mjs — CLI entry point for the runner (issue #5, pre-registration §9/§12).
//
// Usage:
//   node evals/run.mjs --dry-run
//   node evals/run.mjs --max-spend 50 --arms A,B --briefs biz-01,biz-02 --replicates 2
//   node evals/run.mjs --max-spend-anthropic 300 --max-spend-openai 150
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
import { createRequire } from "node:module";

import { CORPUS, CORPUS_HASH } from "./corpus/index.mjs";
import { ResultsStore } from "../lib/store.mjs";
import { runSpec } from "./harness/runner.mjs";
import { runnerPriceGrid } from "../lib/price.mjs";
import { AnthropicBatchProvider } from "./harness/provider.mjs";
import { voyageEmbedder } from "./metrics/embedder.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");

/**
 * Resolve the installed `ideate-core` package's own version from its
 * package.json, WITHOUT assuming `exports` allows requiring
 * "ideate-core/package.json" directly (ideate-core@0.4.0's `exports` map
 * does not expose that subpath -- see the DEVIATION note above this
 * function's call site in main()). `require.resolve("ideate-core")` still
 * works because module RESOLUTION honors `exports`' "." entry; from that
 * resolved entry file, walk up parent directories reading `package.json` via
 * plain `fs` (a filesystem read, not a module resolution, so it is not
 * subject to the exports map) until the one named "ideate-core" is found --
 * i.e. the actual installed package root, however deep the entry file lives
 * under it.
 */
function getInstalledEngineVersion() {
  const require = createRequire(import.meta.url);
  let dir = dirname(require.resolve("ideate-core"));
  for (let i = 0; i < 6; i++) {
    // an arbitrary-but-generous depth cap, well beyond any plausible
    // node_modules/ideate-core/<subdir>/<file> nesting, so a future layout
    // change fails loud (see the throw below) rather than looping forever.
    const pkgPath = join(dir, "package.json");
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
      if (pkg.name === "ideate-core") return pkg.version;
    } catch {
      // no package.json here, or unparsable -- keep walking up
    }
    const parent = dirname(dir);
    if (parent === dir) break; // reached filesystem root
    dir = parent;
  }
  throw new Error(
    "run.mjs: could not resolve ideate-core's installed version by walking up from its resolved entry file -- " +
      "has the package layout changed? (see getInstalledEngineVersion in evals/run.mjs)",
  );
}

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
      case "--max-spend-anthropic":
        // Per-provider ceiling (issue #51) -- §12 registers a single global
        // --max-spend, but the operator's actual constraint is asymmetric
        // (substantial Anthropic headroom, a firm preference against
        // comparable OpenAI spend), which a single ceiling cannot express.
        // Stored under args.maxSpendByProviderUsd (a { anthropic?, openai? }
        // map), keyed the same way lib/price.mjs's providerOf() names a
        // provider, so main() can hand it to runSpec with no translation.
        args.maxSpendByProviderUsd = { ...args.maxSpendByProviderUsd, anthropic: parseRequiredNumber(argv, ++i, "--max-spend-anthropic") };
        break;
      case "--max-spend-openai":
        args.maxSpendByProviderUsd = { ...args.maxSpendByProviderUsd, openai: parseRequiredNumber(argv, ++i, "--max-spend-openai") };
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

  // engineSha now feeds off the REAL, resolved ideate-core version (issue
  // #19) rather than an "unpinned" placeholder, so configHash (lib/manifest.mjs)
  // actually changes when the engine changes -- that's the whole point of
  // pinning it: a study resumed against a different ideate-core version must
  // NOT be silently treated as directly comparable data (lib/manifest.mjs's
  // never-silently-pool guarantee).
  //
  // This runs ONLY inside main() -- which itself only runs on a real CLI
  // invocation (see the `import.meta.url` guard at the bottom of this file),
  // never during `node --test` -- so it never threatens the hermetic-CI
  // invariant even though `ideate-core` is a real runtime dependency now.
  // --dry-run still reaches this line (dry-run builds the real spec,
  // including configHash, so its projection matches a real run's) -- that's
  // fine because --dry-run is a real CLI invocation on a machine with deps
  // installed, exactly like any other non-test invocation of this file.
  //
  // DEVIATION from the issue's suggested one-liner
  // (`require("ideate-core/package.json").version`): ideate-core@0.4.0's
  // package.json `exports` map does NOT expose a `./package.json` subpath
  // (only ".", "./converge", "./feedback", and two ./integrations/* entries
  // -- see node_modules/ideate-core/package.json), so that require() throws
  // ERR_PACKAGE_PATH_NOT_EXPORTED. `getInstalledEngineVersion` below
  // resolves the SAME information a different way: `require.resolve` the
  // package's real entry file (which respects `exports`, so it still works
  // regardless of internal layout), then walk up parent directories reading
  // `package.json` via plain `fs` (bypassing the exports map entirely, since
  // this is a filesystem read, not a module resolution) until it finds the
  // one whose `name` is "ideate-core".
  const engineVersion = getInstalledEngineVersion();
  const engineSha = process.env.IDEATE_CORE_ENGINE_SHA || `ideate-core@${engineVersion}`;

  // embedderId (issue #20, AC5): lib/manifest.mjs's CONFIG_FIELDS already
  // keys configHash on `embedderId` (per docs/PREREGISTRATION.md §3.3 --
  // the embedder is held CONSTANT across arms, and §10 names "embedding
  // model shapes diversity metric" as a registered threat to validity), but
  // until now nothing here actually SET it, so it never participated in the
  // hash. Read it off `voyageEmbedder().modelId` -- constructing with no
  // apiKey and never calling .embed() is safe and network-free (see
  // embedder.mjs voyageEmbedder's header: construction never requires a key
  // or touches fetch) -- rather than hardcoding the literal "voyage-4-lite"
  // a second time, so the run harness and the embedder module cannot drift
  // out of sync on what the production model id actually is.
  const embedderId = voyageEmbedder().modelId;

  const spec = {
    arms: armIds.map((id) => ({ id })),
    briefs: CORPUS.map((b) => ({ id: b.id })),
    replicates: args.replicates ?? 1,
    config: {
      harnessVersion: "0.0.1",
      engineSha,
      promptHash: "unpinned",
      embedderId,
      corpusHash: CORPUS_HASH,
    },
  };

  const store = new ResultsStore(join(REPO_ROOT, "results"));

  // Provider wiring: --dry-run calls nothing (provider: undefined, unchanged
  // from before #19 -- runSpec() only requires a provider when !dryRun -- see
  // runner.mjs). A real run constructs the actual AnthropicBatchProvider
  // (issue #19); ANTHROPIC_API_KEY is read here, at the CLI boundary, and
  // its absence fails LOUDLY with a clear, actionable message -- never an
  // invented/placeholder key and never a bare stack trace. This is
  // deliberately checked BEFORE constructing the provider (rather than
  // deferring to AnthropicBatchProvider's own internal no-apiKey guard) so a
  // misconfigured real run fails at the moment you'd expect -- immediately,
  // pre-flight -- not three network calls deep.
  let provider;
  if (!args.dryRun) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error(
        "run.mjs: ANTHROPIC_API_KEY is not set. A real (non-dry-run) invocation calls the live " +
          "Anthropic Message Batches API and requires a real API key -- this harness never invents " +
          "or defaults one. Set ANTHROPIC_API_KEY in the environment, or pass --dry-run to plan the " +
          "run without calling anything.",
      );
    }
    provider = new AnthropicBatchProvider({ apiKey, corpus: CORPUS, armsConfig });
  }

  await runSpec(spec, {
    store,
    armsConfig,
    provider,
    batch: !args.noBatch,
    dryRun: args.dryRun,
    // --max-spend-anthropic/--max-spend-openai (issue #51) need real,
    // pinned-rate-table pricing to be meaningful pre-flight -- the interim
    // estimator runSpec() falls back to when no priceGrid is injected has no
    // per-model rate for every model and is explicitly labelled a
    // placeholder (see runner.mjs's own header). Wiring lib/price.mjs's
    // runnerPriceGrid() here is the "follow-up PR" that module's own header
    // comment names as the way the CLI adopts it -- zero changes to
    // runner.mjs's own default were needed for this.
    priceGrid: runnerPriceGrid(),
    maxSpendUsd: args.maxSpendUsd,
    maxSpendByProviderUsd: args.maxSpendByProviderUsd,
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
