import pytest

from conftest import make_docs_repo, open_migrated_db
from refora_server.library import bib_import as bib_import_module
from refora_server.library.bib_import import (
    extractAttachmentPaths,
    importBibtex,
    importFromBibtex,
    normalizeAuthors,
    parseBibtex,
)


def test_atomic_copy_removes_published_file_when_directory_fsync_fails(
    tmp_path, monkeypatch
) -> None:
    source = tmp_path / "source" / "paper.pdf"
    source.parent.mkdir()
    source.write_bytes(b"%PDF-1.4\nsource")
    library = tmp_path / "library"
    original_fsync = bib_import_module.os.fsync
    calls = 0

    def fail_directory_fsync(descriptor: int) -> None:
        nonlocal calls
        calls += 1
        if calls == 2:
            raise OSError("directory fsync failed")
        original_fsync(descriptor)

    monkeypatch.setattr(bib_import_module.os, "fsync", fail_directory_fsync)

    with pytest.raises(OSError, match="directory fsync failed"):
        bib_import_module._copy_to_library(str(source), str(library))

    assert source.read_bytes() == b"%PDF-1.4\nsource"
    assert list(library.iterdir()) == []


def test_atomic_copy_removes_published_file_when_resolve_fails(
    tmp_path, monkeypatch
) -> None:
    source = tmp_path / "source" / "paper.pdf"
    source.parent.mkdir()
    source.write_bytes(b"%PDF-1.4\nsource")
    library = tmp_path / "library"
    original_resolve = bib_import_module.Path.resolve

    def fail_destination_resolve(path, strict: bool = False):
        if path.parent == library and path.name == "paper.pdf":
            raise OSError("resolve failed")
        return original_resolve(path, strict=strict)

    monkeypatch.setattr(bib_import_module.Path, "resolve", fail_destination_resolve)

    with pytest.raises(OSError, match="resolve failed"):
        bib_import_module._copy_to_library(str(source), str(library))

    assert source.read_bytes() == b"%PDF-1.4\nsource"
    assert list(library.iterdir()) == []


@pytest.mark.parametrize(
    "raw, expected",
    [
        ("Smith, Jane", "Jane Smith"),
        ("Smith,Jane", "Jane Smith"),
        ("Smith , Jane", "Jane Smith"),
        ("Smith, Jane and Doe, John", "Jane Smith; John Doe"),
        ("John Smith", "John Smith"),
        ("Mary Jane Watson", "Mary Jane Watson"),
        ("Doe, John, Jr.", "John Doe Jr."),
        ("Doe, Jr., John", "John Doe Jr."),
        ("Solo", "Solo"),
        ("  smith  and  jones  ", "smith; jones"),
        ("", ""),
        ("Van Der Berg, Carl", "Carl Van Der Berg"),
    ],
)
def test_normalize_authors_matches_ts_behavior(raw: str, expected: str) -> None:
    assert normalizeAuthors(raw) == expected


def test_normalize_authors_does_not_rearrange_no_comma_names() -> None:
    assert normalizeAuthors("John Smith") == "John Smith"
    assert normalizeAuthors("Mary Jane Watson") == "Mary Jane Watson"
    assert normalizeAuthors("John Smith and Mary Jane Watson") == "John Smith; Mary Jane Watson"


def test_normalize_authors_preserves_recognizable_institutions() -> None:
    assert normalizeAuthors("OpenAI, Inc. and University of California, Berkeley") == (
        "OpenAI, Inc.; University of California, Berkeley"
    )


def test_parse_bibtex_handles_nested_values_and_ignored_entries() -> None:
    entries = parseBibtex(
        """
        @comment{ignored}
        @article{smith2024,
          title = {A {Nested} Title},
          author = {Smith, Jane and Doe, John},
          pages = { 12 -- 20 },
          doi = "10.1000/example"
        }
        """
    )

    assert len(entries) == 1
    assert entries[0]["citekey"] == "smith2024"
    assert entries[0]["fields"]["title"] == "A {Nested} Title"


def test_import_bibtex_creates_missing_document_and_skips_same_doi() -> None:
    documents = make_docs_repo(open_migrated_db())
    repos = {"documents": documents}
    content = r"""
    @article{smith2024,
      title = {Research \& Practice},
      author = {Smith, Jane and Doe, John},
      year = {2024-01-01},
      journal = {Journal of Tests},
      pages = {12 -- 20},
      doi = {10.1000/example}
    }
    """

    first = importBibtex(repos, content)
    second = importBibtex(repos, content)

    assert len(first["imported"]) == 1
    document = documents["get"](first["imported"][0])
    assert document["title"] == "Research & Practice"
    assert document["authors"] == "Jane Smith; John Doe"
    assert document["year"] == "2024"
    assert document["pages"] == "12-20"
    assert document["fileMissing"] == 1
    assert second["imported"] == []
    assert second["skipped"] == [document["id"]]


def test_extract_attachment_paths_handles_descriptors_and_file_urls(tmp_path) -> None:
    first = tmp_path / "first paper.pdf"
    second = tmp_path / "second.pdf"

    assert extractAttachmentPaths(
        f"First:{first}:application/pdf;file://{second}:application/pdf"
    ) == [str(first), str(second)]


