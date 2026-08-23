import { useState, useEffect, useRef, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import {
  PaperPlaneTilt,
  Square,
  Paperclip,
  Scissors,
  Copy,
  Clipboard,
  SelectionAll
} from '@phosphor-icons/react'
import { showContextMenu } from '@lobehub/ui'
import type { ContextMenuItem } from '@lobehub/ui'
import { useClickOutside } from '../../hooks/useClickOutside'
import { Button as UiButton } from '../ui'
import { api } from '../../ipc'
import { MAX_INPUT_LENGTH } from '../../utils/chatUtils'
import type { AiProvider } from '../../../shared/ipc-types'

export interface ChatInputProps {
  input: string
  onInputChange: (value: string) => void
  streaming: boolean
  selectedAttachments: string[]
  onSelectedAttachmentsChange: React.Dispatch<React.SetStateAction<string[]>>
  attachMenuOpen: boolean
  onAttachMenuOpenChange: React.Dispatch<React.SetStateAction<boolean>>
  activeWorkspaceId: string | null
  providers: AiProvider[]
  canSend: boolean
  onSend: () => void
  onCancel: () => void
  textareaRef: React.RefObject<HTMLTextAreaElement | null>
  inputAreaRef: React.RefObject<HTMLDivElement | null>
  toolbar?: React.ReactNode
}

export default function ChatInput({
  input,
  onInputChange,
  streaming,
  selectedAttachments,
  onSelectedAttachmentsChange,
  attachMenuOpen,
  onAttachMenuOpenChange,
  activeWorkspaceId,
  providers,
  canSend,
  onSend,
  onCancel,
  textareaRef,
  inputAreaRef,
  toolbar
}: ChatInputProps) {
  const { t } = useTranslation()
  const [workspaceDocs, setWorkspaceDocs] = useState<Array<{ docId: string; title: string }>>([])
  const attachMenuRef = useRef<HTMLDivElement | null>(null)

  useClickOutside(attachMenuRef, () => onAttachMenuOpenChange(false), attachMenuOpen)

  useEffect(() => {
    setWorkspaceDocs([])
    if (!attachMenuOpen || !activeWorkspaceId) return
    let cancelled = false
    void (async () => {
      try {
        const items = await api.workspaceItems.list(activeWorkspaceId)
        const docItems = items.filter((i) => i.kind === 'document' && i.docId)
        const docs = await Promise.all(
          docItems.map(async (i) => {
            const doc = await api.documents.get(i.docId!)
            return { docId: i.docId!, title: doc?.title ?? doc?.fileName ?? i.docId! }
          })
        )
        if (!cancelled) setWorkspaceDocs(docs)
      } catch {
        if (!cancelled) setWorkspaceDocs([])
      }
    })()
    return () => {
      cancelled = true
    }
  }, [attachMenuOpen, activeWorkspaceId])

  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`
  }, [input])

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      onSend()
    }
  }

  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      const el = textareaRef.current
      const start = el?.selectionStart ?? 0
      const end = el?.selectionEnd ?? 0
      const hasSelection = start !== end
      const items: ContextMenuItem[] = [
        {
          key: 'cut',
          label: t('workspace.chat.cut', 'Cut'),
          icon: <Scissors className="h-3.5 w-3.5" />,
          disabled: !hasSelection,
          onClick: async () => {
            const ta = textareaRef.current
            if (!ta) return
            const s = ta.selectionStart
            const en = ta.selectionEnd
            if (s === en) return
            try {
              await navigator.clipboard.writeText(input.slice(s, en))
            } catch {
              return
            }
            onInputChange(input.slice(0, s) + input.slice(en))
            requestAnimationFrame(() => {
              ta.focus()
              ta.selectionStart = ta.selectionEnd = s
            })
          }
        },
        {
          key: 'copy',
          label: t('workspace.chat.copy', 'Copy'),
          icon: <Copy className="h-3.5 w-3.5" />,
          disabled: !hasSelection,
          onClick: async () => {
            const ta = textareaRef.current
            if (!ta) return
            const s = ta.selectionStart
            const en = ta.selectionEnd
            if (s === en) return
            try {
              await navigator.clipboard.writeText(input.slice(s, en))
            } catch {
              return
            }
          }
        },
        {
          key: 'paste',
          label: t('workspace.chat.paste', 'Paste'),
          icon: <Clipboard className="h-3.5 w-3.5" />,
          onClick: async () => {
            const ta = textareaRef.current
            if (!ta) return
            let text = ''
            try {
              text = await navigator.clipboard.readText()
            } catch {
              return
            }
            if (!text) return
            const s = ta.selectionStart
            const en = ta.selectionEnd
            onInputChange(input.slice(0, s) + text + input.slice(en))
            requestAnimationFrame(() => {
              ta.focus()
              ta.selectionStart = ta.selectionEnd = s + text.length
            })
          }
        },
        { type: 'divider', key: 'divider' },
        {
          key: 'selectAll',
          label: t('workspace.chat.selectAll', 'Select All'),
          icon: <SelectionAll className="h-3.5 w-3.5" />,
          disabled: !input,
          onClick: () => {
            const ta = textareaRef.current
            if (!ta) return
            ta.focus()
            ta.select()
          }
        }
      ]
      showContextMenu(items)
    },
    [input, onInputChange, t, textareaRef]
  )

  return (
    <div ref={inputAreaRef} className="shrink-0 py-3" style={{ paddingInline: 'clamp(12px, 7cqi, 64px)' }}>
      <div className="mx-auto flex w-full max-w-[768px] flex-col rounded-xl border border-border bg-input-area shadow-sm focus-within:border-accent focus-within:ring-1 focus-within:ring-accent">
        {selectedAttachments.length > 0 && (
          <div className="flex flex-wrap gap-1 px-2 pt-1">
            {selectedAttachments.map((docId) => {
              const doc = workspaceDocs.find((d) => d.docId === docId)
              const attachmentTitle = doc?.title ?? docId.slice(0, 8)
              return (
                <span
                  key={docId}
                  className="inline-flex items-center gap-1 rounded-full border border-border bg-panel-2 px-2 py-0.5 text-caption text-foreground"
                >
                  <span className="max-w-[120px] truncate">{attachmentTitle}</span>
                  <button
                    type="button"
                    className="text-muted transition-colors duration-150 hover:text-error"
                    aria-label={t('workspace.chat.removeAttachment', { title: attachmentTitle })}
                    onClick={() =>
                      onSelectedAttachmentsChange((prev) => prev.filter((id) => id !== docId))
                    }
                  >
                    ×
                  </button>
                </span>
              )
            })}
          </div>
        )}
        <div className="relative">
          <textarea
            ref={textareaRef}
            className="max-h-40 min-h-[52px] w-full resize-none bg-transparent px-3 pt-3 text-sm text-foreground placeholder:text-muted focus:outline-none"
            rows={2}
            value={input}
            onChange={(e) => onInputChange(e.target.value)}
            onKeyDown={onKeyDown}
            onContextMenu={handleContextMenu}
            placeholder={t(
              'workspace.chat.inputPlaceholder',
              'PaperPlaneTilt a message… (Enter to send, Shift+Enter for newline)'
            )}
            disabled={providers.length === 0}
            aria-label={t('workspace.chat.inputPlaceholder', 'PaperPlaneTilt a message…')}
            title={`${t('workspace.chat.inputPlaceholder', 'PaperPlaneTilt a message…')} (⌘L)`}
          />
          {input.length > MAX_INPUT_LENGTH * 0.8 && (
            <span
              className={`pointer-events-none absolute bottom-2 right-3 text-caption ${
                input.length > MAX_INPUT_LENGTH ? 'text-error' : 'text-muted'
              }`}
            >
              {Math.max(0, MAX_INPUT_LENGTH - input.length)}{' '}
              {t('workspace.chat.charsRemaining', 'chars left')}
            </span>
          )}
        </div>

        <div className="flex min-w-0 items-center gap-1 px-2 pb-2 pt-1">
          <div className="relative shrink-0" ref={attachMenuRef}>
            <UiButton
              variant="ghost"
              size="sm"
              iconOnly
              className={`shrink-0 ${selectedAttachments.length > 0 ? 'text-accent' : ''}`}
              onClick={() => onAttachMenuOpenChange((v) => !v)}
              disabled={!activeWorkspaceId || streaming}
              title={t('workspace.chat.attachPapers', 'Attach papers')}
              aria-label={t('workspace.chat.attachPapers', 'Attach papers')}
            >
              <Paperclip className="h-4 w-4" />
              {selectedAttachments.length > 0 && (
                <span className="ml-0.5 text-caption font-medium">{selectedAttachments.length}</span>
              )}
            </UiButton>
            {attachMenuOpen && (
              <div className="absolute bottom-full left-0 z-50 mb-1 max-h-64 w-64 overflow-y-auto rounded-lg border border-border bg-panel shadow-lg">
                {workspaceDocs.length === 0 ? (
                  <p className="px-3 py-2 text-label text-muted">
                    {t('workspace.chat.noWorkspaceDocs', 'No papers in workspace. Add papers to the board first.')}
                  </p>
                ) : (
                  <div className="flex flex-col gap-0.5 p-1">
                    {workspaceDocs.map((doc) => {
                      const checked = selectedAttachments.includes(doc.docId)
                      const maxReached = selectedAttachments.length >= 8 && !checked
                      return (
                        <label
                          key={doc.docId}
                          className={`flex items-center gap-2 rounded px-2 py-1 text-label transition-colors duration-150 hover:bg-hover ${maxReached ? 'opacity-40' : ''}`}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={maxReached}
                            onChange={() => {
                              onSelectedAttachmentsChange((prev) =>
                                checked
                                  ? prev.filter((id) => id !== doc.docId)
                                  : [...prev, doc.docId]
                              )
                            }}
                            className="h-3 w-3 shrink-0"
                          />
                          <span className="min-w-0 flex-1 truncate text-foreground">{doc.title}</span>
                        </label>
                      )
                    })}
                    {selectedAttachments.length >= 8 && (
                      <p className="px-2 py-1 text-caption text-muted">
                        {t('workspace.chat.attachMax', 'Maximum 8 attachments.')}
                      </p>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
          <div
            className="ml-auto flex min-w-0 flex-1 items-center justify-end gap-1"
            data-testid="chat-input-controls"
          >
            {toolbar}
            {streaming ? (
              <UiButton
                variant="danger"
                size="sm"
                iconOnly
                className="shrink-0"
                onClick={onCancel}
                aria-label={t('workspace.chat.stop', 'Stop')}
                title={t('workspace.chat.stop', 'Stop')}
              >
                <Square className="h-3.5 w-3.5" />
              </UiButton>
            ) : (
              <UiButton
                variant="primary"
                size="sm"
                iconOnly
                className="shrink-0"
                onClick={onSend}
                disabled={!canSend}
                aria-label={t('workspace.chat.send', 'PaperPlaneTilt')}
                title={`${t('workspace.chat.send', 'PaperPlaneTilt')} (⏎)`}
              >
                <PaperPlaneTilt className="h-3.5 w-3.5" />
              </UiButton>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
