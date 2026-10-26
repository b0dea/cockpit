# Contributing

<!-- cockpit:verified version=0.0.0 -->

cockpit owns the environment for agent-driven work across several product repositories, and
none of the product code. This file is for people changing cockpit itself. To *use* cockpit,
read the [README](README.md). Taking part here means keeping to the
[code of conduct](CODE_OF_CONDUCT.md) and the contributor contracts below.

## Which audience are you?

This repository serves two populations, and confusing them is the single most likely way to be
misled by what you find here.

| | **Using** cockpit | **Contributing** to cockpit |
|---|---|---|
| How you get it | use a source checkout until the first package release | clone this repository |
| What you work on | your own product repositories | this codebase — schema, registry import, environment commands, tests |
| The generated configuration | registry-derived surfaces rendered by `cockpit sync` | none |
| Where to start reading | [README](README.md) | this file, then [Architecture](docs/architecture.md) |

**`packages/cockpit/surfaces/` is the only agent-template tree shipped to users**, alongside
the compiled CLI, launcher, schema, and package metadata. These templates are package inputs;
`cockpit sync` renders them into the user's checkout from the resolved configuration. Tests and
fixtures validate those templates without becoming part of the consumer output. A source checkout builds and tests using the declared dependencies.

What ships is an allow-list — the `files` field of `packages/cockpit/package.json` — asserted
against the real `npm pack` output by `packages/cockpit/src/packaging.test.ts`. Putting a file
in the package directory does not publish it. Adding it to the allow-list does, and that is the
review.

## Setup

Node 22.13 or newer on a supported Node release line, matching the root `engines` field. A clean clone must build and test from the
lockfile without relying on another checkout's generated state.

