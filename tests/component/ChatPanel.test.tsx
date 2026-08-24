import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  render,
  screen,
  fireEvent,
  cleanup,
  renderHook,
  act,
  waitFor,
  within
} from '@testing-library/react'
import { StrictMode } from 'react'
import type {
  AgentProfile,
  AgentTraceStep,
  AgentRun,
  AiProvider,
  AiReasoningEffort,
  ChatDoneEvent,
  ChatErrorEvent,
  ChatInterruptedEvent,
  ChatMessage,
  ChatReasoningEvent,
  ChatRunStatusEvent,
  ChatSendRequest,
  ChatTokenEvent,
  ChatTraceEvent
} from '../../src/shared/ipc-types'
import type {
  OcrCompletedEvent,
  OcrJob,
  OcrProgressEvent
} from '../../src/shared/mineru-types'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en', changeLanguage: () => Promise.resolve() }
  })
}))

import { useWorkspaceStore } from '../../src/renderer/store/workspaceStore'
import { useDocumentStore } from '../../src/renderer/store/documentStore'
import { usePdfReaderStore } from '../../src/renderer/store/pdfReaderStore'
import { useChatDraftStore } from '../../src/renderer/store/chatDraftStore'
import { useSettingsModalStore } from '../../src/renderer/store/settingsModalStore'
import { useAgentCatalogStore } from '../../src/renderer/store/agentCatalogStore'

const ChatPanelModule = await import('../../src/renderer/components/workspace/ChatPanel')
const ChatPanel = ChatPanelModule.default
const { parseReforaDocLink } = ChatPanelModule
const { useChatStream } = await import('../../src/renderer/hooks/useChatStream')
const { enrichChatMessages } = await import('../../src/renderer/utils/chatUtils')
const { AgentTracePanel } = await import('../../src/renderer/components/workspace/AgentTrace')
const ChatMessages = (await import('../../src/renderer/components/workspace/ChatMessages')).default
const ChatInput = (await import('../../src/renderer/components/workspace/ChatInput')).default
const AgentTodoList = (
  await import('../../src/renderer/components/workspace/AgentTodoList')
).default
const AgentOcrProgress = (
  await import('../../src/renderer/components/workspace/AgentOcrProgress')
).default

const mockChatHistory = vi.fn()
const mockChatSend = vi.fn()
const mockChatCancel = vi.fn()
const mockChatResume = vi.fn()
const mockChatRun = vi.fn()
const mockChatTraces = vi.fn()
const mockOpenPdf = vi.fn()
let chatDoneHandler: ((payload: ChatDoneEvent) => void) | undefined
let chatErrorHandler: ((payload: ChatErrorEvent) => void) | undefined
let chatTokenHandler: ((payload: ChatTokenEvent) => void) | undefined
let chatReasoningHandler: ((payload: ChatReasoningEvent) => void) | undefined
let chatTraceHandler: ((payload: ChatTraceEvent) => void) | undefined
let chatInterruptedHandler: ((payload: ChatInterruptedEvent) => void) | undefined
let chatRunStatusHandler: ((payload: ChatRunStatusEvent) => void) | undefined
let librarySwitchedHandlers: Array<() => void> = []

const TEST_PROVIDER: AiProvider = {
  id: 'p1',
  presetId: 'openai',
  name: 'Test Provider',
  baseUrl: 'http://localhost',
  apiProtocol: 'openai-responses',
  reasoningControl: 'openai',
  reasoningEffort: 'medium',
  model: 'gpt-4o',
  models: null,
  baseModel: 'gpt-4o',
  variant: '',
  variantFormat: 'dash',
  hasKey: true,
  temperature: null,
  maxTokens: null,
  createdAt: 0
}

function makeMessage(content: string): ChatMessage {
  return {
    id: `msg-${Math.random().toString(36).slice(2, 8)}`,
    threadId: 'thread-1',
    role: 'assistant',
    content,
    createdAt: Date.now()
  }
}

function makeRun(overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    id: 'run-1',
    threadId: 'thread-1',
    providerId: 'p1',
    agentProfileId: null,
    runtimeSessionId: null,
    modelId: 'gpt-4o',
    activeDocumentId: null,
    status: 'running',
    checkpointBefore: null,
    checkpointAfter: null,
    replacesRunId: null,
    userMessageId: null,
    assistantMessageId: null,
    startedAt: 1,
    endedAt: null,
    error: null,
    ...overrides
  }
}

function makeTodoStep(
  id: string,
  seq: number,
  todos: Array<{ content: string; status: 'pending' | 'in_progress' | 'completed' }>
): AgentTraceStep {
  return {
    id,
    threadId: 'thread-1',
    runId: 'run-todo',
    kind: 'todo',
    name: 'write_todos',
    input: JSON.stringify({ todos }),
    output: null,
    status: 'done',
    startedAt: seq,
    endedAt: seq + 1,
    seq,
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
    parentStepId: null,
    agentName: null,
    namespace: null,
    depth: 0,
    checkpointId: null
  }
}

function makeRunStep(runId: string, status: AgentTraceStep['status']): AgentTraceStep {
  return {
    id: `step-${runId}`,
    threadId: 'thread-1',
    runId,
    kind: 'run',
    name: null,
    input: null,
    output: null,
    status,
    startedAt: 1,
    endedAt: status === 'running' ? null : 2,
    seq: 1,
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
    parentStepId: null,
    agentName: null,
    namespace: null,
    depth: 0,
    checkpointId: null
  }
}

function setupApi(messages: ChatMessage[]): void {
  const w = window as unknown as { api: Record<string, Record<string, unknown>> }
  w.api.agentProfiles.list = async () => []
  w.api.agentProfiles.listModels = async () => ({ ok: true, models: [] })
  w.api.aiProviders.list = async () => [TEST_PROVIDER]
  w.api.aiProviders.listModels = async () => ({ ok: true, models: [] })
  w.api.settings.get = async (_key: string, defaultValue: unknown) => defaultValue
  w.api.settings.set = async () => undefined
  w.api.ai.chatHistory = mockChatHistory
  w.api.ai.chatSend = mockChatSend
  w.api.ai.chatCancel = mockChatCancel
  w.api.ai.chatRun = mockChatRun
  w.api.ai.chatTraces = mockChatTraces
  w.api.ai.chatThreads = async () => []
  w.api.ai.chatPendingInterrupt = async () => null
  w.api.ai.chatResume = mockChatResume
  w.api.documents.openPdf = mockOpenPdf
  w.api.events.onAiChatDone = (handler: (payload: ChatDoneEvent) => void) => {
    chatDoneHandler = handler
  }
  w.api.events.onAiChatError = (handler: (payload: ChatErrorEvent) => void) => {
    chatErrorHandler = handler
  }
  w.api.events.onAiChatToken = (handler: (payload: ChatTokenEvent) => void) => {
    chatTokenHandler = handler
  }
  w.api.events.onAiChatReasoning = (handler: (payload: ChatReasoningEvent) => void) => {
    chatReasoningHandler = handler
  }
  w.api.events.onAiChatTrace = (handler: (payload: ChatTraceEvent) => void) => {
    chatTraceHandler = handler
  }
  w.api.events.onAiChatInterrupted = (handler: (payload: ChatInterruptedEvent) => void) => {
    chatInterruptedHandler = handler
  }
  w.api.events.onAiChatRunStatus = (handler: (payload: ChatRunStatusEvent) => void) => {
    chatRunStatusHandler = handler
  }
  w.api.events.onLibrarySwitched = (handler: () => void) => {
    librarySwitchedHandlers.push(handler)
  }
  mockChatHistory.mockResolvedValue(messages)
  mockChatSend.mockImplementation(async (req: ChatSendRequest) => ({
    threadId: req.threadId ?? 'thread-1',
    runId: req.runId ?? 'run-1'
  }))
  mockChatCancel.mockResolvedValue({ ack: true, cancelRequested: true, terminated: true })
  mockChatRun.mockImplementation(async (runId: string) => makeRun({ id: runId }))
  mockChatTraces.mockResolvedValue([])
}

function setupStore(): void {
  useWorkspaceStore.setState({
    activeWorkspaceId: 'ws-1',
    activeThreadId: 'thread-1',
    panelView: 'workspace',
    threads: [],
    chatStreaming: false,
    fetchThreads: vi.fn().mockResolvedValue(undefined),
    deleteThread: vi.fn().mockResolvedValue(undefined),
    startNewChat: vi.fn(),
    setActiveThreadId: vi.fn(),
    setChatStreaming: vi.fn()
  })
  useDocumentStore.setState({ showToast: vi.fn() })
  usePdfReaderStore.setState({ activeDocumentId: null })
  useChatDraftStore.setState({ pending: null })
  useSettingsModalStore.setState({
    settingsOpen: false,
    settingsPage: 'general',
    accountOpen: false
  })
  useAgentCatalogStore.getState().reset()
}

beforeEach(() => {
  mockChatHistory.mockReset()
  mockChatSend.mockReset()
  mockChatCancel.mockReset()
  mockChatResume.mockReset().mockResolvedValue(undefined)
  mockChatRun.mockReset()
  mockChatTraces.mockReset()
  mockOpenPdf.mockReset()
  chatDoneHandler = undefined
  chatErrorHandler = undefined
  chatTokenHandler = undefined
  chatReasoningHandler = undefined
  chatTraceHandler = undefined
  chatInterruptedHandler = undefined
  chatRunStatusHandler = undefined
  librarySwitchedHandlers = []
  mockOpenPdf.mockResolvedValue(null)
  setupStore()
})

afterEach(() => {
  cleanup()
  useWorkspaceStore.setState({
    activeWorkspaceId: null,
    activeThreadId: null,
    threads: []
  })
  usePdfReaderStore.setState({ activeDocumentId: null })
  useChatDraftStore.setState({ pending: null })
})

describe('parseReforaDocLink', () => {
  it('parses a simple doc link', () => {
    expect(parseReforaDocLink('refora://doc/abc')).toEqual({
      docId: 'abc',
      query: undefined
    })
  })

  it('parses a doc link with query parameter', () => {
    const result = parseReforaDocLink('refora://doc/abc?q=some+quote')
    expect(result).not.toBeNull()
    expect(result!.docId).toBe('abc')
    expect(result!.query).toBe('q=some+quote')
  })

  it('decodes encoded docId', () => {
    const result = parseReforaDocLink('refora://doc/my%20doc')
    expect(result).not.toBeNull()
    expect(result!.docId).toBe('my doc')
  })

  it('does not throw on malformed percent-sequences', () => {
    expect(() => parseReforaDocLink('refora://doc/%')).not.toThrow()
    expect(() => parseReforaDocLink('refora://doc/a%zz')).not.toThrow()
    const result = parseReforaDocLink('refora://doc/%')
    expect(result).not.toBeNull()
    expect(result!.docId).toBe('%')
  })

  it('returns null for https links', () => {
    expect(parseReforaDocLink('https://example.com')).toBeNull()
  })

  it('returns null for empty href', () => {
    expect(parseReforaDocLink('')).toBeNull()
  })

  it('returns null for malformed refora links', () => {
    expect(parseReforaDocLink('refora://other/abc')).toBeNull()
    expect(parseReforaDocLink('refora://doc')).toBeNull()
  })
})

