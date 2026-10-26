import { posix } from 'node:path'
import { z } from 'zod'
import { snapshotJson } from '../environment/contract.js'

export const mechanism = {
    id: 'comparison-contract',
    module: 'packages/cockpit/src/comparison/contract.ts',
    exports: ['ADOPTION_LAYERS', 'COMPARISON_FORMAT', 'SHARED_COMPARISON_COMMANDS', 'parseComparisonFixture'],
} as const

export const COMPARISON_FORMAT = 'cockpit-comparison/v1' as const
export const SHARED_COMPARISON_COMMANDS = Object.freeze(['preflight', 'up', 'down', 'reset', 'doctor', 'logs', 'seed'] as const)
export const ADOPTION_LAYERS = Object.freeze(['registry', 'environment', 'surfaces', 'guards', 'grading'] as const)

const sha256 = /^[a-f0-9]{64}$/
const revision = /^[a-f0-9]{40}$/
const safeName = /^[a-z][a-z0-9-]{0,63}$/
const safeExecutable = /^[a-zA-Z0-9._/-]{1,256}$/
const safeText = z.string().min(1).max(1_024).refine(value => !/[\x00-\x1f\x7f-\x9f\uD800-\uDFFF]/u.test(value))
const relativePath = safeText.refine(value => !value.startsWith('/') && !value.includes('\\') && posix.normalize(value) === value
    && value.split('/').every(part => part !== '' && part !== '.' && part !== '..'))

const InputSchema = z.object({ path: relativePath, sha256: z.string().regex(sha256) }).strict()
const AdoptionSchema = z.object({
    layer: z.enum(ADOPTION_LAYERS),
    state: z.enum(['migrated', 'documented-only']),
}).strict()
const BindingSchema = z.object({
    command: z.string().regex(safeName),
    executable: z.string().regex(safeExecutable),
    argv: z.array(safeText).max(64),
    inputSha256s: z.array(z.string().regex(sha256)).min(1).max(256),
}).strict()
const PostStateSchema = z.object({ command: z.string().regex(safeName), observationSha256: z.string().regex(sha256) }).strict()
const ImplementationSchema = z.object({
    id: z.enum(['legacy', 'cockpit']),
    revision: z.string().regex(revision),
    bindings: z.array(BindingSchema).min(SHARED_COMPARISON_COMMANDS.length).max(128),
    postStates: z.array(PostStateSchema).min(SHARED_COMPARISON_COMMANDS.length).max(128),
}).strict()
const NormalizationSchema = z.object({
    kind: z.enum(['timestamp', 'absolute-path', 'port', 'duration-ms']),
    candidate: safeText,
}).strict()
function canonicalNormalizationCandidate(kind: z.infer<typeof NormalizationSchema>['kind'], candidate: string): boolean {
    if (kind === 'timestamp') {
        if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(candidate)) return false
        const parsed = new Date(candidate)
        return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === candidate
    }
    if (kind === 'absolute-path') {
        return candidate.startsWith('/') && candidate !== '/' && !candidate.endsWith('/') && !candidate.includes('\\')
            && posix.normalize(candidate) === candidate && candidate.split('/').every((part, index) => index === 0 || part !== '' && part !== '.' && part !== '..')
    }
    if (kind === 'port') {
        if (!/^[1-9]\d{0,4}$/.test(candidate)) return false
        const port = Number(candidate)
        return port >= 1_024 && port <= 65_535
    }
    return /^(?:0|[1-9]\d*)(?:\.\d{1,3})?ms$/.test(candidate)
}

