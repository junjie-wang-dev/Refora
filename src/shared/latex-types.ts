import type { WorkspaceItemPlacement } from './ipc-types'

export interface LatexProject {
  id: string
  title: string
  rootFile: string
  files: string[]
  template?: string | null
  reviewFiles?: string[]
  previewRevision?: string | null
  inputRevision?: string
}

export interface LatexFile {
  path: string
  content: string
  hash: string
  encoding?: string
  review?: LatexReview
}

export interface LatexReview {
  id: string
  path: string
  baseContent: string
  expectedHash: string
  edits: { id: string; startLine: number; endLine: number; before: string; after: string; status: 'pending' | 'accepted' | 'rejected' }[]
}

export type LatexEngine = 'pdflatex' | 'xelatex' | 'lualatex'
export type LatexCompiler = 'latexmk' | 'tectonic'

export interface LatexSyncBox {
  path: string
  line: number
  page: number
  x: number
  y: number
  width: number
  height: number
}

export interface LatexSyncMap {
  boxes: LatexSyncBox[]
  sourceHashes: Record<string, string>
}

export type LatexRequest =
  | { action: 'list' | 'active' | 'configure' }
  | { action: 'create'; title: string; placement?: WorkspaceItemPlacement }
  | { action: 'import'; source?: 'directory' | 'archive'; assetId?: string; placement?: WorkspaceItemPlacement }
  | { action: 'project' | 'preview'; projectId: string }
  | { action: 'exportProject' | 'sources'; projectId: string }
  | { action: 'cancelCompile'; projectId: string; compileId?: string }
  | { action: 'importFiles'; projectId: string; source?: 'directory' | 'archive' }
  | { action: 'rename'; projectId: string; path: string; newPath: string; expectedHash: string }
  | { action: 'delete'; projectId: string; path: string; expectedHash: string }
  | { action: 'resource' | 'history'; projectId: string; path: string }
  | { action: 'restore'; projectId: string; path: string; historyId: string; expectedHash: string }
  | { action: 'read'; projectId: string; path: string }
  | { action: 'write'; projectId: string; path: string; content: string; expectedHash: string }
  | { action: 'review'; projectId: string; path: string; reviewId: string; decision: 'accept' | 'reject'; editId?: string }
  | { action: 'activate'; projectId?: string; path?: string }
  | { action: 'root'; projectId: string; path: string }
  | { action: 'asset'; projectId: string; assetId: string }
  | { action: 'compile'; projectId: string; engine: LatexEngine; compileId?: string }

export interface LatexResponse {
  projects?: LatexProject[]
  project?: LatexProject
  file?: LatexFile
  active?: { projectId: string; path: string } | null
  assetPath?: string
  importReport?: { imported: string[]; skipped: string[] }
  sources?: LatexFile[]
  sourceErrors?: { path: string; message: string }[]
  resource?: { path: string; mimeType: string; base64: string; hash?: string }
  archiveBase64?: string
  history?: { id: string; content: string; createdAt: string }[]
  compilation?: { success: boolean; log: string; builtAt?: string; engine?: LatexEngine; stale?: boolean; cacheSaved?: boolean; pdfBase64?: string; synctex?: LatexSyncMap | null }
}

export interface LatexChatContext {
  projectId: string
  path: string
  selection?: { startLine: number; endLine: number }
  intent?: 'proofread' | 'edit'
}
