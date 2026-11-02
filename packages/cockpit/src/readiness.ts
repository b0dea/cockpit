// The prerequisites cockpit itself depends on in a product and its cockpit, each with why it is
// needed and the diagnostics that already report its absence. It detects nothing: the owners of
// those diagnostics do, and a required prerequisite is refused by the command that needs it. This
// module only gathers what a command reported into one list a person, or the setup agent walking
// them through it, can act on. Judgement (which test runner, whether existing tests mean anything)
// stays with them; a gap here is a fact.
import { ENVIRONMENT_CODES } from './environment/contract.js'

export const mechanism = {
    id: 'readiness-catalogue',
    module: 'packages/cockpit/src/readiness.ts',
    exports: ['READINESS_CATALOGUE', 'readinessReport'],
} as const

/** A cockpit that only publishes agent surfaces, or one that also declares a runtime. */
export type ReadinessState = 'surfaces-only' | 'runtime'

export interface ReadinessEntry {
    readonly id: string
    /** Why cockpit needs it, in one sentence. */
    readonly needs: string
    /** Required prerequisites are refused by `refusedBy`; recommended ones only warn. */
    readonly level: 'required' | 'recommended'
    readonly appliesTo: readonly ReadinessState[]
    /** The existing diagnostics that report this prerequisite missing. */
    readonly codes: readonly string[]
    /** The command that refuses while a required prerequisite is missing, and the code it refuses with. */
    readonly refusedBy?: Readonly<{ command: string; code: string }>
    /** What to do when a finding carries no fix of its own. */
    readonly fix: string
}

const C = ENVIRONMENT_CODES
const BOTH: readonly ReadinessState[] = Object.freeze(['surfaces-only', 'runtime'])
const RUNTIME: readonly ReadinessState[] = Object.freeze(['runtime'])

const entries: readonly ReadinessEntry[] = [
    { id: 'cockpit-git', level: 'required', appliesTo: BOTH, codes: [C.SETUP_PATH_TYPE_INVALID],
        refusedBy: { command: 'setup', code: C.SETUP_PATH_TYPE_INVALID },
        needs: 'setup confines every repository write to the cockpit\'s Git working tree, and teammates get the cockpit by cloning it',
        fix: 'run git init in the cockpit root' },
    { id: 'cockpit-committed', level: 'required', appliesTo: BOTH, codes: [C.GIT_STATE_UNHEALTHY, C.CHECKOUT_ADJACENCY_UNHEALTHY],
        refusedBy: { command: 'preflight', code: C.GIT_STATE_UNHEALTHY },
        needs: 'preflight vouches only for a committed cockpit, and a teammate\'s clone holds only what was committed',
        fix: 'review git status --short in the cockpit root with a person, then commit the cockpit files' },
    { id: 'cockpit-installed', level: 'recommended', appliesTo: BOTH, codes: [C.COCKPIT_NOT_INSTALLED],
        needs: 'every instruction cockpit generates runs npx --no cockpit from the cockpit root, and the guard hook runs the copy installed there',
        fix: 'run npm install in the cockpit root, then npx --no cockpit sync --config <your cockpit.toml> in a terminal' },
    { id: 'cockpit-launcher-proven', level: 'recommended', appliesTo: BOTH, codes: [C.COCKPIT_LAUNCHER_UNPROVEN],
        needs: 'the guard runs a printed npx --no cockpit command without asking only when it can prove npx starts the installed cockpit; Codex and OpenCode refuse what it would ask about',
        fix: 'run cockpit as ./node_modules/.bin/cockpit <command> --config <your cockpit.toml> from the cockpit root, or remove what stops npx from proving it' },
    { id: 'siblings-present', level: 'required', appliesTo: BOTH, codes: [C.SIBLING_MISSING, C.SETUP_NONE_ABSENT],
        refusedBy: { command: 'check', code: C.SIBLING_MISSING },
        needs: 'mounts, directory grants, guides and generated services all point at each declared repository',
        fix: 'run npx --no cockpit setup --config <your cockpit.toml>, or clone the repository where cockpit.toml declares it' },
    { id: 'sibling-remote', level: 'recommended', appliesTo: BOTH, codes: [C.SIBLING_REMOTE_UNRECORDED],
        needs: 'setup in a teammate\'s clone of the cockpit obtains only the repositories whose remote cockpit.toml records',
        fix: 'record the pushed repository with npx --no cockpit sibling add <slug> --remote <url> --config <your cockpit.toml>' },
    { id: 'container-runtime', level: 'required', appliesTo: RUNTIME, codes: [C.RUNTIME_UNAVAILABLE, C.RUNTIME_UNMEASURED],
        refusedBy: { command: 'up', code: C.RUNTIME_UNMEASURED },
        needs: 'up runs the stack with Docker Compose, and only on a runtime this machine has measured',
        fix: 'start Docker, then run npx --no cockpit runtime measure --config <your cockpit.toml> --image <local-image>' },
    { id: 'machine-floor', level: 'required', appliesTo: RUNTIME,
        codes: [C.MACHINE_MEMORY_BELOW_FLOOR, C.MACHINE_CPU_BELOW_FLOOR, C.MACHINE_DISK_BELOW_FLOOR],
        refusedBy: { command: 'up', code: C.MACHINE_MEMORY_BELOW_FLOOR },
        needs: 'up refuses to start a stack the container runtime cannot hold, measured against environment.machine',
        fix: 'give the container runtime more capacity, or lower environment.machine deliberately with whoever owns the product' },
    { id: 'env-schema', level: 'required', appliesTo: RUNTIME, codes: [C.ENV_SCHEMA_UNHEALTHY, C.ENV_SCHEMA_TOOL_MISSING],
        refusedBy: { command: 'preflight', code: C.ENV_SCHEMA_UNHEALTHY },
        needs: 'preflight validates a repository\'s .env.schema with Varlock, without reading a value, wherever the repository has one',
        fix: 'install Varlock, then make the environment satisfy the schema' },
    { id: 'guard-hosts', level: 'recommended', appliesTo: RUNTIME, codes: [C.GUARD_HOSTS_UNDECLARED],
        needs: 'the guard denies agent commands that reach a non-local database or vendor API only when cockpit.toml names its hosts',
        fix: 'list the hosts under [guards] in cockpit.toml, or write both lists empty to record that none exists' },
    { id: 'testing-gate', level: 'recommended', appliesTo: RUNTIME, codes: [C.TESTING_GATE_UNDECLARED],
        needs: 'test-run runs only the declared [testing] gates, and no work is graded PASS without one',
        fix: 'declare the product test commands as [testing] stages with a targeted and a full gate' },
    { id: 'secrets-untracked', level: 'recommended', appliesTo: BOTH, codes: [C.SECRET_FILE_TRACKED],
        needs: 'the guard keeps agents from reading secret files, but a committed one is in every clone already',
        fix: 'stop tracking the file, ignore it, rotate what it held, and commit a .env.example of the variable names' },
    { id: 'harness-path-absolute', level: 'recommended', appliesTo: BOTH, codes: [C.GUARD_SEARCH_PATH_RELATIVE],
        needs: 'the guard asks a person before every agent command while the PATH the agent harness runs with holds a relative entry, and Codex and OpenCode refuse what it asks about',
        fix: 'remove relative and empty entries from the PATH the agent harness starts with' },
    { id: 'codex-hook-trusted', level: 'recommended', appliesTo: BOTH, codes: [C.CODEX_HOOK_UNTRUSTED],
        needs: 'Codex runs the guard hook only once a person on this machine has trusted it',
        fix: 'a person trusts the hook from codex in a terminal in the cockpit root' },
    { id: 'work-evaluator', level: 'recommended', appliesTo: BOTH, codes: [C.EVALUATOR_UNAVAILABLE],
        needs: 'work review and work grade run the Codex CLI as the evaluator independent of the agent that did the work',
        fix: 'install the Codex CLI and sign in with codex login' },
]

