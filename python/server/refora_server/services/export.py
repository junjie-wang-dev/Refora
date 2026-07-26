from __future__ import annotations

import json
import re
import time
from typing import Any, Callable, TypedDict

BIBTEX_ESCAPE_MAP: dict[str, str] = {
    "\\": r"\textbackslash{}",
    "{": r"\{",
    "}": r"\}",
    "%": r"\%",
    "#": r"\#",
    '"': r'{\"}',
    "~": r"\textasciitilde{}",
    "^": r"\textasciicircum{}",
}

SKIP_WORDS: frozenset[str] = frozenset(
    {
        "a", "an", "the", "of", "in", "on", "at", "to", "for", "and", "or", "is",
        "are", "was", "were", "be", "been", "being", "has", "have", "had", "do",
        "does", "did", "will", "would", "could", "should", "may", "might", "can",
        "shall", "not", "no", "nor", "but", "yet", "so", "if", "then", "than",
        "that", "this", "these", "those", "it", "its", "with", "from", "by", "as",
        "into", "about", "over", "under", "up", "out", "also", "just", "only",
        "very", "too", "much", "more", "most", "some", "any", "all", "each", "every",
        "both", "few", "new", "other", "such", "own", "same", "use", "used", "using",
    }
)


class VenueEntry(TypedDict):
    canonical: str
    type: str
    patterns: tuple[re.Pattern[str], ...]


