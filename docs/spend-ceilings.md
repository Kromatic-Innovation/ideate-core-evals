# Spend ceilings — what `--max-spend` actually guarantees

`--max-spend` failed to bind twice on Study 1 Stage 1c (issue #169). Neither
failure was a bug in the ceiling's *semantics*; both were gaps between what the
flag guaranteed and what an operator read it as guaranteeing. This page is the
guarantee, written down.

`node evals/run.mjs --help` carries a short version of everything here.

---

## The ceiling is cumulative, not per-invocation

`--max-spend 220` does **not** mean "spend at most $220 on this run". It means:

> Stop when **this store's** total recorded spend reaches $220 — summed across
> every prior invocation and every `configHash` in it.

A store already holding $117.49 of spend has $103 of headroom under a $220
ceiling, and the run stops there. Every ceiling-gated invocation prints both
numbers:

```
[max-spend] ceiling=$220 spent-to-date=$117.4871 projected=$41.5872 (within budget)
[max-spend] the ceiling is CUMULATIVE: spent-to-date is every prior invocation
            and every configHash in this store, not just this invocation.
            Headroom left: $102.5129.
```

This is deliberate and load-bearing. A study is collected over many resumed
sessions; a per-invocation ceiling would let an unbounded number of invocations
each spend up to the cap, which is not a budget. It is also what makes the
ceiling survive a `configHash` move: a prompt-constant edit re-keys every cell
without refunding what they cost.

**To budget one invocation in isolation**, give it its own store with
`--results-dir`, or add the intended new spend to the `spent-to-date` figure the
last run printed.

The operator who filed #169 read `--max-spend 180` as per-invocation on the
first Stage 1c run. The semantics did not change; they were simply not written
anywhere.

---

## Where the ceiling is enforced

Twice, and only one of them is the guard.

**Pre-flight — an early warning.** The whole planned grid is priced before
anything is dispatched, and the run says whether it expects to hit the wall.
This is where the second failure lived: the projection had no model of `effort`,
so the 144-cell re-collect projected **$41.59** against an actual **$105.22**,
and the guard compared against that number. A 2.5x under-projection,
concentrated in `S1C-RICH` — the one arm carrying `effort: max` slots, and so
exactly the arm the ceiling most needed to price.

**Mid-flight — the guard.** Between cell dispatches, and before every judge leg,
against spend that has **actually been recorded**, not against an estimate:

```
spent-to-date (from the store)
  + this invocation's actual spend so far
  + everything reserved in flight
  + this cell's or leg's projection
  > ceiling  ->  skip
```

A cell or leg that would cross the ceiling is recorded as `budget_exceeded`,
written **nowhere**, and re-plans as `todo` on the next invocation. It is never
dropped from the plan and never persisted as an outcome, so raising the ceiling
later is enough to collect it.

Judge legs were unguarded entirely until #169: a leg was dispatched
unconditionally and only recorded afterwards, so a run could stop admitting
generation cells at the ceiling and keep spending on judging past it.

---

## A cell already in flight is allowed to complete

When the ceiling trips mid-cell, the in-flight cell **finishes**. It is not
aborted.

Aborting would discard provider work already paid for — the money is spent the
moment the request is accepted, and throwing the reply away buys nothing — and
it risks a half-written record in an append-only store whose `put()` contract is
byte-identical-or-throw.

So the true bound is:

> **ceiling + the actual cost of whatever was in flight when it tripped.**

At the default `--cell-concurrency 1` that is at most one cell. At
`--cell-concurrency 8` it is at most eight. Size the ceiling with that headroom
in mind, or lower the concurrency when the margin matters more than throughput.

---

## The projection is sometimes a floor, and says so

The pre-flight number comes from one of two tiers:

**Tier 1 — fitted to this store.** For any arm with enough completed cells
anywhere in the store (any `configHash`), the projection uses their measured
mean input/output tokens. Exact for a re-collect. This is the tier that would
have caught the #169 miss: every one of those arms had run before, and their
real token counts were sitting in the store while the pricer consulted a
constant.

**Tier 2 — a structural estimate.** For an arm the store has never run: a
mode-based token estimate with a per-slot `effort` multiplier, derived from the
one-factor screening arms (`S1-ELOW` 0.55x, `S1-C0` 1.00x, `S1-EMAX` 6.16x —
same model, same N, 24 cells each). Better than the effort-blind constant it
replaces, but still an estimate.

The multiplier scales **output tokens only** — effort buys reasoning, not a
longer prompt, and the measurement bears that out (input held flat at ~362
tokens across all three levels). So a *cell's* total cost ratio is always
**below** the multiplier, by whatever share of that cell is input: a solo cell
at 2,500 in / 1,500 out prices `max` at ~4.9x `high`, not 6.16x. If the
`[calibration]` line says `max=6.16x` and a per-cell comparison says 4.87x,
both are right.

A projection containing any tier-2 cell is reported as a **FLOOR, not an
estimate**, with an upper bound and the arms it could not calibrate:

```
[max-spend] ceiling=$220 spent-to-date=$117.4871 projected=$41.5872
            (a FLOOR, not an estimate -- upper bound $103.9680; the store holds
            too few completed cells to calibrate S1C-RICH) (within budget)
```

Mid-flight admission compares against that **upper bound**, never the point
estimate: admitting against a number the pricer itself calls a floor is how a
$220 ceiling settled at $222.7198. The error direction is deliberate —
over-projecting stops the run early, and a `budget_exceeded` skip is
recoverable. Under-projecting spends money that is not.

The basis is printed so the number is auditable rather than authoritative-
looking:

```
[calibration] per-arm token fit from the store (3 arm(s)):
[calibration]   S1C-RICH: 20460 in / 57220 out tokens per cell, mean of 148 completed cell(s)
[calibration] effort output multipliers (store): high=1.00x, low=0.55x, max=6.16x
```

**What is not modeled.** N (`ideasPerAgent` / total ideas requested) is unmodeled
at tier 2. The store shows it matters — 979 / 2,392 / 4,177 mean output tokens at
N=10 / 30 / 60, same model and effort — but three points from one arm family is a
curve, not a model. Tier 1 subsumes N for any arm the store has seen; for one it
has not, the FLOOR label is the honest treatment.

---

## The account balance is the real limit

The first Stage 1c run aborted at **$39.4965** against a `--max-spend` of
**$180**, on an Anthropic billing refusal. The ceiling was never approached. A
ceiling above the money available is decorative.

`--account-balance USD` (or `IDEATE_ACCOUNT_BALANCE_USD`) turns that from a
mid-run surprise into a plan-time warning:

```
[balance] WARNING: this ceiling's remaining headroom ($102.5129) exceeds the
          asserted account balance ($40.0000). The ceiling is decorative above
          $40.0000: the real limit is the balance, and the run will stop on a
          provider billing refusal rather than on --max-spend.
```

The comparison is against **headroom** (`ceiling - spent-to-date`), not the raw
ceiling — most of a cumulative ceiling may already be paid for, and comparing
the ceiling itself would cry wolf on every resumed run.

**It is asserted, not queried.** Anthropic's public API exposes no
remaining-balance endpoint an API key can read; the Admin API's cost reports are
historical spend and need an admin key the harness does not hold. OpenAI's
dashboard billing figures come from session-authenticated endpoints, not from an
API key. There is nothing honest to call, so the harness does not pretend to:
omit the flag and the run says so out loud.

```
[balance] account balance NOT CHECKED -- neither Anthropic nor OpenAI exposes a
          balance an API key can read, so the harness cannot query one and does
          not pretend to.
```

The billing-refusal handling that catches the failure at run time is unchanged
and remains good: an HTTP 400 refusal is recognised as a refusal, not retried,
and nothing is stored under the skipped cell keys — so no spend is wasted
hammering the wall, and skipped cells re-plan cleanly as `todo`.

---

## Per-provider ceilings

`--max-spend-anthropic` / `--max-spend-openai` carry the **same** cumulative
semantics, the same mid-flight enforcement, and the same complete-the-in-flight-
cell rule. A cell is skipped once **any** provider it actually spends under would
cross that provider's own ceiling; the skip reason names the provider
(`budget_exceeded:anthropic`). A cell that does not touch a provider is never
gated by that provider's ceiling.
