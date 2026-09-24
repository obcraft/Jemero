// Turns a component's files into modules the canvas can import.
//
// Small local models get the same few things wrong again and again: a hook used
// without importing it, a kit component never imported, an icon name lucide
// doesn't have, a default import of a named export, a package that isn't
// installed. Each of those is a blank canvas and a cryptic error, so they are
// repaired here, deterministically, or turned into a message the model can act
// on. Then sucrase strips the JSX (and any TypeScript), and every import is
// pointed at a local bundle (through the canvas's import map) or at another
// file of the component.

import { transform } from 'sucrase'
import { kitById, type KitId, type Manifest } from './kits'

export type StageModule = { path: string; code: string }
export type Note = { level: 'info' | 'warn'; text: string }
export type Compiled =
  | { ok: true; modules: StageModule[]; entry: string; notes: Note[]; ms: number }
  | { ok: false; error: string; path?: string; notes: Note[] }

class CompileError extends Error {
  constructor(
    message: string,
    readonly path?: string,
  ) {
    super(message)
  }
}

const SCRIPT = /\.(jsx?|tsx?|mjs)$/
const RESOLVE_EXTENSIONS = ['', '.jsx', '.js', '.tsx', '.ts', '.mjs', '.json', '.css', '/index.jsx', '/index.js', '/index.tsx', '/index.ts']

export const isScript = (path: string) => SCRIPT.test(path)

/** The file the canvas renders: the preferred one if it's still there, else the first with a default export. */
export function pickEntry(files: Record<string, string>, preferred?: string): string | null {
  if (preferred && preferred in files && isScript(preferred)) return preferred
  const scripts = Object.keys(files).filter(isScript)
  return scripts.find((p) => /\bexport\s+default\b/.test(files[p])) ?? scripts[0] ?? null
}

// --- names --------------------------------------------------------------

const REACT_CALLS = new Set([
  'useState', 'useEffect', 'useLayoutEffect', 'useMemo', 'useCallback', 'useRef', 'useId', 'useReducer',
  'useContext', 'useTransition', 'useDeferredValue', 'useImperativeHandle', 'useSyncExternalStore',
  'useOptimistic', 'useActionState', 'createContext', 'forwardRef', 'memo', 'startTransition',
  'cloneElement', 'isValidElement', 'createRef',
])
const REACT_TAGS = new Set(['Fragment', 'Suspense', 'StrictMode'])

