# Security Policy

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

Report them privately via GitHub's
[private vulnerability reporting](https://github.com/Kromatic-Innovation/ideate-core-evals/security/advisories/new),
or email **security@kromatic.com**.

## Scope

This repository is a research harness, not a deployed service. It performs no
network I/O of its own beyond the model-provider calls the runner makes on the
operator's behalf. The relevant considerations are:

- **Provider credentials.** The runner reads API keys from the environment.
  Keys are never committed, never logged, and never written to the results
  store. `.env*` is gitignored and every PR is secret-scanned.
- **The results store is untracked.** `results/` is gitignored. Raw provider
  replies can be large and may echo brief text supplied by an operator; they
  stay local.
- **The cost ledger holds no credentials.** Rows record tokens, model IDs,
  timestamps, and a billing regime — see `lib/accounting.mjs`.
- **Model output is treated as untrusted.** It is parsed, never evaluated.
