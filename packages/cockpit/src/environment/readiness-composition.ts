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
import { ENVIRONMENT_CODES, snapshotExecutionStep, type EnvironmentDiagnostic, type ExecutionStep } from './contract.js'
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
        if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return false
        throw error
    }
}

export async function inspectProjectReadiness(
    input: ProjectReadinessInput,
    execute: (step: ExecutionStep) => Promise<ExecuteProbeOutcome>,
): Promise<readonly EnvironmentDiagnostic[]> {
    const findings: EnvironmentDiagnostic[] = input.configPath === undefined ? [] : [...await inspectTeamReadiness(input.configPath)]
    const git = await resolveGitExecutable(input.env)
    if (git.state !== 'available') return Object.freeze(findings)
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
        if (!step) throw new TypeError('the cockpit root Git probe could not be planned')
        const outcome = authenticatedExecutionOutcome(await execute(step), step)
        if (!outcome) throw new TypeError('the cockpit root Git probe returned unauthenticated evidence')
        // Git exits non-zero outside a working tree; any other refusal is a probe that did not run.
        if (outcome.kind === 'refusal' && outcome.code !== ENVIRONMENT_CODES.EXECUTION_STEP_FAILED) {
            throw new TypeError(`the cockpit root Git probe did not run (${outcome.code})`)
        }
        if (outcome.kind === 'refusal') findings.push(Object.freeze({
            severity: 'warning' as const,
            // A literal, so the diagnostic inventory captures the fix beside the code.
            code: 'SETUP_PATH_TYPE_INVALID' satisfies typeof ENVIRONMENT_CODES.SETUP_PATH_TYPE_INVALID,
            message: `${input.root} is not inside a Git working tree, so setup will refuse to run there and no teammate can clone this cockpit`,
            target: input.root,
            fix: `run git -C ${input.root} init, then commit the cockpit files once a person has reviewed them`,
        }))
    }
    let repositories = input.repositories ?? []
    if (input.configPath !== undefined) {
        const loaded = await loadCockpitConfig(input.configPath)
        if (loaded.kind !== 'complete') return Object.freeze(findings)
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
