// Serves installed packs to the canvas, from loopback only.
//
//   GET /packs/manifest.json                     every active pack: imports, exports, styles
//   GET /packs/<id>/<version>/files/<path>       one file of an active pack
//
// Narrow on purpose. The routing table is built from the signed manifests of
// active packs (rebuild()), so a request can only name a file some verified
// pack lists: no path is ever joined from the URL, and "..", other folders or
// an inactive version are simply not in the table. Each file is hashed again
// before it is sent, so a file changed on disk after activation is refused.
//
// The canvas runs in a sandboxed iframe with an opaque origin, so modules and
// fonts load cross-origin and need CORS.
const fsp = require('node:fs/promises')
const path = require('node:path')
const { sha256, FORMAT_VERSION } = require('./pack-format.cjs')

const TYPES = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
}

const CORS = { 'access-control-allow-origin': '*' }

function createPackRoutes(store) {
  let table = new Map() // url path -> { file, hash }
  let combined = { formatVersion: FORMAT_VERSION, packs: {}, imports: {}, styles: {}, problems: {} }
  let building = null

  /** Re-read and re-verify every active pack. Call after an install or a removal. */
  function rebuild() {
    building = (async () => {
      const next = new Map()
      const out = { formatVersion: FORMAT_VERSION, packs: {}, imports: {}, styles: {}, problems: {} }
      for (const [id, active] of Object.entries(await store.installed())) {
        let loaded
        try {
          const problems = await store.verifyInstalled(id)
          if (problems.length) throw new Error(problems[0])
          loaded = await store.activeManifest(id)
        } catch (err) {
          // Not served at all: a pack with one bad file is a pack the canvas can't trust.
          out.problems[id] = [err.message]
          continue
        }
        const { manifest, filesDir } = loaded
        const base = `/packs/${id}/${active.version}/files/`
        for (const [rel, hash] of Object.entries(manifest.files)) {
          next.set(base + rel, { file: path.join(filesDir, ...rel.split('/')), hash })
        }
        const css = manifest.assets.filter((a) => a.type === 'text/css').map((a) => base + a.path)
        for (const [spec, rel] of Object.entries(manifest.imports)) {
          out.imports[spec] = base + rel
          if (css.length) out.styles[spec] = css
        }
        out.packs[id] = {
          version: manifest.version,
          name: manifest.name,
          description: manifest.description ?? '',
          category: manifest.category,
          dependencies: manifest.dependencies,
          imports: manifest.imports,
          exports: manifest.exports,
          assets: manifest.assets,
        }
      }
      table = next
      combined = out
      return out
    })()
    return building
  }

  async function manifest() {
    if (building) await building.catch(() => {})
    return combined
  }

  /** Answers /packs/… requests; returns false for anything else so the caller serves it. */
  async function handle(req, res) {
    const url = (req.url ?? '').split('?')[0]
    if (!url.startsWith('/packs/')) return false
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, CORS).end()
      return true
    }
    if (building) await building.catch(() => {})

    if (url === '/packs/manifest.json') {
      res.writeHead(200, { ...CORS, 'content-type': TYPES['.json'], 'cache-control': 'no-store' })
      res.end(req.method === 'HEAD' ? undefined : JSON.stringify(combined))
      return true
    }

    let key
    try {
      key = decodeURIComponent(url)
    } catch {
      res.writeHead(400, CORS).end()
      return true
    }
    const entry = table.get(key)
    if (!entry) {
      res.writeHead(404, CORS).end()
      return true
    }
    let buf
    try {
      buf = await fsp.readFile(entry.file)
    } catch {
      res.writeHead(404, CORS).end()
      return true
    }
    if (sha256(buf) !== entry.hash) {
      // Changed since it was verified: refuse, and take the pack out until it's reinstalled.
      res.writeHead(409, { ...CORS, 'content-type': 'text/plain; charset=utf-8' }).end('This pack file failed its integrity check.')
      void rebuild()
      return true
    }
    res.writeHead(200, {
      ...CORS,
      'content-type': TYPES[path.extname(entry.file)] ?? 'application/octet-stream',
      'content-length': buf.length,
      // The path carries the version, so the bytes behind it never change.
      'cache-control': 'public, max-age=31536000, immutable',
    })
    res.end(req.method === 'HEAD' ? undefined : buf)
    return true
  }

  return { handle, rebuild, manifest }
}

module.exports = { createPackRoutes }
