import { isIssuedBrowserCommandReceipt, type BrowserCommandKind, type BrowserCommandReceipt } from './commands.js'

export const mechanism = {
    id: 'browser-ui-gate',
    module: 'packages/cockpit/src/browser/ui-gate.ts',
    exports: ['evaluateUiGate'],
} as const

export interface UiGateInput {
    readonly activating?: unknown
    readonly receipts: readonly unknown[]
}

export type UiGateResult = Readonly<{ kind: 'satisfied'; activating: BrowserCommandKind; receipt: BrowserCommandReceipt }>
    | Readonly<{ kind: 'refusal'; reason: string; satisfyingCommand: string }>

const satisfyingCommand = 'cockpit browser-drive --config cockpit.toml, cockpit browser-accessibility --config cockpit.toml, or cockpit browser-screenshot --config cockpit.toml'
const activatingKinds = new Set<BrowserCommandKind>(['drive', 'accessibility', 'screenshot'])

const refusal = (reason: string): UiGateResult => Object.freeze({ kind: 'refusal', reason, satisfyingCommand })

export function evaluateUiGate(input: UiGateInput): UiGateResult {
    if (!Object.hasOwn(input, 'activating') || !activatingKinds.has(input.activating as BrowserCommandKind)) {
        return refusal('UI evidence requires an activating browser command')
    }
    if (!Array.isArray(input.receipts) || input.receipts.length === 0) {
        return refusal('UI evidence requires an issued receipt from the activating browser command')
    }
    const activating = input.activating as BrowserCommandKind
    const receipt = input.receipts.find((candidate): candidate is BrowserCommandReceipt => isIssuedBrowserCommandReceipt(candidate)
        && candidate.activation === 'application' && candidate.kind === activating)
    return receipt === undefined
        ? refusal('UI evidence requires an issued receipt bound to the configured activating browser command')
        : Object.freeze({ kind: 'satisfied', activating, receipt })
}
