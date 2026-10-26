import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { prepareSelectedBootstrapSurface, resumeSelectedBootstrapSurface, applySelectedBootstrapSurface, syncGeneratedEnvironment, checkGeneratedEnvironment } from '../generated-environment/command.js'
import { loadCockpitConfig } from '../config/load.js'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parse as parseToml } from 'smol-toml'
import { runInitApplication, type InitApplicationAdapters, type InitApplicationInput } from './init-application.js'
import type { SurfaceTarget } from '../surfaces/contract.js'
import { classifyEstateObservation, documentObservedCommand, observePublicEstate, type DocumentCommandInput, type DocumentOutcome, type EstateClassificationOutcome, type EstateClassificationResult } from '../document/command.js'
import { selectBootstrapStateRoot } from './state.js'

const scratch: string[] = []
const digest = (character: string) => character.repeat(64)

function fixture() {
    const directory = mkdtempSync(join(tmpdir(), 'cockpit-init-application-'))
    scratch.push(directory)
    const requestedRoot = join(directory, 'checkout')
    const home = join(directory, 'home')
    mkdirSync(requestedRoot, { mode: 0o700 })
    mkdirSync(home, { mode: 0o700 })
    const root = realpathSync(requestedRoot)
    const destination = join(root, 'cockpit.toml')
    const calls: string[] = []
    let destinationState: { kind: 'absent' } | { kind: 'available'; sha256: string } = { kind: 'absent' }
    let canonicalOwnership = false
    let previewSha256 = digest('3')
    const preview = Object.freeze({
        kind: 'complete' as const,
        status: 0 as const,
        diagnostics: Object.freeze([]),
        result: Object.freeze({
            root,
            target: 'codexcli' as SurfaceTarget,
            sources: Object.freeze([{ path: 'skills/bootstrap.skill.md', sha256: digest('1') }]),
            files: Object.freeze([{ path: '.agents/skills/bootstrap/SKILL.md', sha256: digest('2') }]),
            previewSha256,
        }),
        authority: Object.freeze({ kind: 'selected-bootstrap-publication-authority' as const }),
    })
    let prepared = preview
    const adapters: InitApplicationAdapters = {
        now: () => '2026-10-25T00:00:00.000Z',
        prepareBootstrap: async ({ target }) => {
            calls.push('prepare')
            prepared = Object.freeze({ ...preview, result: Object.freeze({ ...preview.result, target, previewSha256 }) })
            return prepared
        },
        resumeBootstrap: async () => {
            calls.push('resume')
            return canonicalOwnership
                ? Object.freeze({ kind: 'complete' as const, status: 0 as const, diagnostics: Object.freeze([]),
                    result: prepared.result, canonicalOwnership: true as const })
                : Object.freeze({ kind: 'pending' as const, status: 0 as const, diagnostics: Object.freeze([]),
                    result: null, canonicalOwnership: false as const })
        },
        applyBootstrap: async () => {
            calls.push('apply')
            return prepared
        },
        document: async () => {
            calls.push('document')
            return { kind: 'complete', status: 0, diagnostics: [], result: { document: 'name = "synthetic"\n' },
                artifact: 'name = "synthetic"\n', destination }
        },
        observeDestination: async () => { calls.push('observe'); return destinationState },
        validateConfig: async () => { calls.push('validate'); return { kind: 'complete', status: 0, diagnostics: [], result: {} } },
        synchronize: async () => { calls.push('sync'); canonicalOwnership = true; return { kind: 'complete', status: 0, diagnostics: [], result: {} } },
        check: async () => { calls.push('check'); return { kind: 'complete', status: 0, diagnostics: [], result: {} } },
        preflight: async () => { calls.push('preflight'); return { kind: 'complete', status: 0, diagnostics: [], result: { verdict: 'pass' } } },
    }
    const input: InitApplicationInput = {
        root: resolve(root), target: 'codexcli', registry: join(root, 'env/registry.sh'), accepted: false,
        sessionId: 'synthetic-session', platform: 'linux', home, xdgStateHome: join(home, 'state'),
    }
    return {
        root, destination, calls, adapters, input,
        setDestination: (value: typeof destinationState) => { destinationState = value },
        setPreviewSha256: (value: string) => { previewSha256 = value },
    }
}

