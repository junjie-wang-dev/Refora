import { useTranslation } from 'react-i18next'
import { useState, useEffect, useRef, useCallback } from 'react'
import { ArrowClockwise, ArrowsLeftRight, X, Trash, FolderOpen, FileText } from '@phosphor-icons/react'
import { Button } from './ui'
import { Textarea } from './ui'
import { PanelHeader } from './ui'
import { EmptyState } from './ui'
import { Select, showContextMenu } from '@lobehub/ui'
import type { ContextMenuItem } from '@lobehub/ui'

import { useDocumentStore } from '../store/documentStore'
import { api } from '../ipc'
import { formatAuthorName, formatDate, formatFilePath } from '../utils/format'
import type {
  Document,
  EditableField,
  RemoteValue,
  Category,
  DocumentPatch
} from '../../shared/ipc-types'
import { errorMessage } from '../../shared/ipc-types'
import { openDocumentPdf } from '../utils/openPdf'
import OcrSection from './OcrSection'
import {
  pendingDocumentNote,
  persistDocumentNote,
  stageDocumentNote,
  subscribeDocumentNoteStatus
} from '../persistence'

type InlineFieldVariant = 'default' | 'title' | 'year' | 'authors' | 'metadata' | 'abstract'

const DISPLAY_CLASSES: Record<InlineFieldVariant, string> = {
  default: 'rounded-lg bg-background px-3 py-1.5 text-sm leading-5',
  title: 'rounded-md px-0 py-0 text-lg font-semibold leading-6 tracking-tight',
  year: 'rounded-md px-0 py-0 text-sm leading-5 text-muted',
  authors: 'rounded-lg px-0 py-0 text-sm leading-5',
  metadata: 'rounded-lg px-0 py-0 text-sm leading-5',
  abstract: 'rounded-lg px-0 py-0 text-justify text-sm leading-[22px] text-foreground'
}

