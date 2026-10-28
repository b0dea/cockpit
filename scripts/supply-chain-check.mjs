import { execFileSync } from 'node:child_process'
import { cpSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'

export const mechanism = {
    id: 'supply-chain-readiness',
    module: 'scripts/supply-chain-check.mjs',
    exports: ['expectedPackageFiles', 'inspectSupplyChain', 'runSupplyChainCheck', 'generateSbom'],
}

const EXPECTED_RUNTIME_DEPENDENCIES = Object.freeze({ 'smol-toml': '1.9.1', yaml: '2.9.1', zod: '4.6.7' })
const EXPECTED_PACKAGE_LINKS = Object.freeze({
    repository: { type: 'git', url: 'git+https://github.com/b0dea/cockpit.git', directory: 'packages/cockpit' },
    homepage: 'https://github.com/b0dea/cockpit#readme',
    bugs: { url: 'https://github.com/b0dea/cockpit/issues' },
})
const REVIEWED_EXECUTABLE_LOCK_NODES = Object.freeze([
    {"path": "node_modules/@changesets/cli", "version": "3.0.3", "hasInstallScript": false, "bin": {"changeset": "bin.js"}},
    {"path": "node_modules/@typescript/old", "version": "6.0.3", "hasInstallScript": false, "bin": {"tsc": "bin/tsc", "tsserver": "bin/tsserver"}},
    {"path": "node_modules/@typescript/typescript6", "version": "6.0.2", "hasInstallScript": false, "bin": {"tsc6": "bin/tsc6"}},
    {"path": "node_modules/esbuild", "version": "0.28.2", "hasInstallScript": true, "bin": {"esbuild": "bin/esbuild"}, "allowScript": true},
    {"path": "node_modules/esprima", "version": "4.0.1", "hasInstallScript": false, "bin": {"esparse": "bin/esparse.js", "esvalidate": "bin/esvalidate.js"}},
    {"path": "node_modules/fsevents", "version": "2.3.3", "hasInstallScript": true, "bin": null, "allowScript": true},
    {"path": "node_modules/gray-matter/node_modules/js-yaml", "version": "3.15.2", "hasInstallScript": false, "bin": {"js-yaml": "bin/js-yaml.js"}},
    {"path": "node_modules/human-id", "version": "4.2.2", "hasInstallScript": false, "bin": {"human-id": "dist/cli.js"}},
    {"path": "node_modules/js-yaml", "version": "5.5.0", "hasInstallScript": false, "bin": {"js-yaml": "bin/js-yaml.mjs"}},
    {"path": "node_modules/nanoid", "version": "3.3.20", "hasInstallScript": false, "bin": {"nanoid": "bin/nanoid.cjs"}},
    {"path": "node_modules/rolldown", "version": "1.2.15", "hasInstallScript": false, "bin": {"rolldown": "bin/cli.mjs"}},
    {"path": "node_modules/rulesync", "version": "41.0.0", "hasInstallScript": false, "bin": {"rulesync": "dist/cli/index.js"}},
    {"path": "node_modules/semver", "version": "7.8.5", "hasInstallScript": false, "bin": {"semver": "bin/semver.js"}},
    {"path": "node_modules/tsx", "version": "4.23.15", "hasInstallScript": false, "bin": {"tsx": "dist/cli.mjs"}},
    {"path": "node_modules/typescript", "version": "7.0.2", "hasInstallScript": false, "bin": {"tsc": "bin/tsc"}},
    {"path": "node_modules/vite", "version": "8.3.5", "hasInstallScript": false, "bin": {"vite": "bin/vite.js"}},
    {"path": "node_modules/vitest", "version": "5.0.5", "hasInstallScript": false, "bin": {"vitest": "vitest.mjs"}},
    {"path": "node_modules/which", "version": "2.0.2", "hasInstallScript": false, "bin": {"node-which": "bin/node-which"}},
    {"path": "node_modules/why-is-node-running", "version": "3.2.1", "hasInstallScript": false, "bin": {"why-is-node-running": "cli.js"}},
    {"path": "node_modules/yaml", "version": "2.9.1", "hasInstallScript": false, "bin": {"yaml": "bin.mjs"}},
    {"path": "packages/cockpit", "version": "0.0.0", "hasInstallScript": false, "bin": {"cockpit": "bin/cockpit.mjs"}},
])
// Only gates no file in this repository can prove. The source-revision stamp, provenance
// and dependency cooldown are checked by `releaseDiagnostics` and are not listed here.
const OPERATOR_GAPS = Object.freeze([
    'package-scope-owner', 'trusted-publisher', 'superseded-minor-deprecation',
])
const MINIMUM_COOLDOWN_DAYS = 7
const STATIC_PACKAGE_FILES = Object.freeze([
    'LICENSE',
    'README.md',
    'bin/cockpit.mjs',
    'cockpit.schema.json',
    'libexec/install-filesystem.cjs',
    'libexec/rulesync-generator.NOTICE.md',
    'libexec/rulesync-generator.cjs',
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
    'surfaces/references/identity-provider-clerk.md',
    'surfaces/references/test-data-and-personas.md',
    'surfaces/references/testing-tiers.md',
    'surfaces/scripts/browser-runner.sh',
    'surfaces/skills/cockpit-setup.skill.md',
    'surfaces/skills/cockpit-browser.skill.md',
    'surfaces/skills/collection.json',
    'surfaces/skills/cockpit-explain.skill.md',
    'surfaces/skills/cockpit-fix.skill.md',
    'surfaces/skills/cockpit-work.skill.md',
    'surfaces/skills/procedures/onboarding.md',
])
// The only jobs allowed to hold a write scope, and exactly which ones. Everything else is
// read-only. Widening this list is a security-policy change: review it as one.
const WRITE_GRANTS = Object.freeze({
    '.github/workflows/release.yml#release': Object.freeze(['contents', 'pull-requests', 'id-token']),
    '.github/workflows/dependabot-automerge.yml#automerge': Object.freeze(['contents', 'pull-requests']),
})
// The only job allowed to publish, or to invoke a repository script that does.
const PUBLICATION_JOBS = new Set(['.github/workflows/release.yml#release'])
const PUBLICATION_COMMAND = /(?:npm\s+(?:publish|login)|(?:changeset|pnpm|yarn)\s+publish|registry\.npmjs\.org)/i
const EXACT_VERSION = /^(?:\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?|workspace:\*)$/

function diagnostic(code, path, message) { return { code, path, message } }
function json(root, path) { return JSON.parse(readFileSync(resolve(root, path), 'utf8')) }
function compareCodeUnits(left, right) { return left < right ? -1 : left > right ? 1 : 0 }

function productionTypeScriptSources(root) {
    const sourceRoot = resolve(root, 'packages/cockpit/src')
    const files = []
    const visit = (directory, prefix = '') => {
        for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => compareCodeUnits(left.name, right.name))) {
            if (entry.isSymbolicLink()) throw new Error(`[PACKAGE_SOURCE_INVALID] source entry is linked: ${join(prefix, entry.name)}`)
            const relativePath = join(prefix, entry.name).replaceAll('\\', '/')
            if (entry.isDirectory()) {
                if (relativePath !== 'test-support') visit(resolve(directory, entry.name), relativePath)
            } else if (entry.isFile() && relativePath.endsWith('.ts') && !relativePath.endsWith('.test.ts')) {
                files.push(relativePath)
            }
        }
    }
    visit(sourceRoot)
    return files
}

