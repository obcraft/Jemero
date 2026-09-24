import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Modal from './Modal'
import OfflineCheck from './OfflineCheck'
import { bridge } from '../lib/models'
import type { Item } from '../lib/library'
import type { Manifest } from '../lib/kits'
import {
  importedSpecifiers,
  isLocalPack,
  type CatalogEntry,
  type InstalledManifest,
  type LocalPack,
  type PackList,
  type PackProgress,
} from '../lib/packs'

const fmt = (bytes: number) =>
  bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : bytes >= 1024 ** 2 ? `${(bytes / 1024 ** 2).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`

type Filter = 'all' | 'installed' | 'downloadable' | 'internet'
const FILTERS: [Filter, string][] = [
  ['all', 'All'],
  ['installed', 'Installed'],
  ['downloadable', 'Downloadable'],
  ['internet', 'Requires internet'],
]

/** What the base kit bundles: always installed, part of the app. */
const BUILT_IN: [pkg: string, role: string][] = [
  ['react', 'UI runtime'],
  ['radix-ui', 'accessible primitives'],
  ['lucide-react', 'icons'],
  ['motion', 'animation'],
  ['recharts', 'charts'],
  ['date-fns', 'dates'],
  ['cmdk', 'command menu'],
  ['sonner', 'toasts'],
  ['react-day-picker', 'calendar'],
  ['input-otp', 'one-time codes'],
  ['clsx', 'class names'],
]

/**
 * Resources: every component library, pack and service the canvas can use,
 * searchable, with what's installed, what can be downloaded (and what that
 * costs), and what needs the internet. Removing a pack that saved work uses
 * asks first. The Offline ready check sits on top.
 */
