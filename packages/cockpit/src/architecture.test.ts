import { execFileSync, spawnSync } from 'node:child_process'
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, posix, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as ts from '@typescript/typescript6'
import { describe, expect, it } from 'vitest'
import { allObservationDeclarations } from './environment/observations.js'

// The import graph is checked by dependency-cruiser against /.dependency-cruiser.mjs. This file runs
// it and holds what an import graph cannot express: which module may name a capability, and the
// tree-wide controls that are about files rather than imports.

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const SRC = 'packages/cockpit/src/'

function listed(...roots: string[]): string[] {
    return execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', ...roots],
        { cwd: ROOT, encoding: 'utf8' }).split('\0').filter(Boolean)
}

function read(path: string): string {
    return readFileSync(resolve(ROOT, path), 'utf8')
}

const production = new Map(listed('packages/cockpit/src', 'scripts')
    .filter((path) => /\.[cm]?[jt]s$/.test(path) && !/\.(?:test|d)\.[cm]?[jt]s$/.test(path) && !path.startsWith(`${SRC}test-support/`))
    .map((path) => [path, read(path)]))
const product = new Map([...production].filter(([path]) => path.startsWith(SRC)))

function cruise(cwd: string, targets: readonly string[]) {
    return spawnSync(process.execPath, [
        '--import', resolve(ROOT, 'scripts/depcruise-typescript.mjs'),
        resolve(ROOT, 'node_modules/dependency-cruiser/bin/dependency-cruiser.mjs'),
        '--config', resolve(ROOT, '.dependency-cruiser.mjs'), '--output-type', 'err', ...targets,
    ], { cwd, encoding: 'utf8' })
}

