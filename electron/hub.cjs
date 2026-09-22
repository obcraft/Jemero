// Public Hugging Face GGUF discovery. Sizes and memory layouts come from the
// Hub and GGUF headers; popularity ranks results but never excludes a model.
const { QUANT_PENALTY, SPEED_TARGETS, SPEED_TARGET, TARGET_CTX, bestPlan, downloadUrl, remember } = require('./catalog.cjs')
const { readMetadata, kvBytes, activeParams } = require('./gguf.cjs')

const HUB = 'https://huggingface.co'
const PAGE_SIZE = 24
const TIMEOUT_MS = 20000
const CACHE_MS = 10 * 60 * 1000
const REPO_ID = /^[\w-][\w.-]*\/[\w-][\w.-]*$/
const DRAFT = /\b(?:dflash|eagle\d*|draft)\b/i
const NOT_CHAT = new Set([
  'feature-extraction', 'sentence-similarity', 'fill-mask', 'text-classification',
  'token-classification', 'zero-shot-classification', 'text-ranking',
  'text-to-speech', 'text-to-audio', 'automatic-speech-recognition',
  'audio-to-audio', 'text-to-image', 'image-to-image',
])
// Architectures in the pinned llama.cpp runtime. Unknown/new architectures stay
// visible but disabled until their runtime support and memory layout are known.
const SUPPORTED_ARCH = new Set(require('./runtime-architectures.json'))

function quantOf(file) {
  if (!file || file.split('/').some((p) => !p || p === '.' || p === '..') || file.includes('\\')) return null
  if (!/\.gguf$/i.test(file) || /mmproj|projector|(?:^|[-_.])(?:vision|audio|mtp)(?:[-_.]|$)|-\d{5}-of-\d{5}/i.test(file) || DRAFT.test(file)) return null
  const match = /(?:^|[-_.])((?:UD-)?(?:I?Q\d(?:_[A-Z0-9]+)*|MXFP4(?:_MOE)?|BF16|F16|F32))$/i.exec(file.replace(/\.gguf$/i, ''))
  if (!match) return null
  let tag = match[1].toUpperCase()
  if (/^Q\d_K_XL$/.test(tag)) tag = `UD-${tag}`
  return tag in QUANT_PENALTY ? tag : null
}

function modelName(repo, baseModel) {
  let name = repo.split('/')[1].replace(/[-_.]gguf(?=[-_.]|$)/i, '')
  const baseOrg = typeof baseModel === 'string' ? baseModel.split('/')[0] : null
  if (baseOrg && name.toLowerCase().startsWith(`${baseOrg.toLowerCase()}_`)) name = name.slice(baseOrg.length + 1)
  return name.replace(/[-_.](?:i?q\d\w*|bf16|f16)$/i, '')
}

async function getResponse(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) })
  if (res.status === 429) throw new Error('Hugging Face is limiting searches right now. Try again in a minute.')
  if (!res.ok) throw new Error(`Hugging Face returned ${res.status}.`)
  return res
}
const getJSON = async (url) => (await getResponse(url)).json()

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i])
    }
  }))
  return out
}

const repoCache = new Map()
async function toEntry(hit) {
  const repo = hit.id
  if (!repoCache.has(repo)) {
    const name = modelName(repo, [].concat(hit.cardData?.base_model ?? [])[0])
    repoCache.set(repo, describeRepo(name, repo, hit).catch((err) => {
      repoCache.delete(repo)
      throw err
    }))
  }
  const entry = await repoCache.get(repo)
  return entry && remember({ ...entry, downloads: hit.downloads ?? 0 })
}

async function describeRepo(name, repo, hit = {}) {
  const info = await getJSON(`${HUB}/api/models/${repo}?blobs=true`)
  if (info.gated) throw new Error('This repository requires Hugging Face access approval. Use a public GGUF conversion.')
  if (NOT_CHAT.has(info.pipeline_tag) || DRAFT.test(repo)) return null
  const total = info.gguf?.total ?? hit.gguf?.total
  const quants = (info.siblings ?? []).flatMap((s) => {
    const tag = quantOf(s.rfilename)
    const bytes = s.lfs?.size ?? s.size
    if (!tag || !Number.isFinite(bytes) || bytes <= 0) return []
    // Repositories can also hold small companion networks. Their size must not
    // be mistaken for the full LLM's weights (especially full-precision heads).
    const bits = tag === 'F32' ? 32 : /^(?:BF16|F16)$/.test(tag) ? 16 : Number(/(?:I?Q)(\d)/.exec(tag)?.[1] ?? 4)
    if (total && bytes * 8 / total < bits * 0.6) return []
    return [{ tag, file: s.rfilename, bytes }]
  })
  if (!quants.length) return null
  const smallest = quants.reduce((a, b) => b.bytes < a.bytes ? b : a)
  const meta = await readMetadata(downloadUrl({ repo }, smallest), { signal: AbortSignal.timeout(TIMEOUT_MS) })
  const arch = meta['general.architecture']
  const kv = kvBytes(meta, TARGET_CTX)
  const maxCtx = meta[`${arch}.context_length`] ?? info.gguf?.context_length ?? hit.gguf?.context_length
  const validLayout = Number.isFinite(kv) && kv >= 0 && Number.isFinite(maxCtx) && maxCtx > 0
  const labelParams = /(\d+(?:\.\d+)?)\s*([bm])/i.exec(String(meta['general.size_label'] ?? name))
  const params = total ? total / 1e9 : labelParams ? Number(labelParams[1]) / (labelParams[2].toLowerCase() === 'm' ? 1000 : 1) : null
  const active = total ? activeParams(meta, total) : null
  return {
    id: `hf:${repo}`, source: 'hub', storageVersion: 2, label: name, repo,
    params: params && Math.round(params * 1000) / 1000,
    ...(active && { activeParams: Math.round(active * 100) / 100, moe: true }),
    codingScore: 50,
    qat: /\bqat\b/i.test(repo.replace(/[-_]/g, ' ')),
    kvKiBPerToken: validLayout ? kv / 1024 / TARGET_CTX : 0,
    // Preserve the layout: sliding-window memory is not linear in context size.
    kvMetadata: Object.fromEntries(Object.entries(meta).filter(([key]) => key === 'general.architecture' || key.startsWith(`${arch}.`))),
    maxCtx: Number.isFinite(maxCtx) ? maxCtx : 0,
    unsupportedReason: !SUPPORTED_ARCH.has(arch)
      ? `The bundled runtime does not support ${arch ?? 'this architecture'}.`
      : !validLayout ? 'The model’s memory requirements could not be verified.' : null,
    tags: [arch ?? 'gguf', ...(params && params <= 1 ? ['tiny'] : [])],
    blurb: `From huggingface.co/${repo}`,
    quants,
  }
}

