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
 * /llm/* -> the model server's /v1/*, streamed through as it arrives.
 *
 * When the page stops reading (Stop, a reload, a closed window) the upstream
 * request is aborted as well: that disconnect is what tells llama-server to stop
 * generating. Without it the GPU kept writing an answer nobody would read, and
 * the next request queued behind it.
 */
async function proxyModel(req, res) {
  const upstreamAbort = new AbortController()
  res.on('close', () => upstreamAbort.abort())
  try {
    const upstream = await fetch(`${URL_BASE}/v1${req.url.slice('/llm'.length)}`, {
      method: req.method,
      headers: { 'content-type': req.headers['content-type'] ?? 'application/json' },
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : req,
      duplex: 'half',
      signal: upstreamAbort.signal,
    })
    res.writeHead(upstream.status, {
      'content-type': upstream.headers.get('content-type') ?? 'application/json',
      'cache-control': 'no-cache',
    })
    if (upstream.body) for await (const chunk of upstream.body) res.write(chunk)
    res.end()
  } catch (err) {
    // The page went away first: there is no one left to tell.
    if (upstreamAbort.signal.aborted) return
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: String(err) } }))
  }
}

/** A file from the bundle, with the app's HTML for any other route. */
function serveStatic(root, req, res) {
  let urlPath
  try {
    urlPath = decodeURIComponent(req.url.split('?')[0])
  } catch {
    res.writeHead(400).end()
    return
  }
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '')
  const file = path.resolve(root, rel)
  // Never serve outside the bundle (a sibling folder that merely shares its prefix included).
  if (!file.startsWith(root + path.sep)) {
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
      fs.readFile(path.join(root, 'index.html'), (e2, html) => (e2 ? res.writeHead(404).end() : send(html, TYPES['.html'])))
      return
    }
    send(data, TYPES[path.extname(file)] ?? 'application/octet-stream')
  })
}

/**
 * @param {string} dist  the built dist/
 * @param {{ packRoutes?: { handle(req, res): Promise<boolean> } }} [opts]
 *   installed packs, under /packs (electron/pack-routes.cjs)
 */
function startServer(dist, { packRoutes } = {}) {
  const root = path.resolve(dist)
  const handle = async (req, res) => {
    // Installed packs, verified files only.
    if (packRoutes && (await packRoutes.handle(req, res))) return
    if (req.url === '/llm' || req.url.startsWith('/llm/')) return proxyModel(req, res)
    serveStatic(root, req, res)
  }
  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      console.error('[serve]', req.url, err.message)
      if (!res.headersSent) res.writeHead(500)
      res.end()
    })
  })

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`))
  })
}

module.exports = { startServer }
