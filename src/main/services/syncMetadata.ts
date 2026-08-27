import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import type { SyncEntityType } from './supabaseSync'

export interface LocalSyncEntity {
  entityType: SyncEntityType
  entityId: string
  deleted: boolean
  payload: Record<string, unknown>
  payloadHash: string
}

const EDITABLE_FIELDS = [
  'title',
  'authors',
  'year',
  'venue',
  'volume',
  'issue',
  'pages',
  'abstract',
  'keywords',
  'url',
  'doi',
  'arxivId',
  'affiliations'
] as const

export class SyncDependencyUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SyncDependencyUnavailableError'
  }
}

export function isSyncDependencyUnavailableError(
  error: unknown
): error is SyncDependencyUnavailableError {
  return error instanceof SyncDependencyUnavailableError
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalValue(item)])
    )
  }
  return value
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value))
}

export function syncPayloadHash(deleted: boolean, payload: Record<string, unknown>): string {
  return createHash('sha256')
    .update(canonicalJson({ deleted, payload: deleted ? {} : payload }))
    .digest('hex')
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Sync payload must be an object')
  }
  return value as Record<string, unknown>
}

function rows(db: DatabaseSync, sql: string): Record<string, unknown>[] {
  return db.prepare(sql).all() as Record<string, unknown>[]
}

function string(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`Sync payload ${name} is invalid`)
  return value
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function finiteNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function booleanInteger(value: unknown): number {
  return value === true || value === 1 ? 1 : 0
}

function parseJson(value: unknown, fallback: unknown): unknown {
  if (typeof value !== 'string') return fallback
  try {
    return JSON.parse(value) as unknown
  } catch {
    return fallback
  }
}

function addEntity(
  entities: Map<string, LocalSyncEntity>,
  entityType: SyncEntityType,
  entityId: string,
  payload: Record<string, unknown>
): void {
  const entity: LocalSyncEntity = {
    entityType,
    entityId,
    deleted: false,
    payload,
    payloadHash: syncPayloadHash(false, payload)
  }
  entities.set(`${entityType}\u0000${entityId}`, entity)
}

function validDocumentHash(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
}

