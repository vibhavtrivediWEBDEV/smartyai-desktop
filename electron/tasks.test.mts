import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TaskRunner } from './tasks.mjs'
import { busProviders, busTask, busTrip, isBusRequest } from './bus-booking.mjs'
import { browserUseTarget } from './browser-use-agent.mjs'
import { locationSuggestion } from '../src/location-suggestion.js'
import { parseAppLaunch, parseBrowserResearch, parseFileSearch, parseFolderOpen, parseLiveResearch, parseVSCodeProjectOpen, parseWebSearch, parseWebsiteAction, parseWebsiteOpen, resolveFileSearch } from '../src/app-command.js'
import type { Task } from '../src/bridge.js'

async function untilFinished(runner: TaskRunner, id: string): Promise<Task> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const task = runner.list().find((item) => item.id === id)!
    if (!['queued', 'running'].includes(task.state)) return task
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('Task did not finish')
}

async function untilReply(runner: TaskRunner, id: string): Promise<Task> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const task = runner.list().find((item) => item.id === id)!
    if (task.awaitingReply) return task
    if (['failed', 'cancelled', 'completed'].includes(task.state)) throw new Error(`Task ended before asking: ${task.detail}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('Task did not ask for a reply')
}

test('only bounded nonempty strings are accepted', () => {
  const runner = new TaskRunner()
  assert.throws(() => runner.submit('  '), /Enter a command/)
  assert.throws(() => runner.submit({ request: 'show time' }), /Enter a command/)
  assert.throws(() => runner.submit('a'.repeat(4001)), /Enter a command/)
  assert.throws(() => runner.cancel({}), /Invalid task identifier/)
})

test('deterministic local commands complete with actual results', async () => {
  const updates: Task[] = []
  const runner = new TaskRunner((task) => updates.push(task))
  const submitted = runner.submit('show time')
  const task = await untilFinished(runner, submitted.id)
  assert.equal(task.state, 'completed')
  assert.match(task.detail, /Local time:/)
  assert.deepEqual(updates.map((item) => item.state), ['queued', 'running', 'completed'])
  assert.equal(runner.list()[0].state, 'completed')
})

test('bus seats route to bus coordinator, not cinema, and provider follow-ups survive restart', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'jarvis-conversation-'))
  const history = join(folder, 'history.json')
  const seen: string[] = []
  const create = () => {
    let runner: TaskRunner
    runner = new TaskRunner(() => {}, undefined, undefined, false, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    async (request, signal) => { seen.push(request); runner.rememberBusTrip(signal, 'Delhi to Kanpur on 2026-10-12 for 2 seats'); return 'No verified fares yet.' }, history)
    return runner
  }
  try {
    const first = create()
    const trip = 'Find the cheapest bus from Delhi to Kanpur today for two seats'
    assert.equal((await untilFinished(first, first.submit(trip).id)).state, 'completed')
    assert.equal(seen[0], trip)
    const restarted = create()
    assert.equal(restarted.list().length, 1)
    const followup = await untilFinished(restarted, restarted.submit('Try AbhiBus').id)
    assert.equal(followup.state, 'completed')
    assert.match(seen[1], /Delhi to Kanpur on 2026-10-12 for 2 seats\nUser follow-up: Try AbhiBus/)
    assert.equal(isBusRequest('Find cheapest bus seats'), true)
    assert.equal(busTrip(trip), 'Delhi to Kanpur')
    assert.match(busTask(trip, 'https://www.abhibus.com'), /Start at https:\/\/www\.abhibus\.com/)
    restarted.newConversation()
    assert.equal(create().list().length, 0)
  } finally { rmSync(folder, { recursive: true, force: true }) }
})

test('bus comparison selects only active read grants or explicitly named providers', () => {
  const allowed = { isAllowed: (capability: string, origin: string) => capability === 'browser.read' && origin === 'https://www.redbus.in' }
  assert.deepEqual(busProviders('find cheapest bus', allowed).map((site) => site.name), ['redBus'])
  assert.deepEqual(busProviders('try AbhiBus', allowed).map((site) => site.name), ['AbhiBus'])
  assert.equal(isBusRequest('try on abhi bus please'), true)
  assert.deepEqual(busProviders('find cheapest bus', { isAllowed: () => false }), [])
  assert.deepEqual(busProviders('find cheapest bus', { isAllowed: (capability) => capability === 'browser.open' }), [])
})

test('saved-trip AbhiBus task resolves to one browser-use target', async () => {
  const task = busTask('Delhi to Kanpur on 2026-10-15 for 2 seats\nCurrent request: try on abhi bus please', 'https://www.abhibus.com')
  assert.equal((await browserUseTarget(task)).origin, 'https://www.abhibus.com')
})

test('try on abhi bus please reaches bus browsing, not generic GLM tools', async () => {
  let called = 0
  const runner = new TaskRunner(() => {}, undefined, async () => { throw new Error('Generic GLM chat should not run.') }, false,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, async () => { called++; return 'Waiting for trip details.' })
  const result = await untilFinished(runner, runner.submit('try on abhi bus please').id)
  assert.equal(result.detail, 'Waiting for trip details.')
  assert.equal(called, 1)
})

test('chat consent retries only the immediately failed website action after a scoped grant', async () => {
  const origin = 'https://www.abhibus.com'
  const request = 'Can you show the AbhiBus homepage?'
  let granted = false
  let calls = 0
  const runner = new TaskRunner(() => {}, undefined, async (message) => {
    assert.equal(message, request)
    calls++
    if (!granted) throw new Error(`Allow ${origin} in Permissions before GLM-5 can request this action.`)
    return 'Website opened.'
  }, false, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
  undefined, undefined, undefined, undefined, undefined, undefined, undefined, async (scope) => {
    assert.equal(scope, origin)
    granted = true
    return true
  })
  assert.equal((await untilFinished(runner, runner.submit(request).id)).state, 'failed')
  const retried = await untilFinished(runner, runner.submit('i allow').id)
  assert.equal(retried.detail, 'Website opened.')
  assert.equal(calls, 2)
  assert.match((await untilFinished(runner, runner.submit('i allow').id)).detail, /No pending website permission/)
})

test('denied or unrelated chat consent does not retry a failed website action', async () => {
  let calls = 0
  const runner = new TaskRunner(() => {}, undefined, async () => {
    calls++
    throw new Error('Allow https://www.abhibus.com in Permissions before GLM-5 can request this action.')
  }, false, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
  undefined, undefined, undefined, undefined, undefined, undefined, undefined, async () => false)
  assert.match((await untilFinished(runner, runner.submit('i allow').id)).detail, /No pending website permission/)
  assert.equal((await untilFinished(runner, runner.submit('Can you show the AbhiBus homepage?').id)).state, 'failed')
  assert.match((await untilFinished(runner, runner.submit('please add it in permisons now and proceed').id)).detail, /was not granted/)
  assert.equal(calls, 1)
})

test('unsupported requests fail without claiming to run tools or AI', async () => {
  const runner = new TaskRunner()
  const task = await untilFinished(runner, runner.submit('delete all files').id)
  assert.equal(task.state, 'failed')
  assert.match(task.detail, /not available yet/)
})

test('desktop target parsers accept explicit requests only', () => {
  assert.equal(parseFolderOpen('Open my Downloads folder'), 'downloads')
  assert.equal(parseFolderOpen('How do I open my Downloads folder?'), null)
  assert.equal(parseWebsiteOpen('Open this website https://example.com/report'), 'https://example.com/report')
  assert.equal(parseWebsiteOpen('open file:///etc/passwd'), null)
  assert.equal(parseWebsiteOpen('open https://user:pass@example.com'), null)
  assert.equal(parseWebsiteOpen('How do I open https://example.com?'), null)
  assert.deepEqual(parseWebSearch('open safari search VS Code'), { url: 'https://www.google.com/search?q=VS+Code', browser: 'safari' })
  assert.deepEqual(parseWebSearch('search for C++ on google'), { url: 'https://www.google.com/search?q=C%2B%2B', browser: null })
  assert.equal(parseWebSearch('find report.txt'), null)
  assert.equal(parseWebSearch('search for report.txt'), null)
  assert.equal(parseAppLaunch('open safari search VS Code'), null)
  assert.equal(parseBrowserResearch('research: compare OLED and mini LED monitors'), 'compare OLED and mini LED monitors')
  assert.equal(parseBrowserResearch('research climate news'), 'climate news')
  assert.equal(parseBrowserResearch('reserch compair iphone 17 vs iphone 18'), 'compare iphone 17 vs iphone 18')
  assert.equal(parseBrowserResearch('research 6388056383 in google'), '"6388056383" phone number')
  assert.equal(parseBrowserResearch('search for report.txt'), null)
  assert.equal(parseBrowserResearch('research: x\nopen another site'), null)
  assert.equal(parseLiveResearch('delhi weather'), 'delhi weather today')
  assert.equal(parseLiveResearch('What are the latest prices on example.com?'), 'What are the latest prices on example.com')
  assert.equal(parseLiveResearch('find report.txt'), null)
  assert.equal(parseWebsiteAction('click the next button on https://example.com'), 'click the next button on https://example.com')
  assert.equal(parseWebsiteAction('click next on acme'), 'click next on acme')
  assert.equal(parseWebsiteAction('open https://example.com'), null)
  assert.equal(parseLiveResearch('weather in Delhi today'), 'Delhi weather today')
  assert.equal(parseLiveResearch('delhi police phone number'), 'delhi police official contact phone number')
  assert.equal(parseLiveResearch('search for 6388056383 on google'), '"6388056383" phone number')
  assert.equal(parseLiveResearch('whose number is 6388056383'), '"6388056383" phone number')
  assert.equal(parseLiveResearch('phone number 6388056383'), '"6388056383" phone number')
  assert.equal(parseLiveResearch('6388056383'), '"6388056383" phone number')
  assert.equal(parseLiveResearch('search for C++ on google'), null)
  assert.equal(parseLiveResearch('find report.txt'), null)
})

test('folder and website commands require delegated actions and never trigger from questions', async () => {
  const opened: string[] = []
  const runner = new TaskRunner(() => {}, async () => 'VS Code opened', async () => 'GLM response', true,
    async () => 'Terminal opened', async () => 'App opened',
    async (folder) => { opened.push(folder); return 'Downloads opened.' },
    async (url) => { opened.push(url); return 'Website opened.' })
  assert.equal((await untilFinished(runner, runner.submit('open my Downloads folder').id)).detail, 'Downloads opened.')
  assert.equal((await untilFinished(runner, runner.submit('open https://example.com/report').id)).detail, 'Website opened.')
  assert.deepEqual(opened, ['downloads', 'https://example.com/report'])
  assert.equal((await untilFinished(runner, runner.submit('How do I open my Downloads folder?').id)).detail, 'GLM response')
  assert.deepEqual(opened, ['downloads', 'https://example.com/report'])
  const denied = new TaskRunner()
  assert.match((await untilFinished(denied, denied.submit('open my Downloads folder').id)).detail, /not configured/)
  assert.match((await untilFinished(denied, denied.submit('open https://example.com').id)).detail, /not configured/)
})

test('web search opens the intended browser without treating search text as an app', async () => {
  const visited: { url: string, browser?: 'safari' }[] = []
  const runner = new TaskRunner(() => {}, async () => 'VS Code opened', async () => 'GLM reply', true,
    async () => 'Terminal opened', async () => { throw new Error('Search was treated as an app') },
    async () => 'Downloads opened', async (url, browser) => { visited.push({ url, browser }); return 'Browser accepted the URL.' })
  const safari = await untilFinished(runner, runner.submit('open safari search vas').id)
  assert.equal(safari.state, 'completed')
  assert.match(safari.detail, /Safari.*Jarvis has not read the results/)
  const google = await untilFinished(runner, runner.submit('search for C++ on google').id)
  assert.equal(google.state, 'completed')
  assert.deepEqual(visited, [
    { url: 'https://www.google.com/search?q=vas', browser: 'safari' },
    { url: 'https://www.google.com/search?q=C%2B%2B', browser: undefined },
  ])
})

test('opening a persistent Chrome session is a local command, not a GLM website action', async () => {
  let opened = 0
  const runner = new TaskRunner(() => {}, undefined, async () => { throw new Error('Must not request GLM to open Chrome') }, false,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, async () => { opened++; return 'Chrome session is open.' })
  const task = await untilFinished(runner, runner.submit('open chrome session').id)
  assert.equal(task.state, 'completed')
  assert.equal(task.detail, 'Chrome session is open.')
  assert.equal(opened, 1)
})

test('explicit research delegates to the research session and cancellation aborts it', async () => {
  let requested = ''
  const runner = new TaskRunner(() => {}, undefined, undefined, false, undefined, undefined, undefined, undefined, undefined,
    async (topic, signal) => {
      requested = topic
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
      throw new Error('Cancelled')
    })
  const task = runner.submit('research: compare laptops')
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(requested, 'compare laptops')
  runner.cancel(task.id)
  assert.equal((await untilFinished(runner, task.id)).state, 'cancelled')
})

test('explicit browse tasks use the browser runner and reject empty tasks', async () => {
  const requests: string[] = []
  const runner = new TaskRunner(() => {}, undefined, async () => { throw new Error('Do not use regular chat') }, false,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    async (request) => { requests.push(request); return 'Observed the page.' })
  const result = await untilFinished(runner, runner.submit('Browse: inspect https://example.com').id)
  assert.equal(result.state, 'completed')
  assert.equal(result.detail, 'Observed the page.')
  assert.deepEqual(requests, ['inspect https://example.com'])
  assert.match((await untilFinished(runner, runner.submit('browse: ').id)).detail, /after browse:/)
})

test('browser-use tasks use the cloned engine route and retain visible progress', async () => {
  const requests: string[] = []
  const runner = new TaskRunner(() => {}, undefined, async () => { throw new Error('Must not use chat') }, false,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    async () => { throw new Error('Must not use the old browser agent') },
    async (request, _signal, step) => { requests.push(request); step('Step 1: navigate'); return 'Agent reported result' })
  const result = await untilFinished(runner, runner.submit('browse-use: inspect https://example.com').id)
  assert.equal(result.state, 'completed')
  assert.equal(result.detail, 'Agent reported result')
  assert.deepEqual(result.steps, ['Preparing the browser-use task', 'Step 1: navigate'])
  assert.deepEqual(requests, ['inspect https://example.com'])
  assert.match((await untilFinished(runner, runner.submit('browse-use: ').id)).detail, /after browse-use:/)
})

test('location lookup offers only one labeled browser result for confirmed saving', async () => {
  const address = 'Government Boys Senior Secondary School, Block B, New Ashok Nagar, Nala Road, New Ashok Nagar, Shahdara South, Delhi, East Delhi, Delhi, 110096, India'
  let browserTask = ''
  const runner = new TaskRunner(() => {}, undefined, undefined, false, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined,
    async (request) => { browserTask = request; return `Site showed this address.\nSuggested saved area: ${address}` })
  const request = 'browse-use: find my location on https://mylocationapp.com'
  const result = await untilFinished(runner, runner.submit(request).id)
  assert.equal(result.state, 'completed')
  assert.match(browserTask, /Only include text observed on the site/)
  assert.equal(locationSuggestion(request, result.detail), address)
  assert.equal(locationSuggestion(request, `Suggested saved area: ${address}\nSuggested saved area: Other place`), null)
  assert.equal(locationSuggestion('browse-use: find pizza near my location', result.detail), null)
  assert.equal(locationSuggestion(request, 'Site could not determine an address.'), null)
  assert.equal(locationSuggestion('browse-use: inspect https://mylocationapp.com', result.detail), address)
  assert.equal(locationSuggestion(request, `Suggested saved area: ${'a'.repeat(301)}`), null)
})

test('train booking waits for travel details and opens only IRCTC', async () => {
  const requests: string[] = []
  const runner = new TaskRunner(() => {}, undefined, undefined, false, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined,
    async (request) => { requests.push(request); return 'No confirmed ticket yet.' })
  const task = runner.submit('Browse-use:book a train for me 15 oct from delhi to kanput sharmshakti express')
  assert.equal(runner.list()[0].awaitingReply, true)
  assert.match(runner.list()[0].detail, /passenger count, class and quota/)
  assert.deepEqual(requests, [])
  assert.equal(runner.reply(task.id, 'Delhi to Kanpur Central, 15 October 2026, one passenger, sleeper, General'), true)
  const result = await untilFinished(runner, task.id)
  assert.equal(result.state, 'completed')
  assert.match(result.detail, /not independent proof of a booking or payment/)
  assert.match(requests[0], /Start at https:\/\/www\.irctc\.co\.in\/nget\/train-search/)
  assert.match(requests[0], /User-confirmed booking details: Delhi to Kanpur Central/)
  assert.equal((await browserUseTarget(requests[0])).origin, 'https://www.irctc.co.in')
})

test('GLM train clarifications use short replies and corrections before IRCTC handoff', async () => {
  const seen: string[] = []
  const prompts: string[] = []
  const base = { departure: 'Delhi', destination: 'Kanpur', 'date with year': '16 October 2026' }
  const complete = { ...base, 'passenger count': '5', class: '2nd ac', quota: 'General' }
  const responses = [
    { ready: false, question: 'Is Delhi to Kanpur correct?', summary: '', evidence: base },
    { ready: false, question: 'How many passengers?', summary: '', evidence: base },
    { ready: false, question: 'Which class?', summary: '', evidence: { ...base, 'passenger count': '5' } },
    { ready: false, question: 'Which quota?', summary: '', evidence: { ...base, 'passenger count': '5', class: '2nd ac' } },
    { ready: true, question: '', summary: 'Delhi to Kanpur, 16 October 2026, 5 passengers, 2A, General', evidence: complete },
    { ready: true, question: '', summary: 'Delhi to Kanpur, 16 October 2026, 5 passengers, 2A, Tatkal', evidence: { ...complete, quota: 'Tatkal' } },
  ]
  const runner = new TaskRunner(() => {}, undefined, async (prompt) => { prompts.push(prompt); const response = JSON.stringify(responses.shift()); return prompts.length === 1 ? `\`\`\`json\n${response}\n\`\`\`` : response }, true,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, async (request) => { seen.push(request); return 'No booking confirmed.' })
  const task = runner.submit('Book a train from Delhi to Kanpur on 16 October 2026')
  for (const [answer, question] of [['yes', /Delhi to Kanpur correct/], ['5', /How many passengers/], ['2nd ac', /Which class/], ['General', /Which quota/], ['Tatkal', /Confirm these search details.*General/]] as const) {
    assert.match((await untilReply(runner, task.id)).detail, question)
    assert.deepEqual(seen, [])
    assert.equal(runner.reply(task.id, answer), true)
  }
  assert.match((await untilReply(runner, task.id)).detail, /Confirm these search details.*Tatkal/)
  assert.deepEqual(seen, [])
  assert.equal(runner.reply(task.id, 'yes'), true)
  assert.equal((await untilFinished(runner, task.id)).state, 'completed')
  assert.match(seen[0], /User-confirmed booking details: Delhi to Kanpur, 16 October 2026, 5 passengers, 2A, Tatkal/)
  assert.equal((await browserUseTarget(seen[0])).origin, 'https://www.irctc.co.in')
  assert.match(prompts[2], /User: 5/)
  assert.match(prompts[3], /User: 2nd ac/)
})

