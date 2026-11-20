/**
 * Compares a team's existing PreToolUse guard with cockpit's over the team's own guard cases, and
 * proposes `[[guards.deny]]` entries for what only the old guard refused. Pure: the application runs
 * both hooks and hands their answers here.
 */
import { posix } from 'node:path'
import { stringify as stringifyToml } from 'smol-toml'
import { exactKeys } from '../exact-keys.js'
import { Guards } from '../schema.js'
import { foldGuardProgram, type ParsedInvocation } from './invocation-parser.js'

/** One guard case, as `guard prove` reads them too: the command an agent would run and where. */
export interface GuardCase {
    readonly id: string
    readonly command: string
    /** Relative to the cockpit root; the root when absent. */
    readonly cwd?: string
    /** What the case expects of cockpit's guard; the comparison reports both guards' answers whatever it says. */
    readonly expect?: 'allow' | 'ask' | 'deny'
}

/** What a hook answered for one case, or why no answer could be read. */
export type HookVerdict = Readonly<{ decision: 'allow' | 'ask' | 'deny' | 'error'; reason: string }>

export interface ComparedCase {
    readonly case: GuardCase
    /** The absolute directory both hooks judged the command in. */
    readonly cwd: string
    readonly old: HookVerdict
    readonly cockpit: HookVerdict
}

export interface DenyProposal {
    readonly caseIds: readonly string[]
    readonly prefix: readonly string[]
    readonly reason: string
}

export interface GuardParity {
    readonly cases: number
    readonly bothRefuse: readonly ComparedCase[]
    readonly oldOnly: readonly ComparedCase[]
    readonly cockpitOnly: readonly ComparedCase[]
    readonly errors: readonly ComparedCase[]
    readonly proposals: readonly DenyProposal[]
    /** Old-only refusals no prefix entry can close without refusing a case the old guard allowed, each with why. */
    readonly unproposed: readonly Readonly<{ caseId: string; why: string }>[]
}

// Hundreds of cases is what a hand-maintained guard suite reaches; the bound only stops a runaway file.
const MAX_CASES = 4_096
const EXPECTATIONS = ['allow', 'ask', 'deny'] as const

/** Reads a JSON array of guard cases, refusing anything it would otherwise have to guess at. */
export function parseGuardCases(text: string): Readonly<{ cases: readonly GuardCase[] }> | Readonly<{ refusal: string }> {
    let value: unknown
    try { value = JSON.parse(text) }
    catch (error) { return { refusal: `the cases file is not JSON (${error instanceof Error ? error.message : 'parse error'})` } }
    if (!Array.isArray(value) || value.length === 0 || value.length > MAX_CASES) {
        return { refusal: `the cases file must hold a JSON array of 1 to ${MAX_CASES} cases, each {"id", "command", "cwd"?, "expect"?}` }
    }
    const cases: GuardCase[] = []
    const ids = new Set<string>()
    for (const [index, row] of value.entries()) {
        const name = typeof row?.id === 'string' && row.id !== '' ? `case ${JSON.stringify(row.id)}` : `case ${index + 1}`
        if (row === null || typeof row !== 'object' || Array.isArray(row) || !exactKeys(row, ['id', 'command'], ['cwd', 'expect'])) {
            return { refusal: `${name} must be an object with "id" and "command", and optionally "cwd" and "expect", and nothing else` }
        }
        const { id, command, cwd, expect } = row as Record<string, unknown>
        if (typeof id !== 'string' || id === '' || ids.has(id)) return { refusal: `${name} needs an "id" no other case uses` }
        if (typeof command !== 'string' || command.trim() === '') return { refusal: `${name} needs a non-empty "command"` }
        if (cwd !== undefined && (typeof cwd !== 'string' || cwd === '' || cwd.includes('\0'))) return { refusal: `${name} has a "cwd" that is not a directory path` }
        if (expect !== undefined && !EXPECTATIONS.includes(expect as never)) return { refusal: `${name} has "expect" ${JSON.stringify(expect)}; use "allow", "ask" or "deny"` }
        ids.add(id)
        cases.push({ id, command, ...cwd === undefined ? {} : { cwd: cwd as string }, ...expect === undefined ? {} : { expect: expect as NonNullable<GuardCase['expect']> } })
    }
    return { cases }
}

