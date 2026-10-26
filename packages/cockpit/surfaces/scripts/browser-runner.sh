#!/bin/sh
set -eu

fail() { printf '%s\n' "$1" >&2; exit 2; }
sha256() {
  node -e 'const fs=require("node:fs"),crypto=require("node:crypto");process.stdout.write(crypto.createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex"))' "$1"
}

[ "$#" -ge 1 ] || fail 'browser runner operation is required'
operation=$1
shift
if [ "$operation" = check ]; then
  [ "$#" -eq 2 ] || fail 'browser runner check requires host and port'
  node -e '
    const net=require("node:net");
    const host=process.argv[1],port=Number(process.argv[2]);
    const socket=net.createConnection({host:"127.0.0.1",port});
    socket.setTimeout(3000);
    socket.once("connect",()=>socket.write("GET / HTTP/1.1\r\nHost: "+host+"\r\nConnection: close\r\n\r\n"));
    socket.once("data",chunk=>{const line=chunk.toString("ascii").split("\r\n",1)[0];socket.destroy();process.exit(/^HTTP\/1\.1 (?!403|431)\d{3}/.test(line)?0:1)});
    socket.once("timeout",()=>{socket.destroy();process.exit(1)});socket.once("error",()=>process.exit(1));
  ' "$1" "$2"
  exit 0
fi
[ "$operation" = serve ] || [ "$operation" = debugger ] || fail 'browser runner operation is invalid'

manifest=''
lockfile=''
manifest_sha=''
lock_sha=''
driver=''
server_port=''
proxy_port=''
max_clients=''
artifacts=''
engine=''
deadline=''
ws_path=''
allowed_hosts=
resolver_rules=
while [ "$#" -gt 0 ]; do
  key=$1; shift
  [ "$#" -gt 0 ] || fail "browser runner option $key is missing a value"
  value=$1; shift
  case "$key" in
    --manifest) manifest=$value;; --lockfile) lockfile=$value;;
    --manifest-sha256) manifest_sha=$value;; --lock-sha256) lock_sha=$value;;
    --driver-version) driver=$value;; --server-port) server_port=$value;;
    --proxy-port) proxy_port=$value;; --max-clients) max_clients=$value;;
    --artifacts) artifacts=$value;;
    --engine) engine=$value;; --deadline-seconds) deadline=$value;; --ws-path) ws_path=$value;;
    --resolver-rule) resolver_rules="${resolver_rules}${resolver_rules:+
}${value}";;
    --allowed-host) allowed_hosts="${allowed_hosts}${allowed_hosts:+
}${value}";;
    *) fail "browser runner option $key is invalid";;
  esac
done
for value in "$manifest" "$lockfile" "$manifest_sha" "$lock_sha" "$driver" "$server_port" "$proxy_port" "$max_clients" "$artifacts" "$allowed_hosts" "$engine"; do
  [ -n "$value" ] || fail 'browser runner configuration is incomplete'
done
[ "$(sha256 "$manifest")" = "$manifest_sha" ] || fail 'browser project manifest digest differs'
[ "$(sha256 "$lockfile")" = "$lock_sha" ] || fail 'browser project lock digest differs'

workspace=$(mktemp -d)
cleanup() {
  rm -rf "$workspace"
}
trap cleanup EXIT HUP INT TERM
cp "$manifest" "$workspace/package.json"
cp "$lockfile" "$workspace/package-lock.json"
(cd "$workspace" && npm ci --ignore-scripts --no-audit --no-fund --loglevel=warn)
installed=$(node -e 'process.stdout.write(require(process.argv[1]).version)' "$workspace/node_modules/@playwright/test/package.json")
[ "$installed" = "$driver" ] || fail 'installed browser driver version differs'
mkdir -p "$artifacts"
case "$engine" in chromium|firefox|webkit) :;; *) fail 'browser runner engine is invalid';; esac
[ -z "$resolver_rules" ] || [ "$operation" = serve ] || [ "$engine" = chromium ] || fail 'foreground browser resolver rules require chromium'
if [ "$operation" = debugger ]; then
  case "$deadline" in ''|*[!0-9]*) fail 'browser debugger deadline is invalid';; esac
  [ "$deadline" -ge 1 ] && [ "$deadline" -le 14400 ] || fail 'browser debugger deadline is invalid'
