import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createNativeRpc } from '../../src/main/sidecar/nativeRpc'

const electronMocks = vi.hoisted(() => ({
  trashItem: vi.fn(),
  openPath: vi.fn(),
  showItemInFolder: vi.fn(),
  showOpenDialog: vi.fn(),
  showMessageBox: vi.fn(),
  writeText: vi.fn()
}))

vi.mock('electron', () => ({
  shell: {
    trashItem: electronMocks.trashItem,
    openPath: electronMocks.openPath,
    showItemInFolder: electronMocks.showItemInFolder
  },
  dialog: {
    showOpenDialog: electronMocks.showOpenDialog,
    showMessageBox: electronMocks.showMessageBox
  },
  clipboard: { writeText: electronMocks.writeText }
}))

vi.mock('../../src/main/services/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() }
}))

function makeSafeStorage() {
  return {
    isEncryptionAvailable: vi.fn(() => true),
    encrypt: vi.fn(() => Buffer.from('enc')),
    decrypt: vi.fn(() => 'decrypted-key')
  }
}

function setup(overrides: Partial<Parameters<typeof createNativeRpc>[0]> = {}) {
  return createNativeRpc({
    safeStorage: makeSafeStorage(),
    validatePath: ((path) => path),
    ...overrides
  })
}

describe('nativeRpc', () => {
  beforeEach(() => vi.clearAllMocks())

  it('invokes native routes directly without a loopback server', async () => {
    electronMocks.trashItem.mockResolvedValue(undefined)
    const rpc = setup()

    await expect(rpc.invoke('/native/trash-item', { path: '/Users/x/paper.pdf' })).resolves.toEqual({
      ok: true,
      data: { trashed: true }
    })
    expect(electronMocks.trashItem).toHaveBeenCalledWith('/Users/x/paper.pdf')
  })

  it('keeps path validation before native shell operations', async () => {
    const rpc = setup({ validatePath: () => { throw new Error('path must be absolute') } })

    await expect(rpc.invoke('/native/open-path', { path: '../paper.pdf' })).resolves.toEqual({
      ok: false,
      error: { code: 'invalid_path', message: 'path must be absolute' }
    })
    expect(electronMocks.openPath).not.toHaveBeenCalled()
  })

  it('uses managed roots for non-PDF paths', async () => {
    const library = mkdtempSync(join(tmpdir(), 'refora-native-root-'))
    const filePath = join(library, 'notes.md')
    writeFileSync(filePath, 'notes')
    const rpc = createNativeRpc({ safeStorage: makeSafeStorage() })

    await expect(rpc.invoke('/native/open-path', { path: filePath })).resolves.toMatchObject({
      ok: false,
      error: { code: 'invalid_path' }
    })
    expect(rpc.addManagedRoot(library)).toBe(true)
    electronMocks.openPath.mockResolvedValue('')
    await expect(rpc.invoke('/native/open-path', { path: filePath })).resolves.toEqual({
      ok: true,
      data: { opened: true }
    })
    expect(electronMocks.openPath).toHaveBeenCalledWith(realpathSync(filePath))
    rmSync(library, { recursive: true, force: true })
  })

  it('returns structured native failures', async () => {
    electronMocks.trashItem.mockRejectedValue(new Error('nope'))
    const rpc = setup()

    await expect(rpc.invoke('/native/trash-item', { path: '/bad.pdf' })).resolves.toEqual({
      ok: false,
      error: { code: 'trash_failed', message: 'nope' }
    })
    await expect(rpc.invoke('/native/unknown', {})).resolves.toMatchObject({
      ok: false,
      error: { code: 'not_found' }
    })
  })

  it('supports dialogs, clipboard, key storage, and proxy calls', async () => {
    electronMocks.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ['/Users/x/library.json'] })
    electronMocks.showMessageBox.mockResolvedValue({ response: 1 })
    const safeStorage = makeSafeStorage()
    safeStorage.encrypt.mockReturnValue(Buffer.from('encrypted-key'))
    const setProxy = vi.fn().mockResolvedValue(undefined)
    const rpc = createNativeRpc({ safeStorage, setProxy, validatePath: (path) => path })

    await expect(rpc.invoke('/native/dialog-open-file', { title: 'Import', extensions: ['json'] })).resolves.toEqual({
      ok: true,
      data: { canceled: false, path: '/Users/x/library.json' }
    })
    await expect(rpc.invoke('/native/dialog-choose', {
      title: 'Choose', message: 'Choose one', buttons: ['A', 'B']
    })).resolves.toEqual({ ok: true, data: { response: 1 } })
    await expect(rpc.invoke('/native/clipboard-write', { text: 'hello' })).resolves.toEqual({
      ok: true,
      data: { written: true }
    })
    await expect(rpc.invoke('/native/encrypt-api-key', { apiKey: 'secret' })).resolves.toEqual({
      ok: true,
      data: { apiKeyEnc: Buffer.from('encrypted-key').toString('base64') }
    })
    await expect(rpc.invoke('/native/apply-proxy', { proxyRules: 'http://proxy.example:8080' })).resolves.toEqual({
      ok: true,
      data: { applied: true }
    })
    expect(electronMocks.writeText).toHaveBeenCalledWith('hello')
    expect(setProxy).toHaveBeenCalledWith('http://proxy.example:8080')
  })

  it('returns a cancellation envelope without invoking a pre-cancelled route', async () => {
    const controller = new AbortController()
    controller.abort()
    const rpc = setup()

    await expect(rpc.invoke('/native/trash-item', { path: '/x.pdf' }, controller.signal)).resolves.toEqual({
      ok: false,
      error: { code: 'connector_cancelled', message: 'Native RPC was cancelled: /native/trash-item' }
    })
    expect(electronMocks.trashItem).not.toHaveBeenCalled()
  })
})
