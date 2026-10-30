#!/usr/bin/env python3
"""Build the MotionField Blender extension zip — stdlib only.

    python3 plugins/blender/build.py [--out DIR]

Writes dist/motionfield_blender-<version>.zip (or DIR when --out is given)
with every entry at the archive root, exactly as a Blender 4.2+ extension
expects. Output is reproducible: entries are sorted, timestamps are pinned
to the zip epoch, and only file contents decide the bytes — two builds of
the same tree produce the same sha256.

The pure-python API client is vendored at vendor/motionfield/, copied
verbatim from packages/sdk-py/motionfield together with its MIT LICENSE —
the add-on itself is GPL-2.0-or-later (LICENSE at the archive root). The
vendored copy is never edited; fix packages/sdk-py and rebuild.
"""

from __future__ import annotations

import hashlib
import os
import re
import sys
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
EXT_DIR = os.path.join(HERE, "motionfield_blender")
SDK_DIR = os.path.join(ROOT, "packages", "sdk-py", "motionfield")
SDK_LICENSE = os.path.join(ROOT, "packages", "sdk-py", "LICENSE")

# the zip epoch — the earliest timestamp zip can store; pinning every entry
# is what makes the archive reproducible
FIXED_DT = (1980, 1, 1, 0, 0, 0)
EXCLUDE = {"__pycache__", ".DS_Store"}


def _version():
    text = open(os.path.join(EXT_DIR, "blender_manifest.toml"), encoding="utf-8").read()
    try:
        import tomllib
        return tomllib.loads(text)["version"]
    except Exception:
        m = re.search(r'^\s*version\s*=\s*"([^"]+)"', text, re.M)
        if not m:
            raise SystemExit("build: no version in blender_manifest.toml")
        return m.group(1)


def _entries():
    """(arcname, absolute path) pairs — extension files at the archive root
    plus the vendored SDK under vendor/motionfield/, all sorted."""
    out = []
    for dirpath, dirnames, filenames in os.walk(EXT_DIR):
        dirnames[:] = sorted(d for d in dirnames if d not in EXCLUDE)
        for name in sorted(filenames):
            if name.endswith((".pyc", ".pyo")) or name in EXCLUDE:
                continue
            src = os.path.join(dirpath, name)
            out.append((os.path.relpath(src, EXT_DIR), src))
    for name in sorted(os.listdir(SDK_DIR)):
        src = os.path.join(SDK_DIR, name)
        if os.path.isfile(src) and name.endswith(".py"):
            out.append((os.path.join("vendor", "motionfield", name), src))
    out.append((os.path.join("vendor", "motionfield", "LICENSE"), SDK_LICENSE))
    out.sort(key=lambda e: e[0])
    return out


def build(out_dir):
    version = _version()
    os.makedirs(out_dir, exist_ok=True)
    path = os.path.join(out_dir, f"motionfield_blender-{version}.zip")
    entries = _entries()
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED,
                         compresslevel=9) as zf:
        for arc, src in entries:
            info = zipfile.ZipInfo(arc.replace(os.sep, "/"), FIXED_DT)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16  # regular file, 0644
            with open(src, "rb") as f:
                zf.writestr(info, f.read())
    return path


def main(argv):
    out_dir = os.path.join(HERE, "dist")
    if "--out" in argv:
        out_dir = argv[argv.index("--out") + 1]
    path = build(out_dir)
    digest = hashlib.sha256(open(path, "rb").read()).hexdigest()
    print(f"{path}\nsha256 {digest}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
