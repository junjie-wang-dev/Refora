import { app, BrowserWindow, Menu, shell, session, dialog, nativeImage, net, protocol } from 'electron'
import { join, resolve as resolvePath } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createWriteStream, existsSync, mkdirSync, statSync } from 'node:fs'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { initLogger, logger } from './services/logger'
import { openDatabase, seedSettings, closeDatabase, getSetting, getSearchMode } from './db/connection'
import { createRepositories } from './db/repositories'
import { RepoError } from './db/repositories/errors'
import { createImporter } from './services/importer'
import { createMetadataService } from './services/metadata'
import { createWatcher } from './services/watcher'
import { createPdfTextService } from './services/pdfText'
import type { PdfTextService } from './services/pdfText'
import { checkMissing, findPdfsRecursively } from './services/files'
import { writeExportFile, importFromJsonFile } from './services/export'
import { emitLibraryScanning, emitLibrarySwitched } from './ipc/events'
import { dbPathForLibraryFolder, dbExistsInLibraryFolder, DB_FILE_NAME } from './db/dbPath'
import { readLibraryFolderPath, writeLibraryFolderPath } from './services/prefs'
import { IpcChannel } from '../shared/ipc-channels'
import type { LibrarySwitchResult } from '../shared/ipc-types'
import { createExclusiveTask } from './services/exclusiveTask'
import { runMenuAction } from './services/menuAction'
import { prepareReplacement } from './services/resourceReplacement'
import { requireWorkspaceAssetFile } from './services/workspaceAssets'
import { isInsideLibrary } from './services/paths'
import { createMineruEngineManager } from './services/mineruEngineManager'
import type { MineruEngineManager } from './services/mineruEngineManager'
import { createMineruWorkerProcess } from './services/mineruWorkerProcess'
import type { MineruWorkerProcess } from './services/mineruWorkerProcess'
import { createMineruDocumentService } from './services/mineruDocumentService'
import type { MineruDocumentService } from './services/mineruDocumentService'
import { createAgentPythonRuntime } from './services/agentPythonRuntime'
import type { AgentPythonRuntime } from './services/agentPythonRuntime'
import {
  activeDuplicateFiles,
  duplicateFileFingerprint,
  libraryDocumentSignature,
  normalizedLibraryFileKey,
  sameDuplicateFingerprint,
  type LibraryDuplicateFileCache
} from './services/libraryDuplicateCache'
import { createServerLifecycle } from './services/serverLifecycle'
import { createServerAssembly, type ServerAssembly } from './serverAssembly'
import { createLibraryHandoff } from './services/libraryHandoff'

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

let isDev = false
const IS_MAC = process.platform === 'darwin'
const LIBRARY_DUPLICATE_CACHE_KEY = 'libraryDuplicateFileCache'
let serverAssembly: ServerAssembly | null = null

type DbConnection = ReturnType<typeof openDatabase>
interface Runtime {
  db: DbConnection
  repos: ReturnType<typeof createRepositories>
  importer: ReturnType<typeof createImporter>
  metadataService: ReturnType<typeof createMetadataService>
  watcher: ReturnType<typeof createWatcher>
  missingCheckInterval: ReturnType<typeof setInterval> | null
  missingCheckAbort: AbortController
  activated: boolean
  pdfTextService: PdfTextService
  mineruWorker: MineruWorkerProcess
  mineruDocumentService: MineruDocumentService
  agentPythonRuntime: AgentPythonRuntime
}
let runtime: Runtime | null = null
let mineruEngineManager: MineruEngineManager | null = null
let win: BrowserWindow | null = null
let isQuitting = false

function validateProxyUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return (
      parsed.protocol === 'http:' ||
      parsed.protocol === 'https:' ||
      parsed.protocol === 'socks5:'
    )
  } catch {
    return false
  }
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
  dialog.showErrorBox(`${action} Failed`, message)
}

