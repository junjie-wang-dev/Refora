import { contextMenuIcon } from './contextMenuIcons'
import { Menu, type BrowserWindow, type ContextMenuParams, type MenuItemConstructorOptions } from 'electron'

export function editContextMenuTemplate(
  params: Pick<ContextMenuParams, 'isEditable' | 'selectionText' | 'editFlags'>,
  language: 'en' | 'zh'
): MenuItemConstructorOptions[] {
  if (!params.isEditable && !params.selectionText) return []
  const labels = language === 'zh'
    ? ['撤销', '重做', '剪切', '复制', '粘贴', '全选']
    : ['Undo', 'Redo', 'Cut', 'Copy', 'Paste', 'Select All']
  const flags = params.editFlags
  return [
    { role: 'undo', icon: contextMenuIcon('undo'), label: labels[0], enabled: flags.canUndo },
    { role: 'redo', icon: contextMenuIcon('redo'), label: labels[1], enabled: flags.canRedo },
    { type: 'separator' },
    { role: 'cut', icon: contextMenuIcon('cut'), label: labels[2], enabled: flags.canCut },
    { role: 'copy', icon: contextMenuIcon('copy'), label: labels[3], enabled: flags.canCopy },
    { role: 'paste', icon: contextMenuIcon('paste'), label: labels[4], enabled: flags.canPaste },
    { type: 'separator' },
    { role: 'selectAll', icon: contextMenuIcon('selectAll'), label: labels[5], enabled: flags.canSelectAll }
  ]
}

export function registerEditContextMenu(window: BrowserWindow, language: () => 'en' | 'zh'): void {
  window.webContents.on('context-menu', (_event, params) => {
    const template = editContextMenuTemplate(params, language())
    if (template.length > 0) Menu.buildFromTemplate(template).popup({ window })
  })
}
