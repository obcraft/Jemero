// Generates build/icon.icns from a rendered page, with no image toolchain.
//
// Electron is already a dependency and it is, among other things, a renderer:
// draw the mark in a transparent 1024² window, capture it, then let macOS's own
// sips/iconutil produce the .icns. Run with `npm run icon`.
const { app, BrowserWindow } = require('electron')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const OUT = path.join(__dirname, '..', 'build')
const SIZES = [16, 32, 64, 128, 256, 512, 1024]

// A hexagon on a squircle, in the app's accent, the same ⬢ the header uses.
const PAGE = `<!doctype html><meta charset="utf-8"><style>
  html,body{margin:0;width:1024px;height:1024px;background:transparent}
  .plate{
    position:absolute;inset:80px;border-radius:200px;
    background:linear-gradient(160deg,#20242e 0%,#0b0d11 62%);
    box-shadow:inset 0 3px 0 rgba(255,255,255,.07), inset 0 -6px 24px rgba(0,0,0,.5);
  }
  svg{position:absolute;inset:0;width:100%;height:100%}
</style>
<div class="plate"></div>
<svg viewBox="0 0 1024 1024" fill="none">
  <defs>
    <linearGradient id="g" x1="300" y1="250" x2="740" y2="800" gradientUnits="userSpaceOnUse">
      <stop stop-color="#9b8dff"/><stop offset="1" stop-color="#6a56f0"/>
    </linearGradient>
  </defs>
  <path d="M512 268 L723 390 L723 634 L512 756 L301 634 L301 390 Z"
        stroke="url(#g)" stroke-width="54" stroke-linejoin="round"/>
  <path d="M512 268 L723 390 L723 634 L512 756 L301 634 L301 390 Z"
        fill="url(#g)" opacity=".14"/>
</svg>`

app.disableHardwareAcceleration()

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1024,
    height: 1024,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    useContentSize: true,
    webPreferences: { offscreen: true },
  })
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(PAGE)}`)
  await new Promise((r) => setTimeout(r, 600))

  const png = (await win.webContents.capturePage()).toPNG()
  fs.mkdirSync(OUT, { recursive: true })
  fs.writeFileSync(path.join(OUT, 'icon.png'), png)

  // iconutil wants a .iconset with the exact Apple naming, 1x and 2x each.
  const set = path.join(OUT, 'icon.iconset')
  fs.rmSync(set, { recursive: true, force: true })
  fs.mkdirSync(set)
  for (const size of SIZES) {
    for (const [scale, name] of [
      [1, `icon_${size}x${size}.png`],
      [2, `icon_${size / 2}x${size / 2}@2x.png`],
    ]) {
      if (scale === 2 && size < 32) continue
      const dest = path.join(set, name)
      execFileSync('/usr/bin/sips', ['-z', String(size), String(size), path.join(OUT, 'icon.png'), '--out', dest], {
        stdio: 'ignore',
      })
    }
  }
  execFileSync('/usr/bin/iconutil', ['-c', 'icns', set, '-o', path.join(OUT, 'icon.icns')])
  fs.rmSync(set, { recursive: true, force: true })
  console.log(`build/icon.icns  (${(fs.statSync(path.join(OUT, 'icon.icns')).size / 1024).toFixed(0)} KB)`)
  app.quit()
})
