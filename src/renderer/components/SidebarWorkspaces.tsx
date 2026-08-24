import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, PencilSimple, Trash, SquaresFour } from '@phosphor-icons/react'
import { showContextMenu } from '@lobehub/ui'
import type { ContextMenuItem } from '@lobehub/ui'
import { useWorkspaceStore } from '../store/workspaceStore'
import { useConfirmStore } from '../store/confirmStore'
import type { Workspace } from '../../shared/ipc-types'
import { Button as UiButton, Input as UiInput } from './ui'
import { SidebarItem, SidebarSection } from './sidebarShared'
import { useInlineNamedEntityEditor } from '../hooks/useInlineNamedEntityEditor'

const workspaceName = (workspace: Workspace) => workspace.name

export default function SidebarWorkspaces() {
  const { t } = useTranslation()
  const showConfirm = useConfirmStore((s) => s.show)

  const workspaces = useWorkspaceStore((s) => s.workspaces)
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId)
  const requestActiveWorkspace = useWorkspaceStore((s) => s.requestActiveWorkspace)
  const chatStreaming = useWorkspaceStore((s) => s.chatStreaming)
  const createWorkspace = useWorkspaceStore((s) => s.createWorkspace)
  const renameWorkspace = useWorkspaceStore((s) => s.renameWorkspace)
  const deleteWorkspace = useWorkspaceStore((s) => s.deleteWorkspace)

  const editor = useInlineNamedEntityEditor({
    nameOf: workspaceName,
    onCreate: createWorkspace,
    onRename: renameWorkspace
  })
  const {
    creating: wsCreating,
    renamingId: wsRenamingId,
    draftName: wsDraftName,
    setDraftName: setWsDraftName,
    newInputRef: wsNewInputRef,
    renameInputRef: wsRenameInputRef,
    startCreate: startWsCreate,
    startRename: startWsRename,
    commitCreate: commitWsCreate,
    commitRename: commitWsRename,
    cancelCreate: cancelWsCreate,
    cancelRename: cancelWsRename
  } = editor

  const confirmDeleteWorkspace = useCallback(async (ws: Workspace) => {
    await deleteWorkspace(ws.id)
  }, [deleteWorkspace])

  const handleWsSectionContext = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      const items: ContextMenuItem[] = [
        {
          key: 'create',
          label: t('sidebar.createWorkspace'),
          icon: <Plus className="h-3.5 w-3.5" />,
          onClick: startWsCreate,
        },
      ]
      showContextMenu(items)
    },
    [t, startWsCreate]
  )

  const handleWsItemContext = useCallback(
    (e: React.MouseEvent, ws: Workspace) => {
      e.preventDefault()
      e.stopPropagation()
      const items: ContextMenuItem[] = [
        {
          key: 'create',
          label: t('sidebar.createWorkspace'),
          icon: <Plus className="h-3.5 w-3.5" />,
          onClick: startWsCreate,
        },
        {
          key: 'rename',
          label: t('sidebar.renameWorkspace'),
          icon: <PencilSimple className="h-3.5 w-3.5" />,
          onClick: () => startWsRename(ws),
        },
        {
          key: 'delete',
          label: t('sidebar.deleteWorkspace'),
          icon: <Trash className="h-3.5 w-3.5" />,
          onClick: () => showConfirm({
            title: t('common.delete'),
            message: t('sidebar.deleteWorkspaceConfirm', { name: ws.name }),
            confirmText: t('common.delete'),
            cancelText: t('common.cancel'),
            danger: true,
            onConfirm: () => void confirmDeleteWorkspace(ws)
          }),
          danger: true,
        },
      ]
      showContextMenu(items)
    },
    [t, startWsCreate, startWsRename, showConfirm, confirmDeleteWorkspace]
  )

  return (
    <SidebarSection
      title={t('sidebar.workspaces')}
      onContextMenu={handleWsSectionContext}
      action={
        <UiButton
          variant="ghost"
          size="sm"
          iconOnly
          className="no-drag -mr-1 text-muted transition-colors duration-150 hover:text-foreground"
          onClick={startWsCreate}
          title={t('sidebar.createWorkspace')}
          aria-label={t('sidebar.createWorkspace')}
        >
          <Plus className="h-3.5 w-3.5" />
        </UiButton>
      }
    >
      {wsCreating && (
        <UiInput
          ref={wsNewInputRef}
          variant="outlined"
          inputSize="sm"
          className="no-drag mb-1"
          placeholder={t('sidebar.workspaceName')}
          value={wsDraftName}
          onChange={(e) => setWsDraftName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); void commitWsCreate() }
            if (e.key === 'Escape') { e.preventDefault(); cancelWsCreate() }
          }}
          onBlur={() => void commitWsCreate()}
        />
      )}
      {workspaces.length === 0 && !wsCreating ? (
        <div className="px-2 py-1 text-label italic text-muted">
          {t('sidebar.emptyWorkspaces')}
        </div>
      ) : (
        workspaces.map((w) => {
          const isRenaming = wsRenamingId === w.id
          return (
            <div key={w.id} className="relative">
              {isRenaming ? (
                <UiInput
                  ref={wsRenameInputRef}
                  variant="outlined"
                  inputSize="sm"
                  className="no-drag"
                  value={wsDraftName}
                  onChange={(e) => setWsDraftName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') { e.preventDefault(); void commitWsRename(w) }
                    if (e.key === 'Escape') { e.preventDefault(); cancelWsRename() }
                  }}
                  onBlur={() => void commitWsRename(w)}
                />
              ) : (
                <SidebarItem
                  icon={<SquaresFour className="h-4 w-4" />}
                  label={w.name}
                  active={activeWorkspaceId === w.id}
                  disabled={chatStreaming && activeWorkspaceId !== w.id}
                  onClick={() => void requestActiveWorkspace(w.id)}
                  onContextMenu={(e) => handleWsItemContext(e, w)}
                />
              )}
            </div>
          )
        })
      )}
    </SidebarSection>
  )
}
