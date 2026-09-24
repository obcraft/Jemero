import { memo, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { StageModule } from '../lib/compile'
import type { KitId } from '../lib/kits'
import type { CanvasBg, CanvasWidth } from '../lib/settings'

export type StageEvent =
  | { type: 'rendered'; ms: number; variants: string[] }
  | { type: 'error'; kind: 'import' | 'render' | 'runtime'; message: string; stack: string; componentStack?: string }
  | { type: 'console'; level: 'log' | 'info' | 'warn' | 'error' | 'debug'; text: string }

export type StageCode = { entry: string; modules: StageModule[] }

type Props = {
  code: StageCode | null
  kit: KitId
  /**
   * Installed packs for the import map. The map is fixed once the canvas has
   * loaded a module, so a new key (a pack activated or removed) reloads it.
   */
  packs: { key: string; imports: Record<string, string>; styles: Record<string, string[]> }
  layout: 'center' | 'fill'
  theme: 'light' | 'dark'
  bg: CanvasBg
  width: CanvasWidth
  variant: string | null
  /** Bump to remount the component with fresh state. */
  resetKey: number
  onEvent: (e: StageEvent) => void
  children?: ReactNode
}

const GUTTER = 28

/** A component that navigates away this many times within NAV_WINDOW_MS is stopped rather than reloaded again. */
const NAV_LIMIT = 3
const NAV_WINDOW_MS = 10_000

/**
 * The canvas: kits/stage.html in a sandboxed iframe (scripts and forms only,
 * opaque origin), fed compiled modules over postMessage. It stays mounted while
 * the code changes, so an update is an import, not a page load; switching kit
 * remounts it, because a kit's global CSS can't be taken back out.
 *
 * Device widths are real: the iframe is laid out at 375/768/1280px (media
 * queries respond to that) and scaled down to fit the pane when it's narrower.
 */
function Stage({ code, kit, packs, layout, theme, bg, width, variant, resetKey, onEvent, children }: Props) {
  const frame = useRef<HTMLIFrameElement>(null)
  const pane = useRef<HTMLDivElement>(null)
  /**
   * How many times the current iframe has announced a fresh page (0: not yet).
   * A count, not a flag: a page that was reloaded under us announces itself
   * again and has to be sent the component again.
   */
  const [ready, setReady] = useState(0)
  /** Bumped to put a fresh canvas in place of one the component navigated away from. */
  const [frameNonce, setFrameNonce] = useState(0)
  /** Page loads of the current iframe: the first is the canvas, any later one is the component leaving it. */
  const loads = useRef(0)
  const navigations = useRef<number[]>([])
  /** The component kept navigating away: no more reloads until the code changes. */
  const [halted, setHalted] = useState(false)
  const [box, setBox] = useState({ w: 0, h: 0 })
  const seq = useRef(0)
  const onEventRef = useRef(onEvent)
  onEventRef.current = onEvent

  const post = (msg: object) => frame.current?.contentWindow?.postMessage({ __jemero: 'host', ...msg }, '*')

  // A new kit or pack set is a new iframe, which has to announce itself again.
  useLayoutEffect(() => {
    loads.current = 0
    setReady(0)
  }, [kit, packs.key, frameNonce])

  // New code gets a fresh chance, and a fresh canvas if the last one was given up on.
  useEffect(() => {
    navigations.current = []
    if (halted) {
      setHalted(false)
      setFrameNonce((n) => n + 1)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code])

  /**
   * The canvas can't stop script navigation (location.href = …, reload()) from
   * inside: its opaque origin gets no navigate events. Once it has left
   * stage.html nothing can render there, so the host puts the canvas back and
   * sends the component again, unless it does it on every render.
   */
  const onFrameLoad = () => {
    loads.current += 1
    if (loads.current === 1) return
    const now = Date.now()
    navigations.current = [...navigations.current.filter((t) => now - t < NAV_WINDOW_MS), now]
    if (navigations.current.length >= NAV_LIMIT) {
      setHalted(true)
      onEventRef.current({
        type: 'error',
        kind: 'runtime',
        message: 'The component keeps navigating away from the canvas (location.href, location.reload…), so it was stopped. Remove the navigation.',
        stack: '',
      })
      return
    }
    onEventRef.current({ type: 'console', level: 'warn', text: 'The component navigated away from the canvas, so the canvas was reloaded. Navigation is off on the canvas.' })
    setFrameNonce((n) => n + 1)
  }

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (!frame.current || e.source !== frame.current.contentWindow) return
      const d = e.data as ({ __jemero?: string; type?: string; seq?: number } & Record<string, unknown>) | null
      if (!d || d.__jemero !== 'stage') return
      if (d.type === 'ready') return setReady((n) => n + 1)
      // Replies to a render that has since been replaced are noise.
      if ((d.type === 'rendered' || d.type === 'error') && typeof d.seq === 'number' && d.seq !== seq.current) return
      onEventRef.current(d as unknown as StageEvent)
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [])

  useEffect(() => {
    const el = pane.current
    if (!el) return
    const ro = new ResizeObserver(([entry]) => setBox({ w: entry.contentRect.width, h: entry.contentRect.height }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const options = { theme, layout, bg, variant }

  useEffect(() => {
    if (!ready) return
    seq.current += 1
    // No code: stop what's there, or its timers and logs run on under the overlay.
    if (!code) return post({ type: 'clear', seq: seq.current })
    post({ type: 'render', seq: seq.current, kit, entry: code.entry, modules: code.modules, options })
    // Options travel with the code here and on their own below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, code])

  useEffect(() => {
    if (ready) post({ type: 'options', options })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, theme, layout, bg, variant])

  useEffect(() => {
    if (ready && resetKey) post({ type: 'reset' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey])

  const target = width === 'fit' ? null : Number(width)
  const scale = target && box.w ? Math.min(1, (box.w - GUTTER * 2) / target) : 1
  const height = Math.max(0, box.h - GUTTER * 2)

  return (
    <div className={`stage${target ? ' device' : ''}`} ref={pane}>
      <div className="stage-device" style={target ? { width: target * scale, height } : undefined}>
        <iframe
          key={`${kit}|${packs.key}|${frameNonce}`}
          ref={frame}
          onLoad={onFrameLoad}
          className="stage-frame"
          src={`/kits/stage.html#packs=${encodeURIComponent(JSON.stringify({ imports: packs.imports, styles: packs.styles }))}`}
          sandbox="allow-scripts allow-forms"
          title="Canvas"
          style={target ? { width: target, height: height / scale, transform: `scale(${scale})` } : undefined}
        />
      </div>
      {target && (
        <span className="stage-size">
          {target}px{scale < 1 ? ` · ${Math.round(scale * 100)}%` : ''}
        </span>
      )}
      {children}
    </div>
  )
}

export default memo(Stage)
