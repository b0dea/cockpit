import { createServer } from 'node:http'

createServer((request, response) => {
    response.writeHead(request.url === '/health' ? 200 : 404, { 'content-type': 'text/plain' })
    response.end(request.url === '/health' ? 'ok\n' : 'not found\n')
}).listen(3000)