VENUES: tuple[VenueEntry, ...] = (
    {"canonical": "CVPR", "type": "conference", "patterns": (re.compile(r"\bCVPR\b"), re.compile(r"Computer Vision and Pattern Recognition", re.I))},
    {"canonical": "ICCV", "type": "conference", "patterns": (re.compile(r"\bICCV\b"), re.compile(r"International Conference on Computer Vision\b", re.I))},
    {"canonical": "ECCV", "type": "conference", "patterns": (re.compile(r"\bECCV\b"), re.compile(r"European Conference on Computer Vision\b", re.I))},
    {"canonical": "WACV", "type": "conference", "patterns": (re.compile(r"\bWACV\b"), re.compile(r"Winter Conference on Applications of Computer Vision\b", re.I))},
    {"canonical": "BMVC", "type": "conference", "patterns": (re.compile(r"\bBMVC\b"), re.compile(r"British Machine Vision Conference\b", re.I))},
    {"canonical": "NeurIPS", "type": "conference", "patterns": (re.compile(r"\bNeurIPS\b"), re.compile(r"\bNIPS\b"), re.compile(r"Neural Information Processing Systems\b", re.I), re.compile(r"Advances in Neural Information Processing Systems\b", re.I))},
    {"canonical": "ICML", "type": "conference", "patterns": (re.compile(r"\bICML\b"), re.compile(r"International Conference on Machine Learning\b", re.I))},
    {"canonical": "ICLR", "type": "conference", "patterns": (re.compile(r"\bICLR\b"), re.compile(r"International Conference on Learning Representations\b", re.I))},
    {"canonical": "AAAI", "type": "conference", "patterns": (re.compile(r"\bAAAI\b"), re.compile(r"AAAI Conference on Artificial Intelligence\b", re.I), re.compile(r"Association for the Advancement of Artificial Intelligence\b", re.I))},
    {"canonical": "IJCAI", "type": "conference", "patterns": (re.compile(r"\bIJCAI\b"), re.compile(r"International Joint Conference on Artificial Intelligence\b", re.I))},
    {"canonical": "ACL", "type": "conference", "patterns": (re.compile(r"\bACL\b"), re.compile(r"Annual Meeting of the Association for Computational Linguistics\b", re.I))},
    {"canonical": "EMNLP", "type": "conference", "patterns": (re.compile(r"\bEMNLP\b"), re.compile(r"Empirical Methods in Natural Language Processing\b", re.I))},
    {"canonical": "NAACL", "type": "conference", "patterns": (re.compile(r"\bNAACL\b"), re.compile(r"North American Chapter of the Association for Computational Linguistics\b", re.I))},
    {"canonical": "COLING", "type": "conference", "patterns": (re.compile(r"\bCOLING\b"), re.compile(r"International Conference on Computational Linguistics\b", re.I))},
    {"canonical": "KDD", "type": "conference", "patterns": (re.compile(r"\bKDD\b"), re.compile(r"Knowledge Discovery and Data Mining\b", re.I))},
    {"canonical": "SIGMOD", "type": "conference", "patterns": (re.compile(r"\bSIGMOD\b"), re.compile(r"International Conference on Management of Data\b", re.I))},
    {"canonical": "VLDB", "type": "conference", "patterns": (re.compile(r"\bVLDB\b"), re.compile(r"Very Large Data Bases\b", re.I))},
    {"canonical": "ICDE", "type": "conference", "patterns": (re.compile(r"\bICDE\b"), re.compile(r"International Conference on Data Engineering\b", re.I))},
    {"canonical": "WWW", "type": "conference", "patterns": (re.compile(r"\bWWW\b"), re.compile(r"The Web Conference\b", re.I), re.compile(r"International World Wide Web Conferences?\b", re.I))},
    {"canonical": "SIGGRAPH", "type": "conference", "patterns": (re.compile(r"\bSIGGRAPH\b"), re.compile(r"International Conference on Computer Graphics and Interactive Techniques\b", re.I))},
    {"canonical": "ICRA", "type": "conference", "patterns": (re.compile(r"\bICRA\b"), re.compile(r"International Conference on Robotics and Automation\b", re.I))},
    {"canonical": "IROS", "type": "conference", "patterns": (re.compile(r"\bIROS\b"), re.compile(r"International Conference on Intelligent Robots and Systems\b", re.I))},
    {"canonical": "RSS", "type": "conference", "patterns": (re.compile(r"\bRSS\b.*Robot", re.I), re.compile(r"Robotics: Science and Systems\b", re.I))},
    {"canonical": "SOSP", "type": "conference", "patterns": (re.compile(r"\bSOSP\b"), re.compile(r"Symposium on Operating Systems Principles\b", re.I))},
    {"canonical": "OSDI", "type": "conference", "patterns": (re.compile(r"\bOSDI\b"), re.compile(r"Operating Systems Design and Implementation\b", re.I))},
    {"canonical": "NSDI", "type": "conference", "patterns": (re.compile(r"\bNSDI\b"), re.compile(r"Symposium on Networked Systems Design and Implementation\b", re.I))},
    {"canonical": "EuroSys", "type": "conference", "patterns": (re.compile(r"\bEuroSys\b"), re.compile(r"European Conference on Computer Systems\b", re.I))},
    {"canonical": "USENIX ATC", "type": "conference", "patterns": (re.compile(r"\bUSENIX\s*ATC\b"), re.compile(r"USENIX Annual Technical Conference\b", re.I))},
    {"canonical": "CCS", "type": "conference", "patterns": (re.compile(r"\bCCS\b.*Security", re.I), re.compile(r"Computer and Communications Security\b", re.I))},
    {"canonical": "S&P", "type": "conference", "patterns": (re.compile(r"\bS\s*&\s*P\b"), re.compile(r"IEEE Symposium on Security and Privacy\b", re.I))},
    {"canonical": "NDSS", "type": "conference", "patterns": (re.compile(r"\bNDSS\b"), re.compile(r"Network and Distributed System Security Symposium\b", re.I))},
    {"canonical": "ICASSP", "type": "conference", "patterns": (re.compile(r"\bICASSP\b"), re.compile(r"International Conference on Acoustics, Speech and Signal Processing\b", re.I))},
    {"canonical": "ACML", "type": "conference", "patterns": (re.compile(r"\bACML\b"), re.compile(r"Asian Conference on Machine Learning\b", re.I))},
    {"canonical": "CoRL", "type": "conference", "patterns": (re.compile(r"\bCoRL\b"), re.compile(r"Conference on Robot Learning\b", re.I))},
    {"canonical": "3DV", "type": "conference", "patterns": (re.compile(r"\b3DV\b"), re.compile(r"International Conference on 3D Vision\b", re.I))},
    {"canonical": "WSDM", "type": "conference", "patterns": (re.compile(r"\bWSDM\b"), re.compile(r"Web Search and Data Mining\b", re.I))},
    {"canonical": "RECOMB", "type": "conference", "patterns": (re.compile(r"\bRECOMB\b"), re.compile(r"Research in Computational Molecular Biology\b", re.I))},
    {"canonical": "MICCAI", "type": "conference", "patterns": (re.compile(r"\bMICCAI\b"), re.compile(r"Medical Image Computing and Computer Assisted Intervention\b", re.I))},
    {"canonical": "Lecture Notes in Computer Science", "type": "conference", "patterns": (re.compile(r"Lecture Notes in Computer Science\b", re.I), re.compile(r"\bLNCS\b"))},
    {"canonical": "Communications of the ACM", "type": "journal", "patterns": (re.compile(r"Communications of the ACM\b", re.I), re.compile(r"\bCACM\b"))},
    {"canonical": "IEEE Transactions on Pattern Analysis and Machine Intelligence", "type": "journal", "patterns": (re.compile(r"Pattern Analysis and Machine Intelligence\b", re.I), re.compile(r"\bTPAMI\b"), re.compile(r"\bIEEE Trans\.?\s*Pattern Anal", re.I))},
    {"canonical": "IEEE Transactions on Image Processing", "type": "journal", "patterns": (re.compile(r"\bIEEE Transactions on Image Processing\b", re.I), re.compile(r"\bTIP\b.*Image", re.I), re.compile(r"Image Processing\b.*IEEE Trans", re.I), re.compile(r"\bIEEE Trans\.?\s*Image Process", re.I))},
    {"canonical": "IEEE Transactions on Neural Networks and Learning Systems", "type": "journal", "patterns": (re.compile(r"\bIEEE Transactions on Neural Networks\b", re.I), re.compile(r"Neural Networks and Learning Systems\b", re.I))},
    {"canonical": "IEEE Transactions on Knowledge and Data Engineering", "type": "journal", "patterns": (re.compile(r"Knowledge and Data Engineering\b", re.I), re.compile(r"\bTKDE\b"))},
    {"canonical": "IEEE Transactions on Multimedia", "type": "journal", "patterns": (re.compile(r"\bIEEE Transactions on Multimedia\b", re.I),)},
    {"canonical": "IEEE Transactions on Visualization and Computer Graphics", "type": "journal", "patterns": (re.compile(r"Visualization and Computer Graphics\b", re.I), re.compile(r"\bTVCG\b"))},
    {"canonical": "IEEE Transactions on Information Forensics and Security", "type": "journal", "patterns": (re.compile(r"Information Forensics and Security\b", re.I), re.compile(r"\bTIFS\b"))},
    {"canonical": "IEEE Transactions on Circuits and Systems for Video Technology", "type": "journal", "patterns": (re.compile(r"Circuits and Systems for Video Technology\b", re.I), re.compile(r"\bTCSVT\b"))},
    {"canonical": "IEEE Transactions on Signal Processing", "type": "journal", "patterns": (re.compile(r"\bIEEE Transactions on Signal Processing\b", re.I),)},
    {"canonical": "ACM Computing Surveys", "type": "journal", "patterns": (re.compile(r"ACM Computing Surveys\b", re.I), re.compile(r"\bCSUR\b"))},
    {"canonical": "ACM Transactions on Graphics", "type": "journal", "patterns": (re.compile(r"ACM Transactions on Graphics\b", re.I), re.compile(r"\bTOG\b"))},
    {"canonical": "Journal of Machine Learning Research", "type": "journal", "patterns": (re.compile(r"\bJMLR\b"), re.compile(r"Journal of Machine Learning Research\b", re.I))},
    {"canonical": "Pattern Recognition", "type": "journal", "patterns": (re.compile(r"^Pattern Recognition$", re.I), re.compile(r"^Pattern Recognition\s*$"))},
    {"canonical": "Neurocomputing", "type": "journal", "patterns": (re.compile(r"^Neurocomputing$", re.I),)},
    {"canonical": "Knowledge-Based Systems", "type": "journal", "patterns": (re.compile(r"Knowledge-Based Systems\b", re.I),)},
    {"canonical": "Information Fusion", "type": "journal", "patterns": (re.compile(r"^Information Fusion$", re.I),)},
    {"canonical": "Expert Systems with Applications", "type": "journal", "patterns": (re.compile(r"Expert Systems with Applications\b", re.I),)},
    {"canonical": "Neural Networks", "type": "journal", "patterns": (re.compile(r"^Neural Networks$", re.I),)},
    {"canonical": "Neural Computing and Applications", "type": "journal", "patterns": (re.compile(r"Neural Computing and Applications\b", re.I),)},
    {"canonical": "Artificial Intelligence", "type": "journal", "patterns": (re.compile(r"^Artificial Intelligence$", re.I),)},
    {"canonical": "Machine Learning", "type": "journal", "patterns": (re.compile(r"^Machine Learning$", re.I),)},
    {"canonical": "Computer Vision and Image Understanding", "type": "journal", "patterns": (re.compile(r"Computer Vision and Image Understanding\b", re.I), re.compile(r"\bCVIU\b"))},
    {"canonical": "Image and Vision Computing", "type": "journal", "patterns": (re.compile(r"Image and Vision Computing\b", re.I),)},
    {"canonical": "International Journal of Computer Vision", "type": "journal", "patterns": (re.compile(r"\bIJCV\b"), re.compile(r"International Journal of Computer Vision\b", re.I))},
    {"canonical": "Journal of Neuroscience Methods", "type": "journal", "patterns": (re.compile(r"Journal of Neuroscience Methods\b", re.I),)},
    {"canonical": "Vehicular Communications", "type": "journal", "patterns": (re.compile(r"^Vehicular Communications$", re.I),)},
    {"canonical": "Information Sciences", "type": "journal", "patterns": (re.compile(r"^Information Sciences$", re.I),)},
    {"canonical": "Science of Computer Programming", "type": "journal", "patterns": (re.compile(r"Science of Computer Programming\b", re.I),)},
    {"canonical": "Journal of Visual Communication and Image Representation", "type": "journal", "patterns": (re.compile(r"Visual Communication and Image Representation\b", re.I), re.compile(r"\bJ\.?\s*Vis\.?\s*Commun\.?\s*Image", re.I))},
    {"canonical": "IEEE Access", "type": "journal", "patterns": (re.compile(r"^IEEE Access$", re.I),)},
    {"canonical": "IEEE Signal Processing Letters", "type": "journal", "patterns": (re.compile(r"IEEE Signal Processing Letters\b", re.I),)},
    {"canonical": "IEEE Internet of Things Journal", "type": "journal", "patterns": (re.compile(r"Internet of Things Journal\b", re.I),)},
    {"canonical": "IEEE Journal of Selected Topics in Signal Processing", "type": "journal", "patterns": (re.compile(r"Selected Topics in Signal Processing\b", re.I),)},
)

