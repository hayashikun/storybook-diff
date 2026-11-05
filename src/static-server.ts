import { createReadStream } from 'node:fs'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { createServer } from 'node:http'
import { extname, join, normalize, resolve, sep } from 'node:path'

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
}

export type StaticHandlerOptions = {
  /** Disable caching, for files rewritten and re-read at the same path (re-shot images etc.) */
  noStore?: boolean
}

/** Request handler that serves files under rootDir (with directory traversal protection) */
export function createStaticHandler(
  rootDir: string,
  options: StaticHandlerOptions = {},
): (req: IncomingMessage, res: ServerResponse) => void {
  const root = resolve(rootDir)
  return (req, res) => {
    try {
      const rawPath = decodeURIComponent((req.url ?? '/').split('?')[0])
      const relPath = rawPath === '/' ? '/index.html' : rawPath
      const filePath = normalize(join(root, relPath))
      if (!filePath.startsWith(root + sep) && filePath !== root) {
        res.statusCode = 403
        res.end('forbidden')
        return
      }
      res.setHeader(
        'content-type',
        MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
      )
      if (options.noStore) res.setHeader('cache-control', 'no-store')
      const stream = createReadStream(filePath)
      stream.on('error', () => {
        res.statusCode = 404
        res.end('not found')
      })
      stream.pipe(res)
    } catch {
      res.statusCode = 500
      res.end('error')
    }
  }
}

/** Serves rootDir on a free port on 127.0.0.1 */
export async function startStaticServer(
  rootDir: string,
  options: StaticHandlerOptions = {},
): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer(createStaticHandler(rootDir, options))
  await new Promise<void>((res) => server.listen(0, '127.0.0.1', res))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return { server, baseUrl: `http://127.0.0.1:${port}` }
}
