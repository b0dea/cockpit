import { mkdir, mkdtemp, rename, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ENVIRONMENT_CODES, type CockpitId, type HolderId, type StackId } from './contract.js'
import {
    authenticateLifecycleStageAuthority,
    consumeLifecycleStageProjection,
    decodeLifecycleRecord,
    projectLifecycleStage,
    recordLifecycleSeeded,
    recordLifecycleStarted,
    resolveLifecycleStage,
} from './lifecycle-stage.js'
import { lifecycleHistoryAddress, selectStateRoot, transactState, type StateNamespace, type StateRecord } from './state.js'

const cockpitId = `cockpit:fixture:${'a'.repeat(64)}` as CockpitId
const otherCockpitId = `cockpit:fixture:${'e'.repeat(64)}` as CockpitId
const stackId = `stack:${'b'.repeat(64)}` as StackId
const otherStackId = `stack:${'c'.repeat(64)}` as StackId
const holderId = `holder:${'d'.repeat(64)}:session` as HolderId
const observedAt = new Date().toISOString()
const temporaryPaths: string[] = []

afterEach(async () => {
    await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function stateNamespace(targetCockpitId = cockpitId): Promise<StateNamespace> {
    const root = await mkdtemp(join(tmpdir(), 'cockpit-lifecycle-stage-'))
    temporaryPaths.push(root)
    const home = join(root, 'home')
    await mkdir(home)
    const selected = await selectStateRoot({ platform: 'linux', home, cockpitId: targetCockpitId })
    if (selected.kind !== 'complete') throw new Error('fixture state namespace was refused')
    return selected.value
}

function lifecycleRecord(namespace: StateNamespace, targetStackId = stackId): StateRecord {
    const address = namespace.paths.lifecycle(targetStackId)
    return {
        format: 'cockpit-state/v1', kind: 'lifecycle', cockpitId: address.cockpitId,
        subjectId: targetStackId, revision: 0, updatedAt: observedAt, value: { status: 'preparing' },
    }
}

function historyAddress(namespace: StateNamespace) {
    const value = lifecycleHistoryAddress(namespace, stackId)
    if (!value) throw new Error('fixture lifecycle history address was refused')
    return value
}

describe('lifecycle stage authority', () => {
    it('decodes exact durable lifecycle ownership and rejects an aliased stack', () => {
        const record: StateRecord = {
            format: 'cockpit-state/v1', kind: 'lifecycle', cockpitId, subjectId: stackId,
            revision: 7, updatedAt: observedAt, value: { holderId,
                workBasisSha256: '1'.repeat(64), operationGeneration: '2'.repeat(64), completedServices: [] },
        }
        expect(decodeLifecycleRecord(record, { cockpitId, stackId })).toMatchObject({
            record, value: { holderId, completedServices: [] },
        })
        expect(decodeLifecycleRecord(record, { cockpitId, stackId: otherStackId })).toBeUndefined()
    })

    it('decodes teardown completion only without retained runtime or generated checkpoints', () => {
        const value = { holderId, workBasisSha256: '1'.repeat(64), operationGeneration: '2'.repeat(64),
            completedServices: [], teardownComplete: true }
        const record: StateRecord = { format: 'cockpit-state/v1', kind: 'lifecycle', cockpitId, subjectId: stackId,
            revision: 7, updatedAt: observedAt, value }
        expect(decodeLifecycleRecord(record, { cockpitId, stackId })?.value).toEqual(value)
        const invalid: readonly Readonly<Record<string, StateRecord['value']>>[] = [
            { teardownComplete: false },
            { teardownComplete: 'true' },
            { completedServices: [{ service: 'app', containerId: '3'.repeat(64) }] },
            { generatedReplay: { runtimeSha256: '4'.repeat(64), generation: '5'.repeat(64), profiles: [], mounts: [] } },
            { generatedProgress: { applied: [], notApplied: [] } },
        ]
        for (const change of invalid) {
            expect(decodeLifecycleRecord({ ...record, value: { ...value, ...change } }, { cockpitId, stackId })).toBeUndefined()
        }
    })

    it('issues bootstrap authority only for pristine state', async () => {
        const namespace = await stateNamespace()
        const result = await resolveLifecycleStage({ namespace, stackId, observedAt })
        expect(result).toMatchObject({
            kind: 'complete', authority: { stackId, stage: 'bootstrap' },
            observation: { code: ENVIRONMENT_CODES.STATE_UNSEEDED, observed: { state: 'available', value: false } },
        })
    })

    it('keeps an interrupted first seed in bootstrap until history is promoted', async () => {
        const namespace = await stateNamespace()
        expect(await recordLifecycleStarted({ namespace, stackId, holderId, observedAt })).toMatchObject({ kind: 'complete' })
        const address = namespace.paths.lifecycle(stackId)
        expect(await transactState(namespace, address, { ownerId: holderId }, () => lifecycleRecord(namespace))).toMatchObject({ kind: 'complete' })
        expect(await resolveLifecycleStage({ namespace, stackId, observedAt })).toMatchObject({
            kind: 'complete', authority: { stage: 'bootstrap' },
        })
        expect(await recordLifecycleSeeded({ namespace, stackId, holderId, observedAt })).toMatchObject({ kind: 'complete' })
        expect(await resolveLifecycleStage({ namespace, stackId, observedAt })).toMatchObject({
            kind: 'complete', authority: { stage: 'steady' },
        })
    })

    it('keeps seeded history steady when the lifecycle record is later missing', async () => {
        const namespace = await stateNamespace()
        await recordLifecycleStarted({ namespace, stackId, holderId, observedAt })
        await recordLifecycleSeeded({ namespace, stackId, holderId, observedAt })
        expect(await resolveLifecycleStage({ namespace, stackId, observedAt })).toMatchObject({
            kind: 'complete', authority: { stage: 'steady' },
            observation: { observed: { state: 'available', value: false } },
        })
    })

    it('refuses lifecycle data without durable history', async () => {
        const namespace = await stateNamespace()
        const address = namespace.paths.lifecycle(stackId)
        await transactState(namespace, address, { ownerId: holderId }, () => lifecycleRecord(namespace))
        expect(await resolveLifecycleStage({ namespace, stackId, observedAt })).toMatchObject({
            kind: 'refusal', diagnostics: [{ code: ENVIRONMENT_CODES.STATE_RECORD_MALFORMED }],
        })
    })

    it('refuses malformed history and does not infer a stage', async () => {
        const namespace = await stateNamespace()
        const address = historyAddress(namespace)
        await transactState(namespace, address, { ownerId: holderId }, () => ({
            format: 'cockpit-state/v1', kind: 'lifecycle-history', cockpitId,
            subjectId: stackId, revision: 0, updatedAt: observedAt, value: { status: 'unknown' },
        }))
        expect(await resolveLifecycleStage({ namespace, stackId, observedAt })).toMatchObject({
            kind: 'refusal', diagnostics: [{ code: ENVIRONMENT_CODES.STATE_RECORD_MALFORMED }],
        })
    })

    it('permits only started then seeded and never downgrades seeded history', async () => {
        const namespace = await stateNamespace()
        expect(await recordLifecycleSeeded({ namespace, stackId, holderId, observedAt })).toMatchObject({ kind: 'refusal' })
        expect(await recordLifecycleStarted({ namespace, stackId, holderId, observedAt })).toMatchObject({ kind: 'complete' })
        expect(await recordLifecycleStarted({ namespace, stackId, holderId, observedAt })).toMatchObject({ kind: 'unchanged' })
        expect(await recordLifecycleSeeded({ namespace, stackId, holderId, observedAt })).toMatchObject({ kind: 'complete' })
        // Setup records `started` before acquiring a sibling added after the stack has run; seeded
        // history already contains that start, so it stays seeded instead of refusing setup.
        expect(await recordLifecycleStarted({ namespace, stackId, holderId, observedAt })).toMatchObject({
            kind: 'unchanged', record: { value: { status: 'seeded' } },
        })
        expect(await resolveLifecycleStage({ namespace, stackId, observedAt })).toMatchObject({
            kind: 'complete', authority: { stage: 'steady' },
        })
        expect(await recordLifecycleSeeded({ namespace, stackId, holderId, observedAt })).toMatchObject({ kind: 'unchanged' })
    })

    it('invalidates authority when either observed durable record changes', async () => {
        const historyNamespace = await stateNamespace()
        const beforeHistory = await resolveLifecycleStage({ namespace: historyNamespace, stackId, observedAt })
        if (beforeHistory.kind !== 'complete') throw new Error('fixture lifecycle stage was refused')
        await recordLifecycleStarted({ namespace: historyNamespace, stackId, holderId, observedAt })
        expect(authenticateLifecycleStageAuthority(
            beforeHistory.authority,
            stackId,
            cockpitId,
            Date.parse(observedAt),
            Date.parse(beforeHistory.authority.validThrough),
            Date.now(),
        )).toBeUndefined()

        const lifecycleNamespace = await stateNamespace()
        const beforeLifecycle = await resolveLifecycleStage({ namespace: lifecycleNamespace, stackId, observedAt })
        if (beforeLifecycle.kind !== 'complete') throw new Error('fixture lifecycle stage was refused')
        await transactState(
            lifecycleNamespace,
            lifecycleNamespace.paths.lifecycle(stackId),
            { ownerId: holderId },
            () => lifecycleRecord(lifecycleNamespace),
        )
        expect(authenticateLifecycleStageAuthority(
            beforeLifecycle.authority,
            stackId,
            cockpitId,
            Date.parse(observedAt),
            Date.parse(beforeLifecycle.authority.validThrough),
            Date.now(),
        )).toBeUndefined()
    })

    it('binds authority to its issued namespace and ancestor topology', async () => {
        const namespace = await stateNamespace()
        const issued = await resolveLifecycleStage({ namespace, stackId, observedAt })
        if (issued.kind !== 'complete') throw new Error('fixture lifecycle stage was refused')
        expect(authenticateLifecycleStageAuthority(
            issued.authority,
            stackId,
            otherCockpitId,
            Date.parse(observedAt),
            Date.parse(issued.authority.validThrough),
            Date.now(),
        )).toBeUndefined()

        const second = await resolveLifecycleStage({ namespace, stackId, observedAt })
        if (second.kind !== 'complete') throw new Error('fixture lifecycle stage was refused')
        await mkdir(dirname(historyAddress(namespace).path), { recursive: true })
        expect(authenticateLifecycleStageAuthority(
            second.authority,
            stackId,
            cockpitId,
            Date.parse(observedAt),
            Date.parse(second.authority.validThrough),
            Date.now(),
        )).toBeUndefined()
    })

    it('invalidates authority when an existing ancestor is replaced', async () => {
        const namespace = await stateNamespace()
        const issued = await resolveLifecycleStage({ namespace, stackId, observedAt })
        if (issued.kind !== 'complete') throw new Error('fixture lifecycle stage was refused')
        const home = resolve(namespace.root, '../../../..')
        const moved = `${home}-moved`
        const replacement = `${home}-replacement`
        await mkdir(replacement)
        await rename(home, moved)
        await symlink(replacement, home)
        expect(authenticateLifecycleStageAuthority(
            issued.authority,
            stackId,
            cockpitId,
            Date.parse(observedAt),
            Date.parse(issued.authority.validThrough),
            Date.now(),
        )).toBeUndefined()
    })

    it('rejects fabricated namespace functions without invoking them', async () => {
        const namespace = await stateNamespace()
        let calls = 0
        const fabricated = {
            ...namespace,
            paths: {
                ...namespace.paths,
                lifecycle: () => { calls += 1; throw new Error('fabricated lifecycle path invoked') },
                lifecycleHistory: () => { calls += 1; throw new Error('fabricated history path invoked') },
            },
        }
        await expect(resolveLifecycleStage({ namespace: fabricated, stackId, observedAt } as never))
            .resolves.toMatchObject({ kind: 'refusal' })
        expect(calls).toBe(0)
    })

    it('projects only stable stage evidence and consumes both capabilities once', async () => {
        const namespace = await stateNamespace()
        const issued = await resolveLifecycleStage({ namespace, stackId, observedAt })
        if (issued.kind !== 'complete') throw new Error('fixture lifecycle stage was refused')
        const earliest = Date.parse(observedAt)
        const latest = Date.parse(issued.authority.validThrough)
        const projection = projectLifecycleStage({
            authority: issued.authority, stackId, cockpitId, earliest, latest, evaluatedAt: Date.now(),
        })

        expect(projection).toBeDefined()
        expect(Reflect.ownKeys(projection!)).toEqual([])
        expect(authenticateLifecycleStageAuthority(
            issued.authority, stackId, cockpitId, earliest, latest, Date.now(),
        )).toBeUndefined()
        expect(consumeLifecycleStageProjection({ ...projection } as never)).toBeUndefined()
        expect(consumeLifecycleStageProjection(Proxy.revocable(projection!, {}).proxy)).toBeUndefined()
        const evidence = consumeLifecycleStageProjection(projection!)
        expect(evidence).toEqual({ stackId, stage: 'bootstrap' })
        expect(Object.isFrozen(evidence)).toBe(true)
        expect(Object.keys(evidence ?? {}).sort()).toEqual(['stackId', 'stage'])
        expect(consumeLifecycleStageProjection(projection!)).toBeUndefined()
    })

    it('projects steady independently from observation-stage consumption', async () => {
        const namespace = await stateNamespace()
        await recordLifecycleStarted({ namespace, stackId, holderId, observedAt })
        await recordLifecycleSeeded({ namespace, stackId, holderId, observedAt })
        const first = await resolveLifecycleStage({ namespace, stackId, observedAt })
        const second = await resolveLifecycleStage({ namespace, stackId, observedAt })
        if (first.kind !== 'complete' || second.kind !== 'complete') throw new Error('fixture lifecycle stage was refused')
        const earliest = Date.parse(observedAt)
        const latest = Date.parse(first.authority.validThrough)
        expect(authenticateLifecycleStageAuthority(
            first.authority, stackId, cockpitId, earliest, latest, Date.now(),
        )).toBe('steady')
        const projection = projectLifecycleStage({
            authority: second.authority, stackId, cockpitId, earliest,
            latest: Date.parse(second.authority.validThrough), evaluatedAt: Date.now(),
        })
        expect(consumeLifecycleStageProjection(projection!)).toEqual({ stackId, stage: 'steady' })
    })

    it('refuses malformed projection bounds without consuming valid authority', async () => {
        const namespace = await stateNamespace()
        const now = Date.now()
        const invalidBounds = [
            [Number.NaN, now + 1_000, now],
            [now - 1_000, Number.POSITIVE_INFINITY, now],
            [now - 1_000, now + 1_000, now + 0.5],
            [now + 1_000, now - 1_000, now],
            [now, now + 1_000, now - 1],
            [now - 1_000, now, now + 1],
        ] as const
        for (const [earliest, latest, evaluatedAt] of invalidBounds) {
            const issued = await resolveLifecycleStage({ namespace, stackId, observedAt })
            if (issued.kind !== 'complete') throw new Error('fixture lifecycle stage was refused')
            expect(projectLifecycleStage({
                authority: issued.authority, stackId, cockpitId, earliest, latest, evaluatedAt,
            })).toBeUndefined()
            expect(authenticateLifecycleStageAuthority(
                issued.authority, stackId, cockpitId, Date.parse(observedAt),
                Date.parse(issued.authority.validThrough), Date.now(),
            )).toBe('bootstrap')
        }
    })

    it('refuses an expired projection even when the caller backdates evaluation', async () => {
        const namespace = await stateNamespace()
        const issuedAt = Date.now()
        vi.useFakeTimers()
        try {
            vi.setSystemTime(issuedAt)
            const issued = await resolveLifecycleStage({ namespace, stackId, observedAt })
            if (issued.kind !== 'complete') throw new Error('fixture lifecycle stage was refused')
            const latest = Date.parse(issued.authority.validThrough)
            vi.setSystemTime(latest + 1)
            expect(projectLifecycleStage({
                authority: issued.authority, stackId, cockpitId,
                earliest: Date.parse(observedAt), latest, evaluatedAt: issuedAt,
            })).toBeUndefined()

            vi.setSystemTime(issuedAt + 1)
            expect(authenticateLifecycleStageAuthority(
                issued.authority, stackId, cockpitId, Date.parse(observedAt), latest, issuedAt + 1,
            )).toBe('bootstrap')
        } finally {
            vi.useRealTimers()
        }
    })

    it('refuses evaluation before the authority observation without consuming it', async () => {
        const namespace = await stateNamespace()
        const issued = await resolveLifecycleStage({ namespace, stackId, observedAt })
        if (issued.kind !== 'complete') throw new Error('fixture lifecycle stage was refused')
        const observed = Date.parse(issued.authority.observedAt)
        const latest = Date.parse(issued.authority.validThrough)
        expect(projectLifecycleStage({
            authority: issued.authority, stackId, cockpitId,
            earliest: observed - 1, latest, evaluatedAt: observed - 1,
        })).toBeUndefined()
        expect(authenticateLifecycleStageAuthority(
            issued.authority, stackId, cockpitId, observed, latest, Date.now(),
        )).toBe('bootstrap')
    })

    it('refuses wrong identity and copied capabilities', async () => {
        const namespace = await stateNamespace()
        const issue = async () => {
            const result = await resolveLifecycleStage({ namespace, stackId, observedAt })
            if (result.kind !== 'complete') throw new Error('fixture lifecycle stage was refused')
            return result.authority
        }
        const input = (authority: Awaited<ReturnType<typeof issue>>) => ({
            authority, stackId, cockpitId,
            earliest: Date.parse(observedAt), latest: Date.parse(authority.validThrough), evaluatedAt: Date.now(),
        })
        expect(projectLifecycleStage({ ...input(await issue()), stackId: otherStackId })).toBeUndefined()
        expect(projectLifecycleStage({ ...input(await issue()), cockpitId: otherCockpitId })).toBeUndefined()
        const authority = await issue()
        expect(projectLifecycleStage({ ...input(authority), authority: { ...authority } as never })).toBeUndefined()
    })

    it('refuses projection after either durable lifecycle identity changes', async () => {
        const namespace = await stateNamespace()
        const issued = await resolveLifecycleStage({ namespace, stackId, observedAt })
        if (issued.kind !== 'complete') throw new Error('fixture lifecycle stage was refused')
        await recordLifecycleStarted({ namespace, stackId, holderId, observedAt })
        expect(projectLifecycleStage({
            authority: issued.authority, stackId, cockpitId,
            earliest: Date.parse(observedAt), latest: Date.parse(issued.authority.validThrough), evaluatedAt: Date.now(),
        })).toBeUndefined()
    })
})
