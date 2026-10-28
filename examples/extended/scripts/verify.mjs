import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('../api/server.mjs', import.meta.url), 'utf8')
if (!source.includes("'/health'")) throw new Error('api/server.mjs must expose the health route')
