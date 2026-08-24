import { beforeEach, describe, expect, it, vi } from 'vitest'
import { IpcChannel } from '../../src/shared/ipc-channels'
import { createServerAiHandlers } from '../../src/main/sidecar/ipc/ai'
import type { ServerClient } from '../../src/main/sidecar/client'

vi.mock('../../src/main/services/logger', () => ({
  logger: {
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn()
  }
}))

type Result = { ok: true; data: unknown } | { ok: false; error: { code: string; message: string } }

const traceStep = {
  id: 'step-1',
  threadId: 'thread-1',
  runId: 'run-1',
  kind: 'llm' as const,
  name: null,
  input: null,
  output: null,
  status: 'done' as const,
  startedAt: 1,
  endedAt: 2,
  seq: 0,
  inputTokens: null,
  outputTokens: null,
  totalTokens: null,
  parentStepId: null,
  agentName: null,
  namespace: null,
  depth: 0,
  checkpointId: null
}

const pendingInterrupt = {
  id: 'interrupt-1',
  runId: 'run-1',
  threadId: 'thread-1',
  checkpointId: null,
  actions: [
    {
      name: 'run_command',
      args: { command: 'ls' },
      description: 'Lists files',
      allowedDecisions: ['approve', 'reject']
    }
  ],
  status: 'pending' as const,
  decision: null,
  createdAt: 1,
  resolvedAt: null
}

