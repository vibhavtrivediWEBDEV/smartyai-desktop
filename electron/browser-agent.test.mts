import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { chromium } from 'playwright-core'
import { ChromeBrowserSession, observe, routineBrowserClick, routineBrowserFill, runBrowserTask, selectBrowserTab, validateBrowserAction } from './browser-agent.mjs'
import { ChromeProfile, chromeExecutable } from './chrome-profile.mjs'
import type { PermissionManager } from './permissions.mjs'

test('browser tasks select a matching open HTTPS tab or the latest public tab', () => {
  const pages = ['about:blank', 'https://example.com/one', 'https://www.irctc.co.in/nget/train-search', 'https://example.com/two'].map((url) => ({ url: () => url }))
  assert.equal(selectBrowserTab(pages, 'browse https://www.irctc.co.in'), pages[2])
  assert.equal(selectBrowserTab(pages, 'browse https://another.example'), undefined)
  assert.equal(selectBrowserTab(pages, 'inspect current page'), pages[3])
  assert.equal(selectBrowserTab(pages.slice(0, 1), 'inspect current page'), pages[0])
})

test('Chrome session keeps manually opened tabs between requests until closed', {
  skip: process.platform !== 'darwin' || !existsSync(chromeExecutable),
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jarvis-chrome-session-'))
  const session = new ChromeBrowserSession(new ChromeProfile(join(directory, 'profile')),
    (profile, options) => chromium.launchPersistentContext(profile, { ...options, headless: true }))
  try {
    const first = await session.open()
    const tab = await first.newPage()
    await tab.goto('data:text/html,<title>Manual tab</title>')
    const second = await session.open()
    assert.equal(second, first)
    assert.equal(second.pages().includes(tab), true)
    assert.equal(await tab.title(), 'Manual tab')
    await assert.rejects(runBrowserTask('inspect current tab', {} as PermissionManager, async () => false,
      new AbortController().signal, async () => 'No page inspected', () => {}, session), /did not inspect/)
    assert.equal((await session.open()).pages().includes(tab), true)
  } finally { await session.close(); await rm(directory, { recursive: true, force: true }) }
})

test('browser actions require a target and never accept non-HTTPS navigation', () => {
  assert.throws(() => validateBrowserAction({ action: 'navigate', url: 'file:///etc/passwd' }), /public HTTPS/)
  assert.throws(() => validateBrowserAction({ action: 'click' }), /selector/)
  assert.throws(() => validateBrowserAction({ action: 'fill', selector: 'input' }), /text/)
  assert.throws(() => validateBrowserAction({ action: 'press' }), /key/)
  assert.doesNotThrow(() => validateBrowserAction({ action: 'right_click', selector: 'button' }))
})

test('only routine same-site navigation and presentational buttons bypass click review', () => {
  const link = { tag: 'A', href: '/about', label: 'About', inForm: false, form: null, type: null }
  assert.equal(routineBrowserClick(link, 'https://example.com'), true)
  assert.equal(routineBrowserClick({ ...link, href: 'https://elsewhere.example/' }, 'https://example.com'), false)
  assert.equal(routineBrowserClick({ ...link, label: 'Delete account' }, 'https://example.com'), false)
  assert.equal(routineBrowserClick({ ...link, inForm: true }, 'https://example.com'), false)
  assert.equal(routineBrowserClick({ ...link, form: 'checkout' }, 'https://example.com'), false)
  assert.equal(routineBrowserClick({ ...link, href: 'javascript:alert(1)' }, 'https://example.com'), false)
  const button = { ...link, tag: 'BUTTON', href: null, type: 'button', label: 'Show more' }
  assert.equal(routineBrowserClick(button, 'https://example.com'), true)
  assert.equal(routineBrowserClick({ ...button, label: 'Continue' }, 'https://example.com'), false)
  assert.equal(routineBrowserClick({ ...button, type: 'submit' }, 'https://example.com'), false)
})

test('IRCTC station and class choices avoid review but search and sensitive fills do not', () => {
  const station = { tag: 'LI', href: null, label: 'NEW DELHI - NDLS', inForm: true, form: null, type: null,
    role: 'option', widget: 'origin', option: 'NEW DELHI - NDLS (NEW DELHI)' }
  assert.equal(routineBrowserClick(station, 'https://www.irctc.co.in'), true)
  assert.equal(routineBrowserClick({ ...station, widget: 'address' }, 'https://www.irctc.co.in'), false)
  assert.equal(routineBrowserClick({ ...station, option: '----- Stations -----' }, 'https://www.irctc.co.in'), false)
  assert.equal(routineBrowserClick(station, 'https://example.com'), false)
  const dropdown = { ...station, tag: 'DIV', role: 'button', widget: 'journeyClass', option: null, label: 'All Classes' }
  assert.equal(routineBrowserClick(dropdown, 'https://www.irctc.co.in'), true)
  assert.equal(routineBrowserClick({ ...dropdown, role: 'option', widget: 'journeyQuota' }, 'https://www.irctc.co.in'), true)
  assert.equal(routineBrowserClick({ ...dropdown, form: 'checkout' }, 'https://www.irctc.co.in'), false)
  assert.equal(routineBrowserClick({ ...dropdown, tag: 'BUTTON', type: 'submit' }, 'https://www.irctc.co.in'), false)
  assert.equal(routineBrowserClick({ ...dropdown, label: 'Pay now' }, 'https://www.irctc.co.in'), false)
  assert.equal(routineBrowserClick({ ...dropdown, tag: 'BUTTON', type: 'submit', role: null, widget: null, label: 'Search Trains' }, 'https://www.irctc.co.in'), false)
  const input = { ...station, tag: 'INPUT', role: 'searchbox', type: 'text', label: 'Enter From station. Input is Mandatory.' }
  assert.equal(routineBrowserFill(input, 'https://www.irctc.co.in', 'NEW DELHI'), true)
  assert.equal(routineBrowserFill(input, 'https://www.irctc.co.in', 'name@example.com'), false)
  assert.equal(routineBrowserFill({ ...input, widget: 'address' }, 'https://www.irctc.co.in', 'NEW DELHI'), false)
})

test('IRCTC station and dropdown choices remain observable after a long navigation menu', {
  skip: process.platform !== 'darwin' || !existsSync(chromeExecutable),
}, async () => {
  const browser = await chromium.launch({ executablePath: chromeExecutable, headless: true })
  try {
    const page = await browser.newPage()
    await page.route('https://www.irctc.co.in/nget/train-search', (route) => route.fulfill({
      contentType: 'text/html', body: `${'<a href="/menu">Menu</a>'.repeat(80)}<p-autocomplete id="origin"><input type="text" role="searchbox" aria-label="Enter From station. Input is Mandatory."><li role="option">NEW DELHI - NDLS</li></p-autocomplete><p-dropdown id="journeyClass"><div role="button">All Classes</div><li role="option">Sleeper (SL)</li></p-dropdown>`,
    }))
    await page.goto('https://www.irctc.co.in/nget/train-search')
    const result = JSON.parse(await observe(page)) as { controls: { selector: string; label: string }[] }
    const station = result.controls.find((item) => item.label === 'NEW DELHI - NDLS')
    const classOption = result.controls.find((item) => item.label === 'Sleeper (SL)')
    assert.equal(await page.locator(station!.selector).textContent(), 'NEW DELHI - NDLS')
    assert.equal(await page.locator(classOption!.selector).textContent(), 'Sleeper (SL)')
    assert.ok(result.controls.some((item) => item.label.startsWith('Enter From station')))
  } finally { await browser.close() }
})