function InlineField({
  field,
  label,
  value,
  remoteValue,
  docId,
  onSaved,
  variant = 'default',
  className
}: {
  field: EditableField
  label?: string
  value: string
  remoteValue?: RemoteValue
  docId: string
  onSaved: (doc: Document) => void
  variant?: InlineFieldVariant
  className?: string
}) {
  const { t } = useTranslation()
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(value)
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [saveError, setSaveError] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const statusRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const savingRef = useRef(false)

  useEffect(() => {
    if (!editing || savingRef.current) setText(value)
  }, [editing, value])

  useEffect(() => {
    if (editing && textareaRef.current) {
      textareaRef.current.focus()
    }
  }, [editing])

  useEffect(() => {
    return () => {
      if (statusRef.current) clearTimeout(statusRef.current)
    }
  }, [])

  const save = useCallback(async () => {
    if (savingRef.current) return
    const trimmed = text.trim()
    const current = (value ?? '')
    if (trimmed === current) {
      setEditing(false)
      return
    }
    savingRef.current = true
    setStatus('saving')
    setSaveError(null)
    try {
      const patch: DocumentPatch = {}
      patch[field] = trimmed || ''
      const doc = await api.documents.update(docId, patch)
      onSaved(doc)
      setStatus('saved')
      if (statusRef.current) clearTimeout(statusRef.current)
      statusRef.current = setTimeout(() => setStatus('idle'), 2000)
    } catch (error) {
      setText(value)
      setSaveError(errorMessage(error, t('detail.saveFailed')))
      setStatus('error')
    }
    savingRef.current = false
    setEditing(false)
  }, [text, value, field, docId, onSaved, t])

  const applyRemote = useCallback(async () => {
    if (!remoteValue) return
    setText(remoteValue.value)
    setStatus('saving')
    setSaveError(null)
    try {
      const patch: DocumentPatch = {}
      patch[field] = remoteValue.value
      const doc = await api.documents.update(docId, patch)
      onSaved(doc)
      setStatus('saved')
      if (statusRef.current) clearTimeout(statusRef.current)
      statusRef.current = setTimeout(() => setStatus('idle'), 2000)
    } catch (error) {
      setText(value)
      setSaveError(errorMessage(error, t('detail.saveFailed')))
      setStatus('error')
    }
  }, [field, remoteValue, docId, onSaved, value, t])

  const hasRemoteDiff = remoteValue && remoteValue.value !== '' && remoteValue.value !== (value ?? '')
  const authors = variant === 'authors'
    ? value.split(';').map((author) => author.trim()).filter(Boolean)
    : []

  return (
    <div className={`flex min-w-0 flex-col gap-1 ${className ?? ''}`}>
      {label ? (
        <span className="flex items-center gap-1 text-label font-semibold uppercase tracking-wide text-muted">
          {label}
          {status === 'saving' && (
            <span className="text-caption font-normal normal-case text-muted">
              {t('common.saving')}
            </span>
          )}
          {status === 'saved' && (
            <span className="text-caption font-normal normal-case text-success">
              {t('common.saved')}
            </span>
          )}
        </span>
      ) : null}
      <div className="flex items-start gap-1">
        {editing ? (
          <Textarea
            ref={textareaRef}
            variant="filled"
            textareaSize="md"
            autoResize
            className="flex-1 min-h-[2.5rem] resize-none"
            value={text}
            disabled={status === 'saving'}
            rows={1}
            onChange={(e) => {
              setText(e.target.value)
            }}
            onBlur={save}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault()
                save()
              }
              if (e.key === 'Escape') {
                e.stopPropagation()
                setText(value)
                setEditing(false)
              }
            }}
          />
        ) : (
          <div
            className={`w-full cursor-text border border-transparent text-foreground transition-colors duration-150 hover:border-border focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent ${DISPLAY_CLASSES[variant]}`}
            onClick={() => {
              setSaveError(null)
              setStatus('idle')
              setEditing(true)
            }}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                setSaveError(null)
                setStatus('idle')
                setEditing(true)
              }
            }}
          >
            {variant === 'authors' && authors.length > 0 ? (
              <span className="flex flex-wrap gap-2">
                {authors.map((author, index) => (
                  <span
                    key={`${author}-${index}`}
                    className="rounded-lg border border-border/60 bg-panel px-2.5 py-1 text-[13px] text-foreground"
                  >
                    {field === 'authors' ? formatAuthorName(author) : author}
                  </span>
                ))}
              </span>
            ) : value || '\u2014'}
          </div>
        )}
        {hasRemoteDiff && !editing && (
          <Button
            variant="link"
            size="sm"
            iconOnly
            className="flex-sh-0"
            title={t('detail.applyRemote') ?? 'Apply remote value'}
            onClick={applyRemote}
          >
            <ArrowsLeftRight className="h-4 w-4" />
          </Button>
        )}
      </div>
      {!label && status !== 'idle' ? (
        <span className={`text-caption ${status === 'saved' ? 'text-success' : status === 'error' ? 'text-error' : 'text-muted'}`}>
          {status === 'saved'
            ? t('common.saved')
            : status === 'error'
              ? saveError
              : t('common.saving')}
        </span>
      ) : null}
    </div>
  )
}

