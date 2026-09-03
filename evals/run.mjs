#!/usr/bin/env node
// run.mjs — CLI entry point for the runner (issue #5, pre-registration §9/§12).
//
// Usage:
//   node evals/run.mjs --dry-run
//   node evals/run.mjs --max-spend 50 --arms A,B --briefs biz-01,biz-02 --replicates 2
//   node evals/run.mjs --max-spend-anthropic 300 --max-spend-openai 150
//   node evals/run.mjs --phase 0
//   node evals/run.mjs --max-poll-minutes 90   # batch poll ceiling (issue #92)
//   node evals/run.mjs --no-resume             # do NOT re-poll/replay a paid-for batch (issue #103)
//   node evals/run.mjs --no-cancel-on-abandon  # leave an abandoned batch running (issue #92/#103)
//   node evals/run.mjs --prune                 # what WOULD be removed (issue #98)
//   node evals/run.mjs --prune --kinds transient --cfg 5ce5478956e5 --apply
//   node evals/run.mjs --results-dir results-pilot ...   # a SEPARATE store (issue #120)
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

import { readFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";

import { CORPUS, CORPUS_HASH } from "./corpus/index.mjs";
import { ResultsStore } from "../lib/store.mjs";
import { runSpec, planPrune, pruneStore, DEFAULT_ATTEMPT_RETENTION } from "./harness/runner.mjs";
import {
  FAILURE_KINDS,
  TRANSIENT_FAILURE_KINDS,
  INTRINSIC_FAILURE_KINDS,
  PAYMENT_FAILURE_KINDS,
} from "../lib/accounting.mjs";
import { runnerPriceGrid } from "../lib/price.mjs";
import { AnthropicBatchProvider } from "./harness/provider.mjs";
import { promptTemplateHash } from "./harness/prompts.mjs";
import { voyageEmbedder } from "./metrics/embedder.mjs";
import { VOYAGE_CLUSTER_DISTANCE_THRESHOLD } from "./metrics/voyage-calibration.mjs";
import { JUDGE_MODELS } from "./judge/config.mjs";
import { judgeLegsFor } from "./judge/matrix.mjs";
// AnthropicJudgeProvider (issue #68) + OpenAIJudgeProvider (issue #77): the
// real judging LEGS this CLI wires into runSpec's per-pool judging pass --
// the pre-flight already priced judging (issue #63's judgeLegsFor above), but
// nothing actually CALLED a judge until #68 landed the Anthropic leg. #77
// supplies the OpenAI leg (a JudgeProvider distinct from OpenAIBatchProvider,
// the GENERATION adapter for arms G/H, issue #22) -- both legs are now wired
// below, so a fully-wired arm produces zero deferrals.
import { AnthropicJudgeProvider, OpenAIJudgeProvider } from "./judge/score.mjs";
import { runPhase0 } from "./metrics/phase0.mjs";
// armsConfigHash / computeJudgeHash (issue #101): the two CONFIG_FIELDS
// entries this file now populates. Kept on their own import lines rather than
// folded into the judge-provider import above so the two concerns stay
// separable in a diff.
import { armsConfigHash } from "../lib/manifest.mjs";
import { computeJudgeHash } from "./judge/score.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");

// The store this CLI reads and writes when no --results-dir is given.
// Anchored at REPO_ROOT (not cwd) so a run launched from a subdirectory still
// finds the study's one store -- unchanged behaviour, and the reason this
// constant exists rather than the join() being inlined three times.
export const DEFAULT_RESULTS_DIR = join(REPO_ROOT, "results");

/**
 * Resolve --results-dir (issue #120) to an absolute directory, refusing a
 * path that exists but is not a results store.
 *
 * ── Why the flag exists at all ──────────────────────────────────────────────
 * docs/PREREGISTRATION.md §11 permits a pilot to inform the confirmatory n
 * ONLY if "the pilot's own data is then not reused in the confirmatory test",
 * and #49 AC5 requires that exclusion be enforced STRUCTURALLY. The pilot must
 * run at the grid's configHash (a variance estimate collected under a
 * different configuration does not transfer), so every pilot cell would
 * otherwise be classified `reuse` by planRun and pooled by buildFrame -- and
 * correctly so, since there is no config change for the never-silently-pool
 * guarantee to detect. Two SEPARATE stores cannot pool at any configHash,
 * under any analysis path, whether or not anyone remembers the rule. That is
 * what makes this a structural exclusion rather than an intended one.
 *
 * ── Relative paths resolve against cwd, deliberately ────────────────────────
 * evals/analysis/analysis.mjs hands its own --results-dir value straight to
 * `new ResultsStore(...)`, i.e. resolved against process.cwd(). The whole
 * point of this flag is that the directory run.mjs WRITES is the directory
 * analysis.mjs later READS, so `--results-dir results-pilot` must name the
 * same place for both commands. It does, because both resolve it the same
 * way. Only the DEFAULT differs (REPO_ROOT-anchored here), and a default is
 * never typed twice by an operator.
 *
 * @param {string|undefined} resultsDir  the raw --results-dir value, or
 *   undefined for the default store
 * @returns {string} an absolute directory path, suitable for `new ResultsStore()`
 */
export function resolveStoreDir(resultsDir) {
  const dir = resultsDir === undefined ? DEFAULT_RESULTS_DIR : resolve(resultsDir);

  // A path that does not exist is FINE: ResultsStore's constructor mkdirs it
  // recursively and writes an empty index.jsonl, which is exactly how the
  // default `results/` store comes into being on a fresh checkout. Creating
  // the pilot's store on first use is the same behaviour, not a new one.
  if (!existsSync(dir)) return dir;

  if (!statSync(dir).isDirectory()) {
    throw new Error(
      `run.mjs: --results-dir '${resultsDir}' resolves to ${dir}, which exists and is not a directory. ` +
        "A results store is a directory holding index.jsonl + bodies/ (see lib/store.mjs).",
    );
  }

  // Exists, is a directory, is NON-EMPTY, and holds no index.jsonl: this is
  // not a store, and ResultsStore would happily initialise one on top of
  // whatever is in there. Refuse instead. The hazard is a typo'd or
  // shell-completed path (`--results-dir docs`, `--results-dir lib`) silently
  // becoming the study's store -- and, on the pilot/confirmatory split this
  // flag exists for, a mistyped pilot directory that quietly initialises
  // somewhere else is indistinguishable from a working one until the
  // confirmatory analysis reads a store that was never written.
  const entries = readdirSync(dir);
  if (entries.length > 0 && !existsSync(join(dir, "index.jsonl"))) {
    throw new Error(
      `run.mjs: --results-dir '${resultsDir}' resolves to ${dir}, which exists and is not empty but holds no ` +
        `index.jsonl -- it is not a results store (found: ${entries.slice(0, 5).join(", ")}${entries.length > 5 ? ", ..." : ""}). ` +
        "Refusing to initialise a store over it. Pass a new or empty directory, or an existing store's directory.",
    );
  }
  return dir;
}

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

