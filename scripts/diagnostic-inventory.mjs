import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, readFile, realpath } from 'node:fs/promises'
import { isAbsolute, join, posix, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from '@typescript/typescript6'

const MAX_GIT_OUTPUT = 64 * 1024 * 1024
const MAX_EXECUTION_OUTPUT = 16 * 1024 * 1024
const BUILT_EXECUTION_OWNER = new URL('../packages/cockpit/dist/environment-exec/execute.js', import.meta.url)
const BUILT_EXECUTABLE_OWNER = new URL('../packages/cockpit/dist/environment/executable.js', import.meta.url)
const IMPLEMENTATION_ROOTS = Object.freeze([
    'package.json',
    'package-lock.json',
    'tsconfig.json',
    'packages/cockpit/package.json',
    'packages/cockpit/tsconfig.build.json',
    'packages/cockpit/cockpit.schema.json',
    'packages/cockpit/libexec/rulesync-generator.cjs',
    'packages/cockpit/src',
    'packages/cockpit/surfaces',
    'packages/cockpit/src/references/adopt-cockpit.skill.md',
    'scripts/diagnostic-inventory.mjs',
    'scripts/diagnostic-inventory.d.mts',
    'scripts/docs-lint.mjs',
    'scripts/docs-lint.d.mts',
])
const SHIPPED_ASSETS = Object.freeze({
    guardTemplate: 'packages/cockpit/surfaces/guards/bash-guard.sh',
    adapters: Object.freeze([
        'packages/cockpit/surfaces/guards/claude.adapter.json',
        'packages/cockpit/surfaces/guards/codex.adapter.json',
        'packages/cockpit/surfaces/guards/opencode.adapter.json',
    ]),
    skills: Object.freeze([
        ['cockpit-setup', 'packages/cockpit/surfaces/skills/cockpit-setup.skill.md'],
        ['cockpit-explain', 'packages/cockpit/surfaces/skills/cockpit-explain.skill.md'],
        ['cockpit-fix', 'packages/cockpit/surfaces/skills/cockpit-fix.skill.md'],
        ['cockpit-work', 'packages/cockpit/surfaces/skills/cockpit-work.skill.md'],
    ]),
    collection: 'packages/cockpit/surfaces/skills/collection.json',
    terminal: 'packages/cockpit/surfaces/skills/procedures/onboarding.md',
    adoptSkillTemplate: 'packages/cockpit/src/references/adopt-cockpit.skill.md',
})
const TROUBLESHOOTING_PATH = 'docs/troubleshooting.md'

export const mechanism = {
    id: 'maintainer-reference-preparation',
    module: 'scripts/diagnostic-inventory.mjs',
    exports: [
        'productionTypeScriptPaths',
        'productionTypeScriptSources',
        'typeScriptSource',
        'exported',
        'diagnosticInventory',
        'diagnosticInventoryFromSources',
        'checkRepositoryReferences',
        'publishRepositoryReferences',
    ],
}

function git(root, arguments_, options = {}) {
    return execFileSync('git', arguments_, {
        cwd: root,
        encoding: 'utf8',
        maxBuffer: MAX_GIT_OUTPUT,
        stdio: ['ignore', 'pipe', 'pipe'],
        ...options,
    })
}

function candidatePathExists(root, candidate, path) {
    try {
        git(root, ['cat-file', '-e', `${candidate}:${path}`])
        return true
    } catch {
        return false
    }
}

function environmentDiagnosticRegistry(source) {
    const start = source.indexOf('export const ENVIRONMENT_CODES')
    const end = source.indexOf('export const EXECUTION_FAILURE_CODES', start)
    if (start === -1 || end === -1) throw new Error('environment diagnostic registry is unavailable')
    return Object.fromEntries([...source.slice(start, end).matchAll(/([A-Z][A-Z0-9_]+):\s*'([A-Z][A-Z0-9_]+)'/g)]
        .map((match) => [match[1], match[2]]))
}

export function productionTypeScriptPaths(root, candidate) {
    return git(root, ['ls-tree', '-r', '--name-only', candidate, '--', 'packages/cockpit/src'])
        .split('\n')
        .filter((path) => path.endsWith('.ts') && !path.endsWith('.test.ts') && !path.endsWith('.d.ts'))
}

export function productionTypeScriptSources(root, candidate) {
    const listing = git(root, ['ls-tree', '-r', '-z', candidate, '--', 'packages/cockpit/src'], { encoding: null })
    const records = listing.toString('utf8').split('\0')
    if (records.pop() !== '' || records.some((record) => record.length === 0)) {
        throw new Error('authenticated TypeScript source listing is malformed')
    }
    const rows = records.flatMap((record) => {
        const match = /^(100644|100755) blob ([a-f0-9]{40}|[a-f0-9]{64})\t([^\0\r\n]+)$/.exec(record)
        if (!match) throw new Error('authenticated TypeScript source row is malformed')
        return match[3].endsWith('.ts') && !match[3].endsWith('.test.ts') && !match[3].endsWith('.d.ts')
            ? [{ oid: match[2], path: match[3] }]
            : []
    })
    if (new Set(rows.map(({ path }) => path)).size !== rows.length) throw new Error('authenticated TypeScript source listing is ambiguous')
    if (rows.length === 0) return new Map()
    const output = git(root, ['cat-file', '--batch'], {
        encoding: null,
        input: rows.map(({ oid }) => oid).join('\n') + '\n',
        stdio: ['pipe', 'pipe', 'pipe'],
    })
    const sources = new Map()
    let offset = 0
    for (const row of rows) {
        const boundary = output.indexOf(0x0a, offset)
        if (boundary === -1) throw new Error(`${row.path}: authenticated TypeScript source header is truncated`)
        const header = output.subarray(offset, boundary).toString('ascii')
        const match = /^([a-f0-9]{40}|[a-f0-9]{64}) blob ([0-9]+)$/.exec(header)
        const size = match ? Number(match[2]) : Number.NaN
        if (!match || match[1] !== row.oid || !Number.isSafeInteger(size) || size < 0 || size > 16_777_216) {
            throw new Error(`${row.path}: authenticated TypeScript source header is invalid`)
        }
        const start = boundary + 1
        const end = start + size
        if (end >= output.byteLength || output[end] !== 0x0a) {
            throw new Error(`${row.path}: authenticated TypeScript source is truncated`)
        }
        sources.set(row.path, output.subarray(start, end).toString('utf8'))
        offset = end + 1
    }
    if (offset !== output.byteLength) throw new Error('authenticated TypeScript source batch has trailing bytes')
    return sources
}

export function typeScriptSource(path, source) {
    const parsed = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    if (parsed.parseDiagnostics?.length > 0) throw new Error(`${path}: TypeScript source is not parseable`)
    return parsed
}

export function exported(node) {
    return node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) === true
}

