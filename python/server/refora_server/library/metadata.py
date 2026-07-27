from __future__ import annotations

import re
import unicodedata
from math import hypot
from typing import Any, Optional

from refora_server.academic.arxiv import base_arxiv_id, normalize_arxiv_id
from refora_server.library.authors import normalizeAuthors

REFERENCE_HEADINGS = re.compile(
    r"references|bibliography|参考文献|参考资料|references\s*$", re.IGNORECASE
)
DOI_REGEX = re.compile(r"10\.\d{4,9}/[-._;()/:a-zA-Z0-9+]+")
ARXIV_ID_REGEX = re.compile(
    r"(?:arxiv\s*:?\s*|arxiv\.org/(?:abs|pdf)/)"
    r"((?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[a-z]{2})?/\d{7})(?:v\d+)?)",
    re.IGNORECASE,
)

TEMPLATE_NOISE_TITLE = re.compile(
    r"\b(formatting instructions|instructions for authors|template|sample manuscript|"
    r"sample paper|untitled|main\.tex|preliminary version|do not cite|"
    r"work in progress|draft version|preprint version|accepted for publication|"
    r"to appear in)\b",
    re.IGNORECASE,
)

ABSTRACT_KEYWORD = re.compile(r"^(?:abstract)\b\.?:?\s*-?\s*", re.IGNORECASE)
ABSTRACT_KEYWORD_SPACED = re.compile(
    r"^a\s*b\s*s\s*t\s*r\s*a\s*c\s*t\b\.?:?\s*-?\s*", re.IGNORECASE
)
ABSTRACT_KEYWORD_CN = re.compile(r"^摘\s*要[\s:：]*")
ABSTRACT_END_MARKERS = re.compile(
    r"^(?:keywords?|index terms|\d+\.?\s*(?:introduction|related work|background|"
    r"method|methodology|preliminar|related\s+work)|ccs\s+concepts?|"
    r"categories\s+and\s+subject|acm\s+(?:reference|computing\s+classification)|"
    r"1\s+introduction|1\.\s+introduction|i\.?\s+introduction|introduction\s*$|"
    r"acknowledg|references|bibliography)\b",
    re.IGNORECASE,
)
ABSTRACT_NOISE_LINE = re.compile(
    r"^(?:fig(?:ure|\.)?\s*\d|table\s*\d|algorithm\s*\d|theorem\s*\d|lemma\s*\d|"
    r"equation\s*\d|eq\.?\s*\d|section\s*\d|sec\.?\s*\d|corollary|proposition|"
    r"definition|proof|©|copyright|published\s+as|received\s+\d|accepted\s+\d|"
    r"revised\s+\d|available\s+online|article history|article info|"
    r"a\s*r\s*t\s*i\s*c\s*l\s*e\s+i\s*n\s*f\s*o)\b",
    re.IGNORECASE,
)

AFFILIATION_SYMBOL_PATTERN = re.compile(r"^[†‡§¶∗⋆○●▲△▼▽☆★◇◆■□♣♦♥♠∘]")
AFFILIATION_INLINE_SYMBOL_MARKER = re.compile(r"[†‡§¶∗⋆]")
AFFILIATION_DEPT_KEYWORDS = re.compile(
    r"\b(department|dept|school of|institute|laboratory|lab|college|university|"
    r"center|centre|centre for|faculty of|academy|hospital|corporation|inc|"
    r"company|gmbh|division of|research group|labs?|technology|università)\b",
    re.IGNORECASE,
)
AFFILIATION_ORG_KEYWORDS = re.compile(
    r"\b(research institutes|technologies|sciences|science|engineering|physics|"
    r"electronics|automotive|energy)\b",
    re.IGNORECASE,
)
AFFILIATION_COMPANY_NAMES = re.compile(
    r"^(?:NVIDIA|Google(?: Brain)?|Meta|Microsoft|Adobe|Apple|Amazon|ByteDance|OpenAI|"
    r"DeepMind|Anthropic|Abacus\.AI)$",
    re.IGNORECASE,
)
AFFILIATION_ACADEMIC_ACRONYMS = re.compile(
    r"^(?:ETH Zurich|EPFL|MIT|Caltech)(?:\s*,.*)?$",
    re.IGNORECASE,
)
AFFILIATION_NUMBER_MARKER = re.compile(
    r"(?<!\d)\d{1,2}(?:\s*,\s*\d{1,2})*[.)]?\s*(?=[A-Z])"
)
AUTHOR_MARKERS = re.compile(
    r"(?<=[^\W\d_])(?:\d+(?:\s*,\s*\d+)*)?[*†‡§¶∗]+|"
    r"(?<=[^\W\d_])\d+(?:\s*,\s*\d+)*"
)
SUPERSCRIPT_MARKER = re.compile(
    r"^(?:[†‡§¶∗○●▲△▼▽☆★◇◆■□♣♦♥♠∘]|[a-z](?:,[a-z])*|\d+(?:,\d+)*|\*|•)\.?\s*$"
)

