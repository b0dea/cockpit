import { createServer } from 'node:http'

createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' })
    response.end(request.url === '/health' ? 'ok\n' : 'synthetic web front end\n')
}).listen(3000)
