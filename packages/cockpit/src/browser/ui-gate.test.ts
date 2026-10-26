import { describe, expect, it } from 'vitest'
import { evaluateUiGate } from './ui-gate.js'

describe('UI driving gate', () => {
    it('requires an activating field and names a satisfying command', () => {
        expect(evaluateUiGate({ receipts: [] })).toEqual({
            kind: 'refusal', reason: 'UI evidence requires an activating browser command',
            satisfyingCommand: 'cockpit browser-drive --config cockpit.toml, cockpit browser-accessibility --config cockpit.toml, or cockpit browser-screenshot --config cockpit.toml',
        })
    })

    it('refuses suite runners, bare spec paths and structural receipt copies', () => {
        for (const activating of ['npm test', 'tests/ui.spec.ts']) {
            expect(evaluateUiGate({ activating, receipts: [] })).toMatchObject({ kind: 'refusal', satisfyingCommand: expect.stringContaining('cockpit browser-drive --config') })
        }
        expect(evaluateUiGate({ activating: 'drive', receipts: [{ kind: 'drive', activation: 'application' }] })).toMatchObject({
            kind: 'refusal', reason: expect.stringContaining('issued'),
        })
    })

    it('does not let a differently typed command satisfy the configured activating field', () => {
        expect(evaluateUiGate({ activating: 'screenshot', receipts: [{ kind: 'drive', activation: 'application' }] })).toMatchObject({ kind: 'refusal' })
    })
})