CONFERENCE_VENUE_MAP: dict[str, str] = {
    "ICLR": "ICLR",
    "ICML": "ICML",
    "NeurIPS": "NeurIPS",
    "NIPS": "NeurIPS",
    "ICCV": "ICCV",
    "CVPR": "CVPR",
    "ECCV": "ECCV",
    "AAAI": "AAAI",
    "ICASSP": "ICASSP",
    "SIGGRAPH": "SIGGRAPH",
    "ACL": "ACL",
    "EMNLP": "EMNLP",
    "NAACL": "NAACL",
    "COLING": "COLING",
    "KDD": "KDD",
    "WWW": "WWW",
    "SIGMOD": "SIGMOD",
    "VLDB": "VLDB",
    "ICDE": "ICDE",
    "SOSP": "SOSP",
    "OSDI": "OSDI",
    "NSDI": "NSDI",
    "EuroSys": "EuroSys",
    "ATC": "USENIX ATC",
    "CCS": "CCS",
    "SAndP": "S&P",
    "NDSS": "NDSS",
    "RSS": "RSS",
    "ICRA": "ICRA",
    "IROS": "IROS",
    "WACV": "WACV",
    "BMVC": "BMVC",
    "ACML": "ACML",
}

CONFERENCE_BANNER = re.compile(
    r"published as (?:a |an )?conference paper at\s+([A-Za-z][A-Za-z.&\s]*?)\s+(\d{4})",
    re.IGNORECASE,
)
UNDER_REVIEW_BANNER = re.compile(
    r"under review as (?:a |an )?conference paper at\s+([A-Za-z][A-Za-z.&\s]*?)\s+(\d{4})",
    re.IGNORECASE,
)
UNDER_REVIEW_BANNER_NO_YEAR = re.compile(r"under review (?:as|for)\b", re.IGNORECASE)

TITLE_NOISE_PATTERNS = re.compile(
    r"^(\s*(published as a|formatting instructions|instructions for authors)\b|"
    r"\d{4}\s*(©|\(c\))\b|copyright\b|vol\.?\s*\d|article\b|contents lists available\b|"
    r"journal homepage\b|science\s?direct\b|elsevier\b|springer\b|ieee\b|acm\b|"
    r"arxiv:\s*\d|preliminary version|do not cite|work in progress|draft version|"
    r"preprint version|under review)\b",
    re.IGNORECASE,
)
JOURNAL_RUNNING_HEADER = re.compile(r"\b\w+\s+\d+\s*\(\d{4}\)\s*\d+\s*$", re.IGNORECASE)
TITLE_NOISE_ANYWHERE = re.compile(
    r"\b(formatting instructions|instructions for authors|"
    r"published as a conference paper|preliminary version|do not cite|"
    r"work in progress|draft version|preprint version)\b",
    re.IGNORECASE,
)

TITLE_CONTINUATION_END = re.compile(
    r"\b(for|and|the|of|with|using|via|in|on|to|a|an|from|by|as|over|into|"
    r"towards|toward|based|via|through|across|against|with)\s*$",
    re.IGNORECASE,
)
ENDS_SENTENCE = re.compile(r"[.!?]$")

JOURNAL_HEADER_CONTEXT = re.compile(
    r"^(contents lists available|journal homepage|www\.)\b", re.IGNORECASE
)

POSTER_KEYWORDS = re.compile(
    r"\b(poster|slide[s]?|presentation|keynote|tutorial|syllabus|preface|foreword|"
    r"table of contents|index|appendix|chapter)\b",
    re.IGNORECASE,
)
NOISE_TITLE_PATTERNS = re.compile(
    r"^(figure|fig\.?|table|tab\.?|algorithm|theorem|lemma|proof|equation|eq\.?|"
    r"section|sec\.?)\s*\d+",
    re.IGNORECASE,
)

