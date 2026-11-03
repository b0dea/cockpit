# Troubleshooting

This page is for anyone holding a cockpit diagnostic code: what it means and what to do. Every
diagnostic message names what failed and how to fix it; the sections below cover the codes that
need more than that, and [Codes with a fixed remedy](#codes-with-a-fixed-remedy) at the end lists
every code whose remedy never changes.

Human output spells common refusals as **What failed**, **Why it matters** and **Fix**. Use
`--json` only when a program needs the machine-readable envelope. Each command's flags are in its
help, for example `cockpit sync --help`.

## Common refusal guidance

| Diagnostic | Why it stops | Fix |
| --- | --- | --- |
| `INIT_CANONICAL_OWNERSHIP_MISSING` | The saved bootstrap stage and generated ownership disagree. | Restore the committed ownership metadata, then rerun the same `npx --no cockpit init . --target <tool>` command. |
| `SURFACE_SOURCE_UNAVAILABLE` | A declared sibling source cannot be read or checked. | Restore the named checkout at its declared path, then rerun `npx --no cockpit sync --config cockpit.toml`. |
| `SURFACE_OWNERSHIP_INVALID` | Cockpit cannot tell which settings it may replace. | Restore the last committed ownership metadata, then rerun `npx --no cockpit sync --config cockpit.toml`. |
| `SURFACE_STATE_CONFLICT` | Sync would overwrite a hand edit or a file cockpit has no record of writing. | Move a hand edit into `cockpit.toml` or a surface overlay and ask a person before discarding it; for a team's own settings file, have a person approve `npx --no cockpit sync --adopt <path> --config cockpit.toml`. |
| `GENERATED_ARTIFACT_DRIFT` | Generated files no longer match the canonical configuration. | Review the diff, run `npx --no cockpit sync --config cockpit.toml`, then retry. |
| `GENERATED_OWNERSHIP_INVALID` | Cockpit has no trustworthy record of which files it owns. | Restore the committed ownership metadata, then rerun `npx --no cockpit sync --config cockpit.toml`. |
| `GUARD_AUTHORITY_UNAVAILABLE` | The guard cannot read the current policy it needs to decide safely. | Restore `cockpit.toml` and generated guard files, then have a human run `npx --no cockpit sync --config cockpit.toml`. |
| `GUARD_REFUSED` | The command is outside the current guard policy. | Follow the named reason, or ask a human to update `cockpit.toml` and run `npx --no cockpit sync --config cockpit.toml`. |
| `RUNTIME_UNAVAILABLE` | The container runtime cannot be reached or identified. | Start it and verify `docker info`; if the message names a Docker or Compose version with no X.Y.Z core, install a release that prints one. Then retry. |
| `RUNTIME_UNMEASURED` | This machine has no passing measurement for the current runtime and engine version. | Run `npx --no cockpit runtime measure --config cockpit.toml --image <local-image>`, which records the result for this machine only, then retry. |
| `CLAIM_CO_TENANT` | Another [holder](concepts.md#holder) is using the stack. | After a failed `up`, run `npx --no cockpit up --config cockpit.toml` to resume or `npx --no cockpit down --config cockpit.toml` to release. Otherwise, have every session that holds the stack run `npx --no cockpit sleep --config cockpit.toml`, then retry. |
| `PORT_FAMILY_COLLISION` | A selected host port is already in use. | Stop the named listener or release the inactive stack, then retry. |
| `PORT_LEASE_EXHAUSTED` | Every declared port family is leased or occupied. | Release an inactive stack or extend `ports.count` after checking host capacity. |
| `SETUP_MANUAL_MISSING` | A manually managed sibling checkout is absent. | Create it at the declared path, then rerun `npx --no cockpit setup --config cockpit.toml`. |
| `SETUP_REMOTE_MISMATCH` | The checkout remote and declaration name different sources. | Correct the remote or declaration, then rerun `npx --no cockpit setup --config cockpit.toml`. |

## GENERATED_ARTIFACT_DRIFT

**Cause.** An owned whole file, symlink target or shared region differs from what the environment
and surface declarations and their sources now produce. As
[Check and sync](environment.md#check-and-sync) describes, `check` reports the mismatch without
changing any owned file.

**Remedy.** Inspect the target named in the diagnostic, then run:

```sh
npx --no cockpit check --config ./cockpit.toml
```

Review the declaration and source change. If the new bytes are intended, publish the complete
owned manifest:

```sh
npx --no cockpit sync --config ./cockpit.toml
```

Do not edit the ownership manifest or lifecycle state. If changed bytes belong to a formerly
owned path, preserve them until the declaration and ownership transition are understood.

## Harness surface failures

1. Read the target and message in the diagnostic.
2. Run `cockpit sync --config ./cockpit.toml --dry-run`; it prepares everything without changing
   the checkout.
3. Correct the named declaration or source, and repeat the preview.
4. Apply `sync`, then confirm the installed state with `check`.

Never edit the ownership manifest, a generated shared region or the selftest results to make a
diagnostic disappear.

`REGISTRY_INPUT_INVALID` means a declared sibling row cannot produce one valid registry. Correct
the named row or its derived MCP source, then retry the preview.

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
listed entries, and type the displayed digest only if every removal is intended.
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
sync. A sync that leaves the file unchanged, and `check`, do not repeat it. A warning does not mean
the harness enforces anything.

### MCP and restrictions

For `MCP_INPUT_INVALID` or `MCP_DECLARATION_INVALID`, correct the declaration, digest,
same-name environment reference, or confined working directory named by the message.
`MCP_COMMAND_CONFLICT` means two sources give one server name different commands; make them agree or give them distinct names. `MCP_NOT_APPROVED` leaves a declared
server disabled because `[mcp.approved]` has no entry for it, or its declaration changed since it
was approved; a person, only after reviewing its command, arguments, working directory, environment
names and sources, sets its name to the sha256 in the message under `[mcp.approved]` and runs `sync`.
While `[autonomy] mcp_approve` is `person`, the default, the guard refuses an agent's edit of `[mcp]`. `MCP_APPROVAL_UNKNOWN` means the allowlist names no
declaration. `MCP_EXECUTABLE_UNAVAILABLE` comes from the generated wrapper when its declared
executable is absent or not executable; restore that executable rather than changing the wrapper.

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
digest, generated-manifest digest or specification size failed its check, or the file still has a
`null` where a probe belongs. For a missing file, write a fresh one with
`npx --no cockpit selftest --config <path> --write-probe-specifications <new file>` and fill in its
`null` fields; for a stale one, add `--probe-specifications <stale file>` to that command so the
rows you filled for unchanged cells are kept. Do not edit the stored digests. For a `null`, fill in the rows the message lists.
[Skills and selftest evidence](harness-surfaces.md#skills-and-selftest-evidence) describes each
field.

`SELFTEST_EXECUTION_INVALID` has two causes:

- An unapproved or mismatched probe file, refused before any command in it runs. Inspect its
  displayed whole-file digest and exact command vectors.
- A candidate, deliberately broken control, version/help event, transcript or final result bundle
  did not give the expected result. Inspect the named harness and the retained output.

A missing executable, a sign-in requirement, missing process isolation or a pending enforcement
probe stays `human_needed` until the manual action in the record is done. Run
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

These records are how cockpit knows which containers and ports a stack owns. Do not edit them by
hand, and do not delete them while the stack runs: its containers would keep running with nothing
that knows about them. To clear one cockpit's state:

1. Stop the stack and release its claims from the cockpit directory:
   `./node_modules/.bin/cockpit down --config cockpit.toml`.
2. If `down` refuses because the state cannot be read, stop the stack with Docker instead: find
   its project with `docker compose ls`, then run `docker compose -p <project> down`.
3. Delete the directory the diagnostic names, for example
   `rm -rf "$HOME/Library/Application Support/cockpit/state/v1/cockpits/cockpit_duo_<hash>"`.

When this cockpit's own state cannot be read, runtime commands refuse with
`STATE_RECORD_MALFORMED` or `STATE_FORMAT_UNSUPPORTED` until you clear it. Unreadable state of
another cockpit, such as a directory left by an earlier cockpit build, does not stop you: `up` and
`sleep` ignore its port leases, and only `doctor` warns with `STATE_RECORD_MALFORMED`, naming that
directory and the `rm -rf` command. Remove it with the same steps once no cockpit uses it.

<!-- cockpit:diagnostic-index:begin -->
## Codes with a fixed remedy

Every diagnostic message names what failed and how to fix it. These codes always have the same remedy, or a section above that covers them; for any other code, follow its message.

| Diagnostic | What to do |
| --- | --- |
| `AUTONOMY_CI_ONLY` | push the change and let the CI job run the command, or have a person change the field in cockpit.toml and accept the change at sync |
| `AUTONOMY_PERSON_REQUIRED` | a person runs the same command with --interactive in a terminal outside CI, or a person changes the field in cockpit.toml and accepts the change at sync |
| `CLAIM_CO_TENANT` | [see above](#common-refusal-guidance) |
| `COCKPIT_LAUNCHER_UNPROVEN` | run cockpit as ./node_modules/.bin/cockpit <command> --config <your cockpit.toml> from the cockpit root, or remove what stops npx from proving it: a .npmrc in the cockpit root, a bin or directories.bin in its package.json, or a node_modules/.bin/cockpit that npm install did not link to the installed package |
| `COCKPIT_REVISION_UNSTAMPED` | install a released @b00dea/cockpit when the resolved data must name the exact cockpit source commit |
| `CODEX_HOOK_UNTRUSTED` | if you use Codex in this cockpit, a person runs codex -C <cockpit root> in a terminal (not codex exec), trusts the folder if asked, and chooses "Trust all and continue" when Codex shows "Hooks need review" (or enables and trusts the hook in its /hooks view); then run npx --no cockpit doctor --config <your cockpit.toml> |
| `COMPOSE_FILE_UNREADABLE` | make environment.compose_files name a readable Compose file inside the cockpit root, then run npx --no cockpit check --config <your cockpit.toml> |
| `CONFIG_ENCODING_INVALID` | save the configuration as UTF-8, then retry |
| `DATA_SEED_UNAVAILABLE` | make sure the Docker daemon this stack runs on answers docker volume ls, then rerun npx --no cockpit up --config <your cockpit.toml> |
| `DECLARATION_UNCONFIRMED` | confirm each value with whoever owns the product and correct it in cockpit.toml if it is wrong, delete each confirmed entry from unconfirmed, then run npx --no cockpit sync --config <your cockpit.toml> |
| `DOCUMENT_ESTATE_TOPOLOGY_MISMATCH` | declare one sibling for each repository the message says init observed, with that slug and dir, and no other; add any other repository after init with npx --no cockpit sibling add <slug> --config <your cockpit.toml> |
| `DOCUMENT_GUARD_HOSTS_NONE` | list the hosts in guards.hosted_db_hosts and guards.vendor_endpoint_hosts and run npx --no cockpit sync --config <your cockpit.toml> once a non-local environment exists |
| `DOCUMENT_RUNTIME_NOT_DECLARED` | once a product runs, declare environment.compose_files and run npx --no cockpit sync --config <your cockpit.toml> |
| `ENVIRONMENT_NOT_DECLARED` | declare environment.compose_files = ["compose.yml"] to run your Compose file (for a small app with none, npx --no cockpit init <cockpit root> --scaffold-compose <app dir> --port <port> writes a starting one), then run npx --no cockpit sync --config <your cockpit.toml> |
| `EVALUATOR_FELL_BACK_TO_RUNNING_TOOL` | install and sign in to the passed-over tool so another tool grades the work, or name the grader you accept with --evaluator <tool> |
| `EXECUTION_TERMINATION_UNCONFIRMED` | [see above](#merge-ownership-and-generation) |
| `GENERATED_ARTIFACT_DRIFT` | [see above](#generated_artifact_drift) |
| `GENERATED_ARTIFACT_MISSING` | run npx --no cockpit sync --config <your cockpit.toml> |
| `GENERATED_BROWSER_ENDPOINT_UNPUBLISHED` | publish the endpoint port from exactly one service in environment.compose_files as "127.0.0.1:${VAR}:<container port>" with VAR under [ports.bases] set to the endpoint port, or remove browser.endpoint to drive a local browser, then run npx --no cockpit sync --config <your cockpit.toml> |
| `GENERATED_OWNERSHIP_DRIFT` | run npx --no cockpit sync --config <your cockpit.toml> |
| `GENERATED_OWNERSHIP_INVALID` | [see above](#common-refusal-guidance) |
| `GENERATED_STALE_APPROVAL_INVALID` | [see above](#merge-ownership-and-generation) |
| `GENERATED_STALE_APPROVAL_REQUIRED` | [see above](#merge-ownership-and-generation) |
| `GENERATED_STALE_ARTIFACT` | a person runs npx --no cockpit sync --config <your cockpit.toml> --interactive in a terminal and approves the stale-removal digest it shows |
| `GUARD_AUTHORITY_UNAVAILABLE` | [see above](#common-refusal-guidance) |
| `GUARD_HOSTS_UNDECLARED` | list the database and live vendor API hosts of every non-local environment (production, staging, shared) under [guards] in cockpit.toml, then run npx --no cockpit sync --config <your cockpit.toml>; if no such environment exists, record that by writing hosted_db_hosts = [] and vendor_endpoint_hosts = [] under [guards] |
| `GUARD_REFUSED` | [see above](#common-refusal-guidance) |
| `GUARD_SEARCH_PATH_RELATIVE` | remove every relative or empty entry from PATH where the shell profile or launcher that starts the agent harness sets it, then restart the harness |
| `INIT_CANONICAL_OWNERSHIP_MISSING` | [see above](#common-refusal-guidance) |
| `INIT_SCAFFOLD_COMPOSE_EXISTS` | run npx --no cockpit init <cockpit root> --target <tool>, which proposes the existing Compose file for environment.compose_files |
| `LOGS_TRUNCATED` | lower --tail to the number of recent records you need, or read the older records from the container runtime directly |
| `MCP_APPROVAL_UNKNOWN` | [see above](#mcp-and-restrictions) |
| `MCP_COMMAND_CONFLICT` | [see above](#mcp-and-restrictions) |
| `MCP_DECLARATION_INVALID` | [see above](#mcp-and-restrictions) |
| `MCP_INPUT_INVALID` | [see above](#mcp-and-restrictions) |
| `MCP_NOT_APPROVED` | [see above](#mcp-and-restrictions) |
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
| `RUNTIME_IMAGE_UNAVAILABLE` | pull or build it first (docker pull <image>), then run npx --no cockpit runtime measure --config <your cockpit.toml> --image <image> again |
| `RUNTIME_UNAVAILABLE` | [see above](#common-refusal-guidance) |
| `RUNTIME_UNMEASURED` | [see above](#common-refusal-guidance) |
| `SECRET_FILE_TRACKED` | a person decides with the repository owner: stop tracking each file with git rm --cached <file>, add it to .gitignore, commit, and rotate any credential it held; commit a .env.example with the variable names instead |
| `SELFTEST_CUSTOM_PROBE_UNSUPPORTED` | measure the custom harness capability by hand with a candidate and a deliberately broken control, then record what you saw as its state and measured_on in cockpit.toml (enforced needs an evidence file); do not add a row for it |
| `SELFTEST_EXECUTION_INVALID` | [see above](#selftest-and-override-inspection) |
| `SELFTEST_SOURCE_INVALID` | [see above](#selftest-and-override-inspection) |
| `SERVICE_NOT_DECLARED` | rerun with --service set to one of the declared services |
| `SESSION_STACK_RETAINED` | run npx --no cockpit sleep --config <your cockpit.toml> to release this checkout's remaining hold |
| `SETUP_CLONE_FAILED` | check that this machine can reach the remote (git ls-remote <remote>) and that the sibling remote in cockpit.toml is right, or clone it into the named directory yourself; then run npx --no cockpit setup --config <your cockpit.toml> again |
| `SETUP_INSTRUCTION_FILES_OFFERED` | review the proposed change with a person, then run npx --no cockpit setup --config <your cockpit.toml> --write-instruction-files |
| `SETUP_INSTRUCTION_POINTER_OFFERED` | review the proposed AGENTS.md block, then run npx --no cockpit setup --config <your cockpit.toml> --write-instruction-pointers |
| `SETUP_MANUAL_MISSING` | create the checkout, then run npx --no cockpit setup --config <your cockpit.toml> again; [see above](#common-refusal-guidance) |
| `SETUP_REMOTE_MISMATCH` | [see above](#common-refusal-guidance) |
| `SETUP_REMOTE_UNRESOLVABLE` | make the remote path readable, or declare the remote as a URL or an absolute path to an existing repository, then run npx --no cockpit setup --config <your cockpit.toml> again |
| `SIBLING_GUIDE_MISSING` | correct or remove the guide name in that sibling's guides list in cockpit.toml, then run npx --no cockpit sync --config <your cockpit.toml> |
| `SIBLING_INSTRUCTIONS_AGENTS_ONLY` | run npx --no cockpit setup --config <your cockpit.toml> to see the CLAUDE.md it proposes (one line, @AGENTS.md); once a person approves it, run npx --no cockpit setup --config <your cockpit.toml> --write-instruction-files |
| `SIBLING_INSTRUCTIONS_CLAUDE_ONLY` | run npx --no cockpit setup --config <your cockpit.toml> to see the move it proposes (CLAUDE.md copied byte for byte to AGENTS.md, CLAUDE.md replaced by @AGENTS.md) and, once a person approves it, rerun it with --write-instruction-files; when CLAUDE.md imports other files with @, setup proposes nothing and a person moves the shared instructions into AGENTS.md by hand |
| `SIBLING_INSTRUCTIONS_MISSING` | a person writes AGENTS.md with what an agent must know to work in the repository, then runs npx --no cockpit setup --config <your cockpit.toml> --write-instruction-files to add the CLAUDE.md that imports it |
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
| `STATE_FORMAT_UNSUPPORTED` | [see above](#clear-cockpit-state) |
| `STATE_RECORD_MALFORMED` | [see above](#clear-cockpit-state) |
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
| `SURFACE_RULE_SCOPE_UNSUPPORTED` | remove `globs` from the rule frontmatter, or narrow the rule text itself to the files it is about, then run npx --no cockpit sync --config <your cockpit.toml> |
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
| `TESTING_GATE_UNDECLARED` | declare the product test commands as [testing] stages with a targeted and a full gate in cockpit.toml, then run npx --no cockpit sync --config <your cockpit.toml> |
| `TEST_GATE_UNSATISFIED` | the message gives the verdict and its reasons. FAIL: a check a stage ran failed, so fix the product. DEGRADED: start the stack with npx --no cockpit up --config <your cockpit.toml> for a stage that needs it, make a stage command that could not start runnable from the cockpit root, raise testing.stages[].timeout_seconds for a stage that timed out, or declare testing.stages[].select.<kind> for a --select a stage lacks. VOID: stop changing the checkouts and run the gate again. PARTIAL: only the complete gate can PASS, so run it without --select or --mode staged |
| `UPGRADE_ALREADY_CURRENT` | nothing to upgrade; to move to another version name it: npx --no cockpit upgrade --config <your cockpit.toml> <version> |
| `UPGRADE_INSTALL_FAILED` | fix what the package manager reported (is the version published?), then run npx --no cockpit upgrade --config <your cockpit.toml> <version> |
| `UPGRADE_PACKAGE_MANAGER_UNKNOWN` | keep exactly one of package-lock.json, pnpm-lock.yaml or yarn.lock at the cockpit root and put its package manager (npm, pnpm or yarn) on PATH, then run npx --no cockpit upgrade --config <your cockpit.toml> |
| `UPGRADE_REGISTRY_UNREACHABLE` | check the network, the registry login and that npm is on PATH, or name the version: npx --no cockpit upgrade --config <your cockpit.toml> <version> |
| `UPGRADE_SYNC_FAILED` | act on what sync reported above or put npx on PATH, then run npx --no cockpit sync --config <your cockpit.toml> |
| `UPGRADE_VERSION_INVALID` | give a full version such as 1.2.3, not a range or tag |
| `WORK_CHECK_FAILED` | read result.results: fix the product for a check that failed, make one that did not run runnable from the cockpit root, then rerun npx --no cockpit work check --config <your cockpit.toml> --work-order <id> |
| `WORK_PERSON_REQUIRED` | stop and ask a person to run the same command with --interactive in a terminal outside CI, read what it shows, and type the digest; never type it for them |
| `WORK_VERIFY_FAILED` | for an order changed since acceptance, run npx --no cockpit work accept --config <your cockpit.toml> --work-order <id> or revert the change; for a done order without a passing grade, regrade it with work grade |
<!-- cockpit:diagnostic-index:end -->
