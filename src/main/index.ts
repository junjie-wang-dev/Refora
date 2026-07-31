import { app, BrowserWindow, Menu, shell, session, dialog, nativeImage, net, protocol } from 'electron'
import { join, resolve as resolvePath } from 'node:path'
import { createWriteStream, existsSync, statSync, writeFileSync } from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { initLogger, logger } from './services/logger'
import { createPdfTextService } from './services/pdfText'
import type { PdfTextService } from './services/pdfText'
import { dbPathForLibraryFolder, dbExistsInLibraryFolder, DB_FILE_NAME } from './services/dbPath'
import { readLibraryFolderPath, writeLibraryFolderPath } from './services/prefs'
import { IpcChannel } from '../shared/ipc-channels'
import type { LibrarySwitchResult } from '../shared/ipc-types'
import { runMenuAction } from './services/menuAction'
import { createServerPythonRuntime } from './sidecar/runtime'
import type { ServerPythonRuntime } from './sidecar/runtime'
import { createServerLifecycle } from './sidecar/lifecycle'
import { createServerAssembly, type ServerAssembly } from './sidecar/assembly'
import { createServerStateDirectory } from './sidecar/stateDirectory'

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
let serverAssembly: ServerAssembly | null = null
let serverPythonRuntime: ServerPythonRuntime | null = null
let pdfTextService: PdfTextService | null = null
let activeDbPath = ''
let activeLibraryFolder = ''
let win: BrowserWindow | null = null
let isQuitting = false

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
        const [document, settings] = await Promise.all([
          assembly.getClient().http.documentsGet(parts[0]),
          assembly.getClient().http.settingsGet()
        ])
        const libraryFolder = settings['libraryFolderPath']
        if (typeof libraryFolder !== 'string') {
          return new Response('Library unavailable', { status: 503 })
        }
        const png = await pdfTextService.getPreviewForDocument(document, libraryFolder)
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
            const assembly = serverAssembly
            if (!w || !assembly) return
            const result = await dialog.showOpenDialog(w, {
              title: 'Add PDF Files',
              properties: ['openFile', 'multiSelections'],
              filters: [{ name: 'PDF Files', extensions: ['pdf'] }]
            })
            if (result.canceled) return
            void assembly.getClient().http.importFiles({ paths: result.filePaths })
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
              const assembly = serverAssembly
              if (!w || !assembly) return
              const result = await dialog.showOpenDialog(w, {
                title: 'Add Folder',
                properties: ['openDirectory']
              })
              if (result.canceled) return
              await assembly.getClient().http.importFolder({
                path: result.filePaths[0],
                recursive: true
              })
            }, (error) => reportMenuError('add folder', error))
          }
        },
        { type: 'separator' },
        {
          label: 'Import JSON\u2026',
          click: () => {
            void runMenuAction(async () => {
              const w = getWin()
              const assembly = serverAssembly
              if (!w || !assembly) return
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
              const imported = await assembly.getClient().http.importJson({
                path: result.filePaths[0],
                mode
              })
              logger.info(`import:json ${imported.imported} documents`)
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
              const assembly = serverAssembly
              if (!w || !assembly) return
              const result = await dialog.showSaveDialog(w, {
                title: 'Export JSON',
                defaultPath: `refora-export-${new Date().toISOString().slice(0, 10)}.json`,
                filters: [{ name: 'JSON files', extensions: ['json'] }]
              })
              if (result.canceled || !result.filePath) return
              const payload = await assembly.getClient().http.exportJson({})
              writeFileSync(result.filePath, JSON.stringify(payload, null, 2), 'utf8')
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
    const assembly = serverAssembly
    if (!assembly || isQuitting || bw.isDestroyed()) return
    try {
      const bounds = bw.getBounds()
      void assembly.getClient().http.settingsUpdate({
        windowBounds: {
          x: bounds.x,
          y: bounds.y,
          width: bounds.width,
          height: bounds.height,
          isMaximized: bw.isMaximized()
        }
      }).catch((error) => {
        logger.warn(`saveBounds: ${error instanceof Error ? error.message : String(error)}`)
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

  return userDataDbPath
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
    : await serverPythonRuntime.install(new AbortController().signal)
  const serverSourceRoot = join(__dirname, '../../backend')
  const serverState = createServerStateDirectory(app.getPath('userData'))
  const assembly = createServerAssembly({
    lifecycle: createServerLifecycle({
      pythonPath: serverPython,
      serverModule: app.isPackaged ? undefined : 'refora_server.server.run',
      executablePath: serverExecutable,
      stateDir: serverState.path,
      userDataDir: app.getPath('userData'),
      dbPath,
      libraryFolder,
      language: detectLanguage(),
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
    switchLibraryFolder
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
    fetchResource: (path, headers) => assembly.fetchResource(path, headers)
  }
}

let librarySwitching = false

async function switchLibraryFolderPython(folder: string): Promise<LibrarySwitchResult> {
  if (librarySwitching) {
    throw Object.assign(new Error('Library switch already in progress'), { code: 'busy' })
  }
  librarySwitching = true
  const resolvedFolder = folder ? resolvePath(folder) : ''
  if (!resolvedFolder || !existsSync(resolvedFolder) || !statSync(resolvedFolder).isDirectory()) {
    librarySwitching = false
    throw Object.assign(new Error(`Invalid library folder: ${resolvedFolder}`), {
      code: 'invalid_library'
    })
  }
  const previousAssembly = serverAssembly
  const previousDbPath = activeDbPath
  const previousLibraryFolder = activeLibraryFolder
  const targetDbPath = dbPathForLibraryFolder(resolvedFolder)
  const dbExisted = dbExistsInLibraryFolder(resolvedFolder)
  let nextAssembly: ServerAssembly | null = null
  try {
    await previousAssembly?.stop()
    nextAssembly = await createPythonServerAssembly(
      targetDbPath,
      resolvedFolder,
      switchLibraryFolderPython
    )
    await nextAssembly.start()
    let scanned = 0
    let imported = 0
    let skipped = 0
    const errors: Array<{ path: string; message: string }> = []
    if (!dbExisted) {
      const result = await nextAssembly.getClient().http.importFolder({
        path: resolvedFolder,
        recursive: true
      })
      imported = result.added.length
      skipped = result.skipped.length
      scanned = imported + skipped + result.errors.length
      errors.push(...result.errors)
    }
    serverAssembly = nextAssembly
    activeDbPath = targetDbPath
    activeLibraryFolder = resolvedFolder
    writeLibraryFolderPath(app.getPath('userData'), resolvedFolder)
    const result: LibrarySwitchResult = {
      libraryFolderPath: resolvedFolder,
      dbExisted,
      scanned,
      imported,
      skipped,
      errors
    }
    if (win && !win.isDestroyed()) {
      win.webContents.send(IpcChannel.EventLibrarySwitched, result)
    }
    return result
  } catch (error) {
    await nextAssembly?.stop().catch(() => undefined)
    if (previousAssembly) {
      const restored = await createPythonServerAssembly(
        previousDbPath,
        previousLibraryFolder,
        switchLibraryFolderPython
      )
      await restored.start()
      serverAssembly = restored
    }
    throw error
  } finally {
    librarySwitching = false
  }
}

void app.whenReady().then(async () => {
  isDev = !app.isPackaged
  initLogger()
  logger.info(`app:ready (dev=${isDev})`)
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

  if (isDev) {
    const devIconPath = join(__dirname, '../../build/icon.png')
    if (existsSync(devIconPath)) {
      app.dock?.setIcon(nativeImage.createFromPath(devIconPath))
    }
  }

  const dbPath = resolveStartupDbPath()
  const preferredLibrary = readLibraryFolderPath(app.getPath('userData'))
  const libraryFolder = preferredLibrary && existsSync(preferredLibrary)
    ? resolvePath(preferredLibrary)
    : ''
  activeDbPath = dbPath
  activeLibraryFolder = libraryFolder
  serverAssembly = await createPythonServerAssembly(
    dbPath,
    libraryFolder,
    switchLibraryFolderPython
  )
  await serverAssembly.start()
  registerWorkspaceAssetProtocol()
  registerDocumentProtocol()
  const bootstrap = await serverAssembly.getClient().http.appBootstrap()
  if (bootstrap.libraryFolderPath && existsSync(bootstrap.libraryFolderPath)) {
    activeLibraryFolder = resolvePath(bootstrap.libraryFolderPath)
    activeDbPath = dbPathForLibraryFolder(activeLibraryFolder)
    writeLibraryFolderPath(app.getPath('userData'), activeLibraryFolder)
  }
  const savedBounds = bootstrap.windowBounds
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
  pdfTextService?.destroy()
  pdfTextService = null
  serverPythonRuntime?.destroy()
  serverPythonRuntime = null
  if (win) {
    win = null
  }
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
