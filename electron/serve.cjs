// Production server for the packaged app: serves the built dist/, including the
// canvas and its kit bundles under /kits, and proxies /llm to the local model,
// the same things vite.config.ts does in development.
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const { URL_BASE } = require('./model.cjs')

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
}

/**
 * @param {string} root  the built dist/
 * @param {{ packRoutes?: { handle(req, res): Promise<boolean> } }} [opts]
 *   installed packs, under /packs (electron/pack-routes.cjs)
 */
function startServer(root, { packRoutes } = {}) {
  const server = http.createServer(async (req, res) => {
    // --- installed packs, verified files only ----------------------------
    if (packRoutes && (await packRoutes.handle(req, res))) return

    // --- LLM proxy -------------------------------------------------------
    if (req.url.startsWith('/llm')) {
      const target = `${URL_BASE}/v1${req.url.slice(4)}`
      try {
        const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : req
        const upstream = await fetch(target, {
          method: req.method,
          headers: { 'content-type': req.headers['content-type'] ?? 'application/json' },
          body,
          duplex: 'half',
        })
        res.writeHead(upstream.status, {
          'content-type': upstream.headers.get('content-type') ?? 'application/json',
          'cache-control': 'no-cache',
        })
        if (upstream.body) {
          const reader = upstream.body.getReader()
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            res.write(value)
          }
        }
        res.end()
      } catch (err) {
        res.writeHead(502, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: String(err) } }))
      }
      return
    }

    // --- static ----------------------------------------------------------
    const urlPath = decodeURIComponent(req.url.split('?')[0])
    const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '')
    const file = path.join(root, rel)
    // Never serve outside the bundle.
    if (!file.startsWith(root)) {
      res.writeHead(403).end()
      return
    }

    // The canvas runs in a sandboxed iframe with an opaque origin, so to it the
    // kit bundles are cross-origin, and module scripts need CORS to load.
    const kits = rel.startsWith('kits/')

    fs.readFile(file, (err, data) => {
      const send = (buf, type) =>
        res.writeHead(200, { 'content-type': type, ...(kits ? { 'access-control-allow-origin': '*' } : {}) }).end(buf)

      if (err) {
        // A missing module must fail as a 404, not come back as the app's HTML.
        if (kits) return res.writeHead(404).end()
        // SPA fallback
        fs.readFile(path.join(root, 'index.html'), (e2, html) =>
          e2 ? res.writeHead(404).end() : send(html, TYPES['.html']),
        )
        return
      }
      send(data, TYPES[path.extname(file)] ?? 'application/octet-stream')
    })
  })

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`))
  })
}

module.exports = { startServer }
