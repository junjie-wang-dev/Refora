import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export class SyncStateDatabase {
  readonly path: string

  constructor(userDataDir: string) {
    this.path = join(userDataDir, 'refora-sync-state.db')
    mkdirSync(dirname(this.path), { recursive: true })
    const db = this.open()
    try {
      const versionRow = db.prepare('PRAGMA user_version').get() as Record<string, unknown>
      const version = Number(Object.values(versionRow)[0] ?? 0)
      if (version > 2) throw new Error('Sync state database is newer than this Refora version')
      if (version === 0) db.exec(`
        BEGIN IMMEDIATE;
        CREATE TABLE IF NOT EXISTS device_identity (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          deviceId TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS library_state (
          libraryId TEXT PRIMARY KEY,
          cursor INTEGER NOT NULL DEFAULT 0,
          initialized INTEGER NOT NULL DEFAULT 0 CHECK (initialized IN (0, 1)),
          lastSyncedAt INTEGER,
          lastError TEXT
        );
        CREATE TABLE IF NOT EXISTS entity_state (
          libraryId TEXT NOT NULL,
          entityType TEXT NOT NULL,
          entityId TEXT NOT NULL,
          version INTEGER NOT NULL DEFAULT 0,
          sequence INTEGER NOT NULL DEFAULT 0,
          payloadHash TEXT NOT NULL,
          deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
          PRIMARY KEY (libraryId, entityType, entityId)
        );
        CREATE TABLE IF NOT EXISTS outbox (
          operationId TEXT PRIMARY KEY,
          libraryId TEXT NOT NULL,
          entityType TEXT NOT NULL,
          entityId TEXT NOT NULL,
          baseVersion INTEGER NOT NULL,
          deleted INTEGER NOT NULL CHECK (deleted IN (0, 1)),
          payloadJson TEXT NOT NULL,
          payloadHash TEXT NOT NULL,
          createdAt INTEGER NOT NULL,
          UNIQUE (libraryId, entityType, entityId)
        );
        CREATE INDEX IF NOT EXISTS sync_outbox_library_created
        ON outbox(libraryId, createdAt);
        CREATE TABLE IF NOT EXISTS conflicts (
          id TEXT PRIMARY KEY,
          libraryId TEXT NOT NULL,
          entityType TEXT NOT NULL,
          entityId TEXT NOT NULL,
          localDeleted INTEGER NOT NULL CHECK (localDeleted IN (0, 1)),
          localPayloadJson TEXT NOT NULL,
          remoteDeleted INTEGER NOT NULL CHECK (remoteDeleted IN (0, 1)),
          remotePayloadJson TEXT NOT NULL,
          remoteVersion INTEGER NOT NULL,
          remoteSequence INTEGER NOT NULL,
          createdAt INTEGER NOT NULL,
          UNIQUE (libraryId, entityType, entityId)
        );
        CREATE INDEX IF NOT EXISTS sync_conflicts_library_created
        ON conflicts(libraryId, createdAt);
        PRAGMA user_version = 1;
        COMMIT;
      `)
      if (version < 2) db.exec(`
        BEGIN IMMEDIATE;
        CREATE TABLE IF NOT EXISTS deferred_entities (
          libraryId TEXT NOT NULL,
          entityType TEXT NOT NULL,
          entityId TEXT NOT NULL,
          version INTEGER NOT NULL,
          sequence INTEGER NOT NULL,
          deleted INTEGER NOT NULL CHECK (deleted IN (0, 1)),
          payloadJson TEXT NOT NULL,
          updatedAt TEXT NOT NULL,
          PRIMARY KEY (libraryId, entityType, entityId)
        );
        CREATE INDEX IF NOT EXISTS sync_deferred_library_sequence
        ON deferred_entities(libraryId, sequence);
        PRAGMA user_version = 2;
        COMMIT;
      `)
      db.prepare('INSERT OR IGNORE INTO device_identity(id, deviceId) VALUES (1, ?)')
        .run(randomUUID())
    } finally {
      db.close()
    }
  }

  open(): DatabaseSync {
    const db = new DatabaseSync(this.path)
    db.exec('PRAGMA busy_timeout = 5000')
    db.exec('PRAGMA journal_mode = WAL')
    return db
  }

  deviceId(): string {
    const db = this.open()
    try {
      const row = db.prepare('SELECT deviceId FROM device_identity WHERE id = 1').get() as {
        deviceId: string
      }
      return row.deviceId
    } finally {
      db.close()
    }
  }

  resetLibrary(libraryId: string): void {
    const db = this.open()
    try {
      db.exec('BEGIN IMMEDIATE')
      try {
        db.prepare('DELETE FROM conflicts WHERE libraryId = ?').run(libraryId)
        db.prepare('DELETE FROM outbox WHERE libraryId = ?').run(libraryId)
        db.prepare('DELETE FROM deferred_entities WHERE libraryId = ?').run(libraryId)
        db.prepare('DELETE FROM entity_state WHERE libraryId = ?').run(libraryId)
        db.prepare(`
          INSERT INTO library_state(libraryId, cursor, initialized, lastSyncedAt, lastError)
          VALUES (?, 0, 0, NULL, NULL)
          ON CONFLICT(libraryId) DO UPDATE SET
            cursor = 0,
            initialized = 0,
            lastSyncedAt = NULL,
            lastError = NULL
        `).run(libraryId)
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    } finally {
      db.close()
    }
  }
}
