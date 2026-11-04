// Owns who may confirm each init answer listed under `unconfirmed`, and the record of the
// observations that confirmed one. A person keeps every answer that is a trust decision and every
// answer no observation settles exactly; an agent may confirm the rest with `cockpit confirm`, which
// runs the observation and records it here. The guard then lets the agent's own sync apply the
// removed entry, but only while the record matches the configuration on disk.
//
// The record is machine-local, under `.cockpit/local`: the observation is evidence about this machine
// and its running stack, which another clone has not seen, so there a removed entry still waits for a
// person. The directory is a guard control directory, so no agent tool call may write it; only the
// cockpit process that ran the observation does.
import { canonicalJson } from '../canonical-json.js'
import { exactKeys } from '../exact-keys.js'
import { cockpitCommand } from '../fix-catalogue.js'
import { UNCONFIRMABLE_ANSWERS, type CockpitConfig } from '../schema.js'
import { sha256Hex } from '../sha256.js'
import { GUARD_LOCAL_PATHS } from './local-identity.js'

export type UnconfirmedAnswerName = typeof UNCONFIRMABLE_ANSWERS[number]
export type ConfirmingObservation = 'preflight' | 'check' | 'runtime-floor'

export type AnswerConfirmation =
    | Readonly<{ by: 'observation'; observation: ConfirmingObservation; verifies: string }>
    | Readonly<{ by: 'person'; trustDecision: boolean; why: string }>

export const ANSWER_CONFIRMATIONS: Readonly<Record<UnconfirmedAnswerName, AnswerConfirmation>> = Object.freeze({
    'ports.bases': { by: 'observation', observation: 'preflight',
        verifies: 'preflight passes with the stack up, its port family leased on the declared bases and every listener and health observation passing' },
    'environment.compose_files': { by: 'observation', observation: 'check',
        verifies: 'check passes, which parses the declared Compose files with docker compose config and resolves the stack\'s topology from them' },
    'environment.machine': { by: 'observation', observation: 'runtime-floor',
        verifies: 'the container runtime measured on this machine meets the declared memory, CPU and free-disk floor' },
    guards: { by: 'person', trustDecision: true, why: 'it sets which commands and hosts the guard denies' },
    testing: { by: 'person', trustDecision: true, why: 'it decides which tests grade the agent\'s own work' },
    'environment.install_policies': { by: 'person', trustDecision: true, why: 'it sets the build and test commands the guard admits' },
    sibling: { by: 'person', trustDecision: true, why: 'it sets each repository\'s purpose and the roots agents may write' },
    'environment.posture': { by: 'person', trustDecision: true, why: 'it decides browser preapproval and what data agents are exposed to' },
    'cockpit.name': { by: 'person', trustDecision: false,
        why: 'a name is a choice, and no observation shows it is the one the owner wants; it scopes Compose projects, state and generated files' },
    'estate.runnable': { by: 'person', trustDecision: false,
        why: 'a stack that starts shows the declared services run, not that a repository declared not runnable should stay out' },
    'environment.test_data': { by: 'person', trustDecision: false,
        why: 'it states what local work needs (seeded data, signed-in users), and no observation shows a need is absent' },
})

export const ANSWER_CONFIRMATION_PATH = `${GUARD_LOCAL_PATHS.directory}/answer-confirmations`
const FORMAT = 'cockpit-answer-confirmations/v1'
const RECORD_KEYS = ['observation', 'ranAt', 'result', 'evidenceSha256', 'configurationSha256'] as const
const SHA256 = /^[a-f0-9]{64}$/
const TIMESTAMP = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/

export type AnswerConfirmationRecord = Readonly<{
    observation: ConfirmingObservation
    ranAt: string
    result: 'passed'
    evidenceSha256: string
    configurationSha256: string
}>
type Records = Readonly<Partial<Record<UnconfirmedAnswerName, AnswerConfirmationRecord>>>

