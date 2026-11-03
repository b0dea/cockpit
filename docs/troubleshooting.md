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
| `SURFACE_STATE_CONFLICT` | Sync would overwrite settings cockpit does not own. | Review the file and use `npx --no cockpit sync --adopt <path> --config cockpit.toml` only with a person's approval. |
| `GENERATED_ARTIFACT_DRIFT` | Generated files no longer match the canonical configuration. | Review the diff, run `npx --no cockpit sync --config cockpit.toml`, then retry. |
| `GENERATED_OWNERSHIP_INVALID` | Cockpit has no trustworthy record of which files it owns. | Restore the committed ownership metadata, then rerun `npx --no cockpit sync --config cockpit.toml`. |
| `GUARD_AUTHORITY_UNAVAILABLE` | The guard cannot read the current policy it needs to decide safely. | Restore `cockpit.toml` and generated guard files, then have a human run `npx --no cockpit sync --config cockpit.toml`. |
| `GUARD_REFUSED` | The command is outside the current guard policy. | Follow the named reason, or ask a human to update `cockpit.toml` and run `npx --no cockpit sync --config cockpit.toml`. |
| `RUNTIME_UNAVAILABLE` | The container runtime cannot be reached or identified. | Start it and verify `docker info`; if the message names a Docker or Compose version with no X.Y.Z core, install a release that prints one. Then retry. |
| `RUNTIME_UNMEASURED` | This machine has no passing measurement for the current runtime and engine version. | Run `npx --no cockpit runtime measure --config cockpit.toml --image <local-image>`, which records the result for this machine only, then retry. |
| `CLAIM_CO_TENANT` | Another [holder](concepts.md#holder) is using the stack. | After a failed `up`, run `npx --no cockpit up --config cockpit.toml` to resume or `npx --no cockpit down --config cockpit.toml` to release. Otherwise, have every session that holds the stack run `npx --no cockpit sleep --config cockpit.toml`, then retry. When the message names a process restoring the stack's data, wait for it or stop it, then retry: the retry releases a restore whose process has ended. |
| `PORT_FAMILY_COLLISION` | A selected host port is already in use. | Stop the named listener or release the inactive stack, then retry. |
| `PORT_LEASE_EXHAUSTED` | Every declared port family is leased or occupied. | Release an inactive stack or extend `ports.count` after checking host capacity. |
| `SETUP_MANUAL_MISSING` | A manually managed sibling checkout is absent. | Create it at the declared path, then rerun `npx --no cockpit setup --config cockpit.toml`. |
| `SETUP_REMOTE_MISMATCH` | The checkout remote and declaration name different sources. | Correct the remote or declaration, then rerun `npx --no cockpit setup --config cockpit.toml`. |

## GENERATED_ARTIFACT_DRIFT

**Cause.** An owned whole file, symlink target or shared region differs from what the environment
and surface declarations and their sources now produce. Per the
[generated environment contract](environment.md#generated-environment), `check` reports the
mismatch without changing any owned file.

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

Your product's services, paths, probes, data operations, and vendor values go in
`[environment.generated]` in <!-- cockpit:ref consumer=cockpit.toml --> `cockpit.toml`. Cockpit
writes its review record to
<!-- cockpit:ref consumer=docs/cockpit/environment-decisions.md --> `docs/cockpit/environment-decisions.md`.

## Harness surface failures

1. Read the target and message in the diagnostic.
2. Run `cockpit sync --config ./cockpit.toml --dry-run`; it prepares everything without changing
   the checkout.
3. Correct the named declaration or source, and repeat the preview.
4. Apply `sync`, then confirm the installed state with `check`.

Never edit the ownership manifest, a generated shared region or the selftest results to make a
diagnostic disappear.

`REGISTRY_INPUT_INVALID` or `REGISTRY_EFFECTIVE_CONFIG_INVALID` means the declared sibling row
cannot produce one valid registry and configuration. Correct the named row and its derived
service, mount, port, policy or MCP source, then retry the preview.

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
longer matches the bytes cockpit wrote. Keep the current bytes and find out who changed them
before retrying. For a team's own `.claude/settings.json`, `.codex/config.toml` or
`.codex/hooks.json`, the message names the `sync --adopt` command that keeps it; see
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

`SURFACE_GENERATOR_TRUST_WARNING` is a warning attached to an emitted Claude settings file that
changes additional-directory or MCP trust. Review that file before applying it; a warning does
not mean the harness enforces anything.

### MCP and restrictions

For `MCP_INPUT_INVALID` or `MCP_DECLARATION_INVALID`, correct the declaration, digest,
same-name environment reference, or confined working directory named by the message.
`MCP_COMMAND_CONFLICT` means two sources give one server name different commands; make them agree or give them distinct names. `MCP_NOT_APPROVED` leaves a declared
server disabled because `[mcp.approved]` has no entry for it, or its declaration changed since it
was approved; only after reviewing its command, arguments, working directory, environment names and
sources, set its name to the sha256 in the message under `[mcp.approved]`. `MCP_APPROVAL_UNKNOWN` means the allowlist names no
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

For `SKILL_INPUT_INVALID`, `SKILL_FRONTMATTER_INVALID`, `SKILL_CONTRACT_INVALID`,
`SKILL_IDENTITY_INVALID`, `SKILL_NAME_DUPLICATE`, `SKILL_TOOL_EQUIVALENCE_MISSING`,
`SKILL_PROCEDURE_MISSING`, `SKILL_COMMAND_UNDECLARED`, `SKILL_ENTRY_POINT_EXCEEDED`, or
`SKILL_DECISION_LOGIC_EMBEDDED`, correct the shipped skill entry point or shared procedure named
by the diagnostic. `SKILL_RENDER_INVALID` and `SKILL_RENDER_INVENTORY_INVALID` mean generated
files do not match the skill contract. `SKILL_STANDING_COST_EXCEEDED` means the always-loaded
skill entry points are too large. Shrink them; moving decision logic into another always-loaded
file is not a repair.

### Selftest and upgrade

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

None of the upgrade codes is a reason to install a package or edit a manifest by hand.

| Diagnostic | Meaning |
| --- | --- |
| `UPGRADE_SOURCE_INVALID` | The configuration path was not accepted. |
| `UPGRADE_NETWORK_FAILED`, `UPGRADE_AUTH_FAILED` | cockpit could not look up the release; repair that source and retry. `UPGRADE_AUTH_FAILED` also covers a missing or mismatched release-evidence file, SHA-256 or installed package identity: take the expected digest from the release attestation, not from the suspect file. |
| `UPGRADE_VERSION_AMBIGUOUS` | Discovery did not establish one compatible current and candidate package identity, version and integrity. This is the expected fail-closed result when no release evidence is supplied or the candidate is not strictly newer. |
| `UPGRADE_DISCOVERY_INVALID` | The discovery result or affected override list was malformed. |
| `UPGRADE_REPAIR_UNVERIFIED` | The source cannot establish that an earlier repair completed. |

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
| `CLAIM_CO_TENANT` | [see above](#common-refusal-guidance) |
| `COCKPIT_LAUNCHER_UNPROVEN` | run cockpit as ./node_modules/.bin/cockpit <command> --config <your cockpit.toml> from the cockpit root, or remove what stops npx from proving it: a .npmrc in the cockpit root, a bin or directories.bin in its package.json, or a node_modules/.bin/cockpit that npm install did not link to the installed package |
| `COCKPIT_REVISION_UNSTAMPED` | install a released @b00dea/cockpit when the resolved data must name the exact cockpit source commit |
| `CODEX_HOOK_UNTRUSTED` | if you use Codex in this cockpit, a person runs codex -C <cockpit root> in a terminal (not codex exec), trusts the folder if asked, and chooses "Trust all and continue" when Codex shows "Hooks need review" (or enables and trusts the hook in its /hooks view); then run npx --no cockpit doctor --config <your cockpit.toml> |
| `CONFIG_ENCODING_INVALID` | save the configuration as UTF-8, then retry |
| `DECLARATION_UNCONFIRMED` | confirm each value with whoever owns the product and correct it in cockpit.toml if it is wrong, delete each confirmed entry from unconfirmed, then run npx --no cockpit sync --config <your cockpit.toml> |
| `DOCUMENT_ESTATE_TOPOLOGY_MISMATCH` | declare one sibling for each repository the message says init observed, with that slug and dir, and no other; add any other repository after init with npx --no cockpit sibling add <slug> --config <your cockpit.toml> |
| `DOCUMENT_GUARD_HOSTS_NONE` | list the hosts in guards.hosted_db_hosts and guards.vendor_endpoint_hosts and run npx --no cockpit sync --config <your cockpit.toml> once a non-local environment exists |
| `DOCUMENT_RUNTIME_NOT_DECLARED` | once a product runs, declare environment.compose_files or [environment.generated] and run npx --no cockpit sync --config <your cockpit.toml> |
| `ENVIRONMENT_NOT_DECLARED` | declare environment.compose_files = ["compose.yml"] to run your own Compose file, or [environment.generated] to have cockpit render one, then run npx --no cockpit sync --config <your cockpit.toml> |
| `EVALUATOR_UNAVAILABLE` | install the Codex CLI with npm install -g @openai/codex, sign in with codex login, then run npx --no cockpit doctor --config <your cockpit.toml> |
| `EXECUTION_TERMINATION_UNCONFIRMED` | [see above](#merge-ownership-and-generation) |
| `GENERATED_ARTIFACT_DRIFT` | [see above](#generated_artifact_drift) |
| `GENERATED_DECLARATION_MISSING` | declare [environment.generated] for the runner, or remove browser.endpoint |
| `GENERATED_DEPENDENCY_VOLUME_MISSING` | set toolchain = "none" on the sibling if its image already holds its dependencies; otherwise give the sibling exactly one generated service and mount one dependency volume in it: a [[environment.generated.volumes]] row whose id and install_policy are the volume of an install policy for the sibling's toolchain, with purpose = "dependencies", and a mounts row in that service with kind = "volume", that source, and the target where the toolchain reads its dependencies; then run npx --no cockpit sync --config <your cockpit.toml> |
| `GENERATED_HOST_EXECUTABLE_UNSUPPORTED` | make argv[0] of the host operation "node", or run the command in a service: set location = "in-stack" and service to a generated service whose image has the tool |
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
| `REGISTRY_EFFECTIVE_CONFIG_INVALID` | [see above](#harness-surface-failures) |
| `REGISTRY_INPUT_INVALID` | [see above](#harness-surface-failures) |
| `RESTORE_INTERRUPTED` | run npx --no cockpit reset --config <your cockpit.toml>, which only previews the data it would delete; a person who agrees runs it again with --interactive and confirms. Then npx --no cockpit up --config <your cockpit.toml> restores the data again |
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
| `SELFTEST_EXECUTION_INVALID` | [see above](#selftest-and-upgrade) |
| `SELFTEST_SOURCE_INVALID` | [see above](#selftest-and-upgrade) |
| `SERVICE_NOT_DECLARED` | rerun with --service set to one of the declared services |
| `SESSION_STACK_RETAINED` | run npx --no cockpit sleep --config <your cockpit.toml> to release this checkout's remaining hold |
| `SETUP_CLONE_FAILED` | check that this machine can reach the remote (git ls-remote <remote>) and that the sibling remote in cockpit.toml is right, or clone it into the named directory yourself; then run npx --no cockpit setup --config <your cockpit.toml> again |
| `SETUP_INSTRUCTION_POINTER_OFFERED` | review the proposed AGENTS.md block, then run npx --no cockpit setup --config <your cockpit.toml> --write-instruction-pointers |
| `SETUP_MANUAL_MISSING` | create the checkout, then run npx --no cockpit setup --config <your cockpit.toml> again; [see above](#common-refusal-guidance) |
| `SETUP_REMOTE_MISMATCH` | [see above](#common-refusal-guidance) |
| `SETUP_REMOTE_UNRESOLVABLE` | make the remote path readable, or declare the remote as a URL or an absolute path to an existing repository, then run npx --no cockpit setup --config <your cockpit.toml> again |
| `SIBLING_GUIDE_MISSING` | correct or remove the guide name in that sibling's guides list in cockpit.toml, then run npx --no cockpit sync --config <your cockpit.toml> |
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
| `SURFACE_OVERRIDE_INSPECTION_INVALID` | [see above](#selftest-and-upgrade) |
| `SURFACE_OVERRIDE_INSPECTION_PATH_MISMATCH` | [see above](#selftest-and-upgrade) |
| `SURFACE_OVERRIDE_INSPECTION_REFUSED` | [see above](#selftest-and-upgrade) |
| `SURFACE_OVERRIDE_INSPECTION_UNAVAILABLE` | [see above](#selftest-and-upgrade) |
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
| `UPGRADE_AUTH_FAILED` | [see above](#selftest-and-upgrade) |
| `UPGRADE_DISCOVERY_INVALID` | [see above](#selftest-and-upgrade) |
| `UPGRADE_NETWORK_FAILED` | [see above](#selftest-and-upgrade) |
| `UPGRADE_REPAIR_UNVERIFIED` | [see above](#selftest-and-upgrade) |
| `UPGRADE_SOURCE_INVALID` | [see above](#selftest-and-upgrade) |
| `UPGRADE_VERSION_AMBIGUOUS` | [see above](#selftest-and-upgrade) |
| `WORK_EXECUTION_PAUSED` | read result.reason and result.verification, fix the cause, then rerun npx --no cockpit work execute --config <your cockpit.toml> --work-order <id> --approach <text> |
| `WORK_GRADE_UNSATISFIED` | read result.criteria: fix the product for a criterion that failed after execution, make a check that never ran runnable, then rerun npx --no cockpit work grade --config <your cockpit.toml> --work-order <id> |
<!-- cockpit:diagnostic-index:end -->
