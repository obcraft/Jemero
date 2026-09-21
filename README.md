# Atomic Lovable

A minimal Lovable/bolt.new clone, running as a **native macOS app**. You describe an
app, a **local** model writes it, and it gets installed and run in a **WebContainer**
sandbox inside the window. No cloud model, no remote build server — and no other app to
install: the inference runtime ships inside.

The shell is Electron, not Tauri: WebContainer needs Chromium, and Tauri's WKWebView is
not a supported target for it.

## How it works

```
prompt ──► llama-server (built in, Metal)  ──► <file> blocks ──► WebContainer
             127.0.0.1:8757/v1                                   npm install
             via same-origin proxy at /llm                        npm run dev
                                                                  └─► iframe preview
```

- **`electron/runtime.cjs`** — the inference runtime: llama.cpp's official prebuilt
  `llama-server`, pinned to one build. Bundled in the `.app`, vendored in `vendor/llama`
  for development, or fetched once (11 MB) into Application Support as a fallback.
- **`electron/model.cjs`** — starts, stops and switches that server, configured
  exactly as Atomic Chat runs llama.cpp (see **Performance**). It keeps its pid in `server.json`, so it only ever
  stops its own process, and remembers the last model you picked.
- **`electron/hardware.cjs`** + **`electron/catalog.cjs`** — read the Mac (chip, unified
  memory, GPU cores, memory bandwidth) and rank 15 verified models for it.
- **`electron/install.cjs`** — the model store: resumable downloads from Hugging Face
  into `~/Library/Application Support/Atomic Lovable/models`.
- **`src/lib/atomic.ts`** — streaming OpenAI-compatible client. Strips `<think>` blocks
  so reasoning models don't corrupt the file parser.
- **`src/lib/parser.ts`** — pulls `<file path="…">` and `<install>` blocks out of the
  stream as it arrives, so files appear live while the model types.
- **`src/lib/template.ts`** + **`src/lib/uikit.ts`** — a Vite+React scaffold with
  Tailwind, shadcn/ui, lucide-react and recharts pre-mounted. The model composes with
  these instead of hand-writing CSS or touching build config.
- **`src/lib/deps.ts`** / **`src/lib/imports.ts`** — install packages the code imports
  but never declared, and add design-system imports the model forgot.
- **`src/lib/settings.ts`** — the settings store (see **Settings**).

Two details that matter:

1. **Cross-origin isolation.** WebContainer needs `SharedArrayBuffer`, so the page is
   served with `COOP: same-origin` + `COEP: require-corp`.
2. **The model is proxied, not called directly.** `/llm/*` → `127.0.0.1:8757/v1/*`, in
   both the dev server and the packaged app's static server. Same-origin sidesteps CORS
   and the extra rules cross-origin isolation puts on outbound requests.

The base `npm install` starts the moment you hit Generate, in parallel with token
generation, so dependencies are usually warm by the time the model finishes.

## Run it

```bash
npm start
```

Opens the native window, starts the best model you have downloaded (your last pick, or
the recommendation for this Mac), and brings up the UI once it answers. On a Mac with
nothing downloaded yet it opens on the model list instead.

Closing the window quits the app and stops the model server, so the 10+ GB it holds goes
back to macOS. Reopening reloads it — a few seconds while the file is still in the page
cache. Set `ATOMIC_KEEP_WARM=1` to keep it loaded between launches instead.

| script | |
|---|---|
| `npm start` | the app |
| `npm run models` | what this Mac should run, and why (`--priority speed\|quality`, `--json`) |
| `npm run models:install` | download the recommendation (`-- --install <id>` for another) |
| `npm run serve` / `npm run stop` | start / stop the model server without the window |
| `npm run dist` | build `release/Atomic Lovable-<version>-arm64.dmg` |
| `npm run runtime` | re-vendor the llama.cpp runtime into `vendor/llama` |

Shortcuts: **⌘L** models, **⌘,** settings, **⌘↵** generate, **Esc** stop.

## Models

The header button shows what's serving; its menu switches between downloaded models in
a click (a switch is ~2 s once the weights are in the page cache). **Browse all models**
lists everything with speed, size and one button each; **For this Mac** hides what
wouldn't fit.

**How the pick is made.** Decoding a token reads every active weight once, so on Apple
Silicon speed is a memory-bandwidth problem:

```
tokens/sec ≈ 0.75 × memory bandwidth ÷ bytes read per token
```

0.75 is calibrated, not assumed: Qwen2.5-Coder-14B Q4_K_M measured 24.5 tok/s on an M4
Pro (273 GB/s), and the model predicts 24.

- **Fit.** Weights + KV cache at 16k + compute buffers must fit the model budget:
  unified memory minus ~6 GB for Chromium, the sandbox and macOS, and at most Metal's
  wired limit minus 1.5 GB for the display and Chromium's GPU process.
- **Speed.** Dense models read all their weights per token; a mixture-of-experts reads
  only its active experts — why a 30B MoE can outrun a dense 14B.
- **Quantization.** The best-quality quant that still meets the speed target. Nothing
  below 4-bit is offered.
- **Priority** (Settings → Generation): *Speed* wants 35+ tok/s, *Balance* 20+,
  *Quality* will go down to 10 for a stronger model.

Every size in the catalog is the real byte count of the real GGUF, and every KV figure
comes from the model's own config — so "too big" is a fact, not a guess.

