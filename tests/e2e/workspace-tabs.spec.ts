import { test, expect, _electron as electron, chromium } from '@playwright/test'
import electronExe from 'electron'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

test('reorders workspace tabs using real mouse dragging', async () => {
  const profile = mkdtempSync(path.join(tmpdir(), 'refora-tabs-profile-'))
  const library = mkdtempSync(path.join(tmpdir(), 'refora-tabs-library-'))
  writeFileSync(path.join(profile, 'refora-prefs.json'), JSON.stringify({ libraryFolderPath: library }))
  const env: Record<string, string> = { ...process.env, REFORA_E2E_USER_DATA_DIR: profile }
  delete env.ELECTRON_RUN_AS_NODE
  const endpoint = process.env.REFORA_TABS_DEV_CDP
  const browser = endpoint ? await chromium.connectOverCDP(endpoint) : null
  const app = browser ? null : await electron.launch({
    executablePath: String(electronExe), env,
    args: [path.resolve(__dirname, 'electron-main.mjs')]
  })
  try {
    const page = browser ? browser.contexts()[0].pages()[0] : await app!.firstWindow()
    await page.waitForFunction(() => Boolean(window.api?.workspaces))
    const names = ['Drag Alpha', 'Drag Beta', 'Drag Gamma'].map((name) => `${name} ${Date.now()}`)
    await page.evaluate(async (titles) => {
      for (const title of titles) await window.api.workspaces.create(title)
    }, names)
    await page.reload()
    for (const name of names) await page.getByRole('button', { name, exact: true }).click()
    await page.getByRole('button', { name: 'Enter fullscreen', exact: true }).click()
    const tabs = page.getByRole('tablist').getByRole('tab')
    await expect(tabs).toHaveText(names)
    const alpha = page.getByRole('tab', { name: names[0], exact: true })
    const gamma = page.getByRole('tab', { name: names[2], exact: true })
    await expect.poll(() => alpha.evaluate((element) => {
      const bounds = element.getBoundingClientRect()
      return document.elementFromPoint(bounds.left + 5, bounds.top + 12) === element
    })).toBe(true)
    const drag = async (target: typeof alpha, right = false) => {
      const source = (await gamma.boundingBox())!
      const destination = (await target.boundingBox())!
      await page.mouse.move(source.x + source.width / 2, source.y + 12)
      await page.mouse.down()
      const tabBody = gamma.locator('..')
      const before = (await tabBody.boundingBox())!
      const delta = destination.x < source.x ? -35 : 35
      await page.mouse.move(source.x + source.width / 2 + delta, source.y + 12, { steps: 3 })
      await expect.poll(async () => Math.abs((await tabBody.boundingBox())!.x - before.x - delta)).toBeLessThan(2)
      const neighborBefore = (await target.locator('..').boundingBox())!
      await page.mouse.move(destination.x + (right ? destination.width - 5 : 5), destination.y + 12, { steps: 15 })
      await expect.poll(async () => Math.abs((await target.locator('..').boundingBox())!.x - neighborBefore.x)).toBeGreaterThan(30)
      await expect(tabBody).toHaveAttribute('data-dragging', 'true')
      await page.screenshot({ path: '/tmp/refora-workspace-tabs-dragging.png' })
      await page.mouse.up()
    }
    const originalGamma = (await gamma.boundingBox())!
    await page.mouse.move(originalGamma.x + 50, originalGamma.y + 12)
    await page.mouse.down()
    await page.mouse.move(originalGamma.x - 30, originalGamma.y + 12, { steps: 5 })
    await expect(gamma.locator('..')).toHaveAttribute('data-dragging', 'true')
    await page.keyboard.press('Escape')
    await page.mouse.up()
    await expect(tabs).toHaveText(names)
    await expect.poll(async () => Math.abs((await gamma.boundingBox())!.x - originalGamma.x)).toBeLessThan(2)
    await drag(alpha)
    await expect(tabs).toHaveText([names[2], names[0], names[1]])
    await expect(gamma).toHaveAttribute('aria-selected', 'true')
    const beta = page.getByRole('tab', { name: names[1], exact: true })
    await drag(beta, true)
    await expect(tabs).toHaveText(names)
    await alpha.click()
    await expect(alpha).toHaveAttribute('aria-selected', 'true')
    await expect(tabs).toHaveText(names)
    await page.locator('[data-testid="workspace-reader-tab"]').filter({ has: beta }).getByRole('button').last().click()
    await expect(tabs).toHaveText([names[0], names[2]])
    await page.getByRole('button', { name: 'Exit fullscreen', exact: true }).click()
    await page.getByRole('button', { name: names[1], exact: true }).click()
    await expect(tabs).toHaveText([names[0], names[2], names[1]])
    const strip = page.getByRole('tablist')
    await expect.poll(() => strip.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0)
    const betaBounds = (await beta.boundingBox())!
    const stripBounds = (await strip.boundingBox())!
    await page.mouse.move(betaBounds.x + betaBounds.width / 2, betaBounds.y + 12)
    await page.mouse.down()
    await page.mouse.move(stripBounds.x + 8, betaBounds.y + 12, { steps: 10 })
    await expect.poll(() => strip.evaluate((element) => element.scrollLeft)).toBe(0)
    await page.mouse.up()
    await expect(tabs).toHaveText([names[1], names[0], names[2]])
    await page.screenshot({ path: '/tmp/refora-workspace-tabs-verified.png' })
  } finally {
    await app?.close()
    await browser?.close()
    rmSync(profile, { recursive: true, force: true })
    rmSync(library, { recursive: true, force: true })
  }
})