else
  case "$ws_path" in /*) :;; *) fail 'browser runner websocket path is invalid';; esac
fi
BROWSER_ALLOWED_HOSTS=$allowed_hosts BROWSER_RESOLVER_RULES=$resolver_rules exec node - "$workspace/node_modules/playwright" "$operation" "$engine" "$deadline" "$artifacts" "$max_clients" "$workspace" "$server_port" "$proxy_port" "$ws_path" <<'NODE'
const fs = require('node:fs')
const net = require('node:net')
const [modulePath, operation, engine, deadline, artifactsPath, maxClients, workspace, serverPort, proxyPort, wsPath] = process.argv.slice(2)
const api = require(modulePath)
const browserType = api[engine]
if (!browserType || typeof browserType.launchServer !== 'function') throw new Error('browser runner engine is unavailable')
const handshakeDeadlineMs = 1000
let server, proxy, closing = false
const close = async status => {
  if (closing) return
  closing = true
  try { proxy?.close(); await server?.close() } finally { fs.rmSync(workspace, { recursive: true, force: true }); process.exit(status) }
}
process.once('SIGINT', () => close(130)); process.once('SIGTERM', () => close(143))
;(async () => {
  const resolverRules = process.env.BROWSER_RESOLVER_RULES ? process.env.BROWSER_RESOLVER_RULES.split('\n') : []
  const launch = { headless: operation === 'serve', host: '127.0.0.1', port: operation === 'serve' ? Number(serverPort) : 0, downloadsPath: artifactsPath }
  if (resolverRules.length && engine === 'chromium') launch.args = [`--host-resolver-rules=${resolverRules.join(',')}`]
  server = await browserType.launchServer(launch)
  const endpoint = new URL(server.wsEndpoint())
  const publicWsPath = wsPath || '/'
  if (endpoint.protocol !== 'ws:' || endpoint.hostname !== '127.0.0.1'
      || endpoint.username || endpoint.password || endpoint.search || endpoint.hash
      || !endpoint.pathname.startsWith('/') || endpoint.pathname === publicWsPath
      || operation === 'serve' && endpoint.port !== String(serverPort)) {
    throw new Error('browser server did not retain its loopback-only control listener')
  }
  const configuredHosts = [...new Set(process.env.BROWSER_ALLOWED_HOSTS.split('\n').map(value => value.toLowerCase()))]
  const debuggerHostnames = operation === 'debugger' ? configuredHosts.map(value => new URL(`http://${value}`).hostname) : []
  let clients = 0
  proxy = net.createServer(socket => {
    let counted = false
    let handshakeComplete = false
    let upstream
    let handshakeTimer
    const release = () => { if (counted) { counted = false; clients -= 1 } }
    const clearHandshakeTimer = () => { if (handshakeTimer) { clearTimeout(handshakeTimer); handshakeTimer = undefined } }
    const closeSocket = response => {
      handshakeComplete = true
      clearHandshakeTimer()
      release()
      socket.end(response, () => socket.destroy())
    }
    socket.on('error', () => { clearHandshakeTimer(); release(); upstream?.destroy(); socket.destroy() })
    socket.once('close', () => { clearHandshakeTimer(); release(); upstream?.destroy() })
    if (clients >= Number(maxClients)) { closeSocket('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return }
    clients += 1
    counted = true
    handshakeTimer = setTimeout(() => { release(); socket.destroy() }, handshakeDeadlineMs)
    handshakeTimer.unref()
    socket.once('end', () => { if (!handshakeComplete) { clearHandshakeTimer(); release(); socket.destroy() } })
    let buffered = Buffer.alloc(0)
    const onData = chunk => {
      buffered = Buffer.concat([buffered, chunk])
      if (buffered.length > 16384) { socket.off('data', onData); closeSocket('HTTP/1.1 431 Request Header Fields Too Large\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return }
      const end = buffered.indexOf('\r\n\r\n'); if (end < 0) return
      handshakeComplete = true
      clearHandshakeTimer()
      socket.off('data', onData)
      const lines = buffered.subarray(0, end).toString('latin1').split('\r\n')
      const headerValues = name => lines.slice(1).filter(line => new RegExp(`^${name}\\s*:`, 'i').test(line)).map(line => line.slice(line.indexOf(':') + 1).trim())
      const hosts = headerValues('host').map(value => value.toLowerCase())
      const address = proxy.address(); const allowed = new Set(operation === 'debugger' ? debuggerHostnames.map(host => `${host}:${address.port}`) : configuredHosts)
      const forbidden = () => closeSocket('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
      if (hosts.length !== 1 || !allowed.has(hosts[0]) || headerValues('origin').length) { forbidden(); return }
      const requestLine = lines[0]
      if (requestLine === 'GET / HTTP/1.1' && lines.length === 3 && headerValues('connection').length === 1
          && headerValues('connection')[0].toLowerCase() === 'close'
          && !headerValues('upgrade').length && !headerValues('sec-websocket-version').length && !headerValues('sec-websocket-key').length) {
        closeSocket('HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
        return
      }
      const upgrades = headerValues('upgrade')
      const connections = headerValues('connection')
      const versions = headerValues('sec-websocket-version')
      const keys = headerValues('sec-websocket-key')
      const connectionTokens = connections.length === 1 ? connections[0].split(',').map(value => value.trim().toLowerCase()) : []
      const validKey = keys.length === 1 && /^[A-Za-z0-9+/]{22}==$/.test(keys[0]) && Buffer.from(keys[0], 'base64').length === 16
      if (requestLine !== `GET ${publicWsPath} HTTP/1.1` || upgrades.length !== 1 || upgrades[0].toLowerCase() !== 'websocket'
          || connections.length !== 1 || !connectionTokens.includes('upgrade') || versions.length !== 1 || versions[0] !== '13' || !validKey) {
        forbidden()
        return
      }
      const requestLineEnd = buffered.indexOf('\r\n')
      const forwarded = Buffer.concat([Buffer.from(`GET ${endpoint.pathname} HTTP/1.1`, 'latin1'), buffered.subarray(requestLineEnd)])
      upstream = net.createConnection({ host: '127.0.0.1', port: Number(endpoint.port) }, () => upstream.write(forwarded))
      upstream.on('data', data => socket.write(data)); socket.on('data', data => upstream.write(data))
      upstream.on('end', () => socket.end()); socket.on('end', () => upstream.end())
      upstream.on('error', () => socket.destroy())
    }
    socket.on('data', onData)
  })
  await new Promise((resolve, reject) => { proxy.once('error', reject); proxy.listen(operation === 'serve' ? Number(proxyPort) : 0, operation === 'serve' ? '0.0.0.0' : '127.0.0.1', resolve) })
  const address = proxy.address()
  if (operation === 'debugger') process.stdout.write(`ws://${debuggerHostnames[0]}:${address.port}${publicWsPath}\n`)
  server.on('close', () => close(0))
  if (operation === 'debugger') setTimeout(() => close(0), Number(deadline) * 1000)
})().catch(error => { fs.rmSync(workspace, { recursive: true, force: true }); process.stderr.write(`${error.message}\n`); process.exit(1) })
NODE
