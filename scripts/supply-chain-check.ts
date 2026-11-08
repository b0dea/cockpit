import { execFileSync } from 'node:child_process'
import { cpSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse, YAMLParseError } from 'yaml'
import { packagedDocumentationPages } from './build-cockpit.ts'

// Action pins, injection and permission hygiene in general are zizmor's (.github/workflows/zizmor.yml).
// This detector holds what zizmor cannot know: exact dependency and lock policy, the package
// inventory, which jobs may hold a write scope or publish, and the release workflow's publish safety.

// System errors keep their first message line; anything else gives only its class, because parse
// and child-process messages echo their input.
function errorCause(error: unknown): string {
    if (!(error instanceof Error)) return 'a non-error value was thrown'
    const { code, syscall } = error as NodeJS.ErrnoException
    if (typeof code === 'string' && typeof syscall === 'string') return error.message.split(/\r?\n|\r/, 1)[0]!.slice(0, 240)
    return error instanceof TypeError ? 'TypeError' : error instanceof SyntaxError ? 'SyntaxError' : error instanceof RangeError ? 'RangeError' : 'Error'
}

// A YAML parse message quotes the lines around the failure, and a workflow can hold secrets: name
// the parser's error code and where it stopped, never the text there.
function yamlFailure(error: unknown): string {
    if (!(error instanceof YAMLParseError)) return errorCause(error)
    const at = error.linePos?.[0]
    return at ? `${error.code} at line ${at.line}, column ${at.col}` : error.code
}

type Json = Record<string, any>
interface LockNode { path: string; version?: string; hasInstallScript: boolean; bin: unknown; allowScript?: true }
export interface SupplyChainDiagnostic { readonly code: string; readonly path: string; readonly message: string }

const EXPECTED_PACKAGE_LINKS = Object.freeze({
    repository: { type: 'git', url: 'git+https://github.com/b0dea/cockpit.git', directory: 'packages/cockpit' },
    homepage: 'https://github.com/b0dea/cockpit#readme',
    bugs: { url: 'https://github.com/b0dea/cockpit/issues' },
})
// The reviewed runtime dependencies and every lock node with an install script or a binary. The
// file sits beside this script rather than in the inspected root, so a synthetic root is judged
// against the repository's own review. `--refresh-pins` rewrites it from the lockfile; the review
// is of its diff, and an install script stays unapproved until allowScripts names it.
const PINS_PATH = fileURLToPath(new URL('./supply-chain-pins.json', import.meta.url))
// What a person holds and no file here can prove, listed so a reader does not take a green check to
// cover them. Printed on every run whether or not each has been done.
const OPERATOR_CHECKS = Object.freeze(['package-scope-owner', 'trusted-publisher', 'superseded-minor-deprecation'])
const MINIMUM_COOLDOWN_DAYS = 7
// npm 11 and later hold back a release published less than this many days ago while resolving.
const MINIMUM_RELEASE_AGE_DAYS = 2
const STATIC_PACKAGE_FILES = Object.freeze([
    'CHANGELOG.md',
    'LICENSE',
    'README.md',
    'bin/cockpit.mjs',
    'cockpit.schema.json',
    'libexec/browser-operation.cjs',
    'libexec/fence-marker.cjs',
    'libexec/fence-marker.d.cts',
    'libexec/fenced-group-runner.cjs',
    'libexec/fenced-supervisor.cjs',
    'libexec/generated-filesystem.cjs',
    'libexec/install-filesystem.cjs',
    'libexec/native-selftest-guard.d.mts',
    'libexec/native-selftest-guard.mjs',
    'libexec/native-selftest-input.d.mts',
    'libexec/native-selftest-input.mjs',
    'libexec/rulesync-generator.NOTICE.md',
    'libexec/rulesync-generator.cjs',
    'libexec/surface-generator-worker.cjs',
    'libexec/surface-output-reader.cjs',
    'libexec/surface-scratch-cleanup.cjs',
    'libexec/validate-harness-evidence.d.mts',
    'libexec/validate-harness-evidence.mjs',
    'package.json',
    'surfaces/README.md',
    'surfaces/agents/evaluator.agent.md',
    'surfaces/guards/bash-guard.sh',
    'surfaces/guards/claude.adapter.json',
    'surfaces/guards/codex.adapter.json',
    'surfaces/guards/opencode.adapter.json',
    'surfaces/references/browser.md',
    'surfaces/references/test-data-and-personas.md',
    'surfaces/references/testing-tiers.md',
    'surfaces/skills/cockpit-setup.skill.md',
    'surfaces/skills/cockpit-browser.skill.md',
    'surfaces/skills/collection.json',
    'surfaces/skills/cockpit-explain.skill.md',
    'surfaces/skills/cockpit-fix.skill.md',
    'surfaces/skills/cockpit-work.skill.md',
    'surfaces/skills/procedures/explain.md',
    'surfaces/skills/procedures/fix.md',
    'surfaces/skills/procedures/setup.md',
    'surfaces/skills/procedures/work.md',
])
// The only jobs allowed to hold a write scope, and exactly which ones. Everything else is
// read-only. Widening this list is a security-policy change: review it as one.
// The release workflow splits its grants so the OIDC token is held only by the job that publishes.
const WRITE_GRANTS: Readonly<Record<string, readonly string[]>> = Object.freeze({
    '.github/workflows/release.yml#version': ['contents', 'pull-requests'],
    '.github/workflows/release.yml#publish': ['contents', 'id-token'],
    '.github/workflows/dependabot-automerge.yml#automerge': ['contents', 'pull-requests'],
})
// The only job allowed to publish, or to invoke a repository script that does.
const PUBLICATION_JOB = '.github/workflows/release.yml#publish'
// The Changesets publish action runs `changeset publish` itself when no script is given.
const PUBLICATION_ACTION = /^changesets\/action\/publish@/
const PUBLICATION_COMMAND = /(?:npm\s+(?:publish|login)|(?:changeset|pnpm|yarn)\s+publish|registry\.npmjs\.org)/i
const EXACT_VERSION = /^(?:\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?|workspace:\*)$/
const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const
const DETECTOR_COMMAND = 'node scripts/supply-chain-check.ts'

