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
import { deriveInferredFacts } from '../init/derive.js'
import { runInitOperatorCommand, type InitCommandIo } from '../init/command.js'
import { runCli } from '../cli.js'
import { renderHumanValue } from '../diagnostics.js'
import { cockpitCommand, initCommand } from '../fix-catalogue.js'
import type { SurfaceTarget } from '../surfaces/contract.js'
import { classifyEstateObservation, documentObservedCommand, observePublicEstate, type DocumentCommandInput, type DocumentOutcome, type EstateClassificationOutcome, type EstateClassificationResult } from '../document/command.js'
import { readState, selectBootstrapStateRoot } from './state.js'
import { syncTeamGeneratedEnvironment } from './generated-application.js'
import { inspectInitReadiness } from './readiness-composition.js'
import { executeProbe } from '../environment-exec/execute.js'

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
            sources: Object.freeze([{ path: 'skills/cockpit-setup.skill.md', sha256: digest('1') }]),
            files: Object.freeze([{ path: '.agents/skills/cockpit-setup/SKILL.md', sha256: digest('2') }]),
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
        const index = input.configuration?.answers.length ?? 0
        if (index < fields.length) {
            const id = `question:${createHash('sha256').update(`${input.configuration?.sourceObservationSha256}:${index}`).digest('hex')}` as const
            // The document owner reports the open question as a blocking gap, as a standalone draft would be invalid.
            return { kind: 'gap-draft', status: 2, diagnostics: [{ severity: 'error', code: 'DOCUMENT_GAP', target: fields[index]!,
                message: 'runnable command is unknown' }], result: { document: '# incomplete\n' }, artifact: '# incomplete\n', destination,
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

    it('completes a surfaces-only cockpit whose preflight reports only that no runtime is declared', async () => {
        const f = fixture()
        const accepted = { ...f.input, accepted: true, acceptedPreviewSha256: digest('3') }
        await runInitApplication(accepted, f.adapters)
        f.setDestination({ kind: 'available', sha256: '010fb9b6053c7bfa4b9936cf8c372cc028feddd5bf4b848f65de048f198c1a3e' })
        const notDeclared = { severity: 'error' as const, code: 'ENVIRONMENT_NOT_DECLARED', message: 'synthetic: no runtime is declared' }
        const completed = await runInitApplication(accepted, { ...f.adapters, preflight: async () => ({
            kind: 'blocked', status: 2, diagnostics: [notDeclared], result: { verdict: 'unavailable' } }) })
        expect(completed).toMatchObject({ kind: 'complete', status: 0, result: { stage: 'environment-verified' },
            diagnostics: [{ severity: 'info', code: 'ENVIRONMENT_NOT_DECLARED', message: notDeclared.message }] })
    })

    it('asks where the cockpit lives before publishing anything into a product repository', async () => {
        const f = fixture()
        const observed: unknown[] = []
        const adapters: InitApplicationAdapters = { ...f.adapters, observeRoot: async () => 'product-repository',
            classifyEstate: async input => { observed.push(input); return estate(input.root, 'one-sibling') },
            document: interviewDocument(f.destination) }
        const greenfield = { ...f.input, registry: undefined }
        const dedicated = resolve(f.root, '..', 'checkout-cockpit')
        const placement = await runInitApplication(greenfield, adapters)
        expect(placement).toMatchObject({ kind: 'pending', result: {
            cockpitRoot: { field: 'cockpit.root', recommended: 'dedicated', options: [
                { answer: 'dedicated', root: dedicated, creates: [dedicated], siblingsRoot: '..', firstSibling: f.root },
                { answer: 'in-repo', root: f.root, creates: [], siblingsRoot: '.', firstSibling: f.root }] } } })
        expect(placement.result).not.toHaveProperty('nextCommand')
        expect(observed).toEqual([])
        // Consent to the preview bytes is not consent to a location.
        expect(await runInitApplication({ ...greenfield, accepted: true, acceptedPreviewSha256: digest('3') }, adapters))
            .toMatchObject({ kind: 'refusal', diagnostics: [{ code: 'INIT_COCKPIT_ROOT_REQUIRED', target: 'cockpit.root',
                message: expect.stringContaining('cockpit.root = "dedicated"') }] })
        expect(f.calls).not.toContain('apply')
        expect(existsSync(join(f.input.home!, 'state'))).toBe(false)

        // The dedicated cockpit observes only the product repository in the shared parent, not its unrelated neighbours.
        mkdirSync(dedicated)
        const rooted = <T extends { kind: string; result: unknown }>(outcome: T): T => outcome.kind === 'complete'
            ? { ...outcome, result: { ...outcome.result as object, root: dedicated } } : outcome
        const beside: InitApplicationAdapters = { ...adapters,
            prepareBootstrap: async input => rooted(await adapters.prepareBootstrap(input)),
            applyBootstrap: async authority => rooted(await adapters.applyBootstrap(authority)) }
        const besideOutcome = await runInitApplication({ ...greenfield, root: dedicated, cockpitRoot: { kind: 'dedicated', firstSibling: f.root },
            accepted: true, acceptedPreviewSha256: digest('3') }, beside)
        expect(besideOutcome, JSON.stringify(besideOutcome.diagnostics)).toMatchObject({ kind: 'pending', result: { root: dedicated, question: { field: 'sibling' } } })
        expect(observed).toEqual([{ root: resolve(f.root, '..'), repositories: ['checkout'] }])
        const inRepo = await runInitApplication({ ...greenfield, cockpitRoot: { kind: 'in-repo' } }, adapters)
        expect(inRepo).toMatchObject({ kind: 'pending', result: { root: f.root } })
        expect(inRepo.result).not.toHaveProperty('nextCommand')
        // In-repo keeps the product: the root is observed as a repository itself, not as an empty cockpit.
        expect(observed.at(-1)).toEqual({ root: f.root, rootIsRepository: true })

        const acceptedInRepo = { ...greenfield, cockpitRoot: { kind: 'in-repo' } as const,
            accepted: true, acceptedPreviewSha256: digest('3') }
        expect(await runInitApplication(acceptedInRepo, adapters)).toMatchObject({
            kind: 'pending', result: { question: { field: 'sibling' } },
        })
        observed.length = 0

        // Each CLI invocation starts without placement context; the authenticated preview must
        // retain the accepted in-repo estate while the driver resumes its durable question.
        const resumedInRepo = await runInitApplication({ ...greenfield, accepted: false }, adapters)
        expect(resumedInRepo).toMatchObject({ kind: 'pending', result: { question: { field: 'sibling' } } })
        expect(observed).toEqual([{ root: f.root, rootIsRepository: true }])
    })

    it('accepts a dedicated answer reset from the original product root through the public driver', async () => {
        const f = fixture()
        const dedicated = resolve(f.root, '..', 'checkout-cockpit')
        mkdirSync(dedicated)
        let preparedRoot = f.root
        const rooted = <T extends { kind: string; result: unknown }>(outcome: T, root: string): T => outcome.kind === 'complete'
            ? { ...outcome, result: { ...outcome.result as object, root } } : outcome
        const adapters: InitApplicationAdapters = {
            ...f.adapters,
            observeRoot: async ({ root }) => root === f.root ? 'product-repository' : 'cockpit-root',
            prepareBootstrap: async input => {
                preparedRoot = input.root
                return rooted(await f.adapters.prepareBootstrap(input), input.root)
            },
            applyBootstrap: async authority => rooted(await f.adapters.applyBootstrap(authority), preparedRoot),
            classifyEstate: async input => estate(input.root, 'one-sibling'),
            document: interviewDocument(join(dedicated, 'cockpit.toml'), ['sibling', 'configuration.defaults']),
        }
        const application = (input: InitApplicationInput) => runInitApplication(input, adapters)
        const accepted = { ...f.input, root: dedicated, registry: undefined,
            cockpitRoot: { kind: 'dedicated' as const, firstSibling: f.root }, accepted: true,
            acceptedPreviewSha256: digest('3') }
        const question = await application(accepted)
        expect(question).toMatchObject({ kind: 'pending', status: 0, result: { question: { field: 'sibling' } } })
        // A run that stops at a question exits 0, so the question must not read as an error.
        expect(question.diagnostics).toEqual([expect.objectContaining({ severity: 'info', code: 'DOCUMENT_GAP', target: 'sibling' })])
        expect((await application({ ...accepted, accepted: false })).diagnostics.filter(row => row.severity === 'error')).toEqual([])
        expect(await application({ ...accepted, greenfieldAnswer: {
            questionId: question.result!.question!.id, bytes: '[]', provenance: 'operator-confirmed',
        } })).toMatchObject({ kind: 'pending', result: { question: { field: 'configuration.defaults' } } })

        const io: InitCommandIo = { terminal: false, confirm: async () => undefined, writeArtifact: async () => undefined }
        const command = (resetAnswer: NonNullable<InitApplicationInput['resetAnswer']>) => runInitOperatorCommand({
            root: f.root, target: 'codexcli', sessionId: 'separate-public-invocation', platform: 'linux',
            home: f.input.home, xdgStateHome: f.input.xdgStateHome, resetAnswer,
        }, { interactive: false, json: true }, io, application)
        const preview = await command({ field: 'sibling' })
        expect(preview).toMatchObject({ kind: 'pending', result: { root: dedicated, resetAnswer: {
            field: 'sibling', previewSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        } } })
        const reset = preview.result!.resetAnswer!

        expect(await command({ field: reset.field, acceptedPreviewSha256: digest('f') })).toMatchObject({
            kind: 'refusal', diagnostics: [{ code: 'INIT_ANSWER_RESET_STALE' }],
        })
        expect(await command({ field: reset.field, acceptedPreviewSha256: reset.previewSha256 })).toMatchObject({
            kind: 'pending', result: { root: dedicated, question: { field: 'sibling' },
                resetAnswer: { previewSha256: reset.previewSha256 } },
        })
    })

    it.each(['dedicated', 'in-repo'] as const)('accepts the same answers file on every run of a %s init without reporting applied answers unused', async placement => {
        const f = fixture()
        const dedicated = resolve(f.root, '..', 'checkout-cockpit')
        const root = placement === 'dedicated' ? dedicated : f.root
        let preparedRoot = f.root
        const rooted = <T extends { kind: string; result: unknown }>(outcome: T, root: string): T => outcome.kind === 'complete'
            ? { ...outcome, result: { ...outcome.result as object, root } } : outcome
        const adapters: InitApplicationAdapters = {
            ...f.adapters,
            observeRoot: async ({ root }) => root === f.root ? 'product-repository' : 'cockpit-root',
            prepareBootstrap: async input => {
                preparedRoot = input.root
                return rooted(await f.adapters.prepareBootstrap(input), input.root)
            },
            applyBootstrap: async authority => rooted(await f.adapters.applyBootstrap(authority), preparedRoot),
            resumeBootstrap: async input => rooted(await f.adapters.resumeBootstrap(input), input.root),
            classifyEstate: async input => estate(input.root, 'one-sibling'),
            document: interviewDocument(join(root, 'cockpit.toml'), ['cockpit.name', 'sibling']),
        }
        const io: InitCommandIo = { terminal: false, confirm: async () => undefined,
            createCockpitRoot: async path => { mkdirSync(path, { recursive: true }) },
            // The persisted draft is 'name = "synthetic"\n'; writing it makes the destination match.
            writeArtifact: async () => f.setDestination({ kind: 'available', sha256: '010fb9b6053c7bfa4b9936cf8c372cc028feddd5bf4b848f65de048f198c1a3e' }) }
        const run = (answers: Record<string, unknown>) => runInitOperatorCommand({ root: f.root, target: 'codexcli',
            sessionId: 'separate-public-invocation', platform: 'linux', home: f.input.home, xdgStateHome: f.input.xdgStateHome },
        { interactive: false, json: true, unattended: { previewSha256: digest('3'), answers } }, io,
        input => runInitApplication(input, adapters))
        const answers = { cockpit: { root: placement, name: 'checkout' }, sibling: [] }

        expect(await run({ cockpit: { root: placement } })).toMatchObject({ kind: 'pending', result: { root, question: { field: 'cockpit.name' } } })
        for (const attempt of ['completes', 'resumes']) {
            const outcome = await run(answers)
            expect(outcome, `${attempt}: ${JSON.stringify(outcome.diagnostics)}`).toMatchObject({ kind: 'complete', result: { root, stage: 'environment-verified' } })
            expect(outcome.diagnostics.map(row => row.code), attempt).not.toContain('INIT_ANSWER_UNUSED')
        }
        // An applied answer stays in force, so the file cannot quietly change it after the fact.
        expect(await run({ ...answers, sibling: [{ slug: 'checkout' }] })).toMatchObject({ kind: 'refusal',
            diagnostics: [{ code: 'INIT_ANSWER_CONFLICT', message: expect.stringContaining('sibling') }] })
        if (placement === 'in-repo') expect(await run({ ...answers, cockpit: { root: 'dedicated' } })).toMatchObject({
            kind: 'refusal', diagnostics: [{ code: 'INIT_ANSWER_CONFLICT', message: expect.stringContaining('cockpit.root') }] })
    })

    it('resumes durable init state when init-created files make the root look like a product repository', async () => {
        const f = fixture()
        let rootKind: 'cockpit-root' | 'product-repository' = 'cockpit-root'
        const adapters: InitApplicationAdapters = {
            ...f.adapters,
            observeRoot: async () => rootKind,
            classifyEstate: async ({ root }) => estate(root, 'no-runnable-product'),
        }
        const accepted = { ...f.input, registry: undefined, accepted: true, acceptedPreviewSha256: digest('3') }
        const artifact = await runInitApplication(accepted, adapters)
        expect(artifact).toMatchObject({ kind: 'artifact', result: { stage: 'draft-prepared' } })
        f.setDestination({ kind: 'available', sha256: '010fb9b6053c7bfa4b9936cf8c372cc028feddd5bf4b848f65de048f198c1a3e' })
        expect(await runInitApplication(accepted, adapters)).toMatchObject({
            kind: 'complete', result: { stage: 'environment-verified' },
        })
        rootKind = 'product-repository'

        const resumed = await runInitApplication(accepted, adapters)

        expect(resumed).toMatchObject({ kind: 'complete', result: { stage: 'environment-verified' } })
    })

    it('resumes an accepted preview after partial publication changes root classification', async () => {
        const f = fixture()
        let rootKind: 'cockpit-root' | 'product-repository' = 'cockpit-root'
        let interruptPublication = true
        const adapters: InitApplicationAdapters = {
            ...f.adapters,
            observeRoot: async () => rootKind,
            classifyEstate: async ({ root }) => estate(root, 'no-runnable-product'),
            applyBootstrap: async authority => {
                if (interruptPublication) {
                    interruptPublication = false
                    return { kind: 'refusal', status: 2, diagnostics: [{ severity: 'error',
                        code: 'PUBLICATION_INTERRUPTED', message: 'synthetic publication interruption' }], result: null }
                }
                return f.adapters.applyBootstrap(authority)
            },
        }
        const accepted = { ...f.input, registry: undefined, accepted: true, acceptedPreviewSha256: digest('3') }
        expect(await runInitApplication(accepted, adapters)).toMatchObject({
            kind: 'refusal', result: { stage: 'surface-previewed' },
            diagnostics: [{ code: 'PUBLICATION_INTERRUPTED' }],
        })
        rootKind = 'product-repository'

        const resumed = await runInitApplication(accepted, adapters)

        expect(resumed).toMatchObject({ kind: 'artifact', result: { stage: 'draft-prepared' } })
    })

    it('infers dedicated-cockpit answers from the observed product estate', async () => {
        const f = fixture()
        await writeFile(join(f.root, 'Dockerfile'), 'FROM node:22\nEXPOSE 3000\nCMD ["node", "server.mjs"]\n')
        await writeFile(join(f.root, 'compose.yml'), 'services:\n  api:\n    build: .\n')
        mkdirSync(join(f.root, '.github/workflows'), { recursive: true })
        await writeFile(join(f.root, '.github/workflows/ci.yml'), 'jobs: [unclosed')
        await writeFile(resolve(f.root, '..', 'Dockerfile'), 'FROM marker.invalid/unrelated\nEXPOSE 9000\n')
        await writeFile(resolve(f.root, '..', 'compose.yml'), 'services:\n  unrelated:\n    image: marker.invalid/unrelated\n')
        const dedicated = resolve(f.root, '..', 'checkout-cockpit')
        mkdirSync(dedicated)
        await writeFile(join(dedicated, 'compose.yml'), 'services:\n  api:\n    build: ../checkout\n')
        const classified = estate(resolve(f.root, '..'), 'one-sibling')
        if (classified.kind !== 'complete') throw new Error('expected a complete estate classification')
        const adapters: InitApplicationAdapters = {
            ...f.adapters,
            classifyEstate: async () => ({ ...classified, result: { ...classified.result,
                runnable: [{ slug: 'checkout', path: 'checkout', disposition: 'confirmed' }] } }),
            infer: deriveInferredFacts,
            prepareBootstrap: async input => {
                const outcome = await f.adapters.prepareBootstrap(input)
                if (outcome.kind !== 'complete') throw new Error('expected a complete bootstrap preview')
                return { ...outcome, result: { ...outcome.result, root: dedicated } }
            },
        }

        const outcome = await runInitApplication({ ...f.input, root: dedicated, registry: undefined,
            cockpitRoot: { kind: 'dedicated', firstSibling: f.root } }, adapters)

        expect(outcome, JSON.stringify(outcome.diagnostics)).toMatchObject({ kind: 'pending', result: { interview: {
            inferenceSkipped: expect.arrayContaining([
                expect.objectContaining({ source: '../checkout/compose.yml',
                    reason: expect.stringContaining('outside the cockpit root') }),
                expect.objectContaining({ source: '../checkout/.github/workflows/ci.yml',
                    reason: expect.stringContaining('not valid YAML') }),
            ]),
            outstanding: expect.arrayContaining([
                expect.objectContaining({ field: 'ports.bases', inferred: [expect.objectContaining({
                    target: 'checkout.container_ports', value: [3000],
                    provenance: expect.objectContaining({ source: '../checkout/Dockerfile' }),
                })] }),
                expect.objectContaining({ field: 'environment.generated', inferred: expect.arrayContaining([
                    expect.objectContaining({ target: 'environment.compose_files', value: ['compose.yml'],
                        provenance: expect.objectContaining({ source: 'compose.yml' }) }),
                    expect.objectContaining({ target: 'checkout.command', value: ['node', 'server.mjs'],
                        provenance: expect.objectContaining({ source: '../checkout/Dockerfile' }) }),
                ]) }),
            ]),
        } } })
        expect(JSON.stringify(outcome)).not.toContain('marker.invalid/unrelated')
        expect(JSON.stringify(outcome)).not.toContain('9000')
    })

    it.each([
        ['Compose-only', {
            'package.json': JSON.stringify({ scripts: { build: 'node build.mjs' } }),
            'compose.yml': 'services:\n  app:\n    image: synthetic.invalid/app:1\n',
        }, 'environment.compose_files'],
        ['Dockerfile-only', {
            Dockerfile: 'FROM python:3.13-slim\nEXPOSE 8000\nCMD ["python", "app.py"]\n',
        }, 'app.command'],
    ] as const)('keeps a %s product in the public init environment interview', async (_shape, files, inferredTarget) => {
        const f = fixture()
        mkdirSync(join(f.root, 'app'))
        for (const [name, bytes] of Object.entries(files)) await writeFile(join(f.root, 'app', name), bytes)
        const adapters: InitApplicationAdapters = {
            ...f.adapters,
            classifyEstate: input => classifyEstateObservation(input, { observe: observePublicEstate }),
            document: documentObservedCommand,
            infer: deriveInferredFacts,
        }
        const input = { ...f.input, registry: undefined }
        const preview = await runInitApplication(input, adapters)

        const outcome = await runInitApplication({ ...input, accepted: true,
            acceptedPreviewSha256: preview.result!.previewSha256 }, adapters)

        expect(outcome).toMatchObject({ kind: 'pending', result: {
            estate: { classification: 'one-sibling', runnable: [{ slug: 'app', disposition: 'confirmed' }] },
            interview: { outstanding: expect.arrayContaining([
                expect.objectContaining({ field: 'environment.generated', inferred: expect.arrayContaining([
                    expect.objectContaining({ target: inferredTarget }),
                ]) }),
                expect.objectContaining({ field: 'environment.machine' }),
            ]) },
        } })
        expect(outcome.result?.interview?.outstanding).not.toEqual(expect.arrayContaining([
            expect.objectContaining({ field: 'estate.runnable' }),
        ]))
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

    it('refuses copied, unproven and oversized greenfield answers, then restarts a changed-source interview', async () => {
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
            expect(outcome).toMatchObject({ kind: 'refusal' })
            expect(outcome.diagnostics[0]).toMatchObject({ code: 'GREENFIELD_ANSWER_INVALID' })
        }
        const rejected = await runInitApplication({ ...accepted, greenfieldAnswer: {
            questionId: id, bytes: 'api_key=synthetic-secret', provenance: 'operator-confirmed' } as never }, adapters)
        expect(rejected.diagnostics).toEqual([
            expect.objectContaining({ code: 'GREENFIELD_ANSWER_INVALID' }),
            expect.objectContaining({ code: 'DOCUMENT_CONFIGURATION_ANSWER_INVALID',
                message: 'operator answers cannot contain sensitive fields' }),
        ])
        const original = estate(f.root, 'incomplete-multi-repository')
        if (original.kind !== 'complete') throw new Error('expected complete synthetic observation')
        const selected = await selectBootstrapStateRoot({ platform: 'linux', home: f.input.home,
            xdgStateHome: f.input.xdgStateHome, checkoutRoot: f.root, target: 'codexcli' })
        if (selected.kind !== 'complete') throw new Error('expected selected bootstrap namespace')
        const address = selected.value.paths.bootstrap('codexcli')
        const before = await readState(address)
        observed = { kind: 'complete', status: 0, diagnostics: [], result: {
            ...original.result, classification: 'one-sibling',
        } }
        expect(await runInitApplication({ ...accepted, accepted: false }, adapters)).toMatchObject({
            kind: 'refusal', diagnostics: [{ code: 'GREENFIELD_OBSERVATION_CHANGED' }],
        })
        expect(await readState(address)).toEqual(before)
        observed = { kind: 'complete', status: 0, diagnostics: [], result: { ...original.result,
            sourceObservationSha256: digest('8'),
            gaps: [{ field: 'api.runnable', source: 'api/package.json', why: 'observation changed' }],
        } }
        const preview = await runInitApplication({ ...accepted, accepted: false }, adapters)
        expect(preview).toMatchObject({ kind: 'pending', result: {
            estate: { sourceObservationSha256: digest('8'), answers: [] },
            interview: { answered: [] },
        } })
        expect(preview.result?.interview?.outstanding).toEqual(expect.arrayContaining([expect.objectContaining({ field: 'sibling' })]))
        expect(preview.result).not.toHaveProperty('question')
        expect(await readState(address)).toEqual(before)

        const staleAnswer = await runInitApplication({ ...accepted, greenfieldAnswer: {
            questionId: id, bytes: '[]', provenance: 'operator-confirmed',
        } }, adapters)
        expect(staleAnswer).toMatchObject({ kind: 'refusal', diagnostics: [{
            code: 'GREENFIELD_ANSWER_INVALID',
            message: expect.stringContaining(`rerun ${initCommand({ root: accepted.root, target: accepted.target })} to review the fresh observation`),
        }] })
        expect(await readState(address)).toEqual(before)

        const changed = await runInitApplication(accepted, adapters)
        expect(changed).toMatchObject({ kind: 'pending', result: { question: {
            id: `question:${createHash('sha256').update(`${digest('8')}:0`).digest('hex')}`,
        },
            estate: { sourceObservationSha256: digest('8'), answers: [] }, interview: { answered: [] } } })
        const refreshed = await readState(address)
        if (before.kind !== 'complete') throw new Error('expected persisted stale interview')
        expect(refreshed).toMatchObject({ kind: 'complete', value: { revision: before.value.revision + 1, value: {
            stage: 'surface-published', greenfield: { stage: 'question-pending', sourceObservationSha256: digest('8'),
                questions: [{ field: 'sibling' }], answers: [] },
        } } })
        const resumed = await runInitApplication({ ...accepted, accepted: false }, adapters)
        expect(resumed).toMatchObject({ kind: 'pending', result: { question: {
            id: `question:${createHash('sha256').update(`${digest('8')}:0`).digest('hex')}`,
        }, estate: { sourceObservationSha256: digest('8'), answers: [] }, interview: { answered: [] } } })
    })

    it('persists more than one interview round and keeps every unaccepted call byte-for-byte read-only', async () => {
        const f = fixture()
        const gaps = Array.from({ length: 4 }, (_, index) => ({
            field: `repository-${index}.runnable`, source: `repository-${index}/package.json`, why: 'runnable command is unknown',
        }))
        const classified: EstateClassificationOutcome = { kind: 'complete', status: 0, diagnostics: [], result: {
            sourceObservationSha256: digest('9'),
            classification: 'incomplete-multi-repository',
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

    it('requires a fresh preview before replacing bootstrap sources and preserves the current interview', async () => {
        const f = fixture()
        f.setPreviewSha256(createHash('sha256').update(JSON.stringify({ target: 'codexcli',
            sources: [{ path: 'skills/cockpit-setup.skill.md', sha256: digest('1') }],
            files: [{ path: '.agents/skills/cockpit-setup/SKILL.md', sha256: digest('2') }],
        })).digest('hex'))
        const baseAdapters: InitApplicationAdapters = { ...f.adapters,
            classifyEstate: async () => estate(f.root, 'one-sibling'),
            document: interviewDocument(f.destination) }
        const input = { ...f.input, registry: undefined }
        const firstPreview = await runInitApplication(input, baseAdapters)
        if (firstPreview.kind !== 'pending' || !firstPreview.result) throw new Error('initial bootstrap preview was unavailable')
        const accepted = { ...input, accepted: true, acceptedPreviewSha256: firstPreview.result.previewSha256 }
        const question = await runInitApplication(accepted, baseAdapters)
        expect(question).toMatchObject({ kind: 'pending', result: { stage: 'surface-published', question: { field: 'sibling' } } })

        const selected = await selectBootstrapStateRoot({ platform: 'linux', home: f.input.home,
            xdgStateHome: f.input.xdgStateHome, checkoutRoot: f.root, target: 'codexcli' })
        if (selected.kind !== 'complete') throw new Error('expected selected bootstrap namespace')
        const address = selected.value.paths.bootstrap('codexcli')
        const before = await readState(address)
        if (before.kind !== 'complete') throw new Error('expected persisted bootstrap interview')
        const freshSources = Object.freeze([{ path: 'skills/cockpit-setup.skill.md', sha256: digest('4') }])
        const freshFiles = Object.freeze(before.value.value.published.map(row => Object.freeze({ ...row, sha256: digest('5') })))
        const freshPreviewSha256 = createHash('sha256').update(JSON.stringify({ target: 'codexcli',
            sources: freshSources, files: freshFiles })).digest('hex')
        const freshProjection = Object.freeze({ root: f.root, target: 'codexcli' as const,
            sources: freshSources, files: freshFiles, previewSha256: freshPreviewSha256 })
        const authority = Object.freeze({ kind: 'selected-bootstrap-publication-authority' as const })
        let applications = 0
        const adapters: InitApplicationAdapters = { ...baseAdapters,
            resumeBootstrap: async request => {
                expect(request).toMatchObject({ expectedRevision: before.value.revision,
                    expectedCommandSha256: before.value.value.commandSha256 })
                return Object.freeze({ kind: 'refresh' as const, status: 0 as const,
                    diagnostics: Object.freeze([]), result: freshProjection, authority, canonicalOwnership: false as const })
            },
            applyBootstrap: async supplied => {
                applications += 1
                expect(supplied).toBe(authority)
                return Object.freeze({ kind: 'complete' as const, status: 0 as const, diagnostics: Object.freeze([]),
                    result: freshProjection, authority })
            } }
        const preview = await runInitApplication(input, adapters)
        expect(preview).toMatchObject({ kind: 'pending', result: { stage: 'surface-published', previewSha256: freshPreviewSha256 } })
        expect(await readState(address)).toEqual(before)
        expect(applications).toBe(0)

        await expect(runInitApplication(accepted, adapters)).resolves.toMatchObject({ kind: 'refusal',
            diagnostics: [{ code: 'INIT_PREVIEW_CHANGED' }] })
        expect(await readState(address)).toEqual(before)
        expect(applications).toBe(0)

        const refreshed = await runInitApplication({ ...accepted, acceptedPreviewSha256: freshPreviewSha256 }, adapters)
        expect(refreshed, JSON.stringify(refreshed)).toMatchObject({ kind: 'pending', result: { stage: 'surface-published', question: { field: 'sibling' } } })
        expect(applications).toBe(1)
        const after = await readState(address)
        expect(after).toMatchObject({ kind: 'complete', value: { value: {
            sources: freshProjection.sources, published: freshProjection.files, previewSha256: freshPreviewSha256,
            greenfield: before.value.value.greenfield,
        } } })
    })

    it('previews and accepts an exact recorded-answer reset while retaining earlier answers', async () => {
        const f = fixture()
        const fields = ['cockpit.name', 'sibling', 'estate.runnable', 'ports.bases']
        const gaps = fields.slice(1).map((field, index) => ({ field, source: `repository-${index}/package.json`, why: 'runnable command is unknown' }))
        const classified: EstateClassificationOutcome = { kind: 'complete', status: 0, diagnostics: [], result: {
            sourceObservationSha256: digest('9'), classification: 'incomplete-multi-repository',
            applicability: { stack: true, seed: true, postures: true, registry: true, projection: true, drift: true, compose: 'unknown' },
            notice: 'three unresolved facts', gaps,
            runnable: gaps.map((_, index) => ({ slug: `repository-${index}`, path: `repository-${index}`,
                disposition: 'unknown' as const })),
        } as EstateClassificationResult & { readonly sourceObservationSha256: string } }
        const adapters: InitApplicationAdapters = { ...f.adapters, classifyEstate: async () => classified,
            document: interviewDocument(f.destination, fields) }
        const accepted = { ...f.input, registry: undefined, accepted: true, acceptedPreviewSha256: digest('3') }
        let outcome = await runInitApplication(accepted, adapters)
        for (const value of ['synthetic', 'first', 'second']) {
            outcome = await runInitApplication({ ...accepted, greenfieldAnswer: {
                questionId: outcome.result!.question!.id, bytes: JSON.stringify(value), provenance: 'operator-confirmed',
            } }, adapters)
        }
        expect(outcome).toMatchObject({ kind: 'pending', result: { question: { field: 'ports.bases' },
            interview: { answered: ['cockpit.name', 'sibling', 'estate.runnable'] } } })

        const selected = await selectBootstrapStateRoot({ platform: 'linux', home: f.input.home,
            xdgStateHome: f.input.xdgStateHome, checkoutRoot: f.root, target: 'codexcli' })
        if (selected.kind !== 'complete') throw new Error('expected selected bootstrap namespace')
        const address = selected.value.paths.bootstrap('codexcli')
        const before = await readFile(address.path)
        const preview = await runInitApplication({ ...f.input, registry: undefined, resetAnswer: {
            field: 'estate.runnable',
        } }, adapters)
        expect(preview).toMatchObject({ kind: 'pending', result: { resetAnswer: { field: 'estate.runnable',
            invalidatedFields: ['estate.runnable', 'ports.bases'], revision: expect.any(Number),
            previewSha256: expect.stringMatching(/^[a-f0-9]{64}$/) } } })
        expect(await readFile(address.path)).toEqual(before)

        const reset = preview.result!.resetAnswer!
        const applied = await runInitApplication({ ...f.input, registry: undefined, resetAnswer: {
            field: reset.field, acceptedPreviewSha256: reset.previewSha256,
        } }, adapters)
        expect(applied).toMatchObject({ kind: 'pending', result: { question: { field: 'estate.runnable' },
            interview: { answered: ['cockpit.name', 'sibling'] }, resetAnswer: { previewSha256: reset.previewSha256 } } })
        expect(await runInitApplication({ ...f.input, registry: undefined, resetAnswer: {
            field: reset.field, acceptedPreviewSha256: reset.previewSha256,
        } }, adapters)).toMatchObject({ kind: 'refusal', diagnostics: [{ code: 'INIT_ANSWER_RESET_STALE' }] })
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
        expect(outcome).toMatchObject({ kind: 'artifact', result: { stage: 'draft-prepared' } })
        expect(f.calls).not.toContain('sync')
        expect(f.calls).not.toContain('preflight')
    })

    it('lists every outstanding field with its inferred values and provenance before and after acceptance', async () => {
        const f = fixture()
        const infer: NonNullable<InitApplicationAdapters['infer']> = async ({ repositories }) => ({
            facts: [{ fields: ['environment.generated', 'ports.bases'], target: `${repositories[0]!.slug}.container_ports`, value: [3000],
                provenance: { kind: 'inferred', source: 'app/Dockerfile', reason: 'the Dockerfile EXPOSEs this port' } }],
            skipped: [{ source: 'app/.github/workflows/ci.yml', reason: 'is not valid YAML' }],
        })
        const adapters: InitApplicationAdapters = { ...f.adapters, infer, classifyEstate: async ({ root }) => estate(root, 'one-sibling'),
            document: interviewDocument(f.destination, ['cockpit.name', 'sibling', 'ports.bases']) }
        const input = { ...f.input, registry: undefined }
        const preview = await runInitApplication(input, adapters)
        expect(preview).toMatchObject({ kind: 'pending', result: { stage: 'surface-previewed', interview: {
            answered: [], inferenceSkipped: [{ source: 'app/.github/workflows/ci.yml' }] } } })
        const planned = preview.result!.interview!.outstanding
        // The name is asked even when the directory name is a valid one: agents renamed cockpits by hand
        // afterwards, and a rename after sync is a migration, not an edit.
        expect(planned.map(row => row.field)).toEqual(['cockpit.name', 'sibling', 'ports.bases', 'environment.install_policies',
            'environment.test_data', 'environment.generated', 'environment.machine', 'environment.posture', 'testing', 'guards', 'configuration.defaults'])
        expect(planned.find(row => row.field === 'cockpit.name')!.inferred).toEqual([{ target: 'cockpit.name', value: 'checkout',
            provenance: { kind: 'inferred', source: f.root, reason: 'the cockpit root directory name' } }])
        expect(planned.find(row => row.field === 'ports.bases')!.inferred).toEqual([{ target: 'app.container_ports', value: [3000],
            provenance: { kind: 'inferred', source: 'app/Dockerfile', reason: 'the Dockerfile EXPOSEs this port' } }])
        expect(planned.find(row => row.field === 'sibling')!.inferred).toEqual([])
        expect(f.calls).not.toContain('apply')

        const accepted = { ...input, accepted: true, acceptedPreviewSha256: preview.result!.previewSha256 }
        const first = await runInitApplication(accepted, adapters)
        const named = await runInitApplication({ ...accepted, greenfieldAnswer: {
            questionId: first.result!.question!.id, bytes: '"shop"', provenance: 'operator-confirmed' } }, adapters)
        const second = await runInitApplication({ ...accepted, greenfieldAnswer: {
            questionId: named.result!.question!.id, bytes: '[]', provenance: 'operator-confirmed' } }, adapters)
        expect(second.result!.interview).toMatchObject({ answered: ['cockpit.name', 'sibling'] })
        expect(second.result!.interview!.outstanding.map(row => row.field)).toEqual(['ports.bases',
            'environment.install_policies', 'environment.test_data', 'environment.generated', 'environment.machine',
            'environment.posture', 'testing', 'guards', 'configuration.defaults'])
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
            expect(artifact.kind, JSON.stringify(artifact)).toBe('artifact')
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


it.each([false, true])('composes observed greenfield answers and surfaces review values (large purpose: %s)', async largePurpose => {
    const f = fixture()
    mkdirSync(join(f.root, 'app'))
    mkdirSync(join(f.root, 'fixtures'))
    const packageBytes = JSON.stringify({ scripts: { start: 'node server.mjs' } })
    await writeFile(join(f.root, 'app/package.json'), packageBytes)
    await writeFile(join(f.root, 'fixtures/personas.json'), '[{"id":"synthetic"}]\n')
    const sourceConfig = parseToml(await readFile(resolve('fixtures/registries/generated-environment.toml'), 'utf8')) as {
        sibling: Record<string, unknown>[]; ports: { bases: unknown }; environment: { install_policies: unknown; generated: unknown }
    }
    if (largePurpose) sourceConfig.sibling[0]!.purpose = 'p'.repeat(65_000)
    const synchronizeInputs: boolean[] = []
    let defaultsDocument: string | undefined
    const adapters: InitApplicationAdapters = {
        ...f.adapters,
        prepareBootstrap: prepareSelectedBootstrapSurface,
        resumeBootstrap: resumeSelectedBootstrapSurface,
        applyBootstrap: applySelectedBootstrapSurface,
        document: async input => {
            const outcome = await documentObservedCommand(input)
            if (outcome.question?.field === 'configuration.defaults') defaultsDocument = outcome.artifact ?? undefined
            return outcome
        },
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
        expect(count).toBeLessThan(11)
        const question = outcome.result.question
        if (question.field === 'configuration.defaults') {
            if (largePurpose) expect(Buffer.byteLength(defaultsDocument!)).toBeGreaterThan(65_536)
            expect(defaultsDocument).toContain('# [default] ')
            expect(defaultsDocument).toContain('# [inferred] ')
            expect(outcome).toMatchObject({ artifact: null, destination: null,
                result: { question: { document: defaultsDocument!.split('\n') } } })
            expect(question.document!.join('\n')).toBe(defaultsDocument)
            expect(existsSync(f.destination)).toBe(false)
            let interactiveReview = ''
            expect(await runCli(['init', f.root, '--target', 'codexcli', '--interactive'], {
                stdout: { write: () => true }, stderr: { write: () => true },
                answerInitQuestion: async current => {
                    interactiveReview = renderHumanValue(current)
                    return undefined
                },
            }, { init: () => runInitApplication(greenfieldInput, adapters) })).toBe(2)
            expect(interactiveReview).toContain(question.expectedSha256)
            expect(interactiveReview).toContain(sourceConfig.sibling[0]!.purpose)
            for (const line of defaultsDocument!.split('\n').filter(line => line.startsWith('# [default]') || line.startsWith('# [inferred]'))) {
                expect(interactiveReview).toContain(line)
            }
            for (const json of [false, true]) {
                let stdout = ''
                expect(await runCli(['init', f.root, '--target', 'codexcli', ...(json ? ['--json'] : [])], {
                    stdout: { write: value => { stdout += value; return true } },
                    stderr: { write: () => true },
                }, { init: () => runInitApplication(greenfieldInput, adapters) })).toBe(0)
                if (json) expect(JSON.parse(stdout).result.question.document.join('\n')).toBe(defaultsDocument)
                else {
                    expect(stdout).toContain(question.expectedSha256)
                    expect(stdout).toContain(sourceConfig.sibling[0]!.purpose)
                    for (const line of defaultsDocument!.split('\n').filter(line => line.startsWith('# [default]') || line.startsWith('# [inferred]'))) {
                        expect(stdout).toContain(line)
                    }
                }
            }
            expect(existsSync(f.destination)).toBe(false)
            expect(await runInitApplication({ ...accepted, greenfieldAnswer: {
                questionId: question.id, bytes: JSON.stringify({ confirmed: true, sha256: digest('0') }),
                provenance: 'operator-confirmed',
            } }, adapters)).toMatchObject({ kind: 'refusal', status: 2,
                diagnostics: expect.arrayContaining([{ severity: 'error', code: 'DOCUMENT_DEFAULT_CONFIRMATION_INVALID',
                    message: expect.any(String), target: 'configuration.defaults' }]) })
            expect(existsSync(f.destination)).toBe(false)
            if (largePurpose) return
        }
        const value = question.field === 'cockpit.name' ? 'checkout' : question.field === 'sibling' ? sourceConfig.sibling
            : question.field === 'ports.bases' ? sourceConfig.ports.bases
                : question.field === 'environment.install_policies' ? sourceConfig.environment.install_policies
                : question.field === 'environment.test_data' ? { seeded_data: false, signed_in_users: false }
                : question.field === 'environment.generated' ? sourceConfig.environment.generated
                : question.field === 'environment.machine'
                    ? { runtime_memory_mb: 2048, runtime_cpus: 2, free_disk_mb: 10240, cold_start_seconds: 120 }
                : question.field === 'environment.posture' ? { addressing: 'port', authentication: 'none', posture_requirements: [{ requirement: 'leased-localhost-ports', addressing: 'port' }] }
                : question.field === 'testing' ? 'none'
                : question.field === 'guards' ? { hosted_db_hosts: [], vendor_endpoint_hosts: [] }
                    : question.field === 'configuration.defaults'
                        ? { confirmed: true, sha256: question.expectedSha256 }
                        : undefined
        expect(value, question.field).toBeDefined()
        outcome = await runInitApplication({ ...accepted, greenfieldAnswer: {
            questionId: question.id, bytes: JSON.stringify(value), provenance: 'operator-confirmed',
        } }, adapters)
    }
    const artifact = outcome
    expect(artifact.kind, JSON.stringify(artifact)).toBe('artifact')
    expect(await loadCockpitConfig(f.destination)).toMatchObject({ kind: 'refusal' })
    await writeFile(join(f.root, 'app/package.json'), JSON.stringify({ scripts: { start: 'node changed.mjs' } }))
    expect(await runInitApplication(accepted, adapters)).toMatchObject({ kind: 'refusal', status: 2,
        diagnostics: [{ code: 'DOCUMENT_ESTATE_OBSERVATION_CHANGED' }] })
    await writeFile(join(f.root, 'app/package.json'), packageBytes)
    await writeFile(f.destination, artifact.artifact!)
    expect(await loadCockpitConfig(f.destination)).toMatchObject({ kind: 'complete', status: 0,
        result: { config: { cockpit: expect.not.objectContaining({ scope: expect.anything() }), environment: { generated: expect.any(Object) } } } })
    const completed = await runInitApplication(accepted, adapters)
    expect(completed, JSON.stringify(completed)).toMatchObject({ kind: 'complete', status: 0,
        result: { stage: 'environment-verified' } })
    expect(synchronizeInputs).toEqual([true])
}, 120_000)

// Sync writes the cockpit's package pin and scripts into the root package.json, editing the
// product's own manifest or creating one beside a Compose-only product.
it.each([
    ['its own package manifest', { name: 'synthetic-shop', scripts: { test: 'node test.mjs' } }],
    ['only a Compose file', undefined],
] as const)('resumes an in-repo init of a product with %s after sync wrote into it, and still refuses a product change', async (_shape, productManifest) => {
    const f = fixture()
    if (productManifest) await writeFile(join(f.root, 'package.json'), `${JSON.stringify(productManifest)}\n`)
    const composeBytes = 'services:\n  web:\n    image: synthetic.invalid/web:1\n    ports: ["127.0.0.1:${WEB_HOST_PORT:-4100}:80"]\n'
    await writeFile(join(f.root, 'compose.yml'), composeBytes)
    // The first bring-up has not happened yet, so preflight stops the run as it does on a fresh machine.
    let preflight: InitApplicationAdapters['preflight'] = async () => ({ kind: 'blocked', status: 2, result: null,
        diagnostics: [{ severity: 'error', code: 'STATE_UNSEEDED', message: 'synthetic: lifecycle is still in bootstrap' }] })
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
        // The production binding: sync also writes the cockpit's package pin and scripts.
        synchronize: input => syncTeamGeneratedEnvironment(input),
        preflight: input => preflight(input),
    }
    const input: InitApplicationInput = { root: f.root, target: f.input.target, accepted: false, sessionId: f.input.sessionId,
        platform: f.input.platform, home: f.input.home, xdgStateHome: f.input.xdgStateHome, cockpitRoot: { kind: 'in-repo' } }
    const preview = await runInitApplication(input, adapters)
    const accepted = { ...input, accepted: true, acceptedPreviewSha256: preview.result!.previewSha256 }
    let outcome = await runInitApplication(accepted, adapters)
    for (let count = 0; outcome.kind === 'pending' && outcome.result?.question; count += 1) {
        expect(count).toBeLessThan(11)
        const question = outcome.result.question
        const value = question.field === 'cockpit.name' ? 'synthetic-shop' : question.field === 'sibling'
            ? [{ slug: 'checkout', dir: '.', mount: 'none', acquire: 'none', var: 'CHECKOUT_DIR', purpose: 'Synthetic shop' }]
            : question.field === 'ports.bases' ? { WEB_HOST_PORT: 4100 }
                : question.field === 'environment.install_policies' ? []
                    : question.field === 'environment.test_data' ? { seeded_data: false, signed_in_users: false }
                        : question.field === 'environment.generated' ? { compose_files: ['compose.yml'] }
                            : question.field === 'environment.machine'
                                ? { runtime_memory_mb: 256, runtime_cpus: 1, free_disk_mb: 512, cold_start_seconds: 120 }
                                : question.field === 'environment.posture' ? { addressing: 'port', authentication: 'none', posture_requirements: [{ requirement: 'leased-localhost-ports', addressing: 'port' }] }
                                    : question.field === 'testing' ? 'none'
                                    : question.field === 'guards' ? { hosted_db_hosts: [], vendor_endpoint_hosts: [] }
                                        : question.field === 'configuration.defaults' ? { confirmed: true, sha256: question.expectedSha256 }
                                            : undefined
        expect(value, question.field).toBeDefined()
        // The setup agent was told to pick sensible defaults, and said which answers it picked.
        const provenance = question.field === 'environment.machine' || question.field === 'guards' ? 'agent-default' : 'operator-confirmed'
        outcome = await runInitApplication({ ...accepted, greenfieldAnswer: {
            questionId: question.id, bytes: JSON.stringify(value), provenance,
        } }, adapters)
    }
    expect(outcome.kind, JSON.stringify(outcome)).toBe('artifact')
    const drafted = parseToml(outcome.artifact!) as { cockpit: { name: string }; unconfirmed: string[] }
    expect(drafted.cockpit.name).toBe('synthetic-shop')
    // Values the agent chose are not recorded as the operator's: each says who chose it, and stays listed until a person confirms it.
    expect(drafted.unconfirmed).toEqual(['environment.machine', 'guards'])
    expect(outcome.artifact).toMatch(/^# Unconfirmed: environment\.machine was chosen by the setup agent as a default/m)
    expect(outcome.artifact).toContain('# Decision: guards: the setup agent assumed, as a default, that no non-local environment')
    expect(outcome.artifact).not.toContain('the operator stated that no non-local environment')
    expect(outcome.result).toMatchObject({ unconfirmed: [{ field: 'environment.machine', provenance: 'agent-default' },
        { field: 'guards', provenance: 'agent-default' }] })
    await writeFile(f.destination, outcome.artifact!)
    // A run that stops after the draft still names what no person confirmed, and which prerequisites
    // are missing: an agent sees only this last outcome. init ran from a copy of cockpit outside the root.
    const stopped = await runInitApplication(accepted, { ...adapters,
        inspectReadiness: input => inspectInitReadiness(input, { env: process.env, timeoutMs: 5_000, execute: executeProbe }) })
    // This fixture root is not a Git working tree either.
    expect(stopped).toMatchObject({ kind: 'refusal',
        diagnostics: [{ code: 'STATE_UNSEEDED' }, { code: 'COCKPIT_NOT_INSTALLED' }, { code: 'SETUP_PATH_TYPE_INVALID' }],
        result: { unconfirmed: [{ field: 'environment.machine' }, { field: 'guards' }],
            readiness: { state: 'runtime', gaps: [{ id: 'cockpit-git', level: 'required' }, { id: 'cockpit-installed', level: 'recommended' }] } } })
    expect(JSON.parse(await readFile(join(f.root, 'package.json'), 'utf8'))).toMatchObject({
        ...productManifest, scripts: { ...productManifest?.scripts, 'cockpit:sync': 'cockpit sync --config cockpit.toml' },
        devDependencies: { '@b0dea/cockpit': expect.any(String) } })

    // A product source changed after acceptance is still a different estate. Rerunning init alone
    // refuses again, so the remedy names both ways out.
    await writeFile(join(f.root, 'compose.yml'), composeBytes.replace('web:1', 'web:2'))
    for (let rerun = 0; rerun < 2; rerun += 1) expect(await runInitApplication(accepted, adapters)).toMatchObject({ kind: 'refusal',
        diagnostics: [{ code: 'DOCUMENT_ESTATE_OBSERVATION_CHANGED', fix: `restore the product files changed since init drafted cockpit.toml, then rerun ${initCommand({ root: f.root, target: f.input.target, args: `--accept-preview ${accepted.acceptedPreviewSha256}` })}; to keep the change instead, finish without init: run ${cockpitCommand('sync', { config: f.destination })}, then ${cockpitCommand('check', { config: f.destination })}` }] })
    await writeFile(join(f.root, 'compose.yml'), composeBytes)

    preflight = f.adapters.preflight
    const resumed = await runInitApplication(accepted, adapters)
    expect(resumed, JSON.stringify(resumed.diagnostics)).toMatchObject({ kind: 'complete', result: { stage: 'environment-verified',
        unconfirmed: [{ field: 'environment.machine' }, { field: 'guards' }] } })
}, 120_000)


it.each(['scalar', 'artifact'] as const)('refuses an unreviewable defaults draft before confirmation (%s bound)', async bound => {
    const f = fixture()
    mkdirSync(join(f.root, 'app'))
    mkdirSync(join(f.root, 'fixtures'))
    await writeFile(join(f.root, 'app/package.json'), JSON.stringify({ scripts: { start: 'node server.mjs' } }))
    await writeFile(join(f.root, 'fixtures/personas.json'), '[{"id":"synthetic"}]\n')
    const sourceConfig = parseToml(await readFile(resolve('fixtures/registries/generated-environment.toml'), 'utf8')) as {
        sibling: { purpose: string }[]; ports: { bases: Record<string, number> }; environment: {
            install_policies: { load_probe: string[] }[]; generated: { services: { command: string[] }[] }
        }
    }
    const guards = { hosted_db_hosts: [] as string[], vendor_endpoint_hosts: [] as string[] }
    if (bound === 'scalar') {
        sourceConfig.environment.install_policies[0]!.load_probe.push(...Array.from({ length: 14_000 }, () => 'a'))
    } else {
        sourceConfig.sibling[0]!.purpose = 'p'.repeat(60_000)
        sourceConfig.ports.bases['A'.repeat(60_000)] = 4101
        sourceConfig.environment.generated.services[0]!.command.push(...Array.from({ length: 5 }, () => 'a'.repeat(8_000)))
        sourceConfig.environment.install_policies[0]!.load_probe.push('a'.repeat(60_000))
        for (let index = 0; index < 128; index += 1) {
            const host = `${'a'.repeat(60)}.${'b'.repeat(60)}.${'c'.repeat(60)}.${index}.example.test`
            guards.hosted_db_hosts.push(`db.${host}`)
            guards.vendor_endpoint_hosts.push(`vendor.${host}`)
        }
    }
    let defaultsDocument: string | undefined
    const adapters: InitApplicationAdapters = {
        ...f.adapters,
        prepareBootstrap: prepareSelectedBootstrapSurface,
        resumeBootstrap: resumeSelectedBootstrapSurface,
        applyBootstrap: applySelectedBootstrapSurface,
        document: async input => {
            const outcome = await documentObservedCommand(input)
            if (outcome.question?.field === 'configuration.defaults') defaultsDocument = outcome.artifact ?? undefined
            return outcome
        },
        classifyEstate: input => classifyEstateObservation(input, { observe: observePublicEstate }),
    }
    const input = { ...f.input, registry: undefined }
    const preview = await runInitApplication(input, adapters)
    const accepted = { ...input, accepted: true, acceptedPreviewSha256: preview.result!.previewSha256 }
    let outcome = await runInitApplication(accepted, adapters)
    for (let count = 0; outcome.kind === 'pending' && outcome.result?.question
        && outcome.result.question.field !== 'configuration.defaults'; count += 1) {
        expect(count).toBeLessThan(10)
        const question = outcome.result.question
        const value = question.field === 'cockpit.name' ? 'checkout' : question.field === 'sibling' ? sourceConfig.sibling
            : question.field === 'ports.bases' ? sourceConfig.ports.bases
                : question.field === 'environment.install_policies' ? sourceConfig.environment.install_policies
                    : question.field === 'environment.test_data' ? { seeded_data: false, signed_in_users: false }
                        : question.field === 'environment.generated' ? sourceConfig.environment.generated
                            : question.field === 'environment.machine'
                                ? { runtime_memory_mb: 2048, runtime_cpus: 2, free_disk_mb: 10240, cold_start_seconds: 120 }
                                : question.field === 'environment.posture' ? { addressing: 'port', authentication: 'none', posture_requirements: [{ requirement: 'leased-localhost-ports', addressing: 'port' }] }
                                : question.field === 'testing' ? 'none'
                                : question.field === 'guards' ? guards : undefined
        expect(value, question.field).toBeDefined()
        const bytes = JSON.stringify(value)
        expect(Buffer.byteLength(bytes)).toBeLessThanOrEqual(65_536)
        outcome = await runInitApplication({ ...accepted, greenfieldAnswer: {
            questionId: question.id, bytes, provenance: 'operator-confirmed',
        } }, adapters)
    }
    expect(defaultsDocument, JSON.stringify(outcome)).toBeDefined()
    if (bound === 'scalar') {
        expect(Buffer.byteLength(defaultsDocument!)).toBeLessThan(262_144)
        expect(defaultsDocument!.split('\n').some(line => Buffer.byteLength(line) > 65_536)).toBe(true)
    } else {
        expect(Buffer.byteLength(defaultsDocument!)).toBeGreaterThan(262_144)
        expect(defaultsDocument!.split('\n').every(line => Buffer.byteLength(line) <= 65_536)).toBe(true)
    }
    expect(outcome).toMatchObject({ kind: 'refusal', status: 2, artifact: null, destination: null, result: null,
        diagnostics: [{ code: 'INIT_DRAFT_INVALID', message: expect.stringContaining('--reset-answer') }] })
    expect(existsSync(f.destination)).toBe(false)
    const selected = await selectBootstrapStateRoot({ platform: input.platform, home: input.home,
        xdgStateHome: input.xdgStateHome, checkoutRoot: input.root, target: input.target })
    if (selected.kind !== 'complete') throw new Error(JSON.stringify(selected))
    const saved = await readState(selected.value.paths.bootstrap(input.target))
    if (saved.kind !== 'complete') throw new Error(JSON.stringify(saved))
    expect(saved.value.value.greenfield!.questions.some(question => question.field === 'configuration.defaults')).toBe(false)
}, 120_000)
