# Troubleshooting

<!-- cockpit:verified version=0.0.0 -->

This page gives maintainers a short path from a cockpit diagnostic to its public contract,
implementation owner, tested remedy, and focused verification command. The full diagnostic
families remain in the [environment reference](environment.md#respond-to-diagnostic-codes).

## GENERATED_ARTIFACT_DRIFT

**Cause.** An owned whole file, symlink target, or shared region differs from the canonical state
derived from the authenticated environment and surface declarations or their sources. The
[generated environment contract](environment.md#generated-environment) requires `check` to report
that mismatch without changing any owned file.

**Remedy.** Inspect the target named in the diagnostic. Run:

```sh
cockpit check --config ./cockpit.toml
```

Review the declaration and source change. If the new canonical bytes are intended, publish the
complete owned manifest with:

```sh
cockpit sync --config ./cockpit.toml
```

Do not edit the ownership manifest or lifecycle state. If changed bytes belong to a formerly
owned path, preserve them until the declaration and ownership transition are understood.

**Ownership and extension seam.** Transactional rendering, inspection, publication, and recovery
belong to `packages/cockpit/src/environment/generated-application.ts`. The public type-preserving
adapter is `packages/cockpit/src/generated-environment/command.ts`, and canonical stack rendering
is in `packages/cockpit/src/environment/generated-stack.ts`. Product-specific services, paths,
probes, data operations, and vendor values enter through `[environment.generated]` in
<!-- cockpit:ref consumer=cockpit.toml --> `cockpit.toml`. The generated review record is
<!-- cockpit:ref consumer=docs/cockpit/environment-decisions.md --> `docs/cockpit/environment-decisions.md`.

**Test.** The full `sync`/`check` path is covered by
`packages/cockpit/src/generated-environment/command.publication-core.test.ts`, test title
`synchronizes one owned manifest idempotently and checks without mutation`. Run exactly:

```sh
NPM_CONFIG_CACHE=/tmp/b0-cockpit-npm-cache npm test -- packages/cockpit/src/generated-environment/command.publication-core.test.ts -t 'synchronizes one owned manifest idempotently and checks without mutation'
```

The candidate exit synchronizes canonical bytes, then completes `check` without mutation. The
adjacent broken control changes the authenticated persona source while retaining the old generated
bytes; `check` returns `GENERATED_ARTIFACT_DRIFT` for the persona output and leaves all owned bytes
unchanged. This proves the repository's generated-file detector. It does not turn unavailable
native runtime or vendor evidence into a measured result.

## Harness surface failures

Start with the target and message in the diagnostic, then run `cockpit sync --config
./cockpit.toml --dry-run`. The preview performs full preparation without changing the checkout.
After correcting the named declaration or source, repeat the preview before applying `sync`; use
`check` to confirm the installed state. Do not edit the ownership manifest, generated shared
region, or selftest evidence bundle to make a diagnostic disappear.

`REGISTRY_INPUT_INVALID` or `REGISTRY_EFFECTIVE_CONFIG_INVALID` means the declared sibling
row cannot produce one valid effective registry/configuration. Correct the named row and its
derived service, mount, port, policy, or MCP source before retrying the preview.

### Merge, ownership, and generation

`SURFACE_INPUT_INVALID`, `SURFACE_BOUNDS`, `SURFACE_NAME_DUPLICATE`,
`SURFACE_KIND_AMBIGUOUS`, `SURFACE_OVERRIDE_INVALID`, `SURFACE_PATH_CONFLICT`, and
`SURFACE_OWNERSHIP_INVALID` mean the canonical declarations, overlay identity, output paths, or
captured output failed admission. Correct the target named by the diagnostic. For an override,
compare it with the current core declaration and update
<!-- cockpit:ref schema=surfaces.overlays[].replaces.sha256 --> `surfaces.overlays[].replaces.sha256` only after reviewing the
new original. For a path conflict, change the declarations so one producer owns the path; do not
delete the existing path as a workaround.

`SURFACE_STATE_CONFLICT` means a shared region, stale entry, symlink, or prior ownership record no
longer matches the bytes cockpit previously owned. Preserve the current bytes and reconcile their
owner before retrying. `SURFACE_SOURCE_UNAVAILABLE` means a declared source or active sibling
could not be authenticated. Restore that source at its declared root and retry the dry run.
`SURFACE_CUSTOM_REFUSED` means the named custom harness module did not return a complete result
bound to its declaration and source digest, or an `enforced` row's evidence file was missing or
did not match its declared SHA-256. Inspect the module, evidence reference, and broken control.

`GENERATED_STALE_APPROVAL_REQUIRED` means a dry run identified stale entries but the apply has no
independent approval for its exact digest. Use `sync --interactive` from a terminal outside CI,
review the listed entries, and type the displayed digest only if each removal is intended.
`GENERATED_STALE_APPROVAL_INVALID` means the request could not be bound safely; inspect the
reported path and current ownership before retrying. Neither code permits deleting the path by
hand.

`SURFACE_NODE_UNAVAILABLE`, `SURFACE_PACKAGE_UNAVAILABLE`, and
`SURFACE_SCRATCH_UNAVAILABLE` identify a missing authenticated Node executable, the checked-in
Rulesync generator bundle, or a safe staging directory. Restore the exact cockpit package artifact
or the named local path. `SURFACE_STAGING_FAILED`, `SURFACE_WORKER_TIMEOUT`,
`SURFACE_WORKER_SIGNAL`, `SURFACE_WORKER_NONZERO`, `SURFACE_WORKER_STDERR`,
`SURFACE_WORKER_OUTPUT`, `SURFACE_OUTPUT_COVERAGE`, `SURFACE_FEATURE_COVERAGE`,
`SURFACE_STAGE_VARIANCE`, `SURFACE_ARTIFACT_INVALID`, and `SURFACE_CLEANUP_FAILED` identify the
bounded generator stage that failed. Use the captured target and stderr; do not run a second
generator and treat its output as cockpit evidence. The outer `SURFACE_GENERATION_FAILED` retains
that cause at the generated-environment boundary.

`EXECUTION_TERMINATION_UNCONFIRMED` means the process owner could not confirm that a surface
worker stopped. Cockpit retains the private staging path named by the diagnostic. Stop the
remaining workers before removing that directory, then retry the operation.

`SURFACE_GENERATOR_TRUST_WARNING` is a warning attached to an emitted Claude settings file that
changes additional-directory or MCP trust. Review that file before applying it; a warning does
not establish native enforcement.

### MCP and restrictions

For `MCP_INPUT_INVALID` or `MCP_DECLARATION_INVALID`, correct the bounded declaration, digest,
same-name environment reference, or confined working directory named by the message.
`MCP_COMMAND_CONFLICT` means two authenticated sources give one server name different execution
identities; make them agree or give them distinct names. `MCP_NOT_APPROVED` leaves a declared
server disabled; add it to `[mcp].approved` only after reviewing its command, arguments, working
directory, environment names, and sources. `MCP_APPROVAL_UNKNOWN` means the allowlist names no
declaration. `MCP_EXECUTABLE_UNAVAILABLE` comes from the generated wrapper when its declared
executable is absent or not executable; restore that executable rather than changing the wrapper.

For `RESTRICTION_INPUT_INVALID`, `RESTRICTION_POLICY_UNSUPPORTED`,
`RESTRICTION_ADAPTER_INVALID`, `RESTRICTION_EVENT_UNADAPTED`,
`RESTRICTION_TEMPLATE_INVALID`, or `RESTRICTION_OUTPUT_LIMIT`, correct the named guard policy,
measured adapter, template, or bounded output. An unadapted event remains unavailable. Do not
replace it with an instruction and describe it as enforced.

### Sibling projection and skills

`PROJECTION_INPUT_INVALID` and `PROJECTION_RESULT_BOUNDS` mean the projection request or result
is not bounded canonical data. `PROJECTION_ROOT_AMBIGUOUS`, `PROJECTION_MOUNT_MISMATCH`, and
`PROJECTION_GRANT_MISMATCH` require the canonical main checkout, active mount, and directory grant
to agree. `PROJECTION_GUIDE_UNAVAILABLE`, `PROJECTION_GUIDE_ESCAPE`,
`PROJECTION_GUIDE_READ_FAILED`, and `PROJECTION_GUIDE_CLOSE_FAILED` identify the named guide or
its confined read. Restore a regular declared guide and safe root. `PROJECTION_GUIDE_CHANGED`
means the guide changed after observation; stop the concurrent edit and retry from fresh evidence.

For `SKILL_INPUT_INVALID`, `SKILL_FRONTMATTER_INVALID`, `SKILL_CONTRACT_INVALID`,
`SKILL_IDENTITY_INVALID`, `SKILL_NAME_DUPLICATE`, `SKILL_TOOL_EQUIVALENCE_MISSING`,
`SKILL_PROCEDURE_MISSING`, `SKILL_COMMAND_UNDECLARED`, `SKILL_ENTRY_POINT_EXCEEDED`, or
`SKILL_DECISION_LOGIC_EMBEDDED`, correct the shipped skill entry point or shared procedure named
by the diagnostic. `SKILL_RENDER_INVALID` and `SKILL_RENDER_INVENTORY_INVALID` mean generated
files do not match the admitted skill contract. `SKILL_STANDING_COST_EXCEEDED` requires reducing
always-loaded skill entry points; moving decision logic into a different always-loaded file is
not a repair.

### Selftest and upgrade

`SELFTEST_SOURCE_INVALID` means the generated check, resolved probe-specification artifact path,
source digest, generated-manifest digest, or bounded specification failed authentication. Produce
a fresh measured artifact for the current generated manifest; do not edit the stored digests.
`SELFTEST_EXECUTION_INVALID` also refuses an unapproved or mismatched probe artifact before any
submitted command runs. Inspect its displayed whole-file digest and exact command vectors.
It can also mean a candidate, deliberately broken control, version/help event,
transcript, or final evidence bundle did not establish the expected result. Inspect the named
harness and retained bounded evidence. A missing executable, authentication requirement,
unavailable isolation boundary, or pending enforcement probe remains `human_needed` until the
operator action in the record is completed. Use `selftest --interactive` at a terminal outside CI;
approve the full artifact digest and vectors first, then each executable path and SHA-256.
Approval lasts only for that run.

`SURFACE_OVERRIDE_INSPECTION_UNAVAILABLE`, `SURFACE_OVERRIDE_INSPECTION_REFUSED`,
`SURFACE_OVERRIDE_INSPECTION_INVALID`, and `SURFACE_OVERRIDE_INSPECTION_PATH_MISMATCH` mean
`doctor` could not authenticate its read-only override view. They do not mean there are no
overrides; inspect the named generated source or configuration path before relying on that view.

`UPGRADE_SOURCE_INVALID` means the configuration path was not admitted.
`UPGRADE_NETWORK_FAILED` and `UPGRADE_AUTH_FAILED` mean authenticated discovery could not be
completed; repair that source and retry. `UPGRADE_VERSION_AMBIGUOUS` means discovery did not
establish one compatible current and candidate package identity, version, and integrity. It is
the expected fail-closed result when no release evidence is supplied or the candidate is not
strictly newer. `UPGRADE_AUTH_FAILED` also covers a missing or mismatched evidence file, SHA-256,
or installed package identity; obtain the expected digest from
the release attestation, not from the suspect file. `UPGRADE_DISCOVERY_INVALID` means the discovery result or affected override list was
malformed. `UPGRADE_REPAIR_UNVERIFIED` means the source cannot establish that an earlier repair
completed. None of these codes authorizes an install or a manifest edit.

## Focused harness verification

For the owner and extension seam, follow the
[implementation routes](harness-surfaces.md#implementation-and-verification-routes). Run the
command for the changed failure family from this repository; these are synthetic source
controls, not native harness evidence. The supported `npm test --` entry point fixes the worker
limit at four, bounds execution and descendant cleanup, and records the latest JSON result at
`.vitest-reports/latest.json`.

| Failure family | Focused verification command |
|---|---|
| Declaration/overlay admission | `npm test -- packages/cockpit/src/surfaces/merge.test.ts` |
| Generator inventory/determinism | `npm test -- packages/cockpit/src/surfaces/generator-adapter.test.ts` |
| Combined core/plugin dispatch, input bounds and worker recovery | `npm test -- packages/cockpit/src/surfaces/generator-estate.test.ts` |
| Custom/whole/shared output admission | `npm test -- packages/cockpit/src/surfaces/render.test.ts packages/cockpit/src/surfaces/ownership.test.ts` |
| MCP declarations/wrappers | `npm test -- packages/cockpit/src/surfaces/mcp.test.ts` |
| Restriction policy/adapters | `npm test -- packages/cockpit/src/surfaces/restrictions.test.ts` |
| Sibling guides/grants | `npm test -- packages/cockpit/src/surfaces/projection.test.ts` |
| Skill contracts/budgets | `npm test -- packages/cockpit/src/surfaces/skill-contract.test.ts` |
| Selftest authentication/approval | `npm test -- packages/cockpit/src/selftest/command.configured-artifact.test.ts packages/cockpit/src/selftest/command.native-execution.test.ts packages/cockpit/src/selftest/command.custom-operator.test.ts` |
| Upgrade evidence/override inspection | `npm test -- packages/cockpit/src/upgrade/command.test.ts packages/cockpit/src/upgrade/release-evidence.test.ts` |

Publication recovery is owned by `packages/cockpit/src/environment/generated-application.ts`. Its exact
finalization-failure control preserves recovery inputs when cleanup cannot be proved:

```sh
npm test -- packages/cockpit/src/generated-environment/command.test.ts -t 'retains recovery records when publication finalization is not confirmed'
```

A passing source control does not authorize deleting retained recovery data or invent a manual
state repair. Follow the named diagnostic and owning recovery procedure.

<!-- cockpit:diagnostic-index:begin -->
| Diagnostic | Implementing owners | Source remedy |
| --- | --- | --- |
| `ADOPTION_EMPTY` | `packages/cockpit/src/registry-resolve/command.ts` | no static remedy captured; inspect implementing owners |
| `ADOPTION_ENCODING_INVALID` | `packages/cockpit/src/registry-resolve/command.ts` | no static remedy captured; inspect implementing owners |
| `ADOPTION_NOT_FOUND` | `packages/cockpit/src/registry-resolve/command.ts` | no static remedy captured; inspect implementing owners |
| `ADOPTION_ORDER_INVALID` | `packages/cockpit/src/registry-resolve/command.ts` | no static remedy captured; inspect implementing owners |
| `ADOPTION_RECORD_INVALID` | `packages/cockpit/src/registry-resolve/command.ts` | no static remedy captured; inspect implementing owners |
| `ADOPTION_STATE_INVALID` | `packages/cockpit/src/registry-resolve/command.ts` | no static remedy captured; inspect implementing owners |
| `ADOPTION_TOO_LARGE` | `packages/cockpit/src/registry-resolve/command.ts` | no static remedy captured; inspect implementing owners |
| `ADOPTION_UNREADABLE` | `packages/cockpit/src/registry-resolve/command.ts` | no static remedy captured; inspect implementing owners |
| `AUTONOMY_ESCALATION_REQUIRED` | `packages/cockpit/src/autonomy/launcher.ts` | no static remedy captured; inspect implementing owners |
| `AUTONOMY_EVIDENCE_REQUIRED` | `packages/cockpit/src/autonomy/launcher.ts` | no static remedy captured; inspect implementing owners |
| `AUTONOMY_GRANTS_INVALID` | `packages/cockpit/src/autonomy/launcher.ts` | no static remedy captured; inspect implementing owners |
| `AUTONOMY_MODE_INVALID` | `packages/cockpit/src/autonomy/launcher.ts` | no static remedy captured; inspect implementing owners |
| `CHECKOUT_ADJACENCY_UNHEALTHY` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `CLAIM_CO_TENANT` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `CLAIM_LIVENESS_UNKNOWN` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `CLAIM_STATE_UNHEALTHY` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `CLI_COMMAND_REQUIRED` | `packages/cockpit/src/cli.ts` | no static remedy captured; inspect implementing owners |
| `CLI_INTERNAL_ERROR` | `packages/cockpit/src/cli.ts`, `packages/cockpit/src/environment/operator-application.ts` | no static remedy captured; inspect implementing owners |
| `CLI_UNKNOWN_COMMAND` | `packages/cockpit/src/cli.ts` | no static remedy captured; inspect implementing owners |
| `CLI_USAGE_INVALID` | `packages/cockpit/src/cli.ts` | no static remedy captured; inspect implementing owners |
| `COCKPIT_REVISION_INVALID` | `packages/cockpit/src/registry-resolve/command.ts` | no static remedy captured; inspect implementing owners |
| `COMPARISON_FIXTURE_INVALID` | `packages/cockpit/src/comparison/contract.ts` | no static remedy captured; inspect implementing owners |
| `COMPARISON_NORMALIZATION_INVALID` | `packages/cockpit/src/comparison/normalize.ts` | no static remedy captured; inspect implementing owners |
| `COMPARISON_OUTPUT_INVALID` | `packages/cockpit/src/comparison/normalize.ts` | no static remedy captured; inspect implementing owners |
| `COMPARISON_UNAVAILABLE` | `packages/cockpit/src/comparison/command.ts` | no static remedy captured; inspect implementing owners |
| `CONFIG_CHANGED_DURING_EXECUTION` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `CONFIG_ENCODING_INVALID` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `CONFIG_NOT_FOUND` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `CONFIG_PARSE_INVALID` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `CONFIG_SCHEMA_INVALID` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `CONFIG_STALE` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `CONFIG_UNREADABLE` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `DATA_MODE_UNAVAILABLE` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `DEPENDENCY_RUNTIME_INCOMPATIBLE` | `packages/cockpit/src/environment/dependency-runtime.ts` | no static remedy captured; inspect implementing owners |
| `DEPENDENCY_RUNTIME_STALE` | `packages/cockpit/src/environment/dependency-runtime.ts` | no static remedy captured; inspect implementing owners |
| `DEPENDENCY_RUNTIME_UNAVAILABLE` | `packages/cockpit/src/environment/dependency-runtime.ts` | no static remedy captured; inspect implementing owners |
| `DEPENDENCY_RUNTIME_UNMOUNTED` | `packages/cockpit/src/environment/dependency-runtime.ts` | no static remedy captured; inspect implementing owners |
| `DIRECTORY_GRANTS_UNAVAILABLE` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `DISK_BUDGET_EXCEEDED` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `DOCEV050_NAMED_REFERENCE_MISSING` | `packages/cockpit/src/references/named.ts` | no static remedy captured; inspect implementing owners |
| `DOCUMENT_CONFIGURATION_ANSWER_EXTRA` | `packages/cockpit/src/document/command.ts` | no static remedy captured; inspect implementing owners |
| `DOCUMENT_CONFIGURATION_ANSWER_INVALID` | `packages/cockpit/src/document/command.ts` | no static remedy captured; inspect implementing owners |
| `DOCUMENT_CONFIGURATION_ANSWER_STALE` | `packages/cockpit/src/document/command.ts` | no static remedy captured; inspect implementing owners |
| `DOCUMENT_CONFIGURATION_APPLICABILITY_INVALID` | `packages/cockpit/src/document/command.ts` | no static remedy captured; inspect implementing owners |
| `DOCUMENT_CONFIGURATION_INVALID` | `packages/cockpit/src/document/command.ts` | no static remedy captured; inspect implementing owners |
| `DOCUMENT_DEFAULT` | `packages/cockpit/src/document/command.ts` | no static remedy captured; inspect implementing owners |
| `DOCUMENT_DEFAULT_CONFIRMATION_INVALID` | `packages/cockpit/src/document/command.ts` | no static remedy captured; inspect implementing owners |
| `DOCUMENT_ESTATE_GAPS_INVALID` | `packages/cockpit/src/document/command.ts` | no static remedy captured; inspect implementing owners |
| `DOCUMENT_ESTATE_INCOMPLETE` | `packages/cockpit/src/document/command.ts` | no static remedy captured; inspect implementing owners |
| `DOCUMENT_ESTATE_OBSERVATION_CHANGED` | `packages/cockpit/src/document/command.ts` | no static remedy captured; inspect implementing owners |
| `DOCUMENT_ESTATE_OBSERVATION_INVALID` | `packages/cockpit/src/document/command.ts` | no static remedy captured; inspect implementing owners |
| `DOCUMENT_ESTATE_TOPOLOGY_MISMATCH` | `packages/cockpit/src/document/command.ts` | no static remedy captured; inspect implementing owners |
| `DOCUMENT_GAP` | `packages/cockpit/src/document/command.ts` | confirm or replace the attributed default; supply this value before treating the draft as valid |
| `DOCUMENT_INFERRED` | `packages/cockpit/src/document/command.ts` | no static remedy captured; inspect implementing owners |
| `DOCUMENT_NO_RUNNABLE_PRODUCT` | `packages/cockpit/src/document/command.ts` | no static remedy captured; inspect implementing owners |
| `DOCUMENT_OPTION_DUPLICATE` | `packages/cockpit/src/cli.ts` | no static remedy captured; inspect implementing owners |
| `DOCUMENT_ROOT_COUNT` | `packages/cockpit/src/cli.ts` | no static remedy captured; inspect implementing owners |
| `DOCUMENT_RUNNABLE_TOPOLOGY_MISMATCH` | `packages/cockpit/src/document/command.ts` | no static remedy captured; inspect implementing owners |
| `DOCUMENT_SOURCE_CONFLICT` | `packages/cockpit/src/cli.ts` | no static remedy captured; inspect implementing owners |
| `DOCUMENT_SOURCE_REQUIRED` | `packages/cockpit/src/cli.ts`, `packages/cockpit/src/document/command.ts` | no static remedy captured; inspect implementing owners |
| `DOCUMENT_STDOUT_TARGET` | `packages/cockpit/src/document/command.ts` | no static remedy captured; inspect implementing owners |
| `DRAIN_ATTEMPT_REPAIR_REQUIRED` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `ENVIRONMENT_FILE_MALFORMED` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `ENVIRONMENT_FILE_NOT_FOUND` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `ENVIRONMENT_FILE_TOO_LARGE` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `ENVIRONMENT_FILE_UNREADABLE` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `ENVIRONMENT_KEYS_STALE` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `ENVIRONMENT_SEED_FAILED` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `ENVIRONMENT_SEED_PRECONDITION_CHANGED` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `EVIDENCE_BASELINE_MISSING` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `EVIDENCE_UNAVAILABLE` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `EXECUTION_ABORTED` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `EXECUTION_COMPENSATION_STEP_FAILED` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `EXECUTION_COMPENSATION_TIMEOUT` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `EXECUTION_PRECONDITION_CHANGED` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `EXECUTION_SPAWN_FAILED` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `EXECUTION_STAGING_CLEANUP_FAILED` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `EXECUTION_STAGING_FAILED` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `EXECUTION_STDERR_LIMIT` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `EXECUTION_STDOUT_LIMIT` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `EXECUTION_STEP_FAILED` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `EXECUTION_TERMINATION_UNCONFIRMED` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `EXECUTION_TIMEOUT` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `EXTERNAL_DEPENDENCIES_UNAVAILABLE` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `EXTERNAL_DEPENDENCY_DECLARATION_INVALID` | `packages/cockpit/src/environment/external-dependencies.ts` | no static remedy captured; inspect implementing owners |
| `EXTERNAL_DEPENDENCY_EVIDENCE_UNAVAILABLE` | `packages/cockpit/src/environment/external-dependencies.ts` | no static remedy captured; inspect implementing owners |
| `EXTERNAL_DEPENDENCY_EXECUTION_UNAVAILABLE` | `packages/cockpit/src/environment/external-dependencies.ts` | no static remedy captured; inspect implementing owners |
| `EXTERNAL_DEPENDENCY_EXPIRED` | `packages/cockpit/src/environment/external-dependencies.ts` | no static remedy captured; inspect implementing owners |
| `EXTERNAL_DEPENDENCY_SHADOW_UNAVAILABLE` | `packages/cockpit/src/environment/external-dependencies.ts` | no static remedy captured; inspect implementing owners |
| `EXTERNAL_DEPENDENCY_TEMPLATE_MISMATCH` | `packages/cockpit/src/environment/external-dependencies.ts` | no static remedy captured; inspect implementing owners |
| `GENERATED_ARTIFACT_DRIFT` | `packages/cockpit/src/environment/generated-application.ts`, `packages/cockpit/src/environment/generated-stack.ts` | no static remedy captured; inspect implementing owners |
| `GENERATED_ARTIFACT_MISSING` | `packages/cockpit/src/environment/generated-application.ts`, `packages/cockpit/src/environment/generated-stack.ts` | no static remedy captured; inspect implementing owners |
| `GENERATED_COMPENSATION_FAILED` | `packages/cockpit/src/generated-environment/transaction.ts` | no static remedy captured; inspect implementing owners |
| `GENERATED_COMPOSE_INVALID` | `packages/cockpit/src/environment/generated-stack.ts` | no static remedy captured; inspect implementing owners |
| `GENERATED_DECISION_COVERAGE` | `packages/cockpit/src/environment/generated-stack.ts` | no static remedy captured; inspect implementing owners |
| `GENERATED_DECISION_DUPLICATE` | `packages/cockpit/src/environment/generated-stack.ts` | no static remedy captured; inspect implementing owners |
| `GENERATED_DECISION_FUTURE` | `packages/cockpit/src/environment/generated-stack.ts` | no static remedy captured; inspect implementing owners |
| `GENERATED_DECISION_SENSITIVE` | `packages/cockpit/src/environment/generated-stack.ts` | no static remedy captured; inspect implementing owners |
| `GENERATED_DECISION_STALE` | `packages/cockpit/src/environment/generated-stack.ts` | no static remedy captured; inspect implementing owners |
| `GENERATED_DECLARATION_INVALID` | `packages/cockpit/src/environment/generated-application.ts`, `packages/cockpit/src/environment/generated-render.ts` | no static remedy captured; inspect implementing owners |
| `GENERATED_DECLARATION_MISSING` | `packages/cockpit/src/environment/generated-application.ts` | no static remedy captured; inspect implementing owners |
| `GENERATED_ENVIRONMENT_UNAVAILABLE` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `GENERATED_EXECUTABLE_UNAVAILABLE` | `packages/cockpit/src/environment/generated-application.ts`, `packages/cockpit/src/generated-environment/uninstall.ts` | no static remedy captured; inspect implementing owners |
| `GENERATED_INPUT_INVALID` | `packages/cockpit/src/environment/generated-application.ts`, `packages/cockpit/src/environment/generated-render.ts`, `packages/cockpit/src/generated-environment/uninstall.ts` | no static remedy captured; inspect implementing owners |
| `GENERATED_INSPECTION_INVALID` | `packages/cockpit/src/environment/generated-stack.ts` | no static remedy captured; inspect implementing owners |
| `GENERATED_OWNERSHIP_DRIFT` | `packages/cockpit/src/environment/generated-application.ts` | no static remedy captured; inspect implementing owners |
| `GENERATED_OWNERSHIP_FORMAT_UNSUPPORTED` | `packages/cockpit/src/environment/generated-application.ts`, `packages/cockpit/src/generated-environment/uninstall.ts` | no static remedy captured; inspect implementing owners |
| `GENERATED_OWNERSHIP_INVALID` | `packages/cockpit/src/environment/generated-application.ts`, `packages/cockpit/src/generated-environment/transaction.ts`, `packages/cockpit/src/generated-environment/uninstall.ts` | no static remedy captured; inspect implementing owners |
| `GENERATED_OWNERSHIP_MISSING` | `packages/cockpit/src/environment/generated-application.ts`, `packages/cockpit/src/generated-environment/transaction.ts`, `packages/cockpit/src/generated-environment/uninstall.ts` | no static remedy captured; inspect implementing owners |
| `GENERATED_PATH_DUPLICATE` | `packages/cockpit/src/environment/generated-application.ts` | no static remedy captured; inspect implementing owners |
| `GENERATED_PATH_UNOWNED` | `packages/cockpit/src/environment/generated-stack.ts` | no static remedy captured; inspect implementing owners |
| `GENERATED_PATH_UNSAFE` | `packages/cockpit/src/environment/generated-application.ts`, `packages/cockpit/src/generated-environment/transaction.ts` | no static remedy captured; inspect implementing owners |
| `GENERATED_PERSONA_INVALID` | `packages/cockpit/src/environment/generated-application.ts` | no static remedy captured; inspect implementing owners |
| `GENERATED_PERSONA_SOURCE_UNAVAILABLE` | `packages/cockpit/src/environment/generated-application.ts` | no static remedy captured; inspect implementing owners |
| `GENERATED_PUBLICATION_FAILED` | `packages/cockpit/src/environment/generated-application.ts`, `packages/cockpit/src/generated-environment/transaction.ts` | no static remedy captured; inspect implementing owners |
| `GENERATED_REFERENCE_BOOTSTRAP_INVALID` | `packages/cockpit/src/generated-environment/transaction.ts` | no static remedy captured; inspect implementing owners |
| `GENERATED_REFERENCE_OWNERSHIP_INVALID` | `packages/cockpit/src/generated-environment/transaction.ts` | no static remedy captured; inspect implementing owners |
| `GENERATED_RENDER_UNAUTHENTICATED` | `packages/cockpit/src/environment/generated-application.ts`, `packages/cockpit/src/environment/generated-stack.ts` | no static remedy captured; inspect implementing owners |
| `GENERATED_SIBLING_ROOT_INVALID` | `packages/cockpit/src/environment/generated-application.ts` | no static remedy captured; inspect implementing owners |
| `GENERATED_SOURCE_CHANGED` | `packages/cockpit/src/environment/generated-application.ts`, `packages/cockpit/src/generated-environment/transaction.ts` | no static remedy captured; inspect implementing owners |
| `GENERATED_STALE_APPROVAL_INVALID` | `packages/cockpit/src/generated-environment/transaction.ts` | no static remedy captured; inspect implementing owners |
| `GENERATED_STALE_APPROVAL_REQUIRED` | `packages/cockpit/src/environment/operator-application.ts`, `packages/cockpit/src/generated-environment/transaction.ts` | no static remedy captured; inspect implementing owners |
| `GENERATED_STALE_ARTIFACT` | `packages/cockpit/src/environment/generated-application.ts` | no static remedy captured; inspect implementing owners |
| `GENERATED_STALE_ARTIFACT_DRIFT` | `packages/cockpit/src/environment/generated-application.ts`, `packages/cockpit/src/generated-environment/transaction.ts`, `packages/cockpit/src/generated-environment/uninstall.ts` | no static remedy captured; inspect implementing owners |
| `GENERATED_TEMPLATE_INVALID` | `packages/cockpit/src/environment/generated-render.ts` | no static remedy captured; inspect implementing owners |
| `GENERATED_UNINSTALL_HELD` | `packages/cockpit/src/generated-environment/uninstall.ts` | no static remedy captured; inspect implementing owners |
| `GIT_COMPARISON_REMOTE_MISMATCH` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `GIT_STATE_UNHEALTHY` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `GREENFIELD_ANSWER_INVALID` | `packages/cockpit/src/environment/init-application.ts` | no static remedy captured; inspect implementing owners |
| `GREENFIELD_ANSWER_REQUIRED` | `packages/cockpit/src/init/command.ts` | no static remedy captured; inspect implementing owners |
| `GREENFIELD_ANSWER_UNEXPECTED` | `packages/cockpit/src/environment/init-application.ts` | no static remedy captured; inspect implementing owners |
| `GREENFIELD_DISCOVERY_UNAVAILABLE` | `packages/cockpit/src/environment/init-application.ts` | no static remedy captured; inspect implementing owners |
| `GREENFIELD_OBSERVATION_CHANGED` | `packages/cockpit/src/environment/init-application.ts` | no static remedy captured; inspect implementing owners |
| `GREENFIELD_OBSERVATION_INVALID` | `packages/cockpit/src/environment/init-application.ts` | no static remedy captured; inspect implementing owners |
| `GUARD_AUTHORITY_UNAVAILABLE` | `packages/cockpit/src/environment/application.ts` | no static remedy captured; inspect implementing owners |
| `GUARD_INPUT_UNAVAILABLE` | `packages/cockpit/src/cli.ts` | no static remedy captured; inspect implementing owners |
| `GUARD_REFUSED` | `packages/cockpit/src/environment/application.ts` | no static remedy captured; inspect implementing owners |
| `GUARD_TRANSPORT_INVALID` | `packages/cockpit/src/guards/harness-adapter.ts` | no static remedy captured; inspect implementing owners |
| `GUIDE_CAP_EXCEEDED` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `HARNESS_SURFACE_UNAVAILABLE` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `INIT_ARTIFACT_WRITE_FAILED` | `packages/cockpit/src/init/command.ts` | no static remedy captured; inspect implementing owners |
| `INIT_BOOTSTRAP_IDENTITY_CHANGED` | `packages/cockpit/src/environment/init-application.ts` | no static remedy captured; inspect implementing owners |
| `INIT_CANONICAL_OWNERSHIP_MISSING` | `packages/cockpit/src/environment/init-application.ts` | no static remedy captured; inspect implementing owners |
| `INIT_DESTINATION_UNAVAILABLE` | `packages/cockpit/src/cli.ts` | no static remedy captured; inspect implementing owners |
| `INIT_DRAFT_CHANGED` | `packages/cockpit/src/environment/init-application.ts` | no static remedy captured; inspect implementing owners |
| `INIT_DRAFT_INVALID` | `packages/cockpit/src/environment/init-application.ts` | no static remedy captured; inspect implementing owners |
| `INIT_DRAFT_SOURCE_CHANGED` | `packages/cockpit/src/environment/init-application.ts` | no static remedy captured; inspect implementing owners |
| `INIT_PREVIEW_CHANGED` | `packages/cockpit/src/environment/init-application.ts` | no static remedy captured; inspect implementing owners |
| `INIT_PREVIEW_NOT_ACCEPTED` | `packages/cockpit/src/init/command.ts` | no static remedy captured; inspect implementing owners |
| `INIT_ROOT_INVALID` | `packages/cockpit/src/environment/init-application.ts` | no static remedy captured; inspect implementing owners |
| `INIT_STATE_DURABILITY_INDETERMINATE` | `packages/cockpit/src/environment/init-application.ts` | no static remedy captured; inspect implementing owners |
| `INIT_STATE_STALE` | `packages/cockpit/src/environment/init-application.ts` | no static remedy captured; inspect implementing owners |
| `INIT_STATE_UNAUTHENTICATED` | `packages/cockpit/src/environment/init-application.ts` | no static remedy captured; inspect implementing owners |
| `INIT_TARGET_CHANGED` | `packages/cockpit/src/environment/init-application.ts` | no static remedy captured; inspect implementing owners |
| `INIT_TERMINAL_REQUIRED` | `packages/cockpit/src/init/command.ts` | no static remedy captured; inspect implementing owners |
| `INIT_UNAVAILABLE` | `packages/cockpit/src/cli.ts` | no static remedy captured; inspect implementing owners |
| `INSTALL_LOAD_PROBE_FAILED` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `INSTALL_LOCKFILE_CHANGED` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `INSTALL_LOCK_HELD` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `INSTALL_LOCK_INVALID` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `INSTALL_POLICY_AMBIGUOUS` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `INSTALL_POLICY_MISSING` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `INSTALL_POLICY_OBSERVATION_INVALID` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `INSTALL_POLICY_OBSERVATION_UNAVAILABLE` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `INSTALL_STALE_PATH` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `INSTALL_STATE_UNHEALTHY` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `INSTANCE_NOT_IGNORED` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `LIFECYCLE_EVIDENCE_INVALID` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `LIFECYCLE_PROGRESS_INVALID` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `MACHINE_COLD_START_EXCEEDED` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `MACHINE_CPU_BELOW_FLOOR` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `MACHINE_DISK_BELOW_FLOOR` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `MACHINE_MEMORY_BELOW_FLOOR` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `MCP_APPROVAL_UNKNOWN` | `packages/cockpit/src/surfaces/mcp.ts` | no static remedy captured; inspect implementing owners |
| `MCP_COMMAND_CONFLICT` | `packages/cockpit/src/surfaces/mcp.ts` | no static remedy captured; inspect implementing owners |
| `MCP_DECLARATION_INVALID` | `packages/cockpit/src/environment/generated-application.ts`, `packages/cockpit/src/surfaces/mcp.ts` | no static remedy captured; inspect implementing owners |
| `MCP_INPUT_INVALID` | `packages/cockpit/src/surfaces/mcp.ts` | no static remedy captured; inspect implementing owners |
| `MCP_NOT_APPROVED` | `packages/cockpit/src/surfaces/mcp.ts` | no static remedy captured; inspect implementing owners |
| `MOUNT_MATERIALIZATION_UNAVAILABLE` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `MOUNT_POSTURE_UNAVAILABLE` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `OUTPUT_EXISTS` | `packages/cockpit/src/cli.ts` | choose a new path; replacement requires a future explicit option |
| `OUTPUT_WRITE_FAILED` | `packages/cockpit/src/cli.ts` | no static remedy captured; inspect implementing owners |
| `OVERRIDDEN_CORE_CHANGED` | `packages/cockpit/src/surfaces/merge.ts` | no static remedy captured; inspect implementing owners |
| `PORT_EXTERNAL_REGISTRATION_GAP` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `PORT_FAMILY_COLLISION` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `PORT_FAMILY_OUT_OF_RANGE` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `PORT_LEASE_EXHAUSTED` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `PORT_LISTENER_EVIDENCE_INVALID` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `PORT_LOCAL_VALUE_CORRECTED` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `PROJECTION_GRANT_MISMATCH` | `packages/cockpit/src/surfaces/projection.ts` | no static remedy captured; inspect implementing owners |
| `PROJECTION_GUIDE_CHANGED` | `packages/cockpit/src/surfaces/projection.ts` | no static remedy captured; inspect implementing owners |
| `PROJECTION_GUIDE_CLOSE_FAILED` | `packages/cockpit/src/surfaces/projection.ts` | no static remedy captured; inspect implementing owners |
| `PROJECTION_GUIDE_ESCAPE` | `packages/cockpit/src/surfaces/projection.ts` | no static remedy captured; inspect implementing owners |
| `PROJECTION_GUIDE_READ_FAILED` | `packages/cockpit/src/surfaces/projection.ts` | no static remedy captured; inspect implementing owners |
| `PROJECTION_GUIDE_UNAVAILABLE` | `packages/cockpit/src/surfaces/projection.ts` | no static remedy captured; inspect implementing owners |
| `PROJECTION_INPUT_INVALID` | `packages/cockpit/src/surfaces/projection.ts` | no static remedy captured; inspect implementing owners |
| `PROJECTION_MOUNT_MISMATCH` | `packages/cockpit/src/surfaces/projection.ts` | no static remedy captured; inspect implementing owners |
| `PROJECTION_RESULT_BOUNDS` | `packages/cockpit/src/surfaces/projection.ts` | no static remedy captured; inspect implementing owners |
| `PROJECTION_ROOT_AMBIGUOUS` | `packages/cockpit/src/surfaces/projection.ts` | no static remedy captured; inspect implementing owners |
| `RECLAIM_ACCOUNTING_MISMATCH` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `RECLAIM_LABEL_ESCAPE` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `REFERENCE_INPUT_INVALID` | `packages/cockpit/src/references/generate.ts` | no static remedy captured; inspect implementing owners |
| `REGISTRY_ADOPTION_REQUIRED` | `packages/cockpit/src/cli.ts` | no static remedy captured; inspect implementing owners |
| `REGISTRY_AMBIGUOUS` | `packages/cockpit/src/document/registry.ts` | no static remedy captured; inspect implementing owners |
| `REGISTRY_ARTIFACT_UNSAFE` | `packages/cockpit/src/registry-resolve/command.ts` | no static remedy captured; inspect implementing owners |
| `REGISTRY_AUTH_UNAVAILABLE` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `REGISTRY_DIR_DUPLICATE` | `packages/cockpit/src/registry-resolve/command.ts` | no static remedy captured; inspect implementing owners |
| `REGISTRY_DIR_OUTSIDE_SIBLINGS_ROOT` | `packages/cockpit/src/registry-resolve/command.ts` | no static remedy captured; inspect implementing owners |
| `REGISTRY_EFFECTIVE_CONFIG_INVALID` | `packages/cockpit/src/registry-derivation.ts` | no static remedy captured; inspect implementing owners |
| `REGISTRY_EMPTY` | `packages/cockpit/src/document/command.ts`, `packages/cockpit/src/registry-resolve/command.ts` | no static remedy captured; inspect implementing owners |
| `REGISTRY_ENCODING_INVALID` | `packages/cockpit/src/document/command.ts`, `packages/cockpit/src/registry-resolve/command.ts` | no static remedy captured; inspect implementing owners |
| `REGISTRY_GENERATED_BASELINE_MISSING` | `packages/cockpit/src/registry-derivation.ts` | no static remedy captured; inspect implementing owners |
| `REGISTRY_INPUT_INVALID` | `packages/cockpit/src/registry-derivation.ts` | no static remedy captured; inspect implementing owners |
| `REGISTRY_NOT_FOUND` | `packages/cockpit/src/document/command.ts`, `packages/cockpit/src/registry-resolve/command.ts` | no static remedy captured; inspect implementing owners |
| `REGISTRY_OPTION_DUPLICATE` | `packages/cockpit/src/cli.ts` | no static remedy captured; inspect implementing owners |
| `REGISTRY_OUTPUT_UNSUPPORTED` | `packages/cockpit/src/cli.ts` | no static remedy captured; inspect implementing owners |
| `REGISTRY_POSITIONAL_UNSUPPORTED` | `packages/cockpit/src/cli.ts` | no static remedy captured; inspect implementing owners |
| `REGISTRY_ROW_SKIPPED` | `packages/cockpit/src/document/command.ts`, `packages/cockpit/src/registry-resolve/command.ts` | repair every skipped row before documenting repository scope |
| `REGISTRY_SIBLINGS_ROOT_REQUIRED` | `packages/cockpit/src/cli.ts` | no static remedy captured; inspect implementing owners |
| `REGISTRY_SOURCE_REQUIRED` | `packages/cockpit/src/cli.ts` | no static remedy captured; inspect implementing owners |
| `REGISTRY_TOO_LARGE` | `packages/cockpit/src/document/command.ts`, `packages/cockpit/src/registry-resolve/command.ts` | no static remedy captured; inspect implementing owners |
| `REGISTRY_UNREADABLE` | `packages/cockpit/src/document/command.ts`, `packages/cockpit/src/registry-resolve/command.ts` | no static remedy captured; inspect implementing owners |
| `REGISTRY_VARIABLE_INVALID` | `packages/cockpit/src/registry-resolve/command.ts` | no static remedy captured; inspect implementing owners |
| `RESET_CONFIRMATION_MISMATCH` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `RESET_CONFIRMATION_REQUIRED` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `RESET_CO_TENANT` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `RESTRICTION_ADAPTER_INVALID` | `packages/cockpit/src/surfaces/restrictions.ts` | no static remedy captured; inspect implementing owners |
| `RESTRICTION_EVENT_UNADAPTED` | `packages/cockpit/src/surfaces/restrictions.ts` | no static remedy captured; inspect implementing owners |
| `RESTRICTION_INPUT_INVALID` | `packages/cockpit/src/surfaces/restrictions.ts` | no static remedy captured; inspect implementing owners |
| `RESTRICTION_OUTPUT_LIMIT` | `packages/cockpit/src/surfaces/restrictions.ts` | no static remedy captured; inspect implementing owners |
| `RESTRICTION_POLICY_UNSUPPORTED` | `packages/cockpit/src/surfaces/restrictions.ts` | no static remedy captured; inspect implementing owners |
| `RESTRICTION_TEMPLATE_INVALID` | `packages/cockpit/src/surfaces/restrictions.ts` | no static remedy captured; inspect implementing owners |
| `RUNNING_CHECKOUT_MISMATCH` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `RUNTIME_COMPOSE_REMOTE` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `RUNTIME_PROBE_TIMEOUT` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `RUNTIME_UNAVAILABLE` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `RUNTIME_UNMEASURED` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `SELFTEST_EXECUTION_INVALID` | `packages/cockpit/src/environment/selftest-application.ts` | no static remedy captured; inspect implementing owners |
| `SELFTEST_SOURCE_INVALID` | `packages/cockpit/src/environment/selftest-application.ts`, `packages/cockpit/src/surfaces/selftest.ts` | no static remedy captured; inspect implementing owners |
| `SETUP_CONFIG_REQUIRED` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `SETUP_MANUAL_MISSING` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `SETUP_NONE_ABSENT` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `SETUP_NONE_DIRECTORY` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `SETUP_NONE_REPOSITORY` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `SETUP_OPTION_DUPLICATE` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `SETUP_PARENT_MISSING` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `SETUP_PATH_OUTSIDE_ROOT` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `SETUP_PATH_SYMLINK` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `SETUP_PATH_TYPE_INVALID` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `SETUP_POSITIONAL_UNSUPPORTED` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `SETUP_POSTCHECK_FAILED` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `SETUP_REMOTE_MISMATCH` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `SIBLING_MISSING` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `SKILL_BUDGET_UNAVAILABLE` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `SKILL_COMMAND_UNDECLARED` | `packages/cockpit/src/surfaces/skill-contract.ts` | no static remedy captured; inspect implementing owners |
| `SKILL_CONTRACT_INVALID` | `packages/cockpit/src/surfaces/skill-contract.ts` | no static remedy captured; inspect implementing owners |
| `SKILL_DECISION_LOGIC_EMBEDDED` | `packages/cockpit/src/surfaces/skill-contract.ts` | no static remedy captured; inspect implementing owners |
| `SKILL_ENTRY_POINT_EXCEEDED` | `packages/cockpit/src/surfaces/skill-contract.ts` | no static remedy captured; inspect implementing owners |
| `SKILL_FRONTMATTER_INVALID` | `packages/cockpit/src/surfaces/skill-contract.ts` | no static remedy captured; inspect implementing owners |
| `SKILL_IDENTITY_INVALID` | `packages/cockpit/src/surfaces/skill-contract.ts` | no static remedy captured; inspect implementing owners |
| `SKILL_INPUT_INVALID` | `packages/cockpit/src/surfaces/skill-contract.ts` | no static remedy captured; inspect implementing owners |
| `SKILL_NAME_DUPLICATE` | `packages/cockpit/src/surfaces/skill-contract.ts` | no static remedy captured; inspect implementing owners |
| `SKILL_PROCEDURE_MISSING` | `packages/cockpit/src/surfaces/skill-contract.ts` | no static remedy captured; inspect implementing owners |
| `SKILL_PROJECTION_INVALID` | `packages/cockpit/src/surfaces/skill-contract.ts` | no static remedy captured; inspect implementing owners |
| `SKILL_RENDER_INVALID` | `packages/cockpit/src/environment/generated-application.ts`, `packages/cockpit/src/surfaces/skill-contract.ts` | no static remedy captured; inspect implementing owners |
| `SKILL_RENDER_INVENTORY_INVALID` | `packages/cockpit/src/surfaces/skill-contract.ts` | no static remedy captured; inspect implementing owners |
| `SKILL_STANDING_COST_EXCEEDED` | `packages/cockpit/src/surfaces/skill-contract.ts` | no static remedy captured; inspect implementing owners |
| `SKILL_TOOL_EQUIVALENCE_MISSING` | `packages/cockpit/src/surfaces/skill-contract.ts` | no static remedy captured; inspect implementing owners |
| `STATE_DURABILITY_INDETERMINATE` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `STATE_FORMAT_UNSUPPORTED` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `STATE_LOCKED` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `STATE_RECORD_MALFORMED` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `STATE_ROOT_UNAVAILABLE` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `STATE_UNSEEDED` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `SURFACE_ARTIFACT_INVALID` | `packages/cockpit/src/surfaces/generator-adapter.ts` | no static remedy captured; inspect implementing owners |
| `SURFACE_BOUNDS` | `packages/cockpit/src/environment/generated-application.ts`, `packages/cockpit/src/surfaces/check.ts`, `packages/cockpit/src/surfaces/ownership.ts`, `packages/cockpit/src/surfaces/render.ts` | no static remedy captured; inspect implementing owners |
| `SURFACE_CLEANUP_FAILED` | `packages/cockpit/src/surfaces/generator-adapter.ts` | no static remedy captured; inspect implementing owners |
| `SURFACE_CUSTOM_REFUSED` | `packages/cockpit/src/environment/generated-application.ts` | no static remedy captured; inspect implementing owners |
| `SURFACE_FEATURE_COVERAGE` | `packages/cockpit/src/surfaces/generator-adapter.ts` | no static remedy captured; inspect implementing owners |
| `SURFACE_GENERATION_FAILED` | `packages/cockpit/src/environment/generated-application.ts` | no static remedy captured; inspect implementing owners |
| `SURFACE_GENERATOR_TRUST_WARNING` | `packages/cockpit/src/surfaces/generator-adapter.ts` | no static remedy captured; inspect implementing owners |
| `SURFACE_INPUT_INVALID` | `packages/cockpit/src/environment/generated-application.ts`, `packages/cockpit/src/surfaces/check.ts`, `packages/cockpit/src/surfaces/generator-adapter.ts`, `packages/cockpit/src/surfaces/merge.ts`, `packages/cockpit/src/surfaces/ownership.ts`, `packages/cockpit/src/surfaces/render.ts` | no static remedy captured; inspect implementing owners |
| `SURFACE_KIND_AMBIGUOUS` | `packages/cockpit/src/surfaces/merge.ts` | no static remedy captured; inspect implementing owners |
| `SURFACE_NAME_DUPLICATE` | `packages/cockpit/src/surfaces/merge.ts` | no static remedy captured; inspect implementing owners |
| `SURFACE_NODE_UNAVAILABLE` | `packages/cockpit/src/surfaces/generator-adapter.ts` | no static remedy captured; inspect implementing owners |
| `SURFACE_OUTPUT_COVERAGE` | `packages/cockpit/src/surfaces/generator-adapter.ts` | no static remedy captured; inspect implementing owners |
| `SURFACE_OVERRIDE_INSPECTION_INVALID` | `packages/cockpit/src/environment/application.ts`, `packages/cockpit/src/environment/health-composition.ts` | no static remedy captured; inspect implementing owners |
| `SURFACE_OVERRIDE_INSPECTION_PATH_MISMATCH` | `packages/cockpit/src/environment/health-composition.ts` | no static remedy captured; inspect implementing owners |
| `SURFACE_OVERRIDE_INSPECTION_REFUSED` | `packages/cockpit/src/environment/health-composition.ts` | no static remedy captured; inspect implementing owners |
| `SURFACE_OVERRIDE_INSPECTION_UNAVAILABLE` | `packages/cockpit/src/environment/application.ts`, `packages/cockpit/src/environment/health-composition.ts` | no static remedy captured; inspect implementing owners |
| `SURFACE_OVERRIDE_INVALID` | `packages/cockpit/src/surfaces/merge.ts` | no static remedy captured; inspect implementing owners |
| `SURFACE_OWNERSHIP_INVALID` | `packages/cockpit/src/surfaces/ownership.ts`, `packages/cockpit/src/surfaces/render.ts` | no static remedy captured; inspect implementing owners |
| `SURFACE_PACKAGE_UNAVAILABLE` | `packages/cockpit/src/surfaces/generator-adapter.ts` | no static remedy captured; inspect implementing owners |
| `SURFACE_PATH_CONFLICT` | `packages/cockpit/src/environment/generated-application.ts`, `packages/cockpit/src/surfaces/merge.ts`, `packages/cockpit/src/surfaces/ownership.ts`, `packages/cockpit/src/surfaces/render.ts` | no static remedy captured; inspect implementing owners |
| `SURFACE_SCRATCH_UNAVAILABLE` | `packages/cockpit/src/surfaces/generator-adapter.ts` | no static remedy captured; inspect implementing owners |
| `SURFACE_SOURCE_UNAVAILABLE` | `packages/cockpit/src/environment/generated-application.ts` | no static remedy captured; inspect implementing owners |
| `SURFACE_STAGE_VARIANCE` | `packages/cockpit/src/surfaces/generator-adapter.ts` | no static remedy captured; inspect implementing owners |
| `SURFACE_STAGING_FAILED` | `packages/cockpit/src/surfaces/generator-adapter.ts` | no static remedy captured; inspect implementing owners |
| `SURFACE_STATE_CONFLICT` | `packages/cockpit/src/environment/generated-application.ts`, `packages/cockpit/src/surfaces/ownership.ts`, `packages/cockpit/src/surfaces/sync.ts` | no static remedy captured; inspect implementing owners |
| `SURFACE_WORKER_NONZERO` | `packages/cockpit/src/surfaces/generator-adapter.ts` | no static remedy captured; inspect implementing owners |
| `SURFACE_WORKER_OUTPUT` | `packages/cockpit/src/surfaces/generator-adapter.ts` | no static remedy captured; inspect implementing owners |
| `SURFACE_WORKER_SIGNAL` | `packages/cockpit/src/surfaces/generator-adapter.ts` | no static remedy captured; inspect implementing owners |
| `SURFACE_WORKER_STDERR` | `packages/cockpit/src/surfaces/generator-adapter.ts` | no static remedy captured; inspect implementing owners |
| `SURFACE_WORKER_TIMEOUT` | `packages/cockpit/src/surfaces/generator-adapter.ts` | no static remedy captured; inspect implementing owners |
| `TEMPLATE_IGNORED` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `TEMPLATE_NOT_FOUND` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `TEMPLATE_NOT_TRACKED` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `TEMPLATE_PATH_OUTSIDE_ROOT` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `UPGRADE_AUTH_FAILED` | `packages/cockpit/src/environment/upgrade-application.ts`, `packages/cockpit/src/upgrade/release-evidence.ts` | no static remedy captured; inspect implementing owners |
| `UPGRADE_DISCOVERY_INVALID` | `packages/cockpit/src/upgrade/command.ts` | no static remedy captured; inspect implementing owners |
| `UPGRADE_NETWORK_FAILED` | `packages/cockpit/src/upgrade/command.ts` | no static remedy captured; inspect implementing owners |
| `UPGRADE_REPAIR_UNVERIFIED` | `packages/cockpit/src/upgrade/release-evidence.ts` | no static remedy captured; inspect implementing owners |
| `UPGRADE_SOURCE_INVALID` | `packages/cockpit/src/upgrade/command.ts` | no static remedy captured; inspect implementing owners |
| `UPGRADE_VERSION_AMBIGUOUS` | `packages/cockpit/src/upgrade/command.ts` | no static remedy captured; inspect implementing owners |
| `WORK_APPLICATION_REFUSED` | `packages/cockpit/src/cli.ts` | no static remedy captured; inspect implementing owners |
| `WORK_OPERATOR_REQUIRED` | `packages/cockpit/src/cli.ts` | no static remedy captured; inspect implementing owners |
| `WO_ACCEPTANCE_DECLINED` | `packages/cockpit/src/work-orders/intake.ts` | no static remedy captured; inspect implementing owners |
| `WO_ACCEPTANCE_INVALID` | `packages/cockpit/src/work-orders/intake.ts` | no static remedy captured; inspect implementing owners |
| `WO_ACCEPTANCE_REPLAY` | `packages/cockpit/src/work-orders/intake.ts` | no static remedy captured; inspect implementing owners |
| `WO_ACCEPTANCE_STALE` | `packages/cockpit/src/work-orders/intake.ts` | no static remedy captured; inspect implementing owners |
| `WO_AUDIT_INVALID` | `packages/cockpit/src/work-orders/intake.ts` | no static remedy captured; inspect implementing owners |
| `WO_AUTHORITY_INVALID` | `packages/cockpit/src/work-orders/contract.ts` | no static remedy captured; inspect implementing owners |
| `WO_CONTRACT_INVALID` | `packages/cockpit/src/work-orders/intake.ts`, `packages/cockpit/src/work-orders/state.ts`, `packages/cockpit/src/work-orders/status.ts` | no static remedy captured; inspect implementing owners |
| `WO_CONTRADICTION` | `packages/cockpit/src/work-orders/contract.ts` | no static remedy captured; inspect implementing owners |
| `WO_CRITERIA_INVALID` | `packages/cockpit/src/work-orders/contract.ts` | no static remedy captured; inspect implementing owners |
| `WO_DECISION_INVALID` | `packages/cockpit/src/work-orders/contract.ts` | no static remedy captured; inspect implementing owners |
| `WO_ENCODING_INVALID` | `packages/cockpit/src/work-orders/contract.ts` | no static remedy captured; inspect implementing owners |
| `WO_EVIDENCE_INVALID` | `packages/cockpit/src/work-orders/contract.ts` | no static remedy captured; inspect implementing owners |
| `WO_FIELD_INVALID` | `packages/cockpit/src/work-orders/contract.ts` | no static remedy captured; inspect implementing owners |
| `WO_FRONTMATTER_INVALID` | `packages/cockpit/src/work-orders/contract.ts` | no static remedy captured; inspect implementing owners |
| `WO_HUMAN_PARK` | `packages/cockpit/src/work-orders/pressure.ts` | no static remedy captured; inspect implementing owners |
| `WO_ID_EXISTS` | `packages/cockpit/src/work-orders/intake.ts` | no static remedy captured; inspect implementing owners |
| `WO_INVESTIGATION_PATH` | `packages/cockpit/src/work-orders/pressure.ts` | no static remedy captured; inspect implementing owners |
| `WO_KEY_DUPLICATE` | `packages/cockpit/src/work-orders/contract.ts` | no static remedy captured; inspect implementing owners |
| `WO_KEY_UNKNOWN` | `packages/cockpit/src/work-orders/contract.ts` | no static remedy captured; inspect implementing owners |
| `WO_LINE_BYTES_LIMIT` | `packages/cockpit/src/work-orders/contract.ts` | no static remedy captured; inspect implementing owners |
| `WO_LINE_LIMIT` | `packages/cockpit/src/work-orders/contract.ts` | no static remedy captured; inspect implementing owners |
| `WO_METRICS_HISTORY` | `packages/cockpit/src/work-orders/metrics.ts` | no static remedy captured; inspect implementing owners |
| `WO_METRICS_INVENTORY` | `packages/cockpit/src/work-orders/metrics.ts` | no static remedy captured; inspect implementing owners |
| `WO_METRICS_PROCESS` | `packages/cockpit/src/work-orders/metrics.ts` | no static remedy captured; inspect implementing owners |
| `WO_OPERATOR_REQUIRED` | `packages/cockpit/src/work-orders/intake.ts` | no static remedy captured; inspect implementing owners |
| `WO_PLAN_INVALID` | `packages/cockpit/src/work-orders/contract.ts` | no static remedy captured; inspect implementing owners |
| `WO_POLICY_INVALID` | `packages/cockpit/src/work-orders/intake.ts`, `packages/cockpit/src/work-orders/pressure.ts`, `packages/cockpit/src/work-orders/resume.ts`, `packages/cockpit/src/work-orders/state.ts` | no static remedy captured; inspect implementing owners |
| `WO_PRESSURE_INVALID` | `packages/cockpit/src/work-orders/pressure.ts` | no static remedy captured; inspect implementing owners |
| `WO_PRESSURE_UNCLASSIFIABLE` | `packages/cockpit/src/work-orders/pressure.ts` | no static remedy captured; inspect implementing owners |
| `WO_PROGRAMME_CAP` | `packages/cockpit/src/work-orders/programme.ts` | no static remedy captured; inspect implementing owners |
| `WO_PROGRAMME_CONTRACT` | `packages/cockpit/src/work-orders/programme.ts` | no static remedy captured; inspect implementing owners |
| `WO_PROGRAMME_LEDGER` | `packages/cockpit/src/work-orders/programme.ts` | no static remedy captured; inspect implementing owners |
| `WO_PROGRAMME_ORDER` | `packages/cockpit/src/work-orders/programme.ts` | no static remedy captured; inspect implementing owners |
| `WO_PROGRAMME_PREDECESSOR` | `packages/cockpit/src/work-orders/programme.ts` | no static remedy captured; inspect implementing owners |
| `WO_PROGRAMME_PRESSURE` | `packages/cockpit/src/work-orders/programme.ts` | no static remedy captured; inspect implementing owners |
| `WO_PROGRAMME_SHIPPABILITY` | `packages/cockpit/src/work-orders/programme.ts` | no static remedy captured; inspect implementing owners |
| `WO_RENEWAL_DECISION_REQUIRED` | `packages/cockpit/src/work-orders/intake.ts` | no static remedy captured; inspect implementing owners |
| `WO_RESUME_AMBIGUOUS` | `packages/cockpit/src/work-orders/resume.ts` | no static remedy captured; inspect implementing owners |
| `WO_RESUME_AWAITING_GRADE` | `packages/cockpit/src/work-orders/resume.ts` | no static remedy captured; inspect implementing owners |
| `WO_RESUME_BLOCKED` | `packages/cockpit/src/work-orders/resume.ts` | no static remedy captured; inspect implementing owners |
| `WO_RESUME_NO_ACTIVE` | `packages/cockpit/src/work-orders/resume.ts` | no static remedy captured; inspect implementing owners |
| `WO_ROOT_CAUSE_REQUIRED` | `packages/cockpit/src/work-orders/resume.ts`, `packages/cockpit/src/work-orders/state.ts` | no static remedy captured; inspect implementing owners |
| `WO_ROUTE_REQUIRED` | `packages/cockpit/src/work-orders/intake.ts` | no static remedy captured; inspect implementing owners |
| `WO_SECTION_DUPLICATE` | `packages/cockpit/src/work-orders/contract.ts` | no static remedy captured; inspect implementing owners |
| `WO_SECTION_INVALID` | `packages/cockpit/src/work-orders/contract.ts` | no static remedy captured; inspect implementing owners |
| `WO_SECTION_MISSING` | `packages/cockpit/src/work-orders/contract.ts` | no static remedy captured; inspect implementing owners |
| `WO_SIZE_LIMIT` | `packages/cockpit/src/work-orders/contract.ts` | no static remedy captured; inspect implementing owners |
| `WO_SKILLS_INVALID` | `packages/cockpit/src/work-orders/intake.ts` | no static remedy captured; inspect implementing owners |
| `WO_SOURCE_GAPS` | `packages/cockpit/src/work-orders/intake.ts` | no static remedy captured; inspect implementing owners |
| `WO_SOURCE_INVALID` | `packages/cockpit/src/work-orders/contract.ts` | no static remedy captured; inspect implementing owners |
| `WO_STATE_CONFLICT` | `packages/cockpit/src/work-orders/state.ts` | no static remedy captured; inspect implementing owners |
| `WO_STATE_CONTRADICTION` | `packages/cockpit/src/work-orders/state.ts` | no static remedy captured; inspect implementing owners |
| `WO_STATE_INVALID` | `packages/cockpit/src/work-orders/state.ts`, `packages/cockpit/src/work-orders/status.ts` | no static remedy captured; inspect implementing owners |
| `WO_STATE_PERSIST_FAILED` | `packages/cockpit/src/work-orders/state.ts` | no static remedy captured; inspect implementing owners |
| `WO_STATUS_AMBIGUOUS` | `packages/cockpit/src/work-orders/status.ts` | no static remedy captured; inspect implementing owners |
| `WO_STATUS_INVALID` | `packages/cockpit/src/work-orders/status.ts` | no static remedy captured; inspect implementing owners |
| `WO_SWEEP_OBSERVATION` | `packages/cockpit/src/work-orders/pressure.ts` | no static remedy captured; inspect implementing owners |
| `WO_SWEEP_REPLAY` | `packages/cockpit/src/work-orders/pressure.ts` | no static remedy captured; inspect implementing owners |
| `WO_SWEEP_STALE` | `packages/cockpit/src/work-orders/pressure.ts` | no static remedy captured; inspect implementing owners |
| `WO_SWEEP_WRITE_FAILED` | `packages/cockpit/src/work-orders/pressure.ts` | no static remedy captured; inspect implementing owners |
| `WO_VERIFICATION_INVALID` | `packages/cockpit/src/work-orders/contract.ts` | no static remedy captured; inspect implementing owners |
| `WO_WIP_CAP` | `packages/cockpit/src/work-orders/intake.ts` | no static remedy captured; inspect implementing owners |
| `WO_WIP_INVALID` | `packages/cockpit/src/work-orders/intake.ts` | no static remedy captured; inspect implementing owners |
<!-- cockpit:diagnostic-index:end -->
