'use strict'

// Drives one browser operation for packages/cockpit/src/browser/surfaces.ts through the project's own
// Playwright module: navigate to a surface, then report it, take its accessibility snapshot, or save a
// screenshot into the artifact root. Runs from a staged snapshot, so it must stay self-contained.
//
// argv: named flags (--operation, --engine, --connection, --url, --origin, --timeout, --module,
// --module-proof, --control-authorities, --control-ports, --aria-limit, --screenshot-limit, and the
// screenshot artifact flags); see operationStep in surfaces.ts for the full set.
// stdout on success: one JSON 'cockpit-browser-observation/v1' object.
// stderr on failure: one JSON 'cockpit-browser-failure/v1' object naming the phase and its category,
// and, when one is known, a fixed-vocabulary reason (a browser network error code such as
// ERR_CONNECTION_REFUSED, HTTP_<status> or TIMEOUT), exit code 1. The failure deliberately carries no
// error text: page content, URLs and storage state must not leak into cockpit's output.
//
// Requests to cockpit's own browser-control authorities and nested top-level navigations are blocked
// so the page under test cannot reach the control plane that drives it. Requests to a loopback or
// resolver-mapped host outside the application origin are blocked too: such an address is the host
// (through the remote runner's network exposure, or directly for a local browser), and the operation
// was given only the application. Playwright does not route a request the browser follows as a
// redirect, so a redirect to another loopback port still reaches it; this blocks direct requests only.
const fs = require('node:fs')
const crypto = require('node:crypto')
const path = require('node:path')
const args = process.argv.slice(2)
const one = name => { const index = args.indexOf(name); if (index < 0 || index + 1 >= args.length) throw new Error('missing argument'); return args[index + 1] }
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
async function main() {
    const moduleProof = fs.readFileSync(one('--module-proof'))
    const modulePath = one('--module')
    const moduleBytes = fs.readFileSync(modulePath)
    if (digest(moduleProof) !== digest(moduleBytes)) throw new Error('module changed')
    const api = require(modulePath)
    const engine = one('--engine')
    const browserType = api && api[engine]
    const connection = one('--connection')
    if (!['chromium', 'firefox', 'webkit'].includes(engine) || !browserType
            || connection === 'remote' && typeof browserType.connect !== 'function'
            || connection === 'local' && typeof browserType.launch !== 'function') throw new Error('browser module lacks selected engine operation')
    const operation = one('--operation')
    const url = one('--url')
    const timeout = Number(one('--timeout'))
    const deadline = Date.now() + timeout
    const remaining = () => { const value = deadline - Date.now(); if (value <= 0) throw new Error('browser operation deadline expired'); return value }
    const resolverRule = args.includes('--resolver-rule') ? one('--resolver-rule') : undefined
    const categories = { connect: 'availability', context: 'setup', navigation: 'navigation', accessibility: 'observation',
        screenshot: 'observation', artifact: 'artifact', cleanup: 'cleanup' }
    let browser, context, page, observation, failurePhase, failureReason, httpStatus, cleanupFailed = false, phase = 'connect'
    try {
        browser = connection === 'remote'
            ? await browserType.connect(one('--endpoint'), { timeout: remaining(), exposeNetwork: one('--expose-network') })
            : await browserType.launch({ headless: true, timeout: remaining(),
                    ...(resolverRule ? { args: ['--host-resolver-rules=' + resolverRule] } : {}) })
        phase = 'context'
        const state = process.env.COCKPIT_BROWSER_STORAGE_STATE
        const stateProof = state ? fs.readFileSync(one('--state-proof')) : undefined
        if (state && digest(fs.readFileSync(state)) !== digest(stateProof)) throw new Error('storage state changed')
        const storageState = stateProof ? JSON.parse(stateProof.toString('utf8')) : undefined
        context = await browser.newContext({ ...(storageState ? { storageState } : {}), serviceWorkers: 'block' })
        const controlAuthorities = new Set(JSON.parse(one('--control-authorities')))
        const controlPorts = new Set(JSON.parse(one('--control-ports')).map(String))
        const isControlAuthority = value => { try {
            const parsed = new URL(value)
            const port = parsed.port || (parsed.protocol === 'http:' || parsed.protocol === 'ws:' ? '80'
                : parsed.protocol === 'https:' || parsed.protocol === 'wss:' ? '443' : '')
            return controlAuthorities.has(parsed.hostname + ':' + port) || controlPorts.has(port)
        } catch { return true } }
        const origin = one('--origin')
        const mappedHosts = new Set((resolverRule || '').split(',').map(rule => rule.trim().split(/\s+/))
            .filter(parts => parts[0] === 'MAP' && parts[1]).map(parts => parts[1].toLowerCase()))
        const isForeignHost = value => { try {
            const parsed = new URL(value)
            const scheme = { 'ws:': 'http:', 'wss:': 'https:' }[parsed.protocol] || parsed.protocol
            if (!['http:', 'https:'].includes(scheme) || new URL(scheme + '//' + parsed.host).origin === origin) return false
            const hostname = parsed.hostname
            return hostname === 'localhost' || hostname.endsWith('.localhost') || /^127\./.test(hostname) || hostname === '0.0.0.0'
                || hostname === '[::1]' || hostname.startsWith('[::ffff:7f') || mappedHosts.has(hostname)
        } catch { return true } }
        let mainNavigationAttempts = 0
        await context.route('**/*', async (route, request) => {
            if (isControlAuthority(request.url()) || isForeignHost(request.url())) return route.abort('blockedbyclient')
            const frame = request.frame()
            const mainNavigation = request.isNavigationRequest() && page && frame === page.mainFrame()
            if (request.isNavigationRequest() && !mainNavigation
                    && (!frame || typeof frame.parentFrame !== 'function' || frame.parentFrame() === null)) return route.abort('blockedbyclient')
            if (mainNavigation) mainNavigationAttempts += 1
            await route.continue()
        })
        if (typeof context.routeWebSocket !== 'function') throw new Error('browser module lacks WebSocket routing')
        await context.routeWebSocket(() => true, webSocket => {
            if (isControlAuthority(webSocket.url()) || isForeignHost(webSocket.url())) return webSocket.close({ code: 1008, reason: 'blocked by the cockpit browser operation' })
            webSocket.connectToServer()
        })
        phase = 'navigation'
        page = await context.newPage()
        let documentEpoch = 0
        let documentResponse
        page.on('framenavigated', frame => { if (frame === page.mainFrame()) documentEpoch += 1 })
        page.on('response', response => {
            const request = response.request()
            if (request.isNavigationRequest() && request.frame() === page.mainFrame()) documentResponse = response
        })
        const currentDocument = () => {
            const displayed = new URL(page.url())
            if (displayed.origin !== origin || displayed.username || displayed.password || displayed.hash) throw new Error('navigation left application origin')
            if (!documentResponse || typeof documentResponse.ok !== 'function' || !documentResponse.ok()
                    || typeof documentResponse.url !== 'function' || documentResponse.url() !== displayed.href) {
                throw new Error('displayed document lacks a successful terminal HTTP response')
            }
            return { url: displayed.href, epoch: documentEpoch, attempts: mainNavigationAttempts }
        }
        const response = await page.goto(url, { timeout: remaining() })
        if (response && typeof response.status === 'function') httpStatus = response.status()
        if (!response || typeof response.ok !== 'function' || !response.ok()) throw new Error('navigation did not return a successful HTTP response')
        documentResponse = response
        const initialDocument = currentDocument()
        if (operation === 'drive') observation = { schema: 'cockpit-browser-observation/v1', operation, finalUrl: initialDocument.url }
        else if (operation === 'accessibility') {
            phase = 'accessibility'
            const displayedBefore = currentDocument()
            const value = await page.locator('body').ariaSnapshot()
            if (typeof value !== 'string') throw new Error('accessibility observation is not text')
            const bytes = Buffer.from(value, 'utf8')
            if (bytes.byteLength > Number(one('--aria-limit'))) throw new Error('accessibility observation exceeds bound')
            const displayedAfter = currentDocument()
            if (displayedAfter.url !== displayedBefore.url || displayedAfter.epoch !== displayedBefore.epoch
                    || displayedAfter.attempts !== displayedBefore.attempts) throw new Error('navigation changed during accessibility observation')
            observation = { schema: 'cockpit-browser-observation/v1', operation, finalUrl: displayedAfter.url, evidence: { sha256: digest(bytes), byteLength: bytes.byteLength } }
        } else if (operation === 'screenshot') {
            phase = 'screenshot'
            const displayedBefore = currentDocument()
            const bytes = await page.screenshot()
            if (!Buffer.isBuffer(bytes) || bytes.byteLength > Number(one('--screenshot-limit'))) throw new Error('screenshot observation exceeds bound')
            const displayedAfter = currentDocument()
            if (displayedAfter.url !== displayedBefore.url || displayedAfter.epoch !== displayedBefore.epoch
                    || displayedAfter.attempts !== displayedBefore.attempts) throw new Error('navigation changed during screenshot observation')
            const output = one('--output')
            const root = one('--artifact-root')
            const expectedDev = Number(one('--artifact-dev'))
            const expectedIno = Number(one('--artifact-ino'))
            const expectedBirthtimeNs = one('--artifact-birthtime-ns')
            phase = 'artifact'
            if (path.dirname(output) !== root || path.basename(output) !== one('--output-name')) throw new Error('screenshot output escaped root')
            let rootDescriptor, dotDescriptor, descriptor
            try {
                rootDescriptor = fs.openSync(root, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW)
                const held = fs.fstatSync(rootDescriptor)
                const named = fs.lstatSync(root)
                // ext4 reuses a freed inode for the next directory created, so a root recreated since
                // planning can carry the planned device and inode; birth time tells the two apart.
                if (!held.isDirectory() || named.isSymbolicLink() || held.dev !== expectedDev || held.ino !== expectedIno
                    || String(fs.fstatSync(rootDescriptor, { bigint: true }).birthtimeNs) !== expectedBirthtimeNs
                    || named.dev !== held.dev || named.ino !== held.ino) throw new Error('artifact root changed')
                process.chdir(root)
                dotDescriptor = fs.openSync('.', fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW)
                const anchored = fs.fstatSync(dotDescriptor)
                if (anchored.dev !== held.dev || anchored.ino !== held.ino) throw new Error('artifact root changed')
                descriptor = fs.openSync(one('--output-name'), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600)
                fs.fchmodSync(descriptor, 0o600); fs.writeFileSync(descriptor, bytes); fs.fsyncSync(descriptor)
                const after = fs.fstatSync(dotDescriptor)
                if (after.dev !== held.dev || after.ino !== held.ino) throw new Error('artifact root changed')
            } finally {
                if (descriptor !== undefined) fs.closeSync(descriptor)
                if (dotDescriptor !== undefined) fs.closeSync(dotDescriptor)
                if (rootDescriptor !== undefined) fs.closeSync(rootDescriptor)
            }
            observation = { schema: 'cockpit-browser-observation/v1', operation, finalUrl: displayedAfter.url, evidence: { sha256: digest(bytes), byteLength: bytes.byteLength } }
        } else throw new Error('unsupported operation')
    } catch (error) {
        failurePhase = phase
        // Only identifiers leave this process: Chromium's net error code, the HTTP status or a timeout.
        const message = error && typeof error.message === 'string' ? error.message : ''
        const network = /net::(ERR_[A-Z0-9_]{1,64})\b/.exec(message)
        failureReason = network ? network[1]
            : error && error.name === 'TimeoutError' ? 'TIMEOUT'
            : phase === 'navigation' && Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599
                && (httpStatus < 200 || httpStatus > 299) ? 'HTTP_' + httpStatus
            : undefined
    }
    finally {
        for (const value of [page, context, browser]) if (value && typeof value.close === 'function') {
            try { await value.close() } catch { cleanupFailed = true }
        }
    }
    if (failurePhase || cleanupFailed || !observation) {
        const failedAt = failurePhase || 'cleanup'
        process.stderr.write(JSON.stringify({ schema: 'cockpit-browser-failure/v1', phase: failedAt,
            category: categories[failedAt], cleanup: cleanupFailed, ...(failurePhase && failureReason ? { reason: failureReason } : {}) }))
        process.exitCode = 1
        return
    }
    process.stdout.write(JSON.stringify(observation))
}
main().catch(() => { process.stderr.write('{"schema":"cockpit-browser-failure/v1","phase":"context","category":"setup","cleanup":false}'); process.exitCode = 1 })
