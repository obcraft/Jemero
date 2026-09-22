#!/usr/bin/env node
// In development the app runs inside node_modules/electron's own Electron.app,
// and macOS names the menu bar and the Dock after that bundle, not after us.
// The menu bar reads CFBundleName, but the Dock labels a running app with the
// bundle's file name, so both have to change: rename Electron.app to
// Jemero.app, point electron's launcher (path.txt) at it, and set the plist
// names (re-sealing the ad-hoc signature, which covers Info.plist). Idempotent
// and quick, so `npm start` runs it every time; a fresh `npm install` restores
// Electron.app and this puts the name back.
// The packaged app is named by electron-builder and needs none of this.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const NAME = 'Jemero'

if (process.platform !== 'darwin') process.exit(0)

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const pkg = path.join(root, 'node_modules', 'electron')
const original = path.join(pkg, 'dist', 'Electron.app')
const app = path.join(pkg, 'dist', `${NAME}.app`)
const pathTxt = path.join(pkg, 'path.txt')
const launcher = `${NAME}.app/Contents/MacOS/Electron`

try {
  // A reinstall brings Electron.app back next to a stale Jemero.app: the fresh one wins.
  if (fs.existsSync(original)) {
    fs.rmSync(app, { recursive: true, force: true })
    fs.renameSync(original, app)
  }
  if (fs.existsSync(app) && fs.existsSync(pathTxt) && fs.readFileSync(pathTxt, 'utf8') !== launcher) {
    fs.writeFileSync(pathTxt, launcher)
  }
} catch (err) {
  console.warn(`dev-name: could not rename the development app (${err.message.split('\n')[0]})`)
}

const plist = path.join(app, 'Contents', 'Info.plist')
if (!fs.existsSync(plist)) process.exit(0)

const buddy = (...cmds) =>
  execFileSync('/usr/libexec/PlistBuddy', cmds.flatMap((c) => ['-c', c]).concat(plist), { encoding: 'utf8' }).trim()

try {
  if (buddy('Print :CFBundleName') === NAME && buddy('Print :CFBundleDisplayName') === NAME) process.exit(0)
  buddy(`Set :CFBundleName ${NAME}`, `Set :CFBundleDisplayName ${NAME}`)
  execFileSync('codesign', ['--force', '--sign', '-', app], { stdio: 'ignore' })
  // Nudge Launch Services so the Dock picks the new name up.
  fs.utimesSync(app, new Date(), new Date())
  console.log(`dev-name: the development app is now called ${NAME}`)
} catch (err) {
  // Cosmetic only: never stop the app from starting over it.
  console.warn(`dev-name: could not rename the development app (${err.message.split('\n')[0]})`)
}
