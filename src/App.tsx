import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ping, streamChat, type ChatMessage } from './lib/llm'
import { parseArtifacts, type ParsedFile } from './lib/parser'
import { compile, isScript, pickEntry, type Compiled } from './lib/compile'
import { kitById, withPacks, loadManifest, type KitId, type Manifest } from './lib/kits'
import {
  addTurn,
  addVersion,
  clearDraft,
  createItem,
  deleteItem,
  displayName,
  findItem,
  getLibrary,
  provisionalName,
  recoverDrafts,
  saveDraft,
  updateItem,
  useLibrary,
  type Kind,
  type Mode,
  type Version,
} from './lib/library'
import { KIND_LABEL, buildRequest, buildSystem, portRequest, refineRequest, repairRequest, reviewRequest } from './lib/systemPrompt'
import { bridge, modelLabel, setPriority, setQuantization, startSnapshotSync } from './lib/models'
import {
  applyAppearance,
  effectivePrompt,
  maxTokensFor,
  setSettings,
  useResolvedTheme,
  useSettings,
  type CanvasBg,
  type CanvasTheme,
  type CanvasWidth,
} from './lib/settings'
import ModelBrowser from './components/ModelBrowser'
import ModelMenu from './components/ModelMenu'
import SettingsPage from './components/SettingsPage'
import QuantizeDialog from './components/QuantizeDialog'
import ResourcesPage from './components/ResourcesPage'
import SetupPage from './components/SetupPage'
import {
  installedKey,
  installedPacks,
  isLocalPack,
  loadInstalledPacks,
  lockForFiles,
  watchInstalledPacks,
  type InstalledPack,
  type LocalPack,
} from './lib/packs'
import { selectPacks, type PackCandidate } from './lib/packSelect'
import Library from './components/Library'
import Conversation, { type Draft } from './components/Conversation'
import Stage, { type StageCode, type StageEvent } from './components/Stage'
import CodeView from './components/CodeView'
import ConsoleView, { type ConsoleEntry, type ConsoleLevel } from './components/ConsoleView'

type Phase = 'idle' | 'choosing' | 'installing' | 'thinking' | 'planning' | 'writing' | 'reviewing'
type Tab = 'canvas' | 'code' | 'console'

const PHASE_LABEL: Record<Exclude<Phase, 'idle'>, string> = {
  choosing: 'Choosing libraries…',
  installing: 'Installing a pack…',
  thinking: 'Thinking…',
  planning: 'Planning…',
  writing: 'Writing the code…',
  reviewing: 'Reviewing…',
}

const formatBytes = (b: number) =>
  b >= 1024 ** 2 ? `${(b / 1024 ** 2).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`

/** 4B parameters or fewer, read from the model id ("Qwen2.5-Coder-1.5B-Instruct-Q8_0"). */
function isSmallModel(id: string): boolean {
  const b = /(?:^|[^\d.])(\d+(?:\.\d+)?)\s*B(?![a-z])/i.exec(id.split('/').pop() ?? '')
  const m = /(?:^|[^\d.])(\d+)\s*M(?![a-z])/i.exec(id.split('/').pop() ?? '')
  if (b) return Number(b[1]) <= 4
  return !!m
}

/** A file name for a component the model didn't name: the current entry, or the request in PascalCase. */
function fileNameFor(entry: string | undefined, request: string): string {
  if (entry) return entry
  const words = request.match(/[A-Za-z][a-z]*/g)?.filter((w) => !/^(a|an|the|that|with|and|of|for|to|in|on)$/i.test(w)) ?? []
  const base = words.slice(0, 3).map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase()).join('')
  return `${base || 'Component'}.jsx`
}

/** How many times a file cut off by the answer length is continued before giving up. */
const CONTINUATIONS = 2

/** Re-parsing the whole stream on every token is O(n²); 70 ms still feels live. */
const PARSE_INTERVAL_MS = 70

/** Console lines kept; a chatty component can log thousands. */
const MAX_CONSOLE = 500

/**
 * A broken model or quantization degenerates into one repeated character
 * ("@@@@@@…", "GGGG…"). No real code has 48 identical non-space characters in
 * a row, so seeing it means stop now rather than stream 4k tokens of noise.
 */
const DEGENERATE = /([^\s])\1{47,}$/

/**
 * The other way small models break: the same block of lines over and over
 * (Qwen2.5-Coder 1.5B repeating its whole import list). True when the last
 * block of 3 to 40 varied lines appears three times in a row at the end.
 */
export function repeatingBlock(text: string): boolean {
  const lines = text.slice(-12000).split('\n').map((l) => l.trim())
  if (lines.length > 1 && lines.at(-1) !== '') lines.pop() // the line still being written
  for (let k = 2; k <= 40 && k * 3 <= lines.length; k++) {
    const block = lines.slice(-k)
    // Real code repeats short lines (a run of </div>); a loop repeats a varied block.
    if (new Set(block.filter((l) => l.length > 3)).size < 3) continue
    const same = (from: number) => block.every((l, i) => lines[lines.length - from * k + i] === l)
    if (same(2) && same(3)) return true
  }
  return false
}

const TABS: Tab[] = ['canvas', 'code', 'console']

const EXAMPLES: Record<Kind, string[]> = {
  component: [
    'Searchable select: each option shows an icon, a name and a chevron; a search field on top filters the list live',
    'Date range picker with presets like “Last 7 days” and a two-month calendar',
    'OTP input with 6 boxes, paste support, auto-advance and an error state',
    'Tag input: type and press Enter to add chips, Backspace removes the last one',
  ],
  block: [
    'Sign-in card with email, password with show/hide, remember me and social buttons',
    'Notification settings panel with grouped switches and a sticky save bar',
    'Pricing card with a monthly/yearly toggle and a feature checklist',
    'Data table with search, sortable columns, row selection and pagination',
  ],
  section: [
    'SaaS hero: headline, subtext, email capture and a product screenshot placeholder',
    'Three-tier pricing section with the middle plan highlighted',
    'Feature grid with six icon cards and a short intro',
    'Footer with four link columns, a newsletter signup and social links',
  ],
}

const REFINE_CHIPS: Record<Kind, string[]> = {
  component: ['Keyboard navigation', 'Empty, loading and error states', 'More compact', 'Polish the visual design'],
  block: ['Validation and error states', 'Responsive down to phones', 'Polish spacing and hierarchy'],
  section: ['Responsive down to phones', 'Stronger visual hierarchy', 'Subtle entrance motion'],
}

