import { test, expect, _electron as electron } from '@playwright/test'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import electronExe from 'electron'
import { authorizeFilePath } from './path-capability'

const testMain = path.resolve(__dirname, 'electron-main.mjs')
const validPdf = path.resolve(__dirname, '..', 'fixtures', 'valid.pdf')

type ElectronApplication = Awaited<ReturnType<typeof electron.launch>>
type ElectronPage = Awaited<ReturnType<ElectronApplication['firstWindow']>>

type SnapshotApi = {
  getBootstrap(): Promise<unknown>
  import: {
    addFiles(paths: string[]): Promise<{
      added: string[]
      skipped: string[]
      errors: Array<{ path: string; message: string }>
    }>
  }
  documents: {
    list(filter: { mode: string }): Promise<Array<{ id: string; title: string; filePath: string }>>
    update(id: string, patch: Record<string, unknown>): Promise<unknown>
  }
}

async function launchDevice(userDataFolder: string): Promise<{
  app: ElectronApplication
  page: ElectronPage
}> {
  const launchEnv = {
    ...process.env,
    REFORA_E2E_USER_DATA_DIR: userDataFolder
  } as Record<string, string>
  delete launchEnv.ELECTRON_RUN_AS_NODE
  const app = await electron.launch({
    executablePath: String(electronExe),
    env: launchEnv,
    args: [testMain]
  })
  const page = await app.firstWindow()
  await page.evaluate(() => (window as Window & { api: SnapshotApi }).api.getBootstrap())
  return { app, page }
}

async function quitDevice(app: ElectronApplication): Promise<void> {
  const closed = app.waitForEvent('close')
  await app.evaluate(({ app: electronApp }) => electronApp.quit()).catch(() => undefined)
  await closed
}

async function crashDevice(app: ElectronApplication): Promise<void> {
  const closed = app.waitForEvent('close')
  app.process().kill('SIGKILL')
  await closed
}

test('a newer shared-library snapshot replaces an unchanged local working database', async () => {
  test.setTimeout(120_000)
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'refora-e2e-snapshot-'))
  const libraryFolder = path.join(root, 'shared-library')
  const firstUserData = path.join(root, 'device-a')
  const secondUserData = path.join(root, 'device-b')
  fs.mkdirSync(libraryFolder, { recursive: true })
  fs.mkdirSync(firstUserData, { recursive: true })
  fs.mkdirSync(secondUserData, { recursive: true })
  for (const userDataFolder of [firstUserData, secondUserData]) {
    fs.writeFileSync(
      path.join(userDataFolder, 'refora-prefs.json'),
      JSON.stringify({ libraryFolderPath: libraryFolder })
    )
  }

  let running: ElectronApplication | null = null
  try {
    const first = await launchDevice(firstUserData)
    running = first.app
    const authorizedPdf = await authorizeFilePath(first.page, validPdf)
    await first.page.evaluate(async (pdfPath: string) => {
      const api = (window as Window & { api: SnapshotApi }).api
      const imported = await api.import.addFiles([pdfPath])
      if (imported.added.length !== 1) throw new Error(JSON.stringify(imported))
      await api.documents.update(imported.added[0], { title: 'Snapshot from device A, version 1' })
    }, authorizedPdf)
    await quitDevice(first.app)
    running = null

    const snapshotDirectory = path.join(libraryFolder, '.refora', 'snapshots')
    const firstManifest = fs.readdirSync(snapshotDirectory).find((name) => name.endsWith('.json'))
    expect(firstManifest).toBeTruthy()

    const second = await launchDevice(secondUserData)
    running = second.app
    const restored = await second.page.evaluate(async () => {
      const api = (window as Window & { api: SnapshotApi }).api
      const [document] = await api.documents.list({ mode: 'all' })
      if (!document) throw new Error('Snapshot document was not restored')
      return document
    })
    expect(restored.title).toBe('Snapshot from device A, version 1')
    expect(restored.filePath).toBe(fs.realpathSync(path.join(libraryFolder, 'valid.pdf')))
    expect(fs.statSync(restored.filePath).isFile()).toBe(true)
    await crashDevice(second.app)
    running = null

    const firstAgain = await launchDevice(firstUserData)
    running = firstAgain.app
    await firstAgain.page.evaluate(async () => {
      const api = (window as Window & { api: SnapshotApi }).api
      const [document] = await api.documents.list({ mode: 'all' })
      if (!document) throw new Error('Device A document was not found')
      await api.documents.update(document.id, { title: 'Snapshot from device A, version 2' })
    })
    await quitDevice(firstAgain.app)
    running = null

    const manifests = fs.readdirSync(snapshotDirectory).filter((name) => name.endsWith('.json'))
    expect(manifests).toHaveLength(1)
    expect(manifests[0]).not.toBe(firstManifest)

    const secondAgain = await launchDevice(secondUserData)
    running = secondAgain.app
    const [reconciled] = await secondAgain.page.evaluate(() =>
      (window as Window & { api: SnapshotApi }).api.documents.list({ mode: 'all' }))
    expect(reconciled.title).toBe('Snapshot from device A, version 2')
    await quitDevice(secondAgain.app)
    running = null

    expect(fs.readdirSync(snapshotDirectory).filter((name) => name.endsWith('.json')))
      .toHaveLength(1)
    expect(fs.existsSync(path.join(libraryFolder, 'working.db'))).toBe(false)
    expect(fs.existsSync(path.join(libraryFolder, 'refora.db'))).toBe(false)
  } finally {
    if (running) await running.close().catch(() => undefined)
    fs.rmSync(root, { recursive: true, force: true })
  }
})
