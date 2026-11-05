# Harness surfaces

This page is for people reviewing the agent configuration `cockpit sync` generates, and for
integrators extending it. It covers what cockpit writes for each supported agent tool (Claude Code,
Codex CLI, OpenCode, Cursor and Grok Build), how product-specific additions enter, and how far
each generated feature is confirmed to work. Maintainers find the modules and tests behind it in
the contributor page `docs/contributing/testing.md`.

## Publish and verify

[Surfaces](concepts.md#surface) are published by the same `sync` and checked by the same `check`
as the rest of the generated files; follow
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
overwritten: [adopt it](getting-started.md#adopt-existing-agent-settings) and cockpit renders a merge of
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
merging, restriction policy, MCP approval, sibling guide copies, capability state, the output file
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

Cursor and Grok Build are `generated`, and written only when `[surfaces] tools` lists them
(`npx --no cockpit tool add cursor --config <your cockpit.toml>`). Cockpit then writes rules,
skills, subagents, hooks, MCP and permission files for them (`rulesyncFeatures` in
[the harness registry](../packages/cockpit/src/surfaces/harness-registry.ts)), but nobody has
verified that either tool loads those files. Cockpit installs no guard hook for them, so their
guard-firing cells are `unavailable`.

### Choose the tools

`[surfaces] tools` lists the agent tools `sync` writes and `check` compares; it defaults to the
tools whose guard is measured, `claudecode`, `codexcli` and `opencode`, and must name at least one
of them. A tool the list leaves out gets no files, and doctor and check give no advice about it.
`npx --no cockpit tool add <tool> --config <your cockpit.toml>` and `tool remove` edit only that
line (add `--dry-run` to preview). The next `sync` writes an added tool from the same sources as the
others; the files of a removed tool are listed for removal and deleted only after a person approves
the stale-removal digest with `sync --interactive`.

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
trusted, or when they cannot verify it. They report it only once Codex has run on the machine (a
Codex home exists); before that, no Codex session can skip the hook.

### Session-start drift check

The generated `.claude/settings.json` and `.codex/hooks.json` also register a `SessionStart` hook that
runs `./node_modules/.bin/cockpit check --config cockpit.toml` in the cockpit root and prints the end of its report, so the
agent sees drift and the fix it names before it works; the *On drift* section of the cockpit-setup
procedure, which every shipped skill points to, says what to do with it. The hook never blocks a session. Codex runs it only once a person trusts it, like
the guard hook. OpenCode gets none: its plugins receive `session.created`, but no run has shown a plugin
putting text in the agent's context. The [capability matrix](capability-matrix.md) dates each
measurement.

### Run cockpit outside the Codex sandbox

The generated `.codex/config.toml` runs Codex in its `workspace-write` sandbox with the sibling
checkouts as extra writable roots. Inside that sandbox Codex keeps `.git`, `.agents` and `.codex`
read-only and blocks cockpit's per-user state root and the Docker socket, so only `cockpit check`,
`cockpit sync --dry-run` and `--help` work there. Measured on 2026-11-02 with Codex 0.166.0's
`codex sandbox` and its built-in workspace profile, which agreed with a Codex session under the
generated configuration: `doctor`, `preflight`, `logs` and `work status` could not read cockpit's
state and `test-run` reported `DEGRADED`, while outside the sandbox they reported the real state and
the gate passed.

Run every other cockpit command outside the sandbox: from a terminal, or by approving Codex's
request to run it unsandboxed. That covers `init`, `sync`, `up`, `down`, `test-run`, `work` and
`git commit` in the cockpit. A `codex exec` run cannot ask, so a person runs those commands.

cockpit grants nothing more on purpose. Docker socket access controls the whole machine, which
would defeat the sandbox. The state root differs by host and user (see
[Clear cockpit state](troubleshooting.md#clear-cockpit-state)), so no committed path fits every
clone, and Codex keeps `.git`, `.agents` and `.codex` read-only inside every writable root.

### Claude Code command rules

Claude Code's default mode runs no shell command without an allow rule, so a headless session was
refused even the `test-run` its own skill asks for. The generated `.claude/settings.json` therefore
allows, by prefix, the cockpit commands the shipped skills tell an agent to run and the guard
admits (see [Cockpit commands an agent can run](safety-and-autonomy.md#cockpit-commands-an-agent-can-run)),
spelled both as `npx --no cockpit <command>` and as `./node_modules/.bin/cockpit <command>`.
Commands that are always a person's, such as `init` and `sibling add`, have no rule and keep
prompting. A command the policy decides, such as `sync` or `work accept`, has a rule: the guard hook
still runs first, and its ask or deny wins over a rule. Claude Code ignores a project's allow rules
until a person has trusted the workspace by starting Claude Code there once. Measured with Claude
Code 2.1.316 on 2026-11-02 beside a command with no rule.

OpenCode allows shell commands unless configured otherwise, and Codex runs them inside its sandbox
without asking, so cockpit writes no command rules for either.

### OpenCode native reads

OpenCode's native `read`, `grep` and `glob` tools never reach a shell, so the generated plugin
restates each as the shell command that reads at least the same paths (`cat`, a recursive `grep`,
and `ls`) and asks the guard about that. A refusal names the restated command, so an agent can
narrow a search that would cover a secrets directory, a declared instance or an environment file
that is neither a declared template nor a documentation name such as `.env.example`. The generated
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

`[mcp.approved]` is the shared allowlist. It maps each approved server name to the sha256 of the
declaration a human reviewed: its command, arguments, working directory relative to the cockpit,
and environment names. The declaration lives in a sibling's file, which an agent can edit, so a
server whose declaration changed after approval is no longer approved. A declared server absent
from the list, or whose digest differs, is rendered disabled for every configured harness (for
Claude Code through `disabledMcpjsonServers`, because it ignores `disabled` in `.mcp.json`), and
`sync` and `check` report `MCP_NOT_APPROVED` with the current digest to approve. A name on the allowlist without a
declaration reports `MCP_APPROVAL_UNKNOWN`. Cockpit rejects conflicting commands for one server,
credential-like arguments, environment values that are not same-name references, and working
directories outside the declared sibling. Each harness starts the generated wrapper as
`.cockpit/mcp/<id>.sh` relative to the directory the agent was launched in, so it runs only when
the agent was started in the cockpit root, as the guard hooks already require. The wrapper changes
to its sibling by a path relative to that root, resolved physically and never through `CDPATH`, so
the committed files are the same in every clone. Wrappers start with an empty
environment and pass `PATH`, the same non-secret variables product test stages receive (`HOME`,
`USER`, `LOGNAME`, `TMPDIR`, `LANG`, `LC_ALL`, `LC_CTYPE`, `TZ`) and the declared environment
names.

For a local server whose helper has its own defaults, declare optional caller overrides by name:

```json
{ "mcpServers": {
  "local-reader": { "command": "bin/local-reader", "optionalEnv": ["LOCAL_PORT", "LOCAL_CONFIG_FILE"] }
} }
```

`optionalEnv` forwards a named variable only when it is set, preserving an explicitly empty value.
An absent variable stays absent, so the helper can use its default. Required variables remain in
`env`, with same-name references such as `"TOKEN": "${TOKEN}"`; a name cannot be both required and
optional. No other ambient variables are added. The approval digest includes optional names and
whether a variable is required, so changing this access needs a new declaration review. Doctor
reports missing required variables; an absent optional override is not a startup gap.

### Restrict a server's tools

Server approval permits a connection; it does not make the server read-only. Declare a positive
list of reviewed tool names in `cockpit.toml`, then run `sync`:

```toml
[mcp.allowed_tools]
reports = ["read_record", "search_records"]
```

Each name is exact. Every other tool from that server, including a newly added tool, is denied.
An empty list denies all tools; an absent server has no tool restriction. The server must be
declared, and overlapping native server namespaces are refused. Widening this list changes the
guard policy and requires the same approval as other increases in agent authority. Adding a
restriction or removing tools from a list narrows access and can be synced by an agent when
`[autonomy] sync = "agent"`. Removing a server's list makes it unrestricted and requires a person.

Codex receives `enabled_tools` in its generated server configuration. Claude Code receives an
authenticated `PreToolUse` guard scoped to the restricted server namespaces. It denies unlisted
tools and defers listed tools to Claude Code's existing permission rules; listing a tool grants no
native permission. Unrestricted servers and plugin tools do not pass through this MCP guard.
Start Claude Code from the cockpit checkout and trust the workspace so its project hooks load.
Write each name as the server publishes it. Claude Code rewrites a dot in a tool name to an
underscore before the guard sees it, and keeps only the first of two tools that collide. So under
Claude Code a listed `read_record` also admits a server tool named `read.record`; Codex matches the
raw name and keeps them apart. Check the server's tool list when it publishes dotted names.
These restrictions have their own dated row in the
[capability matrix](capability-matrix.md); Codex's native tool filter does not depend on hook trust.
Other harnesses omit restricted servers and report `MCP_TRANSPORT_UNAVAILABLE`: use Claude Code or
Codex for them. Restricted servers cannot currently be included in the Claude plugin bundle,
whose tool namespace has not been measured; remove that bundle from `[surfaces].bundles` to use
the checkout's guarded server.

Review what each allowed tool actually does. A name, a token scope or `readOnlyHint` is not an
enforcement boundary. A generic dispatcher such as `execute_tool` can expose writes through its
arguments; listing it permits all of those operations. Leave such a tool out unless every operation
it can dispatch is acceptable. Cockpit does not filter tool arguments or proxy server requests.
Claude's guard reads only tool metadata from a bounded native JSON envelope (at most 1 MiB); larger envelopes are refused. Shell
and file-edit inputs retain their separate, smaller bound.

This policy covers MCP **tool calls**, not resources, resource templates or prompts. It restricts
one declared server namespace, not every route to the service. With `[autonomy] mcp_approve = "agent"`,
an agent can register a new server or alias without that list, so this is not a read-only
sandbox against delegated approval. Use `mcp_approve = "person"` when new connections must require
human review, and review every approved process and route independently.

### Remote servers

A remote (streamable HTTP) server is declared in the same file, in Claude Code's spelling:

```json
{ "mcpServers": {
  "tracker": { "type": "http", "url": "https://mcp.example.test/mcp",
               "headers": { "Authorization": "Bearer ${TRACKER_TOKEN}" } },
  "docs": { "type": "http", "url": "https://docs.example.test/mcp", "headersHelper": "bin/mcp-headers docs" }
} }
```

The URL must use `https`, or `http` only to a loopback host, and may carry no user information,
credential-named query parameter or `${...}` reference. Each header value is exactly `${NAME}`, or
`Bearer ${NAME}` in `Authorization`; a literal is refused, so no credential enters a tracked file.
`headersHelper` is a command and plain arguments, relative to the sibling, that prints a JSON object
of headers when the tool connects; it runs without a shell, so quoting and expansion belong in the
script. SSE servers are refused because Codex cannot connect to them. The approval digest covers the
URL, the header references and the helper's command, arguments and directory, so changing any of
them needs a new approval. Like a local server's command, the helper script's content is not in the
digest.

| Tool | Header references | Headers helper |
| --- | --- | --- |
| Claude Code | `headers` in `.mcp.json`, expanded from its environment | `headersHelper` |
| Codex | `bearer_token_env_var` and `env_http_headers` in `.codex/config.toml` | `http_headers_helper` |
| OpenCode | `{env:NAME}` in the `headers` of a `remote` server | none: the server is not written |
| Cursor, Grok Build | not written | not written |

A tool that cannot carry a server's credential gets nothing for that server, rather than a server
that starts and fails to authenticate; `sync` and `check` report `MCP_TRANSPORT_UNAVAILABLE` with the
tools it was left out of. The [capability matrix](capability-matrix.md) records the run behind each
cell. Claude Code runs a `headersHelper` from the project `.mcp.json` only after a person trusts the
workspace; until then it connects without those headers.

A header reference resolves from the environment the agent tool was launched in, so a tool started
from a desktop launcher may not see a variable set in a shell profile. A helper reads the credential
when the tool connects instead, wherever it keeps it. The helper runs through a generated wrapper,
`.cockpit/mcp/<id>.headers.sh`, started from the cockpit root like a local server's wrapper: it
changes to the sibling and passes the same inherited variables, without the header names.

`doctor` checks each approved server without starting it or using the network: a local server's
command and a remote server's helper must resolve (`MCP_COMMAND_UNRESOLVED`), and every environment
name it reads must be set where doctor runs (`MCP_ENVIRONMENT_UNSET`). It names variables, never
values. A relative entry in the `PATH` doctor runs with stops it looking up a bare command, so
`MCP_COMMAND_UNRESOLVED` then names that entry and says whether the absolute entries hold the command.

Browser transport is published only for harnesses that can use it. A harness with no applicable
MCP server receives no MCP-only output; its instructions, skills and permissions still publish.
Verify the result with `./node_modules/.bin/cockpit check --config cockpit.toml --json` after
`sync`.

Restriction policy comes from `[guards]`: cockpit expands one shared guard through a tested adapter
for each harness, and a harness event with no adapter stays `unavailable`. Read-only subagent
support is reported on its own, because an instruction-only restriction is weaker than a native
tool restriction.

## Sibling projection and standing cost

Cockpit reads each sibling's guides (`sibling.guides`, by default **CLAUDE.md** and **AGENTS.md**)
from its declared root and copies them into its region of the root **AGENTS.md**, after its own
instructions. Every agent tool reads that file, Claude Code through the `@AGENTS.md` import in
**CLAUDE.md**, so each tool starts with the same sibling instructions. Copying is the one route that
loaded in Claude Code, Codex and OpenCode alike: a symlinked guide imported from **CLAUDE.md**, an
extra directory handed to Claude Code or Codex, and a line telling Codex to read the guide each
left Claude Code or Codex without it; the [capability matrix](capability-matrix.md) has the dated
runs. Each copy starts with a heading naming the sibling and a comment recording the guide and the
SHA-256 of the text copied. A copy leaves out the marked block `setup --write-instruction-pointers`
appended to the guide, and a **CLAUDE.md** line importing the sibling's own **AGENTS.md** when that
file is copied as well. Sync refuses a guide that changes while it is read, resolves outside its
root, or contains cockpit's own instruction region or owner markers.

A copy goes stale when the sibling's guide changes: `check` and `preflight` then report
`GENERATED_ARTIFACT_DRIFT` naming each out-of-date `<sibling>/<guide>`, and a person runs `sync` and
commits **AGENTS.md**. That is deliberate. An agent editing a sibling's guide cannot change what
every later agent session in the cockpit loads until a person has reviewed the new text, the same
review a change to **CLAUDE.md**'s imports gets. A Claude Code `@` import inside a copied guide
resolves from the cockpit root, not the sibling, and no other tool follows it, so keep shared
guides free of them.

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

A checkout `cockpit use` serves from outside the declared one needs a grant that names a path on one
machine, which no committed file can hold. Measured on 2026-11-04, each run writing into the granted
directory and into an ungranted control directory beside it:

- Claude Code 2.1.318, `claude -p --permission-mode acceptEdits`: a directory listed in
  `.claude/settings.local.json` `permissions.additionalDirectories` was written and the control was
  refused. A twin whose list was a string was reported as not loaded, and granted nothing. The run
  was in an untrusted workspace, where Claude Code ignored the committed `.claude/settings.json`
  list, so whether the two lists combine once a person trusts the workspace is unmeasured. `use`
  writes the served checkout there.
- OpenCode 1.19.5, `opencode run`: the grant file holding the worktree path allowed the write, the
  control was denied, and a pattern naming a missing grant file stopped OpenCode at start, naming the
  file. `use` and `sync` write the served checkout there.
- Codex 0.166.0, `codex exec`: Codex reads no machine-local project file; its only per-project user
  setting is the trust level. `--add-dir <dir>` at start made the worktree writable beside the
  committed writable roots, and without it the same write was refused. `use` writes nothing for
  Codex and prints that flag.

Cursor and Grok Build were not installed, so `use` writes nothing for them and says so.

The `[cockpit].guide_cap` limit applies to always-loaded guidance, copied sibling guides included;
going over it makes `sync`, `check` and `preflight` report `GUIDE_CAP_EXCEEDED` with the measured
lines and the cap. The same code reports cockpit's region of **AGENTS.md** passing 32768 bytes,
because Codex silently drops the rest of a longer project **AGENTS.md**. Cockpit reports the line cost per
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

   It first runs the read-only generated-file check and refuses a file that is missing,
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

## Upgrade cockpit

An upgrade replaces the generated files that guard and instruct every agent, so a person reads
what `sync` would change before it writes. One command does the whole move:

```sh
npx --no cockpit upgrade --config cockpit.toml            # latest published release
npx --no cockpit upgrade 1.4.0 --config cockpit.toml      # a named version, including an older one
npx --no cockpit upgrade --config cockpit.toml --dry-run  # resolve the target, print the commands, run nothing
```

`upgrade` resolves the target (`npm view @b00dea/cockpit version`), refuses one that is not newer
than the installed version unless you name it, detects the package manager from the one lockfile at
the cockpit root (`package-lock.json`, `pnpm-lock.yaml` or `yarn.lock`), installs the exact version as
a dev dependency, then runs `npx --no cockpit sync --config <path>` in a new process so the new
version renders. Sync's output and exit code pass through, so its own decisions stand: it removes
stale generated files under `[autonomy] stale_delete = "agent"`, and otherwise asks for the digest a
person types with `sync --interactive` in a terminal. It ends by printing the `Upgrade:`
lines from the installed `CHANGELOG.md` between the two versions (a line there names a step `sync`
does not do), or the npm page when the package has no changelog.

An agent may run `upgrade` exactly where it may run a writing `sync`: under `[autonomy] sync =
"agent"`, the default. Under `person` or `ci` the guard asks, as it does for `sync`, and the sync child
refuses outside CI under `ci`. `upgrade --dry-run` writes nothing, so it is never gated. Until `sync` finishes, the guard holds every agent tool call,
because it trusts only the cockpit it was generated for. A built-in that one of your overlays replaces and that the new release
changed is reported as `OVERRIDDEN_CORE_CHANGED`: review the new built-in against your override
before updating its recorded hash. Then review `git diff` and commit `package.json`, the lockfile and
the regenerated files together.

Dependabot and Renovate can bump the exact pin on their own. The `cockpit-check` CI action then reports
drift until someone runs `npx --no cockpit sync --config cockpit.toml` (or `upgrade <version>`) and
commits the regenerated files.

By hand: `npm install --save-dev --save-exact @b00dea/cockpit@<version>` (`npm update` does not move an
exact pin), read `./node_modules/@b00dea/cockpit/CHANGELOG.md`, preview with
`npx --no cockpit sync --config cockpit.toml --dry-run`, then run `sync` in a terminal.
