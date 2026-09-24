const { test } = require('node:test')
const assert = require('node:assert/strict')
const { CATALOG, bestPlan, rank, downloadUrl, localId, MIN_CTX } = require('../electron/catalog.cjs')
const { kvBytes } = require('../electron/gguf.cjs')
const { quantOf, repoFromQuery, searchPage, matchesWord } = require('../electron/hub.cjs')
const { chatBudget } = require('../electron/chat-context.cjs')
const GB = 1024 ** 3
const device = (gb) => ({ budgetBytes: gb * GB, effectiveBandwidthGBs: 75 })

test('the offline catalog includes Gemma 1B and many runnable models at or below one billion parameters', () => {
  assert.ok(CATALOG.length >= 40)
  const rows = rank(device(2))
  assert.ok(rows.find(m => m.label === 'Gemma 3 1B').fits)
  assert.ok(rows.find(m => m.label === 'Gemma 3 270M').fits)
  assert.ok(rows.filter(m => m.params <= 1 && m.fits).length >= 7)
  assert.equal(rows.find(m => m.label === 'Llama 3.3 70B').fits, false)
})

test('native short contexts are enabled and reported accurately', () => {
  for (const [label, context] of [['SmolLM2 135M', 8192], ['TinyLlama 1.1B', 2048], ['Phi-3 Mini 3.8B', 4096]]) {
    const row = rank(device(16)).find(m => m.label === label)
    assert.equal(row.fits, true)
    assert.equal(row.ctx, context)
  }
})

test('reducing context permits a fitting model without exceeding the budget', () => {
  const entry = { id: 'test', repo: 'test/model', label: 'Test', params: 1, codingScore: 50, kvKiBPerToken: 128, maxCtx: 16384, quants: [{ tag: 'Q4_K_M', file: 'test-Q4_K_M.gguf', bytes: GB }] }
  const plan = bestPlan(entry, device(2.1))
  assert.equal(plan.ctx, 4096)
  assert.ok(plan.totalGB <= 2.1)
  const small = bestPlan(entry, device(1.5))
  assert.equal(small.fits, false)
  assert.equal(small.limit, 'memory')
  assert.ok(small.needsGB > 1.5)
})

test('all offered catalog quants have finite sizes and fitting contexts respect memory', () => {
  for (const budget of [0, 1, 2, 4, 8, 16, 64]) {
    for (const entry of CATALOG) {
      const plan = bestPlan(entry, device(budget))
      assert.ok(Number.isFinite(plan.needsGB), entry.label)
      if (plan.fits) {
        assert.ok(plan.ctx >= MIN_CTX && plan.ctx <= entry.maxCtx)
        const kv = entry.kvMetadata ? kvBytes(entry.kvMetadata, plan.ctx) : entry.kvKiBPerToken * 1024 * plan.ctx
        assert.ok(plan.bytes + kv + 512 * 1024 ** 2 <= budget * GB, entry.label)
      }
    }
  }
})

test('unsupported runtime models stay disabled even with ample RAM', () => {
  const entry = { ...CATALOG[0], unsupportedReason: 'Runtime unsupported.' }
  const row = bestPlan(entry, device(1000))
  assert.equal(row.fits, false)
  assert.equal(row.limit, 'runtime')
})

test('single GGUF subfolders and smaller/full precision quantizations are accepted', () => {
  for (const [file, tag] of [['small/model-Q2_K.gguf', 'Q2_K'], ['model-IQ4_XS.gguf', 'IQ4_XS'], ['model-F16.gguf', 'F16'], ['model-Q8_0.gguf', 'Q8_0']]) assert.equal(quantOf(file), tag)
  for (const file of ['../model-Q4_K_M.gguf', 'mmproj-Q4_K_M.gguf', 'model-Q4_K_M-00001-of-00002.gguf', 'draft-Q4_K_M.gguf', 'model.safetensors']) assert.equal(quantOf(file), null)
  const q = { file: 'small/model-Q4_K_M.gguf' }
  assert.equal(downloadUrl({ repo: 'org/name' }, q), 'https://huggingface.co/org/name/resolve/main/small/model-Q4_K_M.gguf?download=true')
  assert.equal(localId({ repo: 'org/name' }, q).split('/').length, 2)
  assert.notEqual(localId({ repo: 'org/name' }, q), localId({ repo: 'org/name' }, { file: 'other/model-Q4_K_M.gguf' }))
})

test('repository IDs and Hugging Face URLs resolve directly', () => {
  assert.equal(repoFromQuery('unsloth/gemma-3-1b-it-GGUF'), 'unsloth/gemma-3-1b-it-GGUF')
  assert.equal(repoFromQuery('https://huggingface.co/unsloth/gemma-3-1b-it-GGUF/'), 'unsloth/gemma-3-1b-it-GGUF')
  assert.equal(repoFromQuery('gemma 1b'), null)
  assert.equal(repoFromQuery('https://example.com/a/b'), null)
})

// Minimal GGUF metadata fixture, no weights or tokenizer download.
function header() {
  const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b }
  const u64 = n => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b }
  const str = s => Buffer.concat([u64(Buffer.byteLength(s)), Buffer.from(s)])
  const fields = { 'general.architecture': 'llama', 'llama.block_count': 4, 'llama.attention.head_count': 4, 'llama.embedding_length': 128, 'llama.context_length': 4096 }
  return Buffer.concat([Buffer.from('GGUF'), u32(3), u64(0), u64(Object.keys(fields).length), ...Object.entries(fields).flatMap(([k, v]) => [str(k), u32(typeof v === 'string' ? 8 : 4), typeof v === 'string' ? str(v) : u32(v)])])
}

