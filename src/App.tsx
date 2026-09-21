import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { listModels, ping, streamChat, trimHistory, type ChatMessage } from './lib/llm'
import { parseArtifacts } from './lib/parser'
import { BASE_DEPS, missingDeps } from './lib/deps'
import { fixMissingImports } from './lib/imports'
import { SYSTEM_PROMPT, buildUserTurn } from './lib/systemPrompt'
import { LOCKED_PATHS, TEMPLATE } from './lib/template'
import { modelLabel, setPriority, startSnapshotSync } from './lib/models'
import {
  applyAppearance,
  effectivePrompt,
  maxTokensFor,
  memoryCharsFor,
  useSettings,
} from './lib/settings'
import {
  getContainer,
  installPackages,
  mountTemplate,
  startDevServer,
  writeFiles,
} from './lib/webcontainer'
import ModelBrowser from './components/ModelBrowser'
import ModelMenu from './components/ModelMenu'
import SettingsPanel from './components/SettingsPanel'
import TerminalView from './components/Terminal'
import CodeView from './components/CodeView'
import Preview from './components/Preview'

type Phase = 'idle' | 'thinking' | 'writing' | 'installing' | 'booting' | 'ready' | 'error'
type Turn = { role: 'user' | 'assistant'; text: string }

/**
 * "Failed to resolve import \"x\"" means the model used a package it never
 * declared. That's a build-system problem, not a creative one — resolve the bare
 * specifier to a package name and install it rather than round-tripping the model.
 */
function missingPackage(err: string): string | null {
  const m = err.match(/Failed to resolve import ["']([^"']+)["']/)
  if (!m) return null
  const spec = m[1]
  if (spec.startsWith('.') || spec.startsWith('/')) return null
  const parts = spec.split('/')
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
}

/** Logs are unbounded otherwise: a long install plus Vite output adds up. */
const MAX_LOG_LINES = 4000

/** Re-parsing the whole stream on every token is O(n²); 70 ms still feels live. */
const PARSE_INTERVAL_MS = 70

const TABS = ['preview', 'code', 'terminal'] as const

/**
 * A broken model or quantization degenerates into one repeated character
 * ("@@@@@@…", "GGGG…"). No real code has 48 identical non-space characters in
 * a row (a long "=====" divider tops out well below that), so seeing it means
 * stop now rather than stream 4k tokens of noise.
 */
const DEGENERATE = /([^\s])\1{47,}$/

const PHASE_LABEL: Record<Phase, string> = {
  idle: 'Idle',
  thinking: 'Model is thinking…',
  writing: 'Writing files…',
  installing: 'Installing packages…',
  booting: 'Starting dev server…',
  ready: 'Ready',
  error: 'Error',
}

/** Keyed on the phase so each change crossfades instead of snapping. */
function PhaseLine({ phase }: { phase: Phase }) {
  return (
    <span key={phase} className="phase-text">
      {PHASE_LABEL[phase]}
    </span>
  )
}

