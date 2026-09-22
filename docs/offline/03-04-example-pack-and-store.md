# Offline studio — steps 3 & 4: example pack and pack store

## Step 3 — one complete example pack: KaTeX

`npm run packs` (`scripts/packs.mjs`) builds, checks and signs packs into
`packs-dist/` (gitignored). It runs on a developer's machine or in CI; the app
only downloads the result.

KaTeX 0.18.7 proves the whole shape: **JavaScript** (`katex.js`, 14 exports),
**CSS** (`katex.css`) and **local assets** (20 `.woff2` fonts the CSS refers to
by relative path). 22 files, 538 KB.

Build checks (`scripts/pack-checks.mjs`), any failure stops the build:

- **No CDN.** JS: no import/dynamic import/fetch/script/src/href/url() of a
  remote URL. CSS: no remote `url()` or `@import`. Every CSS `url()` must
  resolve to a file shipped in the pack. Links in comments and XML namespaces
  are allowed (never requested).
- **One React.** Every specifier of the base kit (React, React DOM, Radix, …)
  and of the pack's dependencies is external, imported through the canvas's
  import map. A bundle that contains React's internals fails the build.
- **woff2 only.** `@font-face` sources are reduced to woff2 (woff/ttf dropped).
- The manifest must pass `validatePack` and the index `validateCatalog`.

Signing: Ed25519. `npm run packs:keygen` wrote the private key to
`.keys/pack-signing.pem` (gitignored; for CI, set `JEMERO_PACK_SIGNING_KEY`)
and the public key to `electron/pack-trust.json`, which ships in the app.
Current key id: `b849c8150c039ce9`.

Published layout:

```
packs-dist/index.signed.json
packs-dist/katex/0.18.7/manifest.signed.json
packs-dist/katex/0.18.7/files/{katex.js, katex.css, fonts/*.woff2}
```

## Step 4 — the pack store

`electron/pack-store.cjs`, root `~/Library/Application Support/Jemero/packs/`:

```
installed.json              { formatVersion, packs: { id: { version, previous, activatedAt } } }
catalog.signed.json         last index that verified (offline listing)
<id>/<version>/             active pack, never written to again
.staging/<id>@<version>/    download in progress, kept for resume
```

Install: signed index → closure of dependencies → disk check (installed size
×1.1 against free space) → per pack: signed manifest (must match the index) →
each file to staging with `Range` resume, 3 retries with backoff, sha256 check
(a mismatch is refetched once, then fails) → verify every file → rename
staging into place → replace `installed.json` by rename → keep only the active
and previous version.

Guarantees, each covered by `tests/pack-store.test.cjs`:

| Situation | Result |
|---|---|
| Connection drops mid-file | resumes with `Range`, previous version active meanwhile |
| Corrupt file | clear error, previous version still active and verifies |
| Unknown key / edited index | refused, nothing installed |
| Not enough disk | refused before downloading, with both sizes |
| Cancel | staging kept, next install resumes |
| Server unreachable | pack list served from the cached signed index |

Source URL: `JEMERO_PACKS_URL`; in development without it, `packs-dist/` is
served on 127.0.0.1 (`electron/static-server.cjs`). A packaged build has no
default source yet — deciding where packs are hosted is open.

UI: the **Resources** page (rail) lists packs with size, disk needed,
Install/Update/Retry, progress with Cancel, Remove, and the error in plain text;
cloud services appear separately as "Online only".

## Not yet (later steps)

- The canvas doesn't load installed packs yet (import map + asset serving).
- The generator doesn't choose packs; `Version.packs` isn't filled on save.
- No production pack host.
