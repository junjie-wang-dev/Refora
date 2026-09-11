from __future__ import annotations

import json
import os
import time
import uuid
from pathlib import Path

from refora_server.library.importer import _copy_to_library, hashPdf, validatePdfPath


def create_document_recycle_repository(db, library_folder):
    def tables():
        return [row[0] for row in db.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
        ).fetchall() if not row[0].startswith('docs_fts')]

    def quote(name):
        return '"' + name.replace('"', '""') + '"'

    def references(table):
        return db.execute(f'PRAGMA foreign_key_list({quote(table)})').fetchall()

    def collect(ids):
        placeholders = ','.join('?' for _ in ids)
        records = {'documents': [dict(row) for row in db.execute(
            f'SELECT * FROM documents WHERE id IN ({placeholders})', ids
        ).fetchall()]}
        pending = [('documents', row) for row in records['documents']]
        seen = set()
        children = [(table, fk) for table in tables() for fk in references(table)
                    if fk['on_delete'] == 'CASCADE']
        while pending:
            parent, row = pending.pop(0)
            for table, fk in children:
                if fk['table'] != parent or row.get(fk['to']) is None:
                    continue
                for result in db.execute(
                    f'SELECT * FROM {quote(table)} WHERE {quote(fk["from"])} = ?',
                    [row[fk['to']]],
                ).fetchall():
                    child = dict(result)
                    identity = (table, json.dumps(child, sort_keys=True))
                    if identity in seen:
                        continue
                    seen.add(identity)
                    records.setdefault(table, []).append(child)
                    pending.append((table, child))
        return records

    def prepare(ids):
        identifier = str(uuid.uuid4())
        root = Path(library_folder()).resolve()
        destination = root / '.refora' / 'recycle' / identifier
        if not root.is_dir() or destination.resolve() != destination:
            raise ValueError('Invalid library recovery directory')
        backups = {}
        hashes = {}
        for row in collect(ids)['documents']:
            path = validatePdfPath(str(root / row['filePath']))
            if path is None:
                continue
            if not Path(path).is_relative_to(root):
                continue
            backup = _copy_to_library(path, str(destination), f'{row["id"]}.pdf')
            current_hash = hashPdf(path)
            if current_hash != hashPdf(backup):
                raise RuntimeError('PDF recovery copy failed verification')
            backups[row['id']] = str(Path(backup).relative_to(root))
            hashes[row['id']] = current_hash
        return {'id': identifier, 'backups': backups, 'hashes': hashes}

    def archive(ids, prepared):
        records = collect(ids)
        if not records['documents']:
            return
        for row in records['documents']:
            if row['id'] in prepared['hashes']:
                row['fileHash'] = prepared['hashes'][row['id']]
        payload = {'records': records, 'backups': prepared['backups']}
        db.execute('INSERT INTO deleted_documents VALUES (?, ?, ?)', [
            prepared['id'], int(time.time() * 1000), json.dumps(payload),
        ])

    def list_deleted():
        result = []
        for row in db.execute('SELECT * FROM deleted_documents ORDER BY deletedAt DESC, id').fetchall():
            payload = json.loads(row['payloadJson'])
            documents = payload['records']['documents']
            if not documents:
                continue
            result.append({
                'id': row['id'], 'deletedAt': row['deletedAt'],
                'titles': [doc.get('title') or doc['fileName'] for doc in documents],
                'count': len(documents),
            })
        return result

    def restore(identifier):
        entry = db.execute('SELECT * FROM deleted_documents WHERE id = ?', [identifier]).fetchone()
        if entry is None:
            raise ValueError('Recovery entry no longer exists')
        payload = json.loads(entry['payloadJson'])
        records = payload['records']
        root = Path(library_folder()).resolve()
        ids = [row['id'] for row in records['documents']]
        if any(db.execute('SELECT 1 FROM documents WHERE id = ?', [id]).fetchone() for id in ids):
            raise ValueError('A document with this identity already exists')
        plans = []
        for row in records['documents']:
            source = None
            backup = payload['backups'].get(row['id'])
            path = validatePdfPath(str(root / row['filePath']))
            if path and (not row.get('fileHash') or hashPdf(path) != row['fileHash']):
                path = None
            if path and not Path(path).is_relative_to(root):
                path = None
            if path is None and backup:
                recovery_root = root / '.refora' / 'recycle' / identifier
                source = validatePdfPath(str(root / backup))
                if source is None or not Path(source).is_relative_to(recovery_root):
                    raise ValueError('PDF recovery copy is missing; recovery record has been retained')
                if row.get('fileHash') and hashPdf(source) != row['fileHash']:
                    raise ValueError('PDF recovery copy failed verification; recovery record has been retained')
            plans.append((row, path, source))
        created = []
        try:
            return restore_records(identifier, records, plans, root, ids, created)
        except BaseException:
            for path in created:
                Path(path).unlink(missing_ok=True)
            raise

    def restore_records(identifier, records, plans, root, ids, created):
        for row, path, source in plans:
            if path is None and source:
                path = _copy_to_library(source, str(root), row['fileName'])
                created.append(path)
                if row.get('fileHash') and hashPdf(path) != row['fileHash']:
                    raise ValueError('PDF recovery copy changed during restoration')
            if path:
                stat = os.stat(path)
                row.update(filePath=str(Path(path).relative_to(root)), fileName=Path(path).name,
                           fileMissing=0, fileSize=stat.st_size, fileHash=hashPdf(path),
                           fileDevice=stat.st_dev, fileInode=stat.st_ino, fileMtimeNs=stat.st_mtime_ns)
            else:
                row['fileMissing'] = 1
        sources = {identifier: records}
        for archived in db.execute('SELECT id, payloadJson FROM deleted_documents WHERE id <> ?', [identifier]).fetchall():
            other = json.loads(archived['payloadJson'])
            if not other['records'].get('documents'):
                sources[archived['id']] = other['records']
        pending = [(owner, table, row) for owner, source in sources.items() for table, rows in source.items() for row in rows]
        skipped = 0
        while pending:
            remaining = []
            for owner, table, row in pending:
                if any(row.get(fk['from']) is not None and not db.execute(
                    f'SELECT 1 FROM {quote(fk["table"])} WHERE {quote(fk["to"])} = ?',
                    [row[fk['from']]],
                ).fetchone() for fk in references(table)):
                    remaining.append((owner, table, row))
                    continue
                if table == 'document_ocr_jobs' and row.get('status') in ('queued', 'running'):
                    now = int(time.time() * 1000)
                    row = {**row, 'status': 'interrupted', 'errorCode': 'interrupted',
                           'errorMessage': 'OCR process stopped before completion',
                           'finishedAt': now, 'updatedAt': now}
                columns = ','.join(quote(key) for key in row)
                placeholders = ','.join('?' for _ in row)
                command = 'INSERT' if table == 'documents' else 'INSERT OR IGNORE'
                inserted = db.execute(f'{command} INTO {quote(table)} ({columns}) VALUES ({placeholders})', list(row.values()))
                if inserted.rowcount == 0:
                    equivalent = ' AND '.join(f'{quote(key)} IS ?' for key in row)
                    if not db.execute(f'SELECT 1 FROM {quote(table)} WHERE {equivalent}', list(row.values())).fetchone():
                        remaining.append((owner, table, row))
            if len(remaining) == len(pending):
                skipped = len(remaining)
                pending = remaining
                break
            pending = remaining
        for owner in sources:
            retained = {'documents': []}
            for pending_owner, table, row in pending:
                if pending_owner == owner:
                    retained.setdefault(table, []).append(row)
            if any(retained.values()):
                db.execute('UPDATE deleted_documents SET payloadJson = ? WHERE id = ?', [
                    json.dumps({'records': retained, 'backups': {}}), owner,
                ])
            else:
                db.execute('DELETE FROM deleted_documents WHERE id = ?', [owner])
        return {'documentIds': ids, 'skippedRelations': skipped}

    return {'prepareDeletion': prepare, 'archiveDeletion': archive,
            'listDeleted': list_deleted, 'restoreDeleted': restore}
