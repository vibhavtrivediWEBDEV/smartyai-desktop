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

export function researchLink(href: string): string | null {
  try {
    const url = new URL(href, href.startsWith('/l/') ? 'https://html.duckduckgo.com' : 'https://www.google.com')
    const bingRedirect = url.hostname === 'www.bing.com' && url.pathname === '/ck/a'
    const encoded = url.searchParams.get('u') || ''
    const target = bingRedirect ? new URL(encoded.startsWith('a1') ? Buffer.from(encoded.slice(2), 'base64url').toString('utf8') : '')
      : url.hostname === 'www.google.com' && url.pathname === '/url' ? new URL(url.searchParams.get('q') || '')
        : ['duckduckgo.com', 'www.duckduckgo.com', 'html.duckduckgo.com'].includes(url.hostname) && url.pathname === '/l/'
          ? new URL(url.searchParams.get('uddg') || '') : url
    if (target.protocol !== 'https:' || target.username || target.password || target.port && target.port !== '443' ||
      /(^|\.)(google\.[a-z.]+|bing\.com|duckduckgo\.com|brave\.com|youtube\.com)$/.test(target.hostname)) return null
    target.hash = ''
    return target.href
  } catch { return null }
}

export function googleSearchError(url: string): string | null {
  const path = new URL(url).pathname
  if (path.startsWith('/sorry/') || path === '/sorry') return 'Google requested unusual-traffic verification in Chrome. Jarvis cannot read search results until Google allows this session; no comparison was generated.'
  if (path.startsWith('/consent')) return 'Google requested consent in Chrome. Complete it in the visible Chrome window and retry; no comparison was generated.'
  return null
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

export function combineResearchResults(providerResults: string[][]): string[] {
  const links: string[] = []
  for (let index = 0; index < 8; index++) {
    for (const results of providerResults) {
      const link = results[index]
      if (link && !links.includes(link)) links.push(link)
    }
  }
  return links
}

export async function researchBrowser(
  query: string, permissions: PermissionManager, approve: (origin: string) => Promise<boolean>,
  summarize: (evidence: string, signal: AbortSignal) => Promise<string>, signal: AbortSignal,
): Promise<string> {
  if (signal.aborted) throw new Error('Cancelled')
  if (process.platform !== 'darwin') throw new Error('Controlled Chrome research is currently available only on macOS.')
  if (!/\S/.test(query) || query.length > 200) throw new Error('Enter a research topic of at most 200 characters.')
  const target = directResearchUrl(query)
  const phoneDigits = /^"(\d{8,15})" phone number$/.exec(query)?.[1]
  const targetOrigin = target ? await publicOrigin(target) : null
  const searchContext = await chromium.launchPersistentContext('', {
    executablePath: chrome, headless: false, args: ['--disable-extensions'], acceptDownloads: false, serviceWorkers: 'block',
  })
  const browser = searchContext.browser()
  if (!browser) { await searchContext.close(); throw new Error('Research Chrome browser is unavailable.') }
  const stop = () => { void searchContext.close() }
  signal.addEventListener('abort', stop, { once: true })
  const approved = new Set<string>()
  const denied = new Set<string>()
  try {
    if (signal.aborted) throw new Error('Cancelled')
    const context = await browser.newContext({ javaScriptEnabled: false, acceptDownloads: false, serviceWorkers: 'block' })
    const page = await context.newPage()
    const searchPage = await searchContext.newPage()
    page.setDefaultNavigationTimeout(12000)
    searchPage.setDefaultNavigationTimeout(20000)
    const searchRoute = async (route: Route) => {
      const request = route.request()
      const url = new URL(request.url())
      if (signal.aborted || request.method() !== 'GET' ||
        !['https://www.google.com', 'https://www.gstatic.com', 'https://search.brave.com', 'https://html.duckduckgo.com'].includes(url.origin) ||
        !permissions.isAllowed('browser.read', url.origin === 'https://www.gstatic.com' ? 'https://www.google.com' : url.origin) ||
        (request.isNavigationRequest() && request.frame() !== searchPage.mainFrame())) {
        await route.abort().catch(() => {})
        return
      }
      await route.continue()
    }
    await searchPage.route('**/*', searchRoute)
    await page.route('**/*', async (route) => {
      const request = route.request()
      if (signal.aborted || request.method() !== 'GET' || !request.isNavigationRequest() || request.resourceType() !== 'document' || request.frame() !== page.mainFrame()) {
        await route.abort().catch(() => {})
        return
      }
      try {
        const origin = await publicOrigin(request.url())
        if (denied.has(origin)) { await route.abort(); return }
        if (!approved.has(origin)) {
          if (!await approve(origin)) { denied.add(origin); await route.abort(); return }
          approved.add(origin)
        }
        if (signal.aborted || !permissions.isAllowed('browser.read', origin)) { await route.abort(); return }
        await route.continue()
      } catch { await route.abort().catch(() => {}) }
    })
    const search = async (text: string) => {
      if (signal.aborted) throw new Error('Cancelled')
      const readResults = async (provider: 'Google' | 'DuckDuckGo' | 'Brave') => {
        const origin = provider === 'Google' ? 'https://www.google.com'
          : provider === 'DuckDuckGo' ? 'https://html.duckduckgo.com' : 'https://search.brave.com'
        if (!approved.has(origin)) {
          if (!await approve(origin)) throw new Error(`${provider} read access was not approved.`)
          approved.add(origin)
        }
        const url = provider === 'Google' ? `${origin}/search?q=${encodeURIComponent(text)}&num=8`
          : provider === 'DuckDuckGo' ? `${origin}/html/?q=${encodeURIComponent(text)}`
            : `${origin}/search?q=${encodeURIComponent(text)}`
        const selector = provider === 'Google' ? 'a[href]:has(h3)'
          : provider === 'DuckDuckGo' ? 'a.result__a[href]' : '.snippet[data-type="web"] .result-content > a[href]'
        const response = await searchPage.goto(url, { waitUntil: 'domcontentloaded' })
        if (signal.aborted) throw new Error('Cancelled')
        if (provider === 'Google') {
          const blocked = googleSearchError(searchPage.url())
          if (blocked) throw new Error(blocked)
        }
        if (!response?.ok() || new URL(searchPage.url()).pathname !== (provider === 'DuckDuckGo' ? '/html/' : '/search')) throw new Error(`${provider} search results could not be read in Chrome.`)
        try { await searchPage.locator(selector).first().waitFor({ state: 'attached', timeout: 10000 }) }
        catch { if (signal.aborted) throw new Error('Cancelled'); throw new Error(`${provider} returned no readable source links in Chrome.`) }
        const links = await searchPage.locator(selector).evaluateAll((anchors) => anchors.map((anchor) => anchor.getAttribute('href') || '').slice(0, 30))
        const results = [...new Set(links.map(researchLink).filter((link): link is string => !!link))].slice(0, 8)
        if (!results.length) throw new Error(`${provider} did not return readable source links in Chrome.`)
        return results
      }
      const providerResults: string[][] = []
      const failures: string[] = []
      for (const provider of ['Google', 'DuckDuckGo', 'Brave'] as const) {
        try { providerResults.push(await readResults(provider)) }
        catch (error) {
          if (signal.aborted) throw new Error('Cancelled')
          failures.push(`${provider}: ${error instanceof Error ? error.message : 'unavailable'}`)
        }
      }
      if (!providerResults.length) throw new Error(`No public search results could be read (${failures.join('; ')}). No source-backed answer was generated.`)
      return combineResearchResults(providerResults)
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
          const origin = await publicOrigin(link)
          if (denied.has(origin)) continue
          const response = await page.goto(link, { waitUntil: 'domcontentloaded' })
          if (!response?.ok() || !/text\/html/i.test(response.headers()['content-type'] || '')) continue
          if (!permissions.isAllowed('browser.read', await publicOrigin(page.url()))) continue
          if (targetOrigin && new URL(page.url()).origin !== targetOrigin) continue
          const text = await page.locator('body').innerText({ timeout: 5000 })
          if (!permissions.isAllowed('browser.read', await publicOrigin(page.url()))) continue
          const excerpt = text.replace(/\s+/g, ' ').slice(0, 4500)
          if (phoneDigits && !exactPhoneMatch(excerpt, phoneDigits)) continue
          if (text.trim().length >= 180) sources.push({ url: page.url(), text: excerpt })
        } catch { if (signal.aborted) throw new Error('Cancelled') }
      }
    }
    await inspect(links, 3)
    if (target && !sources.length) throw new Error(`Could not read ${target} directly. No answer was generated from other websites.`)
    if (!target && sources.length < (phoneDigits ? 1 : 2) && links.length) {
      const host = new URL(links[0]).hostname
      await inspect(await search(`${query} site:${host}`), 4)
    } else if (!target && sources.length >= 2) {
      try {
        await inspect(await search(`${query} site:${new URL(sources[0].url).hostname}`), 4)
      } catch (error) { if (signal.aborted) throw error }
    }
    if (phoneDigits && !sources.length) throw new Error(`No readable public page with the exact number ${phoneDigits} was found. Jarvis cannot verify who it belongs to.`)
    if (!target && !phoneDigits && sources.length < 2) throw new Error(`Only ${sources.length} readable source(s) found. Approve at least two sites and retry; no comparison was generated.`)
    if (signal.aborted) throw new Error('Cancelled')
    if (sources.some((source) => !permissions.isAllowed('browser.read', new URL(source.url).origin))) {
      throw new Error('A website read grant was revoked during research. No page text was sent to GLM-5.')
    }
    const evidence = sources.map((source, index) => `[${index + 1}] ${source.url}\n${source.text}`).join('\n\n')
    const answer = await summarize(evidence, signal)
    return `${answer}\n\nSources inspected:\n${sources.map((source, index) => `[${index + 1}] ${source.url}`).join('\n')}`
  } finally {
    signal.removeEventListener('abort', stop)
    await searchContext.close().catch(() => {})
  }
}