/** Common names for icons lucide calls something else. */
const ICON_ALIASES: Record<string, string> = {
  Close: 'X', Cross: 'X', Cross1: 'X', Cross2: 'X', Cancel: 'X', Clear: 'X', Times: 'X', XMark: 'X',
  Delete: 'Trash2', Trash: 'Trash2', DeleteOutline: 'Trash2', Remove: 'Minus', Add: 'Plus', AddCircle: 'CirclePlus',
  Edit: 'Pencil', Create: 'Pencil', Done: 'Check', Tick: 'Check', CheckMark: 'Check', Checkmark: 'Check',
  ExpandMore: 'ChevronDown', ExpandLess: 'ChevronUp', ArrowDropDown: 'ChevronDown', ArrowDropUp: 'ChevronUp',
  ArrowForwardIos: 'ChevronRight', ArrowBackIos: 'ChevronLeft', NavigateNext: 'ChevronRight', NavigateBefore: 'ChevronLeft',
  ArrowForward: 'ArrowRight', ArrowBack: 'ArrowLeft', UnfoldMore: 'ChevronsUpDown', CaretSort: 'ChevronsUpDown',
  MoreVert: 'EllipsisVertical', MoreHoriz: 'Ellipsis', MoreVertical: 'EllipsisVertical', MoreHorizontal: 'Ellipsis',
  DotsVertical: 'EllipsisVertical', DotsHorizontal: 'Ellipsis', Dots: 'Ellipsis', Person: 'User', Account: 'User',
  AccountCircle: 'CircleUser', UserCircle: 'CircleUser', People: 'Users', Group: 'Users', Email: 'Mail', Envelope: 'Mail',
  Visibility: 'Eye', VisibilityOff: 'EyeOff', EyeSlash: 'EyeOff', EyeClosed: 'EyeOff', Favorite: 'Heart',
  FavoriteBorder: 'Heart', Warning: 'TriangleAlert', ExclamationTriangle: 'TriangleAlert', Error: 'CircleAlert',
  ErrorOutline: 'CircleAlert', ExclamationCircle: 'CircleAlert', InformationCircle: 'Info', Help: 'CircleHelp',
  HelpOutline: 'CircleHelp', QuestionMarkCircle: 'CircleHelp', Question: 'CircleHelp', Notifications: 'Bell',
  Notification: 'Bell', Logout: 'LogOut', Login: 'LogIn', ArrowRightOnRectangle: 'LogOut', Gear: 'Settings',
  Cog: 'Settings', Cog6Tooth: 'Settings', Hamburger: 'Menu', Bars3: 'Menu', Burger: 'Menu', Magnify: 'Search',
  MagnifyingGlass: 'Search', Filter: 'Funnel', FilterList: 'ListFilter', Sort: 'ArrowUpDown', Attach: 'Paperclip',
  Attachment: 'Paperclip', AttachFile: 'Paperclip', Photo: 'Image', Picture: 'Image', Event: 'Calendar',
  CalendarToday: 'Calendar', CalendarDays: 'Calendar', Schedule: 'Clock', Time: 'Clock', AccessTime: 'Clock',
  Location: 'MapPin', Place: 'MapPin', LocationOn: 'MapPin', Pin: 'MapPin', Call: 'Phone', Chat: 'MessageCircle',
  ChatBubble: 'MessageCircle', Message: 'MessageSquare', Comment: 'MessageSquare', Share: 'Share2', ContentCopy: 'Copy',
  Duplicate: 'Copy', Refresh: 'RefreshCw', Sync: 'RefreshCw', Reload: 'RefreshCw', ArrowPath: 'RefreshCw',
  Loader: 'LoaderCircle', Loader2: 'LoaderCircle', Spinner: 'LoaderCircle', Loading: 'LoaderCircle',
  Dashboard: 'LayoutDashboard', Grid: 'LayoutGrid', GridView: 'LayoutGrid', Squares2x2: 'LayoutGrid',
  Document: 'FileText', DocumentText: 'FileText', Description: 'FileText', Article: 'FileText', Unlock: 'LockOpen',
  LockClosed: 'Lock', Cart: 'ShoppingCart', Payment: 'CreditCard', Money: 'Banknote',
  AttachMoney: 'DollarSign', Dollar: 'DollarSign', CurrencyDollar: 'DollarSign', Chart: 'ChartColumn',
  BarChart: 'ChartColumn', ChartBar: 'ChartColumn', LineChart: 'ChartLine', PieChart: 'ChartPie', DarkMode: 'Moon',
  LightMode: 'Sun', Language: 'Languages', Public: 'Globe', FileUpload: 'Upload',
  ArrowUpTray: 'Upload', ArrowDownTray: 'Download', FileDownload: 'Download', Home: 'House',
  StarBorder: 'Star', ThumbUp: 'ThumbsUp', ThumbDown: 'ThumbsDown', PlayArrow: 'Play',
  PlayCircle: 'CirclePlay', PauseCircle: 'CirclePause', Stop: 'Square', VolumeUp: 'Volume2', VolumeOff: 'VolumeX',
  LocalOffer: 'Tag', BookmarkBorder: 'Bookmark', Print: 'Printer', CommandLine: 'Terminal', AutoAwesome: 'Sparkles',
  Bolt: 'Zap', Lightning: 'Zap', FlashOn: 'Zap', Security: 'Shield', VerifiedUser: 'ShieldCheck',
  OpenInNew: 'ExternalLink', Launch: 'ExternalLink', ArrowTopRightOnSquare: 'ExternalLink', Fullscreen: 'Maximize',
  FullscreenExit: 'Minimize', KeyboardArrowDown: 'ChevronDown', KeyboardArrowUp: 'ChevronUp',
  KeyboardArrowRight: 'ChevronRight', KeyboardArrowLeft: 'ChevronLeft', Github: 'Code', GitHub: 'Code',
}

/** The lucide icon for a name a model reached for, or null. */
export function resolveIcon(name: string, icons: Set<string>): string | null {
  if (icons.has(name)) return name
  const base = name.replace(/^Lucide/, '').replace(/Icon$/, '')
  const candidates = [base, `${base}Icon`, ICON_ALIASES[base], ICON_ALIASES[base.replace(/\d+$/, '')]]
  // lucide names shapes first: CheckCircle -> CircleCheck, AlertTriangle -> TriangleAlert.
  const words = base.match(/[A-Z][a-z]*|\d+/g) ?? []
  for (const shape of ['Circle', 'Square', 'Triangle']) {
    if (words.length > 1 && words[words.length - 1] === shape) candidates.push(shape + words.slice(0, -1).join(''))
    if (words.length > 1 && words[0] === shape) candidates.push(words.slice(1).join('') + shape)
  }
  candidates.push(base.replace(/(Outlined|Outline|Rounded|Sharp|TwoTone|Filled|Solid|Fill|Mini)$/, ''))
  candidates.push(base.replace(/\d+$/, ''))
  for (const c of candidates) if (c && icons.has(c)) return c
  return null
}

