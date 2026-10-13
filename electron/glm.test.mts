import assert from 'node:assert/strict'
import { test } from 'node:test'
import { askGLM, askGLMWithTools, glmKey, glmProvider } from './glm.mjs'

test('structured GLM tool calls require a handler and return their results to the model', async () => {
  const requests: Record<string, unknown>[] = []
  const calls: string[] = []
  const result = await askGLMWithTools('Open the report website', new AbortController().signal, async (name, args) => {
    calls.push(`${name}:${JSON.stringify(args)}`)
    return 'Browser accepted the URL.'
  }, 'test-key', async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    requests.push(body)
    if (requests.length === 1) return Response.json({ choices: [{ message: { content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'open_website', arguments: '{"url":"https://example.com/report"}' } }] } }] })
    return Response.json({ choices: [{ message: { content: 'The website opened.' } }] })
  })
  assert.equal(result, 'The website opened.')
  assert.deepEqual(calls, ['open_website:{"url":"https://example.com/report"}'])
  assert.ok(Array.isArray(requests[0].tools))
  assert.deepEqual((requests[1].messages as Record<string, unknown>[]).at(-1), { role: 'tool', tool_call_id: 'call-1', content: 'Browser accepted the URL.' })
})

test('GLM rejects invalid tool arguments and unrecognized tools without executing', async () => {
  for (const [name, args] of [['open_website', '{"url":"file:///etc/passwd"}'], ['run_shell', '{}'], ['open_app', '{"name":"Photos","extra":"unsafe"}']]) {
    let executions = 0
    await assert.rejects(() => askGLMWithTools('test', new AbortController().signal, async () => { executions++; return 'opened' },
      'test-key', async () => Response.json({ choices: [{ message: { content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name, arguments: args } }] } }] })),
    /invalid response|invalid tool arguments/)
    assert.equal(executions, 0)
  }
})

test('GLM stops after three actions and does not execute a fourth', async () => {
  let executions = 0
  let requests = 0
  await assert.rejects(() => askGLMWithTools('test', new AbortController().signal,
    async () => { executions++; return 'opened' }, 'test-key', async () => {
      requests++
      return Response.json({ choices: [{ message: { content: null, tool_calls: [{ id: `call-${requests}`, type: 'function', function: { name: 'open_downloads', arguments: '{}' } }] } }] })
    }), /too many tool actions/)
  assert.equal(executions, 3)
})

test('Z.AI GLM-5 sends only the user message with the configured key', async () => {
  const result = await askGLM('Hello', new AbortController().signal, 'test-key', async (input, init) => {
    assert.equal(input, 'https://api.z.ai/api/paas/v4/chat/completions')
    assert.ok(init)
    assert.equal((init.headers as Record<string, string>).Authorization, 'Bearer test-key')
    assert.deepEqual(JSON.parse(String(init.body)), { model: 'glm-5', messages: [{ role: 'user', content: 'Hello' }], stream: false, max_tokens: 1024 })
    return Response.json({ choices: [{ message: { content: 'Hello back' } }] })
  }, 'zai')
  assert.equal(result, 'Hello back')
})

test('default Bedrock Mantle GLM-5 uses the direct provider endpoint and model', async () => {
  const result = await askGLM('Hello', new AbortController().signal, 'test-key', async (input, init) => {
    assert.equal(input, 'https://bedrock-mantle.ap-south-1.api.aws/v1/chat/completions')
    assert.ok(init)
    assert.equal((init.headers as Record<string, string>).Authorization, 'Bearer test-key')
    assert.deepEqual(JSON.parse(String(init.body)), { model: 'zai.glm-5', messages: [{ role: 'user', content: 'Hello' }], stream: false, max_tokens: 1024, temperature: 0.2, thinking: { type: 'disabled' } })
    return Response.json({ choices: [{ message: { content: 'Mantle reply' } }] })
  })
  assert.equal(result, 'Mantle reply')
})

test('provider selection defaults to Bedrock Mantle and rejects unknown providers', () => {
  const previous = process.env.JARVIS_GLM_PROVIDER
  try {
    delete process.env.JARVIS_GLM_PROVIDER
    assert.equal(glmProvider(), 'bedrock-mantle')
    process.env.JARVIS_GLM_PROVIDER = 'bedrock-mantle'
    assert.equal(glmProvider(), 'bedrock-mantle')
    process.env.JARVIS_GLM_PROVIDER = 'unknown'
    assert.throws(() => glmProvider(), /must be zai or bedrock-mantle/)
  } finally {
    if (previous === undefined) delete process.env.JARVIS_GLM_PROVIDER
    else process.env.JARVIS_GLM_PROVIDER = previous
  }
})

test('default provider takes the Mantle key from the environment', async () => {
  const previous = process.env.BEDROCK_MANTLE_API_KEY
  const previousProvider = process.env.JARVIS_GLM_PROVIDER
  try {
    delete process.env.JARVIS_GLM_PROVIDER
    process.env.BEDROCK_MANTLE_API_KEY = 'mantle-test-key'
    assert.equal(glmKey(), 'mantle-test-key')
    await askGLM('Hi', new AbortController().signal, undefined, async (input, init) => {
      assert.equal(input, 'https://bedrock-mantle.ap-south-1.api.aws/v1/chat/completions')
      assert.ok(init)
      assert.equal((init.headers as Record<string, string>).Authorization, 'Bearer mantle-test-key')
      return Response.json({ choices: [{ message: { content: 'OK' } }] })
    })
  } finally {
    if (previous === undefined) delete process.env.BEDROCK_MANTLE_API_KEY
    else process.env.BEDROCK_MANTLE_API_KEY = previous
    if (previousProvider === undefined) delete process.env.JARVIS_GLM_PROVIDER
    else process.env.JARVIS_GLM_PROVIDER = previousProvider
  }
})

test('missing and rejected keys produce distinct actionable failures', async () => {
  await assert.rejects(() => askGLM('Hi', new AbortController().signal, '', async () => { throw new Error('Should not fetch') }), /not configured/)
  await assert.rejects(() => askGLM('Hi', new AbortController().signal, 'test-key', async () => new Response('secret content', { status: 401 })), /rejected the API key/)
})