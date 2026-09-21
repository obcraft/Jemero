#!/usr/bin/env node
// Vendor the llama.cpp runtime into vendor/llama so `npm run dist` ships it
// inside the app — a fresh Mac then needs no download at all to start serving.
// Only llama-server and the libraries it links are kept; the tarball's other
// ~40 tools would triple the bundle for nothing.
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const require = createRequire(import.meta.url)
const runtime = require('../electron/runtime.cjs')

const dest = runtime.vendorDir()
// `npm run dist` calls this with --if-missing so builds don't re-download.
if (process.argv.includes('--if-missing') && fs.existsSync(path.join(dest, `llama-${runtime.BUILD}`, 'llama-server'))) {
  console.log(`vendor/llama/llama-${runtime.BUILD} already present`)
  process.exit(0)
}
fs.rmSync(dest, { recursive: true, force: true })
const bin = await runtime.download((s) => console.log(`  ${s}`), dest)
const dir = path.dirname(bin)

// Keep llama-server, the shared libraries it links, and the licence. The other
// tools each ship a libllama-<tool>-impl.dylib, which go with them.
for (const name of fs.readdirSync(dir)) {
  const toolImpl = /^libllama-.+-impl\.dylib$/.test(name) && name !== 'libllama-server-impl.dylib'
  const keep = name === 'llama-server' || name === 'LICENSE' || (name.endsWith('.dylib') && !toolImpl)
  if (!keep) fs.rmSync(path.join(dir, name), { recursive: true, force: true })
}

// --version prints to stderr.
const version = execFileSync('/bin/sh', ['-c', `"${bin}" --version 2>&1`], { encoding: 'utf8' })
  .split('\n')
  .find((l) => l.startsWith('version'))
const size = execFileSync('/usr/bin/du', ['-sh', dir], { encoding: 'utf8' }).split('\t')[0]
console.log(`\nvendor/llama/llama-${runtime.BUILD}  (${size})  ${version ?? ''}`)