describe('server AI IPC handlers', () => {
  let http: Record<string, ReturnType<typeof vi.fn>>
  let handlers: Record<string, (...args: unknown[]) => Promise<Result>>

  beforeEach(() => {
    http = {
      aiDocTextGet: vi.fn().mockResolvedValue({ text: 'document text' }),
      aiSummarize: vi.fn().mockResolvedValue({ summaryId: 'summary-1' }),
      aiSummaryGet: vi.fn().mockResolvedValue(null),
      aiChatSend: vi.fn().mockResolvedValue({ threadId: 'thread-1', runId: 'server-run' }),
      aiChatResume: vi.fn().mockResolvedValue({ runId: 'run-1' }),
      aiChatCancel: vi.fn().mockResolvedValue({
        ack: true,
        cancelRequested: true,
        terminated: true
      }),
      aiChatHistory: vi.fn().mockResolvedValue([]),
      aiChatThreads: vi.fn().mockResolvedValue([]),
      aiUsageStats: vi.fn().mockResolvedValue({ totalTokens: 0 }),
      aiChatTraces: vi.fn().mockResolvedValue([]),
      aiChatRun: vi.fn().mockResolvedValue({ id: 'run-1', status: 'running' }),
      aiChatPendingInterrupt: vi.fn().mockResolvedValue(null),
      aiChatRenameThread: vi.fn().mockResolvedValue({ id: 'thread-1', title: 'Renamed' }),
      aiChatDeleteThread: vi.fn().mockResolvedValue({ ack: true }),
      aiChatMemories: vi.fn().mockResolvedValue([]),
      aiChatUpdateMemory: vi.fn().mockResolvedValue({ id: 'memory-1' }),
      aiChatDeleteMemory: vi.fn().mockResolvedValue({ ack: true }),
      aiReportsList: vi.fn().mockResolvedValue([]),
      aiReportsDelete: vi.fn().mockResolvedValue({ ack: true }),
      aiReportsUpdate: vi.fn().mockResolvedValue({ id: 'report-1' })
    }
    handlers = createServerAiHandlers({
      serverClient: { http } as unknown as ServerClient
    }) as unknown as Record<string, (...args: unknown[]) => Promise<Result>>
  })

  it('forwards document text and summary operations', async () => {
    await expect(handlers[IpcChannel.AiDocTextGet]('document-1')).resolves.toEqual({
      ok: true,
      data: 'document text'
    })
    await expect(handlers[IpcChannel.AiSummarize]('document-1')).resolves.toEqual({
      ok: true,
      data: undefined
    })
    await expect(handlers[IpcChannel.AiSummaryGet]('document-1')).resolves.toEqual({
      ok: true,
      data: null
    })

    expect(http.aiDocTextGet).toHaveBeenCalledWith('document-1')
    expect(http.aiSummarize).toHaveBeenCalledWith({ documentId: 'document-1' })
    expect(http.aiSummaryGet).toHaveBeenCalledWith('document-1')
  })

  it('forwards chat commands while preserving IPC response shapes', async () => {
    const request = {
      workspaceId: 'workspace-1',
      threadId: 'thread-1',
      runId: 'client-run',
      text: 'Hello',
      providerId: 'provider-1'
    }

    await expect(handlers[IpcChannel.AiChatSend](request)).resolves.toEqual({
      ok: true,
      data: { threadId: 'thread-1', runId: 'server-run' }
    })
    await expect(handlers[IpcChannel.AiChatResume]({
      threadId: 'thread-1',
      runId: 'run-1',
      decisions: [{ type: 'approve' }]
    })).resolves.toEqual({ ok: true, data: undefined })
    await expect(handlers[IpcChannel.AiChatCancel]('run-1')).resolves.toEqual({
      ok: true,
      data: { ack: true, cancelRequested: true, terminated: true }
    })

    expect(http.aiChatSend).toHaveBeenCalledWith(expect.objectContaining(request))
    expect(http.aiChatResume).toHaveBeenCalledWith({
      threadId: 'thread-1',
      runId: 'run-1',
      decisions: [{ type: 'approve' }]
    })
    expect(http.aiChatCancel).toHaveBeenCalledWith({ runId: 'run-1' })
  })

  it('forwards chat queries, thread updates, memories, and reports', async () => {
    await Promise.all([
      handlers[IpcChannel.AiChatHistory]('thread-1'),
      handlers[IpcChannel.AiChatThreads](null),
      handlers[IpcChannel.AiUsageStats](),
      handlers[IpcChannel.AiChatTraces]('thread-1'),
      handlers[IpcChannel.AiChatRun]('run-1'),
      handlers[IpcChannel.AiChatPendingInterrupt]('run-1'),
      handlers[IpcChannel.AiChatRenameThread]('thread-1', 'Renamed'),
      handlers[IpcChannel.AiChatDeleteThread]('thread-1'),
      handlers[IpcChannel.AiWorkspaceMemoriesList](null),
      handlers[IpcChannel.AiWorkspaceMemoryUpdate](null, '/brief.md', 'Updated'),
      handlers[IpcChannel.AiWorkspaceMemoryDelete](null, '/brief.md'),
      handlers[IpcChannel.AiReportsList]('workspace-1'),
      handlers[IpcChannel.AiReportsUpdate]('report-1', { title: 'Updated' }),
      handlers[IpcChannel.AiReportsDelete]('report-1')
    ])

    expect(http.aiChatHistory).toHaveBeenCalledWith('thread-1')
    expect(http.aiChatThreads).toHaveBeenCalledWith({})
    expect(http.aiUsageStats).toHaveBeenCalledWith()
    expect(http.aiChatTraces).toHaveBeenCalledWith('thread-1')
    expect(http.aiChatRun).toHaveBeenCalledWith('run-1')
    expect(http.aiChatPendingInterrupt).toHaveBeenCalledWith('run-1')
    expect(http.aiChatRenameThread).toHaveBeenCalledWith('thread-1', { title: 'Renamed' })
    expect(http.aiChatDeleteThread).toHaveBeenCalledWith('thread-1')
    expect(http.aiChatMemories).toHaveBeenCalledWith(null)
    expect(http.aiChatUpdateMemory).toHaveBeenCalledWith(null, '/brief.md', { value: 'Updated' })
    expect(http.aiChatDeleteMemory).toHaveBeenCalledWith(null, '/brief.md')
    expect(http.aiReportsList).toHaveBeenCalledWith('workspace-1')
    expect(http.aiReportsUpdate).toHaveBeenCalledWith('report-1', { title: 'Updated' })
    expect(http.aiReportsDelete).toHaveBeenCalledWith('report-1')

    await expect(handlers[IpcChannel.AiChatRenameThread]('thread-1', 'Renamed')).resolves.toEqual({
      ok: true,
      data: undefined
    })
  })

  it('validates upstream trace and interrupt payloads before resolving', async () => {
    http.aiChatTraces.mockResolvedValue([traceStep, { broken: true }])
    await expect(handlers[IpcChannel.AiChatTraces]('thread-1')).resolves.toEqual({
      ok: true,
      data: [traceStep]
    })

    http.aiChatTraces.mockResolvedValue({ id: 'step-1' })
    await expect(handlers[IpcChannel.AiChatTraces]('thread-1')).resolves.toEqual({
      ok: false,
      error: { code: 'invalid_upstream_payload', message: 'Upstream chat traces payload must be an array' }
    })

    http.aiChatPendingInterrupt.mockResolvedValue(pendingInterrupt)
    await expect(handlers[IpcChannel.AiChatPendingInterrupt]('run-1')).resolves.toEqual({
      ok: true,
      data: pendingInterrupt
    })

    http.aiChatPendingInterrupt.mockResolvedValue({ ...pendingInterrupt, actions: [{ name: 42 }] })
    await expect(handlers[IpcChannel.AiChatPendingInterrupt]('run-1')).resolves.toMatchObject({
      ok: false,
      error: { code: 'invalid_upstream_payload' }
    })
  })

  it('rejects chat resume requests with invalid decisions before forwarding', async () => {
    await expect(handlers[IpcChannel.AiChatResume]({
      threadId: 'thread-1',
      runId: 'run-1',
      decisions: [{ type: 'approve' }]
    })).resolves.toEqual({ ok: true, data: undefined })
    expect(http.aiChatResume).toHaveBeenCalledWith({
      threadId: 'thread-1',
      runId: 'run-1',
      decisions: [{ type: 'approve' }]
    })

    await expect(handlers[IpcChannel.AiChatResume]({
      threadId: 'thread-1',
      runId: 'run-1',
      decisions: [{ type: 'nonsense' }]
    })).resolves.toMatchObject({
      ok: false,
      error: { code: 'invalid_request_payload' }
    })
    expect(http.aiChatResume).toHaveBeenCalledTimes(1)
  })

  it('returns server failures as typed result envelopes', async () => {
    http.aiChatHistory.mockRejectedValue(Object.assign(new Error('Unavailable'), { code: 'unavailable' }))

    await expect(handlers[IpcChannel.AiChatHistory]('thread-1')).resolves.toEqual({
      ok: false,
      error: { code: 'unavailable', message: 'Unavailable' }
    })
  })
})
