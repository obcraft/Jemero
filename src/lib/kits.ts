// The UI kits a component can be built with. Each one is bundled for the canvas
// by scripts/kits.mjs; this is the app's side of it: what to call them, which
// modules components usually come from, and what the model needs to know to
// use them without guessing.

export type KitId = 'shadcn' | 'headless' | 'tailwind' | 'mui' | 'mantine'

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

const EXTRAS =
  'Also available everywhere: lucide-react (icons), motion/react (animation), clsx, date-fns, recharts (charts).'

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
  .map((s) => `  ${s}: ${m.exports[s].filter((n) => n !== 'default' && !/Variants$/.test(n)).join(', ')}`)
  .join('\n')}
  @/lib/utils: cn
${EXTRAS}

USAGE THAT MATTERS:
- Searchable list or combobox: Popover + Command. CommandInput filters the CommandItems live by their value.
- <SelectItem value="…"> needs a non-empty value.
- <Slider value={[n]} onValueChange={([v]) => setN(v)} />, <Switch checked={on} onCheckedChange={setOn} />
- Dialog, Sheet, Popover, DropdownMenu and Tooltip: wrap the trigger with <XTrigger asChild><Button …/></XTrigger>.
- ${TOKENS}`,
  },
  {
    id: 'headless',
    name: 'Headless UI',
    blurb: 'Unstyled accessible primitives + Tailwind',
    tailwind: true,
    autoImport: () => ['@headlessui/react', '@/lib/utils'],
    prompt: () => `KIT: Headless UI v2 + Tailwind CSS v4: accessible, unstyled primitives that you style.
  import { Combobox, ComboboxInput, ComboboxOptions, ComboboxOption } from '@headlessui/react'
Components: Menu, MenuButton, MenuItems, MenuItem, MenuSection, MenuHeading, MenuSeparator; Listbox, ListboxButton,
ListboxOptions, ListboxOption; Combobox, ComboboxInput, ComboboxButton, ComboboxOptions, ComboboxOption; Popover,
PopoverButton, PopoverPanel; Dialog, DialogPanel, DialogTitle, DialogBackdrop; Disclosure, DisclosureButton,
DisclosurePanel; TabGroup, TabList, Tab, TabPanels, TabPanel; Switch; RadioGroup, Radio; Checkbox; Field, Label,
Description, Input, Textarea, Select, Fieldset, Legend; Transition; CloseButton.
${EXTRAS} cn() from '@/lib/utils' merges classes.

USAGE THAT MATTERS:
- Floating panels position themselves with anchor: <MenuItems anchor="bottom start">, <ComboboxOptions anchor="bottom">.
- Style state through data attributes: data-focus:bg-accent, data-selected:font-medium, data-open:rotate-180,
  data-checked:bg-primary, data-disabled:opacity-50.
- Combobox filtering is yours: keep a query in state and filter the options from it.
- ${TOKENS}`,
  },
  {
    id: 'tailwind',
    name: 'Tailwind CSS',
    blurb: 'No component library, just utilities',
    tailwind: true,
    autoImport: () => ['@/lib/utils'],
    prompt: () => `KIT: Tailwind CSS v4 only. No component library: build from semantic HTML elements and handle the
interaction yourself (useState, keyboard handlers, click-outside with useEffect).
${EXTRAS} cn() from '@/lib/utils' merges classes.

- ${TOKENS}`,
  },
  {
    id: 'mui',
    name: 'Material UI',
    blurb: 'Google Material Design components',
    tailwind: false,
    autoImport: () => ['@mui/material'],
    prompt: () => `KIT: Material UI v7 (@mui/material) with Emotion. ThemeProvider and CssBaseline already wrap the canvas.
  import { Autocomplete, TextField, InputAdornment, Stack, Paper } from '@mui/material'
Use named imports from '@mui/material'. Style with the sx prop, or styled() from '@mui/material/styles'. No Tailwind.
Icons come from lucide-react, not @mui/icons-material: <Search size={18} />.
${EXTRAS}

USAGE THAT MATTERS:
- Searchable select: <Autocomplete options={options} renderInput={(params) => <TextField {...params} label="Search" />} />
- Adornments: <TextField slotProps={{ input: { startAdornment: <InputAdornment position="start"><Search size={16} /></InputAdornment> } }} />
- Grid: <Grid container spacing={2}><Grid size={{ xs: 12, md: 6 }}>…</Grid></Grid> (no item or xs props). Stack and Box are simpler.
- Colours from the theme so dark mode works: 'primary.main', 'text.secondary', 'background.paper', 'divider'.`,
  },
  {
    id: 'mantine',
    name: 'Mantine',
    blurb: 'Full-featured components and hooks',
    tailwind: false,
    autoImport: () => ['@mantine/core', '@mantine/hooks'],
    prompt: () => `KIT: Mantine v8 (@mantine/core, @mantine/hooks). MantineProvider and its styles already wrap the canvas.
  import { Combobox, useCombobox, TextInput, Group, Stack, Paper } from '@mantine/core'
  import { useDisclosure, useDebouncedValue } from '@mantine/hooks'
Style with component props (variant, size, radius, c, fw) and style props (p, m, w, maw, gap). No Tailwind.
Icons come from lucide-react: <Search size={16} />.
${EXTRAS}

USAGE THAT MATTERS:
- Searchable select: <Select searchable data={['React', 'Vue']} value={v} onChange={setV} />, or Combobox + useCombobox
  for custom option rows.
- Inputs: <TextInput leftSection={<Search size={16} />} value={q} onChange={(e) => setQ(e.currentTarget.value)} />
- Layout: Group (row), Stack (column), SimpleGrid, Card withBorder, Paper.`,
  },
]

export const kitById = (id: KitId | string | undefined): Kit => KITS.find((k) => k.id === id) ?? KITS[0]

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
