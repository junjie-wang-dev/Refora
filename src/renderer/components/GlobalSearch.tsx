import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ChatCircleText,
  CircleNotch,
  File,
  FileText,
  MagnifyingGlass,
  NotePencil,
  X
} from '@phosphor-icons/react'
import { api } from '../ipc'
import { useClickOutside } from '../hooks/useClickOutside'
import { useDocumentStore } from '../store/documentStore'
import { useWorkspaceStore } from '../store/workspaceStore'
import { Input as UiInput } from './ui'
import type {
  ChatSearchResult,
  Document,
  GlobalSearchResult,
  WorkspaceContentSearchResult,
  WorkspaceFileSearchResult
} from '../../shared/ipc-types'
import { errorMessage } from '../../shared/ipc-types'
import { formatAuthors } from '../utils/format'
import { highlightMatch } from '../utils/highlightMatch'

const EMPTY_RESULTS: GlobalSearchResult = {
  documents: [],
  workspaceFiles: [],
  workspaceContents: [],
  chats: []
}

type SearchSelection =
  | { kind: 'document'; value: Document }
  | { kind: 'workspaceFile'; value: WorkspaceFileSearchResult }
  | { kind: 'workspaceContent'; value: WorkspaceContentSearchResult }
  | { kind: 'chat'; value: ChatSearchResult }

function searchSelectionId(selection: SearchSelection): string {
  const id = selection.kind === 'chat' ? selection.value.threadId : selection.value.id
  return `global-search-option-${selection.kind}-${encodeURIComponent(id)}`
}

interface GlobalSearchProps {
  documentListOpen?: boolean
  onOpenChat?: () => void
}

