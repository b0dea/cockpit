import { createHash } from 'node:crypto'
import { isAbsolute, relative, resolve } from 'node:path'
import { z } from 'zod'
import { parseDocument } from 'yaml'

import { INHERITED_TOOL_ENVIRONMENT, snapshotJson } from '../environment/contract.js'
import { reservedPathSegment, SURFACE_TARGETS, type SurfaceSourceFile, type SurfaceTarget } from './contract.js'
import { harnessFact } from './harness-registry.js'

export const mechanism = {
    id: 'mcp-declaration-collection',
    module: 'packages/cockpit/src/surfaces/mcp.ts',
    exports: ['parseMcpDeclarationFile', 'collectMcpDeclarations', 'hasTargetMcpServers', 'mcpApprovalDigest'],
} as const

const EnvironmentName = z.string().regex(/^[A-Z][A-Z0-9_]*$/).max(128)
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
const Declaration = z.object({
    name: ServerName,
    command: ShellToken.refine(value => !value.startsWith('-')),
    args: z.array(Argument).max(256),
    cwd: WorkingDirectory,
    envNames: z.array(EnvironmentName).max(128).refine(names => new Set(names).size === names.length),
    source: Source,
}).strict()
const Input = z.object({
    cockpitDirectory: WorkingDirectory,
    declarations: z.array(Declaration).max(256),
    approved: z.record(ServerName, Sha256).refine(approved => Object.keys(approved).length <= 256),
    targets: z.array(z.enum(SURFACE_TARGETS)).min(1).max(SURFACE_TARGETS.length).refine(targets => new Set(targets).size === targets.length),
}).strict()

export type McpSource = z.infer<typeof Source>
export type McpDeclaration = z.infer<typeof Declaration>

export interface McpDiagnostic {
    readonly code: 'MCP_INPUT_INVALID' | 'MCP_DECLARATION_INVALID' | 'MCP_COMMAND_CONFLICT' | 'MCP_NOT_APPROVED' | 'MCP_APPROVAL_UNKNOWN'
    readonly message: string
    readonly server?: string
    readonly sources?: readonly McpSource[]
    /** The approval digest of the server's current declaration, on MCP_NOT_APPROVED. */
    readonly sha256?: string
}

interface McpServer {
    readonly name: string
    readonly command: string
    readonly args: readonly string[]
    readonly cwd: string
    readonly envNames: readonly string[]
    readonly enabled: boolean
    readonly sources: readonly McpSource[]
}

export interface McpCollection {
    readonly servers: readonly McpServer[]
    readonly wrappers: readonly { readonly path: string; readonly bytes: string; readonly sha256: string }[]
    readonly harnesses: readonly { readonly target: SurfaceTarget; readonly servers: readonly {
        readonly name: string; readonly command: string; readonly args: readonly string[]; readonly enabled: boolean
    }[] }[]
}

export type McpCollectionOutcome =
    | Readonly<{ kind: 'complete'; result: McpCollection; diagnostics: readonly McpDiagnostic[] }>
    | Readonly<{ kind: 'refusal'; diagnostic: McpDiagnostic }>

export type McpParseOutcome =
    | Readonly<{ kind: 'complete'; declarations: readonly McpDeclaration[] }>
    | Readonly<{ kind: 'refusal'; diagnostic: McpDiagnostic }>

function refuse(code: McpDiagnostic['code'], message: string): Extract<McpCollectionOutcome, { kind: 'refusal' }> {
    return Object.freeze({ kind: 'refusal', diagnostic: Object.freeze({ code, message }) })
}

function quote(value: string): string {
    return `'${value.replaceAll("'", `'"'"'`)}'`
}

// Each harness starts the wrapper as `.cockpit/mcp/<id>.sh` from the directory the agent was
// launched in, so it runs only from the cockpit root (the guard hooks require the same) and the
// server's directory is relative to it: the committed bytes are the same in every clone. The `./`
// keeps CDPATH from choosing another directory and printing it into the JSON-RPC stream, and `-P`
// resolves `..` from the real root, against which the relative path was computed.
function wrapper(server: McpServer, cockpitDirectory: string): string {
    const inherited = ['PATH', ...INHERITED_TOOL_ENVIRONMENT].filter(name => !server.envNames.includes(name))
    return [
        '#!/bin/sh',
        'set -eu',
        `cd -P -- ${quote(`./${relative(cockpitDirectory, server.cwd) || '.'}`)}`,
        `executable=$(command -v ${quote(server.command)}) || { printf '%s\\n' 'MCP_EXECUTABLE_UNAVAILABLE' >&2; exit 2; }`,
        '[ -f "$executable" ] && [ -x "$executable" ] || { printf \'%s\\n\' \'MCP_EXECUTABLE_UNAVAILABLE\' >&2; exit 2; }',
        // `npx`, `uvx` and most npm servers are `#!/usr/bin/env node` scripts: without PATH they
        // cannot start. The rest of the inherited set carries caches and locale, never a credential.
        `exec /usr/bin/env -i ${inherited.map(name => `\${${name}+"${name}=$${name}"}`).join(' ')}`
            + `${server.envNames.map(name => ` ${name}="\${${name}?required environment name ${name} is unset}"`).join('')} "$executable"${server.args.map(arg => ` ${quote(arg)}`).join('')}`,
        '',
    ].join('\n')
}

