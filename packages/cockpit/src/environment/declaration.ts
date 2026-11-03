// Which runtime a configuration declares, read from the declaration alone. A cockpit may declare
// none (it publishes harness surfaces only) or its own Compose files. Observing what Compose
// resolves from those files belongs to compose-topology.ts, not here.
import type { CockpitConfig } from '../schema.js'
import { ENVIRONMENT_CODES, type EnvironmentDiagnostic, RefusalError } from './contract.js'

export type DeclaredRuntime = 'compose' | 'none'

export function declaredRuntime(environment: Pick<CockpitConfig['environment'], 'compose_files'>): DeclaredRuntime {
    return environment.compose_files.length > 0 ? 'compose' : 'none'
}

// A machine floor alone still has something to measure: preflight checks this laptop against it,
// so only a cockpit that declares no runtime and no floor has nothing for runtime commands to do.
export function declaresNothingToRun(environment: Pick<CockpitConfig['environment'], 'compose_files' | 'machine'>): boolean {
    return declaredRuntime(environment) === 'none' && environment.machine === undefined
}

/** The one refusal every runtime command gives a cockpit that declares no environment. */
export function runtimeNotDeclared(target: string): EnvironmentDiagnostic {
    return Object.freeze({
        severity: 'error' as const,
        // A literal, so the diagnostic inventory captures the fix beside the code.
        code: 'ENVIRONMENT_NOT_DECLARED' satisfies typeof ENVIRONMENT_CODES.ENVIRONMENT_NOT_DECLARED,
        message: 'this cockpit declares no runtime environment, so there is nothing to start, stop, observe or measure; sync and check publish and verify the harness surfaces only',
        target,
        fix: 'declare environment.compose_files = ["compose.yml"] to run your Compose file (for a small app with none, npx --no cockpit init <cockpit root> --scaffold-compose <app dir> --port <port> writes a starting one), then run npx --no cockpit sync --config <your cockpit.toml>',
    })
}

/** A service named on the command line that the stack does not declare: a wrong name, not a runtime failure. */
export function serviceNotDeclared(service: string, declared: readonly string[]): EnvironmentDiagnostic {
    return Object.freeze({
        severity: 'error' as const,
        code: 'SERVICE_NOT_DECLARED' satisfies typeof ENVIRONMENT_CODES.SERVICE_NOT_DECLARED,
        message: `this stack declares no service ${service}; it declares ${declared.length === 0 ? 'no services' : declared.join(', ')}`,
        target: service,
        fix: 'rerun with --service set to one of the declared services',
    })
}

/** Carries a declaration refusal through owners whose only failure channel is a thrown error. */
export class DeclarationRefusalError extends RefusalError {
    readonly diagnostic: EnvironmentDiagnostic

    constructor(diagnostic: EnvironmentDiagnostic) {
        super(diagnostic.message)
        this.name = 'DeclarationRefusalError'
        this.diagnostic = diagnostic
    }
}
