# CLI reference

<!-- cockpit:verified version=0.0.0 -->

This generated reference is for users looking up an exact command, flag, exit code or diagnostic. Commands and flags derive from the implementing command table.

## cockpit init

Preview or accept one explicit bootstrap target in an existing checkout.

Configuration: `none`. Owners: none.

| Flag | Type | Default |
| --- | --- | --- |
| `--target` | string | unset |
| `--registry` | string | unset |
| `--interactive` | boolean | `false` |
| `--json` | boolean | `false` |
| `--answers` | string | unset |
| `--accept-preview` | string | unset |
| `--accept-defaults` | string | unset |

| Exit | Meaning |
| --- | --- |
| 0 | success |
| 2 | failure |
| 130 | cancelled |

| Diagnostic | Implementing owners | Source remedy |
| --- | --- | --- |
| `CHECKOUT_ADJACENCY_UNHEALTHY` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `CLAIM_CO_TENANT` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `CLAIM_LIVENESS_UNKNOWN` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `CLAIM_STATE_UNHEALTHY` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `CLI_INTERNAL_ERROR` | `packages/cockpit/src/cli.ts`, `packages/cockpit/src/environment/operator-application.ts` | no static remedy captured; inspect implementing owners |
| `CLI_USAGE_INVALID` | `packages/cockpit/src/cli.ts`, `packages/cockpit/src/environment/runtime-measurement.ts`, `packages/cockpit/src/environment/sibling-registration.ts`, `packages/cockpit/src/generated-environment/adopt.ts` | no static remedy captured; inspect implementing owners |
| `COCKPIT_VERSION_MISMATCH` | `packages/cockpit/src/environment/contract.ts`, `packages/cockpit/src/team-metadata.ts` | no static remedy captured; inspect implementing owners |
| `COMPOSE_TOPOLOGY_UNAVAILABLE` | `packages/cockpit/src/environment/generated-application.ts` | install Docker with the Compose plugin on PATH and make `docker compose config` succeed for environment.compose_files |
| `CONFIG_CHANGED_DURING_EXECUTION` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `CONFIG_ENCODING_INVALID` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `CONFIG_NOT_FOUND` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `CONFIG_PARSE_INVALID` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `CONFIG_SCHEMA_INVALID` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `CONFIG_STALE` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `CONFIG_UNREADABLE` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `DATA_MODE_UNAVAILABLE` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `DIRECTORY_GRANTS_UNAVAILABLE` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `DISK_BUDGET_EXCEEDED` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
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
| `DOCUMENT_GUARD_HOSTS_NONE` | `packages/cockpit/src/document/command.ts` | list the hosts in guards.hosted_db_hosts and guards.vendor_endpoint_hosts and run cockpit sync once a non-local environment exists |
| `DOCUMENT_INFERRED` | `packages/cockpit/src/document/command.ts` | no static remedy captured; inspect implementing owners |
| `DOCUMENT_NO_RUNNABLE_PRODUCT` | `packages/cockpit/src/document/command.ts` | no static remedy captured; inspect implementing owners |
| `DOCUMENT_RUNNABLE_TOPOLOGY_MISMATCH` | `packages/cockpit/src/document/command.ts` | no static remedy captured; inspect implementing owners |
| `DOCUMENT_RUNTIME_NOT_DECLARED` | `packages/cockpit/src/document/command.ts` | once a product runs, declare environment.compose_files or [environment.generated] and run cockpit sync |
| `DOCUMENT_SOURCE_REQUIRED` | `packages/cockpit/src/cli.ts`, `packages/cockpit/src/document/command.ts` | no static remedy captured; inspect implementing owners |
| `DOCUMENT_STDOUT_TARGET` | `packages/cockpit/src/document/command.ts` | no static remedy captured; inspect implementing owners |
| `DRAIN_ATTEMPT_REPAIR_REQUIRED` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `ENVIRONMENT_FILE_MALFORMED` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `ENVIRONMENT_FILE_NOT_FOUND` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `ENVIRONMENT_FILE_TOO_LARGE` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `ENVIRONMENT_FILE_UNREADABLE` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `ENVIRONMENT_KEYS_STALE` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `ENVIRONMENT_NOT_DECLARED` | `packages/cockpit/src/environment/contract.ts`, `packages/cockpit/src/environment/declaration.ts` | declare environment.compose_files = ["compose.yml"] to run your own Compose file, or [environment.generated] to have cockpit render one, then run cockpit sync |
| `ENVIRONMENT_SEED_FAILED` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `ENVIRONMENT_SEED_PRECONDITION_CHANGED` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `ENV_SCHEMA_TOOL_MISSING` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `ENV_SCHEMA_UNHEALTHY` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
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
| `GENERATED_ARTIFACT_DRIFT` | `packages/cockpit/src/environment/generated-application.ts`, `packages/cockpit/src/environment/generated-stack.ts` | no static remedy captured; inspect implementing owners |
| `GENERATED_ARTIFACT_MISSING` | `packages/cockpit/src/environment/generated-application.ts`, `packages/cockpit/src/environment/generated-stack.ts` | no static remedy captured; inspect implementing owners |
| `GENERATED_COMPENSATION_FAILED` | `packages/cockpit/src/generated-environment/transaction.ts` | no static remedy captured; inspect implementing owners |
| `GENERATED_DECISIONS_UNDECIDED` | `packages/cockpit/src/environment/generated-application.ts` | no static remedy captured; inspect implementing owners |
| `GENERATED_DECLARATION_INVALID` | `packages/cockpit/src/environment/generated-application.ts`, `packages/cockpit/src/environment/generated-render.ts` | no static remedy captured; inspect implementing owners |
| `GENERATED_DECLARATION_MISSING` | `packages/cockpit/src/environment/generated-application.ts` | no static remedy captured; inspect implementing owners |
| `GENERATED_ENVIRONMENT_UNAVAILABLE` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `GENERATED_EXECUTABLE_UNAVAILABLE` | `packages/cockpit/src/environment/generated-application.ts`, `packages/cockpit/src/generated-environment/uninstall.ts` | no static remedy captured; inspect implementing owners |
| `GENERATED_INPUT_INVALID` | `packages/cockpit/src/environment/generated-application.ts`, `packages/cockpit/src/environment/generated-render.ts`, `packages/cockpit/src/generated-environment/uninstall.ts` | no static remedy captured; inspect implementing owners |
| `GENERATED_OWNERSHIP_DRIFT` | `packages/cockpit/src/environment/generated-application.ts` | no static remedy captured; inspect implementing owners |
| `GENERATED_OWNERSHIP_FORMAT_UNSUPPORTED` | `packages/cockpit/src/environment/generated-application.ts`, `packages/cockpit/src/generated-environment/uninstall.ts` | no static remedy captured; inspect implementing owners |
| `GENERATED_OWNERSHIP_INVALID` | `packages/cockpit/src/environment/generated-application.ts`, `packages/cockpit/src/generated-environment/adopt.ts`, `packages/cockpit/src/generated-environment/transaction.ts`, `packages/cockpit/src/generated-environment/uninstall.ts` | no static remedy captured; inspect implementing owners |
| `GENERATED_OWNERSHIP_MISSING` | `packages/cockpit/src/environment/generated-application.ts`, `packages/cockpit/src/generated-environment/transaction.ts`, `packages/cockpit/src/generated-environment/uninstall.ts` | no static remedy captured; inspect implementing owners |
| `GENERATED_PATH_DUPLICATE` | `packages/cockpit/src/environment/generated-application.ts` | no static remedy captured; inspect implementing owners |
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
| `GIT_COMPARISON_REMOTE_MISMATCH` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `GIT_STATE_UNHEALTHY` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `GREENFIELD_ANSWER_INVALID` | `packages/cockpit/src/environment/init-application.ts` | no static remedy captured; inspect implementing owners |
| `GREENFIELD_ANSWER_UNEXPECTED` | `packages/cockpit/src/environment/init-application.ts` | no static remedy captured; inspect implementing owners |
| `GREENFIELD_DISCOVERY_UNAVAILABLE` | `packages/cockpit/src/environment/init-application.ts` | no static remedy captured; inspect implementing owners |
| `GREENFIELD_OBSERVATION_CHANGED` | `packages/cockpit/src/environment/init-application.ts` | no static remedy captured; inspect implementing owners |
| `GREENFIELD_OBSERVATION_INVALID` | `packages/cockpit/src/environment/init-application.ts` | no static remedy captured; inspect implementing owners |
| `GUARD_AUTHORITY_UNAVAILABLE` | `packages/cockpit/src/environment/application.ts` | no static remedy captured; inspect implementing owners |
| `GUARD_HOSTS_UNDECLARED` | `packages/cockpit/src/environment/application.ts`, `packages/cockpit/src/environment/contract.ts` | list the database and live vendor API hosts of every non-local environment (production, staging, shared) under [guards] in cockpit.toml, then run cockpit sync; if no such environment exists, record that by writing hosted_db_hosts = [] and vendor_endpoint_hosts = [] under [guards] |
| `GUARD_REFUSED` | `packages/cockpit/src/environment/application.ts` | no static remedy captured; inspect implementing owners |
| `GUIDE_CAP_EXCEEDED` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `HARNESS_SURFACE_UNAVAILABLE` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `INIT_BOOTSTRAP_IDENTITY_CHANGED` | `packages/cockpit/src/environment/init-application.ts` | no static remedy captured; inspect implementing owners |
| `INIT_CANONICAL_OWNERSHIP_MISSING` | `packages/cockpit/src/environment/init-application.ts` | no static remedy captured; inspect implementing owners |
| `INIT_COCKPIT_ROOT_REQUIRED` | `packages/cockpit/src/environment/init-application.ts` | no static remedy captured; inspect implementing owners |
| `INIT_DRAFT_CHANGED` | `packages/cockpit/src/environment/init-application.ts` | no static remedy captured; inspect implementing owners |
| `INIT_DRAFT_INVALID` | `packages/cockpit/src/environment/init-application.ts` | no static remedy captured; inspect implementing owners |
| `INIT_DRAFT_SOURCE_CHANGED` | `packages/cockpit/src/environment/init-application.ts` | no static remedy captured; inspect implementing owners |
| `INIT_INTERVIEW_PREVIEW_UNAVAILABLE` | `packages/cockpit/src/environment/init-application.ts` | no static remedy captured; inspect implementing owners |
| `INIT_PREVIEW_CHANGED` | `packages/cockpit/src/environment/init-application.ts` | no static remedy captured; inspect implementing owners |
| `INIT_ROOT_INVALID` | `packages/cockpit/src/environment/init-application.ts` | no static remedy captured; inspect implementing owners |
| `INIT_ROOT_OBSERVATION_FAILED` | `packages/cockpit/src/environment/init-application.ts` | no static remedy captured; inspect implementing owners |
| `INIT_STATE_DURABILITY_INDETERMINATE` | `packages/cockpit/src/environment/init-application.ts` | no static remedy captured; inspect implementing owners |
| `INIT_STATE_STALE` | `packages/cockpit/src/environment/init-application.ts` | no static remedy captured; inspect implementing owners |
| `INIT_STATE_UNAUTHENTICATED` | `packages/cockpit/src/environment/init-application.ts` | no static remedy captured; inspect implementing owners |
| `INIT_TARGET_CHANGED` | `packages/cockpit/src/environment/init-application.ts` | no static remedy captured; inspect implementing owners |
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
| `MCP_DECLARATION_INVALID` | `packages/cockpit/src/environment/generated-application.ts`, `packages/cockpit/src/surfaces/mcp.ts` | no static remedy captured; inspect implementing owners |
| `MOUNT_MATERIALIZATION_UNAVAILABLE` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `MOUNT_POSTURE_UNAVAILABLE` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `PORT_EXTERNAL_REGISTRATION_GAP` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `PORT_FAMILY_COLLISION` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `PORT_FAMILY_OUT_OF_RANGE` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `PORT_LEASE_EXHAUSTED` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `PORT_LISTENER_EVIDENCE_INVALID` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `PORT_LOCAL_VALUE_CORRECTED` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `RECLAIM_ACCOUNTING_MISMATCH` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `RECLAIM_LABEL_ESCAPE` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `REGISTRY_AUTH_UNAVAILABLE` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `REGISTRY_EMPTY` | `packages/cockpit/src/document/command.ts`, `packages/cockpit/src/registry-resolve/command.ts` | no static remedy captured; inspect implementing owners |
| `REGISTRY_ENCODING_INVALID` | `packages/cockpit/src/document/command.ts`, `packages/cockpit/src/registry-resolve/command.ts` | no static remedy captured; inspect implementing owners |
| `REGISTRY_NOT_FOUND` | `packages/cockpit/src/document/command.ts`, `packages/cockpit/src/registry-resolve/command.ts` | no static remedy captured; inspect implementing owners |
| `REGISTRY_ROW_SKIPPED` | `packages/cockpit/src/document/command.ts`, `packages/cockpit/src/registry-resolve/command.ts` | repair every skipped row before documenting repository scope |
| `REGISTRY_TOO_LARGE` | `packages/cockpit/src/document/command.ts`, `packages/cockpit/src/registry-resolve/command.ts` | no static remedy captured; inspect implementing owners |
| `REGISTRY_UNREADABLE` | `packages/cockpit/src/document/command.ts`, `packages/cockpit/src/registry-resolve/command.ts` | no static remedy captured; inspect implementing owners |
| `RESET_CONFIRMATION_MISMATCH` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `RESET_CONFIRMATION_REQUIRED` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `RESET_CO_TENANT` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `RUNNING_CHECKOUT_MISMATCH` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `RUNTIME_COMPOSE_REMOTE` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `RUNTIME_LAUNCHER_UNAVAILABLE` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `RUNTIME_PROBE_TIMEOUT` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `RUNTIME_UNAVAILABLE` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `RUNTIME_UNMEASURED` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `SETUP_CONFIG_REQUIRED` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `SETUP_INSTRUCTION_POINTER_INVALID` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `SETUP_INSTRUCTION_POINTER_OFFERED` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
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
| `SKILL_RENDER_INVALID` | `packages/cockpit/src/environment/generated-application.ts`, `packages/cockpit/src/surfaces/skill-contract.ts` | no static remedy captured; inspect implementing owners |
| `STATE_DURABILITY_INDETERMINATE` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `STATE_FORMAT_UNSUPPORTED` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `STATE_LOCKED` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `STATE_RECORD_MALFORMED` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `STATE_ROOT_UNAVAILABLE` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `STATE_UNSEEDED` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `SURFACE_ADOPTION_REFUSED` | `packages/cockpit/src/environment/generated-application.ts`, `packages/cockpit/src/generated-environment/adopt.ts`, `packages/cockpit/src/generated-environment/uninstall.ts`, `packages/cockpit/src/surfaces/adoption.ts` | no static remedy captured; inspect implementing owners |
| `SURFACE_BOUNDS` | `packages/cockpit/src/environment/generated-application.ts`, `packages/cockpit/src/surfaces/check.ts`, `packages/cockpit/src/surfaces/ownership.ts`, `packages/cockpit/src/surfaces/render.ts` | no static remedy captured; inspect implementing owners |
| `SURFACE_CUSTOM_REFUSED` | `packages/cockpit/src/environment/generated-application.ts` | no static remedy captured; inspect implementing owners |
| `SURFACE_GENERATION_FAILED` | `packages/cockpit/src/environment/generated-application.ts` | no static remedy captured; inspect implementing owners |
| `SURFACE_INPUT_INVALID` | `packages/cockpit/src/environment/generated-application.ts`, `packages/cockpit/src/surfaces/check.ts`, `packages/cockpit/src/surfaces/generator-adapter.ts`, `packages/cockpit/src/surfaces/merge.ts`, `packages/cockpit/src/surfaces/ownership.ts`, `packages/cockpit/src/surfaces/render.ts` | no static remedy captured; inspect implementing owners |
| `SURFACE_OVERRIDE_INSPECTION_INVALID` | `packages/cockpit/src/environment/application.ts`, `packages/cockpit/src/environment/health-composition.ts` | no static remedy captured; inspect implementing owners |
| `SURFACE_OVERRIDE_INSPECTION_UNAVAILABLE` | `packages/cockpit/src/environment/application.ts`, `packages/cockpit/src/environment/health-composition.ts` | no static remedy captured; inspect implementing owners |
| `SURFACE_PATH_CONFLICT` | `packages/cockpit/src/environment/generated-application.ts`, `packages/cockpit/src/surfaces/merge.ts`, `packages/cockpit/src/surfaces/ownership.ts`, `packages/cockpit/src/surfaces/render.ts` | no static remedy captured; inspect implementing owners |
| `SURFACE_SOURCE_UNAVAILABLE` | `packages/cockpit/src/environment/generated-application.ts` | no static remedy captured; inspect implementing owners |
| `SURFACE_STATE_CONFLICT` | `packages/cockpit/src/environment/generated-application.ts`, `packages/cockpit/src/surfaces/ownership.ts`, `packages/cockpit/src/surfaces/sync.ts` | no static remedy captured; inspect implementing owners |
| `TEAM_METADATA_UNAVAILABLE` | `packages/cockpit/src/environment/contract.ts`, `packages/cockpit/src/team-metadata.ts` | no static remedy captured; inspect implementing owners |
| `TEMPLATE_IGNORED` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `TEMPLATE_NOT_FOUND` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `TEMPLATE_NOT_TRACKED` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `TEMPLATE_PATH_OUTSIDE_ROOT` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `WO_ACCEPTANCE_DECLINED` | `packages/cockpit/src/work-orders/intake.ts` | no static remedy captured; inspect implementing owners |
| `WO_ACCEPTANCE_INVALID` | `packages/cockpit/src/work-orders/intake.ts` | no static remedy captured; inspect implementing owners |
| `WO_ACCEPTANCE_REPLAY` | `packages/cockpit/src/work-orders/intake.ts` | no static remedy captured; inspect implementing owners |
| `WO_ACCEPTANCE_STALE` | `packages/cockpit/src/work-orders/intake.ts` | no static remedy captured; inspect implementing owners |
| `WO_AUDIT_INVALID` | `packages/cockpit/src/work-orders/intake.ts` | no static remedy captured; inspect implementing owners |
| `WO_CONTRACT_INVALID` | `packages/cockpit/src/work-orders/intake.ts`, `packages/cockpit/src/work-orders/state.ts`, `packages/cockpit/src/work-orders/status.ts` | no static remedy captured; inspect implementing owners |
| `WO_ID_EXISTS` | `packages/cockpit/src/work-orders/intake.ts` | no static remedy captured; inspect implementing owners |
| `WO_OPERATOR_REQUIRED` | `packages/cockpit/src/work-orders/intake.ts` | no static remedy captured; inspect implementing owners |
| `WO_POLICY_INVALID` | `packages/cockpit/src/work-orders/intake.ts`, `packages/cockpit/src/work-orders/pressure.ts`, `packages/cockpit/src/work-orders/resume.ts`, `packages/cockpit/src/work-orders/state.ts` | no static remedy captured; inspect implementing owners |
| `WO_RENEWAL_DECISION_REQUIRED` | `packages/cockpit/src/work-orders/intake.ts` | no static remedy captured; inspect implementing owners |
| `WO_ROUTE_REQUIRED` | `packages/cockpit/src/work-orders/intake.ts` | no static remedy captured; inspect implementing owners |
| `WO_SKILLS_INVALID` | `packages/cockpit/src/work-orders/intake.ts` | no static remedy captured; inspect implementing owners |
| `WO_SOURCE_GAPS` | `packages/cockpit/src/work-orders/intake.ts` | no static remedy captured; inspect implementing owners |
| `WO_WIP_CAP` | `packages/cockpit/src/work-orders/intake.ts` | no static remedy captured; inspect implementing owners |
| `WO_WIP_INVALID` | `packages/cockpit/src/work-orders/intake.ts` | no static remedy captured; inspect implementing owners |

