import { create } from 'zustand'

export interface ChatDraftRequest {
  id: number
  mode: 'prefill' | 'append'
  text: string
}

interface ChatDraftState {
  pending: ChatDraftRequest | null
  request: (draft: Omit<ChatDraftRequest, 'id'>) => void
  consume: (id: number) => void
}

let nextChatDraftId = 0

export const useChatDraftStore = create<ChatDraftState>((set) => ({
  pending: null,
  request: (draft) => set({
    pending: {
      ...draft,
      id: ++nextChatDraftId
    }
  }),
  consume: (id) => set((state) => ({
    pending: state.pending?.id === id ? null : state.pending
  }))
}))