const diagnostic = (code: string, path: string, message: string): SupplyChainDiagnostic => ({ code, path, message })
const json = (root: string, path: string): Json => JSON.parse(readFileSync(resolve(root, path), 'utf8')) as Json
const compareCodeUnits = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0
const record = (value: unknown): value is Json => value !== null && typeof value === 'object' && !Array.isArray(value)
const sortedRecord = (value: unknown) => record(value) ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => compareCodeUnits(left, right))) : value

function productionTypeScriptSources(root: string): string[] {
    const files: string[] = []
    const visit = (directory: string, prefix = '') => {
        for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => compareCodeUnits(left.name, right.name))) {
            if (entry.isSymbolicLink()) throw new Error(`[PACKAGE_SOURCE_INVALID] source entry is linked: ${join(prefix, entry.name)}`)
            const relativePath = join(prefix, entry.name)
            if (entry.isDirectory()) {
                // Mirrors the exclusions in packages/cockpit/tsconfig.build.json.
                if (relativePath !== 'test-support' && entry.name !== 'fixtures') visit(resolve(directory, entry.name), relativePath)
            } else if (entry.isFile() && relativePath.endsWith('.ts') && !relativePath.endsWith('.test.ts')) {
                files.push(relativePath)
            }
        }
    }
    visit(resolve(root, 'packages/cockpit/src'))
    return files
}

export function expectedPackageFiles(root: string): readonly string[] {
    const generated = productionTypeScriptSources(root).flatMap(path => {
        const stem = path.slice(0, -'.ts'.length)
        return [`dist/${stem}.d.ts`, `dist/${stem}.js`]
    })
    return [...STATIC_PACKAGE_FILES, ...packagedDocumentationPages(root), ...generated].sort(compareCodeUnits)
}