describe('ChatPanel tab header', () => {
  it('keeps the close control in the tab and the chat actions on the right', () => {
    const onClose = vi.fn()
    setupApi([])

    render(<ChatPanel onClose={onClose} />)

    const tab = screen.getByTestId('panel-tab')
    const actions = screen.getByTestId('panel-tab-actions')
    const close = screen.getByRole('button', { name: 'workspace.chat.closePanel' })
    expect(tab).toContainElement(screen.getByText('workspace.chat.newConversation'))
    expect(tab).toContainElement(close)
    expect(actions).toContainElement(
      screen.getByRole('button', { name: 'workspace.chat.threadHistory' })
    )
    expect(actions).toContainElement(
      screen.getByRole('button', { name: 'workspace.chat.newChat' })
    )

    fireEvent.click(close)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('does not render a manual academic research switch', () => {
    setupApi([])

    render(<ChatPanel />)

    expect(screen.queryByRole('button', {
      name: 'workspace.chat.academicResearch'
    })).toBeNull()
  })

  it('sends the paper in the active reader tab as agent context', async () => {
    setupApi([])
    useWorkspaceStore.setState({ panelView: 'pdf' })
    usePdfReaderStore.setState({ activeDocumentId: 'doc-reader' })

    render(<ChatPanel />)

    const input = await screen.findByRole('textbox', {
      name: 'workspace.chat.inputPlaceholder'
    })
    await waitFor(() => expect(input).not.toBeDisabled())
    fireEvent.change(input, { target: { value: 'Explain this paper' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => expect(mockChatSend).toHaveBeenCalledTimes(1))
    expect(mockChatSend.mock.calls[0][0] as ChatSendRequest).toMatchObject({
      workspaceId: 'ws-1',
      activeDocumentId: 'doc-reader',
      text: 'Explain this paper'
    })
  })

  it('prefills AI selection requests and appends selected context without sending', async () => {
    setupApi([])
    useChatDraftStore.getState().request({
      mode: 'prefill',
      text: 'Summarize this passage:\n\n> Evidence'
    })

    render(<ChatPanel />)

    const input = await screen.findByRole('textbox', {
      name: 'workspace.chat.inputPlaceholder'
    })
    await waitFor(() => expect(input).toHaveValue(
      'Summarize this passage:\n\n> Evidence'
    ))
    expect(mockChatSend).not.toHaveBeenCalled()
    expect(useChatDraftStore.getState().pending).toBeNull()

    fireEvent.change(input, { target: { value: 'Keep my existing question' } })
    act(() => {
      useChatDraftStore.getState().request({
        mode: 'prefill',
        text: 'Explain this passage:\n\n> Evidence'
      })
    })

    await waitFor(() => expect(input).toHaveValue(
      'Keep my existing question\n\nExplain this passage:\n\n> Evidence'
    ))

    act(() => {
      useChatDraftStore.getState().request({
        mode: 'append',
        text: 'Selected context:\n\n> More evidence'
      })
    })

    await waitFor(() => expect(input).toHaveValue(
      'Keep my existing question\n\nExplain this passage:\n\n> Evidence' +
      '\n\nSelected context:\n\n> More evidence'
    ))
    expect(mockChatSend).not.toHaveBeenCalled()
  })

  it('keeps an over-limit selection draft when send is attempted', async () => {
    setupApi([])
    const overLimitDraft = 'x'.repeat(32_001)
    useChatDraftStore.getState().request({
      mode: 'prefill',
      text: overLimitDraft
    })

    render(<ChatPanel />)

    const input = await screen.findByRole('textbox', {
      name: 'workspace.chat.inputPlaceholder'
    })
    await waitFor(() => expect(input).toHaveValue(overLimitDraft))
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(mockChatSend).not.toHaveBeenCalled()
    expect(input).toHaveValue(overLimitDraft)
    expect(await screen.findByText('workspace.chat.inputTooLong')).toBeInTheDocument()
  })
})

describe('ChatPanel OCR progress placement', () => {
  it('docks approved OCR progress below the messages and above the input', async () => {
    setupApi([])
    const now = Date.now()
    const job: OcrJob = {
      id: 'ocr-job',
      documentId: 'doc-ocr',
      resultKey: 'result',
      sourceHash: 'hash',
      profile: 'balanced',
      status: 'running',
      stage: 'parsing',
      progress: 0.42,
      errorCode: null,
      errorMessage: null,
      createdAt: now,
      startedAt: now,
      finishedAt: null,
      updatedAt: now
    }
    const w = window as unknown as { api: Record<string, Record<string, unknown>> }
    w.api.ocr.getState = vi.fn(async () => ({ activeJob: job }))

    render(<ChatPanel />)

    const input = await screen.findByRole('textbox', {
      name: 'workspace.chat.inputPlaceholder'
    })
    await waitFor(() => expect(input).not.toBeDisabled())
    fireEvent.change(input, { target: { value: 'Read the scanned paper' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(mockChatSend).toHaveBeenCalledTimes(1))

    const request = mockChatSend.mock.calls[0][0] as ChatSendRequest
    act(() => {
      chatInterruptedHandler?.({
        threadId: 'thread-1',
        runId: request.runId!,
        interrupt: {
          id: 'interrupt-ocr-placement',
          threadId: 'thread-1',
          runId: request.runId!,
          checkpointId: 'checkpoint-ocr-placement',
          actions: [{
            name: 'prepare_paper_ocr',
            args: { docId: 'doc-ocr' },
            description:
              'Run balanced local OCR for this paper and prepare a reusable structured full-text cache.',
            allowedDecisions: ['approve', 'reject']
          }],
          status: 'pending',
          decision: null,
          createdAt: now,
          resolvedAt: null
        }
      })
    })

    const approval = await screen.findByText('workspace.chat.approvalRequired')
    const approvalCard = approval.parentElement
    expect(approvalCard).toHaveClass(
      'mx-auto',
      'w-full',
      'max-w-[768px]',
      'border-accent',
      'bg-panel'
    )
    expect(approvalCard).toHaveTextContent('workspace.chat.approvalPrepareOcr')
    expect(approvalCard).toHaveTextContent('workspace.chat.approvalPrepareOcrDescription')
    expect(approvalCard).not.toHaveTextContent('prepare_paper_ocr')
    expect(approvalCard?.querySelector('pre')).toBeNull()
    expect(within(approvalCard as HTMLElement).getAllByRole('button')).toHaveLength(2)
    expect(approvalCard).not.toHaveTextContent(
      'Run balanced local OCR for this paper and prepare a reusable structured full-text cache.'
    )

    fireEvent.click(await screen.findByRole('button', {
      name: 'workspace.chat.approveAction'
    }))

    const progress = await screen.findByLabelText('workspace.chat.ocrProgress')
    const messageScroll = screen.getByTestId('chat-message-scroll')
    expect(progress).toHaveClass('shrink-0', 'pb-2')
    expect(progress.style.paddingInline).toBe('clamp(12px, 7cqi, 64px)')
    expect(progress.firstElementChild).toHaveClass('mx-auto', 'w-full', 'max-w-[768px]')
    expect(messageScroll).not.toContainElement(progress)
    expect(progress.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING)
      .toBeTruthy()
  })
})

describe('ChatPanel citation links', () => {
  it('renders refora://doc/ link as a clickable button', async () => {
    setupApi([makeMessage('See [Test Paper](refora://doc/doc-123) for details.')])
    render(<ChatPanel />)

    const btn = await screen.findByRole('button', { name: /Test Paper/i })
    expect(btn.tagName).toBe('BUTTON')
    fireEvent.click(btn)

    await vi.waitFor(() => {
      expect(mockOpenPdf).toHaveBeenCalledWith('doc-123')
    })
  })

  it('does not render citation as an <a> with target=_blank', async () => {
    setupApi([makeMessage('See [Test Paper](refora://doc/doc-123) for details.')])
    render(<ChatPanel />)

    await screen.findByRole('button', { name: /Test Paper/i })
    const links = screen.queryAllByRole('link')
    const citationLinks = links.filter((l) => /Test Paper/i.test(l.textContent ?? ''))
    expect(citationLinks).toHaveLength(0)
  })

  it('renders regular https links as external <a> with target=_blank', async () => {
    setupApi([makeMessage('Check [Example](https://example.com) site.')])
    render(<ChatPanel />)

    const link = await screen.findByRole('link', { name: /Example/i })
    expect(link.tagName).toBe('A')
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('rel')).toBe('noopener noreferrer')
  })

  it('renders multiple citation links as separate buttons', async () => {
    setupApi([
      makeMessage('See [First](refora://doc/doc-a) and [Second](refora://doc/doc-b).')
    ])
    render(<ChatPanel />)

    const btnA = await screen.findByRole('button', { name: /First/i })
    const btnB = await screen.findByRole('button', { name: /Second/i })
    expect(btnA.tagName).toBe('BUTTON')
    expect(btnB.tagName).toBe('BUTTON')

    fireEvent.click(btnA)
    await vi.waitFor(() => {
      expect(mockOpenPdf).toHaveBeenCalledWith('doc-a')
    })

    fireEvent.click(btnB)
    await vi.waitFor(() => {
      expect(mockOpenPdf).toHaveBeenCalledWith('doc-b')
    })
  })

  it('extracts docId correctly when query parameter is present', async () => {
    setupApi([makeMessage('See [Title](refora://doc/abc?q=some+quote).')])
    render(<ChatPanel />)

    const btn = await screen.findByRole('button', { name: /Title/i })
    expect(btn.tagName).toBe('BUTTON')
    expect(btn.getAttribute('title')).toBe('q=some+quote')

    fireEvent.click(btn)
    await vi.waitFor(() => {
      expect(mockOpenPdf).toHaveBeenCalledWith('abc')
    })
  })
})

describe('ChatPanel tool message filtering', () => {
  it('does not render tool messages in the chat history', async () => {
    const toolContent = JSON.stringify({ v: 2, name: 'search_documents', toolCallId: 'call_1', input: 'q', output: '[]' })
    const msgs: ChatMessage[] = [
      { id: 'm1', threadId: 't1', role: 'user', content: 'hello', createdAt: 0 },
      { id: 'm2', threadId: 't1', role: 'tool', content: toolContent, createdAt: 1 },
      { id: 'm3', threadId: 't1', role: 'assistant', content: 'hi there', createdAt: 2 }
    ]
    setupApi(msgs)
    render(<ChatPanel />)

    await screen.findByText('hello')
    await screen.findByText('hi there')
    expect(screen.queryByText(/search_documents/)).toBeNull()
    expect(screen.queryByText(/toolCallId/)).toBeNull()
  })
})

describe('ChatPanel provider restoration', () => {
  it('restores a CLI profile and keeps its model paired with that profile', async () => {
    setupApi([])
    const cliProfile: AgentProfile = {
      id: 'profile-codex',
      name: 'OpenAI Codex CLI',
      kind: 'cli',
      apiProviderId: null,
      cliRuntimeId: 'codex',
      executablePath: '/usr/local/bin/codex',
      model: 'default',
      reasoningEffort: 'medium',
      nativeWebSearch: true,
      webSearchPolicy: 'auto',
      createdAt: 1,
      updatedAt: 1
    }
    const w = window as unknown as { api: Record<string, Record<string, unknown>> }
    w.api.agentProfiles.list = async () => [cliProfile]
    w.api.agentProfiles.listModels = async () => ({
      ok: true,
      models: [{
        id: 'gpt-5.6-luna',
        providerName: 'GPT-5.6-Luna',
        supportsVariants: false,
        supportsReasoning: true,
        reasoningEfforts: ['low', 'medium', 'high'],
        supportsVision: true,
        supportsTools: true,
        supportedParameters: []
      }]
    })
    w.api.settings.get = async (key: string, defaultValue: unknown) => {
      if (key === 'activeAgentProfileId' || key === 'chatSelectedAgentProfileId') {
        return cliProfile.id
      }
      if (key === 'activeProviderId' || key === 'chatSelectedProviderId') {
        return TEST_PROVIDER.id
      }
      if (key === 'chatSelectedModel') return 'gpt-5.6-luna'
      if (key === 'chatReasoningEffort') return 'high'
      return defaultValue
    }

    render(<ChatPanel />)

    const selector = await screen.findByRole('button', {
      name: 'workspace.chat.selectProvider'
    })
    await waitFor(() => expect(selector).toHaveTextContent('GPT-5.6-Luna'))
    expect(selector).not.toHaveTextContent('workspace.chat.localCli')
    expect(selector.querySelector('svg')).toBeInTheDocument()

    const input = screen.getByRole('textbox', { name: 'workspace.chat.inputPlaceholder' })
    fireEvent.change(input, { target: { value: 'Use Codex' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => expect(mockChatSend).toHaveBeenCalledTimes(1))
    expect(mockChatSend.mock.calls[0][0]).toMatchObject({
      providerId: cliProfile.id,
      agentProfileId: cliProfile.id,
      model: 'gpt-5.6-luna'
    })
  })

  it('uses the CLI catalog default when a switched model rejects the current effort', async () => {
    setupApi([])
    const cliProfile: AgentProfile = {
      id: 'profile-codex',
      name: 'OpenAI Codex CLI',
      kind: 'cli',
      apiProviderId: null,
      cliRuntimeId: 'codex',
      executablePath: '/usr/local/bin/codex',
      model: 'gpt-5.6-luna',
      reasoningEffort: 'high',
      nativeWebSearch: true,
      webSearchPolicy: 'auto',
      createdAt: 1,
      updatedAt: 1
    }
    const settingsSet = vi.fn().mockResolvedValue(undefined)
    const w = window as unknown as { api: Record<string, Record<string, unknown>> }
    w.api.agentProfiles.list = async () => [cliProfile]
    w.api.agentProfiles.listModels = async () => ({
      ok: true,
      models: [
        {
          id: 'default',
          providerName: 'CLI default',
          supportsVariants: false,
          supportsReasoning: true,
          reasoningEfforts: ['low', 'medium'],
          defaultReasoningEffort: 'low',
          supportsVision: true,
          supportsTools: true,
          supportedParameters: []
        },
        {
          id: 'gpt-5.6-luna',
          providerName: 'GPT-5.6-Luna',
          supportsVariants: false,
          supportsReasoning: true,
          reasoningEfforts: ['high'],
          defaultReasoningEffort: 'high',
          supportsVision: true,
          supportsTools: true,
          supportedParameters: []
        }
      ]
    })
    w.api.settings.get = async (key: string, defaultValue: unknown) => {
      if (key === 'activeAgentProfileId' || key === 'chatSelectedAgentProfileId') {
        return cliProfile.id
      }
      if (key === 'chatSelectedModel') return 'gpt-5.6-luna'
      if (key === 'chatReasoningEffort') return 'high'
      return defaultValue
    }
    w.api.settings.set = settingsSet

    render(<ChatPanel />)

    const selector = await screen.findByRole('button', {
      name: 'workspace.chat.selectProvider'
    })
    await waitFor(() => expect(selector).toHaveTextContent('GPT-5.6-Luna'))
    fireEvent.click(selector)
    fireEvent.click(screen.getByRole('option', { name: 'OpenAI Codex CLI/default' }))

    await waitFor(() => {
      expect(screen.getByRole('button', {
        name: 'workspace.chat.reasoningEffort'
      })).toHaveTextContent('settings.aiProviders.effort.low')
    })
    expect(settingsSet).toHaveBeenCalledWith('chatReasoningEffort', 'low')
  })

  it('restores a provider reasoning effort when the saved value is none', async () => {
    setupApi([])
    const settingsSet = vi.fn().mockResolvedValue(undefined)
    const w = window as unknown as { api: Record<string, Record<string, unknown>> }
    w.api.settings.get = async (key: string, defaultValue: unknown) => {
      if (key === 'activeProviderId') return TEST_PROVIDER.id
      if (key === 'chatSelectedProviderId') return TEST_PROVIDER.id
      if (key === 'chatSelectedModel') return TEST_PROVIDER.model
      if (key === 'chatSelectedVariant') return ''
      if (key === 'chatReasoningEffort') return 'none'
      return defaultValue
    }
    w.api.settings.set = settingsSet

    render(<ChatPanel />)

    const effortButton = await screen.findByRole('button', {
      name: 'workspace.chat.reasoningEffort'
    })
    await waitFor(() => {
      expect(effortButton).toHaveTextContent('settings.aiProviders.effort.medium')
    })
    expect(settingsSet).toHaveBeenCalledWith('chatReasoningEffort', 'medium')
  })

  it('falls back to a valid provider model when saved settings are stale', async () => {
    setupApi([])
    const settingsSet = vi.fn().mockResolvedValue(undefined)
    const w = window as unknown as { api: Record<string, Record<string, unknown>> }
    w.api.settings.get = async (key: string, defaultValue: unknown) => {
      if (key === 'activeProviderId') return 'removed-provider'
      if (key === 'chatSelectedModel') return 'removed-model'
      if (key === 'chatSelectedVariant') return 'max'
      return defaultValue
    }
    w.api.settings.set = settingsSet

    render(<ChatPanel />)

    const selector = await screen.findByRole('button', {
      name: 'workspace.chat.selectProvider'
    })
    await waitFor(() => expect(selector).toHaveTextContent('gpt-4o'))
    expect(selector).not.toHaveTextContent('removed-model')
    const effortButton = screen.getByRole('button', {
      name: 'workspace.chat.reasoningEffort'
    })
    expect(effortButton).toHaveTextContent('settings.aiProviders.effort.medium')
    expect(screen.queryByText('workspace.chat.reasoningEffort')).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'workspace.chat.deepThinking' })
    ).not.toBeInTheDocument()
    fireEvent.click(effortButton)
    fireEvent.click(screen.getByRole('option', {
      name: 'settings.aiProviders.effort.high'
    }))
    expect(settingsSet).toHaveBeenCalledWith('chatReasoningEffort', 'high')
    fireEvent.click(selector)
    expect(screen.queryByPlaceholderText('model-id')).toBeNull()
    expect(settingsSet).toHaveBeenCalledWith('activeProviderId', 'p1')
  })

  it('does not apply a stale CLI model to a legacy API provider selection', async () => {
    setupApi([])
    const w = window as unknown as { api: Record<string, Record<string, unknown>> }
    w.api.settings.get = async (key: string, defaultValue: unknown) => {
      if (key === 'activeProviderId' || key === 'chatSelectedProviderId') {
        return TEST_PROVIDER.id
      }
      if (key === 'chatSelectedModel') return 'gpt-5.6-luna'
      return defaultValue
    }

    render(<ChatPanel />)

    const selector = await screen.findByRole('button', {
      name: 'workspace.chat.selectProvider'
    })
    await waitFor(() => expect(selector).toHaveTextContent(TEST_PROVIDER.model))
    expect(selector).not.toHaveTextContent('gpt-5.6-luna')
  })

  it('refreshes the configured provider and model after settings changes', async () => {
    setupApi([])
    const ollamaProvider: AiProvider = {
      ...TEST_PROVIDER,
      id: 'ollama-1',
      presetId: 'ollama-local',
      name: 'Ollama',
      model: 'Kimi2.6',
      baseModel: 'Kimi2.6',
      hasKey: false
    }
    let activeProviderId = TEST_PROVIDER.id
    const w = window as unknown as { api: Record<string, Record<string, unknown>> }
    w.api.aiProviders.list = async () => [TEST_PROVIDER, ollamaProvider]
    w.api.settings.get = async (key: string, defaultValue: unknown) => {
      if (key === 'activeProviderId' || key === 'chatSelectedProviderId') {
        return activeProviderId
      }
      if (key === 'chatSelectedModel') {
        return activeProviderId === ollamaProvider.id ? ollamaProvider.model : TEST_PROVIDER.model
      }
      return defaultValue
    }

    render(<ChatPanel />)

    const selector = await screen.findByRole('button', {
      name: 'workspace.chat.selectProvider'
    })
    await waitFor(() => expect(selector).toHaveTextContent('gpt-4o'))
    expect(selector).toHaveAttribute('title', 'Test Provider · gpt-4o')

    activeProviderId = ollamaProvider.id
    await useAgentCatalogStore.getState().refresh()

    await waitFor(() => expect(selector).toHaveTextContent('Kimi2.6'))
    expect(selector).toHaveAttribute('title', 'Ollama · Kimi2.6')
  })

  it('uses a switched provider for a new run in the existing thread', async () => {
    setupApi([makeMessage('Existing answer')])
    const ollamaProvider: AiProvider = {
      ...TEST_PROVIDER,
      id: 'ollama-1',
      presetId: 'ollama-local',
      name: 'Ollama',
      model: 'Kimi2.6',
      baseModel: 'Kimi2.6',
      hasKey: false
    }
    const startNewChat = vi.fn()
    useWorkspaceStore.setState({
      activeThreadId: 'thread-1',
      threads: [{
        id: 'thread-1',
        workspaceId: 'ws-1',
        providerId: TEST_PROVIDER.id,
        agentProfileId: null,
        createdAt: 1,
        title: 'Existing thread',
        headCheckpointId: null,
        agentStateVersion: 1
      }],
      startNewChat
    })
    const w = window as unknown as { api: Record<string, Record<string, unknown>> }
    w.api.aiProviders.list = async () => [TEST_PROVIDER, ollamaProvider]

    render(<ChatPanel />)

    const selector = await screen.findByRole('button', {
      name: 'workspace.chat.selectProvider'
    })
    await waitFor(() => expect(selector).toHaveTextContent('gpt-4o'))
    fireEvent.click(selector)
    fireEvent.click(screen.getByRole('option', { name: 'Ollama/Kimi2.6' }))
    expect(await screen.findByText('workspace.chat.providerSwitchHint')).toBeInTheDocument()

    const input = screen.getByRole('textbox', { name: 'workspace.chat.inputPlaceholder' })
    fireEvent.change(input, { target: { value: 'Continue here' } })
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: false })

    await waitFor(() => expect(mockChatSend).toHaveBeenCalled())
    expect(mockChatSend.mock.calls.at(-1)?.[0]).toMatchObject({
      threadId: 'thread-1',
      providerId: 'ollama-1',
      model: 'Kimi2.6'
    })
    expect(startNewChat).not.toHaveBeenCalled()
  })
})

function renderMessages(overrides: Partial<Parameters<typeof ChatMessages>[0]> = {}) {
  return render(
    <ChatMessages
      messages={[]}
      traceSteps={[]}
      streaming
      streamingText=""
      streamingReasoning=""
      activeRunId={null}
      elapsedSeconds={4}
      loadingHistory={false}
      providers={[]}
      onRegenerate={vi.fn()}
      onSuggestionClick={vi.fn()}
      scrollRef={{ current: null }}
      inputAreaHeight={0}
      stickToBottomRef={{ current: true }}
      {...overrides}
    />
  )
}

describe('ChatMessages presentation', () => {
  it('associates repeated assistant text with the run that finished before each message', () => {
    const messages: ChatMessage[] = [
      { id: 'a1', threadId: 't1', role: 'assistant', content: 'Same answer', createdAt: 10 },
      { id: 'a2', threadId: 't1', role: 'assistant', content: 'Same answer', createdAt: 30 }
    ]
    const makeTrace = (
      id: string,
      runId: string,
      kind: AgentTraceStep['kind'],
      startedAt: number,
      endedAt: number,
      output: string | null
    ): AgentTraceStep => ({
      id,
      threadId: 't1',
      runId,
      kind,
      name: kind === 'run' ? 'agent_run' : 'assistant_message',
      input: null,
      output,
      status: 'done',
      startedAt,
      endedAt,
      seq: kind === 'run' ? 0 : 1,
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      parentStepId: null,
      agentName: null,
      namespace: null,
      depth: 0,
      checkpointId: null
    })
    const traces = [
      makeTrace('run-1', 'run-1', 'run', 1, 5, null),
      makeTrace('message-1', 'run-1', 'message', 4, 5, 'Same answer'),
      makeTrace('run-2', 'run-2', 'run', 20, 25, null),
      makeTrace('message-2', 'run-2', 'message', 24, 25, 'Same answer')
    ]

    expect(enrichChatMessages(messages, traces).map((message) => message.runId)).toEqual([
      'run-1',
      'run-2'
    ])
  })

  it('opens the AI provider settings from the empty-provider state', () => {
    renderMessages({ streaming: false })

    fireEvent.click(screen.getByRole('button', { name: 'topbar.settings' }))

    expect(useSettingsModalStore.getState()).toMatchObject({
      settingsOpen: true,
      settingsPage: 'aiProviders'
    })
  })

  it('prefers persisted run ids when overlapping runs produce identical text', () => {
    const messages: ChatMessage[] = [
      {
        id: 'a1', threadId: 't1', role: 'assistant', content: 'Same answer', createdAt: 10,
        runId: 'run-1', runStatus: 'completed'
      },
      {
        id: 'a2', threadId: 't1', role: 'assistant', content: 'Same answer', createdAt: 11,
        runId: 'run-2', runStatus: 'completed'
      }
    ]
    const base = {
      threadId: 't1', kind: 'run' as const, name: 'agent_run', input: null,
      output: 'Same answer', status: 'done' as const, seq: 0, inputTokens: null,
      outputTokens: null, totalTokens: null, parentStepId: null, agentName: null,
      namespace: null, depth: 0, checkpointId: null
    }
    const traces: AgentTraceStep[] = [
      { ...base, id: 'trace-1', runId: 'run-1', startedAt: 1, endedAt: 8 },
      { ...base, id: 'trace-2', runId: 'run-2', startedAt: 2, endedAt: 9 }
    ]

    expect(enrichChatMessages(messages, traces).map((message) => message.runId)).toEqual([
      'run-1',
      'run-2'
    ])
  })

  it('keeps failed and completed answers associated with their own runs', () => {
    const messages: ChatMessage[] = [
      { id: 'a1', threadId: 't1', role: 'assistant', content: 'Partial answer', createdAt: 10 },
      { id: 'a2', threadId: 't1', role: 'assistant', content: 'Completed answer', createdAt: 30 }
    ]
    const base = {
      threadId: 't1',
      name: 'agent_run',
      input: null,
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
    const traces: AgentTraceStep[] = [
      {
        ...base,
        id: 'failed-run',
        runId: 'run-failed',
        kind: 'run',
        output: 'Provider failed',
        status: 'error',
        startedAt: 1,
        endedAt: 9
      },
      {
        ...base,
        id: 'failed-message',
        runId: 'run-failed',
        kind: 'message',
        name: 'assistant_message',
        output: 'Partial answer',
        status: 'done',
        startedAt: 8,
        endedAt: 9,
        seq: 1
      },
      {
        ...base,
        id: 'completed-run',
        runId: 'run-completed',
        kind: 'run',
        output: 'Completed answer',
        status: 'done',
        startedAt: 20,
        endedAt: 29
      },
      {
        ...base,
        id: 'completed-message',
        runId: 'run-completed',
        kind: 'message',
        name: 'assistant_message',
        output: 'Completed answer',
        status: 'done',
        startedAt: 28,
        endedAt: 29,
        seq: 1
      }
    ]

    expect(enrichChatMessages(messages, traces)).toMatchObject([
      { runId: 'run-failed', terminalStatus: 'failed' },
      { runId: 'run-completed' }
    ])
  })

  it('binds a persisted cancelled partial from terminal run output without adding a placeholder', () => {
    const messages: ChatMessage[] = [{
      id: 'partial',
      threadId: 't1',
      role: 'assistant',
      content: 'Persisted partial',
      createdAt: 10
    }]
    const trace: AgentTraceStep = {
      id: 'cancelled-run',
      threadId: 't1',
      runId: 'run-cancelled',
      kind: 'run',
      name: 'agent_run',
      input: null,
      output: 'Persisted partial',
      status: 'cancelled',
      startedAt: 1,
      endedAt: 9,
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

    expect(enrichChatMessages(messages, [trace])).toMatchObject([{
      id: 'partial',
      content: 'Persisted partial',
      runId: 'run-cancelled',
      terminalStatus: 'cancelled'
    }])
  })

  it('clears an earlier failed terminal status when the same run later completes', () => {
    const message = {
      id: 'partial',
      threadId: 't1',
      role: 'assistant' as const,
      content: 'Recovered answer',
      createdAt: 10,
      runId: 'run-recovered',
      terminalStatus: 'failed' as const
    }
    const completed = {
      ...makeRunStep('run-recovered', 'done'),
      threadId: 't1',
      output: 'Recovered answer',
      startedAt: 1,
      endedAt: 9
    }

    expect(enrichChatMessages([message], [completed])).toEqual([{
      id: 'partial',
      threadId: 't1',
      role: 'assistant',
      content: 'Recovered answer',
      createdAt: 10,
      runId: 'run-recovered'
    }])
  })

  it('does not let a stale running trace erase an explicit live terminal status', () => {
    const message = {
      id: 'cancelled',
      threadId: 't1',
      role: 'assistant' as const,
      content: 'Partial',
      createdAt: 10,
      runId: 'run-cancelled',
      runStatus: 'running' as const,
      terminalStatus: 'cancelled' as const
    }
    const staleRunning = {
      ...makeRunStep('run-cancelled', 'running'),
      threadId: 't1',
      output: 'Partial',
      startedAt: 1
    }

    expect(enrichChatMessages([message], [staleRunning])).toMatchObject([{
      runId: 'run-cancelled',
      terminalStatus: 'cancelled'
    }])
  })

  it('shows the latest todo plan at the top and strikes completed items', () => {
    const todoStep = makeTodoStep('todo-2', 2, [
      { content: 'Inspect the papers', status: 'completed' },
      { content: 'Draft the comparison', status: 'in_progress' }
    ])

    renderMessages({
      traceSteps: [todoStep],
      activeRunId: 'run-todo'
    })

    expect(screen.getByTestId('agent-todo-list')).toBeInTheDocument()
    expect(screen.getByText('Inspect the papers')).toHaveClass('line-through')
    expect(screen.getByText('Draft the comparison')).not.toHaveClass('line-through')
    expect(screen.getByText('1/2')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'workspace.chat.todoCollapse' }))
    expect(screen.queryByText('Inspect the papers')).toBeNull()
  })

  it('reads live todo updates from Deep Agents wrapped tool input', () => {
    const todoStep = {
      ...makeTodoStep('todo-wrapped', 3, []),
      input: JSON.stringify({
        input: JSON.stringify({
          todos: [
            { content: 'Inspect the papers', status: 'in_progress' },
            { content: 'Draft the comparison', status: 'pending' }
          ]
        })
      })
    }

    renderMessages({
      traceSteps: [todoStep],
      activeRunId: 'run-todo'
    })

    expect(screen.getByTestId('agent-todo-list')).toBeInTheDocument()
    expect(screen.getByText('Inspect the papers')).toBeInTheDocument()
    expect(screen.getByText('0/2')).toBeInTheDocument()
  })

  it('keeps a todo plan collapsed when the same run reports another update', () => {
    const first = makeTodoStep('todo-1', 1, [
      { content: 'Inspect the papers', status: 'in_progress' },
      { content: 'Draft the comparison', status: 'pending' }
    ])
    const { rerender } = render(
      <AgentTodoList steps={[first]} activeRunId="run-todo" />
    )
    fireEvent.click(screen.getByRole('button', { name: 'workspace.chat.todoCollapse' }))
    expect(screen.queryByText('Inspect the papers')).toBeNull()

    const updated = makeTodoStep('todo-2', 2, [
      { content: 'Inspect the papers', status: 'completed' },
      { content: 'Draft the comparison', status: 'in_progress' }
    ])
    rerender(
      <AgentTodoList steps={[first, updated]} activeRunId="run-todo" />
    )

    expect(screen.queryByText('Inspect the papers')).toBeNull()
    expect(screen.getByText('1/2')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'workspace.chat.todoExpand' }))
      .toHaveAttribute('aria-expanded', 'false')
  })

  it('shows OCR events in the chat with the shared progress card', async () => {
    let onProgress: ((payload: OcrProgressEvent) => void) | undefined
    const w = window as unknown as { api: Record<string, Record<string, unknown>> }
    w.api.ocr.getState = vi.fn(async () => ({ activeJob: null }))
    w.api.events.onOcrProgress = (handler: (payload: OcrProgressEvent) => void) => {
      onProgress = handler
    }
    const now = Date.now()
    const job: OcrJob = {
      id: 'ocr-job',
      documentId: 'doc-ocr',
      resultKey: 'result',
      sourceHash: 'hash',
      profile: 'balanced',
      status: 'running',
      stage: 'parsing',
      progress: 0.42,
      errorCode: null,
      errorMessage: null,
      createdAt: now,
      startedAt: now,
      finishedAt: null,
      updatedAt: now
    }

    render(<AgentOcrProgress documentId="doc-ocr" />)
    act(() => {
      onProgress?.({ job })
    })

    expect(await screen.findByLabelText('workspace.chat.ocrProgress')).toBeInTheDocument()
    expect(screen.getByText(/42%/)).toBeInTheDocument()
  })

  it('does not let stale OCR state hydration overwrite a live progress event', async () => {
    let resolveState!: (value: { activeJob: OcrJob }) => void
    let onProgress: ((payload: OcrProgressEvent) => void) | undefined
    const w = window as unknown as { api: Record<string, Record<string, unknown>> }
    w.api.ocr.getState = vi.fn(() => new Promise((resolve) => {
      resolveState = resolve
    }))
    w.api.events.onOcrProgress = (handler: (payload: OcrProgressEvent) => void) => {
      onProgress = handler
    }
    const now = Date.now()
    const staleJob: OcrJob = {
      id: 'ocr-job',
      documentId: 'doc-ocr',
      resultKey: 'result',
      sourceHash: 'hash',
      profile: 'balanced',
      status: 'running',
      stage: 'loadingModels',
      progress: 0.1,
      errorCode: null,
      errorMessage: null,
      createdAt: now,
      startedAt: now,
      finishedAt: null,
      updatedAt: now
    }
    const liveJob: OcrJob = {
      ...staleJob,
      stage: 'parsing',
      progress: 0.75,
      updatedAt: now + 1
    }

    render(<AgentOcrProgress documentId="doc-ocr" />)
    act(() => {
      onProgress?.({ job: liveJob })
    })
    await act(async () => {
      resolveState({ activeJob: staleJob })
      await Promise.resolve()
    })

    expect(screen.getByText(/75%/)).toBeInTheDocument()
    expect(screen.queryByText(/10%/)).toBeNull()
  })

  it('does not resurrect OCR progress when completion wins the hydration race', async () => {
    let resolveState!: (value: { activeJob: OcrJob }) => void
    let onCompleted: ((payload: OcrCompletedEvent) => void) | undefined
    const w = window as unknown as { api: Record<string, Record<string, unknown>> }
    w.api.ocr.getState = vi.fn(() => new Promise((resolve) => {
      resolveState = resolve
    }))
    w.api.events.onOcrCompleted = (handler: (payload: OcrCompletedEvent) => void) => {
      onCompleted = handler
    }
    const now = Date.now()
    const staleJob: OcrJob = {
      id: 'ocr-job',
      documentId: 'doc-ocr',
      resultKey: 'result',
      sourceHash: 'hash',
      profile: 'balanced',
      status: 'running',
      stage: 'parsing',
      progress: 0.9,
      errorCode: null,
      errorMessage: null,
      createdAt: now,
      startedAt: now,
      finishedAt: null,
      updatedAt: now
    }

    render(<AgentOcrProgress documentId="doc-ocr" />)
    act(() => {
      onCompleted?.({
        jobId: staleJob.id,
        documentId: staleJob.documentId,
        result: {} as never
      })
    })
    await act(async () => {
      resolveState({ activeJob: staleJob })
      await Promise.resolve()
    })

    expect(screen.queryByLabelText('workspace.chat.ocrProgress')).toBeNull()
  })

  it('renders sanitized HTML in assistant answers', () => {
    const messages: ChatMessage[] = [
      {
        id: 'a1',
        threadId: 't1',
        role: 'assistant',
        content: '<p>Area m<sup>2</sup></p><script>window.hacked = true</script>',
        createdAt: 1
      }
    ]

    const { container } = renderMessages({ messages, streaming: false })

    expect(screen.getByText('2').tagName).toBe('SUP')
    expect(container.querySelector('script')).toBeNull()
  })

  it('resolves reference links across completed Markdown blocks', () => {
    const messages: ChatMessage[] = [
      {
        id: 'a1',
        threadId: 't1',
        role: 'assistant',
        content: 'See [site][1].\n\n[1]: https://example.com',
        createdAt: 1
      }
    ]

    renderMessages({ messages, streaming: false })

    expect(screen.getByRole('link', { name: 'site' })).toHaveAttribute(
      'href',
      'https://example.com'
    )
  })

  it('renders live reasoning in a collapsible activity panel', () => {
    renderMessages({ streamingReasoning: 'Comparing the cited methods.' })

    expect(screen.getByText('workspace.chat.deepThinking')).toBeInTheDocument()
    expect(screen.getByText('Comparing the cited methods.')).toBeInTheDocument()
    const toggle = screen.getByRole('button', { name: 'workspace.chat.reasoningCollapse' })
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(toggle.querySelector('svg')).not.toBeNull()

    fireEvent.click(toggle)
    expect(screen.queryByText('Comparing the cited methods.')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'workspace.chat.reasoningExpand' })).toHaveAttribute('aria-expanded', 'false')
  })

  it('renders a completed assistant answer without extra header chrome', () => {
    const messages: ChatMessage[] = [
      { id: 'u1', threadId: 't1', role: 'user', content: 'Compare them', createdAt: 1 },
      { id: 'a1', threadId: 't1', role: 'assistant', content: 'The methods differ.', createdAt: 2 }
    ]

    const { container } = renderMessages({ messages, streaming: false })

    expect(container.querySelector('.chat-user-message')).toHaveTextContent('Compare them')
    expect(container.querySelector('.chat-response-group')).toHaveTextContent('The methods differ.')
    expect(container.querySelector('.chat-assistant-header')).toBeNull()
    expect(screen.getAllByText('workspace.chat.traceLlmDone')).toHaveLength(1)

    const runToggle = container.querySelector('.chat-run-toggle') as HTMLButtonElement
    expect(runToggle).toHaveAttribute('aria-expanded', 'true')
    fireEvent.click(runToggle)
    expect(runToggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByText('The methods differ.')).toBeInTheDocument()
  })

  it('keeps a persisted API answer when it differs from an earlier streamed segment', () => {
    const messages: ChatMessage[] = [
      { id: 'a1', threadId: 't1', role: 'assistant', content: 'Persisted final answer', createdAt: 4 }
    ]
    const base = {
      threadId: 't1', runId: 'run-api', input: null, status: 'done' as const,
      startedAt: 1, endedAt: 3, inputTokens: null, outputTokens: null,
      totalTokens: null, parentStepId: null, agentName: null, namespace: null,
      depth: 0, checkpointId: null
    }
    const traceSteps: AgentTraceStep[] = [
      { ...base, id: 'run', kind: 'run', name: 'agent', output: 'Persisted final answer', seq: 0 },
      { ...base, id: 'llm', kind: 'llm', name: 'model', output: '{}', seq: 1 },
      { ...base, id: 'partial', kind: 'message', name: 'assistant_message', output: 'Earlier progress', seq: 2 }
    ]

    const { container } = renderMessages({ messages, traceSteps, streaming: false })
    const runToggle = container.querySelector('.chat-run-toggle') as HTMLButtonElement

    expect(screen.getByText('Persisted final answer')).toBeInTheDocument()
    expect(screen.getByText('Earlier progress')).toBeInTheDocument()
    fireEvent.click(runToggle)
    expect(screen.queryByText('Earlier progress')).toBeNull()
    expect(screen.getByText('Persisted final answer')).toBeInTheDocument()
  })

  it('renders reasoning, tools, and answer segments in trace order', () => {
    const messages: ChatMessage[] = [
      { id: 'a1', threadId: 't1', role: 'assistant', content: 'Checking sources.\n\nFinal answer', createdAt: 2 }
    ]
    const base = {
      threadId: 't1',
      runId: 'run-1',
      input: null,
      status: 'done' as const,
      startedAt: 1,
      endedAt: 2,
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      parentStepId: null,
      agentName: null,
      namespace: null,
      depth: 0,
      checkpointId: null
    }
    const traceSteps: AgentTraceStep[] = [
      { ...base, id: 'llm', kind: 'llm', name: 'model_call', input: '{}', output: '', seq: 0 },
      { ...base, id: 'reasoning', kind: 'reasoning', name: 'model_reasoning', output: 'Inspect sources', seq: 1 },
      { ...base, id: 'progress', kind: 'message', name: 'assistant_message', output: 'Checking sources.', seq: 2 },
      { ...base, id: 'tool', kind: 'tool', name: 'search_documents', input: '{"query":"","scope":"library"}', output: '[]', seq: 3 },
      { ...base, id: 'answer', kind: 'message', name: 'assistant_message', output: 'Final answer', seq: 4 }
    ]

    const { container } = renderMessages({ messages, traceSteps, streaming: false })
    const kinds = [...container.querySelectorAll('[data-timeline-kind]')].map(
      (element) => element.getAttribute('data-timeline-kind')
    )

    expect(kinds).toEqual(['reasoning', 'message', 'tool', 'message'])
    expect(container.querySelector('.chat-assistant-avatar')).toBeNull()
    expect(container.querySelector('.chat-reasoning-icon')).toBeNull()
    expect(container.querySelector('.chat-timeline-answer-label')).toBeNull()
    expect(container.querySelector('[data-timeline-kind="llm"]')).toBeNull()
    expect(container.querySelector('[data-timeline-kind="tool"] .agent-trace-kind-icon')).not.toBeNull()
    expect(screen.getAllByText('workspace.chat.traceLlmDone')).toHaveLength(1)
    expect(screen.getByText('workspace.chat.deepThinking')).toBeInTheDocument()
    expect(screen.queryByText('Inspect sources')).not.toBeInTheDocument()
    const reasoningToggle = screen.getByRole('button', { name: 'workspace.chat.reasoningExpand' })
    expect(reasoningToggle).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(reasoningToggle)
    expect(screen.getByText('Inspect sources')).toBeInTheDocument()
    expect(screen.getByText('Checking sources.')).toBeInTheDocument()
    expect(screen.getByText('workspace.chat.toolSearchLibraryDone')).toBeInTheDocument()
    expect(screen.getByText('Final answer')).toBeInTheDocument()

    const runToggle = container.querySelector('.chat-run-toggle') as HTMLButtonElement
    fireEvent.click(runToggle)
    expect(screen.queryByText('workspace.chat.deepThinking')).not.toBeInTheDocument()
    expect(screen.queryByText('Checking sources.')).not.toBeInTheDocument()
    expect(screen.queryByText('workspace.chat.toolSearchLibraryDone')).not.toBeInTheDocument()
    expect(screen.getByText('Final answer')).toBeInTheDocument()
  })

  it('does not pair a failed run without an answer to the next assistant message', () => {
    const messages: ChatMessage[] = [
      { id: 'a1', threadId: 't1', role: 'assistant', content: 'Successful answer', createdAt: 20 }
    ]
    const traceSteps: AgentTraceStep[] = [
      {
        id: 'failed-run', threadId: 't1', runId: 'run-failed', kind: 'run', name: 'agent_run',
        input: null, output: 'Provider failed', status: 'error', startedAt: 1, endedAt: 2,
        seq: 0, inputTokens: null, outputTokens: null, totalTokens: null,
        parentStepId: null, agentName: null, namespace: null, depth: 0, checkpointId: null
      },
      {
        id: 'success-run', threadId: 't1', runId: 'run-success', kind: 'run', name: 'agent_run',
        input: null, output: null, status: 'done', startedAt: 10, endedAt: 12,
        seq: 0, inputTokens: null, outputTokens: null, totalTokens: null,
        parentStepId: null, agentName: null, namespace: null, depth: 0, checkpointId: null
      },
      {
        id: 'success-message', threadId: 't1', runId: 'run-success', kind: 'message',
        name: 'assistant_message', input: null, output: 'Successful answer', status: 'done',
        startedAt: 11, endedAt: 12, seq: 1, inputTokens: null, outputTokens: null,
        totalTokens: null, parentStepId: null, agentName: null, namespace: null,
        depth: 0, checkpointId: null
      }
    ]

    renderMessages({ messages, traceSteps, streaming: false })

    expect(screen.getByText('Successful answer')).toBeInTheDocument()
    expect(screen.queryByText('workspace.chat.traceCompletedError')).toBeNull()
    expect(screen.getByText('workspace.chat.traceLlmDone')).toBeInTheDocument()
  })

  it('renders persisted failed status without trace steps as a localized interruption', () => {
    const messages: ChatMessage[] = [{
      id: 'failed-answer',
      threadId: 't1',
      role: 'assistant',
      content: 'Partial persisted answer',
      createdAt: 20,
      runId: 'run-failed',
      runStatus: 'failed'
    }]

    renderMessages({ messages, traceSteps: [], streaming: false })

    expect(screen.getByText('Partial persisted answer')).toBeInTheDocument()
    expect(screen.getByText('workspace.chat.traceCompletedError')).toBeInTheDocument()
    expect(screen.getByText('workspace.chat.runFailed')).toBeInTheDocument()
    expect(screen.queryByText('workspace.chat.traceLlmDone')).not.toBeInTheDocument()
  })

  it('renders persisted cancelled status without trace steps with a cancelled run label', () => {
    const messages: ChatMessage[] = [{
      id: 'cancelled-answer',
      threadId: 't1',
      role: 'assistant',
      content: '',
      createdAt: 20,
      runId: 'run-cancelled',
      runStatus: 'cancelled'
    }]

    renderMessages({ messages, traceSteps: [], streaming: false })

    expect(screen.getByText('workspace.chat.traceCancelledLabel')).toBeInTheDocument()
    expect(screen.getByText('workspace.chat.responseCancelled')).toBeInTheDocument()
    expect(screen.queryByText('workspace.chat.traceLlmDone')).not.toBeInTheDocument()
  })

  it('keeps resumed run steps chronological and expandable after completion', () => {
    const messages: ChatMessage[] = [
      { id: 'a1', threadId: 't1', role: 'assistant', content: 'Final answer', createdAt: 100 }
    ]
    const base = {
      threadId: 't1',
      runId: 'run-resumed',
      name: 'assistant_message',
      input: null,
      status: 'done' as const,
      endedAt: 2,
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      parentStepId: null,
      agentName: null,
      namespace: null,
      depth: 0,
      checkpointId: null
    }
    const traceSteps: AgentTraceStep[] = [
      {
        ...base, id: 'run-1', kind: 'run', name: 'agent', output: 'Interrupted',
        status: 'interrupted', startedAt: 1, endedAt: 30, seq: 0
      },
      {
        ...base, id: 'progress', kind: 'message', output: 'Paper loaded.',
        startedAt: 10, seq: 55
      },
      {
        ...base, id: 'correction', kind: 'message', output: 'Correcting translation.',
        startedAt: 20, seq: 94
      },
      {
        ...base, id: 'run-2', kind: 'run', name: 'agent', output: 'Interrupted',
        status: 'interrupted', startedAt: 40, endedAt: 60, seq: 0
      },
      {
        ...base, id: 'retry', kind: 'message', output: 'Retrying publication.',
        startedAt: 50, seq: 23
      },
      {
        ...base, id: 'run-3', kind: 'run', name: 'agent', output: 'Final answer',
        startedAt: 70, endedAt: 100, seq: 0
      },
      {
        ...base, id: 'final', kind: 'message', output: 'Final answer',
        startedAt: 90, endedAt: 100, seq: 37
      }
    ]

    const { container } = renderMessages({ messages, traceSteps, streaming: false })
    const timeline = container.querySelector('.chat-agent-timeline')
    const timelineText = timeline?.textContent ?? ''

    expect(timeline).toHaveTextContent('Paper loaded.')
    expect(timeline).toHaveTextContent('Correcting translation.')
    expect(timeline).toHaveTextContent('Retrying publication.')
    expect(timeline).not.toHaveTextContent('Final answer')
    expect(timelineText.indexOf('Paper loaded.')).toBeLessThan(
      timelineText.indexOf('Correcting translation.')
    )
    expect(timelineText.indexOf('Correcting translation.')).toBeLessThan(
      timelineText.indexOf('Retrying publication.')
    )

    const runToggle = container.querySelector('.chat-run-toggle') as HTMLButtonElement
    fireEvent.click(runToggle)
    expect(screen.queryByText('Paper loaded.')).not.toBeInTheDocument()
    expect(screen.getByText('Final answer')).toBeInTheDocument()
    fireEvent.click(runToggle)
    expect(screen.getByText('Paper loaded.')).toBeInTheDocument()
  })
})

