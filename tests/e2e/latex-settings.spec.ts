import { expect, test, _electron as electron } from '@playwright/test'
import electronExe from 'electron'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const testMain = path.resolve(__dirname, 'electron-main.mjs')
const tectonicPath = process.env.REFORA_TECTONIC_PATH ?? ''

test('selects Tectonic, compiles, and resizes the source preview split', async () => {
  test.setTimeout(180_000)
  test.skip(!tectonicPath || !fs.existsSync(tectonicPath), 'Set REFORA_TECTONIC_PATH to the Tectonic executable')
  const userDataFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'refora-tectonic-user-'))
  const libraryFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'refora-tectonic-library-'))
  fs.writeFileSync(
    path.join(userDataFolder, 'refora-prefs.json'),
    JSON.stringify({ libraryFolderPath: libraryFolder })
  )
  const env = { ...process.env, REFORA_E2E_USER_DATA_DIR: userDataFolder } as Record<string, string>
  delete env.ELECTRON_RUN_AS_NODE
  const application = await electron.launch({ executablePath: String(electronExe), env, args: [testMain] })
  try {
    const page = await application.firstWindow()
    await application.evaluate(({ dialog }, selectedPath) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selectedPath] })
    }, tectonicPath)
    await page.getByRole('button', { name: 'Settings' }).click()
    await page.getByRole('button', { name: 'LaTeX Compiler' }).click()
    await page.getByRole('combobox', { name: 'Compiler' }).selectOption('tectonic')
    await page.getByRole('button', { name: 'Choose File' }).click()
    await expect(page.getByPlaceholder('Detect automatically')).toHaveValue(tectonicPath)

    await expect.poll(() => page.evaluate(async () => ({
      compiler: await window.api.settings.get('latexCompiler', ''),
      path: await window.api.settings.get('tectonicBinPath', '')
    }))).toEqual({ compiler: 'tectonic', path: tectonicPath })

    const compilation = await page.evaluate(async () => {
      const workspace = await window.api.workspaces.create('Tectonic E2E')
      const created = await window.api.latex.execute(workspace.id, { action: 'create', title: 'Tectonic paper' })
      if (!created.project) throw new Error('LaTeX project was not created')
      return (await window.api.latex.execute(workspace.id, {
        action: 'compile',
        projectId: created.project.id,
        engine: 'pdflatex'
      })).compilation
    })
    expect(compilation?.success).toBe(true)
    expect(compilation?.pdfBase64).toBeTruthy()

    await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click()
    await page.reload()
    await page.getByRole('button', { name: 'Tectonic E2E', exact: true }).click()
    const latexCard = page.locator('[data-card-kind="latex"]').filter({ hasText: 'Tectonic paper' })
    await latexCard.getByRole('button', { name: 'Tectonic paper', exact: true }).click()
    await page.getByRole('button', { name: 'Enter fullscreen', exact: true }).click()
    await page.getByRole('button', { name: 'Source and PDF', exact: true }).click()
    const sourceRegion = page.locator('.latex-editor-region')
    const divider = page.locator('.latex-editing-surfaces').getByRole('separator')
    const before = await sourceRegion.boundingBox()
    const dividerBox = await divider.boundingBox()
    if (!before || !dividerBox) throw new Error('LaTeX split layout is not visible')
    await page.mouse.move(dividerBox.x, dividerBox.y + dividerBox.height / 2)
    await page.mouse.down()
    await page.mouse.move(dividerBox.x + 120, dividerBox.y + dividerBox.height / 2)
    await page.mouse.up()
    await expect.poll(async () => (await sourceRegion.boundingBox())?.width ?? 0).toBeGreaterThan(before.width + 80)
  } finally {
    await application.close()
    fs.rmSync(userDataFolder, { recursive: true, force: true })
    fs.rmSync(libraryFolder, { recursive: true, force: true })
  }
})
