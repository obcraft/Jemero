const { app, BrowserWindow, Menu, ipcMain, nativeTheme, shell, dialog } = require('electron')
const { spawn } = require('node:child_process')
const net = require('node:net')
const path = require('node:path')
const { ensureModel, switchModel, probe, stopServing } = require('./model.cjs')
const { detect, describe } = require('./hardware.cjs')
const { recommend, planFor, entryFor, setPreferLight, quantizationSupport } = require('./catalog.cjs')
const hub = require('./hub.cjs')
const models = require('./install.cjs')
const runtime = require('./runtime.cjs')
const { startServer } = require('./serve.cjs')
const { createPackStore } = require('./pack-store.cjs')
const { startStaticServer } = require('./static-server.cjs')
const { createPackRoutes } = require('./pack-routes.cjs')
const { installNetGuard, guardFetch } = require('./net-guard.cjs')
const { openLibrary } = require('./library-db.cjs')

// Every external request is recorded; JEMERO_OFFLINE=1 refuses them as an
// unplugged network would (the offline check runs with it).
const externalLog = () => path.join(runtime.appSupport(), 'logs', 'external-requests.jsonl')
guardFetch(externalLog(), { offline: process.env.JEMERO_OFFLINE === '1' })

const isDev = !app.isPackaged

// JEMERO_THEME=light|dark overrides the OS for this run, the renderer's
// 'System' setting follows nativeTheme, so both themes can be checked on one Mac.
if (['light', 'dark'].includes(process.env.JEMERO_THEME)) nativeTheme.themeSource = process.env.JEMERO_THEME

let win = null
let vite = null

/** The window and the splash are painted before the renderer has any CSS, so
 *  they have to read the OS theme themselves or the first frame flashes. */
const chrome = () =>
  nativeTheme.shouldUseDarkColors
    ? { bg: '#0b0d11', text: '#e6e9ef', muted: '#8b95a6', accent: '#7c6cf7' }
    : { bg: '#f4f5f8', text: '#1c2330', muted: '#5f6b7d', accent: '#5a48e8' }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Status and error text goes into the splash's HTML; a reason can quote a log line with `<` in it. */
const escapeHtml = (text) =>
  String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 960,
    minHeight: 620,
    show: false,
    backgroundColor: chrome().bg,
    // Native macOS chrome: no title bar, traffic lights floated over our header.
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 20 },
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  })

  win.once('ready-to-show', () => win.show())

  // External links belong in the real browser, not in this window. Web links
  // only: any other scheme would hand an arbitrary URL to the OS to launch.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })

  return win
}

/** Splash text while the 9 GB model loads, so the window isn't blank. */
function showBootScreen(message) {
  if (!win) return
  const c = chrome()
  const html = `<!doctype html><meta charset="utf-8"><style>
    html,body{height:100%;margin:0;background:${c.bg};color:${c.muted};
      font-family:ui-sans-serif,-apple-system,"Segoe UI",sans-serif;
      display:grid;place-items:center;-webkit-app-region:drag}
    .w{text-align:center;animation:rise .4s cubic-bezier(.16,1,.3,1)}
    .l{color:${c.accent};font-size:30px;margin-bottom:14px}
    .t{color:${c.text};font-size:14px;font-weight:600;margin-bottom:6px}
    .m{font-size:12px;white-space:pre-wrap;line-height:1.55}
    .d{width:8px;height:8px;border-radius:50%;background:${c.accent};margin:16px auto 0;
      animation:p 1.2s ease-in-out infinite}
    @keyframes p{0%,100%{opacity:.25;transform:scale(.8)}50%{opacity:1;transform:scale(1.2)}}
    @keyframes rise{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
  </style><div class="w"><div class="l">⬢</div><div class="t">Jemero</div>
  <div class="m">${escapeHtml(message)}</div><div class="d"></div></div>`
  win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
}

async function waitForVite(url, attempts = 60) {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1500) })
      if (res.ok) return true
    } catch {
      /* not up yet */
    }
    await sleep(500)
  }
  return false
}

/** Ask the OS for a free port, so a busy 5273 can't strand us on the splash. */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })
}

