from __future__ import annotations

import asyncio
import json
import os

import pytest

from conftest import make_doc, make_docs_repo, make_ocr_repo, open_migrated_db
from refora_server.ocr.types import MINERU_VERSION
from refora_server.ocr.paths import get_ocr_result_root
from refora_server.repositories.errors import RepoError
from refora_server.services import ocr as ocr_mod
from refora_server.services.mineru import MineruRuntime
from refora_server.services.ocr import OcrServiceDeps, create_ocr_service


class _FakeEngineStatus:
    def __init__(self, state="installed"):
        self.state = state

    def to_dict(self):
        return {"state": self.state}


class _FakeEngineManager:
    def __init__(self, *, model_revision="rev-1", installed=True):
        self._model_revision = model_revision
        self._installed = installed

    async def getStatus(self):
        return _FakeEngineStatus("installed" if self._installed else "notInstalled")

    async def getRuntime(self):
        if not self._installed:
            raise RuntimeError("MinerU is not installed")
        return MineruRuntime(
            installPath="/engines/MinerU",
            pythonPath="/engines/MinerU/runtime/venv/bin/python",
            modelConfigPath="/engines/MinerU/mineru.json",
            modelRevision=self._model_revision,
            environment={"MINERU_MODEL_SOURCE": "local"},
        )

    def __getitem__(self, name):
        return getattr(self, name)


class _FakeWorker:
    def __init__(self, *, delay=0.0, fail=False, block_event=None):
        self.delay = delay
        self.fail = fail
        self.block_event = block_event
        self.parse_calls: list[dict] = []
        self.cancelled = False

    async def parse(self, input_path, output_path, profile, on_progress):
        self.parse_calls.append(
            {"inputPath": input_path, "outputPath": output_path, "profile": profile}
        )
        if self.block_event is not None:
            await self.block_event.wait()
            if self.cancelled:
                raise RuntimeError("MinerU conversion was cancelled")
        if self.delay:
            await asyncio.sleep(self.delay)
        on_progress(_Progress("parsing", 0.5))
        os.makedirs(output_path, exist_ok=True)
        with open(os.path.join(output_path, "document.md"), "w") as fh:
            fh.write("# Title\n\nBody text")
        with open(os.path.join(output_path, "blocks.jsonl"), "w") as fh:
            fh.write(json.dumps({"type": "text", "text": "Body"}) + "\n")
        with open(os.path.join(output_path, "middle.json"), "w") as fh:
            json.dump({"pdf_info": [{"page": 1}, {"page": 2}]}, fh)
        if self.fail:
            raise RuntimeError("worker exploded")
        from refora_server.services.mineru import ParseResult

        return ParseResult(
            markdown="document.md",
            blocks="blocks.jsonl",
            middle="middle.json",
            assets=None,
            pageCount=2,
            blockCount=1,
        )

    async def cancel(self):
        self.cancelled = True
        if self.block_event is not None:
            self.block_event.set()

    async def stop(self):
        pass

    def destroy(self):
        pass

    def __getitem__(self, name):
        return getattr(self, name)


class _Progress:
    def __init__(self, stage, progress):
        self.stage = stage
        self.progress = progress


@pytest.fixture
def library_folder(tmp_path):
    lib = tmp_path / "library"
    lib.mkdir()
    return str(lib)


@pytest.fixture
def db():
    db = open_migrated_db()
    yield db
    db.close()


@pytest.fixture
def repos(db, library_folder):
    docs = make_docs_repo(db, library_folder=library_folder)
    ocr_repo = make_ocr_repo(db)

    def transaction(operation):
        db.execute("BEGIN IMMEDIATE")
        try:
            result = operation()
            db.execute("COMMIT")
            return result
        except BaseException:
            db.execute("ROLLBACK")
            raise

    return {
        "documents": docs,
        "documentOcr": ocr_repo,
        "transaction": transaction,
    }


