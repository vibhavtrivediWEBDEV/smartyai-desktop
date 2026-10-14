import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'

const locationSchema = z.string().trim().min(3).max(300).regex(/^[\p{L}\p{N}\s,.-]+$/u)
const fileSchema = z.strictObject({ version: z.literal(1), location: locationSchema })

export class LocationPreference {
  private location: string | null = null

  constructor(private readonly file: string) {}

  async load(): Promise<void> {
    try {
      this.location = fileSchema.parse(JSON.parse(await readFile(this.file, 'utf8'))).location
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Saved location could not be loaded safely.', { cause })
    }
  }

  get(): string | null { return this.location }

  async save(input: unknown): Promise<string> {
    const location = locationSchema.parse(input)
    await mkdir(dirname(this.file), { recursive: true })
    const temporary = `${this.file}.${randomUUID()}.tmp`
    await writeFile(temporary, JSON.stringify({ version: 1, location }), { flag: 'wx', mode: 0o600 })
    await rename(temporary, this.file)
    this.location = location
    return location
  }

  async delete(): Promise<void> {
    try { await unlink(this.file) }
    catch (cause) { if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause }
    this.location = null
  }
}