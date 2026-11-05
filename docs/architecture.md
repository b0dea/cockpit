# Architecture and design

The reasoning behind cockpit: the problem it solves, the decisions that follow, and where in the
source to extend it.

## The problem cockpit solves

Agent work across several repositories of one product fails in predictable ways:

1. **No shared environment.** Nothing boots the product an agent is changing, so "it works" means
   "it compiles".
2. **File access is not instruction.** Granting a sibling directory does not say what that
   repository is, how it is tested, or which commands are safe there.
3. **Guards do not carry across tools.** A hook written for one harness does nothing in another.
4. **Environments collide.** Two agents on one machine fight over ports, volumes and the right to
   stop the stack.
5. **Completion is self-reported.** The session that did the work also declares it done.

A planning tool describes the work and leaves the environment to you. A sandbox isolates the agent
from your machine, and from the product. cockpit boots the product the agent is editing, from the
checkouts it is editing, and gives every harness the same rules about it.

## Design decisions

### Two axes: mount and acquire

A sibling declares how the stack uses it (`mount`) separately from how it reaches disk (`acquire`).
Collapsing them produces a preflight that reports healthy while the stack mounts the wrong checkout,
or none.

### Configuration that parses does something

Every schema field is consumed by code. A field accepted and then ignored reads as a control the
next person relies on, so it is a defect. Where a harness offers no mechanism for a restriction,
cockpit emits nothing and records the feature as `unavailable`.

### Generated files are committed and drift-checked

Generated files are written into your repository, committed, and compared byte for byte by
`cockpit check`. This sits between vendoring (copies that silently go stale) and a hidden runtime
dependency (nothing to review).

### TypeScript decides, shell runs the hooks

Every harness invokes guards and hooks directly on each tool call, and they must behave identically
under all of them with no interpreter start-up cost. Everything else lives in the TypeScript CLI,
and every child process goes through one executor.

### Leases, locks and destruction

These rules came from failures on shared machines:

- **Ports are leased, not derived.** Two checkouts would compute the same port from the same
  configuration.
- **Locks are directory creations.** Creating one succeeds or fails atomically, and a dead process
  leaves it for inspection instead of a half-written file.
- **Unknown is not dead.** A lock or holder whose liveness cannot be established is reported, not
  stolen. Age alone never justifies removing it.
- **Classification overrides intent.** Destructive commands act only on resources whose cockpit
  labels and records match. The question is "can I account for everything I am about to destroy?",
  not "does this look dangerous?".

### Why the evaluator is independent

An agent that wrote the code also wrote the account of it. So cockpit runs the checks itself, and a
separate read-only run grades each criterion from that output and the change. It may answer
`unclear` when the output is not enough to decide; that is what turns a likely false pass into a
visible gap.

## Non-goals

- **Not a planner.** Pair it with a spec or workflow tool.
- **Not a sandbox.** See [Safety and autonomy](safety-and-autonomy.md).
- **No telemetry.** See the [FAQ](faq.md#does-cockpit-send-data-anywhere).
- **Not a monorepo or build-system replacement.** Each repository's build and dependency graph stays
  with its own tools.
- **No per-test containers.** One stack per checkout, shared across the agent's work.

## Extending the source

The [Cockpit evidence boundary](concepts.md#cockpit-evidence-boundary) applies at every step: a
parsed declaration is not an observation, a dispatched command is not a successful postcheck, and a
generated file does not show that its harness loaded it. The owner of each step is in the
[environment code map](../AGENTS.md#environment-code-map).

| Adding | Do |
|---|---|
| A [Cockpit surface overlay](concepts.md#cockpit-surface-overlay) | Merging belongs to `packages/cockpit/src/surfaces/merge.ts`; publication stays within [Cockpit generated ownership](concepts.md#cockpit-generated-ownership). |
| Guard policy | Extend `packages/cockpit/src/guards/evaluator.ts`, then adapt its decision through the per-harness adapters. Do not interpret policy in shell or a CLI handler. |
| A public command | Add it to `packages/cockpit/src/command-table.ts`, bind it in `packages/cockpit/src/cli.ts`, and order environment work through `packages/cockpit/src/environment/application/`. |
| A schema field | Only together with the code that consumes it. |
| A diagnostic | With one actionable remedy in [Troubleshooting](troubleshooting.md). |
| A harness capability claim | Probe the exact version beside a deliberately broken control; until then it stays `instructed` or `unavailable`. See [Custom harnesses](harness-surfaces.md#custom-harnesses). |
