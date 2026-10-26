import type { KeyObject } from 'node:crypto'

export const mechanism: {
    id: string
    module: string
    exports: string[]
}

export interface NavigationManifestFile {
    path: string
    state: 'present' | 'deleted'
    sha256: string | null
}

export interface NavigationReviewManifest {
    base: string
    head: string
    files: NavigationManifestFile[]
    pathSetSha256: string
    navigationScope: string[]
}

export interface PreparedHarnessProbe {
    parent: string
    candidate: string
    brokenControl: string
    writable: string
    profiles: { candidate: string; brokenControl: string }
    brokenProfile: string
    forbiddenRoots: string[]
}

export interface PreparedNavigationProbe {
    root: string
    base: string
    commit: string
    controlMarker: string
    manifest: NavigationReviewManifest
    sentinel: string
    harnesses: Record<'codex' | 'claude', PreparedHarnessProbe>
}

export interface PrepareNavigationProbeInput {
    repository: string
    reviewManifest: string
    base: string
    head: string
    destination: string
}

export interface NavigationReceiptExecution {
    command: string
    exitStatus: number
    transcriptSha256: string
    detectorCode?: string
}

export interface NavigationControlReceiptExecution extends NavigationReceiptExecution {
    detectorCode: string
    harnessCommand: string
    harnessExitStatus: number
}

export interface NavigationReceipt {
    bounds: { maxOutputBytes: number; maxSeconds: number }
    candidateCommit: string
    cleanup: { after: string; before: string }
    differential: string
    issuedAt: string
    openedPaths: string[]
    scopeSha256: string
    candidate: NavigationReceiptExecution
    brokenControl: NavigationControlReceiptExecution
}

export interface NavigationEvidenceReceiptRow {
    harness: 'codex' | 'claude'
    scope: string[]
    receipt: NavigationReceipt
    signature: string
}

export interface NavigationEvidenceUnavailableRow {
    harness: 'codex' | 'claude'
    scope: string[]
    status: 'unavailable'
    reason: string
}

export type NavigationEvidenceRow = NavigationEvidenceReceiptRow | NavigationEvidenceUnavailableRow

export interface RunNavigationProbeInput {
    prepared: PreparedNavigationProbe
    binaries: { sandbox: string; codex: string; claude: string }
    privateKey: KeyObject
    prompt: string
    scope: string[]
    timeoutMs?: number
    maxOutputBytes?: number
    environment?: Record<string, string>
    now?: () => Date
}

export function prepareNavigationProbe(input: PrepareNavigationProbeInput): Promise<PreparedNavigationProbe>
export function runNavigationProbe(input: RunNavigationProbeInput): Promise<NavigationEvidenceRow[]>
export function renderNavigationEvidence(fixedPoint: string, navigation: NavigationEvidenceRow[]): string
