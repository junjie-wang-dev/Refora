import os

import pytest

from refora_server.library.metadata import (
    deriveDoiFromArxivId,
    extractAbstractFromText,
    extractAffiliationsFromText,
    extractArxivFromFileName,
    extractArxivFromText,
    extractAuthorsFromText,
    extractDoiFromInfo,
    extractDoiFromText,
    extractMetadataFromPdf,
    extractTitleCandidate,
    extractTitleFromText,
    extractVenueFromText,
    isReliableTitle,
    isTemplateNoiseTitle,
    looksLikePosterOrNonPaper,
    normalizeAuthors,
    titleFromFileName,
)


def test_isTemplateNoiseTitle_matches():
    assert isTemplateNoiseTitle("Instructions for Authors") is True
    assert isTemplateNoiseTitle("Formatting Instructions for Camera Ready") is True
    assert isTemplateNoiseTitle("TEMPLATE paper") is True
    assert isTemplateNoiseTitle("Sample Manuscript") is True
    assert isTemplateNoiseTitle("Untitled") is True
    assert isTemplateNoiseTitle("Preliminary Version") is True
    assert isTemplateNoiseTitle("Do Not Cite") is True
    assert isTemplateNoiseTitle("Work in Progress") is True
    assert isTemplateNoiseTitle("Draft Version") is True
    assert isTemplateNoiseTitle("Accepted for Publication") is True


def test_isTemplateNoiseTitle_no_match():
    assert isTemplateNoiseTitle("Attention Is All You Need") is False
    assert isTemplateNoiseTitle("Deep Residual Learning for Image Recognition") is False
    assert isTemplateNoiseTitle("") is False


def test_extractDoiFromText_plain():
    assert extractDoiFromText("see 10.1000/xyz123 for details") == "10.1000/xyz123"


def test_extractDoiFromText_url_prefix():
    assert extractDoiFromText("https://doi.org/10.1000/xyz789") == "10.1000/xyz789"
    assert extractDoiFromText("http://dx.doi.org/10.1000/abc") == "10.1000/abc"


def test_extractDoiFromText_doi_prefix():
    assert extractDoiFromText("DOI: 10.1111/test456") == "10.1111/test456"
    assert extractDoiFromText("doi:10.2222/aaa") == "10.2222/aaa"


def test_extractDoiFromText_trailing_punctuation():
    assert extractDoiFromText("see 10.1000/abc123, for details") == "10.1000/abc123"
    assert extractDoiFromText("ref 10.1000/abc123. end") == "10.1000/abc123"
    assert extractDoiFromText("ref 10.1000/abc123; next") == "10.1000/abc123"
    assert extractDoiFromText("ref 10.1000/abc123) end") == "10.1000/abc123"


def test_extractDoiFromText_returns_first_match():
    text = "first 10.1000/aaa and second 10.2000/bbb"
    assert extractDoiFromText(text) == "10.1000/aaa"


def test_extractDoiFromText_skips_references_section():
    text = "intro\nReferences\n10.1000/shouldskip"
    assert extractDoiFromText(text) is None
    text2 = "10.1000/keep\nReferences\n10.2000/skip"
    assert extractDoiFromText(text2) == "10.1000/keep"


def test_extractDoiFromText_skips_bibliography_heading():
    text = "intro\nBibliography\n10.1000/skip"
    assert extractDoiFromText(text) is None


def test_extractDoiFromText_none():
    assert extractDoiFromText("no doi here") is None
    assert extractDoiFromText("") is None


def test_extractDoiFromInfo_variants():
    assert extractDoiFromInfo({"doi": "10.1000/abc"}) == "10.1000/abc"
    assert extractDoiFromInfo({"DOI": "10.2000/xyz"}) == "10.2000/xyz"
    assert extractDoiFromInfo({"Doi": "10.3000/def"}) == "10.3000/def"
    assert extractDoiFromInfo({}) is None
    assert extractDoiFromInfo({"doi": ""}) is None
    assert extractDoiFromInfo({"doi": "  "}) == ""
    assert extractDoiFromInfo({"doi": 123}) is None