## cockpit document

Describe an existing cockpit as attributed cockpit.toml content.

Configuration: `none`. Owners: none.

| Flag | Type | Default |
| --- | --- | --- |
| `--registry` | string | unset |
| `--output` | string | unset |
| `--json` | boolean | `false` |

| Exit | Meaning |
| --- | --- |
| 0 | success |
| 2 | failure |
| 130 | cancelled |

| Diagnostic | Implementing owners | Source remedy |
| --- | --- | --- |
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
| `DOCUMENT_GUARD_HOSTS_NONE` | `packages/cockpit/src/document/command.ts` | list the hosts in guards.hosted_db_hosts and guards.vendor_endpoint_hosts and run cockpit sync once a non-local environment exists |
| `DOCUMENT_INFERRED` | `packages/cockpit/src/document/command.ts` | no static remedy captured; inspect implementing owners |
| `DOCUMENT_NO_RUNNABLE_PRODUCT` | `packages/cockpit/src/document/command.ts` | no static remedy captured; inspect implementing owners |
| `DOCUMENT_RUNNABLE_TOPOLOGY_MISMATCH` | `packages/cockpit/src/document/command.ts` | no static remedy captured; inspect implementing owners |
| `DOCUMENT_RUNTIME_NOT_DECLARED` | `packages/cockpit/src/document/command.ts` | once a product runs, declare environment.compose_files or [environment.generated] and run cockpit sync |
| `DOCUMENT_SOURCE_REQUIRED` | `packages/cockpit/src/cli.ts`, `packages/cockpit/src/document/command.ts` | no static remedy captured; inspect implementing owners |
| `DOCUMENT_STDOUT_TARGET` | `packages/cockpit/src/document/command.ts` | no static remedy captured; inspect implementing owners |
| `REGISTRY_EMPTY` | `packages/cockpit/src/document/command.ts`, `packages/cockpit/src/registry-resolve/command.ts` | no static remedy captured; inspect implementing owners |
| `REGISTRY_ENCODING_INVALID` | `packages/cockpit/src/document/command.ts`, `packages/cockpit/src/registry-resolve/command.ts` | no static remedy captured; inspect implementing owners |
| `REGISTRY_NOT_FOUND` | `packages/cockpit/src/document/command.ts`, `packages/cockpit/src/registry-resolve/command.ts` | no static remedy captured; inspect implementing owners |
| `REGISTRY_ROW_SKIPPED` | `packages/cockpit/src/document/command.ts`, `packages/cockpit/src/registry-resolve/command.ts` | repair every skipped row before documenting repository scope |
| `REGISTRY_TOO_LARGE` | `packages/cockpit/src/document/command.ts`, `packages/cockpit/src/registry-resolve/command.ts` | no static remedy captured; inspect implementing owners |
| `REGISTRY_UNREADABLE` | `packages/cockpit/src/document/command.ts`, `packages/cockpit/src/registry-resolve/command.ts` | no static remedy captured; inspect implementing owners |

## cockpit registry-resolve

Resolve a validated legacy registry into sourceable shell data.

Configuration: `none`. Owners: none.

| Flag | Type | Default |
| --- | --- | --- |
| `--registry` | string | unset |
| `--siblings-root` | string | unset |
| `--adoption` | string | unset |
| `--json` | boolean | `false` |

| Exit | Meaning |
| --- | --- |
| 0 | success |
| 2 | failure |
| 130 | cancelled |

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
| `COCKPIT_REVISION_INVALID` | `packages/cockpit/src/registry-resolve/command.ts` | no static remedy captured; inspect implementing owners |
| `REGISTRY_ARTIFACT_UNSAFE` | `packages/cockpit/src/registry-resolve/command.ts` | no static remedy captured; inspect implementing owners |
| `REGISTRY_DIR_DUPLICATE` | `packages/cockpit/src/registry-resolve/command.ts` | no static remedy captured; inspect implementing owners |
| `REGISTRY_DIR_OUTSIDE_SIBLINGS_ROOT` | `packages/cockpit/src/registry-resolve/command.ts` | no static remedy captured; inspect implementing owners |
| `REGISTRY_EMPTY` | `packages/cockpit/src/document/command.ts`, `packages/cockpit/src/registry-resolve/command.ts` | no static remedy captured; inspect implementing owners |
| `REGISTRY_ENCODING_INVALID` | `packages/cockpit/src/document/command.ts`, `packages/cockpit/src/registry-resolve/command.ts` | no static remedy captured; inspect implementing owners |
| `REGISTRY_NOT_FOUND` | `packages/cockpit/src/document/command.ts`, `packages/cockpit/src/registry-resolve/command.ts` | no static remedy captured; inspect implementing owners |
| `REGISTRY_ROW_SKIPPED` | `packages/cockpit/src/document/command.ts`, `packages/cockpit/src/registry-resolve/command.ts` | repair every skipped row before documenting repository scope |
| `REGISTRY_TOO_LARGE` | `packages/cockpit/src/document/command.ts`, `packages/cockpit/src/registry-resolve/command.ts` | no static remedy captured; inspect implementing owners |
| `REGISTRY_UNREADABLE` | `packages/cockpit/src/document/command.ts`, `packages/cockpit/src/registry-resolve/command.ts` | no static remedy captured; inspect implementing owners |
| `REGISTRY_VARIABLE_INVALID` | `packages/cockpit/src/registry-resolve/command.ts` | no static remedy captured; inspect implementing owners |

## cockpit setup

Acquire and wire declared sibling repositories.

Configuration: `resolved`. Owners: `packages/cockpit/src/config/load.ts`, `packages/cockpit/src/schema.ts`.

| Flag | Type | Default |
| --- | --- | --- |
| `--config` | string | unset |
| `--write-instruction-pointers` | boolean | `false` |
| `--json` | boolean | `false` |

| Exit | Meaning |
| --- | --- |
| 0 | success |
| 2 | failure |
| 130 | cancelled |

| Diagnostic | Implementing owners | Source remedy |
| --- | --- | --- |
| `GUARD_AUTHORITY_UNAVAILABLE` | `packages/cockpit/src/environment/application.ts` | no static remedy captured; inspect implementing owners |
| `GUARD_HOSTS_UNDECLARED` | `packages/cockpit/src/environment/application.ts`, `packages/cockpit/src/environment/contract.ts` | list the database and live vendor API hosts of every non-local environment (production, staging, shared) under [guards] in cockpit.toml, then run cockpit sync; if no such environment exists, record that by writing hosted_db_hosts = [] and vendor_endpoint_hosts = [] under [guards] |
| `GUARD_REFUSED` | `packages/cockpit/src/environment/application.ts` | no static remedy captured; inspect implementing owners |
| `SURFACE_OVERRIDE_INSPECTION_INVALID` | `packages/cockpit/src/environment/application.ts`, `packages/cockpit/src/environment/health-composition.ts` | no static remedy captured; inspect implementing owners |
| `SURFACE_OVERRIDE_INSPECTION_UNAVAILABLE` | `packages/cockpit/src/environment/application.ts`, `packages/cockpit/src/environment/health-composition.ts` | no static remedy captured; inspect implementing owners |

## cockpit sync

Synchronize canonical generated environment files.

