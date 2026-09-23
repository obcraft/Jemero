#!/usr/bin/env node
// The offline acceptance test, driven through the real app.
//
//   npm run e2e:offline                 dev app (Vite), packs from packs-dist/
//   JEMERO_APP=/path/Jemero.app npm run e2e:offline    a packaged build
//
// Run 1, online: ask for a component that needs a formula. The model has to
// choose the KaTeX pack, the app installs and verifies it, and the canvas has
// to show KaTeX-rendered math. Run 2, after quitting: the network is "off"
// (JEMERO_OFFLINE=1, no pack server), the saved component must render with
// KaTeX again, and a refinement must too. Every external request attempt is
// read from the app's log and reported.
//
// Isolated from the copy you use: its own profile and data folder, and its
// own model server port. Models are read from your models folder.
import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { openLibrary } = require('../electron/library-db.cjs')
const { startStaticServer } = require('../electron/static-server.cjs')

// A packaged app has no pack host built in: for its online run, packs-dist is
// published on loopback, standing in for the real pack server.
let packHost = null

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const APP = process.env.JEMERO_APP ?? null
// Acceptance runs on the 14B: the 1.5B can't reliably write a working component
// (E2E_MODEL=bartowski/Qwen2.5-Coder-1.5B-Instruct-Q8_0 for a quick smoke run).
const MODEL = process.env.E2E_MODEL ?? 'bartowski/Qwen2.5-Coder-14B-Instruct-Q4_K_M'
const MODELS = process.env.JEMERO_MODELS ?? path.join(os.homedir(), 'Library/Application Support/Jemero/models')
const LLM_PORT = 8758
const DEBUG_PORT = 9333
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'jemero-e2e-'))
const HOME = path.join(WORK, 'home')
const REPORT = path.join(ROOT, 'output', `e2e-offline-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
const PROMPT = 'A card that shows the quadratic formula typeset with KaTeX, with one line explaining it'
const REFINE = 'Add a second formula below it: the Pythagorean theorem, also typeset with KaTeX'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => console.log('[e2e]', ...a)
const results = { model: MODEL, app: APP ?? 'dev', steps: [], external: [] }
const step = (name, ok, detail = '') => {
  results.steps.push({ name, ok, detail })
  log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) throw new Error(`${name} failed${detail ? `: ${detail}` : ''}`)
}

// --- the app -----------------------------------------------------------------

function launch({ offline }) {
  fs.mkdirSync(HOME, { recursive: true })
  const env = {
    ...process.env,
    JEMERO_HOME: HOME,
    JEMERO_USER_DATA: path.join(WORK, 'profile'),
    JEMERO_MODELS: MODELS,
    JEMERO_MODEL: MODEL,
    JEMERO_URL: `http://127.0.0.1:${LLM_PORT}`,
    JEMERO_KEEP_WARM: '1',
    JEMERO_E2E: '1',
    ...(offline
      ? { JEMERO_OFFLINE: '1', JEMERO_PACKS_URL: 'http://127.0.0.1:9' }
      : packHost
        ? { JEMERO_PACKS_URL: packHost.url }
        : {}),
  }
  const [cmd, args] = APP
    ? [path.join(APP, 'Contents/MacOS', path.basename(APP, '.app')), [`--remote-debugging-port=${DEBUG_PORT}`]]
    : ['npx', ['electron', '.', `--remote-debugging-port=${DEBUG_PORT}`]]
  const child = spawn(cmd, args, { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] })
  const out = fs.createWriteStream(path.join(WORK, `app-${offline ? 'offline' : 'online'}.log`))
  child.stdout.pipe(out)
  child.stderr.pipe(out)
  return child
}

async function quit(child) {
  child.kill('SIGTERM')
  for (let i = 0; i < 40 && child.exitCode === null; i++) await sleep(250)
  if (child.exitCode === null) child.kill('SIGKILL')
  await sleep(1000)
}

// --- Chrome DevTools protocol, just enough of it ------------------------------

