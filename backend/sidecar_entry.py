from __future__ import annotations

import json
import sys


if sys.argv[1:] == ["--verify-artifact"]:
    from refora_server.server.artifact_smoke import verify_artifact

    sys.stdout.write(f"{json.dumps(verify_artifact(), sort_keys=True)}\n")
    raise SystemExit(0)

from refora_server.server.run import main

raise SystemExit(main())
