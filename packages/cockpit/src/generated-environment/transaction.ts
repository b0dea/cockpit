import { createHash, randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdtemp, open, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { isProxy } from 'node:util/types'
import { isDeepStrictEqual } from 'node:util'

import type { Diagnostic } from '../diagnostics.js'
import { authenticatedExecutionOutcome, type ExecuteProbeOutcome } from '../environment-exec/execute.js'
import { fileFingerprint, recordVerifiedDigest, verifiedDigest } from '../environment-exec/verified-digest.js'
import { snapshotGeneratedJson, type ExecutionStep } from '../environment/contract.js'
import { resolvedGitExecutable, type ResolvedExecutable } from '../environment/executable.js'
import { installedPackageMetadata } from '../package-metadata.js'
import { parseOwnershipManifest, projectGeneratedPathFacts, classifyGeneratedPaths, removeSharedOwnership, renderSharedPostimage,
    type OwnershipAuthority, type OwnershipManifest, type GeneratedPathFact, type SurfaceDesiredEntry } from '../surfaces/ownership.js'
import { isInspectedBootstrapOutputs, type InspectedBootstrapOutputs } from '../surfaces/skill-contract.js'
import type { SurfaceChange } from '../surfaces/sync.js'

export const mechanism = {
    id: 'generated-publication-transaction',
    module: 'packages/cockpit/src/generated-environment/transaction.ts',
    exports: ['nodeAuthority', 'readAnchoredFile', 'readAnchoredEntry', 'readAnchoredBatches', 'relocateAnchoredFile', 'restoreAnchoredFile', 'readPersonaSource', 'expectedState', 'captureReferenceBootstrap', 'referenceBootstrapFiles', 'revalidateReferenceBootstrap', 'encodeReferenceManifest', 'admitPublicationPlan', 'runPublicationPlan'],
} as const

export interface PublicationAdapters {
    readonly execute: (step: ExecutionStep) => Promise<ExecuteProbeOutcome>
    readonly authorizeStaleRemoval?: (request: GeneratedStaleRemovalApprovalRequest) => Promise<GeneratedStaleRemovalApproval | undefined>
}

interface OwnedBytes { readonly path: string; readonly bytes: string; readonly sha256: string }
interface PublicationChange { readonly operation: 'write' | 'remove'; readonly path: string }
export interface PublicationRefusal {
    readonly kind: 'refusal'
    readonly artifact: null
    readonly destination: null
    readonly result: null
    readonly status: 2
    readonly diagnostics: readonly Diagnostic[]
}
export interface GeneratedStaleRemovalApprovalEntry {
    readonly path: string
    readonly operation: 'write-file' | 'remove-file' | 'remove-symlink'
    readonly current: Readonly<{
        readonly kind: 'file' | 'symlink'
        readonly sha256?: string
        readonly target?: string
        readonly dev: number
        readonly ino: number
    }>
    readonly resultSha256?: string
}

export interface GeneratedStaleRemovalApprovalRequest {
    readonly format: 'cockpit-stale-removal-request/v1'
    readonly cockpitId: string
    readonly generation: string
    readonly sourceSha256: string
    readonly entries: readonly GeneratedStaleRemovalApprovalEntry[]
    readonly digest: string
}

export interface GeneratedStaleRemovalApproval {
    readonly format: 'cockpit-stale-removal-approval/v1'
    readonly digest: string
}

export interface DirectoryIdentity {
    readonly dev: number
    readonly ino: number
}

export interface PersonaSourceIdentity {
    readonly root: DirectoryIdentity
    readonly chain: readonly DirectoryIdentity[]
    readonly file: DirectoryIdentity
}

const SHA256 = /^[a-f0-9]{64}$/
const OWNERSHIP_PATH = '.cockpit/generated-environment-ownership.json'
const REFERENCE_OWNERSHIP_PATH = '.cockpit/generated-reference-ownership.json'
const REFERENCE_FILE_PATHS = Object.freeze([
    'docs/cli-reference.md',
    'docs/configuration-reference.md',
    'docs/command-list.md',
    'docs/capability-matrix.md',
    'skills/adopt-cockpit/SKILL.md',
] as const)
const TROUBLESHOOTING_PATH = 'docs/troubleshooting.md'
const REFERENCE_PATHS = Object.freeze([...REFERENCE_FILE_PATHS, TROUBLESHOOTING_PATH] as const)
const TROUBLESHOOTING_BEGIN = '<!-- cockpit:diagnostic-index:begin -->'
const TROUBLESHOOTING_END = '<!-- cockpit:diagnostic-index:end -->'
const MAX_OWNERSHIP_BYTES = 1_048_576
const MAX_OWNED_FILES = 256
const MAX_EXECUTABLE_BYTES = 536_870_912
const MAX_GENERATED_BYTES = 16_777_216
const MAX_HELPER_FRAME_BYTES = 65_536
const HELPER_TIMEOUT_MS = 10_000
const MAX_AUTHENTICATED_READ_BATCH = 64
const MAX_AUTHENTICATED_READ_BATCH_BYTES = 67_108_864
const MAX_AUTHENTICATED_READ_BATCH_RECEIPT_BYTES = MAX_HELPER_FRAME_BYTES * (MAX_AUTHENTICATED_READ_BATCH + 1)
const MAX_PUBLICATION_BATCH_GROUPS = 8
const TRANSACTION_TIMEOUT_MS = 180_000
// Reserve the final deadline slots so forward work cannot consume rollback's budget.
const PUBLICATION_HELPER_SLOT_MS = 500
const PUBLICATION_HELPER_CALLS_PER_GROUP = 6
const compareCodeUnits = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0
function sha256(value: string | Uint8Array): string {
    return createHash('sha256').update(value).digest('hex')
}

function ownRecord(value: unknown): Record<string, unknown> | undefined {
    try {
        if (value === null || typeof value !== 'object' || Array.isArray(value) || isProxy(value)
            || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return undefined
        const descriptors = Object.getOwnPropertyDescriptors(value)
        if (Object.getOwnPropertySymbols(value).length > 0
            || Object.values(descriptors).some((descriptor) => descriptor.get || descriptor.set || !descriptor.enumerable)) return undefined
        return Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]))
    } catch {
        return undefined
    }
}

function exactKeys(record: Record<string, unknown>, expected: readonly string[]): boolean {
    const keys = Object.keys(record).sort()
    const wanted = [...expected].sort()
    return keys.length === wanted.length && keys.every((key, index) => key === wanted[index])
}

function refuse(code: string, message: string, target?: string, fix?: string): PublicationRefusal {
    return Object.freeze({
        kind: 'refusal', artifact: null, destination: null, result: null, status: 2,
        diagnostics: Object.freeze([{ severity: 'error' as const, code, message, target, fix }]),
    })
}

declare const referenceBootstrapBrand: unique symbol
export type ReferenceBootstrap = Readonly<{ readonly [referenceBootstrapBrand]: true }>

export interface ReferenceBootstrapFile {
    readonly path: typeof REFERENCE_PATHS[number]
    readonly mode: '100644' | '100755'
    readonly oid: string
    readonly bytes: Buffer
    readonly sha256: string
}

interface ReferenceBootstrapRecord {
    readonly root: string
    readonly git: ResolvedExecutable
    readonly objectFormat: 'sha1' | 'sha256'
    readonly head: string
    readonly rows: string
    readonly files: readonly Readonly<Omit<ReferenceBootstrapFile, 'bytes'> & { bytes: Buffer }>[]
}

const referenceBootstraps = new WeakMap<object, ReferenceBootstrapRecord>()

function gitStep(root: string, git: ResolvedExecutable, argv: readonly string[], label: string, stdoutLimitBytes: number, deadline?: number): ExecutionStep | undefined {
    const now = Date.now()
    const stop = Math.min(deadline ?? now + HELPER_TIMEOUT_MS, now + HELPER_TIMEOUT_MS)
    if (stop <= now || stdoutLimitBytes < 1 || stdoutLimitBytes > MAX_AUTHENTICATED_READ_BATCH_BYTES) return undefined
    return Object.freeze({
        id: `reference-bootstrap-${label}-${randomBytes(8).toString('hex')}`,
        argv: Object.freeze([git.canonicalPath, ...argv]) as readonly [string, ...string[]],
        argv0: git.invocationPath,
        cwd: root,
        env: Object.freeze({}),
        timeoutMs: stop - now,
        spawnNotAfter: new Date(stop).toISOString(),
        stdoutLimitBytes,
        stderrLimitBytes: 16_384,
        paths: Object.freeze([root]),
        ports: Object.freeze([]),
        labels: Object.freeze({ action: 'reference-bootstrap', operation: label }),
        expected: Object.freeze([]),
        consumedFiles: Object.freeze([Object.freeze({
            path: git.canonicalPath, sha256: git.sha256, maxBytes: MAX_EXECUTABLE_BYTES,
            argvIndexes: Object.freeze([0]), executable: true as const, executionMode: git.executionMode,
        })]),
        filesystemChecks: Object.freeze([Object.freeze({ path: root, expected: 'directory' as const })]),
        compensation: Object.freeze([]),
    })
}

async function runGit(root: string, git: ResolvedExecutable, argv: readonly string[], label: string, limit: number, adapters: PublicationAdapters, deadline?: number): Promise<Buffer | undefined> {
    const step = gitStep(root, git, argv, label, limit, deadline)
    if (!step) return undefined
    try {
        const outcome = authenticatedExecutionOutcome(await adapters.execute(step), step)
        return outcome?.kind === 'complete' && outcome.stderr.byteLength === 0 ? Buffer.from(outcome.stdout) : undefined
    } catch {
        return undefined
    }
}

async function referenceGitState(root: string, git: ResolvedExecutable, adapters: PublicationAdapters, deadline?: number): Promise<Readonly<{
    objectFormat: 'sha1' | 'sha256'; head: string; rows: string; parsed: readonly Readonly<{ mode: '100644' | '100755'; oid: string; path: typeof REFERENCE_PATHS[number] }>[]
}> | undefined> {
    if (!isAbsolute(root) || !resolvedGitExecutable(git)) return undefined
    const formatBytes = await runGit(root, git, ['rev-parse', '--show-object-format'], 'object-format', 32, adapters, deadline)
    const objectFormat = formatBytes?.toString('utf8').trim()
    if (objectFormat !== 'sha1' && objectFormat !== 'sha256') return undefined
    const oidPattern = objectFormat === 'sha1' ? /^[a-f0-9]{40}$/ : /^[a-f0-9]{64}$/
    const headBytes = await runGit(root, git, ['rev-parse', '--verify', 'HEAD^{commit}'], 'head', 80, adapters, deadline)
    const head = headBytes?.toString('utf8').trim()
    if (!head || !oidPattern.test(head)) return undefined
    const listing = await runGit(root, git, ['ls-tree', '-z', head, '--', ...REFERENCE_PATHS], 'committed-reference-estate', 4096, adapters, deadline)
    if (!listing) return undefined
    let text: string
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(listing) } catch { return undefined }
    if (!text.endsWith('\0')) return undefined
    const records = text.split('\0')
    records.pop()
    if (records.some(raw => raw === '')) return undefined
    const parsed: Array<Readonly<{ mode: '100644' | '100755'; oid: string; path: typeof REFERENCE_PATHS[number] }>> = []
    const seen = new Set<string>()
    for (const raw of records) {
        const match = /^(100644|100755) blob ([a-f0-9]+)\t([^\0\r\n]+)$/.exec(raw)
        if (!match || !oidPattern.test(match[2]!) || !REFERENCE_PATHS.includes(match[3] as typeof REFERENCE_PATHS[number]) || seen.has(match[3]!)) return undefined
        seen.add(match[3]!)
        parsed.push(Object.freeze({ mode: match[1] as '100644' | '100755', oid: match[2]!, path: match[3] as typeof REFERENCE_PATHS[number] }))
    }
    if (!seen.has(TROUBLESHOOTING_PATH)) return undefined
    parsed.sort((left, right) => compareCodeUnits(left.path, right.path))
    const rows = parsed.map(row => `${row.mode} ${row.oid} 0\t${row.path}\0`).join('')
    return Object.freeze({ objectFormat, head, rows, parsed: Object.freeze(parsed) })
}

/** Capture immutable Git objects for the fixed maintainer reference estate. */
export async function captureReferenceBootstrap(root: string, git: ResolvedExecutable, adapters: PublicationAdapters): Promise<PublicationRefusal | Readonly<{ kind: 'complete'; bootstrap: ReferenceBootstrap }>> {
    const trustedGit = resolvedGitExecutable(git)
    const state = trustedGit && await referenceGitState(root, trustedGit, adapters)
    if (!state) return refuse('GENERATED_REFERENCE_BOOTSTRAP_INVALID', 'reference bootstrap could not authenticate the fixed committed Git estate', 'references')
    const blobs = new Map<string, Buffer>()
    let aggregateBytes = 0
    for (const oid of [...new Set(state.parsed.map(row => row.oid))]) {
        const bytes = await runGit(root, trustedGit, ['cat-file', 'blob', oid], 'blob', MAX_GENERATED_BYTES, adapters)
        aggregateBytes += bytes?.byteLength ?? MAX_AUTHENTICATED_READ_BATCH_BYTES + 1
        if (!bytes || bytes.byteLength > MAX_GENERATED_BYTES || aggregateBytes > MAX_AUTHENTICATED_READ_BATCH_BYTES) return refuse('GENERATED_REFERENCE_BOOTSTRAP_INVALID', 'reference bootstrap could not read a bounded immutable Git blob set', oid)
        const header = Buffer.from(`blob ${bytes.byteLength}\0`)
        const actual = createHash(state.objectFormat).update(header).update(bytes).digest('hex')
        if (actual !== oid) return refuse('GENERATED_REFERENCE_BOOTSTRAP_INVALID', 'reference bootstrap blob did not match its captured object id', oid)
        blobs.set(oid, bytes)
    }
    const rechecked = await referenceGitState(root, trustedGit, adapters)
    if (!rechecked || rechecked.objectFormat !== state.objectFormat || rechecked.head !== state.head || rechecked.rows !== state.rows) {
        return refuse('GENERATED_REFERENCE_BOOTSTRAP_INVALID', 'reference Git rows changed while immutable blobs were captured', 'references')
    }
    const files = Object.freeze(state.parsed.map(row => Object.freeze({ ...row, bytes: Buffer.from(blobs.get(row.oid)!), sha256: sha256(blobs.get(row.oid)!) })))
    const bootstrap = Object.freeze({}) as ReferenceBootstrap
    referenceBootstraps.set(bootstrap, Object.freeze({ root, git: trustedGit, objectFormat: state.objectFormat, head: state.head, rows: state.rows, files }))
    return Object.freeze({ kind: 'complete', bootstrap })
}

export function referenceBootstrapFiles(bootstrap: ReferenceBootstrap): readonly ReferenceBootstrapFile[] | undefined {
    const record = bootstrap && referenceBootstraps.get(bootstrap)
    return record && Object.freeze(record.files.map(row => Object.freeze({ ...row, bytes: Buffer.from(row.bytes) })))
}

export async function revalidateReferenceBootstrap(bootstrap: ReferenceBootstrap, adapters: PublicationAdapters, deadline?: number): Promise<boolean> {
    const record = bootstrap && referenceBootstraps.get(bootstrap)
    if (!record) return false
    const current = await referenceGitState(record.root, record.git, adapters, deadline)
    return !!current && current.objectFormat === record.objectFormat && current.head === record.head && current.rows === record.rows
}

function confined(root: string, path: string): string | undefined {
    if (typeof path !== 'string' || path.length === 0 || path.includes('\0') || isAbsolute(path)) return undefined
    const target = resolve(root, path)
    const offset = relative(root, target)
    return offset !== '' && offset !== '..' && !offset.startsWith(`..${sep}`) && !isAbsolute(offset) ? target : undefined
}

