import { create } from 'zustand'
import type { SyncAuthConfirmation, SyncServiceStatus } from '../../shared/sync-types'
import { api } from '../ipc'

interface SyncAccountState {
  status: SyncServiceStatus | null
  loading: boolean
  loadFailed: boolean
  confirmation: SyncAuthConfirmation | null
  load: () => Promise<void>
  setStatus: (status: SyncServiceStatus) => void
  setConfirmation: (confirmation: SyncAuthConfirmation) => void
  clearConfirmation: () => void
}

export const useSyncAccountStore = create<SyncAccountState>((set, get) => ({
  status: null,
  loading: false,
  loadFailed: false,
  confirmation: null,
  load: async () => {
    if (get().loading) return
    set({ loading: true, loadFailed: false })
    try {
      set({ status: await api.sync.status() })
    } catch {
      set({ status: null, loadFailed: true })
    } finally {
      set({ loading: false })
    }
  },
  setStatus: (status) => set({ status, loadFailed: false }),
  setConfirmation: (confirmation) => set({ confirmation }),
  clearConfirmation: () => set({ confirmation: null })
}))
