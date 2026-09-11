import { test, expect, _electron as electron } from '@playwright/test'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import electronExe from 'electron'
import { dbPathForLibraryFolder } from '../../src/main/services/dbPath'

const testMain = path.resolve(__dirname, 'electron-main.mjs')
const backend = path.resolve(__dirname, '..', '..', 'backend')
const fixture = path.resolve(__dirname, '..', 'fixtures', 'valid.pdf')

const seedLibrary = `
import hashlib, json, os, sys
from refora_server.db.connection import open_database, get_search_mode
from refora_server.db.settings_seed import seed_default_settings
from refora_server.repositories.documents import createDocumentsRepository

database_path, library, fixture = sys.argv[1:]
os.makedirs(os.path.dirname(database_path), exist_ok=True)
db, _ = open_database(database_path)
seed_default_settings(db, 'en')
db.execute('INSERT OR REPLACE INTO settings(key, value) VALUES (?, ?)', ('libraryFolderPath', json.dumps(library)))
repo = createDocumentsRepository(db, {'getLibraryFolder': lambda: library, 'getSearchMode': get_search_mode})
with open(fixture, 'rb') as source:
    contents = source.read()
db.execute("INSERT INTO categories(id, name, createdAt) VALUES ('review-category', 'Review collection', 1)")
for index in range(1, 107):
    name = f'review-{index:03}.pdf'
    file_path = os.path.join(library, name)
    data = contents + f'\\n% fixture {index}\\n'.encode()
    with open(file_path, 'wb') as output:
        output.write(data)
    repo['insert']({
        'id': f'review-{index:03}', 'filePath': file_path, 'originalFolderPath': library,
        'fileName': name, 'fileSize': len(data), 'fileHash': hashlib.sha256(data).hexdigest(),
        'title': f'LibraryReview {index:03}' if index <= 105 else 'Unrelated document',
        'authors': 'Review Author', 'year': str(2000 + index % 25),
        'note': f'Preserved note {index}', 'addedAt': 1700000000000 + index,
        'updatedAt': 1700000000000 + index, 'metadataStatus': 'done',
    })
    if index <= 15:
        db.execute('INSERT INTO document_categories(documentId, categoryId) VALUES (?, ?)',
                   (f'review-{index:03}', 'review-category'))
db.close()
`