export function expectedPackageFiles(root) {
    const generated = productionTypeScriptSources(root).flatMap(path => {
        const stem = path.slice(0, -'.ts'.length)
        return [`dist/${stem}.d.ts`, `dist/${stem}.js`]
    })
    return Object.freeze([...STATIC_PACKAGE_FILES, ...generated].sort(compareCodeUnits))
}

function dependencyEntries(manifest) {
    return ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']
        .flatMap(field => Object.entries(manifest[field] ?? {}).map(([name, version]) => ({ field, name, version })))
}

function executableLockNodes(lock) {
    return Object.entries(lock.packages ?? {}).flatMap(([path, row]) => {
        if (!row || row.hasInstallScript !== true && row.bin === undefined) return []
        const bin = row.bin && typeof row.bin === 'object' && !Array.isArray(row.bin)
            ? Object.fromEntries(Object.entries(row.bin).sort(([left], [right]) => compareCodeUnits(left, right)))
            : row.bin ?? null
        return [{ path, version: row.version, hasInstallScript: row.hasInstallScript === true, bin }]
    }).sort((left, right) => compareCodeUnits(left.path, right.path))
}

function reviewedAllowScripts() {
    return Object.fromEntries(REVIEWED_EXECUTABLE_LOCK_NODES.flatMap(row => {
        if (!row.allowScript) return []
        const match = /(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)$/.exec(row.path)
        if (!match || !row.hasInstallScript) throw new Error('[SUPPLY_CHAIN_POLICY_INVALID] allowed script row is not an installer package')
        return [[`${match[1]}@${row.version}`, true]]
    }).sort(([left], [right]) => compareCodeUnits(left, right)))
}

