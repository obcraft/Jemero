#!/usr/bin/env node
// The same recommendation the app shows, from a terminal — and the installer
// behind it. Useful before you ever open the window, and the thing to reach for
// when a 17 GB download deserves a real progress line instead of a spinner.
//
//   npm run models                 what this Mac should run, and why
//   npm run models:install         download the recommended model
//   npm run models -- --install qwen2.5-coder-7b
//   npm run models -- --json
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const require = createRequire(import.meta.url)
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const { detect, describe } = require(path.join(root, 'electron/hardware.cjs'))
const { recommend, planFor } = require(path.join(root, 'electron/catalog.cjs'))
const store = require(path.join(root, 'electron/install.cjs'))
const runtime = require(path.join(root, 'electron/runtime.cjs'))

const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const valueFor = (name) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}

const priority = valueFor('--priority') ?? 'balanced'
if (!['speed', 'balanced', 'quality'].includes(priority)) {
  console.error('--priority must be speed, balanced or quality')
  process.exit(1)
}

const device = detect()
const { models, recommended, reasons } = recommend(device, priority)
await store.adoptAtomicChatModels()
const local = await store.installed()
const installedIds = new Set(local.filter((m) => m.complete).map((m) => m.id))
// Downloaded quants that aren't their family's pick under this priority.
for (const id of installedIds) {
  if (!models.some((m) => m.modelId === id)) {
    const plan = planFor(id, device)
    if (plan) models.push(plan)
  }
}

if (flag('--json')) {
  console.log(JSON.stringify({ device, models, recommended, reasons, installed: local }, null, 2))
  process.exit(0)
}

if (flag('--install')) {
  const wanted = valueFor('--install')
  const pick =
    !wanted || wanted.startsWith('--')
      ? models.find((m) => m.modelId === recommended)
      : models.find((m) => m.catalogId === wanted || m.label === wanted) ?? planFor(wanted, device)

  if (!pick) {
    console.error(`Unknown model: ${wanted}\nTry one of: ${models.map((m) => m.catalogId).join(', ')}`)
    process.exit(1)
  }
  if (!pick.fits && !flag('--force')) {
    console.error(
      `${pick.label} ${pick.quant} needs about ${pick.needsGB} GB but this Mac can only wire ${device.budgetGB} GB.\n` +
        `Install it anyway with --force (expect swapping), or pick a smaller one.`,
    )
    process.exit(1)
  }
  if (installedIds.has(pick.modelId)) {
    console.log(`${pick.modelId} is already installed.`)
    process.exit(0)
  }

  console.log(`${pick.label} ${pick.quant} — ${pick.sizeGB} GB from ${pick.repo}`)
  console.log(`→ ${store.modelDir(pick.modelId)}\n`)

  let lastLine = 0
  const res = await store.install(pick, (p) => {
    if (p.phase === 'downloading' || p.phase === 'resuming') {
      const now = Date.now()
      if (now - lastLine < 500) return
      lastLine = now
      const pct = ((p.received / p.total) * 100).toFixed(1)
      const width = 32
      const done = Math.round((p.received / p.total) * width)
      const bar = '█'.repeat(done) + '░'.repeat(width - done)
      const mbs = (p.bytesPerSec / 1024 ** 2).toFixed(1)
      const eta = p.etaSeconds == null ? '' : ` · ${fmtEta(p.etaSeconds)}`
      process.stdout.write(`\r  ${bar} ${pct.padStart(5)}%  ${mbs} MB/s${eta}   `)
    } else if (p.phase === 'installing') {
      process.stdout.write('\r  writing manifest…                                          ')
    }
  })
  process.stdout.write('\n')
  if (res.cancelled) {
    console.log('Cancelled — the partial file is kept, rerun to resume.')
    process.exit(1)
  }
  console.log(`\nInstalled ${pick.modelId}`)
  console.log(`Run \`npm start\` — the app will serve it at ${pick.ctx / 1024}k context.`)
  process.exit(0)
}

// Default: the report.
const W = 26
console.log(`\n  ${describe(device)}`)
const rt = runtime.describe()
console.log(`  ${device.budgetGB} GB usable for a model · ${device.effectiveBandwidthGBs} GB/s effective bandwidth`)
console.log(`  runtime: llama.cpp ${rt.build} (${rt.source}) · priority: ${priority}\n`)
console.log(`  ${'MODEL'.padEnd(W)} ${'QUANT'.padEnd(11)} ${'SIZE'.padStart(7)} ${'SPEED'.padStart(9)}  NOTE`)
for (const m of models) {
  const mark = m.modelId === recommended ? '★' : installedIds.has(m.modelId) ? '·' : ' '
  const note = !m.fits
    ? `needs ≈${m.needsGB} GB`
    : installedIds.has(m.modelId)
      ? 'installed'
      : `${m.ctx / 1024}k ctx`
  console.log(
    `${mark} ${m.label.padEnd(W)} ${m.quant.padEnd(11)} ${(m.sizeGB + ' GB').padStart(7)} ${(m.tokensPerSec + ' tok/s').padStart(9)}  ${note}`,
  )
}

const best = models.find((m) => m.modelId === recommended)
if (best) {
  console.log(`\n  ★ ${best.label} ${best.quant}  (${best.modelId})`)
  for (const r of reasons) console.log(`    · ${wrap(r, 92, 6)}`)
  console.log(
    installedIds.has(best.modelId)
      ? `\n  Already installed — \`npm start\` will serve it.\n`
      : `\n  Install it:  npm run models:install\n`,
  )
}

function fmtEta(s) {
  if (s < 60) return `${Math.round(s)}s left`
  const m = Math.floor(s / 60)
  return m < 60 ? `${m}m ${Math.round(s % 60)}s left` : `${Math.floor(m / 60)}h ${m % 60}m left`
}

/** Hard-wrap a reason onto continuation lines so the report stays a column. */
function wrap(text, width, indent) {
  const words = text.split(' ')
  const lines = ['']
  for (const w of words) {
    if ((lines.at(-1) + ' ' + w).trim().length > width) lines.push('')
    lines[lines.length - 1] = (lines.at(-1) + ' ' + w).trim()
  }
  return lines.join('\n' + ' '.repeat(indent))
}
