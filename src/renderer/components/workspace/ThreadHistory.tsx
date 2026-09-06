import { useState, useRef, useEffect, useLayoutEffect, useId } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import {
  ClockCounterClockwise,
  PencilSimple,
  Download,
  Trash
} from '@phosphor-icons/react'
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
  const popupRef = useRef<HTMLDivElement | null>(null)
  const popupId = useId()
  const [position, setPosition] = useState({ top: 0, left: 0, width: 288, maxHeight: 360 })
  const [renamingThreadId, setRenamingThreadId] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')

  useLayoutEffect(() => {
    if (!menuOpen) return
    const update = () => {
      const bounds = threadMenuRef.current?.getBoundingClientRect()
      if (!bounds) return
      const width = Math.min(288, window.innerWidth - 16)
      const top = Math.min(bounds.bottom + 6, window.innerHeight - 80)
      setPosition({ top, left: Math.max(8, Math.min(bounds.right - width, window.innerWidth - width - 8)), width, maxHeight: Math.max(64, Math.min(360, window.innerHeight - top - 12)) })
    }
    update()
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [menuOpen])

  useEffect(() => {
    if (!menuOpen) return
    const outside = (event: MouseEvent) => {
      const target = event.target as HTMLElement
      const titleTab = threadMenuRef.current?.closest('[data-testid="panel-tab-header"]')?.querySelector('[data-testid="panel-tab"]')
      if (!threadMenuRef.current?.contains(target) && !popupRef.current?.contains(target) && !titleTab?.contains(target)) onMenuOpenChange(false)
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      onMenuOpenChange(false)
      threadMenuRef.current?.querySelector('button')?.focus()
    }
    document.addEventListener('mousedown', outside)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('mousedown', outside)
      document.removeEventListener('keydown', escape)
    }
  }, [menuOpen, onMenuOpenChange])

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
          aria-expanded={menuOpen}
          aria-controls={menuOpen ? popupId : undefined}
        >
          <ClockCounterClockwise className="h-4 w-4" />
        </UiButton>
        {menuOpen && createPortal(
          <div ref={popupRef} id={popupId} role="region" aria-label={t('workspace.chat.threadHistory', 'Thread history')} className="no-drag fixed z-[100] overflow-y-auto rounded-xl border border-border bg-panel p-1 shadow-lg" style={position}>
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
                          e.stopPropagation()
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
                      className="min-w-0 flex-1 truncate text-left"
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
                      disabled={streaming && th.id === activeThreadId}
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
          </div>, document.body
        )}
      </div>
    </>
  )
}
