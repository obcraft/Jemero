// The canvas. It runs in a sandboxed iframe with an opaque origin, so the code
// it renders can't reach the app, its storage or the model bridge.
//
// The app compiles a component (src/lib/compile.ts) and posts its modules here.
// They're imported as blob modules through the import map in stage.html, which
// points every kit package at a local bundle, so nothing is installed and
// nothing leaves the machine. The default export is what gets rendered; an
// optional `variants` export adds named states to review. Errors, console output
// and form submissions are reported back to the app.
import React from 'react'
import { createRoot } from 'react-dom/client'

const h = React.createElement
const html = document.documentElement
const mount = document.getElementById('jm-root')

/** Id of the render request being handled; replies carry it so stale ones are dropped. */
let seq = 0
let options = { theme: 'light', layout: 'center', bg: 'dots', variant: null }
/** { Wrap, Preview, variants } for the component on screen. */
let current = null
let root = null
let kit = null
let kitReady = null
/** Bumped by "reset" to remount the component with fresh state. */
let nonce = 0

const post = (msg) => {
  try {
    parent.postMessage({ __jemero: 'stage', ...msg }, '*')
  } catch {
    /* unclonable payload: nothing useful to send */
  }
}

// --- console -------------------------------------------------------------

function show(value) {
  if (typeof value === 'string') return value
  if (value instanceof Error) return value.stack || `${value.name}: ${value.message}`
  if (typeof value === 'function') return `ƒ ${value.name || 'anonymous'}()`
  if (typeof value === 'symbol' || typeof value === 'bigint') return String(value)
  if (value === undefined) return 'undefined'
  if (typeof Node !== 'undefined' && value instanceof Node) return `<${value.nodeName.toLowerCase()}>`
  try {
    const seen = new WeakSet()
    const text = JSON.stringify(value, (_key, v) => {
      if (typeof v === 'function') return `ƒ ${v.name || 'anonymous'}()`
      if (typeof v === 'bigint') return `${v}n`
      // Selection state is often a Set or a Map, which JSON prints as {}.
      if (v instanceof Set) return [...v]
      if (v instanceof Map) return Object.fromEntries(v)
      if (typeof v === 'object' && v !== null) {
        if (seen.has(v)) return '[Circular]'
        seen.add(v)
        if (typeof Node !== 'undefined' && v instanceof Node) return `<${v.nodeName.toLowerCase()}>`
      }
      return v
    })
    return text.length > 4000 ? `${text.slice(0, 4000)}…` : text
  } catch {
    return String(value)
  }
}

/** console.* semantics, including the %s substitutions React's warnings use. */
function format(args) {
  if (typeof args[0] === 'string' && /%[sdifoOc]/.test(args[0])) {
    let i = 1
    const head = args[0].replace(/%([sdifoOc%])/g, (match, type) => {
      if (type === '%') return '%'
      if (i >= args.length) return match
      const value = args[i++]
      if (type === 'c') return ''
      if (type === 'd' || type === 'i') return String(parseInt(value, 10))
      if (type === 'f') return String(Number(value))
      return show(value)
    })
    args = [head, ...args.slice(i)]
  }
  return args.map(show).join(' ')
}

for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
  const original = console[level].bind(console)
  console[level] = (...args) => {
    original(...args)
    post({ type: 'console', level, text: format(args) })
  }
}

// Modal dialogs are blocked by the sandbox (and would freeze the app if they
// weren't), so they become console lines instead.
window.alert = (message) => console.info(`alert(): ${message ?? ''}`)
window.confirm = (message) => {
  console.info(`confirm(): ${message ?? ''} → true`)
  return true
}
window.prompt = (message, fallback) => {
  console.info(`prompt(): ${message ?? ''} → ${fallback ?? ''}`)
  return fallback ?? ''
}

// --- navigation ----------------------------------------------------------
// A real link or form submit would navigate the canvas away from the component.
// React's handlers run first (they're attached lower, at the root), so anything
// the component already handled is left alone.

document.addEventListener('click', (e) => {
  const a = e.target instanceof Element ? e.target.closest('a[href]') : null
  if (!a || e.defaultPrevented) return
  const href = a.getAttribute('href') || ''
  if (!href || href.startsWith('#')) return
  e.preventDefault()
  console.info(`Link to ${href} (navigation is off on the canvas)`)
})