Configuration: `resolved`. Owners: `packages/cockpit/src/config/load.ts`, `packages/cockpit/src/schema.ts`.

| Flag | Type | Default |
| --- | --- | --- |
| `--config` | string | unset |
| `--dry-run` | boolean | `false` |
| `--adopt` | string | unset |
| `--interactive` | boolean | `false` |
| `--json` | boolean | `false` |

| Exit | Meaning |
| --- | --- |
| 0 | success |
| 2 | failure |
| 130 | cancelled |

| Diagnostic | Implementing owners | Source remedy |
| --- | --- | --- |
| `CHECKOUT_ADJACENCY_UNHEALTHY` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `CLAIM_CO_TENANT` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `CLAIM_LIVENESS_UNKNOWN` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `CLAIM_STATE_UNHEALTHY` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `CLI_INTERNAL_ERROR` | `packages/cockpit/src/cli.ts`, `packages/cockpit/src/environment/operator-application.ts` | no static remedy captured; inspect implementing owners |
| `CLI_USAGE_INVALID` | `packages/cockpit/src/cli.ts`, `packages/cockpit/src/environment/runtime-measurement.ts`, `packages/cockpit/src/environment/sibling-registration.ts`, `packages/cockpit/src/generated-environment/adopt.ts` | no static remedy captured; inspect implementing owners |
| `COCKPIT_VERSION_MISMATCH` | `packages/cockpit/src/environment/contract.ts`, `packages/cockpit/src/team-metadata.ts` | no static remedy captured; inspect implementing owners |
| `COMPOSE_TOPOLOGY_UNAVAILABLE` | `packages/cockpit/src/environment/generated-application.ts` | install Docker with the Compose plugin on PATH and make `docker compose config` succeed for environment.compose_files |
| `CONFIG_CHANGED_DURING_EXECUTION` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `CONFIG_ENCODING_INVALID` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `CONFIG_NOT_FOUND` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `CONFIG_PARSE_INVALID` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `CONFIG_SCHEMA_INVALID` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `CONFIG_STALE` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `CONFIG_UNREADABLE` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `DATA_MODE_UNAVAILABLE` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `DIRECTORY_GRANTS_UNAVAILABLE` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `DISK_BUDGET_EXCEEDED` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `DRAIN_ATTEMPT_REPAIR_REQUIRED` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `ENVIRONMENT_FILE_MALFORMED` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `ENVIRONMENT_FILE_NOT_FOUND` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `ENVIRONMENT_FILE_TOO_LARGE` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `ENVIRONMENT_FILE_UNREADABLE` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `ENVIRONMENT_KEYS_STALE` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `ENVIRONMENT_NOT_DECLARED` | `packages/cockpit/src/environment/contract.ts`, `packages/cockpit/src/environment/declaration.ts` | declare environment.compose_files = ["compose.yml"] to run your own Compose file, or [environment.generated] to have cockpit render one, then run cockpit sync |
| `ENVIRONMENT_SEED_FAILED` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `ENVIRONMENT_SEED_PRECONDITION_CHANGED` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `ENV_SCHEMA_TOOL_MISSING` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `ENV_SCHEMA_UNHEALTHY` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
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
| `GENERATED_ARTIFACT_DRIFT` | `packages/cockpit/src/environment/generated-application.ts`, `packages/cockpit/src/environment/generated-stack.ts` | no static remedy captured; inspect implementing owners |
| `GENERATED_ARTIFACT_MISSING` | `packages/cockpit/src/environment/generated-application.ts`, `packages/cockpit/src/environment/generated-stack.ts` | no static remedy captured; inspect implementing owners |
| `GENERATED_DECISIONS_UNDECIDED` | `packages/cockpit/src/environment/generated-application.ts` | no static remedy captured; inspect implementing owners |
| `GENERATED_DECLARATION_INVALID` | `packages/cockpit/src/environment/generated-application.ts`, `packages/cockpit/src/environment/generated-render.ts` | no static remedy captured; inspect implementing owners |
| `GENERATED_DECLARATION_MISSING` | `packages/cockpit/src/environment/generated-application.ts` | no static remedy captured; inspect implementing owners |
| `GENERATED_ENVIRONMENT_UNAVAILABLE` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `GENERATED_EXECUTABLE_UNAVAILABLE` | `packages/cockpit/src/environment/generated-application.ts`, `packages/cockpit/src/generated-environment/uninstall.ts` | no static remedy captured; inspect implementing owners |
| `GENERATED_INPUT_INVALID` | `packages/cockpit/src/environment/generated-application.ts`, `packages/cockpit/src/environment/generated-render.ts`, `packages/cockpit/src/generated-environment/uninstall.ts` | no static remedy captured; inspect implementing owners |
| `GENERATED_OWNERSHIP_DRIFT` | `packages/cockpit/src/environment/generated-application.ts` | no static remedy captured; inspect implementing owners |
| `GENERATED_OWNERSHIP_FORMAT_UNSUPPORTED` | `packages/cockpit/src/environment/generated-application.ts`, `packages/cockpit/src/generated-environment/uninstall.ts` | no static remedy captured; inspect implementing owners |
| `GENERATED_OWNERSHIP_INVALID` | `packages/cockpit/src/environment/generated-application.ts`, `packages/cockpit/src/generated-environment/adopt.ts`, `packages/cockpit/src/generated-environment/transaction.ts`, `packages/cockpit/src/generated-environment/uninstall.ts` | no static remedy captured; inspect implementing owners |
| `GENERATED_OWNERSHIP_MISSING` | `packages/cockpit/src/environment/generated-application.ts`, `packages/cockpit/src/generated-environment/transaction.ts`, `packages/cockpit/src/generated-environment/uninstall.ts` | no static remedy captured; inspect implementing owners |
| `GENERATED_PATH_DUPLICATE` | `packages/cockpit/src/environment/generated-application.ts` | no static remedy captured; inspect implementing owners |
| `GENERATED_PATH_UNSAFE` | `packages/cockpit/src/environment/generated-application.ts`, `packages/cockpit/src/generated-environment/transaction.ts` | no static remedy captured; inspect implementing owners |
| `GENERATED_PERSONA_INVALID` | `packages/cockpit/src/environment/generated-application.ts` | no static remedy captured; inspect implementing owners |
| `GENERATED_PERSONA_SOURCE_UNAVAILABLE` | `packages/cockpit/src/environment/generated-application.ts` | no static remedy captured; inspect implementing owners |
| `GENERATED_PUBLICATION_FAILED` | `packages/cockpit/src/environment/generated-application.ts`, `packages/cockpit/src/generated-environment/transaction.ts` | no static remedy captured; inspect implementing owners |
| `GENERATED_RENDER_UNAUTHENTICATED` | `packages/cockpit/src/environment/generated-application.ts`, `packages/cockpit/src/environment/generated-stack.ts` | no static remedy captured; inspect implementing owners |
| `GENERATED_SIBLING_ROOT_INVALID` | `packages/cockpit/src/environment/generated-application.ts` | no static remedy captured; inspect implementing owners |
| `GENERATED_SOURCE_CHANGED` | `packages/cockpit/src/environment/generated-application.ts`, `packages/cockpit/src/generated-environment/transaction.ts` | no static remedy captured; inspect implementing owners |
| `GENERATED_STALE_APPROVAL_REQUIRED` | `packages/cockpit/src/environment/operator-application.ts`, `packages/cockpit/src/generated-environment/transaction.ts` | no static remedy captured; inspect implementing owners |
| `GENERATED_STALE_ARTIFACT` | `packages/cockpit/src/environment/generated-application.ts` | no static remedy captured; inspect implementing owners |
| `GENERATED_STALE_ARTIFACT_DRIFT` | `packages/cockpit/src/environment/generated-application.ts`, `packages/cockpit/src/generated-environment/transaction.ts`, `packages/cockpit/src/generated-environment/uninstall.ts` | no static remedy captured; inspect implementing owners |
| `GIT_COMPARISON_REMOTE_MISMATCH` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `GIT_STATE_UNHEALTHY` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `GUARD_HOSTS_UNDECLARED` | `packages/cockpit/src/environment/application.ts`, `packages/cockpit/src/environment/contract.ts` | list the database and live vendor API hosts of every non-local environment (production, staging, shared) under [guards] in cockpit.toml, then run cockpit sync; if no such environment exists, record that by writing hosted_db_hosts = [] and vendor_endpoint_hosts = [] under [guards] |
| `GUIDE_CAP_EXCEEDED` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `HARNESS_SURFACE_UNAVAILABLE` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
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
| `MCP_DECLARATION_INVALID` | `packages/cockpit/src/environment/generated-application.ts`, `packages/cockpit/src/surfaces/mcp.ts` | no static remedy captured; inspect implementing owners |
| `MOUNT_MATERIALIZATION_UNAVAILABLE` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `MOUNT_POSTURE_UNAVAILABLE` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `PORT_EXTERNAL_REGISTRATION_GAP` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `PORT_FAMILY_COLLISION` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `PORT_FAMILY_OUT_OF_RANGE` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `PORT_LEASE_EXHAUSTED` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `PORT_LISTENER_EVIDENCE_INVALID` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `PORT_LOCAL_VALUE_CORRECTED` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `RECLAIM_ACCOUNTING_MISMATCH` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `RECLAIM_LABEL_ESCAPE` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `REGISTRY_AUTH_UNAVAILABLE` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `RESET_CONFIRMATION_MISMATCH` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `RESET_CONFIRMATION_REQUIRED` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `RESET_CO_TENANT` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `RUNNING_CHECKOUT_MISMATCH` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `RUNTIME_COMPOSE_REMOTE` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `RUNTIME_LAUNCHER_UNAVAILABLE` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `RUNTIME_PROBE_TIMEOUT` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `RUNTIME_UNAVAILABLE` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `RUNTIME_UNMEASURED` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `SETUP_CONFIG_REQUIRED` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `SETUP_INSTRUCTION_POINTER_INVALID` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `SETUP_INSTRUCTION_POINTER_OFFERED` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
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
| `SKILL_RENDER_INVALID` | `packages/cockpit/src/environment/generated-application.ts`, `packages/cockpit/src/surfaces/skill-contract.ts` | no static remedy captured; inspect implementing owners |
| `STATE_DURABILITY_INDETERMINATE` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `STATE_FORMAT_UNSUPPORTED` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `STATE_LOCKED` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `STATE_RECORD_MALFORMED` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `STATE_ROOT_UNAVAILABLE` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `STATE_UNSEEDED` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `SURFACE_ADOPTION_REFUSED` | `packages/cockpit/src/environment/generated-application.ts`, `packages/cockpit/src/generated-environment/adopt.ts`, `packages/cockpit/src/generated-environment/uninstall.ts`, `packages/cockpit/src/surfaces/adoption.ts` | no static remedy captured; inspect implementing owners |
| `SURFACE_BOUNDS` | `packages/cockpit/src/environment/generated-application.ts`, `packages/cockpit/src/surfaces/check.ts`, `packages/cockpit/src/surfaces/ownership.ts`, `packages/cockpit/src/surfaces/render.ts` | no static remedy captured; inspect implementing owners |
| `SURFACE_CUSTOM_REFUSED` | `packages/cockpit/src/environment/generated-application.ts` | no static remedy captured; inspect implementing owners |
| `SURFACE_GENERATION_FAILED` | `packages/cockpit/src/environment/generated-application.ts` | no static remedy captured; inspect implementing owners |
| `SURFACE_INPUT_INVALID` | `packages/cockpit/src/environment/generated-application.ts`, `packages/cockpit/src/surfaces/check.ts`, `packages/cockpit/src/surfaces/generator-adapter.ts`, `packages/cockpit/src/surfaces/merge.ts`, `packages/cockpit/src/surfaces/ownership.ts`, `packages/cockpit/src/surfaces/render.ts` | no static remedy captured; inspect implementing owners |
| `SURFACE_PATH_CONFLICT` | `packages/cockpit/src/environment/generated-application.ts`, `packages/cockpit/src/surfaces/merge.ts`, `packages/cockpit/src/surfaces/ownership.ts`, `packages/cockpit/src/surfaces/render.ts` | no static remedy captured; inspect implementing owners |
| `SURFACE_SOURCE_UNAVAILABLE` | `packages/cockpit/src/environment/generated-application.ts` | no static remedy captured; inspect implementing owners |
| `SURFACE_STATE_CONFLICT` | `packages/cockpit/src/environment/generated-application.ts`, `packages/cockpit/src/surfaces/ownership.ts`, `packages/cockpit/src/surfaces/sync.ts` | no static remedy captured; inspect implementing owners |
| `TEAM_METADATA_UNAVAILABLE` | `packages/cockpit/src/environment/contract.ts`, `packages/cockpit/src/team-metadata.ts` | no static remedy captured; inspect implementing owners |
| `TEMPLATE_IGNORED` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `TEMPLATE_NOT_FOUND` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `TEMPLATE_NOT_TRACKED` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `TEMPLATE_PATH_OUTSIDE_ROOT` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |

## cockpit check

Check canonical generated environment files for drift.

Configuration: `resolved`. Owners: `packages/cockpit/src/config/load.ts`, `packages/cockpit/src/schema.ts`.

| Flag | Type | Default |
| --- | --- | --- |
| `--config` | string | unset |
| `--json` | boolean | `false` |

| Exit | Meaning |
| --- | --- |
| 0 | success |
| 2 | failure |
| 130 | cancelled |