def test_extractArxivFromText_modern():
    assert extractArxivFromText("arXiv:2106.01234") == "2106.01234"
    assert extractArxivFromText("arxiv:2106.01234v1") == "2106.01234v1"


def test_extractArxivFromText_url():
    assert extractArxivFromText("see arxiv.org/abs/2106.01234") == "2106.01234"
    assert extractArxivFromText("arxiv.org/pdf/2106.01234v2") == "2106.01234v2"


def test_extractArxivFromText_legacy():
    assert extractArxivFromText("arXiv:cs.AI/0701001") == "cs.AI/0701001"


def test_extractArxivFromText_none():
    assert extractArxivFromText("no arxiv here") is None
    assert extractArxivFromText("") is None


def test_extractArxivFromFileName():
    assert extractArxivFromFileName("2412.16776v1.pdf") == "2412.16776v1"
    assert extractArxivFromFileName("arxiv-1910.05653.pdf") == "1910.05653"
    assert extractArxivFromFileName("paper3.pdf") is None


def test_deriveDoiFromArxivId_modern():
    assert deriveDoiFromArxivId("2106.01234") == "10.48550/arXiv.2106.01234"
    assert deriveDoiFromArxivId("2106.01234v1") == "10.48550/arXiv.2106.01234"


def test_deriveDoiFromArxivId_legacy():
    assert deriveDoiFromArxivId("cs.AI/0701001") == "10.48550/arXiv.cs.AI/0701001"


def test_deriveDoiFromArxivId_normalizes_input():
    assert deriveDoiFromArxivId("arXiv:2106.01234v3") == "10.48550/arXiv.2106.01234"


def test_extractAbstractFromText_keyword():
    text = (
        "Title\nAuthors\nAbstract\n"
        "This is the abstract of the paper. It discusses important findings.\n"
        "We present a novel method for solving problems.\n"
        "Keywords: machine learning\n"
    )
    result = extractAbstractFromText(text)
    assert result is not None
    assert "abstract of the paper" in result
    assert "Keywords" not in result


def test_extractAbstractFromText_inline_keyword():
    text = (
        "Abstract: This paper studies deep learning. "
        "We propose a new architecture.\n"
        "1 Introduction\n"
    )
    result = extractAbstractFromText(text)
    assert result is not None
    assert "deep learning" in result


def test_extractAbstractFromText_stops_at_introduction():
    text = (
        "Abstract\n"
        "First sentence of abstract.\n"
        "Second sentence here.\n"
        "1 Introduction\n"
        "This should not be included.\n"
    )
    result = extractAbstractFromText(text)
    assert result is not None
    assert "First sentence" in result
    assert "should not be included" not in result


def test_extractAbstractFromText_cn_keyword():
    text = "标题\n作者\n摘 要\n本文研究深度学习。我们提出了新方法。\n关键词\n"
    result = extractAbstractFromText(text)
    assert result is not None
    assert "深度学习" in result


def test_extractAbstractFromText_none_when_no_keyword():
    text = "Title\nAuthors\nSome random text without keyword.\nMore text.\n"
    result = extractAbstractFromText(text)
    assert result is None or len(result) > 0


def test_extractAbstractFromText_spaced_keyword():
    text = "A B S T R A C T\nWe study transformers. The results are good.\n1 Introduction\n"
    result = extractAbstractFromText(text)
    assert result is not None
    assert "transformers" in result


def test_extractAbstractFromText_truncates_at_2000():
    long_sentence = "word " * 500
    text = f"Abstract\n{long_sentence}\nKeywords\n"
    result = extractAbstractFromText(text)
    assert result is not None
    assert len(result) <= 2000


def test_extractAffiliationsFromText_block_header():
    text = (
        "Title\nAuthors\n"
        "Affiliations: Department of CS, MIT; Google Research\n"
        "Abstract\nWe study X.\n"
    )
    result = extractAffiliationsFromText(text)
    assert result is not None
    assert "Department of CS, MIT" in result
    assert "Google Research" in result