export default function App() {
  const [model, setModel] = useState('')
  const [serverStatus, setServerStatus] = useState('starting the model server…')
  const [serverLoading, setServerLoading] = useState(true)
  const [serverOk, setServerOk] = useState(false)
  // The shell opens the app at #models when nothing is downloaded yet, so a
  // first run lands on the browser rather than on a chat that can't answer.
  const [browserOpen, setBrowserOpen] = useState(() => window.location.hash === '#models')
  const [settingsOpen, setSettingsOpen] = useState(() => window.location.hash === '#settings')
  const [menuOpen, setMenuOpen] = useState(false)
  const modelBtn = useRef<HTMLButtonElement>(null)
  const settings = useSettings()

  const [prompt, setPrompt] = useState('')
  const [turns, setTurns] = useState<Turn[]>([])
  const [thought, setThought] = useState('')
  const [phase, setPhase] = useState<Phase>('idle')
  const [error, setError] = useState<string | null>(null)

  const [files, setFiles] = useState<Record<string, string>>({ ...TEMPLATE })
  const [logs, setLogs] = useState<string[]>([])
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [buildError, setBuildError] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const [tab, setTab] = useState<'preview' | 'code' | 'terminal'>('terminal')

  const history = useRef<ChatMessage[]>([{ role: 'system', content: SYSTEM_PROMPT }])
  const warmup = useRef<Promise<void> | null>(null)
  const devStarted = useRef(false)
  const abort = useRef<AbortController | null>(null)
  const autoInstalled = useRef<Set<string>>(new Set())
  const installed = useRef<Set<string>>(new Set(BASE_DEPS))

  const log = useCallback(
    (line: string) => setLogs((l) => (l.length > MAX_LOG_LINES ? [...l.slice(-MAX_LOG_LINES / 2), line] : [...l, line])),
    [],
  )

  // Theme and motion live on <html>, so the CSS can switch without a re-render.
  useEffect(() => applyAppearance(settings), [settings])

  // Keep the model snapshot fresh (and ranked the user's way) for the header
  // menu and the browser.
  useEffect(() => startSnapshotSync(), [])
  useEffect(() => setPriority(settings.modelPriority), [settings.modelPriority])

  // ⌘L and ⌘, from the macOS menu bar.
  useEffect(
    () =>
      window.jemero?.onMenu((which) => {
        if (which === 'models') setBrowserOpen(true)
        else setSettingsOpen(true)
      }),
    [],
  )

  // Watch the built-in model server.
  useEffect(() => {
    let cancelled = false
    const check = async () => {
      const result = await ping()
      if (cancelled) return
      setServerOk(result.ok)
      setServerStatus(result.detail)
      setServerLoading(result.loading)
      if (result.ok) {
        const ids = await listModels().catch(() => [])
        if (cancelled) return
        // The server holds exactly one model at a time, so it — not a stale
        // selection — is the truth about what a prompt will be answered by.
        setModel(ids[0] ?? '')
      }
    }
    void check()
    // No point probing a local server while nobody is looking at the window.
    const id = setInterval(() => {
      if (!document.hidden) void check()
    }, 5000)
    const onVisible = () => !document.hidden && void check()
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      cancelled = true
      clearInterval(id)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [])

  /**
   * Boot the sandbox and run the base `npm install` immediately, in parallel with
   * the model's first generation — by the time tokens stop, deps are usually there.
   */
  const warmSandbox = useCallback(() => {
    if (!warmup.current) {
      warmup.current = (async () => {
        const wc = await getContainer(log)
        await mountTemplate(wc, log)
        await installPackages(wc, [], log)
      })().catch((e) => {
        log(`✗ ${(e as Error).message}`)
        throw e
      })
    }
    return warmup.current
  }, [log])

  const submit = useCallback(async (override?: string) => {
    const text = (override ?? prompt).trim()
    if (!text || !model || phase === 'thinking' || phase === 'writing') return

    setPrompt('')
    setError(null)
    setBuildError(null)
    setThought('')
    setTurns((t) => [...t, { role: 'user', text }, { role: 'assistant', text: '' }])
    setPhase('thinking')
    if (settings.autoSwitchTabs) setTab('code')

    const warming = warmSandbox()

    const generated = Object.keys(files).filter((p) => !(p in TEMPLATE))
    const isFirst = history.current.length === 1
    // A prompt edited in Settings applies to the next conversation, not to one
    // already under way — swapping it mid-thread would contradict the history
    // the model has already been shown.
    if (isFirst) history.current[0] = { role: 'system', content: effectivePrompt(settings) }
    history.current.push({
      role: 'user',
      content: buildUserTurn(text, [...Object.keys(TEMPLATE), ...generated], isFirst),
    })

    abort.current?.abort()
    const controller = new AbortController()
    abort.current = controller

    let raw = ''
    // parseArtifacts re-reads the whole accumulated stream, so calling it per
    // token is quadratic — on a five-file app that is thousands of passes over a
    // growing string, and three setStates each time. Coalesce instead: parse on
    // a fixed interval, and once more when the stream ends.
    let lastParse = 0
    let broken: Error | null = null
    const flush = () => {
      const parsed = parseArtifacts(raw)
      if (parsed.files.length) setPhase('writing')
      setTurns((t) => {
        const last = t[t.length - 1]
        if (last?.text === parsed.prose) return t
        const next = [...t]
        next[next.length - 1] = { role: 'assistant', text: parsed.prose }
        return next
      })
      if (parsed.files.length) {
        setFiles((prev) => {
          let changed = false
          const merged = { ...prev }
          for (const f of parsed.files) {
            if (merged[f.path] === f.content) continue
            merged[f.path] = f.content
            changed = true
          }
          return changed ? merged : prev
        })
      }
    }

    try {
      await streamChat({
        model,
        messages: trimHistory(history.current, memoryCharsFor(settings)),
        temperature: settings.temperature,
        topP: settings.topP,
        maxTokens: maxTokensFor(settings),
        thinking: settings.thinking,
        signal: controller.signal,
        onThought: settings.showReasoning
          ? (t) => setThought((prev) => (prev + t).slice(-4000))
          : undefined,
        onToken: (token) => {
          raw += token
          if (!broken && DEGENERATE.test(raw.slice(-64))) {
            // Record first, then abort: the catch below treats a plain abort as
            // the user pressing Stop and stays quiet, which would hide this.
            broken = new Error(
              `The model started repeating “${raw.slice(-1)}” endlessly — its output is broken, not slow. ` +
                'Switch to another model from the header; if this one keeps doing it, delete and re-download it.',
            )
            controller.abort()
            return
          }
          const now = performance.now()
          if (now - lastParse < PARSE_INTERVAL_MS) return
          lastParse = now
          flush()
        },
      })
      flush()

      if (broken) throw broken
      if (controller.signal.aborted) return
      const parsed = parseArtifacts(raw)
      const written = parsed.files.filter((f) => f.complete)
      if (!written.length) {
        throw new Error(
          'Model produced no complete <file> blocks. Try a more capable model or rephrase the prompt.',
        )
      }
      history.current.push({ role: 'assistant', content: raw })

      setPhase('installing')
      if (settings.autoSwitchTabs) setTab('terminal')
      await warming
      if (controller.signal.aborted) return
      const wc = await getContainer(log)

      // Repair design-system imports the model forgot — otherwise React renders a
      // blank page and neither Vite nor we would report anything.
      const repaired = written.map((f) => {
        if (!settings.autoFixImports) return f
        const { code, added } = fixMissingImports(f.path, f.content)
        if (added.length) log(`  fixed imports in ${f.path}: ${added.join(', ')}`)
        return { ...f, content: code }
      })
      setFiles((prev) => {
        const merged = { ...prev }
        for (const f of repaired) merged[f.path] = f.content
        return merged
      })

      // The model's own <install> hints, plus anything it imported without asking.
      const fileMap = Object.fromEntries(repaired.map((f) => [f.path, f.content]))
      const needed = [
        ...new Set([
          ...parsed.installs.filter((p) => !installed.current.has(p)),
          ...(settings.autoInstallDeps ? missingDeps(fileMap, installed.current) : []),
        ]),
      ]
      if (needed.length) {
        log(`↻ dependencies needed: ${needed.join(', ')}`)
        const code = await installPackages(wc, needed, log)
        if (code === 0) needed.forEach((p) => installed.current.add(p))
        else log('✗ package install failed — preview may not build')
      }

      // Written after installing, so an HMR update never lands on a missing dep.
      await writeFiles(wc, fileMap, log)

      if (controller.signal.aborted) return
      if (!devStarted.current) {
        devStarted.current = true
        setPhase('booting')
        const url = await startDevServer(wc, log, setBuildError)
        setPreviewUrl(url)
      } else {
        log('  HMR will pick up the changes')
      }
      setPhase('ready')
      if (settings.autoSwitchTabs) setTab('preview')
    } catch (e) {
      if (controller.signal.aborted && !broken) return
      const message = (broken ?? (e as Error)).message
      setError(message)
      log(`✗ ${message}`)
      setPhase('error')
    }
  }, [prompt, model, phase, files, warmSandbox, log, settings])

  // The sandbox posts render/runtime errors up; treat the payload as plain data.
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const d = e.data as { __atomic?: boolean; kind?: string; message?: string } | null
      if (!d || d.__atomic !== true || typeof d.message !== 'string') return
      setBuildError(`${d.kind ?? 'Error'}: ${d.message}`)
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [])

  const cancel = useCallback(() => {
    abort.current?.abort()
    setPhase('idle')
    setThought('')
    setTurns((t) => {
      const next = [...t]
      const last = next[next.length - 1]
      if (last?.role === 'assistant') {
        next[next.length - 1] = { role: 'assistant', text: `${last.text}\n\n— stopped` .trim() }
      }
      return next
    })
    log('■ stopped')
  }, [log])

  // Esc stops whatever is running.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') cancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [cancel])

  // Self-heal missing dependencies before bothering the model.
  useEffect(() => {
    if (!buildError || !settings.autoInstallDeps) return
    const pkg = missingPackage(buildError)
    if (!pkg || autoInstalled.current.has(pkg)) return
    autoInstalled.current.add(pkg)
    void (async () => {
      log(`↻ missing dependency "${pkg}" — installing it`)
      const wc = await getContainer(log)
      const code = await installPackages(wc, [pkg], log)
      if (code === 0) {
        log(`✓ installed ${pkg}`)
        setBuildError(null)
      }
    })()
  }, [buildError, log, settings.autoInstallDeps])

  const repair = useCallback(() => {
    if (!buildError) return
    void submit(
      `The dev server failed to compile with this error:\n\n${buildError}\n\n` +
        'Fix it and output the corrected file(s) in full.',
    )
  }, [buildError, submit])

  const busy = phase === 'thinking' || phase === 'writing' || phase === 'installing' || phase === 'booting'
  const examples = useMemo(
    () => [
      'A pomodoro timer with start, pause and reset, and a circular progress ring',
      'A markdown note-taking app with a live preview pane',
      'A tip calculator with a bill amount, tip slider and per-person split',
    ],
    [],
  )

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo">⬢</span>
          <div>
            <strong>Jemero</strong>
            <span className="sub">prompt → app, on a local model</span>
          </div>
        </div>
        <div className="topbar-right">
          <div className="model-anchor">
            <button
              className={`model-btn${menuOpen ? ' open' : ''}`}
              ref={modelBtn}
              onClick={() => setMenuOpen((v) => !v)}
              title="Switch the local model"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
            >
              <span className={serverOk ? 'dot ok' : 'dot bad'} />
              <span className="model-name">{modelLabel(model) || 'Choose a model'}</span>
              <svg className="model-caret" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round">
                <path d="M6 9l6 6 6-6" />
              </svg>
            </button>
            {menuOpen && (
              <ModelMenu
                anchorRef={modelBtn}
                onClose={() => setMenuOpen(false)}
                onBrowse={() => {
                  setMenuOpen(false)
                  setBrowserOpen(true)
                }}
                onActive={(id) => setModel(id)}
              />
            )}
          </div>
          <button
            className="icon-btn"
            onClick={() => setSettingsOpen(true)}
            title="Settings"
            aria-label="Settings"
          >
            {/* Gear (Lucide "settings", ISC licence). */}
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
          </button>
        </div>
      </header>

      <ModelBrowser
        open={browserOpen}
        onClose={() => {
          setBrowserOpen(false)
          if (window.location.hash === '#models') window.location.hash = ''
        }}
        onActive={(id) => setModel(id)}
      />
      <SettingsPanel open={settingsOpen} onClose={() => setSettingsOpen(false)} />

      <div className="body">
        <section className="chat">
          <div className="turns">
            {!turns.length && (
              <div className="hint">
                <h2>Describe an app.</h2>
                <p>
                  It gets generated by your local model, then installed and run in a
                  WebContainer sandbox in this tab.
                </p>
                <div className="examples">
                  {examples.map((ex) => (
                    <button key={ex} onClick={() => setPrompt(ex)}>{ex}</button>
                  ))}
                </div>
                {!serverOk && serverLoading && (
                  <p className="loading-note">
                    <span className="spinner-dot" /> Loading the model…
                  </p>
                )}
                {!serverOk && !serverLoading && (
                  <p className="warn">
                    No model is running yet.{' '}
                    <button className="link" onClick={() => setBrowserOpen(true)} title={serverStatus}>
                      Pick one for this Mac
                    </button>{' '}
                    — it downloads and starts by itself.
                  </p>
                )}
              </div>
            )}
            {turns.map((t, i) => (
              <div key={i} className={`turn ${t.role} enter`}>
                {t.text || (t.role === 'assistant' && busy ? <PhaseLine phase={phase} /> : '')}
              </div>
            ))}
            {thought && busy && settings.showReasoning && (
              <details className="thought">
                <summary>reasoning</summary>
                <pre>{thought}</pre>
              </details>
            )}
            {error && <div className="turn error enter">{error}</div>}
            {buildError && !busy && (
              <div className="turn build-error enter">
                <strong>Build failed</strong>
                <pre>{buildError}</pre>
                <button onClick={repair}>Ask the model to fix it</button>
              </div>
            )}
          </div>

          <div className="composer">
            <textarea
              value={prompt}
              placeholder={
                serverOk ? 'Build me…' : serverLoading ? 'Loading the model…' : 'No model is serving — pick one from the header'
              }
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit()
              }}
              rows={3}
            />
            {busy ? (
              <button className="stop" onClick={cancel}>
                <span className="stop-icon" /> Stop · {PHASE_LABEL[phase]}
                <span className="kbd">esc</span>
              </button>
            ) : (
              <button
                className="send"
                onClick={() => void submit()}
                disabled={!serverOk || !prompt.trim()}
              >
                Generate ⌘↵
              </button>
            )}
          </div>
        </section>

        <section className="workspace">
          <nav className="tabs">
            <div className="tab-group" style={{ '--tab-index': TABS.indexOf(tab) } as React.CSSProperties}>
              <span className="tab-pill" />
              {TABS.map((t) => (
                <button
                  key={t}
                  className={tab === t ? 'tab active' : 'tab'}
                  onClick={() => setTab(t)}
                  aria-current={tab === t}
                >
                  {t}
                </button>
              ))}
            </div>
            <span className="phase">
              <PhaseLine phase={phase} />
            </span>
            <button
              className="icon-btn"
              onClick={() => {
                setBuildError(null)
                setReloadKey((k) => k + 1)
              }}
              disabled={!previewUrl}
              title="Reload preview"
              aria-label="Reload preview"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                <path d="M21 12a9 9 0 1 1-2.64-6.36" />
                <path d="M21 3v6h-6" />
              </svg>
            </button>
          </nav>
          {/* All three stay mounted — the preview iframe and the WebContainer
              service worker behind it must not be torn down on a tab switch —
              so visibility is a class, not `hidden`, and can be transitioned. */}
          <div className="pane">
            <div className={`fill slot${tab === 'preview' ? ' shown' : ''}`}>
              <Preview
                url={previewUrl}
                reloadKey={reloadKey}
                status={busy ? PHASE_LABEL[phase] : 'No preview yet — send a prompt.'}
              />
            </div>
            <div className={`fill slot${tab === 'code' ? ' shown' : ''}`}>
              <CodeView files={files} libraryPaths={LOCKED_PATHS} />
            </div>
            <div className={`fill slot${tab === 'terminal' ? ' shown' : ''}`}>
              <TerminalView lines={logs} theme={settings.theme} />
            </div>
          </div>
        </section>
      </div>
    </div>
  )
}