Contributor checks require Git 2.42 or newer: the hygiene scanner uses
[`git cat-file -Z`](https://git-scm.com/docs/git-cat-file/2.42.0) to read paths and object
contents without newline ambiguity. Bash and zsh must also be available; CI installs zsh on Linux.

```sh
npm ci --ignore-scripts
npm run build
git config --local core.hooksPath .githooks
test "$(git config --local --get core.hooksPath)" = .githooks
```

Git does not activate a tracked hooks directory by itself. The local configuration above makes
the repository's pre-commit anonymisation scan and commit-message guard effective in this clone.

## Verification

While iterating, run the smallest causal test for the behavior being changed, with at most four
workers:

```sh
npm test -- packages/cockpit/src/tree-hygiene.test.ts
```

`npm test` is the supported Vitest entry point. It defaults to four workers; `--maxWorkers=1`, `2`, or `3` can reduce contention on a shared machine. It rejects options
that could weaken or fragment discovery, and gives execution 13 minutes 45 seconds before bounded
descendant termination and cleanup. A completed Vitest report is retained at
`.vitest-reports/latest.json`. Failed cases print their errors immediately, so a later timeout
does not hide the original failure. Pass file paths and, when needed, `-t '<test name>'` after `--` for
focused verification. Result-order caching is disabled to keep scheduling independent of earlier
runs; transformed-module caching remains enabled.

Each run owns a private temporary directory and gives test subprocesses a consistent filesystem
creation mask (`0022`), independent of the caller's mask. The runner removes the directory after confirming that its
test processes have stopped. If shutdown or directory ownership cannot be confirmed, it fails
and reports the remaining path for inspection instead of deleting uncertain artifacts.

Before marking a pull request ready, run the complete local gates:

```sh
npm test
npm run typecheck
npm run lint:docs
npm run lint:supply-chain
```

Paste the actual command output in the pull request. A targeted pass proves only that target; it is
not a green full suite.

Canonical reference generation authenticates the implementation against committed `HEAD`.
An uncommitted implementation change therefore makes the repository documentation gate refuse;
it is not a reason to edit generated references by hand. After the reviewed implementation is
committed, rebuild, publish references through `publishRepositoryReferences` in
`scripts/diagnostic-inventory.mjs`, and run the documentation gate again. Formatting checks for
individual authored documents can run before that commit.

Test discovery is confined to this checkout's `packages/` tree. Nested agent worktrees run
their own tests from their own roots.

CI uses `npm ci --ignore-scripts`, then build, tests, typecheck, and documentation lint on macOS and Linux
across the supported Node versions. It also runs the anonymisation scan separately and tests
the launcher refusal below the supported runtime floor.

## The rule that is not negotiable

**Nothing consumer-identifying enters the tracked tree** — no client or employer names, no
private hostnames, no real registries, no credentials, no internal URLs, in code, comments,
fixtures, tests, commit messages or documentation. Fixtures are synthetic and exercise the
same shapes as the real thing.

If the scan fires, the fix is to anonymise. It is never to widen a pattern or to add an
allowance so the run goes green; an allowance is a written-down decision with a reason beside
it, and a stale one is as much a defect as a missing one.

**Run the suite locally before committing, and read what the scan reports about its own
coverage.** It scans two classes and they are enforced in different places. Credential shapes
and private absolute paths are universal, need no local knowledge, and are enforced by CI on
every push. The consumer names are site-specific and deliberately absent from this tree, so the
CI checkout does not have them and **CI cannot catch a site-name leak** — that class is caught
only where the commit originates. A green tick on the CI scan means "no credentials and no home
directories". It does not mean "no names".

## Commits

- **Subject: a declarative sentence saying what is now true.** Not an imperative, not a
  conventional-commit prefix, not a ticket id, not an emoji.
- **Body: the failure that motivated the change.** What broke, what it looked like, and why
  the fix has this shape. A commit that only restates the diff is a wasted explanation — the
  diff is already in the commit.
- Stage explicit paths. Review the diff before committing.
- Never bypass the hooks. If one fails, fix the cause.
- Commit messages are part of the tracked tree, so the anonymisation rule covers them too, and
  a message cannot be corrected after the fact without a rewrite.

## Pull requests

One concern per pull request. Fill in the checklist in the template — it is short because
every line on it is something that has gone wrong.

- **Every bug fix lands with a test that fails without it.** Say in the description how you saw
  it fail.
- **Paste real output, not a summary of it**, and separate what you verified from what you
  believe. If you could not verify something in your environment, say which part.
- Documentation for a behaviour change goes in the same pull request. Documentation deferred to
  a follow-up is documentation written from memory, if at all.
- Add a `CHANGELOG.md` entry under *Unreleased* when the change is visible to someone using
  cockpit.
- Open an **issue first** for anything touching the <!-- cockpit:ref consumer=cockpit.toml --> `cockpit.toml` schema, the generated file
  layout, the overlay contract, or a CLI command or flag. Those are the public surface, and
  agreeing the shape before the diff is cheaper for both of us. Everything else: open the pull
  request directly.

## What a good issue looks like

The exact command, the actual output, and what you expected instead. Plus the versions — Node,
cockpit, harness, operating system — and the smallest reproduction you can get to. If the real
reproduction carries names you cannot publish, reproduce it synthetically; that is the same
constraint the fixtures in this repository are built under, and a synthetic reproduction is
worth more than a redacted one.

One defect per issue. A report that bundles three is triaged as none.

**Never report a vulnerability here.** Check [SECURITY.md](SECURITY.md) for current private-channel
availability. Until it names a verified route, a public issue may request one but must contain no
vulnerability details.

## What will not be accepted

- **Consumer-identifying material**, in any file, including a fixture "just for a test run".
- **A control that binds nothing**: configuration that parses and does nothing, a CI step that
  runs nothing, or a document claiming something is enforced when nothing enforces it. This is
  worse than the control's absence, because the next reader budgets for a protection that is
  not there.
- **A weakened test** — skipped, deleted, or an assertion edited to match the current
  behaviour — and any fix that works by disabling a check, suppressing a warning or loosening a
  type until the failure goes away.
- **A bug fix with no test that fails without it.**
- **Speculative abstraction**: a configuration knob with no second caller, an interface with
  one implementation, error handling for states that cannot occur.
- **A capability claim that was read rather than measured.** The harness matrix records
  *enforced*, *instructed* or *unavailable*, established by driving the tool with a
  deliberately broken control file alongside, and dated. Documentation is not evidence: several
  cells that looked supported accept the configuration and bind nothing.
- **A dependency added without a case for it.** Exact pin, lockfile committed, and an argument
  for why the code cannot be written instead. A new install script, bundled binary or runtime
  dependency needs that argument to be a good one.
- **Reformatting mixed into a behaviour change.** Send it separately or not at all.
- **A hand-edited generated file.** Change the generator.

## Governance

One maintainer: [@b0dea](https://github.com/b0dea), who reviews and merges everything and owns
every path in [CODEOWNERS](.github/CODEOWNERS).

The honest version of what that means when the maintainer is unavailable: there is no second
reviewer and no on-call, so review can stall, and no response window is promised for anything
except a security report. Two things exist so a stall is not a dead end — the licence is MIT,
so a fork is always available, and the extension seams are real, so a consumer can route around
a decision through the overlay and the guard tables rather than forking to change one. When
there is a second maintainer, they are named here and CODEOWNERS splits to match.