def test_extractAffiliationsFromText_superscript_markers():
    text = (
        "Title\nJohn Smith, Jane Doe\n"
        "1\nDepartment of Computer Science, MIT\n"
        "2\nGoogle Research\n"
        "Abstract\nWe study deep learning.\n"
    )
    result = extractAffiliationsFromText(text)
    assert result is not None
    assert "Department of Computer Science, MIT" in result
    assert "Google Research" in result


def test_extractAffiliationsFromText_removes_inline_numeric_markers():
    text = (
        "Title\nAuthors\n"
        "1 Southwest Jiaotong University2 University of Leeds3 City University of Hong Kong\n"
        "4 NVIDIA 5 The University of California, Merced6 Yonsei University\n"
        "Abstract\nWe study large scenes.\n"
    )
    result = extractAffiliationsFromText(text)
    assert result == (
        "Southwest Jiaotong University; University of Leeds; City University of Hong Kong; "
        "NVIDIA; The University of California, Merced; Yonsei University"
    )


def test_extractAffiliationsFromText_removes_numeric_line_prefixes():
    text = (
        "Title\nAuthors\n"
        "1 ShanghaiTech University\n"
        "2 The Chinese University of Hong Kong\n"
        "3 Shanghai AI Laboratory\n"
        "Abstract\nWe study occupancy.\n"
    )
    result = extractAffiliationsFromText(text)
    assert result == (
        "ShanghaiTech University; The Chinese University of Hong Kong; Shanghai AI Laboratory"
    )


def test_extractAffiliationsFromText_removes_attached_numeric_prefixes():
    text = (
        "Towards Model-Agnostic Cooperative Perception\n"
        "Junjie Wang1, Tomas Nordstr ¨om1,2\n"
        "1Department of Applied Physics and Electronics, Ume ˚a University\n"
        "2RISE Research Institutes of Sweden\n"
        "Abstract—We study cooperative perception.\n"
    )
    assert extractAffiliationsFromText(text) == (
        "Department of Applied Physics and Electronics, Umeå University; "
        "RISE Research Institutes of Sweden"
    )


def test_extractAffiliationsFromText_splits_inline_symbol_markers():
    text = (
        "Title\nAuthors\n"
        "∗Aalto University †Naver Labs Europe\n"
        "Abstract\nWe study geometry.\n"
    )
    assert extractAffiliationsFromText(text) == "Aalto University; Naver Labs Europe"


def test_extractAffiliationsFromText_supports_acronym_institutions():
    text = (
        "Title\nAuthor One\n"
        "ETH Zurich, Switzerland\n"
        "Author Two\n"
        "EPFL, Switzerland\n"
        "Abstract\nWe study fusion.\n"
    )
    assert extractAffiliationsFromText(text) == "ETH Zurich, Switzerland; EPFL, Switzerland"


def test_extractAffiliationsFromText_supports_physics_front_matter():
    text = (
        "A Physics Paper\n"
        "Author One1, Author Two2\n"
        "1Key Laboratory of Physics, Example University\n"
        "2College of Physics, Example University\n"
        "(Dated: January 6, 2026)\n"
        "The scattering phase shift is computed.\n"
        "I. INTRODUCTION\n"
    )
    assert extractAffiliationsFromText(text) == (
        "Key Laboratory of Physics, Example University; "
        "College of Physics, Example University"
    )


def test_extractAffiliationsFromText_preserves_internal_building_number():
    text = (
        "Title\nAuthors\n"
        "Building 3 Research Institute\n"
        "Abstract\nWe study research facilities.\n"
    )
    assert extractAffiliationsFromText(text) == "Building 3 Research Institute"


def test_extractAuthorsFromText_reads_numbered_pdf_author_line():
    text = (
        "Towards Model-Agnostic Cooperative Perception\n"
        "Junjie Wang1, Tomas Nordstr ¨om1,2\n"
        "1Department of Applied Physics and Electronics, Ume ˚a University\n"
        "2RISE Research Institutes of Sweden\n"
        "Abstract—We study cooperative perception.\n"
    )
    assert extractAuthorsFromText(text) == "Junjie Wang; Tomas Nordström"


