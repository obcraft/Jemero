import { useCallback, useEffect, useMemo, useState } from 'react'
import Stage, { type StageEvent } from './Stage'
import { compile } from '../lib/compile'
import { bridge } from '../lib/models'
import type { Item } from '../lib/library'
import type { Manifest } from '../lib/kits'
import { importedSpecifiers, isCloudService, packOfSpecifier, type CatalogEntry, type InstalledManifest } from '../lib/packs'

type Row = { key: string; label: string; ok: boolean; detail: string; action?: { label: string; run: () => void } }

/**
 * "Offline ready", only when it's true: the runtime starts, a model answers,
 * every installed pack verifies, a sample that imports each of them renders
 * in a real canvas, and no saved work needs a missing pack or the internet.
 */
export default function OfflineCheck({
  items,
  installed,
  catalog,
  manifest,
  onOpenModels,
  onInstall,
}: {
  items: Item[]
  installed: InstalledManifest
  catalog: CatalogEntry[]
  /** The kit manifest with installed packs merged in (withPacks). */
  manifest: Manifest | null
  onOpenModels: () => void
  onInstall: (id: string) => void
}) {
  const [shell, setShell] = useState<Awaited<ReturnType<NonNullable<ReturnType<typeof bridge>>['offlineCheck']>> | null>(null)
  const [canvas, setCanvas] = useState<{ ok: boolean; detail: string } | null>(null)
  const [running, setRunning] = useState(false)
  const [run, setRun] = useState(0)

  const check = useCallback(async () => {
    const api = bridge()
    if (!api) return
    setRunning(true)
    setCanvas(null)
    setShell(null)
    setRun((n) => n + 1)
    try {
      setShell(await api.offlineCheck())
    } finally {
      setRunning(false)
    }
  }, [])

  useEffect(() => {
    void check()
  }, [check])

  // A sample importing one module of every installed pack, next to a kit component.
  const sample = useMemo(() => {
    if (!manifest) return null
    const specs = Object.values(installed.packs).map((p) => Object.keys(p.imports)[0]).filter(Boolean)
    const code = [
      `import { Button } from '@/components/ui/button'`,
      ...specs.map((s, i) => `import * as pack${i} from '${s}'`),
      `export default function Preview() {`,
      `  const loaded = [${specs.map((_, i) => `Object.keys(pack${i}).length`).join(', ')}]`,
      `  return <Button data-jm-ready={loaded.every((n) => n > 0) ? 'yes' : 'no'}>Ready {loaded.length}</Button>`,
      `}`,
    ].join('\n')
    const out = compile({ 'Sample.jsx': code }, 'Sample.jsx', 'shadcn', manifest)
    return out.ok ? { code: { entry: out.entry, modules: out.modules }, error: null } : { code: null, error: out.error }
  }, [manifest, installed])

  useEffect(() => {
    if (sample?.error) setCanvas({ ok: false, detail: sample.error })
  }, [sample])

  const onStage = useCallback((e: StageEvent) => {
    if (e.type === 'rendered') setCanvas({ ok: true, detail: `Rendered in ${Math.round(e.ms)} ms` })
    if (e.type === 'error') setCanvas({ ok: false, detail: e.message })
  }, [])

  // Saved work: packs it needs that aren't installed, and online services it uses.
  const projects = useMemo(() => {
    const rows: Row[] = []
    const services = catalog.filter(isCloudService)
    for (const item of items) {
      const v = item.versions.at(-1)
      if (!v) continue
      for (const [id, version] of Object.entries(v.packs?.packs ?? {})) {
        if (installed.packs[id]?.version === version) continue
        const inCatalog = catalog.find((p) => p.id === id)
        rows.push({
          key: `${item.id}:${id}`,
          label: item.name,
          ok: false,
          detail: `Needs ${inCatalog?.name ?? id} ${version}${installed.packs[id] ? ` (installed: ${installed.packs[id].version})` : ''}`,
          action: inCatalog ? { label: 'Install', run: () => onInstall(id) } : undefined,
        })
      }
      for (const spec of importedSpecifiers(v.files)) {
        if (manifest?.imports[spec] || packOfSpecifier(installed, spec)) continue
        const pack = catalog.find((p) => p.kind === 'local' && spec in p.imports)
        if (pack && !rows.some((r) => r.key === `${item.id}:${pack.id}`)) {
          rows.push({ key: `${item.id}:${pack.id}`, label: item.name, ok: false, detail: `Needs ${pack.name}`, action: { label: 'Install', run: () => onInstall(pack.id) } })
        }
      }
      const text = Object.values(v.files).join('\n')
      for (const s of services) {
        const host = new URL(s.endpoint).host
        if (text.includes(host)) {
          rows.push({ key: `${item.id}:${s.id}`, label: item.name, ok: false, detail: `Uses ${s.name}, which needs the internet` })
        }
      }
    }
    return rows
  }, [items, installed, catalog, manifest, onInstall])

  if (!bridge()) return null

  const rows: Row[] = []
  if (shell) {
    rows.push({
      key: 'runtime',
      label: 'Runtime',
      ok: shell.runtime.ok,
      detail: shell.runtime.detail,
    })
    rows.push({
      key: 'model',
      label: 'Model',
      ok: shell.model.ok,
      detail: shell.model.detail,
      action: shell.model.ok ? undefined : { label: 'Pick a model', run: onOpenModels },
    })
    for (const [id, r] of Object.entries(shell.packs)) {
      rows.push({
        key: `pack:${id}`,
        label: installed.packs[id]?.name ?? id,
        ok: r.ok,
        detail: r.ok ? `Verified · ${r.detail}` : r.detail,
        action: r.ok ? undefined : { label: 'Reinstall', run: () => onInstall(id) },
      })
    }
  }
  rows.push({
    key: 'canvas',
    label: 'Canvas',
    ok: !!canvas?.ok,
    detail: canvas?.detail ?? 'Rendering a sample…',
  })
  rows.push(...projects)

  const done = !!shell && !!canvas
  const problems = rows.filter((r) => !r.ok).length
  const ready = done && problems === 0

  return (
    <div className={`offline-check${ready ? ' ready' : ''}`}>
      <div className="offline-head">
        <strong>{!done || running ? 'Checking…' : ready ? 'Offline ready' : `Not offline ready · ${problems} to fix`}</strong>
        <button className="btn ghost small" onClick={() => void check()} disabled={running}>
          Check again
        </button>
      </div>
      <ul className="offline-rows">
        {rows.map((r) => (
          <li key={r.key} className={r.ok ? 'ok' : done ? 'bad' : ''}>
            <span className="offline-mark">{r.ok ? '✓' : done ? '✕' : '…'}</span>
            <span className="offline-label">{r.label}</span>
            <span className="offline-detail">{r.detail}</span>
            {r.action && done && (
              <button className="btn small" onClick={r.action.run}>
                {r.action.label}
              </button>
            )}
          </li>
        ))}
      </ul>
      {/* The real canvas, off screen: the sample must load every pack through it. */}
      {sample?.code && (
        <div className="offline-stage" aria-hidden="true">
          <Stage
            key={run}
            code={sample.code}
            kit="shadcn"
            packs={{ key: Object.keys(installed.imports).sort().join(','), imports: installed.imports, styles: installed.styles }}
            layout="center"
            theme="light"
            bg="plain"
            width="fit"
            variant={null}
            resetKey={0}
            onEvent={onStage}
          />
        </div>
      )}
    </div>
  )
}