// ── Prune selectors (issue #98) ─────────────────────────────────────────────
// `--kinds` accepts literal FAILURE_KINDS values AND the names of the three
// sets lib/accounting.mjs already defines. The aliases are the point: an
// operator repairing a legacy store wants "the environmental ones", and the
// consequence of mistyping or forgetting one of the five transient kinds is
// not an error message — it is a cell that stays bricked, which is exactly
// the failure this command exists to end.
const KIND_ALIASES = {
  transient: TRANSIENT_FAILURE_KINDS,
  intrinsic: INTRINSIC_FAILURE_KINDS,
  payment: PAYMENT_FAILURE_KINDS,
};

export function expandKindSelectors(raw) {
  const tokens = (raw || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!tokens.length) {
    throw new Error(
      `run.mjs: --kinds requires a comma-separated list. Accepts any of ${FAILURE_KINDS.join(", ")}, ` +
        `or a set name: ${Object.keys(KIND_ALIASES).join(", ")}.`,
    );
  }
  const out = new Set();
  for (const token of tokens) {
    if (KIND_ALIASES[token]) {
      for (const k of KIND_ALIASES[token]) out.add(k);
      continue;
    }
    if (!FAILURE_KINDS.includes(token)) {
      throw new Error(
        `run.mjs: --kinds got '${token}', which is neither a failure kind (${FAILURE_KINDS.join(", ")}) ` +
          `nor a set name (${Object.keys(KIND_ALIASES).join(", ")}). Refusing to guess — a kind this command ` +
          `silently ignores is a cell that stays unretryable.`,
      );
    }
    out.add(token);
  }
  return [...out];
}

/**
 * Render a prune plan as operator-facing lines. Pure formatter, tested
 * hermetically — the same reason formatSpendSummary and formatPhase0Report
 * are separated from console.log.
 *
 * @param {object} plan   planPrune()'s return
 * @param {object} [o]
 *   @param {boolean} [o.applied=false] whether this describes work already
 *     done (`--apply`) or work that WOULD be done (the default dry run)
 */
export function formatPrunePlan(plan, { applied = false } = {}) {
  const verb = applied ? "removed" : "would remove";
  const lines = [];
  lines.push(`[prune] store holds ${plan.keysBefore} record(s)`);

  if (!plan.selectorsGiven) {
    lines.push("[prune] no cell selector given (--cfg / --arms / --briefs / --kinds / --states) — compaction only, no cell was considered for eviction");
  }
  if (plan.evictions.length === 0 && plan.selectorsGiven) {
    lines.push("[prune] no cell matched the selectors");
  }
  for (const e of plan.evictions) {
    lines.push(
      `[prune] EVICT ${verb} cell ${e.key}  state=${e.state}${e.kind ? ` kind=${e.kind}` : ""}  ` +
        (e.costRows.length
          ? `(${e.costRows.length} cost row(s) re-homed under pruned-cell|cell=${e.key}|pruned=N — the money stays)`
          : "(no cost rows to preserve)"),
    );
  }
  for (const r of plan.refused) {
    lines.push(`[prune] REFUSED ${r.key} — ${r.reason}`);
  }

  if (plan.compactions.length === 0) {
    lines.push("[prune] no cell exceeds the attempt-retention bound — nothing to compact");
  }
  for (const c of plan.compactions) {
    lines.push(
      `[prune] COMPACT ${verb} ${c.removeKeys.length} ${c.family} record(s) for cell ${c.cellKey} ` +
        `-> ${c.newKey} (${c.rowsBefore} cost row(s) folded to ${c.rows.length}; keeping ${c.keptKeys.length} newest)`,
    );
    if (!c.rowsFolded && c.rowsBefore > 1) {
      lines.push(`[prune]   note: rows kept UNFOLDED — ${c.foldSkippedReason}`);
    }
  }

  lines.push(`[prune] ${applied ? "store now holds" : "store would hold"} ${plan.keysAfter} record(s)`);
  if (!applied) {
    lines.push("[prune] DRY RUN — nothing was modified. Re-run with --apply to commit.");
  }
  return lines;
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
      // ── --results-dir (issue #120) ──────────────────────────────────────
      // Which results store this invocation reads and writes. Mirrors the
      // flag evals/analysis/analysis.mjs has always accepted, so a pilot
      // written here is analysable there by passing the same value.
      //
      // This is NOT a mode flag: it is meaningful on a real run, a
      // --dry-run, a --prune and a --phase 0 alike, because every one of
      // those four opens a store. It therefore appears in none of the three
      // ignored-flag rejection lists in main() -- those exist for flags a
      // mode would silently DROP, and no mode drops this one.
      case "--results-dir":
        args.resultsDir = argv[++i];
        if (!args.resultsDir) throw new Error("run.mjs: --results-dir requires a directory argument");
        // A missing value would otherwise swallow the NEXT flag as the
        // directory name -- `--results-dir --prune` would create a store in a
        // directory literally called `--prune` and then run unpruned. For a
        // flag whose entire job is to say where the study's data lives, a
        // silently-wrong directory is the failure worth an explicit guard.
        if (args.resultsDir.startsWith("--")) {
          throw new Error(
            `run.mjs: --results-dir got '${args.resultsDir}', which looks like a flag, not a directory. ` +
              "Pass the store directory explicitly (e.g. --results-dir results-pilot).",
          );
        }
        break;
      // ── Issue #103 ──────────────────────────────────────────────
      // Both of these are OFF-switches for a default-on behaviour, and there
      // is deliberately no on-switch for either. Resume defaults on because
      // paying twice for replies the provider has already produced and will
      // hand back for free is never what anyone wanted. Cancel-on-abandon
      // defaults on for #92's original reason -- an abandoned batch must not
      // bill unattended -- and #103 does NOT flip it: the premise that
      // cancelling destroys the handle resume re-polls turned out to be
      // false (see provider.mjs's BATCH RESUME section for the documented
      // behaviour). The two are complements.
      case "--no-resume":
        args.noResume = true;
        break;
      case "--no-cancel-on-abandon":
        // The one case this exists for: a batch you believe is nearly done
        // and would rather leave running than cancel and re-poll later. It
        // trades a capped billing exposure for a shorter path to the result,
        // which is a judgement only an operator watching the run can make.
        args.noCancelOnAbandon = true;
        break;
      case "--max-poll-minutes":
        // Issue #92: the batch poll ceiling, in MINUTES because that is the
        // unit an operator reasons about batch latency in (the provider takes
        // milliseconds). Validated the same way as --max-spend, and for a
        // sharper reason: a NaN ceiling does not merely disable a gate, it
        // makes `Date.now() > deadline` permanently false, so the poll loop
        // would never exit at all. A non-positive value is rejected here too
        // -- at the CLI, "wait zero minutes" is always a typo, even though
        // AnthropicBatchProvider accepts it directly so tests can force the
        // ceiling without waiting.
        args.maxPollMinutes = parseRequiredNumber(argv, ++i, "--max-poll-minutes");
        if (!(args.maxPollMinutes > 0)) {
          throw new Error(`run.mjs: --max-poll-minutes must be greater than 0, got ${args.maxPollMinutes}`);
        }
        break;
      // ── --prune and its selectors (issue #98) ───────────────────────────
      // `--prune` is a MODE, not a flag on a run: it never generates, never
      // judges, never calls a provider. It is DRY-RUN BY DEFAULT and needs
      // `--apply` to touch anything, which is what makes it safe to put the
      // only delete path in this repo behind it. A dry run that reports
      // exactly what an apply would do is worth more than any amount of
      // "are you sure? [y/N]" — the operator can read it, diff it, re-run it.
      case "--prune":
        args.prune = true;
        break;
      case "--apply":
        args.apply = true;
        break;
      case "--cfg":
        // Scope by configHash. Named --cfg to match the `cfg=` segment of
        // the cell key the operator is reading this out of.
        args.cfg = argv[++i];
        if (!args.cfg) throw new Error("run.mjs: --cfg requires a configHash argument");
        break;
      case "--kinds":
        // Failure kinds, or one of the three set names lib/accounting.mjs
        // already defines (`transient`, `intrinsic`, `payment`). The aliases
        // exist because the operator's real question is "clear the
        // environmental faults", and making them retype five kind names
        // invites getting one wrong — and a MISSING kind here silently
        // leaves a bricked cell bricked.
        args.kinds = expandKindSelectors(argv[++i]);
        break;
      case "--states":
        args.states = (argv[++i] || "").split(",").map((s) => s.trim()).filter(Boolean);
        if (!args.states.length) throw new Error("run.mjs: --states requires a comma-separated list (completed, failed, skipped)");
        for (const s of args.states) {
          if (!["completed", "failed", "skipped"].includes(s)) {
            throw new Error(`run.mjs: --states got '${s}' — valid terminal states are completed, failed, skipped (lib/accounting.mjs TERMINAL_STATES)`);
          }
        }
        break;
      case "--allow-completed":
        args.allowCompleted = true;
        break;
      case "--keep-attempts":
        args.keepAttempts = parseRequiredNumber(argv, ++i, "--keep-attempts");
        if (!Number.isInteger(args.keepAttempts) || args.keepAttempts < 1) {
          throw new Error(`run.mjs: --keep-attempts must be a positive integer, got ${args.keepAttempts}`);
        }
        break;
      default:
        throw new Error(`run.mjs: unrecognized flag '${a}'`);
    }
  }
  return args;
}

