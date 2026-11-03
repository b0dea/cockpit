import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { readFile, rm, writeFile, mkdir, realpath, lstat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { mkdtemp } from 'node:fs/promises'
import { expect } from 'vitest'

import type { ExecutionStep } from '../src/environment/contract.js'
import {
    type GeneratedEnvironmentCommandAdapters,
    type GeneratedStaleRemovalApprovalRequest,
} from '../src/environment/generated-application.js'
import { syncGeneratedEnvironment } from '../src/generated-environment/command.js'
import { mcpApprovalDigest } from '../src/surfaces/mcp.js'

/** The groups one publication helper step carries; empty for any other step. */
export function publicationRequestGroups(step: ExecutionStep, action: 'prepare' | 'publish' | 'commit'): readonly {
    readonly parent: string
    readonly entries: readonly Record<string, unknown>[]
}[] {
    if (step.labels.action !== `${action}-batch`) return []
    return (JSON.parse(step.argv[3]!) as { groups: readonly { parent: string; entries: readonly Record<string, unknown>[] }[] }).groups
}

/** The staged input files a prepare step copies into its stages, in request input order. */
export function stagedPublicationInputs(step: ExecutionStep): readonly string[] {
    return step.labels.action === 'prepare-batch' ? step.argv.slice(4) : []
}

export function createGeneratedCommandFixture() {
    const fixture = resolve('fixtures/registries/generated-environment.toml')
    const roots: string[] = []

    function canonicalOutputRead(step: ExecutionStep, root: string, outputPaths: readonly string[]) {
        if (step.cwd === root && ['read-batch', 'read-file'].includes(step.labels.action)) {
            const request = JSON.parse(step.argv[3]!) as {
                action: string
                entries?: { action: string; segments: string[]; name: string; maxBytes: number }[]
                segments: string[]; name: string; maxBytes: number
            }
            const entries = (request.action === 'read-batch' ? request.entries! : [request])
                .filter(entry => entry.action === 'read-file')
                .map(entry => ({ path: [...entry.segments, entry.name].join('/'), maxBytes: entry.maxBytes, action: entry.action }))
                .filter(entry => outputPaths.includes(entry.path))
            if (entries.length > 0) return { action: request.action, entries }
        }
        return undefined
    }

    function publicationGroups(step: ExecutionStep, action: 'prepare' | 'publish' | 'commit'): readonly {
        parent: string
        entries: readonly { stage: string | null }[]
    }[] {
        return publicationRequestGroups(step, action) as readonly { parent: string; entries: readonly { stage: string | null }[] }[]
    }

    async function cleanup() {
        await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
    }

    async function consumer(name: string, parentDirectory?: string) {
        const root = await realpath(await mkdtemp(join(parentDirectory ?? tmpdir(), `cockpit-generated-${name}-`)))
        // A supplied parent owns cleanup for its nested fixture estate.
        if (parentDirectory === undefined) roots.push(root)
        const configPath = join(root, 'cockpit.toml')
        const declaration = (await readFile(fixture, 'utf8')).replace(
            'name = "generated-environment"', 'name = "generated-environment"\nsiblings_root = "."',
        )
        await writeFile(configPath, declaration)
        await mkdir(join(root, 'app'), { recursive: true })
        await writeFile(join(root, 'unmanaged.txt'), 'keep\n')
        return { root, configPath }
    }

    // The same cockpit running its own compose.yml, so sync also owns compose.cockpit.yml. Sync and
    // its ownership render read the Compose file directly; only check needs a Docker CLI.
    async function composeConsumer(name: string, parentDirectory?: string) {
        const result = await consumer(name, parentDirectory)
        await writeFile(result.configPath, `${await readFile(result.configPath, 'utf8')}\n[environment]\ncompose_files = ["compose.yml"]\n`)
        await writeFile(join(result.root, 'compose.yml'), [
            'services:', '  app:', `    image: node@sha256:${'8'.repeat(64)}`,
            '    ports: ["127.0.0.1:${APP_HOST_PORT:-4100}:3000"]', '    volumes: ["./app:/app"]', '',
        ].join('\n'))
        return result
    }

    const surfaceFeatures = ['rules', 'mcp', 'subagents', 'skills', 'hooks', 'permissions'] as const

    function rulesSurface() {
        return `
    [[surfaces.overlays]]
    name = "synthetic-rules"
    feature = "rules"
    source = "surfaces/synthetic-rules.json"
    sources = [{ path = "rules/synthetic.md", bytes = "Read the synthetic sibling guide before editing.\\n" }]
    `
    }

    async function skillSurfaces(names: readonly string[]): Promise<string> {
        const entryPoint = await readFile(resolve('packages/cockpit/surfaces/skills/cockpit-setup.skill.md'), 'utf8')
        const procedure = '---\nloading: pull\nbudget: uncapped\n---\n\nInspect the synthetic product-owned verification target.\n'
        return names.map(name => `
    [[surfaces.overlays]]
    name = ${JSON.stringify(`synthetic-${name}`)}
    feature = "skills"
    source = ${JSON.stringify(`surfaces/synthetic-${name}.json`)}
    sources = [
      { path = ${JSON.stringify(`skills/${name}/SKILL.md`)}, bytes = ${JSON.stringify(entryPoint.replace('{{tool-equivalence}}', 'Use `Bash` in Claude Code, `shell` in Codex CLI, or `bash` in OpenCode.').replace('name: cockpit-setup', `name: ${name}`))} },
      { path = ${JSON.stringify(`skills/${name}/procedures/setup.md`)}, bytes = ${JSON.stringify(procedure)} },
    ]
    `).join('')
    }

    function customHarness(module: string, exportName = 'renderRules', spelling = 'custom/rules.md') {
        const capabilities = surfaceFeatures.map((feature) => feature === 'rules'
            ? `{ feature = "rules", state = "instructed", measured_on = "2026-09-26", spelling = ${JSON.stringify(spelling)}, control = "controls/rules.json", mechanism = { module = ${JSON.stringify(module)}, export = ${JSON.stringify(exportName)} } }`
            : `{ feature = ${JSON.stringify(feature)}, state = "unavailable", measured_on = "2026-09-26", reason = "No synthetic ${feature} mechanism" }`)
        return `
    [[surfaces.harnesses]]
    name = "synthetic-harness"
    capabilities = [${capabilities.join(', ')}]
    `
    }

    function enforcedCustomHarness(module: string, evidenceSha256: string, evidenceReference = 'evidence/rules.json') {
        const capabilities = surfaceFeatures.map((feature) => feature === 'rules'
            ? `{ feature = "rules", state = "enforced", measured_on = "2026-09-26", spelling = "custom/rules.md", control = "controls/rules.json", mechanism = { module = ${JSON.stringify(module)}, export = "renderRules" }, evidence = { reference = ${JSON.stringify(evidenceReference)}, sha256 = ${JSON.stringify(evidenceSha256)} } }`
            : `{ feature = ${JSON.stringify(feature)}, state = "unavailable", measured_on = "2026-09-26", reason = "No synthetic ${feature} mechanism" }`)
        return `
    [[surfaces.harnesses]]
    name = "synthetic-harness"
    capabilities = [${capabilities.join(', ')}]
    `
    }

    function unavailableCustomHarness() {
        const capabilities = surfaceFeatures.map((feature) =>
            `{ feature = ${JSON.stringify(feature)}, state = "unavailable", measured_on = "2026-09-26", reason = "No synthetic ${feature} mechanism" }`)
        return `
    [[surfaces.harnesses]]
    name = "synthetic-harness"
    capabilities = [${capabilities.join(', ')}]
    `
    }

    async function surfaceConsumer(name: string, options: {
        readonly rules?: boolean
        /** The declaration of `approved-server` in the sibling's `.mcp.json`, which the configuration approves. */
        readonly mcp?: { readonly command: string; readonly envNames?: readonly string[] }
        readonly bundles?: boolean
        readonly custom?: string
        readonly siblingDirectory?: string
        readonly parentDirectory?: string
    } = {}) {
        const result = await consumer(name, options.parentDirectory)
        const siblingDirectory = options.siblingDirectory ?? join(result.root, 'app')
        await mkdir(siblingDirectory, { recursive: true })
        await writeFile(join(siblingDirectory, 'AGENTS.md'), 'Synthetic sibling guide.\n')
        let declaration = (await readFile(result.configPath, 'utf8'))
            .replace('purpose = "Synthetic application"', 'purpose = "Synthetic application"\nguides = ["AGENTS.md"]')
        // `dir` must be relative, so the caller sets `siblings_root` to the parent of `siblingDirectory`.
        if (options.siblingDirectory) declaration += `
    [[sibling]]
    slug = "external"
    dir = ${JSON.stringify(basename(siblingDirectory))}
    mount = "always"
    acquire = "none"
    var = "EXTERNAL_DIR"
    purpose = "Synthetic external checkout"
    guides = ["AGENTS.md"]
    environment_files = [{ template = ".env.example", instance = ".env" }]
    `
        if (options.mcp) {
            declaration += `
    [sibling.derives]
    mcp_sources = [{ path = ".mcp.json", provenance = { source = "synthetic declaration", observed_on = "2026-09-26", kind = "declared", reason = "Synthetic MCP source" } }]

    [mcp.approved]
    approved-server = "${mcpApprovalDigest({ command: options.mcp.command, args: [], cwd: siblingDirectory, envNames: [...options.mcp.envNames ?? []] }, result.root)}"
    `
        }
        if (options.rules) declaration += rulesSurface()
        if (options.bundles) declaration += '\n[surfaces]\nbundles = ["claudecode-plugin"]\n'
        if (options.custom) declaration += options.custom
        await writeFile(result.configPath, declaration)
        return { ...result, siblingDirectory }
    }

    function digest(bytes: string | Uint8Array) {
        return createHash('sha256').update(bytes).digest('hex')
    }


    function staleRemovalAuthority(expected: readonly Readonly<{
        path: string
        kind: 'file' | 'symlink'
        sha256?: string
        target?: string
    }>[]): Pick<GeneratedEnvironmentCommandAdapters, 'authorizeStaleRemoval'> {
        return {
            authorizeStaleRemoval: async (request: GeneratedStaleRemovalApprovalRequest) => {
                expect(request).toMatchObject({
                    format: 'cockpit-stale-removal-request/v1',
                    entries: expected.map(entry => ({
                        path: entry.path,
                        current: {
                            kind: entry.kind,
                            ...(entry.sha256 ? { sha256: entry.sha256 } : {}),
                            ...(entry.target ? { target: entry.target } : {}),
                        },
                    })),
                })
                expect(request.digest).toMatch(/^[a-f0-9]{64}$/)
                return Object.freeze({ format: 'cockpit-stale-removal-approval/v1', digest: request.digest })
            },
        }
    }

    async function writeCustomModule(root: string, files: readonly { path: string; bytes: string; scope?: 'always' | 'scoped' }[], exportName = 'renderRules') {
        const relativePath = 'adapters/synthetic.mjs'
        await mkdir(join(root, 'adapters'), { recursive: true })
        const output = files.map(({ path, bytes: contents, scope = 'always' }) => ({
            path, bytes: contents, sha256: digest(contents), scope,
        }))
        await writeFile(join(root, relativePath), `export async function ${exportName}(input) {
      if (input.harness !== "synthetic-harness" || input.feature !== "rules" || !Array.isArray(input.sources)) throw new Error("invalid custom input")
      return { kind: "complete", files: ${JSON.stringify(output)} }
    }
    `)
        return relativePath
    }

    async function ownership(root: string) {
        return JSON.parse(await readFile(join(root, '.cockpit/generated-environment-ownership.json'), 'utf8')) as Record<string, unknown>
    }

    function runGeneratedGuard(root: string, path: string) {
        return spawnSync('/bin/bash', [join(root, '.cockpit/guards/bash-guard.sh'), '--harness', 'claudecode'], {
            cwd: root,
            input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Write', cwd: root,
                tool_input: { file_path: path, content: 'synthetic replacement' } }),
            encoding: 'utf8',
        })
    }

    async function bytes(root: string, paths: readonly string[]) {
        return Object.fromEntries(await Promise.all(paths.map(async (path) => [path, await readFile(join(root, path), 'utf8')])))
    }

    return { roots, cleanup, canonicalOutputRead, publicationGroups, consumer, composeConsumer, skillSurfaces, customHarness, enforcedCustomHarness, unavailableCustomHarness, surfaceConsumer, digest, staleRemovalAuthority, writeCustomModule, ownership, runGeneratedGuard, bytes }
}
