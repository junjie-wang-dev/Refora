export const contextMenuIconSources = {
  undo: 'ArrowCounterClockwise',
  redo: 'ArrowClockwise',
  cut: 'Scissors',
  copy: 'Copy',
  paste: 'Clipboard',
  selectAll: 'SelectionAll',
  add: 'Plus',
  addFile: 'FilePlus',
  addFolder: 'FolderPlus',
  workspace: 'SquaresFour',
  file: 'FileText',
  folder: 'Folder',
  open: 'ArrowSquareOut',
  reveal: 'FolderOpen',
  link: 'Link',
  quote: 'Quotes',
  refresh: 'ArrowClockwise',
  edit: 'PencilSimple',
  export: 'Download',
  delete: 'Trash',
  remove: 'Trash',
  category: 'Tag',
  note: 'NotePencil',
  sticky: 'Sticker',
  ai: 'Sparkle',
  highlight: 'Highlighter',
  underline: 'TextUnderline',
  strikeout: 'TextStrikethrough',
  summarize: 'ListBullets',
  explain: 'ChatText',
  title: 'TextT',
  authors: 'Users',
  year: 'CalendarBlank',
  venue: 'Books',
  addedAt: 'Clock',
  filePath: 'Folder'
} as const

export type ContextMenuIcon = keyof typeof contextMenuIconSources

export function isContextMenuIcon(value: unknown): value is ContextMenuIcon {
  return typeof value === 'string' && Object.hasOwn(contextMenuIconSources, value)
}
