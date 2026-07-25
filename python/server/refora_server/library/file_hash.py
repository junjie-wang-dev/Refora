from __future__ import annotations

import hashlib
import os
from typing import Optional

CHUNK_SIZE = 64 * 1024


def streamHash(filePath: str) -> Optional[str]:
    if not os.path.isfile(filePath):
        return None
    h = hashlib.sha256()
    try:
        with open(filePath, "rb") as f:
            while True:
                chunk = f.read(CHUNK_SIZE)
                if not chunk:
                    break
                h.update(chunk)
    except OSError:
        return None
    return h.hexdigest()
