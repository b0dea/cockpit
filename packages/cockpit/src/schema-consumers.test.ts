import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as ts from '@typescript/typescript6'
import { describe, expect, it } from 'vitest'

// "Configuration that parses and does nothing is a defect": every leaf of the published schema
// must be read by code that acts on it. The reads are found statically, through the type checker,
// because every consumer authenticates its input by re-parsing a snapshot (registry-derivation.ts,
// the loader's projections), so a recording Proxy on the loaded configuration is lost at the first
// snapshot. A property symbol on a parsed value still resolves to its declaration in schema.ts,
// which is what ties a read to a schema leaf. A read is not an effect.

const SOURCE_ROOT = fileURLToPath(new URL('.', import.meta.url))
const SCHEMA_JSON = fileURLToPath(new URL('../cockpit.schema.json', import.meta.url))

// Modules that define, publish or author configuration rather than act on it. A field read only
// here reaches no behaviour: echoing a default into a draft is how cockpit.guide looked alive.
const AUTHORING_MODULES = ['schema.ts', 'schema-json.ts', 'init/']
// This module reassembles the effective configuration from sibling derivations; a spread there
// moves fields into the configuration every consumer reads, so it is not itself a read.
const REASSEMBLY_MODULE = 'registry-derivation.ts'
// Leaves no code reads, each a decision with its reason. A stale entry fails the test.
const UNREAD_BY_DESIGN: Readonly<Record<string, string>> = {
    // A provenance tells the person reviewing cockpit.toml where a value came from. The schema is
    // its check: it refuses an inferred provenance until a person sets confirmed = true, and an
    // adopted file's provenance must be declared.
    'sibling.[].derives.mcp_sources.[].provenance.kind': 'where the declaration came from, for its reviewer; schema.ts refuses an unconfirmed inferred one',
    'sibling.[].derives.mcp_sources.[].provenance.confirmed': 'a person\'s confirmation of an inferred source; schema.ts refuses an inferred one without it',
    'surfaces.adopted.[].provenance.kind': 'where the adopted file came from, for its reviewer; schema.ts accepts only declared',
    'surfaces.adopted.[].provenance.confirmed': 'a person\'s confirmation of an inferred value; schema.ts refuses an inferred one without it',
    'surfaces.harnesses.[].capabilities.[].reason': 'why a capability is unavailable, recorded for the reader of the support matrix',
    'surfaces.harnesses.[].capabilities.[].control': 'the broken control the measurement ran beside, recorded as evidence',
    'guards.read_paths.[].reason': 'why a person lets agents read the location, recorded for the reviewer of cockpit.toml',
    'guards.write_paths.[].reason': 'why a person lets agents write the location, recorded for the reviewer of cockpit.toml',
}

// Leaves whose one legal value is a person's explicit statement, each with its reason. A stale entry fails the test.
const SINGLE_VALUE_BY_DESIGN: Readonly<Record<string, string>> = {}

type Leaves = ReadonlyMap<string, ReadonlySet<ts.Node>>
type JsonSchema = Record<string, unknown>
// Each place a leaf path appears in the published schema: its declaration and, in a union or a
// conditional branch, each narrowing of it. `required` is false where that occurrence may be omitted.
type LeafOccurrences = ReadonlyMap<string, readonly Readonly<{ node: JsonSchema; required: boolean }>[]>

function schemaOccurrences(): LeafOccurrences {
    const occurrences = new Map<string, { node: JsonSchema; required: boolean }[]>()
    const objectLike = (node: JsonSchema) => Boolean(node.properties || node.anyOf || node.oneOf || node.allOf
        || (node.items && !Array.isArray(node.items) && (node.items as JsonSchema).properties))
    const walk = (node: JsonSchema, path: readonly string[], required: boolean) => {
        let descended = false
        const requiredKeys = (node.required ?? []) as readonly string[]
        for (const [key, value] of Object.entries((node.properties ?? {}) as Record<string, JsonSchema>)) {
            descended = true
            walk(value, [...path, key], requiredKeys.includes(key))
        }
        const items = node.items as JsonSchema | undefined
        if (items && !Array.isArray(items) && objectLike(items)) {
            descended = true
            walk(items, [...path, '[]'], true)
        }
        for (const key of ['anyOf', 'oneOf', 'allOf']) {
            for (const branch of (node[key] ?? []) as JsonSchema[]) {
                if (objectLike(branch)) {
                    descended = true
                    walk(branch, path, required)
                }
            }
        }
        if (!descended && path.length > 0) {
            const leaf = path.join('.')
            occurrences.set(leaf, [...occurrences.get(leaf) ?? [], { node, required }])
        }
    }
    walk(JSON.parse(readFileSync(SCHEMA_JSON, 'utf8')) as JsonSchema, [], true)
    return occurrences
}