export default function ResourcesPage({
  items,
  installed,
  manifest,
  onOpenModels,
  onClose,
}: {
  items: Item[]
  installed: InstalledManifest
  /** The kit manifest with installed packs merged in. */
  manifest: Manifest | null
  onOpenModels: () => void
  onClose: () => void
}) {
  const [list, setList] = useState<PackList | null>(null)
  const [progress, setProgress] = useState<Record<string, PackProgress>>({})
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [confirm, setConfirm] = useState<{ pack: LocalPack; usedBy: string[] } | null>(null)
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
      if (e.key !== 'Escape' || document.querySelector('.sheet-backdrop, .menu')) return
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

  /** Saved components whose latest version needs this pack. */
  const usedBy = useCallback(
    (pack: LocalPack) =>
      items
        .filter((it) => {
          const v = it.versions.at(-1)
          if (!v) return false
          if (v.packs?.packs[pack.id]) return true
          return importedSpecifiers(v.files).some((s) => s in pack.imports)
        })
        .map((it) => it.name),
    [items],
  )

  const remove = async (pack: LocalPack, confirmed = false) => {
    const users = usedBy(pack)
    if (users.length && !confirmed) return setConfirm({ pack, usedBy: users })
    setConfirm(null)
    const res = await bridge()?.packs.remove(pack.id)
    if (res && !res.ok && res.reason) setErrors((e) => ({ ...e, [pack.id]: res.reason! }))
    void refresh()
  }

  const catalog = list?.packs ?? []
  const byId = useMemo(() => new Map(catalog.map((p) => [p.id, p])), [catalog])
  const q = query.trim().toLowerCase()
  const matches = (...text: (string | undefined)[]) => !q || text.some((t) => t?.toLowerCase().includes(q))

  const builtIns = BUILT_IN.filter(([pkg]) => manifest?.versions[pkg])
    .map(([pkg, role]) => ({ pkg, role, version: manifest!.versions[pkg] }))
    .filter((b) => matches(b.pkg, b.role, 'built in library'))
  const uiCount = manifest ? Object.keys(manifest.exports).filter((s) => s.startsWith('@/components/ui/')).length : 0
  const shadcnMatch = uiCount > 0 && matches('shadcn/ui components', 'button card dialog select')

  const stateOf = (p: CatalogEntry): Filter => (p.kind === 'cloud' ? 'internet' : installed.packs[p.id]?.version === p.version ? 'installed' : 'downloadable')
  const shown = catalog.filter((p) => (filter === 'all' || stateOf(p) === filter) && matches(p.name, p.id, p.description, p.category))
  const showBuiltIn = filter === 'all' || filter === 'installed'

  return (
    <section className="page" aria-label="Resources">
      <header className="page-head">
        <div className="sheet-title">
          <strong>Resources</strong>
          <span>Components, libraries and services</span>
        </div>
        <button className="sheet-close" onClick={onClose} aria-label="Close resources" title="Close (Esc)">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </header>
      {bridge() && (
        <div className="page-toolbar">
          <div className="browser-controls">
            <div className="segmented tight">
              {FILTERS.map(([id, label]) => (
                <button key={id} className={filter === id ? 'seg active' : 'seg'} onClick={() => setFilter(id)}>
                  {label}
                </button>
              ))}
            </div>
            <div className="search">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
                <circle cx="11" cy="11" r="7" />
                <path d="M20 20l-3.6-3.6" />
              </svg>
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search components, libraries, services" aria-label="Search resources" />
            </div>
          </div>
        </div>
      )}
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
              <OfflineCheck
                items={items}
                installed={installed}
                catalog={catalog}
                manifest={manifest}
                onOpenModels={onOpenModels}
                onInstall={(id) => void install(id)}
              />

              {!list.ok && <div className="banner bad">{list.reason}</div>}
              {list.ok && list.fromCache && list.source && <p className="note">Offline. Showing the last pack list.</p>}

              <div className="model-list">
                {shown.map((p) =>
                  isLocalPack(p) ? (
                    <PackRow
                      key={p.id}
                      pack={p}
                      deps={p.dependencies.map((d) => byId.get(d)?.name ?? d)}
                      installed={installed.packs[p.id]?.version ?? null}
                      previous={list.installed[p.id]?.previous ?? null}
                      onRollback={() =>
                        void bridge()
                          ?.packs.rollback(p.id)
                          .then((r) => (r.ok ? refresh() : r.reason && setErrors((e) => ({ ...e, [p.id]: r.reason! }))))
                      }
                      progress={progress[p.id]}
                      error={errors[p.id]}
                      onInstall={() => void install(p.id)}
                      onCancel={() => void bridge()?.packs.cancel(p.id)}
                      onRemove={() => void remove(p)}
                    />
                  ) : (
                    <div key={p.id} className="model-row unfit">
                      <div className="row-main">
                        <div className="row-name">
                          <strong>{p.name}</strong>
                          <span className="chip muted">Requires internet</span>
                        </div>
                        <div className="row-meta">{p.description || p.category} · not available offline</div>
                      </div>
                    </div>
                  ),
                )}

                {showBuiltIn && shadcnMatch && (
                  <div className="model-row">
                    <div className="row-main">
                      <div className="row-name">
                        <strong>shadcn/ui components</strong>
                        <span className="chip muted">Built in</span>
                      </div>
                      <div className="row-meta">{uiCount} components · part of the app</div>
                    </div>
                    <div className="row-actions">
                      <span className="row-note ok">Installed</span>
                    </div>
                  </div>
                )}
                {showBuiltIn &&
                  builtIns.map((b) => (
                    <div key={b.pkg} className="model-row">
                      <div className="row-main">
                        <div className="row-name">
                          <strong>{b.pkg}</strong>
                          <span className="row-quant">{b.version}</span>
                          <span className="chip muted">Built in</span>
                        </div>
                        <div className="row-meta">{b.role} · part of the app</div>
                      </div>
                      <div className="row-actions">
                        <span className="row-note ok">Installed</span>
                      </div>
                    </div>
                  ))}

                {!shown.length && !(showBuiltIn && (builtIns.length || shadcnMatch)) && (
                  <p className="note list-note">{q ? `Nothing matches “${query}”.` : 'Nothing here.'}</p>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      <Modal open={!!confirm} onClose={() => setConfirm(null)} title={`Remove ${confirm?.pack.name ?? ''}?`}>
        {confirm && (
          <>
            <p className="note">
              Used by {confirm.usedBy.length === 1 ? 'a saved component' : `${confirm.usedBy.length} saved components`}:{' '}
              <strong>{confirm.usedBy.slice(0, 5).join(', ')}</strong>
              {confirm.usedBy.length > 5 ? ` and ${confirm.usedBy.length - 5} more` : ''}. They won’t render until it’s installed again, which
              needs the internet.
            </p>
            <div className="confirm-actions">
              <button className="btn ghost" onClick={() => setConfirm(null)}>
                Keep it
              </button>
              <button className="btn danger" onClick={() => void remove(confirm.pack, true)}>
                Remove
              </button>
            </div>
          </>
        )}
      </Modal>
    </section>
  )
}

function PackRow({
  pack,
  deps,
  installed,
  previous,
  progress,
  error,
  onInstall,
  onCancel,
  onRemove,
  onRollback,
}: {
  pack: LocalPack
  deps: string[]
  installed: string | null
  previous: string | null
  onRollback: () => void
  progress?: PackProgress
  error?: string
  onInstall: () => void
  onCancel: () => void
  onRemove: () => void
}) {
  const busy = !!progress && progress.phase !== 'done' && progress.phase !== 'cancelled' && progress.phase !== 'error'
  const current = installed === pack.version
  const pct = progress && 'total' in progress && progress.total > 0 ? Math.min(100, (progress.received / progress.total) * 100) : 0

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
          {!current && <span className="chip muted">Downloadable</span>}
        </div>
        <div className="row-meta">
          {pack.category} · {fmt(pack.size.download)}
          {!current && ` · ${fmt(pack.size.installed)} on disk`}
          {deps.length > 0 && ` · needs ${deps.join(', ')}`}
          {busy && 'total' in progress && ` · ${fmt(progress.received)} of ${fmt(progress.total)}`}
        </div>
        {error && !busy && <div className="row-error">{error}</div>}
      </div>
      <div className="row-actions">
        {previous && !busy && (
          <button className="btn ghost small" onClick={onRollback} title={`Go back to ${previous}`}>
            Roll back
          </button>
        )}
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