/** Icon packages that aren't installed, and how their names map onto lucide's. */
const ICON_PACKAGES: [RegExp, (name: string) => string][] = [
  [/^@mui\/icons-material(\/|$)/, (n) => n.replace(/(Outlined|Rounded|Sharp|TwoTone)$/, '')],
  [/^@heroicons\/react(\/|$)/, (n) => n.replace(/Icon$/, '')],
  [/^react-icons(\/|$)/, (n) => n.replace(/^(Fa6|Fa|Md|Fi|Hi2|Hi|Io5|Io|Bi|Ai|Bs|Ri|Tb|Lu|Gi|Go|Pi|Si|Cg|Vsc|Ti|Wi|Gr|Im|Sl|Tfi|Lia|Rx|Ci)(?=[A-Z])/, '')],
  [/^@tabler\/icons-react$/, (n) => n.replace(/^Icon/, '')],
  [/^@radix-ui\/react-icons$/, (n) => n.replace(/Icon$/, '')],
  [/^@phosphor-icons\/react$/, (n) => n.replace(/Icon$/, '')],
  [/^lucide$/, (n) => n],
]

/** Packages that are here under another name. */
const REDIRECT: Record<string, string> = {
  classnames: 'clsx',
  motion: 'motion/react',
}

/** What to use instead of a package that isn't installed. */
const INSTEAD: Record<string, string> = {
  'react-select': "the kit's own select or combobox",
  'react-router-dom': 'nothing: the canvas shows one component, there is nothing to route',
  'react-router': 'nothing: the canvas shows one component, there is nothing to route',
  next: 'plain <a> and <img> elements',
  axios: 'sample data: the canvas is offline',
  swr: 'sample data: the canvas is offline',
  '@tanstack/react-query': 'sample data: the canvas is offline',
  'styled-components': "the kit's own styling",
  '@tanstack/react-table': 'a plain table with your own sorting and filtering',
  zustand: 'useState or useReducer',
  jotai: 'useState or useReducer',
  redux: 'useState or useReducer',
  uuid: 'crypto.randomUUID()',
  nanoid: 'crypto.randomUUID()',
  'react-hook-form': 'useState',
  zod: 'plain checks',
  moment: 'date-fns',
  dayjs: 'date-fns',
  lodash: 'plain JavaScript',
  'react-datepicker': "the kit's calendar or date input",
  'embla-carousel-react': 'a scroll-snap row',
  'react-hot-toast': 'sonner',
  'react-toastify': 'sonner',
}

const packageOf = (spec: string) =>
  spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]

const pascal = (s: string) => s.replace(/(^|[-_\s]+)([a-z0-9])/gi, (_, __, c: string) => c.toUpperCase())

type Clause = { def: string | null; ns: string | null; named: { imported: string; local: string }[] }

function parseClause(clause: string): Clause {
  const named: Clause['named'] = []
  let def: string | null = null
  let ns: string | null = null
  const braces = clause.match(/\{([^}]*)\}/)
  if (braces) {
    for (const part of braces[1].split(',')) {
      const m = part.trim().match(/^(?:type\s+)?([\w$]+)(?:\s+as\s+([\w$]+))?$/)
      if (m) named.push({ imported: m[1], local: m[2] ?? m[1] })
    }
  }
  for (const piece of clause.replace(/\{[^}]*\}/, '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const star = piece.match(/^\*\s+as\s+([\w$]+)$/)
    if (star) ns = star[1]
    else if (/^[\w$]+$/.test(piece)) def = piece
  }
  return { def, ns, named }
}

function printClause({ def, ns, named }: Clause): string {
  const parts: string[] = []
  if (def) parts.push(def)
  if (ns) parts.push(`* as ${ns}`)
  if (named.length) parts.push(`{ ${named.map((n) => (n.imported === n.local ? n.local : `${n.imported} as ${n.local}`)).join(', ')} }`)
  return parts.join(', ')
}

