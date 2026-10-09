import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(fileURLToPath(new URL('../out/', import.meta.url)))
const port = Number(process.env.PORT ?? 3000)
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
}

await stat(path.join(root, 'index.html'))
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? '/', 'http://localhost')
    let file = path.resolve(root, `.${decodeURIComponent(url.pathname)}`)
    if (!file.startsWith(`${root}${path.sep}`) && file !== root) {
      response.writeHead(403).end()
      return
    }
    if ((await stat(file)).isDirectory()) {
      if (!url.pathname.endsWith('/')) {
        response.writeHead(308, { Location: `${url.pathname}/${url.search}` }).end()
        return
      }
      file = path.join(file, 'index.html')
    }
    response.writeHead(200, {
      'Content-Type': types[path.extname(file)] ?? 'application/json',
      'Cache-Control': 'no-store',
    })
    response.end(request.method === 'HEAD' ? undefined : await readFile(file))
  } catch {
    response.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' })
    response.end(await readFile(path.join(root, '404.html')).catch(() => 'Not found'))
  }
})
server.listen(port, '127.0.0.1', () => {
  console.log(`Static docs preview: http://localhost:${server.address().port}`)
})