JOURNAL_HINTS = re.compile(r"(\btransactions\b|\bjournal\b|\breview\b|\bannals\b|\bmagazine\b|\bletters?\b)", re.I)


def lookupVenue(venue: str) -> dict[str, str] | None:
    if not venue or venue.strip().__len__() == 0:
        return None
    v = venue.strip()
    for entry in VENUES:
        for p in entry["patterns"]:
            if p.search(v):
                return {"canonical": entry["canonical"], "type": entry["type"]}
    return None


def normalizeVenue(venue: str) -> str:
    info = lookupVenue(venue)
    return info["canonical"] if info is not None else venue


def venueType(venue: str) -> str | None:
    info = lookupVenue(venue)
    if info is not None:
        return info["type"]
    if JOURNAL_HINTS.search(venue):
        return "journal"
    return None


def _resolveEntryType(doc: dict[str, Any]) -> str:
    venue = (doc.get("venue") or "").strip()
    if not venue and not doc.get("volume") and not doc.get("pages"):
        return "misc"
    if venue:
        v_type = venueType(venue)
        if v_type == "conference":
            return "inproceedings"
        if v_type == "journal":
            return "article"
    if doc.get("volume"):
        return "article"
    if doc.get("pages") and not venue:
        return "misc"
    return "article"