export function scanSyncEntities(dbPath: string): Map<string, LocalSyncEntity> {
  const db = new DatabaseSync(dbPath, { readOnly: true })
  db.exec('PRAGMA busy_timeout = 5000')
  try {
    const entities = new Map<string, LocalSyncEntity>()
    for (const row of rows(db, `
      SELECT fileHash, note, starred, lastReadAt, editedFields,
             title, authors, year, venue, volume, issue, pages, abstract,
             keywords, url, doi, arxivId, affiliations
      FROM documents
      WHERE fileHash GLOB '${'[0-9a-f]'.repeat(64)}'
    `)) {
      if (!validDocumentHash(row.fileHash)) continue
      const parsedEdited = parseJson(row.editedFields, [])
      const edited = Array.isArray(parsedEdited)
        ? parsedEdited.filter((field): field is typeof EDITABLE_FIELDS[number] =>
          typeof field === 'string' && EDITABLE_FIELDS.includes(field as typeof EDITABLE_FIELDS[number]))
        : []
      if (!row.note && row.starred !== 1 && row.lastReadAt === null && edited.length === 0) continue
      const editedFields: Record<string, unknown> = {}
      for (const field of edited) editedFields[field] = row[field] ?? null
      addEntity(entities, 'document_user_data', row.fileHash, {
        note: row.note ?? null,
        starred: row.starred === 1,
        lastReadAt: row.lastReadAt ?? null,
        editedFields
      })
    }
    for (const row of rows(db, 'SELECT id, name, sortOrder, createdAt FROM categories')) {
      addEntity(entities, 'category', string(row.id, 'category id'), {
        name: row.name,
        sortOrder: row.sortOrder,
        createdAt: row.createdAt
      })
    }
    for (const row of rows(db, `
      SELECT d.fileHash AS documentHash, dc.categoryId
      FROM document_categories dc
      JOIN documents d ON d.id = dc.documentId
      WHERE d.fileHash IS NOT NULL
      ORDER BY dc.categoryId, d.fileHash
    `)) {
      if (!validDocumentHash(row.documentHash)) continue
      const categoryId = string(row.categoryId, 'category id')
      addEntity(entities, 'document_category', `${row.documentHash}:${categoryId}`, {
        documentHash: row.documentHash,
        categoryId
      })
    }
    for (const row of rows(db, 'SELECT id, name, createdAt, updatedAt FROM workspaces')) {
      addEntity(entities, 'workspace', string(row.id, 'workspace id'), {
        name: row.name,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt
      })
    }
    for (const row of rows(db, `
      SELECT id, workspaceId, title, contentMd, noteType, color, createdAt, updatedAt
      FROM workspace_notes
    `)) {
      addEntity(entities, 'workspace_note', string(row.id, 'note id'), {
        workspaceId: row.workspaceId,
        title: row.title,
        contentMd: row.contentMd,
        noteType: row.noteType,
        color: row.color,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt
      })
    }
    for (const row of rows(db, `
      SELECT wi.id, wi.workspaceId, wi.kind, d.fileHash AS documentHash, wi.noteId,
             wi.sortOrder, wi.width, wi.height, wi.x, wi.y, wi.zIndex, wi.addedAt
      FROM workspace_items wi
      LEFT JOIN documents d ON d.id = wi.docId
      WHERE wi.kind IN ('document', 'note')
    `)) {
      if (row.kind === 'document' && !validDocumentHash(row.documentHash)) continue
      addEntity(entities, 'workspace_layout', string(row.id, 'workspace item id'), {
        recordType: 'item',
        workspaceId: row.workspaceId,
        kind: row.kind,
        documentHash: row.kind === 'document' ? row.documentHash : null,
        noteId: row.kind === 'note' ? row.noteId : null,
        sortOrder: row.sortOrder,
        width: row.width,
        height: row.height,
        x: row.x,
        y: row.y,
        zIndex: row.zIndex,
        addedAt: row.addedAt
      })
    }
    for (const row of rows(db, 'SELECT workspaceId, panX, panY, zoom, updatedAt FROM workspace_canvas_state')) {
      const workspaceId = string(row.workspaceId, 'workspace id')
      addEntity(entities, 'workspace_layout', `canvas:${workspaceId}`, {
        recordType: 'canvas',
        workspaceId,
        panX: row.panX,
        panY: row.panY,
        zoom: row.zoom,
        updatedAt: row.updatedAt
      })
    }
    for (const row of rows(db, `
      SELECT c.id, c.workspaceId, c.sourceItemId, c.targetItemId,
             c.sourceAnchor, c.targetAnchor, c.createdAt
      FROM workspace_connections c
      JOIN workspace_items source ON source.id = c.sourceItemId
      JOIN workspace_items target ON target.id = c.targetItemId
      WHERE source.kind IN ('document', 'note') AND target.kind IN ('document', 'note')
    `)) {
      addEntity(entities, 'workspace_connection', string(row.id, 'connection id'), {
        workspaceId: row.workspaceId,
        sourceItemId: row.sourceItemId,
        targetItemId: row.targetItemId,
        sourceAnchor: row.sourceAnchor,
        targetAnchor: row.targetAnchor,
        createdAt: row.createdAt
      })
    }
    for (const row of rows(db, `
      SELECT d.fileHash, p.annotationsJson, p.updatedAt
      FROM pdf_annotations p
      JOIN documents d ON d.id = p.documentId
      WHERE d.fileHash IS NOT NULL
    `)) {
      if (!validDocumentHash(row.fileHash)) continue
      addEntity(entities, 'pdf_annotation', row.fileHash, {
        annotations: parseJson(row.annotationsJson, []),
        updatedAt: row.updatedAt
      })
    }
    for (const row of rows(db, `
      SELECT id, scope, scopeId, workspaceId, path, content, revision, createdAt, updatedAt
      FROM workspace_agent_memories
    `)) {
      addEntity(entities, 'agent_memory', string(row.id, 'memory id'), {
        scope: row.scope,
        scopeId: row.scopeId,
        workspaceId: row.workspaceId ?? null,
        path: row.path,
        content: row.content,
        revision: row.revision,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt
      })
    }
    return entities
  } finally {
    db.close()
  }
}

function documentIdForHash(db: DatabaseSync, hash: string): string | null {
  const row = db.prepare('SELECT id FROM documents WHERE fileHash = ? ORDER BY addedAt LIMIT 1')
    .get(hash) as { id?: unknown } | undefined
  return typeof row?.id === 'string' ? row.id : null
}

