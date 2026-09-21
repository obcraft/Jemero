// Client for the built-in llama.cpp server's OpenAI-compatible API (electron/model.cjs).
// Reached through the same-origin proxy at /llm (vite.config.ts in development,
// electron/serve.cjs in the app), so the page never makes a cross-origin call.

const BASE = '/llm'

export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string }

export async function listModels(): Promise<string[]> {
  const res = await fetch(`${BASE}/models`)
  if (!res.ok) throw new Error(`model server returned ${res.status}`)
  const json = await res.json()
  return (json.data ?? []).map((m: { id: string }) => m.id)
}

export type ServerState = { ok: boolean; loading: boolean; detail: string }

/**
 * llama-server answers 503 while it's loading weights. That's the normal state
 * for a few seconds after every launch and every switch, not a failure, so it
 * gets its own flag instead of reading as "no model".
 */
export async function ping(): Promise<ServerState> {
  try {
    const models = await listModels()
    return models.length
      ? { ok: true, loading: false, detail: `${models.length} model(s) loaded` }
      : { ok: false, loading: false, detail: 'no model is loaded' }
  } catch (e) {
    const detail = (e as Error).message
    return { ok: false, loading: /\b503\b/.test(detail), detail }
  }
}

/**
 * Reasoning models (DeepSeek-R1 distills) wrap their scratchpad in <think>.
 * Strip it incrementally so it never reaches the file parser, while still
 * reporting it so the UI can show "thinking…".
 */
export class ThinkFilter {
  private inside = false
  private buf = ''
  thought = ''

  push(chunk: string): string {
    this.buf += chunk
    let out = ''
    for (;;) {
      if (!this.inside) {
        const open = this.buf.indexOf('<think>')
        if (open === -1) {
          // Hold back a possible partial "<think" split across chunks.
          const keep = Math.max(0, this.buf.length - 7)
          out += this.buf.slice(0, keep)
          this.buf = this.buf.slice(keep)
          break
        }
        out += this.buf.slice(0, open)
        this.buf = this.buf.slice(open + 7)
        this.inside = true
      } else {
        const close = this.buf.indexOf('</think>')
        if (close === -1) {
          const keep = Math.max(0, this.buf.length - 8)
          this.thought += this.buf.slice(0, keep)
          this.buf = this.buf.slice(keep)
          break
        }
        this.thought += this.buf.slice(0, close)
        this.buf = this.buf.slice(close + 8)
        this.inside = false
      }
    }
    return out
  }

  flush(): string {
    if (this.inside) return ''
    const rest = this.buf
    this.buf = ''
    return rest
  }
}

export type StreamOpts = {
  model: string
  messages: ChatMessage[]
  temperature?: number
  topP?: number
  maxTokens?: number
  /** Ask the chat template to enable or skip reasoning. */
  thinking?: boolean
  signal?: AbortSignal
  onToken: (text: string) => void
  onThought?: (text: string) => void
}

export async function streamChat(opts: StreamOpts): Promise<string> {
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: opts.signal,
    body: JSON.stringify({
      model: opts.model,
      messages: opts.messages,
      temperature: opts.temperature ?? 0.2,
      top_p: opts.topP ?? 0.95,
      max_tokens: opts.maxTokens ?? 4096,
      // Rendered by the model's own jinja template (the server runs --jinja):
      // Qwen3 and friends read enable_thinking, gpt-oss reads reasoning_effort.
      // Templates that know neither simply ignore them, so this is safe to send
      // to every model. Reasoning-only models (R1 distills) think regardless.
      chat_template_kwargs: {
        enable_thinking: opts.thinking ?? false,
        reasoning_effort: opts.thinking ? 'medium' : 'low',
      },
      stream: true,
    }),
  })

  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => '')
    throw new Error(`Model server ${res.status}: ${detail.slice(0, 300)}`)
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  const filter = new ThinkFilter()
  let sseBuf = ''
  let full = ''
  let lastThought = 0

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    sseBuf += decoder.decode(value, { stream: true })

    const lines = sseBuf.split('\n')
    sseBuf = lines.pop() ?? ''

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data:')) continue
      const payload = trimmed.slice(5).trim()
      if (payload === '[DONE]') continue
      let delta = ''
      try {
        const json = JSON.parse(payload)
        delta = json.choices?.[0]?.delta?.content ?? ''
        // Some builds surface reasoning on a separate field.
        const reasoning = json.choices?.[0]?.delta?.reasoning_content
        if (reasoning) opts.onThought?.(reasoning)
      } catch {
        continue
      }
      if (!delta) continue
      const visible = filter.push(delta)
      if (visible) {
        full += visible
        opts.onToken(visible)
      }
      if (filter.thought.length > lastThought) {
        opts.onThought?.(filter.thought.slice(lastThought))
        lastThought = filter.thought.length
      }
    }
  }

  const tail = filter.flush()
  if (tail) {
    full += tail
    opts.onToken(tail)
  }
  return full
}
