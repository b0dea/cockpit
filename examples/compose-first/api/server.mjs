import { createServer } from 'node:http'

createServer((request, response) => {
    const healthy = request.url === '/health'
    response.writeHead(healthy || request.url === '/items' ? 200 : 404, { 'content-type': 'application/json' })
    response.end(JSON.stringify(healthy ? { ok: true } : request.url === '/items' ? ['synthetic'] : { error: 'not found' }))
}).listen(3000)