@pytest.fixture
def pdf_path(library_folder):
    path = os.path.join(library_folder, "paper.pdf")
    with open(path, "wb") as fh:
        fh.write(b"%PDF-1.4 fake")
    return path


def _seed_doc(repos, pdf_path, *, doc_id="doc-1", file_hash="hash-doc-1"):
    repos["documents"]["insert"](
        make_doc(id=doc_id, file_path=pdf_path, file_name="paper.pdf", file_hash=file_hash)
    )


def _make_deps(library_folder, worker, engine=None, *, progress_events=None, completed_events=None, error_events=None):
    return OcrServiceDeps(
        engineManager=engine or _FakeEngineManager(),
        worker=worker,
        getLibraryFolder=lambda: library_folder,
        emitProgress=lambda event: progress_events.append(event) if progress_events is not None else None,
        emitCompleted=lambda event: completed_events.append(event) if completed_events is not None else None,
        emitError=lambda event: error_events.append(event) if error_events is not None else None,
    )


@pytest.mark.asyncio
async def test_start_ocr_succeeds_and_stores_result(repos, library_folder, pdf_path):
    _seed_doc(repos, pdf_path)
    progress_events: list = []
    completed_events: list = []
    worker = _FakeWorker()
    deps = _make_deps(library_folder, worker, progress_events=progress_events, completed_events=completed_events)
    service = create_ocr_service(repos, deps)
    await service["initialize"]()
    job_id = await service["startOcr"]("doc-1", "balanced")
    assert isinstance(job_id, str)
    await asyncio.sleep(0.05)
    job = repos["documentOcr"]["getJob"](job_id)
    assert job["status"] == "succeeded"
    assert job["stage"] == "completed"
    assert job["progress"] == 1.0
    result = repos["documentOcr"]["getResult"]("doc-1", "hash-doc-1")
    assert result is not None
    assert result["stale"] is False
    assert result["mineruVersion"] == MINERU_VERSION
    assert result["profile"] == "balanced"
    assert completed_events
    assert completed_events[0]["jobId"] == job_id
    assert completed_events[0]["documentId"] == "doc-1"
    stages = [e["job"]["stage"] for e in progress_events]
    assert "startingWorker" in stages
    assert "completed" in stages


@pytest.mark.asyncio
async def test_get_markdown_returns_content(repos, library_folder, pdf_path):
    _seed_doc(repos, pdf_path)
    worker = _FakeWorker()
    deps = _make_deps(library_folder, worker)
    service = create_ocr_service(repos, deps)
    await service["initialize"]()
    job_id = await service["startOcr"]("doc-1", "balanced")
    await asyncio.sleep(0.05)
    markdown = await service["getMarkdown"](job_id)
    assert markdown == "# Title\n\nBody text"


@pytest.mark.asyncio
async def test_prepare_for_agent_waits_until_cache_is_ready(
    repos, library_folder, pdf_path
):
    _seed_doc(repos, pdf_path)
    service = create_ocr_service(
        repos,
        _make_deps(library_folder, _FakeWorker(delay=0.01)),
    )

    cached = await service["prepareForAgent"]("doc-1")

    assert cached["result"]["profile"] == "balanced"
    assert cached["result"]["resultKey"]
    assert cached["markdown"] == "# Title\n\nBody text"
    assert repos["documentOcr"]["getAnyActiveJob"]() is None


@pytest.mark.asyncio
async def test_cancelled_agent_prepare_cleans_up_its_ocr_job(
    repos, library_folder, pdf_path
):
    _seed_doc(repos, pdf_path)
    block_event = asyncio.Event()
    worker = _FakeWorker(block_event=block_event)
    service = create_ocr_service(repos, _make_deps(library_folder, worker))
    task = asyncio.create_task(service["prepareForAgent"]("doc-1"))
    await asyncio.sleep(0.02)

    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task

    assert worker.cancelled is True
    assert repos["documentOcr"]["getAnyActiveJob"]() is None


