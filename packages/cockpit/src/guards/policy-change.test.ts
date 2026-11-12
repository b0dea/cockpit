import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import type { z } from 'zod'

import { stringify } from 'smol-toml'

import { CockpitConfig } from '../schema.js'
import { sha256Hex } from '../sha256.js'
import { ANSWER_CONFIRMATION_PATH, confirmationConfigurationSha256, encodeAnswerConfirmations } from './answer-confirmation.js'
import { encodeGuardLocalIdentity, GUARD_LOCAL_PATHS } from './local-identity.js'
import { guardConfigChange, inspectGuardConfigChange, POLICY_CHANGE_RULE_PATHS, policyChange } from './policy-change.js'

// A declaration as cockpit.toml spells it, edited freely and parsed again by each case.
type Declared = Record<string, any>

const declared: Declared = {
    unconfirmed: ['guards'],
    cockpit: { name: 'my-app' },
    sibling: [
        { slug: 'web', dir: 'web', remote: 'https://git.example.test/web.git', mount: 'always', acquire: 'auto', var: 'WEB_DIR',
            toolchain: 'node', purpose: 'the web application', environment_files: [{ template: '.env.example', instance: '.env' }] },
        { slug: 'api', dir: 'api', mount: 'none', acquire: 'none', var: 'API_DIR', purpose: 'the API', gate: 'operator' },
    ],
    ports: { bases: { WEB_PORT: 3000 } },
    guards: {
        default: 'ask',
        hosted_db_hosts: ['db.example.test'], vendor_endpoint_hosts: ['api.vendor.example.test'],
        allow: [{ argv: ['make', 'verify'], reason: 'Verification is safe.' }],
        deny: [{ prefix: ['make', 'deploy'], reason: 'Deploys are a person\'s.' }],
        secret_paths: ['var/sessions'], related_checkouts: ['../upstream'], unresolved: 'deny',
    },
    mcp: { approved: { docs: 'a'.repeat(64) } },
    work: { attempt_cap: 1, gates: { accept: 'person' } },
    testing: {
        stages: [{ id: 'unit', command: ['npm', 'test'], requires_stack: false }],
        gates: [{ id: 'quick', tier: 'targeted', stages: ['unit'], changes: 'any change' }],
    },
    environment: {
        compose_files: ['compose.yml'], resettable_volumes: ['db-data'], profiles: ['jobs'],
        install_policies: [{ toolchain: 'node', lockfile: 'package-lock.json', test: ['npm', 'test'] }],
    },
    surfaces: { tools: ['claudecode', 'codexcli'] },
    docs: { living: ['README.md'], decisions: 'docs/adr' },
}
const before = CockpitConfig.parse(declared)
const changed = (edit: (config: Declared) => void) => {
    const after = structuredClone(declared)
    edit(after)
    return policyChange(before, CockpitConfig.parse(after))
}
const newSibling = { slug: 'docs', dir: 'docs', remote: 'https://git.example.test/docs.git', mount: 'none', acquire: 'manual', var: 'DOCS_DIR', purpose: 'the docs' }

