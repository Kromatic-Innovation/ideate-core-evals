#!/usr/bin/env node
// analysis.mjs — thin CLI orchestrator wiring frame -> fit ladder ->
// contrasts -> multiplicity -> pareto -> report -> out/*. Not itself an
// acceptance criterion (#46 asks for the modules + tests); this exists so
// the pieces can be run end-to-end against a real results/ store without
// hand-wiring them each time.
//
// Usage:
//   node evals/analysis/analysis.mjs --results-dir results --out-dir evals/analysis/out \
//     --response distinct_k --reference-arm A --panel-arms A2,B,C,D,E,F,G,H \
//     --cluster-distance-threshold 0.23141118234233987
//
// --cluster-distance-threshold (issue #73): two distinct effects, both real:
//   1. It is REQUIRED to actually compute H1's rarefied estimand (Appendix
//      C) once stored cells carry embedded pools (#8/Phase 2a) — this
//      study's registered clusterDistanceThreshold (lib/manifest.mjs
//      CONFIG_FIELDS; docs/PREREGISTRATION.md's registered value is
//      0.23141118234233987). Omitting it is safe TODAY (no cell has a pool
//      yet, so the rarefied lane reports H1 as not-computed regardless —
//      see main()'s PoolsUnavailableError handling) but will start
//      hard-failing runs the moment pools exist and this flag is still
//      missing.
//   2. It ALSO feeds args.config, which is the SAME config buildFrame()
//      hashes into configHash (frame.mjs) — clusterDistanceThreshold has
//      been a CONFIG_FIELDS entry since issue #42, independent of
//      rarefaction. Passing this flag (or changing its value) therefore
//      changes WHICH stored cells this run selects: cells stored under a
//      different clusterDistanceThreshold (including "none supplied")
//      become `stale`, not silently pooled in. See frame.test.mjs's
//      "clusterDistanceThreshold changes configHash" tests for this
//      exact effect pinned at the frame boundary.
//
// Requires ANALYSIS_SIDECAR-independent setup: the sidecar venv must exist
// at evals/analysis/sidecar/.venv (see sidecar/requirements.txt) — this CLI
// always uses the real sidecar runner, never a fake one (fakes are for
// fit.test.mjs / analysis.main.test.mjs only — the latter injects one via
// main()'s second argument, never used by the real CLI entrypoint below).

import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { ResultsStore } from "../../lib/store.mjs";
import { buildFrame, summarizeByArm } from "./frame.mjs";
import { buildRarefiedFrame, PoolsUnavailableError } from "./rarefiedFrame.mjs";
import { buildJudgeScoreFrame, JudgeScoresUnavailableError } from "./judgeScoreFrame.mjs";
import { buildRegisteredFamily, evaluateSpec, registeredFamilySlotCount, applyHolmVerdicts } from "./contrasts.mjs";
import { holmBonferroni } from "./multiplicity.mjs";
import { paretoFrontier, costDiversityRatioByArm, seedFromString } from "./pareto.mjs";
import { renderParetoSvg } from "./plot.mjs";
import { runLadder, runJudgeScoreLadder, makeSidecarRunner, analysisHash as computeAnalysisHash } from "./fit.mjs";
import { RAREFACTION_TREATMENT } from "./rarefaction.mjs";
import { renderAnalysisDataCsv, renderLme4FitR } from "./reproducibility.mjs";
import { renderReport } from "./report.mjs";
import { providerOf } from "../../lib/price.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");

