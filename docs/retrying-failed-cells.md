# Retrying failed cells

> My run died on a rate limit / a 5xx / an empty credit balance. How do I get
> those cells back?

**Re-run the same command.** That is the whole answer for anything this
harness records from now on. The rest of this page explains why, what the
exception is, and how to tell which case you are in.

## The rule

A failed cell is one of three things, and the harness treats them differently:

|                                                                | Kinds                                                                            | Stored under `cell.key`? | Rest of this run                                                 | Next run                                 |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------ | ---------------------------------------------------------------- | ---------------------------------------- |
| **Cell-intrinsic** — an observation about the arm              | `parse_failure`, `empty_pool`, `refusal`                                         | yes                      | continues                                                        | `reuse` (free, never re-called)          |
| **Transient / environmental** — a fact about the night you ran | `rate_limited`, `timeout`, `transport_error`, `budget_exceeded`, `harness_error` | **no**                   | continues                                                        | `todo` (re-attempted, real spend)        |
| **Payment** — the account cannot pay                           | `payment_required`                                                               | **no**                   | **aborts** — every remaining cell is `skipped: payment_required` | `todo`, once you have funded the account |

The sets live in `lib/accounting.mjs` (`INTRINSIC_FAILURE_KINDS` /
`TRANSIENT_FAILURE_KINDS` / `PAYMENT_FAILURE_KINDS`) with the reasoning for
each membership; the branch that consults them is in
`evals/harness/runner.mjs`'s generation-failure handler.

