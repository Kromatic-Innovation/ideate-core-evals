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
from a failed one — and the store is append-only, with no delete. Once
`cell.key` exists at all, every future invocation classifies it `reuse`,
forever. Keeping a transient failure out of the store is therefore the only
mechanism that makes it retryable; keeping an intrinsic failure in it is what
stops the study from resampling an arm until it happens to look good.

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

## Exception: a store written before this change

Stores created before issue #90's fix wrote **every** classified generation
failure under `cell.key`, including transient ones. Those records are
permanently `reuse` — nothing in the harness can re-attempt them, because
the store has no delete. A run that reuses one warns:

```
[run] WARNING: reused cell 'arm=A|brief=biz-01|rep=0|cfg=5ce5478956e5' is a
      stored 'rate_limited' failure -- an environmental fault recorded before
      issue #90's fix, which this run cannot re-attempt.
```

Two one-time remedies, in order of preference:

1. **Bump the config.** Any change to a `CONFIG_FIELDS` value (see
   `lib/manifest.mjs`) yields a new `configHash`, so the affected cells get
   fresh keys and are planned `todo`. The old records survive under their own
   hash and surface as `stale` — nothing is destroyed, nothing is silently
   pooled. Correct, but it re-plans _every_ cell under the new config, not
   just the broken ones.
2. **Prune the legacy records.** `results/` is gitignored and per-deployment,
   so there is no shared state to migrate — but back it up first, then remove
   the offending `index.jsonl` lines and their `bodies/<hash>.json` files.
   Identify them by reading each body's `accounting.kind` and matching it
   against `TRANSIENT_FAILURE_KINDS`.

A supported prune command belongs on the CLI (`evals/run.mjs`) and does not
exist yet. Until it does, option 2 is a manual operation — which is precisely
why option 1 exists, and why new transient failures are never written under a
cell key in the first place.

## What this page is not

It is not a retry _policy_ for within a single invocation. A provider adapter
still does its own bounded retries before classifying a call `rate_limited`
(see `evals/harness/provider.mjs`); by the time a kind reaches the runner,
those are already exhausted. This page is about the boundary between
invocations — which is where the permanence lived.
