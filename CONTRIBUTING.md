# Contributing

For people and AI coding agents changing cockpit itself. To use cockpit on your own product, start
with the [README](README.md). Taking part means following the [Code of Conduct](CODE_OF_CONDUCT.md).

**AI agents:** read [AGENTS.md](AGENTS.md) first. It holds the codebase map and the rules agents
most often break.

## Setup

You need the prerequisites in [Getting started](docs/getting-started.md#install-cockpit), Bash, zsh,
and a Git recent enough for the
[`git cat-file -Z` call the hygiene scanner makes](scripts/hygiene-scan.ts).

```sh
npm ci --ignore-scripts
npm run build
git config --local core.hooksPath .githooks
test "$(git config --local --get core.hooksPath)" = .githooks
```

The last two lines enable the hooks in `.githooks/`: an anonymisation scan on commit and a
commit-message check. Git does not enable a tracked hooks directory by itself.

Use the repository scripts, not a bare `tsc`: the documentation checks need the compiler API from
the compatibility package in [package.json](package.json).

## Development loop

Run the smallest test that covers the behaviour you are changing:

```sh
npm test -- packages/cockpit/src/tree-hygiene.test.ts
```

- `npm test` runs Vitest's fast and slow projects, capped at four workers; it takes file paths and
  `-t '<test name>'` after `--`. `npm run test:fast` runs the fast project only. A skipped or todo
  test fails the run unless **scripts/skip-allowlist-reporter.mjs** lists it.
- `npm run test:changed -- <base-commit>` runs, in both tiers, the tests that import what changed
  since that commit (Vitest's `--changed`), plus the tests that read a changed file by name rather
  than import it. Most source changes reach nearly every test, so read its file count.
- `*.slow.test.ts` is the slow tier. [Test tiers](docs/contributing/testing.md#test-tiers) says what
  belongs there.

## Verification

Before marking a pull request ready, run the tests for what you changed and the other gates, and
paste their real output into the pull request. CI confirms the full suite, so run `npm test` locally
only when a shared seam changed:

```sh
npm test -- <test files>
npm run typecheck
npm run lint:docs
npm run lint:markdown
npm run lint:links
npm run lint:supply-chain
```

`lint:links` runs [lychee](https://github.com/lycheeverse/lychee) offline, so install it first; CI
pins the version it runs.

**Generated references** are rendered by `npm run references`: run it after changing what they
describe and commit the result with the change. Never edit a generated page by hand. See
[CLI completion and generated references](docs/contributing/cli-completion-and-references.md); other
maintainer pages are in the [contributor index](docs/contributing/README.md).

CI (`.github/workflows/ci.yml`) runs the build, tests, typecheck, documentation lint, the
anonymisation scan, the changeset check and the test-protection check; `ci-ok` is the aggregate. A
pull request runs the full suite on Linux. A push to main runs what has not passed on its exact
tree, usually macOS and the other supported Node lines, and a failure there
[stops the release](docs/contributing/releasing.md#merging-the-version-packages-pull-request). Add
the `test-macos` label to run them on a pull request likely to behave differently on macOS, such as
shell, path or process handling. The test-protection and version-pull-request-scope jobs run the
base revision's copy of their script, so a change cannot loosen the guard that judges it.

## The rule that is not negotiable

**Nothing consumer-identifying enters the tracked tree**, including commit messages;
[AGENTS.md](AGENTS.md#non-negotiable-nothing-consumer-identifying-in-the-tracked-tree) has the rule
and how the scan enforces it. CI cannot catch a site-name leak: a green CI scan means "no
credentials and no home directories", not "no names". The scan prints which classes it covered; read
that line. If it fires, anonymise. Never widen a pattern or add an allowance to make it pass.

## Commits

- Subject: a declarative sentence saying what is now true. No conventional-commit prefix, ticket ID
  or emoji.
- Body: the failure that motivated the change and why the fix has this shape. The diff already says
  what moved.
- Stage explicit paths and review the diff before committing. Never bypass the hooks; fix the cause.
- A commit that deletes, renames or weakens a test needs the line
  `COCKPIT_TEST_WEAKENING_ACK: <reason>` in its message body. The test-protection job refuses
  without it.
- Messages fall under the anonymisation rule and cannot be corrected without a history rewrite.

## Pull requests

One concern per pull request.

- **Every bug fix lands with a test that fails without it.** Say how you saw it fail.
- **Paste real output, not a summary**, and separate what you ran from what you believe.
- Documentation for a behaviour change goes in the same pull request.
- Add a changeset (`npx changeset`) when the change is visible to someone using cockpit. CI requires
  one for changes under `packages/cockpit/src` or `packages/cockpit/surfaces`, unless a maintainer
  adds the `no-changeset` label. See [.changeset/README.md](.changeset/README.md).
- Open an **issue first** for anything that changes the <!-- cockpit:ref consumer=cockpit.toml -->
  `cockpit.toml` schema, the generated file layout, the overlay contract, or a CLI command or flag.
  Agree the shape before the diff.

## Reporting issues

Use the issue forms. Give the exact command, the actual and expected output, your versions and the
smallest reproduction you can; rebuild it with invented names if the real one carries names you
cannot publish. **Never report a vulnerability in a public issue.** Follow
[SECURITY.md](SECURITY.md).

## What will not be accepted

- **Consumer-identifying material**, in any file, including a fixture "just for a test run".
- **A control that binds nothing**: configuration that parses and does nothing, a CI step that runs
  nothing, or a document claiming enforcement that nothing enforces.
- **A weakened test**: skipped, deleted, or an assertion edited to match current behaviour, or a fix
  that works by disabling a check, suppressing a warning or loosening a type.
- **A bug fix with no test that fails without it.**
- **Speculative abstraction**: a configuration knob with no second caller, an interface with one
  implementation, handling for states that cannot occur.
- **A capability claim that was read rather than tested.** Harness cells are established by probing
  the tool beside a deliberately broken control file, and dated.
- **A dependency added without a case for it.** Exact pin, lockfile committed, and an argument for
  why the code cannot be written instead.
- **Reformatting mixed into a behaviour change.**
- **A hand-edited generated file.** Change the generator.

## Releasing

The maintainer cuts releases; see [Releasing](docs/contributing/releasing.md).

## Governance

One maintainer, [@b0dea](https://github.com/b0dea), reviews and merges everything and owns every
path in [CODEOWNERS](.github/CODEOWNERS). There is no second reviewer and no on-call, so review can
stall, and no response window is promised except for [security reports](SECURITY.md). The license is
MIT, so a fork is always available. Small, tested changes that follow the rules above are the most
likely to merge; propose a larger one in an issue first. Fixes land on the latest minor only, and
the [release policy](docs/release-policy.md) says what pre-1.0 releases may change.

## Road to 1.0

1.0 means the configuration, the generated file layout and the command surface stop changing without
a deprecation period. It waits on:

- **Measured tools.** Every cell the README claims is a dated run of the real tool in the
  [capability matrix](docs/capability-matrix.md), and a cell that cannot be measured is not claimed.
- **A cold-start journey that needs no help.** In a new repository, an agent in each measured tool
  sets cockpit up from the guide; a second, fresh session in the same repository then fixes a
  planted bug with the guard denying a planted secret read and a push to the protected branch.
- **Settled defaults.** The autonomy defaults, the work-order format and the `cockpit.toml` schema
  have been used on real products long enough that changes to them are rare.
- **Published and reproducible.** `cockpit upgrade` moves a real consumer across a release without
  manual edits.
