import { spawn, type ChildProcessByStdio } from 'node:child_process'
import type { Readable, Writable } from 'node:stream'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { publicOrigin } from './browser-research.mjs'
import { chromeExecutable } from './chrome-profile.mjs'
import type { FormDetails } from './form-details.mjs'
import type { PermissionManager } from './permissions.mjs'
import { parseWebsiteAction } from '../src/app-command.js'
import { isLocationLookup } from '../src/location-suggestion.js'

const project = fileURLToPath(new URL('../../', import.meta.url))
const interpreter = join(project, 'browser-use/.venv/bin/python')
const worker = join(project, 'electron/browser-use-worker.py')
type BrowserWorker = ChildProcessByStdio<Writable, Readable, null>
let activeWorker: { child: BrowserWorker, origin: string, provider: string, key: string } | null = null
let running = false

function stopWorker(child: BrowserWorker): void {
  if (activeWorker?.child === child) activeWorker = null
  if (child.pid && child.exitCode === null) {
    try { process.kill(-child.pid, 'SIGTERM') } catch { child.kill() }
  }
}

export function closeBrowserUseSession(): Promise<void> {
  if (!activeWorker) return Promise.resolve()
  const child = activeWorker.child
  activeWorker = null
  return new Promise((resolve) => {
    const timeout = setTimeout(() => { stopWorker(child); resolve() }, 3000)
    timeout.unref()
    child.once('close', () => { clearTimeout(timeout); resolve() })
    if (running) stopWorker(child)
    else child.stdin.end()
  })
}

export function browserUseActionAccess(action: string, detail: string, origin: string, routineClick = false, routineInput = false): 'read' | 'scroll' | 'click' | 'input' | 'review' {
  try {
    const request = JSON.parse(detail) as Record<string, unknown>
    if (Object.keys(request).length !== 1 || !(action in request)) return 'review'
    if (action === 'navigate') {
      const target = (request.navigate as { url?: unknown })?.url
      return typeof target === 'string' && new URL(target).origin === origin ? 'read' : 'review'
    }
    if (['wait', 'extract', 'search_page', 'find_elements'].includes(action)) return 'read'
    if (action === 'scroll') return 'scroll'
    if (action === 'click') return routineClick && typeof (request.click as { index?: unknown })?.index === 'number' ? 'click' : 'review'
    if (action === 'send_keys') return routineClick && ['Escape', 'ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Tab'].includes(String((request.send_keys as { keys?: unknown })?.keys)) ? 'click' : 'review'
    if (action === 'select_dropdown_option') {
      const selection = request.select_dropdown_option as { index?: unknown, text?: unknown }
      return routineClick && typeof selection?.index === 'number' && typeof selection.text === 'string' && selection.text.length <= 80 ? 'click' : 'review'
    }
    if (action === 'input') return routineInput && typeof (request.input as { index?: unknown, text?: unknown })?.index === 'number' && typeof (request.input as { text?: unknown }).text === 'string' ? 'input' : 'review'
  } catch {}
  return 'review'
}

export function browserUseCaptchaHandoff(detail: string, origin: string): boolean {
  try {
    const request = JSON.parse(detail) as { captcha_handoff?: { url?: unknown } }
    const url = request.captcha_handoff?.url
    return typeof url === 'string' && new URL(url).origin === origin
  } catch { return false }
}

export function browserUseQuestionHandoff(detail: string, origin: string): string | null {
  try {
    const request = JSON.parse(detail) as { question_handoff?: { question?: unknown, url?: unknown } }
    const handoff = request.question_handoff
    return typeof handoff?.question === 'string' && handoff.question.trim().length > 0 && handoff.question.length <= 700
      && typeof handoff.url === 'string' && new URL(handoff.url).origin === origin ? handoff.question : null
  } catch { return null }
}

export function approvedBrowserUseOrigin(task: string, permissions: Pick<PermissionManager, 'list' | 'isAllowed'>): string | null {
  const words = task.toLowerCase().match(/[a-z0-9]+/g) ?? []
  const compact = words.join('')
  const matches = new Set(permissions.list().filter((record) =>
    record.capability === 'browser.read' && permissions.isAllowed('browser.read', record.scope) &&
    (() => {
      try {
        return new URL(record.scope).hostname.split('.').some((label) =>
          label.length >= 4 && !['online', 'store', 'shop', 'site', 'search', 'google'].includes(label) && compact.includes(label))
      } catch { return false }
    })(),
  ).map((record) => record.scope))
  return matches.size === 1 ? [...matches][0] : null
}

