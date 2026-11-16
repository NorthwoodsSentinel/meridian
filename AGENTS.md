# meridian

Meridian is a domain-agnostic adversarial-verification engine: a TypeScript library that takes claims plus an evidence bundle, challenges every claim, signs an objection for anything that fails, and returns a confidence-scored, ed25519-signed result with an auditable execution log. It runs on Bun, has no build step and no service; `src/index.ts` is the public API. `README.md` describes the loop, `DESIGN.md` the design and `DECISIONS.md` the build choices. The owner picks what gets worked on; agents carry it through to a reviewed pull request.

**This file holds the _rules_: the conventions a reviewer cites against a diff.** It is loaded in full on every turn, so it stays complete enough to work from on its own. The rules are adapted from Cliff Hall's `modelcontextprotocol/inspector` `AGENTS.md`, as the owner ruled on it on 2026-11-14. Where his way and ours differ, **the source's way stands until there is a reason to depart**; every departure below says why. `CLAUDE.md` contains only `@./AGENTS.md`: keep one copy of these rules.

## Contributing

**The owner picks the work; an agent carries it through to a reviewed pull request.** This repo is public, so **anything merged here is public, and merging is the owner's act.** An agent opens the PR and stops there.

**Every PR must reference an issue. No exceptions.** The PR body's first line is `Closes NOR-<NUMBER>` (or `Refs NOR-<NUMBER>` when the PR is one part of a larger ticket). If there is no issue yet, create it first.

- **Repo**: `NorthwoodsSentinel/meridian` (public)
- **Issue tracker**: Linear, team key `NOR`
- **Develop branch**: `master`. Cut feature branches from it; every PR targets it.

## Issue-driven work style

- **Before starting work, check Linear for the relevant ticket.** Every item of work is a real Linear issue; **never create a duplicate.**
  - **A privately reported vulnerability is the one exception**: it is tracked privately until the reviewed fix is ready. Accepting and publishing an advisory stay human-gated; never automate either.
- **Label by type, exactly one of `bug` / `enhancement` / `documentation` / `chore` / `question`.** Work run through this process also carries the factory label (not yet named by the owner; until it is, say "factory method" in the PR description).
- **`Backlog` means filed, not approved; `Todo` means approved by the owner.** An agent starts work only on a ticket in `Todo`.
- **`Done` means the work shipped** (its PR merged, or it is a parent whose last sub-issue closed). Anything else is `Canceled` or `Duplicate`, never `Done`.
- **When work begins**, assign the issue, set it **In Progress**, and create the feature branch in a new git worktree, never by switching branches in a shared checkout.
- **When work is complete**, run `bun run format` then `bun run local:gate`, **sign off every commit** (`git commit -s`), open a PR against `master`, and set the ticket **In Review**.
- **After opening a PR, run a Codex review loop** (`codex exec --sandbox read-only`). Fix what it finds in the PR's own scope and run it again. Stop on the **first** clean round, with no confirming round. **Two failed rounds in a row: stop, leave the PR open, and list the open findings in it.** Decline scope expansion: pre-existing behavior and hardening the issue did not ask for become new issues, not more commits. (Departure: Cliff uses Copilot; the owner chose Codex as the off-lineage reviewer.)
- **If new tasks are discovered during development, create issues.** They arrive in `Backlog`.
- **Pace bulk GitHub writes: 1 s between requests, never in parallel.**

### Responding to code reviews

- Judge each suggestion against the issue the PR closes. Fix defects in what the PR added; decline, with a reason, suggestions that expand it.
- Reply in the review comment's own thread; a rollup comment does not discharge it. Post the PR-level summary in addition.

## Development setup

- `bun install`. Bun runs this repo's own scripts (`bun run <script>`) and the demos; if you run one of Cliff Hall's own tools or procedures, use his runner (`npx`) as he documents it.
- Tests run on Vitest with `@vitest/coverage-v8`, Cliff's choice, because Bun's own test runner cannot measure branches or enforce a per-file bar. Tests import from `vitest`, never `bun:test`.
- No network, account or secret is needed for any gate step.

## Always test new or modified code