function schemaLeaves(): string[] {
    return [...schemaOccurrences().keys()].sort()
}

// The values a leaf schema admits when they are finitely many, or undefined when they are open.
function finiteValues(node: JsonSchema): readonly unknown[] | undefined {
    if (Object.hasOwn(node, 'const')) return [node.const]
    if (Array.isArray(node.enum)) return node.enum
    if ((node.type === 'integer' || node.type === 'number') && node.minimum !== undefined && node.minimum === node.maximum) return [node.minimum]
    const branches = [...(node.anyOf ?? []) as JsonSchema[], ...(node.oneOf ?? []) as JsonSchema[]]
    if (branches.length === 0) return undefined
    const values = branches.map(finiteValues)
    return values.every((branch) => branch !== undefined) ? values.flat() : undefined
}

// A leaf that must be written and can only be written one way, or whose omission means that same
// value, is ceremony: a person types it and nothing changes.
function singleValueLeaves(occurrences: LeafOccurrences): string[] {
    return [...occurrences].filter(([, found]) => {
        if (found.some(({ node, required }) => !required && !Object.hasOwn(node, 'default'))) return false
        const values = found.map(({ node }) => finiteValues(node))
        if (values.some((value) => value === undefined)) return false
        return new Set(values.flat().map((value) => JSON.stringify(value))).size === 1
    }).map(([leaf]) => leaf).sort()
}

function productionSources(directory: string): string[] {
    return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
        const path = join(directory, entry.name)
        if (entry.isDirectory()) return entry.name === 'test-support' || entry.name === 'fixtures' ? [] : productionSources(path)
        return path.endsWith('.ts') && !path.endsWith('.test.ts') && !path.endsWith('.d.ts') ? [path] : []
    })
}

