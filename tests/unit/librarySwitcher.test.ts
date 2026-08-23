import { describe, expect, it, vi } from 'vitest'
import { createLibrarySwitcher } from '../../src/main/services/librarySwitcher'
import type { ServerAssembly } from '../../src/main/sidecar/assembly'

function assembly(options: { start?: () => Promise<void>; stop?: () => Promise<void> } = {}) {
  return {
    start: vi.fn(options.start ?? (async () => undefined)),
    stop: vi.fn(options.stop ?? (async () => undefined)),
    getClient: vi.fn(() => ({
      http: {
        importFolder: vi.fn(async () => ({ added: [], skipped: [], errors: [] }))
      }
    })),
    fetchResource: vi.fn()
  } as unknown as ServerAssembly
}

describe('library switcher', () => {
  it('restores the previous library when the target fails to start', async () => {
    const previous = assembly()
    const target = assembly({ start: async () => { throw new Error('target failed') } })
    const restored = assembly()
    let state = { assembly: previous as ServerAssembly | null, dbPath: '/old/db', libraryFolder: '/old' }
    const createAssembly = vi.fn()
      .mockResolvedValueOnce(target)
      .mockResolvedValueOnce(restored)
    const switchLibrary = createLibrarySwitcher({
      resolveFolder: (folder) => folder,
      isDirectory: () => true,
      dbPathForFolder: () => '/new/db',
      dbExistsInFolder: () => true,
      createAssembly,
      getState: () => state,
      setState: (next) => { state = next },
      persistLibraryFolder: vi.fn(),
      emitSwitched: vi.fn(),
      onRecoveryFailed: vi.fn()
    })

    await expect(switchLibrary('/new')).rejects.toThrow('target failed')

    expect(previous.stop).toHaveBeenCalledOnce()
    expect(restored.start).toHaveBeenCalledOnce()
    expect(state).toEqual({ assembly: restored, dbPath: '/old/db', libraryFolder: '/old' })
  })

  it('clears the stopped assembly and enters recovery when rollback fails', async () => {
    const previous = assembly()
    const target = assembly({ start: async () => { throw new Error('target failed') } })
    const restored = assembly({ start: async () => { throw new Error('restore failed') } })
    let state = { assembly: previous as ServerAssembly | null, dbPath: '/old/db', libraryFolder: '/old' }
    const onRecoveryFailed = vi.fn()
    const createAssembly = vi.fn()
      .mockResolvedValueOnce(target)
      .mockResolvedValueOnce(restored)
    const switchLibrary = createLibrarySwitcher({
      resolveFolder: (folder) => folder,
      isDirectory: () => true,
      dbPathForFolder: () => '/new/db',
      dbExistsInFolder: () => true,
      createAssembly,
      getState: () => state,
      setState: (next) => { state = next },
      persistLibraryFolder: vi.fn(),
      emitSwitched: vi.fn(),
      onRecoveryFailed
    })

    await expect(switchLibrary('/new')).rejects.toMatchObject({
      code: 'library_recovery_failed'
    })

    expect(state).toEqual({ assembly: null, dbPath: '/old/db', libraryFolder: '/old' })
    expect(onRecoveryFailed).toHaveBeenCalledOnce()
  })

  it('reactivates the previous library settings when target activation fails', async () => {
    const previous = assembly()
    const target = assembly()
    const restored = assembly()
    let state = { assembly: previous as ServerAssembly | null, dbPath: '/old/db', libraryFolder: '/old' }
    const createAssembly = vi.fn()
      .mockResolvedValueOnce(target)
      .mockResolvedValueOnce(restored)
    const activateAssembly = vi.fn()
      .mockRejectedValueOnce(new Error('target settings failed'))
      .mockResolvedValueOnce(undefined)
    const switchLibrary = createLibrarySwitcher({
      resolveFolder: (folder) => folder,
      isDirectory: () => true,
      dbPathForFolder: () => '/new/db',
      dbExistsInFolder: () => true,
      createAssembly,
      activateAssembly,
      getState: () => state,
      setState: (next) => { state = next },
      persistLibraryFolder: vi.fn(),
      emitSwitched: vi.fn(),
      onRecoveryFailed: vi.fn()
    })

    await expect(switchLibrary('/new')).rejects.toThrow('target settings failed')

    expect(activateAssembly).toHaveBeenNthCalledWith(1, target)
    expect(activateAssembly).toHaveBeenNthCalledWith(2, restored)
    expect(target.stop).toHaveBeenCalledOnce()
    expect(state).toEqual({ assembly: restored, dbPath: '/old/db', libraryFolder: '/old' })
  })

  it('does not stop the active library when renderer persistence cannot flush', async () => {
    const previous = assembly()
    const beforeSwitch = vi.fn().mockRejectedValue(new Error('unsaved draft'))
    let state = { assembly: previous as ServerAssembly | null, dbPath: '/old/db', libraryFolder: '/old' }
    const createAssembly = vi.fn()
    const switchLibrary = createLibrarySwitcher({
      resolveFolder: (folder) => folder,
      isDirectory: () => true,
      dbPathForFolder: () => '/new/db',
      dbExistsInFolder: () => true,
      createAssembly,
      beforeSwitch,
      getState: () => state,
      setState: (next) => { state = next },
      persistLibraryFolder: vi.fn(),
      emitSwitched: vi.fn(),
      onRecoveryFailed: vi.fn()
    })

    await expect(switchLibrary('/new')).rejects.toThrow('unsaved draft')

    expect(previous.stop).not.toHaveBeenCalled()
    expect(createAssembly).not.toHaveBeenCalled()
    expect(state.assembly).toBe(previous)
  })

  it('restores the active library and rejects when the preference cannot be persisted', async () => {
    const previous = assembly()
    const target = assembly()
    const restored = assembly()
    let state = { assembly: previous as ServerAssembly | null, dbPath: '/old/db', libraryFolder: '/old' }
    const persistLibraryFolder = vi.fn(() => {
      throw new Error('preference disk full')
    })
    const emitSwitched = vi.fn()
    const switchLibrary = createLibrarySwitcher({
      resolveFolder: (folder) => folder,
      isDirectory: () => true,
      dbPathForFolder: () => '/new/db',
      dbExistsInFolder: () => true,
      createAssembly: vi.fn()
        .mockResolvedValueOnce(target)
        .mockResolvedValueOnce(restored),
      getState: () => state,
      setState: (next) => { state = next },
      persistLibraryFolder,
      emitSwitched,
      onRecoveryFailed: vi.fn()
    })

    await expect(switchLibrary('/new')).rejects.toThrow('preference disk full')

    expect(target.stop).toHaveBeenCalledOnce()
    expect(restored.start).toHaveBeenCalledOnce()
    expect(state).toEqual({ assembly: restored, dbPath: '/old/db', libraryFolder: '/old' })
    expect(emitSwitched).not.toHaveBeenCalled()
  })
})
