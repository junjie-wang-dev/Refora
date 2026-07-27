import pytest

from conftest import make_doc, make_docs_repo, make_ocr_repo, open_ocr_db
from refora_server.repositories.errors import RepoError


@pytest.fixture
def db():
    db = open_ocr_db()
    yield db
    db.close()


@pytest.fixture
def repo(db):
    return make_ocr_repo(db)


def _seed_doc(db, doc_id="doc-1"):
    docs = make_docs_repo(db, library_folder="/lib")
    docs["insert"](make_doc(id=doc_id, file_path="/lib/paper.pdf", file_name="paper.pdf"))
    return docs


def _make_job(
    *,
    id="job-1",
    documentId="doc-1",
    resultKey="ocr/doc-1/v1",
    sourceHash="hash-1",
    profile="balanced",
    status="queued",
    stage="queued",
    progress=None,
    errorCode=None,
    errorMessage=None,
    createdAt=1_000_000,
    startedAt=None,
    finishedAt=None,
    updatedAt=1_000_000,
):
    return {
        "id": id,
        "documentId": documentId,
        "resultKey": resultKey,
        "sourceHash": sourceHash,
        "profile": profile,
        "status": status,
        "stage": stage,
        "progress": progress,
        "errorCode": errorCode,
        "errorMessage": errorMessage,
        "createdAt": createdAt,
        "startedAt": startedAt,
        "finishedAt": finishedAt,
        "updatedAt": updatedAt,
    }


def _make_result(
    *,
    id="res-1",
    documentId="doc-1",
    resultKey="ocr/doc-1/v1",
    sourceHash="hash-1",
    mineruVersion="3.4.4",
    modelRevision="rev-1",
    profile="balanced",
    optionsHash="opts-1",
    schemaVersion=1,
    relativeRoot="ocr/doc-1",
    markdownRelativePath="ocr/doc-1/paper.md",
    blocksRelativePath="ocr/doc-1/blocks.json",
    manifestRelativePath="ocr/doc-1/manifest.json",
    createdAt=2_000_000,
):
    return {
        "id": id,
        "documentId": documentId,
        "resultKey": resultKey,
        "sourceHash": sourceHash,
        "mineruVersion": mineruVersion,
        "modelRevision": modelRevision,
        "profile": profile,
        "optionsHash": optionsHash,
        "schemaVersion": schemaVersion,
        "relativeRoot": relativeRoot,
        "markdownRelativePath": markdownRelativePath,
        "blocksRelativePath": blocksRelativePath,
        "manifestRelativePath": manifestRelativePath,
        "createdAt": createdAt,
    }


def test_get_job_missing_returns_none(repo):
    assert repo["getJob"]("missing") is None


def test_create_job_and_get_roundtrip(db, repo):
    _seed_doc(db)
    job = repo["createJob"](_make_job())
    assert job["id"] == "job-1"
    assert job["documentId"] == "doc-1"
    assert job["status"] == "queued"
    assert job["stage"] == "queued"
    assert job["progress"] is None
    assert job["errorCode"] is None
    assert job["startedAt"] is None
    assert job["finishedAt"] is None
    fetched = repo["getJob"]("job-1")
    assert fetched == job


def test_create_job_persists_all_fields(db, repo):
    _seed_doc(db)
    repo["createJob"](
        _make_job(
            status="running",
            stage="parsing",
            progress=42.5,
            errorCode=None,
            errorMessage=None,
            startedAt=1_100_000,
        )
    )
    fetched = repo["getJob"]("job-1")
    assert fetched["status"] == "running"
    assert fetched["stage"] == "parsing"
    assert fetched["progress"] == 42.5
    assert fetched["startedAt"] == 1_100_000


def test_update_job_applies_patch_and_bumps_updatedAt(db, repo):
    _seed_doc(db)
    repo["createJob"](_make_job(createdAt=1_000_000, updatedAt=1_000_000))
    updated = repo["updateJob"](
        "job-1",
        {
            "status": "running",
            "stage": "parsing",
            "progress": 10.0,
            "startedAt": 1_100_000,
        },
    )
    assert updated["status"] == "running"
    assert updated["stage"] == "parsing"
    assert updated["progress"] == 10.0
    assert updated["startedAt"] == 1_100_000
    assert updated["updatedAt"] >= 1_000_000
    assert repo["getJob"]("job-1")["status"] == "running"


def test_update_job_preserves_untouched_fields(db, repo):
    _seed_doc(db)
    repo["createJob"](_make_job(stage="parsing", progress=5.0))
    updated = repo["updateJob"]("job-1", {"progress": 99.0})
    assert updated["progress"] == 99.0
    assert updated["stage"] == "parsing"
    assert updated["status"] == "queued"


def test_update_job_missing_raises(db, repo):
    with pytest.raises(RepoError) as exc:
        repo["updateJob"]("nope", {"status": "running"})
    assert exc.value.code == "not_found"