// argv/deps are injectable (issue #62 BLOCKER 2): main() previously always
// read process.argv and always constructed the real runSpec/ResultsStore,
// so nothing outside a real CLI invocation could exercise its WIRING --
// e.g. mutating away `priceGrid: runnerPriceGrid()` or
// `maxSpendByProviderUsd: args.maxSpendByProviderUsd` from the runSpec call
// below left every test green, because run.test.mjs only ever called
// parseArgs(), never main(). `deps.runSpecFn`/`deps.store` let a test inject
// a spy in place of the real runSpec and a hermetic temp store in place of
// the real `results/` directory, so main()'s actual call site can be
// asserted against directly. Both default to the real implementations, so a
// genuine CLI invocation (`main()`, no args) is unchanged.
/**
 * Render `runSpec()`'s summary as operator-facing lines: this-invocation
 * actual spend per provider, cumulative spend-to-date per provider, the
 * cumulative grand total (`--max-spend`'s own basis -- provider spend PLUS
 * non-provider/embedder spend, see runner.mjs's summary-assembly comment and
 * docs/PREREGISTRATION.md §12 for why), and an explicit non-provider
 * (embedder) line so that spend is named, not merely folded into a total
 * silently. This is the ONLY place any of this reaches the terminal (PR #72
 * review, HIGH): before this, `summary.*` was computed by runSpec() and then
 * discarded -- `await runSpecFn(spec, runSpecOpts);` never captured the
 * result -- so under the study's REGISTERED configuration
 * (`--max-spend-anthropic 300 --max-spend-openai 150`, no global
 * `--max-spend`) an operator watching a real invocation saw NO spend figure
 * at all; the only log line (`runner.mjs`'s `[max-spend]`) is gated on the
 * global ceiling being set, which this study's config never does.
 *
 * `summary.cumulativeSpendByProvider` etc. are `null` when no
 * `--max-spend`/`--max-spend-<provider>` was passed this invocation (see
 * runner.mjs's `priorSpend`) -- printed as an explicit "not computed" line,
 * never a fabricated $0, matching the same non-negotiable this repo applies
 * everywhere else a number could be silently wrong instead of loudly absent.
 *
 * `storeDir` (issue #120) names the store these cumulative figures were read
 * OUT OF. Since --results-dir made the store selectable, "study-to-date" is
 * no longer a single unambiguous number: a pilot invocation and a
 * confirmatory invocation each have their own, and they are SUPPOSED to be
 * different (that separation is the §11 guarantee). A cumulative total
 * printed without its basis is therefore a number an operator can read as
 * the wrong study's spend -- and --max-spend gates on that same number.
 *
 * @param {object} summary  runSpec()'s returned `summary` (absent on a
 *   `--dry-run` invocation, which returns `{ dryRun }` instead -- callers
 *   should not call this function for that case)
 * @param {object} [o]
 *   @param {string} [o.storeDir] the store the cumulative figures came from
 * @returns {string[]} lines, one per `console.log`/`log()` call
 */
