// The component library: everything built so far, every version of it, and
// the conversation that shaped it. One small store read through
// useSyncExternalStore, like settings.ts.
//
// In the Mac app it lives in SQLite, owned by the main process
// (electron/library-db.cjs, jemero.db), because the page's origin, and with it
// localStorage, changes on every launch. Files a generation is still writing
// are saved there too, as drafts. The browser build keeps it in localStorage.
import { useSyncExternalStore } from 'react'
import type { KitId } from './kits'
import type { PackLock } from './packs'

/** How big the thing is, which changes the canvas layout and the model's brief. */
export type Kind = 'component' | 'block' | 'section'

/** What produced a turn or a version. */
export type Mode = 'build' | 'refine' | 'review' | 'repair' | 'port' | 'edit'

export type Version = {
  files: Record<string, string>
  /** The file the canvas renders. */
  entry: string
  kit: KitId
  /**
   * The exact pack versions this version's code was rendered with, so it can
   * be reopened against them (or report what's missing). Absent on versions
   * saved before packs existed.
   */
  packs?: PackLock
  /** The model's plan for this version, as it wrote it. */
  plan: string
  /** The request that produced it. */
  prompt: string
  mode: Mode
  createdAt: number
}

export type Turn = {
  id: string
  role: 'user' | 'assistant'
  mode: Mode
  text: string
  plan?: string
  /** Review findings, when mode is 'review'. */
  review?: string[]
  /** 1-based version this turn produced. */
  version?: number
  error?: string
  at: number
}

export type Item = {
  id: string
  name: string
  kind: Kind
  versions: Version[]
  turns: Turn[]
  createdAt: number
  updatedAt: number
}

type Library = { version: 1; items: Item[] }

const KEY = 'jemero.library.v1'
const EMPTY: Library = { version: 1, items: [] }

export const newId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4)

function load(): Library {
  try {
    const raw = (window.jemero?.library?.load() as Library | null | undefined) ?? JSON.parse(localStorage.getItem(KEY) || 'null')
    if (raw && Array.isArray(raw.items)) return { version: 1, items: raw.items }
  } catch {
    /* unreadable: start empty rather than not at all */
  }
  return EMPTY
}

let current = load()
const listeners = new Set<() => void>()
let saveTimer: ReturnType<typeof setTimeout> | undefined
/** Items changed since the last write. Removals travel as the id order. */
const dirty = new Set<string>()

function writeNow() {
  saveTimer = undefined
  const db = window.jemero?.library
  if (!db) {
    try {
      localStorage.setItem(KEY, JSON.stringify(current))
    } catch {
      /* private window or quota: keep running on what's in memory */
    }
    return
  }
  // Only what changed goes to the database: the whole library is megabytes
  // once it has a history, far too much to copy and rewrite on every edit.
  const changed = new Set(dirty)
  dirty.clear()
  db.save({ order: current.items.map((i) => i.id), items: current.items.filter((i) => changed.has(i.id)) }).catch(() => {
    // Not written (disk full, say): it goes again with the next change.
    for (const id of changed) dirty.add(id)
  })
}

/** Edits arrive per keystroke in the code tab; writing once they settle is plenty. */
function persist() {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(writeNow, 150)
}

// Don't lose the last edit to the debounce when the window closes.
window.addEventListener('beforeunload', () => {
  flushDraft()
  if (saveTimer === undefined) return
  clearTimeout(saveTimer)
  writeNow()
})

// --- drafts: a generation's files, saved as the model writes them ----------

type DraftFile = { path: string; content: string; complete: boolean }
let draftTimer: ReturnType<typeof setTimeout> | undefined
let draftPending: { itemId: string; files: DraftFile[] } | null = null

function flushDraft() {
  clearTimeout(draftTimer)
  draftTimer = undefined
  if (draftPending) window.jemero?.library?.draft(draftPending.itemId, draftPending.files)
  draftPending = null
}

/** Save the files being written now; at most a few writes a second. */
export function saveDraft(itemId: string, files: DraftFile[]) {
  draftPending = { itemId, files: files.map((f) => ({ path: f.path, content: f.content, complete: f.complete })) }
  draftTimer ??= setTimeout(flushDraft, 300)
}

