import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { setSettings, useSettings } from '../lib/settings'

type Props = {
  /** The component's own files. */
  files: Record<string, string>
  /** Kit sources it imports (shadcn/ui), shown read-only so the whole thing can be copied out. */
  kitFiles: Record<string, string>
  entry: string | null
  /** False while the model is writing, or before there's a version to edit. */
  editable: boolean
  /** The file the model is writing right now, followed as it grows. */
  streaming: string | null
  onEdit: (path: string, content: string) => void
}

function CodeView({ files, kitFiles, entry, editable, streaming, onEdit }: Props) {
  const own = useMemo(() => Object.keys(files).sort((a, b) => (a === entry ? -1 : b === entry ? 1 : a.localeCompare(b))), [files, entry])
  const kit = useMemo(() => Object.keys(kitFiles).sort(), [kitFiles])
  const [selected, setSelected] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const { fileTreeOpen } = useSettings()
  const pre = useRef<HTMLPreElement>(null)

  const active =
    streaming && streaming in files
      ? streaming
      : selected && (selected in files || selected in kitFiles)
        ? selected
        : ((entry && entry in files ? entry : own[0]) ?? null)
  const isKit = !!active && !(active in files)
  const text = active ? (isKit ? kitFiles[active] : files[active]) : ''

  // Follow the model down the file as it writes.
  useEffect(() => {
    if (streaming && pre.current) pre.current.scrollTop = pre.current.scrollHeight
  }, [streaming, text])

  useEffect(() => setCopied(false), [active])

  if (!own.length) {
    return (
      <div className="empty">
        <p>No code yet.</p>
      </div>
    )
  }

  const item = (p: string, label = p) => (
    <button key={p} className={p === active ? 'file active' : 'file'} onClick={() => setSelected(p)} title={p}>
      {label}
    </button>
  )

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1400)
    } catch {
      /* clipboard refused: nothing to do */
    }
  }

  return (
    <div className={`codeview${fileTreeOpen ? '' : ' tree-closed'}`}>
      <aside className="filetree" inert={!fileTreeOpen}>
        {own.map((p) => item(p))}
        {kit.length > 0 && (
          <details className="lib" open>
            <summary>uses from the kit · {kit.length}</summary>
            {kit.map((p) => item(p, p.replace(/^components\//, '')))}
          </details>
        )}
      </aside>
      <div className="code-pane">
        <div className="code-bar">
          <button
            className="icon-btn"
            onClick={() => setSettings({ fileTreeOpen: !fileTreeOpen })}
            title={fileTreeOpen ? 'Hide files' : 'Show files'}
            aria-label={fileTreeOpen ? 'Hide files' : 'Show files'}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="4" width="18" height="16" rx="2" />
              <path d="M9 4v16" />
            </svg>
          </button>
          <span className="code-path">{isKit ? `@/${active?.replace(/\.jsx?$/, '')}` : active}</span>
          {isKit && <span className="chip muted">kit · read-only</span>}
          {!isKit && streaming === active && <span className="chip">writing…</span>}
          {!isKit && editable && <span className="code-hint">Edits render live</span>}
          <button className="btn ghost small" onClick={() => void copy()} disabled={!text}>
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
        {editable && !isKit && active ? (
          <textarea
            key={active}
            className="code editor"
            value={text}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            onChange={(e) => onEdit(active, e.target.value)}
            onKeyDown={(e) => {
              // Tab indents instead of leaving the editor.
              if (e.key !== 'Tab' || e.metaKey || e.ctrlKey || e.altKey) return
              e.preventDefault()
              const el = e.currentTarget
              const { selectionStart: start, selectionEnd: end, value } = el
              onEdit(active, `${value.slice(0, start)}  ${value.slice(end)}`)
              requestAnimationFrame(() => el.setSelectionRange(start + 2, start + 2))
            }}
          />
        ) : (
          <pre className="code" ref={pre}>
            <code>{text}</code>
          </pre>
        )}
      </div>
    </div>
  )
}

export default memo(CodeView)
