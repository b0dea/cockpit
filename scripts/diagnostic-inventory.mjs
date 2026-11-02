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
    // The built owners import libexec programs (fence-marker.cjs, rulesync-generator.cjs) beside dist,
    // so the whole directory is part of the committed closure the references are rendered from.
    'packages/cockpit/libexec',
    'packages/cockpit/src',
    'packages/cockpit/surfaces',
    'packages/cockpit/src/references/adopt-cockpit.skill.md',
    'scripts/diagnostic-inventory.mjs',
    'scripts/diagnostic-inventory.d.mts',
    'scripts/docs-lint.mjs',
    'scripts/docs-lint.d.mts',
])
const DIRECTORY_ROOTS = Object.freeze(['packages/cockpit/libexec', 'packages/cockpit/src', 'packages/cockpit/surfaces'])

function isFixedInput(path) {
    return IMPLEMENTATION_ROOTS.includes(path)
        || path.startsWith('packages/cockpit/surfaces/')
        || path.startsWith('packages/cockpit/libexec/')
}

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
    // Each emission is also recorded at the syntax node that produces it, so command attribution
    // can tell which function, not just which module, emits a code.
    const sites = new Map()
    const recordSite = (site, code) => {
        if (!sites.has(site)) sites.set(site, new Set())
        sites.get(site).add(code)
    }
    const addCode = (code, path, site) => {
        if (!owners.has(code)) owners.set(code, new Set())
        if (!remedies.has(code)) remedies.set(code, new Set())
        owners.get(code).add(path)
        if (site) recordSite(site, code)
    }
    const environmentContract = sources.get('packages/cockpit/src/environment/contract.ts')
    const environmentCodes = environmentContract === undefined
        ? new Map()
        : new Map(Object.entries(environmentDiagnosticRegistry(environmentContract)))
    if (environmentContract !== undefined) {
        for (const code of environmentCodes.values()) {
            addCode(code, 'packages/cockpit/src/environment/contract.ts')
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
                addCode(code, path, object)
                remedies.get(code).add(fix)
            }
        }
        const constructorName = (expression) => {
            if (ts.isIdentifier(expression)) return expression.text
            if (ts.isPropertyAccessExpression(expression)) return expression.name.text
            return ''
        }
        // owned: false records the site for command attribution only, leaving the owner index on
        // its stricter rules.
        const collectDiagnosticExpression = (expression, site, owned = true) => {
            const emit = (code) => owned ? addCode(code, path, site) : recordSite(site, code)
            const value = unwrapExpression(expression)
            if (ts.isStringLiteral(value)) {
                if (uppercaseDiagnostic(value.text)) emit(value.text)
            } else if (ts.isPropertyAccessExpression(value) && ts.isIdentifier(value.expression)
                && environmentCodeBindings.has(value.expression.text)) {
                const code = environmentCodes.get(value.name.text)
                if (code) emit(code)
            } else if (ts.isConditionalExpression(value)) {
                collectDiagnosticExpression(value.whenTrue, site, owned)
                collectDiagnosticExpression(value.whenFalse, site, owned)
            } else if (ts.isBinaryExpression(value)
                && [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken].includes(value.operatorToken.kind)) {
                collectDiagnosticExpression(value.left, site, owned)
                collectDiagnosticExpression(value.right, site, owned)
            }
        }
        const visit = (node) => {
            if (ts.isCallExpression(node) && /(?:diagnostic|refus|fail|error|usageOutcome)/i.test(constructorName(node.expression))) {
                const first = node.arguments[0]
                if (first) collectDiagnosticExpression(first, node)
            }
            const codeProperty = (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node))
                && ((ts.isIdentifier(node.name) && node.name.text === 'code') || (ts.isStringLiteral(node.name) && node.name.text === 'code'))
            // A code named in an object that is not returned directly (a lookup row, an array element,
            // a pushed diagnostic) or as a `code` parameter default is still emitted by whatever
            // reaches it, so command attribution counts it.
            if (codeProperty && !returnedObjects.has(node.parent) && ts.isPropertyAssignment(node)) {
                collectDiagnosticExpression(node.initializer, node, false)
            }
            if (ts.isParameter(node) && ts.isIdentifier(node.name) && node.name.text === 'code' && node.initializer) {
                collectDiagnosticExpression(node.initializer, node, false)
            }
            // A registry code held in a variable before it reaches a diagnostic, as a process
            // runner's failure code is. Comparisons, case labels, code lists and lookup keys only
            // test or index a code.
            if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && environmentCodeBindings.has(node.expression.text)
                && environmentCodes.has(node.name.text) && !testsCode(node)) recordSite(node, environmentCodes.get(node.name.text))
            if (codeProperty && returnedObjects.has(node.parent)) {
                const value = ts.isShorthandPropertyAssignment(node) ? node.name : node.initializer
                collectDiagnosticExpression(value, node)
                if (ts.isIdentifier(value)) {
                    let owner = node.parent
                    while (owner && !ts.isFunctionLike(owner)) owner = owner.parent
                    const parameter = owner?.parameters?.find((item) => ts.isIdentifier(item.name) && item.name.text === value.text)
                    if (parameter?.type) {
                        const typeText = parameter.type.getText(source)
                        for (const [name, values] of exportedUnions) {
                            // No site: the code is whatever each caller passes, and the callers' own
                            // literal codes are their sites. Recording every union member here would
                            // list it under every command that reaches this helper for any one code.
                            if (new RegExp(`\\b${name}\\b`).test(typeText)) for (const code of values) addCode(code, path)
                        }
                    }
                }
            }
            ts.forEachChild(node, visit)
        }
        visit(source)
    }
    // Computed on first read: the documentation lint reads only the code list, on every run.
    let commandDiagnostics
    return {
        items: [...owners.keys()].sort().map((code) => `diagnostic:${code}`), owners, remedies,
        get commandDiagnostics() {
            commandDiagnostics ??= commandDiagnosticsFromSources(parsedSources, resolveSourceImport, sites, new Set(owners.keys()))
            return commandDiagnostics
        },
    }
}

