import { useCallback, useEffect, useRef, useState } from 'react'
import {
  bridge,
  cachedSnapshot,
  formatGB,
  loadSnapshot,
  modelLabel,
  watchSnapshot,
  type CatalogSnapshot,
  type Progress,
} from '../lib/models'

/**
 * The header's model menu: everything already downloaded, one click each.
 *
 * Switching means restarting llama.cpp on other weights, so this is as fast as
 * it can honestly be — it reads from the cached snapshot (no spinner on open),
 * shows the restart as inline status on the row, and leaves the deep catalog to
 * the browser behind "Browse all models".
 */
export default function ModelMenu({
  anchorRef,
  onClose,
  onBrowse,
  onActive,
}: {
  anchorRef: React.RefObject<HTMLElement>
  onClose: () => void
  onBrowse: () => void
  onActive: (id: string) => void
}) {
  const [snap, setSnap] = useState<CatalogSnapshot | null>(cachedSnapshot)
  const [status, setStatus] = useState<{ id: string; text: string } | null>(null)
  const menu = useRef<HTMLDivElement>(null)
  const sync = useCallback(() => setSnap(cachedSnapshot()), [])

  useEffect(() => {
    void loadSnapshot()
    const stopWatch = watchSnapshot(sync)
    const stopProgress = bridge()?.onProgress((p: Progress) => {
      if (p.phase === 'activating') setStatus({ id: p.id, text: p.message ?? 'Starting…' })
      if (p.phase === 'active') {
        setStatus(null)
        onActive(p.id)
        onClose()
      }
      if (p.phase === 'error') setStatus(null)
    })
    return () => {
      stopWatch()
      stopProgress?.()
    }
  }, [sync, onActive, onClose])

  // Dismiss on outside click or Esc, ignoring the button that opened us.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node
      if (menu.current?.contains(target) || anchorRef.current?.contains(target)) return
      onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      onClose()
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [anchorRef, onClose])

  const ready = (snap?.installed ?? []).filter((m) => m.complete)
  const plans = new Map((snap?.models ?? []).map((m) => [m.modelId, m]))

  const activate = async (id: string) => {
    if (id === snap?.active) return onClose()
    setStatus({ id, text: 'Stopping the current model…' })
    const res = await bridge()?.activate(id)
    if (res && !res.ok) setStatus(null)
  }

  return (
    <div className="menu" ref={menu} role="menu">
      <div className="menu-head">Downloaded</div>
      {ready.map((m) => {
        const plan = plans.get(m.id)
        const active = snap?.active === m.id
        const busy = status?.id === m.id
        return (
          <button
            key={m.id}
            className={`menu-item${active ? ' active' : ''}`}
            onClick={() => void activate(m.id)}
            disabled={!!status}
            role="menuitem"
          >
            <span className="menu-check">{active ? '●' : ''}</span>
            <span className="menu-text">
              <span className="menu-title">{plan?.label ?? modelLabel(m.id)}</span>
              <span className="menu-sub">
                {busy
                  ? status.text
                  : plan
                    ? `${plan.quant} · ${formatGB(plan.sizeGB)} · ≈${plan.tokensPerSec} tok/s`
                    : formatGB(m.bytes / 1024 ** 3)}
              </span>
            </span>
            {busy && <span className="menu-spinner" />}
          </button>
        )
      })}
      {!ready.length && <div className="menu-empty">Nothing downloaded yet.</div>}

      <div className="menu-sep" />
      <button className="menu-item" onClick={onBrowse} role="menuitem">
        <span className="menu-check" />
        <span className="menu-text">
          <span className="menu-title">Browse all models…</span>
          <span className="menu-sub">
            {snap ? `${snap.models.filter((m) => m.fits).length} of ${snap.models.length} run on this Mac` : 'Matched to your hardware'}
          </span>
        </span>
      </button>
    </div>
  )
}
