import { create } from 'zustand'
import type { QueuedChatMessage } from '../utils/chatUtils'

type Queues = Record<string, QueuedChatMessage[]>
type PausedQueues = Record<string, boolean>
type Update<T> = T | ((current: T) => T)

interface ChatQueueState {
  queues: Queues
  pausedQueues: PausedQueues
  setQueues: (update: Update<Queues>) => void
  setPausedQueues: (update: Update<PausedQueues>) => void
  reset: () => void
}

export const useChatQueueStore = create<ChatQueueState>((set) => ({
  queues: {},
  pausedQueues: {},
  setQueues: (update) => set((state) => ({
    queues: typeof update === 'function' ? update(state.queues) : update
  })),
  setPausedQueues: (update) => set((state) => ({
    pausedQueues: typeof update === 'function' ? update(state.pausedQueues) : update
  })),
  reset: () => set({ queues: {}, pausedQueues: {} })
}))
