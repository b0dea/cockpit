import { createServer } from 'node:http'

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

// Closing on SIGTERM lets `cockpit sleep` and `down` stop the service without waiting out the grace.
process.on('SIGTERM', () => server.close(() => process.exit(0)))
