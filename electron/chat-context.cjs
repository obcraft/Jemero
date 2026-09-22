// Count the rendered prompt with the running model's own tokenizer. Short
// context models need an answer budget that fits alongside the actual prompt.
async function chatBudget(base, { messages, maxTokens = 4096, thinking = false }) {
  const request = async (route, body) => {
    const res = await fetch(`${base}${route}`, {
      ...(body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(15000),
    })
    if (!res.ok) throw new Error(`Could not check the model’s context (${res.status}).`)
    return res.json()
  }
  const props = await request('/props')
  const ctx = props.default_generation_settings?.n_ctx
  if (!Number.isFinite(ctx) || ctx <= 0) throw new Error('The model did not report a usable context window.')
  const rendered = await request('/apply-template', {
    messages, add_generation_prompt: true,
    chat_template_kwargs: { enable_thinking: thinking, reasoning_effort: thinking ? 'medium' : 'low' },
  })
  if (typeof rendered.prompt !== 'string') throw new Error('The model could not format this prompt.')
  const tokenized = await request('/tokenize', { content: rendered.prompt, add_special: true, parse_special: true })
  if (!Array.isArray(tokenized.tokens)) throw new Error('The model could not count this prompt.')
  const remaining = ctx - tokenized.tokens.length - 32
  if (remaining < 64) throw new Error(`This prompt fills the model’s ${ctx.toLocaleString()}-token context. Shorten the prompt or use a model with a larger context.`)
  return { maxTokens: Math.max(1, Math.min(maxTokens, remaining)), context: ctx }
}
module.exports = { chatBudget }