export function formatSpendSummary(summary, { storeDir } = {}) {
  if (!summary) return [];
  const inStore = storeDir ? ` in store ${storeDir}` : "";
  const lines = [];
  const fmt = (usd) => `$${Number(usd).toFixed(4)}`;
  const byProviderLine = (label, obj) => {
    const entries = Object.entries(obj || {});
    if (entries.length === 0) return `${label}: (none)`;
    return `${label}: ` + entries.map(([provider, usd]) => `${provider}=${fmt(usd)}`).join(", ");
  };

  lines.push("[spend] --- this invocation (actual) ---");
  lines.push(byProviderLine("[spend] by provider", summary.spendByProvider));

  // `== null` (loose) rather than `=== null` on purpose: runner.mjs's real
  // summary sets this to `null` explicitly when no ceiling was active, but
  // a bare/spy summary (e.g. run.test.mjs's spyRunSpec, which returns `{}`)
  // leaves it `undefined` -- both mean the same thing here ("nothing to
  // show"), and this function must not crash on either.
  if (summary.cumulativeSpendByProvider == null) {
    lines.push(`[spend] --- cumulative (study-to-date${inStore}) --- NOT COMPUTED`);
    lines.push("[spend] no --max-spend/--max-spend-<provider> was requested this invocation, so the store's full cost history was not read. Pass a ceiling flag to see cumulative spend, or query spendToDate(store) directly.");
  } else {
    lines.push(`[spend] --- cumulative (study-to-date${inStore}, across every prior invocation and configHash in THAT store only) ---`);
    lines.push(byProviderLine("[spend] by provider", summary.cumulativeSpendByProvider));
    const nonProviderModels = summary.cumulativeNonProviderModels || [];
    lines.push(`[spend] excluded (non-provider, e.g. embedder): ${fmt(summary.cumulativeNonProviderSpendUsd)}` + (nonProviderModels.length ? ` (${nonProviderModels.join(", ")})` : ""));
    lines.push(`[spend] TOTAL (matches --max-spend's own basis: provider + non-provider): ${fmt(summary.cumulativeSpendUsd)}`);
  }
  return lines;
}

