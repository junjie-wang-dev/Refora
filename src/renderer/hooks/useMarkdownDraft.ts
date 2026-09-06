import { useCallback, useEffect, useReducer, useRef } from 'react'
import { api } from '../ipc'
import { flushRendererSettingWrites, registerRendererFlushTask, scheduleRendererSetting } from '../persistence'

export interface MarkdownDraft {
  title: string
  contentMd: string
}

export interface MarkdownDraftVersion extends MarkdownDraft {
  id: string
  createdAt: number
  reason: 'saved' | 'backup' | 'conflict' | 'recovered' | 'restored'
}

interface RecoveryRecord {
  draft: MarkdownDraft
  base: MarkdownDraft
  history: MarkdownDraftVersion[]
}

interface MarkdownDraftOptions extends MarkdownDraft {
  id: string
  kind: string
  editable: boolean
  autoSave: boolean
  onUpdate?: (id: string, patch: MarkdownDraft) => Promise<boolean>
  messages: {
    saveFailed: string
    titleRequired: string
    externalConflict: string
    recoveryFailed: string
  }
}

interface DraftSession {
  key: string
  draft: MarkdownDraft
  saved: MarkdownDraft
  incoming: MarkdownDraft
  external: MarkdownDraft | null
  history: MarkdownDraftVersion[]
  recovered: boolean
  error: string | null
  recoveryError: string | null
  ready: boolean
  changed: boolean
  saving: boolean
  task: Promise<boolean> | null
  loading: Promise<void> | null
  ownSave: { draft: MarkdownDraft; observed: boolean } | null
}

const sameDraft = (a: MarkdownDraft, b: MarkdownDraft) =>
  a.title === b.title && a.contentMd === b.contentMd

function validDraft(value: unknown): value is MarkdownDraft {
  if (!value || typeof value !== 'object') return false
  const draft = value as MarkdownDraft
  return typeof draft.title === 'string' && typeof draft.contentMd === 'string'
}

function validVersion(value: unknown): value is MarkdownDraftVersion {
  if (!validDraft(value)) return false
  const version = value as MarkdownDraftVersion
  return typeof version.id === 'string' && Number.isFinite(version.createdAt)
    && ['saved', 'backup', 'conflict', 'recovered', 'restored'].includes(version.reason)
}

function cappedHistory(history: MarkdownDraftVersion[]) {
  let size = 0
  return history.slice(0, 20).filter((version) => {
    size += version.title.length + version.contentMd.length
    return size <= 2_000_000
  })
}

