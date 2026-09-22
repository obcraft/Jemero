// Hugging Face search: any GGUF chat model, sized for this Mac like a catalog one.
//
// The catalog (catalog.cjs) is a judgement about which models write good
// components. Search is for everything else, a Gemma, a Llama, a Phi, whatever
// came out last week, and every result goes through the same fit check and
// quant picker. Nothing is guessed: file sizes and checksums come from the Hub
// API, and the layers, KV heads and context window from the GGUF header itself.
const { CATALOG, QUANT_PENALTY, SPEED_TARGETS, SPEED_TARGET, TARGET_CTX, bestPlan, downloadUrl, remember } = require('./catalog.cjs')
const { readMetadata, kvBytes, activeParams } = require('./gguf.cjs')

const HUB = 'https://huggingface.co'
const MAX_RESULTS = 8
const TIMEOUT_MS = 12000
const CACHE_MS = 10 * 60 * 1000

/**
 * Past the model someone is looking for, a search trails off into hundreds of
 * one-off fine-tunes with a few hundred downloads each. Anything used less than
 * this share of the query's most-used model is that tail.
 */
const MIN_SHARE = 0.03

/** "org/name", with no "." or ".." segment. */
const REPO_ID = /^[\w-][\w.-]*\/[\w-][\w.-]*$/

/** Speculative-decoding drafts: small companions to a big model, not models to chat with. */
const DRAFT = /\b(?:dflash|eagle\d*|draft)\b/i

/**
 * Bits per weight a real 4- to 8-bit file lands in. A file far outside it
 * isn't this repo's model at all (a draft head, a projector, a mislabelled
 * upload), and sizing the model from it would make the fit check a lie.
 */
const BITS_PER_WEIGHT = [3, 12]

/** A GGUF with one of these pipelines is something other than a chat model. */
const NOT_CHAT = new Set([
  'feature-extraction',
  'sentence-similarity',
  'fill-mask',
  'text-classification',
  'token-classification',
  'zero-shot-classification',
  'text-ranking',
  'text-to-speech',
  'text-to-audio',
  'automatic-speech-recognition',
  'audio-to-audio',
  'text-to-image',
  'image-to-image',
])

/**
 * A search result has no codingScore, nobody has judged it. Within one model
 * the score only chooses the quantization, so any constant works; this one
 * keeps unjudged models below the catalog's when both are downloaded.
 */
const UNRATED_SCORE = 50

/**
 * The quant tag in a GGUF file name, if it's one the catalog would offer.
 * Files in subfolders and multi-part files are skipped: the store downloads
 * one file per model, and those layouts are only used for very large quants.
 */
function quantOf(file) {
  if (file.includes('/') || !/\.gguf$/i.test(file) || /mmproj|-\d{5}-of-\d{5}/i.test(file) || DRAFT.test(file)) return null
  const m = /(?:^|[-_.])((?:UD-)?(?:I?Q\d(?:_[A-Z0-9]+)*|MXFP4(?:_MOE)?))$/i.exec(file.replace(/\.gguf$/i, ''))
  if (!m) return null
  let tag = m[1].toUpperCase()
  if (/^Q\d_K_XL$/.test(tag)) tag = `UD-${tag}` // unsloth's older spelling
  return tag in QUANT_PENALTY ? tag : null
}

/**
 * The model a repo quantizes, as one name: "unsloth/gemma-3-1b-it-GGUF",
 * "ggml-org/gemma-3-1b-it-GGUF" and "bartowski/google_gemma-3-1b-it-GGUF"
 * are all "gemma-3-1b-it", and should be one row, not three.
 */
function modelName(repo, baseModel) {
  let name = repo.split('/')[1].replace(/[-_.]gguf(?=[-_.]|$)/i, '')
  const baseOrg = baseModel?.split('/')[0]
  if (baseOrg && name.toLowerCase().startsWith(`${baseOrg.toLowerCase()}_`)) name = name.slice(baseOrg.length + 1)
  // "gemma-3-1b-it-qat-q4_0" is the same model as "gemma-3-1b-it-qat".
  return name.replace(/[-_.](?:i?q\d\w*|bf16|f16)$/i, '')
}

async function getJSON(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) })
  if (res.status === 429) throw new Error('Hugging Face is limiting searches right now. Try again in a minute.')
  if (!res.ok) throw new Error(`Hugging Face returned ${res.status}.`)
  return res.json()
}

/** Run `fn` over `items`, at most `limit` at a time, keeping order. */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

/** Per repo, for the session: an overlapping query ("gemma" → "gemma 1b") costs nothing twice. */
const repoCache = new Map()

/**
 * A catalog entry for one repo. Null when it can't be sized honestly (no
 * usable quant, or a header we can't read), because a model with a made-up
 * fit is worse than a model left out.
 */
async function toEntry({ name, repo, hit, downloads }) {
  if (!repoCache.has(repo)) {
    // A network failure is forgotten so the next search retries; a repo that
    // simply has nothing usable stays cached as null.
    repoCache.set(repo, describeRepo(name, repo, hit).catch(() => (repoCache.delete(repo), null)))
  }
  const entry = await repoCache.get(repo)
  return entry && remember({ ...entry, downloads })
}

