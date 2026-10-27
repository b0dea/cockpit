# Contributing

<!-- cockpit:verified version=0.0.0 -->

This guide is for people and AI coding agents changing cockpit itself. To use cockpit on your
own product, start with the [README](README.md). Taking part means following the
[Code of Conduct](CODE_OF_CONDUCT.md).

**AI agents:** read [AGENTS.md](AGENTS.md) first. It maps the codebase, its owners and the
rules agents most often break. Everything below applies to agents too.

## Two audiences, two trees

This repository holds configuration for two different readers. Mixing them is a defect.

| | Using cockpit | Working on cockpit |
|---|---|---|
| You work on | your own product repositories | this codebase: schema, environment commands, codegen, tests |
| Agent configuration | rendered into your checkout by `cockpit sync` | hand-written, in this repository's root dot-directories |
| Lives in | `packages/cockpit/surfaces/` (shipped templates) | `.agents/skills/` and the root agent files |
| Start reading | [README](README.md) | this file, then [Architecture](docs/architecture.md) |

A skill about maintaining the config parser never goes into the shipped surfaces, and a shipped
template never describes this repository.

What the package ships is the allow-list in the `files` field of `packages/cockpit/package.json`,
checked against the real `npm pack` output by `packages/cockpit/src/packaging.test.ts`. Adding a
file to that list is the review.

## Setup

You need Node.js `^22.13.0 || ^24.0.0 || ^26.0.0` (the root `engines` field), Git 2.42 or newer
(the hygiene scanner uses `git cat-file -Z`), and Bash and zsh.

```sh
npm ci --ignore-scripts
npm run build
git config --local core.hooksPath .githooks
test "$(git config --local --get core.hooksPath)" = .githooks
```

The last two lines turn on the repository's hooks: a pre-commit anonymisation scan and a
commit-message check. Git does not activate a tracked hooks directory by itself.

## Development loop

While iterating, run the smallest test that covers the behaviour you are changing:

```sh
npm test -- packages/cockpit/src/tree-hygiene.test.ts
```

`npm test` is the only supported test entry point. It caps Vitest at four workers (pass
`--maxWorkers=1`, `2` or `3` on a busy machine), accepts file paths and `-t '<test name>'` after
`--`, and prints failures as they happen. It writes the latest result to
**.vitest-reports/latest.json**. `npm run test:changed -- <base-commit>` runs the tests adjacent
to what changed since that commit. Test discovery stays inside this checkout's `packages/` tree,
so nested worktrees run their own tests.

## Verification

Before marking a pull request ready, run the complete local gates and paste their real output
into the pull request:

```sh
npm test
npm run typecheck
npm run lint:docs
npm run lint:supply-chain
```

A targeted pass proves only its target. The full suite takes several minutes.

The generated references (the CLI, configuration, command list, capability matrix and the
troubleshooting index) are checked against committed `HEAD`, so `npm run lint:docs` refuses while
an implementation change is uncommitted. Commit the change, rebuild, publish the references
through `publishRepositoryReferences` in `scripts/diagnostic-inventory.mjs`, then lint again.
Never edit a generated reference by hand.

CI runs the build, tests, typecheck and documentation lint on macOS and Linux across the
supported Node versions, the anonymisation scan as its own job, and a check that the launcher
refuses Node below 22.

## The rule that is not negotiable

**Nothing consumer-identifying enters the tracked tree.** No client or employer names, private
hostnames, real registries, credentials or internal URLs, in code, comments, fixtures, tests,
commit messages or documentation. Fixtures are synthetic and keep the shape of the real thing.

If the scan fires, anonymise. Never widen a pattern or add an allowance to make it pass.

The scan has two classes. Credential shapes and private absolute paths are universal and CI
enforces them on every push. Consumer names are site-specific and live only in the maintainer's
private needle file, so **CI cannot catch a site-name leak**. A green CI scan means "no
credentials and no home directories", not "no names". The scan prints which classes it covered;
read that line.

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

One concern per pull request. The template's checklist is short because every line on it is
something that has gone wrong before.

- **Every bug fix lands with a test that fails without it.** Say how you saw it fail.
- **Paste real output, not a summary**, and separate what you ran from what you believe.
- Documentation for a behaviour change goes in the same pull request.
- Add a changeset (`npx changeset`) when the change is visible to someone using cockpit; see
  [.changeset/README.md](.changeset/README.md).
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
- **A capability claim that was read rather than measured.** Harness cells are established by
  probing the tool beside a deliberately broken control file, and dated.
- **A dependency added without a case for it.** Exact pin, lockfile committed, and an argument
  for why the code cannot be written instead.
- **Reformatting mixed into a behaviour change.**
- **A hand-edited generated file.** Change the generator.

## Releasing

Releases are cut by the maintainer. The checklist is in
[Releasing](docs/contributing/releasing.md); the user-facing policy is in
[Release policy](docs/release-policy.md).

## Governance

One maintainer, [@b0dea](https://github.com/b0dea), reviews and merges everything and owns every
path in [CODEOWNERS](.github/CODEOWNERS). There is no second reviewer and no on-call, so review
can stall, and no response window is promised except for security reports. Two things keep a
stall from being a dead end: the license is MIT, so a fork is always available, and the
extension seams (overlays, guard tables, custom harnesses) let you route around a decision
without forking. A second maintainer will be named here when there is one.
