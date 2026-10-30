#!/usr/bin/env python3
"""Prune tests/fixtures/node-schemas.json to the node classes this repo's
workflows actually use.

The fixture is a full dump of pinned ComfyUI + custom-node INPUT_TYPES used
by scripts/validate-workflow-schema.py (and read by feature-matrix.ts for
pack attribution). A full dump also carries every comfy_api_nodes partner
class (hosted-API nodes the repo never calls) — third-party product names
that must not live in the public tree. The validator only needs the classes
referenced from workflows/*.json, so the fixture is pruned to exactly that
set. Re-run after adding a workflow or re-dumping schemas:

    python3 scripts/prune-node-schemas.py

Exit 1 if a workflow references a class missing from the fixture — that
means the fixture is stale, not that pruning failed; re-dump it with
scripts/dump-node-schemas.py first.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FIXTURE = ROOT / "tests" / "fixtures" / "node-schemas.json"
WORKFLOWS = ROOT / "workflows"


def used_classes() -> set[str]:
    used: set[str] = set()
    for f in sorted(WORKFLOWS.glob("*.json")):
        graph = json.loads(f.read_text())
        for nid, node in graph.items():
            if nid != "_meta" and isinstance(node, dict):
                ct = node.get("class_type")
                if isinstance(ct, str):
                    used.add(ct)
    return used


def main() -> int:
    fx = json.loads(FIXTURE.read_text())
    nodes = fx.get("nodes", {})
    used = used_classes()
    missing = sorted(used - set(nodes))
    if missing:
        print(f"fixture is stale — {len(missing)} workflow classes missing:", file=sys.stderr)
        for m in missing:
            print(f"  {m}", file=sys.stderr)
        return 1
    kept = {k: nodes[k] for k in sorted(used)}
    dropped = len(nodes) - len(kept)
    fx["nodes"] = kept
    fx["pruned"] = (
        f"workflow-used classes only ({len(kept)} kept, {dropped} dropped) — "
        "scripts/prune-node-schemas.py"
    )
    FIXTURE.write_text(json.dumps(fx, indent=1, sort_keys=True) + "\n")
    print(f"pruned {FIXTURE.name}: {len(kept)} classes kept ({dropped} dropped)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