function NoteField({
  value,
  docId,
  onSaved
}: {
  value: string
  docId: string
  onSaved: (doc: Document) => void
}) {
  const { t } = useTranslation()
  const pendingDraft = pendingDocumentNote(docId)
  const [text, setText] = useState(pendingDraft ?? value ?? '')
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>(
    pendingDraft === undefined ? 'idle' : 'error'
  )
  const saveRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const statusRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const textRef = useRef(pendingDraft ?? value ?? '')
  const editVersionRef = useRef(0)
  const dirtyRef = useRef(pendingDraft !== undefined)
  const docIdRef = useRef(docId)
  const savedTextRef = useRef(value ?? '')
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve())

  useEffect(() => {
    if (docIdRef.current !== docId) {
      docIdRef.current = docId
      dirtyRef.current = false
      editVersionRef.current++
      savedTextRef.current = value ?? ''
    }
    if (dirtyRef.current) return
    savedTextRef.current = value ?? ''
    textRef.current = value ?? ''
    setText(value ?? '')
  }, [docId, value])

  const save = useCallback((nextText: string, editVersion: number) => {
    const run = async () => {
      if (nextText === savedTextRef.current) {
        if (editVersion === editVersionRef.current) {
          dirtyRef.current = false
          setStatus('idle')
        }
        return
      }
      if (editVersion === editVersionRef.current) setStatus('saving')
      try {
        const doc = await persistDocumentNote(docId)
        savedTextRef.current = nextText
        if (editVersion === editVersionRef.current) {
          dirtyRef.current = false
          setStatus('saved')
          if (statusRef.current) clearTimeout(statusRef.current)
          statusRef.current = setTimeout(() => setStatus('idle'), 2000)
        }
        if (doc) onSaved(doc)
      } catch (error) {
        if (editVersion === editVersionRef.current) {
          dirtyRef.current = true
          setStatus('error')
        }
        throw error
      }
    }
    const task = saveQueueRef.current.then(run, run)
    saveQueueRef.current = task.catch(() => undefined)
    return task
  }, [docId, onSaved])

  const flush = useCallback(async () => {
    if (saveRef.current) {
      clearTimeout(saveRef.current)
      saveRef.current = undefined
    }
    if (dirtyRef.current) {
      await save(textRef.current, editVersionRef.current)
    } else {
      await saveQueueRef.current
    }
  }, [save])

  useEffect(() => {
    const unsubscribe = subscribeDocumentNoteStatus(docId, (nextStatus) => {
      if (nextStatus === 'saved') {
        dirtyRef.current = false
        savedTextRef.current = textRef.current
        setStatus('saved')
        if (statusRef.current) clearTimeout(statusRef.current)
        statusRef.current = setTimeout(() => setStatus('idle'), 2000)
        return
      }
      if (nextStatus === 'error') dirtyRef.current = true
      setStatus(nextStatus)
    })
    return () => {
      unsubscribe()
      if (statusRef.current) clearTimeout(statusRef.current)
      if (saveRef.current) clearTimeout(saveRef.current)
      void persistDocumentNote(docId).catch(() => undefined)
    }
  }, [docId])

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const nextText = e.target.value
    const editVersion = ++editVersionRef.current
    dirtyRef.current = true
    textRef.current = nextText
    stageDocumentNote(docId, nextText, savedTextRef.current)
    setText(nextText)
    setStatus('idle')
    if (saveRef.current) clearTimeout(saveRef.current)
    saveRef.current = setTimeout(() => {
      saveRef.current = undefined
      void save(nextText, editVersion).catch(() => undefined)
    }, 1000)
  }

  return (
    <div className="flex flex-col gap-1">
      <span className="flex items-center gap-1 text-label font-semibold uppercase tracking-wide text-muted">
        {t('detail.note')}
        {status === 'saving' && (
          <span className="text-caption font-normal normal-case text-muted">
            {t('common.saving')}
          </span>
        )}
        {status === 'saved' && (
          <span className="text-caption font-normal normal-case text-success">
            {t('common.saved')}
          </span>
        )}
        {status === 'error' && (
          <>
            <span className="text-caption font-normal normal-case text-error">
              {t('detail.saveFailed')}
            </span>
            <Button
              variant="link"
              size="sm"
              onClick={() => void flush().catch(() => undefined)}
            >
              {t('pdfReader.retrySave')}
            </Button>
          </>
        )}
      </span>
      <Textarea
        variant="filled"
        textareaSize="md"
        className="min-h-[96px] resize-y"
        value={text}
        onChange={handleChange}
        onBlur={() => {
          if (saveRef.current) {
            clearTimeout(saveRef.current)
            saveRef.current = undefined
          }
          void save(textRef.current, editVersionRef.current).catch(() => undefined)
        }}
      />
    </div>
  )
}

