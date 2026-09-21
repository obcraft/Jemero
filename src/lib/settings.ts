// User settings: one small store, persisted to localStorage, read through
// useSyncExternalStore so every consumer re-renders on change without a context
// provider wrapping the tree.
//
// Anything in here has to *do* something — the panel is not a preferences
// museum. Each field notes where it takes effect.
import { useSyncExternalStore } from 'react'
import { SYSTEM_PROMPT } from './systemPrompt'
import type { Priority } from './models'

export type Theme = 'system' | 'dark' | 'light'
export type AnswerLength = 'brief' | 'standard' | 'long'
export type Memory = 'short' | 'normal' | 'long'

export type Settings = {
  /** Applied to <html data-theme>, which drives the CSS variables. */
  theme: Theme
  /** Turns off transitions for people who don't want them (or want the speed). */
  animations: boolean
  /** max_tokens on every completion. */
  answerLength: AnswerLength
  /** Sampling. Low temperature is what keeps the file format intact. */
  temperature: number
  topP: number
  /** How much history `trimHistory` keeps before dropping older turns. */
  memory: Memory
  /** Empty means "use the built-in prompt". */
  systemPrompt: string
  /**
   * Let hybrid models (Qwen3, gpt-oss) reason before answering. Off is much
   * faster: no hidden tokens to wait through before the first file appears.
   */
  thinking: boolean
  /** Show the model's reasoning while it streams, when there is any. */
  showReasoning: boolean
  /** Code tab: file list open or collapsed. */
  fileTreeOpen: boolean
  /** Add design-system imports the model forgot (src/lib/imports.ts). */
  autoFixImports: boolean
  /** Install packages the generated code imports but never declared. */
  autoInstallDeps: boolean
  /** Follow the pipeline: code while writing, terminal on install, preview when ready. */
  autoSwitchTabs: boolean
  /** What the model recommendation optimises for. */
  modelPriority: Priority
}

export const DEFAULTS: Settings = {
  theme: 'system',
  animations: true,
  answerLength: 'standard',
  temperature: 0.2,
  topP: 0.95,
  memory: 'normal',
  systemPrompt: '',
  thinking: false,
  showReasoning: true,
  fileTreeOpen: true,
  autoFixImports: true,
  autoInstallDeps: true,
  autoSwitchTabs: true,
  modelPriority: 'balanced',
}

/**
 * The served context is 16k and the prompt has to fit in it alongside the
 * answer, so these are the honest ceilings rather than round marketing numbers.
 */
export const ANSWER_TOKENS: Record<AnswerLength, number> = {
  brief: 1536,
  standard: 4096,
  long: 6144,
}

export const ANSWER_HINT: Record<AnswerLength, string> = {
  brief: 'One file, one screen. Fastest.',
  standard: 'Up to ~4 files. The default.',
  long: 'Room for a bigger app — uses most of a 16k window.',
}

/** Characters of history kept; ~3.5 chars per token against a 16k window. */
export const MEMORY_CHARS: Record<Memory, number> = {
  short: 18_000,
  normal: 36_000,
  long: 48_000,
}

export const MEMORY_HINT: Record<Memory, string> = {
  short: 'Forgets fast, always has room to answer.',
  normal: 'A few follow-ups. Matches the 16k window.',
  long: 'More context, tighter fit — leave answers on Brief or Standard.',
}

const KEY = 'atomic.settings.v1'

function load(): Settings {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return DEFAULTS
    const parsed = JSON.parse(raw) as Partial<Settings>
    // Merge over defaults so a new field in a later version doesn't read undefined.
    return { ...DEFAULTS, ...parsed }
  } catch {
    return DEFAULTS
  }
}

let current = load()
const listeners = new Set<() => void>()

function emit() {
  for (const fn of listeners) fn()
}

export function setSettings(patch: Partial<Settings>) {
  current = { ...current, ...patch }
  try {
    localStorage.setItem(KEY, JSON.stringify(current))
  } catch {
    /* private window, or storage full — keep the in-memory value */
  }
  emit()
}

export function resetSettings() {
  current = DEFAULTS
  try {
    localStorage.removeItem(KEY)
  } catch {
    /* ignore */
  }
  emit()
}

export const getSettings = () => current

function subscribe(fn: () => void) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function useSettings(): Settings {
  return useSyncExternalStore(subscribe, getSettings, () => DEFAULTS)
}

/** The prompt actually sent: the user's override, or the built-in one. */
export const effectivePrompt = (s: Settings = current) => s.systemPrompt.trim() || SYSTEM_PROMPT

export const maxTokensFor = (s: Settings = current) => ANSWER_TOKENS[s.answerLength]
export const memoryCharsFor = (s: Settings = current) => MEMORY_CHARS[s.memory]

/**
 * Resolve `theme` against the OS and write it to <html>, plus a motion flag the
 * stylesheet reads. Called once at boot and on every change; returns a cleanup
 * for the OS listener so 'system' keeps tracking.
 */
export function applyAppearance(settings: Settings = current): () => void {
  const media = window.matchMedia('(prefers-color-scheme: light)')
  const paint = () => {
    const resolved = settings.theme === 'system' ? (media.matches ? 'light' : 'dark') : settings.theme
    document.documentElement.dataset.theme = resolved
    document.documentElement.dataset.motion = settings.animations ? 'on' : 'off'
  }
  paint()
  if (settings.theme !== 'system') return () => {}
  media.addEventListener('change', paint)
  return () => media.removeEventListener('change', paint)
}