/** The version is saved: the draft has done its job. */
export function clearDraft(itemId: string) {
  clearTimeout(draftTimer)
  draftTimer = undefined
  draftPending = null
  window.jemero?.library?.clearDraft(itemId)
}

/**
 * Drafts left by a crash or a quit mid-generation come back as a version, so
 * no written code is lost. Only finished files are kept as the version; a
 * file cut off mid-way would just fail to compile.
 */
export async function recoverDrafts(): Promise<number> {
  const drafts = (await window.jemero?.library?.drafts()) ?? {}
  let recovered = 0
  for (const [itemId, files] of Object.entries(drafts)) {
    const item = current.items.find((i) => i.id === itemId)
    const done = files.filter((f) => f.complete)
    const newest = Math.max(...files.map((f) => f.updatedAt))
    const last = item?.versions.at(-1)
    if (item && done.length && (!last || last.createdAt < newest)) {
      const base = last?.files ?? {}
      const merged = { ...base, ...Object.fromEntries(done.map((f) => [f.path, f.content])) }
      const entry = done.find((f) => /\bexport\s+default\b/.test(f.content))?.path ?? last?.entry ?? done[0].path
      const n = addVersion(itemId, {
        files: merged,
        entry,
        kit: last?.kit ?? 'shadcn',
        packs: last?.packs,
        plan: '',
        prompt: 'Recovered after Jemero closed mid-generation',
        mode: 'edit',
        createdAt: Date.now(),
      })
      addTurn(itemId, { role: 'assistant', mode: 'edit', text: 'Recovered the code written before Jemero closed.', version: n })
      recovered++
    }
    window.jemero?.library?.clearDraft(itemId)
  }
  return recovered
}

/** `changed` is the item whose content changed, if any; order changes are always saved. */
function commit(next: Library, changed?: string) {
  current = next
  if (changed) dirty.add(changed)
  persist()
  for (const fn of listeners) fn()
}

export const getLibrary = () => current

function subscribe(fn: () => void) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function useLibrary(): Library {
  return useSyncExternalStore(subscribe, getLibrary, () => EMPTY)
}

export const findItem = (id: string | null) => (id ? (current.items.find((i) => i.id === id) ?? null) : null)

export function createItem(kind: Kind, name: string): Item {
  const now = Date.now()
  const item: Item = { id: newId(), name, kind, versions: [], turns: [], createdAt: now, updatedAt: now }
  commit({ ...current, items: [item, ...current.items] }, item.id)
  return item
}

export function updateItem(id: string, fn: (item: Item) => Item) {
  commit(
    {
      ...current,
      items: current.items.map((i) => (i.id === id ? { ...fn(i), updatedAt: Date.now() } : i)),
    },
    id,
  )
}

export function deleteItem(id: string) {
  commit({ ...current, items: current.items.filter((i) => i.id !== id) })
}

export function addTurn(id: string, turn: Omit<Turn, 'id' | 'at'>): Turn {
  const full: Turn = { ...turn, id: newId(), at: Date.now() }
  updateItem(id, (item) => ({ ...item, turns: [...item.turns, full] }))
  return full
}

/** Appends a version and returns its 1-based number. */
export function addVersion(id: string, version: Version): number {
  let n = 0
  updateItem(id, (item) => {
    n = item.versions.length + 1
    return { ...item, versions: [...item.versions, version] }
  })
  return n
}

/** "SearchableDropdown.jsx" -> "Searchable Dropdown". */
export function displayName(entry: string): string {
  const base = entry.split('/').pop()?.replace(/\.[^.]+$/, '') ?? entry
  return base
    .replace(/[-_]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim()
}

/** A name to show while the model hasn't written a file yet: the first few words of the request. */
export function provisionalName(prompt: string): string {
  const words = prompt.replace(/[^\p{L}\p{N}\s-]/gu, ' ').split(/\s+/).filter(Boolean).slice(0, 4)
  const text = words.join(' ')
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : 'Untitled'
}
