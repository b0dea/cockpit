import { sha256Hex } from '../sha256.js'
import { isAbsolute, relative, resolve } from 'node:path'
import { z } from 'zod'
import { parseDocument } from 'yaml'

import { INHERITED_TOOL_ENVIRONMENT, snapshotJson, tryParseJson } from '../environment/contract.js'
import { reservedPathSegment, SURFACE_TARGETS, type SurfaceSourceFile, type SurfaceTarget } from './contract.js'
import { harnessFact } from './harness-registry.js'

const EnvironmentName = z.string().regex(/^[A-Z][A-Z0-9_]*$/).max(128)
const EnvironmentNames = z.array(EnvironmentName).max(128).refine(names => new Set(names).size === names.length)
const ServerName = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/).max(128)
const RelativePath = z.string().min(1).max(4096).refine(path => !isAbsolute(path)
    && !/[\\\x00-\x1f\x7f]/.test(path) && !/^[a-z]:/i.test(path)
    && path.split('/').every(part => part !== '' && part !== '.' && part !== '..' && !reservedPathSegment(part)))
const ShellToken = z.string().min(1).max(4096).refine(value => !/[\x00-\x1f\x7f]|\$\(|\$\{|`/.test(value))
const WorkingDirectory = ShellToken.refine(isAbsolute)
const Sha256 = z.string().regex(/^[a-f0-9]{64}$/)
const Source = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('core'), path: RelativePath, sha256: Sha256 }).strict(),
    z.object({ kind: z.literal('overlay'), path: RelativePath, sha256: Sha256 }).strict(),
    z.object({ kind: z.literal('sibling'), path: RelativePath, sha256: Sha256, slug: z.string().regex(/^[a-z0-9][a-z0-9-]*$/) }).strict(),
])
const Argument = ShellToken.refine(value => !/^--?(?:api[-_]?key|token|password|secret|authorization|credential)(?:=|$)/i.test(value)
    && !/^[a-z][a-z0-9+.-]*:\/\/[^/]*@/i.test(value))
const Command = ShellToken.refine(value => !value.startsWith('-'))
const StdioDeclaration = z.object({
    name: ServerName,
    command: Command,
    args: z.array(Argument).max(256),
    cwd: WorkingDirectory,
    envNames: EnvironmentNames,
    optionalEnvNames: EnvironmentNames.optional(),
    source: Source,
}).strict().refine(({ envNames, optionalEnvNames = [] }) => envNames.length + optionalEnvNames.length <= 128
    && optionalEnvNames.every(name => !envNames.includes(name)))

const LOOPBACK_HOSTS = /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])$/
const CREDENTIAL_NAME = /^(?:api[-_]?key|token|access[-_]?token|password|secret|authorization|credential)$/i

/** Why a remote MCP URL is refused, or undefined when it is accepted. Never echoes the URL. */
function remoteMcpUrlProblem(value: string): string | undefined {
    // OpenCode expands {env:NAME} and {file:path} anywhere in opencode.jsonc, URL included, so a brace
    // would let a declaration send an environment variable or a file's contents to the server.
    if (/[{}]/.test(value)) return 'contains a brace, which OpenCode expands as {env:...} or {file:...} and Codex sends literally'
    let url: URL
    try { url = new URL(value) } catch { return 'is not an absolute URL' }
    if (url.username || url.password) return 'carries credentials in its user information'
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK_HOSTS.test(url.hostname))) {
        return 'must use https, or http only to a loopback host'
    }
    if ([...url.searchParams.keys()].some(name => CREDENTIAL_NAME.test(name))) return 'carries a credential-named query parameter'
    return undefined
}

// A header value is one environment reference, whole or after `Bearer ` in Authorization. Those are
// the only spellings all three tools resolve from the environment (Codex reads them as
// env_http_headers and bearer_token_env_var), so no credential literal reaches a tracked file.
const HEADER_REFERENCE = /^(Bearer )?\$\{([A-Z][A-Z0-9_]*)\}$/
const HeaderName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]*$/).max(128)

/** Why a declared header is refused, or undefined when it is an accepted environment reference. Never echoes the value. */
function remoteMcpHeaderProblem(name: string, value: string): string | undefined {
    if (!HeaderName.safeParse(name).success) return 'has a name that is not an HTTP token'
    const match = HEADER_REFERENCE.exec(value)
    if (!match) return 'must be exactly ${NAME}, or Bearer ${NAME} for Authorization, naming an upper-case environment variable; a literal value would commit the credential'
    if (match[1] && name.toLowerCase() !== 'authorization') return 'may use the Bearer form only in Authorization'
    return undefined
}

const Headers = z.record(z.string(), z.string().max(256))
    .refine(headers => Object.keys(headers).length <= 32
        && Object.entries(headers).every(([name, value]) => remoteMcpHeaderProblem(name, value) === undefined)
        && new Set(Object.keys(headers).map(name => name.toLowerCase())).size === Object.keys(headers).length)
const HttpDeclaration = z.object({
    name: ServerName,
    transport: z.literal('http'),
    url: z.string().max(2048).refine(url => remoteMcpUrlProblem(url) === undefined),
    headers: Headers,
    // The declared command that prints the request headers as a JSON object when the tool connects.
    helper: z.object({ command: Command, args: z.array(Argument).max(64), cwd: WorkingDirectory }).strict().nullable(),
    source: Source,
}).strict()
const Declaration = z.union([StdioDeclaration, HttpDeclaration])
const Input = z.object({
    cockpitDirectory: WorkingDirectory,
    declarations: z.array(Declaration).max(256),
    approved: z.record(ServerName, Sha256).refine(approved => Object.keys(approved).length <= 256),
    targets: z.array(z.enum(SURFACE_TARGETS)).min(1).max(SURFACE_TARGETS.length).refine(targets => new Set(targets).size === targets.length),
}).strict()

type McpSource = z.infer<typeof Source>
export type McpStdioDeclaration = z.infer<typeof StdioDeclaration>
export type McpHttpDeclaration = z.infer<typeof HttpDeclaration>
type McpDeclaration = McpStdioDeclaration | McpHttpDeclaration

export interface McpDiagnostic {
    readonly code: 'MCP_INPUT_INVALID' | 'MCP_DECLARATION_INVALID' | 'MCP_COMMAND_CONFLICT' | 'MCP_NOT_APPROVED' | 'MCP_APPROVAL_UNKNOWN'
        | 'MCP_TRANSPORT_UNAVAILABLE'
    readonly message: string
    readonly server?: string
    readonly sources?: readonly McpSource[]
    /** The approval digest of the server's current declaration, on MCP_NOT_APPROVED. */
    readonly sha256?: string
    /** The tools a server is not written for, on MCP_TRANSPORT_UNAVAILABLE. */
    readonly targets?: readonly SurfaceTarget[]
}

interface McpLaunch {
    readonly command: string
    readonly args: readonly string[]
    readonly cwd: string
}

export type McpServer = Readonly<{
    name: string; command: string; args: readonly string[]; cwd: string
    envNames: readonly string[]; optionalEnvNames?: readonly string[]; enabled: boolean; sources: readonly McpSource[]
}> | Readonly<{
    name: string; transport: 'http'; url: string; headers: Readonly<Record<string, string>>; helper: McpLaunch | null
    envNames: readonly string[]; enabled: boolean; sources: readonly McpSource[]
}>

export type McpHarnessServer = Readonly<{ name: string; command: string; args: readonly string[]; enabled: boolean }>
    | Readonly<{ name: string; url: string; headers: Readonly<Record<string, string>>; headersHelper: string | null; enabled: boolean }>

export interface McpCollection {
    readonly servers: readonly McpServer[]
    readonly wrappers: readonly { readonly path: string; readonly bytes: string; readonly sha256: string }[]
    readonly harnesses: readonly { readonly target: SurfaceTarget; readonly servers: readonly McpHarnessServer[] }[]
}

export type McpCollectionOutcome =
    | Readonly<{ kind: 'complete'; result: McpCollection; diagnostics: readonly McpDiagnostic[] }>
    | Readonly<{ kind: 'refusal'; diagnostic: McpDiagnostic }>

type McpParseOutcome =
    | Readonly<{ kind: 'complete'; declarations: readonly McpDeclaration[] }>
    | Readonly<{ kind: 'refusal'; diagnostic: McpDiagnostic }>

function refuse(code: McpDiagnostic['code'], message: string): Extract<McpCollectionOutcome, { kind: 'refusal' }> {
    return { kind: 'refusal', diagnostic: { code, message } }
}

function quote(value: string): string {
    return `'${value.replaceAll("'", `'"'"'`)}'`
}

// Each harness starts the wrapper as `.cockpit/mcp/<id>.sh` from the directory the agent was
// launched in, so it runs only from the cockpit root (the guard hooks require the same) and the
// server's directory is relative to it: the committed bytes are the same in every clone. The `./`
// keeps CDPATH from choosing another directory and printing it into the JSON-RPC stream, and `-P`
// resolves `..` from the real root, against which the relative path was computed.
// A headers helper runs through the same kind of wrapper: Claude Code and Codex start it with
// `sh -c` from the directory the agent was launched in, and it prints the headers on stdout.
function wrapper(launch: McpLaunch, envNames: readonly string[], cockpitDirectory: string, optionalEnvNames: readonly string[] = []): string {
    const inherited = ['PATH', ...INHERITED_TOOL_ENVIRONMENT].filter(name => !envNames.includes(name) && !optionalEnvNames.includes(name))
    return [
        '#!/bin/sh',
        'set -eu',
        `cd -P -- ${quote(`./${relative(cockpitDirectory, launch.cwd) || '.'}`)}`,
        `executable=$(command -v ${quote(launch.command)}) || { printf '%s\\n' 'MCP_EXECUTABLE_UNAVAILABLE' >&2; exit 2; }`,
        '[ -f "$executable" ] && [ -x "$executable" ] || { printf \'%s\\n\' \'MCP_EXECUTABLE_UNAVAILABLE\' >&2; exit 2; }',
        // `npx`, `uvx` and most npm servers are `#!/usr/bin/env node` scripts: without PATH they
        // cannot start. The rest of the inherited set carries caches and locale, never a credential.
        `exec /usr/bin/env -i ${[...inherited, ...optionalEnvNames].map(name => `\${${name}+"${name}=$${name}"}`).join(' ')}`
            + `${envNames.map(name => ` ${name}="\${${name}?required environment name ${name} is unset}"`).join('')} "$executable"${launch.args.map(arg => ` ${quote(arg)}`).join('')}`,
        '',
    ].join('\n')
}

/** The committed path of a server's stdio wrapper, or of its headers helper wrapper. */
function mcpWrapperPath(name: string, kind: 'server' | 'headers'): string {
    return `.cockpit/mcp/${sha256Hex(name)}${kind === 'headers' ? '.headers' : ''}.sh`
}

type McpIdentity = Pick<McpStdioDeclaration, 'command' | 'args' | 'cwd' | 'envNames' | 'optionalEnvNames'>
    | Pick<McpHttpDeclaration, 'transport' | 'url' | 'headers' | 'helper'>

function isHttp<T extends object>(value: T): value is Extract<T, { transport: 'http' }> {
    return 'transport' in value && value.transport === 'http'
}

function headerEnvironmentNames(headers: Readonly<Record<string, string>>): readonly string[] {
    return [...new Set(Object.values(headers).map(value => HEADER_REFERENCE.exec(value)![2]!))].sort()
}

// What a human reviews before approving a server: everything the wrapper runs, or the URL, the
// header references and the helper a remote server connects with. Working directories are taken
// relative to the cockpit so the digest is the same in every clone.
function identity(declaration: McpIdentity, cockpitDirectory: string): string {
    if (isHttp(declaration)) {
        const helper = declaration.helper
        return JSON.stringify({ transport: 'http', url: declaration.url,
            headers: Object.entries(declaration.headers).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0),
            helper: helper && { command: helper.command, args: helper.args, cwd: relative(cockpitDirectory, helper.cwd) || '.' } })
    }
    const stdio = declaration as Pick<McpStdioDeclaration, 'command' | 'args' | 'cwd' | 'envNames' | 'optionalEnvNames'>
    const optionalEnvNames = [...(stdio.optionalEnvNames ?? [])].sort()
    return JSON.stringify({ command: stdio.command, args: stdio.args, cwd: relative(cockpitDirectory, stdio.cwd) || '.', envNames: [...stdio.envNames].sort(),
        ...(optionalEnvNames.length > 0 ? { optionalEnvNames } : {}) })
}

/** The digest `[mcp.approved]` records for a server, so a changed declaration is no longer approved. */
export function mcpApprovalDigest(declaration: McpIdentity, cockpitDirectory: string): string {
    return sha256Hex(identity(declaration, cockpitDirectory))
}

export function collectMcpDeclarations(input: unknown): McpCollectionOutcome {
    const captured = snapshotJson(input)
    const parsed = Input.safeParse(captured)
    if (!parsed.success) return refuse('MCP_INPUT_INVALID', 'MCP declarations, approvals and targets must be bounded canonical data')
    const { approved, cockpitDirectory } = parsed.data
    const collected = new Map<string, { declaration: McpDeclaration; sources: McpSource[] }>()
    for (const declaration of parsed.data.declarations) {
        const prior = collected.get(declaration.name)
        if (prior && identity(prior.declaration, cockpitDirectory) !== identity(declaration, cockpitDirectory)) {
            const conflict = snapshotJson({ kind: 'refusal', diagnostic: {
                code: 'MCP_COMMAND_CONFLICT', server: declaration.name,
                message: 'MCP server identity has divergent declarations: command, arguments, working directory or environment names for a local server; URL, header references or headers helper for a remote one',
                sources: [...prior.sources, declaration.source],
            } })
            return conflict ? conflict as unknown as McpCollectionOutcome
                : refuse('MCP_INPUT_INVALID', 'MCP conflict exceeds the bounded data budget')
        }
        if (prior) {
            if (!prior.sources.some(source => JSON.stringify(source) === JSON.stringify(declaration.source))) prior.sources.push(declaration.source)
        } else collected.set(declaration.name, { declaration, sources: [declaration.source] })
    }
    const digests = new Map([...collected].map(([name, { declaration }]) => [name, mcpApprovalDigest(declaration, cockpitDirectory)]))
    const servers = [...collected.values()].map(({ declaration, sources }): McpServer => {
        const shared = {
            enabled: Object.hasOwn(approved, declaration.name) && approved[declaration.name] === digests.get(declaration.name),
            sources: sources.sort((left, right) => JSON.stringify(left) < JSON.stringify(right) ? -1 : JSON.stringify(left) > JSON.stringify(right) ? 1 : 0),
        }
        return isHttp(declaration)
            ? { name: declaration.name, transport: 'http', url: declaration.url, headers: declaration.headers, helper: declaration.helper,
                envNames: headerEnvironmentNames(declaration.headers), ...shared }
            : { name: declaration.name, command: declaration.command, args: declaration.args, cwd: declaration.cwd,
                envNames: [...declaration.envNames].sort(),
                ...(declaration.optionalEnvNames?.length ? { optionalEnvNames: [...declaration.optionalEnvNames].sort() } : {}), ...shared }
    }).sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
    const diagnostics: McpDiagnostic[] = servers.filter(server => !server.enabled).map(server => ({
        code: 'MCP_NOT_APPROVED', server: server.name, sources: server.sources, sha256: digests.get(server.name)!,
        message: 'MCP server has no shared approval for its current declaration and remains disabled',
    }))
    for (const name of Object.keys(approved).sort()) if (!collected.has(name)) diagnostics.push({
        code: 'MCP_APPROVAL_UNKNOWN', server: name, message: 'The shared approval list names an undeclared MCP server',
    })
    // A tool that cannot carry a remote server's credential gets nothing for it: written without
    // its headers, the server would start, fail to authenticate and still read as configured.
    const writes = (server: McpServer, target: SurfaceTarget): boolean => {
        if (!isHttp(server)) return true
        const support = harnessFact(target).remoteMcp
        return support.state !== 'unavailable' && (Object.keys(server.headers).length === 0 || support.headers)
            && (server.helper === null || support.helper)
    }
    const targets = parsed.data.targets
    for (const server of servers) {
        const skipped = targets.filter(target => !writes(server, target))
        if (skipped.length > 0) diagnostics.push({
            code: 'MCP_TRANSPORT_UNAVAILABLE', server: server.name, sources: server.sources, targets: skipped,
            message: `MCP server is not written for ${skipped.join(', ')}: ${skipped.map(target => harnessFact(target).remoteMcp.provenance).filter((reason, index, all) => all.indexOf(reason) === index).join('; ')}`,
        })
    }
    const wrappers: { path: string; bytes: string; sha256: string }[] = []
    const launchers = new Map<string, string>()
    for (const server of servers) {
        const launch = isHttp(server) ? server.helper : server
        if (launch === null || !targets.some(target => writes(server, target))) continue
        const path = mcpWrapperPath(server.name, isHttp(server) ? 'headers' : 'server')
        const bytes = wrapper(launch, isHttp(server) ? [] : server.envNames, cockpitDirectory, isHttp(server) ? [] : server.optionalEnvNames)
        wrappers.push({ path, bytes, sha256: sha256Hex(bytes) })
        launchers.set(server.name, path)
    }
    const result = {
        servers, wrappers,
        harnesses: targets.map(target => ({ target, servers: servers.filter(server => writes(server, target)).map((server): McpHarnessServer => isHttp(server)
            ? { name: server.name, url: server.url, headers: server.headers,
                headersHelper: launchers.has(server.name) ? `/bin/sh ${launchers.get(server.name)}` : null, enabled: server.enabled }
            : { name: server.name, command: '/bin/sh', args: [launchers.get(server.name)!], enabled: server.enabled }) })),
    }
    const outcome = snapshotJson({ kind: 'complete', result, diagnostics })
    return outcome ? outcome as unknown as McpCollectionOutcome : refuse('MCP_INPUT_INVALID', 'Canonical MCP output exceeds the bounded data budget')
}

const NativeServer = z.object({
    type: z.literal('stdio').optional(), command: Command,
    args: z.array(Argument).max(256).default([]), cwd: RelativePath.or(z.literal('.')).optional(),
    env: z.record(EnvironmentName, z.string().max(128)).default({}),
    optionalEnv: EnvironmentNames.optional(),
}).strict()
// Claude Code's `.mcp.json` spelling of a remote server; values are checked one by one below so a
// refusal can say which part is wrong without repeating it.
const NativeHttpServer = z.object({
    type: z.literal('http'), url: z.string().max(2048),
    headers: z.record(z.string(), z.string().max(256)).default({}), headersHelper: z.string().min(1).max(4096).optional(),
}).strict()
// Absence is inferred only from cockpit's neutral shape; other source forms retain generator validation.
const GeneratedServer = z.union([
    NativeServer.extend({ cwd: WorkingDirectory.optional(), disabled: z.boolean().optional() }),
    NativeHttpServer.extend({ http_headers_helper: z.string().min(1).max(4096).optional(), disabled: z.boolean().optional() }),
])
const GeneratedServers = z.record(ServerName, GeneratedServer)
const TargetServers = z.object({ mcpServers: z.record(ServerName, GeneratedServer.nullable()).optional() }).strict()

export function hasTargetMcpServers(sources: readonly SurfaceSourceFile[], target: SurfaceTarget): boolean {
    const source = sources.find(candidate => candidate.path === 'mcp.jsonc')
    if (!source) return false
    try {
        const document = parseDocument(source.bytes, { uniqueKeys: true })
        const root = z.record(z.string(), z.unknown()).safeParse(JSON.parse(source.bytes))
        if (document.errors.length > 0 || document.warnings.length > 0 || !root.success) return true
        const shared = GeneratedServers.safeParse(root.data.mcpServers)
        const targetNames = SURFACE_TARGETS.map(candidate => harnessFact(candidate).rulesyncTarget)
        if (!shared.success || Object.entries(root.data).some(([name, value]) => name !== 'mcpServers'
            && (!targetNames.some(candidate => candidate === name) || !TargetServers.safeParse(value).success))) return true
        const override = TargetServers.safeParse(root.data[harnessFact(target).rulesyncTarget] ?? {})
        if (!override.success) return true
        return Object.values({ ...shared.data, ...override.data.mcpServers }).some(server => server !== null)
    } catch {
        // Unknown syntax and malformed declarations still reach Rulesync's authenticated parser.
        return true
    }
}

const NativeFile = z.object({ mcpServers: z.record(ServerName, z.unknown()).refine(servers => Object.keys(servers).length <= 256) }).strict()
const ParseInput = z.object({ bytes: z.string(), source: Source, workingDirectory: WorkingDirectory }).strict()
// A helper is written as one command line in `.mcp.json`. Cockpit runs it without a shell, so each
// space-separated word must be plain: quoting, expansion and redirection belong in the helper script.
const HELPER_WORD = /^[A-Za-z0-9_@%+=:,.\/-]+$/

function parseHttpServer(name: string, server: z.infer<typeof NativeHttpServer>, source: McpSource, workingDirectory: string): McpDeclaration | string {
    const urlProblem = remoteMcpUrlProblem(server.url)
    if (urlProblem) return `MCP server ${name}: its url ${urlProblem}`
    const headerNames = Object.keys(server.headers)
    if (headerNames.length > 32) return `MCP server ${name} declares more than 32 headers`
    if (new Set(headerNames.map(header => header.toLowerCase())).size !== headerNames.length) return `MCP server ${name} declares a header twice in different case`
    for (const [header, value] of Object.entries(server.headers)) {
        const problem = remoteMcpHeaderProblem(header, value)
        if (problem) return `MCP server ${name}: header ${HeaderName.safeParse(header).success ? header : '(unnamed)'} ${problem}`
    }
    let helper: McpHttpDeclaration['helper'] = null
    if (server.headersHelper !== undefined) {
        const words = server.headersHelper.split(' ')
        if (words.some(word => !HELPER_WORD.test(word)) || words[0]!.startsWith('-')) {
            return `MCP server ${name}: headersHelper must be a command and arguments separated by single spaces, without quotes, variables or shell operators`
        }
        helper = { command: words[0]!, args: words.slice(1), cwd: workingDirectory }
        if (!z.array(Argument).safeParse(helper.args).success) return `MCP server ${name}: headersHelper arguments must not carry a credential`
    }
    return { name, transport: 'http', url: server.url, headers: server.headers, helper, source }
}

export function parseMcpDeclarationFile(input: unknown): McpParseOutcome {
    const parsed = ParseInput.safeParse(snapshotJson(input))
    if (!parsed.success) return refuse('MCP_DECLARATION_INVALID', 'MCP source must be bounded authenticated declaration bytes')
    const { bytes, source, workingDirectory } = parsed.data
    if (sha256Hex(bytes) !== source.sha256) return refuse('MCP_DECLARATION_INVALID', 'MCP source digest does not match declaration bytes')
    const value = tryParseJson(bytes)
    if (value === undefined) return refuse('MCP_DECLARATION_INVALID', 'MCP declaration is not valid JSON')
    const file = NativeFile.safeParse(value)
    if (!file.success) return refuse('MCP_DECLARATION_INVALID', 'MCP declaration must be one mcpServers object of at most 256 named servers')
    const declarations: McpDeclaration[] = []
    for (const [name, entry] of Object.entries(file.data.mcpServers)) {
        const type = typeof entry === 'object' && entry !== null && 'type' in entry ? entry.type : undefined
        if (type === 'sse') {
            return refuse('MCP_DECLARATION_INVALID', `MCP server ${name} uses the SSE transport, which Codex cannot connect to; declare the server's streamable HTTP endpoint with type http`)
        }
        if (type === 'http') {
            const remote = NativeHttpServer.safeParse(entry)
            if (!remote.success) return refuse('MCP_DECLARATION_INVALID', `MCP server ${name} is a remote server with fields other than type, url, headers and headersHelper`)
            const declaration = parseHttpServer(name, remote.data, source, workingDirectory)
            if (typeof declaration === 'string') return refuse('MCP_DECLARATION_INVALID', declaration)
            declarations.push(declaration)
            continue
        }
        const local = NativeServer.safeParse(entry)
        if (!local.success) return refuse('MCP_DECLARATION_INVALID', 'MCP declaration contains unsupported command, environment or transport fields')
        const server = local.data
        if (Object.entries(server.env).some(([key, reference]) => reference !== `\${${key}}`)) {
            return refuse('MCP_DECLARATION_INVALID', 'MCP environment entries must reference their same declared environment name')
        }
        const envNames = Object.keys(server.env).sort()
        const optionalEnvNames = [...(server.optionalEnv ?? [])].sort()
        if (envNames.length + optionalEnvNames.length > 128 || optionalEnvNames.some(name => envNames.includes(name))) {
            return refuse('MCP_DECLARATION_INVALID', 'MCP required and optional environment names must be disjoint and contain at most 128 names together')
        }
        const cwd = resolve(workingDirectory, server.cwd ?? '.')
        const offset = relative(workingDirectory, cwd)
        if (offset === '..' || offset.startsWith('../') || isAbsolute(offset)) return refuse('MCP_DECLARATION_INVALID', 'MCP working directory escapes its declared sibling')
        declarations.push({ name, command: server.command, args: server.args, cwd, envNames,
            ...(optionalEnvNames.length > 0 ? { optionalEnvNames } : {}), source })
    }
    const captured = snapshotJson({ kind: 'complete', declarations })
    return captured ? captured as unknown as McpParseOutcome : refuse('MCP_DECLARATION_INVALID', 'MCP declarations exceed the bounded data budget')
}
