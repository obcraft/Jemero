import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Modal from './Modal'
import {
  available,
  bridge,
  cachedSnapshot,
  formatGB,
  loadSnapshot,
  setPriority,
  watchSnapshot,
  type CatalogSnapshot,
  type ModelPlan,
  type Progress,
} from '../lib/models'
import { useSettings } from '../lib/settings'

type View = 'fits' | 'downloaded' | 'all'

const VIEWS: { id: View; label: string }[] = [
  { id: 'fits', label: 'For this Mac' },
  { id: 'downloaded', label: 'Downloaded' },
  { id: 'all', label: 'All' },
]

/**
 * Pick a model. One line per model: name, speed, size, one button.
 * The detail (why it fits, quantization maths) lives in `npm run models`
 * for anyone who wants it; this view is for choosing.
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
    const q = query.trim().toLowerCase()
    const rows = (snap?.models ?? []).filter((m) => {
      if (view === 'fits' && !m.fits) return false
      if (view === 'downloaded' && !downloaded.has(m.modelId) && !partial.has(m.modelId)) return false
      return !q || `${m.label} ${m.quant}`.toLowerCase().includes(q)
    })
    // Serving first, then the recommendation, then the rest in catalog order.
    const rank = (m: ModelPlan) => (m.modelId === snap?.active ? 0 : m.modelId === snap?.recommended ? 1 : 2)
    return rows.sort((a, b) => rank(a) - rank(b))
  }, [snap, view, query, downloaded, partial])

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Models"
      subtitle={snap ? `${snap.device.chip.replace('Apple ', '')} · ${snap.device.ramGB} GB` : undefined}
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
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search" spellCheck={false} />
            </div>
          </div>

          {error && <div className="banner bad">{error}</div>}

          <div className="model-list">
            {list.map((m) => (
              <ModelRow
                key={m.modelId}
                model={m}
                recommended={m.modelId === snap.recommended}
                active={m.modelId === snap.active}
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
            ))}
            {!list.length && <p className="note">Nothing here.</p>}
          </div>
        </>
      )}
    </Modal>
  )
}

function ModelRow({
  model,
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
  if (!model.fits) action = <span className="row-note">Too big</span>
  else if (active) action = <span className="row-note ok">In use</span>
  else if (busy)
    action = (
      <button className="btn ghost" onClick={onCancel}>
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
          <strong>{model.label}</strong>
          {recommended && !active && <span className="chip">Best</span>}
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
