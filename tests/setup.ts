import '@testing-library/jest-dom/vitest'
import { vi } from 'vitest'

vi.mock('@emoji-mart/data', () => ({ default: {} }))
vi.mock('@emoji-mart/react', () => ({ default: () => null }))

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

;(window as Record<string, unknown>).api = {
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
    get: async () => null,
    update: noop,
    setStarred: noop,
    delete: noop,
    bulkDelete: noop,
    bulkCategorize: noop,
    bulkRefreshMetadata: noop,
    openPdf: noop,
    readPdfRange: async (_id: string, begin: number) => ({
      begin,
      fileSize: 1,
      data: new Uint8Array([1])
    }),
    pdfAnnotations: async () => [],
    setPdfAnnotations: async (_id: string, annotations: unknown[]) => annotations,
    openInFinder: noop,
    refreshMetadata: noop,
    relocateFile: noop,
    restoreFile: noop,
    previewUrl: (id: string, version: string | number) =>
      `refora-document://preview/${encodeURIComponent(id)}?v=${encodeURIComponent(String(version))}`,
  },

  search: {
    global: async () => ({ documents: [], workspaceFiles: [], chats: [] }),
  },

  import: {
    addFiles: async () => ({ added: [], skipped: [], errors: [] }),
    addFolder: async () => ({ added: [], skipped: [], errors: [] }),
    fromJson: async () => 0,
    fromZotero: async () => ({ added: 0, skipped: 0, errors: [] }),
    fromMendeley: async () => ({ added: 0, skipped: 0, errors: [] }),
    fromIdentifier: async () => ({ added: [] }),
  },

  categories: {
    list: async () => [],
    create: noop,
    rename: noop,
    delete: noop,
    assign: noop,
    unassign: noop,
  },

  watch: {
    list: async () => [],
    add: noop,
    remove: noop,
    toggle: noop,
  },

  settings: {
    get: async (_key: string, defaultValue: unknown) => defaultValue,
    set: noop,
  },

  sync: {
    status: async () => ({
      configured: false,
      syncAvailable: false,
      signedIn: false,
      enabled: false,
      state: 'unconfigured' as const,
      account: null,
    }),
    signIn: async () => ({
      configured: true,
      syncAvailable: false,
      signedIn: true,
      enabled: false,
      state: 'disabled' as const,
      account: { id: 'user-1', email: 'user@example.com' },
    }),
    signUp: async () => ({
      confirmationRequired: true,
      status: {
        configured: true,
        syncAvailable: false,
        signedIn: false,
        enabled: false,
        state: 'signedOut' as const,
        account: null,
      },
    }),
    resendConfirmation: noop,
    signOut: async () => ({
      configured: true,
      syncAvailable: false,
      signedIn: false,
      enabled: false,
      state: 'signedOut' as const,
      account: null,
    }),
    setEnabled: async (enabled: boolean) => ({
      configured: true,
      syncAvailable: false,
      signedIn: true,
      enabled,
      state: enabled ? 'ready' as const : 'disabled' as const,
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
    updateConfig: async (patch: { provider?: string }) => ({
      provider: patch.provider ?? 'disabled',
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
    chooseInstallRoot: noop,
    install: noop,
    cancelInstall: noop,
    uninstall: noop,
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
    start: noop,
    cancel: noop,
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
    toJson: async () => '',
    toBibtex: async () => '',
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

  workspaceNotes: {
    list: async () => [],
    create: async (workspaceId: string, title: string, contentMd: string, noteType: 'markdown' | 'plain') => ({
      id: 'note',
      workspaceId,
      noteType,
      title,
      contentMd,
      createdAt: 0,
      updatedAt: 0
    }),
    update: async (id: string, patch: { title?: string; contentMd?: string }) => ({
      id,
      workspaceId: 'ws',
      noteType: 'markdown' as const,
      title: patch.title ?? '',
      contentMd: patch.contentMd ?? '',
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
    create: async (input: { name: string; baseUrl: string; model: string }) => ({
      id: 'p',
      presetId: input.name === 'OpenAI' ? 'openai' : 'custom',
      name: input.name,
      baseUrl: input.baseUrl,
      apiProtocol: 'openai-compatible' as const,
      reasoningControl: 'openai' as const,
      reasoningEffort: 'medium' as const,
      model: input.model,
      baseModel: input.model,
      variant: '',
      variantFormat: 'dash' as const,
      hasKey: false,
      temperature: null,
      maxTokens: null,
      createdAt: 0
    }),
    update: async (id: string) => ({
      id,
      presetId: 'custom',
      name: '',
      baseUrl: '',
      apiProtocol: 'openai-compatible' as const,
      reasoningControl: 'openai' as const,
      reasoningEffort: 'medium' as const,
      model: '',
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
    create: async (input: {
      name: string
      cliRuntimeId: string
      executablePath?: string | null
      model?: string
      reasoningEffort?: string
      nativeWebSearch?: boolean
      webSearchPolicy?: string
    }) => ({
      id: 'cli-profile',
      name: input.name,
      kind: 'cli' as const,
      apiProviderId: null,
      cliRuntimeId: input.cliRuntimeId,
      executablePath: input.executablePath ?? null,
      model: input.model ?? 'default',
      reasoningEffort: input.reasoningEffort ?? 'medium',
      nativeWebSearch: input.nativeWebSearch ?? true,
      webSearchPolicy: input.webSearchPolicy ?? 'auto',
      createdAt: 0,
      updatedAt: 0
    }),
    update: async (id: string) => ({
      id,
      name: 'CLI',
      kind: 'cli' as const,
      apiProviderId: null,
      cliRuntimeId: 'codex',
      executablePath: null,
      model: 'default',
      reasoningEffort: 'medium' as const,
      nativeWebSearch: true,
      webSearchPolicy: 'auto' as const,
      createdAt: 0,
      updatedAt: 0
    }),
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
      modelId: 'm',
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
    chatCancel: noop,
    chatResume: noop,
    chatPendingInterrupt: async () => null,
    chatDeleteThread: noop,
    renameThread: noop,
    listMemories: async () => [],
    updateMemory: async () => ({
      id: 'memory',
      workspaceId: null,
      path: '/memory.md',
      value: '',
      createdAt: 0,
      updatedAt: 0
    }),
    deleteMemory: noop,
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
    onDocumentUpdated: (_cb: unknown) => undefined,
    onImportProgress: (_cb: unknown) => undefined,
    onImportToast: (_cb: unknown) => undefined,
    onMenuExportBibtex: (_cb: unknown) => undefined,
    onMenuImportZotero: (_cb: unknown) => undefined,
    onMenuImportMendeley: (_cb: unknown) => undefined,
    onMenuImportIdentifier: (_cb: unknown) => undefined,
    onLibraryScanning: (_cb: unknown) => undefined,
    onLibrarySwitched: (_cb: unknown) => undefined,
    onSyncAuthConfirmation: (_cb: unknown) => undefined,
    onAiSummaryUpdated: (_cb: unknown) => undefined,
    onAiSummaryError: (_cb: unknown) => undefined,
    onAiReportCreated: (_cb: unknown) => undefined,
    onWorkspaceItemsChanged: (_cb: unknown) => undefined,
    onAiChatToken: (_cb: unknown) => undefined,
    onAiChatReasoning: (_cb: unknown) => undefined,
    onAiChatDone: (_cb: unknown) => undefined,
    onAiChatError: (_cb: unknown) => undefined,
    onAiChatTrace: (_cb: unknown) => undefined,
    onAiChatInterrupted: (_cb: unknown) => undefined,
    onAiChatRunStatus: (_cb: unknown) => undefined,
    onAiChatTitleUpdated: (_cb: unknown) => undefined,
    onMineruInstallProgress: (_cb: unknown) => undefined,
    onOcrProgress: (_cb: unknown) => undefined,
    onOcrCompleted: (_cb: unknown) => undefined,
    onOcrError: (_cb: unknown) => undefined,
    off: (_channel: string, _cb: unknown) => undefined,
  },
}
