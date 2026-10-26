import { randomUUID } from 'node:crypto'
import { isAbsolute, relative, resolve } from 'node:path'
import type { Diagnostic } from '../diagnostics.js'
import { loadCockpitConfig } from '../config/load.js'
import { executeProbe } from '../environment-exec/execute.js'
import { setupEnvironment } from '../environment/application.js'
import { withBoundedComparisonLifecycle } from '../environment/destructive-composition.js'
import { nodeAuthority, readAnchoredBatches } from '../generated-environment/transaction.js'
import { snapshotJson, type JsonSnapshotObject } from '../environment/contract.js'
import { parseComparisonFixture, type ComparisonFixture } from './contract.js'
import { validateRealUseLedger } from './ledger.js'
import { observeComparisonSubject, runComparison, type ComparisonRunnerDependencies, type ComparisonRunResult } from './runner.js'

export const mechanism = {
    id: 'comparison-command',
    module: 'packages/cockpit/src/comparison/command.ts',
    exports: ['comparisonCommand'],
} as const

export interface ComparisonCommandInput {
    readonly root: string
    readonly operation: 'validate' | 'run' | 'status'
    readonly fixturePath: string
    readonly configPath?: string
    readonly ledgerPath?: string
}

export interface ComparisonCommandAdapters {
    readonly env?: Readonly<Record<string, string | undefined>>
    readonly decideReset?: ComparisonRunnerDependencies['decideReset']
}

export interface ComparisonCommandOutcome {
    readonly kind: 'complete' | 'refusal'
    readonly status: 0 | 2
    readonly diagnostics: readonly Diagnostic[]
    readonly result: unknown
}

function refused(message: string, target = 'compare', result: unknown = null): ComparisonCommandOutcome {
    return Object.freeze({ kind: 'refusal', status: 2, result, diagnostics: Object.freeze([
        Object.freeze({ severity: 'error', code: 'COMPARISON_UNAVAILABLE', message, target }),
    ]) })
}

function confined(root: string, path: unknown): path is string {
    if (typeof path !== 'string' || !path || /[\x00-\x1f\x7f\\]/.test(path)
        || path.split('/').includes('..')) return false
    const destination = resolve(root, path)
    const part = relative(root, destination)
    return part.length > 0 && !part.startsWith('../') && !isAbsolute(part)
}

async function readJson(root: string, path: string): Promise<Readonly<{ kind: 'complete'; value: unknown }> | undefined> {
    const node = await nodeAuthority()
    if (!node) return undefined
    const reads = await readAnchoredBatches(root, [{ path: relative(root, resolve(root, path)),
        action: 'read-entry', maxBytes: 1_048_576 }], node, { execute: executeProbe })
    const file = reads?.kind === 'complete' ? reads.results[0] : undefined
    if (file?.kind !== 'file') return undefined
    try { return { kind: 'complete', value: JSON.parse(file.bytes.toString('utf8')) } }
    catch { return undefined }
}

async function runConfiguredComparison(
    input: ComparisonCommandInput & Readonly<{ configPath: string }>,
    fixture: ComparisonFixture,
    adapters: ComparisonCommandAdapters,
): Promise<ComparisonRunResult> {
    const env = adapters.env ?? process.env
    const packageInputs = fixture.subject.inputs.filter(row => row.sha256 === fixture.subject.packageIntegrity)
    if (packageInputs.length !== 1) return { kind: 'refusal', reason: 'fixture must identify exactly one material package input matching packageIntegrity',
        evidence: [], retainCheckout: true }
    const configPath = resolve(input.root, input.configPath)
    return runComparison(fixture, {
        withLifecycle: use => withBoundedComparisonLifecycle({ configPath, env, sessionId: randomUUID(),
            timeoutMs: 30_000, dockerContext: env.DOCKER_CONTEXT ?? '' }, executeProbe, use),
        refresh: async lifecycle => {
            const loaded = await loadCockpitConfig(configPath)
            const git = await lifecycle.resolveExecutable('git')
            const ambient = setupEnvironment(Object.fromEntries(Object.entries(env)
                .filter((entry): entry is [string, string] => typeof entry[1] === 'string')))
            if (loaded.status !== 0 || !loaded.result || git.state !== 'available' || !ambient) return undefined
            const observedAt = new Date().toISOString()
            return observeComparisonSubject({ fixture, lifecycle, packagePath: packageInputs[0]!.path,
                fixturePath: relative(input.root, resolve(input.root, input.fixturePath)),
                checkout: {
                    input: { source: loaded.result.source, cockpitName: loaded.result.config.cockpit.name,
                        observedAt, env: ambient, gitExecutable: git.value },
                    context: { source: loaded.result.source, cockpitName: loaded.result.config.cockpit.name,
                        evaluatedAt: Date.parse(observedAt) },
                } })
        },
        ...(adapters.decideReset ? { decideReset: adapters.decideReset } : {}),
    })
}

export async function comparisonCommand(
    input: ComparisonCommandInput | unknown,
    adapters: ComparisonCommandAdapters = {},
): Promise<ComparisonCommandOutcome> {
    const captured = snapshotJson(input)
    if (!captured || typeof captured !== 'object' || Array.isArray(captured)) return refused('comparison input is not bounded plain data')
    const { root, operation, fixturePath, configPath, ledgerPath } = captured as JsonSnapshotObject
    const allowed = ['root', 'operation', 'fixturePath', ...(operation === 'run' ? ['configPath'] : operation === 'status' ? ['ledgerPath'] : [])]
    if (typeof root !== 'string' || !isAbsolute(root) || resolve(root) !== root
        || !['validate', 'run', 'status'].includes(String(operation))
        || Object.keys(captured).some(key => !allowed.includes(key)) || !confined(root, fixturePath)
        || operation === 'run' && !confined(root, configPath)
        || operation === 'status' && !confined(root, ledgerPath)) return refused('comparison operation or required confined inputs are invalid')
    const read = await readJson(root, fixturePath)
    if (!read) return refused('comparison fixture is unavailable, unsafe, oversized or invalid JSON', fixturePath)
    const parsed = parseComparisonFixture(read.value)
    if (parsed.kind !== 'complete') return refused(parsed.message, fixturePath)
    if (operation === 'validate') return Object.freeze({ kind: 'complete', status: 0, diagnostics: Object.freeze([]),
        result: Object.freeze({ fixtureId: parsed.fixture.fixtureId, operatorGates: 'held' }) })
    if (operation === 'status') {
        const ledger = await readJson(root, ledgerPath as string)
        if (!ledger) return refused('real-use ledger is unavailable, unsafe, oversized or invalid JSON', ledgerPath as string)
        const result = validateRealUseLedger(ledger.value, parsed.fixture)
        return result.kind === 'complete'
            ? Object.freeze({ kind: 'complete', status: 0, diagnostics: Object.freeze([]), result })
            : refused(result.reasons.join('; '), ledgerPath as string, result)
    }
    const result = await runConfiguredComparison({ root, operation: 'run', fixturePath, configPath: configPath as string }, parsed.fixture, adapters)
    return result.kind === 'complete'
        ? Object.freeze({ kind: 'complete', status: 0, diagnostics: Object.freeze([]), result })
        : refused(result.reason, 'compare run', result)
}