| Diagnostic | Implementing owners | Source remedy |
| --- | --- | --- |
| `CHECKOUT_ADJACENCY_UNHEALTHY` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `CLAIM_CO_TENANT` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `CLAIM_LIVENESS_UNKNOWN` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `CLAIM_STATE_UNHEALTHY` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `CLI_INTERNAL_ERROR` | `packages/cockpit/src/cli.ts`, `packages/cockpit/src/environment/operator-application.ts` | no static remedy captured; inspect implementing owners |
| `CLI_USAGE_INVALID` | `packages/cockpit/src/cli.ts`, `packages/cockpit/src/environment/runtime-measurement.ts`, `packages/cockpit/src/environment/sibling-registration.ts`, `packages/cockpit/src/generated-environment/adopt.ts` | no static remedy captured; inspect implementing owners |
| `COCKPIT_VERSION_MISMATCH` | `packages/cockpit/src/environment/contract.ts`, `packages/cockpit/src/team-metadata.ts` | no static remedy captured; inspect implementing owners |
| `COMPOSE_TOPOLOGY_UNAVAILABLE` | `packages/cockpit/src/environment/generated-application.ts` | install Docker with the Compose plugin on PATH and make `docker compose config` succeed for environment.compose_files |
| `CONFIG_CHANGED_DURING_EXECUTION` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `CONFIG_ENCODING_INVALID` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `CONFIG_NOT_FOUND` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `CONFIG_PARSE_INVALID` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `CONFIG_SCHEMA_INVALID` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `CONFIG_STALE` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `CONFIG_UNREADABLE` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `DATA_MODE_UNAVAILABLE` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `DIRECTORY_GRANTS_UNAVAILABLE` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `DISK_BUDGET_EXCEEDED` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `DRAIN_ATTEMPT_REPAIR_REQUIRED` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `ENVIRONMENT_FILE_MALFORMED` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `ENVIRONMENT_FILE_NOT_FOUND` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `ENVIRONMENT_FILE_TOO_LARGE` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `ENVIRONMENT_FILE_UNREADABLE` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `ENVIRONMENT_KEYS_STALE` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `ENVIRONMENT_NOT_DECLARED` | `packages/cockpit/src/environment/contract.ts`, `packages/cockpit/src/environment/declaration.ts` | declare environment.compose_files = ["compose.yml"] to run your own Compose file, or [environment.generated] to have cockpit render one, then run cockpit sync |
| `ENVIRONMENT_SEED_FAILED` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `ENVIRONMENT_SEED_PRECONDITION_CHANGED` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `ENV_SCHEMA_TOOL_MISSING` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `ENV_SCHEMA_UNHEALTHY` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
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
| `GENERATED_ARTIFACT_DRIFT` | `packages/cockpit/src/environment/generated-application.ts`, `packages/cockpit/src/environment/generated-stack.ts` | no static remedy captured; inspect implementing owners |
| `GENERATED_ARTIFACT_MISSING` | `packages/cockpit/src/environment/generated-application.ts`, `packages/cockpit/src/environment/generated-stack.ts` | no static remedy captured; inspect implementing owners |
| `GENERATED_DECISIONS_UNDECIDED` | `packages/cockpit/src/environment/generated-application.ts` | no static remedy captured; inspect implementing owners |
| `GENERATED_DECLARATION_INVALID` | `packages/cockpit/src/environment/generated-application.ts`, `packages/cockpit/src/environment/generated-render.ts` | no static remedy captured; inspect implementing owners |
| `GENERATED_DECLARATION_MISSING` | `packages/cockpit/src/environment/generated-application.ts` | no static remedy captured; inspect implementing owners |
| `GENERATED_ENVIRONMENT_UNAVAILABLE` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `GENERATED_EXECUTABLE_UNAVAILABLE` | `packages/cockpit/src/environment/generated-application.ts`, `packages/cockpit/src/generated-environment/uninstall.ts` | no static remedy captured; inspect implementing owners |
| `GENERATED_INPUT_INVALID` | `packages/cockpit/src/environment/generated-application.ts`, `packages/cockpit/src/environment/generated-render.ts`, `packages/cockpit/src/generated-environment/uninstall.ts` | no static remedy captured; inspect implementing owners |
| `GENERATED_OWNERSHIP_DRIFT` | `packages/cockpit/src/environment/generated-application.ts` | no static remedy captured; inspect implementing owners |
| `GENERATED_OWNERSHIP_FORMAT_UNSUPPORTED` | `packages/cockpit/src/environment/generated-application.ts`, `packages/cockpit/src/generated-environment/uninstall.ts` | no static remedy captured; inspect implementing owners |
| `GENERATED_OWNERSHIP_INVALID` | `packages/cockpit/src/environment/generated-application.ts`, `packages/cockpit/src/generated-environment/adopt.ts`, `packages/cockpit/src/generated-environment/transaction.ts`, `packages/cockpit/src/generated-environment/uninstall.ts` | no static remedy captured; inspect implementing owners |
| `GENERATED_OWNERSHIP_MISSING` | `packages/cockpit/src/environment/generated-application.ts`, `packages/cockpit/src/generated-environment/transaction.ts`, `packages/cockpit/src/generated-environment/uninstall.ts` | no static remedy captured; inspect implementing owners |
| `GENERATED_PATH_DUPLICATE` | `packages/cockpit/src/environment/generated-application.ts` | no static remedy captured; inspect implementing owners |
| `GENERATED_PATH_UNSAFE` | `packages/cockpit/src/environment/generated-application.ts`, `packages/cockpit/src/generated-environment/transaction.ts` | no static remedy captured; inspect implementing owners |
| `GENERATED_PERSONA_INVALID` | `packages/cockpit/src/environment/generated-application.ts` | no static remedy captured; inspect implementing owners |
| `GENERATED_PERSONA_SOURCE_UNAVAILABLE` | `packages/cockpit/src/environment/generated-application.ts` | no static remedy captured; inspect implementing owners |
| `GENERATED_PUBLICATION_FAILED` | `packages/cockpit/src/environment/generated-application.ts`, `packages/cockpit/src/generated-environment/transaction.ts` | no static remedy captured; inspect implementing owners |
| `GENERATED_RENDER_UNAUTHENTICATED` | `packages/cockpit/src/environment/generated-application.ts`, `packages/cockpit/src/environment/generated-stack.ts` | no static remedy captured; inspect implementing owners |
| `GENERATED_SIBLING_ROOT_INVALID` | `packages/cockpit/src/environment/generated-application.ts` | no static remedy captured; inspect implementing owners |
| `GENERATED_SOURCE_CHANGED` | `packages/cockpit/src/environment/generated-application.ts`, `packages/cockpit/src/generated-environment/transaction.ts` | no static remedy captured; inspect implementing owners |
| `GENERATED_STALE_APPROVAL_REQUIRED` | `packages/cockpit/src/environment/operator-application.ts`, `packages/cockpit/src/generated-environment/transaction.ts` | no static remedy captured; inspect implementing owners |
| `GENERATED_STALE_ARTIFACT` | `packages/cockpit/src/environment/generated-application.ts` | no static remedy captured; inspect implementing owners |
| `GENERATED_STALE_ARTIFACT_DRIFT` | `packages/cockpit/src/environment/generated-application.ts`, `packages/cockpit/src/generated-environment/transaction.ts`, `packages/cockpit/src/generated-environment/uninstall.ts` | no static remedy captured; inspect implementing owners |
| `GIT_COMPARISON_REMOTE_MISMATCH` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `GIT_STATE_UNHEALTHY` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `GUARD_HOSTS_UNDECLARED` | `packages/cockpit/src/environment/application.ts`, `packages/cockpit/src/environment/contract.ts` | list the database and live vendor API hosts of every non-local environment (production, staging, shared) under [guards] in cockpit.toml, then run cockpit sync; if no such environment exists, record that by writing hosted_db_hosts = [] and vendor_endpoint_hosts = [] under [guards] |
| `GUIDE_CAP_EXCEEDED` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `HARNESS_SURFACE_UNAVAILABLE` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
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
| `MCP_DECLARATION_INVALID` | `packages/cockpit/src/environment/generated-application.ts`, `packages/cockpit/src/surfaces/mcp.ts` | no static remedy captured; inspect implementing owners |
| `MOUNT_MATERIALIZATION_UNAVAILABLE` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `MOUNT_POSTURE_UNAVAILABLE` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `PORT_EXTERNAL_REGISTRATION_GAP` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `PORT_FAMILY_COLLISION` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `PORT_FAMILY_OUT_OF_RANGE` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `PORT_LEASE_EXHAUSTED` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `PORT_LISTENER_EVIDENCE_INVALID` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `PORT_LOCAL_VALUE_CORRECTED` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `RECLAIM_ACCOUNTING_MISMATCH` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `RECLAIM_LABEL_ESCAPE` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `REGISTRY_AUTH_UNAVAILABLE` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `RESET_CONFIRMATION_MISMATCH` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `RESET_CONFIRMATION_REQUIRED` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `RESET_CO_TENANT` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `RUNNING_CHECKOUT_MISMATCH` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `RUNTIME_COMPOSE_REMOTE` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `RUNTIME_LAUNCHER_UNAVAILABLE` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `RUNTIME_PROBE_TIMEOUT` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `RUNTIME_UNAVAILABLE` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `RUNTIME_UNMEASURED` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `SETUP_CONFIG_REQUIRED` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `SETUP_INSTRUCTION_POINTER_INVALID` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `SETUP_INSTRUCTION_POINTER_OFFERED` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
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
| `SKILL_RENDER_INVALID` | `packages/cockpit/src/environment/generated-application.ts`, `packages/cockpit/src/surfaces/skill-contract.ts` | no static remedy captured; inspect implementing owners |
| `STATE_DURABILITY_INDETERMINATE` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `STATE_FORMAT_UNSUPPORTED` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `STATE_LOCKED` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `STATE_RECORD_MALFORMED` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `STATE_ROOT_UNAVAILABLE` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `STATE_UNSEEDED` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `SURFACE_ADOPTION_REFUSED` | `packages/cockpit/src/environment/generated-application.ts`, `packages/cockpit/src/generated-environment/adopt.ts`, `packages/cockpit/src/generated-environment/uninstall.ts`, `packages/cockpit/src/surfaces/adoption.ts` | no static remedy captured; inspect implementing owners |
| `SURFACE_BOUNDS` | `packages/cockpit/src/environment/generated-application.ts`, `packages/cockpit/src/surfaces/check.ts`, `packages/cockpit/src/surfaces/ownership.ts`, `packages/cockpit/src/surfaces/render.ts` | no static remedy captured; inspect implementing owners |
| `SURFACE_CUSTOM_REFUSED` | `packages/cockpit/src/environment/generated-application.ts` | no static remedy captured; inspect implementing owners |
| `SURFACE_GENERATION_FAILED` | `packages/cockpit/src/environment/generated-application.ts` | no static remedy captured; inspect implementing owners |
| `SURFACE_INPUT_INVALID` | `packages/cockpit/src/environment/generated-application.ts`, `packages/cockpit/src/surfaces/check.ts`, `packages/cockpit/src/surfaces/generator-adapter.ts`, `packages/cockpit/src/surfaces/merge.ts`, `packages/cockpit/src/surfaces/ownership.ts`, `packages/cockpit/src/surfaces/render.ts` | no static remedy captured; inspect implementing owners |
| `SURFACE_PATH_CONFLICT` | `packages/cockpit/src/environment/generated-application.ts`, `packages/cockpit/src/surfaces/merge.ts`, `packages/cockpit/src/surfaces/ownership.ts`, `packages/cockpit/src/surfaces/render.ts` | no static remedy captured; inspect implementing owners |
| `SURFACE_SOURCE_UNAVAILABLE` | `packages/cockpit/src/environment/generated-application.ts` | no static remedy captured; inspect implementing owners |
| `SURFACE_STATE_CONFLICT` | `packages/cockpit/src/environment/generated-application.ts`, `packages/cockpit/src/surfaces/ownership.ts`, `packages/cockpit/src/surfaces/sync.ts` | no static remedy captured; inspect implementing owners |
| `TEAM_METADATA_UNAVAILABLE` | `packages/cockpit/src/environment/contract.ts`, `packages/cockpit/src/team-metadata.ts` | no static remedy captured; inspect implementing owners |
| `TEMPLATE_IGNORED` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `TEMPLATE_NOT_FOUND` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `TEMPLATE_NOT_TRACKED` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `TEMPLATE_PATH_OUTSIDE_ROOT` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `WO_ACCEPTANCE_DECLINED` | `packages/cockpit/src/work-orders/intake.ts` | no static remedy captured; inspect implementing owners |
| `WO_ACCEPTANCE_INVALID` | `packages/cockpit/src/work-orders/intake.ts` | no static remedy captured; inspect implementing owners |
| `WO_ACCEPTANCE_REPLAY` | `packages/cockpit/src/work-orders/intake.ts` | no static remedy captured; inspect implementing owners |
| `WO_ACCEPTANCE_STALE` | `packages/cockpit/src/work-orders/intake.ts` | no static remedy captured; inspect implementing owners |
| `WO_AUDIT_INVALID` | `packages/cockpit/src/work-orders/intake.ts` | no static remedy captured; inspect implementing owners |
| `WO_CONTRACT_INVALID` | `packages/cockpit/src/work-orders/intake.ts`, `packages/cockpit/src/work-orders/state.ts`, `packages/cockpit/src/work-orders/status.ts` | no static remedy captured; inspect implementing owners |
| `WO_ID_EXISTS` | `packages/cockpit/src/work-orders/intake.ts` | no static remedy captured; inspect implementing owners |
| `WO_OPERATOR_REQUIRED` | `packages/cockpit/src/work-orders/intake.ts` | no static remedy captured; inspect implementing owners |
| `WO_POLICY_INVALID` | `packages/cockpit/src/work-orders/intake.ts`, `packages/cockpit/src/work-orders/pressure.ts`, `packages/cockpit/src/work-orders/resume.ts`, `packages/cockpit/src/work-orders/state.ts` | no static remedy captured; inspect implementing owners |
| `WO_RENEWAL_DECISION_REQUIRED` | `packages/cockpit/src/work-orders/intake.ts` | no static remedy captured; inspect implementing owners |
| `WO_ROUTE_REQUIRED` | `packages/cockpit/src/work-orders/intake.ts` | no static remedy captured; inspect implementing owners |
| `WO_SKILLS_INVALID` | `packages/cockpit/src/work-orders/intake.ts` | no static remedy captured; inspect implementing owners |
| `WO_SOURCE_GAPS` | `packages/cockpit/src/work-orders/intake.ts` | no static remedy captured; inspect implementing owners |
| `WO_WIP_CAP` | `packages/cockpit/src/work-orders/intake.ts` | no static remedy captured; inspect implementing owners |
| `WO_WIP_INVALID` | `packages/cockpit/src/work-orders/intake.ts` | no static remedy captured; inspect implementing owners |

