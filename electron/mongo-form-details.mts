import { MongoClient } from 'mongodb'
import { z } from 'zod'
import { parseFormDetails, validateFormDetails, type FormDetails } from './form-details.mjs'

export class MongoFormDetailStore {
  private entries: FormDetails[] = []
  private client: MongoClient

  constructor(uri: string, client?: MongoClient) {
    this.client = client ?? new MongoClient(uri, { serverSelectionTimeoutMS: 5000 })
  }

  private get collection() {
    return this.client.db('jarvis').collection<FormDetails>('form_details')
  }

  async load(): Promise<void> {
    await this.client.connect()
    try {
      const documents = await this.collection.find({}, { projection: { _id: 0 }, limit: 101 }).toArray()
      this.entries = parseFormDetails(documents)
      await this.collection.createIndex({ origin: 1 }, { unique: true })
    } catch (cause) {
      await this.client.close()
      throw new Error('MongoDB form details could not be loaded safely.', { cause })
    }
  }

  list(): FormDetails[] { return this.entries.map((entry) => ({ ...entry })) }

  async save(input: unknown): Promise<FormDetails> {
    const entry = await validateFormDetails(input)
    if (this.entries.length >= 100 && !this.entries.some((item) => item.origin === entry.origin)) throw new Error('Too many saved sites.')
    await this.collection.replaceOne({ origin: entry.origin }, entry, { upsert: true })
    this.entries = [...this.entries.filter((item) => item.origin !== entry.origin), entry]
    return { ...entry }
  }

  async delete(id: unknown): Promise<boolean> {
    if (typeof id !== 'string' || !z.uuid().safeParse(id).success) throw new Error('Invalid saved detail ID.')
    const entry = this.entries.find((item) => item.id === id)
    if (!entry) return false
    const result = await this.collection.deleteOne({ origin: entry.origin, id })
    if (result.deletedCount) this.entries = this.entries.filter((item) => item.id !== id)
    return result.deletedCount === 1
  }

  async close(): Promise<void> { await this.client.close() }
}