function rowExists(db: DatabaseSync, table: string, id: string): boolean {
  return db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(id) !== undefined
}

function requireRow(db: DatabaseSync, table: string, id: string, message: string): void {
  if (!rowExists(db, table, id)) throw new SyncDependencyUnavailableError(message)
}

function editedDocumentFields(value: unknown): Array<typeof EDITABLE_FIELDS[number]> {
  const parsed = parseJson(value, [])
  if (!Array.isArray(parsed)) return []
  return parsed.filter((field): field is typeof EDITABLE_FIELDS[number] =>
    typeof field === 'string' && EDITABLE_FIELDS.includes(field as typeof EDITABLE_FIELDS[number]))
}

function deleteEntity(db: DatabaseSync, entityType: SyncEntityType, entityId: string): void {
  if (entityType === 'document_user_data') {
    const rows = db.prepare('SELECT id, editedFields FROM documents WHERE fileHash = ?')
      .all(entityId) as Array<{ id: string; editedFields: unknown }>
    for (const row of rows) {
      const assignments = [
        'note = NULL',
        'starred = 0',
        'lastReadAt = NULL',
        "editedFields = '[]'",
        'updatedAt = ?'
      ]
      for (const field of editedDocumentFields(row.editedFields)) assignments.push(`${field} = ''`)
      db.prepare(`UPDATE documents SET ${assignments.join(', ')} WHERE id = ?`)
        .run(Date.now(), row.id)
    }
  } else if (entityType === 'category') {
    db.prepare('DELETE FROM categories WHERE id = ?').run(entityId)
  } else if (entityType === 'document_category') {
    const split = entityId.indexOf(':')
    if (split > 0) {
      const documentId = documentIdForHash(db, entityId.slice(0, split))
      if (documentId) {
        db.prepare('DELETE FROM document_categories WHERE documentId = ? AND categoryId = ?')
          .run(documentId, entityId.slice(split + 1))
      }
    }
  } else if (entityType === 'workspace') {
    db.prepare('DELETE FROM workspaces WHERE id = ?').run(entityId)
  } else if (entityType === 'workspace_note') {
    db.prepare('DELETE FROM workspace_notes WHERE id = ?').run(entityId)
  } else if (entityType === 'workspace_layout') {
    if (entityId.startsWith('canvas:')) {
      db.prepare('DELETE FROM workspace_canvas_state WHERE workspaceId = ?').run(entityId.slice(7))
    } else {
      db.prepare('DELETE FROM workspace_items WHERE id = ?').run(entityId)
    }
  } else if (entityType === 'workspace_connection') {
    db.prepare('DELETE FROM workspace_connections WHERE id = ?').run(entityId)
  } else if (entityType === 'pdf_annotation') {
    const documentId = documentIdForHash(db, entityId)
    if (documentId) db.prepare('DELETE FROM pdf_annotations WHERE documentId = ?').run(documentId)
  } else if (entityType === 'agent_memory') {
    db.prepare('DELETE FROM workspace_agent_memories WHERE id = ?').run(entityId)
  }
}

