# Contributing

<!-- cockpit:verified version=0.0.0 -->

This guide is for people and AI coding agents changing cockpit itself: setup, the test loop,
what a pull request needs, and what will be refused. To use cockpit on your own product, start
with the [README](README.md). Taking part means following the
[Code of Conduct](CODE_OF_CONDUCT.md).

**AI agents:** read [AGENTS.md](AGENTS.md) first; it maps the codebase and the rules agents most
often break. Everything below applies to agents too.

## Two audiences, two trees

This repository holds agent configuration for two different readers. Mixing them is a defect.

| | Using cockpit | Working on cockpit |
|---|---|---|
| You work on | your own product repositories | this codebase: schema, environment commands, codegen, tests |
| Agent configuration | rendered into your checkout by `cockpit sync` | hand-written, in this repository's root dot-directories |
| Lives in | `packages/cockpit/surfaces/` (shipped templates) | `.agents/skills/` and the root agent files |
| Start reading | [README](README.md) | this file, then [Architecture](docs/architecture.md) |

A skill about maintaining the config parser never goes into the shipped surfaces, and a shipped
template never describes this repository.

The package ships only the allow-list in the `files` field of `packages/cockpit/package.json`,
which `packages/cockpit/src/packaging.slow.test.ts` checks against real `npm pack` output. Adding a
file to that list is the review.

## Setup

You need the Node.js and platform prerequisites in
[Getting started](docs/getting-started.md#install-cockpit), Bash, zsh, and a Git release that
supports the [`git cat-file -Z` invocation the hygiene scanner uses](scripts/hygiene-scan.mjs).

```sh
npm ci --ignore-scripts
npm run build
git config --local core.hooksPath .githooks
test "$(git config --local --get core.hooksPath)" = .githooks
```

The last two lines turn on the repository's hooks (a pre-commit anonymisation scan and a
commit-message check); Git does not activate a tracked hooks directory by itself.

Use the repository scripts, not a bare `tsc`. Build and typecheck run the native TypeScript
compiler; the documentation and architecture checks need the compiler API, which only the
separate compatibility package in [package.json](package.json) exposes, and that package installs
a second compiler executable. Compiler work runs single-threaded to leave the machine capacity for
other processes.

## Development loop

Run the smallest test that covers the behaviour you are changing:

```sh
npm test -- packages/cockpit/src/tree-hygiene.test.ts
```

- `npm test` is the only supported test entry point. It caps Vitest at four workers (pass
  `--maxWorkers=1`, `2` or `3` on a busy machine), accepts file paths and `-t '<test name>'` after
  `--`, prints failures as they happen, and writes the latest result to
  **.vitest-reports/latest.json**.
- `npm run test:changed -- <base-commit>` runs the fast-tier tests adjacent to what changed since
  that commit, listing the selected files first, and prints the slow-tier owners it left out with
  the command that runs them; `--wide` runs them too. If the run ends early (deadline,
  failure, interrupt), it names the files still running at the deadline, writes the unfinished
  files to **.vitest-reports/remaining-<id>.txt** and prints the `npm test -- $(cat ...)` command
  that reruns exactly those.