test('GLM train details fail closed on unsupported readiness, invalid output and cancellation', async () => {
  const seen: string[] = []
  const runner = new TaskRunner(() => {}, undefined, async () => JSON.stringify({ ready: true, question: 'Which quota?', summary: 'Delhi to Kanpur, General', evidence: { departure: 'Delhi', destination: 'Kanpur', quota: 'General' } }), true,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, async (request) => { seen.push(request); return 'Booked.' })
  const task = runner.submit('Book a train from Delhi to Kanpur')
  assert.match((await untilReply(runner, task.id)).detail, /Which quota/)
  runner.reply(task.id, 'stop')
  assert.equal((await untilFinished(runner, task.id)).state, 'cancelled')
  assert.deepEqual(seen, [])
  const invalidSeen: string[] = []
  const invalid = new TaskRunner(() => {}, undefined, async () => 'not JSON', true,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, async (request) => { invalidSeen.push(request); return 'Booked.' })
  const failed = await untilFinished(invalid, invalid.submit('Book a train from Delhi to Kanpur').id)
  assert.equal(failed.state, 'failed')
  assert.match(failed.detail, /valid booking details/)
  assert.deepEqual(invalidSeen, [])
})

test('exact Delhi to Kanpur 2nd tier request clarifies class without inventing a station typo', () => {
  const runner = new TaskRunner()
  const task = runner.submit('Browse-use: book a train ticket from delhi to kanpur irctc 2nd tier 16 oct')
  const prompt = runner.list()[0]
  assert.equal(prompt.awaitingReply, true)
  assert.match(prompt.detail, /2nd tier.*AC 2-tier \/ 2A/)
  assert.match(prompt.detail, /travel date with year, passenger count/)
  assert.doesNotMatch(prompt.detail, /kanput/)
  runner.cancel(task.id)
})