function CategoryChips({
  docId,
  docCategories
}: {
  docId: string
  docCategories?: Category[]
}) {
  const { t } = useTranslation()
  const allCategories = useDocumentStore((s) => s.categories)
  const fetchCategories = useDocumentStore((s) => s.fetchCategories)
  const [assigned, setAssigned] = useState<Category[]>(docCategories ?? [])

  useEffect(() => {
    setAssigned(docCategories ?? [])
  }, [docId, docCategories])

  const assignedIds = new Set(assigned.map((c) => c.id))
  const unassigned = allCategories.filter((c) => !assignedIds.has(c.id))

  const unassign = async (catId: string) => {
    const removed = assigned.find((c) => c.id === catId)
    setAssigned((prev) => prev.filter((c) => c.id !== catId))
    try {
      await api.categories.unassign(docId, catId)
      void fetchCategories()
    } catch (error) {
      if (removed) setAssigned((prev) => { const s = [...prev, removed]; return s })
      useDocumentStore.getState().showToast(
        errorMessage(error, t('documentErrors.assignCategoryFailed'))
      )
      void fetchCategories()
    }
  }

  const assign = async (catId: string) => {
    const cat = allCategories.find((c) => c.id === catId)
    if (cat) setAssigned((prev) => [...prev, { ...cat, count: undefined }])
    try {
      await api.categories.assign(docId, catId)
      void fetchCategories()
    } catch (error) {
      setAssigned((prev) => prev.filter((c) => c.id !== catId))
      useDocumentStore.getState().showToast(
        errorMessage(error, t('documentErrors.assignCategoryFailed'))
      )
      void fetchCategories()
    }
  }

  const handleAddCategory = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const items: ContextMenuItem[] =
      unassigned.length > 0
        ? unassigned.map((c) => ({
            key: c.id,
            label: c.name,
            onClick: () => assign(c.id)
          }))
        : [{ key: 'empty', label: '\u2014', disabled: true }]
    showContextMenu(items)
  }

  return (
    <div className="flex flex-col gap-1">
      <span className="text-label font-semibold uppercase tracking-wide text-muted">
        {t('sidebar.categories')}
      </span>
      <div className="flex flex-wrap items-center gap-1">
        {assigned.map((c) => (
          <span
            key={c.id}
            className="inline-flex items-center gap-0.5 rounded bg-panel-2 px-1.5 py-0.5 text-xs text-foreground"
          >
            {c.name}
            <button
              className="ml-0.5 text-muted transition-colors duration-150 hover:text-error"
              onClick={() => unassign(c.id)}
              title={t('common.remove') ?? 'Remove'}
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        ))}
        <button
          className="text-xs text-accent transition-colors duration-150 hover:text-accent-hover"
          onClick={handleAddCategory}
          title={t('common.create') ?? 'Add'}
        >
          +
        </button>
      </div>
    </div>
  )
}

