# Resuming an in-flight batch (issue #103)

Companion to `docs/retrying-failed-cells.md`. That one is about a **cell** that
can be re-planned; this one is about a **batch** that was already paid for.

## The problem, in money

`#92` gave the batch poll loop a ceiling (60 minutes by default). A batch that
outruns it is abandoned, the cell fails `timeout`, and `#90` re-plans the cell
`todo` with its spend preserved on an attempt record. All correct — and until
`#103`, all of it re-spent on the next invocation, because the next invocation
submitted a **brand new batch** for work the provider had already done.

That is not a rare edge. Measured single-request batch latency on one account
in one afternoon ranged **2m24s to 21m07s** (recorded on `#92` with batch ids).
Over a ~200-cell grid, some cells outrun any finite ceiling.

The provider will hand the work back for free. Anthropic keeps batch results
downloadable for **29 days after creation**; OpenAI deletes the output file
**30 days after the batch completes**. Re-polling costs nothing.

## Why this is request-level replay, not "reload a saved batch id"

A batch is per **round**. `ideate-core` keeps no durable inter-round state, so
resuming a cell whose **round 2** batch was abandoned means re-entering the
engine — which re-issues **round 1** first. Reloading a batch id alone would
recover round 2 and pay a second time for round 1.

So the unit of resume is the **request**. Every reply a cell has ever received
is cached under a content-derived `custom_id`; a re-issued request that matches
one is served from the cache and never reaches the network.

This works because of a property of `ideate-core@0.4.0` worth stating out loud,
since resume degrades to round-1-only if it ever stops holding: **round-2
prompts are a deterministic function of the round-1 pool in agent order, not in
completion order.** `ideateCore` collects round 1 with `Promise.all` over
`agents` (which resolves in input order regardless of which reply landed
first), builds `candidates` by iterating `agents` in order, and derives round
2's `seeds` as `dedupe(candidates.slice())`. Batch results arrive in arbitrary
JSONL order and are keyed by `custom_id`, never by position. So round 1's pool
— and therefore every round-2 prompt, byte for byte — reproduces across a
re-issue.

## Cancel-on-abandon stays ON

`#103` was filed expecting `#92`'s cancel-on-abandon default to have to flip,
on the premise that _cancelling destroys the very handle this issue would
re-poll_. **That premise is false.** Per Anthropic's documented per-request
result types, `canceled` means only "user canceled the batch **before this
request could be sent to the model**", and those requests are explicitly **not
billed** — while everything already sent still `succeeded`, is still billed,
and is still in the results file for the full 29 days.

Cancelling therefore **caps the unattended-billing exposure and preserves
everything already paid for**. The two features are complements, not
alternatives, and the default does not flip.

The consequence is that a recovered batch is usually **partial** — some
`succeeded`, some `canceled`. Per-request replay handles that natively: the
succeeded ones are served free and only the canceled ones are re-issued. A
per-batch "reload the id" design could not have expressed it at all.

## Flags

Both are **off-switches** for default-on behaviour. There is deliberately no
`--resume` or `--cancel-on-abandon`: an on-switch for a default-on behaviour is
a flag that only ever gets typed by someone who has misread the default.

| Flag                     | Effect                                                                                                                                                                                                                                                   |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--no-resume`            | Never re-poll a handle and never replay a cached reply. Writes no replay records either — a run that opts out does not quietly accumulate state it asked not to keep.                                                                                    |
| `--no-cancel-on-abandon` | Leave an abandoned batch running instead of cancelling it. The one case this is for: a batch you believe is nearly done and would rather let finish than cancel and re-poll later. It trades a capped billing exposure for a shorter path to the result. |

Resume is **batch-only**. `--no-batch` runs neither consult nor produce replay
state — see "the wrong-rate hazard" below.

## Where it lives

| Piece                                                      | File                                                                                       |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Content-derived `custom_id`, replay cache, handle recovery | `evals/harness/provider.mjs` (`contentCustomId`, `#recoverOutstanding` on both adapters)   |
| Durable record: key grammar, read/write                    | `lib/store.mjs` (`BATCH_RESUME_FAMILY`, `readBatchResumeRecord`, `writeBatchResumeRecord`) |
| Load/persist around the provider call                      | `evals/harness/runner.mjs` (`loadBatchResumeState`, `persistBatchResumeState`)             |
| Tests                                                      | `evals/harness/batch-resume.test.mjs`                                                      |

