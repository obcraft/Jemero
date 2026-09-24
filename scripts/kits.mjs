#!/usr/bin/env node
// Bundles the UI kits the preview canvas renders with (see kits/stage.js).
//
// Every package a generated component may import is bundled once, as ESM with
// shared chunks, into public/kits/vendor, and the import map in stage.html
// points each bare specifier at its bundle. A preview then needs no npm
// install, no dev server and no network: it renders in milliseconds, offline.
// public/kits/manifest.json records what every module exports, which the app
// uses to check a component's imports before it reaches the canvas.
//
//   node scripts/kits.mjs             rebuild public/kits
//   node scripts/kits.mjs --if-stale  only when an input changed

import { build } from 'esbuild'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const KITS = path.join(ROOT, 'kits')
const SHADCN = path.join(KITS, 'shadcn')
const OUT = path.join(ROOT, 'public', 'kits')
const TMP = path.join(ROOT, 'node_modules', '.cache', 'jemero-kits')
const require = createRequire(path.join(ROOT, 'package.json'))

// The React packages are CommonJS: their names can't be star-re-exported into
// ESM, so their entry files list them explicitly.
const CJS = ['react', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'react-dom', 'react-dom/client']

/** Read from disk: some packages' "exports" don't expose their package.json. */
const pkgDir = (name) => path.join(ROOT, 'node_modules', name)
const pkgJson = (name) => JSON.parse(fs.readFileSync(path.join(pkgDir(name), 'package.json'), 'utf8'))

const RADIX = Object.keys(pkgJson('radix-ui').dependencies).filter((n) => n.startsWith('@radix-ui/react-'))

/** Every bare specifier a component may import. */
const PACKAGES = [
  ...CJS,
  'clsx',
  'tailwind-merge',
  'class-variance-authority',
  'date-fns',
  'lucide-react',
  'motion/react',
  'framer-motion',
  'radix-ui',
  ...RADIX,
  'cmdk',
  'sonner',
  'input-otp',
  'react-day-picker',
  'recharts',
]

const IDENT = /^[A-Za-z_$][\w$]*$/

/** "react-dom/client" -> "react-dom__client", "motion/react" -> "motion__react". */
const fileName = (spec) => spec.replace(/^@/, '').replace(/\//g, '__')

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name)
    return e.isDirectory() ? walk(full) : [full]
  })
}

/** Everything that changes the output: the lockfile, the kit sources, this script. */
function inputsHash() {
  const hash = createHash('sha256')
  for (const file of [path.join(ROOT, 'package-lock.json'), fileURLToPath(import.meta.url), ...walk(KITS).sort()]) {
    hash.update(path.relative(ROOT, file))
    hash.update(fs.readFileSync(file))
  }
  return hash.digest('hex').slice(0, 16)
}

/** Resolves the shadcn aliases (@/components/ui/*, @/lib/*) to kits/shadcn. */
const shadcnAlias = {
  name: 'shadcn-alias',
  setup(b) {
    b.onResolve({ filter: /^@\/(components\/ui|lib)\// }, (args) => {
      const rel = args.path.slice(2)
      const base = rel.startsWith('components/ui/')
        ? path.join(SHADCN, 'ui', rel.slice('components/ui/'.length))
        : path.join(SHADCN, rel)
      for (const ext of ['', '.jsx', '.js']) {
        if (fs.existsSync(base + ext) && fs.statSync(base + ext).isFile()) return { path: base + ext }
      }
      return { errors: [{ text: `No kit file for ${args.path}` }] }
    })
  },
}

/** Does Node see a default export? A first guess only: Node may pick a package's
 *  CommonJS build, where everything has one, while the bundler takes its ESM. */
async function nodeHasDefault(spec) {
  try {
    const ns = await import(spec)
    return 'default' in ns
  } catch {
    return false
  }
}

const NO_DEFAULT = /No matching export in .* for import "default"/

/** Canvas assets every build writes beside the vendor bundles. */
const ASSETS = ['stage.html', 'stage.js', 'tailwind.js', 'tailwind-theme.css']

/**
 * The last build is still usable: same inputs, and every file it wrote is
 * there. A manifest alone proves nothing (a partial copy or a clone that
 * carried only some of public/kits has one), and a missing bundle is a canvas
 * that can't import anything.
 */
function upToDate(manifestPath, inputs) {
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    if (manifest.inputs !== inputs) return false
    const written = [...ASSETS, ...Object.values(manifest.imports ?? {})]
    return written.every((rel) => fs.existsSync(path.join(OUT, rel)))
  } catch {
    return false
  }
}

