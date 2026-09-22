// Refresh verified sizes/layouts from public Hugging Face metadata and GGUF headers.
// Does not download model weights. Run explicitly when updating the bundled list.
import { createRequire } from 'node:module'
import { writeFile } from 'node:fs/promises'
const require = createRequire(import.meta.url)
const { describeRepo } = require('../electron/hub.cjs')
const repos = [
  ['unsloth/gemma-3-270m-it-GGUF', 'Gemma 3 270M', 25],
  ['unsloth/gemma-3-1b-it-GGUF', 'Gemma 3 1B', 42],
  ['bartowski/gemma-2-2b-it-GGUF', 'Gemma 2 2B', 50],
  ['unsloth/gemma-3-4b-it-GGUF', 'Gemma 3 4B', 62],
  ['bartowski/SmolLM2-135M-Instruct-GGUF', 'SmolLM2 135M', 18],
  ['bartowski/SmolLM2-360M-Instruct-GGUF', 'SmolLM2 360M', 24],
  ['bartowski/SmolLM2-1.7B-Instruct-GGUF', 'SmolLM2 1.7B', 40],
  ['unsloth/SmolLM3-3B-GGUF', 'SmolLM3 3B', 55],
  ['Qwen/Qwen2.5-0.5B-Instruct-GGUF', 'Qwen2.5 0.5B', 30],
  ['Qwen/Qwen2.5-1.5B-Instruct-GGUF', 'Qwen2.5 1.5B', 42],
  ['Qwen/Qwen2.5-3B-Instruct-GGUF', 'Qwen2.5 3B', 54],
  ['Qwen/Qwen2.5-Coder-0.5B-Instruct-GGUF', 'Qwen2.5-Coder 0.5B', 35],
  ['unsloth/Qwen3-0.6B-GGUF', 'Qwen3 0.6B', 34],
  ['unsloth/Qwen3-1.7B-GGUF', 'Qwen3 1.7B', 48],
  ['unsloth/Qwen3-4B-GGUF', 'Qwen3 4B', 62],
  ['unsloth/Qwen3-8B-GGUF', 'Qwen3 8B', 72],
  ['bartowski/Llama-3.2-1B-Instruct-GGUF', 'Llama 3.2 1B', 36],
  ['bartowski/Llama-3.2-3B-Instruct-GGUF', 'Llama 3.2 3B', 53],
  ['TheBloke/TinyLlama-1.1B-Chat-v1.0-GGUF', 'TinyLlama 1.1B', 25],
  ['bartowski/Phi-3-mini-4k-instruct-GGUF', 'Phi-3 Mini 3.8B', 54],
  ['bartowski/Phi-3.5-mini-instruct-GGUF', 'Phi-3.5 Mini 3.8B', 60],
  ['unsloth/Phi-4-mini-instruct-GGUF', 'Phi-4 Mini 3.8B', 68],
  ['bartowski/DeepSeek-R1-Distill-Qwen-1.5B-GGUF', 'DeepSeek R1 Qwen 1.5B', 40],
  ['bartowski/DeepSeek-R1-Distill-Qwen-7B-GGUF', 'DeepSeek R1 Qwen 7B', 61],
  ['bartowski/DeepSeek-R1-Distill-Llama-8B-GGUF', 'DeepSeek R1 Llama 8B', 62],
  ['bartowski/ibm-granite_granite-3.3-2b-instruct-GGUF', 'Granite 3.3 2B', 45],
  ['bartowski/ibm-granite_granite-3.3-8b-instruct-GGUF', 'Granite 3.3 8B', 62],
  ['bartowski/gemma-2-9b-it-GGUF', 'Gemma 2 9B', 65],
]
const results = []
for (const [repo, label, codingScore] of repos) {
  try {
    const entry = await describeRepo(label, repo)
    if (!entry) throw new Error('No GGUF files')
    if (entry.unsupportedReason) throw new Error(entry.unsupportedReason)
    entry.id = `small:${repo}`
    entry.source = 'catalog'
    entry.codingScore = codingScore
    entry.tags.push(/coder/i.test(label) ? 'coder' : 'general')
    entry.blurb = entry.params <= 2 ? 'Lightweight model for quick, simple tasks.' : 'General-purpose local language model.'
    // Keep several practical sizes in the offline catalog. Search accepts all quants.
    entry.quants = entry.quants.filter(q => ['Q4_K_M', 'Q4_0', 'Q5_K_M', 'Q6_K', 'Q8_0', 'F16', 'BF16'].includes(q.tag))
    if (!entry.quants.length) throw new Error('No catalog quantizations')
    results.push(entry)
    console.log(`${label}: ${entry.params}B, ${entry.maxCtx} context, ${entry.quants.length} verified files`)
  } catch (e) { console.error(`${repo}: ${e.message}`) }
}
if (results.length < 24) throw new Error(`Only ${results.length} verified models; keeping the existing catalog.`)
await writeFile(new URL('../electron/catalog-small.json', import.meta.url), JSON.stringify(results, null, 2) + '\n')
console.log(`Saved ${results.length} verified small models.`)