const ERROR_TITLE: Record<string, string> = {
  import: 'Could not load the component',
  render: 'The component crashed while rendering',
  runtime: 'Error while using the component',
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * A version's files after the model rewrote some of them. A component the
 * model renamed replaces the old entry file rather than lingering next to it.
 */
function mergeOutput(base: Version | null, written: ParsedFile[]): { files: Record<string, string>; entry: string } | null {
  const files = { ...(base?.files ?? {}) }
  for (const f of written) files[f.path] = f.content
  const paths = written.map((f) => f.path)
  let entry =
    base && paths.includes(base.entry)
      ? base.entry
      : (paths.find((p) => isScript(p) && /\bexport\s+default\b/.test(files[p])) ?? null)
  if (base && entry && entry !== base.entry && !paths.includes(base.entry)) {
    const stem = base.entry.replace(/\.[^.]+$/, '').split('/').pop() ?? ''
    const imported = Object.entries(files).some(([p, c]) => p !== base.entry && new RegExp(`from\\s*['"]\\./${escapeRe(stem)}`).test(c))
    if (!imported) delete files[base.entry]
  }
  entry ??= pickEntry(files, base?.entry)
  return entry ? { files, entry } : null
}

/** The shadcn sources a component uses, with what they use in turn, for the code tab. */
function kitSourcesFor(files: Record<string, string>, manifest: Manifest | null): Record<string, string> {
  if (!manifest) return {}
  const out: Record<string, string> = {}
  const queue = [Object.values(files).join('\n')]
  while (queue.length) {
    const src = queue.pop()!
    for (const m of src.matchAll(/['"]@\/components\/ui\/([\w-]+)['"]/g)) {
      const p = `components/ui/${m[1]}.jsx`
      if (manifest.sources[p] && !out[p]) {
        out[p] = manifest.sources[p]
        queue.push(out[p])
      }
    }
    if (/['"]@\/lib\/utils['"]/.test(src) && manifest.sources['lib/utils.js']) out['lib/utils.js'] = manifest.sources['lib/utils.js']
  }
  return out
}

function Icon({ d, size = 14 }: { d: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  )
}

const WIDTHS: { id: CanvasWidth; label: string; icon: string }[] = [
  { id: 'fit', label: 'Fit the pane', icon: 'M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3' },
  { id: '375', label: 'Phone, 375px', icon: 'M8 2h8a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zM11 18h2' },
  { id: '768', label: 'Tablet, 768px', icon: 'M6 2h12a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zM11 18h2' },
  { id: '1280', label: 'Desktop, 1280px', icon: 'M4 4h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zM8 20h8M12 16v4' },
]

const NEXT_BG: Record<CanvasBg, CanvasBg> = { dots: 'grid', grid: 'plain', plain: 'dots' }
/** shadcn/ui is built on Tailwind, so there is nothing to choose: every new component uses it. */
const NEW_KIT: KitId = 'shadcn'

const NEXT_THEME: Record<CanvasTheme, CanvasTheme> = { app: 'light', light: 'dark', dark: 'app' }

export default function App() {
  const settings = useSettings()
  const appTheme = useResolvedTheme()
  const library = useLibrary()

  // --- model server ------------------------------------------------------
  const [model, setModel] = useState('')
  const [serverStatus, setServerStatus] = useState('starting the model server…')
  const [serverLoading, setServerLoading] = useState(true)
  const [serverOk, setServerOk] = useState(false)
  // The shell opens the app at #models when nothing is downloaded yet, so a
  // first run lands on the browser rather than on a chat that can't answer.
  /** A full page in place of the library and workspace, opened from the rail. */
  const [page, setPage] = useState<'models' | 'settings' | 'resources' | 'setup' | null>(() =>
    // First launch: setup (a model and packs) before anything else.
    !settings.setupDone ? 'setup' : window.location.hash === '#models' ? 'models' : window.location.hash === '#settings' ? 'settings' : null,
  )
  const [menuOpen, setMenuOpen] = useState(false)
  const modelBtn = useRef<HTMLButtonElement>(null)

  // --- kits --------------------------------------------------------------
  const [manifest, setManifest] = useState<Manifest | null>(null)
  const [manifestError, setManifestError] = useState<string | null>(null)

  // --- packs ---------------------------------------------------------------
  /** Active, verified packs as the local server publishes them. */
  const [installed, setInstalled] = useState(installedPacks)
  /** The catalog's local packs, for naming the ones an import needs but this Mac lacks. */
  const [packCatalog, setPackCatalog] = useState<LocalPack[]>([])
  /** "This needs KaTeX. Install?", waiting for the user during a generation. */
  const [packAsk, setPackAsk] = useState<{ packs: LocalPack[]; resolve: (yes: boolean) => void } | null>(null)

  // --- library & generation ---------------------------------------------
  const [selectedId, setSelectedId] = useState<string | null>(() => getLibrary().items[0]?.id ?? null)
  /** Version on the canvas per item (1-based); missing means the latest. */
  const [viewed, setViewed] = useState<Record<string, number>>({})
  const [newKind, setNewKind] = useState<Kind>('component')
  const [prompt, setPrompt] = useState('')
  const [phase, setPhase] = useState<Phase>('idle')
  const [draft, setDraft] = useState<Draft | null>(null)
  /** Every file the model has started, for the code tab. */
  const [draftFiles, setDraftFiles] = useState<{ itemId: string; files: ParsedFile[] } | null>(null)
  /** Only the finished ones, for the canvas: it renders as soon as a file closes. */
  const [draftDone, setDraftDone] = useState<{ itemId: string; files: ParsedFile[]; kit: KitId } | null>(null)
  const [thought, setThought] = useState('')
  const abort = useRef<AbortController | null>(null)
  const startedAt = useRef(0)
  const running = useRef<{ itemId: string; mode: Mode } | null>(null)
  const composer = useRef<HTMLTextAreaElement>(null)

  // --- workspace ---------------------------------------------------------
  const [tab, setTab] = useState<Tab>('canvas')
  const [consoleEntries, setConsoleEntries] = useState<ConsoleEntry[]>([])
  const [stageError, setStageError] = useState<{ kind: string; message: string; detail: string } | null>(null)
  const [variants, setVariants] = useState<string[]>([])
  const [variant, setVariant] = useState<string | null>(null)
  const [renderMs, setRenderMs] = useState<number | null>(null)
  const [resetKey, setResetKey] = useState(0)
  const nextLogId = useRef(1)

  const item = library.items.find((i) => i.id === selectedId) ?? null
  const viewedN = item ? Math.min(viewed[item.id] ?? item.versions.length, item.versions.length) : 0
  const version = item && viewedN > 0 ? item.versions[viewedN - 1] : null
  const busy = phase !== 'idle'

  const log = useCallback((level: ConsoleLevel, text: string) => {
    setConsoleEntries((list) => {
      const entry = { id: nextLogId.current++, level, text, at: Date.now() }
      return list.length >= MAX_CONSOLE ? [...list.slice(-(MAX_CONSOLE - 100)), entry] : [...list, entry]
    })
  }, [])

  // Theme and motion live on <html>, so the CSS can switch without a re-render.
  useEffect(() => applyAppearance(settings), [settings])

  // Keep the model snapshot fresh (and ranked the user's way) for the header
  // menu and the browser.
  useEffect(() => startSnapshotSync(), [])

  // Installed packs: reloaded whenever one is activated or removed, which
  // also gives the canvas a new import map (its key changes).
  useEffect(() => {
    const refreshCatalog = () =>
      void bridge()
        ?.packs.list()
        .then((l) => setPackCatalog(l.packs.filter(isLocalPack)))
    const stopWatch = watchInstalledPacks(() => setInstalled(installedPacks()))
    const stopChanged = bridge()?.packs.onChanged(() => {
      void loadInstalledPacks()
      refreshCatalog()
    })
    refreshCatalog()
    return () => {
      stopWatch()
      stopChanged?.()
    }
  }, [])
  useEffect(() => setPriority(settings.modelPriority), [settings.modelPriority])
  useEffect(() => void setQuantization(settings.quantize), [settings.quantize])

  useEffect(() => {
    loadManifest().then(setManifest, (e: Error) => setManifestError(e.message))
  }, [])

  // ⌘L and ⌘, from the macOS menu bar.
  useEffect(
    () =>
      window.jemero?.onMenu((which) => {
        setPage(which)
      }),
    [],
  )

  // Startup: nothing is usable until the model answers and the UI kits are
  // loaded. The shell has already started the server before opening this page,
  // so this is usually one round trip; it keeps trying for a minute in case the
  // server is still coming up. With no model downloaded (the shell opens
  // #models) there is nothing to wait for but the kits.
  const [booted, setBooted] = useState(false)
  const [bootStep, setBootStep] = useState('Starting…')
  useEffect(() => {
    let cancelled = false
    const boot = async () => {
      const needsServer = window.location.hash !== '#models'
      const started = Date.now()
      setBootStep('Loading the model…')
      while (!cancelled && needsServer && Date.now() - started < 60_000) {
        const result = await ping()
        if (result.ok) break
        await new Promise((r) => setTimeout(r, 500))
      }
      if (cancelled) return
      setBootStep('Loading components…')
      await Promise.all([loadManifest().catch(() => undefined), loadInstalledPacks(), recoverDrafts().catch(() => 0)])
      if (cancelled) return
      // Known before anything compiles: otherwise a saved component that uses a
      // pack is compiled once against an empty pack list and reports it missing.
      setInstalled(installedPacks())
      setBooted(true)
    }
    void boot()
    return () => {
      cancelled = true
    }
  }, [])

  // Watch the built-in model server.
  useEffect(() => {
    let cancelled = false
    const check = async () => {
      const result = await ping()
      if (cancelled) return
      setServerOk(result.ok)
      setServerStatus(result.detail)
      setServerLoading(result.loading)
      // The server holds exactly one model at a time, so it, not a stale
      // selection, is the truth about what a prompt will be answered by.
      if (result.ok) setModel(result.model)
    }
    void check()
    // No point probing a local server while nobody is looking at the window.
    const id = setInterval(() => {
      if (!document.hidden) void check()
    }, 5000)
    const onVisible = () => !document.hidden && void check()
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      cancelled = true
      clearInterval(id)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [])

  // A different component starts with a clean canvas state and console.
  useEffect(() => {
    setStageError(null)
    setVariants([])
    setVariant(null)
    setRenderMs(null)
    setConsoleEntries([])
  }, [selectedId])

  // --- what the canvas and the code tab show ------------------------------

  const source = useMemo(() => {
    if (!item) return null
    if (draftDone && draftDone.itemId === item.id && draftDone.files.length) {
      const merged = mergeOutput(version, draftDone.files)
      if (merged) return { ...merged, kit: draftDone.kit }
    }
    return version ? { files: version.files, entry: version.entry, kit: version.kit } : null
  }, [item?.id, draftDone, version]) // eslint-disable-line react-hooks/exhaustive-deps

  // Hand edits arrive per keystroke; compiling once typing pauses keeps a
  // half-typed line from flashing an error on the canvas.
  const editing = useRef(false)
  const [compileInput, setCompileInput] = useState(source)
  useEffect(() => {
    if (!editing.current) return setCompileInput(source)
    const id = setTimeout(() => {
      editing.current = false
      setCompileInput(source)
    }, 280)
    return () => clearTimeout(id)
  }, [source])

  // What the compiler accepts: the kit plus every installed, verified pack.
  // Imports of catalog packs that aren't installed are refused by name, so
  // they never reach the canvas.
  const packManifest = useMemo(() => (manifest ? withPacks(manifest, installed) : null), [manifest, installed])
  const missingPacks = useMemo(() => {
    const out: Record<string, string> = {}
    for (const p of packCatalog) if (!installed.packs[p.id]) for (const spec of Object.keys(p.imports)) out[spec] = p.name
    return out
  }, [packCatalog, installed])

  const compiled = useMemo<Compiled | null>(
    () =>
      booted && compileInput && packManifest
        ? compile(compileInput.files, compileInput.entry, compileInput.kit, packManifest, {
            repair: settings.autoFixImports,
            missingPacks,
          })
        : null,
    [booted, compileInput, packManifest, missingPacks, settings.autoFixImports],
  )

  // The canvas keeps showing the last version that compiled while the current
  // one has an error, so there's always something to compare against.
  const [shown, setShown] = useState<{ itemId: string; code: StageCode; kit: KitId } | null>(null)
  useEffect(() => {
    if (!compiled) return
    for (const note of compiled.notes) log(note.level === 'warn' ? 'warn' : 'system', note.text)
    if (!compiled.ok) {
      log('error', compiled.error)
      return
    }
    if (item && compileInput) setShown({ itemId: item.id, code: { entry: compiled.entry, modules: compiled.modules }, kit: compileInput.kit })
  }, [compiled]) // eslint-disable-line react-hooks/exhaustive-deps
  const stage = shown && item && shown.itemId === item.id ? shown : null

  const codeFiles = useMemo(() => {
    if (item && draftFiles && draftFiles.itemId === item.id && draftFiles.files.length) {
      const files = { ...(version?.files ?? {}) }
      for (const f of draftFiles.files) files[f.path] = f.content
      return files
    }
    return version?.files ?? {}
  }, [item?.id, draftFiles, version]) // eslint-disable-line react-hooks/exhaustive-deps
  const kitFiles = useMemo(() => kitSourcesFor(codeFiles, manifest), [codeFiles, manifest])
  const streamingPath = draftFiles && item && draftFiles.itemId === item.id ? (draftFiles.files.find((f) => !f.complete)?.path ?? null) : null

  const onStageEvent = useCallback(
    (e: StageEvent) => {
      if (e.type === 'rendered') {
        setStageError(null)
        setVariants(e.variants)
        setRenderMs(e.ms)
        setVariant((v) => (v && v !== '*' && !e.variants.includes(v) ? null : v))
        log('system', `Rendered in ${e.ms} ms`)
      } else if (e.type === 'error') {
        const detail = [e.message, e.componentStack?.trim().split('\n').slice(0, 6).join('\n')].filter(Boolean).join('\n')
        setStageError({ kind: e.kind, message: e.message, detail })
        log('error', `${ERROR_TITLE[e.kind] ?? 'Error'}: ${e.message}`)
      } else {
        log(e.level, e.text)
      }
    },
    [log],
  )

  // --- generation ---------------------------------------------------------

  /** Ask whether to download packs; resolves false on "not now" or when the run is stopped. */
  const askInstall = useCallback(
    (packs: LocalPack[], signal: AbortSignal) =>
      new Promise<boolean>((resolve) => {
        const done = (yes: boolean) => {
          setPackAsk(null)
          resolve(yes)
        }
        signal.addEventListener('abort', () => done(false), { once: true })
        setPackAsk({ packs, resolve: done })
      }),
    [],
  )

  /**
   * Pass one of a generation: pick packs, install the missing ones (after
   * asking), fall back to installed alternatives when that fails or is
   * declined. Returns installed packs only: the model is never told about an
   * import the canvas can't load yet.
   */
  const resolvePacks = useCallback(
    async ({
      mode,
      kind,
      text,
      base,
      itemId,
      signal,
    }: {
      mode: Mode
      kind: Kind
      text: string
      base: Version | null
      itemId: string
      signal: AbortSignal
    }) => {
      let inst = await loadInstalledPacks()
      // Packs the current version already uses stay available to it.
      const keep = base ? Object.keys(lockForFiles(base.files, inst).packs) : []
      const pick = (ids: string[]) =>
        [...new Set([...keep, ...ids])].filter((id) => inst.packs[id]).map((id) => ({ id, pack: inst.packs[id] }))
      if (mode !== 'build' && mode !== 'refine') return pick([])
      const api = bridge()
      if (!api || !model) return pick([])

      try {
        setPhase('choosing')
        // Online means the pack server answered this request, not that Wi-Fi is on.
        const list = await api.packs.list()
        signal.throwIfAborted()
        const online = list.ok && !list.fromCache && !!list.source
        const catalog = list.packs.filter(isLocalPack)
        const installedOnly = (): PackCandidate[] =>
          Object.entries(inst.packs).map(([id, p]) => ({
            id,
            name: p.name,
            description: p.description,
            installed: true,
            download: 0,
            dependencies: p.dependencies,
          }))
        const candidates: PackCandidate[] = online
          ? catalog.map((p) => ({
              id: p.id,
              name: p.name,
              description: p.description ?? '',
              installed: inst.packs[p.id]?.version === p.version,
              download: inst.packs[p.id] ? 0 : p.size.download,
              dependencies: p.dependencies,
            }))
          : installedOnly()
        let chosen = await selectPacks({ model, kind, request: text, candidates, signal })

        const missing = chosen.filter((id) => !inst.packs[id])
        if (!missing.length) return pick(chosen)

        // With dependencies, so the prompt shows the whole download.
        const byId = new Map(catalog.map((p) => [p.id, p]))
        const needed: LocalPack[] = []
        const add = (id: string) => {
          const p = byId.get(id)
          if (!p || inst.packs[id] || needed.includes(p)) return
          p.dependencies.forEach(add)
          needed.push(p)
        }
        missing.forEach(add)

        let failure = ''
        if (await askInstall(needed, signal)) {
          setPhase('installing')
          for (const id of missing) {
            const res = await api.packs.install(id)
            signal.throwIfAborted()
            if (!res.ok) {
              failure = res.reason ?? 'The download failed.'
              break
            }
          }
          inst = await loadInstalledPacks()
        } else {
          signal.throwIfAborted()
          failure = 'declined'
        }
        if (missing.every((id) => inst.packs[id])) return pick(chosen)

        // Not installed: choose again among what is, and say so.
        const names = needed.map((p) => p.name).join(', ')
        addTurn(itemId, {
          role: 'assistant',
          mode,
          text:
            failure === 'declined'
              ? `Building without ${names}, using what's installed.`
              : `Couldn't install ${names}: ${failure} Building with what's installed instead.`,
        })
        setPhase('choosing')
        chosen = await selectPacks({ model, kind, request: text, candidates: installedOnly(), signal })
        return pick(chosen)
      } catch (e) {
        // Choosing is an optimisation, never a blocker: build with the kit and
        // whatever this version already uses.
        if (signal.aborted) throw e
        console.warn('pack selection failed', e)
        return pick([])
      }
    },
    [model, askInstall],
  )

  const generate = useCallback(
    async (requested: Mode, text: string, portKit?: KitId) => {
      if (!model || !manifest || abort.current) return
      let mode = requested
      let target = mode === 'build' ? null : findItem(selectedId)
      if (!target) {
        target = createItem(newKind, provisionalName(text))
        setSelectedId(target.id)
        mode = 'build'
      }
      const n = Math.min(viewed[target.id] ?? target.versions.length, target.versions.length)
      const base = n > 0 ? target.versions[n - 1] : null
      // Nothing built yet (a first attempt failed): whatever was asked is the build.
      if (!base) mode = 'build'

      const kit: KitId = mode === 'port' && portKit ? portKit : (base?.kit ?? NEW_KIT)
      const request =
        mode === 'build'
          ? buildRequest(target.kind, text)
          : mode === 'review'
            ? reviewRequest(target, base!)
            : mode === 'repair'
              ? repairRequest(target, base!, text)
              : mode === 'port'
                ? portRequest(target, base!, base!.kit, kit)
                : refineRequest(target, base!, n, text)
      const said =
        mode === 'review'
          ? 'Review it'
          : mode === 'repair'
            ? `Fix: ${text.split('\n')[0].slice(0, 160)}`
            : mode === 'port'
              ? `Rebuild it with ${kitById(kit).name}`
              : text
      const itemId = target.id
      addTurn(itemId, { role: 'user', mode, text: said })

      const controller = new AbortController()
      abort.current = controller
      startedAt.current = performance.now()
      running.current = { itemId, mode }
      setThought('')
      setPhase(mode === 'review' ? 'reviewing' : 'thinking')
      setDraft({ itemId, mode, prose: '', plan: '', review: [] })
      setDraftFiles(null)
      setDraftDone(null)
      // Watch a new component being written; changes to one stay on the canvas.
      if (mode === 'build' || (settings.autoSwitchTabs && mode !== 'review')) setTab('code')

      // Pass one: which packs, installed before a line of code is written.
      // It only throws when the run was stopped.
      let chosenPacks: { id: string; pack: InstalledPack }[]
      try {
        chosenPacks = await resolvePacks({ mode, kind: target.kind, text, base, itemId, signal: controller.signal })
      } catch {
        abort.current = null
        running.current = null
        setPhase('idle')
        setDraft(null)
        return
      }
      const system = buildSystem({
        base: effectivePrompt(settings),
        kit,
        kind: target.kind,
        manifest,
        plan: settings.planFirst,
        review: mode === 'review',
        packs: chosenPacks,
        compact: isSmallModel(model),
      })
      if (mode !== 'review') setPhase('thinking')

      let raw = ''
      let lastParse = 0
      let doneSig = ''
      let broken: Error | null = null
      // parseArtifacts re-reads the whole stream, so it runs on an interval
      // rather than per token, and once more at the end.
      const flush = () => {
        const p = parseArtifacts(raw)
        setDraft({ itemId, mode, prose: p.prose, plan: p.plan, review: p.review })
        if (p.files.length) {
          if (mode !== 'review') setPhase('writing')
          setDraftFiles({ itemId, files: p.files })
          const done = p.files.filter((f) => f.complete)
          const sig = done.map((f) => `${f.path}:${f.content.length}`).join('|')
          if (sig !== doneSig) {
            doneSig = sig
            setDraftDone({ itemId, files: done, kit })
          }
          // Every file as it's written, saved to the library database.
          saveDraft(itemId, p.files)
        } else if (p.plan) {
          setPhase((ph) => (ph === 'thinking' ? 'planning' : ph))
        }
      }

      try {
        const onToken = (token: string) => {
          raw += token
          if (!broken && (DEGENERATE.test(raw.slice(-64)) || (token.includes('\n') && repeatingBlock(raw)))) {
            // Record first, then abort: a plain abort is the user pressing
            // Stop and stays quiet, which would hide this.
            broken = new Error(
              DEGENERATE.test(raw.slice(-64))
                ? `The model started repeating “${raw.slice(-1)}” endlessly. Its output is broken, not slow. ` +
                    'Switch to another model from the header; if this one keeps doing it, delete and re-download it.'
                : 'The model got stuck writing the same lines over and over, so it was stopped. Try again, ' +
                    'or use a larger model: small ones loop more often.',
            )
            controller.abort()
            return
          }
          const now = performance.now()
          if (now - lastParse < PARSE_INTERVAL_MS) return
          lastParse = now
          flush()
        }
        const ask = (messages: ChatMessage[], handle: (t: string) => void) =>
          streamChat({
            model,
            messages,
            temperature: settings.temperature,
            topP: settings.topP,
            maxTokens: maxTokensFor(settings),
            thinking: settings.thinking,
            signal: controller.signal,
            onThought: settings.showReasoning ? (t) => setThought((prev) => (prev + t).slice(-4000)) : undefined,
            onToken: handle,
          })
        const messages: ChatMessage[] = [
          { role: 'system', content: system },
          { role: 'user', content: request },
        ]
        await ask(messages, onToken)

        // No file at all (small models sometimes restate the request and stop):
        // open the file for the model and let it write from there.
        if (!broken && mode !== 'review' && !parseArtifacts(raw).files.length && !controller.signal.aborted) {
          const name = fileNameFor(base?.entry, text)
          const prefix = `${raw.trimEnd()}\n<file path="${name}">\n`
          raw = prefix
          flush()
          let pending = ''
          let past = false
          await ask([...messages, { role: 'assistant', content: prefix }], (token) => {
            if (past) return onToken(token)
            pending += token
            if (pending.length < prefix.length && prefix.startsWith(pending)) return
            past = true
            onToken(pending.startsWith(prefix) ? pending.slice(prefix.length) : pending)
          })
        }

        // Cut off in the middle of a file: keep what's written and let the
        // model carry on from that exact point (its reply so far goes back as
        // the start of its answer), rather than throwing the work away.
        for (let more = 0; more < CONTINUATIONS && !broken; more++) {
          const last = parseArtifacts(raw).files.at(-1)
          if (!last || last.complete) break
          const prefix = raw
          // The server streams the prefix back before the new text; skip that echo.
          let pending = ''
          let past = false
          await ask([...messages, { role: 'assistant', content: prefix }], (token) => {
            if (past) return onToken(token)
            pending += token
            if (pending.length < prefix.length && prefix.startsWith(pending)) return
            past = true
            onToken(pending.startsWith(prefix) ? pending.slice(prefix.length) : pending)
          })
        }
        flush()
        if (broken) throw broken

        const p = parseArtifacts(raw)
        if (mode === 'review') {
          if (!p.review.length) throw new Error('The model answered without a review list. Try again, or use a stronger model.')
          addTurn(itemId, { role: 'assistant', mode, text: p.prose, review: p.review })
          return
        }
        const written = p.files.filter((f) => f.complete)
        if (!written.length) {
          throw new Error(
            p.files.length
              ? 'The model ran out of room in the middle of the file. Raise Answer length in Settings, or ask for something smaller.'
              : `The model answered without a <file> block. Try again, or pick a stronger model.${raw.trim() ? ` It wrote: “${raw.trim().slice(0, 160)}”` : ' Its answer was empty.'}`,
          )
        }
        const merged = mergeOutput(base, written)
        if (!merged) throw new Error('The model wrote no JavaScript file to render.')
        const number = addVersion(itemId, {
          files: merged.files,
          entry: merged.entry,
          kit,
          // The exact pack versions this code renders with.
          packs: lockForFiles(merged.files, installedPacks()),
          plan: p.plan,
          prompt: said,
          mode,
          createdAt: Date.now(),
        })
        updateItem(itemId, (it) => ({ ...it, name: displayName(merged.entry) }))
        addTurn(itemId, { role: 'assistant', mode, text: p.prose, plan: p.plan || undefined, version: number })
        setViewed((v) => ({ ...v, [itemId]: number }))
        if (mode === 'build' || settings.autoSwitchTabs) setTab('canvas')
      } catch (e) {
        if (controller.signal.aborted && !broken) return
        addTurn(itemId, { role: 'assistant', mode, text: '', error: (broken ?? (e as Error)).message })
      } finally {
        // Saved, stopped or failed, the run ended here and was dealt with here.
        // A draft only has to outlive a crash or a quit, never a run that ended.
        clearDraft(itemId)
        if (abort.current === controller) {
          abort.current = null
          running.current = null
          setPhase('idle')
          setDraft(null)
          setDraftFiles(null)
          setDraftDone(null)
        }
      }
    },
    [model, manifest, selectedId, viewed, newKind, settings, resolvePacks],
  )

  const cancel = useCallback((e?: { type?: string }) => {
    const controller = abort.current
    const run = running.current
    if (!controller) return
    // Send and Stop are the same button: a double-click on Send must not stop what it just started.
    if (e?.type === 'click' && performance.now() - startedAt.current < 600) return
    controller.abort()
    if (run) addTurn(run.itemId, { role: 'assistant', mode: run.mode, text: 'Stopped.' })
  }, [])

  // Esc stops whatever is running.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') cancel(e)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [cancel])

  const submit = useCallback(() => {
    const text = prompt.trim()
    // ⌘↵ works while the button is disabled: don't swallow a prompt nothing can answer.
    if (!text || busy || !serverOk || !manifest) return
    setPrompt('')
    void generate(item ? 'refine' : 'build', text)
  }, [prompt, busy, serverOk, manifest, item, generate])

  const onEdit = useCallback(
    (path: string, content: string) => {
      const it = findItem(selectedId)
      if (!it) return
      const n = Math.min(viewed[it.id] ?? it.versions.length, it.versions.length)
      const v = it.versions[n - 1]
      if (!v) return
      editing.current = true
      const files = { ...v.files, [path]: content }
      // Typing into the newest hand-edited version keeps editing it; anything
      // else starts a new version, so what the model wrote stays intact.
      if (n === it.versions.length && v.mode === 'edit') {
        updateItem(it.id, (x) => ({ ...x, versions: x.versions.map((y, i) => (i === n - 1 ? { ...y, files } : y)) }))
      } else {
        const number = addVersion(it.id, { ...v, files, mode: 'edit', prompt: 'Edited by hand', plan: '', createdAt: Date.now() })
        addTurn(it.id, { role: 'assistant', mode: 'edit', text: 'Edited by hand.', version: number })
        setViewed((x) => ({ ...x, [it.id]: number }))
      }
    },
    [selectedId, viewed],
  )

  const startNew = useCallback(() => {
    setSelectedId(null)
    requestAnimationFrame(() => composer.current?.focus())
  }, [])

  const remove = useCallback(
    (id: string) => {
      deleteItem(id)
      if (id === selectedId) setSelectedId(getLibrary().items[0]?.id ?? null)
    },
    [selectedId],
  )

  const showVersion = useCallback(
    (n: number) => {
      if (selectedId) setViewed((v) => ({ ...v, [selectedId]: n }))
    },
    [selectedId],
  )

  const applyReview = useCallback(
    (points: string[]) => void generate('refine', `Apply these review points:\n${points.map((p) => `- ${p}`).join('\n')}`),
    [generate],
  )

  const problem =
    compiled && !compiled.ok
      ? { title: 'Could not compile', message: compiled.error, dismissable: false }
      : stageError
        ? { title: ERROR_TITLE[stageError.kind] ?? 'Error', message: stageError.detail, dismissable: true }
        : null

  const stagePacks = useMemo(
    () => ({ key: installedKey(installed), imports: installed.imports, styles: installed.styles }),
    [installed],
  )
  const currentKit = draftDone?.kit ?? version?.kit ?? NEW_KIT
  const canvasKit = stage?.kit ?? currentKit
  const canvasTheme = settings.canvasTheme === 'app' ? appTheme : settings.canvasTheme
  const layout = (item?.kind ?? newKind) === 'section' ? 'fill' : 'center'
  const errorCount = consoleEntries.filter((e) => e.level === 'error').length
  const canAsk = serverOk && !!manifest && !busy

  const serverNotice = !serverOk ? (
    serverLoading ? (
      <p className="loading-note">
        <span className="spinner-dot" /> Loading the model…
      </p>
    ) : (
      <p className="warn">
        No model running.{' '}
        <button className="link" onClick={() => setPage('models')} title={serverStatus}>
          Pick one
        </button>
      </p>
    )
  ) : null

  if (!booted) {
    return (
      <div className="boot" role="status" aria-live="polite">
        <span className="logo">⬢</span>
        <strong>Jemero</strong>
        <p>
          <span className="spinner-dot" /> {bootStep}
        </p>
      </div>
    )
  }

  const composerEl = (
    <div className="composer">
      {packAsk && (
        <div className="pack-ask" role="alertdialog" aria-label="Install packs">
          <div className="pack-ask-text">
            <strong>Needs {packAsk.packs.map((p) => p.name).join(', ')}</strong>
            <span>
              {formatBytes(packAsk.packs.reduce((n, p) => n + p.size.download, 0))} download
              {packAsk.packs.length > 1 ? ` · ${packAsk.packs.length} packs` : ''}
              {packAsk.packs.some((p) => p.dependencies.length) &&
                ` · with ${packAsk.packs.flatMap((p) => p.dependencies).join(', ')}`}
            </span>
          </div>
          <button className="btn ghost small" onClick={() => packAsk.resolve(false)}>
            Not now
          </button>
          <button className="btn small" onClick={() => packAsk.resolve(true)}>
            Install
          </button>
        </div>
      )}
      {item && version && !busy && (
        <div className="chips">
          {REFINE_CHIPS[item.kind].map((c) => (
            <button key={c} className="chip-btn" onClick={() => void generate('refine', c)} disabled={!canAsk}>
              {c}
            </button>
          ))}
        </div>
      )}
      <textarea
        ref={composer}
        value={prompt}
        placeholder={
          !serverOk
            ? serverLoading
              ? 'Loading the model…'
              : 'No model is serving. Pick one from the header'
            : item
              ? `Change ${item.name}: “make it compact”, “add a clear button”…`
              : `Describe a ${newKind}: what it shows and how it behaves`
        }
        onChange={(e) => setPrompt(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit()
        }}
        rows={3}
      />
      <div className="composer-actions">
        {busy ? (
          <button className="stop" onClick={cancel}>
            <span className="stop-icon" /> Stop · {PHASE_LABEL[phase as Exclude<Phase, 'idle'>]}
            <span className="kbd">esc</span>
          </button>
        ) : (
          <>
            {item && version && (
              <button
                className="btn ghost review-btn"
                onClick={() => void generate('review', '')}
                disabled={!canAsk}
                title="Ask the model for a critique you can apply"
              >
                Review
              </button>
            )}
            <button className="send" onClick={submit} disabled={!canAsk || !prompt.trim()}>
              {item ? 'Refine' : 'Generate'} <span className="kbd light">⌘↵</span>
            </button>
          </>
        )}
      </div>
    </div>
  )

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo">⬢</span>
          <div>
            <strong>Jemero</strong>
          </div>
        </div>
        <div className="topbar-right">
          <div className="model-anchor">
            <button
              className={`model-btn${menuOpen ? ' open' : ''}`}
              ref={modelBtn}
              onClick={() => setMenuOpen((v) => !v)}
              title="Switch the local model"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
            >
              <span className={serverOk ? 'dot ok' : 'dot bad'} />
              <span className="model-name">{modelLabel(model) || 'Choose a model'}</span>
              <svg className="model-caret" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round">
                <path d="M6 9l6 6 6-6" />
              </svg>
            </button>
            {menuOpen && (
              <ModelMenu
                anchorRef={modelBtn}
                onClose={() => setMenuOpen(false)}
                onBrowse={() => {
                  setMenuOpen(false)
                  setPage('models')
                }}
                onActive={(id) => setModel(id)}
              />
            )}
          </div>
        </div>
      </header>

      {settings.setupDone && page !== 'setup' && <QuantizeDialog />}

      <div className={`body${page ? ' on-page' : !item ? ' on-start' : ''}`}>
        <nav className="rail" aria-label="Main">
          <button className={`rail-btn${!selectedId && !page ? ' active' : ''}`} onClick={() => {
              setPage(null)
              startNew()
            }} title="New chat" aria-label="New chat">
            {/* Lucide "square-pen" (ISC licence). */}
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
              <path d="M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z" />
            </svg>
          </button>
          <button className={`rail-btn${page === 'models' ? ' active' : ''}`} onClick={() => setPage((p) => (p === 'models' ? null : 'models'))} title="Models" aria-label="Models">
            {/* Lucide "cpu" (ISC licence). */}
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
              <rect x="4" y="4" width="16" height="16" rx="2" />
              <rect x="9" y="9" width="6" height="6" />
              <path d="M15 2v2M15 20v2M2 15h2M2 9h2M20 15h2M20 9h2M9 2v2M9 20v2" />
            </svg>
          </button>
          <button
            className={`rail-btn${page === 'resources' ? ' active' : ''}`}
            onClick={() => setPage((p) => (p === 'resources' ? null : 'resources'))}
            title="Resources"
            aria-label="Resources"
          >
            {/* Lucide "book-open" (ISC licence). */}
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 7v14" />
              <path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z" />
            </svg>
          </button>
          <div className="rail-spacer" />
          <button className={`rail-btn${page === 'settings' ? ' active' : ''}`} onClick={() => setPage((p) => (p === 'settings' ? null : 'settings'))} title="Settings" aria-label="Settings">
            {/* Lucide "settings" (ISC licence). */}
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
          </button>
        </nav>
        {page === 'settings' && <SettingsPage onClose={() => setPage(null)} />}
        {page === 'resources' && (
          <ResourcesPage
            items={library.items}
            installed={installed}
            manifest={packManifest}
            onOpenModels={() => setPage('models')}
            onClose={() => setPage(null)}
          />
        )}
        {page === 'setup' && (
          <SetupPage
            packs={packCatalog}
            installed={installed}
            items={library.items}
            manifest={packManifest}
            onDone={() => setPage(null)}
            onOpenModels={() => setPage('models')}
          />
        )}
        {page === 'models' && (
          <ModelBrowser
            open
            onClose={() => {
              // Opened from first-run setup ("More models"): go back and finish it.
              setPage(settings.setupDone ? null : 'setup')
              if (window.location.hash === '#models') window.location.hash = ''
            }}
            onActive={(id) => setModel(id)}
          />
        )}
        {!item && !page && (
          <section className="start">
            <h1>What should we build?</h1>
            {composerEl}
            <div className="segmented kind-switch" role="radiogroup" aria-label="Size">
              {(['component', 'block', 'section'] as Kind[]).map((k) => (
                <button key={k} className={newKind === k ? 'seg active' : 'seg'} onClick={() => setNewKind(k)} role="radio" aria-checked={newKind === k}>
                  {KIND_LABEL[k]}
                </button>
              ))}
            </div>
            {serverNotice}
          </section>
        )}
        <section className="side">
          <Library
            items={library.items}
            selectedId={selectedId}
            busyId={busy ? (draft?.itemId ?? null) : null}
            onSelect={setSelectedId}
            onNew={startNew}
            onDelete={remove}
          />

          {item && (
            <Conversation
              item={item}
              draft={draft}
              phaseLabel={phase === 'idle' ? null : PHASE_LABEL[phase]}
              thought={thought}
              showThought={settings.showReasoning}
              busy={busy}
              viewedVersion={viewedN}
              newKind={newKind}
              onKind={setNewKind}
              examples={EXAMPLES[newKind]}
              onExample={(ex) => {
                setPrompt(ex)
                composer.current?.focus()
              }}
              onVersion={showVersion}
              onApplyReview={applyReview}
              notice={serverNotice}
            />
          )}

          {item && composerEl}
        </section>

        <section className="workspace">
          <nav className="tabs">
            <div className="tab-group" style={{ '--tab-index': TABS.indexOf(tab) } as React.CSSProperties}>
              <span className="tab-pill" />
              {TABS.map((t) => (
                <button key={t} className={tab === t ? 'tab active' : 'tab'} onClick={() => setTab(t)} aria-current={tab === t}>
                  {t}
                  {t === 'console' && errorCount > 0 && <span className="tab-badge">{errorCount}</span>}
                </button>
              ))}
            </div>

            {tab === 'canvas' && (
              <div className="canvas-tools">
                <div className="segmented" role="radiogroup" aria-label="Canvas width">
                  {WIDTHS.map((w) => (
                    <button
                      key={w.id}
                      className={settings.canvasWidth === w.id ? 'seg icon active' : 'seg icon'}
                      onClick={() => setSettings({ canvasWidth: w.id })}
                      title={w.label}
                      aria-label={w.label}
                      role="radio"
                      aria-checked={settings.canvasWidth === w.id}
                    >
                      <Icon d={w.icon} size={13} />
                    </button>
                  ))}
                </div>
                <button
                  className="icon-btn"
                  onClick={() => setSettings({ canvasTheme: NEXT_THEME[settings.canvasTheme] })}
                  title={`Canvas theme: ${settings.canvasTheme === 'app' ? 'follows the app' : settings.canvasTheme}`}
                  aria-label="Canvas theme"
                >
                  {settings.canvasTheme === 'light' ? (
                    <Icon d="M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4" />
                  ) : settings.canvasTheme === 'dark' ? (
                    <Icon d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
                  ) : (
                    <Icon d="M12 3a9 9 0 1 0 0 18V3zM12 3a9 9 0 0 1 0 18" />
                  )}
                </button>
                <button
                  className="icon-btn"
                  onClick={() => setSettings({ canvasBg: NEXT_BG[settings.canvasBg] })}
                  title={`Canvas background: ${settings.canvasBg}`}
                  aria-label="Canvas background"
                >
                  {settings.canvasBg === 'dots' ? (
                    <Icon d="M6 6h.01M12 6h.01M18 6h.01M6 12h.01M12 12h.01M18 12h.01M6 18h.01M12 18h.01M18 18h.01" />
                  ) : settings.canvasBg === 'grid' ? (
                    <Icon d="M3 9h18M3 15h18M9 3v18M15 3v18" />
                  ) : (
                    <Icon d="M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" />
                  )}
                </button>
                <button
                  className="icon-btn"
                  onClick={() => setResetKey((k) => k + 1)}
                  disabled={!stage}
                  title="Reset the component's state"
                  aria-label="Reset state"
                >
                  <Icon d="M3 12a9 9 0 1 0 2.64-6.36M3 3v6h6" />
                </button>
              </div>
            )}

            <span className="phase">
              {busy ? (
                <span key={phase} className="phase-text">
                  {PHASE_LABEL[phase as Exclude<Phase, 'idle'>]}
                </span>
              ) : renderMs !== null && stage ? (
                <span className="phase-text">Rendered in {renderMs} ms</span>
              ) : null}
            </span>

            {item && item.versions.length > 0 && (
              <div className="versions" aria-label="Versions">
                <button className="icon-btn" onClick={() => showVersion(viewedN - 1)} disabled={viewedN <= 1} title="Previous version" aria-label="Previous version">
                  <Icon d="M15 18l-6-6 6-6" />
                </button>
                <span className="versions-label">
                  v{viewedN}
                  <span className="versions-of"> / {item.versions.length}</span>
                </span>
                <button
                  className="icon-btn"
                  onClick={() => showVersion(viewedN + 1)}
                  disabled={viewedN >= item.versions.length}
                  title="Next version"
                  aria-label="Next version"
                >
                  <Icon d="M9 18l6-6-6-6" />
                </button>
              </div>
            )}
          </nav>

          {/* All three stay mounted: the canvas iframe must survive tab switches,
              so visibility is a class, not `hidden`, and can be transitioned. */}
          <div className="pane">
            <div className={`fill slot canvas-slot${tab === 'canvas' ? ' shown' : ''}`}>
              {variants.length > 0 && (
                <div className="variant-bar" role="tablist" aria-label="States">
                  {([[null, 'Preview'], ...variants.map((v) => [v, v]), ['*', 'All states']] as [string | null, string][]).map(
                    ([id, label]) => (
                      <button
                        key={label}
                        className={variant === id ? 'variant active' : 'variant'}
                        onClick={() => setVariant(id)}
                        role="tab"
                        aria-selected={variant === id}
                      >
                        {label}
                      </button>
                    ),
                  )}
                </div>
              )}
              <Stage
                code={stage?.code ?? null}
                kit={canvasKit}
                packs={stagePacks}
                layout={layout}
                theme={canvasTheme}
                bg={settings.canvasBg}
                width={settings.canvasWidth}
                variant={variant}
                resetKey={resetKey}
                onEvent={onStageEvent}
              >
                {!stage && (
                  <div className="canvas-empty">
                    {manifestError ? (
                      <p className="warn">{manifestError}</p>
                    ) : busy && draft?.itemId === item?.id ? (
                      <>
                        <span className="canvas-pulse" />
                        <p>{PHASE_LABEL[phase as Exclude<Phase, 'idle'>]}</p>
                      </>
                    ) : item ? (
                      <p>{item.versions.length ? 'Loading…' : 'Not built yet'}</p>
                    ) : (
                      <p>Preview</p>
                    )}
                  </div>
                )}
                {problem && (
                  <div className="canvas-error" role="alert">
                    <div className="canvas-error-text">
                      <strong>{problem.title}</strong>
                      <pre>{problem.message}</pre>
                    </div>
                    <div className="canvas-error-actions">
                      <button className="btn small" onClick={() => void generate('repair', problem.message)} disabled={!canAsk || !version}>
                        Fix with the model
                      </button>
                      {problem.dismissable && (
                        <button className="icon-btn" onClick={() => setStageError(null)} aria-label="Dismiss">
                          <Icon d="M6 6l12 12M18 6L6 18" size={12} />
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </Stage>
            </div>
            <div className={`fill slot${tab === 'code' ? ' shown' : ''}`}>
              <CodeView
                files={codeFiles}
                kitFiles={kitFiles}
                entry={source?.entry ?? version?.entry ?? null}
                editable={!busy && !!version}
                streaming={streamingPath}
                onEdit={onEdit}
              />
            </div>
            <div className={`fill slot${tab === 'console' ? ' shown' : ''}`}>
              <ConsoleView entries={consoleEntries} onClear={() => setConsoleEntries([])} />
            </div>
          </div>
        </section>
      </div>
    </div>
  )
}
