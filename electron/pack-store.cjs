// The pack store: downloads, verifies and activates packs under Jemero's
// Application Support folder.
//
//   packs/
//     installed.json                 which version of each pack is active
//     catalog.signed.json            last good index, for listing offline
//     <id>/<version>/                an activated pack, never modified again
//       manifest.signed.json
//       files/…
//     .staging/<id>@<version>/       a download in progress (kept for resume)
//     .trash/                        replaced folders, removed after activation
//
// The rules that keep an old version usable whatever happens:
// - Nothing is written into an active pack folder. A download goes to
//   .staging; only when the signed manifest checks out and every file matches
//   its hash is the staging folder renamed into place (atomic on one volume).
// - installed.json is replaced by rename too, after the folder is in place, so
//   it only ever names folders that are complete.
// - Cancelling, a dropped connection or a corrupt file stops before any of
//   that: the staging folder stays for the next attempt, the active version is
//   untouched.
const crypto = require('node:crypto')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const { pipeline } = require('node:stream/promises')
const { validatePack, validateCatalog, closure, verifyPackDir, sha256, compareVersions, FORMAT_VERSION } = require('./pack-format.cjs')
const signing = require('./pack-sign.cjs')

const RETRIES = 3
const TIMEOUT_MS = 30_000
// Headroom on top of the installed size: staging and final share the volume,
// and a disk filled to the last byte is how other apps start failing.
const DISK_MARGIN = 1.1

class PackError extends Error {
  constructor(message, { retryable = false, code } = {}) {
    super(message)
    this.retryable = retryable
    this.code = code
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const exists = (p) => fsp.stat(p).then(() => true, () => false)

/** Pack ids as the format allows them: never a path. */
const PACK_ID = /^[a-z0-9][a-z0-9-]{0,63}$/

/** Runs tasks one at a time, in call order; a failed task doesn't stop the next. */
function queue() {
  let tail = Promise.resolve()
  return (task) => {
    const run = tail.then(task)
    tail = run.catch(() => {})
    return run
  }
}

/**
 * An abort signal for a stalled transfer: it fires once `touch()` hasn't been
 * called for `ms`. A deadline on the whole request would also fail a slow but
 * steady download.
 */
function stallTimer(ms) {
  const controller = new AbortController()
  let timer
  const touch = () => {
    clearTimeout(timer)
    timer = setTimeout(() => controller.abort(new DOMException('The pack server stopped sending data.', 'TimeoutError')), ms)
  }
  touch()
  return { signal: controller.signal, touch, stop: () => clearTimeout(timer) }
}

async function writeJsonAtomic(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true })
  // Unique per write: two writes of one file must not share (and steal) a temp file.
  const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`
  await fsp.writeFile(tmp, JSON.stringify(value, null, 2) + '\n')
  await fsp.rename(tmp, file)
}

async function hashFile(file) {
  return sha256(await fsp.readFile(file))
}

function formatMB(bytes) {
  return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.max(0.1, bytes / 1024 ** 2).toFixed(1)} MB`
}

/** Turn whatever went wrong into one sentence the UI can show as it is. */
function explain(err, what) {
  if (err instanceof PackError) return err.message
  if (err?.code === 'ENOSPC') return 'The disk is full. Free some space and try again.'
  if (err?.name === 'TimeoutError') return `The pack server stopped responding while downloading ${what}. Try again.`
  if (err?.message === 'fetch failed' || err?.cause?.code === 'ECONNREFUSED' || err?.cause?.code === 'ENOTFOUND') {
    return 'Can’t reach the pack server. Check your connection and try again.'
  }
  return err?.message ?? String(err)
}

/**
 * @param {object} o
 * @param {string} o.root           folder the store owns (…/Jemero/packs)
 * @param {string|null} o.sourceUrl  base URL packs are published under, or null when none is configured
 * @param {Record<string,string>} [o.trust]  public keys, defaults to pack-trust.json
 * @param {typeof fetch} [o.fetchImpl]
 * @param {() => Promise<number>} [o.freeBytes]
 */
