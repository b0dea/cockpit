import { registerHooks } from 'node:module'

// dependency-cruiser parses TypeScript through the `typescript` package's compiler API, which
// TypeScript 7 no longer ships. Resolve dependency-cruiser's own `typescript` imports to the
// TypeScript 6 API this repository already pins, and leave every other importer alone.
const CRUISER = '/node_modules/dependency-cruiser/'
const API = '@typescript/typescript6'

registerHooks({
    resolve(specifier, context, nextResolve) {
        if (context.parentURL?.includes(CRUISER) && (specifier === 'typescript' || specifier.startsWith('typescript/'))) {
            return nextResolve(API + specifier.slice('typescript'.length), context)
        }
        return nextResolve(specifier, context)
    },
})