@pytest.mark.asyncio
async def test_get_state_returns_engine_active_and_result(repos, library_folder, pdf_path):
    _seed_doc(repos, pdf_path)
    worker = _FakeWorker()
    deps = _make_deps(library_folder, worker)
    service = create_ocr_service(repos, deps)
    await service["initialize"]()
    state = await service["getState"]("doc-1")
    assert state["engine"]["state"] == "installed"
    assert state["activeJob"] is None
    assert state["result"] is None
    job_id = await service["startOcr"]("doc-1", "balanced")
    await asyncio.sleep(0.05)
    state = await service["getState"]("doc-1")
    assert state["result"] is not None
    assert state["result"]["resultKey"]


@pytest.mark.asyncio
async def test_get_ocr_state_reports_active_job(repos, library_folder, pdf_path):
    _seed_doc(repos, pdf_path)
    block_event = asyncio.Event()
    worker = _FakeWorker(block_event=block_event)
    deps = _make_deps(library_folder, worker)
    service = create_ocr_service(repos, deps)
    await service["initialize"]()
    job_id = await service["startOcr"]("doc-1", "balanced")
    await asyncio.sleep(0.02)
    ocr_state = await service["getOcrState"]()
    assert ocr_state["activeJob"] is not None
    assert ocr_state["activeJob"]["id"] == job_id
    block_event.set()
    await asyncio.sleep(0.05)
    ocr_state = await service["getOcrState"]()
    assert ocr_state["activeJob"] is None


@pytest.mark.asyncio
async def test_cancel_ocr_marks_job_cancelled(repos, library_folder, pdf_path):
    _seed_doc(repos, pdf_path)
    block_event = asyncio.Event()
    worker = _FakeWorker(block_event=block_event)
    deps = _make_deps(library_folder, worker)
    service = create_ocr_service(repos, deps)
    await service["initialize"]()
    job_id = await service["startOcr"]("doc-1", "balanced")
    await asyncio.sleep(0.02)
    assert worker.parse_calls
    job = await service["cancelOcr"](job_id)
    assert job["status"] == "cancelled"
    assert worker.cancelled


@pytest.mark.asyncio
async def test_cancel_ocr_unknown_job_raises(repos, library_folder):
    worker = _FakeWorker()
    deps = _make_deps(library_folder, worker)
    service = create_ocr_service(repos, deps)
    with pytest.raises(RepoError) as exc:
        await service["cancelOcr"]("nope")
    assert exc.value.code == "not_found"


@pytest.mark.asyncio
async def test_start_ocr_rejects_invalid_profile(repos, library_folder, pdf_path):
    _seed_doc(repos, pdf_path)
    worker = _FakeWorker()
    deps = _make_deps(library_folder, worker)
    service = create_ocr_service(repos, deps)
    with pytest.raises(RepoError) as exc:
        await service["startOcr"]("doc-1", "turbo")
    assert exc.value.code == "invalid_value"


@pytest.mark.asyncio
async def test_start_ocr_rejects_when_engine_not_installed(repos, library_folder, pdf_path):
    _seed_doc(repos, pdf_path)
    worker = _FakeWorker()
    engine = _FakeEngineManager(installed=False)
    deps = _make_deps(library_folder, worker, engine=engine)
    service = create_ocr_service(repos, deps)
    with pytest.raises(RuntimeError, match="MinerU is not installed"):
        await service["startOcr"]("doc-1", "balanced")


@pytest.mark.asyncio
async def test_start_ocr_unknown_document_raises(repos, library_folder):
    worker = _FakeWorker()
    deps = _make_deps(library_folder, worker)
    service = create_ocr_service(repos, deps)
    with pytest.raises(RepoError) as exc:
        await service["startOcr"]("missing-doc", "balanced")
    assert exc.value.code == "not_found"