## cockpit selftest

Probe generated harness controls with explicit measured specifications.

Configuration: `resolved`. Owners: `packages/cockpit/src/config/load.ts`, `packages/cockpit/src/schema.ts`.

| Flag | Type | Default |
| --- | --- | --- |
| `--config` | string | unset |
| `--probe-specifications` | string | unset |
| `--interactive` | boolean | `false` |
| `--json` | boolean | `false` |

| Exit | Meaning |
| --- | --- |
| 0 | success |
| 2 | failure |
| 130 | cancelled |

| Diagnostic | Implementing owners | Source remedy |
| --- | --- | --- |
| `SELFTEST_EXECUTION_INVALID` | `packages/cockpit/src/environment/selftest-application.ts` | no static remedy captured; inspect implementing owners |
| `SELFTEST_SOURCE_INVALID` | `packages/cockpit/src/environment/selftest-application.ts`, `packages/cockpit/src/surfaces/selftest.ts` | no static remedy captured; inspect implementing owners |

## cockpit upgrade

Inspect a reviewable upgrade sequence without applying changes.

Status: experimental. This interface may change before a stable release.

Configuration: `resolved`. Owners: `packages/cockpit/src/config/load.ts`, `packages/cockpit/src/schema.ts`.

| Flag | Type | Default |
| --- | --- | --- |
| `--config` | string | unset |
| `--release-evidence` | string | unset |
| `--release-evidence-sha256` | string | unset |
| `--json` | boolean | `false` |

| Exit | Meaning |
| --- | --- |
| 0 | success |
| 2 | failure |
| 130 | cancelled |

| Diagnostic | Implementing owners | Source remedy |
| --- | --- | --- |
| `UPGRADE_AUTH_FAILED` | `packages/cockpit/src/environment/upgrade-application.ts`, `packages/cockpit/src/upgrade/release-evidence.ts` | no static remedy captured; inspect implementing owners |
| `UPGRADE_DISCOVERY_INVALID` | `packages/cockpit/src/upgrade/command.ts` | no static remedy captured; inspect implementing owners |
| `UPGRADE_NETWORK_FAILED` | `packages/cockpit/src/upgrade/command.ts` | no static remedy captured; inspect implementing owners |
| `UPGRADE_REPAIR_UNVERIFIED` | `packages/cockpit/src/upgrade/release-evidence.ts` | no static remedy captured; inspect implementing owners |
| `UPGRADE_SOURCE_INVALID` | `packages/cockpit/src/upgrade/command.ts` | no static remedy captured; inspect implementing owners |
| `UPGRADE_VERSION_AMBIGUOUS` | `packages/cockpit/src/upgrade/command.ts` | no static remedy captured; inspect implementing owners |

## cockpit up

Start or resume the declared environment.

Configuration: `resolved`. Owners: `packages/cockpit/src/config/load.ts`, `packages/cockpit/src/schema.ts`.

| Flag | Type | Default |
| --- | --- | --- |
| `--config` | string | unset |
| `--json` | boolean | `false` |

| Exit | Meaning |
| --- | --- |
| 0 | success |
| 2 | failure |
| 130 | cancelled |

| Diagnostic | Implementing owners | Source remedy |
| --- | --- | --- |
| `GUARD_AUTHORITY_UNAVAILABLE` | `packages/cockpit/src/environment/application.ts` | no static remedy captured; inspect implementing owners |
| `GUARD_HOSTS_UNDECLARED` | `packages/cockpit/src/environment/application.ts`, `packages/cockpit/src/environment/contract.ts` | list the database and live vendor API hosts of every non-local environment (production, staging, shared) under [guards] in cockpit.toml, then run cockpit sync; if no such environment exists, record that by writing hosted_db_hosts = [] and vendor_endpoint_hosts = [] under [guards] |
| `GUARD_REFUSED` | `packages/cockpit/src/environment/application.ts` | no static remedy captured; inspect implementing owners |
| `SURFACE_OVERRIDE_INSPECTION_INVALID` | `packages/cockpit/src/environment/application.ts`, `packages/cockpit/src/environment/health-composition.ts` | no static remedy captured; inspect implementing owners |
| `SURFACE_OVERRIDE_INSPECTION_UNAVAILABLE` | `packages/cockpit/src/environment/application.ts`, `packages/cockpit/src/environment/health-composition.ts` | no static remedy captured; inspect implementing owners |

## cockpit sleep

Release this holder and stop an unshared environment.

Configuration: `resolved`. Owners: `packages/cockpit/src/config/load.ts`, `packages/cockpit/src/schema.ts`.

| Flag | Type | Default |
| --- | --- | --- |
| `--config` | string | unset |
| `--json` | boolean | `false` |

| Exit | Meaning |
| --- | --- |
| 0 | success |
| 2 | failure |
| 130 | cancelled |

| Diagnostic | Implementing owners | Source remedy |
| --- | --- | --- |
| `GUARD_AUTHORITY_UNAVAILABLE` | `packages/cockpit/src/environment/application.ts` | no static remedy captured; inspect implementing owners |
| `GUARD_HOSTS_UNDECLARED` | `packages/cockpit/src/environment/application.ts`, `packages/cockpit/src/environment/contract.ts` | list the database and live vendor API hosts of every non-local environment (production, staging, shared) under [guards] in cockpit.toml, then run cockpit sync; if no such environment exists, record that by writing hosted_db_hosts = [] and vendor_endpoint_hosts = [] under [guards] |
| `GUARD_REFUSED` | `packages/cockpit/src/environment/application.ts` | no static remedy captured; inspect implementing owners |
| `SURFACE_OVERRIDE_INSPECTION_INVALID` | `packages/cockpit/src/environment/application.ts`, `packages/cockpit/src/environment/health-composition.ts` | no static remedy captured; inspect implementing owners |
| `SURFACE_OVERRIDE_INSPECTION_UNAVAILABLE` | `packages/cockpit/src/environment/application.ts`, `packages/cockpit/src/environment/health-composition.ts` | no static remedy captured; inspect implementing owners |

## cockpit session

Keep the environment available for one command, then release it.

Configuration: `unavailable`. Owners: none.

| Flag | Type | Default |
| --- | --- | --- |
| `--config` | string | unset |

| Exit | Meaning |
| --- | --- |
| 0 | success |
| 2 | failure |
| 130 | cancelled |