@pytest.mark.asyncio
async def test_import_from_bibtex_restores_zotero_pdf_and_arxiv_support(tmp_path) -> None:
    source_folder = tmp_path / "zotero"
    source_folder.mkdir()
    pdf = source_folder / "paper.pdf"
    pdf.write_bytes(b"%PDF-1.4\npaper")
    bib = source_folder / "library.bib"
    bib.write_text(
        """
        @article{smith2024,
          title = {Attached Paper},
          author = {Smith, Jane},
          archiveprefix = {arXiv},
          eprint = {2401.01234},
          file = {Paper:paper.pdf:application/pdf}
        }
        """,
        encoding="utf-8",
    )
    library = tmp_path / "library"
    documents = make_docs_repo(open_migrated_db(), str(library))
    verified: list[tuple[str, str]] = []

    async def verify(document_id: str, arxiv_id: str) -> None:
        verified.append((document_id, arxiv_id))

    result = await importFromBibtex(
        {"documents": documents},
        str(bib),
        "zotero",
        verify,
        {"getLibraryFolder": lambda: str(library)},
    )

    assert len(result["added"]) == 1
    document = documents["get"](result["added"][0])
    assert document["title"] == "Attached Paper"
    assert document["authors"] == "Jane Smith"
    assert document["fileMissing"] == 0
    assert document["filePath"] == str(library / "paper.pdf")
    assert (library / "paper.pdf").read_bytes() == pdf.read_bytes()
    assert list(library.glob(".refora-bib-import-*")) == []
    assert verified == [(document["id"], "2401.01234")]


@pytest.mark.asyncio
async def test_bibtex_duplicate_hash_preserves_edited_fields_as_remote_values(tmp_path) -> None:
    source_folder = tmp_path / "mendeley"
    source_folder.mkdir()
    pdf = source_folder / "paper.pdf"
    pdf.write_bytes(b"%PDF-1.4\nsame")
    bib = source_folder / "library.bib"
    bib.write_text(
        f"""
        @article{{paper,
          title = {{Imported Title}},
          file = {{{pdf}}}
        }}
        """,
        encoding="utf-8",
    )
    library = tmp_path / "library"
    documents = make_docs_repo(open_migrated_db(), str(library))
    first = await importFromBibtex(
        {"documents": documents},
        str(bib),
        "mendeley",
        deps={"getLibraryFolder": lambda: str(library)},
    )
    document_id = first["added"][0]
    documents["update"](document_id, {"title": "My Title"})
    bib.write_text(
        f"""
        @article{{paper,
          title = {{New Imported Title}},
          file = {{{pdf}}}
        }}
        """,
        encoding="utf-8",
    )

    second = await importFromBibtex(
        {"documents": documents},
        str(bib),
        "mendeley",
        deps={"getLibraryFolder": lambda: str(library)},
    )

    document = documents["get"](document_id)
    assert second["skipped"] == [document_id]
    assert document["title"] == "My Title"
    assert document["remoteValues"]["title"] == {
        "value": "New Imported Title",
        "source": "manual",
    }


@pytest.mark.asyncio
async def test_bibtex_copy_failure_does_not_insert_external_attachment(tmp_path) -> None:
    source_folder = tmp_path / "zotero"
    source_folder.mkdir()
    pdf = source_folder / "paper.pdf"
    pdf.write_bytes(b"%PDF-1.4\nsource")
    bib = source_folder / "library.bib"
    bib.write_text(
        "@article{paper, title={Paper}, file={paper.pdf}}",
        encoding="utf-8",
    )
    library = tmp_path / "library"
    documents = make_docs_repo(open_migrated_db(), str(library))

    def fail_copy(_source: str, _library: str) -> str:
        raise OSError("copy failed")

    result = await importFromBibtex(
        {"documents": documents},
        str(bib),
        "zotero",
        deps={
            "getLibraryFolder": lambda: str(library),
            "copyToLibrary": fail_copy,
        },
    )

    assert result["added"] == []
    assert result["errors"] == [{"key": "paper", "message": "copy failed"}]
    assert documents["list"]({"mode": "all"}) == []
    assert pdf.read_bytes() == b"%PDF-1.4\nsource"


@pytest.mark.asyncio
async def test_bibtex_rejects_copy_result_outside_library_without_removing_source(
    tmp_path,
) -> None:
    source_folder = tmp_path / "mendeley"
    source_folder.mkdir()
    pdf = source_folder / "paper.pdf"
    pdf.write_bytes(b"%PDF-1.4\nsource")
    bib = source_folder / "library.bib"
    bib.write_text(
        f"@article{{paper, title={{Paper}}, file={{{pdf}}}}}",
        encoding="utf-8",
    )
    library = tmp_path / "library"
    documents = make_docs_repo(open_migrated_db(), str(library))

    result = await importFromBibtex(
        {"documents": documents},
        str(bib),
        "mendeley",
        deps={
            "getLibraryFolder": lambda: str(library),
            "copyToLibrary": lambda source, _library: source,
        },
    )

    assert result["added"] == []
    assert "outside the library" in result["errors"][0]["message"]
    assert documents["list"]({"mode": "all"}) == []
    assert pdf.exists()