const FILESYSTEM_HELPER = String.raw`
const fs = require("node:fs");
const crypto = require("node:crypto");
const path = require("node:path");
const c = fs.constants;
const limit = 16777216;
const request = JSON.parse(process.argv[1]);
const name = value => {
  if (typeof value !== "string" || value.length === 0 || value.length > 255 || /[<>:"/\\|?*\x00-\x1f\x7f]/.test(value) || /[. ]$/.test(value) || /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(value)) throw new Error("nonportable-name");
  return value;
};
const safeSegments = value => {
  if (!Array.isArray(value)) throw new Error("segments");
  return value.map(name);
};
const same = (actual, expected) => actual.isDirectory() && !actual.isSymbolicLink() && actual.dev === expected.dev && actual.ino === expected.ino;
const identity = () => { const value = fs.lstatSync("."); if (!same(value, request.identity)) throw new Error("identity"); return value; };
const currentDirectory = () => { const value = fs.lstatSync("."); if (!value.isDirectory() || value.isSymbolicLink()) throw new Error("directory"); return value; };
const syncDirectory = () => { const fd = fs.openSync(".", c.O_RDONLY); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } };
const digest = value => crypto.createHash("sha256").update(value).digest("hex");
const readLimit = value => {
  if (!Number.isSafeInteger(value) || value < 1 || value > limit) throw new Error("limit");
  return value;
};
const read = (path, maxBytes = limit, expected) => {
  maxBytes = readLimit(maxBytes);
  if (c.O_NOFOLLOW === undefined) throw new Error("no-follow");
  const fd = fs.openSync(path, c.O_RDONLY | c.O_NOFOLLOW | c.O_NONBLOCK);
  try {
    const status = fs.fstatSync(fd);
    if (!status.isFile() || status.size > maxBytes || expected && (status.dev !== expected.dev || status.ino !== expected.ino)) throw new Error("file");
    const chunks = []; let total = 0; const chunk = Buffer.allocUnsafe(65536);
    while (true) {
      const length = fs.readSync(fd, chunk, 0, Math.min(chunk.length, maxBytes - total + 1), null);
      if (length === 0) break;
      total += length; if (total > maxBytes) throw new Error("limit");
      chunks.push(Buffer.from(chunk.subarray(0, length)));
    }
    const after = fs.fstatSync(fd);
    if (total !== status.size || after.dev !== status.dev || after.ino !== status.ino || after.size !== status.size || after.mtimeMs !== status.mtimeMs || after.ctimeMs !== status.ctimeMs) throw new Error("changed");
    return { bytes: Buffer.concat(chunks, total), status };
  }
  finally { fs.closeSync(fd); }
};
const copy = (source, target, expected) => {
  const value = read(source); if (digest(value.bytes) !== expected) throw new Error("digest");
  const fd = fs.openSync(name(target), c.O_WRONLY | c.O_CREAT | c.O_EXCL | (c.O_NOFOLLOW || 0), 0o600);
  try { fs.writeFileSync(fd, value.bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
};
const hash = path => digest(read(name(path)).bytes);
const walk = (segments, chain = []) => {
  for (const raw of segments) {
    const segment = name(raw); let created = false; let before;
    try { before = fs.lstatSync(segment); }
    catch (error) { if (error.code !== "ENOENT") throw error; fs.mkdirSync(segment, { mode: 0o700 }); syncDirectory(); created = true; before = fs.lstatSync(segment); }
    if (!before.isDirectory() || before.isSymbolicLink()) throw new Error("directory");
    process.chdir(segment); const after = fs.lstatSync(".");
    if (after.dev !== before.dev || after.ino !== before.ino || !after.isDirectory() || after.isSymbolicLink()) throw new Error("walk");
    chain.push({ name: segment, dev: after.dev, ino: after.ino, created });
  }
  return chain;
};
const walkMissing = (segments, chain = []) => {
  for (const raw of segments) {
    const segment = name(raw);
    try { fs.lstatSync(segment); throw new Error("expected-missing"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    fs.mkdirSync(segment, { mode: 0o700 });
    const after = fs.lstatSync(segment); if (!after.isDirectory() || after.isSymbolicLink()) throw new Error("created-directory");
    chain.push({ name: segment, dev: after.dev, ino: after.ino, created: true }); syncDirectory();
    process.chdir(segment); const current = fs.lstatSync("."); if (!same(current, after)) throw new Error("created-walk");
  }
  return chain;
};
const walkNested = (expected, segments, created, chain) => {
  chain.push(...walkExpected(expected)); const names = chain.map(entry => entry.name);
  for (const raw of segments) {
    const segment = name(raw); names.push(segment); const key = names.join("/"); let before; let owned = false;
    try {
      before = fs.lstatSync(segment); const issued = created.get(key);
      if (!issued || !same(before, issued)) throw new Error("unexpected-directory");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      fs.mkdirSync(segment, { mode: 0o700 }); before = fs.lstatSync(segment); owned = true;
      if (!before.isDirectory() || before.isSymbolicLink()) throw new Error("created-directory");
      created.set(key, { dev: before.dev, ino: before.ino });
      chain.push({ name: segment, dev: before.dev, ino: before.ino, created: true }); syncDirectory();
    }
    if (!before.isDirectory() || before.isSymbolicLink()) throw new Error("nested-directory");
    if (!owned) chain.push({ name: segment, dev: before.dev, ino: before.ino, created: false });
    process.chdir(segment); const after = fs.lstatSync("."); if (!same(after, before)) throw new Error("nested-walk");
  }
  return chain;
};
const walkSource = (segments, chain = []) => {
  for (const raw of segments) {
    const segment = name(raw); const before = fs.lstatSync(segment);
    if (!before.isDirectory() || before.isSymbolicLink()) throw new Error("directory");
    process.chdir(segment); const after = fs.lstatSync(".");
    if (!same(after, before)) throw new Error("walk");
    chain.push({ name: segment, dev: after.dev, ino: after.ino });
  }
  return chain;
};
const walkExpected = chain => {
  const walked = [];
  for (const expected of chain) {
    const segment = name(expected.name); const before = fs.lstatSync(segment);
    if (!same(before, expected)) throw new Error("directory-identity");
    process.chdir(segment); const after = fs.lstatSync(".");
    if (!same(after, expected)) throw new Error("walk-identity");
    walked.push({ name: segment, dev: after.dev, ino: after.ino, created: false });
  }
  return walked;
};
const verifySourceChain = (chain, start = request.identity) => {
  for (let index = chain.length - 1; index >= 0; index--) {
    process.chdir("..");
    const parent = fs.lstatSync("."); const expected = index === 0 ? start : chain[index - 1];
    if (!same(parent, expected)) throw new Error("parent-identity");
    const child = fs.lstatSync(name(chain[index].name));
    if (!same(child, chain[index])) throw new Error("child-identity");
  }
  const current = fs.lstatSync("."); if (!same(current, start)) throw new Error("start-identity");
};
const removeCreatedChain = (chain, start) => {
  for (let index = chain.length - 1; index >= 0; index--) {
    process.chdir("..");
    const parent = fs.lstatSync("."); const expected = index === 0 ? start : chain[index - 1];
    if (!same(parent, expected)) throw new Error("parent-identity");
    const child = fs.lstatSync(name(chain[index].name));
    if (!same(child, chain[index])) throw new Error("child-identity");
    if (chain[index].created) { try { fs.rmdirSync(name(chain[index].name)); syncDirectory(); } catch (error) { if (error.code !== "ENOTEMPTY") throw error; } }
  }
  const current = fs.lstatSync("."); if (!same(current, start)) throw new Error("start-identity");
};
const removeCreatedDirectories = (entries, start) => {
  const base = process.cwd(); const created = new Map();
  for (const entry of entries) {
    const names = [];
    for (const [index, directory] of entry.chain.entries()) {
      names.push(directory.name);
      if (directory.created) created.set(names.join("/"), entry.chain.slice(0, index + 1));
    }
  }
  const chains = [...created.values()].sort((left, right) => right.length - left.length);
  for (const chain of chains) {
    process.chdir(base); const parents = walkExpected(chain.slice(0, -1)); const child = chain[chain.length - 1];
    const current = fs.lstatSync(name(child.name)); if (!same(current, child)) throw new Error("created-identity");
    try { fs.rmdirSync(name(child.name)); syncDirectory(); } catch (error) { if (error.code !== "ENOTEMPTY") throw error; }
    verifySourceChain(parents, start);
  }
  process.chdir(base); const current = fs.lstatSync("."); if (!same(current, start)) throw new Error("start-identity");
};
const state = target => {
  try {
    const status = fs.lstatSync(target);
    if (status.isSymbolicLink()) return { kind: "symlink", target: fs.readlinkSync(target), identity: { dev: status.dev, ino: status.ino } };
    if (status.isFile()) return { kind: "file", sha256: hash(target), mode: status.mode & 511, identity: { dev: status.dev, ino: status.ino } };
    return { kind: "other" };
  } catch (error) { if (error.code === "ENOENT") return { kind: "missing" }; throw error; }
};
const matches = (actual, expected) => actual.kind === expected.kind
  && (actual.kind !== "file" || actual.sha256 === expected.sha256)
  && (actual.kind !== "file" || expected.mode === undefined || actual.mode === expected.mode)
  && (actual.kind !== "symlink" || actual.target === expected.target)
  && (actual.kind === "missing" || !expected.identity || actual.identity.dev === expected.identity.dev && actual.identity.ino === expected.identity.ino);
const publishEntries = (entries, start = currentDirectory()) => {
  for (const entry of entries) {
    const chain = walkExpected(entry.chain);
    name(entry.name); if (!matches(state(entry.name), { kind: entry.priorKind, sha256: entry.priorSha256, target: entry.priorTarget, mode: entry.priorMode, identity: entry.priorIdentity })) throw new Error("prior-state");
    if (entry.backup !== null && hash(entry.backup) !== entry.priorSha256) throw new Error("backup-digest");
    if (entry.operation === "write-file") { name(entry.stage); if (hash(entry.stage) !== entry.sha256) throw new Error("stage-digest"); fs.renameSync(entry.stage, entry.name); }
    else if (entry.operation === "write-symlink") { name(entry.stage); if (fs.readlinkSync(entry.stage) !== entry.target) throw new Error("stage-target"); fs.renameSync(entry.stage, entry.name); }
    else fs.unlinkSync(entry.name);
    syncDirectory();
    verifySourceChain(chain, start);
  }
};
const validateEntries = (entries, start = currentDirectory()) => {
  for (const entry of entries) {
    const chain = walkExpected(entry.chain);
    name(entry.name);
    if (!matches(state(entry.name), { kind: entry.priorKind, sha256: entry.priorSha256, target: entry.priorTarget, mode: entry.priorMode, identity: entry.priorIdentity })) throw new Error("prior-state");
    if (entry.backup !== null && hash(entry.backup) !== entry.priorSha256) throw new Error("backup-digest");
    if (entry.operation === "write-file" && hash(name(entry.stage)) !== entry.sha256) throw new Error("stage-digest");
    if (entry.operation === "write-symlink" && fs.readlinkSync(name(entry.stage)) !== entry.target) throw new Error("stage-target");
    verifySourceChain(chain, start);
  }
};
const verifyEntries = (entries, start = currentDirectory()) => {
  for (const entry of entries) {
    const chain = walkExpected(entry.chain);
    name(entry.name); const expected = entry.operation === "write-file" ? { kind: "file", sha256: entry.sha256 }
      : entry.operation === "write-symlink" ? { kind: "symlink", target: entry.target } : { kind: "missing" };
    if (!matches(state(entry.name), expected)) throw new Error("target-state");
    if (entry.backup !== null && hash(entry.backup) !== entry.priorSha256) throw new Error("backup-digest");
    verifySourceChain(chain, start);
  }
};
const respond = value => process.stdout.write(JSON.stringify({ version: 1, nonce: request.nonce, action: request.action, ...value }) + "\n");
const readSource = entry => {
  const chain = []; let before; const filename = name(entry.name);
  try { walkSource(entry.segments, chain); before = fs.lstatSync(filename); }
  catch (error) { if (entry.action !== "read-persona" && error.code === "ENOENT") { verifySourceChain(chain); return { kind: "missing" }; } throw error; }
  if (entry.action === "read-entry" && before.isSymbolicLink()) {
    const target = fs.readlinkSync(filename); const current = fs.lstatSync(filename);
    if (!current.isSymbolicLink() || current.dev !== before.dev || current.ino !== before.ino) throw new Error("source-changed");
    verifySourceChain(chain); return { kind: "symlink", target, identity: { dev: before.dev, ino: before.ino } };
  }
  if (entry.action === "read-entry" && !before.isFile()) { verifySourceChain(chain); return { kind: "other" }; }
  if (!before.isFile() || before.isSymbolicLink()) throw new Error("source");
  const value = read(filename, entry.maxBytes);
  if (value.status.dev !== before.dev || value.status.ino !== before.ino) throw new Error("source-identity");
  const current = fs.lstatSync(filename);
  if (!current.isFile() || current.isSymbolicLink() || current.dev !== before.dev || current.ino !== before.ino) throw new Error("source-changed");
  verifySourceChain(chain);
  const output = fs.openSync(entry.output, c.O_WRONLY | c.O_CREAT | c.O_EXCL | c.O_NOFOLLOW, 0o600);
  try { fs.writeFileSync(output, value.bytes); } finally { fs.closeSync(output); }
  return { kind: entry.action === "read-entry" ? "file" : "complete", identity: { root: request.identity, chain: chain.map(({ dev, ino }) => ({ dev, ino })), file: { dev: before.dev, ino: before.ino } }, ...(entry.action === "read-entry" ? { mode: before.mode & 511 } : {}), sha256: digest(value.bytes) };
};
try {
  identity();
  if (request.action === "read-batch") {
    if (!Array.isArray(request.entries) || request.entries.length < 1 || request.entries.length > ${MAX_AUTHENTICATED_READ_BATCH}) throw new Error("batch");
    const requestedBytes = request.entries.reduce((total, entry) => total + readLimit(entry.maxBytes), 0);
    if (!Number.isSafeInteger(requestedBytes) || requestedBytes > 67108864) throw new Error("batch-limit");
    const entries = [];
    for (const entry of request.entries) {
      if (!entry || typeof entry !== "object" || typeof entry.nonce !== "string"
        || !["read-persona", "read-file", "read-entry"].includes(entry.action)) throw new Error("batch-entry");
      try {
        const result = readSource(entry);
        if (Buffer.byteLength(JSON.stringify({ version: 1, nonce: entry.nonce, action: entry.action, ...result }) + "\n") > 65536) throw new Error("entry-frame");
        entries.push({ nonce: entry.nonce, action: entry.action, segments: entry.segments, name: entry.name, maxBytes: entry.maxBytes, ...result });
      }
      catch { respond({ kind: "refusal", failedNonce: entry.nonce }); process.exit(0); }
    }
    const receipt = Buffer.from(JSON.stringify({ version: 1, nonce: request.nonce, action: request.action, kind: "complete", entries }) + "\n");
    if (receipt.length > ${MAX_AUTHENTICATED_READ_BATCH_RECEIPT_BYTES}) throw new Error("receipt-limit");
    const output = fs.openSync(request.receiptOutput, c.O_WRONLY | c.O_CREAT | c.O_EXCL | c.O_NOFOLLOW, 0o600);
    try { fs.writeFileSync(output, receipt); } finally { fs.closeSync(output); }
    respond({ kind: "complete", receiptBytes: receipt.length, receiptSha256: digest(receipt) });
  } else if (request.action === "read-persona" || request.action === "read-file" || request.action === "read-entry") {
    respond(readSource(request));
  } else if (request.action === "relocate-file") {
    const base = process.cwd(); const destinationChain = []; const sourceCapture = name(".cockpit-adopt-source-" + request.nonce); const destinationCapture = name(".cockpit-adopt-destination-" + request.nonce);
    let sourceCapturePath; let sourceMode; let sourceCaptured = false; let sourceRestored = false; let originalRetired = false; let destinationCreated = false; let destinationQuarantined = false; let destinationIdentity;
    const restoreSource = () => {
      process.chdir(base); const chain = walkExpected(request.source.chain); const sourceName = name(request.source.name);
      if (state(sourceName).kind !== "missing") throw new Error("source-recovery-occupied");
      fs.linkSync(sourceCapture, sourceName); const restored = fs.lstatSync(sourceName); const captured = fs.lstatSync(sourceCapture);
      if (!restored.isFile() || restored.isSymbolicLink() || restored.dev !== captured.dev || restored.ino !== captured.ino) throw new Error("source-recovery-identity");
      sourceRestored = true; syncDirectory(); verifySourceChain(chain);
    };
    const retireSourceCapture = (requireRestored, retired = () => {}) => {
      process.chdir(base); const chain = walkExpected(request.source.chain); const sourceName = name(request.source.name); const captured = fs.lstatSync(sourceCapture);
      if (!captured.isFile() || captured.isSymbolicLink() || captured.dev !== request.source.file.dev || captured.ino !== request.source.file.ino) throw new Error("source-retirement-identity");
      if (requireRestored) {
        const restored = fs.lstatSync(sourceName);
        if (!restored.isFile() || restored.isSymbolicLink() || restored.dev !== captured.dev || restored.ino !== captured.ino) throw new Error("source-retirement-public-identity");
      }
      fs.unlinkSync(sourceCapture); sourceCaptured = false; retired(); syncDirectory(); verifySourceChain(chain);
    };
    const removeDestination = () => {
      process.chdir(base); const chain = walkExpected(destinationChain); const destinationName = name(request.destination.name);
      if (state(destinationCapture).kind !== "missing") throw new Error("destination-recovery-capture");
      fs.renameSync(destinationName, destinationCapture); destinationQuarantined = true; const captured = fs.lstatSync(destinationCapture);
      if (!captured.isFile() || captured.isSymbolicLink() || captured.dev !== destinationIdentity.dev || captured.ino !== destinationIdentity.ino) {
        fs.linkSync(destinationCapture, destinationName); fs.unlinkSync(destinationCapture); destinationQuarantined = false; syncDirectory();
        throw new Error("destination-recovery-identity");
      }
      fs.unlinkSync(destinationCapture); destinationQuarantined = false; destinationCreated = false; syncDirectory(); verifySourceChain(chain);
    };
    try {
      const sourceChain = walkExpected(request.source.chain); const sourceName = name(request.source.name);
      const sourceBefore = fs.lstatSync(sourceName);
      if (!sourceBefore.isFile() || sourceBefore.isSymbolicLink() || sourceBefore.dev !== request.source.file.dev || sourceBefore.ino !== request.source.file.ino) throw new Error("source-identity");
      if (state(sourceCapture).kind !== "missing") throw new Error("source-capture");
      sourceCapturePath = path.join(process.cwd(), sourceCapture);
      fs.renameSync(sourceName, sourceCapture); sourceCaptured = true; syncDirectory();
      const captured = fs.lstatSync(sourceCapture);
      if (!captured.isFile() || captured.isSymbolicLink() || captured.dev !== request.source.file.dev || captured.ino !== request.source.file.ino) throw new Error("source-captured-identity");
      const source = read(sourceCapture, request.source.maxBytes, request.source.file);
      if (source.status.dev !== captured.dev || source.status.ino !== captured.ino || digest(source.bytes) !== request.source.sha256) throw new Error("source-digest");
      sourceMode = source.status.mode & 511; verifySourceChain(sourceChain);

      process.chdir(base); walk(safeSegments(request.destination.segments), destinationChain);
      const destinationName = name(request.destination.name);
      if (state(destinationName).kind !== "missing") throw new Error("destination-state");
      process.chdir(base); const linkSourceChain = walkExpected(request.source.chain); const currentCapture = read(sourceCapturePath, request.source.maxBytes, request.source.file);
      if (currentCapture.status.dev !== request.source.file.dev || currentCapture.status.ino !== request.source.file.ino
        || digest(currentCapture.bytes) !== request.source.sha256 || (currentCapture.status.mode & 511) !== sourceMode) throw new Error("source-capture-changed");
      verifySourceChain(linkSourceChain);
      process.chdir(base); walkExpected(destinationChain);
      fs.linkSync(sourceCapturePath, destinationName); destinationCreated = true; destinationIdentity = { ...request.source.file };
      const destination = fs.lstatSync(destinationName);
      if (!destination.isFile() || destination.isSymbolicLink() || destination.dev !== destinationIdentity.dev || destination.ino !== destinationIdentity.ino) throw new Error("destination-linked-identity");
      process.chdir(base); const linkedSourceChain = walkExpected(request.source.chain); const linkedCapture = fs.lstatSync(sourceCapture);
      if (!linkedCapture.isFile() || linkedCapture.isSymbolicLink() || linkedCapture.dev !== destinationIdentity.dev || linkedCapture.ino !== destinationIdentity.ino) throw new Error("source-linked-identity");
      verifySourceChain(linkedSourceChain);
      process.chdir(base); walkExpected(destinationChain);
      if (hash(destinationName) !== request.source.sha256 || (destination.mode & 511) !== sourceMode) throw new Error("destination-postimage");
      syncDirectory(); verifySourceChain(destinationChain);

      process.chdir(base); const currentSourceChain = walkExpected(request.source.chain);
      if (state(sourceName).kind !== "missing") throw new Error("source-postimage");
      const finalCapture = fs.lstatSync(sourceCapture);
      if (!finalCapture.isFile() || finalCapture.isSymbolicLink() || finalCapture.dev !== destinationIdentity.dev || finalCapture.ino !== destinationIdentity.ino) throw new Error("source-capture-identity");
      verifySourceChain(currentSourceChain);

      process.chdir(base); const currentDestinationChain = walkExpected(destinationChain);
      const currentDestination = fs.lstatSync(destinationName);
      if (!currentDestination.isFile() || currentDestination.isSymbolicLink() || currentDestination.dev !== destinationIdentity.dev
        || currentDestination.ino !== destinationIdentity.ino || hash(destinationName) !== request.source.sha256
        || (currentDestination.mode & 511) !== sourceMode) throw new Error("destination-changed");
      verifySourceChain(currentDestinationChain); process.chdir(base); identity();
      retireSourceCapture(false, () => { originalRetired = true; });
    } catch (error) {
      const failure = error instanceof Error ? error.message : String(error); const recoveryFailures = [];
      if (sourceCaptured) try { restoreSource(); } catch (recoveryError) { recoveryFailures.push("source:" + (recoveryError instanceof Error ? recoveryError.message : String(recoveryError))); }
      if (destinationCreated && !originalRetired) try { removeDestination(); } catch (recoveryError) { recoveryFailures.push("destination:" + (recoveryError instanceof Error ? recoveryError.message : String(recoveryError))); }
      if (sourceCaptured && sourceRestored && !destinationCreated) try { retireSourceCapture(true); } catch (recoveryError) { recoveryFailures.push("source-retirement:" + (recoveryError instanceof Error ? recoveryError.message : String(recoveryError))); }
      if (originalRetired) recoveryFailures.push("source:original-retired");
      if (destinationChain.length > 0) try { process.chdir(base); walkExpected(destinationChain); removeCreatedChain(destinationChain, request.identity); } catch (recoveryError) { recoveryFailures.push("directories:" + (recoveryError instanceof Error ? recoveryError.message : String(recoveryError))); }
      try { process.chdir(base); identity(); } catch (recoveryError) { recoveryFailures.push("root:" + (recoveryError instanceof Error ? recoveryError.message : String(recoveryError))); }
      if (recoveryFailures.length > 0) {
        const retained = [];
        if (sourceCaptured) retained.push([...request.source.chain.map(entry => entry.name), sourceCapture].join("/"));
        if (destinationQuarantined) retained.push([...request.destination.segments, destinationCapture].join("/"));
        else if (destinationCreated) retained.push([...request.destination.segments, request.destination.name].join("/"));
        respond({ kind: "refusal", reason: "relocate-recovery-failed", failure, recoveryFailures, retained }); process.exit(0);
      }
      respond({ kind: "refusal", reason: "relocate-failed", failure }); process.exit(0);
    }
    respond({ kind: "complete", sha256: request.source.sha256 });
  } else if (request.action === "prepare") {
    const base = process.cwd(); let chain = []; let final; let groupPath; const prepared = []; const attempted = []; const createdNested = new Map();
    try {
      walkMissing(safeSegments(request.segments), chain); final = fs.lstatSync("."); groupPath = process.cwd();
      for (const [index, entry] of request.entries.entries()) {
        process.chdir(groupPath); const nested = []; attempted.push({ index, chain: nested });
        walkNested(entry.chain, safeSegments(entry.segments), createdNested, nested);
        const target = name(entry.name); const stage = name(".cockpit-stage-" + request.nonce + "-" + index); const backup = name(".cockpit-backup-" + request.nonce + "-" + index);
        const prior = state(target); if (!matches(prior, entry.expected)) throw new Error("prestate");
        let stageName = null;
        if (entry.operation === "write-file") { copy(process.argv[2 + entry.input], stage, entry.sha256); stageName = stage; }
        else if (entry.operation === "write-symlink") { fs.symlinkSync(entry.target, stage); stageName = stage; }
        else if (entry.operation !== "remove-file" && entry.operation !== "remove-symlink") throw new Error("operation");
        let backupName = null;
        if (prior.kind === "file") { copy(target, backup, prior.sha256); backupName = backup; }
        prepared.push({ chain: nested, name: target, operation: entry.operation, sha256: entry.sha256 ?? null, target: entry.target ?? null,
          stage: stageName, backup: backupName, priorKind: prior.kind, priorSha256: prior.sha256 ?? null,
          priorTarget: prior.target ?? null, priorMode: prior.mode ?? null, priorIdentity: prior.identity ?? null });
        verifySourceChain(nested, final);
      }
    } catch (error) {
      try {
        if (groupPath && final) for (const item of [...attempted].reverse()) {
          process.chdir(groupPath); walkExpected(item.chain);
          fs.rmSync(name(".cockpit-stage-" + request.nonce + "-" + item.index), { force: true });
          fs.rmSync(name(".cockpit-backup-" + request.nonce + "-" + item.index), { force: true });
          syncDirectory(); removeCreatedChain(item.chain, final);
        }
        process.chdir(base);
        if (chain.length > 0) { walkExpected(chain); removeCreatedChain(chain, request.identity); }
        identity();
      } catch { respond({ kind: "refusal", reason: "prepare-cleanup-failed" }); process.exit(0); }
      respond({ kind: "refusal", reason: "prepare-failed" }); process.exit(0);
    }
    process.chdir(groupPath); syncDirectory();
    verifySourceChain(chain, request.identity);
    respond({ kind: "complete", identity: { dev: final.dev, ino: final.ino }, chain, entries: prepared });
  } else if (request.action === "publish") {
    publishEntries(request.entries, request.identity);
    respond({ kind: "complete" });
  } else if (request.action === "validate-batch" || request.action === "publish-batch" || request.action === "verify-batch" || request.action === "commit-batch") {
    if (!Array.isArray(request.groups) || request.groups.length < 1 || request.groups.length > 8) throw new Error("batch");
    const groups = [];
    for (const group of request.groups) {
      if (!group || typeof group !== "object" || typeof group.nonce !== "string" || typeof group.parent !== "string"
        || !Array.isArray(group.chain) || !Array.isArray(group.entries)) throw new Error("batch-group");
      const chain = walkExpected(group.chain);
      const final = fs.lstatSync("."); if (!same(final, group.identity)) throw new Error("group-identity");
      if (request.action === "publish-batch") publishEntries(group.entries);
      else if (request.action === "validate-batch") validateEntries(group.entries);
      else verifyEntries(group.entries);
      verifySourceChain(chain);
      groups.push({ nonce: group.nonce, parent: group.parent, kind: "complete" });
    }
    if (request.action === "commit-batch") {
      for (const group of request.groups) {
        const chain = walkExpected(group.chain);
        const final = fs.lstatSync("."); if (!same(final, group.identity)) throw new Error("group-identity");
        for (const entry of group.entries) {
          verifyEntries([entry], group.identity);
          const nested = walkExpected(entry.chain);
          if (entry.backup !== null) fs.unlinkSync(name(entry.backup));
          syncDirectory(); verifySourceChain(nested, group.identity);
        }
        verifySourceChain(chain);
      }
    }
    respond({ kind: "complete", groups });
  } else {
    if (request.action === "rollback") {
      const groupPath = process.cwd();
      for (const entry of request.entries) {
        process.chdir(groupPath); const nested = walkExpected(entry.chain);
        name(entry.name); if (entry.stage !== null) name(entry.stage);
        const current = state(entry.name); const post = entry.operation === "write-file" ? { kind: "file", sha256: entry.sha256 }
          : entry.operation === "write-symlink" ? { kind: "symlink", target: entry.target } : { kind: "missing" };
        const prior = { kind: entry.priorKind, sha256: entry.priorSha256, target: entry.priorTarget, mode: entry.priorMode, identity: entry.priorIdentity };
        if (!matches(current, post) && !matches(current, prior) || entry.backup !== null && hash(entry.backup) !== entry.priorSha256) throw new Error("recovery-state");
        verifySourceChain(nested, request.identity);
      }
      for (const entry of [...request.entries].reverse()) {
        process.chdir(groupPath); const nested = walkExpected(entry.chain);
        const current = state(entry.name); const post = entry.operation === "write-file" ? { kind: "file", sha256: entry.sha256 }
          : entry.operation === "write-symlink" ? { kind: "symlink", target: entry.target } : { kind: "missing" };
        if (matches(current, post)) {
          if (current.kind !== "missing") fs.unlinkSync(entry.name);
          if (entry.priorKind === "file") { fs.renameSync(entry.backup, entry.name); fs.chmodSync(entry.name, entry.priorMode); }
          else if (entry.priorKind === "symlink") fs.symlinkSync(entry.priorTarget, entry.name);
        } else if (entry.backup !== null) fs.unlinkSync(entry.backup);
        if (entry.stage !== null) fs.rmSync(entry.stage, { force: true });
        syncDirectory(); verifySourceChain(nested, request.identity);
      }
      process.chdir(groupPath);
      removeCreatedDirectories(request.entries, request.identity);
      for (let index = request.chain.length - 1; index >= 0; index--) {
        const child = request.chain[index]; process.chdir("..");
        const parent = fs.lstatSync("."); const expected = index === 0 ? request.start : request.chain[index - 1];
        if (!same(parent, expected)) throw new Error("parent-identity");
        const childStatus = fs.lstatSync(name(child.name)); if (!same(childStatus, child)) throw new Error("child-identity");
        if (child.created) { try { fs.rmdirSync(name(child.name)); syncDirectory(); } catch (error) { if (error.code !== "ENOTEMPTY") throw error; } }
      }
    } else {
      verifyEntries(request.entries, request.identity);
      if (request.action !== "verify") throw new Error("action");
    }
    respond({ kind: "complete" });
  }
} catch (error) { respond({ kind: "refusal", reason: "operation-refused" }); }
`

