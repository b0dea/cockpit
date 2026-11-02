# Troubleshooting

<!-- cockpit:verified version=0.0.0 -->

This page is for anyone holding a cockpit diagnostic code: what it means and what to do. Look the
code up in the index at the end; remedies grouped by family are in the
[environment reference](environment.md#respond-to-diagnostic-codes).

Human output spells common refusals as **What failed**, **Why it matters** and **Fix**. Use
`--json` only when a program needs the machine-readable envelope. Each command's flags are in its
help, for example `cockpit sync --help`.

## Common refusal guidance

| Diagnostic | Why it stops | Fix |
| --- | --- | --- |
| `INIT_CANONICAL_OWNERSHIP_MISSING` | The saved bootstrap stage and generated ownership disagree. | Restore the committed ownership metadata, then rerun the same `npx --no cockpit init . --target <target>` command. |
| `SURFACE_SOURCE_UNAVAILABLE` | A declared sibling source cannot be read or checked. | Restore the named checkout at its declared path, then rerun `npx --no cockpit sync --config cockpit.toml`. |
| `SURFACE_OWNERSHIP_INVALID` | Cockpit cannot tell which settings it may replace. | Restore the last committed ownership metadata, then rerun `npx --no cockpit sync --config cockpit.toml`. |
| `SURFACE_STATE_CONFLICT` | Sync would overwrite settings cockpit does not own. | Review the file and use `npx --no cockpit sync --adopt <path> --config cockpit.toml` only with a person's approval. |
| `GENERATED_ARTIFACT_DRIFT` | Generated files no longer match the canonical configuration. | Review the diff, run `npx --no cockpit sync --config cockpit.toml`, then retry. |
| `GENERATED_OWNERSHIP_INVALID` | Cockpit has no trustworthy record of which files it owns. | Restore the committed ownership metadata, then rerun `npx --no cockpit sync --config cockpit.toml`. |
| `GUARD_AUTHORITY_UNAVAILABLE` | The guard cannot read the current policy it needs to decide safely. | Restore `cockpit.toml` and generated guard files, then have a human run `npx --no cockpit sync --config cockpit.toml`. |
| `GUARD_REFUSED` | The command is outside the current guard policy. | Follow the named reason, or ask a human to update `cockpit.toml` and run `npx --no cockpit sync --config cockpit.toml`. |
| `RUNTIME_UNAVAILABLE` | The container runtime cannot be reached. | Start it, verify `docker info`, then retry. |
| `RUNTIME_UNMEASURED` | This machine has no passing measurement for the current runtime and engine version. | Run `npx --no cockpit runtime measure --config cockpit.toml --image <local-image>`, which records the result for this machine only, then retry. |
| `CLAIM_CO_TENANT` | Another [holder](concepts.md#holder) is using the stack. | After a failed `up`, run `npx --no cockpit up --config cockpit.toml` to resume or `npx --no cockpit down --config cockpit.toml` to release. Otherwise, have every session that holds the stack run `npx --no cockpit sleep --config cockpit.toml`, then retry. |
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
[Adopt existing agent settings](adoption.md#adopt-existing-agent-settings).
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
server disabled; add it to `[mcp].approved` only after reviewing its command, arguments, working
directory, environment names, and sources. `MCP_APPROVAL_UNKNOWN` means the allowlist names no
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
`null` where a probe belongs. For a missing or stale file, write a fresh one with
`npx --no cockpit selftest --config <path> --write-probe-specifications <new file>` and fill in its
`null` fields; do not edit the stored digests. For a `null`, fill in the rows the message lists.
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
`sleep` warn with `STATE_RECORD_MALFORMED`, name that directory and the `rm -rf` command, and
ignore its port leases. Remove it with the same steps once no cockpit uses it.

<!-- cockpit:diagnostic-index:begin -->
Each diagnostic message names what failed and how to fix it. Where a code always has the same fix, the table repeats it; otherwise it says "see the message". [Respond to diagnostic codes](environment.md#respond-to-diagnostic-codes) explains each family of codes.

| Diagnostic | What to do |
| --- | --- |
| `ADOPTION_EMPTY` | see the message |
| `ADOPTION_ENCODING_INVALID` | see the message |
| `ADOPTION_NOT_FOUND` | see the message |
| `ADOPTION_ORDER_INVALID` | see the message |
| `ADOPTION_RECORD_INVALID` | see the message |
| `ADOPTION_STATE_INVALID` | see the message |
| `ADOPTION_TOO_LARGE` | see the message |
| `ADOPTION_UNREADABLE` | see the message |
| `BOOTSTRAP_ANSWER_RESET_FIELD_INVALID` | see the message |
| `BOOTSTRAP_ANSWER_RESET_INDETERMINATE` | see the message |
| `BOOTSTRAP_ANSWER_RESET_STALE` | see the message |
| `BOOTSTRAP_ANSWER_RESET_UNAVAILABLE` | see the message |
| `CHECKOUT_ADJACENCY_UNHEALTHY` | see the message |
| `CLAIM_CO_TENANT` | see the message |
| `CLAIM_LIVENESS_UNKNOWN` | see the message |
| `CLAIM_STATE_UNHEALTHY` | see the message |
| `CLI_COMMAND_REQUIRED` | see the message |
| `CLI_INTERNAL_ERROR` | see the message |
| `CLI_PLATFORM_UNSUPPORTED` | see the message |
| `CLI_UNKNOWN_COMMAND` | see the message |
| `CLI_USAGE_INVALID` | see the message |
| `COCKPIT_REVISION_INVALID` | reinstall @b0dea/cockpit from the registry or from a tarball packed from an unmodified checkout, then retry |
| `COCKPIT_REVISION_UNSTAMPED` | install a released @b0dea/cockpit when the resolved data must name the exact cockpit source commit |
| `COCKPIT_VERSION_MISMATCH` | see the message |
| `CODEX_HOOK_UNTRUSTED` | if you use Codex in this cockpit, a person runs codex -C <cockpit root> in a terminal (not codex exec), trusts the folder if asked, and chooses "Trust all and continue" when Codex shows "Hooks need review" (or enables and trusts the hook in its /hooks view); then run npx --no cockpit doctor --config <your cockpit.toml> |
| `COMPOSE_BIND_UNDECLARED` | see the message |
| `COMPOSE_HEALTHCHECK_MISSING` | see the message |
| `COMPOSE_IMAGE_UNPINNED` | see the message |
| `COMPOSE_PORT_ALL_INTERFACES` | see the message |
| `COMPOSE_PORT_NOT_LEASED` | see the message |
| `COMPOSE_SIBLING_NOT_MOUNTED` | see the message |
| `COMPOSE_TOPOLOGY_UNAVAILABLE` | install Docker with the Compose plugin on PATH and make `docker compose config` succeed for environment.compose_files |
| `CONFIG_CHANGED_DURING_EXECUTION` | see the message |
| `CONFIG_ENCODING_INVALID` | see the message |
| `CONFIG_NOT_FOUND` | see the message |
| `CONFIG_PARSE_INVALID` | see the message |
| `CONFIG_SCHEMA_INVALID` | see the message |
| `CONFIG_STALE` | see the message |
| `CONFIG_UNREADABLE` | see the message |
| `DATA_MODE_UNAVAILABLE` | see the message |
| `DECLARATION_UNCONFIRMED` | confirm each value with whoever owns the product and correct it in cockpit.toml if it is wrong, delete each confirmed entry from unconfirmed, then run npx --no cockpit sync --config <your cockpit.toml> |
| `DEPENDENCY_RUNTIME_INCOMPATIBLE` | see the message |
| `DEPENDENCY_RUNTIME_STALE` | see the message |
| `DEPENDENCY_RUNTIME_UNAVAILABLE` | see the message |
| `DEPENDENCY_RUNTIME_UNMOUNTED` | see the message |
| `DIRECTORY_GRANTS_UNAVAILABLE` | see the message |
| `DOCEV050_NAMED_REFERENCE_MISSING` | see the message |
| `DOCUMENT_ANSWER_UNCONFIRMED` | see the message |
| `DOCUMENT_CONFIGURATION_ANSWER_EXTRA` | see the message |
| `DOCUMENT_CONFIGURATION_ANSWER_INVALID` | see the message |
| `DOCUMENT_CONFIGURATION_ANSWER_STALE` | see the message |
| `DOCUMENT_CONFIGURATION_APPLICABILITY_INVALID` | see the message |
| `DOCUMENT_CONFIGURATION_INVALID` | see the message |
| `DOCUMENT_DEFAULT` | see the message |
| `DOCUMENT_DEFAULT_CONFIRMATION_INVALID` | see the message |
| `DOCUMENT_ESTATE_GAPS_INVALID` | see the message |
| `DOCUMENT_ESTATE_INCOMPLETE` | see the message |
| `DOCUMENT_ESTATE_OBSERVATION_CHANGED` | see the message |
| `DOCUMENT_ESTATE_OBSERVATION_INVALID` | see the message |
| `DOCUMENT_ESTATE_TOPOLOGY_MISMATCH` | see the message |
| `DOCUMENT_GAP` | confirm or replace the attributed default; supply this value before treating the draft as valid |
| `DOCUMENT_GUARD_HOSTS_NONE` | list the hosts in guards.hosted_db_hosts and guards.vendor_endpoint_hosts and run npx --no cockpit sync --config <your cockpit.toml> once a non-local environment exists |
| `DOCUMENT_INFERRED` | see the message |
| `DOCUMENT_NO_RUNNABLE_PRODUCT` | see the message |
| `DOCUMENT_OPTION_DUPLICATE` | see the message |
| `DOCUMENT_OUTPUT_JSON_UNSUPPORTED` | see the message |
| `DOCUMENT_ROOT_COUNT` | see the message |
| `DOCUMENT_RUNNABLE_TOPOLOGY_MISMATCH` | see the message |
| `DOCUMENT_RUNTIME_NOT_DECLARED` | once a product runs, declare environment.compose_files or [environment.generated] and run npx --no cockpit sync --config <your cockpit.toml> |
| `DOCUMENT_SOURCE_CONFLICT` | see the message |
| `DOCUMENT_SOURCE_REQUIRED` | see the message |
| `DOCUMENT_STDOUT_TARGET` | see the message |
| `DOWN_RESOURCES_KEPT` | see the message |
| `DRAIN_ATTEMPT_REPAIR_REQUIRED` | see the message |
| `ENVIRONMENT_FILE_MALFORMED` | see the message |
| `ENVIRONMENT_FILE_NOT_FOUND` | see the message |
| `ENVIRONMENT_FILE_TOO_LARGE` | see the message |
| `ENVIRONMENT_FILE_UNREADABLE` | see the message |
| `ENVIRONMENT_KEYS_STALE` | see the message |
| `ENVIRONMENT_NOT_DECLARED` | declare environment.compose_files = ["compose.yml"] to run your own Compose file, or [environment.generated] to have cockpit render one, then run npx --no cockpit sync --config <your cockpit.toml> |
| `ENVIRONMENT_SEED_FAILED` | see the message |
| `ENVIRONMENT_SEED_PRECONDITION_CHANGED` | see the message |
| `ENV_SCHEMA_TOOL_MISSING` | see the message |
| `ENV_SCHEMA_UNHEALTHY` | see the message |
| `EVALUATOR_UNAVAILABLE` | install the Codex CLI with npm install -g @openai/codex, sign in with codex login, then run npx --no cockpit doctor --config <your cockpit.toml> |
| `EVIDENCE_BASELINE_MISSING` | see the message |
| `EVIDENCE_UNAVAILABLE` | see the message |
| `EXECUTION_ABORTED` | see the message |
| `EXECUTION_COMPENSATION_STEP_FAILED` | see the message |
| `EXECUTION_COMPENSATION_TIMEOUT` | see the message |
| `EXECUTION_PRECONDITION_CHANGED` | see the message |
| `EXECUTION_SPAWN_FAILED` | see the message |
| `EXECUTION_STAGING_CLEANUP_FAILED` | see the message |
| `EXECUTION_STAGING_FAILED` | see the message |
| `EXECUTION_STDERR_LIMIT` | see the message |
| `EXECUTION_STDOUT_LIMIT` | see the message |
| `EXECUTION_STEP_FAILED` | see the message |
| `EXECUTION_TERMINATION_UNCONFIRMED` | see the message |
| `EXECUTION_TIMEOUT` | see the message |
| `EXTERNAL_DEPENDENCIES_UNAVAILABLE` | see the message |
| `EXTERNAL_DEPENDENCY_DECLARATION_INVALID` | see the message |
| `EXTERNAL_DEPENDENCY_EVIDENCE_UNAVAILABLE` | see the message |
| `EXTERNAL_DEPENDENCY_EXECUTION_UNAVAILABLE` | see the message |
| `EXTERNAL_DEPENDENCY_EXPIRED` | see the message |
| `EXTERNAL_DEPENDENCY_SHADOW_UNAVAILABLE` | see the message |
| `EXTERNAL_DEPENDENCY_TEMPLATE_MISMATCH` | see the message |
| `GENERATED_ARTIFACT_DRIFT` | see the message |
| `GENERATED_ARTIFACT_MISSING` | see the message |
| `GENERATED_COMPENSATION_FAILED` | see the message |
| `GENERATED_COMPOSE_INVALID` | see the message |
| `GENERATED_DECISIONS_UNDECIDED` | see the message |
| `GENERATED_DECISION_COVERAGE` | see the message |
| `GENERATED_DECISION_DUPLICATE` | see the message |
| `GENERATED_DECISION_FUTURE` | see the message |
| `GENERATED_DECISION_SENSITIVE` | see the message |
| `GENERATED_DECISION_STALE` | see the message |
| `GENERATED_DECLARATION_INVALID` | see the message |
| `GENERATED_DECLARATION_MISSING` | see the message |
| `GENERATED_ENVIRONMENT_UNAVAILABLE` | see the message |
| `GENERATED_EXECUTABLE_UNAVAILABLE` | see the message |
| `GENERATED_INPUT_INVALID` | see the message |
| `GENERATED_INSPECTION_INVALID` | see the message |
| `GENERATED_OWNERSHIP_DRIFT` | see the message |
| `GENERATED_OWNERSHIP_FORMAT_UNSUPPORTED` | see the message |
| `GENERATED_OWNERSHIP_INVALID` | see the message |
| `GENERATED_OWNERSHIP_MISSING` | see the message |
| `GENERATED_PATH_DUPLICATE` | see the message |
| `GENERATED_PATH_UNOWNED` | see the message |
| `GENERATED_PATH_UNSAFE` | see the message |
| `GENERATED_PERSONA_INVALID` | see the message |
| `GENERATED_PERSONA_SOURCE_UNAVAILABLE` | see the message |
| `GENERATED_PUBLICATION_FAILED` | see the message |
| `GENERATED_REFERENCE_BOOTSTRAP_INVALID` | see the message |
| `GENERATED_REFERENCE_OWNERSHIP_INVALID` | see the message |
| `GENERATED_RENDER_UNAUTHENTICATED` | see the message |
| `GENERATED_SIBLING_ROOT_INVALID` | see the message |
| `GENERATED_SOURCE_CHANGED` | see the message |
| `GENERATED_STALE_APPROVAL_INVALID` | see the message |
| `GENERATED_STALE_APPROVAL_REQUIRED` | a person runs npx --no cockpit sync --config <your cockpit.toml> --interactive in a terminal outside CI, reviews the stale entries it lists, and types the digest it shows only if every removal is intended |
| `GENERATED_STALE_ARTIFACT` | see the message |
| `GENERATED_STALE_ARTIFACT_DRIFT` | see the message |
| `GENERATED_TEMPLATE_INVALID` | see the message |
| `GIT_COMPARISON_REMOTE_MISMATCH` | see the message |
| `GIT_STATE_UNHEALTHY` | see the message |
| `GREENFIELD_ANSWER_INVALID` | see the message |
| `GREENFIELD_ANSWER_REQUIRED` | see the message |
| `GREENFIELD_ANSWER_UNEXPECTED` | see the message |
| `GREENFIELD_DISCOVERY_UNAVAILABLE` | see the message |
| `GREENFIELD_OBSERVATION_CHANGED` | see the message |
| `GREENFIELD_OBSERVATION_INVALID` | see the message |
| `GUARD_AUTHORITY_UNAVAILABLE` | see the message |
| `GUARD_HOSTS_UNDECLARED` | list the database and live vendor API hosts of every non-local environment (production, staging, shared) under [guards] in cockpit.toml, then run npx --no cockpit sync --config <your cockpit.toml>; if no such environment exists, record that by writing hosted_db_hosts = [] and vendor_endpoint_hosts = [] under [guards] |
| `GUARD_INPUT_UNAVAILABLE` | see the message |
| `GUARD_REFUSED` | see the message |
| `GUARD_TRANSPORT_INVALID` | see the message |
| `GUIDE_CAP_EXCEEDED` | see the message |
| `HARNESS_SURFACE_UNAVAILABLE` | see the message |
| `INIT_ANSWER_AMBIGUOUS` | see the message |
| `INIT_ANSWER_CONFLICT` | see the message |
| `INIT_ANSWER_FIELD_UNKNOWN` | see the message |
| `INIT_ANSWER_INVALID` | see the message |
| `INIT_ANSWER_RESET_CONFLICT` | see the message |
| `INIT_ANSWER_UNUSED` | see the message |
| `INIT_ARTIFACT_WRITE_FAILED` | see the message |
| `INIT_BOOTSTRAP_IDENTITY_CHANGED` | see the message |
| `INIT_CANONICAL_OWNERSHIP_MISSING` | see the message |
| `INIT_COCKPIT_ROOT_CREATE_FAILED` | see the message |
| `INIT_COCKPIT_ROOT_REQUIRED` | see the message |
| `INIT_COCKPIT_ROOT_UNAVAILABLE` | see the message |
| `INIT_DEFAULTS_NOT_ACCEPTED` | see the message |
| `INIT_DESTINATION_UNAVAILABLE` | see the message |
| `INIT_DRAFT_CHANGED` | see the message |
| `INIT_DRAFT_INVALID` | see the message |
| `INIT_DRAFT_SOURCE_CHANGED` | see the message |
| `INIT_INTERVIEW_LIMIT_EXCEEDED` | see the message |
| `INIT_INTERVIEW_PREVIEW_UNAVAILABLE` | see the message |
| `INIT_PREVIEW_CHANGED` | see the message |
| `INIT_PREVIEW_NOT_ACCEPTED` | see the message |
| `INIT_ROOT_INVALID` | see the message |
| `INIT_ROOT_OBSERVATION_FAILED` | see the message |
| `INIT_STATE_DURABILITY_INDETERMINATE` | see the message |
| `INIT_STATE_STALE` | see the message |
| `INIT_STATE_UNAUTHENTICATED` | see the message |
| `INIT_TARGET_CHANGED` | see the message |
| `INIT_TERMINAL_REQUIRED` | see the message |
| `INIT_UNAVAILABLE` | see the message |
| `INSTALL_LOAD_PROBE_FAILED` | see the message |
| `INSTALL_LOCKFILE_CHANGED` | see the message |
| `INSTALL_LOCK_HELD` | see the message |
| `INSTALL_LOCK_INVALID` | see the message |
| `INSTALL_POLICY_AMBIGUOUS` | see the message |
| `INSTALL_POLICY_MISSING` | see the message |
| `INSTALL_POLICY_OBSERVATION_INVALID` | see the message |
| `INSTALL_POLICY_OBSERVATION_UNAVAILABLE` | see the message |
| `INSTALL_STALE_PATH` | see the message |
| `INSTALL_STATE_UNHEALTHY` | see the message |
| `INSTANCE_NOT_IGNORED` | see the message |
| `LIFECYCLE_EVIDENCE_INVALID` | see the message |
| `LIFECYCLE_PROGRESS_INVALID` | see the message |
| `LOGS_TRUNCATED` | lower --tail to the number of recent records you need, or read the older records from the container runtime directly |
| `MACHINE_COLD_START_EXCEEDED` | make the services start faster, or raise environment.machine.cold_start_seconds in cockpit.toml above the measured time and run npx --no cockpit sync --config <your cockpit.toml>; then run npx --no cockpit down --config <your cockpit.toml> and npx --no cockpit up --config <your cockpit.toml> |
| `MACHINE_CPU_BELOW_FLOOR` | give the container runtime more resources (its VM or Docker Desktop settings) or lower the declared environment.machine floor in cockpit.toml deliberately and run npx --no cockpit sync --config <your cockpit.toml>, then retry |
| `MACHINE_DISK_BELOW_FLOOR` | give the container runtime more resources (its VM or Docker Desktop settings) or lower the declared environment.machine floor in cockpit.toml deliberately and run npx --no cockpit sync --config <your cockpit.toml>, then retry |
| `MACHINE_MEMORY_BELOW_FLOOR` | give the container runtime more resources (its VM or Docker Desktop settings) or lower the declared environment.machine floor in cockpit.toml deliberately and run npx --no cockpit sync --config <your cockpit.toml>, then retry |
| `MCP_APPROVAL_UNKNOWN` | see the message |
| `MCP_COMMAND_CONFLICT` | see the message |
| `MCP_DECLARATION_INVALID` | see the message |
| `MCP_INPUT_INVALID` | see the message |
| `MCP_NOT_APPROVED` | to enable it, add its name to [mcp].approved in cockpit.toml and run npx --no cockpit sync --config <your cockpit.toml>; to keep it off, nothing is needed |
| `MOUNT_MATERIALIZATION_UNAVAILABLE` | see the message |
| `MOUNT_POSTURE_UNAVAILABLE` | see the message |
| `OUTPUT_EXISTS` | choose a new path; replacement requires a future explicit option |
| `OUTPUT_WRITE_FAILED` | see the message |
| `OVERRIDDEN_CORE_CHANGED` | review the new built-in against your override, set the overlay's replaces.sha256 to the current digest this message names, then run npx --no cockpit sync --config <your cockpit.toml> |
| `PORT_EXTERNAL_REGISTRATION_GAP` | see the message |
| `PORT_FAMILY_COLLISION` | see the message |
| `PORT_FAMILY_OUT_OF_RANGE` | see the message |
| `PORT_LEASE_EXHAUSTED` | see the message |
| `PORT_LISTENER_EVIDENCE_INVALID` | see the message |
| `PORT_LOCAL_VALUE_CORRECTED` | see the message |
| `PROJECTION_GRANT_MISMATCH` | see the message |
| `PROJECTION_GUIDE_CHANGED` | see the message |
| `PROJECTION_GUIDE_CLOSE_FAILED` | see the message |
| `PROJECTION_GUIDE_ESCAPE` | see the message |
| `PROJECTION_GUIDE_READ_FAILED` | see the message |
| `PROJECTION_GUIDE_UNAVAILABLE` | see the message |
| `PROJECTION_INPUT_INVALID` | see the message |
| `PROJECTION_MOUNT_MISMATCH` | see the message |
| `PROJECTION_RESULT_BOUNDS` | see the message |
| `PROJECTION_ROOT_AMBIGUOUS` | see the message |
| `RECLAIM_ACCOUNTING_MISMATCH` | see the message |
| `RECLAIM_LABEL_ESCAPE` | see the message |
| `REFERENCE_INPUT_INVALID` | see the message |
| `REGISTRY_ADOPTION_REQUIRED` | see the message |
| `REGISTRY_AMBIGUOUS` | see the message |
| `REGISTRY_ARTIFACT_UNSAFE` | see the message |
| `REGISTRY_AUTH_UNAVAILABLE` | see the message |
| `REGISTRY_DIR_DUPLICATE` | see the message |
| `REGISTRY_DIR_OUTSIDE_SIBLINGS_ROOT` | see the message |
| `REGISTRY_EFFECTIVE_CONFIG_INVALID` | see the message |
| `REGISTRY_EMPTY` | see the message |
| `REGISTRY_ENCODING_INVALID` | see the message |
| `REGISTRY_GENERATED_BASELINE_MISSING` | see the message |
| `REGISTRY_INPUT_INVALID` | see the message |
| `REGISTRY_NOT_FOUND` | see the message |
| `REGISTRY_OPTION_DUPLICATE` | see the message |
| `REGISTRY_OUTPUT_UNSUPPORTED` | see the message |
| `REGISTRY_POSITIONAL_UNSUPPORTED` | see the message |
| `REGISTRY_ROW_SKIPPED` | repair every skipped row before documenting repository scope |
| `REGISTRY_SIBLINGS_ROOT_REQUIRED` | see the message |
| `REGISTRY_SOURCE_REQUIRED` | see the message |
| `REGISTRY_TOO_LARGE` | see the message |
| `REGISTRY_UNREADABLE` | see the message |
| `REGISTRY_VARIABLE_INVALID` | see the message |
| `RESET_CONFIRMATION_MISMATCH` | see the message |
| `RESET_CONFIRMATION_REQUIRED` | see the message |
| `RESET_CO_TENANT` | see the message |
| `RESTRICTION_ADAPTER_INVALID` | see the message |
| `RESTRICTION_EVENT_UNADAPTED` | see the message |
| `RESTRICTION_INPUT_INVALID` | see the message |
| `RESTRICTION_OUTPUT_LIMIT` | see the message |
| `RESTRICTION_TEMPLATE_INVALID` | see the message |
| `RUNNING_CHECKOUT_MISMATCH` | see the message |
| `RUNTIME_COMPOSE_REMOTE` | see the message |
| `RUNTIME_IMAGE_UNAVAILABLE` | see the message |
| `RUNTIME_LAUNCHER_UNAVAILABLE` | see the message |
| `RUNTIME_PROBE_TIMEOUT` | see the message |
| `RUNTIME_UNAVAILABLE` | see the message |
| `RUNTIME_UNMEASURED` | see the message |
| `SELFTEST_EXECUTION_INVALID` | see the message |
| `SELFTEST_SOURCE_INVALID` | replace each null in the listed rows with the probe for that tool, then rerun selftest with the same file; write a new file with npx --no cockpit selftest --config <your cockpit.toml> --write-probe-specifications <new file>, fill the fields it lists, then pass that file to --probe-specifications |
| `SERVICE_NOT_DECLARED` | rerun with --service set to one of the declared services |
| `SESSION_STACK_RETAINED` | run npx --no cockpit sleep --config <your cockpit.toml> to release this checkout's remaining hold |
| `SETUP_CLONE_FAILED` | see the message |
| `SETUP_CONFIG_REQUIRED` | see the message |
| `SETUP_INSTRUCTION_POINTER_INVALID` | see the message |
| `SETUP_INSTRUCTION_POINTER_OFFERED` | see the message |
| `SETUP_MANUAL_MISSING` | see the message |
| `SETUP_NONE_ABSENT` | see the message |
| `SETUP_NONE_DIRECTORY` | see the message |
| `SETUP_NONE_REPOSITORY` | see the message |
| `SETUP_OPTION_DUPLICATE` | see the message |
| `SETUP_PARENT_MISSING` | see the message |
| `SETUP_PATH_OUTSIDE_ROOT` | see the message |
| `SETUP_PATH_SYMLINK` | see the message |
| `SETUP_PATH_TYPE_INVALID` | see the message |
| `SETUP_POSITIONAL_UNSUPPORTED` | see the message |
| `SETUP_POSTCHECK_FAILED` | see the message |
| `SETUP_REMOTE_MISMATCH` | see the message |
| `SIBLING_DIRECTORY_MISSING` | see the message |
| `SIBLING_DIR_DUPLICATE` | see the message |
| `SIBLING_GIT_FAILED` | see the message |
| `SIBLING_MISSING` | see the message |
| `SIBLING_NOT_FOUND` | see the message |
| `SIBLING_PATH_NOT_EMPTY` | see the message |
| `SIBLING_REFERENCED` | see the message |
| `SIBLING_REMOTE_MISSING` | see the message |
| `SIBLING_SLUG_DUPLICATE` | see the message |
| `SIBLING_STACK_RECORDED` | see the message |
| `SIBLING_VAR_DUPLICATE` | see the message |
| `SKILL_BUDGET_UNAVAILABLE` | see the message |
| `SKILL_COMMAND_UNDECLARED` | see the message |
| `SKILL_CONTRACT_INVALID` | see the message |
| `SKILL_DECISION_LOGIC_EMBEDDED` | see the message |
| `SKILL_ENTRY_POINT_EXCEEDED` | see the message |
| `SKILL_FRONTMATTER_INVALID` | see the message |
| `SKILL_IDENTITY_INVALID` | see the message |
| `SKILL_INPUT_INVALID` | see the message |
| `SKILL_NAME_DUPLICATE` | see the message |
| `SKILL_PROCEDURE_MISSING` | see the message |
| `SKILL_PROJECTION_INVALID` | see the message |
| `SKILL_RENDER_INVALID` | see the message |
| `SKILL_RENDER_INVENTORY_INVALID` | see the message |
| `SKILL_STANDING_COST_EXCEEDED` | see the message |
| `SKILL_TOOL_EQUIVALENCE_MISSING` | see the message |
| `STACK_NOT_RUNNING` | see the message |
| `STACK_RECORDED_UNDER_EARLIER_NAME` | see the message |
| `STATE_DURABILITY_INDETERMINATE` | see the message |
| `STATE_FORMAT_UNSUPPORTED` | see the message |
| `STATE_LOCKED` | see the message |
| `STATE_RECORD_MALFORMED` | see the message |
| `STATE_ROOT_UNAVAILABLE` | see the message |
| `STATE_UNSEEDED` | see the message |
| `SURFACE_ADOPTION_REFUSED` | see the message |
| `SURFACE_ARTIFACT_INVALID` | see the message |
| `SURFACE_BOUNDS` | see the message |
| `SURFACE_CLEANUP_FAILED` | see the message |
| `SURFACE_CUSTOM_REFUSED` | see the message |
| `SURFACE_FEATURE_COVERAGE` | see the message |
| `SURFACE_GENERATION_FAILED` | see the message |
| `SURFACE_GENERATOR_TRUST_WARNING` | see the message |
| `SURFACE_INPUT_INVALID` | see the message |
| `SURFACE_KIND_AMBIGUOUS` | see the message |
| `SURFACE_NAME_DUPLICATE` | see the message |
| `SURFACE_NODE_UNAVAILABLE` | see the message |
| `SURFACE_OUTPUT_COVERAGE` | see the message |
| `SURFACE_OVERRIDE_INSPECTION_INVALID` | see the message |
| `SURFACE_OVERRIDE_INSPECTION_PATH_MISMATCH` | see the message |
| `SURFACE_OVERRIDE_INSPECTION_REFUSED` | see the message |
| `SURFACE_OVERRIDE_INSPECTION_UNAVAILABLE` | see the message |
| `SURFACE_OVERRIDE_INVALID` | see the message |
| `SURFACE_OWNERSHIP_INVALID` | see the message |
| `SURFACE_PACKAGE_UNAVAILABLE` | see the message |
| `SURFACE_PATH_CONFLICT` | see the message |
| `SURFACE_RULE_SCOPE_UNSUPPORTED` | see the message |
| `SURFACE_SCRATCH_UNAVAILABLE` | see the message |
| `SURFACE_SOURCE_UNAVAILABLE` | see the message |
| `SURFACE_STAGE_VARIANCE` | see the message |
| `SURFACE_STAGING_FAILED` | see the message |
| `SURFACE_STATE_CONFLICT` | see the message |
| `SURFACE_WORKER_NONZERO` | see the message |
| `SURFACE_WORKER_OUTPUT` | see the message |
| `SURFACE_WORKER_SIGNAL` | see the message |
| `SURFACE_WORKER_STDERR` | see the message |
| `SURFACE_WORKER_TIMEOUT` | see the message |
| `TEAM_METADATA_UNAVAILABLE` | see the message |
| `TEMPLATE_IGNORED` | see the message |
| `TEMPLATE_NOT_FOUND` | see the message |
| `TEMPLATE_NOT_TRACKED` | see the message |
| `TEMPLATE_PATH_OUTSIDE_ROOT` | see the message |
| `TESTING_GATE_UNDECLARED` | declare the product test commands as [testing] stages with a targeted and a full gate in cockpit.toml, then run npx --no cockpit sync --config <your cockpit.toml> |
| `TEST_GATE_UNSATISFIED` | read result.verdict and result.observations: fix the product for FAIL, restore what a DEGRADED stage names, rerun a VOID gate once the tree is unchanged, and run the complete gate without --select for PASS |
| `UPGRADE_AUTH_FAILED` | see the message |
| `UPGRADE_DISCOVERY_INVALID` | see the message |
| `UPGRADE_NETWORK_FAILED` | see the message |
| `UPGRADE_REPAIR_UNVERIFIED` | see the message |
| `UPGRADE_SOURCE_INVALID` | see the message |
| `UPGRADE_VERSION_AMBIGUOUS` | see the message |
| `WORK_APPLICATION_REFUSED` | see the message |
| `WORK_EXECUTION_PAUSED` | read result.reason and result.verification, fix the cause, then rerun npx --no cockpit work-execute --config <your cockpit.toml> --work-order <id> --approach <text> |
| `WORK_GRADE_UNSATISFIED` | read result.criteria: fix the product for a criterion that failed after execution, make a check that never ran runnable, then rerun npx --no cockpit work-grade --config <your cockpit.toml> --work-order <id> |
| `WORK_OPERATOR_REQUIRED` | see the message |
| `WO_ACCEPTANCE_DECLINED` | see the message |
| `WO_ACCEPTANCE_INVALID` | see the message |
| `WO_ACCEPTANCE_REPLAY` | see the message |
| `WO_ACCEPTANCE_STALE` | see the message |
| `WO_AUDIT_INVALID` | see the message |
| `WO_AUTHORITY_INVALID` | see the message |
| `WO_CONTRACT_INVALID` | see the message |
| `WO_CONTRADICTION` | see the message |
| `WO_CRITERIA_INVALID` | see the message |
| `WO_DECISION_INVALID` | see the message |
| `WO_ENCODING_INVALID` | see the message |
| `WO_EVIDENCE_INVALID` | see the message |
| `WO_FIELD_INVALID` | see the message |
| `WO_FRONTMATTER_INVALID` | see the message |
| `WO_HUMAN_PARK` | see the message |
| `WO_ID_EXISTS` | see the message |
| `WO_INVESTIGATION_PATH` | see the message |
| `WO_KEY_DUPLICATE` | see the message |
| `WO_KEY_UNKNOWN` | see the message |
| `WO_LINE_BYTES_LIMIT` | see the message |
| `WO_LINE_LIMIT` | see the message |
| `WO_METRICS_HISTORY` | see the message |
| `WO_METRICS_INVENTORY` | see the message |
| `WO_METRICS_PROCESS` | see the message |
| `WO_OPERATOR_REQUIRED` | see the message |
| `WO_PLAN_INVALID` | see the message |
| `WO_POLICY_INVALID` | see the message |
| `WO_PRESSURE_INVALID` | see the message |
| `WO_PRESSURE_UNCLASSIFIABLE` | see the message |
| `WO_PROGRAMME_CAP` | see the message |
| `WO_PROGRAMME_CONTRACT` | see the message |
| `WO_PROGRAMME_LEDGER` | see the message |
| `WO_PROGRAMME_ORDER` | see the message |
| `WO_PROGRAMME_PREDECESSOR` | see the message |
| `WO_PROGRAMME_PRESSURE` | see the message |
| `WO_PROGRAMME_SHIPPABILITY` | see the message |
| `WO_RENEWAL_DECISION_REQUIRED` | see the message |
| `WO_RESUME_AMBIGUOUS` | see the message |
| `WO_RESUME_AWAITING_GRADE` | see the message |
| `WO_RESUME_BLOCKED` | see the message |
| `WO_RESUME_NO_ACTIVE` | see the message |
| `WO_ROOT_CAUSE_REQUIRED` | see the message |
| `WO_ROUTE_REQUIRED` | see the message |
| `WO_SECTION_DUPLICATE` | see the message |
| `WO_SECTION_INVALID` | see the message |
| `WO_SECTION_MISSING` | see the message |
| `WO_SIZE_LIMIT` | see the message |
| `WO_SKILLS_INVALID` | see the message |
| `WO_SOURCE_GAPS` | see the message |
| `WO_SOURCE_INVALID` | see the message |
| `WO_STATE_CONFLICT` | see the message |
| `WO_STATE_CONTRADICTION` | see the message |
| `WO_STATE_INVALID` | see the message |
| `WO_STATE_PERSIST_FAILED` | see the message |
| `WO_STATUS_AMBIGUOUS` | see the message |
| `WO_STATUS_INVALID` | see the message |
| `WO_SWEEP_OBSERVATION` | see the message |
| `WO_SWEEP_REPLAY` | see the message |
| `WO_SWEEP_STALE` | see the message |
| `WO_SWEEP_WRITE_FAILED` | see the message |
| `WO_VERIFICATION_INVALID` | see the message |
| `WO_WIP_CAP` | see the message |
| `WO_WIP_INVALID` | see the message |
<!-- cockpit:diagnostic-index:end -->
