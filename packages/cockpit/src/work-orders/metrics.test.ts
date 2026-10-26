import { describe, expect, it } from 'vitest'
import { parseWorkOrder, type ParsedWorkOrder } from './contract.js'
import { workOrderFixture } from '../test-support/work-order.js'
import { validateWorkOrderPolicy } from './intake.js'
import { collectWorkOrderMetrics, renderWorkOrderMetrics } from './metrics.js'

function order(id: string, status = 'draft'): ParsedWorkOrder {
    const parsed = parseWorkOrder(Buffer.from(workOrderFixture({ status }).replace('WO-001', id)))
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.findings))
    return parsed.value
}
function input(status = 'draft') {
    const policy = validateWorkOrderPolicy({ cockpitCap: 3, programmeCap: 1 })
    if (policy.kind !== 'policy') throw new Error(policy.message)
    return {
        capacity: { policy: policy.policy, orders: [{ id: 'WO-001', contract: order('WO-001', status) }] },
        inventoryWriter: 'contract-observer',
        history: { writer: 'history-observer', coverage: 'complete' as const, entries: [{ id: 'WO-001', createdAt: 1000, firstHeartbeatAt: null, everStarted: false }] },
        process: { writer: 'run-observer', argv: ['read-metrics'], exitCode: 0, signal: null, stdout: JSON.stringify({ fixRuns: 0, workOrderRuns: 2, ceremonyArtifacts: 3, productChanges: 10 }) },
    }
}

describe('produced work metrics', () => {
    it('reports absolute counts before ratios, with writers and fixed definitions', () => {
        const metrics = collectWorkOrderMetrics(input())
        expect(metrics).toMatchObject({ kind: 'metrics', history: { coverage: 'complete', observedOrders: 1, totalOrders: 1 } })
        if (!metrics || metrics.kind !== 'metrics') throw new Error('metrics required')
        expect(metrics.counts).toEqual(expect.arrayContaining([
            { name: 'inert-work-orders', value: 1, writer: 'history-observer' },
            { name: 'fix-runs', value: 0, writer: 'run-observer' },
            { name: 'ceremony-artifacts', value: 3, writer: 'run-observer' },
        ]))
        expect(metrics.ratios).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'fix-door-ratio', numerator: 0, denominator: 2, value: 0, writer: 'run-observer', definition: 'fix runs / all recorded fix and work-order runs' })]))
        const rendered = renderWorkOrderMetrics(metrics)
        expect(rendered.indexOf('ceremony-artifacts: 3')).toBeLessThan(rendered.indexOf('fix-door-ratio:'))
        expect(rendered).toContain('writer=history-observer')
        expect(rendered).toContain('history=complete (1/1 orders)')
    })

    it('keeps zero distinct from absent observations and zero denominators', () => {
        const request = input()
        request.process.stdout = JSON.stringify({ fixRuns: 0, workOrderRuns: 0, ceremonyArtifacts: 0, productChanges: 0 })
        const zero = collectWorkOrderMetrics(request)
        const absent = collectWorkOrderMetrics({ ...request, process: null, history: { writer: 'history-observer', coverage: 'unavailable', entries: [] } })
        expect(zero).toMatchObject({ kind: 'metrics', counts: expect.arrayContaining([expect.objectContaining({ name: 'fix-runs', value: 0, writer: 'run-observer' })]), ratios: expect.arrayContaining([expect.objectContaining({ name: 'fix-door-ratio', value: undefined, denominator: 0 })]) })
        expect(absent).toMatchObject({ kind: 'metrics', counts: expect.arrayContaining([expect.objectContaining({ name: 'fix-runs', value: undefined, writer: 'unavailable' })]), ratios: expect.arrayContaining([expect.objectContaining({ name: 'fix-door-ratio', value: undefined, denominator: undefined })]) })
        if (!absent || absent.kind !== 'metrics') throw new Error('metrics required')
        expect(renderWorkOrderMetrics(absent)).toContain('fix-runs: undefined')
    })

    it('retains the all-orders denominator when parking work and states partial history', () => {
        const before = collectWorkOrderMetrics(input())
        const after = collectWorkOrderMetrics(input('parked'))
        expect(before).toMatchObject({ kind: 'metrics', ratios: expect.arrayContaining([expect.objectContaining({ name: 'inert-ratio', numerator: 1, denominator: 1, value: 1 })]) })
        expect(after).toMatchObject({ kind: 'metrics', ratios: expect.arrayContaining([expect.objectContaining({ name: 'inert-ratio', numerator: 1, denominator: 1, value: 1 })]) })
        const partial = collectWorkOrderMetrics({ ...input(), history: { writer: 'history-observer', coverage: 'partial', entries: [] } })
        expect(partial).toMatchObject({ kind: 'metrics', history: { coverage: 'partial', observedOrders: 0, totalOrders: 1 }, ratios: expect.arrayContaining([expect.objectContaining({ name: 'inert-ratio', numerator: undefined, denominator: 1, value: undefined })]) })
    })

    it('computes first-heartbeat latency only from named, bounded produced history', () => {
        const request = input()
        const result = collectWorkOrderMetrics({ ...request, history: { ...request.history, entries: [{ id: 'WO-001', createdAt: 1000, firstHeartbeatAt: 2500, everStarted: true }] } })
        expect(result).toMatchObject({ kind: 'metrics', heartbeat: { samples: 1, meanMs: 1500, writer: 'history-observer' } })
        expect(collectWorkOrderMetrics({ ...request, history: { ...request.history, entries: [{ id: 'WO-001', createdAt: 1000, firstHeartbeatAt: 500, everStarted: true }] } })).toMatchObject({ kind: 'refusal', code: 'WO_METRICS_HISTORY' })
    })

    it('refuses nonzero, SIGPIPE, silent, malformed and oversized process evidence', () => {
        const request = input()
        for (const process of [
            { ...request.process, exitCode: 1 }, { ...request.process, exitCode: null, signal: 'SIGPIPE' },
            { ...request.process, stdout: '' }, { ...request.process, stdout: '{}' },
            { ...request.process, stdout: ' '.repeat(65_537) },
            { ...request.process, stdout: JSON.stringify({ fixRuns: -1, workOrderRuns: 0, ceremonyArtifacts: 0, productChanges: 0 }) },
        ]) expect(collectWorkOrderMetrics({ ...request, process })).toMatchObject({ kind: 'refusal', code: 'WO_METRICS_PROCESS' })
        expect(collectWorkOrderMetrics({ ...request, history: { ...request.history, coverage: 'complete', entries: [] } })).toMatchObject({ kind: 'refusal', code: 'WO_METRICS_HISTORY' })
    })

    it('refuses missing top-level metrics state with a named finding', () => {
        expect(collectWorkOrderMetrics(undefined as unknown as Parameters<typeof collectWorkOrderMetrics>[0])).toMatchObject({ kind: 'refusal', code: 'WO_METRICS_INVENTORY' })
    })
})
