import assert from 'node:assert/strict'
import { test } from 'node:test'
import { TaskRunner } from './tasks.mjs'
import { parseAppLaunch, parseBrowserResearch, parseFileSearch, parseFolderOpen, parseLiveResearch, parseVSCodeProjectOpen, parseWebSearch, parseWebsiteOpen, resolveFileSearch } from '../src/app-command.js'
import type { Task } from '../src/bridge.js'

async function untilFinished(runner: TaskRunner, id: string): Promise<Task> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const task = runner.list().find((item) => item.id === id)!
    if (!['queued', 'running'].includes(task.state)) return task
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('Task did not finish')
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

test('misspelled research comparison never falls through to ordinary chat', async () => {
  let requested = ''
  const runner = new TaskRunner(() => {}, undefined, async () => { throw new Error('Chat must not answer research') }, true,
    undefined, undefined, undefined, undefined, undefined,
    async (topic) => { requested = topic; return 'Research result' })
  const task = await untilFinished(runner, runner.submit('reserch compair iphone 17 vs iphone 18').id)
  assert.equal(task.state, 'completed')
  assert.equal(task.detail, 'Research result')
  assert.equal(requested, 'compare iphone 17 vs iphone 18')
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