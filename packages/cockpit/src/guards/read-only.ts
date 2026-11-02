// Owns the built-in read-only invocation profile: which exact argument shapes of a few inspection
// commands only read, and which paths each one reads, searches or lists. Agents run these
// constantly, and an ask that Codex and OpenCode turn into a deny strands them. It performs no I/O
// and grants nothing alone: the evaluator inspects every returned path, applies every hard denial
// first, and allows a whole command only when every segment is classified here.
import { posix } from 'node:path'
import type { ParsedInvocation } from './invocation-parser.js'

export const mechanism = {
    id: 'guard-read-only-profile', module: 'packages/cockpit/src/guards/read-only.ts',
    exports: ['classifyReadOnlyInvocation', 'cockpitLauncherPrefix'],
} as const

/** Paths are as written; `cwd` is where they resolve, after any `git -C`. */
export interface ReadOnlyAccess {
    readonly cwd: string
    /** Files whose content the command prints or counts. */
    readonly reads: readonly string[]
    /** Directories whose files' content the command searches recursively. */
    readonly trees: readonly string[]
    /** Paths whose names or metadata the command reports, never their content. */
    readonly listings: readonly string[]
    /** Paths that must exist, relative to `cwd`, for the command to be read-only. */
    readonly requires?: readonly string[]
}

type Classified = Omit<ReadOnlyAccess, 'cwd'> | undefined

// One table of option shapes per command. Anything absent is not read-only, so an unknown or
// newly added option (`rg --pre`, `find -exec`, `fd --exec`, `git diff --output`) falls back to
// the ordinary rules instead of being allowed.
interface OptionTable {
    readonly flags: ReadonlySet<string>
    readonly values: ReadonlySet<string>
    /** Value options whose operand is a file the command reads. */
    readonly fileValues?: ReadonlySet<string>
    /** Long options whose value is optional and therefore only ever attached with `=`. */
    readonly attachedOnly?: ReadonlySet<string>
    /** Value options whose operand must be a count, so it cannot smuggle a path or a program. */
    readonly countValues?: ReadonlySet<string>
    /** Value options admitted only as a `!` exclusion, because any other value can widen what is read. */
    readonly exclusionValues?: ReadonlySet<string>
    /** Short flags that may be clustered, as in `-in`. */
    readonly cluster?: RegExp
}

const set = (...values: string[]) => new Set(values)

interface Options { readonly positionals: string[]; readonly present: Set<string>; readonly files: string[] }

function parseOptions(argv: readonly string[], table: OptionTable): Options | undefined {
    const positionals: string[] = []
    const present = new Set<string>()
    const files: string[] = []
    let options = true
    for (let index = 0; index < argv.length; index++) {
        const word = argv[index]!
        if (!options || word === '-' || !word.startsWith('-')) { positionals.push(word); continue }
        if (word === '--') { options = false; continue }
        const long = word.startsWith('--')
        const equals = long ? word.indexOf('=') : -1
        // `-n5` attaches a short option's value; `--lines=5` attaches a long one's.
        const name = long ? (equals < 0 ? word : word.slice(0, equals)) : table.values.has(word.slice(0, 2)) ? word.slice(0, 2) : word
        if (table.values.has(name)) {
            const value = long ? (equals < 0 ? argv[++index] : word.slice(equals + 1)) : word.length > 2 ? word.slice(2) : argv[++index]
            if (value === undefined || table.countValues?.has(name) && !/^[+-]?\d+[bkKmMgG]?$/.test(value)
                || table.exclusionValues?.has(name) && !value.startsWith('!')) return undefined
            if (table.fileValues?.has(name)) files.push(value)
            present.add(name)
        } else if (long && table.attachedOnly?.has(name)) present.add(name)
        else if (equals < 0 && table.flags.has(word)) present.add(word)
        else if (equals < 0 && table.cluster?.test(word)) for (const flag of word.slice(1)) present.add(`-${flag}`)
        else return undefined
    }
    return { positionals, present, files }
}

