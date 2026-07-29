import type { WorkspaceStickyColor } from '../../../shared/ipc-types'

export const STICKY_NOTE_COLORS = [
  { id: 'sand', label: 'Sand', value: '#F2E4C4' },
  { id: 'lemon', label: 'Lemon', value: '#FFF0A8' },
  { id: 'coral', label: 'Coral', value: '#FFC9BD' },
  { id: 'rose', label: 'Rose', value: '#F5D0E2' },
  { id: 'mint', label: 'Mint', value: '#C9E9DA' },
  { id: 'sky', label: 'Sky', value: '#CBE4FA' },
  { id: 'lavender', label: 'Lavender', value: '#DED4F7' },
  { id: 'slate', label: 'Slate', value: '#D9E0E7' }
] as const satisfies ReadonlyArray<{
  id: WorkspaceStickyColor
  label: string
  value: string
}>

export function stickyNoteColorValue(color: WorkspaceStickyColor | undefined): string {
  return STICKY_NOTE_COLORS.find((option) => option.id === color)?.value
    ?? STICKY_NOTE_COLORS[0].value
}
