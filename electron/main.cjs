const { app, BrowserWindow, Menu, ipcMain, nativeTheme, shell, dialog } = require('electron')
const { spawn } = require('node:child_process')
const net = require('node:net')
const path = require('node:path')
const { ensureModel, switchModel, probe, stopServing } = require('./model.cjs')
const { detect, describe } = require('./hardware.cjs')
const { recommend, planFor } = require('./catalog.cjs')
const models = require('./install.cjs')
const runtime = require('./runtime.cjs')
const { startServer } = require('./serve.cjs')

// WebContainer serves its preview from a *.webcontainer-api.io origin backed by a
// Service Worker inside a cross-origin iframe. Chromium only allows that when
// third-party storage partitioning is on, and Electron ships with it off — without
// this switch the preview pane shows "Enable Storage Partitioning".
app.commandLine.appendSwitch('enable-features', 'ThirdPartyStoragePartitioning')

const isDev = !app.isPackaged

// ATOMIC_THEME=light|dark overrides the OS for this run — the renderer's
// 'System' setting follows nativeTheme, so both themes can be checked on one Mac.
if (['light', 'dark'].includes(process.env.ATOMIC_THEME)) nativeTheme.themeSource = process.env.ATOMIC_THEME

let win = null
let vite = null

/** The window and the splash are painted before the renderer has any CSS, so
 *  they have to read the OS theme themselves or the first frame flashes. */
const chrome = () =>
  nativeTheme.shouldUseDarkColors
    ? { bg: '#0b0d11', text: '#e6e9ef', muted: '#8b95a6', accent: '#7c6cf7' }
    : { bg: '#f4f5f8', text: '#1c2330', muted: '#5f6b7d', accent: '#5a48e8' }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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
      // WebContainer's preview iframe is cross-origin; keep the default sandbox.
    },
  })

  win.once('ready-to-show', () => win.show())

  // External links belong in the real browser, not in this window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
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
  </style><div class="w"><div class="l">⬢</div><div class="t">Atomic Lovable</div>
  <div class="m">${message}</div><div class="d"></div></div>`
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
 * — reading hardware, writing into the model store, restarting the
 * llama.cpp server — so the renderer only ever sees plain JSON.
 */
function registerModelIpc() {
  ipcMain.handle('models:device', () => ({ ...detect(), summary: describe() }))

  ipcMain.handle('models:catalog', async (_e, priority = 'balanced') => {
    const device = detect()
    const { models: ranked, recommended, reasons } = recommend(device, priority)
    const local = await models.installed()
    // A downloaded quant that isn't its family's pick under this priority still
    // has to appear, or "Downloaded" would silently hide it.
    const shown = new Set(ranked.map((m) => m.modelId))
    const extra = local
      .filter((m) => m.complete && !shown.has(m.id))
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

  ipcMain.handle('models:install', async (_e, modelId) => {
    const plan = planFor(modelId, detect())
    if (!plan) return { ok: false, reason: `Unknown model: ${modelId}` }
    try {
      return await models.install(plan, emit)
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
    emit({ id: modelId, phase: 'activating' })
    const res = await switchModel(modelId, (status) => emit({ id: modelId, phase: 'activating', message: status }))
    emit({ id: modelId, phase: res.ok ? 'active' : 'error', message: res.ok ? undefined : res.reason })
    return res
  })
}

async function bootstrap() {
  buildMenu()
  registerModelIpc()
  createWindow()
  showBootScreen('Starting…')

  // A missing model is not a fatal error any more: the window opens on the
  // model picker, which can download the right one for this Mac. Anything else
  // (a runtime that can't be fetched, a server that won't start) still stops us here.
  const result = await ensureModel((status) => showBootScreen(status))
  if (!result.ok && !result.needsModel) {
    showBootScreen(result.reason)
    dialog.showMessageBox(win, {
      type: 'error',
      message: 'Could not start the local model',
      detail: result.reason,
      buttons: ['Quit'],
    })
    return
  }

  let url
  if (isDev) {
    showBootScreen('Starting dev server…')
    const port = process.env.ATOMIC_DEV_PORT ? Number(process.env.ATOMIC_DEV_PORT) : await freePort()
    const devUrl = `http://localhost:${port}`
    startVite(port)
    if (!(await waitForVite(devUrl))) {
      showBootScreen(`Dev server never came up at ${devUrl}`)
      return
    }
    url = devUrl
  } else {
    url = await startServer(path.join(__dirname, '..', 'dist'))
  }

  // Nothing downloaded yet: land on the model picker instead of an app that
  // can't answer, with the right model for this Mac already selected.
  // ATOMIC_OPEN=models|settings opens straight onto that panel.
  const open = result.needsModel ? 'models' : process.env.ATOMIC_OPEN
  win.loadURL(open === 'models' || open === 'settings' ? `${url}#${open}` : url)

  // Dev affordance: ATOMIC_CAPTURE=<path> writes a PNG of the window contents
  // once loaded, so the UI can be checked without screen-recording permission.
  if (process.env.ATOMIC_CAPTURE) {
    win.webContents.once('did-finish-load', async () => {
      await sleep(5000)
      const img = await win.webContents.capturePage()
      require('node:fs').writeFileSync(process.env.ATOMIC_CAPTURE, img.toPNG())
      console.log(`captured -> ${process.env.ATOMIC_CAPTURE}`)
    })
  }
}

// Two instances share one userData directory and fight over the Service Worker
// database — which is exactly what WebContainer's preview runs on. Refuse the
// second launch and focus the window that already exists.
if (!app.requestSingleInstanceLock()) {
  console.log('Atomic Lovable is already running — focusing that window.')
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!win || win.isDestroyed()) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  })
  app.whenReady().then(bootstrap)

  // One window is the whole app, so closing it quits — the macOS habit of
  // staying alive in the Dock would keep the model's memory held for nothing.
  app.on('window-all-closed', () => app.quit())

  // Quitting gives the memory back: the model server holds the weights and KV
  // cache (10+ GB for a 14B), and it runs as its own process, so it has to be
  // stopped explicitly or it outlives the window. The next launch reloads it —
  // a few seconds while macOS still has the file in its page cache.
  // Registered only in the primary instance: a second launch quits at once,
  // and must not take the running window's model down with it.
  // ATOMIC_KEEP_WARM=1 keeps it loaded between launches instead.
  app.on('before-quit', () => {
    vite?.kill('SIGINT')
    if (!process.env.ATOMIC_KEEP_WARM) stopServing()
  })
}
