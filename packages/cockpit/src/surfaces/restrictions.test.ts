import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, symlink, writeFile, realpath } from 'node:fs/promises'
import { lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stringify } from 'smol-toml'
import { encodeOwnershipManifest } from './ownership.js'
import { cockpitId } from '../environment/identity.js'
import { spawn, spawnSync } from 'node:child_process'

import { afterAll, describe, expect, it } from 'vitest'

import {
    compareRestrictionOutputs,
    expandRestrictions,
    inspectShippedRestrictionCapabilities,
    mechanism,
    RESTRICTION_OUTPUT_LIMITS,
    validateGuardRegistration,
    type RestrictionExpansionComplete,
    type RestrictionExpansionInput,
} from './restrictions.js'

const root = new URL('../../', import.meta.url)
const contexts = new Map<string, { root: string; alias: string; api: string; source: string; configPath: string }>()
const renderedContexts = new Map<string, { root: string; alias: string; api: string }>()
const scratch: string[] = []
afterAll(() => scratch.forEach(path => rmSync(path, { recursive: true, force: true })))

async function isolatedProjectRoot(prefix: string): Promise<string> {
    const estate = await realpath(await mkdtemp(join(tmpdir(), prefix)))
    scratch.push(estate)
    const project = join(estate, 'product')
    await mkdir(project)
    return project
}

async function fixture(name: string): Promise<string> {
    return readFile(new URL(`surfaces/guards/${name}`, root), 'utf8')
}

async function shippedInputs() {
    return {
        guardTemplate: await fixture('bash-guard.sh'),
        adapters: await Promise.all(['claude', 'codex', 'opencode'].map(async (name) =>
            JSON.parse(await fixture(`${name}.adapter.json`)) as unknown)),
    }
}

function pureInput(shipped: Awaited<ReturnType<typeof shippedInputs>>): RestrictionExpansionInput {
    return {
        canonicalProjectRoot: '/workspace/product',
        guardTemplate: shipped.guardTemplate,
        guardPath: '.cockpit/guards/bash-guard.sh',
        instances: [{ kind: 'instance', name: 'service-instance', path: 'env/service.env' }],
        policy: {
            hosted_db_hosts: ['db.example.test'], protected_branches: ['main'], ask_is_deny_on: ['codex'],
            readonly: { kind: 'agent', name: 'evaluator' },
        },
        adapters: shipped.adapters,
    }
}

async function input(overrides: Partial<RestrictionExpansionInput> = {}): Promise<RestrictionExpansionInput> {
    const parent = await realpath(await mkdtemp(join(tmpdir(), 'cockpit-restriction-estate-')))
    scratch.push(parent)
    const product = join(parent, 'product')
    const api = join(parent, 'api')
    const mapped = (value: string) => value.replaceAll('/workspace/product', product).replaceAll('/workspace/api', api)
    const value: RestrictionExpansionInput = {
        canonicalProjectRoot: '/workspace/product',
        guardTemplate: await fixture('bash-guard.sh'),
        guardPath: '.cockpit/guards/bash-guard.sh',
        instances: [{ kind: 'instance', name: 'service-instance', path: 'env/service.env' }],
        policy: {
            hosted_db_hosts: ['db.example.test'],
            protected_branches: ['main'],
            ask_is_deny_on: ['codex'],
            readonly: { kind: 'agent', name: 'evaluator' },
        },
        adapters: await Promise.all(['claude', 'codex', 'opencode'].map(async (name) =>
            JSON.parse(await fixture(`${name}.adapter.json`)) as unknown)),
        ...overrides,
    }
    let canonical = mapped(value.canonicalProjectRoot)
    let roots = (value.allowedProjectRoots ?? [canonical]).map(mapped)
    const instances = value.instances.map(row => ({ ...row, ...(row.root ? { root: mapped(row.root) } : {}) }))
    // Invalid expansion inputs remain pure capture controls, without filesystem effects.
    if (!canonical.startsWith('/') || canonical.endsWith('/') || canonical.length > 4096
        || !roots.every(path => path.startsWith(parent) || path.startsWith(tmpdir()) || path.startsWith('/private/var/'))) return { ...value, canonicalProjectRoot: canonical, allowedProjectRoots: roots, instances,
            handler: { root: canonical, rootDevice: '0', rootInode: '0', configDevice: '0', configInode: '0',
                configPath: `${canonical}/cockpit.toml`, configSha256: 'a'.repeat(64), node: `${canonical}/node`, nodeSha256: 'b'.repeat(64),
                module: `${canonical}/cli.js`, moduleSha256: 'c'.repeat(64) } }
    await mkdir(canonical, { recursive: true })
    for (const path of roots) await mkdir(path, { recursive: true })
    const alias = canonical
    canonical = await realpath(canonical)
    roots = roots.map(path => path === alias ? canonical : path)
    expect(spawnSync('git', ['init', '--quiet', canonical]).status).toBe(0)
    const source = stringify({ cockpit: { name: 'synthetic-restrictions', siblings_root: dirname(canonical) },
        sibling: roots.map((path, index) => {
            const files = instances.filter(row => (row.root ?? canonical) === path).map(row => ({ template: `${row.path}.example`, instance: row.path }))
            return { slug: `repo-${index}`, dir: path, mount: 'always', acquire: 'none', var: `REPO_${index}_DIR`, purpose: 'Synthetic checkout',
                ...(files.length ? { environment_files: files } : {}) }
        }),
        guards: { hosted_db_hosts: [...value.policy.hosted_db_hosts], protected_branches: [...value.policy.protected_branches], ask_is_deny_on: [...value.policy.ask_is_deny_on] },
        ports: { bases: { APP_PORT: 4100 } },
    })
    const configPath = join(canonical, 'cockpit.toml')
    await writeFile(configPath, source)
    const node = realpathSync(process.execPath)
    const module = fileURLToPath(new URL('dist/cli.js', root))
    const rootStat = lstatSync(canonical)
    const configStat = lstatSync(configPath)
    const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex')
    const handler = { root: canonical, rootDevice: String(rootStat.dev), rootInode: String(rootStat.ino), configPath,
        configDevice: String(configStat.dev), configInode: String(configStat.ino), configSha256: hash(configPath),
        node, nodeSha256: hash(node), module, moduleSha256: hash(module) }
    contexts.set(handler.configSha256, { root: canonical, alias, api, source, configPath })
    return { ...value, canonicalProjectRoot: canonical, allowedProjectRoots: roots, instances, handler }
}

