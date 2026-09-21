#!/usr/bin/env node
// Start the local model server without opening the app, the same choice the
// app would make, so the two can't drift. `npm run stop` shuts it down again.
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const require = createRequire(import.meta.url)
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const { choose, serveModel, probe, PORT } = require(path.join(root, 'electron/model.cjs'))

const serving = await probe()
if (serving) {
  console.log(`${serving} is already serving on :${PORT}`)
  process.exit(0)
}

const { id, ctx, recommended } = await choose()
if (!id) {
  console.error(
    recommended
      ? `No model installed. Run \`npm run models:install\` to get ${recommended}.`
      : 'No model installed. Run `npm run models` to see what fits this Mac.',
  )
  process.exit(1)
}

console.log(`Serving ${id} at ${Number(ctx) / 1024}k context on :${PORT}`)
const res = await serveModel(id, ctx, (status) => console.log(`  ${status}`))
if (!res.ok) {
  console.error(res.reason)
  process.exit(1)
}
console.log(`Ready: http://127.0.0.1:${PORT}/v1`)
