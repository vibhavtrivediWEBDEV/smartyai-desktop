import { randomUUID } from 'node:crypto'
import type { Task } from '../src/bridge.js'
import { parseAppLaunch, parseBrowserResearch, parseFolderOpen, parseLiveResearch, parseVSCodeProjectOpen, parseWebSearch, parseWebsiteOpen } from '../src/app-command.js'

export class TaskRunner {
  private tasks = new Map<string, Task>()
  private controllers = new Map<string, AbortController>()
  private pending: string[] = []
  private active = false

  constructor(
    private readonly notify: (task: Task) => void = () => {},
    private readonly openVSCode: () => Promise<string> = async () => { throw new Error('VS Code access is not configured.') },
    private readonly askGLM: (request: string, signal: AbortSignal) => Promise<string> = async () => { throw new Error('GLM-5 is not configured. Set BEDROCK_MANTLE_API_KEY in .env and restart Jarvis.') },
    private readonly glmConfigured = false,
    private readonly openTerminal: () => Promise<string> = async () => { throw new Error('Terminal access is not configured.') },
    private readonly openApp: (name: string) => Promise<string> = async () => { throw new Error('App access is not configured.') },
    private readonly openFolder: (folder: 'downloads') => Promise<string> = async () => { throw new Error('Folder access is not configured.') },
    private readonly openWebsite: (url: string, browser?: 'safari') => Promise<string> = async () => { throw new Error('Website access is not configured.') },
    private readonly openVSCodeProject: (name: string) => Promise<string> = async () => { throw new Error('VS Code project access is not configured.') },
    private readonly research: (topic: string, signal: AbortSignal, progress: (detail: string) => void) => Promise<string> = async () => { throw new Error('Chrome research is not configured.') },
  ) {}

  list(): Task[] {
    return [...this.tasks.values()].reverse().map((task) => ({ ...task }))
  }

  submit(value: unknown): Task {
    if (typeof value !== 'string' || !value.trim() || value.length > 4000) {
      throw new Error('Enter a command of at most 4,000 characters.')
    }
    if (this.pending.length >= 20) throw new Error('Too many queued tasks. Try again shortly.')
    const now = new Date().toISOString()
    const task: Task = {
      id: randomUUID(), request: value.trim(), state: 'queued',
      detail: 'Waiting to run', createdAt: now, updatedAt: now,
    }
    this.tasks.set(task.id, task)
    this.pending.push(task.id)
    this.notify({ ...task })
    void this.drain()
    return { ...task }
  }

  cancel(value: unknown): Task | null {
    if (typeof value !== 'string' || !/^[0-9a-f-]{36}$/i.test(value)) {
      throw new Error('Invalid task identifier.')
    }
    const task = this.tasks.get(value)
    if (!task) return null
    if (task.state === 'queued') {
      this.pending = this.pending.filter((id) => id !== value)
      return this.update(task, 'cancelled', 'Cancelled before execution')
    }
    if (task.state === 'running') this.controllers.get(value)?.abort()
    return { ...task }
  }

  shutdown(): void {
    for (const task of this.list()) this.cancel(task.id)
  }

  private update(task: Task, state: Task['state'], detail: string): Task {
    const next = { ...task, state, detail, updatedAt: new Date().toISOString() }
    this.tasks.set(task.id, next)
    this.notify({ ...next })
    return { ...next }
  }

  private async drain(): Promise<void> {
    if (this.active) return
    this.active = true
    try {
      while (this.pending.length) {
        const id = this.pending.shift()!
        const task = this.tasks.get(id)
        if (!task || task.state !== 'queued') continue
        const controller = new AbortController()
        this.controllers.set(id, controller)
        this.update(task, 'running', 'Working locally')
        try {
          const detail = await this.execute(task.request, controller.signal, (progress) => {
            if (!controller.signal.aborted) this.update(task, 'running', progress)
          })
          this.update(task, 'completed', detail)
        } catch (error) {
          const cancelled = controller.signal.aborted
          this.update(task, cancelled ? 'cancelled' : 'failed',
            cancelled ? 'Cancelled' : error instanceof Error ? error.message : 'Task failed')
        } finally {
          this.controllers.delete(id)
        }
      }
    } finally {
      this.active = false
    }
  }

