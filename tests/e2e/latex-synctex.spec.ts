import { test, expect, _electron as electron } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import electronExecutable from 'electron'

const texBin = process.env.REFORA_TEX_BIN || '/Library/TeX/texbin'

test('navigates between included source and PDF across pages and zoom levels', async () => {
  test.skip(!fs.existsSync(path.join(texBin, 'latexmk')), 'Set REFORA_TEX_BIN to a local TeX installation')
  test.setTimeout(120_000)
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'refora-synctex-'))
  const userData = path.join(folder, 'user')
  const library = path.join(folder, 'library')
  fs.mkdirSync(userData)
  fs.mkdirSync(library)
  fs.writeFileSync(path.join(userData, 'refora-prefs.json'), JSON.stringify({ libraryFolderPath: library }))
  const env = { ...process.env, REFORA_E2E_USER_DATA_DIR: userData, REFORA_TEX_BIN: texBin } as Record<string, string>
  delete env.ELECTRON_RUN_AS_NODE
  const application = await electron.launch({ executablePath: String(electronExecutable), args: [path.resolve('tests/e2e/electron-main.mjs')], env })
  try {
    const page = await application.firstWindow()
    await page.evaluate(async () => {
      const ws = await window.api.workspaces.create('SyncTeX test')
      const project = (await window.api.latex.execute(ws.id, { action: 'create', title: 'Two page project' })).project!
      const file = (await window.api.latex.execute(ws.id, { action: 'read', projectId: project.id, path: 'main.tex' })).file!
      await window.api.latex.execute(ws.id, { action: 'write', projectId: project.id, path: 'main.tex', expectedHash: file.hash, content: '\\documentclass{article}\n\\begin{document}\n\\section{First page}\nThis is the first page.\n\\input{sections/second}\n\\end{document}\n' })
      await window.api.latex.execute(ws.id, { action: 'write', projectId: project.id, path: 'sections/second.tex', expectedHash: '', content: '\\newpage\n\\section{Second page}\nA distinct sentence in an included file.\n' })
    })
    await page.reload()
    await page.getByRole('button', { name: 'SyncTeX test', exact: true }).click()
    await page.getByRole('button', { name: 'Two page project', exact: true }).click()
    const source = page.getByLabel('LaTeX source', { exact: true })
    await expect(source).toBeVisible()
    await page.getByRole('button', { name: 'Enter fullscreen', exact: true }).click()
    await page.getByRole('button', { name: 'Source and PDF', exact: true }).click()
    const forward = page.getByRole('button', { name: 'Go to code location in PDF', exact: true })
    await expect(forward).toBeDisabled()
    await page.getByRole('button', { name: 'Compile ⌘↵', exact: true }).click()
    await expect(forward).toBeEnabled({ timeout: 30_000 })
    await page.getByRole('button', { name: 'Source', exact: true }).click()
    const fileMenu = page.getByRole('button', { name: 'Current file: main.tex', exact: true })
    if (await fileMenu.getAttribute('aria-expanded') !== 'true') await fileMenu.click()
    await page.getByTitle('sections/second.tex', { exact: true }).click()
    await expect(source).toContainText('A distinct sentence')
    await source.evaluate((element: HTMLTextAreaElement) => {
      const start = element.value.indexOf('A distinct')
      element.focus()
      element.setSelectionRange(start, start)
      element.dispatchEvent(new Event('select', { bubbles: true }))
    })
    await source.press('ArrowRight')
    await expect(page.locator('.latex-cursor-position')).toHaveText('Ln 3, Col 2')
    await expect(forward).toHaveCount(0)
    await page.getByRole('button', { name: 'Source and PDF', exact: true }).click()
    await forward.click()
    const highlight = page.locator('[data-pdf-location-highlight]')
    await expect(highlight).toBeVisible()
    await expect(page.getByRole('textbox', { name: 'Page number', exact: true })).toHaveValue('2')
    await page.getByRole('button', { name: 'Zoom in', exact: true }).click()
    const bounds = await highlight.boundingBox()
    if (!bounds) throw new Error('Source location was not highlighted')
    await page.mouse.dblclick(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
    await expect(source).toBeVisible()
    await expect(source).toBeFocused()
    await expect.poll(() => source.evaluate((element: HTMLTextAreaElement) => element.value.slice(element.selectionStart, element.selectionEnd))).toBe('A distinct sentence in an included file.')
    await forward.click()
    await expect(highlight).toBeVisible()
    const selected = await highlight.boundingBox()
    if (!selected) throw new Error('PDF target is missing')
    await page.mouse.click(selected.x + selected.width / 2, selected.y + selected.height / 2)
    await page.getByRole('button', { name: 'Go to PDF location in code', exact: true }).click()
    await expect(source).toBeFocused()
    await source.fill('\\newpage\n\\section{Changed section}\nUpdated source.\n')
    await expect(forward).toBeDisabled()
    await page.getByRole('button', { name: 'LaTeX PDF preview', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Go to PDF location in code', exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: 'Compile ⌘↵', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Compile ⌘↵', exact: true })).toBeEnabled({ timeout: 30_000 })
    await page.getByRole('button', { name: 'Source and PDF', exact: true }).click()
    await expect(forward).toBeEnabled()
  } finally {
    await application.close()
    fs.rmSync(folder, { recursive: true, force: true })
  }
})
