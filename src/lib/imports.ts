// Small models reliably use <Label> or <CardFooter> without importing them, which
// React reports as a blank screen and a ReferenceError, not a build error. We know
// exactly what the design system exports and where, so repair it deterministically
// instead of asking the model to try again.

import { UI_KIT } from './uikit'

/** exported name -> module path, derived from the kit itself so they can't drift. */
export function buildExportMap(kit: Record<string, string> = UI_KIT): Map<string, string> {
  const map = new Map<string, string>()
  for (const [path, source] of Object.entries(kit)) {
    for (const m of source.matchAll(/^export\s*\{([^}]+)\}/gm)) {
      for (const raw of m[1].split(',')) {
        const name = raw.trim().split(/\s+as\s+/).pop()?.trim()
        if (name) map.set(name, path)
      }
    }
    for (const m of source.matchAll(/^export\s+function\s+([A-Za-z0-9_]+)/gm)) {
      map.set(m[1], path)
    }
  }
  return map
}

// Deliberately stops at the specifier: swallowing the trailing newline would make
// the inserted import land after a blank line.
const IMPORT_LINE = /^[ \t]*import\s[\s\S]*?from\s*['"][^'"]+['"];?/gm

function importedNames(code: string): Set<string> {
  const names = new Set<string>()
  for (const line of code.match(IMPORT_LINE) ?? []) {
    for (const m of line.matchAll(/\{([^}]*)\}/g)) {
      for (const raw of m[1].split(',')) {
        const name = raw.trim().split(/\s+as\s+/).pop()?.trim()
        if (name) names.add(name)
      }
    }
    const def = line.match(/import\s+([A-Za-z0-9_$]+)\s*(?:,|from)/)
    if (def) names.add(def[1])
    const ns = line.match(/\*\s+as\s+([A-Za-z0-9_$]+)/)
    if (ns) names.add(ns[1])
  }
  return names
}

function declaredLocally(code: string, name: string): boolean {
  const re = new RegExp(`(?:function|const|let|class)\\s+${name}\\b`)
  return re.test(code.replace(IMPORT_LINE, ''))
}

function isUsed(code: string, name: string): boolean {
  const body = code.replace(IMPORT_LINE, '')
  return new RegExp(`(?:<\\/?${name}[\\s/>]|\\b${name}\\s*\\()`).test(body)
}

/** Relative specifier from `fromPath` to `toPath`, both repo-relative. */
export function relativeSpecifier(fromPath: string, toPath: string): string {
  const from = fromPath.split('/').slice(0, -1)
  const to = toPath.split('/')
  let i = 0
  while (i < from.length && i < to.length - 1 && from[i] === to[i]) i++
  const up = from.slice(i).map(() => '..')
  const down = to.slice(i)
  const parts = up.length ? [...up, ...down] : ['.', ...down]
  return parts.join('/')
}

/**
 * Adds imports for design-system components the file uses but never imported.
 * @returns the patched source and which names were added.
 */
export function fixMissingImports(
  path: string,
  code: string,
  kit: Record<string, string> = UI_KIT,
): { code: string; added: string[] } {
  if (path in kit) return { code, added: [] }

  const exportMap = buildExportMap(kit)
  const already = importedNames(code)

  // module path -> names to pull from it
  const need = new Map<string, string[]>()
  for (const [name, modulePath] of exportMap) {
    if (already.has(name) || declaredLocally(code, name) || !isUsed(code, name)) continue
    const list = need.get(modulePath) ?? []
    list.push(name)
    need.set(modulePath, list)
  }
  if (!need.size) return { code, added: [] }

  const added: string[] = []
  const lines: string[] = []
  for (const [modulePath, names] of need) {
    names.sort()
    added.push(...names)
    lines.push(`import { ${names.join(', ')} } from '${relativeSpecifier(path, modulePath)}'`)
  }

  // Insert after the file's existing import block so React stays on top.
  const allImports = code.match(IMPORT_LINE)
  if (allImports?.length) {
    const last = allImports[allImports.length - 1]
    const at = code.lastIndexOf(last) + last.length
    return { code: `${code.slice(0, at)}\n${lines.join('\n')}${code.slice(at)}`, added }
  }
  return { code: `${lines.join('\n')}\n\n${code}`, added }
}
