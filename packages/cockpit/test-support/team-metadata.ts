import { applyTeamMetadata, prepareTeamMetadata, type TeamMetadataResult } from '../src/team-metadata.js'

// The production sequence (prepare, then apply the authority it issued), for tests that pin the
// resulting writes rather than the two steps.
export async function initializeTeamMetadata(configPath: string): Promise<TeamMetadataResult> {
    const prepared = await prepareTeamMetadata(configPath)
    return prepared.kind === 'refusal' ? prepared : applyTeamMetadata(prepared.authority)
}
