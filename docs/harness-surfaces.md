# Harness surfaces

What `cockpit sync` writes for each agent tool (Claude Code, Codex CLI, OpenCode, Cursor and Grok
Build), how product-specific additions enter, and how far each generated feature is confirmed to
work.

## Publish and verify

[Surfaces](concepts.md#surface) are published by `sync` and checked by `check`, which reports
[drift](concepts.md#drift) and never repairs output
([Bring the product up](getting-started.md#bring-the-product-up)).

```text
AGENTS.md  CLAUDE.md                 root instructions, one per tool family
.claude/settings.json                Claude Code hook, permissions and deny rules
.claude/skills/  .agents/skills/     cockpit's own skills for Claude Code and Codex
.codex/config.toml  .codex/hooks.json  Codex sandbox and guard hook
.opencode/plugin/  opencode.jsonc    OpenCode guard plugin and permissions (when listed)
.cockpit/guards/bash-guard.sh        the one guard all three tools call
.cockpit/policy.json                 the policy `sync` last ran under
```

The repository action at `.github/actions/cockpit-check/action.yml` runs only `cockpit check`.
Install the exact cockpit version from your lockfile before calling it; the action does not download
cockpit.

## Ownership and extension

Cockpit owns each generated entry as a whole file or a marked region inside a shared file. The
ownership manifest records the expected type, bytes and sources. Its digest catches accidental
changes; it does not prove who wrote a file in the past. Removing a stale entry needs
[separate approval](environment.md#check-and-sync). A team's existing `.claude/settings.json`,
`.codex/config.toml` or `.codex/hooks.json` is not overwritten:
[adopt it](getting-started.md#adopt-existing-agent-settings).

**Root instructions** are written once, in the region of **AGENTS.md** cockpit owns; Claude's region
contains only `@AGENTS.md`. When a team's **CLAUDE.md** already has that exact import, cockpit
leaves it alone; removing the import makes `check` report drift. Because which file imports which
decides what every agent session loads, a person approves those changes and runs `sync`.

**Overlays.** Core declarations and `[surfaces].overlays` merge by name;
[Extending cockpit](extending.md) lists every extension point. An overlay reusing a core name must
set `replaces` to that name and the recorded SHA-256 of the original, and cannot replace
`permissions` or `mcp`. When a later version changes an original you overrode,
`OVERRIDDEN_CORE_CHANGED` names the overlay and the current digest, and `sync` and `check` refuse
until you review it and update `replaces.sha256`. `sync --dry-run` and `doctor` list active
overrides and changed originals, and `doctor` says so when its preview cannot run. Markdown
frontmatter must use plain `---` delimiters and valid YAML of reasonable size. A rules overlay is
written into the instruction file every harness loads at start, so one that narrows itself with
`globs` is refused as `SURFACE_RULE_SCOPE_UNSUPPORTED`.

**The generator.** A checked-in, SHA-pinned bundle of
[Rulesync](https://github.com/dyoshikawa/rulesync) only spells the output for each harness.
Packaging verifies it against its source and includes its third-party notices, and cockpit checks
its bytes before loading it. Cockpit itself handles declaration merging, restriction policy, MCP
approval, sibling guide copies, capability state, ownership and publication, and accepts a result
only when the files reported match those read back from the isolated output directory.

**Plugin bundle.** `[surfaces].bundles = ["claudecode-plugin"]` also publishes a Claude plugin
bundle at **.cockpit/bundles/claudecode-plugin/**: a manifest plus the generated skills, subagents,
overlay hooks and MCP declaration that apply. It does not carry the guard hook, which stays in the
checkout's own `.claude/settings.json`. Writing the bundle does not show that Claude loaded it; that
needs a run in Claude Code.

## Capability states

The [capability matrix](capability-matrix.md) is the one record of each built-in harness's state,
defines the four states (`enforced`, `instructed`, `generated`, `unavailable`), and dates each
measurement. Those versions say nothing about the version you have installed. Generating a file
never upgrades a state: a feature moves to `enforced` only after a dated run of the real tool.

The shared guard is generated only for harnesses with a checked-in guard adapter: Claude Code, Codex
and OpenCode. The scripts deny, and fail closed, whenever a harness runs them; whether it does was
established by running the real tool. Codex is `enforced` only after a person
[trusts the hook](#trust-the-codex-hook). Claude's own Read, Grep and Glob tools never reach the
hook; generated `Read` deny rules
[keep them off secrets](safety-and-autonomy.md#reading-secrets-and-instances).

Cursor and Grok Build are `generated`, and written only when listed. Cockpit writes rules, skills,
subagents, hooks, MCP and permission files for them (`rulesyncFeatures` in
[the harness registry](../packages/cockpit/src/surfaces/harness-registry.ts)), but nobody has
verified either tool loads those files, and neither gets a guard hook.

### Choose the tools

`[surfaces] tools` lists the agent tools `sync` writes and `check` compares; it defaults to
`claudecode`, `codexcli` and `opencode`, the tools whose guard is measured, and must name at least
one of them. A tool left out gets no files, and doctor and check give no advice about it.
`./node_modules/@b00dea/cockpit/bin/cockpit.mjs tool add <tool> --config <your cockpit.toml>` and `tool remove` edit only that
line (`--dry-run` previews). A removed tool's files are deleted only after a person approves the
stale-removal digest with `sync --interactive`.

### Trust the Codex hook

Codex runs the guard from `.codex/hooks.json` only after a person on that machine has trusted it,
and skips an untrusted hook without saying so: every tool call then runs unguarded. In a linked Git
worktree, Codex
[loads project hooks from the original checkout](https://github.com/openai/codex/pull/21969), at
the same checkout-relative directory, so the worktree's own hooks file is neither run nor what
needs trust. That holds only where the shared Git directory is named `.git`: in a bare repository's
worktree, a submodule, a checkout with a separate Git directory and a cockpit root outside Git, Codex
reads the directory's own hooks file, and doctor checks trust there. Outside Git, Codex reads no
parent directory's hooks, so a session started in a subdirectory of the cockpit root runs without
the guard. `cockpit doctor` and `cockpit check` compare the generated hooks with that source first
and report `CODEX_HOOK_SOURCE_MISMATCH` when it is missing or differs: a person reviews and rolls out
the generated hooks in the original checkout through its normal change process, or validates in an
independent clone instead. Cockpit never writes that checkout. Matching definitions are not native
evidence: the generated commands select the guard of the session's own checkout with `pwd -P`, so
start Codex in the cockpit root and measure the guard with a deliberately broken control, a
harmless rejected operation and a successful permitted companion. The
[selftest](#skills-and-selftest-evidence) measures instruction loading; it leaves guard firing
unverified and does not replace this paired native guard measurement.

Trust is recorded per user in Codex's own configuration (`~/.codex/config.toml`, or `$CODEX_HOME`),
keyed by the hook source's path and a hash of its command, so it is needed once per machine and again
whenever that source changes. An agent cannot give it:

```sh
codex -C <hook source directory>
```

Start the interactive CLI (not `codex exec`) in the hook source directory `CODEX_HOOK_UNTRUSTED`
names, trust the folder if asked, and choose **Trust all and continue** when Codex shows **Hooks
need review**; `/hooks` inside a session does the same per hook. `cockpit doctor` and `cockpit
check` read Codex's configuration without changing it and report `CODEX_HOOK_UNTRUSTED` until the
source is trusted, or when discovery or trust cannot be verified, but only once Codex has run on the
machine (a Codex home exists); before that, no Codex session can skip the hook.

### Session-start drift check

The generated `.claude/settings.json` and `.codex/hooks.json` register a `SessionStart` hook that
runs the installed package's `node_modules/@b00dea/cockpit/bin/cockpit.mjs` entrypoint with `check`
and the configured file's absolute path, then prints the end of its report. Missing configuration
or dependencies produce recovery guidance before the first tool call. It never blocks a session.
Codex runs it only once a person trusts it. OpenCode gets none: its plugins receive
`session.created`, but no run has shown a plugin putting text in the agent's context.

### Recover a missing guard

A missing guard or machine-local guard identity holds guarded tool calls, including a sync or Git
restore attempted through the agent. Recovery happens in a human terminal, outside that session.
The message names the checkout and configured file it checked:

- If the configuration is absent, return to the intended configured checkout/worktree and branch.
  Local hook changes can survive a branch switch, whether the hook file is tracked or ignored.
  When the intended branch has no cockpit, review the active hook source against that branch,
  preserve a backup and the original native guards, and undo only the reviewed cockpit changes.
  A Git restore is appropriate only for a tracked file whose branch version is the intended one;
  preserve unrelated local hook changes. For Codex worktrees, review the
  [hook source](#trust-the-codex-hook), which can differ from the session checkout.
- If the configuration exists but the installed package is absent or incomplete, restore the
  repository's pinned dependencies using its documented package-manager command and lockfile.
  If that branch declares no cockpit dependency, return to the configured branch first. Retry
  afterwards so the hook can name the installed sync command.
- If the configuration and package entrypoint exist, the message prints the direct package command
  with the exact configuration path. Run it in the human terminal and review regenerated files.

Close and reopen the native agent session after restoring hook definitions or changing its
checkout. An open session can keep a cached hook even after the file on disk is restored. Recovery
does not require changing hook trust or removing native guards.

### Run cockpit outside the Codex sandbox

The generated `.codex/config.toml` runs Codex in its `workspace-write` sandbox with the sibling
checkouts as extra writable roots. Inside it Codex keeps `.git`, `.agents` and `.codex` read-only
and blocks cockpit's per-user state root and the Docker socket, so only `cockpit check`,
`cockpit sync --dry-run` and `--help` work there. Measured on 2026-11-02 with Codex 0.166.0's
`codex sandbox` and its built-in workspace profile, which agreed with a Codex session under the
generated configuration: `doctor`, `preflight`, `logs` and `work status` could not read cockpit's
state and `test-run` reported `DEGRADED`, while outside the sandbox they reported the real state and
the gate passed. A declared `[browser]` makes `check` and `sync --dry-run` read the state root too,
and so does `sync --dry-run` after a `cockpit.name` rename on a cockpit with Compose files, so those
also stop with `STATE_ROOT_UNAVAILABLE` there. Granting that one directory, or its nearest
existing parent before it exists, lifts the state limit alone: under Codex 0.166.0's `codex sandbox`
with a permissions profile writing only that directory, every state selector and a real write
succeeded while the home directory stayed read-only, and without the grant they refused (measured
2026-11-06). `/bin/ps` stays refused there, and so does the Docker socket.

Run every other cockpit command, and `git commit` in the cockpit, outside the sandbox: from a
terminal, or by approving Codex's request. A `codex exec` run cannot ask, so a person runs those
commands.

cockpit grants nothing more on purpose. Docker socket access controls the whole machine, which would
defeat the sandbox; the [state root](troubleshooting.md#clear-cockpit-state) differs by host and
user, so no committed path fits every clone.

### Claude Code command rules

Claude Code's default mode runs no shell command without an allow rule, so the generated
`.claude/settings.json` allows, by prefix, the cockpit commands the shipped skills tell an agent to
run and the [guard admits](safety-and-autonomy.md#cockpit-commands-an-agent-can-run), spelled as
`./node_modules/@b00dea/cockpit/bin/cockpit.mjs <command>`, `npx --no cockpit <command>` or
`./node_modules/.bin/cockpit <command>`. The direct package entrypoint also works with pnpm;
its `.bin` shell shim remains unproven by the guard. Commands that are
always a person's, such as `init` and `sibling add`, have no rule. A command the policy decides,
such as `sync`, has one: the guard hook still runs first, and its ask or deny wins. Claude Code
ignores a project's allow rules until a person has trusted the workspace by starting Claude Code
there once. Measured with Claude Code 2.1.316 on 2026-11-02 beside a command with no rule.

OpenCode allows shell commands unless configured otherwise, and Codex runs them inside its sandbox
without asking, so cockpit writes no command rules for either.

### OpenCode native reads

OpenCode's native `read`, `grep` and `glob` tools never reach a shell, so the generated plugin
restates each as the shell command that reads at least the same paths (`cat`, a recursive `grep`,
`ls`) and asks the guard about that. A refusal names the restated command, so an agent can narrow a
search. The generated `opencode.jsonc` also denies OpenCode's `read` permission for every `.secrets`
directory and each declared instance, which holds even if the plugin does not load. It carries the
`$schema` member OpenCode would otherwise insert at every start, which made later checks report
`SURFACE_STATE_CONFLICT`.

### Custom harnesses

A custom harness declares exactly one row for every feature. Each row that is not `unavailable`
names a test date, the output spelling, a deliberately broken control, and the module export that
produces it. Cockpit checks the module's source and its result. For an `enforced` row it also
requires the named evidence file to match its declared SHA-256, before running the module and again
before publishing. That ties the declaration to one file; confirming real enforcement still needs a
separate paired test of the tool.

Modules must be self-contained: cockpit imports one only if its bytes match the declaration, and
refuses relative imports. It runs in a worker that can write only to its own temporary directory and
cannot start child processes, worker threads or native addons; if the installed Node.js cannot
restrict filesystem access, cockpit refuses to run it. These limits restrict ordinary file writes;
they are not a sandbox against malicious code.

### Guard adapters

The checked-in adapters (the [Claude](../packages/cockpit/surfaces/guards/claude.adapter.json),
[Codex](../packages/cockpit/surfaces/guards/codex.adapter.json) and
[OpenCode](../packages/cockpit/surfaces/guards/opencode.adapter.json) ones) record how the guard
talks to each harness, as tested on an older version.
[Restriction expansion](../packages/cockpit/src/surfaces/restrictions.ts) checks the adapter's
recorded details but still emits `instructed`; only a dated run recorded in
[the harness registry](../packages/cockpit/src/surfaces/harness-registry.ts) changes a matrix state.
A harness without an adapter gets no control and is recorded as `unavailable`. Codex and OpenCode
have no prompt tier, so "ask" decisions
[become denials](safety-and-autonomy.md#native-adapter-behavior). Read-only subagent support is
reported on its own, because an instruction-only restriction is weaker than a native tool
restriction.

## MCP servers and restrictions

`[mcp.approved]` maps each approved server name to the sha256 of the declaration a human reviewed:
its command, arguments, working directory relative to the cockpit, and environment names. The
declaration lives in a sibling's file, which an agent can edit, so a server whose declaration
changed is no longer approved. A declared server absent from the list, or whose digest differs, is
rendered disabled for every harness (for Claude Code through `disabledMcpjsonServers`, because it
ignores `disabled` in `.mcp.json`), and `sync` and `check` report `MCP_NOT_APPROVED` with the digest
to approve. A name without a declaration reports `MCP_APPROVAL_UNKNOWN`. Cockpit rejects conflicting
commands for one server, credential-like arguments, environment values that are not same-name
references, and working directories outside the declared sibling.

Each harness starts the generated wrapper as `.cockpit/mcp/<id>.sh` relative to the directory the
agent was launched in, so it runs only when the agent was started in the cockpit root. The wrapper
changes to its sibling by a relative path, resolved physically and never through `CDPATH`. It starts
with an empty environment and passes `PATH`, the non-secret variables product test stages receive
(`HOME`, `USER`, `LOGNAME`, `TMPDIR`, `LANG`, `LC_ALL`, `LC_CTYPE`, `TZ`) and the declared
environment names.

For a local server whose helper has its own defaults, declare optional caller overrides by name:

```json
{ "mcpServers": {
  "local-reader": { "command": "bin/local-reader", "optionalEnv": ["LOCAL_PORT", "LOCAL_CONFIG_FILE"] }
} }
```

`optionalEnv` forwards a variable only when it is set, preserving an explicitly empty value.
Required variables remain in `env`, with same-name references such as `"TOKEN": "${TOKEN}"`; a name
cannot be both. The approval digest covers optional names and whether a variable is required. Doctor
reports missing required variables only.

A harness with no applicable MCP server receives no MCP-only output; its instructions, skills and
permissions still publish.

### Restrict a server's tools

Server approval permits a connection; it does not make the server read-only. Declare a positive list
of reviewed tool names, then run `sync`:

```toml
[mcp.allowed_tools]
reports = ["read_record", "search_records"]
```

Each name is exact. Every other tool from that server, including a newly added one, is denied. An
empty list denies all tools; an absent server has no restriction. The server must be declared, and
overlapping native server namespaces are refused.

Widening the list needs the same approval as other increases in agent authority, and removing a
server's list needs a person. Adding a restriction or removing tools narrows access, so an agent can
sync it when `[autonomy] sync = "agent"`, whatever `stale_delete` says: when the restriction leaves
a listed tool with no servers, `sync` removes that tool's MCP-only file (`.mcp.json` or
`.cursor/mcp.json`) as long as its bytes are still what cockpit generated. A hand-edited file is a
conflict, and any other stale path in the same sync still needs the stale-removal approval.

| Tool | Mechanism |
|---|---|
| Codex | `enabled_tools` in its generated server configuration, which does not depend on hook trust. It matches the raw tool name. |
| Claude Code | An authenticated `PreToolUse` guard scoped to the restricted server namespaces. It denies unlisted tools and defers listed tools to Claude Code's existing permission rules; listing a tool grants no native permission. Start Claude Code from the cockpit checkout and trust the workspace so its project hooks load. Claude Code rewrites a dot in a tool name to an underscore and keeps only the first of two tools that collide, so a listed `read_record` also admits a server tool named `read.record`. |
| Other harnesses | Omit restricted servers and report `MCP_TRANSPORT_UNAVAILABLE`. |

Restricted servers cannot be included in the Claude plugin bundle, whose tool namespace has not been
measured; remove that bundle from `[surfaces].bundles` to use the checkout's guarded server.
Unrestricted servers and plugin tools do not pass through this guard.

Review what each allowed tool actually does. A name, a token scope or `readOnlyHint` is not an
enforcement boundary. A generic dispatcher such as `execute_tool` can expose writes through its
arguments; listing it permits all of those operations. Cockpit does not filter tool arguments or
proxy server requests. Claude's guard reads only tool metadata from a bounded native JSON envelope
(at most 1 MiB); larger envelopes are refused.

This policy covers MCP **tool calls**, not resources, resource templates or prompts. It restricts
one declared server namespace, not every route to the service. With
`[autonomy] mcp_approve = "agent"`, an agent can register a new server or alias without that list,
so this is not a read-only sandbox against delegated approval. Use `mcp_approve = "person"` when new
connections must require human review, and review every approved process and route independently.

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
of headers when the tool connects; it runs without a shell. SSE servers are refused because Codex
cannot connect to them. The approval digest covers the URL, the header references and the helper's
command, arguments and directory; like a local server's command, the helper script's content is not
in the digest.

| Tool | Header references | Headers helper |
| --- | --- | --- |
| Claude Code | `headers` in `.mcp.json`, expanded from its environment | `headersHelper` |
| Codex | `bearer_token_env_var` and `env_http_headers` in `.codex/config.toml` | `http_headers_helper` |
| OpenCode | `{env:NAME}` in the `headers` of a `remote` server | none: the server is not written |
| Cursor, Grok Build | not written | not written |

A tool that cannot carry a server's credential gets nothing for that server, and `sync` and `check`
report `MCP_TRANSPORT_UNAVAILABLE`. Claude Code runs a `headersHelper` from the project `.mcp.json`
only after a person trusts the workspace; until then it connects without those headers.

A header reference resolves from the environment the agent tool was launched in, so a tool started
from a desktop launcher may not see a variable set in a shell profile. A helper reads the credential
when the tool connects instead. It runs through a generated wrapper, `.cockpit/mcp/<id>.headers.sh`,
started from the cockpit root, which changes to the sibling and passes the same inherited variables,
without the header names.

`doctor` checks each approved server without starting it or using the network: a local server's
command and a remote server's helper must resolve (`MCP_COMMAND_UNRESOLVED`), and every environment
name it reads must be set where doctor runs (`MCP_ENVIRONMENT_UNSET`). It names variables, never
values. A relative entry in the `PATH` doctor runs with stops it looking up a bare command, and the
code then names that entry.

## Sibling projection and standing cost

Cockpit reads each sibling's guides (`sibling.guides`, by default **CLAUDE.md** and **AGENTS.md**)
and copies them into its region of the root **AGENTS.md**, after its own instructions. Every tool
reads that file, Claude Code through the `@AGENTS.md` import. Copying is the one route that loaded
in Claude Code, Codex and OpenCode alike ([capability matrix](capability-matrix.md)). Each copy
starts with a heading naming the sibling and a comment recording the guide and the SHA-256 of the
text. A copy leaves out the marked block `setup --write-instruction-pointers` appended, and a
**CLAUDE.md** line importing the sibling's own **AGENTS.md** when that file is copied as well. Sync
refuses a guide that changes while it is read, resolves outside its root, or contains cockpit's own
instruction region or owner markers.

A copy goes stale when the guide changes: `check` and `preflight` report `GENERATED_ARTIFACT_DRIFT`
naming each `<sibling>/<guide>`, and a person runs `sync` and commits **AGENTS.md**. That is
deliberate: an agent editing a sibling's guide cannot change what every later agent loads until a
person has reviewed the new text. A Claude Code `@` import inside a copied guide resolves from the
cockpit root, and no other tool follows it, so keep shared guides free of them.

**Codex grants** are `sandbox_workspace_write.writable_roots` entries under
`sandbox_mode = "workspace-write"`, written relative to `.codex/` (`../../api` for a sibling at
`../api`) so clones do not drift. Cockpit emits no competing permission profile, because Codex
ignores one when these settings are present. This is generated configuration, not a measured claim
that Codex enforces it.

**OpenCode grants.** `external_directory` matches absolute paths only, so the committed pattern is
`{file:.cockpit/local/opencode-grant-<slug>}/**`: OpenCode substitutes the absolute directory `sync`
writes to that machine-local, ignored file, and refuses to start, naming the file, until `sync` has
run on the machine.

**A checkout `cockpit use` serves** from outside the declared one needs a grant that names a path on
one machine. Measured on 2026-11-04 unless noted, each run writing into the granted directory and an ungranted
control beside it:

- Claude Code 2.1.319, `claude -p --permission-mode acceptEdits` (measured 2026-11-06): a directory
  listed in `.claude/settings.local.json` `permissions.additionalDirectories` was written and the
  control refused, trusted or not. In a trusted workspace the committed list combines with it; in an
  untrusted one Claude Code ignores the committed list. A string-valued list in either file grants
  nothing from that file, with no report, while the other file's list still holds.
- OpenCode 1.19.5, `opencode run`: the grant file holding the worktree path allowed the write, the
  control was denied, and a pattern naming a missing grant file stopped OpenCode at start, naming
  the file.
- Codex 0.166.0, `codex exec`: Codex reads no machine-local project file. `--add-dir <dir>` at start
  made the worktree writable, and without it the same write was refused, so `use` writes nothing for
  Codex and prints that flag.

Cursor and Grok Build were not installed, so `use` writes nothing for them and says so.

**Guide cap.** `[cockpit].guide_cap` applies to always-loaded guidance, copied guides included;
going over makes `sync`, `check` and `preflight` report `GUIDE_CAP_EXCEEDED`. The same code reports
cockpit's region of **AGENTS.md** passing 32768 bytes, because Codex silently drops the rest of a
longer project **AGENTS.md**. Cockpit reports the line cost per harness only with a dated test of
how it loads guidance; without one the cost is `unavailable`, not zero. When a harness loads every
rule regardless of scope, scoped text still counts toward the total.

## Skills and selftest evidence

`sync` installs the `cockpit-*` skills for the tools `[surfaces] tools` lists. They call cockpit's
own commands, so an agent drives the stack, the tests and the grading the same way in each tool.

| Skill | The agent uses it to |
|---|---|
| `cockpit-fix` | Fix a named bug or failing test: reproduce it with the declared test gate, fix it, prove it with the same gate. Most changes need nothing more. |
| `cockpit-work` | Run a work order: write it, accept it, work inside its scope, record its decisions, check and grade it. |
| `cockpit-browser` | Check what the running app shows, through declared routes, signed-in roles and screenshots. It reports and never edits. Installed when a browser endpoint is declared. |
| `cockpit-explain` | Say what the cockpit does, why it refused something and what to run next, changing nothing. |
| `cockpit-setup` | Add a repository, upgrade, diagnose, clear a stale or orphaned stack, or make a repository's guides reach every tool. |
| `adopt-cockpit` | Set cockpit up in a repository that has none yet. Install it on its own with `npx skills add b0dea/cockpit --skill adopt-cockpit`. |

Each skill declares its trigger, each harness's equivalent tool name, the cockpit commands it may
run, what it changes, what it must not do, its review requirements and a line cap. The renderer
refuses embedded decision logic, undeclared commands, missing tool equivalents, missing procedures,
duplicate names, and skills over the always-loaded size limit.

`selftest` currently measures native Codex instruction loading through `codex debug prompt-input`
(measured 2026-11-06 on Codex 0.167.0).
It copies the exact generated `AGENTS.md` into a candidate directory and writes replacement
instructions in a separate broken-control directory. Both use the native `AGENTS.md` filename.
The validator checks the native structured input for each exact directory, the copied source digest,
and the difference between the leaf controls while keeping inherited instructions identical.
An empty `.git` directory above the controls ends Codex's `AGENTS.md` chain there, so the candidate
has the instruction limit to itself, as the root file does in a session; on that version a
32,000-byte guide loaded whole and a 40,000-byte one did not. A guide the tool cuts refuses the run.
This establishes that instructions reached the tool, not that it obeys them. The tool's identity
rests on the executable digest you approve: cockpit cannot tell that an approved file is really Codex.

The two control streams hold every instruction the tool inherited, including your global ones. The
output shows only their digest and size. The full streams stay in the run's transcript under the
ignored `.cockpit/local/probes`, readable only by you; delete that directory when you no longer need
the evidence. Credential-shaped text in a generated guide refuses the run, because evidence redacts
it and the stored stream could no longer match the source.

Other built-in capabilities remain explicitly `human_needed` with `native_protocol_unsupported`:
no authenticated native selftest adapter has been established for those cells. Their rows do not
execute any commands or request executable approval. This is a limitation of the selftest adapter,
not a claim that the harness lacks the capability. In particular, native tool denials can leave the
parent process successful, and Claude print mode can ignore malformed settings (both measured
2026-11-06, on Claude Code 2.1.319 and, for denials, Codex 0.167.0). Neither is evidence
that a generated guard failed or succeeded. Skills and generated guards need their own measured
protocols; instruction loading does not establish skill parity or guard enforcement.

The probe-specification file has one row per built-in cell, bound to the current `cockpit.toml` and
generated manifest. New files contain closed native protocol rows; no diagnostic codes need to be
invented. Protocol fields and command vectors must match the built-in protocol exactly.

1. After `sync`, write the file to a new path:

   ```sh
   ./node_modules/@b00dea/cockpit/bin/cockpit.mjs selftest --config ./cockpit.toml \
     --write-probe-specifications ./.cockpit/local/probe-specifications.json
   ```

2. Review the file, then run in a terminal outside CI and outside an agent session:

   ```sh
   ./node_modules/@b00dea/cockpit/bin/cockpit.mjs selftest --interactive --config ./cockpit.toml \
     --probe-specifications ./.cockpit/local/probe-specifications.json
   ```

   Cockpit shows the file digest and command vectors, including which native rows will execute.
   Approve that digest, then the digest of the executable found on `PATH`. Approval lasts only for
   that run. Pending cells and the summary remain visible even when evidence validation succeeds;
   command success is not a fully measured capability matrix. Without `--interactive`, or in CI
   or JSON mode, no commands in the file run.

When the file goes stale, carry forward its unchanged rows into a new file:

```sh
./node_modules/@b00dea/cockpit/bin/cockpit.mjs selftest --config ./cockpit.toml \
  --write-probe-specifications ./.cockpit/local/probe-specifications-2.json \
  --probe-specifications ./.cockpit/local/probe-specifications.json
```

Previously completed legacy rows without `protocol` remain supported unchanged. They require an
invocation containing exactly one `{control}`, exact native diagnostic lines in `candidateCode` and
`brokenCode`, and a nonzero rejected broken control. Use these only when the actual harness emits
that contract; assistant prose, echo commands and substitute executables are not proof. To replace
legacy rows with the native defaults, write a new file without the previous-file argument.

Probes inherit only the [non-secret tool environment](../packages/cockpit/src/environment/contract.ts),
including `HOME` for stored sign-in.
They preserve project trust and guards. Missing executables or authentication leave an explicit
operator remainder; unsupported output shapes, size limits and failed controls refuse the run.
The [validator](../packages/cockpit/libexec/validate-harness-evidence.mjs) holds the evidence limits.

Custom harness cells get no executable row and remain `human_needed` with
`enforcement_probe_required`. Measure a custom capability and record its `state` and `measured_on`.
Claude Code and Codex skill reviews stay pending until the required review results exist. A passing
skill review must bind successful evidence covering every declared skill feature; unavailable or
partial evidence cannot substantiate all passing checks.

## Upgrade cockpit

An upgrade replaces the generated files that guard and instruct every agent, so a person reads what
`sync` would change before it writes:

```sh
./node_modules/@b00dea/cockpit/bin/cockpit.mjs upgrade --config cockpit.toml            # latest published release
./node_modules/@b00dea/cockpit/bin/cockpit.mjs upgrade 1.4.0 --config cockpit.toml      # a named version, including an older one
./node_modules/@b00dea/cockpit/bin/cockpit.mjs upgrade --config cockpit.toml --dry-run  # resolve the target, print the commands, run nothing
```

`upgrade` resolves the target, refuses one that is not newer than the installed version unless you
name it, detects the package manager from the one lockfile at the cockpit root, installs the exact
version as a dev dependency, then runs `npx --no cockpit sync --config <path>` in a new process so
the new version renders. Sync's output and exit code pass through: it removes stale generated files
under `[autonomy] stale_delete = "agent"`, and otherwise asks for the digest a person types with
`sync --interactive`. It ends by printing the `Upgrade:` lines from the installed `CHANGELOG.md`
between the two versions (each names a step `sync` does not do), or the npm page when there is no
changelog.

An agent may run `upgrade` exactly where it may run a writing `sync`. Under `person` or `ci` the
guard asks, and the sync child refuses outside CI under `ci`. `--dry-run` is never gated. Until
`sync` finishes, the guard holds every guarded agent tool call, because it trusts only the cockpit,
Node and `cockpit.toml` it was generated for. A built-in that one of your overlays replaces and the
release changed is reported as `OVERRIDDEN_CORE_CHANGED`. Then review `git diff` and commit
`package.json`, the lockfile and the regenerated files together.

Dependabot and Renovate can bump the pin on their own; the `cockpit-check` action then reports drift
until someone runs `./node_modules/@b00dea/cockpit/bin/cockpit.mjs sync --config cockpit.toml` and commits the result.

By hand: `npm install --save-dev --save-exact @b00dea/cockpit@<version>` (`npm update` does not move
an exact pin), read `./node_modules/@b00dea/cockpit/CHANGELOG.md`, preview with
`./node_modules/@b00dea/cockpit/bin/cockpit.mjs sync --config cockpit.toml --dry-run`, then run `sync` in a terminal.
