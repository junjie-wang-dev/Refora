import { test, expect, _electron as electron } from '@playwright/test'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import electronExe from 'electron'
import { authorizeFilePath } from './path-capability'

const testMain = path.resolve(__dirname, 'electron-main.mjs')
const fixtures = path.resolve(__dirname, '..', 'fixtures')

test.describe('Built-in PDF reader', () => {
  let electronApp: Awaited<ReturnType<typeof electron.launch>>
  let page: Awaited<ReturnType<Awaited<ReturnType<typeof electron.launch>>['firstWindow']>>
  let userDataFolder: string
  let libraryFolder: string
  let firstDocumentId: string
  let secondDocumentId: string

  test.beforeAll(async () => {
    userDataFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'refora-reader-user-'))
    libraryFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'refora-reader-library-'))
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
      args: [testMain]
    })
    page = await electronApp.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    const first = await authorizeFilePath(page, path.join(fixtures, 'valid.pdf'))
    const second = await authorizeFilePath(page, path.join(fixtures, 'with-doi.pdf'))
    const imported = await page.evaluate(async ({ first, second }) => {
      const api = (window as unknown as {
        api: {
          import: {
            addFiles(paths: string[]): Promise<{ added: string[] }>
          }
          settings: {
            set(key: string, value: unknown): Promise<void>
          }
          workspaces: {
            create(name: string): Promise<unknown>
          }
          documents: {
            list(filter: { mode: 'all' }): Promise<Array<{ id: string; fileName: string }>>
          }
        }
      }).api
      await api.import.addFiles([first, second])
      await api.settings.set('pdfOpenMode', 'builtin')
      await api.workspaces.create('Reader workspace')
      await api.workspaces.create('Unopened workspace')
      return api.documents.list({ mode: 'all' })
    }, { first, second })
    firstDocumentId = imported.find((document) => document.fileName === 'valid.pdf')?.id ?? ''
    secondDocumentId = imported.find((document) => document.fileName === 'with-doi.pdf')?.id ?? ''
    await page.reload()
    await page.waitForLoadState('domcontentloaded')
  })

  test.afterAll(async () => {
    await electronApp?.close()
    fs.rmSync(userDataFolder, { recursive: true, force: true })
    fs.rmSync(libraryFolder, { recursive: true, force: true })
  })

  test('opens multiple tabs and persists visible drawing and text annotations locally', async () => {
    const firstRow = page.locator(`[data-document-id="${firstDocumentId}"]`)
    const secondRow = page.locator(`[data-document-id="${secondDocumentId}"]`)
    await expect(firstRow).toBeVisible()
    await firstRow.getByRole('button', { name: 'Open' }).click()

    await expect(page.locator('.pdf-reader-page')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Add PDF tab' })).toHaveCount(0)
    await expect(secondRow).toBeVisible()
    await secondRow.click()
    await page.getByRole('button', { name: 'Open File' }).click()

    await expect(page.locator('[data-reader-tab-kind="workspace"]')).toHaveCount(0)
    await expect(page.locator('[data-reader-tab-kind="pdf"]')).toHaveCount(2)
    await expect(page.getByRole('button', { name: 'Enter fullscreen' })).toHaveCount(1)
    await expect(page.getByRole('button', { name: 'Highlight' })).toBeVisible()
    await expect(page.getByRole('button', {
      name: 'Freehand drawing',
      exact: true
    })).toBeVisible()
    await expect(page.locator('[data-pdf-annotation-toolbar]')).toHaveCSS(
      'background-color',
      'rgba(0, 0, 0, 0)'
    )
    await expect(page.locator('[data-pdf-annotation-toolbar]')).toHaveCSS(
      'border-top-width',
      '0px'
    )
    await expect(page.locator('[data-pdf-reader-toolbar][data-compact]')).toBeVisible()
    await expect(page.locator('[data-active-pdf-tool]')).toHaveText('Select annotations')
    await expect(page.getByRole('button', {
      name: 'Select annotations',
      exact: true
    })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Annotation color' })).toHaveCount(0)
    await expect(page.locator('[data-annotation-sidebar]')).toHaveCount(0)

    await page.getByRole('button', { name: 'Search in PDF', exact: true }).click()
    const compactSearch = page.getByPlaceholder('Search in PDF', { exact: true })
    await expect(compactSearch).toBeFocused()
    await compactSearch.press('Escape')
    await expect(compactSearch).toBeHidden()

    await page.getByRole('button', { name: 'Toggle annotations panel' }).click()
    await expect(page.locator('[data-annotation-sidebar][data-overlay]')).toBeVisible()
    await page.getByRole('button', { name: 'Close annotations panel' }).click()
    await expect(page.locator('[data-annotation-sidebar]')).toHaveCount(0)
    await page.getByRole('button', { name: 'Toggle annotations panel' }).click()
    await expect(page.locator('[data-annotation-sidebar][data-overlay]')).toBeVisible()
    const pdfPage = page.locator('.pdf-reader-page').first()
    const annotationInput = pdfPage.locator('[data-annotation-input-layer]')

    const freehandTool = page.locator('button[data-shortcut="P"]')
    await freehandTool.click()
    await expect(page.locator('[data-active-pdf-tool]')).toHaveText('Freehand drawing')
    await expect(page.locator('[data-annotation-sidebar]')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Annotation color' })).toHaveCount(5)
    await page.getByRole('button', { name: 'Increase drawing line width' }).click()
    await expect(annotationInput).toHaveClass(/pointer-events-auto/)
    const drawingBounds = await annotationInput.boundingBox()
    expect(drawingBounds).not.toBeNull()
    await page.mouse.move(
      drawingBounds!.x + drawingBounds!.width * 0.15,
      drawingBounds!.y + drawingBounds!.height * 0.45
    )
    await page.mouse.down()
    await page.mouse.move(
      drawingBounds!.x + drawingBounds!.width * 0.3,
      drawingBounds!.y + drawingBounds!.height * 0.55,
      { steps: 6 }
    )
    await page.mouse.up()
    await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() ?? ''))
      .toBe('')

    const ink = pdfPage.locator('[data-annotation-kind="ink"]').last()
    await expect(ink).toHaveCount(1)
    await expect(ink).toHaveAttribute('stroke-width', '3')
    await expect(pdfPage.locator('[data-selected-annotation]')).toHaveCount(0)
    await expect(page.getByRole('button', {
      name: 'Delete selected annotations (1)'
    })).toHaveCount(0)
    await freehandTool.click()
    await expect(page.locator('[data-active-pdf-tool]')).toHaveText('Select annotations')
    await expect(page.getByRole('button', {
      name: 'Read and select text',
      exact: true
    })).toHaveCount(0)
    await expect(freehandTool).not.toHaveAttribute('aria-pressed', 'true')

    const selectableText = pdfPage.locator('.textLayer span')
      .filter({ hasText: /\S{2}/ })
      .first()
    const textBounds = await selectableText.boundingBox()
    expect(textBounds).not.toBeNull()
    await page.mouse.move(
      textBounds!.x + textBounds!.width * 0.1,
      textBounds!.y + textBounds!.height / 2
    )
    await page.mouse.down()
    await page.mouse.move(
      textBounds!.x + textBounds!.width * 0.75,
      textBounds!.y + textBounds!.height / 2,
      { steps: 4 }
    )
    await page.mouse.up()
    await expect.poll(() => page.evaluate(() => window.getSelection()?.toString().trim() ?? ''))
      .not.toBe('')
    const selectedTextBounds = await page.evaluate(() => {
      const selection = window.getSelection()
      if (!selection || selection.rangeCount === 0) return null
      const bounds = selection.getRangeAt(0).getBoundingClientRect()
      return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }
    })
    expect(selectedTextBounds).not.toBeNull()
    await page.evaluate(() => window.getSelection()?.removeAllRanges())
    await selectableText.dblclick({
      position: {
        x: textBounds!.width * 0.4,
        y: textBounds!.height / 2
      }
    })
    await expect.poll(() => page.evaluate(() => window.getSelection()?.toString().trim() ?? ''))
      .not.toBe('')
    await page.evaluate(() => window.getSelection()?.removeAllRanges())

    const annotationToolbar = page.locator('[data-pdf-annotation-toolbar]')
    const highlightTool = annotationToolbar.getByRole('button', {
      name: 'Highlight',
      exact: true
    })
    await highlightTool.click()
    await page.mouse.move(
      textBounds!.x + textBounds!.width * 0.1,
      textBounds!.y + textBounds!.height / 2
    )
    await page.mouse.down()
    await page.mouse.move(
      textBounds!.x + textBounds!.width * 0.75,
      textBounds!.y + textBounds!.height / 2,
      { steps: 4 }
    )
    await page.mouse.up()
    const textMark = pdfPage.getByRole('button', { name: 'Highlight', exact: true })
    await expect(textMark).toBeVisible()
    const createdTextMarkBounds = await textMark.boundingBox()
    expect(createdTextMarkBounds).not.toBeNull()
    expect(Math.abs(createdTextMarkBounds!.x - selectedTextBounds!.x)).toBeLessThan(4)
    expect(Math.abs(createdTextMarkBounds!.y - selectedTextBounds!.y)).toBeLessThan(4)
    expect(Math.abs(createdTextMarkBounds!.width - selectedTextBounds!.width)).toBeLessThan(6)
    expect(Math.abs(createdTextMarkBounds!.height - selectedTextBounds!.height)).toBeLessThan(4)
    await highlightTool.click()
    await expect(textMark).toHaveCSS('pointer-events', 'auto')
    const textMarkBounds = await textMark.boundingBox()
    expect(textMarkBounds).not.toBeNull()
    await page.mouse.move(
      textMarkBounds!.x + textMarkBounds!.width * 0.25,
      textMarkBounds!.y + textMarkBounds!.height / 2
    )
    await page.mouse.down()
    await page.mouse.move(
      textMarkBounds!.x + textMarkBounds!.width * 0.75,
      textMarkBounds!.y + textMarkBounds!.height / 2
    )
    await page.mouse.up()
    await expect.poll(async () => (await textMark.boundingBox())?.x ?? 0)
      .toBeGreaterThan(textMarkBounds!.x + 2)
    await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() ?? ''))
      .toBe('')
    const eraserTool = annotationToolbar.getByRole('button', {
      name: 'Erase annotation',
      exact: true
    })
    await eraserTool.click()
    await textMark.click()
    await expect(textMark).toHaveCount(0)
    await eraserTool.click()

    await page.getByRole('button', { name: 'Toggle annotations panel' }).click()
    await page.getByRole('button', { name: 'Add text', exact: true }).click()
    await page.getByRole('button', { name: 'Increase font size' }).click()
    await pdfPage.click({ position: { x: 120, y: 210 } })
    const inlineText = pdfPage.getByRole('textbox', { name: 'Add text' })
    await expect(inlineText).toBeVisible()
    await expect(inlineText).toBeFocused()
    await page.getByRole('button', { name: 'Annotation color' }).nth(4).click()
    await expect(inlineText).toBeFocused()
    await expect.poll(() => inlineText.evaluate((element) =>
      window.getComputedStyle(element, '::placeholder').color
    )).toBe('rgb(235, 87, 87)')
    await inlineText.fill('Inline')
    const singleLineBounds = await inlineText.boundingBox()
    expect(singleLineBounds).not.toBeNull()
    await inlineText.fill('Inline PDF annotation\nSecond line\nThird line')
    await expect.poll(async () => (await inlineText.boundingBox())?.height ?? 0)
      .toBeGreaterThan(singleLineBounds!.height * 2)
    const annotationOverflow = await inlineText.evaluate((element) => ({
      horizontal: element.scrollWidth - element.clientWidth,
      vertical: element.scrollHeight - element.clientHeight
    }))
    expect(annotationOverflow.horizontal).toBeLessThanOrEqual(2)
    expect(annotationOverflow.vertical).toBeLessThanOrEqual(2)
    await inlineText.fill('Inline PDF annotation')
    await expect(inlineText).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
    await expect(inlineText).toHaveCSS('border-top-width', '0px')
    await expect(inlineText).toHaveCSS('font-size', '18.4px')
    await expect(inlineText).toHaveCSS('color', 'rgb(235, 87, 87)')
    await expect(pdfPage.locator('[data-selected-annotation]')).toHaveCount(0)
    await expect(page.getByRole('button', {
      name: 'Delete selected annotations (1)'
    })).toHaveCount(0)

    await expect.poll(() => page.evaluate(async (documentId) => {
      const api = (window as unknown as {
        api: {
          documents: {
            pdfAnnotations(id: string): Promise<Array<{
              kind: string
              text: string
              color: string
              fontSize?: number
              strokeWidth?: number
            }>>
          }
        }
      }).api
      const annotations = await api.documents.pdfAnnotations(documentId)
      return annotations.some((annotation) =>
        annotation.kind === 'ink' && annotation.strokeWidth === 3
      ) && annotations.some((annotation) =>
        annotation.kind === 'text' &&
        annotation.text === 'Inline PDF annotation' &&
        annotation.fontSize === 16 &&
        annotation.color === '#eb5757'
      )
    }, secondDocumentId)).toBe(true)

    const addTextTool = page.getByRole('button', { name: 'Add text', exact: true })
    await addTextTool.click()
    await expect(addTextTool).not.toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('[data-active-pdf-tool]')).toHaveText('Select annotations')
    const movableTextBounds = await inlineText.boundingBox()
    expect(movableTextBounds).not.toBeNull()
    await page.mouse.move(
      movableTextBounds!.x + movableTextBounds!.width / 2,
      movableTextBounds!.y + movableTextBounds!.height / 2
    )
    await page.mouse.down()
    await page.mouse.move(
      movableTextBounds!.x + movableTextBounds!.width / 2 + 24,
      movableTextBounds!.y + movableTextBounds!.height / 2 + 12,
      { steps: 5 }
    )
    await page.mouse.up()
    await expect.poll(async () => (await inlineText.boundingBox())?.x ?? 0)
      .toBeGreaterThan(movableTextBounds!.x + 12)
    const selectionBounds = await annotationInput.boundingBox()
    expect(selectionBounds).not.toBeNull()
    const persistedInkBounds = await ink.boundingBox()
    const persistedTextBounds = await inlineText.boundingBox()
    expect(persistedInkBounds).not.toBeNull()
    expect(persistedTextBounds).not.toBeNull()
    const selectionStart = {
      x: Math.max(
        selectionBounds!.x + 1,
        Math.min(persistedInkBounds!.x, persistedTextBounds!.x) - 10
      ),
      y: Math.max(
        selectionBounds!.y + 1,
        Math.min(persistedInkBounds!.y, persistedTextBounds!.y) - 10
      )
    }
    const selectionEnd = {
      x: Math.min(
        selectionBounds!.x + selectionBounds!.width - 1,
        Math.max(
          persistedInkBounds!.x + persistedInkBounds!.width,
          persistedTextBounds!.x + persistedTextBounds!.width
        ) + 10
      ),
      y: Math.min(
        selectionBounds!.y + selectionBounds!.height - 1,
        Math.max(
          persistedInkBounds!.y + persistedInkBounds!.height,
          persistedTextBounds!.y + persistedTextBounds!.height
        ) + 10
      )
    }
    await page.mouse.move(selectionStart.x, selectionStart.y)
    await page.mouse.down()
    await page.mouse.move(selectionEnd.x, selectionEnd.y, { steps: 6 })
    await expect(pdfPage.locator('[data-annotation-selection]')).toBeVisible()
    await page.mouse.up()
    const selectedAnnotations = pdfPage.locator('[data-selected-annotation]')
    await expect(selectedAnnotations).toHaveCount(2)
    await expect(selectedAnnotations.first()).toBeVisible()
    await expect(selectedAnnotations.first()).toHaveCSS('border-top-width', '2px')

    const deleteSelected = page.getByRole('button', {
      name: 'Delete selected annotations (2)'
    })
    await expect(deleteSelected).toBeVisible()
    await deleteSelected.click()
    await expect(selectedAnnotations).toHaveCount(0)
    await expect(pdfPage.locator('[data-annotation-kind="ink"]')).toHaveCount(0)
    await expect(pdfPage.getByRole('textbox', { name: 'Add text' })).toHaveCount(0)
    await expect(page.getByRole('status')).toContainText('Deleted 2 annotations')
    await page.getByRole('button', { name: 'Undo', exact: true }).click()
    await expect(pdfPage.locator('[data-annotation-kind="ink"]')).toHaveCount(1)
    await expect(pdfPage.getByRole('textbox', { name: 'Add text' })).toHaveCount(1)
    await expect(selectedAnnotations).toHaveCount(2)
    await expect.poll(() => page.evaluate(async (documentId) => {
      const api = (window as unknown as {
        api: {
          documents: {
            pdfAnnotations(id: string): Promise<unknown[]>
          }
        }
      }).api
      return (await api.documents.pdfAnnotations(documentId)).length
    }, secondDocumentId)).toBe(2)
    await page.getByRole('button', {
      name: 'Delete selected annotations (2)'
    }).click()
    await expect(selectedAnnotations).toHaveCount(0)
    await expect.poll(() => page.evaluate(async (documentId) => {
      const api = (window as unknown as {
        api: {
          documents: {
            pdfAnnotations(id: string): Promise<unknown[]>
          }
        }
      }).api
      return (await api.documents.pdfAnnotations(documentId)).length
    }, secondDocumentId)).toBe(0)

    await page.getByRole('button', { name: 'Add note', exact: true }).click()
    await expect(page.locator('[data-annotation-sidebar]')).toHaveCount(0)
    await pdfPage.click({ position: { x: 180, y: 120 } })
    await expect(page.locator('[data-annotation-sidebar]')).toHaveCount(0)
    await page.getByRole('button', { name: 'Toggle annotations panel' }).click()
    const noteComment = page.locator('[data-annotation-sidebar]')
      .getByPlaceholder('Add a comment…', { exact: true })
    await expect(noteComment).toBeFocused()
    await noteComment.fill('Follow up on this result')
    await expect.poll(() => page.evaluate(async (documentId) => {
      const api = (window as unknown as {
        api: {
          documents: {
            pdfAnnotations(id: string): Promise<Array<{ comment: string }>>
          }
        }
      }).api
      return (await api.documents.pdfAnnotations(documentId))[0]?.comment
    }, secondDocumentId)).toBe('Follow up on this result')
    await page.locator('[data-annotation-sidebar]')
      .getByRole('button', { name: 'Delete', exact: true })
      .click()
    await expect.poll(() => page.evaluate(async (documentId) => {
      const api = (window as unknown as {
        api: {
          documents: {
            pdfAnnotations(id: string): Promise<unknown[]>
          }
        }
      }).api
      return (await api.documents.pdfAnnotations(documentId)).length
    }, secondDocumentId)).toBe(0)

    await page.getByTestId('app-sidebar-layer')
      .getByRole('button', { name: 'Reader workspace', exact: true })
      .click()
    await expect(page.getByRole('button', { name: 'Add text' })).toBeHidden()
    await expect(
      page.getByTestId('app-workspace-panel').getByText('Reader workspace', { exact: true })
    ).toBeVisible()
    await expect(
      page.getByTestId('workspace-floating-actions').getByRole('button', { name: 'Add files' })
    ).toBeVisible()
    await expect(firstRow).toBeVisible()

    const workspaceTab = page.locator('[data-reader-tab-kind="workspace"]')
    await expect(workspaceTab).toHaveCount(1)
    await page.locator('[data-reader-tab-kind="pdf"]').first().getByRole('tab').evaluate(
      (element: HTMLButtonElement) => element.click()
    )
    await expect(page.locator('.pdf-reader-page')).toBeVisible()
    await workspaceTab.getByRole('button').last().evaluate(
      (element: HTMLButtonElement) => element.click()
    )
    await expect(workspaceTab).toHaveCount(0)

    await page.getByTestId('app-sidebar-layer')
      .getByRole('button', { name: 'Reader workspace', exact: true })
      .click()
    await expect(workspaceTab).toHaveCount(1)
    await expect(
      page.getByTestId('app-workspace-panel').getByText('Reader workspace', { exact: true })
    ).toBeVisible()
  })
})