const LS: OptionTable = { flags: set('--all', '--almost-all', '--classify', '--human-readable', '--recursive', '--reverse'), values: set(), attachedOnly: set('--color'), cluster: /^-[1aAbBcCdFfghiklLmnopqrRsStTuUvwxX@]+$/ }
const CAT: OptionTable = { flags: set('--number', '--number-nonblank', '--show-all', '--show-ends', '--show-tabs', '--squeeze-blank'), values: set(), cluster: /^-[AbeEnstTuv]+$/ }
// `tail -f` never exits, so following is absent; `head -5` is the legacy count spelling.
const HEAD_TAIL: OptionTable = { flags: set('-q', '-v', '--quiet', '--silent', '--verbose'), values: set('-n', '-c', '--lines', '--bytes'),
    countValues: set('-n', '-c', '--lines', '--bytes'), cluster: /^-\d+$/ }
const WC: OptionTable = { flags: set('--bytes', '--chars', '--lines', '--words', '--max-line-length'), values: set(), cluster: /^-[clmwL]+$/ }
const GREP: OptionTable = {
    flags: set('--recursive', '--dereference-recursive', '--ignore-case', '--invert-match', '--word-regexp', '--line-regexp', '--count',
        '--files-with-matches', '--files-without-match', '--line-number', '--no-filename', '--with-filename', '--only-matching', '--quiet', '--silent',
        '--no-messages', '--fixed-strings', '--extended-regexp', '--basic-regexp', '--perl-regexp', '--null', '--text'),
    values: set('-e', '--regexp', '-f', '--file', '-A', '-B', '--after-context', '--before-context', '-m', '--max-count',
        '--include', '--exclude', '--exclude-dir'),
    fileValues: set('-f', '--file'),
    countValues: set('-A', '-B', '--after-context', '--before-context', '-m', '--max-count'),
    // A misread optional value would swallow the next word, so a file operand would go uninspected.
    // BSD grep, the macOS default, takes `-C` and `--context` values only attached, unlike GNU grep.
    attachedOnly: set('--color', '--colour', '--context'),
    cluster: /^-[iIvwxclLnhHoqsrRFEGPaZz]+$/,
}
// Hidden, ignored, compressed and symlink-following searches widen what is read past what the
// declared protections can see, and `--pre` and `--hostname-bin` run programs, so none is listed.
// A glob that is not an exclusion overrides the hidden and ignore filters: `rg -g '.env*' KEY`
// prints a hidden `.env.local`, and `rg -g '*.ts'` an ignored file.
const RG: OptionTable = {
    flags: set('--ignore-case', '--smart-case', '--case-sensitive', '--word-regexp', '--line-regexp', '--invert-match', '--line-number',
        '--no-line-number', '--files-with-matches', '--files-without-match', '--count', '--count-matches', '--fixed-strings', '--with-filename',
        '--no-filename', '--only-matching', '--quiet', '--files', '--no-heading', '--heading', '--vimgrep', '--json', '--column', '--trim', '--stats'),
    values: set('-e', '--regexp', '-f', '--file', '-g', '--glob', '--iglob', '-t', '--type', '-T', '--type-not', '-A', '-B', '-C',
        '--after-context', '--before-context', '--context', '-m', '--max-count', '-d', '--max-depth', '--max-filesize', '-M', '--max-columns',
        '--sort', '--sortr', '--color', '--colors'),
    fileValues: set('-f', '--file'),
    countValues: set('-A', '-B', '-C', '--after-context', '--before-context', '--context', '-m', '--max-count', '-d', '--max-depth'),
    exclusionValues: set('-g', '--glob', '--iglob'),
    cluster: /^-[iSswxvnNlcFHIoqp]+$/,
}
const FD: OptionTable = {
    flags: set('--hidden', '--no-ignore', '--case-sensitive', '--ignore-case', '--glob', '--regex', '--fixed-strings', '--absolute-path', '--print0', '--full-path'),
    values: set('-t', '--type', '-e', '--extension', '-d', '--max-depth', '--min-depth', '-E', '--exclude', '--max-results', '--color'),
    cluster: /^-[HIsigFap01]+$/,
}
const FIND_VALUE = set('-name', '-iname', '-path', '-ipath', '-wholename', '-iwholename', '-regex', '-iregex', '-type', '-maxdepth', '-mindepth',
    '-mtime', '-mmin', '-atime', '-amin', '-ctime', '-cmin', '-size', '-user', '-group', '-perm', '-newer')
