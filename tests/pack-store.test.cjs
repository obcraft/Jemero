const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createPackStore } = require('../electron/pack-store.cjs')
const { startStaticServer } = require('../electron/static-server.cjs')
const { sign, verify, generateKeys } = require('../electron/pack-sign.cjs')
const { sha256 } = require('../electron/pack-format.cjs')

const keys = generateKeys()
const trust = { [keys.keyId]: keys.publicKeyDer }

/** Publish packs to a folder laid out like packs-dist/. `packs`: [{ id, version, files: { path: content } }] */
function publish(dir, packs, { key = keys.privateKeyPem } = {}) {
  const entries = packs.map(({ id, version, files, dependencies = [] }) => {
    const hashes = {}
    let bytes = 0
    for (const [rel, content] of Object.entries(files)) {
      const full = path.join(dir, id, version, 'files', ...rel.split('/'))
      fs.mkdirSync(path.dirname(full), { recursive: true })
      fs.writeFileSync(full, content)
      hashes[rel] = sha256(Buffer.from(content))
      bytes += Buffer.byteLength(content)
    }
    const js = Object.keys(files).filter((f) => f.endsWith('.js'))
    const pack = {
      formatVersion: 1,
      id,
      version,
      name: id.toUpperCase(),
      category: 'components',
      kind: 'local',
      offline: true,
      size: { download: bytes, installed: bytes },
      dependencies,
      imports: Object.fromEntries(js.map((f) => [js.length === 1 ? id : `${id}/${f}`, f])),
      exports: Object.fromEntries(js.map((f) => [js.length === 1 ? id : `${id}/${f}`, ['default']])),
      assets: Object.keys(files)
        .filter((f) => !f.endsWith('.js'))
        .map((f) => ({ path: f, type: f.endsWith('.css') ? 'text/css' : 'font/woff2' })),
      files: hashes,
    }
    fs.writeFileSync(path.join(dir, id, version, 'manifest.signed.json'), JSON.stringify(sign(pack, key)))
    return pack
  })
  fs.writeFileSync(path.join(dir, 'index.signed.json'), JSON.stringify(sign({ formatVersion: 1, packs: entries }, key)))
  return entries
}

async function setup(hooks) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jemero-store-'))
  const dist = path.join(tmp, 'dist')
  const root = path.join(tmp, 'packs')
  fs.mkdirSync(dist)
  const server = await startStaticServer(dist, hooks)
  const store = (extra = {}) => createPackStore({ root, sourceUrl: server.url, trust, freeBytes: async () => 1e12, ...extra })
  return {
    dist,
    root,
    server,
    store,
    async done() {
      await server.close()
      fs.rmSync(tmp, { recursive: true, force: true })
    },
  }
}

const BIG = 'x'.repeat(256 * 1024)
const v1 = { id: 'demo', version: '1.0.0', files: { 'demo.js': 'export default 1', 'demo.css': '.a{}', 'fonts/a.woff2': 'font-1' } }
const v2 = { id: 'demo', version: '2.0.0', files: { 'demo.js': 'export default 2', 'demo.css': '.b{}', 'fonts/a.woff2': BIG } }

test('a pack installs, verifies and activates under the store root', async () => {
  const t = await setup()
  try {
    publish(t.dist, [v1])
    const events = []
    const res = await t.store().install('demo', (e) => events.push(e))
    assert.deepEqual(res, { ok: true })
    assert.equal(events[0].phase, 'checking')
    assert.ok(events[0].required > 0)
    assert.ok(events.some((e) => e.phase === 'downloading' && e.received > 0 && e.total > 0))
    assert.equal(events.at(-1).phase, 'done')
    const store = t.store()
    assert.equal((await store.installed()).demo.version, '1.0.0')
    assert.equal(fs.readFileSync(path.join(store.packDir('demo', '1.0.0'), 'files', 'fonts', 'a.woff2'), 'utf8'), 'font-1')
    assert.deepEqual(await store.verifyInstalled('demo'), [])
    assert.ok(!fs.existsSync(path.join(t.root, '.staging', 'demo@1.0.0')))
  } finally {
    await t.done()
  }
})

test('an interrupted download resumes with Range and leaves the previous version active meanwhile', async () => {
  let cut = true
  const ranges = []
  const t = await setup({
    onRequest(req, res) {
      if (req.headers.range) ranges.push(req.headers.range)
      // First request for the big font: send half, then drop the connection.
      if (cut && req.url.endsWith('/2.0.0/files/fonts/a.woff2')) {
        cut = false
        res.writeHead(200, { 'content-length': BIG.length })
        res.write(BIG.slice(0, BIG.length / 2), () => res.destroy())
        return true
      }
      return false
    },
  })
  try {
    publish(t.dist, [v1])
    await t.store().install('demo')
    publish(t.dist, [v2])

    const store = t.store()
    const res = await store.install('demo')
    assert.deepEqual(res, { ok: true })
    assert.ok(ranges.some((r) => /^bytes=\d+-$/.test(r) && r !== 'bytes=0-'), 'resumed with a Range request')
    const active = (await store.installed()).demo
    assert.equal(active.version, '2.0.0')
    assert.equal(active.previous, '1.0.0')
    assert.ok(fs.existsSync(store.packDir('demo', '1.0.0')), 'previous version kept')
  } finally {
    await t.done()
  }
})

