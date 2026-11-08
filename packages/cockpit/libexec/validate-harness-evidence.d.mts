export interface HarnessEvidenceManifest {
    harness: 'Claude Code' | 'Codex' | 'OpenCode'
    version: string
    date: string
    capability: 'sandbox' | 'approval'
    candidatePath: string
    brokenPath: string
    transcriptPath: string
    candidateSha256: string
    brokenSha256: string
    transcriptSha256: string
    runId: string
    versionCommand: readonly string[]
    helpCommand: readonly string[]
    invocation: readonly string[]
    forbiddenAction: string
    brokenRejected: boolean
    verdict: 'enforced' | 'unavailable'
    syntheticFixture: string
    events: {
        version: HarnessProbeEvent
        help: HarnessProbeEvent
        brokenControl: HarnessProbeEvent
        candidateControl: HarnessProbeEvent
    }
}

export interface HarnessProbeEvent {
    cwd: string
    command: readonly string[]
    exitCode: number
    stream: 'stdout' | 'stderr'
    code: string
    result: 'completed' | 'rejected' | 'accepted' | 'refused' | 'allowed' | 'unavailable'
    output: string
    outputSha256: string
}

export interface HarnessEvidenceValidationOptions {
    testOnlyExecutableIdentities?: Partial<Record<HarnessEvidenceManifest['harness'], readonly string[]>>
    operatorExecutableIdentities?: ReadonlyMap<
        HarnessEvidenceManifest['harness'],
        Readonly<{ canonicalPath: string; sha256: string }>
    >
}

export type SelftestCapability = 'instruction-loading' | 'guard-firing' | 'skill-parity'
export type BuiltinHarnessRef =
    | { kind: 'builtin'; target: 'claudecode'; name: 'Claude Code' }
    | { kind: 'builtin'; target: 'codexcli'; name: 'Codex' }
    | { kind: 'builtin'; target: 'opencode'; name: 'OpenCode' }
export interface CustomHarnessRef {
    kind: 'custom'
    id: string
    declarationSha256: string
    module: string
    sourceSha256: string
    export: string
}
export type SelftestHarnessRef = BuiltinHarnessRef | CustomHarnessRef
export type SelftestCellKey =
    | { harness: SelftestHarnessRef; capability: 'instruction-loading' | 'guard-firing' }
    | { harness: SelftestHarnessRef; capability: 'skill-parity'; skill: string }
