#!/usr/bin/env node
// Produces one release record without network access, or assembles two independently hashed
// records into the pair consumed by `cockpit upgrade`.
import { lstat, open, unlink } from 'node:fs/promises'
import { basename, resolve } from 'node:path'

import { assembleReleaseEvidence, createReleaseRecord } from '../dist/upgrade/release-evidence.js'

function argumentsFor(argv) {
    const [operation, ...rest] = argv
    if (operation !== 'record' && operation !== 'assemble') return undefined
    const values = new Map()
    for (let index = 0; index < rest.length; index += 2) {
        const name = rest[index]
        const value = rest[index + 1]
        if (!name?.startsWith('--') || value === undefined || values.has(name)) return undefined
        values.set(name, value)
    }
    const expected = operation === 'record'
        ? ['--integrity', '--output', '--package', '--version']
        : ['--candidate', '--candidate-sha256', '--current', '--current-sha256', '--output']
    return values.size === expected.length && expected.every(name => values.has(name))
        ? { operation, values }
        : undefined
}

async function writeExclusivePair(path, bytes, sha256) {
    const paths = [path, `${path}.sha256`]
    const files = []
    let failure
    try {
        for (const ownedPath of paths) {
            const file = await open(ownedPath, 'wx', 0o600)
            const owned = { path: ownedPath, file, identity: undefined }
            files.push(owned)
            owned.identity = await file.stat()
        }
        await files[0].file.writeFile(bytes, 'utf8')
        await files[1].file.writeFile(`${sha256}  ${basename(path)}\n`, 'utf8')
    } catch (error) {
        failure = error
    }
    const closed = await Promise.allSettled(files.map(owned => owned.file.close()))
    const closeFailures = closed.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
    failure ??= closeFailures[0]
    if (failure !== undefined) {
        const cleanupFailures = closeFailures.slice(failure === closeFailures[0] ? 1 : 0)
        for (const owned of files) {
            if (owned.identity === undefined) {
                cleanupFailures.push(new Error(`${owned.path}: created file identity is unavailable`))
                continue
            }
            try {
                const current = await lstat(owned.path)
                if (current.dev !== owned.identity.dev || current.ino !== owned.identity.ino) {
                    cleanupFailures.push(new Error(`${owned.path}: path no longer identifies the created file`))
                    continue
                }
                await unlink(owned.path)
            } catch (error) {
                if (!(error && typeof error === 'object' && error.code === 'ENOENT')) cleanupFailures.push(error)
            }
        }
        if (cleanupFailures.length > 0) {
            const details = cleanupFailures.map(error => error instanceof Error ? error.message : String(error)).join('; ')
            throw new Error(`${failure instanceof Error ? failure.message : String(failure)}; cleanup failed: ${details}`, { cause: failure })
        }
        throw failure
    }
}

const parsed = argumentsFor(process.argv.slice(2))
if (!parsed) {
    console.error('usage: release-evidence.mjs record --package NAME --version VERSION --integrity INTEGRITY --output PATH')
    console.error('   or: release-evidence.mjs assemble --current PATH --current-sha256 SHA256 --candidate PATH --candidate-sha256 SHA256 --output PATH')
    process.exitCode = 2
} else {
    const output = resolve(parsed.values.get('--output'))
    const result = parsed.operation === 'record'
        ? await createReleaseRecord({
            package: parsed.values.get('--package'),
            version: parsed.values.get('--version'),
            integrity: parsed.values.get('--integrity'),
        })
        : await assembleReleaseEvidence({
            currentPath: parsed.values.get('--current'),
            currentSha256: parsed.values.get('--current-sha256'),
            candidatePath: parsed.values.get('--candidate'),
            candidateSha256: parsed.values.get('--candidate-sha256'),
        })
    if (result.kind !== 'complete') {
        console.error(`release evidence refused: ${result.reason}`)
        process.exitCode = 2
    } else {
        try {
            await writeExclusivePair(output, result.bytes, result.sha256)
        } catch (error) {
            console.error(`release evidence could not be written: ${error instanceof Error ? error.message : String(error)}`)
            process.exitCode = 2
        }
    }
}
