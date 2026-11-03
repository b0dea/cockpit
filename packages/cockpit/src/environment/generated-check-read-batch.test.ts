import { cp, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { executeProbe, type ExecuteProbeOutcome } from '../environment-exec/execute.js'
import type { ExecutionStep } from './contract.js'
import { checkGeneratedEnvironment, syncGeneratedEnvironment } from './generated-application.js'

const hooks = vi.hoisted(() => ({
    before: undefined as ((step: ExecutionStep) => Promise<void>) | undefined,
    after: undefined as ((step: ExecutionStep, outcome: ExecuteProbeOutcome) => Promise<void>) | undefined,
}))

vi.mock('../environment-exec/execute.js', async importOriginal => {
    const actual = await importOriginal<typeof import('../environment-exec/execute.js')>()
    return {
        ...actual,
        executeProbe: async (step: ExecutionStep) => {
            await hooks.before?.(step)
            const outcome = await actual.executeProbe(step)
            await hooks.after?.(step, outcome)
            return outcome
        },
    }
})

const roots: string[] = []
const generatedPaths = ['compose.cockpit.yml']

interface ReadRequest {
    readonly nonce: string
    readonly action: string
    readonly segments: readonly string[]
    readonly name: string
    readonly maxBytes: number
    readonly output: string
}

interface BatchRequest {
    readonly nonce: string
    readonly entries: readonly ReadRequest[]
    readonly receiptOutput: string
}

function target(row: ReadRequest): string {
    return [...row.segments, row.name].join('/')
}

function reads(step: ExecutionStep): readonly ReadRequest[] {
    if (step.labels.action === 'read-batch') return (JSON.parse(step.argv[3]!) as BatchRequest).entries
    if (step.labels.action === 'read-file') {
        return [JSON.parse(step.argv[3]!) as ReadRequest]
    }
    return []
}

afterEach(async () => {
    hooks.before = undefined
    hooks.after = undefined
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function composeConsumer() {
    const base = await realpath(await mkdtemp(join(tmpdir(), 'cockpit-check-compose-')))
    roots.push(base)
    const root = join(base, 'compose-first')
    await cp(resolve('examples/compose-first'), root, { recursive: true })
    const configPath = join(root, 'cockpit.toml')
    const synced = await syncGeneratedEnvironment({ configPath })
    expect(synced, JSON.stringify(synced)).toMatchObject({ kind: 'complete' })
    return { root, configPath }
}

describe('generated check authenticated read batching', () => {
    // A missing owned file cannot be read at all; a hand edit and unreadable bytes are drift that sync repairs.
    it.each([['missing', 'GENERATED_ARTIFACT_MISSING'], ['hand-edited', 'GENERATED_ARTIFACT_DRIFT'],
        ['invalid UTF8', 'GENERATED_ARTIFACT_DRIFT']] as const)('names a %s owned generated target', async (kind, code) => {
        const { root, configPath } = await composeConsumer()
        let changed = false
        hooks.before = async step => {
            if (changed || step.cwd !== root || !reads(step).some(row => generatedPaths.includes(target(row)))) return
            changed = true
            const first = join(root, 'compose.cockpit.yml')
            if (kind === 'missing') await rm(first)
            else if (kind === 'hand-edited') await writeFile(first, `${await readFile(first, 'utf8')}# edited by hand\n`)
            else await writeFile(first, Buffer.from([0xc3, 0x28]))
        }

        const checked = await checkGeneratedEnvironment({ configPath })
        expect(changed).toBe(true)
        expect(checked).toMatchObject({ kind: 'refusal', diagnostics: [expect.objectContaining({
            code, target: 'compose.cockpit.yml',
        })] })
    })
})
