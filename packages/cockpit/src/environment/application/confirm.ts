// Sequences `cockpit confirm <answer>`: refuse an answer only a person may confirm, run the existing
// observation that verifies the rest against this machine and the running product, record what ran,
// then drop the answer from `unconfirmed` in cockpit.toml. The record goes first, so a failed edit
// leaves a record nothing uses, never a removed entry the guard cannot account for.
import { dirname, join } from 'node:path'

import { canonicalJson } from '../../canonical-json.js'
import { loadCockpitConfig, readBoundedInput } from '../../config/load.js'
import { removeUnconfirmedAnswer } from '../../config/unconfirmed-toml.js'
import { writeVerifiedConfig } from '../../config/verified-write.js'
import { cockpitCommand } from '../../fix-catalogue.js'
import {
    ANSWER_CONFIRMATION_PATH, ANSWER_CONFIRMATIONS, type AnswerConfirmationRecord, type ConfirmingObservation,
    confirmationConfigurationSha256, encodeAnswerConfirmations, parseAnswerConfirmations, personConfirmationFix,
    type UnconfirmedAnswerName,
} from '../../guards/answer-confirmation.js'
import { writeCockpitLocalFiles } from '../../guards/local-identity.js'
import { refusalOutcome } from '../../refusal.js'
import type { CockpitConfig } from '../../schema.js'
import { sha256Hex } from '../../sha256.js'
import { type Diagnostic, ENVIRONMENT_CODES, hasErrorCode } from '../contract.js'
import { declaredRuntime } from '../declaration.js'
import type { EvaluatedObservation } from '../observations.js'

export interface ConfirmCommandInput {
    readonly configPath: string
    readonly answer: UnconfirmedAnswerName
}

type Observed = Readonly<{ status: number; diagnostics: readonly Diagnostic[] }>

export interface ConfirmCommandAdapters {
    /** The preflight command, run against the configuration on disk. */
    readonly preflight: (input: Readonly<{ configPath: string }>) => Promise<Observed & Readonly<{ result: Readonly<{ checks: readonly EvaluatedObservation[] }> }>>
    /** The check command, run against the configuration on disk. */
    readonly check: (input: Readonly<{ configPath: string }>) => Promise<Observed>
    readonly now: () => Date
}

export interface ConfirmCommandOutcome {
    readonly status: 0 | 2
    readonly artifact: string | null
    readonly destination: null
    readonly result: unknown
    readonly diagnostics: readonly Diagnostic[]
}

// The rows of preflight that say the runtime measured on this machine meets the declared floor.
const RUNTIME_FLOOR_CODES: readonly string[] = [ENVIRONMENT_CODES.MACHINE_MEMORY_BELOW_FLOOR, ENVIRONMENT_CODES.MACHINE_CPU_BELOW_FLOOR,
    ENVIRONMENT_CODES.MACHINE_DISK_BELOW_FLOOR, ENVIRONMENT_CODES.RUNTIME_UNMEASURED]
// Preflight passes only with the stack up; this row says the port family it holds is leased on the
// declared bases with current listener evidence.
const PORT_FAMILY_CODES: readonly string[] = [ENVIRONMENT_CODES.PORT_FAMILY_COLLISION]

type Verdict = Readonly<{ passed: true; evidence: unknown }> | Readonly<{ passed: false; reason: string; diagnostics: readonly Diagnostic[] }>

const failing = (diagnostics: readonly Diagnostic[]) => diagnostics.filter(row => row.severity === 'error')

async function observe(observation: ConfirmingObservation, configPath: string, config: CockpitConfig,
    adapters: ConfirmCommandAdapters): Promise<Verdict> {
    // A machine floor alone is still measured; the stack and its Compose files need a declared runtime.
    if (observation !== 'runtime-floor' && declaredRuntime(config.environment) !== 'compose') {
        return { passed: false, reason: 'cockpit.toml declares no Compose files, so there is no stack or topology to observe', diagnostics: [] }
    }
    if (observation === 'check') {
        const checked = await adapters.check({ configPath })
        return checked.status === 0 ? { passed: true, evidence: { status: checked.status, diagnostics: checked.diagnostics } }
            : { passed: false, reason: 'check did not pass', diagnostics: failing(checked.diagnostics) }
    }
    const preflight = await adapters.preflight({ configPath })
    const codes = observation === 'preflight' ? PORT_FAMILY_CODES : RUNTIME_FLOOR_CODES
    const rows = preflight.result.checks.filter(check => codes.includes(check.code))
    const unmet = codes.filter(code => !rows.some(row => row.code === code && row.verdict === 'pass'))
    const evidence = { checks: rows.map(({ code, verdict, source, measured, observedAt }) => ({ code, verdict, source, measured, observedAt })) }
    if (observation === 'preflight' && preflight.status !== 0) {
        return { passed: false, reason: 'preflight did not pass, so the stack is not up and healthy on the declared ports', diagnostics: failing(preflight.diagnostics) }
    }
    return unmet.length === 0 ? { passed: true, evidence }
        : { passed: false, reason: `preflight did not observe ${unmet.join(', ')} passing`, diagnostics: failing(preflight.diagnostics) }
}

async function readConfirmations(root: string): Promise<Uint8Array | undefined> {
    try {
        const read = await readBoundedInput(join(root, ANSWER_CONFIRMATION_PATH))
        return read.kind === 'complete' ? read.bytes : undefined
    } catch (error) {
        if (hasErrorCode(error, 'ENOENT')) return undefined
        throw error
    }
}

