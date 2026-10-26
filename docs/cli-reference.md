# CLI reference

<!-- cockpit:verified version=0.0.0 -->

Commands and flags derive from the implementing command table.

## cockpit init

Preview or accept one explicit bootstrap target in an existing checkout.

Configuration: `none`. Owners: none.

| Flag | Type | Default |
| --- | --- | --- |
| `--target` | string | unset |
| `--registry` | string | unset |
| `--interactive` | boolean | `false` |
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
| `DOCUMENT_INFERRED` | `packages/cockpit/src/document/command.ts` | no static remedy captured; inspect implementing owners |
| `DOCUMENT_NO_RUNNABLE_PRODUCT` | `packages/cockpit/src/document/command.ts` | no static remedy captured; inspect implementing owners |
| `DOCUMENT_RUNNABLE_TOPOLOGY_MISMATCH` | `packages/cockpit/src/document/command.ts` | no static remedy captured; inspect implementing owners |
| `DOCUMENT_SOURCE_REQUIRED` | `packages/cockpit/src/cli.ts`, `packages/cockpit/src/document/command.ts` | no static remedy captured; inspect implementing owners |
| `DOCUMENT_STDOUT_TARGET` | `packages/cockpit/src/document/command.ts` | no static remedy captured; inspect implementing owners |
| `GENERATED_COMPENSATION_FAILED` | `packages/cockpit/src/generated-environment/transaction.ts` | no static remedy captured; inspect implementing owners |
| `GENERATED_OWNERSHIP_INVALID` | `packages/cockpit/src/environment/generated-application.ts`, `packages/cockpit/src/generated-environment/transaction.ts`, `packages/cockpit/src/generated-environment/uninstall.ts` | no static remedy captured; inspect implementing owners |
| `GENERATED_OWNERSHIP_MISSING` | `packages/cockpit/src/environment/generated-application.ts`, `packages/cockpit/src/generated-environment/transaction.ts`, `packages/cockpit/src/generated-environment/uninstall.ts` | no static remedy captured; inspect implementing owners |
| `GENERATED_PATH_UNSAFE` | `packages/cockpit/src/environment/generated-application.ts`, `packages/cockpit/src/generated-environment/transaction.ts` | no static remedy captured; inspect implementing owners |
| `GENERATED_PUBLICATION_FAILED` | `packages/cockpit/src/environment/generated-application.ts`, `packages/cockpit/src/generated-environment/transaction.ts` | no static remedy captured; inspect implementing owners |
| `GENERATED_REFERENCE_BOOTSTRAP_INVALID` | `packages/cockpit/src/generated-environment/transaction.ts` | no static remedy captured; inspect implementing owners |
| `GENERATED_REFERENCE_OWNERSHIP_INVALID` | `packages/cockpit/src/generated-environment/transaction.ts` | no static remedy captured; inspect implementing owners |
| `GENERATED_SOURCE_CHANGED` | `packages/cockpit/src/environment/generated-application.ts`, `packages/cockpit/src/generated-environment/transaction.ts` | no static remedy captured; inspect implementing owners |
| `GENERATED_STALE_APPROVAL_INVALID` | `packages/cockpit/src/generated-environment/transaction.ts` | no static remedy captured; inspect implementing owners |
| `GENERATED_STALE_APPROVAL_REQUIRED` | `packages/cockpit/src/environment/operator-application.ts`, `packages/cockpit/src/generated-environment/transaction.ts` | no static remedy captured; inspect implementing owners |
| `GENERATED_STALE_ARTIFACT_DRIFT` | `packages/cockpit/src/environment/generated-application.ts`, `packages/cockpit/src/generated-environment/transaction.ts`, `packages/cockpit/src/generated-environment/uninstall.ts` | no static remedy captured; inspect implementing owners |
| `GREENFIELD_ANSWER_INVALID` | `packages/cockpit/src/environment/init-application.ts` | no static remedy captured; inspect implementing owners |
| `GREENFIELD_ANSWER_UNEXPECTED` | `packages/cockpit/src/environment/init-application.ts` | no static remedy captured; inspect implementing owners |
| `GREENFIELD_DISCOVERY_UNAVAILABLE` | `packages/cockpit/src/environment/init-application.ts` | no static remedy captured; inspect implementing owners |
| `GREENFIELD_OBSERVATION_CHANGED` | `packages/cockpit/src/environment/init-application.ts` | no static remedy captured; inspect implementing owners |
| `GREENFIELD_OBSERVATION_INVALID` | `packages/cockpit/src/environment/init-application.ts` | no static remedy captured; inspect implementing owners |
| `GUARD_AUTHORITY_UNAVAILABLE` | `packages/cockpit/src/environment/application.ts` | no static remedy captured; inspect implementing owners |
| `GUARD_REFUSED` | `packages/cockpit/src/environment/application.ts` | no static remedy captured; inspect implementing owners |
| `INIT_BOOTSTRAP_IDENTITY_CHANGED` | `packages/cockpit/src/environment/init-application.ts` | no static remedy captured; inspect implementing owners |
| `INIT_CANONICAL_OWNERSHIP_MISSING` | `packages/cockpit/src/environment/init-application.ts` | no static remedy captured; inspect implementing owners |
| `INIT_DRAFT_CHANGED` | `packages/cockpit/src/environment/init-application.ts` | no static remedy captured; inspect implementing owners |
| `INIT_DRAFT_INVALID` | `packages/cockpit/src/environment/init-application.ts` | no static remedy captured; inspect implementing owners |
| `INIT_DRAFT_SOURCE_CHANGED` | `packages/cockpit/src/environment/init-application.ts` | no static remedy captured; inspect implementing owners |
| `INIT_PREVIEW_CHANGED` | `packages/cockpit/src/environment/init-application.ts` | no static remedy captured; inspect implementing owners |
| `INIT_ROOT_INVALID` | `packages/cockpit/src/environment/init-application.ts` | no static remedy captured; inspect implementing owners |
| `INIT_STATE_DURABILITY_INDETERMINATE` | `packages/cockpit/src/environment/init-application.ts` | no static remedy captured; inspect implementing owners |
| `INIT_STATE_STALE` | `packages/cockpit/src/environment/init-application.ts` | no static remedy captured; inspect implementing owners |
| `INIT_STATE_UNAUTHENTICATED` | `packages/cockpit/src/environment/init-application.ts` | no static remedy captured; inspect implementing owners |
| `INIT_TARGET_CHANGED` | `packages/cockpit/src/environment/init-application.ts` | no static remedy captured; inspect implementing owners |
| `REGISTRY_EMPTY` | `packages/cockpit/src/document/command.ts`, `packages/cockpit/src/registry-resolve/command.ts` | no static remedy captured; inspect implementing owners |
| `REGISTRY_ENCODING_INVALID` | `packages/cockpit/src/document/command.ts`, `packages/cockpit/src/registry-resolve/command.ts` | no static remedy captured; inspect implementing owners |
| `REGISTRY_NOT_FOUND` | `packages/cockpit/src/document/command.ts`, `packages/cockpit/src/registry-resolve/command.ts` | no static remedy captured; inspect implementing owners |
| `REGISTRY_ROW_SKIPPED` | `packages/cockpit/src/document/command.ts`, `packages/cockpit/src/registry-resolve/command.ts` | repair every skipped row before documenting repository scope |
| `REGISTRY_TOO_LARGE` | `packages/cockpit/src/document/command.ts`, `packages/cockpit/src/registry-resolve/command.ts` | no static remedy captured; inspect implementing owners |
| `REGISTRY_UNREADABLE` | `packages/cockpit/src/document/command.ts`, `packages/cockpit/src/registry-resolve/command.ts` | no static remedy captured; inspect implementing owners |
| `SURFACE_OVERRIDE_INSPECTION_INVALID` | `packages/cockpit/src/environment/application.ts`, `packages/cockpit/src/environment/health-composition.ts` | no static remedy captured; inspect implementing owners |
| `SURFACE_OVERRIDE_INSPECTION_UNAVAILABLE` | `packages/cockpit/src/environment/application.ts`, `packages/cockpit/src/environment/health-composition.ts` | no static remedy captured; inspect implementing owners |

