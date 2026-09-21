#!/usr/bin/env node
// In development the app runs inside node_modules/electron's own Electron.app,
// and macOS names the menu bar and the Dock after that bundle, not after us.
// Rename the bundle to Jemero (and re-seal its ad-hoc signature, which covers
// Info.plist). Idempotent and quick, so `npm start` runs it every time; a fresh
// `npm install` restores the original and this puts the name back.
// The packaged app is named by electron-builder and needs none of this.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const NAME = 'Jemero'

if (process.platform !== 'darwin') process.exit(0)

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const app = path.join(root, 'node_modules', 'electron', 'dist', 'Electron.app')
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
