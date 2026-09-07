export const contextMenuSymbols = {
  undo: 'arrow.uturn.backward',
  redo: 'arrow.uturn.forward',
  cut: 'scissors',
  copy: 'doc.on.doc',
  paste: 'doc.on.clipboard',
  selectAll: 'selection.pin.in.out',
  add: 'plus',
  addFile: 'doc.badge.plus',
  addFolder: 'folder.badge.plus',
  workspace: 'square.grid.2x2',
  file: 'doc.text',
  folder: 'folder',
  open: 'arrow.up.forward.square',
  reveal: 'folder',
  link: 'link',
  quote: 'quote.opening',
  refresh: 'arrow.clockwise',
  edit: 'square.and.pencil',
  export: 'square.and.arrow.up',
  delete: 'trash',
  remove: 'minus.circle',
  category: 'tag',
  note: 'note.text',
  sticky: 'note',
  ai: 'sparkles',
  highlight: 'highlighter',
  summarize: 'list.bullet',
  explain: 'text.bubble',
  title: 'textformat',
  authors: 'person.2',
  year: 'calendar',
  venue: 'books.vertical',
  addedAt: 'clock',
  filePath: 'folder'
} as const

export type ContextMenuIcon = keyof typeof contextMenuSymbols

export function isContextMenuIcon(value: unknown): value is ContextMenuIcon {
  return typeof value === 'string' && Object.hasOwn(contextMenuSymbols, value)
}