## cockpit compare

Validate an isolated comparison, run it, or inspect its operator ledger.

Configuration: `none`. Owners: none.

| Flag | Type | Default |
| --- | --- | --- |
| `--fixture` | string | unset |
| `--config` | string | unset |
| `--ledger` | string | unset |
| `--json` | boolean | `false` |

| Operation | Configuration | Required flags | Admitted flags |
| --- | --- | --- | --- |
| `validate` | `none` | `--fixture` | `--fixture`, `--json` |
| `run` | `resolved` | `--fixture`, `--config` | `--fixture`, `--config`, `--json` |
| `status` | `none` | `--fixture`, `--ledger` | `--fixture`, `--ledger`, `--json` |

| Exit | Meaning |
| --- | --- |
| 0 | success |
| 2 | failure |
| 130 | cancelled |

| Diagnostic | Implementing owners | Source remedy |
| --- | --- | --- |
| `COMPARISON_UNAVAILABLE` | `packages/cockpit/src/comparison/command.ts` | no static remedy captured; inspect implementing owners |

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
| `DOCUMENT_INFERRED` | `packages/cockpit/src/document/command.ts` | no static remedy captured; inspect implementing owners |
| `DOCUMENT_NO_RUNNABLE_PRODUCT` | `packages/cockpit/src/document/command.ts` | no static remedy captured; inspect implementing owners |
| `DOCUMENT_RUNNABLE_TOPOLOGY_MISMATCH` | `packages/cockpit/src/document/command.ts` | no static remedy captured; inspect implementing owners |
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
| `--json` | boolean | `false` |

