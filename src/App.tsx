import { useEffect, useRef, useState } from 'react'
import { Activity, AppWindow, ArrowRight, CircleHelp, Clock3, Command, ExternalLink, FolderOpen, FolderPlus, History, MicOff, PanelLeft, Send, ShieldCheck, Square, Terminal, Trash2, WifiOff } from 'lucide-react'
import type { FileSearchStep, PermissionView, PythonProposal, Task, VSCodeProjects } from './bridge'
import { parseAppLaunch, parseFolderOpen, parseVSCodeProjectOpen, parseWebSearch, parseWebsiteOpen, resolveFileSearch } from './app-command'
import './App.css'

function App() {
  const [view, setView] = useState<'assistant' | 'history' | 'permissions'>('assistant')
  const [request, setRequest] = useState('')
  const [tasks, setTasks] = useState<Task[]>([])
  const [permissions, setPermissions] = useState<PermissionView[]>([])
  const [glmConfigured, setGlmConfigured] = useState(false)
  const [error, setError] = useState('')
  const [folderPath, setFolderPath] = useState('')
  const [proposal, setProposal] = useState<PythonProposal | null>(null)
  const [pythonResult, setPythonResult] = useState('')
  const [pythonBusy, setPythonBusy] = useState(false)
  const [searchStep, setSearchStep] = useState<FileSearchStep | null>(null)
  const [searchBusy, setSearchBusy] = useState(false)
  const [previews, setPreviews] = useState<Record<string, string>>({})
  const [vscodeProjects, setVSCodeProjects] = useState<VSCodeProjects | null>(null)
  const [vscodeProject, setVSCodeProject] = useState<{ name: string, path: string } | null>(null)
  const [vscodePrompt, setVSCodePrompt] = useState('')
  const [vscodeStatus, setVSCodeStatus] = useState('')
  const [vscodeBusy, setVSCodeBusy] = useState(false)
  const input = useRef<HTMLTextAreaElement>(null)
  const permissionDialog = useRef<HTMLDialogElement>(null)
  const available = Boolean(window.jarvis)

  useEffect(() => {
    const dialog = permissionDialog.current
    if (!dialog) return
    if (searchStep?.status === 'permission-required') {
      if (!dialog.open) dialog.showModal()
    } else if (dialog.open) dialog.close()
  }, [searchStep])

  useEffect(() => {
    if (searchStep?.status !== 'done' || !window.jarvis) return
    let cancelled = false
    let next = 0
    const images = searchStep.matches.filter((file) => /\.(?:png|jpe?g|heic|heif|webp|tiff?)$/i.test(file))
    async function load() {
      while (!cancelled && next < images.length) {
        const file = images[next++]
        try {
          const image = await window.jarvis!.previewFileSearchResult(file)
          if (!cancelled) setPreviews((current) => ({ ...current, [file]: image }))
        } catch { continue }
      }
    }
    for (let worker = 0; worker < Math.min(4, images.length); worker++) void load()
    return () => { cancelled = true }
  }, [searchStep])

  useEffect(() => {
    if (!window.jarvis) return
    let mounted = true
    void window.jarvis.listTasks().then((items) => { if (mounted) setTasks(items) })
      .catch(() => { if (mounted) setError('Could not load tasks.') })
    void window.jarvis.listPermissions().then((items) => { if (mounted) setPermissions(items) })
      .catch(() => { if (mounted) setError('Could not load permissions.') })
    void window.jarvis.glmConfigured().then((configured) => { if (mounted) setGlmConfigured(configured) })
      .catch(() => { if (mounted) setError('Could not load GLM-5 status.') })
    const unsubscribeTask = window.jarvis.onTask((task) => {
      setTasks((current) => [task, ...current.filter((item) => item.id !== task.id)].slice(0, 100))
    })
    const unsubscribeFocus = window.jarvis.onFocusCommand(() => {
      setView('assistant')
      input.current?.focus()
    })
    return () => {
      mounted = false
      unsubscribeTask()
      unsubscribeFocus()
    }
  }, [])

  async function submit(value = request) {
    if (!window.jarvis || !value.trim()) return
    setError('')
    if (/\bphotos\b/i.test(value) && /\b(?:images?|screenshots?|pictures?)\b/i.test(value)) {
      setError('Photos library access is not connected. Export the images from Photos to Desktop, Documents, or Downloads, then search by date and time in Jarvis.')
      return
    }
    const webSearch = parseWebSearch(value)
    if (webSearch) {
      try {
        if (!await window.jarvis.allowWebsite(webSearch.url)) return
        if (webSearch.browser === 'safari' && !await window.jarvis.allowApp('Safari')) return
        setPermissions(await window.jarvis.listPermissions())
        setRequest('')
        await window.jarvis.runCommand(value.trim())
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Could not start web search.')
      }
      return
    }
    const find = resolveFileSearch(value, searchStep?.date ?? null)
    if (find) {
      if (searchBusy || searchStep?.status === 'permission-required') { setError('Finish or skip the current folder search first.'); return }
      setSearchBusy(true)
      try {
        setPreviews({})
        setSearchStep(await window.jarvis.startFileSearch(find))
        setRequest('')
      } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not start file search.') }
      finally { setSearchBusy(false) }
      return
    }
    if (/^python:\s*/i.test(value) || /^(please )?(run|execute|create|build|make|write|edit|delete|move|rename|install)\b/i.test(value)) {
      if (proposal || pythonBusy) { setError('Approve or deny the current Python proposal first.'); return }
      setPythonBusy(true)
      setPythonResult('')
      try {
        const next = await window.jarvis.proposePython(value.replace(/^python:\s*/i, '').trim())
        setProposal(next)
        setRequest('')
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Could not request a Python proposal.')
      } finally { setPythonBusy(false) }
      return
    }
    const requestedProject = parseVSCodeProjectOpen(value)
    if (requestedProject) {
      await openVSCodeWorkflow(requestedProject)
      return
    }
    const folder = parseFolderOpen(value)
    const website = parseWebsiteOpen(value)
    const appName = folder || website ? null : parseAppLaunch(value)
    if (appName && /^(vs ?code|visual studio code|vscode)$/.test(appName)) {
      await openVSCodeWorkflow()
      return
    }
    try {
      if (folder) {
        if (!await window.jarvis.allowDownloads()) return
        setPermissions(await window.jarvis.listPermissions())
      } else if (website) {
        if (!await window.jarvis.allowWebsite(website)) return
        setPermissions(await window.jarvis.listPermissions())
      } else if (appName) {
        const allowed = await window.jarvis.allowApp(appName)
        if (!allowed) return
        setPermissions(await window.jarvis.listPermissions())
      }
      setRequest('')
      await window.jarvis.runCommand(value.trim())
      input.current?.focus()
    } catch (cause) {
      setRequest(value)
      setError(cause instanceof Error ? cause.message : 'Could not submit the task.')
    }
  }

  async function openVSCodeWorkflow(requestedProject?: string) {
    if (!window.jarvis || vscodeBusy) return
    setVSCodeBusy(true)
    setError('')
    try {
      const allowed = await window.jarvis.allowApp('Visual Studio Code')
      if (!allowed) return
      setPermissions(await window.jarvis.listPermissions())
      if (!requestedProject) await window.jarvis.openVSCode()
      const projects = await window.jarvis.listVSCodeProjects()
      setVSCodeProjects(projects)
      setVSCodeProject(null)
      const matches = requestedProject ? projects.projects.filter((project) => project.name.toLowerCase() === requestedProject.toLowerCase()) : []
      if (matches.length === 1) {
        const project = await window.jarvis.selectVSCodeProject(matches[0].path)
        setVSCodeProject(project)
        setVSCodeStatus(`${project?.name} opened in VS Code. Keep its window active before sending a chat prompt.`)
      } else if (requestedProject) {
        const project = await window.jarvis.selectVSCodeProject(null, requestedProject)
        if (project) {
          setVSCodeProject(project)
          setVSCodeStatus(`${project.name} opened in VS Code. Keep its window active before sending a chat prompt.`)
        } else {
          setVSCodeStatus(`Project selection cancelled. Choose the ${requestedProject} folder below to continue.`)
        }
      } else {
        setVSCodeStatus('VS Code opened. Choose a project to continue.')
      }
      setRequest('')
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not list VS Code projects.') }
    finally { setVSCodeBusy(false) }
  }

  async function selectVSCodeProject(path: string | null) {
    if (!window.jarvis || vscodeBusy) return
    setVSCodeBusy(true)
    setError('')
    try {
      const project = await window.jarvis.selectVSCodeProject(path)
      if (project) {
        setVSCodeProject(project)
        setVSCodeStatus(`${project.name} opened in VS Code. Keep its window active before sending a chat prompt.`)
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not open project in VS Code.') }
    finally { setVSCodeBusy(false) }
  }

  async function sendVSCodePrompt() {
    if (!window.jarvis || !vscodeProject || !vscodePrompt.trim() || vscodeBusy) return
    setVSCodeBusy(true)
    setError('')
    try {
      if (await window.jarvis.sendVSCodeChat(vscodePrompt)) {
        setVSCodePrompt('')
        setVSCodeStatus('Prompt handed to the last active VS Code window. Check its project, progress, and result in VS Code; Jarvis cannot monitor this chat.')
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not hand off the chat prompt.') }
    finally { setVSCodeBusy(false) }
  }

  async function approvePython() {
    if (!proposal || !window.jarvis) return
    setPythonBusy(true)
    setError('')
    const id = proposal.id
    setProposal(null)
    try {
      setPythonResult(await window.jarvis.executePython(id))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Python did not complete.')
    } finally { setPythonBusy(false) }
  }

  async function denyPython() {
    if (!proposal || !window.jarvis) return
    const id = proposal.id
    setProposal(null)
    try { await window.jarvis.rejectPython(id) } catch { setError('Could not reject the proposal. It will expire without running.') }
  }

  async function decideSearch(allow: boolean) {
    if (!searchStep || !window.jarvis) return
    setSearchBusy(true)
    setError('')
    try {
      const next = await window.jarvis.decideFileSearch(searchStep.id, allow)
      setSearchStep(next)
      if (allow) setPermissions(await window.jarvis.listPermissions())
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not search this folder.') }
    finally { setSearchBusy(false) }
  }

  async function cancel(id: string) {
    try {
      await window.jarvis?.cancelTask(id)
    } catch {
      setError('Could not cancel this task.')
    }
  }

  async function chooseFolder() {
    try {
      setError('')
      const chosen = await window.jarvis?.addReadFolder(folderPath.trim())
      if (chosen) {
        setPermissions(await window.jarvis!.listPermissions())
        setFolderPath('')
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not grant permission.')
    }
  }

  async function allowVSCode() {
    try {
      setError('')
      const allowed = await window.jarvis?.allowVSCode()
      if (allowed) setPermissions(await window.jarvis!.listPermissions())
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not allow VS Code.')
    }
  }

  async function allowTerminal() {
    try {
      setError('')
      const allowed = await window.jarvis?.allowTerminal()
      if (allowed) setPermissions(await window.jarvis!.listPermissions())
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not allow Terminal.')
    }
  }

  async function revoke(id: string) {
    try {
      setError('')
      await window.jarvis?.revokePermission(id)
      setPermissions(await window.jarvis!.listPermissions())
    } catch {
      setError('Could not revoke permission.')
    }
  }

  const active = tasks.filter((task) => task.state === 'queued' || task.state === 'running')
  const recent = view === 'history' ? tasks : tasks.slice(0, 5)

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark">J<span>.</span></span><span>JARVIS<small>DESKTOP ASSISTANT</small></span></div>
        <nav aria-label="Main navigation">
          <button className={view === 'assistant' ? 'nav-item selected' : 'nav-item'} onClick={() => setView('assistant')}><Terminal size={17} /> Assistant</button>
          <button className={view === 'history' ? 'nav-item selected' : 'nav-item'} onClick={() => setView('history')}><History size={17} /> Task history <span className="nav-count">{tasks.length}</span></button>
          <button className={view === 'permissions' ? 'nav-item selected' : 'nav-item'} onClick={() => setView('permissions')}><ShieldCheck size={17} /> Permissions</button>
        </nav>
        <div className="sidebar-bottom">
          <div className="connection"><span className="connection-dot" /> Local commands ready</div>
          <div className="sidebar-note"><WifiOff size={16} /><span>{glmConfigured ? 'GLM-5 key configured; send a question to verify access.' : 'GLM-5 key missing. Set BEDROCK_MANTLE_API_KEY in .env and restart.'}</span></div>
          <span className="shortcut"><Command size={14} /> Shift + J to reopen</span>
        </div>
      </aside>

      <main className="content">
        <header className="topbar"><span><PanelLeft size={16} /> {view === 'assistant' ? 'Assistant' : view === 'history' ? 'Task history' : 'Permissions'}</span><span className="topbar-state"><Activity size={15} /> {active.length ? `${active.length} active` : 'Ready'}</span></header>
        {view === 'assistant' ? (
          <div className="main-body">
            <div className="intro"><div className="eyebrow">YOUR WORKSPACE, ON YOUR TERMS</div><h1>What can I help with?</h1><p>Ask GLM-5, research public websites in Chrome, search a filename, or open a macOS app. Jarvis asks before reading each new site.</p></div>
            <section className="composer" aria-label="Command input">
              <label htmlFor="command-input">Your command</label>
              <textarea ref={input} id="command-input" value={request} onChange={(event) => setRequest(event.target.value)} placeholder="Try ‘show time’ or ‘python: print 2 + 3’" rows={3} maxLength={4000} disabled={!available} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void submit() } }} />
              <div className="composer-footer"><button className="icon-button" type="button" title="Voice is not available yet" aria-label="Voice is not available yet" disabled><MicOff size={19} /></button><span>Voice is not available yet</span><button className="send-button" type="button" onClick={() => void submit()} disabled={!available || !request.trim()}><Send size={16} /> Send</button></div>
            </section>
            {error && <p className="error" role="alert">{error}</p>}
            {vscodeProjects && <section className="python-review" aria-label="VS Code project workflow">
              <h2>VS Code projects</h2>
              {vscodeStatus && <p role="status">{vscodeStatus}</p>}
              {vscodeProjects.names.length ? <p>Open windows: {vscodeProjects.names.join(', ')}</p> : <p>No active VS Code projects detected.</p>}
              <div className="python-actions">
                {vscodeProjects.projects.map((project) => <button type="button" key={project.path} disabled={vscodeBusy} onClick={() => void selectVSCodeProject(project.path)}>{project.name}</button>)}
                <button type="button" className="add-folder" disabled={vscodeBusy} onClick={() => void selectVSCodeProject(null)}><FolderOpen size={17} /> Choose project folder</button>
              </div>
              {vscodeProject && <div className="vscode-chat-form">
                <label htmlFor="vscode-prompt">Chat prompt for {vscodeProject.name}</label>
                <textarea id="vscode-prompt" value={vscodePrompt} onChange={(event) => setVSCodePrompt(event.target.value)} rows={3} maxLength={4000} disabled={vscodeBusy} />
                <button type="button" className="add-folder" disabled={vscodeBusy || !vscodePrompt.trim()} onClick={() => void sendVSCodePrompt()}><Send size={16} /> Send to VS Code chat</button>
              </div>}
            </section>}
            {searchStep?.status === 'done' && <section className="python-review" aria-label="File search progress">
              <h2>Find {searchStep.query}</h2>
              {searchStep.date && <p>Requested date: {searchStep.date}. Searching Desktop, Documents, and Downloads only; Photos library is not connected.</p>}
              {searchStep.checked.map((item) => <p key={item}>{item}</p>)}
              {searchStep.errors.map((item) => <p className="python-warning" key={item}>{item}</p>)}
              {searchStep.matches.length ? <div className="search-results">{searchStep.matches.map((file) => <div className="search-match" key={file}>{previews[file] && <img src={previews[file]} alt={file.split('/').pop()} />}<div><strong>{file.split('/').pop()}</strong><small>{file}</small></div><button type="button" title="Open with default app" aria-label={`Open ${file.split('/').pop()} with default app`} onClick={() => { void window.jarvis?.openFileSearchResult(file).catch((cause) => setError(cause instanceof Error ? cause.message : 'Could not open file.')) }}><ExternalLink size={17} /></button><button type="button" title="Show in Finder" aria-label={`Show ${file.split('/').pop()} in Finder`} onClick={() => { void window.jarvis?.revealFileSearchResult(file).catch((cause) => setError(cause instanceof Error ? cause.message : 'Could not show file in Finder.')) }}><FolderOpen size={17} /></button></div>)}</div> : <p>{searchStep.errors.length ? 'No confirmed matches; some folders could not be fully searched.' : /\bscreenshots?\b/i.test(searchStep.query) ? 'No saved screenshots found for the requested date in the searched folders. Clipboard-only captures and the Photos library were not searched.' : 'No matching files found in searched folders.'}</p>}
            </section>}
            {pythonBusy && <p role="status">{proposal ? 'Running approved Python...' : 'Preparing Python proposal...'}</p>}
            {proposal && <section className="python-review" aria-label="Python action approval">
              <h2>Review Python action</h2>
              <p>{proposal.summary}</p>
              <pre><code>{proposal.code}</code></pre>
              <p className="python-warning">Approval runs this code with your user account. It is not sandboxed and may access files or the network. Only approve code you understand.</p>
              <div className="python-actions"><button type="button" onClick={() => void denyPython()}>Deny</button><button type="button" className="add-folder" onClick={() => void approvePython()}>Approve and run once</button></div>
            </section>}
            {pythonResult && <p className="python-result" role="status">{pythonResult}</p>}
            {!available && <p className="error" role="alert">Open Jarvis in Electron to run commands. Browser preview cannot access desktop tasks.</p>}
            <div className="quick-heading"><span>START HERE</span><CircleHelp size={16} /></div>
            <div className="suggestions">
              {['Research: OLED vs mini LED monitors', 'Open VS Code', "Today's screenshots", 'Show status'].map((prompt) => <button type="button" key={prompt} disabled={!available} onClick={() => void submit(prompt)}>{prompt}<ArrowRight size={15} /></button>)}
            </div>
            <div className="section-heading"><h2>Recent activity</h2><button type="button" onClick={() => setView('history')}>View all <ArrowRight size={15} /></button></div>
            <TaskList tasks={recent} cancel={cancel} />
          </div>
        ) : view === 'history' ? (
          <div className="main-body history-view"><div className="eyebrow">LOCAL SESSION</div><h1>Task history</h1><p className="history-caption">Tasks are kept in memory for this session only. Quitting Jarvis clears this list.</p><TaskList tasks={recent} cancel={cancel} /></div>
        ) : (
          <div className="main-body history-view">
            <div className="eyebrow">YOUR CONTROL</div><h1>Permissions</h1>
            <p className="history-caption">Type “open Photos” or another installed app to request launch access when needed. You can revoke each app below. Folder search also asks as it goes. These grants do not provide macOS Full Disk Access or control other apps; Python runs only after you review its code.</p>
            {error && <p className="error" role="alert">{error}</p>}
            <form onSubmit={(event) => { event.preventDefault(); void chooseFolder() }}>
              <label htmlFor="folder-path">Folder path</label>
              <input id="folder-path" type="text" value={folderPath} onChange={(event) => setFolderPath(event.target.value)} placeholder="/Users/you/Documents" disabled={!available} />
              <button className="add-folder" type="submit" disabled={!available || !folderPath.trim()}><FolderPlus size={17} /> Add readable folder</button>
            </form>
            {!permissions.some((item) => item.capability === 'apps.open' && item.scope === 'vscode' && !item.revokedAt) && <button className="add-folder" type="button" disabled={!available} onClick={() => void allowVSCode()}><AppWindow size={17} /> Allow VS Code launch</button>}
            {!permissions.some((item) => item.capability === 'apps.open' && item.scope === 'terminal' && !item.revokedAt) && <button className="add-folder" type="button" disabled={!available} onClick={() => void allowTerminal()}><Terminal size={17} /> Allow Terminal launch</button>}
            <div className="section-heading"><h2>Saved grants</h2></div>
            {!permissions.length && <div className="empty"><ShieldCheck size={21} /><span>No permissions saved yet.</span></div>}
            <div className="task-list">{permissions.map((permission) => <article className="task" key={permission.id}>
              <div className={`task-indicator ${permission.state === 'granted' && !permission.revokedAt ? 'completed' : 'failed'}`} />
              <div className="task-content"><div className="task-title">{permission.capability}</div><p>{permission.scope}</p><span className="task-meta">{permission.revokedAt ? 'revoked' : permission.state} · {permission.platform}</span></div>
              {!permission.revokedAt && <button className="cancel-button" type="button" onClick={() => void revoke(permission.id)} title="Revoke permission" aria-label={`Revoke access to ${permission.scope}`}><Trash2 size={16} /></button>}
            </article>)}</div>
          </div>
        )}
      </main>
      <dialog ref={permissionDialog} className="permission-dialog" onCancel={(event) => event.preventDefault()} aria-labelledby="permission-title">
        {searchStep?.status === 'permission-required' && <>
          <div className="eyebrow">FOLDER ACCESS</div>
          <h2 id="permission-title">Search {searchStep.folder}?</h2>
          <p>Find “{searchStep.query}” in {searchStep.folder}. Allow saves read access to this folder only, or skip it. Revoke access later in Permissions. macOS may ask separately for file access.</p>
          {searchStep.matches.length > 0 && <p>{searchStep.matches.length} match(es) found so far. Search {searchStep.folder} for another copy or skip this folder.</p>}
          {searchStep.checked.map((item) => <p className="permission-step" key={item}>{item}</p>)}
          {searchStep.errors.map((item) => <p className="python-warning" key={item}>{item}</p>)}
          {error && <p className="error" role="alert">{error}</p>}
          <div className="python-actions"><button type="button" disabled={searchBusy} onClick={() => void decideSearch(false)}>Skip folder</button><button className="add-folder" type="button" disabled={searchBusy} onClick={() => void decideSearch(true)}><FolderPlus size={17} /> Allow and search</button></div>
        </>}
      </dialog>
    </div>
  )
}

function TaskList({ tasks, cancel }: { tasks: Task[], cancel: (id: string) => void }) {
  if (!tasks.length) return <div className="empty"><Clock3 size={21} /><span>No tasks yet. Your completed commands will appear here.</span></div>
  return <div className="task-list">{tasks.map((task) => <article className="task" key={task.id}>
    <div className={`task-indicator ${task.state}`} />
    <div className="task-content"><div className="task-title">{task.request}</div><p>{task.detail}</p><span className="task-meta">{task.state} · {new Date(task.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span></div>
    {(task.state === 'queued' || task.state === 'running') && <button className="cancel-button" type="button" onClick={() => cancel(task.id)} title="Cancel task" aria-label={`Cancel ${task.request}`}><Square size={16} /></button>}
  </article>)}</div>
}

export default App
