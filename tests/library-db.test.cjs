const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { openLibrary } = require('../electron/library-db.cjs')

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'jemero-db-'))

const item = (id, versions = 1) => ({
  id,
  name: `Item ${id}`,
  kind: 'component',
  createdAt: 1,
  updatedAt: 2,
  versions: Array.from({ length: versions }, (_, i) => ({
    files: { 'A.jsx': `export default () => ${i}`, 'b.js': 'export const b = 1' },
    entry: 'A.jsx',
    kit: 'shadcn',
    packs: { formatVersion: 1, packs: { katex: '0.18.7' } },
    plan: 'p',
    prompt: `v${i + 1}`,
    mode: i ? 'refine' : 'build',
    createdAt: 10 + i,
  })),
  turns: [
    { id: 't1', role: 'user', mode: 'build', text: 'make it', at: 5 },
    { id: 't2', role: 'assistant', mode: 'build', text: '', review: ['a', 'b'], version: 1, at: 6 },
  ],
})

test('a library saves and loads back exactly, versions, files, locks and turns included', () => {
  const dir = tmp()
  try {
    const lib = openLibrary(dir)
    const library = { version: 1, items: [item('a', 2), item('b')] }
    lib.save(library)
    lib.close()
    const again = openLibrary(dir)
    assert.deepEqual(again.load(), library)
    again.close()
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('saving again updates in place and removes what is gone', () => {
  const dir = tmp()
  try {
    const lib = openLibrary(dir)
    lib.save({ version: 1, items: [item('a', 3), item('b')] })
    const a = item('a', 1)
    a.versions[0].files = { 'A.jsx': 'export default () => "edited"' }
    a.turns = a.turns.slice(0, 1)
    lib.save({ version: 1, items: [a] })
    const out = lib.load()
    assert.deepEqual(out.items.map((i) => i.id), ['a'])
    assert.equal(out.items[0].versions.length, 1)
    assert.deepEqual(out.items[0].versions[0].files, { 'A.jsx': 'export default () => "edited"' })
    assert.equal(out.items[0].turns.length, 1)
    lib.close()
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('saving changes writes only the changed items, and applies removals and order from the id list', () => {
  const dir = tmp()
  try {
    const lib = openLibrary(dir)
    lib.save({ version: 1, items: [item('a', 2), item('b'), item('c')] })
    const b = item('b', 2)
    b.name = 'Renamed'
    // 'a' is sent by id only: whatever it held stays exactly as saved.
    lib.saveChanges({ order: ['b', 'a'], items: [b] })
    const out = lib.load()
    assert.deepEqual(out.items.map((i) => i.id), ['b', 'a'])
    assert.equal(out.items[0].name, 'Renamed')
    assert.equal(out.items[0].versions.length, 2)
    assert.deepEqual(out.items[1], item('a', 2))
    lib.close()
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('without pruning, items missing from the order are kept', () => {
  const dir = tmp()
  try {
    const lib = openLibrary(dir)
    lib.save({ version: 1, items: [item('a'), item('b')] })
    lib.saveChanges({ order: ['c'], items: [item('c')] }, { prune: false })
    assert.deepEqual(lib.load().items.map((i) => i.id).sort(), ['a', 'b', 'c'])
    lib.close()
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('drafts are saved as written, survive a reopen, and clear once the version is saved', () => {
  const dir = tmp()
  try {
    let lib = openLibrary(dir)
    lib.save({ version: 1, items: [item('a')] })
    lib.saveDraft('a', [{ path: 'A.jsx', content: 'export default fun', complete: false }])
    lib.saveDraft('a', [
      { path: 'A.jsx', content: 'export default function A() {}', complete: true },
      { path: 'b.js', content: 'export const', complete: false },
    ])
    lib.close()
    lib = openLibrary(dir) // a crash or quit in between
    const drafts = lib.drafts()
    assert.deepEqual(Object.keys(drafts), ['a'])
    assert.deepEqual(
      drafts.a.map((f) => [f.path, f.content, f.complete]),
      [
        ['A.jsx', 'export default function A() {}', true],
        ['b.js', 'export const', false],
      ],
    )
    lib.clearDraft('a')
    assert.deepEqual(lib.drafts(), {})
    lib.close()
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('an existing library.json is moved into the database once and kept as a backup', () => {
  const dir = tmp()
  try {
    const json = path.join(dir, 'library.json')
    const library = { version: 1, items: [item('old', 2)] }
    fs.writeFileSync(json, JSON.stringify(library))
    const lib = openLibrary(dir)
    assert.equal(lib.migrateFromJson(json), true)
    assert.deepEqual(lib.load(), library)
    assert.ok(!fs.existsSync(json))
    assert.ok(fs.existsSync(`${json}.migrated`))
    assert.equal(lib.migrateFromJson(json), false)
    lib.close()
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
