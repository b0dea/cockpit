import { readdirSync, readFileSync } from 'node:fs'
import { join, posix, sep } from 'node:path'
import ts from '@typescript/typescript6'

/**
 * What the index can say about a code's fix: the one fix every emission states, that emissions
 * state different fixes (or some state none), or that none states a literal fix.
 */
export type DiagnosticRemedy =
    | Readonly<{ kind: 'fixed'; fix: string }>
    | Readonly<{ kind: 'varies' }>
    | Readonly<{ kind: 'none' }>

export interface DiagnosticInventory {
    /** Every code production source emits, sorted. */
    readonly codes: readonly string[]
    /** The production modules that emit each code. */
    readonly owners: ReadonlyMap<string, ReadonlySet<string>>
    readonly remedies: ReadonlyMap<string, DiagnosticRemedy>
}

const SOURCE_ROOT = 'packages/cockpit/src'
const ENVIRONMENT_CONTRACT = 'packages/cockpit/src/environment/contract.ts'
// Constructor names that take a code as their first argument.
const DIAGNOSTIC_CONSTRUCTOR = /(?:diagnostic|refus|fail|error|usageOutcome)/i
const FALLBACK_OPERATORS: readonly ts.SyntaxKind[] = [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken]

/** Production TypeScript under packages/cockpit/src in the working tree, keyed by repository path. */
export function productionSources(root: string): Map<string, string> {
    const directory = join(root, SOURCE_ROOT)
    const sources = new Map<string, string>()
    for (const entry of readdirSync(directory, { recursive: true, withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts') || entry.name.endsWith('.d.ts')) continue
        const path = join(entry.parentPath, entry.name)
        sources.set(posix.join(SOURCE_ROOT, path.slice(directory.length + 1).split(sep).join('/')), readFileSync(path, 'utf8'))
    }
    return new Map([...sources].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0))
}

function parse(path: string, source: string): ts.SourceFile {
    const parsed = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    if ((parsed as unknown as { parseDiagnostics?: unknown[] }).parseDiagnostics?.length) throw new Error(`${path}: TypeScript source is not parseable`)
    return parsed
}

function exported(node: ts.Node): boolean {
    return ts.canHaveModifiers(node) && ts.getModifiers(node)?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword) === true
}

function uppercaseDiagnostic(value: string): boolean {
    return /^[A-Z][A-Z0-9_]*_[A-Z0-9_]+$/.test(value)
}

function propertyName(node: ts.ObjectLiteralElementLike): string | undefined {
    return node.name && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) ? node.name.text : undefined
}

function environmentRegistry(source: string): Map<string, string> {
    const start = source.indexOf('export const ENVIRONMENT_CODES')
    const end = source.indexOf('export const EXECUTION_FAILURE_CODES', start)
    if (start === -1 || end === -1) throw new Error('environment diagnostic registry is unavailable')
    return new Map([...source.slice(start, end).matchAll(/([A-Z][A-Z0-9_]+):\s*'([A-Z][A-Z0-9_]+)'/g)].map(match => [match[1]!, match[2]!]))
}

// Comparisons, case labels, code lists and lookup keys only test or index a code.
function testsCode(node: ts.Node): boolean {
    const parent = node.parent
    if (ts.isBinaryExpression(parent) && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken,
        ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken].includes(parent.operatorToken.kind)) return true
    if (ts.isCaseClause(parent) || ts.isArrayLiteralExpression(parent) || ts.isComputedPropertyName(parent)) return true
    return ts.isCallExpression(parent) && ts.isPropertyAccessExpression(parent.expression)
        && ['includes', 'has', 'get', 'indexOf'].includes(parent.expression.name.text)
}

function unwrap(node: ts.Expression): ts.Expression {
    let current = node
    while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isSatisfiesExpression(current) || ts.isNonNullExpression(current)) current = current.expression
    if (ts.isCallExpression(current) && ts.isPropertyAccessExpression(current.expression) && ts.isIdentifier(current.expression.expression)
        && current.expression.expression.text === 'Object' && current.expression.name.text === 'freeze' && current.arguments.length === 1) {
        return unwrap(current.arguments[0]!)
    }
    return current
}