function SingleDetail({ doc }: { doc: Document }) {
  const { t } = useTranslation()
  const patchDocument = useDocumentStore((s) => s.patchDocument)
  const openInFinder = useDocumentStore((s) => s.openInFinder)
  const refreshMetadata = useDocumentStore((s) => s.refreshMetadata)
  const requestDeleteConfirm = useDocumentStore((s) => s.requestDeleteConfirm)
  const [refreshing, setRefreshing] = useState(false)
  const [refreshResult, setRefreshResult] = useState<'idle' | 'success' | 'failed'>('idle')
  const resultTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const refreshPendingSeenRef = useRef(false)

  const onSaved = useCallback(
    (d: Document) => { patchDocument(d.id, d) },
    [patchDocument]
  )

  useEffect(() => {
    if (!refreshing) return
    if (doc.metadataStatus === 'pending') {
      refreshPendingSeenRef.current = true
      return
    }
    if (!refreshPendingSeenRef.current) return
    if (doc.metadataStatus === 'done') {
      setRefreshing(false)
      setRefreshResult('success')
      if (resultTimerRef.current) clearTimeout(resultTimerRef.current)
      resultTimerRef.current = setTimeout(() => setRefreshResult('idle'), 3000)
    } else if (doc.metadataStatus === 'failed') {
      setRefreshing(false)
      setRefreshResult('failed')
      if (resultTimerRef.current) clearTimeout(resultTimerRef.current)
      resultTimerRef.current = setTimeout(() => setRefreshResult('idle'), 4000)
    }
  }, [refreshing, doc.metadataStatus])

  useEffect(() => {
    return () => {
      if (resultTimerRef.current) clearTimeout(resultTimerRef.current)
    }
  }, [])

  const handleRefresh = async () => {
    refreshPendingSeenRef.current = false
    setRefreshing(true)
    setRefreshResult('idle')
    const enqueued = await refreshMetadata(doc.id)
    if (!enqueued) {
      setRefreshing(false)
    }
  }

  const handleOpenPdf = async () => {
    try {
      const updated = await openDocumentPdf(doc.id)
      patchDocument(doc.id, updated)
    } catch (e) {
      useDocumentStore.getState().showToast(
        errorMessage(e, t('documentErrors.openPdfFailed'))
      )
    }
  }

  const handleRelocate = async () => {
    try {
      await api.documents.relocateFile(doc.id, '')
      useDocumentStore.getState().showToast(t('detail.relocate') ?? '')
    } catch (e) {
      useDocumentStore.getState().showToast(errorMessage(e, ''))
    }
  }

  const handleRestore = async () => {
    try {
      const updated = await api.documents.restoreFile(doc.id)
      useDocumentStore.getState().patchDocument(doc.id, updated)
    } catch (e) {
      useDocumentStore.getState().showToast(errorMessage(e, ''))
    }
  }

  const remoteValues: Record<string, RemoteValue> = doc.remoteValues ?? {}
  const isMoved =
    doc.originalFolderPath && doc.filePath &&
    !doc.filePath.startsWith(doc.originalFolderPath)

  return (
    <div className="-mt-4 flex flex-col">
      <div className="border-b border-border/60 px-5 pb-4 pt-4">
        <Button
          variant="link"
          size="sm"
          className="text-sm font-medium text-foreground hover:text-accent hover:no-underline"
          icon={<ArrowClockwise className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} />}
          onClick={handleRefresh}
          disabled={refreshing}
          aria-label={t('detail.refreshMetadata')}
        >
          <span>{t('detail.refreshMetadata')}</span>
          {refreshResult === 'success' && (
            <span className="ml-1 text-caption font-normal normal-case text-success">
              {t('detail.refreshSuccess')}
            </span>
          )}
          {refreshResult === 'failed' && (
            <span className="ml-1 text-caption font-normal normal-case text-error">
              {t('detail.refreshFailed')}
            </span>
          )}
        </Button>

        <div className="mt-3 px-3">
          <InlineField
            field="title"
            value={doc.title ?? ''}
            remoteValue={remoteValues.title}
            docId={doc.id}
            onSaved={onSaved}
            variant="title"
          />
        </div>

        <InlineField
          field="year"
          value={doc.year ?? ''}
          remoteValue={remoteValues.year}
          docId={doc.id}
          onSaved={onSaved}
          variant="year"
          className="mt-1 px-3"
        />
      </div>

        <div className="flex flex-col px-8 py-5">
          <div className="grid grid-cols-[84px_minmax(0,1fr)] gap-x-4">
            <span className="pt-1 text-[13px] text-muted">{t('detail.authors')}</span>
            <InlineField
              field="authors"
              value={doc.authors ?? ''}
              remoteValue={remoteValues.authors}
              docId={doc.id}
              onSaved={onSaved}
              variant="authors"
            />
          </div>

          <div className="mt-3 grid grid-cols-[84px_minmax(0,1fr)] gap-x-4">
            <span className="pt-1 text-[13px] text-muted">{t('detail.affiliations')}</span>
            <InlineField
              field="affiliations"
              value={doc.affiliations ?? ''}
              remoteValue={remoteValues.affiliations}
              docId={doc.id}
              onSaved={onSaved}
              variant="authors"
            />
          </div>


        <div className="mt-5 grid grid-cols-[84px_minmax(0,1fr)] gap-x-4 gap-y-2">
          {(['venue', 'volume', 'issue', 'pages'] as const).map((field) => (
            <div key={field} className="contents">
              <span className="text-[13px] leading-5 text-muted">
                {t(`detail.${field}` as never)}
              </span>
              <InlineField
                field={field}
                value={doc[field] ?? ''}
                remoteValue={remoteValues[field]}
                docId={doc.id}
                onSaved={onSaved}
                variant="metadata"
              />
            </div>
          ))}
        </div>

        <div className="mt-5">
          <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">
            {t('detail.abstract')}
          </span>
          <InlineField
            field="abstract"
            value={doc.abstract ?? ''}
            remoteValue={remoteValues.abstract}
            docId={doc.id}
            onSaved={onSaved}
            variant="abstract"
            className="mt-2"
          />
        </div>

        <div className="mt-6 grid grid-cols-[84px_minmax(0,1fr)] gap-x-4 gap-y-2 border-t border-border pt-5">
          {(['keywords', 'url', 'doi', 'arxivId'] as const).map((field) => (
            <div key={field} className="contents">
              <span className="text-[13px] leading-5 text-muted">
                {field === 'doi' ? 'DOI' : t(`detail.${field}` as never)}
              </span>
              <InlineField
                field={field}
                value={doc[field] ?? ''}
                remoteValue={remoteValues[field]}
                docId={doc.id}
                onSaved={onSaved}
                variant="metadata"
              />
            </div>
          ))}
        </div>

        <div className="mt-6 flex flex-col gap-1 border-t border-border pt-5">
          <span className="text-label font-semibold uppercase tracking-wide text-muted">
            {t('detail.addedAt')}
          </span>
          <div className="text-sm text-muted">{formatDate(doc.addedAt)}</div>
        </div>

        <div className="mt-4 flex flex-col gap-1">
          <div className="flex items-center justify-between">
            <span className="text-label font-semibold uppercase tracking-wide text-muted">
              {t('detail.filePath')}
            </span>
            {!doc.fileMissing && (
              <div className="flex items-center gap-2">
                <Button
                  variant="link"
                  size="sm"
                  icon={<FileText className="h-3.5 w-3.5" />}
                  onClick={handleOpenPdf}
                >
                  {t('common.openFile')}
                </Button>
                <Button
                  variant="link"
                  size="sm"
                  icon={<FolderOpen className="h-3.5 w-3.5" />}
                  onClick={() => openInFinder(doc.id)}
                >
                  {t('common.showInFolder')}
                </Button>
              </div>
            )}
          </div>
          <div className="flex items-center gap-2">
            <span className="truncate text-sm text-muted">
              {formatFilePath(doc.filePath)}
            </span>
            {doc.fileMissing && (
              <Button
                variant="link"
                size="sm"
                className="flex-shrink-0 text-warning"
                onClick={handleRelocate}
              >
                {t('detail.relocate')}
              </Button>
            )}
          </div>
        </div>

        {isMoved && (
          <div className="mt-3 flex flex-col gap-1">
            <Button
              variant="link"
              size="sm"
              className="self-start"
              onClick={handleRestore}
            >
              {t('detail.restoreOriginal')}
            </Button>
          </div>
        )}

        <OcrSection key={doc.id} doc={doc} />

        <div className="mt-5">
          <NoteField key={doc.id} value={doc.note ?? ''} docId={doc.id} onSaved={onSaved} />
        </div>

        <div className="mt-4">
          <CategoryChips docId={doc.id} docCategories={doc.categories} />
        </div>

        <Button
          variant="ghost"
          size="sm"
          className="mt-5 self-start text-error"
          icon={<Trash className="h-3.5 w-3.5" />}
          onClick={() => requestDeleteConfirm([doc.id], t('dialog.deleteConfirm'))}
        >
          {t('common.delete')}
        </Button>
      </div>
    </div>
  )
}

