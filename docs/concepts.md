# Concepts

<!-- cockpit:verified version=0.0.0 -->

This page defines the words cockpit's commands, configuration and diagnostics use. Each term has
one meaning across the documentation, and other pages link here instead of redefining it.

## Cockpit glossary

Everyday terms, in plain language.

### Agent harness

The AI coding tool an agent runs in, such as Claude Code, Codex CLI or OpenCode. cockpit installs
its guard hook for those; it also writes files for Cursor and Grok Build, but installs no
guard there and nobody has confirmed those tools load them. The
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
`cockpit check` reports it without changing anything; `cockpit sync` replaces the files it wrote.

### Holder

A record that one checkout is using the stack. `up` adds one and `sleep` removes it; the stack stops
only when none remain, so one agent cannot stop another's environment.

### Work order

A Markdown contract for one piece of agent work: its source, the paths it may change, acceptance
criteria, the commands that verify them, and ordered steps. cockpit validates it before work starts
and grades the result against it; the [work-order parser](../packages/cockpit/src/work-orders/contract.ts)
sets its size limits.

### Evaluator

The grader for a finished work order. It reruns the declared verification commands and grades each
acceptance criterion from their output. It never edits code and is never the agent that did the work.

### Persona

A stable synthetic identity for seed data and signed-in tests, such as a test user with a known
role. Personas come from one declared source file and are generated into typed outputs the
product's tests can import.

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
directory can `sync` before Git exists; `setup` and lifecycle commands need a Git checkout.

## Where the cockpit lives

The cockpit root is a folder of its own beside the product repositories, not one of them. By
default it is a dedicated folder or repository such as `shop-cockpit`, with
`siblings_root = ".."` so each product repository is a sibling next to it:

```text
work/
  shop/            product repository, first sibling (dir = "shop")
  shop-cockpit/    cockpit root: cockpit.toml, AGENTS.md, guards, harness settings
```

cockpit writes its configuration, instructions, guards and harness settings into the cockpit
root. A dedicated folder keeps those files out of the product repositories, lets one cockpit own
several repositories neutrally, and grows from one repository to many with `cockpit sibling add`
without ever moving. To create one, follow [Getting started](getting-started.md#choose-a-starting-point);
the first installation stays outside the intended root so it cannot change what `init` observes.

- **A new product, an empty folder or a folder of documents** is itself the cockpit. `init`
  declares that folder as its own first sibling (`dir = "."`), and the product's repositories
  are added under it later with `cockpit sibling add <slug> --create`.
- **Inside an existing product repository** (a Git checkout with a package manifest), `init`
  first asks where the cockpit lives (answers key `cockpit.root`) and never picks for you:
  `--accept-preview` and `--accept-defaults` refuse with `INIT_COCKPIT_ROOT_REQUIRED` until it is
  answered.
  - `"dedicated"`, the recommendation, creates `../<repo>-cockpit` as a local Git repository, so
    setup and lifecycle checks can identify it, and declares the product repository as its first
    sibling. This is the one directory `init` writes outside the folder it ran in. An existing
    destination must be empty or a local Git repository with a plain `.git` directory, so adoption
    cannot follow redirected Git metadata or take over unrelated files.
  - `"in-repo"` makes the product repository the cockpit root: it carries the cockpit files, and
    the cockpit cannot neutrally own several repositories.

There is no command to move an in-repo cockpit. Do not delete the ownership manifest or the paths
it lists by hand; create a new dedicated cockpit as a separate adoption, and remove the old one
only once a command can preview and check that cleanup.

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

The record of every file, symlink and delimited region of a shared file that cockpit wrote, with
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