| Diagnostic | Implementing owners | Source remedy |
| --- | --- | --- |
| `CHECKOUT_ADJACENCY_UNHEALTHY` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `CLAIM_CO_TENANT` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `CLAIM_LIVENESS_UNKNOWN` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `CLAIM_STATE_UNHEALTHY` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `COCKPIT_VERSION_MISMATCH` | `packages/cockpit/src/environment/contract.ts`, `packages/cockpit/src/team-metadata.ts` | no static remedy captured; inspect implementing owners |
| `COMPOSE_TOPOLOGY_UNAVAILABLE` | `packages/cockpit/src/environment/generated-application.ts` | install Docker with the Compose plugin on PATH and make `docker compose config` succeed for environment.compose_files |
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
| `DRAIN_ATTEMPT_REPAIR_REQUIRED` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `ENVIRONMENT_FILE_MALFORMED` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `ENVIRONMENT_FILE_NOT_FOUND` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `ENVIRONMENT_FILE_TOO_LARGE` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `ENVIRONMENT_FILE_UNREADABLE` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `ENVIRONMENT_KEYS_STALE` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `ENVIRONMENT_NOT_DECLARED` | `packages/cockpit/src/environment/contract.ts`, `packages/cockpit/src/environment/declaration.ts` | declare environment.compose_files = ["compose.yml"] to run your own Compose file, or [environment.generated] to have cockpit render one, then run cockpit sync |
| `ENVIRONMENT_SEED_FAILED` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `ENVIRONMENT_SEED_PRECONDITION_CHANGED` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `ENV_SCHEMA_TOOL_MISSING` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `ENV_SCHEMA_UNHEALTHY` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
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
| `GENERATED_DECISIONS_UNDECIDED` | `packages/cockpit/src/environment/generated-application.ts` | no static remedy captured; inspect implementing owners |
| `GENERATED_DECLARATION_INVALID` | `packages/cockpit/src/environment/generated-application.ts`, `packages/cockpit/src/environment/generated-render.ts` | no static remedy captured; inspect implementing owners |
| `GENERATED_DECLARATION_MISSING` | `packages/cockpit/src/environment/generated-application.ts` | no static remedy captured; inspect implementing owners |
| `GENERATED_ENVIRONMENT_UNAVAILABLE` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `GENERATED_EXECUTABLE_UNAVAILABLE` | `packages/cockpit/src/environment/generated-application.ts`, `packages/cockpit/src/generated-environment/uninstall.ts` | no static remedy captured; inspect implementing owners |
| `GENERATED_INPUT_INVALID` | `packages/cockpit/src/environment/generated-application.ts`, `packages/cockpit/src/environment/generated-render.ts`, `packages/cockpit/src/generated-environment/uninstall.ts` | no static remedy captured; inspect implementing owners |
| `GENERATED_OWNERSHIP_DRIFT` | `packages/cockpit/src/environment/generated-application.ts` | no static remedy captured; inspect implementing owners |
| `GENERATED_OWNERSHIP_FORMAT_UNSUPPORTED` | `packages/cockpit/src/environment/generated-application.ts`, `packages/cockpit/src/generated-environment/uninstall.ts` | no static remedy captured; inspect implementing owners |
| `GENERATED_OWNERSHIP_INVALID` | `packages/cockpit/src/environment/generated-application.ts`, `packages/cockpit/src/generated-environment/adopt.ts`, `packages/cockpit/src/generated-environment/transaction.ts`, `packages/cockpit/src/generated-environment/uninstall.ts` | no static remedy captured; inspect implementing owners |
| `GENERATED_OWNERSHIP_MISSING` | `packages/cockpit/src/environment/generated-application.ts`, `packages/cockpit/src/generated-environment/transaction.ts`, `packages/cockpit/src/generated-environment/uninstall.ts` | no static remedy captured; inspect implementing owners |
| `GENERATED_PATH_DUPLICATE` | `packages/cockpit/src/environment/generated-application.ts` | no static remedy captured; inspect implementing owners |
| `GENERATED_PATH_UNSAFE` | `packages/cockpit/src/environment/generated-application.ts`, `packages/cockpit/src/generated-environment/transaction.ts` | no static remedy captured; inspect implementing owners |
| `GENERATED_PERSONA_INVALID` | `packages/cockpit/src/environment/generated-application.ts` | no static remedy captured; inspect implementing owners |
| `GENERATED_PERSONA_SOURCE_UNAVAILABLE` | `packages/cockpit/src/environment/generated-application.ts` | no static remedy captured; inspect implementing owners |
| `GENERATED_PUBLICATION_FAILED` | `packages/cockpit/src/environment/generated-application.ts`, `packages/cockpit/src/generated-environment/transaction.ts` | no static remedy captured; inspect implementing owners |
| `GENERATED_RENDER_UNAUTHENTICATED` | `packages/cockpit/src/environment/generated-application.ts`, `packages/cockpit/src/environment/generated-stack.ts` | no static remedy captured; inspect implementing owners |
| `GENERATED_SIBLING_ROOT_INVALID` | `packages/cockpit/src/environment/generated-application.ts` | no static remedy captured; inspect implementing owners |
| `GENERATED_SOURCE_CHANGED` | `packages/cockpit/src/environment/generated-application.ts`, `packages/cockpit/src/generated-environment/transaction.ts` | no static remedy captured; inspect implementing owners |
| `GENERATED_STALE_ARTIFACT` | `packages/cockpit/src/environment/generated-application.ts` | no static remedy captured; inspect implementing owners |
| `GENERATED_STALE_ARTIFACT_DRIFT` | `packages/cockpit/src/environment/generated-application.ts`, `packages/cockpit/src/generated-environment/transaction.ts`, `packages/cockpit/src/generated-environment/uninstall.ts` | no static remedy captured; inspect implementing owners |
| `GENERATED_TEMPLATE_INVALID` | `packages/cockpit/src/environment/generated-render.ts` | no static remedy captured; inspect implementing owners |
| `GIT_COMPARISON_REMOTE_MISMATCH` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `GIT_STATE_UNHEALTHY` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `GUARD_AUTHORITY_UNAVAILABLE` | `packages/cockpit/src/environment/application.ts` | no static remedy captured; inspect implementing owners |
| `GUARD_HOSTS_UNDECLARED` | `packages/cockpit/src/environment/application.ts`, `packages/cockpit/src/environment/contract.ts` | list the database and live vendor API hosts of every non-local environment (production, staging, shared) under [guards] in cockpit.toml, then run cockpit sync; if no such environment exists, record that by writing hosted_db_hosts = [] and vendor_endpoint_hosts = [] under [guards] |
| `GUARD_REFUSED` | `packages/cockpit/src/environment/application.ts` | no static remedy captured; inspect implementing owners |
| `GUIDE_CAP_EXCEEDED` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `HARNESS_SURFACE_UNAVAILABLE` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
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
| `MCP_DECLARATION_INVALID` | `packages/cockpit/src/environment/generated-application.ts`, `packages/cockpit/src/surfaces/mcp.ts` | no static remedy captured; inspect implementing owners |
| `MOUNT_MATERIALIZATION_UNAVAILABLE` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `MOUNT_POSTURE_UNAVAILABLE` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `PORT_EXTERNAL_REGISTRATION_GAP` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `PORT_FAMILY_COLLISION` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `PORT_FAMILY_OUT_OF_RANGE` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `PORT_LEASE_EXHAUSTED` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `PORT_LISTENER_EVIDENCE_INVALID` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `PORT_LOCAL_VALUE_CORRECTED` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `RECLAIM_ACCOUNTING_MISMATCH` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `RECLAIM_LABEL_ESCAPE` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `REGISTRY_AUTH_UNAVAILABLE` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `RESET_CONFIRMATION_MISMATCH` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `RESET_CONFIRMATION_REQUIRED` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `RESET_CO_TENANT` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `RUNNING_CHECKOUT_MISMATCH` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `RUNTIME_COMPOSE_REMOTE` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `RUNTIME_LAUNCHER_UNAVAILABLE` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `RUNTIME_PROBE_TIMEOUT` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `RUNTIME_UNAVAILABLE` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `RUNTIME_UNMEASURED` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `SETUP_CONFIG_REQUIRED` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `SETUP_INSTRUCTION_POINTER_INVALID` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `SETUP_INSTRUCTION_POINTER_OFFERED` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
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
| `SKILL_RENDER_INVALID` | `packages/cockpit/src/environment/generated-application.ts`, `packages/cockpit/src/surfaces/skill-contract.ts` | no static remedy captured; inspect implementing owners |
| `STATE_DURABILITY_INDETERMINATE` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `STATE_FORMAT_UNSUPPORTED` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `STATE_LOCKED` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `STATE_RECORD_MALFORMED` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `STATE_ROOT_UNAVAILABLE` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `STATE_UNSEEDED` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `SURFACE_ADOPTION_REFUSED` | `packages/cockpit/src/environment/generated-application.ts`, `packages/cockpit/src/generated-environment/adopt.ts`, `packages/cockpit/src/generated-environment/uninstall.ts`, `packages/cockpit/src/surfaces/adoption.ts` | no static remedy captured; inspect implementing owners |
| `SURFACE_BOUNDS` | `packages/cockpit/src/environment/generated-application.ts`, `packages/cockpit/src/surfaces/check.ts`, `packages/cockpit/src/surfaces/ownership.ts`, `packages/cockpit/src/surfaces/render.ts` | no static remedy captured; inspect implementing owners |
| `SURFACE_CUSTOM_REFUSED` | `packages/cockpit/src/environment/generated-application.ts` | no static remedy captured; inspect implementing owners |
| `SURFACE_GENERATION_FAILED` | `packages/cockpit/src/environment/generated-application.ts` | no static remedy captured; inspect implementing owners |
| `SURFACE_INPUT_INVALID` | `packages/cockpit/src/environment/generated-application.ts`, `packages/cockpit/src/surfaces/check.ts`, `packages/cockpit/src/surfaces/generator-adapter.ts`, `packages/cockpit/src/surfaces/merge.ts`, `packages/cockpit/src/surfaces/ownership.ts`, `packages/cockpit/src/surfaces/render.ts` | no static remedy captured; inspect implementing owners |
| `SURFACE_OVERRIDE_INSPECTION_INVALID` | `packages/cockpit/src/environment/application.ts`, `packages/cockpit/src/environment/health-composition.ts` | no static remedy captured; inspect implementing owners |
| `SURFACE_OVERRIDE_INSPECTION_UNAVAILABLE` | `packages/cockpit/src/environment/application.ts`, `packages/cockpit/src/environment/health-composition.ts` | no static remedy captured; inspect implementing owners |
| `SURFACE_PATH_CONFLICT` | `packages/cockpit/src/environment/generated-application.ts`, `packages/cockpit/src/surfaces/merge.ts`, `packages/cockpit/src/surfaces/ownership.ts`, `packages/cockpit/src/surfaces/render.ts` | no static remedy captured; inspect implementing owners |
| `SURFACE_SOURCE_UNAVAILABLE` | `packages/cockpit/src/environment/generated-application.ts` | no static remedy captured; inspect implementing owners |
| `SURFACE_STATE_CONFLICT` | `packages/cockpit/src/environment/generated-application.ts`, `packages/cockpit/src/surfaces/ownership.ts`, `packages/cockpit/src/surfaces/sync.ts` | no static remedy captured; inspect implementing owners |
| `TEAM_METADATA_UNAVAILABLE` | `packages/cockpit/src/environment/contract.ts`, `packages/cockpit/src/team-metadata.ts` | no static remedy captured; inspect implementing owners |
| `TEMPLATE_IGNORED` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `TEMPLATE_NOT_FOUND` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `TEMPLATE_NOT_TRACKED` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `TEMPLATE_PATH_OUTSIDE_ROOT` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `WO_ACCEPTANCE_DECLINED` | `packages/cockpit/src/work-orders/intake.ts` | no static remedy captured; inspect implementing owners |
| `WO_ACCEPTANCE_INVALID` | `packages/cockpit/src/work-orders/intake.ts` | no static remedy captured; inspect implementing owners |
| `WO_ACCEPTANCE_REPLAY` | `packages/cockpit/src/work-orders/intake.ts` | no static remedy captured; inspect implementing owners |
| `WO_ACCEPTANCE_STALE` | `packages/cockpit/src/work-orders/intake.ts` | no static remedy captured; inspect implementing owners |
| `WO_AUDIT_INVALID` | `packages/cockpit/src/work-orders/intake.ts` | no static remedy captured; inspect implementing owners |
| `WO_CONTRACT_INVALID` | `packages/cockpit/src/work-orders/intake.ts`, `packages/cockpit/src/work-orders/state.ts`, `packages/cockpit/src/work-orders/status.ts` | no static remedy captured; inspect implementing owners |
| `WO_ID_EXISTS` | `packages/cockpit/src/work-orders/intake.ts` | no static remedy captured; inspect implementing owners |
| `WO_OPERATOR_REQUIRED` | `packages/cockpit/src/work-orders/intake.ts` | no static remedy captured; inspect implementing owners |
| `WO_POLICY_INVALID` | `packages/cockpit/src/work-orders/intake.ts`, `packages/cockpit/src/work-orders/pressure.ts`, `packages/cockpit/src/work-orders/resume.ts`, `packages/cockpit/src/work-orders/state.ts` | no static remedy captured; inspect implementing owners |
| `WO_RENEWAL_DECISION_REQUIRED` | `packages/cockpit/src/work-orders/intake.ts` | no static remedy captured; inspect implementing owners |
| `WO_ROUTE_REQUIRED` | `packages/cockpit/src/work-orders/intake.ts` | no static remedy captured; inspect implementing owners |
| `WO_SKILLS_INVALID` | `packages/cockpit/src/work-orders/intake.ts` | no static remedy captured; inspect implementing owners |
| `WO_SOURCE_GAPS` | `packages/cockpit/src/work-orders/intake.ts` | no static remedy captured; inspect implementing owners |
| `WO_WIP_CAP` | `packages/cockpit/src/work-orders/intake.ts` | no static remedy captured; inspect implementing owners |
| `WO_WIP_INVALID` | `packages/cockpit/src/work-orders/intake.ts` | no static remedy captured; inspect implementing owners |

## cockpit down

Remove the selected generated runtime.

Configuration: `unavailable`. Owners: none.

| Flag | Type | Default |
| --- | --- | --- |
| `--config` | string | unset |
| `--json` | boolean | `false` |

| Exit | Meaning |
| --- | --- |
| 0 | success |
| 2 | failure |
| 130 | cancelled |

| Diagnostic | Implementing owners | Source remedy |
| --- | --- | --- |
| `GUARD_AUTHORITY_UNAVAILABLE` | `packages/cockpit/src/environment/application.ts` | no static remedy captured; inspect implementing owners |
| `GUARD_HOSTS_UNDECLARED` | `packages/cockpit/src/environment/application.ts`, `packages/cockpit/src/environment/contract.ts` | list the database and live vendor API hosts of every non-local environment (production, staging, shared) under [guards] in cockpit.toml, then run cockpit sync; if no such environment exists, record that by writing hosted_db_hosts = [] and vendor_endpoint_hosts = [] under [guards] |
| `GUARD_REFUSED` | `packages/cockpit/src/environment/application.ts` | no static remedy captured; inspect implementing owners |
| `SURFACE_OVERRIDE_INSPECTION_INVALID` | `packages/cockpit/src/environment/application.ts`, `packages/cockpit/src/environment/health-composition.ts` | no static remedy captured; inspect implementing owners |
| `SURFACE_OVERRIDE_INSPECTION_UNAVAILABLE` | `packages/cockpit/src/environment/application.ts`, `packages/cockpit/src/environment/health-composition.ts` | no static remedy captured; inspect implementing owners |

## cockpit reset

Preview or interactively approve an exact reset.

Configuration: `unavailable`. Owners: none.

| Flag | Type | Default |
| --- | --- | --- |
| `--config` | string | unset |
| `--interactive` | boolean | `false` |
| `--json` | boolean | `false` |

| Exit | Meaning |
| --- | --- |
| 0 | success |
| 2 | failure |
| 130 | cancelled |

| Diagnostic | Implementing owners | Source remedy |
| --- | --- | --- |
| `GUARD_AUTHORITY_UNAVAILABLE` | `packages/cockpit/src/environment/application.ts` | no static remedy captured; inspect implementing owners |
| `GUARD_HOSTS_UNDECLARED` | `packages/cockpit/src/environment/application.ts`, `packages/cockpit/src/environment/contract.ts` | list the database and live vendor API hosts of every non-local environment (production, staging, shared) under [guards] in cockpit.toml, then run cockpit sync; if no such environment exists, record that by writing hosted_db_hosts = [] and vendor_endpoint_hosts = [] under [guards] |
| `GUARD_REFUSED` | `packages/cockpit/src/environment/application.ts` | no static remedy captured; inspect implementing owners |
| `SURFACE_OVERRIDE_INSPECTION_INVALID` | `packages/cockpit/src/environment/application.ts`, `packages/cockpit/src/environment/health-composition.ts` | no static remedy captured; inspect implementing owners |
| `SURFACE_OVERRIDE_INSPECTION_UNAVAILABLE` | `packages/cockpit/src/environment/application.ts`, `packages/cockpit/src/environment/health-composition.ts` | no static remedy captured; inspect implementing owners |

## cockpit runtime

Measure the local container runtime (runtime measure) and record its support row.

Configuration: `unavailable`. Owners: none.

| Flag | Type | Default |
| --- | --- | --- |
| `--config` | string | unset |
| `--image` | string | unset |
| `--write` | boolean | `false` |
| `--json` | boolean | `false` |

| Exit | Meaning |
| --- | --- |
| 0 | success |
| 2 | failure |
| 130 | cancelled |