function BulkBar({
  count,
  selectedIds
}: {
  count: number
  selectedIds: string[]
}) {
  const { t } = useTranslation()
  const requestDeleteConfirm = useDocumentStore((s) => s.requestDeleteConfirm)
  const bulkRefreshMetadata = useDocumentStore((s) => s.bulkRefreshMetadata)
  const bulkCategorize = useDocumentStore((s) => s.bulkCategorize)
  const allCategories = useDocumentStore((s) => s.categories)
  const fetchCategories = useDocumentStore((s) => s.fetchCategories)
  const [bulkCategory, setBulkCategory] = useState<string>()

  useEffect(() => {
    void fetchCategories()
  }, [])

  return (
    <div className="flex flex-col gap-4 px-5 py-4">
      <div className="text-sm font-semibold text-foreground">
        {t('common.multiSelected', { count })}
      </div>
      <div className="flex flex-col gap-2">
        <Button
          variant="ghost"
          size="md"
          className="self-start text-error"
          icon={<Trash className="h-4 w-4" />}
          onClick={() =>
            requestDeleteConfirm(
              selectedIds,
              count > 1
                ? t('dialog.deleteConfirmBulk', { count })
                : t('dialog.deleteConfirm')
            )
          }
        >
          {t('common.delete')} ({count})
        </Button>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted">{t('sidebar.categories')}</span>
          <Select
            value={bulkCategory}
            placeholder={`${t('common.create')}…`}
            onChange={(v: string) => {
              if (v) {
                bulkCategorize(selectedIds, v)
                setBulkCategory(undefined)
              }
            }}
            options={allCategories.map((c) => ({ label: c.name, value: c.id }))}
            size="small"
            style={{ width: 160 }}
          />
        </div>
        <Button
          variant="ghost"
          size="md"
          className="self-start"
          icon={<ArrowClockwise className="h-4 w-4" />}
          onClick={() => bulkRefreshMetadata(selectedIds)}
        >
          {t('detail.refreshMetadata')} ({count})
        </Button>
        <Button
          variant="ghost"
          size="md"
          className="self-start"
          icon={<FileText className="h-4 w-4" />}
          onClick={() => void api.export.toBibtex(selectedIds)}
        >
          {t('common.exportBibtexTitle')} ({count})
        </Button>
      </div>
    </div>
  )
}

