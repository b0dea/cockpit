import {
    forgetGeneratedEnvironment as forget,
    uninstallGeneratedEnvironment as uninstall,
    type GeneratedRemovalAdapters,
    type GeneratedRemovalContext,
    type GeneratedRemovalInput,
} from './uninstall.js'
import type { PublicationOutcome } from './transaction.js'

export type { GeneratedRemovalAdapters, GeneratedRemovalContext, GeneratedRemovalInput } from './uninstall.js'

export const mechanism = {
    id: 'generated-removal-command',
    module: 'packages/cockpit/src/generated-environment/uninstall-command.ts',
    exports: ['forgetGeneratedEnvironment', 'uninstallGeneratedEnvironment'],
} as const

export function forgetGeneratedEnvironment(
    input: GeneratedRemovalInput,
    context: GeneratedRemovalContext,
    adapters?: Partial<GeneratedRemovalAdapters>,
): Promise<PublicationOutcome> {
    return forget(input, context, adapters)
}

export function uninstallGeneratedEnvironment(
    input: GeneratedRemovalInput,
    context: GeneratedRemovalContext,
    adapters?: Partial<GeneratedRemovalAdapters>,
): Promise<PublicationOutcome> {
    return uninstall(input, context, adapters)
}
