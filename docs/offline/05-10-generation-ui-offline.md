# Offline studio — steps 5–10 and the milestone

Released as **0.9.0**.

## 5 · Serving installed packs

- `electron/pack-routes.cjs`: `GET /packs/manifest.json` (every active pack:
  imports, exports, styles) and `GET /packs/<id>/<version>/files/<path>`. The
  routing table is built from verified signed manifests; no path is joined
  from the URL, and each file is hashed again before it is sent (a changed
  file gets 409 and the pack leaves the manifest).
- Packaged app: routes on `electron/serve.cjs`. Dev: a loopback server Vite
  proxies `/packs` to.
- Canvas: `kits/stage.html` builds one import map (base kit + installed packs,
  passed in the URL hash, `/packs/…` URLs only; a pack never overrides the
  base kit). `stage.js` links a pack's CSS when a module imports it. The
  canvas reloads when the active pack set changes.

## 6 · Packs in generation

- Pass one (`src/lib/packSelect.ts`): the model picks packs from one-line
  descriptions. Online means the signed catalog request just succeeded (not
  Wi-Fi): the whole catalog is offered; otherwise installed packs only.
- Missing packs: the user is asked (size, dependencies), they're installed and
  verified before any code is written. Declined or failed: an installed
  alternative is chosen again and the build goes on.
- Pass two: the prompt lists the chosen packs' exact imports and exports.
- The compiler validates imports against kit + installed packs; imports of a
  catalog pack that isn't installed fail by name, so nothing reaches the
  canvas early. Every saved version records its pack lock.
- The hard-coded "available everywhere" line is gone: built-ins are listed
  from the kit manifest.

## 7 · Setup and pack management

- First launch: **Set up Jemero** — model (recommended preselected), packs
  (recommended preselected), quantization, total download and disk, then the
  Offline ready check.
- **Resources**: searchable catalog of packs, built-in libraries and services
  with Installed / Downloadable / Requires internet; sizes, dependencies,
  progress, cancel, retry, roll back; removing a pack used by saved work asks
  first and names the components.

## 8 · Offline ready, truthfully

`OfflineCheck.tsx` + `offline:check`: runtime starts (`llama-server
--version`), the model answers a one-token request, each pack verifies, a
sample importing every installed pack renders in a real canvas, and no saved
work needs a missing pack or an online service. Each failure has a repair
action. A packaged app missing its runtime now says so instead of downloading
one (`electron/runtime.cjs`).

## 9 · Preview boundary

Canvas CSP allows loopback only; `electron/net-guard.cjs` cancels and logs
every non-loopback request from any window, and records main-process ones
(`JEMERO_OFFLINE=1` refuses them). The prompt tells the model the preview is
offline.

## 10 · Verification

Also in this release: the library moved to SQLite (`electron/library-db.cjs`,
live drafts, crash recovery, one-time `library.json` import); Electron 33 → 44
for `node:sqlite`; small-model hardening (loop detection, continuation after a
cut-off, forced `<file>` opening, compact kit brief for ≤ 4B models, compiler
repairs for misplaced, unused and bare-markup code).

`npm run e2e:offline` drives the real app (dev or `JEMERO_APP=…`), isolated
profile, 14B model. Online: request needing a formula → model picks KaTeX →
install + verify → lock recorded → preview renders KaTeX with its local fonts.
Restart with `JEMERO_OFFLINE=1` and no pack server → the saved component
renders → an offline refinement renders → a block and a section are built from
scratch and render → external request log checked.

## Open

- No production pack host yet: a packaged app downloads packs only when
  `JEMERO_PACKS_URL` points at a published `packs-dist/`.
- One pack (KaTeX) so far; the catalog is ready for more.
- Qwen2.5-Coder 1.5B selects packs correctly but rarely writes a working
  component; acceptance runs on the 14B.