function uppercaseDiagnostic(value) {
    return /^[A-Z][A-Z0-9_]*_[A-Z0-9_]+$/.test(value)
}

export function diagnosticInventory(root, candidate) {
    const sources = productionTypeScriptSources(root, candidate)
    const paths = [...sources.keys()]
    return diagnosticInventoryFromSources(paths, sources)
}

export function diagnosticInventoryFromSources(paths, sources) {
    const owners = new Map()
    const emissions = new Map()
    const remedies = new Map()
    const parsedSources = new Map(paths.map((path) => {
        const bytes = sources.get(path)
        if (bytes === undefined) throw new Error(`${path}: authenticated TypeScript source is unavailable`)
        return [path, typeScriptSource(path, bytes)]
    }))
    const resolveSourceImport = (owner, specifier) => {
        if (!specifier.startsWith('.')) return undefined
        const joined = posix.normalize(posix.join(posix.dirname(owner), specifier))
        const candidates = specifier.endsWith('.js')
            ? [`${joined.slice(0, -3)}.ts`]
            : [joined, `${joined}.ts`, `${joined}/index.ts`]
        return candidates.find((candidate) => sources.has(candidate))
    }
    const runtimeImports = new Map()
    const importBindings = new Map()
    for (const [path, source] of parsedSources) {
        const dependencies = new Set()
        const bindings = new Map()
        for (const statement of source.statements) {
            if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue
            const dependency = resolveSourceImport(path, statement.moduleSpecifier.text)
            if (!dependency) continue
            const clause = statement.importClause
            if (!clause) {
                dependencies.add(dependency)
                continue
            }
            if (clause.isTypeOnly) continue
            if (clause.name) bindings.set(clause.name.text, dependency)
            const named = clause.namedBindings
            if (named && ts.isNamespaceImport(named)) bindings.set(named.name.text, dependency)
            if (named && ts.isNamedImports(named)) for (const element of named.elements) {
                if (!element.isTypeOnly) bindings.set(element.name.text, dependency)
            }
            if (clause.name || named && (ts.isNamespaceImport(named) || named.elements.some(element => !element.isTypeOnly))) {
                dependencies.add(dependency)
            }
        }
        runtimeImports.set(path, dependencies)
        importBindings.set(path, bindings)
    }
    const directCommandOwners = new Map()
    const cliPath = 'packages/cockpit/src/cli.ts'
    const cliSource = parsedSources.get(cliPath)
    if (cliSource) {
        const handlerFunction = cliSource.statements.find((statement) => ts.isFunctionDeclaration(statement)
            && statement.name?.text === 'defaultHandlers')
        const returned = handlerFunction?.body?.statements.find(ts.isReturnStatement)?.expression
        const cliBindings = importBindings.get(cliPath) ?? new Map()
        if (returned && ts.isObjectLiteralExpression(returned)) for (const property of returned.properties) {
            if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) continue
            const name = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) ? property.name.text : undefined
            if (!name) continue
            const direct = new Set()
            const collectBindings = (node) => {
                if (ts.isTypeNode(node)) return
                if (ts.isIdentifier(node)) {
                    const dependency = cliBindings.get(node.text)
                    if (dependency) direct.add(dependency)
                }
                ts.forEachChild(node, collectBindings)
            }
            collectBindings(ts.isPropertyAssignment(property) ? property.initializer : property.name)
            if (direct.size === 0) continue
            directCommandOwners.set(name, direct)
        }
    }
    const addCode = (code, path, emitted = true) => {
        if (!owners.has(code)) owners.set(code, new Set())
        if (!emissions.has(code)) emissions.set(code, new Set())
        if (!remedies.has(code)) remedies.set(code, new Set())
        owners.get(code).add(path)
        if (emitted) emissions.get(code).add(path)
    }
    const environmentContract = sources.get('packages/cockpit/src/environment/contract.ts')
    const environmentCodes = environmentContract === undefined
        ? new Map()
        : new Map(Object.entries(environmentDiagnosticRegistry(environmentContract)))
    if (environmentContract !== undefined) {
        for (const code of environmentCodes.values()) {
            addCode(code, 'packages/cockpit/src/environment/contract.ts', false)
        }
    }
    for (const path of paths) {
        const source = parsedSources.get(path)
        if (!source) throw new Error(`${path}: authenticated TypeScript source is unavailable`)
        const environmentCodeBindings = new Set(path === 'packages/cockpit/src/environment/contract.ts' ? ['ENVIRONMENT_CODES'] : [])
        for (const statement of source.statements) {
            if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)
                || resolveSourceImport(path, statement.moduleSpecifier.text) !== 'packages/cockpit/src/environment/contract.ts') continue
            const named = statement.importClause?.namedBindings
            if (named && ts.isNamedImports(named)) for (const element of named.elements) {
                if ((element.propertyName ?? element.name).text === 'ENVIRONMENT_CODES') environmentCodeBindings.add(element.name.text)
            }
        }
        const exportedCodeArrays = new Map()
        const unwrapExpression = (node) => {
            let current = node
            while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isSatisfiesExpression(current) || ts.isNonNullExpression(current)) current = current.expression
            if (ts.isCallExpression(current)
                && ts.isPropertyAccessExpression(current.expression)
                && ts.isIdentifier(current.expression.expression)
                && current.expression.expression.text === 'Object'
                && current.expression.name.text === 'freeze'
                && current.arguments.length === 1) return unwrapExpression(current.arguments[0])
            return current
        }
        for (const statement of source.statements) {
            if (!ts.isVariableStatement(statement) || !exported(statement)) continue
            for (const declaration of statement.declarationList.declarations) {
                if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue
                const initializer = unwrapExpression(declaration.initializer)
                if (!ts.isArrayLiteralExpression(initializer)) continue
                const values = initializer.elements
                    .filter((element) => ts.isStringLiteral(element) && uppercaseDiagnostic(element.text))
                    .map((element) => element.text)
                if (values.length > 0) exportedCodeArrays.set(declaration.name.text, values)
            }
        }
        const exportedUnions = new Map()
        for (const statement of source.statements) {
            if (!ts.isTypeAliasDeclaration(statement) || !exported(statement)) continue
            const values = []
            const collect = (node) => {
                if (ts.isLiteralTypeNode(node) && ts.isStringLiteral(node.literal) && uppercaseDiagnostic(node.literal.text)) {
                    values.push(node.literal.text)
                } else if (ts.isUnionTypeNode(node)) {
                    for (const member of node.types) collect(member)
                }
            }
            collect(statement.type)
            const registry = /^typeof\s+([A-Za-z_$][\w$]*)\s*\[\s*number\s*\]$/.exec(statement.type.getText(source))
            if (registry && exportedCodeArrays.has(registry[1])) values.push(...exportedCodeArrays.get(registry[1]))
            if (values.length > 0) exportedUnions.set(statement.name.text, values)
        }
        const snapshotWrappers = new Set(['snapshotJson'])
        for (const statement of source.statements) {
            if (!ts.isFunctionDeclaration(statement) || !statement.name || statement.parameters.length !== 1
                || !ts.isIdentifier(statement.parameters[0].name) || statement.body?.statements.length !== 1) continue
            const returned = statement.body.statements[0]
            if (!ts.isReturnStatement(returned) || !returned.expression) continue
            const value = unwrapExpression(returned.expression)
            if (ts.isCallExpression(value) && ts.isIdentifier(value.expression) && value.expression.text === 'snapshotJson'
                && value.arguments.length === 1 && ts.isIdentifier(value.arguments[0])
                && value.arguments[0].text === statement.parameters[0].name.text) snapshotWrappers.add(statement.name.text)
        }
        const returnedDeclarations = new Set()
        const returnedObjects = new Set()
        const localDeclaration = (identifier) => {
            for (let scope = identifier.parent; scope; scope = scope.parent) {
                if (ts.isBlock(scope) || ts.isSourceFile(scope)) {
                    const declaration = scope.statements.filter(ts.isVariableStatement)
                        .flatMap(statement => [...statement.declarationList.declarations])
                        .find(candidate => ts.isIdentifier(candidate.name) && candidate.name.text === identifier.text)
                    if (declaration) return declaration
                }
                if (ts.isFunctionLike(scope) && scope.parameters.some(parameter => ts.isIdentifier(parameter.name) && parameter.name.text === identifier.text)) return undefined
            }
            return undefined
        }
        const mutations = new Map()
        const collectMutations = (node) => {
            let receiver, values
            if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(node.left)) {
                receiver = node.left
                values = [node.right]
            } else if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
                && ts.isIdentifier(node.expression.expression) && ['push', 'unshift'].includes(node.expression.name.text)) {
                receiver = node.expression.expression
                values = node.arguments
            }
            const declaration = receiver && localDeclaration(receiver)
            if (declaration) mutations.set(declaration, [...(mutations.get(declaration) ?? []), ...values])
            ts.forEachChild(node, collectMutations)
        }
        collectMutations(source)
        const collectReturnedValue = (expression) => {
            const value = unwrapExpression(expression)
            if (ts.isIdentifier(value)) {
                const declaration = localDeclaration(value)
                if (!declaration || returnedDeclarations.has(declaration)) return
                returnedDeclarations.add(declaration)
                if (declaration.initializer) collectReturnedValue(declaration.initializer)
                for (const mutation of mutations.get(declaration) ?? []) collectReturnedValue(mutation)
            } else if (ts.isPropertyAccessExpression(value)) {
                collectReturnedValue(value.expression)
            } else if (ts.isArrayLiteralExpression(value)) {
                for (const element of value.elements) collectReturnedValue(ts.isSpreadElement(element) ? element.expression : element)
            } else if (ts.isObjectLiteralExpression(value)) {
                returnedObjects.add(value)
                for (const property of value.properties) {
                    if (ts.isPropertyAssignment(property)) collectReturnedValue(property.initializer)
                    else if (ts.isShorthandPropertyAssignment(property)) collectReturnedValue(property.name)
                    else if (ts.isSpreadAssignment(property)) collectReturnedValue(property.expression)
                }
            } else if (ts.isConditionalExpression(value)) {
                collectReturnedValue(value.whenTrue)
                collectReturnedValue(value.whenFalse)
            } else if (ts.isCallExpression(value) && ts.isIdentifier(value.expression)
                && snapshotWrappers.has(value.expression.text) && value.arguments.length === 1) {
                collectReturnedValue(value.arguments[0])
            }
        }
        const collectReturns = (node) => {
            if (ts.isReturnStatement(node) && node.expression) collectReturnedValue(node.expression)
            if (ts.isArrowFunction(node) && !ts.isBlock(node.body)) collectReturnedValue(node.body)
            if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)
                && node.expression.text === 'renderJsonResponse' && node.arguments[0]) collectReturnedValue(node.arguments[0])
            ts.forEachChild(node, collectReturns)
        }
        collectReturns(source)
        const staticStrings = (expression) => {
            const strings = []
            const collect = (candidate) => {
                const value = unwrapExpression(candidate)
                if (ts.isStringLiteral(value)) strings.push(value.text)
                else if (ts.isConditionalExpression(value)) {
                    collect(value.whenTrue)
                    collect(value.whenFalse)
                } else if (ts.isBinaryExpression(value)
                    && [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken].includes(value.operatorToken.kind)) {
                    collect(value.left)
                    collect(value.right)
                }
            }
            collect(expression)
            return strings
        }
        for (const object of returnedObjects) {
            const properties = new Map(object.properties.flatMap((property) => ts.isPropertyAssignment(property)
                && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) ? [[property.name.text, unwrapExpression(property.initializer)]] : []))
            const codeValue = properties.get('code')
            const fixValue = properties.get('fix')
            const codes = codeValue ? staticStrings(codeValue).filter(uppercaseDiagnostic) : []
            const fixes = fixValue ? staticStrings(fixValue).filter(value => value.length > 0 && !/[\r\n]/.test(value)) : []
            for (const code of codes) for (const fix of fixes) {
                addCode(code, path)
                remedies.get(code).add(fix)
            }
        }
        const constructorName = (expression) => {
            if (ts.isIdentifier(expression)) return expression.text
            if (ts.isPropertyAccessExpression(expression)) return expression.name.text
            return ''
        }
        const collectDiagnosticExpression = (expression) => {
            const value = unwrapExpression(expression)
            if (ts.isStringLiteral(value)) {
                if (uppercaseDiagnostic(value.text)) addCode(value.text, path)
            } else if (ts.isPropertyAccessExpression(value) && ts.isIdentifier(value.expression)
                && environmentCodeBindings.has(value.expression.text)) {
                const code = environmentCodes.get(value.name.text)
                if (code) addCode(code, path)
            } else if (ts.isConditionalExpression(value)) {
                collectDiagnosticExpression(value.whenTrue)
                collectDiagnosticExpression(value.whenFalse)
            } else if (ts.isBinaryExpression(value)
                && [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken].includes(value.operatorToken.kind)) {
                collectDiagnosticExpression(value.left)
                collectDiagnosticExpression(value.right)
            }
        }
        const visit = (node) => {
            if (ts.isCallExpression(node) && /(?:diagnostic|refus|fail|error|usageOutcome)/i.test(constructorName(node.expression))) {
                const first = node.arguments[0]
                if (first) collectDiagnosticExpression(first)
            }
            const codeProperty = (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node))
                && ((ts.isIdentifier(node.name) && node.name.text === 'code') || (ts.isStringLiteral(node.name) && node.name.text === 'code'))
            if (codeProperty && returnedObjects.has(node.parent)) {
                const value = ts.isShorthandPropertyAssignment(node) ? node.name : node.initializer
                collectDiagnosticExpression(value)
                if (ts.isIdentifier(value)) {
                    let owner = node.parent
                    while (owner && !ts.isFunctionLike(owner)) owner = owner.parent
                    const parameter = owner?.parameters?.find((item) => ts.isIdentifier(item.name) && item.name.text === value.text)
                    if (parameter?.type) {
                        const typeText = parameter.type.getText(source)
                        for (const [name, values] of exportedUnions) {
                            if (new RegExp(`\\b${name}\\b`).test(typeText)) for (const code of values) addCode(code, path)
                        }
                    }
                }
            }
            ts.forEachChild(node, visit)
        }
        visit(source)
    }
    const diagnosticOwnerPaths = new Set([...owners.values()].flatMap(paths => [...paths]))
    const commandOwners = new Map([...directCommandOwners].map(([name, direct]) => {
        const captured = new Set(direct)
        let frontier = [...direct]
        while (frontier.length > 0) {
            const wrappers = frontier.filter(path => !diagnosticOwnerPaths.has(path))
            const next = [...new Set(wrappers.flatMap(path => [...(runtimeImports.get(path) ?? [])]))]
                .filter(path => !captured.has(path))
            for (const path of next) captured.add(path)
            frontier = next
        }
        return [name, captured]
    }))
    return { items: [...owners.keys()].sort().map((code) => `diagnostic:${code}`), owners, emissions, remedies, commandOwners }
}