function executableLockNodes(lock: Json): LockNode[] {
    return Object.entries((lock.packages ?? {}) as Record<string, Json>).flatMap(([path, row]) => {
        if (!row || row.hasInstallScript !== true && row.bin === undefined) return []
        return [{ path, version: row.version, hasInstallScript: row.hasInstallScript === true, bin: sortedRecord(row.bin) ?? null }]
    }).sort((left, right) => compareCodeUnits(left.path, right.path))
}

interface ReviewedPins { readonly runtimeDependencies: Readonly<Record<string, string>>; readonly executableLockNodes: readonly LockNode[] }

function reviewedPins(): ReviewedPins {
    const pins: unknown = JSON.parse(readFileSync(PINS_PATH, 'utf8'))
    if (!record(pins) || !record(pins.runtimeDependencies) || !Object.values(pins.runtimeDependencies).every(value => typeof value === 'string')
        || !Array.isArray(pins.executableLockNodes) || !pins.executableLockNodes.every(row => record(row) && typeof row.path === 'string'
            && typeof row.hasInstallScript === 'boolean' && (row.allowScript === undefined || row.allowScript === true))) {
        throw new Error(`[SUPPLY_CHAIN_POLICY_INVALID] ${PINS_PATH} is not the reviewed pin shape; restore it from git and run node scripts/supply-chain-check.ts --refresh-pins`)
    }
    return pins as unknown as ReviewedPins
}

// npm's allowScripts key for an installer lock node: its package name, from the last
// node_modules segment of its path, and its version.
function installerKey(row: LockNode): string {
    const match = /(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)$/.exec(row.path)
    if (!match || !row.hasInstallScript) throw new Error(`[SUPPLY_CHAIN_POLICY_INVALID] ${row.path} is not an installer package`)
    return `${match[1]}@${row.version}`
}

function reviewedAllowScripts(pins: ReviewedPins) {
    return Object.fromEntries(pins.executableLockNodes.flatMap(row => row.allowScript ? [[installerKey(row), true] as const] : [])
        .sort(([left], [right]) => compareCodeUnits(left, right)))
}

// The pins as the lockfile and manifests now state them. An install script is pinned as allowed
// only when the root allowScripts already approves that exact name@version: approving code that
// runs at install time stays a person's edit, so refresh reports it instead of making it.
export function refreshedPins(root: string): Readonly<{ text: string; pending: readonly string[] }> {
    const rootManifest = json(root, 'package.json')
    const approved: Json = record(rootManifest.allowScripts) ? rootManifest.allowScripts : {}
    const pending: string[] = []
    const allowed = new Set<string>()
    const rows = executableLockNodes(json(root, 'package-lock.json')).map(row => {
        // The workspace's own version is read from its manifest: every release moves it, and the
        // lockfile must move with it.
        if (row.path === 'packages/cockpit') return { path: row.path, hasInstallScript: row.hasInstallScript, bin: row.bin }
        if (!row.hasInstallScript) return row
        const key = installerKey(row)
        if (approved[key] === true) {
            allowed.add(key)
            return { ...row, allowScript: true as const }
        }
        pending.push(`${key} has an install script that allowScripts in package.json does not approve: read what it runs, then add "${key}": true to allowScripts and rerun npm run deps:refresh`)
        return row
    })
    for (const [key, value] of Object.entries(approved).sort(([left], [right]) => compareCodeUnits(left, right))) {
        // npm also accepts a bare name or false; cockpit reviews each installer version on its own.
        if (value !== true || !/^(?:@[^/@]+\/)?[^/@]+@[^/@]+$/.test(key)) {
            pending.push(`allowScripts in package.json lists ${key}, but cockpit approves an install script only as an exact "name@version": true entry: replace it`)
        } else if (!allowed.has(key)) {
            pending.push(`allowScripts in package.json approves ${key}, which is not an installer in package-lock.json: remove it`)
        }
    }
    const runtimeDependencies = json(root, 'packages/cockpit/package.json').dependencies ?? {}
    const text = `{\n  "runtimeDependencies": ${JSON.stringify(runtimeDependencies)},\n  "executableLockNodes": [\n${
        rows.map(row => `    ${JSON.stringify(row)}`).join(',\n')}\n  ]\n}\n`
    return { text, pending }
}

