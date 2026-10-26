import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { runHarnessEvidenceValidatorCli } from '../packages/cockpit/libexec/validate-harness-evidence.mjs'

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
    process.exitCode = runHarnessEvidenceValidatorCli(process.argv.slice(2))
}
