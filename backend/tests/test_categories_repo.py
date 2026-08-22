import pytest

from conftest import make_cats_repo, make_doc, make_docs_repo, open_schema_db
from refora_server.repositories.errors import RepoError


@pytest.fixture
def db():
    db = open_schema_db()
    yield db
    db.close()


def test_list_empty_returns_empty(db):
    cats = make_cats_repo(db)
    assert cats["list"]() == []


def test_create_returns_category(db):
    cats = make_cats_repo(db)
    cat = cats["create"]("Physics")
    assert cat["name"] == "Physics"
    assert cat["sortOrder"] == 0
    assert cat["createdAt"] > 0
    assert cat["id"]


def test_list_orders_by_sortOrder_then_name(db):
    cats = make_cats_repo(db)
    a = cats["create"]("Zebra")
    b = cats["create"]("Apple")
    c = cats["create"]("Mango")
    db.execute(
        f"UPDATE categories SET sortOrder = 1 WHERE id = '{a['id']}'"
    )
    names = [c["name"] for c in cats["list"]()]
    assert names == ["Apple", "Mango", "Zebra"]


def test_list_includes_document_count(db):
    cats = make_cats_repo(db)
    docs = make_docs_repo(db, library_folder="/lib")
    assigned = cats["create"]("Assigned")
    empty = cats["create"]("Empty")
    docs["insert"](make_doc(id="a", file_path="/lib/a.pdf", file_name="a.pdf"))
    docs["insert"](make_doc(id="b", file_path="/lib/b.pdf", file_name="b.pdf"))
    cats["assign"]("a", assigned["id"])
    cats["assign"]("b", assigned["id"])

    listed = {category["id"]: category for category in cats["list"]()}

    assert listed[assigned["id"]]["count"] == 2
    assert listed[empty["id"]]["count"] == 0


def test_rename_updates_name(db):
    cats = make_cats_repo(db)
    cat = cats["create"]("Old")
    cats["rename"](cat["id"], "New")
    assert cats["list"]()[0]["name"] == "New"


def test_rename_missing_raises(db):
    cats = make_cats_repo(db)
    with pytest.raises(RepoError) as exc:
        cats["rename"]("missing", "New")
    assert exc.value.code == "not_found"


def test_delete_removes_category(db):
    cats = make_cats_repo(db)
    cat = cats["create"]("Physics")
    cats["delete"](cat["id"])
    assert cats["list"]() == []


def test_delete_cascades_document_categories(db):
    cats = make_cats_repo(db)
    docs = make_docs_repo(db, library_folder="/lib")
    cat = cats["create"]("Physics")
    docs["insert"](make_doc(id="a", file_path="/lib/a.pdf", file_name="a.pdf"))
    cats["assign"]("a", cat["id"])
    assert cats["countByCategory"]() == {cat["id"]: 1}
    cats["delete"](cat["id"])
    assert cats["countByCategory"]() == {}
    assert cats["listForDocument"]("a") == []


def test_assign_links_document_and_category(db):
    cats = make_cats_repo(db)
    docs = make_docs_repo(db, library_folder="/lib")
    cat = cats["create"]("Physics")
    docs["insert"](make_doc(id="a", file_path="/lib/a.pdf", file_name="a.pdf"))
    cats["assign"]("a", cat["id"])
    listed = cats["listForDocument"]("a")
    assert len(listed) == 1
    assert listed[0]["id"] == cat["id"]


def test_assign_is_idempotent(db):
    cats = make_cats_repo(db)
    docs = make_docs_repo(db, library_folder="/lib")
    cat = cats["create"]("Physics")
    docs["insert"](make_doc(id="a", file_path="/lib/a.pdf", file_name="a.pdf"))
    cats["assign"]("a", cat["id"])
    cats["assign"]("a", cat["id"])
    assert cats["countByCategory"]() == {cat["id"]: 1}


def test_unassign_removes_link(db):
    cats = make_cats_repo(db)
    docs = make_docs_repo(db, library_folder="/lib")
    cat = cats["create"]("Physics")
    docs["insert"](make_doc(id="a", file_path="/lib/a.pdf", file_name="a.pdf"))
    cats["assign"]("a", cat["id"])
    cats["unassign"]("a", cat["id"])
    assert cats["listForDocument"]("a") == []
    assert cats["countByCategory"]() == {}


