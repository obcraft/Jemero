import { memo, useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import type { Theme } from '../lib/settings'

/** xterm paints to a canvas, so it can't inherit the CSS variables. */
function palette() {
  const light = document.documentElement.dataset.theme === 'light'
  return light
    ? { background: '#f7f8fa', foreground: '#2c3340', cursor: '#f7f8fa' }
    : { background: '#0e1014', foreground: '#c9d1d9', cursor: '#0e1014' }
}

// Vite clears the screen when it boots, which would wipe the install log above it.
// Drop screen/scrollback erases and full resets; keep colours and line erases.
const CLEAR_SCREEN = /\u001b\[[0-3]?J|\u001bc|\u001b\[2J/g

function TerminalView({ lines, theme }: { lines: string[]; theme: Theme }) {
  const host = useRef<HTMLDivElement>(null)
  const term = useRef<Terminal | null>(null)
  const fit = useRef<FitAddon | null>(null)
  const written = useRef(0)

  useEffect(() => {
    if (!host.current || term.current) return
    const t = new Terminal({
      convertEol: true,
      fontSize: 12,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      theme: palette(),
    })
    const f = new FitAddon()
    t.loadAddon(f)
    t.open(host.current)
    f.fit()
    term.current = t
    fit.current = f

    const ro = new ResizeObserver(() => {
      try {
        f.fit()
      } catch {
        /* pane hidden */
      }
    })
    ro.observe(host.current)
    return () => ro.disconnect()
  }, [])

  // Re-read the resolved theme: `theme` may be 'system', and <html data-theme>
  // is the thing that actually settled it.
  useEffect(() => {
    if (term.current) term.current.options.theme = palette()
  }, [theme])

  useEffect(() => {
    const t = term.current
    if (!t) return
    const fresh = lines.slice(written.current)
    written.current = lines.length
    if (!fresh.length) return
    // One write for the whole batch: an install can log hundreds of lines and
    // writeln() per line repaints each time.
    t.write(fresh.map((l) => l.replace(CLEAR_SCREEN, '')).join('\r\n') + '\r\n')
  }, [lines])

  return <div className="terminal" ref={host} />
}

/** Only `lines` and `theme` matter, and both are compared by value. */
export default memo(TerminalView)
