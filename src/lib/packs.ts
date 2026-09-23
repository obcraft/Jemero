// The pack format, as the renderer sees it. The rules (and the validator) live
// in electron/pack-format.cjs, where packs are read from disk and the network;
// keep the two in step.

export const PACK_FORMAT_VERSION = 1

export type PackCategory =
  | 'runtime'
  | 'styling'
  | 'primitives'
  | 'components'
  | 'icons'
  | 'charts'
  | 'animation'
  | 'utilities'
  | 'fonts'
  | 'data'

export type PackAsset = {
  /** Path inside the pack. */
  path: string
  type: 'text/css' | 'font/woff2' | 'font/woff' | 'image/svg+xml' | 'image/png' | 'application/json' | 'text/javascript'
}

type PackBase = {
  formatVersion: typeof PACK_FORMAT_VERSION
  /** Lowercase letters, digits and dashes: "radix-ui". */
  id: string
  /** Semver: "1.4.3". */
  version: string
  /** Display name: "Radix UI". */
  name: string
  /** One short sentence, what the generator reads when it chooses packs. */
  description?: string
  /** Part of the recommended selection in setup. */
  recommended?: boolean
  category: PackCategory
  /** Pack ids this one needs. A local pack never depends on a cloud service. */
  dependencies: string[]
}

/** Files on disk: installed once, then works with no network. */
export type LocalPack = PackBase & {
  kind: 'local'
  offline: true
  /** Bytes to download, and on disk once installed. */
  size: { download: number; installed: number }
  /** Import specifier → module file inside the pack: { "@radix-ui/react-dialog": "vendor/radix-dialog.js" }. */
  imports: Record<string, string>
  /** Import specifier → the names it exports. */
  exports: Record<string, string[]>
  /** CSS, fonts and other non-module files the canvas loads. */
  assets: PackAsset[]
  /** Every file in the pack → "sha256-<64 hex>". */
  files: Record<string, string>
}

/** An online API a component may call. Never installed, never offline. */
export type CloudService = PackBase & {
  kind: 'cloud'
  offline: false
  endpoint: string
}

export type CatalogEntry = LocalPack | CloudService

export type PackCatalog = {
  formatVersion: typeof PACK_FORMAT_VERSION
  packs: CatalogEntry[]
}

/** What a project records: the exact version of every pack it uses, dependencies included. */
export type PackLock = {
  formatVersion: typeof PACK_FORMAT_VERSION
  packs: Record<string, string>
}

export const isLocalPack = (p: CatalogEntry): p is LocalPack => p.kind === 'local'
export const isCloudService = (p: CatalogEntry): p is CloudService => p.kind === 'cloud'

// --- the store, through the Electron bridge (electron/pack-store.cjs) -------

/** id -> the active version, the one before it, and when it was activated. */
export type InstalledPacks = Record<string, { version: string; previous: string | null; activatedAt: string }>

export type PackList = {
  ok: boolean
  reason?: string
  packs: CatalogEntry[]
  installed: InstalledPacks
  /** The server couldn't be reached: this is the last index that verified. */
  fromCache: boolean
  /** Where packs are downloaded from; null when no source is configured. */
  source: string | null
}

export type PackProgress =
  | { id: string; phase: 'checking'; required: number; free: number }
  | { id: string; phase: 'downloading' | 'verifying' | 'activating'; pack: string; file?: string; received: number; total: number }
  | { id: string; phase: 'done' | 'cancelled' }
  | { id: string; phase: 'error'; message: string }

export type PackResult = { ok: boolean; reason?: string; cancelled?: boolean }

export type PackBridge = {
  list(): Promise<PackList>
  install(id: string): Promise<PackResult>
  cancel(id: string): Promise<{ ok: boolean }>
  remove(id: string): Promise<PackResult>
  rollback(id: string): Promise<PackResult & { version?: string }>
  onProgress(fn: (p: PackProgress) => void): () => void
  /** A pack was activated or removed. */
  onChanged(fn: () => void): () => void
}

// --- installed packs, as the local server publishes them (electron/pack-routes.cjs) ---

export type InstalledPack = {
  version: string
  name: string
  description: string
  category: PackCategory
  dependencies: string[]
  /** Specifier → file inside the pack. */
  imports: Record<string, string>
  exports: Record<string, string[]>
  assets: PackAsset[]
}

/** GET /packs/manifest.json: every active, verified pack. */
export type InstalledManifest = {
  formatVersion: typeof PACK_FORMAT_VERSION
  packs: Record<string, InstalledPack>
  /** Specifier → URL on the local server, for the canvas's import map. */
  imports: Record<string, string>
  /** Specifier → the stylesheets its pack needs. */
  styles: Record<string, string[]>
  /** Packs that failed verification and aren't served. */
  problems: Record<string, string[]>
}

const EMPTY_INSTALLED: InstalledManifest = { formatVersion: PACK_FORMAT_VERSION, packs: {}, imports: {}, styles: {}, problems: {} }

let installedNow = EMPTY_INSTALLED
const installedWatchers = new Set<() => void>()

/** Fetch the installed-pack manifest again. Empty in the browser build (no /packs route). */
export async function loadInstalledPacks(): Promise<InstalledManifest> {
  try {
    const res = await fetch('/packs/manifest.json', { cache: 'no-store' })
    const next = res.ok ? ((await res.json()) as InstalledManifest) : EMPTY_INSTALLED
    installedNow = next.formatVersion === PACK_FORMAT_VERSION ? next : EMPTY_INSTALLED
  } catch {
    installedNow = EMPTY_INSTALLED
  }
  for (const fn of installedWatchers) fn()
  return installedNow
}

export const installedPacks = () => installedNow

export function watchInstalledPacks(fn: () => void) {
  installedWatchers.add(fn)
  return () => {
    installedWatchers.delete(fn)
  }
}

/** The pack that provides an import specifier, among the installed ones. */
export function packOfSpecifier(installed: InstalledManifest, spec: string): string | null {
  for (const [id, p] of Object.entries(installed.packs)) if (spec in p.imports) return id
  return null
}

/** Every bare specifier a set of files imports. */
export function importedSpecifiers(files: Record<string, string>): string[] {
  const out = new Set<string>()
  const re = /(?:\bfrom\s*|\bimport\s*\(?\s*)["']([^"'./][^"']*)["']/g
  for (const code of Object.values(files)) for (const m of code.matchAll(re)) out.add(m[1])
  return [...out]
}

/** The exact installed versions a version's code uses, dependencies included. */
export function lockForFiles(files: Record<string, string>, installed: InstalledManifest): PackLock {
  const packs: Record<string, string> = {}
  const add = (id: string) => {
    const p = installed.packs[id]
    if (!p || packs[id]) return
    packs[id] = p.version
    p.dependencies.forEach(add)
  }
  for (const spec of importedSpecifiers(files)) {
    const id = packOfSpecifier(installed, spec)
    if (id) add(id)
  }
  return { formatVersion: PACK_FORMAT_VERSION, packs }
}

/** Changes whenever the set of active packs does: the canvas reloads on it. */
export const installedKey = (installed: InstalledManifest) =>
  Object.entries(installed.packs)
    .map(([id, p]) => `${id}@${p.version}`)
    .sort()
    .join(',')
