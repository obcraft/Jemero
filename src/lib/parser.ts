// Incremental parser for the model's output format.
//
//   <file path="src/App.jsx">  ...code...  </file>
//   <install>react-router-dom clsx</install>
//
// Re-parses the whole buffer on each chunk. Output is bounded (tens of KB), and
// this is far more robust against token-split tags than a streaming state machine.

export type ParsedFile = { path: string; content: string; complete: boolean }
export type Parsed = { files: ParsedFile[]; installs: string[]; prose: string }

const FILE_RE = /<file\s+path=["']([^"']+)["']\s*>([\s\S]*?)<\/file>/g
const OPEN_FILE_RE = /<file\s+path=["']([^"']+)["']\s*>([\s\S]*)$/
const INSTALL_RE = /<install>([\s\S]*?)<\/install>/g

/** Models habitually wrap file bodies in markdown fences. Peel them off. */
function stripFence(raw: string): string {
  let s = raw.replace(/^\n+/, '').replace(/\s+$/, '')
  const fence = s.match(/^```[a-zA-Z0-9+#.-]*\n([\s\S]*?)\n?```$/)
  if (fence) s = fence[1]
  else if (s.startsWith('```')) s = s.replace(/^```[a-zA-Z0-9+#.-]*\n/, '')
  return s
}

function normalizePath(p: string): string {
  return p.trim().replace(/^\.?\//, '').replace(/^\/+/, '')
}

export function parseArtifacts(text: string): Parsed {
  const files: ParsedFile[] = []
  const installs: string[] = []
  let prose = text

  FILE_RE.lastIndex = 0
  for (let m = FILE_RE.exec(text); m; m = FILE_RE.exec(text)) {
    files.push({ path: normalizePath(m[1]), content: stripFence(m[2]), complete: true })
  }
  prose = prose.replace(FILE_RE, '')

  INSTALL_RE.lastIndex = 0
  for (let m = INSTALL_RE.exec(text); m; m = INSTALL_RE.exec(text)) {
    for (const pkg of m[1].split(/[\s,]+/)) {
      const clean = pkg.trim()
      if (clean && !installs.includes(clean)) installs.push(clean)
    }
  }
  prose = prose.replace(INSTALL_RE, '')

  // A file still being written: everything after the last closed </file>.
  const lastClose = text.lastIndexOf('</file>')
  const tail = lastClose === -1 ? text : text.slice(lastClose + 7)
  const open = tail.match(OPEN_FILE_RE)
  if (open) {
    files.push({ path: normalizePath(open[1]), content: stripFence(open[2]), complete: false })
    prose = prose.replace(OPEN_FILE_RE, '')
  }

  // Last write of a path wins, but keep first-seen ordering.
  const byPath = new Map<string, ParsedFile>()
  for (const f of files) {
    const prev = byPath.get(f.path)
    if (prev && prev.complete && !f.complete) continue
    byPath.set(f.path, f)
  }

  return { files: [...byPath.values()], installs, prose: prose.trim() }
}
