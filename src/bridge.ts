export type TaskState = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'

export interface Task {
  id: string
  request: string
  state: TaskState
  detail: string
  busContext?: string
  rideContext?: string
  steps?: string[]
  awaitingReply?: boolean
  createdAt: string
  updatedAt: string
}

export interface PermissionView {
  id: string
  capability: string
  scope: string
  state: 'granted' | 'denied'
  expiresAt: string | null
  revokedAt: string | null
  platform: string
}

export interface FormDetails {
  id: string
  origin: string
  name: string
  email: string
  phone: string
  address: string
}

export interface PythonProposal {
  id: string
  summary: string
  code: string
}

export interface FileSearchStep {
  id: string
  status: 'permission-required' | 'done'
  folder: string | null
  query: string
  date: string | null
  matches: string[]
  checked: string[]
  errors: string[]
}

export interface VSCodeProjects {
  names: string[]
  projects: { name: string, path: string }[]
}

export interface JarvisBridge {
  runCommand: (request: string) => Promise<Task>
  newConversation: () => Promise<void>
  cancelTask: (id: string) => Promise<Task | null>
  replyToTask: (id: string, message: string) => Promise<boolean>
  listTasks: () => Promise<Task[]>
  onTask: (listener: (task: Task) => void) => () => void
  onFocusCommand: (listener: () => void) => () => void
  listPermissions: () => Promise<PermissionView[]>
  allowBrowserAction: (origin: string, action: 'read' | 'scroll' | 'click') => Promise<PermissionView | null>
  listFormDetails: () => Promise<FormDetails[]>
  getLocation: () => Promise<string | null>
  saveLocation: (value: string) => Promise<string | null>
  deleteLocation: () => Promise<string | null>
  saveFormDetails: (input: Omit<FormDetails, 'id'>) => Promise<FormDetails | null>
  deleteFormDetails: (id: string) => Promise<boolean>
  onContactRequest: (listener: (request: { origin: string, field: 'name' | 'email' | 'phone' | 'address' }) => void) => () => void
  skipContactRequest: (origin: string) => Promise<void>
  signedInResearchStatus: () => Promise<boolean>
  setSignedInResearch: (enabled: boolean) => Promise<boolean>
  addReadFolder: (folder: string) => Promise<PermissionView>
  allowVSCode: () => Promise<PermissionView | null>
  openVSCode: () => Promise<void>
  listVSCodeProjects: () => Promise<VSCodeProjects>
  selectVSCodeProject: (path: string | null, expectedName?: string) => Promise<{ name: string, path: string } | null>
  sendVSCodeChat: (prompt: string) => Promise<boolean>
  allowTerminal: () => Promise<PermissionView | null>
  allowApp: (name: string) => Promise<PermissionView | null>
  allowDownloads: () => Promise<PermissionView | null>
  allowWebsite: (url: string) => Promise<PermissionView | null>
  proposePython: (request: string) => Promise<PythonProposal>
  executePython: (id: string) => Promise<string>
  rejectPython: (id: string) => Promise<void>
  startFileSearch: (query: string) => Promise<FileSearchStep>
  decideFileSearch: (id: string, allow: boolean) => Promise<FileSearchStep>
  revealFileSearchResult: (file: string) => Promise<void>
  openFileSearchResult: (file: string) => Promise<void>
  previewFileSearchResult: (file: string) => Promise<string>
  glmConfigured: () => Promise<boolean>
  revokePermission: (id: string) => Promise<PermissionView | null>
}

declare global {
  interface Window {
    jarvis?: JarvisBridge
  }
}