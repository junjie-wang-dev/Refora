import { app, BrowserWindow, Menu, shell, session, dialog, ipcMain, nativeImage, nativeTheme, net, protocol } from 'electron'
import { dirname, isAbsolute, join } from 'node:path'
import { createWriteStream, existsSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { initLogger, logger } from './services/logger'
import { createPdfTextService } from './services/pdfText'
import type { PdfTextService } from './services/pdfText'
import { removePdfPreviewCacheForDocument } from './services/pdfPreviewCache'
import { dbPathForLibraryFolder, dbExistsInLibraryFolder } from './services/dbPath'
import {
  adoptDatabaseForLibrary,
  createLibrarySnapshot,
  prepareLibraryDatabase,
  readLibraryFolderFromDatabase
} from './services/libraryDatabase'
import { createLibrarySnapshotPolicy } from './services/librarySnapshotPolicy'
import {
  readLibraryFolderPath,
  readPendingAuthConfirmation,
  writeLibraryFolderPath,
  writePendingAuthConfirmation
} from './services/prefs'
import { IpcChannel } from '../shared/ipc-channels'
import type { BootstrapData, LibrarySwitchResult, WindowBounds } from '../shared/ipc-types'
import { runMenuAction } from './services/menuAction'
import { createServerPythonRuntime } from './sidecar/runtime'
import type { ServerPythonRuntime } from './sidecar/runtime'
import { createServerLifecycle } from './sidecar/lifecycle'
import { createServerAssembly, type ServerAssembly } from './sidecar/assembly'
import {
  cleanupStaleServerStateDirectories,
  createServerStateDirectory
} from './sidecar/stateDirectory'
import { createSyncRuntime } from './services/syncRuntime'
import type { SyncAccountService } from './services/syncAccount'
import { createAuthConfirmationGuard } from './services/authDeepLink'
import type { SyncAuthConfirmation } from '../shared/sync-types'
import { createSyncHandlers } from './sidecar/ipc/sync'
import { createLibrarySwitcher } from './services/librarySwitcher'
import { createShutdownHandler } from './services/shutdown'
import { createRendererFlushCoordinator } from './services/rendererFlush'
import { activateAssemblySettings } from './services/assemblySettings'
import { createAppLifecycleIpcHandlers } from './services/appLifecycleIpc'
import { runPersistenceGuard, type PersistenceFailureAction } from './services/persistenceGuard'
import { createRendererPathCapabilities } from './services/fileCapabilities'
import { contentSecurityPolicy, isTrustedIpcSender, secureWebPreferences } from './services/webSecurity'
import { consumeDeepLinkArguments, handoffSecondInstance } from './services/instanceHandoff'
import { createLifecycleTransitionGate } from './services/lifecycleTransitionGate'

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'refora-asset',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
  },
  {
    scheme: 'refora-document',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
  }
])

const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) app.quit()

let isDev = false
const IS_MAC = process.platform === 'darwin'
let serverAssembly: ServerAssembly | null = null
let serverPythonRuntime: ServerPythonRuntime | null = null
let pdfTextService: PdfTextService | null = null
let syncAccountService: SyncAccountService | null = null
let activeDbPath = ''
let activeLibraryFolder = ''
let win: BrowserWindow | null = null
let pendingAuthConfirmation: SyncAuthConfirmation | null = null
let syncHandlerChannels: string[] = []
let syncTimer: ReturnType<typeof setInterval> | null = null
let snapshotTimer: ReturnType<typeof setInterval> | null = null
let menuLanguage: 'zh' | 'en' = 'en'
let flushWindowState: () => Promise<void> = async () => undefined
let allowWindowClose = false
const rendererPathCapabilities = createRendererPathCapabilities()
const rendererFlushCoordinator = createRendererFlushCoordinator()
const lifecycleTransitionGate = createLifecycleTransitionGate()
const librarySnapshotPolicy = createLibrarySnapshotPolicy({
  createSnapshot: (context, baseSequence) => createLibrarySnapshot({ ...context, baseSequence })
})
const appLifecycleIpcHandlers = createAppLifecycleIpcHandlers({
  completeRendererFlush: (requestId, error) =>
    rendererFlushCoordinator.complete(requestId, error)
})
const authConfirmationGuard = createAuthConfirmationGuard({
  readPending: () => readPendingAuthConfirmation(app.getPath('userData')),
  writePending: (pending) => writePendingAuthConfirmation(app.getPath('userData'), pending)
})

for (const [channel, handler] of Object.entries(appLifecycleIpcHandlers)) {
  ipcMain.handle(channel, (event, ...args) => {
    if (!isTrustedIpcSender(event, () => win)) {
      return {
        ok: false,
        error: { code: 'unauthorized_sender', message: 'IPC request did not originate from the main window' }
      }
    }
    return (handler as (...handlerArgs: unknown[]) => unknown)(...args)
  })
}

