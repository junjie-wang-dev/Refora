from __future__ import annotations

import re


SAFE_DOCUMENT_ID_PATTERN = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}")


def is_safe_document_id(value: object) -> bool:
    return isinstance(value, str) and SAFE_DOCUMENT_ID_PATTERN.fullmatch(value) is not None
