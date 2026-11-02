import { createServer } from 'node:http'

// Two small pages give the browser variant (cockpit.browser.toml) routes to drive and capture.
const pages = {
    '/': '<!doctype html><html lang="en"><head><title>Tiny api</title></head><body><main><h1>Tiny api</h1><a href="/about">About</a></main></body></html>',
    '/about': '<!doctype html><html lang="en"><head><title>About</title></head><body><main><h1>About the tiny api</h1></main></body></html>',
}

const server = createServer((request, response) => {
    if (request.url === '/health') {
        response.writeHead(200, { 'content-type': 'text/plain' })
        return response.end('ok\n')
    }
    const page = pages[request.url]
    response.writeHead(page ? 200 : 404, { 'content-type': page ? 'text/html' : 'text/plain' })
    response.end(page ?? 'not found\n')
}).listen(3000)

// The generated entrypoint execs this command, so node runs as PID 1, which ignores SIGTERM unless
// it is handled; without this, `cockpit sleep` and `down` wait out the full stop grace.
process.on('SIGTERM', () => server.close(() => process.exit(0)))
