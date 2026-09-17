import { test, expect, _electron as electron } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import electronExecutable from 'electron'

test('selected LaTeX sends AI instructions and reviews staged changes individually and in bulk', async () => {
  test.setTimeout(120_000)
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'refora-latex-ai-'))
  fs.mkdirSync(path.join(folder, 'user'))
  fs.mkdirSync(path.join(folder, 'library'))
  fs.writeFileSync(path.join(folder, 'user/refora-prefs.json'), JSON.stringify({ libraryFolderPath: path.join(folder, 'library') }))
  let workspaceId = ''
  let projectId = ''
  let hash = ''
  let proposed = ''
  const prompts: string[] = []
  const server = http.createServer(async (request, response) => {
    if (request.method === 'GET') { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ data: [{ id: 'latex-test' }] })); return }
    let body = ''
    for await (const chunk of request) body += chunk
    const payload = JSON.parse(body)
    if (!payload.tools?.length) {
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify({ id: 'title', object: 'chat.completion', model: 'latex-test', choices: [{ index: 0, message: { role: 'assistant', content: 'LaTeX proofreading' }, finish_reason: 'stop' }] }))
      return
    }
    const messages = payload.messages ?? []
    const system = JSON.stringify(messages.filter((message: { role: string }) => message.role === 'system' || message.role === 'developer'))
    expect(system).toContain('LaTeX writing and coding assistant')
    expect(system).not.toContain('paper catalog')
    expect(system).not.toContain('cards.layout')
    expect(payload.tools.map((tool: { function: { name: string } }) => tool.function.name)).toEqual(['edit_latex_project'])
    const lastUser = messages.findLastIndex((message: { role: string }) => message.role === 'user')
    const prompt = JSON.stringify(messages[lastUser]?.content)
    if (!prompts.includes(prompt)) prompts.push(prompt)
    const results = messages.slice(lastUser + 1).filter((message: { role: string }) => message.role === 'tool')
    const parameters = results.length === 0
      ? { workspaceId, operation: 'read', projectId, path: 'main.tex' }
      : { workspaceId, operation: 'write', projectId, path: 'main.tex', expectedHash: hash, content: proposed }
    const tool = { id: `call-${results.length}`, type: 'function', function: { name: 'edit_latex_project', arguments: JSON.stringify(parameters) } }
    const done = results.length >= 2
    const message = done ? { role: 'assistant', content: 'The proposed edits are ready for review.' } : { role: 'assistant', content: null, tool_calls: [tool] }
    response.setHeader('Content-Type', payload.stream ? 'text/event-stream' : 'application/json')
    if (payload.stream) {
      const delta = done ? message : { role: 'assistant', tool_calls: [{ index: 0, ...tool }] }
      response.write(`data: ${JSON.stringify({ id: 'chat-test', object: 'chat.completion.chunk', model: 'latex-test', choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`)
      response.write(`data: ${JSON.stringify({ id: 'chat-test', object: 'chat.completion.chunk', model: 'latex-test', choices: [{ index: 0, delta: {}, finish_reason: done ? 'stop' : 'tool_calls' }] })}\n\ndata: [DONE]\n\n`)
      response.end()
    } else response.end(JSON.stringify({ id: 'chat-test', object: 'chat.completion', model: 'latex-test', choices: [{ index: 0, message, finish_reason: done ? 'stop' : 'tool_calls' }] }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  const env = { ...process.env, REFORA_E2E_USER_DATA_DIR: path.join(folder, 'user') } as Record<string, string>
  delete env.ELECTRON_RUN_AS_NODE
  const application = await electron.launch({ executablePath: String(electronExecutable), args: [path.resolve('tests/e2e/electron-main.mjs')], env })
  try {
    const page = await application.firstWindow()
    const setTheme = async (theme: 'Light' | 'Dark') => {
      await page.getByRole('button', { name: 'Exit fullscreen', exact: true }).click()
      await page.getByRole('button', { name: 'Theme', exact: true }).click()
      await page.getByRole('menuitemradio', { name: theme, exact: true }).click()
      await page.getByRole('button', { name: 'Enter fullscreen', exact: true }).click()
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme.toLowerCase())
    }
    const original = '\\documentclass{article}\n\\begin{document}\nThis are incorrect. 理解专家（UE）：采用冻结的 Qwen3-VL-4B 模型，保留多模态语义理解能力。\n\\section{Results}\nThese is another error.\n\\end{document}\n'
    proposed = original.replace('This are', 'This is').replace('These is', 'These are')
    const fixture = await page.evaluate(async ({ original, port }) => {
      const provider = await window.api.aiProviders.create({ name: 'Local test AI', baseUrl: `http://127.0.0.1:${port}/v1`, apiProtocol: 'openai-compatible', reasoningControl: 'none', model: 'latex-test' })
      await window.api.settings.set('activeProviderId', provider.id)
      await window.api.settings.set('theme', 'system')
      const ws = await window.api.workspaces.create('AI editing test')
      const project = (await window.api.latex.execute(ws.id, { action: 'create', title: 'Review paper' })).project!
      const file = (await window.api.latex.execute(ws.id, { action: 'read', projectId: project.id, path: 'main.tex' })).file!
      const saved = (await window.api.latex.execute(ws.id, { action: 'write', projectId: project.id, path: file.path, expectedHash: file.hash, content: original })).file!
      return { workspaceId: ws.id, projectId: project.id, hash: saved.hash }
    }, { original, port: address.port })
    workspaceId = fixture.workspaceId; projectId = fixture.projectId; hash = fixture.hash
    const read = () => page.evaluate(async ({ workspaceId, projectId }) => (await window.api.latex.execute(workspaceId, { action: 'read', projectId, path: 'main.tex' })).file!, { workspaceId, projectId })
    await page.reload()
    await page.getByRole('button', { name: 'AI editing test', exact: true }).click()
    await page.getByRole('button', { name: 'Review paper', exact: true }).click()
    await page.getByRole('button', { name: 'Enter fullscreen', exact: true }).click()
    const editor = page.getByRole('textbox', { name: 'LaTeX source', exact: true })
    await editor.click()
    await editor.press('Meta+a')
    await expect(page.getByRole('dialog', { name: 'Edit selected LaTeX' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Comment', exact: true })).toHaveCount(0)
    const instruction = page.getByRole('textbox', { name: 'Edit with AI…' })
    await instruction.fill('Polish this selection')
    await expect(instruction).toBeFocused()
    await expect(page.locator('.latex-selection-layer')).toBeVisible()
    await expect(page.locator('.latex-selection-layer mark')).toHaveText(original)
    await page.screenshot({ path: path.resolve('.tmp/latex-context-selection.png') })
    await page.getByRole('button', { name: 'Proofread', exact: true }).click()
    await expect(page.getByRole('region', { name: 'Review AI changes' })).toBeVisible({ timeout: 45_000 })
    expect(prompts[0]).toContain('Proofread')
    expect(prompts[0]).toContain('main.tex:1-6')
    expect(prompts[0]).not.toContain('Use the LaTeX project editing tool')
    expect(prompts[0]).not.toContain(projectId)
    expect((await read()).content).toBe(original)
    await expect(page.locator('.latex-review-added')).toHaveCount(2)
    await expect(page.locator('.latex-review-removed')).toHaveCount(2)
    await expect(page.locator('.chat-user-message pre code').first()).toContainText('\\documentclass')
    await expect(page.getByRole('button', { name: 'Attach workspace files', exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: 'Next change', exact: true }).click()
    await expect(page.locator('.latex-review-change').nth(1)).toBeFocused()
    const codeBlock = page.locator('.chat-user-message .markdown-code-content').first()
    await expect(codeBlock).toHaveCSS('border-top-width', '0px')
    await expect(codeBlock).toHaveCSS('border-radius', '0px')
    await setTheme('Light')
    expect(await codeBlock.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true)
    await page.screenshot({ path: path.resolve('.tmp/latex-context-review.png') })
    await page.locator('.chat-user-message .markdown-code-block').first().screenshot({ path: path.resolve('.tmp/latex-code-card.png') })
    await setTheme('Dark')
    await page.screenshot({ path: path.resolve('.tmp/latex-context-review-dark.png') })
    await setTheme('Light')
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 760))
    await expect(page.getByRole('button', { name: 'Accept all', exact: true })).toBeInViewport({ ratio: 1 })
    await page.screenshot({ path: path.resolve('.tmp/latex-context-review-compact.png') })
    await page.getByRole('button', { name: 'Accept', exact: true }).first().click()
    await expect(page.getByRole('button', { name: 'Accept', exact: true })).toHaveCount(1)
    expect((await read()).content).toBe(original.replace('This are', 'This is'))
    await page.getByRole('button', { name: 'Reject', exact: true }).click()
    await expect(editor).toBeVisible()
    hash = (await read()).hash
    await editor.click()
    await editor.press('Meta+a')
    await page.getByRole('textbox', { name: 'Edit with AI…' }).fill('Correct the remaining subject–verb agreement.')
    await page.getByRole('button', { name: 'Send AI edit', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Accept all', exact: true })).toBeVisible({ timeout: 45_000 })
    expect(prompts.at(-1)).toContain('Correct the remaining subject–verb agreement.')
    await page.reload()
    await page.getByRole('button', { name: 'AI editing test', exact: true }).click()
    await page.getByRole('button', { name: 'Review paper', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Accept all', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Accept all', exact: true }).click()
    await expect(editor).toHaveValue(proposed)
    expect((await read()).review).toBeUndefined()
    hash = (await read()).hash
    const accepted = proposed
    proposed = accepted.replace('This is incorrect.', 'An unwanted revision.')
    await editor.click()
    await editor.press('Meta+a')
    await page.getByRole('button', { name: 'Proofread', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Reject all', exact: true })).toBeVisible({ timeout: 45_000 })
    await page.getByRole('button', { name: 'Reject all', exact: true }).click()
    await expect(editor).toHaveValue(accepted)
    expect((await read()).review).toBeUndefined()
  } finally {
    await application.close()
    await new Promise<void>(resolve => server.close(() => resolve()))
    fs.rmSync(folder, { recursive: true, force: true })
  }
})
