import { describe, expect, it, vi } from 'vitest'
import type { BrowserWindow, MenuItemConstructorOptions } from 'electron'
import { Menu } from 'electron'
import { nativeContextMenuTemplate, createNativeContextMenuHandlers } from '../../src/main/services/nativeContextMenu'
import { IpcChannel } from '../../src/shared/ipc-channels'

vi.mock('electron', () => ({
  Menu: { buildFromTemplate: vi.fn() },
  nativeImage: { createMenuSymbol: vi.fn((symbol: string) => ({ symbol })) }
}))

describe('native context menus', () => {
  it('preserves separators, checkmarks, disabled items, and submenu actions', () => {
    const select = vi.fn()
    const template = nativeContextMenuTemplate([
      { id: 'columns', label: '标题', type: 'checkbox', checked: true },
      { id: 'divider', type: 'separator' },
      { id: 'ai', label: 'AI', icon: 'ai', type: 'submenu', children: [{ id: 'summary', label: '总结', icon: 'summarize' }] },
      { id: 'disabled', label: '复制', enabled: false }
    ], select)
    expect(template[0]).toMatchObject({ label: '标题', type: 'checkbox', checked: true })
    expect(template[1]).toEqual({ type: 'separator' })
    const child = (template[2].submenu as MenuItemConstructorOptions[])[0]
    expect(template[2].icon).toEqual({ symbol: 'sparkles' })
    expect(child.icon).toEqual({ symbol: 'list.bullet' })
    child.click?.(null as never, null as never, null as never)
    template[3].click?.(null as never, null as never, null as never)
    expect(select.mock.calls).toEqual([['summary']])
  })

  it('rejects malformed, duplicate, deeply nested and oversized requests', () => {
    const nested = (depth: number): unknown => depth ? [{ id: String(depth), label: 'AI', type: 'submenu', children: nested(depth - 1) }] : []
    for (const value of [null, [{ id: 'x', label: 'Copy', icon: '/tmp/image.png' }], [{ id: 'x', label: 4 }], [{ id: 'x', label: 'A' }, { id: 'x', label: 'B' }], nested(7), Array.from({ length: 301 }, (_, id) => ({ id: String(id), label: 'Item' }))]) {
      expect(() => nativeContextMenuTemplate(value, vi.fn())).toThrow()
    }
  })

  it('returns the selected action even if the native close callback fires first', async () => {
    vi.mocked(Menu.buildFromTemplate).mockImplementation((template) => ({
      popup: ({ callback }: { callback: () => void }) => {
        callback()
        template[0].click?.(null as never, null as never, null as never)
      }
    }) as never)
    const handler = createNativeContextMenuHandlers(() => ({ isDestroyed: () => false }) as BrowserWindow)[IpcChannel.ContextMenuShow]
    expect(await handler([{ id: 'copy', label: 'Copy' }])).toEqual({ ok: true, data: 'copy' })
  })

  it('returns null when dismissed and typed failures for invalid requests or closed windows', async () => {
    vi.mocked(Menu.buildFromTemplate).mockReturnValue({ popup: ({ callback }: { callback: () => void }) => callback() } as never)
    const handler = createNativeContextMenuHandlers(() => ({ isDestroyed: () => false }) as BrowserWindow)[IpcChannel.ContextMenuShow]
    expect(await handler([{ id: 'copy', label: 'Copy' }])).toEqual({ ok: true, data: null })
    expect(await handler(null)).toMatchObject({ ok: false })
    expect(await createNativeContextMenuHandlers(() => null)[IpcChannel.ContextMenuShow]([])).toMatchObject({ ok: false })
  })
})
