import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { test } from 'node:test'
import { chromium } from 'playwright-core'
import { combineResearchResults, directResearchUrl, exactPhoneMatch, googleSearchError, publicOrigin, researchLink } from './browser-research.mjs'

test('research links reject internal, credentialed and non-HTTPS destinations', () => {
  assert.equal(researchLink('/url?q=https%3A%2F%2Fexample.com%2Farticle'), 'https://example.com/article')
  assert.equal(researchLink(`https://www.bing.com/ck/a?u=a1${Buffer.from('https://example.com/article').toString('base64url')}`), 'https://example.com/article')
  assert.equal(researchLink(`https://www.bing.com/ck/a?u=a1${Buffer.from('http://127.0.0.1/private').toString('base64url')}`), null)
  assert.equal(researchLink('https://www.bing.com/ck/a?u=invalid'), null)
  assert.equal(researchLink('/l/?uddg=https%3A%2F%2Fwww.instagram.com%2Fpublic_profile%2F'), 'https://www.instagram.com/public_profile/')
  assert.equal(researchLink('/l/?uddg=http%3A%2F%2F127.0.0.1%2Fprivate'), null)
  assert.equal(researchLink('https://html.duckduckgo.com/html/?q=test'), null)
  assert.equal(researchLink('https://www.google.com/search?q=test'), null)
  assert.equal(researchLink('http://example.com/article'), null)
  assert.equal(researchLink('https://user:pass@example.com/'), null)
  assert.equal(researchLink('javascript:alert(1)'), null)
})

test('results from each readable search engine are interleaved and deduplicated', () => {
  assert.deepEqual(combineResearchResults([
    ['https://example.com/a', 'https://example.com/b'],
    ['https://example.com/a', 'https://www.instagram.com/public_profile/'],
    ['https://example.com/c'],
  ]), ['https://example.com/a', 'https://example.com/c', 'https://example.com/b', 'https://www.instagram.com/public_profile/'])
  assert.deepEqual(combineResearchResults([[], ['https://example.com/only']]), ['https://example.com/only'])
})

test('research refuses private network and non-HTTPS origins', async () => {
  for (const url of ['http://example.com', 'https://localhost', 'https://127.0.0.1', 'https://10.0.0.3', 'https://192.168.1.2', 'https://[::1]', 'https://user:pass@example.com']) {
    await assert.rejects(publicOrigin(url))
  }
  assert.equal(await publicOrigin('https://1.1.1.1/path'), 'https://1.1.1.1')
})

test('Google verification and consent are reported instead of treated as results', () => {
  assert.match(googleSearchError('https://www.google.com/sorry/index?continue=search') || '', /verification/)
  assert.match(googleSearchError('https://www.google.com/consent?continue=search') || '', /consent/)
  assert.equal(googleSearchError('https://www.google.com/search?q=topic'), null)
})

test('a requested HTTPS URL is researched directly instead of searched as text', () => {
  assert.equal(directResearchUrl('https://bhavishya.site'), 'https://bhavishya.site/')
  assert.equal(directResearchUrl('OLED vs mini LED monitors'), null)
  assert.throws(() => directResearchUrl('http://bhavishya.site'), /HTTPS/)
  assert.throws(() => directResearchUrl('https://user:pass@bhavishya.site'), /HTTPS/)
})

test('phone research requires the full number in the inspected excerpt', () => {
  assert.equal(exactPhoneMatch('Contact us: +91 (638) 805-6383', '916388056383'), true)
  assert.equal(exactPhoneMatch('Business: 6388056383', '6388056383'), true)
  assert.equal(exactPhoneMatch('Another listing 63880563830', '6388056383'), false)
  assert.equal(exactPhoneMatch('Only 638805638 is shown', '6388056383'), false)
})

test('temporary search profile does not retain cookies and Brave results remain readable', {
  skip: process.platform !== 'darwin' || !existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
}, async () => {
  const executablePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  const first = await chromium.launchPersistentContext('', { executablePath, headless: true })
  try {
    await first.addCookies([{ name: 'temporary_test', value: 'only-this-run', domain: 'www.google.com', path: '/' }])
  } finally { await first.close() }
  const second = await chromium.launchPersistentContext('', { executablePath, headless: true })
  try {
    assert.equal((await second.cookies('https://www.google.com')).length, 0)
    const sourceContext = await second.browser()!.newContext({ javaScriptEnabled: false })
    try { assert.equal((await sourceContext.cookies('https://www.google.com')).length, 0) }
    finally { await sourceContext.close() }
    const page = await second.newPage()
    await page.setContent('<div class="snippet" data-type="web"><div class="result-content"><a href="https://example.com" style="display:none">Result</a></div></div>')
    const results = page.locator('.snippet[data-type="web"] .result-content > a[href]')
    await results.first().waitFor({ state: 'attached', timeout: 1000 })
    assert.deepEqual(await results.evaluateAll((anchors) => anchors.map((anchor) => anchor.getAttribute('href'))), ['https://example.com'])
  } finally { await second.close() }
})