test('misspelled train booking still asks for IRCTC details', async () => {
  const runner = new TaskRunner()
  const task = runner.submit('browse-use: book a trian from Delhi to Kanpur')
  assert.equal(runner.list()[0].awaitingReply, true)
  assert.match(runner.list()[0].detail, /IRCTC/)
  runner.cancel(task.id)
})

test('plain train bookings do not assume a specific train', async () => {
  const requests: string[] = []
  const runner = new TaskRunner(() => {}, undefined, undefined, false,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, async (task) => { requests.push(task); return 'No ticket confirmed.' })
  const task = runner.submit('book a train from Delhi to Kanpur')
  assert.equal(runner.list()[0].awaitingReply, true)
  assert.equal(runner.reply(task.id, 'Delhi to Kanpur Central, 15 October 2026, 1 passenger, sleeper, General'), true)
  assert.equal((await untilFinished(runner, task.id)).state, 'completed')
  assert.equal((await browserUseTarget(requests[0])).origin, 'https://www.irctc.co.in')
  assert.doesNotMatch(requests[0], /Shram Shakti Express/)
})

test('ticket requests stay in browser-use rather than being converted to research', async () => {
  const requests: string[] = []
  const runner = new TaskRunner(() => {}, undefined, async () => { throw new Error('Must not use chat') }, false,
    undefined, undefined, undefined, undefined, undefined,
    async () => { throw new Error('Must not use research') }, undefined, undefined,
    async () => { throw new Error('Must not browse without a site') },
    async (task) => { requests.push(task); return 'Browser observed the site.' })
  const exactRequest = 'Browse-use : get the ticket from the book my show app 2 seat near new ashok nagar delhi'
  const localListing = await untilFinished(runner, runner.submit(exactRequest).id)
  assert.equal(localListing.state, 'completed', localListing.detail)
  assert.equal(localListing.detail, 'Browser observed the site.')
  assert.deepEqual(requests, ['get the ticket from the book my show app 2 seat near new ashok nagar delhi'])
})