function referenceRefusal(code, message, target = 'references') {
    return Object.freeze({
        kind: 'refusal',
        status: 2,
        artifact: null,
        destination: null,
        result: null,
        diagnostics: Object.freeze([Object.freeze({ severity: 'error', code, message, target })]),
    })
}

async function loadBootstrapOwners() {
    try {
        const [execution, executable] = await Promise.all([
            import(BUILT_EXECUTION_OWNER.href),
            import(BUILT_EXECUTABLE_OWNER.href),
        ])
        return { execution, executable }
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        throw new Error(`[REFERENCE_OWNER_UNAVAILABLE] built execution owner is unavailable: ${message}`)
    }
}

async function loadReferenceOwners(root) {
    try {
        const [references, transaction, execution, executable] = await Promise.all([
            import(pathToFileURL(join(root, 'packages/cockpit/dist/references/generate.js')).href),
            import(pathToFileURL(join(root, 'packages/cockpit/dist/generated-environment/transaction.js')).href),
            import(pathToFileURL(join(root, 'packages/cockpit/dist/environment-exec/execute.js')).href),
            import(pathToFileURL(join(root, 'packages/cockpit/dist/environment/executable.js')).href),
        ])
        return { references, transaction, execution, executable }
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        throw new Error(`[REFERENCE_OWNER_UNAVAILABLE] built reference owner is unavailable: ${message}`)
    }
}