function sortedRecord(value) {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => compareCodeUnits(left, right)))
        : value
}

function workflowDiagnostics(root, rootManifest) {
    const diagnostics = []
    const directory = resolve(root, '.github/workflows')
    let invokesDetector = false
    const visitedWorkflows = new Set()
    const activeWorkflows = new Set()
    const visitedActions = new Set()
    const activeActions = new Set()
    const emitted = new Set()
    const add = (code, path, message) => {
        const key = `${code}\0${path}\0${message}`
        if (!emitted.has(key)) diagnostics.push(diagnostic(code, path, message))
        emitted.add(key)
    }
    const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
    const contained = (base, candidate) => {
        const fromBase = relative(base, candidate)
        return fromBase !== '' && fromBase !== '..' && !fromBase.startsWith(`..${sep}`) && !fromBase.startsWith('/')
    }
    const hasLinkedComponent = (base, candidate) => {
        let current = base
        for (const component of relative(base, candidate).split(sep).filter(Boolean)) {
            current = resolve(current, component)
            if (lstatSync(current).isSymbolicLink()) return true
        }
        return false
    }
    const canonicalOwnedBase = (base, owner, kind) => {
        try {
            const canonicalRoot = realpathSync(root)
            if (!contained(root, base) || hasLinkedComponent(root, base)) throw new Error('owned directory is linked')
            const stat = lstatSync(base)
            const canonicalBase = realpathSync(base)
            if (!stat.isDirectory() || stat.isSymbolicLink() || !contained(canonicalRoot, canonicalBase)) {
                throw new Error('owned directory is not one contained directory')
            }
            return canonicalBase
        } catch {
            add('WORKFLOW_ACTION_LOCAL_INVALID', owner, `${kind} owned directory is missing, linked, or outside the repository`)
            return undefined
        }
    }
    const canonicalLocal = (reference, base, owner, kind) => {
        if (!reference.startsWith('./') || reference.includes('@')) {
            add('WORKFLOW_ACTION_LOCAL_INVALID', owner, `${kind} local reference is malformed: ${reference}`)
            return undefined
        }
        const candidate = resolve(root, reference)
        try {
            const canonicalBase = canonicalOwnedBase(base, owner, kind)
            if (!canonicalBase) return undefined
            if (!contained(base, candidate) || hasLinkedComponent(base, candidate)) {
                throw new Error('local reference is linked or outside the owned directory')
            }
            const canonicalCandidate = realpathSync(candidate)
            if (!contained(canonicalBase, canonicalCandidate)) {
                add('WORKFLOW_ACTION_LOCAL_INVALID', owner, `${kind} local reference escapes its owned directory or is linked: ${reference}`)
                return undefined
            }
            return canonicalCandidate
        } catch {
            add('WORKFLOW_ACTION_LOCAL_INVALID', owner, `${kind} local reference does not resolve to a canonical entry: ${reference}`)
            return undefined
        }
    }
    const inspectExternal = (reference, owner) => {
        if (!/@[a-f0-9]{40}$/.test(reference)) {
            add('WORKFLOW_ACTION_MUTABLE', owner, `action is not pinned to a full commit: ${reference}`)
        }
    }
    const inspectAction = (reference, owner) => {
        if (!reference.startsWith('./')) return inspectExternal(reference, owner)
        const actionRoot = canonicalLocal(reference, resolve(root, '.github/actions'), owner, 'action')
        if (!actionRoot) return
        let actionStat
        try { actionStat = lstatSync(actionRoot) } catch { actionStat = undefined }
        if (!actionStat?.isDirectory() || actionStat.isSymbolicLink()) {
            add('WORKFLOW_ACTION_LOCAL_INVALID', owner, `local action is not one canonical directory: ${reference}`)
            return
        }
        const manifests = ['action.yml', 'action.yaml'].filter(name => {
            try {
                const path = resolve(actionRoot, name)
                const stat = lstatSync(path)
                return stat.isFile() && !stat.isSymbolicLink()
            } catch { return false }
        })
        if (manifests.length !== 1) {
            add('WORKFLOW_ACTION_LOCAL_INVALID', owner, `local action needs exactly one canonical action.yml or action.yaml: ${reference}`)
            return
        }
        const manifest = resolve(actionRoot, manifests[0])
        if (activeActions.has(manifest)) {
            add('WORKFLOW_ACTION_CYCLE', owner, `local action dependency cycle reaches ${reference}`)
            return
        }
        if (visitedActions.has(manifest)) return
        activeActions.add(manifest)
        try {
            const action = parse(readFileSync(manifest, 'utf8'))
            if (!record(action) || !record(action.runs) || typeof action.runs.using !== 'string') {
                add('WORKFLOW_ACTION_LOCAL_INVALID', owner, `local action manifest is malformed: ${reference}`)
            } else if (action.runs.using === 'composite') {
                if (!Array.isArray(action.runs.steps)) add('WORKFLOW_ACTION_LOCAL_INVALID', owner, `composite action has no steps: ${reference}`)
                else for (const step of action.runs.steps) {
                    if (!record(step)) add('WORKFLOW_ACTION_LOCAL_INVALID', owner, `composite action has a malformed step: ${reference}`)
                    else if (typeof step.uses === 'string') inspectAction(step.uses, owner)
                }
            }
        } catch (error) {
            add('WORKFLOW_ACTION_LOCAL_INVALID', owner, `local action could not be parsed: ${error instanceof Error ? error.message : reference}`)
        } finally {
            activeActions.delete(manifest)
            visitedActions.add(manifest)
        }
    }
    const inspectWorkflowReference = (reference, owner) => {
        if (!reference.startsWith('./')) return inspectExternal(reference, owner)
        const workflowPath = canonicalLocal(reference, resolve(root, '.github/workflows'), owner, 'workflow')
        if (!workflowPath) return
        let stat
        try { stat = lstatSync(workflowPath) } catch { stat = undefined }
        if (!stat?.isFile() || stat.isSymbolicLink() || !/\.ya?ml$/.test(workflowPath)) {
            add('WORKFLOW_ACTION_LOCAL_INVALID', owner, `local reusable workflow is not one canonical YAML file: ${reference}`)
            return
        }
        inspectWorkflow(workflowPath)
    }
    const inspectWorkflow = absolute => {
        // `absolute` is canonical (symlinks resolved), so the root must be too, or a root reached
        // through a symlink such as /tmp yields a `../..` path that matches no job allowance.
        const path = relative(realpathSync(root), absolute).replaceAll('\\', '/')
        if (activeWorkflows.has(absolute)) {
            add('WORKFLOW_ACTION_CYCLE', path, `local reusable workflow dependency cycle reaches ${path}`)
            return
        }
        if (visitedWorkflows.has(absolute)) return
        activeWorkflows.add(absolute)
        let workflow
        try { workflow = parse(readFileSync(absolute, 'utf8')) }
        catch (error) {
            add('WORKFLOW_INVALID', path, `workflow could not be parsed: ${error instanceof Error ? error.message : path}`)
            activeWorkflows.delete(absolute)
            visitedWorkflows.add(absolute)
            return
        }
        if (!record(workflow)) {
            add('WORKFLOW_INVALID', path, 'workflow must be one mapping')
            activeWorkflows.delete(absolute)
            visitedWorkflows.add(absolute)
            return
        }
        const permissions = workflow.permissions
        // `{}` grants nothing and `contents: read` is the checkout minimum; both are the
        // ceiling every job inherits. Write scopes are granted per job below, never here.
        if (!record(permissions) || Object.keys(permissions).some(key => key !== 'contents')
            || (permissions.contents !== undefined && permissions.contents !== 'read')) {
            add('WORKFLOW_PERMISSIONS_BROAD', path, 'workflow permissions must be {} or exactly contents: read')
        }
        if (!record(workflow.jobs)) add('WORKFLOW_INVALID', path, 'workflow jobs must be one mapping')
        for (const [jobName, job] of Object.entries(record(workflow.jobs) ? workflow.jobs : {})) {
            if (!record(job)) {
                add('WORKFLOW_INVALID', `${path}#${jobName}`, 'job must be one mapping')
                continue
            }
            if (job.permissions !== undefined && !record(job.permissions)) {
                add('WORKFLOW_PERMISSIONS_BROAD', `${path}#${jobName}`, 'job permissions must be one mapping')
            }
            const writable = WRITE_GRANTS[`${path}#${jobName}`] ?? []
            for (const [scope, value] of Object.entries(record(job.permissions) ? job.permissions : {})) {
                if (['none', 'read'].includes(value)) continue
                if (value === 'write' && writable.includes(scope)) continue
                add('WORKFLOW_PERMISSIONS_BROAD', `${path}#${jobName}`, `job grants ${scope}: ${String(value)}, which is not on the reviewed write allowance`)
            }
            const publishes = PUBLICATION_JOBS.has(`${path}#${jobName}`)
            if (typeof job.uses === 'string') inspectWorkflowReference(job.uses, `${path}#${jobName}`)
            if (job.steps !== undefined && !Array.isArray(job.steps)) add('WORKFLOW_INVALID', `${path}#${jobName}`, 'job steps must be one sequence')
            for (const step of Array.isArray(job.steps) ? job.steps : []) {
                if (!record(step)) {
                    add('WORKFLOW_INVALID', `${path}#${jobName}`, 'workflow step must be one mapping')
                    continue
                }
                if (typeof step.uses === 'string') inspectAction(step.uses, path)
                if (typeof step.run === 'string' && /npm run lint:supply-chain(?:\s|$)/.test(step.run)) invokesDetector = true
                // Changesets action command inputs are scanned like `run`. Legacy input names
                // remain included here so an ignored but dangerous-looking command cannot hide.
                // A repository script named by any of them is
                // scanned too: moving a publish command into a script must not hide it.
                const commands = [step.run, step.with?.['publish-script'], step.with?.['version-script'], step.with?.publish, step.with?.version]
                    .filter(value => typeof value === 'string')
                if (!publishes) {
                    if (typeof step.with?.['publish-script'] === 'string' || typeof step.with?.publish === 'string') {
                        add('PUBLICATION_PATH_PRESENT', `${path}#${jobName}`, 'only the release job may run a publish command')
                    }
                    for (const command of commands) {
                        if (PUBLICATION_COMMAND.test(command)) {
                            add('PUBLICATION_PATH_PRESENT', `${path}#${jobName}`, 'only the release job may contain a registry or publication command')
                        }
                        for (const script of command.match(/\.github\/scripts\/[A-Za-z0-9_./-]+/g) ?? []) {
                            const scriptPath = resolve(root, script)
                            let body
                            try {
                                if (script.includes('..') || lstatSync(scriptPath).isSymbolicLink()) throw new Error('linked or escaping script path')
                                body = readFileSync(scriptPath, 'utf8')
                            } catch {
                                add('WORKFLOW_SCRIPT_INVALID', `${path}#${jobName}`, `invoked script is missing, linked, or outside .github/scripts: ${script}`)
                                continue
                            }
                            if (PUBLICATION_COMMAND.test(body)) {
                                add('PUBLICATION_PATH_PRESENT', script, `script invoked by ${path}#${jobName} contains a registry or publication command`)
                            }
                        }
                    }
                }
            }
        }
        activeWorkflows.delete(absolute)
        visitedWorkflows.add(absolute)
    }
    const canonicalWorkflowDirectory = canonicalOwnedBase(directory, '.github/workflows', 'workflow')
    if (canonicalWorkflowDirectory) for (const name of readdirSync(directory).filter(path => /\.ya?ml$/.test(path)).sort()) {
        const workflow = canonicalLocal(`./.github/workflows/${name}`, directory, '.github/workflows', 'workflow')
        if (workflow) inspectWorkflow(workflow)
    }
    if (rootManifest.scripts?.['lint:supply-chain'] !== 'node scripts/supply-chain-check.mjs' || !invokesDetector) {
        diagnostics.push(diagnostic('WORKFLOW_LINT_NOT_INVOKED', '.github/workflows', 'CI must invoke the repository supply-chain detector'))
    }
    return diagnostics
}