async function main() {
  const inputs = inputsHash()
  const manifestPath = path.join(OUT, 'manifest.json')
  if (process.argv.includes('--if-stale') && upToDate(manifestPath, inputs)) {
    console.log('kits: up to date')
    return
  }

  const started = Date.now()
  process.env.NODE_ENV = 'development'
  fs.rmSync(OUT, { recursive: true, force: true })
  fs.rmSync(TMP, { recursive: true, force: true })
  fs.mkdirSync(TMP, { recursive: true })

  // One small entry file per specifier. Bundled together with splitting, so
  // anything two entries share (React above all) exists exactly once.
  const entryPoints = {}
  const specOf = {}
  const withDefault = new Set()
  const writeEntry = (spec) => {
    const name = fileName(spec)
    let source
    if (CJS.includes(spec)) {
      const names = Object.keys(require(spec)).filter((n) => IDENT.test(n) && n !== 'default' && n !== '__esModule')
      source = `export { ${names.join(', ')} } from '${spec}'\nexport { default } from '${spec}'\n`
    } else {
      source = `export * from '${spec}'\n${withDefault.has(spec) ? `export { default } from '${spec}'\n` : ''}`
    }
    const file = path.join(TMP, `${name}.js`)
    fs.writeFileSync(file, source)
    entryPoints[name] = file
    specOf[name] = spec
  }
  for (const spec of PACKAGES) {
    if (!CJS.includes(spec) && (await nodeHasDefault(spec))) withDefault.add(spec)
    writeEntry(spec)
  }

  // shadcn/ui, compiled like any other package, under the import paths shadcn uses.
  const sources = {}
  for (const file of fs.readdirSync(path.join(SHADCN, 'ui')).filter((f) => f.endsWith('.jsx')).sort()) {
    const base = file.replace(/\.jsx$/, '')
    entryPoints[`ui__${base}`] = path.join(SHADCN, 'ui', file)
    specOf[`ui__${base}`] = `@/components/ui/${base}`
    sources[`components/ui/${file}`] = fs.readFileSync(path.join(SHADCN, 'ui', file), 'utf8')
  }
  entryPoints.lib__utils = path.join(SHADCN, 'lib', 'utils.js')
  specOf.lib__utils = '@/lib/utils'
  sources['lib/utils.js'] = fs.readFileSync(path.join(SHADCN, 'lib', 'utils.js'), 'utf8')

  const options = {
    entryPoints,
    bundle: true,
    splitting: true,
    format: 'esm',
    platform: 'browser',
    target: 'chrome120',
    outdir: path.join(OUT, 'vendor'),
    entryNames: '[name]',
    chunkNames: 'chunks/[name]-[hash]',
    jsx: 'automatic',
    // Development builds: React's warnings and full error messages are what
    // the canvas shows, and what a repair request hands back to the model.
    define: { 'process.env.NODE_ENV': '"development"', global: 'globalThis' },
    minifyWhitespace: true,
    minifySyntax: true,
    legalComments: 'eof',
    loader: { '.css': 'empty' },
    metafile: true,
    logLevel: 'silent',
    plugins: [shadcnAlias],
  }

  // A default export Node saw but the ESM build doesn't have fails the build;
  // drop exactly those and go again.
  let result
  try {
    result = await build(options)
  } catch (err) {
    const wrong = (err.errors ?? []).filter((e) => NO_DEFAULT.test(e.text) && e.location?.file)
    if (!wrong.length || wrong.length !== err.errors.length) throw err
    for (const e of wrong) {
      const spec = specOf[path.basename(e.location.file, '.js')]
      withDefault.delete(spec)
      writeEntry(spec)
    }
    result = await build(options)
  }

  const imports = {}
  const exportsOf = {}
  for (const [out, meta] of Object.entries(result.metafile.outputs)) {
    if (!meta.entryPoint) continue
    const name = path.basename(out, '.js')
    const spec = specOf[name]
    if (!spec) continue
    imports[spec] = `./vendor/${name}.js`
    exportsOf[spec] = [...meta.exports].sort()
    if (!exportsOf[spec].length) throw new Error(`${spec} bundled with no exports; is it CommonJS? Add it to CJS.`)
  }
  for (const spec of PACKAGES) if (!imports[spec]) throw new Error(`No bundle produced for ${spec}`)

  const versions = {}
  for (const spec of PACKAGES) {
    const pkg = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]
    if (!versions[pkg]) versions[pkg] = pkgJson(pkg).version
  }

  // Canvas assets.
  fs.copyFileSync(path.join(pkgDir('@tailwindcss/browser'), 'dist', 'index.global.js'), path.join(OUT, 'tailwind.js'))
  const animate = fs.readFileSync(path.join(pkgDir('tw-animate-css'), 'dist', 'tw-animate.css'), 'utf8')
  fs.writeFileSync(path.join(OUT, 'tailwind-theme.css'), `${fs.readFileSync(path.join(KITS, 'tailwind-theme.css'), 'utf8')}\n${animate}\n`)
  fs.copyFileSync(path.join(KITS, 'stage.js'), path.join(OUT, 'stage.js'))
  const stage = fs.readFileSync(path.join(KITS, 'stage.html'), 'utf8')
  fs.writeFileSync(path.join(OUT, 'stage.html'), stage.replace('/*IMPORTMAP*/', JSON.stringify({ imports }, null, 2)))

  fs.writeFileSync(
    manifestPath,
    JSON.stringify({ version: 1, inputs, builtAt: new Date().toISOString(), versions, imports, exports: exportsOf, sources }) + '\n',
  )

  const bytes = walk(OUT).reduce((n, f) => n + fs.statSync(f).size, 0)
  console.log(
    `kits: ${Object.keys(imports).length} modules, ${(bytes / 1024 / 1024).toFixed(1)} MB in ${((Date.now() - started) / 1000).toFixed(1)}s -> ${path.relative(ROOT, OUT)}`,
  )
}

main().catch((err) => {
  console.error(`kits: ${err.message}`)
  process.exit(1)
})
