/**
 * Sequences the commands that choose and refresh the checkouts a stack serves: `use` points a
 * sibling at another checkout of its repository for this cockpit checkout, `pull` fast-forwards
 * every checkout to its upstream, and doctor and preflight read the findings both leave behind.
 * The decisions live in `sibling-checkouts.ts`, `sibling-pull.ts` and `stack-inputs.ts`.
 */
import { realpath } from 'node:fs/promises'
import { dirname, sep } from 'node:path'
import type { ExecuteProbeOutcome } from '../../environment-exec/execute.js'
import { loadCockpitConfig } from '../../config/load.js'
import { cockpitCommand } from '../../fix-catalogue.js'
import { refusalOutcome } from '../../refusal.js'
import { ENVIRONMENT_CODES, errorCause, type Diagnostic, type EnvironmentDiagnostic, type ExecutionStep } from '../contract.js'
import {
    createGitRunner, inspectSiblingCheckout, loadServedSiblings, missingEnvironmentFileDiagnostics, missingEnvironmentFiles,
    readSiblingCheckouts, SIBLING_CHECKOUTS_PATH, servedSiblings, vanishedServedCheckouts, writeSiblingCheckouts, type GitRunner,
} from '../sibling-checkouts.js'
import { fastForwardCheckout, type PullRow } from '../sibling-pull.js'
import { mapLimit } from '../map-limit.js'
import type { LoadedCockpitConfigResult } from './health.js'
import { staleStackDiagnostics } from '../stack-inputs.js'

type Execute = (step: ExecutionStep) => Promise<ExecuteProbeOutcome>

export interface SiblingCommandOutcome {
    readonly status: number
    readonly diagnostics: readonly Diagnostic[]
    readonly result: unknown
    readonly artifact?: string | null
    readonly destination?: null
}

export interface UseCommandInput {
    readonly configPath: string
    readonly slug: string
    /** Absolute; absent with `clear`. */
    readonly checkout?: string
    readonly clear: boolean
    readonly env: Readonly<Record<string, string | undefined>>
}

function inside(path: string, root: string): boolean {
    return path === root || path.startsWith(`${root}${sep}`)
}

async function gitOrRefusal(env: UseCommandInput['env'], execute: Execute): Promise<GitRunner | SiblingCommandOutcome> {
    const git = await createGitRunner(env, execute)
    return 'unavailable' in git
        ? refusalOutcome(ENVIRONMENT_CODES.EVIDENCE_UNAVAILABLE, `Git is needed to read the checkouts and is unavailable: ${git.unavailable}`, 'git',
            'install Git and put it on PATH, then rerun this command')
        : git
}