type NodeAuthority = ResolvedExecutable

interface HelperChainEntry extends DirectoryIdentity {
    readonly name: string
    readonly created: boolean
}

interface PrepareFileEntry {
    readonly chain: readonly Readonly<DirectoryIdentity & { readonly name: string }>[]
    readonly segments: readonly string[]
    readonly name: string
    readonly operation: HelperFileEntry['operation']
    readonly expected: ExpectedEntryState
    readonly sha256: string | null
    readonly target: string | null
    readonly input: number | null
}

interface HelperFileEntry {
    readonly chain: readonly HelperChainEntry[]
    readonly name: string
    readonly operation: 'write-file' | 'write-symlink' | 'remove-file' | 'remove-symlink'
    readonly sha256: string | null
    readonly target: string | null
    readonly stage: string | null
    readonly backup: string | null
    readonly priorKind: 'missing' | 'file' | 'symlink'
    readonly priorSha256: string | null
    readonly priorTarget: string | null
    readonly priorMode: number | null
    readonly priorIdentity: DirectoryIdentity | null
}

interface AppliedGroup {
    readonly parent: string
    readonly path: string
    readonly start: DirectoryIdentity
    readonly identity: DirectoryIdentity
    readonly chain: readonly HelperChainEntry[]
    readonly entries: readonly HelperFileEntry[]
    readonly logicalWeight: number
}

interface PublicationBatchRow {
    readonly nonce: string
    readonly parent: string
    readonly identity: DirectoryIdentity
    readonly chain: readonly Readonly<DirectoryIdentity & { readonly name: string }>[]
    readonly entries: readonly HelperFileEntry[]
}

interface PublicationBatchRequest {
    readonly version: 1
    readonly nonce: string
    readonly action: 'validate-batch' | 'publish-batch' | 'verify-batch' | 'commit-batch'
    readonly identity: DirectoryIdentity
    readonly groups: readonly PublicationBatchRow[]
}

async function digestFile(path: string, maxBytes: number): Promise<string | undefined> {
    let handle: Awaited<ReturnType<typeof open>> | undefined
    try {
        const before = await lstat(path)
        if (!before.isFile() || before.isSymbolicLink() || before.size > maxBytes || (before.mode & 0o111) === 0) return undefined
        handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
        const opened = await handle.stat()
        if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size > maxBytes) return undefined
        const fingerprint = fileFingerprint(path, opened)
        const known = verifiedDigest(fingerprint)
        if (known) return known
        const hash = createHash('sha256')
        const chunk = Buffer.allocUnsafe(Math.min(maxBytes + 1, 1_048_576))
        let total = 0
        while (true) {
            const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, maxBytes - total + 1), null)
            if (bytesRead === 0) break
            total += bytesRead
            if (total > maxBytes) return undefined
            hash.update(chunk.subarray(0, bytesRead))
        }
        const after = await handle.stat()
        if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) return undefined
        const digest = hash.digest('hex')
        if (fileFingerprint(path, after) === fingerprint) recordVerifiedDigest(fingerprint, digest)
        return digest
    } catch {
        return undefined
    } finally {
        try { await handle?.close() } catch { /* Unavailable authority remains a refusal. */ }
    }
}

export async function nodeAuthority(): Promise<NodeAuthority | undefined> {
    try {
        const canonicalPath = await realpath(process.execPath)
        const digest = await digestFile(canonicalPath, MAX_EXECUTABLE_BYTES)
        return digest ? Object.freeze({
            canonicalPath,
            invocationPath: canonicalPath,
            sha256: digest,
            executionMode: 'verified-path' as const,
        }) : undefined
    } catch {
        return undefined
    }
}

async function publicationAnchor(root: string, parent: string): Promise<{ path: string; identity: DirectoryIdentity; segments: readonly string[] } | undefined> {
    let path = root
    const segments = parent === '.' ? [] : parent.split('/')
    for (const [index, segment] of segments.entries()) {
        const candidate = join(path, segment)
        try {
            const status = await lstat(candidate)
            if (!status.isDirectory() || status.isSymbolicLink()) return undefined
            path = candidate
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return undefined
            const anchor = await lstat(path)
            return anchor.isDirectory() && !anchor.isSymbolicLink()
                ? Object.freeze({ path, identity: Object.freeze({ dev: anchor.dev, ino: anchor.ino }), segments: Object.freeze(segments.slice(index)) })
                : undefined
        }
    }
    const status = await lstat(path)
    return status.isDirectory() && !status.isSymbolicLink()
        ? Object.freeze({ path, identity: Object.freeze({ dev: status.dev, ino: status.ino }), segments: Object.freeze([]) })
        : undefined
}

async function nestedPublicationAuthority(
    groupPath: string,
    groupExists: boolean,
    segments: readonly string[],
): Promise<Readonly<{ chain: readonly Readonly<DirectoryIdentity & { readonly name: string }>[]; segments: readonly string[] }> | undefined> {
    if (!groupExists) return Object.freeze({ chain: Object.freeze([]), segments })
    const chain: Array<Readonly<DirectoryIdentity & { readonly name: string }>> = []
    let current = groupPath
    for (const [index, name] of segments.entries()) {
        if (!safePublicationSegment(name)) return undefined
        current = resolve(current, name)
        try {
            const status = await lstat(current)
            if (!status.isDirectory() || status.isSymbolicLink()) return undefined
            chain.push(Object.freeze({ name, dev: status.dev, ino: status.ino }))
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return undefined
            return Object.freeze({ chain: Object.freeze(chain), segments: Object.freeze(segments.slice(index)) })
        }
    }
    return Object.freeze({ chain: Object.freeze(chain), segments: Object.freeze([]) })
}

function helperStep(
    node: NodeAuthority,
    cwd: string,
    parent: string,
    request: object,
    inputs: readonly Readonly<{ path: string; sha256: string }>[],
    deadline: number,
): ExecutionStep | undefined {
    const remaining = deadline - Date.now()
    if (remaining <= 0) return undefined
    const requestBytes = JSON.stringify(request)
    if (Buffer.byteLength(requestBytes) > 65_536) return undefined
    return Object.freeze({
        id: `generated-filesystem-${(request as { action: string }).action}-${(request as { nonce: string }).nonce}`,
        argv: Object.freeze([node.canonicalPath, '-e', FILESYSTEM_HELPER, requestBytes, ...inputs.map(({ path }) => path)]) as readonly [string, ...string[]],
        argv0: node.invocationPath,
        cwd,
        env: Object.freeze({}),
        timeoutMs: Math.min(HELPER_TIMEOUT_MS, remaining),
        spawnNotAfter: new Date(deadline).toISOString(),
        stdoutLimitBytes: 65_536,
        stderrLimitBytes: 16_384,
        paths: Object.freeze([cwd]),
        ports: Object.freeze([]),
        labels: Object.freeze({ action: (request as { action: string }).action, parent }),
        expected: Object.freeze([]),
        consumedFiles: Object.freeze([
            Object.freeze({ path: node.canonicalPath, sha256: node.sha256, maxBytes: MAX_EXECUTABLE_BYTES, argvIndexes: Object.freeze([0]), executable: true as const, executionMode: node.executionMode }),
            ...inputs.map(({ path, sha256: digest }, index) => Object.freeze({ path, sha256: digest, maxBytes: MAX_GENERATED_BYTES, argvIndexes: Object.freeze([4 + index]), executable: false as const })),
        ]),
        filesystemChecks: Object.freeze([Object.freeze({ path: cwd, expected: 'directory' as const })]),
        compensation: Object.freeze([]),
    })
}

function helperRecord(value: unknown, keys: readonly string[]): Record<string, unknown> | undefined {
    const record = ownRecord(value)
    return record && exactKeys(record, keys) ? record : undefined
}

function directoryIdentity(value: unknown): DirectoryIdentity | undefined {
    const record = helperRecord(value, ['dev', 'ino'])
    return record && Number.isSafeInteger(record.dev) && Number.isSafeInteger(record.ino)
        ? Object.freeze({ dev: record.dev as number, ino: record.ino as number }) : undefined
}

export type AnchoredRead = Readonly<{
    kind: 'complete'
    bytes: Buffer
    sha256: string
    identity: PersonaSourceIdentity
}> | Readonly<{ kind: 'missing' }> | Readonly<{ kind: 'invalid' }>

export type AnchoredEntry = Readonly<{ kind: 'missing' | 'other' }>
    | Readonly<{ kind: 'file'; bytes: Buffer; sha256: string; identity: PersonaSourceIdentity; mode: number }>
    | Readonly<{ kind: 'symlink'; target: string; identity: DirectoryIdentity }>
    | Readonly<{ kind: 'invalid' }>

export async function readAnchoredFile(
    root: string,
    path: string,
    maxBytes: number,
    node: NodeAuthority,
    adapters: PublicationAdapters,
    action: 'read-file' | 'read-persona' = 'read-file',
    deadline?: number,
): Promise<AnchoredRead> {
    const target = confined(root, path)
    if (!target || constants.O_NOFOLLOW === undefined || !Number.isSafeInteger(maxBytes)
        || maxBytes < 1 || maxBytes > MAX_GENERATED_BYTES) return Object.freeze({ kind: 'invalid' })
    const parts = relative(root, target).split(sep)
    if (parts.length < 1 || parts.some((part) => part === '' || part === '.' || part === '..')) return Object.freeze({ kind: 'invalid' })
    let rootStatus: Awaited<ReturnType<typeof lstat>>
    try {
        rootStatus = await lstat(root)
        if (!rootStatus.isDirectory() || rootStatus.isSymbolicLink()) return Object.freeze({ kind: 'invalid' })
    } catch {
        return Object.freeze({ kind: 'invalid' })
    }
    let directory: string
    try {
        directory = await mkdtemp(join(tmpdir(), 'cockpit-generated-read-'))
    } catch {
        return Object.freeze({ kind: 'invalid' })
    }
    try {
        const nonce = randomBytes(16).toString('hex')
        const output = join(directory, 'source')
        const request = Object.freeze({
            version: 1, nonce, action, maxBytes,
            identity: Object.freeze({ dev: rootStatus.dev, ino: rootStatus.ino }),
            segments: Object.freeze(parts.slice(0, -1)), name: parts.at(-1), output,
        })
        const helperDeadline = Math.min(Date.now() + HELPER_TIMEOUT_MS, deadline ?? Number.MAX_SAFE_INTEGER)
        const rawReceipt = await runHelper(adapters, helperStep(node, root, '.', request, [], helperDeadline))
        const missing = helperRecord(rawReceipt, ['version', 'nonce', 'action', 'kind'])
        if (missing?.version === 1 && missing.nonce === nonce && missing.action === action && missing.kind === 'missing') {
            return Object.freeze({ kind: 'missing' })
        }
        const receipt = helperRecord(rawReceipt, ['version', 'nonce', 'action', 'kind', 'identity', 'sha256'])
        if (!receipt || receipt.version !== 1 || receipt.nonce !== nonce || receipt.action !== action
            || receipt.kind !== 'complete' || typeof receipt.sha256 !== 'string' || !SHA256.test(receipt.sha256)) {
            return Object.freeze({ kind: 'invalid' })
        }
        const rawIdentity = helperRecord(receipt.identity, ['root', 'chain', 'file'])
        const readRoot = directoryIdentity(rawIdentity?.root)
        const file = directoryIdentity(rawIdentity?.file)
        const chain = Array.isArray(rawIdentity?.chain) ? rawIdentity.chain.map(directoryIdentity) : undefined
        if (!readRoot || readRoot.dev !== rootStatus.dev || readRoot.ino !== rootStatus.ino
            || !file || !chain || chain.length !== parts.length - 1 || chain.some((entry) => !entry)) return Object.freeze({ kind: 'invalid' })
        const handle = await open(output, constants.O_RDONLY | constants.O_NOFOLLOW)
        let bytes: Buffer
        try {
            const before = await handle.stat()
            if (!before.isFile() || before.size > maxBytes) return Object.freeze({ kind: 'invalid' })
            const chunks: Buffer[] = []
            const chunk = Buffer.allocUnsafe(65_536)
            let total = 0
            while (true) {
                const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, maxBytes - total + 1), null)
                if (bytesRead === 0) break
                total += bytesRead
                if (total > maxBytes) return Object.freeze({ kind: 'invalid' })
                chunks.push(Buffer.from(chunk.subarray(0, bytesRead)))
            }
            const after = await handle.stat()
            if (total !== before.size || after.dev !== before.dev || after.ino !== before.ino
                || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
                return Object.freeze({ kind: 'invalid' })
            }
            bytes = Buffer.concat(chunks, total)
        } finally {
            await handle.close()
        }
        if (sha256(bytes) !== receipt.sha256) return Object.freeze({ kind: 'invalid' })
        return Object.freeze({
            kind: 'complete' as const, bytes, sha256: receipt.sha256,
            identity: Object.freeze({ root: readRoot, chain: Object.freeze(chain as DirectoryIdentity[]), file }),
        })
    } catch {
        return Object.freeze({ kind: 'invalid' })
    } finally {
        await rm(directory, { recursive: true, force: true })
    }
}

