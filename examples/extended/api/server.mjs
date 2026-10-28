import { createServer } from 'node:http'

createServer((request, response) => {
    response.writeHead(request.url === '/health' ? 200 : 404)
    response.end()
}).listen(3000)
