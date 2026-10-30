#!/usr/bin/env python3
"""Resolve sha256 for gated Hugging Face files in models.cloud.json.

Gated repos (Lightricks/LTX-2.5, the 2.5 IC-LoRA packs) mask their LFS oid in
anonymous API responses, so the manifest ships them as "pending". One call per
repo against the paths-info endpoint with HF_TOKEN set resolves them; the
manifest is rewritten in place and setup.sh's normal checksum gate then
verifies every download end-to-end.

    HF_TOKEN=hf_... python3 scripts/runpod/fill-hashes.py [manifest]

Exit codes: 0 = nothing pending or all resolved, 1 = unresolved remain, 2 = usage.
"""
import json
import re
import sys
import urllib.request
from collections import defaultdict
from pathlib import Path

SHA_OK = re.compile(r"^[0-9a-f]{64}$")
API = "https://huggingface.co/api/models/{repo}/paths-info/main"


def paths_info(repo: str, paths: list[str], token: str) -> dict:
    body = json.dumps({"paths": paths}).encode()
    req = urllib.request.Request(
        API.format(repo=repo), data=body,
        headers={"Content-Type": "application/json",
                 "Authorization": f"Bearer {token}"},
        method="POST")
    with urllib.request.urlopen(req, timeout=30) as r:
        entries = json.load(r)
    out = {}
    for e in entries:
        lfs = e.get("lfs") or {}
        oid = lfs.get("oid")
        size = lfs.get("size") or e.get("size")
        out[e["path"]] = (oid, size)
    return out


def main() -> int:
    manifest = Path(sys.argv[1] if len(sys.argv) > 1 else
                    Path(__file__).with_name("models.cloud.json"))
    import os
    token = os.environ.get("HF_TOKEN", "")
    m = json.loads(manifest.read_text())
    pending = [e for e in m.get("models", []) if not SHA_OK.match(str(e.get("sha256", "")))]
    if not pending:
        print("fill-hashes: all entries already carry sha256 — nothing to do")
        return 0
    if not token:
        for e in pending:
            print(f"fill-hashes: PENDING {e['repo']}/{e['path']}", file=sys.stderr)
        print("fill-hashes: set HF_TOKEN (read access + licence accepted on each repo)", file=sys.stderr)
        return 1
    if not token.startswith("hf_"):
        print("fill-hashes: HF_TOKEN doesn't look like an hf_* token — skipping API calls", file=sys.stderr)
        return 1

    by_repo: dict[str, list[dict]] = defaultdict(list)
    for e in pending:
        by_repo[e["repo"]].append(e)

    unresolved = 0
    for repo, entries in by_repo.items():
        try:
            info = paths_info(repo, [e["path"] for e in entries], token)
        except Exception as ex:
            print(f"fill-hashes: {repo}: paths-info failed: {ex}", file=sys.stderr)
            unresolved += len(entries)
            continue
        for e in entries:
            oid, size = info.get(e["path"], (None, None))
            if oid and SHA_OK.match(oid):
                e["sha256"] = oid
                if size:
                    e["bytes"] = int(size)
                print(f"fill-hashes: resolved {e['name']} -> {oid[:12]}…")
            else:
                print(f"fill-hashes: still unresolved {e['repo']}/{e['path']} (oid={oid})", file=sys.stderr)
                unresolved += 1

    manifest.write_text(json.dumps(m, indent=2) + "\n")
    if unresolved:
        print(f"fill-hashes: {unresolved} entr(ies) unresolved — accept the repo licence on HF first", file=sys.stderr)
        return 1
    print("fill-hashes: all sha256 resolved")
    return 0


if __name__ == "__main__":
    sys.exit(main())