describe('ChatInput attachment loading', () => {
  it('keeps toolbar controls inside the available input width', () => {
    const props = {
      input: '',
      onInputChange: vi.fn(),
      streaming: false,
      selectedAttachments: [],
      onSelectedAttachmentsChange: vi.fn(),
      attachMenuOpen: false,
      onAttachMenuOpenChange: vi.fn(),
      activeWorkspaceId: 'ws-1',
      providers: [TEST_PROVIDER],
      canSend: false,
      onSend: vi.fn(),
      onCancel: vi.fn(),
      textareaRef: { current: null },
      inputAreaRef: { current: null },
      toolbar: <div>Toolbar</div>
    }

    render(<ChatInput {...props} />)

    const controls = screen.getByTestId('chat-input-controls')
    expect(controls).toHaveClass('min-w-0', 'flex-1', 'justify-end')
    expect(controls.parentElement).toHaveClass('min-w-0')
  })

  it('ignores documents returned for a workspace that is no longer active', async () => {
    let resolveFirst!: (value: Array<{ kind: string; docId: string }>) => void
    const w = window as unknown as { api: Record<string, Record<string, unknown>> }
    w.api.workspaceItems.list = vi.fn((workspaceId: string) => {
      if (workspaceId === 'ws-1') {
        return new Promise((resolve) => {
          resolveFirst = resolve
        })
      }
      return Promise.resolve([{ kind: 'document', docId: 'doc-2' }])
    })
    w.api.documents.get = vi.fn(async (docId: string) => ({
      id: docId,
      title: docId === 'doc-1' ? 'First workspace paper' : 'Second workspace paper'
    }))
    const props = {
      input: '',
      onInputChange: vi.fn(),
      streaming: false,
      selectedAttachments: [],
      onSelectedAttachmentsChange: vi.fn(),
      attachMenuOpen: true,
      onAttachMenuOpenChange: vi.fn(),
      providers: [TEST_PROVIDER],
      canSend: false,
      onSend: vi.fn(),
      onCancel: vi.fn(),
      textareaRef: { current: null },
      inputAreaRef: { current: null }
    }
    const { rerender } = render(<ChatInput {...props} activeWorkspaceId="ws-1" />)

    rerender(<ChatInput {...props} activeWorkspaceId="ws-2" />)
    expect(await screen.findByText('Second workspace paper')).toBeInTheDocument()
    resolveFirst([{ kind: 'document', docId: 'doc-1' }])
    await act(async () => Promise.resolve())

    expect(screen.queryByText('First workspace paper')).toBeNull()
    expect(screen.getByText('Second workspace paper')).toBeInTheDocument()
  })

  it('gives each attachment removal button an accessible name', async () => {
    const w = window as unknown as { api: Record<string, Record<string, unknown>> }
    w.api.workspaceItems.list = vi.fn().mockResolvedValue([{ kind: 'document', docId: 'doc-1' }])
    w.api.documents.get = vi.fn().mockResolvedValue({ id: 'doc-1', title: 'Named paper' })
    const onSelectedAttachmentsChange = vi.fn()
    render(<ChatInput
      input=""
      onInputChange={vi.fn()}
      streaming={false}
      selectedAttachments={['doc-1']}
      onSelectedAttachmentsChange={onSelectedAttachmentsChange}
      attachMenuOpen
      onAttachMenuOpenChange={vi.fn()}
      activeWorkspaceId="ws-1"
      providers={[TEST_PROVIDER]}
      canSend={false}
      onSend={vi.fn()}
      onCancel={vi.fn()}
      textareaRef={{ current: null }}
      inputAreaRef={{ current: null }}
    />)

    await waitFor(() => expect(screen.getAllByText('Named paper')).toHaveLength(2))
    fireEvent.click(screen.getByRole('button', { name: 'workspace.chat.removeAttachment' }))
    expect(onSelectedAttachmentsChange).toHaveBeenCalledWith(expect.any(Function))
  })
})