| Diagnostic | Implementing owners | Source remedy |
| --- | --- | --- |
| `CHECKOUT_ADJACENCY_UNHEALTHY` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `CLAIM_CO_TENANT` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `CLAIM_LIVENESS_UNKNOWN` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `CLAIM_STATE_UNHEALTHY` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `CLI_USAGE_INVALID` | `packages/cockpit/src/cli.ts`, `packages/cockpit/src/environment/runtime-measurement.ts`, `packages/cockpit/src/environment/sibling-registration.ts`, `packages/cockpit/src/generated-environment/adopt.ts` | no static remedy captured; inspect implementing owners |
| `COCKPIT_VERSION_MISMATCH` | `packages/cockpit/src/environment/contract.ts`, `packages/cockpit/src/team-metadata.ts` | no static remedy captured; inspect implementing owners |
| `CONFIG_CHANGED_DURING_EXECUTION` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `CONFIG_ENCODING_INVALID` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `CONFIG_NOT_FOUND` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `CONFIG_PARSE_INVALID` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `CONFIG_SCHEMA_INVALID` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `CONFIG_STALE` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `CONFIG_UNREADABLE` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `DATA_MODE_UNAVAILABLE` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `DIRECTORY_GRANTS_UNAVAILABLE` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `DISK_BUDGET_EXCEEDED` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `DRAIN_ATTEMPT_REPAIR_REQUIRED` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `ENVIRONMENT_FILE_MALFORMED` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `ENVIRONMENT_FILE_NOT_FOUND` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `ENVIRONMENT_FILE_TOO_LARGE` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `ENVIRONMENT_FILE_UNREADABLE` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `ENVIRONMENT_KEYS_STALE` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `ENVIRONMENT_NOT_DECLARED` | `packages/cockpit/src/environment/contract.ts`, `packages/cockpit/src/environment/declaration.ts` | declare environment.compose_files = ["compose.yml"] to run your own Compose file, or [environment.generated] to have cockpit render one, then run cockpit sync |
| `ENVIRONMENT_SEED_FAILED` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `ENVIRONMENT_SEED_PRECONDITION_CHANGED` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `ENV_SCHEMA_TOOL_MISSING` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `ENV_SCHEMA_UNHEALTHY` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
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
| `GENERATED_ENVIRONMENT_UNAVAILABLE` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `GIT_COMPARISON_REMOTE_MISMATCH` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `GIT_STATE_UNHEALTHY` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `GUARD_HOSTS_UNDECLARED` | `packages/cockpit/src/environment/application.ts`, `packages/cockpit/src/environment/contract.ts` | list the database and live vendor API hosts of every non-local environment (production, staging, shared) under [guards] in cockpit.toml, then run cockpit sync; if no such environment exists, record that by writing hosted_db_hosts = [] and vendor_endpoint_hosts = [] under [guards] |
| `GUIDE_CAP_EXCEEDED` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `HARNESS_SURFACE_UNAVAILABLE` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
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
| `MOUNT_MATERIALIZATION_UNAVAILABLE` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `MOUNT_POSTURE_UNAVAILABLE` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `PORT_EXTERNAL_REGISTRATION_GAP` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `PORT_FAMILY_COLLISION` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `PORT_FAMILY_OUT_OF_RANGE` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `PORT_LEASE_EXHAUSTED` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `PORT_LISTENER_EVIDENCE_INVALID` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `PORT_LOCAL_VALUE_CORRECTED` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `RECLAIM_ACCOUNTING_MISMATCH` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `RECLAIM_LABEL_ESCAPE` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `REGISTRY_AUTH_UNAVAILABLE` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `RESET_CONFIRMATION_MISMATCH` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `RESET_CONFIRMATION_REQUIRED` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `RESET_CO_TENANT` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `RUNNING_CHECKOUT_MISMATCH` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `RUNTIME_COMPOSE_REMOTE` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `RUNTIME_LAUNCHER_UNAVAILABLE` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `RUNTIME_PROBE_TIMEOUT` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `RUNTIME_UNAVAILABLE` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `RUNTIME_UNMEASURED` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `SETUP_CONFIG_REQUIRED` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `SETUP_INSTRUCTION_POINTER_INVALID` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `SETUP_INSTRUCTION_POINTER_OFFERED` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
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
| `STATE_DURABILITY_INDETERMINATE` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `STATE_FORMAT_UNSUPPORTED` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `STATE_LOCKED` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `STATE_RECORD_MALFORMED` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `STATE_ROOT_UNAVAILABLE` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `STATE_UNSEEDED` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `TEAM_METADATA_UNAVAILABLE` | `packages/cockpit/src/environment/contract.ts`, `packages/cockpit/src/team-metadata.ts` | no static remedy captured; inspect implementing owners |
| `TEMPLATE_IGNORED` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `TEMPLATE_NOT_FOUND` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `TEMPLATE_NOT_TRACKED` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `TEMPLATE_PATH_OUTSIDE_ROOT` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |

## cockpit sibling

Add or remove a repository in cockpit.toml (sibling add, sibling remove).

Configuration: `unavailable`. Owners: none.

| Flag | Type | Default |
| --- | --- | --- |
| `--config` | string | unset |
| `--create` | boolean | `false` |
| `--from` | string | unset |
| `--remote` | string | unset |
| `--dir` | string | unset |
| `--var` | string | unset |
| `--purpose` | string | unset |
| `--instruction-pointer` | boolean | `false` |
| `--json` | boolean | `false` |

| Exit | Meaning |
| --- | --- |
| 0 | success |
| 2 | failure |
| 130 | cancelled |

| Diagnostic | Implementing owners | Source remedy |
| --- | --- | --- |
| `CHECKOUT_ADJACENCY_UNHEALTHY` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `CLAIM_CO_TENANT` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `CLAIM_LIVENESS_UNKNOWN` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `CLAIM_STATE_UNHEALTHY` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `CLI_USAGE_INVALID` | `packages/cockpit/src/cli.ts`, `packages/cockpit/src/environment/runtime-measurement.ts`, `packages/cockpit/src/environment/sibling-registration.ts`, `packages/cockpit/src/generated-environment/adopt.ts` | no static remedy captured; inspect implementing owners |
| `COCKPIT_VERSION_MISMATCH` | `packages/cockpit/src/environment/contract.ts`, `packages/cockpit/src/team-metadata.ts` | no static remedy captured; inspect implementing owners |
| `CONFIG_CHANGED_DURING_EXECUTION` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `CONFIG_ENCODING_INVALID` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `CONFIG_NOT_FOUND` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `CONFIG_PARSE_INVALID` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `CONFIG_SCHEMA_INVALID` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `CONFIG_STALE` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `CONFIG_UNREADABLE` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `DATA_MODE_UNAVAILABLE` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `DIRECTORY_GRANTS_UNAVAILABLE` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `DISK_BUDGET_EXCEEDED` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `DRAIN_ATTEMPT_REPAIR_REQUIRED` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `ENVIRONMENT_FILE_MALFORMED` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `ENVIRONMENT_FILE_NOT_FOUND` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `ENVIRONMENT_FILE_TOO_LARGE` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `ENVIRONMENT_FILE_UNREADABLE` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `ENVIRONMENT_KEYS_STALE` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `ENVIRONMENT_NOT_DECLARED` | `packages/cockpit/src/environment/contract.ts`, `packages/cockpit/src/environment/declaration.ts` | declare environment.compose_files = ["compose.yml"] to run your own Compose file, or [environment.generated] to have cockpit render one, then run cockpit sync |
| `ENVIRONMENT_SEED_FAILED` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `ENVIRONMENT_SEED_PRECONDITION_CHANGED` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `ENV_SCHEMA_TOOL_MISSING` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `ENV_SCHEMA_UNHEALTHY` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
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
| `GENERATED_ENVIRONMENT_UNAVAILABLE` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `GIT_COMPARISON_REMOTE_MISMATCH` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `GIT_STATE_UNHEALTHY` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `GUARD_HOSTS_UNDECLARED` | `packages/cockpit/src/environment/application.ts`, `packages/cockpit/src/environment/contract.ts` | list the database and live vendor API hosts of every non-local environment (production, staging, shared) under [guards] in cockpit.toml, then run cockpit sync; if no such environment exists, record that by writing hosted_db_hosts = [] and vendor_endpoint_hosts = [] under [guards] |
| `GUIDE_CAP_EXCEEDED` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `HARNESS_SURFACE_UNAVAILABLE` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
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
| `MOUNT_MATERIALIZATION_UNAVAILABLE` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `MOUNT_POSTURE_UNAVAILABLE` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `PORT_EXTERNAL_REGISTRATION_GAP` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `PORT_FAMILY_COLLISION` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `PORT_FAMILY_OUT_OF_RANGE` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `PORT_LEASE_EXHAUSTED` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `PORT_LISTENER_EVIDENCE_INVALID` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `PORT_LOCAL_VALUE_CORRECTED` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `RECLAIM_ACCOUNTING_MISMATCH` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `RECLAIM_LABEL_ESCAPE` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `REGISTRY_AUTH_UNAVAILABLE` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `RESET_CONFIRMATION_MISMATCH` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `RESET_CONFIRMATION_REQUIRED` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `RESET_CO_TENANT` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `RUNNING_CHECKOUT_MISMATCH` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `RUNTIME_COMPOSE_REMOTE` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `RUNTIME_LAUNCHER_UNAVAILABLE` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `RUNTIME_PROBE_TIMEOUT` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `RUNTIME_UNAVAILABLE` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `RUNTIME_UNMEASURED` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `SETUP_CONFIG_REQUIRED` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `SETUP_INSTRUCTION_POINTER_INVALID` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `SETUP_INSTRUCTION_POINTER_OFFERED` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
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
| `SIBLING_DIRECTORY_MISSING` | `packages/cockpit/src/environment/sibling-registration.ts` | no static remedy captured; inspect implementing owners |
| `SIBLING_DIR_DUPLICATE` | `packages/cockpit/src/environment/sibling-registration.ts` | no static remedy captured; inspect implementing owners |
| `SIBLING_GIT_FAILED` | `packages/cockpit/src/environment/sibling-registration.ts` | no static remedy captured; inspect implementing owners |
| `SIBLING_MISSING` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `SIBLING_NOT_FOUND` | `packages/cockpit/src/environment/sibling-registration.ts` | no static remedy captured; inspect implementing owners |
| `SIBLING_PATH_NOT_EMPTY` | `packages/cockpit/src/environment/sibling-registration.ts` | no static remedy captured; inspect implementing owners |
| `SIBLING_REFERENCED` | `packages/cockpit/src/environment/sibling-registration.ts` | no static remedy captured; inspect implementing owners |
| `SIBLING_REMOTE_MISSING` | `packages/cockpit/src/environment/sibling-registration.ts` | no static remedy captured; inspect implementing owners |
| `SIBLING_SLUG_DUPLICATE` | `packages/cockpit/src/environment/sibling-registration.ts` | no static remedy captured; inspect implementing owners |
| `SIBLING_VAR_DUPLICATE` | `packages/cockpit/src/environment/sibling-registration.ts` | no static remedy captured; inspect implementing owners |
| `SKILL_BUDGET_UNAVAILABLE` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `STATE_DURABILITY_INDETERMINATE` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `STATE_FORMAT_UNSUPPORTED` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `STATE_LOCKED` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `STATE_RECORD_MALFORMED` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `STATE_ROOT_UNAVAILABLE` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `STATE_UNSEEDED` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `TEAM_METADATA_UNAVAILABLE` | `packages/cockpit/src/environment/contract.ts`, `packages/cockpit/src/team-metadata.ts` | no static remedy captured; inspect implementing owners |
| `TEMPLATE_IGNORED` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `TEMPLATE_NOT_FOUND` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `TEMPLATE_NOT_TRACKED` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |
| `TEMPLATE_PATH_OUTSIDE_ROOT` | `packages/cockpit/src/environment/contract.ts` | no static remedy captured; inspect implementing owners |

## cockpit preflight

Evaluate the authenticated environment gate.

Configuration: `resolved`. Owners: `packages/cockpit/src/config/load.ts`, `packages/cockpit/src/schema.ts`.

| Flag | Type | Default |
| --- | --- | --- |
| `--config` | string | unset |
| `--json` | boolean | `false` |

| Exit | Meaning |
| --- | --- |
| 0 | success |
| 2 | failure |
| 130 | cancelled |

| Diagnostic | Implementing owners | Source remedy |
| --- | --- | --- |
| `GUARD_AUTHORITY_UNAVAILABLE` | `packages/cockpit/src/environment/application.ts` | no static remedy captured; inspect implementing owners |
| `GUARD_HOSTS_UNDECLARED` | `packages/cockpit/src/environment/application.ts`, `packages/cockpit/src/environment/contract.ts` | list the database and live vendor API hosts of every non-local environment (production, staging, shared) under [guards] in cockpit.toml, then run cockpit sync; if no such environment exists, record that by writing hosted_db_hosts = [] and vendor_endpoint_hosts = [] under [guards] |
| `GUARD_REFUSED` | `packages/cockpit/src/environment/application.ts` | no static remedy captured; inspect implementing owners |
| `SURFACE_OVERRIDE_INSPECTION_INVALID` | `packages/cockpit/src/environment/application.ts`, `packages/cockpit/src/environment/health-composition.ts` | no static remedy captured; inspect implementing owners |
| `SURFACE_OVERRIDE_INSPECTION_UNAVAILABLE` | `packages/cockpit/src/environment/application.ts`, `packages/cockpit/src/environment/health-composition.ts` | no static remedy captured; inspect implementing owners |

## cockpit doctor

Report read-only environment diagnostics.

Configuration: `resolved`. Owners: `packages/cockpit/src/config/load.ts`, `packages/cockpit/src/schema.ts`.

| Flag | Type | Default |
| --- | --- | --- |
| `--config` | string | unset |
| `--json` | boolean | `false` |

| Exit | Meaning |
| --- | --- |
| 0 | success |
| 2 | failure |
| 130 | cancelled |

| Diagnostic | Implementing owners | Source remedy |
| --- | --- | --- |
| `GUARD_AUTHORITY_UNAVAILABLE` | `packages/cockpit/src/environment/application.ts` | no static remedy captured; inspect implementing owners |
| `GUARD_HOSTS_UNDECLARED` | `packages/cockpit/src/environment/application.ts`, `packages/cockpit/src/environment/contract.ts` | list the database and live vendor API hosts of every non-local environment (production, staging, shared) under [guards] in cockpit.toml, then run cockpit sync; if no such environment exists, record that by writing hosted_db_hosts = [] and vendor_endpoint_hosts = [] under [guards] |
| `GUARD_REFUSED` | `packages/cockpit/src/environment/application.ts` | no static remedy captured; inspect implementing owners |
| `SURFACE_OVERRIDE_INSPECTION_INVALID` | `packages/cockpit/src/environment/application.ts`, `packages/cockpit/src/environment/health-composition.ts` | no static remedy captured; inspect implementing owners |
| `SURFACE_OVERRIDE_INSPECTION_UNAVAILABLE` | `packages/cockpit/src/environment/application.ts`, `packages/cockpit/src/environment/health-composition.ts` | no static remedy captured; inspect implementing owners |

## cockpit logs

Collect bounded logs for one declared service.

Configuration: `resolved`. Owners: `packages/cockpit/src/config/load.ts`, `packages/cockpit/src/schema.ts`.

