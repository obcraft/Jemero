const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const { createPackStore } = require('../electron/pack-store.cjs')
const { createPackRoutes } = require('../electron/pack-routes.cjs')
const { startStaticServer } = require('../electron/static-server.cjs')
const { isLocal } = require('../electron/net-guard.cjs')
const { sign, generateKeys } = require('../electron/pack-sign.cjs')
const { sha256 } = require('../electron/pack-format.cjs')

const keys = generateKeys()
const trust = { [keys.keyId]: keys.publicKeyDer }

function publish(dir, id, version, files) {
  const hashes = {}
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, id, version, 'files', ...rel.split('/'))
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, content)
    hashes[rel] = sha256(Buffer.from(content))
  }
  const bytes = Object.values(files).reduce((n, c) => n + Buffer.byteLength(c), 0)
  const pack = {
    formatVersion: 1,
    id,
    version,
    name: 'Math',
    description: 'Formulas.',
    category: 'components',
    kind: 'local',
    offline: true,
    size: { download: bytes, installed: bytes },
    dependencies: [],
    imports: { [id]: `${id}.js` },
    exports: { [id]: ['default', 'renderToString'] },
    assets: [
      { path: `${id}.css`, type: 'text/css' },
      { path: 'fonts/a.woff2', type: 'font/woff2' },
    ],
    files: hashes,
  }
  fs.writeFileSync(path.join(dir, id, version, 'manifest.signed.json'), JSON.stringify(sign(pack, keys.privateKeyPem)))
  fs.writeFileSync(path.join(dir, 'index.signed.json'), JSON.stringify(sign({ formatVersion: 1, packs: [pack] }, keys.privateKeyPem)))
}

async function setup() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jemero-routes-'))
  const dist = path.join(tmp, 'dist')
  fs.mkdirSync(dist)
  const source = await startStaticServer(dist)
  const store = createPackStore({ root: path.join(tmp, 'packs'), sourceUrl: source.url, trust, freeBytes: async () => 1e12 })
  const routes = createPackRoutes(store)
  const app = http.createServer((req, res) => routes.handle(req, res).then((h) => h || res.writeHead(404).end('app')))
  await new Promise((r) => app.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${app.address().port}`
  return {
    tmp,
    dist,
    store,
    routes,
    url,
    get: (p) => fetch(url + p),
    async done() {
      await source.close()
      app.closeAllConnections()
      await new Promise((r) => app.close(r))
      fs.rmSync(tmp, { recursive: true, force: true })
    },
  }
}

const FILES = { 'math.js': 'export default 1; export const renderToString = () => ""', 'math.css': '.m{}', 'fonts/a.woff2': 'woff2' }

test('an activated pack appears in the combined manifest and its files are served with CORS', async () => {
  const t = await setup()
  try {
    publish(t.dist, 'math', '1.0.0', FILES)
    assert.deepEqual(await t.store.install('math'), { ok: true })
    await t.routes.rebuild()

    const res = await t.get('/packs/manifest.json')
    assert.equal(res.headers.get('access-control-allow-origin'), '*')
    const m = await res.json()
    assert.equal(m.packs.math.version, '1.0.0')
    assert.equal(m.imports.math, '/packs/math/1.0.0/files/math.js')
    assert.deepEqual(m.styles.math, ['/packs/math/1.0.0/files/math.css'])
    assert.deepEqual(m.packs.math.exports.math, ['default', 'renderToString'])

    const js = await t.get(m.imports.math)
    assert.equal(js.status, 200)
    assert.match(js.headers.get('content-type'), /javascript/)
    assert.equal(js.headers.get('access-control-allow-origin'), '*')
    assert.equal(await js.text(), FILES['math.js'])
    assert.equal((await t.get('/packs/math/1.0.0/files/fonts/a.woff2')).headers.get('content-type'), 'font/woff2')
  } finally {
    await t.done()
  }
})

test('only listed files of active packs are served; traversal and other paths are not', async () => {
  const t = await setup()
  try {
    publish(t.dist, 'math', '1.0.0', FILES)
    await t.store.install('math')
    await t.routes.rebuild()
    for (const p of [
      '/packs/math/1.0.0/manifest.signed.json',
      '/packs/math/1.0.0/files/../manifest.signed.json',
      '/packs/math/1.0.0/files/%2e%2e/manifest.signed.json',
      '/packs/math/0.9.0/files/math.js',
      '/packs/installed.json',
      '/packs/../installed.json',
    ]) {
      assert.equal((await t.get(p)).status, 404, p)
    }
    assert.equal(await (await t.get('/kits/stage.html')).text(), 'app', 'not a pack route: left to the app')
  } finally {
    await t.done()
  }
})

test('a file changed on disk after verification is refused, and the pack leaves the manifest', async () => {
  const t = await setup()
  try {
    publish(t.dist, 'math', '1.0.0', FILES)
    await t.store.install('math')
    await t.routes.rebuild()
    fs.writeFileSync(path.join(t.store.packDir('math', '1.0.0'), 'files', 'math.js'), 'fetch("https://evil.example")')
    assert.equal((await t.get('/packs/math/1.0.0/files/math.js')).status, 409)
    await t.routes.manifest()
    const m = await (await t.get('/packs/manifest.json')).json()
    assert.equal(m.packs.math, undefined)
    assert.equal(m.imports.math, undefined)
    assert.match(m.problems.math[0], /does not match its hash/)
  } finally {
    await t.done()
  }
})

test('after an update the new version is served; the previous one stays on disk for rollback', async () => {
  const t = await setup()
  try {
    publish(t.dist, 'math', '1.0.0', FILES)
    await t.store.install('math')
    publish(t.dist, 'math', '2.0.0', { ...FILES, 'math.js': 'export default 2; export const renderToString = () => "2"' })
    await t.store.install('math')
    await t.routes.rebuild()
    const m = await (await t.get('/packs/manifest.json')).json()
    assert.equal(m.imports.math, '/packs/math/2.0.0/files/math.js')
    assert.equal((await t.get('/packs/math/1.0.0/files/math.js')).status, 404, 'inactive version not served')
    assert.ok(fs.existsSync(t.store.packDir('math', '1.0.0')), 'previous version kept for rollback')
  } finally {
    await t.done()
  }
})

test('the preview boundary treats only loopback and local schemes as local', () => {
  for (const u of ['http://127.0.0.1:5273/kits/stage.html', 'http://localhost:8757/v1/models', 'blob:http://127.0.0.1/x', 'data:image/png;base64,AA']) {
    assert.equal(isLocal(u), true, u)
  }
  for (const u of ['https://fonts.googleapis.com/css', 'https://cdn.jsdelivr.net/npm/x', 'http://192.168.1.10/', 'https://127.0.0.1.evil.com/']) {
    assert.equal(isLocal(u), false, u)
  }
})
