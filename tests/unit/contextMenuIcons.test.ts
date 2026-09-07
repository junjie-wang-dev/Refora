import { describe, expect, it, vi } from 'vitest'
import { nativeImage } from 'electron'
import { contextMenuIcon } from '../../src/main/services/contextMenuIcons'

vi.mock('electron', () => ({ nativeImage: { createMenuSymbol: vi.fn((symbol: string) => ({ symbol })) } }))

describe('native menu icons', () => {
  it('uses cached system symbols for known actions and omits unknown icons', () => {
    expect(contextMenuIcon('copy')).toEqual({ symbol: 'doc.on.doc' })
    expect(contextMenuIcon('copy')).toBe(contextMenuIcon('copy'))
    expect(nativeImage.createMenuSymbol).toHaveBeenCalledTimes(1)
    expect(contextMenuIcon('constructor')).toBeUndefined()
    expect(contextMenuIcon('/tmp/icon.png')).toBeUndefined()
    expect(contextMenuIcon(undefined)).toBeUndefined()
  })

  it('keeps menu actions available if an OS symbol cannot be created', () => {
    vi.mocked(nativeImage.createMenuSymbol).mockImplementationOnce(() => { throw new Error('Unavailable symbol') })
    expect(contextMenuIcon('sticky')).toBeUndefined()
    expect(contextMenuIcon('sticky')).toBeUndefined()
  })
})