async function flushRendererState(target = win): Promise<void> {
  if (
    !target ||
    target.isDestroyed() ||
    target.webContents.isDestroyed() ||
    target.webContents.isLoadingMainFrame()
  ) return
  await rendererFlushCoordinator.request((requestId) => {
    target.webContents.send(IpcChannel.EventRendererFlushRequested, requestId)
  })
}

const MENU_COPY = {
  en: {
    file: 'File',
    addFile: 'Add File',
    addPdfFiles: 'Add PDF Files',
    pdfFiles: 'PDF Files',
    importIdentifier: 'Import by Identifier…',
    addFolder: 'Add Folder',
    importJson: 'Import JSON…',
    importJsonTitle: 'Import JSON',
    jsonFiles: 'JSON files',
    importMode: 'Import Mode',
    importModeMessage: 'How should the import handle existing data?',
    merge: 'Merge (keep existing, add new)',
    replace: 'Replace (clear all, import)',
    cancel: 'Cancel',
    importZotero: 'Import from Zotero…',
    importMendeley: 'Import from Mendeley…',
    exportJson: 'Export JSON…',
    exportJsonTitle: 'Export JSON',
    exportBibtex: 'Export BibTeX…',
    bibtexFiles: 'BibTeX files',
    selectFolder: 'Select Folder',
    failed: 'Failed',
    persistenceFailedTitle: 'Unsaved changes',
    persistenceFailedMessage: 'Some local changes could not be saved.',
    persistenceFailedDetail: 'Retry saving, cancel closing, or explicitly discard the unsaved changes.',
    retrySaving: 'Retry Saving',
    discardChanges: 'Discard Changes'
  },
  zh: {
    file: '文件',
    addFile: '添加文件',
    addPdfFiles: '添加 PDF 文件',
    pdfFiles: 'PDF 文件',
    importIdentifier: '从标识符导入…',
    addFolder: '添加文件夹',
    importJson: '导入 JSON…',
    importJsonTitle: '导入 JSON',
    jsonFiles: 'JSON 文件',
    importMode: '导入模式',
    importModeMessage: '如何处理已有数据？',
    merge: '合并（保留已有数据并添加新数据）',
    replace: '替换（清空后导入）',
    cancel: '取消',
    importZotero: '从 Zotero 导入…',
    importMendeley: '从 Mendeley 导入…',
    exportJson: '导出 JSON…',
    exportJsonTitle: '导出 JSON',
    exportBibtex: '导出 BibTeX…',
    bibtexFiles: 'BibTeX 文件',
    selectFolder: '选择文件夹',
    failed: '失败',
    persistenceFailedTitle: '存在未保存的更改',
    persistenceFailedMessage: '部分本地更改无法保存。',
    persistenceFailedDetail: '请选择重试保存、取消关闭，或明确放弃未保存的更改。',
    retrySaving: '重试保存',
    discardChanges: '放弃更改'
  }
} as const

async function resolvePersistenceFailure(error: unknown): Promise<PersistenceFailureAction> {
  const copy = MENU_COPY[menuLanguage]
  const message = error instanceof Error ? error.message : String(error)
  const options = {
    type: 'warning' as const,
    title: copy.persistenceFailedTitle,
    message: copy.persistenceFailedMessage,
    detail: `${copy.persistenceFailedDetail}\n\n${message}`,
    buttons: [copy.retrySaving, copy.cancel, copy.discardChanges],
    defaultId: 0,
    cancelId: 1,
    noLink: true
  }
  const result = win && !win.isDestroyed()
    ? await dialog.showMessageBox(win, options)
    : await dialog.showMessageBox(options)
  if (result.response === 0) return 'retry'
  if (result.response === 2) return 'discard'
  return 'cancel'
}

function registerSyncAccountHandlers(service: SyncAccountService): void {
  const handlers = createSyncHandlers(service)
  syncHandlerChannels = Object.keys(handlers)
  for (const [channel, handler] of Object.entries(handlers)) {
    ipcMain.handle(channel, (event, ...args) => {
      if (!isTrustedIpcSender(event, () => win)) {
        return {
          ok: false,
          error: { code: 'unauthorized_sender', message: 'IPC request did not originate from the main window' }
        }
      }
      return (handler as (...handlerArgs: unknown[]) => unknown)(...args)
    })
  }
}

function unregisterSyncAccountHandlers(): void {
  for (const channel of syncHandlerChannels) ipcMain.removeHandler(channel)
  syncHandlerChannels = []
}

