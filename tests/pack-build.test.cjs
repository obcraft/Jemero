const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { verify } = require('../electron/pack-sign.cjs')
const { validatePack } = require('../electron/pack-format.cjs')
const { createPackStore } = require('../electron/pack-store.cjs')
const { startStaticServer } = require('../electron/static-server.cjs')

const checks = import('../scripts/pack-checks.mjs')
const DIST = path.join(__dirname, '..', 'packs-dist')

test('remote resources are caught; links in text and namespaces are not', async () => {
  const { findRemoteRefs } = await checks
  const hits = (text, type) => findRemoteRefs(text, type).map((f) => f.what)
  assert.deepEqual(hits('import x from "https://cdn.example.com/x.js"', 'js'), ['module import from a URL'])
  assert.deepEqual(hits('await import("//esm.sh/react")', 'js'), ['dynamic import from a URL'])
  assert.deepEqual(hits('fetch("https://api.example.com/data")', 'js'), ['fetch of a URL'])
  assert.deepEqual(hits('img.src = "https://images.example.com/a.png"', 'js'), ['remote src assigned'])
  assert.deepEqual(hits('"<img src=\\"https://x.com/a.png\\">"', 'js'), ['remote src in markup'])
  assert.deepEqual(hits('@import url("https://fonts.googleapis.com/css2?family=Inter");', 'css'), ['remote url()', 'remote @import'])
  assert.deepEqual(hits('@font-face{src:url(https://fonts.gstatic.com/a.woff2)}', 'css'), ['remote url()'])
  assert.deepEqual(hits('const ns = "http://www.w3.org/2000/svg"; // see https://katex.org/docs', 'js'), [])
  assert.deepEqual(hits('@font-face{src:url(fonts/a.woff2)}', 'css'), [])
})

test('a bundled copy of React is detected', async () => {
  const { bundlesReact } = await checks
  assert.equal(bundlesReact('exports.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE = {}'), true)
  assert.equal(bundlesReact('import { useState } from "react"'), false)
})

test('fonts are reduced to woff2 and every CSS url is listed', async () => {
  const { woff2Only, cssUrls } = await checks
  const css = '@font-face{font-family:A;src:url(fonts/a.woff2) format("woff2"),url(fonts/a.woff) format("woff"),url(fonts/a.ttf) format("truetype")}'
  const out = woff2Only(css)
  assert.equal(out, '@font-face{font-family:A;src:url(fonts/a.woff2) format("woff2")}')
  assert.deepEqual(cssUrls(out), ['fonts/a.woff2'])
  assert.deepEqual(cssUrls('a{background:url("data:image/png;base64,AAA")}'), [])
})

const built = fs.existsSync(path.join(DIST, 'index.signed.json'))

test('the KaTeX example pack is complete: JS, CSS and local fonts, signed', { skip: !built && 'run `npm run packs` first' }, () => {
  const index = verify(JSON.parse(fs.readFileSync(path.join(DIST, 'index.signed.json'), 'utf8')))
  const katex = index.packs.find((p) => p.id === 'katex')
  assert.ok(katex, 'katex is in the index')
  assert.deepEqual(validatePack(katex), [])
  assert.deepEqual(Object.keys(katex.imports), ['katex'])
  assert.ok(katex.exports.katex.includes('renderToString'))
  assert.ok(katex.assets.some((a) => a.type === 'text/css'))
  assert.ok(katex.assets.filter((a) => a.type === 'font/woff2').length >= 10)
  const css = fs.readFileSync(path.join(DIST, 'katex', katex.version, 'files', 'katex.css'), 'utf8')
  for (const m of css.matchAll(/url\(([^)]+)\)/g)) {
    assert.ok(katex.files[m[1]], `${m[1]} is shipped in the pack`)
  }
})

test('the KaTeX pack installs end to end from a local publish', { skip: !built && 'run `npm run packs` first' }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jemero-katex-'))
  const server = await startStaticServer(DIST)
  try {
    const store = createPackStore({ root: tmp, sourceUrl: server.url })
    const phases = new Set()
    const res = await store.install('katex', (e) => phases.add(e.phase))
    assert.deepEqual(res, { ok: true })
    assert.deepEqual([...phases], ['checking', 'downloading', 'verifying', 'activating', 'done'])
    assert.deepEqual(await store.verifyInstalled('katex'), [])
  } finally {
    await server.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})
