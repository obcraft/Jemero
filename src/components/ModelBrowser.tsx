import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Modal from './Modal'
import {
  available,
  bridge,
  cachedSearch,
  cachedSnapshot,
  formatGB,
  loadSnapshot,
  matchesQuery,
  searchHub,
  setPriority,
  watchSnapshot,
  type CatalogSnapshot,
  type ModelPlan,
  type Priority,
  type Progress,
  type SearchResult,
} from '../lib/models'
import { useSettings } from '../lib/settings'

type View = 'fits' | 'downloaded' | 'all'

const VIEWS: { id: View; label: string }[] = [
  { id: 'fits', label: 'For this Mac' },
  { id: 'downloaded', label: 'Downloaded' },
  { id: 'all', label: 'All' },
]

/** Shorter than this, a query matches half of Hugging Face. */
const MIN_QUERY = 2
/** How long typing has to pause before the network is asked. */
const DEBOUNCE_MS = 350

type Hub = { status: 'done' | 'loading' | 'error'; results: ModelPlan[]; reason?: string }

const IDLE: Hub = { status: 'done', results: [] }
const toHub = (res: SearchResult): Hub =>
  res.ok ? { status: 'done', results: res.results } : { status: 'error', results: [], reason: res.reason }

/**
 * Hugging Face results for `query`, debounced. While a new query loads, the
 * previous results stay up (dimmed) rather than the list collapsing per keystroke.
 */
