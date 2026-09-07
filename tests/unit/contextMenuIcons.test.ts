import { describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { nativeImage } from 'electron'
import { contextMenuIcon } from '../../src/main/services/contextMenuIcons'
import workspaceMenuIcons from '../../src/main/assets/workspaceMenuIcons'

vi.mock('electron', () => ({ nativeImage: {
  createMenuSymbol: vi.fn((symbol: string) => ({ symbol })),
  createEmpty: vi.fn(() => ({ addRepresentation: vi.fn(), setTemplateImage: vi.fn() }))
} }))

describe('native menu icons', () => {
  it('uses the toolbar artwork at standard and Retina resolutions as a cached template image', () => {
    for (const name of ['addFile', 'note', 'sticky'] as const) {
      const icon = contextMenuIcon(name)
      expect(icon?.addRepresentation).toHaveBeenCalledWith(workspaceMenuIcons[name][0])
      expect(icon?.addRepresentation).toHaveBeenCalledWith(workspaceMenuIcons[name][1])
      expect(icon?.setTemplateImage).toHaveBeenCalledWith(true)
      expect(contextMenuIcon(name)).toBe(icon)
    }
    expect(nativeImage.createEmpty).toHaveBeenCalledTimes(3)
  })

  it('keeps generated images in sync with the Phosphor toolbar icons', () => {
    expect(() => execFileSync(process.execPath, ['scripts/generate-workspace-menu-icons.mjs', '--check'])).not.toThrow()
  })

  it('retains system symbols for other actions and omits unknown icons', () => {
    expect(contextMenuIcon('cut')).toEqual({ symbol: 'scissors' })
    expect(contextMenuIcon('constructor')).toBeUndefined()
    expect(contextMenuIcon('/tmp/icon.png')).toBeUndefined()
    expect(contextMenuIcon(undefined)).toBeUndefined()
  })

  it('keeps menu actions available if an icon cannot be created', () => {
    vi.mocked(nativeImage.createEmpty).mockImplementationOnce(() => { throw new Error('Unavailable image') })
    expect(contextMenuIcon('open')).toBeUndefined()
    expect(contextMenuIcon('open')).toBeUndefined()
  })
})
