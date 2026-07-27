import os
import sys

import pytest

from refora_server.library.paths import (
    containsLibrary,
    isInsideLibrary,
    resolveFromLibrary,
    toLibraryRelative,
)

CASE_INSENSITIVE = sys.platform == "darwin" or sys.platform == "win32"


def test_isInsideLibrary_descendant():
    assert isInsideLibrary("/lib/doc.pdf", "/lib")
    assert isInsideLibrary("/lib/sub/doc.pdf", "/lib")


def test_isInsideLibrary_equals():
    assert isInsideLibrary("/lib", "/lib")


def test_isInsideLibrary_sibling_prefix_mismatch():
    assert not isInsideLibrary("/library2/doc.pdf", "/lib")
    assert not isInsideLibrary("/libXYZ/doc.pdf", "/lib")


def test_isInsideLibrary_parent_of_library():
    assert not isInsideLibrary("/data", "/data/lib")


def test_isInsideLibrary_empty():
    assert not isInsideLibrary("", "/lib")
    assert not isInsideLibrary("/lib/doc.pdf", "")
    assert not isInsideLibrary("", "")


def test_isInsideLibrary_trailing_sep():
    assert isInsideLibrary("/lib/doc.pdf", "/lib/")
    assert isInsideLibrary("/lib/doc.pdf", "/lib//")


def test_isInsideLibrary_resolves_relative():
    assert isInsideLibrary("/lib/sub/../doc.pdf", "/lib")


def test_isInsideLibrary_case_insensitive():
    if not CASE_INSENSITIVE:
        pytest.skip("case-sensitive platform")
    assert isInsideLibrary("/Lib/Doc.PDF", "/lib")
    assert isInsideLibrary("/LIB/SUB/DOC.PDF", "/lib")
    assert isInsideLibrary("/lib", "/LIB")


def test_containsLibrary_descendant():
    assert containsLibrary("/watch", "/watch/lib")
    assert containsLibrary("/watch", "/watch/sub/lib")


def test_containsLibrary_equal_returns_false():
    assert not containsLibrary("/data", "/data")


def test_containsLibrary_outside():
    assert not containsLibrary("/watch", "/other/lib")


def test_containsLibrary_sibling_prefix():
    assert not containsLibrary("/watch2", "/watch/lib")


def test_containsLibrary_empty():
    assert not containsLibrary("", "/lib")
    assert not containsLibrary("/watch", "")


def test_containsLibrary_case_insensitive():
    if not CASE_INSENSITIVE:
        pytest.skip("case-sensitive platform")
    assert containsLibrary("/Watch", "/watch/lib")
    assert containsLibrary("/watch", "/WATCH/LIB")


def test_toLibraryRelative_inside():
    assert toLibraryRelative("/lib/doc.pdf", "/lib") == "doc.pdf"
    assert toLibraryRelative("/lib/sub/doc.pdf", "/lib") == os.path.join("sub", "doc.pdf")


def test_toLibraryRelative_outside_keeps_absolute():
    assert toLibraryRelative("/other/doc.pdf", "/lib") == "/other/doc.pdf"
    assert toLibraryRelative("/libXYZ/doc.pdf", "/lib") == "/libXYZ/doc.pdf"


def test_toLibraryRelative_empty_library():
    assert toLibraryRelative("/lib/doc.pdf", "") == "/lib/doc.pdf"


def test_toLibraryRelative_non_absolute_input():
    assert toLibraryRelative("doc.pdf", "/lib") == "doc.pdf"
    assert toLibraryRelative("sub/doc.pdf", "/lib") == "sub/doc.pdf"


def test_toLibraryRelative_trailing_sep():
    assert toLibraryRelative("/lib/doc.pdf", "/lib/") == "doc.pdf"


def test_toLibraryRelative_rejects_sibling_prefix():
    assert toLibraryRelative("/libExtra/doc.pdf", "/lib") == "/libExtra/doc.pdf"
    assert toLibraryRelative("/lib2/doc.pdf", "/lib") == "/lib2/doc.pdf"


def test_resolveFromLibrary_joins_relative():
    assert resolveFromLibrary("doc.pdf", "/lib") == "/lib/doc.pdf"
    assert resolveFromLibrary("sub/doc.pdf", "/lib") == os.path.join("/lib", "sub", "doc.pdf")


def test_resolveFromLibrary_absolute_unchanged():
    assert resolveFromLibrary("/abs/doc.pdf", "/lib") == "/abs/doc.pdf"


def test_resolveFromLibrary_empty_library():
    assert resolveFromLibrary("doc.pdf", "") == "doc.pdf"


def test_resolveFromLibrary_empty_input():
    assert resolveFromLibrary("", "/lib") == ""


def test_round_trip_inside_library():
    lib = "/lib"
    original = "/lib/sub/doc.pdf"
    rel = toLibraryRelative(original, lib)
    assert resolveFromLibrary(rel, lib) == original


def test_round_trip_outside_library():
    lib = "/lib"
    original = "/other/doc.pdf"
    rel = toLibraryRelative(original, lib)
    assert rel == original
    assert resolveFromLibrary(rel, lib) == original