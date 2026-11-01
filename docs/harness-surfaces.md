# Harness surfaces

<!-- cockpit:verified version=0.0.0 -->

This page explains what `cockpit sync` writes for Claude Code, Codex CLI, OpenCode, Cursor, and
Grok Build, how product-specific additions enter, and how far each generated feature has been
confirmed to work. It is for people reviewing generated agent configuration and for integrators
extending it. Maintainers find the modules and tests behind it in the contributor page
`docs/contributing/testing.md`.

## Publish and verify

[Surfaces](concepts.md#surface) are published by the same `sync` and checked by the same `check`
as the rest of the generated environment; follow
[Bring the product up](getting-started.md#bring-the-product-up). `check` reports
[drift](concepts.md#drift) and never repairs output.

The repository action at `.github/actions/cockpit-check/action.yml` runs only `cockpit check`.
The caller must install the exact cockpit version from its lockfile first; the action does not
download cockpit or invoke a second generator check.

## Ownership and extension

Cockpit owns each generated entry either as a whole file or as a marked region inside a shared
file. The ownership manifest records the expected type, bytes, and sources. Its digest catches
accidental changes but does not prove who wrote a file in the past. A dry run lists the stale
entries cockpit would remove, with a digest of that list. Removing them needs your separate
approval of those exact paths and bytes: plain `sync` refuses, and `sync --interactive` shows the
entries and digest and asks you to type the digest before it re-checks and applies. A stale path
whose contents changed stays a conflict for you to resolve. A team's existing
`.claude/settings.json`, `.codex/config.toml` or `.codex/hooks.json` is not overwritten:
[adopt it](adoption.md#adopt-existing-agent-settings) and cockpit renders a merge of the team's copy
and its own output.

Common root instructions are written once, in the region of **AGENTS.md** that cockpit owns.
Claude's region contains only `@AGENTS.md`. When a team's existing **CLAUDE.md** already has that
exact import, cockpit leaves the file alone; removing the import makes `check` report drift. A
person approves changes to which file imports which and runs `sync`, because that decides what every
agent session loads.

Core declarations and `[surfaces].overlays` merge by name. An overlay that reuses a core name
must set `replaces` to the core name and the recorded SHA-256 of that original. An overlay cannot
replace `permissions` or `mcp`; those stay with cockpit's core declarations. When a later cockpit
version changes an original you overrode, `OVERRIDDEN_CORE_CHANGED` names the overlay before you
accept new output. `doctor` lists active overrides and changed originals from a read-only
generation preview, and says so when the preview cannot run.
Markdown frontmatter you write must use plain `---` YAML delimiters (no language tag) and valid YAML
of reasonable size. Cockpit rejects anything else before it runs the generator.
For the full list of supported extension points and the build-beside pattern, see
[Extending cockpit](extending.md); this page covers only generated surface behavior.

The generator uses a checked-in, SHA-pinned bundle of Rulesync only to spell the output for each
harness. Packaging verifies the bundle against its source and includes its third-party notices,
and cockpit checks the bundle's bytes before loading it. Cockpit itself handles declaration merging,
restriction policy, MCP approval, sibling guide links, capability state, the list of output files,
ownership, and publication. It accepts a generator result only when the files the generator
reports match the files read back from its isolated output directory.

Setting `[surfaces].bundles = ["claudecode-plugin"]` also publishes the generated Claude plugin
bundle directory at **.cockpit/bundles/claudecode-plugin/**. It contains a manifest and the
generated skills, subagents, hooks, and MCP declaration that apply. These files use the same
ownership and drift check as other surfaces. A file in that directory that cockpit does not own is
left alone. Writing the bundle does not show that Claude loaded it; that needs a run in Claude Code.

## Capability states

Each feature (rules, MCP servers, subagents, skills, hooks, permissions) has one of four states
per harness. The same words are defined in
[Concepts](concepts.md#enforced-instructed-generated-and-unavailable).

- `enforced`: the harness has a mechanism that can refuse the forbidden operation, and a dated
  test with a deliberately broken control has confirmed it.
- `instructed`: cockpit writes guidance or a harness setting, but nobody has confirmed that the
  harness obeys it.
- `generated`: cockpit writes the file for a harness that has no guard adapter or loading test,
  so nobody has verified that the tool even loads it.
- `unavailable`: cockpit writes nothing for this feature and records why the harness cannot
  provide it.

Native spellings differ per harness, and generating a file never upgrades a state: a feature moves
to `enforced` only after a test of the real tool says so.

The shared guard is generated only for harnesses that have a checked-in guard adapter (Claude Code,
Codex and OpenCode). The guard scripts deny, and fail closed, whenever a harness runs them. Whether
each harness actually runs them on a tool call is recorded per harness in the
[capability matrix](capability-matrix.md), from a dated run of the real tool on 2026-11-01:

- OpenCode 1.19.4 is `enforced`: its plugin refused `git push` to a protected branch and a native
  read of a secrets file, while a read of an unprotected file stayed allowed.
- Codex 0.165.0 is `enforced` only after a person trusts the hook on that machine (evidence
  `human_needed`). Codex silently skips a project hook nobody has trusted, so the same push ran
  until the hook was trusted. See [Trust the Codex hook](#trust-the-codex-hook).
- Claude Code 2.1.316 is `enforced`: its generated hook refused `git push` to a protected branch
  while `git status` stayed allowed, and in an identical copy without the hook the same push ran.
  Claude's own Read, Grep and Glob tools never reach the hook; the generated `Read` deny rules in
  `.claude/settings.json` keep them off secrets (see
  [Safety and autonomy](safety-and-autonomy.md#cockpit-commands-an-agent-can-run)).

### Trust the Codex hook

Codex runs the guard from `.codex/hooks.json` only after a person on that machine has trusted it,
and it skips an untrusted hook without saying so: every tool call then runs unguarded. Trust is
recorded per user in Codex's own configuration (`~/.codex/config.toml`, or `$CODEX_HOME`), keyed by
the hook's path and a hash of its command, so it is needed once per machine and again whenever
`sync` changes the hook. An agent cannot give it; a person does, once:

```sh
codex -C <cockpit root>
```

Start the interactive CLI (not `codex exec`) in the cockpit root, trust the folder if Codex asks,
and choose **Trust all and continue** when Codex shows **Hooks need review**; the `/hooks` view
inside a session does the same per hook. `cockpit doctor` and `cockpit check` read Codex's
configuration without changing it and report `CODEX_HOOK_UNTRUSTED` until every generated hook is
trusted, or when they cannot verify it.

### OpenCode native reads

OpenCode's native `read`, `grep` and `glob` tools never reach a shell, so the generated plugin
restates each as the shell command that reads at least the same paths (`cat`, a recursive `grep`,
and `ls`) and asks the guard about that. A refusal names the restated command, so an agent can
narrow a search that would cover a secrets directory or a declared instance. The generated
`opencode.jsonc` also denies OpenCode's `read` permission for every `.secrets` directory and each
declared instance, which holds even if the plugin does not load. It carries the `$schema` member
OpenCode would otherwise insert at every start, which made later checks report
`SURFACE_STATE_CONFLICT`.

Cursor and Grok Build are `generated`. Cockpit writes rules, skills, subagents, hooks, MCP and
permission files for them (`rulesyncFeatures` in
[the harness registry](../packages/cockpit/src/surfaces/harness-registry.ts)), but nobody has
verified that either tool loads those files. Cockpit installs no guard hook for them, so their
guard-firing cells in the [capability matrix](capability-matrix.md) are `unavailable`.

A custom harness must declare exactly one row for every feature. Each row that is not
`unavailable` names a test date, the output spelling, a deliberately broken control, and the
module export that produces it. Custom modules must be self-contained: cockpit imports the module
only if its bytes match the declaration, and refuses relative imports of other files. The module
runs in a worker that can write only to its own temporary directory and cannot start child
processes, worker threads, or native addons. If the installed Node.js cannot restrict filesystem
access, cockpit refuses to run it. These limits restrict ordinary file writes; they are not a
sandbox against malicious code. Cockpit checks the module's source and its result, so declaring a
capability without a recorded test result is not enough. For a custom row declared `enforced`,
cockpit also requires the named evidence file to match its declared SHA-256 before it runs the
module, and checks it again before publishing. That ties the declaration to one specific file;
confirming real enforcement still needs a separate paired test of the tool.

### Guard adapters

The [capability matrix](capability-matrix.md) is the one record of each built-in harness's state;
it is generated from the shipped sources. The checked-in guard adapters (the
[Claude](../packages/cockpit/surfaces/guards/claude.adapter.json),
[Codex](../packages/cockpit/surfaces/guards/codex.adapter.json) and
[OpenCode](../packages/cockpit/surfaces/guards/opencode.adapter.json) adapters) record how the
guard talks to each harness, tested on an older version. The matrix also records when each
harness was last probed and at which version. Those versions say nothing about the version you
have installed.

[Restriction expansion](../packages/cockpit/src/surfaces/restrictions.ts) checks the adapter's
recorded details but still emits `instructed` with a `pending_evidence` status, including
native read-only settings; a dated run of the real tool recorded in
[the harness registry](../packages/cockpit/src/surfaces/harness-registry.ts) is what the matrix
shows instead. A harness without an adapter gets no control and is recorded as
`unavailable`/`not_applicable`. Codex and OpenCode have no prompt tier, so "ask" decisions become
denials. [Rendering](../packages/cockpit/src/surfaces/render.ts) keeps those states, and
[selftest planning](../packages/cockpit/src/surfaces/selftest.ts) works out which
instruction-loading, guard-firing and per-skill tests to run for a given candidate. Use the
[selftest procedure](#skills-and-selftest-evidence) to test that candidate beside broken controls.
An old adapter record never upgrades a current cell.

## MCP servers and restrictions

`[mcp].approved` is the shared allowlist. A declared server absent from it is rendered disabled
for every configured harness and reports `MCP_NOT_APPROVED`. A name on the allowlist without a
declaration reports `MCP_APPROVAL_UNKNOWN`. Cockpit rejects conflicting commands for one server,
credential-like arguments, environment values that are not same-name references, and working
directories outside the declared sibling. Generated wrappers start with an empty environment
and pass only the declared environment names.

Browser transport is published only for harnesses that can use it. A harness with no applicable
MCP server receives no MCP-only output; its instructions, skills and permissions still publish.
This keeps browser access scoped without blocking the rest of the harness estate. Run
`./node_modules/.bin/cockpit sync --config cockpit.toml`, then
`./node_modules/.bin/cockpit check --config cockpit.toml --json` to verify
the generated estate.

Restriction policy comes from `[guards]`. Cockpit expands one shared guard through a tested
adapter for each harness. A harness event with no adapter stays unavailable. Codex has no
prompt tier, so policy configured as ask for Codex is rendered as deny rather than allowed.
Read-only subagent support is reported on its own because an instruction-only restriction is
weaker than a native tool restriction.

## Sibling projection and standing cost

Cockpit reads each sibling's guide from its declared root, records a digest of its content, and
links it into the generated root instructions through confined symlinks. It refuses a link if the
guide changes between reading and planning, escapes its root, conflicts with the mount or directory
grant, or would replace a link cockpit does not own. The generated state records both the link
target and a digest of the source content.

Codex sibling grants are `sandbox_workspace_write.writable_roots` entries that cockpit writes under
`sandbox_mode = "workspace-write"`. Cockpit keeps them relative to the checkout so clones do not
drift, and emits no competing permission profile because Codex would ignore it when the
workspace-write settings are present. This is generated configuration with `pending_evidence`, not a
claim that Codex enforces it; run the paired [capability procedure](#skills-and-selftest-evidence)
before promoting that matrix cell.

The `[cockpit].guide_cap` limit applies to always-loaded guidance. Cockpit reports the line cost per
harness only when it has a dated test of how that harness loads guidance. When a harness loads every
rule regardless of scope, scoped text still counts toward that total. A harness with no such test is
`unavailable`, not zero.

## Skills and selftest evidence

Shipped skills have small entry points and shared procedures. Each skill declares its trigger,
the equivalent tool name in each harness, the cockpit commands it may run, what it changes, what it
must not do, its review requirements, and a line cap. The renderer refuses embedded decision logic,
undeclared commands, missing tool equivalents, missing procedures, duplicate names, and skills that
exceed the always-loaded size limit. Codex also receives its generated skill sidecar.

`selftest` reads a probe-specification file that is tied to both the current source digest and the
generated manifest:

```sh
./node_modules/.bin/cockpit selftest --interactive \
  --config ./cockpit.toml \
  --probe-specifications ./.cockpit/probe-specifications.json
```

For built-in harnesses, it runs each candidate beside a deliberately broken control and captures
version, help, candidate, and broken-control events. The configured command first runs the read-only generated
environment check and refuses a file that is missing, malformed, stale, or does not match the
current source and manifest.
Interactive mode requires a terminal. Before it runs any command from the file, it shows the
file's canonical path, its whole-file SHA-256, the source and manifest digests it is tied to, and
each exact invocation, version, and help command. You type that file digest, then approve
each executable by its displayed absolute path and SHA-256. It is unavailable in CI and
JSON mode.
Custom cells stay `human_needed` until you approve an exact probe.
A passing check of a custom module does not approve a worker command that cockpit built.
Without that approval, or when cockpit cannot isolate the process, the cell stays
`human_needed`. Claude Code and Codex skill reviews also stay
`human_needed` until the required official-authoring or native-diagnostics results are attached.
Repository tests and generated records do not promote those native or human rows.

Cockpit limits the size of legacy adapter records, command vectors and captured output before it
parses them. The [validator](../packages/cockpit/libexec/validate-harness-evidence.mjs) holds the
current limits. It refuses changed files and files that are not regular. These records keep their
original capability strength; passing the validator does not promote a native capability.

## Review an upgrade

`upgrade` is a read-only plan. Without release evidence it fails with
`UPGRADE_VERSION_AMBIGUOUS`. To inspect a candidate, pass an exact release-evidence file and
its SHA-256, obtained separately, with `--release-evidence` and
`--release-evidence-sha256`. Cockpit checks the file's bytes before parsing, then compares its
package name and version with the installed cockpit package and requires a strictly newer
candidate version. It reports the release's integrity value, checks the installed integrity when
that is available, and lists the originals that your active overrides replace.
A digest computed from an untrusted file alone does
not show who published the release; take it from the approved release attestation.
The command does not query a floating package tag, install anything, or modify the checkout.

Review the reported versions, integrity, and every affected override. Upgrade the dependency
through the repository's lockfile workflow, then run
the reported sequence: `cockpit sync --config <path> --dry-run`, `cockpit sync --config <path>`,
and `cockpit preflight --config <path>`, using the quoted configuration path in the plan, in a
terminal outside the agent: until `sync` runs, the guard holds every agent tool call, because it
trusts only the cockpit it was generated for. Then commit the regenerated files. Do not
accept a changed override original until its replacement has been reviewed against the new
core bytes.
