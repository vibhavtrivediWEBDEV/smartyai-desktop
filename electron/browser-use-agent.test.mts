import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { approvedBrowserUseOrigin, browserUseActionAccess, browserUseCaptchaHandoff, browserUseOrigin, browserUseQuestionHandoff, browserUseTarget, closeBrowserUseSession, resolveBrowserUseTarget, runBrowserUseTask } from './browser-use-agent.mjs'
import { PermissionManager } from './permissions.mjs'

const browserAvailable = process.platform === 'darwin' && existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
const fakeWorker = `
const lines = require('node:readline').createInterface({ input: process.stdin });
let pending = false;
lines.on('line', line => {
  const message = JSON.parse(line);
  if (pending) {
    pending = false;
    if (!message.allow) process.exit(1);
    process.stdout.write(JSON.stringify({ type: 'result', text: 'verified result' }) + '\\n');
    process.stdout.write(JSON.stringify({ type: 'ready' }) + '\\n');
  } else if (message.task.includes('fail worker')) {
    process.stdout.write(JSON.stringify({ type: 'error', message: 'fake worker failed' }) + '\\n', () => process.exit(1));
  } else if (message.task.includes('exhaust steps')) {
    process.stdout.write(JSON.stringify({ type: 'task_failed', message: 'Browser-use did not complete after 40 steps' }) + '\\n');
    process.stdout.write(JSON.stringify({ type: 'ready' }) + '\\n');
  } else {
    pending = true;
    process.stdout.write(JSON.stringify({ type: 'approval', origin: message.origin, action: 'click', detail: '{"click":{"index":1}}', routine_click: false, routine_input: false }) + '\\n');
  }
});
`
const launchFake = () => spawn(process.execPath, ['-e', fakeWorker], { stdio: ['pipe', 'pipe', 'ignore'], detached: true })

test('browser-use keeps one worker for the same origin and closes it on origin change', { skip: !browserAvailable }, async () => {
  const children: ReturnType<typeof launchFake>[] = []
  const launch = () => { const child = launchFake(); children.push(child); return child }
  const run = (task: string) => runBrowserUseTask(task, 'zai', 'test-key', async () => true, new AbortController().signal, () => {}, undefined, launch)
  try {
    assert.equal(await run('inspect https://example.com/first'), 'verified result')
    assert.equal(await run('inspect https://example.com/second'), 'verified result')
    assert.equal(children.length, 1)
    assert.equal(children[0].exitCode, null)
    assert.equal(await run('inspect https://example.org/third'), 'verified result')
    assert.equal(children.length, 2)
    if (children[0].exitCode === null && children[0].signalCode === null) await once(children[0], 'close')
    assert.ok(children[0].exitCode !== null || children[0].signalCode !== null)
  } finally {
    closeBrowserUseSession()
    if (children[1]?.exitCode === null && children[1].signalCode === null) await once(children[1], 'close')
  }
})

test('browser-use sends the selected target to its worker without resolving the request again', { skip: !browserAvailable }, async () => {
  const scopes: string[] = []
  try {
    assert.equal(await runBrowserUseTask('inspect croma and irctc', 'zai', 'test-key', async (origin) => {
      scopes.push(origin)
      return true
    }, new AbortController().signal, () => {}, undefined, launchFake,
    { origin: 'https://www.croma.com', task: 'inspect croma and irctc\nStart at https://www.croma.com.' }), 'verified result')
    assert.deepEqual(scopes, ['https://www.croma.com'])
    await assert.rejects(runBrowserUseTask('inspect croma', 'zai', 'test-key', async () => true,
      new AbortController().signal, () => {}, undefined, launchFake,
      { origin: 'http://www.croma.com', task: 'inspect croma' }), /public HTTPS|Invalid browser-use target/)
  } finally { await closeBrowserUseSession() }
})