`payment_required` (issue #88) is the odd one out because it answers the two
questions in a combination neither other set expresses: it is **not** a fact
about the arm (so it must never be stored under `cell.key`), and it is **not**
worth re-attempting right now (so, unlike a rate limit, the runner stops). It
is detected on the response body's error signature — Anthropic returns the
credit refusal as an HTTP **400** and OpenAI returns quota exhaustion as a
**429**, so keying on status alone would file the first as a flaky wire and
the second as an ordinary rate limit. Both are transient classes, and both
would march a ~200-cell grid into an account that cannot pay for any of it.

Why it has to work this way: `planRun(spec, storedKeys)` receives **only
keys**. It cannot see `accounting.state`, so it cannot tell a completed cell
from a failed one — and nothing a _run_ does removes a record from the store.
(Issue #98 added exactly one removal path, `ResultsStore.remove()`, reachable
only from the explicitly-invoked `--prune` below; `put()` still never rewrites
a key's content.) Once `cell.key` exists at all, every future _run_ classifies
it `reuse`. Keeping a transient failure out of the store is therefore the only
mechanism that makes it retryable without operator intervention; keeping an
intrinsic failure in it is what stops the study from resampling an arm until it
happens to look good.

## What you will see

A run that lost cells to an environmental fault says so:

```
[run] planned=20 completed=11 failed=9 skipped=0
[run] 9 of those failure(s) were environmental (rate_limited=9) and were NOT
      stored under their cell keys -- re-run the same command to re-attempt them
      (spend already incurred is preserved; see docs/retrying-failed-cells.md).
```

Confirm before spending, with the same flags you would really run:

```
$ node evals/run.mjs --dry-run --arms A,B --briefs biz-01,biz-02 --replicates 5
[dry-run] plan: 9 todo, 11 reuse, 0 stale
```

The 9 are back as `todo`. Drop `--dry-run` and they run.

A run that stopped because the account went dry says something different — and
the difference is the point, because the action is different:

```
[run] planned=200 completed=37 failed=1 skipped=162 (payment_required=162)
[run] ABORTED: the provider refused on billing/credit at cell
      'arm=A|brief=biz-14|rep=2|cfg=...' (providers: anthropic). 162 remaining
      cell(s) were skipped, not attempted -- every one of them would have hit
      the identical wall. Nothing was stored under those cell keys, so fund
      the account and re-run the same command to pick up where this stopped
      (spend already incurred is preserved). Provider detail: ...
```

`skipped`, not `failed`: "we never tried" is the honest record, where 162
identical failures would be noise. Fund the account, then re-run the same
command — the 162 skipped cells and the one that hit the wall all come back as
`todo`, and the 37 that completed stay `reuse`.

## Exception: a store written before this change

Stores created before issue #90's fix wrote **every** classified generation
failure under `cell.key`, including transient ones. Nothing a _run_ does can
re-attempt those — no run path removes a record — so a run that reuses one
warns and names the command that fixes it:

```
[run] WARNING: reused cell 'arm=A|brief=biz-01|rep=0|cfg=5ce5478956e5' is a
      stored 'rate_limited' failure -- an environmental fault recorded before
      issue #90's fix, which this run cannot re-attempt. Clear it (its spend
      is preserved) with: node evals/run.mjs --prune --kinds transient --cfg
      5ce5478956e5 --apply -- see docs/retrying-failed-cells.md.
```

### The prune (issue #98)

`--prune` is the supported repair. It is **dry-run by default**: it prints
exactly what it would remove and changes nothing until you add `--apply`.

```
$ node evals/run.mjs --prune --kinds transient --cfg 5ce5478956e5
[prune] store holds 56 record(s)
[prune] EVICT would remove cell arm=A|brief=biz-01|rep=0|cfg=5ce5478956e5
        state=failed kind=rate_limited  (1 cost row(s) re-homed under
        pruned-cell|cell=arm=A|brief=biz-01|rep=0|cfg=5ce5478956e5|pruned=N
        — the money stays)
[prune] store would hold 56 record(s)
[prune] DRY RUN — nothing was modified. Re-run with --apply to commit.
```

Read it, then re-run with `--apply`. The affected cells come back as `todo`
on the next run.

| Flag                | What it selects                                                                                                                |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `--cfg <hash>`      | cells under one `configHash`                                                                                                   |
| `--arms A,B`        | cells for those arms                                                                                                           |
| `--briefs biz-01`   | cells for those briefs                                                                                                         |
| `--kinds …`         | failed cells whose stored `accounting.kind` matches. Accepts literal kinds, or the set names `transient` / `intrinsic` / `payment`. **Defaults to `transient` + `payment`** |
| `--states …`        | cells in those terminal states. **Defaults to `failed` alone**                                                                 |
| `--allow-completed` | permits evicting a `completed` cell (see below)                                                                                |
| `--keep-attempts N` | attempt-record retention window (default 5)                                                                                    |
| `--apply`           | actually do it                                                                                                                 |

With **no** selector at all, `--prune` evicts nothing — it only compacts
attempt records. There is no all-or-nothing wipe.

### It will not touch an intrinsic failure unless you name one

The default `--kinds` is the two **store-absent** sets, `transient` +
`payment` — exactly the failures #90 and #88 would have kept out of the store
in the first place. So `--prune --cfg <hash> --apply`, the most natural
"repair my legacy store" invocation, clears the environmental faults and
leaves `parse_failure`, `empty_pool` and `refusal` alone.

That default is a guard, not a convenience. An intrinsic failure is a real,
paid-for observation about the arm — `empty_pool` is IC-08's silent mode, one
of the behaviours this study exists to measure. Evicting one makes the next
run re-roll it, and an arm that genuinely returns nothing gets resampled until
it happens not to. The salvage preserves the spend; it cannot preserve the
measurement. Reaching one takes `--kinds intrinsic` (or the literal kind),
which is the explicit act.

### It refuses to delete a completed cell

A `completed` cell is a paid-for measurement. The default `--states failed`
never reaches one, and naming one explicitly is reported and refused:

```
[prune] REFUSED arm=A|brief=biz-04|rep=1|cfg=5ce5478956e5 — completed —
        pass --allow-completed to evict paid-for data
```

`--allow-completed` overrides it. Its spend is preserved like any other
eviction's, but the measurement itself is gone and will cost real money to
reproduce.

### Bumping the config is still available, and still coarser

Any change to a `CONFIG_FIELDS` value (see `lib/manifest.mjs`) yields a new
`configHash`, so affected cells get fresh keys and plan `todo` while the old
records survive under their own hash and surface as `stale`. Correct, and
nothing is destroyed — but it re-plans _every_ cell under the new config, not
just the broken ones. Prefer `--prune` when you mean "these cells".

## The money you already spent is not lost

A failed generation call can still have burned real tokens. Those cost rows
are written under an **attempt-scoped** key — `generation-attempt|cell=<the
cell key>|attempt=<n>` — rather than under the cell key, so:

- `spendToDate()` counts them, and they still push against `--max-spend` and
  `--max-spend-<provider>` ceilings. A failed night is not free and the
  harness does not pretend it was.
- Each further attempt gets its own `attempt=n`, so a retry never collides
  with, overwrites, or double-counts an earlier one.
- The record carries the real failure kind, the provider's detail string, and
  the resolved model IDs — so "why is this cell `todo` again?" has a durable
  answer you can read out of the store.

These records are invisible to `planRun` (its key regex requires a leading
`arm=`), so they never masquerade as cells.

**A prune never destroys spend either.** Evicting a cell first re-homes its
cost rows under `pruned-cell|cell=<the cell key>|pruned=<n>` — the same shape
issue #90 writes for a live transient failure, applied retroactively — and
only then removes the cell. After an `--apply`, the command recomputes
`spendToDate()` and **throws if the figure moved**, so a bug in this path
surfaces on your terminal rather than in a cost total nobody can reconcile
three weeks later.

### Attempt records are bounded, not unbounded

A deterministic transient cause — a real harness bug, a persistently dry
account, a model that always times out — re-spends every invocation and
appends another attempt record each time. `spendToDate()` parses every stored
body, so an unbounded pile slows every ceiling-gated run. A run that is over
the bound says so:

```
[run] NOTE: 3 cell(s) hold more than 5 attempt records each. Their spend is
      counted correctly, but spendToDate() parses every stored body, so the
      pile slows every ceiling-gated run. Fold them (money preserved,
      verified) with: node evals/run.mjs --prune   (add --apply to commit).
```

`--prune` folds a cell's older attempt records into ONE
`generation-attempt-compacted|cell=…|through=<n>` record whose cost rows are
the per-(cell, billing mode, model) **sum** of theirs. The newest
`--keep-attempts` records (default 5) are left alone.

Folding rather than dropping is the point: an attempt record exists _because_
its money must outlive the cell, so a policy that discarded the oldest would
discard real spend and under-report the study. The fold is also **priced both
ways and abandoned if the two disagree** — `lib/price.mjs` resolves an
introductory rate by row timestamp, so a group straddling a dated rate change
is left unfolded rather than repriced. The bound is best-effort; the ledger is
not.

Not yet compacted: `judge-call` records (`evals/judge/gate.mjs`), which have
the same shape and the same growth property. Their attempt numbering is
derived from a raw key count in that module, which compaction would break, so
bringing them in is a follow-up rather than part of #98.

## The store's append-only contract, precisely

`put()` never rewrites a key's content — that is unchanged and absolute, and
it is what makes `planRun`'s `stale` path work. What #98 added is
`ResultsStore.remove()`, the one and only removal path in the codebase. It
takes explicit keys (no predicates, no globs), refuses a `completed` record
without `{ allowCompleted: true }`, refuses a key the index does not hold,
validates the whole batch before writing anything, and rewrites `index.jsonl`
before unlinking bodies so a crash leaves an orphaned body rather than an
index line pointing at nothing.

Nothing on the run path calls it. `runSpec()` warns; `node evals/run.mjs
--prune --apply` is the only thing that deletes.

## What this page is not

It is not a retry _policy_ for within a single invocation. A provider adapter
still does its own bounded retries before classifying a call `rate_limited`
(see `evals/harness/provider.mjs`); by the time a kind reaches the runner,
those are already exhausted. This page is about the boundary between
invocations — which is where the permanence lived.
