// The UI kits a component can be built with. Each one is bundled for the canvas
// by scripts/kits.mjs; this is the app's side of it: what to call them, which
// modules components usually come from, and what the model needs to know to
// use them without guessing.

import type { InstalledManifest } from './packs'

export type KitId = 'shadcn' | 'tailwind'

export type Kit = {
  id: KitId
  name: string
  blurb: string
  /** Styled with Tailwind on the canvas (and in the model's output). */
  tailwind: boolean
  /** Where a component used without an import is looked up, in order. */
  autoImport: (manifest: Manifest) => string[]
  /** The kit's part of the system prompt. */
  prompt: (manifest: Manifest) => string
}

export type Manifest = {
  version: number
  versions: Record<string, string>
  imports: Record<string, string>
  exports: Record<string, string[]>
  /** shadcn/ui sources by path, e.g. "components/ui/button.jsx". */
  sources: Record<string, string>
}

/**
 * The base kit's own libraries, as the build installed them (manifest.versions),
 * with what each is for. Only the ones actually in this build are listed;
 * downloadable packs are described separately, per request (systemPrompt.ts).
 */
const BUILT_IN_ROLE: [spec: string, pkg: string, role: string][] = [
  ['lucide-react', 'lucide-react', 'icons'],
  ['motion/react', 'motion', 'animation'],
  ['clsx', 'clsx', 'class names'],
  ['date-fns', 'date-fns', 'dates'],
  ['recharts', 'recharts', 'charts'],
]

function builtIns(m: Manifest): string {
  const libs = BUILT_IN_ROLE.filter(([spec]) => m.imports[spec]).map(
    ([spec, pkg, role]) => `${spec}${m.versions[pkg] ? ` ${m.versions[pkg]}` : ''} (${role})`,
  )
  return libs.length ? `Built in, always installed: ${libs.join(', ')}.` : ''
}

/** The kit manifest plus the installed packs' modules: what the compiler accepts. */
export function withPacks(m: Manifest, installed: InstalledManifest): Manifest {
  const imports = { ...m.imports }
  const exports = { ...m.exports }
  for (const p of Object.values(installed.packs)) {
    for (const spec of Object.keys(p.imports)) {
      if (imports[spec]) continue // the base kit wins: one React
      imports[spec] = installed.imports[spec]
      exports[spec] = p.exports[spec] ?? []
    }
  }
  return { ...m, imports, exports }
}

const TOKENS =
  'Colours come from theme tokens that switch for dark mode by themselves: bg-background, bg-card, bg-popover, ' +
  'bg-muted, bg-accent, bg-primary, text-foreground, text-muted-foreground, text-primary-foreground, border, ring.'

const uiModules = (m: Manifest) => Object.keys(m.exports).filter((s) => s.startsWith('@/components/ui/')).sort()

export const KITS: Kit[] = [
  {
    id: 'shadcn',
    name: 'shadcn/ui',
    blurb: 'Radix primitives styled with Tailwind',
    tailwind: true,
    autoImport: (m) => [...uiModules(m), '@/lib/utils'],
    prompt: (m) => `KIT: shadcn/ui (Radix + Tailwind CSS v4). Every component below is installed. Import from these paths:
${uiModules(m)
  // A few names per module, not all of them: a full list reads like a
  // template, and small models copy it whole into every file.
  .map((s) => {
    const names = m.exports[s].filter((n) => n !== 'default' && !/Variants$/.test(n))
    return `  ${s}: ${names.slice(0, 6).join(', ')}${names.length > 6 ? ', …' : ''}`
  })
  .join('\n')}
  @/lib/utils: cn
${builtIns(m)}

USAGE THAT MATTERS:
- Import only what the file uses, once each.
- Searchable list or combobox: Popover + Command. CommandInput filters the CommandItems live by their value.
- <SelectItem value="…"> needs a non-empty value.
- <Slider value={[n]} onValueChange={([v]) => setN(v)} />, <Switch checked={on} onCheckedChange={setOn} />
- Dialog, Sheet, Popover, DropdownMenu and Tooltip: wrap the trigger with <XTrigger asChild><Button …/></XTrigger>.
- ${TOKENS}`,
  },
  {
    id: 'tailwind',
    name: 'Tailwind CSS',
    blurb: 'No component library, just utilities',
    tailwind: true,
    autoImport: () => ['@/lib/utils'],
    prompt: (m) => `KIT: Tailwind CSS v4 only. No component library: build from semantic HTML elements and handle the
interaction yourself (useState, keyboard handlers, click-outside with useEffect).
${builtIns(m)} cn() from '@/lib/utils' merges classes.

- ${TOKENS}`,
  },
]

export const kitById = (id: KitId | string | undefined): Kit => KITS.find((k) => k.id === id) ?? KITS[0]

/** Kits that were once offered (Headless UI, Material UI, Mantine) fall back to shadcn/ui. */
export const isKitId = (id: unknown): id is KitId => KITS.some((k) => k.id === id)

let manifest: Promise<Manifest> | null = null

/** What scripts/kits.mjs built: the import map, every module's exports, the shadcn sources. */
export function loadManifest(): Promise<Manifest> {
  manifest ??= fetch('/kits/manifest.json').then(async (res) => {
    if (!res.ok) throw new Error('The UI kits are not built yet. Run `npm run kits`, then reload.')
    return (await res.json()) as Manifest
  })
  // A failed load shouldn't stick: the next call tries again.
  manifest.catch(() => {
    manifest = null
  })
  return manifest
}
