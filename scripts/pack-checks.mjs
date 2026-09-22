// Build-time checks every pack must pass before it is signed (scripts/packs.mjs).
//
// 1. Nothing in it makes the canvas reach the network when it runs: no module
//    imported from a URL, no fetch of a remote file, no remote script, image,
//    stylesheet or font. Links in comments, documentation strings and XML
//    namespaces ("http://www.w3.org/2000/svg") are fine: they are text, never
//    requested.
// 2. It doesn't carry its own copy of React. The canvas has exactly one React
//    (the base kit, through the import map); a second copy breaks hooks and
//    context in ways that are hard to trace, so packs import 'react' instead.

const URL_ = String.raw`(?:https?:)?\/\/[^"'\s)]+`

const JS_REMOTE = [
  ['module import from a URL', new RegExp(String.raw`\bimport\s*(?:[\w$*{},\s]+?\s*from\s*)?["']` + URL_ + `["']`, 'g')],
  ['dynamic import from a URL', new RegExp(String.raw`\bimport\(\s*["']` + URL_ + `["']`, 'g')],
  ['fetch of a URL', new RegExp(String.raw`\bfetch\(\s*["'\`]` + URL_, 'g')],
  ['remote worker script', new RegExp(String.raw`\bimportScripts\(\s*["']` + URL_, 'g')],
  ['remote src assigned', new RegExp(String.raw`\.src\s*=\s*["'\`]` + URL_, 'g')],
  ['remote src in markup', new RegExp(String.raw`\bsrc=\\?["']` + URL_, 'g')],
  ['remote href in markup', new RegExp(String.raw`<link[^>]+href=\\?["']` + URL_, 'g')],
  ['remote url() in inline CSS', new RegExp(String.raw`url\(\s*\\?["']?` + URL_, 'g')],
]

const CSS_REMOTE = [
  ['remote url()', new RegExp(String.raw`url\(\s*["']?` + URL_, 'g')],
  ['remote @import', new RegExp(String.raw`@import\s+(?:url\(\s*)?["']?` + URL_, 'g')],
]

/**
 * Remote resources a file would request. Returns [{ what, match }], empty
 * when the file is self-contained.
 * @param {string} text
 * @param {'js' | 'css'} type
 */
export function findRemoteRefs(text, type) {
  const rules = type === 'css' ? CSS_REMOTE : JS_REMOTE
  const found = []
  for (const [what, re] of rules) {
    for (const m of text.matchAll(re)) found.push({ what, match: m[0].slice(0, 120) })
  }
  return found
}

// Strings only React's own source contains.
const REACT_MARKERS = [
  '__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE',
  '__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED',
  '__DOM_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE',
]

/** Does this bundle contain React itself (rather than importing it)? */
export function bundlesReact(text) {
  return REACT_MARKERS.some((m) => text.includes(m))
}

/** Every url(...) in a stylesheet, unquoted, data: URIs left out. */
export function cssUrls(css) {
  return [...css.matchAll(/url\(\s*(["']?)([^"')]+)\1\s*\)/g)].map((m) => m[2]).filter((u) => !u.startsWith('data:'))
}

/**
 * Keep only the woff2 source of each @font-face: every browser the canvas runs
 * in reads it, and the woff/ttf copies would triple the download.
 */
export function woff2Only(css) {
  return css.replace(/src:([^;}]+)/g, (whole, list) => {
    const woff2 = list.split(/,(?=\s*url\()/).find((s) => /\.woff2["']?\s*\)/.test(s))
    return woff2 ? `src:${woff2.trim()}` : whole
  })
}