describe('policyChange', () => {
    it.each<[string, (config: Declared) => void, readonly string[]]>([
        ['a new allow rule', config => config.guards.allow.push({ argv: ['make', 'release'], reason: 'Releases are routine.' }), ['guards.allow']],
        ['a removed hosted database host', config => { config.guards.hosted_db_hosts = [] }, ['guards.hosted_db_hosts']],
        ['a removed vendor host', config => { config.guards.vendor_endpoint_hosts = [] }, ['guards.vendor_endpoint_hosts']],
        ['a removed protected branch', config => { config.guards.protected_branches = ['main'] }, ['guards.protected_branches']],
        ['a removed deny rule', config => { config.guards.deny = [] }, ['guards.deny']],
        ['a new read path', config => { config.guards.read_paths = [{ path: '~/Downloads', reason: 'Inputs a person drops in.' }] }, ['guards.read_paths']],
        ['external reads handed to the agent tools', config => { config.guards.external_reads = 'native' }, ['guards.external_reads']],
        ['a removed secret path', config => { config.guards.secret_paths = [] }, ['guards.secret_paths']],
        ['a new related checkout', config => config.guards.related_checkouts.push('~/src/tool'), ['guards.related_checkouts']],
        ['unresolved commands asking again', config => { config.guards.unresolved = 'ask' }, ['guards.unresolved']],
        ['a new write path', config => { config.guards.write_paths = [{ path: '~/Downloads', reason: 'Inputs a person drops in.' }] }, ['guards.write_paths']],
        ['strict mode turned into the allow default', config => { config.guards.default = 'allow' }, ['guards.default']],
        ['an autonomy decision moved toward agent', config => { config.autonomy = { reset: 'agent' } }, ['autonomy.reset']],
        ['a work gate moved toward agent', config => { config.work.gates.accept = 'agent' }, ['work.gates.accept']],
        ['weaker grading', config => { config.work.grading = 'self' }, ['work.grading']],
        ['relayed grading', config => { config.work.grading = 'subagent' }, ['work.grading']],
        ['no grading', config => { config.work.grading = 'off' }, ['work.grading']],
        ['a raised attempt cap', config => { config.work.attempt_cap = 2 }, ['work.attempt_cap']],
        ['a new MCP approval and a changed digest', config => { config.mcp.approved = { docs: 'b'.repeat(64), search: 'c'.repeat(64) } },
            ['mcp.approved.docs', 'mcp.approved.search']],
        ['an install policy that admits a build', config => { config.environment.install_policies[0].build = ['npm', 'run', 'build'] },
            ['environment.install_policies.node:package-lock.json.build']],
        ['a new Compose file', config => config.environment.compose_files.push('extra.yml'), ['environment.compose_files']],
        ['a new Compose profile', config => config.environment.profiles.push('mail'), ['environment.profiles']],
        ['moved decision records', config => { config.docs.decisions = 'src' }, ['docs.decisions']],
        ['a new resettable volume', config => config.environment.resettable_volumes.push('cache'), ['environment.resettable_volumes']],
        ['a removed declared instance', config => { delete config.sibling[0].environment_files }, ['sibling.web.environment_files']],
        ['a removed sibling', config => { config.sibling.pop() }, ['sibling.api']],
        ['a moved sibling directory', config => { config.sibling[1].dir = 'service' }, ['sibling.api.dir']],
        ['a removed operator gate', config => { delete config.sibling[1].gate }, ['sibling.api.gate']],
        // Every new sibling is a new root the agent may write, inside the siblings root or not.
        ['a new sibling inside the siblings root', config => config.sibling.push(newSibling), ['sibling.docs']],
        ['a new sibling at the siblings root', config => config.sibling.push({ ...newSibling, dir: '.' }), ['sibling.docs']],
        // Sync copies every guide into the root AGENTS.md, so a guide is a read of the sibling into every agent's context.
        ['a new guide', config => { config.sibling[0].guides = ['AGENTS.md', 'notes/setup.md'] }, ['sibling.web.guides']],
        ['a moved siblings root', config => { config.cockpit.siblings_root = '../..' }, ['cockpit.siblings_root']],
        ['a removed guarded tool', config => { config.surfaces.tools = ['claudecode'] }, ['surfaces.tools']],
        ['a changed test stage', config => { config.testing.stages[0].command = ['npm', 'run', 'anything'] }, ['testing.stages']],
        // test-run runs a declared stage unprompted, so a new one is a new command.
        ['an added test stage and gate', config => {
            config.testing.stages.push({ id: 'e2e', command: ['npx', 'playwright', 'test'], requires_stack: true })
            config.testing.gates.push({ id: 'full', tier: 'full', stages: ['unit', 'e2e'], changes: 'a release' })
        }, ['testing.stages', 'testing.gates']],
        ['a decision moved toward a person', config => { config.autonomy = { sync: 'person' }; config.work.gates.amend = 'ci' }, ['work.gates.amend', 'autonomy.sync']],
        ['a removed unconfirmed answer', config => { delete config.unconfirmed }, ['unconfirmed']],
        ['a seed command, which no rule covers', config => { config.environment.seed = { argv: ['make', 'seed'], timeout_seconds: 60 } }, ['environment.seed']],
    ])('widens on %s', (_name, edit, fields) => {
        expect(changed(edit)).toEqual({ kind: 'widening', fields })
    })

    it.each<[string, (config: Declared) => void]>([
        ['an unchanged configuration', () => {}],
        ['an added secret path and a removed related checkout', config => {
            config.guards.secret_paths.push('web:var/sessions')
            config.guards.related_checkouts = []
        }],
        ['an added deny rule, a removed allow rule and added hosts', config => {
            config.guards.deny.push({ contains: ['--force'], reason: 'Forced writes are a person\'s.' })
            config.guards.allow = []
            config.guards.hosted_db_hosts.push('*.warehouse.example.test')
            config.guards.vendor_endpoint_hosts.push('second.vendor.example.test')
            config.guards.protected_branches = ['main', 'master', 'release']
        }],
        ['a removed MCP approval', config => { config.mcp.approved = {} }],
        ['a reworded purpose', config => { config.sibling[0].purpose = 'the storefront' }],
        ['a new derived route', config => { config.environment.entrypoint_derivatives = [{ name: 'app', kind: 'origin', port: 'WEB_PORT', path: '/' }] }],
        ['a moved port base and a raised machine floor', config => {
            config.ports.bases.WEB_PORT = 4000
            config.environment.machine = { runtime_memory_mb: 4096, runtime_cpus: 2, free_disk_mb: 10_000, cold_start_seconds: 600 }
        }],
        ['an added operator gate', config => { config.sibling[0].gate = 'operator' }],
        ['new living documents, rebuild inputs and a removed profile', config => {
            config.docs.living.push('docs/**/*.md')
            config.sibling[0].rebuild_inputs = ['migrations']
            config.environment.profiles = []
        }],
        ['an added tool and unconfirmed answer', config => { config.surfaces.tools.push('opencode'); config.unconfirmed.push('testing') }],
    ])('does not widen on %s', (_name, edit) => {
        expect(changed(edit)).toEqual({ kind: 'non-widening' })
    })

    it('narrows when external reads return to grants, unresolved commands are refused and a read path and a write path are removed', () => {
        const wide = structuredClone(declared)
        wide.guards.external_reads = 'native'
        wide.guards.write_paths = [{ path: '~/Downloads', reason: 'Inputs a person drops in.' }]
        wide.guards.unresolved = 'ask'
        wide.guards.read_paths = [{ path: '~/Downloads', reason: 'Inputs a person drops in.' }]
        expect(policyChange(CockpitConfig.parse(wide), before)).toEqual({ kind: 'non-widening' })
    })

    it('ignores MCP approvals only while both configurations delegate them to the agent', () => {
        const declaring = (...edits: readonly ((config: Declared) => void)[]) => {
            const config = structuredClone(declared)
            for (const edit of edits) edit(config)
            return CockpitConfig.parse(config)
        }
        const delegate = (config: Declared) => { config.autonomy = { mcp_approve: 'agent' } }
        const approve = (config: Declared) => { config.mcp.approved = { docs: 'b'.repeat(64), search: 'c'.repeat(64) } }
        const approvals = ['mcp.approved.docs', 'mcp.approved.search']
        expect(policyChange(declaring(delegate), declaring(delegate, approve))).toEqual({ kind: 'non-widening' })
        // Delegating or taking back approval is itself pinned, and neither side vouches for the other's approvals.
        expect(policyChange(declaring(), declaring(delegate, approve))).toEqual({ kind: 'widening', fields: expect.arrayContaining(['autonomy.mcp_approve', ...approvals]) })
        expect(policyChange(declaring(delegate), declaring(approve))).toEqual({ kind: 'widening', fields: expect.arrayContaining(['autonomy.mcp_approve', ...approvals]) })
        expect(policyChange(declaring(), declaring(approve))).toEqual({ kind: 'widening', fields: approvals })
        // Delegating which servers run does not delegate what their tools may do.
        const restrict = (config: Declared) => { config.mcp.allowed_tools = { docs: ['read_record'] } }
        expect(policyChange(declaring(delegate, restrict), declaring(delegate))).toEqual({ kind: 'widening', fields: ['mcp.allowed_tools.docs'] })
    })

    it('treats a field it has no rule for as widening', () => {
        const after = { ...before, cockpit: { ...before.cockpit, future: { enabled: true } } } as unknown as CockpitConfig
        expect(policyChange(before, after)).toEqual({ kind: 'widening', fields: ['cockpit.future'] })
    })

    it('names only schema fields in its rules, none hidden under another rule', () => {
        // Descends through wrappers to the field a dotted path names; `[]` steps into an array's rows.
        const field = (schema: z.ZodType, path: readonly string[]): z.ZodType | undefined => {
            const def = (schema as unknown as { _zod: { def: Record<string, any> } })._zod.def
            if (def.innerType) return field(def.innerType, path)
            if (def.type === 'pipe') return field(def.in, path)
            if (!path.length) return schema
            const [step, ...rest] = path
            if (def.type === 'array') return step === '[]' ? field(def.element, rest) : undefined
            if (def.type === 'object') return Object.hasOwn(def.shape, step!) ? field(def.shape[step!], rest) : undefined
            if (def.type === 'union') return def.options.map((option: z.ZodType) => field(option, path)).find(Boolean)
            return undefined
        }
        const steps = (path: string) => path.replace('[]', '.[]').split('.')
        expect(POLICY_CHANGE_RULE_PATHS.filter(path => !field(CockpitConfig, steps(path)))).toEqual([])
        // The walk stops at the first rule on a path, so a rule beneath another is never consulted.
        const root = POLICY_CHANGE_RULE_PATHS.filter(path => !path.startsWith('sibling[].'))
        expect(root.filter(path => root.some(other => path.startsWith(`${other}.`)))).toEqual([])
    })
})

