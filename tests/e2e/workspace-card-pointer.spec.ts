import { test, expect, _electron as electron, type Locator } from '@playwright/test'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import electronExe from 'electron'
import { authorizeFilePath } from './path-capability'

const testMain = path.resolve(__dirname, 'electron-main.mjs')

type WorkspaceItem = {
  id: string
  noteId: string | null
  x: number
  y: number
  width: number
  height: number
}

type ElectronApi = {
  documents: {
    get(id: string): Promise<{
      filePath: string
      fileHash: string | null
      updatedAt: number
    } | null>
    previewUrl(id: string, version: string | number): string
  }
  import: {
    addFiles(paths: string[]): Promise<{
      added: string[]
      skipped: string[]
      errors: Array<{ path: string; message: string }>
    }>
  }
  library: {
    switch(folder: string): Promise<unknown>
  }
  workspaces: {
    create(name: string): Promise<{ id: string }>
  }
  workspaceNotes: {
    create(
      workspaceId: string,
      title: string,
      contentMd: string,
      noteType: 'markdown',
      placement: { x: number; y: number }
    ): Promise<{ id: string }>
  }
  workspaceItems: {
    list(workspaceId: string): Promise<WorkspaceItem[]>
    add(
      workspaceId: string,
      kind: 'document',
      ids: string[],
      placement: { x: number; y: number }
    ): Promise<WorkspaceItem[]>
    resize(id: string, width: number, height: number): Promise<WorkspaceItem>
  }
}

type PointerTrace = {
  startHit: string
  endHit: string
  events: Array<{
    type: string
    pointerId: number
    button: number
    buttons: number
    clientX: number
    clientY: number
    target: string
    hit: string
    trusted: boolean
  }>
}

type PointerTraceWindow = Window & {
  __reforaPointerTrace?: PointerTrace
  __reforaPointerTraceInstalled?: boolean
}

