import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { loadCockpitConfig } from '../src/config/load.js'
import { checkoutId, cockpitId, holderId, stackId } from '../src/environment/identity.js'
import { recordLifecycleSeeded, recordLifecycleStarted } from '../src/environment/lifecycle-stage.js'
import { selectStateRoot } from '../src/environment/state.js'
import { publishComposeOwnership } from './compose-ownership-fixture.js'
import { recordSyntheticMeasurement } from './runtime-measurement-fixture.js'

const run = promisify(execFile)

/** A synthetic cockpit checkout for the health adapter composition; each root it makes is pushed to `roots` for cleanup. */
export function createHealthCompositionFixture(roots: string[]) {
    async function fixture(options: { readonly configuredRuntime?: boolean; readonly machineOnly?: boolean; readonly unmeasured?: boolean; readonly unseeded?: boolean; readonly uncommitted?: boolean } = {}) {
        const root = await realpath(await mkdtemp(join(tmpdir(), 'cockpit-health-composition-')))
        roots.push(root)
        const checkout = join(root, 'checkout')
        const home = join(root, 'home')
        const siblings = join(checkout, 'siblings')
        await Promise.all([mkdir(checkout), mkdir(home)])
        await mkdir(join(siblings, 'api'), { recursive: true })
        await run('git', ['init', '--quiet', checkout])
        const configPath = join(checkout, 'cockpit.toml')
        const config = [
            '[cockpit]',
            'name = "synthetic-cockpit"',
            'siblings_root = "siblings"',
            '',
            '[[sibling]]',
            'slug = "api"',
            'dir = "api"',
            'mount = "none"',
            'acquire = "none"',
            'var = "API_DIR"',
            'toolchain = "none"',
            'purpose = "Synthetic data"',
            '',
            '[ports]',
            'step = 10',
            'count = 2',
            'bases = { APP_PORT = 61230 }',
            '',
            '[environment]',
            'addressing = "hostname"',
            'authentication = "bypassed"',
            'posture_requirements = [{ requirement = "synthetic-route", addressing = "hostname", authentication = "bypassed" }]',
            '',
            ...(options.configuredRuntime || options.machineOnly ? [
                options.machineOnly ? 'compose_files = []' : 'compose_files = ["compose.yml"]',
                '',
                '[environment.machine]',
                'runtime_memory_mb = 1024',
                'runtime_cpus = 1',
                'free_disk_mb = 1024',
                'cold_start_seconds = 30',
                '',
            ] : []),
        ].join('\n')
        await writeFile(configPath, config)
        if ((options.configuredRuntime || options.machineOnly) && !options.unmeasured) await recordSyntheticMeasurement(home)
        if (options.configuredRuntime) await writeFile(join(checkout, 'compose.yml'), 'services: {}\n')
        if (!options.uncommitted) {
            await run('git', ['-C', checkout, 'add', 'cockpit.toml'])
            await run('git', ['-C', checkout, '-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid', 'commit', '--quiet', '-m', 'fixture'])
        }

        const cockpit = cockpitId({ name: 'synthetic-cockpit', mainCheckoutPath: checkout })
        const currentCheckout = checkoutId({ checkoutPath: checkout })
        const stack = stackId({ cockpitId: cockpit, checkoutId: currentCheckout, variant: { kind: 'shared' } })
        const holder = holderId({ stackId: stack, checkoutId: currentCheckout, sessionId: 'health-fixture' })
        if (process.platform !== 'darwin' && process.platform !== 'linux') throw new Error('fixture platform is unsupported')
        const selected = await selectStateRoot({ platform: process.platform, home, checkoutRoots: [checkout], cockpitId: cockpit })
        if (selected.kind !== 'complete') throw new Error('fixture state root was refused')
        const observedAt = new Date().toISOString()
        if (!options.unseeded) {
            await recordLifecycleStarted({ namespace: selected.value, stackId: stack, holderId: holder, observedAt })
            await recordLifecycleSeeded({ namespace: selected.value, stackId: stack, holderId: holder, observedAt: new Date().toISOString() })
        }
        if (options.configuredRuntime || options.machineOnly) {
            const loaded = await loadCockpitConfig(configPath)
            if (loaded.kind !== 'complete') throw new Error(JSON.stringify(loaded.diagnostics))
            const sourceSha256 = loaded.result.runtimeSha256
            if (options.configuredRuntime) await publishComposeOwnership(checkout, { stackId: stack, cockpitId: cockpit, runtimeSha256: sourceSha256 })
            await writeFile(join(checkout, 'topology.json'), JSON.stringify({ services: { api: { labels: {
                'dev.b0dea.cockpit.stack-id': stack,
                'dev.b0dea.cockpit.config-sha256': sourceSha256,
            } } } }))
            const dockerPath = join(root, 'docker')
            await writeFile(dockerPath, [
                '#!/bin/sh',
                'if [ "$1" = "version" ]; then printf "27.1.2\n"; exit 0; fi',
                'if [ "$1" = "compose" ] && [ "$2" = "version" ]; then printf "2.39.2\n"; exit 0; fi',
                'if [ "$1" = "info" ] && [ "$3" = "[{{json .OperatingSystem}},{{json .Name}},{{json .OSType}}]" ]; then printf \'%s\\n\' \'["Docker Desktop","docker-desktop","linux"]\'; exit 0; fi',
                'if [ "$1" = "info" ]; then printf "2147483648|2\n"; exit 0; fi',
                'if [ "$1" = "compose" ]; then /bin/cat "$PWD/topology.json"; exit 0; fi',
                'exit 64',
                '',
            ].join('\n'), { mode: 0o700 })
            await chmod(dockerPath, 0o700)
        }
        return { root, checkout, home, configPath, stack, namespace: selected.value }
    }
    return fixture
}
