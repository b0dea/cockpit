# Concepts

<!-- cockpit:verified version=0.0.0 -->

This page defines the words cockpit's commands, configuration and diagnostics use, for anyone
reading them for the first time. Each term has one meaning across the documentation; other
pages link here instead of redefining it.

## Cockpit glossary

Everyday terms, in plain language.

### Agent harness

The AI coding tool an agent runs in. cockpit supports three, named by their target names:
`claudecode` (Claude Code), `codexcli` (Codex CLI) and `opencode` (OpenCode).

### Sibling repository

One of the product's Git repositories, declared in a `[[sibling]]` table. Siblings sit side by
side under one directory, the siblings root. Each declaration says how the stack uses the
checkout (`mount`) and how the checkout gets onto disk (`acquire`). Those two settings are
independent on purpose; see [Architecture](architecture.md#two-axes-mount-and-acquire).

### Stack

The running product: the Docker Compose project cockpit generates from the declared services,
volumes and ports, started against the sibling checkouts on your disk.

### Surface

A file cockpit generates for an agent harness: root instructions such as AGENTS.md and
CLAUDE.md, skills, subagents, hooks, MCP server entries and permissions. Surface templates ship
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
three to seven acceptance criteria, the commands that verify them, and the ordered steps.
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
generated paths, local state and lifecycle commands all resolve from here.

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