export function useMarkdownDraft(options: MarkdownDraftOptions) {
  const [, render] = useReducer((value: number) => value + 1, 0)
  const optionsRef = useRef(options)
  optionsRef.current = options
  const key = `markdown.document.${options.kind}.${options.id}`
  const sessionRef = useRef<DraftSession | null>(null)
  if (!sessionRef.current || sessionRef.current.key !== key) {
    const initial = { title: options.title, contentMd: options.contentMd }
    sessionRef.current = {
      key, draft: initial, saved: initial, incoming: initial, external: null,
      history: [], recovered: false, error: null, recoveryError: null,
      ready: !options.editable, changed: false, saving: false, task: null,
      loading: null, ownSave: null
    }
  }
  const session = sessionRef.current
  const publish = useCallback((target: DraftSession) => {
    if (sessionRef.current === target) render()
  }, [])

  const persist = useCallback((target: DraftSession) => {
    if (!target.ready || !optionsRef.current.editable) return
    const record: RecoveryRecord = {
      draft: { ...target.draft }, base: { ...target.saved }, history: [...target.history]
    }
    scheduleRendererSetting(target.key, record, {
      delay: 150,
      onError: () => {
        target.recoveryError = optionsRef.current.messages.recoveryFailed
        publish(target)
      },
      onSuccess: () => {
        if (!target.recoveryError) return
        target.recoveryError = null
        publish(target)
      }
    })
  }, [publish])

  const remember = useCallback((target: DraftSession, draft: MarkdownDraft, reason: MarkdownDraftVersion['reason']) => {
    if (target.history[0] && sameDraft(target.history[0], draft)) return
    target.history = cappedHistory([{
      ...draft, id: crypto.randomUUID(), createdAt: Date.now(), reason
    }, ...target.history])
  }, [])

  useEffect(() => {
    if (!options.editable || session.loading) return
    session.loading = api.settings.get<RecoveryRecord | null>(session.key, null).then((record) => {
      if (!record || !validDraft(record.draft) || !validDraft(record.base)) return
      session.history = cappedHistory([
        ...session.history,
        ...(Array.isArray(record.history) ? record.history.filter(validVersion) : [])
      ])
      if (sameDraft(record.draft, record.base) || sameDraft(record.draft, session.saved)) return
      remember(session, record.draft, 'recovered')
      if (session.changed) return
      session.draft = record.draft
      session.recovered = true
      if (!sameDraft(record.base, session.saved)) {
        session.external = session.incoming
        session.error = optionsRef.current.messages.externalConflict
      }
    }).catch(() => {
      session.recoveryError = optionsRef.current.messages.recoveryFailed
    }).finally(() => {
      session.ready = true
      persist(session)
      publish(session)
    })
  }, [options.editable, persist, publish, remember, session])

  useEffect(() => {
    const incoming = { title: options.title, contentMd: options.contentMd }
    if (sameDraft(incoming, session.incoming)) return
    session.incoming = incoming
    if (session.ownSave && sameDraft(incoming, session.ownSave.draft)) {
      session.ownSave.observed = true
      if (!session.saving) session.ownSave = null
      return
    }
    if (sameDraft(incoming, session.saved)) return
    if (!sameDraft(session.draft, session.saved) || session.saving || session.external) {
      session.external = incoming
      session.error = optionsRef.current.messages.externalConflict
    } else {
      remember(session, session.saved, 'saved')
      session.saved = incoming
      session.draft = incoming
    }
    persist(session)
    publish(session)
  }, [options.contentMd, options.title, persist, publish, remember, session])

  const flush = useCallback((): Promise<boolean> => {
    const target = sessionRef.current!
    const currentOptions = optionsRef.current
    if (target.task) return target.task
    const run = async () => {
      if (target.loading) await target.loading
      if (!currentOptions.editable || !currentOptions.onUpdate) return true
      while (!sameDraft(target.draft, target.saved)) {
        if (target.external) {
          target.error = currentOptions.messages.externalConflict
          return false
        }
        const submitted = { ...target.draft }
        const next = { ...submitted, title: submitted.title.trim() }
        if (!next.title) {
          target.error = currentOptions.messages.titleRequired
          return false
        }
        target.saving = true
        target.error = null
        target.ownSave = { draft: next, observed: false }
        publish(target)
        let success: boolean
        try {
          success = await currentOptions.onUpdate(currentOptions.id, next)
        } catch {
          success = false
        }
        if (!success) {
          target.ownSave = null
          target.error = target.external
            ? currentOptions.messages.externalConflict : currentOptions.messages.saveFailed
          return false
        }
        remember(target, target.saved, 'saved')
        target.saved = next
        if (sameDraft(target.draft, submitted)) target.draft = next
        if (target.ownSave?.observed) target.ownSave = null
        persist(target)
        publish(target)
        if (target.external) {
          target.error = currentOptions.messages.externalConflict
          return false
        }
      }
      target.error = null
      return !target.external
    }
    target.task = run().finally(() => {
      target.saving = false
      target.task = null
      persist(target)
      publish(target)
    })
    return target.task
  }, [persist, publish, remember])

  const setDraft = useCallback((patch: Partial<MarkdownDraft>) => {
    const target = sessionRef.current!
    target.draft = { ...target.draft, ...patch }
    target.changed = true
    if (!target.external) target.error = null
    persist(target)
    publish(target)
  }, [persist, publish])

  const setDraftTitle = useCallback((title: string) => setDraft({ title }), [setDraft])
  const setDraftContent = useCallback((contentMd: string) => setDraft({ contentMd }), [setDraft])
  const dirty = !sameDraft(session.draft, session.saved)

  useEffect(() => {
    if (!options.editable || !options.autoSave || !session.ready || !dirty
      || session.external || session.error || !session.draft.title.trim()) return
    const timeout = window.setTimeout(() => void flush(), 800)
    return () => window.clearTimeout(timeout)
  }, [dirty, flush, options.autoSave, options.editable, session, session.draft, session.error, session.external, session.ready])

  useEffect(() => {
    if (!options.editable) return
    return registerRendererFlushTask(async () => {
      if (!await flush()) throw new Error(optionsRef.current.messages.saveFailed)
      await flushRendererSettingWrites()
    })
  }, [flush, options.editable])

  const backupDraft = useCallback(() => {
    const target = sessionRef.current!
    remember(target, target.draft, 'backup')
    persist(target)
    publish(target)
    return { ...target.draft }
  }, [persist, publish, remember])

  const reloadExternalDraft = useCallback(() => {
    const target = sessionRef.current!
    if (target.saving) return
    remember(target, target.draft, 'conflict')
    target.draft = target.external ?? target.incoming
    target.saved = target.draft
    target.external = null
    target.error = null
    target.changed = true
    persist(target)
    publish(target)
  }, [persist, publish, remember])

  const keepLocalDraft = useCallback(async () => {
    const target = sessionRef.current!
    if (target.task) await target.task
    if (target.external) {
      remember(target, target.external, 'conflict')
      target.saved = target.external
      target.external = null
      target.error = null
      persist(target)
      publish(target)
    }
    return flush()
  }, [flush, persist, publish, remember])

  const restoreVersion = useCallback((versionId: string) => {
    const target = sessionRef.current!
    const version = target.history.find((entry) => entry.id === versionId)
    if (!version) return
    remember(target, target.draft, 'restored')
    setDraft({ title: version.title, contentMd: version.contentMd })
  }, [remember, setDraft])

  return {
    draftTitle: session.draft.title,
    draftContent: session.draft.contentMd,
    setDraftTitle, setDraftContent,
    savedDraft: session.saved,
    isDirty: dirty,
    saving: session.saving,
    status: !session.ready ? 'recovering' as const
      : session.external ? 'conflict' as const
        : session.error || session.recoveryError ? 'error' as const
          : session.saving ? 'saving' as const
            : dirty ? 'unsaved' as const : 'saved' as const,
    saveError: session.error ?? session.recoveryError,
    externalConflict: Boolean(session.external),
    latestExternalDraft: session.external,
    history: session.history,
    recoveredDraft: session.recovered,
    flush, requestClose: flush, retry: flush,
    reloadExternalDraft, keepLocalDraft, backupDraft, restoreVersion
  }
}
