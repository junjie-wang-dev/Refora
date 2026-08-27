import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it, vi } from 'vitest'
import { createMetadataSyncEngine } from '../../src/main/services/metadataSyncEngine'
import {
  applySyncEntity,
  scanSyncEntities,
  SyncDependencyUnavailableError
} from '../../src/main/services/syncMetadata'
import { SyncStateDatabase } from '../../src/main/services/syncStateDatabase'
import type {
  RemoteSyncEntity,
  SupabaseSyncClient,
  SyncEntityType,
  SyncPushRequest,
  SyncPushResult
} from '../../src/main/services/supabaseSync'

const DOCUMENT_HASH = 'a'.repeat(64)
const MISSING_DOCUMENT_HASH = 'b'.repeat(64)
const LIBRARY_ID = '10000000-0000-0000-0000-000000000010'

function createLibraryDatabase(path: string, libraryId = LIBRARY_ID): DatabaseSync {
  mkdirSync(join(path, '..'), { recursive: true })
  const db = new DatabaseSync(path)
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE sync_state(
      id INTEGER PRIMARY KEY,
      libraryId TEXT NOT NULL,
      remoteLibraryId TEXT,
      enabled INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL
    );
    INSERT INTO sync_state VALUES(
      1,
      '${libraryId}',
      NULL,
      1,
      0
    );
    CREATE TABLE documents(
      id TEXT PRIMARY KEY,
      fileHash TEXT,
      note TEXT,
      starred INTEGER,
      lastReadAt INTEGER,
      editedFields TEXT,
      title TEXT,
      authors TEXT,
      year TEXT,
      venue TEXT,
      volume TEXT,
      issue TEXT,
      pages TEXT,
      abstract TEXT,
      keywords TEXT,
      url TEXT,
      doi TEXT,
      arxivId TEXT,
      affiliations TEXT,
      addedAt INTEGER,
      updatedAt INTEGER
    );
    CREATE TABLE categories(
      id TEXT PRIMARY KEY,
      name TEXT UNIQUE,
      sortOrder INTEGER,
      createdAt INTEGER
    );
    CREATE TABLE document_categories(
      documentId TEXT,
      categoryId TEXT,
      PRIMARY KEY(documentId, categoryId),
      FOREIGN KEY(documentId) REFERENCES documents(id) ON DELETE CASCADE,
      FOREIGN KEY(categoryId) REFERENCES categories(id) ON DELETE CASCADE
    );
    CREATE TABLE workspaces(id TEXT PRIMARY KEY, name TEXT, createdAt INTEGER, updatedAt INTEGER);
    CREATE TABLE workspace_notes(
      id TEXT PRIMARY KEY,
      workspaceId TEXT,
      title TEXT,
      contentMd TEXT,
      noteType TEXT,
      color TEXT,
      createdAt INTEGER,
      updatedAt INTEGER,
      FOREIGN KEY(workspaceId) REFERENCES workspaces(id) ON DELETE CASCADE
    );
    CREATE TABLE workspace_items(
      id TEXT PRIMARY KEY,
      workspaceId TEXT,
      kind TEXT,
      docId TEXT,
      reportId TEXT,
      noteId TEXT,
      assetId TEXT,
      sortOrder INTEGER,
      width INTEGER,
      height INTEGER,
      x REAL,
      y REAL,
      zIndex INTEGER,
      addedAt INTEGER,
      FOREIGN KEY(workspaceId) REFERENCES workspaces(id) ON DELETE CASCADE
    );
    CREATE TABLE workspace_canvas_state(
      workspaceId TEXT PRIMARY KEY,
      panX REAL,
      panY REAL,
      zoom REAL,
      updatedAt INTEGER,
      FOREIGN KEY(workspaceId) REFERENCES workspaces(id) ON DELETE CASCADE
    );
    CREATE TABLE workspace_connections(
      id TEXT PRIMARY KEY,
      workspaceId TEXT,
      sourceItemId TEXT,
      targetItemId TEXT,
      sourceAnchor TEXT,
      targetAnchor TEXT,
      createdAt INTEGER
    );
    CREATE TABLE pdf_annotations(
      documentId TEXT PRIMARY KEY,
      annotationsJson TEXT,
      updatedAt INTEGER,
      FOREIGN KEY(documentId) REFERENCES documents(id) ON DELETE CASCADE
    );
    CREATE TABLE workspace_agent_memories(
      id TEXT PRIMARY KEY,
      scope TEXT,
      scopeId TEXT,
      workspaceId TEXT,
      path TEXT,
      content TEXT,
      revision INTEGER,
      sourceThreadId TEXT,
      sourceRunId TEXT,
      createdAt INTEGER,
      updatedAt INTEGER
    );
    INSERT INTO documents VALUES(
      'doc-1', '${DOCUMENT_HASH}', 'Remember this', 1, 123, '["title"]',
      'Manual title', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      NULL, NULL, NULL, 1, 1
    );
    INSERT INTO categories VALUES('category-1', 'Reading', 0, 1);
    INSERT INTO document_categories VALUES('doc-1', 'category-1');
  `)
  return db
}

class MemoryRemote implements SupabaseSyncClient {
  readonly registerLibrary = vi.fn(async (
    _token: string,
    _libraryId: string,
    _name: string
  ) => undefined)
  readonly registerDevice = vi.fn(async (
    _token: string,
    _deviceId: string,
    _name: string
  ) => undefined)
  readonly saveCursor = vi.fn(async (
    _token: string,
    _libraryId: string,
    _deviceId: string,
    _cursor: number
  ) => undefined)
  private sequence = 0
  private readonly entities = new Map<string, RemoteSyncEntity>()

  async push(_token: string, request: SyncPushRequest): Promise<SyncPushResult> {
    const entityKey = `${request.libraryId}\u0000${request.entityType}\u0000${request.entityId}`
    const previous = this.entities.get(entityKey)
    if ((previous?.version ?? 0) !== request.baseVersion) {
      return {
        status: 'conflict',
        version: previous?.version ?? 0,
        sequence: previous?.sequence ?? 0,
        deleted: previous?.deleted ?? false
      }
    }
    const entity: RemoteSyncEntity = {
      entityType: request.entityType,
      entityId: request.entityId,
      version: request.baseVersion + 1,
      sequence: ++this.sequence,
      deleted: request.deleted,
      payload: request.deleted ? {} : request.payload,
      updatedAt: new Date().toISOString()
    }
    this.entities.set(entityKey, entity)
    return { status: 'applied', version: entity.version, sequence: entity.sequence }
  }

  async pull(
    _token: string,
    libraryId: string,
    after: number,
    limit = 500
  ): Promise<RemoteSyncEntity[]> {
    return [...this.entities.values()]
      .filter((entity) => (
        this.entities.get(`${libraryId}\u0000${entity.entityType}\u0000${entity.entityId}`) === entity
        && entity.sequence > after
      ))
      .sort((left, right) => left.sequence - right.sequence)
      .slice(0, limit)
  }

  update(
    entityType: SyncEntityType,
    entityId: string,
    payload: Record<string, unknown>,
    libraryId = LIBRARY_ID
  ): void {
    const entityKey = `${libraryId}\u0000${entityType}\u0000${entityId}`
    const previous = this.entities.get(entityKey)
    this.entities.set(entityKey, {
      entityType,
      entityId,
      version: (previous?.version ?? 0) + 1,
      sequence: ++this.sequence,
      deleted: false,
      payload,
      updatedAt: new Date().toISOString()
    })
  }
}

describe('metadata sync', () => {
  it('extracts only durable metadata and applies document user data by PDF hash', () => {
    const root = mkdtempSync(join(tmpdir(), 'refora-sync-metadata-'))
    const path = join(root, 'working.db')
    const db = createLibraryDatabase(path)
    db.close()

    const entities = scanSyncEntities(path)
    expect(entities.get(`document_user_data\u0000${DOCUMENT_HASH}`)?.payload).toEqual({
      note: 'Remember this',
      starred: true,
      lastReadAt: 123,
      editedFields: { title: 'Manual title' }
    })
    expect(entities.get('category\u0000category-1')?.payload).toEqual({
      name: 'Reading',
      sortOrder: 0,
      createdAt: 1
    })
    expect([...entities.values()].map((entity) => entity.entityType)).toEqual([
      'document_user_data',
      'category',
      'document_category'
    ])

    applySyncEntity(path, 'document_user_data', DOCUMENT_HASH, false, {
      note: 'Remote note',
      starred: false,
      lastReadAt: 456,
      editedFields: { title: 'Remote title' }
    })
    const updated = new DatabaseSync(path, { readOnly: true })
    expect(updated.prepare(`
      SELECT note, starred, lastReadAt, editedFields, title FROM documents WHERE id = 'doc-1'
    `).get()).toEqual({
      note: 'Remote note',
      starred: 0,
      lastReadAt: 456,
      editedFields: '["title"]',
      title: 'Remote title'
    })
    updated.close()
  })

  it('pushes local metadata, detects concurrent edits, and resolves with the cloud copy', async () => {
    const root = mkdtempSync(join(tmpdir(), 'refora-sync-engine-'))
    const path = join(root, 'library-state', 'working.db')
    const library = createLibraryDatabase(path)
    library.close()
    const remote = new MemoryRemote()
    const onRemoteApplied = vi.fn()
    const createSnapshot = vi.fn(async () => undefined)
    const engine = createMetadataSyncEngine({
      state: new SyncStateDatabase(join(root, 'user-data')),
      remote,
      getLibrary: () => ({ dbPath: path, libraryFolder: join(root, 'cloud-library') }),
      createSnapshot,
      onRemoteApplied
    })

    await engine.run('access-token')

    expect(remote.registerLibrary).toHaveBeenCalledOnce()
    expect(engine.status()).toMatchObject({ pendingCount: 0, conflictCount: 0 })
    expect(createSnapshot).toHaveBeenCalledOnce()

    await engine.run('access-token')
    expect(createSnapshot).toHaveBeenCalledOnce()

    const local = new DatabaseSync(path)
    local.prepare("UPDATE categories SET name = 'Local name' WHERE id = 'category-1'").run()
    local.close()
    remote.update('category', 'category-1', {
      name: 'Cloud name',
      sortOrder: 0,
      createdAt: 1
    })

    await engine.run('access-token')

    expect(engine.status()).toMatchObject({ conflictCount: 1 })
    expect(createSnapshot).toHaveBeenCalledTimes(1)
    const [conflict] = engine.conflicts()
    await engine.resolveConflict(conflict.id, 'use_remote')
    expect(engine.status()).toMatchObject({ conflictCount: 0 })
    const resolved = new DatabaseSync(path, { readOnly: true })
    expect(resolved.prepare("SELECT name FROM categories WHERE id = 'category-1'").get())
      .toEqual({ name: 'Cloud name' })
    resolved.close()
    expect(onRemoteApplied).toHaveBeenCalled()
    expect(createSnapshot).toHaveBeenCalledTimes(2)
  })

  it('clears removed manual fields and clears their values when user data is deleted', () => {
    const root = mkdtempSync(join(tmpdir(), 'refora-sync-clear-fields-'))
    const path = join(root, 'working.db')
    createLibraryDatabase(path).close()

    applySyncEntity(path, 'document_user_data', DOCUMENT_HASH, false, {
      note: null,
      starred: false,
      lastReadAt: null,
      editedFields: {}
    })
    const db = new DatabaseSync(path)
    expect(db.prepare('SELECT title, editedFields FROM documents WHERE id = ?').get('doc-1'))
      .toEqual({ title: '', editedFields: '[]' })
    db.prepare("UPDATE documents SET title = 'Second manual title', editedFields = '[\"title\"]'")
      .run()
    db.close()

    applySyncEntity(path, 'document_user_data', DOCUMENT_HASH, true, {})
    const deleted = new DatabaseSync(path, { readOnly: true })
    expect(deleted.prepare(`
      SELECT note, starred, lastReadAt, title, editedFields FROM documents WHERE id = ?
    `).get('doc-1')).toEqual({
      note: null,
      starred: 0,
      lastReadAt: null,
      title: '',
      editedFields: '[]'
    })
    deleted.close()
  })

  it('defers remote PDF metadata until the source PDF exists locally', async () => {
    const root = mkdtempSync(join(tmpdir(), 'refora-sync-deferred-pdf-'))
    const path = join(root, 'library-state', 'working.db')
    createLibraryDatabase(path).close()
    const remote = new MemoryRemote()
    remote.update('document_user_data', MISSING_DOCUMENT_HASH, {
      note: 'Cloud-only note',
      starred: true,
      lastReadAt: 789,
      editedFields: { title: 'Cloud-only title' }
    })
    const engine = createMetadataSyncEngine({
      state: new SyncStateDatabase(join(root, 'user-data')),
      remote,
      getLibrary: () => ({ dbPath: path, libraryFolder: join(root, 'cloud-library') })
    })

    await engine.run('access-token')

    expect(engine.status()).toMatchObject({ pendingCount: 1, conflictCount: 0 })
    expect(() => applySyncEntity(
      path,
      'document_user_data',
      'c'.repeat(64),
      false,
      { note: 'missing', starred: false, lastReadAt: null, editedFields: {} }
    )).toThrow(SyncDependencyUnavailableError)

    const local = new DatabaseSync(path)
    local.prepare(`
      INSERT INTO documents(id, fileHash, note, starred, lastReadAt, editedFields, addedAt, updatedAt)
      VALUES ('doc-2', ?, NULL, 0, NULL, '[]', 2, 2)
    `).run(MISSING_DOCUMENT_HASH)
    local.close()

    await engine.run('access-token')

    expect(engine.status()).toMatchObject({ pendingCount: 0, conflictCount: 0 })
    const applied = new DatabaseSync(path, { readOnly: true })
    expect(applied.prepare(`
      SELECT note, starred, lastReadAt, title, editedFields FROM documents WHERE id = 'doc-2'
    `).get()).toEqual({
      note: 'Cloud-only note',
      starred: 1,
      lastReadAt: 789,
      title: 'Cloud-only title',
      editedFields: '["title"]'
    })
    applied.close()
  })

  it('replays out-of-order dependent entities after their parent arrives', async () => {
    const root = mkdtempSync(join(tmpdir(), 'refora-sync-dependency-order-'))
    const path = join(root, 'library-state', 'working.db')
    createLibraryDatabase(path).close()
    const remote = new MemoryRemote()
    remote.update('document_category', `${DOCUMENT_HASH}:category-2`, {
      documentHash: DOCUMENT_HASH,
      categoryId: 'category-2'
    })
    remote.update('category', 'category-2', {
      name: 'Cloud category',
      sortOrder: 2,
      createdAt: 2
    })
    const engine = createMetadataSyncEngine({
      state: new SyncStateDatabase(join(root, 'user-data')),
      remote,
      getLibrary: () => ({ dbPath: path, libraryFolder: join(root, 'cloud-library') })
    })

    await engine.run('access-token')

    expect(engine.status()).toMatchObject({ pendingCount: 0, conflictCount: 0 })
    const db = new DatabaseSync(path, { readOnly: true })
    expect(db.prepare(`
      SELECT c.name
      FROM document_categories dc
      JOIN categories c ON c.id = dc.categoryId
      WHERE dc.documentId = 'doc-1' AND dc.categoryId = 'category-2'
    `).get()).toEqual({ name: 'Cloud category' })
    db.close()
  })

  it('turns divergent local and cloud data into a conflict on the first sync', async () => {
    const root = mkdtempSync(join(tmpdir(), 'refora-sync-first-run-conflict-'))
    const path = join(root, 'library-state', 'working.db')
    createLibraryDatabase(path).close()
    const remote = new MemoryRemote()
    remote.update('category', 'category-1', {
      name: 'Cloud category',
      sortOrder: 0,
      createdAt: 1
    })
    const engine = createMetadataSyncEngine({
      state: new SyncStateDatabase(join(root, 'user-data')),
      remote,
      getLibrary: () => ({ dbPath: path, libraryFolder: join(root, 'cloud-library') })
    })

    await engine.run('access-token')

    expect(engine.status()).toMatchObject({ conflictCount: 1 })
    const db = new DatabaseSync(path, { readOnly: true })
    expect(db.prepare("SELECT name FROM categories WHERE id = 'category-1'").get())
      .toEqual({ name: 'Reading' })
    db.close()
  })

  it('serializes runs for different libraries without returning the wrong run', async () => {
    const root = mkdtempSync(join(tmpdir(), 'refora-sync-library-queue-'))
    const firstPath = join(root, 'first', 'working.db')
    const secondPath = join(root, 'second', 'working.db')
    const secondLibraryId = '20000000-0000-0000-0000-000000000010'
    createLibraryDatabase(firstPath).close()
    createLibraryDatabase(secondPath, secondLibraryId).close()
    const remote = new MemoryRemote()
    let releaseFirst: () => void = () => undefined
    const firstRegistration = new Promise<undefined>((resolve) => {
      releaseFirst = () => resolve(undefined)
    })
    remote.registerLibrary.mockImplementationOnce(async () => firstRegistration)
    let active = { dbPath: firstPath, libraryFolder: join(root, 'cloud-first') }
    const engine = createMetadataSyncEngine({
      state: new SyncStateDatabase(join(root, 'user-data')),
      remote,
      getLibrary: () => active
    })

    const firstRun = engine.run('access-token')
    await vi.waitFor(() => expect(remote.registerLibrary).toHaveBeenCalledOnce())
    active = { dbPath: secondPath, libraryFolder: join(root, 'cloud-second') }
    const secondRun = engine.run('access-token')
    expect(engine.status()).toMatchObject({ libraryId: secondLibraryId, running: false })
    releaseFirst()
    await Promise.all([firstRun, secondRun])

    expect(remote.registerLibrary.mock.calls.map((call) => call[1])).toEqual([
      LIBRARY_ID,
      secondLibraryId
    ])
  })
})
