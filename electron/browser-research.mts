import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { chromium, type Route } from 'playwright-core'
import type { PermissionManager } from './permissions.mjs'

const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const blockedAddress = (address: string) => {
  const value = address.toLowerCase()
  if (value.includes(':')) return !/^(2|3)[0-9a-f]{3}:/.test(value) || value.startsWith('2001:db8:')
  const parts = value.split('.').map(Number)
  return parts[0] === 0 || parts[0] === 10 || parts[0] === 127 || parts[0] >= 224 ||
    (parts[0] === 169 && parts[1] === 254) || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168) || (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) ||
    (parts[0] === 192 && parts[1] === 0) || (parts[0] === 198 && parts[1] >= 18 && parts[1] <= 19)
}

export async function publicOrigin(value: string): Promise<string> {
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username || url.password || url.port && url.port !== '443' ||
    url.hostname.endsWith('.local') || url.hostname === 'localhost') throw new Error('Research requires a public HTTPS website.')
  const addresses = isIP(url.hostname) ? [url.hostname] : (await lookup(url.hostname, { all: true })).map((entry) => entry.address)
  if (!addresses.length || addresses.some(blockedAddress)) throw new Error('Research cannot access local or private network addresses.')
  return url.origin
}

export async function publicResearchOrigin(value: string): Promise<string> {
  const url = new URL(value)
  if (/(^|\.)(accounts|login|signin|signup|auth)\./i.test(url.hostname) ||
    /(^|\/)(?:login|signin|sign-in|signup|sign-up|register|account|oauth|authorize)(?:\/|$)/i.test(url.pathname)) {
    throw new Error('Account pages require user interaction; Jarvis does not read or submit them.')
  }
  return publicOrigin(value)
}

export function researchLink(href: string): string | null {
  try {
    const url = new URL(href, 'https://www.google.com')
    const bingRedirect = url.hostname === 'www.bing.com' && url.pathname === '/ck/a'
    const encoded = url.searchParams.get('u') || ''
    const target = bingRedirect ? new URL(encoded.startsWith('a1') ? Buffer.from(encoded.slice(2), 'base64url').toString('utf8') : '')
      : url.hostname === 'www.google.com' && url.pathname === '/url' ? new URL(url.searchParams.get('url') || url.searchParams.get('q') || '') : url
    if (target.protocol !== 'https:' || target.username || target.password || target.port && target.port !== '443' ||
      /(^|\.)(google\.[a-z.]+|bing\.com|youtube\.com)$/.test(target.hostname)) return null
    target.hash = ''
    return target.href
  } catch { return null }
}

export function googleSignInRejected(url: string): boolean {
  const location = new URL(url)
  return location.origin === 'https://accounts.google.com' && /^\/(?:v\d+\/)?signin\/rejected(?:\/|$)/.test(location.pathname)
}

export function googleAccountRedirect(url: string): boolean {
  return new URL(url).origin === 'https://accounts.google.com'
}

export function googleSearchError(url: string): string | null {
  const location = new URL(url)
  if (googleSignInRejected(url)) return 'Google rejected sign-in from this controlled Chrome browser. Jarvis cannot make Google accept it.'
  if (location.origin === 'https://accounts.google.com') return 'Google requested sign-in in Chrome. Complete it in the visible Chrome window and retry.'
  const path = location.pathname
  if (path.startsWith('/sorry/') || path === '/sorry') return 'Google requested unusual-traffic verification in Chrome. Jarvis cannot read search results until Google allows this session.'
  if (path.startsWith('/consent')) return 'Google requested consent in Chrome. Complete it in the visible Chrome window and retry.'
  return null
}

