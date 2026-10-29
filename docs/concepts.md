# Concepts

<!-- cockpit:verified version=0.0.0 -->

This page defines the words cockpit's commands, configuration and diagnostics use, for anyone
reading them for the first time. Each term has one meaning across the documentation; other
pages link here instead of redefining it.

## Cockpit glossary

Everyday terms, in plain language.

### Agent harness

The AI coding tool an agent runs in. The [capability matrix](capability-matrix.md) names the
built-in target identifiers and records each feature's evidence. An instructions-only tool can
read the shared guide without gaining guard or permission enforcement; see
[Capability states](harness-surfaces.md#capability-states).

### Sibling repository

One of the product's Git repositories, declared in a `[[sibling]]` table. Siblings sit side by
side under one directory, the siblings root. Each declaration says how the stack uses the
checkout (`mount`) and how the checkout gets onto disk (`acquire`). Those two settings are
independent on purpose; see [Architecture](architecture.md#two-axes-mount-and-acquire).

### Stack

The running product: the Docker Compose project cockpit generates from the declared services,
volumes and ports, started against the sibling checkouts on your disk.

### Surface

A file cockpit generates for an agent harness: the shared root instructions in AGENTS.md,
the Claude import in CLAUDE.md, skills, subagents, hooks, MCP server entries and permissions. Surface templates ship
in the package; `cockpit sync` renders them for each configured harness.

### Overlay

A product-specific addition to the generated surfaces, such as an extra rule or skill. An
overlay can replace a built-in item only by naming it and its SHA-256, so a later change to that
item is reported instead of silently overridden.

### Guard

A check that runs before an agent's tool call and can deny it: pushing to a protected branch,
editing a declared environment or secret file, or running a command against a declared hosted
database or vendor host. One guard policy is translated into each harness's hook format.

### Drift

A difference between a generated file on disk and what the current configuration would
generate. `cockpit check` reports drift and changes nothing; `cockpit sync` replaces the owned
bytes after you review them.

### Holder

A record that one checkout is using the stack. `up` adds a holder and `sleep` removes it. The
stack stops only when no holder remains, so one agent cannot stop another agent's environment.

### Work order

A bounded Markdown contract for one piece of agent work: its source, the paths it may change,
schema-bounded acceptance criteria, the commands that verify them, and the ordered steps. The
[work-order parser](../packages/cockpit/src/work-orders/contract.ts) owns the current bounds.
cockpit validates it before work starts and grades the result against it.

### Evaluator

The grader that reviews a finished work order. It reruns the declared verification commands and
grades each acceptance criterion from that evidence. It never edits code and is never the
session that did the work.

### Persona

A stable synthetic identity used in seed data and authenticated tests, such as a test user with
a known role. Personas come from one declared source file and are rendered into typed outputs
the product's tests can import.

### Enforced, instructed and unavailable

The three states of a harness feature. See
[Cockpit harness capability state](#cockpit-harness-capability-state).

## Cockpit checkout root

The directory that holds <!-- cockpit:ref consumer=cockpit.toml --> `cockpit.toml`. It identifies one cockpit instance. Relative
generated paths, `cockpit.siblings_root` and lifecycle commands all resolve from here, including
when the configuration sits inside a Git checkout. This keeps sibling discovery and Compose
paths aligned with the configuration you selected. Use `cockpit setup --config <path>` to set up
that configuration's siblings. Git checkout identity still comes from its enclosing repository.

## Where the cockpit lives

The cockpit root is a folder of its own beside the product repositories, not one of them. By
default it is a dedicated folder or repository such as `shop-cockpit`, with
`siblings_root = ".."` so each product repository is a sibling next to it:

```text
work/
  shop/            product repository, first sibling (dir = "shop")
  shop-cockpit/    cockpit root: cockpit.toml, AGENTS.md, guards, harness settings
```

Why: cockpit writes its configuration, instructions, guards and harness settings into the
cockpit root. A dedicated folder keeps the product repositories free of those files and lets one
cockpit own several repositories neutrally. It grows from one repository to many with
`cockpit sibling add` and never needs moving.

An initial tool installation must not change which repositories `init` observes. For an empty,
documents-only or central directory, follow
[Bootstrap without a project manifest](getting-started.md#bootstrap-without-a-project-manifest)
before installing a package manifest in the intended root.

- **A new product, an empty folder or a folder of documents** is itself the cockpit. `init`
  declares that folder as its own first sibling (`dir = "."`), and the product's repositories
  are added under it later with `cockpit sibling add <slug> --create`.
- **Inside an existing product repository** (a Git checkout with a package manifest), `init`
  asks first where the cockpit lives, under the answers key `cockpit.root`, and never picks for
  you: `--accept-preview` and `--accept-defaults` refuse with `INIT_COCKPIT_ROOT_REQUIRED` until
  it is answered. `"dedicated"`, the recommendation, creates `../<repo>-cockpit`, initialises it
  as a local Git repository, and declares the product repository as its first sibling. Git
  identity lets setup and lifecycle checks authenticate the new cockpit before they run. This is
  the one directory `init` writes outside the folder it ran in. An existing destination must be
  empty or a local Git repository with a plain `.git` directory, so adoption cannot follow
  redirected Git metadata or take over unrelated files. `"in-repo"` makes the product
  repository the cockpit root: it then carries the cockpit files, and the cockpit cannot
  neutrally own several repositories.

Moving an existing in-repo cockpit changes generated ownership. There is no authenticated public
migration command yet; do not delete an ownership manifest or its listed paths by hand. Create a
new dedicated cockpit as a separate adoption and remove the old one only when a future command can
preview and postcheck that cleanup.

## Cockpit sibling declaration

The `[[sibling]]` entry for one product repository: its stable slug, directory, acquisition
mode, mount mode, toolchain and projected guidance. A declaration names a repository; `setup`
and `preflight` check that the checkout actually exists and matches it.

## Cockpit product registry

An optional, validated description of an existing product's repositories, environment,
surfaces, guards, grading and adoption state, used as input when adopting an established setup.
It feeds discovery; the <!-- cockpit:ref consumer=cockpit.toml --> `cockpit.toml` draft it produces still needs your review.

## Cockpit lifecycle record

The state cockpit persists for one checkout and its shared runtime: which setup and bring-up
stages completed. Later commands use it to resume safely and to tell a current observation from
an earlier attempt.

## Cockpit generated ownership

The inventory of every whole file, symlink and delimited region in a shared file that cockpit
published, with the expected bytes. It is what lets `check` detect drift and lets `sync`
replace its own output without touching bytes it does not own.

## Cockpit harness capability state

The measured status of one feature for one agent harness:

- `enforced`: a mechanism refuses the prohibited operation, and dated evidence shows it doing so.
- `instructed`: cockpit emits the guidance or setting, but enforcement has not been measured.
- `unavailable`: the harness offers no mechanism, so cockpit emits nothing and records why.

Generating a file never promotes a feature to `enforced`; only a measured probe does.

## Cockpit surface overlay

A product-specific rule, subagent, skill or hook added through `[surfaces].overlays`. It may
replace a built-in item only with an explicit, hash-bound `replaces` entry. It cannot replace
core permissions or MCP approval.

## Cockpit evidence boundary

The line between what cockpit has checked itself and what still needs an observation from
somewhere else: a running harness, a person, a vendor or a live runtime. A repository test proves
cockpit's own behaviour; it does not prove that a harness loaded a generated file.