export default function DetailPanel({ onClose }: { onClose?: () => void }) {
  const { t } = useTranslation()
  const documents = useDocumentStore((s) => s.documents)
  const searchResults = useDocumentStore((s) => s.searchResults) ?? []
  const isSearching = useDocumentStore((s) => s.isSearching) ?? false
  const selectedIds = useDocumentStore((s) => s.selectedIds)
  const focusedDocId = useDocumentStore((s) => s.focusedDocId)

  const focusedDoc = (isSearching ? searchResults : documents)
    .find((d) => d.id === focusedDocId) ??
    documents.find((d) => d.id === focusedDocId) ??
    searchResults.find((d) => d.id === focusedDocId) ??
    null

  if (selectedIds.length >= 2) {
    return (
    <div className="relative flex shrink-0 flex-col bg-panel">
        <PanelHeader
          title={t('common.multiSelected', { count: selectedIds.length })}
          onClose={onClose}
        />
        <BulkBar count={selectedIds.length} selectedIds={selectedIds} />
      </div>
    )
  }

  if (!focusedDoc) {
    return (
      <div className="relative flex shrink-0 flex-col bg-panel">
        <PanelHeader onClose={onClose} />
        <EmptyState
          icon={<FileText className="h-10 w-10" />}
          title={t('common.selectDocHint')}
        />
      </div>
    )
  }

  return (
    <div className="relative flex min-h-full shrink-0 flex-col bg-background">
      <div className="relative z-10">
        <PanelHeader onClose={onClose} />
      </div>
      <SingleDetail doc={focusedDoc} />
    </div>
  )
}