| Exit | Meaning |
| --- | --- |
| 0 | success |
| 2 | failure |
| 130 | cancelled |

| Diagnostic | Implementing owners | Source remedy |
| --- | --- | --- |
| `GUARD_AUTHORITY_UNAVAILABLE` | `packages/cockpit/src/environment/application.ts` | no static remedy captured; inspect implementing owners |
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
| `--interactive` | boolean | `false` |
| `--json` | boolean | `false` |

| Exit | Meaning |
| --- | --- |
| 0 | success |
| 2 | failure |
| 130 | cancelled |

| Diagnostic | Implementing owners | Source remedy |
| --- | --- | --- |
| `CLI_INTERNAL_ERROR` | `packages/cockpit/src/cli.ts`, `packages/cockpit/src/environment/operator-application.ts` | no static remedy captured; inspect implementing owners |
| `GENERATED_ARTIFACT_DRIFT` | `packages/cockpit/src/environment/generated-application.ts`, `packages/cockpit/src/environment/generated-stack.ts` | no static remedy captured; inspect implementing owners |
| `GENERATED_ARTIFACT_MISSING` | `packages/cockpit/src/environment/generated-application.ts`, `packages/cockpit/src/environment/generated-stack.ts` | no static remedy captured; inspect implementing owners |
| `GENERATED_DECLARATION_INVALID` | `packages/cockpit/src/environment/generated-application.ts`, `packages/cockpit/src/environment/generated-render.ts` | no static remedy captured; inspect implementing owners |
| `GENERATED_DECLARATION_MISSING` | `packages/cockpit/src/environment/generated-application.ts` | no static remedy captured; inspect implementing owners |
| `GENERATED_EXECUTABLE_UNAVAILABLE` | `packages/cockpit/src/environment/generated-application.ts`, `packages/cockpit/src/generated-environment/uninstall.ts` | no static remedy captured; inspect implementing owners |
| `GENERATED_INPUT_INVALID` | `packages/cockpit/src/environment/generated-application.ts`, `packages/cockpit/src/environment/generated-render.ts`, `packages/cockpit/src/generated-environment/uninstall.ts` | no static remedy captured; inspect implementing owners |
| `GENERATED_OWNERSHIP_DRIFT` | `packages/cockpit/src/environment/generated-application.ts` | no static remedy captured; inspect implementing owners |
| `GENERATED_OWNERSHIP_FORMAT_UNSUPPORTED` | `packages/cockpit/src/environment/generated-application.ts`, `packages/cockpit/src/generated-environment/uninstall.ts` | no static remedy captured; inspect implementing owners |
| `GENERATED_OWNERSHIP_INVALID` | `packages/cockpit/src/environment/generated-application.ts`, `packages/cockpit/src/generated-environment/transaction.ts`, `packages/cockpit/src/generated-environment/uninstall.ts` | no static remedy captured; inspect implementing owners |
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
| `MCP_DECLARATION_INVALID` | `packages/cockpit/src/environment/generated-application.ts`, `packages/cockpit/src/surfaces/mcp.ts` | no static remedy captured; inspect implementing owners |
| `SKILL_RENDER_INVALID` | `packages/cockpit/src/environment/generated-application.ts`, `packages/cockpit/src/surfaces/skill-contract.ts` | no static remedy captured; inspect implementing owners |
| `SURFACE_BOUNDS` | `packages/cockpit/src/environment/generated-application.ts`, `packages/cockpit/src/surfaces/check.ts`, `packages/cockpit/src/surfaces/ownership.ts`, `packages/cockpit/src/surfaces/render.ts` | no static remedy captured; inspect implementing owners |
| `SURFACE_CUSTOM_REFUSED` | `packages/cockpit/src/environment/generated-application.ts` | no static remedy captured; inspect implementing owners |
| `SURFACE_GENERATION_FAILED` | `packages/cockpit/src/environment/generated-application.ts` | no static remedy captured; inspect implementing owners |
| `SURFACE_INPUT_INVALID` | `packages/cockpit/src/environment/generated-application.ts`, `packages/cockpit/src/surfaces/check.ts`, `packages/cockpit/src/surfaces/generator-adapter.ts`, `packages/cockpit/src/surfaces/merge.ts`, `packages/cockpit/src/surfaces/ownership.ts`, `packages/cockpit/src/surfaces/render.ts` | no static remedy captured; inspect implementing owners |
| `SURFACE_PATH_CONFLICT` | `packages/cockpit/src/environment/generated-application.ts`, `packages/cockpit/src/surfaces/merge.ts`, `packages/cockpit/src/surfaces/ownership.ts`, `packages/cockpit/src/surfaces/render.ts` | no static remedy captured; inspect implementing owners |
| `SURFACE_SOURCE_UNAVAILABLE` | `packages/cockpit/src/environment/generated-application.ts` | no static remedy captured; inspect implementing owners |
| `SURFACE_STATE_CONFLICT` | `packages/cockpit/src/environment/generated-application.ts`, `packages/cockpit/src/surfaces/ownership.ts`, `packages/cockpit/src/surfaces/sync.ts` | no static remedy captured; inspect implementing owners |

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
| `CLI_INTERNAL_ERROR` | `packages/cockpit/src/cli.ts`, `packages/cockpit/src/environment/operator-application.ts` | no static remedy captured; inspect implementing owners |
| `GENERATED_ARTIFACT_DRIFT` | `packages/cockpit/src/environment/generated-application.ts`, `packages/cockpit/src/environment/generated-stack.ts` | no static remedy captured; inspect implementing owners |
| `GENERATED_ARTIFACT_MISSING` | `packages/cockpit/src/environment/generated-application.ts`, `packages/cockpit/src/environment/generated-stack.ts` | no static remedy captured; inspect implementing owners |
| `GENERATED_DECLARATION_INVALID` | `packages/cockpit/src/environment/generated-application.ts`, `packages/cockpit/src/environment/generated-render.ts` | no static remedy captured; inspect implementing owners |
| `GENERATED_DECLARATION_MISSING` | `packages/cockpit/src/environment/generated-application.ts` | no static remedy captured; inspect implementing owners |
| `GENERATED_EXECUTABLE_UNAVAILABLE` | `packages/cockpit/src/environment/generated-application.ts`, `packages/cockpit/src/generated-environment/uninstall.ts` | no static remedy captured; inspect implementing owners |
| `GENERATED_INPUT_INVALID` | `packages/cockpit/src/environment/generated-application.ts`, `packages/cockpit/src/environment/generated-render.ts`, `packages/cockpit/src/generated-environment/uninstall.ts` | no static remedy captured; inspect implementing owners |
| `GENERATED_OWNERSHIP_DRIFT` | `packages/cockpit/src/environment/generated-application.ts` | no static remedy captured; inspect implementing owners |
| `GENERATED_OWNERSHIP_FORMAT_UNSUPPORTED` | `packages/cockpit/src/environment/generated-application.ts`, `packages/cockpit/src/generated-environment/uninstall.ts` | no static remedy captured; inspect implementing owners |
| `GENERATED_OWNERSHIP_INVALID` | `packages/cockpit/src/environment/generated-application.ts`, `packages/cockpit/src/generated-environment/transaction.ts`, `packages/cockpit/src/generated-environment/uninstall.ts` | no static remedy captured; inspect implementing owners |
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
| `MCP_DECLARATION_INVALID` | `packages/cockpit/src/environment/generated-application.ts`, `packages/cockpit/src/surfaces/mcp.ts` | no static remedy captured; inspect implementing owners |
| `SKILL_RENDER_INVALID` | `packages/cockpit/src/environment/generated-application.ts`, `packages/cockpit/src/surfaces/skill-contract.ts` | no static remedy captured; inspect implementing owners |
| `SURFACE_BOUNDS` | `packages/cockpit/src/environment/generated-application.ts`, `packages/cockpit/src/surfaces/check.ts`, `packages/cockpit/src/surfaces/ownership.ts`, `packages/cockpit/src/surfaces/render.ts` | no static remedy captured; inspect implementing owners |
| `SURFACE_CUSTOM_REFUSED` | `packages/cockpit/src/environment/generated-application.ts` | no static remedy captured; inspect implementing owners |
| `SURFACE_GENERATION_FAILED` | `packages/cockpit/src/environment/generated-application.ts` | no static remedy captured; inspect implementing owners |
| `SURFACE_INPUT_INVALID` | `packages/cockpit/src/environment/generated-application.ts`, `packages/cockpit/src/surfaces/check.ts`, `packages/cockpit/src/surfaces/generator-adapter.ts`, `packages/cockpit/src/surfaces/merge.ts`, `packages/cockpit/src/surfaces/ownership.ts`, `packages/cockpit/src/surfaces/render.ts` | no static remedy captured; inspect implementing owners |
| `SURFACE_PATH_CONFLICT` | `packages/cockpit/src/environment/generated-application.ts`, `packages/cockpit/src/surfaces/merge.ts`, `packages/cockpit/src/surfaces/ownership.ts`, `packages/cockpit/src/surfaces/render.ts` | no static remedy captured; inspect implementing owners |
| `SURFACE_SOURCE_UNAVAILABLE` | `packages/cockpit/src/environment/generated-application.ts` | no static remedy captured; inspect implementing owners |
| `SURFACE_STATE_CONFLICT` | `packages/cockpit/src/environment/generated-application.ts`, `packages/cockpit/src/surfaces/ownership.ts`, `packages/cockpit/src/surfaces/sync.ts` | no static remedy captured; inspect implementing owners |

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
| `GUARD_AUTHORITY_UNAVAILABLE` | `packages/cockpit/src/environment/application.ts` | no static remedy captured; inspect implementing owners |
| `GUARD_REFUSED` | `packages/cockpit/src/environment/application.ts` | no static remedy captured; inspect implementing owners |
| `SURFACE_OVERRIDE_INSPECTION_INVALID` | `packages/cockpit/src/environment/application.ts`, `packages/cockpit/src/environment/health-composition.ts` | no static remedy captured; inspect implementing owners |
| `SURFACE_OVERRIDE_INSPECTION_UNAVAILABLE` | `packages/cockpit/src/environment/application.ts`, `packages/cockpit/src/environment/health-composition.ts` | no static remedy captured; inspect implementing owners |

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
| `GUARD_REFUSED` | `packages/cockpit/src/environment/application.ts` | no static remedy captured; inspect implementing owners |
| `SURFACE_OVERRIDE_INSPECTION_INVALID` | `packages/cockpit/src/environment/application.ts`, `packages/cockpit/src/environment/health-composition.ts` | no static remedy captured; inspect implementing owners |
| `SURFACE_OVERRIDE_INSPECTION_UNAVAILABLE` | `packages/cockpit/src/environment/application.ts`, `packages/cockpit/src/environment/health-composition.ts` | no static remedy captured; inspect implementing owners |

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
| `GUARD_REFUSED` | `packages/cockpit/src/environment/application.ts` | no static remedy captured; inspect implementing owners |
| `SURFACE_OVERRIDE_INSPECTION_INVALID` | `packages/cockpit/src/environment/application.ts`, `packages/cockpit/src/environment/health-composition.ts` | no static remedy captured; inspect implementing owners |
| `SURFACE_OVERRIDE_INSPECTION_UNAVAILABLE` | `packages/cockpit/src/environment/application.ts`, `packages/cockpit/src/environment/health-composition.ts` | no static remedy captured; inspect implementing owners |

## cockpit baseline-record

Record an explicitly confirmed environment baseline.

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