function complete(value: ReturnType<typeof expandRestrictions>): RestrictionExpansionComplete {
    expect(value.kind).toBe('complete')
    if (value.kind !== 'complete') throw new Error(JSON.stringify(value))
    const context = [...contexts].find(([hash]) => value.sharedGuard.bytes.includes(hash))?.[1]
    if (context) {
        const files = [value.sharedGuard, ...value.targets.flatMap(row => row.files)]
        for (const file of files) {
            mkdirSync(dirname(join(context.root, file.path)), { recursive: true })
            writeFileSync(join(context.root, file.path), file.bytes, { mode: 0o600 })
        }
        const sourceSha256 = createHash('sha256').update(context.source).digest('hex')
        const manifest = encodeOwnershipManifest({ root: context.root, configPath: context.configPath,
            cockpitId: cockpitId({ name: 'synthetic-restrictions', mainCheckoutPath: context.root }),
            generation: 'a'.repeat(64), sourceSha256, personaSource: { path: 'fixtures/synthetic.json', sha256: 'b'.repeat(64) },
            owned: files, surfaces: [] })
        writeFileSync(join(context.root, '.cockpit/generated-environment-ownership.json'), manifest.bytes)
        renderedContexts.set(value.sharedGuard.bytes, context)
    }
    return value
}

function target(result: RestrictionExpansionComplete, name: RestrictionExpansionComplete['targets'][number]['target']) {
    return result.targets.find((candidate) => candidate.target === name)!
}

function runGuard(bytes: string, payload: unknown, env: Record<string, string> = {}) {
    const context = renderedContexts.get(bytes)
    if (!context) throw new Error('Guard fixture was not published')
    const input = JSON.parse(JSON.stringify(payload).replaceAll('/workspace/product', context.root).replaceAll('/workspace/api', context.api).replaceAll(context.alias, context.root))
    const result = spawnSync('/bin/bash', ['-c', bytes, 'guard', '--harness', 'claudecode'], {
        cwd: context.root,
        input: JSON.stringify({ ...input, cwd: context.root }),
        encoding: 'utf8',
        env: { ...process.env, PATH: process.env.PATH, ...env },
    })
    const lines = result.stderr.match(/[^\n]*\n|[^\n]+$/g) ?? []
    const records = lines.filter(line => line.startsWith('{"result":null,"diagnostics":[],"invocation":'))
    expect(records).toHaveLength(1)
    const record = JSON.parse(records[0]!)
    expect(record).toEqual({ result: null, diagnostics: [], invocation: {
        verb: 'guard-evaluate', durationMs: expect.any(Number), exitCode: result.status, resolvedConfigPath: null,
    } })
    expect(Number.isSafeInteger(record.invocation.durationMs)).toBe(true)
    expect(record.invocation.durationMs).toBeGreaterThanOrEqual(0)
    return { ...result, invocation: record.invocation, stderr: lines.filter(line => line !== records[0]).join('') }
}

function bash(command: string) {
    return { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } }
}

function edit(path: string) {
    return { hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: path, content: 'credential-canary' } }
}