/** The codes production source emits, the modules that emit each, and the fix each states. */
export function diagnosticInventoryFromSources(sources: ReadonlyMap<string, string>): DiagnosticInventory {
    const owners = new Map<string, Set<string>>()
    // Every place that emits a code, with the literal fixes stated there: a code has one fixed remedy
    // only when all of them state the same single fix, so the index never repeats one place's fix
    // for a code another place emits with a different one or with a fix computed at runtime.
    const fixSites = new Map<string, Map<ts.Node, readonly string[]>>()
    const observeFix = (code: string, site: ts.Node, fixes: readonly string[]) => {
        if (!fixSites.has(code)) fixSites.set(code, new Map())
        fixSites.get(code)!.set(site, fixes)
    }
    const addCode = (code: string, path: string) => {
        if (!owners.has(code)) owners.set(code, new Set())
        owners.get(code)!.add(path)
    }
    const resolveImport = (owner: string, specifier: string) => {
        if (!specifier.startsWith('.')) return undefined
        const joined = posix.normalize(posix.join(posix.dirname(owner), specifier))
        const candidates = specifier.endsWith('.js') ? [`${joined.slice(0, -3)}.ts`] : [joined, `${joined}.ts`, `${joined}/index.ts`]
        return candidates.find(candidate => sources.has(candidate))
    }
    const contract = sources.get(ENVIRONMENT_CONTRACT)
    const environmentCodes = contract === undefined ? new Map<string, string>() : environmentRegistry(contract)
    for (const code of environmentCodes.values()) addCode(code, ENVIRONMENT_CONTRACT)

    for (const [path, text] of sources) {
        const source = parse(path, text)
        const registryBindings = new Set(path === ENVIRONMENT_CONTRACT ? ['ENVIRONMENT_CODES'] : [])
        for (const statement of source.statements) {
            if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)
                || resolveImport(path, statement.moduleSpecifier.text) !== ENVIRONMENT_CONTRACT) continue
            const named = statement.importClause?.namedBindings
            if (named && ts.isNamedImports(named)) for (const element of named.elements) {
                if ((element.propertyName ?? element.name).text === 'ENVIRONMENT_CODES') registryBindings.add(element.name.text)
            }
        }
        // Exported code lists and unions, so a helper whose `code` parameter is typed by one owns its members.
        const exportedCodeArrays = new Map<string, string[]>()
        for (const statement of source.statements) {
            if (!ts.isVariableStatement(statement) || !exported(statement)) continue
            for (const declaration of statement.declarationList.declarations) {
                if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue
                const initializer = unwrap(declaration.initializer)
                if (!ts.isArrayLiteralExpression(initializer)) continue
                const values = initializer.elements.filter(ts.isStringLiteral).map(element => element.text).filter(uppercaseDiagnostic)
                if (values.length > 0) exportedCodeArrays.set(declaration.name.text, values)
            }
        }
        const exportedUnions = new Map<string, string[]>()
        for (const statement of source.statements) {
            if (!ts.isTypeAliasDeclaration(statement) || !exported(statement)) continue
            const values: string[] = []
            const collect = (node: ts.TypeNode) => {
                if (ts.isLiteralTypeNode(node) && ts.isStringLiteral(node.literal) && uppercaseDiagnostic(node.literal.text)) values.push(node.literal.text)
                else if (ts.isUnionTypeNode(node)) node.types.forEach(collect)
            }
            collect(statement.type)
            const registry = /^typeof\s+([A-Za-z_$][\w$]*)\s*\[\s*number\s*\]$/.exec(statement.type.getText(source))
            if (registry && exportedCodeArrays.has(registry[1]!)) values.push(...exportedCodeArrays.get(registry[1]!)!)
            if (values.length > 0) exportedUnions.set(statement.name.text, values)
        }
        // One-line wrappers around snapshotJson return their argument.
        const snapshotWrappers = new Set(['snapshotJson'])
        for (const statement of source.statements) {
            if (!ts.isFunctionDeclaration(statement) || !statement.name || statement.parameters.length !== 1
                || !ts.isIdentifier(statement.parameters[0]!.name) || statement.body?.statements.length !== 1) continue
            const returned = statement.body.statements[0]!
            if (!ts.isReturnStatement(returned) || !returned.expression) continue
            const value = unwrap(returned.expression)
            if (ts.isCallExpression(value) && ts.isIdentifier(value.expression) && value.expression.text === 'snapshotJson'
                && value.arguments.length === 1 && ts.isIdentifier(value.arguments[0]!)
                && value.arguments[0].text === statement.parameters[0]!.name.text) snapshotWrappers.add(statement.name.text)
        }
        const localDeclaration = (identifier: ts.Identifier): ts.VariableDeclaration | undefined => {
            for (let scope: ts.Node | undefined = identifier.parent; scope; scope = scope.parent) {
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
        const mutations = new Map<ts.VariableDeclaration, ts.Expression[]>()
        const collectMutations = (node: ts.Node) => {
            let receiver: ts.Identifier | undefined
            let values: readonly ts.Expression[] = []
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
        // Object literals that leave a function as its result, directly or through locals.
        const returnedDeclarations = new Set<ts.VariableDeclaration>()
        const returnedObjects = new Set<ts.Node>()
        const collectReturnedValue = (expression: ts.Expression) => {
            const value = unwrap(expression)
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
                collectReturnedValue(value.arguments[0]!)
            }
        }
        const collectReturns = (node: ts.Node) => {
            if (ts.isReturnStatement(node) && node.expression) collectReturnedValue(node.expression)
            if (ts.isArrowFunction(node) && !ts.isBlock(node.body)) collectReturnedValue(node.body)
            if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)
                && node.expression.text === 'renderJsonResponse' && node.arguments[0]) collectReturnedValue(node.arguments[0])
            ts.forEachChild(node, collectReturns)
        }
        collectReturns(source)
        const staticStrings = (expression: ts.Expression): string[] => {
            const value = unwrap(expression)
            if (ts.isStringLiteral(value)) return [value.text]
            if (ts.isConditionalExpression(value)) return [...staticStrings(value.whenTrue), ...staticStrings(value.whenFalse)]
            if (ts.isBinaryExpression(value) && FALLBACK_OPERATORS.includes(value.operatorToken.kind)) return [...staticStrings(value.left), ...staticStrings(value.right)]
            return []
        }
        // The codes an expression names: literals, registry members, and both arms of a conditional or fallback.
        const diagnosticCodes = (expression: ts.Expression): string[] => {
            const value = unwrap(expression)
            if (ts.isStringLiteral(value)) return uppercaseDiagnostic(value.text) ? [value.text] : []
            if (ts.isPropertyAccessExpression(value) && ts.isIdentifier(value.expression) && registryBindings.has(value.expression.text)) {
                const code = environmentCodes.get(value.name.text)
                return code ? [code] : []
            }
            if (ts.isConditionalExpression(value)) return [...diagnosticCodes(value.whenTrue), ...diagnosticCodes(value.whenFalse)]
            if (ts.isBinaryExpression(value) && FALLBACK_OPERATORS.includes(value.operatorToken.kind)) return [...diagnosticCodes(value.left), ...diagnosticCodes(value.right)]
            return []
        }
        const literalFixes = (expression: ts.Expression | undefined) => expression === undefined ? []
            : staticStrings(expression).filter(value => value.length > 0 && !/[\r\n]/.test(value))
        const objectFixes = (object: ts.ObjectLiteralExpression) => {
            const fix = object.properties.find(property => ts.isPropertyAssignment(property) && propertyName(property) === 'fix')
            return literalFixes(fix && ts.isPropertyAssignment(fix) ? fix.initializer : undefined)
        }
        // A constructor such as refusal(code, message, target, fix) states its fix at the call; one
        // with no `fix` parameter, or declared out of sight, states none the index can read.
        const constructorParameters = (callee: ts.Expression): ts.NodeArray<ts.ParameterDeclaration> | undefined => {
            if (!ts.isIdentifier(callee)) return undefined
            for (let scope: ts.Node | undefined = callee.parent; scope; scope = scope.parent) {
                if (!ts.isBlock(scope) && !ts.isSourceFile(scope)) continue
                for (const statement of scope.statements) {
                    if (ts.isFunctionDeclaration(statement) && statement.name?.text === callee.text) return statement.parameters
                    if (!ts.isVariableStatement(statement)) continue
                    const declaration = statement.declarationList.declarations.find(candidate => ts.isIdentifier(candidate.name) && candidate.name.text === callee.text)
                    const initializer = declaration?.initializer && unwrap(declaration.initializer)
                    if (initializer && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))) return initializer.parameters
                }
            }
            // A shared constructor imported from another module, such as refusalOutcome, states its fix the same way.
            for (const statement of source.statements) {
                if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue
                const named = statement.importClause?.namedBindings
                const element = named && ts.isNamedImports(named) ? named.elements.find(item => item.name.text === callee.text) : undefined
                const target = element && resolveImport(path, statement.moduleSpecifier.text)
                const declaration = target === undefined ? undefined : parse(target, sources.get(target)!).statements.find(
                    (candidate): candidate is ts.FunctionDeclaration => ts.isFunctionDeclaration(candidate)
                        && candidate.name?.text === (element!.propertyName ?? element!.name).text)
                if (declaration) return declaration.parameters
            }
            return undefined
        }
        const callFixes = (call: ts.CallExpression) => {
            const index = constructorParameters(call.expression)?.findIndex(parameter => ts.isIdentifier(parameter.name) && parameter.name.text === 'fix') ?? -1
            return index === -1 ? [] : literalFixes(call.arguments[index])
        }
        const constructorName = (expression: ts.Expression) => ts.isIdentifier(expression) ? expression.text
            : ts.isPropertyAccessExpression(expression) ? expression.name.text : ''
        for (const object of returnedObjects) {
            if (!ts.isObjectLiteralExpression(object)) continue
            const code = object.properties.find(property => ts.isPropertyAssignment(property) && propertyName(property) === 'code')
            if (!code || !ts.isPropertyAssignment(code)) continue
            const fixes = objectFixes(object)
            for (const name of diagnosticCodes(code.initializer)) {
                addCode(name, path)
                observeFix(name, object, fixes)
            }
        }
        // A registry member that is the code of an object literal or of a constructor call is
        // observed at that object or call, with the fix stated there.
        const namedAtEmission = (node: ts.Node) => {
            let value = node
            while (ts.isParenthesizedExpression(value.parent) || ts.isAsExpression(value.parent) || ts.isSatisfiesExpression(value.parent)
                || ts.isNonNullExpression(value.parent) || ts.isConditionalExpression(value.parent) && value.parent.condition !== value
                || ts.isBinaryExpression(value.parent) && FALLBACK_OPERATORS.includes(value.parent.operatorToken.kind)) value = value.parent
            const holder = value.parent
            return ts.isPropertyAssignment(holder) && holder.initializer === value && ts.isIdentifier(holder.name) && holder.name.text === 'code'
                || ts.isCallExpression(holder) && holder.arguments[0] === value && DIAGNOSTIC_CONSTRUCTOR.test(constructorName(holder.expression))
        }
        const visit = (node: ts.Node) => {
            if (ts.isCallExpression(node) && DIAGNOSTIC_CONSTRUCTOR.test(constructorName(node.expression)) && node.arguments[0]) {
                const fixes = callFixes(node)
                for (const code of diagnosticCodes(node.arguments[0])) {
                    addCode(code, path)
                    observeFix(code, node, fixes)
                }
            }
            // A code in an object that is not returned directly (a lookup row, an array element, a
            // pushed diagnostic) or as a `code` parameter default reaches output through whatever
            // uses it, so its stated fix counts towards the remedy without making the module an owner.
            if ((ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) && propertyName(node) === 'code') {
                const value = ts.isShorthandPropertyAssignment(node) ? node.name : node.initializer
                if (returnedObjects.has(node.parent)) {
                    if (ts.isIdentifier(value)) {
                        const name = value.text
                        let owner: ts.Node | undefined = node.parent
                        while (owner && !ts.isFunctionLike(owner)) owner = owner.parent
                        const parameter = owner && ts.isFunctionLike(owner) ? owner.parameters.find(item => ts.isIdentifier(item.name) && item.name.text === name) : undefined
                        if (parameter?.type) {
                            const typeText = parameter.type.getText(source)
                            for (const [union, values] of exportedUnions) {
                                if (new RegExp(`\\b${union}\\b`).test(typeText)) for (const code of values) addCode(code, path)
                            }
                        }
                    }
                } else if (ts.isPropertyAssignment(node)) {
                    const fixes = objectFixes(node.parent)
                    for (const code of diagnosticCodes(node.initializer)) observeFix(code, node.parent, fixes)
                }
            }
            if (ts.isParameter(node) && ts.isIdentifier(node.name) && node.name.text === 'code' && node.initializer) {
                for (const code of diagnosticCodes(node.initializer)) observeFix(code, node, [])
            }
            // A registry code held in a variable before it reaches a diagnostic, as a process runner's
            // failure code is, states no fix the index can read.
            if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && registryBindings.has(node.expression.text)
                && environmentCodes.has(node.name.text) && !testsCode(node) && !namedAtEmission(node)) {
                observeFix(environmentCodes.get(node.name.text)!, node, [])
            }
            ts.forEachChild(node, visit)
        }
        visit(source)
    }
    const remedies = new Map<string, DiagnosticRemedy>([...owners.keys()].map(code => {
        const stated = [...fixSites.get(code)?.values() ?? []]
        const fixes = new Set(stated.flat())
        if (fixes.size === 0) return [code, { kind: 'none' }]
        return [code, fixes.size === 1 && stated.every(site => site.length === 1) ? { kind: 'fixed', fix: [...fixes][0]! } : { kind: 'varies' }]
    }))
    return { codes: [...owners.keys()].sort(), owners, remedies }
}

export function diagnosticInventory(root: string): DiagnosticInventory {
    return diagnosticInventoryFromSources(productionSources(root))
}
