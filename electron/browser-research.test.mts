import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { chromium } from 'playwright-core'
import { directResearchUrl, exactPhoneMatch, googleAccountRedirect, googleSearchError, googleSearchPageError, googleSignInRejected, manualGoogleUrl, publicOrigin, publicResearchOrigin, researchLink, retryGoogleAfterManualSignIn } from './browser-research.mjs'

test('research links reject internal, credentialed and non-HTTPS destinations', () => {
  assert.equal(researchLink('/url?q=https%3A%2F%2Fexample.com%2Farticle'), 'https://example.com/article')
  assert.equal(researchLink('/url?sa=t&url=https%3A%2F%2Fexample.com%2Fsource'), 'https://example.com/source')
  assert.equal(researchLink('/url?q=OLED+vs+mini+LED&url=https%3A%2F%2Fexample.com%2Freview'), 'https://example.com/review')
  assert.equal(researchLink('/url?url=http%3A%2F%2F127.0.0.1%2Fprivate'), null)
  assert.equal(researchLink(`https://www.bing.com/ck/a?u=a1${Buffer.from('https://example.com/article').toString('base64url')}`), 'https://example.com/article')
  assert.equal(researchLink(`https://www.bing.com/ck/a?u=a1${Buffer.from('http://127.0.0.1/private').toString('base64url')}`), null)
  assert.equal(researchLink('https://www.bing.com/ck/a?u=invalid'), null)
  assert.equal(researchLink('https://www.google.com/search?q=test'), null)
  assert.equal(researchLink('http://example.com/article'), null)
  assert.equal(researchLink('https://user:pass@example.com/'), null)
  assert.equal(researchLink('javascript:alert(1)'), null)
})

test('research refuses private network and non-HTTPS origins', async () => {
  for (const url of ['http://example.com', 'https://localhost', 'https://127.0.0.1', 'https://10.0.0.3', 'https://192.168.1.2', 'https://[::1]', 'https://user:pass@example.com']) {
    await assert.rejects(publicOrigin(url))
  }
  assert.equal(await publicOrigin('https://1.1.1.1/path'), 'https://1.1.1.1')
})

test('research never authorizes account or sign-in pages as public sources', async () => {
  assert.equal(await publicResearchOrigin('https://example.com/article'), 'https://example.com')
  for (const url of ['https://accounts.example.com/', 'https://example.com/login', 'https://example.com/oauth/authorize', 'https://example.com/register?next=/article']) {
    await assert.rejects(publicResearchOrigin(url), /Account pages require user interaction/)
  }
})

test('Google verification and consent are reported instead of treated as results', () => {
  assert.match(googleSearchError('https://www.google.com/sorry/index?continue=search') || '', /verification/)
  assert.match(googleSearchError('https://www.google.com/consent?continue=search') || '', /consent/)
  assert.match(googleSearchError('https://accounts.google.com/ServiceLogin?continue=https%3A%2F%2Fwww.google.com%2Fsearch') || '', /sign-in/)
  assert.equal(googleSearchError('https://www.google.com/search?q=topic'), null)
  assert.equal(manualGoogleUrl('https://www.google.com/sorry/index?continue=search'), 'https://www.google.com/sorry/index?continue=search')
  assert.equal(manualGoogleUrl('https://www.google.com/consent?continue=search'), 'https://www.google.com/consent?continue=search')
  assert.equal(manualGoogleUrl('https://www.google.com/search?q=topic'), 'https://www.google.com/search?q=topic')
  assert.equal(manualGoogleUrl('https://accounts.google.com/ServiceLogin?continue=https%3A%2F%2Fwww.google.com%2Fsearch'), 'https://accounts.google.com/ServiceLogin?continue=https%3A%2F%2Fwww.google.com%2Fsearch')
  assert.equal(manualGoogleUrl('https://accounts.google.com/v3/signin/identifier?continue=search'), 'https://accounts.google.com/v3/signin/identifier?continue=search')
  assert.equal(manualGoogleUrl('https://www.google.com.evil.test/sorry'), 'https://www.google.com/')
  assert.match(googleSearchPageError("Our systems have detected unusual traffic from your computer network.") || '', /verification/)
  assert.equal(googleSearchPageError('OLED vs mini LED monitors reviews'), null)
})

