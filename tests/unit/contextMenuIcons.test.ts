import { describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { nativeImage } from 'electron'
import { contextMenuIcon } from '../../src/main/services/contextMenuIcons'
import { contextMenuIconSources, type ContextMenuIcon } from '../../src/shared/contextMenuIcons'
import workspaceMenuIcons from '../../src/main/assets/workspaceMenuIcons'

vi.mock('electron', () => ({ nativeImage: {
  createMenuSymbol: vi.fn((symbol: string) => ({ symbol })),
  createEmpty: vi.fn(() => ({ addRepresentation: vi.fn(), setTemplateImage: vi.fn() }))
} }))

describe('native menu icons', () => {
  it('uses the toolbar artwork at standard and Retina resolutions as a cached template image', () => {
    expect(Object.keys(workspaceMenuIcons).sort()).toEqual(Object.keys(contextMenuIconSources).sort())
    const names = (Object.keys(contextMenuIconSources) as ContextMenuIcon[]).filter((name) => name !== 'open')
    for (const name of names) {
      const icon = contextMenuIcon(name)
      expect(icon?.addRepresentation).toHaveBeenCalledWith(workspaceMenuIcons[name][0])
      expect(icon?.addRepresentation).toHaveBeenCalledWith(workspaceMenuIcons[name][1])
      expect(icon?.setTemplateImage).toHaveBeenCalledWith(true)
      expect(contextMenuIcon(name)).toBe(icon)
    }
    expect(nativeImage.createEmpty).toHaveBeenCalledTimes(names.length)
    expect(nativeImage.createMenuSymbol).not.toHaveBeenCalled()
  })

  it('keeps generated images in sync with the Phosphor toolbar icons', () => {
    expect(() => execFileSync(process.execPath, ['scripts/generate-workspace-menu-icons.mjs', '--check'])).not.toThrow()
  })

  it('omits unknown icons', () => {
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
