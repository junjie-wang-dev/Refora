import { useTranslation } from 'react-i18next'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useRef, useState, useCallback, useEffect, type ReactNode } from 'react'
import { CaretUp, CaretDown, Star, Warning, Lightning, Check, FileText, FolderOpen, Copy, ArrowClockwise, Trash, MagnifyingGlass, TreeStructure, Plus, FilePlus } from '@phosphor-icons/react'
import { showContextMenu } from '@lobehub/ui'
import type { ContextMenuItem } from '@lobehub/ui'
import { useDocumentStore } from '../store/documentStore'
import { api } from '../ipc'
import { formatAuthors, formatDate, formatFilePath } from '../utils/format'
import { Button as UiButton, EmptyState, PanelTabHeader } from './ui'
import type { Document, ColumnId, SortField, ListColumn, Category } from '../../shared/ipc-types'
import { errorMessage } from '../../shared/ipc-types'

const ROW_HEIGHT = 36
const COMPACT_ROW_HEIGHT = 52
const MIN_COL_WIDTH = 40
const DOC_MIME = 'application/x-refora-docids'

function renderCell(doc: Document, col: ColumnId): string {
  switch (col) {
    case 'title':
      return doc.title || doc.fileName
    case 'authors':
      return formatAuthors(doc.authors) || '\u2014'
    case 'year':
      return doc.year || '\u2014'
    case 'venue':
      return doc.venue || '\u2014'
    case 'addedAt':
      return formatDate(doc.addedAt)
    case 'filePath':
      return formatFilePath(doc.filePath)
  }
}

function highlightMatch(text: string, query: string): ReactNode {
  const tokens = query.trim().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return text
  const pattern = tokens.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
  const parts = text.split(new RegExp(`(${pattern})`, 'gi'))
  return parts.map((part, i) =>
    i % 2 === 1 ? (
      <mark key={i} className="rounded-[3px] bg-warning/30 px-0.5 text-inherit">
        {part}
      </mark>
    ) : (
      <span key={i}>{part}</span>
    )
  )
}

function ColumnHeader({
  id,
  label,
  width,
  displayWidth,
  sortField,
  sortDir,
  onSort,
  onResize,
  onLiveResize,
  onLiveResizeEnd,
  onContextMenu
}: {
  id: ColumnId
  label: string
  width: number
  displayWidth: number
  sortField: SortField
  sortDir: 'asc' | 'desc'
  onSort: () => void
  onResize: (id: ColumnId, width: number) => void
  onLiveResize: (id: ColumnId, width: number) => void
  onLiveResizeEnd: () => void
  onContextMenu: (e: React.MouseEvent) => void
}) {
  const isSorted = sortField === id
  const startRef = useRef({ x: 0, w: 0 })
  const currentWidthRef = useRef(width)

  const handleResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
      startRef.current = { x: e.clientX, w: width }
      currentWidthRef.current = width

      const onMouseMove = (ev: MouseEvent) => {
        const delta = ev.clientX - startRef.current.x
        const newWidth = Math.max(MIN_COL_WIDTH, startRef.current.w + delta)
        currentWidthRef.current = newWidth
        onLiveResize(id, newWidth)
      }

      const onMouseUp = () => {
        document.removeEventListener('mousemove', onMouseMove)
        document.removeEventListener('mouseup', onMouseUp)
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
        onResize(id, currentWidthRef.current)
        onLiveResizeEnd()
      }

      document.addEventListener('mousemove', onMouseMove)
      document.addEventListener('mouseup', onMouseUp)
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
    },
    [id, width, onResize, onLiveResize, onLiveResizeEnd]
  )

  return (
    <div
      className="relative flex items-center px-1 font-semibold uppercase tracking-wide text-muted cursor-pointer select-none flex-shrink-0 text-label"
      style={{ width: displayWidth, minWidth: displayWidth }}
      onClick={onSort}
      onContextMenu={onContextMenu}
    >
      <span className="truncate">{label}</span>
      {isSorted && (
        <span className="ml-0.5">
          {sortDir === 'asc' ? <CaretUp className="h-3 w-3" /> : <CaretDown className="h-3 w-3" />}
        </span>
      )}
      <div
        className="absolute right-0 top-0 h-full w-1 cursor-col-resize transition-colors duration-150 hover:bg-accent"
        onMouseDown={handleResizeStart}
      />
    </div>
  )
}

