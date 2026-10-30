#!/usr/bin/env python3
"""Dump node INPUT_TYPES schemas for the workflow schema validator.

Two sources:

  1. Native ComfyUI classes — REAL schemas via the server's own loader.
     Run under the ComfyUI venv interpreter:
         ~/comfy/ComfyUI/.venv/bin/python scripts/dump-node-schemas.py
     COMFY_ROOT env var overrides the checkout location.

  2. Custom-node packs — STATIC extraction of V1-style `INPUT_TYPES`
     classmethods (no imports: pack deps like librosa/torch-audio aren't
     needed). Sources: the repo's own comfy-nodes/ pack plus clones passed
     via --packs <dir> (each subdirectory treated as a pack root) — on the
     pod this is ComfyUI/custom_nodes, on the Mac the pinned clones in
     /tmp/of-nodes.

Output: tests/fixtures/node-schemas.json (committed — the validator runs
on plain python3 with no ComfyUI, no torch, no pack clones).

    {
      "generated_by": "scripts/dump-node-schemas.py",
      "comfy_root": "...",
      "comfy_version": "0.41.0",
      "packs": {"<dir name>": "<git sha>"},
      "nodes": {
        "<class_type>": {
          "src": "core" | "pack:<dir>",
          "inputs": {<v1 INPUT_TYPES dict>},   # dynamic io types preserved
          "outputs": ["IO_TYPE", ...] | null,
        }, ...
      }
    }
"""

from __future__ import annotations

import argparse
import ast
import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT_DEFAULT = ROOT / "tests" / "fixtures" / "node-schemas.json"

DYNAMIC_IO = {
    "COMFY_DYNAMICCOMBO_V3", "COMFY_AUTOGROW_V3", "COMFY_DYNAMICSLOT_V3",
    "COMFY_MULTIBUNDLE_V3", "COMFY_DYNAMICGROUP_V3", "COMFY_MATCHTYPE_V3",
}


class _Anything:
    """Stub for static INPUT_TYPES evaluation: every call -> [], every attr
    -> itself, iteration empty, truthiness False. Covers helpers like
    folder_paths.get_filename_list(...) and module-level constants."""

    def __call__(self, *a, **k):
        return []

    def __getattr__(self, name):
        return _Anything()

    def __iter__(self):
        return iter(())

    def __bool__(self):
        return False


def _static_input_types(py_file: Path) -> dict[str, dict]:
    """name -> INPUT_TYPES dict for every classmethod in one .py file."""
    try:
        tree = ast.parse(py_file.read_text(errors="replace"))
    except SyntaxError:
        return {}
    out = {}
    for node in ast.walk(tree):
        if not isinstance(node, ast.ClassDef):
            continue
        for item in node.body:
            if not (isinstance(item, ast.FunctionDef) and item.name == "INPUT_TYPES"):
                continue
            for stmt in ast.walk(item):
                if isinstance(stmt, ast.Return) and stmt.value is not None:
                    try:
                        val = eval(  # noqa: S307 - deliberate, stubbed env
                            compile(ast.Expression(stmt.value), str(py_file), "eval"),
                            {"__builtins__": {}},
                            _StaticEnv(),
                        )
                        if isinstance(val, dict):
                            out[node.name] = val
                    except Exception:
                        pass
                    break
    return out


class _Self:
    """Inert PromptServer stub: every attr/call returns itself so decorators
    like @PromptServer.instance.routes.get(...) survive import."""

    def __call__(self, *a, **k):
        return self

    def __getattr__(self, name):
        return self

    def __iter__(self):
        return iter(())

    def __bool__(self):
        return False


class _StaticEnv(dict):
    def __missing__(self, key):
        if key in ("True", "False", "None"):
            return {"True": True, "False": False, "None": None}[key]
        v = _Anything()
        self[key] = v
        return v


def _mappings(py_file: Path) -> dict[str, str]:
    try:
        src = py_file.read_text(errors="replace")
    except OSError:
        return {}
    out = {}
    import re
    for m in re.finditer(r"NODE_CLASS_MAPPINGS\s*=\s*\{(.*?)\}", src, re.S):
        for name, cls in re.findall(r'"([^"]+)"\s*:\s*(\w+)', m.group(1)):
            out[name] = cls
    return out


def _return_types(py_file: Path) -> dict[str, list]:
    try:
        tree = ast.parse(py_file.read_text(errors="replace"))
    except SyntaxError:
        return {}
    out = {}
    for node in ast.walk(tree):
        if not isinstance(node, ast.ClassDef):
            continue
        for item in node.body:
            if isinstance(item, ast.Assign):
                for t in item.targets:
                    if isinstance(t, ast.Name) and t.id == "RETURN_TYPES":
                        try:
                            val = ast.literal_eval(item.value)
                            if isinstance(val, (tuple, list)):
                                out[node.name] = [str(x) for x in val]
                        except Exception:
                            pass
    return out


def _git_sha(d: Path) -> str | None:
    try:
        return subprocess.run(["git", "-C", str(d), "rev-parse", "HEAD"],
                              capture_output=True, text=True, timeout=10).stdout.strip() or None
    except Exception:
        return None