const CLI_PATH = 'packages/cockpit/src/cli.ts'
const COMMAND_TABLE_PATH = 'packages/cockpit/src/command-table.ts'
// The CLI binding's own vocabulary, which the attribution below reads to follow one command through
// shared dispatch code. Renaming any of these loses precision rather than coverage: the analysis
// then walks every branch and lists codes under commands that cannot reach them, which the
// reference tests catch by asserting codes that must stay out of every command's table.
const CLI_ENTRY = 'runCli'
// Functions returning the handler objects; only the selected command's entry, and entries the
// dispatch code names (`operators.beginOperatorReset`), belong to that command.
const CLI_HANDLER_MAPS = new Set(['defaultHandlers', 'defaultOperatorHandlers'])
// runCli's bindings once a public command has been selected: a name and definition were given,
// and it is not the internal guard command.
const CLI_SELECTED_COMMAND = new Map([['commandName', true], ['definition', true], ['internal', false]])
// executeOutcome writes an outcome only when it carries both an artifact and a destination, a
// guard reachability alone cannot see. Its codes go to a command only if that command's own
// reachable code builds such an outcome.
const CLI_OUTPUT_PUBLISHER = 'executeOutcome'

function commandHandlers(source) {
    const declaration = source?.statements.filter(ts.isVariableStatement)
        .flatMap(statement => [...statement.declarationList.declarations])
        .find(candidate => ts.isIdentifier(candidate.name) && candidate.name.text === 'commands')
    let rows = declaration?.initializer
    while (rows && (ts.isAsExpression(rows) || ts.isSatisfiesExpression(rows) || ts.isParenthesizedExpression(rows))) rows = rows.expression
    if (!rows || !ts.isArrayLiteralExpression(rows)) return []
    return rows.elements.flatMap(row => ts.isObjectLiteralExpression(row) ? row.properties.flatMap(property =>
        ts.isPropertyAssignment(property) && ts.isIdentifier(property.name) && property.name.text === 'handler'
            && ts.isStringLiteral(property.initializer) ? [property.initializer.text] : []) : [])
}