test('plain nearby ticket request pauses in Assistant chat before browser-use', async () => {
  const requests: string[] = []
  const runner = new TaskRunner(() => {}, undefined, async () => { throw new Error('Must not use chat GLM') }, false,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    async () => { throw new Error('Must not use the old browser agent') },
    async (task) => { requests.push(task); return 'Observed live ticket options.' })
  const task = runner.submit('book cheapest ticket of mirzapur near my location')
  assert.equal(runner.list()[0].awaitingReply, true)
  assert.match(runner.list()[0].detail, /city and area or PIN code/)
  assert.deepEqual(requests, [])
  assert.equal(runner.reply(task.id, 'New Ashok Nagar, Delhi 110096; Mirzapur show; today; 1 seat'), true)
  const result = await untilFinished(runner, task.id)
  assert.equal(result.state, 'completed', result.detail)
  assert.match(requests[0], /User-provided booking details: New Ashok Nagar, Delhi 110096; Mirzapur show; today; 1 seat/)
})

test('brows bookmyshow search ticket asks for location instead of opening a GLM website', async () => {
  const requests: string[] = []
  const runner = new TaskRunner(() => {}, undefined, async () => { throw new Error('Must not call generic GLM tools') }, true,
    undefined, undefined, undefined, async () => { throw new Error('Must not open a website') }, undefined,
    async () => { throw new Error('Must not use research') }, undefined, undefined,
    async () => { throw new Error('Must not use the old browser agent') },
    async (task) => { requests.push(task); return 'Observed BookMyShow options.' })
  const task = runner.submit('brows bookmyshow search ticket for mirzapur near my location for 16oct')
  assert.equal(runner.list()[0].awaitingReply, true)
  assert.match(runner.list()[0].detail, /whether Mirzapur means a show or the city/)
  assert.deepEqual(requests, [])
  assert.equal(runner.reply(task.id, 'New Ashok Nagar, Delhi; Mirzapur show; 16 October; 1 seat'), true)
  const result = await untilFinished(runner, task.id)
  assert.equal(result.state, 'completed', result.detail)
  assert.match(requests[0], /User-provided booking details: New Ashok Nagar, Delhi; Mirzapur show; 16 October; 1 seat/)
})

test('saved area is used only in nearby ticket tasks after asking for missing details', async () => {
  const requests: string[] = []
  const runner = new TaskRunner(() => {}, undefined, undefined, false,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, async (task) => { requests.push(task); return 'Observed options.' },
    undefined, () => 'New Ashok Nagar, Delhi 110096')
  const ticket = runner.submit('book cheapest ticket of mirzapur near my location')
  assert.match(runner.list()[0].detail, /Using saved area New Ashok Nagar/)
  assert.equal(runner.reply(ticket.id, 'Mirzapur show; tomorrow; two seats'), true)
  assert.equal((await untilFinished(runner, ticket.id)).state, 'completed')
  assert.match(requests[0], /Saved area: New Ashok Nagar, Delhi 110096/)
  const unrelated = runner.submit('browse-use: inspect https://example.com')
  assert.equal((await untilFinished(runner, unrelated.id)).state, 'completed')
  assert.doesNotMatch(requests[1], /New Ashok Nagar/)
})

test('PIN-less saved area still prompts for a pizza delivery PIN', async () => {
  const runner = new TaskRunner(() => {}, undefined, undefined, false,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, async () => { throw new Error('Cannot browse without a delivery PIN') },
    undefined, () => 'Delhi')
  const task = runner.submit('compare cheap pizza delivery and order 2 large pizzas near me')
  assert.equal(runner.list()[0].awaitingReply, true)
  assert.match(runner.list()[0].detail, /six-digit PIN/)
  runner.cancel(task.id)
  assert.equal((await untilFinished(runner, task.id)).state, 'cancelled')
})

test('stop reply cancels a waiting task instead of denying it as a failure', async () => {
  const runner = new TaskRunner(() => {}, undefined, undefined, false,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, async () => { throw new Error('Should never browse after stop') })
  const task = runner.submit('book cheapest ticket of mirzapur near my location')
  assert.equal(runner.reply(task.id, 'stop'), true)
  assert.equal((await untilFinished(runner, task.id)).state, 'cancelled')
})

test('plain Domino\'s orders go to browser-use instead of chat', async () => {
  const requests: string[] = []
  const runner = new TaskRunner(() => {}, undefined, async () => { throw new Error('Must not use chat') }, false,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    async () => { throw new Error('Must not use the old browser agent') },
    async (task) => { requests.push(task); return 'Observed Domino\'s ordering page.' })
  const task = 'find the nearest dominos and order 2 large pizza in my location'
  const submitted = runner.submit(task)
  assert.equal(runner.list()[0].awaitingReply, true)
  assert.equal(runner.reply(submitted.id, 'New Ashok Nagar, Delhi 110096'), true)
  const result = await untilFinished(runner, submitted.id)
  assert.equal(result.state, 'completed', result.detail)
  assert.match(requests[0], /Delivery address provided by user: New Ashok Nagar, Delhi 110096/)
})

