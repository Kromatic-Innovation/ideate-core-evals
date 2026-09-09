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

ARMS="S1C-SOLO60,S1C-SOLO6X10,S1C-RICH"
REPLICATES=3
STORE="results-study1c"
MAX_SPEND=180          # Appendix L item 7 -- why this is not ~$110 is recorded there
CONCURRENCY=8          # top of Appendix I item 7's registered 4-8 band
LOG=".tmp/stage1c-run.log"

if [[ "${1:-}" == "--dry-run" ]]; then
  exec node evals/run.mjs --dry-run --arms "$ARMS" --replicates "$REPLICATES"
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
echo "replicates:  $REPLICATES   (3 arms x 48 briefs x 3 = 432 cells)"
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