test('search, scoped sorting, multiple selection, compact controls and recently deleted work together', async () => {
  test.setTimeout(120_000)
  const temporaryRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'refora-e2e-management-')))
  const userDataFolder = path.join(temporaryRoot, 'user')
  const libraryFolder = path.join(temporaryRoot, 'library')
  fs.mkdirSync(userDataFolder)
  fs.mkdirSync(libraryFolder)
  fs.writeFileSync(path.join(userDataFolder, 'refora-prefs.json'), JSON.stringify({ libraryFolderPath: libraryFolder }))
  execFileSync(path.join(backend, '.venv', 'bin', 'python'), [
    '-c', seedLibrary, dbPathForLibraryFolder(userDataFolder, libraryFolder), libraryFolder, fixture
  ], { cwd: backend })
  const launchEnv = { ...process.env, REFORA_E2E_USER_DATA_DIR: userDataFolder } as Record<string, string>
  delete launchEnv.ELECTRON_RUN_AS_NODE
  const app = await electron.launch({ executablePath: String(electronExe), env: launchEnv, args: [testMain] })
  const diagnostics: string[] = []
  app.process().stderr?.on('data', (chunk: Buffer) => diagnostics.push(chunk.toString()))
  try {
    expect(await app.evaluate(({ app: nativeApp }) => nativeApp.getPath('userData'))).toBe(userDataFolder)
    const page = await app.firstWindow()
    page.on('pageerror', (error) => diagnostics.push(error.message))
    const list = page.locator('.document-list')
    const grid = list.getByRole('grid')
    const row = (id: string) => list.locator(`[data-document-id="${id}"] [role="row"]`)
    const search = page.locator('.doc-search-input')
    await expect(list.getByRole('row').first()).toBeVisible({ timeout: 30_000 })
    await list.getByRole('columnheader', { name: 'Title', exact: true }).getByRole('button').click()
    await search.fill('LibraryReview')
    await search.press('Escape')
    await expect(row('review-001').locator('mark').first()).toHaveText('LibraryReview')
    await row('review-001').click()
    await page.keyboard.press('Meta+a')
    await expect(page.getByText('105 selected', { exact: true }).first()).toBeVisible()
    await expect(async () => {
      await grid.evaluate((element) => { element.scrollTop = element.scrollHeight })
      await expect(row('review-105')).toBeVisible()
    }).toPass({ timeout: 15_000 })
    await expect(row('review-106')).toHaveCount(0)

    await page.getByRole('button', { name: /Review collection/ }).click()
    await grid.evaluate((element) => { element.scrollTop = 0 })
    await expect(row('review-001')).toBeVisible()
    await row('review-001').click()
    await page.keyboard.press('Meta+a')
    await expect(page.getByText('15 selected', { exact: true }).first()).toBeVisible()
    const titleHeader = list.getByRole('columnheader', { name: 'Title', exact: true })
    await titleHeader.getByRole('button').click()
    await expect(titleHeader).toHaveAttribute('aria-sort', 'descending')
    await expect(list.getByRole('row').first()).toContainText('LibraryReview 015')
    await titleHeader.getByRole('button').click()
    await expect(list.getByRole('row').first()).toContainText('LibraryReview 001')

    await row('review-001').click()
    await row('review-003').click({ modifiers: ['Shift'] })
    await expect(page.getByText('3 selected', { exact: true }).first()).toBeVisible()
    await row('review-002').click({ modifiers: ['Meta'] })
    await expect(page.getByText('2 selected', { exact: true }).first()).toBeVisible()
    await row('review-004').click()
    await expect(page.getByText('2 selected', { exact: true })).toHaveCount(0)
    await expect(row('review-004')).toHaveAttribute('aria-selected', 'true')
    await page.keyboard.press('Shift+ArrowDown')
    await expect(page.getByText('2 selected', { exact: true }).first()).toBeVisible()
    await expect(row('review-005')).toBeFocused()
    await page.keyboard.press('Escape')

    await row('review-001').click()
    await page.keyboard.press('Meta+Backspace')
    const confirmation = page.getByRole('dialog')
    await expect(confirmation).toBeVisible()
    await confirmation.getByRole('button', { name: 'Delete', exact: true }).click()
    await expect(row('review-001')).toHaveCount(0)
    await expect.poll(async () => page.evaluate(() => window.api.documents.listDeleted().then((entries) => entries.length))).toBe(1)
    await page.getByRole('button', { name: 'Recently deleted', exact: true }).click()
    const recycle = page.getByRole('dialog')
    await expect(recycle.getByText('LibraryReview 001', { exact: true })).toBeVisible()
    await recycle.getByRole('button', { name: 'Restore', exact: true }).click()
    await expect.poll(async () => page.evaluate(() => window.api.documents.listDeleted().then((entries) => entries.length))).toBe(0)
    const restored = await page.evaluate(() => window.api.documents.get('review-001'))
    expect(restored.note).toBe('Preserved note 1')
    const restoredCategory = await page.evaluate(() => window.api.documents.list({ mode: 'category', categoryId: 'review-category' }))
    expect(restoredCategory.map((document) => document.id)).toContain('review-001')
    await page.keyboard.press('Escape')
    await expect(row('review-001')).toBeVisible()

    await page.evaluate(() => window.api.workspaces.create('Review workspace'))
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.getByRole('button', { name: 'Review workspace', exact: true }).click()
    await expect(list.getByRole('columnheader')).toHaveCount(0)
    const compactRow = list.getByRole('row').first()
    const compactId = await compactRow.locator('..').getAttribute('data-document-id')
    expect(compactId).toBeTruthy()
    const checkbox = compactRow.getByRole('checkbox')
    await checkbox.check()
    await expect(checkbox).toBeChecked()
    const star = compactRow.getByRole('button', { name: /^Star / })
    await star.click()
    await expect(compactRow.getByRole('button', { name: /^Unstar / })).toHaveAttribute('aria-pressed', 'true')
    expect((await page.evaluate((id) => window.api.documents.get(id), compactId!)).starred).toBe(1)

    const primary = await page.evaluate(async () => {
      await window.api.documents.update('review-016', { doi: '10.5555/review-e2e' })
      await window.api.documents.update('review-017', { doi: '10.5555/review-e2e' })
      return window.api.documents.get('review-016')
    })
    await search.fill('LibraryReview 01')
    await search.press('Escape')
    await expect(row('review-016').locator('mark').nth(1)).toHaveText('01')
    await row('review-016').click()
    await row('review-017').click({ modifiers: ['Meta'] })
    await page.getByRole('button', { name: 'Merge duplicate documents', exact: true }).click()
    await expect(page.getByText('Primary document to keep', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Merge documents', exact: true }).click()
    await expect(row('review-017')).toHaveCount(0)
    await expect.poll(async () => page.evaluate(() => window.api.documents.list({ mode: 'all' })
      .then((documents) => documents.some((document) => document.id === 'review-017')))).toBe(false)
    const merged = await page.evaluate(() => window.api.documents.get('review-016'))
    expect(merged.citekey).toBe(primary.citekey)
    expect(merged.note).toContain('Preserved note 16')
    expect(merged.note).toContain('Preserved note 17')
    await page.getByRole('button', { name: merged.citekey!, exact: true }).click()
    const citekeyEditor = page.locator('textarea:focus')
    await citekeyEditor.fill('review2026stable')
    await citekeyEditor.press('Meta+Enter')
    await expect(page.getByRole('button', { name: 'review2026stable', exact: true })).toBeVisible()
    const bibtex = await page.evaluate(() => window.api.export.toBibtexString(['review-016']))
    expect(bibtex).toContain('{review2026stable,')

  } catch (error) {
    await test.info().attach('electron-diagnostics', { body: diagnostics.join('\n'), contentType: 'text/plain' })
    throw error
  } finally {
    await app.close().catch(() => undefined)
    fs.rmSync(temporaryRoot, { recursive: true, force: true })
  }
})