function parseArgs(argv) {
  const args = { resultsDir: "results", outDir: join(__dirname, "out"), response: "distinct_k", referenceArm: "A", panelArms: null, delta: undefined, config: {}, poolField: "pool" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--results-dir") args.resultsDir = argv[++i];
    else if (a === "--out-dir") args.outDir = argv[++i];
    else if (a === "--response") args.response = argv[++i];
    else if (a === "--reference-arm") args.referenceArm = argv[++i];
    else if (a === "--panel-arms") args.panelArms = argv[++i].split(",");
    // H2/H4's registered default is delta=0 (buildRegisteredFamily()) -- this
    // flag exists ONLY to register an explicit margin later (§B2's pilot),
    // and doing so is recorded as a deviation from the current registration
    // (see contrasts.mjs's `deltaDeviatesFromRegistration`), never silently
    // absorbed as if it were always the registered test.
    else if (a === "--delta") args.delta = Number(argv[++i]);
    // Rarefaction (issue #73, docs/PREREGISTRATION.md Appendix C): H1's
    // registered estimand needs the SAME clusterDistanceThreshold distinct_k
    // was originally measured at (lib/manifest.mjs CONFIG_FIELDS) — there is
    // no default (rarefiedFrame.mjs refuses to guess one).
    else if (a === "--cluster-distance-threshold") args.config.clusterDistanceThreshold = Number(argv[++i]);
    else if (a === "--pool-field") args.poolField = argv[++i];
    else throw new Error(`analysis.mjs: unrecognized argument '${a}'`);
  }
  return args;
}

/**
 * @param {string[]} argv
 * @param {object} [deps]
 *   @param {(request: object) => Promise<object>} [deps.runner]  overrides
 *     the sidecar runner BOTH ladders use (issue #73 fix round — the real
 *     CLI entrypoint below never passes this; it exists so
 *     analysis.main.test.mjs can exercise main() end-to-end, hermetically,
 *     with a fake runner instead of the real spawned sidecar).
 */