def _escapeBibtexValue(value: str) -> str:
    result_parts: list[str] = []
    for ch in value:
        if ch in BIBTEX_ESCAPE_MAP:
            result_parts.append(BIBTEX_ESCAPE_MAP[ch])
        elif ord(ch) > 127:
            result_parts.append("{" + ch + "}")
        else:
            result_parts.append(ch)
    return "{" + "".join(result_parts) + "}"


_SANITIZE_CITEKEY_RE = re.compile(r"[^a-zA-Z0-9]")


def _sanitizeCitekey(s: str) -> str:
    return _SANITIZE_CITEKEY_RE.sub("", s).lower()


def _firstAuthorLastName(authors: str | None) -> str | None:
    if not authors:
        return None
    first = authors.split(";")[0].strip()
    if not first:
        return None
    comma_idx = first.find(",")
    return first[:comma_idx].strip() if comma_idx >= 0 else first.strip()


_TITLE_CLEAN_RE = re.compile(r"[{}\\]")
_NON_ALPHA_RE = re.compile(r"[^a-zA-Z]")


def _firstTitleWord(title: str | None) -> str | None:
    if not title:
        return None
    words = _TITLE_CLEAN_RE.sub(" ", title).split()
    for w in words:
        cleaned = _NON_ALPHA_RE.sub("", w)
        if len(cleaned) > 0 and cleaned.lower() not in SKIP_WORDS:
            return cleaned
    for w in words:
        if len(w) > 0:
            return _NON_ALPHA_RE.sub("", w)
    return None