function estate(root: string, classification: 'one-sibling' | 'incomplete-multi-repository' | 'no-runnable-product'): EstateClassificationOutcome {
    const multi = classification === 'incomplete-multi-repository'
    const noRunnable = classification === 'no-runnable-product'
    return { kind: 'complete', status: 0, diagnostics: [], result: {
        sourceObservationSha256: createHash('sha256').update(`estate:${classification}:${root}`).digest('hex'),
        classification,
        applicability: { stack: true, seed: true, postures: true, registry: multi, projection: multi, drift: multi,
            compose: noRunnable ? 'inapplicable' : multi ? 'unknown' : 'applicable' },
        notice: `${classification} at ${root}`,
        gaps: multi ? [{ field: 'api.runnable', source: 'api/package.json', why: 'runnable command is unknown' }]
            : noRunnable ? [{ field: 'runnable-product', source: 'assets/package.json', why: 'no runnable product exists' }] : [],
        runnable: multi ? [{ slug: 'web', path: 'web', disposition: 'confirmed' },
            { slug: 'api', path: 'api', disposition: 'unknown' }]
            : noRunnable ? [{ slug: 'assets', path: 'assets', disposition: 'absent' }]
                : [{ slug: 'app', path: 'app', disposition: 'confirmed' }],
    } as EstateClassificationResult & { readonly sourceObservationSha256: string } }
}

function interviewDocument(destination: string, fields: readonly string[] = ['sibling']): (input: DocumentCommandInput) => Promise<DocumentOutcome> {
    return async input => {
        if (input.configuration?.answers.some(answer => answer.bytes.includes('api_key'))) return {
            kind: 'refusal', status: 2, diagnostics: [{ severity: 'error', code: 'DOCUMENT_CONFIGURATION_ANSWER_INVALID',
                message: 'operator answers cannot contain sensitive fields' }],
            result: null, artifact: null, destination: null,
        }
        if (input.configuration?.classification === 'no-runnable-product') return {
            kind: 'refusal', status: 2, diagnostics: [{ severity: 'error', code: 'DOCUMENT_NO_RUNNABLE_PRODUCT',
                message: 'build enough product to run before scaffolding a cockpit configuration' }],
            result: null, artifact: null, destination: null,
        }
        const index = input.configuration?.answers.length ?? 0
        if (index < fields.length) {
            const id = `question:${createHash('sha256').update(`${input.configuration?.sourceObservationSha256}:${index}`).digest('hex')}` as const
            return { kind: 'gap-draft', status: 2, diagnostics: [], result: null, artifact: '# incomplete\n', destination,
                question: { id, field: fields[index] as 'sibling', source: 'api/package.json',
                    why: 'runnable command is unknown' } }
        }
        return { kind: 'complete', status: 0, diagnostics: [], result: { document: 'name = "synthetic"\n' },
            artifact: 'name = "synthetic"\n', destination, question: null }
    }
}

