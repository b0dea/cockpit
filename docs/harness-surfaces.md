# Harness surfaces

<!-- cockpit:verified version=0.0.0 -->

This page explains what `cockpit sync` writes for Claude Code, Codex CLI, OpenCode, Cursor, and
Grok Build, how product-specific additions enter, and how each feature's enforcement is measured. It is for
people reviewing generated agent configuration and for integrators extending it.

## Publish and verify

Surfaces are published by the same `sync` and checked by the same `check` as the rest of the
generated environment; follow [Bring the product up](getting-started.md#bring-the-product-up).
`check` is the only drift authority and never repairs output.

The repository action at `.github/actions/cockpit-check/action.yml` runs only `cockpit check`.
The caller must install the exact cockpit version from its lockfile first; the action does not
download cockpit or invoke a second generator check.

## Ownership and extension

Generated entries are either whole-file owned or an explicitly delimited region in a shared
file. The ownership manifest records the expected type, bytes, and source identities. Its
unkeyed digest detects accidental changes but does not prove historical ownership. A dry run
reports an exact stale-removal request and digest. Applying any stale removal requires a separate
approval bound to the current paths and bytes. Plain `sync` refuses the apply;
`sync --interactive` previews the request, displays its entries and digest, and requires you to
type that exact digest before a revalidated apply. Changed stale paths remain
conflicts to reconcile. A team's existing `.claude/settings.json`, `.codex/config.toml` or
`.codex/hooks.json` is not overwritten: [adopt it](adoption.md#adopt-existing-agent-settings) and
cockpit renders a merge of the team's copy and its own output.

Core declarations and `[surfaces].overlays` merge by stable name. A colliding overlay must use
`replaces` with the core name and the recorded SHA-256 of that original. `permissions` and `mcp`
remain core authority and cannot be replaced by an overlay. When a later cockpit version changes
an overridden original, `OVERRIDDEN_CORE_CHANGED` identifies the affected overlay before you
accept new output. `doctor` lists active overrides and changed originals from an
authenticated read-only generation preview; an unavailable preview is reported explicitly.
Authored Markdown frontmatter must use unqualified YAML delimiters and valid bounded YAML.
Cockpit rejects language-qualified or malformed frontmatter before generator dispatch.
For the complete list of supported product extension seams and the build-beside pattern, see
[Extending cockpit](extending.md); this page owns only generated surface behavior.

The generator uses a checked-in, SHA-pinned bundle of Rulesync only for harness-specific
spelling. Packaging verifies the bundle against its source and includes its third-party notices;
runtime execution authenticates the bundle bytes before loading them. Cockpit
owns declaration merge, restriction policy, MCP approval, sibling projection, capability state,
output inventory, ownership, and publication. A generator result is accepted only when its
reported inventory matches the files read back from its isolated output directory.

Setting `[surfaces].bundles = ["claudecode-plugin"]` also publishes the generated Claude plugin
bundle directory at **.cockpit/bundles/claudecode-plugin/**. It contains a manifest and the applicable generated
skills, subagents, hooks, and MCP declaration. These files use the same ownership transaction
and drift check as other surfaces. An unmanaged file in that directory remains untouched.
Publication alone does not show that Claude loaded the bundle; that needs a native run.

## Capability states

Each feature is represented as `enforced`, `instructed`, or `unavailable`:

- `enforced` has a mechanism that can refuse the prohibited operation and still requires the
  dated evidence named by its declaration.
- `instructed` emits guidance or a harness setting whose enforcement has not been established.
- `unavailable` emits no pretend control and records why the harness cannot provide it.

Built-in generation covers rules, MCP servers, subagents, skills, hooks, and permissions. The
shared guard is generated only for targets with an admitted adapter. Native spellings differ,
and generated output does not promote an unmeasured native capability. A custom harness must
declare exactly one row for every feature.
Each non-unavailable row names a measured date, output spelling, deliberately broken control,
and bounded module export. Custom modules must be self-contained: cockpit imports the exact
authenticated module bytes, and relative dependency imports are refused. The worker may write
only to its temporary scratch directory; it receives no child-process, worker-thread, or native
addon permission. If the installed Node runtime cannot provide filesystem permissions, cockpit
refuses execution. These permissions limit ordinary filesystem writes and do not establish a
sandbox for malicious code. Cockpit authenticates the module source and result;
declaring a capability without a receipt is insufficient. For a custom row declared `enforced`,
Cockpit also requires the named evidence file to match its declared SHA-256 before invoking the
module and rechecks the file before publication. That byte match binds the declaration to a
specific artifact; native enforcement still needs a separate paired probe.

### Built-in capability matrix

The renderer publishes Rulesync output for all built-in targets. Native capability stays
`unavailable` for Cursor and Grok Build until an authenticated candidate and deliberately broken
control have been measured.

| Feature | Claude Code | Codex | OpenCode | Cursor | Grok Build | Current evidence boundary |
|---|---|---|---|---|---|---|
| Rules | instructed | instructed | instructed | unavailable | unavailable | Native instruction loading needs a paired probe. |
| MCP | instructed | instructed | instructed | unavailable | unavailable | Approval controls generated enablement; native loading is unproven. |
| Subagents | instructed | instructed | instructed | unavailable | unavailable | Native role behavior needs evidence. |
| Skills | instructed | instructed | instructed | unavailable | unavailable | Native parity and required human reviews remain pending only for admitted candidates. |
| Hooks | instructed | instructed | instructed | unavailable | unavailable | Generated hook files do not establish that the harness invokes them. |
| Permissions | instructed | instructed | instructed | unavailable | unavailable | Generated permission files do not establish native loading; the shared guard remains unavailable without an admitted adapter. |

The checked-in guard adapters (the
[Claude](../packages/cockpit/surfaces/guards/claude.adapter.json),
[Codex](../packages/cockpit/surfaces/guards/codex.adapter.json) and
[OpenCode](../packages/cockpit/surfaces/guards/opencode.adapter.json) adapters) record historical
transport measurements. Each harness's recorded version, date and probe are in the
[capability matrix](capability-matrix.md).

The recorded versions are not claims about a currently installed harness.
[Restriction expansion](../packages/cockpit/src/surfaces/restrictions.ts) authenticates the
adapter provenance but emits `instructed`/`pending_evidence`, including native read-only
fragments. An unavailable adapter emits no control and records `unavailable`/`not_applicable`.
Codex and OpenCode have no prompt tier, so ask decisions become denials.
[Rendering](../packages/cockpit/src/surfaces/render.ts) preserves those states;
[selftest planning](../packages/cockpit/src/surfaces/selftest.ts) derives the candidate's
instruction-loading, guard-firing and per-skill matrix. Use the
[selftest evidence procedure](#skills-and-selftest-evidence) to measure that exact candidate
beside broken controls. Historical adapter provenance never promotes current native cells.

## MCP servers and restrictions

`[mcp].approved` is the shared allowlist. A declared server absent from it is rendered disabled
for every configured harness and reports `MCP_NOT_APPROVED`. A name on the allowlist without a
declaration reports `MCP_APPROVAL_UNKNOWN`. Cockpit rejects conflicting commands for one server,
credential-like arguments, environment values that are not same-name references, and working
directories outside the declared sibling. Generated wrappers start with an empty environment
and pass only the declared environment names.

Restriction policy comes from `[guards]`. Cockpit expands one shared guard through measured
per-harness adapters. A harness event with no measured adapter stays unavailable. Codex has no
prompt tier, so policy configured as ask for Codex is rendered as deny rather than allowed.
Read-only subagent support is reported independently because an instruction-only restriction is
weaker than a native tool restriction.

## Sibling projection and standing cost

Sibling guides are observed from declared roots, content-digested, and projected through native
root instructions and confined symlinks. A projection is refused if the guide changes between
observation and planning, escapes its root, conflicts with the mount or directory grant, or
would replace an unmanaged link. The generated state records both the link target and the source
content identity.

The `[cockpit].guide_cap` limit applies to always-loaded guidance. Cockpit reports the measured
line cost per harness only when it has a dated load characterization. When a harness loads every
rule regardless of scope, scoped text still counts toward that total. Missing characterization
is `unavailable`, not zero.

## Skills and selftest evidence

Shipped skills have small entry points and shared procedures. Each skill declares its trigger,
native tool equivalents, allowed cockpit commands, side effects, non-goals, review requirements,
and line cap. The renderer refuses embedded decision logic, undeclared commands, missing native
tool equivalents, missing procedures, duplicate identities, and standing-cost overflow. Codex
also receives its generated skill sidecar.

`selftest` consumes a measured probe-specification artifact tied to both the current source
digest and generated manifest:

```sh
cockpit selftest --interactive \
  --config ./cockpit.toml \
  --probe-specifications ./.cockpit/probe-specifications.json
```

For built-in harnesses, it runs each candidate beside a deliberately broken control and captures
version, help, candidate, and broken-control events. The configured command first runs the read-only generated
environment check and refuses an absent, malformed, stale, or provenance-mismatched artifact.
Interactive mode requires a terminal. Before executing any submitted vector, it displays the
canonical artifact path, whole-file SHA-256, bound source and manifest digests, and each exact
invocation, version, and help command. You must type that artifact digest, then approve
each resolved executable by its displayed absolute path and SHA-256. It is unavailable in CI and
JSON mode.
Custom cells remain `human_needed` until an approved exact probe is available.
Generated custom-module checks do not authorize a constructed worker command.
Without that approval, or when process isolation cannot be established, the cell remains
`human_needed`. Claude Code and Codex skill reviews also remain
`human_needed` until the required official-authoring or native-diagnostics evidence is attached.
Repository tests and generated receipts do not promote those native or human rows.

Legacy adapter evidence is also bounded before parsing: each manifest, candidate, broken control,
and transcript file is limited to 1 MiB. Commands admit at most 256 arguments and 1 MiB of total
argument text; individual event output and required text fields are limited to 1 MiB. Changed
files and non-regular files refuse. These receipts retain their historical capability strength;
passing their validator does not promote a native capability.

## Review an upgrade

`upgrade` is a read-only plan. Without explicit release evidence, it fails closed with
`UPGRADE_VERSION_AMBIGUOUS`. To inspect a candidate, supply an exact release-evidence file and
its independently obtained SHA-256 with `--release-evidence` and
`--release-evidence-sha256`. Cockpit checks the file bytes before parsing, then compares its
current package name and version against the installed cockpit package and requires a strictly newer
candidate version. It reports the attested release integrity, checks installed integrity when that
identity is available, and joins core originals with the locally authenticated active overrides.
A digest computed from an untrusted file alone does
not establish a publisher or release identity; obtain it from the approved release attestation.
The command does not query a floating package tag, install anything, or modify the checkout.

Review the reported versions, integrity, and every affected override. Upgrade the dependency
through the repository's lockfile workflow, then run
the reported sequence: `cockpit sync --config <path> --dry-run`, `cockpit sync --config <path>`,
and `cockpit preflight --config <path>`, using the quoted configuration path in the plan, in a
terminal outside the agent: until `sync` runs, the guard holds every agent tool call, because it
trusts only the cockpit it was generated for. Then commit the regenerated files. Do not
accept a changed override original until its replacement has been reviewed against the new
core bytes.

## Implementation and verification routes

All owners below are under `packages/cockpit/src/`. Thin command adapters bind these owners
through `packages/cockpit/src/cli.ts`; all process dispatch crosses
[the sole executor](../packages/cockpit/src/environment-exec/execute.ts).

| Responsibility | Owner | Focused test file |
|---|---|---|
| Generator admission and deterministic passes | [surfaces/generator-adapter.ts](../packages/cockpit/src/surfaces/generator-adapter.ts) | `packages/cockpit/src/surfaces/generator-adapter.test.ts` |
| Combined core/plugin dispatch and worker recovery | [surfaces/generator-adapter.ts](../packages/cockpit/src/surfaces/generator-adapter.ts) | `packages/cockpit/src/surfaces/generator-estate.test.ts` |
| Final surface rendering | [surfaces/render.ts](../packages/cockpit/src/surfaces/render.ts) | `packages/cockpit/src/surfaces/render.test.ts` |
| Overlay merge | [surfaces/merge.ts](../packages/cockpit/src/surfaces/merge.ts) | `packages/cockpit/src/surfaces/merge.test.ts` |
| MCP collection and approval | [surfaces/mcp.ts](../packages/cockpit/src/surfaces/mcp.ts) | `packages/cockpit/src/surfaces/mcp.test.ts` |
| Guard expansion | [surfaces/restrictions.ts](../packages/cockpit/src/surfaces/restrictions.ts) | `packages/cockpit/src/surfaces/restrictions.test.ts` |
| Sibling guides and grants | [surfaces/projection.ts](../packages/cockpit/src/surfaces/projection.ts) | `packages/cockpit/src/surfaces/projection.test.ts` |
| Skills | [surfaces/skill-contract.ts](../packages/cockpit/src/surfaces/skill-contract.ts) | `packages/cockpit/src/surfaces/skill-contract.test.ts` |
| Owned regions, changes and drift | [surfaces/ownership.ts](../packages/cockpit/src/surfaces/ownership.ts), [surfaces/sync.ts](../packages/cockpit/src/surfaces/sync.ts), [surfaces/check.ts](../packages/cockpit/src/surfaces/check.ts) | `packages/cockpit/src/surfaces/ownership.test.ts`, `packages/cockpit/src/surfaces/sync.test.ts`, `packages/cockpit/src/surfaces/check.test.ts` |
| Publication input authentication | [environment/generated-application.ts](../packages/cockpit/src/environment/generated-application.ts) | `packages/cockpit/src/generated-environment/command.authentication.test.ts` |
| Durable manifest and publication | [environment/generated-application.ts](../packages/cockpit/src/environment/generated-application.ts) | `packages/cockpit/src/generated-environment/command.publication-bounds.test.ts`, `packages/cockpit/src/generated-environment/command.publication-core.test.ts`, `packages/cockpit/src/generated-environment/command.publication-custom.test.ts`, `packages/cockpit/src/generated-environment/command.publication-native.test.ts` |
| Repair and recovery | [environment/generated-application.ts](../packages/cockpit/src/environment/generated-application.ts) | `packages/cockpit/src/generated-environment/command.test.ts` |
| Selftest evidence | [surfaces/selftest.ts](../packages/cockpit/src/surfaces/selftest.ts), [environment/selftest-application.ts](../packages/cockpit/src/environment/selftest-application.ts) | `packages/cockpit/src/selftest/command.configured-artifact.test.ts`, `packages/cockpit/src/selftest/command.native-execution.test.ts`, `packages/cockpit/src/selftest/command.custom-operator.test.ts` |
| Operator approval | [environment/operator-application.ts](../packages/cockpit/src/environment/operator-application.ts) | `packages/cockpit/src/environment/operator-application.test.ts` |
| Configured upgrade evidence | [environment/upgrade-application.ts](../packages/cockpit/src/environment/upgrade-application.ts) | `packages/cockpit/src/upgrade/command.test.ts` |

From this repository, run `npm test -- packages/cockpit/src/<test-file>`
with the listed file. [Troubleshooting](troubleshooting.md#focused-harness-verification) maps
failure families to exact commands, including a bounded publication-recovery regression.
Repository tests verify source behavior; they do not substitute for native selftest evidence.