test('Hub pagination keeps unpopular matches and handles multiword searches', async (t) => {
  const hits = Array.from({ length: 30 }, (_, i) => ({ id: `test/paginationgemma-3-1b-${i}-GGUF`, downloads: i === 0 ? 100000 : 1, siblings: [{ rfilename: 'model-Q4_K_M.gguf' }] }))
  const urls = []
  t.mock.method(global, 'fetch', async (input) => {
    const url = new URL(input)
    urls.push(url)
    if (url.pathname === '/api/models') return Response.json(hits)
    if (url.pathname.startsWith('/api/models/')) return Response.json({ gguf: { total: 100000000 }, siblings: [{ rfilename: 'model-Q4_K_M.gguf', size: 100000000 }] })
    return new Response(header(), { status: 206 })
  })
  const first = await searchPage('paginationgemma 1b', device(8))
  assert.equal(first.results.length, 24)
  assert.equal(first.hasMore, true)
  const second = await searchPage('paginationgemma 1b', device(8), 'balanced', 1)
  assert.equal(second.results.length, 6)
  assert.equal(second.hasMore, false)
  assert.equal(urls[0].searchParams.get('search'), 'paginationgemma')
})

test('Hub follows API cursors beyond its initial repository batch', async (t) => {
  let listCalls = 0
  t.mock.method(global, 'fetch', async (input) => {
    const url = new URL(input)
    if (url.pathname === '/api/models') {
      listCalls++
      if (!url.searchParams.has('cursor')) return Response.json([], { headers: { link: '<https://huggingface.co/api/models?cursor=next>; rel="next"' } })
      return Response.json([{ id: 'test/cursormodel-1b-GGUF', siblings: [{ rfilename: 'model-Q4_K_M.gguf' }] }])
    }
    if (url.pathname.startsWith('/api/models/')) return Response.json({ gguf: { total: 1e8 }, siblings: [{ rfilename: 'model-Q4_K_M.gguf', size: 1e8 }] })
    return new Response(header(), { status: 206 })
  })
  const result = await searchPage('cursormodel 1b', device(8))
  assert.equal(listCalls, 2)
  assert.equal(result.results.length, 1)
})

test('short-context answers use the actual tokenizer and oversized prompts fail clearly', async (t) => {
  let tokens = 1500
  t.mock.method(global, 'fetch', async (url, opts) => {
    if (url.endsWith('/props')) return Response.json({ default_generation_settings: { n_ctx: 2048 } })
    if (url.endsWith('/apply-template')) return Response.json({ prompt: '<bos>actual formatted prompt' })
    assert.equal(JSON.parse(opts.body).parse_special, true)
    return Response.json({ tokens: Array(tokens).fill(1) })
  })
  const request = { messages: [{ role: 'user', content: 'Hello' }], maxTokens: 4096 }
  const budget = await chatBudget('http://localhost', request)
  assert.equal(budget.maxTokens, 516)
  tokens = 2000
  await assert.rejects(chatBudget('http://localhost', request), /Shorten the prompt/)
})

test('parameter searches do not match the suffix of larger model sizes', () => {
  assert.equal(matchesWord('gemma-4-31b-it', '1b'), false)
  assert.equal(matchesWord('gemma-3-1b-it', '1b'), true)
  assert.equal(matchesWord('qwen2.5-0.5b', '0.5b'), true)
})


test('new Hub downloads distinguish identical filenames in different repositories', () => {
  const entry = { repo: 'org/first', source: 'hub', storageVersion: 2 }
  const quant = { file: 'model-Q4_K_M.gguf' }
  assert.notEqual(localId(entry, quant), localId({ ...entry, repo: 'org/second' }, quant))
  assert.equal(localId({ ...entry, storageVersion: undefined }, quant), 'org/model-Q4_K_M')
})

test('the context ladder always tries the minimum before giving up', () => {
  // 12288 halves to 6144, 3072, 1536, 768 and then 256, below the minimum: 512 must still be tried.
  const entry = { ...CATALOG.find((e) => e.label === 'Gemma 3 270M'), maxCtx: 12288, kvMetadata: undefined, kvKiBPerToken: 1024 }
  const quant = entry.quants[0]
  const budget = quant.bytes + 512 * 1024 ** 2 + MIN_CTX * 1024 * 1024 * 1.05
  const plan = bestPlan({ ...entry, quants: [quant] }, { budgetBytes: budget, effectiveBandwidthGBs: 75 })
  assert.equal(plan.fits, true)
  assert.equal(plan.ctx, MIN_CTX)
})

test('removing a model only accepts model ids, never a path', async () => {
  const { remove } = require('../electron/install.cjs')
  for (const id of ['', '..', '../..', 'org', 'a/b/c', 'org/..']) assert.equal((await remove(id)).ok, false, id)
})

test('a Hugging Face link into a repository names that repository', () => {
  assert.equal(repoFromQuery('https://huggingface.co/ggml-org/gemma-3-1b-it-GGUF/tree/main'), 'ggml-org/gemma-3-1b-it-GGUF')
  assert.equal(repoFromQuery('hf.co/ggml-org/gemma-3-1b-it-GGUF/blob/main/gemma-3-1b-it-Q8_0.gguf'), 'ggml-org/gemma-3-1b-it-GGUF')
})