function renderChatStream(
  activeThreadId: string | null = 'thread-1',
  reasoningEffort?: AiReasoningEffort,
  activeWorkspaceId: string | null = 'ws-1'
) {
  setupApi([])
  return renderHook(() =>
    useChatStream({
      activeWorkspaceId,
      activeDocumentId: null,
      activeProviderId: 'p1',
      activeThreadId,
      requestModel: '',
      deepThinking: reasoningEffort != null && reasoningEffort !== 'none',
      reasoningEffort,
      setChatStreaming: vi.fn(),
      fetchThreads: vi.fn().mockResolvedValue(undefined)
    })
  )
}

describe('useChatStream lifecycle', () => {
  it('does not let a late history response overwrite a message sent while history loads', async () => {
    let resolveHistory!: (messages: ChatMessage[]) => void
    setupApi([])
    mockChatHistory.mockReturnValue(new Promise((resolve) => {
      resolveHistory = resolve
    }))
    const { result } = renderHook(() => useChatStream({
      activeWorkspaceId: 'ws-1',
      activeDocumentId: null,
      activeProviderId: 'p1',
      activeThreadId: 'thread-1',
      requestModel: '',
      deepThinking: false,
      setChatStreaming: vi.fn(),
      fetchThreads: vi.fn().mockResolvedValue(undefined)
    }))
    await waitFor(() => expect(result.current.loadingHistory).toBe(true))

    await act(async () => {
      await result.current.sendText('New message', [], 'thread-1')
    })
    expect(result.current.messages.at(-1)?.content).toBe('New message')

    await act(async () => {
      resolveHistory([makeMessage('Stale history')])
      await Promise.resolve()
    })

    expect(result.current.messages.map((message) => message.content)).toContain('New message')
    expect(result.current.messages.map((message) => message.content)).not.toContain('Stale history')
  })

  it('settles an active run when the library changes', async () => {
    const setChatStreaming = vi.fn()
    setupApi([])
    const { result } = renderHook(() => useChatStream({
      activeWorkspaceId: 'ws-1',
      activeDocumentId: null,
      activeProviderId: 'p1',
      activeThreadId: 'thread-1',
      requestModel: '',
      deepThinking: false,
      setChatStreaming,
      fetchThreads: vi.fn().mockResolvedValue(undefined)
    }))
    await waitFor(() => expect(result.current.loadingHistory).toBe(false))
    await act(async () => {
      await result.current.sendText('Keep running', [], 'thread-1')
    })
    expect(result.current.streaming).toBe(true)

    act(() => {
      librarySwitchedHandlers.forEach((handler) => handler())
    })

    expect(result.current.streaming).toBe(false)
    expect(result.current.activeRunId).toBeNull()
    expect(result.current.messages).toEqual([])
    expect(setChatStreaming).toHaveBeenLastCalledWith(false)
  })

  it('keeps chat history when loading agent traces fails', async () => {
    const history = [makeMessage('Visible history')]
    setupApi(history)
    mockChatTraces.mockRejectedValue(new Error('trace unavailable'))
    const { result } = renderHook(() => useChatStream({
      activeWorkspaceId: 'ws-1',
      activeDocumentId: null,
      activeProviderId: 'p1',
      activeThreadId: 'thread-1',
      requestModel: '',
      deepThinking: false,
      setChatStreaming: vi.fn(),
      fetchThreads: vi.fn().mockResolvedValue(undefined)
    }))

    await waitFor(() => expect(result.current.loadingHistory).toBe(false))
    expect(result.current.messages).toEqual(history)
    expect(result.current.traceSteps).toEqual([])
    expect(result.current.error).toBe('trace unavailable')
  })

  it('keeps agent traces when loading chat history fails', async () => {
    const traces = [makeRunStep('completed-run', 'done')]
    setupApi([])
    mockChatHistory.mockRejectedValue(new Error('history unavailable'))
    mockChatTraces.mockResolvedValue(traces)
    const { result } = renderHook(() => useChatStream({
      activeWorkspaceId: 'ws-1',
      activeDocumentId: null,
      activeProviderId: 'p1',
      activeThreadId: 'thread-1',
      requestModel: '',
      deepThinking: false,
      setChatStreaming: vi.fn(),
      fetchThreads: vi.fn().mockResolvedValue(undefined)
    }))

    await waitFor(() => expect(result.current.loadingHistory).toBe(false))
    expect(result.current.messages).toEqual([])
    expect(result.current.traceSteps).toEqual(traces)
    expect(result.current.error).toBe('history unavailable')
  })

  it('restores a localized cancelled response from terminal traces without persisted text', async () => {
    const cancelledTrace = makeRunStep('cancelled-run', 'cancelled')
    setupApi([])
    mockChatTraces.mockResolvedValue([cancelledTrace])
    const { result } = renderHook(() => useChatStream({
      activeWorkspaceId: 'ws-1',
      activeDocumentId: null,
      activeProviderId: 'p1',
      activeThreadId: 'thread-1',
      requestModel: '',
      deepThinking: false,
      setChatStreaming: vi.fn(),
      fetchThreads: vi.fn().mockResolvedValue(undefined)
    }))

    await waitFor(() => expect(result.current.loadingHistory).toBe(false))

    expect(result.current.messages).toMatchObject([{
      content: '',
      runId: cancelledTrace.runId,
      terminalStatus: 'cancelled'
    }])
    renderMessages({
      messages: result.current.messages,
      traceSteps: result.current.traceSteps,
      streaming: false
    })
    expect(screen.getByText('workspace.chat.responseCancelled')).toBeInTheDocument()
    expect(screen.queryByText('[Response cancelled by user]')).not.toBeInTheDocument()
  })

  it('retries with the reader document from the original send', async () => {
    setupApi([])
    mockChatSend
      .mockRejectedValueOnce(new Error('Temporary failure'))
      .mockResolvedValueOnce({ threadId: 'thread-1', runId: 'run-retry' })
    const { result, rerender } = renderHook(
      ({ activeDocumentId }: { activeDocumentId: string | null }) => useChatStream({
        activeWorkspaceId: 'ws-1',
        activeDocumentId,
        activeProviderId: 'p1',
        activeThreadId: 'thread-1',
        requestModel: '',
        deepThinking: false,
        setChatStreaming: vi.fn(),
        fetchThreads: vi.fn().mockResolvedValue(undefined)
      }),
      { initialProps: { activeDocumentId: 'doc-original' as string | null } }
    )
    await waitFor(() => expect(result.current.loadingHistory).toBe(false))

    await act(async () => {
      await result.current.sendText('Explain this paper', [], 'thread-1')
    })
    await waitFor(() => expect(result.current.canRetry).toBe(true))
    rerender({ activeDocumentId: 'doc-new' })

    act(() => {
      result.current.handleRetry()
    })

    await waitFor(() => expect(mockChatSend).toHaveBeenCalledTimes(2))
    expect(mockChatSend.mock.calls[0][0]).toMatchObject({
      activeDocumentId: 'doc-original'
    })
    expect(mockChatSend.mock.calls[1][0]).toMatchObject({
      activeDocumentId: 'doc-original'
    })
  })

  it('resumes an interrupted action with user-edited arguments', async () => {
    const { result } = renderChatStream()
    await waitFor(() => expect(result.current.loadingHistory).toBe(false))
    await act(async () => {
      await result.current.sendText('Update memory', [], 'thread-1')
    })
    const runId = result.current.activeRunId!

    act(() => {
      chatInterruptedHandler?.({
        threadId: 'thread-1',
        runId,
        interrupt: {
          id: 'interrupt-1',
          threadId: 'thread-1',
          runId,
          checkpointId: 'checkpoint-1',
          actions: [{
            name: 'propose_workspace_memory_update',
            args: { path: '/brief.md', content: 'Old' },
            allowedDecisions: ['approve', 'edit', 'reject']
          }],
          status: 'pending',
          decision: null,
          createdAt: 1,
          resolvedAt: null
        }
      })
    })

    await act(async () => {
      await result.current.sendText('Start another run', [], 'thread-1')
    })
    expect(mockChatSend).toHaveBeenCalledTimes(1)

    await act(async () => {
      await result.current.resolveInterrupt('edit', [{
        name: 'propose_workspace_memory_update',
        args: { path: '/brief.md', content: 'Updated' }
      }])
    })

    expect(mockChatResume).toHaveBeenCalledWith({
      threadId: 'thread-1',
      runId,
      decisions: [{
        type: 'edit',
        editedAction: {
          name: 'propose_workspace_memory_update',
          args: { path: '/brief.md', content: 'Updated' }
        }
      }]
    })
  })

  it('rejects only the pending OCR action without showing OCR progress', async () => {
    const { result } = renderChatStream()
    await waitFor(() => expect(result.current.loadingHistory).toBe(false))
    await act(async () => {
      await result.current.sendText('Read the scanned paper', [], 'thread-1')
    })
    const runId = result.current.activeRunId!

    act(() => {
      chatInterruptedHandler?.({
        threadId: 'thread-1',
        runId,
        interrupt: {
          id: 'interrupt-reject-ocr',
          threadId: 'thread-1',
          runId,
          checkpointId: 'checkpoint-reject-ocr',
          actions: [{
            name: 'prepare_paper_ocr',
            args: { docId: 'doc-ocr' },
            allowedDecisions: ['approve', 'reject']
          }],
          status: 'pending',
          decision: null,
          createdAt: 1,
          resolvedAt: null
        }
      })
    })

    await act(async () => {
      await result.current.resolveInterrupt('reject')
    })

    expect(mockChatResume).toHaveBeenCalledWith({
      threadId: 'thread-1',
      runId,
      decisions: [{ type: 'reject' }]
    })
    expect(result.current.pendingInterrupt).toBeNull()
    expect(result.current.activeOcrDocumentId).toBeNull()
    expect(result.current.streaming).toBe(true)
  })

  it('keeps an approval visible when resume fails', async () => {
    const { result } = renderChatStream()
    await waitFor(() => expect(result.current.loadingHistory).toBe(false))
    await act(async () => {
      await result.current.sendText('Publish output', [], 'thread-1')
    })
    const runId = result.current.activeRunId!
    act(() => {
      chatInterruptedHandler?.({
        threadId: 'thread-1',
        runId,
        interrupt: {
          id: 'interrupt-failed-resume',
          threadId: 'thread-1',
          runId,
          checkpointId: 'checkpoint-1',
          actions: [{
            name: 'publish_workspace_artifacts',
            args: { paths: ['outputs/report.md'] },
            allowedDecisions: ['approve', 'reject']
          }],
          status: 'pending',
          decision: null,
          createdAt: 1,
          resolvedAt: null
        }
      })
    })
    mockChatResume.mockRejectedValueOnce(new Error('Provider unavailable'))

    await act(async () => {
      await result.current.resolveInterrupt('approve')
    })

    expect(result.current.pendingInterrupt).toMatchObject({ id: 'interrupt-failed-resume' })
    expect(result.current.error).toContain('Provider unavailable')
    expect(result.current.streaming).toBe(false)
  })

  it('keeps a follow-up approval emitted while resume is completing', async () => {
    const { result } = renderChatStream()
    await waitFor(() => expect(result.current.loadingHistory).toBe(false))
    await act(async () => {
      await result.current.sendText('Run two reviewed actions', [], 'thread-1')
    })
    const runId = result.current.activeRunId!
    const interrupt = (id: string, name: string): ChatInterruptedEvent => ({
      threadId: 'thread-1',
      runId,
      interrupt: {
        id,
        threadId: 'thread-1',
        runId,
        checkpointId: `checkpoint-${id}`,
        actions: [{
          name,
          args: { paths: ['outputs/report.md'] },
          allowedDecisions: ['approve', 'reject']
        }],
        status: 'pending',
        decision: null,
        createdAt: 1,
        resolvedAt: null
      }
    })
    act(() => {
      chatInterruptedHandler?.(interrupt('interrupt-first', 'publish_workspace_artifacts'))
    })
    mockChatResume.mockImplementationOnce(async () => {
      chatInterruptedHandler?.(interrupt('interrupt-second', 'install_runtime_packages'))
    })

    await act(async () => {
      await result.current.resolveInterrupt('approve')
    })

    expect(result.current.pendingInterrupt).toMatchObject({ id: 'interrupt-second' })
    expect(result.current.streaming).toBe(false)
  })

  it('restores an approval after resume fails and retries the reviewed action', async () => {
    let rejectResume!: (error: Error) => void
    mockChatResume.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => {
      rejectResume = reject
    }))
    const { result } = renderChatStream()
    await waitFor(() => expect(result.current.loadingHistory).toBe(false))
    await act(async () => {
      await result.current.sendText('Read the scanned paper', [], 'thread-1')
    })
    const runId = result.current.activeRunId!
    const interrupted: ChatInterruptedEvent = {
      threadId: 'thread-1',
      runId,
      interrupt: {
        id: 'interrupt-ocr',
        threadId: 'thread-1',
        runId,
        checkpointId: 'checkpoint-ocr',
        actions: [{
          name: 'prepare_paper_ocr',
          args: { docId: 'doc-ocr' },
          allowedDecisions: ['approve', 'reject']
        }],
        status: 'pending',
        decision: null,
        createdAt: 1,
        resolvedAt: null
      }
    }
    act(() => {
      chatInterruptedHandler?.(interrupted)
    })

    expect(result.current.streaming).toBe(false)
    expect(result.current.pendingInterrupt?.id).toBe('interrupt-ocr')

    let resumePromise!: Promise<void>
    await act(async () => {
      resumePromise = result.current.resolveInterrupt('approve')
      await Promise.resolve()
    })
    expect(result.current.streaming).toBe(true)
    expect(result.current.pendingInterrupt).toBeNull()
    expect(result.current.activeOcrDocumentId).toBe('doc-ocr')

    await act(async () => {
      rejectResume(new Error('Provider unavailable'))
      await resumePromise
    })
    expect(result.current.streaming).toBe(false)
    expect(result.current.pendingInterrupt?.id).toBe('interrupt-ocr')
    expect(result.current.activeOcrDocumentId).toBeNull()
    expect(result.current.canRetry).toBe(true)

    act(() => {
      result.current.handleRetry()
    })
    await waitFor(() => expect(mockChatResume).toHaveBeenCalledTimes(2))
    expect(mockChatSend).toHaveBeenCalledTimes(1)
    expect(mockChatResume.mock.calls[1][0]).toEqual(mockChatResume.mock.calls[0][0])
  })

  it('sends a new chat with a null workspace scope', async () => {
    const { result } = renderChatStream(null, undefined, null)
    await waitFor(() => expect(result.current.loadingHistory).toBe(false))

    await act(async () => {
      await result.current.sendText('Search my library', [], null)
    })

    expect(mockChatSend.mock.calls[0][0] as ChatSendRequest).toMatchObject({
      workspaceId: null,
      text: 'Search my library'
    })
  })

  it('keeps a new chat alive after the Strict Mode effect replay', async () => {
    setupApi([])
    useWorkspaceStore.setState({ activeThreadId: null })
    const { result } = renderHook(
      () => useChatStream({
        activeWorkspaceId: 'ws-1',
        activeDocumentId: null,
        activeProviderId: 'p1',
        activeThreadId: null,
        requestModel: '',
        deepThinking: false,
        setChatStreaming: vi.fn(),
        fetchThreads: vi.fn().mockResolvedValue(undefined)
      }),
      { wrapper: StrictMode }
    )

    await waitFor(() => expect(result.current.loadingHistory).toBe(false))
    await act(async () => {
      await result.current.sendText('Start a new chat', [], null)
    })

    expect(mockChatCancel).not.toHaveBeenCalled()
    expect(useWorkspaceStore.getState().activeThreadId).toBe('thread-1')
    expect(result.current.streaming).toBe(true)
  })

  it('sends the selected reasoning effort with the chat request', async () => {
    const { result } = renderChatStream('thread-1', 'high')
    await waitFor(() => expect(result.current.loadingHistory).toBe(false))

    await act(async () => {
      await result.current.sendText('Think carefully', [], 'thread-1')
    })

    expect(mockChatSend.mock.calls[0][0] as ChatSendRequest).toMatchObject({
      features: { deepThinking: true, reasoningEffort: 'high' }
    })
    expect(mockChatSend.mock.calls[0][0].features).not.toHaveProperty('academicResearch')
  })

  it('merges live reasoning and answer tokens into their timeline steps', async () => {
    const { result } = renderChatStream()
    await waitFor(() => expect(result.current.loadingHistory).toBe(false))

    await act(async () => {
      await result.current.sendText('Compare these papers', [], 'thread-1')
    })
    const runId = (mockChatSend.mock.calls[0][0] as ChatSendRequest).runId!

    const reasoningStep: AgentTraceStep = {
      id: 'reasoning-1',
      threadId: 'thread-1',
      runId,
      kind: 'reasoning',
      name: 'model_reasoning',
      input: null,
      output: null,
      status: 'running',
      startedAt: 1,
      endedAt: null,
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
    const messageStep: AgentTraceStep = {
      ...reasoningStep,
      id: 'message-1',
      kind: 'message',
      name: 'assistant_message',
      seq: 1
    }

    act(() => {
      chatTraceHandler?.({ threadId: 'thread-1', runId, step: reasoningStep })
      chatReasoningHandler?.({ threadId: 'thread-1', runId, stepId: 'reasoning-1', token: 'Inspect ' })
      chatReasoningHandler?.({ threadId: 'thread-1', runId, stepId: 'reasoning-1', token: 'sources' })
      chatTraceHandler?.({ threadId: 'thread-1', runId, step: messageStep })
      chatTokenHandler?.({ threadId: 'thread-1', runId, stepId: 'message-1', token: 'Answer' })
    })

    await waitFor(() => {
      expect(result.current.traceSteps.find((step) => step.id === 'reasoning-1')?.output).toBe('Inspect sources')
      expect(result.current.traceSteps.find((step) => step.id === 'message-1')?.output).toBe('Answer')
    })
  })

  it('keeps fast file activity running long enough to render before completion', async () => {
    const { result } = renderChatStream()
    await waitFor(() => expect(result.current.loadingHistory).toBe(false))

    await act(async () => {
      await result.current.sendText('Write a report', [], 'thread-1')
    })
    const runId = (mockChatSend.mock.calls[0][0] as ChatSendRequest).runId!
    const runningStep: AgentTraceStep = {
      id: 'write-1',
      threadId: 'thread-1',
      runId,
      kind: 'tool',
      name: 'write_file',
      input: '{"file_path":"/outputs/report.md"}',
      output: null,
      status: 'running',
      startedAt: 1,
      endedAt: null,
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

    act(() => {
      chatTraceHandler?.({ threadId: 'thread-1', runId, step: runningStep })
      chatTraceHandler?.({
        threadId: 'thread-1',
        runId,
        step: { ...runningStep, status: 'done', endedAt: 2, output: 'written' }
      })
    })

    expect(result.current.traceSteps.find((step) => step.id === 'write-1')?.status)
      .toBe('running')
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 180))
    })
    expect(result.current.traceSteps.find((step) => step.id === 'write-1')?.status)
      .toBe('done')
  })

  it('keeps failed send context available for retry after a stream error', async () => {
    const { result } = renderChatStream()
    await waitFor(() => expect(result.current.loadingHistory).toBe(false))

    await act(async () => {
      await result.current.sendText('Compare these papers', ['doc-1'], 'thread-1')
    })
    const runId = (mockChatSend.mock.calls[0][0] as ChatSendRequest).runId!
    act(() => {
      chatErrorHandler?.({ threadId: 'thread-1', runId, message: 'Provider unavailable' })
    })

    expect(result.current.error).toBe('Provider unavailable')
    expect(result.current.canRetry).toBe(true)

    act(() => {
      result.current.handleRetry()
    })
    await waitFor(() => expect(mockChatSend).toHaveBeenCalledTimes(2))
    expect(mockChatSend.mock.calls[1][0] as ChatSendRequest).toMatchObject({
      text: 'Compare these papers',
      replaceLastExchange: true,
      replaceRunId: runId,
      attachments: [{ type: 'document', docId: 'doc-1' }]
    })
  })

  it('preserves attachments when regenerating a completed response', async () => {
    const { result } = renderChatStream()
    await waitFor(() => expect(result.current.loadingHistory).toBe(false))

    await act(async () => {
      await result.current.sendText('Summarize this paper', ['doc-2'], 'thread-1')
    })
    const runId = (mockChatSend.mock.calls[0][0] as ChatSendRequest).runId!
    act(() => {
      chatDoneHandler?.({ threadId: 'thread-1', runId, finalText: 'Summary' })
    })

    expect(result.current.canRetry).toBe(false)
    act(() => {
      result.current.handleRegenerate()
    })
    await waitFor(() => expect(mockChatSend).toHaveBeenCalledTimes(2))
    expect(mockChatSend.mock.calls[1][0] as ChatSendRequest).toMatchObject({
      text: 'Summarize this paper',
      replaceLastExchange: true,
      attachments: [{ type: 'document', docId: 'doc-2' }]
    })
  })

  it('ignores late events from an older run in the same thread', async () => {
    const { result } = renderChatStream()
    await waitFor(() => expect(result.current.loadingHistory).toBe(false))

    await act(async () => {
      await result.current.sendText('Current request', [], 'thread-1')
    })
    const runId = (mockChatSend.mock.calls[0][0] as ChatSendRequest).runId!

    act(() => {
      chatTokenHandler?.({ threadId: 'thread-1', runId: 'older-run', token: 'stale' })
      chatErrorHandler?.({ threadId: 'thread-1', runId: 'older-run', message: 'stale error' })
      chatTokenHandler?.({ threadId: 'thread-1', runId, token: 'current' })
    })

    await waitFor(() => expect(result.current.streamingText).toBe('current'))
    expect(result.current.error).toBeNull()
    expect(result.current.streaming).toBe(true)
  })

  it('does not hydrate history over a newly started live run', async () => {
    setupApi([])
    const { result, rerender } = renderHook(
      ({ threadId }: { threadId: string | null }) => useChatStream({
        activeWorkspaceId: 'ws-1',
        activeDocumentId: null,
        activeProviderId: 'p1',
        activeThreadId: threadId,
        requestModel: '',
        deepThinking: false,
        setChatStreaming: vi.fn(),
        fetchThreads: vi.fn().mockResolvedValue(undefined)
      }),
      { initialProps: { threadId: null as string | null } }
    )

    await act(async () => {
      await result.current.sendText('New live question', [], null)
    })
    rerender({ threadId: 'thread-1' })

    expect(mockChatHistory).not.toHaveBeenCalled()
    expect(result.current.messages).toHaveLength(1)
    expect(result.current.messages[0].content).toBe('New live question')
    expect(result.current.streaming).toBe(true)
  })

  it('cancels an active run and releases the global lock when unmounted', async () => {
    setupApi([])
    const setChatStreaming = vi.fn()
    const { result, unmount } = renderHook(() => useChatStream({
      activeWorkspaceId: 'ws-1',
      activeDocumentId: null,
      activeProviderId: 'p1',
      activeThreadId: 'thread-1',
      requestModel: '',
      deepThinking: false,
      setChatStreaming,
      fetchThreads: vi.fn().mockResolvedValue(undefined)
    }))
    await waitFor(() => expect(result.current.loadingHistory).toBe(false))
    await act(async () => {
      await result.current.sendText('Keep running', [], 'thread-1')
    })

    unmount()

    expect(mockChatCancel).toHaveBeenCalledWith(
      (mockChatSend.mock.calls[0][0] as ChatSendRequest).runId
    )
    expect(setChatStreaming).toHaveBeenLastCalledWith(false)
  })

  it('cancels a new thread after its id arrives when stop is clicked immediately', async () => {
    let resolveSend: ((value: { threadId: string; runId: string }) => void) | undefined
    let requestedRunId = ''
    const { result } = renderChatStream(null)
    mockChatSend.mockImplementation(
      (req: ChatSendRequest) => new Promise<{ threadId: string; runId: string }>((resolve) => {
        requestedRunId = req.runId!
        resolveSend = resolve
      })
    )
    let sendPromise: Promise<void> | undefined

    await act(async () => {
      sendPromise = result.current.sendText('Start a new chat', [], null)
      await Promise.resolve()
    })
    act(() => {
      result.current.handleCancel()
    })

    expect(mockChatCancel).toHaveBeenCalledWith(requestedRunId)
    await act(async () => {
      resolveSend?.({ threadId: 'new-thread', runId: requestedRunId })
      await sendPromise
    })
    expect(mockChatCancel).toHaveBeenCalledWith(requestedRunId)
    expect(result.current.streaming).toBe(true)
    act(() => {
      chatDoneHandler?.({
        threadId: 'new-thread',
        runId: requestedRunId,
        finalText: '[Response cancelled by user]'
      })
    })
    expect(result.current.streaming).toBe(false)
    expect(result.current.messages.at(-1)).toMatchObject({
      content: '',
      runId: requestedRunId,
      terminalStatus: 'cancelled'
    })
  })

  it('preserves streamed text when a run is cancelled', async () => {
    const { result } = renderChatStream()
    await waitFor(() => expect(result.current.loadingHistory).toBe(false))
    await act(async () => {
      await result.current.sendText('Draft a response', [], 'thread-1')
    })
    const runId = result.current.activeRunId!

    act(() => {
      chatTokenHandler?.({ threadId: 'thread-1', runId, token: 'Partial answer' })
      result.current.handleCancel()
      chatDoneHandler?.({
        threadId: 'thread-1',
        runId,
        finalText: '[Response cancelled by user]'
      })
    })

    expect(result.current.streaming).toBe(false)
    expect(result.current.messages.at(-1)).toMatchObject({
      content: 'Partial answer',
      runId,
      terminalStatus: 'cancelled'
    })
  })

  it('surfaces a cancellation request that has not terminated the run', async () => {
    mockChatCancel.mockResolvedValueOnce({
      ack: true,
      cancelRequested: true,
      terminated: false
    })
    const { result } = renderChatStream()
    await waitFor(() => expect(result.current.loadingHistory).toBe(false))
    await act(async () => {
      await result.current.sendText('Keep working', [], 'thread-1')
    })

    act(() => {
      result.current.handleCancel()
    })

    await waitFor(() => expect(result.current.error).toBe('workspace.chat.stopFailed'))
    expect(result.current.streaming).toBe(true)
  })

  it('preserves streamed text when a run fails', async () => {
    const { result } = renderChatStream()
    await waitFor(() => expect(result.current.loadingHistory).toBe(false))
    await act(async () => {
      await result.current.sendText('Draft a response', [], 'thread-1')
    })
    const runId = result.current.activeRunId!

    act(() => {
      chatTokenHandler?.({ threadId: 'thread-1', runId, token: 'Partial answer' })
      chatErrorHandler?.({
        threadId: 'thread-1',
        runId,
        message: 'Provider failed',
        partialText: 'Partial answer'
      })
    })

    expect(result.current.streaming).toBe(false)
    expect(result.current.messages.at(-1)).toMatchObject({
      content: 'Partial answer',
      runId,
      terminalStatus: 'failed'
    })
    const messageCount = result.current.messages.length
    act(() => {
      chatDoneHandler?.({
        threadId: 'thread-1',
        runId,
        finalText: 'Partial answer'
      })
    })
    expect(result.current.messages).toHaveLength(messageCount)
    expect(result.current.messages.at(-1)).toMatchObject({
      content: 'Partial answer',
      runId,
      terminalStatus: 'failed'
    })
  })

  it('reconciles a terminal run-status event from the persisted snapshot', async () => {
    const { result } = renderChatStream()
    await waitFor(() => expect(result.current.loadingHistory).toBe(false))
    await act(async () => {
      await result.current.sendText('Draft a response', [], 'thread-1')
    })
    const runId = result.current.activeRunId!
    mockChatRun.mockResolvedValueOnce(makeRun({
      id: runId,
      status: 'failed',
      endedAt: 2,
      error: 'Worker stopped'
    }))

    act(() => {
      chatTokenHandler?.({ threadId: 'thread-1', runId, token: 'Recovered partial' })
      chatRunStatusHandler?.({ threadId: 'thread-1', runId, status: 'failed' })
    })

    await waitFor(() => expect(result.current.streaming).toBe(false))
    expect(mockChatRun).toHaveBeenCalledWith(runId)
    expect(result.current.messages.at(-1)?.content).toContain('Recovered partial')
    expect(result.current.error).toBe('Worker stopped')
  })

  it('ignores an older recovery snapshot that finishes after a newer one', async () => {
    const { result } = renderChatStream()
    await waitFor(() => expect(result.current.loadingHistory).toBe(false))
    await act(async () => {
      await result.current.sendText('Recover this run', [], 'thread-1')
    })
    const runId = result.current.activeRunId!
    const olderTrace = { ...makeRunStep(runId, 'running'), id: 'older-trace' }
    const newerTrace = { ...makeRunStep(runId, 'running'), id: 'newer-trace', seq: 2 }
    let resolveOlderRun: ((run: AgentRun) => void) | undefined
    let resolveOlderTraces: ((traces: AgentTraceStep[]) => void) | undefined
    mockChatRun
      .mockReset()
      .mockReturnValueOnce(new Promise((resolve) => {
        resolveOlderRun = resolve
      }))
      .mockResolvedValueOnce(makeRun({ id: runId, status: 'running' }))
    mockChatTraces
      .mockReset()
      .mockReturnValueOnce(new Promise((resolve) => {
        resolveOlderTraces = resolve
      }))
      .mockResolvedValueOnce([newerTrace])

    act(() => {
      chatRunStatusHandler?.({ threadId: 'thread-1', runId, status: 'failed' })
      chatRunStatusHandler?.({ threadId: 'thread-1', runId, status: 'failed' })
    })
    await waitFor(() => expect(result.current.traceSteps).toEqual([newerTrace]))

    await act(async () => {
      resolveOlderRun?.(makeRun({ id: runId, status: 'running' }))
      resolveOlderTraces?.([olderTrace])
      await Promise.resolve()
    })

    expect(result.current.traceSteps).toEqual([newerTrace])
  })

  it('refreshes the completed run trace after the done event', async () => {
    const { result } = renderChatStream()
    await waitFor(() => expect(result.current.loadingHistory).toBe(false))
    await act(async () => {
      await result.current.sendText('Explain the paper', [], 'thread-1')
    })
    const runId = result.current.activeRunId!
    const completedRun = makeRunStep(runId, 'done')
    const completedModel: AgentTraceStep = {
      ...completedRun,
      id: 'model-completed',
      kind: 'llm',
      name: 'model',
      seq: 2,
      inputTokens: 12,
      outputTokens: 8,
      totalTokens: 20
    }
    mockChatTraces.mockResolvedValue([completedRun, completedModel])

    act(() => {
      chatDoneHandler?.({
        threadId: 'thread-1',
        runId,
        finalText: 'Answer'
      })
    })

    expect(result.current.streaming).toBe(false)
    await waitFor(() => {
      expect(result.current.traceSteps).toEqual([completedRun, completedModel])
    })
    expect(mockChatTraces).toHaveBeenCalledWith('thread-1')
  })

  it('discards a completed trace refresh after regeneration starts', async () => {
    const { result } = renderChatStream()
    await waitFor(() => expect(result.current.loadingHistory).toBe(false))
    await act(async () => {
      await result.current.sendText('Explain the paper', [], 'thread-1')
    })
    const completedRunId = result.current.activeRunId!
    const completedRun = makeRunStep(completedRunId, 'done')
    act(() => {
      chatTraceHandler?.({
        threadId: 'thread-1',
        runId: completedRunId,
        step: completedRun
      })
    })
    let resolveCompletedTrace: ((steps: AgentTraceStep[]) => void) | undefined
    mockChatTraces.mockImplementationOnce(
      () => new Promise<AgentTraceStep[]>((resolve) => {
        resolveCompletedTrace = resolve
      })
    )

    act(() => {
      chatDoneHandler?.({
        threadId: 'thread-1',
        runId: completedRunId,
        finalText: 'First answer'
      })
    })
    act(() => {
      result.current.handleRegenerate()
    })
    await waitFor(() => expect(mockChatSend).toHaveBeenCalledTimes(2))

    await act(async () => {
      resolveCompletedTrace?.([completedRun])
      await Promise.resolve()
    })

    expect(result.current.traceSteps.some((step) => step.runId === completedRunId))
      .toBe(false)
  })

  it('converges a reloaded running trace from the persisted run snapshot', async () => {
    setupApi([])
    const runId = 'run-reloaded'
    const userMessage: ChatMessage = {
      id: 'user-reloaded',
      threadId: 'thread-1',
      role: 'user',
      content: 'Question before reload',
      createdAt: 1
    }
    const assistantMessage: ChatMessage = {
      id: 'assistant-reloaded',
      threadId: 'thread-1',
      role: 'assistant',
      content: 'Persisted answer',
      createdAt: 2
    }
    mockChatHistory
      .mockReset()
      .mockResolvedValueOnce([userMessage])
      .mockResolvedValue([userMessage, assistantMessage])
    mockChatTraces.mockResolvedValue([makeRunStep(runId, 'running')])
    mockChatRun.mockResolvedValue(makeRun({
      id: runId,
      status: 'completed',
      assistantMessageId: assistantMessage.id,
      endedAt: 2
    }))

    const { result } = renderHook(() => useChatStream({
      activeWorkspaceId: 'ws-1',
      activeDocumentId: null,
      activeProviderId: 'p1',
      activeThreadId: 'thread-1',
      requestModel: '',
      deepThinking: false,
      setChatStreaming: vi.fn(),
      fetchThreads: vi.fn().mockResolvedValue(undefined)
    }))

    await waitFor(() => {
      expect(result.current.loadingHistory).toBe(false)
      expect(result.current.streaming).toBe(false)
      expect(result.current.activeRunId).toBeNull()
      expect(result.current.messages.at(-1)?.content).toBe('Persisted answer')
    })
    expect(mockChatRun).toHaveBeenCalledWith(runId)
  })

  it('backfills missed live text and reasoning from persisted traces', async () => {
    setupApi([])
    const runId = 'run-recovered-stream'
    const runStep = makeRunStep(runId, 'running')
    const reasoningStep: AgentTraceStep = {
      ...runStep,
      id: 'reasoning-recovered',
      kind: 'reasoning',
      name: 'model_reasoning',
      output: 'Recovered reasoning',
      seq: 1
    }
    const messageStep: AgentTraceStep = {
      ...runStep,
      id: 'message-recovered',
      kind: 'message',
      name: 'assistant_message',
      output: 'Recovered answer',
      seq: 2
    }
    mockChatTraces
      .mockReset()
      .mockResolvedValueOnce([runStep])
      .mockResolvedValue([runStep, reasoningStep, messageStep])
    mockChatRun.mockResolvedValue(makeRun({
      id: runId,
      status: 'running',
      endedAt: null
    }))

    const { result } = renderHook(() => useChatStream({
      activeWorkspaceId: 'ws-1',
      activeDocumentId: null,
      activeProviderId: 'p1',
      activeThreadId: 'thread-1',
      requestModel: '',
      deepThinking: false,
      setChatStreaming: vi.fn(),
      fetchThreads: vi.fn().mockResolvedValue(undefined)
    }))

    await waitFor(() => {
      expect(result.current.streaming).toBe(true)
      expect(result.current.streamingText).toBe('Recovered answer')
      expect(result.current.streamingReasoning).toBe('Recovered reasoning')
    })
    expect(result.current.traceSteps).toEqual([
      runStep,
      reasoningStep,
      messageStep
    ])
  })
})

