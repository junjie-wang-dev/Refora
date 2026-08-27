import { hostname } from 'node:os'
import { basename } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import type {
  SyncConflict,
  SyncConflictResolution,
  SyncLibraryStatus
} from '../../shared/sync-types'
import { MainProcessError } from './errors'
import {
  applySyncEntity,
  canonicalJson,
  isSyncDependencyUnavailableError,
  scanSyncEntities,
  syncPayloadHash,
  type LocalSyncEntity
} from './syncMetadata'
import type {
  RemoteSyncEntity,
  SupabaseSyncClient,
  SyncEntityType
} from './supabaseSync'
import { SyncStateDatabase } from './syncStateDatabase'

export interface ActiveLibraryContext {
  dbPath: string
  libraryFolder: string
}

interface MetadataSyncEngineDeps {
  state: SyncStateDatabase
  remote: SupabaseSyncClient
  getLibrary: () => ActiveLibraryContext | null
  createSnapshot?: (context: ActiveLibraryContext, baseSequence: number) => Promise<void>
  onRemoteApplied?: (context: ActiveLibraryContext) => void
}

interface LibraryIdentity {
  libraryId: string
  enabled: boolean
}

interface StateEntityRow {
  entityType: SyncEntityType
  entityId: string
  version: number
  sequence: number
  payloadHash: string
  deleted: number
}

interface OutboxRow {
  operationId: string
  entityType: SyncEntityType
  entityId: string
  baseVersion: number
  deleted: number
  payloadJson: string
  payloadHash: string
}

interface ConflictRow {
  id: string
  entityType: SyncEntityType
  entityId: string
  localDeleted: number
  localPayloadJson: string
  remoteDeleted: number
  remotePayloadJson: string
  remoteVersion: number
  remoteSequence: number
  createdAt: number
}

interface DeferredRow {
  entityType: SyncEntityType
  entityId: string
  version: number
  sequence: number
  deleted: number
  payloadJson: string
  updatedAt: string
}

interface RunningSync {
  libraryId: string
  promise: Promise<void>
}

function libraryIdentity(dbPath: string): LibraryIdentity {
  const db = new DatabaseSync(dbPath)
  try {
    db.exec('PRAGMA busy_timeout = 5000')
    const row = db.prepare('SELECT libraryId, enabled FROM sync_state WHERE id = 1').get() as
      | { libraryId?: unknown; enabled?: unknown }
      | undefined
    if (!row || typeof row.libraryId !== 'string') {
      throw new MainProcessError('sync_library_unavailable', 'The active library has no sync identity')
    }
    return { libraryId: row.libraryId, enabled: row.enabled === 1 }
  } finally {
    db.close()
  }
}

function setLibraryEnabled(dbPath: string, enabled: boolean): LibraryIdentity {
  const db = new DatabaseSync(dbPath)
  try {
    db.exec('PRAGMA busy_timeout = 5000')
    db.prepare(`
      UPDATE sync_state
      SET enabled = ?, remoteLibraryId = CASE WHEN ? = 1 THEN libraryId ELSE remoteLibraryId END,
          updatedAt = ?
      WHERE id = 1
    `).run(enabled ? 1 : 0, enabled ? 1 : 0, Date.now())
  } finally {
    db.close()
  }
  return libraryIdentity(dbPath)
}

function parsePayload(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Stored sync payload is invalid')
  }
  return parsed as Record<string, unknown>
}

function key(entityType: SyncEntityType, entityId: string): string {
  return `${entityType}\u0000${entityId}`
}

function ensureLibraryState(db: DatabaseSync, libraryId: string): void {
  db.prepare('INSERT OR IGNORE INTO library_state(libraryId) VALUES (?)').run(libraryId)
}

function stateEntities(db: DatabaseSync, libraryId: string): Map<string, StateEntityRow> {
  const result = new Map<string, StateEntityRow>()
  const values = db.prepare(`
    SELECT entityType, entityId, version, sequence, payloadHash, deleted
    FROM entity_state WHERE libraryId = ?
  `).all(libraryId) as unknown as StateEntityRow[]
  for (const value of values) result.set(key(value.entityType, value.entityId), value)
  return result
}

