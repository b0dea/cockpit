import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { onTestFinished } from 'vitest'

// check reads a cockpit's own Compose files through `docker compose config` and refuses when no
// docker is on PATH, as on a hosted macOS runner. A test that is not about that probe puts this
// stand-in first on PATH for its own duration, so it runs the same with Docker or without. It answers
// only the topology probe, with the services the test supplies: what real Compose reports for the
// test's Compose file under `config --format json --no-interpolate`, where a relative bind source
// comes back absolute and a variable port or source comes back as written. Fields the probe does not
// read may be left out.
export async function stubComposeTopology(services: Readonly<Record<string, unknown>>): Promise<void> {
    const bin = await realpath(await mkdtemp(join(tmpdir(), 'cockpit-compose-topology-')))
    await writeFile(join(bin, 'docker'), [
        '#!/bin/sh',
        'case " $* " in',
        `    " compose "*" config "*) /bin/cat <<'TOPOLOGY'`,
        JSON.stringify({ services }),
        'TOPOLOGY',
        '        exit 0 ;;',
        'esac',
        'printf "synthetic docker answers only compose config, not: %s\\n" "$*" >&2',
        'exit 64',
        '',
    ].join('\n'), { mode: 0o700 })
    const prior = process.env.PATH
    process.env.PATH = prior === undefined ? bin : `${bin}${delimiter}${prior}`
    onTestFinished(async () => {
        if (prior === undefined) delete process.env.PATH
        else process.env.PATH = prior
        await rm(bin, { recursive: true, force: true })
    })
}
