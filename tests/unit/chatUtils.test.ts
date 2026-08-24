import { describe, it, expect, vi, beforeEach } from 'vitest'

const { settingsGet, settingsSet } = vi.hoisted(() => ({
  settingsGet: vi.fn(),
  settingsSet: vi.fn()
}))

vi.mock('../../src/renderer/ipc', () => ({
  api: {
    settings: { get: settingsGet, set: settingsSet }
  }
}))

import {
  loadRecentModels,
  pushRecentModel,
  localMessage,
  mergeTraceStep,
  MAX_INPUT_LENGTH
} from '../../src/renderer/utils/chatUtils'
import type { AgentTraceStep } from '../../src/shared/ipc-types'

beforeEach(() => {
  settingsGet.mockReset()
  settingsSet.mockReset()
})

describe('loadRecentModels', () => {
  it('returns parsed recent models capped to MAX_RECENT', async () => {
    const items = Array.from({ length: 12 }, (_, i) => ({ model: `m${i}`, providerId: 'p' }))
    settingsGet.mockResolvedValue(JSON.stringify(items))
    const res = await loadRecentModels()
    expect(res.length).toBe(8)
    expect(res[0]).toEqual({ model: 'm0', providerId: 'p' })
  })

  it('returns [] when stored value is not an array', async () => {
    settingsGet.mockResolvedValue('{}')
    expect(await loadRecentModels()).toEqual([])
  })

  it('filters entries missing required string fields', async () => {
    settingsGet.mockResolvedValue(JSON.stringify([{ model: 'ok', providerId: 'p' }, { model: 1 }, null, { providerId: 'x' }]))
    const res = await loadRecentModels()
    expect(res).toEqual([{ model: 'ok', providerId: 'p' }])
  })

  it('returns [] when JSON parse throws', async () => {
    settingsGet.mockResolvedValue('not-json')
    expect(await loadRecentModels()).toEqual([])
  })

  it('treats non-string stored value as []', async () => {
    settingsGet.mockResolvedValue(123)
    expect(await loadRecentModels()).toEqual([])
  })
})

describe('pushRecentModel', () => {
  it('prepends the new model and dedupes by provider and model', async () => {
    settingsGet.mockResolvedValue(JSON.stringify([
      { model: 'a', providerId: 'p2' },
      { model: 'b', providerId: 'p2' },
      { model: 'a', providerId: 'p1' }
    ]))
    await pushRecentModel('a', 'p1')
    expect(settingsSet).toHaveBeenCalledWith('chatRecentModels', JSON.stringify([
      { model: 'a', providerId: 'p1' },
      { model: 'a', providerId: 'p2' },
      { model: 'b', providerId: 'p2' }
    ]))
  })

  it('caps the stored list at 8 entries', async () => {
    const items = Array.from({ length: 8 }, (_, i) => ({ model: `m${i}`, providerId: 'p' }))
    settingsGet.mockResolvedValue(JSON.stringify(items))
    await pushRecentModel('new', 'p')
    const saved = JSON.parse(settingsSet.mock.calls[0][1])
    expect(saved).toHaveLength(8)
    expect(saved[0]).toEqual({ model: 'new', providerId: 'p' })
  })

  it('does nothing when model id is empty', async () => {
    await pushRecentModel('   ', 'p')
    expect(settingsSet).not.toHaveBeenCalled()
  })

  it('does nothing when providerId is empty', async () => {
    await pushRecentModel('m', '')
    expect(settingsSet).not.toHaveBeenCalled()
  })
})

describe('localMessage', () => {
  it('builds a message with local- id, given role and content', () => {
    const before = Date.now()
    const msg = localMessage('thread-1', 'user', 'hello')
    const after = Date.now()
    expect(msg.id).toMatch(/^local-/)
    expect(msg.threadId).toBe('thread-1')
    expect(msg.role).toBe('user')
    expect(msg.content).toBe('hello')
    expect(msg.createdAt).toBeGreaterThanOrEqual(before)
    expect(msg.createdAt).toBeLessThanOrEqual(after)
  })

  it('produces unique ids across calls', () => {
    const a = localMessage('t', 'assistant', 'x')
    const b = localMessage('t', 'assistant', 'y')
    expect(a.id).not.toBe(b.id)
  })
})

describe('mergeTraceStep', () => {
  const base = (id: string, seq: number): AgentTraceStep => ({
    id, threadId: 't', runId: 'r', kind: 'llm', name: id,
    input: null, output: null, status: 'running', startedAt: seq, endedAt: null, seq,
    inputTokens: null, outputTokens: null, totalTokens: null,
    parentStepId: null, agentName: null, namespace: null, depth: 0, checkpointId: null
  })

  it('appends a new step and sorts by start time before seq', () => {
    const prev = [base('a', 2), base('b', 5)]
    const res = mergeTraceStep(prev, base('c', 3))
    expect(res.map((s) => s.id)).toEqual(['a', 'c', 'b'])
  })

  it('keeps resumed steps after earlier steps when seq restarts', () => {
    const prev = [base('earlier', 20)]
    const resumed = { ...base('resumed', 1), startedAt: 30 }
    const res = mergeTraceStep(prev, resumed)
    expect(res.map((s) => s.id)).toEqual(['earlier', 'resumed'])
  })

  it('replaces an existing step with the same id', () => {
    const prev = [base('a', 1), base('b', 2)]
    const updated = { ...base('a', 1), status: 'done' as const, output: 'out' }
    const res = mergeTraceStep(prev, updated)
    expect(res).toHaveLength(2)
    expect(res[0]).toEqual(updated)
  })

  it('does not mutate the input array', () => {
    const prev = [base('a', 1)]
    mergeTraceStep(prev, base('b', 2))
    expect(prev).toHaveLength(1)
  })
})

describe('MAX_INPUT_LENGTH', () => {
  it('is a positive number', () => {
    expect(typeof MAX_INPUT_LENGTH).toBe('number')
    expect(MAX_INPUT_LENGTH).toBeGreaterThan(0)
  })
})
