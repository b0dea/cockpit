// Binds the readiness probes no health row covers to the production executor, for doctor and for
// init: whether the cockpit root is a Git working tree before any cockpit.toml exists, the cockpit's
// own install and recorded sibling remotes, and secret files a repository commits. Each finding
// comes from its owner; this module only chooses which repositories to ask.
import { lstat } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { loadCockpitConfig } from '../config/load.js'
import type { ExecuteProbeOutcome } from '../environment-exec/execute.js'
import { authenticatedExecutionOutcome } from '../environment-exec/execute.js'
import { inspectTeamReadiness } from '../team-metadata.js'
import { guardSearchPathRelativeEntry } from '../guards/protected-locations.js'
import { ENVIRONMENT_CODES, snapshotExecutionStep, type EnvironmentDiagnostic, type ExecutionStep, RefusalError, isMissing } from './contract.js'
import { resolveGitExecutable } from './executable.js'
import { inspectTrackedSecretFiles } from './git-observation.js'
import { declaresNothingToRun } from './declaration.js'
import type { ReadinessReport } from '../readiness.js'

export const mechanism = {
    id: 'readiness-composition',
    module: 'packages/cockpit/src/environment/readiness-composition.ts',
    exports: ['inspectProjectReadiness', 'inspectInitReadiness'],
} as const

export interface ProjectReadinessInput {
    /** The cockpit root, where cockpit.toml is or will be written. */
    readonly root: string
    /** Present once cockpit.toml exists; its siblings are the repositories asked. */
    readonly configPath?: string
    /** Repositories observed before cockpit.toml exists. */
    readonly repositories?: readonly Readonly<{ slug: string; root: string }>[]
    /** Doctor already names a cockpit root outside Git through its checkout observation. */
    readonly checkRoot: boolean
    readonly env: Readonly<Record<string, string | undefined>>
    readonly timeoutMs: number
}

async function isDirectory(path: string): Promise<boolean> {
    try { return (await lstat(path)).isDirectory() } catch (error) {
        if (isMissing(error)) return false
        throw error
    }
}

