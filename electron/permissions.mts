import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { realpathSync, statSync } from 'node:fs'
import { dirname, relative, sep } from 'node:path'
import { z } from 'zod'

export const capabilities = {
  'files.read': { category: 'files', description: 'Read files inside a selected folder', risk: 'low' },
  'files.create': { category: 'files', description: 'Create files inside a selected folder', risk: 'medium' },
  'files.modify': { category: 'files', description: 'Modify or move files inside a selected folder', risk: 'high' },
  'files.delete': { category: 'files', description: 'Delete files inside a selected folder', risk: 'high' },
  'apps.open': { category: 'applications', description: 'Open selected applications', risk: 'low' },
  'browser.open': { category: 'browser', description: 'Open selected websites', risk: 'medium' },
  'browser.read': { category: 'browser', description: 'Read pages on selected websites', risk: 'medium' },
  'voice.record': { category: 'microphone', description: 'Capture microphone audio', risk: 'high' },
  'automation.run': { category: 'automation', description: 'Run approved automations', risk: 'high' },
  'schedule.manage': { category: 'scheduling', description: 'Create and run schedules', risk: 'medium' },
  'system.integrate': { category: 'system', description: 'Access selected system integrations', risk: 'high' },
  'external.send': { category: 'communications', description: 'Send data to external services', risk: 'high' },
} as const

export const permissionSchema = z.strictObject({
  id: z.uuid(),
  capability: z.enum(Object.keys(capabilities) as [keyof typeof capabilities, ...(keyof typeof capabilities)[]]),
  scope: z.string().min(1),
  state: z.enum(['granted', 'denied']),
  source: z.enum(['folder-picker', 'user-decision']),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime().nullable(),
  revokedAt: z.iso.datetime().nullable(),
  platform: z.enum(['darwin', 'win32', 'linux']),
  version: z.literal(1),
})

export type Permission = z.infer<typeof permissionSchema>
const storeSchema = z.strictObject({ version: z.literal(1), permissions: z.array(permissionSchema) })
const legacyPermissionSchema = z.strictObject({
  ...permissionSchema.shape, capability: z.literal('browser.research-autopilot'), scope: z.literal('public-https'),
})
const legacyStoreSchema = z.strictObject({
  version: z.literal(1), permissions: z.array(z.union([permissionSchema, legacyPermissionSchema])),
})

function canonicalFolder(folder: string): string {
  const resolved = realpathSync(folder)
  if (!statSync(resolved).isDirectory()) throw new Error('Choose a folder, not a file.')
  return resolved
}

export function appScope(name: unknown): string {
  if (typeof name !== 'string') throw new Error('Enter an application name.')
  const normalized = name.trim().toLowerCase().replace(/\s+/g, ' ')
  if (!/^[a-z][a-z0-9 .+_-]{0,79}$/.test(normalized)) throw new Error('Enter a valid application name (up to 80 characters).')
  if (/^(vs ?code|visual studio code)$/.test(normalized)) return 'vscode'
  return normalized
}

export function websiteScope(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048) throw new Error('Enter a valid HTTPS website URL.')
  try {
    const url = new URL(value)
    if (url.protocol === 'https:' && !url.username && !url.password) return url.origin
  } catch {}
  throw new Error('Enter a valid HTTPS website URL.')
}

export class PermissionManager {
  private records: Permission[] = []
  private writing: Promise<void> = Promise.resolve()

  constructor(private readonly file: string, private readonly platform: Permission['platform'] = process.platform as Permission['platform']) {}

