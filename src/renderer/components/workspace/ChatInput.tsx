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
import type { AiProvider, ChatAttachment } from '../../../shared/ipc-types'

type WorkspaceAttachmentOption = {
  key: string
  title: string
  attachment: ChatAttachment
}

function attachmentKey(attachment: ChatAttachment): string {
  return attachment.type === 'document'
    ? `document:${attachment.docId}`
    : `asset:${attachment.assetId}`
}

export interface ChatInputProps {
  input: string
  onInputChange: (value: string) => void
  streaming: boolean
  selectedAttachments: ChatAttachment[]
  onSelectedAttachmentsChange: React.Dispatch<React.SetStateAction<ChatAttachment[]>>
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
  const [workspaceAttachmentState, setWorkspaceAttachmentState] = useState<{
    workspaceId: string
    options: WorkspaceAttachmentOption[]
  } | null>(null)
  const attachMenuRef = useRef<HTMLDivElement | null>(null)
  const shouldLoadAttachments = attachMenuOpen || selectedAttachments.length > 0
  const workspaceAttachments = workspaceAttachmentState?.workspaceId === activeWorkspaceId
    ? workspaceAttachmentState.options
    : []

  useClickOutside(attachMenuRef, () => onAttachMenuOpenChange(false), attachMenuOpen)

  useEffect(() => {
    if (!shouldLoadAttachments || !activeWorkspaceId) return
    let cancelled = false
    void (async () => {
      try {
        const [items, assets] = await Promise.all([
          api.workspaceItems.list(activeWorkspaceId),
          api.workspaceAssets.list(activeWorkspaceId)
        ])
        const assetsById = new Map(assets.map((asset) => [asset.id, asset]))
        const options = (await Promise.all(
          items.map(async (item): Promise<WorkspaceAttachmentOption | null> => {
            if (item.kind === 'document' && item.docId) {
              const document = await api.documents.get(item.docId)
              const attachment = { type: 'document' as const, docId: item.docId }
              return {
                key: attachmentKey(attachment),
                title: document?.title?.trim() || document?.fileName || item.docId,
                attachment
              }
            }
            if (item.kind === 'asset' && item.assetId) {
              const asset = assetsById.get(item.assetId)
              const attachment = { type: 'asset' as const, assetId: item.assetId }
              return {
                key: attachmentKey(attachment),
                title: asset?.fileName ?? item.assetId,
                attachment
              }
            }
            return null
          })
        )).filter((option): option is WorkspaceAttachmentOption => option !== null)
        if (!cancelled) setWorkspaceAttachmentState({ workspaceId: activeWorkspaceId, options })
      } catch {
        if (!cancelled) setWorkspaceAttachmentState({ workspaceId: activeWorkspaceId, options: [] })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [activeWorkspaceId, shouldLoadAttachments])

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
            {selectedAttachments.map((attachment) => {
              const key = attachmentKey(attachment)
              const option = workspaceAttachments.find((candidate) => candidate.key === key)
              const attachmentTitle = option?.title ?? (
                attachment.type === 'document' ? attachment.docId : attachment.assetId
              )
              return (
                <span
                  key={key}
                  className="inline-flex items-center gap-1 rounded-full border border-border bg-panel-2 px-2 py-0.5 text-caption text-foreground"
                >
                  <span className="max-w-[120px] truncate">{attachmentTitle}</span>
                  <button
                    type="button"
                    className="text-muted transition-colors duration-150 hover:text-error"
                    aria-label={t('workspace.chat.removeAttachment', { title: attachmentTitle })}
                    onClick={() =>
                      onSelectedAttachmentsChange((previous) =>
                        previous.filter((candidate) => attachmentKey(candidate) !== key)
                      )
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
              title={t('workspace.chat.attachPapers', 'Attach workspace files')}
              aria-label={t('workspace.chat.attachPapers', 'Attach workspace files')}
            >
              <Paperclip className="h-4 w-4" />
              {selectedAttachments.length > 0 && (
                <span className="ml-0.5 text-caption font-medium">{selectedAttachments.length}</span>
              )}
            </UiButton>
            {attachMenuOpen && (
              <div className="absolute bottom-full left-0 z-50 mb-1 max-h-64 w-64 overflow-y-auto rounded-lg border border-border bg-panel shadow-lg">
                {workspaceAttachments.length === 0 ? (
                  <p className="px-3 py-2 text-label text-muted">
                    {t('workspace.chat.noWorkspaceDocs', 'No files in workspace. Add files to the board first.')}
                  </p>
                ) : (
                  <div className="flex flex-col gap-0.5 p-1">
                    {workspaceAttachments.map((option) => {
                      const checked = selectedAttachments.some(
                        (attachment) => attachmentKey(attachment) === option.key
                      )
                      const maxReached = selectedAttachments.length >= 8 && !checked
                      return (
                        <label
                          key={option.key}
                          className={`flex items-center gap-2 rounded px-2 py-1 text-label transition-colors duration-150 hover:bg-hover ${maxReached ? 'opacity-40' : ''}`}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={maxReached}
                            onChange={() => {
                              onSelectedAttachmentsChange((prev) =>
                                checked
                                  ? prev.filter((attachment) => attachmentKey(attachment) !== option.key)
                                  : [...prev, option.attachment]
                              )
                            }}
                            className="h-3 w-3 shrink-0"
                          />
                          <span className="min-w-0 flex-1 truncate text-foreground">{option.title}</span>
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
