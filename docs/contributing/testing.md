# Testing harness surfaces

<!-- cockpit:verified version=0.0.0 -->

This page is for people working on cockpit itself: which module owns each harness surface, and
which focused test to run for each family of surface failure.

## Harness surface modules

Every module below is under `packages/cockpit/src/`. Thin command adapters connect them through
`packages/cockpit/src/cli.ts`; all process dispatch goes through
[the single executor](../../packages/cockpit/src/environment-exec/execute.ts).

| Responsibility | Module | Focused test file |
|---|---|---|
| Generator input checks and deterministic passes | [surfaces/generator-adapter.ts](../../packages/cockpit/src/surfaces/generator-adapter.ts) | `packages/cockpit/src/surfaces/generator-adapter.test.ts` |
| Combined core/plugin dispatch and worker recovery | [surfaces/generator-adapter.ts](../../packages/cockpit/src/surfaces/generator-adapter.ts) | `packages/cockpit/src/surfaces/generator-estate.test.ts` |
| Final surface rendering | [surfaces/render.ts](../../packages/cockpit/src/surfaces/render.ts) | `packages/cockpit/src/surfaces/render.test.ts` |
| Overlay merge | [surfaces/merge.ts](../../packages/cockpit/src/surfaces/merge.ts) | `packages/cockpit/src/surfaces/merge.test.ts` |
| MCP collection and approval | [surfaces/mcp.ts](../../packages/cockpit/src/surfaces/mcp.ts) | `packages/cockpit/src/surfaces/mcp.test.ts` |
| Guard expansion | [surfaces/restrictions.ts](../../packages/cockpit/src/surfaces/restrictions.ts) | `packages/cockpit/src/surfaces/restrictions.test.ts` |
| Sibling guides and grants | [surfaces/projection.ts](../../packages/cockpit/src/surfaces/projection.ts) | `packages/cockpit/src/surfaces/projection.test.ts` |
| Skills | [surfaces/skill-contract.ts](../../packages/cockpit/src/surfaces/skill-contract.ts) | `packages/cockpit/src/surfaces/skill-contract.test.ts` |
| Owned regions, changes and drift | [surfaces/ownership.ts](../../packages/cockpit/src/surfaces/ownership.ts), [surfaces/sync.ts](../../packages/cockpit/src/surfaces/sync.ts) | `packages/cockpit/src/surfaces/ownership.test.ts`, `packages/cockpit/src/surfaces/sync.test.ts` |
| Checking publication inputs | [environment/generated-application.ts](../../packages/cockpit/src/environment/generated-application.ts) | `packages/cockpit/src/generated-environment/command.authentication.test.ts` |
| Durable manifest and publication | [environment/generated-application.ts](../../packages/cockpit/src/environment/generated-application.ts) | `packages/cockpit/src/generated-environment/command.publication-bounds.test.ts`, `packages/cockpit/src/generated-environment/command.publication-core.test.ts`, `packages/cockpit/src/generated-environment/command.publication-custom.test.ts`, `packages/cockpit/src/generated-environment/command.publication-native.test.ts` |
| Repair and recovery | [environment/generated-application.ts](../../packages/cockpit/src/environment/generated-application.ts) | `packages/cockpit/src/generated-environment/command.test.ts` |
| Selftest | [surfaces/selftest.ts](../../packages/cockpit/src/surfaces/selftest.ts), [environment/selftest-application.ts](../../packages/cockpit/src/environment/selftest-application.ts) | `packages/cockpit/src/selftest/command.configured-artifact.test.ts`, `packages/cockpit/src/selftest/command.native-execution.test.ts`, `packages/cockpit/src/selftest/command.custom-operator.test.ts` |
| Human approval prompts | [environment/operator-application.ts](../../packages/cockpit/src/environment/operator-application.ts) | `packages/cockpit/src/environment/operator-application.test.ts` |
| Upgrade plan | [environment/upgrade-application.ts](../../packages/cockpit/src/environment/upgrade-application.ts) | `packages/cockpit/src/upgrade/command.test.ts` |

Repository tests check source behavior; they do not replace a selftest of the real tool.

## Focused harness verification

Run the command for the changed failure family from the repository root. These tests use
synthetic data; they do not exercise a real harness. `npm test` is described in
[Development loop](../../CONTRIBUTING.md#development-loop).

| Failure family | Focused verification command |
|---|---|
| Declaration and overlay validation | `npm test -- packages/cockpit/src/surfaces/merge.test.ts` |
| Generator inventory/determinism | `npm test -- packages/cockpit/src/surfaces/generator-adapter.test.ts` |
| Combined core/plugin dispatch, input limits and worker recovery | `npm test -- packages/cockpit/src/surfaces/generator-estate.test.ts` |
| Custom, whole-file and shared-region output | `npm test -- packages/cockpit/src/surfaces/render.test.ts packages/cockpit/src/surfaces/ownership.test.ts` |
| MCP declarations/wrappers | `npm test -- packages/cockpit/src/surfaces/mcp.test.ts` |
| Restriction policy/adapters | `npm test -- packages/cockpit/src/surfaces/restrictions.test.ts` |
| Sibling guides/grants | `npm test -- packages/cockpit/src/surfaces/projection.test.ts` |
| Skill contracts/budgets | `npm test -- packages/cockpit/src/surfaces/skill-contract.test.ts` |
| Selftest checks and approval | `npm test -- packages/cockpit/src/selftest/command.configured-artifact.test.ts packages/cockpit/src/selftest/command.native-execution.test.ts packages/cockpit/src/selftest/command.custom-operator.test.ts` |
| Upgrade plan and override inspection | `npm test -- packages/cockpit/src/upgrade/command.test.ts packages/cockpit/src/upgrade/release-evidence.test.ts` |

Publication recovery lives in `packages/cockpit/src/environment/generated-application.ts`. This
test checks that recovery data is kept when cleanup cannot be confirmed:

```sh
npm test -- packages/cockpit/src/generated-environment/command.test.ts -t 'retains recovery records when publication finalization is not confirmed'
```

A passing test is not a reason to delete retained recovery data or to repair state by hand.
Follow the named diagnostic and its recovery procedure.

## Generated environment drift

| Responsibility | Module |
|---|---|
| Rendering, inspection, publication and recovery | `packages/cockpit/src/environment/generated-application.ts` |
| `sync` and `check` command adapter | `packages/cockpit/src/generated-environment/command.ts` |
| Stack rendering | `packages/cockpit/src/environment/generated-stack.ts` |

One test covers the full `sync`/`check` path:

```sh
npm test -- packages/cockpit/src/generated-environment/command.publication-core.test.ts -t 'synchronizes one owned manifest idempotently and checks without mutation'
```

It runs `sync`, then `check`, which changes nothing. A deliberately broken second case changes
the persona source but keeps the old generated files; `check` then reports
`GENERATED_ARTIFACT_DRIFT` for the persona output and leaves every file unchanged. That proves drift
detection, and nothing about native runtime or vendor behaviour.