const oneLine = (text: string) => text.replace(/[\x00-\x1f\x7f-\x9f]+/g, ' ').replace(/\s+/g, ' ').trim()

/**
 * A PreToolUse hook's answer, read as Claude Code reads it: exit 2 refuses with stderr as the reason;
 * exit 0 answers through `hookSpecificOutput.permissionDecision`, the older `decision` and `reason`, or
 * `continue: false`, and otherwise leaves the call to the tool's own permissions. Claude Code runs a call
 * whose hook exits with any other status, but a hook that failed has not judged it, so that is an error here.
 */
export function readHookAnswer(run: Readonly<{ exitCode: number; stdout: string; stderr: string }>): HookVerdict {
    if (run.exitCode === 2) return { decision: 'deny', reason: oneLine(run.stderr) || 'exited 2 with no reason on stderr' }
    if (run.exitCode !== 0) return { decision: 'error', reason: `exited ${run.exitCode}${oneLine(run.stderr) ? `: ${oneLine(run.stderr)}` : ''}` }
    const text = run.stdout.trim()
    if (!text.startsWith('{')) return { decision: 'allow', reason: 'no decision; the tool\'s own permissions decide' }
    let answer: Record<string, unknown>
    try { answer = JSON.parse(text) }
    catch { return { decision: 'error', reason: 'printed output that starts like JSON but does not parse' } }
    const specific = answer.hookSpecificOutput as Record<string, unknown> | undefined
    const said = (value: unknown) => typeof value === 'string' && oneLine(value) ? oneLine(value) : undefined
    if (answer.continue === false) return { decision: 'deny', reason: said(answer.stopReason) ?? 'stopped the session (continue: false)' }
    const permission = specific?.permissionDecision
    if (permission === 'allow' || permission === 'ask' || permission === 'deny') {
        return { decision: permission, reason: said(specific?.permissionDecisionReason) ?? `answered ${permission} with no reason` }
    }
    if (answer.decision === 'block') return { decision: 'deny', reason: said(answer.reason) ?? 'answered block with no reason' }
    if (answer.decision === 'approve') return { decision: 'allow', reason: said(answer.reason) ?? 'answered approve' }
    return { decision: 'allow', reason: 'no decision; the tool\'s own permissions decide' }
}

/** The plain commands a command line runs, as cockpit's guard reads them; undefined for a form it does not read. */
export type ReadCommands = (command: string, cwd: string) => readonly ParsedInvocation[] | undefined

// The prefix half of the evaluator's declared-deny match: a bare program name refuses that program run
// by any path, and every later word must be spelled exactly.
function prefixMatches(prefix: readonly string[], words: readonly string[]): boolean {
    const program = foldGuardProgram(prefix[0]!)
    const first = words[0] === undefined ? undefined : foldGuardProgram(words[0])
    return first !== undefined && (first === program || posix.basename(first) === program)
        && prefix.every((word, index) => index === 0 || words[index] === word)
}

