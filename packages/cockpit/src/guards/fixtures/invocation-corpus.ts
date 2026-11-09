import type { ParsedInvocation, InvocationWord } from '../invocation-parser.js'

const rows = [
    { name: 'separate push', candidate: 'git push origin feature; git push origin main', control: 'git push origin feature; printf main', decision: 'deny' },
    { name: 'timeout values', candidate: 'timeout -s TERM -k 5 60 git reset --hard', control: 'printf "timeout -s TERM -k 5 60 git reset --hard"', decision: 'ask' },
    { name: 'nice adjustment', candidate: 'nice -n 10 git clean -fd', control: 'printf "nice -n 10 git clean -fd"', decision: 'ask' },
    { name: 'session detacher', candidate: 'setsid --wait nohup git push origin main', control: 'printf "setsid --wait nohup git push origin main"', decision: 'deny' },
    { name: 'environment cwd', candidate: 'env -C config git push origin main', control: 'printf "env -C config git push origin main"', decision: 'deny' },
    { name: 'refspec destination', candidate: 'git push origin +feature:refs/heads/main', control: 'git push origin main:refs/heads/feature', decision: 'deny' },
    { name: 'redirect data', candidate: 'curl https://db.example.test > output.txt', control: 'printf ok > db.example.test', decision: 'deny' },
    { name: 'quoted separator', candidate: 'printf "ok; still data"; git push origin main', control: 'printf "git push origin main; still data"', decision: 'deny' },
    { name: 'heredoc data', candidate: 'cat <<\'END\'\nsafe\nEND\ngit push origin main', control: 'cat <<\'END\'\ngit push origin main; db.example.test\nEND', decision: 'deny' },
    { name: 'brace boundaries', candidate: '{ git push origin feature; git push origin main; }', control: '{ git push origin feature; printf main; }', decision: 'deny' },
    { name: 'option decoy', candidate: 'git push --push-option=feature origin main', control: 'git push --push-option=main origin feature', decision: 'deny' },
    { name: 'function definition', candidate: 'ship() { git push origin main; }; ship', control: 'ship() { git push origin main; }; printf ok', decision: 'unavailable' },
    { name: 'alias definition', candidate: 'alias ship="git push origin main"\nship', control: 'alias ship="git push origin main"; printf ok', decision: 'unavailable' },
    { name: 'assignment host', candidate: 'DB_URL=https://db.example.test printf ok', control: 'printf "NOTE=git push origin main"', decision: 'deny' },
    { name: 'command variable', candidate: 'cmd=git; $cmd push origin main', control: "printf '$cmd push origin main'", decision: 'unavailable' },
    { name: 'variable indirection', candidate: 'cmd=git; name=cmd; ${!name} push origin main', control: "printf '${!name} push origin main'", decision: 'unavailable' },
    { name: 'command substitution', candidate: '$(printf git) push origin main', control: "printf '$(printf git) push origin main'", decision: 'unavailable' },
] as const

