// Renderer-side view of the model machinery in electron/.

/** How the recommendation trades speed against quality. See catalog.cjs. */
export type Priority = 'speed' | 'balanced' | 'quality'
//
// Everything here is a thin call over the preload bridge. In the browser build
// (`npm run web`) there is no bridge, so `available` is false and the UI says
// so rather than pretending it can install anything.

export type Device = {
  summary: string
  machine: string
  chip: string
  ramGB: number
  gpuCores: number
  bandwidthGBs: number
  budgetGB: number
  appleSilicon: boolean
}

export type ModelPlan = {
  modelId: string
  label: string
  tags: string[]
  quant: string
  repo: string
  file: string
  sizeGB: number
  kvGB: number
  totalGB: number
  needsGB: number
  ctx: number | null
  tokensPerSec: number
  params: number
  activeParams: number | null
  moe: boolean
  blurb: string
  formatRisk: string | null
  fits: boolean
  score: number
}

export type InstalledModel = {
  id: string
  bytes: number
  partialBytes: number
  complete: boolean
}

export type CatalogSnapshot = {
  device: Device
  models: ModelPlan[]
  recommended: string | null
  reasons: string[]
  installed: InstalledModel[]
  active: string | null
  modelsFolder: string
  priority: Priority
  runtime: { build: string; path: string | null; source: string }
  freeBytes: number | null
}

export type Progress = {
  id: string
  phase: 'downloading' | 'resuming' | 'verifying' | 'installing' | 'done' | 'cancelled' | 'error' | 'activating' | 'active'
  received?: number
  total?: number
  bytesPerSec?: number
  etaSeconds?: number | null
  message?: string
}

type Bridge = {
  settings: { load(): unknown; save(value: unknown): void }
  device(): Promise<Device>
  catalog(priority?: Priority): Promise<CatalogSnapshot>
  install(modelId: string): Promise<{ ok: boolean; reason?: string }>
  cancelInstall(modelId: string): Promise<{ ok: boolean }>
  remove(modelId: string): Promise<{ ok: boolean; reason?: string }>
  activate(modelId: string): Promise<{ ok: boolean; reason?: string }>
  onMenu(fn: (which: 'models' | 'settings') => void): () => void
  onProgress(fn: (p: Progress) => void): () => void
}

declare global {
  interface Window {
    jemero?: Bridge
  }
}

export const bridge = () => window.jemero ?? null
export const available = () => !!window.jemero

// --- shared snapshot ------------------------------------------------------
// Both the header's quick-switch and the full browser read the same catalog,
// and reading it means hitting the disk and probing the server. Cache it, let
// download/activation progress invalidate it, and hand the cached value to
// whatever opens next so panels appear populated rather than empty.

let cached: CatalogSnapshot | null = null
let inFlight: Promise<CatalogSnapshot | null> | null = null
let priority: Priority = 'balanced'

/** Changing priority re-ranks the catalog, so it invalidates the cache. */
export function setPriority(next: Priority) {
  if (next === priority) return
  priority = next
  void loadSnapshot(true)
}
const watchers = new Set<() => void>()

function publish() {
  for (const fn of watchers) fn()
}

export function cachedSnapshot() {
  return cached
}

export async function loadSnapshot(force = false): Promise<CatalogSnapshot | null> {
  const api = bridge()
  if (!api) return null
  if (cached && !force) return cached
  if (!inFlight || force) {
    inFlight = api
      .catalog(priority)
      .then((snap) => {
        cached = snap
        publish()
        return snap
      })
      .finally(() => {
        inFlight = null
      })
  }
  return inFlight
}

/** Subscribe to snapshot changes; returns an unsubscribe. */
export function watchSnapshot(fn: () => void) {
  watchers.add(fn)
  return () => watchers.delete(fn)
}

/**
 * Keep the cache honest for the whole session: any download that finishes, any
 * activation, any cancel changes what's on disk or what's serving.
 */
export function startSnapshotSync() {
  const api = bridge()
  if (!api) return () => {}
  return api.onProgress((p) => {
    if (p.phase === 'done' || p.phase === 'active' || p.phase === 'cancelled' || p.phase === 'error') {
      void loadSnapshot(true)
    }
  })
}

/** One decimal below 100 GB, so "16.5 GB budget" and "16.5 GB" never disagree. */
export function formatGB(gb: number) {
  return `${gb < 100 ? gb.toFixed(1).replace(/\.0$/, '') : Math.round(gb)} GB`
}

export function formatBytes(bytes: number) {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`
}

export function formatRate(bytesPerSec = 0) {
  const mb = bytesPerSec / 1024 ** 2
  return mb >= 1 ? `${mb.toFixed(1)} MB/s` : `${(bytesPerSec / 1024).toFixed(0)} KB/s`
}

export function formatEta(seconds?: number | null) {
  if (seconds == null || !Number.isFinite(seconds)) return ''
  if (seconds < 60) return `${Math.round(seconds)}s left`
  const m = Math.floor(seconds / 60)
  if (m < 60) return `${m}m ${Math.round(seconds % 60)}s left`
  return `${Math.floor(m / 60)}h ${m % 60}m left`
}

/** "bartowski/Qwen2.5-Coder-14B-Instruct-Q4_K_M" → "Qwen2.5-Coder-14B · Q4_K_M" */
export function modelLabel(id: string): string {
  if (!id) return ''
  const name = id.split('/').pop() ?? id
  const m = name.match(/^(.*?)-(Instruct-)?((?:UD-)?[A-Z]+\d?(?:_[A-Z0-9]+)*)$/)
  return m ? `${m[1]} · ${m[3]}` : name
}

/** "3.3B of 30B active" reads better than "MoE" for anyone who hasn't met one. */
export function sizeLine(m: ModelPlan) {
  const params = m.moe && m.activeParams ? `${m.params}B · ${m.activeParams}B active` : `${m.params}B`
  return `${params} · ${m.quant} · ${formatGB(m.sizeGB)}`
}
