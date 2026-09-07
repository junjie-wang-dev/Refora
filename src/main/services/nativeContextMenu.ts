import { contextMenuIcon } from './contextMenuIcons'
import { isContextMenuIcon } from '../../shared/contextMenuIcons'
import { Menu, type BrowserWindow, type MenuItemConstructorOptions } from 'electron'
import { IpcChannel } from '../../shared/ipc-channels'
import type { NativeContextMenuItem } from '../../shared/ipc-types'
import { resultify } from '../sidecar/ipc/result'

export function nativeContextMenuTemplate(
  input: unknown,
  select: (id: string) => void
): MenuItemConstructorOptions[] {
  let count = 0
  const ids = new Set<string>()
  const convert = (items: unknown, depth: number): MenuItemConstructorOptions[] => {
    if (!Array.isArray(items) || depth > 5) throw new Error('Invalid context menu')
    return items.map((value: unknown) => {
      if (++count > 300 || !value || typeof value !== 'object') throw new Error('Invalid context menu')
      const item = value as NativeContextMenuItem
      if (typeof item.id !== 'string' || item.id.length > 200 || ids.has(item.id)) throw new Error('Invalid menu item')
      ids.add(item.id)
      if (item.type === 'separator') return { type: 'separator' }
      if (
        (item.icon !== undefined && !isContextMenuIcon(item.icon)) ||
        typeof item.label !== 'string' || item.label.length > 1000 ||
        (item.type !== undefined && !['normal', 'checkbox', 'submenu'].includes(item.type)) ||
        (item.enabled !== undefined && typeof item.enabled !== 'boolean') ||
        (item.checked !== undefined && typeof item.checked !== 'boolean')
      ) throw new Error('Invalid menu item')
      const base = { label: item.label, enabled: item.enabled !== false, icon: contextMenuIcon(item.icon) }
      if (item.type === 'submenu') return { ...base, submenu: convert(item.children, depth + 1) }
      return {
        ...base,
        type: item.type === 'checkbox' ? 'checkbox' : 'normal',
        checked: item.checked,
        click: () => { if (base.enabled) select(item.id) }
      }
    })
  }
  return convert(input, 0)
}

export function createNativeContextMenuHandlers(getWindow: () => BrowserWindow | null) {
  let activeMenu: Menu | undefined
  return {
    [IpcChannel.ContextMenuShow]: (items: unknown) => resultify(async () => {
      const window = getWindow()
      if (!window || window.isDestroyed()) throw new Error('Main window is unavailable')
      return new Promise<string | null>((resolve) => {
        const template = nativeContextMenuTemplate(items, resolve)
        activeMenu?.closePopup(window)
        if (!template.length) { resolve(null); return }
        const menu = Menu.buildFromTemplate(template)
        activeMenu = menu
        menu.popup({ window, callback: () => {
          if (activeMenu === menu) activeMenu = undefined
          setImmediate(() => resolve(null))
        } })
      })
    })
  }
}
