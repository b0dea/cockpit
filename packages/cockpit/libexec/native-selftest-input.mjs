import { dirname, join } from 'node:path'
import { parseDocument } from 'yaml'

export const MODEL_INPUT_PROTOCOLS = ['claude-model-input/v1', 'codex-skill-input/v1']

// The lines Claude reads as instructions: outside fenced code blocks and HTML comments, each without
// its line ending. Sync's adoption rule, the sibling projection and the probe all read files this way.
export function claudeActiveLines(bytes) {
    const active = []
    let fence
    let inComment = false
    for (const [index, raw] of bytes.split('\n').entries()) {
        const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
        const trimmed = line.trimStart()
        const marker = /^ {0,3}(?<fence>`{3,}|~{3,})(?<suffix>.*)$/u.exec(line)?.groups
        if (fence) {
            if (marker?.fence?.[0] === fence.marker && marker.fence.length >= fence.length && marker.suffix?.trim() === '') fence = undefined
            continue
        }
        if (inComment) {
            if (trimmed.includes('-->')) inComment = false
            continue
        }
        if (trimmed.startsWith('<!--')) {
            if (!trimmed.includes('-->')) inComment = true
            continue
        }
        if (marker?.fence && (marker.fence[0] !== '`' || !marker.suffix?.includes('`'))) {
            fence = { marker: marker.fence[0], length: marker.fence.length }
            continue
        }
        active.push({ index, line })
    }
    return active
}

// An `@` token starting a word, outside code spans, that names a file: a path with a directory part,
// a home or relative prefix, or a file extension. Prose such as "ask @oncall" names no file.
const IMPORT_TOKEN = /(^|\s)@([^\s`]+)/g
const importPath = path => /^(?:~|\/|\.{1,2}\/)/.test(path) || path.includes('/') || /\.[A-Za-z0-9]+$/.test(path)

/** The bytes with each active file import replaced by what `replace` returns for its path; undefined keeps it. */
export function mapClaudeImports(bytes, replace) {
    const active = new Set(claudeActiveLines(bytes).map(row => row.index))
    return bytes.split('\n').map((line, index) => !active.has(index) ? line : line.split(/(`+[^`]*`+)/).map((part, segment) =>
        segment % 2 === 1 ? part : part.replace(IMPORT_TOKEN, (token, lead, path) => {
            if (!importPath(path)) return token
            const replaced = replace(path)
            return replaced === undefined ? token : `${lead}${replaced}`
        })).join('')).join('\n')
}

/** Every file Claude would import from these bytes, in order. */
export function claudeImportPaths(bytes) {
    const paths = []
    mapClaudeImports(bytes, path => { paths.push(path) })
    return paths
}

// The guide's AGENTS.md reaches Claude through exactly one line importing it. Whether any other token
// would import a file depends on what exists where the file lives; the probe judges that before it runs.
export function nativeClaudeImport(bytes) {
    return claudeActiveLines(bytes).filter(row => row.line === '@AGENTS.md').length === 1
}

export function nativeClaudeContent(bytes) {
    // Claude removes standalone HTML comment lines before delivering imported instructions, as measured
    // with cockpit's own markers. Only that shape is normalized; any other transformation fails comparison.
    return bytes.replace(/^<!--[^\n]*-->\r?\n(?:[ \t]*\r?\n)*/gm, '').trim()
}

/** Whether the bytes hold an HTML comment the probe cannot reproduce Claude's removal of: one spanning lines. */
export function foreignClaudeComment(bytes) {
    return /^[ \t]*<!--/m.test(nativeClaudeContent(bytes))
}

export function nativeInputSettings(cwd) {
    const claudeMdExcludes = [join(cwd, 'CLAUDE.local.md'), join(cwd, '.claude', 'CLAUDE.md'), join(cwd, '.claude', 'rules', '**')]
    for (let parent = dirname(cwd); ; parent = dirname(parent)) {
        claudeMdExcludes.push(join(parent, 'CLAUDE.md'), join(parent, 'CLAUDE.local.md'), join(parent, '.claude', 'CLAUDE.md'), join(parent, '.claude', 'rules', '**'))
        if (dirname(parent) === parent) break
    }
    return `${JSON.stringify({ claudeMdExcludes })}\n`
}

export function nativeInputInvocation(target, skill) {
    if (target === 'claudecode') return ['{executable}', '--print', '--output-format', 'stream-json', '--verbose',
        '--no-session-persistence', '--setting-sources', 'project', '--strict-mcp-config', '--permission-prompts', 'none', '--settings', '{native-settings}',
        '--tools', '', '--', skill ? `/${skill}` : 'Do not run tools.']
    return ['{executable}', 'exec', '--json', '--ephemeral', '--skip-git-repo-check',
        '-c', 'model="cockpit-selftest"', '-c', 'model_provider="cockpit_selftest"',
        '-c', 'model_providers.cockpit_selftest.name="Cockpit selftest"',
        '-c', 'model_providers.cockpit_selftest.base_url="{model-endpoint}"',
        '-c', 'model_providers.cockpit_selftest.wire_api="responses"',
        '-c', 'model_providers.cockpit_selftest.requires_openai_auth=false', `$${skill}`]
}

export function nativeSkillBody(bytes) {
    const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(bytes)
    if (!match) return undefined
    const document = parseDocument(match[1], { uniqueKeys: true })
    if (document.errors.length) return undefined
    let metadata
    try { metadata = document.toJS({ maxAliasCount: 0 }) } catch { return undefined }
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return undefined
    // A measurement must never execute dynamic skill context or spawn an agent while loading a body.
    if (['hooks', 'context', 'agent', 'model'].some(key => Object.hasOwn(metadata, key))
        || metadata['user-invocable'] === false || /!`|\$ARGUMENTS|\$\{CLAUDE_(?:SKILL|PROJECT)_DIR\}/.test(match[2])) return undefined
    return match[2]
}

function userTexts(request, target) {
    const messages = target === 'claudecode' ? request?.messages : request?.input
    if (!Array.isArray(messages)) return []
    return messages.filter(message => message?.role === 'user' && (target === 'claudecode' || message.type === 'message'))
        .flatMap(message => Array.isArray(message.content) ? message.content : [])
        .filter(block => block?.type === (target === 'claudecode' ? 'text' : 'input_text') && typeof block.text === 'string')
        .map(block => block.text)
}

export function validateNativeModelInputPair({ target, skill, candidateInput, brokenInput, candidatePath, brokenPath,
    candidateBytes, brokenBytes, brokenStdout, brokenStderr }) {
    if (![candidateInput, brokenInput, candidatePath, brokenPath, candidateBytes, brokenBytes, brokenStdout, brokenStderr]
        .every(value => typeof value === 'string')) return 'native model input evidence fields must be strings'
    let candidate, broken
    try { candidate = JSON.parse(candidateInput); broken = JSON.parse(brokenInput) } catch { return 'native model inputs must be JSON request arrays' }
    if (!Array.isArray(candidate) || candidate.length !== 1 || !Array.isArray(broken)
        || broken.length !== (target === 'claudecode' && skill ? 0 : 1)) return 'native model input did not capture exactly the expected requests'
    const left = userTexts(candidate[0], target), right = userTexts(broken[0], target)
    if (!skill) {
        const contains = (texts, path, bytes) => texts.filter(text => text.startsWith('<system-reminder>\n')
            && text.includes(`Contents of ${path} (project instructions, checked into the codebase):\n\n${nativeClaudeContent(bytes)}\n`)
            && text.trimEnd().endsWith('</system-reminder>')).length === 1
        if (!/^Cockpit selftest replacement control [a-f0-9]{24}\.\n$/.test(brokenBytes)
            || !contains(left, candidatePath, candidateBytes) || !contains(right, brokenPath, brokenBytes)
            || left.some(text => text.includes(brokenBytes.trim())) || right.some(text => text.includes(nativeClaudeContent(candidateBytes)))) {
            return 'native Claude input did not independently load the exact candidate and replacement instructions'
        }
    } else if (target === 'codexcli') {
        const expected = `<skill>\n<name>${skill}</name>\n<path>${candidatePath}</path>\n${candidateBytes}\n</skill>`
        if (left.filter(text => text === expected).length !== 1 || right.some(text => text.startsWith('<skill>\n'))
            || !/^Cockpit selftest replacement control [a-f0-9]{24}\.\n$/.test(brokenBytes)
            || !brokenStderr.includes(`failed to load skill ${brokenPath}: missing YAML frontmatter delimited by ---`)) {
            return 'native Codex input did not load the exact skill and name its rejected broken control'
        }
    } else {
        const body = nativeSkillBody(candidateBytes)
        const expected = `Base directory for this skill: ${dirname(candidatePath)}\n\n${body}`
        const replacement = `---\nname: ${skill}\ndescription: Cockpit selftest broken control.\nuser-invocable: false\n---\n`
        let results
        try { results = brokenStdout.trim().split('\n').map(line => JSON.parse(line)).filter(row => row?.type === 'result') } catch { results = [] }
        if (!body || left.filter(text => text === expected).length !== 1 || !brokenBytes.startsWith(replacement)
            || !/^Cockpit selftest replacement control [a-f0-9]{24}\.\n$/.test(brokenBytes.slice(replacement.length))
            || results.length !== 1 || results[0].result !== `This skill can only be invoked by Claude, not directly by users. Ask Claude to use the "${skill}" skill for you.`) {
            return 'native Claude input did not load the exact skill body and name its non-invocable broken control'
        }
    }
    return null
}