TRAILING_PUNCT = re.compile(r"[.,;)\]]+$")
PDF_TITLE_NOISE = re.compile(
    r"^(published as a|formatting instructions|instructions for authors|"
    r"this (is an? )?(open access|article)|\d{4}\s*(©|\(c\))|copyright\b|"
    r"vol\.?\b|article\b|contents\b|journal homepage\b|preliminary version|"
    r"do not cite|work in progress|draft version|preprint version|under review)\b",
    re.IGNORECASE,
)
PDF_ARXIV_HEADER = re.compile(r"^arxiv:\s*\d", re.IGNORECASE)
PDF_CITED_BY_HEADER = re.compile(r"^cited by\b", re.IGNORECASE)
PDF_JOURNAL_HEADER_NOISE = re.compile(
    r"^(contents lists available|journal homepage|www\.|http|sciencedirect|"
    r"elsevier|springer)\b",
    re.IGNORECASE,
)


def _nonEmptyString(value: Any) -> Optional[str]:
    if isinstance(value, str) and value.strip():
        return value.strip()
    return None


def isTemplateNoiseTitle(title: str) -> bool:
    return TEMPLATE_NOISE_TITLE.search(title) is not None


def extractDoiFromText(text: str) -> Optional[str]:
    lines = text.split("\n")
    inReferences = False
    firstMatch: Optional[str] = None

    for line in lines:
        if REFERENCE_HEADINGS.search(line.strip()):
            inReferences = True
            continue
        if inReferences:
            continue

        cleanLine = re.sub(r"https?://(?:dx\.)?doi\.org/", "", line, flags=re.IGNORECASE)
        cleanLine = re.sub(r"^doi\s*:?\s*", "", cleanLine, flags=re.IGNORECASE)
        match = DOI_REGEX.search(cleanLine)
        if match and firstMatch is None:
            firstMatch = TRAILING_PUNCT.sub("", match.group(0))

    return firstMatch


def extractDoiFromInfo(info: dict[str, Any]) -> Optional[str]:
    raw = info.get("doi", info.get("DOI", info.get("Doi", None)))
    if not isinstance(raw, str) or len(raw) == 0:
        return None
    return raw.strip()


def extractArxivFromText(text: str) -> Optional[str]:
    match = ARXIV_ID_REGEX.search(text)
    if not match:
        return None
    return normalize_arxiv_id(match.group(1))


def extractArxivFromFileName(fileName: str) -> Optional[str]:
    match = re.fullmatch(
        r"(?:arxiv[-_ ]?)?(\d{4}\.\d{4,5}(?:v\d+)?)\.pdf",
        fileName.strip(),
        re.IGNORECASE,
    )
    if not match:
        return None
    return normalize_arxiv_id(match.group(1))


def deriveDoiFromArxivId(arxivId: str) -> str:
    normalizedId = normalize_arxiv_id(arxivId) or arxivId
    bareId = base_arxiv_id(normalizedId)
    return f"10.48550/arXiv.{bareId}"


