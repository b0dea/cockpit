import { randomUUID } from 'node:crypto'
import { mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import type { InstallPolicy, Sibling } from '../schema.js'
import { checkoutId } from './identity.js'
import {
    observeInstallPolicyLockfiles,
    withInstallPolicyProjection,
    type InstallPolicyProjection,
} from './install-policy-observation.js'
import { resolveInstallPolicies, renderGuardProjectCommand, GUARD_PROJECT_COMMAND_RENDERED_BYTES } from './install-policy.js'
import { GUARD_INPUT_LIMITS, parseGuardInput } from '../guards/invocation-parser.js'
import { planGuardTransport } from '../guards/harness-adapter.js'
import { expandRestrictions } from '../surfaces/restrictions.js'

const scratch: string[] = []
const source = { path: '/synthetic/cockpit.toml', byteLength: 17, sha256: 'b'.repeat(64) }
const baseSibling = {
    slug: 'service', dir: 'service', remote: 'https://example.invalid/service.git',
    mount: 'always', acquire: 'auto', var: 'SERVICE_DIR', purpose: 'Synthetic service', guides: [], instruction_pointer: false,
} satisfies Omit<Sibling, 'toolchain'>

const policy = (patch: Partial<InstallPolicy> = {}): InstallPolicy => ({
    toolchain: 'node', volume: 'node-modules', lockfile: 'package-lock.json',
    install: ['npm', 'ci'], load_probe: ['node', '--version'], ...patch,
})

async function checkout(lockfiles: readonly string[]): Promise<string> {
    const root = join(tmpdir(), `cockpit-policy-resolution-${randomUUID()}`)
    scratch.push(root)
    await mkdir(root)
    await Promise.all(lockfiles.map((file) => writeFile(join(root, file), '{}')))
    return realpath(root)
}

async function observed(root: string, siblingIndex: number, siblingSlug: string, catalog: readonly InstallPolicy[]) {
    const identity = checkoutId({ checkoutPath: root })
    const evaluatedAt = Date.now()
    const observation = await observeInstallPolicyLockfiles({
        source, siblingIndex, siblingSlug, checkoutRoot: root, checkoutId: identity,
        policies: catalog, observedAt: new Date(evaluatedAt).toISOString(),
    })
    return {
        observation,
        expected: { source, siblingIndex, siblingSlug, checkoutRoot: root, checkoutId: identity, policies: catalog, evaluatedAt },
    }
}

function input(
    catalog: readonly InstallPolicy[],
    sibling: Sibling,
    siblingIndex = 0,
    evidence: { checkoutRoot: string; checkoutId: ReturnType<typeof checkoutId>; projection: InstallPolicyProjection } | undefined = undefined,
) {
    return { source, policies: catalog, siblingIndex, sibling, ...evidence }
}

async function resolveObserved(root: string, siblingIndex: number, sibling: Sibling, catalog: readonly InstallPolicy[]) {
    const issued = await observed(root, siblingIndex, sibling.slug, catalog)
    return withInstallPolicyProjection(issued.observation, issued.expected, (projection) =>
        resolveInstallPolicies(input(catalog, sibling, siblingIndex, {
            checkoutRoot: root,
            checkoutId: issued.expected.checkoutId,
            projection,
        })))
}

afterEach(async () => {
    await Promise.all(scratch.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('install policy resolution', () => {
    it('frames scalar and escaping commands through emitted hook registrations and OpenCode serialization', async () => {
        expect(GUARD_PROJECT_COMMAND_RENDERED_BYTES).toBe(32_768)
        const directory = await checkout([])
        const guardPath = '.cockpit/guards/bash-guard.sh'
        const capturePath = join(directory, 'captured-input.json')
        const fixture = (name: string) => readFile(new URL(`../../surfaces/guards/${name}`, import.meta.url), 'utf8')
        const expansion = expandRestrictions({
            canonicalProjectRoot: directory, guardPath,
            guardTemplate: await fixture('bash-guard.sh'), instances: [],
            policy: { hosted_db_hosts: ['db.example.test'], protected_branches: ['main'],
                ask_is_deny_on: ['codex'], readonly: { kind: 'agent', name: 'evaluator' } },
            adapters: await Promise.all(['claude', 'codex', 'opencode'].map(async name => JSON.parse(await fixture(`${name}.adapter.json`)))),
        })
        expect(expansion.kind).toBe('complete')
        if (expansion.kind !== 'complete') throw new Error(JSON.stringify(expansion))
        await mkdir(join(directory, '.cockpit/guards'), { recursive: true })
        // The subprocess boundary captures the actual registration's stdin, without executing the candidate command.
        await writeFile(join(directory, guardPath), 'cat > "$COCKPIT_TEST_CAPTURE"\nprintf \'{}\'\n', { mode: 0o600 })
        const framedBytes: Record<string, number> = {}
        for (const [name, word] of [['astral', '😀'.repeat(128)], ['escaping', "'".repeat(128)]] as const) {
            const argv = Array(32).fill(word)
            expect(Buffer.byteLength(word)).toBeLessThanOrEqual(512)
            expect(argv.reduce((bytes, value) => bytes + Buffer.byteLength(value), 0)).toBeLessThanOrEqual(16_384)
            const rendered = renderGuardProjectCommand(argv)
            expect(rendered.kind).toBe('complete')
            if (rendered.kind !== 'complete') throw new Error('boundary command did not render')
            expect(Buffer.byteLength(rendered.command)).toBeLessThan(GUARD_PROJECT_COMMAND_RENDERED_BYTES)
            for (const row of expansion.targets) {
                const registration = row.files[0]!
                let nativeInput: Buffer | undefined
                let execution
                if (row.target === 'opencode') {
                    const pluginUrl = `data:text/javascript;base64,${Buffer.from(registration.bytes).toString('base64')}`
                    const runner = `const { CockpitRestrictions } = await import(${JSON.stringify(pluginUrl)}); const hooks = await CockpitRestrictions(); await hooks['tool.execute.before']({ tool: 'bash', sessionID: 'synthetic-session', callID: 'synthetic-call' }, { args: JSON.parse(process.argv[1]) });`
                    execution = spawnSync(process.execPath, ['--input-type=module', '--eval', runner, JSON.stringify({ command: rendered.command })], {
                        cwd: directory, env: { ...process.env, COCKPIT_TEST_CAPTURE: capturePath }, encoding: 'utf8',
                    })
                } else {
                    nativeInput = Buffer.from(JSON.stringify({
                        session_id: `synthetic-${row.target}`, transcript_path: `/workspace/project/${row.target}.jsonl`,
                        cwd: '/workspace/project', permission_mode: 'default', hook_event_name: 'PreToolUse',
                        tool_name: 'Bash', tool_use_id: 'synthetic-call', tool_input: { command: rendered.command },
                    }, null, row.target === 'claudecode' ? 2 : undefined) + '\n')
                    const registrationCommand = JSON.parse(registration.bytes).hooks.PreToolUse[0].hooks[0].command
                    execution = spawnSync('/bin/sh', ['-c', registrationCommand], {
                        cwd: directory, input: nativeInput, env: { ...process.env, COCKPIT_TEST_CAPTURE: capturePath }, encoding: 'utf8',
                    })
                }
                expect(execution.error).toBeUndefined()
                expect(execution.status, execution.stderr).toBe(0)
                const captured = await readFile(capturePath)
                if (nativeInput) expect(captured.equals(nativeInput), `${row.target} exact stdin bytes`).toBe(true)
                framedBytes[`${name}-${row.target}`] = captured.byteLength
                expect(captured.byteLength).toBeLessThan(GUARD_PROJECT_COMMAND_RENDERED_BYTES)
                expect(captured.byteLength).toBeLessThan(GUARD_INPUT_LIMITS.inputBytes)
                const envelope = JSON.parse(captured.toString('utf8'))
                expect(envelope).toMatchObject({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: rendered.command } })
                if (row.target === 'opencode') expect(Object.keys(envelope).sort()).toEqual(['hook_event_name', 'tool_input', 'tool_name'])
                // The parser consumes closed fields; native metadata is framing evidence, and the plugin relies on process cwd.
                const stdin = JSON.stringify({ hook_event_name: envelope.hook_event_name, tool_name: envelope.tool_name,
                    tool_input: envelope.tool_input, cwd: envelope.cwd ?? '/workspace/project' })
                expect(planGuardTransport({ target: row.target, handler: '/workspace/bin/cockpit', cwd: '/workspace/project', stdin }).kind).toBe('complete')
                const parsed = parseGuardInput(stdin)
                expect(parsed.status).toBe('parsed')
                if (parsed.status !== 'parsed') throw new Error(JSON.stringify(parsed))
                expect(parsed.invocations[0]?.executable).toBe(argv[0])
                expect(parsed.invocations[0]?.argv).toEqual(argv.slice(1))
            }
        }
        expect(Object.keys(framedBytes)).toHaveLength(6)
        expect(framedBytes['astral-claudecode']).toBeGreaterThan(framedBytes['astral-codexcli']!)
        expect(framedBytes['astral-codexcli']).toBeGreaterThan(framedBytes['astral-opencode']!)
        for (const argv of [['😀'.repeat(129)], ["'".repeat(129)], Array(33).fill('x')]) {
            expect(renderGuardProjectCommand(argv)).toMatchObject({ kind: 'unavailable' })
        }
    })
    it('freezes only explicitly declared exact build/test argv from matching source and catalog authority', async () => {
        const root = await checkout(['package-lock.json'])
        const catalog = [policy({ build: ['npm', 'run', 'build'], test: ['npm', 'test', '--', 'unit.test.ts'] })]
        const result = await resolveObserved(root, 0, { ...baseSibling, toolchain: 'node' }, catalog)
        expect(result).toMatchObject({ kind: 'complete', bindings: [{ policy: { build: catalog[0]!.build, test: catalog[0]!.test } }] })
        if (result?.kind !== 'complete') throw new Error('declared project commands did not resolve')
        const resolved = result.bindings[0]!.policy
        expect(Object.isFrozen(resolved.build)).toBe(true)
        expect(Object.isFrozen(resolved.test)).toBe(true)
        catalog[0]!.build![1] = 'changed'
        expect(resolved.build).toEqual(['npm', 'run', 'build'])
        const absent = await resolveObserved(root, 0, { ...baseSibling, toolchain: 'node' }, [policy()])
        expect(absent?.kind === 'complete' && absent.bindings[0]!.policy.build).toBeUndefined()
        for (const change of ['catalog', 'source', 'projection-copy'] as const) {
            const issued = await observed(root, 0, 'service', catalog)
            const result = await withInstallPolicyProjection(issued.observation, issued.expected, projection => {
                const value = input(catalog, { ...baseSibling, toolchain: 'node' }, 0, { checkoutRoot: root, checkoutId: issued.expected.checkoutId, projection })
                if (change === 'catalog') value.policies = [policy({ build: ['npm', 'run', 'other'] })]
                if (change === 'source') value.source = { ...source, sha256: 'c'.repeat(64) }
                if (change === 'projection-copy') value.projection = { ...projection }
                return resolveInstallPolicies(value)
            })
            expect(result, change).toMatchObject({ kind: 'unavailable' })
        }
    })
    it('needs no policy or checkout observation for a none toolchain', () => {
        expect(resolveInstallPolicies(input([], { ...baseSibling, toolchain: 'none' })))
            .toEqual({ kind: 'complete', bindings: [] })
    })

    it('resolves one policy for multiple independently sequenced siblings with immutable provenance', async () => {
        const catalog = [policy()]
        const firstRoot = await checkout(['package-lock.json'])
        const secondRoot = await checkout(['package-lock.json'])
        const first = await resolveObserved(firstRoot, 0, { ...baseSibling, toolchain: 'node' }, catalog)
        const secondSibling = { ...baseSibling, slug: 'worker', dir: 'worker', var: 'WORKER_DIR', toolchain: 'node' as const }
        const second = await resolveObserved(secondRoot, 1, secondSibling, catalog)

        expect(first).toMatchObject({
            kind: 'complete',
            bindings: [{ source, siblingIndex: 0, diagnostics: { catalogIndex: 0 }, siblingSlug: 'service', checkoutRoot: firstRoot }],
        })
        expect(second).toMatchObject({
            kind: 'complete',
            bindings: [{ source, siblingIndex: 1, diagnostics: { catalogIndex: 0 }, siblingSlug: 'worker', checkoutRoot: secondRoot }],
        })
        expect(first && Object.isFrozen(first)).toBe(true)
        expect(first?.kind === 'complete' && Object.isFrozen(first.bindings)).toBe(true)
    })

    it('distinguishes unavailable, missing and ambiguous policy evidence', async () => {
        expect(resolveInstallPolicies(input([policy()], { ...baseSibling, toolchain: 'node' })))
            .toMatchObject({ kind: 'unavailable', code: 'INSTALL_POLICY_OBSERVATION_UNAVAILABLE', siblingSlug: 'service' })

        const emptyRoot = await checkout([])
        expect(await resolveObserved(emptyRoot, 0, { ...baseSibling, toolchain: 'node' }, [policy()]))
            .toMatchObject({ kind: 'refusal', code: 'INSTALL_POLICY_MISSING', siblingSlug: 'service' })

        const ambiguousRoot = await checkout(['package-lock.json', 'npm-shrinkwrap.json'])
        const ambiguousPolicies = [policy({ lockfile: 'npm-shrinkwrap.json', volume: 'shrinkwrap' }), policy()]
        const outcome = await resolveObserved(ambiguousRoot, 0, { ...baseSibling, toolchain: 'node' }, ambiguousPolicies)
        expect(outcome).toMatchObject({ kind: 'refusal', code: 'INSTALL_POLICY_AMBIGUOUS', siblingSlug: 'service' })
        expect(outcome?.kind === 'refusal' && outcome.candidates)
            .toEqual(['node:npm-shrinkwrap.json', 'node:package-lock.json'])
    })

    it('rejects forged, replayed, mismatched-catalog and cross-checkout projections', async () => {
        const root = await checkout(['package-lock.json', 'npm-shrinkwrap.json'])
        const catalog = [policy(), policy({ volume: 'shrinkwrap', lockfile: 'npm-shrinkwrap.json' })]
        expect(resolveInstallPolicies(input(catalog, { ...baseSibling, toolchain: 'node' }, 0, {
            checkoutRoot: root,
            checkoutId: checkoutId({ checkoutPath: root }),
            projection: Object.freeze({}) as InstallPolicyProjection,
        }))).toMatchObject({ kind: 'unavailable' })

        const incomplete = await observed(root, 0, 'service', [catalog[0]!])
        expect(await withInstallPolicyProjection(
            incomplete.observation,
            { ...incomplete.expected, policies: catalog },
            () => 'used',
        )).toBeUndefined()

        const issued = await observed(root, 0, 'service', catalog)
        let escaped: InstallPolicyProjection | undefined
        const first = await withInstallPolicyProjection(issued.observation, issued.expected, (projection) => {
            escaped = projection
            return resolveInstallPolicies(input(catalog, { ...baseSibling, toolchain: 'node' }, 0, {
                checkoutRoot: root, checkoutId: issued.expected.checkoutId, projection,
            }))
        })
        expect(first).toMatchObject({ kind: 'refusal', code: 'INSTALL_POLICY_AMBIGUOUS' })
        expect(resolveInstallPolicies(input(catalog, { ...baseSibling, toolchain: 'node' }, 0, {
            checkoutRoot: root, checkoutId: issued.expected.checkoutId, projection: escaped!,
        }))).toMatchObject({ kind: 'unavailable' })

        const otherRoot = await checkout(['package-lock.json', 'npm-shrinkwrap.json'])
        const substitution = await observed(root, 0, 'service', catalog)
        expect(await withInstallPolicyProjection(substitution.observation, substitution.expected, (projection) =>
            resolveInstallPolicies(input(catalog, { ...baseSibling, toolchain: 'node' }, 0, {
                checkoutRoot: otherRoot, checkoutId: checkoutId({ checkoutPath: otherRoot }), projection,
            })))).toMatchObject({ kind: 'unavailable' })
    })

    it('fails closed on hostile top-level and sibling accessors', () => {
        let reads = 0
        const hostile = Object.defineProperty(input([], { ...baseSibling, toolchain: 'none' }), 'policies', {
            enumerable: true,
            get: () => { reads += 1; return [] },
        })
        expect(resolveInstallPolicies(hostile as never)).toMatchObject({ kind: 'unavailable' })
        expect(reads).toBe(0)

        const hostileSibling = Object.defineProperty({ ...baseSibling, toolchain: 'none' }, 'slug', {
            enumerable: true,
            get: () => { reads += 1; return 'service' },
        })
        expect(resolveInstallPolicies(input([], hostileSibling as never))).toMatchObject({ kind: 'unavailable' })
        expect(reads).toBe(0)
    })

    it('rejects duplicate runtime catalog volumes independently of schema loading', () => {
        const duplicateVolume = [policy(), policy({ toolchain: 'python', lockfile: 'requirements.lock' })]
        expect(resolveInstallPolicies(input(duplicateVolume, { ...baseSibling, toolchain: 'none' })))
            .toMatchObject({ kind: 'unavailable', reason: 'install policy catalog is invalid' })
    })

    it('keeps the selected policy invariant when catalog diagnostic order changes', async () => {
        const root = await checkout(['package-lock.json'])
        const firstCatalog = [policy({ toolchain: 'python', lockfile: 'requirements.lock', volume: 'python' }), policy()]
        const secondCatalog = [...firstCatalog].reverse()
        const first = await resolveObserved(root, 0, { ...baseSibling, toolchain: 'node' }, firstCatalog)
        const second = await resolveObserved(root, 0, { ...baseSibling, toolchain: 'node' }, secondCatalog)
        expect(first?.kind).toBe('complete')
        expect(second?.kind).toBe('complete')
        if (first?.kind !== 'complete' || second?.kind !== 'complete') return
        expect(first.bindings[0]?.policy).toEqual(second.bindings[0]?.policy)
        expect(first.bindings[0]?.diagnostics.catalogIndex).toBe(1)
        expect(second.bindings[0]?.diagnostics.catalogIndex).toBe(0)
    })
})
