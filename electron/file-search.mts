import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { lstatSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'
import type { PermissionManager } from './permissions.mjs'

const runFile = promisify(execFile)

function calendarDay(year: number, month: number, day: number): Date | null {
  const value = new Date(year, month - 1, day)
  return value.getFullYear() === year && value.getMonth() === month - 1 && value.getDate() === day ? value : null
}

export function parseScreenshotDate(query: string, now: Date): Date | 'last' | null {
  if (!/\bscreenshots?\b/i.test(query)) return null
  if (/\blast\s+screenshots?\b/i.test(query)) return 'last'
  if (/\btoday'?s?\b/i.test(query)) return calendarDay(now.getFullYear(), now.getMonth() + 1, now.getDate())
  if (/\byesterday\b/i.test(query)) return new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)
  const match = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(query)
  if (match) {
    const date = calendarDay(Number(match[1]), Number(match[2]), Number(match[3]))
    if (!date) throw new Error('Invalid screenshot date. Use YYYY-MM-DD.')
    return date
  }
  return null
}

function screenshotTime(file: string): number {
  const match = /(?:screen\s?shot|screenshot)[^/]*?\b(\d{4})-(\d{2})-(\d{2})\b(?:\s+at\s+(\d{1,2})[.:](\d{2})(?:[.:](\d{2}))?\s*(AM|PM))?/i.exec(basename(file))
  const dated = match && calendarDay(Number(match[1]), Number(match[2]), Number(match[3]))
  if (!dated) return lstatSync(file).mtimeMs
  if (!match[4]) return dated.getTime()
  const hour = Number(match[4]), minute = Number(match[5]), second = Number(match[6] ?? 0)
  if (hour < 1 || hour > 12 || minute > 59 || second > 59) return dated.getTime()
  dated.setHours(hour % 12 + (match[7].toUpperCase() === 'PM' ? 12 : 0), minute, second)
  return dated.getTime()
}

function screenshotDay(file: string): number {
  const date = new Date(screenshotTime(file))
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

function screenshotWindow(query: string, date: Date): { start: number, end: number } {
  const time = /\b(?:between|from)\s+(\d{1,2}):(\d{2})\s+(?:and|to|-)\s+(\d{1,2}):(\d{2})\b/i.exec(query)
  if (!time) {
    if (/\b(?:between|from|at)\s+\d{1,2}(?::\d{2})?\b/i.test(query)) throw new Error('Specify the time range as between HH:MM and HH:MM (24-hour local time).')
    return { start: date.getTime(), end: new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime() }
  }
  const startHour = Number(time[1]), startMinute = Number(time[2]), endHour = Number(time[3]), endMinute = Number(time[4])
  if (startHour > 23 || endHour > 23 || startMinute > 59 || endMinute > 59) throw new Error('Invalid screenshot time. Use HH:MM in 24-hour local time.')
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate(), startHour, startMinute).getTime()
  const end = new Date(date.getFullYear(), date.getMonth(), date.getDate(), endHour, endMinute).getTime()
  if (end <= start) throw new Error('The end time must be later than the start time on the requested date.')
  return { start, end }
}

async function spotlightNames(folder: string, filename: string): Promise<string[]> {
  const { stdout } = await runFile('mdfind', ['-onlyin', folder, '-name', filename], { timeout: 10000, maxBuffer: 1024 * 1024 })
  return stdout.split('\n')
}

export interface SearchStep {
  id: string
  status: 'permission-required' | 'done'
  folder: string | null
  query: string
  date: string | null
  matches: string[]
  checked: string[]
  errors: string[]
}

export class FileSearch {
  private current: { id: string, query: string, screenshotMode: 'date' | 'last' | null, dayStart: number, dayEnd: number, index: number, matches: string[], checked: string[], errors: string[] } | null = null
  private lastMatches: string[] = []

  constructor(private readonly permissions: PermissionManager, private readonly folders: { name: string, path: string }[] = [
    { name: 'Desktop', path: join(homedir(), 'Desktop') },
    { name: 'Documents', path: join(homedir(), 'Documents') },
    { name: 'Downloads', path: join(homedir(), 'Downloads') },
  ], private readonly indexedSearch: (folder: string, filename: string) => Promise<string[]> = spotlightNames, private readonly now: () => Date = () => new Date()) {}

  async start(query: unknown): Promise<SearchStep> {
    if (typeof query !== 'string' || !query.trim() || query.length > 200 || query.includes('/') || query.includes('\\') || [...query].some((character) => character.charCodeAt(0) < 32)) throw new Error('Enter a filename of at most 200 characters without a path.')
    this.lastMatches = []
    const requestedDate = parseScreenshotDate(query, this.now())
    if (/\bscreenshots?\b/i.test(query) && !requestedDate) throw new Error('Specify a screenshot date, such as today, yesterday, or YYYY-MM-DD.')
    const screenshotMode = requestedDate === 'last' ? 'last' : requestedDate ? 'date' : null
    const window = requestedDate instanceof Date ? screenshotWindow(query, requestedDate) : { start: 0, end: 0 }
    const dayStart = window.start
    const dayEnd = window.end
    this.current = { id: randomUUID(), query: query.trim(), screenshotMode, dayStart, dayEnd, index: 0, matches: [], checked: [], errors: [] }
    return this.advance()
  }

  reveal(file: unknown): string {
    if (typeof file !== 'string' || !this.lastMatches.includes(file) || !this.permissions.isAllowed('files.read', file)) throw new Error('This file is not available from the last approved search.')
    try {
      if (lstatSync(file).isFile()) return file
    } catch {}
    throw new Error('The matching file is no longer available.')
  }

  preview(file: unknown): string {
    const result = this.reveal(file)
    if (!/\.(?:png|jpe?g|heic|heif|webp|tiff?)$/i.test(result)) throw new Error('Only image search results can be previewed.')
    return result
  }

  async decide(id: unknown, allow: unknown): Promise<SearchStep> {
    const search = this.current
    if (!search || id !== search.id || typeof allow !== 'boolean' || !this.folders[search.index]) throw new Error('This search permission request is no longer active.')
    const folder = this.folders[search.index]
    search.id = randomUUID()
    if (allow) {
      await this.permissions.grantFolder(folder.path)
      await this.inspect(folder.name, folder.path)
    } else {
      search.checked.push(`${folder.name}: skipped`)
    }
    search.index++
    return this.advance()
  }

  private async advance(): Promise<SearchStep> {
    const search = this.current!
    while (search.index < this.folders.length) {
      const folder = this.folders[search.index]
      if (!this.permissions.isAllowed('files.read', folder.path)) break
      await this.inspect(folder.name, folder.path)
      search.index++
    }
    const next = this.folders[search.index]
    const done = !next
    const sorted = [...search.matches].sort(search.screenshotMode ? (left, right) =>
      screenshotTime(right) - screenshotTime(left) || lstatSync(right).mtimeMs - lstatSync(left).mtimeMs || left.localeCompare(right) : (left, right) =>
      Number(basename(right).toLowerCase() === search.query.toLowerCase()) - Number(basename(left).toLowerCase() === search.query.toLowerCase()) ||
      left.split('/').length - right.split('/').length || left.localeCompare(right))
    const newest = sorted.length ? new Date(screenshotDay(sorted[0])) : null
    const lastDayStart = newest ? new Date(newest.getFullYear(), newest.getMonth(), newest.getDate()).getTime() : null
    const lastDayEnd = newest ? new Date(newest.getFullYear(), newest.getMonth(), newest.getDate() + 1).getTime() : null
    const matches = search.screenshotMode === 'last' && lastDayStart !== null && lastDayEnd !== null
      ? sorted.filter((file) => { const day = screenshotDay(file); return day >= lastDayStart && day < lastDayEnd }) : sorted
    const step: SearchStep = {
      id: search.id, status: done ? 'done' : 'permission-required', folder: done ? null : next.name,
      query: search.query, date: search.screenshotMode === 'last' ? newest && `${newest.getFullYear()}-${String(newest.getMonth() + 1).padStart(2, '0')}-${String(newest.getDate()).padStart(2, '0')}` : search.screenshotMode === 'date' ? `${new Date(search.dayStart).getFullYear()}-${String(new Date(search.dayStart).getMonth() + 1).padStart(2, '0')}-${String(new Date(search.dayStart).getDate()).padStart(2, '0')}` : null, matches: matches.slice(0, search.screenshotMode ? 200 : 20), checked: [...search.checked], errors: [...search.errors],
    }
    if (done) {
      this.lastMatches = step.matches
      this.current = null
    }
    return step
  }

  private async inspect(name: string, path: string): Promise<void> {
    const search = this.current!
    if (!this.permissions.isAllowed('files.read', path)) throw new Error(`Jarvis has no read grant for ${name}.`)
    const folderMatches = search.matches.length
    const term = search.screenshotMode ? 'screenshot' : search.query
    const screenshotName = (filename: string) => /\bscreen\s?shot\b/i.test(filename)
    const addMatch = (candidate: string) => {
      if (search.screenshotMode && !/\.(?:png|jpe?g|heic|heif|webp|tiff?)$/i.test(candidate)) return false
      if (search.matches.includes(candidate)) return false
      if (search.screenshotMode === 'date') {
        const captured = screenshotTime(candidate)
        if (captured < search.dayStart || captured >= search.dayEnd) return false
      }
      search.matches.push(candidate)
      if (search.screenshotMode && search.matches.length > 200) {
        search.matches.sort((left, right) => screenshotTime(right) - screenshotTime(left) || lstatSync(right).mtimeMs - lstatSync(left).mtimeMs)
        search.matches.length = 200
        if (!search.errors.includes('More than 200 screenshots matched; only the newest 200 are shown.')) search.errors.push('More than 200 screenshots matched; only the newest 200 are shown.')
      }
      return true
    }
    if (process.platform === 'darwin') {
      try {
        const indexed = (await Promise.all((search.screenshotMode ? [term, 'screen shot'] : [term]).map((name) => this.indexedSearch(path, name)))).flat()
        let indexedScreenshot = false
        for (const candidate of indexed) {
          if (!search.screenshotMode && search.matches.length - folderMatches >= 20) break
          if (!candidate || !this.permissions.isAllowed('files.read', candidate)) continue
          try {
            if (lstatSync(candidate).isFile() && (search.screenshotMode ? screenshotName(basename(candidate)) : basename(candidate).toLowerCase().includes(term.toLowerCase()))) {
              indexedScreenshot = true
              addMatch(candidate)
            }
          } catch { continue }
        }
        if (indexedScreenshot || search.matches.length > folderMatches) {
          search.checked.push(`${name}: searched`)
          return
        }
      } catch {}
    }
    let visited = 0
    const visitLimit = search.screenshotMode ? 100000 : 5000
    const walk = async (folder: string, depth: number): Promise<void> => {
      const entries = await readdir(folder, { withFileTypes: true })
      for (const entry of entries) {
        if (++visited > visitLimit || (!search.screenshotMode && search.matches.length - folderMatches >= 20)) return
        if (entry.isSymbolicLink()) continue
        const target = join(folder, entry.name)
        if (entry.isFile() && (search.screenshotMode ? screenshotName(entry.name) : entry.name.toLowerCase().includes(term.toLowerCase()))) addMatch(target)
        if (entry.isDirectory() && depth < 4) await walk(target, depth + 1)
      }
    }
    try {
      await walk(path, 0)
      search.checked.push(`${name}: ${visited > visitLimit ? 'search incomplete' : 'searched'}`)
      if (visited > visitLimit) search.errors.push(`${name}: Spotlight had no usable matches; filesystem scan stopped after ${visitLimit.toLocaleString('en-US')} entries to avoid an unbounded search. Results may be incomplete.`)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      search.errors.push(`${name}: ${code === 'EACCES' || code === 'EPERM' ? 'macOS denied file access. Enable access for Electron/Jarvis in System Settings > Privacy & Security > Files and Folders, then retry.' : 'Could not search this folder.'}`)
    }
  }
}