function useHubSearch(query: string, priority: Priority): Hub {
  const q = query.trim()
  const [hub, setHub] = useState<Hub>(IDLE)
  useEffect(() => {
    if (q.length < MIN_QUERY) return setHub(IDLE)
    const hit = cachedSearch(q, priority)
    if (hit) return setHub(toHub(hit))
    setHub((h) => ({ status: 'loading', results: h.results }))
    let live = true
    const timer = setTimeout(() => {
      searchHub(q, priority)
        .catch((e: Error): SearchResult => ({ ok: false, reason: e.message }))
        .then((res) => live && setHub(toHub(res)))
    }, DEBOUNCE_MS)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [q, priority])
  return hub
}

/**
 * Pick a model. One line per model: name, speed, size, one button. The curated
 * catalog is always here; typing searches Hugging Face as well, for anything
 * the catalog doesn't carry (a Gemma, a Llama, a Phi…), sized for this Mac the
 * same way. The detail (why it fits, quantization maths) lives in
 * `npm run models` for anyone who wants it; this view is for choosing.
 */
export default function ModelBrowser({
  open,
  onClose,
  onActive,
}: {
  open: boolean
  onClose: () => void
  onActive: (id: string) => void
}) {
  const [snap, setSnap] = useState<CatalogSnapshot | null>(cachedSnapshot)
  const [progress, setProgress] = useState<Record<string, Progress>>({})
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [view, setView] = useState<View>('fits')
  const { modelPriority } = useSettings()
  const searchInput = useRef<HTMLInputElement>(null)

  useEffect(() => setPriority(modelPriority), [modelPriority])

  const sync = useCallback(() => setSnap(cachedSnapshot()), [])

  // Downloads started from here are downloads the user wants to *use*: when
  // one finishes, start it and close this panel, so Get lands in the chat.
  const useWhenReady = useRef(new Set<string>())

  // The parent passes fresh closures every render; reading them through refs
  // keeps the subscription below from re-running (and re-reading the catalog
  // from disk) each time the app re-renders.
  const onActiveRef = useRef(onActive)
  const onCloseRef = useRef(onClose)
  onActiveRef.current = onActive
  onCloseRef.current = onClose

  useEffect(() => {
    if (!open) return
    void loadSnapshot(true)
    const stopWatch = watchSnapshot(sync)
    const stopProgress = bridge()?.onProgress((p) => {
      setProgress((prev) => ({ ...prev, [p.id]: p }))
      if (p.phase === 'error' && p.message) setError(p.message)
      if (p.phase === 'done' && useWhenReady.current.delete(p.id)) {
        void bridge()?.activate(p.id).then((r) => r && !r.ok && r.reason && setError(r.reason))
      }
      if (p.phase === 'active') {
        onActiveRef.current(p.id)
        onCloseRef.current()
      }
    })
    return () => {
      stopWatch()
      stopProgress?.()
    }
  }, [open, sync])

  // Finding a model is what this panel is for, so the search has the focus.
  // A frame late, after the dialog has taken focus for itself.
  const ready = open && !!snap
  useEffect(() => {
    if (!ready) return
    const id = requestAnimationFrame(() => searchInput.current?.focus())
    return () => cancelAnimationFrame(id)
  }, [ready])

  const downloaded = useMemo(
    () => new Set((snap?.installed ?? []).filter((m) => m.complete).map((m) => m.id)),
    [snap],
  )
  const partial = useMemo(
    () => new Set((snap?.installed ?? []).filter((m) => !m.complete).map((m) => m.id)),
    [snap],
  )

  const run = async (call: () => Promise<{ ok: boolean; reason?: string }> | undefined) => {
    setError(null)
    const res = await call()
    if (res && !res.ok && res.reason) setError(res.reason)
  }

  const list = useMemo(() => {
    const rows = (snap?.models ?? []).filter((m) => {
      if (view === 'fits' && !m.fits) return false
      if (view === 'downloaded' && !downloaded.has(m.modelId) && !partial.has(m.modelId)) return false
      return matchesQuery(m, query)
    })
    // Serving first, then the recommendation, then the rest in catalog order.
    const rank = (m: ModelPlan) => (m.modelId === snap?.active ? 0 : m.modelId === snap?.recommended ? 1 : 2)
    return rows.sort((a, b) => rank(a) - rank(b))
  }, [snap, view, query, downloaded, partial])

  // Hugging Face only adds what isn't listed above, filtered the same way.
  const searching = available() && query.trim().length >= MIN_QUERY && view !== 'downloaded'
  const hub = useHubSearch(searching ? query : '', modelPriority)
  const listed = useMemo(() => new Set((snap?.models ?? []).map((m) => m.repo)), [snap])
  const found = hub.results.filter((m) => !listed.has(m.repo))
  const hubRows = view === 'fits' ? found.filter((m) => m.fits) : found
  const tooBig = found.length - hubRows.length
  const hubEmpty = hub.status === 'done' && !hubRows.length
  const q = query.trim()

  const row = (m: ModelPlan) => (
    <ModelRow
      key={m.modelId}
      model={m}
      budgetGB={snap?.device.budgetGB ?? 0}
      recommended={m.modelId === snap?.recommended}
      active={m.modelId === snap?.active}
      downloaded={downloaded.has(m.modelId)}
      partial={partial.has(m.modelId)}
      progress={progress[m.modelId]}
      onGet={() => {
        useWhenReady.current.add(m.modelId)
        return run(() => bridge()?.install(m.modelId))
      }}
      onUse={() => run(() => bridge()?.activate(m.modelId))}
      onCancel={() => void bridge()?.cancelInstall(m.modelId)}
      onDelete={() => run(() => bridge()?.remove(m.modelId)).then(() => loadSnapshot(true))}
    />
  )

  const controls = (
    <div className="browser-controls">
      <div className="segmented tight">
        {VIEWS.map((v) => (
          <button key={v.id} className={view === v.id ? 'seg active' : 'seg'} onClick={() => setView(v.id)}>
            {v.label}
          </button>
        ))}
      </div>
      <div className="search">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
          <circle cx="11" cy="11" r="7" />
          <path d="M20 20l-3.6-3.6" />
        </svg>
        <input
          ref={searchInput}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search any model, like gemma 1b"
          spellCheck={false}
          aria-label="Search models"
        />
        {query && (
          <button
            className="search-clear"
            onClick={() => {
              setQuery('')
              searchInput.current?.focus()
            }}
            aria-label="Clear search"
          >
            <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        )}
      </div>
    </div>
  )

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Models"
      subtitle={snap ? `${snap.device.chip.replace('Apple ', '')} · ${snap.device.ramGB} GB` : undefined}
      toolbar={available() && snap ? controls : undefined}
      tall={available()}
    >
      {!available() ? (
        <p className="note">Open the Mac app to manage models.</p>
      ) : !snap ? (
        <div className="skeleton-list">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="skeleton-row" />
          ))}
        </div>
      ) : (
        <>
          {error && <div className="banner bad">{error}</div>}

          <div className="model-list">
            {list.map(row)}

            {!list.length && !searching && (
              <p className="note list-note">
                {q
                  ? `No ${view === 'downloaded' ? 'downloaded ' : ''}model matches “${q}”.`
                  : view === 'downloaded'
                    ? 'Nothing downloaded yet.'
                    : 'Nothing in the catalog fits this Mac. Search for a smaller model.'}
              </p>
            )}

            {searching && !(hubEmpty && list.length) && (
              <section className="hub-results" aria-busy={hub.status === 'loading'}>
                <div className="list-heading">
                  On Hugging Face
                  {hub.status === 'loading' && <span className="menu-spinner" aria-label="Searching" />}
                </div>
                {hub.status === 'error' ? (
                  <p className="note list-note">{hub.reason}</p>
                ) : hub.status === 'loading' && !hubRows.length ? (
                  <div className="skeleton-list">
                    <div className="skeleton-row" />
                    <div className="skeleton-row" />
                  </div>
                ) : (
                  <div className={hub.status === 'loading' ? 'stale' : undefined}>{hubRows.map(row)}</div>
                )}
                {hubEmpty && !tooBig && <p className="note list-note">No chat model matches “{q}”.</p>}
                {hub.status === 'done' && tooBig > 0 && (
                  <p className="list-foot">
                    {tooBig === 1 ? 'One more match doesn’t' : `${tooBig} more matches don’t`} fit this Mac.{' '}
                    <button className="text-btn" onClick={() => setView('all')}>
                      Show
                    </button>
                  </p>
                )}
              </section>
            )}
          </div>
        </>
      )}
    </Modal>
  )
}

