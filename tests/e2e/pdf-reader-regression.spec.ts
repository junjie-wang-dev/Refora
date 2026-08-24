import { test, expect, _electron as electron } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import electronExe from 'electron'
import { authorizeFilePath } from './path-capability'
import { MAX_PDF_RANGE_BYTES } from '../../src/shared/pdf-range'

const testMain = path.resolve(__dirname, 'electron-main.mjs')

function pdfStream(content: string): string {
  return `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`
}

function createRegressionPdf(filePath: string): void {
  const padding = '% range-padding abcdefghijklmnopqrstuvwxyz 0123456789\n'.repeat(50000)
  const pageOne = [
    'BT',
    '/F1 18 Tf',
    '72 720 Td',
    '(Refora searchable phrase page one) Tj',
    '0 -70 Td',
    '(Internal link to page two) Tj',
    '0 -35 Td',
    '(External link example) Tj',
    'ET'
  ].join('\n')
  const pageTwo = [
    'BT',
    '/F1 18 Tf',
    '72 828 Td',
    '(Refora searchable phrase page two) Tj',
    '0 -70 Td',
    '(Back to page one) Tj',
    'ET',
    padding
  ].join('\n')
  const pageThree = [
    'BT',
    '/F1 18 Tf',
    '72 720 Td',
    '(Refora searchable phrase page three) Tj',
    'ET'
  ].join('\n')
  const objects = new Map<number, string>([
    [1, '<< /Type /Catalog /Pages 2 0 R >>'],
    [2, '<< /Type /Pages /Kids [3 0 R 4 0 R 5 0 R] /Count 3 >>'],
    [3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 6 0 R >> >> /Contents 7 0 R /Annots [10 0 R 11 0 R] >>'],
    [4, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 900] /Resources << /Font << /F1 6 0 R >> >> /Contents 8 0 R /Annots [12 0 R] >>'],
    [5, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 6 0 R >> >> /Contents 9 0 R >>'],
    [6, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'],
    [7, pdfStream(pageOne)],
    [8, pdfStream(pageTwo)],
    [9, pdfStream(pageThree)],
    [10, '<< /Type /Annot /Subtype /Link /Rect [70 642 290 668] /Border [0 0 1] /C [0 0 1] /Dest [4 0 R /Fit] >>'],
    [11, '<< /Type /Annot /Subtype /Link /Rect [70 607 255 633] /Border [0 0 1] /C [0 0 1] /A << /S /URI /URI (https://example.com/refora-e2e) >> >>'],
    [12, '<< /Type /Annot /Subtype /Link /Rect [70 750 240 776] /Border [0 0 1] /C [0 0 1] /Dest [3 0 R /Fit] >>']
  ])
  let output = '%PDF-1.7\n%\xe2\xe3\xcf\xd3\n'
  const offsets = new Map<number, number>()
  for (const [number, body] of objects) {
    offsets.set(number, Buffer.byteLength(output, 'latin1'))
    output += `${number} 0 obj\n${body}\nendobj\n`
  }
  const xrefOffset = Buffer.byteLength(output, 'latin1')
  output += `xref\n0 ${objects.size + 1}\n`
  output += '0000000000 65535 f \n'
  for (let number = 1; number <= objects.size; number += 1) {
    output += `${String(offsets.get(number)).padStart(10, '0')} 00000 n \n`
  }
  output += `trailer\n<< /Size ${objects.size + 1} /Root 1 0 R >>\n`
  output += `startxref\n${xrefOffset}\n%%EOF\n`
  fs.writeFileSync(filePath, Buffer.from(output, 'latin1'))
}

test.describe('PDF reader regressions', () => {
  let electronApp: Awaited<ReturnType<typeof electron.launch>>
  let page: Awaited<ReturnType<Awaited<ReturnType<typeof electron.launch>>['firstWindow']>>
  let userDataFolder: string
  let libraryFolder: string
  let sourceFolder: string
  let documentId: string

  test.beforeAll(async () => {
    userDataFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'refora-pdf-regression-user-'))
    libraryFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'refora-pdf-regression-library-'))
    sourceFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'refora-pdf-regression-source-'))
    fs.writeFileSync(
      path.join(userDataFolder, 'refora-prefs.json'),
      JSON.stringify({ libraryFolderPath: libraryFolder })
    )
    const fixturePath = path.join(sourceFolder, 'reader-regression.pdf')
    createRegressionPdf(fixturePath)
    expect(fs.statSync(fixturePath).size).toBeGreaterThan(MAX_PDF_RANGE_BYTES * 2)
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
    const authorizedPath = await authorizeFilePath(page, fixturePath)
    const documents = await page.evaluate(async (pdfPath) => {
      const api = (window as unknown as {
        api: {
          import: { addFiles(paths: string[]): Promise<unknown> }
          settings: { set(key: string, value: unknown): Promise<void> }
          documents: {
            list(filter: { mode: 'all' }): Promise<Array<{ id: string; fileName: string }>>
          }
        }
      }).api
      await api.import.addFiles([pdfPath])
      await api.settings.set('pdfOpenMode', 'builtin')
      return api.documents.list({ mode: 'all' })
    }, authorizedPath)
    documentId = documents.find((document) =>
      document.fileName === 'reader-regression.pdf'
    )?.id ?? ''
    await page.reload()
    await page.waitForLoadState('domcontentloaded')
  })

  test.afterAll(async () => {
    await electronApp?.close()
    fs.rmSync(userDataFolder, { recursive: true, force: true })
    fs.rmSync(libraryFolder, { recursive: true, force: true })
    fs.rmSync(sourceFolder, { recursive: true, force: true })
  })

  test('loads ranged pages, searches, follows links, and keeps a frame during cross-page zoom', async ({ browserName: _browserName }, testInfo) => {
    const row = page.locator(`[data-document-id="${documentId}"]`)
    await expect(row).toBeVisible()
    await row.getByRole('button', { name: 'Open' }).click()
    const pageInput = page.getByRole('textbox', { name: 'Page number' })
    await expect(page.getByText('/ 3', { exact: true })).toBeVisible()

    for (const pageNumber of [1, 2, 3]) {
      await pageInput.fill(String(pageNumber))
      await pageInput.press('Enter')
      await expect(pageInput).toHaveValue(String(pageNumber))
      const pdfPage = page.locator(`[data-page-number="${pageNumber}"]`)
      await expect(pdfPage).toBeVisible()
      await expect.poll(() => pdfPage.locator('canvas').evaluateAll((canvases) =>
        canvases.some((canvas) => {
          const element = canvas as HTMLCanvasElement
          return getComputedStyle(element).visibility !== 'hidden' &&
            element.width > 1 && element.height > 1
        })
      )).toBe(true)
    }
    await expect(page.getByRole('alert')).toHaveCount(0)

    await pageInput.fill('1')
    await pageInput.press('Enter')
    const nativeLinks = page.locator('[data-page-number="1"] .annotationLayer a')
    await expect(nativeLinks).toHaveCount(2)
    await expect(page.locator(
      '[data-page-number="1"] .annotationLayer a[href="https://example.com/refora-e2e"]'
    ))
      .toHaveAttribute('target', '_blank')
    await page.locator('[data-page-number="1"] .annotationLayer a[href="#"]').click()
    await expect(pageInput).toHaveValue('2')

    const searchInput = page.getByPlaceholder('Search in PDF', { exact: true })
    if (!await searchInput.isVisible()) {
      await page.getByRole('button', { name: 'Search in PDF', exact: true }).click()
    }
    await searchInput.fill('searchable phrase')
    await expect(page.getByText('1/3', { exact: true })).toBeVisible()
    await expect(page.locator('.textLayer .highlight.selected')).toHaveCount(1)
    await searchInput.press('Enter')
    await expect(page.getByText('2/3', { exact: true })).toBeVisible()
    await expect(page.locator('[data-page-number="2"] .textLayer .highlight.selected'))
      .toBeVisible()
    await searchInput.press('Enter')
    await expect(page.getByText('3/3', { exact: true })).toBeVisible()
    await expect(page.locator('[data-page-number="3"] .textLayer .highlight.selected'))
      .toBeVisible()
    await searchInput.press('Enter')
    await expect(page.getByText('1/3', { exact: true })).toBeVisible()
    await expect(page.locator('[data-page-number="1"] .textLayer .highlight.selected'))
      .toBeVisible()
    const clearSearch = page.getByRole('button', { name: 'Clear search' })
    await expect(clearSearch).toBeVisible()
    const searchBounds = await searchInput.boundingBox()
    const clearBounds = await clearSearch.boundingBox()
    expect(searchBounds).not.toBeNull()
    expect(clearBounds).not.toBeNull()
    expect(clearBounds!.x).toBeGreaterThan(searchBounds!.x)
    expect(clearBounds!.x + clearBounds!.width).toBeLessThanOrEqual(
      searchBounds!.x + searchBounds!.width
    )
    await clearSearch.click()
    await expect(searchInput).toHaveValue('')
    await expect(clearSearch).toHaveCount(0)
    await expect(page.locator('.textLayer .highlight')).toHaveCount(0)

    const zoomInput = page.getByRole('textbox', { name: 'Zoom percentage' })
    await zoomInput.fill('137.5')
    await zoomInput.press('Enter')
    await expect(zoomInput).toHaveValue('137.5')
    const scroller = page.locator('[data-pdf-page-virtualizer]').locator('..')
    const scrollerBounds = await scroller.boundingBox()
    expect(scrollerBounds).not.toBeNull()
    await scroller.dispatchEvent('wheel', {
      ctrlKey: true,
      deltaY: -6,
      clientX: scrollerBounds!.x + scrollerBounds!.width / 2,
      clientY: scrollerBounds!.y + scrollerBounds!.height / 2
    })
    await expect.poll(async () => Number(await zoomInput.inputValue())).toBeGreaterThan(137.5)

    await pageInput.fill('2')
    await pageInput.press('Enter')
    await expect(page.locator('[data-page-number="2"]')).toBeVisible()
    const zoomContinuity = await page.evaluate(async () => {
      const root = document.querySelector<HTMLElement>('[data-pdf-page-virtualizer]')?.parentElement
      const anchoredPage = root?.querySelector<HTMLElement>('[data-page-number="2"]')
      if (!root || !anchoredPage) return { drifts: [Number.POSITIVE_INFINITY] }
      const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      const rootBounds = root.getBoundingClientRect()
      const initialBounds = anchoredPage.getBoundingClientRect()
      root.scrollTop += initialBounds.top - rootBounds.top - root.clientHeight * 0.45
      await frame()
      await frame()
      const positionedBounds = anchoredPage.getBoundingClientRect()
      const clientX = positionedBounds.left + positionedBounds.width / 2
      const clientY = positionedBounds.top + positionedBounds.height * 0.08
      const normalizedX = (clientX - positionedBounds.left) / positionedBounds.width
      const normalizedY = (clientY - positionedBounds.top) / positionedBounds.height
      const drifts: number[] = []
      for (let index = 0; index < 16; index += 1) {
        root.dispatchEvent(new WheelEvent('wheel', {
          bubbles: true,
          cancelable: true,
          ctrlKey: true,
          deltaY: index < 8 ? -3 : 3,
          clientX,
          clientY
        }))
        await frame()
        const nextPage = root.querySelector<HTMLElement>('[data-page-number="2"]')
        const nextBounds = nextPage?.getBoundingClientRect()
        drifts.push(nextBounds
          ? Math.hypot(
              nextBounds.left + nextBounds.width * normalizedX - clientX,
              nextBounds.top + nextBounds.height * normalizedY - clientY
            )
          : Number.POSITIVE_INFINITY)
      }
      await frame()
      await frame()
      return { drifts }
    })
    expect(Math.max(...zoomContinuity.drifts)).toBeLessThan(2)
    const zoomGaps = await page.evaluate(async () => {
      const root = document.querySelector<HTMLElement>('[data-pdf-page-virtualizer]')?.parentElement
      if (!root) return ['missing-scroller']
      const gaps: string[] = []
      const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      for (let index = 0; index < 12; index += 1) {
        root.dispatchEvent(new WheelEvent('wheel', {
          bubbles: true,
          cancelable: true,
          ctrlKey: true,
          deltaY: index < 6 ? -4 : 4,
          clientX: root.getBoundingClientRect().left + root.clientWidth / 2,
          clientY: root.getBoundingClientRect().top + root.clientHeight / 2
        }))
        await frame()
        await frame()
        const rootBounds = root.getBoundingClientRect()
        const visiblePages = Array.from(root.querySelectorAll<HTMLElement>('[data-page-number]'))
          .filter((pdfPage) => {
            const bounds = pdfPage.getBoundingClientRect()
            return bounds.bottom > rootBounds.top && bounds.top < rootBounds.bottom
          })
        for (const pdfPage of visiblePages) {
          const committedCanvas = Array.from(pdfPage.querySelectorAll('canvas')).some((canvas) =>
            getComputedStyle(canvas).visibility !== 'hidden' &&
            canvas.width > 1 && canvas.height > 1
          )
          if (!committedCanvas) {
            const canvases = Array.from(pdfPage.querySelectorAll('canvas')).map((canvas) =>
              `${canvas.width}x${canvas.height}:${getComputedStyle(canvas).visibility}`
            )
            gaps.push(
              `${index}:${pdfPage.dataset.pageNumber ?? 'unknown'}:${canvases.join(',')}`
            )
          }
        }
      }
      return gaps
    })
    expect.soft(zoomGaps).toEqual([])

    await page.waitForTimeout(200)
    const canvasPixels = await page.evaluate(() => {
      const root = document.querySelector<HTMLElement>('[data-pdf-page-virtualizer]')?.parentElement
      if (!root) return []
      const rootBounds = root.getBoundingClientRect()
      return Array.from(root.querySelectorAll<HTMLElement>('[data-page-number]')).flatMap(
        (pdfPage) => {
          const bounds = pdfPage.getBoundingClientRect()
          if (bounds.bottom <= rootBounds.top || bounds.top >= rootBounds.bottom) return []
          const canvas = Array.from(pdfPage.querySelectorAll('canvas')).find((candidate) =>
            getComputedStyle(candidate).visibility !== 'hidden' &&
            candidate.width > 1 && candidate.height > 1
          )
          const context = canvas?.getContext('2d', { willReadFrequently: true })
          if (!canvas || !context) return []
          let black = 0
          let transparent = 0
          let total = 0
          for (let row = 0; row < 12; row += 1) {
            for (let column = 0; column < 12; column += 1) {
              const x = Math.min(canvas.width - 1, Math.floor(canvas.width * (column + 0.5) / 12))
              const y = Math.min(canvas.height - 1, Math.floor(canvas.height * (row + 0.5) / 12))
              const pixel = context.getImageData(x, y, 1, 1).data
              if (pixel[0] < 8 && pixel[1] < 8 && pixel[2] < 8 && pixel[3] > 240) black += 1
              if (pixel[3] < 16) transparent += 1
              total += 1
            }
          }
          return [{
            page: pdfPage.dataset.pageNumber,
            blackRatio: black / total,
            transparentRatio: transparent / total
          }]
        }
      )
    })
    expect(canvasPixels.length).toBeGreaterThan(0)
    for (const sample of canvasPixels) {
      expect(sample.blackRatio).toBeLessThan(0.8)
      expect(sample.transparentRatio).toBeLessThan(0.2)
    }
    await testInfo.attach('cross-page-zoom', {
      body: await scroller.screenshot(),
      contentType: 'image/png'
    })
  })

})
