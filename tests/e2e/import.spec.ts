import { test, expect, _electron as electron } from '@playwright/test'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import electronExe from 'electron'

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
    }
    delete launchEnv.ELECTRON_RUN_AS_NODE
    electronApp = await electron.launch({
      executablePath: electronExe,
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
    const ids = await electronPage.evaluate(async (p: string) => {
      const w = window as Window & { api: { import: { addFiles(paths: string[]): Promise<PdfImportResult> } } }
      return (await w.api.import.addFiles([p])).added
    }, validPath)
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
    const filePaths = [encryptedPath, corruptedPath, withDoiPath]

    const events = await electronPage.evaluate(async (paths: string[]) => {
      const w = window as Window & {
        api: {
          import: { addFiles(ps: string[]): Promise<PdfImportResult> }
          events: {
            onImportProgress(cb: (p: { current: number; total: number; message?: string }) => void): void
          }
        }
      }
      return new Promise<Array<{ current: number; total: number; message?: string }>>((resolve) => {
        const captured: Array<{ current: number; total: number; message?: string }> = []
        const timeout = setTimeout(() => resolve(captured), 20000)
        w.api.events.onImportProgress((payload) => {
          captured.push(payload)
          if (payload.current === payload.total) {
            clearTimeout(timeout)
            resolve(captured)
          }
        })
        void w.api.import.addFiles(paths)
      })
    }, filePaths)

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
    const result = await electronPage.evaluate(async (p: string) => {
      const w = window as Window & {
        api: {
          import: { addFiles(paths: string[]): Promise<PdfImportResult> }
          documents: {
            get(id: string): Promise<DocumentItem>
            list(filter: { mode: string }): Promise<DocumentItem[]>
          }
        }
      }
      const first = await w.api.import.addFiles([p])
      const imported = await w.api.documents.get(first.added[0])
      const second = await w.api.import.addFiles([imported.filePath])
      const documents = await w.api.documents.list({ mode: 'all' })
      return { first: first.added, second: second.added, documents }
    }, duplicatePath)
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
    const ids = await electronPage.evaluate(async (p: string) => {
      const w = window as Window & { api: { import: { addFiles(paths: string[]): Promise<PdfImportResult> } } }
      return (await w.api.import.addFiles([p])).added
    }, encryptedPath)
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
    const ids = await electronPage.evaluate(async (p: string) => {
      const w = window as Window & { api: { import: { addFiles(paths: string[]): Promise<PdfImportResult> } } }
      return (await w.api.import.addFiles([p])).added
    }, corruptedPath)
    expect(ids).toHaveLength(0)

    const docCountAfter = (await electronPage.evaluate(async () => {
      const w = window as Window & { api: { documents: { list(filter: { mode: string }): Promise<DocumentItem[]> } } }
      return w.api.documents.list({ mode: 'all' })
    })).length
    expect(docCountAfter).toBe(docCountBefore)
  })
})