/** Up to five exports that look like `name`, for "did you mean" messages. */
function suggest(name: string, exported: string[]): string[] {
  const lower = name.toLowerCase()
  return exported
    .filter((e) => e !== 'default')
    .map((e) => {
      const l = e.toLowerCase()
      const score = l === lower ? 0 : l.includes(lower) || lower.includes(l) ? 1 : distance(l, lower) <= 2 ? 2 : 9
      return { e, score }
    })
    .filter((x) => x.score < 9)
    .sort((a, b) => a.score - b.score || a.e.length - b.e.length)
    .slice(0, 5)
    .map((x) => x.e)
}

function distance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 2) return 9
  const row = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]
    row[0] = i
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j]
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1))
      prev = tmp
    }
  }
  return row[b.length]
}

// --- source-level repairs ---------------------------------------------

const IMPORT_STMT = /^[ \t]*import\s+([\w$*{},\s]+?)\s+from\s*['"][^'"\n]+['"];?[ \t]*$/gm
const ANY_IMPORT = /^[ \t]*import\s[^;]*?(?:from\s*)?['"][^'"\n]+['"];?[ \t]*$/gm

function boundNames(code: string): Set<string> {
  const names = new Set<string>()
  for (const m of code.matchAll(IMPORT_STMT)) {
    const c = parseClause(m[1])
    if (c.def) names.add(c.def)
    if (c.ns) names.add(c.ns)
    for (const n of c.named) names.add(n.local)
  }
  for (const m of code.matchAll(/\b(?:function\*?|class)\s+([\w$]+)/g)) names.add(m[1])
  for (const m of code.matchAll(/\b(?:const|let|var)\s+([\w$]+)/g)) names.add(m[1])
  // Destructuring: keys come along too, which only makes this more cautious.
  for (const m of code.matchAll(/\b(?:const|let|var)\s*([{[][^=;]*)=/g)) {
    for (const id of m[1].match(/[\w$]+/g) ?? []) names.add(id)
  }
  return names
}

/**
 * Drops imports the file never uses, and repeats of a name already imported.
 * Small models paste the kit's whole component list, or packages that aren't
 * here, at the top of every file; an import nothing reads can't be needed, so
 * removing it is safe and saves a failed render. `react` is left alone.
 */
function pruneUnusedImports(code: string): { code: string; dropped: string[] } {
  const body = code.replace(ANY_IMPORT, '')
  const used = (name: string) => new RegExp(`(?<![\\w$])${name.replace(/\$/g, '\\$')}(?![\\w$])`).test(body)
  const seen = new Set<string>()
  const dropped: string[] = []
  const out = code.replace(IMPORT_STMT, (stmt: string, rawClause: string) => {
    const spec = /from\s*['"]([^'"\n]+)['"]/.exec(stmt)?.[1] ?? ''
    if (spec === 'react' || spec.startsWith('.')) return stmt
    const c = parseClause(rawClause)
    const keep = (local: string | null) => {
      if (!local) return false
      if (seen.has(local) || !used(local)) {
        dropped.push(local)
        return false
      }
      seen.add(local)
      return true
    }
    const next: Clause = {
      def: keep(c.def) ? c.def : null,
      ns: keep(c.ns) ? c.ns : null,
      named: c.named.filter((n) => keep(n.local)),
    }
    if (!next.def && !next.ns && !next.named.length) return ''
    const indent = /^[ \t]*/.exec(stmt)?.[0] ?? ''
    return `${indent}import ${printClause(next)} from '${spec}'`
  })
  return { code: out, dropped }
}

/**
 * Adds the imports a file forgot: React hooks, the kit's components, lucide
 * icons. A name only counts as missing when nothing in the file binds it, so a
 * local component called Button is never shadowed by the kit's. (One bound in a
 * nested scope, like a destructured `icon: Icon` prop, shadows the import, which
 * is harmless.)
 */
function addMissingImports(
  code: string,
  candidates: Map<string, string>,
  icons: Set<string>,
): { code: string; added: string[] } {
  const bound = boundNames(code)
  const body = code.replace(ANY_IMPORT, '')
  const wanted = new Map<string, Set<string>>()
  const want = (mod: string, name: string) => {
    if (!wanted.has(mod)) wanted.set(mod, new Set())
    wanted.get(mod)!.add(name)
  }

  // Components and icons: PascalCase names read anywhere but never bound.
  for (const name of new Set(Array.from(body.matchAll(/(?<![\w$.'"`])([A-Z][\w$]*)/g), (m) => m[1]))) {
    if (bound.has(name) || name === 'React') continue
    // lucide has icons called Map, Infinity, Image, File, Text…: a built-in
    // used as a value (new Map(), x < Infinity) means the built-in. Only a tag
    // (<Map />) asks for the component.
    if (name in globalThis && !new RegExp(`<${name}[\\s/>]`).test(body)) continue
    if (REACT_TAGS.has(name)) want('react', name)
    else if (candidates.has(name)) want(candidates.get(name)!, name)
    else if (icons.has(name)) want('lucide-react', name)
  }
  // Hooks and helpers: called but never bound.
  for (const name of new Set(Array.from(body.matchAll(/(?<![\w$.])([a-z][\w$]*)\s*(?:<[^<>()]*>\s*)?\(/g), (m) => m[1]))) {
    if (bound.has(name)) continue
    if (REACT_CALLS.has(name)) want('react', name)
    else if (candidates.has(name)) want(candidates.get(name)!, name)
  }
  if (!bound.has('React') && /(?<![\w$.])React\.[A-Za-z]/.test(body)) want('react', 'default:React')

  if (!wanted.size) return { code, added: [] }
  const added: string[] = []
  const lines: string[] = []
  for (const [mod, names] of wanted) {
    const list = [...names]
    const def = list.find((n) => n.startsWith('default:'))?.slice(8)
    const named = list.filter((n) => !n.startsWith('default:')).sort()
    added.push(...(def ? [def] : []), ...named)
    const clause = [def, named.length ? `{ ${named.join(', ')} }` : ''].filter(Boolean).join(', ')
    lines.push(`import ${clause} from '${mod}'`)
  }
  const imports = code.match(ANY_IMPORT)
  if (imports?.length) {
    const last = imports[imports.length - 1]
    const at = code.lastIndexOf(last) + last.length
    return { code: `${code.slice(0, at)}\n${lines.join('\n')}${code.slice(at)}`, added }
  }
  return { code: `${lines.join('\n')}\n${code}`, added }
}

// --- compile ------------------------------------------------------------

// Statements start a line or follow a `;`: sucrase puts its jsx-runtime import
// on the first line, right before the file's own first import.
// The trailing `;` is left in place so the next statement can still match on it.
const STATIC_IMPORT = /(^|[;\n])([ \t]*)(import|export)(\s+)([\w$*{},\s]*?)(\s*from\s*)(['"])([^'"\n]+)\7/g
const SIDE_EFFECT_IMPORT = /(^|[;\n])([ \t]*)import\s*(['"])([^'"\n]+)\3/g
const DYNAMIC_IMPORT = /\bimport\s*\(\s*(['"])([^'"\n]+)\1\s*\)/g

function kitAlias(spec: string): string | null {
  const m = spec.match(/^(?:@\/|~\/|\/|(?:\.{1,2}\/)+)?(?:src\/)?(components\/ui\/[\w-]+|lib\/utils)(?:\.[jt]sx?)?$/)
  return m ? `@/${m[1]}` : null
}

function resolveRelative(from: string, spec: string, files: Record<string, string>): string | null {
  const parts = from.split('/').slice(0, -1)
  for (const part of spec.split('/')) {
    if (part === '.' || part === '') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  const joined = parts.join('/')
  for (const ext of RESOLVE_EXTENSIONS) if (joined + ext in files) return joined + ext
  return null
}

/** "Unexpected token (12:4)" plus the offending line, so the error says where. */
function syntaxMessage(path: string, source: string, err: Error): string {
  const text = err.message.replace(/^Error transforming [^:]+:\s*/, '')
  const at = text.match(/\((\d+):(\d+)\)\s*$/)
  // The parser itself fell over on badly broken code: say that, not its internals.
  if (err instanceof TypeError || /Cannot read properties of undefined/.test(text)) {
    return `Syntax error in ${path}: the file is too broken to parse (unbalanced brackets or JSX, or a cut-off line). Ask for it again.`
  }
  if (!at) return `Syntax error in ${path}: ${text}`
  const line = Number(at[1])
  const col = Number(at[2])
  const src = source.split('\n')[line - 1] ?? ''
  return `Syntax error in ${path} at line ${line}: ${text.replace(/\s*\(\d+:\d+\)\s*$/, '')}\n\n${line} | ${src}\n${' '.repeat(String(line).length + 3 + col)}^`
}

export function compile(
  files: Record<string, string>,
  entry: string,
  kitId: KitId,
  manifest: Manifest,
  {
    repair = true,
    missingPacks = {},
  }: {
    repair?: boolean
    /**
     * Specifier → pack name, for packs the catalog has but this Mac hasn't
     * installed. Their imports are refused with that name, so nothing reaches
     * the canvas before its pack is ready.
     */
    missingPacks?: Record<string, string>
  } = {},
): Compiled {
  const started = performance.now()
  const notes: Note[] = []
  const kit = kitById(kitId)
  const icons = new Set(manifest.exports['lucide-react'] ?? [])
  const candidates = new Map<string, string>()
  for (const mod of kit.autoImport(manifest)) {
    for (const name of manifest.exports[mod] ?? []) if (name !== 'default' && !candidates.has(name)) candidates.set(name, mod)
  }

  const compileFile = (path: string): { code: string; deps: string[] } => {
    const source = files[path]
    if (path.endsWith('.css')) {
      return {
        code: `globalThis.__jemeroStyle?.(${JSON.stringify(path)}, ${JSON.stringify(source)});\nexport default ${JSON.stringify(source)};\n`,
        deps: [],
      }
    }
    if (path.endsWith('.json')) {
      try {
        JSON.parse(source)
      } catch (e) {
        throw new CompileError(`${path} is not valid JSON: ${(e as Error).message}`, path)
      }
      return { code: `export default ${source};\n`, deps: [] }
    }

    let code = source
    if (repair) {
      // Only markup, no component around it (small models do this, sometimes
      // on the same line as an import): keep the imports, make the markup the Preview.
      const head = /^(?:\s*import\s[^;\n]*?from\s*['"][^'"\n]+['"];?)*/.exec(code)?.[0] ?? ''
      const bare = code.slice(head.length).trim()
      if (bare.startsWith('<') && !/^\s*export\b/m.test(bare) && !/\bfunction\b|=>/.test(bare.replace(/\{[^{}]*\}/g, ''))) {
        code = `${head.trim().replace(/;?\s*import\s/g, (m, i) => (i ? ';\nimport ' : m))}\n\nexport default function Preview() {\n  return (\n    <>\n${bare}\n    </>\n  )\n}\n`
        notes.push({ level: 'info', text: `${path}: the file was only markup; wrapped it in a Preview component` })
      } else if (path === entry && !/\bexport\s+default\b/.test(code)) {
        // A component defined but never exported: the last one is the one to show.
        const names = [...code.matchAll(/^(?:export\s+)?(?:function\s+([A-Z][\w$]*)\s*\(|const\s+([A-Z][\w$]*)\s*=)/gm)].map((m) => m[1] ?? m[2])
        const last = names.at(-1)
        if (last) {
          code = `${code.trimEnd()}\n\nexport default ${last}\n`
          notes.push({ level: 'info', text: `${path}: nothing was exported by default; exported ${last}` })
        }
      }
      const pruned = pruneUnusedImports(code)
      if (pruned.dropped.length) {
        const shown = [...new Set(pruned.dropped)]
        notes.push({ level: 'info', text: `${path}: removed unused imports: ${shown.slice(0, 8).join(', ')}${shown.length > 8 ? ` and ${shown.length - 8} more` : ''}` })
      }
      code = pruned.code
      const fixed = addMissingImports(code, candidates, icons)
      if (fixed.added.length) notes.push({ level: 'info', text: `${path}: added missing imports for ${fixed.added.join(', ')}` })
      code = fixed.code
    }

    try {
      code = transform(code, {
        transforms: ['jsx', 'typescript'],
        jsxRuntime: 'automatic',
        production: false,
        disableESTransforms: true,
        filePath: path,
      }).code
    } catch (e) {
      throw new CompileError(syntaxMessage(path, code, e as Error), path)
    }

    const deps: string[] = []

    /** Where an import should point, or null to drop it (CSS the kit already provides). */
    const target = (spec: string): string | null => {
      if (spec.startsWith('.') || spec.startsWith('/')) {
        const file = resolveRelative(path, spec, files)
        if (file) {
          deps.push(file)
          return `jemero:${file}`
        }
      }
      const alias = kitAlias(spec)
      if (alias) {
        if (manifest.imports[alias]) return alias
        const available = Object.keys(manifest.imports)
          .filter((s) => s.startsWith('@/components/ui/'))
          .map((s) => s.slice('@/components/ui/'.length))
          .sort()
        throw new CompileError(
          `${path} imports "${spec}", but there is no such kit component. ` +
            (kit.id === 'shadcn'
              ? `Build it from the ones that exist: ${available.join(', ')}.`
              : `This component uses ${kit.name}, which has no @/components/ui files.`),
          path,
        )
      }
      if (spec.startsWith('.') || spec.startsWith('/')) {
        throw new CompileError(`${path} imports "${spec}", which isn't one of the component's files (${Object.keys(files).join(', ')}).`, path)
      }
      if (spec.endsWith('.css')) return null
      return REDIRECT[spec] ?? spec
    }

    code = code.replace(SIDE_EFFECT_IMPORT, (_stmt, lead: string, indent: string, quote: string, spec: string) => {
      const t = target(spec)
      if (!t || (!t.startsWith('jemero:') && !manifest.imports[t])) return lead
      return `${lead}${indent}import ${quote}${t}${quote}`
    })

    code = code.replace(
      STATIC_IMPORT,
      (_stmt, lead: string, ind: string, keyword: string, gap: string, rawClause: string, from: string, quote: string, spec: string) => {
        const indent = lead + ind
        const clause = parseClause(rawClause)
        const reexportAll = keyword === 'export' && rawClause.trim() === '*'

        // Icon packages that aren't installed: the same icons, from lucide.
        const iconPkg = ICON_PACKAGES.find(([re]) => re.test(spec))
        if (iconPkg && repair) {
          const deep = spec.split('/').pop() ?? ''
          const out: Clause = { def: null, ns: clause.ns, named: [] }
          const mapOne = (wantedName: string, local: string) => {
            const icon = resolveIcon(iconPkg[1](wantedName), icons) ?? resolveIcon(wantedName, icons)
            const chosen = icon ?? (icons.has('CircleHelp') ? 'CircleHelp' : 'Circle')
            if (!icon) notes.push({ level: 'warn', text: `${path}: no lucide icon for ${wantedName}; showing ${chosen}` })
            out.named.push({ imported: chosen, local })
          }
          if (clause.def) mapOne(pascal(deep), clause.def)
          for (const n of clause.named) mapOne(n.imported, n.local)
          notes.push({ level: 'info', text: `${path}: ${packageOf(spec)} isn't installed, used lucide-react icons instead` })
          return `${indent}${keyword}${gap}${printClause(out)}${from}${quote}lucide-react${quote}`
        }

        const t = target(spec)
        if (!t) return lead
        if (t.startsWith('jemero:')) return `${indent}${keyword}${gap}${rawClause}${from}${quote}${t}${quote}`

        let mod = t
        const out: Clause = { def: clause.def, ns: clause.ns, named: [...clause.named] }

        // A deep import from a package that is here: '@mui/material/Button' -> { Button } from '@mui/material'.
        if (!manifest.imports[mod]) {
          const root = Object.keys(manifest.imports)
            .filter((s) => mod.startsWith(`${s}/`))
            .sort((a, b) => b.length - a.length)[0]
          if (root && repair) {
            const last = mod.slice(root.length + 1).split('/').pop() ?? ''
            const exported = manifest.exports[root] ?? []
            if (out.def) {
              const name = [last, pascal(last), pascal(last).charAt(0).toLowerCase() + pascal(last).slice(1)].find((n) =>
                exported.includes(n),
              )
              if (!name) throw new CompileError(`${path}: "${spec}" isn't available, and ${root} has no export called ${last}.`, path)
              out.named.push({ imported: name, local: out.def })
              out.def = null
            }
            notes.push({ level: 'info', text: `${path}: rewrote "${spec}" as an import from "${root}"` })
            mod = root
          } else {
            const pkg = packageOf(mod)
            // Kit components imported from a package that isn't here ('shadcn',
            // '@radix-ui/react-button', …): point each name at the kit module that has it.
            const homes = repair && !out.def && !out.ns && out.named.length ? out.named.map((n) => candidates.get(n.imported)) : []
            if (homes.length && homes.every(Boolean)) {
              const byHome = new Map<string, { imported: string; local: string }[]>()
              out.named.forEach((n, i) => byHome.set(homes[i]!, [...(byHome.get(homes[i]!) ?? []), n]))
              notes.push({ level: 'info', text: `${path}: "${spec}" isn't installed; took ${out.named.map((n) => n.imported).join(', ')} from the kit` })
              return [...byHome]
                .map(([home, named]) => `${indent}${keyword}${gap}${printClause({ def: null, ns: null, named })}${from}${quote}${home}${quote}`)
                .join('\n')
            }
            const pack = missingPacks[mod] ?? missingPacks[pkg]
            if (pack) {
              throw new CompileError(
                `${path} imports "${mod}" from the ${pack} pack, which isn't installed. Install it in Resources, or build it without ${pack}.`,
                path,
              )
            }
            const instead = INSTEAD[mod] ?? INSTEAD[pkg]
            throw new CompileError(
              `${path} imports "${pkg}", which isn't installed, and the canvas is offline.` +
                (instead ? ` Use ${instead} instead.` : ` Use only what the ${kit.name} kit lists.`),
              path,
            )
          }
        }

        const exported = manifest.exports[mod] ?? []
        const has = new Set(exported)

        // `import Button from '@/components/ui/button'`: it's a named export.
        if (out.def && !has.has('default')) {
          const base = mod.split('/').pop() ?? ''
          const name = [out.def, pascal(base)].find((n) => has.has(n))
          if (!name || !repair) {
            const like = suggest(out.def, exported)[0] ?? '…'
            throw new CompileError(`${path}: "${mod}" has no default export. Import it by name: import { ${like} } from '${mod}'.`, path)
          }
          out.named.unshift({ imported: name, local: out.def })
          out.def = null
          notes.push({ level: 'info', text: `${path}: ${mod} has no default export, imported { ${name} } instead` })
        }

        // A name imported from the wrong module of the kit ({ InputOTP } from
        // '@/components/ui/input'): move it to the module that exports it.
        const moved = new Map<string, { imported: string; local: string }[]>()
        out.named = out.named.flatMap((n) => {
          if (has.has(n.imported)) return [n]
          const home = candidates.get(n.imported)
          if (repair && home && home !== mod) {
            moved.set(home, [...(moved.get(home) ?? []), n])
            notes.push({ level: 'info', text: `${path}: ${n.imported} comes from "${home}", not "${mod}"; moved it` })
            return []
          }
          if (mod === 'lucide-react' && repair) {
            const icon = resolveIcon(n.imported, icons)
            const chosen = icon ?? (icons.has('CircleHelp') ? 'CircleHelp' : 'Circle')
            notes.push({
              level: icon ? 'info' : 'warn',
              text: icon
                ? `${path}: lucide calls ${n.imported} “${icon}”, used that`
                : `${path}: lucide has no ${n.imported} icon; showing ${chosen}. Name a real one when you refine.`,
            })
            return [{ imported: chosen, local: n.local }]
          }
          const like = suggest(n.imported, exported)
          throw new CompileError(
            `${path}: "${mod}" has no export called ${n.imported}.` + (like.length ? ` Did you mean ${like.join(', ')}?` : ''),
            path,
          )
        })

        const foreign = mod.startsWith('@/components/ui/') && kit.id !== 'shadcn'
        if (foreign) notes.push({ level: 'warn', text: `${path} imports ${mod}, but this component uses ${kit.name}; it may not render right.` })

        if (reexportAll) return `${indent}export * from ${quote}${mod}${quote}`
        const extra = [...moved].map(
          ([home, named]) => `${indent}${keyword}${gap}${printClause({ def: null, ns: null, named })}${from}${quote}${home}${quote}`,
        )
        const kept = out.def || out.ns || out.named.length ? [`${indent}${keyword}${gap}${printClause(out)}${from}${quote}${mod}${quote}`] : []
        return [...kept, ...extra].join('\n')
      },
    )

    code = code.replace(DYNAMIC_IMPORT, (_stmt, quote: string, spec: string) => {
      const t = target(spec)
      return t ? `import(${quote}${t}${quote})` : 'Promise.resolve({})'
    })

    return { code, deps }
  }

  try {
    // Depth-first from the entry, so the canvas gets dependencies before their importers.
    const compiled = new Map<string, string>()
    const order: string[] = []
    const state = new Map<string, 'visiting' | 'done'>()
    const visit = (path: string, chain: string[]) => {
      const seen = state.get(path)
      if (seen === 'done') return
      if (seen === 'visiting') throw new CompileError(`Circular import: ${[...chain, path].join(' → ')}`, path)
      state.set(path, 'visiting')
      const mod = compileFile(path)
      compiled.set(path, mod.code)
      for (const dep of mod.deps) visit(dep, [...chain, path])
      state.set(path, 'done')
      order.push(path)
    }
    visit(entry, [])
    return {
      ok: true,
      entry,
      modules: order.map((path) => ({ path, code: compiled.get(path)! })),
      notes,
      ms: Math.round(performance.now() - started),
    }
  } catch (e) {
    if (e instanceof CompileError) return { ok: false, error: e.message, path: e.path, notes }
    return { ok: false, error: (e as Error).message, notes }
  }
}
