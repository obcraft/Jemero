// Renders build/background.png (+ @2x) for the DMG window: the drag-to-install
// layout, drawn in a hidden Electron window like scripts/icon.cjs. The icon
// positions here must match `dmg.contents` in electron-builder.config.cjs.
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const W = 540
const H = 380
const OUT = path.join(__dirname, '..', 'build')

const page = `<!doctype html><meta charset="utf-8"><style>
  html,body{margin:0;width:${W}px;height:${H}px;background:#f6f6f8;
    font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text",sans-serif;-webkit-font-smoothing:antialiased}
  svg{position:absolute;inset:0}
  p{position:absolute;left:0;right:0;top:292px;margin:0;text-align:center;
    font-size:13px;color:#6b6f78;letter-spacing:.01em}
</style>
<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" fill="none">
  <path d="M222 170 H312" stroke="#b9bcc4" stroke-width="2" stroke-linecap="round" stroke-dasharray="1 7"/>
  <path d="M306 162 L316 170 L306 178" stroke="#b9bcc4" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
</svg>
<p>Drag Jemero into Applications</p>`

app.disableHardwareAcceleration()
app.whenReady().then(async () => {
  // Render once at 2x (CSS zoom), then let sips make the 1x from it.
  const win = new BrowserWindow({ width: W * 2, height: H * 2, show: false, frame: false, useContentSize: true })
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(page.replace('<style>', '<style>html{zoom:2}'))}`)
  await new Promise((r) => setTimeout(r, 500))
  const retina = path.join(OUT, 'background@2x.png')
  // capturePage returns device pixels, so on a Retina screen this is 4x; pin both sizes.
  const img = (await win.webContents.capturePage()).resize({ width: W * 2, height: H * 2, quality: 'best' })
  fs.writeFileSync(retina, img.toPNG())
  fs.writeFileSync(path.join(OUT, 'background.png'), img.resize({ width: W, height: H, quality: 'best' }).toPNG())
  console.log('build/background.png, build/background@2x.png')
  app.quit()
})