function gitStep(root, gitExecutable, arguments_, label, stdoutLimitBytes, deadline) {
    const now = Date.now()
    const stop = Math.min(deadline ?? now + 30_000, now + 30_000)
    if (stop <= now) throw new Error('[REFERENCE_SOURCE_CHANGED] reference revalidation deadline expired')
    return Object.freeze({
        id: `maintainer-reference-${label}`,
        argv: Object.freeze([gitExecutable.canonicalPath, ...arguments_]),
        argv0: gitExecutable.invocationPath,
        cwd: root,
        env: Object.freeze({}),
        timeoutMs: stop - now,
        spawnNotAfter: new Date(stop).toISOString(),
        stdoutLimitBytes,
        stderrLimitBytes: 16_384,
        paths: Object.freeze([root]),
        ports: Object.freeze([]),
        labels: Object.freeze({ action: 'maintainer-reference', operation: label }),
        expected: Object.freeze([]),
        consumedFiles: Object.freeze([Object.freeze({
            path: gitExecutable.canonicalPath,
            sha256: gitExecutable.sha256,
            maxBytes: 536_870_912,
            argvIndexes: Object.freeze([0]),
            executable: true,
            executionMode: gitExecutable.executionMode,
        })]),
        filesystemChecks: Object.freeze([Object.freeze({ path: root, expected: 'directory' })]),
        compensation: Object.freeze([]),
    })
}

async function runGit(owners, root, gitExecutable, arguments_, label, stdoutLimitBytes, deadline) {
    const step = gitStep(root, gitExecutable, arguments_, label, stdoutLimitBytes, deadline)
    const outcome = owners.execution.authenticatedExecutionOutcome(
        await owners.execution.executeProbe(step),
        step,
    )
    if (outcome?.kind !== 'complete' || outcome.stderr.byteLength !== 0) {
        throw new Error(`[REFERENCE_GIT_UNAVAILABLE] Git ${label} did not produce authenticated output`)
    }
    return Buffer.from(outcome.stdout)
}

