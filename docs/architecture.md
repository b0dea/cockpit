# Architecture and extension seams

<!-- cockpit:verified version=0.0.0 -->

This guide is for integrators extending cockpit without creating a second parser, process runner,
or source of environment truth. The command line remains a thin adapter over existing owners.

## Processing path

Configuration is declared and loaded, bounded evidence is observed, policy owners decide, the
environment application sequences the work, and the shared executor dispatches child processes.
Postchecks authenticate results before command handlers render them. The current fields and
commands are generated in the [configuration reference](configuration-reference.md) and
[CLI reference](cli-reference.md); do not reproduce their tables in extension documentation.

The [Cockpit evidence boundary](concepts.md#cockpit-evidence-boundary) applies at every transition.
A parsed declaration is not an observation, a dispatched command is not a successful postcheck,
and a generated file is not proof that its native consumer loaded it.

## Surface overlays

Use a [Cockpit surface overlay](concepts.md#cockpit-surface-overlay) for product-specific rules,
subagents, skills, and hooks. A name collision must declare `replaces` with the original name and
SHA-256. A later change to that original is
reported as `OVERRIDDEN_CORE_CHANGED` before new output is accepted. Permissions and MCP authority
stay in core declarations and cannot be replaced by an overlay.

Overlay merging belongs to `packages/cockpit/src/surfaces/merge.ts`; rendering continues through
the existing surface owners. Publication must remain within
[Cockpit generated ownership](concepts.md#cockpit-generated-ownership). See [Harness surfaces](harness-surfaces.md)
for the exact ownership and review procedure.

## Guards

Extend policy in `packages/cockpit/src/guards/evaluator.ts`, then adapt its decision through the
measured harness adapters. Do not interpret guard policy in shell or reconstruct it in a CLI
handler. A harness mechanism that has not been paired with a deliberately broken control remains
`instructed` or `unavailable`, as shown by its
[Cockpit harness capability state](concepts.md#cockpit-harness-capability-state).

## Runtime behavior

Add a public command to `packages/cockpit/src/command-table.ts`, bind it in
`packages/cockpit/src/cli.ts`, and sequence environment work through the applicable application
owner. Every child process crosses `packages/cockpit/src/environment-exec/execute.ts`; health and
lifecycle verdicts stay with their existing owners. Extend a schema field only with the owner that
consumes it, because configuration that parses and does nothing is a defect.

The detailed runtime sequence and recovery rules are in [Environment](environment.md). New
diagnostics need one actionable remedy in the generated [Troubleshooting](troubleshooting.md)
reference.

## Harnesses

A custom harness declares exactly one row for every feature. Each emitted row names its spelling,
control, mechanism, and measured date; an `enforced` row also binds exact evidence bytes. Custom
modules are authenticated and filesystem-constrained but are not a security sandbox.

Probe the exact harness candidate beside a deliberately broken control before changing a
capability claim. Repository tests and source inspection can verify cockpit's side of the contract;
native loading and enforcement remain separate operator evidence.