def _extractAbstractByStructure(lines: list[str]) -> Optional[str]:
    if len(lines) < 6:
        return None

    affiliationRegex = re.compile(
        r"\b(universit[yéeè]|institute|college|laborator[y]|research|corporation|"
        r"inc\.?|gmbh|department|school of|faculty of|center|centre|facebook|google|"
        r"microsoft|nvidia|apple|amazon|bytedance|openai|deepmind|anthropic)\b",
        re.IGNORECASE,
    )
    authorLikeLine = re.compile(
        r"^[A-Z][a-zA-Z'`''-]+(?:\s+[A-Z][a-zA-Z'`''-]+)*"
        r"(?:,?\s+(?:and|&)\s+[A-Z][a-zA-Z'`''-]+)*$"
    )
    nameWithAffiliation = re.compile(r"^[A-Z][a-zA-Z'`''-]+.*,\s+")

    firstParagraphStart = -1
    seenAuthorish = False

    for i in range(1, min(len(lines), 80)):
        line = lines[i]
        if len(line) == 0:
            continue
        if ABSTRACT_END_MARKERS.search(line):
            break
        if ABSTRACT_NOISE_LINE.search(line):
            continue

        if (
            affiliationRegex.search(line)
            or re.search(r"^[\w.-]+@[\w.-]+\.\w+", line)
            or re.search(r"^(?:Member|Senior Member|Fellow|Student Member),?\s+IEEE", line, re.IGNORECASE)
        ):
            seenAuthorish = True
            continue
        if re.match(r"^\d+$", line) or re.match(
            r"^[†‡§¶∗○●▲△▼▽☆★◇◆■□♣♦♥♠∘]\.?\s*$", line
        ):
            continue
        if authorLikeLine.match(line) and len(line) < 60:
            seenAuthorish = True
            continue
        if nameWithAffiliation.match(line) and len(line) < 80 and not line.endswith("."):
            seenAuthorish = True
            continue
        if len(line) < 3:
            continue

        if (
            seenAuthorish
            and len(line) > 40
            and line[0].isupper()
            and not line.endswith(":")
        ):
            if re.search(r"\bFig\.?\s*\d", line):
                continue
            if re.search(r"[+]", line) and re.search(r"\d", line):
                continue
            words = line.split()
            capWords = [w for w in words if w and w[0].isupper()]
            if len(words) > 3 and len(capWords) / len(words) > 0.6:
                continue
            firstParagraphStart = i
            break

    if firstParagraphStart == -1:
        return None

    paragraph: list[str] = []
    for j in range(firstParagraphStart, min(len(lines), firstParagraphStart + 30)):
        pLine = lines[j]
        if ABSTRACT_END_MARKERS.search(pLine):
            break
        if re.match(r"^(?:[1-9]\.?\s|1\s+Introduction|I\.?\s+Introduction)\b", pLine, re.IGNORECASE):
            break
        if len(pLine) == 0:
            if paragraph:
                break
            continue
        if ABSTRACT_NOISE_LINE.search(pLine) and not paragraph:
            continue
        paragraph.append(pLine)

    if len(paragraph) >= 2:
        result = re.sub(r"\s+", " ", " ".join(paragraph)).strip()
        if len(result) > 60 and result[0].isupper():
            if re.search(r"\bFig\.?\s*\d", result):
                return None
            sentences = re.split(r"[.!?]\s+", result)
            if len(sentences) >= 2:
                return result[:2000]
            if len(result) > 150:
                return result[:2000]

    return None


def extractAbstractFromText(text: str) -> Optional[str]:
    rawLines = text.split("\n")
    lines = [l.strip() for l in rawLines]
    textLen = len(lines)

    for idx in range(min(textLen, 80)):
        line = lines[idx]
        if len(line) == 0:
            continue

        rest: Optional[str] = None
        m1 = ABSTRACT_KEYWORD.match(line)
        m2 = None if m1 else ABSTRACT_KEYWORD_SPACED.match(line)
        m3 = None if (m1 or m2) else ABSTRACT_KEYWORD_CN.match(line)

        if m1:
            rest = line[m1.end():]
        elif m2:
            rest = line[m2.end():]
        elif m3:
            rest = line[m3.end():]

        if rest is None:
            continue

        abstractLines: list[str] = [rest] if len(rest) > 0 else []
        for i in range(idx + 1, min(textLen, idx + 50)):
            l = lines[i]
            if ABSTRACT_END_MARKERS.search(l):
                break
            if ABSTRACT_NOISE_LINE.search(l):
                break
            if len(l) == 0:
                if abstractLines:
                    break
                continue
            abstractLines.append(l)
        result = re.sub(r"\s+", " ", " ".join(abstractLines)).strip()
        if len(result) > 15:
            return result[:2000]

    return _extractAbstractByStructure(lines)


def _isLikelyAffiliation(line: str) -> bool:
    if len(line) < 5 or len(line) > 300:
        return False
    if "@" in line:
        return False
    if AFFILIATION_COMPANY_NAMES.fullmatch(line):
        return True
    if AFFILIATION_ACADEMIC_ACRONYMS.fullmatch(line):
        return True
    if AFFILIATION_DEPT_KEYWORDS.search(line):
        return True
    if AFFILIATION_ORG_KEYWORDS.search(line) and re.search(
        r"\b(University|Institute|College|Laboratory|Research|Corp|Inc|Ltd|GmbH|"
        r"Company|Foundation)\b",
        line,
        re.IGNORECASE,
    ):
        return True
    if re.search(r"\b[A-Z][a-zA-Z]+\s+Research\b", line) and len(line) < 80:
        return True
    if re.match(
        r"^[A-Z][a-zA-Z\s,&.'-]+(University|Institute|College|Laboratory|"
        r"Corporation|Inc\.?|Ltd\.?|GmbH)\b",
        line,
    ):
        return True
    return False


