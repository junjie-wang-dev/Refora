import { lazy, Suspense, useState, useCallback, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { FilePlus, FileArrowDown, ArrowLineLeft, ArrowLineRight, CircleNotch } from '@phosphor-icons/react'
import { useDocumentStore } from '../store/documentStore'
import { errorMessage } from '../../shared/ipc-types'
import type { SettingsPage } from './SettingsModal'
import { Button as UiButton, IconTooltip } from './ui'
import { api } from '../ipc'
import { IpcChannel } from '../../shared/ipc-channels'
import SidebarSmartItems from './SidebarSmartItems'
import SidebarWorkspaces from './SidebarWorkspaces'
import SidebarCategories from './SidebarCategories'
import SidebarFooter from './SidebarFooter'
import { useSyncAccountStore } from '../store/syncAccountStore'

const SettingsModal = lazy(() => import('./SettingsModal'))
const AccountModal = lazy(() => import('./AccountModal'))
const ImportByIdentifierDialog = lazy(() => import('./ImportByIdentifierDialog'))

interface SidebarProps {
  collapsed: boolean
  onToggleCollapse: () => void
}



export default function Sidebar({ collapsed, onToggleCollapse }: SidebarProps) {
  const { t } = useTranslation()
  const fetchDocuments = useDocumentStore((s) => s.fetchDocuments)
  const importProgress = useDocumentStore((s) => s.importProgress)
  const identifierImporting = useDocumentStore((s) => s.identifierImporting)
  const setAuthConfirmation = useSyncAccountStore((state) => state.setConfirmation)
  const [showSettings, setShowSettings] = useState(false)
  const [settingsPage, setSettingsPage] = useState<SettingsPage>('general')
  const [showAccount, setShowAccount] = useState(false)
  const [showIdentifierImport, setShowIdentifierImport] = useState(false)
  const isMac = document.documentElement.dataset.platform === 'mac'

  const openSettings = useCallback((page: SettingsPage) => {
    setShowAccount(false)
    setSettingsPage(page)
    setShowSettings(true)
  }, [])

  const openAccount = useCallback(() => {
    setShowSettings(false)
    setShowAccount(true)
  }, [])

  const handleAddFiles = useCallback(async () => {
    try {
      await api.import.addFiles([])
    } catch (e) { useDocumentStore.getState().showToast(errorMessage(e, 'Failed to import files')) }
    void fetchDocuments()
  }, [fetchDocuments])

  const handleImportFromIdentifier = useCallback(() => {
    setShowIdentifierImport(true)
  }, [])

  useEffect(() => {
    const cb = () => setShowIdentifierImport(true)
    api.events.onMenuImportIdentifier(cb)
    return () => api.events.off(IpcChannel.EventMenuImportIdentifier, cb)
  }, [])

  useEffect(() => {
    const cb = (confirmation: Parameters<typeof setAuthConfirmation>[0]) => {
      setAuthConfirmation(confirmation)
      openAccount()
    }
    api.events.onSyncAuthConfirmation(cb)
    return () => api.events.off(IpcChannel.EventSyncAuthConfirmation, cb)
  }, [openAccount, setAuthConfirmation])

  if (collapsed) {
    const toolbarLeft = isMac ? 92 : 8
    const toolbar = (
      <div
        className="sidebar-floating-toolbar drag-region"
        style={{ left: `${toolbarLeft}px` }}
      >
        <IconTooltip label={t('tooltip.expandSidebar')} appearance="sidebar">
          <UiButton
            variant="ghost"
            size="sm"
            iconOnly
            onClick={onToggleCollapse}
            aria-label={t('tooltip.expandSidebar')}
          >
            <ArrowLineRight className="h-4 w-4" />
          </UiButton>
        </IconTooltip>
        <div className="toolbar-sep" aria-hidden="true" />
        <IconTooltip label={t('tooltip.addFile')} appearance="sidebar" shortcut="⌘I">
          <UiButton
            variant="ghost"
            size="sm"
            iconOnly
            onClick={handleAddFiles}
            aria-label={t('tooltip.addFile')}
          >
            <FilePlus className="h-4 w-4" />
          </UiButton>
        </IconTooltip>
        <IconTooltip label={t('tooltip.importFromIdentifier')} appearance="sidebar" shortcut="⌘⇧I">
          <UiButton
            variant="ghost"
            size="sm"
            iconOnly
            onClick={handleImportFromIdentifier}
            aria-label={t('tooltip.importFromIdentifier')}
          >
            {identifierImporting > 0
              ? <CircleNotch className="h-4 w-4 animate-spin text-muted" />
              : <FileArrowDown className="h-4 w-4" />}
          </UiButton>
        </IconTooltip>
      </div>
    )
    return (
      <>
        {toolbar}
        <Suspense fallback={null}>
          {showSettings ? (
            <SettingsModal
              open
              onClose={() => setShowSettings(false)}
              initialPage={settingsPage}
              onOpenAccount={openAccount}
            />
          ) : null}
          {showAccount ? (
            <AccountModal
              open
              onClose={() => setShowAccount(false)}
              onOpenSyncSettings={() => openSettings('sync')}
            />
          ) : null}
          {showIdentifierImport ? (
            <ImportByIdentifierDialog open onClose={() => setShowIdentifierImport(false)} />
          ) : null}
        </Suspense>
      </>
    )
  }

  return (
    <aside className="sidebar-floating flex h-full w-full shrink-0 flex-col">
      <div className="drag-region flex h-10 shrink-0 items-center px-2">
        <div className="ml-auto mr-2 flex items-center gap-3 no-drag">
          <IconTooltip label={t('tooltip.collapseSidebar')} appearance="sidebar">
            <UiButton
              variant="ghost"
              size="sm"
              iconOnly
              onClick={onToggleCollapse}
              aria-label={t('tooltip.collapseSidebar')}
            >
              <ArrowLineLeft className="h-4 w-4" />
            </UiButton>
          </IconTooltip>
          <IconTooltip label={t('tooltip.addFile')} appearance="sidebar" shortcut="⌘I">
            <UiButton
              variant="ghost"
              size="sm"
              iconOnly
              onClick={handleAddFiles}
              aria-label={t('tooltip.addFile')}
            >
              <FilePlus className="h-4 w-4" />
            </UiButton>
          </IconTooltip>
          <IconTooltip label={t('tooltip.importFromIdentifier')} appearance="sidebar" shortcut="⌘⇧I">
            <UiButton
              variant="ghost"
              size="sm"
              iconOnly
              onClick={handleImportFromIdentifier}
              aria-label={t('tooltip.importFromIdentifier')}
            >
              {identifierImporting > 0
                ? <CircleNotch className="h-4 w-4 animate-spin text-muted" />
                : <FileArrowDown className="h-4 w-4" />}
            </UiButton>
          </IconTooltip>
        </div>
      </div>

      {importProgress && (
        <div className="mx-2 mb-1 flex items-center gap-2 text-label text-muted">
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-panel-2">
            <div
              className="h-full rounded-full bg-accent transition-all duration-200"
              style={{
                width: `${importProgress.total > 0 ? (importProgress.current / importProgress.total) * 100 : 0}%`
              }}
            />
          </div>
          <span className="whitespace-nowrap">
            {t('topbar.importing', { current: importProgress.current, total: importProgress.total })}
          </span>
        </div>
      )}

      {identifierImporting > 0 && (
        <div className="mx-2 mb-1 flex items-center gap-2 text-label text-muted">
          <CircleNotch className="h-3.5 w-3.5 shrink-0 animate-spin text-muted" />
          <span className="truncate">{t('identifierImport.importing')}</span>
        </div>
      )}

      <nav className="min-h-0 flex-1 overflow-y-auto py-2">
        <SidebarSmartItems />
        <SidebarWorkspaces />
        <SidebarCategories />
      </nav>

      <SidebarFooter
        onOpenAccount={openAccount}
        onOpenSettings={() => openSettings('general')}
      />


      <Suspense fallback={null}>
        {showSettings ? (
          <SettingsModal
            open
            onClose={() => setShowSettings(false)}
            initialPage={settingsPage}
            onOpenAccount={openAccount}
          />
        ) : null}
        {showAccount ? (
          <AccountModal
            open
            onClose={() => setShowAccount(false)}
            onOpenSyncSettings={() => openSettings('sync')}
          />
        ) : null}
        {showIdentifierImport ? (
          <ImportByIdentifierDialog open onClose={() => setShowIdentifierImport(false)} />
        ) : null}
      </Suspense>
    </aside>
  )
}
