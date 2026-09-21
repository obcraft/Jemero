// The inference runtime, inside the app.
//
// Atomic Chat used to own this: it shipped llama.cpp, held the models and
// served them. Depending on another app for the core of this one was the weak
// link, it had to be installed, running, and serving the right model. Instead
// we carry llama.cpp ourselves: the official prebuilt macOS binary from the
// llama.cpp releases, resolved in this order:
//
//   1. bundled in the packaged app (Resources/llama), nothing to download
//   2. vendor/llama in the repo, same, for development
//   3. the app-support cache, fetched once on first run
//
// Pinned to one build so behaviour doesn't drift under the user; BUILD is the
// single place to bump, and `npm run runtime` re-vendors it.
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')

const BUILD = 'b11067'
const REPO = 'https://github.com/ggml-org/llama.cpp/releases/download'

const arch = () => (process.arch === 'x64' ? 'x64' : 'arm64')
const assetName = () => `llama-${BUILD}-bin-macos-${arch()}.tar.gz`
const assetUrl = () => `${REPO}/${BUILD}/${assetName()}`

/** Our own application-support directory, not Atomic Chat's. */
function appSupport() {
  const home = process.env.JEMERO_HOME ?? path.join(os.homedir(), 'Library/Application Support/Jemero')
  migrateFromOldName(home)
  return home
}

/**
 * The app used to be called Atomic Lovable, and kept its models, runtime and
 * state under that name. Move them across once, so a rename doesn't strand
 * gigabytes of downloads. Per item, because Electron creates the new folder
 * itself on launch and it may already exist.
 */
let migrated = false
function migrateFromOldName(home) {
  if (migrated || process.env.JEMERO_HOME) return
  migrated = true
  const old = path.join(os.homedir(), 'Library/Application Support/Atomic Lovable')
  if (!fs.existsSync(old)) return
  fs.mkdirSync(home, { recursive: true })
  for (const name of ['models', 'runtime', 'logs', 'server.json', 'settings.json']) {
    const from = path.join(old, name)
    const to = path.join(home, name)
    if (!fs.existsSync(from) || fs.existsSync(to)) continue
    try {
      fs.renameSync(from, to)
    } catch {
      /* in use or cross-volume, leave it; the app still works */
    }
  }
}

const cacheDir = () => path.join(appSupport(), 'runtime')
const vendorDir = () => path.join(__dirname, '..', 'vendor', 'llama')

/** Every directory that might hold llama-server, best first. */
function candidates() {
  const roots = []
  if (process.env.JEMERO_LLAMA_BIN) return [path.dirname(process.env.JEMERO_LLAMA_BIN)]
  if (process.resourcesPath) roots.push(path.join(process.resourcesPath, 'llama'))
  roots.push(vendorDir(), cacheDir())
  // The tarball unpacks into llama-<build>/, so look one level down as well.
  return roots.flatMap((r) => [r, path.join(r, `llama-${BUILD}`)])
}

/** Path to a runnable llama-server, or null if there isn't one yet. */
function find() {
  for (const dir of candidates()) {
    const bin = path.join(dir, 'llama-server')
    try {
      fs.accessSync(bin, fs.constants.X_OK)
      return bin
    } catch {
      /* next candidate */
    }
  }
  return null
}

/**
 * Fetch and unpack the runtime into `dest`. 11 MB, so a few seconds, and it
 * lands outside the app bundle, so an app update doesn't re-download it.
 */
async function download(onStatus = () => {}, dest = cacheDir()) {
  await fsp.mkdir(dest, { recursive: true })
  const tarball = path.join(dest, assetName())

  onStatus(`Downloading the inference runtime (llama.cpp ${BUILD}, 11 MB)…`)
  const res = await fetch(assetUrl(), { redirect: 'follow' })
  if (!res.ok) throw new Error(`Could not fetch llama.cpp ${BUILD}: HTTP ${res.status}`)
  await fsp.writeFile(tarball, Buffer.from(await res.arrayBuffer()))

  onStatus('Unpacking the runtime…')
  // bsdtar ships with macOS and handles the gzip itself.
  execFileSync('/usr/bin/tar', ['xzf', tarball, '-C', dest])
  await fsp.rm(tarball, { force: true })

  const bin = path.join(dest, `llama-${BUILD}`, 'llama-server')
  if (!fs.existsSync(bin)) throw new Error(`Unpacked llama.cpp ${BUILD} but found no llama-server in ${dest}`)
  await fsp.chmod(bin, 0o755)
  return bin
}

/** The one call the rest of the app makes. */
async function ensureRuntime(onStatus = () => {}) {
  return find() ?? (await download(onStatus))
}

/** Where the runtime came from, for the UI and `npm run models`. */
function describe() {
  const bin = find()
  if (!bin) return { build: BUILD, path: null, source: 'not installed' }
  const source = process.resourcesPath && bin.startsWith(process.resourcesPath)
    ? 'bundled'
    : bin.startsWith(vendorDir())
      ? 'vendored'
      : 'cached'
  return { build: BUILD, path: bin, source }
}

module.exports = { ensureRuntime, find, download, describe, BUILD, appSupport, cacheDir, vendorDir, assetUrl }
