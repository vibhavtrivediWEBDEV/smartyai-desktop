import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { LocationPreference } from './location-preference.mjs'

test('location saves locally, loads after restart and deletes on request', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jarvis-location-'))
  try {
    const file = join(dir, 'location.json')
    const saved = new LocationPreference(file)
    const fullAddress = 'Government Boys Senior Secondary School, Block B, New Ashok Nagar, Nala Road, New Ashok Nagar, Shahdara South, Delhi, East Delhi, Delhi, 110096, India'
    await saved.load()
    assert.equal(saved.get(), null)
    assert.equal(await saved.save(`  ${fullAddress}  `), fullAddress)
    const restarted = new LocationPreference(file)
    await restarted.load()
    assert.equal(restarted.get(), fullAddress)
    await assert.rejects(restarted.save('a'.repeat(301)), /too_big|Invalid/)
    await assert.rejects(restarted.save('https://example.com\nsecret'), /invalid_string|Invalid/)
    await restarted.delete()
    assert.equal(restarted.get(), null)
    await restarted.load()
    assert.equal(restarted.get(), null)
  } finally { await rm(dir, { recursive: true, force: true }) }
})