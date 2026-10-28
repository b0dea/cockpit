import { execFileSync } from 'node:child_process'
import { lstatSync, readFileSync, readlinkSync } from 'node:fs'
import { posix, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as ts from 'typescript'
import { describe, expect, it } from 'vitest'

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const KERNEL_LEAVES = new Set([
    'packages/cockpit/src/diagnostics.ts',
    'packages/cockpit/src/command-table.ts',
    'packages/cockpit/src/schema.ts',
    'packages/cockpit/src/document/registry.ts',
    'packages/cockpit/src/config/load.ts',
    'packages/cockpit/src/environment/contract.ts',
    'packages/cockpit/src/environment/runtime.ts',
    'packages/cockpit/src/environment/logs.ts',
    'packages/cockpit/src/environment/lifecycle.ts',
    'packages/cockpit/src/environment/install-policy.ts',
    'packages/cockpit/src/environment/install-policy-observation.ts',
])

type Sources = ReadonlyMap<string, string>
const COMPUTED_DYNAMIC_IMPORT = '\0computed-dynamic-import'
const STATE_MODULE = 'packages/cockpit/src/environment/state.ts'
const LOCAL_TOOL_ROOTS = ['.claude', '.codex', '.opencode', '.agents'] as const
const SHIPPED_ESTATE = 'packages/cockpit/surfaces'

function shippedSurfaceSources(): Map<string, string> {
    const paths = execFileSync('git', [
        'ls-files', '-z', '--cached', '--others', '--exclude-standard',
        SHIPPED_ESTATE,
    ], { cwd: ROOT, encoding: 'utf8' }).split('\0').filter(Boolean)
    return new Map(paths.map((path) => {
        const absolute = resolve(ROOT, path)
        const status = lstatSync(absolute)
        return [path, status.isSymbolicLink() ? `@${readlinkSync(absolute)}` : readFileSync(absolute, 'utf8')]
    }))
}

function estateBoundaryViolations(sources: Sources): string[] {
    for (const [path, body] of sources) {
        if (path !== SHIPPED_ESTATE && !path.startsWith(`${SHIPPED_ESTATE}/`)) continue
        const suffix = path.slice(SHIPPED_ESTATE.length + 1)
        if (LOCAL_TOOL_ROOTS.some((root) => suffix === root || suffix.startsWith(`${root}/`))) {
            return ['ARCH048_ESTATE_CROSSING']
        }
        const references = [
            ...( /\.(?:[cm]?[jt]s)$/.test(path) ? importSpecifiers(body) : []),
            ...[...body.matchAll(/(?:@|\]\(|["'])(\.{1,2}\/[^\s"'`\])}]+|packages\/cockpit\/surfaces\/[^\s"'`\])}]+)/g)].map((match) => match[1]!),
        ]
        for (const reference of references) {
            const target = reference.startsWith('.') ? posix.normalize(posix.join(posix.dirname(path), reference)) : reference
            if (LOCAL_TOOL_ROOTS.some((root) => target === root || target.startsWith(`${root}/`))) {
                return ['ARCH048_ESTATE_CROSSING']
            }
        }
    }
    return []
}

function productionSourcePath(path: string): boolean {
    const runtimeModule = /\.(?:[cm]?[jt]s)$/.test(path)
    const generatedOrTest = /(?:\.test|\.spec|\.d)\.(?:[cm]?[jt]s)$/.test(path)
    const testSupport = path.startsWith('packages/cockpit/src/test-support/')
    return runtimeModule && !generatedOrTest && !testSupport
        && (path.startsWith('packages/cockpit/src/') || path.startsWith('scripts/'))
}

function assertSupportedProductionPaths(paths: readonly string[]): void {
    const unsupported = paths.find((path) => /\.(?:sh|bash)$/.test(path))
    if (unsupported) throw new Error(`ARCH018_UNPARSED_EXECUTABLE ${unsupported}`)
}

function productionSources(): Map<string, string> {
    const repositoryPaths = execFileSync('git', [
        'ls-files',
        '-z',
        '--cached',
        '--others',
        '--exclude-standard',
        'packages/cockpit/src',
        'scripts',
    ], {
        cwd: ROOT,
        encoding: 'utf8',
    })
        .split('\0')
        .filter(Boolean)
    assertSupportedProductionPaths(repositoryPaths)
    const paths = repositoryPaths.filter(productionSourcePath)
    return new Map(paths.map((path) => [path, readFileSync(resolve(ROOT, path), 'utf8')]))
}

function cockpitSources(): Map<string, string> {
    const paths = execFileSync('git', [
        'ls-files', '-z', '--cached', '--others', '--exclude-standard', 'packages/cockpit/src',
    ], { cwd: ROOT, encoding: 'utf8' })
        .split('\0')
        .filter((path) => path !== '' && /\.(?:[cm]?[jt]s)$/.test(path) && !/\.d\.(?:[cm]?[jt]s)$/.test(path))
    return new Map(paths.map((path) => [path, readFileSync(resolve(ROOT, path), 'utf8')]))
}

const importSpecifierCache = new Map<string, readonly string[]>()

function importSpecifiers(source: string): string[] {
    const cached = importSpecifierCache.get(source)
    if (cached) return [...cached]
    const sourceFile = ts.createSourceFile('module.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    const specifiers: string[] = []
    const requireNames = new Set(['require'])
    const createRequireNames = new Set(['createRequire'])
    const loadsNodeModule = (node: ts.CallExpression): boolean => {
        const [argument] = node.arguments
        const callee = node.expression.getText(sourceFile)
        return (
            (callee === 'require' || callee === 'module.require') &&
            node.arguments.length === 1 &&
            !!argument &&
            ts.isStringLiteralLike(argument) &&
            ['node:module', 'module'].includes(argument.text)
        )
    }
    const collectCreateRequireNames = (node: ts.Node): void => {
        if (
            ts.isImportDeclaration(node) &&
            ts.isStringLiteralLike(node.moduleSpecifier) &&
            ['node:module', 'module'].includes(node.moduleSpecifier.text) &&
            node.importClause?.namedBindings
        ) {
            if (ts.isNamedImports(node.importClause.namedBindings)) {
                for (const element of node.importClause.namedBindings.elements) {
                    if ((element.propertyName ?? element.name).text === 'createRequire') {
                        createRequireNames.add(element.name.text)
                    }
                }
            } else {
                createRequireNames.add(`${node.importClause.namedBindings.name.text}.createRequire`)
            }
        }
        if (
            ts.isVariableDeclaration(node) &&
            ts.isObjectBindingPattern(node.name) &&
            node.initializer &&
            ts.isCallExpression(node.initializer) &&
            loadsNodeModule(node.initializer)
        ) {
            for (const element of node.name.elements) {
                if (
                    (element.propertyName ?? element.name).getText(sourceFile) === 'createRequire' &&
                    ts.isIdentifier(element.name)
                ) {
                    createRequireNames.add(element.name.text)
                }
            }
        }
        if (
            ts.isVariableDeclaration(node) &&
            ts.isIdentifier(node.name) &&
            node.initializer &&
            ts.isCallExpression(node.initializer) &&
            loadsNodeModule(node.initializer)
        ) {
            createRequireNames.add(`${node.name.text}.createRequire`)
        }
        ts.forEachChild(node, collectCreateRequireNames)
    }
    collectCreateRequireNames(sourceFile)
    const isCreateRequireFactory = (node: ts.Expression): boolean =>
        createRequireNames.has(node.getText(sourceFile)) ||
        (ts.isPropertyAccessExpression(node) &&
            node.name.text === 'createRequire' &&
            ts.isCallExpression(node.expression) &&
            loadsNodeModule(node.expression))
    const isRequireFunction = (node: ts.Expression): boolean => {
        const expression = unwrappedExpression(node)
        const name = expression.getText(sourceFile)
        if (name === 'module.require' || requireNames.has(name)) return true
        return (
            ts.isCallExpression(expression) &&
            ts.isPropertyAccessExpression(expression.expression) &&
            expression.expression.name.text === 'bind' &&
            isRequireFunction(expression.expression.expression)
        )
    }
    const collectRequireNames = (node: ts.Node): void => {
        if (
            ts.isVariableDeclaration(node) &&
            ts.isIdentifier(node.name) &&
            node.initializer
        ) {
            const initializer = unwrappedExpression(node.initializer)
            if (isRequireFunction(initializer)) requireNames.add(node.name.text)
            if (
            ts.isCallExpression(node.initializer) &&
            isCreateRequireFactory(node.initializer.expression)
            ) {
                requireNames.add(node.name.text)
            }
        }
        if (
            ts.isBinaryExpression(node) &&
            node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
            ts.isIdentifier(node.left) &&
            isRequireFunction(node.right)
        ) {
            requireNames.add(node.left.text)
        }
        ts.forEachChild(node, collectRequireNames)
    }
    let requireNameCount = -1
    while (requireNameCount !== requireNames.size) {
        requireNameCount = requireNames.size
        collectRequireNames(sourceFile)
    }
    const visit = (node: ts.Node): void => {
        if (
            (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
            node.moduleSpecifier &&
            ts.isStringLiteralLike(node.moduleSpecifier)
        ) {
            specifiers.push(node.moduleSpecifier.text)
        }
        if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
            const [argument] = node.arguments
            specifiers.push(argument && ts.isStringLiteralLike(argument) ? argument.text : COMPUTED_DYNAMIC_IMPORT)
        }
        if (
            ts.isImportEqualsDeclaration(node) &&
            ts.isExternalModuleReference(node.moduleReference) &&
            node.moduleReference.expression
        ) {
            specifiers.push(
                ts.isStringLiteralLike(node.moduleReference.expression)
                    ? node.moduleReference.expression.text
                    : COMPUTED_DYNAMIC_IMPORT,
            )
        }
        if (ts.isCallExpression(node)) {
            const callee = node.expression.getText(sourceFile)
            if (requireNames.has(callee) || callee === 'module.require') {
                const [argument] = node.arguments
                specifiers.push(argument && ts.isStringLiteralLike(argument) ? argument.text : COMPUTED_DYNAMIC_IMPORT)
            }
        }
        ts.forEachChild(node, visit)
    }
    visit(sourceFile)
    const captured = Object.freeze([...specifiers])
    importSpecifierCache.set(source, captured)
    return [...captured]
}

function resolveImport(importer: string, specifier: string, sources: Sources): string | null {
    if (!specifier.startsWith('.')) return null
    const raw = posix.normalize(posix.join(posix.dirname(importer), specifier))
    const extensionCandidates = raw.endsWith('.mjs')
        ? [`${raw.slice(0, -4)}.mts`, raw, `${raw.slice(0, -4)}.ts`]
        : raw.endsWith('.cjs')
          ? [`${raw.slice(0, -4)}.cts`, raw, `${raw.slice(0, -4)}.ts`]
          : raw.endsWith('.js')
            ? [`${raw.slice(0, -3)}.ts`, raw]
            : null
    const candidates = extensionCandidates ?? [
        raw,
        ...['ts', 'mts', 'cts', 'js', 'mjs', 'cjs'].flatMap((extension) => [
            `${raw}.${extension}`,
            `${raw}/index.${extension}`,
        ]),
    ]
    return candidates.find((candidate) => sources.has(candidate)) ?? candidates[0]
}

function graphFor(sources: Sources): Map<string, string[]> {
    return new Map(
        [...sources].map(([path, source]) => [
            path,
            importSpecifiers(source)
                .map((specifier) => resolveImport(path, specifier, sources))
                .filter((target): target is string => target !== null && sources.has(target)),
        ]),
    )
}

function canonicalModulePath(path: string): string {
    return path.replace(/\.(?:mts|cts|js|mjs|cjs)$/, '.ts')
}

function commandModule(path: string): boolean {
    const canonical = canonicalModulePath(path)
    return (
        /(?:^|\/)commands?(?:\/|\.ts$)/.test(canonical) ||
        canonical.endsWith('/command.ts') ||
        /(?:^|\/)[^/]+-command\.ts$/.test(canonical)
    )
}

const ENVIRONMENT_EXECUTOR = 'packages/cockpit/src/environment-exec/execute.ts'
const ENVIRONMENT_CONTRACT = 'packages/cockpit/src/environment/contract.ts'
const LIFECYCLE_MODULE = 'packages/cockpit/src/environment/lifecycle.ts'
const LIFECYCLE_EXPORTS = [
    'admitUpProgress', 'planAdmittedUp', 'planUp', 'planSleep', 'planDown', 'planResetLifecycle', 'consumeLifecycleIssuance',
] as const
const LIFECYCLE_IMPORT_CONTRACT = new Map<string, readonly string[]>([
    ['node:crypto', ['createHash']],
    ['node:util/types', ['isProxy']],
    ['./contract.js', [
        'ENVIRONMENT_CODES', 'snapshotLifecyclePlan', 'type EnvironmentDiagnostic',
        'type LifecyclePlan', 'type LifecycleProgress',
    ]],
    ['./lifecycle-stage.js', ['consumeLifecycleStageProjection', 'type LifecycleStageProjection']],
    ['./ports.js', ['consumePortLeaseProjection', 'type PortLeaseProjection']],
    ['./reclaim.js', [
        'consumeReclaimTargetProjection', 'type ReclaimTargetEnvelope', 'type ReclaimTargetProjection',
    ]],
    ['./runtime.js', [
        'consumeRuntimeLifecycleProjection', 'isRuntimeServiceEvidence', 'type RuntimeLifecycleEnvelope',
        'type RuntimeLifecycleExecutionSemantics', 'type RuntimeLifecycleProjection',
        'type RuntimeLifecycleSemantics', 'type RuntimeServiceEvidence', 'type RuntimeTopologyEvidence',
    ]],
    ['./claims.js', ['type DrainReservationRequest']],
])

function lifecycleSource(): string {
    return readFileSync(resolve(ROOT, LIFECYCLE_MODULE), 'utf8')
}

const ENVIRONMENT_CODE_PATTERN = /^(?:CONFIG|STATE|SETUP|PORT|CLAIM|INSTALL|TEMPLATE|RUNTIME|RESET|EVIDENCE|RECLAIM|EXECUTION)_[A-Z0-9_]+$/

function environmentCodeViolations(sources: Sources): string[] {
    const independentDiagnosticCodes = new Map<string, ReadonlySet<string>>([
        ['scripts/supply-chain-check.mjs', new Set(['INSTALL_SCRIPT_PRESENT', 'RUNTIME_DEPENDENCIES_CHANGED'])],
    ])
    for (const [path, source] of sources) {
        if (canonicalModulePath(path) === ENVIRONMENT_CONTRACT) continue
        const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
        const initializerFor = (identifier: ts.Identifier): ts.Expression | undefined => {
            let scope: ts.Node | undefined = identifier.parent
            while (scope) {
                if (ts.isBlock(scope) || ts.isSourceFile(scope)) {
                    for (const statement of scope.statements) {
                        if (!ts.isVariableStatement(statement)) continue
                        const declaration = statement.declarationList.declarations.find((candidate) =>
                            ts.isIdentifier(candidate.name) && candidate.name.text === identifier.text)
                        if (declaration?.initializer) return declaration.initializer
                    }
                }
                if (ts.isFunctionLike(scope)) {
                    const parameter = scope.parameters.find((candidate) =>
                        ts.isIdentifier(candidate.name) && candidate.name.text === identifier.text)
                    if (parameter) return parameter.initializer
                }
                scope = scope.parent
            }
            return undefined
        }
        const staticText = (expression: ts.Expression, seen = new Set<number>()): string | undefined => {
            const value = unwrappedExpression(expression)
            if (ts.isStringLiteralLike(value) || ts.isNoSubstitutionTemplateLiteral(value)) return value.text
            if (ts.isIdentifier(value)) {
                const initializer = initializerFor(value)
                if (!initializer || seen.has(initializer.pos)) return undefined
                const nextSeen = new Set(seen)
                nextSeen.add(initializer.pos)
                return staticText(initializer, nextSeen)
            }
            if (ts.isBinaryExpression(value) && value.operatorToken.kind === ts.SyntaxKind.PlusToken) {
                const left = staticText(value.left, seen)
                const right = staticText(value.right, seen)
                return left === undefined || right === undefined ? undefined : left + right
            }
            if (ts.isTemplateExpression(value)) {
                let result = value.head.text
                for (const span of value.templateSpans) {
                    const substitution = staticText(span.expression, seen)
                    if (substitution === undefined) return undefined
                    result += substitution + span.literal.text
                }
                return result
            }
            if (ts.isCallExpression(value) && ts.isPropertyAccessExpression(value.expression)) {
                const receiver = unwrappedExpression(value.expression.expression)
                if (value.expression.name.text === 'concat') {
                    const head = staticText(receiver, seen)
                    const tail = value.arguments.map((argument) => staticText(argument, seen))
                    return head === undefined || tail.includes(undefined) ? undefined : head + tail.join('')
                }
                if (
                    value.expression.name.text === 'join' &&
                    ts.isArrayLiteralExpression(receiver) &&
                    value.arguments.length <= 1
                ) {
                    const separator = value.arguments[0] ? staticText(value.arguments[0], seen) : ','
                    const elements = receiver.elements.map((element) => staticText(element as ts.Expression, seen))
                    return separator === undefined || elements.includes(undefined)
                        ? undefined
                        : elements.join(separator)
                }
            }
            return undefined
        }
        let duplicate = false
        const permitted = independentDiagnosticCodes.get(path) ?? new Set<string>()
        const visit = (node: ts.Node): void => {
            if (ts.isStringLiteralLike(node) && ENVIRONMENT_CODE_PATTERN.test(node.text) && !permitted.has(node.text)) duplicate = true
            if (ts.isExpression(node)) {
                const value = staticText(node)
                if (value !== undefined && ENVIRONMENT_CODE_PATTERN.test(value) && !permitted.has(value)) duplicate = true
            }
            ts.forEachChild(node, visit)
        }
        visit(sourceFile)
        if (duplicate) return ['ARCH027_ENVIRONMENT_CODE_HOME']
    }
    return []
}

function executionBoundaryViolations(
    sources: Sources,
    analysis: ArchitectureAnalysis = analyzeArchitecture(sources),
): string[] {
    const violations = new Set<string>()
    const applicationModules = new Set(
        analysis.declarations
            .filter(({ declaredBy, id, module }) =>
                canonicalModulePath(declaredBy) === canonicalModulePath(module) &&
                canonicalModulePath(module).startsWith('packages/cockpit/src/environment/') &&
                id.endsWith('application'))
            .map(({ module }) => canonicalModulePath(module)),
    )
    for (const [path, source] of sources) {
        const canonical = canonicalModulePath(path)
        if (!canonical.startsWith('packages/cockpit/src/')) continue
        if (commandModule(canonical)) {
            const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
            const executorSpecifier = (value: ts.Expression | undefined): boolean => value !== undefined && ts.isStringLiteralLike(value)
                && resolveImport(path, value.text, sources) === ENVIRONMENT_EXECUTOR
            const executorReferences = importSpecifiers(source)
                .filter(specifier => resolveImport(path, specifier, sources) === ENVIRONMENT_EXECUTOR)
            const typeOnlyReferences = file.statements.filter(statement =>
                (ts.isImportDeclaration(statement) && executorSpecifier(statement.moduleSpecifier)
                    && !!statement.importClause && (statement.importClause.isTypeOnly
                        || !!statement.importClause.namedBindings && ts.isNamedImports(statement.importClause.namedBindings)
                            && !statement.importClause.name && statement.importClause.namedBindings.elements.every(binding => binding.isTypeOnly)))
                || (ts.isExportDeclaration(statement) && statement.moduleSpecifier && executorSpecifier(statement.moduleSpecifier)
                    && (statement.isTypeOnly || !!statement.exportClause && ts.isNamedExports(statement.exportClause)
                        && statement.exportClause.elements.every(binding => binding.isTypeOnly)))
                || (ts.isImportEqualsDeclaration(statement) && statement.isTypeOnly
                    && ts.isExternalModuleReference(statement.moduleReference)
                    && executorSpecifier(statement.moduleReference.expression))).length
            const runtimeReferenceCount = executorReferences.length - typeOnlyReferences
            const comparisonProbeImports = file.statements.filter((statement): statement is ts.ImportDeclaration =>
                ts.isImportDeclaration(statement) && executorSpecifier(statement.moduleSpecifier)
                && !statement.importClause?.isTypeOnly && !statement.importClause?.name && !!statement.importClause?.namedBindings
                && ts.isNamedImports(statement.importClause.namedBindings)
                && statement.importClause.namedBindings.elements.filter(binding => !binding.isTypeOnly).length === 1
                && (statement.importClause.namedBindings.elements.find(binding => !binding.isTypeOnly)?.propertyName
                    ?? statement.importClause.namedBindings.elements.find(binding => !binding.isTypeOnly)?.name)?.text === 'executeProbe')
            const acceptedComparisonProbeOwner = canonical === 'packages/cockpit/src/comparison/command.ts'
                && runtimeReferenceCount === 1 && comparisonProbeImports.length === 1
                && analysis.declarations.some(row => row.id === 'comparison-command'
                    && row.declaredBy === path && row.module === canonical && row.exports.includes('comparisonCommand'))
            if (runtimeReferenceCount > 0 && !acceptedComparisonProbeOwner) violations.add('ARCH026_EXECUTE_PLAN_CALLER')
        }
        const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
        const releaseMetadataCalls = new Set<ts.CallExpression>()
        const compactRelease = (text: string): string => text.replace(/\s+/g, '')
        const releaseQueries = sourceFile.statements.filter((node): node is ts.FunctionDeclaration =>
            ts.isFunctionDeclaration(node) && node.name?.text === 'query')
        const releaseQuery = releaseQueries.length === 1 ? releaseQueries[0] : undefined
        const releaseText = compactRelease(source)
        const httpsImports = sourceFile.statements.filter((node): node is ts.ImportDeclaration =>
            ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier) && node.moduleSpecifier.text === 'node:https')
        const httpsClause = httpsImports.length === 1 ? httpsImports[0]?.importClause : undefined
        const httpsBindings = httpsClause?.namedBindings
        const exactHttpsImport = httpsClause && !httpsClause.isTypeOnly && !httpsClause.name
            && httpsBindings && ts.isNamedImports(httpsBindings) && httpsBindings.elements.length === 1
            && httpsBindings.elements.every(binding => !binding.isTypeOnly && !binding.propertyName && binding.name.text === 'get')
        const releaseBounds = new Map([['TIMEOUT_MS', '2_000'], ['MAX_BYTES', '131_072']])
        const boundDeclarations = new Map<string, ts.Node[]>()
        const collectBounds = (node: ts.Node): void => {
            if ((ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node)
                || ts.isFunctionDeclaration(node)) && node.name && ts.isIdentifier(node.name) && releaseBounds.has(node.name.text)) {
                boundDeclarations.set(node.name.text, [...boundDeclarations.get(node.name.text) ?? [], node])
            }
            ts.forEachChild(node, collectBounds)
        }
        collectBounds(sourceFile)
        const exactReleaseBounds = [...releaseBounds].every(([name, initializer]) => {
            const declarations = boundDeclarations.get(name) ?? []
            const declaration = declarations.length === 1 ? declarations[0] : undefined
            return declaration && ts.isVariableDeclaration(declaration) && ts.isVariableDeclarationList(declaration.parent)
                && (declaration.parent.flags & ts.NodeFlags.Const) !== 0
                && declaration.initializer?.getText(sourceFile) === initializer
        })
        if (canonical === 'packages/cockpit/src/freshness.ts' && releaseQuery?.body
            && analysis.declarations.some(row => row.id === 'release-freshness' && row.declaredBy === path
                && row.module === canonical && row.exports.join('|') === 'discoverReleaseFreshness')
            && exactHttpsImport
            && exactReleaseBounds
            && releaseText.includes('get(url,{signal,headers:')
            && compactRelease(releaseQuery.body.getText(sourceFile)).includes('constcontroller=newAbortController()')
            && compactRelease(releaseQuery.body.getText(sourceFile)).includes('awaitPromise.race([timeout,(async()=>{')
            && compactRelease(releaseQuery.body.getText(sourceFile)).includes('transport({url:`https://registry.npmjs.org/${encodeURIComponent(installedPackageMetadata.name)}/latest`,signal:controller.signal})')) {
            const patterns = new Set([
                "timer=setTimeout(()=>{controller.abort();reject(newError('releasemetadataquerytimedout'))},TIMEOUT_MS)",
                "if(size>MAX_BYTES){controller.abort();thrownewError('releasemetadataexceededbytelimit')}",
                '{if(timer)clearTimeout(timer)controller.abort()}',
            ].map(text => text.replace(/;/g, '')))
            const matchedPatterns = new Set<string>()
            const capture = (node: ts.Node): void => {
                const text = compactRelease(node.getText(sourceFile)).replace(/;/g, '')
                if (patterns.has(text)) {
                    matchedPatterns.add(text)
                    const calls = (child: ts.Node): void => {
                        if (ts.isCallExpression(child)) releaseMetadataCalls.add(child)
                        ts.forEachChild(child, calls)
                    }
                    calls(node)
                }
                ts.forEachChild(node, capture)
            }
            capture(releaseQuery.body)
            if (matchedPatterns.size !== patterns.size) releaseMetadataCalls.clear()
        }
        const importsChildProcess = importSpecifiers(source).some((specifier) =>
            ['node:child_process', 'child_process'].includes(specifier),
        )
        let processExecution = importsChildProcess
        let timeoutOutputSignal = false
        let compensationExecution = false
        let executorPolicy = false

        type Capability = 'process' | 'module' | 'module-loader' | 'global' | 'timer-namespace' | 'timer-call' | 'backoff-delay' | 'protected-call' | 'stream' | 'child-namespace' | 'child-call' | 'executor-namespace' | 'execute-plan' | 'ambiguous'
        const capabilities = new Map<string, Capability>()
        const staticStrings = new Map<string, string | null>()
        const timerNames = new Set(['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate'])
        const streamNames = new Set(['stdin', 'stdout', 'stderr'])
        const childCalls = new Set(['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'])
        capabilities.set('process', 'process')
        capabilities.set('module', 'module')
        capabilities.set('globalThis', 'global')
        for (const name of timerNames) capabilities.set(name, 'timer-call')

        const bindingContains = (name: ts.BindingName, sought: string): boolean => {
            if (ts.isIdentifier(name)) return name.text === sought
            return name.elements.some((element) =>
                !ts.isOmittedExpression(element) && bindingContains(element.name, sought))
        }
        const localVariableInitializer = (identifier: ts.Identifier): ts.Expression | undefined => {
            let scope: ts.Node | undefined = identifier.parent
            while (scope) {
                if (ts.isBlock(scope) || ts.isSourceFile(scope)) {
                    for (const statement of scope.statements) {
                        if (!ts.isVariableStatement(statement)) continue
                        const declaration = statement.declarationList.declarations.find((candidate) =>
                            bindingContains(candidate.name, identifier.text))
                        if (declaration) return declaration.initializer
                    }
                }
                scope = scope.parent
            }
            return undefined
        }
        const parameterShadows = (identifier: ts.Identifier): boolean => {
            let scope: ts.Node | undefined = identifier.parent
            while (scope) {
                if (
                    ts.isFunctionLike(scope) &&
                    scope.parameters.some((parameter) => bindingContains(parameter.name, identifier.text))
                ) return true
                scope = scope.parent
            }
            return false
        }
        const unrelatedImportShadows = (identifier: ts.Identifier): boolean => sourceFile.statements.some((statement) => {
            if (!ts.isImportDeclaration(statement) || !statement.importClause || !ts.isStringLiteralLike(statement.moduleSpecifier)) {
                return false
            }
            const clause = statement.importClause
            const localNames = [
                clause.name?.text,
                clause.namedBindings && ts.isNamespaceImport(clause.namedBindings) ? clause.namedBindings.name.text : undefined,
                ...(clause.namedBindings && ts.isNamedImports(clause.namedBindings)
                    ? clause.namedBindings.elements.map((element) => element.name.text)
                    : []),
            ]
            if (!localNames.includes(identifier.text)) return false
            const allowedModules = identifier.text === 'process'
                ? ['node:process', 'process']
                : timerNames.has(identifier.text)
                  ? ['node:timers', 'timers', 'node:timers/promises', 'timers/promises']
                  : []
            return !allowedModules.includes(statement.moduleSpecifier.text)
        })

        const staticText = (expression: ts.Expression): string | undefined => {
            const unwrapped = unwrappedExpression(expression)
            if (ts.isIdentifier(unwrapped)) return staticStrings.get(unwrapped.text) ?? undefined
            if (ts.isStringLiteralLike(unwrapped) || ts.isNoSubstitutionTemplateLiteral(unwrapped)) return unwrapped.text
            if (ts.isBinaryExpression(unwrapped) && unwrapped.operatorToken.kind === ts.SyntaxKind.PlusToken) {
                const left = staticText(unwrapped.left)
                const right = staticText(unwrapped.right)
                return left === undefined || right === undefined ? undefined : left + right
            }
            return undefined
        }
        const memberName = (expression: ts.Expression): string | undefined => {
            const unwrapped = unwrappedExpression(expression)
            if (ts.isPropertyAccessExpression(unwrapped)) return unwrapped.name.text
            if (ts.isElementAccessExpression(unwrapped)) {
                const argument = unwrapped.argumentExpression && unwrappedExpression(unwrapped.argumentExpression)
                if (argument) return staticText(argument)
            }
            return undefined
        }
        const memberBase = (expression: ts.Expression): ts.Expression | undefined => {
            const unwrapped = unwrappedExpression(expression)
            return ts.isPropertyAccessExpression(unwrapped) || ts.isElementAccessExpression(unwrapped)
                ? unwrapped.expression
                : undefined
        }
        const classify = (expression: ts.Expression): Capability | undefined => {
            const unwrapped = unwrappedExpression(expression)
            if (ts.isAwaitExpression(unwrapped)) return classify(unwrapped.expression)
            if (ts.isIdentifier(unwrapped)) {
                if (parameterShadows(unwrapped)) return undefined
                const predeclared = ['process', 'module', 'globalThis'].includes(unwrapped.text) || timerNames.has(unwrapped.text)
                if (predeclared && unrelatedImportShadows(unwrapped)) return undefined
                const localInitializer = predeclared ? localVariableInitializer(unwrapped) : undefined
                if (localInitializer) {
                    if (ts.isIdentifier(localInitializer) && localInitializer.text === unwrapped.text) {
                        return capabilities.get(unwrapped.text)
                    }
                    return classify(localInitializer)
                }
                return capabilities.get(unwrapped.text)
            }
            if (ts.isCallExpression(unwrapped)) {
                if (unwrapped.expression.kind === ts.SyntaxKind.ImportKeyword) {
                    const [specifier] = unwrapped.arguments
                    const loaded = specifier ? staticText(specifier) : undefined
                    if (loaded && ['node:process', 'process'].includes(loaded)) return 'process'
                    if (loaded && ['node:timers', 'timers', 'node:timers/promises', 'timers/promises'].includes(loaded)) {
                        return 'timer-namespace'
                    }
                    if (loaded === undefined) return 'ambiguous'
                }
                const name = memberName(unwrapped.expression)
                const base = memberBase(unwrapped.expression)
                if (name === 'getBuiltinModule' && base && classify(base) === 'process') {
                    const [specifier] = unwrapped.arguments
                    const loaded = specifier ? staticText(specifier) : undefined
                    if (loaded && ['node:child_process', 'child_process'].includes(loaded)) {
                        return 'child-namespace'
                    }
                    if (loaded === undefined) return 'ambiguous'
                }
                if (classify(unwrapped.expression) === 'module-loader') {
                    const [specifier] = unwrapped.arguments
                    const loaded = specifier ? staticText(specifier) : undefined
                    if (loaded && ['node:child_process', 'child_process'].includes(loaded)) {
                        return 'child-namespace'
                    }
                    if (loaded === undefined) return 'ambiguous'
                }
                if (
                    ts.isPropertyAccessExpression(unwrapped.expression) &&
                    unwrapped.expression.expression.getText(sourceFile) === 'Reflect' &&
                    unwrapped.expression.name.text === 'apply'
                ) {
                    const [target] = unwrapped.arguments
                    return target ? classify(target) : undefined
                }
                const callee = classify(unwrapped.expression)
                return callee === 'module-loader' || callee === 'timer-call' || callee === 'backoff-delay' || callee === 'protected-call' || callee === 'child-call' || callee === 'execute-plan' || callee === 'ambiguous'
                    ? callee
                    : undefined
            }
            const name = memberName(unwrapped)
            const base = memberBase(unwrapped)
            if (!name || !base) return undefined
            const owner = classify(base)
            if (owner === 'ambiguous') return 'ambiguous'
            if (owner === 'process' && name === 'kill') return 'protected-call'
            if (owner === 'process' && streamNames.has(name)) return 'stream'
            if (owner === 'global' && name === 'process') return 'process'
            if (owner === 'module' && name === 'require') return 'module-loader'
            if (owner === 'global' && timerNames.has(name)) return 'timer-call'
            if (owner === 'timer-namespace' && timerNames.has(name)) return 'timer-call'
            if (owner === 'stream' && ['write', 'pipe', 'read', 'resume', 'setEncoding'].includes(name)) return 'protected-call'
            if (owner === 'child-namespace' && childCalls.has(name)) return 'child-call'
            if (owner === 'executor-namespace' && name === 'executePlan') return 'execute-plan'
            if (['module-loader', 'timer-call', 'backoff-delay', 'protected-call', 'child-call', 'execute-plan'].includes(owner ?? '') && ['bind', 'call', 'apply'].includes(name)) {
                return owner
            }
            return undefined
        }

        for (const statement of sourceFile.statements) {
            if (!ts.isImportDeclaration(statement) || !statement.importClause || !ts.isStringLiteralLike(statement.moduleSpecifier)) continue
            const specifier = statement.moduleSpecifier.text
            const bindings = statement.importClause.namedBindings
            if (['node:timers', 'timers', 'node:timers/promises', 'timers/promises'].includes(specifier)) {
                if (statement.importClause.name) capabilities.set(statement.importClause.name.text, 'timer-namespace')
                if (bindings && ts.isNamespaceImport(bindings)) capabilities.set(bindings.name.text, 'timer-namespace')
                else if (bindings) for (const binding of bindings.elements) {
                    const imported = (binding.propertyName ?? binding.name).text
                    if (timerNames.has(imported)) {
                        capabilities.set(
                            binding.name.text,
                            specifier === 'node:timers/promises' && imported === 'setTimeout'
                                ? 'backoff-delay'
                                : 'timer-call',
                        )
                    }
                }
            }
            if (['node:process', 'process'].includes(specifier)) {
                if (statement.importClause.name) capabilities.set(statement.importClause.name.text, 'process')
                if (bindings && ts.isNamespaceImport(bindings)) capabilities.set(bindings.name.text, 'process')
                else if (bindings) for (const binding of bindings.elements) {
                    const imported = (binding.propertyName ?? binding.name).text
                    if (imported === 'kill') capabilities.set(binding.name.text, 'protected-call')
                    if (streamNames.has(imported)) capabilities.set(binding.name.text, 'stream')
                }
            }
            if (['node:child_process', 'child_process'].includes(specifier) && bindings) {
                if (ts.isNamespaceImport(bindings)) capabilities.set(bindings.name.text, 'child-namespace')
                else for (const binding of bindings.elements) {
                    if (childCalls.has((binding.propertyName ?? binding.name).text)) capabilities.set(binding.name.text, 'child-call')
                }
            }
            if (resolveImport(path, specifier, sources) === ENVIRONMENT_EXECUTOR && bindings) {
                if (ts.isNamespaceImport(bindings)) capabilities.set(bindings.name.text, 'executor-namespace')
                else for (const binding of bindings.elements) {
                    if ((binding.propertyName ?? binding.name).text === 'executePlan') capabilities.set(binding.name.text, 'execute-plan')
                }
            }
        }

        let bindingsChanged = false
        const recordStaticString = (name: string, value: string | undefined): void => {
            if (!staticStrings.has(name)) {
                if (value !== undefined) {
                    staticStrings.set(name, value)
                    bindingsChanged = true
                }
                return
            }
            const current = staticStrings.get(name)
            if (current !== null && current !== value) {
                staticStrings.set(name, null)
                bindingsChanged = true
            }
        }
        const recordCapability = (name: string, capability: Capability | undefined): void => {
            if (!capabilities.has(name)) {
                if (capability) {
                    capabilities.set(name, capability)
                    bindingsChanged = true
                }
                return
            }
            const current = capabilities.get(name)
            if (current !== 'ambiguous' && current !== capability) {
                capabilities.set(name, 'ambiguous')
                bindingsChanged = true
            }
        }
        const bindCapabilities = (node: ts.Node): void => {
            if (ts.isVariableDeclaration(node) && node.initializer) {
                if (ts.isIdentifier(node.name)) {
                    recordStaticString(node.name.text, staticText(node.initializer))
                }
                const capability = classify(node.initializer)
                if (ts.isIdentifier(node.name)) recordCapability(node.name.text, capability)
                if (ts.isObjectBindingPattern(node.name)) {
                    const owner = classify(node.initializer)
                    for (const element of node.name.elements) {
                        if (ts.isOmittedExpression(element) || !ts.isIdentifier(element.name)) continue
                        const name = (element.propertyName ?? element.name).getText(sourceFile).replace(/^['"]|['"]$/g, '')
                        const bound = owner === 'process' && name === 'kill' ? 'protected-call'
                            : owner === 'process' && streamNames.has(name) ? 'stream'
                            : owner === 'module' && name === 'require' ? 'module-loader'
                            : owner === 'global' && timerNames.has(name) ? 'timer-call'
                            : owner === 'child-namespace' && childCalls.has(name) ? 'child-call'
                            : owner === 'executor-namespace' && name === 'executePlan' ? 'execute-plan'
                            : undefined
                        recordCapability(element.name.text, bound)
                    }
                }
            }
            if (
                ts.isBinaryExpression(node) &&
                node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
                ts.isIdentifier(node.left)
            ) {
                recordStaticString(node.left.text, staticText(node.right))
                recordCapability(node.left.text, classify(node.right))
            }
            ts.forEachChild(node, bindCapabilities)
        }
        do {
            bindingsChanged = false
            bindCapabilities(sourceFile)
        } while (bindingsChanged)

        const visit = (node: ts.Node): void => {
            const insideStateTransaction = (): boolean => {
                let cursor: ts.Node | undefined = node.parent
                while (cursor) {
                    if (ts.isFunctionDeclaration(cursor)) return cursor.name?.text === 'transactState'
                        || cursor.name?.text === 'withStateScopedLock'
                    cursor = cursor.parent
                }
                return false
            }
            const boundedBackoffCall = (): boolean =>
                ts.isCallExpression(node) &&
                node.arguments.length === 1 &&
                node.arguments[0]?.getText(sourceFile) === 'Math.min(backoffMs, remainingMs)'
            const permittedFilesystemExpectation =
                ts.isIdentifier(node) &&
                node.text === 'expected' &&
                ts.isPropertyAccessExpression(node.parent) &&
                node.parent.name === node &&
                node.parent.expression.getText(sourceFile) === 'check'
            if (canonical === ENVIRONMENT_EXECUTOR && !permittedFilesystemExpectation && (
                (ts.isIdentifier(node) && ['paths', 'ports', 'labels', 'expected'].includes(node.text)) ||
                (ts.isStringLiteralLike(node) && ['paths', 'ports', 'labels', 'expected'].includes(node.text))
            )) {
                executorPolicy = true
            }
            if (ts.isFunctionDeclaration(node) && node.name && /compensat/i.test(node.name.text)) {
                compensationExecution = true
            }
            if (ts.isCallExpression(node)) {
                const capability = classify(node.expression)
                if (capability === 'timer-call' && !releaseMetadataCalls.has(node)) timeoutOutputSignal = true
                if (capability === 'backoff-delay') {
                    if (!(canonical === STATE_MODULE && insideStateTransaction() && boundedBackoffCall())) {
                        timeoutOutputSignal = true
                    }
                }
                if (capability === 'protected-call') timeoutOutputSignal = true
                if (capability === 'child-call' || classify(node) === 'child-namespace') processExecution = true
                if (capability === 'execute-plan' && !applicationModules.has(canonical)) {
                    violations.add('ARCH026_EXECUTE_PLAN_CALLER')
                }
                if (capability === 'ambiguous') {
                    timeoutOutputSignal = true
                    processExecution = true
                    if (!applicationModules.has(canonical)) violations.add('ARCH026_EXECUTE_PLAN_CALLER')
                }
                const callee = node.expression.getText(sourceFile)
                const name = ts.isIdentifier(node.expression)
                    ? node.expression.text
                    : ts.isPropertyAccessExpression(node.expression)
                      ? node.expression.name.text
                      : callee
                if (name === 'abort' && !releaseMetadataCalls.has(node)) timeoutOutputSignal = true
                if (/compensat/i.test(name)) compensationExecution = true
                if (/^(?:choose|select|classify|derive|prompt|verdict|applyPolicy)/i.test(name)) executorPolicy = true
            }
            if (
                (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
                classify(node) === 'stream'
            ) timeoutOutputSignal = true
            if (ts.isElementAccessExpression(node) && memberName(node) === undefined) {
                const owner = classify(node.expression)
                if (owner === 'executor-namespace' && !applicationModules.has(canonical)) {
                    violations.add('ARCH026_EXECUTE_PLAN_CALLER')
                }
                if (owner === 'timer-namespace') timeoutOutputSignal = true
                if (['process', 'global', 'stream', 'protected-call'].includes(owner ?? '')) {
                    timeoutOutputSignal = true
                }
                if (['module', 'module-loader', 'child-namespace', 'child-call'].includes(owner ?? '')) {
                    processExecution = true
                }
            }
            ts.forEachChild(node, visit)
        }
        visit(sourceFile)

        if (canonical !== ENVIRONMENT_EXECUTOR) {
            if (processExecution) violations.add('ARCH022_PROCESS_EXECUTION_HOME')
            if (timeoutOutputSignal) violations.add('ARCH023_TIMEOUT_OUTPUT_SIGNAL_HOME')
            if (
                compensationExecution
                && canonical !== PORTS_MODULE
                && !(canonical === 'packages/cockpit/src/generated-environment/transaction.ts'
                    && analysis.declarations.some(row => row.id === 'generated-publication-transaction'
                        && row.declaredBy === path && row.module === canonical))
                && !applicationModules.has(canonical)
                && !(canonical === 'packages/cockpit/src/environment/destructive-composition.ts'
                    && analysis.declarations.some(row => row.id === 'destructive-adapter-composition'
                        && row.declaredBy === path && row.module === canonical
                        && row.exports.includes('withBoundedComparisonLifecycle')))
            ) violations.add('ARCH024_COMPENSATION_EXECUTION_HOME')
        } else if (executorPolicy) {
            violations.add('ARCH025_EXECUTOR_POLICY')
        }
    }
    return [...violations]
}

function kernelLeaf(path: string): boolean {
    return KERNEL_LEAVES.has(canonicalModulePath(path))
}

function cycleViolations(graph: ReadonlyMap<string, readonly string[]>): string[] {
    const visiting = new Set<string>()
    const visited = new Set<string>()
    const violations = new Set<string>()

    function visit(path: string): void {
        if (visiting.has(path)) {
            violations.add('ARCH001_CYCLE')
            return
        }
        if (visited.has(path)) return
        visiting.add(path)
        for (const target of graph.get(path) ?? []) visit(target)
        visiting.delete(path)
        visited.add(path)
    }

    for (const path of graph.keys()) visit(path)
    return [...violations]
}

function importDirectionViolations(sources: Sources): string[] {
    sources = new Map([...sources].map(([path, source]) => [path, boundedMaintainerImports(path, source)]))
    const graph = graphFor(sources)
    const violations = new Set(cycleViolations(graph))

    if ([...sources.values()].some((source) => importSpecifiers(source).includes(COMPUTED_DYNAMIC_IMPORT))) {
        violations.add('ARCH017_COMPUTED_DYNAMIC_IMPORT')
    }

    const reachesCommandBoundary = (path: string, visited = new Set<string>()): boolean => {
        if (visited.has(path)) return false
        visited.add(path)
        return (graph.get(path) ?? []).some((target) => {
            const canonicalTarget = canonicalModulePath(target)
            return commandModule(target) || canonicalTarget.endsWith('/cli.ts')
                || reachesCommandBoundary(target, visited)
        })
    }

    for (const [path, targets] of graph) {
        if (kernelLeaf(path) && reachesCommandBoundary(path)) {
            violations.add('ARCH002_KERNEL_DIRECTION')
        }
        for (const target of targets) {
            const canonicalTarget = canonicalModulePath(target)
            if (
                canonicalModulePath(path) === LIFECYCLE_MODULE
                    && (canonicalTarget.endsWith('/application.ts') || canonicalTarget.includes('/environment-exec/'))
                || canonicalModulePath(path) === 'packages/cockpit/src/environment/application.ts'
                    && commandModule(target)
                || canonicalModulePath(path) === 'packages/cockpit/src/environment/runtime.ts'
                    && ['packages/cockpit/src/environment/logs.ts', 'packages/cockpit/src/environment/application.ts']
                        .includes(canonicalTarget)
                || canonicalModulePath(path) === 'packages/cockpit/src/environment/logs.ts'
                    && canonicalTarget === 'packages/cockpit/src/environment/application.ts'
            ) {
                violations.add('ARCH002_KERNEL_DIRECTION')
            }
            if (canonicalModulePath(path).endsWith('/command-table.ts') && commandModule(target)) {
                violations.add('ARCH003_COMMAND_TABLE_HANDLER_IMPORT')
            }
            if (
                commandModule(path) &&
                (canonicalModulePath(target).endsWith('/command-table.ts') ||
                    canonicalModulePath(target).endsWith('/cli.ts'))
            ) {
                violations.add('ARCH004_HANDLER_REVERSE_IMPORT')
            }
            if (commandModule(path) && commandModule(target)) {
                violations.add('ARCH005_PEER_COMMAND_IMPORT')
            }
        }
    }
    return [...violations]
}

function namedFunction(sourceFile: ts.SourceFile, name: string): ts.FunctionDeclaration | undefined {
    return sourceFile.statements.find(
        (statement): statement is ts.FunctionDeclaration =>
            ts.isFunctionDeclaration(statement) && statement.name?.text === name,
    )
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
    return ts.canHaveModifiers(node) && !!ts.getModifiers(node)?.some((modifier) => modifier.kind === kind)
}

function hasMechanicalWrite(source: string): boolean {
    const sourceFile = ts.createSourceFile('cli.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    const execution = namedFunction(sourceFile, 'executeOutcome')
    if (!execution?.body) return false
    let writes = 0
    let validWrites = 0
    const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node) && node.expression.getText(sourceFile) === 'writeFile') {
            writes += 1
            const [destination, artifact, options] = node.arguments
            const flag = options && ts.isObjectLiteralExpression(options)
                ? options.properties.find(
                    (property): property is ts.PropertyAssignment =>
                        ts.isPropertyAssignment(property) && property.name.getText(sourceFile) === 'flag',
                )
                : undefined
            const valid =
                node.parent.kind === ts.SyntaxKind.AwaitExpression &&
                destination?.getText(sourceFile).replace(/\s/g, '') === 'outcome.destination' &&
                artifact?.getText(sourceFile).replace(/\s/g, '') === 'outcome.artifact' &&
                !!flag &&
                ts.isStringLiteralLike(flag.initializer) &&
                flag.initializer.text === 'wx'
            if (valid) validWrites += 1
        }
        ts.forEachChild(node, visit)
    }
    visit(execution.body)
    return writes === 1 && validWrites === 1
}

function hasDecisionSyntax(source: string): boolean {
    const sourceFile = ts.createSourceFile('cli.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    const execution = namedFunction(sourceFile, 'executeOutcome')
    const dispatch = namedFunction(sourceFile, 'runCli')
    const environmentExecution = namedFunction(sourceFile, 'executeEnvironmentOutcome')
    if (!execution?.body) return false

    const finishDeclarations: ts.VariableDeclaration[] = []
    const locateFinish = (node: ts.Node): void => {
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'finish') finishDeclarations.push(node)
        ts.forEachChild(node, locateFinish)
    }
    if (dispatch?.body) locateFinish(dispatch.body)
    const finish = finishDeclarations.length === 1 ? finishDeclarations[0] : undefined
    const exactFinish = finish && ts.isVariableDeclarationList(finish.parent)
        && (finish.parent.flags & ts.NodeFlags.Const) !== 0 && finish.parent.parent.parent === dispatch?.body
        && finish.initializer && ts.isArrowFunction(finish.initializer)
        && finish.initializer.getText(sourceFile).replace(/\s/g, '') === `
            (status: number, outcome?: CommandOutcome): number => {
                const exitCode = status === EXIT_CODES.success ? EXIT_CODES.success
                    : status === EXIT_CODES.cancelled ? EXIT_CODES.cancelled : EXIT_CODES.failure
                if (outcome) {
                    const invocation = createInvocationRecord({ verb, durationMs: Math.floor(performance.now() - startedAt),
                        exitCode, resolvedConfigPath })
                    io.stdout.write(renderJsonResponse({ ...outcome, invocation }, outcome.fixContext))
                }
                return exitCode
            }`.replace(/\s/g, '')
    let violation = false
    const inspect = (root: ts.Node, allowedCalls: ReadonlySet<string>, minimumPosition = root.getStart(sourceFile)): void => {
        const visit = (node: ts.Node): void => {
            if (node.getStart(sourceFile) >= minimumPosition) {
                if (ts.isCallExpression(node)) {
                    const callee = node.expression.getText(sourceFile).replace(/\s/g, '')
                    const invocationPublication = root === dispatch?.body && exactFinish && callee === 'finish'
                        && ['outcome!.status', 'outcome!.status,outcome!'].includes(node.arguments.map(argument =>
                            argument.getText(sourceFile).replace(/\s/g, '')).join(','))
                    if (!allowedCalls.has(callee) && !invocationPublication) violation = true
                }
                const inExecution = root === execution.body
                if (ts.isConditionalExpression(node)) {
                    const condition = node.condition.getText(sourceFile).replace(/\s/g, '')
                    const allowed = inExecution ? condition === "code==='EEXIST'" : condition === 'errorinstanceofError'
                    if (!allowed) violation = true
                }
                if (ts.isIfStatement(node)) {
                    const condition = node.expression.getText(sourceFile).replace(/\s/g, '')
                    const allowedConditions = inExecution
                        ? new Set(['!outcome.artifact||!outcome.destination'])
                        : new Set([
                            '!values.json',
                            '!parsed.values.json',
                            'jsonRequested',
                            'outcome.plan',
                            'outcome.artifact&&!outcome.destination',
                            'outcome!.artifact&&!outcome!.destination',
                        ])
                    if (!allowedConditions.has(condition)) violation = true
                }
                if (
                    ts.isBinaryExpression(node) &&
                    node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
                    node.left.getText(sourceFile).replace(/\s/g, '').startsWith('outcome.')
                ) {
                    violation = true
                }
                if (
                    ts.isBinaryExpression(node) &&
                    node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
                    node.left.getText(sourceFile).replace(/\s/g, '') === 'outcome'
                ) {
                    let parent: ts.Node | undefined = node.parent
                    let insideCatch = false
                    while (parent) {
                        if (ts.isCatchClause(parent)) insideCatch = true
                        parent = parent.parent
                    }
                    const awaitedCall = ts.isAwaitExpression(node.right) && ts.isCallExpression(node.right.expression)
                        ? node.right.expression
                        : null
                    const directCall = ts.isCallExpression(node.right) ? node.right : null
                    const allowedAssignment = !inExecution && (
                        ['handlers[definition.handler]', 'invokeHandler'].includes(
                            awaitedCall?.expression.getText(sourceFile).replace(/\s/g, '') ?? '',
                        ) ||
                        (awaitedCall?.expression.getText(sourceFile).replace(/\s/g, '') === 'executeOutcome' &&
                            awaitedCall.arguments.length === 1 &&
                            awaitedCall.arguments[0].getText(sourceFile).replace(/\s/g, '') === 'outcome') ||
                        (awaitedCall?.expression.getText(sourceFile).replace(/\s/g, '') === 'executeEnvironmentOutcome' &&
                            awaitedCall.arguments.length === 1 &&
                            awaitedCall.arguments[0].getText(sourceFile).replace(/\s/g, '') === 'outcome') ||
                        (insideCatch && directCall?.expression.getText(sourceFile).replace(/\s/g, '') === 'usageOutcome')
                    )
                    if (!allowedAssignment) violation = true
                }
                if (inExecution) {
                    if (ts.isBinaryExpression(node)) {
                        const expression = node.getText(sourceFile).replace(/\s/g, '')
                        if (expression.includes('outcome.') && expression !== '!outcome.artifact||!outcome.destination') {
                            violation = true
                        }
                    }
                    if (ts.isElementAccessExpression(node) && node.getText(sourceFile).includes('outcome.')) {
                        violation = true
                    }
                    if (
                        ((ts.isPrefixUnaryExpression(node) &&
                            [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator)) ||
                            ts.isPostfixUnaryExpression(node)) &&
                        node.operand.getText(sourceFile).replace(/\s/g, '').startsWith('outcome.')
                    ) {
                        violation = true
                    }
                    if (
                        ts.isSwitchStatement(node) ||
                        ts.isForStatement(node) ||
                        ts.isForInStatement(node) ||
                        ts.isForOfStatement(node) ||
                        ts.isWhileStatement(node) ||
                        ts.isDoStatement(node)
                    ) {
                        violation = true
                    }
                }
            }
            ts.forEachChild(node, visit)
        }
        visit(root)
    }

    inspect(execution.body, new Set(['writeFile']))
    if (dispatch?.body) {
        const handlerPositions: number[] = []
        const locateHandler = (node: ts.Node): void => {
            if (ts.isCallExpression(node)) {
                const callee = node.expression.getText(sourceFile).replace(/\s/g, '')
                if (
                    callee.startsWith('handlers[') ||
                    callee.startsWith('handlers.') ||
                    callee === 'invokeHandler'
                ) {
                    let boundary: ts.Node = node
                    while (boundary.parent && !ts.isStatement(boundary)) boundary = boundary.parent
                    handlerPositions.push(boundary.getStart(sourceFile))
                }
            }
            ts.forEachChild(node, locateHandler)
        }
        locateHandler(dispatch.body)
        if (handlerPositions.length !== 1) violation = true
        const [handlerPosition = -1] = handlerPositions
        if (handlerPosition >= 0) {
            inspect(
                dispatch.body,
                new Set([
                    'handlers[definition.handler]',
                    'invokeHandler',
                    'executeOutcome',
                    'executeEnvironmentOutcome',
                    'usageOutcome',
                    'renderJsonResponse',
                    'renderHumanDiagnostics',
                    'io.stdout.write',
                    'io.stderr.write',
                ]),
                handlerPosition,
            )
        } else {
            violation = true
        }
    } else {
        violation = true
    }
    if (environmentExecution?.body) {
        const body = environmentExecution.body.getText(sourceFile).replace(/\s/g, '')
        const calls: ts.CallExpression[] = []
        const collectCalls = (node: ts.Node): void => {
            if (ts.isCallExpression(node)) calls.push(node)
            ts.forEachChild(node, collectCalls)
        }
        collectCalls(environmentExecution.body)
        const executeCalls = calls.filter((call) => call.expression.getText(sourceFile) === 'executePlan')
        const policyCall = calls.some((call) => /^(?:choose|select|classify|derive|prompt|verdict|applyPolicy)/i.test(call.expression.getText(sourceFile)))
        if (
            executeCalls.length !== 1 ||
            executeCalls[0].arguments[0]?.getText(sourceFile).replace(/\s/g, '') !== 'outcome.plan' ||
            !body.includes('if(!outcome.plan)returnoutcome') ||
            policyCall
        ) violation = true
    }
    return violation
}

function boundaryViolations(sources: Sources): string[] {
    const violations = new Set<string>()
    const command = sources.get('packages/cockpit/src/document/command.ts') ?? ''
    const cli = sources.get('packages/cockpit/src/cli.ts') ?? ''
    const outcome = /interface\s+OutcomeBase\s*\{(?<body>[\s\S]*?)\n\}/.exec(command)?.groups?.body ?? ''
    const cliSource = ts.createSourceFile('cli.ts', cli, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    const execution = namedFunction(cliSource, 'executeOutcome')

    if (/\b(?:writeFile|appendFile|createWriteStream|writeFileSync|openSync)\b/.test(command)) {
        violations.add('ARCH006_COMMAND_WRITES')
    }
    for (const field of ['artifact', 'destination', 'diagnostics', 'status']) {
        if (!new RegExp(`\\b${field}\\s*:`).test(outcome)) violations.add('ARCH007_OUTCOME_CONTRACT')
    }
    if (!execution?.body) violations.add('ARCH008_EXECUTION_EDGE_MISSING')
    if (hasDecisionSyntax(cli)) {
        violations.add('ARCH009_EXECUTION_RECLASSIFIES')
    }
    if (execution?.body && !hasMechanicalWrite(cli)) {
        violations.add('ARCH010_EXECUTION_NOT_MECHANICAL')
    }
    return [...violations]
}

interface MechanismDeclaration {
    declaredBy: string
    exports: readonly string[]
    id: string
    module: string
}

function unwrappedExpression(expression: ts.Expression): ts.Expression {
    let current = expression
    while (ts.isAsExpression(current) || ts.isSatisfiesExpression(current) || ts.isParenthesizedExpression(current)) {
        current = current.expression
    }
    return current
}

function objectProperty(object: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined {
    const property = object.properties.find(
        (item): item is ts.PropertyAssignment =>
            ts.isPropertyAssignment(item) &&
            ((ts.isIdentifier(item.name) && item.name.text === name) ||
                (ts.isStringLiteralLike(item.name) && item.name.text === name)),
    )
    return property?.initializer
}

function stringProperty(object: ts.ObjectLiteralExpression, name: string): string | undefined {
    const value = objectProperty(object, name)
    return value && ts.isStringLiteralLike(value) ? value.text : undefined
}

function stringArrayProperty(object: ts.ObjectLiteralExpression, name: string): string[] {
    const value = objectProperty(object, name)
    if (!value) return []
    const array = unwrappedExpression(value)
    return ts.isArrayLiteralExpression(array)
        ? array.elements.filter(ts.isStringLiteralLike).map((element) => element.text)
        : []
}

function mechanismDeclarations(sources: Sources): MechanismDeclaration[] {
    const declarations: MechanismDeclaration[] = []
    for (const [path, source] of sources) {
        const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
        for (const statement of sourceFile.statements) {
            if (!ts.isVariableStatement(statement) || !statement.modifiers?.some((item) => item.kind === ts.SyntaxKind.ExportKeyword)) {
                continue
            }
            for (const declaration of statement.declarationList.declarations) {
                if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue
                const initializer = unwrappedExpression(declaration.initializer)
                if (declaration.name.text === 'mechanism' && ts.isObjectLiteralExpression(initializer)) {
                    const id = stringProperty(initializer, 'id')
                    const module = stringProperty(initializer, 'module')
                    if (id && module) {
                        declarations.push({
                            declaredBy: path,
                            exports: stringArrayProperty(initializer, 'exports'),
                            id,
                            module,
                        })
                    }
                }
                if (
                    declaration.name.text === 'IMPLEMENTED_MECHANISMS' &&
                    ts.isCallExpression(initializer) &&
                    initializer.expression.getText(sourceFile) === 'Object.freeze' &&
                    ts.isArrayLiteralExpression(initializer.arguments[0])
                ) {
                    for (const rawElement of initializer.arguments[0].elements) {
                        const element = unwrappedExpression(rawElement)
                        if (ts.isStringLiteralLike(element)) {
                            declarations.push({ declaredBy: path, exports: [], id: element.text, module: path })
                        } else if (ts.isObjectLiteralExpression(element)) {
                            const id = stringProperty(element, 'id')
                            if (id) {
                                declarations.push({
                                    declaredBy: path,
                                    exports: stringArrayProperty(element, 'exports'),
                                    id,
                                    module: path,
                                })
                            }
                        }
                    }
                }
            }
        }
    }
    return declarations
}

function bindingNames(name: ts.BindingName): string[] {
    if (ts.isIdentifier(name)) return [name.text]
    return name.elements.flatMap((element) => (ts.isOmittedExpression(element) ? [] : bindingNames(element.name)))
}

function exportedImplementations(source: string): Set<string> {
    const sourceFile = ts.createSourceFile('module.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    const implementations = new Set<string>()
    for (const statement of sourceFile.statements) {
        if (
            ts.isExpressionStatement(statement) &&
            ts.isBinaryExpression(statement.expression) &&
            statement.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken
        ) {
            const target = statement.expression.left.getText(sourceFile)
            if (target === 'module.exports') implementations.add('default')
            const named = /^(?:exports|module\.exports)(?:\.([A-Za-z_$][\w$]*)|\[['"]([^'"]+)['"]\])$/.exec(
                target,
            )
            const name = named?.[1] ?? named?.[2]
            if (name && !['mechanism', 'IMPLEMENTED_MECHANISMS'].includes(name)) implementations.add(name)
        }
        if (ts.isExportAssignment(statement)) {
            implementations.add(statement.isExportEquals ? 'export=' : 'default')
        }
        if (ts.isExportDeclaration(statement) && !statement.isTypeOnly) {
            if (!statement.exportClause) implementations.add('*')
            else if (ts.isNamespaceExport(statement.exportClause)) implementations.add(statement.exportClause.name.text)
            else {
                for (const element of statement.exportClause.elements) {
                    if (!element.isTypeOnly) implementations.add(element.name.text)
                }
            }
        }
        const exported = hasModifier(statement, ts.SyntaxKind.ExportKeyword)
        if (!exported) continue
        if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) {
            implementations.add(hasModifier(statement, ts.SyntaxKind.DefaultKeyword) ? 'default' : (statement.name?.text ?? 'default'))
        }
        if (ts.isVariableStatement(statement)) {
            for (const declaration of statement.declarationList.declarations) {
                for (const name of bindingNames(declaration.name)) {
                    if (!['mechanism', 'IMPLEMENTED_MECHANISMS'].includes(name)) implementations.add(name)
                }
            }
        }
        if (
            (ts.isEnumDeclaration(statement) || ts.isModuleDeclaration(statement)) &&
            !hasModifier(statement, ts.SyntaxKind.DeclareKeyword)
        ) {
            implementations.add(statement.name.text)
        }
    }
    return implementations
}

interface ArchitectureAnalysis {
    readonly declarations: readonly MechanismDeclaration[]
    readonly implementationsByPath: ReadonlyMap<string, ReadonlySet<string>>
    readonly implementationOwnersByFacet: ReadonlyMap<string, ReadonlySet<string>>
}

function analyzeArchitecture(sources: Sources): ArchitectureAnalysis {
    const implementationsByPath = new Map<string, ReadonlySet<string>>()
    const implementationOwnersByFacet = new Map<string, Set<string>>()
    for (const [path, source] of sources) {
        const implementations = exportedImplementations(source)
        implementationsByPath.set(path, implementations)
        for (const implementation of implementations) {
            const owners = implementationOwnersByFacet.get(implementation) ?? new Set<string>()
            owners.add(canonicalModulePath(path))
            implementationOwnersByFacet.set(implementation, owners)
        }
    }
    return {
        declarations: mechanismDeclarations(sources),
        implementationsByPath,
        implementationOwnersByFacet,
    }
}

function supportedCommonJsExportAssignment(node: ts.Identifier, sourceFile: ts.SourceFile): boolean {
    let target: ts.Expression =
        ts.isPropertyAccessExpression(node.parent) &&
        node.parent.name === node &&
        ts.isIdentifier(node.parent.expression) &&
        node.parent.expression.text === 'module'
            ? node.parent
            : node
    while (
        (ts.isPropertyAccessExpression(target.parent) || ts.isElementAccessExpression(target.parent)) &&
        target.parent.expression === target
    ) {
        target = target.parent
    }
    return (
        ts.isBinaryExpression(target.parent) &&
        target.parent.left === target &&
        target.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        /^(?:exports(?:\.[A-Za-z_$][\w$]*|\[['"][^'"]+['"]\])|module\.exports(?:\.[A-Za-z_$][\w$]*|\[['"][^'"]+['"]\])?)$/.test(
            target.getText(sourceFile),
        )
    )
}

function unsupportedCommonJsSyntax(source: string): boolean {
    const sourceFile = ts.createSourceFile('module.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    let unsupported = false
    const bindings = new Map<ts.Node, Set<string>>()
    const scopeOf = (node: ts.Node): ts.Node => {
        let scope = node.parent
        while (!ts.isSourceFile(scope) && !ts.isBlock(scope) && !ts.isFunctionLike(scope)) scope = scope.parent
        return scope
    }
    const bind = (name: ts.BindingName, scope: ts.Node): void => {
        if (ts.isIdentifier(name)) {
            const names = bindings.get(scope) ?? new Set<string>()
            names.add(name.text)
            bindings.set(scope, names)
        } else {
            for (const element of name.elements) if (ts.isBindingElement(element)) bind(element.name, scope)
        }
    }
    const collectBindings = (node: ts.Node): void => {
        if (ts.isVariableDeclaration(node) || ts.isParameter(node)) bind(node.name, scopeOf(node))
        ts.forEachChild(node, collectBindings)
    }
    collectBindings(sourceFile)
    const localBinding = (node: ts.Identifier): boolean => {
        let scope: ts.Node | undefined = node.parent
        while (scope) {
            if (bindings.get(scope)?.has(node.text)) return true
            scope = scope.parent
        }
        return false
    }
    const declarationRole = (node: ts.Identifier): boolean => {
        const parent = node.parent
        return ((ts.isPropertyAssignment(parent) || ts.isPropertySignature(parent) || ts.isMethodSignature(parent)
            || ts.isPropertyDeclaration(parent) || ts.isMethodDeclaration(parent)) && parent.name === node)
            || (ts.isBindingElement(parent) && (parent.name === node || parent.propertyName === node))
            || ((ts.isVariableDeclaration(parent) || ts.isParameter(parent)) && parent.name === node)
    }
    const requireNames = new Set(['require'])
    const isDirectModuleRequire = (node: ts.Expression): boolean =>
        ts.isPropertyAccessExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'module' &&
        node.name.text === 'require'
    const isRequireReference = (node: ts.Expression): boolean => {
        const expression = unwrappedExpression(node)
        return (ts.isIdentifier(expression) && requireNames.has(expression.text)) || isDirectModuleRequire(expression)
    }
    const collectRequireAliases = (node: ts.Node): void => {
        if (
            ts.isVariableDeclaration(node) &&
            ts.isIdentifier(node.name) &&
            node.initializer &&
            isRequireReference(node.initializer)
        ) {
            requireNames.add(node.name.text)
        }
        if (
            ts.isBinaryExpression(node) &&
            node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
            ts.isIdentifier(node.left) &&
            isRequireReference(node.right)
        ) {
            requireNames.add(node.left.text)
        }
        ts.forEachChild(node, collectRequireAliases)
    }
    let requireNameCount = -1
    while (requireNameCount !== requireNames.size) {
        requireNameCount = requireNames.size
        collectRequireAliases(sourceFile)
    }
    const supportedModuleRequireReference = (node: ts.PropertyAccessExpression): boolean => {
        const parent = node.parent
        if (ts.isCallExpression(parent) && parent.expression === node) return true
        if (
            ts.isVariableDeclaration(parent) &&
            parent.initializer === node &&
            ts.isIdentifier(parent.name)
        ) return true
        if (
            ts.isBinaryExpression(parent) &&
            parent.right === node &&
            parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
            ts.isIdentifier(parent.left)
        ) return true
        return (
            ts.isPropertyAccessExpression(parent) &&
            parent.expression === node &&
            parent.name.text === 'bind' &&
            ts.isCallExpression(parent.parent) &&
            parent.parent.expression === parent
        )
    }
    const visit = (node: ts.Node): void => {
        if (
            ts.isElementAccessExpression(node) &&
            ts.isIdentifier(node.expression) &&
            node.expression.text === 'module' &&
            node.argumentExpression &&
            ts.isStringLiteralLike(node.argumentExpression) &&
            ['exports', 'require'].includes(node.argumentExpression.text)
        ) {
            unsupported = true
        }
        if (
            ts.isPropertyAccessExpression(node) &&
            isDirectModuleRequire(node) &&
            !supportedModuleRequireReference(node)
        ) {
            unsupported = true
        }
        if (
            ts.isPropertyAccessExpression(node) &&
            ['call', 'apply'].includes(node.name.text) &&
            isRequireReference(node.expression)
        ) {
            unsupported = true
        }
        if (
            ts.isIdentifier(node) &&
            requireNames.has(node.text) &&
            !declarationRole(node) &&
            !(ts.isVariableDeclaration(node.parent) && node.parent.name === node) &&
            !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) &&
            !(ts.isBindingElement(node.parent) && (node.parent.name === node || node.parent.propertyName === node)) &&
            !(ts.isCallExpression(node.parent) && node.parent.expression === node) &&
            !(ts.isVariableDeclaration(node.parent) && node.parent.initializer === node) &&
            !(
                ts.isBinaryExpression(node.parent) &&
                node.parent.right === node &&
                node.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
            ) &&
            !(
                ts.isPropertyAccessExpression(node.parent) &&
                node.parent.expression === node &&
                node.parent.name.text === 'bind' &&
                ts.isCallExpression(node.parent.parent) &&
                node.parent.parent.expression === node.parent
            )
        ) {
            unsupported = true
        }
        if (
            ts.isIdentifier(node) &&
            node.text === 'module' &&
            !declarationRole(node) && !localBinding(node) &&
            !(ts.isPropertyAssignment(node.parent) && node.parent.name === node) &&
            !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) &&
            !(
                ts.isPropertyAccessExpression(node.parent) &&
                node.parent.expression === node &&
                ['exports', 'require'].includes(node.parent.name.text)
            ) &&
            !(
                ts.isCallExpression(node.parent) &&
                node.parent.arguments.includes(node) &&
                ts.isPropertyAccessExpression(node.parent.expression) &&
                node.parent.expression.name.text === 'bind' &&
                isDirectModuleRequire(node.parent.expression.expression)
            )
        ) {
            unsupported = true
        }
        if (
            ts.isIdentifier(node) &&
            node.text === 'exports' &&
            !declarationRole(node) && !localBinding(node) &&
            !(ts.isPropertyAssignment(node.parent) && node.parent.name === node) &&
            !(
                ts.isPropertyAccessExpression(node.parent) && node.parent.name === node &&
                !(ts.isIdentifier(node.parent.expression) && node.parent.expression.text === 'module')
            ) &&
            !supportedCommonJsExportAssignment(node, sourceFile)
        ) {
            unsupported = true
        }
        ts.forEachChild(node, visit)
    }
    visit(sourceFile)
    return unsupported
}

function commonJsPolicyViolations(sources: Sources): string[] {
    return [...sources.values()].some(unsupportedCommonJsSyntax) ? ['ARCH021_UNMODELLED_COMMONJS'] : []
}

function hasNonstandardMechanismDeclaration(source: string): boolean {
    const sourceFile = ts.createSourceFile('module.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    return sourceFile.statements.some(
        (statement) =>
            ts.isVariableStatement(statement) &&
            statement.modifiers?.some((item) => item.kind === ts.SyntaxKind.ExportKeyword) &&
            statement.declarationList.declarations.some(
                (declaration) => ts.isIdentifier(declaration.name) && /[A-Z0-9_]*MECHANISM$/.test(declaration.name.text),
            ),
    )
}

function ownershipViolations(
    sources: Sources,
    analysis: ArchitectureAnalysis = analyzeArchitecture(sources),
): string[] {
    const declarations = analysis.declarations
    const violations = new Set<string>()
    const byId = new Map<string, Set<string>>()

    for (const declaration of declarations) {
        if (!sources.has(declaration.module) || declaration.module !== declaration.declaredBy) {
            violations.add('ARCH012_DECLARATION_NOT_LOCAL')
        }
        const modules = byId.get(declaration.id) ?? new Set<string>()
        modules.add(declaration.module)
        byId.set(declaration.id, modules)
    }
    if ([...byId.values()].some((modules) => modules.size > 1)) {
        violations.add('ARCH013_DUPLICATE_MECHANISM')
    }
    for (const [path, source] of sources) {
        if (hasNonstandardMechanismDeclaration(source)) {
            violations.add('ARCH015_NONSTANDARD_DECLARATION')
        }
        const implementations = analysis.implementationsByPath.get(path) ?? new Set<string>()
        const declared = new Set(
            declarations.filter((item) => item.declaredBy === path).flatMap((item) => item.exports),
        )
        if (implementations.has('*')) {
            violations.add('ARCH020_WILDCARD_REEXPORT')
        }
        if ([...implementations].some((name) => !declared.has(name))) {
            violations.add('ARCH016_IMPLEMENTATION_OWNER_MISSING')
        }
        if ([...declared].some((name) => !implementations.has(name))) {
            violations.add('ARCH019_DECLARED_IMPLEMENTATION_MISSING')
        }
    }
    return [...violations]
}

const WORK_OWNER_CONTRACTS = [
    {
        id: 'work-order-contract', module: 'packages/cockpit/src/work-orders/contract.ts',
        facets: ['isParsedWorkOrder', 'parseWorkOrder'],
    },
    {
        id: 'work-order-state', module: 'packages/cockpit/src/work-orders/state.ts',
        facets: ['createWorkOrderState', 'encodeWorkOrderState', 'persistWorkOrderProgress', 'readWorkOrderState', 'validateWorkOrderRepositories', 'workOrderProofIsCurrent'],
    },
    {
        id: 'work-order-application', module: 'packages/cockpit/src/work-orders/application.ts',
        facets: ['runWorkApplication'],
    },
    {
        id: 'work-order-composition', module: 'packages/cockpit/src/work-orders/composition.ts',
        facets: ['isWorkApplicationComposition', 'createConfiguredWorkApplicationComposition'],
    },
    {
        id: 'work-order-verification', module: 'packages/cockpit/src/grading/verifier.ts',
        facets: ['checkGradeCurrency', 'checkPreparedWorkOrderCurrency', 'prepareWorkOrderVerification', 'verifyPreparedWorkOrder', 'verifyWorkOrder'],
    },
    {
        id: 'work-order-completion', module: 'packages/cockpit/src/grading/completion.ts',
        facets: ['completeWorkOrder'],
    },
    {
        id: 'browser-runtime', module: 'packages/cockpit/src/browser/runtime.ts',
        facets: ['assertBrowserArtifactRegistration', 'assertBrowserStorageStateCurrent', 'browserRuntimeCoordination', 'resolveBrowserRuntime'],
    },
    {
        id: 'testing-gate-registry', module: 'packages/cockpit/src/testing/gates.ts',
        facets: ['createGateRegistry', 'runGate', 'renderTierGuide'],
    },
    {
        id: 'testing-run-verdict', module: 'packages/cockpit/src/testing/verdict.ts',
        facets: ['RUN_VERDICTS', 'classifyRun'],
    },
] as const

function workArchitectureViolations(
    sources: Sources,
    analysis: ArchitectureAnalysis = analyzeArchitecture(sources),
): string[] {
    const violations = new Set<string>()
    const declarations = analysis.declarations
    const runtimeExports = new Set(analysis.implementationOwnersByFacet.keys())
    for (const contract of WORK_OWNER_CONTRACTS) {
        if (!sources.has(contract.module) && !contract.facets.some(facet => runtimeExports.has(facet))) continue
        const local = declarations.filter(({ declaredBy }) => canonicalModulePath(declaredBy) === contract.module)
        if (local.length !== 1 || local[0]!.id !== contract.id || local[0]!.module !== contract.module
            || contract.facets.some(facet => !local[0]!.exports.includes(facet))) violations.add('ARCH059_WORK_OWNER')
        for (const violation of facetOwnerViolation(
            sources, contract.module, contract.facets, 'ARCH059_WORK_OWNER', analysis,
        )) violations.add(violation)
    }
    const cli = [...sources.keys()].find(path => canonicalModulePath(path) === 'packages/cockpit/src/cli.ts')
    if (cli) {
        const applicationOwners = new Set([
            'packages/cockpit/src/work-orders/application.ts',
            'packages/cockpit/src/work-orders/composition.ts',
        ])
        const workDomainRoots = [
            'packages/cockpit/src/work-orders/',
            'packages/cockpit/src/grading/',
            'packages/cockpit/src/browser/',
            'packages/cockpit/src/testing/',
        ]
        const targets = importSpecifiers(sources.get(cli) ?? '')
            .map(specifier => resolveImport(cli, specifier, sources))
            .filter((target): target is string => target !== null)
            .map(canonicalModulePath)
        if (targets.some(target => workDomainRoots.some(root => target.startsWith(root))
            && !applicationOwners.has(target))) violations.add('ARCH060_WORK_CLI_BOUNDARY')
        if (targets.some(target => workDomainRoots.some(root => target.startsWith(root)))
            && !cliUsesWorkApplication(sources, cli)) violations.add('ARCH060_WORK_CLI_BOUNDARY')
    }
    return [...violations]
}

function cliUsesWorkApplication(sources: Sources, cli: string): boolean {
    const program = sourceProgram(sources)
    const checker = program.getTypeChecker()
    const file = program.getSourceFile(resolve(ROOT, cli))
    if (!file) return false
    const expected = new Map([
        ['packages/cockpit/src/work-orders/application.ts', 'runWorkApplication'],
        ['packages/cockpit/src/work-orders/composition.ts', 'createConfiguredWorkApplicationComposition'],
    ])
    const bindings = new Map<ts.Symbol, Readonly<{ module: string; facet: string }>>()
    for (const statement of file.statements) {
        if (ts.isImportDeclaration(statement) && !statement.importClause?.isTypeOnly
            && ts.isStringLiteralLike(statement.moduleSpecifier) && statement.importClause?.namedBindings
            && ts.isNamedImports(statement.importClause.namedBindings)) {
            const target = canonicalModulePath(resolveImport(cli, statement.moduleSpecifier.text, sources) ?? '')
            for (const element of statement.importClause.namedBindings.elements) {
                if (element.isTypeOnly) continue
                const facet = (element.propertyName ?? element.name).text
                const symbol = checker.getSymbolAtLocation(element.name)
                if (symbol && expected.get(target) === facet) bindings.set(symbol, { module: target, facet })
            }
        }
    }
    const collectDynamicBinding = (node: ts.Node): void => {
        if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && node.initializer) {
            const awaited = ts.isAwaitExpression(node.initializer) ? node.initializer.expression : node.initializer
            if (ts.isCallExpression(awaited) && awaited.expression.kind === ts.SyntaxKind.ImportKeyword
                && awaited.arguments.length === 1 && ts.isStringLiteralLike(awaited.arguments[0]!)) {
                const target = canonicalModulePath(resolveImport(cli, awaited.arguments[0].text, sources) ?? '')
                for (const element of node.name.elements) {
                    if (element.dotDotDotToken || !ts.isIdentifier(element.name)) continue
                    const facet = element.propertyName && ts.isIdentifier(element.propertyName)
                        ? element.propertyName.text : element.name.text
                    const symbol = checker.getSymbolAtLocation(element.name)
                    if (symbol && expected.get(target) === facet) bindings.set(symbol, { module: target, facet })
                }
            }
        }
        ts.forEachChild(node, collectDynamicBinding)
    }
    collectDynamicBinding(file)
    const calls = new Map<ts.FunctionDeclaration, Readonly<{ facet: string; position: number }>[]>()
    const functionReferences = new Map<ts.Symbol, number>()
    const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
            const symbol = checker.getSymbolAtLocation(node.expression)
            const binding = symbol && bindings.get(symbol)
            if (binding) {
                let owner: ts.Node | undefined = node.parent
                while (owner && !ts.isFunctionLike(owner)) owner = owner.parent
                if (owner && ts.isFunctionDeclaration(owner)) calls.set(owner, [
                    ...(calls.get(owner) ?? []), { facet: binding.facet, position: node.getStart(file) },
                ])
            } else if (symbol) {
                functionReferences.set(symbol, (functionReferences.get(symbol) ?? 0) + 1)
            }
        }
        ts.forEachChild(node, visit)
    }
    visit(file)
    return [...calls].some(([owner, rows]) => {
        const composition = rows.find(row => row.facet === 'createConfiguredWorkApplicationComposition')
        const application = rows.find(row => row.facet === 'runWorkApplication')
        if (!composition || !application || composition.position >= application.position
            || !ts.isFunctionDeclaration(owner) || !owner.name) return false
        const symbol = checker.getSymbolAtLocation(owner.name)
        return !!symbol && (functionReferences.get(symbol) ?? 0) > 0
    })
}

function workOwnerFixture(): Map<string, string> {
    return new Map(WORK_OWNER_CONTRACTS.map(({ id, module, facets }) => [module, [
        `export const mechanism = { id: '${id}', module: '${module}', exports: [${facets.map(facet => `'${facet}'`).join(', ')}] } as const`,
        ...facets.map(facet => `export function ${facet}() {}`),
    ].join('\n')]))
}

const RESOLVER_IMPORT_CONTRACT = new Map<string, readonly string[]>([
    ['../config/load.js', ['readBoundedInput', 'STRUCTURED_INPUT_BYTE_LIMIT']],
    ['node:crypto', ['createHash']],
    ['node:fs/promises', ['readFile']],
    ['node:path', ['isAbsolute', 'relative', 'resolve', 'sep']],
    ['node:url', ['fileURLToPath']],
    ['../diagnostics.js', ['type Diagnostic']],
    ['../document/registry.js', ['parseRegistry', 'type DocumentedSibling', 'type RegistryReadResult']],
    ['./render-shell.js', ['renderResolvedRegistryShell']],
])

const RESOLVER_IMPORT_FIXTURE = [
    "import { readBoundedInput, STRUCTURED_INPUT_BYTE_LIMIT } from '../config/load.js'",
    "import { createHash } from 'node:crypto'",
    "import { readFile } from 'node:fs/promises'",
    "import { isAbsolute, relative, resolve, sep } from 'node:path'",
    "import { fileURLToPath } from 'node:url'",
    "import type { Diagnostic } from '../diagnostics.js'",
    "import { parseRegistry, type DocumentedSibling, type RegistryReadResult } from '../document/registry.js'",
    "import { renderResolvedRegistryShell } from './render-shell.js'",
].join('; ')
const RESOLVER_TRANSFORM_FIXTURE =
    "interface ResolvedRegistryContext { adoption: { layer: AdoptionLayer; state: AdoptionState }[]; cockpitSourceRevision: string; registryPath: string; registrySha256: string; siblingsRoot: string }; function resolveRegistry(parsed: RegistryReadResult, context: ResolvedRegistryContext) { return { parsed, context } }"
const RESOLVER_METADATA_FIXTURE =
    "const revision = await sourceRevision(input.cockpitSourceRevision); const registrySha256 = createHash('sha256').update(registryRead).digest('hex')"
const RESOLVER_SOURCE_FIXTURE =
    'let registrySource: string; registrySource = decodeInput(registryRead)'
const RESOLVER_CONTEXT_FIXTURE =
    '{ adoption: adoptionResult.value, cockpitSourceRevision: revision, registryPath: resolve(input.registry), registrySha256, siblingsRoot: resolve(input.siblingsRoot) }'

function registryParserViolations(sources: Sources): string[] {
    const violations = new Set<string>()
    const canonicalParser = 'packages/cockpit/src/document/registry.ts'
    const resolver = 'packages/cockpit/src/registry-resolve/command.ts'

    const locallyExportsParserImplementation = (source: string): boolean => {
        const sourceFile = ts.createSourceFile('module.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
        const implementations = new Set<string>()
        for (const statement of sourceFile.statements) {
            if (ts.isFunctionDeclaration(statement) && statement.name && statement.body) {
                implementations.add(statement.name.text)
            }
            if (ts.isVariableStatement(statement)) {
                for (const declaration of statement.declarationList.declarations) {
                    if (
                        ts.isIdentifier(declaration.name) &&
                        declaration.initializer &&
                        (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer))
                    ) {
                        implementations.add(declaration.name.text)
                    }
                }
            }
        }
        for (const statement of sourceFile.statements) {
            if (
                hasModifier(statement, ts.SyntaxKind.ExportKeyword) &&
                ((ts.isFunctionDeclaration(statement) && statement.name?.text === 'parseRegistry') ||
                    (ts.isVariableStatement(statement) &&
                        statement.declarationList.declarations.some(
                            (declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === 'parseRegistry',
                        )))
            ) {
                return true
            }
            if (ts.isExportDeclaration(statement) && !statement.moduleSpecifier && statement.exportClause) {
                if (
                    ts.isNamedExports(statement.exportClause) &&
                    statement.exportClause.elements.some(
                        (element) =>
                            element.name.text === 'parseRegistry' &&
                            implementations.has((element.propertyName ?? element.name).text),
                    )
                ) {
                    return true
                }
            }
        }
        return false
    }

    for (const [path, source] of sources) {
        if (canonicalModulePath(path) === canonicalParser) continue
        if (locallyExportsParserImplementation(source)) violations.add('ARCH020_DUPLICATE_REGISTRY_PARSER')
    }

    const resolverSource = sources.get(resolver)
    if (resolverSource !== undefined) {
        const sourceFile = ts.createSourceFile(resolver, resolverSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
        const actualImports = new Map<string, string[]>()
        const parserImports = sourceFile.statements.flatMap((statement) => {
            if (
                !ts.isImportDeclaration(statement) ||
                !statement.importClause?.namedBindings ||
                !ts.isNamedImports(statement.importClause.namedBindings)
            ) {
                return []
            }
            const source = ts.isStringLiteralLike(statement.moduleSpecifier)
                ? statement.moduleSpecifier.text
                : ''
            const bindings = statement.importClause.namedBindings.elements.map((element) => {
                const imported = (element.propertyName ?? element.name).text
                const aliased = element.name.text === imported ? '' : ` as ${element.name.text}`
                const typeOnly = statement.importClause!.isTypeOnly || element.isTypeOnly ? 'type ' : ''
                return `${typeOnly}${imported}${aliased}`
            })
            actualImports.set(source, [...(actualImports.get(source) ?? []), ...bindings])
            return statement.importClause.namedBindings.elements
                .filter((element) => element.name.text === 'parseRegistry')
                .map((element) => ({
                    imported: (element.propertyName ?? element.name).text,
                    source,
                }))
        })
        const staticImportContract =
            [...actualImports.keys()].sort().join('\0') === [...RESOLVER_IMPORT_CONTRACT.keys()].sort().join('\0') &&
            [...RESOLVER_IMPORT_CONTRACT].every(([source, expected]) =>
                [...(actualImports.get(source) ?? [])].sort().join('\0') === [...expected].sort().join('\0'),
            ) &&
            importSpecifiers(resolverSource).sort().join('\0') ===
                [...RESOLVER_IMPORT_CONTRACT.keys()].sort().join('\0')
        let shadowed = false
        const parserCalls: ts.CallExpression[] = []
        const rawSourceUses: ts.Identifier[] = []
        const rawRegistryByteUses: ts.Identifier[] = []
        const registryDecodeCalls: ts.CallExpression[] = []
        const registryHashDeclarations: ts.VariableDeclaration[] = []
        const revisionDeclarations: ts.VariableDeclaration[] = []
        const visit = (node: ts.Node): void => {
            if (
                (ts.isVariableDeclaration(node) || ts.isParameter(node)) &&
                bindingNames(node.name).includes('parseRegistry')
            ) {
                shadowed = true
            }
            if (
                ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) &&
                    node.name?.text === 'parseRegistry') ||
                (ts.isCatchClause(node) &&
                    node.variableDeclaration &&
                    bindingNames(node.variableDeclaration.name).includes('parseRegistry'))
            ) {
                shadowed = true
            }
            if (ts.isCallExpression(node)) {
                const callee = node.expression.getText(sourceFile).replace(/\s/g, '')
                if (callee === 'parseRegistry') parserCalls.push(node)
                if (
                    callee === 'decodeInput' &&
                    node.arguments.length === 1 &&
                    node.arguments[0].getText(sourceFile).replace(/\s/g, '') === 'registryRead'
                ) {
                    registryDecodeCalls.push(node)
                }
            }
            if (ts.isIdentifier(node) && node.text === 'registrySource') rawSourceUses.push(node)
            if (ts.isIdentifier(node) && node.text === 'registryRead') rawRegistryByteUses.push(node)
            if (
                ts.isVariableDeclaration(node) &&
                ts.isIdentifier(node.name) &&
                node.name.text === 'registrySha256'
            ) {
                registryHashDeclarations.push(node)
            }
            if (
                ts.isVariableDeclaration(node) &&
                ts.isIdentifier(node.name) &&
                node.name.text === 'revision'
            ) {
                revisionDeclarations.push(node)
            }
            ts.forEachChild(node, visit)
        }
        visit(sourceFile)
        const [parserCall] = parserCalls
        const transformCall = parserCall?.parent
        const canonicalCall =
            parserCalls.length === 1 &&
            ts.isCallExpression(transformCall) &&
            ts.isIdentifier(transformCall.expression) &&
            transformCall.expression.text === 'resolveRegistry' &&
            transformCall.arguments.length === 2 &&
            transformCall.arguments[0] === parserCall &&
            parserCall.arguments.length === 1 &&
            parserCall.arguments[0].getText(sourceFile).replace(/\s/g, '') === 'registrySource'
        const canonicalImport =
            parserImports.length === 1 &&
            parserImports[0].imported === 'parseRegistry' &&
            parserImports[0].source === '../document/registry.js'
        const transforms = sourceFile.statements.filter(
            (statement): statement is ts.FunctionDeclaration =>
                ts.isFunctionDeclaration(statement) && statement.name?.text === 'resolveRegistry' && !!statement.body,
        )
        const [transform] = transforms
        const contexts = sourceFile.statements.filter(
            (statement): statement is ts.InterfaceDeclaration =>
                ts.isInterfaceDeclaration(statement) && statement.name.text === 'ResolvedRegistryContext',
        )
        const [contextDeclaration] = contexts
        const contextMembers = contextDeclaration?.members ?? []
        const contextFields = contextMembers.flatMap((member) =>
            ts.isPropertySignature(member) && member.name ? [member.name.getText(sourceFile)] : [],
        )
        const contextArgument =
            transformCall && ts.isCallExpression(transformCall) ? transformCall.arguments[1] : undefined
        const contextProperties = contextArgument && ts.isObjectLiteralExpression(contextArgument)
            ? contextArgument.properties.flatMap((property) =>
                ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)
                    ? [property.name.getText(sourceFile)]
                    : [],
            )
            : []
        const expectedContextFields = [
            'adoption',
            'cockpitSourceRevision',
            'registryPath',
            'registrySha256',
            'siblingsRoot',
        ]
        const expectedContextTypes = new Map([
            ['adoption', '{layer:AdoptionLayer;state:AdoptionState}[]'],
            ['cockpitSourceRevision', 'string'],
            ['registryPath', 'string'],
            ['registrySha256', 'string'],
            ['siblingsRoot', 'string'],
        ])
        const exactContextTypes = contextMembers.every((member) =>
            ts.isPropertySignature(member) &&
            !!member.name &&
            !member.questionToken &&
            member.type?.getText(sourceFile).replace(/\s/g, '') === expectedContextTypes.get(member.name.getText(sourceFile)),
        )
        const contextValues = new Map(contextArgument && ts.isObjectLiteralExpression(contextArgument)
            ? contextArgument.properties.flatMap((property): [string, string][] => {
                if (ts.isPropertyAssignment(property)) {
                    return [[property.name.getText(sourceFile), property.initializer.getText(sourceFile).replace(/\s/g, '')]]
                }
                if (ts.isShorthandPropertyAssignment(property)) {
                    return [[property.name.getText(sourceFile), property.name.getText(sourceFile)]]
                }
                return []
            })
            : [])
        const expectedContextValues = new Map([
            ['adoption', 'adoptionResult.value'],
            ['cockpitSourceRevision', 'revision'],
            ['registryPath', 'resolve(input.registry)'],
            ['registrySha256', 'registrySha256'],
            ['siblingsRoot', 'resolve(input.siblingsRoot)'],
        ])
        const exactContext =
            contexts.length === 1 &&
            contextMembers.length === expectedContextFields.length &&
            [...contextFields].sort().join('\0') === [...expectedContextFields].sort().join('\0') &&
            exactContextTypes &&
            !!contextArgument &&
            ts.isObjectLiteralExpression(contextArgument) &&
            contextArgument.properties.length === expectedContextFields.length &&
            [...contextProperties].sort().join('\0') === [...expectedContextFields].sort().join('\0') &&
            [...expectedContextValues].every(([field, value]) => contextValues.get(field) === value)
        const typedTransform =
            transforms.length === 1 &&
            !!transform &&
            transform.parameters.length === 2 &&
            ts.isIdentifier(transform.parameters[0].name) &&
            transform.parameters[0].name.text === 'parsed' &&
            transform.parameters[0].type?.getText(sourceFile).replace(/\s/g, '') === 'RegistryReadResult' &&
            ts.isIdentifier(transform.parameters[1].name) &&
            transform.parameters[1].name.text === 'context' &&
            transform.parameters[1].type?.getText(sourceFile).replace(/\s/g, '') === 'ResolvedRegistryContext'
        const allowedRawSourceUse = (identifier: ts.Identifier): boolean => {
            const parent = identifier.parent
            if (
                (ts.isVariableDeclaration(parent) || ts.isParameter(parent)) &&
                parent.name === identifier
            ) {
                return true
            }
            if (parserCall?.arguments[0] === identifier) return true
            if (
                ts.isBinaryExpression(parent) &&
                parent.left === identifier &&
                parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
                registryDecodeCalls.includes(parent.right as ts.CallExpression)
            ) {
                return true
            }
            if (!(
                ts.isPropertyAccessExpression(parent) &&
                parent.expression === identifier &&
                parent.name.text === 'trim' &&
                ts.isCallExpression(parent.parent) &&
                parent.parent.expression === parent
            )) return false
            let enclosing: ts.Node = parent.parent
            while (enclosing.parent && !ts.isIfStatement(enclosing)) enclosing = enclosing.parent
            return ts.isIfStatement(enclosing) &&
                enclosing.expression.getText(sourceFile).replace(/\s/g, '') ===
                    "registryRead.length===0||registrySource.trim()===''"
        }
        const rawSourceConfined = rawSourceUses.every(allowedRawSourceUse)
        const [registryDecodeCall] = registryDecodeCalls
        const registryDecodeAssignment = registryDecodeCall?.parent
        const exactRegistryDecode =
            registryDecodeCalls.length === 1 &&
            ts.isBinaryExpression(registryDecodeAssignment) &&
            registryDecodeAssignment.right === registryDecodeCall &&
            ts.isIdentifier(registryDecodeAssignment.left) &&
            registryDecodeAssignment.left.text === 'registrySource' &&
            registryDecodeAssignment.operatorToken.kind === ts.SyntaxKind.EqualsToken
        const rawRegistryBytesConfined = rawRegistryByteUses.every((identifier) => {
            const parent = identifier.parent
            if (ts.isVariableDeclaration(parent) && parent.name === identifier) return true
            if (
                ts.isReturnStatement(parent) &&
                ts.isIfStatement(parent.parent) &&
                parent.parent.expression.getText(sourceFile).replace(/\s/g, '') === '!Buffer.isBuffer(registryRead)'
            ) {
                return true
            }
            if (registryDecodeCall?.arguments[0] === identifier) return true
            if (
                ts.isCallExpression(parent) &&
                parent.arguments.includes(identifier) &&
                ['Buffer.isBuffer', "createHash('sha256').update"].includes(
                    parent.expression.getText(sourceFile).replace(/\s/g, ''),
                )
            ) {
                return true
            }
            return ts.isPropertyAccessExpression(parent) && parent.expression === identifier && parent.name.text === 'length'
        })
        const [registryHashDeclaration] = registryHashDeclarations
        const exactRegistryHash =
            registryHashDeclarations.length === 1 &&
            registryHashDeclaration.initializer?.getText(sourceFile).replace(/\s/g, '') ===
                "createHash('sha256').update(registryRead).digest('hex')"
        const [revisionDeclaration] = revisionDeclarations
        const exactRevision =
            revisionDeclarations.length === 1 &&
            revisionDeclaration.initializer?.getText(sourceFile).replace(/\s/g, '') ===
                'awaitsourceRevision(input.cockpitSourceRevision)'
        if (!staticImportContract || !canonicalImport || !canonicalCall || !typedTransform || !exactContext || !rawSourceConfined || !exactRegistryDecode || !rawRegistryBytesConfined || !exactRegistryHash || !exactRevision || shadowed) {
            violations.add('ARCH021_RESOLVER_PARSER_BINDING')
        }
    }

    return [...violations]
}

function sourceProgram(sources: Sources): ts.Program {
    const virtualSources = new Map([...sources].map(([path, source]) => [resolve(ROOT, path), source]))
    const compilerOptions: ts.CompilerOptions = {
        allowJs: true, checkJs: false, noLib: true, target: ts.ScriptTarget.Latest, module: ts.ModuleKind.ESNext,
    }
    const host: ts.CompilerHost = {
        fileExists: (path) => virtualSources.has(path),
        readFile: (path) => virtualSources.get(path),
        getSourceFile: (path, languageVersion) => {
            const source = virtualSources.get(path)
            return source === undefined ? undefined : ts.createSourceFile(path, source, languageVersion, true, ts.ScriptKind.TS)
        },
        getDefaultLibFileName: () => 'lib.d.ts',
        writeFile: () => undefined,
        getCurrentDirectory: () => ROOT,
        getDirectories: () => [],
        getCanonicalFileName: (path) => path,
        useCaseSensitiveFileNames: () => true,
        getNewLine: () => '\n',
    }
    return ts.createProgram({ rootNames: [...virtualSources.keys()], options: compilerOptions, host })
}

function lifecyclePlanningViolations(sources: Sources): string[] {
    const source = sources.get(LIFECYCLE_MODULE)
    const violations = new Set<string>()
    if (source === undefined) {
        violations.add('ARCH040_LIFECYCLE_PLANNING_BOUNDARY')
    } else {
        const sourceFile = ts.createSourceFile(LIFECYCLE_MODULE, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
        const actualImports = new Map<string, string[]>()
        let unsupportedImport = false
        for (const statement of sourceFile.statements) {
            if (!ts.isImportDeclaration(statement) || !ts.isStringLiteralLike(statement.moduleSpecifier)) continue
            const clause = statement.importClause
            if (!clause?.namedBindings || !ts.isNamedImports(clause.namedBindings) || clause.name) {
                unsupportedImport = true
                continue
            }
            const bindings = clause.namedBindings.elements.map((element) => {
                const imported = (element.propertyName ?? element.name).text
                const aliased = element.name.text === imported ? '' : ` as ${element.name.text}`
                const typeOnly = clause.isTypeOnly || element.isTypeOnly ? 'type ' : ''
                return `${typeOnly}${imported}${aliased}`
            })
            actualImports.set(statement.moduleSpecifier.text, [
                ...(actualImports.get(statement.moduleSpecifier.text) ?? []),
                ...bindings,
            ])
        }
        const exactImports = !unsupportedImport
            && [...actualImports.keys()].sort().join('\0') === [...LIFECYCLE_IMPORT_CONTRACT.keys()].sort().join('\0')
            && [...LIFECYCLE_IMPORT_CONTRACT].every(([specifier, expected]) =>
                [...(actualImports.get(specifier) ?? [])].sort().join('\0') === [...expected].sort().join('\0'))
            && importSpecifiers(source).sort().join('\0') === [...LIFECYCLE_IMPORT_CONTRACT.keys()].sort().join('\0')
        const declarations = mechanismDeclarations(new Map([[LIFECYCLE_MODULE, source]]))
        const declaration = declarations.length === 1 ? declarations[0] : undefined
        const runtimeExports = [...exportedImplementations(source)].sort()
        const exactMechanism = declaration?.declaredBy === LIFECYCLE_MODULE
            && declaration.id === 'lifecycle-planning' && declaration.module === LIFECYCLE_MODULE
            && declaration.exports.join('\0') === LIFECYCLE_EXPORTS.join('\0')
            && runtimeExports.join('\0') === [...LIFECYCLE_EXPORTS].sort().join('\0')

        if (!exactImports || !exactMechanism) {
            violations.add('ARCH040_LIFECYCLE_PLANNING_BOUNDARY')
        }
    }
    for (const [path, candidate] of sources) {
        if (path === LIFECYCLE_MODULE) continue
        if (canonicalModulePath(path) === LIFECYCLE_MODULE) {
            violations.add('ARCH040_LIFECYCLE_PLANNING_BOUNDARY')
        }
        if ([...exportedImplementations(candidate)].some((name) => LIFECYCLE_EXPORTS.includes(name as never))) {
            violations.add('ARCH040_LIFECYCLE_PLANNING_BOUNDARY')
        }
    }
    return [...violations]
}

function lifecycleIssuanceConsumerViolations(sources: Sources): string[] {
    const allowedConsumers = new Set([
        'packages/cockpit/src/environment/application.ts',
        'packages/cockpit/src/environment/lifecycle.test.ts',
    ])
    const program = sourceProgram(sources)
    const checker = program.getTypeChecker()
    const violations = new Set<string>()
    for (const [path, source] of sources) {
        if (path === LIFECYCLE_MODULE) continue
        const sourceFile = program.getSourceFile(resolve(ROOT, path))!
        const issuanceBindings = new Set<ts.Symbol>()
        let staticLifecycleAccesses = 0
        for (const statement of sourceFile.statements) {
            if ((ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement))
                && statement.moduleSpecifier && ts.isStringLiteralLike(statement.moduleSpecifier)
                && canonicalModulePath(resolveImport(path, statement.moduleSpecifier.text, sources) ?? '') === LIFECYCLE_MODULE) {
                staticLifecycleAccesses += 1
            }
            if (ts.isImportDeclaration(statement) && ts.isStringLiteralLike(statement.moduleSpecifier)
                && canonicalModulePath(resolveImport(path, statement.moduleSpecifier.text, sources) ?? '') === LIFECYCLE_MODULE) {
                const clause = statement.importClause
                if (clause?.name || clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
                    violations.add('ARCH041_LIFECYCLE_ISSUANCE_CONSUMER')
                }
                if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
                    for (const element of clause.namedBindings.elements) {
                        const imported = element.propertyName?.text ?? element.name.text
                        if (imported === 'consumeLifecycleIssuance') {
                            if (!allowedConsumers.has(path) || element.name.text !== imported
                                || clause.isTypeOnly || element.isTypeOnly) {
                                violations.add('ARCH041_LIFECYCLE_ISSUANCE_CONSUMER')
                            }
                            const symbol = checker.getSymbolAtLocation(element.name)
                            if (symbol) issuanceBindings.add(symbol)
                        }
                    }
                }
            }
            if (ts.isExportDeclaration(statement) && statement.moduleSpecifier
                && ts.isStringLiteralLike(statement.moduleSpecifier)
                && canonicalModulePath(resolveImport(path, statement.moduleSpecifier.text, sources) ?? '') === LIFECYCLE_MODULE
                && (!statement.exportClause || ts.isNamespaceExport(statement.exportClause)
                    || ts.isNamedExports(statement.exportClause) && statement.exportClause.elements.some((element) =>
                        (element.propertyName?.text ?? element.name.text) === 'consumeLifecycleIssuance'))) {
                violations.add('ARCH041_LIFECYCLE_ISSUANCE_CONSUMER')
            }
        }
        const lifecycleAccesses = importSpecifiers(source)
            .filter((specifier) => canonicalModulePath(resolveImport(path, specifier, sources) ?? '') === LIFECYCLE_MODULE)
            .length
        if (lifecycleAccesses !== staticLifecycleAccesses) {
            violations.add('ARCH041_LIFECYCLE_ISSUANCE_CONSUMER')
        }
        const auditIssuanceBinding = (node: ts.Node): void => {
            if (ts.isIdentifier(node) && !ts.isImportSpecifier(node.parent)) {
                const symbol = ts.isShorthandPropertyAssignment(node.parent) && node.parent.name === node
                    ? checker.getShorthandAssignmentValueSymbol(node.parent)
                    : checker.getSymbolAtLocation(node)
                if (symbol && issuanceBindings.has(symbol)
                    && (!ts.isCallExpression(node.parent) || node.parent.expression !== node
                        || Boolean(node.parent.questionDotToken))) {
                    violations.add('ARCH041_LIFECYCLE_ISSUANCE_CONSUMER')
                }
            }
            ts.forEachChild(node, auditIssuanceBinding)
        }
        auditIssuanceBinding(sourceFile)
    }
    return [...violations]
}

const GENERATED_COMPOSE_AUTHORITY_MODULE = 'packages/cockpit/src/environment/generated-render.ts'
const GENERATED_COMPOSE_AUTHORITY_TYPE = 'GeneratedComposeArtifactAuthority'
const GENERATED_COMPOSE_PROJECTION = 'projectGeneratedComposeArtifactAuthority'
const GENERATED_RENDER_AUTHENTICATOR = 'authenticateGeneratedRender'
const GENERATED_COMPOSE_AUTHENTICATOR = 'authenticateGeneratedComposeArtifact'

function generatedComposeAuthorityViolations(sources: Sources): string[] {
    const code = 'ARCH048_GENERATED_COMPOSE_AUTHORITY'
    const violations = new Set<string>()
    if (!sources.has(GENERATED_COMPOSE_AUTHORITY_MODULE)) violations.add(code)
    const program = sourceProgram(sources)
    const checker = program.getTypeChecker()
    const stack = 'packages/cockpit/src/environment/generated-stack.ts'
    const facade = 'packages/cockpit/src/environment/generated-compose-authority.ts'
    const tests = [
        'packages/cockpit/src/environment/generated-render.test.ts',
        'packages/cockpit/src/environment/generated-compose-authority.test.ts',
    ]
    const allowed = new Map([
        [GENERATED_COMPOSE_PROJECTION, new Set([stack, ...tests])],
        [GENERATED_RENDER_AUTHENTICATOR, new Set([stack, ...tests])],
        [GENERATED_COMPOSE_AUTHENTICATOR, new Set([
            'packages/cockpit/src/environment/runtime.ts',
            'packages/cockpit/src/environment/runtime.test.ts',
            ...tests,
        ])],
    ])
    const types = new Set([
        GENERATED_COMPOSE_AUTHORITY_TYPE, 'GeneratedEnvironmentInput', 'GeneratedEnvironmentResult',
        'GeneratedObservationPlan', 'GeneratedOwnedFile', 'GeneratedRenderEnvelope',
    ])
    const declarationCounts = new Map<string, number>([
        [GENERATED_COMPOSE_AUTHORITY_TYPE, 0],
        ...[...allowed.keys()].map((name): [string, number] => [name, 0]),
    ])

    for (const [path, source] of sources) {
        const sourceFile = program.getSourceFile(resolve(ROOT, path))!
        const bindings = new Map<ts.Symbol, string>()
        let staticAccesses = 0
        for (const statement of sourceFile.statements) {
            const declarationName = ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)
                || ts.isClassDeclaration(statement) || ts.isFunctionDeclaration(statement)
                || ts.isEnumDeclaration(statement)
                ? statement.name?.text
                : ts.isVariableStatement(statement)
                    ? statement.declarationList.declarations.length === 1
                        && ts.isIdentifier(statement.declarationList.declarations[0]!.name)
                        ? statement.declarationList.declarations[0]!.name.text : undefined
                    : undefined
            if (declarationName === 'issueGeneratedComposeArtifactAuthority') violations.add(code)
            if (declarationName !== undefined && declarationCounts.has(declarationName)) {
                declarationCounts.set(declarationName, declarationCounts.get(declarationName)! + 1)
                const expectedDeclaration = declarationName === GENERATED_COMPOSE_AUTHORITY_TYPE
                    ? ts.isInterfaceDeclaration(statement) : ts.isFunctionDeclaration(statement)
                if (path !== GENERATED_COMPOSE_AUTHORITY_MODULE || !expectedDeclaration
                    || !hasModifier(statement, ts.SyntaxKind.ExportKeyword)) violations.add(code)
            }

            if (!(ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement))
                || !statement.moduleSpecifier || !ts.isStringLiteralLike(statement.moduleSpecifier)
                || canonicalModulePath(resolveImport(path, statement.moduleSpecifier.text, sources) ?? '') !== GENERATED_COMPOSE_AUTHORITY_MODULE) continue
            staticAccesses += 1
            if (ts.isExportDeclaration(statement)) {
                if (!statement.exportClause || !ts.isNamedExports(statement.exportClause)) {
                    violations.add(code)
                    continue
                }
                for (const element of statement.exportClause.elements) {
                    const name = element.propertyName?.text ?? element.name.text
                    const typeOnly = statement.isTypeOnly || element.isTypeOnly
                    if (element.name.text !== name || (typeOnly
                        ? !types.has(name) || (path !== stack && !(path === facade && name === GENERATED_COMPOSE_AUTHORITY_TYPE))
                        : path !== stack || ![GENERATED_COMPOSE_PROJECTION, 'renderGeneratedEnvironment'].includes(name))) violations.add(code)
                }
                continue
            }
            const clause = statement.importClause
            if (!clause?.namedBindings || !ts.isNamedImports(clause.namedBindings) || clause.name) {
                violations.add(code)
                continue
            }
            for (const element of clause.namedBindings.elements) {
                const imported = element.propertyName?.text ?? element.name.text
                if (element.name.text !== imported) {
                    violations.add(code)
                    continue
                }
                const typeOnly = clause.isTypeOnly || element.isTypeOnly
                if (types.has(imported)) {
                    if (!typeOnly) violations.add(code)
                    continue
                }
                if (imported === 'renderGeneratedEnvironment') {
                    if (typeOnly) violations.add(code)
                    continue
                }
                if (typeOnly || !allowed.get(imported)?.has(path)) violations.add(code)
                const symbol = checker.getSymbolAtLocation(element.name)
                if (symbol) bindings.set(symbol, imported)
            }
        }
        const accesses = importSpecifiers(source)
            .filter((specifier) => canonicalModulePath(resolveImport(path, specifier, sources) ?? '') === GENERATED_COMPOSE_AUTHORITY_MODULE)
            .length
        if (accesses !== staticAccesses) violations.add(code)

        const auditBinding = (node: ts.Node): void => {
            if (ts.isIdentifier(node) && !ts.isImportSpecifier(node.parent)) {
                const symbol = ts.isShorthandPropertyAssignment(node.parent) && node.parent.name === node
                    ? checker.getShorthandAssignmentValueSymbol(node.parent)
                    : checker.getSymbolAtLocation(node)
                if (symbol && bindings.has(symbol)
                    && (!ts.isCallExpression(node.parent) || node.parent.expression !== node || Boolean(node.parent.questionDotToken))) {
                    violations.add(code)
                }
            }
            ts.forEachChild(node, auditBinding)
        }
        auditBinding(sourceFile)
    }
    if ([...declarationCounts.values()].some((count) => count !== 1)) violations.add(code)
    return [...violations]
}

const APPLICATION_MODULE = 'packages/cockpit/src/environment/application.ts'
const RUNTIME_MODULE = 'packages/cockpit/src/environment/runtime.ts'
const PORTS_MODULE = 'packages/cockpit/src/environment/ports.ts'
const CLAIMS_MODULE = 'packages/cockpit/src/environment/claims.ts'
const UP_COMMAND_MODULE = 'packages/cockpit/src/up/command.ts'

function exportedTypeDeclarations(source: string): Map<string, ts.InterfaceDeclaration | ts.TypeAliasDeclaration> {
    const sourceFile = ts.createSourceFile('module.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    return new Map(sourceFile.statements.flatMap((statement): [string, ts.InterfaceDeclaration | ts.TypeAliasDeclaration][] =>
        (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement))
            && hasModifier(statement, ts.SyntaxKind.ExportKeyword)
            ? [[statement.name.text, statement]]
            : []))
}

function facetOwnerViolation(
    sources: Sources,
    module: string,
    facets: readonly string[],
    code: string,
    analysis: ArchitectureAnalysis = analyzeArchitecture(sources),
): string[] {
    const declarations = analysis.declarations
    const declaredOwners = new Map<string, Set<string>>()
    const implementationOwners = new Map<string, Set<string>>()
    for (const facet of facets) {
        declaredOwners.set(facet, new Set(declarations
            .filter(({ exports }) => exports.includes(facet))
            .map(({ declaredBy }) => canonicalModulePath(declaredBy))))
        implementationOwners.set(facet, new Set(analysis.implementationOwnersByFacet.get(facet) ?? []))
    }
    return facets.every((facet) => {
        const expected = canonicalModulePath(module)
        const declarationsForFacet = declaredOwners.get(facet)!
        const implementationsForFacet = implementationOwners.get(facet)!
        return declarationsForFacet.size === 1 && declarationsForFacet.has(expected)
            && implementationsForFacet.size === 1 && implementationsForFacet.has(expected)
    }) ? [] : [code]
}

function initBoundaryViolations(sources: Sources): string[] {
    const command = 'packages/cockpit/src/init/command.ts'
    const application = 'packages/cockpit/src/environment/init-application.ts'
    const violations = new Set<string>()
    for (const owner of [command, application]) {
        const source = sources.get(owner)
        if (source === undefined) { violations.add('ARCH_INIT_APPLICATION_BOUNDARY'); continue }
        for (const specifier of importSpecifiers(source)) {
            const target = canonicalModulePath(resolveImport(owner, specifier, sources) ?? specifier)
            const allowedCommand = target === application || target === 'node:crypto'
                || target === 'packages/cockpit/src/surfaces/contract.ts'
            const allowedApplication = new Set([
                'node:crypto', 'node:path',
                'packages/cockpit/src/diagnostics.ts',
                'packages/cockpit/src/document/command.ts',
                'packages/cockpit/src/surfaces/contract.ts',
                'packages/cockpit/src/environment/identity.ts',
                'packages/cockpit/src/environment/state.ts',
            ])
            if (specifier === COMPUTED_DYNAMIC_IMPORT
                || owner === command && !allowedCommand
                || owner === application && !allowedApplication.has(target)) {
                violations.add('ARCH_INIT_APPLICATION_BOUNDARY')
            }
        }
    }
    return [...violations]
}

function applicationBoundaryViolations(
    sources: Sources,
    analysis: ArchitectureAnalysis = analyzeArchitecture(sources),
): string[] {
    const violations = new Set<string>()
    const lifecycleContracts = [
        'UpCommandInput', 'UpCommandAdapters', 'UpCommandResult',
        'SleepCommandInput', 'SleepCommandAdapters', 'SleepCommandResult',
    ]
    const environmentContracts = [
        'PreflightCommandInput', 'PreflightCommandAdapters', 'PreflightCommandResult',
        'DoctorCommandInput', 'DoctorCommandAdapters', 'DoctorCommandResult',
        'LogsCommandInput', 'LogsCommandAdapters', 'LogsCommandResult',
        'BaselineCommandInput', 'BaselineCommandAdapters', 'BaselineCommandResult',
    ]
    const applicationTypes = exportedTypeDeclarations(sources.get(APPLICATION_MODULE) ?? '')
    if (lifecycleContracts.some((name) => !applicationTypes.has(name))) {
        violations.add('ARCH042_APPLICATION_LIFECYCLE_HOME')
    }
    for (const violation of facetOwnerViolation(
        sources,
        APPLICATION_MODULE,
        ['issueLifecycleRunContext', 'runUp', 'runSleep'],
        'ARCH042_APPLICATION_LIFECYCLE_HOME',
        analysis,
    )) violations.add(violation)

    const commandContracts = new Map([
        [UP_COMMAND_MODULE, { functionName: 'upCommand', imported: 'runUp', types: lifecycleContracts.slice(0, 3) }],
    ])
    if (environmentContracts.some((name) => !applicationTypes.has(name))) {
        violations.add('ARCH048_APPLICATION_OBSERVATION_HOME')
    }
    for (const violation of facetOwnerViolation(
        sources,
        APPLICATION_MODULE,
        ['runPreflight', 'runDoctor', 'runLogs', 'runBaselineRecord'],
        'ARCH048_APPLICATION_OBSERVATION_HOME',
        analysis,
    )) violations.add(violation)
    for (const [path, contract] of commandContracts) {
        const source = sources.get(path)
        if (!source) {
            violations.add('ARCH043_COMMAND_APPLICATION_BOUNDARY')
            continue
        }
        const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
        const imports = importSpecifiers(source)
            .map((specifier) => canonicalModulePath(resolveImport(path, specifier, sources) ?? specifier))
        const importedApplicationFacets = sourceFile.statements.flatMap((statement) =>
            ts.isImportDeclaration(statement)
                && ts.isStringLiteralLike(statement.moduleSpecifier)
                && canonicalModulePath(resolveImport(path, statement.moduleSpecifier.text, sources) ?? '') === APPLICATION_MODULE
                && statement.importClause?.namedBindings
                && ts.isNamedImports(statement.importClause.namedBindings)
                ? statement.importClause.namedBindings.elements.map((element) =>
                    (element.propertyName ?? element.name).text)
                : [])
        const reexportedTypes = sourceFile.statements.flatMap((statement) =>
            ts.isExportDeclaration(statement) && !statement.moduleSpecifier
                && statement.exportClause && ts.isNamedExports(statement.exportClause)
                ? statement.exportClause.elements.map((element) => element.name.text)
                : [])
        if (
            imports.length === 0 || imports.some((target) => target !== APPLICATION_MODULE)
            || importedApplicationFacets.sort().join('\0') !== [contract.imported, ...contract.types].sort().join('\0')
            || reexportedTypes.sort().join('\0') !== [...contract.types].sort().join('\0')
            || !analysis.implementationsByPath.get(path)?.has(contract.functionName)
        ) violations.add('ARCH043_COMMAND_APPLICATION_BOUNDARY')
    }

    for (const violation of facetOwnerViolation(
        sources,
        RUNTIME_MODULE,
        [
            'createRuntimeServiceRevalidationPlan', 'admitRuntimeServiceRevalidation',
            'admitRuntimeServicePlanFailure', 'admitRuntimeServiceInspectFailure',
            'consumeRuntimeServiceFailureForLogs', 'observeRuntimeServiceColdStart',
        ],
        'ARCH044_RUNTIME_RESUME_HOME',
        analysis,
    )) violations.add(violation)
    const reducer = namedFunction(
        ts.createSourceFile(CLAIMS_MODULE, sources.get(CLAIMS_MODULE) ?? '', ts.ScriptTarget.Latest, true, ts.ScriptKind.TS),
        'removeExactCoordinationHolder',
    )
    if (reducer) {
        let impure = Boolean(reducer.modifiers?.some(({ kind }) => kind === ts.SyntaxKind.AsyncKeyword))
        const inspect = (node: ts.Node): void => {
            if (ts.isAwaitExpression(node)) impure = true
            if (
                ts.isCallExpression(node)
                && ['executePlan', 'transactState', 'leasePortFamily', 'releasePortFamily', 'releaseClaim']
                    .includes(node.expression.getText())
            ) impure = true
            ts.forEachChild(node, inspect)
        }
        inspect(reducer)
        if (impure) violations.add('ARCH046_EXACT_HOLDER_REDUCER_HOME')
    }
    for (const violation of facetOwnerViolation(
        sources,
        PORTS_MODULE,
        ['compensateAcquiredPortHolder'],
        'ARCH045_PORT_COMPENSATION_HOME',
        analysis,
    )) violations.add(violation)
    for (const violation of facetOwnerViolation(
        sources,
        CLAIMS_MODULE,
        ['removeExactCoordinationHolder'],
        'ARCH046_EXACT_HOLDER_REDUCER_HOME',
        analysis,
    )) violations.add(violation)

    for (const resultName of [
        'UpCommandResult',
        'SleepCommandResult',
        'PreflightCommandResult',
        'DoctorCommandResult',
        'LogsCommandResult',
        'BaselineCommandResult',
    ]) {
        const declaration = applicationTypes.get(resultName)
        if (!declaration) continue
        let authorityEscapes = false
        const inspect = (node: ts.Node): void => {
            if (
                ts.isIdentifier(node)
                && (/(?:Authority|Envelope)$/.test(node.text)
                    || /^Lifecycle.*(?:Plan|Progress|Projection|Receipt|Window)$/.test(node.text))
            ) authorityEscapes = true
            if (
                (ts.isPropertySignature(node) || ts.isPropertyDeclaration(node))
                && /authority/i.test(node.name.getText())
            ) authorityEscapes = true
            ts.forEachChild(node, inspect)
        }
        inspect(declaration)
        if (authorityEscapes) violations.add('ARCH047_COMMAND_AUTHORITY_ESCAPE')
    }

    return [...violations]
}

function guardArchitectureViolations(
    sources: Sources,
    analysis: ArchitectureAnalysis = analyzeArchitecture(sources),
): string[] {
    const violations = new Set<string>()
    const base = 'packages/cockpit/src/'
    const parser = `${base}guards/invocation-parser.ts`
    const evaluator = `${base}guards/evaluator.ts`
    const host = `${base}guards/host.ts`
    const table = `${base}command-table.ts`
    const adapter = `${base}guards/harness-adapter.ts`
    const generated = `${base}environment/generated-application.ts`
    const owners = new Map<string, readonly string[]>([
        [parser, ['GUARD_INPUT_LIMITS', 'parseGuardInput', 'isParsedGuardInput']],
        [evaluator, ['evaluateGuard']],
        [host, ['GUARD_HOST_LIMITS', 'GUARD_HOST_PATTERN', 'isGuardHost', 'normalizeGuardHost']],
        [table, ['commands', 'internalCommands', 'resolveOrdinaryInvocation']],
        [APPLICATION_MODULE, ['prepareGuardEvaluationPolicy', 'runGuardEvaluationApplication']],
    ])
    const declarations = analysis.declarations
    const runtimeFields = new Set(['protectedBranches', 'hostedDatabaseHosts', 'vendorHosts', 'declaredAllows', 'declaredDenies',
        'cockpitInvocations', 'projectCommands'])
    const fieldConsumers = new Map([
        ['protected_branches', { path: APPLICATION_MODULE, target: 'protectedBranches' }],
        ['hosted_db_hosts', { path: APPLICATION_MODULE, target: 'hostedDatabaseHosts' }],
        ['vendor_endpoint_hosts', { path: APPLICATION_MODULE, target: 'vendorHosts' }],
        ['allow', { path: APPLICATION_MODULE, target: 'declaredAllows' }],
        ['deny', { path: APPLICATION_MODULE, target: 'declaredDenies' }],
        ['ask_is_deny_on', { path: generated, target: 'ask_is_deny_on' }],
    ])
    const consumed = new Set<string>()
    const guardFields = new Set<string>()
    const program = sourceProgram(new Map([...sources].filter(([path]) => /\.[cm]?[jt]s$/.test(path))))
    const checker = program.getTypeChecker()
    const propertyName = (node: ts.PropertyName): string | undefined =>
        ts.isIdentifier(node) || ts.isStringLiteralLike(node) ? node.text : undefined
    const frozenValue = (expression: ts.Expression): ts.Expression => {
        const value = unwrappedExpression(expression)
        return ts.isCallExpression(value) && value.expression.getText() === 'Object.freeze' && value.arguments[0]
            ? frozenValue(value.arguments[0]) : value
    }

    for (const [path, source] of sources) {
        if (/\.(?:sh|bash)$/.test(path) || source.startsWith('#!') && !/\.[cm]?[jt]s$/.test(path)) {
            // Transport may select its framing mode, but may never interpret guard policy.
            const executable = source.split('\n').filter(line => !line.trimStart().startsWith('#')).join('\n')
            if (/\b(?:protected_branches|hosted_db_hosts|vendor_endpoint_hosts|protectedBranches|hostedDatabaseHosts|vendorHosts)\b|\b(?:jq|awk|python\d*|eval)\b|\b(?:allow|deny|ask)\b/.test(executable)) {
                violations.add('ARCH057_SHELL_POLICY')
            }
            continue
        }
        const canonical = canonicalModulePath(path)
        const file = program.getSourceFile(resolve(ROOT, path))
        if (!file) continue
        const implementations = analysis.implementationsByPath.get(path) ?? new Set<string>()
        for (const [owner, facets] of owners) {
            for (const facet of facets) {
                if (canonical !== owner && (implementations.has(facet)
                    || declarations.some(row => row.declaredBy === path && row.exports.includes(facet)))) violations.add('ARCH051_GUARD_OWNER')
            }
            if (canonical === owner && facets.some(facet => implementations.has(facet))) {
                if (facetOwnerViolation(sources, owner, facets, 'ARCH051_GUARD_OWNER', analysis).length) violations.add('ARCH051_GUARD_OWNER')
            }
        }
        const targets = importSpecifiers(source).map(specifier => resolveImport(path, specifier, sources)).filter((target): target is string => target !== null).map(canonicalModulePath)
        const parserImports = file.statements.filter((statement): statement is ts.ImportDeclaration => ts.isImportDeclaration(statement)
            && ts.isStringLiteralLike(statement.moduleSpecifier)
            && canonicalModulePath(resolveImport(path, statement.moduleSpecifier.text, sources) ?? '') === parser)
        const onlyParserLimits = parserImports.length > 0 && parserImports.every(statement =>
            !statement.importClause?.name && statement.importClause?.namedBindings
            && ts.isNamedImports(statement.importClause.namedBindings)
            && statement.importClause.namedBindings.elements.length > 0
            && statement.importClause.namedBindings.elements.every(binding => (binding.propertyName ?? binding.name).text === 'GUARD_INPUT_LIMITS'))
        const forbidden = canonical === `${base}schema.ts` || canonical === `${base}registry-derivation.ts` || canonical === `${base}document/registry.ts`
            ? [table, APPLICATION_MODULE, generated, `${base}cli.ts`]
            : canonical === `${base}cli.ts` || canonical === generated ? [evaluator, ...(!onlyParserLimits ? [parser] : [])]
            : canonical === evaluator ? [APPLICATION_MODULE, generated, `${base}cli.ts`, adapter, table]
            : canonical === parser || canonical === host ? [APPLICATION_MODULE, generated, `${base}cli.ts`, table, adapter, evaluator]
            : canonical === table ? [APPLICATION_MODULE, generated, `${base}cli.ts`, `${base}schema.ts`, `${base}registry-derivation.ts`]
            : []
        if (targets.some(target => forbidden.includes(target))) violations.add('ARCH052_GUARD_GRAPH')

        const importedCalls = new Map<ts.Symbol, string>()
        const importedCallNames = new Set<string>()
        for (const statement of file.statements) {
            if (!ts.isImportDeclaration(statement) || !ts.isStringLiteralLike(statement.moduleSpecifier)
                || !statement.importClause?.namedBindings || !ts.isNamedImports(statement.importClause.namedBindings)) continue
            const target = resolveImport(path, statement.moduleSpecifier.text, sources)
            for (const binding of statement.importClause.namedBindings.elements) {
                const name = (binding.propertyName ?? binding.name).text
                const owner = [...owners].find(([, facets]) => facets.includes(name))?.[0]
                const symbol = checker.getSymbolAtLocation(binding.name)
                if (owner && target && canonicalModulePath(target) === owner) {
                    importedCallNames.add(name)
                    if (symbol) importedCalls.set(symbol, name)
                }
            }
        }
        const sequence: string[] = []
        const visit = (node: ts.Node): void => {
            if (ts.isFunctionDeclaration(node) && node.name) {
                const name = node.name.text
                const owner = [...owners].find(([, facets]) => facets.includes(name))?.[0]
                if (owner && canonical !== owner) violations.add('ARCH051_GUARD_OWNER')
                if (name === 'capturePolicy' && ![evaluator, `${base}surfaces/restrictions.ts`].includes(canonical)) violations.add('ARCH054_GUARD_POLICY_RECONSTRUCTION')
            }
            if (ts.isObjectLiteralExpression(node)) {
                const names = node.properties.map(property => property.name && propertyName(property.name))
                if (canonical !== APPLICATION_MODULE && canonical !== evaluator && names.some(name => name && runtimeFields.has(name)
                    && !(canonical === `${base}autonomy/launcher.ts` && ['cockpitInvocations', 'projectCommands'].includes(name)))) {
                    violations.add('ARCH054_GUARD_POLICY_RECONSTRUCTION')
                }
                if (canonical !== parser && stringProperty(node, 'status') === 'parsed' && objectProperty(node, 'invocations')) violations.add('ARCH051_GUARD_OWNER')
                if (canonical !== table && ['name', 'handler', 'visibility', 'ordinary'].every(name => names.includes(name))) violations.add('ARCH051_GUARD_OWNER')
            }
            if (ts.isPropertyAccessExpression(node) && runtimeFields.has(node.name.text)
                && ![APPLICATION_MODULE, evaluator].includes(canonical)
                && !(canonical === `${base}autonomy/launcher.ts` && ['cockpitInvocations', 'projectCommands'].includes(node.name.text))) violations.add('ARCH054_GUARD_POLICY_RECONSTRUCTION')
            if (ts.isPropertyAssignment(node)) {
                const consumer = [...fieldConsumers].find(([, consumer]) => consumer.path === canonical && consumer.target === propertyName(node.name))
                if (consumer) {
                    const unwrap = (expression: ts.Expression): ts.Expression => {
                        while (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression)
                            || ts.isSatisfiesExpression(expression) || ts.isNonNullExpression(expression)) expression = expression.expression
                        return expression
                    }
                    let value = unwrap(node.initializer)
                    if (ts.isCallExpression(value) && value.arguments.length === 1
                        && ts.isPropertyAccessExpression(value.expression) && value.expression.name.text === 'freeze'
                        && ts.isIdentifier(value.expression.expression) && value.expression.expression.text === 'Object') value = unwrap(value.arguments[0]!)
                    if (ts.isArrayLiteralExpression(value) && value.elements.length === 1 && ts.isSpreadElement(value.elements[0]!)) {
                        value = unwrap(value.elements[0]!.expression)
                    }
                    if (ts.isCallExpression(value) && ts.isPropertyAccessExpression(value.expression)
                        && value.expression.name.text === 'map') value = unwrap(value.expression.expression)
                    if (ts.isPropertyAccessExpression(value) && value.name.text === consumer[0]
                        && ts.isPropertyAccessExpression(value.expression) && value.expression.name.text === 'guards'
                        && ts.isIdentifier(value.expression.expression) && value.expression.expression.text === 'config') consumed.add(consumer[0])
                }
            }
            if (canonical === `${base}schema.ts` && ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'Guards' && node.initializer) {
                const fields = (child: ts.Node): void => {
                    if (ts.isCallExpression(child) && ts.isPropertyAccessExpression(child.expression) && child.expression.name.text === 'object'
                        && ts.isIdentifier(child.expression.expression) && child.expression.expression.text === 'z'
                        && child.arguments[0] && ts.isObjectLiteralExpression(child.arguments[0])) {
                        for (const property of child.arguments[0].properties) {
                            const name = property.name && propertyName(property.name)
                            if (name) guardFields.add(name)
                            else violations.add('ARCH055_GUARD_DECLARATION_CONSUMPTION')
                        }
                    }
                    ts.forEachChild(child, fields)
                }
                fields(node.initializer)
            }
            if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
                const symbol = checker.getSymbolAtLocation(node.expression)
                const imported = symbol && importedCalls.get(symbol)
                if (imported && ['parseGuardInput', 'evaluateGuard', 'resolveOrdinaryInvocation'].includes(imported)) {
                    let owner: ts.Node | undefined = node
                    while (owner && !ts.isFunctionLike(owner)) owner = owner.parent
                    const acceptedComparisonArgumentCaller = imported === 'resolveOrdinaryInvocation'
                        && canonical === `${base}cli.ts` && ts.isFunctionDeclaration(owner)
                        && owner.name?.text === 'admitComparisonArguments'
                        && declarations.some(row => row.id === 'command-dispatch' && row.declaredBy === path
                            && row.module === canonical && row.exports.includes('runCli'))
                    if (canonical !== APPLICATION_MODULE && !acceptedComparisonArgumentCaller) {
                        violations.add('ARCH053_GUARD_APPLICATION_SEQUENCE')
                    }
                }
            }
            if (canonical === table && ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)
                && ['commands', 'internalCommands'].includes(node.name.text) && node.initializer) {
                const internal = node.name.text === 'internalCommands'
                const array = frozenValue(node.initializer)
                if (!ts.isArrayLiteralExpression(array) || array.elements.length === 0) violations.add('ARCH056_COMMAND_METADATA')
                else for (const element of array.elements) {
                    const row = frozenValue(element as ts.Expression)
                    if (!ts.isObjectLiteralExpression(row)) { violations.add('ARCH056_COMMAND_METADATA'); continue }
                    const ordinary = objectProperty(row, 'ordinary')
                    const grammar = ordinary && frozenValue(ordinary)
                    if (!stringProperty(row, 'name') || !stringProperty(row, 'handler')
                        || stringProperty(row, 'visibility') !== (internal ? 'internal' : 'public')
                        || !internal && (stringProperty(row, 'name') === 'guard-evaluate' || stringProperty(row, 'handler') === 'guard-evaluate')
                        || !grammar || (internal ? !ts.isObjectLiteralExpression(grammar) || stringProperty(grammar, 'availability') !== 'unavailable'
                            : !ts.isCallExpression(grammar) || !ts.isIdentifier(grammar.expression) || !['ordinary', 'unavailable'].includes(grammar.expression.text))) {
                        violations.add('ARCH056_COMMAND_METADATA')
                    }
                }
            }
            ts.forEachChild(node, visit)
        }
        visit(file)
        if (canonical === APPLICATION_MODULE) {
            const run = namedFunction(file, 'runGuardEvaluationApplication')
            if (run) {
                const walk = (node: ts.Node): void => {
                    if (node !== run && ts.isFunctionLike(node)) return
                if (ts.isCallExpression(node)) {
                        if (ts.isIdentifier(node.expression)) {
                            const symbol = checker.getSymbolAtLocation(node.expression)
                            const imported = symbol && importedCalls.get(symbol)
                            if (imported) sequence.push(imported)
                        else if (['parseGuardInput', 'resolveOrdinaryInvocation', 'evaluateGuard'].includes(node.expression.text)
                            && !symbol && importedCallNames.has(node.expression.text)) sequence.push(node.expression.text)
                            else if (node.expression.text === 'prepareGuardEvaluationPolicy'
                                && (symbol?.declarations?.some(declaration => ts.isFunctionDeclaration(declaration) && declaration.parent === file)
                                    || namedFunction(file, 'prepareGuardEvaluationPolicy') !== undefined)) sequence.push(node.expression.text)
                        } else if (ts.isPropertyAccessExpression(node.expression) && ['loadConfig', 'observeCheckout'].includes(node.expression.name.text)) sequence.push(node.expression.name.text)
                    }
                    ts.forEachChild(node, walk)
                }
                walk(run)
                const required = ['loadConfig', 'observeCheckout', 'parseGuardInput', 'prepareGuardEvaluationPolicy', 'resolveOrdinaryInvocation', 'evaluateGuard']
                if (required.some((name, index) => !sequence.includes(name) || index > 0 && sequence.indexOf(name) <= sequence.indexOf(required[index - 1]!))
                    || ['parseGuardInput', 'evaluateGuard'].some(name => sequence.filter(call => call === name).length !== 1)) violations.add('ARCH053_GUARD_APPLICATION_SEQUENCE')
            }
        }
    }
    if ([...guardFields].some(field => !consumed.has(field))) violations.add('ARCH055_GUARD_DECLARATION_CONSUMPTION')
    return [...violations]
}

function referenceArchitectureViolations(sources: Sources): string[] {
    const violations = new Set<string>()
    for (const [path, body] of sources) {
        const file = ts.createSourceFile(path, body, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
        const runtime = file.statements.filter(node => !ts.isImportDeclaration(node) || !node.importClause?.isTypeOnly)
            .map(node => node.getText(file)).join('\n')
        for (const dependency of importSpecifiers(runtime)) {
            const target = resolveImport(path, dependency, sources)
            if (path === 'scripts/diagnostic-inventory.mjs' && target === 'scripts/docs-lint.mjs'
                || path.startsWith('packages/cockpit/src/') && (dependency === 'typescript'
                    || target === 'scripts/diagnostic-inventory.mjs' || target === 'scripts/docs-lint.mjs')) {
                violations.add('ARCH058_REFERENCE_GRAPH')
            }
        }
    }
    return [...violations]
}

function boundedMaintainerImports(path: string, source: string): string {
    if (path !== 'scripts/diagnostic-inventory.mjs') return source
    const compact = source.replace(/\s+/g, '')
    const preparation = compact.slice(compact.indexOf('asyncfunctionprepareRender('), compact.indexOf('functionregion('))
    if (!preparation.includes('awaitauthenticateBuiltReferenceOwner(record)')
        || preparation.indexOf('awaitauthenticateBuiltReferenceOwner(record)') >= preparation.indexOf('awaitloadReferenceOwners(root)')
        || !compact.includes("constBUILT_EXECUTION_OWNER=newURL('../packages/cockpit/dist/environment-exec/execute.js',import.meta.url)")
        || !compact.includes("constBUILT_EXECUTABLE_OWNER=newURL('../packages/cockpit/dist/environment/executable.js',import.meta.url)")) return source
    const allowed = new Map([
        ['loadBootstrapOwners:BUILT_EXECUTION_OWNER.href', '../packages/cockpit/dist/environment-exec/execute.js'],
        ['loadBootstrapOwners:BUILT_EXECUTABLE_OWNER.href', '../packages/cockpit/dist/environment/executable.js'],
        ["loadReferenceOwners:pathToFileURL(join(root,'packages/cockpit/dist/references/generate.js')).href", '../packages/cockpit/dist/references/generate.js'],
        ["loadReferenceOwners:pathToFileURL(join(root,'packages/cockpit/dist/generated-environment/transaction.js')).href", '../packages/cockpit/dist/generated-environment/transaction.js'],
        ["loadReferenceOwners:pathToFileURL(join(root,'packages/cockpit/dist/environment-exec/execute.js')).href", '../packages/cockpit/dist/environment-exec/execute.js'],
        ["loadReferenceOwners:pathToFileURL(join(root,'packages/cockpit/dist/environment/executable.js')).href", '../packages/cockpit/dist/environment/executable.js'],
    ])
    const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    const replacements: { start: number; end: number; bytes: string }[] = []
    const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments.length === 1) {
            let parent: ts.Node | undefined = node.parent
            while (parent && !ts.isFunctionDeclaration(parent)) parent = parent.parent
            const key = `${parent?.name?.getText(file)}:${node.arguments[0]!.getText(file).replace(/\s+/g, '')}`
            const dependency = allowed.get(key)
            if (dependency) replacements.push({ start: node.getStart(file), end: node.end, bytes: `import('${dependency}')` })
        }
        ts.forEachChild(node, visit)
    }
    visit(file)
    return replacements.sort((left, right) => right.start - left.start).reduce(
        (bytes, replacement) => bytes.slice(0, replacement.start) + replacement.bytes + bytes.slice(replacement.end), source)
}

function inspectArchitecture(sources: Sources): string[] {
    let analysis = analyzeArchitecture(sources)
    const guardViolations = guardArchitectureViolations(sources, analysis)
    sources = new Map([...sources].filter(([path]) => !/\.(?:sh|bash)$/.test(path)))
    if (sources.size === 0) return guardViolations.sort()
    if (sources.size !== analysis.implementationsByPath.size) analysis = analyzeArchitecture(sources)
    return [
        ...guardViolations,
        ...referenceArchitectureViolations(sources),
        ...importDirectionViolations(sources),
        ...boundaryViolations(sources),
        ...ownershipViolations(sources, analysis),
        ...workArchitectureViolations(sources, analysis),
        ...registryParserViolations(sources),
        ...commonJsPolicyViolations(sources),
        ...executionBoundaryViolations(sources, analysis),
        ...environmentCodeViolations(sources),
        ...jsonSnapshotOwnershipViolations(sources),
        ...observationDeclarationViolations(sources),
        ...entrypointKindVocabularyViolations(sources),
        ...claimsBrokerOwnershipViolations(sources),
        ...coordinationPolicyViolations(sources),
        ...lifecyclePlanningViolations(sources),
        ...applicationBoundaryViolations(sources, analysis),
        ...initBoundaryViolations(sources),
    ].sort()
}

function entrypointKindVocabularyViolations(sources: Sources): string[] {
    const owner = 'packages/cockpit/src/entrypoint-kinds.ts'
    const schema = 'packages/cockpit/src/schema.ts'
    const ports = 'packages/cockpit/src/environment/ports.ts'
    const expectedKinds = [
        'entrypoint', 'origin', 'callback_url', 'advertised_listener', 'cors_origin', 'public_base_url',
    ]
    const violations = new Set<string>()
    const sourceFiles = new Map([...sources].map(([path, source]) => [
        canonicalModulePath(path), ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS),
    ]))
    const unwrap = (expression: ts.Expression): ts.Expression => {
        while (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression)
            || ts.isSatisfiesExpression(expression) || ts.isNonNullExpression(expression)) {
            expression = expression.expression
        }
        if (ts.isCallExpression(expression) && ts.isPropertyAccessExpression(expression.expression)
            && ts.isIdentifier(expression.expression.expression) && expression.expression.expression.text === 'Object'
            && expression.expression.name.text === 'freeze' && expression.arguments.length === 1) {
            return unwrap(expression.arguments[0]!)
        }
        return expression
    }
    const literalKinds = (expression: ts.Expression): string[] | undefined => {
        expression = unwrap(expression)
        if (!ts.isArrayLiteralExpression(expression)) return undefined
        const values: string[] = []
        for (const element of expression.elements) {
            if (!ts.isStringLiteralLike(element)) return undefined
            values.push(element.text)
        }
        return values
    }
    const isExpectedVocabulary = (expression: ts.Expression): boolean => {
        const values = literalKinds(expression)
        return values?.length === expectedKinds.length
            && values.every((value, index) => value === expectedKinds[index])
    }
    const isVocabularySet = (expression: ts.Expression): boolean => {
        const values = literalKinds(expression)
        return values?.length === expectedKinds.length
            && expectedKinds.every((value) => values.includes(value))
    }
    const ownerSource = sourceFiles.get(owner)
    if (ownerSource) {
        const mechanismDeclarations = ownerSource.statements.flatMap((statement) =>
            ts.isVariableStatement(statement)
                && ts.getModifiers(statement)?.some(({ kind }) => kind === ts.SyntaxKind.ExportKeyword)
                && (statement.declarationList.flags & ts.NodeFlags.Const) !== 0
                ? statement.declarationList.declarations.filter((declaration) =>
                    ts.isIdentifier(declaration.name) && declaration.name.text === 'mechanism') : [])
        const mechanismInitializer = mechanismDeclarations.length === 1 && mechanismDeclarations[0]?.initializer
            ? unwrap(mechanismDeclarations[0].initializer) : undefined
        const mechanismProperties = mechanismInitializer && ts.isObjectLiteralExpression(mechanismInitializer)
            ? new Map(mechanismInitializer.properties.flatMap((property) =>
                ts.isPropertyAssignment(property) && (ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name))
                    ? [[property.name.text, unwrap(property.initializer)] as const] : [])) : undefined
        const mechanismExports = mechanismProperties?.get('exports')
        const runtimeExports = mechanismExports ? literalKinds(mechanismExports) : undefined
        const ownerImplementations = exportedImplementations(ownerSource.text)
        const mechanismString = (name: string): string | undefined => {
            const value = mechanismProperties?.get(name)
            return value && ts.isStringLiteralLike(value) ? value.text : undefined
        }
        const exactMechanism = mechanismProperties?.size === 3
            && mechanismString('id') === 'entrypoint-kind-vocabulary'
            && mechanismString('module') === owner
            && runtimeExports?.length === 2 && runtimeExports[0] === 'ENTRYPOINT_KINDS'
            && runtimeExports[1] === 'isEntrypointKind'
            && ownerImplementations.size === 2 && ownerImplementations.has('ENTRYPOINT_KINDS')
            && ownerImplementations.has('isEntrypointKind')
        const vocabularyDeclarations = ownerSource.statements.flatMap((statement) =>
            ts.isVariableStatement(statement)
                && ts.getModifiers(statement)?.some(({ kind }) => kind === ts.SyntaxKind.ExportKeyword)
                && (statement.declarationList.flags & ts.NodeFlags.Const) !== 0
                ? statement.declarationList.declarations.filter((declaration) =>
                    ts.isIdentifier(declaration.name) && declaration.name.text === 'ENTRYPOINT_KINDS') : [])
        const guardDeclarations = ownerSource.statements.filter((statement): statement is ts.FunctionDeclaration =>
            ts.isFunctionDeclaration(statement) && statement.name?.text === 'isEntrypointKind'
            && Boolean(ts.getModifiers(statement)?.some(({ kind }) => kind === ts.SyntaxKind.ExportKeyword)))
        const typeDeclarations = ownerSource.statements.filter((statement): statement is ts.TypeAliasDeclaration =>
            ts.isTypeAliasDeclaration(statement) && statement.name.text === 'EntrypointKind'
            && Boolean(ts.getModifiers(statement)?.some(({ kind }) => kind === ts.SyntaxKind.ExportKeyword)))
        const exactOwnerType = typeDeclarations.length === 1 && (() => {
            const declaration = typeDeclarations[0]!
            if (!ts.isIndexedAccessTypeNode(declaration.type)
                || declaration.type.indexType.kind !== ts.SyntaxKind.NumberKeyword) return false
            let objectType = declaration.type.objectType
            while (ts.isParenthesizedTypeNode(objectType)) objectType = objectType.type
            return ts.isTypeQueryNode(objectType) && ts.isIdentifier(objectType.exprName)
                && objectType.exprName.text === 'ENTRYPOINT_KINDS'
        })()
        const exactGuard = guardDeclarations.length === 1 && (() => {
            const guard = guardDeclarations[0]!
            const modifiers = ts.getModifiers(guard) ?? []
            if (modifiers.length !== 1 || modifiers[0]!.kind !== ts.SyntaxKind.ExportKeyword
                || guard.asteriskToken || guard.typeParameters || guard.questionToken
                || guard.parameters.length !== 1 || !ts.isIdentifier(guard.parameters[0]!.name)
                || !guard.body || !guard.type || !ts.isTypePredicateNode(guard.type)
                || !guard.type.type || !ts.isTypeReferenceNode(guard.type.type)
                || !ts.isIdentifier(guard.type.type.typeName)
                || guard.type.type.typeName.text !== 'EntrypointKind'
                || guard.type.type.typeArguments?.length) return false
            const parameter = guard.parameters[0]!
            const parameterName = parameter.name
            if (!ts.isIdentifier(parameterName)) return false
            return parameterName.text === 'value' && !parameter.dotDotDotToken && !parameter.questionToken
                && !parameter.initializer && parameter.type?.kind === ts.SyntaxKind.UnknownKeyword
                && !guard.type.assertsModifier && ts.isIdentifier(guard.type.parameterName)
                && guard.type.parameterName.text === parameterName.text
        })()
        if (!exactMechanism || vocabularyDeclarations.length !== 1 || !vocabularyDeclarations[0]?.initializer
            || !isExpectedVocabulary(vocabularyDeclarations[0].initializer)
            || !exactGuard || !exactOwnerType
            || ownerSource.statements.some(ts.isImportDeclaration)) {
            violations.add('ARCH039_ENTRYPOINT_KIND_VOCABULARY')
        }
    }
    const typeConsumers = new Set([ports, 'packages/cockpit/src/environment/contract.ts'])
    for (const [path, sourceFile] of sourceFiles) {
        const ownerImportEntries: Array<{ imported: string; local: string; typeOnly: boolean }> = []
        let namespaceOwnerImport = false
        for (const statement of sourceFile.statements) {
            if (ts.isImportEqualsDeclaration(statement) && ts.isExternalModuleReference(statement.moduleReference)
                && statement.moduleReference.expression && ts.isStringLiteralLike(statement.moduleReference.expression)
                && canonicalModulePath(resolveImport(path, statement.moduleReference.expression.text, sources) ?? '') === owner) {
                namespaceOwnerImport = true
            }
            if (!ts.isImportDeclaration(statement) || !ts.isStringLiteralLike(statement.moduleSpecifier)
                || canonicalModulePath(resolveImport(path, statement.moduleSpecifier.text, sources) ?? '') !== owner) continue
            const bindings = statement.importClause?.namedBindings
            if (bindings && ts.isNamespaceImport(bindings)) namespaceOwnerImport = true
            if (bindings && ts.isNamedImports(bindings)) for (const element of bindings.elements) {
                ownerImportEntries.push({
                    imported: element.propertyName?.text ?? element.name.text,
                    local: element.name.text,
                    typeOnly: Boolean(statement.importClause?.isTypeOnly || element.isTypeOnly),
                })
            }
        }
        let duplicateVocabulary = false
        let duplicateDeclaration = false
        let consumerReferencesValid = true
        const consumerReferences = new Map([
            ['ENTRYPOINT_KINDS', 0], ['EntrypointKind', 0], ['isEntrypointKind', 0],
        ])
        const visit = (node: ts.Node): void => {
            if (path !== owner && ts.isArrayLiteralExpression(node) && isVocabularySet(node)) {
                duplicateVocabulary = true
            }
            if (path !== owner && (ts.isVariableDeclaration(node) || ts.isFunctionDeclaration(node)
                    || ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isClassDeclaration(node))
                && node.name && ts.isIdentifier(node.name)
                && ['ENTRYPOINT_KINDS', 'EntrypointKind', 'isEntrypointKind'].includes(node.name.text)) {
                duplicateDeclaration = true
            }
            if (path !== owner && ts.isIdentifier(node)
                && consumerReferences.has(node.text)
                && !(ts.isImportSpecifier(node.parent)
                    && (node.parent.name === node || node.parent.propertyName === node))) {
                consumerReferences.set(node.text, consumerReferences.get(node.text)! + 1)
                if (path === schema && node.text === 'ENTRYPOINT_KINDS') {
                    const call = node.parent
                    if (!ts.isCallExpression(call) || call.arguments[0] !== node || call.questionDotToken
                        || !ts.isPropertyAccessExpression(call.expression) || call.expression.questionDotToken
                        || !ts.isIdentifier(call.expression.expression) || call.expression.expression.text !== 'z'
                        || call.expression.name.text !== 'enum') consumerReferencesValid = false
                } else if (typeConsumers.has(path) && node.text === 'EntrypointKind') {
                    if (!ts.isTypeReferenceNode(node.parent) || node.parent.typeName !== node
                        || ts.isTypeAliasDeclaration(node.parent.parent)
                            && node.parent.parent.type === node.parent) {
                        consumerReferencesValid = false
                    }
                } else if (typeConsumers.has(path) && node.text === 'isEntrypointKind') {
                    if (!ts.isCallExpression(node.parent) || node.parent.expression !== node
                        || node.parent.questionDotToken) consumerReferencesValid = false
                } else {
                    consumerReferencesValid = false
                }
            }
            if (path !== owner && ts.isCallExpression(node) && node.arguments[0]
                && ts.isStringLiteralLike(node.arguments[0])
                && canonicalModulePath(resolveImport(path, node.arguments[0].text, sources) ?? '') === owner
                && (node.expression.kind === ts.SyntaxKind.ImportKeyword
                    || ts.isIdentifier(node.expression) && node.expression.text === 'require'
                    || ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression)
                        && node.expression.expression.text === 'module' && node.expression.name.text === 'require')) {
                consumerReferencesValid = false
            }
            ts.forEachChild(node, visit)
        }
        visit(sourceFile)
        const expectedImports = path === schema
            ? [{ imported: 'ENTRYPOINT_KINDS', local: 'ENTRYPOINT_KINDS', typeOnly: false }]
            : typeConsumers.has(path) ? [
                { imported: 'isEntrypointKind', local: 'isEntrypointKind', typeOnly: false },
                { imported: 'EntrypointKind', local: 'EntrypointKind', typeOnly: true },
            ] : []
        const importsMatch = !namespaceOwnerImport && ownerImportEntries.length === expectedImports.length
            && expectedImports.every((expected) => ownerImportEntries.some((actual) =>
                actual.imported === expected.imported && actual.local === expected.local
                && actual.typeOnly === expected.typeOnly))
        const hasRequiredReferences = path === schema ? consumerReferences.get('ENTRYPOINT_KINDS')! > 0
            : typeConsumers.has(path) ? consumerReferences.get('EntrypointKind')! > 0
                && consumerReferences.get('isEntrypointKind')! > 0 : true
        if (duplicateVocabulary || duplicateDeclaration || !consumerReferencesValid
            || path !== owner && (!importsMatch || !hasRequiredReferences)) {
            violations.add('ARCH039_ENTRYPOINT_KIND_VOCABULARY')
        }
        if (path !== owner && sourceFile.statements.some((statement) =>
            ts.isExportDeclaration(statement) && statement.moduleSpecifier
            && ts.isStringLiteralLike(statement.moduleSpecifier)
            && canonicalModulePath(resolveImport(path, statement.moduleSpecifier.text, sources) ?? '') === owner)) {
            violations.add('ARCH039_ENTRYPOINT_KIND_VOCABULARY')
        }
    }
    return [...violations]
}

function operationClaimsFixture(extra = ''): string {
    return `
        export const mechanism = {
            id: 'environment-claims', module: 'packages/cockpit/src/environment/claims.ts',
            exports: [
                'openRuntimeDrainExecution', 'settleRuntimeDrainSuccess', 'settleRuntimeDrainFailure',
                'openReclaimDrainExecution', 'settleReclaimDrainSuccess', 'settleReclaimDrainFailure',
                'matchReclaimDrainContinuation', 'reduceDrainOutcome', 'prepareDrainOutcomePublication', 'finalizeDrainOutcome',
            ],
        } as const
        export function openRuntimeDrainExecution() {}
        export const settleRuntimeDrainSuccess = () => undefined
        export const settleRuntimeDrainFailure = () => undefined
        export function openReclaimDrainExecution() {}
        export const settleReclaimDrainSuccess = () => undefined
        export const settleReclaimDrainFailure = () => undefined
        export function matchReclaimDrainContinuation() {}
        export function reduceDrainOutcome() {}
        export function prepareDrainOutcomePublication() {}
        export function finalizeDrainOutcome() {}
        ${extra}
    `
}

function claimsBrokerOwnershipViolations(sources: Sources): string[] {
    const claimsModule = 'packages/cockpit/src/environment/claims.ts'
    const runtimeModule = 'packages/cockpit/src/environment/runtime.ts'
    const reclaimModule = 'packages/cockpit/src/environment/reclaim.ts'
    const applicationModule = 'packages/cockpit/src/environment/application.ts'
    const claimsOwnedNames = new Set([
        'DrainAttemptPermit', 'ReclaimAttemptPermit', 'sealSuccess', 'sealFailure',
        'DrainProgressAuthority', 'DrainAttemptSuccessAuthority', 'DrainAttemptFailureAuthority',
    ])
    const retiredExports = new Set([
        'redeemRuntimeStopAttempt', 'redeemReclaimAttempt', 'matchesDrainProgress', 'matchesDrainFailure',
        'reduceDrainAttemptStart', 'reduceDrainAttemptRetry', 'reduceDrainAttemptFailure',
        'reduceDrainAttemptSuccess', 'reduceDrain', 'finalizeDrainAttemptOutcome',
    ])
    const retiredBrokerNames = new Set([
        'openDrainExecution', 'settleDrainExecution', 'accessDrainEvidence', 'DrainExecutionAuthority',
    ])
    const facetOwners = new Map<string, string>([
        ['openRuntimeDrainExecution', runtimeModule],
        ['settleRuntimeDrainSuccess', runtimeModule],
        ['settleRuntimeDrainFailure', runtimeModule],
        ['openReclaimDrainExecution', reclaimModule],
        ['settleReclaimDrainSuccess', reclaimModule],
        ['settleReclaimDrainFailure', reclaimModule],
        ['matchReclaimDrainContinuation', reclaimModule],
        ['reduceDrainOutcome', applicationModule],
        ['prepareDrainOutcomePublication', applicationModule],
        ['finalizeDrainOutcome', applicationModule],
    ])
    const brokerExports = new Set(facetOwners.keys())
    const capabilityFieldNames = new Set(['permit', 'progressAuthority', 'failureAuthority'])
    const claimsOwnedStores = new Set([
        'drainAttemptSuccessAuthorities', 'drainAttemptFailureAuthorities', 'drainProgressAuthorities',
        'drainFailureProgressAuthorities', 'drainExecutions', 'drainOutcomes', 'drainContinuationEvidence',
    ])
    const brokerModules = new Set([claimsModule, runtimeModule, reclaimModule, applicationModule])
    const program = sourceProgram(sources)
    const checker = program.getTypeChecker()
    const violations = new Set<string>()
    const unalias = (input: ts.Symbol | undefined): ts.Symbol | undefined => {
        let symbol = input
        const seen = new Set<ts.Symbol>()
        while (symbol && (symbol.flags & ts.SymbolFlags.Alias) !== 0 && !seen.has(symbol)) {
            seen.add(symbol)
            try { symbol = checker.getAliasedSymbol(symbol) } catch { break }
        }
        return symbol
    }
    for (const [path, source] of sources) {
        const modulePath = canonicalModulePath(path)
        const sourceFile = program.getSourceFile(resolve(ROOT, path))!
        const brokerBindings = new Set<ts.Symbol>()
        const importedBrokerNames = new Set<string>()
        const directlyCalledBrokerNames = new Set<string>()
        const commonJsNamespaces = new Set<ts.Symbol>()
        const brokerModule = brokerModules.has(modulePath)
        if (modulePath === claimsModule) {
            const declarations = sourceFile.statements.flatMap((statement) =>
                ts.isVariableStatement(statement)
                    && statement.modifiers?.some(({ kind }) => kind === ts.SyntaxKind.ExportKeyword)
                    && (statement.declarationList.flags & ts.NodeFlags.Const) !== 0
                    ? statement.declarationList.declarations.filter((declaration) =>
                        ts.isIdentifier(declaration.name) && declaration.name.text === 'mechanism')
                    : [],
            )
            const declaration = declarations.length === 1 ? declarations[0] : undefined
            let initializer = declaration?.initializer
            while (initializer && (ts.isAsExpression(initializer) || ts.isSatisfiesExpression(initializer)
                || ts.isParenthesizedExpression(initializer))) initializer = initializer.expression
            const properties = initializer && ts.isObjectLiteralExpression(initializer)
                ? new Map(initializer.properties.flatMap((property) =>
                    ts.isPropertyAssignment(property) && (ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name))
                        ? [[property.name.text, property.initializer] as const] : []))
                : undefined
            const stringValue = (expression: ts.Expression | undefined): string | undefined => {
                while (expression && (ts.isAsExpression(expression) || ts.isSatisfiesExpression(expression)
                    || ts.isParenthesizedExpression(expression))) expression = expression.expression
                return expression && ts.isStringLiteralLike(expression) ? expression.text : undefined
            }
            let exportsExpression = properties?.get('exports')
            while (exportsExpression && (ts.isAsExpression(exportsExpression) || ts.isSatisfiesExpression(exportsExpression)
                || ts.isParenthesizedExpression(exportsExpression))) exportsExpression = exportsExpression.expression
            const declaredExports = exportsExpression && ts.isArrayLiteralExpression(exportsExpression)
                ? exportsExpression.elements.flatMap((element) => ts.isStringLiteralLike(element) ? [element.text] : [])
                : []
            const implementations = exportedImplementations(source)
            const moduleSymbol = checker.getSymbolAtLocation(sourceFile)
            const brokerSymbols = new Set((moduleSymbol ? checker.getExportsOfModule(moduleSymbol) : [])
                .filter((symbol) => brokerExports.has(symbol.name))
                .map((symbol) => unalias(symbol)).filter((symbol): symbol is ts.Symbol => Boolean(symbol)))
            const resolvesToBroker = (identifier: ts.Identifier): boolean => {
                const symbol = ts.isShorthandPropertyAssignment(identifier.parent) && identifier.parent.name === identifier
                    ? checker.getShorthandAssignmentValueSymbol(identifier.parent)
                    : checker.getSymbolAtLocation(identifier)
                return Boolean(symbol && brokerSymbols.has(unalias(symbol)!))
            }
            const auditBrokerReferences = (node: ts.Node): void => {
                if (ts.isIdentifier(node) && resolvesToBroker(node)) {
                    const declarationName = (ts.isFunctionDeclaration(node.parent)
                            || ts.isVariableDeclaration(node.parent))
                        && node.parent.name === node && brokerExports.has(node.text)
                    if (!declarationName) {
                        violations.add('ARCH037_DRAIN_REDEMPTION_BOUNDARY')
                    }
                }
                ts.forEachChild(node, auditBrokerReferences)
            }
            auditBrokerReferences(sourceFile)
            if (stringValue(properties?.get('id')) !== 'environment-claims'
                || stringValue(properties?.get('module')) !== claimsModule
                || !exportsExpression || !ts.isArrayLiteralExpression(exportsExpression)
                || exportsExpression.elements.length !== declaredExports.length
                || new Set(declaredExports).size !== declaredExports.length
                || declaredExports.some((name) => retiredExports.has(name) || retiredBrokerNames.has(name))
                || declaredExports.some((name) => !implementations.has(name))
                || [...implementations].some((name) => !declaredExports.includes(name))
                || [...brokerExports].some((name) => !declaredExports.includes(name))
                || brokerSymbols.size !== brokerExports.size) {
                    violations.add('ARCH037_DRAIN_REDEMPTION_BOUNDARY')
            }
        }
        for (const statement of sourceFile.statements) {
            if (brokerModule && ts.isImportDeclaration(statement) && ts.isStringLiteralLike(statement.moduleSpecifier)
                && ['module', 'node:module'].includes(statement.moduleSpecifier.text)) {
                const bindings = statement.importClause?.namedBindings
                if (bindings && ts.isNamedImports(bindings)
                    && bindings.elements.some((element) => (element.propertyName?.text ?? element.name.text) === 'createRequire')) {
                    violations.add('ARCH037_DRAIN_REDEMPTION_BOUNDARY')
                }
                if (bindings && ts.isNamespaceImport(bindings)) {
                    const symbol = checker.getSymbolAtLocation(bindings.name)
                    if (symbol) commonJsNamespaces.add(symbol)
                }
            }
            if (modulePath !== claimsModule && ts.isImportDeclaration(statement)
                && ts.isStringLiteralLike(statement.moduleSpecifier)
                && canonicalModulePath(resolveImport(path, statement.moduleSpecifier.text, sources) ?? '') === claimsModule) {
                const bindings = statement.importClause?.namedBindings
                if (bindings && ts.isNamespaceImport(bindings)) violations.add('ARCH037_DRAIN_REDEMPTION_BOUNDARY')
                if (bindings && ts.isNamedImports(bindings)) for (const element of bindings.elements) {
                    const imported = element.propertyName?.text ?? element.name.text
                    if (retiredExports.has(imported)) violations.add('ARCH037_DRAIN_REDEMPTION_BOUNDARY')
                    if (!facetOwners.has(imported)) continue
                    importedBrokerNames.add(imported)
                    if (facetOwners.get(imported) !== modulePath || element.name.text !== imported) {
                        violations.add('ARCH037_DRAIN_REDEMPTION_BOUNDARY')
                    }
                    const symbol = checker.getSymbolAtLocation(element.name)
                    if (symbol) brokerBindings.add(symbol)
                }
            }
            if (modulePath !== claimsModule && ts.isExportDeclaration(statement)
                && statement.moduleSpecifier && ts.isStringLiteralLike(statement.moduleSpecifier)
                && canonicalModulePath(resolveImport(path, statement.moduleSpecifier.text, sources) ?? '') === claimsModule
                && (!statement.exportClause || ts.isNamespaceExport(statement.exportClause)
                    || statement.exportClause.elements.some((element) =>
                        retiredExports.has(element.propertyName?.text ?? element.name.text)
                        || facetOwners.has(element.propertyName?.text ?? element.name.text)))) {
                violations.add('ARCH037_DRAIN_REDEMPTION_BOUNDARY')
            }
            if (modulePath !== claimsModule && ts.isExportDeclaration(statement)
                && !statement.moduleSpecifier && statement.exportClause && ts.isNamedExports(statement.exportClause)
                && statement.exportClause.elements.some((element) =>
                    brokerExports.has(element.propertyName?.text ?? element.name.text))) {
                violations.add('ARCH037_DRAIN_REDEMPTION_BOUNDARY')
            }
            if (modulePath !== claimsModule && ts.canHaveModifiers(statement)
                && ts.getModifiers(statement)?.some(({ kind }) => kind === ts.SyntaxKind.ExportKeyword)) {
                const exportedName = ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)
                    ? statement.name?.text
                    : ts.isVariableStatement(statement) && statement.declarationList.declarations.length === 1
                        && ts.isIdentifier(statement.declarationList.declarations[0]!.name)
                        ? statement.declarationList.declarations[0]!.name.text : undefined
                if (exportedName && brokerExports.has(exportedName)) {
                    violations.add('ARCH037_DRAIN_REDEMPTION_BOUNDARY')
                }
            }
        }
        const isLocallyDeclared = (identifier: ts.Identifier): boolean => {
            const symbol = checker.getSymbolAtLocation(identifier)
            return Boolean(symbol?.declarations?.some((declaration) => declaration.getSourceFile() === sourceFile))
        }
        const directResultEscape = (call: ts.CallExpression): boolean => {
            let current: ts.Node = call
            while (ts.isParenthesizedExpression(current.parent) || ts.isAsExpression(current.parent)
                || ts.isSatisfiesExpression(current.parent) || ts.isNonNullExpression(current.parent)
                || ts.isAwaitExpression(current.parent)) {
                current = current.parent
            }
            const parent = current.parent
            return ts.isReturnStatement(parent) || ts.isExportAssignment(parent)
                || ts.isArrowFunction(parent) || ts.isPropertyAssignment(parent)
                || ts.isArrayLiteralExpression(parent) || ts.isSpreadElement(parent)
                || ts.isCallExpression(parent) || ts.isNewExpression(parent)
                || ts.isTaggedTemplateExpression(parent) || ts.isBinaryExpression(parent)
                || ts.isConditionalExpression(parent)
        }
        const visit = (node: ts.Node): void => {
            if ((ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) && retiredBrokerNames.has(node.text)) {
                violations.add('ARCH037_DRAIN_REDEMPTION_BOUNDARY')
            }
            if (modulePath !== claimsModule && (ts.isIdentifier(node) || ts.isPrivateIdentifier(node))
                && (claimsOwnedNames.has(node.text) || claimsOwnedStores.has(node.text))) {
                violations.add('ARCH037_DRAIN_REDEMPTION_BOUNDARY')
            }
            if (modulePath !== claimsModule && ts.isIdentifier(node) && brokerExports.has(node.text)) {
                const symbol = checker.getSymbolAtLocation(node)
                if (symbol?.declarations?.some((declaration) => !ts.isImportSpecifier(declaration))) {
                    violations.add('ARCH037_DRAIN_REDEMPTION_BOUNDARY')
                }
            }
            if (ts.isIdentifier(node) && brokerBindings.has(checker.getSymbolAtLocation(node)!)
                && !ts.isImportSpecifier(node.parent)) {
                if (!ts.isCallExpression(node.parent) || node.parent.expression !== node || node.parent.questionDotToken) {
                    violations.add('ARCH037_DRAIN_REDEMPTION_BOUNDARY')
                } else if (directResultEscape(node.parent)) {
                    violations.add('ARCH037_DRAIN_REDEMPTION_BOUNDARY')
                } else {
                    directlyCalledBrokerNames.add(node.text)
                }
            }
            if ((modulePath === runtimeModule || modulePath === reclaimModule)
                && (ts.isPropertySignature(node) || ts.isPropertyDeclaration(node)
                    || ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node))
                && (ts.isIdentifier(node.name) || ts.isStringLiteralLike(node.name))
                && capabilityFieldNames.has(node.name.text)) {
                violations.add('ARCH037_DRAIN_REDEMPTION_BOUNDARY')
            }
            if (brokerModule && ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
                violations.add('ARCH037_DRAIN_REDEMPTION_BOUNDARY')
            }
            if (brokerModule && ts.isImportEqualsDeclaration(node)
                && ts.isExternalModuleReference(node.moduleReference)) {
                violations.add('ARCH037_DRAIN_REDEMPTION_BOUNDARY')
            }
            if (brokerModule && ts.isPropertyAccessExpression(node) && node.name.text === 'createRequire'
                && ts.isIdentifier(node.expression)
                && commonJsNamespaces.has(checker.getSymbolAtLocation(node.expression)!)) {
                violations.add('ARCH037_DRAIN_REDEMPTION_BOUNDARY')
            }
            if (brokerModule && ts.isIdentifier(node) && node.text === 'require' && !isLocallyDeclared(node)
                && !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)
                && !(ts.isElementAccessExpression(node.parent) && node.parent.argumentExpression === node)) {
                violations.add('ARCH037_DRAIN_REDEMPTION_BOUNDARY')
            }
            if (brokerModule && ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
                && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === 'module'
                && node.expression.name.text === 'require' && !isLocallyDeclared(node.expression.expression)) {
                violations.add('ARCH037_DRAIN_REDEMPTION_BOUNDARY')
            }
            if (brokerModule && ts.isCallExpression(node) && ts.isElementAccessExpression(node.expression)
                && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === 'module'
                && node.expression.argumentExpression && ts.isStringLiteralLike(node.expression.argumentExpression)
                && node.expression.argumentExpression.text === 'require'
                && !isLocallyDeclared(node.expression.expression)) {
                violations.add('ARCH037_DRAIN_REDEMPTION_BOUNDARY')
            }
            if (brokerModule && ts.isCallExpression(node)
                && (ts.isPropertyAccessExpression(node.expression) || ts.isElementAccessExpression(node.expression))
                && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === 'process'
                && !isLocallyDeclared(node.expression.expression)
                && (ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text === 'getBuiltinModule'
                    : node.expression.argumentExpression && ts.isStringLiteralLike(node.expression.argumentExpression)
                        && node.expression.argumentExpression.text === 'getBuiltinModule')) {
                violations.add('ARCH037_DRAIN_REDEMPTION_BOUNDARY')
            }
            if (brokerModule && (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))
                && ts.isIdentifier(node.expression) && node.expression.text === 'global'
                && !isLocallyDeclared(node.expression)
                && (ts.isPropertyAccessExpression(node) ? ['eval', 'Function'].includes(node.name.text)
                    : node.argumentExpression && ts.isStringLiteralLike(node.argumentExpression)
                        && ['eval', 'Function'].includes(node.argumentExpression.text))) {
                violations.add('ARCH037_DRAIN_REDEMPTION_BOUNDARY')
            }
            if (brokerModule && ts.isIdentifier(node) && ['eval', 'Function', 'globalThis'].includes(node.text)
                && !isLocallyDeclared(node)) {
                violations.add('ARCH037_DRAIN_REDEMPTION_BOUNDARY')
            }
            ts.forEachChild(node, visit)
        }
        visit(sourceFile)
        const requiredFacets = modulePath === runtimeModule || modulePath === reclaimModule
            ? new Set([...facetOwners].flatMap(([name, owner]) => owner === modulePath ? [name] : []))
            : undefined
        if (requiredFacets && sources.has(claimsModule)
            && (importedBrokerNames.size !== requiredFacets.size
            || [...requiredFacets].some((name) => !importedBrokerNames.has(name)
                || !directlyCalledBrokerNames.has(name)))) {
            violations.add('ARCH037_DRAIN_REDEMPTION_BOUNDARY')
        }
    }
    return [...violations]
}

function coordinationPolicyViolations(sources: Sources): string[] {
    const violations = new Set<string>()
    const claimsModule = 'packages/cockpit/src/environment/claims.ts'
    const portsModule = 'packages/cockpit/src/environment/ports.ts'
    const reclaimModule = 'packages/cockpit/src/environment/reclaim.ts'
    const finalizationOwners = new Set([
        claimsModule,
        'packages/cockpit/src/environment/application.ts',
    ])
    const redemptionExports = new Set(['inspectDrainAttemptAuthority', 'redeemRuntimeStopAttempt', 'redeemReclaimAttempt'])
    const transactionReducers = new Set([
        'reduceDrainAttemptStart', 'reduceDrainAttemptRetry', 'reduceDrainAttemptFailure',
        'reduceDrainAttemptSuccess', 'reduceDrain',
    ])
    const recoveryPolicyExports = new Set(['inspectFailedReclaimRecovery', 'consumeFailedReclaimRecovery'])
    const policyExports = new Set([
        'reserveDrain', 'recoverDrainReservation', 'inspectDestructiveDrainRecovery', 'consumeDrainReservationAuthority',
        'reserveDrainAttempt', 'reduceDrainAttemptStart', 'reduceDrainAttemptRetry',
        'reduceDrainAttemptFailure', 'reduceDrainAttemptSuccess', 'finalizeDrainAttemptOutcome',
        ...redemptionExports, ...recoveryPolicyExports, 'isDrainActive', 'reduceDrain',
    ])
    for (const [path, source] of sources) {
        const modulePath = canonicalModulePath(path)
        const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
        const accessedPolicyFields = new Set<string>()
        const importedClaimsBindings = new Map<string, string>()
        const functionCalls = new Map<string, Set<string>>()
        const directRecoveryCalls = new Set<string>()
        const visit = (node: ts.Node, currentFunction?: string): void => {
            if (ts.isPropertyAccessExpression(node)) accessedPolicyFields.add(node.name.text)
            if (ts.isElementAccessExpression(node) && node.argumentExpression && ts.isStringLiteralLike(node.argumentExpression)) {
                accessedPolicyFields.add(node.argumentExpression.text)
            }
            if (currentFunction && ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
                const calls = functionCalls.get(currentFunction) ?? new Set<string>()
                calls.add(node.expression.text)
                functionCalls.set(currentFunction, calls)
            }
            if (ts.isIdentifier(node) && importedClaimsBindings.has(node.text)
                && !ts.isImportSpecifier(node.parent)) {
                const imported = importedClaimsBindings.get(node.text)!
                const directCall = ts.isCallExpression(node.parent) && node.parent.expression === node
                const callEscapes = directCall && (ts.isReturnStatement(node.parent.parent)
                    || ts.isExportAssignment(node.parent.parent)
                    || ts.isCallExpression(node.parent.parent)
                    || ts.isPropertyAssignment(node.parent.parent)
                    || ts.isArrayLiteralExpression(node.parent.parent)
                    || ts.isBinaryExpression(node.parent.parent))
                if (recoveryPolicyExports.has(imported)) {
                    const declaration = directCall && ts.isVariableDeclaration(node.parent.parent)
                        ? node.parent.parent : undefined
                    const exportedDeclaration = declaration && ts.isVariableDeclarationList(declaration.parent)
                        && ts.isVariableStatement(declaration.parent.parent)
                        && declaration.parent.parent.modifiers?.some(({ kind }) => kind === ts.SyntaxKind.ExportKeyword)
                    if (modulePath === reclaimModule && directCall && !callEscapes && !exportedDeclaration) {
                        directRecoveryCalls.add(node.text)
                    } else {
                        violations.add('ARCH034_DUPLICATE_COORDINATION_POLICY')
                    }
                }
                if (imported === 'finalizeDrainAttemptOutcome'
                    && (!finalizationOwners.has(modulePath) || !directCall || callEscapes)) {
                    violations.add('ARCH038_DRAIN_OUTCOME_FINALIZATION_BOUNDARY')
                }
                if (transactionReducers.has(imported)
                    && (modulePath !== claimsModule
                        && (modulePath !== 'packages/cockpit/src/environment/application.ts' || !directCall || callEscapes))) {
                    violations.add('ARCH034_DUPLICATE_COORDINATION_POLICY')
                }
            }
            if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
                && node.arguments.length === 1 && ts.isStringLiteralLike(node.arguments[0]!)) {
                const target = resolveImport(path, node.arguments[0]!.text, sources)
                if (target && canonicalModulePath(target) === claimsModule && modulePath !== claimsModule) {
                    violations.add('ARCH034_DUPLICATE_COORDINATION_POLICY')
                    violations.add('ARCH038_DRAIN_OUTCOME_FINALIZATION_BOUNDARY')
                }
            }
            let nestedFunction = currentFunction
            if (ts.isFunctionDeclaration(node) && node.name) nestedFunction = node.name.text
            if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer
                && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) nestedFunction = node.name.text
            ts.forEachChild(node, (child) => visit(child, nestedFunction))
        }
        for (const statement of sourceFile.statements) {
            if (ts.isImportDeclaration(statement) && ts.isStringLiteralLike(statement.moduleSpecifier)) {
                const target = resolveImport(path, statement.moduleSpecifier.text, sources)
                if (target && canonicalModulePath(target) === claimsModule && statement.importClause?.namedBindings
                    && ts.isNamedImports(statement.importClause.namedBindings)) {
                    for (const element of statement.importClause.namedBindings.elements) {
                        importedClaimsBindings.set(element.name.text, element.propertyName?.text ?? element.name.text)
                    }
                }
                if (target && canonicalModulePath(target) === claimsModule && statement.importClause?.namedBindings
                    && ts.isNamespaceImport(statement.importClause.namedBindings)) {
                    violations.add('ARCH034_DUPLICATE_COORDINATION_POLICY')
                    if (modulePath !== claimsModule) violations.add('ARCH038_DRAIN_OUTCOME_FINALIZATION_BOUNDARY')
                }
            }
            if (modulePath !== claimsModule && ts.isExportDeclaration(statement) && statement.exportClause
                && ts.isNamedExports(statement.exportClause)) {
                for (const element of statement.exportClause.elements) {
                    const exported = element.propertyName?.text ?? element.name.text
                    if (policyExports.has(exported)) {
                        violations.add('ARCH034_DUPLICATE_COORDINATION_POLICY')
                    }
                    if (exported === 'finalizeDrainAttemptOutcome') violations.add('ARCH038_DRAIN_OUTCOME_FINALIZATION_BOUNDARY')
                }
            }
            if (modulePath !== claimsModule && ts.isExportDeclaration(statement)
                && statement.moduleSpecifier && ts.isStringLiteralLike(statement.moduleSpecifier)
                && canonicalModulePath(resolveImport(path, statement.moduleSpecifier.text, sources) ?? '') === claimsModule
                && (!statement.exportClause || ts.isNamespaceExport(statement.exportClause))) {
                violations.add('ARCH034_DUPLICATE_COORDINATION_POLICY')
                violations.add('ARCH038_DRAIN_OUTCOME_FINALIZATION_BOUNDARY')
            }
        }
        visit(sourceFile)
        for (const imported of importedClaimsBindings.values()) {
            if (imported === 'finalizeDrainAttemptOutcome' && !finalizationOwners.has(modulePath)) {
                violations.add('ARCH038_DRAIN_OUTCOME_FINALIZATION_BOUNDARY')
            }
        }
        for (const [local, imported] of importedClaimsBindings) {
            if (recoveryPolicyExports.has(imported) && !directRecoveryCalls.has(local)) {
                violations.add('ARCH034_DUPLICATE_COORDINATION_POLICY')
            }
        }
        const exportedPolicy = [...exportedImplementations(source)].some((name) => policyExports.has(name))
        const bindingFieldCount = ['drain', 'reservationId', 'operationBasis', 'coordinationRevision']
            .filter((field) => accessedPolicyFields.has(field)).length
        if (modulePath !== claimsModule && (exportedPolicy || accessedPolicyFields.has('drain') && bindingFieldCount >= 2)) {
            violations.add('ARCH034_DUPLICATE_COORDINATION_POLICY')
        }
        if (modulePath === STATE_MODULE && (importedClaimsBindings.size > 0 || bindingFieldCount > 0 || exportedPolicy)) {
            violations.add('ARCH035_STATE_POLICY_BOUNDARY')
        }
        if (modulePath === portsModule) {
            const guardBinding = [...importedClaimsBindings].find(([, imported]) => imported === 'isDrainActive')?.[0]
            const releaseBinding = [...importedClaimsBindings].find(([, imported]) => imported === 'releaseClaim')?.[0]
            if (!guardBinding || !functionCalls.get('leasePortFamily')?.has(guardBinding)
                || !releaseBinding || !functionCalls.get('releasePortFamily')?.has(releaseBinding)
                || accessedPolicyFields.has('drain')) {
                violations.add('ARCH036_COORDINATION_GUARD_BYPASS')
            }
        }
    }
    return [...violations]
}

function observationDeclarationViolations(sources: Sources): string[] {
    const seenIds = new Set<string>()
    const seenCodes = new Set<string>()
    const violations = new Set<string>()
    const declarationModules = new Set<string>()
    for (const [path, source] of sources) {
        const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
        const localBindings = new Set<string>()
        for (const statement of sourceFile.statements) {
            if (ts.isFunctionDeclaration(statement) && statement.name) localBindings.add(statement.name.text)
            if (ts.isVariableStatement(statement)) {
                for (const declaration of statement.declarationList.declarations) {
                    if (ts.isIdentifier(declaration.name)) localBindings.add(declaration.name.text)
                }
            }
            if (ts.isImportDeclaration(statement) && statement.importClause?.namedBindings && ts.isNamedImports(statement.importClause.namedBindings)
                && statement.importClause.namedBindings.elements.some(({ name }) => /^issue.*Observation$/.test(name.text))) {
                violations.add('ARCH032_OBSERVATION_ISSUER_EXPORTED')
            }
            if (ts.isFunctionDeclaration(statement) && statement.name && /^issue.*Observation$/.test(statement.name.text)
                && statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
                violations.add('ARCH032_OBSERVATION_ISSUER_EXPORTED')
            }
        }
        const declarations = sourceFile.statements
            .filter((statement): statement is ts.VariableStatement => ts.isVariableStatement(statement)
                && statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) === true)
            .flatMap((statement) => [...statement.declarationList.declarations])
        for (const declaration of declarations) {
            const call = declaration.initializer && ts.isCallExpression(declaration.initializer) ? declaration.initializer : undefined
            let value: ts.Expression | undefined = call?.expression.getText(sourceFile) === 'Object.freeze' ? call.arguments[0] : undefined
            while (value && (ts.isAsExpression(value) || ts.isParenthesizedExpression(value))) value = value.expression
            if (!value || !ts.isArrayLiteralExpression(value)) {
                if (ts.isIdentifier(declaration.name) && declaration.name.text === 'observationDeclarations') violations.add('ARCH030_OBSERVATION_DECLARATION_NOT_LOCAL')
                continue
            }
            const looksLikeDeclarations = value.elements.length > 0 && value.elements.every(ts.isObjectLiteralExpression)
                && value.elements.some((element) => ts.isObjectLiteralExpression(element)
                    && element.properties.some((property) => property.name?.getText(sourceFile).replaceAll("'", '') === 'postures'))
            if (!looksLikeDeclarations) continue
            declarationModules.add(canonicalModulePath(path))
            for (const element of value.elements) {
            if (!ts.isObjectLiteralExpression(element)) {
                violations.add('ARCH030_OBSERVATION_DECLARATION_NOT_LOCAL'); continue
            }
            const property = (name: string) => element.properties.find((item): item is ts.PropertyAssignment =>
                ts.isPropertyAssignment(item) && item.name.getText(sourceFile).replaceAll("'", '') === name)
            const id = property('id')?.initializer
            const owner = property('owner')?.initializer
            const code = property('code')?.initializer
            const postures = property('postures')?.initializer
            const stages = property('stages')?.initializer
            const issuedProperty = element.properties.find((item) => item.name?.getText(sourceFile).replaceAll("'", '') === 'isIssued')
            const isIssued = issuedProperty && (ts.isPropertyAssignment(issuedProperty) ? issuedProperty.initializer
                : ts.isShorthandPropertyAssignment(issuedProperty) ? issuedProperty.name : undefined)
            if (!id || !ts.isStringLiteral(id) || owner?.getText(sourceFile) !== 'mechanism.id'
                || !code || !/^ENVIRONMENT_CODES\.[A-Z0-9_]+$/.test(code.getText(sourceFile))
                || !postures || !ts.isArrayLiteralExpression(postures) || postures.elements.length === 0
                || postures.elements.some((item) => !ts.isStringLiteral(item)) || !isIssued || !ts.isIdentifier(isIssued)
                || !localBindings.has(isIssued.text)) {
                violations.add('ARCH030_OBSERVATION_DECLARATION_NOT_LOCAL'); continue
            }
            const stageNames = stages && ts.isArrayLiteralExpression(stages)
                ? stages.elements.flatMap((stage) => {
                    if (!ts.isObjectLiteralExpression(stage)) return []
                    const field = stage.properties.find((item): item is ts.PropertyAssignment =>
                        ts.isPropertyAssignment(item) && item.name.getText(sourceFile).replaceAll("'", '') === 'stage')
                    return field && ts.isStringLiteral(field.initializer) ? [field.initializer.text] : []
                })
                : []
            if (!stages || !ts.isArrayLiteralExpression(stages) || stages.elements.length !== 2
                || stageNames.length !== 2 || new Set(stageNames).size !== 2
                || !stageNames.includes('bootstrap') || !stageNames.includes('steady')) {
                violations.add('ARCH033_OBSERVATION_STAGE_NOT_LOCAL')
            }
            if (seenIds.has(id.text) || seenCodes.has(code.getText(sourceFile))) violations.add('ARCH029_DUPLICATE_OBSERVATION_DECLARATION')
            seenIds.add(id.text); seenCodes.add(code.getText(sourceFile))
            }
        }
    }
    const aggregate = sources.get('packages/cockpit/src/environment/observations.ts')
    if (aggregate) {
        const aggregateFile = ts.createSourceFile('observations.ts', aggregate, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
        const imports = new Map<string, string>()
        const spreads = new Set<string>()
        for (const statement of aggregateFile.statements) {
            if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)
                && statement.importClause?.namedBindings && ts.isNamedImports(statement.importClause.namedBindings)) {
                const imported = statement.importClause.namedBindings.elements.find(({ propertyName, name }) =>
                    (propertyName ?? name).text === 'observationDeclarations')
                if (imported) imports.set(statement.moduleSpecifier.text, imported.name.text)
            }
            if (!ts.isVariableStatement(statement)) continue
            for (const declaration of statement.declarationList.declarations) {
                if (!ts.isIdentifier(declaration.name) || declaration.name.text !== 'allObservationDeclarations') continue
                const call = declaration.initializer && ts.isCallExpression(declaration.initializer) ? declaration.initializer : undefined
                let value: ts.Expression | undefined = call?.expression.getText(aggregateFile) === 'Object.freeze' ? call.arguments[0] : undefined
                while (value && (ts.isAsExpression(value) || ts.isParenthesizedExpression(value))) value = value.expression
                if (!value || !ts.isArrayLiteralExpression(value)) continue
                for (const element of value.elements) {
                    if (ts.isSpreadElement(element) && ts.isIdentifier(element.expression)) spreads.add(element.expression.text)
                }
            }
        }
        for (const module of declarationModules) {
            if (module.endsWith('/observations.ts')) continue
            const stem = posix.basename(module, '.ts')
            const imported = imports.get(`./${stem}.js`)
            if (!imported || !spreads.has(imported)) violations.add('ARCH031_OBSERVATION_AGGREGATE_INCOMPLETE')
        }
        for (const code of ['CONFIG_STALE', 'SIBLING_MISSING', 'GUIDE_CAP_EXCEEDED', 'MACHINE_COLD_START_EXCEEDED', 'DISK_BUDGET_EXCEEDED']) {
            if (!seenCodes.has(`ENVIRONMENT_CODES.${code}`)) violations.add('ARCH031_OBSERVATION_AGGREGATE_INCOMPLETE')
        }
    }
    return [...violations]
}

function jsonSnapshotOwnershipViolations(sources: Sources): string[] {
    for (const [path, source] of sources) {
        if (canonicalModulePath(path) === 'packages/cockpit/src/environment/contract.ts') continue
        if (/Object\.create\(null\)/.test(source) && /Object\.keys\(/.test(source) && /Object\.freeze\(/.test(source)) {
            return ['ARCH028_JSON_SNAPSHOT_HOME']
        }
    }
    return []
}

function publicationBatchAuthorityViolations(source: string): string[] {
    const sourceFile = ts.createSourceFile('transaction.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    const declarations = new Map<string, ts.Node[]>()
    const calls: ts.CallExpression[] = []
    const visit = (node: ts.Node): void => {
        const name = (ts.isFunctionDeclaration(node) || ts.isInterfaceDeclaration(node)) && node.name?.text
        if (name) declarations.set(name, [...declarations.get(name) ?? [], node])
        if (ts.isCallExpression(node) && node.expression.getText(sourceFile) === 'runPublicationBatches') calls.push(node)
        ts.forEachChild(node, visit)
    }
    visit(sourceFile)
    const functionBody = (name: string): string | undefined => {
        const matches = declarations.get(name) ?? []
        return matches.length === 1 && ts.isFunctionDeclaration(matches[0]!) ? matches[0]!.body?.getText(sourceFile) : undefined
    }
    const exactDeclaration = (name: string, pattern: RegExp): boolean => {
        const matches = declarations.get(name) ?? []
        return matches.length === 1 && pattern.test(matches[0]!.getText(sourceFile))
    }
    const compact = (value: string | undefined): string => value?.replace(/\s+/g, '') ?? ''
    const request = compact(functionBody('publicationBatchRequest'))
    const receipt = compact(functionBody('parsePublicationBatchReceipt'))
    const dispatch = compact(functionBody('runPublicationBatches'))
    const helper = source.match(/const FILESYSTEM_HELPER = String\.raw`([\s\S]*?)`/)?.[1] ?? ''
    const compactHelper = compact(helper)
    const batchBranchStart = compactHelper.indexOf('request.action==="validate-batch"||request.action==="publish-batch"||request.action==="verify-batch"||request.action==="commit-batch"')
    const commitBatchStart = compactHelper.indexOf('if(request.action==="commit-batch"){for(constgroupofrequest.groups)')
    const batchValidationBody = batchBranchStart >= 0 && commitBatchStart > batchBranchStart
        ? compactHelper.slice(batchBranchStart, commitBatchStart)
        : ''
    const commitBatchBody = commitBatchStart >= 0 ? compactHelper.slice(commitBatchStart) : ''
    const required = [
        exactDeclaration('PublicationBatchRow', /readonly nonce: string[\s\S]*readonly parent: string[\s\S]*readonly identity: DirectoryIdentity[\s\S]*readonly chain: readonly Readonly<DirectoryIdentity & \{ readonly name: string \}>\[\][\s\S]*readonly entries: readonly HelperFileEntry\[\]/),
        exactDeclaration('PublicationBatchRequest', /readonly version: 1[\s\S]*readonly nonce: string[\s\S]*readonly action: 'validate-batch' \| 'publish-batch' \| 'verify-batch' \| 'commit-batch'[\s\S]*readonly identity: DirectoryIdentity[\s\S]*readonly groups: readonly PublicationBatchRow\[\]/),
        /const MAX_PUBLICATION_BATCH_GROUPS = 8\b/.test(source),
        request.includes('constrootStatus=awaitlstat(root)')
            && request.includes('rootStatus.dev!==rootIdentity.dev||rootStatus.ino!==rootIdentity.ino'),
        request.includes('for(constgroupofgroups.slice(0,MAX_PUBLICATION_BATCH_GROUPS))')
            && request.includes("consttarget=group.parent==='.'?root:confined(root,group.parent)")
            && request.includes('if(!target||target!==group.path)returnundefined'),
        request.includes("for(constnameofgroup.parent==='.'?[]:group.parent.split('/'))")
            && request.includes('chain.push(Object.freeze({name,dev:status.dev,ino:status.ino}))')
            && request.includes('constfinal=chain.at(-1)??rootIdentity')
            && request.includes('final.dev!==group.identity.dev||final.ino!==group.identity.ino'),
        request.includes('nonce:randomBytes(16).toString') && request.includes('parent:group.parent')
            && request.includes('identity:group.identity') && request.includes('chain:Object.freeze(chain)')
            && request.includes('entries:group.entries'),
        request.includes('constcandidate=Object.freeze({version:1asconst,nonce,action,identity:rootIdentity,groups:Object.freeze([...rows,row])})')
            && request.includes('if(Buffer.byteLength(JSON.stringify(candidate))>MAX_HELPER_FRAME_BYTES)break'),
        receipt.includes("helperRecord(value,['version','nonce','action','kind','groups'])")
            && receipt.includes('receipt.groups.length!==request.groups.length')
            && receipt.includes('constexpected=request.groups[index]')
            && receipt.includes("helperRecord(value,['nonce','parent','kind'])")
            && receipt.includes('row.nonce===expected.nonce&&row.parent===expected.parent&&row.kind===\'complete\''),
        receipt.includes('constnonces=newSet<string>()') && receipt.includes('nonces.has(row.nonce)')
            && receipt.includes('nonces.add(row.nonce)'),
        dispatch.includes('constrequest=awaitpublicationBatchRequest(root,rootIdentity,groups.slice(offset),action)')
            && (dispatch.includes('constdeadline=nextForwardDeadline(request.groups.length)')
                || dispatch.includes('constlogicalWeight=request.groups.reduce((count,_row,index)=>count+groups[offset+index]!.logicalWeight,0)')
                    && dispatch.includes('constdeadline=nextForwardDeadline(logicalWeight)'))
            && dispatch.includes("helperStep(node,root,'generated-environment',request,[],deadline)")
            && dispatch.includes('parsePublicationBatchReceipt(receipt,request)')
            && dispatch.includes('offset+=request.groups.length'),
        source.includes('const transactionRootIdentity = prepared.rootIdentity')
            && source.includes('transactionRoot.dev !== transactionRootIdentity.dev || transactionRoot.ino !== transactionRootIdentity.ino')
            && (source.match(/!await transactionRootCurrent\(\)/g) ?? []).length >= 3,
        calls.length === 4
            && calls.map(call => compact(call.arguments[0]?.getText(sourceFile))).join('|') === "'validate-batch'|'publish-batch'|'verify-batch'|'commit-batch'"
            && calls.every(call => compact(call.arguments[1]?.getText(sourceFile)) === 'prepared.root'
                && compact(call.arguments[2]?.getText(sourceFile)) === 'transactionRootIdentity'
                && compact(call.arguments[3]?.getText(sourceFile)) === 'applied'),
        batchBranchStart >= 0
            && batchValidationBody.includes('request.groups.length<1||request.groups.length>8')
            && batchValidationBody.includes('constchain=walkExpected(group.chain)')
            && batchValidationBody.includes('if(!same(final,group.identity))thrownewError("group-identity")')
            && batchValidationBody.includes('if(request.action==="publish-batch")publishEntries(group.entries);elseif(request.action==="validate-batch")validateEntries(group.entries);elseverifyEntries(group.entries);verifySourceChain(chain);groups.push({nonce:group.nonce,parent:group.parent,kind:"complete"})'),
        commitBatchStart >= 0
            && compactHelper.includes('groups.push({nonce:group.nonce,parent:group.parent,kind:"complete"});}if(request.action==="commit-batch")')
            && (compactHelper.match(/constfinal=fs\.lstatSync\("\."\);if\(!same\(final,group\.identity\)\)thrownewError\("group-identity"\)/g) ?? []).length >= 2
            && commitBatchBody.includes('for(constentryofgroup.entries)')
            && commitBatchBody.includes('verifyEntries([entry],group.identity)')
            && commitBatchBody.indexOf('verifyEntries([entry],group.identity)') < commitBatchBody.indexOf('constnested=walkExpected(entry.chain)')
            && commitBatchBody.indexOf('constnested=walkExpected(entry.chain)') < commitBatchBody.indexOf('fs.unlinkSync(name(entry.backup))')
            && commitBatchBody.includes('syncDirectory();verifySourceChain(nested,group.identity)')
            && (compactHelper.match(/verifySourceChain\(chain\)/g) ?? []).length >= 2,
        !compactHelper.includes('if(request.action==="commit")')
            && !/\bMAX_COMMIT_JOBS\b/.test(source)
            && exactDeclaration('parseSimpleReceipt', /action: 'publish' \| 'verify' \| 'rollback'\)/),
    ]
    return required.flatMap((valid, index) => valid ? [] : [`ARCH049_PUBLICATION_BATCH_AUTHORITY_${index + 1}`])
}

function nestedPublicationAuthorityViolations(application: string, transaction: string): string[] {
    const applicationFile = ts.createSourceFile('generated-application.ts', application, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    const transactionFile = ts.createSourceFile('transaction.ts', transaction, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    const applicationNames = new Set(['PreparedEnvironment', 'prepareSurfaces', 'surfaceMutations', 'preparePublication'])
    const declarationNode = (name: string): ts.FunctionDeclaration | ts.InterfaceDeclaration | undefined => {
        const owner = applicationNames.has(name) ? applicationFile : transactionFile
        const matches = [applicationFile, transactionFile].flatMap(file => file.statements.filter(
            (node): node is ts.FunctionDeclaration | ts.InterfaceDeclaration =>
                (ts.isFunctionDeclaration(node) || ts.isInterfaceDeclaration(node)) && node.name?.text === name))
        return matches.length === 1 && matches[0]?.parent === owner ? matches[0] : undefined
    }
    const declaration = (name: string): string => declarationNode(name)?.getText() ?? ''
    const body = (name: string): string => {
        const node = declarationNode(name)
        return node && ts.isFunctionDeclaration(node) ? node.body?.getText() ?? '' : ''
    }
    const compact = (value: string): string => value.replace(/\s+/g, '')
    const prepared = compact(declaration('PreparedEnvironment'))
    const mutation = compact(declaration('PublicationMutation'))
    const helperEntry = compact(declaration('HelperFileEntry'))
    const appliedGroup = compact(declaration('AppliedGroup'))
    const publicationGroup = compact(declaration('PublicationGroup'))
    const prepareSurfaces = compact(body('prepareSurfaces'))
    const surfaceDeclaration = compact(declaration('surfaceMutations'))
    const surface = compact(body('surfaceMutations'))
    const grouping = compact(body('groupMutations'))
    const parser = compact(body('parsePrepareReceipt'))
    const chainValidator = compact(body('preparedEntryChainsValid'))
    const frameBound = compact(body('groupFrameBounded'))
    const preparation = compact(body('admitPlan'))
    const synchronize = compact(body('applyPrepared'))
    const nestedAuthority = compact(body('nestedPublicationAuthority'))
    const batches = compact(body('runPublicationBatches'))
    const compensate = compact(body('compensate'))
    const recovery = compact(body('recordRecovery'))
    const helper = transaction.match(/const FILESYSTEM_HELPER = String\.raw`([\s\S]*?)`/)?.[1] ?? ''
    const compactHelper = compact(helper)
    const verifyCall = "runPublicationBatches('verify-batch',prepared.root,transactionRootIdentity,applied,"
    const commitCall = "runPublicationBatches('commit-batch',prepared.root,transactionRootIdentity,applied,"
    const commitStart = synchronize.indexOf(`constfinalized=await${commitCall}`)
    const commitFailure = synchronize.indexOf('if(!finalized||forwardCallsRemaining!==0)', commitStart)
    const commitSuccess = synchronize.indexOf("returnObject.freeze({kind:'complete'", commitFailure)
    const commitFailureBody = commitFailure >= 0 && commitSuccess > commitFailure
        ? synchronize.slice(commitFailure, commitSuccess)
        : ''

    const properties = [
        prepared.includes('readonlycompactSurfacePaths:ReadonlySet<string>')
            && prepareSurfaces.includes('constcustomSurfacePaths=newSet(customReceipts.flatMap(receipt=>receipt.files.map(file=>file.path)))')
            && prepareSurfaces.includes('constcompactSurfacePaths=newSet(generated.files.map(file=>file.path).filter(path=>!customSurfacePaths.has(path)))')
            && prepareSurfaces.includes('compactSurfacePaths,'),
        mutation.includes('readonlycompactAnchor?:string')
            && surfaceDeclaration.includes('compactSurfacePaths:ReadonlySet<string>')
            && surface.includes("action.kind==='write'")
            && surface.includes("action.desired.kind==='symlink'")
            && surface.includes('compactSurfacePaths.has(action.path)')
            && surface.includes("if(path.startsWith('.agents/skills/'))return'.agents'")
            && surface.includes("for(constanchorof['.claude','.codex','.opencode'])")
            && surface.includes('if(path.startsWith(`${anchor}/`))returnanchor')
            && surface.includes('constcompactAnchor=compactSurfacePaths.has(action.path)?compactAnchorFor(action.path):undefined'),
        grouping.includes('row.compactAnchor')
            && grouping.includes('mutation.phase')
            && grouping.includes('dirname(mutation.path)')
            && grouping.includes('newSet(')
            && grouping.includes('parents.size>1')
            && grouping.includes('groupFrameBounded(anchor!,entries)')
            && grouping.includes('logicalWeight:cluster.length')
            && grouping.includes('phaseOrder'),
        helperEntry.includes('readonlychain:readonlyHelperChainEntry[]')
            && parser.includes("helperRecord(item,['chain','name','operation','sha256','target','stage','backup','priorKind','priorSha256','priorTarget','priorMode','priorIdentity'])")
            && parser.includes('preparedEntryChainsValid(entries,requests)')
            && parser.includes('constrequest=requests[index]')
            && parser.includes('constexpectedStage=`.cockpit-stage-${nonce}-${index}`')
            && parser.includes('constexpectedBackup=`.cockpit-backup-${nonce}-${index}`')
            && parser.includes("row.stage!==(request.operation==='write-file'||request.operation==='write-symlink'?expectedStage:null)")
            && parser.includes("row.backup!==(row.priorKind==='file'?expectedBackup:null)")
            && synchronize.includes('constreceipt=parsePrepareReceipt(raw,nonce,entries)'),
        nestedAuthority.includes('if(!groupExists)returnObject.freeze({chain:Object.freeze([]),segments})')
            && nestedAuthority.includes('conststatus=awaitlstat(current)')
            && nestedAuthority.includes('status.isSymbolicLink()')
            && nestedAuthority.includes('chain.push(Object.freeze({name,dev:status.dev,ino:status.ino}))')
            && nestedAuthority.includes('segments:Object.freeze(segments.slice(index))')
            && synchronize.includes('constnested=awaitnestedPublicationAuthority(')
            && synchronize.includes('entries.push(Object.freeze({chain:nested.chain,segments:nested.segments,')
            && compactHelper.includes('walkNested(entry.chain,safeSegments(entry.segments),createdNested,nested)')
            && compactHelper.includes('walkExpected(entry.chain)')
            && (compactHelper.match(/verifySourceChain\(chain,start\)/g) ?? []).length >= 2
            && (compactHelper.match(/verifySourceChain\(nested,request\.identity\)/g) ?? []).length >= 2
            && compactHelper.includes('verifySourceChain(nested,final)'),
        chainValidator.includes('constcreatedPrefixes=newMap<string,DirectoryIdentity>()')
            && chainValidator.includes('entry.chain.length!==request.chain.length+request.segments.length')
            && chainValidator.includes('directory.name!==expected.name||directory.dev!==expected.dev||directory.ino!==expected.ino||directory.created')
            && chainValidator.includes('directory.name!==request.segments[chainIndex-request.chain.length]')
            && chainValidator.includes('if(directory.created||directory.dev!==created.dev||directory.ino!==created.ino)returnfalse')
            && chainValidator.includes('if(!directory.created)returnfalse'),
        compactHelper.includes('[...request.entries].reverse()')
            && compactHelper.includes('constremoveCreatedDirectories=(entries,start)=>')
            && compactHelper.includes('constchains=[...created.values()].sort((left,right)=>right.length-left.length)')
            && compactHelper.includes('constcurrent=fs.lstatSync(name(child.name));if(!same(current,child))thrownewError("created-identity")')
            && compactHelper.includes('verifySourceChain(parents,start)')
            && compactHelper.includes('removeCreatedDirectories(request.entries,request.identity)')
            && compactHelper.includes('constchildStatus=fs.lstatSync(name(child.name));if(!same(childStatus,child))thrownewError("child-identity")'),
        frameBound.includes("action:'prepare'")
            && frameBound.includes("action:'validate-batch'")
            && frameBound.includes("action:'publish-batch'")
            && frameBound.includes("action:'verify-batch'")
            && frameBound.includes("action:'rollback'")
            && frameBound.includes("action:'commit-batch'")
            && frameBound.includes('groups:[group]')
            && frameBound.includes('MAX_HELPER_FRAME_BYTES')
            && frameBound.includes('JSON.stringify(frame)')
            && frameBound.includes('+1'),
        synchronize.includes('applied.push(current)')
            && synchronize.includes('awaitrecordRecovery(staged.directory,applied)')
            && synchronize.indexOf('applied.push(current)') < synchronize.indexOf('awaitrecordRecovery(staged.directory,applied)'),
        publicationGroup.includes('readonlylogicalWeight:number')
            && appliedGroup.includes('readonlylogicalWeight:number')
            && grouping.includes('logicalWeight:1')
            && compact(body('admitPublicationPlan')).includes('returnawaitadmitPlan(input,adapters)')
            && preparation.includes('constcount=groups?.reduce((total,group)=>total+group.logicalWeight,0)??0')
            && preparation.includes('count*PUBLICATION_HELPER_CALLS_PER_GROUP*PUBLICATION_HELPER_SLOT_MS>TRANSACTION_TIMEOUT_MS')
            && transaction.includes('const TRANSACTION_TIMEOUT_MS = 180_000')
            && transaction.includes('const PUBLICATION_HELPER_SLOT_MS = 500')
            && transaction.includes('const PUBLICATION_HELPER_CALLS_PER_GROUP = 6')
            && compact(body('preparePublication')).includes('rootIdentity:prepared.personaSourceIdentity.root')
            && synchronize.includes('constlogicalGroupCount=groups.reduce((count,group)=>count+group.logicalWeight,0)')
            && synchronize.includes('logicalGroupCount*PUBLICATION_HELPER_SLOT_MS')
            && synchronize.includes('logicalGroupCount*(PUBLICATION_HELPER_CALLS_PER_GROUP-1)')
            && (synchronize.match(/nextForwardDeadline\(group\.logicalWeight\)/g) ?? []).length === 1
            && batches.includes('constlogicalWeight=request.groups.reduce((count,_row,index)=>count+groups[offset+index]!.logicalWeight,0)')
            && batches.includes('nextForwardDeadline(logicalWeight)')
            && compensate.includes('remainingWeight=rollback.reduce((count,group)=>count+group.logicalWeight,0)')
            && compensate.includes('remainingWeight-=group.logicalWeight')
            && recovery.includes('groups.map(({logicalWeight:_logicalWeight,...group})=>group)')
            && recovery.includes('groups:durableGroups'),
        synchronize.indexOf(verifyCall) >= 0
            && synchronize.indexOf(verifyCall) < commitStart
            && commitStart >= 0
            && synchronize.includes(`${commitCall}node,adapters,nextForwardDeadline).catch(()=>false)`, commitStart)
            && commitFailure >= 0
            && commitFailureBody.includes('retainInputs=true')
            && commitFailureBody.includes("returnrefuse('GENERATED_COMPENSATION_FAILED'")
            && commitFailureBody.includes("'generatedbyteswerepublishedbutretainedbackupscouldnotbesafelyfinalized;recoverretainedlocalbackupsbeforeretrying'")
            && commitFailureBody.includes('inputs=${staged.directory}')
            && !commitFailureBody.includes('compensate('),
    ]
    return properties.flatMap((valid, index) => valid ? [] : [`ARCH050_NESTED_PUBLICATION_AUTHORITY_${index + 1}`])
}

describe('product architecture contract', () => {
    it.each([
        'packages/cockpit/src/runtime.mts',
        'packages/cockpit/src/runtime.cts',
        'packages/cockpit/src/runtime.js',
        'packages/cockpit/src/runtime.cjs',
        'scripts/runtime.mts',
        'scripts/runtime.cjs',
    ])('includes executable module form %s in the production corpus', (path) => {
        expect(productionSourcePath(path)).toBe(true)
    })

    it('excludes test-support modules from the production corpus', () => {
        expect(productionSourcePath('packages/cockpit/src/test-support/helper.ts')).toBe(false)
    })

    it('fails closed when an unparsed shell module enters a production source root', () => {
        expect(() => assertSupportedProductionPaths(['scripts/runtime.sh'])).toThrow(
            'ARCH018_UNPARSED_EXECUTABLE scripts/runtime.sh',
        )
    })

    it('keeps the production graph acyclic and leaf-ward with one local home per mechanism', () => {
        expect(inspectArchitecture(productionSources())).toEqual([])
    })

    it('keeps cached import parsing exact-source and returns independent results', () => {
        const first = importSpecifiers("import './first.js'")
        first.push('./caller-only.js')

        expect(importSpecifiers("import './first.js'")).toEqual(['./first.js'])
        expect(importSpecifiers("import './second.js'")).toEqual(['./second.js'])
    })

    it('confines lifecycle issuance consumption to its declared consumers', () => {
        expect(lifecycleIssuanceConsumerViolations(cockpitSources())).toEqual([])
    })

    it('keeps generated environment routing declarative and canonical production in its owners', () => {
        const sources = productionSources()
        const commandTable = sources.get('packages/cockpit/src/command-table.ts')
        const cli = sources.get('packages/cockpit/src/cli.ts')
        const command = sources.get('packages/cockpit/src/generated-environment/command.ts')
        if (!commandTable || !cli || !command) throw new Error('generated environment command routing is missing')

        expect(importSpecifiers(commandTable).filter((specifier) => specifier.startsWith('.'))).toEqual([
            './surfaces/contract.js', './environment/contract.js', './guards/evaluator.js', './guards/harness-adapter.js', './guards/invocation-parser.js',
        ])
        expect(cli).toContain("from './generated-environment/command.js'")
        expect(commandTable).not.toMatch(/\b(?:renderGeneratedEnvironment|projectPersonaOutputs|writeFile|rename|mkdtemp)\b/)
        expect(cli).not.toMatch(/\b(?:renderGeneratedEnvironment|projectPersonaOutputs|rename|mkdtemp)\b/)
        expect(command).toContain("from '../environment/generated-application.js'")
        expect(command).not.toMatch(/\b(?:executeProbe|compensate|renderGeneratedEnvironment|projectPersonaOutputs)\b/)
        const application = sources.get('packages/cockpit/src/environment/generated-application.ts')
        expect(application).toContain("from './generated-stack.js'")
        expect(application).toContain("from './data-plane.js'")
        expect(application).not.toContain("from './templates.js'")

        const declarations = mechanismDeclarations(sources)
        expect(declarations.filter(({ id }) => id === 'generated-environment'))
            .toEqual([expect.objectContaining({ module: 'packages/cockpit/src/environment/generated-stack.ts' })])
        expect(declarations.filter(({ id }) => id === 'environment-template-seeding'))
            .toEqual([expect.objectContaining({ module: 'packages/cockpit/src/environment/templates.ts' })])
    })

    it('confines generated Compose artifact issuance and authentication to exact owners', () => {
        expect(generatedComposeAuthorityViolations(cockpitSources())).toEqual([])

        const authority = `
            export interface GeneratedComposeArtifactAuthority { readonly kind: 'generated-compose-artifact-authority' }
            export function authenticateGeneratedRender() {}
            export function projectGeneratedComposeArtifactAuthority() {}
            export function authenticateGeneratedComposeArtifact() {}
            export function renderGeneratedEnvironment() {}
        `
        const allowed = new Map([
            ['packages/cockpit/src/environment/generated-render.ts', authority],
            ['packages/cockpit/src/environment/generated-stack.ts', "import { authenticateGeneratedRender, projectGeneratedComposeArtifactAuthority, renderGeneratedEnvironment, type GeneratedEnvironmentResult } from './generated-render.js'; authenticateGeneratedRender(); projectGeneratedComposeArtifactAuthority(); export { projectGeneratedComposeArtifactAuthority, renderGeneratedEnvironment } from './generated-render.js'; export type { GeneratedComposeArtifactAuthority, GeneratedEnvironmentResult } from './generated-render.js'"],
            ['packages/cockpit/src/environment/generated-compose-authority.ts', "export type { GeneratedComposeArtifactAuthority } from './generated-render.js'"],
            ['packages/cockpit/src/environment/runtime.ts', "import { authenticateGeneratedComposeArtifact, type GeneratedComposeArtifactAuthority } from './generated-render.js'; authenticateGeneratedComposeArtifact()"],
            ['packages/cockpit/src/environment/generated-compose-authority.test.ts', "import { projectGeneratedComposeArtifactAuthority, authenticateGeneratedComposeArtifact } from './generated-render.js'; projectGeneratedComposeArtifactAuthority(); authenticateGeneratedComposeArtifact()"],
        ])
        expect(generatedComposeAuthorityViolations(allowed)).toEqual([])

        for (const [path, source] of [
            ['packages/cockpit/src/environment/rogue.ts', "import { projectGeneratedComposeArtifactAuthority } from './generated-render.js'; projectGeneratedComposeArtifactAuthority()"],
            ['packages/cockpit/src/environment/rogue.test.ts', "import { authenticateGeneratedComposeArtifact } from './generated-render.js'; authenticateGeneratedComposeArtifact()"],
            ['packages/cockpit/src/environment/rogue.ts', "import { authenticateGeneratedRender } from './generated-render.js'; authenticateGeneratedRender()"],
            ['packages/cockpit/src/environment/generated-stack.ts', "export { authenticateGeneratedRender } from './generated-render.js'"],
            ['packages/cockpit/src/environment/rogue.ts', "export { projectGeneratedComposeArtifactAuthority } from './generated-render.js'"],
            ['packages/cockpit/src/environment/runtime.ts', "import * as authority from './generated-render.js'; authority.authenticateGeneratedComposeArtifact()"],
            ['packages/cockpit/src/environment/runtime.ts', "void import('./generated-render.js')"],
            ['packages/cockpit/src/environment/runtime.ts', "const guard = require('./generated-render.js')"],
            ['packages/cockpit/src/environment/generated-stack.ts', "import { projectGeneratedComposeArtifactAuthority } from './generated-render.js'; const issue = projectGeneratedComposeArtifactAuthority"],
            ['packages/cockpit/src/environment/generated-stack.ts', "import { projectGeneratedComposeArtifactAuthority as issue } from './generated-render.js'; issue()"],
            ['packages/cockpit/src/environment/rogue.ts', 'export function issueGeneratedComposeArtifactAuthority() {}'],
        ] as const) {
            const planted = new Map(allowed)
            planted.set(path, source)
            expect(generatedComposeAuthorityViolations(planted)).toContain('ARCH048_GENERATED_COMPOSE_AUTHORITY')
        }

        const duplicate = new Map(allowed)
        duplicate.set('packages/cockpit/src/environment/rogue.ts', 'export interface GeneratedComposeArtifactAuthority {}')
        expect(generatedComposeAuthorityViolations(duplicate)).toContain('ARCH048_GENERATED_COMPOSE_AUTHORITY')
    })

    it('binds compact nested publication to authenticated built-in provenance and per-entry ancestry', () => {
        const sources = productionSources()
        const application = sources.get('packages/cockpit/src/environment/generated-application.ts')
        const transaction = sources.get('packages/cockpit/src/generated-environment/transaction.ts')
        if (!application || !transaction) throw new Error('generated publication owners are missing')
        expect(nestedPublicationAuthorityViolations(application, transaction)).toEqual([])
        for (const [from, to, violation] of [
            ['filter(path => !customSurfacePaths.has(path))', 'filter(() => true)', 'ARCH050_NESTED_PUBLICATION_AUTHORITY_1'],
            ['compactSurfacePaths.has(action.path) ? compactAnchorFor(action.path) : undefined', 'compactAnchorFor(action.path)', 'ARCH050_NESTED_PUBLICATION_AUTHORITY_2'],
            ['parents.size > 1 && groupFrameBounded(anchor!, entries)', 'parents.size >= 1 && groupFrameBounded(anchor!, entries)', 'ARCH050_NESTED_PUBLICATION_AUTHORITY_3'],
            ['preparedEntryChainsValid(entries, requests)', 'true', 'ARCH050_NESTED_PUBLICATION_AUTHORITY_4'],
            ['const status = await lstat(current)', 'const status = await lstat(groupPath)', 'ARCH050_NESTED_PUBLICATION_AUTHORITY_5'],
            ['if (!directory.created) return false', 'if (directory.created) return false', 'ARCH050_NESTED_PUBLICATION_AUTHORITY_6'],
            ['syncDirectory(); verifySourceChain(nested, request.identity);', 'syncDirectory();', 'ARCH050_NESTED_PUBLICATION_AUTHORITY_5'],
            ['const childStatus = fs.lstatSync(name(child.name)); if (!same(childStatus, child)) throw new Error("child-identity");', 'void child;', 'ARCH050_NESTED_PUBLICATION_AUTHORITY_7'],
            ['Buffer.byteLength(JSON.stringify(frame)) + 1 <= MAX_HELPER_FRAME_BYTES', 'false', 'ARCH050_NESTED_PUBLICATION_AUTHORITY_8'],
            ['applied.push(current)', 'void current', 'ARCH050_NESTED_PUBLICATION_AUTHORITY_9'],
            ['const count = groups?.reduce((total, group) => total + group.logicalWeight, 0) ?? 0', 'const count = groups?.length ?? 0', 'ARCH050_NESTED_PUBLICATION_AUTHORITY_10'],
            ["{ version: 1, nonce: '0'.repeat(32), action: 'commit-batch', identity, groups: [group] },", "{ version: 1, nonce: '0'.repeat(32), action: 'commit', identity, entries: receiptEntries },", 'ARCH050_NESTED_PUBLICATION_AUTHORITY_8'],
            ["runPublicationBatches('verify-batch', prepared.root, transactionRootIdentity, applied,", "runPublicationBatches('publish-batch', prepared.root, transactionRootIdentity, applied,", 'ARCH050_NESTED_PUBLICATION_AUTHORITY_11'],
            ["runPublicationBatches('commit-batch', prepared.root, transactionRootIdentity, applied,\n            node, adapters, nextForwardDeadline).catch(() => false)", "runPublicationBatches('commit-batch', prepared.root, transactionRootIdentity, applied,\n            node, adapters, nextForwardDeadline)", 'ARCH050_NESTED_PUBLICATION_AUTHORITY_11'],
            ['if (!finalized || forwardCallsRemaining !== 0)', 'if (!finalized)', 'ARCH050_NESTED_PUBLICATION_AUTHORITY_11'],
            ['generated bytes were published but retained backups could not be safely finalized; recover retained local backups before retrying', 'generated finalization failed', 'ARCH050_NESTED_PUBLICATION_AUTHORITY_11'],
        ] as const) {
            const applicationOwned = ['ARCH050_NESTED_PUBLICATION_AUTHORITY_1', 'ARCH050_NESTED_PUBLICATION_AUTHORITY_2'].includes(violation)
            const source = applicationOwned ? application : transaction
            const replacement = violation === 'ARCH050_NESTED_PUBLICATION_AUTHORITY_10'
                ? source.replaceAll(from, to) : source.replace(from, to)
            expect(replacement, from).not.toBe(source)
            expect(nestedPublicationAuthorityViolations(applicationOwned ? replacement : application,
                applicationOwned ? transaction : replacement), from).toContain(violation)
        }
    })

    it('rejects private publication declarations duplicated across both owners', () => {
        const sources = productionSources()
        const application = sources.get('packages/cockpit/src/environment/generated-application.ts')
        const transaction = sources.get('packages/cockpit/src/generated-environment/transaction.ts')
        if (!application || !transaction) throw new Error('generated publication owners are missing')
        expect(nestedPublicationAuthorityViolations(application, transaction)).toEqual([])
        expect(nestedPublicationAuthorityViolations(`${application}\nfunction groupMutations() {}`, transaction))
            .toContain('ARCH050_NESTED_PUBLICATION_AUTHORITY_3')
        expect(nestedPublicationAuthorityViolations(application, `${transaction}\nfunction prepareSurfaces() {}`))
            .toContain('ARCH050_NESTED_PUBLICATION_AUTHORITY_1')
    })

    it('keeps check read-only and filesystem publication behind sync', () => {
        const sources = productionSources()
        const application = sources.get('packages/cockpit/src/environment/generated-application.ts')
        const source = sources.get('packages/cockpit/src/generated-environment/transaction.ts')
        if (!application || !source) throw new Error('generated publication owners are missing')
        const readGraph = (application: string, transaction: string): ts.SourceFile =>
            ts.createSourceFile('publication-read-graph.ts', `${application}\n${transaction}`, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
        const sourceFile = readGraph(application, source)
        expect(publicationBatchAuthorityViolations(source)).toEqual([])
        for (const [from, to] of [
            ["readonly action: 'validate-batch' | 'publish-batch' | 'verify-batch' | 'commit-batch'", "readonly action: string"],
            ["helperStep(node, root, 'generated-environment', request, [], deadline)", "helperStep(node, groups[offset]!.path, groups[offset]!.parent, request, [], deadline)"],
            ['identity: group.identity,\n            chain: Object.freeze(chain),', 'identity: group.identity,\n            chain: Object.freeze([]),'],
            ['identity: group.identity,', 'identity: rootIdentity,'],
            ['entries: group.entries,', 'entries: Object.freeze([]),'],
            ['const expected = request.groups[index]', 'const expected = request.groups.find(group => group.nonce === row?.nonce)'],
            ['Buffer.byteLength(JSON.stringify(candidate)) > MAX_HELPER_FRAME_BYTES', 'false'],
            ['const MAX_PUBLICATION_BATCH_GROUPS = 8', 'const MAX_PUBLICATION_BATCH_GROUPS = 9'],
            ['const transactionRootIdentity = prepared.rootIdentity', 'const transactionRootIdentity = Object.freeze({ dev: transactionRoot.dev, ino: transactionRoot.ino })'],
            ['request.groups.length < 1 || request.groups.length > 8', 'request.groups.length < 1'],
            ['const chain = walkExpected(group.chain);', 'const chain = [];'],
            ['if (!same(final, group.identity)) throw new Error("group-identity");', 'void final;'],
            ['if (request.action === "publish-batch") publishEntries(group.entries);\n      else if (request.action === "validate-batch") validateEntries(group.entries);\n      else verifyEntries(group.entries);\n      verifySourceChain(chain);', 'if (request.action === "publish-batch") publishEntries(group.entries);\n      else if (request.action === "validate-batch") validateEntries(group.entries);\n      else verifyEntries(group.entries);\n      void chain;'],
            ['groups.push({ nonce: group.nonce, parent: group.parent, kind: "complete" });', 'groups.push({ nonce: group.nonce, parent: ".", kind: "complete" });'],
            ["runPublicationBatches('publish-batch', prepared.root, transactionRootIdentity, applied,", "runPublicationBatches('verify-batch', prepared.root, transactionRootIdentity, applied,"],
            ['if (request.action === "commit-batch") {', 'if (false) {'],
            ['verifyEntries([entry], group.identity);', 'void entry;'],
            ['if (entry.backup !== null) fs.unlinkSync(name(entry.backup));', 'if (entry.backup !== null) void name(entry.backup);'],
            ['syncDirectory(); verifySourceChain(nested, group.identity);', 'syncDirectory();'],
            ['syncDirectory(); verifySourceChain(nested, group.identity);', 'verifySourceChain(nested, group.identity);'],
            ["action: 'publish' | 'verify' | 'rollback')", "action: 'publish' | 'verify' | 'rollback' | 'commit')"],
        ] as const) {
            const replacement = source.replace(from, to)
            expect(replacement).not.toBe(source)
            expect(publicationBatchAuthorityViolations(replacement).length, from).toBeGreaterThan(0)
        }
        const reachableMutations = (candidate: ts.SourceFile, entry: string): string[] => {
            const functions = new Map<string, ts.FunctionLikeDeclaration>()
            let constantsShadowed = false
            let openShadowed = false
            const customWorker = candidate.statements.flatMap((statement) => ts.isVariableStatement(statement)
                ? [...statement.declarationList.declarations] : []).find((declaration) =>
                ts.isIdentifier(declaration.name) && declaration.name.text === 'CUSTOM_SURFACE_WORKER')?.initializer
            const customWorkerText = customWorker?.getText(candidate)
            const exactCustomWorker = customWorkerText !== undefined
                && (customWorkerText.match(/process\.argv\[2\]/g) ?? []).length === 1
                && (customWorkerText.match(/fs\.readFileSync\(/g) ?? []).length === 1
                && customWorkerText.includes('const source = fs.readFileSync(process.argv[2]);')
                && customWorkerText.includes("if (digest(source) !== request.sourceSha256) throw new Error('module changed');")
                && customWorkerText.includes("await import('data:text/javascript;base64,' + source.toString('base64'))")
                && !customWorkerText.includes('request.modulePath') && !customWorkerText.includes('pathToFileURL')
            const scratchNames = new Set(['mkdtemp', 'rm', 'join', 'tmpdir', 'realpath', 'writeFile'])
            const scratchShadowed = new Set<string>()
            const imported = (name: string, module: string): boolean => candidate.statements.some((statement) =>
                ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)
                && statement.moduleSpecifier.text === module && statement.importClause && !statement.importClause.isTypeOnly
                && statement.importClause.namedBindings && ts.isNamedImports(statement.importClause.namedBindings)
                && statement.importClause.namedBindings.elements.some((element) => !element.isTypeOnly
                    && element.name.text === name && (element.propertyName ?? element.name).text === name))
            const collect = (node: ts.Node): void => {
                if ((ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node)
                    || ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node))
                    && node.name && ts.isIdentifier(node.name) && scratchNames.has(node.name.text)) scratchShadowed.add(node.name.text)
                if ((ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node)
                    || ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node))
                    && node.name && ts.isIdentifier(node.name) && node.name.text === 'constants') constantsShadowed = true
                if ((ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node)
                    || ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node))
                    && node.name && ts.isIdentifier(node.name) && node.name.text === 'open') openShadowed = true
                if (ts.isFunctionDeclaration(node) && node.name?.text && node.body) functions.set(node.name.text, node)
                ts.forEachChild(node, collect)
            }
            collect(candidate)
            const pending = [entry]
            const visited = new Set<string>()
            const mutations = new Set<string>()
            while (pending.length > 0) {
                const name = pending.pop()!
                if (visited.has(name)) continue
                visited.add(name)
                const declaration = functions.get(name)
                if (!declaration?.body) throw new Error(`${name} is missing`)
                const directoryDeclarations: ts.VariableDeclaration[] = []
                const directoryAssignments: ts.BinaryExpression[] = []
                const locals = new Map<string, ts.VariableDeclaration>()
                const reassigned = new Set<string>()
                const captureDirectory = (node: ts.Node): void => {
                    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
                        if (locals.has(node.name.text)) reassigned.add(node.name.text)
                        locals.set(node.name.text, node)
                        if (node.name.text === 'directory' || node.name.text === 'scratch') directoryDeclarations.push(node)
                    }
                    if (ts.isBinaryExpression(node)
                        && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
                        if (ts.isIdentifier(node.left)) {
                            reassigned.add(node.left.text)
                            if (node.left.text === 'directory' || node.left.text === 'scratch') directoryAssignments.push(node)
                        } else if (ts.isPropertyAccessExpression(node.left) && ts.isIdentifier(node.left.expression)) {
                            reassigned.add(node.left.expression.text)
                        } else if (ts.isElementAccessExpression(node.left) && ts.isIdentifier(node.left.expression)) {
                            reassigned.add(node.left.expression.text)
                        }
                    }
                    ts.forEachChild(node, captureDirectory)
                }
                captureDirectory(declaration.body)
                const helperRequests = new Set<string>()
                const helperCalls: ts.CallExpression[] = []
                let actionUnmodified = true
                let helperUnaliased = true
                const property = (object: ts.ObjectLiteralExpression, key: string): ts.Expression | undefined => {
                    if (object.properties.some(ts.isSpreadAssignment)) return undefined
                    const matches = object.properties.filter(row => row.name && ts.isIdentifier(row.name) && row.name.text === key)
                    if (matches.length !== 1) return undefined
                    const row = matches[0]!
                    return ts.isPropertyAssignment(row) ? row.initializer : ts.isShorthandPropertyAssignment(row) ? row.name : undefined
                }
                const initializer = (key: string): ts.Expression | undefined => {
                    const local = locals.get(key)
                    return local && ts.isVariableDeclarationList(local.parent) && (local.parent.flags & ts.NodeFlags.Const) !== 0
                        && !reassigned.has(key) ? local.initializer : undefined
                }
                const compact = (node: ts.Node | undefined): string | undefined => node?.getText(candidate).replace(/\s+/g, '')
                const batchEntries = initializer('entries')
                const batchMap = batchEntries && ts.isCallExpression(batchEntries)
                    && batchEntries.expression.getText(candidate) === 'resolved.map' && batchEntries.arguments.length === 1
                    && ts.isArrowFunction(batchEntries.arguments[0]!) ? batchEntries.arguments[0] : undefined
                const batchRow = batchMap && ts.isCallExpression(batchMap.body)
                    && batchMap.body.expression.getText(candidate) === 'Object.freeze' && batchMap.body.arguments.length === 1
                    && ts.isObjectLiteralExpression(batchMap.body.arguments[0]!) ? batchMap.body.arguments[0] : undefined
                const batchType = candidate.statements.find(statement => ts.isInterfaceDeclaration(statement)
                    && statement.name.text === 'AnchoredBatchReadRequest')
                const boundedBatch = name === 'readAnchoredBatch' && batchRow
                    && compact(property(batchRow, 'output')) === 'join(directory!,`source-${index}`)'
                    && compact(property(batchRow, 'action')) === 'request!.action'
                    && compact(property(batchRow, 'maxBytes')) === 'request!.maxBytes'
                    && compact(property(batchRow, 'segments')) === 'request!.parts.slice(0,-1)'
                    && compact(property(batchRow, 'name')) === 'request!.parts.at(-1)'
                    && !reassigned.has('entries') && !reassigned.has('resolved')
                    && batchType && ts.isInterfaceDeclaration(batchType)
                    && batchType.members.some(member => ts.isPropertySignature(member)
                        && member.name.getText(candidate) === 'action'
                        && compact(member.type) === "'read-file'|'read-persona'|'read-entry'")
                    && declaration.body.getText(candidate).includes('requests.length > MAX_AUTHENTICATED_READ_BATCH')
                    && declaration.body.getText(candidate).includes('requests.reduce((total, request) => total + request.maxBytes, 0) > MAX_AUTHENTICATED_READ_BATCH_BYTES')
                    && declaration.body.getText(candidate).includes('constants.O_NOFOLLOW === undefined')
                    && declaration.body.getText(candidate).includes('readRoot.dev !== rootStatus.dev || readRoot.ino !== rootStatus.ino')
                    && declaration.body.getText(candidate).includes('sha256(bytes) !== row.sha256')
                    && initializer('receiptOutput')?.getText(candidate) === "join(directory, 'receipt')"
                    && declaration.body.getText(candidate).includes('sha256(receiptBytes) !== summary.receiptSha256')
                    && declaration.body.getText(candidate).includes('receiptBytes.length !== summary.receiptBytes')
                    && declaration.body.getText(candidate).includes("new TextDecoder('utf-8', { fatal: true }).decode(receiptBytes)")
                    && declaration.body.getText(candidate).includes("JSON.stringify(receiptValue) + '\\n' !== receiptText")
                    && declaration.body.getText(candidate).includes('(summary.receiptBytes as number) > MAX_AUTHENTICATED_READ_BATCH_RECEIPT_BYTES')
                const captureHelper = (node: ts.Node): void => {
                    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer
                        && ts.isVariableDeclarationList(node.parent) && (node.parent.flags & ts.NodeFlags.Const) !== 0
                        && ts.isCallExpression(node.initializer) && node.initializer.expression.getText(candidate) === 'Object.freeze'
                        && node.initializer.arguments.length === 1 && ts.isObjectLiteralExpression(node.initializer.arguments[0]!)) {
                        const properties = node.initializer.arguments[0]!.properties.filter((property) => property.name?.getText(candidate) === 'action')
                        const request = node.initializer.arguments[0]!
                        const output = property(request, 'output')
                        const privateOutput = output && ts.isIdentifier(output) && output.text === 'output'
                            && initializer('output')?.getText(candidate) === "join(directory, 'source')"
                        const fixedEntry = name === 'readAnchoredEntry' && properties.length === 1 && ts.isPropertyAssignment(properties[0]!)
                            && ts.isStringLiteral(properties[0]!.initializer) && properties[0]!.initializer.text === 'read-entry'
                        const fixedBatch = boundedBatch && properties.length === 1 && ts.isPropertyAssignment(properties[0]!)
                            && ts.isStringLiteral(properties[0]!.initializer) && properties[0]!.initializer.text === 'read-batch'
                            && compact(property(request, 'entries')) === 'Object.freeze(entries)'
                            && compact(property(request, 'receiptOutput')) === 'receiptOutput'
                        if (properties.length === 1 && !reassigned.has(node.name.text)
                            && (fixedBatch || privateOutput && (fixedEntry || ts.isShorthandPropertyAssignment(properties[0]!)
                                && properties[0]!.name.text === 'action' && !properties[0]!.objectAssignmentInitializer))) helperRequests.add(node.name.text)
                    }
                    if (ts.isIdentifier(node) && node.text === 'action') {
                        const parent = node.parent
                        const property = ts.isPropertyAccessExpression(parent) && parent.name === node
                            || ts.isPropertyAssignment(parent) && parent.name === node
                                && (ts.isStringLiteral(parent.initializer) && (parent.initializer.text === 'read-entry'
                                    || name === 'readAnchoredBatch' && parent.initializer.text === 'read-batch')
                                    || name === 'readAnchoredBatch' && compact(parent.initializer) === 'request!.action')
                        const comparison = ts.isBinaryExpression(parent)
                            && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(parent.operatorToken.kind)
                        const request = ts.isShorthandPropertyAssignment(parent) && !parent.objectAssignmentInitializer
                            && ts.isObjectLiteralExpression(parent.parent) && ts.isCallExpression(parent.parent.parent)
                            && parent.parent.parent.expression.getText(candidate) === 'Object.freeze'
                            && parent.parent.parent.arguments.length === 1
                            && ts.isVariableDeclaration(parent.parent.parent.parent)
                            && ts.isVariableDeclarationList(parent.parent.parent.parent.parent)
                            && (parent.parent.parent.parent.parent.flags & ts.NodeFlags.Const) !== 0
                        if (!property && !comparison && !request) actionUnmodified = false
                    }
                    if (ts.isIdentifier(node) && node.text === 'helperStep'
                        && !(ts.isCallExpression(node.parent) && node.parent.expression === node)) helperUnaliased = false
                    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'helperStep') helperCalls.push(node)
                    ts.forEachChild(node, captureHelper)
                }
                captureHelper(declaration.body)
                const readHelpersOnly = helperCalls.every((call) => call.arguments[3] !== undefined && ts.isIdentifier(call.arguments[3]!) && helperRequests.has(call.arguments[3]!.text))
                const action = declaration.parameters.find((parameter) => ts.isIdentifier(parameter.name) && parameter.name.text === 'action')
                const privateRead = (name === 'readAnchoredFile' || name === 'readAnchoredEntry' || name === 'readAnchoredBatch')
                    && scratchShadowed.size === 0 && readHelpersOnly && actionUnmodified && helperUnaliased
                    && imported('mkdtemp', 'node:fs/promises') && imported('rm', 'node:fs/promises')
                    && imported('join', 'node:path') && imported('tmpdir', 'node:os')
                    && (name === 'readAnchoredEntry' || boundedBatch || action?.type?.getText(candidate) === "'read-file' | 'read-persona'"
                        && action.initializer?.getText(candidate) === "'read-file'")
                    && directoryDeclarations.length === 1 && !directoryDeclarations[0]!.initializer
                    && directoryAssignments.length === 1 && directoryAssignments[0]!.operatorToken.kind === ts.SyntaxKind.EqualsToken
                    && directoryAssignments[0]!.right.getText(candidate) === (name === 'readAnchoredEntry'
                        ? "await mkdtemp(join(tmpdir(), 'cockpit-generated-entry-'))" : name === 'readAnchoredBatch'
                            ? "await mkdtemp(join(tmpdir(), 'cockpit-generated-read-batch-'))" : "await mkdtemp(join(tmpdir(), 'cockpit-generated-read-'))")
                const stepInitializer = initializer('step')
                const stepObject = stepInitializer && ts.isCallExpression(stepInitializer)
                    && stepInitializer.expression.getText(candidate) === 'snapshotExecutionStep' && stepInitializer.arguments.length === 1
                    && ts.isObjectLiteralExpression(stepInitializer.arguments[0]!) ? stepInitializer.arguments[0] : undefined
                const customRequest = initializer('request')
                const customArgv = stepObject && property(stepObject, 'argv')
                const consumed = stepObject && property(stepObject, 'consumedFiles')
                const authenticatedInputs = consumed && ts.isArrayLiteralExpression(consumed) && consumed.elements.length === 2
                    && consumed.elements.every(ts.isObjectLiteralExpression) && consumed.elements.every((row, index) => {
                        if (!ts.isObjectLiteralExpression(row)) return false
                        return property(row, 'path')?.getText(candidate) === (index === 0 ? 'prepared.node.canonicalPath' : 'absoluteModule')
                            && property(row, 'sha256')?.getText(candidate) === (index === 0 ? 'prepared.node.sha256' : 'moduleRead.sha256')
                            && compact(property(row, 'argvIndexes')) === (index === 0 ? '[0]' : '[3,9]')
                            && property(row, 'executable')?.getText(candidate) === (index === 0 ? 'true' : 'false')
                    })
                let authenticatedCustomExecute = false
                let customUnaliased = true
                const captureCustomDispatch = (node: ts.Node): void => {
                    if (ts.isIdentifier(node) && ['snapshotExecutionStep', 'authenticatedExecutionOutcome'].includes(node.text)
                        && !(ts.isCallExpression(node.parent) && node.parent.expression === node)) customUnaliased = false
                    if (ts.isPropertyAccessExpression(node) && node.expression.getText(candidate) === 'adapters' && node.name.text === 'execute') {
                        const call = node.parent
                        const awaited = call.parent
                        const authentication = awaited.parent
                        const authenticated = ts.isCallExpression(call) && call.expression === node && call.arguments.length === 1
                            && call.arguments[0]?.getText(candidate) === 'step' && ts.isAwaitExpression(awaited)
                            && ts.isCallExpression(authentication) && authentication.expression.getText(candidate) === 'authenticatedExecutionOutcome'
                            && authentication.arguments.length === 2 && authentication.arguments[0] === awaited
                            && authentication.arguments[1]?.getText(candidate) === 'step'
                        authenticatedCustomExecute = authenticatedCustomExecute || authenticated
                        if (!authenticated) customUnaliased = false
                    }
                    ts.forEachChild(node, captureCustomDispatch)
                }
                captureCustomDispatch(declaration.body)
                const privateCustom = name === 'executeCustomCapability' && scratchShadowed.size === 0
                    && imported('mkdtemp', 'node:fs/promises') && imported('rm', 'node:fs/promises')
                    && imported('realpath', 'node:fs/promises') && imported('join', 'node:path')
                    && imported('tmpdir', 'node:os')
                    && directoryDeclarations.length === 1 && directoryDeclarations[0]!.name.getText(candidate) === 'scratch'
                    && !directoryDeclarations[0]!.initializer && directoryAssignments.length === 1
                    && compact(directoryAssignments[0]!.right) === "awaitrealpath(awaitmkdtemp(join(tmpdir(),'cockpit-custom-surface-')))"
                    && compact(initializer('permissionFlag')) === "process.allowedNodeEnvironmentFlags.has('--permission')?'--permission':process.allowedNodeEnvironmentFlags.has('--experimental-permission')?'--experimental-permission':undefined"
                    && ts.isBlock(declaration.body) && declaration.body.statements.some(statement => ts.isIfStatement(statement)
                        && compact(statement.expression) === "!permissionFlag||!process.allowedNodeEnvironmentFlags.has('--allow-fs-read')||!process.allowedNodeEnvironmentFlags.has('--allow-fs-write')"
                        && ts.isReturnStatement(statement.thenStatement) && statement.thenStatement.expression?.getText(candidate) === 'undefined')
                    && declaration.body.statements.some(statement => ts.isTryStatement(statement)
                        && statement.tryBlock.statements.some(child => ts.isIfStatement(child)
                            && compact(child.expression) === "!absoluteModule||[scratch,absoluteModule].some(path=>path.includes('*'))"
                            && ts.isReturnStatement(child.thenStatement) && child.thenStatement.expression?.getText(candidate) === 'undefined'))
                    && customRequest && ts.isObjectLiteralExpression(customRequest) && property(customRequest, 'output')?.getText(candidate) === 'scratch'
                    && property(customRequest, 'modulePath') === undefined
                    && stepObject && property(stepObject, 'cwd')?.getText(candidate) === 'scratch'
                    && compact(property(stepObject, 'env')) === '{}'
                    && customArgv && ts.isArrayLiteralExpression(customArgv)
                    && customArgv.elements.map(element => compact(element)).join('|') === [
                        'prepared.node.canonicalPath', 'permissionFlag', "'--allow-fs-read'", 'absoluteModule',
                        '`--allow-fs-read=${scratch}`', '`--allow-fs-write=${scratch}`', "'-e'", 'CUSTOM_SURFACE_WORKER', 'raw', 'absoluteModule',
                    ].join('|')
                    && initializer('raw')?.getText(candidate) === 'JSON.stringify(request)'
                    && compact(initializer('absoluteModule')) === 'confined(prepared.root,capability.mechanism.module)'
                    && authenticatedInputs && exactCustomWorker
                    && authenticatedCustomExecute && customUnaliased
                const nativeProjection = initializer('projection')
                const nativeProjectionCall = nativeProjection && ts.isAwaitExpression(nativeProjection)
                    && ts.isCallExpression(nativeProjection.expression)
                    && nativeProjection.expression.expression.getText(candidate) === 'projectNativeHooks'
                    && nativeProjection.expression.arguments.length === 1
                    && ts.isObjectLiteralExpression(nativeProjection.expression.arguments[0]!)
                    ? nativeProjection.expression.arguments[0] : undefined
                const nativeBudget = nativeProjectionCall && property(nativeProjectionCall, 'budget')
                const nativeMeasurement = nativeBudget && ts.isObjectLiteralExpression(nativeBudget)
                    ? property(nativeBudget, 'prepareMeasurement') : undefined
                const nativePath = initializer('path')
                const nativeConsumed = stepObject && property(stepObject, 'consumedFiles')
                const nativeOuterTry = ts.isBlock(declaration.body)
                    ? declaration.body.statements.find((statement): statement is ts.TryStatement =>
                        ts.isTryStatement(statement) && statement.finallyBlock !== undefined)
                    : undefined
                const nativeInitialGuard = nativeOuterTry?.tryBlock.statements.find((statement): statement is ts.IfStatement =>
                    ts.isIfStatement(statement) && compact(statement.expression) === '!status.isDirectory()||status.isSymbolicLink()')
                const nativeIdentityAssignments: ts.BinaryExpression[] = []
                if (nativeOuterTry) {
                    const collectIdentityAssignments = (node: ts.Node): void => {
                        if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
                            && ts.isIdentifier(node.left) && node.left.text === 'scratchIdentity') nativeIdentityAssignments.push(node)
                        ts.forEachChild(node, collectIdentityAssignments)
                    }
                    collectIdentityAssignments(nativeOuterTry.tryBlock)
                }
                const nativeScratchGuard = nativeOuterTry?.finallyBlock?.statements.length === 1
                    && ts.isIfStatement(nativeOuterTry.finallyBlock.statements[0]!)
                    ? nativeOuterTry.finallyBlock.statements[0] : undefined
                const nativeCleanupTry = nativeScratchGuard && compact(nativeScratchGuard.expression) === 'scratch&&scratchIdentity'
                    && ts.isBlock(nativeScratchGuard.thenStatement) && nativeScratchGuard.thenStatement.statements.length === 1
                    && ts.isTryStatement(nativeScratchGuard.thenStatement.statements[0]!)
                    ? nativeScratchGuard.thenStatement.statements[0] : undefined
                const nativeCleanupCurrent = nativeCleanupTry?.tryBlock.statements[0]
                const nativeCleanupGuard = nativeCleanupTry?.tryBlock.statements[1]
                const exactNativeCleanup = nativeCleanupTry?.tryBlock.statements.length === 2
                    && ts.isVariableStatement(nativeCleanupCurrent!)
                    && compact(nativeCleanupCurrent) === 'constcurrent=awaitlstat(scratch)'
                    && ts.isIfStatement(nativeCleanupGuard!)
                    && compact(nativeCleanupGuard.expression) === 'current.isDirectory()&&!current.isSymbolicLink()&&current.dev===scratchIdentity.dev&&current.ino===scratchIdentity.ino'
                    && ts.isBlock(nativeCleanupGuard.thenStatement) && nativeCleanupGuard.thenStatement.statements.length === 1
                    && compact(nativeCleanupGuard.thenStatement.statements[0]) === 'awaitrm(scratch,{recursive:true,force:true})'
                    && compact(nativeCleanupTry.catchClause) === "catch(error){if((errorasNodeJS.ErrnoException).code!=='ENOENT')throwerror}"
                const privateNativeHook = name === 'projectExplicitNativeHooks' && scratchShadowed.size === 0
                    && imported('mkdtemp', 'node:fs/promises') && imported('rm', 'node:fs/promises')
                    && imported('realpath', 'node:fs/promises') && imported('writeFile', 'node:fs/promises')
                    && imported('join', 'node:path') && imported('tmpdir', 'node:os')
                    && imported('projectNativeHooks', '../testing/hooks.js')
                    && imported('snapshotExecutionStep', './contract.js')
                    && imported('authenticatedExecutionOutcome', '../environment-exec/execute.js')
                    && directoryDeclarations.length === 1 && directoryDeclarations[0]!.name.getText(candidate) === 'scratch'
                    && !directoryDeclarations[0]!.initializer && directoryAssignments.length === 1
                    && compact(directoryAssignments[0]!.right) === "awaitrealpath(awaitmkdtemp(join(tmpdir(),'cockpit-native-hook-cost-')))"
                    && compact(initializer('status')) === 'awaitlstat(scratch)'
                    && nativeInitialGuard && ts.isReturnStatement(nativeInitialGuard.thenStatement)
                    && nativeInitialGuard.thenStatement.expression?.getText(candidate) === 'undefined'
                    && nativeIdentityAssignments.length === 1
                    && compact(nativeIdentityAssignments[0]!.right) === 'Object.freeze({dev:status.dev,ino:status.ino})'
                    && nativeProjectionCall && property(nativeProjectionCall, 'install')?.getText(candidate) === "'explicit-native'"
                    && property(nativeProjectionCall, 'cockpitId')?.getText(candidate) === 'prepared.cockpitId'
                    && property(nativeProjectionCall, 'harnesses')?.getText(candidate) === 'harnesses'
                    && nativeBudget && ts.isObjectLiteralExpression(nativeBudget)
                    && property(nativeBudget, 'policy')?.getText(candidate) === 'policy'
                    && nativeMeasurement && ts.isArrowFunction(nativeMeasurement)
                    && nativeMeasurement.modifiers?.some(({ kind }) => kind === ts.SyntaxKind.AsyncKeyword)
                    && nativeMeasurement.parameters.length === 1 && nativeMeasurement.parameters[0]!.name.getText(candidate) === 'entry'
                    && nativePath?.getText(candidate) === "join(scratch!, 'pre-push')"
                    && declaration.body.getText(candidate).includes("await writeFile(path, entry.bytes, { flag: 'wx', mode: 0o700 })")
                    && stepObject && property(stepObject, 'id')?.getText(candidate) === "'native-hook-cost'"
                    && property(stepObject, 'cwd')?.getText(candidate) === 'prepared.root'
                    && compact(property(stepObject, 'env')) === '{PATH:dirname(git.value.canonicalPath)}'
                    && compact(property(stepObject, 'argv')) === "[shell.value.canonicalPath,'-c',NATIVE_HOOK_COST_SCRIPT,'native-hook-cost',path,revisions[0]!,revisions[1]!]"
                    && nativeConsumed && ts.isArrayLiteralExpression(nativeConsumed) && nativeConsumed.elements.length === 2
                    && nativeConsumed.elements.every(ts.isObjectLiteralExpression)
                    && compact(nativeConsumed.elements[0]) === '{path:shell.value.canonicalPath,sha256:shell.value.sha256,maxBytes:MAX_EXECUTABLE_BYTES,argvIndexes:[0],executable:true,executionMode:shell.value.executionMode}'
                    && compact(nativeConsumed.elements[1]) === '{path,sha256:entry.sha256,maxBytes:Buffer.byteLength(entry.bytes),argvIndexes:[4],executable:false}'
                    && compact(property(stepObject, 'filesystemChecks')) === "[{path:prepared.root,expected:'directory'},{path:scratch!,expected:'directory'}]"
                    && declaration.body.getText(candidate).includes('const revisionOutcome = authenticatedExecutionOutcome(await adapters.execute(revisionStep), revisionStep)')
                    && exactNativeCleanup
                const privateCapture = privateRead || privateCustom || privateNativeHook
                const inspect = (node: ts.Node): void => {
                    if (ts.isIdentifier(node) && node.text === 'helperStep'
                        && !(ts.isCallExpression(node.parent) && node.parent.expression === node)) mutations.add('helperStep')
                    if (ts.isCallExpression(node)) {
                        const called = ts.isIdentifier(node.expression)
                            ? node.expression.text
                            : ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : undefined
                        const readOnlyOpen = !constantsShadowed && !openShadowed && ts.isIdentifier(node.expression)
                            && called === 'open' && node.arguments.length === 2
                            && candidate.statements.some((statement) => ts.isImportDeclaration(statement)
                                && ts.isStringLiteral(statement.moduleSpecifier) && statement.moduleSpecifier.text === 'node:fs/promises'
                                && statement.importClause && !statement.importClause.isTypeOnly
                                && statement.importClause.namedBindings && ts.isNamedImports(statement.importClause.namedBindings)
                                && statement.importClause.namedBindings.elements.some((element) => !element.isTypeOnly
                                    && element.name.text === 'open' && (element.propertyName ?? element.name).text === 'open'))
                            && ['constants.O_RDONLY | constants.O_NOFOLLOW', 'constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW']
                                .includes(node.arguments[1]?.getText(candidate) ?? '')
                            && candidate.statements.some((statement) => ts.isImportDeclaration(statement)
                                && ts.isStringLiteral(statement.moduleSpecifier) && statement.moduleSpecifier.text === 'node:fs'
                                && statement.importClause && !statement.importClause.isTypeOnly
                                && statement.importClause.namedBindings && ts.isNamedImports(statement.importClause.namedBindings)
                                && statement.importClause.namedBindings.elements.some((element) => !element.isTypeOnly
                                    && element.name.text === 'constants' && (element.propertyName ?? element.name).text === 'constants'))
                        const scratchCall = privateCapture && ts.isIdentifier(node.expression)
                            && ((called === 'mkdtemp' && node.arguments.length === 1
                                && node.arguments[0]?.getText(candidate) === (privateNativeHook ? "join(tmpdir(), 'cockpit-native-hook-cost-')"
                                    : privateCustom ? "join(tmpdir(), 'cockpit-custom-surface-')"
                                    : name === 'readAnchoredEntry' ? "join(tmpdir(), 'cockpit-generated-entry-')"
                                        : name === 'readAnchoredBatch' ? "join(tmpdir(), 'cockpit-generated-read-batch-')" : "join(tmpdir(), 'cockpit-generated-read-')"))
                                || (called === 'rm' && node.arguments.length === 2
                                    && node.arguments[0]?.getText(candidate) === (privateCustom || privateNativeHook ? 'scratch' : 'directory')
                                    && node.arguments[1]?.getText(candidate) === '{ recursive: true, force: true }')
                                || (privateNativeHook && called === 'writeFile' && node.arguments.length === 3
                                    && node.arguments[0]?.getText(candidate) === 'path'
                                    && node.arguments[1]?.getText(candidate) === 'entry.bytes'
                                    && node.arguments[2]?.getText(candidate) === "{ flag: 'wx', mode: 0o700 }"))
                        if (called && /^(?:rename|mkdir|mkdtemp|open|rm|rmdir|unlink|writeFile)$/.test(called)
                            && !readOnlyOpen && !scratchCall) mutations.add(called)
                        if (called === 'helperStep' && !privateCapture) mutations.add(called)
                        if (name === 'executeCustomCapability' && called === 'execute' && !privateCustom) mutations.add('execute')
                        if (called && functions.has(called) && !visited.has(called)) pending.push(called)
                    }
                    ts.forEachChild(node, inspect)
                }
                inspect(declaration.body)
            }
            return [...mutations].sort()
        }

        const scratchSource = `
            import { mkdtemp, rm } from 'node:fs/promises'
            import { tmpdir } from 'node:os'
            import { join } from 'node:path'
            async function readAnchoredFile(action: 'read-file' | 'read-persona' = 'read-file') {
                let directory: string
                directory = await mkdtemp(join(tmpdir(), 'cockpit-generated-read-'))
                try { return 'bounded read' }
                finally { await rm(directory, { recursive: true, force: true }) }
            }
            async function check() { return readAnchoredFile() }
        `
        const scratch = ts.createSourceFile('scratch.ts', scratchSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
        expect(reachableMutations(scratch, 'check')).toEqual([])
        for (const replacement of [
            scratchSource.replace('rm(directory,', "rm('consumer-output',"),
            scratchSource.replace("try { return 'bounded read' }", "directory = 'consumer-output'; try { return 'bounded read' }"),
            scratchSource.replace("join(tmpdir(), 'cockpit-generated-read-')", "join(root, 'consumer-output')"),
            scratchSource.replace("from 'node:fs/promises'", "from './foreign.js'"),
            scratchSource.replace("async function check()", "function mkdtemp() {} async function check()"),
            scratchSource.replace("action: 'read-file' | 'read-persona' = 'read-file'", "action: 'apply' = 'apply'"),
            scratchSource.replace("try { return 'bounded read' }", "const request = Object.freeze({ action: 'publish' }); helperStep(node, root, '.', request); try { return 'bounded read' }"),
            scratchSource.replace("try { return 'bounded read' }", "helperStep(); try { return 'bounded read' }"),
            scratchSource.replace("try { return 'bounded read' }", "action = ('publish' as never); const request = Object.freeze({ action }); helperStep(node, root, '.', request); try { return 'bounded read' }"),
            scratchSource.replace("try { return 'bounded read' }", "const dispatch = helperStep; dispatch(node, root, '.', { action: 'publish' }); try { return 'bounded read' }"),
            scratchSource.replace("try { return 'bounded read' }", "; ({ action } = ({ 'action': 'publish' } as never)); const request = Object.freeze({ action }); helperStep(node, root, '.', request); try { return 'bounded read' }"),
        ]) {
            const unsafe = ts.createSourceFile('unsafe.ts', replacement, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
            expect(reachableMutations(unsafe, 'check').length).toBeGreaterThan(0)
        }

        expect(application).toMatch(/function syncGeneratedEnvironment[\s\S]*applyGeneratedEnvironmentRepair/)
        expect(application).toMatch(/function applyGeneratedEnvironmentRepair[\s\S]*runPublicationPlan\(record.plan,/)
        expect(source).toMatch(/function runPublicationPlan[\s\S]*runPlan\(plan, adapters\)/)
        expect(source).toMatch(/function runPlan[\s\S]*applyPrepared\(record, adapters\)/)
        expect(reachableMutations(sourceFile, 'checkGeneratedEnvironment')).toEqual([])

        const batchSource = [
                ["output: join(directory!, `source-${index}`)", "output: join(root, `source-${index}`)"],
                ["version: 1, nonce, action: 'read-batch'", "version: 1, nonce, action: 'publish'"],
                ['action: request!.action', "action: 'publish'"],
                ['requests.length > MAX_AUTHENTICATED_READ_BATCH', 'false'],
                ['requests.reduce((total, request) => total + request.maxBytes, 0) > MAX_AUTHENTICATED_READ_BATCH_BYTES', 'false'],
                ['sha256(bytes) !== row.sha256', 'false'],
                ['if (!readRoot || readRoot.dev !== rootStatus.dev || readRoot.ino !== rootStatus.ino || !file || !chain\n', 'if (!readRoot || false || !file || !chain\n'],
                ["const receiptOutput = join(directory, 'receipt')", "const receiptOutput = join(root, 'receipt')"],
                ['sha256(receiptBytes) !== summary.receiptSha256', 'false'],
                ['receiptBytes.length !== summary.receiptBytes', 'false'],
                ["new TextDecoder('utf-8', { fatal: true }).decode(receiptBytes)", "new TextDecoder('utf-8').decode(receiptBytes)"],
                ["JSON.stringify(receiptValue) + '\\n' !== receiptText", 'false'],
                ['(summary.receiptBytes as number) > MAX_AUTHENTICATED_READ_BATCH_RECEIPT_BYTES', 'false'],
                ["directory = await mkdtemp(join(tmpdir(), 'cockpit-generated-read-batch-'))", "directory = await mkdtemp(join(root, 'cockpit-generated-read-batch-'))"],
            ]
        for (const [from, to] of [
            ...batchSource,
            ["const output = join(directory, 'source')", "const output = join(root, 'consumer-output')"],
            ["const output = join(directory, 'source')\n        const request = Object.freeze({ version: 1", "const output = join(root, 'consumer-output')\n        const request = Object.freeze({ version: 1"],
            ["action: 'read-entry', maxBytes", "action: 'publish', maxBytes"],
            ["cwd: scratch, env: {}", "cwd: prepared.root, env: {}"],
            ['`--allow-fs-write=${scratch}`', '`--allow-fs-write=${prepared.root}`'],
            ['`--allow-fs-write=${scratch}`', "'--allow-fs-write=*'"],
            ['argv: [prepared.node.canonicalPath, permissionFlag,', 'argv: [prepared.node.canonicalPath,'],
            ['argv: [prepared.node.canonicalPath, permissionFlag,', "argv: [prepared.node.canonicalPath, '--allow-child-process', permissionFlag,"],
            ['argv: [prepared.node.canonicalPath, permissionFlag,', "argv: [prepared.node.canonicalPath, '--allow-worker', permissionFlag,"],
            ['argv: [prepared.node.canonicalPath, permissionFlag,', "argv: [prepared.node.canonicalPath, '--allow-addons', permissionFlag,"],
            ["const request = Object.freeze({ version: 1, nonce, action: 'read-entry'", "const dispatch = helperStep; const request = Object.freeze({ version: 1, nonce, action: 'read-entry'"],
            ['const outcome = authenticatedExecutionOutcome(await adapters.execute(step), step)', 'const dispatch = adapters.execute; const outcome = authenticatedExecutionOutcome(await dispatch(step), step)'],
            ["process.allowedNodeEnvironmentFlags.has('--permission')", "true"],
            ['argvIndexes: [3, 9], executable: false', 'argvIndexes: [9], executable: false'],
            ["'--allow-fs-read', absoluteModule", "'--allow-fs-read', prepared.root"],
            ["'--allow-fs-read', absoluteModule", "'--allow-fs-read=*', absoluteModule"],
            ["'--allow-fs-read', absoluteModule", "'--allow-fs-read', dirname(absoluteModule)"],
            ["[scratch, absoluteModule].some(path => path.includes('*'))", "[scratch].some(path => path.includes('*'))"],
            ['const source = fs.readFileSync(process.argv[2]);', 'const source = fs.readFileSync(request.modulePath);'],
            ["await import('data:text/javascript;base64,' + source.toString('base64'))", 'await import(process.argv[2])'],
            ['const request = { export: capability.mechanism.export, input, output: scratch,', 'const request = { export: capability.mechanism.export, input, output: prepared.root,'],
            ["scratch = await realpath(await mkdtemp(join(tmpdir(), 'cockpit-native-hook-cost-')))", "scratch = await realpath(await mkdtemp(join(prepared.root, 'cockpit-native-hook-cost-')))"],
            ["const path = join(scratch!, 'pre-push')", "const path = join(prepared.root, 'pre-push')"],
            ["await writeFile(path, entry.bytes, { flag: 'wx', mode: 0o700 })", "await writeFile(path, entry.bytes, { flag: 'w', mode: 0o700 })"],
            ['scratchIdentity = Object.freeze({ dev: status.dev, ino: status.ino })', 'scratchIdentity = Object.freeze({ dev: 0, ino: status.ino })'],
            ['const projection = await projectNativeHooks({', 'const hookProjection = projectNativeHooks; const projection = await hookProjection({'],
            ['const step = snapshotExecutionStep({\n                        id: \'native-hook-cost\'', 'const step = ({\n                        id: \'native-hook-cost\''],
            ["id: 'native-hook-cost',\n                        argv: [shell.value.canonicalPath", "id: 'native-hook-cost',\n                        argv: [git.value.canonicalPath"],
            ['{ path: shell.value.canonicalPath, sha256: shell.value.sha256, maxBytes: MAX_EXECUTABLE_BYTES,', '{ path: prepared.root, sha256: shell.value.sha256, maxBytes: MAX_EXECUTABLE_BYTES,'],
            ['{ path, sha256: entry.sha256, maxBytes: Buffer.byteLength(entry.bytes), argvIndexes: [4], executable: false }', '{ path: prepared.root, sha256: entry.sha256, maxBytes: Buffer.byteLength(entry.bytes), argvIndexes: [4], executable: false }'],
            ["{ path: prepared.root, expected: 'directory' }, { path: scratch!, expected: 'directory' }", "{ path: prepared.root, expected: 'directory' }"],
            ['const revisionOutcome = authenticatedExecutionOutcome(await adapters.execute(revisionStep), revisionStep)', 'const revisionOutcome = await adapters.execute(revisionStep)'],
            [`source: Object.freeze({ path: policyDeclaration.path, sha256: policyRead.sha256, identity: policyRead.identity }),
        })
    } finally {
        if (scratch && scratchIdentity) {`, `source: Object.freeze({ path: policyDeclaration.path, sha256: policyRead.sha256, identity: policyRead.identity }),
        })
    } finally {
        if (scratch && scratchIdentity) {
            await rm(scratch, { recursive: true, force: true })`],
        ]) {
            const transactionOwned = batchSource.some(([pattern]) => pattern === from)
                || ["const output = join(directory, 'source')", "const output = join(directory, 'source')\n        const request = Object.freeze({ version: 1",
                    "action: 'read-entry', maxBytes", "const request = Object.freeze({ version: 1, nonce, action: 'read-entry'"].includes(from)
            const owner = transactionOwned ? source : application
            const replacement = owner.replace(from, to)
            expect(replacement, from).not.toBe(owner)
            const unsafe = readGraph(transactionOwned ? application : replacement, transactionOwned ? replacement : source)
            expect(reachableMutations(unsafe, 'checkGeneratedEnvironment').length, from).toBeGreaterThan(0)
        }

        const planted = ts.createSourceFile('planted.ts', `
            async function hiddenMutation() { await rename('source', 'destination') }
            async function plantedCheck() { await hiddenMutation() }
        `, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
        expect(reachableMutations(planted, 'plantedCheck')).toEqual(['rename'])
        const readOnly = ts.createSourceFile('readonly.ts', `
            import { open } from 'node:fs/promises'
            import { constants } from 'node:fs'
            async function check() { return open('source', constants.O_RDONLY | constants.O_NOFOLLOW) }
        `, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
        expect(reachableMutations(readOnly, 'check')).toEqual([])
        const readOnlyDirectory = ts.createSourceFile('readonly-directory.ts', `
            import { open } from 'node:fs/promises'
            import { constants } from 'node:fs'
            async function check() { return open('source', constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW) }
        `, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
        expect(reachableMutations(readOnlyDirectory, 'check')).toEqual([])
        const shadowed = ts.createSourceFile('shadowed.ts', `
            import { open } from 'node:fs/promises'
            import { constants } from 'node:fs'
            async function check(constants) { return open('source', constants.O_RDONLY | constants.O_NOFOLLOW) }
        `, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
        expect(reachableMutations(shadowed, 'check')).toEqual(['open'])

        for (const body of [
            `function open(path, flags) { return rename(path, 'destination') }
             async function check() { return open('source', constants.O_RDONLY | constants.O_NOFOLLOW) }`,
            `async function check() { return rogue.open('source', constants.O_RDONLY | constants.O_NOFOLLOW) }`,
            `async function check(open) { return open('source', constants.O_RDONLY | constants.O_NOFOLLOW) }`,
        ]) {
            const impostor = ts.createSourceFile('impostor.ts', `
                import { open } from 'node:fs/promises'
                import { constants } from 'node:fs'
                ${body}
            `, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
            expect(reachableMutations(impostor, 'check')).toContain('open')
        }

        for (const flags of ['constants.O_WRONLY | constants.O_NOFOLLOW', 'constants.O_RDONLY | constants.O_DIRECTORY | constants.O_CREAT | constants.O_NOFOLLOW', 'unknownFlags']) {
            const writable = ts.createSourceFile('writable.ts', `
                import { constants } from 'node:fs'
                async function check() { return open('source', ${flags}) }
            `, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
            expect(reachableMutations(writable, 'check')).toEqual(['open'])
        }

    })

    it('exposes one authoritative environment application sequence', () => {
        const applicationModule = 'packages/cockpit/src/environment/application.ts'
        const source = productionSources().get(applicationModule)
        if (!source) throw new Error('environment application owner is missing')
        const declarations = mechanismDeclarations(new Map([[applicationModule, source]]))

        expect(declarations).toEqual([{
            declaredBy: applicationModule,
            id: 'environment-application',
            module: applicationModule,
            exports: [
                'setupEnvironment', 'issueSetupRunContext', 'runSetup',
                'issueLifecycleRunContext', 'withLifecycleConfiguration', 'decodeLifecycleRecord', 'revalidateService', 'runUp', 'runSession', 'runSleep',
                'issueDestructiveRunContext', 'runDown', 'runReset', 'beginOperatorReset',
                'runPreflight', 'runDoctor', 'runLogs', 'runBaselineRecord', 'beginOperatorBaselineRecord',
                'prepareGuardEvaluationPolicy', 'runGuardEvaluationApplication',
            ],
        }])
        expect([...exportedImplementations(source)].sort()).toEqual([
            'beginOperatorBaselineRecord',
            'beginOperatorReset',
            'decodeLifecycleRecord',
            'issueDestructiveRunContext',
            'issueLifecycleRunContext',
            'issueSetupRunContext',
            'prepareGuardEvaluationPolicy',
            'revalidateService',
            'runBaselineRecord',
            'runDoctor',
            'runDown',
            'runGuardEvaluationApplication',
            'runLogs',
            'runPreflight',
            'runReset',
            'runSession',
            'runSetup',
            'runSleep',
            'runUp',
            'setupEnvironment',
            'withLifecycleConfiguration',
        ])
    })

    it('keeps environment command ownership in the application instead of pass-through modules', () => {
        const sources = productionSources()
        for (const path of ['down', 'sleep', 'doctor', 'logs', 'preflight', 'reset', 'baseline']) {
            expect(sources.has(`packages/cockpit/src/${path}/command.ts`)).toBe(false)
        }
    })

    it('keeps install-policy observation and resolution in their declared leaf-ward homes', () => {
        const sources = productionSources()
        const declarations = mechanismDeclarations(sources)

        expect(declarations.filter(({ id }) => id === 'install-policy-lockfile-observation'))
            .toEqual([expect.objectContaining({ module: 'packages/cockpit/src/environment/install-policy-observation.ts' })])
        expect(declarations.filter(({ id }) => id === 'install-policy-resolution'))
            .toEqual([expect.objectContaining({ module: 'packages/cockpit/src/environment/install-policy.ts' })])
        expect(kernelLeaf('packages/cockpit/src/environment/install-policy.ts')).toBe(true)
        expect(kernelLeaf('packages/cockpit/src/environment/install-policy-observation.ts')).toBe(true)
    })

    it('keeps production drain authority behind the finite claims broker', () => {
        expect(claimsBrokerOwnershipViolations(productionSources())).toEqual([])
    })

    it.each([
        ['duplicate vocabulary', new Map([
            ['packages/cockpit/src/entrypoint-kinds.ts', "export const mechanism = { id: 'entrypoint-kind-vocabulary', module: 'packages/cockpit/src/entrypoint-kinds.ts', exports: ['ENTRYPOINT_KINDS', 'isEntrypointKind'] } as const; export const ENTRYPOINT_KINDS = ['entrypoint', 'origin', 'callback_url', 'advertised_listener', 'cors_origin', 'public_base_url'] as const; export type EntrypointKind = (typeof ENTRYPOINT_KINDS)[number]; export function isEntrypointKind() {}"],
            ['packages/cockpit/src/other.ts', "const kinds = ['entrypoint', 'origin', 'callback_url', 'advertised_listener', 'cors_origin', 'public_base_url'] as const"],
        ])],
        ['reordered duplicate vocabulary', new Map([
            ['packages/cockpit/src/entrypoint-kinds.ts', "export const mechanism = { id: 'entrypoint-kind-vocabulary', module: 'packages/cockpit/src/entrypoint-kinds.ts', exports: ['ENTRYPOINT_KINDS', 'isEntrypointKind'] } as const; export const ENTRYPOINT_KINDS = ['entrypoint', 'origin', 'callback_url', 'advertised_listener', 'cors_origin', 'public_base_url'] as const; export type EntrypointKind = (typeof ENTRYPOINT_KINDS)[number]; export function isEntrypointKind() {}"],
            ['packages/cockpit/src/other.ts', "const kinds = ['origin', 'entrypoint', 'callback_url', 'advertised_listener', 'cors_origin', 'public_base_url'] as const"],
        ])],
        ['schema-local vocabulary', new Map([
            ['packages/cockpit/src/entrypoint-kinds.ts', "export const mechanism = { id: 'entrypoint-kind-vocabulary', module: 'packages/cockpit/src/entrypoint-kinds.ts', exports: ['ENTRYPOINT_KINDS', 'isEntrypointKind'] } as const; export const ENTRYPOINT_KINDS = ['entrypoint', 'origin', 'callback_url', 'advertised_listener', 'cors_origin', 'public_base_url'] as const; export type EntrypointKind = (typeof ENTRYPOINT_KINDS)[number]; export function isEntrypointKind() {}"],
            ['packages/cockpit/src/schema.ts', "const EntrypointDerivative = z.enum(['entrypoint', 'origin'])"],
        ])],
        ['aliased ports guard', new Map([
            ['packages/cockpit/src/entrypoint-kinds.ts', "export const mechanism = { id: 'entrypoint-kind-vocabulary', module: 'packages/cockpit/src/entrypoint-kinds.ts', exports: ['ENTRYPOINT_KINDS', 'isEntrypointKind'] } as const; export const ENTRYPOINT_KINDS = ['entrypoint', 'origin', 'callback_url', 'advertised_listener', 'cors_origin', 'public_base_url'] as const; export type EntrypointKind = (typeof ENTRYPOINT_KINDS)[number]; export function isEntrypointKind() {}"],
            ['packages/cockpit/src/schema.ts', "import { ENTRYPOINT_KINDS } from './entrypoint-kinds.js'; z.enum(ENTRYPOINT_KINDS)"],
            ['packages/cockpit/src/environment/ports.ts', "import { isEntrypointKind as acceptsKind, type EntrypointKind } from '../entrypoint-kinds.js'; const kind: EntrypointKind = value; acceptsKind(kind)"],
        ])],
        ['owner imports a consumer', new Map([
            ['packages/cockpit/src/entrypoint-kinds.ts', "import './schema.js'; export const mechanism = { id: 'entrypoint-kind-vocabulary', module: 'packages/cockpit/src/entrypoint-kinds.ts', exports: ['ENTRYPOINT_KINDS', 'isEntrypointKind'] } as const; export const ENTRYPOINT_KINDS = ['entrypoint', 'origin', 'callback_url', 'advertised_listener', 'cors_origin', 'public_base_url'] as const; export type EntrypointKind = (typeof ENTRYPOINT_KINDS)[number]; export function isEntrypointKind() {}"],
            ['packages/cockpit/src/schema.ts', "import { ENTRYPOINT_KINDS } from './entrypoint-kinds.js'; z.enum(ENTRYPOINT_KINDS)"],
            ['packages/cockpit/src/environment/ports.ts', "import { isEntrypointKind, type EntrypointKind } from '../entrypoint-kinds.js'; const kind: EntrypointKind = value; isEntrypointKind(kind)"],
        ])],
        ['second guard implementation', new Map([
            ['packages/cockpit/src/entrypoint-kinds.ts', "export const mechanism = { id: 'entrypoint-kind-vocabulary', module: 'packages/cockpit/src/entrypoint-kinds.ts', exports: ['ENTRYPOINT_KINDS', 'isEntrypointKind'] } as const; export const ENTRYPOINT_KINDS = ['entrypoint', 'origin', 'callback_url', 'advertised_listener', 'cors_origin', 'public_base_url'] as const; export type EntrypointKind = (typeof ENTRYPOINT_KINDS)[number]; export function isEntrypointKind() {}"],
            ['packages/cockpit/src/other.ts', "import { ENTRYPOINT_KINDS } from './entrypoint-kinds.js'; const accepts = (value: string) => ENTRYPOINT_KINDS.includes(value)"],
        ])],
        ['second derived type', new Map([
            ['packages/cockpit/src/entrypoint-kinds.ts', "export const mechanism = { id: 'entrypoint-kind-vocabulary', module: 'packages/cockpit/src/entrypoint-kinds.ts', exports: ['ENTRYPOINT_KINDS', 'isEntrypointKind'] } as const; export const ENTRYPOINT_KINDS = ['entrypoint', 'origin', 'callback_url', 'advertised_listener', 'cors_origin', 'public_base_url'] as const; export type EntrypointKind = (typeof ENTRYPOINT_KINDS)[number]; export function isEntrypointKind() {}"],
            ['packages/cockpit/src/other.ts', "import { ENTRYPOINT_KINDS } from './entrypoint-kinds.js'; type OtherKind = (typeof ENTRYPOINT_KINDS)[number]"],
        ])],
    ])('keeps one leaf-ward entrypoint-kind vocabulary: %s', (_label, sources) => {
        expect(entrypointKindVocabularyViolations(sources)).toContain('ARCH039_ENTRYPOINT_KIND_VOCABULARY')
    })

    it('accepts the entrypoint-kind owner and its direct consumers', () => {
        expect(entrypointKindVocabularyViolations(new Map([
            ['packages/cockpit/src/entrypoint-kinds.ts', "export const mechanism = { id: 'entrypoint-kind-vocabulary', module: 'packages/cockpit/src/entrypoint-kinds.ts', exports: ['ENTRYPOINT_KINDS', 'isEntrypointKind'] } as const; export const ENTRYPOINT_KINDS = Object.freeze(['entrypoint', 'origin', 'callback_url', 'advertised_listener', 'cors_origin', 'public_base_url'] as const); export type EntrypointKind = (typeof ENTRYPOINT_KINDS)[number]; export function isEntrypointKind(value: unknown): value is EntrypointKind { return false }"],
            ['packages/cockpit/src/schema.ts', "import { ENTRYPOINT_KINDS } from './entrypoint-kinds.js'; z.enum(ENTRYPOINT_KINDS)"],
            ['packages/cockpit/src/environment/ports.ts', "import { isEntrypointKind, type EntrypointKind } from '../entrypoint-kinds.js'; const kind: EntrypointKind = value; isEntrypointKind(kind)"],
            ['packages/cockpit/src/environment/contract.ts', "import { isEntrypointKind, type EntrypointKind } from '../entrypoint-kinds.js'; const kind: EntrypointKind = value; isEntrypointKind(kind)"],
        ]))).toEqual([])
    })

    it.each([
        ['owner type is widened', 'export type EntrypointKind = string; export function isEntrypointKind(value: unknown): value is EntrypointKind { return false }'],
        ['guard parameter is widened', 'export type EntrypointKind = (typeof ENTRYPOINT_KINDS)[number]; export function isEntrypointKind(value: string): value is EntrypointKind { return false }'],
        ['guard returns boolean', 'export type EntrypointKind = (typeof ENTRYPOINT_KINDS)[number]; export function isEntrypointKind(value: unknown): boolean { return false }'],
        ['guard predicates another type', 'export type EntrypointKind = (typeof ENTRYPOINT_KINDS)[number]; type LocalKind = string; export function isEntrypointKind(value: unknown): value is LocalKind { return false }'],
    ])('requires the exact entrypoint-kind owner type and guard signature: %s', (_label, declarations) => {
        expect(entrypointKindVocabularyViolations(new Map([
            ['packages/cockpit/src/entrypoint-kinds.ts', `export const mechanism = { id: 'entrypoint-kind-vocabulary', module: 'packages/cockpit/src/entrypoint-kinds.ts', exports: ['ENTRYPOINT_KINDS', 'isEntrypointKind'] } as const; export const ENTRYPOINT_KINDS = ['entrypoint', 'origin', 'callback_url', 'advertised_listener', 'cors_origin', 'public_base_url'] as const; ${declarations}`],
        ]))).toContain('ARCH039_ENTRYPOINT_KIND_VOCABULARY')
    })

    it.each([
        ['schema carrier', 'packages/cockpit/src/schema.ts', "import { ENTRYPOINT_KINDS } from './entrypoint-kinds.js'; const kinds = ENTRYPOINT_KINDS; z.enum(kinds)"],
        ['schema passed reference', 'packages/cockpit/src/schema.ts', "import { ENTRYPOINT_KINDS } from './entrypoint-kinds.js'; consume(ENTRYPOINT_KINDS)"],
        ['ports guard callback', 'packages/cockpit/src/environment/ports.ts', "import { isEntrypointKind, type EntrypointKind } from '../entrypoint-kinds.js'; const kind: EntrypointKind = value; values.filter(isEntrypointKind)"],
        ['ports derived type', 'packages/cockpit/src/environment/ports.ts', "import { isEntrypointKind, type EntrypointKind } from '../entrypoint-kinds.js'; type LocalKind = EntrypointKind; isEntrypointKind(value)"],
        ['contract optional guard', 'packages/cockpit/src/environment/contract.ts', "import { isEntrypointKind, type EntrypointKind } from '../entrypoint-kinds.js'; const kind: EntrypointKind = value; isEntrypointKind?.(kind)"],
        ['schema import without use', 'packages/cockpit/src/schema.ts', "import { ENTRYPOINT_KINDS } from './entrypoint-kinds.js'"],
        ['ports imports without type use', 'packages/cockpit/src/environment/ports.ts', "import { isEntrypointKind, type EntrypointKind } from '../entrypoint-kinds.js'; isEntrypointKind(value)"],
    ])('rejects entrypoint-kind consumer reference escapes: %s', (_label, path, source) => {
        expect(entrypointKindVocabularyViolations(new Map([
            ['packages/cockpit/src/entrypoint-kinds.ts', "export const mechanism = { id: 'entrypoint-kind-vocabulary', module: 'packages/cockpit/src/entrypoint-kinds.ts', exports: ['ENTRYPOINT_KINDS', 'isEntrypointKind'] } as const; export const ENTRYPOINT_KINDS = ['entrypoint', 'origin', 'callback_url', 'advertised_listener', 'cors_origin', 'public_base_url'] as const; export type EntrypointKind = (typeof ENTRYPOINT_KINDS)[number]; export function isEntrypointKind(value: unknown): value is EntrypointKind { return ENTRYPOINT_KINDS.includes(value as never) }"],
            [path, source],
        ]))).toContain('ARCH039_ENTRYPOINT_KIND_VOCABULARY')
    })

    it.each([
        ['dynamic import', "void import('./entrypoint-kinds.js')"],
        ['CommonJS load', "require('./entrypoint-kinds.js')"],
        ['module CommonJS load', "module.require('./entrypoint-kinds.js')"],
        ['TypeScript CommonJS import', "import entrypoints = require('./entrypoint-kinds.js')"],
        ['re-export', "export * from './entrypoint-kinds.js'"],
    ])('rejects indirect entrypoint-kind module access: %s', (_label, source) => {
        expect(entrypointKindVocabularyViolations(new Map([
            ['packages/cockpit/src/entrypoint-kinds.ts', "export const mechanism = { id: 'entrypoint-kind-vocabulary', module: 'packages/cockpit/src/entrypoint-kinds.ts', exports: ['ENTRYPOINT_KINDS', 'isEntrypointKind'] } as const; export const ENTRYPOINT_KINDS = ['entrypoint', 'origin', 'callback_url', 'advertised_listener', 'cors_origin', 'public_base_url'] as const; export type EntrypointKind = (typeof ENTRYPOINT_KINDS)[number]; export function isEntrypointKind(value: unknown): value is EntrypointKind { return ENTRYPOINT_KINDS.includes(value as never) }"],
            ['packages/cockpit/src/other.ts', source],
        ]))).toContain('ARCH039_ENTRYPOINT_KIND_VOCABULARY')
    })

    it.each([
        ['namespace import', "import * as entrypoints from './entrypoint-kinds.js'; const kinds = entrypoints.ENTRYPOINT_KINDS"],
        ['vocabulary carrier', "import { ENTRYPOINT_KINDS } from './entrypoint-kinds.js'; const kinds = ENTRYPOINT_KINDS"],
        ['guard carrier', "import { isEntrypointKind } from './entrypoint-kinds.js'; const accepts = isEntrypointKind"],
        ['derived guard', "import { isEntrypointKind } from './entrypoint-kinds.js'; const accepts = (value: unknown) => isEntrypointKind(value)"],
        ['derived type', "import type { EntrypointKind } from './entrypoint-kinds.js'; type LocalKind = EntrypointKind"],
    ])('rejects indirect entrypoint-kind consumers: %s', (_label, source) => {
        expect(entrypointKindVocabularyViolations(new Map([
            ['packages/cockpit/src/entrypoint-kinds.ts', "export const mechanism = { id: 'entrypoint-kind-vocabulary', module: 'packages/cockpit/src/entrypoint-kinds.ts', exports: ['ENTRYPOINT_KINDS', 'isEntrypointKind'] } as const; export const ENTRYPOINT_KINDS = ['entrypoint', 'origin', 'callback_url', 'advertised_listener', 'cors_origin', 'public_base_url'] as const; export type EntrypointKind = (typeof ENTRYPOINT_KINDS)[number]; export function isEntrypointKind(value: unknown): value is EntrypointKind { return ENTRYPOINT_KINDS.includes(value as never) }"],
            ['packages/cockpit/src/other.ts', source],
        ]))).toContain('ARCH039_ENTRYPOINT_KIND_VOCABULARY')
    })

    it.each([
        ["export const mechanism = { id: 'other', module: 'packages/cockpit/src/entrypoint-kinds.ts', exports: ['ENTRYPOINT_KINDS', 'isEntrypointKind'] } as const"],
        ["export const mechanism = { id: 'entrypoint-kind-vocabulary', module: 'packages/cockpit/src/schema.ts', exports: ['ENTRYPOINT_KINDS', 'isEntrypointKind'] } as const"],
        ["export const mechanism = { id: 'entrypoint-kind-vocabulary', module: 'packages/cockpit/src/entrypoint-kinds.ts', exports: ['ENTRYPOINT_KINDS', 'EntrypointKind', 'isEntrypointKind'] } as const"],
    ])('requires the exact entrypoint-kind mechanism declaration', (mechanism) => {
        expect(entrypointKindVocabularyViolations(new Map([
            ['packages/cockpit/src/entrypoint-kinds.ts', `${mechanism}; export const ENTRYPOINT_KINDS = ['entrypoint', 'origin', 'callback_url', 'advertised_listener', 'cors_origin', 'public_base_url'] as const; export type EntrypointKind = (typeof ENTRYPOINT_KINDS)[number]; export function isEntrypointKind() {}`],
        ]))).toContain('ARCH039_ENTRYPOINT_KIND_VOCABULARY')
    })

    it('rejects an additional entrypoint-kind runtime export', () => {
        expect(entrypointKindVocabularyViolations(new Map([
            ['packages/cockpit/src/entrypoint-kinds.ts', "export const mechanism = { id: 'entrypoint-kind-vocabulary', module: 'packages/cockpit/src/entrypoint-kinds.ts', exports: ['ENTRYPOINT_KINDS', 'isEntrypointKind'] } as const; export const ENTRYPOINT_KINDS = ['entrypoint', 'origin', 'callback_url', 'advertised_listener', 'cors_origin', 'public_base_url'] as const; export type EntrypointKind = (typeof ENTRYPOINT_KINDS)[number]; export function isEntrypointKind() {}; export default ENTRYPOINT_KINDS"],
        ]))).toContain('ARCH039_ENTRYPOINT_KIND_VOCABULARY')
    })

    it.each([
        ['runtime permit type', 'packages/cockpit/src/environment/runtime.ts', 'interface Contract { readonly permit: DrainAttemptPermit<object> }'],
        ['reclaim progress type', 'packages/cockpit/src/environment/reclaim.ts', 'interface Continuation { readonly progressAuthority: DrainProgressAuthority }'],
        ['runtime sealed store', 'packages/cockpit/src/environment/runtime.ts', 'const outcomes = new WeakMap<object, DrainAttemptSuccessAuthority>()'],
        ['runtime inferred progress store', 'packages/cockpit/src/environment/runtime.ts', 'const drainProgressAuthorities = new WeakMap()'],
    ])('confines finite claims-broker ownership: %s', (_label, path, source) => {
        expect(claimsBrokerOwnershipViolations(new Map([[path, source]]))).toContain(
            'ARCH037_DRAIN_REDEMPTION_BOUNDARY',
        )
    })

    it.each([
        ['runtime permit record', 'packages/cockpit/src/environment/runtime.ts', 'interface Contract { readonly permit: object }'],
        ['reclaim progress record', 'packages/cockpit/src/environment/reclaim.ts', 'type Continuation = { readonly progressAuthority: object | null }'],
        ['reclaim failure record', 'packages/cockpit/src/environment/reclaim.ts', 'const continuation = { failureAuthority: Object.freeze({}) }'],
    ])('reserves broker capability data-field names in runtime and reclaim: %s', (_label, path, source) => {
        expect(claimsBrokerOwnershipViolations(new Map([[path, source]]))).toContain(
            'ARCH037_DRAIN_REDEMPTION_BOUNDARY',
        )
    })

    it('allows unrelated behavior to use the same vocabulary', () => {
        expect(claimsBrokerOwnershipViolations(new Map([
            ['packages/cockpit/src/environment/runtime.ts', 'class Metrics { permit() { return true } get progressAuthority() { return false } }'],
        ]))).toEqual([])
    })

    it('allows each operation-specific facet only in its owner', () => {
        expect(claimsBrokerOwnershipViolations(new Map([
            ['packages/cockpit/src/environment/runtime.ts', "import { openRuntimeDrainExecution, settleRuntimeDrainSuccess, settleRuntimeDrainFailure } from './claims.js'; const execution = openRuntimeDrainExecution({}); settleRuntimeDrainSuccess({}); settleRuntimeDrainFailure({})"],
            ['packages/cockpit/src/environment/reclaim.ts', "import { openReclaimDrainExecution, settleReclaimDrainSuccess, settleReclaimDrainFailure, matchReclaimDrainContinuation } from './claims.js'; const execution = openReclaimDrainExecution({}); settleReclaimDrainSuccess({}); settleReclaimDrainFailure({}); matchReclaimDrainContinuation({})"],
            ['packages/cockpit/src/environment/application.ts', "import { reduceDrainOutcome, prepareDrainOutcomePublication, finalizeDrainOutcome } from './claims.js'; reduceDrainOutcome({}); const publication = await prepareDrainOutcomePublication({}); finalizeDrainOutcome({ publication })"],
            ['packages/cockpit/src/environment/claims.ts', operationClaimsFixture()],
        ]))).toEqual([])
    })

    it.each([
        ['runtime missing import', "import { openRuntimeDrainExecution, settleRuntimeDrainSuccess } from './claims.js'; openRuntimeDrainExecution({}); settleRuntimeDrainSuccess({})"],
        ['runtime missing call', "import { openRuntimeDrainExecution, settleRuntimeDrainSuccess, settleRuntimeDrainFailure } from './claims.js'; openRuntimeDrainExecution({}); settleRuntimeDrainSuccess({})"],
        ['reclaim missing import', "import { openReclaimDrainExecution, settleReclaimDrainSuccess, settleReclaimDrainFailure } from './claims.js'; openReclaimDrainExecution({}); settleReclaimDrainSuccess({}); settleReclaimDrainFailure({})"],
        ['reclaim missing call', "import { openReclaimDrainExecution, settleReclaimDrainSuccess, settleReclaimDrainFailure, matchReclaimDrainContinuation } from './claims.js'; openReclaimDrainExecution({}); settleReclaimDrainSuccess({}); settleReclaimDrainFailure({})"],
    ])('requires every current owner facet to be imported and called directly: %s', (label, source) => {
        const path = label.startsWith('runtime')
            ? 'packages/cockpit/src/environment/runtime.ts'
            : 'packages/cockpit/src/environment/reclaim.ts'
        expect(claimsBrokerOwnershipViolations(new Map([
            [path, source], ['packages/cockpit/src/environment/claims.ts', operationClaimsFixture()],
        ]))).toContain('ARCH037_DRAIN_REDEMPTION_BOUNDARY')
    })

    it('allows application to omit its future-reserved outcome facets', () => {
        expect(claimsBrokerOwnershipViolations(new Map([
            ['packages/cockpit/src/environment/runtime.ts', "import { openRuntimeDrainExecution, settleRuntimeDrainSuccess, settleRuntimeDrainFailure } from './claims.js'; openRuntimeDrainExecution({}); settleRuntimeDrainSuccess({}); settleRuntimeDrainFailure({})"],
            ['packages/cockpit/src/environment/reclaim.ts', "import { openReclaimDrainExecution, settleReclaimDrainSuccess, settleReclaimDrainFailure, matchReclaimDrainContinuation } from './claims.js'; openReclaimDrainExecution({}); settleReclaimDrainSuccess({}); settleReclaimDrainFailure({}); matchReclaimDrainContinuation({})"],
            ['packages/cockpit/src/environment/application.ts', 'export const applicationReady = true'],
            ['packages/cockpit/src/environment/claims.ts', operationClaimsFixture()],
        ]))).toEqual([])
    })

    it.each([
        ['runtime facet in reclaim', 'packages/cockpit/src/environment/reclaim.ts', "import { openRuntimeDrainExecution } from './claims.js'; openRuntimeDrainExecution({})"],
        ['reclaim facet in runtime', 'packages/cockpit/src/environment/runtime.ts', "import { settleReclaimDrainSuccess } from './claims.js'; settleReclaimDrainSuccess({})"],
        ['continuation facet in application', 'packages/cockpit/src/environment/application.ts', "import { matchReclaimDrainContinuation } from './claims.js'; matchReclaimDrainContinuation({})"],
        ['outcome facet in reclaim', 'packages/cockpit/src/environment/reclaim.ts', "import { reduceDrainOutcome } from './claims.js'; reduceDrainOutcome({})"],
        ['publication facet in reclaim', 'packages/cockpit/src/environment/reclaim.ts', "import { prepareDrainOutcomePublication } from './claims.js'; prepareDrainOutcomePublication({})"],
        ['second local facet declaration', 'packages/cockpit/src/environment/runtime.ts', 'function reduceDrainOutcome() {}'],
    ])('rejects operation-specific facet ownership violations: %s', (_label, path, source) => {
        expect(claimsBrokerOwnershipViolations(new Map([
            [path, source], ['packages/cockpit/src/environment/claims.ts', operationClaimsFixture()],
        ]))).toContain('ARCH037_DRAIN_REDEMPTION_BOUNDARY')
    })

    it.each([
        ['renamed import', "import { openRuntimeDrainExecution as open } from './claims.js'; open({})"],
        ['local alias', "import { openRuntimeDrainExecution } from './claims.js'; const open = openRuntimeDrainExecution; open({})"],
        ['optional call', "import { openRuntimeDrainExecution } from './claims.js'; openRuntimeDrainExecution?.({})"],
        ['returned call', "import { openRuntimeDrainExecution } from './claims.js'; function expose() { return openRuntimeDrainExecution({}) }"],
        ['binding carrier', "import { openRuntimeDrainExecution } from './claims.js'; const broker = { openRuntimeDrainExecution }"],
        ['namespace import', "import * as claims from './claims.js'; claims.openRuntimeDrainExecution({})"],
        ['direct re-export', "export { openRuntimeDrainExecution } from './claims.js'"],
        ['imported re-export', "import { openRuntimeDrainExecution } from './claims.js'; export { openRuntimeDrainExecution }"],
    ])('rejects finite facet reference escapes: %s', (_label, source) => {
        expect(claimsBrokerOwnershipViolations(new Map([
            ['packages/cockpit/src/environment/runtime.ts', source],
            ['packages/cockpit/src/environment/claims.ts', operationClaimsFixture()],
        ]))).toContain('ARCH037_DRAIN_REDEMPTION_BOUNDARY')
    })

    it('rejects publication result escape from its application owner', () => {
        expect(claimsBrokerOwnershipViolations(new Map([
            ['packages/cockpit/src/environment/application.ts', "import { prepareDrainOutcomePublication } from './claims.js'; function expose() { return prepareDrainOutcomePublication({}) }"],
            ['packages/cockpit/src/environment/claims.ts', operationClaimsFixture()],
        ]))).toContain('ARCH037_DRAIN_REDEMPTION_BOUNDARY')
    })

    it('rejects awaited publication result escape from its application owner', () => {
        expect(claimsBrokerOwnershipViolations(new Map([
            ['packages/cockpit/src/environment/application.ts', "import { prepareDrainOutcomePublication } from './claims.js'; async function expose() { return await prepareDrainOutcomePublication({}) }"],
            ['packages/cockpit/src/environment/claims.ts', operationClaimsFixture()],
        ]))).toContain('ARCH037_DRAIN_REDEMPTION_BOUNDARY')
    })

    it('rejects conditional awaited publication result escape from its application owner', () => {
        expect(claimsBrokerOwnershipViolations(new Map([
            ['packages/cockpit/src/environment/application.ts', "import { prepareDrainOutcomePublication } from './claims.js'; async function expose(enabled: boolean) { return enabled ? await prepareDrainOutcomePublication({}) : undefined }"],
            ['packages/cockpit/src/environment/claims.ts', operationClaimsFixture()],
        ]))).toContain('ARCH037_DRAIN_REDEMPTION_BOUNDARY')
    })

    it.each([
        ['old broker function', 'function openDrainExecution() {}'],
        ['old evidence function', 'const accessDrainEvidence = () => undefined'],
        ['generic execution type', 'interface DrainExecutionAuthority {}'],
    ])('retires the broad drain broker surface: %s', (_label, source) => {
        expect(claimsBrokerOwnershipViolations(new Map([
            ['packages/cockpit/src/environment/claims.ts', `${operationClaimsFixture()} ${source}`],
        ]))).toContain('ARCH037_DRAIN_REDEMPTION_BOUNDARY')
    })

    it.each([
        ['renamed export', 'export { openRuntimeDrainExecution as open }'],
        ['default export', 'export default openRuntimeDrainExecution'],
        ['exported carrier', 'export const broker = { openRuntimeDrainExecution }'],
        ['local alias', 'const open = openRuntimeDrainExecution'],
    ])('rejects claims facet aliases and carriers: %s', (_label, extra) => {
        expect(claimsBrokerOwnershipViolations(new Map([
            ['packages/cockpit/src/environment/claims.ts', operationClaimsFixture(extra)],
        ]))).toContain('ARCH037_DRAIN_REDEMPTION_BOUNDARY')
    })

    it.each([
        ['dynamic import', 'packages/cockpit/src/environment/application.ts', "void import('./extension.js')"],
        ['claims dynamic import', 'packages/cockpit/src/environment/claims.ts', operationClaimsFixture("void import('./extension.js')")],
        ['CommonJS load', 'packages/cockpit/src/environment/runtime.ts', "require('./extension.js')"],
        ['CommonJS alias', 'packages/cockpit/src/environment/runtime.ts', 'const load = require'],
        ['module CommonJS load', 'packages/cockpit/src/environment/reclaim.ts', "module.require('./extension.js')"],
        ['bracketed module CommonJS load', 'packages/cockpit/src/environment/reclaim.ts', "module['require']('./extension.js')"],
        ['TypeScript CommonJS import', 'packages/cockpit/src/environment/reclaim.ts', "import extension = require('./extension.js')"],
        ['CommonJS factory', 'packages/cockpit/src/environment/runtime.ts', "import { createRequire as factory } from 'node:module'; const require = factory(import.meta.url); require('./extension.js')"],
        ['namespace CommonJS factory', 'packages/cockpit/src/environment/runtime.ts', "import * as nodeModule from 'node:module'; const require = nodeModule.createRequire(import.meta.url); require('./extension.js')"],
        ['process CommonJS factory', 'packages/cockpit/src/environment/runtime.ts', "const require = process.getBuiltinModule('node:module').createRequire(import.meta.url); require('./extension.js')"],
        ['bracketed process CommonJS factory', 'packages/cockpit/src/environment/reclaim.ts', "const require = process['getBuiltinModule']('node:module')['createRequire'](import.meta.url); require('./extension.js')"],
        ['eval alias', 'packages/cockpit/src/environment/application.ts', 'const evaluate = eval'],
        ['global eval', 'packages/cockpit/src/environment/application.ts', "global['eval']('1')"],
        ['global Function', 'packages/cockpit/src/environment/application.ts', "new global.Function('return 1')"],
        ['Function call', 'packages/cockpit/src/environment/runtime.ts', "Function('return 1')"],
        ['Function constructor', 'packages/cockpit/src/environment/reclaim.ts', "new Function('return 1')"],
        ['global object', 'packages/cockpit/src/environment/application.ts', 'const root = globalThis'],
    ])('rejects the finite opaque code-loading threat set in broker modules: %s', (_label, path, source) => {
        expect(claimsBrokerOwnershipViolations(new Map([[path, source]]))).toContain(
            'ARCH037_DRAIN_REDEMPTION_BOUNDARY',
        )
    })

    it.each([
        ['eval', 'const eval = () => 1; eval()'],
        ['Function', 'const Function = () => 1; Function()'],
        ['globalThis', 'function inspect(globalThis: object) { return globalThis }'],
        ['require', 'const require = () => 1; require()'],
        ['module', 'const module = { require: () => 1 }; module.require()'],
        ['process', "const process = { getBuiltinModule: () => ({ createRequire: () => () => 1 }) }; process.getBuiltinModule('node:module').createRequire()()"],
        ['global', "const global = { eval: () => 1 }; global['eval']()"],
    ])('allows a genuinely local %s shadow', (_label, source) => {
        expect(claimsBrokerOwnershipViolations(new Map([
            ['packages/cockpit/src/environment/runtime.ts', source],
        ]))).toEqual([])
    })

    it('ignores opaque loading syntax in unrelated modules', () => {
        expect(claimsBrokerOwnershipViolations(new Map([
            ['packages/cockpit/src/config.ts', "void import('./extension.js'); eval; Function; globalThis; require('./extension.js')"],
        ]))).toEqual([])
    })

    it('rejects duplicate observation code authority and non-local declarations', () => {
        const duplicateAuthority = new Map([
            ['packages/cockpit/src/environment/one.ts', `const mechanism = { id: 'one' } as const; const isIssued = () => false; export const observationDeclarations = Object.freeze([{ id: 'first', owner: mechanism.id, postures: ['environment'], code: ENVIRONMENT_CODES.CONFIG_STALE, isIssued }] as const)`],
            ['packages/cockpit/src/environment/two.ts', `const mechanism = { id: 'two' } as const; const isIssued = () => false; export const observationDeclarations = Object.freeze([{ id: 'second', owner: mechanism.id, postures: ['environment'], code: ENVIRONMENT_CODES.CONFIG_STALE, isIssued }] as const)`],
        ])
        const nonLocal = new Map([
            ['packages/cockpit/src/environment/one.ts', `const mechanism = { id: 'one' } as const; const isIssued = () => false; export const observationDeclarations = Object.freeze([{ id: 'first', owner: 'other', postures: ['environment'], code: ENVIRONMENT_CODES.CONFIG_STALE, isIssued }] as const)`],
        ])
        expect(observationDeclarationViolations(duplicateAuthority)).toContain('ARCH029_DUPLICATE_OBSERVATION_DECLARATION')
        expect(observationDeclarationViolations(nonLocal)).toContain('ARCH030_OBSERVATION_DECLARATION_NOT_LOCAL')
        const disguised = new Map([
            ['packages/cockpit/src/environment/one.ts', `const mechanism = { id: 'one' } as const; const isIssued = () => false; export const checks = Object.freeze([{ id: 'first', owner: mechanism.id, postures: ['environment'], code: ENVIRONMENT_CODES.CONFIG_STALE, isIssued }] as const)`],
            ['packages/cockpit/src/environment/two.ts', `const mechanism = { id: 'two' } as const; const isIssued = () => false; export const observationDeclarations = Object.freeze([{ id: 'second', owner: mechanism.id, postures: ['environment'], code: ENVIRONMENT_CODES.CONFIG_STALE, isIssued }] as const)`],
        ])
        expect(observationDeclarationViolations(disguised)).toContain('ARCH029_DUPLICATE_OBSERVATION_DECLARATION')
        expect(observationDeclarationViolations(new Map([['packages/cockpit/src/environment/one.ts', 'export function issueEnvironmentObservation() {}']]))).toContain('ARCH032_OBSERVATION_ISSUER_EXPORTED')
    })

    it('requires a local issuance verifier and aggregation of every declaration module', () => {
        const nonLocalVerifier = new Map([
            ['packages/cockpit/src/environment/one.ts', `const mechanism = { id: 'one' } as const; export const observationDeclarations = Object.freeze([{ id: 'first', owner: mechanism.id, postures: ['environment'], code: ENVIRONMENT_CODES.CONFIG_STALE, isIssued }] as const)`],
        ])
        const omittedFromAggregate = new Map([
            ['packages/cockpit/src/environment/one.ts', `const mechanism = { id: 'one' } as const; const isIssued = () => false; export const observationDeclarations = Object.freeze([{ id: 'first', owner: mechanism.id, postures: ['environment'], code: ENVIRONMENT_CODES.CONFIG_STALE, isIssued }] as const)`],
            ['packages/cockpit/src/environment/observations.ts', `import { observationDeclarations as oneDeclarations } from './one.js'; export const allObservationDeclarations = Object.freeze([])`],
        ])

        expect(observationDeclarationViolations(nonLocalVerifier)).toContain('ARCH030_OBSERVATION_DECLARATION_NOT_LOCAL')
        expect(observationDeclarationViolations(omittedFromAggregate)).toContain('ARCH031_OBSERVATION_AGGREGATE_INCOMPLETE')
    })

    it('requires lifecycle applicability beside every observation producer', () => {
        const missingStage = new Map([
            ['packages/cockpit/src/environment/one.ts', `const mechanism = { id: 'one' } as const; const isIssued = () => false; export const observationDeclarations = Object.freeze([{ id: 'first', owner: mechanism.id, postures: ['environment'], code: ENVIRONMENT_CODES.CONFIG_STALE, isIssued }] as const)`],
        ])
        const complete = new Map([
            ['packages/cockpit/src/environment/one.ts', `const mechanism = { id: 'one' } as const; const isIssued = () => false; export const observationDeclarations = Object.freeze([{ id: 'first', owner: mechanism.id, postures: ['environment'], stages: [{ stage: 'bootstrap', disposition: 'required' }, { stage: 'steady', disposition: 'required' }], code: ENVIRONMENT_CODES.CONFIG_STALE, isIssued }] as const)`],
        ])
        expect(observationDeclarationViolations(missingStage)).toContain('ARCH033_OBSERVATION_STAGE_NOT_LOCAL')
        expect(observationDeclarationViolations(complete)).not.toContain('ARCH033_OBSERVATION_STAGE_NOT_LOCAL')
    })

    it('names cycle, leaf reversal, command-table binding, handler reversal, and peer imports', () => {
        const sources = new Map([
            ['packages/cockpit/src/schema.ts', "import './document/command.js'"],
            ['packages/cockpit/src/command-table.ts', "import './document/command.js'"],
            ['packages/cockpit/src/document/command.ts', "import '../command-table.js'; import './other-command.js'"],
            ['packages/cockpit/src/document/other-command.ts', "import './command.js'"],
        ])

        expect(importDirectionViolations(sources)).toEqual(
            expect.arrayContaining([
                'ARCH001_CYCLE',
                'ARCH002_KERNEL_DIRECTION',
                'ARCH003_COMMAND_TABLE_HANDLER_IMPORT',
                'ARCH004_HANDLER_REVERSE_IMPORT',
                'ARCH005_PEER_COMMAND_IMPORT',
            ]),
        )
    })

    it('classifies a nested resolver command for reverse and peer-import controls', () => {
        const sources = new Map([
            ['packages/cockpit/src/command-table.ts', 'export const commands = []'],
            [
                'packages/cockpit/src/registry-resolve/command.ts',
                "import '../command-table.js'; import '../document/command.js'",
            ],
            ['packages/cockpit/src/document/command.ts', 'export const document = true'],
        ])

        expect(importDirectionViolations(sources)).toEqual(
            expect.arrayContaining(['ARCH004_HANDLER_REVERSE_IMPORT', 'ARCH005_PEER_COMMAND_IMPORT']),
        )
    })

    it.each(['setup', 'up', 'sleep', 'down', 'reset', 'preflight', 'doctor', 'logs', 'baseline'])(
        'classifies the root %s command directory as a command module',
        (verb) => {
            const sources = new Map([
                ['packages/cockpit/src/command-table.ts', 'export const commands = []'],
                [
                    `packages/cockpit/src/${verb}/command.ts`,
                    `import '../command-table.js'; import '../document/command.js'`,
                ],
                ['packages/cockpit/src/document/command.ts', 'export const document = true'],
            ])

            expect(importDirectionViolations(sources)).toEqual(
                expect.arrayContaining(['ARCH004_HANDLER_REVERSE_IMPORT', 'ARCH005_PEER_COMMAND_IMPORT']),
            )
        },
    )

    it('keeps the config loader and environment contract leaf-ward', () => {
        const sources = new Map([
            ['packages/cockpit/src/config/load.ts', "import '../config-support.js'"],
            ['packages/cockpit/src/config-support.ts', "import './setup/command.js'"],
            ['packages/cockpit/src/environment/contract.ts', "import '../cli.js'"],
            ['packages/cockpit/src/setup/command.ts', 'export const setup = true'],
            ['packages/cockpit/src/cli.ts', 'export const cli = true'],
        ])

        expect(importDirectionViolations(sources)).toContain('ARCH002_KERNEL_DIRECTION')
    })

    it('keeps runtime and failure-log planning leaf-ward with one local mechanism home', () => {
        const reversed = new Map([
            ['packages/cockpit/src/environment/runtime.ts', "import '../up/command.js'"],
            ['packages/cockpit/src/environment/logs.ts', "import '../up/command.js'"],
            ['packages/cockpit/src/up/command.ts', 'export const up = true'],
        ])
        const duplicate = new Map([
            ['packages/cockpit/src/environment/runtime.ts', "export const mechanism = { id: 'runtime-planning', module: 'packages/cockpit/src/environment/runtime.ts', exports: [] } as const"],
            ['packages/cockpit/src/environment/runtime-copy.ts', "export const mechanism = { id: 'runtime-planning', module: 'packages/cockpit/src/environment/runtime-copy.ts', exports: [] } as const"],
        ])

        expect(importDirectionViolations(reversed)).toContain('ARCH002_KERNEL_DIRECTION')
        expect(ownershipViolations(duplicate)).toContain('ARCH013_DUPLICATE_MECHANISM')
    })

    it('keeps lifecycle planning leaf-ward from the application layer', () => {
        const sources = new Map([
            ['packages/cockpit/src/environment/lifecycle.ts', "import './application.js'"],
            ['packages/cockpit/src/environment/application.ts', 'export const application = true'],
        ])

        expect(importDirectionViolations(sources)).toContain('ARCH002_KERNEL_DIRECTION')
    })

    it('keeps controlled runtime measurement authority confined to the probe and lifecycle consumer', () => {
        const sources = productionSources()
        const issuerUsers = [...sources]
            .filter(([path, source]) => path !== 'packages/cockpit/src/environment/runtime.ts'
                && /\bissueRuntimeMeasurementProbeAuthority\b/.test(source))
            .map(([path]) => path)
            .sort()
        const consumerUsers = [...sources]
            .filter(([path, source]) => path !== 'packages/cockpit/src/environment/runtime.ts'
                && /\bruntimeMeasurementProbeObservation\b/.test(source))
            .map(([path]) => path)
            .sort()

        expect(issuerUsers).toEqual(['packages/cockpit/src/environment/runtime-probe.ts'])
        expect(consumerUsers).toEqual(['packages/cockpit/src/environment/lifecycle-composition.ts'])
    })

    it('keeps the environment application independent from command adapters', () => {
        const sources = new Map([
            ['packages/cockpit/src/environment/application.ts', "import '../setup/command.js'"],
            ['packages/cockpit/src/setup/command.ts', 'export const setup = true'],
        ])

        expect(importDirectionViolations(sources)).toContain('ARCH002_KERNEL_DIRECTION')
    })

    it('keeps runtime, failure logs, and the application dependency leaf-ward', () => {
        expect(importDirectionViolations(new Map([
            [RUNTIME_MODULE, "import './logs.js'"],
            ['packages/cockpit/src/environment/logs.ts', "import './application.js'"],
            [APPLICATION_MODULE, 'export const application = true'],
        ]))).toContain('ARCH002_KERNEL_DIRECTION')
    })

    it.each([
        [APPLICATION_MODULE, ['issueLifecycleRunContext', 'runUp', 'runSleep'], 'ARCH042_APPLICATION_LIFECYCLE_HOME'],
        [RUNTIME_MODULE, [
            'createRuntimeServiceRevalidationPlan', 'admitRuntimeServiceRevalidation',
            'admitRuntimeServicePlanFailure', 'admitRuntimeServiceInspectFailure',
            'consumeRuntimeServiceFailureForLogs',
        ], 'ARCH044_RUNTIME_RESUME_HOME'],
        [PORTS_MODULE, ['compensateAcquiredPortHolder'], 'ARCH045_PORT_COMPENSATION_HOME'],
        [CLAIMS_MODULE, ['removeExactCoordinationHolder'], 'ARCH046_EXACT_HOLDER_REDUCER_HOME'],
    ] as const)('requires lifecycle facet ownership in %s', (module, facets, code) => {
        const rogue = 'packages/cockpit/src/environment/rogue.ts'
        const implementation = facets.map((facet) => `export function ${facet}() {}`).join('; ')
        const declared = `export const mechanism = { id: 'owner', module: '${module}', exports: ${JSON.stringify(facets)} } as const; ${implementation}`
        const duplicate = `export const mechanism = { id: 'rogue', module: '${rogue}', exports: ${JSON.stringify(facets)} } as const; ${implementation}`

        expect(facetOwnerViolation(new Map([[module, declared]]), module, facets, code)).toEqual([])
        expect(facetOwnerViolation(new Map([[module, declared], [rogue, duplicate]]), module, facets, code)).toEqual([code])
    })

    it.each(['runPreflight', 'runDoctor', 'runLogs', 'runBaselineRecord'])(
        'requires %s to have exactly one application owner',
        (runner) => {
            const rogue = 'packages/cockpit/src/environment/rogue.ts'
            const application = `export const mechanism = { id: 'environment-application', module: '${APPLICATION_MODULE}', exports: ['${runner}'] } as const; export function ${runner}() {}`
            const duplicate = `export const mechanism = { id: 'rogue', module: '${rogue}', exports: ['${runner}'] } as const; export function ${runner}() {}`

            expect(facetOwnerViolation(
                new Map([[APPLICATION_MODULE, application]]),
                APPLICATION_MODULE,
                [runner],
                'ARCH048_APPLICATION_OBSERVATION_HOME',
            )).toEqual([])
            expect(facetOwnerViolation(
                new Map([[APPLICATION_MODULE, application], [rogue, duplicate]]),
                APPLICATION_MODULE,
                [runner],
                'ARCH048_APPLICATION_OBSERVATION_HOME',
            )).toEqual(['ARCH048_APPLICATION_OBSERVATION_HOME'])
        },
    )

    it('keeps the remaining up command confined to the application adapter', () => {
        const up = readFileSync(resolve(ROOT, UP_COMMAND_MODULE), 'utf8')
        const sources = new Map([
            [UP_COMMAND_MODULE, `${up}\nimport { executePlan } from '../environment-exec/execute.js'`],
            [APPLICATION_MODULE, 'export interface UpCommandInput {}; export interface UpCommandAdapters {}; export interface UpCommandResult {}; export interface SleepCommandInput {}; export interface SleepCommandAdapters {}; export interface SleepCommandResult {}'],
        ])

        expect(applicationBoundaryViolations(sources)).toContain('ARCH043_COMMAND_APPLICATION_BOUNDARY')
    })

    it.each([
        'LifecyclePlan',
        'LifecycleProgress',
        'LifecycleStageProjection',
        'LifecycleIssuanceReceipt',
        'LifecycleObservationWindow',
        'RuntimeServiceFailureAuthority',
    ])('does not expose %s through command results', (forbiddenType) => {
        const sources = new Map([
            [APPLICATION_MODULE, `
                export interface UpCommandInput {}
                export interface UpCommandAdapters {}
                export interface UpCommandResult { internal: ${forbiddenType} }
                export interface SleepCommandInput {}
                export interface SleepCommandAdapters {}
                export type SleepCommandResult = { change: 'stopped' }
            `],
        ])

        expect(applicationBoundaryViolations(sources)).toContain('ARCH047_COMMAND_AUTHORITY_ESCAPE')
    })

    it('does not expose an opaque authority property through command results', () => {
        const sources = new Map([
            [APPLICATION_MODULE, `
                export interface UpCommandInput {}
                export interface UpCommandAdapters {}
                export interface UpCommandResult { authority: object }
                export interface SleepCommandInput {}
                export interface SleepCommandAdapters {}
                export type SleepCommandResult = { change: 'stopped' }
            `],
        ])

        expect(applicationBoundaryViolations(sources)).toContain('ARCH047_COMMAND_AUTHORITY_ESCAPE')
    })

    it('requires the exact-holder coordination reducer to stay synchronous and mechanical', () => {
        const claims = `
            export const mechanism = { id: 'environment-claims', module: '${CLAIMS_MODULE}', exports: ['removeExactCoordinationHolder'] } as const
            export async function removeExactCoordinationHolder() { return transactState() }
        `

        expect(applicationBoundaryViolations(new Map([[CLAIMS_MODULE, claims]]))).toContain(
            'ARCH046_EXACT_HOLDER_REDUCER_HOME',
        )
    })

    it('confines lifecycle planning to its exact finite import set', () => {
        const lifecycle = lifecycleSource()
        const sources = new Map([
            ['packages/cockpit/src/environment/lifecycle.ts', `${lifecycle}\nimport { writeFile } from 'node:fs/promises'`],
        ])

        expect(lifecyclePlanningViolations(sources)).toContain('ARCH040_LIFECYCLE_PLANNING_BOUNDARY')
    })

    it('requires the lifecycle planning owner to exist', () => {
        expect(lifecyclePlanningViolations(new Map([
            ['packages/cockpit/src/environment/other.ts', 'export const other = true'],
        ]))).toContain('ARCH040_LIFECYCLE_PLANNING_BOUNDARY')
    })

    it.each([
        ['application', "import './application.js'"],
        ['executor', "import { executePlan } from '../environment-exec/execute.js'"],
        ['lifecycle mutation', "import { recordLifecycleStarted } from './lifecycle-stage.js'"],
        ['lease mutation', "import { releasePortFamily } from './ports.js'"],
        ['coordination mutation', "import { reserveDrain } from './claims.js'"],
        ['dynamic loading', "void import('./runtime.js')"],
    ])('rejects a lifecycle planning %s capability', (_label, addition) => {
        const lifecycle = lifecycleSource()
        expect(lifecyclePlanningViolations(new Map([
            [LIFECYCLE_MODULE, `${lifecycle}\n${addition}`],
        ]))).toContain('ARCH040_LIFECYCLE_PLANNING_BOUNDARY')
    })

    it('requires the exact lifecycle planning declaration and reserves its exported facets', () => {
        const lifecycle = lifecycleSource()
        const wrongDeclaration = lifecycle.replace("id: 'lifecycle-planning'", "id: 'other-planning'")

        expect(lifecyclePlanningViolations(new Map([[LIFECYCLE_MODULE, wrongDeclaration]]))).toContain(
            'ARCH040_LIFECYCLE_PLANNING_BOUNDARY',
        )
        for (const facet of LIFECYCLE_EXPORTS) {
            const duplicateFacet = new Map([
                [LIFECYCLE_MODULE, lifecycle],
                [
                    'packages/cockpit/src/environment/other.ts',
                    `export const mechanism = { id: 'other', module: 'packages/cockpit/src/environment/other.ts', exports: ['${facet}'] } as const; export function ${facet}() {}`,
                ],
            ])

            expect(lifecyclePlanningViolations(duplicateFacet)).toContain('ARCH040_LIFECYCLE_PLANNING_BOUNDARY')
        }
    })

    it.each(['lifecycle.mts', 'lifecycle.cts', 'lifecycle.js'])(
        'does not treat the %s extension variant as the lifecycle planning owner',
        (filename) => {
            expect(lifecyclePlanningViolations(new Map([
                [LIFECYCLE_MODULE, lifecycleSource()],
                [`packages/cockpit/src/environment/${filename}`, 'export function planUp() {}'],
            ]))).toContain('ARCH040_LIFECYCLE_PLANNING_BOUNDARY')
        },
    )

    it('accepts the current lifecycle planning owner', () => {
        const lifecycle = lifecycleSource()

        expect(lifecyclePlanningViolations(new Map([[LIFECYCLE_MODULE, lifecycle]]))).toEqual([])
    })

    it('confines lifecycle issuance consumption to the application and its owner test', () => {
        const sources = new Map([
            [LIFECYCLE_MODULE, 'export function consumeLifecycleIssuance() {}'],
            [
                'packages/cockpit/src/environment/runtime.test.ts',
                "import { consumeLifecycleIssuance } from './lifecycle.js'; consumeLifecycleIssuance()",
            ],
        ])

        expect(lifecycleIssuanceConsumerViolations(sources)).toContain('ARCH041_LIFECYCLE_ISSUANCE_CONSUMER')
    })

    it.each([
        'packages/cockpit/src/environment/lifecycle.mts',
        'packages/cockpit/src/environment/lifecycle.cts',
        'packages/cockpit/src/environment/lifecycle.js',
        'packages/cockpit/src/environment/application.mts',
        'packages/cockpit/src/environment/application.cts',
        'packages/cockpit/src/environment/application.js',
    ])('does not grant lifecycle issuance access to the extension variant %s', (path) => {
        expect(lifecycleIssuanceConsumerViolations(new Map([
            [LIFECYCLE_MODULE, 'export function consumeLifecycleIssuance() {}'],
            [path, "import { consumeLifecycleIssuance } from './lifecycle.js'; consumeLifecycleIssuance({})"],
        ]))).toContain('ARCH041_LIFECYCLE_ISSUANCE_CONSUMER')
    })

    it.each([
        'packages/cockpit/src/environment/application.mts',
        'packages/cockpit/src/environment/lifecycle.test.mts',
    ])('allows an unrelated extension variant at %s', (path) => {
        expect(lifecycleIssuanceConsumerViolations(new Map([
            [LIFECYCLE_MODULE, 'export function consumeLifecycleIssuance() {}'],
            [path, 'export const unrelated = true'],
        ]))).toEqual([])
    })

    it.each([
        [
            'another production module',
            'packages/cockpit/src/environment/runtime.ts',
            "import { consumeLifecycleIssuance } from './lifecycle.js'",
        ],
        [
            'an aliased application import',
            'packages/cockpit/src/environment/application.ts',
            "import { consumeLifecycleIssuance as consume } from './lifecycle.js'",
        ],
        [
            'an application namespace import',
            'packages/cockpit/src/environment/application.ts',
            "import * as lifecycle from './lifecycle.js'",
        ],
        [
            'an application re-export',
            'packages/cockpit/src/environment/application.ts',
            "export { consumeLifecycleIssuance } from './lifecycle.js'",
        ],
        [
            'dynamic application access',
            'packages/cockpit/src/environment/application.ts',
            "void import('./lifecycle.js')",
        ],
        [
            'CommonJS application access',
            'packages/cockpit/src/environment/application.ts',
            "require('./lifecycle.js')",
        ],
    ])('rejects lifecycle issuance consumption through %s', (_label, path, source) => {
        expect(lifecycleIssuanceConsumerViolations(new Map([
            [LIFECYCLE_MODULE, 'export function consumeLifecycleIssuance() {}'],
            [path, source],
        ]))).toContain('ARCH041_LIFECYCLE_ISSUANCE_CONSUMER')
    })

    it.each([
        ['passing the binding', 'sink(consumeLifecycleIssuance)'],
        ['storing the binding', 'const stored = consumeLifecycleIssuance'],
        ['returning the binding', 'function expose() { return consumeLifecycleIssuance }'],
        ['reassigning the binding', 'consumeLifecycleIssuance = replacement'],
        ['using the binding as a callback', '[plan].map(consumeLifecycleIssuance)'],
        ['carrying the binding in an object', 'const carrier = { consumeLifecycleIssuance }'],
        ['carrying the binding in an array', 'const carrier = [consumeLifecycleIssuance]'],
        ['calling the binding optionally', 'consumeLifecycleIssuance?.(plan)'],
    ])('rejects %s outside a direct lifecycle issuance call', (_label, use) => {
        expect(lifecycleIssuanceConsumerViolations(new Map([
            [LIFECYCLE_MODULE, 'export function consumeLifecycleIssuance() {}'],
            [
                'packages/cockpit/src/environment/application.ts',
                `import { consumeLifecycleIssuance } from './lifecycle.js'; ${use}`,
            ],
        ]))).toContain('ARCH041_LIFECYCLE_ISSUANCE_CONSUMER')
    })

    it('allows direct lifecycle issuance imports in the application and owner test', () => {
        expect(lifecycleIssuanceConsumerViolations(new Map([
            [LIFECYCLE_MODULE, 'export function consumeLifecycleIssuance() {}'],
            [
                'packages/cockpit/src/environment/application.ts',
                "import { consumeLifecycleIssuance } from './lifecycle.js'; consumeLifecycleIssuance({})",
            ],
            [
                'packages/cockpit/src/environment/lifecycle.test.ts',
                "import { consumeLifecycleIssuance } from './lifecycle.js'; consumeLifecycleIssuance({})",
            ],
        ]))).toEqual([])
    })

    it('distinguishes direct lifecycle issuance calls from shadowed local bindings', () => {
        expect(lifecycleIssuanceConsumerViolations(new Map([
            [LIFECYCLE_MODULE, 'export function consumeLifecycleIssuance() {}'],
            [
                'packages/cockpit/src/environment/application.ts',
                `import { consumeLifecycleIssuance } from './lifecycle.js'
                 const issuance = consumeLifecycleIssuance(plan)
                 function invoke(consumeLifecycleIssuance: () => void) { consumeLifecycleIssuance() }
                 void issuance`,
            ],
        ]))).toEqual([])
    })

    it('keeps durable drain policy in claims and generic persistence free of lifecycle policy', () => {
        const duplicate = new Map([
            ['packages/cockpit/src/environment/claims.ts', 'const DrainReservationSchema = {}; export function reduceDrain() {}'],
            ['packages/cockpit/src/environment/reclaim.ts', 'export function reduceDrain() {}'],
        ])
        const statePolicy = new Map([
            [STATE_MODULE, 'export function reserveDrain() {}'],
        ])

        expect(coordinationPolicyViolations(duplicate)).toContain('ARCH034_DUPLICATE_COORDINATION_POLICY')
        expect(coordinationPolicyViolations(statePolicy)).toContain('ARCH035_STATE_POLICY_BOUNDARY')
        expect(coordinationPolicyViolations(new Map([
            ['packages/cockpit/src/environment/reclaim.ts', 'export const finish = (value) => value.drain && value.reservationId === value.operationBasis && value.coordinationRevision > 0'],
        ]))).toContain('ARCH034_DUPLICATE_COORDINATION_POLICY')
        expect(coordinationPolicyViolations(new Map([
            ['packages/cockpit/src/environment/reclaim.ts', 'function matchesContinuationDrain(record, expected) { return record.value.drain.reservationId === expected.reservationId && record.value.drain.progressRevision === expected.progressRevision }'],
        ]))).toContain('ARCH034_DUPLICATE_COORDINATION_POLICY')
        expect(coordinationPolicyViolations(new Map([
            ['packages/cockpit/src/environment/reclaim.ts', 'export { reduceDrain as finishDrain } from "./claims.js"'],
        ]))).toContain('ARCH034_DUPLICATE_COORDINATION_POLICY')
        expect(coordinationPolicyViolations(new Map([
            ['packages/cockpit/src/environment/ports.ts', 'export function lease(value) { return value.drain === null }'],
        ]))).toContain('ARCH036_COORDINATION_GUARD_BYPASS')
        expect(coordinationPolicyViolations(new Map([
            [STATE_MODULE, "import { reserveDrain as begin } from './claims.js'; export function persist(value) { return begin(value) }"],
            ['packages/cockpit/src/environment/claims.ts', 'export function reserveDrain() {}'],
        ]))).toContain('ARCH035_STATE_POLICY_BOUNDARY')
        expect(coordinationPolicyViolations(new Map([
            ['packages/cockpit/src/environment/ports.ts', "import { isDrainActive as guard, releaseClaim as release } from './claims.js'; function dead(value) { return guard(value) } export async function leasePortFamily() { return true } export async function releasePortFamily(value) { return release(value) }"],
            ['packages/cockpit/src/environment/claims.ts', 'export function isDrainActive() {} export function releaseClaim() {}'],
        ]))).toContain('ARCH036_COORDINATION_GUARD_BYPASS')
    })

    it('keeps failed reclaim recovery policy calls in their sole consumer', () => {
        const claims = 'export function inspectFailedReclaimRecovery() {} export function consumeFailedReclaimRecovery() {}'

        expect(coordinationPolicyViolations(new Map([
            ['packages/cockpit/src/environment/runtime.ts', "import { inspectFailedReclaimRecovery } from './claims.js'; inspectFailedReclaimRecovery({})"],
            ['packages/cockpit/src/environment/claims.ts', claims],
        ]))).toContain('ARCH034_DUPLICATE_COORDINATION_POLICY')
        expect(coordinationPolicyViolations(new Map([
            ['packages/cockpit/src/environment/reclaim.ts', "import { inspectFailedReclaimRecovery as inspect, consumeFailedReclaimRecovery as consume } from './claims.js'; const authority = true ? inspect({}) : undefined; const recovery = authority ? consume(authority) : undefined"],
            ['packages/cockpit/src/environment/claims.ts', claims],
        ]))).toEqual([])
        for (const source of [
            "import { consumeFailedReclaimRecovery } from './claims.js'",
            "export { inspectFailedReclaimRecovery as inspect } from './claims.js'",
            "export * from './claims.js'",
            "export * as recovery from './claims.js'",
            "import { inspectFailedReclaimRecovery as inspect } from './claims.js'; export { inspect as recovery }",
            "import * as claims from './claims.js'; claims.inspectFailedReclaimRecovery({})",
            "import * as claims from './claims.js'; claims['consumeFailedReclaimRecovery']({})",
            "async function recover() { return (await import('./claims.js')).consumeFailedReclaimRecovery({}) }",
            "import { inspectFailedReclaimRecovery as inspect } from './claims.js'; const alias = inspect",
            "import { inspectFailedReclaimRecovery as inspect } from './claims.js'; function alias() { return inspect }",
            "import { inspectFailedReclaimRecovery as inspect } from './claims.js'; const wrapped = { inspect }",
            "import { inspectFailedReclaimRecovery as inspect } from './claims.js'; const wrapped = [inspect]",
            "import { inspectFailedReclaimRecovery as inspect } from './claims.js'; function recover() { return inspect({}) }",
            "import { inspectFailedReclaimRecovery as inspect } from './claims.js'; const sink = (value) => value; sink(inspect({}))",
            "import { inspectFailedReclaimRecovery as inspect } from './claims.js'; export default inspect({})",
            "import { inspectFailedReclaimRecovery as inspect } from './claims.js'; export const recovery = inspect({})",
            "import { inspectFailedReclaimRecovery as inspect } from './claims.js'; const wrapped = { recovery: inspect({}) }",
            "import { inspectFailedReclaimRecovery as inspect } from './claims.js'; const wrapped = [inspect({})]",
            "import { inspectFailedReclaimRecovery as inspect } from './claims.js'; const wrapped = {}; wrapped.recovery = inspect({})",
        ]) {
            expect(coordinationPolicyViolations(new Map([
                ['packages/cockpit/src/environment/reclaim.ts', source],
                ['packages/cockpit/src/environment/claims.ts', claims],
            ])), source).toContain('ARCH034_DUPLICATE_COORDINATION_POLICY')
        }
    })

    it('rejects process execution, timeout ownership, and compensation execution outside the sole executor', () => {
        const sources = new Map([
            [
                'packages/cockpit/src/environment/runtime.ts',
                "import { spawn } from 'node:child_process'; export function executeCompensation() { setTimeout(() => spawn('git'), 1) }",
            ],
            [
                'packages/cockpit/src/environment-exec/execute.ts',
                "import { spawn } from 'node:child_process'; export function executePlan() { return spawn('git') }",
            ],
        ])

        expect(inspectArchitecture(sources)).toEqual(
            expect.arrayContaining([
                'ARCH022_PROCESS_EXECUTION_HOME',
                'ARCH023_TIMEOUT_OUTPUT_SIGNAL_HOME',
                'ARCH024_COMPENSATION_EXECUTION_HOME',
            ]),
        )
    })

    it('allows the application to invoke compensation implemented by the port owner', () => {
        const sources = new Map([
            [
                PORTS_MODULE,
                `export const mechanism = { id: 'port-leasing', module: '${PORTS_MODULE}', exports: ['compensateAcquiredPortHolder'] } as const; export function compensateAcquiredPortHolder() {}`,
            ],
            [
                APPLICATION_MODULE,
                `import { compensateAcquiredPortHolder } from './ports.js'; export const mechanism = { id: 'environment-application', module: '${APPLICATION_MODULE}', exports: ['runUp'] } as const; export function runUp() { compensateAcquiredPortHolder() }`,
            ],
        ])

        expect(executionBoundaryViolations(sources)).not.toContain('ARCH024_COMPENSATION_EXECUTION_HOME')
    })

    it('rejects executor policy and command modules that call the executor directly', () => {
        const sources = new Map([
            [
                'packages/cockpit/src/environment-exec/execute.ts',
                "export function executePlan(plan: unknown) { return choosePort(plan) }",
            ],
            [
                'packages/cockpit/src/setup/command.ts',
                "import { executePlan } from '../environment-exec/execute.js'; export function setupCommand() { return executePlan({}) }",
            ],
        ])

        expect(inspectArchitecture(sources)).toContain('ARCH025_EXECUTOR_POLICY')
        expect(inspectArchitecture(sources)).toContain('ARCH026_EXECUTE_PLAN_CALLER')
    })

    it('rejects duplicate and dynamically constructed environment code vocabularies outside the contract owner', () => {
        const sources = new Map([
            ['packages/cockpit/src/environment/contract.ts', "export const ENVIRONMENT_CODES = { EXECUTION_TIMEOUT: 'EXECUTION_TIMEOUT' }"],
            ['packages/cockpit/src/environment/other.ts', "type FailureCode = 'EXECUTION_TIMEOUT'; const first = `SETUP_NONE_${kind}`; const second = 'SETUP_' + suffix"],
        ])

        expect(inspectArchitecture(sources)).toContain('ARCH027_ENVIRONMENT_CODE_HOME')
    })

    it('rejects a second immutable JSON snapshot implementation outside its contract owner', () => {
        const sources = new Map([
            ['packages/cockpit/src/environment/contract.ts', 'export function snapshotJson(value: unknown) { return value }'],
            ['packages/cockpit/src/environment/other.ts', 'function copy(value: any) { const result = Object.create(null); for (const key of Object.keys(value)) result[key] = copy(value[key]); return Object.freeze(result) }'],
        ])
        expect(inspectArchitecture(sources)).toContain('ARCH028_JSON_SNAPSHOT_HOME')
    })

    it.each([
        "const code = ['EXECUTION', 'TIMEOUT'].join('_')",
        "const prefix = 'EXECUTION'; const code = `${prefix}_TIMEOUT`",
        "const code = 'EXECUTION'.concat('_', 'TIMEOUT')",
        "const prefix = 'SETUP_'; const code = prefix + 'POSTCHECK_' + 'FAILED'",
        "function code() { const prefix = 'EXECUTION'; return prefix + '_TIMEOUT' }",
        "function bad() { const prefix = 'EXECUTION'; return prefix + '_TIMEOUT' }; function safe() { const prefix = 'SAFE'; return prefix + '_LABEL' }",
    ])('rejects statically constructed environment code ownership bypasses: %s', (source) => {
        expect(environmentCodeViolations(new Map([
            ['packages/cockpit/src/environment/contract.ts', 'export const ENVIRONMENT_CODES = {}'],
            ['packages/cockpit/src/environment/other.ts', source],
        ]))).toContain('ARCH027_ENVIRONMENT_CODE_HOME')
    })

    it('does not claim unrelated constructed text or CLI diagnostics as environment codes', () => {
        expect(environmentCodeViolations(new Map([
            ['packages/cockpit/src/environment/contract.ts', 'export const ENVIRONMENT_CODES = {}'],
            ['packages/cockpit/src/cli.ts', "const cliCode = 'CLI_USAGE_INVALID'; const label = ['EXECUTION', 'TIMEOUT'].join('-')"],
        ]))).toEqual([])
    })

    it('allows several application functions to call the one mechanical executor', () => {
        const sources = new Map([
            ['packages/cockpit/src/environment-exec/execute.ts', 'export function executePlan() {}'],
            [
                'packages/cockpit/src/environment/application.ts',
                "import { executePlan } from '../environment-exec/execute.js'; export const mechanism = { id: 'environment-application', module: 'packages/cockpit/src/environment/application.ts', exports: ['runSetup'] }; export function runSetup(plan: any) { return executePlan(plan) }",
            ],
            [
                'packages/cockpit/src/environment/lifecycle-application.ts',
                "import { executePlan } from '../environment-exec/execute.js'; export const mechanism = { id: 'lifecycle-application', module: 'packages/cockpit/src/environment/lifecycle-application.ts', exports: ['runUp'] }; export function runUp(plan: any) { return executePlan(plan) }",
            ],
        ])

        expect(executionBoundaryViolations(sources)).toEqual([])
    })

    it('allows a declared application module to load and call the executor dynamically', () => {
        const sources = new Map([
            ['packages/cockpit/src/environment-exec/execute.ts', 'export function executePlan() {}'],
            [
                'packages/cockpit/src/environment/application.ts',
                "export const mechanism = { id: 'environment-application', module: 'packages/cockpit/src/environment/application.ts', exports: ['runSetup'] }; export async function runSetup(plan: any) { const execution = await import('../environment-exec/execute.js'); return execution.executePlan(plan) }",
            ],
        ])

        expect(executionBoundaryViolations(sources)).toEqual([])
    })

    it.each([
        "import { executePlan as run } from '../environment-exec/execute.js'; run({})",
        "import * as execution from '../environment-exec/execute.js'; execution['executePlan']({})",
        "import * as execution from '../environment-exec/execute.js'; const key = 'execute' + 'Plan'; execution[key]({})",
        "import * as execution from '../environment-exec/execute.js'; declare const key: string; execution[key]({})",
        "import { executePlan } from '../environment-exec/execute.js'; let run = executePlan; run = () => undefined; run({})",
        "import * as execution from '../environment-exec/execute.js'; const { executePlan: run } = execution; run({})",
        "import { executePlan } from '../environment-exec/execute.js'; const run = executePlan.bind(null); run({})",
        "const { executePlan } = await import('../environment-exec/execute.js'); executePlan({})",
        "import('../environment-exec/execute.js').then(({ executePlan }) => executePlan({}))",
        "require('../environment-exec/execute.js').executePlan({})",
        "const { executePlan } = module.require('../environment-exec/execute.js'); executePlan({})",
    ])('rejects a disguised executePlan call from a command module: %s', (source) => {
        expect(executionBoundaryViolations(new Map([
            ['packages/cockpit/src/setup/command.ts', source],
            ['packages/cockpit/src/environment-exec/execute.ts', 'export function executePlan() {}'],
        ]))).toContain('ARCH026_EXECUTE_PLAN_CALLER')
    })

    it.each([
        "import execution from '../environment-exec/execute.js'",
        "import execution, { executeProbe } from '../environment-exec/execute.js'",
        "import * as execution from '../environment-exec/execute.js'",
        "import '../environment-exec/execute.js'",
        "export { executePlan } from '../environment-exec/execute.js'",
        "export * from '../environment-exec/execute.js'",
        "import execution = require('../environment-exec/execute.js')",
        "import { createRequire } from 'node:module'; const load = createRequire(import.meta.url); load('../environment-exec/execute.js')",
    ])('rejects every runtime executor reference from a command module: %s', (source) => {
        expect(executionBoundaryViolations(new Map([
            ['packages/cockpit/src/setup/command.ts', source],
            ['packages/cockpit/src/environment-exec/execute.ts', 'export function executePlan() {}'],
        ]))).toContain('ARCH026_EXECUTE_PLAN_CALLER')
    })

    it.each([
        "import type { ExecutionPlan } from '../environment-exec/execute.js'",
        "import { type ExecutionPlan } from '../environment-exec/execute.js'",
        "export type { ExecutionPlan } from '../environment-exec/execute.js'",
    ])('permits type-only executor references from a command module: %s', (source) => {
        expect(executionBoundaryViolations(new Map([
            ['packages/cockpit/src/setup/command.ts', source],
            ['packages/cockpit/src/environment-exec/execute.ts', 'export interface ExecutionPlan {}'],
        ]))).not.toContain('ARCH026_EXECUTE_PLAN_CALLER')
    })

    it.each([
        "const terminate = process.kill; terminate(1, 'SIGTERM')",
        "const { kill: terminate } = process; terminate(1, 'SIGTERM')",
        "const terminate = process.kill.bind(process); terminate(1, 'SIGTERM')",
        "process['kill'](1, 'SIGTERM')",
        "process['k' + 'ill'](1, 'SIGTERM')",
        "declare const key: string; process[key](1, 'SIGTERM')",
        'const later = setTimeout; later(() => {}, 1)',
        'const later = globalThis.setTimeout.bind(globalThis); later(() => {}, 1)',
        "globalThis['setInterval'](() => {}, 1)",
        "globalThis['set' + 'Timeout'](() => {}, 1)",
        "import { setTimeout as later } from 'node:timers'; later(() => {}, 1)",
        "process.stdout.write('raw')",
        "const output = process['stderr']; output.write('raw')",
        "process['std' + 'out'].write('raw')",
        "const { stdout: output } = process; output.write('raw')",
        "const emit = process.stdout.write.bind(process.stdout); emit('raw')",
        "import runtime from 'node:process'; runtime.stdout.write('raw')",
        "import * as runtime from 'node:process'; const { stderr: output } = runtime; output.write('raw')",
        "import { setTimeout as later } from 'node:timers/promises'; later(1)",
        "import clocks from 'node:timers'; clocks.setTimeout(() => {}, 1)",
        "globalThis.process.stdout.write('raw')",
        "const runtime = globalThis.process; runtime.kill(1, 'SIGTERM')",
        "const runtime = await import('node:process'); runtime.stdout.write('raw')",
    ])('rejects off-boundary process, timer, and raw-stream bypass: %s', (source) => {
        expect(executionBoundaryViolations(new Map([
            ['packages/cockpit/src/environment/runtime.ts', source],
        ]))).toContain('ARCH023_TIMEOUT_OUTPUT_SIGNAL_HOME')
    })

    it('permits bounded lock backoff only in the state owner', () => {
        const timer = "import { setTimeout as delay } from 'node:timers/promises'; export async function transactState() { const backoffMs = 5; const remainingMs = 5; await delay(Math.min(backoffMs, remainingMs)) }"
        expect(executionBoundaryViolations(new Map([[STATE_MODULE, timer]]))).toEqual([])
        const scopedTimer = timer.replace('transactState', 'withStateScopedLock')
        expect(executionBoundaryViolations(new Map([[STATE_MODULE, scopedTimer]]))).toEqual([])
        expect(executionBoundaryViolations(new Map([[STATE_MODULE,
            scopedTimer.replace('Math.min(backoffMs, remainingMs)', '5')]])))
            .toContain('ARCH023_TIMEOUT_OUTPUT_SIGNAL_HOME')
        expect(executionBoundaryViolations(new Map([[STATE_MODULE,
            scopedTimer.replace('withStateScopedLock', 'unrelated')]])))
            .toContain('ARCH023_TIMEOUT_OUTPUT_SIGNAL_HOME')
        expect(executionBoundaryViolations(new Map([[
            STATE_MODULE,
            "import { setTimeout as delay } from 'node:timers/promises'; export async function transactState() { await delay(5) }",
        ]]))).toContain('ARCH023_TIMEOUT_OUTPUT_SIGNAL_HOME')
        expect(executionBoundaryViolations(new Map([[
            STATE_MODULE,
            "import * as clocks from 'node:timers/promises'; export async function transactState() { await clocks['setTimeout'](5) }",
        ]]))).toContain('ARCH023_TIMEOUT_OUTPUT_SIGNAL_HOME')
        expect(executionBoundaryViolations(new Map([
            [STATE_MODULE, "process.stderr.write('raw')"],
        ]))).toContain('ARCH023_TIMEOUT_OUTPUT_SIGNAL_HOME')
        expect(executionBoundaryViolations(new Map([
            [STATE_MODULE, "export function unrelated() { setInterval(() => {}, 5) }"],
        ]))).toContain('ARCH023_TIMEOUT_OUTPUT_SIGNAL_HOME')
        for (const path of [
            'packages/cockpit/src/environment/claims.ts',
            'packages/cockpit/src/environment/ports.ts',
            'packages/cockpit/src/up/command.ts',
            'packages/cockpit/src/arbitrary.ts',
        ]) {
            expect(executionBoundaryViolations(new Map([[path, timer]]))).toContain('ARCH023_TIMEOUT_OUTPUT_SIGNAL_HOME')
        }
    })

    it('confines bounded release metadata timers to their declared HTTPS owner and exact mechanics', () => {
        const path = 'packages/cockpit/src/freshness.ts'
        const source = productionSources().get(path)
        if (!source) throw new Error('release freshness owner is missing')
        expect(executionBoundaryViolations(new Map([[path, source]]))).toEqual([])
        expect(executionBoundaryViolations(new Map([['packages/cockpit/src/other.ts', source]])))
            .toContain('ARCH023_TIMEOUT_OUTPUT_SIGNAL_HOME')
        for (const [from, to] of [
            ["id: 'release-freshness'", "id: 'other'"],
            ['const TIMEOUT_MS = 2_000', 'const TIMEOUT_MS = Infinity'],
            ['const TIMEOUT_MS = 2_000', 'const TIMEOUT_MS = 2_000_000'],
            ['const MAX_BYTES = 131_072', 'const MAX_BYTES = 131_072_000'],
            ['const observedAt =', 'const TIMEOUT_MS = Infinity; const observedAt ='],
            ['const MAX_BYTES = 131_072', 'const MAX_BYTES = Infinity'],
            ['https://registry.npmjs.org/', 'http://registry.npmjs.org/'],
            ['if (timer) clearTimeout(timer)', 'clearTimeout(timer)'],
            ['if (timer) clearTimeout(timer)\n        controller.abort()', 'void timer'],
            ['}, TIMEOUT_MS)', '}, 0)'],
            ['size > MAX_BYTES', 'false'],
            ['const observedAt =', 'setInterval(() => {}, 1); const observedAt ='],
        ]) {
            const replacement = source.replace(from, to)
            expect(replacement, from).not.toBe(source)
            expect(executionBoundaryViolations(new Map([[path, replacement]])), from)
                .toContain('ARCH023_TIMEOUT_OUTPUT_SIGNAL_HOME')
        }
    })

    it('authenticates the release HTTPS import as syntax rather than a marker', () => {
        const path = 'packages/cockpit/src/freshness.ts'
        const source = productionSources().get(path)
        if (!source) throw new Error('release freshness owner is missing')
        const original = "import { get } from 'node:https'"
        expect(source).toContain(original)
        for (const replacement of [
            `// ${original}\nconst get = () => undefined`,
            `const marker = ${JSON.stringify(original)}; const get = () => undefined`,
            "import { get as localGet } from 'node:https'; const get = localGet",
            "import type { get } from 'node:https'",
            "import { type get } from 'node:https'",
            "import { get, request } from 'node:https'",
            `${original}\n${original}`,
        ]) {
            expect(executionBoundaryViolations(new Map([[path, source.replace(original, replacement)]])), replacement)
                .toContain('ARCH023_TIMEOUT_OUTPUT_SIGNAL_HOME')
        }
    })

    it('confines publication compensation to its declared transaction owner', () => {
        const path = 'packages/cockpit/src/generated-environment/transaction.ts'
        const source = `export const mechanism = { id: 'generated-publication-transaction', module: '${path}', exports: ['runPublicationPlan'] }; function compensate() {}; compensate()`
        expect(executionBoundaryViolations(new Map([[path, source]]))).toEqual([])
        expect(executionBoundaryViolations(new Map([[path, source.replace("id: 'generated-publication-transaction'", "id: 'other'")]])))
            .toContain('ARCH024_COMPENSATION_EXECUTION_HOME')
        expect(executionBoundaryViolations(new Map([['packages/cockpit/src/generated-environment/other.ts', source]])))
            .toContain('ARCH024_COMPENSATION_EXECUTION_HOME')
    })

    it('allows writes through injected CLI I/O', () => {
        expect(executionBoundaryViolations(new Map([
            ['packages/cockpit/src/cli.ts', "export function runCli(io: { stdout: { write(value: string): void } }) { io.stdout.write('ok') }"],
        ]))).toEqual([])
    })

    it('does not mistake a function parameter named process for the Node global', () => {
        expect(executionBoundaryViolations(new Map([
            ['packages/cockpit/src/cli.ts', "interface Injected { stdout: { write(value: string): void } }; export function runCli(process: Injected) { process.stdout.write('ok') }"],
        ]))).toEqual([])
    })

    it.each([
        "import { stdout } from 'node:process'; interface Writer { write(value: string): void }; function run(stdout: Writer) { stdout.write('ok') }",
        "import { process } from './adapter.js'; function run() { return process.stdout }",
        "const setTimeout = (fn: () => void) => fn(); setTimeout(() => {})",
        "import { setTimeout } from './injected-clock.js'; setTimeout(() => {})",
    ])('resolves shadowed and unrelated capability names lexically: %s', (source) => {
        expect(executionBoundaryViolations(new Map([
            ['packages/cockpit/src/environment/runtime.ts', source],
        ]))).toEqual([])
    })

    it.each([
        "process.getBuiltinModule('node:child_process').spawn('git')",
        "process.getBuiltinModule('node:' + 'child_process')['sp' + 'awn']('git')",
        "const moduleName = 'node:' + 'child_process'; process.getBuiltinModule(moduleName).spawn('git')",
        "declare const moduleName: string; process.getBuiltinModule(moduleName).spawn('git')",
        "declare const key: string; process.getBuiltinModule('node:child_process')[key]('git')",
        "const { spawn: run } = process.getBuiltinModule('node:child_process'); run('git')",
        "module['require']('node:child_process').spawn('git')",
        "const { require: load } = module; const { spawn: run } = load('node:child_process'); run('git')",
        "const load = module.require.bind(module); load('node:child_process').spawn('git')",
    ])('rejects off-boundary child-process acquisition: %s', (source) => {
        expect(executionBoundaryViolations(new Map([
            ['packages/cockpit/src/environment/runtime.ts', source],
        ]))).toContain('ARCH022_PROCESS_EXECUTION_HOME')
    })

    it.each([
        "export function executePlan(step: any) { const { labels: renamed } = step; return renamed.mode }",
        "export function executePlan(step: any) { const alias = step; return alias['ports'][0] }",
        "export function executePlan(step: any) { const expected = step.argv; return expected }",
        "export function executePlan(step: any) { const { ['paths']: value } = step; return value }",
    ])('rejects executor policy aliases and computed access', (executor) => {
        expect(executionBoundaryViolations(new Map([
            ['packages/cockpit/src/environment-exec/execute.ts', executor],
        ]))).toContain('ARCH025_EXECUTOR_POLICY')
    })

    it.each([
        [
            'inline decision',
            "export function executePlan(step: any) { if (step.labels.mode === 'host') return 'chosen'; return 'exact' }",
        ],
        [
            'inline arithmetic',
            'export function executePlan(step: any) { return step.ports[0] + 100 }',
        ],
        [
            'renamed helper',
            'function routeValue(step: any) { return step.expected.length ? step.paths[0] : undefined }; export function executePlan(step: any) { return routeValue(step) }',
        ],
    ])('rejects %s that interprets resolved executor policy fields', (_label, executor) => {
        const sources = new Map([
            ['packages/cockpit/src/environment-exec/execute.ts', executor],
        ])

        expect(executionBoundaryViolations(sources)).toContain('ARCH025_EXECUTOR_POLICY')
    })

    it('does not mistake a duplicate mechanism claim for a second parser implementation', () => {
        const sources = new Map([
            [
                'packages/cockpit/src/document/registry.ts',
                "export const mechanism = { id: 'registry-parsing', module: 'packages/cockpit/src/document/registry.ts', exports: ['parseRegistry'] }; export function parseRegistry() { return [] }",
            ],
            [
                'packages/cockpit/src/registry-resolve/parser.ts',
                "export const mechanism = { id: 'registry-parsing', module: 'packages/cockpit/src/registry-resolve/parser.ts', exports: [] }; function decodeSiblingTable() { return [] }",
            ],
        ])

        expect(registryParserViolations(sources)).toEqual([])
    })

    it('detects a second parser implementation exported under a different mechanism', () => {
        const sources = new Map([
            [
                'packages/cockpit/src/document/registry.ts',
                "export const mechanism = { id: 'registry-parsing', module: 'packages/cockpit/src/document/registry.ts', exports: ['parseRegistry'] }; export function parseRegistry() { return [] }",
            ],
            [
                'packages/cockpit/src/registry-resolve/other-parser.ts',
                "export const mechanism = { id: 'other-parser', module: 'packages/cockpit/src/registry-resolve/other-parser.ts', exports: ['parseRegistry'] }; const decodeSiblingTable = () => []; export { decodeSiblingTable as parseRegistry }",
            ],
        ])

        expect(registryParserViolations(sources)).toContain('ARCH020_DUPLICATE_REGISTRY_PARSER')
    })

    it('does not classify a harmless registry parser re-export as a second implementation', () => {
        const sources = new Map([
            [
                'packages/cockpit/src/document/registry.ts',
                "export const mechanism = { id: 'registry-parsing', module: 'packages/cockpit/src/document/registry.ts', exports: ['parseRegistry'] }; export function parseRegistry() { return [] }",
            ],
            [
                'packages/cockpit/src/public-registry.ts',
                "export { parseRegistry } from './document/registry.js'",
            ],
        ])

        expect(registryParserViolations(sources)).toEqual([])
    })

    it('pins the resolver parser binding to the canonical registry module', () => {
        const canonical = new Map([
            [
                'packages/cockpit/src/registry-resolve/command.ts',
                `${RESOLVER_IMPORT_FIXTURE}; ${RESOLVER_TRANSFORM_FIXTURE}; ${RESOLVER_METADATA_FIXTURE}; export async function registryResolveCommand() { ${RESOLVER_SOURCE_FIXTURE}; return resolveRegistry(parseRegistry(registrySource), ${RESOLVER_CONTEXT_FIXTURE}) }`,
            ],
        ])
        const substituted = new Map([
            [
                'packages/cockpit/src/registry-resolve/command.ts',
                `${RESOLVER_IMPORT_FIXTURE.replace("import { parseRegistry, type DocumentedSibling, type RegistryReadResult } from '../document/registry.js'", "import { parseRegistry as parseSiblingTable, type DocumentedSibling, type RegistryReadResult } from './other-parser.js'")}; ${RESOLVER_TRANSFORM_FIXTURE}; ${RESOLVER_METADATA_FIXTURE}; export async function registryResolveCommand() { ${RESOLVER_SOURCE_FIXTURE}; return resolveRegistry(parseSiblingTable(registrySource), ${RESOLVER_CONTEXT_FIXTURE}) }`,
            ],
        ])

        expect(registryParserViolations(canonical)).not.toContain('ARCH021_RESOLVER_PARSER_BINDING')
        expect(registryParserViolations(substituted)).toContain('ARCH021_RESOLVER_PARSER_BINDING')
    })

    it('rejects a canonical parser import shadowed at the resolver call site', () => {
        const sources = new Map([
            [
                'packages/cockpit/src/registry-resolve/command.ts',
                `${RESOLVER_IMPORT_FIXTURE}; ${RESOLVER_TRANSFORM_FIXTURE}; ${RESOLVER_METADATA_FIXTURE}; const decodeSiblingTable = (source: string) => source; export async function registryResolveCommand() { ${RESOLVER_SOURCE_FIXTURE}; { const parseRegistry = decodeSiblingTable; return resolveRegistry(parseRegistry(registrySource), ${RESOLVER_CONTEXT_FIXTURE}) } }`,
            ],
        ])

        expect(registryParserViolations(sources)).toContain('ARCH021_RESOLVER_PARSER_BINDING')
    })

    it('rejects a dead canonical call beside a differently named imported parser', () => {
        const sources = new Map([
            [
                'packages/cockpit/src/registry-resolve/command.ts',
                `${RESOLVER_IMPORT_FIXTURE}; import { readRows } from './other-parser.js'; ${RESOLVER_TRANSFORM_FIXTURE}; ${RESOLVER_METADATA_FIXTURE}; export async function registryResolveCommand() { ${RESOLVER_SOURCE_FIXTURE}; const canonical = resolveRegistry(parseRegistry(registrySource), ${RESOLVER_CONTEXT_FIXTURE}); return readRows(registrySource) ?? canonical }`,
            ],
            [
                'packages/cockpit/src/registry-resolve/other-parser.ts',
                "export const mechanism = { id: 'different-reader', module: 'packages/cockpit/src/registry-resolve/other-parser.ts', exports: ['readRows'] }; export function readRows(source: string) { return source }",
            ],
        ])

        expect(registryParserViolations(sources)).toContain('ARCH021_RESOLVER_PARSER_BINDING')
    })

    it('rejects a private local reader consuming raw registry source after dead evidence', () => {
        const sources = new Map([
            [
                'packages/cockpit/src/registry-resolve/command.ts',
                `${RESOLVER_IMPORT_FIXTURE}; ${RESOLVER_TRANSFORM_FIXTURE}; ${RESOLVER_METADATA_FIXTURE}; function readRows(source: string) { return source }; export async function registryResolveCommand() { ${RESOLVER_SOURCE_FIXTURE}; const canonical = resolveRegistry(parseRegistry(registrySource), ${RESOLVER_CONTEXT_FIXTURE}); return readRows(registrySource) ?? canonical }`,
            ],
        ])

        expect(registryParserViolations(sources)).toContain('ARCH021_RESOLVER_PARSER_BINDING')
    })

    it('rejects raw registry source smuggled through a resolved transform field', () => {
        const sources = new Map([
            [
                'packages/cockpit/src/registry-resolve/command.ts',
                `${RESOLVER_IMPORT_FIXTURE}; ${RESOLVER_TRANSFORM_FIXTURE}; ${RESOLVER_METADATA_FIXTURE}; export async function registryResolveCommand() { ${RESOLVER_SOURCE_FIXTURE}; return resolveRegistry(parseRegistry(registrySource), ${RESOLVER_CONTEXT_FIXTURE.replace('registrySha256,', 'registrySha256: registrySource.trim(),')}) }`,
            ],
        ])

        expect(registryParserViolations(sources)).toContain('ARCH021_RESOLVER_PARSER_BINDING')
    })

    it('rejects raw registry source aliased as the expected registry hash', () => {
        const sources = new Map([
            [
                'packages/cockpit/src/registry-resolve/command.ts',
                `${RESOLVER_IMPORT_FIXTURE}; ${RESOLVER_TRANSFORM_FIXTURE}; const revision = await sourceRevision(input.cockpitSourceRevision); export async function registryResolveCommand() { ${RESOLVER_SOURCE_FIXTURE}; const registrySha256 = registryDecoded; return resolveRegistry(parseRegistry(registrySource), ${RESOLVER_CONTEXT_FIXTURE}) }`,
            ],
        ])

        expect(registryParserViolations(sources)).toContain('ARCH021_RESOLVER_PARSER_BINDING')
    })

    it('rejects raw registry source aliased as the resolved source revision', () => {
        const sources = new Map([
            [
                'packages/cockpit/src/registry-resolve/command.ts',
                `${RESOLVER_IMPORT_FIXTURE}; ${RESOLVER_TRANSFORM_FIXTURE}; const registrySha256 = createHash('sha256').update(registryRead).digest('hex'); const revision = registryDecoded; export async function registryResolveCommand() { ${RESOLVER_SOURCE_FIXTURE}; return resolveRegistry(parseRegistry(registrySource), ${RESOLVER_CONTEXT_FIXTURE}) }`,
            ],
        ])

        expect(registryParserViolations(sources)).toContain('ARCH021_RESOLVER_PARSER_BINDING')
    })

    it('rejects a private reader consuming a decoded registry alias', () => {
        const sources = new Map([
            [
                'packages/cockpit/src/registry-resolve/command.ts',
                `${RESOLVER_IMPORT_FIXTURE}; ${RESOLVER_TRANSFORM_FIXTURE}; ${RESOLVER_METADATA_FIXTURE}; function readRows(source: string) { return source }; export async function registryResolveCommand() { ${RESOLVER_SOURCE_FIXTURE}; const registryDecoded = decodeInput(registryRead); const canonical = resolveRegistry(parseRegistry(registrySource), ${RESOLVER_CONTEXT_FIXTURE}); return readRows(registryDecoded) ?? canonical }`,
            ],
        ])

        expect(registryParserViolations(sources)).toContain('ARCH021_RESOLVER_PARSER_BINDING')
    })

    it('detects dynamic imports that reverse the kernel direction', () => {
        const sources = new Map([
            ['packages/cockpit/src/schema.ts', "export async function load() { await import('./document/command.js') }"],
            ['packages/cockpit/src/document/command.ts', 'export const command = true'],
        ])

        expect(importDirectionViolations(sources)).toContain('ARCH002_KERNEL_DIRECTION')
    })

    it('resolves and classifies an mts command edge that reverses the kernel direction', () => {
        const sources = new Map([
            ['packages/cockpit/src/schema.mts', "import './document/command.mjs'"],
            ['packages/cockpit/src/document/command.mts', 'export const command = true'],
        ])

        expect(importDirectionViolations(sources)).toContain('ARCH002_KERNEL_DIRECTION')
    })

    it('applies command-table and handler direction rules to mts modules', () => {
        const sources = new Map([
            ['packages/cockpit/src/command-table.mts', "import './document/command.mjs'"],
            [
                'packages/cockpit/src/document/command.mts',
                "import '../command-table.mjs'; import '../cli.mjs'",
            ],
            ['packages/cockpit/src/cli.mts', 'export const cli = true'],
        ])

        expect(importDirectionViolations(sources)).toEqual(
            expect.arrayContaining(['ARCH003_COMMAND_TABLE_HANDLER_IMPORT', 'ARCH004_HANDLER_REVERSE_IMPORT']),
        )
    })

    it('resolves cjs specifiers to cts sources when checking cycles', () => {
        const sources = new Map([
            ['packages/cockpit/src/a.cts', "require('./b.cjs')"],
            ['packages/cockpit/src/b.cts', "require('./a.cjs')"],
        ])

        expect(importDirectionViolations(sources)).toContain('ARCH001_CYCLE')
    })

    it('detects a CommonJS require alias that reverses the kernel direction', () => {
        const sources = new Map([
            [
                'packages/cockpit/src/schema.cjs',
                "const load = require; load('./document/command.cjs')",
            ],
            ['packages/cockpit/src/document/command.cjs', 'exports.command = true'],
        ])

        expect(importDirectionViolations(sources)).toContain('ARCH002_KERNEL_DIRECTION')
    })

    it('detects a bound CommonJS require alias that reverses the kernel direction', () => {
        const sources = new Map([
            [
                'packages/cockpit/src/schema.cts',
                "const load = module.require.bind(module); load('./document/command.cjs')",
            ],
            ['packages/cockpit/src/document/command.cts', 'exports.command = true'],
        ])

        expect(importDirectionViolations(sources)).toContain('ARCH002_KERNEL_DIRECTION')
    })

    it('keeps ordinary descriptor properties outside CommonJS global references', () => {
        expect(unsupportedCommonJsSyntax(`
            const descriptor = { module: 'owner.ts', exports: ['apply'] }
            const owned = descriptor.exports
            const owner = descriptor.module
        `)).toBe(false)
    })

    it.each([
        `interface Descriptor { readonly module: string; exports: readonly string[]; require: string }`,
        `type Descriptor = { module: string }; const descriptor = { module: 'synthetic.mjs' }`,
        `const { module, exports: publicNames, require: loaderName } = descriptor; const receipt = { module, exports: publicNames, require: loaderName }`,
        `const { module: ownerModule } = descriptor; const receipt = { module: ownerModule }`,
        `const descriptor = { module: 'synthetic.mjs', exports: [], require: 'synthetic' }`,
    ])('models descriptor declaration and binding roles without CommonJS flow: %s', (source) => {
        expect(unsupportedCommonJsSyntax(source)).toBe(false)
    })

    it("rejects an unmodelled bracketed CommonJS require alias", () => {
        const sources = new Map([
            [
                'packages/cockpit/src/schema.cts',
                "const load = module['require']; load('./document/command.cjs')",
            ],
            ['packages/cockpit/src/document/command.cts', 'exports.command = true'],
        ])

        expect(inspectArchitecture(sources)).toContain('ARCH021_UNMODELLED_COMMONJS')
    })

    it.each([
        "const { require: load } = module; load('./document/command.cjs')",
        "module.require.call(module, './document/command.cjs')",
        "module.require.apply(module, ['./document/command.cjs'])",
        "const load = require; load.call(null, './document/command.cjs')",
        "const load = require; load.apply(null, ['./document/command.cjs'])",
        "const moduleApi = module; moduleApi.require('./document/command.cjs')",
        "const loader = { load: module.require }; loader.load('./document/command.cjs')",
        "const load = require; const loader = { load }; loader.load('./document/command.cjs')",
    ])('fails closed on an unmodelled CommonJS property flow: %s', (schema) => {
        const sources = new Map([
            ['packages/cockpit/src/schema.cts', schema],
            ['packages/cockpit/src/document/command.cts', 'exports.command = true'],
        ])

        expect(inspectArchitecture(sources)).toContain('ARCH021_UNMODELLED_COMMONJS')
    })

    it('keeps modelled CommonJS load syntax under the graph rules', () => {
        const sources = new Map([
            ['packages/cockpit/src/schema.cts', "module.require('./document/command.cjs')"],
            ['packages/cockpit/src/document/command.cts', 'exports.command = true'],
        ])

        expect(inspectArchitecture(sources)).toContain('ARCH002_KERNEL_DIRECTION')
        expect(inspectArchitecture(sources)).not.toContain('ARCH021_UNMODELLED_COMMONJS')
    })

    it('fails closed on computed dynamic imports in the production graph', () => {
        const sources = new Map([
            [
                'packages/cockpit/src/schema.ts',
                "export async function load(name: string) { await import(`./document/${name}.js`) }",
            ],
        ])

        expect(importDirectionViolations(sources)).toContain('ARCH017_COMPUTED_DYNAMIC_IMPORT')
    })

    it('detects relative createRequire edges that reverse the kernel direction', () => {
        const sources = new Map([
            [
                'packages/cockpit/src/schema.ts',
                "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url); require('./document/command.js')",
            ],
            ['packages/cockpit/src/document/command.ts', 'export const command = true'],
        ])

        expect(importDirectionViolations(sources)).toContain('ARCH002_KERNEL_DIRECTION')
    })

    it.each([
        "const moduleApi = require('node:module')",
        "const moduleApi = module.require('node:module')",
    ])('detects createRequire edges reached through a CommonJS module-object alias: %s', (moduleBinding) => {
        const sources = new Map([
            [
                'packages/cockpit/src/schema.ts',
                `${moduleBinding}; const load = moduleApi.createRequire(import.meta.url); load('./document/command.js')`,
            ],
            ['packages/cockpit/src/document/command.ts', 'export const command = true'],
        ])

        expect(importDirectionViolations(sources)).toContain('ARCH002_KERNEL_DIRECTION')
    })

    it.each([
        "require('node:module').createRequire(import.meta.url)",
        "module.require('node:module').createRequire(import.meta.url)",
    ])('detects createRequire edges reached through direct property access: %s', (factory) => {
        const sources = new Map([
            [
                'packages/cockpit/src/schema.ts',
                `const load = ${factory}; load('./document/command.js')`,
            ],
            ['packages/cockpit/src/document/command.ts', 'export const command = true'],
        ])

        expect(importDirectionViolations(sources)).toContain('ARCH002_KERNEL_DIRECTION')
    })

    it('detects relative createRequire edges when the factory import is aliased', () => {
        const sources = new Map([
            [
                'packages/cockpit/src/schema.ts',
                "import { createRequire as makeRequire } from 'node:module'; const load = makeRequire(import.meta.url); load('./document/command.js')",
            ],
            ['packages/cockpit/src/document/command.ts', 'export const command = true'],
        ])

        expect(importDirectionViolations(sources)).toContain('ARCH002_KERNEL_DIRECTION')
    })

    it.each([
        "import * as moduleApi from 'node:module'; const load = moduleApi.createRequire(import.meta.url); load('./document/command.js')",
        "const { createRequire: makeRequire } = require('node:module'); const load = makeRequire(import.meta.url); load('./document/command.js')",
    ])('detects a supported createRequire binding: %s', (schema) => {
        const sources = new Map([
            ['packages/cockpit/src/schema.ts', schema],
            ['packages/cockpit/src/document/command.ts', 'export const command = true'],
        ])

        expect(importDirectionViolations(sources)).toContain('ARCH002_KERNEL_DIRECTION')
    })

    it('names command writers and execution-edge reclassification', () => {
        const sources = new Map([
            [
                'packages/cockpit/src/document/command.ts',
                "import { writeFile } from 'node:fs/promises'; interface OutcomeBase { artifact: string; destination: string; diagnostics: []; status: number }",
            ],
            [
                'packages/cockpit/src/cli.ts',
                "async function executeOutcome(outcome: unknown) { gaps(outcome); await writeFile('x', 'y', { flag: 'wx' }) }",
            ],
        ])

        expect(boundaryViolations(sources)).toEqual(
            expect.arrayContaining(['ARCH006_COMMAND_WRITES', 'ARCH009_EXECUTION_RECLASSIFIES']),
        )
    })

    it('admits only the exact invocation publication callback after handler dispatch', () => {
        const sources = productionSources()
        const path = 'packages/cockpit/src/cli.ts'
        const source = sources.get(path)
        if (!source) throw new Error('CLI owner is missing')
        expect(boundaryViolations(sources)).toEqual([])
        for (const [from, to] of [
            ['return exitCode', 'parseRegistry(outcome); return exitCode'],
            ['finish(outcome!.status, outcome!)', 'finish(0, outcome!)'],
            ['finish(outcome!.status)', 'finish(0)'],
        ]) {
            const planted = new Map(sources)
            const replacement = source.replace(from, to)
            expect(replacement).not.toBe(source)
            planted.set(path, replacement)
            expect(boundaryViolations(planted)).toContain('ARCH009_EXECUTION_RECLASSIFIES')
        }
    })

    it('names decision helpers introduced after handler dispatch', () => {
        const sources = new Map([
            [
                'packages/cockpit/src/document/command.ts',
                'interface OutcomeBase { artifact: string; destination: string; diagnostics: []; status: number }',
            ],
            [
                'packages/cockpit/src/cli.ts',
                "async function executeOutcome(outcome: unknown) { await writeFile('x', 'y', { flag: 'wx' }) }\nasync function runCli() { outcome = await handlers.document({}); parseRegistry(outcome); return outcome.status }",
            ],
        ])

        expect(boundaryViolations(sources)).toContain('ARCH009_EXECUTION_RECLASSIFIES')
    })

    it('finds the handler boundary structurally across formatting changes', () => {
        const sources = new Map([
            [
                'packages/cockpit/src/document/command.ts',
                'interface OutcomeBase { artifact: string; destination: string; diagnostics: []; status: number }',
            ],
            [
                'packages/cockpit/src/cli.ts',
                "async function executeOutcome(outcome: unknown) { await writeFile('x', 'y', { flag: 'wx' }) }\nasync function runCli() { outcome =\n await handlers[definition.handler]({}); parseRegistry(outcome) }",
            ],
        ])

        expect(boundaryViolations(sources)).toContain('ARCH009_EXECUTION_RECLASSIFIES')
    })

    it.each([
        "async function executeOutcome(outcome: unknown) { await writeFile('x', 'y', { flag: 'wx' }) }",
        "async function executeOutcome(outcome: unknown) { await writeFile('x', 'y', { flag: 'wx' }) }\nasync function runCli() { outcome = await handlers[definition.handler]({}); parseRegistry(outcome); outcome = await handlers[definition.handler]({}) }",
        "async function executeOutcome(outcome: unknown) { await writeFile('x', 'y', { flag: 'wx' }) }\nasync function runCli() { outcome = await handlers[definition.handler]({}); outcome = usageOutcome('X', 'x') }",
        "async function executeOutcome(outcome: unknown) { await writeFile('x', 'y', { flag: 'wx' }) }\nasync function runCli() { outcome = await handlers[definition.handler]({}) || usageOutcome('X', 'x') }",
        "async function executeOutcome(outcome: unknown) { await writeFile('x', 'y', { flag: 'wx' }) }\nasync function runCli() { try { outcome = await handlers[definition.handler]({}) } catch (error) { if (outcome.status) outcome = usageOutcome('X', 'x') } }",
    ])('fails closed when the dispatch contract is missing or replaced: %s', (cli) => {
        const sources = new Map([
            [
                'packages/cockpit/src/document/command.ts',
                'interface OutcomeBase { artifact: string; destination: string; diagnostics: []; status: number }',
            ],
            ['packages/cockpit/src/cli.ts', cli],
        ])

        expect(boundaryViolations(sources)).toContain('ARCH009_EXECUTION_RECLASSIFIES')
    })

    it('rejects an arbitrary decision helper at the mechanical execution edge', () => {
        const sources = new Map([
            [
                'packages/cockpit/src/document/command.ts',
                'interface OutcomeBase { artifact: string; destination: string; diagnostics: []; status: number }',
            ],
            [
                'packages/cockpit/src/cli.ts',
                "async function executeOutcome(outcome: unknown) { applyPolicy(outcome); await writeFile('x', 'y', { flag: 'wx' }) }",
            ],
        ])

        expect(boundaryViolations(sources)).toContain('ARCH009_EXECUTION_RECLASSIFIES')
    })

    it.each([
        'applyPolicy?.(outcome)',
        '(applyPolicy)(outcome)',
        "globalThis['applyPolicy'](outcome)",
        'const message = `policy: ${applyPolicy(outcome)}`',
        'const message = `policy: ${applyPolicy({ outcome })}`',
        'const destination = outcome.status === 0 ? outcome.destination : null',
    ])('rejects a disguised decision helper at the execution edge: %s', (decision) => {
        const sources = new Map([
            [
                'packages/cockpit/src/document/command.ts',
                'interface OutcomeBase { artifact: string; destination: string; diagnostics: []; status: number }',
            ],
            [
                'packages/cockpit/src/cli.ts',
                `async function executeOutcome(outcome: unknown) { ${decision}; await writeFile('x', 'y', { flag: 'wx' }) }`,
            ],
        ])

        expect(boundaryViolations(sources)).toContain('ARCH009_EXECUTION_RECLASSIFIES')
    })

    it.each([
        "outcome.destination = '/tmp/other'",
        "await writeFile([outcome.destination, null][outcome.status], outcome.artifact, { flag: 'wx' })",
    ])('rejects execution-edge policy without a helper call: %s', (decision) => {
        const sources = new Map([
            [
                'packages/cockpit/src/document/command.ts',
                'interface OutcomeBase { artifact: string; destination: string; diagnostics: []; status: number }',
            ],
            [
                'packages/cockpit/src/cli.ts',
                `async function executeOutcome(outcome: any) { ${decision}; await writeFile(outcome.destination, outcome.artifact, { flag: 'wx' }) }`,
            ],
        ])

        expect(boundaryViolations(sources)).toContain('ARCH009_EXECUTION_RECLASSIFIES')
    })

    it.each([
        "const marker = \"writeFile(outcome.destination, outcome.artifact, { flag: 'wx' })\"",
        "await writeFile('/different/path', 'different bytes', { flag: 'wx' })",
        "await writeFile('/different/path', 'different bytes', { flag: 'wx' }); await writeFile(outcome.destination, outcome.artifact, { flag: 'wx' })",
    ])('rejects marker text or replacement bytes at the execution edge: %s', (execution) => {
        const sources = new Map([
            [
                'packages/cockpit/src/document/command.ts',
                'interface OutcomeBase { artifact: string; destination: string; diagnostics: []; status: number }',
            ],
            ['packages/cockpit/src/cli.ts', `async function executeOutcome(outcome: any) { ${execution} }`],
        ])

        expect(boundaryViolations(sources)).toContain('ARCH010_EXECUTION_NOT_MECHANICAL')
    })

    it('ignores braces in string literals while locating the real mechanical write', () => {
        const sources = new Map([
            [
                'packages/cockpit/src/document/command.ts',
                'interface OutcomeBase { artifact: string; destination: string; diagnostics: []; status: number }',
            ],
            [
                'packages/cockpit/src/cli.ts',
                "async function executeOutcome(outcome: any) { const marker = '}'; await writeFile(outcome.destination, outcome.artifact, { flag: 'wx' }) }",
            ],
        ])

        expect(boundaryViolations(sources)).not.toContain('ARCH010_EXECUTION_NOT_MECHANICAL')
    })

    it('rejects post-dispatch outcome policy expressed as a conditional', () => {
        const sources = new Map([
            [
                'packages/cockpit/src/document/command.ts',
                'interface OutcomeBase { artifact: string; destination: string; diagnostics: []; status: number }',
            ],
            [
                'packages/cockpit/src/cli.ts',
                "async function executeOutcome(outcome: any) { await writeFile(outcome.destination, outcome.artifact, { flag: 'wx' }) }\nasync function runCli() { outcome = await handlers[definition.handler]({}); outcome = outcome.status ? usageOutcome('X', 'x') : outcome }",
            ],
        ])

        expect(boundaryViolations(sources)).toContain('ARCH009_EXECUTION_RECLASSIFIES')
    })

    it('discovers a second implementation from declarations beside the implementations', () => {
        const sources = new Map([
            [
                'packages/cockpit/src/a.ts',
                "export const mechanism = { id: 'same-mechanism', module: 'packages/cockpit/src/a.ts' } as const",
            ],
            [
                'packages/cockpit/src/b.ts',
                "export const mechanism = { id: 'same-mechanism', module: 'packages/cockpit/src/b.ts' } as const",
            ],
        ])

        expect(ownershipViolations(sources)).toContain('ARCH013_DUPLICATE_MECHANISM')
    })

    it('rejects missing, mislocated, and nonstandard implementation declarations', () => {
        const sources = new Map([
            ['packages/cockpit/src/schema.ts', 'export const CockpitConfig = {}'],
            [
                'packages/cockpit/src/a.ts',
                "export const mechanism = { id: 'mislocated', module: 'packages/cockpit/src/b.ts' } as const",
            ],
            ['packages/cockpit/src/b.ts', 'export const implementation = true'],
            ['packages/cockpit/src/cli.ts', 'export async function runCli() {}'],
            [
                'packages/cockpit/libexec/validate-harness-evidence.mjs',
                "export const HARNESS_EVIDENCE_MECHANISM = 'packages/cockpit/libexec/validate-harness-evidence.mjs'",
            ],
        ])

        expect(ownershipViolations(sources)).toEqual(
            expect.arrayContaining([
                'ARCH012_DECLARATION_NOT_LOCAL',
                'ARCH015_NONSTANDARD_DECLARATION',
                'ARCH016_IMPLEMENTATION_OWNER_MISSING',
            ]),
        )
    })

    it.each([
        "// export const mechanism = { id: 'fake', module: 'packages/cockpit/src/policy.ts' } as const\nexport default function applyPolicy() {}",
        "const marker = \"export const mechanism = { id: 'fake', module: 'packages/cockpit/src/policy.ts' } as const\"; export default class Policy {}",
        'const applyPolicy = () => true; export { applyPolicy }',
    ])('rejects pseudo-declarations and every real export form: %s', (source) => {
        expect(ownershipViolations(new Map([['packages/cockpit/src/policy.ts', source]]))).toContain(
            'ARCH016_IMPLEMENTATION_OWNER_MISSING',
        )
    })

    it.each([
        'export const applyPolicy = () => true',
        'export class Policy {}',
        'export enum Policy { Strict }',
        'export namespace Policy { export const strict = true }',
    ])('requires local ownership for exported implementations: %s', (source) => {
        expect(ownershipViolations(new Map([['packages/cockpit/src/policy.ts', source]]))).toContain(
            'ARCH016_IMPLEMENTATION_OWNER_MISSING',
        )
    })

    it.each([
        'module.exports = function applyPolicy() {}',
        'exports.applyPolicy = function applyPolicy() {}',
    ])('requires local ownership for CommonJS implementation exports: %s', (source) => {
        expect(ownershipViolations(new Map([['packages/cockpit/src/policy.cts', source]]))).toContain(
            'ARCH016_IMPLEMENTATION_OWNER_MISSING',
        )
    })

    it.each([
        'Object.assign(exports, { applyPolicy() {} })',
        "Object.defineProperty(exports, 'applyPolicy', { value() {} })",
    ])('rejects an unmodelled CommonJS export mutation: %s', (source) => {
        expect(inspectArchitecture(new Map([['packages/cockpit/src/policy.cts', source]]))).toContain(
            'ARCH021_UNMODELLED_COMMONJS',
        )
    })

    it('keeps modelled CommonJS assignment exports under the ownership rules', () => {
        const source = 'exports.applyPolicy = function applyPolicy() {}'

        expect(inspectArchitecture(new Map([['packages/cockpit/src/policy.cts', source]]))).toContain(
            'ARCH016_IMPLEMENTATION_OWNER_MISSING',
        )
        expect(inspectArchitecture(new Map([['packages/cockpit/src/policy.cts', source]]))).not.toContain(
            'ARCH021_UNMODELLED_COMMONJS',
        )
    })

    it.each([
        'export declare enum Policy { Strict }',
        'export declare namespace Policy { const strict: true }',
    ])('rejects ownership declarations for ambient exports that emit no runtime value: %s', (ambientExport) => {
        const source = [
            "export const mechanism = { id: 'policy', module: 'packages/cockpit/src/policy.ts', exports: ['Policy'] } as const",
            ambientExport,
        ].join('\n')

        expect(ownershipViolations(new Map([['packages/cockpit/src/policy.ts', source]]))).toContain(
            'ARCH019_DECLARED_IMPLEMENTATION_MISSING',
        )
    })

    it('rejects wildcard re-exports even when a mechanism declares the wildcard token', () => {
        const source = [
            "export const mechanism = { id: 'policy', module: 'packages/cockpit/src/policy.ts', exports: ['*'] } as const",
            "export * from './policy-implementation.js'",
        ].join('\n')

        expect(ownershipViolations(new Map([['packages/cockpit/src/policy.ts', source]]))).toContain(
            'ARCH020_WILDCARD_REEXPORT',
        )
    })

    it('does not let one valid declaration mask a second nonstandard mechanism export', () => {
        const source =
            "export const IMPLEMENTED_MECHANISMS = Object.freeze(['declared']); export const SECOND_MECHANISM = 'undeclared'"

        expect(ownershipViolations(new Map([['scripts/policy.mjs', source]]))).toContain(
            'ARCH015_NONSTANDARD_DECLARATION',
        )
    })

    it.each([
        'export function extraImplementation() {}',
        'export class ExtraImplementation {}',
        'const extraImplementation = () => true; export { extraImplementation }',
    ])('requires every implementation export beside a valid declaration to be named: %s', (extra) => {
        const source = [
            "export const mechanism = { id: 'declared', module: 'packages/cockpit/src/policy.ts', exports: ['declaredImplementation'] } as const",
            'export const declaredImplementation = () => true',
            extra,
        ].join('\n')

        expect(ownershipViolations(new Map([['packages/cockpit/src/policy.ts', source]]))).toContain(
            'ARCH016_IMPLEMENTATION_OWNER_MISSING',
        )
    })

    it('ignores unrelated partial source graphs in work ownership checks', () => {
        expect(workArchitectureViolations(new Map([
            ['packages/cockpit/src/cli.ts', 'export function runCli() { return undefined }'],
            ['packages/cockpit/src/diagnostics.ts', 'export const code = 1'],
        ]))).toEqual([])
    })

    it('accepts the declared work and grading decision owners', () => {
        expect(workArchitectureViolations(workOwnerFixture())).toEqual([])
    })

    it.each([
        ['work-order parser', 'parseWorkOrder'],
        ['work-order state store', 'readWorkOrderState'],
        ['work-order orchestration', 'runWorkApplication'],
        ['work-order composition', 'createConfiguredWorkApplicationComposition'],
        ['work-order verifier', 'verifyWorkOrder'],
        ['work-order completion writer', 'completeWorkOrder'],
        ['browser runtime', 'resolveBrowserRuntime'],
        ['testing gate classifier', 'createGateRegistry'],
        ['testing run verdict', 'classifyRun'],
    ])('rejects a second declared %s owner through an aliased export', (_label, facet) => {
        const sources = workOwnerFixture()
        const rogue = 'packages/cockpit/src/rogue-owner.ts'
        sources.set(rogue, [
            `export const mechanism = { id: 'rogue-owner', module: '${rogue}', exports: ['${facet}'] } as const`,
            `const substitute = () => undefined; export { substitute as ${facet} }`,
        ].join('\n'))

        expect(workArchitectureViolations(sources)).toContain('ARCH059_WORK_OWNER')
    })

    it('rejects a direct CLI binding to a work-order leaf even when aliased', () => {
        const sources = workOwnerFixture()
        sources.set('packages/cockpit/src/cli.ts', [
            "import { parseWorkOrder as decode } from './work-orders/contract.js'",
            'export function runCli(bytes: Uint8Array) { return decode(bytes) }',
        ].join('\n'))

        expect(workArchitectureViolations(sources)).toContain('ARCH060_WORK_CLI_BOUNDARY')
    })

    it('rejects dead work application imports that no CLI handler reaches', () => {
        const sources = workOwnerFixture()
        sources.set('packages/cockpit/src/cli.ts', [
            "import { runWorkApplication } from './work-orders/application.js'",
            "import { createConfiguredWorkApplicationComposition } from './work-orders/composition.js'",
            'void runWorkApplication; void createConfiguredWorkApplicationComposition',
            'export function runCli() { return undefined }',
        ].join('\n'))

        expect(workArchitectureViolations(sources)).toContain('ARCH060_WORK_CLI_BOUNDARY')
    })

    it('accepts an invoked CLI boundary bound to the exact application and composition exports', () => {
        const sources = workOwnerFixture()
        sources.set('packages/cockpit/src/cli.ts', [
            'async function configured(input: unknown) {',
            "  const { createConfiguredWorkApplicationComposition: compose } = await import('./work-orders/composition.js')",
            "  const { runWorkApplication: run } = await import('./work-orders/application.js')",
            '  const configured = await compose(input)',
            '  return run(input, configured)',
            '}',
            'export function runCli(input: unknown) { return configured(input) }',
        ].join('\n'))

        expect(workArchitectureViolations(sources)).not.toContain('ARCH060_WORK_CLI_BOUNDARY')
    })

    it('rejects a browser command-to-command edge through an aliased import', () => {
        const sources = new Map([
            [
                'packages/cockpit/src/browser/commands.ts',
                "import { setupCommand as invoke } from '../setup/command.js'; export function executeBrowserCommand() { return invoke() }",
            ],
            ['packages/cockpit/src/setup/command.ts', 'export function setupCommand() {}'],
        ])

        expect(importDirectionViolations(sources)).toContain('ARCH005_PEER_COMMAND_IMPORT')
    })
})

describe('maintainer reference dependency controls', () => {
    it.each([
        ['scripts/diagnostic-inventory.mjs', "import './docs-lint.mjs'", 'scripts/docs-lint.mjs'],
        ['packages/cockpit/src/references/generate.ts', "import '../../../../scripts/diagnostic-inventory.mjs'", 'scripts/diagnostic-inventory.mjs'],
        ['packages/cockpit/src/references/generate.ts', "import ts from 'typescript'", 'typescript'],
    ])('refuses reversed maintainer reference dependency in %s', (path, body, dependency) => {
        const sources = new Map([[path, body], [dependency, '']])
        expect(referenceArchitectureViolations(sources)).toContain('ARCH058_REFERENCE_GRAPH')
    })

    it('rejects an unbounded loader or a reference import before build authentication', () => {
        const path = 'scripts/diagnostic-inventory.mjs'
        const source = readFileSync(resolve(ROOT, path), 'utf8')
        for (const [from, to] of [
            ["join(root, 'packages/cockpit/dist/references/generate.js')", "join(root, 'other.js')"],
            ['await authenticateBuiltReferenceOwner(record)', 'void record'],
        ]) {
            expect(source).toContain(from)
            expect(importDirectionViolations(new Map([[path, source.replace(from, to)]]))).toContain('ARCH017_COMPUTED_DYNAMIC_IMPORT')
        }
    })

    it('keeps the diagnostic scanner and shared AST helper implementations at one maintainer owner', () => {
        const sources = productionSources()
        const owner = 'scripts/diagnostic-inventory.mjs'
        for (const name of ['diagnosticInventory', 'productionTypeScriptPaths', 'typeScriptSource', 'exported']) {
            const implementations = [...sources].filter(([, body]) => {
                const file = ts.createSourceFile('source.ts', body, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
                return file.statements.some(node => ts.isFunctionDeclaration(node) && node.name?.text === name)
            }).map(([path]) => path)
            expect(implementations, name).toEqual([owner])
        }
        const manifest = JSON.parse(readFileSync(resolve(ROOT, 'packages/cockpit/package.json'), 'utf8'))
        expect(manifest.files).not.toContain('scripts')
        expect(referenceArchitectureViolations(sources)).toEqual([])
    })
})

describe('guard architecture controls', () => {
    const modulePath = (name: string) => `packages/cockpit/src/${name}`

    it('accepts the shipped guard owners, independent representation and actual field consumers', () => {
        expect(guardArchitectureViolations(productionSources())).toEqual([])
    })

    it('does not mistake diagnostic vocabulary for policy authority', () => {
        expect(guardArchitectureViolations(new Map([[modulePath('diagnostic.ts'), "const message = 'protectedBranches evaluateGuard parseGuardInput'" ]]))).toEqual([])
    })

    it.each([
        ['parseGuardInput', 'invocation-parser'],
        ['evaluateGuard', 'evaluator'],
        ['normalizeGuardHost', 'host'],
        ['runGuardEvaluationApplication', 'application'],
        ['resolveOrdinaryInvocation', 'command-table'],
    ])('rejects a second %s authority even under another mechanism', (facet, label) => {
        const path = modulePath('duplicate.ts')
        const source = `export const mechanism = { id: 'other-${label}', module: '${path}', exports: ['${facet}'] } as const; export function ${facet}() { return true }`
        expect(inspectArchitecture(new Map([[path, source]]))).toContain('ARCH051_GUARD_OWNER')
    })

    it.each([
        ['schema.ts', "import { commands } from './command-table.js'", 'command-table.ts'],
        ['registry-derivation.ts', "import { commands } from './command-table.js'", 'command-table.ts'],
        ['cli.ts', "import { evaluateGuard } from './guards/evaluator.js'", 'guards/evaluator.ts'],
        ['environment/generated-application.ts', "import { parseGuardInput } from '../guards/invocation-parser.js'", 'guards/invocation-parser.ts'],
        ['guards/evaluator.ts', "import { runGuardEvaluationApplication } from '../environment/application.js'", 'environment/application.ts'],
    ])('rejects guard dependency reversal in %s', (importer, source, target) => {
        expect(inspectArchitecture(new Map([[modulePath(importer), source], [modulePath(target), '']]))).toContain('ARCH052_GUARD_GRAPH')
    })

    it.each(['cli.ts', 'environment/generated-application.ts'])('rejects mixed parser imports despite a limits-only import in %s', (path) => {
        const specifier = path === 'cli.ts' ? './guards/invocation-parser.js' : '../guards/invocation-parser.js'
        const sources = new Map([[modulePath('guards/invocation-parser.ts'), '']])
        const limits = `import { GUARD_INPUT_LIMITS } from '${specifier}'`
        sources.set(modulePath(path), limits)
        expect(guardArchitectureViolations(sources)).not.toContain('ARCH052_GUARD_GRAPH')
        for (const extra of [
            `import { parseGuardInput } from '${specifier}'`,
            `import * as parser from '${specifier}'`,
            `import parser from '${specifier}'`,
        ]) {
            sources.set(modulePath(path), `${limits}\n${extra}`)
            expect(guardArchitectureViolations(sources), extra).toContain('ARCH052_GUARD_GRAPH')
        }
    })

    it.each([
        '(void config.guards.vendor_endpoint_hosts, Object.freeze([]))',
        'true ? [] : config.guards.vendor_endpoint_hosts',
        'Object.freeze([config.guards.vendor_endpoint_hosts, []])',
        'Object.freeze([...config.guards.vendor_endpoint_hosts, "extra"])',
        'other.guards.vendor_endpoint_hosts',
    ])('requires value-producing guard consumption rather than a discarded descendant read: %s', (value) => {
        const path = modulePath('environment/application.ts')
        const sources = productionSources()
        const source = sources.get(path)
        if (!source) throw new Error('guard application owner is missing')
        const original = 'vendorHosts: Object.freeze([...config.guards.vendor_endpoint_hosts])'
        expect(source).toContain(original)
        const planted = new Map(sources)
        planted.set(path, source.replace(original, `vendorHosts: ${value}`))
        expect(guardArchitectureViolations(planted), value).toContain('ARCH055_GUARD_DECLARATION_CONSUMPTION')
    })

    it('accepts wrapped value-producing guard consumption', () => {
        const path = modulePath('environment/application.ts')
        const sources = productionSources()
        const source = sources.get(path)
        if (!source) throw new Error('guard application owner is missing')
        const original = 'vendorHosts: Object.freeze([...config.guards.vendor_endpoint_hosts])'
        expect(source).toContain(original)
        const wrapped = new Map(sources)
        wrapped.set(path, source.replace(original, 'vendorHosts: ((Object.freeze([...(config.guards.vendor_endpoint_hosts! as readonly string[])])) satisfies readonly string[])'))
        expect(guardArchitectureViolations(wrapped)).toEqual([])
    })

    it.each([
        ['declaredAllows', 'allow'],
        ['declaredDenies', 'deny'],
    ])('requires the %s policy projection to consume guards.%s', (target, field) => {
        const path = modulePath('environment/application.ts')
        const sources = productionSources()
        const source = sources.get(path)
        if (!source) throw new Error('guard application owner is missing')
        const pattern = new RegExp(`${target}: Object\\.freeze\\(config\\.guards\\.${field}\\.map\\([\\s\\S]*?\\)\\),`)
        expect(source).toMatch(pattern)
        const planted = new Map(sources)
        planted.set(path, source.replace(pattern, `${target}: Object.freeze([]),`))
        expect(guardArchitectureViolations(planted)).toContain('ARCH055_GUARD_DECLARATION_CONSUMPTION')
    })

    it.each(['cli.ts', 'environment/generated-application.ts', 'guards/harness-adapter.ts', 'duplicate.ts'])('rejects runtime policy reconstruction in %s', (path) => {
        expect(inspectArchitecture(new Map([[modulePath(path), 'const localPolicy = { protectedBranches: [], vendorHosts: [] }; function capturePolicy() { return localPolicy }']]))).toContain('ARCH054_GUARD_POLICY_RECONSTRUCTION')
    })

    it('rejects an accepted guard declaration with no application consumer', () => {
        const path = modulePath('schema.ts')
        expect(inspectArchitecture(new Map([[path, 'export const Guards = z.object({ unused_guard_field: z.boolean() })']]))).toContain('ARCH055_GUARD_DECLARATION_CONSUMPTION')
    })

    it.each([
        "export const commands = [{ name: 'guard-evaluate', handler: 'guard-evaluate', visibility: 'public', ordinary: unavailable('private') }]",
        "export const commands = [{ name: 'check', handler: 'check', visibility: 'public' }]",
        "export const internalCommands = Object.freeze([{ name: 'guard-evaluate', handler: 'guard-evaluate', visibility: 'public', ordinary: ordinary('check') }])",
    ])('rejects public internal routes and incomplete ordinary metadata: %s', (source) => {
        expect(inspectArchitecture(new Map([[modulePath('command-table.ts'), source]]))).toContain('ARCH056_COMMAND_METADATA')
    })

    it('rejects dead or missing application sequencing rather than counting marker text', () => {
        const sources = new Map([[modulePath('environment/application.ts'), "export async function runGuardEvaluationApplication() { const marker = 'parseGuardInput evaluateGuard prepareGuardEvaluationPolicy resolveOrdinaryInvocation'; return marker }"]])
        expect(inspectArchitecture(sources)).toContain('ARCH053_GUARD_APPLICATION_SEQUENCE')
    })

    it('does not credit shadowed guard call names as the application sequence', () => {
        const application = modulePath('environment/application.ts')
        const sources = new Map([
            [modulePath('guards/invocation-parser.ts'), 'export function parseGuardInput() {}'],
            [modulePath('guards/evaluator.ts'), 'export function evaluateGuard() {}'],
            [modulePath('command-table.ts'), 'export function resolveOrdinaryInvocation() {}'],
            [application, `
                import { parseGuardInput } from '../guards/invocation-parser.js'
                import { evaluateGuard } from '../guards/evaluator.js'
                import { resolveOrdinaryInvocation } from '../command-table.js'
                export async function runGuardEvaluationApplication(parseGuardInput: () => void,
                    resolveOrdinaryInvocation: () => void, evaluateGuard: () => void) {
                    parseGuardInput(); resolveOrdinaryInvocation(); evaluateGuard()
                }
            `],
        ])
        expect(guardArchitectureViolations(sources)).toContain('ARCH053_GUARD_APPLICATION_SEQUENCE')
    })

    it('rejects shell policy interpretation in an executable entrypoint', () => {
        expect(inspectArchitecture(new Map([['packages/cockpit/surfaces/guards/bash-guard.sh', '#!/bin/bash\nif grep -q protected_branches policy; then exit 0; fi']]))).toContain('ARCH057_SHELL_POLICY')
    })

    it('explicitly scans every shipped executable shell entrypoint', () => {
        const paths = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', 'packages/cockpit/surfaces'], { cwd: ROOT, encoding: 'utf8' }).split('\0').filter(Boolean)
        const shells = new Map(paths.filter(path => /\.(?:sh|bash)$/.test(path)
            || readFileSync(resolve(ROOT, path), 'utf8').startsWith('#!')).map(path => [path, readFileSync(resolve(ROOT, path), 'utf8')]))
        expect(shells.has('packages/cockpit/surfaces/guards/bash-guard.sh')).toBe(true)
        expect(inspectArchitecture(shells)).toEqual([])
    })
})

describe('clean-checkout controls', () => {
    it('keeps shipped templates independent from repository-local tool roots', () => {
        expect(estateBoundaryViolations(shippedSurfaceSources())).toEqual([])
        expect(estateBoundaryViolations(new Map([
            ['packages/cockpit/surfaces/.codex/config.toml', 'model = "synthetic"'],
        ]))).toContain('ARCH048_ESTATE_CROSSING')
        expect(estateBoundaryViolations(new Map([
            ['packages/cockpit/surfaces/skills/synthetic.md', '@../../../../.codex/config.toml'],
        ]))).toContain('ARCH048_ESTATE_CROSSING')
        expect(estateBoundaryViolations(new Map([
            ['packages/cockpit/surfaces/guards/synthetic.adapter.json', '{"path":".codex/hooks.json"}'],
        ]))).toEqual([])
    })

    it('exposes root build and documentation commands backed by real implementations', () => {
        const manifest = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as {
            scripts?: Record<string, string>
        }

        expect(manifest.scripts?.build).toBe('npm run build --workspace @b0dea/cockpit')
        expect(manifest.scripts?.['lint:docs']).toBe('node scripts/docs-lint.mjs')
    })

    it('keeps four min/max full cells, two Node 24 compatibility cells and the separate Node 20 negative control', () => {
        const workflow = readFileSync(resolve(ROOT, '.github/workflows/ci.yml'), 'utf8')
        const supportedJob = /\n  test:\n(?<body>[\s\S]*?)(?=\n  runtime-floor-negative:)/.exec(workflow)?.groups?.body ?? ''
        const hygieneJob = /\n  hygiene:\n(?<body>[\s\S]*?)(?=\n  test:)/.exec(workflow)?.groups?.body ?? ''
        const floorJob = /\n  runtime-floor-negative:\n(?<body>[\s\S]*)/.exec(workflow)?.groups?.body ?? ''

        // The matrix is one fromJSON expression with a pull-request list and a main list, so each
        // list is read as data rather than matched line by line.
        const [pullRequestCells, mainCells] = [...supportedJob.matchAll(/'(\[\{[^']*\}\])'/g)]
            .map((match) => (JSON.parse(match[1]) as { os: string; node: string; gate: string }[])
                .map(({ os, node, gate }) => ({ os, node, gate })))
        expect(mainCells).toEqual([
            { os: 'ubuntu-latest', node: '22.13.0', gate: 'full' },
            { os: 'macos-latest', node: '22.13.0', gate: 'full' },
            { os: 'ubuntu-latest', node: '24', gate: 'compatibility' },
            { os: 'macos-latest', node: '24', gate: 'compatibility' },
            { os: 'ubuntu-latest', node: '26', gate: 'full' },
            { os: 'macos-latest', node: '26', gate: 'full' },
        ])
        // Pull requests keep both Node range edges and the Node 24 cell but pay for one macOS cell.
        expect(pullRequestCells).toEqual([
            { os: 'ubuntu-latest', node: '22.13.0', gate: 'full' },
            { os: 'macos-latest', node: '22.13.0', gate: 'full' },
            { os: 'ubuntu-latest', node: '24', gate: 'compatibility' },
            { os: 'ubuntu-latest', node: '26', gate: 'full' },
        ])
        expect(workflow).toContain('runtime-floor-negative:')
        expect(supportedJob).toContain('npm run build')
        expect(supportedJob).toContain("if: matrix.gate == 'full'")
        expect(supportedJob).toContain("if: matrix.gate == 'compatibility'")
        expect(supportedJob).toContain('run: npm test -- packages/cockpit/src/launcher.test.ts packages/cockpit/src/package-metadata.test.ts packages/cockpit/src/environment/runtime-probe.test.ts')
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


describe('init application boundary', () => {
    it('keeps init presentation and application at their public owners', () => {
        expect(initBoundaryViolations(productionSources())).toEqual([])
    })

    it('rejects direct, aliased, dynamic and computed imports of private decisions or filesystem writers', () => {
        const sources = productionSources()
        for (const [owner, addition] of [
            ['init/command.ts', "import { parseRegistry } from '../document/registry.js'"],
            ['init/command.ts', "import { writeFile as save } from 'node:fs/promises'"],
            ['init/command.ts', "void import('../document/registry.js')"],
            ['init/command.ts', 'void import(selectedModule)'],
            ['environment/init-application.ts', "import { parseRegistry as decide } from '../document/registry.js'"],
            ['environment/init-application.ts', "void import('node:fs/promises')"],
            ['environment/init-application.ts', "import { resolveInstallPolicies as decide } from './install-policy.js'"],
            ['environment/init-application.ts', "void import('./lifecycle.js')"],
            ['environment/init-application.ts', "import { executeProbe } from '../environment-exec/execute.js'"],
        ]) {
            const changed = new Map(sources), path = `packages/cockpit/src/${owner}`
            changed.set(path, `${changed.get(path)}\n${addition}`)
            expect(initBoundaryViolations(changed), addition).toContain('ARCH_INIT_APPLICATION_BOUNDARY')
        }
    })
})