// Detectors for the release properties that used to be listed as operator gaps: the release
// job stamps the source revision, publishes with provenance, and dependency updates wait out
// a cooldown. Each is read from the files that implement it.
function releaseDiagnostics(root) {
    const diagnostics = []
    const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
    const readYaml = path => {
        try { return parse(readFileSync(resolve(root, path), 'utf8')) }
        catch (error) {
            diagnostics.push(diagnostic('RELEASE_CONFIG_UNREADABLE', path, `could not be read or parsed: ${error instanceof Error ? error.message : path}`))
            return undefined
        }
    }
    const workflow = readYaml('.github/workflows/release.yml')
    const job = record(workflow?.jobs) ? workflow.jobs.release : undefined
    if (workflow !== undefined && !record(job)) {
        diagnostics.push(diagnostic('RELEASE_JOB_MISSING', '.github/workflows/release.yml', 'the release workflow must define a job named release'))
    }
    if (record(job)) {
        const steps = Array.isArray(job.steps) ? job.steps.filter(record) : []
        const commands = steps.flatMap(step => [step.run, step.with?.['publish-script'], step.with?.['version-script']]
            .filter(value => typeof value === 'string'))
        const bodies = [...commands]
        for (const script of new Set(commands.flatMap(command => command.match(/\.github\/scripts\/[A-Za-z0-9_./-]+/g) ?? []))) {
            try {
                if (script.includes('..') || lstatSync(resolve(root, script)).isSymbolicLink()) throw new Error('linked or escaping path')
                bodies.push(readFileSync(resolve(root, script), 'utf8'))
            } catch {
                diagnostics.push(diagnostic('RELEASE_SCRIPT_INVALID', script, 'script named by the release job is missing, linked, or outside .github/scripts'))
            }
        }
        if (!bodies.some(body => body.includes('cockpitSourceRevision'))) {
            diagnostics.push(diagnostic('RELEASE_STAMP_MISSING', '.github/workflows/release.yml', 'the release job must stamp cockpitSourceRevision with the commit before publishing'))
        }
        const envs = [job.env, ...steps.map(step => step.env)].filter(record)
        const provenance = envs.some(env => String(env.NPM_CONFIG_PROVENANCE) === 'true') || bodies.some(body => /--provenance\b/.test(body))
        if (!provenance || job.permissions?.['id-token'] !== 'write') {
            diagnostics.push(diagnostic('RELEASE_PROVENANCE_MISSING', '.github/workflows/release.yml', 'the release job must publish with provenance (NPM_CONFIG_PROVENANCE or --provenance) and hold id-token: write'))
        }
        const evidence = steps.find(step => step.name === 'attach authenticated release evidence')
        const evidenceBody = typeof evidence?.run === 'string' ? evidence.run : ''
        if (evidence?.if !== "steps.changesets.outputs.published == 'true'"
            || evidence?.env?.PUBLISHED_PACKAGES !== '${{ steps.changesets.outputs.published-packages }}'
            || !evidenceBody.includes('published.length !== 1')
            || !evidenceBody.includes('published[0]?.name !== "@b0dea/cockpit"')
            || !evidenceBody.includes('npm view "${package_name}@${version}" dist.integrity --json')
            || !evidenceBody.includes('packages/cockpit/libexec/release-evidence.mjs record')
            || !evidenceBody.includes('gh release view "$tag"')
            || !evidenceBody.includes('gh release upload "$tag" release-evidence.json release-evidence.json.sha256')) {
            diagnostics.push(diagnostic('RELEASE_EVIDENCE_MISSING', '.github/workflows/release.yml', 'the exact published cockpit package must attach its authenticated release record and digest to the matching GitHub release'))
        }
    }
    const dependabot = readYaml('.github/dependabot.yml')
    const updates = Array.isArray(dependabot?.updates) ? dependabot.updates : []
    if (dependabot !== undefined && updates.length === 0) {
        diagnostics.push(diagnostic('DEPENDABOT_COOLDOWN_MISSING', '.github/dependabot.yml', 'no update entries to carry a cooldown'))
    }
    updates.forEach((update, index) => {
        const days = record(update) && record(update.cooldown) ? update.cooldown['default-days'] : undefined
        if (!Number.isInteger(days) || days < MINIMUM_COOLDOWN_DAYS) {
            diagnostics.push(diagnostic('DEPENDABOT_COOLDOWN_MISSING', '.github/dependabot.yml', `update entry ${index} needs cooldown.default-days of at least ${MINIMUM_COOLDOWN_DAYS}`))
        }
    })
    return diagnostics
}

