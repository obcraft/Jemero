// The pack format: what the canvas can import, as installable units.
//
// A *local pack* is files on disk: ES modules the canvas imports by specifier,
// plus assets (CSS, fonts) it loads. Once installed it works with no network.
// A *cloud service* is only a catalog entry: an online API a component could
// call. It is never installed and never works offline, so it lives in the
// catalog under its own kind and the offline checks can refuse it by type.
//
// A project records the exact pack versions it was built with (a lock), so a
// component reopened months later renders against what it was written for, or
// says precisely which pack is missing.
//
// Validation lives here, in the main process, because that is where packs are
// read from disk and from the network. src/lib/packs.ts mirrors the types.
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const FORMAT_VERSION = 1

const CATEGORIES = ['runtime', 'styling', 'primitives', 'components', 'icons', 'charts', 'animation', 'utilities', 'fonts', 'data']
const KINDS = ['local', 'cloud']

const ID = /^[a-z0-9][a-z0-9-]{0,63}$/
// Semver 2.0 without build metadata: 1.2.3, 1.2.3-rc.1
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/
const HASH = /^sha256-[0-9a-f]{64}$/
// A bare or scoped npm-style specifier, with an optional subpath: react, react-dom/client, @radix-ui/react-dialog
const SPECIFIER = /^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*(\/[\w.-]+)*$/i
const ASSET_TYPES = ['text/css', 'font/woff2', 'font/woff', 'image/svg+xml', 'image/png', 'application/json', 'text/javascript']

/** A path inside the pack: relative, forward slashes, no escaping it, no URLs. */
function isPackPath(p) {
  if (typeof p !== 'string' || !p || p.length > 256) return false
  if (p.startsWith('/') || p.includes('\\') || /^[a-z][a-z0-9+.-]*:/i.test(p)) return false
  return p.split('/').every((seg) => seg && seg !== '.' && seg !== '..')
}

const isInt = (n) => Number.isSafeInteger(n) && n >= 0

/**
 * Check one catalog entry. Returns a list of problems, empty when valid, so a
 * catalog can report every bad entry at once instead of the first.
 */
