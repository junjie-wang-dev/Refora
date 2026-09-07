import { describe, expect, it, vi } from 'vitest'
import { editContextMenuTemplate } from '../../src/main/services/editContextMenu'

vi.mock('electron', () => ({
  Menu: { buildFromTemplate: vi.fn() },
  nativeImage: { createMenuSymbol: vi.fn((symbol: string) => ({ symbol })) }
}))

const flags = {
  canUndo: true, canRedo: false, canCut: true, canCopy: true,
  canPaste: true, canDelete: true, canSelectAll: true, canEditRichly: false
}

describe('native edit context menu', () => {
  it('offers localized native editing commands', () => {
    const items = editContextMenuTemplate({ isEditable: true, selectionText: 'text', editFlags: flags }, 'zh')
    expect(items.filter((item) => item.role).map((item) => [item.role, item.label])).toEqual([
      ['undo', '撤销'], ['redo', '重做'], ['cut', '剪切'], ['copy', '复制'], ['paste', '粘贴'], ['selectAll', '全选']
    ])
    expect(items.find((item) => item.role === 'copy')?.icon).toEqual({ symbol: 'doc.on.doc' })
    expect(items.find((item) => item.role === 'cut')?.icon).toEqual({ symbol: 'scissors' })
    expect(items.find((item) => item.role === 'redo')?.enabled).toBe(false)
  })

  it('disables unavailable actions and leaves read-only text copyable', () => {
    const items = editContextMenuTemplate({ isEditable: false, selectionText: 'read only', editFlags: { ...flags, canCut: false, canPaste: false } }, 'en')
    expect(items.find((item) => item.role === 'cut')?.enabled).toBe(false)
    expect(items.find((item) => item.role === 'paste')?.enabled).toBe(false)
    expect(items.find((item) => item.role === 'copy')?.enabled).toBe(true)
    expect(editContextMenuTemplate({ isEditable: false, selectionText: '', editFlags: flags }, 'en')).toEqual([])
  })
})
