import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { ChatMediaResource } from '../../src/shared/ipc-types'
import { createChatMediaActions } from '../../src/main/services/chatMedia'

const mocks = vi.hoisted(() => ({
  getPath: vi.fn(),
  openPath: vi.fn(),
  showItemInFolder: vi.fn(),
  showSaveDialog: vi.fn(),
  createFromPath: vi.fn(),
  writeImage: vi.fn(),
  writeFileToClipboard: vi.fn()
}))

vi.mock('electron', () => ({
  app: { getPath: mocks.getPath },
  shell: { openPath: mocks.openPath, showItemInFolder: mocks.showItemInFolder },
  dialog: { showSaveDialog: mocks.showSaveDialog },
  nativeImage: { createFromPath: mocks.createFromPath },
  clipboard: { writeImage: mocks.writeImage }
}))

vi.mock('../../src/main/services/clipboard', () => ({ writeFileToClipboard: mocks.writeFileToClipboard }))

describe('native chat media actions', () => {
  const id = 'a'.repeat(64)
  const otherId = 'b'.repeat(64)
  const content = Buffer.from('local media contents')
  let root: string
  let cache: string
  let path: string
  let resource: ChatMediaResource & { path: string }
  let getFile: Mock<(id: string) => Promise<ChatMediaResource & { path: string }>>
  let actions: ReturnType<typeof createChatMediaActions>

  beforeEach(() => {
    vi.resetAllMocks()
    root = realpathSync(mkdtempSync(join(tmpdir(), 'refora-media-actions-')))
    cache = join(root, '.refora-agent', 'media')
    path = join(cache, id, 'figure.png')
    mkdirSync(join(cache, id), { recursive: true })
    writeFileSync(path, content)
    resource = { id, path, url: `refora-asset://media/${id}`, kind: 'image', fileName: 'figure.png', mimeType: 'image/png', byteLength: content.length }
    getFile = vi.fn(async (_id: string) => resource)
    actions = createChatMediaActions({ getFile, managedRoots: [root], getWin: () => null })
    mocks.openPath.mockResolvedValue('')
    mocks.getPath.mockReturnValue(join(root, 'Downloads'))
    mocks.showSaveDialog.mockResolvedValue({ canceled: true })
    mocks.createFromPath.mockReturnValue({ isEmpty: () => false })
  })

  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('opens and reveals a validated managed cache file', async () => {
    await actions.open(id)
    await actions.reveal(id)
    expect(mocks.openPath).toHaveBeenCalledWith(path)
    expect(mocks.showItemInFolder).toHaveBeenCalledWith(path)
  })

  it('reports native open failures', async () => {
    mocks.openPath.mockResolvedValue('No application can open this file')
    await expect(actions.open(id)).rejects.toThrow('No application can open this file')
  })

  it.each([
    ['text/x-python', 'script.py'],
    ['application/x-sh', 'script.command'],
    ['text/html', 'page.html']
  ])('prevents launching %s while allowing an explicit save', async (mimeType, fileName) => {
    const renamed = join(cache, id, fileName)
    renameSync(path, renamed)
    path = renamed
    resource = { ...resource, path, mimeType, fileName, kind: 'file' }
    await expect(actions.open(id)).rejects.toThrow('cannot be launched from the conversation')
    expect(mocks.openPath).not.toHaveBeenCalled()
    const destination = join(root, fileName)
    mocks.showSaveDialog.mockResolvedValue({ canceled: false, filePath: destination })
    expect(await actions.save(id)).toBe(true)
    expect(readFileSync(destination)).toEqual(content)
  })

  it('copies image data through the native image clipboard', async () => {
    const image = { isEmpty: () => false }
    mocks.createFromPath.mockReturnValue(image)
    await actions.copy(id)
    expect(mocks.createFromPath).toHaveBeenCalledWith(path)
    expect(mocks.writeImage).toHaveBeenCalledWith(image)
    expect(mocks.writeFileToClipboard).not.toHaveBeenCalled()
  })

  it('rejects an image that the native decoder cannot read', async () => {
    mocks.createFromPath.mockReturnValue({ isEmpty: () => true })
    await expect(actions.copy(id)).rejects.toThrow('Image could not be copied')
    expect(mocks.writeImage).not.toHaveBeenCalled()
  })

  it.each(['file', 'audio', 'video'] as const)('copies a %s as a file clipboard item', async (kind) => {
    resource.kind = kind
    await actions.copy(id)
    expect(mocks.writeFileToClipboard).toHaveBeenCalledWith(path)
    expect(mocks.createFromPath).not.toHaveBeenCalled()
    expect(mocks.writeImage).not.toHaveBeenCalled()
  })

  it('returns false when saving is canceled and leaves the cached source unchanged', async () => {
    expect(await actions.save(id)).toBe(false)
    expect(mocks.showSaveDialog).toHaveBeenCalledWith({ defaultPath: join(root, 'Downloads', 'figure.png') })
    expect(readFileSync(path)).toEqual(content)
    expect(existsSync(join(root, 'Downloads', 'figure.png'))).toBe(false)
  })

  it('copies a selected save destination and attaches the dialog to the active window', async () => {
    const win = {} as BrowserWindow
    const destination = join(root, 'saved.png')
    mocks.showSaveDialog.mockResolvedValue({ canceled: false, filePath: destination })
    const scopedActions = createChatMediaActions({ getFile, managedRoots: [root], getWin: () => win })
    expect(await scopedActions.save(id)).toBe(true)
    expect(mocks.showSaveDialog).toHaveBeenCalledWith(win, { defaultPath: join(root, 'Downloads', 'figure.png') })
    expect(readFileSync(destination)).toEqual(content)
    expect(readFileSync(path)).toEqual(content)
  })

  it('permits replacing a regular destination selected in the save dialog', async () => {
    const destination = join(root, 'saved.png')
    writeFileSync(destination, 'previous file')
    mocks.showSaveDialog.mockResolvedValue({ canceled: false, filePath: destination })
    expect(await actions.save(id)).toBe(true)
    expect(readFileSync(destination)).toEqual(content)
  })

  it('does not truncate the cached file when it is selected as the save destination', async () => {
    mocks.showSaveDialog.mockResolvedValue({ canceled: false, filePath: path })
    expect(await actions.save(id)).toBe(true)
    expect(readFileSync(path)).toEqual(content)
  })

  it('revalidates a cache file changed while the save dialog was open', async () => {
    const destination = join(root, 'saved.png')
    mocks.showSaveDialog.mockImplementation(async () => {
      writeFileSync(path, 'different file contents after the dialog opened')
      return { canceled: false, filePath: destination }
    })
    await expect(actions.save(id)).rejects.toThrow('Media file size has changed')
    expect(existsSync(destination)).toBe(false)
  })

  it('rejects a cache file replaced with a symlink while the save dialog was open', async () => {
    const original = join(root, 'original.png')
    const destination = join(root, 'saved.png')
    writeFileSync(original, content)
    mocks.showSaveDialog.mockImplementation(async () => {
      unlinkSync(path)
      symlinkSync(original, path)
      return { canceled: false, filePath: destination }
    })
    await expect(actions.save(id)).rejects.toThrow('symbolic_link')
    expect(existsSync(destination)).toBe(false)
  })

  it.each(['directory', 'symlink'])('rejects a %s as the save destination', async (kind) => {
    const destination = join(root, 'destination')
    if (kind === 'directory') mkdirSync(destination)
    else symlinkSync(path, destination)
    mocks.showSaveDialog.mockResolvedValue({ canceled: false, filePath: destination })
    await expect(actions.save(id)).rejects.toThrow('Save destination must be a regular file')
    expect(readFileSync(path)).toEqual(content)
  })

  it.each(['../file', 'x'.repeat(64), 'a'.repeat(63), 'A'.repeat(64), ''])('rejects invalid media identifier %s before resolving a resource', async (invalidId) => {
    await expect(actions.open(invalidId)).rejects.toThrow('Invalid media reference')
    expect(getFile).not.toHaveBeenCalled()
    expect(mocks.openPath).not.toHaveBeenCalled()
  })

  it('rejects a response belonging to a different media identifier', async () => {
    resource.id = otherId
    await expect(actions.open(id)).rejects.toThrow('Media reference does not match')
    expect(mocks.openPath).not.toHaveBeenCalled()
  })

  it.each(['outside', 'sibling', 'nested'])('rejects a file in an %s location', async (location) => {
    const destination = location === 'outside'
      ? join(root, 'outside', 'figure.png')
      : location === 'sibling'
        ? join(cache, otherId, 'figure.png')
        : join(cache, id, 'nested', 'figure.png')
    mkdirSync(join(destination, '..'), { recursive: true })
    writeFileSync(destination, content)
    resource.path = destination
    await expect(actions.open(id)).rejects.toThrow('Media file is outside the managed cache')
    expect(mocks.openPath).not.toHaveBeenCalled()
  })

  it('rejects an unmanaged root even if the relative cache structure matches', async () => {
    const unmanagedActions = createChatMediaActions({ getFile, managedRoots: ['', join(root, 'other')], getWin: () => null })
    await expect(unmanagedActions.open(id)).rejects.toThrow('Media file is outside the managed cache')
  })

  it('accepts a resource from any configured managed root', async () => {
    const multipleRoots = createChatMediaActions({ getFile, managedRoots: [join(root, 'missing'), root], getWin: () => null })
    await multipleRoots.reveal(id)
    expect(mocks.showItemInFolder).toHaveBeenCalledWith(path)
  })

  it('rejects a symlink in place of a cache file', async () => {
    const outside = join(root, 'outside.png')
    writeFileSync(outside, content)
    unlinkSync(path)
    symlinkSync(outside, path)
    await expect(actions.copy(id)).rejects.toThrow('symbolic_link')
    expect(mocks.writeImage).not.toHaveBeenCalled()
    expect(mocks.writeFileToClipboard).not.toHaveBeenCalled()
  })

  it('rejects a symlink in place of a resource cache directory', async () => {
    const outside = join(root, 'outside')
    renameSync(join(cache, id), outside)
    symlinkSync(outside, join(cache, id), 'dir')
    await expect(actions.reveal(id)).rejects.toThrow('Media file is outside the managed cache')
    expect(mocks.showItemInFolder).not.toHaveBeenCalled()
  })

  it.each(['.refora-agent', '.refora-agent/media'])('rejects a symlink in place of managed cache ancestor %s', async (ancestor) => {
    const outside = join(root, 'outside')
    const directory = join(root, ancestor)
    renameSync(directory, outside)
    symlinkSync(outside, directory, 'dir')
    await expect(actions.open(id)).rejects.toThrow()
    expect(mocks.openPath).not.toHaveBeenCalled()
  })

  it('rejects a changed byte length before showing a dialog or accessing the clipboard', async () => {
    writeFileSync(path, 'changed contents with a different size')
    await expect(actions.save(id)).rejects.toThrow('Media file size has changed')
    await expect(actions.copy(id)).rejects.toThrow('Media file size has changed')
    expect(mocks.showSaveDialog).not.toHaveBeenCalled()
    expect(mocks.writeImage).not.toHaveBeenCalled()
  })

  it('rejects a declared size over the resource limit', async () => {
    resource.byteLength = 100 * 1024 * 1024 + 1
    await expect(actions.open(id)).rejects.toThrow('Media file size has changed')
    expect(mocks.openPath).not.toHaveBeenCalled()
  })
})
