import { lstatSync, readdirSync, realpathSync } from 'node:fs'
import { basename, join } from 'node:path'

export function validateProjectFolder(project: string, home: string): void {
  if (!lstatSync(project).isDirectory()) throw new Error('Choose a project folder.')
  if (realpathSync(project) === realpathSync(home)) throw new Error('Your home folder is not a project. Choose the actual project folder instead.')
}

export function activeProjectNames(status: string): string[] {
  return [...new Set([...status.matchAll(/\bwindow \[\d+\] \(([^\n]+)\)/g)]
    .map((match) => match[1].split(' — ').at(-1)?.trim() ?? '')
    .filter(Boolean))]
}

export function activeProjects(status: string, folders: string[]): { name: string, path: string }[] {
  const titles = new Set(activeProjectNames(status))
  const matches = new Set<string>()
  let visited = 0
  function visit(folder: string, depth: number): void {
    if (titles.has(basename(folder))) matches.add(folder)
    if (depth >= 3 || visited >= 500) return
    try {
      for (const entry of readdirSync(folder, { withFileTypes: true })) {
        if (++visited > 500) break
        if (entry.isDirectory() && !entry.name.startsWith('.')) visit(join(folder, entry.name), depth + 1)
      }
    } catch { return }
  }
  for (const folder of folders) visit(folder, 0)
  return [...matches].map((path) => ({ name: basename(path), path }))
}