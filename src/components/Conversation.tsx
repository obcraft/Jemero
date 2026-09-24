import { memo, useEffect, useRef, useState, type ReactNode } from 'react'
import type { Item, Kind, Mode } from '../lib/library'
import { KIND_LABEL } from '../lib/systemPrompt'

/** What the model is producing right now, before it becomes a turn. */
export type Draft = {
  itemId: string
  mode: Mode
  prose: string
  plan: string
  review: string[]
}

const MODE_LABEL: Partial<Record<Mode, string>> = {
  review: 'Review',
  repair: 'Fix',
  port: 'Port',
  edit: 'Edit',
}

/** "- Anatomy: trigger, panel" -> a list with the label picked out. */
function Plan({ text, open }: { text: string; open: boolean }) {
  const lines = text
    .split('\n')
    .map((l) => l.trim().replace(/^[-*•]\s*/, ''))
    .filter(Boolean)
  if (!lines.length) return null
  return (
    <details className="plan" open={open}>
      <summary>Plan</summary>
      <ul>
        {lines.map((line, i) => {
          const m = line.match(/^([A-Z][\w /&-]{1,24}):\s*(.*)$/)
          return (
            <li key={i}>
              {m ? (
                <>
                  <strong>{m[1]}</strong> {m[2]}
                </>
              ) : (
                line
              )}
            </li>
          )
        })}
      </ul>
    </details>
  )
}

/** Review findings as a checklist: tick what's worth doing, apply it as one refinement. */
function Review({ points, onApply, disabled }: { points: string[]; onApply: (p: string[]) => void; disabled: boolean }) {
  const [picked, setPicked] = useState<Set<number>>(() => new Set(points.map((_, i) => i)))
  const chosen = points.filter((_, i) => picked.has(i))
  return (
    <div className="review">
      {points.map((p, i) => (
        <label key={i} className="review-point">
          <input
            type="checkbox"
            checked={picked.has(i)}
            onChange={() =>
              setPicked((prev) => {
                const next = new Set(prev)
                if (next.has(i)) next.delete(i)
                else next.add(i)
                return next
              })
            }
          />
          <span>{p}</span>
        </label>
      ))}
      <button className="btn small review-apply" disabled={disabled || !chosen.length} onClick={() => onApply(chosen)}>
        Apply {chosen.length === points.length ? 'all' : chosen.length} {chosen.length === 1 ? 'fix' : 'fixes'}
      </button>
    </div>
  )
}

type Props = {
  item: Item | null
  draft: Draft | null
  phaseLabel: string | null
  thought: string
  showThought: boolean
  busy: boolean
  viewedVersion: number
  onVersion: (n: number) => void
  onApplyReview: (points: string[]) => void
  notice?: ReactNode
}

function Conversation({
  item,
  draft,
  phaseLabel,
  thought,
  showThought,
  busy,
  viewedVersion,
  onVersion,
  onApplyReview,
  notice,
}: Props) {
  const list = useRef<HTMLDivElement>(null)
  const turns = item?.turns ?? []
  const live = draft && item && draft.itemId === item.id ? draft : null

  // Keep the newest turn in view as it streams.
  useEffect(() => {
    const el = list.current
    if (el) el.scrollTop = el.scrollHeight
  }, [turns.length, live?.prose, live?.plan, live?.review.length, item?.id])

  return (
    <div className="turns" ref={list}>
      {item && !turns.length && !live && <p className="turns-empty">Describe what you want below.</p>}

      {turns.map((t) => {
        if (t.role === 'user') {
          return (
            <div key={t.id} className="turn user enter">
              {MODE_LABEL[t.mode] && <span className="turn-mode">{MODE_LABEL[t.mode]}</span>}
              {t.text}
            </div>
          )
        }
        return (
          <div key={t.id} className={`turn assistant enter${t.error ? ' failed' : ''}`}>
            {t.text && <div className="turn-text">{t.text}</div>}
            {t.plan && <Plan text={t.plan} open={false} />}
            {t.review && t.review.length > 0 && <Review points={t.review} onApply={onApplyReview} disabled={busy} />}
            {t.error && <div className="turn-error">{t.error}</div>}
            {t.version && (
              <button
                className={`version-chip${t.version === viewedVersion ? ' current' : ''}`}
                onClick={() => onVersion(t.version!)}
                title={t.version === viewedVersion ? 'On the canvas' : 'Show this version'}
              >
                v{t.version}
                {t.mode === 'edit' ? ' · edited by hand' : ''}
              </button>
            )}
          </div>
        )
      })}

      {live && (
        <div className="turn assistant enter">
          {live.prose && <div className="turn-text">{live.prose}</div>}
          {live.plan && <Plan text={live.plan} open />}
          {live.review.length > 0 && (
            <ul className="review-live">
              {live.review.map((p, i) => (
                <li key={i}>{p}</li>
              ))}
            </ul>
          )}
          {phaseLabel && (
            <span key={phaseLabel} className="phase-text working">
              <span className="spinner-dot" /> {phaseLabel}
            </span>
          )}
        </div>
      )}

      {notice}

      {live && thought && showThought && (
        <details className="thought">
          <summary>reasoning</summary>
          <pre>{thought}</pre>
        </details>
      )}
    </div>
  )
}

export default memo(Conversation)
