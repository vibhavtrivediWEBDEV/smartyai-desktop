import { useEffect, useRef, useState } from 'react'
import { Activity, AppWindow, ArrowRight, CircleHelp, Clock3, Command, ExternalLink, FolderOpen, FolderPlus, History, MicOff, PanelLeft, Plus, Send, ShieldCheck, Square, Terminal, Trash2, WifiOff } from 'lucide-react'
import type { FileSearchStep, FormDetails, PermissionView, PythonProposal, Task, VSCodeProjects } from './bridge'
import { parseAppLaunch, parseFolderOpen, parseVSCodeProjectOpen, parseWebSearch, parseWebsiteOpen, resolveFileSearch } from './app-command'
import { locationSuggestion } from './location-suggestion'
import './App.css'

function searchCreatedAt() {
  return new Date().toISOString()
}

function App() {
  const [view, setView] = useState<'assistant' | 'history' | 'permissions'>('assistant')
  const [activeTab, setActiveTab] = useState('new')
  const [request, setRequest] = useState('')
  const [tasks, setTasks] = useState<Task[]>([])
  const [replies, setReplies] = useState<Record<string, string[]>>({})
  const [permissions, setPermissions] = useState<PermissionView[]>([])
  const [formDetails, setFormDetails] = useState<FormDetails[]>([])
  const [savedLocation, setSavedLocation] = useState<string | null>(null)
  const [locationDraft, setLocationDraft] = useState('')
  const [locationBusy, setLocationBusy] = useState(false)
  const formDetailsRef = useRef<FormDetails[]>([])
  const [contact, setContact] = useState({ origin: '', name: '', email: '', phone: '', address: '' })
  const [contactBusy, setContactBusy] = useState(false)
  const [contactRequest, setContactRequest] = useState<{ origin: string, field: 'name' | 'email' | 'phone' | 'address' } | null>(null)
  const [signedInResearch, setSignedInResearch] = useState(false)
  const [signedInBusy, setSignedInBusy] = useState(false)
  const [glmConfigured, setGlmConfigured] = useState(false)
  const [error, setError] = useState('')
  const [folderPath, setFolderPath] = useState('')
  const [proposal, setProposal] = useState<PythonProposal | null>(null)
  const [pythonResult, setPythonResult] = useState('')
  const [pythonBusy, setPythonBusy] = useState(false)
  const [pythonChats, setPythonChats] = useState<{ id: string, request: string, createdAt: string, result: string }[]>([])
  const [pythonTab, setPythonTab] = useState<string | null>(null)
  const [searchStep, setSearchStep] = useState<FileSearchStep | null>(null)
  const [searches, setSearches] = useState<{ request: string, createdAt: string, step: FileSearchStep }[]>([])
  const [searchBusy, setSearchBusy] = useState(false)
  const [previews, setPreviews] = useState<Record<string, string>>({})
  const [vscodeProjects, setVSCodeProjects] = useState<VSCodeProjects | null>(null)
  const [vscodeProject, setVSCodeProject] = useState<{ name: string, path: string } | null>(null)
  const [vscodePrompt, setVSCodePrompt] = useState('')
  const [vscodeStatus, setVSCodeStatus] = useState('')
  const [vscodeBusy, setVSCodeBusy] = useState(false)
  const input = useRef<HTMLTextAreaElement>(null)
  const conversation = useRef<HTMLDivElement>(null)
  const permissionDialog = useRef<HTMLDialogElement>(null)
  const available = Boolean(window.jarvis)

  useEffect(() => { formDetailsRef.current = formDetails }, [formDetails])

  useEffect(() => {
    if (view === 'assistant') conversation.current?.scrollTo({ top: conversation.current.scrollHeight })
  }, [tasks, searches, view, activeTab])

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
    if (view !== 'permissions' || !window.jarvis) return
    let mounted = true
    void window.jarvis.listPermissions().then((items) => { if (mounted) setPermissions(items) })
      .catch(() => { if (mounted) setError('Could not load permissions.') })
    return () => { mounted = false }
  }, [view])

  useEffect(() => {
    if (!window.jarvis) return
    let mounted = true
    void window.jarvis.listTasks().then((items) => { if (mounted) setTasks(items) })
      .catch(() => { if (mounted) setError('Could not load tasks.') })
    void window.jarvis.listPermissions().then((items) => { if (mounted) setPermissions(items) })
      .catch(() => { if (mounted) setError('Could not load permissions.') })
    void window.jarvis.listFormDetails().then((items) => { if (mounted) setFormDetails(items) })
      .catch(() => { if (mounted) setError('Could not load saved contact details.') })
    void window.jarvis.getLocation().then((location) => { if (mounted) { setSavedLocation(location); setLocationDraft(location ?? '') } })
      .catch(() => { if (mounted) setError('Could not load saved area.') })
    void window.jarvis.signedInResearchStatus().then((enabled) => { if (mounted) setSignedInResearch(enabled) })
      .catch(() => { if (mounted) setError('Could not load signed-in research setting.') })
    void window.jarvis.glmConfigured().then((configured) => { if (mounted) setGlmConfigured(configured) })
      .catch(() => { if (mounted) setError('Could not load GLM-5 status.') })
    const unsubscribeTask = window.jarvis.onTask((task) => {
      setTasks((current) => [task, ...current.filter((item) => item.id !== task.id)].slice(0, 100))
      if ((/^(?:browse|browser)-use\s*:/i.test(task.request) || /\bpizzas?\b/i.test(task.request)) && (task.state === 'cancelled' || task.state === 'failed' || task.state === 'completed')) {
        setContactRequest(null)
      }
      if (task.request.toLowerCase() === 'reset chrome login' && task.state === 'completed') {
        void window.jarvis?.signedInResearchStatus().then(setSignedInResearch)
      }
    })
    const unsubscribeFocus = window.jarvis.onFocusCommand(() => {
      setView('assistant')
      input.current?.focus()
    })
    const unsubscribeContact = window.jarvis.onContactRequest((needed) => {
      setContactRequest(needed)
      setContact((current) => {
        const saved = formDetailsRef.current.find((item) => item.origin === needed.origin)
        return saved ? { origin: needed.origin, name: saved.name, email: saved.email, phone: saved.phone, address: saved.address }
          : { ...current, origin: needed.origin }
      })
      setView('permissions')
      requestAnimationFrame(() => document.getElementById(`contact-${needed.field}`)?.focus())
    })
    return () => {
      mounted = false
      unsubscribeTask()
      unsubscribeFocus()
      unsubscribeContact()
    }
  }, [])

  async function submit(value = request) {
    if (!window.jarvis || !value.trim()) return
    setError('')
    const waiting = tasks.find((task) => task.id === activeTab && task.state === 'running' && task.awaitingReply)
    if (waiting) {
      try {
        if (!await window.jarvis.replyToTask(waiting.id, value.trim())) throw new Error('That task is no longer waiting for a reply. Send your message again.')
        setReplies((current) => ({ ...current, [waiting.id]: [...(current[waiting.id] ?? []), value.trim()] }))
        setRequest('')
        input.current?.focus()
      } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not send reply.') }
      return
    }
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
        const task = await window.jarvis.runCommand(value.trim())
        setActiveTab(task.id)
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
        const createdAt = searchCreatedAt()
        const step = await window.jarvis.startFileSearch(find)
        setSearchStep(step)
        setSearches((current) => [...current, { request: value.trim(), createdAt, step }])
        setActiveTab(step.id)
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
        const id = crypto.randomUUID()
        setPythonChats((current) => [...current, { id, request: value.trim(), createdAt: searchCreatedAt(), result: '' }])
        setPythonTab(id)
        setActiveTab(id)
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
      const task = await window.jarvis.runCommand(value.trim())
      setActiveTab(task.id)
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
      const result = await window.jarvis.executePython(id)
      setPythonResult(result)
      setPythonChats((current) => current.map((chat) => chat.id === pythonTab ? { ...chat, result } : chat))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Python did not complete.')
    } finally { setPythonBusy(false) }
  }

  async function denyPython() {
    if (!proposal || !window.jarvis) return
    const id = proposal.id
    setProposal(null)
    setPythonChats((current) => current.map((chat) => chat.id === pythonTab ? { ...chat, result: 'Python action denied.' } : chat))
    try { await window.jarvis.rejectPython(id) } catch { setError('Could not reject the proposal. It will expire without running.') }
  }

  async function decideSearch(allow: boolean) {
    if (!searchStep || !window.jarvis) return
    setSearchBusy(true)
    setError('')
    try {
      const next = await window.jarvis.decideFileSearch(searchStep.id, allow)
      setSearchStep(next)
      setSearches((current) => current.map((search) => search.step.id === next.id ? { ...search, step: next } : search))
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

  async function toggleSignedInResearch() {
    if (!window.jarvis || signedInBusy) return
    setSignedInBusy(true)
    setError('')
    try { setSignedInResearch(await window.jarvis.setSignedInResearch(!signedInResearch)) }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not change signed-in research.') }
    finally { setSignedInBusy(false) }
  }

  async function saveContact() {
    if (!window.jarvis || contactBusy) return
    setContactBusy(true)
    setError('')
    try {
      const saved = await window.jarvis.saveFormDetails(contact)
      if (saved) {
        setFormDetails(await window.jarvis.listFormDetails())
        setContact({ origin: '', name: '', email: '', phone: '', address: '' })
        if (contactRequest?.origin === saved.origin && saved[contactRequest.field]) setContactRequest(null)
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not save contact details.') }
    finally { setContactBusy(false) }
  }

  async function deleteContact(id: string) {
    if (!window.jarvis || contactBusy) return
    setContactBusy(true)
    setError('')
    try {
      if (await window.jarvis.deleteFormDetails(id)) setFormDetails(await window.jarvis.listFormDetails())
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not delete contact details.') }
    finally { setContactBusy(false) }
  }

  async function saveLocation(value = locationDraft) {
    if (!window.jarvis || locationBusy) return
    setLocationBusy(true)
    setError('')
    try {
      const location = await window.jarvis.saveLocation(value)
      setSavedLocation(location)
      setLocationDraft(location ?? locationDraft)
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not save area.') }
    finally { setLocationBusy(false) }
  }

  async function deleteLocation() {
    if (!window.jarvis || locationBusy) return
    setLocationBusy(true)
    setError('')
    try {
      const location = await window.jarvis.deleteLocation()
      setSavedLocation(location)
      setLocationDraft(location ?? '')
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not delete area.') }
    finally { setLocationBusy(false) }
  }

  const active = tasks.filter((task) => task.state === 'queued' || task.state === 'running')
  const latestRide = tasks[0]?.rideContext ?? (/^(?:browse|browser)-use\s*:/i.test(tasks[0]?.request ?? '') ? tasks[0]?.request : undefined)
  const rideRoute = latestRide && tasks[0]?.state !== 'cancelled' && /\b(?:ride|cab|taxi)\b/i.test(latestRide)
    ? /\bfrom\s+(.+?)\s+to\s+(.+?)(?:\s+(?:search|find|check|compare|book)\b|$)/i.exec(latestRide) : null

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
        <header className="topbar"><span><PanelLeft size={16} /> {view === 'assistant' ? 'Assistant' : view === 'history' ? 'Task history' : 'Permissions'}</span>{view === 'assistant' && <button type="button" className="icon-button" title="New chat" aria-label="New chat" onClick={() => { setActiveTab('new'); setRequest(''); setError(''); setView('assistant'); input.current?.focus() }}><Plus size={16} /></button>}<span className="topbar-state"><Activity size={15} /> {active.length ? `${active.length} active` : 'Ready'}</span></header>
        {view === 'assistant' ? (
          <div className="main-body assistant-view">
            <nav className="chat-tabs" aria-label="Task chats">
              <button type="button" className={activeTab === 'new' ? 'selected' : ''} aria-current={activeTab === 'new' ? 'page' : undefined} onClick={() => setActiveTab('new')}><Plus size={14} /> New chat</button>
              {[...tasks.map((task) => ({ id: task.id, label: task.request, createdAt: task.createdAt })), ...searches.map((search) => ({ id: search.step.id, label: search.request, createdAt: search.createdAt })), ...pythonChats.map((chat) => ({ id: chat.id, label: chat.request, createdAt: chat.createdAt }))]
                .sort((left, right) => right.createdAt.localeCompare(left.createdAt)).map((tab) => <button type="button" key={tab.id} title={tab.label} className={activeTab === tab.id ? 'selected' : ''} aria-current={activeTab === tab.id ? 'page' : undefined} onClick={() => setActiveTab(tab.id)}>{tab.label}</button>)}
            </nav>
            <div ref={conversation} className="conversation" role="log" aria-label="Conversation" aria-live="polite" aria-relevant="additions text">
              {activeTab === 'new' && <div className="intro"><div className="eyebrow">JARVIS</div><h1>What can I help with?</h1><p>Ask GLM-5, research or interact with approved public websites in Chrome, search a filename, or open a macOS app.</p></div>}
              {[...tasks.filter((task) => task.id === activeTab).map((task) => ({ kind: 'task' as const, createdAt: task.createdAt, task })), ...searches.filter((search) => search.step.id === activeTab).map((search) => ({ kind: 'search' as const, createdAt: search.createdAt, search }))]
                .sort((left, right) => left.createdAt.localeCompare(right.createdAt)).map((entry) => {
                if (entry.kind === 'task') {
                  const task = entry.task
                  const suggestedArea = task.state === 'completed' ? locationSuggestion(task.request, task.detail) : null
                  return <article className="exchange" key={task.id}>
                <div className="message user-message"><span className="message-label">You</span><p>{task.request}</p></div>
                <div className={`message assistant-message ${task.state}`}><span className="message-label">Jarvis · {task.state}</span>
                  {task.steps?.length ? <ol className="browser-steps">{task.steps.map((step, index) => <li key={index}>{step}</li>)}</ol> : null}
                  {task.detail !== task.steps?.at(-1) && <p>{task.detail}</p>}
                  {suggestedArea && savedLocation !== suggestedArea && <div className="location-review"><p>Website-suggested area. Check the address before saving; this is not verified device location.</p><button type="button" className="add-folder" disabled={!available || locationBusy} onClick={() => void saveLocation(suggestedArea)}><ShieldCheck size={17} /> Save area on this device</button></div>}
                  {(task.state === 'queued' || task.state === 'running') && <button className="cancel-button" type="button" onClick={() => void cancel(task.id)} title="Cancel task" aria-label={`Cancel ${task.request}`}><Square size={16} /></button>}
                </div>
                {replies[task.id]?.map((reply, index) => <div className="message user-message" key={index}><span className="message-label">You</span><p>{reply}</p></div>)}
              </article>
                }
                return <article className="exchange" key={entry.search.step.id}>
                <div className="message user-message"><span className="message-label">You</span><p>{entry.search.request}</p></div>
                <div className="message assistant-message search-message"><span className="message-label">Jarvis · {entry.search.step.status === 'done' ? 'searched' : 'searching'}</span>
                  {entry.search.step.status === 'done' ? <>
                    {entry.search.step.date && <p>Requested date: {entry.search.step.date}. Searching Desktop, Documents, and Downloads only; Photos library is not connected.</p>}
                    {entry.search.step.checked.map((item) => <p key={item}>{item}</p>)}
                    {entry.search.step.errors.map((item) => <p className="python-warning" key={item}>{item}</p>)}
                    {entry.search.step.matches.length ? <div className="search-results">{entry.search.step.matches.map((file) => <div className="search-match" key={file}>{entry.search.step.id === searchStep?.id && previews[file] && <img src={previews[file]} alt={file.split('/').pop()} />}<div><strong>{file.split('/').pop()}</strong><small>{file}</small></div>{entry.search.step.id === searchStep?.id && <><button type="button" title="Open with default app" aria-label={`Open ${file.split('/').pop()} with default app`} onClick={() => { void window.jarvis?.openFileSearchResult(file).catch((cause) => setError(cause instanceof Error ? cause.message : 'Could not open file.')) }}><ExternalLink size={17} /></button><button type="button" title="Show in Finder" aria-label={`Show ${file.split('/').pop()} in Finder`} onClick={() => { void window.jarvis?.revealFileSearchResult(file).catch((cause) => setError(cause instanceof Error ? cause.message : 'Could not show file in Finder.')) }}><FolderOpen size={17} /></button></>}</div>)}</div> : <p>{entry.search.step.errors.length ? 'No confirmed matches; some folders could not be fully searched.' : /\bscreenshots?\b/i.test(entry.search.step.query) ? 'No saved screenshots found for the requested date in the searched folders. Clipboard-only captures and the Photos library were not searched.' : 'No matching files found in searched folders.'}</p>}
                  </> : <p>Waiting for folder access.</p>}
                </div>
              </article>
              })}
            {pythonChats.filter((chat) => chat.id === activeTab).map((chat) => <div className="exchange" key={chat.id}><div className="message user-message"><span className="message-label">You</span><p>{chat.request}</p></div>{chat.result && <div className="message assistant-message"><span className="message-label">Jarvis · Python</span><p>{chat.result}</p></div>}</div>)}
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
            {pythonBusy && activeTab === pythonTab && <p role="status">{proposal ? 'Running approved Python...' : 'Preparing Python proposal...'}</p>}
            {proposal && activeTab === pythonTab && <section className="python-review" aria-label="Python action approval">
              <h2>Review Python action</h2>
              <p>{proposal.summary}</p>
              <pre><code>{proposal.code}</code></pre>
              <p className="python-warning">Approval runs this code with your user account. It is not sandboxed and may access files or the network. Only approve code you understand.</p>
              <div className="python-actions"><button type="button" onClick={() => void denyPython()}>Deny</button><button type="button" className="add-folder" onClick={() => void approvePython()}>Approve and run once</button></div>
            </section>}
            {pythonResult && activeTab === pythonTab && !pythonChats.some((chat) => chat.id === pythonTab && chat.result) && <p className="python-result" role="status">{pythonResult}</p>}
            {!available && <p className="error" role="alert">Open Jarvis in Electron to run commands. Browser preview cannot access desktop tasks.</p>}
            </div>
            {activeTab === 'new' && <div className="quick-heading"><span>START HERE</span><CircleHelp size={16} /></div>}
            {activeTab === 'new' && <div className="suggestions">
              {['Browse-use: inspect https://example.com', 'Research: OLED vs mini LED monitors', 'Open VS Code', "Today's screenshots"].map((prompt) => <button type="button" key={prompt} disabled={!available} onClick={() => void submit(prompt)}>{prompt}<ArrowRight size={15} /></button>)}
            </div>}
            {rideRoute && <div className="ride-context" role="status"><div><strong>Ride search</strong><span>{rideRoute[1]} → {rideRoute[2]}</span></div><button type="button" disabled={!available || !!active.length} onClick={() => void submit('Search it in Uber also')}><ArrowRight size={15} /> Search Uber</button></div>}
            <section className="composer" aria-label="Command input">
              <label htmlFor="command-input">Message Jarvis</label>
              <textarea ref={input} id="command-input" value={request} onChange={(event) => setRequest(event.target.value)} placeholder="Ask a question or give a command" rows={2} maxLength={4000} disabled={!available} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void submit() } }} />
              <div className="composer-footer"><button className="icon-button" type="button" title="Voice is not available yet" aria-label="Voice is not available yet" disabled><MicOff size={19} /></button><span>Voice is not available yet</span><button className="send-button" type="button" onClick={() => void submit()} disabled={!available || !request.trim()}><Send size={16} /> Send</button></div>
            </section>
          </div>
        ) : view === 'history' ? (
          <div className="main-body history-view"><div className="eyebrow">LOCAL HISTORY</div><h1>Task history</h1><p className="history-caption">The most recent 100 tasks are stored on this device. New chat keeps earlier tasks. Interrupted tasks do not resume automatically.</p><TaskList tasks={tasks} cancel={cancel} /></div>
        ) : (
          <div className="main-body history-view">
            <div className="eyebrow">YOUR CONTROL</div><h1>Permissions</h1>
            <p className="history-caption">Type “open Photos” or another installed app to request launch access when needed. You can revoke each app below. Folder search also asks as it goes. These grants do not provide macOS Full Disk Access or control other apps; Python runs only after you review its code.</p>
            {error && <p className="error" role="alert">{error}</p>}
            <section className="contact-details browser-access" aria-label="Browser site access">
              <h2>Browser site access</h2>
              <p>Public HTTPS pages can be read and scrolled without a visit prompt. Revoke a site's read grant below to block it; Jarvis asks during a task before restoring access and remembers your approval for future visits. Signed-in reads and actions that may change a page still need approval.</p>
            </section>
            <section className="research-setting" aria-label="Signed-in Chrome profile">
              <div><h2>Signed-in Chrome profile</h2><p>Use a Jarvis-only Chrome profile for approved research sites. Run “setup chrome login” to sign in manually; “reset chrome login” removes it. Signed-in sites require separate read approvals.</p></div>
              <label className="research-toggle"><input type="checkbox" checked={signedInResearch} disabled={!available || signedInBusy} onChange={() => void toggleSignedInResearch()} /> Use signed-in profile</label>
            </section>
            <section className="contact-details" aria-label="Saved area">
              <h2>Saved area</h2>
              <p>Optional city, area and PIN. Stored only on this device until deleted. Used for nearby tickets and, with a six-digit PIN, pizza comparisons. These tasks send it to GLM-5 and approved sites; Jarvis does not track device location.</p>
              <form onSubmit={(event) => { event.preventDefault(); void saveLocation() }}>
                <label htmlFor="saved-area">City, area and PIN</label>
                <input id="saved-area" type="text" value={locationDraft} maxLength={300} placeholder="New Ashok Nagar, Delhi 110096" onChange={(event) => setLocationDraft(event.target.value)} disabled={!available || locationBusy} />
                <button className="add-folder" type="submit" disabled={!available || locationBusy || locationDraft.trim().length < 3}><ShieldCheck size={17} /> Save area</button>
                {savedLocation && <button className="cancel-button" type="button" disabled={locationBusy} onClick={() => void deleteLocation()}><Trash2 size={16} /> Delete saved area</button>}
              </form>
            </section>
            <section className="contact-details" aria-label="Saved contact details">
              <h2>Saved contact details</h2>
              {contactRequest && <p role="status">Jarvis needs your {contactRequest.field}{contactRequest.field === 'address' ? ' including area, city and PIN code' : ''} for {contactRequest.origin}. Save and use it to continue, or stop this request. Do not enter payment details.</p>}
              <p>Optional. Save contact fields for one public HTTPS site. GLM-5 receives them only when you approve sharing for a specific browser-use task. Form entry still needs one-time approval. Storage is local unless MongoDB is configured. Do not enter passwords or payment details.</p>
              <form onSubmit={(event) => { event.preventDefault(); void saveContact() }}>
                <label htmlFor="contact-origin">Site origin</label>
                <input id="contact-origin" type="url" placeholder="https://example.com" required value={contact.origin} onChange={(event) => setContact({ ...contact, origin: event.target.value })} disabled={!available || contactBusy || !!contactRequest} />
                <div className="contact-fields">
                  {(['name', 'email', 'phone', 'address'] as const).map((field) => <label key={field} htmlFor={`contact-${field}`}>{field === 'name' ? 'Full name' : field[0].toUpperCase() + field.slice(1)}<input id={`contact-${field}`} type={field === 'email' ? 'email' : field === 'phone' ? 'tel' : 'text'} value={contact[field]} maxLength={field === 'email' ? 254 : field === 'address' ? 300 : field === 'phone' ? 40 : 120} onChange={(event) => setContact({ ...contact, [field]: event.target.value })} disabled={!available || contactBusy} /></label>)}
                </div>
                <button className="add-folder" type="submit" disabled={!available || contactBusy || !contact.origin || (contactRequest ? !contact[contactRequest.field].trim() : !Object.values(contact).slice(1).some(Boolean))}><ShieldCheck size={17} /> {contactRequest ? 'Review, save and use' : 'Review and save'}</button>
                {contactRequest && <button className="cancel-button" type="button" onClick={() => { void window.jarvis?.skipContactRequest(contactRequest.origin); setContactRequest(null) }}>Stop contact request</button>}
              </form>
              <div className="task-list">{formDetails.map((entry) => <article className="task" key={entry.id}>
                <div className="task-indicator completed" />
                <div className="task-content"><div className="task-title">{entry.origin}</div><p>{[entry.name, entry.email, entry.phone, entry.address].filter(Boolean).join(' · ')}</p></div>
                <button className="cancel-button" type="button" disabled={contactBusy} onClick={() => void deleteContact(entry.id)} title="Delete saved details" aria-label={`Delete saved details for ${entry.origin}`}><Trash2 size={16} /></button>
              </article>)}</div>
            </section>
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
    <div className="task-content"><div className="task-title">{task.request}</div>{task.steps?.length ? <ol className="browser-steps">{task.steps.map((step, index) => <li key={index}>{step}</li>)}</ol> : null}<p>{task.detail}</p><span className="task-meta">{task.state} · {new Date(task.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span></div>
    {(task.state === 'queued' || task.state === 'running') && <button className="cancel-button" type="button" onClick={() => cancel(task.id)} title="Cancel task" aria-label={`Cancel ${task.request}`}><Square size={16} /></button>}
  </article>)}</div>
}

export default App