  async load(): Promise<void> {
    try {
      const content = await readFile(this.file, 'utf8')
      const stored = JSON.parse(content)
      const current = storeSchema.safeParse(stored)
      if (current.success) {
        this.records = current.data.permissions
      } else {
        const legacy = legacyStoreSchema.parse(stored)
        this.records = legacy.permissions.filter((record): record is Permission => record.capability !== 'browser.research-autopilot')
        await writeFile(`${this.file}.${randomUUID()}.backup`, content, { flag: 'wx', mode: 0o600 })
        await this.persist()
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Permission store could not be loaded safely.', { cause: error })
    }
  }

  list(): Permission[] {
    return this.records.map((record) => ({ ...record }))
  }

  async grantFolder(folder: string): Promise<Permission> {
    const scope = canonicalFolder(folder)
    return this.save({
      id: randomUUID(), capability: 'files.read', scope, state: 'granted', source: 'user-decision',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      expiresAt: null, revokedAt: null, platform: this.platform, version: 1,
    })
  }

  async grantVSCode(): Promise<Permission> {
    return this.save({
      id: randomUUID(), capability: 'apps.open', scope: 'vscode', state: 'granted', source: 'user-decision',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      expiresAt: null, revokedAt: null, platform: this.platform, version: 1,
    })
  }

  async grantTerminal(): Promise<Permission> {
    return this.save({
      id: randomUUID(), capability: 'apps.open', scope: 'terminal', state: 'granted', source: 'user-decision',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      expiresAt: null, revokedAt: null, platform: this.platform, version: 1,
    })
  }

  async grantApp(name: unknown): Promise<Permission> {
    const scope = appScope(name)
    return this.save({
      id: randomUUID(), capability: 'apps.open', scope, state: 'granted', source: 'user-decision',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      expiresAt: null, revokedAt: null, platform: this.platform, version: 1,
    })
  }

  async grantWebsite(value: unknown): Promise<Permission> {
    const scope = websiteScope(value)
    return this.save({
      id: randomUUID(), capability: 'browser.open', scope, state: 'granted', source: 'user-decision',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      expiresAt: null, revokedAt: null, platform: this.platform, version: 1,
    })
  }

  async grantWebsiteRead(value: unknown): Promise<Permission> {
    const scope = websiteScope(value)
    return this.save({
      id: randomUUID(), capability: 'browser.read', scope, state: 'granted', source: 'user-decision',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      expiresAt: null, revokedAt: null, platform: this.platform, version: 1,
    })
  }

  async recordDenial(capability: Permission['capability'], scope: string): Promise<Permission> {
    return this.save({
      id: randomUUID(), capability, scope, state: 'denied', source: 'user-decision',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      expiresAt: null, revokedAt: null, platform: this.platform, version: 1,
    })
  }

  async revoke(id: unknown): Promise<Permission | null> {
    if (typeof id !== 'string' || !z.uuid().safeParse(id).success) throw new Error('Invalid permission identifier.')
    return this.serialize(async () => {
      const record = this.records.find((item) => item.id === id)
      if (!record) return null
      if (record.revokedAt) return { ...record }
      const updated = { ...record, revokedAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
      this.records = this.records.map((item) => item.id === id ? updated : item)
      await this.persist()
      return { ...updated }
    })
  }

  isAllowed(capability: Permission['capability'], resource: string, now = new Date()): boolean {
    if (!Object.hasOwn(capabilities, capability) || typeof resource !== 'string') return false
    let canonical = ''
    if (capability.startsWith('files.')) {
      try { canonical = realpathSync(resource) } catch { return false }
    }
    return this.records.some((record) => {
      if (record.capability !== capability || record.platform !== this.platform ||
        record.state !== 'granted' || record.revokedAt ||
        (record.expiresAt && new Date(record.expiresAt) <= now)) return false
      if (capability.startsWith('files.')) {
        try {
          const scope = canonicalFolder(record.scope)
          if (scope !== record.scope) return false
          const subpath = relative(scope, canonical)
          return subpath === '' || (subpath !== '..' && !subpath.startsWith(`..${sep}`))
        } catch { return false }
      }
      return record.scope === resource
    })
  }

  private async save(value: Permission): Promise<Permission> {
    const record = permissionSchema.parse(value)
    return this.serialize(async () => {
      const existing = this.records.find((item) => item.capability === record.capability && item.scope === record.scope && item.state === record.state && !item.revokedAt)
      if (existing) return { ...existing }
      this.records.push(record)
      await this.persist()
      return { ...record }
    })
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writing.then(operation)
    this.writing = result.then(() => {}, () => {})
    return result
  }

  private async persist(): Promise<void> {
    const temp = `${this.file}.${randomUUID()}.tmp`
    const payload = JSON.stringify(storeSchema.parse({ version: 1, permissions: this.records }))
    try {
      await mkdir(dirname(this.file), { recursive: true, mode: 0o700 })
      await writeFile(temp, payload, { mode: 0o600 })
      await rename(temp, this.file)
    } catch (error) {
      await rm(temp, { force: true })
      throw error
    }
  }
}