// Navigation from script (location.href = …) can't be cancelled from in here:
// the canvas has an opaque origin, which gets no navigate events. The host
// notices the frame loading another page and puts the canvas back
// (src/components/Stage.tsx).

window.addEventListener('submit', (e) => {
  if (e.defaultPrevented) return
  e.preventDefault()
  let data = {}
  try {
    data = Object.fromEntries(new FormData(e.target))
  } catch {
    /* not a form element */
  }
  console.info('Form submitted', data)
})

// --- errors --------------------------------------------------------------

const errorOf = (err) => ({
  message: err instanceof Error ? err.message : String(err),
  stack: err instanceof Error ? err.stack || '' : '',
})

window.addEventListener('error', (e) => post({ type: 'error', kind: 'runtime', seq, ...errorOf(e.error ?? e.message) }))
window.addEventListener('unhandledrejection', (e) => post({ type: 'error', kind: 'runtime', seq, ...errorOf(e.reason) }))

function ErrorBox({ title, message }) {
  return h('div', { className: 'jm-error', role: 'alert' }, h('strong', null, title), message)
}

class Boundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }
  static getDerivedStateFromError(error) {
    return { error }
  }
  render() {
    if (!this.state.error) return this.props.children
    return h(ErrorBox, { title: 'This component crashed while rendering', message: errorOf(this.state.error).message })
  }
}

// --- kits ----------------------------------------------------------------

const TAILWIND_KITS = new Set(['shadcn', 'tailwind'])

const loadScript = (src) =>
  new Promise((resolve, reject) => {
    const el = document.createElement('script')
    el.src = src
    el.onload = resolve
    el.onerror = () => reject(new Error(`Could not load ${src}`))
    document.head.appendChild(el)
  })

const Passthrough = ({ children }) => children

/** Global CSS and the provider a kit's components expect, loaded once per canvas. */
async function loadKit(id) {
  if (TAILWIND_KITS.has(id)) {
    const css = await fetch('./tailwind-theme.css').then((r) => r.text())
    const style = document.createElement('style')
    style.type = 'text/tailwindcss'
    style.textContent = css
    document.head.appendChild(style)
    await loadScript('./tailwind.js')
    return Passthrough
  }
  return Passthrough
}

// --- rendering -----------------------------------------------------------

// --- pack styles ---------------------------------------------------------

const linkedStyles = new Set()

/**
 * A pack's stylesheets (KaTeX's fonts and layout, say) load the first time a
 * component imports one of its modules. The URLs come from the import map
 * setup in stage.html, which only accepted verified local pack files.
 */
function linkPackStyles(modules) {
  const styles = window.__jemeroPackStyles || {}
  const specs = Object.keys(styles)
  if (!specs.length) return Promise.resolve()
  const loads = []
  for (const m of modules) {
    for (const spec of specs) {
      const quoted = new RegExp(`(?:from\\s*|import\\s*\\(?\\s*)["']${spec.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}["']`)
      if (!quoted.test(m.code)) continue
      for (const href of styles[spec]) {
        if (linkedStyles.has(href)) continue
        linkedStyles.add(href)
        const link = document.createElement('link')
        link.rel = 'stylesheet'
        link.href = href
        loads.push(new Promise((resolve) => ((link.onload = resolve), (link.onerror = resolve))))
        document.head.appendChild(link)
      }
    }
  }
  return Promise.all(loads)
}

/** Modules arrive dependency-first; relative imports point at "jemero:<path>". */
async function importModules(modules, entry) {
  await linkPackStyles(modules)
  const urls = {}
  for (const m of modules) {
    const code = m.code.replace(/(["'])jemero:([^"']+)\1/g, (match, quote, path) =>
      urls[path] ? `${quote}${urls[path]}${quote}` : match,
    )
    urls[m.path] = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }))
  }
  try {
    return await import(urls[entry])
  } finally {
    // Imported (or failed) means fetched: the module map holds them from here.
    for (const url of Object.values(urls)) URL.revokeObjectURL(url)
  }
}

const isComponent = (v) => typeof v === 'function' || (typeof v === 'object' && v !== null && '$$typeof' in v)