test.describe('Workspace card pointer gestures', () => {
  let electronApp: Awaited<ReturnType<typeof electron.launch>>
  let electronPage: Awaited<ReturnType<Awaited<ReturnType<typeof electron.launch>>['firstWindow']>>
  let userDataFolder: string
  let libraryFolder: string
  const mainLogs: string[] = []
  const rendererErrors: string[] = []

  const preparePointerTrace = async (
    start: { x: number; y: number },
    end: { x: number; y: number }
  ) => electronPage.evaluate(({ start: startPoint, end: endPoint }) => {
    const traceWindow = window as PointerTraceWindow
    const describeElement = (value: EventTarget | Element | null) => {
      const element = value instanceof Element ? value : null
      if (!element) return 'none'
      const cardKind = element.closest('[data-card-kind]')?.getAttribute('data-card-kind')
      const workspaceCardId = element.closest('[data-workspace-card]')?.getAttribute('data-workspace-card-id')
      const role = element.closest('[role]')?.getAttribute('role')
      return [
        element.tagName.toLowerCase(),
        cardKind ? `[data-card-kind="${cardKind}"]` : '',
        element.closest('[data-card-drag-click]') ? '[data-card-drag-click]' : '',
        workspaceCardId ? `[data-workspace-card-id="${workspaceCardId}"]` : '',
        role ? `[role="${role}"]` : ''
      ].join('')
    }

    if (!traceWindow.__reforaPointerTraceInstalled) {
      const record = (event: PointerEvent) => {
        const trace = traceWindow.__reforaPointerTrace
        if (!trace) return
        const hit = describeElement(document.elementFromPoint(event.clientX, event.clientY))
        trace.endHit = hit
        trace.events.push({
          type: event.type,
          pointerId: event.pointerId,
          button: event.button,
          buttons: event.buttons,
          clientX: event.clientX,
          clientY: event.clientY,
          target: describeElement(event.target),
          hit,
          trusted: event.isTrusted
        })
      }
      document.addEventListener('pointerdown', record, true)
      document.addEventListener('pointermove', record, true)
      document.addEventListener('pointerup', record, true)
      document.addEventListener('pointercancel', record, true)
      traceWindow.__reforaPointerTraceInstalled = true
    }

    traceWindow.__reforaPointerTrace = {
      startHit: describeElement(document.elementFromPoint(startPoint.x, startPoint.y)),
      endHit: describeElement(document.elementFromPoint(endPoint.x, endPoint.y)),
      events: []
    }
  }, { start, end })

  const readPointerTrace = () => electronPage.evaluate(() => (
    (window as PointerTraceWindow).__reforaPointerTrace ?? null
  ))

  const pointerFailure = async (message: string, error: unknown) => {
    let trace: PointerTrace | null = null
    try {
      trace = await readPointerTrace()
    } catch (traceError) {
      rendererErrors.push(traceError instanceof Error ? traceError.message : String(traceError))
    }
    const details = [
      message,
      error instanceof Error ? error.message : String(error),
      `Pointer trace: ${JSON.stringify(trace, null, 2)}`,
      `Renderer errors: ${rendererErrors.join('\n') || 'none'}`,
      `Electron logs: ${mainLogs.join('') || 'none'}`
    ]
    return new Error(details.join('\n'))
  }

  const waitForPointerEvent = async (type: string, buttons: number) => {
    try {
      await expect.poll(async () => {
        const trace = await readPointerTrace()
        return trace?.events.some((event) => (
          event.type === type && event.buttons === buttons && event.trusted
        )) ?? false
      }, { timeout: 3000 }).toBe(true)
    } catch (error) {
      throw await pointerFailure(`Expected native ${type} with buttons=${buttons}`, error)
    }
  }

  const dragLocator = async (
    target: Locator,
    delta: { x: number; y: number },
    steps = 1
  ) => {
    await target.hover()
    const box = await target.boundingBox()
    if (!box) throw new Error('Pointer target has no bounding box')
    const start = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
    const end = { x: start.x + delta.x, y: start.y + delta.y }
    await expect.poll(() => target.evaluate((element, point) => (
      element.contains(document.elementFromPoint(point.x, point.y))
    ), start)).toBe(true)
    await preparePointerTrace(start, end)
    await electronPage.mouse.move(start.x, start.y)
    await electronPage.mouse.down()
    await waitForPointerEvent('pointerdown', 1)
    await electronPage.mouse.move(end.x, end.y, { steps })
    await waitForPointerEvent('pointermove', 1)
    await electronPage.mouse.up()
    await waitForPointerEvent('pointerup', 0)
  }

  const expectWorkspaceItemPosition = async (
    workspaceId: string,
    itemId: string,
    expected: { x: number; y: number }
  ) => {
    try {
      await expect.poll(() => electronPage.evaluate(
        async ({ targetWorkspaceId, targetItemId }) => {
          const electronApi = (window as Window & { api: ElectronApi }).api
          const item = (await electronApi.workspaceItems.list(targetWorkspaceId))
            .find((candidate) => candidate.id === targetItemId)
          return item ? { x: item.x, y: item.y } : null
        },
        { targetWorkspaceId: workspaceId, targetItemId: itemId }
      )).toEqual(expected)
    } catch (error) {
      throw await pointerFailure(`Expected workspace item ${itemId} at ${JSON.stringify(expected)}`, error)
    }
  }

  test.beforeAll(async () => {
    userDataFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'refora-e2e-user-data-'))
    libraryFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'refora-e2e-pointer-'))
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
      args: [testMain]
    })
    electronApp.process().stdout?.on('data', (chunk: Buffer) => mainLogs.push(chunk.toString()))
    electronApp.process().stderr?.on('data', (chunk: Buffer) => mainLogs.push(chunk.toString()))
    electronPage = await electronApp.firstWindow()
    electronPage.on('pageerror', (error) => rendererErrors.push(error.stack ?? error.message))
    electronPage.on('console', (message) => {
      if (message.type() === 'error') rendererErrors.push(message.text())
    })

    const actualUserDataFolder = await electronApp.evaluate(({ app }) => app.getPath('userData'))
    expect(actualUserDataFolder).toBe(userDataFolder)
  })

  test.afterAll(async () => {
    await Promise.race([
      electronApp?.close(),
      new Promise<void>((resolve) => setTimeout(resolve, 3000))
    ]).catch(() => {})
    try { fs.rmSync(userDataFolder, { recursive: true, force: true }) } catch { void 0 }
    try { fs.rmSync(libraryFolder, { recursive: true, force: true }) } catch { void 0 }
  })

  test('uses the native click after small movement and suppresses the click after a drag', async () => {
    const workspaceName = 'Pointer gesture workspace'
    const noteTitle = 'Pointer gesture note'
    const noteContent = 'Reader opened from the browser-generated click.'
    const setup = await electronPage.evaluate(
      async ({ workspaceName: name, noteTitle: title, noteContent: content }) => {
        const electronApi = (window as Window & { api: ElectronApi }).api
        const workspace = await electronApi.workspaces.create(name)
        const note = await electronApi.workspaceNotes.create(
          workspace.id,
          title,
          content,
          'markdown',
          { x: 80, y: 80 }
        )
        const item = (await electronApi.workspaceItems.list(workspace.id))
          .find((candidate) => candidate.noteId === note.id)
        if (!item) throw new Error('Workspace note item was not created')
        return { workspaceId: workspace.id, item }
      },
      { workspaceName, noteTitle, noteContent }
    )

    await electronPage.reload({ waitUntil: 'domcontentloaded' })
    await electronPage.getByRole('button', { name: workspaceName, exact: true }).click()

    const noteCard = electronPage.locator('[data-card-kind="note"]').filter({ hasText: noteTitle })
    const card = electronPage.locator('[data-workspace-card]').filter({ has: noteCard })
    await expect(noteCard).toBeVisible()

    await dragLocator(noteCard, { x: 30, y: 20 }, 2)

    await expect(card).toBeVisible()
    await expect(electronPage.locator('article.markdown-body')).toHaveCount(0)
    await expectWorkspaceItemPosition(
      setup.workspaceId,
      setup.item.id,
      { x: setup.item.x + 30, y: setup.item.y + 20 }
    )

    await dragLocator(noteCard, { x: 4, y: 0 })

    const reader = electronPage.locator('article.markdown-body')
    await expect(reader).toBeVisible()
    await expect(reader.getByRole('heading', { level: 1 })).toHaveText(noteTitle)
    await expect(reader).toContainText(noteContent)
    await expectWorkspaceItemPosition(
      setup.workspaceId,
      setup.item.id,
      { x: setup.item.x + 30, y: setup.item.y + 20 }
    )
  })

  test('loads the first PDF page in a workspace paper card', async () => {
    const workspaceName = 'PDF preview workspace'
    const pdfPath = process.env.REFORA_E2E_PREVIEW_PDF ??
      path.resolve(__dirname, '..', 'fixtures', 'valid.pdf')
    const authorizedPdfPath = await authorizeFilePath(electronPage, pdfPath)
    const setup = await electronPage.evaluate(
      async ({ workspaceName: name, pdfPath: sourcePath }) => {
        const electronApi = (window as Window & { api: ElectronApi }).api
        const imported = await electronApi.import.addFiles([sourcePath])
        if (imported.added.length !== 1) {
          throw new Error(`PDF import failed: ${JSON.stringify(imported)}`)
        }
        const workspace = await electronApi.workspaces.create(name)
        const [item] = await electronApi.workspaceItems.add(
          workspace.id,
          'document',
          imported.added,
          { x: 80, y: 80 }
        )
        const resizedItem = await electronApi.workspaceItems.resize(item.id, 300, 500)
        const document = await electronApi.documents.get(imported.added[0])
        if (!document) throw new Error('Imported PDF was not found')
        return {
          workspaceId: workspace.id,
          docId: imported.added[0],
          filePath: document.filePath,
          item: resizedItem
        }
      },
      { workspaceName, pdfPath: authorizedPdfPath }
    )

    const summaryDb = new DatabaseSync(path.join(libraryFolder, 'refora.db'))
    const summaryTimestamp = Date.now()
    summaryDb.prepare(
      `INSERT INTO ai_summaries (docId, model, summaryJson, fullText, createdAt, updatedAt)
       VALUES (?, ?, ?, NULL, ?, ?)`
    ).run(
      setup.docId,
      'e2e-model',
      JSON.stringify({
        core: 'E2E summary core',
        keyPoints: ['E2E key point'],
        methods: 'E2E methods',
        contribution: 'E2E contribution'
      }),
      summaryTimestamp,
      summaryTimestamp
    )
    summaryDb.close()

    await electronPage.reload({ waitUntil: 'domcontentloaded' })
    await electronPage.getByRole('button', { name: workspaceName, exact: true }).click()

    const preview = electronPage.locator('[data-paper-preview] img')
    await expect(preview).toBeVisible()
    await expect.poll(() => preview.evaluate(
      (image: HTMLImageElement) => image.complete ? image.naturalWidth : 0
    )).toBeGreaterThan(0).catch((error: Error) => {
      throw new Error(`${error.message}\nElectron logs:\n${mainLogs.join('')}`)
    })
    await expect.poll(() => preview.evaluate(
      (image: HTMLImageElement) => image.complete ? image.naturalHeight : 0
    )).toBeGreaterThan(0)
    const layout = await electronPage.locator('[data-paper-preview]').evaluate((element) => {
      const previewBounds = element.getBoundingClientRect()
      const detailsBounds = element.parentElement?.querySelector('[data-paper-details]')?.getBoundingClientRect()
      const containerBounds = element.parentElement?.getBoundingClientRect()
      return {
        previewHeight: previewBounds.height,
        previewWidth: previewBounds.width,
        detailsWidth: detailsBounds?.width ?? 0,
        containerHeight: containerBounds?.height ?? 0,
        containerWidth: containerBounds?.width ?? 0,
        gap: detailsBounds ? detailsBounds.left - previewBounds.right : Number.NaN
      }
    })
    expect(Math.abs(layout.previewHeight - layout.containerHeight)).toBeLessThan(1)
    expect(layout.previewWidth).toBeLessThanOrEqual(layout.containerWidth * 0.7 + 1)
    expect(layout.detailsWidth).toBeGreaterThanOrEqual(layout.containerWidth * 0.3 - 1)
    expect(Math.abs(layout.gap)).toBeLessThan(1)
    await expect(electronPage.locator('[data-paper-preview]')).toHaveCSS('cursor', 'pointer')

    const previewUrl = await preview.getAttribute('src')
    if (!previewUrl) throw new Error('Paper preview has no URL')
    const cacheControl = await electronApp.evaluate(async ({ net }, url) => {
      const response = await net.fetch(url)
      await response.arrayBuffer()
      return response.headers.get('cache-control')
    }, previewUrl)
    expect(cacheControl).toBe('no-store')

    const previewCacheRoot = path.join(libraryFolder, '.refora', 'derived', 'pdf-previews')
    await expect.poll(() => {
      if (!fs.existsSync(previewCacheRoot)) return 0
      return fs.readdirSync(previewCacheRoot).reduce((count, directory) => {
        const directoryPath = path.join(previewCacheRoot, directory)
        if (!fs.statSync(directoryPath).isDirectory()) return count
        return count + fs.readdirSync(directoryPath).filter((name) => name.endsWith('.png')).length
      }, 0)
    }).toBeGreaterThan(0)

    const documentCacheDirectory = path.join(
      previewCacheRoot,
      createHash('sha256').update(setup.docId).digest('hex')
    )
    const initialCacheFiles = fs.readdirSync(documentCacheDirectory)
      .filter((name) => name.endsWith('.png'))
    expect(initialCacheFiles).toHaveLength(1)
    const sourceStats = fs.statSync(setup.filePath)
    fs.utimesSync(
      setup.filePath,
      sourceStats.atime,
      new Date(sourceStats.mtimeMs + 5000)
    )
    await electronApp.evaluate(async ({ net }, url) => {
      const response = await net.fetch(url)
      await response.arrayBuffer()
    }, previewUrl)
    await expect.poll(() => {
      const cacheFiles = fs.readdirSync(documentCacheDirectory)
        .filter((name) => name.endsWith('.png'))
      return cacheFiles.length === 1 && cacheFiles[0] !== initialCacheFiles[0]
    }).toBe(true)

    await dragLocator(
      electronPage.locator('[data-paper-preview]'),
      { x: 30, y: 20 },
      2
    )

    await expectWorkspaceItemPosition(
      setup.workspaceId,
      setup.item.id,
      { x: setup.item.x + 30, y: setup.item.y + 20 }
    )

    await electronPage.locator('[data-paper-details]').click()
    const summaryReader = electronPage.locator('article.markdown-body')
    await expect(summaryReader).toBeVisible()
    await expect(summaryReader).toContainText('E2E summary core')
  })
})
