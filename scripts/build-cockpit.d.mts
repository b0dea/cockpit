export const mechanism: Readonly<{
    id: 'cockpit-package-build'
    module: 'scripts/build-cockpit.mjs'
    exports: readonly ['cleanOwnedPackageDist']
}>

export function cleanOwnedPackageDist(packageRoot: string): Promise<void>
