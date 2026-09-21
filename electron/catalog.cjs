// The model catalog and the picker that turns it into one recommendation.
//
// Every size below is the real byte count of the real GGUF on Hugging Face, and
// every KV figure is derived from the model's own config (layers × KV heads ×
// head_dim × 2 for K+V × 2 bytes for f16). Nothing here is a round number for
// the sake of looking tidy, the whole point is that the fit check is true.
//
// `codingScore` is a judgement call, not a benchmark score: it ranks how well
// the model writes a *whole* small React app in one pass and keeps to a strict
// output format, which is what this app asks of it. HumanEval saturates and
// does not predict that.
const { GB } = require('./hardware.cjs')

const KiB = 1024

/** Quality cost of quantization, in codingScore points. */
const QUANT_PENALTY = {
  Q8_0: 0,
  'UD-Q6_K_XL': 0.4,
  Q6_K: 0.6,
  'UD-Q5_K_XL': 1.2,
  Q5_K_M: 1.5,
  MXFP4: 1.5, // native training precision for gpt-oss, not a post-hoc squeeze
  'UD-Q4_K_XL': 2.2, // importance-matrix quant: keeps more of the sensitive tensors
  Q4_K_M: 3,
  Q4_K_S: 4.5,
}

/**
 * Below 4-bit, code generation starts dropping closing braces and inventing
 * APIs, and sparse-MoE models degrade faster still because each expert carries
 * less redundancy. So the catalog simply doesn't offer Q3 and below.
 */