export default function GlobalSearch({ documentListOpen = false, onOpenChat }: GlobalSearchProps) {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<GlobalSearchResult>(EMPTY_RESULTS)
  const [resolvedQuery, setResolvedQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)
  const [searchRetry, setSearchRetry] = useState(0)
  const [expanded, setExpanded] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const requestVersionRef = useRef(0)
  const translationRef = useRef(t)
  translationRef.current = t
  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId)
  const chatStreaming = useWorkspaceStore((state) => state.chatStreaming)
  const setSearchResults = useDocumentStore((state) => state.setSearchResults)
  const setFocusedDoc = useDocumentStore((state) => state.setFocusedDoc)
  const clearSearch = useDocumentStore((state) => state.clearSearch)

  const selections = useMemo<SearchSelection[]>(() => [
    ...results.documents.map((value) => ({ kind: 'document' as const, value })),
    ...results.workspaceFiles.map((value) => ({ kind: 'workspaceFile' as const, value })),
    ...results.workspaceContents.map((value) => ({ kind: 'workspaceContent' as const, value })),
    ...results.chats.map((value) => ({ kind: 'chat' as const, value }))
  ], [results])

  const close = useCallback(() => setExpanded(false), [])
  useClickOutside(rootRef, close, expanded)

  const resetLocalSearch = useCallback(() => {
    requestVersionRef.current += 1
    setQuery('')
    setResults(EMPTY_RESULTS)
    setResolvedQuery('')
    setLoading(false)
    setSearchError(null)
    setExpanded(false)
    setActiveIndex(0)
  }, [])

  useEffect(() => {
    const handleLibrarySwitched = () => {
      resetLocalSearch()
    }
    return api.events.onLibrarySwitched(handleLibrarySwitched)
  }, [resetLocalSearch])

  useEffect(() => {
    const trimmed = query.trim()
    const requestVersion = ++requestVersionRef.current
    if (!trimmed) {
      setResults(EMPTY_RESULTS)
      setResolvedQuery('')
      setLoading(false)
      setExpanded(false)
      setActiveIndex(0)
      setSearchError(null)
      return
    }
    setLoading(true)
    setSearchError(null)
    setExpanded(true)
    const timer = window.setTimeout(() => {
      void api.search.global(trimmed)
        .then((nextResults) => {
          if (requestVersionRef.current !== requestVersion) return
          setResults(nextResults)
          setResolvedQuery(trimmed)
          setSearchError(null)
          setActiveIndex(0)
        })
        .catch((cause) => {
          if (requestVersionRef.current !== requestVersion) return
          setResults(EMPTY_RESULTS)
          setResolvedQuery('')
          setSearchError(errorMessage(cause, translationRef.current('globalSearch.searchFailed')))
          setActiveIndex(0)
        })
        .finally(() => {
          if (requestVersionRef.current === requestVersion) setLoading(false)
        })
    }, 180)
    return () => window.clearTimeout(timer)
  }, [query, searchRetry])

  useEffect(() => {
    if (!documentListOpen) {
      return
    }
    const unsubscribe = useDocumentStore.subscribe((state, previousState) => {
      if (previousState.isSearching && !state.isSearching) {
        resetLocalSearch()
      }
    })
    return unsubscribe
  }, [documentListOpen, resetLocalSearch])

  useEffect(() => {
    if (!documentListOpen) return
    const trimmed = query.trim()
    if (!trimmed) {
      if (useDocumentStore.getState().isSearching) {
        useDocumentStore.getState().clearSearch()
      }
      return
    }
    if (resolvedQuery !== trimmed) return
    setSearchResults(query, results.documents)
  }, [documentListOpen, query, resolvedQuery, results.documents, setSearchResults])

  const selectResult = useCallback(async (selection: SearchSelection) => {
    if (selection.kind === 'document') {
      setSearchResults(query, results.documents)
      setFocusedDoc(selection.value.id)
    } else if (selection.kind === 'workspaceFile') {
      const store = useWorkspaceStore.getState()
      if (store.activeWorkspaceId !== selection.value.workspaceId) {
        if (store.chatStreaming) return
        if (!await store.requestActiveWorkspace(selection.value.workspaceId)) return
      } else {
        store.openPanel()
      }
      void api.workspaceAssets.open(selection.value.id).catch((error) => {
        useDocumentStore.getState().showToast(
          errorMessage(error, t('workspace.assetOpenFailed'))
        )
      })
    } else if (selection.kind === 'workspaceContent') {
      const store = useWorkspaceStore.getState()
      if (store.activeWorkspaceId !== selection.value.workspaceId) {
        if (store.chatStreaming) return
        if (!await store.requestActiveWorkspace(selection.value.workspaceId)) return
      } else {
        store.openPanel()
      }
      useWorkspaceStore.getState().openMarkdownCard(selection.value.kind, selection.value.id)
    } else {
      const store = useWorkspaceStore.getState()
      if (store.chatStreaming) return
      if (store.activeWorkspaceId !== selection.value.workspaceId) {
        if (!await store.requestActiveWorkspace(selection.value.workspaceId)) return
      } else if (selection.value.workspaceId) {
        store.openPanel()
      }
      useWorkspaceStore.getState().setActiveThreadId(selection.value.threadId)
      onOpenChat?.()
    }
    setExpanded(false)
  }, [onOpenChat, query, results.documents, setFocusedDoc, setSearchResults, t])

  const clear = useCallback(() => {
    const shouldClearDocumentSearch = useDocumentStore.getState().isSearching
    resetLocalSearch()
    if (shouldClearDocumentSearch) clearSearch()
  }, [clearSearch, resetLocalSearch])

  const total = selections.length
  const showResults = expanded && query.trim().length > 0
  let selectionOffset = 0

  const selectionUnavailable = useCallback((selection: SearchSelection) => {
    if (!chatStreaming || selection.kind === 'document') return false
    if (selection.kind === 'chat') return true
    return selection.value.workspaceId !== activeWorkspaceId
  }, [activeWorkspaceId, chatStreaming])

  const selectableIndices = useMemo(
    () => selections.flatMap((selection, index) => selectionUnavailable(selection) ? [] : [index]),
    [selectionUnavailable, selections]
  )

  useEffect(() => {
    if (!selectableIndices.includes(activeIndex)) {
      setActiveIndex(selectableIndices[0] ?? 0)
    }
  }, [activeIndex, selectableIndices])

  const resultButton = (
    selection: SearchSelection,
    content: ReactNode,
    label: string
  ) => {
    const index = selectionOffset++
    const selectionId = selection.kind === 'chat' ? selection.value.threadId : selection.value.id
    const unavailable = selectionUnavailable(selection)
    return (
      <button
        key={`${selection.kind}:${selectionId}`}
        type="button"
        role="option"
        aria-label={label}
        aria-selected={!unavailable && index === activeIndex}
        aria-disabled={unavailable}
        disabled={unavailable}
        title={unavailable ? t('globalSearch.unavailableWhileStreaming') : undefined}
        className={`flex w-full min-w-0 items-start gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors duration-150 ${
          unavailable
            ? 'cursor-not-allowed opacity-45'
            : index === activeIndex ? 'bg-active' : 'hover:bg-hover'
        }`}
        onMouseEnter={() => {
          if (!unavailable) setActiveIndex(index)
        }}
        id={searchSelectionId(selection)}
        onClick={() => void selectResult(selection)}
      >
        {content}
      </button>
    )
  }

  return (
    <div
      ref={rootRef}
      className="no-drag pointer-events-auto absolute left-1/2 top-2.5 z-[60] isolate w-[min(480px,calc(100vw-32px))] -translate-x-1/2"
      onMouseDownCapture={(event) => {
        const target = event.target
        if (!(target instanceof Element) || !target.closest('button')) {
          inputRef.current?.focus()
        }
      }}
    >
      <div className="relative">
        <MagnifyingGlass className="no-drag pointer-events-none absolute left-2.5 top-1/2 z-10 h-3.5 w-3.5 -translate-y-1/2 text-muted" />
        <UiInput
          ref={inputRef}
          variant="outlined"
          inputSize="sm"
          className="doc-search-input min-w-0 bg-background pl-8 pr-14 shadow-sm"
          value={query}
          placeholder={t('globalSearch.placeholder')}
          role="combobox"
          aria-label={t('globalSearch.label')}
          aria-autocomplete="list"
          aria-controls="global-search-results"
          aria-activedescendant={showResults && selections[activeIndex]
            ? searchSelectionId(selections[activeIndex])
            : undefined}
          aria-expanded={showResults}
          maxLength={500}
          onFocus={() => {
            if (query.trim()) setExpanded(true)
          }}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault()
              setExpanded(false)
              event.currentTarget.blur()
            } else if (event.key === 'ArrowDown' && selectableIndices.length > 0) {
              event.preventDefault()
              const position = selectableIndices.indexOf(activeIndex)
              setActiveIndex(selectableIndices[Math.min(selectableIndices.length - 1, position + 1)])
            } else if (event.key === 'ArrowUp' && selectableIndices.length > 0) {
              event.preventDefault()
              const position = selectableIndices.indexOf(activeIndex)
              setActiveIndex(selectableIndices[position < 0 ? selectableIndices.length - 1 : Math.max(0, position - 1)])
            } else if (
              event.key === 'Enter' &&
              selections[activeIndex] &&
              !selectionUnavailable(selections[activeIndex])
            ) {
              event.preventDefault()
              void selectResult(selections[activeIndex])
            }
          }}
        />
        <div className="no-drag absolute right-1.5 top-0.5 flex h-6 items-center gap-1">
          {loading && <CircleNotch className="h-3.5 w-3.5 animate-spin text-muted" aria-label={t('globalSearch.loading')} />}
          {query && (
            <button
              type="button"
              className="flex h-6 w-6 items-center justify-center rounded-md text-muted transition-colors hover:bg-hover hover:text-foreground"
              onClick={clear}
              aria-label={t('globalSearch.clear')}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        {showResults && (
          <div
            id="global-search-results"
            role="listbox"
            aria-label={t('globalSearch.results')}
            className="no-drag absolute left-0 right-0 top-[calc(100%+6px)] max-h-[min(66vh,560px)] overflow-y-auto rounded-lg border border-border bg-panel p-1.5 shadow-lg"
          >
            {!loading && searchError && (
              <div className="flex items-center gap-3 px-4 py-6 text-xs text-error" role="alert">
                <span className="min-w-0 flex-1">{searchError}</span>
                <button
                  type="button"
                  className="shrink-0 rounded-md border border-error/30 px-2 py-1 font-medium hover:bg-error/10"
                  onClick={() => setSearchRetry((current) => current + 1)}
                >
                  {t('globalSearch.retry')}
                </button>
              </div>
            )}
            {!loading && !searchError && total === 0 && (
              <div className="px-4 py-8 text-center text-xs text-muted">
                {t('globalSearch.noResults')}
              </div>
            )}

            {results.documents.length > 0 && (
              <section aria-labelledby="global-search-papers">
                <h2 id="global-search-papers" className="px-2.5 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted">
                  {t('globalSearch.papers')} · {results.documents.length}
                </h2>
                {results.documents.map((document) => resultButton(
                  { kind: 'document', value: document },
                  <>
                    <FileText className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs font-medium text-foreground">
                        {highlightMatch(document.title || document.fileName, query)}
                      </span>
                      <span className="mt-0.5 block truncate text-[11px] text-muted">
                        {highlightMatch([formatAuthors(document.authors), document.year, document.venue].filter(Boolean).join(' · '), query)}
                      </span>
                    </span>
                  </>,
                  `${t('globalSearch.openPaper')}: ${document.title || document.fileName}`
                ))}
              </section>
            )}

            {results.workspaceFiles.length > 0 && (
              <section aria-labelledby="global-search-workspace-files">
                <h2 id="global-search-workspace-files" className="px-2.5 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wide text-muted">
                  {t('globalSearch.workspaceFiles')} · {results.workspaceFiles.length}
                </h2>
                {results.workspaceFiles.map((workspaceFile) => resultButton(
                  { kind: 'workspaceFile', value: workspaceFile },
                  <>
                    <File className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs font-medium text-foreground">
                        {highlightMatch(workspaceFile.fileName, query)}
                      </span>
                      <span className="mt-0.5 block truncate text-[11px] text-muted">
                        {workspaceFile.workspaceName} · {workspaceFile.mimeType}
                      </span>
                    </span>
                  </>,
                  `${t('globalSearch.openWorkspaceFile')}: ${workspaceFile.fileName}`
                ))}
              </section>
            )}

            {results.workspaceContents.length > 0 && (
              <section aria-labelledby="global-search-workspace-contents">
                <h2 id="global-search-workspace-contents" className="px-2.5 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wide text-muted">
                  {t('globalSearch.workspaceContents')} · {results.workspaceContents.length}
                </h2>
                {results.workspaceContents.map((workspaceContent) => resultButton(
                  { kind: 'workspaceContent', value: workspaceContent },
                  <>
                    {workspaceContent.kind === 'report'
                      ? <FileText className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
                      : <NotePencil className="mt-0.5 h-4 w-4 shrink-0 text-accent" />}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs font-medium text-foreground">
                        {highlightMatch(workspaceContent.title, query)}
                      </span>
                      <span className="mt-0.5 line-clamp-2 text-[11px] leading-4 text-muted">
                        {workspaceContent.workspaceName} · {t(`globalSearch.workspaceContentKind.${workspaceContent.kind}`)}
                        {' · '}{highlightMatch(workspaceContent.snippet, query)}
                      </span>
                    </span>
                  </>,
                  `${t('globalSearch.openWorkspaceContent')}: ${workspaceContent.title}`
                ))}
              </section>
            )}

            {results.chats.length > 0 && (
              <section aria-labelledby="global-search-chats">
                <h2 id="global-search-chats" className="px-2.5 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wide text-muted">
                  {t('globalSearch.chats')} · {results.chats.length}
                </h2>
                {results.chats.map((chat) => resultButton(
                  { kind: 'chat', value: chat },
                  <>
                    <ChatCircleText className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs font-medium text-foreground">
                        {highlightMatch(chat.title?.trim() || t('globalSearch.untitledChat'), query)}
                      </span>
                      <span className="mt-0.5 line-clamp-2 text-[11px] leading-4 text-muted">
                        {chat.workspaceName ?? t('globalSearch.globalChat')}
                        {chat.role && <> · {t(`globalSearch.role.${chat.role}`)}</>}
                        {' · '}{highlightMatch(chat.snippet, query)}
                      </span>
                    </span>
                  </>,
                  `${t('globalSearch.openChat')}: ${chat.title?.trim() || t('globalSearch.untitledChat')}`
                ))}
              </section>
            )}

            {total > 0 && (
              <div className="mt-1 border-t border-border/70 px-2.5 py-1.5 text-[10px] text-muted">
                {t('globalSearch.hint')}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
