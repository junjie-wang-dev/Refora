import { useState, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ClockCounterClockwise,
  PencilSimple,
  Download,
  Trash
} from '@phosphor-icons/react'
import { useClickOutside } from '../../hooks/useClickOutside'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { useConfirmStore } from '../../store/confirmStore'
import { Button as UiButton, Input as UiInput } from '../ui'

export interface ThreadHistoryProps {
  streaming: boolean
  onExportThread: (threadId: string) => Promise<void>
  menuOpen: boolean
  onMenuOpenChange: (open: boolean) => void
}

export default function ThreadHistory({
  streaming,
  onExportThread,
  menuOpen,
  onMenuOpenChange
}: ThreadHistoryProps) {
  const { t } = useTranslation()
  const threads = useWorkspaceStore((s) => s.threads)
  const activeThreadId = useWorkspaceStore((s) => s.activeThreadId)
  const setActiveThreadId = useWorkspaceStore((s) => s.setActiveThreadId)
  const fetchThreads = useWorkspaceStore((s) => s.fetchThreads)
  const deleteThread = useWorkspaceStore((s) => s.deleteThread)
  const renameThread = useWorkspaceStore((s) => s.renameThread)
  const showConfirm = useConfirmStore((s) => s.show)

  const threadMenuRef = useRef<HTMLDivElement | null>(null)
  const [renamingThreadId, setRenamingThreadId] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')

  useClickOutside(threadMenuRef, () => onMenuOpenChange(false), menuOpen)

  return (
    <>
      <div className="relative" ref={threadMenuRef}>
        <UiButton
          variant="ghost"
          size="sm"
          iconOnly
          onClick={() => onMenuOpenChange(!menuOpen)}
          title={t('workspace.chat.threadHistory', 'Thread history')}
          aria-label={t('workspace.chat.threadHistory', 'Thread history')}
          disabled={streaming}
        >
          <ClockCounterClockwise className="h-4 w-4" />
        </UiButton>
        {menuOpen && (
          <div className="absolute right-0 top-full z-50 mt-1 max-h-64 w-56 overflow-y-auto rounded-lg border border-border bg-panel shadow-lg">
            {threads.length === 0 ? (
              <p className="px-3 py-2 text-label text-muted">
                {t('workspace.chat.noThreads', 'No conversations yet')}
              </p>
            ) : (
              threads.map((th) => (
                <div
                  key={th.id}
                  className={`flex items-center gap-1 px-2 py-1.5 text-label transition-colors duration-150 hover:bg-hover ${
                    th.id === activeThreadId ? 'bg-active text-foreground' : 'text-muted'
                  }`}
                >
                  {renamingThreadId === th.id ? (
                    <UiInput
                      variant="outlined"
                      inputSize="sm"
                      className="min-w-0 flex-1 border-accent"
                      value={renameDraft}
                      autoFocus
                      onChange={(e) => setRenameDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault()
                          if (renameDraft.trim()) {
                            void renameThread(th.id, renameDraft.trim())
                          }
                          setRenamingThreadId(null)
                        }
                        if (e.key === 'Escape') {
                          e.preventDefault()
                          setRenamingThreadId(null)
                        }
                      }}
                      onBlur={() => {
                        if (renameDraft.trim() && renameDraft.trim() !== th.title) {
                          void renameThread(th.id, renameDraft.trim())
                        }
                        setRenamingThreadId(null)
                      }}
                    />
                  ) : (
                    <button
                      type="button"
                      className={`min-w-0 flex-1 truncate text-left ${
                        streaming ? 'cursor-not-allowed opacity-50' : ''
                      }`}
                      disabled={streaming}
                      onClick={() => {
                        setActiveThreadId(th.id)
                        onMenuOpenChange(false)
                      }}
                    >
                      {th.title?.trim() || `${t('workspace.chat.thread', 'Thread')} ${th.id.slice(0, 8)}`}
                    </button>
                  )}
                  {renamingThreadId !== th.id && (
                    <button
                      type="button"
                      className="shrink-0 text-muted transition-colors duration-150 hover:text-foreground"
                      onClick={(e) => {
                        e.stopPropagation()
                        setRenamingThreadId(th.id)
                        setRenameDraft(th.title?.trim() || '')
                      }}
                      title={t('common.rename', 'Rename')}
                      aria-label={t('common.rename', 'Rename')}
                    >
                      <PencilSimple className="h-3 w-3" />
                    </button>
                  )}
                  {renamingThreadId !== th.id && (
                    <button
                      type="button"
                      className="shrink-0 text-muted transition-colors duration-150 hover:text-error"
                      onClick={(e) => {
                        e.stopPropagation()
                        const threadTitle = th.title?.trim() || `${t('workspace.chat.thread', 'Thread')} ${th.id.slice(0, 8)}`
                        showConfirm({
                          title: t('common.delete'),
                          message: t('workspace.chat.confirmDeleteThread', { name: threadTitle, defaultValue: 'Delete "{{name}}"?' }),
                          confirmText: t('common.delete'),
                          cancelText: t('common.cancel'),
                          danger: true,
                          onConfirm: () => {
                            void deleteThread(th.id).then(() =>
                              void fetchThreads({ selectLatestIfNone: true })
                            )
                          }
                        })
                      }}
                      title={t('common.delete', 'Delete')}
                      aria-label={t('common.delete', 'Delete')}
                    >
                      <Trash className="h-3 w-3" />
                    </button>
                  )}
                </div>
              ))
            )}
            {threads.length > 0 && activeThreadId && (
              <button
                type="button"
                className="flex w-full items-center gap-1.5 border-t border-border px-2 py-1.5 text-label text-muted transition-colors duration-150 hover:bg-hover hover:text-foreground"
                onClick={() => {
                  void onExportThread(activeThreadId)
                  onMenuOpenChange(false)
                }}
              >
                <Download className="h-3 w-3" />
                {t('workspace.chat.exportChat', 'Export conversation')}
              </button>
            )}
          </div>
        )}
      </div>
    </>
  )
}