export interface SelftestExpectation {
    schema: 'cockpit-harness-selftest-expectation/v1'
    generatedManifestSha256: string
    instructionSourceSha256?: string
    nativeSourceSha256?: Readonly<Record<string, string>>
    guardProbeHost?: string
    guardHookCommand?: string
    cells: readonly SelftestCellKey[]
    shippedSkills: readonly string[]
    reviewHarnesses: readonly [
        { name: 'Claude Code'; nativeDiagnostics: boolean },
        { name: 'Codex'; nativeDiagnostics: boolean },
    ]
}
export interface SelftestProbeEvent {
    cwd: string
    command: readonly string[]
    exitCode: number
    signal: NodeJS.Signals | null
    result: 'completed' | 'rejected' | 'accepted' | 'refused' | 'allowed' | 'unavailable'
    code: string
    stdout: string
    stderr: string
    stdoutSha256: string
    stderrSha256: string
}
export interface BuiltinExecutionAuthority {
    kind: 'native-executable'
    name: 'Claude Code' | 'Codex' | 'OpenCode'
    executable: string
}
export interface CustomExecutionAuthority {
    kind: 'custom-module'
    harnessId: string
    module: string
    sourceSha256: string
    export: string
    stepId: string
    startedAt: string
    finishedAt: string
}
export type SelftestExecutionAuthority = BuiltinExecutionAuthority | CustomExecutionAuthority
export interface SelftestSample { skill: string; features: readonly string[] }
export interface SelftestEvidenceRecord {
    protocol?: 'codex-prompt-input/v1' | 'claude-model-input/v1' | 'codex-skill-input/v1' | 'claude-guard-loopback/v1'
    modelInputs?: { candidate: string; broken: string }
    modelEndpoints?: { candidate: string; broken: string }
    guardProbe?: { host: string; brokenCommand: string; receipts: { candidate: readonly string[]; broken: readonly string[] } }
    kind: 'evidence'
    harness: SelftestHarnessRef
    capability: SelftestCapability
    generatedManifestSha256: string
    verdict: 'enforced' | 'instructed' | 'unavailable'
    version: string
    measuredOn: string
    runId: string
    startedAt: string
    finishedAt: string
    expiresAt: string
    candidatePath: string
    brokenPath: string
    transcriptPath: string
    candidateSha256: string
    brokenSha256: string
    transcriptSha256: string
    invocation: readonly string[]
    versionCommand: readonly string[]
    helpCommand: readonly string[]
    candidateCode: string
    brokenCode: string
    sample: SelftestSample | null
    authority: SelftestExecutionAuthority
    events: { version: SelftestProbeEvent; help: SelftestProbeEvent; brokenControl: SelftestProbeEvent; candidateControl: SelftestProbeEvent }
}
export type SelftestHumanNeededRecord = {
    kind: 'human_needed'
    harness: SelftestHarnessRef
    generatedManifestSha256: string
    observedAt: string
    reason: 'executable_missing' | 'authentication_required' | 'isolation_unavailable' | 'enforcement_probe_required' | 'native_protocol_unsupported'
    operatorAction: string
} & (
    | { capability: 'instruction-loading' | 'guard-firing' }
    | { capability: 'skill-parity'; skill: string }
)
export interface SelftestSkillReviewRecord {
    skill: string
    harness: 'Claude Code' | 'Codex'
    status: 'evidenced' | 'human_needed'
    reviewedOn: string | null
    evidenceRunId: string | null
    reviewers: readonly ('official-authoring' | 'harness-diagnostics')[]
    checks: { trigger: 'pass'; silence: 'pass'; bodyLoad: 'pass'; tools: 'pass'; nonGoals: 'pass' } | null
    operatorAction: string | null
}
export interface SelftestEvidenceBundle {
    schema: 'cockpit-harness-selftest/v1'
    generatedManifestSha256: string
    records: readonly (SelftestEvidenceRecord | SelftestHumanNeededRecord)[]
    skillInventory: readonly string[]
    skillReviews: readonly SelftestSkillReviewRecord[]
}
export interface SelftestEvidenceValidationOptions extends HarnessEvidenceValidationOptions { testOnlyNow?: string }
export interface SelftestEvidenceValidationResult {
    errors: readonly string[]
    evidence: readonly SelftestEvidenceRecord[]
    pending: readonly SelftestHumanNeededRecord[]
    skillReviews: readonly SelftestSkillReviewRecord[]
}

export const PROBE_EVIDENCE_ROOT: '.cockpit/local/probes'
export function validateEvidenceManifest(
    manifest: unknown,
    root?: string,
    options?: HarnessEvidenceValidationOptions,
): string[]
export function validateEvidenceManifests(
    manifests: readonly unknown[],
    root?: string,
    options?: HarnessEvidenceValidationOptions,
): { errors: string[]; rows: HarnessEvidenceManifest[] }
export function validateSelftestEvidenceBundle(
    bundle: unknown,
    expectation: unknown,
    root?: string,
    options?: SelftestEvidenceValidationOptions,
): SelftestEvidenceValidationResult
export function runHarnessEvidenceValidatorCli(paths: readonly string[]): number

export const NATIVE_SELFTEST_STREAM_BYTES: number
export function validateNativeInstructionPair(candidateOutput: string, brokenOutput: string, candidateCwd: string, brokenCwd: string, candidateBytes: string, brokenBytes: string): string | null