function readScript(root: string, script: string): string {
    if (script.includes('..') || lstatSync(resolve(root, script)).isSymbolicLink()) throw new Error('linked or escaping script path')
    return readFileSync(resolve(root, script), 'utf8')
}

function workflowDiagnostics(root: string, rootManifest: Json): SupplyChainDiagnostic[] {
    const diagnostics: SupplyChainDiagnostic[] = []
    let invokesDetector = false
    for (const name of readdirSync(resolve(root, '.github/workflows')).filter(path => /\.ya?ml$/.test(path)).sort()) {
        const path = `.github/workflows/${name}`
        let workflow: unknown
        try { workflow = parse(readScript(root, path)) } catch (error) {
            diagnostics.push(diagnostic('WORKFLOW_INVALID', path, `workflow could not be read or parsed (${yamlFailure(error)})`))
            continue
        }
        if (!record(workflow) || !record(workflow.jobs)) {
            diagnostics.push(diagnostic('WORKFLOW_INVALID', path, 'workflow and its jobs must each be one mapping'))
            continue
        }
        const permissions = workflow.permissions
        // `{}` grants nothing and `contents: read` is the checkout minimum; both are the ceiling every
        // job inherits. Write scopes are granted per job below, never here.
        if (!record(permissions) || Object.keys(permissions).some(key => key !== 'contents')
            || (permissions.contents !== undefined && permissions.contents !== 'read')) {
            diagnostics.push(diagnostic('WORKFLOW_PERMISSIONS_BROAD', path, 'workflow permissions must be {} or exactly contents: read'))
        }
        for (const [jobName, job] of Object.entries(workflow.jobs)) {
            const owner = `${path}#${jobName}`
            if (!record(job) || job.permissions !== undefined && !record(job.permissions) || job.steps !== undefined && !Array.isArray(job.steps)) {
                diagnostics.push(diagnostic('WORKFLOW_INVALID', owner, 'job, its permissions and its steps must be a mapping, a mapping and a sequence'))
                continue
            }
            for (const [scope, value] of Object.entries(job.permissions ?? {})) {
                if (value === 'none' || value === 'read' || value === 'write' && (WRITE_GRANTS[owner] ?? []).includes(scope)) continue
                diagnostics.push(diagnostic('WORKFLOW_PERMISSIONS_BROAD', owner, `job grants ${scope}: ${String(value)}, which is not on the reviewed write allowance`))
            }
            for (const step of (job.steps ?? []) as unknown[]) {
                if (!record(step)) {
                    diagnostics.push(diagnostic('WORKFLOW_INVALID', owner, 'workflow step must be one mapping'))
                    continue
                }
                if (typeof step.run === 'string' && /npm run lint:supply-chain(?:\s|$)/.test(step.run)) invokesDetector = true
                if (owner === PUBLICATION_JOB) continue
                // Changesets action command inputs are scanned like `run`, ignored input names included,
                // so an ignored but dangerous-looking command cannot hide. A repository script named by
                // any of them is scanned too: moving a publish command into a script must not hide it.
                const commands = [step.run, step.with?.script, step.with?.['publish-script'], step.with?.['version-script'], step.with?.publish, step.with?.version]
                    .filter((value): value is string => typeof value === 'string')
                if (typeof step.with?.['publish-script'] === 'string' || typeof step.with?.publish === 'string'
                    || typeof step.uses === 'string' && PUBLICATION_ACTION.test(step.uses)) {
                    diagnostics.push(diagnostic('PUBLICATION_PATH_PRESENT', owner, 'only the release publish job may run a publish command'))
                }
                for (const command of commands) {
                    if (PUBLICATION_COMMAND.test(command)) diagnostics.push(diagnostic('PUBLICATION_PATH_PRESENT', owner, 'only the release publish job may contain a registry or publication command'))
                    for (const script of command.match(/\.github\/scripts\/[A-Za-z0-9_./-]+/g) ?? []) {
                        let body: string
                        try { body = readScript(root, script) } catch (error) {
                            diagnostics.push(diagnostic('WORKFLOW_SCRIPT_INVALID', owner, `invoked script is missing, linked, or outside .github/scripts: ${script} (${errorCause(error)})`))
                            continue
                        }
                        if (PUBLICATION_COMMAND.test(body)) diagnostics.push(diagnostic('PUBLICATION_PATH_PRESENT', script, `script invoked by ${owner} contains a registry or publication command`))
                    }
                }
            }
        }
    }
    if (rootManifest.scripts?.['lint:supply-chain'] !== DETECTOR_COMMAND || !invokesDetector) {
        diagnostics.push(diagnostic('WORKFLOW_LINT_NOT_INVOKED', '.github/workflows', 'CI must invoke the repository supply-chain detector'))
    }
    return diagnostics
}

