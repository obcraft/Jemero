import { useCallback, useEffect, useRef, useState } from 'react'
import { bridge } from '../lib/models'
import { isLocalPack, type CatalogEntry, type PackList, type PackProgress } from '../lib/packs'

const fmt = (bytes: number) =>
  bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : bytes >= 1024 ** 2 ? `${(bytes / 1024 ** 2).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`

/**
 * Packs: what the canvas can use beyond the built-in kit, installed once so it
 * works offline. Online-only services are listed apart, marked as such.
 */
export default function ResourcesPage({ onClose }: { onClose: () => void }) {
  const [list, setList] = useState<PackList | null>(null)
  const [progress, setProgress] = useState<Record<string, PackProgress>>({})
  const [errors, setErrors] = useState<Record<string, string>>({})
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  const refresh = useCallback(async () => {
    const api = bridge()
    if (!api) return
    setList(await api.packs.list())
  }, [])

  useEffect(() => {
    void refresh()
    const stop = bridge()?.packs.onProgress((p) => {
      setProgress((prev) => ({ ...prev, [p.id]: p }))
      if (p.phase === 'error') setErrors((e) => ({ ...e, [p.id]: p.message }))
      if (p.phase === 'done' || p.phase === 'cancelled') void refresh()
    })
    return () => stop?.()
  }, [refresh])

  // Esc leaves the page, as on Models and Settings.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || document.querySelector('.sheet-backdrop')) return
      e.stopPropagation()
      onCloseRef.current()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  const install = async (id: string) => {
    setErrors(({ [id]: _, ...rest }) => rest)
    const res = await bridge()?.packs.install(id)
    if (res && !res.ok && !res.cancelled && res.reason) setErrors((e) => ({ ...e, [id]: res.reason! }))
    setProgress(({ [id]: _, ...rest }) => rest)
    void refresh()
  }

  const remove = async (id: string) => {
    const res = await bridge()?.packs.remove(id)
    if (res && !res.ok && res.reason) setErrors((e) => ({ ...e, [id]: res.reason! }))
    void refresh()
  }

  const local = list?.packs.filter(isLocalPack) ?? []
  const cloud = list?.packs.filter((p) => !isLocalPack(p)) ?? []

  return (
    <section className="page" aria-label="Resources">
      <header className="page-head">
        <div className="sheet-title">
          <strong>Resources</strong>
          <span>Packs that work offline</span>
        </div>
        <button className="sheet-close" onClick={onClose} aria-label="Close resources" title="Close (Esc)">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </header>
      <div className="page-body">
        <div className="page-inner">
          {!bridge() ? (
            <p className="note">Open the Mac app to manage packs.</p>
          ) : !list ? (
            <div className="skeleton-list">
              {[0, 1, 2].map((i) => (
                <div key={i} className="skeleton-row" />
              ))}
            </div>
          ) : (
            <>
              {!list.ok && <div className="banner bad">{list.reason}</div>}
              {list.ok && list.fromCache && list.source && <p className="note">Offline. Showing the last pack list.</p>}
              {!list.source && <p className="note">No pack source configured.</p>}

              <div className="model-list">
                {local.map((p) => (
                  <PackRow
                    key={p.id}
                    pack={p}
                    installed={list.installed[p.id]?.version ?? null}
                    progress={progress[p.id]}
                    error={errors[p.id]}
                    onInstall={() => void install(p.id)}
                    onCancel={() => void bridge()?.packs.cancel(p.id)}
                    onRemove={() => void remove(p.id)}
                  />
                ))}
                {!local.length && list.ok && <p className="note list-note">No packs yet.</p>}
              </div>

              {cloud.length > 0 && (
                <>
                  <div className="list-heading">Online only</div>
                  <div className="model-list">
                    {cloud.map((p) => (
                      <div key={p.id} className="model-row unfit">
                        <div className="row-main">
                          <div className="row-name">
                            <strong>{p.name}</strong>
                            <span className="chip muted">Online only</span>
                          </div>
                          <div className="row-meta">{p.category} · not available offline</div>
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </section>
  )
}

function PackRow({
  pack,
  installed,
  progress,
  error,
  onInstall,
  onCancel,
  onRemove,
}: {
  pack: Extract<CatalogEntry, { kind: 'local' }>
  installed: string | null
  progress?: PackProgress
  error?: string
  onInstall: () => void
  onCancel: () => void
  onRemove: () => void
}) {
  const busy = !!progress && progress.phase !== 'done' && progress.phase !== 'cancelled' && progress.phase !== 'error'
  const current = installed === pack.version
  const pct =
    progress && 'total' in progress && progress.total > 0 ? Math.min(100, (progress.received / progress.total) * 100) : 0

  let action
  if (busy) {
    action = (
      <button className="btn ghost" onClick={onCancel} title="Stop the download. It resumes where it stopped.">
        {progress.phase === 'verifying' || progress.phase === 'activating' ? 'Checking…' : `${pct.toFixed(0)}% · Cancel`}
      </button>
    )
  } else if (current) {
    action = <span className="row-note ok">Installed</span>
  } else {
    action = (
      <button className="btn" onClick={onInstall} title={`Needs ${fmt(pack.size.installed)} of disk space`}>
        {error ? 'Retry' : installed ? 'Update' : 'Install'}
      </button>
    )
  }

  return (
    <div className="model-row">
      <div className="row-main">
        <div className="row-name">
          <strong>{pack.name}</strong>
          <span className="row-quant">{installed && !current ? `${installed} → ${pack.version}` : pack.version}</span>
        </div>
        <div className="row-meta">
          {pack.category} · {fmt(pack.size.download)}
          {!current && ` · needs ${fmt(pack.size.installed)} on disk`}
          {busy && 'total' in progress && ` · ${fmt(progress.received)} of ${fmt(progress.total)}`}
        </div>
        {error && !busy && <div className="row-error">{error}</div>}
      </div>
      <div className="row-actions">
        {current && !busy && (
          <button className="icon-btn" onClick={onRemove} title="Remove pack" aria-label={`Remove ${pack.name}`}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" />
            </svg>
          </button>
        )}
        {action}
      </div>
      {busy && progress.phase === 'downloading' && (
        <div className="row-progress">
          <div className="row-progress-fill" style={{ width: `${pct}%` }} />
        </div>
      )}
    </div>
  )
}