- **Ensure all code has corresponding tests.** The bar is the source's: **≥ 90 on all four dimensions (lines, statements, functions, branches), per file**, enforced by `vitest.config.ts` and therefore by `bun run test`, `bun run local:gate` and CI. A PR that drops any file below the bar fails. **Never lower the threshold to pass.**
- Measured on 2026-11-16: every file under `src/` at or above the bar; totals 100 / 99.65 / 100 / 100 (statements / branches / functions / lines).
- **An exclusion is an exact path, one per entry, never a glob, with a comment naming its follow-up ticket.** There are none today.
- **A genuinely unreachable branch is annotated at the source** with its reason, never waved through by lowering the gate.
- **A gate must show how much it checked.** `scripts/verify-gate-scope.ts`, the last step of `bun run test`, fails if a tracked `.ts` file is outside the tsconfig project, a `src/` file is missing from the coverage summary, or a coverage exclusion is a glob or names no file. It prints the counts it checked. Fix a failure by fixing the globs, never by excusing the file.
- **Keep the exact test filename pattern** (`tests/**/*.test.ts`). A test file the pattern misses is silently skipped while the run still exits 0.
- **A rule about what the code does is asserted at runtime in a test, not read out of the source.** Tests use synthetic data only and write to fresh temp directories, never to `.meridian-keys/` or `.receipts/`.
- **A test that races is fixed with an awaited condition or a mocked clock, never with headroom.**

## Mandatory pre-push gate

`local:gate` runs `format:check`, `lint`, `typecheck` and `test` (Vitest with the per-file bar, then the gate-scope check), in that order. CI (`.github/workflows/ci.yml`) runs the same four steps on every pull request.

- **ALWAYS run `bun run format` before committing.** The gate runs the non-fixing `format:check`.
- **`bun run local:gate` is the mandatory pre-push command.** It runs every check CI runs. `bun run test` alone is not a substitute.
- **The CI workflow never deploys or publishes and holds no secrets.** Its token is read-only, its actions are pinned to a commit SHA, and `timeout-minutes` is declared.
- Departures, each for a stated reason: no gate lease (the gate takes seconds and binds no ports); no DCO check job (a required-check ruleset is a repository setting, the owner's to change); no smoke stage (there is no built artifact; the demos are the consumer and are run by hand).

## Waiting on long-running work

**When you are waiting for something to finish, arm a notifier and stop. Never spend turns polling.** State the harness cannot observe (a CI run, a remote review) is polled inside **one** backgrounded loop with an interval of 30 s or more. **If a notifier is already armed, that settles it: wait.**

## Build output is never a gate target

**No gate (lint, format, typecheck, coverage) may read generated output.** Out of scope: `node_modules/`, `coverage/`, `bun.lock`, and the runtime output directories `.meridian-keys/`, `.receipts/` and `demo-output/`. Each scope says so in its own ignore list (`eslint.config.js`, `.prettierignore`, the tsconfig `include` list). Markdown is outside the format scope: prettier rewrites prose.

- **When a run starts writing to a new location, add it to every scope's ignore list in the same change.** Never widen an ignore to silence a finding in first-party code.

## Lint has no warning tier

**`lint` runs with `--max-warnings 0`, so a warning fails the gate exactly as an error does.** Rules: ESLint recommended, typescript-eslint recommended, and `@typescript-eslint/no-floating-promises` at `error`.

- **Do not silence a finding to satisfy the gate.** Fix it. If a rule genuinely must be waived on one line, use its inline disable comment **with a one-line justification**. Widening an ignore list or dropping a rule is not a fix.

## TypeScript instructions

- Use TypeScript for all code. NEVER use `any` as a type. Untrusted input (a parsed file, a loader result, a Cistern response) is treated as untrusted: an adapter records a bad source as a failure in the bundle and never throws out of `collect()`.
- NEVER suppress error types in the TypeScript or ESLint configuration to satisfy the linter or compiler. The tsconfig is strict, with `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess`; keep it so.
- AVOID double casts (`as unknown as T`). Where one is unavoidable (in this repo, only in tests, to feed an untrusted-input shape to a typed function), it carries an inline comment saying why.
- **NEVER leave a promise floating.** Every promise is awaited, returned, terminated with `.catch(…)`, or discarded with `void` plus a one-line reason.
- **Every new file carries a header comment explaining its purpose and the reasoning behind it.** This applies to new files and files a change touches; there is no bulk migration.

## Signing and receipts (OURS)

**OURS: none of this section comes from the Inspector.**

- **The signed bytes are a contract.** `buildResultDigest` and `buildObjectionMessage` in `src/engine.ts` define what a receipt signs. Any change to either shape bumps `RECEIPT_VERSION`, so an old receipt fails loudly instead of mis-validating. `tests/verifier-invariant.test.ts` encodes the invariant and must keep passing.
- **Keys stay out of git.** `.meridian-keys/signer.key` is a private ed25519 key; it is gitignored and never committed, printed or pasted.
- **A library ships as a tagged release plus a consumer, not a deploy.** Tagging a release is the owner's act.

## Only the owner does

- Picking new work.
- Merging into this public repo, or anything else public or sent to other people.
- Tagging or publishing a release.
- Spending.
- Secrets, repository settings, and branch protection.