@pytest.mark.asyncio
async def test_start_ocr_rejects_concurrent_job(repos, library_folder, pdf_path):
    _seed_doc(repos, pdf_path)
    block_event = asyncio.Event()
    worker = _FakeWorker(block_event=block_event)
    deps = _make_deps(library_folder, worker)
    service = create_ocr_service(repos, deps)
    await service["startOcr"]("doc-1", "balanced")
    await asyncio.sleep(0.02)
    with pytest.raises(RepoError) as exc:
        await service["startOcr"]("doc-1", "balanced")
    assert exc.value.code == "busy"
    block_event.set()
    await asyncio.sleep(0.05)


@pytest.mark.asyncio
async def test_failed_job_emits_error_and_marks_failed(repos, library_folder, pdf_path):
    _seed_doc(repos, pdf_path)
    error_events: list = []
    worker = _FakeWorker(fail=True)
    deps = _make_deps(library_folder, worker, error_events=error_events)
    service = create_ocr_service(repos, deps)
    job_id = await service["startOcr"]("doc-1", "balanced")
    await asyncio.sleep(0.05)
    job = repos["documentOcr"]["getJob"](job_id)
    assert job["status"] == "failed"
    assert job["errorCode"] != "cancelled"
    assert error_events
    assert error_events[0]["jobId"] == job_id


@pytest.mark.asyncio
async def test_success_persistence_rolls_back_result_and_files_atomically(
    repos, library_folder, pdf_path
):
    _seed_doc(repos, pdf_path)
    original_update = repos["documentOcr"]["updateJob"]

    def fail_success_update(job_id, patch):
        if patch.get("status") == "succeeded":
            raise RuntimeError("job update failed")
        return original_update(job_id, patch)

    repos["documentOcr"]["updateJob"] = fail_success_update
    service = create_ocr_service(
        repos,
        _make_deps(library_folder, _FakeWorker()),
    )

    job_id = await service["startOcr"]("doc-1", "balanced")
    await asyncio.sleep(0.05)

    job = repos["documentOcr"]["getJob"](job_id)
    assert job["status"] == "failed"
    assert repos["documentOcr"]["getResult"]("doc-1", "hash-doc-1") is None
    assert not os.path.exists(
        get_ocr_result_root(library_folder, "doc-1", job["resultKey"])
    )


@pytest.mark.asyncio
async def test_get_markdown_unknown_job_raises(repos, library_folder):
    worker = _FakeWorker()
    deps = _make_deps(library_folder, worker)
    service = create_ocr_service(repos, deps)
    with pytest.raises(RepoError) as exc:
        await service["getMarkdown"]("nope")
    assert exc.value.code == "not_found"

@pytest.mark.asyncio
async def test_read_markdown_requires_matching_document_and_current_source(
    repos, library_folder, pdf_path
):
    _seed_doc(repos, pdf_path)
    service = create_ocr_service(repos, _make_deps(library_folder, _FakeWorker()))
    job_id = await service["startOcr"]("doc-1", "balanced")
    await asyncio.sleep(0.05)
    job = repos["documentOcr"]["getJob"](job_id)
    markdown = await service["readMarkdown"]("doc-1", job["resultKey"])
    assert markdown.startswith("# Title")

    document = repos["documents"]["get"]("doc-1")
    repos["documents"]["updateFileIdentity"](
        "doc-1",
        document["filePath"],
        document["fileName"],
        document["fileSize"],
        "new-source-hash",
    )
    state = await service["getState"]("doc-1")
    assert state["result"]["stale"] is True
    with pytest.raises(RepoError) as exc:
        await service["readMarkdown"]("doc-1", job["resultKey"])
    assert exc.value.code == "stale"


