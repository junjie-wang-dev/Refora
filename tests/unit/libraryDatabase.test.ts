import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { dbPathForLibraryFolder, snapshotDirectoryForLibraryFolder } from '../../src/main/services/dbPath'
import {
  adoptDatabaseForLibrary,
  createLibrarySnapshot,
  prepareLibraryDatabase,
  readLibraryFolderFromDatabase,
  type LibrarySnapshotManifest
} from '../../src/main/services/libraryDatabase'
import { SyncStateDatabase } from '../../src/main/services/syncStateDatabase'

function createPortableSource(path: string): void {
  const db = new DatabaseSync(path)
  try {
    db.exec(`
      PRAGMA user_version = 40;
      CREATE TABLE sync_state(
        id INTEGER PRIMARY KEY,
        libraryId TEXT NOT NULL,
        remoteLibraryId TEXT,
        enabled INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL
      );
      INSERT INTO sync_state VALUES(
        1,
        '10000000-0000-0000-0000-000000000010',
        '10000000-0000-0000-0000-000000000010',
        1,
        123
      );
      CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO settings VALUES('libraryFolderPath', '"/cloud/library"');
      INSERT INTO settings VALUES('durableMarker', '"preserved"');
      CREATE TABLE watch_folders(id TEXT PRIMARY KEY);
      INSERT INTO watch_folders VALUES('watch-1');
      CREATE TABLE ai_providers(id TEXT PRIMARY KEY, apiKeyEnc BLOB);
      CREATE TABLE web_search_config(
        id INTEGER PRIMARY KEY,
        provider TEXT,
        tavilyApiKeyEnc BLOB,
        braveApiKeyEnc BLOB
      );
      INSERT INTO web_search_config VALUES(1, 'tavily', X'0102', X'0304');
      CREATE TABLE agent_profiles(id TEXT PRIMARY KEY, executablePath TEXT);
      CREATE TABLE agent_runtime_sessions(id TEXT PRIMARY KEY);
    `)
    db.prepare('INSERT INTO ai_providers VALUES (?, ?)').run('provider-1', Buffer.from('secret'))
    db.prepare('INSERT INTO agent_profiles VALUES (?, ?)').run('profile-1', '/usr/local/bin/tool')
    db.prepare('INSERT INTO agent_runtime_sessions VALUES (?)').run('session-1')
  } finally {
    db.close()
  }
}