export async function readAnchoredEntry(
    root: string,
    path: string,
    maxBytes: number,
    node: NodeAuthority,
    adapters: PublicationAdapters,
): Promise<AnchoredEntry> {
    const target = confined(root, path)
    if (!target || maxBytes < 1 || maxBytes > MAX_GENERATED_BYTES) return Object.freeze({ kind: 'invalid' })
    const parts = relative(root, target).split(sep)
    let rootStatus: Awaited<ReturnType<typeof lstat>>
    try { rootStatus = await lstat(root) } catch { return Object.freeze({ kind: 'invalid' }) }
    if (!rootStatus.isDirectory() || rootStatus.isSymbolicLink()) return Object.freeze({ kind: 'invalid' })
    let directory: string | undefined
    try {
        directory = await mkdtemp(join(tmpdir(), 'cockpit-generated-entry-'))
        const nonce = randomBytes(16).toString('hex')
        const output = join(directory, 'source')
        const request = Object.freeze({ version: 1, nonce, action: 'read-entry', maxBytes,
            identity: { dev: rootStatus.dev, ino: rootStatus.ino }, segments: parts.slice(0, -1), name: parts.at(-1), output })
        const value = await runHelper(adapters, helperStep(node, root, '.', request, [], Date.now() + HELPER_TIMEOUT_MS))
        const simple = ownRecord(value)
        if (!simple || simple.version !== 1 || simple.nonce !== nonce || simple.action !== 'read-entry' || typeof simple.kind !== 'string') return Object.freeze({ kind: 'invalid' })
        if ((simple.kind === 'missing' || simple.kind === 'other') && exactKeys(simple, ['version', 'nonce', 'action', 'kind'])) return Object.freeze({ kind: simple.kind })
        if (simple.kind === 'symlink' && exactKeys(simple, ['version', 'nonce', 'action', 'kind', 'target', 'identity'])) {
            const identity = directoryIdentity(simple.identity)
            return identity && typeof simple.target === 'string' ? Object.freeze({ kind: 'symlink', target: simple.target, identity }) : Object.freeze({ kind: 'invalid' })
        }
        if (simple.kind !== 'file' || !exactKeys(simple, ['version', 'nonce', 'action', 'kind', 'identity', 'mode', 'sha256'])
            || typeof simple.sha256 !== 'string' || !SHA256.test(simple.sha256) || !Number.isSafeInteger(simple.mode)) return Object.freeze({ kind: 'invalid' })
        const identityRow = ownRecord(simple.identity)
        const readRoot = directoryIdentity(identityRow?.root)
        const file = directoryIdentity(identityRow?.file)
        const chain = Array.isArray(identityRow?.chain) ? identityRow.chain.map(directoryIdentity) : undefined
        if (!readRoot || !file || !chain || chain.some(row => !row)) return Object.freeze({ kind: 'invalid' })
        const handle = await open(output, constants.O_RDONLY | constants.O_NOFOLLOW)
        let bytes: Buffer
        try {
            const before = await handle.stat()
            if (!before.isFile() || before.size > maxBytes) return Object.freeze({ kind: 'invalid' })
            const chunks: Buffer[] = []
            const chunk = Buffer.allocUnsafe(65_536)
            let total = 0
            while (true) {
                const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, maxBytes - total + 1), null)
                if (bytesRead === 0) break
                total += bytesRead
                if (total > maxBytes) return Object.freeze({ kind: 'invalid' })
                chunks.push(Buffer.from(chunk.subarray(0, bytesRead)))
            }
            const after = await handle.stat()
            if (total !== before.size || after.dev !== before.dev || after.ino !== before.ino
                || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
                return Object.freeze({ kind: 'invalid' })
            }
            bytes = Buffer.concat(chunks, total)
        } finally { await handle.close() }
        if (sha256(bytes) !== simple.sha256) return Object.freeze({ kind: 'invalid' })
        return Object.freeze({ kind: 'file', bytes, sha256: simple.sha256, mode: simple.mode as number,
            identity: Object.freeze({ root: readRoot, chain: Object.freeze(chain as DirectoryIdentity[]), file }) })
    } catch { return Object.freeze({ kind: 'invalid' }) } finally { if (directory) await rm(directory, { recursive: true, force: true }) }
}

export type AnchoredRelocation = Readonly<{ kind: 'complete'; sha256: string }>
    | Readonly<{ kind: 'refusal'; recovery: 'unchanged' | 'indeterminate'; failure?: string; recoveryFailures?: readonly string[]; retainedPaths?: readonly string[] }>

/** Move one authenticated regular file between confined paths through the publication helper. */
export async function relocateAnchoredFile(
    root: string,
    sourcePath: string,
    destinationPath: string,
    maxBytes: number,
    expectedSha256: string,
    node: NodeAuthority,
    adapters: PublicationAdapters,
): Promise<AnchoredRelocation> {
    const sourceTarget = confined(root, sourcePath)
    const destinationTarget = confined(root, destinationPath)
    if (!sourceTarget || !destinationTarget || sourceTarget === destinationTarget || !SHA256.test(expectedSha256)
        || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_GENERATED_BYTES) {
        return Object.freeze({ kind: 'refusal', recovery: 'unchanged' })
    }
    const sourceParts = relative(root, sourceTarget).split(sep)
    const destinationParts = relative(root, destinationTarget).split(sep)
    if (sourceParts.some(part => !safePublicationSegment(part)) || destinationParts.some(part => !safePublicationSegment(part))) {
        return Object.freeze({ kind: 'refusal', recovery: 'unchanged' })
    }
    const source = await readAnchoredFile(root, sourcePath, maxBytes, node, adapters)
    const destination = await readAnchoredEntry(root, destinationPath, maxBytes, node, adapters)
    if (source.kind !== 'complete' || source.sha256 !== expectedSha256 || destination.kind !== 'missing') {
        return Object.freeze({ kind: 'refusal', recovery: 'unchanged' })
    }
    const nonce = randomBytes(16).toString('hex')
    const request = Object.freeze({
        version: 1, nonce, action: 'relocate-file', identity: source.identity.root,
        source: Object.freeze({
            chain: Object.freeze(sourceParts.slice(0, -1).map((name, index) => Object.freeze({ name, ...source.identity.chain[index]! }))),
            name: sourceParts.at(-1), file: source.identity.file, sha256: source.sha256, maxBytes,
        }),
        destination: Object.freeze({ segments: Object.freeze(destinationParts.slice(0, -1)), name: destinationParts.at(-1) }),
    })
    const receipt = await runHelper(adapters, helperStep(node, root, 'adoption', request, [], Date.now() + HELPER_TIMEOUT_MS))
    const complete = helperRecord(receipt, ['version', 'nonce', 'action', 'kind', 'sha256'])
    if (complete?.version === 1 && complete.nonce === nonce && complete.action === 'relocate-file'
        && complete.kind === 'complete' && complete.sha256 === expectedSha256) {
        return Object.freeze({ kind: 'complete', sha256: expectedSha256 })
    }
    const refusal = ownRecord(receipt)
    const safeFailure = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 512
    const recovered = refusal && exactKeys(refusal, ['version', 'nonce', 'action', 'kind', 'reason', 'failure'])
        && refusal.version === 1 && refusal.nonce === nonce && refusal.action === 'relocate-file'
        && refusal.kind === 'refusal' && refusal.reason === 'relocate-failed' && safeFailure(refusal.failure)
    const recoveryFailed = refusal && exactKeys(refusal, ['version', 'nonce', 'action', 'kind', 'reason', 'failure', 'recoveryFailures', 'retained'])
        && refusal.version === 1 && refusal.nonce === nonce && refusal.action === 'relocate-file'
        && refusal.kind === 'refusal' && refusal.reason === 'relocate-recovery-failed' && Array.isArray(refusal.retained)
        && safeFailure(refusal.failure) && Array.isArray(refusal.recoveryFailures)
        && refusal.recoveryFailures.length > 0 && refusal.recoveryFailures.every(safeFailure)
        && refusal.retained.every(path => typeof path === 'string' && confined(root, path) !== undefined)
    const retainedPaths = recoveryFailed
        ? Object.freeze(refusal.retained as string[]) : undefined
    const possibleCaptures = Object.freeze([
        [...sourceParts.slice(0, -1), `.cockpit-adopt-source-${nonce}`].join('/'),
        [...destinationParts.slice(0, -1), `.cockpit-adopt-destination-${nonce}`].join('/'),
    ])
    return Object.freeze({
        kind: 'refusal', recovery: recovered ? 'unchanged' : 'indeterminate',
        ...((recovered || recoveryFailed) ? { failure: refusal.failure as string } : { failure: 'filesystem-helper-receipt-unavailable' }),
        ...(recoveryFailed ? { recoveryFailures: Object.freeze(refusal.recoveryFailures as string[]) } : {}),
        ...(!recovered ? { retainedPaths: retainedPaths ?? possibleCaptures } : {}),
    })
}

/** Confirm or restore the original side of an anchored relocation without following either path. */
export async function restoreAnchoredFile(
    root: string,
    originalPath: string,
    relocatedPath: string,
    maxBytes: number,
    expectedSha256: string,
    node: NodeAuthority,
    adapters: PublicationAdapters,
): Promise<AnchoredRelocation> {
    const original = await readAnchoredFile(root, originalPath, maxBytes, node, adapters)
    const relocated = await readAnchoredFile(root, relocatedPath, maxBytes, node, adapters)
    if (original.kind === 'complete' && original.sha256 === expectedSha256 && relocated.kind === 'missing') {
        return Object.freeze({ kind: 'complete', sha256: expectedSha256 })
    }
    if (original.kind === 'missing' && relocated.kind === 'complete' && relocated.sha256 === expectedSha256) {
        return relocateAnchoredFile(root, relocatedPath, originalPath, maxBytes, expectedSha256, node, adapters)
    }
    return Object.freeze({ kind: 'refusal', recovery: 'indeterminate' })
}

interface AnchoredBatchReadRequest {
    readonly path: string
    readonly maxBytes: number
    readonly action: 'read-file' | 'read-persona' | 'read-entry'
}

export type AnchoredBatchReadResult = AnchoredRead | AnchoredEntry
type AnchoredBatchOutcome = Readonly<{ kind: 'complete'; results: readonly AnchoredBatchReadResult[] }>
    | Readonly<{ kind: 'invalid'; index: number }>
type AnchoredBatchAttempt = AnchoredBatchOutcome | Readonly<{ kind: 'split' }>

async function readPrivateOutput(path: string, maxBytes: number): Promise<Buffer | undefined> {
    let handle: Awaited<ReturnType<typeof open>> | undefined
    let result: Buffer | undefined
    let closeFailed = false
    try {
        handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
        const before = await handle.stat()
        if (!before.isFile() || before.size > maxBytes) return undefined
        const chunks: Buffer[] = []
        const chunk = Buffer.allocUnsafe(65_536)
        let total = 0
        while (true) {
            const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, maxBytes - total + 1), null)
            if (bytesRead === 0) break
            total += bytesRead
            if (total > maxBytes) return undefined
            chunks.push(Buffer.from(chunk.subarray(0, bytesRead)))
        }
        const after = await handle.stat()
        result = total === before.size && after.dev === before.dev && after.ino === before.ino
            && after.size === before.size && after.mtimeMs === before.mtimeMs && after.ctimeMs === before.ctimeMs
            ? Buffer.concat(chunks, total) : undefined
    } catch {
        return undefined
    } finally {
        try { await handle?.close() } catch { closeFailed = true }
    }
    return closeFailed ? undefined : result
}

async function readAnchoredBatch(
    root: string,
    requests: readonly AnchoredBatchReadRequest[],
    node: NodeAuthority,
    adapters: PublicationAdapters,
    deadline?: number,
): Promise<AnchoredBatchAttempt | undefined> {
    if (requests.length < 1 || requests.length > MAX_AUTHENTICATED_READ_BATCH || constants.O_NOFOLLOW === undefined
        || requests.reduce((total, request) => total + request.maxBytes, 0) > MAX_AUTHENTICATED_READ_BATCH_BYTES) return undefined
    const resolved = requests.map((request) => {
        const target = confined(root, request.path)
        if (!target || !Number.isSafeInteger(request.maxBytes) || request.maxBytes < 1 || request.maxBytes > MAX_GENERATED_BYTES) return undefined
        const parts = relative(root, target).split(sep)
        return parts.length > 0 && parts.every(part => part !== '' && part !== '.' && part !== '..')
            ? Object.freeze({ ...request, target, parts: Object.freeze(parts) }) : undefined
    })
    if (resolved.some(request => request === undefined)
        || new Set(resolved.map(request => request?.target)).size !== resolved.length) return undefined
    if (requests.length === 1) {
        const single = requests[0]!
        const result = single.action === 'read-entry'
            ? await readAnchoredEntry(root, single.path, single.maxBytes, node, adapters)
            : await readAnchoredFile(root, single.path, single.maxBytes, node, adapters, single.action, deadline)
        return result.kind === 'invalid' ? Object.freeze({ kind: 'invalid', index: 0 })
            : Object.freeze({ kind: 'complete', results: Object.freeze([result]) })
    }
    let rootStatus: Awaited<ReturnType<typeof lstat>>
    try {
        rootStatus = await lstat(root)
        if (!rootStatus.isDirectory() || rootStatus.isSymbolicLink()) return undefined
    } catch {
        return undefined
    }
    let directory: string | undefined
    try {
        directory = await mkdtemp(join(tmpdir(), 'cockpit-generated-read-batch-'))
        const nonce = randomBytes(16).toString('hex')
        const entries = resolved.map((request, index) => Object.freeze({
            nonce: randomBytes(16).toString('hex'),
            action: request!.action,
            maxBytes: request!.maxBytes,
            segments: request!.parts.slice(0, -1),
            name: request!.parts.at(-1),
            output: join(directory!, `source-${index}`),
        }))
        if (new Set(entries.map(entry => entry.nonce)).size !== entries.length) return undefined
        const receiptOutput = join(directory, 'receipt')
        const request = Object.freeze({
            version: 1, nonce, action: 'read-batch',
            identity: Object.freeze({ dev: rootStatus.dev, ino: rootStatus.ino }),
            entries: Object.freeze(entries),
            receiptOutput,
        })
        if (Buffer.byteLength(JSON.stringify(request)) > MAX_HELPER_FRAME_BYTES) return Object.freeze({ kind: 'split' })
        const helperDeadline = Math.min(Date.now() + HELPER_TIMEOUT_MS, deadline ?? Number.MAX_SAFE_INTEGER)
        const raw = await runHelper(adapters, helperStep(node, root, '.', request, [], helperDeadline))
        const refusal = helperRecord(raw, ['version', 'nonce', 'action', 'kind', 'failedNonce'])
        if (refusal?.version === 1 && refusal.nonce === nonce && refusal.action === 'read-batch' && refusal.kind === 'refusal'
            && typeof refusal.failedNonce === 'string') {
            const index = entries.findIndex(entry => entry.nonce === refusal.failedNonce)
            return index >= 0 ? Object.freeze({ kind: 'invalid', index }) : undefined
        }
        const summary = helperRecord(raw, ['version', 'nonce', 'action', 'kind', 'receiptBytes', 'receiptSha256'])
        if (!summary || summary.version !== 1 || summary.nonce !== nonce || summary.action !== 'read-batch'
            || summary.kind !== 'complete' || !Number.isSafeInteger(summary.receiptBytes)
            || (summary.receiptBytes as number) < 1 || (summary.receiptBytes as number) > MAX_AUTHENTICATED_READ_BATCH_RECEIPT_BYTES
            || typeof summary.receiptSha256 !== 'string' || !SHA256.test(summary.receiptSha256)) return undefined
        const receiptBytes = await readPrivateOutput(receiptOutput, MAX_AUTHENTICATED_READ_BATCH_RECEIPT_BYTES)
        if (!receiptBytes || receiptBytes.length !== summary.receiptBytes || sha256(receiptBytes) !== summary.receiptSha256) return undefined
        const receiptText = new TextDecoder('utf-8', { fatal: true }).decode(receiptBytes)
        const receiptValue = JSON.parse(receiptText) as unknown
        if (JSON.stringify(receiptValue) + '\n' !== receiptText) return undefined
        const receipt = helperRecord(receiptValue, ['version', 'nonce', 'action', 'kind', 'entries'])
        if (!receipt || receipt.version !== 1 || receipt.nonce !== nonce || receipt.action !== 'read-batch'
            || receipt.kind !== 'complete' || !Array.isArray(receipt.entries) || receipt.entries.length !== entries.length) return undefined
        const results: AnchoredBatchReadResult[] = []
        for (const [index, expected] of entries.entries()) {
            const row = ownRecord(receipt.entries[index])
            if (!row || row.nonce !== expected.nonce || row.action !== expected.action || row.name !== expected.name
                || row.maxBytes !== expected.maxBytes || typeof row.kind !== 'string') return undefined
            if (!Array.isArray(row.segments) || row.segments.length !== expected.segments.length
                || row.segments.some((segment, segmentIndex) => segment !== expected.segments[segmentIndex])) return undefined
            const boundKeys = ['nonce', 'action', 'segments', 'name', 'maxBytes', 'kind']
            if (row.kind === 'missing') {
                if (expected.action === 'read-persona' || !exactKeys(row, boundKeys)) return undefined
                results.push(Object.freeze({ kind: 'missing' }))
                continue
            }
            if (row.kind === 'other') {
                if (expected.action !== 'read-entry' || !exactKeys(row, boundKeys)) return undefined
                results.push(Object.freeze({ kind: 'other' }))
                continue
            }
            if (row.kind === 'symlink') {
                if (expected.action !== 'read-entry' || !exactKeys(row, [...boundKeys, 'target', 'identity']) || typeof row.target !== 'string') return undefined
                const identity = directoryIdentity(row.identity)
                if (!identity) return undefined
                results.push(Object.freeze({ kind: 'symlink', target: row.target, identity }))
                continue
            }
            const expectedKind = expected.action === 'read-entry' ? 'file' : 'complete'
            const keys = expected.action === 'read-entry'
                ? [...boundKeys, 'identity', 'mode', 'sha256'] : [...boundKeys, 'identity', 'sha256']
            if (row.kind !== expectedKind || !exactKeys(row, keys) || typeof row.sha256 !== 'string' || !SHA256.test(row.sha256)
                || expected.action === 'read-entry' && !Number.isSafeInteger(row.mode)) return undefined
            const identityRow = helperRecord(row.identity, ['root', 'chain', 'file'])
            const readRoot = directoryIdentity(identityRow?.root)
            const file = directoryIdentity(identityRow?.file)
            const chain = Array.isArray(identityRow?.chain) ? identityRow.chain.map(directoryIdentity) : undefined
            const parts = resolved[index]!.parts
            if (!readRoot || readRoot.dev !== rootStatus.dev || readRoot.ino !== rootStatus.ino || !file || !chain
                || chain.length !== parts.length - 1 || chain.some(entry => !entry)) return undefined
            const bytes = await readPrivateOutput(expected.output, expected.maxBytes)
            if (!bytes || sha256(bytes) !== row.sha256) return Object.freeze({ kind: 'invalid', index })
            const identity = Object.freeze({ root: readRoot, chain: Object.freeze(chain as DirectoryIdentity[]), file })
            results.push(expected.action === 'read-entry'
                ? Object.freeze({ kind: 'file', bytes, sha256: row.sha256, mode: row.mode as number, identity })
                : Object.freeze({ kind: 'complete', bytes, sha256: row.sha256, identity }))
        }
        return Object.freeze({ kind: 'complete', results: Object.freeze(results) })
    } catch {
        return undefined
    } finally {
        if (directory) await rm(directory, { recursive: true, force: true })
    }
}

export async function readAnchoredBatches(
    root: string,
    requests: readonly AnchoredBatchReadRequest[],
    node: NodeAuthority,
    adapters: PublicationAdapters,
    deadline?: number,
): Promise<AnchoredBatchOutcome | undefined> {
    const results: AnchoredBatchReadResult[] = []
    let offset = 0
    while (offset < requests.length) {
        if (deadline !== undefined && Date.now() >= deadline) return undefined
        let end = offset
        let requestedBytes = 0
        const targets = new Set<string>()
        while (end < requests.length && end - offset < MAX_AUTHENTICATED_READ_BATCH) {
            const next = requests[end]!
            const target = confined(root, next.path)
            if (target && targets.has(target)) break
            if (requestedBytes + next.maxBytes > MAX_AUTHENTICATED_READ_BATCH_BYTES) break
            if (target) targets.add(target)
            requestedBytes += next.maxBytes
            end += 1
        }
        if (end === offset) return undefined
        let batch = await readAnchoredBatch(root, requests.slice(offset, end), node, adapters, deadline)
        while (batch?.kind === 'split') {
            end = offset + Math.ceil((end - offset) / 2)
            batch = await readAnchoredBatch(root, requests.slice(offset, end), node, adapters, deadline)
        }
        if (!batch) return undefined
        if (batch.kind === 'invalid') return Object.freeze({ kind: 'invalid', index: offset + batch.index })
        results.push(...batch.results)
        offset = end
    }
    return Object.freeze({ kind: 'complete', results: Object.freeze(results) })
}