def _repairPdfDiacritics(value: str) -> str:
    marks = {"¨": "\u0308", "˚": "\u030a", "˘": "\u0306"}
    repaired = value
    for mark, combining in marks.items():
        repaired = re.sub(
            rf"\s*{re.escape(mark)}\s*([A-Za-z])",
            lambda match: unicodedata.normalize("NFC", match.group(1) + combining),
            repaired,
        )
    return repaired


def _splitNumberedAffiliationLine(line: str) -> Optional[list[str]]:
    matches = list(AFFILIATION_NUMBER_MARKER.finditer(line))
    if not matches or (matches[0].start() != 0 and len(matches) == 1):
        return None

    parts = [
        line[match.end():matches[index + 1].start() if index + 1 < len(matches) else len(line)]
        .strip(" ,;")
        for index, match in enumerate(matches)
    ]
    return [part for part in parts if part]


def _splitSymbolAffiliationLine(line: str) -> Optional[list[str]]:
    matches = list(AFFILIATION_INLINE_SYMBOL_MARKER.finditer(line))
    if not matches:
        return None
    parts: list[str] = []
    cursor = 0
    for match in matches:
        if match.start() > cursor:
            parts.append(line[cursor:match.start()].strip(" ,;"))
        cursor = match.end()
    if cursor < len(line):
        parts.append(line[cursor:].strip(" ,;"))
    return [part for part in parts if part]


def extractAffiliationsFromText(text: str) -> Optional[str]:
    hasAbstract = re.search(r"\babstract\b", text[:3000], re.IGNORECASE) is not None
    hasPhysicsFrontMatter = (
        re.search(r"^\(Dated:\s+", text[:3000], re.IGNORECASE | re.MULTILINE)
        is not None
        and re.search(r"^\s*(?:I\.|1\.?)\s+INTRODUCTION\b", text[:5000], re.IGNORECASE | re.MULTILINE)
        is not None
    )
    if not hasAbstract and not hasPhysicsFrontMatter:
        return None

    lines = [l.strip() for l in text.split("\n") if l.strip()]
    head = lines[:50]
    affiliations: list[str] = []
    seen: set[str] = set()

    def tryAdd(value: str) -> None:
        trimmed = _repairPdfDiacritics(value).strip()
        if len(trimmed) < 5:
            return
        key = trimmed.lower()
        if key in seen:
            return
        seen.add(key)
        affiliations.append(trimmed)

    def addLikelyAffiliations(value: str) -> bool:
        candidates = (
            _splitNumberedAffiliationLine(value)
            or _splitSymbolAffiliationLine(value)
            or [value]
        )
        added = False
        for candidate in candidates:
            if _isLikelyAffiliation(candidate):
                tryAdd(candidate)
                added = True
        return added

    inAffiliationBlock = False
    blockEnded = False
    expectAffiliationAfterMarker = False

    i = 0
    while i < len(head):
        line = head[i]

        if blockEnded:
            break

        if re.match(r"^(abstract|keywords|introduction)\b", line, re.IGNORECASE):
            break
        if re.match(r"^\(Dated:\s+", line, re.IGNORECASE):
            break

        if re.match(r"^affiliations?\b", line, re.IGNORECASE) or re.match(
            r"^\*?\s*author affiliations?\b", line, re.IGNORECASE
        ):
            rest = re.sub(r"^.*?affiliations?\s*:?\s*", "", line, flags=re.IGNORECASE).strip()
            if len(rest) > 0:
                for part in rest.split(";"):
                    part = part.strip()
                    if part:
                        addLikelyAffiliations(part)
                inAffiliationBlock = True
            i += 1
            continue

        if inAffiliationBlock:
            if len(line) < 5:
                blockEnded = True
                i += 1
                continue
            if addLikelyAffiliations(line):
                i += 1
                continue
            blockEnded = True
            i += 1
            continue

        if SUPERSCRIPT_MARKER.match(line):
            if i + 1 < len(head):
                nxt = head[i + 1]
                if addLikelyAffiliations(nxt):
                    expectAffiliationAfterMarker = True
                    i += 2
                    continue

        if expectAffiliationAfterMarker and addLikelyAffiliations(line):
            i += 1
            continue

        if AFFILIATION_SYMBOL_PATTERN.match(line):
            cleaned = AFFILIATION_SYMBOL_PATTERN.sub("", line)
            cleaned = re.sub(r"^[a-z\d]+,?\s*", "", cleaned)
            cleaned = re.sub(r"^\d+\.?\s*", "", cleaned).strip()
            if len(cleaned) > 5 and addLikelyAffiliations(cleaned):
                i += 1
                continue

        if not inAffiliationBlock:
            addLikelyAffiliations(line)

        i += 1

    if not affiliations:
        return None
    return "; ".join(affiliations)