async function runEnabledSync(): Promise<void> {
  const service = syncAccountService
  if (!service) return
  try {
    const status = await service.status()
    if (status.signedIn && status.library?.enabled && !status.library.running) {
      await service.runNow()
    }
  } catch (error) {
    logger.warn(`sync:background failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function syncBeforePersistence(): Promise<void> {
  const service = syncAccountService
  if (!service) return
  try {
    const status = await service.status()
    if (status.signedIn && status.library?.enabled) await service.runNow()
    else await service.waitForIdle()
  } catch (error) {
    logger.warn(`sync:persistence failed: ${error instanceof Error ? error.message : String(error)}`)
    await service.waitForIdle().catch(() => undefined)
  }
}

async function snapshotActiveLibraryIfChanged(): Promise<void> {
  if (!activeDbPath || !activeLibraryFolder) return
  try {
    await librarySnapshotPolicy.snapshotIfChanged({
      dbPath: activeDbPath,
      libraryFolder: activeLibraryFolder
    })
  } catch (error) {
    logger.warn(`snapshot:scheduled failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function deliverAuthConfirmation(): void {
  const target = win
  if (!pendingAuthConfirmation || !target || target.isDestroyed()) return
  if (target.webContents.isDestroyed() || target.webContents.isLoadingMainFrame()) return
  target.webContents.send(IpcChannel.EventSyncAuthConfirmation, pendingAuthConfirmation)
  pendingAuthConfirmation = null
  if (target.isMinimized()) target.restore()
  target.show()
  target.focus()
}

function handleAuthDeepLink(value: string): boolean {
  try {
    const confirmation = authConfirmationGuard.consume(value)
    if (!confirmation) return false
    pendingAuthConfirmation = confirmation
    deliverAuthConfirmation()
    return true
  } catch (error) {
    logger.error(`auth deep link rejected: ${error instanceof Error ? error.message : String(error)}`)
    return false
  }
}

if (hasSingleInstanceLock) {
  app.on('open-url', (event, url) => {
    if (!handleAuthDeepLink(url)) return
    event.preventDefault()
  })
  app.on('second-instance', (_event, argv) => {
    handoffSecondInstance(argv, handleAuthDeepLink, () => win)
  })
  consumeDeepLinkArguments(process.argv, handleAuthDeepLink)
}

function detectLanguage(): 'zh' | 'en' {
  try {
    const locale = app.getLocale().toLowerCase()
    return locale.startsWith('zh') ? 'zh' : 'en'
  } catch {
    return 'en'
  }
}

function reportMenuError(action: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  logger.error(`${action}: ${message}`)
  dialog.showErrorBox(`${action} ${MENU_COPY[menuLanguage].failed}`, message)
}

export async function persistWindowBounds(
  assembly: ServerAssembly | null,
  target: Pick<BrowserWindow, 'isDestroyed' | 'isMaximized' | 'getNormalBounds' | 'getBounds'>
): Promise<void> {
  if (!assembly || target.isDestroyed()) return
  const maximized = target.isMaximized()
  const bounds = maximized ? target.getNormalBounds() : target.getBounds()
  await assembly.getClient().http.settingsUpdate({
    windowBounds: {
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      isMaximized: maximized
    }
  })
}

function applyCsp(): void {
  const csp = contentSecurityPolicy(app.isPackaged)
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [csp]
      }
    })
  })
}

