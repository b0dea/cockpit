# Troubleshooting

Every diagnostic message names what failed and how to fix it. The sections below cover the codes that need more, and
[Codes with a fixed remedy](#codes-with-a-fixed-remedy) lists every code whose remedy never changes. Each command's flags are in its help.

## Common refusal guidance

| Diagnostic | Why it stops | Fix |
| --- | --- | --- |
| `INIT_CANONICAL_OWNERSHIP_MISSING` | The saved bootstrap stage and generated ownership disagree. | Restore the committed ownership metadata, then rerun the same `./node_modules/@b00dea/cockpit/bin/cockpit.mjs init . --target <tool>` command. |
| `SURFACE_SOURCE_UNAVAILABLE` | A declared sibling source cannot be read or checked. | Restore the named checkout at its declared path, then rerun `./node_modules/@b00dea/cockpit/bin/cockpit.mjs sync --config cockpit.toml`. |
| `SURFACE_OWNERSHIP_INVALID` | Cockpit cannot tell which settings it may replace. | Restore the last committed ownership metadata, then rerun `./node_modules/@b00dea/cockpit/bin/cockpit.mjs sync --config cockpit.toml`. |
| `SURFACE_STATE_CONFLICT` | Sync would overwrite a hand edit or a file cockpit has no record of writing. | Move a hand edit into `cockpit.toml` or a surface overlay and ask a person before discarding it; for a team's own settings file, have a person approve `./node_modules/@b00dea/cockpit/bin/cockpit.mjs sync --adopt <path> --config cockpit.toml`. |
| `GENERATED_ARTIFACT_DRIFT` | Generated files no longer match the canonical configuration. | Review the diff, run `./node_modules/@b00dea/cockpit/bin/cockpit.mjs sync --config cockpit.toml`, then retry. |
| `GENERATED_OWNERSHIP_INVALID` | Cockpit has no trustworthy record of which files it owns. | Restore the committed ownership metadata, then rerun `./node_modules/@b00dea/cockpit/bin/cockpit.mjs sync --config cockpit.toml`. |
| `GUARD_AUTHORITY_UNAVAILABLE` | The guard cannot read the current policy it needs to decide safely. | Restore `cockpit.toml` and generated guard files, then have a human run `./node_modules/@b00dea/cockpit/bin/cockpit.mjs sync --config cockpit.toml`. |
| `GUARD_REFUSED` | The command is outside the current guard policy. | Follow the named reason, or ask a human to update `cockpit.toml` and run `./node_modules/@b00dea/cockpit/bin/cockpit.mjs sync --config cockpit.toml`. |
| `RUNTIME_UNAVAILABLE` | The container runtime cannot be reached or identified. | Start it and verify `docker info`; if the message names a Docker or Compose version with no X.Y.Z core, install a release that prints one. Then retry. |
| `RUNTIME_UNMEASURED` | This machine has no passing measurement for the current runtime and engine version. | Run `./node_modules/@b00dea/cockpit/bin/cockpit.mjs runtime measure --config cockpit.toml --image <local-image>`, which records the result for this machine only, then retry. |
| `CLAIM_CO_TENANT` | Another [holder](concepts.md#holder) is using the stack. | After a failed `up`, run `./node_modules/@b00dea/cockpit/bin/cockpit.mjs up --config cockpit.toml` to resume or `./node_modules/@b00dea/cockpit/bin/cockpit.mjs down --config cockpit.toml` to release. Otherwise, have every session that holds the stack run `./node_modules/@b00dea/cockpit/bin/cockpit.mjs sleep --config cockpit.toml`, then retry. |
| `PORT_FAMILY_COLLISION` | A selected host port is already in use. | Stop the named listener or release the inactive stack, then retry. A host process meant to serve a leased port must be [started by the session](environment.md#host-processes-on-leased-ports) holding the stack. |
| `PORT_LEASE_EXHAUSTED` | Every declared port family is leased or occupied. | Release an inactive stack or extend `ports.count` after checking host capacity. |
| `SETUP_MANUAL_MISSING` | A manually managed sibling checkout is absent. | Create it at the declared path, then rerun `./node_modules/@b00dea/cockpit/bin/cockpit.mjs setup --config cockpit.toml`. |
| `SETUP_REMOTE_MISMATCH` | The checkout remote and declaration name different sources. | Correct the remote or declaration, then rerun `./node_modules/@b00dea/cockpit/bin/cockpit.mjs setup --config cockpit.toml`. |

## GENERATED_ARTIFACT_DRIFT

**Cause.** An owned whole file, symlink target or shared region differs from what the declarations and
their sources now produce ([Check and sync](environment.md#check-and-sync)).

**Remedy.** Inspect the target named in the diagnostic, then run:

```sh
./node_modules/@b00dea/cockpit/bin/cockpit.mjs check --config ./cockpit.toml
```

Review the declaration and source change. If the new bytes are intended, publish the complete
owned manifest:

```sh
./node_modules/@b00dea/cockpit/bin/cockpit.mjs sync --config ./cockpit.toml
```

Do not edit the ownership manifest or lifecycle state. If changed bytes belong to a formerly
owned path, preserve them until the declaration and ownership transition are understood.

## Harness surface failures

1. Read the target and message in the diagnostic.
2. Run `./node_modules/@b00dea/cockpit/bin/cockpit.mjs sync --config ./cockpit.toml --dry-run`; it prepares everything without changing
   the checkout.
3. Correct the named declaration or source, and repeat the preview.
4. Apply `sync`, then confirm the installed state with `check`.

Never edit the ownership manifest, a generated shared region or the selftest results to make a
diagnostic disappear.

`REGISTRY_INPUT_INVALID` means a declared sibling row cannot produce one valid registry. Correct
the named row or its derived MCP source, then retry the preview.

### Codex hooks in linked worktrees

`CODEX_HOOK_SOURCE_MISMATCH` means Codex loads this linked worktree's hooks from the original
checkout, where the generated definitions are missing or differ; trusting the worktree's own file
cannot fix it. `CODEX_HOOK_UNTRUSTED` names the hook source whose trust is missing, disabled or
outdated, or the Git or file-access failure that kept discovery from being verified, which comes
first. [Trust the Codex hook](harness-surfaces.md#trust-the-codex-hook) covers both.

### Merge, ownership, and generation

`SURFACE_INPUT_INVALID`, `SURFACE_BOUNDS`, `SURFACE_NAME_DUPLICATE`,
`SURFACE_KIND_AMBIGUOUS`, `SURFACE_OVERRIDE_INVALID`, `SURFACE_PATH_CONFLICT`, and
`SURFACE_OWNERSHIP_INVALID` mean the declarations, overlay identity, output paths or captured
output failed validation. Correct the named target. For an override, compare it with the current
core declaration and update
<!-- cockpit:ref schema=surfaces.overlays[].replaces.sha256 --> `surfaces.overlays[].replaces.sha256` only after reviewing the
new original. For a path conflict, change the declarations so only one produces the path; do not
delete the existing path as a workaround.

`SURFACE_STATE_CONFLICT` means a shared region, stale entry, symlink, or prior ownership record no
longer matches the bytes cockpit wrote. Keep the current bytes: a hand edit belongs in
`cockpit.toml` or a surface overlay, and discarding it, or deleting a file cockpit has no record of
writing, is the person's decision. For a team's own `.claude/settings.json`, `.codex/config.toml` or
`.codex/hooks.json`, the fix names the `sync --adopt` command that keeps it; see
[Adopt existing agent settings](getting-started.md#adopt-existing-agent-settings).
`SURFACE_ADOPTION_REFUSED` names the adopted key that would switch off or bypass the guard, or that
cockpit writes with a different value; remove it from the named file and sync again.
`SURFACE_SOURCE_UNAVAILABLE` means a declared source or active sibling could not be read or checked. Restore that source at its declared root and retry the dry run.
`SURFACE_CUSTOM_REFUSED` means the named custom harness module did not return a complete result
bound to its declaration and source digest, or an `enforced` row's evidence file was missing or
did not match its declared SHA-256. Inspect the module, the evidence file reference, and the broken control.

`GENERATED_STALE_APPROVAL_REQUIRED` means a dry run found stale entries but the apply has no
approval for their exact digest. Run `sync --interactive` from a terminal outside CI, review the
listed entries, and explicitly confirm only if every removal is intended.
`GENERATED_STALE_APPROVAL_INVALID` means the request could not be bound safely; inspect the
reported path and current ownership before retrying. Neither code permits deleting the path by
hand.

`SURFACE_NODE_UNAVAILABLE`, `SURFACE_PACKAGE_UNAVAILABLE`, and
`SURFACE_SCRATCH_UNAVAILABLE` identify a missing Node executable, a missing or changed copy of
the checked-in Rulesync generator bundle, or no safe staging directory. Restore the exact cockpit
package or the named local path. `SURFACE_STAGING_FAILED`, `SURFACE_WORKER_TIMEOUT`,
`SURFACE_WORKER_SIGNAL`, `SURFACE_WORKER_NONZERO`, `SURFACE_WORKER_STDERR`,
`SURFACE_WORKER_OUTPUT`, `SURFACE_OUTPUT_COVERAGE`, `SURFACE_FEATURE_COVERAGE`,
`SURFACE_STAGE_VARIANCE`, `SURFACE_ARTIFACT_INVALID`, and `SURFACE_CLEANUP_FAILED` identify the
generator stage that failed. Use the captured target and stderr; do not run a second generator
and treat its output as cockpit's result. The outer `SURFACE_GENERATION_FAILED` carries that cause
at the generated-environment boundary.

`EXECUTION_TERMINATION_UNCONFIRMED` means cockpit could not confirm that a surface worker
stopped, so it keeps the private staging path the diagnostic names. Stop the remaining workers
before removing that directory, then retry.

`SURFACE_GENERATOR_TRUST_WARNING` is a warning from a `sync` that writes `.claude/settings.json`
granting something: the sibling directories Claude Code may edit, the MCP servers it approves, and
the command patterns it runs without asking. It names each grant; review them before applying the
sync. A warning does not mean the harness enforces anything.

### MCP and restrictions

For `MCP_INPUT_INVALID` or `MCP_DECLARATION_INVALID`, correct the declaration, digest,
same-name environment reference, confined working directory, or remote server URL, header
reference or `headersHelper` named by the message.
`MCP_COMMAND_CONFLICT` means two sources give one server name different commands; make them agree or give them distinct names. `MCP_NOT_APPROVED` leaves a declared
server disabled because `[mcp.approved]` has no entry for it, or its declaration changed since it
was approved; a person, only after reviewing its command, arguments, working directory, environment
names and sources, sets its name to the sha256 in the message under `[mcp.approved]` and runs `sync`.
While `[autonomy] mcp_approve` is `person`, the default, the guard refuses an agent adding or
changing an approval or widening tool access; an agent may remove an unchanged approval and add or
narrow an exact allowlist under `[mcp.allowed_tools]`, which grant nothing new.
`MCP_APPROVAL_UNKNOWN` means the allowlist names no declaration. `MCP_EXECUTABLE_UNAVAILABLE` comes from the generated wrapper when its declared
executable is absent or not executable; restore that executable rather than changing the wrapper.
`MCP_TRANSPORT_UNAVAILABLE` names a remote server left out of the tools that cannot carry its
credential, such as OpenCode for a server with a `headersHelper`; see
[Remote servers](harness-surfaces.md#remote-servers) for what each tool can carry.

For `RESTRICTION_INPUT_INVALID`, `RESTRICTION_ADAPTER_INVALID`, `RESTRICTION_EVENT_UNADAPTED`,
`RESTRICTION_TEMPLATE_INVALID` or `RESTRICTION_OUTPUT_LIMIT`, correct the named guard policy,
adapter, template or output. An unadapted event stays unavailable; do not replace it with an
instruction and call it enforced.

### Sibling projection and skills

`PROJECTION_INPUT_INVALID` and `PROJECTION_RESULT_BOUNDS` mean the projection request or result
is not valid, size-limited data. `PROJECTION_ROOT_AMBIGUOUS`, `PROJECTION_MOUNT_MISMATCH`, and
`PROJECTION_GRANT_MISMATCH` require the main checkout, active mount, and directory grant
to agree. `PROJECTION_GUIDE_UNAVAILABLE`, `PROJECTION_GUIDE_ESCAPE`,
`PROJECTION_GUIDE_READ_FAILED`, and `PROJECTION_GUIDE_CLOSE_FAILED` identify the named guide or
its confined read. Restore a regular declared guide and safe root. `PROJECTION_GUIDE_CHANGED`
means the guide changed after observation; stop the concurrent edit and retry from a fresh read.
A sibling guide holding one of cockpit's own `<!-- cockpit:instructions:` or `<!-- cockpit:owner:`
markers is refused as `PROJECTION_INPUT_INVALID`, because its copy would end or split cockpit's
region of the root **AGENTS.md**; remove the marker from the guide.

For `SKILL_INPUT_INVALID`, `SKILL_FRONTMATTER_INVALID`, `SKILL_CONTRACT_INVALID`,
`SKILL_IDENTITY_INVALID`, `SKILL_NAME_DUPLICATE`, `SKILL_TOOL_EQUIVALENCE_MISSING`,
`SKILL_PROCEDURE_MISSING`, `SKILL_COMMAND_UNDECLARED`, `SKILL_ENTRY_POINT_EXCEEDED`, or
`SKILL_DECISION_LOGIC_EMBEDDED`, correct the shipped skill entry point or shared procedure named
by the diagnostic. `SKILL_RENDER_INVALID` and `SKILL_RENDER_INVENTORY_INVALID` mean generated
files do not match the skill contract. `SKILL_STANDING_COST_EXCEEDED` means the always-loaded
skill entry points are too large. Shrink them; moving decision logic into another always-loaded
file is not a repair.

### Selftest and override inspection

`SELFTEST_SOURCE_INVALID` means the generated check, resolved probe-specification path, source
digest, generated-manifest digest or specification shape failed its check. Write a fresh file with
`./node_modules/@b00dea/cockpit/bin/cockpit.mjs selftest --config <path> --write-probe-specifications <new file>`.
New files contain supported native protocols and explicit pending rows; they need no invented
markers. For a stale file, add `--probe-specifications <stale file>` to preserve unchanged filled
legacy rows. Do not edit stored digests. Legacy rows still containing `null` must be completed with
a demonstrably compatible native diagnostic contract or replaced with a fresh file.
[Skills and selftest evidence](harness-surfaces.md#skills-and-selftest-evidence) describes the
supported native scope and remaining operator work.

`SELFTEST_EXECUTION_INVALID` has three causes:

- An unapproved or mismatched probe file, refused before any command in it runs. Inspect its
  displayed whole-file digest and exact command vectors.
- One cell's candidate, deliberately broken control or version/help event did not give the expected
  result. That cell is recorded `probe_failed`, the summary leads with it and what to do, and the
  other cells are still measured. Inspect the named harness and the retained output.
- A reviewed input changed while the run used it, the probe directory was unusable, or the final
  result bundle failed validation. The whole run stops; rerun selftest once the named cause is fixed.
  A changed input is named with its path: the approved executable, a probe control, the guard
  identity, the configuration copy recorded for the guard, `cockpit.toml`, the Node executable or
  cockpit module the guard runs, or the generated Bash guard. A step that could not start before its
  dispatch window closed says so.

`SELFTEST_GUARD_IDENTITY_MISMATCH` means the guard identity `sync` wrote under
`.cockpit/local/guard-identity` differs from the one this selftest would write, so the Claude Code
guard probe cannot run; selftest refuses before asking for any approval. Most often `sync` ran under
another Node than this shell's, and the message names both. Run selftest with the Node the guard was
installed for, as the fix prints it, or run `sync` under the current Node and then selftest. When the
Node at the recorded path was upgraded in place, no Node runs what `sync` recorded and the guard holds
its calls until `sync` runs again, so run `sync`, then selftest. For any other difference, run `sync`
with this cockpit, then selftest. `doctor` reports `GUARD_NODE_DIFFERS` for both Node cases.

A missing executable, a sign-in requirement, missing process isolation or a pending enforcement
probe or unsupported native adapter stays `human_needed` until the manual action in the record is done. Run
`selftest --interactive` at a terminal outside CI; approve the full file digest and commands
first, then each executable path and SHA-256. Approval lasts only for that run.

`SURFACE_OVERRIDE_INSPECTION_UNAVAILABLE`, `SURFACE_OVERRIDE_INSPECTION_REFUSED`,
`SURFACE_OVERRIDE_INSPECTION_INVALID`, and `SURFACE_OVERRIDE_INSPECTION_PATH_MISMATCH` mean
`doctor` could not produce its read-only override view. They do not mean there are no overrides;
inspect the named generated source or configuration path before relying on that view.

## Clear cockpit state

cockpit keeps machine-local runtime state outside the repository: which sessions hold each stack,
its port lease, and how far `up` got. Each user has one state root:

| Host | State root |
| --- | --- |
| macOS | `~/Library/Application Support/cockpit/state/v1` |
| Linux, `XDG_STATE_HOME` set | `$XDG_STATE_HOME/cockpit/v1` |
| Linux, otherwise | `~/.local/state/cockpit/v1` |

Under it, `cockpits/cockpit_<name>_<hash>/` holds one cockpit's state, where `<name>` is
`cockpit.name` and `<hash>` identifies the cockpit's main checkout; `checkouts/` holds `init`
progress per checkout. A state diagnostic's target names the exact directory.

For `STATE_ROOT_UNAVAILABLE`, grant write access to the existing state root, or to the nearest
existing parent if cockpit must create the remaining directories. The directories between the home
directory and the state root need safe ownership and traversal, not write access: an already-created
private state root can be writable while the rest of the home directory stays read-only. Symlinks,
another owner's directories and group- or other-writable directories on that path remain refused. A
sandbox denial at the required write location still refuses the command; cockpit never switches to
another state directory to escape it.

A granted state root does not lift a sandbox's other limits. macOS's Seatbelt refuses to run
`/bin/ps`, which is setuid, even under a profile that allows everything else (measured 2026-11-06
with `sandbox-exec` and inside Codex 0.166.0's `codex sandbox`). Cockpit then cannot read when a process started. Work-order lock recovery says
so; a stack's hold names the holder instead. A pid that has gone is still released, since that takes
no `ps`, but a running pid reads as the session, so a hold stays while its pid exists. A session
started inside the sandbox records only its pid, so a command outside the sandbox cannot release that
hold any sooner, and that pid may since name another process: the refusal asks you to confirm it with
`ps -p` before stopping it.

These records are how cockpit knows which containers and ports a stack owns. Do not edit them by
hand, and do not delete them while the stack runs: its containers would keep running with nothing
that knows about them.

A stack whose worktree was deleted, and state folders an earlier cockpit build left, are removed by
`stacks prune`, which previews by default and removes only what no checkout can reach; see
[List and prune stacks across the machine](environment.md#list-and-prune-stacks-across-the-machine).
`doctor` warns with `STACKS_ORPHANED` when it finds such a stack, and with `STATE_RECORD_MALFORMED`
for another cockpit's state folder this version cannot read; `up` and `sleep` ignore that folder's
port leases.

`stacks prune` keeps a stack whose checkout still exists. To clear the state of a checkout you still
have:

1. Stop the stack and release its claims from the cockpit directory:
   `./node_modules/@b00dea/cockpit/bin/cockpit.mjs down --config cockpit.toml`.
2. If `down` refuses because the state cannot be read, stop the stack with Docker instead: find
   its project with `docker compose ls`, then run `docker compose -p <project> down`.
3. Delete the directory the diagnostic names, for example
   `rm -rf "$HOME/Library/Application Support/cockpit/state/v1/cockpits/cockpit_duo_<hash>"`.

When this cockpit's own state cannot be read, runtime commands refuse with
`STATE_RECORD_MALFORMED` or `STATE_FORMAT_UNSUPPORTED` until you clear it this way.

<!-- cockpit:diagnostic-index:begin -->
## Codes with a fixed remedy

Every diagnostic message names what failed and how to fix it. These codes always have the same remedy, or a section above that covers them; for any other code, follow its message.

| Diagnostic | What to do |
| --- | --- |
| `AUTONOMY_CI_ONLY` | push the change and let the CI job run the command, or have a person change the field in cockpit.toml and accept the change at sync |
| `AUTONOMY_PERSON_REQUIRED` | a person runs the same command with --interactive in a terminal outside CI, or a person changes the field in cockpit.toml and accepts the change at sync |
| `BROWSER_ROUTE_FINDINGS` | this run asked for a clean route (--fail-on-findings). Read result.receipt.surfaces[].diagnostics, including excerpt.messages where present: fix the product for each console error, uncaught page error and failed request that matters, then rerun ./node_modules/@b00dea/cockpit/bin/cockpit.mjs browser drive --config <your cockpit.toml> --route <name> --fail-on-findings; third-party traffic never counts |
| `CLAIM_CO_TENANT` | [see above](#common-refusal-guidance) |
| `COCKPIT_REVISION_UNSTAMPED` | install a released @b00dea/cockpit when the resolved data must name the exact cockpit source commit |
| `CODEX_HOOK_SOURCE_MISMATCH` | have a person review and roll out the matching generated hooks in the original checkout through its normal change process; cockpit does not copy hooks or change that checkout; rerun ./node_modules/@b00dea/cockpit/bin/cockpit.mjs doctor --config <your cockpit.toml>, then review and trust the reported source in interactive Codex; [see above](#codex-hooks-in-linked-worktrees) |
| `CODEX_HOOK_UNTRUSTED` | if the hook source could not be verified, resolve the reported discovery failure first; otherwise a person runs codex -C <hook source directory> in a terminal (not codex exec), trusts the folder if asked, and chooses "Trust all and continue" when Codex shows "Hooks need review" (or enables and trusts the hook in its /hooks view); then run ./node_modules/@b00dea/cockpit/bin/cockpit.mjs doctor --config <your cockpit.toml>; [see above](#codex-hooks-in-linked-worktrees) |
| `COMPOSE_FILE_UNREADABLE` | make environment.compose_files name a readable Compose file inside the cockpit root, then run ./node_modules/@b00dea/cockpit/bin/cockpit.mjs check --config <your cockpit.toml> |
| `CONFIG_ENCODING_INVALID` | save the configuration as UTF-8, then retry |
| `DATA_SEED_UNAVAILABLE` | make sure the Docker daemon this stack runs on answers docker volume ls, then rerun ./node_modules/@b00dea/cockpit/bin/cockpit.mjs up --config <your cockpit.toml> |
| `DECISION_INDEX_ENTRY_MISSING` | correct the link to the record's current file name, or remove the entry if the record was deleted on purpose |
| `DECISION_LINK_UNRESOLVED` | correct the number or link to name an existing record, or restore the record it names |
| `DECISION_NUMBER_REUSED` | renumber the later record to the next free number, then update the index and every supersedes line that cites it |
| `DECISION_UNINDEXED` | add a line linking the record to the decision index |
| `DOCS_NOT_DECLARED` | add a [docs] table to cockpit.toml: living = ["README.md", "docs/**/*.md"] lists the documents that must stay true, and the optional decisions = "docs/adr" and decisions_index = "docs/adr/README.md" name the decision records and their index; then rerun ./node_modules/@b00dea/cockpit/bin/cockpit.mjs docs check --config <your cockpit.toml> |
| `DOCS_REFERENCE_REMOVED` | cite the path that replaced it (a rename is named in the message), or rewrite or delete the sentence if what it described is gone; then rerun ./node_modules/@b00dea/cockpit/bin/cockpit.mjs docs check --config <your cockpit.toml> |
| `DOCS_TARGET_REMOVED` | cite the target or command that replaced it, or rewrite or delete the sentence if the step is gone; then rerun ./node_modules/@b00dea/cockpit/bin/cockpit.mjs docs check --config <your cockpit.toml> |
| `DOCUMENT_ESTATE_TOPOLOGY_MISMATCH` | declare one sibling for each repository the message says init observed, with that slug and dir, and no other; add any other repository after init with ./node_modules/@b00dea/cockpit/bin/cockpit.mjs sibling add <slug> --config <your cockpit.toml> |
| `DOCUMENT_GUARD_HOSTS_NONE` | list the hosts in guards.hosted_db_hosts and guards.vendor_endpoint_hosts and run ./node_modules/@b00dea/cockpit/bin/cockpit.mjs sync --config <your cockpit.toml> once a non-local environment exists |
| `DOCUMENT_RUNTIME_NOT_DECLARED` | to adopt a runtime, declare environment.compose_files, environment.machine and the environment postures, then run ./node_modules/@b00dea/cockpit/bin/cockpit.mjs sync --config <your cockpit.toml> |
| `ENVIRONMENT_NOT_DECLARED` | declare environment.compose_files = ["compose.yml"] to run your Compose file (for a small app with none, ./node_modules/@b00dea/cockpit/bin/cockpit.mjs init <cockpit root> --scaffold-compose <app dir> --port <port> writes a starting one), then run ./node_modules/@b00dea/cockpit/bin/cockpit.mjs sync --config <your cockpit.toml> |
| `ENV_KEYS_SOURCE_SKIPPED` | replace it with a regular file in that directory |
| `ENV_SCHEMA_OVERRIDDEN` | unset those variables in the shell, then rerun this command to check the schema's own sources |
| `ENV_SCHEMA_TOOL_MISSING` | install Varlock (https://varlock.dev) and put it on PATH |
| `ENV_SCHEMA_UNCOMMITTED` | commit the schema to have it validated, or have a person review it and run the load this message names |
| `ENV_SCHEMA_UNDECLARED` | consider adopting Varlock: install it if needed, then ask a person to run VARLOCK_TELEMETRY_DISABLED=true varlock init in this directory and review .env.schema without copying secret values into it |
| `EVALUATOR_FELL_BACK_TO_RUNNING_TOOL` | install and sign in to the passed-over tool so another tool grades the work, or name the grader you accept with --evaluator <tool> |
| `EVALUATOR_IS_RUNNING_TOOL` | list a second tool in work.evaluators so another tool grades the work, or accept this as the grade you chose |
| `EXECUTION_TERMINATION_UNCONFIRMED` | [see above](#merge-ownership-and-generation) |
| `GENERATED_ARTIFACT_DRIFT` | [see above](#generated_artifact_drift) |
| `GENERATED_ARTIFACT_MISSING` | run ./node_modules/@b00dea/cockpit/bin/cockpit.mjs sync --config <your cockpit.toml> |
| `GENERATED_BROWSER_ENDPOINT_UNPUBLISHED` | publish the endpoint port from exactly one service in environment.compose_files as "127.0.0.1:${VAR}:<container port>" with VAR under [ports.bases] set to the endpoint port, or remove browser.endpoint to drive a local browser, then run ./node_modules/@b00dea/cockpit/bin/cockpit.mjs sync --config <your cockpit.toml> |
| `GENERATED_CHECKOUT_STANDALONE` | in a terminal, outside the agent, run git init if this directory has no repository, remove a stale .git entry or repair it with git worktree repair, and install Git on an absolute PATH entry if it is missing; held calls then continue without a sync |
| `GENERATED_OWNERSHIP_DRIFT` | run ./node_modules/@b00dea/cockpit/bin/cockpit.mjs sync --config <your cockpit.toml> |
| `GENERATED_OWNERSHIP_INVALID` | [see above](#common-refusal-guidance) |
| `GENERATED_STALE_APPROVAL_INVALID` | [see above](#merge-ownership-and-generation) |
| `GENERATED_STALE_APPROVAL_REQUIRED` | [see above](#merge-ownership-and-generation) |
| `GENERATED_STALE_ARTIFACT` | a person runs ./node_modules/@b00dea/cockpit/bin/cockpit.mjs sync --config <your cockpit.toml> --interactive in a terminal and confirms the stale-file removals it shows with yes |
| `GUARD_AUTHORITY_UNAVAILABLE` | [see above](#common-refusal-guidance) |
| `GUARD_HOSTS_UNDECLARED` | list the database and live vendor API hosts of every non-local environment (production, staging, shared) under [guards] in cockpit.toml, then run ./node_modules/@b00dea/cockpit/bin/cockpit.mjs sync --config <your cockpit.toml>; if no such environment exists, record that by writing hosted_db_hosts = [] and vendor_endpoint_hosts = [] under [guards] |
| `GUARD_NODE_DIFFERS` | [see above](#selftest-and-override-inspection) |
| `GUARD_REFUSED` | [see above](#common-refusal-guidance) |
| `GUARD_SEARCH_PATH_RELATIVE` | check PATH in the shell or launcher that starts the agent harness; if it contains relative or empty entries, remove them there and restart the harness |
| `INIT_CANONICAL_OWNERSHIP_MISSING` | [see above](#common-refusal-guidance) |
| `INIT_SCAFFOLD_COMPOSE_EXISTS` | run ./node_modules/@b00dea/cockpit/bin/cockpit.mjs init <cockpit root> --target <tool>, which proposes the existing Compose file for environment.compose_files |
| `LOGS_TRUNCATED` | lower --tail to the number of recent records you need, or read the older records from the container runtime directly |
| `MCP_APPROVAL_UNKNOWN` | [see above](#mcp-and-restrictions) |
| `MCP_COMMAND_CONFLICT` | [see above](#mcp-and-restrictions) |
| `MCP_DECLARATION_INVALID` | [see above](#mcp-and-restrictions) |
| `MCP_INPUT_INVALID` | [see above](#mcp-and-restrictions) |
| `MCP_NOT_APPROVED` | [see above](#mcp-and-restrictions) |
| `MCP_TRANSPORT_UNAVAILABLE` | [see above](#mcp-and-restrictions) |
| `OUTPUT_EXISTS` | choose a new path; replacement requires a future explicit option |
| `PORT_FAMILY_COLLISION` | [see above](#common-refusal-guidance) |
| `PORT_LEASE_EXHAUSTED` | [see above](#common-refusal-guidance) |
| `PROJECTION_GRANT_MISMATCH` | [see above](#sibling-projection-and-skills) |
| `PROJECTION_GUIDE_CHANGED` | [see above](#sibling-projection-and-skills) |
| `PROJECTION_GUIDE_CLOSE_FAILED` | [see above](#sibling-projection-and-skills) |
| `PROJECTION_GUIDE_ESCAPE` | [see above](#sibling-projection-and-skills) |
| `PROJECTION_GUIDE_READ_FAILED` | [see above](#sibling-projection-and-skills) |
| `PROJECTION_GUIDE_UNAVAILABLE` | [see above](#sibling-projection-and-skills) |
| `PROJECTION_INPUT_INVALID` | [see above](#sibling-projection-and-skills) |
| `PROJECTION_MOUNT_MISMATCH` | [see above](#sibling-projection-and-skills) |
| `PROJECTION_RESULT_BOUNDS` | [see above](#sibling-projection-and-skills) |
| `PROJECTION_ROOT_AMBIGUOUS` | [see above](#sibling-projection-and-skills) |
| `REGISTRY_INPUT_INVALID` | [see above](#harness-surface-failures) |
| `RESTRICTION_ADAPTER_INVALID` | [see above](#mcp-and-restrictions) |
| `RESTRICTION_EVENT_UNADAPTED` | [see above](#mcp-and-restrictions) |
| `RESTRICTION_INPUT_INVALID` | [see above](#mcp-and-restrictions) |
| `RESTRICTION_OUTPUT_LIMIT` | [see above](#mcp-and-restrictions) |
| `RESTRICTION_TEMPLATE_INVALID` | [see above](#mcp-and-restrictions) |
| `RUNTIME_IMAGE_UNAVAILABLE` | pull or build it first (docker pull <image>), then run ./node_modules/@b00dea/cockpit/bin/cockpit.mjs runtime measure --config <your cockpit.toml> --image <image> again |
| `RUNTIME_UNAVAILABLE` | [see above](#common-refusal-guidance) |
| `RUNTIME_UNMEASURED` | [see above](#common-refusal-guidance) |
| `SECRET_FILE_TRACKED` | a person decides with the repository owner: stop tracking each file with git rm --cached <file>, add it to .gitignore, commit, and rotate any credential it held; commit a .env.example with the variable names instead |
| `SELFTEST_CUSTOM_PROBE_UNSUPPORTED` | measure the custom harness capability by hand with a candidate and a deliberately broken control, then record what you saw as its state and measured_on in cockpit.toml (enforced needs an evidence file); do not add a row for it |
| `SELFTEST_EXECUTION_INVALID` | [see above](#selftest-and-override-inspection) |
| `SELFTEST_GUARD_IDENTITY_MISMATCH` | [see above](#selftest-and-override-inspection) |
| `SELFTEST_SOURCE_INVALID` | [see above](#selftest-and-override-inspection) |
| `SERVICE_NOT_DECLARED` | rerun with --service set to one of the declared services |
| `SESSION_STACK_RETAINED` | run ./node_modules/@b00dea/cockpit/bin/cockpit.mjs sleep --config <your cockpit.toml> to release this checkout's remaining hold |
| `SETUP_CLONE_FAILED` | check that this machine can reach the remote (git ls-remote <remote>) and that the sibling remote in cockpit.toml is right, or clone it into the named directory yourself; then run ./node_modules/@b00dea/cockpit/bin/cockpit.mjs setup --config <your cockpit.toml> again |
| `SETUP_INSTRUCTION_FILES_OFFERED` | review the proposed change with a person, then run ./node_modules/@b00dea/cockpit/bin/cockpit.mjs setup --config <your cockpit.toml> --write-instruction-files |
| `SETUP_INSTRUCTION_POINTER_OFFERED` | review the proposed AGENTS.md block, then run ./node_modules/@b00dea/cockpit/bin/cockpit.mjs setup --config <your cockpit.toml> --write-instruction-pointers |
| `SETUP_MANUAL_MISSING` | create the checkout, then run ./node_modules/@b00dea/cockpit/bin/cockpit.mjs setup --config <your cockpit.toml> again; [see above](#common-refusal-guidance) |
| `SETUP_REMOTE_MISMATCH` | [see above](#common-refusal-guidance) |
| `SETUP_REMOTE_UNRESOLVABLE` | make the remote path readable, or declare the remote as a URL or an absolute path to an existing repository, then run ./node_modules/@b00dea/cockpit/bin/cockpit.mjs setup --config <your cockpit.toml> again |
| `SIBLING_GUIDE_MISSING` | correct or remove the guide name in that sibling's guides list in cockpit.toml, then run ./node_modules/@b00dea/cockpit/bin/cockpit.mjs sync --config <your cockpit.toml> |
| `SIBLING_INSTRUCTIONS_AGENTS_ONLY` | run ./node_modules/@b00dea/cockpit/bin/cockpit.mjs setup --config <your cockpit.toml> to see the CLAUDE.md it proposes (one line, @AGENTS.md); once a person approves it, or without one where [autonomy] instruction_files = "agent", run ./node_modules/@b00dea/cockpit/bin/cockpit.mjs setup --config <your cockpit.toml> --write-instruction-files |
| `SIBLING_INSTRUCTIONS_CLAUDE_ONLY` | run ./node_modules/@b00dea/cockpit/bin/cockpit.mjs setup --config <your cockpit.toml> to see the move it proposes (CLAUDE.md copied byte for byte to AGENTS.md, CLAUDE.md replaced by @AGENTS.md) and, once a person approves it, or without one where [autonomy] instruction_files = "agent", rerun it with --write-instruction-files; when CLAUDE.md imports other files with @, setup proposes nothing and a person moves the shared instructions into AGENTS.md by hand |
| `SIBLING_INSTRUCTIONS_MISSING` | a person writes AGENTS.md with what an agent must know to work in the repository, then runs ./node_modules/@b00dea/cockpit/bin/cockpit.mjs setup --config <your cockpit.toml> --write-instruction-files to add the CLAUDE.md that imports it |
| `SIBLING_INSTRUCTIONS_TOOL_ONLY` | a person moves the instructions every tool needs from those files into AGENTS.md, and keeps only settings specific to one tool where they are |
| `SIBLING_INSTRUCTIONS_UNLINKED` | a person merges the instructions every tool needs into AGENTS.md, then makes CLAUDE.md a line reading @AGENTS.md followed only by instructions that apply to Claude Code alone |
| `SKILL_COMMAND_UNDECLARED` | [see above](#sibling-projection-and-skills) |
| `SKILL_CONTRACT_INVALID` | [see above](#sibling-projection-and-skills) |
| `SKILL_DECISION_LOGIC_EMBEDDED` | [see above](#sibling-projection-and-skills) |
| `SKILL_ENTRY_POINT_EXCEEDED` | [see above](#sibling-projection-and-skills) |
| `SKILL_FRONTMATTER_INVALID` | [see above](#sibling-projection-and-skills) |
| `SKILL_IDENTITY_INVALID` | [see above](#sibling-projection-and-skills) |
| `SKILL_INPUT_INVALID` | [see above](#sibling-projection-and-skills) |
| `SKILL_NAME_DUPLICATE` | [see above](#sibling-projection-and-skills) |
| `SKILL_PROCEDURE_MISSING` | [see above](#sibling-projection-and-skills) |
| `SKILL_RENDER_INVALID` | [see above](#sibling-projection-and-skills) |
| `SKILL_RENDER_INVENTORY_INVALID` | [see above](#sibling-projection-and-skills) |
| `SKILL_STANDING_COST_EXCEEDED` | [see above](#sibling-projection-and-skills) |
| `SKILL_TOOL_EQUIVALENCE_MISSING` | [see above](#sibling-projection-and-skills) |
| `STACKS_ORPHANED` | [see above](#clear-cockpit-state) |
| `STATE_FORMAT_UNSUPPORTED` | [see above](#clear-cockpit-state) |
| `STATE_RECORD_MALFORMED` | [see above](#clear-cockpit-state) |
| `STATE_ROOT_UNAVAILABLE` | [see above](#clear-cockpit-state) |
| `SURFACE_ADOPTION_REFUSED` | [see above](#merge-ownership-and-generation) |
| `SURFACE_ARTIFACT_INVALID` | [see above](#merge-ownership-and-generation) |
| `SURFACE_BOUNDS` | [see above](#merge-ownership-and-generation) |
| `SURFACE_CLEANUP_FAILED` | [see above](#merge-ownership-and-generation) |
| `SURFACE_CUSTOM_REFUSED` | [see above](#merge-ownership-and-generation) |
| `SURFACE_FEATURE_COVERAGE` | [see above](#merge-ownership-and-generation) |
| `SURFACE_GENERATION_FAILED` | [see above](#merge-ownership-and-generation) |
| `SURFACE_GENERATOR_TRUST_WARNING` | [see above](#merge-ownership-and-generation) |
| `SURFACE_INPUT_INVALID` | [see above](#merge-ownership-and-generation) |
| `SURFACE_KIND_AMBIGUOUS` | [see above](#merge-ownership-and-generation) |
| `SURFACE_NAME_DUPLICATE` | [see above](#merge-ownership-and-generation) |
| `SURFACE_NODE_UNAVAILABLE` | [see above](#merge-ownership-and-generation) |
| `SURFACE_OUTPUT_COVERAGE` | [see above](#merge-ownership-and-generation) |
| `SURFACE_OVERRIDE_INSPECTION_INVALID` | [see above](#selftest-and-override-inspection) |
| `SURFACE_OVERRIDE_INSPECTION_PATH_MISMATCH` | [see above](#selftest-and-override-inspection) |
| `SURFACE_OVERRIDE_INSPECTION_REFUSED` | [see above](#selftest-and-override-inspection) |
| `SURFACE_OVERRIDE_INSPECTION_UNAVAILABLE` | [see above](#selftest-and-override-inspection) |
| `SURFACE_OVERRIDE_INVALID` | [see above](#merge-ownership-and-generation) |
| `SURFACE_OWNERSHIP_INVALID` | [see above](#common-refusal-guidance) |
| `SURFACE_PACKAGE_UNAVAILABLE` | [see above](#merge-ownership-and-generation) |
| `SURFACE_PATH_CONFLICT` | [see above](#merge-ownership-and-generation) |
| `SURFACE_RULE_SCOPE_UNSUPPORTED` | remove `globs` from the rule frontmatter, or narrow the rule text itself to the files it is about, then run ./node_modules/@b00dea/cockpit/bin/cockpit.mjs sync --config <your cockpit.toml> |
| `SURFACE_SCRATCH_UNAVAILABLE` | [see above](#merge-ownership-and-generation) |
| `SURFACE_SOURCE_UNAVAILABLE` | [see above](#common-refusal-guidance) |
| `SURFACE_STAGE_VARIANCE` | [see above](#merge-ownership-and-generation) |
| `SURFACE_STAGING_FAILED` | [see above](#merge-ownership-and-generation) |
| `SURFACE_STATE_CONFLICT` | [see above](#common-refusal-guidance) |
| `SURFACE_WORKER_NONZERO` | [see above](#merge-ownership-and-generation) |
| `SURFACE_WORKER_OUTPUT` | [see above](#merge-ownership-and-generation) |
| `SURFACE_WORKER_SIGNAL` | [see above](#merge-ownership-and-generation) |
| `SURFACE_WORKER_STDERR` | [see above](#merge-ownership-and-generation) |
| `SURFACE_WORKER_TIMEOUT` | [see above](#merge-ownership-and-generation) |
| `TESTING_GATE_UNDECLARED` | declare the product test commands as [testing] stages with a targeted and a full gate in cockpit.toml, then run ./node_modules/@b00dea/cockpit/bin/cockpit.mjs sync --config <your cockpit.toml> |
| `TEST_GATE_UNSATISFIED` | the message gives the verdict and its reasons. FAIL: a check a stage ran failed, so fix the product. DEGRADED: start the stack with ./node_modules/@b00dea/cockpit/bin/cockpit.mjs up --config <your cockpit.toml> for a stage that needs it, make a stage command that could not start runnable from the cockpit root, raise testing.stages[].timeout_seconds for a stage that timed out, or declare testing.stages[].select.<kind> for a --select a stage lacks. VOID: stop changing the checkouts and run the gate again. PARTIAL: only the complete gate can PASS, so run it without --select or --mode staged |
| `UPGRADE_ALREADY_CURRENT` | nothing to upgrade; to move to another version name it: ./node_modules/@b00dea/cockpit/bin/cockpit.mjs upgrade --config <your cockpit.toml> <version> |
| `UPGRADE_INSTALL_FAILED` | fix what the package manager reported (is the version published?), then run ./node_modules/@b00dea/cockpit/bin/cockpit.mjs upgrade --config <your cockpit.toml> <version> |
| `UPGRADE_LATEST_FILTERED` | name the latest version the message gives (or look it up on the registry) instead of asking the package manager: ./node_modules/@b00dea/cockpit/bin/cockpit.mjs upgrade <version> --config <your cockpit.toml> |
| `UPGRADE_PACKAGE_MANAGER_UNKNOWN` | keep exactly one of package-lock.json, pnpm-lock.yaml or yarn.lock at the cockpit root and put its package manager (npm, pnpm or yarn) on PATH, then run ./node_modules/@b00dea/cockpit/bin/cockpit.mjs upgrade --config <your cockpit.toml> |
| `UPGRADE_REGISTRY_UNREACHABLE` | check the network, the registry login and that npm is on PATH, or name the version: ./node_modules/@b00dea/cockpit/bin/cockpit.mjs upgrade --config <your cockpit.toml> <version> |
| `UPGRADE_SYNC_FAILED` | act on what sync reported above, then run ./node_modules/@b00dea/cockpit/bin/cockpit.mjs sync --config <your cockpit.toml> |
| `UPGRADE_VERSION_INVALID` | give a full version such as 1.2.3, not a range or tag |
| `WORK_CHECK_FAILED` | read result.results: fix the product for a check that failed, make one that did not run runnable from the cockpit root, then rerun ./node_modules/@b00dea/cockpit/bin/cockpit.mjs work check --config <your cockpit.toml> --work-order <id> |
| `WORK_PERSON_REQUIRED` | stop and ask a person to run the same command with --interactive in a terminal outside CI, read what it shows, and type the digest; never type it for them |
| `WORK_VERIFY_FAILED` | for an order changed since acceptance, run ./node_modules/@b00dea/cockpit/bin/cockpit.mjs work accept --config <your cockpit.toml> --work-order <id> or revert the change; for a done order without a passing grade, regrade it with work grade; for a decision record that is missing or no longer cites its order, restore it from git or put back its "Work order: <id>" line |
<!-- cockpit:diagnostic-index:end -->
