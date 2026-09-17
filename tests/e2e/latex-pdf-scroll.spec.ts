import { test, expect, _electron as electron } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import electronExecutable from 'electron'

const texBin = process.env.REFORA_TEX_BIN || '/Library/TeX/texbin'

test('reads a continuous PDF and keeps its location after sync, zoom, resize, and recompile', async () => {
  test.skip(!fs.existsSync(path.join(texBin, 'latexmk')), 'Set REFORA_TEX_BIN to a local TeX installation')
  test.setTimeout(120_000)
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'refora-pdf-scroll-'))
  fs.mkdirSync(path.join(folder, 'user'))
  fs.mkdirSync(path.join(folder, 'library'))
  fs.writeFileSync(path.join(folder, 'user/refora-prefs.json'), JSON.stringify({ libraryFolderPath: path.join(folder, 'library') }))
  const env = { ...process.env, REFORA_E2E_USER_DATA_DIR: path.join(folder, 'user'), REFORA_TEX_BIN: texBin } as Record<string, string>
  delete env.ELECTRON_RUN_AS_NODE
  const application = await electron.launch({ executablePath: String(electronExecutable), args: [path.resolve('tests/e2e/electron-main.mjs')], env })
  const content = '\\documentclass{article}\n\\begin{document}\n' + Array.from({ length: 12 }, (_, index) => `${index ? '\\newpage\n' : ''}\\section{Page ${index + 1}}\nParagraph ${index + 1} for continuous PDF reading.\n`).join('') + '\\end{document}\n'
  try {
    const page = await application.firstWindow()
    await page.evaluate(async (source) => {
      const ws = await window.api.workspaces.create('Continuous PDF')
      const project = (await window.api.latex.execute(ws.id, { action: 'create', title: 'Twelve pages' })).project!
      const file = (await window.api.latex.execute(ws.id, { action: 'read', projectId: project.id, path: 'main.tex' })).file!
      await window.api.latex.execute(ws.id, { action: 'write', projectId: project.id, path: file.path, expectedHash: file.hash, content: source })
    }, content)
    await page.reload()
    await page.getByRole('button', { name: 'Continuous PDF', exact: true }).click()
    await page.getByRole('button', { name: 'Twelve pages', exact: true }).click()
    await page.getByRole('button', { name: 'Enter fullscreen', exact: true }).click()
    await page.getByRole('button', { name: 'Source and PDF', exact: true }).click()
    await page.getByRole('button', { name: 'Compile ⌘↵', exact: true }).click()
    const forward = page.getByRole('button', { name: 'Go to code location in PDF', exact: true })
    await expect(forward).toBeEnabled({ timeout: 30_000 })
    const counter = page.getByRole('textbox', { name: 'Page number', exact: true })
    await expect(counter).toHaveValue('1')
    const toolbar = page.locator('.latex-pdf [data-pdf-reader-toolbar]')
    await expect(toolbar.getByRole('button', { name: 'Document navigation', exact: true })).toHaveCount(0)
    await expect(toolbar.getByRole('button', { name: 'Search in PDF', exact: true })).toHaveCount(0)
    await expect(toolbar.getByRole('button', { name: 'Back to previous position', exact: true })).toHaveCount(0)
    await application.evaluate(({ Menu }) => {
      const state = globalThis as typeof globalThis & { previewMenus: string[][] }
      state.previewMenus = []
      Menu.prototype.popup = function(options) {
        state.previewMenus.push(this.items.map(item => item.label))
        options?.callback?.()
      }
    })
    const pdfText = page.locator('.latex-pdf .textLayer span').first()
    await expect(pdfText).toBeVisible()
    await pdfText.evaluate(element => {
      const range = document.createRange()
      range.selectNodeContents(element)
      window.getSelection()?.removeAllRanges()
      window.getSelection()?.addRange(range)
    })
    await pdfText.click({ button: 'right' })
    await expect.poll(() => application.evaluate(() => (globalThis as typeof globalThis & { previewMenus: string[][] }).previewMenus)).toEqual([['Copy text']])
    await page.evaluate(() => window.getSelection()?.removeAllRanges())
    await page.locator('.latex-pdf .pdf-reader-page').first().click({ button: 'right', position: { x: 10, y: 10 } })
    expect(await application.evaluate(() => (globalThis as typeof globalThis & { previewMenus: string[][] }).previewMenus)).toEqual([['Copy text']])
    const scroll = page.getByLabel('PDF pages', { exact: true })
    await expect.poll(() => scroll.evaluate(element => element.scrollHeight / element.clientHeight)).toBeGreaterThan(5)
    await forward.click()
    await expect(page.locator('[data-pdf-location-highlight]')).toBeVisible()
    await scroll.hover()
    const scrollFinished = scroll.evaluate(element => new Promise<void>(resolve => element.addEventListener('scrollend', () => resolve(), { once: true })))
    await page.mouse.wheel(0, 900)
    await scrollFinished
    await expect.poll(() => scroll.evaluate(element => element.scrollTop)).toBeGreaterThan(300)
    await expect.poll(async () => Number(await counter.inputValue())).toBeGreaterThan(1)
    await counter.fill('8')
    await counter.press('Enter')
    await expect(counter).toHaveValue('8')
    await expect(page.locator('[data-page-number="8"] canvas:visible').first()).toBeVisible()
    expect(await page.locator('.latex-pdf [data-virtual-page]').count()).toBeLessThan(12)
    await page.getByRole('textbox', { name: 'Zoom percentage', exact: true }).fill('150')
    await page.getByRole('textbox', { name: 'Zoom percentage', exact: true }).press('Enter')
    await expect(counter).toHaveValue('8')
    const divider = page.locator('.latex-sync-divider')
    await expect(divider.getByRole('button', { name: 'Go to code location in PDF', exact: true })).toBeVisible()
    await expect(divider.getByRole('button', { name: 'Go to PDF location in code', exact: true })).toBeVisible()
    const edge = await divider.getByRole('separator').boundingBox()
    if (!edge) throw new Error('Missing split divider')
    expect(edge.width).toBeLessThanOrEqual(2)
    const controls = await divider.locator('.latex-sync-controls').boundingBox()
    if (!controls) throw new Error('Missing floating controls')
    expect(controls.width).toBeGreaterThan(edge.width)
    expect(controls.x).toBeLessThan(edge.x)
    await page.mouse.move(edge.x, edge.y + 20)
    await page.mouse.down()
    await page.mouse.move(edge.x + 30, edge.y + 20)
    await page.mouse.up()
    await expect(counter).toHaveValue('8')
    await page.getByRole('button', { name: 'Source', exact: true }).click()
    await expect(divider).toHaveCount(0)
    await page.getByLabel('LaTeX source', { exact: true }).fill(content.replace('Paragraph 8', 'Changed paragraph 8'))
    await page.getByRole('button', { name: 'LaTeX PDF preview', exact: true }).click()
    await expect(divider).toHaveCount(0)
    await expect(counter).toHaveValue('8')
    const readingOffset = () => scroll.evaluate(element => {
      const row = element.querySelector('[data-page-number="8"]')
      return row ? row.getBoundingClientRect().top - element.getBoundingClientRect().top : Number.POSITIVE_INFINITY
    })
    await expect(page.locator('.latex-pdf [data-page-number="8"]')).toBeInViewport()
    const before = await readingOffset()
    await page.getByRole('button', { name: 'Compile ⌘↵', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Compile ⌘↵', exact: true })).toBeEnabled({ timeout: 30_000 })
    await expect(page.locator('.latex-pdf [data-pdf-page-virtualizer]')).toBeVisible()
    await expect(counter).toHaveValue('8')
    await expect.poll(async () => Math.abs(await readingOffset() - before)).toBeLessThan(5)
    await scroll.focus()
    await page.keyboard.press('Meta+0')
    await expect(page.getByRole('button', { name: 'Fit page width', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await expect(counter).toHaveValue('8')
    await page.getByRole('button', { name: 'Source and PDF', exact: true }).click()
    await expect(divider).toBeVisible()
    await expect(page.locator('.latex-pdf [data-page-number="8"]')).toBeInViewport()
    await page.getByRole('button', { name: 'Exit fullscreen', exact: true }).click()
    await expect(divider).toHaveCount(0)
  } finally {
    await application.close()
    fs.rmSync(folder, { recursive: true, force: true })
  }
})
