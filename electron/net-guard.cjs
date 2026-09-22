// The preview boundary, and a record of every attempt to cross it.
//
// Nothing the renderer loads needs the internet: the app, the kits and the
// installed packs are all served from loopback, and model search and downloads
// happen in this (main) process. So every renderer request to anything other
// than 127.0.0.1/localhost is cancelled — a generated component can't pull a
// script, font or image from a CDN, or call an API, even while online — and
// written to a log, so "worked offline" can be checked rather than assumed.
//
// Main-process requests (Hugging Face, the pack server, the llama.cpp release)
// are recorded too. With JEMERO_OFFLINE=1 they fail as if the network were
// down: the packaged-app offline check runs with it.
const fs = require('node:fs')
const path = require('node:path')

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])
const LOCAL_SCHEMES = new Set(['data:', 'blob:', 'file:', 'about:', 'devtools:', 'chrome:', 'chrome-extension:', 'chrome-devtools:'])

function isLocal(url) {
  try {
    const u = new URL(url)
    if (LOCAL_SCHEMES.has(u.protocol)) return true
    return ['http:', 'https:', 'ws:', 'wss:'].includes(u.protocol) && LOOPBACK.has(u.hostname)
  } catch {
    return false
  }
}

function recorder(logFile) {
  return (entry) => {
    const line = JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n'
    try {
      fs.mkdirSync(path.dirname(logFile), { recursive: true })
      fs.appendFileSync(logFile, line)
    } catch {
      /* a log we can't write must not break the app */
    }
    if (entry.blocked) console.warn(`[net-guard] blocked ${entry.source} request: ${entry.url}`)
  }
}

/** Cancel and record every non-loopback request from the app's windows and the canvas. */
function installNetGuard(session, logFile) {
  const record = recorder(logFile)
  session.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
    if (isLocal(details.url)) return callback({})
    // The canvas is a sandboxed subframe; the app itself is the main frame.
    const source = details.frame && details.frame.parent ? 'canvas' : 'app'
    record({ source, url: details.url, type: details.resourceType, blocked: true })
    callback({ cancel: true })
  })
}

/**
 * Record the main process's own external requests. With `offline`, refuse
 * them the way an unplugged network would (fetch rejects with "fetch failed").
 */
function guardFetch(logFile, { offline = false } = {}) {
  const record = recorder(logFile)
  const real = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (!isLocal(url)) {
      record({ source: 'main', url, blocked: offline })
      if (offline) {
        const err = new TypeError('fetch failed')
        err.cause = Object.assign(new Error(`getaddrinfo ENOTFOUND ${new URL(url).hostname}`), { code: 'ENOTFOUND' })
        throw err
      }
    }
    return real(input, init)
  }
}

module.exports = { installNetGuard, guardFetch, isLocal }
