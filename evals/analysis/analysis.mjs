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
// Add --config-hash <hash> only when the store holds more than one
// configHash; the error you get in that case names every candidate.
//
// --cluster-distance-threshold (issue #73) is REQUIRED to actually compute
// H1's rarefied estimand (Appendix C) once stored cells carry embedded pools
// (#8/Phase 2a) — this study's registered clusterDistanceThreshold
// (docs/PREREGISTRATION.md's registered value is 0.23141118234233987).
// Omitting it is safe TODAY (no cell has a pool yet, so the rarefied lane
// reports H1 as not-computed regardless — see main()'s PoolsUnavailableError
// handling) but will start hard-failing runs the moment pools exist and this
// flag is still missing.
//
// It used to have a SECOND effect: it fed `args.config`, the object
// buildFrame() hashed into the configHash that decides which stored cells
// this run selects. That is gone as of issue #91, and its removal is the
// point of that issue, not a side effect — see "which cells this run
// selects" below.
//
// ── Which cells this run selects (issue #91) ────────────────────────────────
// This CLI no longer COMPUTES a configHash. It reads the hash off the store's
// own index (evals/analysis/storeConfig.mjs) and hands it to buildFrame()
// verbatim.
//
// Before, it computed one from `args.config` — an object it had flags for
// exactly ONE of lib/manifest.mjs's nine CONFIG_FIELDS. The hash it reached
// (560d764366bc) therefore could never equal the one evals/run.mjs stamps on
// every cell (5ce5478956e5), so every cell was excluded as `stale` and the
// study's whole dataset was invisible to its own analysis.
//
// The fix is deliberately NOT "add the other eight flags". Two reasons.
// First, a config the operator retypes on every invocation is a config that
// drifts. Second, the two sides genuinely DISAGREED about the field set:
// `clusterDistanceThreshold` is a CONFIG_FIELDS entry that this file set and
// run.mjs does not, so adding the five missing flags would have swapped one
// mismatch for another. Reading the hash off the store removes the second
// derivation entirely, so there is nothing left for the two sides to disagree
// about — whatever run.mjs stamps is what this selects, today and after any
// future change to run.mjs's field set.
//
// The never-silently-pool guarantee is untouched: buildFrame() still fits
// only cells whose stored `cfg` equals the declared hash, and a store holding
// two hashes is REFUSED (--config-hash names the one you mean), never
// silently merged. See frame.test.mjs's "clusterDistanceThreshold changes
// configHash" tests, which still pin that effect at the frame boundary for
// callers who pass `opts.config`.
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
import { buildFrame, summarizeByArm, assertCellsSelected } from "./frame.mjs";
import { resolveStoreConfigHash } from "./storeConfig.mjs";
import { buildRarefiedFrame, PoolsUnavailableError } from "./rarefiedFrame.mjs";
import { buildJudgeScoreFrame, JudgeScoresUnavailableError, JudgeScoreBiasNotIdentifiableError } from "./judgeScoreFrame.mjs";
import { buildRegisteredFamily, evaluateSpec, registeredFamilySlotCount, applyHolmVerdicts, familyEstimability } from "./contrasts.mjs";
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
  const args = {
    resultsDir: "results",
    outDir: join(__dirname, "out"),
    response: "distinct_k",
    referenceArm: "A",
    panelArms: null,
    delta: undefined,
    clusterDistanceThreshold: undefined,
    configHash: undefined,
    poolField: "pool",
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--results-dir") args.resultsDir = argv[++i];
    else if (a === "--out-dir") args.outDir = argv[++i];
    else if (a === "--response") args.response = argv[++i];
    else if (a === "--reference-arm") args.referenceArm = argv[++i];
    // --panel-arms scopes BOTH the model fit and the registered contrast
    // family (issue #97). Before that issue it scoped only the fit, so a
    // subset run built a family naming arms D/E/G/H that the fit did not
    // carry and died as `contrastVector: unknown coefficient 'arm[T.E]'`.
    // Left off, it is derived from the frame's own armLevels below, which
    // is the path an operator actually takes.
    //
    // There is deliberately NO --h2-pair / --h3-target-vs-best / --h4-pair
    // flag, and adding one is not a missing feature. buildRegisteredFamily()
    // accepts those options, but exposing them on the CLI would let a subset
    // run SUBSTITUTE a present arm for an absent one -- answering a
    // different question under a pre-registered hypothesis's name. What a
    // subset run needs is SCOPING (which this flag gives) and an explicit
    // not-estimable record for what it cannot reach (which
    // buildRegisteredFamily() gives); it does not need re-pairing. See
    // contrasts.mjs's "ARM SUBSETS AND THE REGISTERED FAMILY" header.
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
    else if (a === "--cluster-distance-threshold") args.clusterDistanceThreshold = Number(argv[++i]);
    // --config-hash (issue #91): the DISAMBIGUATOR, not the normal path. Left
    // off, the hash is read off the store, which is right whenever the store
    // holds one experiment. Supply it only when the store holds more than one
    // configHash and you must say which is yours. It is validated against the
    // store (storeConfig.mjs) rather than passed through to produce an empty
    // frame.
    else if (a === "--config-hash") args.configHash = argv[++i];
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
  //
  // The configHash comes from the STORE, never recomputed here (issue #91 —
  // see this file's header). resolveStoreConfigHash() throws a named,
  // actionable error for each way this can fail: an empty store, a store
  // holding several incomparable experiments (it refuses to choose), and a
  // --config-hash the store does not carry — the last being exactly the state
  // that used to surface four modules downstream as `armLevels []`.
  const { configHash: selectedCfg } = resolveStoreConfigHash(store, {
    configHash: args.configHash,
    resultsDir: args.resultsDir,
  });
  const frame = buildFrame(store, { configHash: selectedCfg, responseField: args.response, poolField: args.poolField });
  // Belt-and-braces behind the resolver: a frame that selected nothing is
  // reported as the exclusion outcome it is, with the expected hash and what
  // the store holds, instead of travelling on to become a contrasts.mjs
  // complaint about --reference-arm.
  assertCellsSelected(frame);
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
  //
  // `panelArms.length < 2` (issue #97) is the same "don't even try" gate one
  // step wider: H1's registered contrast is mean(panel arms) - referenceArm,
  // and with fewer than two panel arms buildRegisteredFamily() records H1 as
  // NOT ESTIMABLE (a single panel arm collapses it to a per-arm comparison,
  // which Appendix B item 5 assigns to the §6.3 exploratory section). There
  // is then nothing for the rarefied lane to fit, so skip it rather than
  // spend a rarefaction + ladder on a contrast that will not be evaluated.
  if (panelArms.length === 0) {
    rarefiedUnavailableReason = "no panel arms present in this frame — H1 is undefined without at least one panel arm";
  } else if (panelArms.length < 2) {
    rarefiedUnavailableReason =
      `only one panel arm present in this frame ([${panelArms.join(", ")}]) — H1 (mean(panel arms) - ${args.referenceArm}) is ` +
      "recorded NOT ESTIMABLE for this arm subset rather than computed as a per-arm comparison under H1's registered name " +
      "(docs/PREREGISTRATION.md Appendix B item 5), so the rarefied lane has nothing to fit";
  } else if (RAREFACTION_TREATMENT[args.response] === "rarefied") {
    try {
      rarefiedFrame = buildRarefiedFrame(frame, {
        armIds: [args.referenceArm, ...panelArms],
        threshold: args.clusterDistanceThreshold,
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
  // Issue #97: true when H5 is unreachable because of THIS RUN'S ARMS (no
  // provider-mixed arm, so the bias term is collinear with judge_provider),
  // as opposed to "judging has not run yet" or "the ladder did not converge".
  // Kept separate so the report's arm-subset banner counts H5 only when the
  // arm subset is genuinely the cause.
  let judgeScoreNotEstimableForArms = false;
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
      // Issue #97: H5's bias term must be IDENTIFIABLE before it is worth
      // fitting. Without a provider-mixed arm the bias column is collinear
      // with judge_provider, the sidecar answers `Singular matrix`, and that
      // -- routed through SidecarUnavailableError -- aborted the WHOLE run
      // (H1-H4 and the Pareto/cost lanes included) over a hypothesis none of
      // them depend on. Observed against the #8 smoke store (arms A/B, all
      // Anthropic generators). Refuse the fit by NAME, before spawning it.
      if (!judgeScoreFrame.biasTermIdentifiable) {
        throw new JudgeScoreBiasNotIdentifiableError(judgeScoreFrame.biasTermNotIdentifiableReason);
      }
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
      if (err instanceof JudgeScoresUnavailableError || err instanceof JudgeScoreBiasNotIdentifiableError) {
        // Registered, expected state until real judging (#68/#77) has
        // actually run against a study cell -- never silently fall through
        // to a different estimand for H5 (same discipline as the rarefied
        // lane's PoolsUnavailableError handling above).
        //
        // JudgeScoreBiasNotIdentifiableError (issue #97) is the ARM-SUBSET
        // form of the same thing: with no provider-mixed arm present, H5's
        // bias column is collinear with judge_provider and the term does not
        // exist to be estimated. Without this branch the sidecar's `Singular
        // matrix` came back as SidecarUnavailableError and aborted the whole
        // run -- H1-H4 and the Pareto/cost lanes included -- over a
        // hypothesis none of them depend on. Observed against the #8 smoke
        // store (arms A/B, all-Anthropic generators).
        judgeScoreNotEstimableForArms = err instanceof JudgeScoreBiasNotIdentifiableError;
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
    // Arm-subset not-estimable (issue #97): evaluateSpec() returns the
    // record without touching a fit, so this must come BEFORE the per-lane
    // fit routing below -- H1's entry in particular has no rarefied fit to
    // be evaluated against when it was never estimable in the first place.
    if (spec.notEstimable) return evaluateSpec(spec, null);
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
        // Issue #97: H5's own arm-subset non-estimability -- the bias term
        // needs a provider-MIXED arm (G) to be identifiable at all, so a
        // subset without one cannot reach it. Marked so it appears in the
        // report's arm-subset banner alongside H1-H4 rather than reading as
        // the unrelated "judging has not run yet" state.
        ...(judgeScoreNotEstimableForArms ? { notEstimable: true, missingArms: [], availableArms: [args.referenceArm, ...panelArms] } : {}),
        reason: judgeScoreUnavailableReason || "judge-score lane did not run",
        p: 1,
      };
    }
    return evaluateSpec(spec, ladder.fit);
  });
  // Multiplicity (issue #97 AC). The Holm family is `registeredFamilySlotCount(family)`
  // -- 5 -- WHATEVER this run could estimate. Every not-estimable entry is
  // still in `registeredResults` carrying p=1, so the count matches and the
  // `familySize` assertion holds. This is deliberate, not an oversight:
  // shrinking m to the number of contrasts actually estimated would make the
  // correction LESS conservative (Holm's first step multiplies by m, so
  // 5*p >= 2*p) and would make the registered family size a function of
  // which cells happened to arrive -- a data-dependent family definition,
  // which is exactly what §11 forbids. Keeping m=5 costs power and cannot
  // inflate FWER. `estimability` records what was and was not reachable so
  // the loss is visible rather than implicit.
  const estimability = familyEstimability(registeredResults);
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
      estimability,
    }),
  );

  return {
    frame,
    ladder,
    registeredResults: verdicts,
    estimability,
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
