import { lazy, Suspense } from 'react'
import { useSettingsModalStore } from '../store/settingsModalStore'

const SettingsModal = lazy(() => import('./SettingsModal'))
const AccountModal = lazy(() => import('./AccountModal'))

export default function SettingsModalHost() {
  const settingsOpen = useSettingsModalStore((state) => state.settingsOpen)
  const settingsPage = useSettingsModalStore((state) => state.settingsPage)
  const accountOpen = useSettingsModalStore((state) => state.accountOpen)
  const closeSettings = useSettingsModalStore((state) => state.closeSettings)
  const openAccount = useSettingsModalStore((state) => state.openAccount)
  const closeAccount = useSettingsModalStore((state) => state.closeAccount)

  return (
    <Suspense fallback={null}>
      {settingsOpen ? (
        <SettingsModal
          open
          onClose={closeSettings}
          initialPage={settingsPage}
          onOpenAccount={openAccount}
        />
      ) : null}
      {accountOpen ? (
        <AccountModal
          open
          onClose={closeAccount}
        />
      ) : null}
    </Suspense>
  )
}