function decodeUtf8(bytes, label) {
    try {
        return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch {
        throw new Error(`[REFERENCE_SOURCE_INVALID] ${label} is not valid UTF-8`)
    }
}

function committedTreeRecords(listing) {
    const records = listing.split('\0')
    if (records.pop() !== '' || records.some((record) => record.length === 0)) return undefined
    return records
}

function confined(root, path) {
    const target = resolve(root, path)
    const offset = relative(root, target)
    return offset !== '' && offset !== '..' && !offset.startsWith(`..${sep}`) && !isAbsolute(offset) ? target : undefined
}

async function exactWorktreeFile(root, path, expected, identity) {
    const target = confined(root, path)
    if (!target) return false
    try {
        const before = await lstat(target)
        if (!before.isFile() || before.isSymbolicLink() || before.size !== expected.byteLength
            || identity && (before.dev !== identity.dev || before.ino !== identity.ino || before.mode !== identity.mode)) return undefined
        const bytes = await readFile(target)
        const after = await lstat(target)
        return before.dev === after.dev && before.ino === after.ino && before.size === after.size && before.mode === after.mode
            && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs && bytes.equals(expected)
            ? Object.freeze({ dev: before.dev, ino: before.ino, mode: before.mode }) : undefined
    } catch {
        return undefined
    }
}

async function authenticatedWorktreeBlob(root, row, objectFormat) {
    const target = confined(root, row.path)
    if (!target) return undefined
    let file
    try {
        const before = await lstat(target)
        const executable = (before.mode & 0o111) !== 0
        if (!before.isFile() || before.isSymbolicLink() || before.size > 16_777_216
            || (row.mode === '100755') !== executable) return undefined
        file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
        const opened = await file.stat()
        if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino
            || opened.size !== before.size || opened.mode !== before.mode) return undefined
        const bytes = Buffer.allocUnsafe(opened.size)
        let offset = 0
        while (offset < bytes.byteLength) {
            const read = await file.read(bytes, offset, bytes.byteLength - offset, offset)
            if (read.bytesRead === 0) return undefined
            offset += read.bytesRead
        }
        const after = await file.stat()
        const named = await lstat(target)
        if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size || after.mode !== opened.mode
            || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs
            || named.isSymbolicLink() || !named.isFile() || named.dev !== opened.dev || named.ino !== opened.ino
            || named.size !== opened.size || named.mode !== opened.mode
            || named.mtimeMs !== opened.mtimeMs || named.ctimeMs !== opened.ctimeMs) return undefined
        const actual = createHash(objectFormat).update(Buffer.from(`blob ${bytes.byteLength}\0`)).update(bytes).digest('hex')
        return actual === row.oid
            ? Object.freeze({ bytes, identity: Object.freeze({ dev: opened.dev, ino: opened.ino, mode: opened.mode }) })
            : undefined
    } catch {
        return undefined
    } finally {
        await file?.close()
    }
}

const snapshots = new WeakMap()

async function captureCommittedInputs(root, candidate, owners) {
    if (!isAbsolute(root)) throw new Error('[REFERENCE_ROOT_INVALID] repository root must be absolute')
    const canonicalRoot = await realpath(root)
    if (canonicalRoot !== root) throw new Error('[REFERENCE_ROOT_INVALID] repository root must be canonical')
    const rootStatus = await lstat(root)
    if (!rootStatus.isDirectory() || rootStatus.isSymbolicLink()) throw new Error('[REFERENCE_ROOT_INVALID] repository root must be an anchored directory')
    const resolvedGit = await owners.executable.resolveGitExecutable({ PATH: process.env.PATH ?? '' })
    if (resolvedGit?.state !== 'available') throw new Error('[REFERENCE_GIT_UNAVAILABLE] Git executable authority is unavailable')
    const gitExecutable = resolvedGit.value
    const objectFormat = decodeUtf8(await runGit(owners, root, gitExecutable, ['rev-parse', '--show-object-format'], 'object-format', 32), 'object format').trim()
    if (objectFormat !== 'sha1' && objectFormat !== 'sha256') throw new Error('[REFERENCE_GIT_UNAVAILABLE] repository object format is unsupported')
    const oidPattern = objectFormat === 'sha1' ? /^[a-f0-9]{40}$/ : /^[a-f0-9]{64}$/
    const head = decodeUtf8(await runGit(owners, root, gitExecutable, ['rev-parse', '--verify', 'HEAD^{commit}'], 'head', 80), 'HEAD').trim()
    const requested = decodeUtf8(await runGit(owners, root, gitExecutable, ['rev-parse', '--verify', `${candidate}^{commit}`], 'candidate', 80), 'candidate').trim()
    if (!oidPattern.test(head) || requested !== head) throw new Error('[REFERENCE_CANDIDATE_MISMATCH] canonical references must describe the captured HEAD')
    const listing = await runGit(owners, root, gitExecutable, ['ls-tree', '-r', '-z', head, '--', ...IMPLEMENTATION_ROOTS], 'source-tree', MAX_EXECUTION_OUTPUT)
    const listingText = decodeUtf8(listing, 'source tree')
    if (!listingText.endsWith('\0')) throw new Error('[REFERENCE_SOURCE_INVALID] committed source tree is truncated')
    const sourceRecords = committedTreeRecords(listingText)
    if (!sourceRecords) throw new Error('[REFERENCE_SOURCE_INVALID] committed source tree contains an invalid row')
    const rows = []
    const seen = new Set()
    for (const raw of sourceRecords) {
        const match = /^(100644|100755) blob ([a-f0-9]+)\t([^\0\r\n]+)$/.exec(raw)
        if (!match || !oidPattern.test(match[2]) || seen.has(match[3])) throw new Error('[REFERENCE_SOURCE_INVALID] committed source tree contains an invalid row')
        seen.add(match[3])
        const path = match[3]
        const productionSource = path.startsWith('packages/cockpit/src/') && path.endsWith('.ts')
            && !path.endsWith('.test.ts') && !path.endsWith('.d.ts')
        const fixedInput = IMPLEMENTATION_ROOTS.includes(path) || path.startsWith('packages/cockpit/surfaces/')
        if (productionSource || fixedInput) rows.push(Object.freeze({ mode: match[1], oid: match[2], path }))
    }
    rows.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
    const required = [
        ...IMPLEMENTATION_ROOTS.filter((path) => !path.endsWith('/src') && !path.endsWith('/surfaces')),
        SHIPPED_ASSETS.guardTemplate,
        ...SHIPPED_ASSETS.adapters,
        ...SHIPPED_ASSETS.skills.map(([, path]) => path),
        SHIPPED_ASSETS.collection,
        SHIPPED_ASSETS.terminal,
        'packages/cockpit/src/environment/contract.ts',
        'packages/cockpit/src/references/generate.ts',
        'packages/cockpit/src/generated-environment/transaction.ts',
    ]
    for (const path of required) if (!seen.has(path)) throw new Error(`[REFERENCE_SOURCE_UNAVAILABLE] ${path} is absent from captured HEAD`)
    let stableListing
    try {
        stableListing = decodeUtf8(await runGit(owners, root, gitExecutable,
            ['ls-tree', '-r', '-z', head, '--', ...IMPLEMENTATION_ROOTS], 'source-tree-stability', MAX_EXECUTION_OUTPUT), 'source tree')
    } catch {
        throw new Error('[REFERENCE_SOURCE_CHANGED] committed source tree changed during capture')
    }
    if (stableListing !== listingText || !stableListing.endsWith('\0') || !committedTreeRecords(stableListing)) {
        throw new Error('[REFERENCE_SOURCE_CHANGED] committed source tree changed during capture')
    }
    const blobs = new Map()
    const identities = new Map()
    let aggregate = 0
    for (const row of rows) {
        const authenticated = await authenticatedWorktreeBlob(root, row, objectFormat)
        if (!authenticated) throw new Error(`[REFERENCE_SOURCE_DIRTY] ${row.path} differs from captured HEAD`)
        const { bytes, identity } = authenticated
        aggregate += bytes.byteLength
        if (bytes.byteLength > 16_777_216 || aggregate > MAX_GIT_OUTPUT) throw new Error(`[REFERENCE_SOURCE_INVALID] ${row.path} exceeds the committed input bound`)
        blobs.set(row.path, Buffer.from(bytes))
        identities.set(row.path, identity)
    }
    const rowFingerprint = rows.map(({ mode, oid, path }) => `${mode} ${oid}\t${path}\0`).join('')
    const record = Object.freeze({
        root,
        rootIdentity: Object.freeze({ dev: rootStatus.dev, ino: rootStatus.ino }),
        head,
        objectFormat,
        gitExecutable,
        rows: Object.freeze(rows),
        rowFingerprint,
        blobs,
        identities,
        buildOutputs: new Map(),
        buildIdentities: new Map(),
    })
    const snapshot = Object.freeze({})
    snapshots.set(snapshot, record)
    return snapshot
}

