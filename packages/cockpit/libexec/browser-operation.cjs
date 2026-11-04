'use strict'

// Drives one browser operation for packages/cockpit/src/browser/surfaces.ts through the project's own
// Playwright module: navigate to a surface, then report it or save a screenshot into the artifact
// root. Runs from a staged snapshot, so it must stay self-contained.
//
// argv: named flags (--operation, --engine, --connection, --url, --origin, --timeout, --module,
// --module-proof, --control-authorities, --control-ports, --screenshot-limit, and the screenshot
// artifact flags); see operationStep in surfaces.ts for the full set.
// stdout on success: one JSON 'cockpit-browser-observation/v1' object. A drive observation also carries
// per-route diagnostics: counts of console errors, uncaught page errors and failed or >= 400 requests to
// the application origin, a count of warnings, aborted requests and third-party traffic, and a capped
// list of entries. Entries hold only identifiers: a request's method, URL path (no query) and status or
// network error code; a console error's script path and line; an uncaught error's class name. Bodies,
// headers and cookies are never read. Message text is read only when cockpit passes --messages, which it
// does only for a data posture that is isolated, not restored and not reaching production; the drive
// observation then carries a capped `messages` list of console error and uncaught error text.
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
const MAX_ENTRIES = 20
const MAX_PATH = 200
const MAX_MESSAGES = 5
const MAX_MESSAGE_BYTES = 240
const SETTLE_MS = 1000
// Records what the page did wrong; what it said only with withMessages: see the stdout contract above.
function collectDiagnostics(page, origin, withMessages) {
    const counts = { consoleErrors: 0, consoleWarnings: 0, pageErrors: 0, failedRequests: 0, abortedRequests: 0 }
    const thirdParty = { requests: 0, failed: 0 }
    const entries = []
    let omitted = 0
    const messages = []
    // Control characters are replaced so message text stays one line of plain text; the cap is in bytes.
    const excerpt = value => {
        // A character is at least one byte, so the first MAX_MESSAGE_BYTES characters hold the longest prefix within the cap.
        let text = String(value).replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, MAX_MESSAGE_BYTES)
        while (Buffer.byteLength(text) > MAX_MESSAGE_BYTES) text = text.slice(0, -1)
        return text
    }
    const keep = (kind, value) => { if (withMessages && messages.length < MAX_MESSAGES) { const text = excerpt(value); if (text) messages.push({ kind, text }) } }
    const add = entry => { if (entries.length < MAX_ENTRIES) entries.push(entry); else omitted += 1 }
    const parse = value => { try { const parsed = new URL(value); return ['http:', 'https:'].includes(parsed.protocol) ? parsed : undefined } catch { return undefined } }
    const pathOf = parsed => parsed.pathname.slice(0, MAX_PATH)
    page.on('console', message => {
        if (message.type() === 'warning') counts.consoleWarnings += 1
        if (message.type() !== 'error') return
        counts.consoleErrors += 1
        keep('console', message.text())
        const location = message.location()
        const parsed = location && typeof location.url === 'string' ? parse(location.url) : undefined
        const own = parsed && parsed.origin === origin
        add({ kind: 'console', ...(own ? { path: pathOf(parsed) } : {}),
            ...(own && Number.isInteger(location.lineNumber) && location.lineNumber >= 0 ? { line: location.lineNumber } : {}) })
    })
    page.on('pageerror', error => {
        counts.pageErrors += 1
        keep('pageerror', error && typeof error.message === 'string' ? error.message : 'uncaught error')
        add({ kind: 'pageerror', name: error && typeof error.name === 'string' && /^[A-Za-z0-9_$.]{1,64}$/.test(error.name) ? error.name : 'Error' })
    })
    page.on('request', request => { const parsed = parse(request.url()); if (parsed && parsed.origin !== origin) thirdParty.requests += 1 })
    page.on('requestfailed', request => {
        const parsed = parse(request.url())
        if (!parsed) return
        const failure = request.failure()
        const code = failure && typeof failure.errorText === 'string' ? /net::(ERR_[A-Z0-9_]{1,64})\b/.exec(failure.errorText) : null
        // A request the browser cancelled itself, such as one left behind by a navigation, is not a failure.
        if (code && code[1] === 'ERR_ABORTED') { counts.abortedRequests += 1; return }
        if (parsed.origin !== origin) { thirdParty.failed += 1; return }
        counts.failedRequests += 1
        add({ kind: 'request', method: request.method(), path: pathOf(parsed), failure: code ? code[1] : 'ERR_UNKNOWN' })
    })
    page.on('response', response => {
        const status = response.status()
        if (status < 400) return
        const request = response.request()
        // A main-document failure already refuses the drive, so it is not reported twice.
        if (request.isNavigationRequest() && request.frame() === page.mainFrame()) return
        const parsed = parse(response.url())
        if (!parsed) return
        if (parsed.origin !== origin) { thirdParty.failed += 1; return }
        counts.failedRequests += 1
        add({ kind: 'request', method: request.method(), path: pathOf(parsed), status })
    })
    return () => ({ ...counts, thirdParty, entries, omitted, ...(withMessages ? { messages } : {}) })
}
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
    const categories = { connect: 'availability', context: 'setup', navigation: 'navigation',
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
        // An address that does not parse cannot be shown to be safe, so both guards treat it as blocked
        // rather than naming the error, which would quote the address.
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
        const diagnostics = operation === 'drive' ? collectDiagnostics(page, origin, args.includes('--messages')) : undefined
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
        if (operation === 'drive') {
            // Errors raised just after load are findings too. An application that polls never goes idle,
            // so running out the short wait is not a failure; any other error still propagates.
            try { await page.waitForLoadState('networkidle', { timeout: Math.min(remaining(), SETTLE_MS) }) }
            catch (error) { if (!error || error.name !== 'TimeoutError') throw error }
            observation = { schema: 'cockpit-browser-observation/v1', operation, finalUrl: initialDocument.url, diagnostics: diagnostics() }
        }
        else if (operation === 'screenshot') {
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
            // The failure record carries a cleanup flag and never a message, so the error is not kept.
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