  private async execute(request: string, signal: AbortSignal, progress: (detail: string) => void): Promise<string> {
    const normalized = request.toLowerCase().replace(/[?.!]$/, '').trim()
    const topic = parseBrowserResearch(request)
    if (topic) return this.research(topic, signal, progress)
    if (/^(?:delhi\s+(?:(?:todays?|today's|current)\s+)?time|(?:current\s+)?time\s+in\s+delhi)$/i.test(normalized)) {
      return `Delhi time: ${new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'full', timeStyle: 'long' }).format(new Date())}`
    }
    const liveTopic = parseLiveResearch(request)
    if (liveTopic) return this.research(liveTopic, signal, progress)
    const project = parseVSCodeProjectOpen(request)
    if (project) {
      if (signal.aborted) throw new Error('Cancelled')
      return this.openVSCodeProject(project)
    }
    const folder = parseFolderOpen(request)
    if (folder) {
      if (signal.aborted) throw new Error('Cancelled')
      return this.openFolder(folder)
    }
    const website = parseWebsiteOpen(request)
    if (website) {
      if (signal.aborted) throw new Error('Cancelled')
      return this.openWebsite(website)
    }
    const search = parseWebSearch(request)
    if (search) {
      if (signal.aborted) throw new Error('Cancelled')
      const result = await this.openWebsite(search.url, search.browser ?? undefined)
      return `Search results requested in ${search.browser === 'safari' ? 'Safari' : 'your default browser'}. ${result} Jarvis has not read the results.`
    }
    if (/\b(?:vs\s*code|visual studio code)\s+(?:(?:and|then)\s+)?(?:type|send)\b.*\b(?:in|to)\s+(?:the\s+)?chat\b/i.test(request)) {
      throw new Error('Chat prompt was not sent. Open VS Code, choose a project in Jarvis, then use Send to VS Code chat and confirm the prompt.')
    }
    const appName = parseAppLaunch(request)
    if (appName && /^(vs ?code|visual studio code|vscode)$/.test(appName)) {
      if (signal.aborted) throw new Error('Cancelled')
      return this.openVSCode()
    }
    if (appName === 'terminal') {
      if (signal.aborted) throw new Error('Cancelled')
      return this.openTerminal()
    }
    if (appName) {
      if (signal.aborted) throw new Error('Cancelled')
      return this.openApp(appName)
    }
    if (/^(help|what can you do|show commands)$/.test(normalized)) {
      return 'Available: help, show status, show time, wait N seconds (up to 30), open <app name>, open my Downloads folder, open https://<website>, search for <query> on Google, open Safari search <query>, research: <topic> (Chrome, site approvals, GLM-5), phone-number lookup, filename search, and GLM-5 text chat. Ordinary search only opens results; number lookups read approved sources. Google AI Mode is not connected. Voice is not connected.'
    }
    if (/^(show status|status)$/.test(normalized)) {
      return `Jarvis is running locally. GLM-5: ${this.glmConfigured ? 'key configured (validity not checked until a request succeeds)' : 'no key configured'}. File tools, voice, and persistent history are not connected.`
    }
    if (/^(show time|what time is it|time)$/.test(normalized)) {
      return `Local time: ${new Date().toLocaleString()}`
    }
    const wait = /^wait (\d{1,2}) seconds?$/.exec(normalized)
    if (wait && Number(wait[1]) <= 30) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, Number(wait[1]) * 1000)
        signal.addEventListener('abort', () => {
          clearTimeout(timer)
          reject(new Error('Cancelled'))
        }, { once: true })
      })
      return `Waited ${wait[1]} seconds.`
    }
    if (/^(please )?(delete|remove|move|rename|write|edit|create|install|run|execute|open|launch|start)\b/i.test(normalized)) {
      throw new Error('This action is not available yet. Try "help" for available commands.')
    }
    return this.askGLM(request, signal)
  }
}