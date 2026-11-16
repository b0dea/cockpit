import type { HolderId, StackId } from '../src/environment/contract.js'
import { transactState, type StateNamespace } from '../src/environment/state.js'

// Stands in for a completed `up`: the stack's lifecycle record, marked steady, with nothing left to start.
export async function recordSteadyStack(input: Readonly<{ namespace: StateNamespace; stackId: StackId; holderId: HolderId }>): Promise<void> {
    const address = input.namespace.paths.lifecycle(input.stackId)
    const result = await transactState(input.namespace, address, { ownerId: input.holderId }, () => ({
        format: 'cockpit-state/v1', kind: 'lifecycle', cockpitId: address.cockpitId, subjectId: input.stackId,
        revision: 0, updatedAt: new Date().toISOString(),
        value: { holderId: input.holderId, workBasisSha256: '1'.repeat(64), operationGeneration: '2'.repeat(64), completedServices: [], steady: true },
    }))
    if (result.kind !== 'complete') throw new Error(`fixture lifecycle record was refused: ${JSON.stringify(result)}`)
}
