import { create } from 'zustand'
import type { LatexChatContext } from '../../shared/latex-types'

export const useLatexContextStore = create<{ active: (LatexChatContext & { workspaceId: string }) | null }>(() => ({ active: null }))
