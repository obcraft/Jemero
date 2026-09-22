#!/usr/bin/env node
// Builds the downloadable packs into packs-dist/, signed, ready to publish.
//
//   npm run packs          build every pack in PACKS
//
// Runs on a developer's machine or in CI, never on a user's Mac: the app only
// downloads what this produces. Output, per pack:
//
//   packs-dist/index.signed.json                   the catalog of every pack
//   packs-dist/<id>/<version>/manifest.signed.json the pack's own manifest
//   packs-dist/<id>/<version>/files/…              modules, CSS, fonts
//
// Signing needs the Ed25519 private key: JEMERO_PACK_SIGNING_KEY (the PEM text,
// for CI) or .keys/pack-signing.pem (made by `npm run packs:keygen`). Its public
// half must be in electron/pack-trust.json, or the app will refuse the packs.
//
// Every pack imports the base kit's modules (React above all) as externals
// instead of bundling them, so the canvas keeps a single React; the build fails
// if a pack contains one anyway, or refers to anything on a CDN.
import { build } from 'esbuild'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { findRemoteRefs, bundlesReact, cssUrls, woff2Only } from './pack-checks.mjs'

const require = createRequire(import.meta.url)
const { validatePack, validateCatalog, sha256, FORMAT_VERSION } = require('../electron/pack-format.cjs')
const { sign, loadTrust, keyIdOf } = require('../electron/pack-sign.cjs')

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const OUT = path.join(ROOT, 'packs-dist')
const TMP = path.join(ROOT, 'node_modules', '.cache', 'jemero-packs')
const BASE_MANIFEST = path.join(ROOT, 'public', 'kits', 'manifest.json')
const KEY_FILE = path.join(ROOT, '.keys', 'pack-signing.pem')

/**
 * The packs. `modules` maps the import specifier components use to the npm
 * module bundled for it; `css` lists stylesheets, whose fonts and images are
 * copied into the pack next to them.
 */
const PACKS = [
  {
    id: 'katex',
    name: 'KaTeX',
    description: 'Typesets LaTeX math formulas: katex.renderToString(tex) returns HTML to set with dangerouslySetInnerHTML.',
    recommended: true,
    category: 'components',
    package: 'katex',
    dependencies: [],
    modules: { katex: 'katex' },
    css: [{ from: 'katex/dist/katex.min.css', to: 'katex.css' }],
  },
]

const ASSET_TYPE = { '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff', '.svg': 'image/svg+xml', '.png': 'image/png' }
const fileName = (spec) => spec.replace(/^@/, '').replace(/\//g, '__')

function signingKey() {
  if (process.env.JEMERO_PACK_SIGNING_KEY) return process.env.JEMERO_PACK_SIGNING_KEY
  if (fs.existsSync(KEY_FILE)) return fs.readFileSync(KEY_FILE, 'utf8')
  throw new Error('No signing key. Run `npm run packs:keygen` once, or set JEMERO_PACK_SIGNING_KEY (CI).')
}

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name)
    return e.isDirectory() ? walk(full) : [full]
  })
}

/** Everything a pack may import without bundling: the base kit, and its dependencies' modules. */
function externalsFor(def, built) {
  const base = JSON.parse(fs.readFileSync(BASE_MANIFEST, 'utf8')).imports
  const fromDeps = def.dependencies.flatMap((d) => {
    const dep = built.get(d)
    if (!dep) throw new Error(`${def.id} depends on ${d}, which isn't built before it`)
    return Object.keys(dep.imports)
  })
  // Subpaths too: react/jsx-runtime, react-dom/client, …
  return [...new Set([...Object.keys(base), ...fromDeps])].flatMap((s) => [s, `${s}/*`])
}