/** Every string literal and plain template in a module. */
function literals(source: string): string[] {
    const found: string[] = []
    const visit = (node: ts.Node): void => {
        if (ts.isStringLiteralLike(node)) found.push(node.text)
        ts.forEachChild(node, visit)
    }
    visit(ts.createSourceFile('module.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS))
    return found
}

function violators(sources: ReadonlyMap<string, string>, pattern: RegExp, allowed: readonly string[]): string[] {
    return [...sources].filter(([path, source]) => pattern.test(source) && !allowed.includes(path)).map(([path]) => path)
}

const ENV = `${SRC}environment/`
// Each row names a capability by the words that reach it and the only modules that may say them.
// A name is a coarse detector: an alias still spells the imported name, and a computed property
// would not, which is why computed imports are refused below.
const CONFINED: readonly (readonly [capability: string, pattern: RegExp, allowed: readonly string[]])[] = [
    ['runtime measurement authority is issued only to the probe', /\bissueRuntimeMeasurementProbeAuthority\b/, [`${ENV}runtime.ts`, `${ENV}runtime-probe.ts`]],
    ['runtime measurement observations are read only by lifecycle composition', /\bruntimeMeasurementProbeObservation\b/,
        [`${ENV}runtime.ts`, `${ENV}lifecycle-composition.ts`]],
    // The port owner implements compensation and the transaction owner compensates its own publication;
    // only the application, and the lifecycle adapter around a fresh acquisition, invoke it.
    ['compensation runs only where it is owned or sequenced', /\bcompensat\w*\s*\(/i,
        [`${SRC}environment-exec/execute.ts`, `${ENV}ports.ts`, `${SRC}generated-environment/transaction.ts`, `${ENV}application.ts`, `${ENV}lifecycle-composition.ts`]],
    ['plan execution is bound only by the CLI', /\bexecutePlan\b/, [`${SRC}environment-exec/execute.ts`, `${SRC}cli.ts`]],
    ['lifecycle issuance is consumed only by the application', /\bconsumeLifecycleIssuance\b/, [`${ENV}lifecycle.ts`, `${ENV}application.ts`]],
    ['drain reducers stay inside the claims broker', /\b(?:reduceDrain\w*|consumeDrainReservationAuthority)\b/, [`${ENV}claims.ts`]],
    ['drain reservation and outcome publication are the application\'s',
        /\b(?:reserveDrain\w*|recoverDrainReservation|inspectDestructiveDrainRecovery|prepareDrainOutcomePublication|finalizeDrain\w*Outcome)\b/,
        [`${ENV}claims.ts`, `${ENV}application.ts`]],
    ['reclaim drain recovery is reclaim\'s', /\b(?:inspectFailedReclaimRecovery|consumeFailedReclaimRecovery|openReclaimDrainExecution|matchReclaimDrainContinuation)\b/,
        [`${ENV}claims.ts`, `${ENV}reclaim.ts`]],
    ['runtime drain execution is runtime\'s', /\b(?:openRuntimeDrainExecution|settleRuntimeDrain\w+)\b/, [`${ENV}claims.ts`, `${ENV}runtime.ts`]],
    ['port leases consult the drain guard', /\b(?:isDrainActive|releaseClaim)\b/, [`${ENV}claims.ts`, `${ENV}ports.ts`]],
    ['one registry parser', /\bfunction\s+parseRegistry\b|\bparseRegistry\s*=/, [`${SRC}registry-resolve/registry.ts`]],
    ['guard input is parsed only for the guard application', /\bparseGuardInput\b/, [`${SRC}guards/invocation-parser.ts`, `${ENV}application.ts`]],
    ['guard policy is evaluated only by the guard application', /\bevaluateGuard\b/, [`${SRC}guards/evaluator.ts`, `${ENV}application.ts`]],
    ['ordinary invocations are admitted through the command table', /\bresolveOrdinaryInvocation\b/,
        [`${SRC}command-table.ts`, `${ENV}application.ts`, `${SRC}cli.ts`]],
    ['runtime guard policy is assembled once',
        /\b(?:protectedBranches|hostedDatabaseHosts|vendorHosts|declaredAllows|declaredDenies|cockpitInvocations|cockpitLaunchers|projectCommands)\b/,
        [`${SRC}guards/evaluator.ts`, `${ENV}application.ts`]],
    ['guard policy is captured where it is evaluated or rendered', /\bcapturePolicy\b/, [`${SRC}guards/evaluator.ts`, `${SRC}surfaces/restrictions.ts`]],
    ['one entrypoint-kind vocabulary', /\b(?:callback_url|advertised_listener|cors_origin|public_base_url)\b/, [`${SRC}entrypoint-kinds.ts`]],
    ['observations are issued only by their owner', /\bexport\s+(?:async\s+)?function\s+issue\w*Observation\b|\bimport\s*(?:type\s*)?\{[^}]*\bissue\w*Observation\b/, []],
]

describe('product architecture', () => {
    it('keeps the production import graph within the dependency rules', () => {
        const result = cruise(ROOT, ['packages/cockpit/src', 'scripts'])
        expect(result.stderr + result.stdout).toContain('no dependency violations found')
        expect(result.status).toBe(0)
    }, 60_000)

    it('reports a planted cycle and a planted lifecycle import through the TypeScript parser', () => {
        const root = mkdtempSync(join(tmpdir(), 'cockpit-architecture-'))
        try {
            const plant = (path: string, source: string) => {
                mkdirSync(dirname(join(root, path)), { recursive: true })
                writeFileSync(join(root, path), source)
            }
            plant(`${ENV}lifecycle.ts`, "import { run } from './application.js'\nexport const plan = (value: string): string => run(value)\n")
            plant(`${ENV}application.ts`, "import type { plan } from './lifecycle.js'\nexport const run = (value: string): string => value\nexport type Plan = typeof plan\n")
            const result = cruise(root, ['packages/cockpit/src'])
            expect(result.status).not.toBe(0)
            expect(result.stdout).toContain('lifecycle-planning-imports')
            expect(result.stdout).toContain('no-cycle')
        } finally {
            rmSync(root, { recursive: true, force: true })
        }
    }, 60_000)

    it.each(CONFINED)('confines %s', (_capability, pattern, allowed) => {
        expect(violators(production, pattern, allowed)).toEqual([])
        for (const path of allowed) expect(production.has(path), path).toBe(true)
    })

    // Every child process crosses the executor, which owns its timeout, output bound and signal.
    it('loads child processes only in the executor', () => {
        const loaders = [...product].filter(([path, source]) => path !== `${SRC}environment-exec/execute.ts`
            && literals(source).some((text) => text === 'child_process' || text === 'node:child_process'))
        expect(loaders.map(([path]) => path)).toEqual([])
    })

    it('keeps timers, signals and standard streams in the executor', () => {
        const allowed = new Map([
            // The release query bounds its own HTTPS request; the state lock backs off between attempts.
            [`${SRC}freshness.ts`, ['setTimeout', 'clearTimeout']],
            [`${ENV}state.ts`, ['node:timers/promises']],
        ])
        const found: string[] = []
        for (const [path, source] of product) {
            if (path === `${SRC}environment-exec/execute.ts`) continue
            const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
            const visit = (node: ts.Node): void => {
                const name = ts.isCallExpression(node) && ts.isIdentifier(node.expression) ? node.expression.text
                    : ts.isPropertyAccessExpression(node) && node.expression.getText(file) === 'process'
                        && ['kill', 'stdin', 'stdout', 'stderr'].includes(node.name.text) ? `process.${node.name.text}`
                        : ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && /^(?:node:)?timers/.test(node.moduleSpecifier.text)
                            ? node.moduleSpecifier.text : undefined
                if (name && /^(?:set|clear)(?:Timeout|Interval|Immediate)$|^process\.|timers/.test(name)
                    && !allowed.get(path)?.includes(name)) found.push(`${path} ${name}`)
                ts.forEachChild(node, visit)
            }
            visit(file)
        }
        expect(found).toEqual([])
    })

    // dependency-cruiser sees only literal specifiers; a computed one would hide an edge from every rule above.
    it('refuses computed module loading in production code', () => {
        const computed: string[] = []
        for (const [path, source] of production) {
            const visit = (node: ts.Node): void => {
                if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
                    || ts.isIdentifier(node.expression) && node.expression.text === 'require')
                    && !(node.arguments.length === 1 && ts.isStringLiteralLike(node.arguments[0]!))) computed.push(path)
                ts.forEachChild(node, visit)
            }
            visit(ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS))
        }
        expect(computed).toEqual([])
    })

    it('spells environment codes only in their registry', () => {
        const environmentCode = /^(?:CONFIG|STATE|SETUP|PORT|CLAIM|INSTALL|TEMPLATE|RUNTIME|RESET|EVIDENCE|RECLAIM|EXECUTION)_[A-Z0-9_]+$/
        // The supply-chain detector reports on the lockfile with codes of its own.
        const independent = new Set(['scripts/supply-chain-check.ts INSTALL_SCRIPT_PRESENT', 'scripts/supply-chain-check.ts RUNTIME_DEPENDENCIES_CHANGED'])
        const spelled = [...production].filter(([path]) => path !== `${ENV}contract.ts`)
            .flatMap(([path, source]) => literals(source).filter((text) => environmentCode.test(text)).map((text) => `${path} ${text}`))
            .filter((site) => !independent.has(site))
        expect(spelled).toEqual([])
    })

    // No second health verdict: every observation an owner declares is evaluated by observations.ts.
    it('aggregates every declared observation into the one evaluator', async () => {
        const declared = []
        for (const [path, source] of product) {
            for (const [, name] of source.matchAll(/^export const (\w*[oO]bservationDeclarations)\b/gm)) {
                const module = await import(resolve(ROOT, path)) as Record<string, readonly object[]>
                if (path !== `${ENV}observations.ts`) declared.push(...module[name]!)
            }
        }
        expect(declared.length).toBeGreaterThan(0)
        for (const declaration of declared) expect(allObservationDeclarations).toContain(declaration)
        const ids = allObservationDeclarations.map(({ id }) => id)
        const codes = allObservationDeclarations.map(({ code }) => code)
        expect(new Set(ids).size).toBe(ids.length)
        expect(new Set(codes).size).toBe(codes.length)
    })

    it('keeps the diagnostic scanner in maintainer tooling outside the shipped package', () => {
        expect(violators(production, /\bfunction\s+(?:diagnosticInventory|diagnosticInventoryFromSources|productionSources)\b/,
            ['scripts/diagnostic-inventory.ts'])).toEqual([])
        expect(JSON.parse(read('packages/cockpit/package.json')).files).not.toContain('scripts')
    })

    it('keeps guard policy out of every shipped shell entrypoint', () => {
        const shells = listed('packages/cockpit/surfaces').filter((path) => /\.(?:sh|bash)$/.test(path) || read(path).startsWith('#!'))
        expect(shells).toContain('packages/cockpit/surfaces/guards/bash-guard.sh')
        for (const path of shells) {
            // Transport may select its framing mode, but may never interpret guard policy.
            const executable = read(path).split('\n').filter((line) => !line.trimStart().startsWith('#')).join('\n')
            expect(executable, path).not.toMatch(/\b(?:protected_branches|hosted_db_hosts|vendor_endpoint_hosts|protectedBranches|hostedDatabaseHosts|vendorHosts)\b|\b(?:jq|awk|python\d*|eval)\b|\b(?:allow|deny|ask)\b/)
        }
    })
})

