import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { api } from '../ipc'
import { scheduleRendererSetting } from '../persistence'

export interface MarkdownViewState {
  mode: 'read' | 'edit'
  preview: boolean
  scrollTop: number
  position: { start: number; end: number; scrollTop: number }
}

const views = new Map<string, MarkdownViewState>()
const subscribers = new Set<() => void>()
let generation = 0

export function resetMarkdownViewStates(): void {
  generation += 1
  views.clear()
  subscribers.forEach((subscriber) => subscriber())
}

function subscribe(subscriber: () => void): () => void {
  subscribers.add(subscriber)
  return () => { subscribers.delete(subscriber) }
}

function validState(value: unknown): value is MarkdownViewState {
  if (!value || typeof value !== 'object') return false
  const state = value as MarkdownViewState
  return (state.mode === 'read' || state.mode === 'edit') && typeof state.preview === 'boolean' && Number.isFinite(state.scrollTop) && state.scrollTop >= 0 && Boolean(state.position) && [state.position.start, state.position.end].every((number) => Number.isSafeInteger(number) && number >= 0) && state.position.end >= state.position.start && Number.isFinite(state.position.scrollTop) && state.position.scrollTop >= 0
}

function remember(key: string, value: MarkdownViewState): void {
  views.delete(key)
  views.set(key, value)
  if (views.size > 100) views.delete(views.keys().next().value!)
}

function initialState(key: string, mode: 'read' | 'edit'): MarkdownViewState {
  return views.get(key) ?? { mode, preview: false, scrollTop: 0, position: { start: 0, end: 0, scrollTop: 0 } }
}

export function useMarkdownViewState(key: string, initialMode: 'read' | 'edit') {
  const currentGeneration = useSyncExternalStore(subscribe, () => generation)
  const [record, setRecord] = useState(() => ({ key, generation: currentGeneration, value: initialState(key, initialMode), ready: views.has(key) }))
  const touched = useRef(false)
  let state = record.value
  let ready = record.ready
  if (record.key !== key || record.generation !== currentGeneration) {
    state = initialState(key, initialMode)
    touched.current = false
    ready = views.has(key)
    setRecord({ key, generation: currentGeneration, value: state, ready })
  }
  const current = useRef({ key, generation: currentGeneration, value: state })
  current.current = { key, generation: currentGeneration, value: state }

  useEffect(() => {
    if (views.has(key)) return
    let active = true
    const finish = (saved?: unknown) => {
      if (!active || generation !== currentGeneration || current.current.key !== key || current.current.generation !== currentGeneration) return
      const value = !touched.current && validState(saved) ? saved : current.current.value
      remember(key, value)
      setRecord({ key, generation: currentGeneration, value, ready: true })
    }
    void api.settings.get<unknown>(`markdown.view.${key}`, null).then(finish).catch(() => finish())
    return () => { active = false }
  }, [key, currentGeneration])

  const update = useCallback((patch: Partial<MarkdownViewState>) => {
    if (current.current.key !== key || current.current.generation !== currentGeneration || generation !== currentGeneration) return
    touched.current = true
    const next = { ...current.current.value, ...patch }
    current.current = { key, generation: currentGeneration, value: next }
    remember(key, next)
    setRecord({ key, generation: currentGeneration, value: next, ready: true })
    scheduleRendererSetting(`markdown.view.${key}`, next, { delay: 500 })
  }, [key, currentGeneration])
  return [state, update, ready] as const
}
