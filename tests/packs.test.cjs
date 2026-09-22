const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const {
  validatePack,
  validateCatalog,
  lockFor,
  closure,
  packsForImports,
  missingFromLock,
  verifyPackDir,
  sha256,
} = require('../electron/pack-format.cjs')

const H = (s) => sha256(Buffer.from(s))

const local = (id, extra = {}) => ({
  formatVersion: 1,
  id,
  version: '1.0.0',
  name: id,
  category: 'utilities',
  kind: 'local',
  offline: true,
  size: { download: 100, installed: 200 },
  dependencies: [],
  imports: { [id]: `vendor/${id}.js` },
  exports: { [id]: ['default'] },
  assets: [],
  files: { [`vendor/${id}.js`]: H(id) },
  ...extra,
})

const cloud = (id, extra = {}) => ({
  formatVersion: 1,
  id,
  version: '2025.1.0',
  name: id,
  category: 'data',
  kind: 'cloud',
  offline: false,
  endpoint: 'https://api.example.com',
  dependencies: [],
  ...extra,
})

const catalog = (...packs) => ({ formatVersion: 1, packs })

test('a well-formed local pack and cloud service validate', () => {
  assert.deepEqual(validatePack(local('react')), [])
  assert.deepEqual(validatePack(cloud('maps')), [])
  const withAssets = local('tailwind', {
    category: 'styling',
    imports: {},
    exports: {},
    assets: [{ path: 'theme.css', type: 'text/css' }],
    files: { 'theme.css': H('css') },
  })
  assert.deepEqual(validatePack(withAssets), [])
})

test('every required field is checked', () => {
  const bad = { ...local('x'), id: 'Bad Id', version: '1.0', name: '', category: 'misc', size: { download: -1 } }
  const errors = validatePack(bad).join('\n')
  for (const word of ['id must', 'semver', 'name is required', 'category must', 'size needs']) assert.match(errors, new RegExp(word))
})

test('local and cloud entries cannot be confused', () => {
  assert.match(validatePack(local('a', { offline: false })).join(), /works offline/)
  assert.match(validatePack(local('a', { endpoint: 'https://x' })).join(), /no endpoint/)
  assert.match(validatePack(cloud('b', { offline: true })).join(), /never offline/)
  assert.match(validatePack(cloud('b', { imports: {} })).join(), /nothing of it is installed/)
  assert.match(validatePack(cloud('b', { endpoint: 'http://insecure' })).join(), /https endpoint/)
})

test('imports, exports, assets and hashes must agree', () => {
  assert.match(validatePack(local('a', { files: {} })).join(), /has no hash/)
  assert.match(validatePack(local('a', { exports: {} })).join(), /no exports entry/)
  assert.match(validatePack(local('a', { imports: { a: '../escape.js' } })).join(), /outside the pack/)
  assert.match(validatePack(local('a', { imports: { a: 'https://cdn.x/a.js' } })).join(), /outside the pack/)
  assert.match(validatePack(local('a', { files: { 'vendor/a.js': 'md5-abc' } })).join(), /sha256/)
  assert.match(validatePack(local('a', { assets: [{ path: 'x.css', type: 'text/css' }] })).join(), /asset x.css has no hash/)
})

test('the catalog rejects unknown, cloud-backed and cyclic dependencies, and shared specifiers', () => {
  assert.deepEqual(validateCatalog(catalog(local('react'), local('radix', { dependencies: ['react'] }))), [])
  assert.match(validateCatalog(catalog(local('a', { dependencies: ['ghost'] }))).join(), /unknown pack ghost/)
  assert.match(validateCatalog(catalog(cloud('maps'), local('a', { dependencies: ['maps'] }))).join(), /cannot depend on the cloud service/)
  assert.match(
    validateCatalog(catalog(local('a', { dependencies: ['b'] }), local('b', { dependencies: ['a'] }))).join(),
    /dependency cycle/,
  )
  const twin = local('b', { imports: { a: 'vendor/b.js' }, exports: { a: [] }, files: { 'vendor/b.js': H('b') } })
  assert.match(validateCatalog(catalog(local('a'), twin)).join(), /already provided by a/)
  assert.match(validateCatalog(catalog(local('a'), local('a'))).join(), /listed twice/)
})

test('a project lock pins exact versions, dependencies included, and refuses cloud services', () => {
  const cat = catalog(local('react', { version: '19.3.0' }), local('radix', { version: '1.4.3', dependencies: ['react'] }), cloud('maps'))
  assert.deepEqual(closure(cat, ['radix']).map((p) => p.id), ['react', 'radix'])
  assert.deepEqual(lockFor(cat, ['radix']), { formatVersion: 1, packs: { react: '19.3.0', radix: '1.4.3' } })
  assert.throws(() => lockFor(cat, ['maps']), /online service/)
  assert.deepEqual(packsForImports(cat, ['radix', 'react', 'left-pad']).sort(), ['radix', 'react'])
  assert.deepEqual(missingFromLock({ formatVersion: 1, packs: { react: '19.3.0', radix: '1.4.3' } }, { react: '19.3.0', radix: '1.4.0' }), [
    { id: 'radix', version: '1.4.3', installed: '1.4.0' },
  ])
})

test('an installed pack is checked file by file against its hashes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jemero-pack-'))
  try {
    const pack = local('react')
    assert.deepEqual(verifyPackDir(dir, pack), ['react: missing vendor/react.js'])
    fs.mkdirSync(path.join(dir, 'vendor'))
    fs.writeFileSync(path.join(dir, 'vendor', 'react.js'), 'tampered')
    assert.deepEqual(verifyPackDir(dir, pack), ['react: vendor/react.js does not match its hash'])
    fs.writeFileSync(path.join(dir, 'vendor', 'react.js'), 'react')
    assert.deepEqual(verifyPackDir(dir, pack), [])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
