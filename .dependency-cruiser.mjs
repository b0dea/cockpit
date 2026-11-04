// Import-graph rules for the production modules (packages/cockpit/src and scripts, tests excluded).
// packages/cockpit/src/architecture.test.ts runs this configuration and holds the rules an import
// graph cannot express.
const SRC = 'packages/cockpit/src'
const ENV = `${SRC}/environment`
const COMMANDS = [`^${SRC}/commands?(?:/|\\.ts$)`, `^${SRC}/.*/commands?(?:/|\\.ts$)`, `^${SRC}/.*-command\\.ts$`]
const CLI = `^${SRC}/cli(?:-main|-guard)?\\.ts$`
const COMMAND_TABLE = `^${SRC}/command-table\\.ts$`
const APPLICATION = `^${ENV}/application/[^/]+\\.ts$`
const GENERATED_APPLICATION = `^${ENV}/generated-application/[^/]+\\.ts$`
const EVALUATOR = `^${SRC}/guards/evaluator\\.ts$`
const PARSER = `^${SRC}/guards/invocation-parser\\.ts$`
const HARNESS_ADAPTER = `^${SRC}/guards/harness-adapter\\.ts$`
const exact = (...paths) => `^(?:${paths.map((path) => path.replaceAll('.', '\\.')).join('|')})$`

// Leaves the rest of the product builds on: none of them may reach a command or the CLI.
const KERNEL_LEAVES = exact(...[
    'diagnostics.ts', 'command-table.ts', 'schema.ts', 'registry-resolve/registry.ts', 'config/load.ts',
    'environment/contract.ts', 'environment/runtime.ts', 'environment/logs.ts', 'environment/lifecycle.ts',
    'environment/install-policy.ts', 'environment/install-policy-observation.ts',
].map((path) => `${SRC}/${path}`))

const forbid = (name, comment, from, to) => ({ name, comment, severity: 'error', from, to })

