import { memo, useEffect, useRef } from 'react'

export type ConsoleLevel = 'log' | 'info' | 'warn' | 'error' | 'debug' | 'system'
export type ConsoleEntry = { id: number; level: ConsoleLevel; text: string; at: number }

/** One formatter for every line: toLocaleTimeString builds a new one per call. */
const TIME = new Intl.DateTimeFormat([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })

/**
 * What the component logs on the canvas (console.*, alerts, form submissions,
 * React's warnings), plus what the compiler repaired. It's the test bench:
 * wire an onChange to console.log in the Preview and watch the values arrive.
 */
function ConsoleView({ entries, onClear }: { entries: ConsoleEntry[]; onClear: () => void }) {
  const list = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)

  // Follow new output, unless the user has scrolled up to read something.
  useEffect(() => {
    const el = list.current
    if (el && pinned.current) el.scrollTop = el.scrollHeight
  }, [entries])

  const errors = entries.filter((e) => e.level === 'error').length
  const warnings = entries.filter((e) => e.level === 'warn').length

  return (
    <div className="console">
      <div className="code-bar">
        <span className="code-path">
          {entries.length ? `${entries.length} message${entries.length === 1 ? '' : 's'}` : 'Console'}
          {errors > 0 && <span className="console-count error"> · {errors} error{errors === 1 ? '' : 's'}</span>}
          {warnings > 0 && <span className="console-count warn"> · {warnings} warning{warnings === 1 ? '' : 's'}</span>}
        </span>
        <button className="btn ghost small" onClick={onClear} disabled={!entries.length}>
          Clear
        </button>
      </div>
      <div
        className="console-list"
        ref={list}
        onScroll={(e) => {
          const el = e.currentTarget
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
        }}
      >
        {!entries.length && <p className="console-empty">Logs from the canvas show up here: console output, form submissions, warnings.</p>}
        {entries.map((e) => (
          <div key={e.id} className={`console-line ${e.level}`}>
            <span className="console-time">
              {TIME.format(e.at)}
            </span>
            <pre>{e.text}</pre>
          </div>
        ))}
      </div>
    </div>
  )
}

export default memo(ConsoleView)
