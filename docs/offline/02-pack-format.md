# Offline studio — step 2: pack format

Source of truth: `electron/pack-format.cjs` (validator, lock helpers, on-disk
hash check). Renderer types: `src/lib/packs.ts`. Tests: `tests/packs.test.cjs`.
Format version: **1**.

## Catalog

One list, two kinds of entry, told apart by `kind`:

- **`local`** — a downloadable pack: files on disk, `offline: true`. Installed
  once, then it works with no network.
- **`cloud`** — an online-only service: nothing is installed, `offline: false`,
  has an `https` endpoint. Listed so the generator knows it exists and the
  offline checks can refuse it by type.

```json
{
  "formatVersion": 1,
  "packs": [
    {
      "formatVersion": 1,
      "id": "radix-ui",
      "version": "1.4.3",
      "name": "Radix UI",
      "category": "primitives",
      "kind": "local",
      "offline": true,
      "size": { "download": 412000, "installed": 1380000 },
      "dependencies": ["react"],
      "imports": { "@radix-ui/react-dialog": "vendor/radix-ui__react-dialog.js" },
      "exports": { "@radix-ui/react-dialog": ["Root", "Trigger", "Portal", "Overlay", "Content", "Title", "Description", "Close"] },
      "assets": [],
      "files": { "vendor/radix-ui__react-dialog.js": "sha256-<64 hex>" }
    },
    {
      "formatVersion": 1,
      "id": "example-maps",
      "version": "2025.1.0",
      "name": "Example Maps API",
      "category": "data",
      "kind": "cloud",
      "offline": false,
      "endpoint": "https://api.example.com",
      "dependencies": []
    }
  ]
}
```

## Fields

| Field | Local pack | Cloud service | Rule |
|---|---|---|---|
| `formatVersion` | ✓ | ✓ | `1` |
| `id` | ✓ | ✓ | `a-z 0-9 -`, max 64, unique in the catalog |
| `version` | ✓ | ✓ | semver (`1.4.3`, `1.4.3-rc.1`) |
| `name` | ✓ | ✓ | display name, non-empty |
| `description` | optional | optional | one sentence, ≤ 200 chars; what the generator reads when choosing packs |
| `recommended` | optional | optional | boolean; part of the recommended selection in setup |
| `category` | ✓ | ✓ | runtime, styling, primitives, components, icons, charts, animation, utilities, fonts, data |
| `kind` | `local` | `cloud` | |
| `offline` | `true` | `false` | must match the kind |
| `size` | `{ download, installed }` bytes | — | whole bytes ≥ 0 |
| `dependencies` | pack ids | pack ids | must exist; no cycles; a local pack never depends on a cloud service |
| `imports` | specifier → file | — | npm-style specifier; file inside the pack (no `..`, no absolute path, no URL); no specifier provided by two packs |
| `exports` | specifier → names | — | one entry per import; valid identifiers |
| `assets` | `[{ path, type }]` | — | CSS, woff/woff2, svg, png, json, js; inside the pack |
| `files` | path → `sha256-<hex>` | — | every import target and asset must be listed |
| `endpoint` | — | `https://…` | |

A local pack must provide at least one import or asset.

## Project lock

Every saved `Version` in the library (`src/lib/library.ts`) can carry the
exact versions it was rendered with, dependencies included:

```json
{ "formatVersion": 1, "packs": { "react": "19.3.0", "radix-ui": "1.4.3" } }
```

- `lockFor(catalog, ids)` builds it from the packs a version imports
  (`packsForImports` maps import specifiers to pack ids). Cloud services can't
  be locked: their version is whatever the server runs.
- `missingFromLock(lock, installed)` says which packs a reopened version needs
  that aren't installed at that exact version.
- `verifyPackDir(dir, pack)` checks an installed pack file by file against its
  hashes.

`packs` is optional on `Version`: versions saved before packs existed have
none. Filling it in on save is wired up in a later step, once the base bundle
is described as packs.