async function connect(timeoutMs = 180_000) {
  const until = Date.now() + timeoutMs
  let page
  while (Date.now() < until) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json`)).json()
      page = targets.find((t) => t.type === 'page' && /^http:\/\/(127\.0\.0\.1|localhost):\d+\/(#.*)?$/.test(t.url))
      if (page) break
    } catch {}
    await sleep(500)
  }
  if (!page) throw new Error('The app window never loaded')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)))
  let id = 0
  const pending = new Map()
  const listeners = new Set()
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data)
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)
    } else for (const fn of listeners) fn(msg)
  }
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const n = ++id
      pending.set(n, { resolve, reject })
      ws.send(JSON.stringify({ id: n, method, params, ...(sessionId ? { sessionId } : {}) }))
    })
  // The canvas may be an out-of-process frame: attach to it as it appears.
  const frames = new Map() // sessionId -> url
  listeners.add((m) => {
    if (m.method === 'Target.attachedToTarget' && m.params.targetInfo.type === 'iframe') {
      frames.set(m.params.sessionId, m.params.targetInfo.url)
    }
    if (m.method === 'Target.detachedFromTarget') frames.delete(m.params.sessionId)
  })
  await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true })
  await send('Page.enable')
  await send('Runtime.enable')
  const consoleLog = fs.createWriteStream(path.join(WORK, 'renderer-console.log'), { flags: 'a' })
  listeners.add((m) => {
    if (m.method === 'Runtime.consoleAPICalled') {
      consoleLog.write(`${new Date().toISOString()} ${m.params.type}: ${m.params.args.map((a) => a.value ?? a.description ?? '').join(' ')}\n`)
    }
    if (m.method === 'Runtime.exceptionThrown') {
      consoleLog.write(`${new Date().toISOString()} EXCEPTION: ${m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text}\n`)
    }
  })

  const evaluate = async (expression, sessionId) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId)
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
    return r.result.value
  }

  /** Run code in the canvas, whether it's in-process or an OOPIF. */
  const inCanvas = async (expression) => {
    // An out-of-process canvas is attached before it navigates, so its URL is
    // asked for, not remembered.
    for (const sid of frames.keys()) {
      const href = await evaluate('location.href', sid).catch(() => '')
      if (href.includes('/kits/stage.html')) return evaluate(expression, sid)
    }
    const { frameTree } = await send('Page.getFrameTree')
    const child = (frameTree.childFrames ?? []).find((f) => f.frame.url.includes('/kits/stage.html'))
    if (!child) return undefined
    const { executionContextId } = await send('Page.createIsolatedWorld', { frameId: child.frame.id, worldName: 'e2e' })
    const r = await send('Runtime.evaluate', { expression, contextId: executionContextId, returnByValue: true })
    return r.result.value
  }

  const waitFor = async (what, expression, timeoutMs, where = evaluate) => {
    const until = Date.now() + timeoutMs
    for (;;) {
      const v = await where(expression).catch(() => undefined)
      if (v) return v
      if (Date.now() > until) throw new Error(`Timed out waiting for ${what}`)
      await sleep(500)
    }
  }

  /** What the canvas looks like from outside, for a failure report. */
  const diagnose = async () => {
    const targets = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json`)).json().catch(() => [])
    const { frameTree } = await send('Page.getFrameTree').catch(() => ({ frameTree: {} }))
    const app = await evaluate(`({
      src: document.querySelector('.stage-frame')?.getAttribute('src')?.slice(0, 300),
      empty: document.querySelector('.canvas-empty')?.textContent,
      error: document.querySelector('.canvas-error')?.textContent,
      tab: document.querySelector('.tab.active')?.textContent,
    })`).catch((e) => ({ error: e.message }))
    const inside = await inCanvas(`({ body: document.body.innerHTML.slice(0, 600), map: document.querySelector('script[type=importmap]')?.textContent.includes('katex') })`).catch((e) => e.message)
    return {
      targets: targets.map((t) => `${t.type} ${t.url.slice(0, 120)}`),
      oopifs: [...frames.values()],
      childFrames: (frameTree.childFrames ?? []).map((f) => f.frame.url.slice(0, 120)),
      app,
      inside,
    }
  }

  return { ws, evaluate, inCanvas, waitFor, diagnose, close: () => ws.close() }
}

