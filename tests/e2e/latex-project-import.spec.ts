import { test, expect, _electron as electron } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import electronExecutable from 'electron'

test('imports a complete LaTeX folder as one workspace project with its template', async () => {
  test.setTimeout(90_000)
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'refora-project-import-'))
  const userData = path.join(folder, 'user')
  const library = path.join(folder, 'library')
  const source = path.join(folder, 'IEEE Conference Paper')
  fs.mkdirSync(userData)
  fs.mkdirSync(library)
  fs.mkdirSync(path.join(source, 'sections'), { recursive: true })
  fs.writeFileSync(path.join(userData, 'refora-prefs.json'), JSON.stringify({ libraryFolderPath: library }))
  fs.writeFileSync(path.join(source, 'main.tex'), '\\documentclass[conference]{IEEEtran}\n\\begin{document}\n\\input{sections/introduction}\n\\end{document}\n')
  fs.writeFileSync(path.join(source, 'sections/introduction.tex'), 'Imported project introduction.')
  fs.writeFileSync(path.join(source, 'references.bib'), '@article{paper,title={A paper}}')
  fs.writeFileSync(path.join(source, 'IEEEtran.cls'), '\\ProvidesClass{IEEEtran}\n\\LoadClass{article}')
  const env = { ...process.env, REFORA_E2E_USER_DATA_DIR: userData } as Record<string, string>
  delete env.ELECTRON_RUN_AS_NODE
  const application = await electron.launch({ executablePath: String(electronExecutable), args: [path.resolve('tests/e2e/electron-main.mjs')], env })
  try {
    const page = await application.firstWindow()
    const workspace = await page.evaluate(() => window.api.workspaces.create('Project import test'))
    await application.evaluate(({ dialog }, selectedPath) => {
      dialog.showOpenDialog = async (...args: unknown[]) => {
        const options = args.at(-1) as { properties?: string[] }
        if (!options.properties?.includes('openDirectory')) throw new Error('Expected a project folder picker')
        return { canceled: false, filePaths: [selectedPath] }
      }
    }, source)
    await page.reload()
    await page.getByRole('button', { name: 'Project import test', exact: true }).click()
    await page.getByRole('button', { name: 'Add LaTeX project', exact: true }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Import folder', exact: true }).click()
    const card = page.locator('[data-card-kind="latex"]')
    await expect(card).toHaveCount(1)
    await expect(card.getByRole('button', { name: 'IEEE Conference Paper', exact: true })).toBeVisible()
    await expect(card.getByText('Template: IEEE Conference', { exact: true })).toBeInViewport({ ratio: 1 })
    await expect(card).toContainText('4 files')
    await expect(card).not.toContainText('main.tex')
    const project = (await page.evaluate(id => window.api.latex.execute(id, { action: 'list' }), workspace.id)).projects![0]
    expect(project.files).toEqual(['IEEEtran.cls', 'main.tex', 'references.bib', 'sections/introduction.tex'])
    expect(project.template).toBe('IEEE Conference')
    await card.getByRole('button', { name: 'IEEE Conference Paper', exact: true }).click()
    await expect(page.getByRole('tab', { name: 'IEEE Conference Paper', exact: true })).toBeVisible()
    await expect(page.getByLabel('LaTeX source', { exact: true })).toContainText('IEEEtran')
    await page.getByRole('button', { name: 'Current file: main.tex', exact: true }).click()
    await page.getByTitle('sections/introduction.tex', { exact: true }).click()
    await expect(page.getByLabel('LaTeX source', { exact: true })).toHaveValue('Imported project introduction.')
    await page.reload()
    await page.getByRole('button', { name: 'Project import test', exact: true }).click()
    await expect(card).toHaveCount(1)
    await expect(card).toContainText('Template: IEEE Conference')
    expect((await page.evaluate(id => window.api.workspaceItems.list(id), workspace.id)).filter(item => item.kind === 'latex')).toHaveLength(1)
  } finally {
    await application.close()
    fs.rmSync(folder, { recursive: true, force: true })
  }
})
