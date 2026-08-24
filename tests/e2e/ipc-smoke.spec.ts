import { test, expect, _electron as electron } from '@playwright/test'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import electronExe from 'electron'
import { authorizeFilePath } from './path-capability'

const testMain = path.resolve(__dirname, 'electron-main.mjs')

type ElectronApi = Record<string, unknown> & {
  getBootstrap(): Promise<Record<string, unknown>>
  settings: {
    set(key: string, value: unknown): Promise<void>
    get(key: string, defaultValue: unknown): Promise<unknown>
  }
  import: {
    addFiles(paths: string[]): Promise<{
      added: string[]
      skipped: string[]
      errors: Array<{ path: string; message: string }>
    }>
  }
  documents: {
    update(id: string, patch: Record<string, unknown>): Promise<Record<string, unknown>>
  }
  events: {
    onDocumentUpdated(cb: (doc: Record<string, unknown>) => void): void
    off(channel: 'document:updated', cb: (doc: Record<string, unknown>) => void): void
  }
}

test.describe('IPC Smoke', () => {
  let electronApp: Awaited<ReturnType<typeof electron.launch>>
  let electronPage: Awaited<ReturnType<Awaited<ReturnType<typeof electron.launch>>['firstWindow']>>
  let userDataFolder: string
  let libraryFolder: string

  test.beforeAll(async () => {
    userDataFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'refora-e2e-smoke-user-'))
    libraryFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'refora-e2e-smoke-'))
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

  test('getBootstrap() returns valid shape', async () => {
    const bootstrap = await electronPage.evaluate(() =>
      (window as unknown as { api: ElectronApi }).api.getBootstrap())
    expect(bootstrap).toBeDefined()
    expect(typeof bootstrap.language).toBe('string')
    expect(['zh', 'en']).toContain(bootstrap.language)
    expect(typeof bootstrap.sidebarCollapsed).toBe('boolean')
    expect(typeof bootstrap.firstRun).toBe('boolean')
    if (bootstrap.windowBounds !== null) {
      expect(bootstrap.windowBounds).toMatchObject({
        x: expect.any(Number),
        y: expect.any(Number),
        width: expect.any(Number),
        height: expect.any(Number),
        isMaximized: expect.any(Boolean),
      })
    }
  })

  test('settings get / set round-trip', async () => {
    const result = await electronPage.evaluate(async () => {
      const settings = (window as unknown as { api: ElectronApi }).api.settings
      const previous = await settings.get('sidebarCollapsed', '0')
      const next = previous === '1' ? '0' : '1'
      await settings.set('sidebarCollapsed', next)
      const value = await settings.get('sidebarCollapsed', '0')
      await settings.set('sidebarCollapsed', previous)
      return { next, value }
    })
    expect(result.value).toBe(result.next)
  })

  test('document:updated event fires on update', async () => {
    const pdfPath = path.resolve(__dirname, '..', 'fixtures', 'valid.pdf')
    const authorizedPath = await authorizeFilePath(electronPage, pdfPath)
    const result = await electronPage.evaluate(
      async (absPath: string) =>
        (window as unknown as { api: ElectronApi }).api.import.addFiles([absPath]),
      authorizedPath,
    )
    const ids = result.added
    expect(ids.length).toBeGreaterThan(0)
    const docId: string = ids[0]

    const eventDoc = await electronPage.evaluate((id: string) => {
      return new Promise<Record<string, unknown>>((resolve, reject) => {
        const electronApi = (window as unknown as { api: ElectronApi }).api
        const timeout = setTimeout(
          () => reject(new Error('Timeout waiting for document:updated')),
          15000,
        )
        const onUpdated = (doc: Record<string, unknown>) => {
          if (doc.id === id && doc.title === 'E2E Test Title') {
            clearTimeout(timeout)
            electronApi.events.off('document:updated', onUpdated)
            resolve(doc)
          }
        }
        electronApi.events.onDocumentUpdated(onUpdated)
        void electronApi.documents.update(id, { title: 'E2E Test Title' }).catch((error) => {
          clearTimeout(timeout)
          electronApi.events.off('document:updated', onUpdated)
          reject(error)
        })
      })
    }, docId)

    expect(eventDoc.id).toBe(docId)
    expect(eventDoc.title).toBe('E2E Test Title')
  })
})