def _isLikelyAuthorName(value: str) -> bool:
    words = [word for word in value.split() if word]
    if len(words) < 2 or len(words) > 6:
        return False
    if any(
        not all(
            character.isalpha() or character in ".'’`-"
            for character in word
        )
        for word in words
    ):
        return False
    return True


def extractAuthorsFromText(
    text: str,
    titleHint: Optional[str] = None,
) -> Optional[str]:
    if re.search(r"\babstract\b", text[:3000], re.IGNORECASE) is None:
        return None
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    title = titleHint or extractTitleFromText(text)
    if not title:
        return None

    title_end = -1
    for start in range(min(len(lines), 10)):
        for end in range(start, min(len(lines), start + 4)):
            combined = re.sub(r"\s+", " ", " ".join(lines[start:end + 1])).strip()
            if combined == title:
                title_end = end
                break
        if title_end >= 0:
            break
    if title_end < 0:
        return None

    authors: list[str] = []
    for line in lines[title_end + 1:title_end + 4]:
        if re.match(r"^abstract\b", line, re.IGNORECASE) or "@" in line:
            break
        affiliation_parts = _splitNumberedAffiliationLine(line) or [line]
        if any(_isLikelyAffiliation(part) for part in affiliation_parts):
            break
        cleaned = _repairPdfDiacritics(AUTHOR_MARKERS.sub("", line))
        names = [
            name.strip(" ,;")
            for name in re.split(r"\s*(?:,|;|\band\b|&)\s*", cleaned, flags=re.IGNORECASE)
        ]
        valid = [name for name in names if _isLikelyAuthorName(name)]
        if not valid:
            if authors:
                break
            continue
        authors.extend(valid)

    if not authors:
        return None
    return normalizeAuthors("; ".join(dict.fromkeys(authors)))


def _normalizeVenueKey(rawVenue: str) -> Optional[str]:
    for k in CONFERENCE_VENUE_MAP:
        if rawVenue.lower() == k.lower():
            return CONFERENCE_VENUE_MAP[k]
    return None


def extractVenueFromText(text: str) -> Optional[dict[str, str]]:
    head = text[:600]

    m = CONFERENCE_BANNER.search(head)
    if m:
        rawVenue = m.group(1).strip()
        venue = _normalizeVenueKey(rawVenue) or rawVenue
        return {"venue": venue, "year": m.group(2)}

    reviewMatch = UNDER_REVIEW_BANNER.search(head)
    if reviewMatch:
        rawVenue = reviewMatch.group(1).strip()
        venue = _normalizeVenueKey(rawVenue) or rawVenue
        return {"venue": venue, "year": reviewMatch.group(2)}

    if UNDER_REVIEW_BANNER_NO_YEAR.search(head):
        return None

    ieeeMatch = re.search(
        r"IEEE\s+(Transactions\s+on\s+[A-Z][A-Za-z\s]+?)[\s.,]\s*(?:\d|VOL|vol|$)",
        head,
        re.IGNORECASE,
    )
    if ieeeMatch:
        venue = "IEEE " + ieeeMatch.group(1).strip()
        return {"venue": venue, "year": ""}

    return None


def _isTitleNoiseLine(line: str) -> bool:
    lower = line.lower()
    if lower == "arxiv" or lower.startswith("arxiv:"):
        return True
    if lower == "abstract" or lower.startswith("abstract"):
        return True
    if lower.startswith("http") or lower.startswith("www."):
        return True
    if lower.startswith("doi") or DOI_REGEX.search(line):
        return True
    if "@" in line and "." in line:
        return True
    if TITLE_NOISE_PATTERNS.search(line):
        return True
    if TITLE_NOISE_ANYWHERE.search(line):
        return True
    if JOURNAL_RUNNING_HEADER.search(line):
        return True
    return False


def _isLikelyTitleLine(line: str) -> bool:
    if len(line) < 8:
        return False
    if _isTitleNoiseLine(line):
        return False
    return True


