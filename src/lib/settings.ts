// User settings: one small store, persisted to localStorage, read through
// useSyncExternalStore so every consumer re-renders on change without a context
// provider wrapping the tree.
//
// Anything in here has to *do* something, the panel is not a preferences
// museum. Each field notes where it takes effect.
import { useSyncExternalStore } from 'react'
import { SYSTEM_PROMPT } from './systemPrompt'
import { isKitId, type KitId } from './kits'
import type { Priority } from './models'

export type Theme = 'system' | 'dark' | 'light'
export type AnswerLength = 'brief' | 'standard' | 'long'
export type CanvasTheme = 'app' | 'light' | 'dark'
export type CanvasBg = 'dots' | 'grid' | 'plain'
export type CanvasWidth = 'fit' | '375' | '768' | '1280'

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
  /** Empty means "use the built-in prompt". */
  systemPrompt: string
  /**
   * Let hybrid models (Qwen3, gpt-oss) reason before answering. Off is much
   * faster: no hidden tokens to wait through before the first file appears.
   */
  thinking: boolean
  /** Show the model's reasoning while it streams, when there is any. */
  showReasoning: boolean
  /** Ask for a short <plan> (anatomy, states, props, behaviour) before the code. */
  planFirst: boolean
  /** Code tab: file list open or collapsed. */
  fileTreeOpen: boolean
  /** Repair imports before rendering (compile.ts): missing ones, wrong icons, deep paths. */
  autoFixImports: boolean
  /** Show the code while it's written, then the canvas when it's ready. */
  autoSwitchTabs: boolean
  /** What the model recommendation optimises for. */
  modelPriority: Priority
  /** Prefer 4-bit model files: lighter, faster, a little less precise (electron/catalog.cjs). */
  quantize: boolean
  /** Ask about quantization when the app starts, until "Don't show again". */
  quantizePrompt: boolean
  /** The kit new components are built with. */
  kit: KitId
  /** Canvas: light or dark, or follow the app. */
  canvasTheme: CanvasTheme
  canvasBg: CanvasBg
  canvasWidth: CanvasWidth
}

export const DEFAULTS: Settings = {
  theme: 'system',
  animations: true,
  answerLength: 'standard',
  temperature: 0.2,
  topP: 0.95,
  systemPrompt: '',
  thinking: false,
  showReasoning: true,
  planFirst: true,
  fileTreeOpen: true,
  autoFixImports: true,
  autoSwitchTabs: false,
  modelPriority: 'balanced',
  quantize: false,
  quantizePrompt: true,
  kit: 'shadcn',
  canvasTheme: 'app',
  canvasBg: 'dots',
  canvasWidth: 'fit',
}

/**
 * The served context is 16k and the prompt (with the current code, on a
 * refinement) has to fit in it alongside the answer, so these are the honest
 * ceilings rather than round marketing numbers.
 */
export const ANSWER_TOKENS: Record<AnswerLength, number> = {
  brief: 2048,
  standard: 4096,
  long: 6144,
}

export const ANSWER_HINT: Record<AnswerLength, string> = {
  brief: 'Small components. Fastest.',
  standard: 'Most components and blocks. The default.',
  long: 'Sections and big blocks. Uses most of a 16k window.',
}

const KEY = 'jemero.settings.v1'

/**
 * In the Mac app, settings live in a file the main process owns, the page's
 * origin changes every launch, so localStorage alone forgot everything on
 * restart. localStorage remains the store for the browser build.
 */
function load(): Settings {
  try {
    const fromApp = window.jemero?.settings.load() as Partial<Settings> | null | undefined
    const raw = fromApp ? null : localStorage.getItem(KEY)
    // Merge over defaults so a new field in a later version doesn't read undefined.
    const saved = fromApp ?? (raw ? (JSON.parse(raw) as Partial<Settings>) : null)
    if (!saved) return DEFAULTS
    const merged = { ...DEFAULTS, ...saved }
    return isKitId(merged.kit) ? merged : { ...merged, kit: DEFAULTS.kit }
  } catch {
    return DEFAULTS
  }
}

function persist(value: Settings | null) {
  window.jemero?.settings.save(value ?? {})
  try {
    if (value) localStorage.setItem(KEY, JSON.stringify(value))
    else localStorage.removeItem(KEY)
  } catch {
    /* private window, or storage full, the file copy still has it */
  }
}

let current = load()
const listeners = new Set<() => void>()

function emit() {
  for (const fn of listeners) fn()
}

export function setSettings(patch: Partial<Settings>) {
  current = { ...current, ...patch }
  persist(current)
  emit()
}

export function resetSettings() {
  current = DEFAULTS
  persist(null)
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

/** The base prompt actually sent: the user's override, or the built-in one. */
export const effectivePrompt = (s: Settings = current) => s.systemPrompt.trim() || SYSTEM_PROMPT

export const maxTokensFor = (s: Settings = current) => ANSWER_TOKENS[s.answerLength]

const lightQuery = () => window.matchMedia('(prefers-color-scheme: light)')

/** 'system' resolved against the OS. */
export const resolveTheme = (theme: Theme): 'light' | 'dark' =>
  theme === 'system' ? (lightQuery().matches ? 'light' : 'dark') : theme

/** The app's resolved theme, following the OS live when set to 'system'. */
export function useResolvedTheme(): 'light' | 'dark' {
  const { theme } = useSettings()
  return useSyncExternalStore(
    (fn) => {
      const media = lightQuery()
      media.addEventListener('change', fn)
      return () => media.removeEventListener('change', fn)
    },
    () => resolveTheme(theme),
    () => 'dark',
  )
}

/**
 * Resolve `theme` against the OS and write it to <html>, plus a motion flag the
 * stylesheet reads. Called once at boot and on every change; returns a cleanup
 * for the OS listener so 'system' keeps tracking.
 */
export function applyAppearance(settings: Settings = current): () => void {
  const media = lightQuery()
  const paint = () => {
    document.documentElement.dataset.theme = resolveTheme(settings.theme)
    document.documentElement.dataset.motion = settings.animations ? 'on' : 'off'
  }
  paint()
  if (settings.theme !== 'system') return () => {}
  media.addEventListener('change', paint)
  return () => media.removeEventListener('change', paint)
}