function repoFromQuery(query) {
  const raw = query.replace(/^https?:\/\/(?:www\.)?(?:huggingface\.co|hf\.co)\//i, '').replace(/\/$/, '')
  return REPO_ID.test(raw) ? raw : null
}

const wordsFor = (q) => q.toLowerCase().split(/[\s/_-]+/).filter(Boolean)
function matchesWord(haystack, word) {
  if (/^\d+(?:\.\d+)?[bm]$/i.test(word)) {
    const escaped = word.replace('.', '\\.')
    return new RegExp(`(?:^|[^0-9.])${escaped}(?![a-z0-9])`, 'i').test(haystack)
  }
  return haystack.includes(word)
}
const searches = new Map()

/** A cursor walks all matching Hub repositories, with no popularity cutoff. */
async function searchPage(query, device, priority = 'balanced', page = 0) {
  const q = String(query ?? '').trim().replace(/\s+/g, ' ')
  if (q.length < 2) return { results: [], hasMore: false }
  if (!Number.isInteger(page) || page < 0 || page > 1000) throw new Error('Invalid search page.')
  const key = q.toLowerCase()
  let state = searches.get(key)
  if (!state || Date.now() - state.at > CACHE_MS) {
    const repo = repoFromQuery(q)
    const words = wordsFor(q)
    const term = words.filter((w) => !/^\d/.test(w)).sort((a, b) => b.length - a.length)[0] ?? words[0]
    const params = new URLSearchParams({ search: term, filter: 'gguf', sort: 'downloads', direction: '-1', limit: '100' })
    for (const field of ['gguf', 'downloads', 'gated', 'pipeline_tag', 'cardData', 'siblings']) params.append('expand[]', field)
    state = { at: Date.now(), repo, words, next: `${HUB}/api/models?${params}`, queue: [], pages: [], seen: new Set(), lock: Promise.resolve() }
    searches.set(key, state)
  }
  // Serialize pagination of the same query; priority changes reuse discovered entries.
  const work = state.lock.catch(() => {}).then(async () => {
    while (state.pages.length <= page) {
      if (state.repo) {
        const entry = await toEntry({ id: state.repo })
        if (!entry) throw new Error('No supported single-file GGUF language model was found in this repository. Search for a GGUF conversion of its name.')
        state.pages.push({ entries: [entry], hasMore: false })
        state.repo = null
        state.next = null
        continue
      }
      const entries = []
      // Bound each request's work; a page can be empty but still offer Load more.
      let batches = 0
      while (entries.length < PAGE_SIZE && (state.queue.length || state.next) && batches++ < 8) {
        if (!state.queue.length && state.next) {
          const res = await getResponse(state.next)
          const hits = await res.json()
          const next = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get('link') ?? '')?.[1]
          state.next = next && next.startsWith(`${HUB}/api/models?`) ? next : null
          state.queue = hits.filter((m) => {
            if (!REPO_ID.test(m.id ?? '') || NOT_CHAT.has(m.pipeline_tag) || DRAFT.test(m.id)) return false
            if (m.gated || !m.siblings?.some((s) => quantOf(s.rfilename))) return false
            const haystack = m.id.toLowerCase()
            return state.words.every((word) => matchesWord(haystack, word)) && !state.seen.has(m.id)
          })
        }
        const hits = state.queue.splice(0, PAGE_SIZE - entries.length)
        const results = await mapLimit(hits, 5, async (hit) => {
          try { return { hit, entry: await toEntry(hit) } }
          catch (error) { return { hit, error } }
        })
        const failed = results.filter((r) => r.error)
        for (const result of results) {
          if (result.error) continue
          state.seen.add(result.hit.id)
          if (result.entry) entries.push(result.entry)
        }
        if (failed.length) {
          state.queue.unshift(...failed.map((r) => r.hit))
          if (!entries.length) throw failed[0].error
          break
        }
      }
      state.pages.push({ entries, hasMore: !!(state.queue.length || state.next) })
      if (!state.next && !state.queue.length && state.pages.length <= page) break
    }
  })
  state.lock = work
  await work
  const target = SPEED_TARGETS[priority] ?? SPEED_TARGET
  const result = state.pages[page] ?? { entries: [], hasMore: false }
  return { results: result.entries.map((e) => bestPlan(e, device, target)), hasMore: result.hasMore }
}

// Retain the array interface for the terminal picker.
async function search(query, device, priority) {
  return (await searchPage(query, device, priority)).results
}

module.exports = { search, searchPage, quantOf, modelName, describeRepo, repoFromQuery, matchesWord }
