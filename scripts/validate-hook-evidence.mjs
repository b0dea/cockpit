import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runHookEvidenceValidatorCli } from '../packages/cockpit/libexec/validate-harness-evidence.mjs'

export const mechanism = {
    id: 'hook-evidence-wrapper', module: 'scripts/validate-hook-evidence.mjs',
    exports: ['validateHookEvidence', 'hookEvidenceMatches', 'captureHookWiring'],
}

export { validateHookEvidence, hookEvidenceMatches, captureHookWiring } from '../packages/cockpit/libexec/validate-harness-evidence.mjs'

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
    process.exitCode = runHookEvidenceValidatorCli(process.argv.slice(2))
}
