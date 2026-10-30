import { createServer } from 'node:http'

const server = createServer((request, response) => {
    response.writeHead(request.url === '/health' ? 200 : 404, { 'content-type': 'text/plain' })
    response.end(request.url === '/health' ? 'ok\n' : 'not found\n')
}).listen(3000)

// The generated entrypoint execs this command, so node runs as PID 1, which ignores SIGTERM unless
// it is handled; without this, `cockpit sleep` and `down` wait out the full stop grace.
process.on('SIGTERM', () => server.close(() => process.exit(0)))