const CATALOG = [
  {
    id: 'qwen3-coder-30b-a3b',
    tags: ['coder', 'agentic'],
    label: 'Qwen3-Coder 30B-A3B',
    repo: 'unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF',
    params: 30.5,
    activeParams: 3.3,
    moe: true,
    codingScore: 92,
    kvKiBPerToken: 96, // 48 layers × 4 KV heads × 128 dim × 2 × 2 B
    maxCtx: 262144,
    blurb: 'Strongest local coder that still feels instant: 30B of knowledge, 3.3B active per token.',
    quants: [
      { tag: 'UD-Q4_K_XL', file: 'Qwen3-Coder-30B-A3B-Instruct-UD-Q4_K_XL.gguf', bytes: 17665334432 },
      { tag: 'Q4_K_M', file: 'Qwen3-Coder-30B-A3B-Instruct-Q4_K_M.gguf', bytes: 18556689568 },
      { tag: 'UD-Q5_K_XL', file: 'Qwen3-Coder-30B-A3B-Instruct-UD-Q5_K_XL.gguf', bytes: 21740305568 },
      { tag: 'UD-Q6_K_XL', file: 'Qwen3-Coder-30B-A3B-Instruct-UD-Q6_K_XL.gguf', bytes: 26340328608 },
      { tag: 'Q8_0', file: 'Qwen3-Coder-30B-A3B-Instruct-Q8_0.gguf', bytes: 32483935392 },
    ],
  },
  {
    id: 'qwen2.5-coder-32b',
    tags: ['coder'],
    label: 'Qwen2.5-Coder 32B',
    repo: 'bartowski/Qwen2.5-Coder-32B-Instruct-GGUF',
    params: 32.8,
    codingScore: 90,
    kvKiBPerToken: 256, // 64 × 8 × 128 × 2 × 2
    maxCtx: 32768,
    blurb: 'Dense and very accurate, but every token reads all 32B, so it needs bandwidth, not just RAM.',
    quants: [
      { tag: 'Q4_K_S', file: 'Qwen2.5-Coder-32B-Instruct-Q4_K_S.gguf', bytes: 18784410592 },
      { tag: 'Q4_K_M', file: 'Qwen2.5-Coder-32B-Instruct-Q4_K_M.gguf', bytes: 19851336672 },
      { tag: 'Q5_K_M', file: 'Qwen2.5-Coder-32B-Instruct-Q5_K_M.gguf', bytes: 23262157792 },
      { tag: 'Q6_K', file: 'Qwen2.5-Coder-32B-Instruct-Q6_K.gguf', bytes: 26886155232 },
      { tag: 'Q8_0', file: 'Qwen2.5-Coder-32B-Instruct-Q8_0.gguf', bytes: 34820885184 },
    ],
  },
  {
    id: 'devstral-small-2507',
    tags: ['coder', 'agentic'],
    label: 'Devstral Small 1.1 (24B)',
    repo: 'unsloth/Devstral-Small-2507-GGUF',
    params: 23.6,
    codingScore: 85,
    kvKiBPerToken: 160, // 40 × 8 × 128 × 2 × 2
    maxCtx: 131072,
    blurb: 'Tuned for agentic, multi-file editing. Strong at following a fixed output format.',
    quants: [
      { tag: 'Q4_K_S', file: 'Devstral-Small-2507-Q4_K_S.gguf', bytes: 13549288672 },
      { tag: 'UD-Q4_K_XL', file: 'Devstral-Small-2507-UD-Q4_K_XL.gguf', bytes: 14548876512 },
      { tag: 'Q5_K_M', file: 'Devstral-Small-2507-Q5_K_M.gguf', bytes: 16763993312 },
      { tag: 'UD-Q6_K_XL', file: 'Devstral-Small-2507-UD-Q6_K_XL.gguf', bytes: 20788395232 },
      { tag: 'Q8_0', file: 'Devstral-Small-2507-Q8_0.gguf', bytes: 25054788576 },
    ],
  },
  {
    id: 'qwen2.5-coder-14b',
    tags: ['coder'],
    label: 'Qwen2.5-Coder 14B',
    repo: 'bartowski/Qwen2.5-Coder-14B-Instruct-GGUF',
    params: 14.8,
    codingScore: 82,
    kvKiBPerToken: 192, // 48 × 8 × 128 × 2 × 2
    maxCtx: 32768,
    blurb: 'The safe default on 24 GB: good enough to one-shot a small app, small enough to stay responsive.',
    quants: [
      { tag: 'Q4_K_S', file: 'Qwen2.5-Coder-14B-Instruct-Q4_K_S.gguf', bytes: 8573432032 },
      { tag: 'Q4_K_M', file: 'Qwen2.5-Coder-14B-Instruct-Q4_K_M.gguf', bytes: 8988111072 },
      { tag: 'Q5_K_M', file: 'Qwen2.5-Coder-14B-Instruct-Q5_K_M.gguf', bytes: 10508873952 },
      { tag: 'Q6_K', file: 'Qwen2.5-Coder-14B-Instruct-Q6_K.gguf', bytes: 12124684512 },
      { tag: 'Q8_0', file: 'Qwen2.5-Coder-14B-Instruct-Q8_0.gguf', bytes: 15701598432 },
    ],
  },
  {
    id: 'gpt-oss-20b',
    tags: ['general', 'reasoning'],
    label: 'gpt-oss 20B',
    repo: 'ggml-org/gpt-oss-20b-GGUF',
    params: 20.9,
    activeParams: 3.6,
    moe: true,
    codingScore: 80,
    // Its own channel format ("analysis"/"final") is not <think>, so the file
    // parser can see reasoning text. Usable, but not what to recommend blind.
    formatRisk: 'Emits reasoning in its own channel format rather than <think>, which the parser strips.',
    kvKiBPerToken: 48, // 24 × 8 × 64 × 2 × 2
    maxCtx: 131072,
    blurb: 'Fast MoE with strong reasoning; wants a harmony-aware client to behave perfectly.',
    quants: [{ tag: 'MXFP4', file: 'gpt-oss-20b-MXFP4.gguf', bytes: 12109566624 }],
  },
  {
    id: 'qwen2.5-coder-7b',
    tags: ['coder'],
    label: 'Qwen2.5-Coder 7B',
    repo: 'bartowski/Qwen2.5-Coder-7B-Instruct-GGUF',
    params: 7.6,
    codingScore: 72,
    kvKiBPerToken: 56, // 28 × 4 × 128 × 2 × 2
    maxCtx: 32768,
    blurb: 'Fits 16 GB comfortably and answers fast; expect more repair passes on bigger apps.',
    quants: [
      { tag: 'Q4_K_M', file: 'Qwen2.5-Coder-7B-Instruct-Q4_K_M.gguf', bytes: 4683074336 },
      { tag: 'Q5_K_M', file: 'Qwen2.5-Coder-7B-Instruct-Q5_K_M.gguf', bytes: 5444832032 },
      { tag: 'Q6_K', file: 'Qwen2.5-Coder-7B-Instruct-Q6_K.gguf', bytes: 6254199584 },
      { tag: 'Q8_0', file: 'Qwen2.5-Coder-7B-Instruct-Q8_0.gguf', bytes: 8098525984 },
    ],
  },
  {
    id: 'qwen2.5-coder-3b',
    tags: ['coder', 'tiny'],
    label: 'Qwen2.5-Coder 3B',
    repo: 'bartowski/Qwen2.5-Coder-3B-Instruct-GGUF',
    params: 3.1,
    codingScore: 58,
    kvKiBPerToken: 36, // 36 × 2 × 128 × 2 × 2
    maxCtx: 32768,
    blurb: 'For 8 to 16 GB Macs. Keeps prompts simple and single-screen.',
    quants: [
      { tag: 'Q4_K_M', file: 'Qwen2.5-Coder-3B-Instruct-Q4_K_M.gguf', bytes: 1929903360 },
      { tag: 'Q5_K_M', file: 'Qwen2.5-Coder-3B-Instruct-Q5_K_M.gguf', bytes: 2224815360 },
      { tag: 'Q6_K', file: 'Qwen2.5-Coder-3B-Instruct-Q6_K.gguf', bytes: 2538159360 },
      { tag: 'Q8_0', file: 'Qwen2.5-Coder-3B-Instruct-Q8_0.gguf', bytes: 3285476608 },
    ],
  },
  {
    id: 'qwen2.5-coder-1.5b',
    tags: ['coder', 'tiny'],
    label: 'Qwen2.5-Coder 1.5B',
    repo: 'bartowski/Qwen2.5-Coder-1.5B-Instruct-GGUF',
    params: 1.5,
    codingScore: 45,
    kvKiBPerToken: 28, // 28 × 2 × 128 × 2 × 2
    maxCtx: 32768,
    blurb: 'Last resort on 8 GB. It will need help, but it runs.',
    quants: [
      { tag: 'Q4_K_M', file: 'Qwen2.5-Coder-1.5B-Instruct-Q4_K_M.gguf', bytes: 986048800 },
      { tag: 'Q5_K_M', file: 'Qwen2.5-Coder-1.5B-Instruct-Q5_K_M.gguf', bytes: 1125050656 },
      { tag: 'Q6_K', file: 'Qwen2.5-Coder-1.5B-Instruct-Q6_K.gguf', bytes: 1272740128 },
      { tag: 'Q8_0', file: 'Qwen2.5-Coder-1.5B-Instruct-Q8_0.gguf', bytes: 1646573344 },
    ],
  },
  {
    id: 'gpt-oss-120b',
    label: 'gpt-oss 120B',
    repo: 'ggml-org/gpt-oss-120b-GGUF',
    params: 116.8,
    activeParams: 5.1,
    moe: true,
    tags: ['general', 'reasoning'],
    codingScore: 88,
    formatRisk: 'Emits reasoning in its own channel format rather than <think>, which the parser strips.',
    kvKiBPerToken: 72, // 36 layers × 8 KV heads × 64 dim × 2 × 2 B
    maxCtx: 131072,
    blurb: 'Frontier-class reasoning on a 128 GB Mac, and still only 5.1B active per token.',
    quants: [{ tag: 'MXFP4', file: 'gpt-oss-120b-MXFP4.gguf', bytes: 63387346208 }],
  },
  {
    id: 'llama-3.3-70b',
    label: 'Llama 3.3 70B',
    repo: 'unsloth/Llama-3.3-70B-Instruct-GGUF',
    params: 70.6,
    tags: ['general'],
    codingScore: 78,
    kvKiBPerToken: 320, // 80 × 8 × 128 × 2 × 2
    maxCtx: 131072,
    blurb: 'Excellent instruction-following generalist. Dense 70B, so it is slow even where it fits.',
    quants: [
      { tag: 'Q4_K_S', file: 'Llama-3.3-70B-Instruct-Q4_K_S.gguf', bytes: 40347224672 },
      { tag: 'UD-Q4_K_XL', file: 'Llama-3.3-70B-Instruct-UD-Q4_K_XL.gguf', bytes: 42664577632 },
      { tag: 'Q5_K_M', file: 'Llama-3.3-70B-Instruct-Q5_K_M.gguf', bytes: 49949821536 },
    ],
  },
  {
    id: 'mistral-small-3.2',
    label: 'Mistral Small 3.2 (24B)',
    repo: 'unsloth/Mistral-Small-3.2-24B-Instruct-2506-GGUF',
    params: 23.6,
    tags: ['general'],
    codingScore: 80,
    kvKiBPerToken: 160, // 40 × 8 × 128 × 2 × 2
    maxCtx: 131072,
    blurb: 'Devstral’s generalist sibling: less agentic tuning, better prose and instruction-following.',
    quants: [
      { tag: 'Q4_K_S', file: 'Mistral-Small-3.2-24B-Instruct-2506-Q4_K_S.gguf', bytes: 13549293088 },
      { tag: 'UD-Q4_K_XL', file: 'Mistral-Small-3.2-24B-Instruct-2506-UD-Q4_K_XL.gguf', bytes: 14548880928 },
      { tag: 'Q5_K_M', file: 'Mistral-Small-3.2-24B-Instruct-2506-Q5_K_M.gguf', bytes: 16763997728 },
      { tag: 'UD-Q6_K_XL', file: 'Mistral-Small-3.2-24B-Instruct-2506-UD-Q6_K_XL.gguf', bytes: 20788399648 },
      { tag: 'Q8_0', file: 'Mistral-Small-3.2-24B-Instruct-2506-Q8_0.gguf', bytes: 25054793248 },
    ],
  },
  {
    id: 'qwen3-14b',
    label: 'Qwen3 14B',
    repo: 'unsloth/Qwen3-14B-GGUF',
    params: 14.8,
    tags: ['general', 'reasoning'],
    codingScore: 78,
    kvKiBPerToken: 160, // 40 × 8 × 128 × 2 × 2
    maxCtx: 131072,
    blurb: 'Hybrid reasoning generalist. Its <think> block is stripped before the parser sees it.',
    quants: [
      { tag: 'UD-Q4_K_XL', file: 'Qwen3-14B-UD-Q4_K_XL.gguf', bytes: 9159818624 },
      { tag: 'Q5_K_M', file: 'Qwen3-14B-Q5_K_M.gguf', bytes: 10514570624 },
      { tag: 'UD-Q6_K_XL', file: 'Qwen3-14B-UD-Q6_K_XL.gguf', bytes: 13285990784 },
      { tag: 'Q8_0', file: 'Qwen3-14B-Q8_0.gguf', bytes: 15698534784 },
    ],
  },
  {
    id: 'codestral-22b',
    label: 'Codestral 22B',
    repo: 'bartowski/Codestral-22B-v0.1-GGUF',
    params: 22.2,
    tags: ['coder'],
    codingScore: 76,
    kvKiBPerToken: 224, // 56 × 8 × 128 × 2 × 2
    maxCtx: 32768,
    // Mistral's non-production licence, fine to run locally, read it before shipping.
    blurb: 'Mistral’s 2024 code model. Superseded by Devstral, but strong at fill-in-the-middle.',
    quants: [
      { tag: 'Q4_K_S', file: 'Codestral-22B-v0.1-Q4_K_S.gguf', bytes: 12660384096 },
      { tag: 'Q4_K_M', file: 'Codestral-22B-v0.1-Q4_K_M.gguf', bytes: 13341237600 },
      { tag: 'Q5_K_M', file: 'Codestral-22B-v0.1-Q5_K_M.gguf', bytes: 15722553696 },
      { tag: 'Q6_K', file: 'Codestral-22B-v0.1-Q6_K.gguf', bytes: 18252702048 },
      { tag: 'Q8_0', file: 'Codestral-22B-v0.1-Q8_0.gguf', bytes: 23640547680 },
    ],
  },
  {
    id: 'deepseek-coder-v2-lite',
    label: 'DeepSeek-Coder-V2 Lite',
    repo: 'bartowski/DeepSeek-Coder-V2-Lite-Instruct-GGUF',
    params: 15.7,
    activeParams: 2.4,
    moe: true,
    tags: ['coder'],
    codingScore: 74,
    // Multi-head latent attention: the cache stores a 512-wide compression plus
    // 64 rope dims per layer, not full K and V, so it is unusually small.
    kvKiBPerToken: 48,
    maxCtx: 131072,
    blurb: 'Very fast for its knowledge: 2.4B active. Older, so weaker at holding a strict format.',
    quants: [
      { tag: 'Q4_K_M', file: 'DeepSeek-Coder-V2-Lite-Instruct-Q4_K_M.gguf', bytes: 10364416768 },
      { tag: 'Q5_K_M', file: 'DeepSeek-Coder-V2-Lite-Instruct-Q5_K_M.gguf', bytes: 11851313920 },
      { tag: 'Q6_K', file: 'DeepSeek-Coder-V2-Lite-Instruct-Q6_K.gguf', bytes: 14066972416 },
      { tag: 'Q8_0', file: 'DeepSeek-Coder-V2-Lite-Instruct-Q8_0.gguf', bytes: 16702518016 },
    ],
  },
  {
    id: 'r1-distill-qwen-14b',
    label: 'R1-Distill Qwen 14B',
    repo: 'bartowski/DeepSeek-R1-Distill-Qwen-14B-GGUF',
    params: 14.8,
    tags: ['reasoning'],
    codingScore: 68,
    kvKiBPerToken: 192, // 48 × 8 × 128 × 2 × 2
    maxCtx: 131072,
    blurb: 'Thinks at length before answering, which costs tokens here. Kept for reasoning comparisons.',
    quants: [
      { tag: 'Q4_K_M', file: 'DeepSeek-R1-Distill-Qwen-14B-Q4_K_M.gguf', bytes: 8988110240 },
      { tag: 'Q5_K_M', file: 'DeepSeek-R1-Distill-Qwen-14B-Q5_K_M.gguf', bytes: 10508873120 },
      { tag: 'Q6_K', file: 'DeepSeek-R1-Distill-Qwen-14B-Q6_K.gguf', bytes: 12124683680 },
      { tag: 'Q8_0', file: 'DeepSeek-R1-Distill-Qwen-14B-Q8_0.gguf', bytes: 15701597600 },
    ],
  },
]

