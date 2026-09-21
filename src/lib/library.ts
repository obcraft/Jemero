// The component library: everything built so far, every version of it, and
// the conversation that shaped it. One small store read through
// useSyncExternalStore, like settings.ts.
//
// In the Mac app it lives in a file the main process owns (library.json next to
// settings.json), because the page's origin, and with it localStorage, changes
// on every launch. The browser build keeps it in localStorage.
import { useSyncExternalStore } from 'react'
import type { KitId } from './kits'

/** How big the thing is, which changes the canvas layout and the model's brief. */
export type Kind = 'component' | 'block' | 'section'

/** What produced a turn or a version. */
export type Mode = 'build' | 'refine' | 'review' | 'repair' | 'port' | 'edit'

export type Version = {
  files: Record<string, string>
  /** The file the canvas renders. */
  entry: string
  kit: KitId
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

function writeNow() {
  saveTimer = undefined
  window.jemero?.library?.save(current)
  try {
    localStorage.setItem(KEY, JSON.stringify(current))
  } catch {
    /* private window or quota: the file copy still has it */
  }
}

/** Edits arrive per keystroke in the code tab; writing once they settle is plenty. */
function persist() {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(writeNow, 400)
}

// Don't lose the last edit to the debounce when the window closes.
window.addEventListener('beforeunload', () => {
  if (saveTimer === undefined) return
  clearTimeout(saveTimer)
  writeNow()
})

function commit(next: Library) {
  current = next
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
  commit({ ...current, items: [item, ...current.items] })
  return item
}

export function updateItem(id: string, fn: (item: Item) => Item) {
  commit({
    ...current,
    items: current.items.map((i) => (i.id === id ? { ...fn(i), updatedAt: Date.now() } : i)),
  })
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