export async function runUse(input: UseCommandInput, dependencies: Readonly<{ execute: Execute }>): Promise<SiblingCommandOutcome> {
    const loaded = await loadCockpitConfig(input.configPath)
    if (loaded.kind !== 'complete') return { status: 2, result: null, diagnostics: loaded.diagnostics }
    const configPath = loaded.result.source.path
    const config = loaded.result.config
    const root = dirname(configPath)
    const recorded = await readSiblingCheckouts(root)
    if (recorded.kind !== 'complete') return { status: 2, result: null, diagnostics: [recorded.diagnostic] }
    const sibling = config.sibling.find(row => row.slug === input.slug)
    // A sibling removed from cockpit.toml can still be forgotten, or doctor would name it forever.
    if (!sibling && input.clear && Object.hasOwn(recorded.checkouts, input.slug)) {
        const { [input.slug]: forgotten, ...others } = recorded.checkouts
        const written = await writeSiblingCheckouts(root, others)
        if (written.kind !== 'complete') return recordUnwritable(configPath, root, written.message)
        return { status: 0, diagnostics: [], destination: null, artifact: `Forgot the checkout recorded for ${input.slug}, which cockpit.toml no longer declares.\n`,
            result: { slug: input.slug, overridden: false, previous: forgotten } }
    }
    if (!sibling) {
        return refusalOutcome(ENVIRONMENT_CODES.SIBLING_CHECKOUT_UNKNOWN,
            `cockpit.toml declares no sibling ${input.slug}; it declares ${config.sibling.map(row => row.slug).join(', ')}`, input.slug,
            `name a declared sibling, or declare this one with ${cockpitCommand('sibling add', { operand: input.slug, config: configPath })}`)
    }
    const declaredPath = servedSiblings(root, config, {}).get(sibling.slug)!.declared
    // Compared with a resolved candidate, so a siblings root reached through a link still matches.
    const declared = await realpath(declaredPath).catch(() => declaredPath)
    const previous = recorded.checkouts[sibling.slug]
    let served = declared
    let evidence: 'object-store' | 'remote' | undefined
    if (!input.clear) {
        const git = await gitOrRefusal(input.env, dependencies.execute)
        if ('status' in git) return git
        const inspected = await inspectSiblingCheckout({ sibling, declared, candidate: input.checkout!, git })
        if (inspected.kind === 'refusal') return { status: 2, result: null, diagnostics: [inspected.diagnostic] }
        served = inspected.directory
        evidence = inspected.evidence
    }
    const { [sibling.slug]: _cleared, ...others } = recorded.checkouts
    // Naming the declared checkout is the same as clearing: it is what serves the sibling by default.
    const checkouts = served === declared ? others : { ...others, [sibling.slug]: served }
    const written = previous === checkouts[sibling.slug] ? { kind: 'complete' as const } : await writeSiblingCheckouts(root, checkouts)
    if (written.kind !== 'complete') return recordUnwritable(configPath, root, written.message)
    const current = servedSiblings(root, config, checkouts)
    const entry = current.get(sibling.slug)!
    const diagnostics = [
        ...missingEnvironmentFileDiagnostics(entry, entry.overridden ? await missingEnvironmentFiles(entry, sibling) : []),
        // A running stack keeps the checkout it mounted until it is brought down and up again.
        ...await staleStackDiagnostics(root, current),
    ]
    const covered = inside(served, declared)
    const artifact = [
        entry.overridden ? `Sibling ${sibling.slug} is now served from ${served} (${evidence === 'object-store' ? 'a worktree of' : 'a clone with the same origin as'} ${declared}).`
            : `Sibling ${sibling.slug} is served from its declared checkout ${declared}${previous === undefined ? '' : ` again, no longer from ${previous}`}.`,
        `Recorded for this cockpit checkout only, in ${SIBLING_CHECKOUTS_PATH}; up, the guard, doctor and preflight read it.`,
        ...(entry.overridden && !covered ? [`${served} lies outside ${declared}, so the directory grants sync wrote for agent tools do not reach it and a tool may ask before editing there; a worktree inside the declared checkout avoids that.`] : []),
        '',
    ].join('\n')
    return { status: 0, diagnostics, destination: null, artifact,
        result: { slug: sibling.slug, declared, served, overridden: entry.overridden, ...(evidence ? { evidence } : {}),
            ...(previous === undefined ? {} : { previous }), insideDeclared: covered } }
}

function recordUnwritable(configPath: string, root: string, reason: string): SiblingCommandOutcome {
    return refusalOutcome(ENVIRONMENT_CODES.SIBLING_CHECKOUT_RECORD_INVALID, `the sibling checkout record could not be written: ${reason}`,
        SIBLING_CHECKOUTS_PATH, `run ${cockpitCommand('sync', { config: configPath })} first if ${root}/.cockpit does not exist yet, or make it a plain directory you can write; then run this command again`)
}

export interface PullCommandInput {
    readonly configPath: string
    readonly env: Readonly<Record<string, string | undefined>>
}

const PULL_CONCURRENCY = 4

type PullTarget = Readonly<{ label: string; path: string; expected: boolean }>

