export const mechanism: Readonly<{
    id: 'cockpit-package-build'
    module: 'scripts/build-cockpit.mjs'
    exports: readonly ['cleanOwnedPackageDist', 'packagedDocumentationPages', 'writePackagedDocumentation']
}>

export function cleanOwnedPackageDist(packageRoot: string): Promise<void>
export function packagedDocumentationPages(repositoryRoot: string): string[]
export function writePackagedDocumentation(repositoryRoot: string, packageRoot: string): Promise<void>