const TYPE_AND_SEND = (text) => `(() => {
  const ta = document.querySelector('.composer textarea')
  if (!ta) return false
  const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
  set.call(ta, ${JSON.stringify(text)})
  ta.dispatchEvent(new Event('input', { bubbles: true }))
  return true
})()`
const CLICK_SEND = `(() => { const b = document.querySelector('.composer .send'); if (!b || b.disabled) return false; b.click(); return true })()`
const IDLE = `!document.querySelector('.composer .stop') && !document.querySelector('.pack-ask')`
const LAST_ERROR = `(() => { const e = [...document.querySelectorAll('.turn-error, .turn .error, [class*="error"]')].map((n) => n.textContent.trim()).filter(Boolean); return e.at(-1) ?? '' })()`
const CANVAS_KATEX = `(() => {
  const k = document.querySelector('.katex')
  if (!k) return false
  const font = getComputedStyle(k).fontFamily
  const fontsLoaded = [...document.fonts].some((f) => f.family.includes('KaTeX') && f.status === 'loaded')
  return { spans: document.querySelectorAll('.katex').length, font, fontsLoaded, text: k.textContent.slice(0, 60) }
})()`

/**
 * When the preview shows an error, press "Fix with the model" the way a
 * person would, up to `tries` times, then look for KaTeX in the canvas.
 */
async function katexAfterFixes(app, tries = 2) {
  for (let fix = 0; ; fix++) {
    const k = await app.waitFor('KaTeX in the canvas', CANVAS_KATEX, 20_000, app.inCanvas).catch(() => null)
    if (k) return k
    const error = await app.evaluate(`document.querySelector('.canvas-error')?.textContent ?? ''`).catch(() => '')
    if (!error || fix >= tries) {
      results.diagnosis = await app.diagnose()
      throw new Error(`KaTeX never appeared in the canvas${error ? `: ${error.slice(0, 200)}` : ''}`)
    }
    log(`canvas error, pressing Fix with the model (${fix + 1}/${tries}): ${error.slice(0, 120)}`)
    const before = readLibrary().items[0]?.versions.length ?? 0
    await app.evaluate(`document.querySelector('.canvas-error .btn')?.click()`)
    const until = Date.now() + 600_000
    while ((readLibrary().items[0]?.versions.length ?? 0) <= before) {
      const last = readLibrary().items[0]?.turns.at(-1)
      if (last?.role === 'assistant' && last.error && last.at > Date.now() - 5000) break
      if (Date.now() > until) throw new Error('Timed out waiting for the fix')
      await sleep(1000)
    }
    await app.waitFor('the app to go idle', IDLE, 60_000)
    await sleep(1500)
  }
}

const CANVAS_OK = `(() => {
  const root = document.getElementById('jm-root')
  return !!root && root.children.length > 0 && !root.querySelector('.jm-error')
})()`

/** The canvas shows the component (no error box), pressing Fix up to twice if it doesn't. */
async function renderedAfterFixes(app, tries = 2) {
  for (let fix = 0; ; fix++) {
    const ok = await app.waitFor('the component in the canvas', CANVAS_OK, 20_000, app.inCanvas).catch(() => false)
    if (ok) return true
    const error = await app.evaluate(`document.querySelector('.canvas-error')?.textContent ?? ''`).catch(() => '')
    if (!error || fix >= tries) return false
    log(`canvas error, pressing Fix with the model (${fix + 1}/${tries}): ${error.slice(0, 120)}`)
    const before = readLibrary().items[0]?.versions.length ?? 0
    await app.evaluate(`document.querySelector('.canvas-error .btn')?.click()`)
    const until = Date.now() + 600_000
    while ((readLibrary().items[0]?.versions.length ?? 0) <= before && Date.now() < until) await sleep(1000)
    await app.waitFor('the app to go idle', IDLE, 60_000)
    await sleep(1500)
  }
}

