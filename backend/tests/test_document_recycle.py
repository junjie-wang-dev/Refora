import json

import pytest

from conftest import make_doc, make_docs_repo, open_migrated_db
from refora_server.library.importer import hashPdf


@pytest.fixture
def library(tmp_path):
    db = open_migrated_db()
    repo = make_docs_repo(db, str(tmp_path))
    yield db, repo, tmp_path
    db.close()


def insert_document(repo, folder, identifier='paper'):
    path = folder / f'{identifier}.pdf'
    path.write_bytes(b'%PDF-1.4\nrecovery fixture')
    return repo['insert'](make_doc(
        id=identifier, file_path=str(path), file_name=path.name,
        file_hash=hashPdf(str(path)), title='A paper', note='My research notes',
    ))


def archive(db, repo, folder, ids):
    prepared = repo['prepareDeletion'](ids)
    db.execute('SAVEPOINT deletion')
    try:
        repo['archiveDeletion'](ids, prepared)
        repo['bulkDelete'](ids)
        db.execute('RELEASE deletion')
    except BaseException:
        db.execute('ROLLBACK TO deletion')
        db.execute('RELEASE deletion')
        raise
    for identifier in ids:
        path = folder / f'{identifier}.pdf'
        if path.exists():
            path.rename(folder / f'{identifier}.trashed')
    return prepared['id']


def restore(db, repo, identifier):
    db.execute('SAVEPOINT recovery')
    try:
        result = repo['restoreDeleted'](identifier)
        db.execute('RELEASE recovery')
        return result
    except BaseException:
        db.execute('ROLLBACK TO recovery')
        db.execute('RELEASE recovery')
        raise


def test_restores_pdf_notes_annotations_categories_and_board_connections(library):
    db, repo, folder = library
    original = insert_document(repo, folder)
    insert_document(repo, folder, 'other')
    db.execute("INSERT INTO categories (id,name,sortOrder,createdAt) VALUES ('cat','Topic',0,1)")
    db.execute("INSERT INTO document_categories VALUES ('paper','cat')")
    db.execute("INSERT INTO pdf_annotations VALUES ('paper', ?, 1)", [json.dumps([{'id': 'annotation'}])])
    db.execute("INSERT INTO workspaces (id,name,createdAt,updatedAt) VALUES ('ws','Research',1,1)")
    for identifier in ['paper', 'other']:
        db.execute("INSERT INTO workspace_items (id,workspaceId,kind,docId,addedAt) VALUES (?,'ws','document',?,1)", [identifier, identifier])
    db.execute("INSERT INTO workspace_connections (id,workspaceId,sourceItemId,targetItemId,sourceAnchor,targetAnchor,createdAt) VALUES ('edge','ws','paper','other','right','left',1)")
    identifier = archive(db, repo, folder, ['paper'])
    assert repo['get']('paper') is None
    assert db.execute('SELECT * FROM pdf_annotations').fetchall() == []
    assert db.execute('SELECT * FROM workspace_connections').fetchall() == []
    assert repo['listDeleted']()[0]['titles'] == ['A paper']
    result = restore(db, repo, identifier)
    recovered = repo['get']('paper')
    assert recovered['note'] == original['note']
    assert recovered['fileMissing'] == 0
    assert hashPdf(recovered['filePath']) == original['fileHash']
    assert db.execute('SELECT count(*) FROM pdf_annotations').fetchone()[0] == 1
    assert db.execute('SELECT count(*) FROM document_categories').fetchone()[0] == 1
    assert db.execute('SELECT count(*) FROM workspace_connections').fetchone()[0] == 1
    assert result == {'documentIds': ['paper'], 'skippedRelations': 0}
    assert repo['listDeleted']() == []


def test_restore_never_overwrites_new_pdf_at_original_path(library):
    db, repo, folder = library
    original = insert_document(repo, folder)
    identifier = archive(db, repo, folder, ['paper'])
    (folder / 'paper.pdf').write_bytes(b'%PDF-1.4\nnew unrelated PDF')
    restore(db, repo, identifier)
    recovered = repo['get']('paper')
    assert recovered['filePath'] != str(folder / 'paper.pdf')
    assert hashPdf(recovered['filePath']) == original['fileHash']
    assert (folder / 'paper.pdf').read_bytes().endswith(b'new unrelated PDF')


def test_missing_recovery_copy_retains_record_for_retry(library):
    db, repo, folder = library
    insert_document(repo, folder)
    identifier = archive(db, repo, folder, ['paper'])
    recovery = next((folder / '.refora' / 'recycle' / identifier).glob('*.pdf'))
    recovery.rename(recovery.with_suffix('.unavailable'))
    with pytest.raises(ValueError, match='recovery copy is missing'):
        restore(db, repo, identifier)
    assert repo['get']('paper') is None
    assert len(repo['listDeleted']()) == 1


def test_missing_attachment_and_deleted_category_do_not_block_document_recovery(library):
    db, repo, folder = library
    repo['insert'](make_doc(id='paper', file_path='', file_hash=None, file_missing=1))
    db.execute("INSERT INTO categories (id,name,sortOrder,createdAt) VALUES ('cat','Topic',0,1)")
    db.execute("INSERT INTO document_categories VALUES ('paper','cat')")
    identifier = archive(db, repo, folder, ['paper'])
    db.execute("DELETE FROM categories WHERE id='cat'")
    assert restore(db, repo, identifier)['skippedRelations'] == 1
    assert repo['get']('paper')['fileMissing'] == 1


