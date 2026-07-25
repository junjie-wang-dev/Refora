from conftest import make_docs_repo, open_migrated_db
from refora_server.library.bib_import import importBibtex, parseBibtex


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
    assert document["authors"] == "Smith, Jane; Doe, John"
    assert document["year"] == "2024"
    assert document["pages"] == "12-20"
    assert document["fileMissing"] == 1
    assert second["imported"] == []
    assert second["skipped"] == [document["id"]]
