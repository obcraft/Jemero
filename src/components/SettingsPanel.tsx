import { useState } from 'react'
import Modal from './Modal'
import { SYSTEM_PROMPT } from '../lib/systemPrompt'
import type { Priority } from '../lib/models'
import {
  ANSWER_HINT,
  ANSWER_TOKENS,
  DEFAULTS,
  MEMORY_CHARS,
  MEMORY_HINT,
  resetSettings,
  setSettings,
  useSettings,
  type AnswerLength,
  type Memory,
  type Theme,
} from '../lib/settings'

type Tab = 'general' | 'model' | 'prompt'

/**
 * Settings. Every control here changes what the next generation actually does,
 * and says so underneath, a slider whose effect you can't predict is worse
 * than no slider.
 */
export default function SettingsPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const s = useSettings()
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
    <Modal open={open} onClose={onClose} title="Settings" subtitle="Saved on this Mac" tabs={tabs}>
      <div className="tab-fade" key={tab}>
        {tab === 'general' && (
          <>
            <Row label="Appearance" hint="Follows macOS unless you pick one.">
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

            <Row label="Animations" hint="Panel and tab transitions. Off is instant.">
              <Toggle value={s.animations} onChange={(animations) => setSettings({ animations })} />
            </Row>

            <h3 className="group-heading">While it builds</h3>

            <Row label="Thinking" hint="Let the model reason first. Off is much faster. R1-style models always think.">
              <Toggle value={s.thinking} onChange={(thinking) => setSettings({ thinking })} />
            </Row>

            <Row label="Show reasoning" hint="Shows the thinking above the answer while it streams.">
              <Toggle value={s.showReasoning} onChange={(showReasoning) => setSettings({ showReasoning })} />
            </Row>

            <Row label="Follow the pipeline" hint="Switches tab to code, then terminal, then preview.">
              <Toggle value={s.autoSwitchTabs} onChange={(autoSwitchTabs) => setSettings({ autoSwitchTabs })} />
            </Row>

            <Row label="Fix forgotten imports" hint="Adds design-system imports the model left out.">
              <Toggle value={s.autoFixImports} onChange={(autoFixImports) => setSettings({ autoFixImports })} />
            </Row>

            <Row label="Install undeclared packages" hint="Installs anything the generated code imports.">
              <Toggle value={s.autoInstallDeps} onChange={(autoInstallDeps) => setSettings({ autoInstallDeps })} />
            </Row>

            <button className="btn ghost wide-btn" onClick={() => resetSettings()}>
              Reset everything to defaults
            </button>
          </>
        )}

        {tab === 'model' && (
          <>
            <Row label="Recommend models for" hint="Changes which model is marked Best.">
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

            <Row
              label="Memory"
              hint={`${MEMORY_HINT[s.memory]} · keeps ${(MEMORY_CHARS[s.memory] / 1000).toFixed(0)}k characters of history`}
            >
              <Segmented<Memory>
                value={s.memory}
                options={[
                  ['short', 'Short'],
                  ['normal', 'Normal'],
                  ['long', 'Long'],
                ]}
                onChange={(memory) => setSettings({ memory })}
              />
            </Row>

            <h3 className="group-heading">Sampling</h3>

            <Row
              label="Temperature"
              hint="Low keeps the output format intact. Above ~0.5 it starts improvising past the spec."
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
              hint="Nucleus sampling. Leave at 0.95 unless you're chasing a specific failure."
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

            <p className="note">
              Context size isn’t here on purpose: it’s fixed when the model server starts, and the
              catalog picks the largest window that fits your Mac. Change the model to change it.
            </p>
          </>
        )}

        {tab === 'prompt' && (
          <>
            <p className="note">
              {usingDefaultPrompt
                ? 'Using the built-in prompt: the design system, the <file> output format and the rules that keep small models on track.'
                : 'Custom prompt. It replaces the built-in one entirely, including the output-format rules. Keep the <file path="…"> blocks or nothing gets written.'}
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
            <p className="note">Takes effect on your next prompt; the current conversation keeps the prompt it started with.</p>
          </>
        )}
      </div>
    </Modal>
  )
}

function Row({
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

function Toggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      className={value ? 'switch on' : 'switch'}
      role="switch"
      aria-checked={value}
      onClick={() => onChange(!value)}
    >
      <span className="switch-knob" />
    </button>
  )
}