function registerWorkspaceAssetProtocol(): void {
  void protocol.handle('refora-asset', async (request) => {
    try {
      const url = new URL(request.url)
      const id = decodeURIComponent(url.pathname.replace(/^\//, ''))
      if (url.hostname !== 'asset' || !id || id.includes('/')) {
        return new Response('Not found', { status: 404 })
      }
      const assembly = serverAssembly
      if (!assembly) return new Response('Server unavailable', { status: 503 })
      const response = await assembly.fetchResource(
        `/workspace-assets/${encodeURIComponent(id)}/content`,
        request.headers
      )
      const headers = new Headers(response.headers)
      headers.set('X-Content-Type-Options', 'nosniff')
      return new Response(response.body, { status: response.status, headers })
    } catch {
      return new Response('Not found', { status: 404 })
    }
  })
}

function registerDocumentProtocol(): void {
  void protocol.handle('refora-document', async (request) => {
    try {
      const url = new URL(request.url)
      const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
      const assembly = serverAssembly
      if (!assembly) return new Response('Server unavailable', { status: 503 })
      if (url.hostname === 'preview' && parts.length === 1) {
        if (!pdfTextService) return new Response('Preview unavailable', { status: 503 })
        const document = await assembly.getClient().http.documentsGet(parts[0])
        if (!activeDbPath) {
          return new Response('Library unavailable', { status: 503 })
        }
        const png = await pdfTextService.getPreviewForDocument(document, dirname(activeDbPath))
        return new Response(new Uint8Array(png), {
          headers: {
            'Cache-Control': 'no-store',
            'Content-Type': 'image/png',
            'X-Content-Type-Options': 'nosniff'
          }
        })
      }
      if (url.hostname !== 'ocr' || parts.length < 4 || parts[2] !== 'assets') {
        return new Response('Not found', { status: 404 })
      }
      const response = await assembly.fetchResource(
        `/ocr/documents/${encodeURIComponent(parts[0])}/results/${encodeURIComponent(parts[1])}/assets/${parts
          .slice(3)
          .map(encodeURIComponent)
          .join('/')}`,
        request.headers
      )
      const headers = new Headers(response.headers)
      headers.set('X-Content-Type-Options', 'nosniff')
      return new Response(response.body, { status: response.status, headers })
    } catch (error) {
      logger.warn(
        `document-protocol:failed url=${request.url}: ${error instanceof Error ? error.message : String(error)}`
      )
      return new Response('Not found', { status: 404 })
    }
  })
}

function buildMenu(language: 'zh' | 'en' = menuLanguage): Menu {
  const copy = MENU_COPY[language]
  const getWin = (): BrowserWindow | null => (win && !win.isDestroyed() ? win : null)
  const template: Electron.MenuItemConstructorOptions[] = [
    { role: 'appMenu' },
    {
      label: copy.file,
      submenu: [
        {
          label: copy.addFile,
          accelerator: 'Cmd+I',
          click: () => {
            void runMenuAction(async () => {
              const w = getWin()
              const assembly = serverAssembly
              if (!w || !assembly) return
              const result = await dialog.showOpenDialog(w, {
                title: copy.addPdfFiles,
                properties: ['openFile', 'multiSelections'],
                filters: [{ name: copy.pdfFiles, extensions: ['pdf'] }]
              })
              if (result.canceled) return
              await assembly.getClient().http.importFiles({ paths: result.filePaths })
            }, (error) => reportMenuError(copy.addFile, error))
          }
        },
        {
          label: copy.importIdentifier,
          accelerator: 'Cmd+Shift+I',
          click: () => {
            const w = getWin()
            if (w && !w.isDestroyed()) {
              w.webContents.send(IpcChannel.EventMenuImportIdentifier)
            }
          }
        },
        {
          label: copy.addFolder,
          click: () => {
            void runMenuAction(async () => {
              const w = getWin()
              const assembly = serverAssembly
              if (!w || !assembly) return
              const result = await dialog.showOpenDialog(w, {
                title: copy.addFolder,
                properties: ['openDirectory']
              })
              if (result.canceled) return
              await assembly.getClient().http.importFolder({
                path: result.filePaths[0],
                recursive: true
              })
            }, (error) => reportMenuError(copy.addFolder, error))
          }
        },
        { type: 'separator' },
        {
          label: copy.importJson,
          click: () => {
            void runMenuAction(async () => {
              const w = getWin()
              const assembly = serverAssembly
              if (!w || !assembly) return
              const result = await dialog.showOpenDialog(w, {
                title: copy.importJsonTitle,
                properties: ['openFile'],
                filters: [{ name: copy.jsonFiles, extensions: ['json'] }]
              })
              if (result.canceled || result.filePaths.length === 0) return
              const modeChoice = await dialog.showMessageBox(w, {
                type: 'question',
                title: copy.importMode,
                message: copy.importModeMessage,
                buttons: [copy.merge, copy.replace, copy.cancel],
                defaultId: 0,
                cancelId: 2
              })
              if (modeChoice.response === 2) return
              const mode = modeChoice.response === 1 ? 'replace' : 'merge'
              const imported = await assembly.getClient().http.importJson({
                path: result.filePaths[0],
                mode
              })
              logger.info(`import:json ${imported.imported} documents`)
            }, (error) => reportMenuError(copy.importJsonTitle, error))
          }
        },
        { type: 'separator' },
        {
          label: copy.importZotero,
          click: () => {
            const w = getWin()
            if (w && !w.isDestroyed()) w.webContents.send(IpcChannel.EventMenuImportZotero)
          }
        },
        {
          label: copy.importMendeley,
          click: () => {
            const w = getWin()
            if (w && !w.isDestroyed()) w.webContents.send(IpcChannel.EventMenuImportMendeley)
          }
        },
        { type: 'separator' },
        {
          label: copy.exportJson,
          accelerator: 'Cmd+E',
          click: () => {
            void runMenuAction(async () => {
              const w = getWin()
              const assembly = serverAssembly
              if (!w || !assembly) return
              const result = await dialog.showSaveDialog(w, {
                title: copy.exportJsonTitle,
                defaultPath: `refora-export-${new Date().toISOString().slice(0, 10)}.json`,
                filters: [{ name: copy.jsonFiles, extensions: ['json'] }]
              })
              if (result.canceled || !result.filePath) return
              const payload = await assembly.getClient().http.exportJson({})
              writeFileSync(result.filePath, JSON.stringify(payload, null, 2), 'utf8')
            }, (error) => reportMenuError(copy.exportJsonTitle, error))
          }
        },
        {
          label: copy.exportBibtex,
          accelerator: 'Cmd+Shift+B',
          click: () => {
            const w = getWin()
            if (w) {
              w.webContents.send(IpcChannel.EventMenuExportBibtex)
            }
          }
        }
      ]
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    { role: 'help', submenu: [] }
  ]
  return Menu.buildFromTemplate(template)
}

function createWindow(bounds?: WindowBounds | null): BrowserWindow {
  const bw = new BrowserWindow({
    x: bounds?.x,
    y: bounds?.y,
    width: bounds?.width ?? 1280,
    height: bounds?.height ?? 800,
    minWidth: 800,
    minHeight: 500,
    backgroundColor: IS_MAC ? '#00000000' : '#1e1e1e',
    show: false,
    title: 'Refora',
    ...(IS_MAC && {
      acceptFirstMouse: true,
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 22, y: 22 },
      vibrancy: 'header',
      visualEffectState: 'followWindow'
    }),
    webPreferences: secureWebPreferences(join(__dirname, '../preload/index.js'))
  })

  const sendWindowFocus = (focused: boolean) => {
    if (!bw.isDestroyed() && !bw.webContents.isDestroyed()) {
      bw.webContents.send(IpcChannel.EventWindowFocusChanged, focused)
    }
  }

  let initialWindowStateApplied = false
  bw.webContents.on('did-finish-load', () => {
    if (!initialWindowStateApplied) {
      initialWindowStateApplied = true
      if (bounds?.isMaximized) bw.maximize()
    }
    bw.show()
    sendWindowFocus(bw.isFocused())
    deliverAuthConfirmation()
  })
  bw.on('focus', () => sendWindowFocus(true))
  bw.on('blur', () => sendWindowFocus(false))

  let saveBoundsTimeout: ReturnType<typeof setTimeout> | null = null
  let closeFlushInProgress = false
  let closeAfterFlush = false
  const saveBounds = async (): Promise<void> => {
    await persistWindowBounds(serverAssembly, bw)
  }
  const saveBoundsBestEffort = (): void => {
    void saveBounds().catch((error) => {
      logger.warn(`saveBounds: ${error instanceof Error ? error.message : String(error)}`)
    })
  }
  flushWindowState = saveBounds
  const debouncedSaveBounds = () => {
    if (saveBoundsTimeout) clearTimeout(saveBoundsTimeout)
    saveBoundsTimeout = setTimeout(saveBoundsBestEffort, 500)
  }

  bw.on('resize', debouncedSaveBounds)
  bw.on('move', debouncedSaveBounds)
  bw.on('close', (event) => {
    if (saveBoundsTimeout) {
      clearTimeout(saveBoundsTimeout)
      saveBoundsTimeout = null
    }
    if (allowWindowClose || closeAfterFlush) {
      saveBoundsBestEffort()
      return
    }
    event.preventDefault()
    if (closeFlushInProgress) return
    closeFlushInProgress = true
    void runPersistenceGuard({
      persist: async () => {
        await Promise.all([saveBounds(), flushRendererState(bw)])
      },
      resolveFailure: async (error) => {
        logger.error(
          `window close blocked because renderer state could not be saved: ${error instanceof Error ? error.message : String(error)}`
        )
        return resolvePersistenceFailure(error)
      }
    })
      .then((result) => {
        if (result === 'cancelled') return
        closeAfterFlush = true
        bw.close()
      })
      .catch((error) => {
        logger.error(
          `window close persistence prompt failed: ${error instanceof Error ? error.message : String(error)}`
        )
      })
      .finally(() => {
        closeFlushInProgress = false
      })
  })
  bw.on('closed', () => {
    rendererFlushCoordinator.cancel()
    if (flushWindowState === saveBounds) flushWindowState = async () => undefined
  })

  bw.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const parsed = new URL(url)
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        void shell.openExternal(url)
      }
    } catch {
      void url
    }
    return { action: 'deny' }
  })

  bw.webContents.on('will-navigate', (e) => {
    e.preventDefault()
  })

  if (isDev && process.env['ELECTRON_RENDERER_URL']) {
    void bw.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void bw.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return bw
}
async function resolveStartupLibrary(): Promise<{ dbPath: string; libraryFolder: string }> {
  const userDataDir = app.getPath('userData')

  const prefsLibrary = readLibraryFolderPath(userDataDir)
  if (prefsLibrary) {
    let libraryFolder = ''
    try {
      libraryFolder = realpathSync(prefsLibrary)
      if (!statSync(libraryFolder).isDirectory()) throw new Error('not a directory')
    } catch {
      logger.warn(`db:startup prefs library folder invalid, clearing prefs: ${prefsLibrary}`)
      writeLibraryFolderPath(userDataDir, '')
    }
    if (libraryFolder) {
      logger.info(
        dbExistsInLibraryFolder(userDataDir, libraryFolder)
          ? `db:startup using library db (prefs) at ${libraryFolder}`
          : `db:startup creating library db (prefs) at ${libraryFolder}`
      )
      const prepared = await prepareLibraryDatabase(userDataDir, libraryFolder)
      return { dbPath: prepared.dbPath, libraryFolder }
    }
  }

  const prepared = await prepareLibraryDatabase(userDataDir, '')
  const storedLibrary = readLibraryFolderFromDatabase(prepared.dbPath)
  if (storedLibrary) {
    try {
      const libraryFolder = realpathSync(storedLibrary)
      if (!statSync(libraryFolder).isDirectory()) throw new Error('not a directory')
      const adopted = await adoptDatabaseForLibrary(
        userDataDir,
        libraryFolder,
        prepared.dbPath
      )
      writeLibraryFolderPath(userDataDir, libraryFolder)
      return { dbPath: adopted.dbPath, libraryFolder }
    } catch {
      logger.warn(`db:startup ignored invalid stored library folder: ${storedLibrary}`)
    }
  }
  return { dbPath: prepared.dbPath, libraryFolder: '' }
}
async function createPythonServerAssembly(
  dbPath: string,
  libraryFolder: string,
  switchLibraryFolder: (folder: string) => Promise<LibrarySwitchResult>
): Promise<ServerAssembly> {
  if (!serverPythonRuntime) throw new Error('Python runtime is not ready')
  const serverExecutable = app.isPackaged
    ? join(process.resourcesPath, 'python-server', 'refora-server')
    : undefined
  const serverPython = app.isPackaged
    ? undefined
    : await (async () => {
        const configured = process.env['REFORA_SERVER_PYTHON_PATH']
        if (!configured) {
          return serverPythonRuntime.install(new AbortController().signal)
        }
        if (!isAbsolute(configured) || !existsSync(configured) || !statSync(configured).isFile()) {
          throw new Error('REFORA_SERVER_PYTHON_PATH must reference an absolute Python executable')
        }
        return configured
      })()
  const serverSourceRoot = join(__dirname, '../../backend')
  const userDataDir = app.getPath('userData')
  cleanupStaleServerStateDirectories(userDataDir)
  const serverState = createServerStateDirectory(userDataDir)
  const assembly = createServerAssembly({
    lifecycle: createServerLifecycle({
      pythonPath: serverPython,
      serverModule: app.isPackaged ? undefined : 'refora_server.server.run',
      executablePath: serverExecutable,
      stateDir: serverState.path,
      userDataDir,
      dbPath,
      libraryFolder,
      language: detectLanguage(),
      parentPid: process.pid,
      onChildSpawned: serverState.setChildPid,
      environment: {
        ...process.env,
        PYTHONNOUSERSITE: '1',
        ...(app.isPackaged ? {} : { PYTHONPATH: serverSourceRoot }),
        REFORA_MINERU_WORKER_PATH: app.isPackaged
          ? join(process.resourcesPath, 'mineru', 'mineru_worker.py')
          : join(__dirname, '../../backend/workers/mineru_worker.py')
      }
    }),
    getWin: () => win,
    nativeManagedRoots: [libraryFolder, app.getPath('userData')],
    rendererPathCapabilities,
    openDirectory: async () => {
      const target = win
      const options = {
        title: MENU_COPY[menuLanguage].selectFolder,
        properties: ['openDirectory', 'createDirectory'] as Array<'openDirectory' | 'createDirectory'>
      }
      const result = target && !target.isDestroyed()
        ? await dialog.showOpenDialog(target, options)
        : await dialog.showOpenDialog(options)
      return result.canceled ? null : result.filePaths[0] ?? null
    },
    saveBibtex: async (bibtex) => {
      const target = win
      const copy = MENU_COPY[menuLanguage]
      const options = {
        title: copy.exportBibtex,
        defaultPath: `refora-export-${new Date().toISOString().slice(0, 10)}.bib`,
        filters: [{ name: copy.bibtexFiles, extensions: ['bib'] }]
      }
      const result = target && !target.isDestroyed()
        ? await dialog.showSaveDialog(target, options)
        : await dialog.showSaveDialog(options)
      if (!result.canceled && result.filePath) writeFileSync(result.filePath, bibtex, 'utf8')
    },
    removeDocumentPreviewCache: async (documentId) => {
      const currentDbPath = dbPath || activeDbPath
      if (!currentDbPath) return
      try {
        if (pdfTextService) {
          await pdfTextService.removePreviewCacheForDocument(documentId, dirname(currentDbPath))
        } else {
          await removePdfPreviewCacheForDocument(dirname(currentDbPath), documentId)
        }
      } catch (error) {
        logger.warn(
          `pdf-preview-cache:cleanup failed document=${documentId}: ${error instanceof Error ? error.message : String(error)}`
        )
      }
    },
    switchLibraryFolder,
    onSettingUpdated: (key, value) => {
      if (key !== 'language' || (value !== 'zh' && value !== 'en')) return
      menuLanguage = value
      Menu.setApplicationMenu(buildMenu(value))
    }
  })
  return {
    start: async () => {
      try {
        await assembly.start()
      } catch (error) {
        serverState.cleanup()
        throw error
      }
    },
    stop: async () => {
      try {
        await assembly.stop()
      } finally {
        serverState.cleanup()
      }
    },
    getClient: () => assembly.getClient(),
    fetchResource: (path, headers) => assembly.fetchResource(path, headers),
    addNativeManagedRoot: (path) => assembly.addNativeManagedRoot(path)
  }
}

