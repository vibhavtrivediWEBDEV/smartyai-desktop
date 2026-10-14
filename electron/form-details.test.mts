import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { FormDetailStore } from './form-details.mjs'

test('contact details require explicit save, stay scoped, and can be removed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jarvis-form-details-'))
  const file = join(directory, 'details.json')
  try {
    const store = new FormDetailStore(file)
    await store.load()
    assert.deepEqual(store.list(), [])
    const entry = await store.save({ origin: 'https://example.com', name: 'Alex', email: '', phone: '', address: '' })
    assert.equal(store.list()[0].name, 'Alex')
    assert.equal((await stat(file)).mode & 0o777, 0o600)
    const restored = new FormDetailStore(file)
    await restored.load()
    assert.deepEqual(restored.list(), [entry])
    assert.match(await readFile(file, 'utf8'), /Alex/)
    await assert.rejects(store.save({ origin: 'https://example.com', name: 'Alex', email: '', phone: '', address: '', password: 'secret' }))
    await assert.rejects(store.save({ origin: 'https://127.0.0.1', name: 'Alex', email: '', phone: '', address: '' }))
    await assert.rejects(store.save({ origin: 'https://example.com', name: '', email: 'not-an-email', phone: '', address: '' }))
    assert.equal(await store.delete(entry.id), true)
    assert.deepEqual(store.list(), [])
    const emptied = new FormDetailStore(file)
    await emptied.load()
    assert.deepEqual(emptied.list(), [])
  } finally { await rm(directory, { recursive: true, force: true }) }
})