def test_bulk_recovery_checks_all_backups_before_publishing_any_pdf(library):
    db, repo, folder = library
    insert_document(repo, folder)
    insert_document(repo, folder, 'second')
    identifier = archive(db, repo, folder, ['paper', 'second'])
    backup = folder / '.refora' / 'recycle' / identifier / 'second.pdf'
    backup.write_bytes(b'corrupted recovery data')
    with pytest.raises(ValueError, match='failed verification'):
        restore(db, repo, identifier)
    assert not (folder / 'paper.pdf').exists()
    assert not (folder / 'second.pdf').exists()
    assert len(repo['listDeleted']()) == 1


def test_recovery_uses_actual_backup_hash_when_database_identity_is_stale(library):
    db, repo, folder = library
    insert_document(repo, folder)
    (folder / 'paper.pdf').write_bytes(b'%PDF-1.4\nexternally updated content')
    identifier = archive(db, repo, folder, ['paper'])
    restore(db, repo, identifier)
    assert (folder / 'paper.pdf').read_bytes().endswith(b'externally updated content')


def test_connections_are_restored_regardless_of_separate_deletion_order(library):
    db, repo, folder = library
    for identifier in ['paper', 'other']:
        insert_document(repo, folder, identifier)
    db.execute("INSERT INTO workspaces (id,name,createdAt,updatedAt) VALUES ('ws','Research',1,1)")
    for identifier in ['paper', 'other']:
        db.execute("INSERT INTO workspace_items (id,workspaceId,kind,docId,addedAt) VALUES (?,'ws','document',?,1)", [identifier, identifier])
    db.execute("INSERT INTO workspace_connections (id,workspaceId,sourceItemId,targetItemId,sourceAnchor,targetAnchor,createdAt) VALUES ('edge','ws','paper','other','right','left',1)")
    first = archive(db, repo, folder, ['paper'])
    second = archive(db, repo, folder, ['other'])
    assert restore(db, repo, first)['skippedRelations'] == 1
    assert restore(db, repo, second)['skippedRelations'] == 0
    assert db.execute('SELECT count(*) FROM workspace_connections').fetchone()[0] == 1
    assert db.execute('SELECT count(*) FROM deleted_documents').fetchone()[0] == 0


def test_recovery_migration_preserves_existing_documents():
    db = open_migrated_db()
    assert db.execute("PRAGMA table_info(deleted_documents)").fetchall()
    assert db.execute('PRAGMA foreign_key_check').fetchall() == []
    db.close()


def test_conflicting_report_source_is_retained_until_it_can_be_restored(library):
    db, repo, folder = library
    for document_id in ['paper', 'other']:
        insert_document(repo, folder, document_id)
    db.execute("INSERT INTO workspaces (id,name,createdAt,updatedAt) VALUES ('ws','Research',1,1)")
    db.execute("INSERT INTO ai_reports (id,workspaceId,title,contentMd,createdAt) VALUES ('report','ws','Report','Notes',1)")
    db.execute("INSERT INTO ai_report_sources VALUES ('report','paper',0)")
    identifier = archive(db, repo, folder, ['paper'])
    db.execute("INSERT INTO ai_report_sources VALUES ('report','other',0)")

    result = restore(db, repo, identifier)

    assert result['skippedRelations'] == 1
    assert [row['docId'] for row in db.execute('SELECT * FROM ai_report_sources')] == ['other']
    retained = json.loads(db.execute('SELECT payloadJson FROM deleted_documents WHERE id = ?', [identifier]).fetchone()[0])
    assert retained['records']['ai_report_sources'] == [{'reportId': 'report', 'docId': 'paper', 'ordinal': 0}]
    assert repo['listDeleted']() == []

    db.execute("UPDATE ai_report_sources SET ordinal=1 WHERE docId='other'")
    second = archive(db, repo, folder, ['other'])
    assert restore(db, repo, second)['skippedRelations'] == 0
    assert [tuple(row) for row in db.execute('SELECT docId,ordinal FROM ai_report_sources ORDER BY ordinal')] == [('paper', 0), ('other', 1)]
    assert db.execute('SELECT count(*) FROM deleted_documents').fetchone()[0] == 0


@pytest.mark.parametrize('status', ['queued', 'running'])
def test_restored_ocr_jobs_are_interrupted_and_do_not_block_new_jobs(library, status):
    from refora_server.repositories.document_ocr import createDocumentOcrRepository

    db, repo, folder = library
    original = insert_document(repo, folder)
    ocr = createDocumentOcrRepository(db)
    ocr['createJob']({
        'id': 'job', 'documentId': 'paper', 'resultKey': 'result',
        'sourceHash': original['fileHash'], 'profile': 'balanced', 'status': status,
        'stage': 'parsing' if status == 'running' else 'queued', 'progress': 0.3,
        'createdAt': 1, 'updatedAt': 1,
    })
    identifier = archive(db, repo, folder, ['paper'])

    restore(db, repo, identifier)

    recovered = ocr['getJob']('job')
    assert recovered['status'] == 'interrupted'
    assert recovered['errorCode'] == 'interrupted'
    assert recovered['finishedAt'] > 1
    assert recovered['updatedAt'] == recovered['finishedAt']
    assert ocr['getAnyActiveJob']() is None


def test_recovery_restores_merged_document_hash_aliases(library):
    db, repo, folder = library
    insert_document(repo, folder, 'paper')
    insert_document(repo, folder, 'source')
    db.execute("UPDATE documents SET fileHash='previous-version' WHERE id='source'")
    repo['merge']('paper', ['source'])
    identifier = archive(db, repo, folder, ['paper'])
    assert repo['findByHash']('previous-version') is None
    restore(db, repo, identifier)
    assert repo['findByHash']('previous-version')['id'] == 'paper'
