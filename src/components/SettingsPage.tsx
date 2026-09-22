import { useEffect, useRef, useState } from 'react'
import { SYSTEM_PROMPT } from '../lib/systemPrompt'
import type { Priority } from '../lib/models'
import {
  ANSWER_HINT,
  ANSWER_TOKENS,
  DEFAULTS,
  resetSettings,
  setSettings,
  useSettings,
  type AnswerLength,
  type Theme,
} from '../lib/settings'

type Tab = 'general' | 'model' | 'prompt'

/**
 * Settings, as a page next to the rail rather than a dialog. Every control here
 * changes what the next generation actually does, and says so underneath, a
 * slider whose effect you can't predict is worse than no slider.
 */
export default function SettingsPage({ onClose }: { onClose: () => void }) {
  const s = useSettings()
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  // Esc leaves the page. Capture phase, so the app's Esc-to-stop doesn't also fire;
  // a dialog opened on top (the model browser) handles its own Esc first.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || document.querySelector('.sheet-backdrop')) return
      e.stopPropagation()
      onCloseRef.current()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])
  const [tab, setTab] = useState<Tab>('general')
  const [draft, setDraft] = useState<string | null>(null)

  const prompt = draft ?? s.systemPrompt
  const promptDirty = draft !== null && draft !== s.systemPrompt
  const usingDefaultPrompt = !prompt.trim()

  const tabs = (['general', 'model', 'prompt'] as const).map((t) => (
    <button key={t} className={tab === t ? 'sheet-tab active' : 'sheet-tab'} onClick={() => setTab(t)}>
      {t === 'general' ? 'General' : t === 'model' ? 'Generation' : 'System prompt'}
    </button>
  ))

  return (
    <section className="page" aria-label="Settings">
      <header className="page-head">
        <div className="sheet-title">
          <strong>Settings</strong>
          <span>Saved on this Mac</span>
        </div>
        <button className="sheet-close" onClick={onClose} aria-label="Close settings" title="Close (Esc)">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </header>
      <div className="page-tabs sheet-tabs">{tabs}</div>
      <div className="page-body">
        <div className="page-inner tab-fade" key={tab}>
          {tab === 'general' && (
            <>
              <Row label="Appearance" hint="Follows macOS by default.">
                <Segmented<Theme>
                  value={s.theme}
                  options={[
                    ['system', 'System'],
                    ['dark', 'Dark'],
                    ['light', 'Light'],
                  ]}
                  onChange={(theme) => setSettings({ theme })}
                />
              </Row>

              <Row label="Animations" hint="Panel and tab transitions.">
                <Toggle value={s.animations} onChange={(animations) => setSettings({ animations })} />
              </Row>

              <h3 className="group-heading">While it builds</h3>

              <Row label="Thinking" hint="Reason before answering. Slower.">
                <Toggle value={s.thinking} onChange={(thinking) => setSettings({ thinking })} />
              </Row>

              <Row label="Show reasoning" hint="Show the thinking while it streams.">
                <Toggle value={s.showReasoning} onChange={(showReasoning) => setSettings({ showReasoning })} />
              </Row>

              <Row label="Plan before coding" hint="Plan first. Better results, a bit slower.">
                <Toggle value={s.planFirst} onChange={(planFirst) => setSettings({ planFirst })} />
              </Row>

              <Row label="Watch the code being written" hint="Show the code tab while it writes.">
                <Toggle value={s.autoSwitchTabs} onChange={(autoSwitchTabs) => setSettings({ autoSwitchTabs })} />
              </Row>

              <Row label="Repair imports" hint="Fix missing imports and icon names.">
                <Toggle value={s.autoFixImports} onChange={(autoFixImports) => setSettings({ autoFixImports })} />
              </Row>

              <button className="btn ghost wide-btn" onClick={() => resetSettings()}>
                Reset everything to defaults
              </button>
            </>
          )}

          {tab === 'model' && (
            <>
              <Row label="Recommend models for" hint="Which model is marked Best.">
                <Segmented<Priority>
                  value={s.modelPriority}
                  options={[
                    ['speed', 'Speed'],
                    ['balanced', 'Balance'],
                    ['quality', 'Quality'],
                  ]}
                  onChange={(modelPriority) => setSettings({ modelPriority })}
                />
              </Row>

              <Row label="Quantization" hint="Prefer 4-bit models: lighter and faster.">
                <Toggle value={s.quantize} onChange={(quantize) => setSettings({ quantize })} />
              </Row>

              <Row
                label="Answer length"
                hint={`${ANSWER_HINT[s.answerLength]} · max_tokens ${ANSWER_TOKENS[s.answerLength].toLocaleString()}`}
              >
                <Segmented<AnswerLength>
                  value={s.answerLength}
                  options={[
                    ['brief', 'Brief'],
                    ['standard', 'Standard'],
                    ['long', 'Long'],
                  ]}
                  onChange={(answerLength) => setSettings({ answerLength })}
                />
              </Row>

              <h3 className="group-heading">Sampling</h3>

              <Row
                label="Temperature"
                hint="Low keeps output reliable."
                value={s.temperature.toFixed(2)}
              >
                <input
                  className="range"
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={s.temperature}
                  onChange={(e) => setSettings({ temperature: Number(e.target.value) })}
                />
              </Row>

              <Row
                label="Top-p"
                hint="Leave at 0.95."
                value={s.topP.toFixed(2)}
              >
                <input
                  className="range"
                  type="range"
                  min={0.5}
                  max={1}
                  step={0.01}
                  value={s.topP}
                  onChange={(e) => setSettings({ topP: Number(e.target.value) })}
                />
              </Row>

            </>
          )}

          {tab === 'prompt' && (
            <>
              <p className="note">
                {usingDefaultPrompt
                  ? 'Using the built-in prompt.'
                  : 'Using your custom prompt.'}
              </p>

              <textarea
                className="prompt-editor"
                value={prompt}
                placeholder={SYSTEM_PROMPT}
                spellCheck={false}
                onChange={(e) => setDraft(e.target.value)}
                rows={16}
              />

              <div className="prompt-actions">
                <span className="hint-text">
                  {prompt.trim() ? `${prompt.length.toLocaleString()} characters` : `default · ${SYSTEM_PROMPT.length.toLocaleString()} characters`}
                </span>
                <div className="prompt-buttons">
                  <button
                    className="btn ghost"
                    onClick={() => {
                      setDraft(SYSTEM_PROMPT)
                    }}
                  >
                    Start from the default
                  </button>
                  <button
                    className="btn ghost"
                    disabled={usingDefaultPrompt && !promptDirty}
                    onClick={() => {
                      setDraft(null)
                      setSettings({ systemPrompt: DEFAULTS.systemPrompt })
                    }}
                  >
                    Use built-in
                  </button>
                  <button
                    className="btn"
                    disabled={!promptDirty}
                    onClick={() => {
                      setSettings({ systemPrompt: draft ?? '' })
                      setDraft(null)
                    }}
                  >
                    {promptDirty ? 'Save' : 'Saved'}
                  </button>
                </div>
              </div>
              <p className="note">Applies to your next prompt.</p>
            </>
          )}
        </div>
      </div>
    </section>
  )
}

export function Row({
  label,
  hint,
  value,
  children,
}: {
  label: string
  hint: string
  value?: string
  children: React.ReactNode
}) {
  return (
    <div className="setting">
      <div className="setting-text">
        <div className="setting-label">
          <span>{label}</span>
          {value !== undefined && <code className="setting-value">{value}</code>}
        </div>
        <p>{hint}</p>
      </div>
      <div className="setting-control">{children}</div>
    </div>
  )
}

function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T
  options: [T, string][]
  onChange: (v: T) => void
}) {
  return (
    <div className="segmented tight">
      {options.map(([id, label]) => (
        <button key={id} className={value === id ? 'seg active' : 'seg'} onClick={() => onChange(id)}>
          {label}
        </button>
      ))}
    </div>
  )
}

export function Toggle({
  value,
  onChange,
  disabled,
}: {
  value: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
}) {
  return (
    <button
      className={value ? 'switch on' : 'switch'}
      role="switch"
      aria-checked={value}
      disabled={disabled}
      onClick={() => onChange(!value)}
    >
      <span className="switch-knob" />
    </button>
  )
}