def test_extractAffiliationsFromText_plain_line():
    text = (
        "Title\nAuthors\n"
        "Department of Computer Science, Stanford University\n"
        "Abstract\nWe study Y.\n"
    )
    result = extractAffiliationsFromText(text)
    assert result is not None
    assert "Stanford University" in result


def test_extractAffiliationsFromText_none_without_abstract():
    text = "Title\nAuthors\nDepartment of CS, MIT\nSome content without the keyword.\n"
    assert extractAffiliationsFromText(text) is None


def test_extractAffiliationsFromText_dedup():
    text = (
        "Title\nAuthors\n"
        "Department of CS, MIT\n"
        "Department of CS, MIT\n"
        "Abstract\nWe study.\n"
    )
    result = extractAffiliationsFromText(text)
    assert result == "Department of CS, MIT"


def test_extractAffiliationsFromText_stops_at_abstract():
    text = (
        "Title\nAuthors\n"
        "Abstract\n"
        "Department of CS, MIT\n"
    )
    assert extractAffiliationsFromText(text) is None


def test_extractTitleFromText_basic():
    text = "Attention Is All You Need\nAuthors\nAbstract\nWe study attention.\n"
    result = extractTitleFromText(text)
    assert result == "Attention Is All You Need"


def test_extractTitleFromText_continuation():
    text = (
        "Deep Residual Learning for\n"
        "Image Recognition\n"
        "Authors\nAbstract\nWe study residual learning.\n"
    )
    result = extractTitleFromText(text)
    assert "Deep Residual Learning" in result
    assert "Image Recognition" in result


def test_extractTitleFromText_skips_noise():
    text = (
        "arXiv:2106.01234\n"
        "The Real Title\n"
        "Abstract\ncontent\n"
    )
    result = extractTitleFromText(text)
    assert result == "The Real Title"


def test_extractVenueFromText_conference_banner():
    text = "Published as a conference paper at ICLR 2027\nTitle\nAbstract\n"
    result = extractVenueFromText(text)
    assert result == {"venue": "ICLR", "year": "2027"}


def test_extractVenueFromText_neurips_alias():
    text = "Published as a conference paper at NIPS 2019\nTitle\n"
    result = extractVenueFromText(text)
    assert result == {"venue": "NeurIPS", "year": "2019"}


def test_extractVenueFromText_under_review():
    text = "Under review as a conference paper at CVPR 2024\nTitle\n"
    result = extractVenueFromText(text)
    assert result == {"venue": "CVPR", "year": "2024"}


def test_extractVenueFromText_under_review_no_year_returns_none():
    text = "Under review for conference\nTitle\n"
    assert extractVenueFromText(text) is None


def test_extractVenueFromText_ieee_transactions():
    text = "IEEE Transactions on Pattern Analysis 12 2020\nTitle\n"
    result = extractVenueFromText(text)
    assert result is not None
    assert result["venue"].startswith("IEEE")


def test_extractVenueFromText_none():
    assert extractVenueFromText("Just a plain paper title\n") is None


def test_isReliableTitle_valid():
    text = "Title\nAuthors\nAbstract\ncontent\n"
    assert isReliableTitle("Attention Is All You Need", text) is True


def test_isReliableTitle_too_short():
    assert isReliableTitle("Hi", "abstract content") is False


def test_isReliableTitle_too_long():
    assert isReliableTitle("x" * 400, "abstract") is False


def test_isReliableTitle_single_word():
    assert isReliableTitle("Supercalifragilistic", "abstract") is False


def test_isReliableTitle_contains_doi():
    assert isReliableTitle("Paper 10.1000/abc123 here", "abstract") is False


def test_isReliableTitle_noise_pattern():
    assert isReliableTitle("Figure 1 Results", "abstract") is False


def test_isReliableTitle_none():
    assert isReliableTitle(None, "abstract") is False
    assert isReliableTitle("", "abstract") is False
    assert isReliableTitle("   ", "abstract") is False


