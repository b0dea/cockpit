/**
 * Owns the text edit `confirm` makes to cockpit.toml: drop one answer from the top-level
 * `unconfirmed = [...]` line, or the whole line once the list empties. Every other byte, comments
 * included, is left alone. The verified write re-parses the result and refuses anything beyond that
 * change; a layout this module cannot locate the list in (a multi-line array, a list inside a table)
 * is refused by name rather than guessed at.
 */
import { scanHeaders, type SiblingEdit } from './sibling-toml.js'

const UNCONFIRMED_KEY = /^\s*unconfirmed\s*=/
const SINGLE_LINE_ARRAY = /^(\s*unconfirmed\s*=\s*)\[([^\]#]*)\](\s*(?:#.*)?)$/

export function removeUnconfirmedAnswer(text: string, answer: string): SiblingEdit {
    const lines = text.split('\n')
    const firstHeader = scanHeaders(lines)[0]?.line ?? lines.length
    const keys = lines.slice(0, firstHeader).flatMap((row, index) => UNCONFIRMED_KEY.test(row) ? [index] : [])
    const at = keys[0]
    const current = at === undefined ? null : SINGLE_LINE_ARRAY.exec(lines[at]!)
    if (keys.length !== 1 || !current) {
        return { kind: 'unsupported', reason: 'the unconfirmed list is not written on one line as unconfirmed = [...] before the first table' }
    }
    const rows = current[2]!.split(',').map(row => row.trim()).filter(row => row !== '')
    const kept = rows.filter(row => row !== JSON.stringify(answer) && row !== `'${answer}'`)
    if (kept.length === rows.length) return { kind: 'unsupported', reason: `the unconfirmed list does not spell ${answer} as a plain string` }
    if (kept.length === 0) lines.splice(at!, 1)
    else lines[at!] = `${current[1]}[${kept.join(', ')}]${current[3]}`
    return { kind: 'edited', text: lines.join('\n') }
}
