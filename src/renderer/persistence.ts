import type { Document } from '../shared/ipc-types'
import { api } from './ipc'

type RendererFlushTask = () => Promise<void>

interface PendingDocumentNote {
  text: string
  savedText: string
  version: number
  task: Promise<Document> | null
}

type DocumentNoteSaveStatus = 'saving' | 'saved' | 'error'

const registeredTasks = new Set<RendererFlushTask>()
const trackedTasks = new Set<Promise<unknown>>()
const pendingDocumentNotes = new Map<string, PendingDocumentNote>()
const documentNoteSubscribers = new Map<
  string,
  Set<(status: DocumentNoteSaveStatus) => void>
>()

function publishDocumentNoteStatus(docId: string, status: DocumentNoteSaveStatus): void {
  for (const subscriber of documentNoteSubscribers.get(docId) ?? []) subscriber(status)
}

export function registerRendererFlushTask(task: RendererFlushTask): () => void {
  registeredTasks.add(task)
  return () => registeredTasks.delete(task)
}

export function trackRendererPersistence<T>(task: PromiseLike<T> | T): Promise<T> {
  const promise = Promise.resolve(task)
  trackedTasks.add(promise)
  void promise.finally(() => trackedTasks.delete(promise)).catch(() => undefined)
  return promise
}

export function pendingDocumentNote(docId: string): string | undefined {
  return pendingDocumentNotes.get(docId)?.text
}

export function subscribeDocumentNoteStatus(
  docId: string,
  subscriber: (status: DocumentNoteSaveStatus) => void
): () => void {
  const subscribers = documentNoteSubscribers.get(docId) ?? new Set()
  subscribers.add(subscriber)
  documentNoteSubscribers.set(docId, subscribers)
  return () => {
    subscribers.delete(subscriber)
    if (subscribers.size === 0) documentNoteSubscribers.delete(docId)
  }
}

export function stageDocumentNote(docId: string, text: string, savedText: string): void {
  const current = pendingDocumentNotes.get(docId)
  if (current) {
    current.text = text
    current.version += 1
    return
  }
  if (text === savedText) return
  pendingDocumentNotes.set(docId, {
    text,
    savedText,
    version: 1,
    task: null
  })
}

export async function persistDocumentNote(docId: string): Promise<Document | null> {
  const pending = pendingDocumentNotes.get(docId)
  if (!pending) return null
  if (pending.task) {
    await pending.task.catch(() => undefined)
    return persistDocumentNote(docId)
  }
  if (pending.text === pending.savedText) {
    pendingDocumentNotes.delete(docId)
    return null
  }
  const text = pending.text
  const version = pending.version
  publishDocumentNoteStatus(docId, 'saving')
  const task = trackRendererPersistence(api.documents.update(docId, { note: text }))
  pending.task = task
  try {
    const document = await task
    const current = pendingDocumentNotes.get(docId)
    if (current === pending) {
      current.savedText = text
      current.task = null
      if (current.version === version || current.text === text) {
        pendingDocumentNotes.delete(docId)
      }
    }
    if (pendingDocumentNotes.has(docId)) {
      return await persistDocumentNote(docId) ?? document
    }
    publishDocumentNoteStatus(docId, 'saved')
    return document
  } catch (error) {
    if (pendingDocumentNotes.get(docId) === pending) pending.task = null
    publishDocumentNoteStatus(docId, 'error')
    throw error
  }
}

async function flushPendingDocumentNotes(): Promise<void> {
  const results = await Promise.allSettled(
    [...pendingDocumentNotes.keys()].map((docId) => persistDocumentNote(docId))
  )
  const failure = results.find((result): result is PromiseRejectedResult =>
    result.status === 'rejected'
  )
  if (failure) throw failure.reason
}

export async function waitForTrackedRendererPersistence(): Promise<void> {
  while (trackedTasks.size > 0) {
    const results = await Promise.allSettled([...trackedTasks])
    const failure = results.find((result): result is PromiseRejectedResult =>
      result.status === 'rejected'
    )
    if (failure) throw failure.reason
  }
}

export async function flushRendererPersistence(): Promise<void> {
  const [{ useDocumentStore }, { usePdfReaderStore }] = await Promise.all([
    import('./store/documentStore'),
    import('./store/pdfReaderStore')
  ])
  const results = await Promise.allSettled([
    useDocumentStore.getState().flushPendingSettings(),
    usePdfReaderStore.getState().flushPendingSaves(),
    flushPendingDocumentNotes(),
    ...[...registeredTasks].map((task) => task())
  ])
  const failure = results.find((result): result is PromiseRejectedResult =>
    result.status === 'rejected'
  )
  if (failure) throw failure.reason
  await waitForTrackedRendererPersistence()
}