async function activatePythonServerAssembly(assembly: ServerAssembly): Promise<BootstrapData> {
  const bootstrap = await activateAssemblySettings({
    assembly,
    setProxy: (proxyRules) => session.defaultSession.setProxy({ proxyRules }),
    setLanguage: (language) => {
      menuLanguage = language
      Menu.setApplicationMenu(buildMenu(language))
    },
    setTheme: (theme) => {
      nativeTheme.themeSource = theme
    }
  })
  return bootstrap
}

const switchLibraryFolder = createLibrarySwitcher({
  resolveFolder: realpathSync,
  isDirectory: (folder) => {
    try {
      return existsSync(folder) && statSync(folder).isDirectory()
    } catch {
      return false
    }
  },
  dbPathForFolder: (folder) => dbPathForLibraryFolder(app.getPath('userData'), folder),
  dbExistsInFolder: (folder) => dbExistsInLibraryFolder(app.getPath('userData'), folder),
  prepareDatabase: (folder) => prepareLibraryDatabase(app.getPath('userData'), folder),
  createAssembly: (dbPath, libraryFolder) =>
    createPythonServerAssembly(dbPath, libraryFolder, switchLibraryFolderPython),
  beforeSwitch: async () => {
    await flushRendererState()
    await syncBeforePersistence()
  },
  snapshotCurrent: async (state) => {
    if (!state.dbPath || !state.libraryFolder) return
    try {
      await librarySnapshotPolicy.snapshotNow({
        dbPath: state.dbPath,
        libraryFolder: state.libraryFolder
      })
    } catch (error) {
      logger.warn(`snapshot:switch failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  },
  activateAssembly: async (assembly) => {
    await activatePythonServerAssembly(assembly)
  },
  getState: () => ({
    assembly: serverAssembly,
    dbPath: activeDbPath,
    libraryFolder: activeLibraryFolder
  }),
  setState: (state) => {
    serverAssembly = state.assembly
    activeDbPath = state.dbPath
    activeLibraryFolder = state.libraryFolder
  },
  persistLibraryFolder: (folder) => writeLibraryFolderPath(app.getPath('userData'), folder),
  emitSwitched: (result) => {
    if (win && !win.isDestroyed()) {
      win.webContents.send(IpcChannel.EventLibrarySwitched, result)
    }
    void runEnabledSync()
  },
  onRecoveryFailed: (error) => {
    logger.error(`library recovery failed: ${error instanceof Error ? error.message : String(error)}`)
    if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.reload()
    }
  }
})

const switchLibraryFolderPython = (folder: string): Promise<LibrarySwitchResult> =>
  lifecycleTransitionGate.run(() => switchLibraryFolder(folder))

if (hasSingleInstanceLock) void app.whenReady().then(async () => {
  isDev = !app.isPackaged
  menuLanguage = detectLanguage()
  initLogger()
  logger.info(`app:ready (dev=${isDev})`)
  if (app.isPackaged) app.setAsDefaultProtocolClient('refora')
  applyCsp()

  serverPythonRuntime = createServerPythonRuntime({
    userDataDir: app.getPath('userData'),
    projectPath: join(__dirname, '../../backend/pyproject.toml'),
    downloadFile: async (url, destination, signal) => {
      const response = await net.fetch(url, { signal })
      if (!response.ok) throw new Error(`Runtime download failed with HTTP ${response.status}`)
      if (!response.body) throw new Error('Runtime download returned an empty response')
      await pipeline(
        Readable.fromWeb(response.body as import('node:stream/web').ReadableStream<Uint8Array>),
        createWriteStream(destination, { mode: 0o600 }),
        { signal }
      )
    }
  })
  pdfTextService = createPdfTextService()
  syncAccountService = createSyncRuntime({
    userDataDir: app.getPath('userData'),
    fetch: (input, init) => net.fetch(input, init),
    issueConfirmationRedirect: () => authConfirmationGuard.issue(),
    getLibrary: () => activeDbPath && activeLibraryFolder
      ? { dbPath: activeDbPath, libraryFolder: activeLibraryFolder }
      : null,
    createSnapshot: async (context, baseSequence) => {
      await librarySnapshotPolicy.snapshotNow(context, baseSequence)
    },
    onRemoteApplied: (context) => {
      if (
        !win
        || win.isDestroyed()
        || !activeLibraryFolder
        || context.dbPath !== activeDbPath
      ) return
      win.webContents.send(IpcChannel.EventLibrarySwitched, {
        libraryFolderPath: activeLibraryFolder,
        dbExisted: true,
        scanned: 0,
        imported: 0,
        skipped: 0,
        errors: []
      } satisfies LibrarySwitchResult)
    }
  })
  registerSyncAccountHandlers(syncAccountService)

  if (isDev) {
    const devIconPath = join(__dirname, '../../build/icon.png')
    if (existsSync(devIconPath)) {
      app.dock?.setIcon(nativeImage.createFromPath(devIconPath))
    }
  }

  const { dbPath, libraryFolder } = await resolveStartupLibrary()
  activeDbPath = dbPath
  activeLibraryFolder = libraryFolder
  registerWorkspaceAssetProtocol()
  registerDocumentProtocol()
  let savedBounds: WindowBounds | null = null
  try {
    serverAssembly = await createPythonServerAssembly(
      dbPath,
      libraryFolder,
      switchLibraryFolderPython
    )
    await serverAssembly.start()
    const bootstrap = await activatePythonServerAssembly(serverAssembly)
    if (bootstrap.libraryFolderPath) {
      try {
        const resolvedLibraryFolder = realpathSync(bootstrap.libraryFolderPath)
        if (!statSync(resolvedLibraryFolder).isDirectory()) throw new Error('not a directory')
        activeLibraryFolder = resolvedLibraryFolder
        activeDbPath = dbPathForLibraryFolder(app.getPath('userData'), activeLibraryFolder)
        writeLibraryFolderPath(app.getPath('userData'), activeLibraryFolder)
      } catch {
        logger.warn(`db:bootstrap ignored invalid library folder: ${bootstrap.libraryFolderPath}`)
      }
    }
    savedBounds = bootstrap.windowBounds
    void runEnabledSync()
  } catch (error) {
    logger.error(`local library startup failed: ${error instanceof Error ? error.message : String(error)}`)
    const failedAssembly = serverAssembly
    serverAssembly = null
    await failedAssembly?.stop().catch(() => undefined)
  }
  win = createWindow(savedBounds)

  Menu.setApplicationMenu(buildMenu(menuLanguage))
  syncTimer = setInterval(() => void runEnabledSync(), 5 * 60 * 1000)
  snapshotTimer = setInterval(() => void snapshotActiveLibraryIfChanged(), 30 * 60 * 1000)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      win = createWindow()
    }
  })
}).catch((e) => {
  logger.error(`startup failed: ${e instanceof Error ? e.message : String(e)}`)
  app.quit()
})

const handleBeforeQuit = createShutdownHandler({
  beginShutdown: () => lifecycleTransitionGate.beginShutdown(),
  cancelShutdown: () => lifecycleTransitionGate.cancelShutdown(),
  waitForTransitions: () => lifecycleTransitionGate.waitForIdle(),
  flushWindowState: () => flushWindowState(),
  flushRendererState: () => flushRendererState(),
  unregisterHandlers: unregisterSyncAccountHandlers,
  stopServices: async () => {
    await syncBeforePersistence()
    const assembly = serverAssembly
    serverAssembly = null
    let stopError: unknown = null
    try {
      await assembly?.stop()
    } catch (error) {
      stopError = error
    }
    if (activeDbPath && activeLibraryFolder) {
      try {
        await librarySnapshotPolicy.snapshotNow({
          dbPath: activeDbPath,
          libraryFolder: activeLibraryFolder
        })
      } catch (error) {
        logger.warn(`snapshot:shutdown failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    if (stopError) throw stopError
  },
  destroyRuntimes: () => {
    if (syncTimer) clearInterval(syncTimer)
    syncTimer = null
    if (snapshotTimer) clearInterval(snapshotTimer)
    snapshotTimer = null
    pdfTextService?.destroy()
    pdfTextService = null
    serverPythonRuntime?.destroy()
    serverPythonRuntime = null
    win = null
  },
  quit: () => {
    allowWindowClose = true
    app.quit()
  },
  reportError: (error) => {
    logger.error(`shutdown failed: ${error instanceof Error ? error.message : String(error)}`)
  },
  resolvePersistenceFailure
})

if (hasSingleInstanceLock) {
  app.on('before-quit', handleBeforeQuit)
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit()
    }
  })
}
