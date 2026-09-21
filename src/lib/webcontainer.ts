import { WebContainer, type FileSystemTree } from '@webcontainer/api'
import { TEMPLATE } from './template'

type Log = (line: string) => void

let instance: WebContainer | null = null
let booting: Promise<WebContainer> | null = null

/** WebContainer allows exactly one instance per page. */
export async function getContainer(log: Log): Promise<WebContainer> {
  if (instance) return instance
  if (booting) return booting
  if (!crossOriginIsolated) {
    throw new Error(
      'Page is not cross-origin isolated: WebContainer needs COOP/COEP headers (see vite.config.ts).',
    )
  }
  log('$ booting WebContainer…')
  booting = WebContainer.boot().then((wc) => {
    instance = wc
    // Dev-only handle for poking at the sandbox from the browser console.
    if (import.meta.env.DEV) (window as unknown as { wc?: WebContainer }).wc = wc
    log('✓ WebContainer ready')
    return wc
  })
  return booting
}

/** Flat path map -> nested FileSystemTree that mount() expects. */
function toTree(files: Record<string, string>): FileSystemTree {
  const tree: FileSystemTree = {}
  for (const [path, contents] of Object.entries(files)) {
    const parts = path.split('/')
    let node = tree
    parts.forEach((part, i) => {
      if (i === parts.length - 1) {
        node[part] = { file: { contents } }
      } else {
        if (!node[part] || !('directory' in node[part])) node[part] = { directory: {} }
        node = (node[part] as { directory: FileSystemTree }).directory
      }
    })
  }
  return tree
}

async function pipe(stream: ReadableStream<string>, log: Log) {
  const reader = stream.getReader()
  let buf = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += value
    const lines = buf.split('\n')
    buf = lines.pop() ?? ''
    for (const line of lines) log(line)
  }
  if (buf) log(buf)
}

export async function run(
  wc: WebContainer,
  cmd: string,
  args: string[],
  log: Log,
): Promise<number> {
  log(`$ ${cmd} ${args.join(' ')}`)
  const proc = await wc.spawn(cmd, args)
  void pipe(proc.output, log)
  const code = await proc.exit
  if (code !== 0) log(`✗ exited with code ${code}`)
  return code
}

export async function mountTemplate(wc: WebContainer, log: Log) {
  log('$ mounting project template')
  await wc.mount(toTree(TEMPLATE))
}

export async function writeFiles(
  wc: WebContainer,
  files: Record<string, string>,
  log: Log,
) {
  for (const [path, contents] of Object.entries(files)) {
    const dir = path.split('/').slice(0, -1).join('/')
    if (dir) await wc.fs.mkdir(dir, { recursive: true })
    await wc.fs.writeFile(path, contents)
    log(`  wrote ${path}`)
  }
}

export async function installPackages(wc: WebContainer, pkgs: string[], log: Log) {
  const args = pkgs.length ? ['install', ...pkgs] : ['install']
  return run(wc, 'npm', args, log)
}

/**
 * Starts `npm run dev` and resolves with the preview URL once Vite is listening.
 * The dev server keeps running; later file writes are picked up by HMR.
 */
export async function startDevServer(
  wc: WebContainer,
  log: Log,
  onBuildError?: (text: string | null) => void,
): Promise<string> {
  const url = new Promise<string>((resolve) => {
    wc.on('server-ready', (_port, serverUrl) => {
      log(`✓ dev server ready at ${serverUrl}`)
      resolve(serverUrl)
    })
  })

  // Vite reports compile failures on stdout long after the server is "ready",
  // so watch the stream continuously rather than only during startup.
  const ERROR_LINE = /Failed to resolve import|Internal server error|Pre-transform error|\[vite\][^\n]*error/i
  const RECOVERED = /hmr update|page reload/i
  let capture: string[] | null = null
  let timer: ReturnType<typeof setTimeout> | undefined

  const flush = () => {
    if (!capture) return
    const text = capture.join('\n').trim()
    capture = null
    clearTimeout(timer)
    if (text) onBuildError?.(text)
  }

  const watch = (line: string) => {
    const clean = line.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '').trimEnd()
    if (capture) {
      capture.push(clean)
      if (capture.length >= 14) flush()
      return
    }
    if (ERROR_LINE.test(clean)) {
      capture = [clean]
      clearTimeout(timer)
      timer = setTimeout(flush, 700)
    } else if (RECOVERED.test(clean)) {
      onBuildError?.(null)
    }
  }

  log('$ npm run dev')
  const proc = await wc.spawn('npm', ['run', 'dev'])
  void pipe(proc.output, (line) => {
    log(line)
    watch(line)
  })
  return url
}