def test_update_job_to_failed_sets_error_fields(db, repo):
    _seed_doc(db)
    repo["createJob"](_make_job(status="running", stage="parsing", startedAt=1_100_000))
    updated = repo["updateJob"](
        "job-1",
        {
            "status": "failed",
            "stage": "validating",
            "errorCode": "mineru_crash",
            "errorMessage": "worker exited",
            "finishedAt": 1_200_000,
        },
    )
    assert updated["status"] == "failed"
    assert updated["errorCode"] == "mineru_crash"
    assert updated["errorMessage"] == "worker exited"
    assert updated["finishedAt"] == 1_200_000


def test_get_active_job_returns_queued_or_running(db, repo):
    _seed_doc(db)
    repo["createJob"](_make_job(id="j-old", status="succeeded", createdAt=100, resultKey="k1"))
    repo["createJob"](_make_job(id="j-active", status="running", createdAt=200, resultKey="k2"))
    active = repo["getActiveJob"]("doc-1")
    assert active is not None
    assert active["id"] == "j-active"


def test_get_active_job_returns_none_when_only_terminal(db, repo):
    _seed_doc(db)
    repo["createJob"](_make_job(id="j-done", status="succeeded", resultKey="k1"))
    assert repo["getActiveJob"]("doc-1") is None


def test_get_active_job_scoped_to_document(db, repo):
    _seed_doc(db, "doc-1")
    _seed_doc(db, "doc-2")
    repo["createJob"](_make_job(id="j1", documentId="doc-1", status="running", resultKey="k1"))
    repo["createJob"](_make_job(id="j2", documentId="doc-2", status="running", resultKey="k2"))
    active = repo["getActiveJob"]("doc-1")
    assert active is not None
    assert active["id"] == "j1"


def test_get_any_active_job_returns_oldest_active(db, repo):
    _seed_doc(db, "doc-1")
    _seed_doc(db, "doc-2")
    repo["createJob"](_make_job(id="j-new", documentId="doc-1", status="running", createdAt=300, resultKey="k1"))
    repo["createJob"](_make_job(id="j-old", documentId="doc-2", status="queued", createdAt=100, resultKey="k2"))
    any_active = repo["getAnyActiveJob"]()
    assert any_active is not None
    assert any_active["id"] == "j-old"


def test_get_any_active_job_returns_none_when_no_active(db, repo):
    _seed_doc(db)
    repo["createJob"](_make_job(status="succeeded", resultKey="k1"))
    assert repo["getAnyActiveJob"]() is None


def test_mark_running_interrupted_interrupts_active_jobs(db, repo):
    _seed_doc(db, "doc-1")
    _seed_doc(db, "doc-2")
    repo["createJob"](_make_job(id="j-q", documentId="doc-1", status="queued", resultKey="k1"))
    repo["createJob"](_make_job(id="j-r", documentId="doc-2", status="running", startedAt=500, resultKey="k2"))
    repo["createJob"](_make_job(id="j-s", documentId="doc-1", status="succeeded", resultKey="k3"))
    changed = repo["markRunningInterrupted"]()
    assert changed == 2
    q = repo["getJob"]("j-q")
    r = repo["getJob"]("j-r")
    s = repo["getJob"]("j-s")
    assert q["status"] == "interrupted"
    assert q["errorCode"] == "interrupted"
    assert q["finishedAt"] is not None
    assert r["status"] == "interrupted"
    assert s["status"] == "succeeded"


def test_insert_result_and_get_result_roundtrip(db, repo):
    _seed_doc(db)
    result = repo["insertResult"](_make_result())
    assert result["id"] == "res-1"
    assert result["documentId"] == "doc-1"
    assert result["sourceHash"] == "hash-1"
    assert result["schemaVersion"] == 1
    fetched = repo["getResult"]("doc-1")
    assert fetched == result


def test_get_result_missing_returns_none(db, repo):
    _seed_doc(db)
    assert repo["getResult"]("doc-1") is None


def test_get_result_stale_when_source_hash_differs(db, repo):
    _seed_doc(db)
    repo["insertResult"](_make_result(sourceHash="hash-1"))
    fresh = repo["getResult"]("doc-1", "hash-1")
    stale = repo["getResult"]("doc-1", "hash-different")
    no_arg = repo["getResult"]("doc-1")
    assert fresh["stale"] is False
    assert stale["stale"] is True
    assert no_arg["stale"] is False


def test_insert_result_upserts_on_documentId_resultKey(db, repo):
    _seed_doc(db)
    repo["insertResult"](_make_result(id="res-1", mineruVersion="3.4.4", createdAt=1_000))
    repo["insertResult"](
        _make_result(id="res-2", mineruVersion="3.5.0", createdAt=2_000)
    )
    cur = db.execute("SELECT count(*) AS c FROM document_ocr_results WHERE documentId = 'doc-1'").fetchone()
    assert cur["c"] == 1
    fetched = repo["getResult"]("doc-1")
    assert fetched["mineruVersion"] == "3.5.0"