def test_looksLikePosterOrNonPaper_keyword():
    assert looksLikePosterOrNonPaper("This is a poster presentation\n" * 5) is True


def test_looksLikePosterOrNonPaper_not():
    text = "A Real Paper Title\nAuthors\nAbstract\n" + "sentence. " * 20
    assert looksLikePosterOrNonPaper(text) is False


def test_titleFromFileName_basic():
    assert titleFromFileName("Attention Is All You Need.pdf") == "Attention Is All You Need"


def test_titleFromFileName_underscores():
    assert titleFromFileName("deep_learning_paper.pdf") == "Deep learning paper"


def test_titleFromFileName_camelcase():
    assert titleFromFileName("camelCaseTitle.pdf") == "Camel Case Title"


def test_titleFromFileName_leading_year():
    result = titleFromFileName("2021_deep_learning.pdf")
    assert "Deep learning" in result
    assert not result.startswith("2021")


def test_titleFromFileName_empty():
    assert titleFromFileName(".pdf") is None
    assert titleFromFileName("   .pdf") is None


def test_normalizeAuthors_keeps_given_name_first():
    assert normalizeAuthors("John Smith; Jane Doe") == "John Smith; Jane Doe"


def test_normalizeAuthors_already_comma():
    assert normalizeAuthors("Smith, John; Doe, Jane") == "John Smith; Jane Doe"


def test_normalizeAuthors_none():
    assert normalizeAuthors(None) is None
    assert normalizeAuthors("") is None
    assert normalizeAuthors("   ") is None


def test_normalizeAuthors_single():
    assert normalizeAuthors("John Smith") == "John Smith"


def test_normalizeAuthors_removes_dblp_disambiguation_suffixes():
    assert normalizeAuthors(
        "Sanghyun Son 0003; Matheus Gadelha; Yang Zhou 0009; Yi Zhou 0023"
    ) == "Sanghyun Son; Matheus Gadelha; Yang Zhou; Yi Zhou"


def test_normalizeAuthors_repairs_dblp_disambiguation_prefixes():
    assert normalizeAuthors(
        "0003, Sanghyun Son; 0009, Yang Zhou; 0023, Yi Zhou"
    ) == "Sanghyun Son; Yang Zhou; Yi Zhou"


def test_extractTitleCandidate_uses_largest_non_noise_lines():
    assert extractTitleCandidate(
        [
            {"text": "Journal homepage", "y": 780, "size": 18},
            {"text": "A Reliable Paper", "y": 720, "size": 24},
            {"text": "Title", "y": 695, "size": 23},
            {"text": "Abstract", "y": 650, "size": 14},
        ]
    ) == "A Reliable Paper Title"


def test_extractMetadataFromPdf_blank_pdf(tmp_path):
    from pypdf import PdfWriter

    pdf_path = str(tmp_path / "blank.pdf")
    writer = PdfWriter()
    writer.add_blank_page(width=200, height=200)
    with open(pdf_path, "wb") as f:
        writer.write(f)

    result = extractMetadataFromPdf(pdf_path)
    assert "info" in result
    assert "text" in result
    assert "titleCandidate" in result
    assert "error" not in result or result.get("error") is None
    assert isinstance(result["info"], dict)
    assert isinstance(result["text"], str)


def test_extractMetadataFromPdf_missing_file(tmp_path):
    result = extractMetadataFromPdf(str(tmp_path / "nope.pdf"))
    assert "error" in result
    assert result["error"]["type"] in ("corrupted", "other")


def test_extractMetadataFromPdf_respects_max_pages(tmp_path):
    from pypdf import PdfWriter

    pdf_path = str(tmp_path / "multi.pdf")
    writer = PdfWriter()
    for _ in range(5):
        writer.add_blank_page(width=200, height=200)
    with open(pdf_path, "wb") as f:
        writer.write(f)

    result = extractMetadataFromPdf(pdf_path, maxPages=2)
    assert "error" not in result or result.get("error") is None