async function revalidateCommittedInputs(snapshot, owners, deadline) {
    const record = snapshots.get(snapshot)
    if (!record) return false
    try {
        const rootStatus = await lstat(record.root)
        if (!rootStatus.isDirectory() || rootStatus.isSymbolicLink() || rootStatus.dev !== record.rootIdentity.dev || rootStatus.ino !== record.rootIdentity.ino) return false
        const objectFormat = decodeUtf8(await runGit(owners, record.root, record.gitExecutable, ['rev-parse', '--show-object-format'], 'revalidate-object-format', 32, deadline), 'object format').trim()
        if (objectFormat !== record.objectFormat) return false
        const head = decodeUtf8(await runGit(owners, record.root, record.gitExecutable, ['rev-parse', '--verify', 'HEAD^{commit}'], 'revalidate-head', 80, deadline), 'HEAD').trim()
        if (head !== record.head) return false
        const listing = decodeUtf8(await runGit(owners, record.root, record.gitExecutable, ['ls-tree', '-r', '-z', record.head, '--', ...IMPLEMENTATION_ROOTS], 'revalidate-source-tree', MAX_EXECUTION_OUTPUT, deadline), 'source tree')
        if (!listing.endsWith('\0')) return false
        const sourceRecords = committedTreeRecords(listing)
        if (!sourceRecords) return false
        const rows = []
        for (const raw of sourceRecords) {
            const match = /^(100644|100755) blob ([a-f0-9]+)\t([^\0\r\n]+)$/.exec(raw)
            if (!match) return false
            const path = match[3]
            const productionSource = path.startsWith('packages/cockpit/src/') && path.endsWith('.ts')
                && !path.endsWith('.test.ts') && !path.endsWith('.d.ts')
            const fixedInput = IMPLEMENTATION_ROOTS.includes(path) || path.startsWith('packages/cockpit/surfaces/')
            if (productionSource || fixedInput) rows.push({ mode: match[1], oid: match[2], path })
        }
        rows.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
        if (rows.map(({ mode, oid, path }) => `${mode} ${oid}\t${path}\0`).join('') !== record.rowFingerprint) return false
        for (const row of record.rows) if (!await exactWorktreeFile(record.root, row.path, record.blobs.get(row.path), record.identities.get(row.path))) return false
        for (const [path, bytes] of record.buildOutputs) {
            if (!await exactWorktreeFile(record.root, path, bytes, record.buildIdentities.get(path))) return false
        }
        return true
    } catch {
        return false
    }
}

async function authenticateBuiltReferenceOwner(record) {
    const lock = JSON.parse(textBlob(record, 'package-lock.json'))
    if (lock?.packages?.['node_modules/@typescript/old']?.version !== ts.version) {
        throw new Error('[REFERENCE_BUILD_UNAUTHENTICATED] installed TypeScript does not match captured package-lock.json')
    }
    for (const row of record.rows) {
        if (!row.path.startsWith('packages/cockpit/src/') || !row.path.endsWith('.ts')
            || row.path.startsWith('packages/cockpit/src/test-support/')) continue
        const source = textBlob(record, row.path)
        const emitted = ts.transpileModule(source, {
            fileName: row.path,
            reportDiagnostics: true,
            compilerOptions: {
                target: ts.ScriptTarget.ES2023,
                module: ts.ModuleKind.ESNext,
                moduleResolution: ts.ModuleResolutionKind.Bundler,
                verbatimModuleSyntax: true,
            },
        })
        if (emitted.diagnostics?.some(({ category }) => category === ts.DiagnosticCategory.Error)) {
            throw new Error(`[REFERENCE_BUILD_UNAUTHENTICATED] ${row.path} could not be emitted for build authentication`)
        }
        const outputPath = row.path.replace('packages/cockpit/src/', 'packages/cockpit/dist/').replace(/\.ts$/, '.js')
        const output = Buffer.from(emitted.outputText)
        const identity = await exactWorktreeFile(record.root, outputPath, output)
        if (!identity) {
            throw new Error(`[REFERENCE_BUILD_UNAUTHENTICATED] ${outputPath} does not match captured HEAD source`)
        }
        record.buildOutputs.set(outputPath, output)
        record.buildIdentities.set(outputPath, identity)
    }
}

function textBlob(record, path) {
    const bytes = record.blobs.get(path)
    if (!bytes) throw new Error(`[REFERENCE_SOURCE_UNAVAILABLE] ${path} was not captured`)
    return decodeUtf8(bytes, path)
}

