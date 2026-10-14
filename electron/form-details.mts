import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'
import { publicOrigin } from './browser-research.mjs'

const detailsSchema = z.strictObject({
  id: z.uuid(),
  origin: z.url(),
  name: z.string().max(120),
  email: z.union([z.literal(''), z.email().max(254)]),
  phone: z.string().max(40),
  address: z.string().max(300),
})
const storeSchema = z.strictObject({ version: z.literal(1), entries: z.array(detailsSchema).max(100) })
export type FormDetails = z.infer<typeof detailsSchema>

export async function validateFormDetails(input: unknown): Promise<FormDetails> {
  if (!input || typeof input !== 'object' || !('origin' in input) || typeof input.origin !== 'string') throw new Error('Invalid form details.')
  const origin = await publicOrigin(input.origin)
  if (origin !== input.origin) throw new Error('Use only the HTTPS site origin.')
  const entry = detailsSchema.parse({ ...input, id: randomUUID(), origin })
  if (![entry.name, entry.email, entry.phone, entry.address].some(Boolean)) throw new Error('Enter at least one contact detail.')
  return entry
}

export function parseFormDetails(entries: unknown): FormDetails[] {
  return storeSchema.parse({ version: 1, entries }).entries
}

export class FormDetailStore {
  private entries: FormDetails[] = []
  private writing = Promise.resolve()

  constructor(private readonly file: string) {}

  async load(): Promise<void> {
    try {
      this.entries = storeSchema.parse(JSON.parse(await readFile(this.file, 'utf8'))).entries
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Saved form details could not be loaded safely.', { cause })
    }
  }

  list(): FormDetails[] { return this.entries.map((entry) => ({ ...entry })) }

  async save(input: unknown): Promise<FormDetails> {
    const entry = await validateFormDetails(input)
    const { origin } = entry
    return this.serialize(async () => {
      if (this.entries.length >= 100 && !this.entries.some((item) => item.origin === origin)) throw new Error('Too many saved sites.')
      this.entries = [...this.entries.filter((item) => item.origin !== origin), entry]
      await this.persist()
      return { ...entry }
    })
  }

  async delete(id: unknown): Promise<boolean> {
    if (typeof id !== 'string' || !z.uuid().safeParse(id).success) throw new Error('Invalid saved detail ID.')
    return this.serialize(async () => {
      const previous = this.entries.length
      this.entries = this.entries.filter((entry) => entry.id !== id)
      if (previous !== this.entries.length) await this.persist()
      return previous !== this.entries.length
    })
  }

  private async serialize<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.writing.then(operation)
    this.writing = pending.then(() => {}, () => {})
    return pending
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true })
    const temporary = `${this.file}.${randomUUID()}.tmp`
    await writeFile(temporary, JSON.stringify({ version: 1, entries: this.entries }), { flag: 'wx', mode: 0o600 })
    await rename(temporary, this.file)
  }
}