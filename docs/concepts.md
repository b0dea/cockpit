# Concepts

This page defines the words cockpit's commands, configuration and diagnostics use. Each term has
one meaning across the documentation, and other pages link here instead of redefining it.

## Cockpit glossary

Everyday terms, in plain language.

### Agent harness

The AI coding tool an agent runs in, such as Claude Code, Codex CLI or OpenCode. cockpit installs
its guard hook for those; for Cursor and Grok Build, once `[surfaces] tools` lists them, it writes
files but installs no guard, and nobody has confirmed those tools load them. The
[capability matrix](capability-matrix.md) lists the target identifiers and what is confirmed for
each feature; see also [Capability states](harness-surfaces.md#capability-states).

### Sibling repository

One of the product's Git repositories, declared in a `[[sibling]]` table. Siblings sit side by
side under one directory, the siblings root. Each says how the stack uses the checkout (`mount`)
and how the checkout gets onto disk (`acquire`), two deliberately independent settings
([Architecture](architecture.md#two-axes-mount-and-acquire)).

### Stack

The running product: the Docker Compose project cockpit generates from the declared services,
volumes and ports, started against the sibling checkouts on your disk.

### Surface

A file cockpit generates for an agent harness: the shared instructions in AGENTS.md, the Claude
import in CLAUDE.md, skills, subagents, hooks, MCP server entries and permissions. `cockpit sync`
renders them from templates shipped in the package.

### Overlay

A product-specific addition to the generated surfaces, such as an extra rule or skill; see
[Cockpit surface overlay](#cockpit-surface-overlay).

### Guard

A check that runs before an agent's tool call and can deny it, for example a push to a protected
branch, an edit to a declared environment or secret file, or a command aimed at a declared hosted
database or vendor host. The same policy is installed as a hook in each harness that supports one.

### Drift

A difference between a generated file on disk and what the current configuration would generate.
`cockpit check` reports it without changing anything. `cockpit sync` rewrites a changed generated
artifact such as `compose.cockpit.yml`, but refuses a changed surface (a skill, agent settings or
a cockpit-owned region) with `SURFACE_STATE_CONFLICT`, because it can no longer prove it wrote
those bytes.

### Holder

A record that one checkout is using the stack. `up` adds one and `sleep` removes it; the stack stops
only when none remain, so one agent cannot stop another's environment.

### Work order

A file, `workorders/<id>.md`, whose YAML front-matter is the contract for one piece of agent work: its
objective, the paths it may change, acceptance criteria with the checks that show them, and what it
leaves alone. cockpit records who accepted it, runs its checks, grades the result against it and
records how it closed; the [work-order contract](../packages/cockpit/src/work-orders/contract.ts)
holds its schema and limits.

### Evaluator

The grader for a finished work order under the default `independent` grading. It grades each
acceptance criterion, and the standing criteria cockpit adds (changes outside scope, flagged test
changes, the agent's amendments), against the checks cockpit ran and the change since the order was
accepted, in a fresh read-only run that never sees the session that did the work, in another listed
agent tool when one is available, otherwise the same tool in a new run. It never edits code. A cockpit
can instead let the checks alone decide, or let the agent report its own verdict; the record says
which.

### Enforced, instructed, generated and unavailable

The four states of a harness feature. See
[Cockpit harness capability state](#cockpit-harness-capability-state).

## Cockpit checkout root

The directory that holds <!-- cockpit:ref consumer=cockpit.toml --> `cockpit.toml`; it identifies one cockpit instance. Generated
paths, `cockpit.siblings_root` and lifecycle commands resolve from here, even when the
configuration sits inside a larger Git checkout, so sibling discovery and Compose paths follow
the configuration you select with `--config`.

The cockpit's runtime identity comes from the main Git checkout and the checkout identity from the
current one, so linked worktrees share one cockpit but stay distinct checkouts. A standalone
directory can `sync` before Git exists, and its generated files stay valid; `setup` and lifecycle
commands need a Git checkout, and the guard holds an agent's guarded calls until it can read one.

## Where the cockpit lives

The cockpit root is the directory that holds `cockpit.toml`, the generated instructions, the guard
and the harness settings. There are two layouts, and `init` does not ask which to use for a single
repository:

- **In-repo** is the default for one product repository. The repository itself is the cockpit root
  (`siblings_root = "."`, the repository is the sibling with `dir = "."`), so the cockpit files are
  committed with the product.
- **Dedicated** is the layout for a product made of several repositories. The root is a folder or
  repository of its own beside them, such as `shop-cockpit`, with `siblings_root = ".."`:

```text
work/
  shop/            product repository, first sibling (dir = "shop")
  shop-cockpit/    cockpit root: cockpit.toml, AGENTS.md, guards, harness settings
```

A dedicated root keeps cockpit files out of the product repositories and lets one cockpit own several
neutrally; an in-repo cockpit cannot. Pick it by answering `cockpit.root = "dedicated"` to `init` run
from the product repository: `init` creates `../<repo>-cockpit` as a local Git repository (the one
directory it writes outside the folder it ran in; an existing destination must be empty or a local
Git repository with a plain `.git` directory) and declares the product repository as its first
sibling. An empty folder or a folder of documents is itself the cockpit: `init` declares it as its
own first sibling (`dir = "."`), and repositories are added later with
`cockpit sibling add <slug> --create`.

There is no command to move an in-repo cockpit. Do not delete the ownership manifest or the paths it
lists by hand; create a new dedicated cockpit as a separate adoption, and remove the old one only
once a command can preview and check that cleanup. To create one, follow
[Getting started](getting-started.md).

## Cockpit sibling declaration

The `[[sibling]]` entry for one product repository: its stable slug, directory, acquisition and
mount modes, toolchain and generated guidance. It names a repository; `setup` and `preflight`
check that the checkout exists and matches it.

## Cockpit product registry

An optional, validated description of an existing product's repositories, environment, surfaces,
guards, grading and adoption state, used as input when adopting an established setup. The
<!-- cockpit:ref consumer=cockpit.toml --> `cockpit.toml` draft it produces still needs your review.

## Cockpit lifecycle record

The state cockpit keeps for one checkout and its shared runtime: which setup and bring-up stages
completed. Later commands use it to resume safely and to tell the current state from an earlier
attempt.

## Cockpit generated ownership

The record of every file and delimited region of a shared file that cockpit wrote, with
the bytes it expects. It lets `check` detect drift and `sync` replace its own output without
touching anything else.

## Cockpit harness capability state

The confirmed status of one feature for one agent harness:

- `enforced`: a mechanism refuses the prohibited operation, and a dated check shows it doing so.
- `instructed`: cockpit emits the guidance or setting, but enforcement has not been confirmed.
- `generated`: cockpit emits the file for a harness with no guard adapter or loading test, so
  nobody has verified that the tool even loads it.
- `unavailable`: the harness offers no mechanism, so cockpit emits nothing and records why.

Generating a file never promotes a feature to `enforced`; only a probe of the real tool does.

## Cockpit surface overlay

A product-specific rule, subagent, skill or hook added through `[surfaces].overlays`. It may
replace a built-in item only with an explicit `replaces` entry naming that item's SHA-256, so a
later change to the item is reported instead of silently overridden. It cannot replace core
permissions or MCP approval.

## Cockpit evidence boundary

The line between what cockpit has checked itself and what still needs confirmation elsewhere: a
running harness, a person, a vendor or a live runtime. A repository test proves cockpit's own
behaviour, not that a harness loaded a generated file.