export async function runConfirm(input: ConfirmCommandInput, adapters: ConfirmCommandAdapters): Promise<ConfirmCommandOutcome> {
    const { answer } = input
    const confirmation = ANSWER_CONFIRMATIONS[answer]
    if (confirmation.by === 'person') {
        return refusalOutcome('CONFIRM_PERSON_REQUIRED' satisfies typeof ENVIRONMENT_CODES.CONFIRM_PERSON_REQUIRED,
            `${answer} is confirmed only by a person: ${confirmation.trustDecision ? `it is a trust decision, because ${confirmation.why}` : confirmation.why}`,
            answer, personConfirmationFix([answer], input.configPath))
    }
    const loaded = await loadCockpitConfig(input.configPath)
    if (loaded.kind !== 'complete') return { status: 2, artifact: null, destination: null, result: null, diagnostics: loaded.diagnostics }
    const configPath = loaded.result.source.path
    const config = loaded.result.config
    if (!config.unconfirmed?.includes(answer)) {
        return refusalOutcome('CONFIRM_ANSWER_NOT_LISTED' satisfies typeof ENVIRONMENT_CODES.CONFIRM_ANSWER_NOT_LISTED,
            `${answer} is not listed under unconfirmed in ${configPath}, so there is nothing to confirm`, 'unconfirmed',
            `run ${cockpitCommand('doctor', { config: configPath })}; DECLARATION_UNCONFIRMED names the answers still to confirm`)
    }

    const ranAt = adapters.now().toISOString()
    const verdict = await observe(confirmation.observation, configPath, config, adapters)
    if (!verdict.passed) {
        const refused = refusalOutcome('CONFIRM_OBSERVATION_FAILED' satisfies typeof ENVIRONMENT_CODES.CONFIRM_OBSERVATION_FAILED,
            `${answer} stays unconfirmed: ${verdict.reason}; confirming it needs ${confirmation.verifies}`, answer,
            `clear the diagnostics reported beside this one, then run ${cockpitCommand('confirm', { config: configPath, operand: answer })} again; if the value itself is wrong, correct it in cockpit.toml first`)
        return { ...refused, diagnostics: [...refused.diagnostics, ...verdict.diagnostics] }
    }

    const root = dirname(configPath)
    const record: AnswerConfirmationRecord = { observation: confirmation.observation, ranAt, result: 'passed',
        evidenceSha256: sha256Hex(canonicalJson(verdict.evidence)), configurationSha256: confirmationConfigurationSha256(config) }
    const written = await writeCockpitLocalFiles(root, [{ name: 'answer-confirmations',
        bytes: encodeAnswerConfirmations({ ...parseAnswerConfirmations(await readConfirmations(root)), [answer]: record }) }])
    if (written.kind !== 'complete') {
        return refusalOutcome('CONFIRM_RECORD_UNWRITABLE' satisfies typeof ENVIRONMENT_CODES.CONFIRM_RECORD_UNWRITABLE,
            `the observation passed, but its record could not be written: ${written.message}; cockpit.toml was not changed`, ANSWER_CONFIRMATION_PATH,
            `make ${ANSWER_CONFIRMATION_PATH} writable for this user, then run ${cockpitCommand('confirm', { config: configPath, operand: answer })} again`)
    }

    const remaining = config.unconfirmed.filter(row => row !== answer)
    const expected = canonicalJson({ ...config, unconfirmed: remaining.length ? remaining : undefined })
    const exact = (candidate: unknown) => canonicalJson(candidate) === expected
    const rerun = `run ${cockpitCommand('confirm', { config: configPath, operand: answer })} again`
    const byHand = personConfirmationFix([answer], configPath)
    const edited = await writeVerifiedConfig({
        path: configPath, expectedSha256: loaded.result.source.sha256, temporaryTag: 'confirm',
        edit: text => {
            const edit = removeUnconfirmedAnswer(text, answer)
            return edit.kind === 'edited' ? edit.text : text
        },
        isExactChange: exact,
        messages: {
            changedBefore: { message: 'cockpit.toml changed while the observation ran; nothing was removed', fix: rerun },
            changedDuring: { message: 'cockpit.toml changed while the edit was being prepared; nothing was removed', fix: rerun },
            invalid: reason => ({ message: `removing ${answer} would leave cockpit.toml invalid (${reason}); nothing was removed`, fix: byHand }),
            notExact: { message: `cockpit.toml does not list ${answer} on one unconfirmed = [...] line this command can edit; nothing was removed`, fix: byHand },
            writtenMismatch: { message: `${answer} was removed, but re-reading cockpit.toml shows a change beyond it`,
                fix: `review cockpit.toml for the change you did not make before running ${cockpitCommand('sync', { config: configPath, args: '--dry-run' })}` },
        },
    })
    if (edited.kind !== 'complete') return refusalOutcome(edited.code, edited.message, configPath, edited.fix)

    const sync = cockpitCommand('sync', { config: configPath })
    return {
        status: 0, destination: null, diagnostics: [],
        artifact: `Confirmed ${answer}: ${confirmation.verifies}. Removed it from unconfirmed in ${configPath} and recorded the observation in ${ANSWER_CONFIRMATION_PATH}.\n`
            + `Run ${sync} to apply the edit; an agent may where [autonomy] sync = "agent", because the recorded observation makes the removal non-widening.\n`,
        result: { answer, observation: confirmation.observation, ranAt, outcome: 'passed', evidenceSha256: record.evidenceSha256,
            record: ANSWER_CONFIRMATION_PATH, unconfirmed: remaining, next: sync },
    }
}