/**
 * This app needs 16k and gains nothing from more: `trimHistory` feeds at most
 * ~36k characters of history (~10k tokens) and completions are capped at 4k, so
 * a bigger window would only cost memory and slower prompt processing. Treat 16k
 * as a requirement, a model that can only be served at 8k here is a model that
 * does not fit, and saying so is more useful than shipping a truncated context.
 */
const TARGET_CTX = 16384

/**
 * The speed a model has to reach before quality alone decides. "Speed" wants
 * snappy; "quality" will wait for a better answer. Balanced is where watching
 * a five-file app being typed out still feels live.
 */
const SPEED_TARGETS = { speed: 35, balanced: 20, quality: 10 }
const SPEED_TARGET = SPEED_TARGETS.balanced

/** The server keeps llama.cpp's default f16 KV cache (see model.cjs). */
const KV_RATIO = 1

/** Local model id: org/<gguf basename>. Also the server's --alias. */
function localId(entry, quant) {
  const org = entry.repo.split('/')[0]
  return `${org}/${quant.file.replace(/\.gguf$/i, '')}`
}

function downloadUrl(entry, quant) {
  return `https://huggingface.co/${entry.repo}/resolve/main/${encodeURIComponent(quant.file)}?download=true`
}

/**
 * Bytes actually read per generated token. A dense model reads everything; an
 * MoE reads its attention layers and shared weights plus only the experts it
 * routes to, which is why 30B-A3B decodes several times faster than a 14B dense.
 */
