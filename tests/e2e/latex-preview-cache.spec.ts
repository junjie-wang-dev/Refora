import { test, expect, _electron as electron } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import electronExecutable from 'electron'

const texBin = process.env.REFORA_TEX_BIN || '/Library/TeX/texbin'

test('restores the compiled PDF after restarting and preserves it after compilation errors', async () => {
  test.skip(!fs.existsSync(path.join(texBin, 'latexmk')), 'Requires local TeX')
  test.setTimeout(150_000)
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'refora-preview-cache-'))
  fs.mkdirSync(path.join(folder, 'user'))
  fs.mkdirSync(path.join(folder, 'library'))
  fs.writeFileSync(path.join(folder, 'user/refora-prefs.json'), JSON.stringify({ libraryFolderPath: path.join(folder, 'library') }))
  const env = { ...process.env, REFORA_E2E_USER_DATA_DIR: path.join(folder, 'user'), REFORA_TEX_BIN: texBin } as Record<string, string>
  delete env.ELECTRON_RUN_AS_NODE
  const launch = () => electron.launch({ executablePath: String(electronExecutable), args: [path.resolve('tests/e2e/electron-main.mjs')], env })
  let application = await launch()
  try {
    let page = await application.firstWindow()
    const content = '\\documentclass{article}\n\\begin{document}\n\\section{Cached preview}\nThis PDF survives reopening the project.\n\\newpage\nThe second page stays available too.\n\\end{document}\n'
    const fixture = await page.evaluate(async (content) => {
      const ws = await window.api.workspaces.create('PDF cache test')
      const project = (await window.api.latex.execute(ws.id, { action: 'create', title: 'Cached paper' })).project!
      const file = (await window.api.latex.execute(ws.id, { action: 'read', projectId: project.id, path: 'main.tex' })).file!
      await window.api.latex.execute(ws.id, { action: 'write', projectId: project.id, path: file.path, expectedHash: file.hash, content })
      return { workspaceId: ws.id, projectId: project.id }
    }, content)
    const open = async () => {
      await page.getByRole('button', { name: 'PDF cache test', exact: true }).click()
      await page.getByRole('button', { name: 'Cached paper', exact: true }).click()
      await page.getByRole('button', { name: 'Enter fullscreen', exact: true }).click()
      await page.getByRole('button', { name: 'Source and PDF', exact: true }).click()
    }
    const preview = () => page.evaluate(async ({ workspaceId, projectId }) => (await window.api.latex.execute(workspaceId, { action: 'preview', projectId })).compilation!, fixture)
    await page.reload()
    await open()
    await page.getByRole('button', { name: 'Compile ⌘↵', exact: true }).click()
    await expect(page.locator('.latex-pdf canvas:visible').first()).toBeVisible({ timeout: 60_000 })
    const first = await preview()
    expect(first.stale).toBe(false)
    expect(first.synctex?.boxes.length).toBeGreaterThan(0)
    await application.close()
    application = await launch()
    page = await application.firstWindow()
    await open()
    await expect(page.locator('.latex-pdf canvas:visible').first()).toBeVisible()
    expect((await preview()).builtAt).toBe(first.builtAt)
    await expect(page.getByRole('button', { name: 'Go to code location in PDF', exact: true })).toBeEnabled()
    await page.getByRole('textbox', { name: 'LaTeX source', exact: true }).fill(content.replace('This PDF', '\\undefinedCacheCommand This PDF'))
    await page.getByRole('button', { name: 'Compile ⌘↵', exact: true }).click()
    await expect(page.locator('.latex-workspace [role="alert"]')).toBeVisible({ timeout: 60_000 })
    await expect(page.locator('.latex-pdf canvas:visible').first()).toBeVisible()
    expect((await preview()).builtAt).toBe(first.builtAt)
    await page.reload()
    await open()
    await expect(page.locator('.latex-pdf canvas:visible').first()).toBeVisible()
    await expect(page.locator('.latex-preview-notice')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Go to code location in PDF', exact: true })).toBeDisabled()
    expect((await preview()).stale).toBe(true)
    await page.screenshot({ path: path.resolve('.tmp/latex-cached-preview.png') })
    await page.getByRole('textbox', { name: 'LaTeX source', exact: true }).fill(content.replace('Cached preview', 'Updated cached preview'))
    await page.getByRole('button', { name: 'Compile ⌘↵', exact: true }).click()
    await expect(page.locator('.latex-preview-notice')).toHaveCount(0, { timeout: 60_000 })
    const latest = await preview()
    expect(latest.builtAt).not.toBe(first.builtAt)
    expect(latest.stale).toBe(false)
    expect(latest.pdfBase64).not.toBe(first.pdfBase64)
  } finally {
    await application.close()
    fs.rmSync(folder, { recursive: true, force: true })
  }
})