def _buildCitekey(doc: dict[str, Any], used: set[str]) -> str:
    author = _firstAuthorLastName(doc.get("authors"))
    year_match = re.search(r"\d{4}", doc.get("year") or "")
    year = year_match.group(0) if year_match else (doc.get("year") or "")
    title_word = _firstTitleWord(doc.get("title"))

    if author or year or title_word:
        parts = [
            _sanitizeCitekey(s)
            for s in (author, year, title_word)
            if s is not None
        ]
        base = "".join(parts)
        if base:
            key = base
            suffix = 1
            while key in used:
                key = base + chr(96 + suffix)
                suffix += 1
                if suffix > 26:
                    while key in used:
                        suffix += 1
                        key = base + str(suffix)
                    break
            used.add(key)
            return key

    fallback = _sanitizeCitekey(doc.get("id", "")[:8])
    key = fallback
    suffix = 1
    while key in used:
        key = fallback + chr(96 + suffix)
        suffix += 1
        if suffix > 26:
            while key in used:
                suffix += 1
                key = fallback + str(suffix)
            break
    used.add(key)
    return key


def _formatAuthors(authors: str | None) -> str | None:
    if not authors:
        return None
    return " and ".join(a.strip() for a in authors.split(";") if a.strip())


def _formatBibtexEntry(doc: dict[str, Any], used: set[str]) -> str | None:
    entry_type = _resolveEntryType(doc)
    citekey = _buildCitekey(doc, used)

    fields: list[tuple[str, str]] = []
    if doc.get("title"):
        fields.append(("title", _escapeBibtexValue(doc["title"])))
    author_str = _formatAuthors(doc.get("authors"))
    if author_str:
        fields.append(("author", _escapeBibtexValue(author_str)))
    if doc.get("year"):
        fields.append(("year", _escapeBibtexValue(doc["year"])))
    if doc.get("venue"):
        venue_info = lookupVenue(doc["venue"])
        venue_name = venue_info["canonical"] if venue_info else doc["venue"]
        if entry_type == "inproceedings":
            fields.append(("booktitle", _escapeBibtexValue(venue_name)))
        else:
            fields.append(("journal", _escapeBibtexValue(venue_name)))
    if doc.get("volume"):
        fields.append(("volume", _escapeBibtexValue(doc["volume"])))
    if doc.get("issue"):
        fields.append(("number", _escapeBibtexValue(doc["issue"])))
    if doc.get("pages"):
        fields.append(("pages", _escapeBibtexValue(doc["pages"])))
    if doc.get("keywords"):
        fields.append(("keywords", _escapeBibtexValue(doc["keywords"])))
    if doc.get("url"):
        fields.append(("url", _escapeBibtexValue(doc["url"])))
    if doc.get("doi"):
        fields.append(("doi", _escapeBibtexValue(doc["doi"])))
    if doc.get("arxivId"):
        fields.append(("eprint", _escapeBibtexValue(doc["arxivId"])))
        fields.append(("archiveprefix", _escapeBibtexValue("arXiv")))

    if len(fields) == 0:
        return None

    lines = [f"  {k.ljust(12)} = {v}" for k, v in fields]
    return f"@{entry_type}{{{citekey},\n" + ",\n".join(lines) + "\n}"


