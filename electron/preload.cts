import { contextBridge, ipcRenderer } from 'electron'
import type { JarvisBridge, Task } from '../src/bridge.js'

const api: JarvisBridge = {
  runCommand: (request) => ipcRenderer.invoke('tasks:submit', request),
  cancelTask: (id) => ipcRenderer.invoke('tasks:cancel', id),
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
  allowResearchAutopilot: () => ipcRenderer.invoke('permissions:allow-research-autopilot'),
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