async function buildPack(def, built) {
  const pkgVersion = require(`${def.package}/package.json`).version
  const dir = path.join(OUT, def.id, pkgVersion)
  const filesDir = path.join(dir, 'files')
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(filesDir, { recursive: true })
  fs.mkdirSync(TMP, { recursive: true })

  // --- JavaScript ----------------------------------------------------------
  const external = externalsFor(def, built)
  const imports = {}
  const exportsOf = {}
  for (const [spec, from] of Object.entries(def.modules)) {
    const entry = path.join(TMP, `${fileName(spec)}.js`)
    fs.writeFileSync(entry, `export * from '${from}'\nexport { default } from '${from}'\n`)
    const out = `${fileName(spec)}.js`
    const result = await build({
      entryPoints: [entry],
      outfile: path.join(filesDir, out),
      bundle: true,
      format: 'esm',
      platform: 'browser',
      target: 'chrome120',
      external,
      define: { 'process.env.NODE_ENV': '"production"', global: 'globalThis' },
      minify: true,
      legalComments: 'eof',
      loader: { '.css': 'empty' },
      metafile: true,
      logLevel: 'silent',
    })
    imports[spec] = out
    exportsOf[spec] = [...Object.values(result.metafile.outputs)[0].exports].sort()
  }

  // --- CSS and the files it points at --------------------------------------
  const assets = []
  for (const sheet of def.css ?? []) {
    const src = require.resolve(sheet.from)
    const css = woff2Only(fs.readFileSync(src, 'utf8'))
    for (const ref of cssUrls(css)) {
      if (/^(https?:)?\/\//.test(ref)) throw new Error(`${def.id}: ${sheet.from} loads ${ref} from the network`)
      const clean = ref.split(/[?#]/)[0]
      const from = path.resolve(path.dirname(src), clean)
      const to = path.join(path.dirname(path.join(filesDir, sheet.to)), clean)
      if (!fs.existsSync(from)) throw new Error(`${def.id}: ${sheet.from} refers to ${ref}, which isn't in the package`)
      fs.mkdirSync(path.dirname(to), { recursive: true })
      fs.copyFileSync(from, to)
    }
    fs.writeFileSync(path.join(filesDir, sheet.to), css)
  }

  // --- checks, hashes, manifest ---------------------------------------------
  const files = {}
  let bytes = 0
  for (const full of walk(filesDir).sort()) {
    const rel = path.relative(filesDir, full).split(path.sep).join('/')
    const buf = fs.readFileSync(full)
    bytes += buf.length
    files[rel] = sha256(buf)
    const ext = path.extname(rel)
    if (ext === '.js' || ext === '.css') {
      const remote = findRemoteRefs(buf.toString('utf8'), ext === '.js' ? 'js' : 'css')
      if (remote.length) throw new Error(`${def.id}: ${rel} needs the network (${remote[0].what}: ${remote[0].match})`)
    }
    if (ext === '.js' && bundlesReact(buf.toString('utf8'))) {
      throw new Error(`${def.id}: ${rel} contains its own copy of React; import it instead so the canvas keeps one`)
    }
    if (ext !== '.js') {
      if (!ASSET_TYPE[ext]) throw new Error(`${def.id}: no asset type for ${rel}`)
      assets.push({ path: rel, type: ASSET_TYPE[ext] })
    }
  }

  const pack = {
    formatVersion: FORMAT_VERSION,
    id: def.id,
    version: pkgVersion,
    name: def.name,
    description: def.description,
    recommended: def.recommended ?? false,
    category: def.category,
    kind: 'local',
    offline: true,
    size: { download: bytes, installed: bytes },
    dependencies: def.dependencies,
    imports,
    exports: exportsOf,
    assets,
    files,
  }
  const errors = validatePack(pack)
  if (errors.length) throw new Error(errors.join('\n'))
  return pack
}

async function main() {
  if (!fs.existsSync(BASE_MANIFEST)) throw new Error('Build the base kit first: npm run kits')
  const key = signingKey()
  const keyId = keyIdOf(require('node:crypto').createPublicKey(key))
  if (!loadTrust()[keyId]) {
    throw new Error(`The signing key ${keyId} isn't in electron/pack-trust.json; the app would refuse these packs.`)
  }

  const started = Date.now()
  const built = new Map()
  for (const def of PACKS) {
    const pack = await buildPack(def, built)
    built.set(pack.id, pack)
    fs.writeFileSync(path.join(OUT, pack.id, pack.version, 'manifest.signed.json'), JSON.stringify(sign(pack, key), null, 2) + '\n')
    const kb = (pack.size.download / 1024).toFixed(0)
    console.log(`packs: ${pack.id} ${pack.version}: ${Object.keys(pack.files).length} files, ${kb} KB`)
  }

  const catalog = { formatVersion: FORMAT_VERSION, packs: [...built.values()] }
  const errors = validateCatalog(catalog)
  if (errors.length) throw new Error(errors.join('\n'))
  fs.writeFileSync(path.join(OUT, 'index.signed.json'), JSON.stringify(sign(catalog, key), null, 2) + '\n')
  console.log(`packs: ${built.size} signed with ${keyId} in ${((Date.now() - started) / 1000).toFixed(1)}s -> ${path.relative(ROOT, OUT)}`)
}

main().catch((err) => {
  console.error(`packs: ${err.message}`)
  process.exit(1)
})