const LOCAL_TOOL_ROOTS = ['.claude', '.codex', '.opencode', '.agents'] as const
const SHIPPED_ESTATE = 'packages/cockpit/surfaces'

function estateCrossings(sources: ReadonlyMap<string, string>): string[] {
    const crossing = (path: string) => LOCAL_TOOL_ROOTS.some((root) => path === root || path.startsWith(`${root}/`))
    return [...sources].filter(([path, body]) => {
        if (crossing(path.slice(SHIPPED_ESTATE.length + 1))) return true
        const references = [...body.matchAll(/(?:@|\]\(|["'])(\.{1,2}\/[^\s"'`\])}]+|packages\/cockpit\/surfaces\/[^\s"'`\])}]+)/g)].map((match) => match[1]!)
        return references.some((reference) => crossing(reference.startsWith('.') ? posix.normalize(posix.join(posix.dirname(path), reference)) : reference))
    }).map(([path]) => path)
}

describe('clean-checkout controls', () => {
    it('keeps shipped templates independent from repository-local tool roots', () => {
        const shipped = new Map(listed(SHIPPED_ESTATE).map((path) => {
            const absolute = resolve(ROOT, path)
            return [path, lstatSync(absolute).isSymbolicLink() ? `@${readlinkSync(absolute)}` : read(path)]
        }))
        expect(estateCrossings(shipped)).toEqual([])
        expect(estateCrossings(new Map([[`${SHIPPED_ESTATE}/.codex/config.toml`, 'model = "synthetic"']]))).toHaveLength(1)
        expect(estateCrossings(new Map([[`${SHIPPED_ESTATE}/skills/synthetic.md`, '@../../../../.codex/config.toml']]))).toHaveLength(1)
        expect(estateCrossings(new Map([[`${SHIPPED_ESTATE}/guards/synthetic.adapter.json`, '{"path":".codex/hooks.json"}']]))).toEqual([])
    })

    it('exposes root build and documentation commands backed by real implementations', () => {
        const manifest = JSON.parse(read('package.json')) as {
            scripts?: Record<string, string>
        }

        expect(manifest.scripts?.build).toBe('npm run build --workspace @b00dea/cockpit')
        expect(manifest.scripts?.['lint:docs']).toBe('tsx scripts/docs-lint.ts')
    })

    it('runs one full Linux cell and adjacent macOS tests per pull request, full platforms on main, the Node upper edge weekly, and the Node 20 negative control', () => {
        const workflow = read('.github/workflows/ci.yml')
        const supportedJob = /\n  test:\n(?<body>[\s\S]*?)(?=\n  test-protection:)/.exec(workflow)?.groups?.body ?? ''
        const hygieneJob = /\n  hygiene:\n(?<body>[\s\S]*?)(?=\n  test:)/.exec(workflow)?.groups?.body ?? ''
        const floorJob = /\n  runtime-floor-negative:\n(?<body>[\s\S]*)/.exec(workflow)?.groups?.body ?? ''

        // The matrix is one fromJSON expression with a pull-request, a weekly and a main list, so
        // each list is read as data rather than matched line by line.
        const [pullRequestCells, weeklyCells, mainCells] = [...supportedJob.matchAll(/'(\[\{[^']*\}\])'/g)]
            .map((match) => (JSON.parse(match[1]) as { os: string; node: string; gate: string }[])
                .map(({ os, node, gate }) => ({ os, node, gate })))
        expect(supportedJob).toContain("github.event_name == 'pull_request' && '[")
        expect(supportedJob).toContain("github.event_name == 'schedule' && '[")
        expect(workflow).toMatch(/\n  schedule:\n    - cron: '[^']+'\n/)
        // macOS minutes cost ten times Linux minutes, so a pull request runs only the tests
        // adjacent to its change there.
        expect(pullRequestCells).toEqual([
            { os: 'ubuntu-latest', node: '22.22.0', gate: 'full' },
            { os: 'macos-latest', node: '22.22.0', gate: 'changed' },
        ])
        expect(weeklyCells).toEqual([
            { os: 'ubuntu-latest', node: '26', gate: 'full' },
        ])
        expect(mainCells).toEqual([
            { os: 'ubuntu-latest', node: '22.22.0', gate: 'full' },
            { os: 'macos-latest', node: '22.22.0', gate: 'full' },
            { os: 'ubuntu-latest', node: '24', gate: 'compatibility' },
            { os: 'ubuntu-latest', node: '26', gate: 'compatibility' },
        ])
        // A refused adjacent selection widens the cell to the full suite; it never runs nothing.
        expect(supportedJob).toContain("if: matrix.gate == 'changed'")
        expect(supportedJob).toContain('if npm run --silent test:changed -- HEAD^1 --list >/dev/null; then\n            npm run test:changed -- HEAD^1 --wide\n          else')
        expect(supportedJob).toMatch(/else\n[^\n]*\n {12}npm test\n {10}fi/)
        expect(supportedJob).toContain('fetch-depth: 2')
        expect(workflow).toContain('runtime-floor-negative:')
        expect(supportedJob).toContain('npm run build')
        expect(supportedJob).toContain("if: matrix.gate == 'full'")
        expect(supportedJob).toContain("if: matrix.gate == 'compatibility'")
        expect(supportedJob).toContain('run: npm test -- packages/cockpit/src/launcher.test.ts packages/cockpit/src/package-metadata.test.ts packages/cockpit/src/environment/runtime-probe.slow.test.ts')
        expect(supportedJob).not.toMatch(/\bnpx\s+vitest\b|--(?:maxWorkers|minWorkers|pool|fileParallelism)\b/)
        // Documentation lint runs once in the hygiene job, which docs-only changes also reach.
        expect(hygieneJob).toContain('npm run lint:docs')
        expect(floorJob).toContain("node-version: '20'")
        expect(floorJob).toContain('node20_status=$?')
        expect(floorJob).toContain('test "$node20_status" -ne 0')
        expect(floorJob).toContain("grep -Eq 'COCKPIT_NODE_VERSION_UNSUPPORTED.*22'")
        expect(floorJob).toContain("! grep -q 'packages/cockpit/dist/'")

        const actionReferences = [...workflow.matchAll(/uses:\s*[^@\s]+@([^\s]+)/g)].map((match) => match[1])
        expect(actionReferences.length).toBeGreaterThan(0)
        expect(actionReferences.every((reference) => /^[a-f0-9]{40}$/.test(reference))).toBe(true)
    })
})


// An empty catch hides what failed. Each one left in production code is named here with why its
// silence is correct; a new one carries the cause, narrows to the error it expects, or earns an entry.
// The site is the module and the enclosing function, so the list survives edits that move lines.
const CLOSE_AFTER_DECISION = 'closing a descriptor after the read or write whose result is already decided'
const CLEANUP_AFTER_REPORTED_FAILURE = 'removing a temporary file after a failure that is already returned'
const SIGNAL_RACES_EXIT = 'signalling a process that may already have exited; the caller authenticates that it is gone'
const PARSE_REFUSED_NEXT = 'a parse failure leaves the value unset, and the next statement refuses it'
const JUSTIFIED_EMPTY_CATCHES: readonly (readonly [site: string, why: string])[] = [
    ['packages/cockpit/libexec/fence-marker.cjs#readFenceMarkerFile', CLOSE_AFTER_DECISION],
    ['packages/cockpit/libexec/fence-marker.cjs#replaceApprovedActiveMarker', CLOSE_AFTER_DECISION],
    ['packages/cockpit/libexec/fence-marker.cjs#replaceApprovedActiveMarker', CLEANUP_AFTER_REPORTED_FAILURE],
    ['packages/cockpit/libexec/fenced-supervisor.cjs#removeSocket', 'an absent socket is the goal, and repair checks absence itself'],
    ['packages/cockpit/libexec/install-filesystem.cjs#acquire', 'lock residue is left on purpose for explicit recovery, and the primary refusal is returned'],
    ['packages/cockpit/libexec/install-filesystem.cjs#atomicFile', CLEANUP_AFTER_REPORTED_FAILURE],
    ['packages/cockpit/src/environment-exec/execute.ts#checkFilesystem', CLOSE_AFTER_DECISION],
    ['packages/cockpit/src/environment-exec/execute.ts#consumedFileMatches', CLOSE_AFTER_DECISION],
    ['packages/cockpit/src/environment-exec/execute.ts#publishFenceMarker', CLOSE_AFTER_DECISION],
    ['packages/cockpit/src/environment-exec/execute.ts#publishFenceMarker', 'the prepared marker is either the linked winner or absent'],
    ['packages/cockpit/src/environment-exec/execute.ts#spawnFencedSupervisor', SIGNAL_RACES_EXIT],
    ['packages/cockpit/src/environment-exec/execute.ts#stageVerifiedFile', CLOSE_AFTER_DECISION],
    ['packages/cockpit/src/environment-exec/execute.ts#stageVerifiedFile', CLOSE_AFTER_DECISION],
    ['packages/cockpit/src/environment-exec/execute.ts#terminate', SIGNAL_RACES_EXIT],
    ['packages/cockpit/src/environment-exec/execute.ts#terminate', SIGNAL_RACES_EXIT],
    ['packages/cockpit/src/environment-exec/execute.ts#terminate', SIGNAL_RACES_EXIT],
    ['packages/cockpit/src/environment/claims.ts#prepareDrainOutcomePublication', PARSE_REFUSED_NEXT],
    ['packages/cockpit/src/environment/executable.ts#digestRegularFile', CLOSE_AFTER_DECISION],
    ['packages/cockpit/src/environment/posture-observation.ts#currentConfigurationRevision', CLOSE_AFTER_DECISION],
    ['packages/cockpit/src/environment/setup-observation.ts#stableFile', CLOSE_AFTER_DECISION],
    ['packages/cockpit/src/environment/state.ts#acquireLock', 'a partly created lock is authority evidence that must survive for recovery; the acquisition error is rethrown'],
    ['packages/cockpit/src/generated-environment/transaction.ts#admitPlan', PARSE_REFUSED_NEXT],
    ['packages/cockpit/src/generated-environment/transaction.ts#digestFile', CLOSE_AFTER_DECISION],
    ['packages/cockpit/src/generated-environment/transaction.ts#recordRecovery', CLOSE_AFTER_DECISION],
    ['packages/cockpit/src/generated-environment/transaction.ts#recordRecovery', 'the recovery record was synced before its directory handle is closed'],
    ['packages/cockpit/src/surfaces/projection.ts#readGuide', 'a guide that vanishes or turns unreadable mid-read is recorded as an identity change'],
]

// Shipped helper processes run outside the TypeScript graph; the rulesync bundle is generated
// third-party code, rebuilt rather than edited.
function emptyCatchCorpus(): Map<string, string> {
    const helpers = listed('packages/cockpit/libexec')
        .filter((path) => /\.(?:c|m)?js$/.test(path) && path !== 'packages/cockpit/libexec/rulesync-generator.cjs')
    return new Map([...production, ...helpers.map((path) => [path, read(path)] as const)])
}

function emptyCatchSites(sources: ReadonlyMap<string, string>): string[] {
    const sites: string[] = []
    for (const [path, source] of sources) {
        const enclosing: string[] = ['<module>']
        const visit = (node: ts.Node): void => {
            const name = (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.name
                ? node.name.getText()
                : (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && ts.isVariableDeclaration(node.parent)
                    ? node.parent.name.getText() : undefined
            if (name) enclosing.push(name)
            if (ts.isCatchClause(node) && node.block.statements.length === 0) sites.push(`${path}#${enclosing.at(-1)}`)
            ts.forEachChild(node, visit)
            if (name) enclosing.pop()
        }
        visit(ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS))
    }
    return sites.sort()
}

describe('error surfacing controls', () => {
    it('names why each remaining empty catch in production code is correct', () => {
        expect(emptyCatchSites(emptyCatchCorpus())).toEqual(JUSTIFIED_EMPTY_CATCHES.map(([site]) => site).sort())
        expect(JUSTIFIED_EMPTY_CATCHES.every(([, why]) => why.length > 0)).toBe(true)
    })

    it('reports a planted empty catch by module and enclosing function', () => {
        const sources = new Map([['packages/cockpit/src/planted.ts', 'export function load() { try { read() } catch { /* ignored */ } }']])
        expect(emptyCatchSites(sources)).toEqual(['packages/cockpit/src/planted.ts#load'])
    })
})
