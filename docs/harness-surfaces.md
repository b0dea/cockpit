# Harness surfaces

<!-- cockpit:verified version=0.0.0 -->

This page is for people reviewing the agent configuration `cockpit sync` generates, and for
integrators extending it. It covers what cockpit writes for each supported agent tool (Claude Code,
Codex CLI, OpenCode, Cursor and Grok Build), how product-specific additions enter, and how far
each generated feature is confirmed to work. Maintainers find the modules and tests behind it in
the contributor page `docs/contributing/testing.md`.

## Publish and verify

[Surfaces](concepts.md#surface) are published by the same `sync` and checked by the same `check`
as the rest of the generated environment; follow
[Bring the product up](getting-started.md#bring-the-product-up). `check` reports
[drift](concepts.md#drift) and never repairs output.

The repository action at `.github/actions/cockpit-check/action.yml` runs only `cockpit check`.
Install the exact cockpit version from your lockfile before calling it; the action does not
download cockpit.

## Ownership and extension

Cockpit owns each generated entry either as a whole file or as a marked region inside a shared
file. The ownership manifest records the expected type, bytes and sources. Its digest catches
accidental changes; it does not prove who wrote a file in the past.

Removing a stale entry needs your separate approval of those exact paths and bytes: plain `sync`
refuses, and `sync --interactive` asks you to type the digest the dry run showed. A stale path whose
contents changed stays a conflict for you to resolve; [Check and sync](environment.md#check-and-sync)
has the full procedure.

A team's existing `.claude/settings.json`, `.codex/config.toml` or `.codex/hooks.json` is not
overwritten: [adopt it](adoption.md#adopt-existing-agent-settings) and cockpit renders a merge of
the team's copy and its own output.

Common root instructions are written once, in the region of **AGENTS.md** that cockpit owns.
Claude's region contains only `@AGENTS.md`. When a team's existing **CLAUDE.md** already has that
exact import, cockpit leaves the file alone; removing the import makes `check` report drift.
Because which file imports which decides what every agent session loads, a person approves those
changes and runs `sync`.

Core declarations and `[surfaces].overlays` merge by name. An overlay that reuses a core name must
set `replaces` to that name and the recorded SHA-256 of the original. An overlay cannot replace
`permissions` or `mcp`. When a later cockpit version changes an original you overrode,
`OVERRIDDEN_CORE_CHANGED` names the overlay and the current digest, and `sync` and `check` refuse
until you review the new original and update `replaces.sha256`. `sync --dry-run` and `doctor` list
active overrides and changed originals from a read-only generation preview, and `doctor` says so
when the preview cannot run. Markdown frontmatter you write must use plain `---` YAML delimiters
(no language tag) and valid YAML of reasonable size; anything else is rejected before the generator
runs. A rules overlay is written into the instruction file every harness loads at start, so Rulesync
frontmatter such as `root: false` is accepted, but one that narrows itself with `globs` is refused
as `SURFACE_RULE_SCOPE_UNSUPPORTED`.
[Extending cockpit](extending.md) lists every extension point and the build-beside pattern.

The generator uses a checked-in, SHA-pinned bundle of Rulesync only to spell the output for each
harness. Packaging verifies the bundle against its source and includes its third-party notices,
and cockpit checks the bundle's bytes before loading it. Cockpit itself handles declaration
merging, restriction policy, MCP approval, sibling guide links, capability state, the output file
list, ownership and publication. It accepts a generator result only when the files the generator
reports match the files read back from its isolated output directory.

Setting `[surfaces].bundles = ["claudecode-plugin"]` also publishes a Claude plugin bundle at
**.cockpit/bundles/claudecode-plugin/**: a manifest plus the generated skills (with the references
they tell the agent to read), subagents, overlay hooks and MCP declaration that apply. It does not
carry the guard hook, which reads the cockpit checkout and stays in the checkout's own
`.claude/settings.json`. These files share the ownership and drift check of other surfaces, and
a file in that directory that cockpit does not own is left alone. Writing the bundle does not show
that Claude loaded it; that needs a run in Claude Code.

## Capability states

Each feature (rules, MCP servers, subagents, skills, hooks, permissions) has one of four states
per harness:

- `enforced`: the harness has a mechanism that can refuse the forbidden operation, and a dated
  test with a deliberately broken control has confirmed it.
- `instructed`: cockpit writes guidance or a harness setting, but nothing makes the agent follow
  it.
- `generated`: cockpit writes the file for a harness that has no guard adapter or loading test,
  so nobody has verified that the tool even loads it.
- `unavailable`: cockpit writes nothing for this feature and records why the harness cannot
  provide it.

Native spellings differ per harness, and generating a file never upgrades a state: a feature moves
to `enforced` only after a dated run of the real tool says so.

The shared guard is generated only for harnesses with a checked-in guard adapter: Claude Code,
Codex and OpenCode. The guard scripts deny, and fail closed, whenever a harness runs them. Whether a
harness actually runs them on a tool call was established by a run of the real tool, recorded with
its date and version in the [capability matrix](capability-matrix.md):

- OpenCode is `enforced`: its plugin refused `git push` to a protected branch and a native read of
  a secrets file, while a read of an unprotected file stayed allowed.
- Codex is `enforced` only after a person trusts the hook on that machine. Codex silently skips a project hook nobody has trusted, so the same push ran
  until the hook was trusted. See [Trust the Codex hook](#trust-the-codex-hook).
- Claude Code is `enforced`: its generated hook refused `git push` to a protected branch while
  `git status` stayed allowed, and in an identical copy without the hook the same push ran.
  Claude's own Read, Grep and Glob tools never reach the hook; the generated `Read` deny rules in
  `.claude/settings.json` keep them off secrets (see
  [Reading secrets and instances](safety-and-autonomy.md#reading-secrets-and-instances)).

Cursor and Grok Build are `generated`. Cockpit writes rules, skills, subagents, hooks, MCP and
permission files for them (`rulesyncFeatures` in
[the harness registry](../packages/cockpit/src/surfaces/harness-registry.ts)), but nobody has
verified that either tool loads those files. Cockpit installs no guard hook for them, so their
guard-firing cells are `unavailable`.

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

### Custom harnesses

A custom harness must declare exactly one row for every feature. Each row that is not
`unavailable` names a test date, the output spelling, a deliberately broken control, and the
module export that produces it. Cockpit checks the module's source and its result, so declaring a
capability without a recorded test result is not enough. For a row declared `enforced`, cockpit
also requires the named evidence file to match its declared SHA-256 before it runs the module, and
checks it again before publishing. That ties the declaration to one file; confirming real
enforcement still needs a separate paired test of the tool.

Custom modules must be self-contained: cockpit imports a module only if its bytes match the
declaration, and refuses relative imports of other files. The module runs in a worker that can
write only to its own temporary directory and cannot start child processes, worker threads or
native addons; if the installed Node.js cannot restrict filesystem access, cockpit refuses to run
it. These limits restrict ordinary file writes; they are not a sandbox against malicious code.

### Guard adapters

The [capability matrix](capability-matrix.md) is the one record of each built-in harness's state,
generated from the shipped sources, with the date and tool version of every measurement. Those versions say nothing about the version you have installed. The checked-in guard
adapters (the [Claude](../packages/cockpit/surfaces/guards/claude.adapter.json),
[Codex](../packages/cockpit/surfaces/guards/codex.adapter.json) and
[OpenCode](../packages/cockpit/surfaces/guards/opencode.adapter.json) adapters) record how the
guard talks to each harness, as tested on an older version.

[Restriction expansion](../packages/cockpit/src/surfaces/restrictions.ts) checks the adapter's
recorded details but still emits `instructed`, including for native read-only settings; only a
dated run of the real tool, recorded in
[the harness registry](../packages/cockpit/src/surfaces/harness-registry.ts), changes a matrix
state. A harness without an adapter gets no control and is recorded as `unavailable`. Codex and OpenCode have no prompt tier, so "ask" decisions become denials; see
[Native adapter behavior](safety-and-autonomy.md#native-adapter-behavior).
[Rendering](../packages/cockpit/src/surfaces/render.ts) keeps those states, and
[selftest planning](../packages/cockpit/src/surfaces/selftest.ts) works out which
instruction-loading, guard-firing and per-skill tests to run for a candidate; run them with the
[selftest procedure](#skills-and-selftest-evidence). An old adapter record never upgrades a current
cell.

## MCP servers and restrictions

`[mcp].approved` is the shared allowlist. A declared server absent from it is rendered disabled
for every configured harness (for Claude Code through `disabledMcpjsonServers`, because it ignores
`disabled` in `.mcp.json`), and `sync` and `check` report `MCP_NOT_APPROVED`. A name on the allowlist without a
declaration reports `MCP_APPROVAL_UNKNOWN`. Cockpit rejects conflicting commands for one server,
credential-like arguments, environment values that are not same-name references, and working
directories outside the declared sibling. Each harness starts the generated wrapper as
`.cockpit/mcp/<id>.sh` relative to the directory the agent was launched in, and the wrapper finds
its sibling from its own location, so the committed files are the same in every clone; start the
agent in the cockpit root, as the guard hooks already require. Wrappers start with an empty
environment and pass `PATH`, the same non-secret variables product test stages receive (`HOME`,
`USER`, `LOGNAME`, `TMPDIR`, `LANG`, `LC_ALL`, `LC_CTYPE`, `TZ`) and the declared environment
names.

Browser transport is published only for harnesses that can use it. A harness with no applicable
MCP server receives no MCP-only output; its instructions, skills and permissions still publish.
Verify the result with `./node_modules/.bin/cockpit check --config cockpit.toml --json` after
`sync`.

Restriction policy comes from `[guards]`: cockpit expands one shared guard through a tested adapter
for each harness, and a harness event with no adapter stays `unavailable`. Read-only subagent
support is reported on its own, because an instruction-only restriction is weaker than a native
tool restriction.

## Sibling projection and standing cost

Cockpit reads each sibling's guide from its declared root and links it into the generated root
instructions through confined symlinks. It refuses a link if the guide changes between reading and
planning within one `sync`, escapes its root, conflicts with the mount or directory grant, or would
replace a link cockpit does not own. The guide belongs to the sibling team: the ownership manifest
records only the sibling and the guide's path inside it, so an edit, checkout or clone leaves the
link current, while a link replaced by a file or pointed elsewhere is still refused.

Codex sibling grants are `sandbox_workspace_write.writable_roots` entries under
`sandbox_mode = "workspace-write"`. Codex resolves a relative root from `.codex/`, so cockpit writes
each one relative to that directory (`../../api` for a sibling at `../api`) and clones do not
drift, and emits no competing permission profile, because Codex ignores one when the
workspace-write settings are present. This is generated configuration, not a measured claim that
Codex enforces it; run the [selftest procedure](#skills-and-selftest-evidence) before
promoting that matrix cell.

OpenCode matches `external_directory` against absolute paths only and has no token for the
project root, so the committed pattern is `{file:.cockpit/local/opencode-grant-<slug>}/**`: OpenCode
substitutes the absolute sibling directory that `sync` writes to that machine-local, ignored file,
and refuses to start, naming the file, until `sync` has run on the machine.

The `[cockpit].guide_cap` limit applies to always-loaded guidance, linked sibling guides included;
going over it makes `sync`, `check` and `preflight` report `GUIDE_CAP_EXCEEDED` with the measured
lines and the cap. Cockpit reports the line cost per
harness only when it has a dated test of how that harness loads guidance; without one the cost is
`unavailable`, not zero. When a harness loads every rule regardless of scope, scoped text still
counts toward the total.

## Skills and selftest evidence

Shipped skills have small entry points and shared procedures. Each skill declares its trigger,
the equivalent tool name in each harness, the cockpit commands it may run, what it changes, what it
must not do, its review requirements and a line cap. The renderer refuses embedded decision logic,
undeclared commands, missing tool equivalents, missing procedures, duplicate names, and skills over
the always-loaded size limit. Codex also receives its generated skill sidecar.

`selftest` runs each tool against a probe-specification file: one row per built-in tool cell the
generated manifest expects evidence for (each built-in tool's instruction loading, guard firing and
the parity of each shipped skill). The file is tied to the current `cockpit.toml` digest and
generated manifest, so it goes stale whenever either changes.

A custom harness cell gets no row. `selftest` runs only a tool it found on `PATH` and you approved
by digest, and a custom harness has no such executable, so a row for it could only be ignored.
Writing the file warns `SELFTEST_CUSTOM_PROBE_UNSUPPORTED` for each such cell, `selftest` records
it `human_needed` with `enforcement_probe_required`, and a custom row added by hand is refused.
Measure a custom capability yourself and record it as its `state` and `measured_on`.

1. After `sync`, write the file to a new path. It refuses a path that already exists, so a file you
   have filled in is never overwritten:

   ```sh
   npx --no cockpit selftest --config ./cockpit.toml \
     --write-probe-specifications ./.cockpit/local/probe-specifications.json
   ```

   It prints which rows it wrote and where each value came from. The generated manifest decides
   `harness`, `capability`, the skill in `sample` and `unavailableCode`. cockpit fills
   `versionCommand` and `helpCommand` with the tool's `--version` and `--help`.

   After a change to `cockpit.toml` or the generated manifest, your filled file is stale. Write
   the new file from it so the probes you wrote are kept:

   ```sh
   npx --no cockpit selftest --config ./cockpit.toml \
     --write-probe-specifications ./.cockpit/local/probe-specifications-2.json \
     --probe-specifications ./.cockpit/local/probe-specifications.json
   ```

   Each complete row whose cell still exists is copied as it was, and the output says how many.
   Rows for new or changed cells, and rows you left partly `null`, start over with `null`s.
2. Replace every `null` in the file. Nothing in the manifest says how a given tool version can be
   made to load a control file and report what it did, so these values come from you:
   - `invocation`: the arguments, starting with `{executable}` like `versionCommand`, with
     exactly one `{control}`. cockpit
     replaces `{control}` with the path of a control file it writes under `.cockpit/local/probes/`:
     the generated file under test, or a deliberately broken copy.
   - `candidateCode` and `brokenCode`: codes you choose (capital letters, digits and underscores,
     starting with a letter) that the tool prints as a line of their own. With the broken control it must
     exit non-zero and print `brokenCode`. With the candidate it must exit 0 and print
     `candidateCode` (instructed), or, for guard firing, exit non-zero and print it (enforced), or
     print `unavailableCode` (unavailable). Any other result refuses the whole run.
   - `sample.features` on skill-parity rows: which of `name`, `trigger`, `body-load`, `tools` and
     `non-goals` your invocation exercises.

   `selftest` refuses a file that still has a `null` and lists the rows.
3. In a terminal outside CI, outside an agent session, run:

   ```sh
   npx --no cockpit selftest --interactive --config ./cockpit.toml \
     --probe-specifications ./.cockpit/local/probe-specifications.json
   ```

   It first runs the read-only generated environment check and refuses a file that is missing,
   malformed, stale, or does not match the current source and manifest. It then shows the file's
   canonical path, its SHA-256, the source and manifest digests it is tied to, and each exact
   invocation, version and help command. Compare the SHA-256 with `shasum -a 256 <file>` and type
   it at the prompt. For each tool it then shows the absolute path and SHA-256 of the executable it
   found on `PATH`; type that SHA-256 to let it run. Anything else leaves that cell `human_needed`
   and it asks again at the tool's next cell. Approval lasts only for that run. Without `--interactive`, or in CI or JSON
   mode, nothing in the file runs.

For each approved built-in tool, `selftest` runs the version and help commands, then the invocation
with the broken control and with the candidate, and records each event. The probes inherit only
`PATH`, `HOME`, `USER`, `LOGNAME`, `TMPDIR`, `LANG`, `LC_ALL`, `LC_CTYPE` and `TZ`, so a tool that
keeps its sign-in under `HOME` finds it. No other variable reaches the probe, so a tool signed in
only through an environment token reports that it is not signed in; that cell stays `human_needed`
with `authentication_required`.

Some cells stay `human_needed` regardless:

- a custom harness cell, which has no probe row (see above);
- Claude Code and Codex skill reviews, until the official-authoring or native-diagnostics results
  are attached.

Repository tests and generated records do not promote those native or human rows.

Cockpit limits the size of legacy adapter records, command vectors and captured output before
parsing them; the [validator](../packages/cockpit/libexec/validate-harness-evidence.mjs) holds the
current limits. It refuses changed files and files that are not regular. These records keep their
original capability strength; passing the validator does not promote a native capability.

## Review an upgrade

`upgrade` is a read-only plan: it does not query a floating package tag, install anything or
modify the checkout. Without release evidence it fails with `UPGRADE_VERSION_AMBIGUOUS`. To inspect
a candidate, pass an exact release-evidence file with `--release-evidence` and its separately
obtained SHA-256 with `--release-evidence-sha256`;
[Migration](release-policy.md#migration) shows how to get and pair both. Cockpit checks the file's
bytes before parsing, compares its package name and version with the installed package, and
requires a strictly newer candidate. It reports the release's integrity value, checks the installed
integrity when that is available, and lists the originals your active overrides replace. A digest
computed from an untrusted file alone does not show who published the release; take it from the
approved release attestation.

To apply the upgrade:

1. Review the reported versions, integrity and every affected override. Do not accept a changed
   override original until its replacement has been reviewed against the new core bytes.
2. Upgrade the dependency through the repository's lockfile workflow.
3. In a terminal outside the agent, run the reported sequence with the quoted configuration path
   from the plan: `cockpit sync --config <path> --dry-run`, `cockpit sync --config <path>`, then
   `cockpit preflight --config <path>`. Until `sync` runs, the guard holds every agent tool call,
   because it trusts only the cockpit it was generated for.
4. Commit the regenerated files.