function validatePack(p) {
  const errors = []
  const where = typeof p?.id === 'string' ? p.id : '(no id)'
  const err = (msg) => errors.push(`${where}: ${msg}`)
  if (!p || typeof p !== 'object' || Array.isArray(p)) return ['pack: not an object']

  if (p.formatVersion !== FORMAT_VERSION) err(`formatVersion must be ${FORMAT_VERSION}`)
  if (!ID.test(p.id ?? '')) err('id must be lowercase letters, digits and dashes')
  if (!SEMVER.test(p.version ?? '')) err('version must be semver, e.g. 1.4.2')
  if (typeof p.name !== 'string' || !p.name.trim()) err('name is required')
  // What the generator reads when it picks packs: one short sentence.
  if (p.description !== undefined && (typeof p.description !== 'string' || p.description.length > 200)) {
    err('description must be a sentence of at most 200 characters')
  }
  if (p.recommended !== undefined && typeof p.recommended !== 'boolean') err('recommended must be true or false')
  if (!CATEGORIES.includes(p.category)) err(`category must be one of ${CATEGORIES.join(', ')}`)
  if (!KINDS.includes(p.kind)) err(`kind must be one of ${KINDS.join(', ')}`)
  if (!Array.isArray(p.dependencies) || !p.dependencies.every((d) => ID.test(d))) err('dependencies must be a list of pack ids')
  else if (p.dependencies.includes(p.id)) err('a pack cannot depend on itself')
  else if (new Set(p.dependencies).size !== p.dependencies.length) err('dependencies has duplicates')

  if (p.kind === 'cloud') {
    if (p.offline !== false) err('a cloud service is never offline-capable (offline: false)')
    if (typeof p.endpoint !== 'string' || !/^https:\/\//.test(p.endpoint)) err('a cloud service needs an https endpoint')
    for (const field of ['imports', 'exports', 'assets', 'files']) {
      if (p[field] !== undefined) err(`a cloud service has no ${field}: nothing of it is installed`)
    }
    if (p.size !== undefined) err('a cloud service has no download size')
    return errors
  }

  if (p.kind !== 'local') return errors

  if (p.offline !== true) err('a local pack works offline once installed (offline: true)')
  if (p.endpoint !== undefined) err('a local pack has no endpoint')
  if (!p.size || !isInt(p.size.download) || !isInt(p.size.installed)) err('size needs whole-byte download and installed counts')

  const imports = p.imports && typeof p.imports === 'object' && !Array.isArray(p.imports) ? p.imports : null
  const exports = p.exports && typeof p.exports === 'object' && !Array.isArray(p.exports) ? p.exports : null
  const files = p.files && typeof p.files === 'object' && !Array.isArray(p.files) ? p.files : null
  if (!imports) err('imports must map specifiers to files in the pack')
  if (!exports) err('exports must list the symbols of each specifier')
  if (!Array.isArray(p.assets)) err('assets must be a list (empty when there are none)')
  if (!files) err('files must map every file in the pack to its sha256 hash')
  if (!imports || !exports || !files || !Array.isArray(p.assets)) return errors

  if (!Object.keys(imports).length && !p.assets.length) err('a local pack must provide at least one import or asset')

  for (const [spec, file] of Object.entries(imports)) {
    if (!SPECIFIER.test(spec)) err(`import "${spec}" is not a package specifier`)
    if (!isPackPath(file)) err(`import "${spec}" points outside the pack: ${file}`)
    else if (!(file in files)) err(`import "${spec}" file ${file} has no hash in files`)
    if (!Array.isArray(exports[spec])) err(`import "${spec}" has no exports entry`)
  }
  for (const [spec, names] of Object.entries(exports)) {
    if (!(spec in imports)) err(`exports lists "${spec}", which is not imported`)
    else if (!Array.isArray(names) || !names.every((n) => typeof n === 'string' && /^[A-Za-z_$][\w$]*$/.test(n))) {
      err(`exports of "${spec}" must be identifiers`)
    }
  }
  for (const a of p.assets) {
    if (!a || !isPackPath(a.path)) err(`asset path is not inside the pack: ${a?.path}`)
    else if (!(a.path in files)) err(`asset ${a.path} has no hash in files`)
    if (!ASSET_TYPES.includes(a?.type)) err(`asset ${a?.path} type must be one of ${ASSET_TYPES.join(', ')}`)
  }
  for (const [file, hash] of Object.entries(files)) {
    if (!isPackPath(file)) err(`file is not inside the pack: ${file}`)
    if (!HASH.test(hash)) err(`file ${file} hash must be sha256-<64 hex>`)
  }
  return errors
}

/**
 * Check a whole catalog: every entry, unique ids, dependencies that exist and
 * don't loop, no specifier claimed by two packs, and local packs that don't
 * depend on cloud services (they would stop working offline).
 */
function validateCatalog(catalog) {
  if (!catalog || catalog.formatVersion !== FORMAT_VERSION || !Array.isArray(catalog.packs)) {
    return [`catalog: needs formatVersion ${FORMAT_VERSION} and a packs list`]
  }
  const errors = catalog.packs.flatMap(validatePack)
  const byId = new Map()
  for (const p of catalog.packs) {
    if (byId.has(p.id)) errors.push(`${p.id}: listed twice`)
    byId.set(p.id, p)
  }
  const owner = new Map()
  for (const p of catalog.packs) {
    for (const d of p.dependencies ?? []) {
      const dep = byId.get(d)
      if (!dep) errors.push(`${p.id}: depends on unknown pack ${d}`)
      else if (p.kind === 'local' && dep.kind === 'cloud') errors.push(`${p.id}: a local pack cannot depend on the cloud service ${d}`)
    }
    for (const spec of Object.keys(p.imports ?? {})) {
      if (owner.has(spec)) errors.push(`${p.id}: "${spec}" is already provided by ${owner.get(spec)}`)
      else owner.set(spec, p.id)
    }
  }
  for (const cycle of findCycles(byId)) errors.push(`dependency cycle: ${cycle.join(' → ')}`)
  return errors
}

function findCycles(byId) {
  const cycles = []
  const state = new Map() // id -> 'visiting' | 'done'
  const visit = (id, trail) => {
    if (state.get(id) === 'done' || !byId.has(id)) return
    if (state.get(id) === 'visiting') {
      cycles.push([...trail.slice(trail.indexOf(id)), id])
      return
    }
    state.set(id, 'visiting')
    for (const d of byId.get(id).dependencies ?? []) visit(d, [...trail, id])
    state.set(id, 'done')
  }
  for (const id of byId.keys()) visit(id, [])
  return cycles
}

/** A pack and everything it depends on, dependencies first. */
function closure(catalog, ids) {
  const byId = new Map(catalog.packs.map((p) => [p.id, p]))
  const out = []
  const seen = new Set()
  const add = (id) => {
    if (seen.has(id)) return
    seen.add(id)
    const p = byId.get(id)
    if (!p) throw new Error(`Unknown pack: ${id}`)
    for (const d of p.dependencies) add(d)
    out.push(p)
  }
  for (const id of ids) add(id)
  return out
}

/**
 * The lock a project stores: exact versions of every pack its code needs,
 * dependencies included. Refuses cloud services, which a component may call
 * but can't be locked to (their version is whatever the server runs).
 */
function lockFor(catalog, ids) {
  const packs = {}
  for (const p of closure(catalog, ids)) {
    if (p.kind !== 'local') throw new Error(`${p.id} is an online service, not a pack; it can't be locked`)
    packs[p.id] = p.version
  }
  return { formatVersion: FORMAT_VERSION, packs }
}

/** Packs that serve these import specifiers (only the ones the catalog knows). */
function packsForImports(catalog, specifiers) {
  const ids = new Set()
  for (const spec of specifiers) {
    const p = catalog.packs.find((x) => x.kind === 'local' && spec in (x.imports ?? {}))
    if (p) ids.add(p.id)
  }
  return [...ids]
}

/**
 * What a lock needs that isn't installed at that exact version.
 * `installed` maps pack id -> installed version.
 */
function missingFromLock(lock, installed) {
  return Object.entries(lock?.packs ?? {})
    .filter(([id, version]) => installed[id] !== version)
    .map(([id, version]) => ({ id, version, installed: installed[id] ?? null }))
}

const sha256 = (buf) => `sha256-${crypto.createHash('sha256').update(buf).digest('hex')}`

/**
 * Compare a pack directory on disk with its manifest: every listed file must be
 * present with the right hash. Returns the problems, empty when intact.
 */
function verifyPackDir(dir, pack) {
  const problems = []
  for (const [file, hash] of Object.entries(pack.files ?? {})) {
    const full = path.join(dir, ...file.split('/'))
    let buf
    try {
      buf = fs.readFileSync(full)
    } catch {
      problems.push(`${pack.id}: missing ${file}`)
      continue
    }
    if (sha256(buf) !== hash) problems.push(`${pack.id}: ${file} does not match its hash`)
  }
  return problems
}

module.exports = {
  FORMAT_VERSION,
  CATEGORIES,
  KINDS,
  ASSET_TYPES,
  validatePack,
  validateCatalog,
  closure,
  lockFor,
  packsForImports,
  missingFromLock,
  verifyPackDir,
  sha256,
}