test('location lookup selects one site instead of researching approximate IP locations', async () => {
  const permissions = new PermissionManager(join(tmpdir(), `jarvis-location-${process.pid}.json`))
  const target = await resolveBrowserUseTarget('get my exact location please', permissions)
  assert.equal(target.origin, 'https://mylocationapp.com')
  assert.match(target.task, /Start at https:\/\/mylocationapp\.com\/my-location\//)
  assert.match(target.task, /Never present an IP-based estimate/)
})

test('browser-use evicts cancelled and failed workers', { skip: !browserAvailable }, async () => {
  const children: ReturnType<typeof launchFake>[] = []
  const launch = () => { const child = launchFake(); children.push(child); return child }
  const controller = new AbortController()
  try {
    await assert.rejects(runBrowserUseTask('inspect https://example.com/first', 'zai', 'test-key', async () => {
      controller.abort()
      return false
    }, controller.signal, () => {}, undefined, launch), /denied or cancelled/)
    assert.equal(await runBrowserUseTask('inspect https://example.com/second', 'zai', 'test-key', async () => true,
      new AbortController().signal, () => {}, undefined, launch), 'verified result')
    await assert.rejects(runBrowserUseTask('fail worker https://example.com', 'zai', 'test-key', async () => true,
      new AbortController().signal, () => {}, undefined, launch), /fake worker failed/)
    assert.equal(await runBrowserUseTask('inspect https://example.com/third', 'zai', 'test-key', async () => true,
      new AbortController().signal, () => {}, undefined, launch), 'verified result')
    assert.equal(children.length, 3)
  } finally {
    closeBrowserUseSession()
    if (children.at(-1)?.exitCode === null && children.at(-1)?.signalCode === null) await once(children.at(-1)!, 'close')
  }
})

test('browser-use retains Chrome after step exhaustion but evicts a failed worker', { skip: !browserAvailable }, async () => {
  const children: ReturnType<typeof launchFake>[] = []
  const launch = () => { const child = launchFake(); children.push(child); return child }
  const run = (task: string) => runBrowserUseTask(task, 'zai', 'test-key', async () => true,
    new AbortController().signal, () => {}, undefined, launch)
  try {
    await assert.rejects(run('exhaust steps https://example.com'), /did not complete after 40 steps/)
    assert.equal(children.length, 1)
    assert.equal(children[0].exitCode, null)
    assert.equal(await run('inspect https://example.com/again'), 'verified result')
    assert.equal(children.length, 1)
    await assert.rejects(run('fail worker https://example.com'), /fake worker failed/)
    assert.equal(await run('inspect https://example.com/new'), 'verified result')
    assert.equal(children.length, 2)
  } finally {
    await closeBrowserUseSession()
  }
})

test('CAPTCHA handoff accepts only a page from the task origin', () => {
  const origin = 'https://example.com'
  assert.equal(browserUseCaptchaHandoff('{"captcha_handoff":{"url":"https://example.com/challenge"}}', origin), true)
  assert.equal(browserUseCaptchaHandoff('{"captcha_handoff":{"url":"https://evil.example/challenge"}}', origin), false)
  assert.equal(browserUseCaptchaHandoff('{"captcha_handoff":{"url":"https://example.com.evil.example"}}', origin), false)
  assert.equal(browserUseCaptchaHandoff('{"captcha_handoff":{"url":"http://example.com/challenge"}}', origin), false)
  assert.equal(browserUseCaptchaHandoff('{"captcha_handoff":{"url":"invalid"}}', origin), false)
})

test('question handoff requires a bounded question on the task origin', () => {
  const origin = 'https://example.com'
  assert.equal(browserUseQuestionHandoff('{"question_handoff":{"question":"Which showtime?","url":"https://example.com/shows"}}', origin), 'Which showtime?')
  assert.equal(browserUseQuestionHandoff('{"question_handoff":{"question":"Which showtime?","url":"https://evil.example/shows"}}', origin), null)
  assert.equal(browserUseQuestionHandoff('{"question_handoff":{"question":" ","url":"https://example.com"}}', origin), null)
  assert.equal(browserUseQuestionHandoff('{"question_handoff":{"question":"Which showtime?","url":"http://example.com"}}', origin), null)
})

test('browser-use reuses scoped grants only for recognized, well-formed actions', () => {
  const origin = 'https://example.com'
  assert.equal(browserUseActionAccess('navigate', JSON.stringify({ navigate: { url: 'https://example.com/contact' } }), origin), 'read')
  assert.equal(browserUseActionAccess('navigate', JSON.stringify({ navigate: { url: 'https://other.example.com' } }), origin), 'review')
  assert.equal(browserUseActionAccess('navigate', JSON.stringify({ navigate: { url: 'http://example.com' } }), origin), 'review')
  assert.equal(browserUseActionAccess('extract', '{"extract":{"query":"email"}}', origin), 'read')
  assert.equal(browserUseActionAccess('find_elements', '{"find_elements":{"selector":"a","attributes":["href"]}}', origin), 'read')
  assert.equal(browserUseActionAccess('scroll', '{"scroll":{"down":1}}', origin), 'scroll')
  assert.equal(browserUseActionAccess('click', '{"click":{"index":1}}', origin), 'review')
  assert.equal(browserUseActionAccess('click', '{"click":{"index":1}}', origin, true), 'click')
  assert.equal(browserUseActionAccess('click', '{"click":{}}', origin, true), 'review')
  assert.equal(browserUseActionAccess('send_keys', '{"send_keys":{"keys":"Escape"}}', origin, true), 'click')
  assert.equal(browserUseActionAccess('send_keys', '{"send_keys":{"keys":"Enter"}}', origin, true), 'review')
  assert.equal(browserUseActionAccess('select_dropdown_option', '{"select_dropdown_option":{"index":1,"text":"Hindi"}}', origin, true), 'click')
  assert.equal(browserUseActionAccess('select_dropdown_option', '{"select_dropdown_option":{"text":"Hindi"}}', origin, true), 'review')
  assert.equal(browserUseActionAccess('input', '{"input":{"index":1,"text":"pricing"}}', origin), 'review')
  assert.equal(browserUseActionAccess('input', '{"input":{"index":1,"text":"pricing"}}', origin, false, true), 'input')
  assert.equal(browserUseActionAccess('input', '{"input":{"text":"pricing"}}', origin, false, true), 'review')
  for (const action of ['input', 'send_keys', 'go_back', 'select_dropdown_option', 'unknown']) {
    assert.equal(browserUseActionAccess(action, JSON.stringify({ [action]: {} }), origin), 'review')
  }
  assert.equal(browserUseActionAccess('scroll', '{"scroll":', origin), 'review')
  assert.equal(browserUseActionAccess('click', '{"click":{},"input":{}}', origin), 'review')
  assert.equal(browserUseActionAccess('click', '{"scroll":{}}', origin), 'review')
})

test('browser-use requires one public HTTPS origin with no credentials', async () => {
  assert.equal(await browserUseOrigin('find two tickets near me'), 'https://in.bookmyshow.com')
  await assert.rejects(browserUseOrigin('https://example.com and https://example.org'), /exactly one/)
  await assert.rejects(browserUseOrigin('https://127.0.0.1/'), /private/)
  await assert.rejects(browserUseOrigin('https://user:pass@example.com/'), /public HTTPS/)
  assert.equal(await browserUseOrigin('Inspect https://example.com/path'), 'https://example.com')
})

test('browser-use starts a real browser for URL-free product and store searches', async () => {
  const general = await browserUseTarget('search the latest price of iphone')
  assert.equal(general.origin, 'https://www.google.com')
  assert.match(general.task, /google\.com\/search\?q=search%20the%20latest%20price%20of%20iphone/)
  const store = await browserUseTarget('search the latest price of iphone croma store')
  assert.equal(store.origin, 'https://www.croma.com')
  assert.match(store.task, /Search this store/)
  const pizza = await browserUseTarget('find the nearest dominos and order 2 large pizza in my location')
  assert.equal(pizza.origin, 'https://pizzaonline.dominos.co.in')
  assert.match(pizza.task, /confirmed area or address/)
  assert.match(pizza.task, /total including fees/)
  assert.match(pizza.task, /never claim an order succeeded without a site confirmation/)
})

test('browser-use prefers only a uniquely matching active read grant and passes its URL to the worker', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-browser-sites-'))
  try {
    const file = join(root, 'permissions.json')
    const permissions = new PermissionManager(file)
    await permissions.grantWebsite('https://www.croma.com')
    await permissions.grantWebsiteSignedInRead('https://www.croma.com')
    assert.equal(approvedBrowserUseOrigin('inspect croma prices', permissions), null)
    assert.equal(await permissions.allowPublicRead('https://www.croma.com'), true)
    assert.equal(await permissions.allowPublicRead('https://www.croma.com/another'), true)
    assert.equal(permissions.list().filter((item) => item.capability === 'browser.read').length, 1)
    await permissions.grantWebsiteRead('https://www.irctc.co.in')
    assert.equal(approvedBrowserUseOrigin('inspect croma prices', permissions), 'https://www.croma.com')
    assert.equal(approvedBrowserUseOrigin('inspect ticket prices', permissions), null)
    assert.equal(approvedBrowserUseOrigin('compare croma and irctc', permissions), null)
    const picked = approvedBrowserUseOrigin('inspect irctc train availability', permissions)
    assert.equal(picked, 'https://www.irctc.co.in')
    assert.equal(await browserUseOrigin(`inspect irctc train availability\nStart at ${picked}.`), picked)
    const restarted = new PermissionManager(file)
    await restarted.load()
    assert.equal(approvedBrowserUseOrigin('inspect irctc trains', restarted), picked)
    const grant = restarted.list().find((item) => item.capability === 'browser.read' && item.scope === picked)
    assert.ok(grant)
    await restarted.revoke(grant.id)
    assert.equal(approvedBrowserUseOrigin('inspect irctc trains', restarted), null)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('named-site actions require one active matching read grant and retain that target', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-action-target-'))
  try {
    const permissions = new PermissionManager(join(root, 'permissions.json'))
    await assert.rejects(resolveBrowserUseTarget('click next on acme', permissions), /No unique approved website/)
    const grant = await permissions.grantWebsiteRead('https://www.acme.example')
    assert.deepEqual(await resolveBrowserUseTarget('click next on acme', permissions), {
      origin: 'https://www.acme.example', task: 'click next on acme\nStart at https://www.acme.example.',
    })
    await permissions.revoke(grant.id)
    await assert.rejects(resolveBrowserUseTarget('click next on acme', permissions), /No unique approved website/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('browser-use infers HTTPS for one bare website and preserves the request intent', async () => {
  assert.deepEqual(await browserUseTarget('inspect the benosupport.in get the official from here'), {
    origin: 'https://benosupport.in',
    task: 'inspect the benosupport.in get the official from here\nStart at https://benosupport.in.',
  })
  assert.deepEqual(await browserUseTarget('inspect www.example.com/contact.'), {
    origin: 'https://www.example.com',
    task: 'inspect www.example.com/contact.\nStart at https://www.example.com/contact.',
  })
  await assert.rejects(browserUseOrigin('inspect example.com and example.org'), /exactly one/)
  await assert.rejects(browserUseOrigin('inspect https://example.com and example.org'), /exactly one/)
  await assert.rejects(browserUseOrigin('inspect http://example.com'), /public HTTPS/)
  await assert.rejects(browserUseOrigin('inspect https://127.0.0.1'), /private/)
  await assert.rejects(browserUseOrigin('inspect example.com:8080'), /public HTTPS/)
})

test('browser-use opens named BookMyShow directly without inventing a booking', async () => {
  const target = await browserUseTarget('get the ticket from the book my show app 2 seat near new ashok nagar delhi')
  assert.equal(target.origin, 'https://in.bookmyshow.com')
  assert.match(target.task, /Start at https:\/\/in\.bookmyshow\.com\./)
  assert.match(target.task, /near new ashok nagar delhi/)
  assert.match(target.task, /do not claim seats were booked/)
  assert.match(target.task, /Stop at checkout or a QR payment screen/)
  const nearby = await browserUseTarget('mirzapur search cinema near my location 2 seats')
  assert.equal(nearby.origin, 'https://in.bookmyshow.com')
  assert.match(nearby.task, /ask for a city or neighborhood/)
  assert.match(nearby.task, /live seating chart confirms them/)
})