import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { ChildProcess } from 'node:child_process'
import { ChromeProfile, chromeExecutable } from './chrome-profile.mjs'
import { launchResearchChrome } from './browser-research.mjs'

test('manual login uses only the dedicated profile args and waits for Chrome exit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-chrome-'))
  try {
    const directory = join(root, 'chrome-profile')
    const profile = new ChromeProfile(directory, 'darwin')
    const child = new EventEmitter() as ChildProcess
    const args: string[][] = []
    let launched!: () => void
    const launchStarted = new Promise<void>((resolve) => { launched = resolve })
    const pending = profile.setup(new AbortController().signal, (executable, launchArgs) => {
      assert.equal(executable, chromeExecutable)
      args.push(launchArgs)
      launched()
      return child
    })
    await launchStarted
    assert.deepEqual(args, [[`--user-data-dir=${directory}`, '--no-first-run', 'https://accounts.google.com']])
    assert.equal((await stat(directory)).mode & 0o777, 0o700)
    await assert.rejects(() => profile.reset(), /already using/)
    child.emit('exit', 0)
    assert.match(await pending, /Sign in in the Chrome window, then close it/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('lock blocks setup, research, and reset without deleting the profile', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-chrome-'))
  try {
    const directory = join(root, 'chrome-profile')
    const profile = new ChromeProfile(directory, 'darwin')
    await profile.ensureDirectory()
    await writeFile(join(directory, 'marker'), 'login stays')
    await symlink('hostname-1234', join(directory, 'SingletonLock'))
    await assert.rejects(() => profile.setup(new AbortController().signal), /in use/)
    await assert.rejects(() => launchResearchChrome(profile), /in use/)
    await assert.rejects(() => profile.reset(), /in use/)
    assert.equal(await readFile(join(directory, 'marker'), 'utf8'), 'login stays')
    await rm(join(directory, 'SingletonLock'))
    await profile.reset()
    assert.equal(existsSync(directory), false)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('existing profile directory with broad permissions cannot be used for login or research', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-chrome-'))
  try {
    const directory = join(root, 'chrome-profile')
    await mkdir(directory, { mode: 0o755 })
    const profile = new ChromeProfile(directory, 'darwin')
    await assert.rejects(() => profile.setup(new AbortController().signal), /not a private directory/)
    await assert.rejects(() => launchResearchChrome(profile), /not a private directory/)
    assert.equal((await stat(directory)).mode & 0o777, 0o755)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('research defaults to temporary profile and signed-in launch keeps its directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-chrome-'))
  try {
    const directory = join(root, 'chrome-profile')
    const calls: { path: string; options: Record<string, unknown> }[] = []
    const launch = (async (path: string, options: Record<string, unknown>) => {
      calls.push({ path, options })
      return { close: async () => {} }
    }) as typeof import('playwright-core').chromium.launchPersistentContext
    const temporary = await launchResearchChrome(null, launch)
    assert.equal(calls[0].path, '')
    assert.equal(calls[0].options.javaScriptEnabled, undefined)
    temporary.release()
    const signedIn = await launchResearchChrome(new ChromeProfile(directory, 'darwin'), launch)
    assert.equal(calls[1].path, directory)
    assert.equal(calls[1].options.javaScriptEnabled, false)
    await signedIn.context.close()
    signedIn.release()
    assert.equal(existsSync(directory), true)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('default research launcher opens a temporary Chrome context', {
  skip: process.platform !== 'darwin' || !existsSync(chromeExecutable),
}, async () => {
  const { context, release } = await launchResearchChrome(null)
  try { assert.ok(context.browser()) }
  finally { await context.close(); release() }
})

test('signed-in profile is not supported outside macOS', async () => {
  const profile = new ChromeProfile('/unused/jarvis-chrome-profile', 'win32')
  await assert.rejects(() => profile.setup(new AbortController().signal), /not supported yet/)
  await assert.rejects(() => profile.reset(), /not supported yet/)
})