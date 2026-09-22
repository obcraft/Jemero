// Explicit integration check: download one small model to a temporary store,
// verify its checksum, run our bundled llama.cpp on an isolated port, and stop it.
import { createRequire } from 'node:module'
import { mkdtemp, open, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import assert from 'node:assert/strict'
const require = createRequire(import.meta.url)
const directory = (process.argv[2] === '-' ? undefined : process.argv[2]) ?? await mkdtemp(path.join(tmpdir(), 'jemero-small-model-'))
process.env.JEMERO_HOME = directory
process.env.JEMERO_MODELS = path.join(directory, 'models')
const { CATALOG, bestPlan } = require('../electron/catalog.cjs')
const { install, ggufPath, readManifest } = require('../electron/install.cjs')
const { chatBudget } = require('../electron/chat-context.cjs')
const entry = CATALOG.find(m => m.label === (process.argv[3] ?? 'SmolLM2 135M'))
const small = { ...entry, quants: entry.quants.filter(q => q.tag === 'Q4_K_M') }
const plan = bestPlan(small, { budgetBytes: 2 * 1024 ** 3, effectiveBandwidthGBs: 75 })
console.log(`Downloading ${plan.label} (${plan.sizeGB} GB) to ${directory}`)
await install(plan)
assert.match(readManifest(plan.modelId).sha256, /^[0-9a-f]{64}$/)
console.log('Download and SHA-256 verified')
const logfile = await open(path.join(directory, 'server.log'), 'w')
const port = 18759
const base = `http://127.0.0.1:${port}`
const server = spawn(require('../electron/runtime.cjs').find(), ['--model', ggufPath(plan.modelId), '--host', '127.0.0.1', '--port', String(port), '--ctx-size', '2048', '--n-gpu-layers', '999', '--parallel', '1', '--jinja', '--no-webui'], { stdio: ['ignore', logfile.fd, logfile.fd] })
let spawnError
server.on('error', error => { spawnError = error })
try {
  let ready = false
  for (let n = 0; n < 100; n++) {
    if (spawnError) throw spawnError
    if (server.exitCode != null) throw new Error(await readFile(path.join(directory, 'server.log'), 'utf8'))
    try { ready = (await fetch(`${base}/health`)).ok } catch {}
    if (ready) break
    await new Promise(r => setTimeout(r, 300))
  }
  assert.ok(ready, 'Server ready')
  const messages = [{ role: 'system', content: 'You are a helpful assistant.' }, { role: 'user', content: 'Say hello in one sentence.' }]
  const budget = await chatBudget(base, { messages, maxTokens: 4096 })
  assert.ok(budget.maxTokens < 2048)
  const response = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messages, max_tokens: 32, temperature: 0, stream: false }) })
  const answer = await response.json()
  assert.equal(response.status, 200, JSON.stringify(answer))
  assert.ok(answer.choices?.[0]?.message?.content)
  console.log(JSON.stringify({ context: budget.context, answerBudget: budget.maxTokens, answer: answer.choices[0].message.content }))
} finally {
  if (server.pid && server.exitCode === null) { server.kill('SIGTERM'); await once(server, 'exit') }
  await logfile.close()
}