test('approved saved address with PIN is reused for Domino\'s without another location question', async () => {
  const requests: string[] = []
  const runner = new TaskRunner(() => {}, undefined, undefined, false,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, async (task) => { requests.push(task); return 'No order confirmed.' },
    undefined, () => 'Block B, New Ashok Nagar, Delhi 110096')
  const result = await untilFinished(runner, runner.submit('find the nearest dominos and order 2 large pizza in my location').id)
  assert.equal(result.state, 'completed')
  assert.equal(result.awaitingReply, false)
  assert.match(requests[0], /Previously approved saved area: Block B, New Ashok Nagar, Delhi 110096/)
  assert.match(requests[0], /Verify the complete delivery address before checkout/)
})

test('approved precise address is reused for nearby searches without another location question', async () => {
  const requests: string[] = []
  const runner = new TaskRunner(() => {}, undefined, undefined, false,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, async (task) => { requests.push(task); return 'Distance unverified.' },
    undefined, () => 'Block B, New Ashok Nagar, Delhi 110096')
  const result = await untilFinished(runner, runner.submit('Find restaurants near me within 200 meters').id)
  assert.equal(result.state, 'completed')
  assert.match(requests[0], /Previously approved saved search address: Block B, New Ashok Nagar, Delhi 110096/)
  assert.match(requests[0], /verified distances/)
})

test('lowest pizza price asks for location and compares retailer menus without ordering', async () => {
  const requests: string[] = []
  const runner = new TaskRunner(() => {}, undefined, async () => { throw new Error('Must not guess prices') }, false,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, async (request) => {
      requests.push(request)
      const origin = requests.length === 1 ? 'https://pizzaonline.dominos.co.in' : 'https://www.pizzahut.co.in'
      return JSON.stringify({ currency: 'INR', pizza: 'Margherita small', price: requests.length === 1 ? 179 : 199, source: `${origin}/menu` })
    })
  const submitted = runner.submit('Browse-use: find the pizza in lowest price near my location')
  assert.equal(runner.list()[0].awaitingReply, true)
  assert.equal(runner.reply(submitted.id, 'New Ashok Nagar Delhi 110096'), true)
  const result = await untilFinished(runner, submitted.id)
  assert.equal(result.state, 'completed', result.detail)
  assert.equal(requests.length, 2)
  assert.match(requests[0], /At https:\/\/pizzaonline\.dominos\.co\.in/)
  assert.match(requests[1], /At https:\/\/www\.pizzahut\.co\.in/)
  assert.match(result.detail, /Lowest observed menu price: Domino's, INR 179\.00/)
  assert.match(result.detail, /Delivery fees, taxes and discounts were not verified/)
})

test('near-me pizza price comparison asks for a location before browsing or ordering', async () => {
  const runner = new TaskRunner(() => {}, undefined, async () => { throw new Error('Must not guess a price in chat') }, false,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, async () => { throw new Error('Must not browse without an address') })
  const first = runner.submit('find cheap pizza near me compare prices and order 2 large')
  assert.equal(runner.list()[0].awaitingReply, true)
  assert.equal(runner.reply(first.id, 'Sector 18, Noida'), true)
  await new Promise(setImmediate)
  assert.equal(runner.list()[0].awaitingReply, true)
  assert.equal(runner.reply(first.id, 'Still no PIN'), true)
  await new Promise(setImmediate)
  assert.equal(runner.list()[0].awaitingReply, true)
  runner.cancel(first.id)
  const result = await untilFinished(runner, first.id)
  assert.equal(result.state, 'cancelled')
  const next = runner.submit('test i need to book 2 large pizza near me find where iss cheep pizzza compare pizza price in multiple websites')
  assert.equal(runner.reply(next.id, 'Noida 201301'), true)
  const userWording = await untilFinished(runner, next.id)
  assert.match(userWording.detail, /comparison is incomplete/)
  assert.equal(runner.list().length, 2)
})

test('a location-specific pizza comparison calls both retailers before checkout', async () => {
  const requests: string[] = []
  const runner = new TaskRunner(() => {}, undefined, async () => { throw new Error('Must not guess prices in chat') }, false,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, async (task) => {
      requests.push(task)
      const origin = requests.length === 1 ? 'https://pizzaonline.dominos.co.in' : 'https://www.pizzahut.co.in'
      return requests.length === 3 ? 'QR payment pending.' : JSON.stringify({ currency: 'INR', quantity: 2, size: 'large',
        pizzas: ['Margherita', 'Margherita'], total: requests.length === 1 ? 600 : 500, source: `${origin}/menu`, deliveryAvailable: true })
    })
  const result = await untilFinished(runner, runner.submit('compare cheap pizza delivery and order 2 large pizzas in Sector 18 Noida 201301').id)
  assert.equal(result.state, 'completed', result.detail)
  assert.equal(requests.length, 3)
  assert.match(requests[2], /At https:\/\/www\.pizzahut\.co\.in, start a delivery order/)
  assert.match(result.detail, /Pizza Hut: INR 500\.00/)
})

test('official email requests with a site use browser-use instead of GLM chat website opening', async () => {
  const requests: string[] = []
  const runner = new TaskRunner(() => {}, undefined, async () => { throw new Error('Must not ask chat to open a website') }, false,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    async () => { throw new Error('Must not use the old browser agent') },
    async (request) => { requests.push(request); return 'Email found on the site.' })
  const examples = [
    'get the email from https://benosupport.in official mail',
    'get the email from benosupport.com official mail',
    'Browser-use: get the email from benosupport.com official mail',
  ]
  for (const request of examples) {
    const result = await untilFinished(runner, runner.submit(request).id)
    assert.equal(result.state, 'completed', `${request}: ${result.detail}`)
  }
  assert.deepEqual(requests, [examples[0], examples[1], examples[2].slice('Browser-use: '.length)])
})

test('natural-language site inspection routes to the persistent browser without intercepting opening or files', async () => {
  const requests: string[] = []
  const runner = new TaskRunner(() => {}, undefined, async () => 'Chat reply', false,
    undefined, undefined, undefined, async () => 'Website opened.', undefined, undefined, undefined, undefined,
    async (request) => { requests.push(request); return 'Site inspected.' },
    async () => { throw new Error('Disposable browser-use worker was called') })
  for (const request of ['inspect benosupport.in get the official email from here', 'can you check https://example.com/contact for details?', 'look at my current tab']) {
    assert.equal((await untilFinished(runner, runner.submit(request).id)).detail, 'Site inspected.')
  }
  assert.deepEqual(requests, ['inspect benosupport.in get the official email from here', 'can you check https://example.com/contact for details?', 'look at my current tab'])
  assert.equal((await untilFinished(runner, runner.submit('open https://example.com').id)).detail, 'Website opened.')
  assert.equal((await untilFinished(runner, runner.submit('find report.txt').id)).detail, 'Chat reply')
})

test('site questions research while explicit site actions use browser-use without an open grant', async () => {
  const calls: string[] = []
  const runner = new TaskRunner(() => {}, undefined, async () => { throw new Error('Chat tool was called') }, false,
    undefined, undefined, undefined, undefined, undefined,
    async (topic, _signal, question) => { calls.push(`research: ${topic} | ${question ?? ''}`); return 'Inspected sources.' },
    undefined, undefined, undefined,
    async (task) => { calls.push(`browser-use: ${task}`); return 'Action reviewed.' })
  assert.equal((await untilFinished(runner, runner.submit('What are the latest prices on example.com?').id)).detail, 'Inspected sources.')
  assert.equal((await untilFinished(runner, runner.submit('What are the latest prices on https://example.com/products?').id)).detail, 'Inspected sources.')
  assert.equal((await untilFinished(runner, runner.submit('click the next button on https://example.com').id)).detail, 'Action reviewed.')
  assert.deepEqual(calls, [
    'research: What are the latest prices on example.com | ',
    'research: https://example.com/products | What are the latest prices on https://example.com/products?',
    'browser-use: click the next button on https://example.com',
  ])
})

test('informational follow-ups carry a single prior HTTPS site across restart', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'jarvis-site-followup-'))
  const history = join(folder, 'history.json')
  const calls: { topic: string, question?: string }[] = []
  const create = () => new TaskRunner(() => {}, undefined, async () => { throw new Error('Chat tool was called') }, false,
    undefined, undefined, undefined, undefined, undefined,
    async (topic, _signal, question) => { calls.push({ topic, question }); return 'Inspected sources.' },
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, history)
  try {
    const first = create()
    assert.equal((await untilFinished(first, first.submit('What are the prices on https://example.com/products?').id)).state, 'completed')
    const restarted = create()
    assert.equal((await untilFinished(restarted, restarted.submit('What about availability?').id)).detail, 'Inspected sources.')
    assert.deepEqual(calls, [
      { topic: 'https://example.com/products', question: 'What are the prices on https://example.com/products?' },
      { topic: 'https://example.com/products', question: 'What about availability?' },
    ])
  } finally { rmSync(folder, { recursive: true, force: true }) }
})

