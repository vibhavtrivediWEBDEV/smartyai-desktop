import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { MongoClient } from 'mongodb'
import { MongoFormDetailStore } from './mongo-form-details.mjs'

test('MongoDB contact details are scoped, validated, and only reported saved after a write', async () => {
  const documents = new Map<string, Record<string, string>>()
  let rejectWrites = false
  const collection = {
    find: () => ({ toArray: async () => [...documents.values()] }),
    createIndex: async () => 'origin_1',
    replaceOne: async (filter: { origin: string }, entry: Record<string, string>) => {
      if (rejectWrites) throw new Error('write failed')
      documents.set(filter.origin, { ...entry })
    },
    deleteOne: async (filter: { origin: string, id: string }) => {
      if (documents.get(filter.origin)?.id !== filter.id) return { deletedCount: 0 }
      documents.delete(filter.origin)
      return { deletedCount: 1 }
    },
  }
  const client = {
    connect: async () => {}, close: async () => {},
    db: () => ({ collection: () => collection }),
  } as unknown as MongoClient
  const store = new MongoFormDetailStore('mongodb://localhost:27017', client)
  await store.load()
  assert.deepEqual(store.list(), [])
  const entry = await store.save({ origin: 'https://example.com', name: 'Alex', email: '', phone: '', address: '' })
  assert.equal(documents.get(entry.origin)?.name, 'Alex')
  assert.deepEqual(store.list(), [entry])
  rejectWrites = true
  await assert.rejects(store.save({ origin: 'https://example.com', name: 'Bob', email: '', phone: '', address: '' }), /write failed/)
  assert.deepEqual(store.list(), [entry])
  await assert.rejects(store.save({ origin: 'https://127.0.0.1', name: 'Bob', email: '', phone: '', address: '' }), /private/)
  await assert.rejects(store.save({ origin: 'https://example.com', name: '', email: 'invalid', phone: '', address: '' }))
  assert.equal(await store.delete(entry.id), true)
  assert.deepEqual(store.list(), [])
  assert.equal(await store.delete(entry.id), false)
  await store.close()
})