// A command line the guard does not read as plain commands is still refused by a declared deny that
// matches any run of its words, split as the evaluator splits that text.
function textWindows(command: string): readonly (readonly string[])[] {
    const words = command.split(/[\s;&|()<>`"'{}]+/).filter(Boolean)
    return words.map((_, at) => words.slice(at))
}

function validRule(prefix: readonly string[], reason: string): boolean {
    return Guards.safeParse({ deny: [{ prefix: [...prefix], reason }] }).success
}

/**
 * The comparison, and for each case only the old guard refused, the shortest `prefix` entry that
 * refuses it and no case the old guard let through. A rule starts at the program and its first argument,
 * since one naming a program alone refuses every use of it; reviewing the rule stays a person's job.
 */
export function guardParity(compared: readonly ComparedCase[], invocations: ReadCommands): GuardParity {
    const refused = (verdict: HookVerdict) => verdict.decision === 'deny'
    const errors = compared.filter(row => row.old.decision === 'error' || row.cockpit.decision === 'error')
    const judged = compared.filter(row => !errors.includes(row))
    const oldOnly = judged.filter(row => refused(row.old) && !refused(row.cockpit))
    // Every case the old guard let through, whatever cockpit answered, must stay unrefused by a proposal.
    const permitted = compared.filter(row => row.old.decision === 'allow' || row.old.decision === 'ask').flatMap(row => {
        const parsed = invocations(row.case.command, row.cwd)
        return parsed ? parsed.map(invocation => [invocation.executable!, ...invocation.argv]) : textWindows(row.case.command)
    })
    const proposals = new Map<string, { caseIds: string[]; prefix: readonly string[]; reason: string }>()
    const unproposed: { caseId: string; why: string }[] = []
    for (const row of oldOnly) {
        const parsed = invocations(row.case.command, row.cwd)
        if (!parsed?.length) {
            unproposed.push({ caseId: row.case.id, why: 'cockpit\'s guard does not read this shell form as plain commands, so no prefix can name it' })
            continue
        }
        // Which of several commands the old guard refused is not known, and a rule for the wrong one leaves the gap open.
        if (parsed.length > 1) {
            unproposed.push({ caseId: row.case.id, why: 'it runs several commands; split it into one case per command to see which the old guard refuses' })
            continue
        }
        const reason = oneLine(row.old.reason).slice(0, 512) || 'Refused by the previous guard.'
        let chosen: readonly string[] | undefined
        const words = [posix.basename(parsed[0]!.executable!), ...parsed[0]!.argv]
        for (let length = Math.min(2, words.length); length <= words.length && !chosen; length += 1) {
            const prefix = words.slice(0, length)
            if (validRule(prefix, reason) && !permitted.some(other => prefixMatches(prefix, other))) chosen = prefix
        }
        if (!chosen) {
            unproposed.push({ caseId: row.case.id, why: 'every prefix of it also refuses a case the old guard allowed, or cannot be written as a rule' })
            continue
        }
        const key = JSON.stringify(chosen)
        const existing = proposals.get(key)
        if (existing) existing.caseIds.push(row.case.id)
        else proposals.set(key, { caseIds: [row.case.id], prefix: chosen, reason })
    }
    return {
        cases: compared.length,
        bothRefuse: judged.filter(row => refused(row.old) && refused(row.cockpit)),
        oldOnly,
        cockpitOnly: judged.filter(row => !refused(row.old) && refused(row.cockpit)),
        errors,
        proposals: [...proposals.values()],
        unproposed,
    }
}

function cockpitAnswer(verdict: HookVerdict): string {
    return verdict.decision === 'allow' ? 'allowed' : verdict.decision === 'ask' ? `asks a person: ${verdict.reason}` : verdict.reason
}

/** The parity report a person reads, ending with the proposed entries to review and paste. */
export function renderGuardParity(parity: GuardParity): string {
    const lines = [`Replayed ${parity.cases} cases through both guards.`, '']
    const section = (title: string, rows: readonly ComparedCase[], detail: (row: ComparedCase) => string) => {
        lines.push(`${title} (${rows.length})`)
        for (const row of rows) lines.push(`  ${row.case.id}: ${row.case.command}`, `      ${detail(row)}`)
        lines.push('')
    }
    section('Refused by both', parity.bothRefuse, row => `cockpit: ${row.cockpit.reason}`)
    section('Refused only by the old guard: a gap, or a refusal you no longer want', parity.oldOnly,
        row => `old: ${row.old.reason} | cockpit: ${cockpitAnswer(row.cockpit)}`)
    section('Refused only by cockpit', parity.cockpitOnly, row => `cockpit: ${row.cockpit.reason}`)
    if (parity.errors.length) section('Not compared: a hook failed', parity.errors,
        row => `old: ${row.old.decision === 'error' ? row.old.reason : row.old.decision} | cockpit: ${row.cockpit.decision === 'error' ? row.cockpit.reason : row.cockpit.decision}`)
    // The entries come last, so everything after the heading pastes into cockpit.toml as it stands.
    for (const row of parity.unproposed) lines.push(`No entry proposed for ${row.caseId}: ${row.why}.`)
    if (parity.unproposed.length) lines.push('')
    if (parity.proposals.length) {
        lines.push('Proposed entries for cockpit.toml, to review before adding (nothing was written):', '')
        for (const proposal of parity.proposals) {
            lines.push(`# closes ${proposal.caseIds.join(', ')}`,
                stringifyToml({ guards: { deny: [{ prefix: [...proposal.prefix], reason: proposal.reason }] } }).trim(), '')
        }
    }
    return `${lines.join('\n').trimEnd()}\n`
}