test('action follow-ups keep the prior browser-use site without turning action history into research', async () => {
  const calls: string[] = []
  const runner = new TaskRunner(() => {}, undefined, async () => 'Chat reply', false,
    undefined, undefined, undefined, undefined, undefined,
    async (topic) => { calls.push(`research: ${topic}`); return 'Generic research.' },
    undefined, undefined, undefined,
    async (task) => { calls.push(task); return 'Action reviewed.' })
  assert.equal((await untilFinished(runner, runner.submit('click next on https://example.com/products').id)).state, 'completed')
  assert.equal((await untilFinished(runner, runner.submit('click the next button').id)).state, 'completed')
  assert.deepEqual(calls, ['click next on https://example.com/products', 'click the next button on https://example.com'])
  assert.equal((await untilFinished(runner, runner.submit('What about availability?').id)).detail, 'Generic research.')
  assert.equal(calls[2], 'research: What about availability')
})

test('failed ride searches carry pickup and destination to a different provider, including after restart', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'jarvis-ride-followup-'))
  const history = join(folder, 'history.json')
  const calls: string[] = []
  const create = () => new TaskRunner(() => {}, undefined, async () => 'Ordinary chat', false,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    async (request) => {
      calls.push(request)
      if (calls.length === 1) throw new Error('Browser-use could not verify the task')
      return 'No verified fare.'
    }, undefined, undefined, undefined, undefined, history)
  try {
    const runner = create()
    const ride = 'Browse-use: find the ride for me from new ashoknage shiva appartment pillar 153 to noida 62 search cab for me in uber and rapido'
    assert.equal((await untilFinished(runner, runner.submit(ride).id)).state, 'failed')
    const restarted = create()
    const result = await untilFinished(restarted, restarted.submit('Yousearch it in uber also').id)
    assert.equal(result.state, 'completed')
    assert.match(calls[1], /Start at https:\/\/m\.uber\.com/)
    assert.match(calls[1], /from new ashoknage shiva appartment pillar 153 to noida 62/)
    assert.match(calls[1], /do not book or pay without review/i)
    assert.equal((await browserUseTarget(calls[1])).origin, 'https://m.uber.com')
    assert.match(restarted.list()[0].rideContext ?? '', /from new ashoknage shiva appartment pillar 153 to noida 62/)
    assert.equal((await untilFinished(restarted, restarted.submit('Try Rapido again').id)).state, 'completed')
    assert.equal((await browserUseTarget(calls[2])).origin, 'https://www.rapido.bike')
    assert.match(calls[2], /from new ashoknage shiva appartment pillar 153 to noida 62/)
    assert.equal((await untilFinished(restarted, restarted.submit('show time').id)).state, 'completed')
    assert.equal((await untilFinished(restarted, restarted.submit('Search it in Rapido also').id)).detail.startsWith('Ordinary chat'), true)
    assert.equal(calls.length, 3)
    restarted.newConversation()
    assert.equal((await untilFinished(restarted, restarted.submit('Search it in Uber also').id)).detail, 'Ordinary chat')
    assert.equal(calls.length, 3)
  } finally { rmSync(folder, { recursive: true, force: true }) }
})

