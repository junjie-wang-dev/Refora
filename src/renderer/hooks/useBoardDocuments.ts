import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { AiSummary, Document } from '../../shared/ipc-types'
import { errorMessage } from '../../shared/ipc-types'
import { api } from '../ipc'
import { useDocumentStore } from '../store/documentStore'
import { useWorkspaceStore } from '../store/workspaceStore'

const BOARD_LOAD_CONCURRENCY = 4

async function mapConcurrent<T, R>(
  values: T[],
  operation: (value: T) => Promise<R>
): Promise<Array<PromiseSettledResult<R>>> {
  const results = new Array<PromiseSettledResult<R>>(values.length)
  let index = 0
  const workers = Array.from(
    { length: Math.min(BOARD_LOAD_CONCURRENCY, values.length) },
    async () => {
      while (index < values.length) {
        const current = index
        index += 1
        try {
          results[current] = { status: 'fulfilled', value: await operation(values[current]) }
        } catch (reason) {
          results[current] = { status: 'rejected', reason }
        }
      }
    }
  )
  await Promise.all(workers)
  return results
}

interface BoardDocumentsOptions {
  activeWorkspaceId: string | null
  allDocIds: string[]
  workspaceDocIds: string[]
  documents: Document[]
  searchResults: Document[]
}

export function useBoardDocuments({
  activeWorkspaceId,
  allDocIds,
  workspaceDocIds,
  documents,
  searchResults
}: BoardDocumentsOptions) {
  const { t } = useTranslation()
  const [docs, setDocs] = useState<Map<string, Document>>(new Map())
  const [summaries, setSummaries] = useState<Map<string, AiSummary>>(new Map())
  const [loadedSummaryDocIds, setLoadedSummaryDocIds] = useState<Set<string>>(new Set())
  const summarizing = useWorkspaceStore((state) => state.summarizingDocIds)
  const backgroundSummaryErrors = useWorkspaceStore((state) => state.summaryErrors)
  const summarize = useWorkspaceStore((state) => state.summarizeDocument)
  const [summaryLookupErrors, setSummaryLookupErrors] = useState<Map<string, string>>(new Map())
  const allDocIdsKey = [...allDocIds].sort().join('|')
  const workspaceDocIdsKey = [...workspaceDocIds].sort().join('|')
  const knownDocuments = useMemo(
    () => new Map(
      [...documents, ...searchResults].map((document) => [document.id, document])
    ),
    [documents, searchResults]
  )

  useEffect(() => {
    setDocs(new Map())
    setSummaries(new Map())
    setLoadedSummaryDocIds(new Set())
    setSummaryLookupErrors(new Map())
  }, [activeWorkspaceId])

  useEffect(() => {
    const relevantIds = new Set(allDocIds)
    setDocs((previous) => {
      let changed = false
      const next = new Map(previous)
      for (const [docId, document] of knownDocuments) {
        if (!relevantIds.has(docId) || next.get(docId) === document) continue
        next.set(docId, document)
        changed = true
      }
      return changed ? next : previous
    })
  }, [allDocIdsKey, knownDocuments])

  useEffect(() => {
    let cancelled = false
    setLoadedSummaryDocIds((previous) => previous.size === 0 ? previous : new Set())
    void (async () => {
      const cachedDocuments = new Map(
        allDocIds
          .map((docId) => [docId, knownDocuments.get(docId)] as const)
          .filter((entry): entry is readonly [string, Document] => entry[1] !== undefined)
      )
      if (!cancelled && cachedDocuments.size > 0) setDocs(cachedDocuments)
      const missingDocIds = allDocIds.filter((docId) => !knownDocuments.has(docId))
      const [documentResults, summaryResults] = await Promise.all([
        mapConcurrent(missingDocIds, async (docId) => ({
          docId,
          document: await api.documents.get(docId)
        })),
        mapConcurrent(workspaceDocIds, async (docId) => ({
          docId,
          summary: await api.ai.summaryGet(docId)
        }))
      ])
      if (cancelled) return
      const nextDocuments = new Map(cachedDocuments)
      let firstFailure: unknown = null
      for (const result of documentResults) {
        if (result.status === 'rejected') {
          firstFailure ??= result.reason
        } else if (result.value.document) {
          nextDocuments.set(result.value.docId, result.value.document)
        }
      }
      const currentDocumentState = useDocumentStore.getState()
      const latestDocuments = new Map(
        [...currentDocumentState.documents, ...currentDocumentState.searchResults]
          .map((document) => [document.id, document])
      )
      for (const docId of allDocIds) {
        const document = latestDocuments.get(docId)
        if (document) nextDocuments.set(docId, document)
      }
      const nextSummaries = new Map<string, AiSummary>()
      const loadedIds = new Set<string>()
      const nextSummaryErrors = new Map<string, string>()
      summaryResults.forEach((result, resultIndex) => {
        const docId = workspaceDocIds[resultIndex]
        if (result.status === 'rejected') {
          firstFailure ??= result.reason
          nextSummaryErrors.set(docId, t('workspace.openDocFailed'))
          return
        }
        loadedIds.add(docId)
        if (result.value.summary) nextSummaries.set(docId, result.value.summary)
      })
      setDocs(nextDocuments)
      setSummaries(nextSummaries)
      setLoadedSummaryDocIds(loadedIds)
      setSummaryLookupErrors(nextSummaryErrors)
      if (firstFailure) {
        useDocumentStore.getState().showToast(
          errorMessage(firstFailure, t('workspace.openDocFailed'))
        )
      }
    })()
    return () => {
      cancelled = true
    }
  }, [activeWorkspaceId, allDocIdsKey, t, workspaceDocIdsKey])

  useEffect(() => {
    let cancelled = false
    const handleUpdated = (docId: string) => {
      if (!workspaceDocIds.includes(docId)) return
      void api.ai.summaryGet(docId).then((summary) => {
        if (cancelled) return
        setSummaries((previous) => {
          const next = new Map(previous)
          if (summary) next.set(docId, summary)
          else next.delete(docId)
          return next
        })
        setLoadedSummaryDocIds((previous) => new Set(previous).add(docId))
      }).catch((cause) => {
        if (cancelled) return
        useDocumentStore.getState().showToast(
          errorMessage(cause, t('workspace.openDocFailed'))
        )
      })
    }
    const disposeUpdated = api.events.onAiSummaryUpdated(handleUpdated)
    return () => {
      cancelled = true
      disposeUpdated()
    }
  }, [t, workspaceDocIdsKey])

  const summaryErrors = useMemo(
    () => new Map([...summaryLookupErrors, ...backgroundSummaryErrors]),
    [backgroundSummaryErrors, summaryLookupErrors]
  )

  return { docs, summaries, loadedSummaryDocIds, summarizing, summaryErrors, summarize }
}