export const READINESS_CATALOGUE: readonly ReadinessEntry[] = Object.freeze(entries.map((entry) => Object.freeze({
    ...entry, codes: Object.freeze([...entry.codes]),
    ...(entry.refusedBy ? { refusedBy: Object.freeze({ ...entry.refusedBy }) } : {}) })))

export interface ReadinessFinding {
    readonly code: string
    readonly severity: string
    readonly target?: string
    readonly message: string
    readonly fix: string
}

export interface ReadinessGap {
    readonly id: string
    readonly level: ReadinessEntry['level']
    readonly needs: string
    readonly findings: readonly ReadinessFinding[]
}

export interface ReadinessReport {
    /** Undetermined before init has classified the estate and while no cockpit.toml says. */
    readonly state: ReadinessState | 'undetermined'
    /** Prerequisites some reported diagnostic says are missing, in catalogue order. */
    readonly gaps: readonly ReadinessGap[]
    /** Catalogue ids that apply to this state and that no reported diagnostic named. */
    readonly noFinding: readonly string[]
}

type ReportedDiagnostic = Readonly<{ code: string; severity: string; message: string; target?: string; fix?: string }>

/** Groups the diagnostics a command reported under the prerequisites they name. */
export function readinessReport(state: ReadinessReport['state'], diagnostics: readonly ReportedDiagnostic[]): ReadinessReport {
    const gaps: ReadinessGap[] = []
    const noFinding: string[] = []
    for (const entry of READINESS_CATALOGUE) {
        const findings = diagnostics.filter(({ code }) => entry.codes.includes(code))
        if (findings.length > 0) {
            gaps.push(Object.freeze({ id: entry.id, level: entry.level, needs: entry.needs,
                findings: Object.freeze(findings.map(({ code, severity, target, message, fix }) => Object.freeze({
                    code, severity, ...(target === undefined ? {} : { target }), message, fix: fix ?? entry.fix }))) }))
        } else if (state === 'undetermined' ? entry.appliesTo.length === BOTH.length : entry.appliesTo.includes(state)) noFinding.push(entry.id)
    }
    return Object.freeze({ state, gaps: Object.freeze(gaps), noFinding: Object.freeze(noFinding) })
}