def _looksLikeContinuation(prev: str, nxt: str) -> bool:
    if ENDS_SENTENCE.search(prev):
        return False
    if TITLE_CONTINUATION_END.search(prev):
        return True
    if re.search(r"[:(\--]$", prev):
        return True
    if (
        nxt
        and nxt[0].islower()
        and len(nxt) < 80
        and not re.match(r"^(this|we|our|the|in|abstract)\b", nxt, re.IGNORECASE)
    ):
        return True
    return False


def _inJournalHeaderCluster(head: list[str], i: int) -> bool:
    for k in range(i + 1, min(len(head), i + 4)):
        if JOURNAL_HEADER_CONTEXT.search(head[k]):
            return True
    return False


def extractTitleFromText(text: str) -> Optional[str]:
    lines = [l.strip() for l in text.split("\n") if l.strip()]
    head = lines[:12]
    for i in range(len(head)):
        line = head[i]
        if not _isLikelyTitleLine(line):
            continue
        if _inJournalHeaderCluster(head, i):
            continue
        titleLines = [line]
        for j in range(i + 1, len(head)):
            if len(titleLines) >= 4:
                break
            nxt = head[j]
            if not _isLikelyTitleLine(nxt):
                break
            last = titleLines[-1]
            if not _looksLikeContinuation(last, nxt):
                break
            titleLines.append(nxt)
        return re.sub(r"\s+", " ", " ".join(titleLines)).strip()
    return None


def looksLikePosterOrNonPaper(text: str) -> bool:
    head = text[:600].lower()
    if POSTER_KEYWORDS.search(head):
        return True
    lines = [l.strip() for l in text.split("\n") if l.strip()]
    if len(lines) < 12:
        return False
    headLines = lines[:40]
    shortLines = [l for l in headLines if 0 < len(l) < 40]
    if len(shortLines) / len(headLines) > 0.8 and not re.search(r"abstract", head, re.IGNORECASE):
        return True
    return False


def isReliableTitle(title: Optional[str], text: str) -> bool:
    if not title or not title.strip():
        return False
    trimmed = title.strip()
    if len(trimmed) < 8:
        return False
    if len(trimmed) > 300:
        return False
    if NOISE_TITLE_PATTERNS.search(trimmed):
        return False
    if looksLikePosterOrNonPaper(text):
        return False
    words = [w for w in trimmed.split() if w]
    if len(words) < 2:
        return False
    alphaChars = [c for c in trimmed if c.isalpha()]
    if len(alphaChars) / len(trimmed) < 0.5:
        return False
    if DOI_REGEX.search(trimmed):
        return False
    return True


def titleFromFileName(fileName: str) -> Optional[str]:
    base = re.sub(r"\.pdf$", "", fileName, flags=re.IGNORECASE).strip()
    if len(base) == 0:
        return None
    base = re.sub(r"[_]+", " ", base)
    base = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", base)
    base = re.sub(r"(\d{4})([A-Za-z])", r"\1 \2", base)
    base = re.sub(r"([A-Za-z])(\d{4})", r"\1 \2", base)
    base = re.sub(r"\s+", " ", base).strip()
    if len(base) == 0:
        return None
    words = [w for w in base.split(" ") if w]
    if not words:
        return None
    if re.match(r"^\d+$", words[0]) and len(words) > 1:
        words.pop(0)
    result = " ".join(words)
    if len(result) == 0:
        return None
    return result[0].upper() + result[1:]


def _isPdfTitleNoise(text: str) -> bool:
    return bool(
        PDF_TITLE_NOISE.search(text)
        or TITLE_NOISE_ANYWHERE.search(text)
        or PDF_ARXIV_HEADER.search(text)
        or PDF_CITED_BY_HEADER.search(text)
        or PDF_JOURNAL_HEADER_NOISE.search(text)
        or re.search(
            r"\b(abstract|introduction|acknowledg|references|bibliography)\b",
            text,
            re.IGNORECASE,
        )
    )


