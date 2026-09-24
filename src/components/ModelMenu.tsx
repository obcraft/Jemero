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
 * it can honestly be, it reads from the cached snapshot (no spinner on open),
 * shows the restart as inline status on the row, and leaves the deep catalog to
 * the browser behind "Browse all models".
 */
export default function ModelMenu({
  anchorRef,
  onClose,
  onBrowse,
  onActive,
}: {
  anchorRef: React.RefObject<HTMLElement | null>
  onClose: () => void
  onBrowse: () => void
  onActive: (id: string) => void
}) {
  const [snap, setSnap] = useState<CatalogSnapshot | null>(cachedSnapshot)
  const [status, setStatus] = useState<{ id: string; text: string } | null>(null)
  /** Why the last switch failed, shown on its row until the next click. */
  const [failure, setFailure] = useState<{ id: string; text: string } | null>(null)
  const menu = useRef<HTMLDivElement>(null)
  const sync = useCallback(() => setSnap(cachedSnapshot()), [])
  // Fresh closures from the parent every render, read through refs so the
  // subscriptions below are made once, not on every app re-render.
  const onActiveRef = useRef(onActive)
  const onCloseRef = useRef(onClose)
  onActiveRef.current = onActive
  onCloseRef.current = onClose

  useEffect(() => {
    void loadSnapshot()
    const stopWatch = watchSnapshot(sync)
    const stopProgress = bridge()?.onProgress((p: Progress) => {
      if (p.phase === 'activating') setStatus({ id: p.id, text: p.message ?? 'Starting…' })
      if (p.phase === 'active') {
        setStatus(null)
        onActiveRef.current(p.id)
        onCloseRef.current()
      }
      if (p.phase === 'error') {
        setStatus(null)
        if (p.message) setFailure({ id: p.id, text: p.message })
      }
    })
    return () => {
      stopWatch()
      stopProgress?.()
    }
  }, [sync])

  // Dismiss on outside click or Esc, ignoring the button that opened us.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node
      if (menu.current?.contains(target) || anchorRef.current?.contains(target)) return
      onCloseRef.current()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      onCloseRef.current()
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [anchorRef])

  const ready = (snap?.installed ?? []).filter((m) => m.complete)
  const plans = new Map((snap?.models ?? []).map((m) => [m.modelId, m]))

  const activate = async (id: string) => {
    if (id === snap?.active) return onClose()
    setFailure(null)
    setStatus({ id, text: 'Stopping the current model…' })
    try {
      const res = await bridge()?.activate(id)
      if (res && !res.ok) setFailure({ id, text: res.reason ?? 'The model did not start.' })
    } catch (err) {
      setFailure({ id, text: (err as Error).message })
    } finally {
      // 'active' closes the menu; anything else leaves it usable.
      setStatus(null)
    }
  }

  return (
    <div className="menu" ref={menu} role="menu">
      <div className="menu-head">Downloaded</div>
      {ready.map((m) => {
        const plan = plans.get(m.id)
        const active = snap?.active === m.id
        const busy = status?.id === m.id
        const failed = !busy && failure?.id === m.id
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
              <span className={`menu-sub${failed ? ' failed' : ''}`} title={failed ? failure.text : undefined}>
                {busy
                  ? status.text
                  : failed
                    ? `Didn’t start: ${failure.text.split('\n')[0]}`
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
          <span className="menu-sub plain">Or search any model on Hugging Face</span>
        </span>
      </button>
    </div>
  )
}
