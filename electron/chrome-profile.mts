import { spawn, type ChildProcess } from 'node:child_process'
import { lstatSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'

export const chromeExecutable = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

export class ChromeProfile {
  private active = false

  constructor(readonly directory: string, private readonly platform = process.platform) {}

  acquire(): () => void {
    if (this.platform !== 'darwin') throw new Error('Signed-in Chrome profiles are not supported yet on this platform.')
    if (this.active) throw new Error('Jarvis is already using the signed-in Chrome profile. Close that Chrome window or wait for research to finish.')
    try {
      const profile = lstatSync(this.directory)
      if (!profile.isDirectory() || profile.isSymbolicLink()) throw new Error('Chrome profile path is not a private directory.')
      lstatSync(join(this.directory, 'SingletonLock'))
      throw new Error('Signed-in Chrome profile is in use. Close its Chrome window and retry.')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    this.active = true
    return () => { this.active = false }
  }

  async ensureDirectory(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const profile = lstatSync(this.directory)
    if (!profile.isDirectory() || profile.isSymbolicLink() || (profile.mode & 0o077) !== 0) throw new Error('Chrome profile path is not a private directory.')
  }

  async setup(signal: AbortSignal, launch: (executable: string, args: string[]) => ChildProcess = spawn): Promise<string> {
    const release = this.acquire()
    try {
      if (signal.aborted) throw new Error('Cancelled')
      await this.ensureDirectory()
      const child = launch(chromeExecutable, [`--user-data-dir=${this.directory}`, '--no-first-run', 'https://accounts.google.com'])
      await new Promise<void>((resolve, reject) => {
        const abort = () => child.kill('SIGTERM')
        signal.addEventListener('abort', abort, { once: true })
        child.once('error', (error) => { signal.removeEventListener('abort', abort); reject(error) })
        child.once('exit', (code) => {
          signal.removeEventListener('abort', abort)
          if (signal.aborted) reject(new Error('Cancelled'))
          else if (code !== 0) reject(new Error(`Chrome exited with code ${code}.`))
          else resolve()
        })
        if (signal.aborted) abort()
      })
      try {
        lstatSync(join(this.directory, 'SingletonLock'))
        throw new Error('Chrome is still using the signed-in profile. Close its window before continuing.')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      return 'Sign in in the Chrome window, then close it. Chrome has closed; the login profile is ready.'
    } finally { release() }
  }

  async reset(): Promise<void> {
    const release = this.acquire()
    try { await rm(this.directory, { recursive: true, force: true }) }
    finally { release() }
  }
}