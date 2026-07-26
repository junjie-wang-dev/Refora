from __future__ import annotations

import json

from refora_server.server.contract import source_contract

print(json.dumps(source_contract(), ensure_ascii=True, separators=(",", ":"), sort_keys=True))