def toBibtex(docs: list[dict[str, Any]]) -> str:
    used: set[str] = set()
    entries: list[str] = []
    for doc in docs:
        entry = _formatBibtexEntry(doc, used)
        if entry is not None:
            entries.append(entry)
    return "\n\n".join(entries) + ("\n" if entries else "")


class ExportRepos(TypedDict):
    documents: Any
    categories: Any
    settings: Any


class ExportServiceDeps(TypedDict, total=False):
    now: Callable[[], int]


def serialize(repos: ExportRepos, exportedAt: int | None = None) -> str:
    documents = repos["documents"]["list"]({"mode": "all"})
    categories = [
        {
            "id": c["id"],
            "name": c["name"],
            "sortOrder": c["sortOrder"],
            "createdAt": c["createdAt"],
        }
        for c in repos["categories"]["list"]()
    ]
    data = {
        "version": 1,
        "exportedAt": exportedAt if exportedAt is not None else int(time.time() * 1000),
        "documents": documents,
        "categories": categories,
        "documentCategories": repos["categories"]["getAllDocumentCategories"](),
    }
    return json.dumps(data, indent=2, ensure_ascii=False)


def createExportService(repos: ExportRepos, deps: ExportServiceDeps | None = None):
    deps = deps or {}
    now_fn: Callable[[], int] = deps.get("now", lambda: int(time.time() * 1000))

    def _resolveDocs(documentIds: list[str] | None, workspaceId: str | None) -> list[dict[str, Any]]:
        if documentIds is not None:
            docs: list[dict[str, Any]] = []
            for doc_id in documentIds:
                doc = repos["documents"]["get"](doc_id)
                if doc is not None:
                    docs.append(doc)
            return docs
        return repos["documents"]["list"]({"mode": "all"})

    def exportJson(documentIds: list[str] | None = None, workspaceId: str | None = None) -> dict[str, Any]:
        documents = _resolveDocs(documentIds, workspaceId)
        categories = [
            {
                "id": c["id"],
                "name": c["name"],
                "sortOrder": c["sortOrder"],
                "createdAt": c["createdAt"],
            }
            for c in repos["categories"]["list"]()
        ]
        document_categories = repos["categories"]["getAllDocumentCategories"]()
        return {
            "version": 1,
            "exportedAt": now_fn(),
            "documents": documents,
            "categories": categories,
            "documentCategories": document_categories,
        }

    def exportBibtex(documentIds: list[str] | None = None) -> dict[str, Any]:
        docs = _resolveDocs(documentIds, None)
        return {
            "version": 1,
            "exportedAt": now_fn(),
            "bibtex": toBibtex(docs),
        }

    def getBibtexString(documentIds: list[str]) -> dict[str, str]:
        docs = _resolveDocs(documentIds, None)
        return {"bibtex": toBibtex(docs)}

    def serializeExport() -> str:
        return serialize(repos, now_fn())

    return {
        "exportJson": exportJson,
        "exportBibtex": exportBibtex,
        "getBibtexString": getBibtexString,
        "serialize": serializeExport,
        "toBibtex": toBibtex,
    }