const FIND_FLAG = set('-print', '-print0', '-prune', '-empty', '-not', '!', '-a', '-and', '-o', '-or', '(', ')', '-depth', '-xdev', '-mount', '-true', '-false')

function find(argv: readonly string[]): Classified {
    let index = 0
    const roots: string[] = []
    while (index < argv.length && !argv[index]!.startsWith('-') && argv[index] !== '!' && argv[index] !== '(') roots.push(argv[index++]!)
    const listings = roots.length ? [...roots] : ['.']
    for (; index < argv.length; index++) {
        const word = argv[index]!
        if (FIND_FLAG.has(word)) continue
        if (!FIND_VALUE.has(word) || argv[index + 1] === undefined) return undefined
        if (word === '-newer') listings.push(argv[index + 1]!)
        index++
    }
    return { reads: [], trees: [], listings }
}

function search(argv: readonly string[], table: OptionTable, recursiveByDefault: boolean): Classified {
    const parsed = parseOptions(argv, table)
    if (!parsed) return undefined
    const listOnly = parsed.present.has('--files')
    const explicitPattern = ['-e', '--regexp', '-f', '--file'].some(name => parsed.present.has(name))
    const operands = listOnly || explicitPattern ? parsed.positionals : parsed.positionals.slice(1)
    if (!listOnly && !explicitPattern && parsed.positionals.length === 0) return undefined
    const recursive = recursiveByDefault || ['-r', '-R', '--recursive', '--dereference-recursive'].some(name => parsed.present.has(name))
    // grep follows symlinks only with -R; that reads through links the inspection never sees.
    if (parsed.present.has('-R') || parsed.present.has('--dereference-recursive')) return undefined
    const paths = operands.length ? operands : recursive ? ['.'] : []
    if (listOnly) return { reads: parsed.files, trees: [], listings: paths }
    return recursive ? { reads: parsed.files, trees: paths, listings: [] } : { reads: [...parsed.files, ...paths], trees: [], listings: [] }
}

function files(argv: readonly string[], table: OptionTable): Classified {
    const parsed = parseOptions(argv, table)
    return parsed && { reads: parsed.positionals, trees: [], listings: [] }
}

const GIT_READ_VERBS = set('status', 'diff', 'log', 'show')

// Git discovers an implicit bare repository in any directory holding HEAD, objects and refs, and runs
// programs its config names, so read-only Git runs only where `.git` exists: discovery takes it before
// the directory itself, and nothing under `.git` is agent-writable.
function git(argv: readonly string[], cwd: string): ReadOnlyAccess | undefined {
    let index = 0
    let directory = cwd
    // `-c`, `--git-dir` and friends change which configuration runs; only -C and paging are exact.
    while (argv[index]?.startsWith('-')) {
        const option = argv[index++]!
        if (option === '-C' && argv[index] !== undefined) directory = posix.resolve(directory, argv[index++]!)
        else if (option !== '--no-pager') return undefined
    }
    const verb = argv[index++]
    const args = argv.slice(index)
    const requires = ['.git']
    if (verb === 'branch') return args.length === 0 || args.length === 1 && args[0] === '--list' ? { cwd: directory, reads: [], trees: [], listings: [], requires } : undefined
    if (verb === undefined || !GIT_READ_VERBS.has(verb)) return undefined
    // --output writes a file, an external diff driver runs a program, and --no-index prints any file.
    if (args.some(arg => /^--(?:output|ext-diff|textconv|no-index)(?:=|$)/.test(arg))) return undefined
    // Revision operands that name a blob (`HEAD:path`) print content the path inspection cannot see.
    if (args.some(arg => !arg.startsWith('-') && arg.includes(':'))) return undefined
    // Operands may be pathspecs whose content is printed, and a path outside the repository turns
    // `git diff` into a file comparison, so every operand is inspected as a read.
    return { cwd: directory, reads: args.filter(arg => !arg.startsWith('-')), trees: [], listings: [], requires }
}