function unresolvedConflictKeys(db: DatabaseSync, libraryId: string): Set<string> {
  return new Set(
    (db.prepare('SELECT entityType, entityId FROM conflicts WHERE libraryId = ?')
      .all(libraryId) as Array<{ entityType: SyncEntityType; entityId: string }>)
      .map((row) => key(row.entityType, row.entityId))
  )
}

function deferredEntityKeys(db: DatabaseSync, libraryId: string): Set<string> {
  return new Set(
    (db.prepare('SELECT entityType, entityId FROM deferred_entities WHERE libraryId = ?')
      .all(libraryId) as Array<{ entityType: SyncEntityType; entityId: string }>)
      .map((row) => key(row.entityType, row.entityId))
  )
}

function queueEntity(
  db: DatabaseSync,
  libraryId: string,
  entity: LocalSyncEntity,
  baseVersion: number
): boolean {
  const existing = db.prepare(`
    SELECT operationId, payloadHash, deleted FROM outbox
    WHERE libraryId = ? AND entityType = ? AND entityId = ?
  `).get(libraryId, entity.entityType, entity.entityId) as
    | { operationId: string; payloadHash: string; deleted: number }
    | undefined
  if (
    existing
    && existing.payloadHash === entity.payloadHash
    && existing.deleted === (entity.deleted ? 1 : 0)
  ) return false
  db.prepare(`
    INSERT INTO outbox(
      operationId, libraryId, entityType, entityId, baseVersion,
      deleted, payloadJson, payloadHash, createdAt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(libraryId, entityType, entityId) DO UPDATE SET
      operationId = excluded.operationId,
      baseVersion = excluded.baseVersion,
      deleted = excluded.deleted,
      payloadJson = excluded.payloadJson,
      payloadHash = excluded.payloadHash,
      createdAt = excluded.createdAt
  `).run(
    randomUUID(),
    libraryId,
    entity.entityType,
    entity.entityId,
    baseVersion,
    entity.deleted ? 1 : 0,
    canonicalJson(entity.deleted ? {} : entity.payload),
    entity.payloadHash,
    Date.now()
  )
  return true
}