function projectionInput(record) {
    const terminal = textBlob(record, SHIPPED_ASSETS.terminal)
    const collection = textBlob(record, SHIPPED_ASSETS.collection)
    const sourceAsset = (path, installedPath) => {
        const bytes = textBlob(record, path)
        return Object.freeze({ path, installedPath, bytes, sha256: createHash('sha256').update(bytes).digest('hex') })
    }
    return Object.freeze({
        guardTemplate: textBlob(record, SHIPPED_ASSETS.guardTemplate),
        adapters: Object.freeze(SHIPPED_ASSETS.adapters.map((path) => JSON.parse(textBlob(record, path)))),
        skillSources: Object.freeze(SHIPPED_ASSETS.skills.flatMap(([name, path]) => Object.freeze([
            Object.freeze({ path: `skills/${name}/SKILL.md`, bytes: textBlob(record, path) }),
            Object.freeze({ path: `skills/${name}/procedures/onboarding.md`, bytes: terminal }),
        ]))),
        collection: Object.freeze({ path: 'skills/collection.json', bytes: collection, sha256: createHash('sha256').update(collection).digest('hex') }),
        terminal: Object.freeze({ path: 'skills/procedures/onboarding.md', bytes: terminal, sha256: createHash('sha256').update(terminal).digest('hex') }),
        sourceAssets: Object.freeze([
            sourceAsset(SHIPPED_ASSETS.collection, 'skills/collection.json'),
            sourceAsset(SHIPPED_ASSETS.terminal, 'skills/procedures/onboarding.md'),
            ...SHIPPED_ASSETS.skills.flatMap(([name, path]) => [
                sourceAsset(path, `skills/${name}/SKILL.md`),
                sourceAsset(SHIPPED_ASSETS.terminal, `skills/${name}/procedures/onboarding.md`),
            ]),
        ]),
    })
}

async function prepareRender(root, candidate, bootstrapOwners, troubleshooting) {
    const snapshot = await captureCommittedInputs(root, candidate, bootstrapOwners)
    const record = snapshots.get(snapshot)
    if (!await revalidateCommittedInputs(snapshot, bootstrapOwners)) {
        return { result: referenceRefusal('REFERENCE_SOURCE_CHANGED', 'committed reference inputs changed during preparation') }
    }
    await authenticateBuiltReferenceOwner(record)
    const owners = await loadReferenceOwners(root)
    const sources = new Map(record.rows.filter(({ path }) => path.startsWith('packages/cockpit/src/') && path.endsWith('.ts'))
        .map(({ path }) => [path, textBlob(record, path)]))
    const inventory = diagnosticInventoryFromSources([...sources.keys()], sources)
    const prepared = await owners.references.prepareCommittedCapabilityProjection(projectionInput(record))
    if (prepared?.kind !== 'complete') return { result: prepared ?? referenceRefusal('REFERENCE_OWNER_UNAVAILABLE', 'committed capability owner returned no result') }
    const adoptSkill = { template: textBlob(record, SHIPPED_ASSETS.adoptSkillTemplate), procedure: textBlob(record, SHIPPED_ASSETS.terminal) }
    const rendered = owners.references.renderReferences({ committed: prepared.projection, diagnostics: inventory, troubleshooting, adoptSkill })
    if (rendered?.kind !== 'complete') return { result: rendered ?? referenceRefusal('REFERENCE_OWNER_UNAVAILABLE', 'reference renderer returned no result') }
    if (!await revalidateCommittedInputs(snapshot, owners)) return { result: referenceRefusal('REFERENCE_SOURCE_CHANGED', 'committed reference inputs changed during preparation') }
    return { snapshot, rendered, owners }
}

function region(document) {
    const starts = [...document.matchAll(/^<!-- cockpit:diagnostic-index:begin -->\r?$/gm)]
    const ends = [...document.matchAll(/^<!-- cockpit:diagnostic-index:end -->\r?$/gm)]
    if (starts.length !== 1 || ends.length !== 1 || starts[0].index >= ends[0].index) return undefined
    const start = starts[0].index + starts[0][0].length
    const end = ends[0].index
    return document.slice(start, end).replace(/^\r?\n/, '')
}

async function readCurrentText(root, path) {
    const target = confined(root, path)
    if (!target) return undefined
    try {
        const status = await lstat(target)
        if (!status.isFile() || status.isSymbolicLink() || status.size > 16_777_216) return undefined
        return decodeUtf8(await readFile(target), path)
    } catch {
        return undefined
    }
}

export async function checkRepositoryReferences(root, candidate = 'HEAD') {
    try {
        if (arguments.length > 2) return referenceRefusal('REFERENCE_INPUT_INVALID', 'canonical reference check does not accept caller authority')
        if (typeof root !== 'string' || !isAbsolute(root)) return referenceRefusal('REFERENCE_ROOT_INVALID', 'repository root must be absolute')
        root = resolve(root)
        const bootstrapOwners = await loadBootstrapOwners()
        const troubleshooting = await readCurrentText(root, TROUBLESHOOTING_PATH)
        if (troubleshooting === undefined) return referenceRefusal('REFERENCE_OWNER_INPUT_UNAVAILABLE', 'troubleshooting source is missing or unreadable', TROUBLESHOOTING_PATH)
        const prepared = await prepareRender(root, candidate, bootstrapOwners, troubleshooting)
        if (prepared.result) return prepared.result
        const diagnostics = []
        for (const expected of prepared.rendered.files) {
            const actual = await readCurrentText(root, expected.path)
            if (actual === undefined) diagnostics.push(Object.freeze({ severity: 'error', code: 'REFERENCE_COPY_MISSING', message: 'generated maintainer reference is missing', target: expected.path }))
            else if (actual !== expected.bytes) diagnostics.push(Object.freeze({ severity: 'error', code: 'REFERENCE_COPY_STALE', message: 'generated maintainer reference differs from captured HEAD owners', target: expected.path }))
        }
        const actualRegion = region(troubleshooting)
        if (actualRegion === undefined) diagnostics.push(Object.freeze({ severity: 'error', code: 'REFERENCE_REGION_INVALID', message: 'diagnostic index markers are missing or ambiguous', target: TROUBLESHOOTING_PATH }))
        else if (actualRegion !== prepared.rendered.troubleshooting.bytes) diagnostics.push(Object.freeze({ severity: 'error', code: 'REFERENCE_COPY_STALE', message: 'generated diagnostic index differs from captured HEAD owners', target: TROUBLESHOOTING_PATH }))
        if (!await revalidateCommittedInputs(prepared.snapshot, prepared.owners)) return referenceRefusal('REFERENCE_SOURCE_CHANGED', 'committed reference inputs changed during check')
        return Object.freeze({ kind: 'complete', ok: diagnostics.length === 0, diagnostics: Object.freeze(diagnostics) })
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const match = /^\[([A-Z][A-Z0-9_]+)\]\s*(.*)$/.exec(message)
        return referenceRefusal(match?.[1] ?? 'REFERENCE_OWNER_UNAVAILABLE', match?.[2] ?? message)
    }
}