function upsertEntity(
  db: DatabaseSync,
  entityType: SyncEntityType,
  entityId: string,
  rawPayload: Record<string, unknown>
): void {
  const payload = record(rawPayload)
  if (entityType === 'document_user_data') {
    const editedFields = record(payload.editedFields ?? {})
    const documents = db.prepare('SELECT id, editedFields FROM documents WHERE fileHash = ?')
      .all(entityId) as Array<{ id: string; editedFields: unknown }>
    if (documents.length === 0) {
      throw new SyncDependencyUnavailableError('Referenced PDF is not available on this device')
    }
    const incomingFields = EDITABLE_FIELDS.filter((field) => field in editedFields)
    const assignments = ['note = ?', 'starred = ?', 'lastReadAt = ?', 'editedFields = ?', 'updatedAt = ?']
    const values: Array<string | number | null> = [
      nullableString(payload.note),
      booleanInteger(payload.starred),
      typeof payload.lastReadAt === 'number' ? payload.lastReadAt : null,
      canonicalJson(incomingFields),
      Date.now()
    ]
    const fieldsToClear = new Set<typeof EDITABLE_FIELDS[number]>()
    for (const document of documents) {
      for (const field of editedDocumentFields(document.editedFields)) {
        if (!(field in editedFields)) fieldsToClear.add(field)
      }
    }
    for (const field of EDITABLE_FIELDS) {
      if (field in editedFields) {
        assignments.push(`${field} = ?`)
        values.push(nullableString(editedFields[field]))
      } else if (fieldsToClear.has(field)) {
        assignments.push(`${field} = ''`)
      }
    }
    values.push(entityId)
    db.prepare(`UPDATE documents SET ${assignments.join(', ')} WHERE fileHash = ?`).run(...values)
  } else if (entityType === 'category') {
    db.prepare(`
      INSERT INTO categories(id, name, sortOrder, createdAt)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        sortOrder = excluded.sortOrder
    `).run(
      entityId,
      string(payload.name, 'category name'),
      finiteNumber(payload.sortOrder),
      finiteNumber(payload.createdAt, Date.now())
    )
  } else if (entityType === 'document_category') {
    const documentHash = string(payload.documentHash, 'document hash')
    const categoryId = string(payload.categoryId, 'category id')
    const documentId = documentIdForHash(db, documentHash)
    if (!documentId) {
      throw new SyncDependencyUnavailableError('Referenced PDF is not available on this device')
    }
    requireRow(db, 'categories', categoryId, 'Referenced category is not available on this device')
    db.prepare('INSERT OR IGNORE INTO document_categories(documentId, categoryId) VALUES (?, ?)')
      .run(documentId, categoryId)
  } else if (entityType === 'workspace') {
    db.prepare(`
      INSERT INTO workspaces(id, name, createdAt, updatedAt)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, updatedAt = excluded.updatedAt
    `).run(
      entityId,
      string(payload.name, 'workspace name'),
      finiteNumber(payload.createdAt, Date.now()),
      finiteNumber(payload.updatedAt, Date.now())
    )
  } else if (entityType === 'workspace_note') {
    const workspaceId = string(payload.workspaceId, 'workspace id')
    requireRow(db, 'workspaces', workspaceId, 'Referenced workspace is not available on this device')
    db.prepare(`
      INSERT INTO workspace_notes(
        id, workspaceId, title, contentMd, createdAt, updatedAt, noteType, color
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        workspaceId = excluded.workspaceId,
        title = excluded.title,
        contentMd = excluded.contentMd,
        updatedAt = excluded.updatedAt,
        noteType = excluded.noteType,
        color = excluded.color
    `).run(
      entityId,
      workspaceId,
      string(payload.title, 'note title'),
      typeof payload.contentMd === 'string' ? payload.contentMd : '',
      finiteNumber(payload.createdAt, Date.now()),
      finiteNumber(payload.updatedAt, Date.now()),
      payload.noteType === 'plain' ? 'plain' : 'markdown',
      typeof payload.color === 'string' ? payload.color : 'sand'
    )
  } else if (entityType === 'workspace_layout') {
    const workspaceId = string(payload.workspaceId, 'workspace id')
    requireRow(db, 'workspaces', workspaceId, 'Referenced workspace is not available on this device')
    if (payload.recordType === 'canvas') {
      db.prepare(`
        INSERT INTO workspace_canvas_state(workspaceId, panX, panY, zoom, updatedAt)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(workspaceId) DO UPDATE SET
          panX = excluded.panX,
          panY = excluded.panY,
          zoom = excluded.zoom,
          updatedAt = excluded.updatedAt
      `).run(
        workspaceId,
        finiteNumber(payload.panX),
        finiteNumber(payload.panY),
        finiteNumber(payload.zoom, 1),
        finiteNumber(payload.updatedAt, Date.now())
      )
    } else {
      const kind = payload.kind === 'note' ? 'note' : 'document'
      const documentId = kind === 'document'
        ? documentIdForHash(db, string(payload.documentHash, 'document hash'))
        : null
      const noteId = kind === 'note' ? string(payload.noteId, 'note id') : null
      if (kind === 'document' && !documentId) {
        throw new SyncDependencyUnavailableError('Referenced PDF is not available on this device')
      }
      if (noteId) requireRow(db, 'workspace_notes', noteId, 'Referenced note is not available on this device')
      db.prepare(`
        INSERT INTO workspace_items(
          id, workspaceId, kind, docId, reportId, noteId, assetId,
          sortOrder, width, height, x, y, zIndex, addedAt
        ) VALUES (?, ?, ?, ?, NULL, ?, NULL, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          workspaceId = excluded.workspaceId,
          kind = excluded.kind,
          docId = excluded.docId,
          reportId = NULL,
          noteId = excluded.noteId,
          assetId = NULL,
          sortOrder = excluded.sortOrder,
          width = excluded.width,
          height = excluded.height,
          x = excluded.x,
          y = excluded.y,
          zIndex = excluded.zIndex
      `).run(
        entityId,
        workspaceId,
        kind,
        documentId,
        noteId,
        finiteNumber(payload.sortOrder),
        finiteNumber(payload.width, 300),
        finiteNumber(payload.height, 200),
        finiteNumber(payload.x),
        finiteNumber(payload.y),
        finiteNumber(payload.zIndex),
        finiteNumber(payload.addedAt, Date.now())
      )
    }
  } else if (entityType === 'workspace_connection') {
    const workspaceId = string(payload.workspaceId, 'workspace id')
    const sourceItemId = string(payload.sourceItemId, 'source item id')
    const targetItemId = string(payload.targetItemId, 'target item id')
    requireRow(db, 'workspaces', workspaceId, 'Referenced workspace is not available on this device')
    requireRow(db, 'workspace_items', sourceItemId, 'Referenced workspace item is not available on this device')
    requireRow(db, 'workspace_items', targetItemId, 'Referenced workspace item is not available on this device')
    db.prepare(`
      INSERT INTO workspace_connections(
        id, workspaceId, sourceItemId, targetItemId, sourceAnchor, targetAnchor, createdAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        sourceItemId = excluded.sourceItemId,
        targetItemId = excluded.targetItemId,
        sourceAnchor = excluded.sourceAnchor,
        targetAnchor = excluded.targetAnchor
    `).run(
      entityId,
      workspaceId,
      sourceItemId,
      targetItemId,
      string(payload.sourceAnchor, 'source anchor'),
      string(payload.targetAnchor, 'target anchor'),
      finiteNumber(payload.createdAt, Date.now())
    )
  } else if (entityType === 'pdf_annotation') {
    const documentId = documentIdForHash(db, entityId)
    if (!documentId) {
      throw new SyncDependencyUnavailableError('Referenced PDF is not available on this device')
    }
    db.prepare(`
      INSERT INTO pdf_annotations(documentId, annotationsJson, updatedAt)
      VALUES (?, ?, ?)
      ON CONFLICT(documentId) DO UPDATE SET
        annotationsJson = excluded.annotationsJson,
        updatedAt = excluded.updatedAt
    `).run(
      documentId,
      canonicalJson(Array.isArray(payload.annotations) ? payload.annotations : []),
      finiteNumber(payload.updatedAt, Date.now())
    )
  } else if (entityType === 'agent_memory') {
    const workspaceId = typeof payload.workspaceId === 'string' ? payload.workspaceId : null
    if (workspaceId) {
      requireRow(db, 'workspaces', workspaceId, 'Referenced workspace is not available on this device')
    }
    db.prepare(`
      INSERT INTO workspace_agent_memories(
        id, scope, scopeId, workspaceId, path, content, revision,
        sourceThreadId, sourceRunId, createdAt, updatedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        scope = excluded.scope,
        scopeId = excluded.scopeId,
        workspaceId = excluded.workspaceId,
        path = excluded.path,
        content = excluded.content,
        revision = excluded.revision,
        updatedAt = excluded.updatedAt
    `).run(
      entityId,
      payload.scope === 'global' ? 'global' : 'workspace',
      string(payload.scopeId, 'memory scope'),
      workspaceId,
      string(payload.path, 'memory path'),
      typeof payload.content === 'string' ? payload.content : '',
      finiteNumber(payload.revision, 1),
      finiteNumber(payload.createdAt, Date.now()),
      finiteNumber(payload.updatedAt, Date.now())
    )
  }
}

export function applySyncEntity(
  dbPath: string,
  entityType: SyncEntityType,
  entityId: string,
  deleted: boolean,
  payload: Record<string, unknown>
): void {
  const db = new DatabaseSync(dbPath)
  try {
    db.exec('PRAGMA busy_timeout = 5000')
    db.exec('PRAGMA foreign_keys = ON')
    db.exec('BEGIN IMMEDIATE')
    try {
      if (deleted) deleteEntity(db, entityType, entityId)
      else upsertEntity(db, entityType, entityId, payload)
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  } finally {
    db.close()
  }
}