@pytest.mark.asyncio
async def test_initialize_marks_running_interrupted(repos, library_folder, pdf_path):
    _seed_doc(repos, pdf_path)
    repos["documentOcr"]["createJob"](
        {
            "id": "stale-job",
            "documentId": "doc-1",
            "resultKey": "k1",
            "sourceHash": "hash-doc-1",
            "profile": "balanced",
            "status": "running",
            "stage": "parsing",
            "progress": 0.5,
            "errorCode": None,
            "errorMessage": None,
            "createdAt": 1,
            "startedAt": 2,
            "finishedAt": None,
            "updatedAt": 3,
        }
    )
    worker = _FakeWorker()
    deps = _make_deps(library_folder, worker)
    service = create_ocr_service(repos, deps)
    await service["initialize"]()
    job = repos["documentOcr"]["getJob"]("stale-job")
    assert job["status"] == "interrupted"


@pytest.mark.asyncio
async def test_prepare_document_delete_cancels_and_removes_root(repos, library_folder, pdf_path):
    _seed_doc(repos, pdf_path)
    block_event = asyncio.Event()
    worker = _FakeWorker(block_event=block_event)
    deps = _make_deps(library_folder, worker)
    service = create_ocr_service(repos, deps)
    await service["initialize"]()
    job_id = await service["startOcr"]("doc-1", "balanced")
    await asyncio.sleep(0.02)
    await service["prepareDocumentDelete"]("doc-1")
    assert worker.cancelled
    job = repos["documentOcr"]["getJob"](job_id)
    assert job["status"] == "cancelled"


@pytest.mark.asyncio
async def test_prepare_for_agent_signal_already_set_cancels_immediately(
    repos, library_folder, pdf_path
):
    _seed_doc(repos, pdf_path)
    block_event = asyncio.Event()
    worker = _FakeWorker(block_event=block_event)
    service = create_ocr_service(repos, _make_deps(library_folder, worker))

    signal = asyncio.Event()
    signal.set()

    with pytest.raises(RuntimeError, match="cancelled"):
        await service["prepareForAgent"]("doc-1", signal)

    assert repos["documentOcr"]["getAnyActiveJob"]() is None


@pytest.mark.asyncio
async def test_prepare_for_agent_signal_set_during_job_cancels_agent_job(
    repos, library_folder, pdf_path
):
    _seed_doc(repos, pdf_path)
    block_event = asyncio.Event()
    worker = _FakeWorker(block_event=block_event)
    service = create_ocr_service(repos, _make_deps(library_folder, worker))

    signal = asyncio.Event()

    async def trigger_signal():
        await asyncio.sleep(0.02)
        signal.set()

    asyncio.create_task(trigger_signal())

    with pytest.raises(RuntimeError, match="cancelled"):
        await service["prepareForAgent"]("doc-1", signal)

    assert worker.cancelled is True
    assert repos["documentOcr"]["getAnyActiveJob"]() is None


@pytest.mark.asyncio
async def test_prepare_for_agent_signal_does_not_cancel_preexisting_job(
    repos, library_folder, pdf_path
):
    _seed_doc(repos, pdf_path)
    block_event = asyncio.Event()
    worker = _FakeWorker(block_event=block_event)
    service = create_ocr_service(repos, _make_deps(library_folder, worker))

    preexisting_job_id = await service["startOcr"]("doc-1", "balanced")
    await asyncio.sleep(0.02)

    signal = asyncio.Event()

    async def trigger_signal():
        await asyncio.sleep(0.02)
        signal.set()

    asyncio.create_task(trigger_signal())

    with pytest.raises(RuntimeError, match="cancelled"):
        await service["prepareForAgent"]("doc-1", signal)

    block_event.set()
    await asyncio.sleep(0.05)
    job = repos["documentOcr"]["getJob"](preexisting_job_id)
    assert job["status"] == "succeeded"


@pytest.mark.asyncio
async def test_prepare_for_agent_without_signal_completes_normally(
    repos, library_folder, pdf_path
):
    _seed_doc(repos, pdf_path)
    service = create_ocr_service(
        repos,
        _make_deps(library_folder, _FakeWorker(delay=0.01)),
    )

    cached = await service["prepareForAgent"]("doc-1", None)

    assert cached["result"]["profile"] == "balanced"
    assert cached["markdown"] == "# Title\n\nBody text"