function createPackStore({ root, sourceUrl, trust = signing.loadTrust(), fetchImpl = globalThis.fetch, freeBytes }) {
  const base = sourceUrl ? sourceUrl.replace(/\/+$/, '') : null
  const installedFile = path.join(root, 'installed.json')
  const catalogFile = path.join(root, 'catalog.signed.json')
  const stagingDir = (p) => path.join(root, '.staging', `${p.id}@${p.version}`)
  const packDir = (id, version) => path.join(root, id, version)
  const inFlight = new Map() // id -> AbortController
  // Downloads run one at a time: two packs can share a dependency, and with
  // it a staging folder. installed.json changes (activate, remove, rollback)
  // are read-modify-write, so they take turns as well.
  const downloads = queue()
  const stateChange = queue()

  const free =
    freeBytes ??
    (async () => {
      await fsp.mkdir(root, { recursive: true })
      const { bavail, bsize } = await fsp.statfs(root)
      return bavail * bsize
    })

  /** A response, and the stall timer its body is read under: touch() per chunk, stop() when done. */
  async function get(url, signal, headers = {}) {
    const stall = stallTimer(TIMEOUT_MS)
    try {
      const res = await fetchImpl(url, { signal: signal ? AbortSignal.any([signal, stall.signal]) : stall.signal, headers })
      if (res.status === 404) throw new PackError(`The pack server has no ${url.slice(base.length + 1)}.`)
      if (res.status >= 500) throw new PackError(`The pack server failed (${res.status}). Try again.`, { retryable: true })
      stall.touch()
      return { res, stall }
    } catch (err) {
      stall.stop()
      throw err
    }
  }

  async function getJson(url, signal) {
    const { res, stall } = await get(url, signal)
    try {
      if (!res.ok) throw new PackError(`The pack server answered ${res.status} for ${url.slice(base.length + 1)}.`)
      return await res.json()
    } finally {
      stall.stop()
    }
  }

  function checkCatalog(envelope) {
    const catalog = signing.verify(envelope, trust)
    const errors = validateCatalog(catalog)
    if (errors.length) throw new PackError(`The pack index is invalid: ${errors[0]}`)
    return catalog
  }

  /** The cached index, verified, or null. */
  async function cachedCatalog() {
    try {
      return checkCatalog(JSON.parse(await fsp.readFile(catalogFile, 'utf8')))
    } catch {
      return null
    }
  }

  /**
   * The signed index of every pack. Fresh from the server when it can be
   * reached, otherwise the last one that verified, so the list still shows
   * what is installed on a plane.
   *
   * A signature proves who made an index, not when: an older one, served
   * again, would verify too and offer old versions as the current ones. So a
   * fresh index must not be older (by its signed serial) than the last one.
   */
  async function catalog() {
    if (base) {
      try {
        const envelope = await getJson(`${base}/index.signed.json`)
        const catalog = checkCatalog(envelope)
        const known = await cachedCatalog()
        if (known && (catalog.serial ?? -1) < (known.serial ?? -1)) {
          throw new PackError('The pack server sent an older pack index than the one already seen, so it was not used.')
        }
        // The copy for offline listing is a convenience: failing to write it
        // mustn't turn a fresh, verified index into "offline".
        await writeJsonAtomic(catalogFile, envelope).catch(() => {})
        return { catalog, fromCache: false }
      } catch (err) {
        if (!(await exists(catalogFile))) throw new PackError(explain(err, 'the pack index'))
      }
    }
    try {
      const catalog = checkCatalog(JSON.parse(await fsp.readFile(catalogFile, 'utf8')))
      return { catalog, fromCache: true }
    } catch (err) {
      if (!base) return { catalog: { formatVersion: FORMAT_VERSION, packs: [] }, fromCache: true }
      throw new PackError(explain(err, 'the pack index'))
    }
  }

  /** id -> { version, previous, activatedAt } for every active pack. */
  async function installed() {
    try {
      return JSON.parse(await fsp.readFile(installedFile, 'utf8')).packs ?? {}
    } catch {
      return {}
    }
  }

  /**
   * One file into staging: resume a .part with a Range request, hash the
   * result, retry on a dropped connection or a server error. A file whose
   * hash doesn't match is thrown away and fetched once more from scratch
   * before giving up.
   */
  async function downloadFile(url, dest, expected, signal, onBytes) {
    const part = `${dest}.part`
    await fsp.mkdir(path.dirname(dest), { recursive: true })
    // What an earlier attempt left is progress already made.
    const kept = (await fsp.stat(part).catch(() => null))?.size ?? 0
    if (kept) onBytes(kept)
    let freshAfterMismatch = false
    for (let attempt = 0; ; attempt++) {
      try {
        const from = (await fsp.stat(part).catch(() => null))?.size ?? 0
        const { res, stall } = await get(url, signal, from ? { Range: `bytes=${from}-` } : {})
        try {
          if (res.status === 416) {
            // Nothing left to send: the .part is already whole (or wrong); the hash decides.
          } else if (!res.ok) {
            throw new PackError(`The pack server answered ${res.status} for ${path.basename(dest)}.`)
          } else {
            const append = from > 0 && res.status === 206
            if (from > 0 && !append) onBytes(-from) // the server ignored Range: start over
            // pipeline() settles on a write error (a full disk) as well as on a
            // read error, and closes both ends either way.
            await pipeline(
              res.body,
              async function* (chunks) {
                for await (const chunk of chunks) {
                  stall.touch()
                  onBytes(chunk.length)
                  yield chunk
                }
              },
              fs.createWriteStream(part, { flags: append ? 'a' : 'w' }),
            )
          }
        } finally {
          stall.stop()
        }
        const got = await hashFile(part)
        if (got === expected) {
          await fsp.rename(part, dest)
          return
        }
        const size = (await fsp.stat(part)).size
        await fsp.rm(part, { force: true })
        onBytes(-size)
        if (freshAfterMismatch) {
          throw new PackError(`${path.basename(dest)} arrived corrupted twice (its hash doesn’t match the signed manifest). Try again later.`)
        }
        freshAfterMismatch = true
      } catch (err) {
        if (signal.aborted) throw err
        const retryable = err instanceof PackError ? err.retryable : err?.code !== 'ENOSPC'
        if (!retryable || attempt >= RETRIES) throw err
        await sleep(500 * 2 ** attempt)
      }
    }
  }

  /** Download, verify and activate one pack (its dependencies are handled by install). */
  async function installOne(entry, signal, progress) {
    const staging = stagingDir(entry)
    const filesDir = path.join(staging, 'files')
    await fsp.mkdir(filesDir, { recursive: true })

    progress({ phase: 'downloading', pack: entry.id, file: 'manifest' })
    const url = `${base}/${entry.id}/${entry.version}`
    const envelope = await getJson(`${url}/manifest.signed.json`, signal)
    const manifest = signing.verify(envelope, trust)
    const errors = validatePack(manifest)
    if (errors.length) throw new PackError(`The ${entry.name} manifest is invalid: ${errors[0]}`)
    if (manifest.id !== entry.id || manifest.version !== entry.version || manifest.kind !== 'local') {
      throw new PackError(`The ${entry.name} manifest doesn’t match the pack index.`)
    }
    if (JSON.stringify(manifest.files) !== JSON.stringify(entry.files)) {
      throw new PackError(`The ${entry.name} manifest and the pack index list different files.`)
    }
    await writeJsonAtomic(path.join(staging, 'manifest.signed.json'), envelope)

    for (const [file, hash] of Object.entries(manifest.files)) {
      if (signal.aborted) throw signal.reason
      const dest = path.join(filesDir, ...file.split('/'))
      // Already fetched by an earlier, interrupted attempt.
      if ((await exists(dest)) && (await hashFile(dest)) === hash) {
        progress({ phase: 'downloading', pack: entry.id, file, bytes: (await fsp.stat(dest)).size })
        continue
      }
      await fsp.rm(dest, { force: true })
      await downloadFile(`${url}/files/${file.split('/').map(encodeURIComponent).join('/')}`, dest, hash, signal, (n) =>
        progress({ phase: 'downloading', pack: entry.id, file, bytes: n }),
      )
    }

    progress({ phase: 'verifying', pack: entry.id })
    const problems = verifyPackDir(filesDir, manifest)
    if (problems.length) throw new PackError(`${entry.name} failed verification: ${problems[0]}`)
    if (signal.aborted) throw signal.reason

    progress({ phase: 'activating', pack: entry.id })
    await activate(manifest, staging)
  }

  const activate = (manifest, staging) => stateChange(() => activateNow(manifest, staging))

  async function activateNow(manifest, staging) {
    const final = packDir(manifest.id, manifest.version)
    const trash = path.join(root, '.trash')
    await fsp.mkdir(path.dirname(final), { recursive: true })
    // Same version already there (a reinstall after a failed check): set it aside first.
    if (await exists(final)) {
      await fsp.mkdir(trash, { recursive: true })
      await fsp.rename(final, path.join(trash, `${manifest.id}@${manifest.version}-${Date.now()}`))
    }
    await fsp.rename(staging, final)

    const all = await installed()
    const before = all[manifest.id]?.version ?? null
    all[manifest.id] = {
      version: manifest.version,
      previous: before && before !== manifest.version ? before : (all[manifest.id]?.previous ?? null),
      activatedAt: new Date().toISOString(),
    }
    await writeJsonAtomic(installedFile, { formatVersion: FORMAT_VERSION, packs: all })

    // Keep the active and the previous version; older ones and the trash go.
    const keep = new Set([all[manifest.id].version, all[manifest.id].previous].filter(Boolean))
    for (const v of await fsp.readdir(path.dirname(final)).catch(() => [])) {
      if (!keep.has(v)) await fsp.rm(path.join(path.dirname(final), v), { recursive: true, force: true })
    }
    await fsp.rm(trash, { recursive: true, force: true })
  }

  /**
   * Install a pack and whatever it depends on. Progress events:
   *   { id, phase: 'checking', required, free }
   *   { id, phase: 'downloading' | 'verifying' | 'activating', pack, received, total }
   *   { id, phase: 'done' | 'cancelled' } | { id, phase: 'error', message }
   * Resolves { ok, reason? }; never rejects.
   */
  async function install(id, onProgress = () => {}) {
    if (!base) return fail(id, onProgress, 'No pack server is configured.')
    if (inFlight.has(id)) return { ok: false, busy: true, reason: 'Already installing.' }
    const controller = new AbortController()
    inFlight.set(id, controller)
    try {
      return await downloads(() => installNow(id, controller, onProgress))
    } finally {
      inFlight.delete(id)
    }
  }

  async function installNow(id, controller, onProgress) {
    try {
      controller.signal.throwIfAborted()
      const { catalog: cat } = await catalog()
      const target = cat.packs.find((p) => p.id === id)
      if (!target) throw new PackError(`There is no pack called ${id}.`)
      const current = (await installed())[id]?.version
      // Going back is what Roll back is for; an index that offers an older version is not an update.
      if (current && compareVersions(target.version, current) < 0) {
        throw new PackError(`${target.name} ${current} is installed; the pack index only offers the older ${target.version}.`)
      }
      if (target.kind !== 'local') throw new PackError(`${target.name} is an online service; there is nothing to install.`)
      const order = closure(cat, [id])
      const active = await installed()
      // A version that is active but no longer verifies is installed again:
      // that's how a damaged pack gets repaired.
      const todo = []
      for (const p of order) {
        if (active[p.id]?.version !== p.version || (await verifyInstalled(p.id)).length) todo.push(p)
      }

      const total = todo.reduce((n, p) => n + p.size.download, 0)
      const required = Math.ceil(todo.reduce((n, p) => n + p.size.installed, 0) * DISK_MARGIN)
      const available = await free()
      onProgress({ id, phase: 'checking', required, free: available })
      if (required > available) {
        throw new PackError(`Needs ${formatMB(required)} of free disk space; only ${formatMB(available)} is available.`)
      }

      let received = 0
      for (const pack of todo) {
        await installOne(pack, controller.signal, (e) => {
          if (e.bytes) received += e.bytes
          onProgress({ id, phase: e.phase, pack: e.pack, file: e.file, received: Math.max(0, received), total })
        })
      }
      onProgress({ id, phase: 'done' })
      return { ok: true }
    } catch (err) {
      if (controller.signal.aborted) {
        onProgress({ id, phase: 'cancelled' })
        return { ok: false, cancelled: true, reason: 'Cancelled. The download resumes where it stopped.' }
      }
      return fail(id, onProgress, explain(err, id))
    }
  }

  function fail(id, onProgress, message) {
    onProgress({ id, phase: 'error', message })
    return { ok: false, reason: message }
  }

  /** Stop a download. Its staging folder stays, so the next install resumes. */
  function cancel(id) {
    const c = inFlight.get(id)
    if (!c) return false
    c.abort()
    return true
  }

  /** Deactivate and delete a pack, all its versions and any half download. */
  async function remove(id) {
    if (typeof id !== 'string' || !PACK_ID.test(id)) return { ok: false, reason: 'That is not a pack id.' }
    if (inFlight.has(id)) return { ok: false, reason: 'It is downloading. Cancel first.' }
    return stateChange(() => removeNow(id))
  }

  async function removeNow(id) {
    const all = await installed()
    delete all[id]
    await writeJsonAtomic(installedFile, { formatVersion: FORMAT_VERSION, packs: all })
    await fsp.rm(path.join(root, id), { recursive: true, force: true })
    for (const d of await fsp.readdir(path.join(root, '.staging')).catch(() => [])) {
      if (d.startsWith(`${id}@`)) await fsp.rm(path.join(root, '.staging', d), { recursive: true, force: true })
    }
    return { ok: true }
  }

  /**
   * Go back to the version that was active before the last update. It must
   * still be on disk and verify; installed.json is replaced by rename, so the
   * switch is atomic like an activation.
   */
  const rollback = (id) => stateChange(() => rollbackNow(id))

  async function rollbackNow(id) {
    const all = await installed()
    const active = all[id]
    if (!active?.previous) return { ok: false, reason: 'There is no earlier version to go back to.' }
    const dir = packDir(id, active.previous)
    try {
      const manifest = signing.verify(JSON.parse(await fsp.readFile(path.join(dir, 'manifest.signed.json'), 'utf8')), trust)
      const problems = verifyPackDir(path.join(dir, 'files'), manifest)
      if (problems.length) return { ok: false, reason: `The earlier version is damaged: ${problems[0]}` }
    } catch (err) {
      return { ok: false, reason: `The earlier version can’t be used: ${explain(err, id)}` }
    }
    all[id] = { version: active.previous, previous: active.version, activatedAt: new Date().toISOString() }
    await writeJsonAtomic(installedFile, { formatVersion: FORMAT_VERSION, packs: all })
    return { ok: true, version: active.previous }
  }

  /** The active version's signed manifest, verified, and where its files are. Null when not installed. */
  async function activeManifest(id) {
    const active = (await installed())[id]
    if (!active) return null
    const dir = packDir(id, active.version)
    const manifest = signing.verify(JSON.parse(await fsp.readFile(path.join(dir, 'manifest.signed.json'), 'utf8')), trust)
    if (manifest.id !== id || manifest.version !== active.version) throw new PackError(`${id}: the installed manifest doesn’t match its folder`)
    return { manifest, filesDir: path.join(dir, 'files') }
  }

  /** Re-check an active pack against its signed manifest. Returns problems, empty when intact. */
  async function verifyInstalled(id) {
    const active = (await installed())[id]
    if (!active) return [`${id}: not installed`]
    const dir = packDir(id, active.version)
    try {
      const manifest = signing.verify(JSON.parse(await fsp.readFile(path.join(dir, 'manifest.signed.json'), 'utf8')), trust)
      return verifyPackDir(path.join(dir, 'files'), manifest)
    } catch (err) {
      return [`${id}: ${explain(err, id)}`]
    }
  }

  return { root, sourceUrl: base, catalog, installed, install, cancel, remove, rollback, verifyInstalled, activeManifest, packDir }
}

module.exports = { createPackStore, PackError }