Models you downloaded earlier through Atomic Chat are adopted automatically, by hard
link: no copy, no extra disk, and they stay yours if that app is removed.

## Performance

`llama-server` runs with the same configuration Atomic Chat uses:

| flag | why |
|---|---|
| `--n-gpu-layers 999` | every layer on the GPU; unified memory means no copy cost |
| `--flash-attn auto` | on wherever the model supports it |
| f16 KV cache (default) | an 8-bit cache was tried: it halved prompt-processing speed on Metal (a long wait for the first token) and produced `@@@@` garbage on small models |
| `--parallel 1 --kv-unified` | one conversation gets the whole context |
| `--jinja` | each model's own chat template — correct prompt format for every family |
| `--reasoning-format auto` | thinking is returned separately, never mixed into the files |

**Thinking** (Settings → General) is off by default: hybrid models like Qwen3 and gpt-oss
then answer straight away instead of reasoning first. It's sent per request through the
model's own template (`enable_thinking` / `reasoning_effort`), so it applies to any model
that supports it; R1-style distills always think.

If a model ever degenerates into one repeated character, generation stops with a clear
error instead of streaming noise.

In the renderer, the stream is parsed every 70 ms rather than on every token (it re-reads
the whole output, so per-token parsing is quadratic), the preview/code/terminal panes are
memoized, terminal writes are batched, logs are capped, and vendor code is split into
separate chunks — the app's own bundle is 59 kB.

## Settings

Everything in **⌘,** changes what the next generation does:

- **General** — theme (System / Dark / Light), animations, thinking on/off, show
  reasoning, follow the pipeline between tabs, auto-fix imports, auto-install packages.
- **Generation** — model priority, answer length (1.5k / 4k / 6k tokens — the ceilings a
  16k window leaves room for), memory (how much history is kept), temperature, top-p.
- **System prompt** — edit or replace the built-in one. It applies from the next
  conversation; the current one keeps the prompt it started with.

Context size isn't a setting: it's fixed when the server starts, at the 16k this app
needs, and the catalog only offers models that fit it.

## Output format the model must follow

```
<file path="src/App.jsx">
export default function App() { return <h1>Hi</h1> }
</file>

<install>recharts date-fns</install>
```

Full contents every time — no diffs, no "rest unchanged". `parser.ts` is forgiving
about stray markdown fences and single quotes, because small models produce both.

## Install (as a user)

1. Download `Atomic Lovable-<version>-arm64.dmg`, open it, drag the app to **Applications**.
2. Open it. First launch of an ad-hoc signed build: macOS blocks it once — go to
   **System Settings → Privacy & Security → Open Anyway**. (A Developer ID build, below,
   skips this entirely.)
3. The model list opens on its own, with the best model for your Mac marked **Best**.
   Click **Get**: it downloads, is checked against Hugging Face's SHA-256, starts, and
   drops you in the chat — one click, no other app needed.

## Packaging

```bash
npm run dist     # → release/Atomic Lovable-0.1.0-arm64.dmg  (~107 MB)
```

The app carries `llama-server` and its Metal libraries in `Contents/Resources/llama`,
so a fresh Mac needs nothing but a model download. The runtime isn't committed
(`vendor/` is ignored); `npm run dist` fetches it on a fresh clone. Config lives in
`electron-builder.config.cjs`, which picks the signing mode from the environment:

| mode | when | what the user gets |
|---|---|---|
| **ad-hoc** (default) | no certificate present | a valid, sealed bundle; macOS asks once via *Open Anyway* |
| **Developer ID + notarized** | `CSC_NAME` (or `CSC_LINK`) plus `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` | opens with no warning, like Atomic Chat |

The Developer ID mode needs a paid Apple Developer account. It enables the hardened
runtime with the entitlements in `build/entitlements.mac.plist`.

To move to a newer llama.cpp, bump `BUILD` in `electron/runtime.cjs` and run
`npm run runtime`.

## Environment overrides

| variable | default | |
|---|---|---|
| `ATOMIC_MODEL` | your last pick, else the recommendation | serve this model id at startup |
| `ATOMIC_URL` | `http://127.0.0.1:8757` | where the model server listens |
| `ATOMIC_HOME` | `~/Library/Application Support/Atomic Lovable` | models, runtime cache, logs |
| `ATOMIC_LLAMA_BIN` | the bundled runtime | use your own `llama-server` build |
| `ATOMIC_DEV_PORT` | a free port | pin the dev server |
| `ATOMIC_OPEN` | — | `models` or `settings`: open straight onto that panel |
| `ATOMIC_THEME` | the OS | `light` or `dark` for this run |
| `ATOMIC_CAPTURE` | — | write a PNG of the window once loaded |
| `ATOMIC_KEEP_WARM` | — | `1`: leave the model loaded after quitting |

Server log: `~/Library/Application Support/Atomic Lovable/logs/llama-server.log`.

## One window only

Two instances share one `userData` directory and fight over the Service Worker database
WebContainer's preview runs on. A second launch focuses the existing window instead.

## Known limits

- Speed figures are estimates from the bandwidth model (±20%); the ordering is the
  reliable part.
- One WebContainer per window; reload to reset the sandbox. No project persistence yet.
- Follow-ups rewrite whole files rather than patching.
- A 14B model breaks the output format occasionally; the error surfaces with a one-click
  repair pass, which usually but not always converges.
