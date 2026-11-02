import { realpathSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import {
    ENVIRONMENT_CODES,
    type EnvironmentCommandOutcome, type ExecutionPlan, type ExecutionStep, type FilesystemCheck,
    type Observation, type EnvironmentDiagnostic, type RefusalCode, type SetupActionKind,
} from './contract.js'
import type { Sibling } from '../schema.js'
import { resolvedGitExecutable, type ResolvedExecutable } from './executable.js'

export const mechanism = {
    id: 'setup-planning',
    module: 'packages/cockpit/src/environment/setup.ts',
    exports: ['planSetup', 'gitEnvironment'],
} as const

type ObservedPathKind = 'absent' | 'directory' | 'repository' | 'symlink'

export interface SetupPathEvidence {
    kind: ObservedPathKind
    missingParent?: string
    remotes?: Readonly<Record<string, string>>
    filesystemChecks?: readonly FilesystemCheck[]
}

export type SetupObservation = Observation<SetupPathEvidence>

export interface SetupResult {
    sibling: string
    target: string
    observed: ObservedPathKind
    action: SetupActionKind
    changed: boolean
}

interface PlanSetupBaseInput {
    siblingsRoot: string
    sibling: Sibling
    env: Readonly<Record<string, string>>
    gitExecutable: ResolvedExecutable
}

export type PlanSetupInput = PlanSetupBaseInput & (
    | { observation: SetupObservation; observe?: never }
    | {
          observation?: never
          observe(target: string, siblingsRoot: string, env: Readonly<Record<string, string>>, gitExecutable: ResolvedExecutable): Promise<SetupObservation>
      }
)

function refusal(code: RefusalCode, message: string, target: string): EnvironmentCommandOutcome<SetupResult> {
    return { kind: 'refusal', status: 2, diagnostics: [{ severity: 'error', code, message, target }], result: null }
}

const APPROVED_GIT_ENVIRONMENT = [
    'PATH', 'HOME', 'SSH_AUTH_SOCK', 'TMPDIR', 'LANG', 'LC_ALL',
] as const

const NONE_POSTURE = {
    absent: { code: ENVIRONMENT_CODES.SETUP_NONE_ABSENT, found: 'nothing exists there yet' },
    directory: { code: ENVIRONMENT_CODES.SETUP_NONE_DIRECTORY, found: 'it is a plain directory, not a Git checkout' },
    repository: { code: ENVIRONMENT_CODES.SETUP_NONE_REPOSITORY, found: 'it is an existing Git checkout' },
} as const satisfies Record<Exclude<ObservedPathKind, 'symlink'>, Readonly<{ code: string; found: string }>>

export function gitEnvironment(ambient: Readonly<Record<string, string | undefined>>): Readonly<Record<string, string>> {
    const approved: Record<string, string> = {}
    for (const name of APPROVED_GIT_ENVIRONMENT) {
        const value = ambient[name]
        if (value !== undefined) approved[name] = value
    }
    return Object.freeze({
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_SYSTEM: '/dev/null',
        GIT_TERMINAL_PROMPT: '0',
        ...approved,
    })
}

// Git stores a cloned local path as an absolute path, so a relative declaration is resolved against
// the siblings root (the directory clone runs in) before it is cloned and before it is compared with
// the observed origin. URLs, scp-like `host:path` (a colon before any slash) and option-like values
// are left exactly as declared.
export function resolveLocalRemote(remote: string, siblingsRoot: string): string {
    if (remote === '' || remote.startsWith('-') || isAbsolute(remote) || remote.startsWith('~')) return remote
    if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(remote)) return remote
    const colon = remote.indexOf(':')
    if (colon !== -1 && !remote.slice(0, colon).includes('/')) return remote
    const path = resolve(siblingsRoot, remote)
    try {
        return realpathSync(path)
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return path
        throw new Error(`cannot resolve local remote ${JSON.stringify(remote)} (${(error as NodeJS.ErrnoException).code ?? 'unknown error'})`, { cause: error })
    }
}

function fallbackChecks(
    observation: SetupPathEvidence,
    siblingsRoot: string,
    target: string,
): readonly FilesystemCheck[] {
    if (observation.kind === 'absent') {
        return [
            { path: siblingsRoot, expected: 'directory' },
            { path: target, expected: 'absent' },
        ]
    }
    if (observation.kind === 'repository') return [{ path: target, expected: 'directory' }]
    return []
}

function step(
    id: string,
    argv: readonly [string, ...string[]],
    cwd: string,
    env: Readonly<Record<string, string>>,
    target: string,
    filesystemChecks: readonly FilesystemCheck[],
    executable: ResolvedExecutable,
): ExecutionStep {
    return {
        id, argv, argv0: executable.invocationPath, cwd, env, timeoutMs: 120_000, stdoutLimitBytes: 65_536, stderrLimitBytes: 65_536,
        paths: [target], ports: [], labels: { operation: 'setup' },
        expected: [{ kind: 'path', target, state: 'repository' }],
        consumedFiles: [{ path: executable.canonicalPath, sha256: executable.sha256, maxBytes: 536_870_912, argvIndexes: [0], executable: true, executionMode: executable.executionMode }],
        filesystemChecks, compensation: [],
    }
}

