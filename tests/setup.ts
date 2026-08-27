import '@testing-library/jest-dom/vitest'
import { vi } from 'vitest'
import type { ReforaApi } from '../src/shared/ipc-types'

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
  })),
})

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}
;(global as unknown as Record<string, unknown>).ResizeObserver = ResizeObserverMock

const noop = async () => undefined
const noopDisposer = () => undefined
const mockResult = <T>(): T => undefined as T

export const createMockReforaApi = (): ReforaApi => ({
  getBootstrap: async () => ({
    language: 'en',
    theme: 'dark',
    windowBounds: null,
    listColumnState: null,
    sidebarCollapsed: false,
    firstRun: false,
    libraryFolderPath: '/fake/library',
  }),

  documents: {
    list: async () => [],
    counts: async () => ({ all: 0, recentlyRead: 0, recentlyAdded: 0, starred: 0 }),
    search: async () => [],
    get: async () => mockResult<Awaited<ReturnType<ReforaApi['documents']['get']>>>(),
    update: async () => mockResult<Awaited<ReturnType<ReforaApi['documents']['update']>>>(),
    setStarred: noop,
    delete: noop,
    bulkDelete: noop,
    bulkCategorize: noop,
    bulkRefreshMetadata: noop,
    openPdf: async () => mockResult<Awaited<ReturnType<ReforaApi['documents']['openPdf']>>>(),
    readPdfRange: async (_id: string, begin: number) => ({
      begin,
      fileSize: 1,
      data: new Uint8Array([1])
    }),
    pdfAnnotations: async () => [],
    setPdfAnnotations: async (_id, annotations) => annotations,
    openInFinder: noop,
    refreshMetadata: async () => mockResult<Awaited<ReturnType<ReforaApi['documents']['refreshMetadata']>>>(),
    relocateFile: async () => mockResult<Awaited<ReturnType<ReforaApi['documents']['relocateFile']>>>(),
    restoreFile: async () => mockResult<Awaited<ReturnType<ReforaApi['documents']['restoreFile']>>>(),
    previewUrl: (id: string, version: string | number) =>
      `refora-document://preview/${encodeURIComponent(id)}?v=${encodeURIComponent(String(version))}`,
  },

  search: {
    global: async () => ({ documents: [], workspaceFiles: [], workspaceContents: [], chats: [] }),
  },

  import: {
    addFiles: async () => ({ added: [], skipped: [], errors: [] }),
    fromZotero: async () => ({ added: 0, skipped: 0, errors: [] }),
    fromMendeley: async () => ({ added: 0, skipped: 0, errors: [] }),
    fromIdentifier: async () => ({ added: [] }),
  },

  categories: {
    list: async () => [],
    create: async () => mockResult<Awaited<ReturnType<ReforaApi['categories']['create']>>>(),
    rename: noop,
    delete: noop,
    assign: noop,
    unassign: noop,
  },

  watch: {
    list: async () => [],
    add: async () => mockResult<Awaited<ReturnType<ReforaApi['watch']['add']>>>(),
    remove: noop,
    toggle: noop,
  },

  settings: {
    get: async <T>(_key: string, defaultValue: T) => defaultValue,
    set: noop,
  },

  sync: {
    status: async () => ({
      configured: false,
      signedIn: false,
      account: null,
    }),
    signIn: async () => ({
      configured: true,
      signedIn: true,
      account: { id: 'user-1', email: 'user@example.com' },
    }),
    signUp: async () => ({
      confirmationRequired: true,
      status: {
        configured: true,
        signedIn: false,
        account: null,
      },
    }),
    resendConfirmation: noop,
    signOut: async () => ({
      configured: true,
      signedIn: false,
      account: null,
    }),
    setEnabled: async () => ({
      configured: true,
      signedIn: true,
      account: { id: 'user-1', email: 'user@example.com' },
    }),
    runNow: async () => ({
      configured: true,
      signedIn: true,
      account: { id: 'user-1', email: 'user@example.com' },
    }),
    conflicts: async () => [],
    resolveConflict: async () => ({
      configured: true,
      signedIn: true,
      account: { id: 'user-1', email: 'user@example.com' },
    }),
  },

  appearance: {
    setThemeSource: noop,
  },

  webSearch: {
    getConfig: async () => ({
      provider: 'disabled',
      hasTavilyApiKey: false,
      hasBraveApiKey: false,
      ddgsInstalled: false,
      ddgsVersion: '9.14.4',
    }),
    updateConfig: async (patch) => ({
      provider: patch.provider ?? ('disabled' as const),
      hasTavilyApiKey: false,
      hasBraveApiKey: false,
      ddgsInstalled: false,
      ddgsVersion: '9.14.4',
    }),
    test: async () => ({
      ok: false,
      provider: 'disabled',
      resultCount: 0,
      error: 'Web search is disabled',
    }),
  },

  mineru: {
    status: async () => ({
      state: 'notInstalled',
      installRoot: '/fake/mineru',
      installPath: null,
      version: null,
      architecture: 'arm64',
      pythonPath: null,
      modelConfigPath: null,
      installedAt: null,
      diskBytes: null,
      error: null,
      progress: null,
    }),
    chooseInstallRoot: async () => mockResult<Awaited<ReturnType<ReforaApi['mineru']['chooseInstallRoot']>>>(),
    install: async () => mockResult<Awaited<ReturnType<ReforaApi['mineru']['install']>>>(),
    cancelInstall: async () => mockResult<Awaited<ReturnType<ReforaApi['mineru']['cancelInstall']>>>(),
    uninstall: async () => mockResult<Awaited<ReturnType<ReforaApi['mineru']['uninstall']>>>(),
  },

  ocr: {
    getState: async () => ({
      engine: {
        state: 'notInstalled',
        installRoot: '/fake/mineru',
        installPath: null,
        version: null,
        architecture: 'arm64',
        pythonPath: null,
        modelConfigPath: null,
        installedAt: null,
        diskBytes: null,
        error: null,
        progress: null,
      },
      activeJob: null,
      result: null,
    }),
    start: async () => mockResult<Awaited<ReturnType<ReforaApi['ocr']['start']>>>(),
    cancel: async () => mockResult<Awaited<ReturnType<ReforaApi['ocr']['cancel']>>>(),
    readMarkdown: async () => '',
    assetUrl: (documentId: string, resultKey: string, assetPath: string) =>
      `refora-document://ocr/${documentId}/${resultKey}/${assetPath}`,
  },

  dialog: {
    openDirectory: async () => null,
  },

  library: {
    switch: async () => ({
      libraryFolderPath: '/fake/library',
      dbExisted: true,
      scanned: 0,
      imported: 0,
      skipped: 0,
      errors: [],
    }),
  },

  getPathForFile: async (_file: unknown) => '',

  export: {
    toBibtex: async () => undefined,
    toBibtexString: async () => '',
  },

  clipboard: {
    writeText: noop,
    copyMarkdown: noop,
    copyWorkspaceAsset: noop,
  },

  workspaces: {
    list: async () => [],
    create: async (name: string) => ({ id: 'ws', name, createdAt: 0, updatedAt: 0 }),
    rename: noop,
    delete: noop,
    openSandbox: noop,
  },

  workspaceItems: {
    list: async () => [],
    add: async () => [],
    remove: noop,
    reorder: async () => [],
    resize: async (id: string, width: number, height: number) => ({
      id,
      workspaceId: 'ws',
      kind: 'document' as const,
      docId: 'doc',
      reportId: null,
      noteId: null,
      assetId: null,
      sortOrder: 0,
      width,
      height,
      x: 0,
      y: 0,
      zIndex: 0,
      addedAt: 0
    }),
    move: async (id: string, x: number, y: number, zIndex: number) => ({
      id,
      workspaceId: 'ws',
      kind: 'document' as const,
      docId: 'doc',
      reportId: null,
      noteId: null,
      assetId: null,
      sortOrder: 0,
      width: 300,
      height: 200,
      x,
      y,
      zIndex,
      addedAt: 0
    }),
  },

  workspaceAssets: {
    list: async () => [],
    addFiles: async () => ({ imported: [], errors: [] }),
    textPreview: async () => ({ content: '', truncated: false }),
    open: noop,
    reveal: noop,
    delete: noop,
    previewUrl: (id: string) => `refora-asset://asset/${encodeURIComponent(id)}`,
  },

  workspaceFiles: {
    add: async () => ({ documentIds: [], notes: [], assets: [], errors: [] }),
  },

  workspaceNotes: {
    list: async () => [],
    create: async (workspaceId, title, contentMd, noteType) => ({
      id: 'note',
      workspaceId,
      noteType,
      title,
      contentMd,
      color: 'sand' as const,
      createdAt: 0,
      updatedAt: 0
    }),
    update: async (id, patch) => ({
      id,
      workspaceId: 'ws',
      noteType: 'markdown' as const,
      title: patch.title ?? '',
      contentMd: patch.contentMd ?? '',
      color: patch.color ?? 'sand',
      createdAt: 0,
      updatedAt: 0
    }),
    delete: noop,
  },

  workspaceCanvas: {
    get: async () => ({ panX: 0, panY: 0, zoom: 1 }),
    update: async (_workspaceId: string, viewport: { panX: number; panY: number; zoom: number }) => viewport,
  },

  workspaceConnections: {
    list: async () => [],
    create: async (
      workspaceId: string,
      sourceItemId: string,
      targetItemId: string,
      sourceAnchor: 'top' | 'right' | 'bottom' | 'left',
      targetAnchor: 'top' | 'right' | 'bottom' | 'left'
    ) => ({
      id: 'connection',
      workspaceId,
      sourceItemId,
      targetItemId,
      sourceAnchor,
      targetAnchor,
      createdAt: 0
    }),
    delete: noop,
  },

  aiProviders: {
    list: async () => [],
    create: async (input) => ({
      id: 'p',
      presetId: input.name === 'OpenAI' ? 'openai' : 'custom',
      name: input.name,
      baseUrl: input.baseUrl,
      apiProtocol: 'openai-compatible' as const,
      reasoningControl: 'openai' as const,
      reasoningEffort: 'medium' as const,
      model: input.model,
      models: null,
      baseModel: input.model,
      variant: '',
      variantFormat: 'dash' as const,
      hasKey: false,
      temperature: null,
      maxTokens: null,
      createdAt: 0
    }),
    update: async (id) => ({
      id,
      presetId: 'custom',
      name: '',
      baseUrl: '',
      apiProtocol: 'openai-compatible' as const,
      reasoningControl: 'openai' as const,
      reasoningEffort: 'medium' as const,
      model: '',
      models: null,
      baseModel: '',
      variant: '',
      variantFormat: 'dash' as const,
      hasKey: false,
      temperature: null,
      maxTokens: null,
      createdAt: 0
    }),
    delete: noop,
    test: async () => ({ ok: true }),
    listModels: async () => ({ ok: true, models: [] }),
  },

  agentProfiles: {
    list: async () => [],
    create: async () => mockResult<Awaited<ReturnType<ReforaApi['agentProfiles']['create']>>>(),
    update: async () => mockResult<Awaited<ReturnType<ReforaApi['agentProfiles']['update']>>>(),
    delete: noop,
    test: async () => ({ ok: true, runtimeId: 'codex' }),
    listModels: async () => ({ ok: true, models: [] }),
    scanRuntimes: async () => [
      {
        ok: true,
        runtimeId: 'codex',
        label: 'OpenAI Codex CLI',
        defaultExecutable: 'codex',
        available: true,
        executablePath: '/usr/local/bin/codex',
        version: 'codex-cli 1.0.0',
        authenticated: true,
        reasoningMode: 'select' as const,
        capabilities: { nativeWebSearch: true, mcp: true, sessionResume: true },
        models: [
          {
            id: 'default',
            label: 'CLI default',
            reasoningEfforts: ['low', 'medium', 'high', 'xhigh'] as const,
            defaultReasoningEffort: 'medium' as const
          }
        ]
      }
    ]
  },

  ai: {
    docTextGet: async () => '',
    summarize: noop,
    summaryGet: async () => null,
    chatSend: async () => ({ threadId: 't', runId: 'r' }),
    chatHistory: async () => [],
    chatThreads: async () => [],
    usageStats: async () => ({
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      conversationCount: 0,
      turnCount: 0,
      modelCallCount: 0,
      activeDays: 0,
      models: [],
      activity: []
    }),
    chatTraces: async () => [],
    chatRun: async (runId: string) => ({
      id: runId,
      threadId: 't',
      providerId: 'p',
      agentProfileId: null,
      runtimeSessionId: null,
      modelId: 'm',
      activeDocumentId: null,
      status: 'completed' as const,
      checkpointBefore: null,
      checkpointAfter: null,
      replacesRunId: null,
      userMessageId: null,
      assistantMessageId: null,
      startedAt: 0,
      endedAt: 0,
      error: null
    }),
    chatCancel: async () => mockResult<Awaited<ReturnType<ReforaApi['ai']['chatCancel']>>>(),
    chatResume: noop,
    chatPendingInterrupt: async () => null,
    chatDeleteThread: noop,
    renameThread: noop,
    workspaceMemories: async () => [],
    updateWorkspaceMemory: async () => mockResult<Awaited<ReturnType<ReforaApi['ai']['updateWorkspaceMemory']>>>(),
    deleteWorkspaceMemory: noop,
  },

  reports: {
    list: async () => [],
    update: async (id: string, patch: { title?: string; contentMd?: string }) => ({
      id,
      workspaceId: 'ws',
      title: patch.title ?? '',
      contentMd: patch.contentMd ?? '',
      sourceDocIds: [],
      model: null,
      createdAt: 0
    }),
    delete: noop,
  },

  events: {
    onRendererFlushRequested: (_cb: unknown) => noopDisposer,
    onDocumentUpdated: (_cb: unknown) => noopDisposer,
    onWindowFocusChanged: (_cb: unknown) => noopDisposer,
    onImportProgress: (_cb: unknown) => noopDisposer,
    onImportToast: (_cb: unknown) => noopDisposer,
    onMenuExportBibtex: (_cb: unknown) => noopDisposer,
    onMenuImportZotero: (_cb: unknown) => noopDisposer,
    onMenuImportMendeley: (_cb: unknown) => noopDisposer,
    onMenuImportIdentifier: (_cb: unknown) => noopDisposer,
    onLibrarySwitched: (_cb: unknown) => noopDisposer,
    onSyncAuthConfirmation: (_cb: unknown) => noopDisposer,
    onAiSummaryUpdated: (_cb: unknown) => noopDisposer,
    onAiSummaryError: (_cb: unknown) => noopDisposer,
    onAiReportCreated: (_cb: unknown) => noopDisposer,
    onWorkspaceItemsChanged: (_cb: unknown) => noopDisposer,
    onAiChatToken: (_cb: unknown) => noopDisposer,
    onAiChatReasoning: (_cb: unknown) => noopDisposer,
    onAiChatDone: (_cb: unknown) => noopDisposer,
    onAiChatError: (_cb: unknown) => noopDisposer,
    onAiChatTrace: (_cb: unknown) => noopDisposer,
    onAiChatInterrupted: (_cb: unknown) => noopDisposer,
    onAiChatRunStatus: (_cb: unknown) => noopDisposer,
    onAiChatTitleUpdated: (_cb: unknown) => noopDisposer,
    onMineruInstallProgress: (_cb: unknown) => noopDisposer,
    onOcrProgress: (_cb: unknown) => noopDisposer,
    onOcrCompleted: (_cb: unknown) => noopDisposer,
    onOcrError: (_cb: unknown) => noopDisposer,
  },
} satisfies ReforaApi)

window.api = createMockReforaApi()
