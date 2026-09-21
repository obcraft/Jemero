import { useEffect, useRef, useState, type ReactNode } from 'react'

/**
 * The shell every panel in the app uses: one dialog, one animation, one set of
 * dismiss rules.
 *
 * It owns its own unmount so the close animation can finish — the parent just
 * flips `open`. React has no built-in exit transition, so the pattern is: render
 * on open, flag 'out' on close, unmount when the transition ends (with a timer
 * as a backstop, because a transition on a hidden element never fires).
 */
export default function Modal({
  open,
  onClose,
  title,
  subtitle,
  tabs,
  wide,
  children,
}: {
  open: boolean
  onClose: () => void
  title: string
  subtitle?: string
  tabs?: ReactNode
  wide?: boolean
  children: ReactNode
}) {
  const [mounted, setMounted] = useState(open)
  const [shown, setShown] = useState(false)
  const panel = useRef<HTMLDivElement>(null)
  const restoreFocus = useRef<Element | null>(null)
  // Read through a ref: the parent's onClose is a new function every render,
  // and as an effect dependency it re-ran the focus handling below each time —
  // yanking focus out of whatever input was being typed in.
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useEffect(() => {
    if (open) {
      restoreFocus.current = document.activeElement
      setMounted(true)
      // One frame with the closed styles applied, so the browser has something
      // to transition *from*.
      const id = requestAnimationFrame(() => setShown(true))
      return () => cancelAnimationFrame(id)
    }
    setShown(false)
    const id = setTimeout(() => setMounted(false), 260)
    return () => clearTimeout(id)
  }, [open])

  useEffect(() => {
    if (!mounted) return
    panel.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      // Don't let the app's global Esc-to-stop fire as well.
      e.stopPropagation()
      onCloseRef.current()
    }
    // Capture phase: this runs before App's window listener.
    window.addEventListener('keydown', onKey, true)
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey, true)
      document.body.style.overflow = overflow
      if (restoreFocus.current instanceof HTMLElement) restoreFocus.current.focus()
    }
  }, [mounted])

  if (!mounted) return null

  return (
    <div
      className={`sheet-backdrop${shown ? ' shown' : ''}`}
      onClick={onClose}
      onTransitionEnd={(e) => {
        if (e.target === e.currentTarget && !shown) setMounted(false)
      }}
    >
      <div
        className={`sheet${wide ? ' wide' : ''}${shown ? ' shown' : ''}`}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        ref={panel}
      >
        <header className="sheet-head">
          <div className="sheet-title">
            <strong>{title}</strong>
            {subtitle && <span>{subtitle}</span>}
          </div>
          <button className="sheet-close" onClick={onClose} aria-label="Close">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </header>
        {tabs && <div className="sheet-tabs">{tabs}</div>}
        <div className="sheet-body">{children}</div>
      </div>
    </div>
  )
}