function expected(executable: string | null, argv: string[] = [], before: InvocationWord[] = [], wrapped = false): ParsedInvocation {
    return { executable, argv, cwd: '/workspace/project', wrapped, redirects: [], words: [
        ...before, ...(executable === null ? [] : [{ role: 'executable' as const, value: executable }]),
        ...argv.map((value) => ({ role: 'argument' as const, value })),
    ] }
}
const git = (...argv: string[]) => expected('git', argv)
const printf = (value: string) => expected('printf', [value])
const wrapper = (...values: string[]): InvocationWord[] => values.map((value) => ({ role: 'wrapper-option-value', value }))
const definition = (...values: string[]) => expected(null, [], values.map((value) => ({ role: 'definition', value })))
const here = (body: string) => expected('cat', [], [{ role: 'redirect-target', value: 'END' }, { role: 'heredoc-body', value: body }])
const redirect = (executable: string, argv: string[], target: string) => ({ ...expected(executable, argv, [{ role: 'redirect-target', value: target }]), redirects: [{ target, write: true, truncate: true }] })
const defined = 'Unsupported executable or defined command invocation.'
const dynamic = (word: string) => `Dynamic command construction is unsupported: ${JSON.stringify(word)} holds a variable, command substitution, glob, home-directory tilde or zsh =command whose expansion the guard cannot see. Write the command and its paths out literally.`
interface CapturePair { candidate: readonly ParsedInvocation[] | string; control: readonly ParsedInvocation[] }
const captures: Record<typeof rows[number]['name'], CapturePair> = {
    'separate push': { candidate: [git('push', 'origin', 'feature'), git('push', 'origin', 'main')], control: [git('push', 'origin', 'feature'), printf('main')] },
    'timeout values': { candidate: [expected('git', ['reset', '--hard'], wrapper('-s', 'TERM', '-k', '5', '60'), true)], control: [printf('timeout -s TERM -k 5 60 git reset --hard')] },
    'nice adjustment': { candidate: [expected('git', ['clean', '-fd'], wrapper('-n', '10'), true)], control: [printf('nice -n 10 git clean -fd')] },
    'session detacher': { candidate: [expected('git', ['push', 'origin', 'main'], wrapper('--wait'), true)], control: [printf('setsid --wait nohup git push origin main')] },
    'environment cwd': { candidate: [{ ...expected('git', ['push', 'origin', 'main'], wrapper('-C', 'config'), true), cwd: '/workspace/project/config' }], control: [printf('env -C config git push origin main')] },
    'refspec destination': { candidate: [git('push', 'origin', '+feature:refs/heads/main')], control: [git('push', 'origin', 'main:refs/heads/feature')] },
    'redirect data': { candidate: [redirect('curl', ['https://db.example.test'], 'output.txt')], control: [redirect('printf', ['ok'], 'db.example.test')] },
    'quoted separator': { candidate: [printf('ok; still data'), git('push', 'origin', 'main')], control: [printf('git push origin main; still data')] },
    'heredoc data': { candidate: [here('safe\n'), git('push', 'origin', 'main')], control: [here('git push origin main; db.example.test\n')] },
    'brace boundaries': { candidate: [git('push', 'origin', 'feature'), git('push', 'origin', 'main')], control: [git('push', 'origin', 'feature'), printf('main')] },
    'option decoy': { candidate: [git('push', '--push-option=feature', 'origin', 'main')], control: [git('push', '--push-option=main', 'origin', 'feature')] },
    'function definition': { candidate: defined, control: [definition('ship', 'git', 'push', 'origin', 'main', ';', '}'), printf('ok')] },
    'alias definition': { candidate: defined, control: [definition('alias', 'ship=git push origin main'), printf('ok')] },
    'assignment host': { candidate: [expected('printf', ['ok'], [{ role: 'environment-assignment-value', value: 'https://db.example.test', name: 'DB_URL' }])], control: [printf('NOTE=git push origin main')] },
    'command variable': { candidate: dynamic('$cmd'), control: [printf('$cmd push origin main')] },
    'variable indirection': { candidate: dynamic('${!name}'), control: [printf('${!name} push origin main')] },
    'command substitution': { candidate: dynamic('$(printf git)'), control: [printf('$(printf git) push origin main')] },
}
const protectedPush = 'Refusing push to a declared protected branch.'
const uncaptured = 'Guard input is unavailable or was not captured by the invocation parser.'
const destructive = 'Destructive Git operation requires human approval.'
const hosted = 'Refusing executable use of a declared hosted database host.'
const pathspec = 'Unproven Git staging pathspec grammar.'

export const invocationCorpus = [
    ...rows.map((row) => {
        const capture = captures[row.name]
        const witness = typeof capture.candidate === 'string' ? git('push', 'origin', 'main') : capture.candidate.at(-1)
        if (!witness) throw new Error(`Missing executable corpus witness: ${row.name}`)
        return { ...row, capture, witness,
            cause: row.decision === 'unavailable' ? uncaptured : row.decision === 'ask' ? destructive : ['redirect data', 'assignment host'].includes(row.name) ? hosted : protectedPush,
        }
    }),
    ...['config/*', 'config/active.*', 'config/active.?nstance', 'config/[a]ctive.instance', ':(glob)config/*'].map((path) => ({
        name: `unproven staging pathspec ${path}`, candidate: `git add '${path}'`, control: 'git add config/template', decision: 'unavailable' as const,
        capture: { candidate: [git('add', path)], control: [git('add', 'config/template')] }, cause: pathspec, witness: git('add', path),
    })),
]

export function shellPayload(command: string, cwd = '/workspace/project') {
    return { hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd, tool_input: { command } }
}

// Claude Code sends execution options beside the command on every Bash call.
export function nativeShellPayload(command: string, cwd = '/workspace/project') {
    return { hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd, tool_input: {
        command, description: 'Push the feature branch', timeout: 120000, run_in_background: false, dangerouslyDisableSandbox: false,
    } }
}
