import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PythonActions } from './python-actions.mjs'

test('Python only executes the exact reviewed, one-time proposal', async () => {
  const actions = new PythonActions(async () => JSON.stringify({ summary: 'Print a result', code: 'print(2 + 3)' }))
  const proposal = await actions.propose('calculate 2 + 3')
  assert.equal(proposal.code, 'print(2 + 3)')
  assert.match(await actions.execute(proposal.id), /Output: 5/)
  await assert.rejects(() => actions.execute(proposal.id), /already used/)
  const denied = await actions.propose('calculate 2 + 3')
  actions.reject(denied.id)
  await assert.rejects(() => actions.execute(denied.id), /already used/)
})

test('invalid proposals fail closed without executing Python', async () => {
  const actions = new PythonActions(async () => '```python\nprint(1)\n```')
  await assert.rejects(() => actions.propose('print 1'), /Nothing was run/)
  await assert.rejects(() => actions.execute('unknown'), /already used/)
  await assert.rejects(() => actions.propose(''), /Describe a Python action/)
})

test('Python proposals target the isolated standard-library runtime', async () => {
  let prompt = ''
  const actions = new PythonActions(async (value) => {
    prompt = value
    return JSON.stringify({ summary: 'Fetch a URL', code: 'import urllib.request\nprint(urllib.request.urlopen("https://example.com").status)' })
  })
  await actions.propose('fetch a URL')
  assert.match(prompt, /Python 3\.9 standard library only/)
  assert.match(prompt, /urllib\.request/)
  assert.match(prompt, /requests/)
})

test('missing modules explain the isolated runtime after approval', async () => {
  const actions = new PythonActions(async () => JSON.stringify({ summary: 'Import a package', code: 'import requests' }))
  const proposal = await actions.propose('import requests')
  await assert.rejects(() => actions.execute(proposal.id), /'requests' is unavailable there.*Request a new proposal using only the Python 3\.9 standard library/s)
})