// Reads the metadata header of a GGUF on Hugging Face, without downloading it.
//
// A model found through search has no hand-written catalog entry, so the
// numbers the fit check needs (layers, KV heads, head size, sliding window,
// experts) come from the file itself. They sit in the first couple of KB,
// ahead of the tokenizer, so one small Range request is normally all it takes.
const KiB = 1024

/** Stop reading once this much has been fetched: past it we are in the tokenizer. */
const MAX_BYTES = 8 * 1024 * KiB
const FIRST_READ = 64 * KiB

const SCALAR_BYTES = { 0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8 }
const STRING = 8
const ARRAY = 9

/**
 * Every key before the first `tokenizer.*` one, which is where llama.cpp's
 * writer puts the architecture: general.* first, then <arch>.*, then the
 * vocabulary (megabytes of it, which we never need).
 *
 * @returns {Promise<Record<string, unknown>>}
 */
async function readMetadata(url, { signal } = {}) {
  let buf = Buffer.alloc(0)
  const more = async (n) => {
    if (buf.length >= MAX_BYTES) throw new Error('GGUF header is larger than expected')
    const res = await fetch(url, {
      headers: { Range: `bytes=${buf.length}-${buf.length + n - 1}` },
      redirect: 'follow',
      signal,
    })
    // A 200 means the server ignored the Range and is sending all the weights.
    if (res.status !== 206) {
      await res.body?.cancel().catch(() => {})
      throw new Error(`HTTP ${res.status} for a ranged read`)
    }
    const chunk = Buffer.from(await res.arrayBuffer())
    if (!chunk.length) throw new Error('GGUF header ended early')
    buf = Buffer.concat([buf, chunk])
  }

  let off = 0
  const need = async (n) => {
    // Lengths come from the file itself: one that points past the header limit
    // is refused here, before it becomes a request for gigabytes of weights.
    if (off + n > MAX_BYTES) throw new Error('GGUF header is larger than expected')
    while (off + n > buf.length) await more(Math.min(Math.max(n, buf.length || FIRST_READ), MAX_BYTES - buf.length))
  }
  const u32 = async () => (await need(4), (off += 4), buf.readUInt32LE(off - 4))
  const u64 = async () => (await need(8), (off += 8), Number(buf.readBigUInt64LE(off - 8)))
  const str = async () => {
    const n = await u64()
    await need(n)
    off += n
    return buf.toString('utf8', off - n, off)
  }
  const scalar = async (type) => {
    const size = SCALAR_BYTES[type]
    if (!size) throw new Error(`Unknown GGUF value type ${type}`)
    await need(size)
    const at = off
    off += size
    switch (type) {
      case 0: return buf.readUInt8(at)
      case 1: return buf.readInt8(at)
      case 2: return buf.readUInt16LE(at)
      case 3: return buf.readInt16LE(at)
      case 4: return buf.readUInt32LE(at)
      case 5: return buf.readInt32LE(at)
      case 6: return buf.readFloatLE(at)
      case 7: return buf.readUInt8(at) !== 0
      case 10: return Number(buf.readBigUInt64LE(at))
      case 11: return Number(buf.readBigInt64LE(at))
      default: return buf.readDoubleLE(at)
    }
  }
  const value = async (type) => {
    if (type === STRING) return str()
    if (type !== ARRAY) return scalar(type)
    const itemType = await u32()
    const n = await u64()
    const items = []
    for (let i = 0; i < n; i++) items.push(await value(itemType))
    return items
  }

  await more(FIRST_READ)
  if (buf.toString('ascii', 0, 4) !== 'GGUF') throw new Error('Not a GGUF file')
  off = 4
  await u32() // version
  await u64() // tensor count
  const count = await u64()
  const meta = {}
  for (let i = 0; i < count; i++) {
    const key = await str()
    if (key.startsWith('tokenizer.')) break
    meta[key] = await value(await u32())
  }
  return meta
}

/**
 * llama.cpp sizes sliding-window layers from the architecture when the file
 * doesn't carry a per-layer pattern: every nth layer attends globally. Anything
 * not listed here is costed as full attention everywhere, which overstates the
 * cache and so can only make the fit check stricter, never wrong.
 */
const SWA_EVERY = { gemma2: 2, gemma3: 6, 'gpt-oss': 2 }

/** llama-server's default micro-batch, which the sliding-window cache holds on top of the window. */
const UBATCH = 512

/**
 * f16 KV cache, in bytes, for `ctx` tokens: what llama.cpp allocates for this
 * model with the flags model.cjs starts it with. Accounts for grouped-query
 * heads, per-layer head counts, sliding-window layers, layers that share
 * another layer's cache, hybrid models whose recurrent layers keep no KV at
 * all, and DeepSeek's compressed latent cache.
 */
function kvBytes(meta, ctx) {
  const arch = meta['general.architecture']
  const get = (k) => meta[`${arch}.${k}`]
  const at = (v, i) => (Array.isArray(v) ? v[i] : v)

  const layers = get('block_count')
  const heads = get('attention.head_count')
  if (!layers || !heads) return null
  const kvHeads = get('attention.head_count_kv') ?? heads
  const keyLen = get('attention.key_length') ?? get('embedding_length') / at(heads, 0)
  const valueLen = get('attention.value_length') ?? keyLen
  const keyLenSwa = get('attention.key_length_swa') ?? keyLen
  const valueLenSwa = get('attention.value_length_swa') ?? valueLen
  const window = get('attention.sliding_window')
  const pattern = get('attention.sliding_window_pattern')
  const every = SWA_EVERY[arch]
  const shared = get('attention.shared_kv_layers') ?? 0
  const interval = get('full_attention_interval')
  const latentRank = get('attention.kv_lora_rank')
  const ropeDims = get('rope.dimension_count') ?? 0
  const swaTokens = window ? Math.min(ctx, Math.ceil((window + UBATCH) / 256) * 256) : ctx

  let total = 0
  for (let i = 0; i < layers - shared; i++) {
    if (interval && (i + 1) % interval !== 0) continue // recurrent layer
    const h = at(kvHeads, i)
    if (!h) continue // no attention in this layer
    const sliding = !!window && (Array.isArray(pattern) ? !!pattern[i] : every ? i % every < every - 1 : false)
    const perToken = latentRank
      ? 2 * latentRank + ropeDims
      : h * (sliding ? keyLenSwa + valueLenSwa : keyLen + valueLen)
    total += perToken * 2 * (sliding ? swaTokens : ctx)
  }
  return total
}

/**
 * Parameters read per token, in billions, for a mixture-of-experts model:
 * everything except the experts the router skips. Null for a dense model.
 */
function activeParams(meta, totalParams) {
  const arch = meta['general.architecture']
  const get = (k) => meta[`${arch}.${k}`]
  const experts = get('expert_count')
  const used = get('expert_used_count')
  if (!experts || !used) return null
  const ffn = get('expert_feed_forward_length')
  if (ffn && totalParams) {
    const moeLayers = get('block_count') - (get('leading_dense_block_count') ?? 0)
    const skipped = (experts - used) * 3 * get('embedding_length') * ffn * moeLayers
    if (skipped > 0 && skipped < totalParams) return (totalParams - skipped) / 1e9
  }
  // Fall back on the label the converter wrote, "30B-A3B".
  const label = /A(\d+(?:\.\d+)?)B/i.exec(String(meta['general.size_label'] ?? ''))
  return label ? Number(label[1]) : null
}

module.exports = { readMetadata, kvBytes, activeParams }
