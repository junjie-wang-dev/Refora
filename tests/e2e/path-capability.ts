import type { Page } from '@playwright/test'

export async function authorizeFilePath(page: Page, filePath: string): Promise<string> {
  const selector = 'input[data-refora-e2e-path]'
  await page.evaluate(() => {
    document.querySelector('input[data-refora-e2e-path]')?.remove()
    const input = document.createElement('input')
    input.type = 'file'
    input.dataset.reforaE2ePath = 'true'
    document.body.append(input)
  })
  const input = page.locator(selector)
  await input.setInputFiles(filePath)
  const resolved = await input.evaluate(async (element) => {
    const file = (element as HTMLInputElement).files?.[0]
    if (!file) return ''
    const electronApi = (window as Window & {
      api: { getPathForFile(value: unknown): Promise<string> }
    }).api
    return electronApi.getPathForFile(file)
  })
  await input.evaluate((element) => element.remove())
  if (!resolved) throw new Error(`Unable to authorize E2E file path: ${filePath}`)
  return resolved
}
