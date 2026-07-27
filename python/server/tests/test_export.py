import json

from conftest import make_doc, make_docs_repo, open_migrated_db
from refora_server.services.export import (
    lookupVenue,
    toBibtex,
    venueType,
)


def _make_repos(db, library_folder=""):
    docs = make_docs_repo(db, library_folder=library_folder)
    from conftest import make_cats_repo

    cats = make_cats_repo(db)
    from refora_server.repositories.settings import create_settings_repository

    settings = create_settings_repository(db)
    return {"documents": docs, "categories": cats, "settings": settings}


def _insert_doc(db, **overrides):
    doc = make_doc(**overrides)
    db.execute(
        "INSERT INTO documents "
        "(id, filePath, originalFolderPath, fileName, fileSize, fileHash, title, authors, year, venue, "
        "volume, issue, pages, abstract, keywords, url, doi, arxivId, note, affiliations, starred, "
        "addedAt, updatedAt, metadataStatus, editedFields, remoteValues, fileMissing) "
        "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        [
            doc["id"], doc["filePath"], doc["originalFolderPath"], doc["fileName"],
            doc["fileSize"], doc["fileHash"], doc["title"], doc["authors"], doc["year"],
            doc["venue"], doc["volume"], doc["issue"], doc["pages"], doc["abstract"],
            doc["keywords"], doc["url"], doc["doi"], doc["arxivId"], doc["note"],
            doc["affiliations"], doc["starred"], doc["addedAt"], doc["updatedAt"],
            doc["metadataStatus"], "[]", None, doc["fileMissing"],
        ],
    )
    return doc


def test_toBibtex_conference_paper():
    doc = make_doc(
        id="doc-c",
        title="Deep Learning for Vision",
        authors="Smith, John;Doe, Jane",
        year="2023",
        venue="CVPR",
        pages="1--10",
    )
    out = toBibtex([doc])
    assert out.startswith("@inproceedings{smith2023deep,\n")
    assert "booktitle    = {CVPR}" in out
    assert "author       = {John Smith and Jane Doe}" in out
    assert "pages        = {1--10}" in out
    assert out.endswith("\n")


def test_toBibtex_journal_paper():
    doc = make_doc(
        id="doc-j",
        title="A Journal Study",
        authors="Lee, Ann",
        year="2021",
        venue="IEEE Transactions on Pattern Analysis and Machine Intelligence",
        volume="33",
    )
    out = toBibtex([doc])
    assert out.startswith("@article{lee2021journal,\n")
    assert "journal      = {IEEE Transactions on Pattern Analysis and Machine Intelligence}" in out
    assert "volume       = {33}" in out


def test_toBibtex_misc_no_metadata():
    doc = make_doc(id="doc-m", title="Only Title", authors="Brown, C", year="2020")
    out = toBibtex([doc])
    assert out.startswith("@misc{brown2020title,\n")


def test_toBibtex_article_with_volume_only():
    doc = make_doc(id="doc-v", title="V", authors="X, Y", year="2019", volume="5")
    out = toBibtex([doc])
    assert out.startswith("@article{")


def test_toBibtex_empty_when_no_fields():
    doc = make_doc(id="doc-empty")
    assert toBibtex([doc]) == ""


def test_toBibtex_escape_special_chars():
    doc = make_doc(
        id="doc-e",
        title='100% {Special} "chars" ~ ^ \\',
        authors="X, Y",
        year="2020",
    )
    out = toBibtex([doc])
    assert r"\%" in out
    assert r"\{" in out
    assert r"\}" in out
    assert r'{\"}' in out
    assert r"\textasciitilde{}" in out
    assert r"\textasciicircum{}" in out
    assert r"\textbackslash{}" in out


def test_toBibtex_arxiv_eprint():
    doc = make_doc(
        id="doc-a",
        title="ArXiv Paper",
        authors="Z, Q",
        year="2022",
        arxiv_id="2210.00001",
    )
    out = toBibtex([doc])
    assert "eprint       = {2210.00001}" in out
    assert "archiveprefix = {arXiv}" in out


