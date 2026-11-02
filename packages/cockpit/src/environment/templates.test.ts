import {
    chmodSync,
    existsSync,
    linkSync,
    lstatSync,
    mkdtempSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    realpathSync,
    renameSync,
    rmSync,
    statSync,
    symlinkSync,
    utimesSync,
    writeFileSync,
} from 'node:fs'
import { execFileSync, spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { inspect } from 'node:util'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { externalDependencyTemplateFragments, inspectEnvironmentKeys, planEnvironmentSeed, seedEnvironmentInstance, seedEnvironmentInstanceSync } from './templates.js'

const scratch: string[] = []

function workspace(): string {
    const path = mkdtempSync(join(tmpdir(), 'cockpit-environment-template-'))
    scratch.push(path)
    return path
}

function delayedFifoWriter(path: string) {
    return spawn(
        process.execPath,
        [
            '-e',
            "setTimeout(() => { const fs = require('node:fs'); try { fs.closeSync(fs.openSync(process.argv[1], fs.constants.O_WRONLY | fs.constants.O_NONBLOCK)) } catch {} }, 500)",
            path,
        ],
        { stdio: 'ignore' },
    )
}

async function beforeDelayedFifoWriter<T>(path: string, operation: () => Promise<T>): Promise<T> {
    const writer = delayedFifoWriter(path)
    const started = performance.now()
    try {
        const result = await operation()
        expect(performance.now() - started).toBeLessThan(250)
        return result
    } finally {
        writer.kill()
    }
}

afterEach(() => {
    for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('external dependency template fragments', () => {
    it('pins a stubbed dependency through both suppliers and product loader', () => {
        const result = externalDependencyTemplateFragments({
            id: 'mailer',
            posture: 'stubbed',
            reason: 'exercise delivery without external egress',
            endpoints: [{
                variable: 'MAILER_URL',
                sink: 'http://mailer-stub:4010/api',
                runtime_service: 'api',
                supplier: { sibling: 'web', template: '.env.example' },
            }],
            normalize_empty: true,
            placeholder: 'cockpit:absent:mailer',
            nonempty_variables: ['MAILER_TOKEN'],
            shadow_files: [{ sibling: 'web', instance: '.env', probe: { location: 'in-stack', service: 'api', cwd: '.', argv: ['node', 'probe.mjs'], timeout_seconds: 5, provenance: { source: 'overlay.toml', observed_on: '2026-09-26', kind: 'declared', reason: 'product loader' } } }],
        })

        expect(result).toEqual({
            kind: 'complete',
            dependencyId: 'mailer',
            runtime: [{ variable: 'MAILER_URL', value: 'http://mailer-stub:4010/api', service: 'api' }],
            secretsTemplate: [{ variable: 'MAILER_URL', value: 'http://mailer-stub:4010/api', sibling: 'web', template: '.env.example' }],
            nonempty: [{ variable: 'MAILER_TOKEN', value: 'cockpit:absent:mailer' }],
            shadowFiles: [{ sibling: 'web', instance: '.env' }],
            normalizeExportedEmpties: true,
            placeholder: 'cockpit:absent:mailer',
        })
        expect(Object.isFrozen(result)).toBe(true)
        if (result.kind === 'complete') {
            expect(result.runtime[0]).not.toBe(result.secretsTemplate[0])
            expect(Object.isFrozen(result.runtime)).toBe(true)
            expect(Object.isFrozen(result.secretsTemplate)).toBe(true)
        }
    })

    it('refuses missing pins, mismatched suppliers, live endpoints, and duplicate variables', () => {
        const base = {
            id: 'mailer', normalize_empty: true, placeholder: 'cockpit:absent:mailer',
            endpoints: [{ variable: 'MAILER_URL', sink: 'http://mailer-stub:4010', runtime_service: 'api', supplier: { sibling: 'web', template: '.env.example' } }],
        }
        expect(externalDependencyTemplateFragments({ ...base, endpoints: [] })).toMatchObject({ kind: 'refusal' })
        expect(externalDependencyTemplateFragments({ ...base, endpoints: [{ ...base.endpoints[0], sink: 'https://vendor.example.com' }] })).toMatchObject({ kind: 'refusal' })
        expect(externalDependencyTemplateFragments({ ...base, endpoints: [...base.endpoints, base.endpoints[0]] })).toMatchObject({ kind: 'refusal' })
        expect(externalDependencyTemplateFragments({ ...base, nonempty_variables: ['MAILER_URL'] })).toMatchObject({ kind: 'refusal' })
        expect(externalDependencyTemplateFragments({ ...base, endpoints: [{ ...base.endpoints[0], supplier: { sibling: '', template: '.env.example' } }] })).toMatchObject({ kind: 'refusal' })
    })
})

describe('environment template keys', () => {
    it('derives required keys only from the template and reports a fresh instance by key name', async () => {
        const root = workspace()
        const templatePath = join(root, '.env.example')
        const instancePath = join(root, '.env')
        writeFileSync(templatePath, '# public declarations\nAPI_ORIGIN=http://example.invalid\nEMPTY=\n')
        writeFileSync(instancePath, 'EMPTY=private\nAPI_ORIGIN=http://local.invalid\n')

        await expect(inspectEnvironmentKeys({ siblingRoot: root, templatePath, instancePath })).resolves.toEqual({
            kind: 'fresh',
            templatePath,
            instancePath,
            requiredKeys: ['API_ORIGIN', 'EMPTY'],
            presentKeys: ['API_ORIGIN', 'EMPTY'],
            missingKeys: [],
            unexpectedKeys: [],
        })
    })

    it('ignores comments containing equals signs', async () => {
        const root = workspace()
        const templatePath = join(root, '.env.example')
        const instancePath = join(root, '.env')
        writeFileSync(templatePath, '# documentation=https://example.invalid\nKEY=public\n')
        writeFileSync(instancePath, '  # local note=not-an-assignment\nKEY=private\n')

        await expect(inspectEnvironmentKeys({ siblingRoot: root, templatePath, instancePath })).resolves.toMatchObject({
            kind: 'fresh',
            requiredKeys: ['KEY'],
            presentKeys: ['KEY'],
        })
    })

    it('reports stale keys without retaining or rendering any secret values', async () => {
        const root = workspace()
        const templatePath = join(root, '.env.example')
        const instancePath = join(root, '.env')
        const canaries = [
            'credential-canary-9f42',
            'https://private.invalid/path?token=url-canary',
            'registry-token-canary',
            'first-line\\nsecond-line-canary',
        ]
        writeFileSync(templatePath, `REQUIRED=${canaries[0]}\nURL=${canaries[1]}\nMULTILINE="${canaries[3]}"\n`)
        writeFileSync(instancePath, `URL=${canaries[1]}\nEXTRA=${canaries[2]}\nMULTILINE="${canaries[3]}"\n`)
        const before = statSync(instancePath)

        const result = await inspectEnvironmentKeys({ siblingRoot: root, templatePath, instancePath })
        expect(result).toEqual({
            kind: 'stale',
            templatePath,
            instancePath,
            requiredKeys: ['MULTILINE', 'REQUIRED', 'URL'],
            presentKeys: ['EXTRA', 'MULTILINE', 'URL'],
            missingKeys: ['REQUIRED'],
            unexpectedKeys: ['EXTRA'],
        })
        const rendered = [JSON.stringify(result), inspect(result), String(result)].join('\n')
        for (const canary of canaries) expect(rendered).not.toContain(canary)
        expect({ ...result, templatePath: '<template>', instancePath: '<instance>' }).toMatchInlineSnapshot(`
          {
            "instancePath": "<instance>",
            "kind": "stale",
            "missingKeys": [
              "REQUIRED",
            ],
            "presentKeys": [
              "EXTRA",
              "MULTILINE",
              "URL",
            ],
            "requiredKeys": [
              "MULTILINE",
              "REQUIRED",
              "URL",
            ],
            "templatePath": "<template>",
            "unexpectedKeys": [
              "EXTRA",
            ],
          }
        `)
        expect(statSync(instancePath).mtimeMs).toBe(before.mtimeMs)
        expect(readFileSync(instancePath, 'utf8')).toContain(canaries[2])
    })

    it('names an absent instance without inventing its keys or value', async () => {
        const root = workspace()
        const templatePath = join(root, '.env.example')
        const instancePath = join(root, '.env')
        writeFileSync(templatePath, 'FIRST=discard-me\nSECOND=discard-this-too\n')

        await expect(inspectEnvironmentKeys({ siblingRoot: root, templatePath, instancePath })).resolves.toEqual({
            kind: 'absent',
            templatePath,
            instancePath,
            requiredKeys: ['FIRST', 'SECOND'],
            presentKeys: [],
            missingKeys: ['FIRST', 'SECOND'],
            unexpectedKeys: [],
        })
    })

    it('distinguishes unreadable files without embedding their content in the failure', async () => {
        const root = workspace()
        const templatePath = join(root, '.env.example')
        const instancePath = join(root, '.env')
        writeFileSync(templatePath, 'REQUIRED=template-secret-canary\n')
        mkdirSync(instancePath)

        const result = await inspectEnvironmentKeys({ siblingRoot: root, templatePath, instancePath })
        expect(result).toEqual({
            kind: 'unreadable',
            file: 'instance',
            path: instancePath,
            code: 'ENVIRONMENT_FILE_UNREADABLE',
        })
        expect(JSON.stringify(result)).not.toContain('template-secret-canary')
    })

    it('reports malformed template and instance lines using location rather than content', async () => {
        const root = workspace()
        const templatePath = join(root, '.env.example')
        const instancePath = join(root, '.env')
        writeFileSync(templatePath, 'VALID=discard\nnot valid = malformed-value-canary\n')
        writeFileSync(instancePath, 'VALID=instance-value-canary\n')

        const malformedTemplate = await inspectEnvironmentKeys({ siblingRoot: root, templatePath, instancePath })
        expect(malformedTemplate).toEqual({
            kind: 'malformed',
            file: 'template',
            path: templatePath,
            line: 2,
            code: 'ENVIRONMENT_FILE_MALFORMED',
        })
        expect(JSON.stringify(malformedTemplate)).not.toContain('malformed-value-canary')

        writeFileSync(templatePath, 'VALID=discard\n')
        writeFileSync(instancePath, 'VALID=instance-value-canary\nno equals instance-secret-canary\n')
        const malformedInstance = await inspectEnvironmentKeys({ siblingRoot: root, templatePath, instancePath })
        expect(malformedInstance).toEqual({
            kind: 'malformed',
            file: 'instance',
            path: instancePath,
            line: 2,
            code: 'ENVIRONMENT_FILE_MALFORMED',
        })
        expect(JSON.stringify(malformedInstance)).not.toContain('instance-secret-canary')
    })

    it('fails closed when either file exceeds the bounded parser limit', async () => {
        const root = workspace()
        const templatePath = join(root, '.env.example')
        const instancePath = join(root, '.env')
        writeFileSync(templatePath, 'KEY=discarded-value\n')
        writeFileSync(instancePath, 'KEY=secret-value\n')

        await expect(inspectEnvironmentKeys({ siblingRoot: root, templatePath, instancePath, maxBytes: 4 })).resolves.toEqual({
            kind: 'unreadable',
            file: 'template',
            path: templatePath,
            code: 'ENVIRONMENT_FILE_TOO_LARGE',
        })
    })

    it('does not turn read errors into thrown messages containing file bytes', async () => {
        const root = workspace()
        const templatePath = join(root, '.env.example')
        const instancePath = join(root, '.env')
        writeFileSync(templatePath, 'KEY=template-canary\n')
        writeFileSync(instancePath, 'KEY=instance-canary\n')
        chmodSync(templatePath, 0)

        try {
            const result = await inspectEnvironmentKeys({ siblingRoot: root, templatePath, instancePath })
            expect(JSON.stringify(result)).not.toContain('template-canary')
            expect(JSON.stringify(result)).not.toContain('instance-canary')
        } catch (error) {
            expect(String(error)).not.toContain('template-canary')
            expect(String(error)).not.toContain('instance-canary')
            throw error
        } finally {
            chmodSync(templatePath, 0o600)
        }
    })

    it('refuses final and ancestor symlinks before projecting outside key names', async () => {
        const root = workspace()
        const outside = workspace()
        const outsideTemplate = join(outside, '.env.example')
        const instancePath = join(root, '.env')
        writeFileSync(outsideTemplate, 'OUTSIDE_KEY=outside-value-canary\n')
        writeFileSync(instancePath, 'OUTSIDE_KEY=instance-value-canary\n')
        symlinkSync(outsideTemplate, join(root, '.env.example'))

        const finalLink = await inspectEnvironmentKeys({
            siblingRoot: root,
            templatePath: join(root, '.env.example'),
            instancePath,
        })
        expect(finalLink).toMatchObject({ kind: 'unreadable', file: 'template' })
        expect(JSON.stringify(finalLink)).not.toContain('OUTSIDE_KEY')

        rmSync(join(root, '.env.example'))
        symlinkSync(outside, join(root, 'linked'))
        const ancestorLink = await inspectEnvironmentKeys({
            siblingRoot: root,
            templatePath: join(root, 'linked/.env.example'),
            instancePath,
        })
        expect(ancestorLink).toMatchObject({ kind: 'unreadable', file: 'template' })
        expect(JSON.stringify(ancestorLink)).not.toContain('OUTSIDE_KEY')
    })

    it('refuses a template FIFO without waiting for a writer', async () => {
        const root = workspace()
        const templatePath = join(root, '.env.example')
        execFileSync('mkfifo', [templatePath])
        await expect(
            beforeDelayedFifoWriter(templatePath, () =>
                inspectEnvironmentKeys({
                    siblingRoot: root,
                    templatePath,
                    instancePath: join(root, '.env'),
                }),
            ),
        ).resolves.toMatchObject({
            kind: 'unreadable',
            file: 'template',
            code: 'ENVIRONMENT_FILE_UNREADABLE',
        })
    })

    it('accepts opaque non-UTF-8 RHS bytes but rejects invalid key encoding', async () => {
        const root = workspace()
        const templatePath = join(root, '.env.example')
        const instancePath = join(root, '.env')
        writeFileSync(templatePath, Buffer.from([0x4b, 0x45, 0x59, 0x3d, 0xff, 0xfe, 0x0a]))
        writeFileSync(instancePath, Buffer.from([0x4b, 0x45, 0x59, 0x3d, 0x80, 0x0a]))

        await expect(inspectEnvironmentKeys({ siblingRoot: root, templatePath, instancePath })).resolves.toMatchObject({
            kind: 'fresh',
            requiredKeys: ['KEY'],
            presentKeys: ['KEY'],
        })

        writeFileSync(templatePath, Buffer.from([0xff, 0x4b, 0x45, 0x59, 0x3d, 0x76, 0x0a]))
        await expect(inspectEnvironmentKeys({ siblingRoot: root, templatePath, instancePath })).resolves.toMatchObject({
            kind: 'malformed',
            file: 'template',
            line: 1,
        })
    })
})

describe('environment instance seeding', () => {
    it('publishes exact template bytes once with a private mode and confined report', async () => {
        const root = workspace()
        const template = 'config/.env.example'
        const instance = 'private/.env'
        mkdirSync(join(root, 'config'))
        mkdirSync(join(root, 'private'))
        const bytes = Buffer.from('LABEL=Grüße\nFINAL=no-newline', 'utf8')
        writeFileSync(join(root, template), bytes)
        chmodSync(join(root, template), 0o644)

        const plan = await planEnvironmentSeed({
            siblingRoot: root,
            environmentFile: { template, instance },
        })
        expect(plan.kind).toBe('ready')
        const result = await seedEnvironmentInstance(plan)

        expect(result).toEqual({
            kind: 'created',
            siblingRoot: root,
            destination: join(realpathSync(root), instance),
        })
        expect(readFileSync(join(root, instance))).toEqual(bytes)
        expect(statSync(join(root, instance)).mode & 0o777).toBe(0o600)
        expect(JSON.stringify(result)).not.toContain('Grüße')
        expect(JSON.stringify(result)).not.toContain('no-newline')
    })

    it('does nothing for an empty environment declaration', async () => {
        const root = workspace()
        const before = statSync(root).mtimeMs
        const plan = await planEnvironmentSeed({ siblingRoot: root })

        expect(plan).toEqual({ kind: 'none' })
        await expect(seedEnvironmentInstance(plan)).resolves.toEqual({ kind: 'none' })
        expect(statSync(root).mtimeMs).toBe(before)
    })

    it('never overwrites or back-fills an existing stale instance', async () => {
        const root = workspace()
        const template = '.env.example'
        const instance = '.env'
        writeFileSync(join(root, template), 'PRESENT=public\nMISSING=public\n')
        const original = Buffer.from('PRESENT=private-secret\n')
        writeFileSync(join(root, instance), original)

        const plan = await planEnvironmentSeed({
            siblingRoot: root,
            environmentFile: { template, instance },
        })
        expect(plan).toEqual({
            kind: 'unchanged',
            siblingRoot: root,
            destination: join(realpathSync(root), instance),
        })
        await expect(seedEnvironmentInstance(plan)).resolves.toEqual(plan)
        expect(readFileSync(join(root, instance))).toEqual(original)
        await expect(inspectEnvironmentKeys({
            siblingRoot: root,
            templatePath: join(root, template),
            instancePath: join(root, instance),
        })).resolves.toMatchObject({ kind: 'stale', missingKeys: ['MISSING'] })
    })

    it('lets exactly one racing creator publish and never exposes a partial file', async () => {
        const root = workspace()
        const template = '.env.example'
        const instance = '.env'
        const bytes = Buffer.alloc(512 * 1024, 0x61)
        writeFileSync(join(root, template), bytes)
        const plan = await planEnvironmentSeed({
            siblingRoot: root,
            environmentFile: { template, instance },
        })
        expect(plan.kind).toBe('ready')

        const observedLengths: number[] = []
        const observer = setInterval(() => {
            if (existsSync(join(root, instance))) observedLengths.push(statSync(join(root, instance)).size)
        }, 0)
        const results = await Promise.all([seedEnvironmentInstance(plan), seedEnvironmentInstance(plan)])
        clearInterval(observer)
        observedLengths.push(statSync(join(root, instance)).size)

        expect(results.map((result) => result.kind).sort()).toEqual(['created', 'unchanged'])
        expect(readFileSync(join(root, instance))).toEqual(bytes)
        expect(observedLengths.every((length) => length === bytes.length)).toBe(true)
        expect(readdirSync(root).filter((name) => name.includes('.cockpit-seed-'))).toEqual([])
    })

    it('preserves unrelated bytes created by a racer after planning', async () => {
        const root = workspace()
        writeFileSync(join(root, '.env.example'), 'KEY=template\n')
        const plan = await planEnvironmentSeed({
            siblingRoot: root,
            environmentFile: { template: '.env.example', instance: '.env' },
        })
        expect(plan.kind).toBe('ready')
        const raced = Buffer.from('KEY=racer-secret\n')
        writeFileSync(join(root, '.env'), raced)

        await expect(seedEnvironmentInstance(plan)).resolves.toMatchObject({ kind: 'unchanged' })
        expect(readFileSync(join(root, '.env'))).toEqual(raced)
        expect(readdirSync(root).filter((name) => name.includes('.cockpit-seed-'))).toEqual([])
    })

    it.each(['source hard-link', 'symbolic link', 'directory'] as const)(
        'refuses a racing %s at the destination',
        async (racer) => {
            const root = workspace()
            const template = join(root, '.env.example')
            const destination = join(root, '.env')
            writeFileSync(template, 'KEY=template\n')
            const plan = await planEnvironmentSeed({
                siblingRoot: root,
                environmentFile: { template: '.env.example', instance: '.env' },
            })
            expect(plan.kind).toBe('ready')

            if (racer === 'source hard-link') linkSync(template, destination)
            else if (racer === 'symbolic link') symlinkSync(template, destination)
            else mkdirSync(destination)
            const racedIdentity = lstatSync(destination, { bigint: true })

            await expect(seedEnvironmentInstance(plan)).resolves.toMatchObject({
                kind: 'refusal',
                code:
                    racer === 'source hard-link'
                        ? 'ENVIRONMENT_SEED_PRECONDITION_CHANGED'
                        : 'TEMPLATE_PATH_OUTSIDE_ROOT',
            })
            const preservedIdentity = lstatSync(destination, { bigint: true })
            expect([preservedIdentity.dev, preservedIdentity.ino, preservedIdentity.mode]).toEqual([
                racedIdentity.dev,
                racedIdentity.ino,
                racedIdentity.mode,
            ])
            expect(readdirSync(root).filter((name) => name.includes('.cockpit-seed-'))).toEqual([])
        },
    )

    it('refuses a racing destination FIFO without waiting for a writer', async () => {
        const root = workspace()
        const destination = join(root, '.env')
        writeFileSync(join(root, '.env.example'), 'KEY=template\n')
        const plan = await planEnvironmentSeed({
            siblingRoot: root,
            environmentFile: { template: '.env.example', instance: '.env' },
        })
        expect(plan.kind).toBe('ready')
        execFileSync('mkfifo', [destination])
        await expect(
            beforeDelayedFifoWriter(destination, () => seedEnvironmentInstance(plan)),
        ).resolves.toMatchObject({ kind: 'refusal', code: 'TEMPLATE_PATH_OUTSIDE_ROOT' })
    })

    it.each([
        { template: '../outside.example', instance: '.env' },
        { template: '.env.example', instance: '../outside.env' },
        { template: '/absolute.example', instance: '.env' },
        { template: '.env.example', instance: '/absolute.env' },
        { template: '.env.example', instance: '.env.example' },
    ])('refuses traversal, absolute paths, and lexical aliasing: %o', async (environmentFile) => {
        const root = workspace()
        writeFileSync(join(root, '.env.example'), 'KEY=value\n')
        const result = await planEnvironmentSeed({ siblingRoot: root, environmentFile })
        expect(result).toMatchObject({ kind: 'refusal', code: 'TEMPLATE_PATH_OUTSIDE_ROOT' })
        expect(existsSync(join(root, '.env'))).toBe(false)
    })

    it('refuses symlink components and a hard-link alias before writing', async () => {
        const root = workspace()
        const outside = workspace()
        writeFileSync(join(outside, '.env.example'), 'KEY=outside\n')
        symlinkSync(outside, join(root, 'linked'))

        await expect(planEnvironmentSeed({
            siblingRoot: root,
            environmentFile: { template: 'linked/.env.example', instance: '.env' },
        })).resolves.toMatchObject({ kind: 'refusal', code: 'TEMPLATE_PATH_OUTSIDE_ROOT' })

        rmSync(join(root, 'linked'))
        writeFileSync(join(root, '.env.example'), 'KEY=value\n')
        linkSync(join(root, '.env.example'), join(root, '.env'))
        await expect(planEnvironmentSeed({
            siblingRoot: root,
            environmentFile: { template: '.env.example', instance: '.env' },
        })).resolves.toMatchObject({ kind: 'refusal', code: 'TEMPLATE_PATH_OUTSIDE_ROOT' })

        rmSync(join(root, '.env'))
        symlinkSync(join(outside, '.env.example'), join(root, '.env'))
        await expect(planEnvironmentSeed({
            siblingRoot: root,
            environmentFile: { template: '.env.example', instance: '.env' },
        })).resolves.toMatchObject({ kind: 'refusal', code: 'TEMPLATE_PATH_OUTSIDE_ROOT' })
    })

    it('revalidates the resolved plan and refuses a parent swapped for a symlink', async () => {
        const root = workspace()
        const outside = workspace()
        mkdirSync(join(root, 'config'))
        mkdirSync(join(root, 'private'))
        writeFileSync(join(root, 'config/.env.example'), 'KEY=value\n')
        const plan = await planEnvironmentSeed({
            siblingRoot: root,
            environmentFile: { template: 'config/.env.example', instance: 'private/.env' },
        })
        expect(plan.kind).toBe('ready')
        rmSync(join(root, 'private'), { recursive: true })
        symlinkSync(outside, join(root, 'private'))

        await expect(seedEnvironmentInstance(plan)).resolves.toMatchObject({
            kind: 'refusal',
            code: 'TEMPLATE_PATH_OUTSIDE_ROOT',
        })
        expect(existsSync(join(outside, '.env'))).toBe(false)
    })

    it('pins the destination directory before a parent-name swap can redirect publication or cleanup', async () => {
        const root = workspace()
        const outside = workspace()
        const parent = join(root, 'private')
        const movedParent = join(root, 'private-moved')
        mkdirSync(parent)
        writeFileSync(join(root, '.env.example'), 'KEY=value\n')
        writeFileSync(join(outside, '.env'), 'KEY=unrelated\n')
        const plan = await planEnvironmentSeed({
            siblingRoot: root,
            environmentFile: { template: '.env.example', instance: 'private/.env' },
        })
        expect(plan.kind).toBe('ready')

        const changeDirectory = process.chdir.bind(process)
        let swapped = false
        const chdir = vi.spyOn(process, 'chdir').mockImplementation((path) => {
            changeDirectory(path)
            if (!swapped && realpathSync('.') === realpathSync(parent)) {
                renameSync(parent, movedParent)
                symlinkSync(outside, parent)
                swapped = true
            }
        })
        try {
            await expect(seedEnvironmentInstance(plan)).resolves.toMatchObject({
                kind: 'refusal',
                code: 'TEMPLATE_PATH_OUTSIDE_ROOT',
            })
        } finally {
            chdir.mockRestore()
        }

        expect(swapped).toBe(true)
        expect(existsSync(join(movedParent, '.env'))).toBe(false)
        expect(readFileSync(join(outside, '.env'), 'utf8')).toBe('KEY=unrelated\n')
    })

    it('refuses a source ancestor swapped to an outside hard-link alias after planning', async () => {
        const root = workspace()
        const outside = workspace()
        mkdirSync(join(root, 'config'))
        writeFileSync(join(root, 'config/.env.example'), 'KEY=value\n')
        linkSync(join(root, 'config/.env.example'), join(outside, '.env.example'))
        const plan = await planEnvironmentSeed({
            siblingRoot: root,
            environmentFile: { template: 'config/.env.example', instance: '.env' },
        })
        expect(plan.kind).toBe('ready')
        rmSync(join(root, 'config'), { recursive: true })
        symlinkSync(outside, join(root, 'config'))

        await expect(seedEnvironmentInstance(plan)).resolves.toMatchObject({
            kind: 'refusal',
            code: 'TEMPLATE_PATH_OUTSIDE_ROOT',
        })
        expect(existsSync(join(root, '.env'))).toBe(false)
    })

    it('refuses a racing source FIFO without waiting for a writer', async () => {
        const root = workspace()
        const template = join(root, '.env.example')
        writeFileSync(template, 'KEY=template\n')
        const plan = await planEnvironmentSeed({
            siblingRoot: root,
            environmentFile: { template: '.env.example', instance: '.env' },
        })
        expect(plan.kind).toBe('ready')

        const changeDirectory = process.chdir.bind(process)
        let swapped = false
        const chdir = vi.spyOn(process, 'chdir').mockImplementation((path) => {
            changeDirectory(path)
            if (!swapped && realpathSync('.') === realpathSync(root)) {
                rmSync(template)
                execFileSync('mkfifo', [template])
                swapped = true
            }
        })
        try {
            await expect(
                beforeDelayedFifoWriter(template, () => seedEnvironmentInstance(plan)),
            ).resolves.toMatchObject({ kind: 'refusal', code: 'ENVIRONMENT_SEED_PRECONDITION_CHANGED' })
        } finally {
            chdir.mockRestore()
        }
        expect(swapped).toBe(true)
        expect(existsSync(join(root, '.env'))).toBe(false)
    })

    it('refuses a template replaced after planning without publishing bytes', async () => {
        const root = workspace()
        writeFileSync(join(root, '.env.example'), 'KEY=first\n')
        const plan = await planEnvironmentSeed({
            siblingRoot: root,
            environmentFile: { template: '.env.example', instance: '.env' },
        })
        expect(plan.kind).toBe('ready')
        rmSync(join(root, '.env.example'))
        writeFileSync(join(root, '.env.example'), 'KEY=second\n')

        await expect(seedEnvironmentInstance(plan)).resolves.toMatchObject({
            kind: 'refusal',
            code: 'ENVIRONMENT_SEED_PRECONDITION_CHANGED',
        })
        expect(existsSync(join(root, '.env'))).toBe(false)
    })

    it('refuses a same-size in-place template rewrite even when its modification time is restored', async () => {
        const root = workspace()
        const template = join(root, '.env.example')
        const fixedTime = 1_700_000_000
        writeFileSync(template, 'KEY=alpha\n')
        utimesSync(template, fixedTime, fixedTime)
        const plan = await planEnvironmentSeed({
            siblingRoot: root,
            environmentFile: { template: '.env.example', instance: '.env' },
        })
        expect(plan.kind).toBe('ready')

        writeFileSync(template, 'KEY=omega\n')
        utimesSync(template, fixedTime, fixedTime)

        await expect(seedEnvironmentInstance(plan)).resolves.toMatchObject({
            kind: 'refusal',
            code: 'ENVIRONMENT_SEED_PRECONDITION_CHANGED',
        })
        expect(existsSync(join(root, '.env'))).toBe(false)
    })

    it('synchronously revalidates every planned identity immediately before copying', async () => {
        const root = workspace()
        const template = join(root, '.env.example')
        writeFileSync(template, 'KEY=alpha\n')
        const plan = await planEnvironmentSeed({
            siblingRoot: root,
            environmentFile: { template: '.env.example', instance: '.env' },
        })
        expect(plan.kind).toBe('ready')
        writeFileSync(template, 'KEY=omega\n')

        const result = seedEnvironmentInstanceSync(plan)

        expect(result).toMatchObject({
            kind: 'refusal',
            code: 'ENVIRONMENT_SEED_PRECONDITION_CHANGED',
        })
        expect(result).not.toHaveProperty('then')
        expect(existsSync(join(root, '.env'))).toBe(false)
    })

})
