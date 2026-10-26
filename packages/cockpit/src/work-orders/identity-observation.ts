import { createHash } from 'node:crypto'
import { isAbsolute, resolve } from 'node:path'

export const mechanism = {
    id: 'work-order-identity-observation',
    module: 'packages/cockpit/src/work-orders/identity-observation.ts',
    exports: ['observeWorkOrderIdentity'],
} as const

const MAX_REFS = 1_024
const MAX_WORKTREES = 256
const GIT_OBJECT_ID = /^(?=[a-f0-9]*[1-9a-f])(?:[a-f0-9]{40}|[a-f0-9]{64})$/

export type WorkOrderIdentityGitResult = Readonly<{
    kind: 'executed'
    exitCode: number | null
    stdout: string
    stderr: string
    truncated: boolean
}> | Readonly<{ kind: 'error' | 'unavailable'; reason: string }>

export type WorkOrderIdentityGit = (cwd: string, argv: readonly string[]) => Promise<WorkOrderIdentityGitResult>

export type WorkOrderIdentityObservation = Readonly<{
    id: string
    target: string
    digest: string
    commonDirectory: string
    claimedBy: 'ref' | 'worktree' | null
}>

function digest(value: string): string {
    return createHash('sha256').update(value).digest('hex')
}

function executed(result: WorkOrderIdentityGitResult, operation: string, exits: readonly number[] = [0]): Extract<WorkOrderIdentityGitResult, { kind: 'executed' }> {
    if (result.kind !== 'executed' || result.exitCode === null || !exits.includes(result.exitCode)
        || result.stderr || result.truncated) throw new Error(`work-order identity ${operation} is unavailable`)
    return result
}

function lines(value: string, operation: string): readonly string[] {
    if (!value.endsWith('\n')) throw new Error(`work-order identity ${operation} is malformed`)
    const rows = value.slice(0, -1).split('\n')
    if (rows.some(row => !row)) throw new Error(`work-order identity ${operation} is malformed`)
    return rows
}

function parseWorktrees(value: string): readonly Readonly<{ root: string; head: string; metadata: readonly string[] }>[] {
    if (!value.endsWith('\0\0')) throw new Error('work-order identity worktree inventory is malformed')
    const records = value.slice(0, -2).split('\0\0')
    if (!records.length || records.length > MAX_WORKTREES) throw new Error('work-order identity worktree inventory exceeds its bound')
    const roots = new Set<string>()
    return Object.freeze(records.map(record => {
        const fields = record.split('\0')
        const rootField = fields.shift()
        const headField = fields.shift()
        if (!rootField?.startsWith('worktree ') || !headField?.startsWith('HEAD ')) {
            throw new Error('work-order identity worktree inventory is malformed')
        }
        const root = rootField.slice('worktree '.length)
        const head = headField.slice('HEAD '.length)
        if (!root || root.includes('\0') || !isAbsolute(root) || resolve(root) !== root || Buffer.byteLength(root) > 4_096
            || !GIT_OBJECT_ID.test(head) || roots.has(root)
            || fields.length < 1 || fields.length > 2
            || !/^(?:branch refs\/heads\/[^\u0000-\u0020~^:?*\\[]+|detached)$/.test(fields[0]!)
            || fields[1] !== undefined && !/^(?:locked|prunable)(?: [^\u0000]*)?$/.test(fields[1])) {
            throw new Error('work-order identity worktree inventory is malformed')
        }
        roots.add(root)
        return Object.freeze({ root, head, metadata: Object.freeze(fields) })
    }))
}

export async function observeWorkOrderIdentity(input: Readonly<{
    root: string
    id: string
    executeGit: WorkOrderIdentityGit
}>): Promise<WorkOrderIdentityObservation> {
    if (!input || typeof input.root !== 'string' || !isAbsolute(input.root) || resolve(input.root) !== input.root
        || typeof input.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(input.id)
        || typeof input.executeGit !== 'function') throw new Error('work-order identity observation input is invalid')
    const target = `workorders/${input.id}.md`
    const commonResult = executed(await input.executeGit(input.root,
        ['rev-parse', '--path-format=absolute', '--git-common-dir']), 'common directory')
    const commonRows = lines(commonResult.stdout, 'common directory')
    const commonDirectory = commonRows.length === 1 ? commonRows[0]! : ''
    if (!commonDirectory || !isAbsolute(commonDirectory) || resolve(commonDirectory) !== commonDirectory
        || commonDirectory.includes('\0') || Buffer.byteLength(commonDirectory) > 4_096) {
        throw new Error('work-order identity common directory is malformed')
    }

    const refsResult = executed(await input.executeGit(input.root,
        ['for-each-ref', `--count=${String(MAX_REFS + 1)}`, '--format=%(objectname) %(refname)', 'refs/heads', 'refs/remotes']), 'ref inventory')
    const refs = (refsResult.stdout ? lines(refsResult.stdout, 'ref inventory') : []).map(row => {
        const separator = row.indexOf(' ')
        const object = row.slice(0, separator); const ref = row.slice(separator + 1)
        if (separator < 0 || !GIT_OBJECT_ID.test(object)
            || !/^refs\/(?:heads|remotes)\/[^\u0000-\u0020~^:?*\\[]+$/.test(ref)) {
            throw new Error('work-order identity ref inventory is malformed')
        }
        return Object.freeze({ object, ref })
    })
    if (refs.length > MAX_REFS || new Set(refs.map(row => row.ref)).size !== refs.length) {
        throw new Error('work-order identity ref inventory is malformed or exceeds its bound')
    }
    let claimedBy: WorkOrderIdentityObservation['claimedBy'] = null
    const refEvidence: Array<Readonly<{ object: string; target: string }>> = []
    for (const object of [...new Set(refs.map(row => row.object))].sort()) {
        const tree = executed(await input.executeGit(input.root, ['ls-tree', '-z', '--name-only', object, '--', target]), 'ref target')
        if (tree.stdout !== '' && tree.stdout !== `${target}\0`) throw new Error('work-order identity ref target is malformed')
        if (tree.stdout) claimedBy = 'ref'
        refEvidence.push(Object.freeze({ object, target: tree.stdout }))
    }

    const worktreeResult = executed(await input.executeGit(input.root, ['worktree', 'list', '--porcelain', '-z']), 'worktree inventory')
    const worktrees = parseWorktrees(worktreeResult.stdout)
    const worktreeEvidence: Array<Readonly<{ root: string; head: string; metadata: readonly string[]; tracked: string; status: string }>> = []
    for (const worktree of worktrees) {
        const tracked = executed(await input.executeGit(worktree.root, ['ls-files', '-z', '--', target]), 'worktree target')
        if (tracked.stdout !== '' && tracked.stdout !== `${target}\0`) throw new Error('work-order identity worktree target is malformed')
        const status = executed(await input.executeGit(worktree.root,
            ['status', '--porcelain=v2', '-z', '--untracked-files=all', '--ignored=matching', '--', target]), 'worktree status')
        if (status.stdout && !status.stdout.endsWith('\0')) throw new Error('work-order identity worktree status is malformed')
        if (tracked.stdout || status.stdout) claimedBy = 'worktree'
        worktreeEvidence.push(Object.freeze({ ...worktree, tracked: tracked.stdout, status: status.stdout }))
    }
    const evidence = JSON.stringify({ commonDirectory, refs, targets: refEvidence, worktrees: worktreeEvidence })
    return Object.freeze({ id: input.id, target, digest: digest(evidence), commonDirectory, claimedBy })
}