function activeBytes(entry, bytes) {
  if (!entry.moe || !entry.activeParams) return bytes
  const frac = entry.activeParams / entry.params
  return bytes * (0.15 + 0.85 * frac)
}

function kvBytes(entry, ctx) {
  return entry.kvKiBPerToken * KiB * ctx * KV_RATIO
}

/** llama.cpp's compute buffers and graph, on top of weights and KV cache. */
const RUNTIME_OVERHEAD = 512 * 1024 ** 2

/** The served context, or null when 16k can't be wired alongside the weights. */
function pickCtx(entry, bytes, budget) {
  if (TARGET_CTX > entry.maxCtx) return null
  if (bytes + kvBytes(entry, TARGET_CTX) + RUNTIME_OVERHEAD > budget) return null
  return TARGET_CTX
}

/**
 * Score one (model, quant) pair for this machine. Quality leads; speed can only
 * scale it down, never overturn it, a fast model that writes broken code is
 * not a better answer than a slower one that works.
 */
function evaluate(entry, quant, device, target = SPEED_TARGET) {
  const ctx = pickCtx(entry, quant.bytes, device.budgetBytes)
  const kv = kvBytes(entry, TARGET_CTX)
  // Report exactly what the fit check tested, so "needs 18.5 GB" against an
  // 18 GB budget reads as the refusal it is instead of looking like a rounding bug.
  const total = quant.bytes + kv + RUNTIME_OVERHEAD
  const tokensPerSec = (device.effectiveBandwidthGBs * GB) / activeBytes(entry, quant.bytes)
  const quality = entry.codingScore - (QUANT_PENALTY[quant.tag] ?? 3) - (entry.formatRisk ? 6 : 0)
  const speedFactor = Math.min(1, tokensPerSec / target)

  return {
    modelId: localId(entry, quant),
    catalogId: entry.id,
    label: entry.label,
    quant: quant.tag,
    file: quant.file,
    repo: entry.repo,
    url: downloadUrl(entry, quant),
    bytes: quant.bytes,
    sizeGB: round(quant.bytes / GB),
    kvGB: round(kv / GB),
    totalGB: round(total / GB),
    ctx,
    tokensPerSec: Math.round(tokensPerSec),
    params: entry.params,
    activeParams: entry.activeParams ?? null,
    moe: !!entry.moe,
    tags: entry.tags ?? [],
    blurb: entry.blurb,
    formatRisk: entry.formatRisk ?? null,
    fits: ctx !== null,
    needsGB: round(total / GB),
    score: ctx === null ? 0 : quality * (0.55 + 0.45 * speedFactor),
  }
}