/** A small model fails some attempts (loops, no file); retry the way a user would. */
async function generateWithRetry(app, text, { expectAsk }, tries = 3) {
  for (let attempt = 1; ; attempt++) {
    try {
      await generate(app, text, { expectAsk: expectAsk && attempt === 1 })
      results.steps.push({ name: `generated in ${attempt} attempt(s)`, ok: true, detail: text.slice(0, 40) })
      return
    } catch (err) {
      if (!/generation ended without a version/.test(err.message) || attempt >= tries) throw err
      log(`attempt ${attempt} failed (${err.message.slice(0, 140)}); retrying`)
    }
  }
}

async function generate(app, text, { expectAsk }) {
  // A new item goes to the top of the library; a refinement adds to the top one.
  const before = readLibrary().items[0]
  const topBefore = before?.id
  const versionsBefore = before?.versions.length ?? 0
  await app.waitFor('the composer', `(${IDLE}) && !!document.querySelector('.composer textarea')`, 120_000)
  await app.waitFor('the model to be ready', `!document.querySelector('.composer textarea')?.placeholder.includes('model')`, 180_000)
  step(`type: ${text.slice(0, 40)}…`, await app.evaluate(TYPE_AND_SEND(text)))
  await sleep(200)
  step('send', await app.waitFor('the send button', CLICK_SEND, 10_000))
  if (expectAsk) {
    const ask = await app.waitFor('the install prompt', `document.querySelector('.pack-ask')?.textContent ?? ''`, 180_000)
    step('model chose the KaTeX pack and asked to install it', /KaTeX/.test(ask), ask)
    await app.evaluate(`document.querySelector('.pack-ask .btn:not(.ghost)').click()`)
  }
  // Done means the library says so: a new version, or an answer with an error.
  const until = Date.now() + 600_000
  for (;;) {
    const item = readLibrary().items[0]
    const fresh = item && item.id !== topBefore
    const last = item?.turns.at(-1)
    if (item && item.versions.length > (fresh ? 0 : versionsBefore)) break
    if ((fresh || item?.turns.length > (before?.turns.length ?? 0)) && last?.role === 'assistant' && (last.error || last.text === 'Stopped.')) {
      throw new Error(`generation ended without a version: ${last.error ?? last.text}`)
    }
    if (Date.now() > until) throw new Error('Timed out waiting for the generation to finish')
    await sleep(1000)
  }
  await app.waitFor('the app to go idle', IDLE, 60_000)
  await sleep(1500)
}

/** The app's library, read from its SQLite database (WAL: safe while the app writes). */
function readLibrary() {
  if (!fs.existsSync(path.join(HOME, 'jemero.db'))) return { items: [] }
  const lib = openLibrary(HOME)
  try {
    return lib.load()
  } finally {
    lib.close()
  }
}

// --- the test ----------------------------------------------------------------

