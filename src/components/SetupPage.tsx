import { useEffect, useMemo, useRef, useState } from 'react'
import OfflineCheck from './OfflineCheck'
import { bridge, cachedSnapshot, loadSnapshot, watchSnapshot, type CatalogSnapshot, type Progress } from '../lib/models'
import { setSettings, useSettings } from '../lib/settings'
import { Row, Toggle } from './SettingsPage'
import type { Item } from '../lib/library'
import type { Manifest } from '../lib/kits'
import type { InstalledManifest, LocalPack, PackProgress } from '../lib/packs'

const fmt = (bytes: number) =>
  bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : bytes >= 1024 ** 2 ? `${(bytes / 1024 ** 2).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`

type Status = { state: 'waiting' | 'working' | 'done' | 'error'; pct?: number; detail?: string }

/**
 * First run: pick a model and packs (the recommended ones preselected), see
 * what it costs in downloads and disk, get it all, then check it works
 * offline. Everything is optional; Skip leaves it for Models and Resources.
 */
export default function SetupPage({
  packs,
  installed,
  items,
  manifest,
  onDone,
  onOpenModels,
}: {
  packs: LocalPack[]
  installed: InstalledManifest
  items: Item[]
  manifest: Manifest | null
  onDone: () => void
  onOpenModels: () => void
}) {
  const [snap, setSnap] = useState<CatalogSnapshot | null>(null)
  const [model, setModel] = useState<string | null>(null)
  const [chosen, setChosen] = useState<Set<string> | null>(null)
  const [status, setStatus] = useState<Record<string, Status>>({})
  const [phase, setPhase] = useState<'choose' | 'working' | 'check'>('choose')
  const { quantize } = useSettings()
  /** Set once setup is left: a download still running must not switch models or start packs after that. */
  const left = useRef(false)

  useEffect(() => {
    left.current = false
    void loadSnapshot(true).then(setSnap)
    // Re-ranked when the quantization switch or a download changes the catalog.
    const stop = watchSnapshot(() => setSnap(cachedSnapshot()))
    return () => {
      stop()
      left.current = true
    }
  }, [])

  useEffect(() => {
    if (chosen === null && packs.length) setChosen(new Set(packs.filter((p) => p.recommended || installed.packs[p.id]).map((p) => p.id)))
  }, [packs, installed, chosen])

  const models = useMemo(() => {
    if (!snap) return []
    const fitting = snap.models.filter((m) => m.fits)
    const top = fitting.slice(0, 5)
    for (const m of fitting) if (snap.installed.some((i) => i.id === m.modelId && i.complete) && !top.includes(m)) top.push(m)
    return top
  }, [snap])

  const byId = useMemo(() => new Map(packs.map((p) => [p.id, p])), [packs])
  /** Chosen packs plus their dependencies, minus what's installed. */
  const packPlan = useMemo(() => {
    const out: LocalPack[] = []
    const add = (id: string) => {
      const p = byId.get(id)
      if (!p || out.includes(p) || installed.packs[id]?.version === p.version) return
      p.dependencies.forEach(add)
      out.push(p)
    }
    for (const id of chosen ?? []) add(id)
    return out
  }, [chosen, byId, installed])

  // The pick follows the ranking: with quantization switched on, the
  // recommended model is a different (4-bit) file with a different id.
  useEffect(() => {
    if (snap && !models.some((m) => m.modelId === model)) setModel(snap.active ?? snap.recommended)
  }, [snap, models, model])

  const modelPlan = models.find((m) => m.modelId === model) ?? null
  const modelInstalled = !!snap?.installed.some((i) => i.id === model && i.complete)
  const modelBytes = modelPlan && !modelInstalled ? modelPlan.sizeGB * 1024 ** 3 : 0
  const download = modelBytes + packPlan.reduce((n, p) => n + p.size.download, 0)
  const disk = modelBytes + packPlan.reduce((n, p) => n + p.size.installed, 0)

  const finish = () => {
    left.current = true
    // The quantization question was part of setup: don't ask it again on top.
    setSettings({ setupDone: true, quantizePrompt: false })
    onDone()
  }

  async function start() {
    const api = bridge()
    if (!api) return
    setPhase('working')
    const set = (id: string, s: Status) => setStatus((prev) => ({ ...prev, [id]: s }))
    const failed = (err: unknown) => ({ ok: false, reason: (err as Error).message })

    if (model && modelPlan) {
      const stop = api.onProgress((p: Progress) => {
        if (p.id !== model) return
        if (p.phase === 'downloading' || p.phase === 'resuming') set(model, { state: 'working', pct: p.total ? (p.received ?? 0) / p.total : 0 })
        else if (p.phase === 'activating') set(model, { state: 'working', detail: 'Starting…' })
      })
      set(model, { state: 'working' })
      try {
        const got = modelInstalled ? { ok: true } : await api.install(model).catch(failed)
        // Skipped meanwhile: the download is kept, but whatever the user runs now stays.
        if (left.current) return
        const ran = got.ok && snap?.active !== model ? await api.activate(model).catch(failed) : got
        set(model, ran.ok ? { state: 'done' } : { state: 'error', detail: ran.reason })
      } finally {
        stop()
      }
    }

    const stop = api.packs.onProgress((p: PackProgress) => {
      if (!('total' in p) || !p.total) return
      set(p.id, { state: 'working', pct: p.received / p.total })
    })
    try {
      for (const p of packPlan) {
        if (left.current) return
        set(p.id, { state: 'working' })
        const res = await api.packs.install(p.id).catch(failed)
        set(p.id, res.ok ? { state: 'done' } : { state: 'error', detail: res.reason })
      }
    } finally {
      stop()
    }
    if (!left.current) setPhase('check')
  }

  const row = (id: string, name: string, meta: string) => {
    const s = status[id]
    return (
      <li key={id}>
        <span className="offline-mark">{s?.state === 'done' ? '✓' : s?.state === 'error' ? '✕' : s?.state === 'working' ? '…' : '·'}</span>
        <span className="offline-label">{name}</span>
        <span className="offline-detail">
          {s?.state === 'error' ? s.detail : s?.pct != null && s.state === 'working' ? `${Math.round(s.pct * 100)}%` : (s?.detail ?? meta)}
        </span>
      </li>
    )
  }

  return (
    <section className="page" aria-label="Set up Jemero">
      <header className="page-head">
        <div className="sheet-title">
          <strong>Set up Jemero</strong>
          <span>Download once, then work offline</span>
        </div>
        <button className="btn ghost small" onClick={finish}>
          {phase === 'check' ? 'Done' : 'Skip'}
        </button>
      </header>
      <div className="page-body">
        <div className="page-inner">
          {!bridge() ? (
            <p className="note">Open the Mac app to set up models and packs.</p>
          ) : phase === 'choose' ? (
            <>
              <h3 className="group-heading">Model</h3>
              {!snap ? (
                <div className="skeleton-list">
                  <div className="skeleton-row" />
                  <div className="skeleton-row" />
                </div>
              ) : (
                <div className="model-list">
                  {models.map((m) => {
                    const have = snap.installed.some((i) => i.id === m.modelId && i.complete)
                    return (
                      <label key={m.modelId} className={`model-row setup-choice${model === m.modelId ? ' active' : ''}`}>
                        <input type="radio" name="model" checked={model === m.modelId} onChange={() => setModel(m.modelId)} />
                        <div className="row-main">
                          <div className="row-name">
                            <strong>{m.label}</strong>
                            {m.modelId === snap.recommended && <span className="chip">Recommended</span>}
                          </div>
                          <div className="row-meta">
                            {m.sizeGB} GB · ~{m.tokensPerSec} tok/s <span className="row-quant">{m.quant}</span>
                            {have && ' · downloaded'}
                          </div>
                        </div>
                      </label>
                    )
                  })}
                  <button className="text-btn" onClick={onOpenModels}>
                    More models
                  </button>
                </div>
              )}
              <Row label="Prefer quantized models" hint="4-bit: about half the memory, about twice as fast.">
                <Toggle value={quantize} onChange={(q) => setSettings({ quantize: q })} />
              </Row>

              <h3 className="group-heading">Packs</h3>
              <div className="model-list">
                {packs.map((p) => {
                  const on = chosen?.has(p.id) ?? false
                  const have = installed.packs[p.id]?.version === p.version
                  return (
                    <label key={p.id} className={`model-row setup-choice${on ? ' active' : ''}`}>
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={() =>
                          setChosen((prev) => {
                            const next = new Set(prev ?? [])
                            if (next.has(p.id)) next.delete(p.id)
                            else next.add(p.id)
                            return next
                          })
                        }
                      />
                      <div className="row-main">
                        <div className="row-name">
                          <strong>{p.name}</strong>
                          {p.recommended && <span className="chip">Recommended</span>}
                        </div>
                        <div className="row-meta">
                          {p.category} · {fmt(p.size.download)}
                          {p.dependencies.length > 0 && ` · needs ${p.dependencies.map((d) => byId.get(d)?.name ?? d).join(', ')}`}
                          {have && ' · installed'}
                        </div>
                      </div>
                    </label>
                  )
                })}
                {!packs.length && <p className="note list-note">No packs available.</p>}
              </div>

              <div className="setup-summary">
                <span>
                  {download ? `${fmt(download)} to download · ${fmt(disk)} on disk` : 'Nothing to download'}
                  {snap?.freeBytes != null && ` · ${fmt(snap.freeBytes)} free`}
                </span>
                <button className="btn" onClick={() => void start()} disabled={!modelPlan && !packPlan.length}>
                  {download ? 'Download' : 'Continue'}
                </button>
              </div>
            </>
          ) : (
            <>
              <ul className="offline-rows">
                {modelPlan && row(modelPlan.modelId, modelPlan.label, `${modelPlan.sizeGB} GB`)}
                {packPlan.map((p) => row(p.id, p.name, fmt(p.size.download)))}
              </ul>
              {phase === 'check' && (
                <OfflineCheck
                  items={items}
                  installed={installed}
                  catalog={packs}
                  manifest={manifest}
                  onOpenModels={onOpenModels}
                  onInstall={(id) => void bridge()?.packs.install(id)}
                />
              )}
            </>
          )}
        </div>
      </div>
    </section>
  )
}
