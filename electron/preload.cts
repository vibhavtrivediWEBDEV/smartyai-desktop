import { contextBridge, ipcRenderer } from 'electron'
import type { JarvisBridge, Task } from '../src/bridge.js'

const api: JarvisBridge = {
  runCommand: (request) => ipcRenderer.invoke('tasks:submit', request),
  newConversation: () => ipcRenderer.invoke('tasks:new-conversation'),
  cancelTask: (id) => ipcRenderer.invoke('tasks:cancel', id),
  replyToTask: (id, message) => ipcRenderer.invoke('tasks:reply', id, message),
  listTasks: () => ipcRenderer.invoke('tasks:list'),
  onTask: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, task: Task) => listener(task)
    ipcRenderer.on('tasks:updated', handler)
    return () => ipcRenderer.removeListener('tasks:updated', handler)
  },
  onFocusCommand: (listener) => {
    const handler = () => listener()
    ipcRenderer.on('window:focus-command', handler)
    return () => ipcRenderer.removeListener('window:focus-command', handler)
  },
  listPermissions: () => ipcRenderer.invoke('permissions:list'),
  allowBrowserAction: (origin, action) => ipcRenderer.invoke('permissions:allow-browser-action', origin, action),
  listFormDetails: () => ipcRenderer.invoke('form-details:list'),
  getLocation: () => ipcRenderer.invoke('location:get'),
  saveLocation: (value) => ipcRenderer.invoke('location:save', value),
  deleteLocation: () => ipcRenderer.invoke('location:delete'),
  saveFormDetails: (input) => ipcRenderer.invoke('form-details:save', input),
  deleteFormDetails: (id) => ipcRenderer.invoke('form-details:delete', id),
  onContactRequest: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, request: { origin: string, field: 'name' | 'email' | 'phone' | 'address' }) => listener(request)
    ipcRenderer.on('form-details:requested', handler)
    return () => ipcRenderer.removeListener('form-details:requested', handler)
  },
  skipContactRequest: (origin) => ipcRenderer.invoke('form-details:skip', origin),
  signedInResearchStatus: () => ipcRenderer.invoke('research:signed-in-status'),
  setSignedInResearch: (enabled) => ipcRenderer.invoke('research:set-signed-in', enabled),
  addReadFolder: (folder) => ipcRenderer.invoke('permissions:add-read-folder', folder),
  allowVSCode: () => ipcRenderer.invoke('permissions:allow-vscode'),
  openVSCode: () => ipcRenderer.invoke('vscode:open'),
  listVSCodeProjects: () => ipcRenderer.invoke('vscode:projects'),
  selectVSCodeProject: (path, expectedName) => ipcRenderer.invoke('vscode:select-project', path, expectedName),
  sendVSCodeChat: (prompt) => ipcRenderer.invoke('vscode:send-chat', prompt),
  allowTerminal: () => ipcRenderer.invoke('permissions:allow-terminal'),
  allowApp: (name) => ipcRenderer.invoke('permissions:allow-app', name),
  allowDownloads: () => ipcRenderer.invoke('permissions:allow-downloads'),
  allowWebsite: (url) => ipcRenderer.invoke('permissions:allow-website', url),
  proposePython: (request) => ipcRenderer.invoke('python:propose', request),
  executePython: (id) => ipcRenderer.invoke('python:execute', id),
  rejectPython: (id) => ipcRenderer.invoke('python:reject', id),
  startFileSearch: (query) => ipcRenderer.invoke('file-search:start', query),
  decideFileSearch: (id, allow) => ipcRenderer.invoke('file-search:decide', id, allow),
  revealFileSearchResult: (file) => ipcRenderer.invoke('file-search:reveal', file),
  openFileSearchResult: (file) => ipcRenderer.invoke('file-search:open', file),
  previewFileSearchResult: (file) => ipcRenderer.invoke('file-search:preview', file),
  glmConfigured: () => ipcRenderer.invoke('glm:status'),
  revokePermission: (id) => ipcRenderer.invoke('permissions:revoke', id),
}

contextBridge.exposeInMainWorld('jarvis', api)