/**
 * How many leading words of `argv` belong to the launcher when `executable` may start cockpit, or
 * undefined when it cannot: the bare `cockpit` name, a path, `node <path>`, and `npx --no [--]
 * cockpit`. Every spelling is a candidate only; the application proves which one starts the guard's
 * own installed cockpit, so all of them are judged by that one identity.
 */
export function cockpitLauncherPrefix(executable: string, argv: readonly string[]): number | undefined {
    if (executable === 'cockpit' || executable.includes('/')) return 0
    // `node --require … launcher` would run other code first, so the script must come first.
    if (executable === 'node') return argv[0]?.includes('/') && !argv[0].startsWith('-') ? 1 : undefined
    // Without --no, npx downloads and runs a missing package; any other npx option chooses the
    // package, the command or the shell. npx also reads every option before the first operand after
    // the package name as its own, so `npx --no cockpit --script-shell=… doctor` runs another program.
    if (executable !== 'npx' || argv[0] !== '--no') return undefined
    if (argv[1] === '--') return argv[2] === 'cockpit' ? 3 : undefined
    return argv[1] === 'cockpit' && argv[2] !== undefined && !argv[2].startsWith('-') ? 2 : undefined
}

const COCKPIT_READ_VERBS = set('check', 'doctor')

// Help and version print and exit before any command runs; `<verb> --help` and, for a command
// group, `<group> <subcommand> --help` do the same.
function cockpit(argv: readonly string[]): Classified {
    if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '--version')
        || argv.length >= 2 && argv.length <= 3 && argv.at(-1) === '--help' && argv.slice(0, -1).every(word => /^[a-z][a-z-]*$/.test(word))) {
        return { reads: [], trees: [], listings: [] }
    }
    const [verb, ...rest] = argv
    if (verb === undefined || !COCKPIT_READ_VERBS.has(verb)) return undefined
    const parsed = parseOptions(rest, { flags: set('--json'), values: set('--config'), fileValues: set('--config') })
    return parsed && parsed.positionals.length === 0 ? { reads: parsed.files, trees: [], listings: [] } : undefined
}

/**
 * The paths an exact read-only invocation touches, or undefined when it is not one. `cockpit` holds
 * the cockpit arguments only when the application proved the invocation starts the installed cockpit.
 */
export function classifyReadOnlyInvocation(invocation: ParsedInvocation, environment: { readonly ripgrepConfigActive: boolean; readonly cockpit?: readonly string[] } = { ripgrepConfigActive: false }): ReadOnlyAccess | undefined {
    if (invocation.executable === null || invocation.wrapped || invocation.redirects.some(redirect => redirect.write)
        || invocation.words.some(word => word.role === 'environment-assignment-value')) return undefined
    const argv = invocation.argv
    const inputs = invocation.redirects.map(redirect => redirect.target)
    const shape = (classified: Classified): ReadOnlyAccess | undefined =>
        classified && { cwd: invocation.cwd, ...classified, reads: [...classified.reads, ...inputs] }
    if (environment.cockpit) return shape(cockpit(environment.cockpit))
    switch (invocation.executable) {
        case 'pwd': return argv.length === 0 || argv.length === 1 && ['-L', '-P'].includes(argv[0]!) ? shape({ reads: [], trees: [], listings: [] }) : undefined
        case 'ls': {
            const parsed = parseOptions(argv, LS)
            return parsed && shape({ reads: [], trees: [], listings: parsed.positionals.length ? parsed.positionals : ['.'] })
        }
        case 'cat': return shape(files(argv, CAT))
        case 'head': case 'tail': return shape(files(argv, HEAD_TAIL))
        case 'wc': return shape(files(argv, WC))
        case 'grep': return shape(search(argv, GREP, false))
        case 'rg': return environment.ripgrepConfigActive ? undefined : shape(search(argv, RG, true))
        case 'fd': {
            const parsed = parseOptions(argv, FD)
            return parsed && shape({ reads: [], trees: [], listings: parsed.positionals.length > 1 ? parsed.positionals.slice(1) : ['.'] })
        }
        case 'find': return shape(find(argv))
        case 'git': {
            const access = git(argv, invocation.cwd)
            return access && inputs.length === 0 ? access : undefined
        }
        default: return undefined
    }
}
