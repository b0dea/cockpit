import { spawnSync } from 'node:child_process'
import { lstat, readFile, realpath, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export async function cleanOwnedPackageDist(packageRoot) {
    const root = await realpath(packageRoot)
    const manifestPath = join(root, 'package.json')
    const manifestStat = await lstat(manifestPath)
    if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) {
        throw new Error('[PACKAGE_ROOT_INVALID] package.json is not one owned regular file')
    }
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    if (manifest.name !== '@b0dea/cockpit') {
        throw new Error('[PACKAGE_ROOT_INVALID] build root is not the cockpit package')
    }

    const dist = join(root, 'dist')
    let distStat
    try {
        distStat = await lstat(dist)
    } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return
        throw error
    }
    if (!distStat.isDirectory() || distStat.isSymbolicLink()) {
        throw new Error('[PACKAGE_DIST_INVALID] dist is not one owned directory')
    }
    await rm(dist, { recursive: true })
}

async function build() {
    const packageRoot = fileURLToPath(new URL('..', import.meta.url))
    await cleanOwnedPackageDist(packageRoot)
    const compiler = resolve(packageRoot, '../../node_modules/typescript/bin/tsc')
    const result = spawnSync(process.execPath, [
        compiler,
        '--project', 'tsconfig.build.json',
        '--declaration',
        '--singleThreaded',
    ], { cwd: packageRoot, stdio: 'inherit' })
    if (result.error) throw new Error(`[PACKAGE_BUILD_FAILED] TypeScript did not start: ${result.error.message}`, { cause: result.error })
    if (result.signal) throw new Error(`[PACKAGE_BUILD_FAILED] TypeScript ended on signal ${result.signal}`)
    if (result.status !== 0) process.exitCode = result.status ?? 1
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
    build().catch(error => {
        console.error(error instanceof Error ? error.message : '[PACKAGE_BUILD_FAILED] unknown build failure')
        process.exitCode = 1
    })
}
