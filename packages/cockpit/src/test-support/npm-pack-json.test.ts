import { describe, expect, it } from 'vitest'
import { parseNpmPackJson } from './npm-pack-json.js'

const artifact = {
    filename: 'synthetic-package-1.0.0.tgz',
    files: [{ path: 'package.json' }, { path: 'dist/index.js' }],
}

describe('npm pack JSON compatibility', () => {
    it('reads the one-item array emitted by npm 10 and 11', () => {
        expect(parseNpmPackJson(JSON.stringify([artifact]))).toEqual(artifact)
    })

    it('reads the package-keyed object emitted by npm 12', () => {
        expect(parseNpmPackJson(JSON.stringify({ '@synthetic/package': artifact }))).toEqual(artifact)
    })

    it.each([
        ['malformed JSON', '{'],
        ['an empty array', '[]'],
        ['an empty object', '{}'],
        ['multiple array entries', JSON.stringify([artifact, artifact])],
        ['multiple object entries', JSON.stringify({ first: artifact, second: artifact })],
        ['a missing filename', JSON.stringify([{ files: artifact.files }])],
        ['a missing files inventory', JSON.stringify([{ filename: artifact.filename }])],
        ['a malformed file entry', JSON.stringify([{ ...artifact, files: [{}] }])],
    ])('fails closed with context for %s', (_case, output) => {
        expect(() => parseNpmPackJson(output)).toThrow(/^npm pack --json returned invalid output:/)
    })
})
