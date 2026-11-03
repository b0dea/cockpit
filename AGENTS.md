# AGENTS.md

Guide for AI coding agents and humans changing cockpit itself. For using cockpit, see the
[README](README.md); for contribution process (branches, changesets, review), see
[CONTRIBUTING.md](CONTRIBUTING.md).

## What this is

cockpit owns the environment for agent-driven work across several product repositories, and none
of the product code. It brings the product up against live working copies, gives every agent tool
the same instructions, skills, guards and permissions, and grades finished work with something
other than the thing that did the work. It is not a planning tool and not a sandbox.

## Non-negotiable: nothing consumer-identifying in the tracked tree

No client or employer names, private hostnames, real registries, credentials or internal URLs, in
code, comments, fixtures, tests, commit messages or docs. Fixtures are synthetic: when a real
system teaches you something, encode the property in a synthetic fixture and write the lesson in
a comment, never paste the artefact.

The hygiene scan (`node scripts/hygiene-scan.ts`, also run by `npm test`) has two classes.
Credential shapes and private paths are universal, so CI enforces them. Consumer names are
site-specific and absent from this tree, so CI cannot catch a site-name leak: that class is
enforced only where a maintainer-held private site-identifier list is present. A green CI is not
evidence on that class. If the scan fires, anonymise; never narrow the scan.

Publish product truth, not development ceremony: tracked files do not name private tooling,
plan or task identifiers, sessions or local planning paths. Anything generated or machine-local
is ignored in the same change that introduces it.

## Two surface estates, never mixed

| | Working on cockpit | Cockpit working on a consumer's business |
|---|---|---|
| Where | `AGENTS.md`, `CLAUDE.md`, `.agents/skills`, `.claude/skills` (symlink to `.agents/skills`) | `packages/cockpit/surfaces/` |
| Authored | by hand, nothing generates them | templates rendered per cockpit from the registry |

A skill about the `cockpit.toml` schema belongs on the left. A skill about driving a stack or
reaching a sibling repository belongs on the right. A consumer's session must not load
instructions for maintaining a config parser. Only these root surfaces are tracked; the harness
settings directories are not published (enforced by `tree-hygiene.test.ts`).

## Layout

| Path | What |
|---|---|
| `packages/cockpit` | the CLI: config, registry, codegen, drift, `init` |
| `packages/cockpit/surfaces` | shipped templates rendered into a consumer's cockpit |
| `.agents/skills` | skills for working on cockpit itself |
| `fixtures/registries` | synthetic registries, the round-trip corpus |
| `docs` | user and contributor documentation |

## Environment code map

| Step | Owner |
|---|---|
| Declare and load | `packages/cockpit/src/schema.ts` validates declarations; `packages/cockpit/src/config/load.ts` binds source bytes and path. |
| Observe | `packages/cockpit/src/environment/{setup-observation,git-observation,runtime,ports,lifecycle-stage}.ts` produce bounded evidence. |
| Decide | `packages/cockpit/src/environment/observations.ts` evaluates health; `lifecycle.ts`, `claims.ts` and `reclaim.ts` in the same directory decide permitted work. |
| Sequence | `packages/cockpit/src/environment/application.ts` orders setup, lifecycle, health, logs and destructive operations. Thin command modules forward its outcomes. |
| Execute and postcheck | `packages/cockpit/src/environment-exec/execute.ts` owns process mechanics. Owner modules authenticate the resulting observations before application publishes state. |
| Bind and test | `packages/cockpit/src/cli.ts` supplies production dependencies and renders outcomes. Adjacent `*.test.ts` files exercise each owner; `packages/cockpit/src/architecture-contract.test.ts` checks the boundaries. |

Extend an owner at its existing seam. A new command goes in the command table and CLI binding;
it does not get a second process runner or an independent health verdict.

## Commands

```sh
npm ci --ignore-scripts
npm run test:changed -- <base-commit>  # fast-tier tests adjacent to your changes; --wide adds the slow tier
npm test -- <test file>                # targeted run; bare `npm test` is the full suite
npm run typecheck
npm run lint:docs                      # cockpit:ref targets, codes, glossary links, docs indexes
npm run lint:markdown                  # markdownlint
npm run lint:links                     # lychee, offline; needs lychee installed
npm run references                     # regenerate generated docs (see Keep docs current)
```

Run adjacent owner tests, review non-adjacent dependents, and typecheck before reporting a
behaviour change. Run the full suite, which includes the slow tier, before pushing, before a PR is
marked ready, or when a shared seam changes.

## Conventions

- **TypeScript owns decisions and bounded process dispatch; shell owns shared scripts.** Config,
  validation, registry, codegen, drift and state live in the CLI. Every child process crosses
  `environment-exec/execute.ts`. Compose scripts, guards and hooks stay shell: several agent tools
  invoke them directly and they must run identically under all of them.
- **Configuration that parses and does nothing is a defect.** If a harness offers no mechanism for
  a restriction, emit nothing and record the gap.
- **Say where a value came from.** Anything inferred carries a provenance and a stated reason, and
  is surfaced for confirmation.
- **Detectors over assertions.** Prefer a check that can go red to a paragraph that claims; where
  a claim cannot be checked mechanically, say so.
- **Fail closed.** A missing dependency, unparseable field or unreadable file exits with a reason.
- **Comments explain why.** Keep comments that record the failure motivating a design; do not
  restate them elsewhere.
- **Every bug fix lands with a test that fails without it.** One test pins one public behaviour;
  extend the closest existing case rather than adding branch or getter coverage.

## Keep docs current

- After changing `command-table.ts`, `schema.ts`, a shipped skill or guard, or a diagnostic code: run `npm run references` and commit the regenerated pages with the change. CI fails while they differ.
- A user-visible behaviour change updates the hand-written page that owns that fact in the same change; find the owner through the `docs/README.md` index (grep the old wording).
- Never write counts, tool versions, dates or line numbers in prose: link to the generated page, `package.json` or the schema.
- Add a changeset for package changes: `npx changeset`.

## Harness capabilities

Support for each agent tool is a matrix of capabilities; a cell is *enforced*, *instructed*,
*generated* (emitted, never checked) or *unavailable* (nothing emitted). Establish which by driving the tool, not by reading its docs or symbols. Follow
`.agents/skills/verify-harness-capability/SKILL.md`, keep a deliberately broken control file
beside the real one, never claim a capability the matrix has not measured, and date every
measurement. The matrix is `docs/capability-matrix.md`.
