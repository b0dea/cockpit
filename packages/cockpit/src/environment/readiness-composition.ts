// Binds the readiness probes no health row covers to the production executor, for doctor and for
// init: whether the cockpit root is a Git working tree before any cockpit.toml exists, the cockpit's
// own install and recorded sibling remotes, secret files a repository commits, missing schemas,
// and root instruction files that leave some agent tool without a repository's instructions.
// Schema discovery reads directory entries only; other probes come from their existing owners.
import { lstat, opendir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { loadCockpitConfig } from '../config/load.js'
import type { ExecuteProbeOutcome } from '../environment-exec/execute.js'
import { authenticatedExecutionOutcome } from '../environment-exec/execute.js'
import { inspectTeamReadiness } from '../team-metadata.js'
import { guardSearchPathRelativeEntry } from '../guards/protected-locations.js'
import { DOCKER_CLIENT_ENVIRONMENT, ENVIRONMENT_CODES, snapshotExecutionStep, type EnvironmentDiagnostic, type ExecutionStep, RefusalError, isMissing, errorCause } from './contract.js'
import { resolveDiskCapacityExecutable, resolveDockerExecutable, resolveGitExecutable } from './executable.js'
import { measureMachineFloor } from './runtime.js'
import { gitRepositoryRefusal, inspectTrackedSecretFiles } from './git-observation.js'
import { declaresNothingToRun } from './declaration.js'
import { inspectSiblingInstructions } from './sibling-instructions.js'
import { DEFAULT_SURFACE_TOOLS } from '../surfaces/harness-registry.js'
import type { ReadinessReport } from '../readiness.js'
import { STRUCTURED_INPUT_ENTRY_LIMIT } from '../schema.js'

interface ProjectReadinessInput {
    /** The cockpit root, where cockpit.toml is or will be written. */
    readonly root: string
    /** Present once cockpit.toml exists; its siblings are the repositories asked. */
    readonly configPath?: string
    /** Repositories observed before cockpit.toml exists. */
    readonly repositories?: readonly Readonly<{ slug: string; root: string; templates?: readonly string[] }>[]
    /** Doctor already names a cockpit root outside Git through its checkout observation. */
    readonly checkRoot: boolean
    readonly env: Readonly<Record<string, string | undefined>>
    /** Doctor observes Git with a separate PATH; warnings still describe the caller's environment. */
    readonly observationEnv?: Readonly<Record<string, string | undefined>>
    readonly timeoutMs: number
    /** The agent tools init was asked to set up, before cockpit.toml records them. */
    readonly tools?: readonly string[]
}

type LoadedConfigResult = Awaited<ReturnType<typeof loadCockpitConfig>>

async function isDirectory(path: string): Promise<boolean> {
    try { return (await lstat(path)).isDirectory() } catch (error) {
        if (isMissing(error)) return false
        throw error
    }
}

export async function inspectProjectReadiness(
    input: ProjectReadinessInput,
    execute: (step: ExecutionStep) => Promise<ExecuteProbeOutcome>,
    // A caller that already loaded cockpit.toml hands the result over rather than reading it again.
    preloaded?: LoadedConfigResult,
): Promise<readonly EnvironmentDiagnostic[]> {
    // A cockpit.toml that does not load is the finding; its own refusal says what to fix first.
    const loaded = preloaded ?? (input.configPath === undefined ? undefined : await loadCockpitConfig(input.configPath))
    if (loaded && loaded.kind !== 'complete') return []
    const findings: EnvironmentDiagnostic[] = input.configPath === undefined ? [] : [...await inspectTeamReadiness(input.configPath)]
    const tools: readonly string[] = loaded?.kind === 'complete' ? loaded.result.config.surfaces.tools : input.tools ?? DEFAULT_SURFACE_TOOLS
    const refusers = ['codexcli', 'opencode'].filter(tool => tools.includes(tool)).map(tool => tool === 'codexcli' ? 'Codex' : 'OpenCode')
    // A package manager may have changed this process's PATH; it is not evidence of the harness's PATH.
    const relativeEntry = guardSearchPathRelativeEntry(input.env.PATH ?? '')
    if (input.configPath !== undefined && relativeEntry !== null) findings.push({
        severity: 'warning' as const,
        // A literal, so the diagnostic inventory captures the fix beside the code.
        code: 'GUARD_SEARCH_PATH_RELATIVE' satisfies typeof ENVIRONMENT_CODES.GUARD_SEARCH_PATH_RELATIVE,
        message: `This CLI process's PATH holds the relative entry ${JSON.stringify(relativeEntry)}${relativeEntry === '' ? ' (an empty entry is the working directory)' : ''}; a package manager may have added it, so this does not establish the running harness's PATH. An agent harness started with this PATH gets a guard that asks before every command, because a file the agent wrote could run in place of the command${refusers.length > 0 ? `, and ${refusers.join(' and ')} refuse${refusers.length === 1 ? 's' : ''} what it asks about` : ''}`,
        target: 'PATH',
        fix: 'check PATH in the shell or launcher that starts the agent harness; if it contains relative or empty entries, remove them there and restart the harness',
    })
    let repositories = input.repositories ?? []
    if (loaded?.kind === 'complete') {
        const siblingRoot = resolve(dirname(loaded.result.source.path), loaded.result.config.cockpit.siblings_root)
        repositories = loaded.result.config.sibling.map((sibling) => ({ slug: sibling.slug, root: resolve(siblingRoot, sibling.dir),
            templates: (sibling.environment_files ?? []).map(({ template }) => template) }))
    }
    // Only an existing directory has files to ask about; an absent one is reported as missing elsewhere.
    const present = []
    for (const repository of repositories) if (await isDirectory(repository.root)) present.push(repository)
    const schemaRoots = new Set<string>()
    if (await isDirectory(input.root)) schemaRoots.add(resolve(input.root))
    for (const repository of present) schemaRoots.add(resolve(repository.root))
    for (const root of schemaRoots) {
        // Names and types reveal adoption without opening a dotenv file or following its links.
        let entries = 0
        let hasSchema = false
        let hasEnvironmentFile = false
        try {
            for await (const entry of await opendir(root)) {
                if (++entries > STRUCTURED_INPUT_ENTRY_LIMIT) break
                if (!entry.isFile() && !entry.isSymbolicLink()) continue
                if (entry.name === '.env.schema') hasSchema = true
                if (entry.name === '.env' || entry.name.startsWith('.env.') || entry.name === 'env.template') hasEnvironmentFile = true
            }
        } catch (error) {
            findings.push({
                severity: 'warning', code: ENVIRONMENT_CODES.EVIDENCE_UNAVAILABLE, target: root,
                message: `schema adoption could not be checked from root file metadata: ${errorCause(error)}`,
                fix: 'restore access to list this directory, then rerun this command',
            })
            continue
        }
        if (entries > STRUCTURED_INPUT_ENTRY_LIMIT) {
            findings.push({
                severity: 'warning', code: ENVIRONMENT_CODES.EVIDENCE_UNAVAILABLE, target: root,
                message: `schema adoption could not be checked because this directory exceeds the root entry limit of ${STRUCTURED_INPUT_ENTRY_LIMIT}`,
                fix: 'ask a person to review schema adoption in this directory; the metadata scan stopped before completing its listing',
            })
            continue
        }
        if (hasSchema || !hasEnvironmentFile) continue
        findings.push({
            severity: 'warning',
            code: 'ENV_SCHEMA_UNDECLARED',
            message: `${root} has a dotenv or environment template file but no .env.schema, so required variables and their validation rules are not declared for Varlock`,
            target: root,
            fix: 'consider adopting Varlock: install it if needed, then ask a person to run VARLOCK_TELEMETRY_DISABLED=true varlock init in this directory and review .env.schema without copying secret values into it',
        })
    }
    // The cockpit root's own AGENTS.md and CLAUDE.md are generated by sync.
    for (const repository of present) if (resolve(repository.root) !== resolve(input.root)) findings.push(...await inspectSiblingInstructions(repository, tools))
    const git = await resolveGitExecutable(input.observationEnv ?? input.env)
    if (git.state !== 'available') {
        // Without Git, the root and secret checks did not run; their absence from the report is no finding.
        findings.push({
            severity: 'warning' as const,
            code: ENVIRONMENT_CODES.EVIDENCE_UNAVAILABLE,
            message: `the readiness checks that ask Git (the cockpit root's working tree, committed secret files) did not run: ${git.reason}`,
            target: 'git',
            fix: 'install Git and put it on PATH, then rerun this command',
        })
        return findings
    }
    // A greenfield root init writes into in place stays outside Git until someone runs git init, and
    // setup refuses it only later; init reached its final stage without saying so.
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
        // Git exits non-zero outside a working tree and in one it refuses to read; any other refusal is a
        // probe that did not run.
        if (outcome.kind === 'refusal' && outcome.code !== ENVIRONMENT_CODES.EXECUTION_STEP_FAILED) {
            throw new RefusalError(`the cockpit root Git probe did not run (${outcome.code})`)
        }
        const refused = outcome.kind === 'refusal' ? gitRepositoryRefusal(outcome.stderr) : undefined
        if (refused?.kind === 'not-a-repository') findings.push({
            severity: 'warning' as const,
            code: ENVIRONMENT_CODES.SETUP_PATH_TYPE_INVALID,
            message: `${input.root} is not inside a Git working tree, so setup will refuse to run there and no teammate can clone this cockpit`,
            target: input.root,
            fix: `run git -C ${input.root} init, then commit the cockpit files once a person has reviewed them`,
        })
        if (refused?.kind === 'refused') findings.push({
            severity: 'warning' as const,
            code: ENVIRONMENT_CODES.EVIDENCE_UNAVAILABLE,
            message: `whether ${input.root} is inside a Git working tree could not be checked: ${refused.reason}`,
            target: input.root,
            fix: refused.fix,
        })
    }
    findings.push(...await inspectTrackedSecretFiles({ executable: git.value, repositories: present, timeoutMs: input.timeoutMs }, execute))
    return findings
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
    const loaded = input.configPath === undefined ? undefined : await loadCockpitConfig(input.configPath)
    const findings = await inspectProjectReadiness({ ...probe, env: binding.env, timeoutMs: binding.timeoutMs }, binding.execute, loaded)
    const state: ReadinessReport['state'] = loaded?.kind === 'complete'
        ? declaresNothingToRun(loaded.result.config.environment) ? 'surfaces-only' : 'runtime'
        : classification === undefined ? 'undetermined' : classification === 'no-runnable-product' ? 'surfaces-only' : 'runtime'
    return { state, findings }
}