// The Dependabot cooldown covers only what Dependabot proposes; this covers a person or an agent
// running npm install. Only the value is reported, because an .npmrc can also hold a registry token.
function releaseAgeDiagnostic(root: string): SupplyChainDiagnostic | undefined {
    let text: string
    try { text = readScript(root, '.npmrc') } catch (error) {
        return diagnostic('NPM_RELEASE_AGE_MISSING', '.npmrc', `could not be read (${errorCause(error)}); it must set min-release-age=${MINIMUM_RELEASE_AGE_DAYS}`)
    }
    // npm reads .npmrc as ini, where the last assignment of a key wins.
    const days = text.split(/\r?\n/).flatMap(line => /^\s*min-release-age\s*=\s*(.*?)\s*$/.exec(line)?.[1] ?? []).at(-1)
    if (days !== undefined && /^\d+$/.test(days) && Number(days) >= MINIMUM_RELEASE_AGE_DAYS) return undefined
    return diagnostic('NPM_RELEASE_AGE_MISSING', '.npmrc', `min-release-age must be a whole number of days, at least ${MINIMUM_RELEASE_AGE_DAYS}`)
}

// The release workflow's publish safety and the dependency cooldown, read from the files that
// implement them.
function releaseDiagnostics(root: string): SupplyChainDiagnostic[] {
    const diagnostics: SupplyChainDiagnostic[] = []
    const readYaml = (path: string): unknown => {
        try { return parse(readFileSync(resolve(root, path), 'utf8')) } catch (error) {
            diagnostics.push(diagnostic('RELEASE_CONFIG_UNREADABLE', path, `could not be read or parsed (${yamlFailure(error)})`))
            return undefined
        }
    }
    const workflow = readYaml('.github/workflows/release.yml')
    const jobs = record(workflow) && record(workflow.jobs) ? workflow.jobs : {}
    // Changesets versions nothing for a private package yet still opens a Version Packages pull
    // request, so an ungated version job opens an empty one on every push.
    if (record(jobs.version) && !String(jobs.version.if ?? '').includes("needs.select-mode.outputs.private == 'false'")) {
        diagnostics.push(diagnostic('RELEASE_VERSION_UNGATED', '.github/workflows/release.yml', "the version job must also require needs.select-mode.outputs.private == 'false', or a private package opens an empty Version Packages pull request"))
    }
    const job = jobs.publish
    if (workflow !== undefined && !record(job)) diagnostics.push(diagnostic('RELEASE_JOB_MISSING', '.github/workflows/release.yml', 'the release workflow must define a job named publish'))
    if (record(job)) {
        // The npm trusted publisher names this environment, so the registry refuses an OIDC token
        // minted outside it, and its deployment-branch rule keeps the job on main.
        const environment = record(job.environment) ? job.environment.name : job.environment
        if (environment !== 'npm') {
            diagnostics.push(diagnostic('RELEASE_ENVIRONMENT_MISSING', '.github/workflows/release.yml', 'the publish job must run in the npm deployment environment that the npm trusted publisher names'))
        }
        const steps = (Array.isArray(job.steps) ? job.steps : []).filter(record)
        // Only inputs the steps actually run: a script under an input the action ignores publishes nothing.
        const bodies = steps.flatMap(step => [step.run, step.with?.script].filter((value): value is string => typeof value === 'string'))
        for (const script of new Set(bodies.flatMap(command => command.match(/\.github\/scripts\/[A-Za-z0-9_./-]+/g) ?? []))) {
            try { bodies.push(readScript(root, script)) } catch (error) {
                diagnostics.push(diagnostic('RELEASE_SCRIPT_INVALID', script, `script named by the publish job is missing, linked, or outside .github/scripts: ${errorCause(error)}`))
            }
        }
        const provenance = [job.env, ...steps.map(step => step.env)].filter(record).some(env => String(env.NPM_CONFIG_PROVENANCE) === 'true')
            || bodies.some(body => /--provenance\b/.test(body))
        if (!provenance || job.permissions?.['id-token'] !== 'write') {
            diagnostics.push(diagnostic('RELEASE_PROVENANCE_MISSING', '.github/workflows/release.yml', 'the publish job must publish with provenance (NPM_CONFIG_PROVENANCE or --provenance) and hold id-token: write'))
        }
    }
    const dependabot = readYaml('.github/dependabot.yml')
    const updates: unknown[] = record(dependabot) && Array.isArray(dependabot.updates) ? dependabot.updates : []
    if (dependabot !== undefined && updates.length === 0) diagnostics.push(diagnostic('DEPENDABOT_COOLDOWN_MISSING', '.github/dependabot.yml', 'no update entries to carry a cooldown'))
    updates.forEach((update, index) => {
        const days = record(update) && record(update.cooldown) ? update.cooldown['default-days'] : undefined
        if (!Number.isInteger(days) || days < MINIMUM_COOLDOWN_DAYS) {
            diagnostics.push(diagnostic('DEPENDABOT_COOLDOWN_MISSING', '.github/dependabot.yml', `update entry ${index} needs cooldown.default-days of at least ${MINIMUM_COOLDOWN_DAYS}`))
        }
    })
    const releaseAge = releaseAgeDiagnostic(root)
    if (releaseAge) diagnostics.push(releaseAge)
    return diagnostics
}

