import { memo } from 'react'

type Props = { url: string | null; status: string; reloadKey: number }

function Preview({ url, status, reloadKey }: Props) {
  if (!url) {
    return (
      <div className="empty">
        <div className="spinner-dot" />
        <p>{status}</p>
      </div>
    )
  }
  // Changing the key remounts the iframe, which is the only reliable way to reload
  // a cross-origin document we can't reach into.
  return <iframe key={reloadKey} className="preview" src={url} title="Preview" allow="cross-origin-isolated" />
}

// The iframe must not re-render on every streamed token.
export default memo(Preview)