function SkeletonRows({ compact }: { compact: boolean }) {
  return (
    <div>
      {Array.from({ length: 5 }).map((_, i) => (
        <div
          key={i}
          className="flex items-center px-3"
          style={{ height: compact ? COMPACT_ROW_HEIGHT : ROW_HEIGHT }}
        >
          <div className={compact ? 'w-7' : 'w-10'} />
          {!compact && <div className="w-8" />}
          {!compact && <div className="w-8" />}
          <div className={compact ? 'min-w-0 flex-1 space-y-2' : 'contents'}>
            <div className="skeleton-shimmer mx-1 h-3 flex-1 rounded" />
            {compact ? (
              <div className="skeleton-shimmer mx-1 h-3 w-2/3 rounded" />
            ) : (
              <>
                <div className="skeleton-shimmer mx-1 h-3 rounded" style={{ width: 192 }} />
                <div className="skeleton-shimmer mx-1 h-3 rounded" style={{ width: 64 }} />
                <div className="skeleton-shimmer mx-1 h-3 rounded" style={{ width: 128 }} />
                <div className="skeleton-shimmer mx-1 h-3 rounded" style={{ width: 96 }} />
                <div className="skeleton-shimmer mx-1 h-3 rounded" style={{ width: 192 }} />
              </>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}

function visibleColumns(cols: ListColumn[]): ListColumn[] {
  return [...cols].filter((c) => c.visible).sort((a, b) => a.order - b.order)
}

interface DocumentListProps {
  compact?: boolean
  onClose?: () => void
  onDocumentFocus?: () => void
}

export default function DocumentList({
  compact = false,
  onClose,
  onDocumentFocus
}: DocumentListProps = {}) {
  const { t } = useTranslation()
  const documents = useDocumentStore((s) => s.documents)
  const isLoading = useDocumentStore((s) => s.isLoading)
  const listColumnState = useDocumentStore((s) => s.listColumnState)
  const selectedIds = useDocumentStore((s) => s.selectedIds)
  const listMode = useDocumentStore((s) => s.listMode)
  const setSort = useDocumentStore((s) => s.setSort)
  const setColumns = useDocumentStore((s) => s.setColumns)
  const toggleSelect = useDocumentStore((s) => s.toggleSelect)
  const setFocusedDoc = useDocumentStore((s) => s.setFocusedDoc)
  const toggleStar = useDocumentStore((s) => s.toggleStar)
  const openPdf = useDocumentStore((s) => s.openPdf)
  const openInFinder = useDocumentStore((s) => s.openInFinder)
  const requestDeleteConfirm = useDocumentStore((s) => s.requestDeleteConfirm)
  const refreshMetadata = useDocumentStore((s) => s.refreshMetadata)
  const isSearching = useDocumentStore((s) => s.isSearching)
  const searchResults = useDocumentStore((s) => s.searchResults)
  const searchQuery = useDocumentStore((s) => s.searchQuery)
  const clearSearch = useDocumentStore((s) => s.clearSearch)
  const categories = useDocumentStore((s) => s.categories)
  const createCategory = useDocumentStore((s) => s.createCategory)
  const fetchDocuments = useDocumentStore((s) => s.fetchDocuments)
  const loadMoreDocuments = useDocumentStore((s) => s.loadMoreDocuments)
  const loadMoreSearchResults = useDocumentStore((s) => s.loadMoreSearchResults)

  const parentRef = useRef<HTMLDivElement>(null)

  const cols = visibleColumns(listColumnState.columns)

  const [liveWidths, setLiveWidths] = useState<Record<string, number>>({})

  const handleLiveResize = useCallback((id: ColumnId, w: number) => {
    setLiveWidths((prev) => ({ ...prev, [id]: w }))
  }, [])

  const handleLiveResizeEnd = useCallback(() => {
    setLiveWidths({})
  }, [])

  const displayDocs = isSearching ? searchResults : documents
  const rowHeight = compact ? COMPACT_ROW_HEIGHT : ROW_HEIGHT

  const virtualizer = useVirtualizer({
    count: displayDocs.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => rowHeight,
    overscan: 5
  })
  const virtualItems = virtualizer.getVirtualItems()
  const lastVirtualIndex = virtualItems.length > 0
    ? virtualItems[virtualItems.length - 1].index
    : -1

  useEffect(() => {
    if (displayDocs.length === 0 || lastVirtualIndex < displayDocs.length - 10) return
    if (isSearching) {
      void loadMoreSearchResults?.()
    } else {
      void loadMoreDocuments?.()
    }
  }, [
    displayDocs.length,
    isSearching,
    lastVirtualIndex,
    loadMoreDocuments,
    loadMoreSearchResults
  ])

  const toggleColumn = useCallback(
    (id: ColumnId) => {
      const updated = listColumnState.columns.map((c) =>
        c.id === id ? { ...c, visible: !c.visible } : c
      )
      setColumns(updated)
    },
    [listColumnState.columns, setColumns]
  )

  const handleResize = useCallback(
    (id: ColumnId, width: number) => {
      const updated = listColumnState.columns.map((c) =>
        c.id === id ? { ...c, width } : c
      )
      setColumns(updated)
    },
    [listColumnState.columns, setColumns]
  )

  const handleRowClick = useCallback(
    (docId: string, e: React.MouseEvent) => {
      e.preventDefault()
      setFocusedDoc(docId)
      onDocumentFocus?.()
    },
    [setFocusedDoc, onDocumentFocus]
  )

  const handleCopyPath = useCallback((filePath: string) => {
    void navigator.clipboard.writeText(filePath).catch(() => {
      useDocumentStore.getState().showToast(t('common.copyFailed'))
    })
  }, [t])

  const handleAddFiles = useCallback(async () => {
    try {
      await api.import.addFiles([])
    } catch (error) {
      useDocumentStore.getState().showToast(
        errorMessage(error, t('documentErrors.importFilesFailed'))
      )
    }
    void fetchDocuments()
  }, [fetchDocuments, t])

  const handleCopyBibtex = useCallback(async (ids: string[]) => {
    try {
      const bibtex = await api.export.toBibtexString(ids)
      if (!bibtex) return
      await navigator.clipboard.writeText(bibtex)
      useDocumentStore.getState().showToast(t('common.bibtexCopied', { count: ids.length }))
    } catch {
      useDocumentStore.getState().showToast(t('common.copyFailed'))
    }
  }, [t])

  const handleRowContextMenu = useCallback(
    (doc: Document, e: React.MouseEvent) => {
      e.preventDefault()
      const effectiveIds =
        selectedIds.length > 0 && selectedIds.includes(doc.id) ? selectedIds : [doc.id]
      const assignToCategory = async (catId: string) => {
        try {
          if (effectiveIds.length === 1) {
            await api.categories.assign(effectiveIds[0], catId)
          } else {
            await api.documents.bulkCategorize(effectiveIds, catId)
          }
          void useDocumentStore.getState().fetchCategories()
        } catch (err) {
          useDocumentStore.getState().showToast(
            errorMessage(err, t('documentErrors.categorizeFailed'))
          )
        }
      }
      const createAndAssign = async () => {
        const name = window.prompt(t('sidebar.categoryName'))
        if (!name || !name.trim()) return
        const cat = await createCategory(name.trim())
        if (cat) await assignToCategory(cat.id)
      }

      const categoryItems: ContextMenuItem[] = categories.length
        ? categories.map((c: Category) => ({
            key: `cat-${c.id}`,
            label: `${c.name} (${c.count ?? 0})`,
            onClick: () => { void assignToCategory(c.id) },
          }))
        : [{
            key: 'no-categories',
            label: t('sidebar.emptyCategories'),
            disabled: true,
            onClick: () => {},
          }]

      const items: ContextMenuItem[] = [
        {
          key: 'addToCategory',
          label: t('sidebar.addToCategory'),
          icon: <TreeStructure className="h-3.5 w-3.5" />,
          type: 'submenu',
          children: [
            ...categoryItems,
            { type: 'divider' as const, key: 'cat-divider' },
            {
              key: 'create-category',
              label: t('sidebar.createCategory'),
              icon: <Plus className="h-3.5 w-3.5" />,
              onClick: () => { void createAndAssign() },
            },
          ],
        },
        { type: 'divider' as const, key: 'divider-1' },
        {
          key: 'openFile',
          label: t('common.openFile'),
          icon: <FileText className="h-3.5 w-3.5" />,
          onClick: () => openPdf(doc.id),
        },
        {
          key: 'showInFolder',
          label: t('common.showInFolder'),
          icon: <FolderOpen className="h-3.5 w-3.5" />,
          onClick: () => openInFinder(doc.id),
        },
        {
          key: 'copyPath',
          label: t('common.copyPath'),
          icon: <Copy className="h-3.5 w-3.5" />,
          onClick: () => handleCopyPath(doc.filePath),
        },
        {
          key: 'copyBibtex',
          label: t('common.copyBibtex'),
          icon: <Copy className="h-3.5 w-3.5" />,
          onClick: () => { void handleCopyBibtex(effectiveIds) },
        },
        {
          key: 'refreshMetadata',
          label: t('detail.refreshMetadata'),
          icon: <ArrowClockwise className="h-3.5 w-3.5" />,
          onClick: () => refreshMetadata(doc.id),
        },
        {
          key: 'delete',
          label: t('common.delete'),
          icon: <Trash className="h-3.5 w-3.5" />,
          onClick: () =>
            requestDeleteConfirm(
              effectiveIds,
              effectiveIds.length > 1
                ? t('dialog.deleteConfirmBulk', { count: effectiveIds.length })
                : t('dialog.deleteConfirm')
            ),
          danger: true,
        },
      ]
      showContextMenu(items)
    },
    [t, openInFinder, handleCopyPath, handleCopyBibtex, refreshMetadata, requestDeleteConfirm, selectedIds, categories, createCategory, openPdf]
  )

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    const files = e.dataTransfer.files
    if (files.length === 0) return
    e.preventDefault()
    const paths: string[] = []
    for (let i = 0; i < files.length; i++) {
      try {
        const p = await api.getPathForFile(files[i] as File)
        if (p && p.toLowerCase().endsWith('.pdf')) {
          paths.push(p)
        }
      } catch (e) {
        useDocumentStore.getState().showToast(
          errorMessage(e, t('documentErrors.readFilePathFailed'))
        )
      }
    }
    if (paths.length > 0) {
      try {
        await api.import.addFiles(paths)
      } catch (e) {
        useDocumentStore.getState().showToast(
          errorMessage(e, t('documentErrors.importFilesFailed'))
        )
      }
      void fetchDocuments()
    }
  }, [fetchDocuments, t])

  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (e.dataTransfer.types.includes('Files')) {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
    }
  }, [])

  const handleDragStart = useCallback(
    (docId: string, e: React.DragEvent) => {
      const ids = selectedIds.length > 0 && selectedIds.includes(docId) ? selectedIds : [docId]
      e.dataTransfer.setData(DOC_MIME, JSON.stringify(ids))
      e.dataTransfer.setData('text/plain', ids.join(','))
      e.dataTransfer.effectAllowed = 'copyMove'
    },
    [selectedIds]
  )

  const sortedColumns = [...listColumnState.columns].sort((a, b) => a.order - b.order)
  const compactTitle = listMode.mode === 'category'
    ? categories.find((category) => category.id === listMode.categoryId)?.name ?? t('sidebar.categories')
    : t(`sidebar.${listMode.mode === 'all' ? 'allFiles' : listMode.mode}`)

  const handleColContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      const colItems: ContextMenuItem[] = sortedColumns.map((col) => ({
        key: col.id,
        label: t(`list.${col.id}` as never),
        icon: col.visible ? <Check className="h-3.5 w-3.5" /> : <span className="inline-block w-[14px]" />,
        onClick: () => toggleColumn(col.id),
      }))
      showContextMenu(colItems)
    },
    [sortedColumns, t, toggleColumn]
  )

  const colHeaderBar =
    !compact && cols.length > 0 ? (
      <div className="relative flex" style={{ background: 'linear-gradient(to right, var(--color-background), var(--color-panel) 60px)' }}>
        <div className="w-10 flex-shrink-0" />
        <div className="w-8 flex-shrink-0" />
        <div className="w-8 flex-shrink-0" />
        {cols.map((col) => (
          <ColumnHeader
            key={col.id}
            id={col.id}
            label={t(`list.${col.id}` as never)}
            width={col.width}
            displayWidth={liveWidths[col.id] ?? col.width}
            sortField={listColumnState.sort.field}
            sortDir={listColumnState.sort.dir}
            onSort={() => setSort(col.id)}
            onResize={handleResize}
            onLiveResize={handleLiveResize}
            onLiveResizeEnd={handleLiveResizeEnd}
            onContextMenu={handleColContextMenu}
          />
        ))}
        <div className="absolute bottom-0 left-0 right-0 h-px" style={{ background: 'linear-gradient(to right, var(--color-background), var(--color-border) 100px)' }} />
      </div>
    ) : null

  return (
    <div
      className="document-list flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background"
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {compact ? (
        <PanelTabHeader
          title={compactTitle}
          onClose={onClose}
          closeLabel={t('list.close')}
        />
      ) : null}
      {colHeaderBar}

      <div
        ref={parentRef}
        className="min-h-0 flex-1 overflow-auto"
        role="grid"
        aria-label={t('list.documentList')}
      >
        {isLoading ? (
          <SkeletonRows compact={compact} />
        ) : displayDocs.length === 0 ? (
          isSearching ? (
            <EmptyState
              className="h-full"
              icon={<MagnifyingGlass className="h-10 w-10" />}
              title={t('common.noSearchResults')}
              action={
                <UiButton variant="secondary" size="md" onClick={clearSearch}>
                  {t('common.clearSearch')}
                </UiButton>
              }
            />
          ) : (
            <EmptyState
              className="h-full"
              icon={<FileText className="h-10 w-10" />}
              title={t('common.emptyLibrary')}
              action={
                <UiButton
                  variant="primary"
                  size="md"
                  icon={<FilePlus className="h-4 w-4" />}
                  onClick={handleAddFiles}
                >
                  {t('topbar.addFile')}
                </UiButton>
              }
            />
          )
        ) : (
          <div
            role="rowgroup"
            style={{
              height: virtualizer.getTotalSize(),
              width: '100%',
              position: 'relative'
            }}
          >
            {virtualItems.map((vr) => {
              const doc = displayDocs[vr.index]
              const isSelected = selectedIds.includes(doc.id)
              const isMissing = doc.fileMissing === 1
              const isFailed = doc.metadataStatus === 'failed'
              const hasError = isMissing || isFailed

              return (
                <div
                  key={vr.key}
                  role="presentation"
                  data-index={vr.index}
                  data-document-id={doc.id}
                  ref={virtualizer.measureElement}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    transform: `translateY(${vr.start}px)`
                  }}
                  draggable
                  onDragStart={(e) => handleDragStart(doc.id, e)}
                  onContextMenu={(e) => handleRowContextMenu(doc, e)}
                >
                  <div
                    role="row"
                    tabIndex={0}
                    aria-selected={isSelected}
                    className={`flex ${
                      compact ? 'items-start px-2 py-2' : 'items-center px-3'
                    } text-xs cursor-pointer transition-colors duration-150 ${
                      isSelected ? 'bg-active' : 'hover:bg-hover'
                    }`}
                    style={{ height: rowHeight }}
                    onClick={(e) => handleRowClick(doc.id, e)}
                    onKeyDown={(event) => {
                      if (event.key !== 'Enter' && event.key !== ' ') return
                      event.preventDefault()
                      setFocusedDoc(doc.id)
                      onDocumentFocus?.()
                    }}
                  >
                    {!compact && (
                      <>
                        <div role="gridcell" className="flex w-10 flex-shrink-0 items-center justify-center">
                          <input
                            type="checkbox"
                            className="h-4 w-4 rounded border-border bg-background accent-accent cursor-pointer"
                            checked={isSelected}
                            onChange={(e) => {
                              e.stopPropagation()
                              toggleSelect(doc.id)
                            }}
                            onClick={(e) => e.stopPropagation()}
                          />
                        </div>
                        <div role="gridcell" className="flex w-8 flex-shrink-0 items-center justify-center text-center">
                          {isMissing ? (
                            <span title={t('detail.relocate') ?? 'Relocate'}>
                              <Warning className="h-4 w-4 text-warning" />
                            </span>
                          ) : (
                            <button
                              className="flex items-center justify-center text-accent transition-colors duration-150 hover:text-accent-hover cursor-pointer"
                              title={t('detail.open')}
                              aria-label={t('detail.open')}
                              onClick={(e) => {
                                e.stopPropagation()
                                openPdf(doc.id)
                              }}
                            >
                              <FileText className="h-4 w-4" />
                            </button>
                          )}
                        </div>
                      </>
                    )}
                    <div role="gridcell" className={`flex-shrink-0 text-center ${compact ? 'w-7 pt-0.5' : 'w-8'}`}>
                      <button
                        className="cursor-pointer"
                        title={t('sidebar.starred')}
                        aria-label={t('sidebar.starred')}
                        onClick={(e) => {
                          e.stopPropagation()
                          toggleStar(doc.id)
                        }}
                      >
                        <Star
                          className={`h-4 w-4 ${
                            doc.starred ? 'fill-yellow-400 text-yellow-400' : 'text-muted'
                          }`}
                        />
                      </button>
                    </div>
                    {compact ? (
                      <div role="gridcell" className="min-w-0 flex-1 pl-1">
                        <div className="flex min-w-0 items-center gap-1.5">
                          <span className={`min-w-0 flex-1 truncate text-xs font-medium leading-4 ${isMissing ? 'text-muted' : 'text-foreground'}`}>
                            {isSearching ? highlightMatch(renderCell(doc, 'title'), searchQuery) : renderCell(doc, 'title')}
                          </span>
                          {hasError && !isMissing && (
                            <Lightning className="h-3.5 w-3.5 shrink-0 text-error" aria-hidden="true" />
                          )}
                        </div>
                        <div className="mt-0.5 truncate text-xs leading-4 text-muted">
                          {isSearching ? highlightMatch(renderCell(doc, 'authors'), searchQuery) : renderCell(doc, 'authors')}
                        </div>
                      </div>
                    ) : cols.map((col) => {
                      const cellText = renderCell(doc, col.id)
                      const content = isSearching ? highlightMatch(cellText, searchQuery) : cellText
                      return (
                        <div
                          key={col.id}
                          role="gridcell"
                          className="truncate px-1"
                          style={{ width: liveWidths[col.id] ?? col.width, flexShrink: 0 }}
                        >
                          {col.id === 'title' ? (
                            <span className={`${isMissing ? 'text-muted' : 'text-foreground'}`}>
                              {content}
                            </span>
                          ) : (
                            <span className="text-muted">{content}</span>
                          )}
                        </div>
                      )
                    })}
                    {!compact && hasError && !isMissing && (
                      <div role="gridcell" className="ml-1 flex-shrink-0" title={`${t('common.networkError')} (${doc.metadataAttempts})`}>
                        <Lightning className="h-3.5 w-3.5 text-error" aria-hidden="true" />
                      </div>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
