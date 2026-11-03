import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { lstat, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, join, posix, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const mechanism = {
    id: 'cockpit-package-build',
    module: 'scripts/build-cockpit.ts',
    exports: ['cleanOwnedPackageDist', 'packagedDocumentationPages', 'writePackagedDocumentation'],
}

// The surfaces a consumer's cockpit renders send agents to the user guide. They run after cockpit
// is installed, possibly offline and possibly before the repository is reachable, so the guide
// travels in the package. Contributor pages describe this repository, not an installation.
const GUIDE = 'docs'
const CONTRIBUTOR_PAGES = 'docs/contributing'
const PUBLIC_SOURCE = 'https://github.com/b0dea/cockpit/blob/main/'

async function canonicalPackageRoot(packageRoot: string): Promise<string> {
    const requestedRoot = resolve(packageRoot)
    const rootStat = await lstat(requestedRoot)
    const root = await realpath(requestedRoot)
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || root !== requestedRoot) {
        throw new Error('[PACKAGE_ROOT_INVALID] build root is not one canonical directory')
    }
    const manifestPath = join(root, 'package.json')
    const manifestStat = await lstat(manifestPath)
    if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) {
        throw new Error('[PACKAGE_ROOT_INVALID] package.json is not one owned regular file')
    }
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    if (manifest.name !== '@b00dea/cockpit') {
        throw new Error('[PACKAGE_ROOT_INVALID] build root is not the cockpit package')
    }
    return root
}

async function removeOwnedDirectory(root: string, name: string, code: string): Promise<void> {
    const directory = join(root, name)
    let stat
    try {
        stat = await lstat(directory)
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
        throw error
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error(`[${code}] ${name} is not one owned directory`)
    }
    await rm(directory, { recursive: true })
}

export async function cleanOwnedPackageDist(packageRoot: string): Promise<void> {
    await removeOwnedDirectory(await canonicalPackageRoot(packageRoot), 'dist', 'PACKAGE_DIST_INVALID')
}

/** Repository paths of the guide pages the package ships, in code-unit order. */
export function packagedDocumentationPages(repositoryRoot: string): string[] {
    const pages: string[] = []
    const visit = (directory: string) => {
        for (const entry of readdirSync(join(repositoryRoot, directory), { withFileTypes: true })) {
            const path = posix.join(directory, entry.name)
            if (path === CONTRIBUTOR_PAGES) continue
            if (entry.isDirectory()) visit(path)
            else if (entry.isFile()) pages.push(path)
            else throw new Error(`[PACKAGE_DOCS_INVALID] ${path} is not a regular file or directory`)
        }
    }
    visit(GUIDE)
    return pages.sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
}

/**
 * A relative link that resolves outside the shipped guide would dangle in the installation, so it
 * is redirected to the public source. Fenced blocks and code spans are left alone: the
 * configuration reference quotes schema patterns shaped like link destinations.
 */
function packagedPageText(repositoryRoot: string, page: string, body: string, shipped: ReadonlySet<string>): string {
    const redirect = (link: string, target: string) => {
        if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('#')) return link
        const [path, fragment] = target.split('#', 2) as [string, string | undefined]
        const resolved = posix.normalize(posix.join(posix.dirname(page), path))
        if (shipped.has(resolved)) return link
        if (resolved === '..' || resolved.startsWith('../') || !existsSync(join(repositoryRoot, resolved))) {
            throw new Error(`[PACKAGE_DOCS_LINK_INVALID] ${page} links to ${target}, which is not in the repository`)
        }
        return `](${PUBLIC_SOURCE}${resolved}${fragment === undefined ? '' : `#${fragment}`})`
    }
    let fence: string | null = null
    return body.split('\n').map(line => {
        const marker = /^\s*(`{3,}|~{3,})(.*)$/.exec(line)
        if (fence !== null) {
            if (marker && marker[1]![0] === fence[0] && marker[1]!.length >= fence.length && marker[2]!.trim() === '') fence = null
            return line
        }
        if (marker) {
            fence = marker[1]!
            return line
        }
        let codeSpan: string | null = null
        return line.split(/(`+)/).map(part => {
            if (/^`+$/.test(part)) {
                if (codeSpan === null) codeSpan = part
                else if (codeSpan === part) codeSpan = null
                return part
            }
            return codeSpan === null ? part.replace(/\]\(([^)\s]+)\)/g, redirect) : part
        }).join('')
    }).join('\n')
}

export async function writePackagedDocumentation(repositoryRoot: string, packageRoot: string): Promise<void> {
    const root = await canonicalPackageRoot(packageRoot)
    await removeOwnedDirectory(root, GUIDE, 'PACKAGE_DOCS_INVALID')
    const pages = packagedDocumentationPages(repositoryRoot)
    if (pages.length === 0) throw new Error(`[PACKAGE_DOCS_INVALID] ${GUIDE} holds no guide page to ship`)
    const shipped = new Set(pages)
    for (const page of pages) {
        const destination = join(root, page)
        await mkdir(dirname(destination), { recursive: true })
        const bytes = await readFile(join(repositoryRoot, page))
        await writeFile(destination, page.endsWith('.md') ? packagedPageText(repositoryRoot, page, bytes.toString('utf8'), shipped) : bytes)
    }
}

async function build() {
    const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))
    const packageRoot = join(repositoryRoot, 'packages/cockpit')
    await cleanOwnedPackageDist(packageRoot)
    await writePackagedDocumentation(repositoryRoot, packageRoot)
    const compiler = join(repositoryRoot, 'node_modules/typescript/bin/tsc')
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