export async function runPull(input: PullCommandInput, dependencies: Readonly<{ execute: Execute }>): Promise<SiblingCommandOutcome> {
    const loaded = await loadCockpitConfig(input.configPath)
    if (loaded.kind !== 'complete') return { status: 2, result: null, diagnostics: loaded.diagnostics }
    const config = loaded.result.config
    const root = dirname(loaded.result.source.path)
    const served = await loadServedSiblings(root, config)
    if (served.kind !== 'complete') return { status: 2, result: null, diagnostics: [served.diagnostic] }
    const git = await gitOrRefusal(input.env, dependencies.execute)
    if ('status' in git) return git
    // The cockpit root first, then each sibling's declared checkout and any checkout `use` put in its
    // place. A sibling that is not a repository (acquire = "none") is expected to have no Git history,
    // and a cockpit root outside Git is doctor's readiness finding, not pull's.
    const targets: PullTarget[] = [{ label: 'cockpit', path: root, expected: false }]
    for (const sibling of config.sibling) {
        const entry = served.siblings.get(sibling.slug)!
        targets.push({ label: sibling.slug, path: entry.declared, expected: sibling.acquire !== 'none' })
        if (entry.overridden) targets.push({ label: `${sibling.slug} (served)`, path: entry.served, expected: true })
    }
    const located = await Promise.all(targets.map(async target => {
        const output = await git.run(target.path, 'pull:root', ['rev-parse', '--show-toplevel'])
        return output.kind === 'complete' ? await realpath(output.stdout).catch(() => undefined) : undefined
    }))
    // Two targets in one repository (an in-repo cockpit is its own sibling) move once, under the first one's label.
    const distinct = new Map<string, PullTarget>()
    located.forEach((toplevel, index) => { if (toplevel !== undefined && !distinct.has(toplevel)) distinct.set(toplevel, targets[index]!) })
    const advanced = new Map(await mapLimit([...distinct], PULL_CONCURRENCY, async ([toplevel, target]) =>
        [toplevel, { label: target.label, ...await fastForwardCheckout(git, toplevel) }] as const))
    const rows: (PullRow & { readonly label: string })[] = []
    const diagnostics: EnvironmentDiagnostic[] = []
    const reported = new Set<string>()
    located.forEach((toplevel, index) => {
        const target = targets[index]!
        if (toplevel === undefined) {
            const row = { label: target.label, state: 'skipped' as const, path: target.path, reason: 'there is no Git checkout there',
                fix: `run ${cockpitCommand('setup', { config: loaded.result.source.path })} to clone it`, blocked: target.expected }
            rows.push(row)
            if (row.blocked) diagnostics.push(skippedDiagnostic(row))
            return
        }
        if (reported.has(toplevel)) return
        reported.add(toplevel)
        const row = advanced.get(toplevel)!
        rows.push(row)
        if (row.state === 'skipped' && row.blocked) diagnostics.push(skippedDiagnostic(row))
    })
    // A pulled lockfile or migration behind a running stack is the next thing to go wrong.
    if (rows.some(row => row.state === 'advanced')) diagnostics.push(...await staleStackDiagnostics(root, served.siblings))
    const line = (row: (typeof rows)[number]) => row.state === 'advanced'
        ? `${row.label}: ${row.branch} fast-forwarded ${row.from.slice(0, 12)} -> ${row.to.slice(0, 12)} (${row.commits} commit${row.commits === 1 ? '' : 's'} from ${row.upstream})`
        : row.state === 'current' ? `${row.label}: ${row.branch} is up to date with ${row.upstream}${row.ahead > 0 ? ` (${row.ahead} ahead)` : ''}`
        : `${row.label}: skipped, ${row.reason}`
    return { status: 0, diagnostics, destination: null, artifact: `${rows.map(line).join('\n')}\n`, result: { repositories: rows } }
}

function skippedDiagnostic(row: Extract<PullRow, { state: 'skipped' }> & { readonly label: string }): EnvironmentDiagnostic {
    return {
        severity: 'warning',
        code: 'PULL_SKIPPED' satisfies typeof ENVIRONMENT_CODES.PULL_SKIPPED,
        message: `${row.label} at ${row.path} was left as it was: ${row.reason}`,
        target: row.path,
        fix: row.fix,
    }
}

/**
 * What doctor and preflight report about the served checkouts: each override and where it came
 * from, an override that no longer names a checkout of its sibling, the environment files a worktree
 * lacks, and a running stack whose siblings' dependencies or migrations moved since it came up.
 */
