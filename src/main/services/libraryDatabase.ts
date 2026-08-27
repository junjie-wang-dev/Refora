import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { backup, DatabaseSync } from 'node:sqlite'
import {
  dbPathForLibraryFolder,
  legacyDbPathForLibraryFolder,
  snapshotDirectoryForLibraryFolder
} from './dbPath'
import { SyncStateDatabase } from './syncStateDatabase'

const SNAPSHOT_FORMAT_VERSION = 1
const LOCAL_SNAPSHOT_STATE_FORMAT_VERSION = 1
const LOCAL_SNAPSHOT_STATE_FILE = 'snapshot-state.json'
const runningSnapshots = new Map<string, Promise<LibrarySnapshotManifest | null>>()

export interface LibrarySnapshotManifest {
  formatVersion: 1
  snapshotId: string
  databaseFile: string
  libraryId: string
  schemaVersion: number
  baseSequence: number
  sha256: string
  size: number
  createdAt: string
}

export interface PreparedLibraryDatabase {
  dbPath: string
  dbExisted: boolean
  source: 'working' | 'legacy' | 'snapshot' | 'new'
  restoredSnapshot: LibrarySnapshotManifest | null
}

interface LocalSnapshotState {
  formatVersion: 1
  libraryId: string
  snapshotId: string
  snapshotCreatedAt: string
  snapshotSha256: string
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function parseManifest(value: unknown): LibrarySnapshotManifest | null {
  const record = asRecord(value)
  if (!record) return null
  if (
    record.formatVersion !== SNAPSHOT_FORMAT_VERSION
    || typeof record.snapshotId !== 'string'
    || !/^[0-9a-f-]{36}$/.test(record.snapshotId)
    || record.databaseFile !== `${record.snapshotId}.db`
    || typeof record.libraryId !== 'string'
    || !/^[0-9a-f-]{36}$/.test(record.libraryId)
    || !Number.isInteger(record.schemaVersion)
    || (record.schemaVersion as number) < 1
    || !Number.isSafeInteger(record.baseSequence)
    || (record.baseSequence as number) < 0
    || typeof record.sha256 !== 'string'
    || !/^[0-9a-f]{64}$/.test(record.sha256)
    || !Number.isSafeInteger(record.size)
    || (record.size as number) < 1
    || typeof record.createdAt !== 'string'
    || !Number.isFinite(Date.parse(record.createdAt))
  ) return null
  return record as unknown as LibrarySnapshotManifest
}

function parseLocalSnapshotState(value: unknown): LocalSnapshotState | null {
  const record = asRecord(value)
  if (!record) return null
  if (
    record.formatVersion !== LOCAL_SNAPSHOT_STATE_FORMAT_VERSION
    || typeof record.libraryId !== 'string'
    || !/^[0-9a-f-]{36}$/.test(record.libraryId)
    || typeof record.snapshotId !== 'string'
    || !/^[0-9a-f-]{36}$/.test(record.snapshotId)
    || typeof record.snapshotCreatedAt !== 'string'
    || !Number.isFinite(Date.parse(record.snapshotCreatedAt))
    || typeof record.snapshotSha256 !== 'string'
    || !/^[0-9a-f]{64}$/.test(record.snapshotSha256)
  ) return null
  return record as unknown as LocalSnapshotState
}

function localSnapshotStatePath(dbPath: string): string {
  return join(dirname(dbPath), LOCAL_SNAPSHOT_STATE_FILE)
}

function readLocalSnapshotState(dbPath: string): LocalSnapshotState | null {
  try {
    return parseLocalSnapshotState(JSON.parse(readFileSync(localSnapshotStatePath(dbPath), 'utf8')))
  } catch {
    return null
  }
}

function writeLocalSnapshotState(dbPath: string, manifest: LibrarySnapshotManifest): void {
  const path = localSnapshotStatePath(dbPath)
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.tmp-${randomUUID()}`
  const state: LocalSnapshotState = {
    formatVersion: LOCAL_SNAPSHOT_STATE_FORMAT_VERSION,
    libraryId: manifest.libraryId,
    snapshotId: manifest.snapshotId,
    snapshotCreatedAt: manifest.createdAt,
    snapshotSha256: manifest.sha256
  }
  try {
    writeFileSync(temporary, JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600 })
    renameSync(temporary, path)
  } finally {
    if (existsSync(temporary)) rmSync(temporary, { force: true })
  }
}

function isSnapshotNewerThanLocal(
  manifest: LibrarySnapshotManifest,
  state: LocalSnapshotState | null
): boolean {
  if (!state) return true
  if (manifest.snapshotId === state.snapshotId) return false
  const createdAtDifference = Date.parse(manifest.createdAt) - Date.parse(state.snapshotCreatedAt)
  if (createdAtDifference !== 0) return createdAtDifference > 0
  return manifest.snapshotId > state.snapshotId
}

function sha256File(path: string): Promise<string> {
  return new Promise((resolveHash, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolveHash(hash.digest('hex')))
  })
}

function verifyDatabase(
  path: string,
  requireIdentity = false
): { libraryId: string | null; schemaVersion: number } {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    db.exec('PRAGMA busy_timeout = 5000')
    const quickCheck = db.prepare('PRAGMA quick_check').get() as Record<string, unknown> | undefined
    if (!quickCheck || Object.values(quickCheck)[0] !== 'ok') {
      throw new Error('SQLite integrity check failed')
    }
    const foreignKeyError = db.prepare('PRAGMA foreign_key_check').get()
    if (foreignKeyError) throw new Error('SQLite foreign-key check failed')
    const schema = db.prepare('PRAGMA user_version').get() as Record<string, unknown> | undefined
    const schemaVersion = Number(schema ? Object.values(schema)[0] : 0)
    const hasSyncState = db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sync_state'"
    ).get()
    const syncState = hasSyncState
      ? db.prepare('SELECT libraryId FROM sync_state WHERE id = 1').get() as
        | { libraryId?: unknown }
        | undefined
      : undefined
    const libraryId = typeof syncState?.libraryId === 'string'
      && /^[0-9a-f-]{36}$/.test(syncState.libraryId)
      ? syncState.libraryId
      : null
    if (requireIdentity && !libraryId) {
      throw new Error('Database library identity is missing or invalid')
    }
    return { libraryId, schemaVersion }
  } finally {
    db.close()
  }
}

function tableHasColumns(
  db: DatabaseSync,
  schema: 'main' | 'previous',
  table: string,
  columns: string[]
): boolean {
  try {
    const available = new Set(
      (db.prepare(`PRAGMA ${schema}.table_info(${table})`).all() as Array<{ name?: unknown }>)
        .flatMap((row) => typeof row.name === 'string' ? [row.name] : [])
    )
    return columns.every((column) => available.has(column))
  } catch {
    return false
  }
}

function preserveDeviceLocalState(snapshotPath: string, previousPath: string): void {
  const db = new DatabaseSync(snapshotPath)
  let attached = false
  try {
    db.exec('PRAGMA busy_timeout = 5000')
    db.prepare('ATTACH DATABASE ? AS previous').run(previousPath)
    attached = true
    db.exec('BEGIN IMMEDIATE')
    try {
      const watchFolderColumns = ['id', 'path', 'enabled', 'addedAt']
      if (
        tableHasColumns(db, 'main', 'watch_folders', watchFolderColumns)
        && tableHasColumns(db, 'previous', 'watch_folders', watchFolderColumns)
      ) {
        db.exec(`
          DELETE FROM watch_folders;
          INSERT INTO watch_folders(id, path, enabled, addedAt)
          SELECT id, path, enabled, addedAt FROM previous.watch_folders;
        `)
      }
      const settingColumns = ['key', 'value']
      if (
        tableHasColumns(db, 'main', 'settings', settingColumns)
        && tableHasColumns(db, 'previous', 'settings', settingColumns)
      ) {
        db.exec(`
          INSERT INTO settings(key, value)
          SELECT key, value FROM previous.settings
          WHERE key IN ('windowBounds', 'proxyUrl')
          ON CONFLICT(key) DO UPDATE SET value = excluded.value;
        `)
      }
      const providerColumns = ['id', 'apiKeyEnc']
      if (
        tableHasColumns(db, 'main', 'ai_providers', providerColumns)
        && tableHasColumns(db, 'previous', 'ai_providers', providerColumns)
      ) {
        db.exec(`
          UPDATE ai_providers
          SET apiKeyEnc = (
            SELECT previous.ai_providers.apiKeyEnc
            FROM previous.ai_providers
            WHERE previous.ai_providers.id = ai_providers.id
          )
          WHERE EXISTS (
            SELECT 1 FROM previous.ai_providers
            WHERE previous.ai_providers.id = ai_providers.id
          );
        `)
      }
      const webSearchColumns = [
        'id',
        'provider',
        'tavilyApiKeyEnc',
        'braveApiKeyEnc',
        'updatedAt'
      ]
      if (
        tableHasColumns(db, 'main', 'web_search_config', webSearchColumns)
        && tableHasColumns(db, 'previous', 'web_search_config', webSearchColumns)
      ) {
        db.exec(`
          UPDATE web_search_config
          SET provider = (SELECT provider FROM previous.web_search_config WHERE id = 1),
              tavilyApiKeyEnc = (SELECT tavilyApiKeyEnc FROM previous.web_search_config WHERE id = 1),
              braveApiKeyEnc = (SELECT braveApiKeyEnc FROM previous.web_search_config WHERE id = 1),
              updatedAt = (SELECT updatedAt FROM previous.web_search_config WHERE id = 1)
          WHERE id = 1 AND EXISTS (SELECT 1 FROM previous.web_search_config WHERE id = 1);
        `)
      }
      const profileColumns = ['id', 'executablePath']
      if (
        tableHasColumns(db, 'main', 'agent_profiles', profileColumns)
        && tableHasColumns(db, 'previous', 'agent_profiles', profileColumns)
      ) {
        db.exec(`
          UPDATE agent_profiles
          SET executablePath = (
            SELECT previous.agent_profiles.executablePath
            FROM previous.agent_profiles
            WHERE previous.agent_profiles.id = agent_profiles.id
          )
          WHERE EXISTS (
            SELECT 1 FROM previous.agent_profiles
            WHERE previous.agent_profiles.id = agent_profiles.id
          );
        `)
      }
      const syncStateColumns = ['id', 'libraryId', 'remoteLibraryId', 'enabled', 'updatedAt']
      if (
        tableHasColumns(db, 'main', 'sync_state', syncStateColumns)
        && tableHasColumns(db, 'previous', 'sync_state', syncStateColumns)
      ) {
        db.exec(`
          UPDATE sync_state
          SET remoteLibraryId = (SELECT remoteLibraryId FROM previous.sync_state WHERE id = 1),
              enabled = (SELECT enabled FROM previous.sync_state WHERE id = 1),
              updatedAt = (SELECT updatedAt FROM previous.sync_state WHERE id = 1)
          WHERE id = 1
            AND libraryId = (SELECT libraryId FROM previous.sync_state WHERE id = 1);
        `)
      }
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  } finally {
    if (attached) {
      try {
        db.exec('DETACH DATABASE previous')
      } catch (error) {
        void error
      }
    }
    db.close()
  }
}

function replaceDatabaseFile(temporary: string, destinationPath: string): void {
  const movedSidecars: Array<{ original: string; moved: string }> = []
  try {
    for (const original of [`${destinationPath}-wal`, `${destinationPath}-shm`]) {
      if (!existsSync(original)) continue
      const moved = `${original}.replaced-${randomUUID()}`
      renameSync(original, moved)
      movedSidecars.push({ original, moved })
    }
    renameSync(temporary, destinationPath)
  } catch (error) {
    for (const sidecar of movedSidecars.reverse()) {
      if (existsSync(sidecar.moved) && !existsSync(sidecar.original)) {
        renameSync(sidecar.moved, sidecar.original)
      }
    }
    throw error
  }
  for (const sidecar of movedSidecars) rmSync(sidecar.moved, { force: true })
}

async function backupDatabase(
  sourcePath: string,
  destinationPath: string,
  deviceStateSourcePath?: string
): Promise<void> {
  mkdirSync(dirname(destinationPath), { recursive: true })
  const temporary = `${destinationPath}.tmp-${randomUUID()}`
  const source = new DatabaseSync(sourcePath, { readOnly: true })
  try {
    source.exec('PRAGMA busy_timeout = 5000')
    await backup(source, temporary)
    if (deviceStateSourcePath) preserveDeviceLocalState(temporary, deviceStateSourcePath)
    verifyDatabase(temporary)
    chmodSync(temporary, 0o600)
    replaceDatabaseFile(temporary, destinationPath)
  } finally {
    source.close()
    if (existsSync(temporary)) rmSync(temporary, { force: true })
  }
}

interface SnapshotCandidate {
  manifest: LibrarySnapshotManifest
  databasePath: string
  manifestPath: string
}

function snapshotCandidates(libraryFolder: string): SnapshotCandidate[] {
  const directory = snapshotDirectoryForLibraryFolder(libraryFolder)
  let names: string[]
  try {
    names = readdirSync(directory).filter((name) => name.endsWith('.json'))
  } catch {
    return []
  }
  return names.flatMap((name) => {
    try {
      const manifest = parseManifest(JSON.parse(readFileSync(join(directory, name), 'utf8')))
      if (!manifest || name !== `${manifest.snapshotId}.json`) return []
      const databasePath = resolve(directory, manifest.databaseFile)
      if (dirname(databasePath) !== resolve(directory) || basename(databasePath) !== manifest.databaseFile) {
        return []
      }
      return [{ manifest, databasePath, manifestPath: join(directory, name) }]
    } catch {
      return []
    }
  }).sort((left, right) => {
    const createdAtDifference = Date.parse(right.manifest.createdAt) - Date.parse(left.manifest.createdAt)
    if (createdAtDifference !== 0) return createdAtDifference
    return right.manifest.snapshotId.localeCompare(left.manifest.snapshotId)
  })
}

async function isValidSnapshot(candidate: SnapshotCandidate): Promise<boolean> {
  try {
    if (!existsSync(candidate.databasePath)) return false
    const stat = statSync(candidate.databasePath)
    if (!stat.isFile() || stat.size !== candidate.manifest.size) return false
    if (await sha256File(candidate.databasePath) !== candidate.manifest.sha256) return false
    const identity = verifyDatabase(candidate.databasePath, true)
    return identity.libraryId === candidate.manifest.libraryId
      && identity.schemaVersion === candidate.manifest.schemaVersion
  } catch {
    return false
  }
}

function removeSnapshotCandidate(candidate: SnapshotCandidate): void {
  for (const path of [candidate.databasePath, candidate.manifestPath]) {
    try {
      rmSync(path, { force: true })
    } catch {
      continue
    }
  }
}

async function newestValidSnapshot(libraryFolder: string): Promise<SnapshotCandidate | null> {
  for (const candidate of snapshotCandidates(libraryFolder)) {
    if (await isValidSnapshot(candidate)) return candidate
  }
  return null
}

async function restoreSnapshotCandidate(
  candidate: SnapshotCandidate,
  destinationPath: string,
  preserveExistingDeviceState = false
): Promise<LibrarySnapshotManifest> {
  await backupDatabase(
    candidate.databasePath,
    destinationPath,
    preserveExistingDeviceState && existsSync(destinationPath) ? destinationPath : undefined
  )
  writeLocalSnapshotState(destinationPath, candidate.manifest)
  return candidate.manifest
}

async function restoreSnapshot(
  libraryFolder: string,
  destinationPath: string
): Promise<LibrarySnapshotManifest | null> {
  const candidate = await newestValidSnapshot(libraryFolder)
  if (!candidate) return null
  return restoreSnapshotCandidate(candidate, destinationPath)
}

async function sanitizedDatabaseHash(dbPath: string): Promise<string> {
  const temporary = join(dirname(dbPath), `.snapshot-compare-${randomUUID()}.db`)
  const source = new DatabaseSync(dbPath, { readOnly: true })
  try {
    source.exec('PRAGMA busy_timeout = 5000')
    await backup(source, temporary)
  } finally {
    source.close()
  }
  try {
    sanitizeSnapshot(temporary)
    return await sha256File(temporary)
  } finally {
    rmSync(temporary, { force: true })
  }
}

function resetMetadataSyncAfterRestore(
  userDataDir: string,
  dbPath: string,
  manifest: LibrarySnapshotManifest
): void {
  try {
    new SyncStateDatabase(userDataDir).resetLibrary(manifest.libraryId)
  } catch (error) {
    rmSync(localSnapshotStatePath(dbPath), { force: true })
    throw error
  }
}

export async function prepareLibraryDatabase(
  userDataDir: string,
  libraryFolder: string
): Promise<PreparedLibraryDatabase> {
  const dbPath = dbPathForLibraryFolder(userDataDir, libraryFolder)
  if (existsSync(dbPath)) {
    let localDatabaseError: unknown = null
    try {
      verifyDatabase(dbPath)
    } catch (error) {
      localDatabaseError = error
    }
    const candidate = libraryFolder ? await newestValidSnapshot(libraryFolder) : null
    const localState = readLocalSnapshotState(dbPath)
    const newerSnapshotAvailable = candidate
      && isSnapshotNewerThanLocal(candidate.manifest, localState)
    const localMatchesPreviousSnapshot = localDatabaseError === null
      && localState !== null
      && localState.libraryId === candidate?.manifest.libraryId
      && await sanitizedDatabaseHash(dbPath) === localState.snapshotSha256
    if (candidate && (localDatabaseError !== null || (newerSnapshotAvailable && localMatchesPreviousSnapshot))) {
      const restoredSnapshot = await restoreSnapshotCandidate(
        candidate,
        dbPath,
        localDatabaseError === null
      )
      resetMetadataSyncAfterRestore(userDataDir, dbPath, restoredSnapshot)
      return { dbPath, dbExisted: true, source: 'snapshot', restoredSnapshot }
    }
    if (localDatabaseError !== null) {
      throw Object.assign(
        new Error(`The local working database is damaged and no valid snapshot can replace it: ${localDatabaseError instanceof Error ? localDatabaseError.message : String(localDatabaseError)}`),
        { code: 'library_database_damaged' }
      )
    }
    return { dbPath, dbExisted: true, source: 'working', restoredSnapshot: null }
  }
  if (libraryFolder) {
    const restoredSnapshot = await restoreSnapshot(libraryFolder, dbPath)
    if (restoredSnapshot) {
      resetMetadataSyncAfterRestore(userDataDir, dbPath, restoredSnapshot)
      return { dbPath, dbExisted: true, source: 'snapshot', restoredSnapshot }
    }
  }
  const legacyPath = legacyDbPathForLibraryFolder(userDataDir, libraryFolder)
  if (existsSync(legacyPath)) {
    try {
      await backupDatabase(legacyPath, dbPath)
    } catch (error) {
      throw Object.assign(
        new Error(`The legacy library database could not be migrated safely: ${error instanceof Error ? error.message : String(error)}`),
        { code: 'library_database_damaged' }
      )
    }
    return { dbPath, dbExisted: true, source: 'legacy', restoredSnapshot: null }
  }
  mkdirSync(dirname(dbPath), { recursive: true })
  return { dbPath, dbExisted: false, source: 'new', restoredSnapshot: null }
}

export function readLibraryFolderFromDatabase(path: string): string {
  if (!existsSync(path)) return ''
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    const hasSettings = db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'settings'"
    ).get()
    if (!hasSettings) return ''
    const row = db.prepare("SELECT value FROM settings WHERE key = 'libraryFolderPath'").get() as
      | { value?: unknown }
      | undefined
    if (typeof row?.value !== 'string') return ''
    const decoded = JSON.parse(row.value) as unknown
    return typeof decoded === 'string' ? decoded : ''
  } catch {
    return ''
  } finally {
    db.close()
  }
}

export async function adoptDatabaseForLibrary(
  userDataDir: string,
  libraryFolder: string,
  sourcePath: string
): Promise<PreparedLibraryDatabase> {
  const dbPath = dbPathForLibraryFolder(userDataDir, libraryFolder)
  if (dbPath === sourcePath) {
    return { dbPath, dbExisted: true, source: 'working', restoredSnapshot: null }
  }
  if (!existsSync(dbPath)) await backupDatabase(sourcePath, dbPath)
  else verifyDatabase(dbPath)
  return { dbPath, dbExisted: true, source: 'working', restoredSnapshot: null }
}

function sanitizeSnapshot(path: string): { libraryId: string; schemaVersion: number } {
  const db = new DatabaseSync(path)
  try {
    db.exec('PRAGMA busy_timeout = 5000')
    db.exec('PRAGMA foreign_keys = ON')
    db.exec('BEGIN IMMEDIATE')
    try {
      db.exec('DELETE FROM watch_folders')
      db.exec("DELETE FROM settings WHERE key IN ('libraryFolderPath', 'windowBounds', 'proxyUrl')")
      db.exec('UPDATE ai_providers SET apiKeyEnc = NULL')
      db.exec("UPDATE web_search_config SET provider = 'disabled', tavilyApiKeyEnc = NULL, braveApiKeyEnc = NULL")
      db.exec('DELETE FROM agent_runtime_sessions')
      db.exec('UPDATE agent_profiles SET executablePath = NULL')
      db.exec('UPDATE sync_state SET remoteLibraryId = NULL, enabled = 0, updatedAt = 0 WHERE id = 1')
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
    db.exec('VACUUM')
    db.exec('PRAGMA journal_mode = DELETE')
  } finally {
    db.close()
  }
  const identity = verifyDatabase(path, true)
  return { libraryId: identity.libraryId as string, schemaVersion: identity.schemaVersion }
}

async function createLibrarySnapshotNow(options: {
  dbPath: string
  libraryFolder: string
  baseSequence?: number
}): Promise<LibrarySnapshotManifest | null> {
  if (!options.libraryFolder || !existsSync(options.dbPath)) return null
  const directory = snapshotDirectoryForLibraryFolder(options.libraryFolder)
  mkdirSync(directory, { recursive: true })
  const snapshotId = randomUUID()
  const databaseFile = `${snapshotId}.db`
  const databasePath = join(directory, databaseFile)
  const temporaryDatabase = `${databasePath}.tmp-${randomUUID()}`
  const temporaryManifest = join(directory, `${snapshotId}.json.tmp-${randomUUID()}`)
  const source = new DatabaseSync(options.dbPath, { readOnly: true })
  try {
    source.exec('PRAGMA busy_timeout = 5000')
    await backup(source, temporaryDatabase)
  } finally {
    source.close()
  }
  try {
    const identity = sanitizeSnapshot(temporaryDatabase)
    const stat = statSync(temporaryDatabase)
    const sha256 = await sha256File(temporaryDatabase)
    const previousCandidates = snapshotCandidates(options.libraryFolder)
    const validCandidates: SnapshotCandidate[] = []
    for (const candidate of previousCandidates) {
      if (await isValidSnapshot(candidate)) validCandidates.push(candidate)
    }
    const localState = readLocalSnapshotState(options.dbPath)
    const newestCandidate = validCandidates[0]
    const contentMatches = (candidate: SnapshotCandidate): boolean => (
      candidate.manifest.sha256 === sha256
      && candidate.manifest.libraryId === identity.libraryId
      && candidate.manifest.schemaVersion === identity.schemaVersion
    )
    if (newestCandidate && isSnapshotNewerThanLocal(newestCandidate.manifest, localState)) {
      if (contentMatches(newestCandidate)) {
        writeLocalSnapshotState(options.dbPath, newestCandidate.manifest)
        for (const stale of previousCandidates) {
          if (stale.manifest.snapshotId !== newestCandidate.manifest.snapshotId) {
            removeSnapshotCandidate(stale)
          }
        }
        return newestCandidate.manifest
      }
      if (options.baseSequence === undefined) {
        throw Object.assign(
          new Error('A newer cloud snapshot exists while this device also has local changes. Sync metadata before publishing a new snapshot.'),
          { code: 'library_snapshot_conflict' }
        )
      }
    }
    const matchingCandidate = validCandidates.find((candidate) => (
      candidate.manifest.snapshotId === localState?.snapshotId && contentMatches(candidate)
    ))
    if (matchingCandidate) {
      writeLocalSnapshotState(options.dbPath, matchingCandidate.manifest)
      for (const stale of previousCandidates) {
        if (stale.manifest.snapshotId !== matchingCandidate.manifest.snapshotId) {
          removeSnapshotCandidate(stale)
        }
      }
      return matchingCandidate.manifest
    }
    const latestKnownCreatedAt = Math.max(
      localState ? Date.parse(localState.snapshotCreatedAt) : 0,
      ...validCandidates.map((candidate) => Date.parse(candidate.manifest.createdAt))
    )
    const manifest: LibrarySnapshotManifest = {
      formatVersion: SNAPSHOT_FORMAT_VERSION,
      snapshotId,
      databaseFile,
      libraryId: identity.libraryId,
      schemaVersion: identity.schemaVersion,
      baseSequence: Math.max(0, Math.trunc(options.baseSequence ?? 0)),
      sha256,
      size: stat.size,
      createdAt: new Date(Math.max(Date.now(), latestKnownCreatedAt + 1)).toISOString()
    }
    chmodSync(temporaryDatabase, 0o400)
    renameSync(temporaryDatabase, databasePath)
    writeFileSync(temporaryManifest, JSON.stringify(manifest, null, 2), {
      encoding: 'utf8',
      mode: 0o600
    })
    renameSync(temporaryManifest, join(directory, `${snapshotId}.json`))
    writeLocalSnapshotState(options.dbPath, manifest)
    for (const stale of previousCandidates) removeSnapshotCandidate(stale)
    return manifest
  } finally {
    if (existsSync(temporaryDatabase)) rmSync(temporaryDatabase, { force: true })
    if (existsSync(temporaryManifest)) rmSync(temporaryManifest, { force: true })
  }
}

export function createLibrarySnapshot(options: {
  dbPath: string
  libraryFolder: string
  baseSequence?: number
}): Promise<LibrarySnapshotManifest | null> {
  if (!options.libraryFolder || !existsSync(options.dbPath)) return Promise.resolve(null)
  const key = resolve(options.libraryFolder)
  const running = runningSnapshots.get(key)
  if (running) return running
  const snapshot = createLibrarySnapshotNow(options).finally(() => {
    if (runningSnapshots.get(key) === snapshot) runningSnapshots.delete(key)
  })
  runningSnapshots.set(key, snapshot)
  return snapshot
}