/** --strictPort makes Vite fail loudly rather than silently drifting elsewhere. */
function startVite(port) {
  vite = spawn('npx', ['vite', '--port', String(port), '--strictPort'], {
    cwd: path.join(__dirname, '..'),
    stdio: 'inherit',
    env: process.env,
  })
  vite.on('exit', (code) => {
    if (code && code !== 0 && win && !win.isDestroyed()) {
      showBootScreen(`Dev server exited with code ${code}.\nIs another copy already running?`)
    }
  })
}

function buildMenu() {
  const template = [
    { role: 'appMenu' },
    { role: 'editMenu' },
    {
      label: 'Model',
      submenu: [
        {
          label: 'Browse Local Models…',
          accelerator: 'CmdOrCtrl+L',
          click: () => win?.webContents.send('menu:open', 'models'),
        },
        {
          label: 'Settings…',
          accelerator: 'CmdOrCtrl+,',
          click: () => win?.webContents.send('menu:open', 'settings'),
        },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

/** Push download/activation progress at the window, if there still is one. */
function emit(payload) {
  if (win && !win.isDestroyed()) win.webContents.send('models:progress', payload)
}

/**
 * The model surface the renderer talks to. Everything here is main-process work
 *, reading hardware, writing into the model store, restarting the
 * llama.cpp server, so the renderer only ever sees plain JSON.
 */
/**
 * Settings and the component library live in files, not the renderer's
 * localStorage: the UI is served from a fresh port each launch, localStorage is
 * keyed by origin (port included), so anything stored there was quietly lost on
 * every restart.
 */
function registerStoreIpc(name, { pretty = false } = {}) {
  const fs = require('node:fs')
  const file = path.join(runtime.appSupport(), `${name}.json`)
  // Synchronous on purpose: the renderer needs it before its first paint, or
  // it flashes the wrong theme or an empty library. One small file, read once.
  ipcMain.on(`${name}:load`, (e) => {
    try {
      e.returnValue = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
      e.returnValue = null
    }
  })
  ipcMain.on(`${name}:save`, (_e, value) => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      // Written aside and renamed into place, so a crash mid-write can't leave
      // half a library behind.
      const tmp = `${file}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(value, null, pretty ? 2 : 0) + '\n')
      fs.renameSync(tmp, file)
    } catch {
      /* disk full or read-only, keep running on what's in memory */
    }
  })
}

/**
 * The pack store, created on first use. Packs come from JEMERO_PACKS_URL; in
 * development, without it, from packs-dist/ (npm run packs) served on
 * 127.0.0.1, so the real download path runs. A packaged build with no source
 * still lists and serves what is installed.
 */
let packStore = null
let packRoutes = null
function packs() {
  packStore ??= (async () => {
    let sourceUrl = process.env.JEMERO_PACKS_URL ?? null
    const dist = path.join(__dirname, '..', 'packs-dist')
    if (!sourceUrl && isDev && require('node:fs').existsSync(path.join(dist, 'index.signed.json'))) {
      sourceUrl = (await startStaticServer(dist)).url
    }
    const store = createPackStore({ root: path.join(runtime.appSupport(), 'packs'), sourceUrl })
    packRoutes = createPackRoutes(store)
    await packRoutes.rebuild()
    return store
  })()
  return packStore
}

/** After an install or removal: re-verify what's served, and let the canvas reload its import map. */
async function packsChanged() {
  await packRoutes?.rebuild()
  if (win && !win.isDestroyed()) win.webContents.send('packs:changed')
}

/**
 * In development Vite serves the app, so the pack routes run on their own
 * loopback server and Vite proxies /packs to it (vite.config.ts).
 */
async function startDevPackRoutes() {
  await packs()
  const http = require('node:http')
  const server = http.createServer((req, res) => {
    packRoutes.handle(req, res).then(
      (handled) => handled || res.writeHead(404).end(),
      (err) => {
        console.error('[packs]', req.url, err.message)
        if (!res.headersSent) res.writeHead(500)
        res.end()
      },
    )
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  process.env.JEMERO_PACK_ROUTES = `http://127.0.0.1:${server.address().port}`
}

function registerPackIpc() {
  ipcMain.handle('packs:list', async () => {
    const store = await packs()
    const installed = await store.installed()
    try {
      const { catalog, fromCache } = await store.catalog()
      return { ok: true, packs: catalog.packs, installed, fromCache, source: store.sourceUrl }
    } catch (err) {
      return { ok: false, reason: err.message, packs: [], installed, fromCache: true, source: store.sourceUrl }
    }
  })
  ipcMain.handle('packs:install', async (_e, id) => {
    const res = await (await packs()).install(id, (p) => {
      // 'done' goes out once the canvas can actually load the pack.
      if (p.phase === 'done') return
      if (win && !win.isDestroyed()) win.webContents.send('packs:progress', p)
    })
    if (res.ok) {
      await packsChanged()
      if (win && !win.isDestroyed()) win.webContents.send('packs:progress', { id, phase: 'done' })
    }
    return res
  })
  // "Offline ready", the parts only this process can check: the runtime
  // starts, a model answers, every installed pack still verifies. The canvas
  // sample and saved work are checked in the renderer (OfflineCheck.tsx).
  ipcMain.handle('offline:check', async () => {
    const { URL_BASE } = require('./model.cjs')
    const runtimeCheck = runtime.verifyRuntime()
    let modelCheck
    const serving = await probe()
    if (!serving) {
      modelCheck = { ok: false, detail: 'No model is running.' }
    } else {
      try {
        const res = await fetch(`${URL_BASE}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: serving, messages: [{ role: 'user', content: 'Say OK.' }], max_tokens: 2, temperature: 0 }),
          signal: AbortSignal.timeout(60_000),
        })
        modelCheck = res.ok ? { ok: true, detail: serving } : { ok: false, detail: `${serving} answered ${res.status}` }
      } catch (err) {
        modelCheck = { ok: false, detail: `${serving} didn’t answer: ${err.message}` }
      }
    }
    const store = await packs()
    const installed = await store.installed()
    const packChecks = {}
    for (const id of Object.keys(installed)) {
      const problems = await store.verifyInstalled(id)
      packChecks[id] = problems.length ? { ok: false, detail: problems[0] } : { ok: true, detail: installed[id].version }
    }
    return { runtime: runtimeCheck, model: modelCheck, packs: packChecks }
  })
  ipcMain.handle('packs:rollback', async (_e, id) => {
    const res = await (await packs()).rollback(id)
    if (res.ok) await packsChanged()
    return res
  })
  ipcMain.handle('packs:cancel', async (_e, id) => ({ ok: (await packs()).cancel(id) }))
  ipcMain.handle('packs:remove', async (_e, id) => {
    const res = await (await packs()).remove(id)
    if (res.ok) await packsChanged()
    return res
  })
}

/**
 * The component library lives in SQLite (library-db.cjs): every version,
 * file and turn, plus the files of a generation still in progress, saved as
 * they're written. An old library.json is moved in on first launch.
 */
function registerLibraryIpc() {
  const lib = openLibrary(runtime.appSupport())
  try {
    if (lib.migrateFromJson(path.join(runtime.appSupport(), 'library.json'))) console.log('[library] moved library.json into jemero.db')
  } catch (err) {
    console.error('[library] could not import library.json:', err.message)
  }
  ipcMain.on('library:load', (e) => {
    try {
      e.returnValue = lib.load()
    } catch (err) {
      console.error('[library] load failed:', err.message)
      e.returnValue = null
    }
  })
  const guarded = (what, fn) => (...args) => {
    try {
      fn(...args)
    } catch (err) {
      console.error(`[library] ${what} failed:`, err.message)
    }
  }
  // Awaited by the renderer, which keeps what failed to save and sends it again with the next change.
  ipcMain.handle('library:save', (_e, changes) => {
    try {
      lib.saveChanges(changes)
    } catch (err) {
      console.error('[library] save failed:', err.message)
      throw err
    }
  })
  ipcMain.on('library:draft', guarded('draft', (_e, itemId, files) => lib.saveDraft(itemId, files)))
  ipcMain.on('library:clear-draft', guarded('clear draft', (_e, itemId) => lib.clearDraft(itemId)))
  ipcMain.handle('library:drafts', () => lib.drafts())
  app.on('will-quit', () => lib.close())
}

function registerModelIpc() {
  ipcMain.handle('models:chat-budget', async (_e, request) => {
    const { chatBudget } = require('./chat-context.cjs')
    const { URL_BASE } = require('./model.cjs')
    return chatBudget(URL_BASE, request)
  })

  ipcMain.handle('models:device', () => ({ ...detect(), summary: describe() }))

  ipcMain.handle('models:quantization', () => quantizationSupport(detect()))
  ipcMain.handle('models:set-quantization', (_e, on) => setPreferLight(on))

  ipcMain.handle('models:catalog', async (_e, priority = 'balanced') => {
    const device = detect()
    const { models: ranked, recommended, reasons } = recommend(device, priority)
    const local = await models.installed()
    // A downloaded (or half-downloaded) quant that isn't its family's pick under
    // this priority, or a model found through search, still has to appear, or
    // "Downloaded" would silently hide it.
    const shown = new Set(ranked.map((m) => m.modelId))
    const extra = local
      .filter((m) => !shown.has(m.id))
      .map((m) => planFor(m.id, device))
      .filter(Boolean)
    const free = await models.freeBytes()
    return {
      device: { ...device, summary: describe(device) },
      models: [...ranked, ...extra],
      recommended,
      reasons,
      priority,
      installed: local,
      active: await probe(),
      modelsFolder: models.modelsRoot(),
      runtime: runtime.describe(),
      freeBytes: Number.isFinite(free) ? free : null,
    }
  })

  ipcMain.handle('models:search', async (_e, query, priority = 'balanced', page = 0) => {
    try {
      return { ok: true, ...await hub.searchPage(query, detect(), priority, page) }
    } catch (err) {
      const offline = err.name === 'TimeoutError' || err.cause?.code === 'ENOTFOUND' || err.message === 'fetch failed'
      return { ok: false, reason: offline ? 'Can’t reach Hugging Face. Check your connection.' : err.message }
    }
  })

  ipcMain.handle('models:install', async (_e, modelId) => {
    const plan = planFor(modelId, detect())
    if (!plan) return { ok: false, reason: `Unknown model: ${modelId}` }
    if (!plan.fits) return { ok: false, reason: plan.unsupportedReason ?? `${plan.label} cannot run within this Mac’s memory and context limits.` }
    // A model found through search takes its catalog entry along, into model.json.
    const { entry } = entryFor(modelId)
    try {
      return await models.install(entry.source === 'hub' ? { ...plan, entry } : plan, emit)
    } catch (err) {
      emit({ id: modelId, phase: 'error', message: err.message })
      return { ok: false, reason: err.message }
    }
  })

  ipcMain.handle('models:cancel', (_e, modelId) => ({ ok: models.cancel(modelId) }))

  ipcMain.handle('models:remove', async (_e, modelId) => {
    const serving = await probe()
    if (serving === modelId) return { ok: false, reason: 'That model is currently serving. Switch first.' }
    return models.remove(modelId)
  })

  ipcMain.handle('models:activate', async (_e, modelId) => {
    console.log(`[models] switching to ${modelId}`)
    emit({ id: modelId, phase: 'activating' })
    const res = await switchModel(modelId, (status) => emit({ id: modelId, phase: 'activating', message: status }))
    emit({ id: modelId, phase: res.ok ? 'active' : 'error', message: res.ok ? undefined : res.reason })
    return res
  })
}

async function bootstrap() {
  // In development the Dock would show Electron's own icon (the name is fixed
  // by scripts/dev-name.mjs); the packaged app carries ours in its bundle.
  if (isDev && process.platform === 'darwin') app.dock.setIcon(path.join(__dirname, '..', 'build', 'icon.png'))
  buildMenu()
  // The preview boundary: nothing in a window may reach past loopback.
  installNetGuard(require('electron').session.defaultSession, externalLog())
  registerStoreIpc('settings', { pretty: true })
  registerLibraryIpc()
  registerModelIpc()
  registerPackIpc()
  // Before ensureModel, so the model picked at launch already follows the switch.
  try {
    const saved = JSON.parse(require('node:fs').readFileSync(path.join(runtime.appSupport(), 'settings.json'), 'utf8'))
    setPreferLight(saved?.quantize === true)
  } catch {
    /* first launch: no settings yet */
  }
  createWindow()
  showBootScreen('Starting…')

  // A missing model is not fatal: the window opens on the model picker, which
  // can download the right one for this Mac. Neither is a model that won't
  // load: the picker opens so another one can be chosen, or this one deleted
  // and downloaded again. Only a runtime that can't be found or fetched stops
  // us here, since without it no model can run at all.
  let result
  try {
    result = await ensureModel((status) => showBootScreen(status))
  } catch (err) {
    fail('Could not start the local model runtime', err.message)
    return
  }
  if (!result.ok && !result.needsModel) {
    dialog.showMessageBox(win, {
      type: 'warning',
      message: 'Could not load the last model',
      detail: `${result.reason}\n\nPick another model, or delete this one and download it again.`,
    })
  }

  let url
  if (isDev) {
    showBootScreen('Starting dev server…')
    await startDevPackRoutes()
    const port = process.env.JEMERO_DEV_PORT ? Number(process.env.JEMERO_DEV_PORT) : await freePort()
    const devUrl = `http://localhost:${port}`
    startVite(port)
    if (!(await waitForVite(devUrl))) {
      showBootScreen(`Dev server never came up at ${devUrl}`)
      return
    }
    url = devUrl
  } else {
    await packs()
    url = await startServer(path.join(__dirname, '..', 'dist'), { packRoutes })
  }

  // Nothing that can answer yet: land on the model picker instead of an app
  // that can't, with the right model for this Mac already selected.
  // JEMERO_OPEN=models|settings opens straight onto that panel.
  const open = result.ok ? process.env.JEMERO_OPEN : 'models'
  win.loadURL(open === 'models' || open === 'settings' ? `${url}#${open}` : url)

  // Dev affordance: JEMERO_CAPTURE=<path> writes a PNG of the window contents
  // once loaded, so the UI can be checked without screen-recording permission.
  if (process.env.JEMERO_CAPTURE) {
    win.webContents.once('did-finish-load', async () => {
      await sleep(5000)
      const img = await win.webContents.capturePage()
      require('node:fs').writeFileSync(process.env.JEMERO_CAPTURE, img.toPNG())
      console.log(`captured -> ${process.env.JEMERO_CAPTURE}`)
    })
  }
}

/** A failure nothing can recover from: say what it is, then quit when asked. */
function fail(message, detail) {
  console.error(`[boot] ${message}: ${detail}`)
  if (!win || win.isDestroyed()) return app.quit()
  showBootScreen(detail)
  dialog.showMessageBox(win, { type: 'error', message, detail, buttons: ['Quit'] }).then(() => app.quit())
}

// Two instances would start two model servers on one port and race each other
// writing library.json. Refuse the second launch and focus the window that
// already exists.
// A separate profile, so a test run doesn't collide with the copy in use.
if (process.env.JEMERO_USER_DATA) app.setPath('userData', process.env.JEMERO_USER_DATA)

if (!app.requestSingleInstanceLock()) {
  console.log('Jemero is already running, focusing that window.')
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!win || win.isDestroyed()) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  })
  app
    .whenReady()
    .then(bootstrap)
    .catch((err) => fail('Jemero could not start', err.stack ?? err.message))

  // One window is the whole app, so closing it quits, the macOS habit of
  // staying alive in the Dock would keep the model's memory held for nothing.
  app.on('window-all-closed', () => app.quit())

  // Quitting gives the memory back: the model server holds the weights and KV
  // cache (10+ GB for a 14B), and it runs as its own process, so it has to be
  // stopped explicitly or it outlives the window. The next launch reloads it,
  // a few seconds while macOS still has the file in its page cache.
  // Registered only in the primary instance: a second launch quits at once,
  // and must not take the running window's model down with it.
  // JEMERO_KEEP_WARM=1 keeps it loaded between launches instead.
  app.on('before-quit', () => {
    vite?.kill('SIGINT')
    if (!process.env.JEMERO_KEEP_WARM) stopServing()
  })
}
