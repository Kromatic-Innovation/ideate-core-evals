#!/usr/bin/env bash
# Stage 1c -- the rich-panel study. Registered as docs/PREREGISTRATION.md
# Appendix L; do not run this before that appendix is merged.
#
#   ./scripts/run-study1c.sh            # run it
#   ./scripts/run-study1c.sh --dry-run  # plan and price only, collects nothing
#
# Everything the run needs is baked in here on purpose. The arms, the replicate
# count, the store, the spend ceiling and the concurrency are REGISTERED values,
# not operator choices -- and a study whose invocation lives only in a chat
# transcript is a study nobody can re-run. Stage 1b's first headline numbers
# came from an uncommitted script and could not be reproduced from the repo;
# this file and evals/analysis/stage1c.mjs exist so that cannot happen twice.
set -euo pipefail
cd "$(dirname "$0")/.."

# Default: the full registered arm set. Override with the first positional
# argument -- `./scripts/run-study1c.sh S1C-RICH`.
#
# WHY AN OVERRIDE EXISTS (issue #168). Cells are keyed by configHash, so after
# #168 moved promptTemplateHash NOTHING in the store matches and every one of
# the 432 cells re-plans as `todo` -- including the 288 control cells that were
# already collected and whose requests #168 did not change (prompts.test.mjs
# asserts that invariance: 26250 and 6873 on both sides of the move). Left at
# the default, a resume would silently re-collect them: ~$35 and ~40 minutes to
# reproduce data we already hold, which is exactly what pooling the two hashes
# at analysis time exists to avoid.
#
# So the post-#168 resume is deliberately `S1C-RICH` only, and the analysis
# pools the two hashes explicitly:
#   ./scripts/run-study1c.sh S1C-RICH
#   node evals/analysis/stage1c.mjs --config-hash <pre-168>,<post-168>
# Parsed rather than read off $1 positionally, so `--dry-run` in any position
# stays a flag instead of being swallowed as the arm list.
DRY_RUN=0
ARMS_ARG=""
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    -*) echo "unknown flag: $arg" >&2; exit 2 ;;
    *) ARMS_ARG="$arg" ;;
  esac
done
ARMS="${ARMS_ARG:-S1C-SOLO60,S1C-SOLO6X10,S1C-RICH}"
REPLICATES=3
STORE="results-study1c"
# --max-spend is CUMULATIVE over the store, across every prior invocation and
# configHash in it -- not per-invocation. It counts what this STORE has already
# recorded, so the number below is a TOTAL for results-study1c, not a budget for
# this invocation. `node evals/run.mjs --help` and docs/spend-ceilings.md carry
# the full guarantee; the three things that bite when sizing this constant:
#
#   1. It is enforced MID-FLIGHT against actual spend (between cell dispatches
#      and before every judge leg), not only pre-flight against a projection.
#      A skipped cell is store-absent and re-plans as `todo`, so a ceiling that
#      trips early costs a re-run, never data.
#   2. A cell already IN FLIGHT when the ceiling trips is allowed to COMPLETE.
#      At CONCURRENCY=8 below, the bound is the ceiling plus up to eight cells'
#      actual cost -- not the ceiling exactly. Budget that headroom in.
#   3. The ceiling is decorative above the ACCOUNT BALANCE. The first Stage 1c
#      run aborted at $39.4965 against a $180 ceiling on a billing refusal.
#      Pass --account-balance (or set IDEATE_ACCOUNT_BALANCE_USD) to have that
#      checked at plan time; it is asserted by you, not queried -- neither
#      provider exposes a balance an API key can read.
#
# $117.49 was already spent before the
# #168 re-collect (Appendix L item 7 registered $180 against an expected
# $120-135; the arm that overran it was the one whose ceiling was wrong).
# Raised to $220 = $117.49 spent + ~$85 for S1C-RICH's 144 cells + headroom,
# because a max-effort reply now runs to completion (~18k tokens) instead of
# being truncated at 11640, so the corrected arm costs MORE per cell, not less.
MAX_SPEND=220          # Appendix L item 7, amended by Appendix M item 6
CONCURRENCY=8          # top of Appendix I item 7's registered 4-8 band
LOG=".tmp/stage1c-run.log"

if [[ "$DRY_RUN" == "1" ]]; then
  # --results-dir and --max-spend belong here too (issue #169). Without them the
  # dry run priced against the DEFAULT store -- a different, near-empty ledger --
  # so it reported neither this study's spent-to-date nor the projection the real
  # invocation would be admission-controlled against. A dry run that prices the
  # wrong store is worse than no dry run: it reads as a rehearsal and is not one.
  exec node evals/run.mjs --dry-run \
    --arms "$ARMS" \
    --replicates "$REPLICATES" \
    --results-dir "$STORE" \
    --max-spend "$MAX_SPEND"
fi

# Keys live in 1Password, never the shell profile: generation, judging and
# embedding legs respectively.
: "${ANTHROPIC_API_KEY:=$(op read 'op://Infrastructure/anthropic-api-key/credential')}"
: "${OPENAI_API_KEY:=$(op read 'op://Infrastructure/openai-api-key/credential')}"
: "${VOYAGE_API_KEY:=$(op read 'op://Infrastructure/voyage-api-key/credential')}"
export ANTHROPIC_API_KEY OPENAI_API_KEY VOYAGE_API_KEY
for v in ANTHROPIC_API_KEY OPENAI_API_KEY VOYAGE_API_KEY; do
  [[ -n "${!v:-}" ]] || { echo "FATAL: $v is empty" >&2; exit 1; }
done

# Refuse to start on a dirty tree: the config that produced armsConfigHash must
# be the committed one, or the store's cells carry a hash no commit reproduces.
if [[ -n "$(git status --porcelain)" ]]; then
  echo "FATAL: working tree is dirty. Commit or stash before collecting cells." >&2
  git status --short >&2
  exit 1
fi

mkdir -p .tmp
echo "arms:        $ARMS"
echo "replicates:  $REPLICATES   ($(echo "$ARMS" | tr ',' '\n' | grep -c .) arm(s) x 48 briefs x 3)"
echo "store:       $STORE"
echo "max-spend:   \$$MAX_SPEND"
echo "log:         $LOG"
echo

# --no-batch: Appendix K. The Message Batches queue costs ~10-15x in wall clock
# (a size-1 batch measured at 20.9 min against a 13s direct call) and batch wait
# GROWS with batch size, so coalescing buys nothing.
node evals/run.mjs \
  --arms "$ARMS" \
  --replicates "$REPLICATES" \
  --results-dir "$STORE" \
  --no-batch \
  --max-spend "$MAX_SPEND" \
  --cell-concurrency "$CONCURRENCY" \
  2>&1 | tee "$LOG"