const ComparisonFixtureSchema = z.object({
    format: z.literal(COMPARISON_FORMAT),
    fixtureId: z.string().regex(safeName),
    subject: z.object({
        revisions: z.object({ legacy: z.string().regex(revision), cockpit: z.string().regex(revision) }).strict(),
        packageIntegrity: z.string().regex(sha256),
        inputs: z.array(InputSchema).min(1).max(256),
    }).strict(),
    adoption: z.array(AdoptionSchema).length(ADOPTION_LAYERS.length),
    commands: z.object({
        shared: z.array(z.string().regex(safeName)).length(SHARED_COMPARISON_COMMANDS.length),
        extras: z.array(z.string().regex(safeName)).max(121),
    }).strict(),
    implementations: z.array(ImplementationSchema).length(2),
    normalization: z.array(NormalizationSchema).max(32),
}).strict().superRefine((fixture, context) => {
    const issue = (message: string, path: (string | number)[] = []) => context.addIssue({ code: 'custom', message, path })
    if (fixture.commands.shared.some((command, index) => command !== SHARED_COMPARISON_COMMANDS[index])) {
        issue('the shared command set is incomplete or out of order', ['commands', 'shared'])
    }
    const commands = [...fixture.commands.shared, ...fixture.commands.extras]
    if (new Set(commands).size !== commands.length) issue('comparison commands must be unique', ['commands'])
    const inputPaths = fixture.subject.inputs.map(input => input.path)
    const inputDigests = fixture.subject.inputs.map(input => input.sha256)
    if (new Set(inputPaths).size !== inputPaths.length) {
        issue('comparison input paths must be unique', ['subject', 'inputs'])
    }
    fixture.adoption.forEach((row, index) => {
        if (row.layer !== ADOPTION_LAYERS[index]) issue('adoption layers must use the required order', ['adoption', index])
    })
    if (fixture.implementations.map(row => row.id).join(',') !== 'legacy,cockpit') {
        issue('implementations must appear once in legacy, cockpit order', ['implementations'])
    }
    for (const [index, implementation] of fixture.implementations.entries()) {
        if (implementation.revision !== fixture.subject.revisions[implementation.id]) {
            issue('implementation revision does not match the frozen subject revision', ['implementations', index, 'revision'])
        }
        const bindingCommands = implementation.bindings.map(row => row.command)
        const postCommands = implementation.postStates.map(row => row.command)
        if (bindingCommands.length !== commands.length || bindingCommands.some((command, position) => command !== commands[position])) {
            issue('implementation bindings must cover every declared command exactly once in order', ['implementations', index, 'bindings'])
        }
        if (postCommands.length !== commands.length || postCommands.some((command, position) => command !== commands[position])) {
            issue('post-state observations must cover every declared command exactly once in order', ['implementations', index, 'postStates'])
        }
        implementation.bindings.forEach((binding, bindingIndex) => {
            if (binding.inputSha256s.length !== inputDigests.length
                || binding.inputSha256s.some((digest, position) => digest !== inputDigests[position])) {
                issue('command binding inputs do not match the frozen source inputs', ['implementations', index, 'bindings', bindingIndex, 'inputSha256s'])
            }
        })
    }
    const normalizationCandidates = fixture.normalization.map(rule => rule.candidate)
    if (new Set(normalizationCandidates).size !== normalizationCandidates.length) {
        issue('normalization candidates must be unique', ['normalization'])
    }
    fixture.normalization.forEach((rule, index) => {
        if (!canonicalNormalizationCandidate(rule.kind, rule.candidate)) {
            issue('normalization candidate does not match its declared bounded kind', ['normalization', index, 'candidate'])
        }
    })
})

export type ComparisonFixture = Readonly<z.infer<typeof ComparisonFixtureSchema>>
export type ComparisonFixtureResult =
    | Readonly<{ kind: 'complete'; fixture: ComparisonFixture }>
    | Readonly<{ kind: 'refusal'; code: 'COMPARISON_FIXTURE_INVALID'; message: string }>

function freeze<T>(value: T): T {
    if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
        for (const item of Object.values(value)) freeze(item)
        Object.freeze(value)
    }
    return value
}

export function parseComparisonFixture(input: unknown): ComparisonFixtureResult {
    const captured = snapshotJson(input)
    if (captured === undefined) {
        return Object.freeze({ kind: 'refusal', code: 'COMPARISON_FIXTURE_INVALID', message: 'comparison fixture is not bounded plain JSON' })
    }
    const parsed = ComparisonFixtureSchema.safeParse(captured)
    if (!parsed.success) {
        const first = parsed.error.issues[0]
        const location = first.path.length ? ` at ${first.path.join('.')}` : ''
        return Object.freeze({ kind: 'refusal', code: 'COMPARISON_FIXTURE_INVALID', message: `comparison fixture is invalid${location}: ${first.message}` })
    }
    return Object.freeze({ kind: 'complete', fixture: freeze(parsed.data) })
}
