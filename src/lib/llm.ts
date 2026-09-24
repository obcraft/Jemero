// Client for the built-in llama.cpp server's OpenAI-compatible API (electron/model.cjs).
// Reached through the same-origin proxy at /llm (vite.config.ts in development,
// electron/serve.cjs in the app), so the page never makes a cross-origin call.

import { bridge } from './models'

const BASE = '/llm'

export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string }

export async function listModels(): Promise<string[]> {
  const res = await fetch(`${BASE}/models`)
  if (!res.ok) throw new Error(`model server returned ${res.status}`)
  const json = await res.json()
  return (json.data ?? []).map((m: { id: string }) => m.id)
}

/** Whether the server can answer now, and with which model ('' when it can't). */
export type ServerState = { ok: boolean; loading: boolean; model: string; detail: string }

/**
 * llama-server answers 503 while it's loading weights. That's the normal state
 * for a few seconds after every launch and every switch, not a failure, so it
 * gets its own flag instead of reading as "no model". It lists the model on
 * /models during the load as well, so only /health tells loading from ready.
 */
export async function ping(): Promise<ServerState> {
  try {
    const health = await fetch(`${BASE}/health`)
    if (health.status === 503) return { ok: false, loading: true, model: '', detail: 'loading the model' }
    const models = await listModels()
    return models.length
      ? { ok: true, loading: false, model: models[0], detail: `${models.length} model(s) loaded` }
      : { ok: false, loading: false, model: '', detail: 'no model is loaded' }
  } catch (e) {
    const detail = (e as Error).message
    return { ok: false, loading: /\b503\b/.test(detail), model: '', detail }
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

/** The message of an error event's JSON payload, or the payload itself. */
function streamError(payload: string): string {
  try {
    const json = JSON.parse(payload)
    return String(json.error?.message ?? json.message ?? payload).slice(0, 300)
  } catch {
    return payload.trim().slice(0, 300)
  }
}

export async function streamChat(opts: StreamOpts): Promise<string> {
  let maxTokens = opts.maxTokens ?? 4096
  const api = bridge()
  if (api) {
    const budget = await api.chatBudget({ messages: opts.messages, maxTokens, thinking: opts.thinking ?? false })
    maxTokens = budget.maxTokens
    opts.signal?.throwIfAborted()
  }
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: opts.signal,
    body: JSON.stringify({
      model: opts.model,
      messages: opts.messages,
      temperature: opts.temperature ?? 0.2,
      top_p: opts.topP ?? 0.95,
      max_tokens: maxTokens,
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
      // The server reports a failure mid-answer as an `error:` event; ignoring
      // it would pass a cut-off answer off as a finished one.
      if (trimmed.startsWith('error:')) throw new Error(`Model server: ${streamError(trimmed.slice(6))}`)
      if (!trimmed.startsWith('data:')) continue
      const payload = trimmed.slice(5).trim()
      if (payload === '[DONE]') continue
      let json: { error?: unknown; choices?: { delta?: { content?: string; reasoning_content?: string } }[] }
      try {
        json = JSON.parse(payload)
      } catch {
        continue
      }
      if (json.error) throw new Error(`Model server: ${streamError(payload)}`)
      const delta = json.choices?.[0]?.delta?.content ?? ''
      // Some builds surface reasoning on a separate field.
      const reasoning = json.choices?.[0]?.delta?.reasoning_content
      if (reasoning) opts.onThought?.(reasoning)
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
