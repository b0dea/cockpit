import { describe, expect, it } from 'vitest'
import { runWorkApplication } from './application.js'

describe('work application boundary', () => {
    it('refuses unissued composition and accessor requests without reading them', async () => {
        let reads = 0
        const request = Object.defineProperty({ workOrderId: 'WO-001' }, 'operation', {
            enumerable: true, get: () => { reads += 1; return 'work-status' },
        })
        await expect(runWorkApplication(request as never, {} as never))
            .resolves.toMatchObject({ kind: 'refusal', operation: 'invalid' })
        expect(reads).toBe(0)
        for (const operation of ['toString', 'constructor']) {
            await expect(runWorkApplication({ operation } as never, {} as never)).resolves.toMatchObject({ kind: 'refusal', operation: 'invalid' })
        }
        for (const operation of ['work-intake', 'work-accept', 'work-renew', 'work-recover', 'work-execute', 'work-record', 'work-reverse', 'work-grade', 'work-review']) {
            await expect(runWorkApplication({ operation } as never, {} as never)).resolves.toMatchObject({ kind: 'refusal', operation: 'invalid' })
        }
        for (const request of [{ operation: 'work-intake', intent: '../intent.json' },
            { operation: 'work-intake', workOrderId: 'WO-001', intent: 'intent.json' },
            { operation: 'work-record', workOrderId: 'WO-001', eventFile: '/tmp/event.json' }]) {
            await expect(runWorkApplication(request as never, {} as never)).resolves.toMatchObject({ kind: 'refusal', operation: 'invalid' })
        }
        for (const lockId of ['WO-001', 'programme-synthetic', '.admission-capacity', '.identity-admission']) {
            await expect(runWorkApplication({ operation: 'work-recover', lockId, apply: false } as never, {} as never)).resolves.toMatchObject({
                kind: 'refusal', operation: 'invalid', reason: expect.stringContaining('issued'),
            })
        }
        for (const lockId of ['../outside', '.', '/tmp/lock', 'x'.repeat(129)]) {
            await expect(runWorkApplication({ operation: 'work-recover', lockId, apply: false } as never, {} as never)).resolves.toMatchObject({
                kind: 'refusal', operation: 'invalid', reason: expect.stringContaining('closed selector-only shape'),
            })
        }
        for (const approach of ['unsafe\u0085text', 'unsafe\u009ftext']) {
            await expect(runWorkApplication({ operation: 'work-execute', workOrderId: 'WO-001', approach }, {} as never)).resolves.toMatchObject({
                kind: 'refusal', operation: 'invalid', reason: expect.stringContaining('closed selector-only shape'),
            })
        }
        await expect(runWorkApplication({ operation: 'work-metrics' }, {} as never)).resolves.toMatchObject({
            kind: 'refusal', operation: 'invalid', reason: expect.stringContaining('issued'),
        })
        for (const role of ['qa_user', '1worker']) {
            await expect(runWorkApplication({ operation: 'browser-drive', role }, {} as never)).resolves.toMatchObject({
                kind: 'refusal', operation: 'invalid', reason: expect.stringContaining('issued'),
            })
        }
        for (const role of ['Bad', 'bad role', '../outside', 'x'.repeat(65)]) {
            await expect(runWorkApplication({ operation: 'browser-drive', role }, {} as never)).resolves.toMatchObject({
                kind: 'refusal', operation: 'invalid', reason: expect.stringContaining('closed selector-only shape'),
            })
        }
    })
})