function pickPreview(mod) {
  if (isComponent(mod.default)) return React.isValidElement(mod.default) ? () => mod.default : mod.default
  // No default export: render the first exported component, bare.
  const named = Object.entries(mod).find(([name, v]) => /^[A-Z]/.test(name) && isComponent(v))
  if (!named) return null
  console.warn(`No default export, so the canvas renders <${named[0]} /> with no props.`)
  return named[1]
}

function pickVariants(mod) {
  const v = mod.variants
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const entries = Object.entries(v).filter(([, x]) => isComponent(x) || React.isValidElement(x))
  return entries.length ? Object.fromEntries(entries) : null
}

const asElement = (v) => (React.isValidElement(v) ? v : h(v))

function apply() {
  html.classList.toggle('dark', options.theme === 'dark')
  html.dataset.layout = options.layout
  html.dataset.bg = options.bg
}

function paint() {
  if (!current || !root) return
  const { Wrap, Preview, variants } = current
  const { variant } = options
  let body
  if (variant === '*' && variants) {
    body = h(
      'div',
      { className: 'jm-grid' },
      Object.entries(variants).map(([name, v]) =>
        h('section', { key: name, className: 'jm-cell' }, h('div', { className: 'jm-label' }, name), h(Boundary, null, asElement(v))),
      ),
    )
  } else if (variant && variants?.[variant]) {
    body = h(Boundary, null, asElement(variants[variant]))
  } else {
    body = h(Boundary, null, h(Preview))
  }
  // Keyed on the request and the reset counter: new code or "reset" remounts
  // the component (fresh state, cleared error), a theme flip does not.
  root.render(h(Wrap, { theme: options.theme }, h(React.Fragment, { key: `${seq}:${nonce}:${variant ?? ''}` }, body)))
}

function reportRenderError(error, info) {
  post({
    type: 'error',
    kind: 'render',
    seq,
    ...errorOf(error),
    componentStack: info?.componentStack ?? '',
  })
}

async function render(msg) {
  const id = msg.seq
  seq = id
  if (msg.options) options = { ...options, ...msg.options }
  apply()
  const started = performance.now()
  try {
    if (!kitReady) {
      kit = msg.kit
      kitReady = loadKit(msg.kit)
    } else if (msg.kit !== kit) {
      console.warn(`The canvas was set up for ${kit}; reload it to switch to ${msg.kit}.`)
    }
    const Wrap = await kitReady
    const mod = await importModules(msg.modules, msg.entry)
    if (id !== seq) return
    const Preview = pickPreview(mod)
    if (!Preview) throw new Error('Nothing to render: the file has no default export. Add `export default function Preview() { … }`.')
    const variants = pickVariants(mod)
    current = { Wrap, Preview, variants }
    if (options.variant && options.variant !== '*' && !variants?.[options.variant]) options.variant = null
    root ??= createRoot(mount, {
      onCaughtError: reportRenderError,
      onUncaughtError: reportRenderError,
      onRecoverableError: (error) => console.warn(errorOf(error).message),
    })
    paint()
    post({
      type: 'rendered',
      seq: id,
      ms: Math.round(performance.now() - started),
      variants: variants ? Object.keys(variants) : [],
    })
  } catch (err) {
    if (id !== seq) return
    post({ type: 'error', kind: 'import', seq: id, ...errorOf(err) })
    current = null
    root?.unmount()
    root = null
    mount.replaceChildren()
    const box = document.createElement('div')
    box.className = 'jm-error'
    box.innerHTML = '<strong>This component could not be loaded</strong>'
    box.append(errorOf(err).message)
    mount.appendChild(box)
  }
}

window.addEventListener('message', (e) => {
  if (e.source !== parent) return
  const msg = e.data
  if (!msg || msg.__jemero !== 'host') return
  if (msg.type === 'render') void render(msg)
  else if (msg.type === 'options') {
    options = { ...options, ...msg.options }
    apply()
    paint()
  } else if (msg.type === 'reset') {
    nonce++
    paint()
  } else if (msg.type === 'clear') {
    // Nothing to show: the last component stops too, timers and logs included.
    seq = msg.seq
    current = null
    root?.unmount()
    root = null
    mount.replaceChildren()
  }
})

apply()
post({ type: 'ready' })
