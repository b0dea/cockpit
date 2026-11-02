// Shell blocks in the example READMEs carry their classification in the fence info string:
// `sh executable` blocks are run by the example acceptance tests, `sh human-only: <reason>` are not.
export function inventory(readme: string) {
    const blocks = [...readme.matchAll(/```sh ([^\n]+)\n([\s\S]*?)```/g)]
    const machineLocal = /(?:\/Users\/|\/home\/|[A-Za-z]:\\|\.\.\/|\$HOME\b)/
    if (blocks.some(([, , body]) => machineLocal.test(body!))) throw new Error('example commands depend on a machine-local path')
    if (blocks.some(([, marker]) => marker !== 'executable' && !marker?.startsWith('human-only:'))) {
        throw new Error('shell command block is not classified')
    }
    const classified = (classification: 'executable' | 'human-only') => blocks.flatMap(([, marker, body]) => {
        const kind = marker === 'executable' ? 'executable' : marker?.startsWith('human-only:') ? 'human-only' : 'unknown'
        if (kind !== classification) return []
        return body!.trim().split('\n').map(line => line.trim().split(/\s+/))
    })
    return { executable: classified('executable'), humanOnly: classified('human-only') }
}