async function describeRepo(name, repo, hit) {
  const info = await getJSON(`${HUB}/api/models/${repo}?blobs=true`)
  const total = hit.gguf?.total
  const byTag = new Map()
  for (const s of info.siblings ?? []) {
    const tag = quantOf(s.rfilename)
    const bytes = s.lfs?.size ?? s.size
    if (!tag || !bytes || byTag.has(tag)) continue
    const bits = total ? (bytes * 8) / total : null
    if (bits !== null && (bits < BITS_PER_WEIGHT[0] || bits > BITS_PER_WEIGHT[1])) continue
    byTag.set(tag, { tag, file: s.rfilename, bytes })
  }
  const quants = [...byTag.values()]
  if (!quants.length) return null

  // Every quant of a model shares one header; the smallest file answers fastest.
  const smallest = quants.reduce((a, b) => (b.bytes < a.bytes ? b : a))
  const meta = await readMetadata(downloadUrl({ repo }, smallest), { signal: AbortSignal.timeout(TIMEOUT_MS) })
  const arch = meta['general.architecture']
  const kv = kvBytes(meta, TARGET_CTX)
  if (!arch || kv === null) return null

  const params = hit.gguf?.total ? hit.gguf.total / 1e9 : null
  const active = params ? activeParams(meta, hit.gguf.total) : null
  return {
    id: `hf:${repo}`,
    source: 'hub',
    label: name,
    repo,
    params: params && round(params),
    ...(active && { activeParams: round(active), moe: true }),
    codingScore: UNRATED_SCORE,
    qat: /\bqat\b/i.test(repo.replace(/[-_]/g, ' ')),
    // Measured at the 16k this app serves, so sliding-window layers (which hold
    // a fixed window, not the whole context) are costed at what they really take.
    kvKiBPerToken: kv / 1024 / TARGET_CTX,
    maxCtx: meta[`${arch}.context_length`] ?? hit.gguf?.context_length ?? TARGET_CTX,
    ...(arch === 'gpt-oss' && {
      formatRisk: 'Emits reasoning in its own channel format rather than <think>, which the parser strips.',
    }),
    tags: [arch],
    blurb: `From huggingface.co/${repo}`,
    quants,
  }
}

const searches = new Map() // normalised query -> { at, entries }

/**
 * Chat models on Hugging Face matching `query`, most used first, each at its
 * best quantization for `device`. Catalog models are left out: the browser
 * already lists them, with a real judgement behind them.
 */
async function search(query, device, priority = 'balanced') {
  const q = String(query ?? '').trim().replace(/\s+/g, ' ')
  if (q.length < 2) return []
  const key = q.toLowerCase()
  let hit = searches.get(key)
  if (!hit || Date.now() - hit.at > CACHE_MS) {
    hit = { at: Date.now(), entries: await find(q) }
    searches.set(key, hit)
  }
  const target = SPEED_TARGETS[priority] ?? SPEED_TARGET
  return hit.entries.map((entry) => bestPlan(entry, device, target))
}

async function find(q) {
  const params = new URLSearchParams({ search: q, filter: 'gguf', sort: 'downloads', direction: '-1', limit: '60' })
  for (const field of ['gguf', 'downloads', 'gated', 'pipeline_tag', 'cardData', 'siblings']) params.append('expand[]', field)
  const hits = await getJSON(`${HUB}/api/models?${params}`)

  const curated = new Set(CATALOG.map((e) => modelName(e.repo).toLowerCase()))
  const groups = new Map()
  for (const m of hits) {
    // The id becomes a folder on disk (install.cjs), so only a plain org/name will do.
    if (!REPO_ID.test(m.id ?? '')) continue
    if (m.gated) continue // can't be downloaded without an account
    if (!m.gguf?.chat_template || NOT_CHAT.has(m.pipeline_tag) || DRAFT.test(m.id)) continue
    if (!m.siblings?.some((s) => quantOf(s.rfilename))) continue
    const name = modelName(m.id, [].concat(m.cardData?.base_model ?? [])[0])
    const key = name.toLowerCase()
    // Hits arrive most-downloaded first, so the first repo seen for a model is
    // the one to offer; the others only add to how popular the model is.
    const group = groups.get(key)
    if (group) group.downloads += m.downloads ?? 0
    else groups.set(key, { key, name, repo: m.id, hit: m, downloads: m.downloads ?? 0 })
  }

  const ranked = [...groups.values()].sort((a, b) => b.downloads - a.downloads)
  // Catalog models set the bar too (so "gpt-oss" doesn't fill up with gpt-oss
  // fine-tunes), but aren't returned: the browser already lists them.
  const floor = (ranked[0]?.downloads ?? 0) * MIN_SHARE
  const top = ranked.filter((g) => g.downloads >= floor && !curated.has(g.key)).slice(0, MAX_RESULTS)
  return (await mapLimit(top, 5, toEntry)).filter(Boolean)
}

function round(n) {
  return Math.round(n * 10) / 10
}

module.exports = { search, quantOf, modelName }