function testsCode(node) {
    const parent = node.parent
    if (ts.isBinaryExpression(parent) && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken,
        ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken].includes(parent.operatorToken.kind)) return true
    if (ts.isCaseClause(parent) || ts.isArrayLiteralExpression(parent) || ts.isComputedPropertyName(parent)) return true
    return ts.isCallExpression(parent) && ts.isPropertyAccessExpression(parent.expression)
        && ['includes', 'has', 'get', 'indexOf'].includes(parent.expression.name.text)
}

function bindingNames(name) {
    if (ts.isIdentifier(name)) return [name.text]
    return name.elements.flatMap(element => ts.isOmittedExpression(element) ? [] : bindingNames(element.name))
}

function unwrapValue(node) {
    let current = node
    while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isSatisfiesExpression(current)
        || ts.isNonNullExpression(current)) current = current.expression
    return current
}

function isFunctionValue(node) {
    const value = unwrapValue(node)
    return ts.isArrowFunction(value) || ts.isFunctionExpression(value)
}

const UNDEFINED = Symbol('undefined')

function terminates(statement) {
    if (ts.isReturnStatement(statement) || ts.isThrowStatement(statement)) return true
    return ts.isBlock(statement) && statement.statements.length > 0 && terminates(statement.statements.at(-1))
}

function isReference(node) {
    const parent = node.parent
    if (!parent) return false
    if ((ts.isPropertyAccessExpression(parent) || ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(parent)
        || ts.isPropertyDeclaration(parent) || ts.isGetAccessorDeclaration(parent) || ts.isSetAccessorDeclaration(parent)
        || ts.isEnumMember(parent) || ts.isVariableDeclaration(parent) || ts.isParameter(parent)
        || ts.isFunctionDeclaration(parent) || ts.isFunctionExpression(parent) || ts.isClassDeclaration(parent)
        || ts.isClassExpression(parent) || ts.isBindingElement(parent)) && parent.name === node) return false
    if (ts.isBindingElement(parent) && parent.propertyName === node) return false
    return !ts.isLabeledStatement(parent) && !ts.isBreakOrContinueStatement(parent)
}

// Reading only these from an outcome decides control flow or carries payload and prose; diagnostics
// travel in the outcome itself or its `diagnostics`, so these reads do not pass codes on.
const INSPECTED_OUTCOME_FIELDS = new Set(['kind', 'status', 'state', 'ok', 'result', 'value', 'reason', 'message'])

const DIAGNOSTIC_CARRIERS = new Set(['diagnostics', 'diagnostic', 'code'])

function withinThrow(node, scope) {
    for (let current = node; current && current !== scope; current = current.parent) if (ts.isThrowStatement(current)) return true
    return false
}

/**
 * Which codes each public command can emit: the emission sites reachable from runCli once that
 * command is selected, following references from function to function across modules, and only
 * through calls whose outcome can reach the command's output.
 *
 * It over-approximates where syntax cannot see further. A function handed on as a value counts
 * wherever it may be called, a top-level factory counts whole even when a command uses one of the
 * closures it returns, a code is listed where a caller folds it into another diagnostic other than
 * by inspecting the outcome or quoting it in a thrown error, and branches are pruned only on the
 * CLI binding's own command dispatch, never on runtime data inside a module.
 *
 * It can under-approximate in two shapes, which the CLI reference test guards for the failure paths
 * it drives: a code that leaves a function other than through its outcome (pushed into an argument
 * the caller later returns) while the caller only inspects that outcome, and a code held in a
 * variable that is neither a registry member nor named at a diagnostic constructor or `code` field.
 */
