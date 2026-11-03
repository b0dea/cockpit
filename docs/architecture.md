# Architecture and design

This page is for integrators and contributors who want the reasoning behind cockpit: the problem it
solves, the design decisions that follow, and where in the source to extend it. The fields and
commands themselves are in the generated [configuration reference](configuration-reference.md) and
[CLI reference](cli-reference.md).

## The problem cockpit solves

Agent work across several repositories of one product fails in predictable, mechanical ways:

1. **No shared environment.** Each agent sees one checkout. Nothing boots the product it is
   changing, so "it works" means "it compiles".
2. **File access is not instruction.** Granting an agent a sibling directory does not tell it
   what that repository is, how it is tested, or which commands are safe there.
3. **Guards do not carry across tools.** A hook written for one harness does nothing in another,
   and each harness spells permissions differently.
4. **Environments collide.** Two agents on one machine fight over ports, volumes and the right to
   stop the stack.
5. **Completion is self-reported.** The session that did the work also declares it done.

There are three ways to respond. A planning tool describes the work and leaves the environment
to you. A sandbox isolates the agent from your machine, and from the product. cockpit boots the
product the agent is editing, from the checkouts it is editing, and gives every harness the same
rules about it.

## Design decisions

### Two axes: mount and acquire

A sibling declares how the stack uses it (`mount`) separately from how it reaches disk
(`acquire`). Neither is derived from the other. Collapsing them produces a preflight that reports
healthy while the stack mounts the wrong checkout, or none.

### Configuration that parses does something

Every schema field is consumed by code. A field that is accepted and then ignored reads as a
control the next person relies on, so it is a defect. Where a harness offers no
mechanism for a restriction, cockpit emits nothing and records the feature as `unavailable`
rather than writing a setting that binds nothing.

### Generated files are committed and drift-checked

Generated surfaces and Compose files are written into your repository, committed, and compared
byte for byte by `cockpit check`. This sits between vendoring (copies that silently go stale) and
a hidden runtime dependency (nothing to review). You can read every line an agent will load, and
CI fails when a line changes without the configuration changing.

### TypeScript decides, shell runs the hooks

Configuration, validation, codegen, drift and state live in the TypeScript CLI, and every child
process goes through one executor. Guards and hooks stay in shell, because every harness invokes
them directly on each tool call and they must behave identically under all of them with no
interpreter start-up cost.

### Leases, locks and destruction

These rules came from failures on shared machines:

- **Ports are leased, not derived.** Two checkouts of one product would compute the same port from
  the same configuration. A lease records who holds each port family.
- **Locks are directory creations.** Creating a directory either succeeds or fails atomically, and
  a process that dies leaves the directory behind for inspection instead of a half-written file.
- **Unknown is not dead.** A lock or holder whose liveness cannot be established is reported, not
  stolen. Age alone never justifies removing it.
- **Classification overrides intent.** Destructive commands act only on resources whose cockpit
  labels and records match, so "just delete it" cannot be expressed. The question cockpit asks
  is "can I account for everything I am about to destroy?", not "does this look dangerous?".

### Why the evaluator is independent

Self-assessment is overconfident: an agent that wrote the code also wrote the account of it. The
evaluator is a separate subagent that reruns the declared verification commands, grades each
acceptance criterion from that output, and may abstain when the output is not enough to decide. Abstention
is a valid result; it is what turns a likely false pass into a visible gap.

### Prior art

Spec and workflow tools also generate files into repositories. cockpit adds three things they
typically lack: a drift check against installed generated files, a `--dry-run` preview of every
write, and CLI and configuration references generated from the source so they cannot go stale.

## Non-goals

- **Not a planner.** cockpit does not decide what work to do. Pair it with a spec or workflow tool.
- **Not a sandbox.** It does not isolate an agent from your machine; see
  [Safety and autonomy](safety-and-autonomy.md).
- **No telemetry.** The only network request cockpit makes itself is `doctor` reading the latest
  published version from the npm registry, skipped when `CI` or `NO_UPDATE_NOTIFIER` is set.
- **Not a monorepo or build-system replacement.** It can manage one repository or several, but
  delegates each repository's build and dependency graph to that repository's own tools.
- **No per-test containers.** One stack per checkout, shared across the agent's work.

## Processing path

Configuration is declared and loaded, the environment is observed, policy code decides, the
environment application orders the work, and the shared executor runs child processes.
Postchecks verify results before command handlers print them. The
[Cockpit evidence boundary](concepts.md#cockpit-evidence-boundary) applies at every step: a
parsed declaration is not an observation, a dispatched command is not a successful postcheck,
and a generated file does not show that its harness loaded it.

## Surface overlays

Use a [Cockpit surface overlay](concepts.md#cockpit-surface-overlay) for product-specific rules,
subagents, skills and hooks. Overlay merging belongs to `packages/cockpit/src/surfaces/merge.ts`;
rendering continues through the existing surface code, and publication stays within
[Cockpit generated ownership](concepts.md#cockpit-generated-ownership).
[Ownership and extension](harness-surfaces.md#ownership-and-extension) covers the `replaces` rule
and the review procedure.

## Guards

Extend policy in `packages/cockpit/src/guards/evaluator.ts`, then adapt its decision through the
per-harness adapters. Do not interpret guard policy in shell or rebuild it in a CLI
handler. A harness mechanism that has not been probed beside a deliberately broken control stays
`instructed` or `unavailable`; see [Capability states](harness-surfaces.md#capability-states).

## Runtime behavior

Add a public command to `packages/cockpit/src/command-table.ts`, bind it in
`packages/cockpit/src/cli.ts`, and order environment work through the environment application
(`packages/cockpit/src/environment/application/`). Every child process crosses
`packages/cockpit/src/environment-exec/execute.ts`; health and lifecycle verdicts stay in their
existing modules. Add a schema field only together with the code that consumes it.

The runtime sequence and recovery rules are in [Environment](environment.md). A new diagnostic
needs one actionable remedy in [Troubleshooting](troubleshooting.md).

## Harnesses

A custom harness declares one row for every feature, with the evidence described in
[Custom harnesses](harness-surfaces.md#custom-harnesses). Probe the exact harness version beside
a deliberately broken control before changing a capability claim. Repository tests verify
cockpit's side of the contract; native loading and enforcement need their own check through
`cockpit selftest`.
