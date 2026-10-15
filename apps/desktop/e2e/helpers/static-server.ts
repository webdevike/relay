import * as fs from 'node:fs'
import * as http from 'node:http'
import * as path from 'node:path'
import type { AddressInfo } from 'node:net'

const PAGES = path.join(__dirname, '..', 'fixtures', 'pages')
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.json': 'application/json',
}

export interface StaticServer {
  port: number
  url(p?: string): string
  close(): Promise<void>
}

/** Serves e2e/fixtures/pages on 127.0.0.1 with an ephemeral port; `/` is a.html. */
export async function startStaticServer(): Promise<StaticServer> {
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
    const name = pathname === '/' ? 'a.html' : path.basename(pathname)
    const file = path.join(PAGES, name)
    if (!file.startsWith(PAGES) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('not found')
      return
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' })
    fs.createReadStream(file).pipe(res)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as AddressInfo).port
  return {
    port,
    url: (p = '/') => `http://127.0.0.1:${port}${p}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  }
}