export async function inspectServedSiblings(input: Readonly<{
    configPath: string
    env: Readonly<Record<string, string | undefined>>
    /** The configuration the command already loaded; read again from `configPath` when absent. */
    loaded?: LoadedCockpitConfigResult
}>, dependencies: Readonly<{ execute: Execute }>): Promise<readonly EnvironmentDiagnostic[]> {
    try {
        return await servedSiblingFindings(input, dependencies)
    } catch (error) {
        return [{ severity: 'warning', code: ENVIRONMENT_CODES.EVIDENCE_UNAVAILABLE,
            message: `the checkouts serving the siblings could not be inspected: ${errorCause(error)}`, target: SIBLING_CHECKOUTS_PATH,
            fix: 'rerun this command; if it persists, check that the sibling checkouts and .cockpit/local are readable' }]
    }
}

async function servedSiblingFindings(input: Parameters<typeof inspectServedSiblings>[0],
    dependencies: Readonly<{ execute: Execute }>): Promise<readonly EnvironmentDiagnostic[]> {
    const loaded = input.loaded ?? await loadCockpitConfig(input.configPath)
    // An unloadable cockpit.toml is reported by the command itself.
    if (loaded.kind !== 'complete') return []
    const config = loaded.result.config
    const root = dirname(loaded.result.source.path)
    const recorded = await readSiblingCheckouts(root)
    // `up` refuses an unreadable record, so the served-checkouts row fails on it too; this says why.
    if (recorded.kind !== 'complete') return [recorded.diagnostic]
    const served = servedSiblings(root, config, recorded.checkouts)
    const findings: EnvironmentDiagnostic[] = []
    for (const slug of Object.keys(recorded.checkouts).filter(slug => !served.has(slug))) findings.push({
        severity: 'warning', code: 'SIBLING_CHECKOUT_UNKNOWN' satisfies typeof ENVIRONMENT_CODES.SIBLING_CHECKOUT_UNKNOWN,
        message: `${SIBLING_CHECKOUTS_PATH} names a checkout for ${slug}, which cockpit.toml no longer declares, so nothing serves it`,
        target: SIBLING_CHECKOUTS_PATH,
        fix: `forget it with ${cockpitCommand('use', { operand: slug, args: '--clear' })}`,
    })
    // A directory that is gone is the served-checkouts row's finding, which `up` refuses as well; it is not repeated here.
    const gone = new Set((await vanishedServedCheckouts(served)).map(entry => entry.slug))
    const overridden = [...served.values()].filter(entry => entry.overridden && !gone.has(entry.slug))
    const git = overridden.length === 0 ? undefined : await createGitRunner(input.env, dependencies.execute)
    const perEntry = await Promise.all(overridden.map(async (entry): Promise<EnvironmentDiagnostic[]> => {
        const sibling = config.sibling.find(row => row.slug === entry.slug)!
        const rows: EnvironmentDiagnostic[] = [{
            severity: 'info', code: 'SIBLING_CHECKOUT_OVERRIDDEN' satisfies typeof ENVIRONMENT_CODES.SIBLING_CHECKOUT_OVERRIDDEN,
            message: `sibling ${entry.slug} is served from ${entry.served}, recorded by use in ${SIBLING_CHECKOUTS_PATH}, instead of its declared checkout ${entry.declared}`,
            target: `sibling:${entry.slug}`,
            fix: `serve the declared checkout again with ${cockpitCommand('use', { operand: entry.slug, args: '--clear' })}`,
        }]
        if (git === undefined) return rows
        if ('unavailable' in git) {
            rows.push({ severity: 'warning', code: ENVIRONMENT_CODES.EVIDENCE_UNAVAILABLE,
                message: `whether ${entry.served} is still a checkout of sibling ${entry.slug} could not be checked: ${git.unavailable}`,
                target: entry.served, fix: 'install Git and put it on PATH, then rerun this command' })
            return rows
        }
        const inspected = await inspectSiblingCheckout({ sibling, declared: entry.declared, candidate: entry.served, git })
        // `up` does not refuse a checkout of another repository, so these commands report it as a warning.
        if (inspected.kind === 'refusal') rows.push({ ...inspected.diagnostic, severity: 'warning' })
        else rows.push(...missingEnvironmentFileDiagnostics(entry, await missingEnvironmentFiles(entry, sibling)))
        return rows
    }))
    findings.push(...perEntry.flat())
    findings.push(...await staleStackDiagnostics(root, served))
    return findings
}
