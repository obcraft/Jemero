import { memo, useEffect, useState } from 'react'
import { kitById } from '../lib/kits'
import type { Item, Kind } from '../lib/library'
import { KIND_LABEL } from '../lib/systemPrompt'

type Props = {
  items: Item[]
  selectedId: string | null
  busyId: string | null
  onSelect: (id: string) => void
  onNew: () => void
  onDelete: (id: string) => void
}

/** Tiny glyphs so a list of names still reads at a glance: control, card, full-width band. */
function KindGlyph({ kind }: { kind: Kind }) {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      {kind === 'component' && <rect x="2.5" y="5" width="11" height="6" rx="3" />}
      {kind === 'block' && (
        <>
          <rect x="3" y="2.5" width="10" height="11" rx="2" />
          <path d="M5.5 6h5M5.5 9h3" strokeLinecap="round" />
        </>
      )}
      {kind === 'section' && (
        <>
          <rect x="1.5" y="3" width="13" height="10" rx="1.5" />
          <path d="M1.5 6.5h13" />
        </>
      )}
    </svg>
  )
}

/** Everything built so far. Deleting takes two clicks, since it takes every version with it. */
function Library({ items, selectedId, busyId, onSelect, onNew, onDelete }: Props) {
  const [confirming, setConfirming] = useState<string | null>(null)

  useEffect(() => {
    if (!confirming) return
    const id = setTimeout(() => setConfirming(null), 3000)
    return () => clearTimeout(id)
  }, [confirming])

  return (
    <div className="library">
      <div className="library-head">
        <span className="library-title">Library</span>
        {items.length > 0 && <span className="library-count">{items.length}</span>}
        <button className={`btn small new-btn${selectedId ? '' : ' current'}`} onClick={onNew} title="Start a new component">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round">
            <path d="M12 5v14M5 12h14" />
          </svg>
          New
        </button>
      </div>
      <div className="library-list" role="list">
        {items.map((item) => {
          const latest = item.versions[item.versions.length - 1]
          const selected = item.id === selectedId
          return (
            <div key={item.id} className={`lib-row${selected ? ' selected' : ''}`} role="listitem">
              <button className="lib-main" onClick={() => onSelect(item.id)} aria-current={selected}>
                <span className="lib-glyph">
                  <KindGlyph kind={item.kind} />
                </span>
                <span className="lib-text">
                  <span className="lib-name">{item.name}</span>
                  <span className="lib-meta">
                    {KIND_LABEL[item.kind]}
                    {latest ? ` · ${kitById(latest.kit).name} · v${item.versions.length}` : ' · not built yet'}
                  </span>
                </span>
                {busyId === item.id && <span className="menu-spinner" />}
              </button>
              <button
                className={`lib-delete${confirming === item.id ? ' armed' : ''}`}
                onClick={() => {
                  if (confirming === item.id) {
                    setConfirming(null)
                    onDelete(item.id)
                  } else setConfirming(item.id)
                }}
                disabled={busyId === item.id}
                title={confirming === item.id ? 'Click again to delete it and every version' : 'Delete'}
                aria-label={confirming === item.id ? `Confirm deleting ${item.name}` : `Delete ${item.name}`}
              >
                {confirming === item.id ? (
                  'Delete?'
                ) : (
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round">
                    <path d="M6 6l12 12M18 6L6 18" />
                  </svg>
                )}
              </button>
            </div>
          )
        })}
        {!items.length && <p className="lib-empty">Nothing yet. Everything you build lands here, with every version.</p>}
      </div>
    </div>
  )
}

export default memo(Library)