export function inspectSupplyChain(root: string, packFiles: unknown): Readonly<{ diagnostics: readonly SupplyChainDiagnostic[]; operatorChecks: readonly string[] }> {
    const diagnostics: SupplyChainDiagnostic[] = []
    const rootManifest = json(root, 'package.json')
    const packageManifest = json(root, 'packages/cockpit/package.json')
    const lock = json(root, 'package-lock.json')
    const pins = reviewedPins()
    for (const [path, manifest] of [['package.json', rootManifest], ['packages/cockpit/package.json', packageManifest]] as const) {
        for (const field of DEPENDENCY_FIELDS) for (const [name, version] of Object.entries(manifest[field] ?? {})) {
            if (typeof version !== 'string' || !EXACT_VERSION.test(version)) diagnostics.push(diagnostic('DEPENDENCY_VERSION_MUTABLE', path, `${field}.${name} must be exact`))
        }
        for (const name of ['preinstall', 'install', 'postinstall']) {
            if (manifest.scripts?.[name]) diagnostics.push(diagnostic('INSTALL_SCRIPT_PRESENT', path, `${name} is not permitted`))
        }
    }
    if (JSON.stringify(packageManifest.dependencies) !== JSON.stringify(pins.runtimeDependencies)) {
        diagnostics.push(diagnostic('RUNTIME_DEPENDENCIES_CHANGED', 'packages/cockpit/package.json', 'runtime dependencies differ from scripts/supply-chain-pins.json; review the change, then run npm run deps:refresh'))
    }
    if (JSON.stringify(packageManifest.bin) !== JSON.stringify({ cockpit: 'bin/cockpit.mjs' })) {
        diagnostics.push(diagnostic('PACKAGE_BIN_CHANGED', 'packages/cockpit/package.json', 'the package must expose only the cockpit binary'))
    }
    if (JSON.stringify({ repository: packageManifest.repository, homepage: packageManifest.homepage, bugs: packageManifest.bugs }) !== JSON.stringify(EXPECTED_PACKAGE_LINKS)) {
        diagnostics.push(diagnostic('PACKAGE_LINKS_CHANGED', 'packages/cockpit/package.json', 'repository, homepage, and issue links must identify the public source and support locations'))
    }
    if (packageManifest.types !== './dist/cli.d.ts' || JSON.stringify(packageManifest.exports) !== JSON.stringify({ '.': { types: './dist/cli.d.ts', import: './dist/cli.js' } })) {
        diagnostics.push(diagnostic('PACKAGE_EXPORTS_CHANGED', 'packages/cockpit/package.json', 'the public import and declaration targets must remain explicit'))
    }
    // The pins file is rewritten even while an installer awaits approval, so the lockfile itself
    // must prove every install script it would run is approved.
    for (const line of refreshedPins(root).pending) diagnostics.push(diagnostic('ALLOW_SCRIPTS_APPROVAL_MISSING', 'package.json', line))
    if (JSON.stringify(sortedRecord(rootManifest.allowScripts)) !== JSON.stringify(reviewedAllowScripts(pins))) {
        diagnostics.push(diagnostic('ALLOW_SCRIPTS_POLICY_MISMATCH', 'package.json', 'allowScripts must exactly match the installers allowed in scripts/supply-chain-pins.json; run npm run deps:refresh, which names each entry to add or remove'))
    }
    const reviewedLockNodes = pins.executableLockNodes.map(({ allowScript: _allowScript, ...row }) =>
        row.path === 'packages/cockpit' ? { path: row.path, version: packageManifest.version, hasInstallScript: row.hasInstallScript, bin: row.bin } : row)
    if (JSON.stringify(executableLockNodes(lock)) !== JSON.stringify(reviewedLockNodes)) {
        diagnostics.push(diagnostic('LOCK_EXECUTABLE_POLICY_CHANGED', 'package-lock.json', 'installer and binary lock nodes differ from scripts/supply-chain-pins.json; run npm run deps:refresh and review its diff'))
    }
    for (const [path, manifest, lockPath] of [['package.json', rootManifest, ''], ['packages/cockpit/package.json', packageManifest, 'packages/cockpit']] as const) {
        const locked = lock.packages?.[lockPath]
        for (const field of DEPENDENCY_FIELDS) {
            const declared = manifest[field] ?? {}
            const recorded = locked?.[field] ?? {}
            for (const name of [...new Set([...Object.keys(declared), ...Object.keys(recorded)])].sort()) {
                if (declared[name] !== recorded[name]) diagnostics.push(diagnostic('LOCKFILE_MISMATCH', path, `${field}.${name} differs from package-lock.json`))
            }
        }
    }
    if (!Array.isArray(packFiles) || packFiles.length === 0) {
        diagnostics.push(diagnostic('PACK_METADATA_MISSING', 'packages/cockpit', 'npm pack metadata was not inspected'))
    } else {
        const expected = expectedPackageFiles(root)
        const packed = new Set(packFiles as string[])
        for (const path of packFiles as string[]) if (!expected.includes(path)) diagnostics.push(diagnostic('PACKAGE_AUDIENCE_LEAK', path, 'packed file is outside the exact consumer inventory'))
        for (const required of expected) if (!packed.has(required)) diagnostics.push(diagnostic('PACKAGE_REQUIRED_FILE_MISSING', required, 'required installed surface is absent'))
        if (packed.size !== packFiles.length) diagnostics.push(diagnostic('PACK_METADATA_INVALID', 'packages/cockpit', 'pack metadata contains duplicate paths'))
    }
    diagnostics.push(...workflowDiagnostics(root, rootManifest), ...releaseDiagnostics(root))
    return { diagnostics, operatorChecks: OPERATOR_CHECKS }
}

