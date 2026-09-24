# Changelog

## 1.0.0

A stability release: no new features, many fixes to what 0.9.0 advertised.

### Generation and the canvas
- **Stop** stops the model too. In the packaged app the server used to keep generating the whole answer after Stop.
- "Model ready" waits until the weights are actually loaded, at launch, after a switch and in the offline check.
- Errors the model server reports partway through an answer are shown, instead of being blamed on the model.
- A component using `new Map()` or `Infinity` no longer gets lucide icons of those names imported over the built-ins.
- A component that navigates (`location.href = …`, `location.reload()`) no longer breaks the canvas for the session.
- With nothing to show, the previous component is unmounted instead of running on under the overlay.
- A stopped or failed generation is no longer restored as a "recovered" version on the next launch.

### Library
- Saves write only what changed: about 0.5 ms instead of about 40 ms per save on a large library, and no full copy in localStorage.
- A library that fails to load can no longer be wiped by the next save, and one malformed cell no longer hides everything.

### Models
- Downloads always check Hugging Face's SHA-256 and are pinned to one commit. Upstream re-uploads no longer loop.
- A lock left behind by a crash no longer blocks a model for good.
- Importing Atomic Chat models can't delete a download in progress.
- The context ladder tries 512 tokens before calling a model too big.
- The header menu shows why a model didn't start.
- If the last model fails to load, the app opens the model picker instead of an error with a Quit button that didn't quit.
- A missing runtime is reported instead of leaving the window on "Starting…".

### Packs
- A damaged pack can be repaired or removed from Resources.
- A full disk during a download no longer crashes the app, and concurrent installs no longer lose one another.
- Slow but steady downloads are no longer cut off after 30 seconds.
- "Check again" can no longer hang the offline check.

### Setup and settings
- Skipping setup mid-download no longer switches models later. The model list follows the quantization switch, and "More models" returns to setup.
- "Reset everything" keeps setup and the quantization prompt answered.
- Switches, sliders and segmented controls have accessible names. Tab stays inside dialogs, and one Esc closes one layer.

### Build
- `public/kits` build output is no longer committed. A fresh clone rebuilds the kit bundles instead of shipping a canvas with none.