export async function main(argv = process.argv.slice(2), deps = {}) {
  const args = parseArgs(argv);
  const runner = deps.runner || makeSidecarRunner();
  mkdirSync(args.outDir, { recursive: true });

  const store = new ResultsStore(args.resultsDir);
  // poolField is requested unconditionally (issue #73): no stored cell
  // carries one yet (frame.mjs's own header / Appendix C item 5), so today
  // every row's `pool` comes back undefined and the rarefied lane below
  // reports H1 as not computed -- see PoolsUnavailableError handling. Once
  // #8 (Phase 2a) starts writing embedded pools, this same CLI wiring picks
  // them up with no further change.
  //
  // STATED DECISION (issue #73 fix round): turning this on by default also
  // puts frame.mjs's malformed-pool guard on the default analysis path -- a
  // completed cell whose `result.pool` is PRESENT but malformed (not a
  // non-empty array, e.g. `[]`) now hard-fails buildFrame() on every real
  // run, not just a caller who opted in with `--pool-field`. This is
  // deliberate, not a side effect of turning the flag on: a malformed pool
  // on a cell that claims to have one is exactly the kind of silent-drift
  // risk this issue exists to close, and failing loud beats quietly
  // treating it as "absent" -- which would BIAS the rarefied comparison by
  // silently dropping whichever arm's cells happen to be corrupted, rather
  // than surfacing the corruption. See frame.test.mjs's "opts.poolField on
  // a PRESENT but malformed pool ... is a hard error" test and
  // analysis.main.test.mjs's matching test at the CLI/main() boundary.
  // Disagree with this call? It is exactly `poolField: args.poolField`
  // below, gated by parseArgs()'s default -- flip that default, not this
  // comment, if the decision should go the other way.
  const frame = buildFrame(store, { config: args.config, responseField: args.response, poolField: args.poolField });
  const panelArms = args.panelArms || frame.armLevels.filter((a) => a !== args.referenceArm);

  // ── Full-pool ladder — the response every hypothesis EXCEPT H1 is fit
  // against (H2/H3/H4 are registered "unaffected" by rarefaction, Appendix C
  // item 4), and what the Pareto/cost lanes stay on (item 3: distinct_k/$ is
  // "full-pool, self-correcting"). ───────────────────────────────────────────
  const ladder = await runLadder({
    rows: frame.rows.map((r) => ({ armId: r.armId, briefId: r.briefId, response: r.response })),
    armLevels: frame.armLevels,
    referenceArm: args.referenceArm,
    runner,
  });

  if (!ladder.fit) {
    throw new Error(`analysis.mjs: ladder reached ${ladder.rung} (no confirmatory inference) — see history: ${JSON.stringify(ladder.history)}`);
  }

  // ── Rarefied lane — H1's registered estimand (Appendix C items 2/4/5).
  // A SEPARATE frame and a SEPARATE ladder fit from the full-pool one above:
  // H1's contrast (mean(panel arms) - referenceArm) is evaluated against
  // THIS fit, never the full-pool one. Only attempted for a metric Appendix
  // C item 3 actually registers as "rarefied" (distinct_k, poolFlexibility)
  // — buildRarefiedFrame() itself refuses any other metric, this is just the
  // faster "don't even try" path for e.g. a judge-score response. ──────────
  let rarefiedLadder = null;
  let rarefiedFrame = null;
  let rarefiedUnavailableReason = null;
  // panelArms.length === 0 (issue #73 fix round): H1's contrast (mean(panel
  // arms) - referenceArm) has no arms to mean over, so there is nothing for
  // buildRarefiedFrame() to rarefy either — buildRegisteredFamily() below
  // throws its own clear "opts.panelArms is required" error for this state
  // regardless of rarefaction. Skip the attempt here rather than let
  // buildRarefiedFrame()'s unrelated "must name at least two arms" guard
  // fire first and obscure that this was never a rarefaction problem.
  if (panelArms.length === 0) {
    rarefiedUnavailableReason = "no panel arms present in this frame — H1 is undefined without at least one panel arm";
  } else if (RAREFACTION_TREATMENT[args.response] === "rarefied") {
    try {
      rarefiedFrame = buildRarefiedFrame(frame, {
        armIds: [args.referenceArm, ...panelArms],
        threshold: args.config.clusterDistanceThreshold,
        metric: args.response,
      });
    } catch (err) {
      if (err instanceof PoolsUnavailableError) {
        // Registered, expected state until #8 (Phase 2a) populates pools —
        // never silently fall through to the full-pool fit for H1 (that is
        // exactly the defect Appendix C exists to close). Any OTHER error
        // (MixedPoolCoverageError, a missing/wrong threshold, a disagreeing
        // stored scalar) is a real problem and must keep propagating.
        rarefiedUnavailableReason = err.message;
      } else {
        throw err;
      }
    }
    if (rarefiedFrame) {
      rarefiedLadder = await runLadder({
        rows: rarefiedFrame.rows.map((r) => ({ armId: r.armId, briefId: r.briefId, response: r.response })),
        armLevels: rarefiedFrame.armLevels,
        referenceArm: args.referenceArm,
        runner,
      });
      if (!rarefiedLadder.fit) {
        // Sidecar-unavailable already propagated as SidecarUnavailableError
        // out of runLadder/fitViaSidecar above, uncaught — this is reachable
        // only for a genuine R3 (every rung's diagnostics failed), which is
        // as much a hard stop for the rarefied lane as it already is for the
        // full-pool one two lines up.
        throw new Error(
          `analysis.mjs: rarefied ladder reached ${rarefiedLadder.rung} (no confirmatory inference for H1's registered estimand) — see history: ${JSON.stringify(rarefiedLadder.history)}`,
        );
      }
    }
  }

  // ── Judge-score lane — H5's registered bias term (issue #80, Appendix B
  // item 6). A THIRD, independent frame and ladder from both the full-pool
  // and rarefied lanes above: H5 is evaluated against THIS fit alone, never
  // `ladder.fit` or `rarefiedLadder.fit`. `opts.pools` (judgeScoreFrame.mjs)
  // is derived here from the already-built full-pool `frame` (one pool per
  // completed generation cell) joined against arms.config.json's own
  // generator-provider set per arm (mirrors evals/judge/matrix.mjs's
  // generatorProvidersOf) -- this file, not judgeScoreFrame.mjs, is the one
  // that knows about arms.config.json, keeping that module decoupled from
  // run configuration exactly as frame.mjs stays decoupled from it. ────────
  let judgeScoreLadder = null;
  let judgeScoreUnavailableReason = null;
  let armsConfig = null;
  try {
    armsConfig = JSON.parse(readFileSync(join(REPO_ROOT, "arms.config.json"), "utf8"));
  } catch (err) {
    // arms.config.json is required to resolve a pool's generator-provider
    // set, but its absence must degrade H5 to not-computed, never abort the
    // whole run -- H1-H4 (and Pareto/cost) have nothing to do with it.
    judgeScoreUnavailableReason = `could not read arms.config.json to resolve generator providers: ${err.message}`;
  }
  const judgeScorePools = armsConfig
    ? frame.rows
        .map((r) => {
          const arm = armsConfig.arms && armsConfig.arms[r.armId];
          const generatorProviders = [];
          for (const slot of (arm && arm.slots) || []) {
            // A model id this run doesn't recognize the provider prefix for
            // (isNonProviderModel-style unknowns, e.g. a future embedder in
            // `slots`) is skipped, not a hard crash for the whole analysis
            // run -- providerOf() throws by design for anything it can't
            // classify (lib/price.mjs), which is correct for pricing but too
            // strict a gate for this best-effort provider-set derivation.
            try {
              generatorProviders.push(providerOf(slot.model));
            } catch {
              continue;
            }
          }
          return { poolKey: r.cellKey, armId: r.armId, generatorProviders: Array.from(new Set(generatorProviders)) };
        })
        .filter((p) => p.generatorProviders.length > 0)
    : [];

  if (judgeScorePools.length === 0) {
    judgeScoreUnavailableReason = judgeScoreUnavailableReason || "no frame row's arm resolved to a known generator provider via arms.config.json";
  } else {
    try {
      const judgeScoreFrame = buildJudgeScoreFrame(store, { pools: judgeScorePools });
      const ladderResult = await runJudgeScoreLadder({
        rows: judgeScoreFrame.rows,
        judgeProviderLevels: judgeScoreFrame.judgeProviderLevels,
        referenceJudgeProvider: judgeScoreFrame.judgeProviderLevels[0],
        runner,
      });
      if (ladderResult.fit) {
        judgeScoreLadder = ladderResult;
      } else {
        // J2 (no confirmatory inference for the judge-score lane) must
        // degrade H5 to not-computed, exactly like PoolsUnavailableError
        // does for H1 -- it must NEVER abort the whole analysis run (H1-H4
        // and Pareto/cost have nothing to do with H5's fit). This mirrors
        // the brief's own convention: "a registered quantity that cannot be
        // computed -> named error -> report as not-computed", not a crash.
        judgeScoreUnavailableReason = `judge-score ladder reached ${ladderResult.rung} (no confirmatory inference for H5) — see history: ${JSON.stringify(ladderResult.history)}`;
      }
    } catch (err) {
      if (err instanceof JudgeScoresUnavailableError) {
        // Registered, expected state until real judging (#68/#77) has
        // actually run against a study cell -- never silently fall through
        // to a different estimand for H5 (same discipline as the rarefied
        // lane's PoolsUnavailableError handling above).
        judgeScoreUnavailableReason = err.message;
      } else {
        throw err;
      }
    }
  }

  const family = buildRegisteredFamily({
    referenceArm: args.referenceArm,
    panelArms,
    delta: args.delta,
    h5Wired: Boolean(judgeScoreLadder && judgeScoreLadder.fit),
  });
  // One evaluateSpec() result per hypothesis (H3's two sub-contrasts are
  // combined internally into a single IUT p-value -- see contrasts.mjs) --
  // registeredResults is therefore already flat, 5 entries, H1..H5. H1 is
  // evaluated against the rarefied fit (when available); H5 against the
  // judge-score fit (when available); every other entry keeps using the
  // full-pool `ladder.fit`, unchanged.
  const registeredResults = family.map((spec) => {
    if (spec.id === "H1") {
      if (rarefiedLadder && rarefiedLadder.fit) return evaluateSpec(spec, rarefiedLadder.fit);
      // No rarefied fit available -- report H1 as NOT COMPUTED (the same
      // `{unimplemented: true, p: 1}` shape H5 uses when its own fit is
      // unavailable) rather than fabricating a number or silently falling
      // back to the full-pool fit.
      return {
        id: "H1",
        description: spec.description,
        unimplemented: true,
        reason: rarefiedUnavailableReason || "rarefied lane did not run",
        p: 1,
      };
    }
    if (spec.id === "H5") {
      if (judgeScoreLadder && judgeScoreLadder.fit) return evaluateSpec(spec, judgeScoreLadder.fit);
      return {
        id: "H5",
        description: spec.description,
        unimplemented: true,
        reason: judgeScoreUnavailableReason || "judge-score lane did not run",
        p: 1,
      };
    }
    return evaluateSpec(spec, ladder.fit);
  });
  const holmAdjusted = holmBonferroni(
    registeredResults.map((r) => r.p),
    { familySize: registeredFamilySlotCount(family) },
  );
  const verdicts = applyHolmVerdicts(registeredResults, holmAdjusted);

  // Pareto / cost lanes stay on the FULL-POOL frame -- distinct_k/dollar is
  // registered "full-pool, self-correcting" (Appendix C item 3), never
  // rarefied.
  const armSummaries = summarizeByArm(frame);
  const paretoPoints = paretoFrontier(armSummaries.map((a) => ({ armId: a.armId, meanCostUsd: a.meanCostUsd, meanResponse: a.meanResponse })));
  const costRatioByArm = costDiversityRatioByArm(frame, { seed: seedFromString(frame.configHash) });

  const hash = computeAnalysisHash(ladder.fit);

  writeFileSync(join(args.outDir, "analysis-data.csv"), renderAnalysisDataCsv(frame));
  writeFileSync(join(args.outDir, "lme4-fit.R"), renderLme4FitR({ responseField: frame.responseField, armLevels: frame.armLevels, referenceArm: args.referenceArm }));
  // Rarefied reproducibility artifacts (issue #73 fix round, BLOCKING 3):
  // renderAnalysisDataCsv()/renderLme4FitR() are pure functions of a
  // frame-shaped object (rows/responseField/armLevels) — rarefiedFrame has
  // exactly that shape, so this is straight reuse, not a new renderer. A
  // reviewer with R can therefore reproduce H1's rarefied fit the same way
  // they reproduce H2-H4's, instead of `lme4-fit.R` only ever describing the
  // full-pool fit while REPORT.md's headline hypothesis was fit elsewhere.
  if (rarefiedFrame) {
    writeFileSync(join(args.outDir, "analysis-data-rarefied.csv"), renderAnalysisDataCsv(rarefiedFrame));
    writeFileSync(
      join(args.outDir, "lme4-fit-rarefied.R"),
      // dataFile MUST be the rarefied CSV (issue #73 fix round, BLOCKING) --
      // omitting it here is exactly the bug that shipped a rarefied-lane R
      // script hardcoded to `read.csv("analysis-data.csv")`, reproducing the
      // full-pool fit under H1's label. See reproducibility.test.mjs and
      // analysis.main.test.mjs for the regression tests pinning this.
      renderLme4FitR({
        responseField: rarefiedFrame.responseField,
        armLevels: rarefiedFrame.armLevels,
        referenceArm: args.referenceArm,
        dataFile: "analysis-data-rarefied.csv",
      }),
    );
  }
  writeFileSync(
    join(args.outDir, "fit.json"),
    JSON.stringify(
      {
        rung: ladder.rung,
        fit: ladder.fit,
        history: ladder.history,
        robustnessCheck: ladder.robustnessCheck,
        rarefied: rarefiedLadder
          ? { rung: rarefiedLadder.rung, fit: rarefiedLadder.fit, history: rarefiedLadder.history, robustnessCheck: rarefiedLadder.robustnessCheck }
          : { unavailableReason: rarefiedUnavailableReason },
        judgeScore: judgeScoreLadder
          ? { rung: judgeScoreLadder.rung, fit: judgeScoreLadder.fit, history: judgeScoreLadder.history }
          : { unavailableReason: judgeScoreUnavailableReason },
      },
      null,
      2,
    ),
  );
  writeFileSync(join(args.outDir, "pareto.svg"), renderParetoSvg(paretoPoints));
  writeFileSync(
    join(args.outDir, "REPORT.md"),
    renderReport({
      frame,
      ladder,
      registeredResults: verdicts,
      holmAdjusted,
      paretoPoints,
      costRatioByArm,
      analysisHash: hash,
      rarefiedFrame,
      rarefiedLadder,
      rarefiedUnavailableReason,
    }),
  );

  return {
    frame,
    ladder,
    registeredResults: verdicts,
    holmAdjusted,
    paretoPoints,
    costRatioByArm,
    analysisHash: hash,
    rarefiedFrame,
    rarefiedLadder,
    rarefiedUnavailableReason,
    judgeScoreLadder,
    judgeScoreUnavailableReason,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err.stack || err.message);
    process.exit(1);
  });
}