function ModelRow({
  model,
  budgetGB,
  recommended,
  active,
  downloaded,
  partial,
  progress,
  onGet,
  onUse,
  onCancel,
  onDelete,
}: {
  model: ModelPlan
  budgetGB: number
  recommended: boolean
  active: boolean
  downloaded: boolean
  partial: boolean
  progress?: Progress
  onGet: () => void
  onUse: () => void
  onCancel: () => void
  onDelete: () => void
}) {
  const busy = !!progress && ['downloading', 'resuming', 'verifying', 'installing', 'activating'].includes(progress.phase)
  const pct = progress?.total ? Math.min(100, ((progress.received ?? 0) / progress.total) * 100) : 0

  let action
  if (!model.fits)
    action =
      model.limit === 'context' ? (
        <span className="row-note" title={`Its context window is ${model.maxCtx.toLocaleString()} tokens; Jemero needs 16k.`}>
          {Math.round(model.maxCtx / 1024)}k context
        </span>
      ) : (
        <span className="row-note" title={`Needs about ${formatGB(model.needsGB)}; this Mac can give a model ${formatGB(budgetGB)}.`}>
          Too big
        </span>
      )
  else if (active) action = <span className="row-note ok">In use</span>
  else if (busy)
    action = (
      <button className="btn ghost" onClick={onCancel} title="Stop the download">
        {progress?.phase === 'activating'
          ? 'Starting…'
          : progress?.phase === 'verifying' || progress?.phase === 'installing'
            ? 'Checking…'
            : `${pct.toFixed(0)}%`}
      </button>
    )
  else if (downloaded) action = <button className="btn" onClick={onUse}>Use</button>
  // Only the recommendation gets a filled button; a column of identical
  // purple buttons is noise, not guidance.
  else
    action = (
      <button className={recommended ? 'btn' : 'btn ghost'} onClick={onGet}>
        {partial ? 'Resume' : 'Get'}
      </button>
    )

  return (
    <div className={`model-row${active ? ' active' : ''}${model.fits ? '' : ' unfit'}`}>
      <div className="row-main">
        <div className="row-name">
          <strong title={model.label}>{model.label}</strong>
          {recommended && !active && <span className="chip">Best</span>}
          {model.source === 'hub' && (
            <a
              className="row-by"
              href={`https://huggingface.co/${model.repo}`}
              target="_blank"
              rel="noreferrer"
              title={`${model.repo} on Hugging Face`}
            >
              {model.author}
            </a>
          )}
        </div>
        <div className="row-meta">
          {model.tokensPerSec} tok/s · {formatGB(model.sizeGB)}
          <span className="row-quant">{model.quant}</span>
        </div>
      </div>
      <div className="row-actions">
        {downloaded && !active && !busy && (
          <button className="icon-btn" onClick={onDelete} title="Delete download" aria-label="Delete download">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" />
            </svg>
          </button>
        )}
        {action}
      </div>
      {busy && progress?.phase !== 'activating' && (
        <div className="row-progress">
          <div className="row-progress-fill" style={{ width: `${pct}%` }} />
        </div>
      )}
    </div>
  )
}
