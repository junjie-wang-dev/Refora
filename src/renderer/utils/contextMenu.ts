import type { ContextMenuIcon } from '../../shared/contextMenuIcons'
import type { NativeContextMenuItem } from '../../shared/ipc-types'
import i18n from '../i18n'
import { useDocumentStore } from '../store/documentStore'

export interface ContextMenuItem {
  key: string
  label?: string
  type?: 'divider' | 'submenu'
  disabled?: boolean
  checked?: boolean
  icon?: ContextMenuIcon
  danger?: boolean
  children?: ContextMenuItem[]
  onClick?: () => unknown
}

let requestSequence = 0

export function showContextMenu(items: ContextMenuItem[]): void {
  const sequence = ++requestSequence
  const actions = new Map<string, () => unknown>()
  const serialize = (entries: ContextMenuItem[], prefix = '', enabled = true): NativeContextMenuItem[] => entries.map((item, index) => {
    const id = `${prefix}${index}`
    const itemEnabled = enabled && !item.disabled
    if (item.onClick && itemEnabled && item.type !== 'divider' && item.type !== 'submenu') actions.set(id, item.onClick)
    return {
      id,
      label: item.label,
      icon: item.icon,
      type: item.type === 'divider' ? 'separator' : item.type === 'submenu' ? 'submenu' : item.checked !== undefined ? 'checkbox' : 'normal',
      enabled: itemEnabled,
      checked: item.checked,
      children: item.children ? serialize(item.children, `${id}.`, itemEnabled) : undefined
    }
  })
  void window.api.contextMenu.show(serialize(items)).then(async (id) => {
    if (sequence === requestSequence && id !== null) await actions.get(id)?.()
  }).catch(() => {
    useDocumentStore.getState().showToast(i18n.t('common.contextMenuFailed'))
  })
}