export async function inspectProjectReadiness(
    input: ProjectReadinessInput,
    execute: (step: ExecutionStep) => Promise<ExecuteProbeOutcome>,
): Promise<readonly EnvironmentDiagnostic[]> {
    // A cockpit.toml that does not load is the finding; its own refusal says what to fix first.
    const loaded = input.configPath === undefined ? undefined : await loadCockpitConfig(input.configPath)
    if (loaded && loaded.kind !== 'complete') return Object.freeze([])
    const findings: EnvironmentDiagnostic[] = input.configPath === undefined ? [] : [...await inspectTeamReadiness(input.configPath)]
    // The guard reads the PATH its hook inherits from the harness, which is started from a shell like
    // this one; while that PATH holds a relative entry it asks before every command.
    const relativeEntry = guardSearchPathRelativeEntry(input.env.PATH ?? '')
    if (input.configPath !== undefined && relativeEntry !== null) findings.push(Object.freeze({
        severity: 'warning' as const,
        // A literal, so the diagnostic inventory captures the fix beside the code.
        code: 'GUARD_SEARCH_PATH_RELATIVE' satisfies typeof ENVIRONMENT_CODES.GUARD_SEARCH_PATH_RELATIVE,
        message: `PATH holds the relative entry ${JSON.stringify(relativeEntry)}${relativeEntry === '' ? ' (an empty entry is the working directory)' : ''}; an agent harness started with this PATH gets a guard that asks before every command, because a file the agent wrote could run in place of the command, and Codex and OpenCode refuse what it asks about`,
        target: 'PATH',
        fix: 'remove every relative or empty entry from PATH where the shell profile or launcher that starts the agent harness sets it, then restart the harness',
    }))
    const git = await resolveGitExecutable(input.env)
    if (git.state !== 'available') {
        // Without Git, the root and secret checks did not run; their absence from the report is no finding.
        findings.push(Object.freeze({
            severity: 'warning' as const,
            code: ENVIRONMENT_CODES.EVIDENCE_UNAVAILABLE,
            message: `the readiness checks that ask Git (the cockpit root's working tree, committed secret files) did not run: ${git.reason}`,
            target: 'git',
            fix: 'install Git and put it on PATH, then rerun this command',
        }))
        return Object.freeze(findings)
    }
    // A greenfield root init writes into in place stays outside Git until someone runs git init, and
    // setup refuses it only later; init reached environment-verified without saying so.
    if (input.checkRoot && await isDirectory(input.root)) {
        const step = snapshotExecutionStep({
            id: 'git:readiness-working-tree', argv: [git.value.canonicalPath, '-C', input.root, 'rev-parse', '--show-toplevel'],
            argv0: git.value.invocationPath, cwd: input.root, env: {}, timeoutMs: input.timeoutMs,
            stdoutLimitBytes: 4_096, stderrLimitBytes: 4_096, paths: [input.root], ports: [], labels: { source: input.root },
            expected: [], consumedFiles: [{ path: git.value.canonicalPath, sha256: git.value.sha256, maxBytes: 536_870_912,
                argvIndexes: [0], executable: true, executionMode: git.value.executionMode }],
            filesystemChecks: [], compensation: [],
        })
        if (!step) throw new RefusalError('the cockpit root Git probe could not be planned')
        const outcome = authenticatedExecutionOutcome(await execute(step), step)
        if (!outcome) throw new RefusalError('the cockpit root Git probe returned unauthenticated evidence')
        // Git exits non-zero outside a working tree; any other refusal is a probe that did not run.
        if (outcome.kind === 'refusal' && outcome.code !== ENVIRONMENT_CODES.EXECUTION_STEP_FAILED) {
            throw new RefusalError(`the cockpit root Git probe did not run (${outcome.code})`)
        }
        if (outcome.kind === 'refusal') findings.push(Object.freeze({
            severity: 'warning' as const,
            code: ENVIRONMENT_CODES.SETUP_PATH_TYPE_INVALID,
            message: `${input.root} is not inside a Git working tree, so setup will refuse to run there and no teammate can clone this cockpit`,
            target: input.root,
            fix: `run git -C ${input.root} init, then commit the cockpit files once a person has reviewed them`,
        }))
    }
    let repositories = input.repositories ?? []
    if (loaded?.kind === 'complete') {
        const siblingRoot = resolve(dirname(loaded.result.source.path), loaded.result.config.cockpit.siblings_root)
        repositories = loaded.result.config.sibling.map((sibling) => ({ slug: sibling.slug, root: resolve(siblingRoot, sibling.dir) }))
    }
    // Only an existing directory has an index to ask; an absent one is reported as missing elsewhere.
    const present = []
    for (const repository of repositories) if (await isDirectory(repository.root)) present.push(repository)
    findings.push(...await inspectTrackedSecretFiles({ executable: git.value, repositories: present, timeoutMs: input.timeoutMs }, execute))
    return Object.freeze(findings)
}

/**
 * init's readiness probes. Before cockpit.toml exists, whether a runtime will be declared is read
 * from the estate classification: an estate with no runnable product gets a surfaces-only cockpit.
 */
export async function inspectInitReadiness(
    input: Omit<ProjectReadinessInput, 'env' | 'timeoutMs'> & Readonly<{ classification?: string }>,
    binding: Readonly<{ env: ProjectReadinessInput['env']; timeoutMs: number; execute: (step: ExecutionStep) => Promise<ExecuteProbeOutcome> }>,
): Promise<Readonly<{ state: ReadinessReport['state']; findings: readonly EnvironmentDiagnostic[] }>> {
    const { classification, ...probe } = input
    const findings = await inspectProjectReadiness({ ...probe, env: binding.env, timeoutMs: binding.timeoutMs }, binding.execute)
    const loaded = input.configPath === undefined ? undefined : await loadCockpitConfig(input.configPath)
    const state: ReadinessReport['state'] = loaded?.kind === 'complete'
        ? declaresNothingToRun(loaded.result.config.environment) ? 'surfaces-only' : 'runtime'
        : classification === undefined ? 'undetermined' : classification === 'no-runnable-product' ? 'surfaces-only' : 'runtime'
    return Object.freeze({ state, findings })
}