The record uses the **existing** attempt-key grammar —
`batch-replay|cell=<cellKey>|attempt=N` — so it inherits `parseAttemptKey` and
`nextAttemptNumber`'s max+1 discipline (never a count). It is deliberately
**not** in `ATTEMPT_FAMILIES`: compaction rewrites a record's body as the sum
of its cost rows and nothing else, which would destroy precisely the batch
handle resume exists to re-poll. `ATTEMPT_KEY_FAMILIES` is the wider "shares
the grammar" set; `ATTEMPT_FAMILIES` remains the compaction set.

All store I/O stays in the runner. The provider is handed a
`{replies, outstanding}` object and hands one back, the same way it is handed a
cell and hands back tokens.

## The money rules

**Meter on recovery, never on replay.** A recovered `succeeded` reply is
metered into `tokens_by_model` at the moment it is downloaded — not when it is
later replayed into a prompt. A reply pulled down but never asked for is still
money the provider charged; metering on serve would silently drop it. A
_replayed_ reply is never metered, because whoever recovered it already did,
and its money already sits on that attempt's record. Metering it again is the
double count `#103`'s AC4 names, and it would be invisible: `spendToDate()`
sums the cell record _and_ the attempt record.

**Replay records carry no money, ever.** `costRows` is always `[]`, enforced in
`writeBatchResumeRecord` rather than assumed. That invariant is what makes a
superseded replay record safe to drop with no salvage step — contrast
`pruneStore`'s `salvageEvictedCellSpend`, which exists precisely because cell
records _do_ carry money.

**The wrong-rate hazard, and why it is unreachable rather than merely
detected.** `billing_mode` on a cost row is `"api" | "subscription"` — the
metering _regime_. Batch-vs-single is a different axis: a pricing _lever_
within the `"api"` regime, applied by `lib/price.mjs`'s
`priceRow(row, table, { batch })` from a flag the **caller** passes, because
the ledger carries no per-row record of which lever a row ran under.
`spendToDate()` therefore passes one flag for the whole store.

Replaying batch-produced replies into a `--no-batch` invocation would price
them at roughly **twice** what they cost — not double-counted, which a
reconciliation would catch, but attributed at the **wrong rate**, which looks
entirely plausible in a total. So each replay record records the
`pricingLever` its replies were produced under, and the loader **declines to
replay across a mismatch**, choosing to re-spend over to mis-price. Resume is
additionally inert in single mode on the provider side.

The principled fix is a **per-row pricing lever on `costRow()`**
(`lib/accounting.mjs`), so `priceRows` can read the lever off each row instead
of being told once for the whole store. `#103` does not make that change — it
is a ledger schema change outside its scope — so until it is made, **a store
mixing batch and non-batch spend is priced at one lever for all of it.** That
is a pre-existing property of `--no-batch`, not something resume introduced,
but it is named here rather than left to be discovered.

## Growth, and what the prune does

A replay record is written only for a cell that will be **re-planned**. A cell
stored `completed` writes none: `planRun` classifies it `reuse` forever after,
so it can never re-enter the loop and has nothing to replay. Per-cell growth is
therefore bounded by that cell's **failure** count, exactly like `#90`'s
`generation-attempt` records, and the highest-numbered record shadows every
older one.

Superseded replay records **are** reachable by `--prune` now, via a third
operation alongside evict and compact — **supersede** (`#117`). Compaction
still excludes the family deliberately (folding a batch handle plus recovered
replies into a summed cost row would destroy exactly the handle resume exists
to re-poll), and eviction still cannot select these keys at all (`parseCellKey`
requires a leading `arm=`). Supersede is neither: for each cell it keeps the
highest-attempt `batch-replay` record — the one `readBatchResumeRecord` would
actually read — and removes every older one outright. No fold, no salvage:
the family always carries `costRows: []`, so there is no money to re-home.

