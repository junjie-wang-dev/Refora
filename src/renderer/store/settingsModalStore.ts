import { create } from 'zustand'
import type { SettingsPage } from '../components/SettingsModal'

interface SettingsModalState {
  settingsOpen: boolean
  settingsPage: SettingsPage
  accountOpen: boolean
  openSettings: (page?: SettingsPage) => void
  closeSettings: () => void
  openAccount: () => void
  closeAccount: () => void
}

export const useSettingsModalStore = create<SettingsModalState>((set) => ({
  settingsOpen: false,
  settingsPage: 'general',
  accountOpen: false,
  openSettings: (page = 'general') => set({
    settingsOpen: true,
    settingsPage: page,
    accountOpen: false
  }),
  closeSettings: () => set({ settingsOpen: false }),
  openAccount: () => set({ settingsOpen: false, accountOpen: true }),
  closeAccount: () => set({ accountOpen: false })
}))