def dump_packs(pack_dirs: list[Path], nodes: dict, packs_meta: dict,
               comfy_nodes=None):
    for d in pack_dirs:
        if not d.is_dir():
            continue
        cls_types: dict[str, dict] = {}
        ret: dict[str, list] = {}
        mapping: dict[str, str] = {}
        for f in d.rglob("*.py"):
            if "node_modules" in f.parts:
                continue
            mapping.update(_mappings(f))
            cls_types.update(_static_input_types(f))
            ret.update(_return_types(f))
        sha = _git_sha(d)
        packs_meta[d.name] = sha
        n = 0
        imported = False
        if comfy_nodes is not None:
            # real loader — the same path ComfyUI itself uses on the pod;
            # resolves V3 comfy_entrypoint packs (Chatterbox, FlashVSR…)
            before = set(comfy_nodes.NODE_CLASS_MAPPINGS)
            try:
                imported = bool(asyncio_run(comfy_nodes.load_custom_node(str(d))))
            except Exception as e:
                print(f"pack {d.name}: import failed ({e}) — static fallback",
                      file=sys.stderr)
            if imported:
                for name in set(comfy_nodes.NODE_CLASS_MAPPINGS) - before:
                    cls = comfy_nodes.NODE_CLASS_MAPPINGS[name]
                    try:
                        inputs = cls.INPUT_TYPES()
                    except Exception:
                        inputs = {}
                    outputs = None
                    rt = getattr(cls, "RETURN_TYPES", None)
                    if isinstance(rt, (tuple, list)):
                        outputs = [str(x) for x in rt]
                    else:
                        try:
                            sch = getattr(cls, "SCHEMA", None) or cls.define_schema()
                            outputs = [o.get_io_type() for o in sch.outputs]
                        except Exception:
                            outputs = None
                    nodes[name] = {"src": f"pack:{d.name}", "inputs": _to_jsonable(inputs),
                                   "outputs": outputs}
                    n += 1
        if not imported:
            for name, cls in mapping.items():
                nodes[name] = {
                    "src": f"pack:{d.name}",
                    "inputs": _to_jsonable(cls_types.get(cls) or {}),
                    "outputs": ret.get(cls),
                }
                n += 1
        print(f"pack {d.name} @{sha}: {n} classes mapped "
              f"({'imported' if imported else 'static'}, "
              f"{sum(1 for c in cls_types.values())} static INPUT_TYPES)", file=sys.stderr)


def _to_jsonable(o):
    import enum
    if isinstance(o, dict):
        return {str(k): _to_jsonable(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [_to_jsonable(v) for v in o]
    if isinstance(o, enum.Enum):
        return str(o.value)
    if type(o) in (str, int, float, bool) or o is None:
        return o
    return None  # stub objects / enums / callables -> null (harmless defaults)


def asyncio_run(coro):
    import asyncio
    return asyncio.run(coro)


def dump_core(comfy_root: Path, nodes: dict):
    sys.path.insert(0, str(comfy_root))
    import asyncio  # noqa: E402
    import nodes as comfy_nodes  # noqa: E402

    asyncio.run(comfy_nodes.init_extra_nodes(init_custom_nodes=False))
    # packs that touch PromptServer at import (VHS reads .prompt_queue at
    # module level) get an inert instance — attribute access returns stubs
    try:
        import server
        if not getattr(server.PromptServer, "instance", None):
            server.PromptServer.instance = _Self()
    except Exception:
        pass
    n = 0
    for name, cls in comfy_nodes.NODE_CLASS_MAPPINGS.items():
        try:
            inputs = cls.INPUT_TYPES()
        except Exception:
            inputs = {}
        outputs = None
        rt = getattr(cls, "RETURN_TYPES", None)
        if isinstance(rt, (tuple, list)):
            outputs = [str(x) for x in rt]
        else:
            try:
                sch = getattr(cls, "SCHEMA", None) or cls.define_schema()
                outputs = [o.get_io_type() for o in sch.outputs]
            except Exception:
                outputs = None
        nodes[name] = {"src": "core", "inputs": _to_jsonable(inputs), "outputs": outputs}
        n += 1
    return comfy_nodes, n


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--comfy-root", default=os.environ.get("COMFY_ROOT", os.path.expanduser("~/comfy/ComfyUI")))
    ap.add_argument("--packs", nargs="*", default=[],
                    help="pack root dirs (each treated as one custom-node pack)")
    ap.add_argument("--out", default=str(OUT_DEFAULT))
    ap.add_argument("--packs-only", action="store_true",
                    help="skip the ComfyUI import (stdlib-only machine)")
    args = ap.parse_args()

    nodes: dict = {}
    packs_meta: dict = {}
    comfy_root = Path(args.comfy_root)

    version = None
    vfile = comfy_root / "comfyui_version.py"
    if vfile.exists():
        import re
        m = re.search(r'VERSION\s*=\s*"([^"]+)"', vfile.read_text())
        version = m and m.group(1)

    comfy_nodes = None
    if not args.packs_only:
        comfy_nodes, n = dump_core(comfy_root, nodes)
        print(f"core: {n} classes (ComfyUI {version} @ {comfy_root})", file=sys.stderr)

    pack_dirs = [Path(p) for p in args.packs]
    own_pack = ROOT / "comfy-nodes"
    if own_pack.is_dir() and all(p.resolve() != own_pack.resolve() for p in pack_dirs):
        pack_dirs.append(own_pack)
    dump_packs(pack_dirs, nodes, packs_meta, comfy_nodes=comfy_nodes)

    doc = {
        "generated_by": "scripts/dump-node-schemas.py",
        "comfy_root": str(comfy_root),
        "comfy_version": version,
        "packs": packs_meta,
        "nodes": dict(sorted(nodes.items())),
    }
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(doc, indent=1, sort_keys=True) + "\n")
    print(f"wrote {out} — {len(nodes)} classes", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