def test_toBibtex_dedup_citekeys():
    doc1 = make_doc(id="d1", title="Same Title", authors="Smith, A", year="2020")
    doc2 = make_doc(id="d2", title="Same Title", authors="Smith, A", year="2020")
    out = toBibtex([doc1, doc2])
    assert "@misc{smith2020title," in out
    assert "smith2020titlea," in out


def test_toBibtex_fallback_to_id_slice():
    doc = make_doc(
        id="abcdef12345",
        title=None,
        authors=None,
        year=None,
        venue="Custom Venue",
    )
    out = toBibtex([doc])
    assert "@article{abcdef12," in out


def test_venueType_and_lookupVenue():
    assert lookupVenue("CVPR 2023")["canonical"] == "CVPR"
    assert venueType("CVPR 2023") == "conference"
    assert venueType("Journal of Foo") == "journal"
    assert venueType("Unknown Venue") is None
    assert lookupVenue("") is None


def test_exportJson_returns_full_payload(db_fixture):
    db = db_fixture
    _insert_doc(db, id="d1", title="T1", authors="A, B", year="2020", venue="CVPR")
    _insert_doc(db, id="d2", title="T2", authors="C, D", year="2021")
    repos = _make_repos(db)
    from refora_server.services.export import createExportService

    svc = createExportService(repos, {"now": lambda: 5000})
    payload = svc["exportJson"](None, None)
    assert payload["version"] == 1
    assert payload["exportedAt"] == 5000
    assert len(payload["documents"]) == 2
    assert isinstance(payload["categories"], list)
    assert isinstance(payload["documentCategories"], list)


def test_exportJson_filtered_by_documentIds(db_fixture):
    db = db_fixture
    _insert_doc(db, id="d1", title="T1")
    _insert_doc(db, id="d2", title="T2")
    repos = _make_repos(db)
    from refora_server.services.export import createExportService

    svc = createExportService(repos, {"now": lambda: 100})
    payload = svc["exportJson"](["d1"], None)
    ids = [d["id"] for d in payload["documents"]]
    assert ids == ["d1"]


def test_exportJson_unknown_documentId_skipped(db_fixture):
    db = db_fixture
    _insert_doc(db, id="d1", title="T1")
    repos = _make_repos(db)
    from refora_server.services.export import createExportService

    svc = createExportService(repos, {"now": lambda: 100})
    payload = svc["exportJson"](["d1", "missing"], None)
    assert [d["id"] for d in payload["documents"]] == ["d1"]


def test_exportBibtex_returns_bibtex_string(db_fixture):
    db = db_fixture
    _insert_doc(db, id="d1", title="Conf Paper", authors="Smith, A", year="2020", venue="CVPR")
    repos = _make_repos(db)
    from refora_server.services.export import createExportService

    svc = createExportService(repos, {"now": lambda: 7})
    payload = svc["exportBibtex"](None)
    assert payload["version"] == 1
    assert payload["exportedAt"] == 7
    assert "@inproceedings{" in payload["bibtex"]


def test_getBibtexString_returns_only_bibtex(db_fixture):
    db = db_fixture
    _insert_doc(db, id="d1", title="T", authors="X, Y", year="2020")
    repos = _make_repos(db)
    from refora_server.services.export import createExportService

    svc = createExportService(repos)
    out = svc["getBibtexString"](["d1"])
    assert "@misc{" in out["bibtex"]


def test_serialize_produces_valid_json(db_fixture):
    db = db_fixture
    _insert_doc(db, id="d1", title="T1")
    repos = _make_repos(db)
    from refora_server.services.export import createExportService

    svc = createExportService(repos, {"now": lambda: 42})
    text = svc["serialize"]()
    parsed = json.loads(text)
    assert parsed["version"] == 1
    assert parsed["exportedAt"] == 42
    assert isinstance(parsed["documents"], list)


def test_toBibtex_multiple_entries_joined_by_blank_line():
    a = make_doc(id="a", title="A", authors="X, Y", year="2020")
    b = make_doc(id="b", title="B", authors="Z, W", year="2021")
    out = toBibtex([a, b])
    entries = out.strip().split("\n\n")
    assert len(entries) == 2


import pytest


@pytest.fixture
def db_fixture():
    db = open_migrated_db()
    yield db
    db.close()
