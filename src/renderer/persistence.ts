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
interface PendingRendererSettingWrite {
  value: unknown
  generation: number
  onError?: (error: unknown) => void
  onSuccess?: () => void
}

interface RendererSettingWriteQueue {
  pending: PendingRendererSettingWrite | null
  timer: ReturnType<typeof setTimeout> | null
  task: Promise<void> | null
}

const rendererSettingWrites = new Map<string, RendererSettingWriteQueue>()
let rendererSettingGeneration = 0
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

function rendererSettingQueue(key: string): RendererSettingWriteQueue {
  const existing = rendererSettingWrites.get(key)
  if (existing) return existing
  const queue: RendererSettingWriteQueue = { pending: null, timer: null, task: null }
  rendererSettingWrites.set(key, queue)
  return queue
}

async function persistRendererSetting(key: string, queue: RendererSettingWriteQueue): Promise<void> {
  if (queue.timer) {
    clearTimeout(queue.timer)
    queue.timer = null
  }
  if (queue.task) await queue.task.catch(() => undefined)
  while (queue.pending) {
    const pending = queue.pending
    queue.pending = null
    if (pending.generation !== rendererSettingGeneration) continue
    const task = trackRendererPersistence(api.settings.set(key, pending.value)).then(() => undefined)
    queue.task = task
    try {
      await task
      if (pending.generation === rendererSettingGeneration) {
        try {
          pending.onSuccess?.()
        } catch (error) {
          void error
        }
      }
    } catch (error) {
      if (
        pending.generation === rendererSettingGeneration &&
        queue.pending === null
      ) {
        queue.pending = pending
      }
      pending.onError?.(error)
      throw error
    } finally {
      if (queue.task === task) queue.task = null
    }
  }
  if (!queue.timer && !queue.task && !queue.pending && rendererSettingWrites.get(key) === queue) {
    rendererSettingWrites.delete(key)
  }
}

export function scheduleRendererSetting(
  key: string,
  value: unknown,
  options: {
    delay?: number
    onError?: (error: unknown) => void
    onSuccess?: () => void
  } = {}
): void {
  const queue = rendererSettingQueue(key)
  queue.pending = {
    value,
    generation: rendererSettingGeneration,
    onError: options.onError,
    onSuccess: options.onSuccess
  }
  if (queue.timer) clearTimeout(queue.timer)
  const delay = options.delay ?? 0
  if (delay <= 0) {
    queue.timer = null
    void persistRendererSetting(key, queue).catch(() => undefined)
    return
  }
  queue.timer = setTimeout(() => {
    queue.timer = null
    void persistRendererSetting(key, queue).catch(() => undefined)
  }, delay)
}

export function cancelRendererSetting(key: string): void {
  const queue = rendererSettingWrites.get(key)
  if (!queue) return
  if (queue.timer) clearTimeout(queue.timer)
  queue.timer = null
}

export function invalidateRendererSettingWrites(): void {
  rendererSettingGeneration += 1
  for (const [key, queue] of rendererSettingWrites) {
    if (queue.timer) clearTimeout(queue.timer)
    queue.timer = null
    queue.pending = null
    if (!queue.task) rendererSettingWrites.delete(key)
  }
}

export async function flushRendererSettingWrites(): Promise<void> {
  const queues = [...rendererSettingWrites.entries()]
  for (const [, queue] of queues) {
    if (queue.timer) {
      clearTimeout(queue.timer)
      queue.timer = null
    }
  }
  const results = await Promise.allSettled(
    queues.map(([key, queue]) => persistRendererSetting(key, queue))
  )
  const failure = results.find((result): result is PromiseRejectedResult =>
    result.status === 'rejected'
  )
  if (failure) throw failure.reason
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
  const { usePdfReaderStore } = await import('./store/pdfReaderStore')
  const results = await Promise.allSettled([
    flushRendererSettingWrites(),
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