| Flag | Type | Default |
| --- | --- | --- |
| `--config` | string | unset |
| `--service` | string | unset |
| `--tail` | string | `"100"` |
| `--since` | string | `"15m"` |
| `--follow` | boolean | `false` |
| `--json` | boolean | `false` |

| Exit | Meaning |
| --- | --- |
| 0 | success |
| 2 | failure |
| 130 | cancelled |

| Diagnostic | Implementing owners | Source remedy |
| --- | --- | --- |
| `GUARD_AUTHORITY_UNAVAILABLE` | `packages/cockpit/src/environment/application.ts` | no static remedy captured; inspect implementing owners |
| `GUARD_HOSTS_UNDECLARED` | `packages/cockpit/src/environment/application.ts`, `packages/cockpit/src/environment/contract.ts` | list the database and live vendor API hosts of every non-local environment (production, staging, shared) under [guards] in cockpit.toml, then run cockpit sync; if no such environment exists, record that by writing hosted_db_hosts = [] and vendor_endpoint_hosts = [] under [guards] |
| `GUARD_REFUSED` | `packages/cockpit/src/environment/application.ts` | no static remedy captured; inspect implementing owners |
| `SURFACE_OVERRIDE_INSPECTION_INVALID` | `packages/cockpit/src/environment/application.ts`, `packages/cockpit/src/environment/health-composition.ts` | no static remedy captured; inspect implementing owners |
| `SURFACE_OVERRIDE_INSPECTION_UNAVAILABLE` | `packages/cockpit/src/environment/application.ts`, `packages/cockpit/src/environment/health-composition.ts` | no static remedy captured; inspect implementing owners |

## cockpit baseline-record

Record an explicitly confirmed environment baseline.

Status: experimental. This interface may change before a stable release.

Configuration: `unavailable`. Owners: none.

| Flag | Type | Default |
| --- | --- | --- |
| `--config` | string | unset |
| `--interactive` | boolean | `false` |
| `--json` | boolean | `false` |

| Exit | Meaning |
| --- | --- |
| 0 | success |
| 2 | failure |
| 130 | cancelled |

| Diagnostic | Implementing owners | Source remedy |
| --- | --- | --- |
| unavailable | unavailable | no static owner binding was captured from CLI dispatch |

## cockpit work-intake

Prepare a source-bound work order.

Status: experimental. This interface may change before a stable release.

Configuration: `unavailable`. Owners: none.

| Flag | Type | Default |
| --- | --- | --- |
| `--config` | string | unset |
| `--json` | boolean | `false` |
| `--work-order` | string | unset |
| `--intent` | string | unset |
| `--candidate` | string | unset |

| Exit | Meaning |
| --- | --- |
| 0 | success |
| 2 | failure |
| 130 | cancelled |

| Diagnostic | Implementing owners | Source remedy |
| --- | --- | --- |
| unavailable | unavailable | no static owner binding was captured from CLI dispatch |

## cockpit work-status

Report current work-order state.

Status: experimental. This interface may change before a stable release.

Configuration: `unavailable`. Owners: none.

| Flag | Type | Default |
| --- | --- | --- |
| `--config` | string | unset |
| `--json` | boolean | `false` |
| `--work-order` | string | unset |

| Exit | Meaning |
| --- | --- |
| 0 | success |
| 2 | failure |
| 130 | cancelled |

| Diagnostic | Implementing owners | Source remedy |
| --- | --- | --- |
| unavailable | unavailable | no static owner binding was captured from CLI dispatch |

## cockpit work-accept

Interactively accept the exact current work order.

Status: experimental. This interface may change before a stable release.

Configuration: `unavailable`. Owners: none.

| Flag | Type | Default |
| --- | --- | --- |
| `--config` | string | unset |
| `--json` | boolean | `false` |
| `--work-order` | string | unset |
| `--interactive` | boolean | `false` |

| Exit | Meaning |
| --- | --- |
| 0 | success |
| 2 | failure |
| 130 | cancelled |

| Diagnostic | Implementing owners | Source remedy |
| --- | --- | --- |
| unavailable | unavailable | no static owner binding was captured from CLI dispatch |

## cockpit work-renew

Interactively renew a changed work-order contract.

Status: experimental. This interface may change before a stable release.

Configuration: `unavailable`. Owners: none.

| Flag | Type | Default |
| --- | --- | --- |
| `--config` | string | unset |
| `--json` | boolean | `false` |
| `--work-order` | string | unset |
| `--interactive` | boolean | `false` |

| Exit | Meaning |
| --- | --- |
| 0 | success |
| 2 | failure |
| 130 | cancelled |

| Diagnostic | Implementing owners | Source remedy |
| --- | --- | --- |
| unavailable | unavailable | no static owner binding was captured from CLI dispatch |

## cockpit work-resume

Resume the next executable step of the single active work order.

Status: experimental. This interface may change before a stable release.

Configuration: `unavailable`. Owners: none.

| Flag | Type | Default |
| --- | --- | --- |
| `--config` | string | unset |
| `--json` | boolean | `false` |

| Exit | Meaning |
| --- | --- |
| 0 | success |
| 2 | failure |
| 130 | cancelled |

| Diagnostic | Implementing owners | Source remedy |
| --- | --- | --- |
| unavailable | unavailable | no static owner binding was captured from CLI dispatch |

## cockpit work-recover

Inspect or explicitly recover one interrupted work lock.

Status: experimental. This interface may change before a stable release.

Configuration: `unavailable`. Owners: none.

| Flag | Type | Default |
| --- | --- | --- |
| `--config` | string | unset |
| `--json` | boolean | `false` |
| `--lock` | string | unset |
| `--apply` | boolean | `false` |

| Exit | Meaning |
| --- | --- |
| 0 | success |
| 2 | failure |
| 130 | cancelled |

| Diagnostic | Implementing owners | Source remedy |
| --- | --- | --- |
| unavailable | unavailable | no static owner binding was captured from CLI dispatch |

## cockpit work-execute

Execute one admitted work-order step.

Status: experimental. This interface may change before a stable release.

Configuration: `unavailable`. Owners: none.

| Flag | Type | Default |
| --- | --- | --- |
| `--config` | string | unset |
| `--json` | boolean | `false` |
| `--work-order` | string | unset |
| `--approach` | string | unset |

| Exit | Meaning |
| --- | --- |
| 0 | success |
| 2 | failure |
| 130 | cancelled |

| Diagnostic | Implementing owners | Source remedy |
| --- | --- | --- |
| unavailable | unavailable | no static owner binding was captured from CLI dispatch |

## cockpit work-record

Persist current work-order progress.

Status: experimental. This interface may change before a stable release.

Configuration: `unavailable`. Owners: none.

| Flag | Type | Default |
| --- | --- | --- |
| `--config` | string | unset |
| `--json` | boolean | `false` |
| `--work-order` | string | unset |
| `--event-file` | string | unset |

| Exit | Meaning |
| --- | --- |
| 0 | success |
| 2 | failure |
| 130 | cancelled |

| Diagnostic | Implementing owners | Source remedy |
| --- | --- | --- |
| unavailable | unavailable | no static owner binding was captured from CLI dispatch |

## cockpit work-review

Review the current accepted work order.

Status: experimental. This interface may change before a stable release.

Configuration: `unavailable`. Owners: none.

| Flag | Type | Default |
| --- | --- | --- |
| `--config` | string | unset |
| `--json` | boolean | `false` |
| `--work-order` | string | unset |

| Exit | Meaning |
| --- | --- |
| 0 | success |
| 2 | failure |
| 130 | cancelled |

| Diagnostic | Implementing owners | Source remedy |
| --- | --- | --- |
| unavailable | unavailable | no static owner binding was captured from CLI dispatch |

## cockpit work-sweep

Inspect or apply a reversible work-order sweep.

Status: experimental. This interface may change before a stable release.

Configuration: `unavailable`. Owners: none.

| Flag | Type | Default |
| --- | --- | --- |
| `--config` | string | unset |
| `--json` | boolean | `false` |
| `--apply` | boolean | `false` |

| Exit | Meaning |
| --- | --- |
| 0 | success |
| 2 | failure |
| 130 | cancelled |

| Diagnostic | Implementing owners | Source remedy |
| --- | --- | --- |
| unavailable | unavailable | no static owner binding was captured from CLI dispatch |

## cockpit work-reverse

Reverse an authenticated work-order sweep.

Status: experimental. This interface may change before a stable release.

Configuration: `unavailable`. Owners: none.

| Flag | Type | Default |
| --- | --- | --- |
| `--config` | string | unset |
| `--json` | boolean | `false` |
| `--work-order` | string | unset |

| Exit | Meaning |
| --- | --- |
| 0 | success |
| 2 | failure |
| 130 | cancelled |

| Diagnostic | Implementing owners | Source remedy |
| --- | --- | --- |
| unavailable | unavailable | no static owner binding was captured from CLI dispatch |

## cockpit work-programme-mint

Mint the next declared programme work order.

Status: experimental. This interface may change before a stable release.

Configuration: `unavailable`. Owners: none.

| Flag | Type | Default |
| --- | --- | --- |
| `--config` | string | unset |
| `--json` | boolean | `false` |
| `--programme` | string | unset |
| `--item` | string | unset |
| `--candidate` | string | unset |

| Exit | Meaning |
| --- | --- |
| 0 | success |
| 2 | failure |
| 130 | cancelled |

| Diagnostic | Implementing owners | Source remedy |
| --- | --- | --- |
| unavailable | unavailable | no static owner binding was captured from CLI dispatch |

## cockpit work-metrics

Report attributed work-order metrics.

Status: experimental. This interface may change before a stable release.

Configuration: `unavailable`. Owners: none.

| Flag | Type | Default |
| --- | --- | --- |
| `--config` | string | unset |
| `--json` | boolean | `false` |

| Exit | Meaning |
| --- | --- |
| 0 | success |
| 2 | failure |
| 130 | cancelled |

| Diagnostic | Implementing owners | Source remedy |
| --- | --- | --- |
| unavailable | unavailable | no static owner binding was captured from CLI dispatch |

## cockpit work-grade

Independently grade the current accepted work order.

Status: experimental. This interface may change before a stable release.

Configuration: `unavailable`. Owners: none.

| Flag | Type | Default |
| --- | --- | --- |
| `--config` | string | unset |
| `--json` | boolean | `false` |
| `--work-order` | string | unset |

| Exit | Meaning |
| --- | --- |
| 0 | success |
| 2 | failure |
| 130 | cancelled |

| Diagnostic | Implementing owners | Source remedy |
| --- | --- | --- |
| unavailable | unavailable | no static owner binding was captured from CLI dispatch |

## cockpit browser-drive

Drive the declared application browser surfaces.

Status: experimental. This interface may change before a stable release.

Configuration: `unavailable`. Owners: none.

| Flag | Type | Default |
| --- | --- | --- |
| `--config` | string | unset |
| `--json` | boolean | `false` |
| `--role` | string | unset |

| Exit | Meaning |
| --- | --- |
| 0 | success |
| 2 | failure |
| 130 | cancelled |

| Diagnostic | Implementing owners | Source remedy |
| --- | --- | --- |
| unavailable | unavailable | no static owner binding was captured from CLI dispatch |

## cockpit browser-accessibility

Collect bounded application accessibility observations.

Status: experimental. This interface may change before a stable release.

Configuration: `unavailable`. Owners: none.

| Flag | Type | Default |
| --- | --- | --- |
| `--config` | string | unset |
| `--json` | boolean | `false` |
| `--role` | string | unset |

| Exit | Meaning |
| --- | --- |
| 0 | success |
| 2 | failure |
| 130 | cancelled |

| Diagnostic | Implementing owners | Source remedy |
| --- | --- | --- |
| unavailable | unavailable | no static owner binding was captured from CLI dispatch |

## cockpit browser-screenshot

Capture the declared application surfaces.

Status: experimental. This interface may change before a stable release.

Configuration: `unavailable`. Owners: none.

| Flag | Type | Default |
| --- | --- | --- |
| `--config` | string | unset |
| `--json` | boolean | `false` |
| `--role` | string | unset |

| Exit | Meaning |
| --- | --- |
| 0 | success |
| 2 | failure |
| 130 | cancelled |

| Diagnostic | Implementing owners | Source remedy |
| --- | --- | --- |
| unavailable | unavailable | no static owner binding was captured from CLI dispatch |

## cockpit browser-debugger

Prepare an explicitly requested browser debugger.

Status: experimental. This interface may change before a stable release.

Configuration: `unavailable`. Owners: none.

| Flag | Type | Default |
| --- | --- | --- |
| `--config` | string | unset |
| `--json` | boolean | `false` |
| `--role` | string | unset |

| Exit | Meaning |
| --- | --- |
| 0 | success |
| 2 | failure |
| 130 | cancelled |

| Diagnostic | Implementing owners | Source remedy |
| --- | --- | --- |
| unavailable | unavailable | no static owner binding was captured from CLI dispatch |

## cockpit test-run

Run a declared product gate with honest selection.

Configuration: `unavailable`. Owners: none.

| Flag | Type | Default |
| --- | --- | --- |
| `--config` | string | unset |
| `--json` | boolean | `false` |
| `--gate` | string | unset |
| `--mode` | string | `"canonical"` |
| `--select` | string | unset |

| Exit | Meaning |
| --- | --- |
| 0 | success |
| 2 | failure |
| 130 | cancelled |

| Diagnostic | Implementing owners | Source remedy |
| --- | --- | --- |
| unavailable | unavailable | no static owner binding was captured from CLI dispatch |
