import { useState, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import {
  PaperPlaneTilt,
  Queue,
  Square,
  Paperclip,
  X
} from '@phosphor-icons/react'
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
  queueing?: boolean
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
  queueing = false,
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
  const isFollowup = streaming || queueing
  const placeholder = t(isFollowup ? 'workspace.chat.followupPlaceholder' : 'workspace.chat.inputPlaceholder')
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
                attachment: { ...attachment, title: document?.title?.trim() || document?.fileName }
              }
            }
            if (item.kind === 'asset' && item.assetId) {
              const asset = assetsById.get(item.assetId)
              const attachment = { type: 'asset' as const, assetId: item.assetId }
              return {
                key: attachmentKey(attachment),
                title: asset?.fileName ?? item.assetId,
                attachment: { ...attachment, title: asset?.fileName }
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

  const submit = () => {
    if (!canSend) return
    textareaRef.current?.focus()
    onSend()
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      if (input.trim().length > MAX_INPUT_LENGTH) onSend()
      else submit()
    }
  }

  return (
    <div ref={inputAreaRef} className="shrink-0 py-3" style={{ paddingInline: 'clamp(12px, 7cqi, 64px)' }}>
      <div className="mx-auto flex w-full max-w-[768px] flex-col rounded-xl border border-border bg-input-area shadow-sm focus-within:border-accent focus-within:ring-1 focus-within:ring-accent">
        {selectedAttachments.length > 0 && (
          <div className="flex flex-wrap gap-1 px-2 pt-1">
            {selectedAttachments.map((attachment) => {
              const key = attachmentKey(attachment)
              const option = workspaceAttachments.find((candidate) => candidate.key === key)
              const attachmentTitle = option?.title ?? attachment.title ?? (
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
                    <X aria-hidden className="h-3 w-3" />
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
            placeholder={placeholder}
            disabled={providers.length === 0}
            aria-label={placeholder}
            title={`${placeholder} (⌘L)`}
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

        {streaming && !!input.trim() && (
          <div className="flex justify-end px-3 pb-1">
            <UiButton variant="ghost" size="sm" icon={<Queue className="h-3.5 w-3.5" />} onClick={submit} disabled={!canSend}
              aria-label={t('workspace.chat.queueMessage')}
              title={`${t('workspace.chat.queueMessage')} (⏎)`}>
              {t('workspace.chat.queueMessage')}
            </UiButton>
          </div>
        )}

        <div className="flex min-w-0 items-center gap-1 px-2 pb-2 pt-1">
          <div className="relative shrink-0" ref={attachMenuRef}>
            <UiButton
              variant="ghost"
              size="sm"
              iconOnly
              className={`shrink-0 ${selectedAttachments.length > 0 ? 'text-accent' : ''}`}
              onClick={() => onAttachMenuOpenChange((v) => !v)}
              disabled={!activeWorkspaceId}
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
            {streaming && (
              <UiButton
                variant="danger"
                size="sm"
                iconOnly
                className="shrink-0"
                onClick={() => { textareaRef.current?.focus(); onCancel() }}
                aria-label={t('workspace.chat.stop', 'Stop')}
                title={t('workspace.chat.stop', 'Stop')}
              >
                <Square className="h-3.5 w-3.5" />
              </UiButton>
            )}
            {!streaming && <UiButton
                variant="primary"
                size="sm"
                iconOnly
                className="shrink-0"
                onClick={submit}
                disabled={!canSend}
                aria-label={t(isFollowup ? 'workspace.chat.queueMessage' : 'workspace.chat.send')}
                title={`${t(isFollowup ? 'workspace.chat.queueMessage' : 'workspace.chat.send')} (⏎)`}
              >
                {isFollowup ? <Queue className="h-3.5 w-3.5" /> : <PaperPlaneTilt className="h-3.5 w-3.5" />}
              </UiButton>}
          </div>
        </div>
      </div>
    </div>
  )
}
