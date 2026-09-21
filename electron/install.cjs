// The app's own model store: downloading, resuming, listing and deleting GGUFs.
//
// A model is a directory: models/<org>/<name>/{model.gguf,model.json}, under
// the app's own Application Support folder. No other app has to be installed
// for any of this to work.
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')
const { once } = require('node:events')
const { Readable, Transform } = require('node:stream')
const { pipeline } = require('node:stream/promises')
const { appSupport } = require('./runtime.cjs')

const modelsRoot = () => process.env.ATOMIC_MODELS ?? path.join(appSupport(), 'models')
const modelDir = (id) => path.join(modelsRoot(), ...id.split('/'))
const ggufPath = (id) => path.join(modelDir(id), 'model.gguf')

/**
 * Installed models, read straight off disk — this way a half-finished download (a leftover .part) is visible as
 * such instead of looking like a missing model.
 */
async function installed() {
  const root = modelsRoot()
  const out = []
  let orgs = []
  try {
    orgs = await fsp.readdir(root, { withFileTypes: true })
  } catch {
    return out
  }
  for (const org of orgs.filter((d) => d.isDirectory())) {
    const names = await fsp.readdir(path.join(root, org.name), { withFileTypes: true }).catch(() => [])
    for (const name of names.filter((d) => d.isDirectory())) {
      const dir = path.join(root, org.name, name.name)
      const gguf = path.join(dir, 'model.gguf')
      const stat = await fsp.stat(gguf).catch(() => null)
      const partial = await fsp.stat(`${gguf}.part`).catch(() => null)
      if (!stat && !partial) continue
      out.push({
        id: `${org.name}/${name.name}`,
        bytes: stat?.size ?? 0,
        partialBytes: partial?.size ?? 0,
        complete: !!stat,
        dir,
      })
    }
  }
  return out
}

async function isInstalled(id) {
  return !!(await fsp.stat(ggufPath(id)).catch(() => null))
}

