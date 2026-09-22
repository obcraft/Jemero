// Pass one of a generation: which packs does this request need?
//
// The model sees one line per candidate pack (its id and description) and
// answers with JSON naming the ones it wants, usually none. Candidates are the
// whole supported catalog when the pack server actually answered just now, and
// only what's installed otherwise: a Wi-Fi icon is not a connection, a
// successful catalog request is.
import { streamChat } from './llm'
import type { Kind } from './library'

export type PackCandidate = {
  id: string
  name: string
  description: string
  installed: boolean
  /** Bytes to download; 0 when installed. */
  download: number
  /** Pack ids it pulls in. */
  dependencies: string[]
}

const SYSTEM = `You pick optional libraries for one UI component. Reply with JSON only, no prose:
{"packs": ["id", ...]}
Pick a pack only when the request clearly needs what it does. Most requests need none: reply {"packs": []}.`

/** Parse the model's answer, keeping only ids that were offered. */
export function parseSelection(text: string, offered: string[]): string[] {
  const json = /\{[\s\S]*\}/.exec(text)?.[0]
  if (!json) return []
  try {
    const picked = (JSON.parse(json) as { packs?: unknown }).packs
    if (!Array.isArray(picked)) return []
    return [...new Set(picked.filter((id): id is string => typeof id === 'string' && offered.includes(id)))]
  } catch {
    return []
  }
}

export async function selectPacks(opts: {
  model: string
  kind: Kind
  request: string
  candidates: PackCandidate[]
  signal?: AbortSignal
}): Promise<string[]> {
  if (!opts.candidates.length) return []
  const list = opts.candidates.map((c) => `- ${c.id}: ${c.name}. ${c.description}`).join('\n')
  const answer = await streamChat({
    model: opts.model,
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: `Packs:\n${list}\n\nRequest (a ${opts.kind}): ${opts.request.slice(0, 1200)}` },
    ],
    temperature: 0,
    maxTokens: 64,
    thinking: false,
    signal: opts.signal,
    onToken: () => {},
  })
  return parseSelection(answer, opts.candidates.map((c) => c.id))
}