describe('library database storage', () => {
  it('migrates a legacy cloud database into a device-local working database', async () => {
    const root = mkdtempSync(join(tmpdir(), 'refora-library-db-'))
    const userData = join(root, 'user-data')
    const library = join(root, 'cloud-library')
    const legacy = join(library, 'refora.db')
    mkdirSync(library, { recursive: true })
    const legacyDb = new DatabaseSync(legacy)
    legacyDb.exec('CREATE TABLE marker(value TEXT); INSERT INTO marker VALUES (\'legacy\')')
    legacyDb.close()

    const prepared = await prepareLibraryDatabase(userData, library)

    expect(prepared).toMatchObject({ dbExisted: true, source: 'legacy' })
    expect(prepared.dbPath).toBe(dbPathForLibraryFolder(userData, library))
    expect(prepared.dbPath.startsWith(userData)).toBe(true)
    const working = new DatabaseSync(prepared.dbPath, { readOnly: true })
    expect(working.prepare('SELECT value FROM marker').get()).toEqual({ value: 'legacy' })
    working.close()
    const original = new DatabaseSync(legacy, { readOnly: true })
    expect(original.prepare('SELECT value FROM marker').get()).toEqual({ value: 'legacy' })
    original.close()
  })

  it('publishes a sanitized immutable snapshot and restores it on another device', async () => {
    const root = mkdtempSync(join(tmpdir(), 'refora-library-snapshot-'))
    const firstUserData = join(root, 'first-user-data')
    const secondUserData = join(root, 'second-user-data')
    const library = join(root, 'cloud-library')
    const workingPath = dbPathForLibraryFolder(firstUserData, library)
    mkdirSync(join(workingPath, '..'), { recursive: true })
    createPortableSource(workingPath)

    const manifest = await createLibrarySnapshot({
      dbPath: workingPath,
      libraryFolder: library,
      baseSequence: 42
    })

    expect(manifest).not.toBeNull()
    expect(manifest?.baseSequence).toBe(42)
    const manifestPath = join(
      snapshotDirectoryForLibraryFolder(library),
      `${manifest?.snapshotId}.json`
    )
    expect(JSON.parse(readFileSync(manifestPath, 'utf8')) as LibrarySnapshotManifest)
      .toEqual(manifest)

    const unchanged = await createLibrarySnapshot({
      dbPath: workingPath,
      libraryFolder: library,
      baseSequence: 43
    })
    expect(unchanged?.snapshotId).toBe(manifest?.snapshotId)
    expect(readdirSync(snapshotDirectoryForLibraryFolder(library)).sort()).toEqual([
      `${manifest?.snapshotId}.db`,
      `${manifest?.snapshotId}.json`
    ])

    const changedDb = new DatabaseSync(workingPath)
    changedDb.prepare("UPDATE settings SET value = '\"updated\"' WHERE key = 'durableMarker'").run()
    changedDb.close()
    const updatedManifest = await createLibrarySnapshot({
      dbPath: workingPath,
      libraryFolder: library,
      baseSequence: 44
    })
    expect(updatedManifest?.snapshotId).not.toBe(manifest?.snapshotId)
    expect(updatedManifest?.baseSequence).toBe(44)
    expect(existsSync(manifestPath)).toBe(false)
    expect(readdirSync(snapshotDirectoryForLibraryFolder(library)).sort()).toEqual([
      `${updatedManifest?.snapshotId}.db`,
      `${updatedManifest?.snapshotId}.json`
    ])

    const restored = await prepareLibraryDatabase(secondUserData, library)
    expect(restored).toMatchObject({ source: 'snapshot', dbExisted: true })
    const db = new DatabaseSync(restored.dbPath, { readOnly: true })
    try {
      expect(db.prepare('SELECT enabled, remoteLibraryId FROM sync_state').get()).toEqual({
        enabled: 0,
        remoteLibraryId: null
      })
      expect(db.prepare('SELECT apiKeyEnc FROM ai_providers').get()).toEqual({ apiKeyEnc: null })
      expect(db.prepare("SELECT value FROM settings WHERE key = 'libraryFolderPath'").get())
        .toBeUndefined()
      expect(db.prepare("SELECT value FROM settings WHERE key = 'durableMarker'").get())
        .toEqual({ value: '"updated"' })
      expect(db.prepare('SELECT count(*) AS count FROM watch_folders').get()).toEqual({ count: 0 })
      expect(db.prepare('SELECT count(*) AS count FROM agent_runtime_sessions').get())
        .toEqual({ count: 0 })
    } finally {
      db.close()
    }
  })

  it('replaces an existing working database when the cloud snapshot advances', async () => {
    const root = mkdtempSync(join(tmpdir(), 'refora-library-reconcile-'))
    const firstUserData = join(root, 'first-user-data')
    const secondUserData = join(root, 'second-user-data')
    const library = join(root, 'cloud-library')
    const firstWorkingPath = dbPathForLibraryFolder(firstUserData, library)
    mkdirSync(join(firstWorkingPath, '..'), { recursive: true })
    createPortableSource(firstWorkingPath)
    const firstSnapshot = await createLibrarySnapshot({
      dbPath: firstWorkingPath,
      libraryFolder: library
    })

    const secondPrepared = await prepareLibraryDatabase(secondUserData, library)
    expect(secondPrepared.restoredSnapshot?.snapshotId).toBe(firstSnapshot?.snapshotId)
    const syncState = new SyncStateDatabase(secondUserData)
    const staleSyncState = syncState.open()
    staleSyncState.prepare(`
      INSERT INTO library_state(libraryId, cursor, initialized, lastSyncedAt, lastError)
      VALUES (?, 88, 1, 123, 'stale')
      ON CONFLICT(libraryId) DO UPDATE SET
        cursor = 88, initialized = 1, lastSyncedAt = 123, lastError = 'stale'
    `).run('10000000-0000-0000-0000-000000000010')
    staleSyncState.prepare(`
      INSERT INTO entity_state(
        libraryId, entityType, entityId, version, sequence, payloadHash, deleted
      ) VALUES (?, 'category', 'category-1', 2, 88, 'stale-hash', 0)
    `).run('10000000-0000-0000-0000-000000000010')
    staleSyncState.prepare(`
      INSERT INTO outbox(
        operationId, libraryId, entityType, entityId, baseVersion,
        deleted, payloadJson, payloadHash, createdAt
      ) VALUES ('operation-1', ?, 'category', 'category-1', 2, 0, '{}', 'stale-hash', 123)
    `).run('10000000-0000-0000-0000-000000000010')
    staleSyncState.prepare(`
      INSERT INTO conflicts(
        id, libraryId, entityType, entityId, localDeleted, localPayloadJson,
        remoteDeleted, remotePayloadJson, remoteVersion, remoteSequence, createdAt
      ) VALUES ('conflict-1', ?, 'category', 'category-2', 0, '{}', 0, '{}', 2, 88, 123)
    `).run('10000000-0000-0000-0000-000000000010')
    staleSyncState.close()
    const firstDevice = new DatabaseSync(firstWorkingPath)
    firstDevice.prepare("UPDATE settings SET value = '\"cloud-newer\"' WHERE key = 'durableMarker'").run()
    firstDevice.close()
    const newerSnapshot = await createLibrarySnapshot({
      dbPath: firstWorkingPath,
      libraryFolder: library
    })
    expect(newerSnapshot?.snapshotId).not.toBe(firstSnapshot?.snapshotId)

    const secondDevice = new DatabaseSync(secondPrepared.dbPath)
    secondDevice.prepare(`
      UPDATE sync_state SET enabled = 1, remoteLibraryId = libraryId, updatedAt = 999 WHERE id = 1
    `).run()
    secondDevice.prepare("UPDATE ai_providers SET apiKeyEnc = ? WHERE id = 'provider-1'")
      .run(Buffer.from('device-secret'))
    secondDevice.close()

    const reconciled = await prepareLibraryDatabase(secondUserData, library)
    expect(reconciled).toMatchObject({ source: 'snapshot', dbExisted: true })
    expect(reconciled.restoredSnapshot?.snapshotId).toBe(newerSnapshot?.snapshotId)
    const reconciledDb = new DatabaseSync(reconciled.dbPath, { readOnly: true })
    expect(reconciledDb.prepare("SELECT value FROM settings WHERE key = 'durableMarker'").get())
      .toEqual({ value: '"cloud-newer"' })
    expect(reconciledDb.prepare('SELECT enabled, remoteLibraryId, updatedAt FROM sync_state').get())
      .toEqual({
        enabled: 1,
        remoteLibraryId: '10000000-0000-0000-0000-000000000010',
        updatedAt: 999
      })
    const preservedProvider = reconciledDb.prepare(`
      SELECT apiKeyEnc FROM ai_providers WHERE id = 'provider-1'
    `).get() as { apiKeyEnc: Uint8Array }
    expect(Buffer.from(preservedProvider.apiKeyEnc).toString()).toBe('device-secret')
    reconciledDb.close()

    const resetSyncState = syncState.open()
    expect(resetSyncState.prepare(`
      SELECT cursor, initialized, lastSyncedAt, lastError
      FROM library_state WHERE libraryId = ?
    `).get('10000000-0000-0000-0000-000000000010')).toEqual({
      cursor: 0,
      initialized: 0,
      lastSyncedAt: null,
      lastError: null
    })
    for (const table of ['entity_state', 'outbox', 'conflicts']) {
      expect(resetSyncState.prepare(`SELECT count(*) AS count FROM ${table} WHERE libraryId = ?`)
        .get('10000000-0000-0000-0000-000000000010')).toEqual({ count: 0 })
    }
    resetSyncState.close()

    const localAfterReconcile = new DatabaseSync(reconciled.dbPath)
    localAfterReconcile.prepare("UPDATE settings SET value = '\"local-after-reconcile\"' WHERE key = 'durableMarker'").run()
    localAfterReconcile.close()

    const firstDeviceAgain = new DatabaseSync(firstWorkingPath)
    firstDeviceAgain.prepare("UPDATE settings SET value = '\"cloud-newest\"' WHERE key = 'durableMarker'").run()
    firstDeviceAgain.close()
    const cloudNewest = await createLibrarySnapshot({
      dbPath: firstWorkingPath,
      libraryFolder: library
    })
    expect(cloudNewest?.snapshotId).not.toBe(newerSnapshot?.snapshotId)

    await expect(createLibrarySnapshot({
      dbPath: reconciled.dbPath,
      libraryFolder: library
    })).rejects.toMatchObject({ code: 'library_snapshot_conflict' })

    const protectedLocal = await prepareLibraryDatabase(secondUserData, library)
    expect(protectedLocal.source).toBe('working')
    const retainedLocal = new DatabaseSync(protectedLocal.dbPath, { readOnly: true })
    expect(retainedLocal.prepare("SELECT value FROM settings WHERE key = 'durableMarker'").get())
      .toEqual({ value: '"local-after-reconcile"' })
    retainedLocal.close()

    const publishedAfterSync = await createLibrarySnapshot({
      dbPath: protectedLocal.dbPath,
      libraryFolder: library,
      baseSequence: 99
    })
    expect(publishedAfterSync?.snapshotId).not.toBe(cloudNewest?.snapshotId)
    expect(publishedAfterSync?.baseSequence).toBe(99)
    expect(readdirSync(snapshotDirectoryForLibraryFolder(library)).sort()).toEqual([
      `${publishedAfterSync?.snapshotId}.db`,
      `${publishedAfterSync?.snapshotId}.json`
    ])
  })

  it('adopts a previously local bootstrap database after discovering its library folder', async () => {
    const root = mkdtempSync(join(tmpdir(), 'refora-library-adopt-'))
    const userData = join(root, 'user-data')
    const library = join(root, 'cloud-library')
    const bootstrapPath = join(userData, 'working.db')
    mkdirSync(userData, { recursive: true })
    createPortableSource(bootstrapPath)
    const bootstrap = new DatabaseSync(bootstrapPath)
    bootstrap.prepare("UPDATE settings SET value = ? WHERE key = 'libraryFolderPath'")
      .run(JSON.stringify(library))
    bootstrap.close()

    expect(readLibraryFolderFromDatabase(bootstrapPath)).toBe(library)
    const adopted = await adoptDatabaseForLibrary(userData, library, bootstrapPath)

    expect(adopted.dbPath).toBe(dbPathForLibraryFolder(userData, library))
    const db = new DatabaseSync(adopted.dbPath, { readOnly: true })
    expect(db.prepare("SELECT value FROM settings WHERE key = 'durableMarker'").get())
      .toEqual({ value: '"preserved"' })
    db.close()
  })
})