/**
 * What the container runtime on this machine offers, measured by the same collector preflight
 * compares the machine floor with, so init can propose a floor where no Compose limit records one.
 */
export async function measureInitMachine(
    input: Readonly<{ root: string }>,
    binding: Readonly<{ env: ProjectReadinessInput['env']; timeoutMs: number; execute: (step: ExecutionStep) => Promise<ExecuteProbeOutcome> }>,
): Promise<Readonly<{ kind: 'complete'; memoryMb: number; cpus: number; observedAt: string }> | Readonly<{ kind: 'unavailable'; reason: string }>> {
    const [docker, disk] = await Promise.all([resolveDockerExecutable(binding.env), resolveDiskCapacityExecutable()])
    if (docker.state !== 'available') return { kind: 'unavailable', reason: docker.reason }
    if (disk.state !== 'available') return { kind: 'unavailable', reason: disk.reason }
    const env = Object.fromEntries(Object.entries(binding.env)
        .filter((entry): entry is [string, string] => DOCKER_CLIENT_ENVIRONMENT.has(entry[0]) && typeof entry[1] === 'string'))
    const measured = await measureMachineFloor({ runtimeExecutable: docker.value, diskExecutable: disk.value, cwd: input.root,
        env, timeoutMs: binding.timeoutMs }, binding.execute)
    if (measured.kind !== 'complete') return { kind: 'unavailable', reason: measured.kind === 'refusal'
        ? measured.diagnostics.map(row => row.message).join('; ') : 'docker info did not report the runtime\'s memory and CPUs' }
    return { kind: 'complete', memoryMb: Math.floor(measured.evidence.memoryBytes / 1024 ** 2),
        cpus: measured.evidence.cpuMillis / 1_000, observedAt: measured.evidence.observedAt }
}