export function googleSearchPageError(text: string): string | null {
  if (/unusual traffic from your computer network|not a robot|verify (?:that )?you(?:'re| are) human|complete the captcha/i.test(text)) {
    return 'Google requested unusual-traffic verification in Chrome. Complete it in the visible Chrome window before retrying.'
  }
  return null
}

export function manualGoogleUrl(searchUrl: string): string {
  const url = new URL(searchUrl)
  return (url.origin === 'https://www.google.com' && (url.pathname === '/search' || googleSearchError(url.href)) ||
    url.origin === 'https://accounts.google.com' && googleSearchError(url.href))
    ? url.href : 'https://www.google.com/'
}

export async function retryGoogleAfterManualSignIn<T>(
  reason: string, manualSignIn: (reason: string, openSignIn: () => Promise<void>) => Promise<boolean>,
  openSignIn: () => Promise<void>, readGoogle: () => Promise<T>, signal: AbortSignal,
): Promise<T | null> {
  if (signal.aborted) throw new Error('Cancelled')
  if (!await manualSignIn(reason, openSignIn)) return null
  if (signal.aborted) throw new Error('Cancelled')
  return readGoogle()
}

export function directResearchUrl(query: string): string | null {
  const text = query.trim()
  if (!/^https?:\/\//i.test(text)) return null
  const url = new URL(text)
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Research requires a public HTTPS website.')
  return url.href
}

export function exactPhoneMatch(text: string, digits: string): boolean {
  return new RegExp(`(?<!\\d)${digits.split('').join('[\\s().-]*')}(?!\\d)`).test(text)
}

export async function researchBrowser(
  query: string, permissions: PermissionManager, approve: (origin: string) => Promise<boolean>,
  summarize: (evidence: string, signal: AbortSignal) => Promise<string>, signal: AbortSignal,
  profileDir: string, onGoogleFailure: (reason: string) => void,
  manualGoogleSignIn?: (reason: string, openSignIn: () => Promise<void>) => Promise<boolean>,
): Promise<string> {
  if (signal.aborted) throw new Error('Cancelled')
  if (process.platform !== 'darwin') throw new Error('Controlled Chrome research is currently available only on macOS.')
  if (!/\S/.test(query) || query.length > 200) throw new Error('Enter a research topic of at most 200 characters.')
  const target = directResearchUrl(query)
  const phoneDigits = /^"(\d{8,15})" phone number$/.exec(query)?.[1]
  const targetOrigin = target ? await publicResearchOrigin(target) : null
  const canRead = (origin: string) => permissions.isAllowed('browser.read', origin) || permissions.isAllowed('browser.research-autopilot', 'public-https')
  const searchContext = await chromium.launchPersistentContext(profileDir, {
    executablePath: chrome, headless: false, args: ['--disable-extensions'], acceptDownloads: false, serviceWorkers: 'block',
  })
  const browser = searchContext.browser()
  if (!browser) { await searchContext.close(); throw new Error('Research Chrome browser is unavailable.') }
  const stop = () => { void searchContext.close() }
  signal.addEventListener('abort', stop, { once: true })
  const approved = new Set<string>()
  const denied = new Set<string>()
  let accountPageRequired = false
  let attemptedManualGoogleSignIn = false
  let searchProvider = 'Google'
  try {
    if (signal.aborted) throw new Error('Cancelled')
    const context = await browser.newContext({ javaScriptEnabled: false, acceptDownloads: false, serviceWorkers: 'block' })
    const page = await context.newPage()
    const searchPage = await searchContext.newPage()
    page.setDefaultNavigationTimeout(12000)
    searchPage.setDefaultNavigationTimeout(20000)
    let accountRedirectUrl: string | null = null
    const searchRoute = async (route: Route) => {
      const request = route.request()
      const url = new URL(request.url())
      const accountRedirect = googleAccountRedirect(request.url()) &&
        request.isNavigationRequest() && request.frame() === searchPage.mainFrame()
      if (accountRedirect) {
        accountRedirectUrl = request.url()
        await route.abort().catch(() => {})
        return
      }
      if (signal.aborted || request.method() !== 'GET' ||
        !['https://www.google.com', 'https://www.gstatic.com'].includes(url.origin) ||
        !canRead(url.origin === 'https://www.gstatic.com' ? 'https://www.google.com' : url.origin) ||
        (request.isNavigationRequest() && request.frame() !== searchPage.mainFrame())) {
        await route.abort().catch(() => {})
        return
      }
      await route.continue()
    }
    await searchPage.route('**/*', searchRoute)
    const bingPage = await context.newPage()
    bingPage.setDefaultNavigationTimeout(20000)
    await bingPage.route('**/*', async (route) => {
      const request = route.request()
      if (signal.aborted || request.method() !== 'GET' || new URL(request.url()).origin !== 'https://www.bing.com' ||
        !canRead('https://www.bing.com') || request.isNavigationRequest() && request.frame() !== bingPage.mainFrame()) {
        await route.abort().catch(() => {})
        return
      }
      await route.continue()
    })
    await page.route('**/*', async (route) => {
      const request = route.request()
      if (signal.aborted || request.method() !== 'GET' || !request.isNavigationRequest() || request.resourceType() !== 'document' || request.frame() !== page.mainFrame()) {
        await route.abort().catch(() => {})
        return
      }
      try {
        const origin = await publicResearchOrigin(request.url())
        if (denied.has(origin)) { await route.abort(); return }
        if (!approved.has(origin)) {
          if (!await approve(origin)) { denied.add(origin); await route.abort(); return }
          approved.add(origin)
        }
        if (signal.aborted || !canRead(origin)) { await route.abort(); return }
        await route.continue()
      } catch (error) {
        if (error instanceof Error && /Account pages require user interaction/.test(error.message)) accountPageRequired = true
        await route.abort().catch(() => {})
      }
    })
    const search = async (text: string) => {
      if (signal.aborted) throw new Error('Cancelled')
      const readBing = async () => {
        const origin = 'https://www.bing.com'
        if (!approved.has(origin)) {
          if (!await approve(origin)) throw new Error('Bing read access was not approved.')
          approved.add(origin)
        }
        const response = await bingPage.goto(`${origin}/search?q=${encodeURIComponent(text)}`, { waitUntil: 'domcontentloaded' })
        if (signal.aborted) throw new Error('Cancelled')
        if (!response?.ok() || new URL(bingPage.url()).origin !== origin || new URL(bingPage.url()).pathname !== '/search') {
          throw new Error('Bing search results could not be read in Chrome.')
        }
        const selector = '.b_algo h2 a[href]'
        await bingPage.locator(selector).first().waitFor({ state: 'attached', timeout: 10000 })
        const links = await bingPage.locator(selector).evaluateAll((anchors) => anchors.map((anchor) => anchor.getAttribute('href') || '').slice(0, 30))
        const results = [...new Set(links.map(researchLink).filter((link): link is string => !!link))].slice(0, 8)
        if (!results.length) throw new Error('Bing did not return readable source links in Chrome.')
        searchProvider = 'Bing (Google unavailable)'
        return results
      }
      const readResults = async () => {
        const origin = 'https://www.google.com'
        if (!approved.has(origin)) {
          if (!await approve(origin)) throw new Error('Google read access was not approved.')
          approved.add(origin)
        }
        const url = `${origin}/search?q=${encodeURIComponent(text)}&num=8`
        const selector = 'a[href]:has(h3), a[href]:has(h2)'
        const response = await searchPage.goto(url, { waitUntil: 'domcontentloaded' })
        if (signal.aborted) throw new Error('Cancelled')
        const blocked = googleSearchError(searchPage.url())
        if (blocked) throw new Error(blocked)
        if (!response?.ok() || new URL(searchPage.url()).pathname !== '/search') throw new Error('Google search results could not be read in Chrome.')
        try { await searchPage.locator(selector).first().waitFor({ state: 'attached', timeout: 10000 }) }
        catch {
          if (signal.aborted) throw new Error('Cancelled')
          const pageError = googleSearchPageError(await searchPage.locator('body').innerText().catch(() => ''))
          throw new Error(pageError || 'Google returned no readable source links in Chrome.')
        }
        const links = await searchPage.locator(selector).evaluateAll((anchors) => anchors.map((anchor) => anchor.getAttribute('href') || '').slice(0, 30))
        const results = [...new Set(links.map(researchLink).filter((link): link is string => !!link))].slice(0, 8)
        if (!results.length) throw new Error('Google did not return readable source links in Chrome.')
        return results
      }
      try {
        return await readResults()
      } catch (error) {
        if (signal.aborted) throw new Error('Cancelled')
        if (error instanceof Error && error.message === 'Google read access was not approved.') throw error
        let googleFailure = error instanceof Error ? error.message : 'unavailable'
        const rejectedPage = searchContext.pages().find((openPage) => googleSignInRejected(openPage.url()))
        if (rejectedPage) googleFailure = googleSearchError(rejectedPage.url())!
        const accountSignIn = accountRedirectUrl || googleAccountRedirect(searchPage.url())
        if (accountSignIn && !rejectedPage) googleFailure = 'Google requires sign-in in the controlled Chrome browser.'
        onGoogleFailure(googleFailure)
        try { return await readBing() }
        catch (fallbackError) {
          if (signal.aborted) throw new Error('Cancelled')
          if (fallbackError instanceof Error && fallbackError.message !== 'Bing read access was not approved.') {
            googleFailure += ` Bing fallback failed (${fallbackError.message}).`
          }
        }
        if (!rejectedPage && !attemptedManualGoogleSignIn && manualGoogleSignIn && canRead('https://www.google.com')) {
          attemptedManualGoogleSignIn = true
          try {
            const results = await retryGoogleAfterManualSignIn(googleFailure, manualGoogleSignIn, async () => {
              if (signal.aborted) throw new Error('Cancelled')
              const signInPage = await searchContext.newPage()
              await signInPage.goto(manualGoogleUrl(accountRedirectUrl || searchPage.url()), { waitUntil: 'domcontentloaded' })
            }, () => {
              const rejected = searchContext.pages().find((openPage) => googleSignInRejected(openPage.url()))
              if (rejected) throw new Error(googleSearchError(rejected.url())!)
              return readResults()
            }, signal)
            if (results) return results
          } catch (signInError) {
            if (signal.aborted) throw new Error('Cancelled')
            googleFailure = signInError instanceof Error ? signInError.message : 'manual sign-in unavailable'
          }
        }
        throw new Error(`Search failed (${googleFailure}). No source-backed answer was generated.`)
      }
    }
    const links = target ? [target] : await search(query)
    const visited = new Set<string>()
    const sources: { url: string; text: string }[] = []
    const inspect = async (candidates: string[], limit: number) => {
      for (const link of candidates) {
        if (signal.aborted) throw new Error('Cancelled')
        if (sources.length >= limit || visited.has(link)) continue
        visited.add(link)
        try {
          const origin = await publicResearchOrigin(link)
          if (denied.has(origin)) continue
          const response = await page.goto(link, { waitUntil: 'domcontentloaded' })
          if (!response?.ok() || !/text\/html/i.test(response.headers()['content-type'] || '')) continue
          if (!canRead(await publicResearchOrigin(page.url()))) continue
          if (targetOrigin && new URL(page.url()).origin !== targetOrigin) continue
          const text = await page.locator('body').innerText({ timeout: 5000 })
          if (!canRead(await publicResearchOrigin(page.url()))) continue
          const excerpt = text.replace(/\s+/g, ' ').slice(0, 4500)
          if (phoneDigits && !exactPhoneMatch(excerpt, phoneDigits)) continue
          if (text.trim().length >= 180) sources.push({ url: page.url(), text: excerpt })
        } catch { if (signal.aborted) throw new Error('Cancelled') }
      }
    }
    await inspect(links, 3)
    if (target && !sources.length) throw new Error(accountPageRequired
      ? `${target} requires account sign-in or signup. Open the site yourself to complete it; Jarvis cannot read the account page or resume this source automatically. No answer was generated.`
      : `Could not read ${target} directly. No answer was generated from other websites.`)
    if (!target && sources.length < (phoneDigits ? 1 : 2) && links.length) {
      const host = new URL(links[0]).hostname
      await inspect(await search(`${query} site:${host}`), 4)
    } else if (!target && sources.length >= 2) {
      try {
        await inspect(await search(`${query} site:${new URL(sources[0].url).hostname}`), 4)
      } catch (error) { if (signal.aborted) throw error }
    }
    if (phoneDigits && !sources.length) throw new Error(`No readable public page with the exact number ${phoneDigits} was found. Jarvis cannot verify who it belongs to.`)
    if (!target && !phoneDigits && sources.length < 2) throw new Error(`Only ${sources.length} readable source(s) found.${accountPageRequired ? ' A source required user sign-in or signup; Jarvis cannot read its account page.' : ''} At least two public sources are required; no comparison was generated.`)
    if (signal.aborted) throw new Error('Cancelled')
    if (sources.some((source) => !canRead(new URL(source.url).origin))) {
      throw new Error('Research read access was revoked during research. No page text was sent to GLM-5.')
    }
    const evidence = sources.map((source, index) => `[${index + 1}] ${source.url}\n${source.text}`).join('\n\n')
    const answer = await summarize(evidence, signal)
    return `Search provider: ${searchProvider}\n\n${answer}\n\nSources inspected:\n${sources.map((source, index) => `[${index + 1}] ${source.url}`).join('\n')}`
  } finally {
    signal.removeEventListener('abort', stop)
    await searchContext.close().catch(() => {})
  }
}