- Test files named `*.slow.test.ts` are the slow tier: packaging and the installed tarball,
  end-to-end CLI and composition runs, and the host Docker. `npm test` runs both tiers.
  [Test tiers](docs/contributing/testing.md#test-tiers) says what belongs where.
- Test discovery stays inside this checkout's `packages/` tree, so nested worktrees run their own
  tests.

## Verification

Before marking a pull request ready, run the full local gates and paste their real output into
the pull request:

```sh
npm test
npm run typecheck
npm run lint:docs
npm run lint:supply-chain
```

A targeted pass proves only its target.

**Changed-test selection.** `npm run test:changed -- <base-commit>` follows imports through shared
test helpers and stops at the first importer that has its own fast-tier adjacent tests. It runs the
fast tier only, so run `npm test` before pushing. `--wide` runs what CI's changed-test cell runs:
the slow tier too, and every test that reaches the change through its importers. A change to the
Vitest configuration or the shared Git-isolation setup selects every package test. Unmapped paths
refuse before dispatch: check them yourself rather than treating an empty selection as a pass.
`node scripts/run-changed-tests.mjs <base-commit> --list` prints the tests it would run as a JSON
array without running anything (it also accepts `--wide` and `--extra-test <test-path>`); the list
is not evidence that the tests passed.

**Splitting a run.** When a suite needs several invocations, partition whole test files and run
each batch with `npm test -- <paths>`. Keep the commit, working tree, dependencies and test
configuration unchanged throughout, save each report before the next run replaces it, and check
that the reports together cover every required test file with every assertion accounted for: every
selected file for a changed-test run, every configured file for the full suite.

**Generated references.** The CLI reference, configuration reference, command list, capability
matrix and troubleshooting index are checked against committed `HEAD`, so `npm run lint:docs`
refuses while an implementation change is uncommitted. Commit the change, run
`npm run references` (it builds first), commit the regenerated pages, then lint again. Uncommitted page edits also
refuse: commit intentional edits or restore them before regenerating. After a rebase, generation
refreshes its ignored local ownership record when every page matches the current commit. Never
edit a generated reference by hand. How publication verifies these pages is in
[CLI completion and generated references](docs/contributing/cli-completion-and-references.md); the
[contributor documentation index](docs/contributing/README.md) lists the other maintainer pages.

CI runs the build, tests, typecheck and documentation lint, plus the anonymisation scan as its own
job; `.github/workflows/` defines its matrix.

## The rule that is not negotiable

**Nothing consumer-identifying enters the tracked tree.** No client or employer names, private
hostnames, real registries, credentials or internal URLs, in code, comments, fixtures, tests,
commit messages or documentation. Fixtures are synthetic and keep the shape of the real thing.

If the scan fires, anonymise. Never widen a pattern or add an allowance to make it pass.

The scan has two classes:

- Credential shapes and private absolute paths are universal; CI enforces them on every push.
- Consumer names are site-specific and live only in the maintainer's private needle file, so
  **CI cannot catch a site-name leak**. A green CI scan means "no credentials and no home
  directories", not "no names".

The scan prints which classes it covered; read that line.

## Commits

- **Subject: a declarative sentence saying what is now true.** No conventional-commit prefix,
  ticket ID or emoji.
- **Body: the failure that motivated the change**, what it looked like, and why the fix has this
  shape. The diff already says what moved.
- Stage explicit paths and review the diff before committing.
- Never bypass the hooks. If one fails, fix the cause.
- Commit messages are covered by the anonymisation rule, and cannot be corrected without a
  history rewrite.

## Pull requests

One concern per pull request. Every line of the template's checklist is something that has gone
wrong before.

- **Every bug fix lands with a test that fails without it.** Say how you saw it fail.
- **Paste real output, not a summary**, and separate what you ran from what you believe.
- Documentation for a behaviour change goes in the same pull request.
- Add a changeset (`npx changeset`) when the change is visible to someone using cockpit; otherwise
  ask a maintainer to add the `no-changeset` label. See [.changeset/README.md](.changeset/README.md).
- Open an **issue first** for anything that changes the <!-- cockpit:ref consumer=cockpit.toml --> `cockpit.toml` schema, the generated
  file layout, the overlay contract, or a CLI command or flag. Agree the shape before the diff.

## Reporting issues

Give the exact command, the actual output, what you expected, your versions (Node, cockpit,
harness, operating system) and the smallest reproduction you can. If the real reproduction
carries names you cannot publish, rebuild it with invented ones; a synthetic reproduction can
become a test. One defect per issue.

**Never report a vulnerability in a public issue.** Follow [SECURITY.md](SECURITY.md).

## What will not be accepted

- **Consumer-identifying material**, in any file, including a fixture "just for a test run".
- **A control that binds nothing**: configuration that parses and does nothing, a CI step that
  runs nothing, or a document claiming enforcement that nothing enforces.
- **A weakened test**: skipped, deleted, or an assertion edited to match current behaviour, or a
  fix that works by disabling a check, suppressing a warning or loosening a type.
- **A bug fix with no test that fails without it.**
- **Speculative abstraction**: a configuration knob with no second caller, an interface with one
  implementation, handling for states that cannot occur.
- **A capability claim that was read rather than tested.** Harness cells are established by
  probing the tool beside a deliberately broken control file, and dated.
- **A dependency added without a case for it.** Exact pin, lockfile committed, and an argument
  for why the code cannot be written instead.
- **Reformatting mixed into a behaviour change.**
- **A hand-edited generated file.** Change the generator.

## Releasing

The maintainer cuts releases. The checklist is in [Releasing](docs/contributing/releasing.md); the
user-facing policy is in [Release policy](docs/release-policy.md).

## Governance

One maintainer, [@b0dea](https://github.com/b0dea), reviews and merges everything and owns every
path in [CODEOWNERS](.github/CODEOWNERS). There is no second reviewer and no on-call, so review can
stall, and no response window is promised except for security reports. A stall is not a dead end:
the license is MIT, so a fork is always available, and the extension seams (overlays, guard
tables, custom harnesses) let you route around a decision without forking. A second maintainer
will be named here when there is one.