def extractTitleCandidate(lines: list[dict[str, float | str]]) -> Optional[str]:
    candidates = [
        line
        for line in lines
        if isinstance(line.get("text"), str)
        and str(line["text"]).strip()
        and isinstance(line.get("size"), (int, float))
        and float(line["size"]) > 0
    ]
    valid = [line for line in candidates if not _isPdfTitleNoise(str(line["text"]))]
    if not valid:
        return None
    max_size = max(float(line["size"]) for line in valid)
    threshold = max(max_size * 0.85, 11)
    group = sorted(
        [line for line in valid if float(line["size"]) >= threshold],
        key=lambda line: float(line.get("y", 0)),
        reverse=True,
    )
    if len(group) > 1:
        filtered = []
        for line in group:
            y = float(line.get("y", 0))
            above = any(
                y + 1 < float(candidate.get("y", 0)) < y + 32
                and PDF_JOURNAL_HEADER_NOISE.search(str(candidate["text"]))
                for candidate in candidates
            )
            below = any(
                y - 32 < float(candidate.get("y", 0)) < y - 1
                and PDF_JOURNAL_HEADER_NOISE.search(str(candidate["text"]))
                for candidate in candidates
            )
            if not (above and below):
                filtered.append(line)
        if filtered:
            group = filtered
    if not group:
        return None
    chosen = [group[0]]
    start_y = float(group[0].get("y", 0))
    for line in [item for item in group if float(item.get("y", 0)) < start_y - 1]:
        gap = abs(start_y - float(line.get("y", 0)))
        next_gap = abs(
            float(chosen[-1].get("y", 0)) - float(line.get("y", 0))
        )
        if gap > 40 or next_gap > 40:
            break
        chosen.append(line)
    chosen.sort(key=lambda line: float(line.get("y", 0)), reverse=True)
    title = re.sub(
        r"\s+",
        " ",
        " ".join(str(line["text"]) for line in chosen),
    ).strip()
    return title if len(title) >= 8 else None


def _pdfLinesFromFragments(
    fragments: list[dict[str, float | str]],
) -> list[dict[str, float | str]]:
    lines: list[dict[str, float | str]] = []
    for fragment in fragments:
        text = re.sub(r"\s+", " ", str(fragment["text"])).strip()
        if not text:
            continue
        y = float(fragment.get("y", 0))
        size = float(fragment.get("size", 0))
        if lines and abs(float(lines[-1]["y"]) - y) <= 2:
            lines[-1]["text"] = f"{lines[-1]['text']}{text}"
            lines[-1]["size"] = max(float(lines[-1]["size"]), size)
        else:
            lines.append({"text": text, "y": y, "size": size})
    return lines


def extractMetadataFromPdf(filePath: str, maxPages: int = 5) -> dict[str, Any]:
    try:
        from pypdf import PdfReader
    except ImportError:
        return {"error": {"type": "other", "message": "pypdf is not available"}, "info": {}, "text": "", "titleCandidate": None}

    try:
        reader = PdfReader(filePath)
    except Exception as e:
        name = type(e).__name__
        message = str(e) or name
        lower = message.lower()
        if "password" in lower or name == "PasswordError":
            return {"error": {"type": "encrypted", "message": message}, "info": {}, "text": "", "titleCandidate": None}
        if name in ("PdfReadError", "PyPdfError") or "invalid" in lower:
            return {"error": {"type": "corrupted", "message": message}, "info": {}, "text": "", "titleCandidate": None}
        return {"error": {"type": "other", "message": message}, "info": {}, "text": "", "titleCandidate": None}

    info: dict[str, Any] = {}
    try:
        meta = reader.metadata
        if meta is not None:
            info = {k: v for k, v in meta.items()}
    except Exception:
        info = {}

    total = len(reader.pages)
    pageCount = total if maxPages == 0 else min(maxPages, total)
    textParts: list[str] = []
    titleCandidate: Optional[str] = None

    for i in range(pageCount):
        try:
            if i == 0:
                fragments: list[dict[str, float | str]] = []

                def visitor(
                    text: str,
                    cm: list[float],
                    tm: list[float],
                    _font: dict[str, Any] | None,
                    font_size: float,
                ) -> None:
                    y = tm[5] if len(tm) > 5 else 0
                    size = font_size
                    if len(cm) > 5 and len(tm) > 5:
                        y = tm[4] * cm[1] + tm[5] * cm[3] + cm[5]
                        size = font_size * hypot(cm[2], cm[3])
                    for value in text.splitlines():
                        if value.strip():
                            fragments.append(
                                {
                                    "text": value,
                                    "y": y,
                                    "size": size,
                                }
                            )

                pageText = reader.pages[i].extract_text(visitor_text=visitor) or ""
                titleCandidate = extractTitleCandidate(
                    _pdfLinesFromFragments(fragments)
                )
            else:
                pageText = reader.pages[i].extract_text() or ""
            textParts.append(pageText)
        except Exception:
            textParts.append("")

    text = "\n".join(textParts)
    return {"info": info, "text": text, "titleCandidate": titleCandidate}