// Phase 0 (docs/PREREGISTRATION.md §8.3, issue #48): negative controls + DAT
// replication against the live Voyage embedder. Pure formatter for
// runPhase0()'s summary, separated from console.log the same way the
// now-deleted live-validation.mjs's renderRandomPoolReport was -- so the
// report content is hermetically testable without a live embedder (see
// run.test.mjs).
//
// Deliberately reports on THREE controls only (duplicate pool, random-text
// pool, DAT replication) -- the fourth control in §4.4's table (judge
// test-retest, replacing the vacuous shuffled-label control per Appendix B
// item 12) needs #63/#64 landed first and is out of scope for --phase 0
// today; see phase0.mjs's header for the full reasoning. This formatter
// never claims "all controls" passed -- only the three it actually names.
export function formatPhase0Report(summary) {
  const { dat, controls, duplicatePassed, randomVerdict, allPassed, embedderId, totalTokens, threshold, runId, gitSha, datKey, controlsKey } = summary;
  const fmt = (n) => (Number.isFinite(n) ? n.toFixed(4) : String(n));
  const lines = [];
  lines.push(`[phase0] embedder: ${embedderId} (live Voyage API)`);
  lines.push(`[phase0] Voyage-calibrated clustering threshold: ${threshold} (issue #42 / Appendix B item 8)`);
  if (runId) lines.push(`[phase0] run: ${runId}${gitSha ? ` (git ${gitSha})` : ""}`);
  if (datKey) lines.push(`[phase0] stored keys: ${datKey}, ${controlsKey}`);
  lines.push("");
  lines.push("[phase0] DAT replication:");
  lines.push(`  low=${fmt(dat.low)} average=${fmt(dat.average)} high=${fmt(dat.high)}`);
  lines.push(`  margin (high-low, DESCRIPTIVE ONLY -- not compared against any registered bound)=${fmt(dat.margin)}`);
  lines.push(dat.orderingHolds ? "  PASS: ordering low < average < high holds" : "  FAIL: published ordering did not hold");
  lines.push("");
  lines.push("[phase0] duplicate pool (30 copies):");
  lines.push(
    `  distinct_k=${controls.duplicate.distinctK} diversity=${fmt(controls.duplicate.diversity)} collapseRate=${fmt(controls.duplicate.collapseRate)}`,
  );
  lines.push(duplicatePassed ? "  PASS: collapses to distinct_k=1 / near-zero diversity" : "  FAIL: did not collapse as expected");
  lines.push("");
  lines.push("[phase0] random-text pool (30 unrelated sentences):");
  lines.push(
    `  distinct_k=${controls.random.distinctK} diversity=${fmt(controls.random.diversity)} collapseRate=${fmt(controls.random.collapseRate)}`,
  );
  lines.push(`  distinct_k check: ${randomVerdict.distinctKPass ? "PASS" : "FAIL"}`);
  lines.push(`  diversity-floor check: ${randomVerdict.floorVerdict.toUpperCase()}`);
  lines.push("");
  lines.push(`[phase0] usage: ${totalTokens} total_tokens (Voyage embeddings; covered by the free-token allocation)`);
  lines.push(
    `[phase0] NOTE: the duplicate-pool and random-text-pool controls pass under almost any threshold -- this ` +
      "result is NOT evidence the threshold itself is right (see issue #42 for that). It only shows the embedding " +
      "pipeline is wired correctly.",
  );
  lines.push(
    `[phase0] NOTE: judge test-retest (§4.4's 4th control, Appendix B item 12) is NOT run by --phase 0 -- it needs ` +
      "#63/#64 landed first (see issue #48/#49).",
  );
  lines.push(`[phase0] THREE-CONTROL RESULT: ${allPassed ? "ALL PASS" : "AT LEAST ONE FAILED -- stop, per §8.3"}`);
  return { lines, allPassed };
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  const {
    runSpecFn = runSpec,
    store: injectedStore,
    // log (issue #64 follow-up, PR #72 review): injectable so tests can
    // capture the end-of-run spend summary without polluting test output --
    // defaults to console.log so a genuine CLI invocation is unchanged.
    log = (msg) => console.log(msg),
    // getEngineVersion is injectable (issue #62 CI break): the real
    // implementation does `require.resolve("ideate-core")`, a genuine
    // dependency lookup that only succeeds when node_modules exists. CI runs
    // bare `node --test` with no `npm ci` (deliberately -- see the hermetic
    // rationale on getInstalledEngineVersion above), so a test that calls
    // main() without stubbing this seam fails in CI even though it passes
    // locally on a machine that happens to have `npm install`ed. Defaults to
    // the real resolver, so a genuine CLI invocation is unchanged.
    getEngineVersion = getInstalledEngineVersion,
    // runPhase0Fn is injectable for the exact same reason: a real --phase 0
    // invocation calls the live Voyage API (see phase0.mjs), and a test that
    // exercises main()'s --phase 0 WIRING (not just phase0.mjs's own logic,
    // already covered in phase0.test.mjs) must never touch the network.
    runPhase0Fn = runPhase0,
  } = deps;
  const args = parseArgs(argv);

  // ── Which store (issue #120) ──────────────────────────────────────────
  // Resolved ONCE, before any mode branches, and used by all four of them
  // (--prune, --phase 0, --dry-run, a real run). Resolving it here rather
  // than at each `new ResultsStore(...)` site is what makes it impossible
  // for a mode to be added later that silently keeps the default.
  if (injectedStore && args.resultsDir !== undefined) {
    // Precedence stated out loud instead of one silently winning. A real CLI
    // invocation never injects, so this can only fire in a test -- where a
    // no-op flag is exactly the thing that would make a --results-dir test
    // pass without --results-dir doing anything.
    throw new Error(
      "run.mjs: --results-dir and an injected store are mutually exclusive -- the injected store already fixes " +
        "the directory, so honouring the flag would silently do nothing.",
    );
  }
  const storeDir = injectedStore ? null : resolveStoreDir(args.resultsDir);
  const openStore = () => injectedStore || new ResultsStore(storeDir);
  // What every mode's report says it read. `spendToDate()` is cumulative
  // over the store IN USE, so an operator running the pilot must never read
  // a total that silently includes the main store (or vice versa) -- and
  // --max-spend gates on precisely that number.
  const storeLabel = injectedStore
    ? (typeof injectedStore.dir === "string" ? injectedStore.dir : "(injected store)")
    : storeDir;
  const storeOrigin = injectedStore ? "injected" : args.resultsDir === undefined ? "default" : "--results-dir";
  log(`[store] results store: ${storeLabel} (${storeOrigin})`);

  // ── --prune (issue #98) ───────────────────────────────────────────────
  // Handled FIRST, and returning before anything else: a prune reads and
  // rewrites a store, and that is all it does. It must not resolve
  // ideate-core's version, must not read arms.config.json, must not build a
  // provider or an embedder, and must not require VOYAGE_API_KEY — a repair
  // command that cannot run on a machine missing a dependency it will never
  // call is a repair command that is unavailable exactly when it is needed.
  if (args.prune) {
    const runOnlyFlags = [];
    if (args.maxSpendUsd !== undefined) runOnlyFlags.push("--max-spend");
    if (args.maxSpendByProviderUsd !== undefined) runOnlyFlags.push("--max-spend-anthropic/--max-spend-openai");
    if (args.replicates !== undefined) runOnlyFlags.push("--replicates");
    if (args.noBatch) runOnlyFlags.push("--no-batch");
    if (args.noResume) runOnlyFlags.push("--no-resume");
    if (args.noCancelOnAbandon) runOnlyFlags.push("--no-cancel-on-abandon");
    if (args.maxPollMinutes !== undefined) runOnlyFlags.push("--max-poll-minutes");
    if (args.phase !== undefined) runOnlyFlags.push("--phase");
    if (runOnlyFlags.length) {
      // Same non-negotiable --phase 0 applies: a flag silently ignored on a
      // live code path is the wrong pattern to leave in place, and here the
      // live code path DELETES.
      throw new Error(
        `run.mjs: --prune does not accept ${runOnlyFlags.join(", ")} — a prune runs no cells, calls no provider, ` +
          "and has no spend ceiling to enforce. Scope it with --cfg/--arms/--briefs/--kinds/--states instead.",
      );
    }
    if (args.dryRun && args.apply) {
      throw new Error("run.mjs: --dry-run and --apply contradict each other. --prune is dry-run by default; pass --apply only when you mean to modify the store.");
    }
    const store = openStore();
    const pruneOpts = {
      configHash: args.cfg,
      armIds: args.arms,
      briefIds: args.briefs,
      kinds: args.kinds,
      states: args.states,
      allowCompleted: args.allowCompleted === true,
      keepAttempts: args.keepAttempts === undefined ? DEFAULT_ATTEMPT_RETENTION : args.keepAttempts,
    };
    if (!args.apply) {
      for (const line of formatPrunePlan(planPrune(store, pruneOpts), { applied: false })) log(line);
      return;
    }
    const result = pruneStore(store, pruneOpts);
    for (const line of formatPrunePlan(result.plan, { applied: true })) log(line);
    // The spend figures are printed even though pruneStore() already THREW
    // on any drift: the invariant this whole command is built around is
    // "the money survived", and an operator who just deleted records should
    // see the number, not merely be told no error occurred.
    log(`[prune] spend-to-date before: $${result.spendBefore.totalUsd.toFixed(6)}`);
    log(`[prune] spend-to-date after:  $${result.spendAfter.totalUsd.toFixed(6)}  (verified unchanged — a prune never makes the study look cheaper than it was)`);
    return result;
  }

  // The mirror image of the --prune branch's own rejection above, and of
  // --phase 0's: a prune-only flag on a REAL run is silently meaningless
  // today, and the run is the code path that spends money. The concrete
  // hazard is an edit, not a typo -- an operator runs
  // `--prune --cfg X --kinds transient --apply`, deletes the `--prune`, and
  // gets a full unscoped run under flags that read exactly like scoping.
  const pruneOnlyFlags = [];
  if (args.apply) pruneOnlyFlags.push("--apply");
  if (args.cfg !== undefined) pruneOnlyFlags.push("--cfg");
  if (args.kinds !== undefined) pruneOnlyFlags.push("--kinds");
  if (args.states !== undefined) pruneOnlyFlags.push("--states");
  if (args.allowCompleted) pruneOnlyFlags.push("--allow-completed");
  if (args.keepAttempts !== undefined) pruneOnlyFlags.push("--keep-attempts");
  if (pruneOnlyFlags.length) {
    throw new Error(
      `run.mjs: ${pruneOnlyFlags.join(", ")} ${pruneOnlyFlags.length === 1 ? "is" : "are"} only meaningful with --prune, ` +
        "and this invocation would run real cells. Add --prune if you meant to repair the store; remove the flag(s) if you meant to run.",
    );
  }

  // --phase is accepted (per §12's flag table). Phase 0 (docs/PREREGISTRATION.md
  // §8.3: negative controls + DAT replication, issue #48) is now REAL --
  // it runs the three in-scope controls (see phase0.mjs header for why the
  // §4.4 table's 4th control, judge test-retest, is deferred) against the
  // live Voyage embedder and persists results to the store. No other phase
  // has a mapping yet -- docs/PREREGISTRATION.md §8.3 defines phases 1-4 as
  // a HUMAN-GATED sequence ("no phase starts without an explicit go"), and
  // nothing in this repo yet codifies which arms/briefs belong to phases
  // 1-3 -- that mapping is a judgment call for whoever runs the study, made
  // via --arms/--briefs/--replicates directly for now. Failing loudly for
  // phase != 0 (rather than silently ignoring --phase or guessing a mapping)
  // keeps a mistaken "I passed --phase so I'm scoped correctly" assumption
  // from quietly running the full grid.
  if (args.phase === 0) {
    if (args.dryRun) {
      throw new Error(
        "run.mjs: --dry-run is not supported with --phase 0 -- Phase 0 has no arms/briefs cost projection to " +
          "dry-run; it makes real (free-tier) Voyage embedding calls. Run `node evals/run.mjs --phase 0` directly.",
      );
    }
    // Phase 0 is a fixed, embeddings-only run (three controls, no arms/briefs
    // grid, no batching, effectively free) -- every other flag parseArgs
    // accepts is meaningless here. REJECT them explicitly rather than
    // silently ignoring them (as a prior version of this branch did, simply
    // by returning before reading them): a budget-safety flag
    // (--max-spend[-anthropic|-openai]) silently dropped on a live code path
    // is the wrong pattern to leave in place on the branch phases 1-3 (which
    // DO spend real money) will land on.
    const ignoredFlags = [];
    if (args.maxSpendUsd !== undefined) ignoredFlags.push("--max-spend");
    if (args.maxSpendByProviderUsd !== undefined) ignoredFlags.push("--max-spend-anthropic/--max-spend-openai");
    if (args.arms !== undefined) ignoredFlags.push("--arms");
    if (args.briefs !== undefined) ignoredFlags.push("--briefs");
    if (args.replicates !== undefined) ignoredFlags.push("--replicates");
    if (args.noBatch) ignoredFlags.push("--no-batch");
    if (args.noResume) ignoredFlags.push("--no-resume");
    if (args.noCancelOnAbandon) ignoredFlags.push("--no-cancel-on-abandon");
    // --max-poll-minutes (issue #92) is a batch-mode flag; Phase 0 makes no
    // batch calls at all. Listed here for the same reason every other flag is:
    // silently dropping a flag on a live code path is the pattern this branch
    // exists to refuse.
    if (args.maxPollMinutes !== undefined) ignoredFlags.push("--max-poll-minutes");
    if (ignoredFlags.length > 0) {
      throw new Error(
        `run.mjs: --phase 0 does not accept ${ignoredFlags.join(", ")} -- Phase 0 is a fixed three-control run ` +
          "with no arms/briefs grid and no spend ceiling to enforce (embeddings only, covered by Voyage's free-token " +
          "allocation). Run `node evals/run.mjs --phase 0` with no other flags.",
      );
    }
    const apiKey = process.env.VOYAGE_API_KEY;
    if (!apiKey) {
      throw new Error(
        "run.mjs: VOYAGE_API_KEY is not set. --phase 0 calls the live Voyage embedding API (negative controls + " +
          "DAT replication, docs/PREREGISTRATION.md §8.3) and requires a real API key -- this harness never " +
          "invents or defaults one. Set VOYAGE_API_KEY in the environment and re-run:\n" +
          "  VOYAGE_API_KEY=... node evals/run.mjs --phase 0",
      );
    }
    const store = openStore();
    const summary = await runPhase0Fn({ apiKey, store });
    const { lines, allPassed } = formatPhase0Report(summary);
    for (const line of lines) console.log(line);
    if (!allPassed) process.exitCode = 1;
    // INTENTIONAL early return (merge of #69/Phase 0 and #64's cumulative-
    // spend follow-up, PR #72 review): Phase 0 never calls runSpec() -- it
    // runs no arms/briefs cells at all (three fixed embedding-only
    // controls, per the ignoredFlags rejection above, which already refuses
    // --max-spend/--max-spend-<provider> for this phase) -- so there is no
    // `summary` for `formatSpendSummary()` below to render. Returning here,
    // before that code is ever reached, keeps it that way explicitly rather
    // than as an accident of where this branch happens to sit in the
    // function. A spend block after `formatPhase0Report`'s own report would
    // be either empty (confusing -- "which run does this belong to?") or,
    // if `store` already holds prior generation spend, present but
    // unrelated to what --phase 0 just did -- misleading either way.
    return;
  }
  if (args.phase !== undefined) {
    throw new Error(
      "run.mjs: --phase is accepted by the flag parser (pre-registration §12) but only --phase 0 is wired to a " +
        "real mapping today (issue #48) -- use --arms/--briefs/--replicates directly to scope any other phase " +
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
  const engineVersion = getEngineVersion();
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
      // promptHash (issue #99): the REAL generation-prompt hash, not the
      // literal "unpinned" this used to carry. A constant is a CONFIG_FIELDS
      // entry that can never change, so a prompt edit was invisible to the
      // staleness machinery built to catch exactly that -- #93 changed the
      // generation prompts' token budget and added salvage, and cells from
      // before and after that change hashed identically and would have been
      // pooled as comparable data. promptTemplateHash() (evals/harness/prompts.mjs,
      // sha256/12, mirroring judgePromptHash) covers both templates RENDERED,
      // the token-sizing constants, and SALVAGE_VERSION.
      //
      // This moves configHash, and therefore every arm's cellKey, marking the
      // whole #8 smoke-study dataset `stale`. That is correct and intended:
      // #8's results are discarded from confirmatory analysis by construction,
      // and absorbing the invalidation now costs a $3.32 smoke run rather than
      // Phase 2's grid.
      promptHash: promptTemplateHash(),
      // judgeHash (issue #101): populated at last, with the SAME
      // computeJudgeHash() evals/judge/score.mjs has exported since #21 --
      // it folds judgePromptHash() and the registered judge model roster
      // into one 12-hex value. Nothing here invents a hash; the mechanism
      // already existed and simply had no caller on the run path.
      //
      // #101 asked whether to populate this field or delete it, on the
      // grounds that a declared-but-never-set CONFIG_FIELDS entry reads as
      // covered and is worse than an absent one. Deleting it is not
      // available: docs/PREREGISTRATION.md §11 names "judge hash" among the
      // things configHash covers, and Appendix B item 3 registers IN ADVANCE
      // that judgeHash is a CONFIG_FIELDS entry and that a rubric change
      // flowing judgeHash -> configHash -> cellKey is "correct and
      // intended". Removing it would be a pre-registration deviation
      // requiring its own registered justification, not a code cleanup.
      //
      // Note what this deliberately costs: swapping a JUDGE now invalidates
      // GENERATION cells, which must be re-generated rather than merely
      // re-scored. That is the registered trade, and it is the conservative
      // direction -- §5.3/§11 treat a cell's result as comparable only if
      // the judge that could score it is identical too.
      judgeHash: computeJudgeHash({ judgeModels: JUDGE_MODELS }),
      embedderId,
      corpusHash: CORPUS_HASH,
      // armsConfigHash (issue #101): THE headline fix. arms.config.json was
      // hashed nowhere, so the single variable this entire study manipulates
      // -- "the ONLY thing varying between arms is model assignment", per the
      // file's own header -- was invisible to configHash. Editing arm C from
      // claude-sonnet-5 to claude-opus-5 produced cells carrying the SAME
      // configHash as the old ones; planRun classified them `reuse` and the
      // frame pooled two different experiments with no `stale` warning.
      //
      // This also subsumes the `ideasPerAgent` / `maxRounds` CONFIG_FIELDS
      // entries, now removed -- see lib/manifest.mjs for why a per-spec slot
      // could never honestly hold those per-arm values.
      armsConfigHash: armsConfigHash(armsConfig),
      // clusterDistanceThreshold (issue #101): stamped HERE, on the
      // generation side, settling the ownership question #101 left open.
      //
      // It is a CONFIG_FIELDS entry registered by docs/PREREGISTRATION.md
      // Appendix B item 8, but until now run.mjs passed it only as a
      // runSpec() OPTION (see runSpecOpts below) and never into spec.config,
      // so it never reached the hash. Since #85 wired pool metrics into
      // runSpec, the threshold shapes a stored GENERATION artifact --
      // distinct_k is a direct function of it -- which is precisely what
      // makes it comparability-relevant and this file's to stamp.
      //
      // evals/analysis/ is NOT the owner and is untouched: post-#91 the
      // analysis side computes no hash at all, it reads the store's own cfg
      // (evals/analysis/storeConfig.mjs). Its --cluster-distance-threshold
      // flag survives as a RECOMPUTATION parameter for the rarefied lane,
      // where a value disagreeing with what generation used already fails
      // loudly -- buildRarefiedFrame recomputes full-pool distinct_k and
      // throws on a mismatch with the stored scalar (rarefiedFrame.mjs).
      //
      // Set UNCONDITIONALLY, never gated on whether `embedder` got wired
      // below: a config whose hash depended on the presence of a
      // VOYAGE_API_KEY would make --dry-run project a different configHash
      // than the real run it is supposed to be projecting.
      clusterDistanceThreshold: VOYAGE_CLUSTER_DISTANCE_THRESHOLD,
    },
  };

  const store = openStore();

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
    // maxPollMs (issue #92): passed only when the operator actually set
    // --max-poll-minutes, so an unset flag falls through to the provider's own
    // DEFAULT_MAX_POLL_MS rather than being re-specified (and able to drift)
    // here. `undefined` would trigger the same default, but passing the key
    // explicitly-as-undefined hides which layer owns the number.
    provider = new AnthropicBatchProvider({
      apiKey,
      corpus: CORPUS,
      armsConfig,
      ...(args.maxPollMinutes !== undefined ? { maxPollMs: args.maxPollMinutes * 60 * 1000 } : {}),
      // Same "pass only what the operator actually set" discipline as
      // maxPollMs above: an unset off-switch leaves the provider's own
      // default-on in place rather than re-specifying it here, where it could
      // drift out of agreement with the class.
      ...(args.noResume ? { resume: false } : {}),
      ...(args.noCancelOnAbandon ? { cancelOnAbandon: false } : {}),
    });
  }

  // judgeProviders (issue #68 anthropic leg, issue #77 openai leg): the real
  // judge legs, constructed only for a real (non-dry-run) invocation,
  // mirroring the generation `provider` construction immediately above
  // (dry-run's early return in runSpec() never reaches the judging pass, so
  // this is unused but harmless there). The Anthropic leg shares the SAME
  // ANTHROPIC_API_KEY already validated above. The OpenAI leg reads
  // OPENAI_API_KEY directly -- unlike the Anthropic key, this CLI does not
  // pre-flight-check it (a run using only Anthropic-judged arms should not be
  // blocked by an unset OpenAI credential); OpenAIJudgeProvider's own
  // constructor guard returns a classified harness_error per call if it is
  // unset, mirroring AnthropicJudgeProvider's no-apiKey behavior, never a
  // thrown error.
  const judgeProviders = args.dryRun
    ? {}
    : {
        anthropic: new AnthropicJudgeProvider({ apiKey: process.env.ANTHROPIC_API_KEY }),
        openai: new OpenAIJudgeProvider({ apiKey: process.env.OPENAI_API_KEY }),
      };

  // embedder (issue #85): the wiring that makes pool metrics (distinct_k,
  // diversity, collapse rate, embedded pools) reachable from a real CLI run
  // at all -- before this, evals/metrics/operational.mjs's
  // poolMetricsSummary had zero non-test callers (the same "registered
  // stage, no caller" shape #68/#77 fixed for judging). Constructed only
  // for a real (non-dry-run) invocation, mirroring `provider`/
  // `judgeProviders` immediately above -- runSpec()'s dry-run branch never
  // reaches the metrics pass either way. VOYAGE_API_KEY is checked here, at
  // the CLI boundary, so a misconfigured real run fails loudly before any
  // generation spend happens (runSpec()'s own pre-flight assertion catches
  // a missing clusterDistanceThreshold the same way; this catches a missing
  // credential one layer up, at construction, mirroring the
  // ANTHROPIC_API_KEY check above).
  let embedder;
  if (!args.dryRun) {
    const voyageApiKey = process.env.VOYAGE_API_KEY;
    if (!voyageApiKey) {
      throw new Error(
        "run.mjs: VOYAGE_API_KEY is not set. A real (non-dry-run) invocation embeds every completed pool via the " +
          "live Voyage API (pool-level metrics -- distinct_k, diversity, collapse rate -- issue #85) and requires " +
          "a real API key -- this harness never invents or defaults one. Set VOYAGE_API_KEY in the environment, " +
          "or pass --dry-run to plan the run without calling anything.",
      );
    }
    embedder = voyageEmbedder({ apiKey: voyageApiKey });
  }

  const runSpecOpts = {
    store,
    armsConfig,
    provider,
    batch: !args.noBatch,
    resume: !args.noResume, // issue #103
    dryRun: args.dryRun,
    // judgeModels/judgeProviders/corpus (issue #68): THE wiring that makes
    // judging reachable from a real CLI run at all -- before this, nothing
    // outside a test ever called runJudgeMatrix/runJudgeValidation (see the
    // issue: "runJudgeMatrix has no non-test caller"). judgeModels is the
    // SAME registered roster (evals/judge/config.mjs) the pre-flight
    // (judgeLegsFor below) already prices judging against, so what gets
    // JUDGED and what gets PRICED can never silently diverge.
    judgeModels: JUDGE_MODELS,
    judgeProviders,
    corpus: CORPUS,
    // embedder/clusterDistanceThreshold (issue #85): opt-in switch that
    // makes runSpec() compute pool metrics for every completed cell -- see
    // the `embedder` construction above and runner.mjs's own opts doc.
    // VOYAGE_CLUSTER_DISTANCE_THRESHOLD is the Voyage-4-lite-calibrated
    // threshold (issue #42) -- the live embedder built above always
    // produces vectors in THAT space, never the hermetic MiniLM fixture
    // space calibration.mjs's CLUSTER_DISTANCE_THRESHOLD is valid for.
    embedder,
    clusterDistanceThreshold: VOYAGE_CLUSTER_DISTANCE_THRESHOLD,
    // --max-spend-anthropic/--max-spend-openai (issue #51) need real,
    // pinned-rate-table pricing to be meaningful pre-flight -- the interim
    // estimator runSpec() falls back to when no priceGrid is injected has no
    // per-model rate for every model and is explicitly labelled a
    // placeholder (see runner.mjs's own header). Wiring lib/price.mjs's
    // runnerPriceGrid() here is the "follow-up PR" that module's own header
    // comment names as the way the CLI adopts it -- zero changes to
    // runner.mjs's own default were needed for this.
    //
    // judgeLegsFor (issue #63, revised in the fix round) -- the pre-flight
    // must price the planned JUDGING too, not only the planned generation:
    // docs/PREREGISTRATION.md §12 discloses that neither --max-spend nor
    // --max-spend-<provider> could see the cross-judge matrix's spend, and
    // that judge spend is the dominant OpenAI cost driver. Wires the SAME
    // judge-selection logic the real matrix uses (evals/judge/matrix.mjs's
    // judgeLegsFor factory, backed by buildJudgeMatrix's pickDistinctJudge)
    // plus arms.config.json's own panel shape, so each planned cell's judge
    // legs are priced per-model, batch-aware, and fail loud on a missing
    // rate -- not a flat per-pool guess.
    priceGrid: runnerPriceGrid(undefined, { judgeLegsFor: judgeLegsFor({ judgeModels: JUDGE_MODELS, panelConfig: armsConfig.panel }) }),
    maxSpendUsd: args.maxSpendUsd,
    maxSpendByProviderUsd: args.maxSpendByProviderUsd,
    armIds: args.arms,
    briefIds: args.briefs,
    replicates: args.replicates,
    log, // same injectable log this function's own end-of-run summary uses
  };
  const result = await runSpecFn(spec, runSpecOpts);
  // Print the spend summary (issue #64 follow-up, PR #72 review, HIGH) --
  // the ONLY place any of runSpec()'s spend accounting reaches the operator.
  // `result.summary` is absent on --dry-run (runSpec returns `{ dryRun }`
  // instead, and --dry-run already prints its own projection via `log` --
  // see runner.mjs's dry-run branch), so formatSpendSummary's own
  // `if (!summary) return []` guard makes this a no-op there.
  for (const line of formatSpendSummary(result && result.summary, { storeDir: storeLabel })) log(line);
  // Judge payment abort notice (issue #106). Without this the abort is
  // INVISIBLE: runner.mjs logs #88's `[run] ABORTED:` line for a
  // GENERATION-side refusal, but a judge-side one only moves a count inside
  // `summary.judge.byKind`, which nothing prints. The operator action is the
  // same as #88's -- fund the account, re-run -- and it cannot be taken if
  // the run never says the judge account went dry.
  //
  // Deliberately says what is and is not affected, because the answer is
  // asymmetric and surprising by design: GENERATION completed normally, and
  // the pools it produced are judged on the next invocation once the account
  // is funded (runSpec() judges an already-generated-but-unjudged pool on
  // resume -- issue #68 AC4). Nothing here needs re-generating.
  const judgeSummary = result && result.summary && result.summary.judge;
  const judgePaymentFailures = (judgeSummary && judgeSummary.byKind && judgeSummary.byKind.payment_required) || 0;
  if (judgePaymentFailures) {
    log(
      `[run] JUDGING ABORTED: at least one judge account refused on billing/credit. ${judgePaymentFailures} judge ` +
        `leg(s) are payment_required -- the leg(s) that were actually refused, plus every later leg on that same ` +
        `account, which were NOT attempted (each would have hit the identical wall). This count cannot say how the ` +
        `total splits between the two, only that it is entirely billing. GENERATION was NOT stopped and is ` +
        `unaffected: those pools are already stored, and the ` +
        `next invocation of this same command judges them once the account is funded. Judge legs on the OTHER ` +
        `provider were unaffected. Spend already incurred is preserved; see docs/retrying-failed-cells.md.`,
    );
  }
  return result;
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