export default {
    forbidden: [
        forbid('no-cycle', 'Modules form a directed graph; a cycle hides which side owns the decision.',
            {}, { circular: true }),
        forbid('kernel-leaf-direction', 'A kernel leaf never depends, even transitively, on a command or the CLI.',
            { path: KERNEL_LEAVES }, { path: [...COMMANDS, CLI], reachable: true }),
        forbid('application-below-commands', 'The environment application is called by commands and never calls one.',
            { path: APPLICATION }, { path: COMMANDS }),
        forbid('runtime-below-application', 'Runtime planning sits below failure logs and the application.',
            { path: `^${ENV}/runtime\\.ts$` }, { path: [`^${ENV}/logs\\.ts$`, APPLICATION] }),
        forbid('logs-below-application', 'Failure-log planning sits below the application.',
            { path: `^${ENV}/logs\\.ts$` }, { path: APPLICATION }),
        forbid('lifecycle-planning-imports', 'Lifecycle planning is pure: it reads projections from its fixed set of owners and executes nothing.',
            { path: `^${ENV}/lifecycle\\.ts$` },
            { pathNot: [exact(...['contract', 'lifecycle-stage', 'ports', 'reclaim', 'runtime', 'claims'].map((name) => `${ENV}/${name}.ts`)),
                '^(?:node:)?(?:crypto|util/types)$'] }),
        forbid('state-below-claims', 'State persistence holds no coordination policy, so it never reads the claims broker.',
            { path: `^${ENV}/state\\.ts$` }, { path: `^${ENV}/claims\\.ts$` }),
        forbid('command-table-is-data', 'The command table names handlers from leaf contracts; it never imports a handler.',
            { path: COMMAND_TABLE },
            { pathNot: exact(...['surfaces/contract.ts', 'work-orders/contract.ts', 'environment/contract.ts', 'guards/evaluator.ts',
                'guards/harness-adapter.ts', 'guards/invocation-parser.ts'].map((path) => `${SRC}/${path}`)), dependencyTypesNot: ['core'] }),
        forbid('handler-below-dispatch', 'A command handler never imports the dispatcher that calls it.',
            { path: COMMANDS }, { path: [COMMAND_TABLE, CLI] }),
        forbid('no-peer-command', 'Commands share owners, never each other.',
            { path: COMMANDS }, { path: COMMANDS }),
        forbid('commands-do-not-execute', 'A command reaches child processes only through an application, never the executor itself.',
            { path: COMMANDS }, { path: `^${SRC}/environment-exec/execute\\.ts$`, dependencyTypesNot: ['type-only'] }),
        forbid('init-command-imports', 'Init presentation reaches only the init application and leaf vocabularies.',
            { path: `^${SRC}/init/command\\.ts$` },
            { pathNot: [exact(`${ENV}/init-application.ts`, `${SRC}/canonical-json.ts`, `${SRC}/surfaces/contract.ts`, `${SRC}/fix-catalogue.ts`, `${SRC}/refusal.ts`), '^(?:node:)?crypto$'] }),
        forbid('init-application-imports', 'The init application decides through its fixed owners and writes nothing directly.',
            { path: `^${ENV}/init-application\\.ts$` },
            { pathNot: [exact(...[
                'diagnostics.ts', 'fix-catalogue.ts', 'init/draft.ts', 'surfaces/contract.ts', 'environment/contract.ts',
                'environment/identity.ts', 'environment/state.ts', 'readiness.ts', 'refusal.ts',
            ].map((path) => `${SRC}/${path}`)), '^(?:node:)?(?:crypto|path)$'] }),
        forbid('cli-reaches-work-through-application', 'The CLI reaches work orders, grading, browser and testing only through the work application.',
            { path: CLI },
            { path: `^${SRC}/(?:work-orders|grading|browser|testing)/`,
                pathNot: exact(`${SRC}/work-orders/application.ts`, `${SRC}/work-orders/composition.ts`) }),
        forbid('policy-leaves-below-guard-runtime', 'Configuration and registry parsing never reach guard dispatch or evaluation.',
            { path: exact(`${SRC}/schema.ts`, `${SRC}/registry-derivation.ts`, `${SRC}/registry-resolve/registry.ts`) },
            { path: [COMMAND_TABLE, APPLICATION, GENERATED_APPLICATION, CLI] }),
        forbid('evaluator-independent', 'The CLI and generated application never evaluate guard policy themselves.',
            { path: [CLI, GENERATED_APPLICATION] }, { path: EVALUATOR }),
        forbid('evaluator-is-a-leaf', 'The guard evaluator depends on no dispatcher or adapter.',
            { path: EVALUATOR }, { path: [APPLICATION, GENERATED_APPLICATION, CLI, HARNESS_ADAPTER, COMMAND_TABLE] }),
        forbid('guard-input-leaves', 'Guard input parsing and host normalisation depend on nothing that consumes them.',
            { path: [PARSER, `^${SRC}/guards/host\\.ts$`] },
            { path: [APPLICATION, GENERATED_APPLICATION, CLI, COMMAND_TABLE, HARNESS_ADAPTER, EVALUATOR] }),
        forbid('command-table-below-runtime', 'The command table is metadata below the configuration and every dispatcher.',
            { path: COMMAND_TABLE },
            { path: [APPLICATION, GENERATED_APPLICATION, CLI, `^${SRC}/schema\\.ts$`, `^${SRC}/registry-derivation\\.ts$`] }),
        forbid('product-excludes-maintainer-tooling', 'The shipped package never reaches maintainer scripts or the TypeScript compiler they use.',
            { path: `^${SRC}/` },
            { path: ['^scripts/', '^node_modules/(?:typescript|@typescript/typescript6)/'], dependencyTypesNot: ['type-only'] }),
    ],
    required: [
        { name: 'resolver-uses-registry-parser', comment: 'Registry resolution parses through the one registry parser.', severity: 'error',
            module: { path: `^${SRC}/registry-resolve/command\\.ts$` }, to: { path: `^${SRC}/registry-resolve/registry\\.ts$` } },
    ],
    options: {
        doNotFollow: { path: 'node_modules' },
        exclude: { path: ['\\.test\\.ts$', '\\.d\\.[cm]?ts$', `^${SRC}/test-support/`] },
        tsPreCompilationDeps: true,
    },
}