```bash
node evals/run.mjs --prune --keep-batch-replays 2 --apply
```

`--keep-batch-replays` is its **own** knob, not `--keep-attempts`
(`DEFAULT_BATCH_REPLAY_RETENTION`, default **1**). The two families share a
key grammar but not a size profile: an attempt record is cheap to keep several
of because compaction sums it down to one cost row, while a batch-replay
record is never folded and carries full recovered reply text, so every kept
copy costs its full size. And unlike an attempt record — where a few recent
ones have diagnostic value ("read the last few bad nights by hand") — an
older batch-replay record carries no information a newer one doesn't already
shadow, since only the highest-attempt one is ever read. Keeping exactly 1,
the record resume would actually use, is therefore the natural default rather
than a smaller copy of 5.

**Left deliberately out of scope: a `retired`-but-superseded record is not
chased further.** A cell that has completed can never replay again, so its
last `batch-replay` record — `retired: true`, or simply the cell's own stored
state being `completed` — is dead weight even at `keepBatchReplays`. Supersede
does not cross-reference the cell's own record to catch this: doing so would
make this operation's correctness depend on two record families staying in
sync, which is exactly the coupling that produced `#115`'s
`salvageEvictedCellSpend` bug. Retaining one dead record per such cell is a
bounded, honest cost, not a correctness gap.

## Operator recipes

```bash
# Normal. Resume and cancel-on-abandon are both on; nothing to type.
node evals/run.mjs --max-spend 50

# You are watching a batch you think is nearly done; let it finish.
node evals/run.mjs --max-spend 50 --no-cancel-on-abandon

# Force everything fresh (e.g. reproducing a bug against clean state).
node evals/run.mjs --max-spend 50 --no-resume

# What is outstanding right now? Replay records are visible in the index.
node -e '
  const { ResultsStore, BATCH_RESUME_FAMILY, parseAttemptKey } = await import("./lib/store.mjs");
  const store = new ResultsStore("results");
  for (const e of store.list()) {
    const p = parseAttemptKey(e.key);
    if (!p || p.family !== BATCH_RESUME_FAMILY) continue;
    const r = store.get(e.key).result;
    for (const h of r.outstanding) console.log(p.cellKey, h.provider, h.batchId, h.submittedAt);
  }
' --input-type=module
```

A handle printed by the last recipe can also be inspected by hand:

```bash
curl -s https://api.anthropic.com/v1/messages/batches/$ID \
  -H "x-api-key: $ANTHROPIC_API_KEY" -H "anthropic-version: 2023-06-01" | jq .request_counts
```

## Retention, verified

|           | Processing window                           | Results window                        |
| --------- | ------------------------------------------- | ------------------------------------- |
| Anthropic | 24h (`expired` requests are **not billed**) | **29 days** from batch creation       |
| OpenAI    | 24h (`completion_window` can only be `24h`) | **30 days** after the batch completes |

Verified 2026-09-02 against
`platform.claude.com/docs/en/build-with-claude/batch-processing` and
`developers.openai.com/api/docs/guides/batch`. `#103` originally said
"Anthropic expires batches at 24h" and told the implementer to confirm rather
than trust it. The 24h figure is real but describes the **wrong clock** for
resume: a batch that was already submitted is recoverable for 29 days, not 24
hours. Taking the issue's line on trust would have discarded every handle older
than a day while its results sat there for another four weeks.

**One named residual on the OpenAI side.** Anthropic documents explicitly that
cancelling preserves already-succeeded results. OpenAI documents that a
cancelling batch lets "in-flight requests complete (up to 10 minutes)" and then
becomes `cancelled`, but does **not** state whether an output file is produced
for the requests that did complete. The OpenAI recovery path therefore assumes
nothing: a terminal batch with no `output_file_id` recovers nothing and
degrades to a fresh submit, which is correct whichever way OpenAI behaves.