/** Provenance, so a folder on disk explains itself. Nothing reads it to run. */
async function writeManifest(id, bytes, extra = {}) {
  const manifest = { id, bytes, installedAt: new Date().toISOString(), ...extra }
  await fsp.writeFile(path.join(modelDir(id), 'model.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8')
}

/**
 * Models downloaded earlier through Atomic Chat, adopted into our store.
 *
 * Hard links, not copies: same volume means the "import" of a 9 GB file is a
 * metadata write, uses no extra disk, and leaves each app owning an independent
 * name for it — uninstalling Atomic Chat no longer takes the model with it.
 * Only when the two folders are on different volumes do we fall back to leaving
 * the file where it is and skipping it.
 */
async function adoptAtomicChatModels() {
  const legacyRoot = legacyModelsRoot()
  if (!legacyRoot) return []
  const adopted = []
  const orgs = await fsp.readdir(legacyRoot, { withFileTypes: true }).catch(() => [])
  for (const org of orgs.filter((d) => d.isDirectory())) {
    const names = await fsp.readdir(path.join(legacyRoot, org.name), { withFileTypes: true }).catch(() => [])
    for (const name of names.filter((d) => d.isDirectory())) {
      const id = `${org.name}/${name.name}`
      const source = path.join(legacyRoot, org.name, name.name, 'model.gguf')
      const stat = await fsp.stat(source).catch(() => null)
      if (!stat || (await isInstalled(id))) continue
      try {
        await fsp.mkdir(modelDir(id), { recursive: true })
        await fsp.link(source, ggufPath(id))
        await writeManifest(id, stat.size, { adoptedFrom: 'Atomic Chat' })
        adopted.push(id)
      } catch {
        await fsp.rm(modelDir(id), { recursive: true, force: true }).catch(() => {})
      }
    }
  }
  return adopted
}

/** Atomic Chat's model folder, if that app was ever installed. Read-only to us. */
function legacyModelsRoot() {
  const settings = path.join(os.homedir(), 'Library/Application Support/Atomic-Chat/settings.json')
  let data = path.join(os.homedir(), 'Library/Application Support/Atomic Chat/data')
  try {
    data = JSON.parse(fs.readFileSync(settings, 'utf8')).data_folder || data
  } catch {
    /* default location */
  }
  const root = path.join(data, 'llamacpp', 'models')
  return fs.existsSync(root) ? root : null
}

/** Free space on the volume that holds the model folder. */
async function freeBytes() {
  try {
    await fsp.mkdir(modelsRoot(), { recursive: true })
    const { bavail, bsize } = await fsp.statfs(modelsRoot())
    return Number(bavail) * Number(bsize)
  } catch {
    return Infinity
  }
}

const inFlight = new Map() // id -> AbortController

/**
 * The SHA-256 Hugging Face publishes for this file (its LFS object id). The
 * download is checked against it before the model is ever loaded: a file of
 * the right size with wrong bytes loads fine and then prints "@@@@@@", which
 * is exactly how a bad resume showed up the first time.
 */
async function expectedSha256(plan) {
  try {
    const res = await fetch(`https://huggingface.co/api/models/${plan.repo}?blobs=true`, {
      signal: AbortSignal.timeout(15000),
    })
    const json = await res.json()
    return json.siblings?.find((s) => s.rfilename === plan.file)?.lfs?.sha256 ?? null
  } catch {
    return null
  }
}

/** Streaming SHA-256 of a file, reporting progress as it goes. */
async function sha256File(file, onBytes) {
  const hash = crypto.createHash('sha256')
  let done = 0
  for await (const chunk of fs.createReadStream(file, { highWaterMark: 8 * 1024 * 1024 })) {
    hash.update(chunk)
    done += chunk.length
    onBytes(done)
  }
  return hash.digest('hex')
}

/**
 * One writer per .part, across processes too: the dev app and the packaged
 * app keep separate windows but share this folder, and two writers on one file
 * is how bytes end up in the wrong place.
 */
async function acquireLock(dir) {
  const lock = path.join(dir, '.download.lock')
  try {
    const pid = Number(await fsp.readFile(lock, 'utf8'))
    if (pid && pid !== process.pid) {
      try {
        process.kill(pid, 0)
        throw new Error('This model is already downloading in another Atomic Lovable window.')
      } catch (err) {
        if (err.code !== 'ESRCH') throw err // alive → refuse; ESRCH → stale lock, take it
      }
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
  }
  await fsp.writeFile(lock, String(process.pid))
  return () => fsp.rm(lock, { force: true })
}

/**
 * Download `plan.url` into place, resuming a previous attempt when one is
 * there. Weights are 5-60 GB and connections drop, so a resumable .part is the
 * difference between a retry and starting over — but only if the resume is
 * provably at the right offset and the result is checked, both done here.
 *
 * @param {{modelId: string, url: string, bytes: number, repo: string, file: string, quant?: string}} plan
 * @param {(p: object) => void} onProgress
 */
async function install(plan, onProgress = () => {}) {
  const { modelId, url, bytes } = plan
  if (inFlight.has(modelId)) throw new Error(`${modelId} is already downloading`)

  const dir = modelDir(modelId)
  const gguf = path.join(dir, 'model.gguf')
  const part = `${gguf}.part`
  const controller = new AbortController()
  inFlight.set(modelId, controller)
  let release = null
  let sink = null

  const emit = (phase, received, rate = 0, eta = null) =>
    onProgress({ id: modelId, phase, received, total: bytes, bytesPerSec: rate, etaSeconds: eta })

  try {
    await fsp.mkdir(dir, { recursive: true })

    if (await isInstalled(modelId)) {
      emit('done', bytes)
      return { ok: true, modelId, alreadyInstalled: true }
    }

    release = await acquireLock(dir)
    const sha = await expectedSha256(plan)

    let from = (await fsp.stat(part).catch(() => null))?.size ?? 0
    if (from > bytes) {
      // Bigger than the target: a stale file from something else.
      await fsp.rm(part, { force: true })
      from = 0
    }

    const free = await freeBytes()
    const needed = bytes - from + 512 * 1024 ** 2
    if (free < needed) throw new Error(`Not enough disk space: ${gb(needed)} GB needed, ${gb(free)} GB free.`)

    if (from < bytes) {
      emit(from ? 'resuming' : 'downloading', from)

      const res = await fetch(url, {
        signal: controller.signal,
        headers: from ? { Range: `bytes=${from}-` } : {},
        redirect: 'follow',
      })
      if (!res.ok || !res.body) {
        if (res.status === 416) await fsp.rm(part, { force: true })
        throw new Error(`Hugging Face returned ${res.status} for ${plan.file}. Try again.`)
      }

      // Resume only when the server *says* it starts exactly where we stopped.
      // A 206 alone isn't enough: a range served from a different offset writes
      // shifted bytes and still ends at the right total size.
      if (from) {
        const start = Number(/bytes (\d+)-/.exec(res.headers.get('content-range') ?? '')?.[1])
        if (res.status !== 206 || start !== from) {
          await res.body.cancel().catch(() => {})
          await fsp.rm(part, { force: true })
          release?.()
          release = null
          inFlight.delete(modelId)
          return install(plan, onProgress) // clean restart from zero
        }
      }

      sink = fs.createWriteStream(part, { flags: from ? 'a' : 'w' })
      let received = from
      const started = Date.now()
      let lastEmit = 0

      const body = Readable.fromWeb(res.body)
      const meter = new Transform({
        transform(chunk, _enc, done) {
          received += chunk.length
          const now = Date.now()
          if (now - lastEmit >= 250) {
            lastEmit = now
            const rate = ((received - from) / (now - started)) * 1000
            emit('downloading', received, Math.round(rate), rate > 0 ? Math.round((bytes - received) / rate) : null)
          }
          done(null, chunk)
        },
      })
      await pipeline(body, meter, sink)
    }

    const finalSize = (await fsp.stat(part)).size
    if (finalSize !== bytes) {
      throw new Error(`Download ended at ${finalSize} of ${bytes} bytes. Press Resume to continue.`)
    }

    if (sha) {
      const got = await sha256File(part, (n) => emit('verifying', n))
      if (got !== sha) {
        await fsp.rm(part, { force: true })
        throw new Error(`${plan.file} was damaged in transit (checksum mismatch), so it was removed. Press Get to download it again.`)
      }
    }

    emit('installing', bytes)
    await fsp.rename(part, gguf)
    await writeManifest(modelId, bytes, { repo: plan.repo, file: plan.file, quant: plan.quant, sha256: sha ?? 'unverified' })
    emit('done', bytes)
    return { ok: true, modelId }
  } catch (err) {
    if (controller.signal.aborted) {
      // Let the last in-flight write land before reporting, so the size a
      // later Resume reads is the size that's really on disk.
      if (sink && !sink.closed) await once(sink, 'close').catch(() => {})
      emit('cancelled', (await fsp.stat(part).catch(() => null))?.size ?? 0)
      return { ok: false, cancelled: true, modelId }
    }
    if (sink && !sink.closed) await once(sink, 'close').catch(() => {})
    emit('error', 0)
    throw err
  } finally {
    await release?.()
    inFlight.delete(modelId)
  }
}

/** Stops the download but keeps the .part file, so "Resume" is one click. */
function cancel(modelId) {
  const controller = inFlight.get(modelId)
  if (!controller) return false
  controller.abort()
  return true
}

async function remove(modelId) {
  await fsp.rm(modelDir(modelId), { recursive: true, force: true })
  return { ok: true }
}

const gb = (n) => Math.round((n / 1024 ** 3) * 10) / 10

module.exports = {
  installed,
  isInstalled,
  install,
  cancel,
  remove,
  modelsRoot,
  modelDir,
  ggufPath,
  freeBytes,
  adoptAtomicChatModels,
}