export function inspectSupplyChain(root, packFiles) {
    const diagnostics = []
    const rootManifest = json(root, 'package.json')
    const packageManifest = json(root, 'packages/cockpit/package.json')
    const lock = json(root, 'package-lock.json')
    const manifests = [['package.json', rootManifest], ['packages/cockpit/package.json', packageManifest]]

    for (const [path, manifest] of manifests) {
        for (const entry of dependencyEntries(manifest)) {
            if (typeof entry.version !== 'string' || !EXACT_VERSION.test(entry.version)) {
                diagnostics.push(diagnostic('DEPENDENCY_VERSION_MUTABLE', path, `${entry.field}.${entry.name} must be exact`))
            }
        }
        for (const name of ['preinstall', 'install', 'postinstall']) {
            if (manifest.scripts?.[name]) diagnostics.push(diagnostic('INSTALL_SCRIPT_PRESENT', path, `${name} is not permitted`))
        }
    }
    if (JSON.stringify(packageManifest.dependencies) !== JSON.stringify(EXPECTED_RUNTIME_DEPENDENCIES)) {
        diagnostics.push(diagnostic('RUNTIME_DEPENDENCIES_CHANGED', 'packages/cockpit/package.json', 'runtime dependencies require explicit policy review'))
    }
    if (JSON.stringify(packageManifest.bin) !== JSON.stringify({ cockpit: 'bin/cockpit.mjs' })) {
        diagnostics.push(diagnostic('PACKAGE_BIN_CHANGED', 'packages/cockpit/package.json', 'the package must expose only the cockpit binary'))
    }
    if (JSON.stringify({
        repository: packageManifest.repository,
        homepage: packageManifest.homepage,
        bugs: packageManifest.bugs,
    }) !== JSON.stringify(EXPECTED_PACKAGE_LINKS)) {
        diagnostics.push(diagnostic('PACKAGE_LINKS_CHANGED', 'packages/cockpit/package.json', 'repository, homepage, and issue links must identify the public source and support locations'))
    }
    if (packageManifest.types !== './dist/cli.d.ts' || JSON.stringify(packageManifest.exports) !== JSON.stringify({
        '.': { types: './dist/cli.d.ts', import: './dist/cli.js' },
    })) {
        diagnostics.push(diagnostic('PACKAGE_EXPORTS_CHANGED', 'packages/cockpit/package.json', 'the public import and declaration targets must remain explicit'))
    }
    if (JSON.stringify(sortedRecord(rootManifest.allowScripts)) !== JSON.stringify(reviewedAllowScripts())) {
        diagnostics.push(diagnostic('ALLOW_SCRIPTS_POLICY_MISMATCH', 'package.json', 'allowScripts must exactly match the reviewed executable dependency policy'))
    }
    const reviewedLockNodes = REVIEWED_EXECUTABLE_LOCK_NODES.map(({ allowScript: _allowScript, ...row }) => row)
    if (JSON.stringify(executableLockNodes(lock)) !== JSON.stringify(reviewedLockNodes)) {
        diagnostics.push(diagnostic('LOCK_EXECUTABLE_POLICY_CHANGED', 'package-lock.json', 'installer and binary lock nodes require explicit policy review'))
    }
    for (const [path, manifest, lockPath] of [
        ['package.json', rootManifest, ''],
        ['packages/cockpit/package.json', packageManifest, 'packages/cockpit'],
    ]) {
        const locked = lock.packages?.[lockPath]
        for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
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
        const expectedSet = new Set(expected)
        const packedSet = new Set(packFiles)
        for (const path of packFiles) if (!expectedSet.has(path)) {
            diagnostics.push(diagnostic('PACKAGE_AUDIENCE_LEAK', path, 'packed file is outside the exact consumer inventory'))
        }
        for (const required of expected) if (!packedSet.has(required)) {
            diagnostics.push(diagnostic('PACKAGE_REQUIRED_FILE_MISSING', required, 'required installed surface is absent'))
        }
        if (packedSet.size !== packFiles.length) diagnostics.push(diagnostic('PACK_METADATA_INVALID', 'packages/cockpit', 'pack metadata contains duplicate paths'))
    }
    diagnostics.push(...workflowDiagnostics(root, rootManifest))
    diagnostics.push(...releaseDiagnostics(root))
    return Object.freeze({ diagnostics: Object.freeze(diagnostics), operatorGaps: OPERATOR_GAPS })
}