type McpIdentity = Pick<McpDeclaration, 'command' | 'args' | 'cwd' | 'envNames'>

// What a human reviews before approving a server: everything the wrapper runs. The working
// directory is taken relative to the cockpit so the digest is the same in every clone.
function identity(declaration: McpIdentity, cockpitDirectory: string): string {
    return JSON.stringify({ command: declaration.command, args: declaration.args, cwd: relative(cockpitDirectory, declaration.cwd) || '.', envNames: [...declaration.envNames].sort() })
}

/** The digest `[mcp.approved]` records for a server, so a changed declaration is no longer approved. */
export function mcpApprovalDigest(declaration: McpIdentity, cockpitDirectory: string): string {
    return createHash('sha256').update(identity(declaration, cockpitDirectory)).digest('hex')
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
                message: 'MCP server identity has divergent command, arguments, working directory or environment names',
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
    const servers = [...collected.values()].map(({ declaration, sources }): McpServer => ({
        name: declaration.name, command: declaration.command, args: declaration.args, cwd: declaration.cwd,
        envNames: [...declaration.envNames].sort(), enabled: Object.hasOwn(approved, declaration.name) && approved[declaration.name] === digests.get(declaration.name),
        sources: sources.sort((left, right) => JSON.stringify(left) < JSON.stringify(right) ? -1 : JSON.stringify(left) > JSON.stringify(right) ? 1 : 0),
    })).sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
    const diagnostics: McpDiagnostic[] = servers.filter(server => !server.enabled).map(server => ({
        code: 'MCP_NOT_APPROVED', server: server.name, sources: server.sources, sha256: digests.get(server.name)!,
        message: 'MCP server has no shared approval for its current declaration and remains disabled',
    }))
    for (const name of Object.keys(approved).sort()) if (!collected.has(name)) diagnostics.push({
        code: 'MCP_APPROVAL_UNKNOWN', server: name, message: 'The shared approval list names an undeclared MCP server',
    })
    const wrappers = servers.map(server => {
        const bytes = wrapper(server, cockpitDirectory)
        return { path: `.cockpit/mcp/${createHash('sha256').update(server.name).digest('hex')}.sh`, bytes, sha256: createHash('sha256').update(bytes).digest('hex') }
    })
    const result = {
        servers, wrappers,
        harnesses: parsed.data.targets.map(target => ({ target, servers: servers.map((server, index) => ({
            name: server.name, command: '/bin/sh', args: [wrappers[index]!.path], enabled: server.enabled,
        })) })),
    }
    const outcome = snapshotJson({ kind: 'complete', result, diagnostics })
    return outcome ? outcome as unknown as McpCollectionOutcome : refuse('MCP_INPUT_INVALID', 'Canonical MCP output exceeds the bounded data budget')
}

const NativeServer = z.object({
    type: z.literal('stdio').optional(), command: Declaration.shape.command,
    args: z.array(Argument).max(256).default([]), cwd: RelativePath.or(z.literal('.')).optional(),
    env: z.record(EnvironmentName, z.string().max(128)).default({}),
}).strict()
// Absence is inferred only from cockpit's neutral shape; other source forms retain generator validation.
const GeneratedServer = NativeServer.extend({ cwd: WorkingDirectory.optional(), disabled: z.boolean().optional() })
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

const NativeFile = z.object({ mcpServers: z.record(ServerName, NativeServer).refine(servers => Object.keys(servers).length <= 256) }).strict()
const ParseInput = z.object({ bytes: z.string(), source: Source, workingDirectory: WorkingDirectory }).strict()

export function parseMcpDeclarationFile(input: unknown): McpParseOutcome {
    const parsed = ParseInput.safeParse(snapshotJson(input))
    if (!parsed.success) return refuse('MCP_DECLARATION_INVALID', 'MCP source must be bounded authenticated declaration bytes')
    const { bytes, source, workingDirectory } = parsed.data
    if (createHash('sha256').update(bytes).digest('hex') !== source.sha256) return refuse('MCP_DECLARATION_INVALID', 'MCP source digest does not match declaration bytes')
    let value: unknown
    try { value = JSON.parse(bytes) } catch { return refuse('MCP_DECLARATION_INVALID', 'MCP declaration is not valid JSON') }
    const file = NativeFile.safeParse(value)
    if (!file.success) return refuse('MCP_DECLARATION_INVALID', 'MCP declaration contains unsupported command, environment or transport fields')
    const declarations: McpDeclaration[] = []
    for (const [name, server] of Object.entries(file.data.mcpServers)) {
        if (Object.entries(server.env).some(([key, reference]) => reference !== `\${${key}}`)) {
            return refuse('MCP_DECLARATION_INVALID', 'MCP environment entries must reference their same declared environment name')
        }
        const cwd = resolve(workingDirectory, server.cwd ?? '.')
        const offset = relative(workingDirectory, cwd)
        if (offset === '..' || offset.startsWith('../') || isAbsolute(offset)) return refuse('MCP_DECLARATION_INVALID', 'MCP working directory escapes its declared sibling')
        declarations.push({ name, command: server.command, args: server.args, cwd, envNames: Object.keys(server.env).sort(), source })
    }
    const captured = snapshotJson({ kind: 'complete', declarations })
    return captured ? captured as unknown as McpParseOutcome : refuse('MCP_DECLARATION_INVALID', 'MCP declarations exceed the bounded data budget')
}