test('Google account rejection is not treated as another solvable sign-in prompt', () => {
  const rejected = 'https://accounts.google.com/v3/signin/rejected?continue=https%3A%2F%2Fwww.google.com%2Fsearch'
  assert.equal(googleAccountRedirect('https://accounts.google.com/v3/signin/identifier?continue=search'), true)
  assert.equal(googleAccountRedirect('https://accounts.google.com.evil.test/v3/signin/identifier'), false)
  assert.equal(googleAccountRedirect('https://www.google.com/search?q=topic'), false)
  assert.equal(googleSignInRejected(rejected), true)
  assert.match(googleSearchError(rejected) || '', /rejected.*controlled Chrome/i)
  assert.doesNotMatch(googleSearchError(rejected) || '', /Bing/i)
  assert.equal(googleSignInRejected('https://accounts.google.com/ServiceLogin'), false)
  assert.equal(googleSignInRejected('https://accounts.google.com.evil.test/v3/signin/rejected'), false)
})

test('manual Google sign-in retries only after user confirmation', async () => {
  const calls: string[] = []
  const openSignIn = async () => { calls.push('open sign-in') }
  const readGoogle = async () => { calls.push('read Google'); return ['https://example.com'] }
  const signal = new AbortController().signal
  assert.equal(await retryGoogleAfterManualSignIn('blocked', async () => false, openSignIn, readGoogle, signal), null)
  assert.equal(calls.length, 0)
  assert.deepEqual(await retryGoogleAfterManualSignIn('blocked', async (reason, open) => {
    assert.equal(reason, 'blocked')
    await open()
    calls.push('user confirmed')
    return true
  }, openSignIn, readGoogle, signal), ['https://example.com'])
  assert.deepEqual(calls, ['open sign-in', 'user confirmed', 'read Google'])
})

test('manual sign-in never treats confirmation as proof of readable results', async () => {
  await assert.rejects(retryGoogleAfterManualSignIn('blocked', async () => true, async () => {}, async () => {
    throw new Error('Google still blocks search')
  }, new AbortController().signal), /Google still blocks search/)
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(retryGoogleAfterManualSignIn('blocked', async () => true, async () => {}, async () => 'results', controller.signal), /Cancelled/)
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

test('search profile retains persistent cookies while source contexts stay separate and hidden results remain readable', {
  skip: process.platform !== 'darwin' || !existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
}, async () => {
  const profileDir = await mkdtemp(join(tmpdir(), 'jarvis-chrome-test-'))
  const executablePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  try {
    const first = await chromium.launchPersistentContext(profileDir, { executablePath, headless: true })
    try {
      await first.addCookies([{ name: 'persistent_test', value: 'retained', domain: 'www.google.com', path: '/', expires: Math.floor(Date.now() / 1000) + 3600 }])
    } finally { await first.close() }
    const second = await chromium.launchPersistentContext(profileDir, { executablePath, headless: true })
    try {
      assert.equal((await second.cookies('https://www.google.com')).find((cookie) => cookie.name === 'persistent_test')?.value, 'retained')
      const sourceContext = await second.browser()!.newContext({ javaScriptEnabled: false })
      try { assert.equal((await sourceContext.cookies('https://www.google.com')).length, 0) }
      finally { await sourceContext.close() }
      const page = await second.newPage()
      await page.setContent('<div class="b_algo"><h2><a href="https://example.com" style="display:none">Result</a></h2></div>')
      await page.locator('.b_algo h2 a[href]').first().waitFor({ state: 'attached', timeout: 1000 })
      assert.deepEqual(await page.locator('.b_algo h2 a[href]').evaluateAll((anchors) => anchors.map((anchor) => anchor.getAttribute('href'))), ['https://example.com'])
    } finally { await second.close() }
  } finally { await rm(profileDir, { recursive: true, force: true }) }
})