function scanAndQueue(dbPath: string, state: SyncStateDatabase, libraryId: string): boolean {
  const local = scanSyncEntities(dbPath)
  const db = state.open()
  let queued = false
  try {
    db.exec('BEGIN IMMEDIATE')
    try {
      ensureLibraryState(db, libraryId)
      const known = stateEntities(db, libraryId)
      const conflicts = unresolvedConflictKeys(db, libraryId)
      const deferred = deferredEntityKeys(db, libraryId)
      for (const [entityKey, entity] of local) {
        if (conflicts.has(entityKey) || deferred.has(entityKey)) continue
        const previous = known.get(entityKey)
        if (!previous || previous.deleted === 1 || previous.payloadHash !== entity.payloadHash) {
          queued = queueEntity(db, libraryId, entity, previous?.version ?? 0) || queued
        }
      }
      for (const [entityKey, previous] of known) {
        if (
          local.has(entityKey)
          || previous.deleted === 1
          || conflicts.has(entityKey)
          || deferred.has(entityKey)
        ) continue
        const payload: Record<string, unknown> = {}
        queued = queueEntity(db, libraryId, {
          entityType: previous.entityType,
          entityId: previous.entityId,
          deleted: true,
          payload,
          payloadHash: syncPayloadHash(true, payload)
        }, previous.version) || queued
      }
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  } finally {
    db.close()
  }
  return queued
}

function upsertEntityState(
  db: DatabaseSync,
  libraryId: string,
  entity: Pick<RemoteSyncEntity, 'entityType' | 'entityId' | 'version' | 'sequence' | 'deleted' | 'payload'>
): void {
  db.prepare(`
    INSERT INTO entity_state(
      libraryId, entityType, entityId, version, sequence, payloadHash, deleted
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(libraryId, entityType, entityId) DO UPDATE SET
      version = excluded.version,
      sequence = excluded.sequence,
      payloadHash = excluded.payloadHash,
      deleted = excluded.deleted
  `).run(
    libraryId,
    entity.entityType,
    entity.entityId,
    entity.version,
    entity.sequence,
    syncPayloadHash(entity.deleted, entity.payload),
    entity.deleted ? 1 : 0
  )
}

function storeConflict(
  db: DatabaseSync,
  libraryId: string,
  local: { entityType: SyncEntityType; entityId: string; deleted: boolean; payload: Record<string, unknown> },
  remote: RemoteSyncEntity
): void {
  db.prepare(`
    INSERT INTO conflicts(
      id, libraryId, entityType, entityId, localDeleted, localPayloadJson,
      remoteDeleted, remotePayloadJson, remoteVersion, remoteSequence, createdAt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(libraryId, entityType, entityId) DO UPDATE SET
      localDeleted = excluded.localDeleted,
      localPayloadJson = excluded.localPayloadJson,
      remoteDeleted = excluded.remoteDeleted,
      remotePayloadJson = excluded.remotePayloadJson,
      remoteVersion = excluded.remoteVersion,
      remoteSequence = excluded.remoteSequence,
      createdAt = excluded.createdAt
  `).run(
    randomUUID(),
    libraryId,
    local.entityType,
    local.entityId,
    local.deleted ? 1 : 0,
    canonicalJson(local.deleted ? {} : local.payload),
    remote.deleted ? 1 : 0,
    canonicalJson(remote.deleted ? {} : remote.payload),
    remote.version,
    remote.sequence,
    Date.now()
  )
}

function storeDeferred(db: DatabaseSync, libraryId: string, remote: RemoteSyncEntity): void {
  db.prepare(`
    INSERT INTO deferred_entities(
      libraryId, entityType, entityId, version, sequence, deleted, payloadJson, updatedAt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(libraryId, entityType, entityId) DO UPDATE SET
      version = excluded.version,
      sequence = excluded.sequence,
      deleted = excluded.deleted,
      payloadJson = excluded.payloadJson,
      updatedAt = excluded.updatedAt
  `).run(
    libraryId,
    remote.entityType,
    remote.entityId,
    remote.version,
    remote.sequence,
    remote.deleted ? 1 : 0,
    canonicalJson(remote.deleted ? {} : remote.payload),
    remote.updatedAt
  )
}

function dependencyOrder(entityType: SyncEntityType): number {
  if (entityType === 'document_user_data') return 1
  if (entityType === 'category') return 2
  if (entityType === 'workspace') return 3
  if (entityType === 'workspace_note') return 4
  if (entityType === 'document_category') return 5
  if (entityType === 'workspace_layout') return 6
  if (entityType === 'workspace_connection') return 7
  if (entityType === 'pdf_annotation') return 8
  if (entityType === 'agent_memory') return 9
  return 10
}

function hasSnapshotBlockers(state: SyncStateDatabase, libraryId: string): boolean {
  const db = state.open()
  try {
    const row = db.prepare(`
      SELECT
        (SELECT count(*) FROM conflicts WHERE libraryId = ?) AS conflicts,
        (SELECT count(*) FROM deferred_entities WHERE libraryId = ?) AS deferred
    `).get(libraryId, libraryId) as { conflicts: number; deferred: number }
    return row.conflicts > 0 || row.deferred > 0
  } finally {
    db.close()
  }
}

export function createMetadataSyncEngine(deps: MetadataSyncEngineDeps) {
  let running: RunningSync | null = null

  function requireLibrary(): ActiveLibraryContext {
    const context = deps.getLibrary()
    if (!context?.dbPath || !context.libraryFolder) {
      throw new MainProcessError('sync_library_unavailable', 'Choose a library folder before enabling sync')
    }
    return context
  }

  function statusForContext(context: ActiveLibraryContext): SyncLibraryStatus {
    const identity = libraryIdentity(context.dbPath)
    const db = deps.state.open()
    try {
      ensureLibraryState(db, identity.libraryId)
      const library = db.prepare(`
        SELECT lastSyncedAt, lastError FROM library_state WHERE libraryId = ?
      `).get(identity.libraryId) as { lastSyncedAt: number | null; lastError: string | null }
      const pending = db.prepare(`
        SELECT
          (SELECT count(*) FROM outbox WHERE libraryId = ?) +
          (SELECT count(*) FROM deferred_entities WHERE libraryId = ?) AS count
      `).get(identity.libraryId, identity.libraryId) as { count: number }
      const conflicts = db.prepare('SELECT count(*) AS count FROM conflicts WHERE libraryId = ?')
        .get(identity.libraryId) as { count: number }
      return {
        libraryId: identity.libraryId,
        enabled: identity.enabled,
        running: running?.libraryId === identity.libraryId,
        lastSyncedAt: library.lastSyncedAt,
        lastError: library.lastError,
        pendingCount: pending.count,
        conflictCount: conflicts.count,
        storageMode: 'local-working-cloud-snapshots'
      }
    } finally {
      db.close()
    }
  }

  function drainDeferred(
    context: ActiveLibraryContext,
    libraryId: string
  ): { applied: boolean } {
    let applied = false
    let progressed = true
    while (progressed) {
      progressed = false
      const db = deps.state.open()
      let deferred: DeferredRow[]
      try {
        deferred = db.prepare(`
          SELECT entityType, entityId, version, sequence, deleted, payloadJson, updatedAt
          FROM deferred_entities WHERE libraryId = ?
        `).all(libraryId) as unknown as DeferredRow[]
      } finally {
        db.close()
      }
      deferred.sort((left, right) =>
        dependencyOrder(left.entityType) - dependencyOrder(right.entityType)
        || left.sequence - right.sequence)
      for (const item of deferred) {
        const remote: RemoteSyncEntity = {
          entityType: item.entityType,
          entityId: item.entityId,
          version: item.version,
          sequence: item.sequence,
          deleted: item.deleted === 1,
          payload: parsePayload(item.payloadJson),
          updatedAt: item.updatedAt
        }
        try {
          applySyncEntity(
            context.dbPath,
            remote.entityType,
            remote.entityId,
            remote.deleted,
            remote.payload
          )
          const stateDb = deps.state.open()
          try {
            stateDb.prepare(`
              DELETE FROM deferred_entities
              WHERE libraryId = ? AND entityType = ? AND entityId = ?
            `).run(libraryId, remote.entityType, remote.entityId)
          } finally {
            stateDb.close()
          }
          applied = true
          progressed = true
        } catch (error) {
          if (isSyncDependencyUnavailableError(error)) continue
          const local = scanSyncEntities(context.dbPath).get(key(remote.entityType, remote.entityId))
          const stateDb = deps.state.open()
          try {
            stateDb.exec('BEGIN IMMEDIATE')
            storeConflict(stateDb, libraryId, local ?? {
              entityType: remote.entityType,
              entityId: remote.entityId,
              deleted: true,
              payload: {}
            }, remote)
            stateDb.prepare(`
              DELETE FROM deferred_entities
              WHERE libraryId = ? AND entityType = ? AND entityId = ?
            `).run(libraryId, remote.entityType, remote.entityId)
            stateDb.exec('COMMIT')
          } catch (stateError) {
            stateDb.exec('ROLLBACK')
            throw stateError
          } finally {
            stateDb.close()
          }
          progressed = true
        }
      }
    }
    return { applied }
  }

  async function pullAll(
    accessToken: string,
    context: ActiveLibraryContext,
    libraryId: string,
    deviceId: string
  ): Promise<{ cursor: number; applied: boolean }> {
    const stateDb = deps.state.open()
    let cursor: number
    try {
      ensureLibraryState(stateDb, libraryId)
      const row = stateDb.prepare('SELECT cursor FROM library_state WHERE libraryId = ?')
        .get(libraryId) as { cursor: number }
      cursor = row.cursor
    } finally {
      stateDb.close()
    }
    let applied = false
    while (true) {
      const page = await deps.remote.pull(accessToken, libraryId, cursor, 500)
      if (page.length === 0) break
      for (const remote of page) {
        if (remote.sequence <= cursor) continue
        const db = deps.state.open()
        let pending: OutboxRow | undefined
        try {
          pending = db.prepare(`
            SELECT operationId, entityType, entityId, baseVersion, deleted, payloadJson, payloadHash
            FROM outbox WHERE libraryId = ? AND entityType = ? AND entityId = ?
          `).get(libraryId, remote.entityType, remote.entityId) as OutboxRow | undefined
        } finally {
          db.close()
        }
        if (pending) {
          const remoteHash = syncPayloadHash(remote.deleted, remote.payload)
          const dbForPending = deps.state.open()
          try {
            dbForPending.exec('BEGIN IMMEDIATE')
            if (pending.payloadHash === remoteHash && pending.deleted === (remote.deleted ? 1 : 0)) {
              dbForPending.prepare('DELETE FROM outbox WHERE operationId = ?').run(pending.operationId)
            } else {
              storeConflict(dbForPending, libraryId, {
                entityType: pending.entityType,
                entityId: pending.entityId,
                deleted: pending.deleted === 1,
                payload: parsePayload(pending.payloadJson)
              }, remote)
              dbForPending.prepare('DELETE FROM outbox WHERE operationId = ?').run(pending.operationId)
            }
            dbForPending.prepare(`
              DELETE FROM deferred_entities
              WHERE libraryId = ? AND entityType = ? AND entityId = ?
            `).run(libraryId, remote.entityType, remote.entityId)
            upsertEntityState(dbForPending, libraryId, remote)
            cursor = remote.sequence
            dbForPending.prepare('UPDATE library_state SET cursor = ? WHERE libraryId = ?')
              .run(cursor, libraryId)
            dbForPending.exec('COMMIT')
          } catch (error) {
            dbForPending.exec('ROLLBACK')
            throw error
          } finally {
            dbForPending.close()
          }
          continue
        }
        try {
          applySyncEntity(
            context.dbPath,
            remote.entityType,
            remote.entityId,
            remote.deleted,
            remote.payload
          )
          applied = true
          const dbForRemote = deps.state.open()
          try {
            dbForRemote.exec('BEGIN IMMEDIATE')
            dbForRemote.prepare(`
              DELETE FROM deferred_entities
              WHERE libraryId = ? AND entityType = ? AND entityId = ?
            `).run(libraryId, remote.entityType, remote.entityId)
            upsertEntityState(dbForRemote, libraryId, remote)
            cursor = remote.sequence
            dbForRemote.prepare('UPDATE library_state SET cursor = ? WHERE libraryId = ?')
              .run(cursor, libraryId)
            dbForRemote.exec('COMMIT')
          } catch (error) {
            dbForRemote.exec('ROLLBACK')
            throw error
          } finally {
            dbForRemote.close()
          }
        } catch (error) {
          const dbForFailure = deps.state.open()
          try {
            dbForFailure.exec('BEGIN IMMEDIATE')
            if (isSyncDependencyUnavailableError(error)) {
              storeDeferred(dbForFailure, libraryId, remote)
            } else {
              const local = scanSyncEntities(context.dbPath)
                .get(key(remote.entityType, remote.entityId))
              storeConflict(dbForFailure, libraryId, local ?? {
                entityType: remote.entityType,
                entityId: remote.entityId,
                deleted: true,
                payload: {}
              }, remote)
            }
            upsertEntityState(dbForFailure, libraryId, remote)
            cursor = remote.sequence
            dbForFailure.prepare('UPDATE library_state SET cursor = ? WHERE libraryId = ?')
              .run(cursor, libraryId)
            dbForFailure.exec('COMMIT')
          } catch (stateError) {
            dbForFailure.exec('ROLLBACK')
            throw stateError
          } finally {
            dbForFailure.close()
          }
        }
      }
      if (page.length < 500) break
    }
    const deferred = drainDeferred(context, libraryId)
    applied ||= deferred.applied
    await deps.remote.saveCursor(accessToken, libraryId, deviceId, cursor)
    return { cursor, applied }
  }

  async function pushAll(
    accessToken: string,
    libraryId: string,
    deviceId: string
  ): Promise<{ conflicted: boolean; applied: boolean }> {
    const db = deps.state.open()
    let outbox: OutboxRow[]
    try {
      outbox = db.prepare(`
        SELECT operationId, entityType, entityId, baseVersion, deleted, payloadJson, payloadHash
        FROM outbox WHERE libraryId = ?
        ORDER BY CASE entityType
          WHEN 'document_user_data' THEN 1
          WHEN 'category' THEN 2
          WHEN 'workspace' THEN 3
          WHEN 'workspace_note' THEN 4
          WHEN 'document_category' THEN 5
          WHEN 'workspace_layout' THEN 6
          WHEN 'workspace_connection' THEN 7
          WHEN 'pdf_annotation' THEN 8
          WHEN 'agent_memory' THEN 9
          ELSE 10 END, rowid
      `).all(libraryId) as unknown as OutboxRow[]
    } finally {
      db.close()
    }
    let conflicted = false
    let applied = false
    for (const item of outbox) {
      const payload = parsePayload(item.payloadJson)
      const result = await deps.remote.push(accessToken, {
        libraryId,
        deviceId,
        operationId: item.operationId,
        entityType: item.entityType,
        entityId: item.entityId,
        baseVersion: item.baseVersion,
        deleted: item.deleted === 1,
        payload
      })
      if (result.status === 'conflict') {
        conflicted = true
        continue
      }
      const stateDb = deps.state.open()
      try {
        stateDb.exec('BEGIN IMMEDIATE')
        upsertEntityState(stateDb, libraryId, {
          entityType: item.entityType,
          entityId: item.entityId,
          version: result.version,
          sequence: result.sequence,
          deleted: item.deleted === 1,
          payload
        })
        stateDb.prepare('DELETE FROM outbox WHERE operationId = ?').run(item.operationId)
        stateDb.exec('COMMIT')
      } catch (error) {
        stateDb.exec('ROLLBACK')
        throw error
      } finally {
        stateDb.close()
      }
      applied = true
    }
    return { conflicted, applied }
  }

  async function performSync(
    accessToken: string,
    context: ActiveLibraryContext,
    identity: LibraryIdentity
  ): Promise<void> {
    if (!identity.enabled) throw new MainProcessError('sync_disabled', 'Sync is disabled for this library')
    const deviceId = deps.state.deviceId()
    const libraryName = basename(context.libraryFolder) || 'Refora Library'
    await deps.remote.registerLibrary(accessToken, identity.libraryId, libraryName)
    await deps.remote.registerDevice(accessToken, deviceId, hostname().slice(0, 200) || 'Mac')
    const stateDb = deps.state.open()
    let initialized: boolean
    try {
      ensureLibraryState(stateDb, identity.libraryId)
      const row = stateDb.prepare('SELECT initialized FROM library_state WHERE libraryId = ?')
        .get(identity.libraryId) as { initialized: number }
      initialized = row.initialized === 1
    } finally {
      stateDb.close()
    }
    scanAndQueue(context.dbPath, deps.state, identity.libraryId)
    const beforePush = await pullAll(accessToken, context, identity.libraryId, deviceId)
    let remoteApplied = beforePush.applied
    if (!initialized) {
      const db = deps.state.open()
      try {
        db.prepare('UPDATE library_state SET initialized = 1 WHERE libraryId = ?')
          .run(identity.libraryId)
      } finally {
        db.close()
      }
    }
    const pushed = await pushAll(accessToken, identity.libraryId, deviceId)
    const afterPush = await pullAll(accessToken, context, identity.libraryId, deviceId)
    remoteApplied ||= afterPush.applied
    if (pushed.conflicted && afterPush.cursor === beforePush.cursor) {
      throw new MainProcessError('sync_conflict_unavailable', 'A sync conflict could not be downloaded yet')
    }
    const completedAt = Date.now()
    const completedDb = deps.state.open()
    try {
      completedDb.prepare(`
        UPDATE library_state SET lastSyncedAt = ?, lastError = NULL WHERE libraryId = ?
      `).run(completedAt, identity.libraryId)
    } finally {
      completedDb.close()
    }
    if (remoteApplied) deps.onRemoteApplied?.(context)
    if ((pushed.applied || remoteApplied) && !hasSnapshotBlockers(deps.state, identity.libraryId)) {
      await deps.createSnapshot?.(context, afterPush.cursor)
    }
  }

  return {
    status(): SyncLibraryStatus | null {
      const context = deps.getLibrary()
      if (!context?.dbPath || !context.libraryFolder) return null
      return statusForContext(context)
    },
    setEnabled(enabled: boolean): SyncLibraryStatus | null {
      const context = requireLibrary()
      setLibraryEnabled(context.dbPath, enabled)
      return statusForContext(context)
    },
    async run(accessToken: string): Promise<void> {
      const context = requireLibrary()
      const identity = libraryIdentity(context.dbPath)
      while (running) {
        if (running.libraryId === identity.libraryId) return running.promise
        await running.promise.catch(() => undefined)
      }
      const promise = performSync(accessToken, context, identity).catch((error) => {
        const db = deps.state.open()
        try {
          ensureLibraryState(db, identity.libraryId)
          db.prepare('UPDATE library_state SET lastError = ? WHERE libraryId = ?')
            .run(error instanceof Error ? error.message : String(error), identity.libraryId)
        } finally {
          db.close()
        }
        throw error
      }).finally(() => {
        if (running?.promise === promise) running = null
      })
      running = { libraryId: identity.libraryId, promise }
      return promise
    },
    async waitForIdle(): Promise<void> {
      while (running) await running.promise
    },
    conflicts(): SyncConflict[] {
      const context = requireLibrary()
      const identity = libraryIdentity(context.dbPath)
      const db = deps.state.open()
      try {
        return (db.prepare(`
          SELECT id, entityType, entityId, createdAt
          FROM conflicts WHERE libraryId = ? ORDER BY createdAt
        `).all(identity.libraryId) as unknown as SyncConflict[])
      } finally {
        db.close()
      }
    },
    async resolveConflict(
      conflictId: string,
      resolution: SyncConflictResolution
    ): Promise<void> {
      while (running) await running.promise
      const context = requireLibrary()
      const identity = libraryIdentity(context.dbPath)
      const db = deps.state.open()
      let remoteSequence: number | null = null
      try {
        const conflict = db.prepare(`
          SELECT id, entityType, entityId, localDeleted, localPayloadJson,
                 remoteDeleted, remotePayloadJson, remoteVersion, remoteSequence, createdAt
          FROM conflicts WHERE id = ? AND libraryId = ?
        `).get(conflictId, identity.libraryId) as ConflictRow | undefined
        if (!conflict) throw new MainProcessError('sync_conflict_not_found', 'Sync conflict was not found')
        if (resolution === 'use_remote') {
          applySyncEntity(
            context.dbPath,
            conflict.entityType,
            conflict.entityId,
            conflict.remoteDeleted === 1,
            parsePayload(conflict.remotePayloadJson)
          )
          db.exec('BEGIN IMMEDIATE')
          try {
            upsertEntityState(db, identity.libraryId, {
              entityType: conflict.entityType,
              entityId: conflict.entityId,
              version: conflict.remoteVersion,
              sequence: conflict.remoteSequence,
              deleted: conflict.remoteDeleted === 1,
              payload: parsePayload(conflict.remotePayloadJson)
            })
            db.prepare('DELETE FROM conflicts WHERE id = ?').run(conflict.id)
            db.exec('COMMIT')
          } catch (error) {
            db.exec('ROLLBACK')
            throw error
          }
          remoteSequence = conflict.remoteSequence
        } else {
          db.exec('BEGIN IMMEDIATE')
          try {
            queueEntity(db, identity.libraryId, {
              entityType: conflict.entityType,
              entityId: conflict.entityId,
              deleted: conflict.localDeleted === 1,
              payload: parsePayload(conflict.localPayloadJson),
              payloadHash: syncPayloadHash(
                conflict.localDeleted === 1,
                parsePayload(conflict.localPayloadJson)
              )
            }, conflict.remoteVersion)
            db.prepare('DELETE FROM conflicts WHERE id = ?').run(conflict.id)
            db.exec('COMMIT')
          } catch (error) {
            db.exec('ROLLBACK')
            throw error
          }
        }
      } finally {
        db.close()
      }
      if (remoteSequence !== null) {
        deps.onRemoteApplied?.(context)
        if (!hasSnapshotBlockers(deps.state, identity.libraryId)) {
          await deps.createSnapshot?.(context, remoteSequence)
        }
      }
    }
  }
}

export type MetadataSyncEngine = ReturnType<typeof createMetadataSyncEngine>
