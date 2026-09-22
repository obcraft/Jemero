// A plain static file server on 127.0.0.1 with Range support. It publishes the
// built packs (packs-dist/) during development, the way a CDN or release host
// would, so the pack store's download, resume and verify path runs for real.
// The tests use it the same way.
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')

const TYPES = {
  '.json': 'application/json; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
}

/**
 * @param {string} root  folder to serve
 * @param {{ onRequest?: (req: http.IncomingMessage, res: http.ServerResponse) => boolean }} [hooks]
 *   onRequest may answer a request itself (tests use it to drop or corrupt one) and return true.
 * @returns {Promise<{ url: string, close: () => Promise<void> }>}
 */
function startStaticServer(root, hooks = {}) {
  const base = path.resolve(root)
  const server = http.createServer((req, res) => {
    if (hooks.onRequest?.(req, res)) return
    if (req.method !== 'GET' && req.method !== 'HEAD') return res.writeHead(405).end()
    const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '')
    const file = path.resolve(base, rel)
    if (file !== base && !file.startsWith(base + path.sep)) return res.writeHead(403).end()

    fs.stat(file, (err, stat) => {
      if (err || !stat.isFile()) return res.writeHead(404).end()
      const type = TYPES[path.extname(file)] ?? 'application/octet-stream'
      const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '')
      if (range) {
        const start = Number(range[1])
        const end = range[2] ? Math.min(Number(range[2]), stat.size - 1) : stat.size - 1
        if (start >= stat.size) return res.writeHead(416, { 'content-range': `bytes */${stat.size}` }).end()
        res.writeHead(206, {
          'content-type': type,
          'content-length': end - start + 1,
          'content-range': `bytes ${start}-${end}/${stat.size}`,
          'accept-ranges': 'bytes',
        })
        if (req.method === 'HEAD') return res.end()
        return fs.createReadStream(file, { start, end }).pipe(res)
      }
      res.writeHead(200, { 'content-type': type, 'content-length': stat.size, 'accept-ranges': 'bytes' })
      if (req.method === 'HEAD') return res.end()
      fs.createReadStream(file).pipe(res)
    })
  })

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () =>
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        close: () =>
          new Promise((r) => {
            server.closeAllConnections?.()
            server.close(() => r())
          }),
      }),
    )
  })
}

module.exports = { startStaticServer }
