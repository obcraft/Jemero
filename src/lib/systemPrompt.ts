// What the model is told. The system prompt is three parts: the base rules
// (editable in Settings), the kit's own brief (kits.ts), and what size of thing
// is being built. Requests are stateless: a follow-up sends the current code
// plus a short list of earlier requests instead of the whole conversation, so a
// long refinement session never overflows a 16k context.
import type { InstalledPack } from './packs'
import { kitById, type KitId, type Manifest } from './kits'
import type { Item, Kind, Version } from './library'

export const SYSTEM_PROMPT = `You are a senior design engineer. You design and build ONE piece of React UI at a time for a
live preview canvas: a component, a block or a page section. Never a whole app, and never a page shell around it.

THE FILE:
1. One .jsx file named after the component in PascalCase, e.g. OtpInput.jsx. Plain JavaScript, no TypeScript.
2. export function OtpInput(props) {…}: the reusable component. Its data and callbacks come in as props, with
   sensible defaults.
3. export default function Preview() {…}: renders the component with realistic sample data, wired to useState so
   everything really works. Only the component: no page title, no heading, no explanation around it.
4. Optional: export const variants = { Default: () => <OtpInput />, Error: () => <OtpInput error="Wrong code" /> }
   with 2 to 4 states worth reviewing side by side.
5. The complete file every time. Never "...", never "rest unchanged".
6. Import only what the kit below lists. Nothing else is installed and there is no network. No CSS files, no
   <style> tags.

QUALITY BAR:
- Real behaviour, not placeholders: live filtering, selection, validation, keyboard support, focus handling.
- Accessible: labels, roles and aria attributes, visible focus.
- Edge cases handled: empty, loading, disabled, error, long text (truncate), many items (scroll).
- Looks designed: consistent spacing, clear hierarchy, subtle borders, right in light and dark.`

const FORMAT_WITH_PLAN = `OUTPUT FORMAT (exactly this, nothing after </file>):
One sentence saying what you will build.
<plan>
- Anatomy: the parts, in order
- States: the ones that apply
- Props: data and callbacks, with defaults
- Behaviour: interactions and keyboard
</plan>
<file path="OtpInput.jsx">
…the complete file…
</file>`

const FORMAT_NO_PLAN = `OUTPUT FORMAT (exactly this, nothing after </file>):
One sentence saying what you will build.
<file path="OtpInput.jsx">
…the complete file…
</file>`

const KIND_BRIEF: Record<Kind, string> = {
  component:
    'WHAT YOU BUILD: a single reusable component (a control such as a picker, input, menu, toggle, badge or card). ' +
    'Preview shows it at its natural size, the way it sits in a real interface, not stretched across the canvas.',
  block:
    'WHAT YOU BUILD: a composed block (a form, a card with actions, a settings panel, a list with filters) made of ' +
    'smaller components. Give it a natural width, between max-w-sm and max-w-3xl.',
  section:
    'WHAT YOU BUILD: a full-width page section (hero, feature grid, pricing, testimonials, FAQ, footer). It spans the ' +
    'full width with an inner max-width container, and is responsive from 375px phones up to wide desktops.',
}

export const KIND_LABEL: Record<Kind, string> = { component: 'Component', block: 'Block', section: 'Section' }

export function buildSystem(opts: {
  base: string
  kit: KitId
  kind: Kind
  manifest: Manifest
  plan: boolean
  review?: boolean
  /** Installed packs chosen for this request: their exact imports and exports. */
  packs?: { id: string; pack: InstalledPack }[]
  /** A small model: the kit's compact brief, without import lines to copy. */
  compact?: boolean
}): string {
  const kit = kitById(opts.kit)
  const kitBrief = opts.compact && kit.compactPrompt ? kit.compactPrompt(opts.manifest) : kit.prompt(opts.manifest)
  const format = opts.review ? '' : opts.plan ? FORMAT_WITH_PLAN : FORMAT_NO_PLAN
  // The offline rule sits with the brief, not last: placed at the very end it
  // made small models (Qwen2.5-Coder 1.5B) stop after echoing the request.
  return [opts.base.trim(), format, `${KIND_BRIEF[opts.kind]} ${BOUNDARY}`, kitBrief, packBrief(opts.packs ?? [])]
    .filter(Boolean)
    .join('\n\n')
}

/** The preview has no internet (electron/net-guard.cjs and the canvas CSP block it). */
const BOUNDARY =
  'The preview has no internet, so remote images, fonts, scripts and API calls never load: draw with inline SVG, CSS ' +
  'and the icons, and put realistic sample data in the file.'

/** What the model may import from the packs chosen for this request, and nothing more. */
function packBrief(packs: { id: string; pack: InstalledPack }[]): string {
  if (!packs.length) return ''
  const lines = packs.flatMap(({ pack }) => [
    `  ${pack.name} ${pack.version}${pack.description ? `: ${pack.description}` : ''}`,
    ...Object.keys(pack.imports).map(
      (spec) => `    '${spec}' exports: ${(pack.exports[spec] ?? []).filter((n) => !n.startsWith('__')).join(', ')}`,
    ),
  ])
  return `PACKS, installed for this request. Import them exactly as listed; their stylesheets load by themselves:\n${lines.join('\n')}`
}

function filesBlock(v: Version): string {
  return Object.entries(v.files)
    .map(([path, content]) => `<file path="${path}">\n${content}\n</file>`)
    .join('\n\n')
}

/** The requests that shaped the item so far, oldest first, so a refinement keeps their intent. */
function history(item: Item): string {
  const asked = item.turns
    .filter((t) => t.role === 'user' && (t.mode === 'build' || t.mode === 'refine' || t.mode === 'port'))
    .slice(-6)
    .map((t, i) => `${i + 1}. ${t.text.length > 240 ? `${t.text.slice(0, 240)}…` : t.text}`)
  return asked.length ? `Earlier requests, oldest first:\n${asked.join('\n')}\n\n` : ''
}

export function buildRequest(kind: Kind, prompt: string): string {
  // The closing cue matters to small models: without it Qwen2.5-Coder 1.5B
  // often restates the request and stops, never opening the <file>.
  return `Build this ${kind}: ${prompt}\n\nWrite the <file> now.`
}

export function refineRequest(item: Item, base: Version, n: number, prompt: string): string {
  return `The current ${item.kind}, ${item.name} (version ${n}):

${filesBlock(base)}

${history(item)}Change now: ${prompt}

Rewrite the complete file. Keep everything that already works; change what is asked.`
}

export function repairRequest(item: Item, base: Version, error: string): string {
  return `The current ${item.kind}, ${item.name}:

${filesBlock(base)}

The canvas could not render it:

${error.slice(0, 1500)}

Find the cause and output the complete corrected file. Keep the design and behaviour as they are.`
}

export function portRequest(item: Item, base: Version, fromKit: KitId, toKit: KitId): string {
  return `The current ${item.kind}, ${item.name}, built with ${kitById(fromKit).name}:

${filesBlock(base)}

Rebuild this exact ${item.kind} with ${kitById(toKit).name} instead. Same behaviour, props, states and look, using
that kit's own components. Output the complete file.`
}

export function reviewRequest(item: Item, base: Version): string {
  return `Review this ${item.kind}, ${item.name}, like a demanding senior design engineer:

${filesBlock(base)}

Check accessibility (labels, roles, keyboard, focus), states (empty, loading, disabled, error, long content), visual
polish (spacing, alignment, hierarchy, dark mode), responsiveness, and the props API.

Reply ONLY with this, no code and no plan:
<review>
- one concrete improvement to make in the code, per line
</review>
3 to 6 lines, most important first. No praise.`
}