async function main() {
  if (!APP && !fs.existsSync(path.join(ROOT, 'packs-dist', 'index.signed.json'))) throw new Error('Run `npm run packs` first')
  fs.mkdirSync(HOME, { recursive: true })
  // Skip first-run prompts; watch the canvas, not the code tab.
  fs.writeFileSync(
    path.join(HOME, 'settings.json'),
    JSON.stringify({ quantizePrompt: false, setupDone: true, autoSwitchTabs: false, planFirst: false }, null, 2),
  )
  log(`work folder ${WORK}`)

  // Run 1: online.
  if (APP) packHost = await startStaticServer(path.join(ROOT, 'packs-dist'))
  let child = launch({ offline: false })
  let app = await connect()
  try {
    await generateWithRetry(app, PROMPT, { expectAsk: true })
    const lib = readLibrary()
    const version = lib.items[0]?.versions.at(-1)
    step('a version was saved', !!version, (await app.evaluate(LAST_ERROR)) || '')
    step('it imports katex', /from\s*['"]katex['"]/.test(Object.values(version.files).join('\n')))
    step('its lock records KaTeX 0.18.7', version.packs?.packs?.katex === '0.18.7', JSON.stringify(version.packs))
    const installed = JSON.parse(fs.readFileSync(path.join(HOME, 'packs', 'installed.json'), 'utf8')).packs
    step('KaTeX is installed and active', installed.katex?.version === '0.18.7')
    const k = await katexAfterFixes(app)
    step('the preview renders KaTeX with its local fonts', k.spans > 0 && k.fontsLoaded, JSON.stringify(k))
    results.online = k
  } finally {
    app.close()
    await quit(child)
    await packHost?.close()
  }

  // Run 2: restarted, network off.
  fs.mkdirSync(path.join(HOME, 'logs'), { recursive: true })
  fs.writeFileSync(path.join(HOME, 'logs', 'external-requests.jsonl'), '', { flag: 'a' })
  const before = fs.readFileSync(path.join(HOME, 'logs', 'external-requests.jsonl'), 'utf8').split('\n').filter(Boolean).length
  child = launch({ offline: true })
  app = await connect()
  try {
    const k = await app.waitFor('KaTeX in the reopened component', CANVAS_KATEX, 120_000, app.inCanvas)
    step('offline after restart: the saved component renders KaTeX', k.spans > 0 && k.fontsLoaded, JSON.stringify(k))
    await generateWithRetry(app, REFINE, { expectAsk: false })
    const lib = readLibrary()
    const version = lib.items[0].versions.at(-1)
    step('offline refinement saved a new version', lib.items[0].versions.length >= 2, (await app.evaluate(LAST_ERROR)) || '')
    step('it still uses KaTeX 0.18.7', version.packs?.packs?.katex === '0.18.7', JSON.stringify(version.packs))
    const k2 = await katexAfterFixes(app)
    step('offline refinement renders KaTeX', k2.spans >= 1 && k2.fontsLoaded, JSON.stringify(k2))
    results.offline = k2

    // A block and a section, built from scratch while offline.
    for (const [kind, text] of [
      ['block', 'A sign-in form with email, password, a remember-me checkbox and a submit button'],
      ['section', 'A pricing section with three plans, a highlighted middle plan and a feature list each'],
    ]) {
      await app.evaluate(`document.querySelector('.rail-btn[aria-label="New chat"]').click()`)
      await app.waitFor('the start screen', `!!document.querySelector('.start .kind-switch')`, 20_000)
      await app.evaluate(`[...document.querySelectorAll('.start .kind-switch .seg')].find((b) => b.textContent.toLowerCase() === '${kind}')?.click()`)
      await sleep(300)
      await generateWithRetry(app, text, { expectAsk: false })
      const item = readLibrary().items[0]
      step(`offline ${kind} saved`, item?.kind === kind && item.versions.length > 0, item?.name)
      const rendered = await renderedAfterFixes(app)
      step(`offline ${kind} renders`, rendered, item?.name)
    }
  } finally {
    app.close()
    await quit(child)
    try {
      execFileSync('/bin/sh', ['-c', `lsof -nP -ti tcp:${LLM_PORT} -sTCP:LISTEN | xargs kill 2>/dev/null || true`])
    } catch {}
  }

  const lines = fs.readFileSync(path.join(HOME, 'logs', 'external-requests.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  results.external = lines
  const offlineLines = lines.slice(before)
  step(
    'offline run: no external request got through',
    offlineLines.every((l) => l.blocked),
    `${offlineLines.length} attempt(s), all blocked${offlineLines.length ? ': ' + [...new Set(offlineLines.map((l) => new URL(l.url).host))].join(', ') : ''}`,
  )
}

main()
  .then(() => (results.ok = true))
  .catch((err) => {
    results.ok = false
    results.error = err.message
    console.error('[e2e]', err.message)
    process.exitCode = 1
  })
  .finally(() => {
    fs.mkdirSync(path.dirname(REPORT), { recursive: true })
    fs.writeFileSync(REPORT, JSON.stringify(results, null, 2))
    log(`report: ${path.relative(ROOT, REPORT)} · logs: ${WORK}`)
  })
