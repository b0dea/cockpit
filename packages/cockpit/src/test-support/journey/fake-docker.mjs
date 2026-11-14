// A stand-in `docker` for adopter journeys. argv[2] is its state directory and argv[3] the URL of a
// YAML parser. It appends every call to calls.jsonl and answers from state.json, so a journey can
// assert what cockpit asked Docker to do without a daemon. It models only what cockpit calls: a
// container's command runs once on the host when it starts, with mount targets rewritten to their
// host sources and a trailing idle loop dropped, and every running container is healthy. Anything
// else exits 64 and names itself, so a new call fails a journey instead of passing unnoticed.
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

const [, , stateDir, yamlUrl, ...invocation] = process.argv
appendFileSync(join(stateDir, 'calls.jsonl'), `${JSON.stringify(invocation)}\n`)
// cockpit issues some calls in parallel; one call at a time keeps state.json whole. A holder that
// was killed, as cockpit kills a call past its timeout, leaves its lock to the next caller.
const lock = join(stateDir, 'lock')
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
for (;;) {
    try { mkdirSync(lock); writeFileSync(join(lock, 'pid'), String(process.pid)); break } catch (error) { if (error.code !== 'EEXIST') throw error }
    let holder = 0
    try { holder = Number(readFileSync(join(lock, 'pid'), 'utf8')) } catch (error) { if (error.code !== 'ENOENT') throw error }
    try { if (holder > 0) process.kill(holder, 0) } catch (error) { if (error.code === 'ESRCH') rmSync(lock, { recursive: true, force: true }) }
    sleep(5)
}
process.on('exit', () => rmSync(lock, { recursive: true, force: true }))
const statePath = join(stateDir, 'state.json')
const state = JSON.parse(readFileSync(statePath, 'utf8'))
const save = () => writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`)
const out = (text) => { if (text !== '') process.stdout.write(text.endsWith('\n') ? text : `${text}\n`) }
const fail = (message, code = 1) => { process.stderr.write(`${message}\n`); process.exit(code) }
const unsupported = () => fail(`fake docker does not implement: ${invocation.join(' ')}`, 64)
const newId = () => createHash('sha256').update(`${stateDir}\0${state.sequence++}`).digest('hex')
const option = (list, name) => { const index = list.indexOf(name); return index === -1 ? undefined : list[index + 1] }
const options = (list, name) => list.flatMap((value, index) => list[index - 1] === name ? [value] : [])
const operands = (list, valued) => list.filter((value, index) => !value.startsWith('-') && !valued.includes(list[index - 1]))

// The subset of Go templates cockpit's --format strings use: fields, json, index, or, .Label,
// with/else and range over a map.
function parseTemplate(parts, stop = []) {
    const nodes = []
    while (parts.length > 0) {
        const part = parts.shift()
        const action = /^\{\{\s*(.*?)\s*\}\}$/s.exec(part)?.[1]
        if (action === undefined) { nodes.push({ text: part }); continue }
        if (stop.includes(action)) return Object.assign(nodes, { end: action })
        const range = /^range \$(\w+), \$\w+ := (.*)$/.exec(action)
        if (range) { nodes.push({ range: range[2], key: range[1], body: parseTemplate(parts, ['end']) }); continue }
        if (!action.startsWith('with ')) { nodes.push({ action }); continue }
        const then = parseTemplate(parts, ['else', 'end'])
        nodes.push({ with: action.slice(5), then, otherwise: then.end === 'else' ? parseTemplate(parts, ['end']) : [] })
    }
    return nodes
}
function render(nodes, dot, variables = {}) {
    return nodes.map((node) => {
        if ('text' in node) return node.text
        const value = evaluate(node.action ?? node.with ?? node.range, dot, variables)
        if ('range' in node) return Object.keys(value ?? {}).sort().map((key) => render(node.body, dot, { ...variables, [node.key]: key })).join('')
        if ('with' in node) return render(value === undefined || value === null || value === '' ? node.otherwise : node.then, value, variables)
        return typeof value === 'string' ? value : JSON.stringify(value ?? null)
    }).join('')
}
function evaluate(expression, dot, variables) {
    const tokens = expression.match(/"(?:[^"\\]|\\.)*"|\(|\)|[^\s()]+/g) ?? []
    let position = 0
    const term = () => {
        const token = tokens[position++]
        if (token === '(') { const value = command(); position++; return value }
        if (token.startsWith('"')) return JSON.parse(token)
        if (token === '.') return dot
        if (token.startsWith('$')) return variables[token.slice(1)]
        if (token.startsWith('.')) return token.slice(1).split('.').reduce((value, key) => value?.[key], dot)
        return { name: token }
    }
    const command = () => {
        const head = term()
        const args = []
        while (position < tokens.length && tokens[position] !== ')') args.push(term())
        if (head?.name === 'json') return JSON.stringify(args[0] ?? null)
        if (head?.name === 'index') return args[0]?.[args[1]] ?? null
        if (head?.name === 'or') return args.find((arg) => arg !== undefined && arg !== null && arg !== '') ?? args.at(-1)
        return typeof head === 'function' ? head(...args) : head
    }
    return command()
}
const format = (template, dot) => render(parseTemplate(template.split(/(\{\{.*?\}\})/s)), dot)

function interpolate(value, env) {
    if (typeof value === 'string') {
        return value.replace(/\$\$|\$\{([A-Za-z0-9_]+)(?::?([-?])([^}]*))?\}/g, (match, name, kind, text) => {
            if (match === '$$') return '$'
            if (env[name] !== undefined && env[name] !== '') return env[name]
            if (kind === '?') fail(`required variable ${name} is missing a value: ${text}`)
            return kind === '-' ? text : ''
        })
    }
    if (Array.isArray(value)) return value.map((item) => interpolate(item, env))
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, interpolate(item, env)]))
    return value
}
// Compose's merge for the shapes journeys use: later files override scalars and merge maps.
function merge(base, next) {
    if (Array.isArray(base) && Array.isArray(next)) return [...base, ...next]
    if (base && next && typeof base === 'object' && typeof next === 'object') {
        return Object.fromEntries([...new Set([...Object.keys(base), ...Object.keys(next)])]
            .map((key) => [key, key in next ? (key in base ? merge(base[key], next[key]) : next[key]) : base[key]]))
    }
    return next
}
const COMPOSE_VALUED = ['--project-directory', '--file', '-f', '--project-name', '-p', '--env-file', '--profile', '--progress', '--ansi']
async function loadProject(head, interpolated) {
    const { parse } = await import(yamlUrl)
    const directory = option(head, '--project-directory') ?? process.cwd()
    let model = options(head, '--file').map((file) => parse(readFileSync(resolve(directory, file), 'utf8')) ?? {}).reduce(merge, {})
    if (!model.services || typeof model.services !== 'object') fail('validating compose file: services must be a mapping', 15)
    if (interpolated) model = interpolate(model, process.env)
    const name = option(head, '--project-name')
    const profiles = options(head, '--profile')
    // Normalised as `docker compose config --format json` prints it.
    model.networks = { default: {}, ...model.networks }
    for (const [key, network] of Object.entries(model.networks)) model.networks[key] = { name: `${name}_${key}`, ...network }
    for (const [key, volume] of Object.entries(model.volumes ?? {})) model.volumes[key] = { name: `${name}_${key}`, ...volume }
    for (const service of Object.values(model.services)) {
        service.networks ??= { default: null }
        if (interpolated) {
            service.ports = (service.ports ?? []).map((port) => {
                if (typeof port !== 'string') return port
                const [target, published, hostIp] = port.split(':').reverse()
                return { mode: 'ingress', ...hostIp ? { host_ip: hostIp } : {}, target: Number(target), ...published ? { published } : {}, protocol: 'tcp' }
            })
        }
        if (Array.isArray(service.depends_on)) {
            service.depends_on = Object.fromEntries(service.depends_on.map((other) => [other, { condition: 'service_started', required: true }]))
        }
        service.volumes = (service.volumes ?? []).map((volume) => {
            const long = typeof volume === 'string'
                ? { type: /^[./$]/.test(volume) ? 'bind' : 'volume', source: volume.split(':')[0], target: volume.split(':')[1] } : { ...volume }
            if (long.type === 'bind' && !isAbsolute(long.source)) long.source = resolve(directory, long.source)
            return long
        })
    }
    const active = Object.entries(model.services).filter(([, service]) => !service.profiles || service.profiles.some((profile) => profiles.includes(profile)))
    return { name, model, active }
}

const volumeName = (project, key) => project.model.volumes?.[key]?.name ?? `${project.name}_${key}`
function volumeDirectory(name) { const path = join(stateDir, 'volumes', name); mkdirSync(path, { recursive: true }); return path }
// A container's /proc/1 is a directory of its own: `stat` carries a start time that changes on every
// start, as a restarted process's does, and `exe` stands for the image's entrypoint binary.
function processDirectory(container) { return join(stateDir, 'proc', container.Id) }
function hostPaths(text, container) {
    return [...container.Mounts, { Destination: '/proc/1', Source: processDirectory(container) }]
        .reduce((result, mount) => result.split(mount.Destination).join(mount.Source), text)
}
function execIn(key, argv) {
    const container = kinds.container.find(key)
    if (container?.State.Status !== 'running') fail(`Error response from daemon: container ${key} is not running`)
    const [program, ...programArgs] = argv.map((arg) => hostPaths(arg, container))
    const result = spawnSync(program, programArgs, { encoding: 'utf8', env: { PATH: `${process.env.PATH}:/usr/sbin:/sbin` } })
    process.stdout.write(result.stdout)
    process.stderr.write(result.stderr)
    process.exitCode = result.status ?? 1
}
// A published port really listens while its container runs, as Docker's port forwarder does,
// because preflight connects to each leased port. Listener pids live in state.json so stop, down
// and the journey's own cleanup can end them.
function start(container) {
    container.State = { Status: 'running', Running: true, Health: { Status: 'healthy' } }
    mkdirSync(processDirectory(container), { recursive: true })
    writeFileSync(join(processDirectory(container), 'stat'), `1 (sh) S ${'0 '.repeat(18)}${state.sequence++} 0 0\n`)
    writeFileSync(join(processDirectory(container), 'exe'), container.Config.Image)
    container.listeners = Object.values(container.NetworkSettings.Ports).flat().map(({ HostIp, HostPort }) => {
        const ready = join(stateDir, `listener-${HostPort}`)
        const report = (text) => `require('fs').writeFileSync(${JSON.stringify(ready)}, ${text})`
        const child = spawn(process.execPath, ['-e', `require('net').createServer((s) => s.end())
            .on('error', (error) => { ${report('error.message')}; process.exit(1) })
            .listen(${HostPort}, ${JSON.stringify(HostIp)}, () => ${report("'listening'")})`], { detached: true, stdio: 'ignore' })
        child.unref()
        while (!existsSync(ready)) sleep(5)
        const outcome = readFileSync(ready, 'utf8')
        rmSync(ready)
        if (outcome !== 'listening') fail(`Error response from daemon: ports are not available: ${HostIp}:${HostPort}: ${outcome}`)
        return child.pid
    })
    if (!container.command) return
    const script = hostPaths(container.command.at(-1).replace(/;?\s*while :; do sleep \d+; done\s*$/, ''), container)
    container.logs += execFileSync('/bin/sh', ['-c', script], { encoding: 'utf8', env: { PATH: process.env.PATH, ...container.Config.Env } })
}

function stop(container) {
    for (const pid of container.listeners ?? []) {
        try { process.kill(pid) } catch (error) { if (error.code !== 'ESRCH') throw error }
    }
    container.listeners = []
    container.State = { Status: 'exited', Running: false }
}

async function compose(rest) {
    const verbIndex = rest.findIndex((value, index) => !value.startsWith('-') && !COMPOSE_VALUED.includes(rest[index - 1]))
    const [head, verb, tail] = [rest.slice(0, verbIndex), rest[verbIndex], rest.slice(verbIndex + 1)]
    if (verb === 'version') return out(state.composeVersion)
    const project = await loadProject(head, verb !== 'config' || !tail.includes('--no-interpolate'))
    if (verb === 'config') return tail.includes('--quiet') ? undefined : out(JSON.stringify({ name: project.name, ...project.model }))
    const services = operands(tail, ['--timeout', '-t', '--since', '--until', '--tail', '-n', '--wait-timeout', '--status', '--format'])
    const mine = state.containers.filter((container) => container.project === project.name && (services.length === 0 || services.includes(container.service)))
    switch (verb) {
        case 'up': {
            for (const key of Object.keys(project.model.volumes ?? {})) {
                const name = volumeName(project, key)
                if (state.volumes.some((volume) => volume.Name === name)) continue
                state.volumes.push({ Name: name, CreatedAt: new Date().toISOString(), Labels: { ...project.model.volumes[key]?.labels, 'com.docker.compose.project': project.name, 'com.docker.compose.volume': key } })
            }
            for (const [key, network] of Object.entries(project.model.networks ?? { default: {} })) {
                const name = network?.name ?? `${project.name}_${key}`
                if (state.networks.some((entry) => entry.Name === name)) continue
                state.networks.push({ ID: newId(), Name: name, Labels: { ...network?.labels, 'com.docker.compose.project': project.name, 'com.docker.compose.network': key } })
            }
            for (const [service, definition] of project.active) {
                if (services.length > 0 && !services.includes(service)) continue
                let container = state.containers.find((entry) => entry.project === project.name && entry.service === service)
                if (container?.State.Status === 'running') continue
                if (!container) {
                    container = {
                        Id: newId(), Name: `/${project.name}-${service}-1`, project: project.name, service, logs: '', command: definition.command,
                        Config: {
                            Labels: { ...definition.labels, 'com.docker.compose.project': project.name, 'com.docker.compose.service': service },
                            Env: Object.fromEntries((definition.environment ?? []).map((pair) => pair.split(/=(.*)/s))), Image: definition.image,
                        },
                        Mounts: definition.volumes.map((volume) => ({
                            Type: volume.type, Destination: volume.target,
                            Source: volume.type === 'bind' ? volume.source : volumeDirectory(volumeName(project, volume.source)),
                        })),
                        NetworkSettings: { Ports: Object.fromEntries(definition.ports.map((port) => [`${port.target}/${port.protocol}`, [{ HostIp: port.host_ip ?? '0.0.0.0', HostPort: String(port.published) }]])) },
                    }
                    state.containers.push(container)
                }
                start(container)
            }
            save()
            return
        }
        case 'stop':
            for (const container of mine) stop(container)
            save()
            return
        case 'down':
            for (const container of mine) stop(container)
            state.containers = state.containers.filter((container) => container.project !== project.name)
            state.networks = state.networks.filter((network) => network.Labels['com.docker.compose.project'] !== project.name)
            if (tail.includes('--volumes') || tail.includes('-v')) state.volumes = state.volumes.filter((volume) => volume.Labels['com.docker.compose.project'] !== project.name)
            save()
            return
        case 'ps': {
            const shown = mine.filter((container) => (tail.includes('--all') || container.State.Status === 'running')
                && (option(tail, '--status') ?? container.State.Status) === container.State.Status)
            if (tail.includes('--quiet')) return out(shown.map((container) => container.Id).join('\n'))
            return out(shown.map((container) => JSON.stringify({
                ID: container.Id.slice(0, 12), Name: container.Name.slice(1), Service: container.service, Project: project.name,
                State: container.State.Status, Health: container.State.Health?.Status ?? '', ExitCode: 0,
                Publishers: Object.entries(container.NetworkSettings.Ports).map(([target, [binding]]) => ({
                    URL: binding.HostIp, TargetPort: Number.parseInt(target), PublishedPort: Number(binding.HostPort), Protocol: target.split('/')[1],
                })),
                Labels: Object.entries(container.Config.Labels).map(([key, value]) => `${key}=${value}`).join(','),
            })).join('\n'))
        }
        case 'logs': return out(mine.flatMap((container) => container.logs.split('\n').filter(Boolean)
            .map((line) => tail.includes('--no-log-prefix') ? line : `${container.Name.slice(1)}  | ${line}`)).join('\n'))
        default: return unsupported()
    }
}

// Listing rows expose Docker's listing fields, including the `.Label "key"` method.
const listing = (resource, fields) => ({ ...fields, Labels: resource.Labels ?? resource.Config?.Labels, Label: (key) => (resource.Labels ?? resource.Config?.Labels)?.[key] ?? '' })
const kinds = {
    container: {
        items: () => state.containers,
        find: (key) => state.containers.find((container) => container.Id.startsWith(key) || container.Name === `/${key}`),
        row: (container) => listing(container, { ID: container.Id, Names: container.Name.slice(1), State: container.State.Status, Networks: `${container.project}_default` }),
        remove: (ids) => {
            const removed = (container) => ids.some((id) => container.Id.startsWith(id))
            state.containers.filter(removed).forEach(stop)
            state.containers = state.containers.filter((container) => !removed(container))
        },
        labels: (container) => container.Config.Labels,
    },
    volume: {
        items: () => state.volumes,
        find: (key) => state.volumes.find((volume) => volume.Name === key),
        row: (volume) => listing(volume, { Name: volume.Name, Size: 'N/A' }),
        remove: (names) => { state.volumes = state.volumes.filter((volume) => !names.includes(volume.Name)) },
        labels: (volume) => volume.Labels,
    },
    network: {
        items: () => state.networks,
        find: (key) => state.networks.find((network) => network.ID.startsWith(key) || network.Name === key),
        row: (network) => listing(network, { ID: network.ID, Name: network.Name }),
        inspect: (network) => ({ ...network, Id: network.ID, Containers: Object.fromEntries(state.containers
            .filter((container) => container.State.Status === 'running' && `${container.project}_default` === network.Name).map((container) => [container.Id, {}])) }),
        remove: (ids) => { state.networks = state.networks.filter((network) => !ids.some((id) => network.ID.startsWith(id) || network.Name === id)) },
        labels: (network) => network.Labels,
    },
}
function list(kind, rest) {
    const all = rest.includes('-a') || rest.includes('--all') || rest.includes('-aq')
    const rows = kinds[kind].items().filter((item) => kind !== 'container' || all || item.State.Status === 'running').filter((item) => options(rest, '--filter').every((filter) => {
        const [type, value] = filter.split(/=(.*)/s)
        if (type === 'network') return kind === 'container' && `${item.project}_default` === value
        if (type !== 'label') return fail(`fake docker does not filter by ${type}`, 64)
        const [key, expected] = value.split(/=(.*)/s)
        const labels = kinds[kind].labels(item)
        return expected === undefined ? key in labels : labels[key] === expected
    }))
    const template = option(rest, '--format')
    if (template !== undefined) return out(rows.map((item) => format(template, kinds[kind].row(item))).join('\n'))
    if (rest.some((value) => ['-q', '--quiet', '-aq'].includes(value))) return out(rows.map((item) => item.Id ?? item.ID ?? item.Name).join('\n'))
    return unsupported()
}

const args = invocation[0] === '--host' ? invocation.slice(2) : invocation
const [command, sub, ...rest] = args
switch (`${command} ${sub}`) {
    case 'version --format': out(state.serverVersion); break
    case 'info --format': out(format(rest[0], { OperatingSystem: state.operatingSystem, Name: 'fake-docker', OSType: 'linux', MemTotal: state.memTotal, NCPU: state.cpus })); break
    case 'context show': out('default'); break
    case 'context inspect': out(format(option(args, '--format'), { Name: rest[0], Endpoints: { docker: { Host: 'unix:///var/run/docker.sock' } } })); break
    case 'image inspect': {
        const id = state.images[rest[0]] ?? Object.values(state.images).find((value) => value === rest[0])
        if (!id) fail(`Error: No such image: ${rest[0]}`)
        out(format(option(rest, '--format'), { Id: id }))
        break
    }
    case 'image ls': case 'builder du': out(''); break
    case 'ps -aq': case 'ps -a': list('container', [sub, ...rest]); break
    case 'container ls': case 'volume ls': case 'network ls': list(command, rest); break
    case 'container inspect': case 'volume inspect': case 'network inspect': {
        const template = option(rest, '--format')
        const found = operands(rest, ['--format']).map((key) => kinds[command].find(key) ?? fail(`Error: No such ${command}: ${key}`))
        out(found.map((item) => format(template, kinds[command].inspect?.(item) ?? item)).join('\n'))
        break
    }
    case 'container exec': execIn(rest[0], rest.slice(1)); break
    case 'container logs': {
        const container = kinds.container.find(rest.at(-1)) ?? fail(`Error: No such container: ${rest.at(-1)}`)
        const stamp = rest.includes('--timestamps') ? `${new Date().toISOString()} ` : ''
        out(container.logs.split('\n').filter(Boolean).map((line) => `${stamp}${line}`).join('\n'))
        break
    }
    case 'container rm': case 'volume rm': case 'network rm':
        kinds[command].remove(operands(rest, []))
        save()
        out(operands(rest, []).join('\n'))
        break
    default:
        if (command === 'exec' && sub === '--') execIn(rest[0], rest.slice(1))
        else if (command === 'compose') await compose(args.slice(1))
        else unsupported()
}