/**
 * The digest a record binds to: the whole configuration except the `unconfirmed` list, so confirming
 * one answer leaves the records of the others current, and any other edit leaves every record stale.
 */
export function confirmationConfigurationSha256(config: CockpitConfig): string {
    const { unconfirmed: _unconfirmed, ...observed } = config
    return sha256Hex(canonicalJson(observed))
}

function validRecord(answer: string, value: unknown): value is AnswerConfirmationRecord {
    const confirmation = ANSWER_CONFIRMATIONS[answer as UnconfirmedAnswerName]
    if (!confirmation || confirmation.by !== 'observation' || value === null || typeof value !== 'object' || Array.isArray(value)) return false
    const row = value as Record<string, unknown>
    return exactKeys(row, RECORD_KEYS) && row.observation === confirmation.observation && row.result === 'passed'
        && typeof row.ranAt === 'string' && TIMESTAMP.test(row.ranAt) && Number.isFinite(Date.parse(row.ranAt))
        && typeof row.evidenceSha256 === 'string' && SHA256.test(row.evidenceSha256)
        && typeof row.configurationSha256 === 'string' && SHA256.test(row.configurationSha256)
}

/** Every well-formed record the bytes hold, or none when they are absent or not a current-format file. */
export function parseAnswerConfirmations(bytes: Uint8Array | undefined): Records {
    if (!bytes) return {}
    let value: unknown
    try { value = JSON.parse(Buffer.from(bytes).toString('utf8')) }
    catch (error) {
        if (error instanceof SyntaxError) return {}
        throw error
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
    const file = value as Record<string, unknown>
    const confirmations = file.confirmations
    if (!exactKeys(file, ['format', 'confirmations']) || file.format !== FORMAT
        || confirmations === null || typeof confirmations !== 'object' || Array.isArray(confirmations)) return {}
    return Object.fromEntries(Object.entries(confirmations).filter(([answer, row]) => validRecord(answer, row)))
}

export function encodeAnswerConfirmations(records: Records): string {
    return `${JSON.stringify({ format: FORMAT, confirmations: records }, null, 2)}\n`
}

/**
 * The answers whose recorded observation passed against exactly `config`. A missing, malformed or
 * stale record confirms nothing, and no record confirms an answer only a person may.
 */
export function confirmedAnswers(bytes: Uint8Array | undefined, config: CockpitConfig): ReadonlySet<string> {
    const digest = confirmationConfigurationSha256(config)
    return new Set(Object.entries(parseAnswerConfirmations(bytes))
        .filter(([, row]) => row.configurationSha256 === digest).map(([answer]) => answer))
}

export function isUnconfirmedAnswerName(value: string): value is UnconfirmedAnswerName {
    return (UNCONFIRMABLE_ANSWERS as readonly string[]).includes(value)
}

/** The confirmation a person makes, for the answers only a person may confirm. */
export function personConfirmationFix(answers: readonly string[], configPath?: string): string {
    return `a person confirms ${answers.join(', ')} with whoever owns the product, corrects cockpit.toml if a value is wrong, deletes ${answers.length === 1 ? 'its entry' : 'each entry'} from unconfirmed, then runs ${cockpitCommand('sync', configPath === undefined ? {} : { config: configPath })} in a terminal outside the agent`
}

/** How each listed answer is confirmed: the observation an agent runs, or the person who must. */
export function unconfirmedFix(answers: readonly UnconfirmedAnswerName[]): string {
    const observed = answers.flatMap(answer => {
        const confirmation = ANSWER_CONFIRMATIONS[answer]
        return confirmation.by === 'observation'
            ? [`run ${cockpitCommand('confirm', { operand: answer })}, which confirms ${answer} only if ${confirmation.verifies}`] : []
    })
    const person = answers.filter(answer => ANSWER_CONFIRMATIONS[answer].by === 'person')
    return [...observed, ...person.length ? [personConfirmationFix(person)] : []].join('; ')
}