describe('guardConfigChange', () => {
    // The guards were generated with two answers unconfirmed; the agent's edit removes ports.bases.
    const generated = Buffer.from(stringify({ ...declared, unconfirmed: ['ports.bases', 'guards'] }))
    const edited = (edit: (config: Declared) => void = () => {}) => {
        const after = structuredClone({ ...declared, unconfirmed: ['guards'] })
        edit(after)
        return CockpitConfig.parse(after)
    }
    const record = (answer: string, row: Record<string, unknown> = {}, observed: CockpitConfig = edited()) => Buffer.from(encodeAnswerConfirmations({
        [answer]: { observation: 'preflight', ranAt: '2026-11-04T10:00:00.000Z', result: 'passed', evidenceSha256: 'a'.repeat(64),
            configurationSha256: confirmationConfigurationSha256(observed), ...row } } as never))
    const change = (confirmations: Uint8Array | undefined, after = edited()) =>
        guardConfigChange(sha256Hex(generated), generated, { sha256: 'f'.repeat(64), config: after }, confirmations)
    const widening = { kind: 'widening', fields: ['unconfirmed'] }

    it('admits removing an unconfirmed answer only with a passed observation recorded for it against exactly the new configuration', () => {
        expect(change(record('ports.bases'))).toEqual({ kind: 'non-widening' })
        // Missing, unreadable, or recorded for another answer.
        expect(change(undefined)).toEqual(widening)
        expect(change(Buffer.from('{"format":'))).toEqual(widening)
        expect(change(record('environment.machine', { observation: 'runtime-floor' }))).toEqual(widening)
        // Stale: observed before another edit, which the removal then rides along with.
        expect(change(record('ports.bases', {}, edited(config => { config.ports.bases.WEB_PORT = 4000 })))).toEqual(widening)
        // Forged: not the observation that verifies the answer, or not a pass.
        expect(change(record('ports.bases', { observation: 'check' }))).toEqual(widening)
        expect(change(record('ports.bases', { result: 'failed' }))).toEqual(widening)
        // A trust decision stays a person's whatever the record claims.
        const trusted = edited(config => { config.unconfirmed = ['ports.bases'] })
        expect(change(record('guards', {}, trusted), trusted)).toEqual(widening)
    })

    it('lets check read the record, so a confirmed removal waits only for a sync', async () => {
        const root = mkdtempSync(join(tmpdir(), 'cockpit-policy-change-'))
        try {
            mkdirSync(join(root, GUARD_LOCAL_PATHS.directory), { recursive: true })
            const identity = Object.fromEntries(['root', 'rootInode', 'configPath', 'configInode', 'node', 'nodeSha256',
                'nodeFingerprint', 'module', 'moduleSha256'].map(key => [key, 'synthetic']))
            writeFileSync(join(root, GUARD_LOCAL_PATHS.identity), encodeGuardLocalIdentity({ ...identity, configSha256: sha256Hex(generated) } as never))
            writeFileSync(join(root, GUARD_LOCAL_PATHS.generatedConfig), generated)
            const reports = async () => inspectGuardConfigChange(root, join(root, 'cockpit.toml'), { sha256: 'f'.repeat(64), config: edited() })
            // Neither edit holds calls: a widening one is judged under the configuration last synced, any other under itself.
            expect(await reports()).toEqual([expect.objectContaining({ code: 'GUARD_CONFIG_WIDENED',
                message: expect.stringMatching(/the guard judges agent calls under the configuration last synced, and refuses an agent's sync or upgrade, until a person syncs$/) })])
            writeFileSync(join(root, ANSWER_CONFIRMATION_PATH), record('ports.bases'))
            expect(await reports()).toEqual([expect.objectContaining({ code: 'GUARD_CONFIG_UNSYNCED',
                message: expect.stringMatching(/the guard judges agent calls under it, while the generated files still follow the configuration last synced until it is synced$/),
                fix: expect.stringContaining(GUARD_LOCAL_PATHS.generatedConfig) })])
        } finally { rmSync(root, { recursive: true, force: true }) }
    })
})