afterEach(() => {
    for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('init application', () => {
    it('previews one exact target without publishing checkout or durable state', async () => {
        const f = fixture()

        const outcome = await runInitApplication(f.input, f.adapters)

        expect(outcome).toEqual(expect.objectContaining({
            kind: 'pending', status: 0, artifact: null, destination: null,
            result: expect.objectContaining({ stage: 'surface-previewed', root: f.root, target: 'codexcli', previewSha256: digest('3') }),
        }))
        expect(f.calls).toEqual(['prepare'])
        expect(readdirSync(f.root)).toEqual([])
        expect(existsSync(join(f.input.home!, 'state'))).toBe(false)
    })

    it('persists the exact draft before returning it and resumes safely from every destination state', async () => {
        const f = fixture()
        const accepted = { ...f.input, accepted: true, acceptedPreviewSha256: digest('3') }

        const prepared = await runInitApplication(accepted, f.adapters)
        f.calls.length = 0
        const reissued = await runInitApplication(accepted, f.adapters)

        expect(prepared).toEqual(expect.objectContaining({
            kind: 'artifact', status: 0, artifact: 'name = "synthetic"\n', destination: f.destination,
            result: expect.objectContaining({ stage: 'draft-prepared' }),
        }))
        expect(reissued).toEqual(prepared)
        expect(f.calls).toEqual(['prepare', 'document', 'observe'])

        f.calls.length = 0
        f.setDestination({ kind: 'available', sha256: digest('f') })
        const changed = await runInitApplication(accepted, f.adapters)
        expect(changed).toEqual(expect.objectContaining({ kind: 'refusal', status: 2 }))
        expect(changed.diagnostics).toEqual([expect.objectContaining({ code: 'INIT_DRAFT_CHANGED' })])
        expect(f.calls).toEqual(['prepare', 'document', 'observe'])

        f.calls.length = 0
        f.setDestination({ kind: 'available', sha256: '010fb9b6053c7bfa4b9936cf8c372cc028feddd5bf4b848f65de048f198c1a3e' })
        const syncRefusal = {
            kind: 'refusal', status: 2, diagnostics: [{ severity: 'error' as const, code: 'SYNC_BLOCKED', message: 'synthetic' }], result: null,
        }
        const blocked = await runInitApplication(accepted, { ...f.adapters, synchronize: async () => {
            f.calls.push('sync-blocked')
            return syncRefusal
        } })
        expect(blocked).toEqual(expect.objectContaining({ kind: 'refusal', status: 2 }))
        expect(blocked.diagnostics).toBe(syncRefusal.diagnostics)
        expect(blocked.result?.ownerOutcome).toBe(syncRefusal)
        expect(f.calls).toEqual(['prepare', 'document', 'observe', 'resume', 'validate', 'sync-blocked'])

        f.calls.length = 0
        const complete = await runInitApplication(accepted, f.adapters)
        expect(complete).toEqual(expect.objectContaining({ kind: 'complete', status: 0, artifact: null, destination: null }))
        expect(f.calls).toEqual(['resume', 'prepare', 'document', 'validate', 'sync', 'check', 'preflight'])
    })

    it('names the deferred greenfield dependency without fabricating a configuration', async () => {
        const f = fixture()
        const adapters: InitApplicationAdapters = { ...f.adapters, document: async () => ({
            kind: 'refusal', status: 2, diagnostics: [{ severity: 'error', code: 'REGISTRY_NOT_FOUND', message: 'missing' }],
            result: null, artifact: null, destination: null,
        }) }

        const outcome = await runInitApplication({ ...f.input, accepted: true, acceptedPreviewSha256: digest('3') }, adapters)

        expect(outcome).toEqual(expect.objectContaining({ kind: 'refusal', status: 2 }))
        expect(outcome.diagnostics).toEqual([expect.objectContaining({ code: 'REGISTRY_NOT_FOUND' })])
    })

    it('persists one provenance-bound unresolved answer and resumes without re-asking it', async () => {
        const f = fixture()
        const adapters: InitApplicationAdapters = { ...f.adapters,
            classifyEstate: async ({ root }) => estate(root, 'incomplete-multi-repository'),
            document: interviewDocument(f.destination) }
        const accepted = { ...f.input, registry: undefined, accepted: true, acceptedPreviewSha256: digest('3') }
        const question = await runInitApplication(accepted, adapters)
        expect(question, JSON.stringify(question)).toMatchObject({ kind: 'pending', result: { question: { field: 'sibling' } } })
        const answered = await runInitApplication({ ...accepted, greenfieldAnswer: {
            questionId: question.result!.question!.id, bytes: '[]', provenance: 'operator-confirmed',
        } }, adapters)
        expect(answered).toMatchObject({ kind: 'artifact', result: { stage: 'draft-prepared' } })
        const resumed = await runInitApplication({ ...accepted, accepted: false }, adapters)
        expect(resumed).toMatchObject({ kind: 'pending', result: { stage: 'draft-prepared' } })
        expect(resumed.result?.question).toBeUndefined()
    })

    it('refuses copied, unproven, oversized and changed-observation greenfield answers', async () => {
        const f = fixture()
        let observed = estate(f.root, 'incomplete-multi-repository')
        const adapters: InitApplicationAdapters = { ...f.adapters, classifyEstate: async () => observed,
            document: interviewDocument(f.destination) }
        const accepted = { ...f.input, registry: undefined, accepted: true, acceptedPreviewSha256: digest('3') }
        const question = await runInitApplication(accepted, adapters)
        const id = question.result!.question!.id
        for (const greenfieldAnswer of [
            { questionId: `question:${'f'.repeat(64)}`, bytes: '[]', provenance: 'operator-confirmed' },
            { questionId: id, bytes: '[]', provenance: 'inferred' },
            { questionId: id, bytes: 'x'.repeat(262_145), provenance: 'operator-confirmed' },
            { questionId: id, bytes: 'api_key=synthetic-secret', provenance: 'operator-confirmed' },
            { questionId: id, bytes: 'npm run dev\u0000', provenance: 'operator-confirmed' },
        ]) {
            const outcome = await runInitApplication({ ...accepted, greenfieldAnswer: greenfieldAnswer as never }, adapters)
            expect(outcome).toMatchObject({ kind: 'refusal', diagnostics: [{ code: 'GREENFIELD_ANSWER_INVALID' }] })
        }
        const original = estate(f.root, 'incomplete-multi-repository')
        if (original.kind !== 'complete') throw new Error('expected complete synthetic observation')
        observed = { kind: 'complete', status: 0, diagnostics: [], result: { ...original.result,
            sourceObservationSha256: digest('8'),
            gaps: [{ field: 'api.runnable', source: 'api/package.json', why: 'observation changed' }],
        } }
        const changed = await runInitApplication(accepted, adapters)
        expect(changed).toMatchObject({ kind: 'refusal', diagnostics: [{ code: 'GREENFIELD_OBSERVATION_CHANGED' }] })
    })

    it('persists more than one interview round and keeps every unaccepted call byte-for-byte read-only', async () => {
        const f = fixture()
        const gaps = Array.from({ length: 4 }, (_, index) => ({
            field: `repository-${index}.runnable`, source: `repository-${index}/package.json`, why: 'runnable command is unknown',
        }))
        const classified: EstateClassificationOutcome = { kind: 'complete', status: 0, diagnostics: [], result: {
            sourceObservationSha256: digest('9'),
            classification: 'incomplete-multi-repository',
            applicability: { stack: true, seed: true, postures: true, registry: true, projection: true, drift: true, compose: 'unknown' },
            notice: 'four unresolved facts', gaps,
            runnable: gaps.map((_, index) => ({ slug: `repository-${index}`, path: `repository-${index}`,
                disposition: 'unknown' as const })),
        } as EstateClassificationResult & { readonly sourceObservationSha256: string } }
        const adapters: InitApplicationAdapters = { ...f.adapters, classifyEstate: async () => classified,
            document: interviewDocument(f.destination, gaps.map(row => row.field)) }
        const accepted = { ...f.input, registry: undefined, accepted: true, acceptedPreviewSha256: digest('3') }
        let outcome = await runInitApplication(accepted, adapters)
        for (let index = 0; index < gaps.length; index += 1) {
            expect(outcome, JSON.stringify(outcome)).toMatchObject({ kind: 'pending', result: { question: { field: gaps[index]!.field } } })
            outcome = await runInitApplication({ ...accepted, greenfieldAnswer: {
                questionId: outcome.result!.question!.id, bytes: `["${index}"]`, provenance: 'operator-confirmed',
            } }, adapters)
        }
        expect(outcome).toMatchObject({ kind: 'artifact', result: { stage: 'draft-prepared' } })

        const selected = await selectBootstrapStateRoot({ platform: 'linux', home: f.input.home,
            xdgStateHome: f.input.xdgStateHome, checkoutRoot: f.root, target: 'codexcli' })
        if (selected.kind !== 'complete') throw new Error('expected selected bootstrap namespace')
        const path = selected.value.paths.bootstrap('codexcli').path
        const before = await readFile(path)
        const preview = await runInitApplication({ ...accepted, accepted: false }, adapters)
        expect(preview).toMatchObject({ kind: 'pending' })
        expect(await readFile(path)).toEqual(before)
        const rejected = await runInitApplication({ ...accepted, accepted: false, greenfieldAnswer: {
            questionId: `question:${digest('e')}`, bytes: 'ignored', provenance: 'operator-confirmed',
        } }, adapters)
        expect(rejected).toMatchObject({ kind: 'refusal', diagnostics: [{ code: 'GREENFIELD_ANSWER_UNEXPECTED' }] })
        expect(await readFile(path)).toEqual(before)
    })

    it.each([
        ['one-sibling', 'GREENFIELD_FLOOR_RENDER_PENDING'],
        ['no-runnable-product', 'GREENFIELD_NO_RUNNABLE_PRODUCT'],
    ] as const)('keeps %s output boundaries explicit', async (classification, _legacyCode) => {
        const f = fixture()
        const adapters: InitApplicationAdapters = { ...f.adapters, classifyEstate: async ({ root }) => estate(root, classification),
            document: interviewDocument(f.destination) }
        const accepted = { ...f.input, registry: undefined, accepted: true, acceptedPreviewSha256: digest('3') }
        const first = await runInitApplication(accepted, adapters)
        const outcome = first.result?.question ? await runInitApplication({ ...accepted, greenfieldAnswer: {
            questionId: first.result.question.id, bytes: '[]', provenance: 'operator-confirmed',
        } }, adapters) : first
        expect(outcome).toMatchObject(classification === 'no-runnable-product'
            ? { kind: 'refusal', diagnostics: [{ code: 'DOCUMENT_NO_RUNNABLE_PRODUCT' }] }
            : { kind: 'artifact', result: { stage: 'draft-prepared' } })
        expect(f.calls).not.toContain('sync')
        expect(f.calls).not.toContain('preflight')
    })

    it('refuses a different target after bootstrap state is bound', async () => {
        const f = fixture()
        await runInitApplication({ ...f.input, accepted: true, acceptedPreviewSha256: digest('3') }, f.adapters)

        const changed = await runInitApplication({ ...f.input, target: 'claudecode', accepted: true,
            acceptedPreviewSha256: digest('3') }, f.adapters)

        expect(changed).toEqual(expect.objectContaining({ kind: 'refusal', status: 2 }))
        expect(changed.diagnostics).toEqual([expect.objectContaining({ code: 'INIT_TARGET_CHANGED' })])
    })

    it('refuses when the accepted preview changes before publication', async () => {
        const f = fixture()
        const preview = await runInitApplication(f.input, f.adapters)
        f.calls.length = 0
        f.setPreviewSha256(digest('4'))

        const outcome = await runInitApplication({ ...f.input, accepted: true,
            acceptedPreviewSha256: preview.result!.previewSha256 }, f.adapters)

        expect(outcome).toEqual(expect.objectContaining({ kind: 'refusal', status: 2 }))
        expect(outcome.diagnostics).toEqual([expect.objectContaining({ code: 'INIT_PREVIEW_CHANGED' })])
        expect(f.calls).toEqual(['prepare'])
        expect(existsSync(join(f.input.home!, 'state'))).toBe(false)
    })

    it.each(['check', 'preflight', 'state'] as const)(
        'resumes after the %s boundary without preparing or applying bootstrap again',
        async (boundary) => {
            const f = fixture()
            let timestampCalls = 0
            let ownerInterrupted = false
            const accepted = { ...f.input, accepted: true, acceptedPreviewSha256: digest('3') }
            const adapters: InitApplicationAdapters = {
                ...f.adapters,
                now: () => {
                    timestampCalls += 1
                    return boundary === 'state' && timestampCalls === 5
                        ? 'invalid'
                        : '2026-10-25T00:00:00.000Z'
                },
                check: async () => {
                    f.calls.push('check')
                    if (boundary === 'check' && !ownerInterrupted) {
                        ownerInterrupted = true
                        return { kind: 'refusal', status: 2,
                            diagnostics: [{ severity: 'error', code: 'CHECK_INTERRUPTED', message: 'synthetic' }], result: null }
                    }
                    return { kind: 'complete', status: 0, diagnostics: [], result: {} }
                },
                preflight: async () => {
                    f.calls.push('preflight')
                    if (boundary === 'preflight' && !ownerInterrupted) {
                        ownerInterrupted = true
                        return { kind: 'refusal', status: 2,
                            diagnostics: [{ severity: 'error', code: 'PREFLIGHT_INTERRUPTED', message: 'synthetic' }], result: null }
                    }
                    return { kind: 'complete', status: 0, diagnostics: [], result: { verdict: 'pass' } }
                },
            }
            const artifact = await runInitApplication(accepted, adapters)
            expect(artifact.kind).toBe('artifact')
            f.setDestination({ kind: 'available', sha256: '010fb9b6053c7bfa4b9936cf8c372cc028feddd5bf4b848f65de048f198c1a3e' })

            const interrupted = await runInitApplication(accepted, adapters)
            expect(interrupted).toEqual(expect.objectContaining({ kind: 'refusal', status: 2 }))
            f.calls.length = 0

            const resumed = await runInitApplication(accepted, adapters)

            expect(resumed).toEqual(expect.objectContaining({ kind: 'complete', status: 0 }))
            expect(f.calls).toEqual(['resume', 'document', 'validate', 'sync', 'check', 'preflight'])
        },
    )
})


it('composes observed greenfield answers into a loadable configuration and actual generated sync/check', async () => {
    const f = fixture()
    mkdirSync(join(f.root, 'app'))
    mkdirSync(join(f.root, 'fixtures'))
    const packageBytes = JSON.stringify({ scripts: { start: 'node server.mjs' } })
    await writeFile(join(f.root, 'app/package.json'), packageBytes)
    await writeFile(join(f.root, 'fixtures/personas.json'), '[{"id":"synthetic"}]\n')
    const sourceConfig = parseToml(await readFile(resolve('fixtures/registries/generated-environment.toml'), 'utf8')) as {
        sibling: unknown; ports: { bases: unknown }; environment: { install_policies: unknown; generated: unknown }
    }
    const synchronizeInputs: boolean[] = []
    const adapters: InitApplicationAdapters = {
        ...f.adapters,
        prepareBootstrap: prepareSelectedBootstrapSurface,
        resumeBootstrap: resumeSelectedBootstrapSurface,
        applyBootstrap: applySelectedBootstrapSurface,
        document: documentObservedCommand,
        classifyEstate: input => classifyEstateObservation(input, { observe: observePublicEstate }),
        observeDestination: async ({ path }) => {
            if (!existsSync(path)) return { kind: 'absent' }
            return { kind: 'available', sha256: createHash('sha256').update(await readFile(path)).digest('hex') }
        },
        validateConfig: loadCockpitConfig,
        synchronize: input => {
            synchronizeInputs.push(input.bootstrapState !== undefined)
            return syncGeneratedEnvironment(input)
        },
        check: checkGeneratedEnvironment,
    }
    const greenfieldInput: InitApplicationInput = {
        root: f.root, target: f.input.target, accepted: false, sessionId: f.input.sessionId,
        platform: f.input.platform, home: f.input.home, xdgStateHome: f.input.xdgStateHome,
    }
    const preview = await runInitApplication(greenfieldInput, adapters)
    expect(preview.kind).toBe('pending')
    const accepted = { ...greenfieldInput, accepted: true, acceptedPreviewSha256: preview.result!.previewSha256 }
    let outcome = await runInitApplication(accepted, adapters)
    for (let count = 0; outcome.kind === 'pending' && outcome.result?.question; count += 1) {
        expect(count).toBeLessThan(5)
        const question = outcome.result.question
        const value = question.field === 'sibling' ? sourceConfig.sibling
            : question.field === 'ports.bases' ? sourceConfig.ports.bases
                : question.field === 'environment.install_policies' ? sourceConfig.environment.install_policies
                : question.field === 'environment.generated' ? sourceConfig.environment.generated
                    : question.field === 'configuration.defaults'
                        ? { confirmed: true, sha256: question.expectedSha256 }
                        : undefined
        expect(value, question.field).toBeDefined()
        outcome = await runInitApplication({ ...accepted, greenfieldAnswer: {
            questionId: question.id, bytes: JSON.stringify(value), provenance: 'operator-confirmed',
        } }, adapters)
    }
    const artifact = outcome
    expect(artifact.kind).toBe('artifact')
    expect(await loadCockpitConfig(f.destination)).toMatchObject({ kind: 'refusal' })
    await writeFile(join(f.root, 'app/package.json'), JSON.stringify({ scripts: { start: 'node changed.mjs' } }))
    expect(await runInitApplication(accepted, adapters)).toMatchObject({ kind: 'refusal', status: 2,
        diagnostics: [{ code: 'DOCUMENT_ESTATE_OBSERVATION_CHANGED' }] })
    await writeFile(join(f.root, 'app/package.json'), packageBytes)
    await writeFile(f.destination, artifact.artifact!)
    expect(await loadCockpitConfig(f.destination)).toMatchObject({ kind: 'complete', status: 0,
        result: { config: { cockpit: { scope: 'stack' }, environment: { generated: expect.any(Object) } } } })
    const completed = await runInitApplication(accepted, adapters)
    expect(completed, JSON.stringify(completed)).toMatchObject({ kind: 'complete', status: 0,
        result: { stage: 'environment-verified' } })
    expect(synchronizeInputs).toEqual([true])
}, 120_000)
