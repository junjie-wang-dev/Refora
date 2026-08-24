import { test, expect, _electron as electron } from '@playwright/test'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import electronExe from 'electron'
import { authorizeFilePath } from './path-capability'

const testMain = path.resolve(__dirname, 'electron-main.mjs')

test.describe('Document CRUD', () => {
  let electronApp: Awaited<ReturnType<typeof electron.launch>>
  let electronPage: Awaited<ReturnType<Awaited<ReturnType<typeof electron.launch>>['firstWindow']>>
  let userDataFolder: string
  let libraryFolder: string

  test.beforeAll(async () => {
    userDataFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'refora-e2e-crud-user-'))
    libraryFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'refora-e2e-crud-'))
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
    await Promise.race([
      electronApp?.close(),
      new Promise<void>((resolve) => setTimeout(resolve, 3000)),
    ]).catch(() => {})
    try { fs.rmSync(userDataFolder, { recursive: true, force: true }) } catch { void 0 }
    try { fs.rmSync(libraryFolder, { recursive: true, force: true }) } catch { void 0 }
  })

  test('create → list → read', async () => {
    const pdfPath = path.resolve(__dirname, '..', 'fixtures', 'valid.pdf')
    const authorizedPdfPath = await authorizeFilePath(electronPage, pdfPath)
    const ids = await electronPage.evaluate(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async (absPath: string) => ((await (window as any).api.import.addFiles([absPath])) as { added: string[] }).added,
      authorizedPdfPath,
    )
    expect(ids.length).toBe(1)
    const docId = ids[0]

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const docs = await electronPage.evaluate(() => (window as any).api.documents.list({ mode: 'all' }) as Promise<unknown[]>)
    expect(docs.length).toBeGreaterThanOrEqual(1)
    const found = docs.find((d: unknown) => (d as { id: string }).id === docId)
    expect(found).toBeDefined()

    const doc = await electronPage.evaluate(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (id: string) => (window as any).api.documents.get(id) as Promise<Record<string, unknown> | null>,
      docId,
    )
    expect(doc).not.toBeNull()
    expect(doc!.id).toBe(docId)
    expect(doc!.title === null || typeof doc!.title === 'string').toBe(true)
    expect(typeof doc!.fileName).toBe('string')
    expect(typeof doc!.filePath).toBe('string')
    expect(typeof doc!.addedAt).toBe('number')

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await electronPage.evaluate((id: string) => (window as any).api.documents.delete(id) as Promise<void>, docId)
  })

  test('update title + editedFields tracking', async () => {
    const pdfPath = path.resolve(__dirname, '..', 'fixtures', 'valid.pdf')
    const authorizedPdfPath = await authorizeFilePath(electronPage, pdfPath)
    const ids = await electronPage.evaluate(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async (absPath: string) => ((await (window as any).api.import.addFiles([absPath])) as { added: string[] }).added,
      authorizedPdfPath,
    )
    expect(ids.length).toBe(1)
    const docId = ids[0]

    const result = await electronPage.evaluate(
      async (id: string) => {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const updated = await (window as any).api.documents.update(id, { title: 'Updated Title' })
          return { ok: true, data: updated }
        } catch (e: unknown) {
          const error = e as { code?: string; message?: string }
          return { ok: false, error: { code: error.code, message: error.message } }
        }
      },
      docId,
    )
    expect(result.ok).toBe(true)
    const updated = (result as { data: Record<string, unknown> }).data
    expect(updated.title).toBe('Updated Title')
    expect(Array.isArray(updated.editedFields)).toBe(true)
    expect((updated.editedFields as string[])).toContain('title')

    const refetched = await electronPage.evaluate(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (id: string) => (window as any).api.documents.get(id) as Promise<Record<string, unknown> | null>,
      docId,
    )
    expect(refetched).not.toBeNull()
    expect(refetched!.title).toBe('Updated Title')

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await electronPage.evaluate((id: string) => (window as any).api.documents.delete(id) as Promise<void>, docId)
  })

  test('update forbidden field rejected', async () => {
    const pdfPath = path.resolve(__dirname, '..', 'fixtures', 'valid.pdf')
    const authorizedPdfPath = await authorizeFilePath(electronPage, pdfPath)
    const ids = await electronPage.evaluate(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async (absPath: string) => ((await (window as any).api.import.addFiles([absPath])) as { added: string[] }).added,
      authorizedPdfPath,
    )
    expect(ids.length).toBe(1)
    const docId = ids[0]

    const result = await electronPage.evaluate(
      async (id: string) => {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          await (window as any).api.documents.update(id, { filePath: '/hacked' })
          return { ok: true }
        } catch (e: unknown) {
          return { ok: false, error: e as { code: string; message: string } }
        }
      },
      docId,
    )
    expect(result.ok).toBe(false)
    expect((result as { error: { code: string } }).error.code).toBe('forbidden_field')

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await electronPage.evaluate((id: string) => (window as any).api.documents.delete(id) as Promise<void>, docId)
  })

  test('set star', async () => {
    const pdfPath = path.resolve(__dirname, '..', 'fixtures', 'valid.pdf')
    const authorizedPdfPath = await authorizeFilePath(electronPage, pdfPath)
    const ids = await electronPage.evaluate(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async (absPath: string) => ((await (window as any).api.import.addFiles([absPath])) as { added: string[] }).added,
      authorizedPdfPath,
    )
    expect(ids.length).toBe(1)
    const docId = ids[0]

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await electronPage.evaluate((id: string) => (window as any).api.documents.setStarred(id, true) as Promise<void>, docId)

    const doc = await electronPage.evaluate(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (id: string) => (window as any).api.documents.get(id) as Promise<Record<string, unknown> | null>,
      docId,
    )
    expect(doc).not.toBeNull()
    expect(doc!.starred).toBe(1)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await electronPage.evaluate((id: string) => (window as any).api.documents.delete(id) as Promise<void>, docId)
  })

  test('delete + list confirms gone', async () => {
    const pdfPath = path.resolve(__dirname, '..', 'fixtures', 'valid.pdf')
    const authorizedPdfPath = await authorizeFilePath(electronPage, pdfPath)
    const ids = await electronPage.evaluate(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async (absPath: string) => ((await (window as any).api.import.addFiles([absPath])) as { added: string[] }).added,
      authorizedPdfPath,
    )
    expect(ids.length).toBe(1)
    const docId = ids[0]

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await electronPage.evaluate((id: string) => (window as any).api.documents.delete(id) as Promise<void>, docId)

    const documents = await electronPage.evaluate(() =>
      (window as Window & {
        api: { documents: { list(filter: { mode: string }): Promise<Array<{ id: string }>> } }
      }).api.documents.list({ mode: 'all' })
    )
    expect(documents.some((document) => document.id === docId)).toBe(false)
  })

  test('bulk delete 3 documents', async () => {
    const pdfPath = path.resolve(__dirname, '..', 'fixtures', 'valid.pdf')
    const thirdPdfPath = path.join(userDataFolder, 'third.pdf')
    fs.writeFileSync(thirdPdfPath, Buffer.concat([fs.readFileSync(pdfPath), Buffer.from('\n% third\n')]))
    const firstPath = await authorizeFilePath(electronPage, pdfPath)
    const secondPath = await authorizeFilePath(
      electronPage,
      path.resolve(__dirname, '..', 'fixtures', 'with-doi.pdf')
    )
    const thirdPath = await authorizeFilePath(electronPage, thirdPdfPath)
    const ids = await electronPage.evaluate(
      async (paths: { firstPath: string; secondPath: string; thirdPath: string }) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const a = (window as any).api
        const id1 = (await a.import.addFiles([paths.firstPath])).added[0]
        const id2 = (await a.import.addFiles([paths.secondPath])).added[0]
        const id3 = (await a.import.addFiles([paths.thirdPath])).added[0]
        return [id1, id2, id3]
      },
      { firstPath, secondPath, thirdPath },
    )
    expect(ids.length).toBe(3)

    await electronPage.evaluate(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (idList: string[]) => (window as any).api.documents.bulkDelete(idList) as Promise<void>,
      ids,
    )

    const documents = await electronPage.evaluate(() =>
      (window as Window & {
        api: { documents: { list(filter: { mode: string }): Promise<Array<{ id: string }>> } }
      }).api.documents.list({ mode: 'all' })
    )
    expect(documents.some((document) => ids.includes(document.id))).toBe(false)
  })

  test('categories CRUD round-trip', async () => {
    const pdfPath = path.resolve(__dirname, '..', 'fixtures', 'valid.pdf')
    const authorizedPdfPath = await authorizeFilePath(electronPage, pdfPath)
    const ids = await electronPage.evaluate(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async (absPath: string) => ((await (window as any).api.import.addFiles([absPath])) as { added: string[] }).added,
      authorizedPdfPath,
    )
    expect(ids.length).toBe(1)
    const docId = ids[0]

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cat = await electronPage.evaluate(() => (window as any).api.categories.create('E2E Test Category') as Promise<Record<string, unknown>>)
    expect(cat).toBeDefined()
    expect(typeof cat.id).toBe('string')
    expect(cat.name).toBe('E2E Test Category')

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const catList = await electronPage.evaluate(() => (window as any).api.categories.list() as Promise<unknown[]>)
    const found = catList.find((c: unknown) => (c as { id: string }).id === cat.id)
    expect(found).toBeDefined()

    await electronPage.evaluate(
      async (args: { docId: string; catId: string }) => {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          await (window as any).api.categories.assign(args.docId, args.catId)
          return { ok: true }
        } catch (e: unknown) {
          return { ok: false, error: e as { code: string; message: string } }
        }
      },
      { docId, catId: cat.id as string },
    ).then((r) => {
      if (!(r as { ok: boolean }).ok) {
        const err = (r as { error: { code: string; message: string } }).error
        throw new Error(`assign failed: ${err.code} - ${err.message}`)
      }
    })

    await electronPage.evaluate(
      async (args: { docId: string; catId: string }) => {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          await (window as any).api.categories.unassign(args.docId, args.catId)
          return { ok: true }
        } catch (e: unknown) {
          return { ok: false, error: e as { code: string; message: string } }
        }
      },
      { docId, catId: cat.id as string },
    ).then((r) => {
      if (!(r as { ok: boolean }).ok) {
        const err = (r as { error: { code: string; message: string } }).error
        throw new Error(`unassign failed: ${err.code} - ${err.message}`)
      }
    })

    await electronPage.evaluate(
      async (catId: string) => {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          await (window as any).api.categories.delete(catId)
          return { ok: true }
        } catch (e: unknown) {
          return { ok: false, error: e as { code: string; message: string } }
        }
      },
      cat.id as string,
    ).then((r) => {
      if (!(r as { ok: boolean }).ok) {
        const err = (r as { error: { code: string; message: string } }).error
        throw new Error(`delete cat failed: ${err.code} - ${err.message}`)
      }
    })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const catListAfter = await electronPage.evaluate(() => (window as any).api.categories.list() as Promise<unknown[]>)
    const stillExists = catListAfter.find((c: unknown) => (c as { id: string }).id === cat.id)
    expect(stillExists).toBeUndefined()

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await electronPage.evaluate((id: string) => (window as any).api.documents.delete(id) as Promise<void>, docId)
  })
})
