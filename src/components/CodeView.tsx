import { memo, useMemo, useState } from 'react'
import { setSettings, useSettings } from '../lib/settings'

type Props = { files: Record<string, string>; libraryPaths: string[] }

function CodeView({ files, libraryPaths }: Props) {
  // Sorting and partitioning on every streamed batch is wasted work; the file
  // *set* only changes when the model starts a new file.
  const keys = Object.keys(files).join('\u0000')
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const all = useMemo(() => Object.keys(files).sort(), [keys])
  const mine = useMemo(() => all.filter((p) => !libraryPaths.includes(p)), [all, libraryPaths])
  const lib = useMemo(() => all.filter((p) => libraryPaths.includes(p)), [all, libraryPaths])

  const [selected, setSelected] = useState<string | null>(null)
  const { fileTreeOpen } = useSettings()
  const active = selected && files[selected] ? selected : (mine.find((p) => p === 'src/App.jsx') ?? mine[0] ?? all[0])

  if (!all.length) return <div className="empty"><p>No files yet.</p></div>

  const item = (p: string) => (
    <button key={p} className={p === active ? 'file active' : 'file'} onClick={() => setSelected(p)}>
      {p}
    </button>
  )

  return (
    <div className={`codeview${fileTreeOpen ? '' : ' tree-closed'}`}>
      <aside className="filetree" aria-hidden={!fileTreeOpen}>
        {mine.map(item)}
        {lib.length > 0 && (
          <details className="lib">
            <summary>design system · {lib.length}</summary>
            {lib.map(item)}
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
          <span className="code-path">{active}</span>
        </div>
        <pre className="code">
          <code>{active ? files[active] : ''}</code>
        </pre>
      </div>
    </div>
  )
}

export default memo(CodeView)