export async function publishRepositoryReferences(root, options = {}) {
    if (arguments.length > 2 || options === null || typeof options !== 'object' || Array.isArray(options)
        || Object.keys(options).some((key) => key !== 'dryRun')
        || options.dryRun !== undefined && typeof options.dryRun !== 'boolean') {
        return referenceRefusal('REFERENCE_INPUT_INVALID', 'publication accepts only an optional dryRun boolean')
    }
    const dryRun = options.dryRun ?? false
    try {
        if (typeof root !== 'string' || !isAbsolute(root)) return referenceRefusal('REFERENCE_ROOT_INVALID', 'repository root must be absolute')
        root = resolve(root)
        const bootstrapOwners = await loadBootstrapOwners()
        const currentTroubleshooting = await readCurrentText(root, TROUBLESHOOTING_PATH)
        if (currentTroubleshooting === undefined) return referenceRefusal('REFERENCE_OWNER_INPUT_UNAVAILABLE', 'troubleshooting source is missing or unreadable', TROUBLESHOOTING_PATH)
        const prepared = await prepareRender(root, 'HEAD', bootstrapOwners, currentTroubleshooting)
        if (prepared.result) return prepared.result
        const owners = prepared.owners
        const resolvedGit = await owners.executable.resolveGitExecutable({ PATH: process.env.PATH ?? '' })
        if (resolvedGit?.state !== 'available') return referenceRefusal('REFERENCE_GIT_UNAVAILABLE', 'Git executable authority is unavailable')
        const bootstrap = await owners.transaction.captureReferenceBootstrap(root, resolvedGit.value, { execute: owners.execution.executeProbe })
        if (bootstrap?.kind !== 'complete') return bootstrap
        const files = owners.transaction.referenceBootstrapFiles(bootstrap.bootstrap)
        if (!files?.some(({ path }) => path === TROUBLESHOOTING_PATH)) return referenceRefusal('GENERATED_REFERENCE_BOOTSTRAP_INVALID', 'troubleshooting has no authenticated index blob', TROUBLESHOOTING_PATH)
        const record = snapshots.get(prepared.snapshot)
        const sourceBytes = record.blobs.get('package.json')
        if (!sourceBytes) return referenceRefusal('REFERENCE_SOURCE_UNAVAILABLE', 'root package source was not captured', 'package.json')
        const sourceSha256 = createHash('sha256').update(sourceBytes).digest('hex')
        const regionSha256 = createHash('sha256').update(prepared.rendered.troubleshooting.bytes).digest('hex')
        const generation = createHash('sha256').update(JSON.stringify([...prepared.rendered.files.map(({ path, sha256 }) => ({ path, sha256 })),
            { path: TROUBLESHOOTING_PATH, sha256: regionSha256 }])).digest('hex')
        const next = owners.transaction.encodeReferenceManifest({
            generation,
            sourceSha256,
            files: prepared.rendered.files.map(({ path, sha256 }) => ({ path, sha256 })),
            troubleshootingSha256: regionSha256,
        })
        const node = await owners.transaction.nodeAuthority()
        if (!node) return referenceRefusal('REFERENCE_OWNER_UNAVAILABLE', 'Node executable authority is unavailable')
        const execute = owners.execution.executeProbe
        const referenceLedgerPath = '.cockpit/generated-reference-ownership.json'
        const consumerLedgerPath = '.cockpit/generated-environment-ownership.json'
        const referenceLedger = await owners.transaction.readAnchoredEntry(root, referenceLedgerPath, 1_048_576, node, { execute })
        const consumerLedger = await owners.transaction.readAnchoredEntry(root, consumerLedgerPath, 1_048_576, node, { execute })
        const ledgerExpected = owners.transaction.expectedState(referenceLedger)
        const consumerExpected = owners.transaction.expectedState(consumerLedger)
        if (!ledgerExpected || !consumerExpected || !['file', 'missing'].includes(ledgerExpected.kind)
            || !['file', 'missing'].includes(consumerExpected.kind)) return referenceRefusal('GENERATED_REFERENCE_OWNERSHIP_INVALID', 'reference estate ledgers could not be authenticated')
        const packageJson = JSON.parse(decodeUtf8(sourceBytes, 'package.json'))
        if (typeof packageJson.name !== 'string' || packageJson.name.length === 0 || Buffer.byteLength(packageJson.name) > 256) {
            return referenceRefusal('REFERENCE_SOURCE_INVALID', 'root package name is unavailable', 'package.json')
        }
        const cockpitId = packageJson.name
        const sameAnchored = (actual, expected) => !!actual && ['file', 'missing'].includes(actual.kind)
            && JSON.stringify(actual) === JSON.stringify(expected)
        const anchoredToRoot = (entry) => entry?.kind === 'file'
            && entry.identity?.root?.dev === record.rootIdentity.dev
            && entry.identity?.root?.ino === record.rootIdentity.ino
            && Array.isArray(entry.identity.chain)
            && entry.identity.chain.every((identity) => Number.isSafeInteger(identity?.dev) && Number.isSafeInteger(identity?.ino))
        const revalidate = async (deadline, stage) => {
            if (!await revalidateCommittedInputs(prepared.snapshot, owners, deadline)
                || !await owners.transaction.revalidateReferenceBootstrap(bootstrap.bootstrap, { execute }, deadline)) return false
            const consumerCurrent = await owners.transaction.readAnchoredEntry(root, consumerLedgerPath, 1_048_576, node, { execute }, deadline)
            if (!sameAnchored(consumerCurrent, consumerLedger)) return false
            const referenceCurrent = await owners.transaction.readAnchoredEntry(root, referenceLedgerPath, 1_048_576, node, { execute }, deadline)
            if (stage !== 'after-publish') return sameAnchored(referenceCurrent, referenceLedger)
            if (!anchoredToRoot(referenceCurrent) || referenceCurrent.sha256 !== createHash('sha256').update(next.bytes).digest('hex')) return false
            for (const expected of prepared.rendered.files) if (await readCurrentText(root, expected.path) !== expected.bytes) return false
            return await readCurrentText(root, TROUBLESHOOTING_PATH) === prepared.rendered.troubleshooting.document
        }
        const result = await owners.references.writeReferences({
            root,
            publication: {
                authority: Object.freeze({ root, cockpitId, configPath: join(root, 'package.json') }),
                generation,
                sourceSha256,
                rootIdentity: record.rootIdentity,
                node,
                ledgerExpected,
                nextLedgerBytes: next.bytes,
                referenceBootstrap: bootstrap.bootstrap,
            },
            rendered: prepared.rendered,
        }, { dryRun, execute, revalidate })
        return result?.kind === 'complete'
            ? Object.freeze({ ...result, ok: true, diagnostics: Object.freeze([]) })
            : result
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const match = /^\[([A-Z][A-Z0-9_]+)\]\s*(.*)$/.exec(message)
        return referenceRefusal(match?.[1] ?? 'REFERENCE_PUBLICATION_UNAVAILABLE', match?.[2] ?? message)
    }
}
