// Read-only smoke checks of live Hub metadata and the pinned runtime source.
import { createRequire } from 'node:module'
import { writeFile } from 'node:fs/promises'
const require = createRequire(import.meta.url)
const { BUILD } = require('../electron/runtime.cjs')
const sourceURL = `https://raw.githubusercontent.com/ggml-org/llama.cpp/${BUILD}/src/llama-arch.cpp`
const response = await fetch(sourceURL)
if (!response.ok) throw new Error(`${sourceURL}: ${response.status}`)
const source = await response.text()
const architectures = [...source.matchAll(/\{\s*LLM_ARCH_\w+,\s*"([^"]+)"\s*\}/g)].map(m => m[1]).filter(a => a !== '(unknown)')
if (architectures.length < 30) throw new Error('Could not read runtime architectures')
await writeFile(new URL('../electron/runtime-architectures.json', import.meta.url), JSON.stringify(architectures, null, 2) + '\n')
console.log(`Verified ${architectures.length} architectures in ${BUILD}`)
const { searchPage } = require('../electron/hub.cjs')
const device = { budgetBytes: 8 * 1024 ** 3, effectiveBandwidthGBs: 75 }
for (const query of ['gemma 1b', 'https://huggingface.co/bartowski/SmolLM2-135M-Instruct-GGUF', 'qwen 0.5b']) {
  const page = await searchPage(query, device)
  console.log(JSON.stringify({ query, count: page.results.length, hasMore: page.hasMore, models: page.results.map(m => ({ name: m.label, quant: m.quant, fits: m.fits, ctx: m.ctx, limit: m.limit })) }))
  if (!page.results.some(m => m.fits)) throw new Error(`No runnable results for ${query}`)
}