def test_unassign_missing_link_is_noop(db):
    cats = make_cats_repo(db)
    docs = make_docs_repo(db, library_folder="/lib")
    cat = cats["create"]("Physics")
    docs["insert"](make_doc(id="a", file_path="/lib/a.pdf", file_name="a.pdf"))
    cats["unassign"]("a", cat["id"])
    assert cats["listForDocument"]("a") == []


def test_assignMany_is_atomic_when_any_document_is_invalid(db):
    cats = make_cats_repo(db)
    docs = make_docs_repo(db, library_folder="/lib")
    cat = cats["create"]("Physics")
    docs["insert"](make_doc(id="a", file_path="/lib/a.pdf", file_name="a.pdf"))

    with pytest.raises(Exception):
        cats["assignMany"](["a", "missing"], cat["id"])

    assert cats["listForDocument"]("a") == []


def test_setForDocuments_clears_all_assignments_in_one_operation(db):
    cats = make_cats_repo(db)
    docs = make_docs_repo(db, library_folder="/lib")
    first = cats["create"]("Physics")
    second = cats["create"]("Math")
    for document_id in ("a", "b"):
        docs["insert"](
            make_doc(
                id=document_id,
                file_path=f"/lib/{document_id}.pdf",
                file_name=f"{document_id}.pdf",
            )
        )
        cats["assign"](document_id, first["id"])
        cats["assign"](document_id, second["id"])

    cats["setForDocuments"](["a", "b"], None)

    assert cats["listForDocument"]("a") == []
    assert cats["listForDocument"]("b") == []


def test_listForDocument_returns_multiple_ordered(db):
    cats = make_cats_repo(db)
    docs = make_docs_repo(db, library_folder="/lib")
    c1 = cats["create"]("Zeta")
    c2 = cats["create"]("Alpha")
    docs["insert"](make_doc(id="a", file_path="/lib/a.pdf", file_name="a.pdf"))
    cats["assign"]("a", c1["id"])
    cats["assign"]("a", c2["id"])
    listed = cats["listForDocument"]("a")
    assert [c["name"] for c in listed] == ["Alpha", "Zeta"]


def test_countByCategory(db):
    cats = make_cats_repo(db)
    docs = make_docs_repo(db, library_folder="/lib")
    c1 = cats["create"]("Physics")
    c2 = cats["create"]("Math")
    docs["insert"](make_doc(id="a", file_path="/lib/a.pdf", file_name="a.pdf"))
    docs["insert"](make_doc(id="b", file_path="/lib/b.pdf", file_name="b.pdf"))
    docs["insert"](make_doc(id="c", file_path="/lib/c.pdf", file_name="c.pdf"))
    cats["assign"]("a", c1["id"])
    cats["assign"]("b", c1["id"])
    cats["assign"]("c", c2["id"])
    counts = cats["countByCategory"]()
    assert counts == {c1["id"]: 2, c2["id"]: 1}


def test_getAllDocumentCategories(db):
    cats = make_cats_repo(db)
    docs = make_docs_repo(db, library_folder="/lib")
    c1 = cats["create"]("Physics")
    c2 = cats["create"]("Math")
    docs["insert"](make_doc(id="a", file_path="/lib/a.pdf", file_name="a.pdf"))
    docs["insert"](make_doc(id="b", file_path="/lib/b.pdf", file_name="b.pdf"))
    cats["assign"]("a", c1["id"])
    cats["assign"]("b", c2["id"])
    links = cats["getAllDocumentCategories"]()
    pairs = {(l["documentId"], l["categoryId"]) for l in links}
    assert pairs == {("a", c1["id"]), ("b", c2["id"])}


def test_category_name_unique_constraint(db):
    cats = make_cats_repo(db)
    cats["create"]("Physics")
    with pytest.raises(Exception):
        cats["create"]("Physics")


def test_assign_used_by_documents_list_category_mode(db):
    cats = make_cats_repo(db)
    docs = make_docs_repo(db, library_folder="/lib")
    cat = cats["create"]("Physics")
    docs["insert"](make_doc(id="a", file_path="/lib/a.pdf", file_name="a.pdf"))
    docs["insert"](make_doc(id="b", file_path="/lib/b.pdf", file_name="b.pdf"))
    cats["assign"]("a", cat["id"])
    listed = docs["list"]({"mode": "category", "categoryId": cat["id"]})
    assert [d["id"] for d in listed] == ["a"]