function readLeaves(): Readonly<{ leaves: Leaves; read: ReadonlySet<ts.Node> }> {
    const program = ts.createProgram({
        rootNames: productionSources(SOURCE_ROOT),
        options: {
            target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
            strict: true, noEmit: true, skipLibCheck: true, types: ['node'],
        },
    })
    const checker = program.getTypeChecker()
    const schemaFile = program.getSourceFile(join(SOURCE_ROOT, 'schema.ts'))!
    const inSchema = (node: ts.Node) => node.getSourceFile() === schemaFile
    const constituents = (type: ts.Type): readonly ts.Type[] => {
        const present = checker.getNonNullableType(type)
        return present.isUnion() ? present.types : [present]
    }
    const configAlias = schemaFile.statements.find((statement): statement is ts.TypeAliasDeclaration =>
        ts.isTypeAliasDeclaration(statement) && statement.name.text === 'CockpitConfig')!
    const leaves = new Map<string, ReadonlySet<ts.Node>>()
    for (const leaf of schemaLeaves()) {
        let types: readonly ts.Type[] = [checker.getTypeAtLocation(configAlias.name)]
        let symbols: ts.Symbol[] = []
        for (const segment of leaf.split('.')) {
            if (segment === '[]') {
                types = types.flatMap(constituents).flatMap(type => checker.isArrayType(type) || checker.isTupleType(type)
                    ? checker.getTypeArguments(type as ts.TypeReference) : [])
                continue
            }
            symbols = types.flatMap(constituents).flatMap(type => type.getProperty(segment) ?? [])
            types = symbols.map(symbol => checker.getTypeOfSymbol(symbol))
        }
        leaves.set(leaf, new Set(symbols.flatMap(symbol => symbol.declarations ?? []).filter(inSchema)))
    }

    const read = new Set<ts.Node>()
    const markSymbol = (symbol: ts.Symbol | undefined) => {
        for (const declaration of symbol?.declarations ?? []) if (inSchema(declaration)) read.add(declaration)
    }
    const markProperties = (type: ts.Type, only?: ReadonlySet<string>) => {
        for (const part of constituents(type)) {
            for (const property of part.getProperties()) if (!only || only.has(property.name)) markSymbol(property)
        }
    }
    // A schema value handed to a structurally typed parameter, variable or property is read for
    // each property name that type asks for (external-dependencies.ts reads fixture.path that way).
    const flow = (value: ts.Type, contextual: ts.Type) => {
        const names = new Set(constituents(contextual).flatMap(part => part.getProperties()
            .filter(property => !(property.declarations ?? []).some(inSchema)).map(property => property.name)))
        if (names.size > 0) markProperties(value, names)
    }
    const flowsOut = (node: ts.Node) => {
        const parent = node.parent
        return ts.isCallExpression(parent) && parent.arguments.includes(node as ts.Expression) || ts.isNewExpression(parent)
            || ts.isVariableDeclaration(parent) && parent.initializer === node && parent.type !== undefined
            || ts.isPropertyAssignment(parent) && parent.initializer === node || ts.isReturnStatement(parent)
            || ts.isArrayLiteralExpression(parent) || ts.isArrowFunction(parent) && parent.body === node
    }
    for (const file of program.getSourceFiles()) {
        const module = relative(SOURCE_ROOT, file.fileName)
        if (module.startsWith('..') || AUTHORING_MODULES.some(prefix => module.startsWith(prefix))) continue
        const visit = (node: ts.Node): void => {
            if (ts.isPropertyAccessExpression(node)) markSymbol(checker.getSymbolAtLocation(node.name))
            else if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) {
                markSymbol(checker.getSymbolAtLocation(node.argumentExpression))
            } else if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
                markSymbol(checker.getTypeAtLocation(node.parent).getProperty((node.propertyName ?? node.name).getText()))
            } else if ((ts.isSpreadAssignment(node) || ts.isSpreadElement(node)) && module !== REASSEMBLY_MODULE) {
                markProperties(checker.getTypeAtLocation(node.expression))
            } else if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
                && node.expression.expression.getText() === 'Object' && ['values', 'entries', 'keys'].includes(node.expression.name.text)
                && node.arguments[0]) {
                markProperties(checker.getTypeAtLocation(node.arguments[0]))
            } else if (ts.isShorthandPropertyAssignment(node)) {
                const contextual = checker.getContextualType(node.parent)
                for (const part of contextual ? constituents(contextual) : []) {
                    const property = part.getProperty(node.name.text)
                    if (property) flow(checker.getTypeAtLocation(node.name), checker.getTypeOfSymbol(property))
                }
            }
            if (ts.isExpression(node) && !ts.isLiteralExpression(node) && flowsOut(node)) {
                const contextual = checker.getContextualType(node)
                if (contextual) flow(checker.getTypeAtLocation(node), contextual)
            }
            ts.forEachChild(node, visit)
        }
        visit(file)
    }
    return { leaves, read }
}

function unreadLeaves(leaves: Leaves, read: ReadonlySet<ts.Node>): string[] {
    const isRead = (leaf: string) => [...leaves.get(leaf) ?? []].some(declaration => read.has(declaration))
    return [...leaves.keys()].filter(leaf => !isRead(leaf))
}

describe('schema consumers', () => {
    it('reads every published configuration leaf in code that acts on it, or names why not', () => {
        const { leaves, read } = readLeaves()
        // Every published leaf must resolve to a declaration, or a missing read would go unseen.
        expect([...leaves].filter(([, declarations]) => declarations.size === 0).map(([leaf]) => leaf)).toEqual([])
        const unread = unreadLeaves(leaves, read)
        expect(unread.filter(leaf => !Object.hasOwn(UNREAD_BY_DESIGN, leaf)), 'a leaf nobody reads parses and does nothing').toEqual([])
        expect(Object.keys(UNREAD_BY_DESIGN).filter(leaf => !unread.includes(leaf)), 'an allowlisted leaf is now read or gone').toEqual([])
    }, 120_000)

    it('admits more than one value at every published leaf, or names why not', () => {
        const single = singleValueLeaves(schemaOccurrences())
        expect(single.filter(leaf => !Object.hasOwn(SINGLE_VALUE_BY_DESIGN, leaf)), 'a leaf with one legal value is typed for no effect').toEqual([])
        expect(Object.keys(SINGLE_VALUE_BY_DESIGN).filter(leaf => !single.includes(leaf)), 'an allowlisted leaf now admits other values or is gone').toEqual([])
    })
})