export async function readPersonaSource(
    root: string,
    path: string,
    node: NodeAuthority,
    adapters: PublicationAdapters,
    deadline?: number,
): Promise<{ bytes: Buffer; sha256: string; identity: PersonaSourceIdentity } | undefined> {
    const read = await readAnchoredFile(root, path, MAX_GENERATED_BYTES, node, adapters, 'read-persona', deadline)
    return read.kind === 'complete'
        ? Object.freeze({ bytes: read.bytes, sha256: read.sha256, identity: read.identity })
        : undefined
}

function safePublicationSegment(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0 && value.length <= 255
        && !/[<>:"/\\|?*\x00-\x1f\x7f]/.test(value) && !/[. ]$/.test(value)
        && !/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(value)
}

function portablePublicationPaths(paths: readonly string[]): boolean {
    const prefixes = new Map<string, string>()
    for (const path of paths) {
        let prefix = ''
        for (const segment of path.split('/')) {
            if (!safePublicationSegment(segment)) return false
            prefix = prefix ? `${prefix}/${segment}` : segment
            // Missing parents have no inode to compare, so reject aliases before either spelling can be created.
            const key = prefix.normalize('NFC').toLowerCase()
            const prior = prefixes.get(key)
            if (prior !== undefined && prior !== prefix) return false
            prefixes.set(key, prefix)
        }
    }
    return true
}

function helperChain(value: unknown): readonly HelperChainEntry[] | undefined {
    if (!Array.isArray(value)) return undefined
    const chain: HelperChainEntry[] = []
    for (const item of value) {
        const row = helperRecord(item, ['name', 'dev', 'ino', 'created'])
        if (!row || !safePublicationSegment(row.name) || !Number.isSafeInteger(row.dev)
            || !Number.isSafeInteger(row.ino) || typeof row.created !== 'boolean') return undefined
        chain.push(Object.freeze({ name: row.name, dev: row.dev as number, ino: row.ino as number, created: row.created }))
    }
    return Object.freeze(chain)
}

function preparedEntryChainsValid(entries: readonly HelperFileEntry[], requests: readonly PrepareFileEntry[]): boolean {
    const createdPrefixes = new Map<string, DirectoryIdentity>()
    for (const [entryIndex, entry] of entries.entries()) {
        const request = requests[entryIndex]
        if (!request || entry.chain.length !== request.chain.length + request.segments.length) return false
        const names: string[] = []
        for (const [chainIndex, directory] of entry.chain.entries()) {
            names.push(directory.name)
            const prefix = names.join('/')
            if (chainIndex < request.chain.length) {
                const expected = request.chain[chainIndex]
                if (!expected || directory.name !== expected.name || directory.dev !== expected.dev
                    || directory.ino !== expected.ino || directory.created) return false
                continue
            }
            if (directory.name !== request.segments[chainIndex - request.chain.length]) return false
            const created = createdPrefixes.get(prefix)
            if (created) {
                if (directory.created || directory.dev !== created.dev || directory.ino !== created.ino) return false
            } else {
                if (!directory.created) return false
                createdPrefixes.set(prefix, Object.freeze({ dev: directory.dev, ino: directory.ino }))
            }
        }
    }
    return true
}

function parsePrepareReceipt(
    value: unknown,
    nonce: string,
    requests: readonly PrepareFileEntry[],
): Omit<AppliedGroup, 'parent' | 'path' | 'start' | 'logicalWeight'> | undefined {
    const receipt = helperRecord(value, ['version', 'nonce', 'action', 'kind', 'identity', 'chain', 'entries'])
    if (!receipt || receipt.version !== 1 || receipt.nonce !== nonce || receipt.action !== 'prepare' || receipt.kind !== 'complete'
        || !Array.isArray(receipt.chain) || !Array.isArray(receipt.entries)) return undefined
    const identity = directoryIdentity(receipt.identity)
    const chain = helperChain(receipt.chain)
    if (!chain) return undefined
    const entries: HelperFileEntry[] = []
    for (const [index, item] of receipt.entries.entries()) {
        const row = helperRecord(item, ['chain', 'name', 'operation', 'sha256', 'target', 'stage', 'backup', 'priorKind', 'priorSha256', 'priorTarget', 'priorMode', 'priorIdentity'])
        const priorIdentity = row ? row.priorIdentity === null ? null : directoryIdentity(row.priorIdentity) : undefined
        const entryChain = row ? helperChain(row.chain) : undefined
        const request = requests[index]
        const expectedStage = `.cockpit-stage-${nonce}-${index}`
        const expectedBackup = `.cockpit-backup-${nonce}-${index}`
        if (!row || !request || !entryChain || !safePublicationSegment(row.name) || !['write-file', 'write-symlink', 'remove-file', 'remove-symlink'].includes(String(row.operation))
            || row.stage !== null && typeof row.stage !== 'string' || row.sha256 !== null && (typeof row.sha256 !== 'string' || !SHA256.test(row.sha256))
            || row.target !== null && typeof row.target !== 'string'
            || row.backup !== null && typeof row.backup !== 'string'
            || !['missing', 'file', 'symlink'].includes(String(row.priorKind))
            || row.priorSha256 !== null && (typeof row.priorSha256 !== 'string' || !SHA256.test(row.priorSha256))
            || row.priorTarget !== null && typeof row.priorTarget !== 'string'
            || row.priorMode !== null && (!Number.isSafeInteger(row.priorMode) || (row.priorMode as number) < 0 || (row.priorMode as number) > 0o777)
            || priorIdentity === undefined || (row.priorKind === 'missing') !== (priorIdentity === null)
            || (row.priorKind === 'file') !== (row.priorSha256 !== null) || (row.priorKind === 'file') !== (row.priorMode !== null)
            || (row.priorKind === 'file') !== (row.backup !== null) || (row.priorKind === 'symlink') !== (row.priorTarget !== null)
            || row.stage !== (request.operation === 'write-file' || request.operation === 'write-symlink' ? expectedStage : null)
            || row.backup !== (row.priorKind === 'file' ? expectedBackup : null)) return undefined
        entries.push(Object.freeze({ ...row, chain: entryChain, priorIdentity }) as unknown as HelperFileEntry)
    }
    return identity && preparedEntryChainsValid(entries, requests)
        ? Object.freeze({ identity, chain, entries: Object.freeze(entries) }) : undefined
}

function parseSimpleReceipt(value: unknown, nonce: string, action: 'publish' | 'verify' | 'rollback'): boolean {
    const receipt = helperRecord(value, ['version', 'nonce', 'action', 'kind'])
    return receipt?.version === 1 && receipt.nonce === nonce && receipt.action === action && receipt.kind === 'complete'
}

function parsePublicationBatchReceipt(value: unknown, request: PublicationBatchRequest): boolean {
    const receipt = helperRecord(value, ['version', 'nonce', 'action', 'kind', 'groups'])
    if (!receipt || receipt.version !== 1 || receipt.nonce !== request.nonce || receipt.action !== request.action
        || receipt.kind !== 'complete' || !Array.isArray(receipt.groups) || receipt.groups.length !== request.groups.length) return false
    const nonces = new Set<string>()
    return receipt.groups.every((value, index) => {
        const row = helperRecord(value, ['nonce', 'parent', 'kind'])
        const expected = request.groups[index]
        if (!row || !expected || typeof row.nonce !== 'string' || nonces.has(row.nonce)) return false
        nonces.add(row.nonce)
        return row.nonce === expected.nonce && row.parent === expected.parent && row.kind === 'complete'
    })
}

async function publicationBatchRequest(
    root: string,
    rootIdentity: DirectoryIdentity,
    groups: readonly AppliedGroup[],
    action: PublicationBatchRequest['action'],
): Promise<PublicationBatchRequest | undefined> {
    const rootStatus = await lstat(root)
    if (!rootStatus.isDirectory() || rootStatus.isSymbolicLink()
        || rootStatus.dev !== rootIdentity.dev || rootStatus.ino !== rootIdentity.ino) return undefined
    const nonce = randomBytes(16).toString('hex')
    const rows: PublicationBatchRow[] = []
    for (const group of groups.slice(0, MAX_PUBLICATION_BATCH_GROUPS)) {
        const target = group.parent === '.' ? root : confined(root, group.parent)
        if (!target || target !== group.path) return undefined
        let current = root
        const chain: Array<Readonly<DirectoryIdentity & { readonly name: string }>> = []
        for (const name of group.parent === '.' ? [] : group.parent.split('/')) {
            if (name.length === 0 || name === '.' || name === '..' || name.includes('\\') || name.includes('\0')) return undefined
            current = resolve(current, name)
            const status = await lstat(current)
            if (!status.isDirectory() || status.isSymbolicLink()) return undefined
            chain.push(Object.freeze({ name, dev: status.dev, ino: status.ino }))
        }
        const final = chain.at(-1) ?? rootIdentity
        if (final.dev !== group.identity.dev || final.ino !== group.identity.ino) return undefined
        const row = Object.freeze({
            nonce: randomBytes(16).toString('hex'),
            parent: group.parent,
            identity: group.identity,
            chain: Object.freeze(chain),
            entries: group.entries,
        })
        const candidate = Object.freeze({ version: 1 as const, nonce, action, identity: rootIdentity, groups: Object.freeze([...rows, row]) })
        if (Buffer.byteLength(JSON.stringify(candidate)) > MAX_HELPER_FRAME_BYTES) break
        rows.push(row)
    }
    return rows.length > 0
        ? Object.freeze({ version: 1, nonce, action, identity: rootIdentity, groups: Object.freeze(rows) })
        : undefined
}

async function runPublicationBatches(
    action: PublicationBatchRequest['action'],
    root: string,
    rootIdentity: DirectoryIdentity,
    groups: readonly AppliedGroup[],
    node: NodeAuthority,
    adapters: PublicationAdapters,
    nextForwardDeadline: (calls: number) => number | undefined,
): Promise<boolean> {
    let offset = 0
    while (offset < groups.length) {
        const request = await publicationBatchRequest(root, rootIdentity, groups.slice(offset), action)
        if (!request) return false
        const logicalWeight = request.groups.reduce((count, _row, index) => count + groups[offset + index]!.logicalWeight, 0)
        const deadline = nextForwardDeadline(logicalWeight)
        if (deadline === undefined) return false
        const receipt = await runHelper(adapters, helperStep(node, root, 'generated-environment', request, [], deadline))
        if (!parsePublicationBatchReceipt(receipt, request)) return false
        offset += request.groups.length
    }
    return true
}

async function runHelper(
    adapters: PublicationAdapters,
    step: ExecutionStep | undefined,
): Promise<unknown | undefined> {
    if (!step) return undefined
    try {
        const outcome = authenticatedExecutionOutcome(await adapters.execute(step), step)
        if (!outcome || outcome.kind !== 'complete' || outcome.stderr.byteLength !== 0) return undefined
        const text = new TextDecoder('utf-8', { fatal: true }).decode(outcome.stdout)
        const value: unknown = JSON.parse(text)
        return `${JSON.stringify(value)}\n` === text ? value : undefined
    } catch {
        return undefined
    }
}

export interface ExpectedEntryState {
    readonly kind: 'missing' | 'file' | 'symlink'
    readonly sha256?: string
    readonly target?: string
    readonly identity?: DirectoryIdentity
}

export interface PublicationMutation {
    readonly path: string
    readonly phase: 'desired' | 'stale' | 'ledger'
    readonly operation: 'write-file' | 'write-symlink' | 'remove-file' | 'remove-symlink'
    readonly expected: ExpectedEntryState
    readonly bytes?: string
    readonly sha256?: string
    readonly target?: string
    readonly compactAnchor?: string
}

interface PublicationGroup {
    readonly parent: string
    readonly mutations: readonly PublicationMutation[]
    readonly logicalWeight: number
}

export function expectedState(entry: AnchoredEntry): ExpectedEntryState | undefined {
    if (entry.kind === 'missing') return Object.freeze({ kind: 'missing' })
    if (entry.kind === 'file') return Object.freeze({ kind: 'file', sha256: entry.sha256, identity: entry.identity.file })
    if (entry.kind === 'symlink') return Object.freeze({ kind: 'symlink', target: entry.target, identity: entry.identity })
    return undefined
}

async function stageInputs(files: readonly OwnedBytes[]): Promise<{ directory: string; inputs: readonly Readonly<{ path: string; sha256: string }>[] } | undefined> {
    let directory: string | undefined
    try {
        directory = await mkdtemp(join(tmpdir(), 'cockpit-generated-input-'))
        const inputs: Array<{ path: string; sha256: string }> = []
        for (const [index, file] of files.entries()) {
            if (Buffer.byteLength(file.bytes) > MAX_GENERATED_BYTES) throw new Error('generated input is oversized')
            const path = join(directory, String(index))
            const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
            try { await handle.writeFile(file.bytes); await handle.sync() } finally { await handle.close() }
            inputs.push(Object.freeze({ path, sha256: file.sha256 }))
        }
        return Object.freeze({ directory, inputs: Object.freeze(inputs) })
    } catch {
        if (directory) await rm(directory, { recursive: true, force: true })
        return undefined
    }
}

async function recordRecovery(directory: string, groups: readonly AppliedGroup[]): Promise<boolean> {
    const path = join(directory, `recovery-${String(groups.length).padStart(4, '0')}.json`)
    let handle: Awaited<ReturnType<typeof open>> | undefined
    let directoryHandle: Awaited<ReturnType<typeof open>> | undefined
    try {
        handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
        const durableGroups = groups.map(({ logicalWeight: _logicalWeight, ...group }) => group)
        await handle.writeFile(`${JSON.stringify({ version: 1, groups: durableGroups })}\n`)
        await handle.sync()
        await handle.close()
        handle = undefined
        directoryHandle = await open(directory, constants.O_RDONLY | constants.O_NOFOLLOW)
        await directoryHandle.sync()
        return true
    } catch {
        return false
    } finally {
        try { await handle?.close() } catch { /* A missing durable recovery record keeps publication closed. */ }
        try { await directoryHandle?.close() } catch { /* The recovery record was already synced before directory cleanup. */ }
    }
}

function publicationEntrySegments(parent: string, path: string): readonly string[] | undefined {
    const group = parent === '.' ? [] : parent.split('/')
    const leafParent = dirname(path) === '.' ? [] : dirname(path).split('/')
    if (group.some((segment, index) => segment !== leafParent[index])) return undefined
    const segments = leafParent.slice(group.length)
    return segments.every(segment => segment.length > 0 && segment !== '.' && segment !== '..'
        && !segment.includes('/') && !segment.includes('\\') && !segment.includes('\0')) ? Object.freeze(segments) : undefined
}

function groupFrameBounded(parent: string, entries: readonly PublicationMutation[]): boolean {
        const identity = { dev: Number.MAX_SAFE_INTEGER, ino: Number.MAX_SAFE_INTEGER }
        const chain = (parent === '.' ? [] : parent.split('/')).map(name => ({ name, ...identity, created: false }))
        const requestEntries = entries.map((entry, index) => {
            const segments = publicationEntrySegments(parent, entry.path)
            return segments && { chain: segments.map(name => ({ name, ...identity })), segments: [], name: basename(entry.path), operation: entry.operation,
                expected: entry.expected, sha256: entry.sha256 ?? null, target: entry.target ?? null,
                input: entry.operation === 'write-file' ? Number.MAX_SAFE_INTEGER - index : null }
        })
        if (requestEntries.some(entry => entry === undefined)) return false
        const receiptEntries = entries.map((entry, index) => ({ chain: publicationEntrySegments(parent, entry.path)!.map(name => ({ name, ...identity, created: false })),
            name: basename(entry.path), operation: entry.operation,
            sha256: entry.sha256 ?? null, target: entry.target ?? null, stage: `.cockpit-stage-${'0'.repeat(32)}-${index}`,
            backup: `.cockpit-backup-${'0'.repeat(32)}-${index}`, priorKind: entry.expected.kind,
            priorSha256: entry.expected.sha256 ?? null, priorTarget: entry.expected.target ?? null,
            priorMode: entry.expected.kind === 'file' ? 511 : null, priorIdentity: entry.expected.identity ?? null }))
        const group = { nonce: '0'.repeat(32), parent, identity, chain, entries: receiptEntries }
        const frames = [
            { version: 1, nonce: '0'.repeat(32), action: 'prepare', identity, segments: parent === '.' ? [] : parent.split('/'), entries: requestEntries },
            { version: 1, nonce: '0'.repeat(32), action: 'prepare', kind: 'complete', identity, chain, entries: receiptEntries },
            { version: 1, nonce: '0'.repeat(32), action: 'validate-batch', identity, groups: [group] },
            { version: 1, nonce: '0'.repeat(32), action: 'publish-batch', identity, groups: [group] },
            { version: 1, nonce: '0'.repeat(32), action: 'verify-batch', identity, groups: [group] },
            { version: 1, nonce: '0'.repeat(32), action: 'rollback', identity, start: identity, chain, entries: receiptEntries },
            { version: 1, nonce: '0'.repeat(32), action: 'commit-batch', identity, groups: [group] },
        ]
        return frames.every(frame => Buffer.byteLength(JSON.stringify(frame)) + 1 <= MAX_HELPER_FRAME_BYTES)
}

function groupMutations(mutations: readonly PublicationMutation[]): readonly PublicationGroup[] | undefined {
    type Order = 'write' | 'remove' | 'ledger'
    const grouped = new Map<string, { parent: string; phase: Order; rows: PublicationMutation[] }>()
    for (const mutation of mutations) {
        const parent = dirname(mutation.path)
        const phase = mutation.phase === 'ledger' ? 'ledger' : mutation.operation.startsWith('write-') ? 'write' : 'remove'
        const key = `${phase}\0${parent}`
        const group = grouped.get(key) ?? { parent, phase, rows: [] }
        group.rows.push(mutation)
        grouped.set(key, group)
    }
    const logical: Array<Readonly<{ parent: string; phase: Order; mutations: readonly PublicationMutation[] }>> = []
    const phaseOrder = { write: 0, remove: 1, ledger: 2 } as const
    for (const { parent, phase, rows } of [...grouped.values()].sort((left, right) => phaseOrder[left.phase] - phaseOrder[right.phase]
        || compareCodeUnits(left.parent, right.parent))) {
        let chunk: PublicationMutation[] = []
        for (const row of rows.sort((left, right) => compareCodeUnits(left.path, right.path))) {
            const candidate = [...chunk, row]
            if (!groupFrameBounded(parent, candidate)) {
                if (chunk.length === 0 || !groupFrameBounded(parent, [row])) return undefined
                logical.push(Object.freeze({ parent, phase, mutations: Object.freeze(chunk) }))
                chunk = [row]
            } else chunk = candidate
        }
        if (chunk.length > 0) logical.push(Object.freeze({ parent, phase, mutations: Object.freeze(chunk) }))
    }
    const clusters = new Map<string, typeof logical>()
    for (const group of logical) {
        const anchor = group.mutations.every(row => row.compactAnchor === group.mutations[0]?.compactAnchor)
            ? group.mutations[0]?.compactAnchor : undefined
        if (!anchor) continue
        const key = `${group.phase}\0${anchor}`
        const cluster = clusters.get(key) ?? []
        cluster.push(group)
        clusters.set(key, cluster)
    }
    const compacted = new Set<string>()
    const result: Array<Readonly<PublicationGroup & { phase: Order }>> = []
    for (const group of logical) {
        const anchor = group.mutations.every(row => row.compactAnchor === group.mutations[0]?.compactAnchor)
            ? group.mutations[0]?.compactAnchor : undefined
        const key = anchor ? `${group.phase}\0${anchor}` : undefined
        const cluster = key ? clusters.get(key) : undefined
        if (!key || !cluster || compacted.has(key)) {
            if (!key || !cluster) result.push(Object.freeze({ ...group, logicalWeight: 1 }))
            continue
        }
        compacted.add(key)
        const parents = new Set(cluster.map(row => row.parent))
        const entries = cluster.flatMap(row => row.mutations).sort((left, right) => compareCodeUnits(left.path, right.path))
        if (parents.size > 1 && groupFrameBounded(anchor!, entries)) {
            result.push(Object.freeze({ parent: anchor!, phase: group.phase, mutations: Object.freeze(entries), logicalWeight: 1 }))
        } else for (const row of cluster) result.push(Object.freeze({ ...row, logicalWeight: 1 }))
    }
    result.sort((left, right) => phaseOrder[left.phase] - phaseOrder[right.phase] || compareCodeUnits(left.parent, right.parent))
    const merged: typeof result = []
    for (const group of result) {
        const prior = merged.at(-1)
        const mutations = prior && prior.phase === group.phase && prior.parent === group.parent
            ? [...prior.mutations, ...group.mutations].sort((left, right) => compareCodeUnits(left.path, right.path)) : undefined
        if (prior && mutations && groupFrameBounded(group.parent, mutations)) {
            merged[merged.length - 1] = Object.freeze({ ...prior, mutations: Object.freeze(mutations), logicalWeight: prior.logicalWeight + group.logicalWeight })
        } else merged.push(group)
    }
    return Object.freeze(merged.map(({ phase: _phase, ...group }) => Object.freeze(group)))
}

async function compensate(
    groups: readonly AppliedGroup[],
    node: NodeAuthority,
    adapters: PublicationAdapters,
    transactionDeadline: number,
): Promise<boolean> {
    const rollback = [...groups].reverse()
    let remainingWeight = rollback.reduce((count, group) => count + group.logicalWeight, 0)
    for (const [index, group] of rollback.entries()) {
        const nonce = randomBytes(16).toString('hex')
        const request = Object.freeze({ version: 1, nonce, action: 'rollback', identity: group.identity, start: group.start, chain: group.chain, entries: group.entries })
        remainingWeight -= group.logicalWeight
        const deadline = transactionDeadline - remainingWeight * PUBLICATION_HELPER_SLOT_MS
        const receipt = await runHelper(adapters, helperStep(node, group.path, group.parent, request, [], deadline))
        if (!parseSimpleReceipt(receipt, nonce, 'rollback')) return false
    }
    return true
}

function staleRemovalRequest(
    prepared: Readonly<{ cockpitId: string; generation: string; sourceSha256: string }>,
    mutations: readonly PublicationMutation[],
): GeneratedStaleRemovalApprovalRequest | undefined {
    const entries: GeneratedStaleRemovalApprovalEntry[] = []
    for (const mutation of mutations.filter((candidate) => candidate.phase === 'stale')) {
        const current = mutation.expected
        if (current.kind !== 'file' && current.kind !== 'symlink' || !current.identity
            || mutation.operation !== 'write-file' && mutation.operation !== 'remove-file' && mutation.operation !== 'remove-symlink') return undefined
        entries.push(Object.freeze({
            path: mutation.path,
            operation: mutation.operation,
            current: Object.freeze({
                kind: current.kind,
                ...(current.sha256 ? { sha256: current.sha256 } : {}),
                ...(current.target ? { target: current.target } : {}),
                dev: current.identity.dev,
                ino: current.identity.ino,
            }),
            ...(mutation.sha256 ? { resultSha256: mutation.sha256 } : {}),
        }))
    }
    if (entries.length === 0) return undefined
    const payload = Object.freeze({
        format: 'cockpit-stale-removal-request/v1' as const,
        cockpitId: prepared.cockpitId,
        generation: prepared.generation,
        sourceSha256: prepared.sourceSha256,
        entries: Object.freeze(entries.sort((left, right) => compareCodeUnits(left.path, right.path))),
    })
    return Object.freeze({ ...payload, digest: sha256(JSON.stringify(payload)) })
}

async function staleRemovalApproved(
    request: GeneratedStaleRemovalApprovalRequest,
    adapters: PublicationAdapters,
): Promise<boolean> {
    if (!adapters.authorizeStaleRemoval) return false
    try {
        const approval = ownRecord(await adapters.authorizeStaleRemoval(request))
        return !!approval
            && exactKeys(approval, ['format', 'digest'])
            && approval.format === 'cockpit-stale-removal-approval/v1'
            && approval.digest === request.digest
    } catch {
        return false
    }
}

export interface ReferenceManifestInput {
    readonly generation: string
    readonly sourceSha256: string
    readonly files: readonly Readonly<{ path: string; sha256: string }>[]
    readonly troubleshootingSha256: string
}

type ReferenceManifestEntry = Readonly<{ kind: 'file'; path: typeof REFERENCE_FILE_PATHS[number]; sha256: string }>
    | Readonly<{ kind: 'markdown-region'; path: typeof TROUBLESHOOTING_PATH; regionId: 'diagnostic-index'; begin: typeof TROUBLESHOOTING_BEGIN; end: typeof TROUBLESHOOTING_END; sha256: string }>

interface ReferenceManifestPayload {
    readonly format: 'cockpit-generated-references/v1'
    readonly generation: string
    readonly source: Readonly<{ path: 'package.json'; sha256: string }>
    readonly producer: Readonly<{ package: string; version: string; sourceRevision: string }>
    readonly entries: readonly ReferenceManifestEntry[]
}

interface ReferenceManifest extends ReferenceManifestPayload { readonly integrity: string }

function parseReferenceManifest(bytes: string): ReferenceManifest | undefined {
    if (typeof bytes !== 'string' || Buffer.byteLength(bytes) > MAX_OWNERSHIP_BYTES) return undefined
    let value: unknown
    try { value = JSON.parse(bytes) } catch { return undefined }
    const record = ownRecord(value)
    if (!record || !exactKeys(record, ['format', 'generation', 'source', 'producer', 'entries', 'integrity'])
        || record.format !== 'cockpit-generated-references/v1' || typeof record.generation !== 'string' || !SHA256.test(record.generation)
        || typeof record.integrity !== 'string' || !SHA256.test(record.integrity)) return undefined
    const source = ownRecord(record.source)
    const producer = ownRecord(record.producer)
    if (!source || !exactKeys(source, ['path', 'sha256']) || source.path !== 'package.json' || typeof source.sha256 !== 'string' || !SHA256.test(source.sha256)
        || !producer || !exactKeys(producer, ['package', 'version', 'sourceRevision'])
        || producer.package !== installedPackageMetadata.name || producer.version !== installedPackageMetadata.version
        || producer.sourceRevision !== installedPackageMetadata.cockpitSourceRevision || !Array.isArray(record.entries)
        || record.entries.length !== REFERENCE_PATHS.length) return undefined
    const entries: ReferenceManifestEntry[] = []
    for (const [index, path] of REFERENCE_PATHS.entries()) {
        const row = ownRecord(record.entries[index])
        if (!row || row.path !== path || typeof row.sha256 !== 'string' || !SHA256.test(row.sha256)) return undefined
        if (path === TROUBLESHOOTING_PATH) {
            if (!exactKeys(row, ['kind', 'path', 'regionId', 'begin', 'end', 'sha256']) || row.kind !== 'markdown-region'
                || row.regionId !== 'diagnostic-index' || row.begin !== TROUBLESHOOTING_BEGIN || row.end !== TROUBLESHOOTING_END) return undefined
        } else if (!exactKeys(row, ['kind', 'path', 'sha256']) || row.kind !== 'file') return undefined
        entries.push(Object.freeze(row as unknown as ReferenceManifestEntry))
    }
    const payload = Object.freeze({ format: record.format, generation: record.generation, source: Object.freeze(source),
        producer: Object.freeze(producer), entries: Object.freeze(entries) }) as ReferenceManifestPayload
    if (sha256(JSON.stringify(payload)) !== record.integrity) return undefined
    return Object.freeze({ ...payload, integrity: record.integrity }) as ReferenceManifest
}

export function encodeReferenceManifest(input: ReferenceManifestInput): Readonly<{ bytes: string; manifest: ReferenceManifest }> {
    const captured = snapshotGeneratedJson(input) as unknown as ReferenceManifestInput | undefined
    if (!captured || !exactKeys(captured as unknown as Record<string, unknown>, ['generation', 'sourceSha256', 'files', 'troubleshootingSha256'])
        || !SHA256.test(captured.generation) || !SHA256.test(captured.sourceSha256) || !SHA256.test(captured.troubleshootingSha256)
        || !Array.isArray(captured.files) || captured.files.length !== REFERENCE_FILE_PATHS.length
        || captured.files.some((row, index) => !row || row.path !== REFERENCE_FILE_PATHS[index] || !SHA256.test(row.sha256))) throw new Error('reference manifest input is not exact bounded hashes')
    const payload: ReferenceManifestPayload = Object.freeze({
        format: 'cockpit-generated-references/v1', generation: captured.generation,
        source: Object.freeze({ path: 'package.json', sha256: captured.sourceSha256 }),
        producer: Object.freeze({ package: installedPackageMetadata.name, version: installedPackageMetadata.version, sourceRevision: installedPackageMetadata.cockpitSourceRevision }),
        entries: Object.freeze([
            ...REFERENCE_FILE_PATHS.map((path, index) => Object.freeze({ kind: 'file' as const, path, sha256: captured.files[index]!.sha256 })),
            Object.freeze({ kind: 'markdown-region' as const, path: TROUBLESHOOTING_PATH, regionId: 'diagnostic-index' as const,
                begin: TROUBLESHOOTING_BEGIN, end: TROUBLESHOOTING_END, sha256: captured.troubleshootingSha256 }),
        ]),
    })
    const bytes = `${JSON.stringify({ ...payload, integrity: sha256(JSON.stringify(payload)) }, null, 2)}\n`
    const manifest = parseReferenceManifest(bytes)
    if (!manifest) throw new Error('reference manifest encoder produced invalid bytes')
    return Object.freeze({ bytes, manifest })
}

export type PublicationReference = Readonly<{ kind: 'file'; path: string; sha256: string }>
    | Readonly<{ kind: 'markdown-region'; path: string; begin: string; end: string;
        preimageSha256: string; regionSha256: string; postimageSha256: string }>

export interface PublicationPlan {
    readonly changes: readonly PublicationChange[]
    readonly staleRemoval?: GeneratedStaleRemovalApprovalRequest
}

export interface PublicationPlanInput {
    readonly authority: OwnershipAuthority
    readonly generation: string
    readonly sourceSha256: string
    readonly rootIdentity: DirectoryIdentity
    readonly node: ResolvedExecutable
    readonly mode: 'sync' | 'uninstall' | 'forget' | 'reference'
    readonly ledgerExpected: ExpectedEntryState
    readonly nextLedgerBytes: string | null
    readonly mutations: readonly PublicationMutation[]
    readonly surfaceActions?: readonly SurfaceChange[]
    readonly references?: readonly PublicationReference[]
    readonly referenceBootstrap?: ReferenceBootstrap
}

export interface BootstrapPublicationPlanInput {
    readonly mode: 'bootstrap'
    readonly root: string
    readonly rootIdentity: DirectoryIdentity
    readonly node: ResolvedExecutable
    readonly inspected: InspectedBootstrapOutputs
    readonly mutations: readonly PublicationMutation[]
}

type AdmittedPublicationPlanInput = PublicationPlanInput | BootstrapPublicationPlanInput

interface PublicationCheck {
    readonly path: string
    readonly maxBytes: number
    readonly expected: ExpectedEntryState
    readonly identity?: PersonaSourceIdentity
}

interface PublicationRecord {
    readonly root: string
    readonly rootIdentity: DirectoryIdentity
    readonly node: ResolvedExecutable
    readonly mutations: readonly PublicationMutation[]
    readonly groups: readonly PublicationGroup[]
    readonly changes: readonly PublicationChange[]
    readonly checks: readonly PublicationCheck[]
    readonly referenceBootstrap?: ReferenceBootstrap
    readonly staleRemoval?: GeneratedStaleRemovalApprovalRequest
}

export interface PublicationRunAdapters extends PublicationAdapters {
    readonly dryRun?: boolean
    readonly revalidate: (deadline?: number, stage?: 'preview' | 'before-stage' | 'before-publish' | 'after-publish') => Promise<boolean | PublicationRefusal>
}

export type PublicationOutcome = PublicationRefusal | Readonly<{
    kind: 'complete'
    changes: readonly PublicationChange[]
    committedPaths: readonly string[]
    staleRemoval?: GeneratedStaleRemovalApprovalRequest
}>

const issuedPlans = new WeakMap<object, PublicationRecord>()
const consumedPlans = new WeakSet<object>()

function sameExpected(left: ExpectedEntryState, right: ExpectedEntryState): boolean {
    return left.kind === right.kind && left.sha256 === right.sha256 && left.target === right.target
        && left.identity?.dev === right.identity?.dev && left.identity?.ino === right.identity?.ino
}

function sameIdentity(left: PersonaSourceIdentity, right: PersonaSourceIdentity): boolean {
    return left.root.dev === right.root.dev && left.root.ino === right.root.ino
        && left.file.dev === right.file.dev && left.file.ino === right.file.ino
        && left.chain.length === right.chain.length
        && left.chain.every((row, index) => row.dev === right.chain[index]?.dev && row.ino === right.chain[index]?.ino)
}

function exactPath(root: string, path: string): boolean {
    return path.length <= 4096 && !/[\\\x00-\x1f\x7f*?\[\]{}]/.test(path)
        && path.split('/').every(part => safePublicationSegment(part)
            && !['.git', 'internal', 'node_modules'].includes(part.toLowerCase())) && confined(root, path) !== undefined
}

function classifyEntry(fact: GeneratedPathFact | undefined, current: AnchoredEntry): string | undefined {
    if (!fact) return undefined
    const entry = fact.entry
    const observation = current.kind === 'file' ? { path: entry.path, kind: 'file', bytes: current.bytes,
        identity: JSON.stringify(current.identity), confinement: 'confined' }
        : current.kind === 'symlink' && entry.kind === 'symlink' ? { path: entry.path, kind: 'symlink', target: current.target,
            identity: JSON.stringify(current.identity), source: entry.source, confinement: 'confined' }
            : { path: entry.path, kind: current.kind, confinement: current.kind === 'missing' ? 'confined' : 'unknown' }
    const classified = classifyGeneratedPaths([fact], [observation])
    return classified.kind === 'complete' ? classified.paths[0]?.state : undefined
}

function troubleshootingRegion(document: string): Readonly<{ bytes: string; prefix: string; suffix: string }> | undefined {
    const tokens = [...document.matchAll(/<!--\s*cockpit:diagnostic-index[^\r\n]*?(?:-->|$)/g)]
    if (tokens.length !== 2 || tokens[0]![0] !== TROUBLESHOOTING_BEGIN || tokens[1]![0] !== TROUBLESHOOTING_END) return undefined
    for (const token of tokens) {
        const start = token.index!
        if ((start !== 0 && document[start - 1] !== '\n') || !/^(?:\r?\n|$)/.test(document.slice(start + token[0].length))) return undefined
    }
    const contentStart = tokens[0]!.index! + TROUBLESHOOTING_BEGIN.length
    const lineBreak = document.slice(contentStart).match(/^\r?\n/)?.[0]
    if (!lineBreak) return undefined
    const contentEnd = tokens[1]!.index!
    return Object.freeze({ bytes: document.slice(contentStart + lineBreak.length, contentEnd),
        prefix: document.slice(0, contentStart) + lineBreak, suffix: document.slice(contentEnd) })
}

async function admitReferencePlan(
    captured: PublicationPlanInput,
    bootstrap: ReferenceBootstrap | undefined,
    adapters: PublicationAdapters,
): Promise<PublicationRefusal | Readonly<{ kind: 'complete'; plan: PublicationPlan }>> {
    const { authority, node } = captured
    if (authority.configPath !== join(authority.root, 'package.json') || captured.nextLedgerBytes === null) {
        return refuse('GENERATED_REFERENCE_OWNERSHIP_INVALID', 'reference publication requires the root package source and a complete reference ledger', REFERENCE_OWNERSHIP_PATH)
    }
    const ledger = await readAnchoredEntry(authority.root, REFERENCE_OWNERSHIP_PATH, MAX_OWNERSHIP_BYTES, node, adapters)
    const ledgerState = expectedState(ledger)
    if (!ledgerState || !sameExpected(ledgerState, captured.ledgerExpected)) {
        return refuse('GENERATED_REFERENCE_OWNERSHIP_INVALID', 'reference ownership metadata changed after observation', REFERENCE_OWNERSHIP_PATH)
    }
    let prior: ReferenceManifest | undefined
    if (ledger.kind === 'file') {
        try { prior = parseReferenceManifest(new TextDecoder('utf-8', { fatal: true }).decode(ledger.bytes)) } catch { /* Refuse below. */ }
        if (!prior) return refuse('GENERATED_REFERENCE_OWNERSHIP_INVALID', 'reference publication requires authenticated reference metadata', REFERENCE_OWNERSHIP_PATH)
    } else if (ledger.kind !== 'missing') return refuse('GENERATED_REFERENCE_OWNERSHIP_INVALID', 'reference ownership metadata is not a regular file', REFERENCE_OWNERSHIP_PATH)
    const next = parseReferenceManifest(captured.nextLedgerBytes)
    if (!next || next.generation !== captured.generation || next.source.sha256 !== captured.sourceSha256) {
        return refuse('GENERATED_REFERENCE_OWNERSHIP_INVALID', 'reference ledger does not match its declared source and generation', REFERENCE_OWNERSHIP_PATH)
    }
    const references = captured.references ?? []
    if (references.length !== REFERENCE_PATHS.length || references.some((row, index) => {
        const fields = ownRecord(row)
        if (!fields || row.path !== REFERENCE_PATHS[index]) return true
        return index < REFERENCE_FILE_PATHS.length
            ? row.kind !== 'file' || !exactKeys(fields, ['kind', 'path', 'sha256']) || !SHA256.test(row.sha256) || row.sha256 !== next.entries[index]!.sha256
            : row.kind !== 'markdown-region' || !exactKeys(fields, ['kind', 'path', 'begin', 'end', 'preimageSha256', 'regionSha256', 'postimageSha256'])
                || row.begin !== TROUBLESHOOTING_BEGIN || row.end !== TROUBLESHOOTING_END || row.regionSha256 !== next.entries[index]!.sha256
                || ![row.preimageSha256, row.regionSha256, row.postimageSha256].every(value => SHA256.test(value))
    })) {
        return refuse('GENERATED_REFERENCE_OWNERSHIP_INVALID', 'reference destinations differ from the fixed reference estate', 'references')
    }
    const mutations = [...captured.mutations]
    if (new Set(mutations.map(row => row.path)).size !== mutations.length || mutations.some(row => !REFERENCE_PATHS.includes(row.path as typeof REFERENCE_PATHS[number])
        || row.phase !== 'desired' || row.operation !== 'write-file' || typeof row.bytes !== 'string'
        || Buffer.byteLength(row.bytes) > MAX_GENERATED_BYTES || row.sha256 !== sha256(row.bytes))) {
        return refuse('GENERATED_PUBLICATION_FAILED', 'reference publication contains an undeclared or non-exact operation', 'references')
    }
    const bootstrapRecord = bootstrap && referenceBootstraps.get(bootstrap)
    if (!bootstrapRecord || bootstrapRecord.root !== authority.root || !await revalidateReferenceBootstrap(bootstrap!, adapters)) {
        return refuse('GENERATED_REFERENCE_BOOTSTRAP_INVALID', 'reference publication requires current owner-issued Git bootstrap evidence', 'references')
    }
    const bootstrapFiles = new Map(bootstrapRecord?.files.map(row => [row.path, row]))
    const reads = await readAnchoredBatches(authority.root, REFERENCE_PATHS.map(path => ({ path, action: 'read-entry', maxBytes: MAX_GENERATED_BYTES })), node, adapters)
    if (!reads || reads.kind !== 'complete' || reads.results.length !== REFERENCE_PATHS.length) {
        return refuse('GENERATED_PUBLICATION_FAILED', 'reference destinations could not be classified safely', 'references')
    }
    // Rebases replace committed pages without updating the ignored ledger. Only the entire
    // authenticated Git estate can replace that baseline; a single hand edit keeps it closed.
    if (prior && REFERENCE_PATHS.every((path, index) => {
        const current = reads.results[index]!
        const indexed = bootstrapFiles.get(path)
        return indexed ? current.kind === 'file' && current.sha256 === indexed.sha256
            && (indexed.mode === '100755') === ((current.mode & 0o111) !== 0) : current.kind === 'missing'
    })) prior = undefined
    const checks: PublicationCheck[] = []
    for (const [index, path] of REFERENCE_PATHS.entries()) {
        const current = reads.results[index]!
        if (current.kind === 'complete' || current.kind === 'invalid' || current.kind === 'other' || current.kind === 'symlink') {
            return refuse('GENERATED_PUBLICATION_FAILED', 'reference destination is not an anchored regular file or missing', path)
        }
        const expected = expectedState(current)
        if (!expected) return refuse('GENERATED_PUBLICATION_FAILED', 'reference destination state is unknown', path)
        const mutation = mutations.find(row => row.path === path)
        if (mutation && !sameExpected(expected, mutation.expected)) return refuse('GENERATED_SOURCE_CHANGED', 'reference destination changed after classification', path)
        if (!prior) {
            const indexed = bootstrapFiles.get(path)
            const modeMatches = current.kind === 'file' && (indexed?.mode === '100755') === ((current.mode & 0o111) !== 0)
            if (indexed ? current.kind !== 'file' || current.sha256 !== indexed.sha256 || !modeMatches : current.kind !== 'missing') {
                return refuse('GENERATED_REFERENCE_BOOTSTRAP_INVALID', 'reference destination differs from its immutable Git bootstrap', path)
            }
        }
        const desired = next.entries[index]!
        if (path !== TROUBLESHOOTING_PATH) {
            const priorEntry = prior?.entries[index]
            if (prior && (priorEntry?.kind !== 'file' || current.kind !== 'file' || current.sha256 !== priorEntry.sha256)) {
                return refuse('GENERATED_STALE_ARTIFACT_DRIFT', 'owned reference file differs from its authenticated manifest', path)
            }
            if (!mutation) {
                if (current.kind !== 'file' || current.sha256 !== desired.sha256) return refuse('GENERATED_PUBLICATION_FAILED', 'reference plan omitted a required whole-file write', path)
            } else if (mutation.sha256 !== desired.sha256) return refuse('GENERATED_PUBLICATION_FAILED', 'reference whole-file postimage differs from its manifest', path)
        } else {
            if (current.kind !== 'file') return refuse('GENERATED_PUBLICATION_FAILED', 'troubleshooting reference region requires an existing regular file', path)
            let document: string
            try { document = new TextDecoder('utf-8', { fatal: true }).decode(current.bytes) } catch { return refuse('GENERATED_PUBLICATION_FAILED', 'troubleshooting reference is not UTF-8', path) }
            const region = troubleshootingRegion(document)
            const declaration = references[index]
            if (!region || declaration?.kind !== 'markdown-region' || declaration.preimageSha256 !== current.sha256
                || prior && (prior.entries[index]?.kind !== 'markdown-region' || prior.entries[index]?.sha256 !== sha256(region.bytes))) {
                return refuse('GENERATED_STALE_ARTIFACT_DRIFT', 'troubleshooting reference region or foreign preimage is not authenticated', path)
            }
            if (!mutation) {
                if (sha256(region.bytes) !== declaration.regionSha256 || current.sha256 !== declaration.postimageSha256) {
                    return refuse('GENERATED_PUBLICATION_FAILED', 'reference plan omitted a required troubleshooting region write', path)
                }
            } else {
                let nextDocument: string
                try { nextDocument = mutation.bytes! } catch { return refuse('GENERATED_PUBLICATION_FAILED', 'troubleshooting postimage is invalid', path) }
                const nextRegion = troubleshootingRegion(nextDocument)
                if (!nextRegion || nextRegion.prefix !== region.prefix || nextRegion.suffix !== region.suffix
                    || sha256(nextRegion.bytes) !== declaration.regionSha256 || mutation.sha256 !== declaration.postimageSha256) {
                    return refuse('GENERATED_PUBLICATION_FAILED', 'troubleshooting write would change foreign bytes or differs from its declared region', path)
                }
            }
        }
        checks.push(Object.freeze({ path, expected, maxBytes: current.kind === 'file' ? Math.max(1, current.bytes.byteLength) : 1, ...(current.kind === 'file' ? { identity: current.identity } : {}) }))
    }
    checks.push(Object.freeze({ path: REFERENCE_OWNERSHIP_PATH, expected: ledgerState, maxBytes: ledger.kind === 'file' ? Math.max(1, ledger.bytes.byteLength) : 1, ...(ledger.kind === 'file' ? { identity: ledger.identity } : {}) }))
    if (ledger.kind !== 'file' || ledger.sha256 !== sha256(captured.nextLedgerBytes)) mutations.push(Object.freeze({ path: REFERENCE_OWNERSHIP_PATH, phase: 'ledger', operation: 'write-file',
        bytes: captured.nextLedgerBytes, sha256: sha256(captured.nextLedgerBytes), expected: ledgerState }))
    const groups = groupMutations(mutations)
    const count = groups?.reduce((total, group) => total + group.logicalWeight, 0) ?? 0
    if (!groups || count > REFERENCE_PATHS.length + 1 || count * PUBLICATION_HELPER_CALLS_PER_GROUP * PUBLICATION_HELPER_SLOT_MS > TRANSACTION_TIMEOUT_MS) {
        return refuse('GENERATED_PUBLICATION_FAILED', 'reference publication exceeds the bounded helper schedule', 'references')
    }
    const ordered = Object.freeze(groups.flatMap(group => group.mutations))
    const changes = Object.freeze(ordered.map(row => Object.freeze({ operation: 'write' as const, path: row.path })))
    const plan = Object.freeze({ changes })
    issuedPlans.set(plan, Object.freeze({ root: authority.root, rootIdentity: captured.rootIdentity, node, mutations: ordered, groups, changes,
        checks: Object.freeze(checks), referenceBootstrap: bootstrap }))
    return Object.freeze({ kind: 'complete', plan })
}

async function admitBootstrapPlan(
    input: BootstrapPublicationPlanInput,
    adapters: PublicationAdapters,
): Promise<PublicationRefusal | Readonly<{ kind: 'complete'; plan: PublicationPlan }>> {
    const supplied = ownRecord(input)
    if (!supplied || !exactKeys(supplied, ['mode', 'root', 'rootIdentity', 'node', 'inspected', 'mutations']) || supplied.mode !== 'bootstrap'
        || !isInspectedBootstrapOutputs(supplied.inspected)) {
        return refuse('GENERATED_PUBLICATION_FAILED', 'bootstrap publication input is not an exact bounded plan', 'generated-environment')
    }
    const serializable = snapshotGeneratedJson({ mode: supplied.mode, root: supplied.root, rootIdentity: supplied.rootIdentity,
        node: supplied.node, mutations: supplied.mutations }) as unknown as Omit<BootstrapPublicationPlanInput, 'inspected'> | undefined
    if (!serializable || serializable.mode !== 'bootstrap' || !isAbsolute(serializable.root) || resolve(serializable.root) !== serializable.root
        || !directoryIdentity(serializable.rootIdentity)
        || !serializable.node || !isAbsolute(serializable.node.canonicalPath) || !SHA256.test(serializable.node.sha256)
        || !Array.isArray(serializable.mutations) || serializable.mutations.length > MAX_OWNED_FILES) {
        return refuse('GENERATED_PUBLICATION_FAILED', 'bootstrap publication input is not an exact bounded plan', 'generated-environment')
    }
    const { node } = serializable
    const inspected = supplied.inspected as InspectedBootstrapOutputs
    const desired: readonly SurfaceDesiredEntry[] = Object.freeze(inspected.files.map(file => Object.freeze({
        kind: 'file' as const, path: file.path, harnesses: [inspected.target] as [typeof inspected.target], scope: 'always' as const,
        capability: 'instructed' as const, writer: 'cockpit' as const, schemaVersion: 1 as const,
        ownership: 'whole-file' as const, bytes: file.bytes, sha256: file.sha256,
    })))
    const mutations = [...serializable.mutations]
    if (mutations.length > desired.length || new Set(mutations.map(row => row.path)).size !== mutations.length
        || mutations.some(row => !exactPath(serializable.root, row.path) || row.phase !== 'desired' || row.operation !== 'write-file'
            || typeof row.bytes !== 'string' || row.sha256 !== sha256(row.bytes))) {
        return refuse('GENERATED_PUBLICATION_FAILED', 'bootstrap publication contains an undeclared or non-exact operation', 'generated-environment')
    }
    const paths = desired.map(entry => entry.path)
    if (!portablePublicationPaths(paths) || mutations.some(row => !paths.includes(row.path))) {
        return refuse('GENERATED_PUBLICATION_FAILED', 'bootstrap publication operation is outside the selected target output set', 'generated-environment')
    }
    const reads = await readAnchoredBatches(serializable.root,
        [...paths.map(path => ({ path, action: 'read-entry' as const, maxBytes: MAX_GENERATED_BYTES })),
            { path: OWNERSHIP_PATH, action: 'read-entry' as const, maxBytes: MAX_OWNERSHIP_BYTES }], node, adapters)
    if (!reads || reads.kind !== 'complete' || reads.results.length !== paths.length + 1) {
        return refuse('GENERATED_PUBLICATION_FAILED', 'bootstrap destinations could not be classified safely', 'generated-environment')
    }
    const ledger = reads.results[paths.length]!
    if (ledger.kind !== 'missing') return refuse('GENERATED_OWNERSHIP_INVALID', 'bootstrap publication cannot replace ownership metadata', OWNERSHIP_PATH)
    const checks: PublicationCheck[] = []
    for (const [index, entry] of desired.entries()) {
        if (entry.kind !== 'file') return refuse('GENERATED_PUBLICATION_FAILED', 'bootstrap output is not a whole file', entry.path)
        const current = reads.results[index]!
        if (current.kind === 'complete' || current.kind === 'invalid' || current.kind === 'other' || current.kind === 'symlink') {
            return refuse('GENERATED_PUBLICATION_FAILED', 'bootstrap destination is not an anchored regular file or missing', entry.path)
        }
        const expected = expectedState(current)
        if (!expected) return refuse('GENERATED_PUBLICATION_FAILED', 'bootstrap destination state is unknown', entry.path)
        const mutation = mutations.find(row => row.path === entry.path)
        if (mutation && (!sameExpected(expected, mutation.expected) || mutation.bytes !== entry.bytes || mutation.sha256 !== entry.sha256)) {
            return refuse('GENERATED_SOURCE_CHANGED', 'bootstrap destination or postimage changed after classification', entry.path)
        }
        if (current.kind === 'missing' ? !mutation : current.kind !== 'file' || current.sha256 !== entry.sha256 || mutation !== undefined) {
            return refuse('GENERATED_PUBLICATION_FAILED', 'bootstrap plan must write each missing output and preserve each exact output', entry.path)
        }
        checks.push(Object.freeze({ path: entry.path, expected, maxBytes: current.kind === 'file' ? Math.max(1, current.bytes.byteLength) : 1,
            ...(current.kind === 'file' ? { identity: current.identity } : {}) }))
    }
    checks.push(Object.freeze({ path: OWNERSHIP_PATH, expected: Object.freeze({ kind: 'missing' as const }), maxBytes: 1 }))
    const groups = groupMutations(mutations)
    const count = groups?.reduce((total, group) => total + group.logicalWeight, 0) ?? 0
    if (!groups || count > desired.length || count * PUBLICATION_HELPER_CALLS_PER_GROUP * PUBLICATION_HELPER_SLOT_MS > TRANSACTION_TIMEOUT_MS) {
        return refuse('GENERATED_PUBLICATION_FAILED', 'bootstrap publication exceeds the bounded helper schedule', 'generated-environment')
    }
    const ordered = Object.freeze(groups.flatMap(group => group.mutations))
    const changes = Object.freeze(ordered.map(row => Object.freeze({ operation: 'write' as const, path: row.path })))
    const plan = Object.freeze({ changes })
    issuedPlans.set(plan, Object.freeze({ root: serializable.root, rootIdentity: serializable.rootIdentity, node,
        mutations: ordered, groups, changes, checks: Object.freeze(checks) }))
    return Object.freeze({ kind: 'complete', plan })
}

async function planCurrent(record: PublicationRecord, adapters: PublicationAdapters, deadline?: number, published = false): Promise<boolean> {
    if (record.referenceBootstrap && !await revalidateReferenceBootstrap(record.referenceBootstrap, adapters, deadline)) return false
    const checks = published ? record.checks.filter(row => !record.mutations.some(mutation => mutation.path === row.path)) : record.checks
    const reads = await readAnchoredBatches(record.root, checks.map(row => ({ path: row.path, action: 'read-entry', maxBytes: row.maxBytes })), record.node, adapters, deadline)
    return reads?.kind === 'complete' && reads.results.length === checks.length && reads.results.every((read, index) => {
        if (read.kind === 'complete') return false
        const expected = checks[index]!
        const state = expectedState(read)
        return state !== undefined && sameExpected(state, expected.expected)
            && (!expected.identity || read.kind === 'file' && sameIdentity(read.identity, expected.identity))
    })
}

/** Admit exact classified leaves against the observed durable ledger, never raw delete authority. */
export async function admitPublicationPlan(input: AdmittedPublicationPlanInput, adapters: PublicationAdapters): Promise<PublicationRefusal | Readonly<{ kind: 'complete'; plan: PublicationPlan }>> {
    try { return await admitPlan(input, adapters) } catch {
        return refuse('GENERATED_PUBLICATION_FAILED', 'publication input, ownership or target observation could not be authenticated', 'generated-environment')
    }
}

async function admitPlan(input: AdmittedPublicationPlanInput, adapters: PublicationAdapters): Promise<PublicationRefusal | Readonly<{ kind: 'complete'; plan: PublicationPlan }>> {
    const supplied = ownRecord(input)
    if (supplied?.mode === 'bootstrap') return admitBootstrapPlan(input as BootstrapPublicationPlanInput, adapters)
    const rawBootstrap = supplied?.referenceBootstrap as ReferenceBootstrap | undefined
    const serializable = supplied && Object.fromEntries(Object.entries(supplied).filter(([key]) => key !== 'referenceBootstrap'))
    const captured = snapshotGeneratedJson(serializable) as unknown as PublicationPlanInput | undefined
    const fields = ownRecord(captured)
    if (!captured || !fields || !exactKeys(fields, ['authority', 'generation', 'sourceSha256', 'rootIdentity', 'node', 'mode', 'ledgerExpected', 'nextLedgerBytes', 'mutations',
        ...(Object.hasOwn(fields, 'surfaceActions') ? ['surfaceActions'] : []), ...(Object.hasOwn(fields, 'references') ? ['references'] : [])])
        || !supplied || !exactKeys(supplied, [...Object.keys(fields), ...(Object.hasOwn(supplied, 'referenceBootstrap') ? ['referenceBootstrap'] : [])])
        || !['sync', 'uninstall', 'forget', 'reference'].includes(captured.mode)
        || !captured.authority || !isAbsolute(captured.authority.root)
        || dirname(captured.authority.configPath) !== captured.authority.root
        || !SHA256.test(captured.generation) || !SHA256.test(captured.sourceSha256)
        || !directoryIdentity(captured.rootIdentity) || !Array.isArray(captured.mutations) || captured.mutations.length > MAX_OWNED_FILES
        || !captured.node || !isAbsolute(captured.node.canonicalPath) || !SHA256.test(captured.node.sha256)) {
        return refuse('GENERATED_PUBLICATION_FAILED', 'publication input is not a bounded exact plan', 'generated-environment')
    }
    const { authority, node, mode } = captured
    if (mode === 'reference') return admitReferencePlan(captured, rawBootstrap, adapters)
    const ledger = await readAnchoredEntry(authority.root, OWNERSHIP_PATH, MAX_OWNERSHIP_BYTES, node, adapters)
    const ledgerState = expectedState(ledger)
    if (!ledgerState || !captured.ledgerExpected || !sameExpected(ledgerState, captured.ledgerExpected)) {
        return refuse('GENERATED_OWNERSHIP_INVALID', 'generated ownership metadata changed after observation', OWNERSHIP_PATH)
    }
    let prior: OwnershipManifest | undefined
    if (ledger.kind === 'file') {
        let parsed
        try { parsed = parseOwnershipManifest(new TextDecoder('utf-8', { fatal: true }).decode(ledger.bytes), authority) } catch { /* Invalid bytes refuse below. */ }
        if (!parsed || parsed.kind !== 'complete') return refuse('GENERATED_OWNERSHIP_INVALID', 'publication requires authenticated ownership metadata', OWNERSHIP_PATH)
        prior = parsed.manifest
    } else if (ledger.kind !== 'missing' || mode === 'uninstall' || mode === 'forget') {
        return refuse('GENERATED_OWNERSHIP_MISSING', 'removal requires durable ownership metadata', OWNERSHIP_PATH)
    }
    let next: OwnershipManifest | undefined
    if (captured.nextLedgerBytes !== null) {
        const parsed = parseOwnershipManifest(captured.nextLedgerBytes, authority)
        if (parsed.kind !== 'complete' || parsed.manifest.generation !== captured.generation || parsed.manifest.source.sha256 !== captured.sourceSha256
            || mode === 'uninstall' || mode === 'forget') return refuse('GENERATED_OWNERSHIP_INVALID', 'publication ledger does not match its declared authority', OWNERSHIP_PATH)
        next = parsed.manifest
    } else if (mode !== 'uninstall' && mode !== 'forget') return refuse('GENERATED_OWNERSHIP_INVALID', 'publication requires its complete resulting ledger', OWNERSHIP_PATH)
    const priorProjection = prior && projectGeneratedPathFacts(prior, authority, [])
    if (priorProjection && priorProjection.kind !== 'complete') return refuse('GENERATED_OWNERSHIP_INVALID', 'publication requires authenticated prior ownership facts', OWNERSHIP_PATH)
    const nextProjection = next && projectGeneratedPathFacts(next, authority, [])
    if (nextProjection && nextProjection.kind !== 'complete') return refuse('GENERATED_OWNERSHIP_INVALID', 'publication requires authenticated resulting ownership facts', OWNERSHIP_PATH)
    const priorFacts = new Map(priorProjection?.facts.map(fact => [fact.path, fact]))
    const nextFacts = new Map(nextProjection?.facts.map(fact => [fact.path, fact]))
    // Only an unchanged authenticated estate can authorize restoration of corrupt bytes.
    const restorationEstate = mode === 'sync' && prior?.format === 'cockpit-generated-ownership/v3'
        && next?.format === 'cockpit-generated-ownership/v3' && prior.cockpitId === next.cockpitId
        && prior.generation === next.generation && prior.source.path === next.source.path && prior.source.sha256 === next.source.sha256
        && prior.personaSource.path === next.personaSource.path && prior.personaSource.sha256 === next.personaSource.sha256
        && prior.producer !== null && next.producer !== null && prior.producer.package === next.producer.package
        && prior.producer.version === next.producer.version && prior.producer.sourceRevision === next.producer.sourceRevision
        && isDeepStrictEqual(prior.entries, next.entries)
    const references = captured.references ?? []
    if (!Array.isArray(references) || references.length !== 0) return refuse('GENERATED_PUBLICATION_FAILED', 'consumer publication cannot declare maintainer reference destinations', 'references')
    const mutations = [...captured.mutations]
    if (!portablePublicationPaths(mutations.map(row => row.path))) return refuse('GENERATED_PUBLICATION_FAILED', 'generated output names alias or cannot be transferred between supported filesystems; rename the declared outputs and rerun cockpit sync --dry-run', 'generated-environment')
    if (new Set(mutations.map(row => row.path)).size !== mutations.length
        || mutations.some(row => !exactPath(authority.root, row.path) || row.path === OWNERSHIP_PATH || row.phase === 'ledger'
            || !['desired', 'stale'].includes(row.phase) || !['write-file', 'write-symlink', 'remove-file', 'remove-symlink'].includes(row.operation))
        || mode === 'forget' && mutations.length !== 0) {
        return refuse('GENERATED_PUBLICATION_FAILED', 'publication contains an undeclared or non-exact operation', 'generated-environment')
    }
    const paths = mode === 'forget' ? [] : [...new Set([...(prior?.entries ?? []).map(row => row.path), ...(next?.entries ?? []).map(row => row.path)])].sort(compareCodeUnits)
    if (!portablePublicationPaths(paths)) return refuse('GENERATED_PUBLICATION_FAILED', 'generated output names alias or cannot be transferred between supported filesystems; rename the declared outputs and rerun cockpit sync --dry-run', 'generated-environment')
    if (mutations.some(row => !paths.includes(row.path))) return refuse('GENERATED_PUBLICATION_FAILED', 'publication operation is absent from both ownership ledgers', 'generated-environment')
    // Sizes allocate bounded batches; anchored reads still authenticate every target and refuse growth.
    const maxBytes = await Promise.all(paths.map(async path => {
        if (!exactPath(authority.root, path)) return undefined
        try {
            const status = await lstat(join(authority.root, path))
            if (!status.isFile() || status.isSymbolicLink()) return 1
            if (!Number.isSafeInteger(status.size) || status.size < 0) return undefined
            return Math.min(MAX_GENERATED_BYTES, Math.max(1, status.size))
        } catch (error) {
            return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 1 : undefined
        }
    }))
    if (maxBytes.some(limit => limit === undefined)) return refuse('GENERATED_PUBLICATION_FAILED', 'publication targets could not be classified safely', 'generated-environment')
    const reads = await readAnchoredBatches(authority.root, paths.map((path, index) => ({ path, action: 'read-entry', maxBytes: maxBytes[index]! })), node, adapters)
    if (!reads || reads.kind !== 'complete' || reads.results.length !== paths.length) return refuse('GENERATED_PUBLICATION_FAILED', 'publication targets could not be classified safely', 'generated-environment')
    const checks: PublicationCheck[] = []
    for (const [index, path] of paths.entries()) {
        const current = reads.results[index]!
        if (current.kind === 'complete') return refuse('GENERATED_PUBLICATION_FAILED', 'publication observation has the wrong kind', path)
        const expected = expectedState(current)
        if (!expected) return refuse('GENERATED_PUBLICATION_FAILED', 'publication target kind is unknown', path)
        const previous = prior?.entries.find(row => row.path === path)
        const desired = next?.entries.find(row => row.path === path)
        const priorFact = priorFacts.get(path)
        const nextFact = nextFacts.get(path)
        if (previous && !priorFact || desired && !nextFact) return refuse('GENERATED_OWNERSHIP_INVALID', 'publication target lacks authenticated ownership facts', path)
        const mutation = mutations.find(row => row.path === path)
        if (mutation && !sameExpected(expected, mutation.expected)) return refuse('GENERATED_SOURCE_CHANGED', 'publication target changed after classification', path)
        const priorState = previous && classifyEntry(priorFact, current)
        const restoration = restorationEstate && priorState === 'modified' && current.kind === 'file'
            && previous?.kind === 'file' && desired?.kind === 'file' && mutation?.phase === 'desired'
            && mutation.operation === 'write-file' && mutation.sha256 === previous.sha256
        if (previous && current.kind !== 'missing' && priorState !== 'unchanged' && !restoration) return refuse('GENERATED_STALE_ARTIFACT_DRIFT', 'owned target has changed or its confinement is unknown', path)
        if (!mutation) {
            if (desired ? classifyEntry(nextFact, current) !== 'unchanged' : current.kind !== 'missing') {
                return refuse('GENERATED_PUBLICATION_FAILED', 'complete publication plan omitted a required operation', path)
            }
        } else if (!desired) {
            if (!previous || priorState !== 'unchanged' || mutation.phase !== 'stale') return refuse('GENERATED_PUBLICATION_FAILED', 'destructive operation lacks exact classified prior ownership', path)
            if (previous.kind === 'shared-region' && current.kind === 'file') {
                const removed = removeSharedOwnership(new TextDecoder('utf-8', { fatal: true }).decode(current.bytes), previous, prior)
                if (removed.kind !== 'complete' || mutation.operation !== 'write-file' || mutation.bytes !== removed.bytes
                    || mutation.sha256 !== sha256(removed.bytes)) return refuse('GENERATED_PUBLICATION_FAILED', 'shared removal must preserve the exact foreign postimage', path)
            } else if (mutation.operation !== (previous.kind === 'symlink' ? 'remove-symlink' : 'remove-file')) {
                return refuse('GENERATED_PUBLICATION_FAILED', 'removal does not name the exact owned leaf kind', path)
            }
        } else {
            if (mutation.phase !== 'desired' || mutation.operation.startsWith('remove-') || !previous && current.kind !== 'missing' && desired.kind !== 'shared-region') {
                return refuse('GENERATED_PUBLICATION_FAILED', 'write destination lacks applicable ownership', path)
            }
            if (desired.kind === 'symlink') {
                if (mutation.operation !== 'write-symlink' || mutation.target !== desired.target) return refuse('GENERATED_PUBLICATION_FAILED', 'symlink publication differs from its exact declaration', path)
            } else {
                if (mutation.operation !== 'write-file' || typeof mutation.bytes !== 'string' || Buffer.byteLength(mutation.bytes) > MAX_GENERATED_BYTES
                    || mutation.sha256 !== sha256(mutation.bytes)) return refuse('GENERATED_PUBLICATION_FAILED', 'file publication has invalid bounded bytes', path)
                const post = { kind: 'file' as const, bytes: Buffer.from(mutation.bytes), sha256: mutation.sha256, identity: current.kind === 'file' ? current.identity
                    : { root: captured.rootIdentity, chain: [], file: captured.rootIdentity }, mode: 0o600 }
                if (classifyEntry(nextFact, post) !== 'unchanged') return refuse('GENERATED_PUBLICATION_FAILED', 'write postimage differs from its declared ownership', path)
                if (desired.kind === 'shared-region') {
                    const before = current.kind === 'file' ? new TextDecoder('utf-8', { fatal: true }).decode(current.bytes) : desired.region.format === 'opencode-json-root-properties' ? '{}' : ''
                    const action = captured.surfaceActions?.find(row => row.path === path)
                    if (!action || action.kind !== 'write' || action.desired.kind !== 'shared-region') return refuse('GENERATED_PUBLICATION_FAILED', 'shared write requires its admitted surface action', path)
                    const rendered = renderSharedPostimage(before, action.desired, previous)
                    if (rendered.kind !== 'complete' || rendered.bytes !== mutation.bytes || action.postimage !== mutation.bytes) return refuse('GENERATED_PUBLICATION_FAILED', 'shared write would change foreign bytes', path)
                }
            }
        }
        checks.push(Object.freeze({ path, expected, maxBytes: current.kind === 'file' ? Math.max(1, current.bytes.byteLength) : 1, ...(current.kind === 'file' ? { identity: current.identity } : {}) }))
    }
    checks.push(Object.freeze({ path: OWNERSHIP_PATH, expected: ledgerState, maxBytes: ledger.kind === 'file' ? Math.max(1, ledger.bytes.byteLength) : 1, ...(ledger.kind === 'file' ? { identity: ledger.identity } : {}) }))
    if (captured.nextLedgerBytes === null) mutations.push(Object.freeze({ path: OWNERSHIP_PATH, phase: 'ledger', operation: 'remove-file', expected: ledgerState }))
    else if (ledger.kind !== 'file' || ledger.sha256 !== sha256(captured.nextLedgerBytes)) mutations.push(Object.freeze({ path: OWNERSHIP_PATH, phase: 'ledger', operation: 'write-file',
        bytes: captured.nextLedgerBytes, sha256: sha256(captured.nextLedgerBytes), expected: ledgerState }))
    const groups = groupMutations(mutations)
    const count = groups?.reduce((total, group) => total + group.logicalWeight, 0) ?? 0
    if (!groups || count > MAX_OWNED_FILES + 1 || count * PUBLICATION_HELPER_CALLS_PER_GROUP * PUBLICATION_HELPER_SLOT_MS > TRANSACTION_TIMEOUT_MS) {
        return refuse('GENERATED_PUBLICATION_FAILED', 'generated publication exceeds the bounded helper schedule', 'generated-environment')
    }
    const ordered = Object.freeze(groups.flatMap(group => group.mutations))
    const staleRemoval = staleRemovalRequest({ cockpitId: authority.cockpitId, generation: captured.generation, sourceSha256: captured.sourceSha256 }, ordered)
    if (ordered.some(row => row.phase === 'stale') && !staleRemoval) return refuse('GENERATED_STALE_APPROVAL_INVALID', 'stale operations cannot be bound to exact current identities', 'generated-environment')
    const changes = Object.freeze(ordered.map(row => Object.freeze({ operation: row.operation.startsWith('remove-') ? 'remove' as const : 'write' as const, path: row.path })))
    const plan = Object.freeze({ changes, ...(staleRemoval ? { staleRemoval } : {}) })
    issuedPlans.set(plan, Object.freeze({ root: authority.root, rootIdentity: captured.rootIdentity, node, mutations: ordered, groups, changes, checks: Object.freeze(checks), ...(staleRemoval ? { staleRemoval } : {}) }))
    return Object.freeze({ kind: 'complete', plan })
}

export async function runPublicationPlan(plan: PublicationPlan, adapters: PublicationRunAdapters): Promise<PublicationOutcome> {
    try { return await runPlan(plan, adapters) } catch {
        return refuse('GENERATED_PUBLICATION_FAILED', 'publication owner revalidation failed', 'generated-environment')
    }
}

async function runPlan(plan: PublicationPlan, adapters: PublicationRunAdapters): Promise<PublicationOutcome> {
    const record = plan && issuedPlans.get(plan)
    if (!record || consumedPlans.has(plan)) return refuse('GENERATED_PUBLICATION_FAILED', 'publication requires a current owner-issued plan', 'generated-environment')
    if (adapters.dryRun) {
        const current = await adapters.revalidate(undefined, 'preview')
        if (current !== true) return typeof current === 'object' ? current : refuse('GENERATED_SOURCE_CHANGED', 'publication preview inputs changed', 'generated-environment')
        if (!await planCurrent(record, adapters)) return refuse('GENERATED_SOURCE_CHANGED', 'publication preview identities changed', 'generated-environment')
        return Object.freeze({ kind: 'complete', changes: record.changes, committedPaths: Object.freeze([]), ...(record.staleRemoval ? { staleRemoval: record.staleRemoval } : {}) })
    }
    consumedPlans.add(plan)
    if (record.staleRemoval && !await staleRemovalApproved(record.staleRemoval, adapters)) return refuse('GENERATED_STALE_APPROVAL_REQUIRED', 'stale generated ownership requires independent approval bound to the exact current entries',
        record.staleRemoval.entries[0]!.path, `review dry-run stale-removal digest ${record.staleRemoval.digest} before retrying through an approved operator boundary`)
    return applyPrepared(record, adapters)
}

async function applyPrepared(
    prepared: PublicationRecord,
    adapters: PublicationRunAdapters,
): Promise<PublicationOutcome> {
    const { mutations: publicationMutations, groups } = prepared
    const publicationFiles: readonly OwnedBytes[] = Object.freeze(publicationMutations.filter(row => row.operation === 'write-file')
        .map(row => Object.freeze({ path: row.path, bytes: row.bytes!, sha256: row.sha256! })))
    const logicalGroupCount = groups.reduce((count, group) => count + group.logicalWeight, 0)
    const transactionDeadline = Date.now() + TRANSACTION_TIMEOUT_MS
    const forwardCutoff = transactionDeadline - logicalGroupCount * PUBLICATION_HELPER_SLOT_MS
    let forwardCallsRemaining = logicalGroupCount * (PUBLICATION_HELPER_CALLS_PER_GROUP - 1)
    const nextForwardDeadline = (calls = 1): number | undefined => {
        if (!Number.isSafeInteger(calls) || calls < 1 || calls > forwardCallsRemaining) return undefined
        forwardCallsRemaining -= calls
        return forwardCutoff - forwardCallsRemaining * PUBLICATION_HELPER_SLOT_MS
    }
    const node = prepared.node
    if (publicationMutations.length === 0) {
        const transactionRootCurrent = async (): Promise<boolean> => {
            const current = await lstat(prepared.root)
            return current.isDirectory() && !current.isSymbolicLink()
                && current.dev === prepared.rootIdentity.dev && current.ino === prepared.rootIdentity.ino
        }
        if (Date.now() >= forwardCutoff || !await transactionRootCurrent()) {
            return refuse('GENERATED_SOURCE_CHANGED', 'generated transaction root changed or its deadline expired', 'generated-environment')
        }
        // Without writes, final canonical validation and exact admitted identities suffice.
        const current = await adapters.revalidate(forwardCutoff, 'after-publish')
        if (current !== true) return typeof current === 'object' ? current : refuse('GENERATED_SOURCE_CHANGED', 'generated inputs changed during unchanged publication', 'generated-environment')
        if (Date.now() >= forwardCutoff || !await planCurrent(prepared, adapters, forwardCutoff)
            || !await transactionRootCurrent() || Date.now() >= forwardCutoff) {
            return refuse('GENERATED_SOURCE_CHANGED', 'generated inputs or target identities changed during unchanged publication', 'generated-environment')
        }
        return Object.freeze({ kind: 'complete', changes: prepared.changes, committedPaths: Object.freeze([]) })
    }
    const staged = await stageInputs(publicationFiles)
    if (!node || !staged) return refuse('GENERATED_PUBLICATION_FAILED', 'generated publication authority could not be prepared', 'generated-environment')
    const applied: AppliedGroup[] = []
    let retainInputs = false
    try {
        const transactionRoot = await lstat(prepared.root)
        const transactionRootIdentity = prepared.rootIdentity
        if (!transactionRoot.isDirectory() || transactionRoot.isSymbolicLink()
            || transactionRoot.dev !== transactionRootIdentity.dev || transactionRoot.ino !== transactionRootIdentity.ino) {
            throw new Error('generated transaction root is unsafe')
        }
        const transactionRootCurrent = async (): Promise<boolean> => {
            const current = await lstat(prepared.root)
            return current.isDirectory() && !current.isSymbolicLink()
                && current.dev === transactionRootIdentity.dev && current.ino === transactionRootIdentity.ino
        }
        if (Date.now() >= forwardCutoff) throw new Error('generated helper schedule exhausted')
        const beforeStage = await adapters.revalidate(forwardCutoff, 'before-stage')
        if (beforeStage !== true) return typeof beforeStage === 'object' ? beforeStage : refuse('GENERATED_SOURCE_CHANGED', 'generated inputs changed before staging', 'generated-environment')
        if (!await planCurrent(prepared, adapters, forwardCutoff)) {
            return refuse('GENERATED_SOURCE_CHANGED', 'generated inputs or target identities changed before staging', 'generated-environment')
        }
        for (const mutation of publicationMutations) if (!confined(prepared.root, mutation.path)) {
            return refuse('GENERATED_PATH_UNSAFE', 'generated destination is not confined', mutation.path)
        }
        for (const group of groups) {
            if (!await transactionRootCurrent()) throw new Error('generated transaction root changed')
            const anchor = await publicationAnchor(prepared.root, group.parent)
            if (!anchor) throw new Error('generated destination parent is unsafe')
            const nonce = randomBytes(16).toString('hex')
            const inputs: Array<Readonly<{ path: string; sha256: string }>> = []
            const entries: PrepareFileEntry[] = []
            for (const mutation of group.mutations) {
                const segments = publicationEntrySegments(group.parent, mutation.path)
                if (!segments) throw new Error('generated destination nesting is unsafe')
                const nested = await nestedPublicationAuthority(
                    group.parent === '.' ? prepared.root : resolve(prepared.root, group.parent),
                    anchor.segments.length === 0,
                    segments,
                )
                if (!nested) throw new Error('generated destination ancestor is unsafe')
                let input: number | null = null
                if (mutation.operation === 'write-file') {
                    const fileIndex = publicationFiles.findIndex(file => file.path === mutation.path)
                    input = inputs.length
                    inputs.push(staged.inputs[fileIndex]!)
                }
                entries.push(Object.freeze({ chain: nested.chain, segments: nested.segments,
                    name: basename(mutation.path), operation: mutation.operation, expected: mutation.expected,
                    sha256: mutation.sha256 ?? null, target: mutation.target ?? null, input }))
            }
            const request = Object.freeze({
                version: 1, nonce, action: 'prepare', identity: anchor.identity, segments: anchor.segments,
                entries: Object.freeze(entries),
            })
            const deadline = nextForwardDeadline(group.logicalWeight)
            if (deadline === undefined) throw new Error('generated helper schedule exhausted')
            const raw = await runHelper(adapters, helperStep(node, anchor.path, group.parent, request, inputs, deadline))
            const receipt = parsePrepareReceipt(raw, nonce, entries)
            const receiptFinal = receipt?.chain.at(-1) ?? anchor.identity
            if (!receipt || receipt.entries.length !== group.mutations.length
                || receipt.chain.length !== anchor.segments.length
                || receipt.chain.some((row, index) => row.name !== anchor.segments[index] || !row.created)
                || receiptFinal.dev !== receipt.identity.dev || receiptFinal.ino !== receipt.identity.ino
                || new Set(receipt.entries.map(entry => [...entry.chain.map(row => row.name), entry.name].join('/'))).size !== receipt.entries.length
                || receipt.entries.some((entry, index) => entry.name !== basename(group.mutations[index]!.path)
                    || entry.operation !== group.mutations[index]!.operation || entry.sha256 !== (group.mutations[index]!.sha256 ?? null)
                    || entry.target !== (group.mutations[index]!.target ?? null))) {
                throw new Error('generated filesystem helper refused publication')
            }
            const current = Object.freeze({
                parent: group.parent,
                path: group.parent === '.' ? prepared.root : resolve(prepared.root, group.parent),
                start: anchor.identity,
                logicalWeight: group.logicalWeight,
                ...receipt,
            })
            applied.push(current)
            if (!await recordRecovery(staged.directory, applied)) throw new Error('generated recovery record could not be persisted')
            if (!await transactionRootCurrent()) throw new Error('generated transaction root changed')
        }
        if (Date.now() >= forwardCutoff) throw new Error('generated helper schedule exhausted')
        const inputsCurrent = await adapters.revalidate(forwardCutoff, 'before-publish')
        if (inputsCurrent !== true || !await planCurrent(prepared, adapters, forwardCutoff) || !await transactionRootCurrent()) {
            if (!await compensate(applied, node, adapters, transactionDeadline)) {
                retainInputs = true
                return refuse(
                    'GENERATED_COMPENSATION_FAILED',
                    'generated inputs changed after preparation and retained backups could not be safely restored; recover retained local backups before retrying',
                    `${applied.at(-1)?.parent ?? 'generated-environment'}; inputs=${staged.directory}`,
                )
            }
            return typeof inputsCurrent === 'object' ? inputsCurrent : refuse('GENERATED_SOURCE_CHANGED', 'a generated input changed immediately before publication', 'generated-environment')
        }
        if (!await runPublicationBatches('validate-batch', prepared.root, transactionRootIdentity, applied,
            node, adapters, nextForwardDeadline)) throw new Error('generated staged identities failed validation')
        if (!await runPublicationBatches('publish-batch', prepared.root, transactionRootIdentity, applied,
            node, adapters, nextForwardDeadline)) throw new Error('generated filesystem helper did not confirm publication')
        if (Date.now() >= forwardCutoff) throw new Error('generated helper schedule exhausted')
        if (await adapters.revalidate(forwardCutoff, 'after-publish') !== true || !await planCurrent(prepared, adapters, forwardCutoff, true)) {
            throw new Error('generated input or unchanged target changed during publication')
        }
        if (!await runPublicationBatches('verify-batch', prepared.root, transactionRootIdentity, applied,
            node, adapters, nextForwardDeadline)) throw new Error('generated postcheck failed')
        // Backup retirement can be partial, so finalization failures retain recovery instead of rolling back.
        const finalized = await runPublicationBatches('commit-batch', prepared.root, transactionRootIdentity, applied,
            node, adapters, nextForwardDeadline).catch(() => false)
        if (!finalized || forwardCallsRemaining !== 0) {
            retainInputs = true
            return refuse(
                'GENERATED_COMPENSATION_FAILED',
                'generated bytes were published but retained backups could not be safely finalized; recover retained local backups before retrying',
                `${applied.at(-1)?.parent ?? 'generated-environment'}; inputs=${staged.directory}`,
            )
        }
        return Object.freeze({ kind: 'complete', changes: prepared.changes, committedPaths: Object.freeze(prepared.changes.map(row => row.path)) })
    } catch {
        if (!await compensate(applied, node, adapters, transactionDeadline)) {
            retainInputs = true
            return refuse(
                'GENERATED_COMPENSATION_FAILED',
                'generated publication failed and prior bytes could not be fully restored; recover retained local backups before retrying',
                `${applied.at(-1)?.parent ?? 'generated-environment'}; inputs=${staged.directory}`,
            )
        }
        return refuse('GENERATED_PUBLICATION_FAILED', 'generated files were not published (filesystem transaction refused)', 'generated-environment')
    } finally {
        if (!retainInputs) await rm(staged.directory, { recursive: true, force: true })
    }
}