export async function browserUseTarget(task: string): Promise<{ origin: string, task: string }> {
  const sites: string[] = task.match(/https?:\/\/[^\s<>"']+|(?<![\w@/.-])(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}(?::\d+)?(?:\/[^\s<>"']*)?/gi) ?? []
  const bookMyShow = !sites.length && (/\bbook\s*my\s*show\b/i.test(task)
    || /\b(?:cinema|movie|film|showtime|tickets?|seats?)\b/i.test(task) && /\b(?:cinema|movie|film|showtime|tickets?|seats?)\b.*\b(?:near|nearby|book|find|search|two|2)\b|\b(?:near|nearby|book|find|search|two|2)\b.*\b(?:cinema|movie|film|showtime|tickets?|seats?)\b/i.test(task))
  const croma = !sites.length && /\bcroma\b/i.test(task)
  const dominos = !sites.length && /\bdomino(?:'s|s)?\b/i.test(task)
  if (bookMyShow) sites.push('https://in.bookmyshow.com')
  if (croma) sites.push('https://www.croma.com')
  if (dominos) sites.push('https://pizzaonline.dominos.co.in')
  if (!sites.length) sites.push('https://www.google.com')
  if (sites.length !== 1) throw new Error('Browser-use needs exactly one website at a time. No site was opened.')
  const site = sites[0].replace(/[),.!?;]+$/, '')
  const url = /^https?:\/\//i.test(site) ? site : `https://${site}`
  const origin = await publicOrigin(url)
  return { origin, task: bookMyShow
    ? `${task}\nStart at ${url}. Browse the site for the requested location and available shows. If the user's location is unknown, ask for a city or neighborhood; do not infer it from IP. Compare observed ticket prices and fees before choosing a showing. If the movie or showtime is unspecified, report observed options and ask the user to choose. Let the user inspect and approve the exact seats before selecting them. Stop at checkout or a QR payment screen; do not submit payment. Only report two adjacent seats if the live seating chart confirms them; do not claim seats were booked or paid for without site confirmation.`
    : dominos ? `${task}\nStart at ${url}. Find delivery or pickup options for the user's confirmed area or address; do not infer location from IP. If the location, pizza variants, size, or price is unspecified, show observed choices and ask the user before placing an order. Confirm the cart contents, total including fees, and delivery address before any final order submission. Let the user scan a QR code or complete payment personally; never claim an order succeeded without a site confirmation.`
    : croma ? `${task}\nStart at ${url}. Search this store for the requested product and report only observed prices and product variants.`
    : site === 'https://www.google.com' ? `${task}\nStart at https://www.google.com/search?q=${encodeURIComponent(task.replace(/^(?:browse|browser)-use\s*:\s*/i, ''))}. Use the search results to find the requested information; report source links and clearly distinguish snippets from verified store prices. Do not claim you visited a store if you only read results.`
    : /^https:\/\//i.test(site) ? task : `${task}\nStart at ${url}.` }
}

export async function browserUseOrigin(task: string): Promise<string> {
  return (await browserUseTarget(task)).origin
}

export async function resolveBrowserUseTarget(task: string, permissions: Pick<PermissionManager, 'list' | 'isAllowed'>): Promise<{ origin: string, task: string }> {
  const inferred = await browserUseTarget(task)
  if (inferred.origin !== 'https://www.google.com') return inferred
  if (isLocationLookup(`browse-use: ${task}`)) return {
    origin: await publicOrigin('https://mylocationapp.com/my-location/'),
    task: `${task}\nStart at https://mylocationapp.com/my-location/. Use the site's precise-location control. Never present an IP-based estimate as the device location. If the site does not show a precise location, say that it could not be verified.`,
  }
  const approved = approvedBrowserUseOrigin(task, permissions)
  if (approved) return { origin: approved, task: `${task}\nStart at ${approved}.` }
  if (parseWebsiteAction(task)) throw new Error('No unique approved website matches this action. Name one site with its HTTPS URL or grant browser.read for that site in Permissions.')
  return inferred
}

export async function runBrowserUseTask(
  task: string, provider: 'zai' | 'bedrock-mantle', key: string,
  approve: (origin: string, action: string, detail: string, routineClick: boolean, routineInput: boolean, field?: 'name' | 'email' | 'phone' | 'address') => Promise<boolean | string>, signal: AbortSignal,
  step: (detail: string) => void,
  sharedDetails?: FormDetails,
  launch: () => BrowserWorker = () => spawn(interpreter, [worker], {
    cwd: project, stdio: ['pipe', 'pipe', 'ignore'], detached: true,
    env: { HOME: process.env.HOME, PATH: process.env.PATH, TMPDIR: process.env.TMPDIR,
      JARVIS_BROWSER_KEY: key, BROWSER_USE_SETUP_LOGGING: 'false', DO_NOT_TRACK: '1' },
  }),
  selectedTarget?: { origin: string, task: string },
  allowLocation = false,
): Promise<string> {
  if (process.platform !== 'darwin') throw new Error('Local browser-use browsing is currently available only on macOS.')
  if (!key.trim()) throw new Error('Configure GLM-5 before browsing.')
  if (!existsSync(interpreter) || !existsSync(worker)) throw new Error('Install browser-use into browser-use/.venv with Python 3.12 first.')
  if (!existsSync(chromeExecutable)) throw new Error('Google Chrome is not installed.')
  if (signal.aborted) throw new Error('Cancelled')
  const target = selectedTarget ?? await browserUseTarget(task)
  if (selectedTarget && (await publicOrigin(selectedTarget.origin)) !== selectedTarget.origin) throw new Error('Invalid browser-use target origin.')
  if (running) throw new Error('Another browser-use task is still running.')
  if (signal.aborted) throw new Error('Cancelled')
  const { origin } = target
  if (activeWorker && (activeWorker.origin !== origin || activeWorker.provider !== provider || activeWorker.key !== key
    || activeWorker.child.exitCode !== null || activeWorker.child.killed || activeWorker.child.stdin.destroyed)) void closeBrowserUseSession()
  const reused = activeWorker !== null
  const child = activeWorker?.child ?? launch()
  running = true
  activeWorker = { child, origin, provider, key }
  if (!reused) child.once('close', () => { if (activeWorker?.child === child) activeWorker = null })
  step(`${reused ? 'Reusing' : 'Launching'} local Chrome for ${origin}`)
  const stop = () => stopWorker(child)
  signal.addEventListener('abort', stop, { once: true })
  let timedOut = false
  let retainedFailure = false
  const startTimeout = () => setTimeout(() => { timedOut = true; stop() }, 12 * 60_000)
  let timeout = startTimeout()
  try {
    return await new Promise<string>((resolve, reject) => {
      let buffer = ''
      let answer: string | undefined
      let error: string | undefined
      let taskFailure: string | undefined
      let actions = 0
      let queue = Promise.resolve()
      let settled = false
      const cleanup = () => {
        child.stdout.removeListener('data', onData)
        child.removeListener('close', onClose)
        child.removeListener('error', onError)
        child.stdin.removeListener('error', onError)
      }
      const fail = (cause: Error, retain = false) => {
        if (settled) return
        settled = true
        cleanup()
        if (retain) retainedFailure = true
        else stop()
        reject(cause)
      }
      const succeed = (result: string) => {
        if (settled) return
        settled = true
        cleanup()
        resolve(result)
      }
      const onError = (cause: Error) => fail(cause)
      child.stdout.setEncoding('utf8')
      const onData = (chunk: string) => {
        buffer += chunk
        if (buffer.length > 32_000) { fail(new Error('Browser-use sent too much output.')); return }
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          queue = queue.then(async () => {
            if (settled) return
            const message: unknown = JSON.parse(line)
            if (!message || typeof message !== 'object' || !('type' in message)) throw new Error('Invalid browser-use response.')
            if (message.type === 'approval') {
              const captchaHandoff = 'action' in message && message.action === 'captcha_handoff' && 'detail' in message && typeof message.detail === 'string' && browserUseCaptchaHandoff(message.detail, origin)
              const question = 'action' in message && message.action === 'question_handoff' && 'detail' in message && typeof message.detail === 'string' ? browserUseQuestionHandoff(message.detail, origin) : null
              const handoff = captchaHandoff || question !== null || ('action' in message && message.action === 'payment_handoff' && (target.task.startsWith(`At ${origin}, start a delivery order`) || origin === 'https://in.bookmyshow.com'))
              if (!('origin' in message) || message.origin !== origin || !('action' in message) || typeof message.action !== 'string' || !/^[a-z_]{1,80}$/.test(message.action) || !('detail' in message) || typeof message.detail !== 'string' || message.detail.length > 1000 || !('routine_click' in message) || typeof message.routine_click !== 'boolean' || !('routine_input' in message) || typeof message.routine_input !== 'boolean' || ('field' in message && (message.action !== 'input' || !['name', 'email', 'phone', 'address'].includes(String(message.field)))) || (actions >= 60 && !handoff)) throw new Error('Invalid browser-use action.')
              if ((message.action === 'question_handoff' || message.action === 'captcha_handoff') && !handoff) throw new Error('Invalid browser-use handoff.')
              if (handoff) clearTimeout(timeout)
              else actions++
              const access = browserUseActionAccess(message.action, message.detail, origin, message.routine_click, message.routine_input)
              step(`${access === 'review' ? 'Reviewing' : 'Browsing'} ${message.action.replaceAll('_', ' ')} on ${origin}`)
              const field = 'field' in message ? message.field as 'name' | 'email' | 'phone' | 'address' : undefined
              const allowed = !signal.aborted && await approve(origin, message.action, message.detail, message.routine_click, message.routine_input, field)
              if (!allowed || signal.aborted) { stop(); throw new Error('Browser action denied or cancelled.') }
              if (field && (typeof allowed !== 'string' || !allowed.trim() || allowed.length > 300)) throw new Error('Contact value was not supplied.')
              if (question !== null && (typeof allowed !== 'string' || !allowed.trim() || allowed.length > 1000)) throw new Error('Question reply was not supplied.')
              if (captchaHandoff || question !== null) timeout = startTimeout()
              child.stdin.write(JSON.stringify({ allow: true, ...(field || question !== null ? { text: allowed } : {}) }) + '\n')
            } else if (message.type === 'result' && 'text' in message && typeof message.text === 'string' && message.text.length <= 4000) {
              answer = message.text
            } else if (message.type === 'ready') {
              if (taskFailure) {
                if (answer || error || signal.aborted || timedOut) throw new Error('Invalid browser-use failure response.')
                fail(new Error(taskFailure), true)
                return
              }
              if (error) throw new Error(error)
              if (!answer || !actions) throw new Error('Browser-use stopped without a verified result.')
              succeed(answer)
            } else if (message.type === 'status' && 'text' in message && typeof message.text === 'string' && message.text.length <= 200) {
              step(message.text)
            } else if (message.type === 'error' && 'message' in message && typeof message.message === 'string') {
              error = message.message.slice(0, 200)
            } else if (message.type === 'task_failed' && 'message' in message && typeof message.message === 'string' && message.message.length > 0 && message.message.length <= 200) {
              taskFailure = message.message
            } else throw new Error('Invalid browser-use response.')
          }).catch((cause) => fail(new Error(cause instanceof Error ? cause.message : 'Browser-use failed.')))
        }
      }
      const onClose = (code: number | null) => {
        void queue.then(() => {
          if (signal.aborted) fail(new Error('Cancelled'))
          else if (timedOut) fail(new Error('Browser-use timed out after twelve minutes without a verified result.'))
          else if (error) fail(new Error(error))
          else if (code !== 0) fail(new Error(`Browser-use worker exited unexpectedly (${code ?? 'signal'}).`))
          else fail(new Error('Browser-use worker closed before it was ready to reuse.'))
        })
      }
      child.once('error', onError)
      child.stdin.on('error', onError)
      child.stdout.on('data', onData)
      child.once('close', onClose)
      child.stdin.write(JSON.stringify({ task: `${target.task}\nIf you need the user's choice or other missing details to proceed, ask one clear question ending in ? instead of declaring the task complete.`, origin, provider, chrome: chromeExecutable, allow_location: allowLocation,
        details: sharedDetails && { name: sharedDetails.name, email: sharedDetails.email, phone: sharedDetails.phone, address: sharedDetails.address } }) + '\n')
    })
  } catch (error) {
    if (!retainedFailure) stop()
    throw error
  } finally {
    clearTimeout(timeout)
    signal.removeEventListener('abort', stop)
    running = false
  }
}