describe('AgentTracePanel structure', () => {
  it('keeps expand-all outside the panel toggle button', () => {
    Element.prototype.scrollIntoView = vi.fn()
    const traceStep: AgentTraceStep = {
      id: 'step-1',
      threadId: 'thread-1',
      runId: 'run-1',
      kind: 'llm',
      name: null,
      input: 'Prompt',
      output: null,
      status: 'done',
      startedAt: 0,
      endedAt: 1,
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
    render(<AgentTracePanel steps={[traceStep]} streaming={false} />)
    const panelToggle = screen.getByRole('button', { name: /workspace.chat.trace/ })
    fireEvent.click(panelToggle)
    expect(panelToggle.querySelector('button')).toBeNull()
    expect(screen.getByRole('button', { name: 'workspace.chat.expandAll' })).toBeInTheDocument()
  })

  it('uses completed tool labels and pretty prints JSON details', () => {
    Element.prototype.scrollIntoView = vi.fn()
    const traceStep: AgentTraceStep = {
      id: 'step-1',
      threadId: 'thread-1',
      runId: 'run-1',
      kind: 'tool',
      name: 'search_documents',
      input: '{"query":"graph","scope":"library"}',
      output: null,
      status: 'done',
      startedAt: 0,
      endedAt: 10,
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
    render(<AgentTracePanel steps={[traceStep]} streaming={false} />)

    fireEvent.click(screen.getByRole('button', { name: /workspace.chat.trace/ }))
    fireEvent.click(screen.getByText('workspace.chat.toolSearchLibraryDone'))

    expect(screen.getByText(/"query": "graph"/)).toBeInTheDocument()
  })
})