function preview(
    result: SetupResult,
    mutation: ExecutionStep,
    diagnostics: readonly EnvironmentDiagnostic[] = [],
): EnvironmentCommandOutcome<SetupResult> {
    const plan: ExecutionPlan = { steps: [mutation] }
    return { kind: 'preview', status: 0, diagnostics, result, plan }
}

export async function planSetup(input: PlanSetupInput): Promise<EnvironmentCommandOutcome<SetupResult>> {
    const siblingsRoot = resolve(input.siblingsRoot)
    const target = resolve(siblingsRoot, input.sibling.dir)
    const fromRoot = relative(siblingsRoot, target)
    const gitExecutable = resolvedGitExecutable(input.gitExecutable)
    if (gitExecutable === undefined) {
        return refusal(ENVIRONMENT_CODES.SETUP_PATH_TYPE_INVALID, 'Git executable identity is unresolved', target)
    }
    const resolvedGitEnvironment = gitEnvironment(input.env)
    if (isAbsolute(input.sibling.dir) || fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
        return refusal(ENVIRONMENT_CODES.SETUP_PATH_OUTSIDE_ROOT, 'sibling target is outside the declared siblings root', target)
    }
    const observed = input.observation ?? await input.observe(target, siblingsRoot, resolvedGitEnvironment, gitExecutable)
    if (observed.state === 'failed') {
        return refusal(observed.code, observed.reason, target)
    }
    if (observed.state === 'unavailable') return refusal(ENVIRONMENT_CODES.SETUP_PATH_TYPE_INVALID, observed.reason, target)
    const observation = observed.value
    if (observation.kind === 'symlink') {
        return refusal(ENVIRONMENT_CODES.SETUP_PATH_SYMLINK, 'sibling target or one of its path components is a symlink', target)
    }

    const result = (action: SetupActionKind, changed: boolean): SetupResult => ({
        sibling: input.sibling.slug,
        target,
        observed: observation.kind,
        action,
        changed,
    })
    if (input.sibling.acquire === 'none') {
        return {
            kind: 'complete',
            status: 0,
            diagnostics: [{
                severity: 'info',
                code: NONE_POSTURE[observation.kind].code,
                message: `acquire = "none", so setup leaves this path alone: ${NONE_POSTURE[observation.kind].found}`,
                target,
            }],
            result: result('report', false),
        }
    }

    const remote = resolveLocalRemote(input.sibling.remote!, siblingsRoot)
    if (observation.kind === 'absent') {
        if (input.sibling.acquire === 'manual') {
            return {
                kind: 'complete',
                status: 0,
                diagnostics: [{
                    severity: 'warning',
                    code: ENVIRONMENT_CODES.SETUP_MANUAL_MISSING,
                    message: 'manual checkout is absent',
                    target,
                    fix: 'create the checkout, then run npx --no cockpit setup --config <your cockpit.toml> again',
                }],
                result: result('report', false),
            }
        }
        if (observation.missingParent) {
            return refusal(
                ENVIRONMENT_CODES.SETUP_PARENT_MISSING,
                'automatic checkout parent directory is absent',
                observation.missingParent,
            )
        }
        const branch = input.sibling.branch ? (['--branch', input.sibling.branch] as const) : []
        const checks = observation.filesystemChecks ?? fallbackChecks(observation, siblingsRoot, target)
        return preview(
            result('clone', true),
            step(
                `setup:${input.sibling.slug}:clone`,
                [gitExecutable.canonicalPath, 'clone', ...branch, '--', remote, target],
                siblingsRoot,
                resolvedGitEnvironment,
                target,
                checks,
                gitExecutable,
            ),
        )
    }
    if (observation.kind !== 'repository') {
        return refusal(ENVIRONMENT_CODES.SETUP_PATH_TYPE_INVALID, 'repository acquisition target exists but is not a repository', target)
    }

    const observedOrigin = observation.remotes?.origin
    const current = observedOrigin === undefined ? undefined : resolveLocalRemote(observedOrigin, siblingsRoot)
    if (current === remote) return { kind: 'complete', status: 0, diagnostics: [], result: result('report', false) }
    if (input.sibling.acquire === 'auto') {
        return refusal(
            ENVIRONMENT_CODES.SETUP_REMOTE_MISMATCH,
            current === undefined
                ? 'existing automatic checkout has no origin remote'
                : 'existing automatic checkout has a different origin remote',
            target,
        )
    }
    const verb = current === undefined ? 'add' : 'set-url'
    const checks = observation.filesystemChecks ?? fallbackChecks(observation, siblingsRoot, target)
    return preview(
        result('wire-remote', true),
        step(
            `setup:${input.sibling.slug}:remote-${verb}`,
            [gitExecutable.canonicalPath, '-C', target, 'remote', verb, '--', 'origin', remote],
            siblingsRoot,
            resolvedGitEnvironment,
            target,
            checks,
            gitExecutable,
        ),
    )
}