test('a corrupt file fails with a clear error and the previous version stays usable', async () => {
  const t = await setup({
    onRequest(req, res) {
      if (req.url.endsWith('/2.0.0/files/demo.js')) {
        res.writeHead(200).end('export default "evil"')
        return true
      }
      return false
    },
  })
  try {
    publish(t.dist, [v1])
    await t.store().install('demo')
    publish(t.dist, [v2])
    const store = t.store()
    const events = []
    const res = await store.install('demo', (e) => events.push(e))
    assert.equal(res.ok, false)
    assert.match(res.reason, /demo\.js arrived corrupted twice/)
    assert.equal(events.at(-1).phase, 'error')
    assert.equal((await store.installed()).demo.version, '1.0.0')
    assert.deepEqual(await store.verifyInstalled('demo'), [])
    assert.ok(!fs.existsSync(store.packDir('demo', '2.0.0')), 'nothing half-installed was activated')
  } finally {
    await t.done()
  }
})

test('a manifest or index signed by an unknown key is refused', async () => {
  const t = await setup()
  try {
    publish(t.dist, [v1], { key: generateKeys().privateKeyPem })
    const res = await t.store().install('demo')
    assert.equal(res.ok, false)
    assert.match(res.reason, /unknown key/)
    assert.deepEqual(await t.store().installed(), {})

    // Signed correctly, then edited: the signature no longer covers it.
    publish(t.dist, [v1])
    const file = path.join(t.dist, 'index.signed.json')
    const env = JSON.parse(fs.readFileSync(file, 'utf8'))
    env.payload = env.payload.replace('"DEMO"', '"EVIL"')
    fs.writeFileSync(file, JSON.stringify(env))
    assert.match((await t.store().install('demo')).reason, /signature does not match/)
  } finally {
    await t.done()
  }
})

test('not enough disk space is reported before anything is downloaded', async () => {
  const t = await setup()
  try {
    publish(t.dist, [v1])
    const res = await t.store({ freeBytes: async () => 5 }).install('demo')
    assert.equal(res.ok, false)
    assert.match(res.reason, /Needs .* of free disk space; only .* is available/)
    assert.ok(!fs.existsSync(path.join(t.root, '.staging')))
  } finally {
    await t.done()
  }
})

test('cancelling keeps the partial download for the next attempt', async () => {
  let release
  const gate = new Promise((r) => (release = r))
  const t = await setup({
    onRequest(req, res) {
      if (req.url.endsWith('/1.0.0/files/fonts/a.woff2') && release) {
        const go = release
        release = null
        res.writeHead(200)
        res.write('fo')
        go()
        return true // never finishes; the cancel ends it
      }
      return false
    },
  })
  try {
    publish(t.dist, [v1])
    const store = t.store()
    const pending = store.install('demo')
    await gate
    assert.equal(store.cancel('demo'), true)
    const res = await pending
    assert.equal(res.cancelled, true)
    assert.deepEqual(await store.installed(), {})
    assert.ok(fs.existsSync(path.join(t.root, '.staging', 'demo@1.0.0')), 'staging kept for resume')
    assert.deepEqual(await store.install('demo'), { ok: true })
  } finally {
    await t.done()
  }
})

test('dependencies install first, and the index is cached for offline listing', async () => {
  const t = await setup()
  try {
    publish(t.dist, [{ id: 'base', version: '1.0.0', files: { 'base.js': 'export default 0' } }, { ...v1, dependencies: ['base'] }])
    const store = t.store()
    assert.deepEqual(await store.install('demo'), { ok: true })
    assert.deepEqual(Object.keys(await store.installed()).sort(), ['base', 'demo'])

    await t.server.close()
    const offline = await t.store().catalog()
    assert.equal(offline.fromCache, true)
    assert.deepEqual(offline.catalog.packs.map((p) => p.id), ['base', 'demo'])
    assert.equal(verify(JSON.parse(fs.readFileSync(path.join(t.root, 'catalog.signed.json'), 'utf8')), trust).packs.length, 2)
  } finally {
    await t.done()
  }
})

test('removing a pack deletes it and its staging', async () => {
  const t = await setup()
  try {
    publish(t.dist, [v1])
    const store = t.store()
    await store.install('demo')
    assert.deepEqual(await store.remove('demo'), { ok: true })
    assert.deepEqual(await store.installed(), {})
    assert.ok(!fs.existsSync(path.join(t.root, 'demo')))
  } finally {
    await t.done()
  }
})