test('nearby restaurant searches ask for a precise location before browsing, not files', async () => {
  assert.equal(resolveFileSearch('Find restraunt near my location in 200 meters', null), null)
  assert.equal(resolveFileSearch('Find restraunt near my location in 200 meters', '2026-10-12'), null)
  assert.equal(resolveFileSearch('Can you find restaurants near me', null), null)
  const requests: string[] = []
  const runner = new TaskRunner(() => {}, undefined, async () => 'Chat reply', false,
    undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined,
    async (request) => { requests.push(request); return 'Distance not verified.' })
  const task = runner.submit('Find restraunt near my location in 200 meters')
  for (let attempt = 0; attempt < 100 && !runner.list().find((item) => item.id === task.id)?.awaitingReply; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.equal(runner.list().find((item) => item.id === task.id)?.awaitingReply, true)
  assert.equal(requests.length, 0)
  runner.reply(task.id, 'Connaught Place, New Delhi')
  const result = await untilFinished(runner, task.id)
  assert.equal(result.state, 'completed', result.detail)
  assert.match(requests[0], /Connaught Place, New Delhi/)
  assert.match(requests[0], /verified distances/)
  assert.match(requests[0], /within 200 meters/)
  const farther = runner.submit('Find restaurants near me within 500 metres')
  for (let attempt = 0; attempt < 100 && !runner.list().find((item) => item.id === farther.id)?.awaitingReply; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.equal(runner.reply(farther.id, 'Connaught Place, New Delhi'), true)
  await untilFinished(runner, farther.id)
  assert.match(requests[1], /within 500 meters/)
  const explicit = runner.submit('Browse-use: restraunt near my location in 200 meters')
  for (let attempt = 0; attempt < 100 && !runner.list().find((item) => item.id === explicit.id)?.awaitingReply; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.equal(runner.list().find((item) => item.id === explicit.id)?.awaitingReply, true)
  assert.equal(requests.length, 2)
  assert.equal(runner.reply(explicit.id, 'Connaught Place, New Delhi'), true)
  assert.equal((await untilFinished(runner, explicit.id)).state, 'completed')
  assert.match(requests[2], /within 200 meters/)
})

test('Chrome login commands stay local and setup remains running until the window closes', async () => {
  let closeChrome!: () => void
  const closed = new Promise<void>((resolve) => { closeChrome = resolve })
  let setups = 0
  let resets = 0
  const runner = new TaskRunner(() => {}, undefined, async () => { throw new Error('Must not reach GLM-5') }, false,
    undefined, undefined, undefined, undefined, undefined, undefined,
    async () => { setups++; await closed; return 'Sign in in the Chrome window, then close it. Chrome has closed.' },
    async () => { resets++; return 'Chrome login profile deleted.' })
  const first = runner.submit('setup chrome login')
  assert.match(runner.list()[0].detail, /Sign in in the Chrome window, then close it/)
  closeChrome()
  assert.equal((await untilFinished(runner, first.id)).state, 'completed')
  for (const request of ['chrome login setup', 'chrome me sign in karo']) {
    assert.equal((await untilFinished(runner, runner.submit(request).id)).state, 'completed')
  }
  assert.equal(setups, 3)
  assert.equal((await untilFinished(runner, runner.submit('reset chrome login').id)).state, 'completed')
  assert.equal(resets, 1)
})

test('login-oriented research typo gives manual profile steps without requesting website access', async () => {
  let called = false
  const runner = new TaskRunner(() => {}, undefined, async () => { called = true; throw new Error('Chat must not open a website') }, true,
    undefined, undefined, undefined, async () => { called = true; throw new Error('Must not open a website') }, undefined,
    async () => { called = true; throw new Error('Must not research a login page') })
  for (const request of ['reseach naukri so i can login', 'research naukri so i can login']) {
    const task = await untilFinished(runner, runner.submit(request).id)
    assert.equal(task.state, 'completed')
    assert.match(task.detail, /setup chrome login/)
    assert.match(task.detail, /JavaScript/)
  }
  assert.equal(called, false)
})

test('misspelled research comparison never falls through to ordinary chat', async () => {
  const requested: string[] = []
  const runner = new TaskRunner(() => {}, undefined, async () => { throw new Error('Chat must not answer research') }, true,
    undefined, undefined, undefined, undefined, undefined,
    async (topic) => { requested.push(topic); return 'Research result' })
  for (const command of ['reserch compair iphone 17 vs iphone 18', 'reseach compair iphone 17 vs iphone 18']) {
    const task = await untilFinished(runner, runner.submit(command).id)
    assert.equal(task.state, 'completed')
    assert.equal(task.detail, 'Research result')
  }
  assert.deepEqual(requested, ['compare iphone 17 vs iphone 18', 'compare iphone 17 vs iphone 18'])
})

test('Delhi time is local and live weather and contact lookups require research', async () => {
  const topics: string[] = []
  const runner = new TaskRunner(() => {}, undefined, async () => { throw new Error('Chat must not answer live lookups') }, true,
    undefined, undefined, undefined, undefined, undefined,
    async (topic) => { topics.push(topic); return 'Inspected source result' })
  const time = await untilFinished(runner, runner.submit('delhi todays time').id)
  assert.equal(time.state, 'completed')
  assert.match(time.detail, /Delhi time:.*(?:IST|GMT\+5:30)/)
  for (const request of ['delhi weather', 'delhi police phone number']) {
    const task = await untilFinished(runner, runner.submit(request).id)
    assert.equal(task.state, 'completed')
    assert.equal(task.detail, 'Inspected source result')
  }
  assert.deepEqual(topics, ['delhi weather today', 'delhi police official contact phone number'])
})

test('train timing questions and comparisons discover public research sources', async () => {
  const topics: string[] = []
  const runner = new TaskRunner(() => {}, undefined, async () => { throw new Error('Must not ask GLM-5 to open the site') }, true,
    undefined, undefined, undefined, async () => { throw new Error('Must not open the website without reading it') },
    undefined, async (topic) => { topics.push(topic); return 'No timetable was verified in inspected sources.' },
    undefined, undefined, undefined, async () => { throw new Error('Must not start browser-use') })
  for (const request of [
    'kanpur to delhi jane vali train shramshakti train ki timings kya hai kal k liye https://www.irctc.co.in',
    'IRCTC train schedule tomorrow',
    'compare iphone 17 vs iphone 18 prices',
    'compare solar and wind power',
    'what is the price today https://example.com/products',
  ]) {
    const result = await untilFinished(runner, runner.submit(request).id)
    assert.equal(result.state, 'completed')
    assert.equal(result.detail, 'No timetable was verified in inspected sources.')
  }
  assert.deepEqual(topics, [
    'kanpur to delhi jane vali train shramshakti train ki timings kya hai tomorrow k liye www.irctc.co.in',
    'IRCTC train schedule tomorrow',
    'compare iphone 17 vs iphone 18 prices',
    'compare solar and wind power',
    'https://example.com/products',
  ])
})

test('number lookups read sources instead of opening Google or asking chat', async () => {
  const topics: string[] = []
  const runner = new TaskRunner(() => {}, undefined, async () => { throw new Error('Chat must not answer number lookups') }, true,
    undefined, undefined, undefined, async () => { throw new Error('Must not open unread search results') }, undefined,
    async (topic) => { topics.push(topic); return 'No verified public listing' })
  for (const request of ['search for 6388056383 on google', 'whose number is 6388056383', '6388056383']) {
    const task = await untilFinished(runner, runner.submit(request).id)
    assert.equal(task.state, 'completed')
    assert.equal(task.detail, 'No verified public listing')
  }
  assert.deepEqual(topics, Array(3).fill('"6388056383" phone number'))
})

test('VS Code launch requires delegated permission and chat never launches apps', async () => {
  let launches = 0
  const runner = new TaskRunner(() => {}, async () => { launches++; return 'macOS accepted the request to open Visual Studio Code.' }, async () => 'GLM response', true)
  const opened = await untilFinished(runner, runner.submit('open vscode').id)
  assert.equal(opened.state, 'completed')
  assert.equal(launches, 1)
  for (const request of ['kholo vscode', 'vs code open krdo be']) {
    const local = await untilFinished(runner, runner.submit(request).id)
    assert.equal(local.state, 'completed')
    assert.match(local.detail, /macOS accepted/)
  }
  assert.equal(launches, 3)
  const chat = await untilFinished(runner, runner.submit('Explain what VS Code does').id)
  assert.equal(chat.detail, 'GLM response')
  const question = await untilFinished(runner, runner.submit('How do I open VS Code?').id)
  assert.equal(question.detail, 'GLM response')
  assert.equal(launches, 3)
  const denied = new TaskRunner()
  assert.match((await untilFinished(denied, denied.submit('open vscode').id)).detail, /not configured/)
})

test('VS Code project request cannot fall through to named application launch', async () => {
  const projects: string[] = []
  const runner = new TaskRunner(() => {}, async () => 'VS Code opened', async () => 'GLM reply', true,
    async () => 'Terminal opened', async () => { throw new Error('Project was treated as an app') },
    async () => 'Downloads opened', async () => 'Website opened',
    async (name) => { projects.push(name); return `${name} opened in VS Code.` })
  const result = await untilFinished(runner, runner.submit('open vs code smartyai project').id)
  assert.equal(result.state, 'completed')
  assert.deepEqual(projects, ['smartyai'])
  assert.equal(result.detail, 'smartyai opened in VS Code.')
  for (const [name, request] of [['benosupport', 'open benosupport in vscode'], ['beno', 'open beno in the vscode']] as const) {
    const opened = await untilFinished(runner, runner.submit(request).id)
    assert.equal(opened.state, 'completed')
    assert.equal(opened.detail, `${name} opened in VS Code.`)
  }
  assert.deepEqual(projects, ['smartyai', 'benosupport', 'beno'])
})

test('combined VS Code chat request does not launch an app or claim to send a prompt', async () => {
  let launches = 0
  const runner = new TaskRunner(() => {}, async () => { launches++; return 'VS Code opened' }, async () => 'GLM reply', true,
    async () => 'Terminal opened', async () => { launches++; return 'App opened' })
  const result = await untilFinished(runner, runner.submit('open vs code type hi in the chat').id)
  assert.equal(result.state, 'failed')
  assert.match(result.detail, /Chat prompt was not sent.*choose a project.*Send to VS Code chat/)
  assert.equal(launches, 0)
})

test('Terminal launch is explicit and cannot be triggered by chat', async () => {
  let launches = 0
  const runner = new TaskRunner(() => {}, async () => 'VS Code opened', async () => 'GLM response', true, async () => { launches++; return 'macOS accepted the request to open Terminal.' })
  const opened = await untilFinished(runner, runner.submit('open terminal').id)
  assert.equal(opened.state, 'completed')
  assert.equal(launches, 1)
  assert.equal((await untilFinished(runner, runner.submit('How do I open Terminal?').id)).detail, 'GLM response')
  assert.equal(launches, 1)
  const denied = new TaskRunner()
  assert.match((await untilFinished(denied, denied.submit('open terminal').id)).detail, /not configured/)
})

test('a polite, misspelled Terminal request routes to the approved local action', async () => {
  assert.equal(parseAppLaunch('hi cna you open the terminal'), 'terminal')
  assert.equal(parseAppLaunch('Could you please launch Photos for me?'), 'photos')
  assert.equal(parseAppLaunch('kholo vscode'), 'vscode')
  assert.equal(parseAppLaunch('vs code open krdo be'), 'vs code')
  assert.equal(parseAppLaunch('open VS Code and show active projects'), 'vscode')
  assert.equal(parseVSCodeProjectOpen('open vs code smartyai project'), 'smartyai')
  assert.equal(parseVSCodeProjectOpen('open benosupport in vscode'), 'benosupport')
  assert.equal(parseVSCodeProjectOpen('open beno in vs code'), 'beno')
  assert.equal(parseVSCodeProjectOpen('open beno in the vscode'), 'beno')
  assert.equal(parseVSCodeProjectOpen('open beno folder with Visual Studio Code'), 'beno')
  assert.equal(parseAppLaunch('open beno in the vscode now'), null)
  assert.equal(parseVSCodeProjectOpen('open VS Code'), null)
  assert.equal(parseAppLaunch('How do I open Terminal?'), null)
  assert.equal(parseFileSearch('hi cna you find report on my desktop?'), 'report')
  assert.equal(parseFileSearch('search for file report.txt'), 'report.txt')
  assert.equal(resolveFileSearch('Find on abhi bus for same place on wednesday 17 oct', null), null)
  assert.equal(parseFileSearch('find buses from Delhi to Agra tomorrow'), null)
  assert.equal(parseFileSearch('find bus timetable file on my desktop'), 'bus timetable file')
  assert.equal(resolveFileSearch('find the nearest dominos and order 2 large pizza in my location', null), null)
  assert.equal(parseFileSearch('find dominos order file on my desktop'), 'dominos order file')
  assert.equal(parseFileSearch('resume kaha h'), 'resume')
  assert.equal(parseFileSearch('desktop me mera invoice kaha hai?'), 'invoice')
  assert.equal(parseFileSearch('report kidhar h'), 'report')
  assert.equal(parseFileSearch('where is my resume?'), 'resume')
  assert.equal(parseFileSearch('todays screenshot'), 'todays screenshot')
  assert.equal(parseFileSearch('last screenshot'), 'last screenshot')
  assert.equal(parseFileSearch('last screenshots'), 'last screenshots')
  assert.equal(parseFileSearch('show screenshots from 2026-10-12'), 'show screenshots from 2026-10-12')
  assert.equal(parseFileSearch('find screenshots for yesterday'), 'find screenshots for yesterday')
  assert.equal(resolveFileSearch('between 09:00 and 11:00', '2026-10-12'), 'screenshots on 2026-10-12 between 09:00 and 11:00')
  assert.equal(resolveFileSearch('show me from 13:00 to 14:00', '2026-10-12'), 'screenshots on 2026-10-12 show me from 13:00 to 14:00')
  assert.equal(resolveFileSearch('between 09:00 and 11:00', null), null)
  assert.equal(resolveFileSearch('find report', '2026-10-12'), 'report')
  assert.equal(parseFileSearch('How can I search for report?'), null)
  let launches = 0
  let chatCalls = 0
  const runner = new TaskRunner(() => {}, async () => 'VS Code opened', async () => { chatCalls++; return 'GLM reply' }, true,
    async () => { launches++; return 'macOS accepted the request to open Terminal.' })
  const task = await untilFinished(runner, runner.submit('hi cna you open the terminal').id)
  assert.equal(task.state, 'completed')
  assert.match(task.detail, /macOS accepted/)
  assert.equal(launches, 1)
  assert.equal(chatCalls, 0)
  assert.equal((await untilFinished(runner, runner.submit('How do I open Terminal?').id)).detail, 'GLM reply')
  assert.equal(launches, 1)
})

test('Photos and named apps launch only on explicit commands', async () => {
  const launched: string[] = []
  const runner = new TaskRunner(() => {}, async () => 'VS Code opened', async () => 'GLM reply', true,
    async () => 'Terminal opened', async (name) => { launched.push(name); return `macOS accepted the request to open ${name}.` })
  const opened = await untilFinished(runner, runner.submit('Open Photos').id)
  assert.equal(opened.state, 'completed')
  assert.deepEqual(launched, ['photos'])
  assert.equal((await untilFinished(runner, runner.submit('How do I open Photos?').id)).detail, 'GLM reply')
  assert.deepEqual(launched, ['photos'])
  const unconfigured = new TaskRunner()
  assert.match((await untilFinished(unconfigured, unconfigured.submit('open photos').id)).detail, /App access is not configured/)
})

test('running and queued tasks can be cancelled independently', async () => {
  const runner = new TaskRunner()
  const running = runner.submit('wait 20 seconds')
  const queued = runner.submit('show status')
  assert.equal(runner.cancel(queued.id)?.state, 'cancelled')
  runner.cancel(running.id)
  assert.equal((await untilFinished(runner, running.id)).state, 'cancelled')
  assert.equal(runner.list().find((task) => task.id === queued.id)?.state, 'cancelled')
  const next = await untilFinished(runner, runner.submit('help').id)
  assert.equal(next.state, 'completed')
})