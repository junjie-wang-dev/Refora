import type { SqliteDb } from '../types'
import { createDocumentsRepository } from './documents'
import { createCategoriesRepository } from './categories'
import { createWatchFoldersRepository } from './watchFolders'
import { createSettingsRepository } from './settings'
import { createWorkspacesRepository } from './workspaces'
import { createWorkspaceItemsRepository } from './workspaceItems'
import { createWorkspaceNotesRepository } from './workspaceNotes'
import { createWorkspaceCanvasRepository } from './workspaceCanvas'
import { createWorkspaceConnectionsRepository } from './workspaceConnections'
import { createWorkspaceAssetsRepository } from './workspaceAssets'
import { createAiSummariesRepository } from './aiSummaries'
import { createAiReportsRepository } from './aiReports'
import { createChatRepository } from './chat'
import { createAiProvidersRepository } from './aiProviders'
import { createDocumentOcrRepository } from './documentOcr'
import { createWebSearchConfigRepository } from './webSearchConfig'
import { RepoError } from './errors'

export interface RepositoryDeps {
  getSearchMode?: () => 'trigram' | 'like'
}

export function createRepositories(db: SqliteDb, deps: RepositoryDeps = {}) {
  const settings = createSettingsRepository(db)
  const documents = createDocumentsRepository(db, {
    getLibraryFolder: () => settings.get<string>('libraryFolderPath', ''),
    getSearchMode: deps.getSearchMode ?? (() => 'trigram')
  })
  const categories = createCategoriesRepository(db)
  const watchFolders = createWatchFoldersRepository(db)
  const workspaces = createWorkspacesRepository(db)
  const workspaceItems = createWorkspaceItemsRepository(db)
  const workspaceNotes = createWorkspaceNotesRepository(db)
  const workspaceCanvas = createWorkspaceCanvasRepository(db)
  const workspaceConnections = createWorkspaceConnectionsRepository(db)
  const workspaceAssets = createWorkspaceAssetsRepository(db)
  const aiSummaries = createAiSummariesRepository(db)
  const aiReports = createAiReportsRepository(db)
  const chat = createChatRepository(db)
  const aiProviders = createAiProvidersRepository(db)
  const documentOcr = createDocumentOcrRepository(db)
  const webSearchConfig = createWebSearchConfigRepository(db)

  let depth = 0

  function transaction<T>(fn: () => T): T {
    const outer = depth === 0
    const savepoint = `sp_${depth}`
    if (outer) {
      db.exec('BEGIN')
    } else {
      db.exec(`SAVEPOINT ${savepoint}`)
    }
    depth += 1
    try {
      const result = fn()
      if (result != null && typeof (result as { then?: unknown }).then === 'function') {
        throw new RepoError(
          'transaction_callback_must_be_sync',
          'transaction callbacks must be synchronous'
        )
      }
      if (outer) {
        db.exec('COMMIT')
      } else {
        db.exec(`RELEASE SAVEPOINT ${savepoint}`)
      }
      return result
    } catch (err) {
      if (outer) {
        db.exec('ROLLBACK')
      } else {
        db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`)
        db.exec(`RELEASE SAVEPOINT ${savepoint}`)
      }
      throw err
    } finally {
      depth -= 1
    }
  }

  return {
    documents,
    categories,
    watchFolders,
    settings,
    workspaces,
    workspaceItems,
    workspaceNotes,
    workspaceCanvas,
    workspaceConnections,
    workspaceAssets,
    aiSummaries,
    aiReports,
    chat,
    aiProviders,
    documentOcr,
    webSearchConfig,
    transaction
  }
}

export type Repositories = ReturnType<typeof createRepositories>