export function runSupplyChainCheck(root) {
    const output = execFileSync('npm', ['pack', '--json', '--dry-run', '--workspace', '@b0dea/cockpit'], {
        cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'],
    })
    const decoded = JSON.parse(output)
    const records = Array.isArray(decoded) ? decoded
        : decoded !== null && typeof decoded === 'object' ? Object.values(decoded) : []
    if (records.length !== 1 || !Array.isArray(records[0]?.files)
        || !records[0].files.every(file => typeof file?.path === 'string' && file.path.length > 0)) {
        throw new Error('[PACK_METADATA_INVALID] npm pack did not return one artifact inventory')
    }
    const result = inspectSupplyChain(root, records[0].files.map(file => file.path))
    if (result.diagnostics.length > 0) {
        for (const row of result.diagnostics) process.stderr.write(`${row.code} ${row.path}: ${row.message}\n`)
        return 1
    }
    process.stdout.write(`${JSON.stringify({ status: 'ready', operatorGaps: result.operatorGaps })}\n`)
    return 0
}

export function generateSbom(root, output) {
    const temporaryRoot = mkdtempSync(join(tmpdir(), 'cockpit-sbom-input-'))
    try {
        mkdirSync(resolve(temporaryRoot, 'packages/cockpit'), { recursive: true })
        const rootManifest = json(root, 'package.json')
        const packageManifest = json(root, 'packages/cockpit/package.json')
        const lock = json(root, 'package-lock.json')
        // npm 11 cannot form a package URL for an unversioned private workspace root.
        // The compatibility snapshot derives that metadata-only root version from the exact
        // candidate workspace; package declarations and the dependency lock remain unchanged.
        writeFileSync(resolve(temporaryRoot, 'package.json'), `${JSON.stringify({ ...rootManifest, version: packageManifest.version }, null, 2)}\n`)
        writeFileSync(resolve(temporaryRoot, 'package-lock.json'), `${JSON.stringify({
            ...lock,
            packages: { ...lock.packages, '': { ...lock.packages[''], version: packageManifest.version } },
        }, null, 2)}\n`)
        cpSync(resolve(root, 'packages/cockpit/package.json'), resolve(temporaryRoot, 'packages/cockpit/package.json'))
        const bytes = execFileSync('npm', [
            'sbom', '--workspace', '@b0dea/cockpit', '--sbom-format', 'cyclonedx', '--package-lock-only',
        ], { cwd: temporaryRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })
        mkdirSync(dirname(output), { recursive: true })
        writeFileSync(output, bytes)
    } finally {
        rmSync(temporaryRoot, { recursive: true, force: true })
    }
}

const invoked = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])
if (invoked) {
    const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
    if (process.argv.length === 4 && process.argv[2] === '--sbom') generateSbom(root, resolve(process.argv[3]))
    else if (process.argv.length === 5 && process.argv[2] === '--inspect') {
        const result = inspectSupplyChain(resolve(process.argv[3]), JSON.parse(process.argv[4]))
        process.stdout.write(`${JSON.stringify(result)}\n`)
        if (result.diagnostics.length > 0) process.exitCode = 1
    }
    else if (process.argv.length === 2) process.exitCode = runSupplyChainCheck(root)
    else throw new Error('[SUPPLY_CHAIN_USAGE_INVALID] use no arguments, --inspect <root> <pack-files-json>, or --sbom <output>')
}
