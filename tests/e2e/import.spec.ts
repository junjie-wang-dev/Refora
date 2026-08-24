import { test, expect, _electron as electron } from '@playwright/test'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import electronExe from 'electron'
import { authorizeFilePath } from './path-capability'

const testMain = path.resolve(__dirname, 'electron-main.mjs')
const fixturesDir = path.resolve(__dirname, '..', 'fixtures')

interface DocumentItem {
  id: string
  filePath: string
  fileName: string
}

interface PdfImportResult {
  added: string[]
  skipped: string[]
  errors: Array<{ path: string; message: string }>
}

test.describe('Import E2E', () => {
  let electronApp: Awaited<ReturnType<typeof electron.launch>>
  let electronPage: Awaited<ReturnType<Awaited<ReturnType<typeof electron.launch>>['firstWindow']>>
  let userDataFolder: string
  let libraryFolder: string

  test.beforeAll(async () => {
    userDataFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'refora-e2e-import-user-'))
    libraryFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'refora-e2e-lib-'))
    fs.writeFileSync(
      path.join(userDataFolder, 'refora-prefs.json'),
      JSON.stringify({ libraryFolderPath: libraryFolder })
    )
    const launchEnv = {
      ...process.env,
      REFORA_E2E_USER_DATA_DIR: userDataFolder
    } as Record<string, string>
    delete launchEnv.ELECTRON_RUN_AS_NODE
    electronApp = await electron.launch({
      executablePath: String(electronExe),
      env: launchEnv,
      args: [testMain],
    })
    electronPage = await electronApp.firstWindow()
    const actualUserDataFolder = await electronApp.evaluate(({ app }) => app.getPath('userData'))
    expect(actualUserDataFolder).toBe(userDataFolder)
  })

  test.afterAll(async () => {
    await electronApp?.close()
    try { fs.rmSync(userDataFolder, { recursive: true, force: true }) } catch { void 0 }
    try { fs.rmSync(libraryFolder, { recursive: true, force: true }) } catch { void 0 }
  })

  test('imports a single valid PDF and document appears in list', async () => {
    const validPath = path.resolve(fixturesDir, 'valid.pdf')
    const authorizedPath = await authorizeFilePath(electronPage, validPath)
    const ids = await electronPage.evaluate(async (p: string) => {
      const w = window as Window & { api: { import: { addFiles(paths: string[]): Promise<PdfImportResult> } } }
      return (await w.api.import.addFiles([p])).added
    }, authorizedPath)
    expect(ids).toHaveLength(1)

    const docs = await electronPage.evaluate(async () => {
      const w = window as Window & { api: { documents: { list(filter: { mode: string }): Promise<DocumentItem[]> } } }
      return w.api.documents.list({ mode: 'all' })
    })
    expect(docs).toHaveLength(1)
    expect(docs[0].filePath).toBe(fs.realpathSync(path.join(libraryFolder, 'valid.pdf')))
  })

  test('emits import:progress events when importing multiple files', async () => {
    const encryptedPath = path.resolve(fixturesDir, 'encrypted.pdf')
    const corruptedPath = path.resolve(fixturesDir, 'corrupted.pdf')
    const withDoiPath = path.resolve(fixturesDir, 'with-doi.pdf')
    const filePaths: string[] = []
    for (const value of [encryptedPath, corruptedPath, withDoiPath]) {
      filePaths.push(await authorizeFilePath(electronPage, value))
    }
    expect(filePaths).toEqual(
      [encryptedPath, corruptedPath, withDoiPath].map((value) => fs.realpathSync(value))
    )

    const progressResult = await electronPage.evaluate(async (paths: string[]) => {
      const w = window as Window & {
        api: {
          import: { addFiles(ps: string[]): Promise<PdfImportResult> }
          events: {
            onImportProgress(cb: (p: { current: number; total: number; message?: string }) => void): void
          }
        }
      }
      return new Promise<{
        events: Array<{ current: number; total: number; message?: string }>
        error: { code?: string; message?: string } | null
      }>((resolve) => {
        const captured: Array<{ current: number; total: number; message?: string }> = []
        const timeout = setTimeout(() => resolve({ events: captured, error: null }), 20000)
        w.api.events.onImportProgress((payload) => {
          if (payload.total !== paths.length) return
          captured.push(payload)
          if (payload.current === payload.total) {
            clearTimeout(timeout)
            resolve({ events: captured, error: null })
          }
        })
        void w.api.import.addFiles(paths).catch((error) => {
          clearTimeout(timeout)
          const value = error as { code?: string; message?: string }
          resolve({ events: captured, error: { code: value.code, message: value.message } })
        })
      })
    }, filePaths)
    expect(progressResult.error).toBeNull()
    const events = progressResult.events

    expect(events.length).toBeGreaterThan(0)

    const firstEvent = events[0]
    expect(typeof firstEvent.current).toBe('number')
    expect(typeof firstEvent.total).toBe('number')
    expect(firstEvent.total).toBe(filePaths.length)

    const lastEvent = events[events.length - 1]
    expect(lastEvent.current).toBe(lastEvent.total)
  })

  test('skips an already imported library path and does not re-insert', async () => {
    const validPath = path.resolve(fixturesDir, 'valid.pdf')
    const duplicatePath = path.join(userDataFolder, 'duplicate.pdf')
    fs.writeFileSync(
      duplicatePath,
      Buffer.concat([fs.readFileSync(validPath), Buffer.from('\n% duplicate\n')])
    )
    const authorizedDuplicate = await authorizeFilePath(electronPage, duplicatePath)
    const first = await electronPage.evaluate(async (p: string) => {
      const w = window as Window & {
        api: {
          import: { addFiles(paths: string[]): Promise<PdfImportResult> }
          documents: {
            get(id: string): Promise<DocumentItem>
          }
        }
      }
      const importedIds = await w.api.import.addFiles([p])
      const imported = await w.api.documents.get(importedIds.added[0])
      return { added: importedIds.added, filePath: imported.filePath }
    }, authorizedDuplicate)
    const authorizedStoredPath = await authorizeFilePath(electronPage, first.filePath)
    const result = await electronPage.evaluate(async ({ firstAdded, storedPath }) => {
      const w = window as Window & {
        api: {
          import: { addFiles(paths: string[]): Promise<PdfImportResult> }
          documents: { list(filter: { mode: string }): Promise<DocumentItem[]> }
        }
      }
      const second = await w.api.import.addFiles([storedPath])
      const documents = await w.api.documents.list({ mode: 'all' })
      return { first: firstAdded, second: second.added, documents }
    }, { firstAdded: first.added, storedPath: authorizedStoredPath })
    expect(result.first).toHaveLength(1)
    expect(result.second).toHaveLength(0)
    expect(result.documents.length).toBeGreaterThanOrEqual(1)
    const found = result.documents.filter((d: DocumentItem) => d.fileName === 'duplicate.pdf')
    expect(found).toHaveLength(1)
  })

  test('encrypted PDF returns empty result and does not insert', async () => {
    const docCountBefore = (await electronPage.evaluate(async () => {
      const w = window as Window & { api: { documents: { list(filter: { mode: string }): Promise<DocumentItem[]> } } }
      return w.api.documents.list({ mode: 'all' })
    })).length

    const encryptedPath = path.resolve(fixturesDir, 'encrypted.pdf')
    const authorizedPath = await authorizeFilePath(electronPage, encryptedPath)
    const ids = await electronPage.evaluate(async (p: string) => {
      const w = window as Window & { api: { import: { addFiles(paths: string[]): Promise<PdfImportResult> } } }
      return (await w.api.import.addFiles([p])).added
    }, authorizedPath)
    expect(ids).toHaveLength(0)

    const docCountAfter = (await electronPage.evaluate(async () => {
      const w = window as Window & { api: { documents: { list(filter: { mode: string }): Promise<DocumentItem[]> } } }
      return w.api.documents.list({ mode: 'all' })
    })).length
    expect(docCountAfter).toBe(docCountBefore)
  })

  test('corrupted PDF returns empty result and does not insert', async () => {
    const docCountBefore = (await electronPage.evaluate(async () => {
      const w = window as Window & { api: { documents: { list(filter: { mode: string }): Promise<DocumentItem[]> } } }
      return w.api.documents.list({ mode: 'all' })
    })).length

    const corruptedPath = path.resolve(fixturesDir, 'corrupted.pdf')
    const authorizedPath = await authorizeFilePath(electronPage, corruptedPath)
    const ids = await electronPage.evaluate(async (p: string) => {
      const w = window as Window & { api: { import: { addFiles(paths: string[]): Promise<PdfImportResult> } } }
      return (await w.api.import.addFiles([p])).added
    }, authorizedPath)
    expect(ids).toHaveLength(0)

    const docCountAfter = (await electronPage.evaluate(async () => {
      const w = window as Window & { api: { documents: { list(filter: { mode: string }): Promise<DocumentItem[]> } } }
      return w.api.documents.list({ mode: 'all' })
    })).length
    expect(docCountAfter).toBe(docCountBefore)
  })
})
