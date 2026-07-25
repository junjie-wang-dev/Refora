from __future__ import annotations

import re
from typing import Any, Optional

from refora_server.academic.arxiv import base_arxiv_id, normalize_arxiv_id

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

AFFILIATION_SYMBOL_PATTERN = re.compile(r"^[†‡§¶∗○●▲△▼▽☆★◇◆■□♣♦♥♠∘]")
AFFILIATION_DEPT_KEYWORDS = re.compile(
    r"\b(department|dept|school of|institute|laboratory|lab|college|university|"
    r"center|centre|centre for|faculty of|academy|hospital|corporation|inc|"
    r"company|gmbh|division of|research group)\b",
    re.IGNORECASE,
)
AFFILIATION_ORG_KEYWORDS = re.compile(
    r"\b(research institutes|technologies|sciences|science|engineering|physics|"
    r"electronics|automotive|energy)\b",
    re.IGNORECASE,
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


def extractAffiliationsFromText(text: str) -> Optional[str]:
    hasAbstract = re.search(r"\babstract\b", text[:3000], re.IGNORECASE) is not None
    if not hasAbstract:
        return None

    lines = [l.strip() for l in text.split("\n") if l.strip()]
    head = lines[:50]
    affiliations: list[str] = []
    seen: set[str] = set()

    def tryAdd(value: str) -> None:
        trimmed = value.strip()
        if len(trimmed) < 5:
            return
        key = trimmed.lower()
        if key in seen:
            return
        seen.add(key)
        affiliations.append(trimmed)

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

        if re.match(r"^affiliations?\b", line, re.IGNORECASE) or re.match(
            r"^\*?\s*author affiliations?\b", line, re.IGNORECASE
        ):
            rest = re.sub(r"^.*?affiliations?\s*:?\s*", "", line, flags=re.IGNORECASE).strip()
            if len(rest) > 0:
                for part in rest.split(";"):
                    part = part.strip()
                    if part and _isLikelyAffiliation(part):
                        tryAdd(part)
                inAffiliationBlock = True
            i += 1
            continue

        if inAffiliationBlock:
            if len(line) < 5:
                blockEnded = True
                i += 1
                continue
            if _isLikelyAffiliation(line):
                tryAdd(line)
                i += 1
                continue
            blockEnded = True
            i += 1
            continue

        if SUPERSCRIPT_MARKER.match(line):
            if i + 1 < len(head):
                nxt = head[i + 1]
                if _isLikelyAffiliation(nxt):
                    tryAdd(nxt)
                    expectAffiliationAfterMarker = True
                    i += 2
                    continue

        if expectAffiliationAfterMarker and _isLikelyAffiliation(line):
            tryAdd(line)
            i += 1
            continue

        if AFFILIATION_SYMBOL_PATTERN.match(line):
            cleaned = AFFILIATION_SYMBOL_PATTERN.sub("", line)
            cleaned = re.sub(r"^[a-z\d]+,?\s*", "", cleaned)
            cleaned = re.sub(r"^\d+\.?\s*", "", cleaned).strip()
            if len(cleaned) > 5 and _isLikelyAffiliation(cleaned):
                tryAdd(cleaned)
                i += 1
                continue

        if not inAffiliationBlock and _isLikelyAffiliation(line):
            tryAdd(line)

        i += 1

    if not affiliations:
        return None
    return "; ".join(affiliations)


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


def normalizeAuthors(raw: Optional[str]) -> Optional[str]:
    if not raw or not raw.strip():
        return None
    parts = [s.strip() for s in raw.split(";") if s.strip()]
    if not parts:
        return None
    out: list[str] = []
    for p in parts:
        if "," in p:
            out.append(p)
            continue
        spaceIdx = p.rfind(" ")
        if spaceIdx == -1:
            out.append(p)
            continue
        out.append(p[spaceIdx + 1:] + ", " + p[:spaceIdx])
    return "; ".join(out)


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
            pageText = reader.pages[i].extract_text() or ""
            textParts.append(pageText)
        except Exception:
            textParts.append("")

    text = "\n".join(textParts)
    return {"info": info, "text": text, "titleCandidate": titleCandidate}
