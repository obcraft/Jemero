# Offline studio — step 1: baseline

Recorded 2026-09-23 on `main` at `d3f173a` (working tree clean: the earlier
session's edits are all committed in `eb373b6`, `8e50779`, `d3f173a`).

## Health

| Check | Result |
|---|---|
| `npm test` | 12 / 12 pass, 0 fail |
| `npm run build` | passes (kits up to date, Vite build ~0.65 s) |
| `npx tsc --noEmit` | clean |

No existing failures.

## External requests (everything that leaves 127.0.0.1)

All from the Electron main process; the renderer and the canvas make none.

| Where | What | When | Offline today |
|---|---|---|---|
| `electron/runtime.cjs:96` | `github.com/ggml-org/llama.cpp/releases/download/b11067/…tar.gz` | only if llama-server is neither bundled (`Resources/llama`) nor vendored (`vendor/llama`) | fine when packaged: the runtime ships as an extraResource |
| `electron/install.cjs:143` | `huggingface.co/api/models/<repo>?blobs=true` | model download: SHA-256 lookup | fails → download unavailable |
| `electron/install.cjs:243` | `huggingface.co/<repo>/resolve/main/<file>` | model download | fails |
| `electron/hub.cjs:40` | `huggingface.co/api/models?search=…` | Models page search | fails → error shown |
| `electron/gguf.cjs:28` | `huggingface.co/…` range request for GGUF headers | sizing search results | fails |
| `electron/main.cjs:53` | `shell.openExternal(url)` | links opened in the browser (e.g. the model repo link, `ModelBrowser.tsx:416`) | user-initiated, not needed to work |
| `scripts/check-hub-live.mjs` | huggingface.co, raw.githubusercontent.com | dev script only | n/a |

Local only (allowed): `electron/model.cjs:45`, `electron/main.cjs:84`,
`electron/chat-context.cjs:5`, `electron/serve.cjs:27` (proxy `/llm` →
`127.0.0.1:8757`), `src/lib/llm.ts` (`/llm/...`), `src/lib/kits.ts:82`
(`/kits/manifest.json`).

## What the canvas needs

The canvas is `public/kits/stage.html` in a sandboxed iframe, served by the
app's own server (Vite in dev, `electron/serve.cjs` from `dist/` when
packaged). Everything is local, built by `scripts/kits.mjs`:

| Asset | Loaded by |
|---|---|
| `stage.html` (+ inline import map, 106 specifiers, **0 external**) | iframe src |
| `stage.js` | `<script type="module">` |
| `tailwind-theme.css` (theme tokens + tw-animate) | `fetch('./tailwind-theme.css')` in `loadKit` |
| `tailwind.js` (`@tailwindcss/browser`, compiles classes at runtime) | `loadScript` in `loadKit` |
| `vendor/*.js` (React 19, Radix, cmdk, sonner, input-otp, react-day-picker, recharts, lucide, motion, date-fns, clsx, cva, tailwind-merge) | import map, on first import |
| `manifest.json` (exports per module, shadcn sources) | the app, for the compiler and the prompt |

`public/kits` is 5.4 MB in total.

Packages bundled today: react, react-dom, clsx, tailwind-merge,
class-variance-authority, date-fns, lucide-react, motion, framer-motion,
radix-ui (+ 60 `@radix-ui/*`), cmdk, sonner, input-otp, react-day-picker,
recharts. There is no pack concept yet: it is one fixed bundle, rebuilt only by
`npm run kits` at development time.

## Gaps found (for the later steps)

- **No CSP on the canvas.** Generated code can request `https://` images,
  fonts or `fetch()`; offline these fail silently or break the preview. Nothing
  stops the model from writing them (`src/lib/systemPrompt.ts` doesn't forbid
  remote assets).
- **No "offline ready" state.** Nothing checks that a model is installed, the
  runtime is present and the kits are complete before a flight.
- **Unknown packages are rejected, not installed.** `src/lib/compile.ts`
  reports modules missing from the import map; there is no fetch-and-install
  path and no fallback to an installed alternative beyond the lucide icon
  mapping.
- **Dev-mode runtime** relies on `vendor/llama` being present; if it isn't,
  the first run downloads it from GitHub.

## Minimal UI stays bundled

The app shell (`dist/`: React app, styles, the compiler) and the base canvas
(`public/kits` → `dist/kits`) ship inside the app today and need no network to
open. Any later pack system must keep this set as the always-present base, so
setup can open before packs are downloaded.
