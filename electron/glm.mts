import { z } from 'zod'

const callSchema = z.strictObject({
  id: z.string().min(1).max(128), type: z.literal('function'),
  function: z.strictObject({ name: z.enum(['open_app', 'open_downloads', 'open_website']), arguments: z.string().max(4096) }),
})
const responseSchema = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string().nullable().optional(), tool_calls: z.array(callSchema).optional() }) })).min(1),
})

const tools = [
  { type: 'function', function: { name: 'open_app', description: 'Request to launch a named macOS application after user confirmation.', parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'], additionalProperties: false } } },
  { type: 'function', function: { name: 'open_downloads', description: 'Request to open the Downloads folder in Finder after user confirmation.', parameters: { type: 'object', properties: {}, required: [], additionalProperties: false } } },
  { type: 'function', function: { name: 'open_website', description: 'Request to open an HTTPS website after user confirmation.', parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'], additionalProperties: false } } },
] as const

const argumentsSchema = {
  open_app: z.strictObject({ name: z.string().trim().min(1).max(80) }),
  open_downloads: z.strictObject({}),
  open_website: z.strictObject({ url: z.string().max(2048).refine((value) => {
    try {
      const url = new URL(value)
      return url.protocol === 'https:' && !url.username && !url.password
    } catch { return false }
  }) }),
}
export type GLMTool = keyof typeof argumentsSchema
type Message = { role: 'user' | 'assistant' | 'tool'; content: string | null; tool_calls?: z.infer<typeof callSchema>[]; tool_call_id?: string }

export type GLMProvider = 'zai' | 'bedrock-mantle'

export function glmProvider(): GLMProvider {
  const value = process.env.JARVIS_GLM_PROVIDER || 'bedrock-mantle'
  if (value !== 'zai' && value !== 'bedrock-mantle') throw new Error('JARVIS_GLM_PROVIDER must be zai or bedrock-mantle.')
  return value
}

export function glmKey(provider = glmProvider()): string | undefined {
  return provider === 'bedrock-mantle' ? process.env.BEDROCK_MANTLE_API_KEY : process.env.JARVIS_GLM_API_KEY
}

async function complete(messages: Message[], signal: AbortSignal, key: string | undefined, client: typeof fetch, provider: GLMProvider, allowTools: boolean) {
  if (!key?.trim()) throw new Error(`GLM-5 is not configured. Set ${provider === 'bedrock-mantle' ? 'BEDROCK_MANTLE_API_KEY' : 'JARVIS_GLM_API_KEY'} and restart Jarvis.`)
  if (provider !== 'zai' && provider !== 'bedrock-mantle') throw new Error('Unsupported GLM-5 provider.')
  const url = provider === 'bedrock-mantle'
    ? 'https://bedrock-mantle.ap-south-1.api.aws/v1/chat/completions'
    : 'https://api.z.ai/api/paas/v4/chat/completions'
  let response: Response
  try {
    response = await client(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key.trim()}` },
      body: JSON.stringify({ model: provider === 'bedrock-mantle' ? 'zai.glm-5' : 'glm-5', messages, stream: false, max_tokens: 1024, ...(provider === 'bedrock-mantle' ? { temperature: 0.2, thinking: { type: 'disabled' } } : {}), ...(allowTools ? { tools, tool_choice: 'auto' } : {}) }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
    })
  } catch (error) {
    if (signal.aborted) throw error
    throw new Error('GLM-5 request failed or timed out. Check your connection and try again.', { cause: error })
  }
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) throw new Error(`GLM-5 rejected the API key or access (HTTP ${response.status}). Check your ${provider} key and account permissions.`)
    if (response.status === 429) throw new Error('GLM-5 rate limit or quota reached (HTTP 429). Check your provider account.')
    throw new Error(`GLM-5 request failed (HTTP ${response.status}). Check your provider account and try again.`)
  }
  const parsed = responseSchema.safeParse(await response.json())
  if (!parsed.success) throw new Error('GLM-5 returned an invalid response.')
  return parsed.data.choices[0].message
}

export async function askGLM(request: string, signal: AbortSignal, key = glmKey(), client: typeof fetch = fetch, provider = glmProvider()): Promise<string> {
  const message = await complete([{ role: 'user', content: request }], signal, key, client, provider, false)
  const text = message.content?.trim()
  if (!text) throw new Error('GLM-5 returned no text response.')
  return text
}

export async function askGLMWithTools(
  request: string, signal: AbortSignal, execute: (name: GLMTool, args: Record<string, string>) => Promise<string>,
  key = glmKey(), client: typeof fetch = fetch, provider = glmProvider(),
): Promise<string> {
  const messages: Message[] = [{ role: 'user', content: request }]
  const seen = new Set<string>()
  for (let round = 0; round <= 3; round++) {
    if (signal.aborted) throw new Error('Cancelled')
    const message = await complete(messages, signal, key, client, provider, true)
    const calls = message.tool_calls
    if (!calls?.length) {
      const text = message.content?.trim()
      if (!text) throw new Error('GLM-5 returned no text response.')
      return text
    }
    if (round === 3 || seen.size + calls.length > 3) throw new Error('GLM-5 requested too many tool actions; stopped.')
    messages.push({ role: 'assistant', content: message.content ?? null, tool_calls: calls })
    for (const call of calls) {
      if (seen.has(call.id)) throw new Error('GLM-5 repeated a tool call identifier; stopped.')
      seen.add(call.id)
      let raw: unknown
      try { raw = JSON.parse(call.function.arguments) } catch { throw new Error('GLM-5 returned invalid tool arguments.') }
      const args = argumentsSchema[call.function.name].safeParse(raw)
      if (!args.success) throw new Error('GLM-5 returned invalid tool arguments.')
      if (signal.aborted) throw new Error('Cancelled')
      const result = await execute(call.function.name, args.data)
      if (signal.aborted) throw new Error('Cancelled')
      messages.push({ role: 'tool', tool_call_id: call.id, content: result.slice(0, 2048) })
    }
  }
  throw new Error('GLM-5 tool actions stopped.')
}