/**
 * One row per model: its best-scoring quantization for this machine. Picking the
 * quantization is the engine's job, not the user's, that's the whole premise,
 * so only the winner is returned. Models that don't fit are returned too, marked
 * unfit, because "why not the big one?" is the first question anybody asks.
 */
function rank(device, priority = 'balanced') {
  const target = SPEED_TARGETS[priority] ?? SPEED_TARGET
  const rows = []
  for (const entry of CATALOG) {
    const options = entry.quants.map((q) => evaluate(entry, q, device, target))
    const fitting = options.filter((o) => o.fits)
    if (fitting.length) {
      rows.push(fitting.reduce((a, b) => (b.score > a.score ? b : a)))
    } else {
      // Smallest quant, so the "needs N GB" we print is the kindest true number.
      rows.push(options.reduce((a, b) => (b.bytes < a.bytes ? b : a)))
    }
  }
  rows.sort((a, b) => b.score - a.score || a.bytes - b.bytes)
  return rows
}

/** Human-readable justification, so the pick never looks like magic. */
function reasons(pick, device, ranked, target) {
  const out = []
  out.push(
    `${pick.sizeGB} GB of weights + ${pick.kvGB} GB of KV cache at ${(pick.ctx / 1024) | 0}k context fits inside your ${device.budgetGB} GB model budget (${device.ramGB} GB of unified memory, less what Chromium, the WebContainer sandbox and macOS need).`,
  )
  out.push(
    pick.moe
      ? `Mixture-of-experts: only ~${pick.activeParams}B of ${pick.params}B params are read per token, so on ${device.bandwidthGBs} GB/s it decodes at roughly ${pick.tokensPerSec} tok/s.`
      : `Dense ${pick.params}B at ${pick.quant} reads ${pick.sizeGB} GB per token, which your ${device.bandwidthGBs} GB/s memory turns into roughly ${pick.tokensPerSec} tok/s.`,
  )
  out.push(`${pick.quant} is the best-quality quantization that still clears ${target} tok/s on this Mac.`)
  const bigger = ranked.find((r) => !r.fits)
  if (bigger) out.push(`${bigger.label} scores higher but needs about ${bigger.needsGB} GB, so it would swap here.`)
  return out
}

/** @returns {{device, models, recommended: string|null, reasons: string[]}} */
function recommend(device, priority = 'balanced') {
  const target = SPEED_TARGETS[priority] ?? SPEED_TARGET
  const models = rank(device, priority)
  const best = models.find((m) => m.fits) ?? null
  return {
    models,
    priority,
    recommended: best?.modelId ?? null,
    reasons: best ? reasons(best, device, models, target) : ['No catalog model fits this machine.'],
  }
}

/**
 * The plan for one exact (model, quant) id, whatever priority surfaced it. The
 * browser may have shown a Q8 under "speed" that "balanced" would never pick,
 * and installing it must still resolve to that exact file.
 */
function planFor(modelId, device) {
  for (const entry of CATALOG) {
    for (const quant of entry.quants) {
      if (localId(entry, quant) === modelId) return evaluate(entry, quant, device)
    }
  }
  return null
}

function round(n) {
  return Math.round(n * 10) / 10
}

module.exports = { CATALOG, recommend, rank, planFor, localId, downloadUrl, SPEED_TARGET, SPEED_TARGETS, TARGET_CTX }