function applyCsp(): void {
  const prod =
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: refora-asset: refora-document:; media-src 'self' refora-asset:; connect-src 'self'"
  const dev =
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: refora-asset: refora-document:; media-src 'self' refora-asset:; connect-src 'self' ws://localhost:*"
  const csp = app.isPackaged ? prod : dev
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
      const current = runtime
      if (!current) return new Response('Runtime unavailable', { status: 503 })
      const { asset, filePath } = requireWorkspaceAssetFile(current.repos, id)
      if (asset.previewKind !== 'image' && asset.previewKind !== 'audio' && asset.previewKind !== 'video') {
        return new Response('Preview not supported', { status: 415 })
      }
      const response = await net.fetch(pathToFileURL(filePath).toString(), {
        headers: request.headers,
        bypassCustomProtocolHandlers: true
      })
      const headers = new Headers(response.headers)
      headers.set('Content-Type', asset.mimeType)
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
      const current = runtime
      if (!current) return new Response('Runtime unavailable', { status: 503 })
      if (url.hostname === 'preview' && parts.length === 1) {
        const png = await current.pdfTextService.getPreview(parts[0])
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
      const filePath = await current.mineruDocumentService.resolveAsset(
        parts[0],
        parts[1],
        parts.slice(2).join('/')
      )
      const response = await net.fetch(pathToFileURL(filePath).toString(), {
        headers: request.headers,
        bypassCustomProtocolHandlers: true
      })
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

function buildMenu(): Menu {
  const getWin = (): BrowserWindow | null => (win && !win.isDestroyed() ? win : null)
  const template: Electron.MenuItemConstructorOptions[] = [
    { role: 'appMenu' },
    {
      label: 'File',
      submenu: [
        {
          label: 'Add File',
          accelerator: 'Cmd+I',
          click: async () => {
            const w = getWin()
            if (!w || !runtime) return
            const result = await dialog.showOpenDialog(w, {
              title: 'Add PDF Files',
              properties: ['openFile', 'multiSelections'],
              filters: [{ name: 'PDF Files', extensions: ['pdf'] }]
            })
            if (result.canceled) return
            void runtime.importer.importFiles(result.filePaths, false)
          }
        },
        {
          label: 'Import by Identifier…',
          accelerator: 'Cmd+Shift+I',
          click: () => {
            const w = getWin()
            if (w && !w.isDestroyed()) {
              w.webContents.send('menu:import-identifier')
            }
          }
        },
        {
          label: 'Add Folder',
          click: () => {
            void runMenuAction(async () => {
              const w = getWin()
              const current = runtime
              if (!w || !current) return
              const result = await dialog.showOpenDialog(w, {
                title: 'Add Folder',
                properties: ['openDirectory']
              })
              if (result.canceled) return
              const dir = result.filePaths[0]
              const pdfs = await findPdfsRecursively(dir)
              await current.importer.importFiles(pdfs, false)
            }, (error) => reportMenuError('add folder', error))
          }
        },
        { type: 'separator' },
        {
          label: 'Import JSON\u2026',
          click: () => {
            void runMenuAction(async () => {
              const w = getWin()
              const current = runtime
              if (!w || !current) return
              const result = await dialog.showOpenDialog(w, {
                title: 'Import JSON',
                properties: ['openFile'],
                filters: [{ name: 'JSON files', extensions: ['json'] }]
              })
              if (result.canceled || result.filePaths.length === 0) return
              const modeChoice = await dialog.showMessageBox(w, {
                type: 'question',
                title: 'Import Mode',
                message: 'How should the import handle existing data?',
                buttons: ['Merge (keep existing, add new)', 'Replace (clear all, import)', 'Cancel'],
                defaultId: 0,
                cancelId: 2
              })
              if (modeChoice.response === 2) return
              const mode = modeChoice.response === 1 ? 'replace' : 'merge'
              const count = importFromJsonFile(current.repos, result.filePaths[0], mode, current.db)
              logger.info(`import:json ${count} documents`)
            }, (error) => reportMenuError('Import JSON', error))
          }
        },
        { type: 'separator' },
        {
          label: 'Import from Zotero\u2026',
          click: () => {
            const w = getWin()
            if (w && !w.isDestroyed()) w.webContents.send('menu:import-zotero')
          }
        },
        {
          label: 'Import from Mendeley\u2026',
          click: () => {
            const w = getWin()
            if (w && !w.isDestroyed()) w.webContents.send('menu:import-mendeley')
          }
        },
        { type: 'separator' },
        {
          label: 'Export JSON\u2026',
          accelerator: 'Cmd+E',
          click: () => {
            void runMenuAction(async () => {
              const w = getWin()
              const current = runtime
              if (!w || !current) return
              const result = await dialog.showSaveDialog(w, {
                title: 'Export JSON',
                defaultPath: `refora-export-${new Date().toISOString().slice(0, 10)}.json`,
                filters: [{ name: 'JSON files', extensions: ['json'] }]
              })
              if (result.canceled || !result.filePath) return
              writeExportFile(current.repos, result.filePath)
            }, (error) => reportMenuError('Export JSON', error))
          }
        },
        {
          label: 'Export BibTeX\u2026',
          accelerator: 'Cmd+Shift+B',
          click: () => {
            const w = getWin()
            if (w) {
              w.webContents.send('menu:export-bibtex')
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

function createWindow(bounds?: { x?: number; y?: number; width?: number; height?: number } | null): BrowserWindow {
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
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  const sendWindowFocus = (focused: boolean) => {
    if (!bw.isDestroyed() && !bw.webContents.isDestroyed()) {
      bw.webContents.send(IpcChannel.EventWindowFocusChanged, focused)
    }
  }

  bw.webContents.on('did-finish-load', () => {
    bw.show()
    sendWindowFocus(bw.isFocused())
  })
  bw.on('focus', () => sendWindowFocus(true))
  bw.on('blur', () => sendWindowFocus(false))

  let saveBoundsTimeout: ReturnType<typeof setTimeout> | null = null
  const saveBounds = () => {
    if (!runtime || isQuitting || bw.isDestroyed()) return
    try {
      const bounds = bw.getBounds()
      runtime.repos.settings.set('windowBounds', {
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
        isMaximized: bw.isMaximized()
      })
    } catch (e) {
      logger.warn(`saveBounds: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  const debouncedSaveBounds = () => {
    if (saveBoundsTimeout) clearTimeout(saveBoundsTimeout)
    saveBoundsTimeout = setTimeout(saveBounds, 500)
  }

  bw.on('resize', debouncedSaveBounds)
  bw.on('move', debouncedSaveBounds)
  bw.on('close', () => {
    if (saveBoundsTimeout) {
      clearTimeout(saveBoundsTimeout)
      saveBoundsTimeout = null
    }
    saveBounds()
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

function destroyRuntime(target: Runtime): void {
  target.missingCheckAbort.abort()
  if (target.missingCheckInterval) {
    clearInterval(target.missingCheckInterval)
    target.missingCheckInterval = null
  }
  target.activated = false
  target.metadataService.destroy()
  target.watcher.destroy()
  target.importer.destroy()
  target.agentPythonRuntime.destroy()
  target.pdfTextService.destroy()
  target.mineruDocumentService.destroy()
  closeDatabase(target.db)
}

function teardownRuntime(): void {
  const current = runtime
  runtime = null
  if (current) destroyRuntime(current)
}

function buildRuntime(dbPath: string): Runtime {
  if (!mineruEngineManager) throw new Error('MinerU engine manager is not ready')
  const db = openDatabase(dbPath)
  try {
    seedSettings(db, detectLanguage())
    const repos = createRepositories(db, { getSearchMode: () => getSearchMode(db) })
    const importer = createImporter(repos, () => win)
    const metadataService = createMetadataService(repos, () => win)
    const pdfTextService = createPdfTextService(repos, () => win)
    const agentPythonProjectPath = join(__dirname, '../../python/server/pyproject.toml')
    const agentPythonRuntime = createAgentPythonRuntime({
      userDataDir: app.getPath('userData'),
      projectPath: agentPythonProjectPath,
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
    const workerScriptPath = app.isPackaged
      ? join(process.resourcesPath, 'mineru', 'mineru_worker.py')
      : join(__dirname, '../../resources/mineru_worker.py')
    const mineruWorker = createMineruWorkerProcess({
      engineManager: mineruEngineManager,
      workerScriptPath
    })
    const send = (channel: string, payload: unknown): void => {
      if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
    }
    const mineruDocumentService = createMineruDocumentService({
      repos,
      engineManager: mineruEngineManager,
      worker: mineruWorker,
      getLibraryFolder: () => repos.settings.get<string>('libraryFolderPath', ''),
      emitProgress: (payload) => send(IpcChannel.EventOcrProgress, payload),
      emitCompleted: (payload) => send(IpcChannel.EventOcrCompleted, payload),
      emitError: (payload) => send(IpcChannel.EventOcrError, payload)
    })
    const watcher = createWatcher({
      importFiles: (paths, isWatch) => importer.importFiles(paths, isWatch),
      getLibraryFolder: () => repos.settings.get<string>('libraryFolderPath', ''),
      findUntrackedLibraryFiles: async (folder) => {
        const documents = repos.documents.list({ mode: 'all' })
        const knownPaths = new Set(
          documents.map((document) => normalizedLibraryFileKey(document.filePath))
        )
        const documentSignature = libraryDocumentSignature(documents)
        const duplicateCache = repos.settings.get<LibraryDuplicateFileCache | null>(
          LIBRARY_DUPLICATE_CACHE_KEY,
          null
        )
        const cachedFiles = activeDuplicateFiles(duplicateCache, documentSignature)
        const pdfs = await findPdfsRecursively(folder)
        return pdfs.filter((filePath) => {
          const key = normalizedLibraryFileKey(filePath)
          if (knownPaths.has(key)) return false
          return !sameDuplicateFingerprint(cachedFiles[key], duplicateFileFingerprint(filePath))
        })
      },
      recordSkippedLibraryFiles: (paths) => {
        const folder = repos.settings.get<string>('libraryFolderPath', '')
        const skipped = paths.filter((filePath) => isInsideLibrary(filePath, folder))
        if (skipped.length === 0) return
        const documents = repos.documents.list({ mode: 'all' })
        const documentSignature = libraryDocumentSignature(documents)
        const previous = repos.settings.get<LibraryDuplicateFileCache | null>(
          LIBRARY_DUPLICATE_CACHE_KEY,
          null
        )
        const files = previous?.documentSignature === documentSignature
          ? { ...previous.files }
          : {}
        for (const filePath of skipped) {
          const fingerprint = duplicateFileFingerprint(filePath)
          if (fingerprint) files[normalizedLibraryFileKey(filePath)] = fingerprint
        }
        repos.settings.set(LIBRARY_DUPLICATE_CACHE_KEY, { documentSignature, files })
      }
    })

    importer.onComplete((result) => {
      if (result.errors.length > 0 && win && !win.isDestroyed()) {
        for (const err of result.errors) {
          logger.warn(`import:error ${err.path}: ${err.message}`)
          win.webContents.send('import:toast', err.message)
        }
      }
      for (const id of result.added) {
        metadataService.enqueue(id)
      }
    })

    return {
      db,
      repos,
      importer,
      metadataService,
      watcher,
      missingCheckInterval: null,
      missingCheckAbort: new AbortController(),
      activated: false,
      pdfTextService,
      mineruWorker,
      mineruDocumentService,
      agentPythonRuntime
    }
  } catch (error) {
    closeDatabase(db)
    throw error
  }
}

function activateRuntime(target: Runtime, startLibraryWatcher = true): void {
  if (target.activated) return
  target.activated = true
  target.metadataService.resumeOnStartup()
  void target.mineruDocumentService.initialize().catch((error) => {
    logger.warn(`ocr:init failed: ${error instanceof Error ? error.message : String(error)}`)
  })
  const signal = target.missingCheckAbort.signal

  setImmediate(() => {
    if (signal.aborted) return
    try {
      const enabledFolders = target.repos.watchFolders.getEnabled()
      target.watcher.startAll(enabledFolders)
      logger.info(`watch:started ${enabledFolders.length} watchers`)
      const libraryFolder = target.repos.settings.get<string>('libraryFolderPath', '')
      if (startLibraryWatcher && libraryFolder) target.watcher.startLibraryWatcher(libraryFolder)
    } catch (error) {
      logger.warn(`watch:start failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  })

  const proxyUrl = target.repos.settings.get<string>('proxyUrl', '')
  if (proxyUrl) {
    if (validateProxyUrl(proxyUrl)) {
      void session.defaultSession.setProxy({ proxyRules: proxyUrl }).catch((e) => {
        logger.warn(`proxy:set failed: ${e instanceof Error ? e.message : String(e)}`)
      })
    } else {
      logger.warn(`proxy:invalid-url skipping setProxy: ${proxyUrl}`)
    }
  }

  setImmediate(() => {
    if (!signal.aborted) checkMissing(target.repos, win, signal)
  })

  target.missingCheckInterval = setInterval(() => {
    if (!isQuitting && !signal.aborted) checkMissing(target.repos, win, signal)
  }, 10 * 60 * 1000)
}

async function createRuntimeServerAssembly(
  target: Runtime,
  dbPath: string,
  libraryFolder: string,
  switchLibraryFolder: (folder: string) => Promise<LibrarySwitchResult>
): Promise<ServerAssembly> {
  const serverStateDir = join(app.getPath('userData'), 'server')
  mkdirSync(serverStateDir, { recursive: true })
  const serverExecutable = app.isPackaged
    ? join(process.resourcesPath, 'python-server', 'refora-server')
    : undefined
  const serverPython = app.isPackaged
    ? undefined
    : await target.agentPythonRuntime.install(new AbortController().signal)
  const serverSourceRoot = join(__dirname, '../../python/server')
  return createServerAssembly({
    lifecycle: createServerLifecycle({
      pythonPath: serverPython,
      serverModule: app.isPackaged ? undefined : 'refora_server.server.run',
      executablePath: serverExecutable,
      stateDir: serverStateDir,
      dbPath,
      libraryFolder,
      environment: {
        ...process.env,
        PYTHONNOUSERSITE: '1',
        ...(app.isPackaged ? {} : { PYTHONPATH: serverSourceRoot }),
        REFORA_MINERU_WORKER_PATH: app.isPackaged
          ? join(process.resourcesPath, 'mineru', 'mineru_worker.py')
          : join(__dirname, '../../resources/mineru_worker.py')
      }
    }),
    repos: target.repos,
    getWin: () => win,
    switchLibraryFolder,
    metadataService: target.metadataService
  })
}

function resolveStartupDbPath(): string {
  const userDataDir = app.getPath('userData')
  const userDataDbPath = join(userDataDir, DB_FILE_NAME)

  const prefsLibrary = readLibraryFolderPath(userDataDir)
  if (prefsLibrary && dbExistsInLibraryFolder(prefsLibrary)) {
    logger.info(`db:startup using library db (prefs) at ${prefsLibrary}`)
    return dbPathForLibraryFolder(prefsLibrary)
  }
  if (prefsLibrary && existsSync(prefsLibrary)) {
    logger.info(`db:startup creating library db (prefs) at ${prefsLibrary}`)
    return dbPathForLibraryFolder(prefsLibrary)
  }
  if (prefsLibrary && !existsSync(prefsLibrary)) {
    logger.warn(`db:startup prefs library folder missing, clearing prefs: ${prefsLibrary}`)
    writeLibraryFolderPath(userDataDir, '')
  }

  try {
    if (existsSync(userDataDbPath)) {
      const db = openDatabase(userDataDbPath)
      let trimmed = ''
      try {
        const libraryFolder = getSetting(db, 'libraryFolderPath')
        trimmed = libraryFolder ? JSON.parse(libraryFolder) as string : ''
      } finally {
        closeDatabase(db)
      }
      if (trimmed && dbExistsInLibraryFolder(trimmed)) {
        logger.info(`db:startup migrating to library db at ${trimmed}`)
        writeLibraryFolderPath(userDataDir, trimmed)
        return dbPathForLibraryFolder(trimmed)
      }
      if (trimmed && existsSync(trimmed)) {
        logger.info(`db:startup migrating to new library db at ${trimmed}`)
        writeLibraryFolderPath(userDataDir, trimmed)
        return dbPathForLibraryFolder(trimmed)
      }
      if (trimmed && !existsSync(trimmed)) {
        logger.warn(`db:startup legacy library folder missing, falling back to bootstrap: ${trimmed}`)
      }
    }
  } catch (e) {
    logger.warn(`db:startup bootstrap read failed: ${e instanceof Error ? e.message : String(e)}`)
  }
  return userDataDbPath
}

async function performLibrarySwitch(folder: string): Promise<LibrarySwitchResult> {
  const resolvedFolder = folder ? resolvePath(folder) : ''
  if (!resolvedFolder || !existsSync(resolvedFolder) || !statSync(resolvedFolder).isDirectory()) {
    throw new Error(`Invalid library folder: ${resolvedFolder}`)
  }
  const targetDbPath = dbPathForLibraryFolder(resolvedFolder)
  const dbExisted = dbExistsInLibraryFolder(resolvedFolder)
  logger.info(`library:switch folder=${resolvedFolder} dbExisted=${dbExisted}`)

  const nextRuntime = prepareReplacement(
    () => buildRuntime(targetDbPath),
    (candidate) => candidate.repos.settings.set('libraryFolderPath', resolvedFolder),
    destroyRuntime
  )
  const previousRuntime = runtime
  runtime = nextRuntime
  if (previousRuntime) destroyRuntime(previousRuntime)
  writeLibraryFolderPath(app.getPath('userData'), resolvedFolder)
  activateRuntime(nextRuntime, false)

  let scanned = 0
  let imported = 0
  let skipped = 0
  const errors: Array<{ path: string; message: string }> = []

  try {
    if (!dbExisted) {
      const pdfs = await findPdfsRecursively(resolvedFolder)
      scanned = pdfs.length
      logger.info(`library:scan found ${scanned} pdfs in ${resolvedFolder}`)
      if (scanned > 0 && win && !win.isDestroyed()) {
        emitLibraryScanning(win, { current: 0, total: scanned })
      }
      if (scanned > 0) {
        const importResult = await nextRuntime.importer.importFiles(pdfs, false)
        imported = importResult.added.length
        skipped = importResult.skipped.length
        errors.push(...importResult.errors)
      }
    }
  } finally {
    try {
      nextRuntime.watcher.startLibraryWatcher(resolvedFolder)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger.warn(`watch:library start failed: ${message}`)
      errors.push({ path: resolvedFolder, message })
    }
  }

  const result: LibrarySwitchResult = {
    libraryFolderPath: resolvedFolder,
    dbExisted,
    scanned,
    imported,
    skipped,
    errors
  }
  if (win && !win.isDestroyed()) {
    emitLibrarySwitched(win, result)
  }
  return result
}

const _switchLibraryFolder = createExclusiveTask(
  performLibrarySwitch,
  () => new RepoError('busy', 'Library switch already in progress')
)

void app.whenReady().then(async () => {
  isDev = !app.isPackaged
  initLogger()
  logger.info(`app:ready (dev=${isDev})`)
  applyCsp()

  mineruEngineManager = createMineruEngineManager({
    userDataDir: app.getPath('userData'),
    downloadFile: async (url, destination, signal, onProgress) => {
      const response = await net.fetch(url, { signal })
      if (!response.ok) throw new Error(`Runtime download failed with HTTP ${response.status}`)
      if (!response.body) throw new Error('Runtime download returned an empty response')
      const totalHeader = response.headers.get('content-length')
      const parsedTotal = totalHeader ? Number(totalHeader) : NaN
      const total = Number.isFinite(parsedTotal) && parsedTotal > 0 ? parsedTotal : null
      let received = 0
      let lastReportedAt = 0
      let lastReportedBytes = -1
      const reportProgress = (force = false): void => {
        const now = Date.now()
        if (!force && now - lastReportedAt < 100) return
        if (!force && received === lastReportedBytes) return
        lastReportedAt = now
        lastReportedBytes = received
        onProgress(received, total)
      }
      const tracker = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          received += chunk.length
          reportProgress()
          callback(null, chunk)
        }
      })
      await pipeline(
        Readable.fromWeb(response.body as import('node:stream/web').ReadableStream<Uint8Array>),
        tracker,
        createWriteStream(destination, { mode: 0o600 }),
        { signal }
      )
      if (received !== lastReportedBytes) reportProgress(true)
    },
    trashItem: (path) => shell.trashItem(path)
  })
  mineruEngineManager.onProgress((payload) => {
    if (win && !win.isDestroyed()) {
      win.webContents.send(IpcChannel.EventMineruInstallProgress, payload)
    }
  })

  if (isDev) {
    const devIconPath = join(__dirname, '../../build/icon.png')
    if (existsSync(devIconPath)) {
      app.dock?.setIcon(nativeImage.createFromPath(devIconPath))
    }
  }

  const dbPath = resolveStartupDbPath()
  runtime = buildRuntime(dbPath)
  registerWorkspaceAssetProtocol()
  registerDocumentProtocol()
  const r = runtime.repos
  const savedBounds = r.settings.get<{ x?: number; y?: number; width?: number; height?: number } | null>('windowBounds', null)
  activateRuntime(runtime)

  const libraryFolder = runtime.repos.settings.get<string>('libraryFolderPath', '') || app.getPath('userData')
  const switchLibraryFolder: (folder: string) => Promise<LibrarySwitchResult> = createLibraryHandoff<Runtime>({
    getRuntime: () => runtime,
    setRuntime: (nextRuntime) => { runtime = nextRuntime },
    getAssembly: () => serverAssembly,
    setAssembly: (nextAssembly) => { serverAssembly = nextAssembly },
    createRuntime: buildRuntime,
    destroyRuntime,
    createAssembly: (nextRuntime, nextDbPath, nextLibraryFolder): Promise<ServerAssembly> =>
      createRuntimeServerAssembly(nextRuntime, nextDbPath, nextLibraryFolder, switchLibraryFolder),
    activateRuntime: (nextRuntime) => activateRuntime(nextRuntime, false),
    dbPathForLibraryFolder,
    dbExistsInLibraryFolder,
    findPdfsRecursively,
    writeLibraryFolderPath: (folder) => writeLibraryFolderPath(app.getPath('userData'), folder),
    emitLibraryScanning,
    emitLibrarySwitched,
    getWin: () => win,
    exists: existsSync,
    isDirectory: (folder) => statSync(folder).isDirectory()
  })
  serverAssembly = await createRuntimeServerAssembly(runtime, dbPath, libraryFolder, switchLibraryFolder)
  await serverAssembly.start()
  win = createWindow(savedBounds)

  Menu.setApplicationMenu(buildMenu())

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      win = createWindow()
    }
  })
}).catch((e) => {
  logger.error(`startup failed: ${e instanceof Error ? e.message : String(e)}`)
  app.quit()
})

app.on('before-quit', () => {
  isQuitting = true
  const assembly = serverAssembly
  serverAssembly = null
  void assembly?.stop()
  teardownRuntime()
  mineruEngineManager?.destroy()
  if (win) {
    win = null
  }
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