export function runSupplyChainCheck(root: string): number {
    // A dry run downloads nothing, and the shared cache can be out of reach in a sandbox, where npm
    // then fails with a cache error that says nothing about the package. A failing run keeps this
    // cache, because the error it prints points at the log inside it.
    const cache = mkdtempSync(join(tmpdir(), 'cockpit-pack-cache-'))
    const output = execFileSync('npm', ['pack', '--json', '--dry-run', '--workspace', '@b00dea/cockpit', '--cache', cache], {
        cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'],
    })
    rmSync(cache, { recursive: true, force: true })
    const decoded: unknown = JSON.parse(output)
    const records = Array.isArray(decoded) ? decoded : record(decoded) ? Object.values(decoded) : []
    if (records.length !== 1 || !Array.isArray(records[0]?.files)
        || !records[0].files.every((file: unknown) => record(file) && typeof file.path === 'string' && file.path.length > 0)) {
        throw new Error('[PACK_METADATA_INVALID] npm pack did not return one artifact inventory')
    }
    const result = inspectSupplyChain(root, records[0].files.map((file: Json) => file.path))
    if (result.diagnostics.length > 0) {
        for (const row of result.diagnostics) process.stderr.write(`${row.code} ${row.path}: ${row.message}\n`)
        return 1
    }
    process.stdout.write(`${JSON.stringify({ status: 'ready', operatorChecks: result.operatorChecks })}\n`)
    return 0
}

