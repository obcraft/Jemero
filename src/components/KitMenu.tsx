import { useEffect, useRef } from 'react'
import { KITS, type KitId } from '../lib/kits'

/**
 * The header's kit menu. With nothing open it sets the kit new components are
 * built with; with a component open, picking another kit rebuilds that
 * component with it (a new version, so the old one is one click away).
 */
export default function KitMenu({
  anchorRef,
  current,
  portTarget,
  onPick,
  onClose,
}: {
  anchorRef: React.RefObject<HTMLElement | null>
  current: KitId
  /** Name of the open component, when picking a kit means rebuilding it. */
  portTarget: string | null
  onPick: (kit: KitId) => void
  onClose: () => void
}) {
  const menu = useRef<HTMLDivElement>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

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

  return (
    <div className="menu kit-menu" ref={menu} role="menu">
      <div className="menu-head">{portTarget ? `Kit for ${portTarget}` : 'Kit for new components'}</div>
      {KITS.map((kit) => {
        const active = kit.id === current
        return (
          <button
            key={kit.id}
            className={`menu-item${active ? ' active' : ''}`}
            onClick={() => onPick(kit.id)}
            role="menuitemradio"
            aria-checked={active}
          >
            <span className="menu-check">{active ? '●' : ''}</span>
            <span className="menu-text">
              <span className="menu-title">{kit.name}</span>
              <span className="menu-sub plain">
                {portTarget && !active ? `Rebuild ${portTarget} with ${kit.name}` : kit.blurb}
              </span>
            </span>
          </button>
        )
      })}
      <div className="menu-sep" />
      <div className="menu-note">Bundled in the app: renders offline, nothing to install.</div>
    </div>
  )
}
