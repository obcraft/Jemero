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

/**
 * The canvas: kits/stage.html in a sandboxed iframe (scripts and forms only,
 * opaque origin), fed compiled modules over postMessage. It stays mounted while
 * the code changes, so an update is an import, not a page load; switching kit
 * remounts it, because a kit's global CSS can't be taken back out.
 *
 * Device widths are real: the iframe is laid out at 375/768/1280px (media
 * queries respond to that) and scaled down to fit the pane when it's narrower.
 */
function Stage({ code, kit, layout, theme, bg, width, variant, resetKey, onEvent, children }: Props) {
  const frame = useRef<HTMLIFrameElement>(null)
  const pane = useRef<HTMLDivElement>(null)
  const [ready, setReady] = useState(false)
  const [box, setBox] = useState({ w: 0, h: 0 })
  const seq = useRef(0)
  const onEventRef = useRef(onEvent)
  onEventRef.current = onEvent

  const post = (msg: object) => frame.current?.contentWindow?.postMessage({ __jemero: 'host', ...msg }, '*')

  // A new kit is a new iframe, which has to announce itself again.
  useLayoutEffect(() => setReady(false), [kit])

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (!frame.current || e.source !== frame.current.contentWindow) return
      const d = e.data as ({ __jemero?: string; type?: string; seq?: number } & Record<string, unknown>) | null
      if (!d || d.__jemero !== 'stage') return
      if (d.type === 'ready') return setReady(true)
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
    if (!ready || !code) return
    seq.current += 1
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
          key={kit}
          ref={frame}
          className="stage-frame"
          src="/kits/stage.html"
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