export function generateSbom(root: string, output: string): void {
    const temporaryRoot = mkdtempSync(join(tmpdir(), 'cockpit-sbom-input-'))
    try {
        mkdirSync(resolve(temporaryRoot, 'packages/cockpit'), { recursive: true })
        const rootManifest = json(root, 'package.json')
        const packageManifest = json(root, 'packages/cockpit/package.json')
        const lock = json(root, 'package-lock.json')
        // npm 11 cannot form a package URL for an unversioned private workspace root. The
        // compatibility snapshot derives that metadata-only root version from the exact candidate
        // workspace; package declarations and the dependency lock remain unchanged.
        writeFileSync(resolve(temporaryRoot, 'package.json'), `${JSON.stringify({ ...rootManifest, version: packageManifest.version }, null, 2)}\n`)
        writeFileSync(resolve(temporaryRoot, 'package-lock.json'), `${JSON.stringify({
            ...lock, packages: { ...lock.packages, '': { ...lock.packages[''], version: packageManifest.version } },
        }, null, 2)}\n`)
        cpSync(resolve(root, 'packages/cockpit/package.json'), resolve(temporaryRoot, 'packages/cockpit/package.json'))
        const bytes = execFileSync('npm', ['sbom', '--workspace', '@b00dea/cockpit', '--sbom-format', 'cyclonedx', '--package-lock-only', '--cache', join(temporaryRoot, '.cache')],
            { cwd: temporaryRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })
        mkdirSync(dirname(output), { recursive: true })
        writeFileSync(output, bytes)
    } finally {
        rmSync(temporaryRoot, { recursive: true, force: true })
    }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
    const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
    if (process.argv.length === 4 && process.argv[2] === '--sbom') generateSbom(root, resolve(process.argv[3]!))
    else if (process.argv.length === 5 && process.argv[2] === '--inspect') {
        const result = inspectSupplyChain(resolve(process.argv[3]!), JSON.parse(process.argv[4]!))
        process.stdout.write(`${JSON.stringify(result)}\n`)
        if (result.diagnostics.length > 0) process.exitCode = 1
    } else if (process.argv.length === 3 && process.argv[2] === '--refresh-pins') {
        const { text, pending } = refreshedPins(root)
        writeFileSync(PINS_PATH, text)
        process.stdout.write('scripts/supply-chain-pins.json now matches package-lock.json; review its diff\n')
        for (const line of pending) process.stderr.write(`ALLOW_SCRIPTS_REVIEW_NEEDED ${line}\n`)
        if (pending.length > 0) process.exitCode = 1
    } else if (process.argv.length === 2) process.exitCode = runSupplyChainCheck(root)
    else throw new Error('[SUPPLY_CHAIN_USAGE_INVALID] use no arguments, --refresh-pins, --inspect <root> <pack-files-json>, or --sbom <output>')
}
