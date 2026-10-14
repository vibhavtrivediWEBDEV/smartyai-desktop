import { chromium, type BrowserContext, type Page, type Route } from 'playwright-core'
import { askGLMBrowser, type browserActionSchema } from './glm.mjs'
import { publicOrigin } from './browser-research.mjs'
import { ChromeProfile, chromeExecutable } from './chrome-profile.mjs'
import type { PermissionManager } from './permissions.mjs'
import type { z } from 'zod'

type Action = z.infer<typeof browserActionSchema>
type Approval = (origin: string, action?: string) => Promise<boolean>

type ClickTarget = { tag: string; href: string | null; label: string; inForm: boolean; form: string | null; type: string | null; role?: string | null; widget?: string | null; option?: string | null }

export function selectBrowserTab<T extends { url(): string }>(pages: T[], request: string): T | undefined {
  const requested = /https:\/\/[^\s<>"']+/i.exec(request)?.[0]
  let origin: string | undefined
  if (requested) {
    try { origin = new URL(requested).origin } catch { /* Navigation validates malformed URLs. */ }
  }
  for (let index = pages.length - 1; index >= 0; index--) {
    try { if (origin && new URL(pages[index].url()).origin === origin) return pages[index] } catch { /* Ignore blank tabs. */ }
  }
  if (origin) return undefined
  for (let index = pages.length - 1; index >= 0; index--) {
    if (pages[index].url().startsWith('https://')) return pages[index]
  }
  return pages.at(-1)
}

export class ChromeBrowserSession {
  private context: BrowserContext | null = null
  private opening: Promise<BrowserContext> | null = null

  constructor(
    private readonly profile: ChromeProfile,
    private readonly launchChrome: typeof chromium.launchPersistentContext = chromium.launchPersistentContext.bind(chromium),
  ) {}

  async open(): Promise<BrowserContext> {
    if (this.context?.browser()?.isConnected()) return this.context
    if (this.opening) return this.opening
    this.opening = this.launch()
    try { return await this.opening }
    finally { this.opening = null }
  }

  private async launch(): Promise<BrowserContext> {
    const release = this.profile.acquire()
    try {
      await this.profile.ensureDirectory()
      const context = await this.launchChrome(this.profile.directory, {
        executablePath: chromeExecutable, headless: false, acceptDownloads: false,
        args: ['--disable-extensions'],
      })
      context.once('close', () => { if (this.context === context) this.context = null; release() })
      this.context = context
      if (!context.pages().length) await context.newPage()
      return context
    } catch (error) { release(); throw error }
  }

  async close(): Promise<void> {
    const context = this.context ?? await this.opening
    await context?.close().catch(() => {})
  }
}

export function routineBrowserClick(target: ClickTarget, origin: string): boolean {
  if (target.type === 'submit') return false
  if (/\b(submit|send|pay|purchase|buy|checkout|order|delete|remove|save|upload|download|register|sign.?up|log.?in|subscribe|authorize|confirm|publish|post|transfer|book|apply|accept|agree)\b/i.test(target.label)) return false
  if (origin === 'https://www.irctc.co.in' && !target.form) {
    if (['journeyClass', 'journeyQuota'].includes(target.widget ?? '') && ['button', 'option'].includes(target.role ?? '')) return true
    if (['origin', 'destination'].includes(target.widget ?? '') && target.role === 'option'
      && /^.{1,100} - [A-Z0-9]{2,5}\b/.test(target.option ?? '')) return true
  }
  if (target.inForm || target.form) return false
  if (target.tag === 'A' && target.href) {
    try {
      const url = new URL(target.href, origin)
      return url.protocol === 'https:' && url.origin === origin && !url.username && !url.password
    } catch { return false }
  }
  return target.tag === 'BUTTON' && target.type === 'button' && /^(show|hide|expand|collapse|more|less|next|previous|menu|open menu|close menu|details)(\b|$)/i.test(target.label.trim())
}

export function routineBrowserFill(target: ClickTarget, origin: string, text: string): boolean {
  return origin === 'https://www.irctc.co.in' && target.tag === 'INPUT' && target.type === 'text'
    && target.role === 'searchbox' && ['origin', 'destination'].includes(target.widget ?? '')
    && /^Enter (From|To) station\b/.test(target.label) && /^[\p{L}\s.-]{2,80}$/u.test(text.trim())
}

export function validateBrowserAction(action: Action): void {
  if (action.action === 'navigate') {
    if (!action.url || !/^https:\/\//i.test(action.url)) throw new Error('Navigate requires a public HTTPS URL.')
  } else if (['click', 'double_click', 'right_click', 'fill'].includes(action.action)) {
    if (!action.selector?.trim()) throw new Error('Interaction requires a selector from the observed page.')
    if (action.selector.length > 300) throw new Error('Selector is too long.')
    if (action.action === 'fill' && action.text === undefined) throw new Error('Fill requires text.')
  } else if (action.action === 'press' && !action.key) throw new Error('Press requires a key.')
}

export async function observe(page: Page): Promise<string> {
  const url = page.url()
  const title = await page.title()
  const text = (await page.locator('body').innerText({ timeout: 5000 })).replace(/\s+/g, ' ').slice(0, 2400)
  const irctcSelectors = [
    '#origin input', '#destination input', '#journeyClass [role="button"]', '#journeyQuota [role="button"]',
    '#origin li[role="option"]', '#destination li[role="option"]',
    '#journeyClass li[role="option"]', '#journeyQuota li[role="option"]',
  ]
  const irctcControls = new URL(url).origin === 'https://www.irctc.co.in'
    ? (await Promise.all(irctcSelectors.map(async (selector) => page.locator(selector).evaluateAll((elements, prefix) =>
      elements.slice(0, 8).map((element, index) => ({
        selector: `:nth-match(${prefix}, ${index + 1})`,
        label: (element.getAttribute('aria-label') || element.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 100),
        type: element.getAttribute('type') || element.tagName.toLowerCase(),
      })).filter((item) => item.label || item.type === 'input'), selector)))).flat()
    : []
  const controls = await page.locator('a, button, input, textarea, select, [role="button"]').evaluateAll((elements) => elements.slice(0, 60).map((element, index) => {
    return { selector: `:nth-match(:is(a, button, input, textarea, select, [role="button"]), ${index + 1})`, label: (element.getAttribute('aria-label') || element.getAttribute('placeholder') || element.textContent || '').trim().slice(0, 100), type: element.getAttribute('type') || element.tagName.toLowerCase(), href: element.getAttribute('href')?.slice(0, 180) }
  }).filter((item) => item.label || item.type === 'input'))
  const observation = { url: url.slice(0, 500), title: title.slice(0, 200), text, controls: [...irctcControls, ...controls] }
  while (JSON.stringify(observation).length > 4800) {
    if (observation.controls.length) observation.controls.pop()
    else observation.text = observation.text.slice(0, -200)
  }
  return JSON.stringify(observation)
}

export async function runBrowserTask(
  request: string, permissions: PermissionManager, approve: Approval, signal: AbortSignal,
  agent: typeof askGLMBrowser = askGLMBrowser,
  step: (detail: string) => void = () => {},
  session?: ChromeBrowserSession,
): Promise<string> {
  if (process.platform !== 'darwin') throw new Error('Controlled Chrome browsing is currently available only on macOS.')
  if (!request.trim() || request.length > 2000) throw new Error('Enter a browser task of at most 2,000 characters.')
  if (signal.aborted) throw new Error('Cancelled')
  const context = session ? await session.open() : await chromium.launchPersistentContext('', {
    executablePath: chromeExecutable, headless: false, acceptDownloads: false, serviceWorkers: 'block',
    args: ['--disable-extensions'],
  })
  const stop = () => { if (!session) void context.close() }
  signal.addEventListener('abort', stop, { once: true })
  const approved = new Set<string>()
  const readCapability = session ? 'browser.readSignedIn' : 'browser.read'
  const routeFilter = async (route: Route) => {
    const request = route.request()
    try {
      const origin = await publicOrigin(request.url())
      if (signal.aborted || request.method() !== 'GET' || request.resourceType() === 'websocket') { await route.abort(); return }
      if (!approved.has(origin)) {
        if (!request.isNavigationRequest() || !await approve(origin, session ? 'signed-in-read' : undefined)) { await route.abort(); return }
        approved.add(origin)
      }
      if (!permissions.isAllowed(readCapability, origin)) { await route.abort(); return }
      await route.continue()
    } catch { await route.abort().catch(() => {}) }
  }
  try {
    const page = selectBrowserTab(context.pages().filter((tab) => !tab.isClosed()), request) ?? await context.newPage()
    page.setDefaultTimeout(8000)
    page.setDefaultNavigationTimeout(12000)
    await context.route('**/*', routeFilter)
    let initial = ''
    if (session && page.url().startsWith('https://')) {
      const origin = await publicOrigin(page.url())
      if (!permissions.isAllowed(readCapability, origin) && !await approve(origin, 'signed-in-read')) throw new Error(`Reading ${origin} was not approved.`)
      if (!permissions.isAllowed(readCapability, origin)) throw new Error('Signed-in read permission is required.')
      approved.add(origin)
      initial = `\nCurrent approved Chrome tab observation: ${await observe(page)}`
    }
    let actions = initial ? 1 : 0
    const answer = await agent(`${request}${initial}`, signal, async (action) => {
      validateBrowserAction(action)
      if (signal.aborted) throw new Error('Cancelled')
      if (action.action === 'navigate') {
        const origin = await publicOrigin(action.url!)
        step(`Opening ${origin}`)
        await page.goto(action.url!, { waitUntil: 'domcontentloaded' })
      } else {
        if (!page.url().startsWith('https://')) throw new Error('Navigate to an approved HTTPS page first.')
        const origin = await publicOrigin(page.url())
        step(`${action.action.replaceAll('_', ' ')} on ${origin}`)
        if (!permissions.isAllowed(readCapability, origin)) throw new Error('Website read permission was revoked.')
        const locator = action.selector ? page.locator(action.selector) : null
        if (locator && await locator.count() !== 1) throw new Error('Selector must identify exactly one element. Observe the page again.')
        const target = (action.action === 'click' || action.action === 'fill') && locator && await locator.evaluate((element): ClickTarget => {
          const control = element.closest('a, button')
          const option = element.closest('li[role="option"].ui-dropdown-item, li[role="option"].ui-autocomplete-list-item')
          return { tag: control?.tagName ?? element.tagName, href: control?.getAttribute('href') ?? null,
            label: (control?.getAttribute('aria-label') || element.getAttribute('aria-label') || control?.textContent || element.textContent || '').trim().slice(0, 150),
            inForm: Boolean(control?.closest('form')), form: control?.getAttribute('form') ?? null,
            type: (control ?? element).getAttribute('type')?.toLowerCase() ?? null,
            role: option ? 'option' : element.closest('[role="button"], .ui-dropdown-label')?.getAttribute('role') ||
              (element.closest('.ui-dropdown-label') ? 'button' : element.getAttribute('role')),
            widget: option?.closest('p-autocomplete, p-dropdown')?.id ?? element.closest('p-autocomplete, p-dropdown')?.id ?? null,
            option: option?.textContent?.trim().slice(0, 100) ?? null }
        })
        const routineInteraction = (action.action === 'click' && target && routineBrowserClick(target, origin))
          || (action.action === 'fill' && target && routineBrowserFill(target, origin, action.text ?? ''))
        if (!['observe', 'scroll', 'back', 'forward'].includes(action.action) && !routineInteraction) {
          if (!permissions.isAllowed('browser.interact', origin) && !await approve(origin, 'grant-interact')) throw new Error('Interaction was not approved.')
          if (!permissions.isAllowed('browser.interact', origin)) throw new Error('Website interaction permission is required.')
          if (!await approve(origin, `${action.action}: ${action.selector || action.key || action.direction || ''}${action.text ? ` = ${action.text.slice(0, 100)}` : ''}`)) throw new Error('Action was not approved.')
        }
        switch (action.action) {
          case 'click': await locator!.click(); break
          case 'double_click': await locator!.dblclick(); break
          case 'right_click': await locator!.click({ button: 'right' }); break
          case 'fill':
            if (await locator!.getAttribute('type') === 'password') throw new Error('Jarvis cannot fill password fields.')
            await locator!.fill(action.text!); break
          case 'press': await page.keyboard.press(action.key!); break
          case 'scroll': await page.mouse.wheel(0, action.direction === 'up' ? -600 : 600); break
          case 'back': await page.goBack({ waitUntil: 'domcontentloaded' }); break
          case 'forward': await page.goForward({ waitUntil: 'domcontentloaded' }); break
        }
      }
      actions++
      const origin = await publicOrigin(page.url())
      if (!permissions.isAllowed(readCapability, origin)) throw new Error('Website read permission was revoked.')
      const result = await observe(page)
      step(`Read ${origin}: ${(await page.title()).slice(0, 80)}`)
      return result
    })
    if (!actions) throw new Error('GLM-5 did not inspect or interact with a page; no browser result was verified.')
    return `Browser task: ${actions} observed action(s). ${answer}`
  } finally {
    signal.removeEventListener('abort', stop)
    await context.unroute('**/*', routeFilter).catch(() => {})
    if (!session) await context.close().catch(() => {})
  }
}