def test_get_result_by_key(db, repo):
    _seed_doc(db)
    repo["insertResult"](_make_result(resultKey="ocr/doc-1/v1"))
    fetched = repo["getResultByKey"]("doc-1", "ocr/doc-1/v1")
    assert fetched is not None
    assert fetched["resultKey"] == "ocr/doc-1/v1"
    assert repo["getResultByKey"]("doc-1", "missing") is None


def test_delete_result(db, repo):
    _seed_doc(db)
    repo["insertResult"](_make_result(resultKey="k1"))
    repo["insertResult"](
        _make_result(id="res-2", resultKey="k2", createdAt=3_000)
    )
    repo["deleteResult"]("doc-1", "k1")
    assert repo["getResultByKey"]("doc-1", "k1") is None
    assert repo["getResultByKey"]("doc-1", "k2") is not None


def test_result_supports_multiple_results_latest_first(db, repo):
    _seed_doc(db)
    repo["insertResult"](_make_result(id="r1", resultKey="k1", createdAt=1_000))
    repo["insertResult"](_make_result(id="r2", resultKey="k2", createdAt=5_000))
    latest = repo["getResult"]("doc-1")
    assert latest["id"] == "r2"


def test_create_job_invalid_profile_rejected_by_check(db, repo):
    _seed_doc(db)
    with pytest.raises(Exception):
        repo["createJob"](_make_job(profile="turbo"))


def test_create_job_invalid_status_rejected_by_check(db, repo):
    _seed_doc(db)
    with pytest.raises(Exception):
        repo["createJob"](_make_job(status="flying"))


def test_create_job_invalid_stage_rejected_by_check(db, repo):
    _seed_doc(db)
    with pytest.raises(Exception):
        repo["createJob"](_make_job(stage="teleporting"))


def test_cascade_delete_document_removes_ocr_jobs_and_results(db, repo):
    docs = _seed_doc(db, "doc-1")
    repo["createJob"](_make_job(documentId="doc-1", resultKey="k1"))
    repo["insertResult"](_make_result(documentId="doc-1", resultKey="k1"))
    assert repo["getJob"]("job-1") is not None
    assert repo["getResult"]("doc-1") is not None
    docs["delete"]("doc-1")
    assert repo["getJob"]("job-1") is None
    assert repo["getResult"]("doc-1") is None
    cur = db.execute(
        "SELECT count(*) AS c FROM document_ocr_jobs WHERE documentId = 'doc-1'"
    ).fetchone()
    assert cur["c"] == 0
    cur = db.execute(
        "SELECT count(*) AS c FROM document_ocr_results WHERE documentId = 'doc-1'"
    ).fetchone()
    assert cur["c"] == 0


def test_cascade_delete_document_does_not_touch_other_documents(db, repo):
    _seed_doc(db, "doc-1")
    _seed_doc(db, "doc-2")
    repo["createJob"](_make_job(id="j1", documentId="doc-1", resultKey="k1"))
    repo["createJob"](_make_job(id="j2", documentId="doc-2", resultKey="k2"))
    repo["insertResult"](_make_result(id="r1", documentId="doc-1", resultKey="k1"))
    repo["insertResult"](_make_result(id="r2", documentId="doc-2", resultKey="k2"))
    docs = make_docs_repo(db, library_folder="/lib")
    docs["delete"]("doc-1")
    assert repo["getJob"]("j1") is None
    assert repo["getResult"]("doc-1") is None
    assert repo["getJob"]("j2") is not None
    assert repo["getResult"]("doc-2") is not None


def test_create_job_requires_existing_document_fk(db, repo):
    with pytest.raises(Exception):
        repo["createJob"](_make_job(documentId="nonexistent-doc"))


def test_full_lifecycle_running_to_succeeded(db, repo):
    _seed_doc(db)
    repo["createJob"](_make_job(status="queued", stage="queued"))
    repo["updateJob"]("job-1", {"status": "running", "stage": "startingWorker", "startedAt": 1_100})
    repo["updateJob"]("job-1", {"stage": "loadingModels", "progress": 10.0})
    repo["updateJob"]("job-1", {"stage": "parsing", "progress": 60.0})
    repo["updateJob"]("job-1", {"stage": "writingResults", "progress": 90.0})
    repo["updateJob"](
        "job-1",
        {"status": "succeeded", "stage": "completed", "progress": 100.0, "finishedAt": 1_900},
    )
    final = repo["getJob"]("job-1")
    assert final["status"] == "succeeded"
    assert final["stage"] == "completed"
    assert final["progress"] == 100.0
    assert final["finishedAt"] == 1_900
    repo["insertResult"](_make_result())
    assert repo["getResult"]("doc-1") is not None