function commandDiagnosticsFromSources(parsedSources, resolveSourceImport, sites, known) {
    const handlers = commandHandlers(parsedSources.get(COMMAND_TABLE_PATH))
    if (!parsedSources.has(CLI_PATH) || handlers.length === 0) return new Map()
    const keyOf = (path, name) => `${path}\0${name}`
    const modules = new Map()
    for (const [path, source] of parsedSources) {
        const declarations = new Map()
        const body = []
        const exportsOf = new Map()
        const stars = []
        const imports = new Map()
        const declare = (name, node, isExported) => {
            declarations.set(name, [...(declarations.get(name) ?? []), node])
            if (isExported) exportsOf.set(name, { path, name })
        }
        for (const statement of source.statements) {
            if (ts.isImportDeclaration(statement)) {
                const dependency = ts.isStringLiteral(statement.moduleSpecifier)
                    ? resolveSourceImport(path, statement.moduleSpecifier.text) : undefined
                const clause = statement.importClause
                if (!dependency || !clause || clause.isTypeOnly) continue
                if (clause.name) imports.set(clause.name.text, { path: dependency, name: 'default' })
                const named = clause.namedBindings
                if (named && ts.isNamespaceImport(named)) imports.set(named.name.text, { path: dependency, name: '*' })
                if (named && ts.isNamedImports(named)) for (const element of named.elements) {
                    if (!element.isTypeOnly) imports.set(element.name.text, { path: dependency, name: (element.propertyName ?? element.name).text })
                }
            } else if (ts.isExportDeclaration(statement)) {
                if (statement.isTypeOnly) continue
                const dependency = statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)
                    ? resolveSourceImport(path, statement.moduleSpecifier.text) : undefined
                if (statement.moduleSpecifier && !dependency) continue
                if (!statement.exportClause) stars.push(dependency)
                else if (ts.isNamedExports(statement.exportClause)) for (const element of statement.exportClause.elements) {
                    if (!element.isTypeOnly) exportsOf.set(element.name.text, { path: dependency ?? path, name: (element.propertyName ?? element.name).text })
                }
            } else if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isEnumDeclaration(statement)) {
                if (statement.name) declare(statement.name.text, statement, exported(statement))
            } else if (ts.isVariableStatement(statement)) {
                for (const declaration of statement.declarationList.declarations) {
                    for (const name of bindingNames(declaration.name)) declare(name, declaration, exported(statement))
                }
            } else if (!ts.isInterfaceDeclaration(statement) && !ts.isTypeAliasDeclaration(statement)
                && !ts.isModuleDeclaration(statement) && !ts.isExportAssignment(statement)) {
                body.push(statement)
            }
        }
        modules.set(path, { declarations, body, exportsOf, stars, imports })
    }
    const resolveExport = (path, name, seen = new Set()) => {
        const module = modules.get(path)
        if (!module || seen.has(keyOf(path, name))) return undefined
        seen.add(keyOf(path, name))
        const target = module.exportsOf.get(name)
        if (target) return target.path === path ? resolveLocal(path, target.name, seen) : resolveExport(target.path, target.name, seen)
        for (const star of module.stars) {
            const resolved = resolveExport(star, name, seen)
            if (resolved) return resolved
        }
        return undefined
    }
    // A key names one top-level declaration; a namespace import resolves to its module path alone.
    const resolveLocal = (path, name, seen = new Set()) => {
        const module = modules.get(path)
        if (module?.declarations.has(name)) return keyOf(path, name)
        const imported = module?.imports.get(name)
        if (!imported) return undefined
        return imported.name === '*' ? { namespace: imported.path } : resolveExport(imported.path, imported.name, seen)
    }
    const allExports = (path) => [...(modules.get(path)?.exportsOf.keys() ?? [])]
        .map(name => resolveExport(path, name)).filter(key => typeof key === 'string')

    const declarationOf = (path, name) => {
        const resolved = resolveLocal(path, name)
        if (typeof resolved !== 'string') return undefined
        const [owner, local] = resolved.split('\0')
        const node = modules.get(owner).declarations.get(local)?.[0]
        return node && ts.isFunctionDeclaration(node) ? node : undefined
    }
    // Whether a local holding an outcome passes it on: any use but an inspected field read or text
    // for a thrown error does, and so does handing it to a function that passes its parameter on.
    const holderForwards = (path, scope, name, declaration, depth) => {
        let forwarded = false
        const visit = (node) => {
            if (forwarded) return
            if (ts.isIdentifier(node) && node.text === name && node !== declaration && isReference(node) && !withinThrow(node, scope)) {
                forwarded = valueForwards(path, node, depth)
            }
            ts.forEachChild(node, visit)
        }
        visit(scope)
        return forwarded
    }
    // Whether an outcome-valued expression can reach the command's output. Depth bounds the walk
    // through callee parameters; past it the value is assumed to be passed on.
    const valueForwards = (path, expression, depth) => {
        let value = expression
        while (ts.isAwaitExpression(value.parent) || ts.isParenthesizedExpression(value.parent) || ts.isAsExpression(value.parent)
            || ts.isNonNullExpression(value.parent) || ts.isConditionalExpression(value.parent) && value.parent.condition !== value) value = value.parent
        const fields = []
        let read = value
        while (ts.isPropertyAccessExpression(read.parent) && read.parent.expression === read) {
            fields.push(read.parent.name.text)
            read = read.parent
        }
        if (fields.length > 0) {
            if (INSPECTED_OUTCOME_FIELDS.has(fields[0])) return false
            // A method on the outcome, such as a continuation's decide(), yields the next outcome.
            if (ts.isCallExpression(read.parent) && read.parent.expression === read) return valueForwards(path, read.parent, depth)
            // A leaf inside a nested field is plain data unless the path names the diagnostics channel.
            if (fields.length > 1) return fields.some(field => DIAGNOSTIC_CARRIERS.has(field))
            return valueForwards(path, read, depth)
        }
        const holder = value.parent
        if (ts.isVariableDeclaration(holder) && holder.initializer === value && ts.isIdentifier(holder.name)) {
            let scope = holder.parent
            while (scope && !ts.isFunctionLike(scope) && !ts.isSourceFile(scope)) scope = scope.parent
            return holderForwards(path, scope, holder.name.text, holder.name, depth)
        }
        if (ts.isCallExpression(holder) && holder.expression !== value && ts.isIdentifier(holder.expression) && depth > 0) {
            const callee = declarationOf(path, holder.expression.text)
            const parameter = callee?.parameters[holder.arguments.indexOf(value)]
            if (callee?.body && parameter && ts.isIdentifier(parameter.name)) {
                return holderForwards(callee.getSourceFile().fileName, callee, parameter.name.text, parameter.name, depth - 1)
            }
        }
        return true
    }
    // A function's codes reach the command only through its outcome; a reference that is not a call
    // hands the function on, which counts as passing its outcome on.
    const forwardsResult = (path, identifier) => !ts.isCallExpression(identifier.parent) || identifier.parent.expression !== identifier
        || valueForwards(path, identifier.parent, 2)

    const walk = (path, root, accumulator, command) => {
        const lazies = new Map()
        const walked = new Set()
        const collectLazies = (node) => {
            if (node !== root) {
                if (ts.isFunctionDeclaration(node) && node.name) {
                    lazies.set(node.name.text, [...(lazies.get(node.name.text) ?? []), node])
                } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && isFunctionValue(node.initializer)) {
                    lazies.set(node.name.text, [...(lazies.get(node.name.text) ?? []), node.initializer])
                }
            }
            ts.forEachChild(node, collectLazies)
        }
        collectLazies(root)
        // Only the CLI binding branches on the selected command, so only its walks evaluate conditions.
        const atCli = command !== undefined && path === CLI_PATH
        const localConstants = new Map()
        const collectConstants = (node) => {
            if (ts.isVariableDeclarationList(node) && node.flags & ts.NodeFlags.Const) for (const declaration of node.declarations) {
                if (ts.isIdentifier(declaration.name) && declaration.initializer) localConstants.set(declaration.name.text, unwrapValue(declaration.initializer))
            }
            ts.forEachChild(node, collectConstants)
        }
        if (atCli) collectConstants(root)
        const isLazy = (node) => node !== root && (ts.isFunctionDeclaration(node) && node.name !== undefined
            || ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer !== undefined && isFunctionValue(node.initializer))
        const skipped = new Set()
        const request = (name) => {
            if (!atCli) return
            command.requested.add(name)
            for (const pending of command.members.get(name) ?? []) {
                if (command.walkedMembers.has(pending)) continue
                command.walkedMembers.add(pending)
                pending()
            }
        }
        const reference = (name, site) => {
            if (site && !forwardsResult(path, site)) return
            if (lazies.has(name)) {
                if (walked.has(name)) return
                walked.add(name)
                for (const node of lazies.get(name)) ts.isFunctionDeclaration(node) ? ts.forEachChild(node, visit) : visit(node)
                return
            }
            const resolved = resolveLocal(path, name)
            if (typeof resolved === 'string') accumulator.edges.add(resolved)
            else if (resolved) for (const key of allExports(resolved.namespace)) accumulator.edges.add(key)
        }
        const value = (expression, bound) => {
            const node = unwrapValue(expression)
            if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
            if (ts.isIdentifier(node) && bound.has(node.text)) return bound.get(node.text)
            if (ts.isIdentifier(node) && node.text === 'handler' || ts.isPropertyAccessExpression(node) && node.name.text === 'handler') return command.handler
            if (ts.isIdentifier(node) && node.text === 'undefined') return UNDEFINED
            // A local constant chosen by a decided condition, such as one computed only for setup.
            const constant = ts.isIdentifier(node) ? localConstants.get(node.text) : undefined
            if (constant && ts.isConditionalExpression(constant)) {
                const taken = decide(constant.condition, bound)
                if (taken !== undefined) return value(taken ? constant.whenTrue : constant.whenFalse, bound)
            }
            return undefined
        }
        // true or false when the selected command decides the condition, undefined otherwise.
        const decide = (expression, bound = new Map()) => {
            const node = unwrapValue(expression)
            if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) {
                const operand = decide(node.operand, bound)
                return operand === undefined ? undefined : !operand
            }
            if (ts.isIdentifier(node) && bound.size === 0 && CLI_SELECTED_COMMAND.has(node.text)) return CLI_SELECTED_COMMAND.get(node.text)
            if (ts.isBinaryExpression(node)) {
                const operator = node.operatorToken.kind
                if ([ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(operator)) {
                    const left = value(node.left, bound)
                    const right = value(node.right, bound)
                    if (left === undefined || right === undefined) return undefined
                    return (left === right) === (operator === ts.SyntaxKind.EqualsEqualsEqualsToken)
                }
                if (operator === ts.SyntaxKind.AmpersandAmpersandToken || operator === ts.SyntaxKind.BarBarToken) {
                    const left = decide(node.left, bound)
                    const right = decide(node.right, bound)
                    const and = operator === ts.SyntaxKind.AmpersandAmpersandToken
                    if (left === !and || right === !and) return !and
                    return left === and && right === and ? and : undefined
                }
            }
            if (ts.isCallExpression(node) && node.arguments.length === 1) {
                const argument = value(node.arguments[0], bound)
                if (argument === undefined) return undefined
                if (ts.isPropertyAccessExpression(node.expression) && ['startsWith', 'endsWith'].includes(node.expression.name.text)) {
                    const subject = value(node.expression.expression, bound)
                    return subject === undefined ? undefined : subject[node.expression.name.text](argument)
                }
                // A one-line predicate such as isWorkHandler is evaluated with the command bound to its parameter.
                const resolved = ts.isIdentifier(node.expression) ? resolveLocal(path, node.expression.text) : undefined
                const [predicatePath, predicateName] = typeof resolved === 'string' ? resolved.split('\0') : []
                const predicate = predicateName === undefined ? undefined : modules.get(predicatePath).declarations.get(predicateName)?.[0]
                const returned = predicate && ts.isFunctionDeclaration(predicate) && predicate.parameters.length === 1
                    && ts.isIdentifier(predicate.parameters[0].name) && predicate.body?.statements.length === 1
                    && ts.isReturnStatement(predicate.body.statements[0]) ? predicate.body.statements[0].expression : undefined
                if (returned) return decide(returned, new Map([[predicate.parameters[0].name.text, argument]]))
            }
            return undefined
        }
        const visit = (node) => {
            if (ts.isTypeNode(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)
                || ts.isImportDeclaration(node) || skipped.has(node) || isLazy(node)) return
            for (const code of sites.get(node) ?? []) if (known.has(code)) accumulator.codes.add(code)
            if (ts.isObjectLiteralExpression(node)) {
                const published = (name) => node.properties.some(property => property.name && ts.isIdentifier(property.name) && property.name.text === name
                    && (ts.isShorthandPropertyAssignment(property) || ts.isPropertyAssignment(property) && property.initializer.kind !== ts.SyntaxKind.NullKeyword))
                if (published('artifact') && published('destination')) accumulator.publishesOutput = true
            }
            if (ts.isIdentifier(node)) {
                if (isReference(node)) reference(node.text, node)
                return
            }
            if (ts.isShorthandPropertyAssignment(node)) {
                reference(node.name.text)
                if (node.objectAssignmentInitializer) visit(node.objectAssignmentInitializer)
                return
            }
            if (ts.isPropertyAccessExpression(node)) {
                const resolved = ts.isIdentifier(node.expression) && !lazies.has(node.expression.text) ? resolveLocal(path, node.expression.text) : undefined
                if (resolved && typeof resolved !== 'string') {
                    const key = resolveExport(resolved.namespace, node.name.text)
                    if (key) accumulator.edges.add(key)
                } else visit(node.expression)
                request(node.name.text)
                return
            }
            if (ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression)) request(node.argumentExpression.text)
            if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
                const specifier = node.arguments[0]
                const dependency = specifier && ts.isStringLiteral(specifier) ? resolveSourceImport(path, specifier.text) : undefined
                if (dependency) {
                    const holder = ts.isAwaitExpression(node.parent) ? node.parent.parent : node.parent
                    const names = ts.isVariableDeclaration(holder) && ts.isObjectBindingPattern(holder.name)
                        ? holder.name.elements.map(element => (element.propertyName ?? element.name).getText())
                        : undefined
                    for (const key of names ? names.map(name => resolveExport(dependency, name)) : allExports(dependency)) {
                        if (typeof key === 'string') accumulator.edges.add(key)
                    }
                }
            }
            if (atCli) {
                // Statements after a branch the command takes and that always returns are not reached.
                if (ts.isBlock(node)) {
                    for (const statement of node.statements) {
                        visit(statement)
                        if (ts.isIfStatement(statement) && decide(statement.expression) === true && terminates(statement.thenStatement)) break
                    }
                    return
                }
                if (ts.isIfStatement(node)) {
                    visit(node.expression)
                    const taken = decide(node.expression)
                    if (taken !== false) visit(node.thenStatement)
                    if (taken !== true && node.elseStatement) visit(node.elseStatement)
                    return
                }
                if (ts.isConditionalExpression(node)) {
                    visit(node.condition)
                    const taken = decide(node.condition)
                    if (taken !== false) visit(node.whenTrue)
                    if (taken !== true) visit(node.whenFalse)
                    return
                }
                if (ts.isBinaryExpression(node) && [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken].includes(node.operatorToken.kind)) {
                    visit(node.left)
                    const left = decide(node.left)
                    if (left !== (node.operatorToken.kind === ts.SyntaxKind.BarBarToken)) visit(node.right)
                    return
                }
            }
            ts.forEachChild(node, visit)
        }
        if (atCli && ts.isFunctionDeclaration(root) && CLI_HANDLER_MAPS.has(root.name?.text)) {
            for (const statement of root.body?.statements ?? []) {
                const value = ts.isReturnStatement(statement) && statement.expression ? unwrapValue(statement.expression) : undefined
                if (!value || !ts.isObjectLiteralExpression(value)) continue
                for (const property of value.properties) {
                    if (ts.isSpreadAssignment(property) || !property.name) continue
                    const name = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) ? property.name.text : undefined
                    if (name === undefined) continue
                    skipped.add(property)
                    command.members.set(name, [...(command.members.get(name) ?? []), () => ts.isShorthandPropertyAssignment(property)
                        ? reference(property.name.text) : ts.forEachChild(property, visit)])
                    if (command.requested.has(name)) request(name)
                }
            }
        }
        if (ts.isVariableDeclaration(root)) {
            if (root.initializer) visit(root.initializer)
        } else if (ts.isFunctionDeclaration(root) || ts.isClassDeclaration(root) || ts.isEnumDeclaration(root)) {
            ts.forEachChild(root, visit)
        } else visit(root)
    }

    const rootsOf = (key) => {
        const [path, name] = key.split('\0')
        const module = modules.get(path)
        return name === '' ? module.body : module.declarations.get(name) ?? []
    }
    // Code outside the CLI binding never branches on the selected command, so its reach is shared.
    const shared = new Map()
    const sharedReach = (key) => {
        if (!shared.has(key)) {
            const accumulator = { codes: new Set(), edges: new Set(), publishesOutput: false }
            for (const root of rootsOf(key)) walk(key.split('\0')[0], root, accumulator, undefined)
            shared.set(key, accumulator)
        }
        return shared.get(key)
    }
    const result = new Map()
    for (const handler of new Set(handlers)) {
        const command = { handler, requested: new Set(), members: new Map(), walkedMembers: new Set() }
        const reach = { codes: new Set(), edges: new Set(), publishesOutput: false }
        const published = { codes: new Set(), edges: reach.edges, publishesOutput: false }
        const queue = [keyOf(CLI_PATH, CLI_ENTRY)]
        const seen = new Set()
        while (queue.length > 0) {
            const key = queue.pop()
            if (seen.has(key)) continue
            seen.add(key)
            const [path, name] = key.split('\0')
            queue.push(keyOf(path, ''))
            if (path === CLI_PATH) {
                for (const root of rootsOf(key)) walk(path, root, name === CLI_OUTPUT_PUBLISHER ? published : reach, command)
                queue.push(...reach.edges)
                reach.edges.clear()
            } else {
                const found = sharedReach(key)
                for (const code of found.codes) reach.codes.add(code)
                if (found.publishesOutput) reach.publishesOutput = true
                queue.push(...found.edges)
            }
        }
        if (reach.publishesOutput) for (const code of published.codes) reach.codes.add(code)
        result.set(handler, reach.codes)
    }
    return result
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
        const fixedInput = isFixedInput(path)
        if (productionSource || fixedInput) rows.push(Object.freeze({ mode: match[1], oid: match[2], path }))
    }
    rows.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
    const required = [
        ...IMPLEMENTATION_ROOTS.filter((path) => !DIRECTORY_ROOTS.includes(path)),
        'packages/cockpit/libexec/fence-marker.cjs',
        'packages/cockpit/libexec/rulesync-generator.cjs',
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
            const fixedInput = isFixedInput(path)
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
        // Mirrors the exclusions in packages/cockpit/tsconfig.build.json: those sources are never built.
        if (!row.path.startsWith('packages/cockpit/src/') || !row.path.endsWith('.ts')
            || row.path.startsWith('packages/cockpit/src/test-support/') || row.path.includes('/fixtures/')) continue
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
            if (actual === undefined) diagnostics.push(Object.freeze({ severity: 'error', code: 'REFERENCE_COPY_MISSING', message: 'generated reference page is missing; run npm run references', target: expected.path }))
            else if (actual !== expected.bytes) diagnostics.push(Object.freeze({ severity: 'error', code: 'REFERENCE_COPY_STALE', message: 'generated reference page differs from what the committed sources produce; run npm run references', target: expected.path }))
        }
        const actualRegion = region(troubleshooting)
        if (actualRegion === undefined) diagnostics.push(Object.freeze({ severity: 'error', code: 'REFERENCE_REGION_INVALID', message: 'diagnostic index markers are missing or ambiguous', target: TROUBLESHOOTING_PATH }))
        else if (actualRegion !== prepared.rendered.troubleshooting.bytes) diagnostics.push(Object.freeze({ severity: 'error', code: 'REFERENCE_COPY_STALE', message: 'troubleshooting diagnostic index differs from what the committed sources produce; run npm run references', target: TROUBLESHOOTING_PATH }))
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
