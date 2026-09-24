// Serving a local model, entirely in-app.
//
// We run llama.cpp's llama-server ourselves (see runtime.cjs), with flags tuned
// for Apple Silicon, and speak its OpenAI-compatible API, the same API the
// renderer always used, so nothing above this file had to change.
//
// The server is spawned detached and deliberately left running when the app
// quits, so the next launch doesn't reload gigabytes of weights. Its pid lives
// in server.json, which is how we find *our* server again later without
// pattern-killing processes that might belong to someone else.
const { spawn, execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { detect } = require('./hardware.cjs')
const { recommend, planFor, lightSibling, TARGET_CTX } = require('./catalog.cjs')
const { installed, ggufPath, adoptAtomicChatModels } = require('./install.cjs')
const { ensureRuntime, appSupport } = require('./runtime.cjs')

// Our own port. 1337 is Atomic Chat's; sharing it is how two apps end up
// talking to each other's models.
const URL_BASE = process.env.JEMERO_URL ?? 'http://127.0.0.1:8757'
const PORT = Number(new global.URL(URL_BASE).port || 8757)

const statePath = () => path.join(appSupport(), 'server.json')
const logPath = () => path.join(appSupport(), 'logs', 'llama-server.log')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function readState() {
  try {
    return JSON.parse(fs.readFileSync(statePath(), 'utf8'))
  } catch {
    return {}
  }
}

function writeState(patch) {
  fs.mkdirSync(appSupport(), { recursive: true })
  fs.writeFileSync(statePath(), JSON.stringify({ ...readState(), ...patch }, null, 2) + '\n')
}

/**
 * The model id the server answers to, or null if nothing is ready to answer.
 * llama-server binds its port before it loads the weights and lists the model
 * on /v1/models the whole time, so only /health (503 until loaded) says ready.
 */
async function probe() {
  try {
    const health = await fetch(`${URL_BASE}/health`, { signal: AbortSignal.timeout(2000) })
    if (!health.ok) return null
    const res = await fetch(`${URL_BASE}/v1/models`, { signal: AbortSignal.timeout(2000) })
    if (!res.ok) return null
    const json = await res.json()
    return Array.isArray(json.data) && json.data.length ? json.data[0].id : null
  } catch {
    return null
  }
}

/** Is anything still bound to our port? A server that is loading answers /health with 503. */
async function listening() {
  try {
    await fetch(`${URL_BASE}/health`, { signal: AbortSignal.timeout(2000) })
    return true
  } catch {
    return false
  }
}

/** The process name of a pid, or '' if it no longer exists. */
function commandOf(pid) {
  try {
    return execFileSync('/bin/ps', ['-o', 'comm=', '-p', String(pid)], { encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}

/**
 * Deliberately the same configuration Atomic Chat runs llama.cpp with:
 *   -ngl 999               every layer on the GPU (unified memory: no copy cost)
 *   --flash-attn auto      llama.cpp enables it where the model supports it
 *   f16 KV cache           the default. An 8-bit cache was tried and made prompt
 *                          processing ~2x slower on Metal (long wait for the first
 *                          token) and produced "@@@@" garbage on small models
 *   --parallel 1 -kvu      one conversation, one unified cache
 *   --jinja                use each model's own chat template, so every model's
 *                          prompt format and thinking switch work as designed
 *   --reasoning-format auto  thinking goes to reasoning_content, never into the
 *                          answer the file parser reads
 */
function serverArgs(id, ctx) {
  return [
    '--model', ggufPath(id),
    '--alias', id,
    '--host', '127.0.0.1',
    '--port', String(PORT),
    '--ctx-size', String(ctx),
    '--n-gpu-layers', '999',
    '--flash-attn', 'auto',
    '--parallel', '1',
    '--kv-unified',
    '--jinja',
    '--reasoning-format', 'auto',
    '--no-webui',
  ]
}

/**
 * Which installed model to serve. In order: an explicit override, the model
 * the user last chose (a restart shouldn't undo their choice), the
 * recommendation for this Mac, then the best-scoring thing that's downloaded.
 */
async function choose() {
  await adoptAtomicChatModels()
  const device = detect()
  const { models, recommended } = recommend(device)
  const local = (await installed()).filter((m) => m.complete).map((m) => m.id)
  const byId = new Map(models.map((m) => [m.modelId, m]))

  const order = [
    process.env.JEMERO_MODEL,
    lightSibling(readState().chosen, local),
    readState().chosen,
    recommended,
    ...[...local].sort((a, b) => (byId.get(b)?.score ?? 0) - (byId.get(a)?.score ?? 0)),
  ].filter(Boolean)

  const id = order.find((candidate) => local.includes(candidate) && (byId.get(candidate) ?? planFor(candidate, device))?.fits) ?? null
  const plan = id ? byId.get(id) ?? planFor(id, device) : null
  return { id, ctx: plan?.ctx ?? Number(process.env.JEMERO_CTX ?? TARGET_CTX), recommended, installed: local, plan }
}

/**
 * Stop the server we started. Falls back to whatever llama-server holds our port.
 * A pid is only signalled while it still belongs to llama-server: the one in
 * server.json may be long gone and reused by an unrelated process.
 */
function stopServing() {
  const pids = new Set()
  const { pid } = readState()
  if (pid) pids.add(Number(pid))
  try {
    execFileSync('/usr/sbin/lsof', ['-nP', '-ti', `tcp:${PORT}`, '-sTCP:LISTEN'], { encoding: 'utf8' })
      .split('\n')
      .filter(Boolean)
      .forEach((p) => pids.add(Number(p)))
  } catch {
    /* nothing listening */
  }
  for (const p of pids) if (!/llama-server/.test(commandOf(p))) pids.delete(p)
  let stopped = 0
  for (const p of pids) {
    try {
      process.kill(p, 'SIGTERM')
      stopped++
    } catch {
      /* already gone */
    }
  }
  writeState({ pid: null, serving: null })
  return stopped
}

/** Wait for the port to be free, so the next server can bind it. */
async function waitForExit(ms = 8000) {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (!(await listening())) return
    await sleep(250)
  }
}

/** The server log keeps the last few launches, not every launch ever. */
const LOG_LIMIT = 8 * 1024 * 1024

/** The last `n` lines of the server log, read from its end rather than whole. */
function logTail(n) {
  let fd
  try {
    fd = fs.openSync(logPath(), 'r')
    const size = fs.fstatSync(fd).size
    const length = Math.min(size, 16 * 1024)
    const buf = Buffer.alloc(length)
    fs.readSync(fd, buf, 0, length, size - length)
    return buf.toString('utf8').split('\n').slice(-n).join('\n')
  } catch {
    return ''
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
}

/** Start `id` detached, then wait until it answers. */
async function serveModel(id, ctx, onStatus = () => {}) {
  const bin = await ensureRuntime(onStatus)
  fs.mkdirSync(path.dirname(logPath()), { recursive: true })
  let size = 0
  try {
    size = fs.statSync(logPath()).size
  } catch {
    /* no log yet */
  }
  const log = fs.openSync(logPath(), size > LOG_LIMIT ? 'w' : 'a')

  onStatus(`Loading ${id.split('/').pop()}…`)
  let child
  try {
    child = spawn(bin, serverArgs(id, ctx), {
      detached: true,
      stdio: ['ignore', log, log],
      cwd: path.dirname(bin),
    })
  } finally {
    // The child has its own copy of the descriptor.
    fs.closeSync(log)
  }
  child.unref()
  writeState({ pid: child.pid, serving: id, port: PORT, ctx })

  let exited = null
  // A binary that can't be executed fails here, not with an exit code.
  child.once('error', (err) => (exited = err.code ?? err.message))
  child.once('exit', (code) => (exited ??= code ?? -1))

  // Big models on a cold disk cache take a while; 3 minutes covers a 60 GB load.
  for (let i = 0; i < 360; i++) {
    const serving = await probe()
    if (serving) {
      onStatus('Model ready')
      return { ok: true, model: serving }
    }
    if (exited !== null) {
      const tail = logTail(12)
      writeState({ pid: null, serving: null })
      return { ok: false, reason: `The model server exited while loading (code ${exited}).\n\n${tail}` }
    }
    await sleep(500)
  }
  return { ok: false, reason: `The model server did not become ready in 3 minutes. Log: ${logPath()}` }
}

/**
 * Switch the served model. Remembered, so the next launch opens on it too.
 * Two models don't fit in wired memory at once, so the old one has to be gone
 * before the new one loads, hence stop, wait, then start.
 */
async function switchModel(id, onStatus = () => {}) {
  const device = detect()
  const plan = planFor(id, device)
  if (!plan) return { ok: false, reason: 'This model’s requirements are unknown. Select a model from the browser.' }
  if (!plan.fits) {
    return { ok: false, reason: plan.unsupportedReason ?? `${plan.label} needs about ${plan.needsGB} GB and this Mac can only give a model ${device.budgetGB} GB.` }
  }
  if (!(await installed()).some((m) => m.id === id && m.complete)) return { ok: false, reason: 'Download this model before using it.' }
  onStatus('Stopping the current model…')
  stopServing()
  await waitForExit()
  const res = await serveModel(id, plan?.ctx ?? TARGET_CTX, onStatus)
  if (res.ok) writeState({ chosen: id })
  return res
}

/** @returns {Promise<{ok: true, model?: string} | {ok: false, reason: string, needsModel?: boolean}>} */
async function ensureModel(onStatus = () => {}) {
  const serving = await probe()
  if (serving) {
    onStatus(`${serving.split('/').pop()} already serving`)
    return { ok: true, model: serving }
  }

  const { id, ctx, recommended } = await choose()
  if (!id) {
    const device = detect()
    const pick = recommend(device).models.find((m) => m.modelId === recommended)
    return {
      ok: false,
      needsModel: true,
      reason: pick
        ? `No model downloaded yet.\n\nBest for this ${device.machine} (${device.chip}, ${device.ramGB} GB):\n${pick.label} ${pick.quant}, ${pick.sizeGB} GB`
        : 'No model downloaded, and nothing in the catalog fits this machine.',
    }
  }
  return serveModel(id, ctx, onStatus)
}

module.exports = { ensureModel, switchModel, serveModel, stopServing, choose, probe, URL_BASE, PORT, logPath }