describe('restriction expansion', () => {
    it('issues shipped restriction facts from the same template and adapter validation as expansion', async () => {
        const shipped = await shippedInputs()
        const inspected = inspectShippedRestrictionCapabilities({
            guardTemplate: shipped.guardTemplate,
            adapters: shipped.adapters,
        })
        expect(inspected).toEqual({
            kind: 'complete',
            targets: [
                { target: 'claudecode', capability: 'instructed', evidenceStatus: 'pending_evidence', measuredOn: '2026-08-25', measuredVersion: '2.1.220', provenance: 'paired native PreToolUse payload and decision probe' },
                { target: 'codexcli', capability: 'instructed', evidenceStatus: 'pending_evidence', measuredOn: '2026-08-24', measuredVersion: '0.149.0', provenance: 'paired native PreToolUse payload, apply_patch and ask-decision probe' },
                { target: 'opencode', capability: 'instructed', evidenceStatus: 'pending_evidence', measuredOn: '2026-08-24', measuredVersion: '1.18.15', provenance: 'paired native tool.execute.before payload, apply_patch and thrown-refusal probe' },
            ],
        })
        expect(Object.isFrozen(inspected)).toBe(true)
        expect(inspected.kind === 'complete' && Object.isFrozen(inspected.targets)).toBe(true)
        expect(inspected.kind === 'complete' && inspected.targets.every(Object.isFrozen)).toBe(true)

        const expanded = complete(expandRestrictions(pureInput(shipped)))
        expect(expanded.targets.map(({ target, capability, evidenceStatus, measuredOn, measuredVersion, provenance }) =>
            ({ target, capability, evidenceStatus, measuredOn, measuredVersion, provenance })))
            .toEqual(inspected.kind === 'complete' ? inspected.targets : [])
    })

    it('refuses shipped facts when the actual template or measured adapters are incomplete or changed', async () => {
        const captured = await shippedInputs()
        expect(inspectShippedRestrictionCapabilities({
            guardTemplate: captured.guardTemplate.replace('__COCKPIT_GUARD_NODE__', ''),
            adapters: captured.adapters,
        })).toMatchObject({ kind: 'refusal', code: 'RESTRICTION_TEMPLATE_INVALID' })
        expect(inspectShippedRestrictionCapabilities({
            guardTemplate: captured.guardTemplate,
            adapters: captured.adapters.slice(0, 2),
        })).toMatchObject({ kind: 'refusal', code: 'RESTRICTION_EVENT_UNADAPTED' })
        expect(inspectShippedRestrictionCapabilities({
            guardTemplate: captured.guardTemplate,
            adapters: [{ ...captured.adapters[0] as object, measuredVersion: '2.1.221' }, ...captured.adapters.slice(1)],
        })).toMatchObject({ kind: 'refusal', code: 'RESTRICTION_ADAPTER_INVALID' })
        const unavailable = [...captured.adapters]
        unavailable[1] = {
            format: 'cockpit-restriction-adapter/v1', target: 'codexcli', mechanism: 'unavailable',
            measuredOn: '2026-08-24', measuredVersion: null,
            provenance: 'paired source measurement found no applicable hook mechanism',
            reason: 'source measurement did not identify a harness version',
        }
        const unavailableResult = inspectShippedRestrictionCapabilities({
            guardTemplate: captured.guardTemplate,
            adapters: unavailable,
        })
        expect(unavailableResult.kind).toBe('complete')
        expect(unavailableResult.kind === 'complete'
            && unavailableResult.targets.find(row => row.target === 'codexcli')).toMatchObject({
            target: 'codexcli', capability: 'unavailable', evidenceStatus: 'not_applicable', measuredVersion: null,
        })
        const expanded = complete(expandRestrictions({ ...pureInput(captured), adapters: unavailable }))
        expect(target(expanded, 'codexcli')).toMatchObject({
            capability: 'unavailable', evidenceStatus: 'not_applicable', measuredVersion: null, files: [],
        })
    })

    it('validates staged handler registration as bytes and exact argv without replacing legacy output', async () => {
        const captured = await input()
        const legacy = complete(expandRestrictions(captured))
        const staged = { target: 'codexcli', handler: '/workspace/bin/cockpit', cwd: '/workspace/product',
            argv: ['guard-evaluate', '--harness', 'codexcli'],
            registration: { path: '.codex/hooks.json', bytes: 'synthetic candidate bytes' } }
        expect(validateGuardRegistration(staged)).toMatchObject({ kind: 'complete', registration: {
            ...staged.registration, sha256: createHash('sha256').update(staged.registration.bytes).digest('hex'),
        } })
        for (const changed of [
            { ...staged, argv: ['guard-evaluate', '--harness', 'claudecode'] },
            { ...staged, argv: ['internal', 'guard', '--harness', 'codexcli'] },
            { ...staged, registration: { path: '../hooks.json', bytes: 'bytes' } },
            { ...staged, registration: { ...staged.registration, bytes: 'x'.repeat(65_537) } },
        ]) expect(validateGuardRegistration(changed).kind).toBe('refusal')
        expect(complete(expandRestrictions(captured))).toEqual(legacy)
        expect(RESTRICTION_OUTPUT_LIMITS).toEqual({ scalarBytes: 65_536, aggregateBytes: 102_400, fileCount: 8 })
    })

    it('declares its runtime limit export and refuses accessors without invoking them', async () => {
        expect(mechanism.exports).toContain('RESTRICTION_OUTPUT_LIMITS')
        const value = await input()
        let reads = 0
        const hostile = Object.defineProperty({ ...value }, 'guardTemplate', {
            enumerable: true,
            get() { reads += 1; return value.guardTemplate },
        })
        expect(expandRestrictions(hostile)).toMatchObject({ kind: 'refusal', code: 'RESTRICTION_INPUT_INVALID' })
        expect(reads).toBe(0)
    })

    it('captures database hosts with the shared bounded grammar and normalized uniqueness', async () => {
        const value = await input()
        const exact = `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(61)}`
        for (const hosts of [[exact], [`*.${exact}`], ['localhost'], Array.from({ length: 128 }, (_, index) => `host-${index}.test`)]) {
            expect(expandRestrictions({ ...value, policy: { ...value.policy, hosted_db_hosts: hosts } }).kind).toBe('complete')
        }
        for (const hosts of [[`${exact}a`], [`*.${exact}a`], [`${'a'.repeat(64)}.test`], ['db..test'], ['db.test\n'], ['db.test', '*.db.test'], Array.from({ length: 129 }, (_, index) => `host-${index}.test`)]) {
            expect(expandRestrictions({ ...value, policy: { ...value.policy, hosted_db_hosts: hosts } })).toMatchObject({ kind: 'refusal', code: 'RESTRICTION_INPUT_INVALID' })
        }
    })

    it('launches published non-executable guards through both hook registrations', async () => {
        const directory = await isolatedProjectRoot('cockpit-hook-launch-')
        const result = complete(expandRestrictions(await input({ canonicalProjectRoot: directory })))
        await mkdir(join(directory, '.cockpit', 'guards'), { recursive: true })
        await writeFile(join(directory, result.sharedGuard.path), result.sharedGuard.bytes, { mode: 0o600 })
        for (const name of ['claudecode', 'codexcli'] as const) {
            const registration = JSON.parse(target(result, name).files[0]!.bytes) as {
                hooks: { PreToolUse: Array<{ hooks: Array<{ command: string }> }> }
            }
            const command = registration.hooks.PreToolUse[0]!.hooks[0]!.command
            const allowed = spawnSync('/bin/sh', ['-c', command], {
                cwd: directory, input: JSON.stringify(edit('env/service.env.example')), encoding: 'utf8',
            })
            expect(allowed.status, allowed.stderr).toBe(0)
            expect(allowed.stdout).toBe('')
            const denied = spawnSync('/bin/sh', ['-c', command], {
                cwd: directory, input: JSON.stringify(edit('env/service.env')), encoding: 'utf8',
            })
            expect(denied.status, denied.stderr).toBe(0)
            expect(denied.stdout).toContain('permissionDecision":"deny')
        }
    })

    it('turns every guard failure other than the blocking exit into a blocking exit', async () => {
        const directory = await isolatedProjectRoot('cockpit-hook-failure-')
        const result = complete(expandRestrictions(await input({ canonicalProjectRoot: directory })))
        await mkdir(join(directory, '.cockpit', 'guards'), { recursive: true })
        for (const name of ['claudecode', 'codexcli'] as const) {
            const command = (JSON.parse(target(result, name).files[0]!.bytes) as {
                hooks: { PreToolUse: Array<{ hooks: Array<{ command: string }> }> }
            }).hooks.PreToolUse[0]!.hooks[0]!.command
            // A guard that cannot load its handler exits 1; a killed one 137. Exit 2 keeps its own reason.
            for (const [exit, status, stderr] of [[1, 2, 'cockpit guard failed (exit 1)\n'], [137, 2, 'cockpit guard failed (exit 137)\n'], [2, 2, 'refused\n'], [0, 0, '']] as const) {
                await writeFile(join(directory, result.sharedGuard.path), exit === 2 ? "printf 'refused\\n' >&2; exit 2\n" : `exit ${exit}\n`)
                const run = spawnSync('/bin/sh', ['-c', command], { cwd: directory, input: '{}', encoding: 'utf8' })
                expect({ status: run.status, stderr: run.stderr }, `${name} exit ${exit}`).toEqual({ status, stderr })
            }
        }
    })

    it('renders every neutral policy field through versioned transport-only adapters', async () => {
        const baseInput = await input()
        const result = complete(expandRestrictions(baseInput))

        expect(result.targets.map(({ target: name, capability, evidenceStatus, measuredVersion }) =>
            ({ name, capability, evidenceStatus, measuredVersion }))).toEqual([
            { name: 'claudecode', capability: 'instructed', evidenceStatus: 'pending_evidence', measuredVersion: '2.1.220' },
            { name: 'codexcli', capability: 'instructed', evidenceStatus: 'pending_evidence', measuredVersion: '0.149.0' },
            { name: 'opencode', capability: 'instructed', evidenceStatus: 'pending_evidence', measuredVersion: '1.18.15' },
        ])
        expect(target(result, 'claudecode').readonly).toMatchObject({
            agent: 'evaluator', capability: 'instructed', fragment: { path: '.claude/agents/evaluator.md' },
        })
        expect(target(result, 'claudecode').readonly.fragment?.bytes).toBe('disallowedTools: Edit, Write, NotebookEdit\n')
        expect(target(result, 'codexcli').readonly).toMatchObject({ capability: 'instructed', fragment: null })
        expect(target(result, 'opencode').readonly.fragment).toMatchObject({
            path: '.opencode/agents/evaluator.md', bytes: 'permission:\n  edit: deny\n',
        })
        expect(target(result, 'claudecode').files[0]).toMatchObject({ path: '.claude/settings.json' })
        expect(target(result, 'claudecode').files[0]!.bytes).toContain('Bash|Edit|Write')
        expect(target(result, 'codexcli').files[0]).toMatchObject({ path: '.codex/hooks.json' })
        expect(target(result, 'codexcli').files[0]!.bytes).toContain('Bash|Edit|Write|apply_patch')
        expect(target(result, 'opencode').files[0]).toMatchObject({ path: '.opencode/plugin/cockpit-guards.js' })
        expect(target(result, 'opencode').files[0]!.bytes).toContain('"tool.execute.before"')
        expect(target(result, 'opencode').files[0]!.bytes).toContain('spawnSync("/bin/bash"')

        expect(runGuard(result.sharedGuard.bytes, bash('psql postgresql://db.example.test/app')).stdout)
            .toContain('permissionDecision":"deny')
        expect(runGuard(result.sharedGuard.bytes, bash('git push origin main')).stdout)
            .toContain('permissionDecision":"deny')

        const hostChanged = complete(expandRestrictions(await input({ policy: {
            ...baseInput.policy, hosted_db_hosts: ['archive.example.test'],
        } })))
        expect(hostChanged.sharedGuard.sha256).not.toBe(result.sharedGuard.sha256)
        expect(runGuard(hostChanged.sharedGuard.bytes, bash('psql postgresql://db.example.test/app')).stdout).toContain('permissionDecision":"ask')
        expect(runGuard(hostChanged.sharedGuard.bytes, bash('psql postgresql://archive.example.test/app')).stdout)
            .toContain('permissionDecision":"deny')

        const branchChanged = complete(expandRestrictions(await input({ policy: {
            ...baseInput.policy, protected_branches: ['release'],
        } })))
        expect(branchChanged.sharedGuard.sha256).not.toBe(result.sharedGuard.sha256)
        expect(runGuard(branchChanged.sharedGuard.bytes, bash('git push origin main')).stdout).toContain('permissionDecision":"ask')
        expect(runGuard(branchChanged.sharedGuard.bytes, bash('git push origin release')).stdout)
            .toContain('permissionDecision":"deny')

        const denyClaude = complete(expandRestrictions(await input({ policy: {
            ...baseInput.policy, ask_is_deny_on: ['codex', 'claude'],
        } })))
        expect(target(denyClaude, 'claudecode').files[0]!.bytes).toContain('COCKPIT_ASK_IS_DENY=1')
        expect(target(denyClaude, 'claudecode').files[0]!.sha256).not.toBe(target(result, 'claudecode').files[0]!.sha256)

        const reviewer = complete(expandRestrictions(await input({ policy: {
            ...baseInput.policy, readonly: { kind: 'agent', name: 'reviewer' },
        } })))
        expect(target(reviewer, 'opencode').readonly.fragment?.path).toBe('.opencode/agents/reviewer.md')
        expect(JSON.stringify(reviewer)).not.toContain('credential-canary')
    })

    it('normalizes exact, dot-relative and absolute instance paths and refuses escapes', async () => {
        const result = complete(expandRestrictions(await input()))

        for (const path of ['env/service.env', './env/service.env', '/workspace/product/env/service.env', '../product/env/service.env']) {
            const outcome = runGuard(result.sharedGuard.bytes, edit(path))
            expect(outcome, JSON.stringify({ path, ...outcome })).toMatchObject({
                status: 0, stdout: expect.stringContaining('permissionDecision":"deny'),
            })
        }
        for (const path of ['/workspace/product-other/env/service.env']) {
            expect(runGuard(result.sharedGuard.bytes, edit(path))).toMatchObject({
                status: 2, stderr: expect.stringContaining('escapes configured roots'),
            })
        }
        expect(runGuard(result.sharedGuard.bytes, edit('env/service.env.example'))).toMatchObject({ status: 0, stdout: '' })

        const directory = await isolatedProjectRoot('cockpit-restriction-')
        await writeFile(join(directory, 'private.env'), 'synthetic')
        const local = complete(expandRestrictions(await input({
            canonicalProjectRoot: directory,
            instances: [{ kind: 'instance', name: 'local-instance', path: 'private.env' }],
        })))
        expect(runGuard(local.sharedGuard.bytes, edit(join(directory, 'private.env')))).toMatchObject({
            status: 0, stdout: expect.stringContaining('declared environment instance'),
        })
    })

    it('ignores repository-provided policy utility replacements', async () => {
        const isolatedTmp = await realpath(await mkdtemp(join(tmpdir(), 'cockpit-restriction-tmp-')))
        scratch.push(isolatedTmp)
        const previousTmp = process.env.TMPDIR
        process.env.TMPDIR = isolatedTmp
        try {
            const directory = await isolatedProjectRoot('cockpit-restriction-path-')
            const hostileBin = join(directory, 'bin')
            await mkdir(hostileBin)
            await writeFile(join(hostileBin, 'grep'), '#!/bin/sh\nexit 1\n', { mode: 0o700 })
            const allowedProjectRoots = [directory, join(directory, 'sibling')]
            const result = complete(expandRestrictions(await input({ canonicalProjectRoot: directory, allowedProjectRoots })))
            const churn = spawn(process.execPath, ['--eval', `
const { mkdtempSync, rmSync } = require('node:fs')
const { join } = require('node:path')
process.stdout.write('ready\\n')
const end = Date.now() + 10_000
while (Date.now() < end) {
  const path = mkdtempSync(join(process.argv[1], 'foreign-'))
  rmSync(path, { recursive: true })
}
`, isolatedTmp], { stdio: ['ignore', 'pipe', 'inherit'] })
            const closed = new Promise<void>((resolve, reject) => {
                churn.once('error', reject)
                churn.once('exit', (code, signal) => code === 0 || signal === 'SIGTERM'
                    ? resolve()
                    : reject(new Error(`namespace churn exited with ${String(code ?? signal)}`)))
            })
            try {
                await Promise.race([
                    new Promise<void>((resolve, reject) => {
                        churn.stdout.once('data', resolve)
                        churn.stdout.once('error', reject)
                    }),
                    closed.then(() => { throw new Error('namespace churn exited before readiness') }),
                ])
                const outcome = runGuard(result.sharedGuard.bytes, bash('psql postgresql://db.example.test/app'), {
                    PATH: `${hostileBin}:${process.env.PATH ?? ''}`,
                })
                expect(outcome, JSON.stringify(outcome)).toMatchObject({
                    status: 0, stdout: expect.stringContaining('permissionDecision":"deny'),
                })
            } finally {
                if (churn.exitCode === null && churn.signalCode === null) churn.kill('SIGTERM')
                await closed
            }
        } finally {
            if (previousTmp === undefined) delete process.env.TMPDIR
            else process.env.TMPDIR = previousTmp
        }
    })

    it('refuses protected write and stage aliases with symlink components', async () => {
        const directory = await isolatedProjectRoot('cockpit-restriction-symlink-')
        await mkdir(join(directory, 'env'))
        await symlink('env', join(directory, 'alias-env'), 'dir')
        const result = complete(expandRestrictions(await input({ canonicalProjectRoot: directory })))

        for (const payload of [edit('alias-env/service.env'), bash('git add alias-env/service.env')]) {
            expect(runGuard(result.sharedGuard.bytes, payload)).toMatchObject({
                status: 2, stderr: expect.stringContaining('symlinked'),
            })
        }
        const protectedPath = runGuard(result.sharedGuard.bytes, edit('env/service.env'))
        expect(protectedPath.stderr, JSON.stringify(protectedPath)).toBe('')
        expect(protectedPath, JSON.stringify(protectedPath)).toMatchObject({
            status: 0, stdout: expect.stringContaining('permissionDecision":"deny'),
        })
    })

    it('guards declared instances across exact checkout roots while leaving sibling templates editable', async () => {
        const result = complete(expandRestrictions(await input({
            allowedProjectRoots: ['/workspace/product', '/workspace/api'],
            instances: [
                { kind: 'instance', name: 'service-instance', path: 'env/service.env' },
                { kind: 'instance', name: 'api-instance', root: '/workspace/api', path: 'env/private.env' },
            ],
        })))

        for (const path of [
            '/workspace/api/env/private.env',
            '../api/env/private.env',
            './../api/./env/../env/private.env',
        ]) {
            expect(runGuard(result.sharedGuard.bytes, edit(path))).toMatchObject({
                status: 0, stdout: expect.stringContaining('permissionDecision":"deny'),
            })
        }
        for (const path of ['/workspace/api/env/private.env.example', '../api/env/private.env.example']) {
            expect(runGuard(result.sharedGuard.bytes, edit(path))).toMatchObject({ status: 0, stdout: '' })
        }
        for (const path of ['/workspace/other/env/private.env', '../other/env/private.env']) {
            expect(runGuard(result.sharedGuard.bytes, edit(path))).toMatchObject({
                status: 2, stderr: expect.stringContaining('escapes configured roots'),
            })
        }

        const patch = '*** Begin Patch\n*** Update File: env/service.env.example\n*** Move to: ../api/env/private.env\n@@\n-old\n+new\n*** End Patch'
        expect(runGuard(result.sharedGuard.bytes, {
            hook_event_name: 'PreToolUse', tool_name: 'apply_patch', tool_input: { command: patch },
        })).toMatchObject({ status: 0, stdout: expect.stringContaining('permissionDecision":"deny') })
        expect(runGuard(result.sharedGuard.bytes, bash('git add ../api/env/private.env')).stdout)
            .toContain('permissionDecision":"deny')
        expect(runGuard(result.sharedGuard.bytes, bash('git add ../api/env/private.env.example')).stdout)
            .toContain('permissionDecision":"ask')
    })

    it('denies every patch spelling including Move-to and leaves the tracked template editable', async () => {
        const result = complete(expandRestrictions(await input()))
        for (const header of [
            '*** Add File: env/service.env',
            '*** Update File: ./env/service.env',
            '*** Delete File: /workspace/product/env/service.env',
            '*** Update File: env/service.env.example\n*** Move to: env/service.env',
        ]) {
            const patch = `*** Begin Patch\n${header}\n@@\n-old\n+new\n*** End Patch`
            expect(runGuard(result.sharedGuard.bytes, {
                hook_event_name: 'PreToolUse', tool_name: 'apply_patch', tool_input: { command: patch },
            })).toMatchObject({ status: 0, stdout: expect.stringContaining('permissionDecision":"deny') })
        }
        expect(runGuard(result.sharedGuard.bytes, {
            hook_event_name: 'PreToolUse', tool_name: 'apply_patch',
            tool_input: { command: '*** Begin Patch\n*** Update File: env/service.env.example\n@@\n-old\n+new\n*** End Patch' },
        })).toMatchObject({ status: 0, stdout: '' })
        expect(target(result, 'opencode').files[0]!.bytes).toContain('args.patchText')
    })

    it('protects literal staging of each added instance while keeping templates stageable', async () => {
        const result = complete(expandRestrictions(await input({ instances: [
            { kind: 'instance', name: 'service-instance', path: 'env/service.env' },
            { kind: 'instance', name: 'reports-instance', path: 'env/reports/private.env' },
        ] })))

        expect(runGuard(result.sharedGuard.bytes, bash('git add ./env/reports/private.env')).stdout)
            .toContain('permissionDecision":"deny')
        expect(runGuard(result.sharedGuard.bytes, bash('git add env/service.env.example')).stdout).toContain('permissionDecision":"ask')
        expect(result.sharedGuard.bytes).not.toContain('reports-instance')
    })

    it('keeps destructive policy active when the instance set is empty and denies asks without a prompt tier', async () => {
        const result = complete(expandRestrictions(await input({ instances: [] })))
        expect(runGuard(result.sharedGuard.bytes, bash('git reset --hard HEAD~1')))
            .toMatchObject({ status: 2, stderr: expect.stringContaining('Dynamic command construction is unsupported') })
        const command = bash('git reset --hard HEAD')

        expect(runGuard(result.sharedGuard.bytes, command)).toMatchObject({ status: 0, stderr: '', stdout: expect.stringContaining('permissionDecision":"ask') })
        expect(runGuard(result.sharedGuard.bytes, command, { COCKPIT_ASK_IS_DENY: '1' }).stdout)
            .toContain('permissionDecision":"deny')
        expect(target(result, 'codexcli').files[0]!.bytes).toContain('COCKPIT_ASK_IS_DENY=1')
        expect(target(result, 'opencode').files[0]!.bytes).toContain('COCKPIT_ASK_IS_DENY: "1"')
    })

    it('bounds rendered UTF-8 output after substitution and shell-quote amplification', async () => {
        const baseInput = await input({
            canonicalProjectRoot: await isolatedProjectRoot("cockpit-quote'-"),
            instances: [{ kind: 'instance', name: 'quoted-instance', path: `env/${"'".repeat(100)}.env` }],
        })
        const minimal = '#!/usr/bin/env bash\n# __COCKPIT_GUARD_IDENTITY__\n# __COCKPIT_GUARD_NODE__\n# __COCKPIT_GUARD_MODULE__\n'
        const rendered = complete(expandRestrictions({ ...baseInput, guardTemplate: minimal }))
        expect(rendered.sharedGuard.bytes).toContain("'\\''")
        const padding = RESTRICTION_OUTPUT_LIMITS.scalarBytes - Buffer.byteLength(rendered.sharedGuard.bytes)
        const exact = complete(expandRestrictions({ ...baseInput, guardTemplate: `${minimal}${'x'.repeat(padding)}` }))
        expect(Buffer.byteLength(exact.sharedGuard.bytes)).toBe(RESTRICTION_OUTPUT_LIMITS.scalarBytes)
        expect(expandRestrictions({ ...baseInput, guardTemplate: `${minimal}${'x'.repeat(padding + 1)}` })).toMatchObject({
            kind: 'refusal', code: 'RESTRICTION_OUTPUT_LIMIT',
        })

        const aggregate = await input({
            canonicalProjectRoot: `/${"a'".repeat(2_000)}`,
            guardTemplate: `${minimal}${'x'.repeat(RESTRICTION_OUTPUT_LIMITS.scalarBytes - 12_000)}`,
        })
        expect(expandRestrictions(aggregate)).toMatchObject({ kind: 'refusal', code: 'RESTRICTION_OUTPUT_LIMIT' })
    })

    it('refuses unsupported policy, malformed payloads, foreign adapters and policy-bearing adapters', async () => {
        const value = await input()
        expect(expandRestrictions({ ...value, policy: { ...value.policy, ask_is_deny_on: ['foreign'] } })).toMatchObject({
            kind: 'refusal', code: 'RESTRICTION_POLICY_UNSUPPORTED',
        })
        expect(expandRestrictions({ ...value, instances: [{ kind: 'template', name: 'template', path: 'env/service.env.example' }] })).toMatchObject({
            kind: 'refusal', code: 'RESTRICTION_INPUT_INVALID',
        })
        expect(expandRestrictions({ ...value, instances: [{ kind: 'instance', name: 'outside', path: '../outside.env' }] })).toMatchObject({
            kind: 'refusal', code: 'RESTRICTION_INPUT_INVALID',
        })
        for (const candidate of [
            { ...value, canonicalProjectRoot: '/workspace/product/' },
            { ...value, allowedProjectRoots: ['/workspace/product', '/workspace/product'] },
            { ...value, allowedProjectRoots: ['/workspace/product', '../api'] },
            { ...value, allowedProjectRoots: ['/workspace/product', '/workspace/api/'] },
            { ...value, allowedProjectRoots: ['/workspace/api'] },
            {
                ...value,
                allowedProjectRoots: ['/workspace/product', '/workspace/api'],
                instances: [{ kind: 'instance', name: 'outside', root: '/workspace/other', path: 'private.env' }],
            },
        ]) {
            expect(expandRestrictions(candidate)).toMatchObject({ kind: 'refusal', code: 'RESTRICTION_INPUT_INVALID' })
        }
        expect(expandRestrictions({ ...value, adapters: [{ ...value.adapters[0] as object, policy: { decision: 'allow' } }, ...value.adapters.slice(1)] })).toMatchObject({
            kind: 'refusal', code: 'RESTRICTION_ADAPTER_INVALID',
        })
        expect(expandRestrictions({ ...value, adapters: [{ ...value.adapters[0] as object, credential: 'credential-canary' }, ...value.adapters.slice(1)] })).toMatchObject({
            kind: 'refusal', code: 'RESTRICTION_ADAPTER_INVALID',
        })
        expect(expandRestrictions({ ...value, adapters: [...value.adapters.slice(0, 2), {
            ...value.adapters[2] as object, payload: { kind: 'claude-pre-tool-use' },
        }] })).toMatchObject({ kind: 'refusal', code: 'RESTRICTION_ADAPTER_INVALID' })
        expect(expandRestrictions({ ...value, adapters: value.adapters.slice(0, 2) })).toMatchObject({
            kind: 'refusal', code: 'RESTRICTION_EVENT_UNADAPTED',
        })

        const result = complete(expandRestrictions(value))
        expect(runGuard(result.sharedGuard.bytes, { hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: {} }))
            .toMatchObject({ status: 2, stderr: expect.stringContaining('Malformed file payload') })
        expect(runGuard(result.sharedGuard.bytes, {
            hook_event_name: 'tool.execute.before', input: { tool: 'bash' }, args: { command: 'git reset --hard' },
        })).toMatchObject({ status: 2, stderr: expect.stringContaining('Guard request is malformed') })
    })

    it('emits no apparent control when a measured source supplies no mechanism version', async () => {
        const value = await input()
        const adapters = [...value.adapters]
        adapters[0] = {
            format: 'cockpit-restriction-adapter/v1', target: 'claudecode', mechanism: 'unavailable',
            measuredOn: '2026-08-25', measuredVersion: null,
            provenance: 'paired source measurement found no applicable hook mechanism',
            reason: 'source measurement did not identify a harness version',
        }
        const result = complete(expandRestrictions({ ...value, adapters }))

        expect(target(result, 'claudecode')).toMatchObject({
            capability: 'unavailable', evidenceStatus: 'not_applicable', measuredVersion: null, files: [],
            readonly: { capability: 'unavailable', evidenceStatus: 'not_applicable', fragment: null },
        })
    })

    it('reports one stale harness while the other outputs remain current', async () => {
        const expected = complete(expandRestrictions(await input()))
        const actual = structuredClone(expected) as unknown as {
            targets: Array<{ files: Array<{ bytes: string, sha256: string }> }>
        }
        actual.targets[1]!.files[0]!.bytes += '\n'
        actual.targets[1]!.files[0]!.sha256 = createHash('sha256').update(actual.targets[1]!.files[0]!.bytes).digest('hex')

        expect(compareRestrictionOutputs(expected, actual)).toEqual({
            kind: 'complete', currentTargets: ['claudecode', 'opencode'], staleTargets: ['codexcli'], sharedGuardCurrent: true,
        })
    })
})
