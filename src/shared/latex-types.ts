import type { WorkspaceItemPlacement } from './ipc-types'

export interface LatexProject {
  id: string
  title: string
  rootFile: string
  files: string[]
}

export interface LatexFile {
  path: string
  content: string
  hash: string
}

export type LatexEngine = 'pdflatex' | 'xelatex' | 'lualatex'

export type LatexRequest =
  | { action: 'list' | 'active' | 'configure' }
  | { action: 'create'; title: string; placement?: WorkspaceItemPlacement }
  | { action: 'import'; assetId?: string; placement?: WorkspaceItemPlacement }
  | { action: 'project'; projectId: string }
  | { action: 'read'; projectId: string; path: string }
  | { action: 'write'; projectId: string; path: string; content: string; expectedHash: string }
  | { action: 'activate'; projectId?: string; path?: string }
  | { action: 'root'; projectId: string; path: string }
  | { action: 'asset'; projectId: string; assetId: string }
  | { action: 'compile'; projectId: string; engine: LatexEngine }

export interface LatexResponse {
  projects?: LatexProject[]
  project?: LatexProject
  file?: LatexFile
  active?: { projectId: string; path: string } | null
  assetPath?: string
  compilation?: { success: boolean; log: string; pdfBase64?: string }
}
