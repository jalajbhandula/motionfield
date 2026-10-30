#!/usr/bin/env python3
"""Offline linter for workflows/*.json (ComfyUI API-format graphs).

Checks per graph:
  a) JSON parses; every non-_meta entry has class_type + inputs.
  b) every class_type exists in the union of the object_info fixture,
     the local ComfyUI checkout (node_id="..." + NODE_CLASS_MAPPINGS),
     KNOWN_NODE_CLASSES (licenses.generated.ts) and the comfy-nodes pack.
  c) every link ["<id>", <slot>] resolves to a node in the same graph; the
     slot index is enforced where the source node's output count is known
     (motionfield_nodes RETURN_TYPES).
  d) every {{PLACEHOLDER}} in inputs is declared in _meta.placeholders;
     embedded/malformed tokens the engine never substitutes are flagged;
     declared-but-unused placeholders warn.
  e) _meta.optional entries must be declared placeholders.
  f) file-like _meta.requires entries must appear in models.cloud.json
     or the license catalog; non-file entries (node packs) are info.
  g) loader widget filenames checked against the manifest / license
     catalog — misses are reported as local-only assets (warnings).
  h) nodes carrying an optional placeholder get dropped by the engine
     when the param is unset — informational.

Exit code is always 0 (report-only); the full table lands in
/tmp/lint-workflows-report.txt and a summary + error list on stdout.
"""

import json
import os
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
COMFY = Path(os.environ.get("COMFY_ROOT", "~/comfy/ComfyUI")).expanduser()
REPORT = Path("/tmp/lint-workflows-report.txt")

WORKFLOWS = ROOT / "workflows"
OBJECT_INFO_CANDIDATES = [
    ROOT / "comfy-nodes" / "tests" / "fixtures" / "object_info.min.json",
    ROOT / "tests" / "fixtures" / "object_info.min.json",
]
MANIFEST = ROOT / "scripts" / "runpod" / "models.cloud.json"
CATALOG_DIR = ROOT / "src" / "lib" / "catalog"
NODE_PACK = ROOT / "comfy-nodes"

MODEL_EXT = re.compile(r"\.(safetensors|pth|pt|onnx|bin|ckpt|gguf)$", re.I)
FILE_TOKEN = re.compile(r"[A-Za-z0-9_.\-/]+\.(?:safetensors|pth|pt|onnx|bin|ckpt|gguf)", re.I)
PH_WHOLE = re.compile(r"^\{\{[A-Z_0-9]+\}\}$")
PH_TOKEN = re.compile(r"\{\{[^{}]*\}\}")


def load_node_names():
    """Union of every node-name source we can find locally."""
    names = set()
    sources = []

    for p in OBJECT_INFO_CANDIDATES:
        if p.exists():
            try:
                names.update(json.loads(p.read_text()).keys())
                sources.append(f"object_info fixture {p.relative_to(ROOT)}")
            except Exception as e:
                sources.append(f"object_info fixture {p} UNREADABLE: {e}")
            break

    if COMFY.exists():
        n0 = len(names)
        for pat in ("comfy_extras/**/*.py", "comfy_api_nodes/**/*.py", "nodes.py"):
            for f in COMFY.glob(pat):
                try:
                    names.update(re.findall(r'node_id="([^"]+)"', f.read_text(errors="replace")))
                except OSError:
                    pass
        nodes_py = COMFY / "nodes.py"
        if nodes_py.exists():
            src = nodes_py.read_text(errors="replace")
            m = re.search(r"NODE_CLASS_MAPPINGS\s*=\s*\{(.*?)\n\}", src, re.S)
            if m:
                names.update(re.findall(r'"([^"]+)"\s*:', m.group(1)))
        sources.append(f"ComfyUI checkout {COMFY} (+{len(names) - n0})")
    else:
        sources.append(f"ComfyUI checkout MISSING: {COMFY}")

    gen = ROOT / "src" / "lib" / "catalog" / "licenses.generated.ts"
    if gen.exists():
        src = gen.read_text(errors="replace")
        m = re.search(r"KNOWN_NODE_CLASSES:\s*string\[\]\s*=\s*\[(.*?)\]", src, re.S)
        if m:
            names.update(re.findall(r'"([^"]+)"', m.group(1)))
            sources.append("KNOWN_NODE_CLASSES (licenses.generated.ts)")

    if NODE_PACK.exists():
        n0 = len(names)
        for f in NODE_PACK.rglob("*.py"):
            try:
                src = f.read_text(errors="replace")
            except OSError:
                continue
            for m in re.finditer(r"NODE_CLASS_MAPPINGS\s*=\s*\{(.*?)\}", src, re.S):
                names.update(re.findall(r'"([^"]+)"\s*:', m.group(1)))
        sources.append(f"comfy-nodes pack (+{len(names) - n0})")

    return names, sources


def load_of_output_counts():
    """Map comfy-nodes class names -> declared RETURN_TYPES counts."""
    counts = {}
    if not NODE_PACK.exists():
        return counts
    for f in NODE_PACK.rglob("*.py"):
        try:
            src = f.read_text(errors="replace")
        except OSError:
            continue
        classes = {}
        for m in re.finditer(r"^class\s+(\w+)[\(:](.*?)(?=^class\s|\ANODE_CLASS_MAPPINGS|\Z)",
                             src, re.S | re.M):
            rt = re.search(r"RETURN_TYPES\s*=\s*\(([^)]*)\)", m.group(2))
            if rt:
                classes[m.group(1)] = len(re.findall(r'["\']', rt.group(1))) // 2
        for m in re.finditer(r"NODE_CLASS_MAPPINGS\s*=\s*\{(.*?)\}", src, re.S):
            for name, cls in re.findall(r'"([^"]+)"\s*:\s*(\w+)', m.group(1)):
                if cls in classes:
                    counts[name] = classes[cls]
    return counts


def load_manifest_names():
    names = set()
    if not MANIFEST.exists():
        return names
    for m in json.loads(MANIFEST.read_text()).get("models", []):
        if m.get("name"):
            names.add(m["name"])
        if m.get("path"):
            names.add(m["path"])
            names.add(m["path"].split("/")[-1])
    return names


def load_license_filenames():
    """Model filenames anywhere in the catalog (WEIGHT_LICENSES keys,
    generated weight names, bound-file constants like ACESTEP_FILES)."""
    names = set()
    for p in CATALOG_DIR.rglob("*.ts"):
        try:
            src = p.read_text(errors="replace")
        except OSError:
            continue
        for tok in FILE_TOKEN.findall(src):
            names.add(tok)
            names.add(tok.split("/")[-1])
    return names


def is_link(v):
    return isinstance(v, list) and len(v) == 2 and isinstance(v[0], str) and isinstance(v[1], int)


def load_engine_bound_keys():
    """Placeholder names the submit engine binds itself: the static map in
    placeholders() plus the RESERVED set (src/lib/generation/comfy.ts)."""
    bound = set()
    f = ROOT / "src" / "lib" / "generation" / "comfy.ts"
    if not f.exists():
        return bound
    src = f.read_text(errors="replace")
    m = re.search(r"const map: Record<string, string>\s*=\s*\{(.*?)\};", src, re.S)
    if m:
        bound.update(re.findall(r"^\s*([A-Z][A-Z_0-9]*)\s*:", m.group(1), re.M))
    m = re.search(r"const RESERVED\s*=\s*new Set\(\[(.*?)\]\)", src, re.S)
    if m:
        bound.update(re.findall(r'"([A-Z_0-9]+)"', m.group(1)))
    return bound


def lint_file(path, node_names, out_counts, manifest, license_names, bound):
    errors, warns, infos = [], [], []
    try:
        graph = json.loads(path.read_text())
    except Exception as e:
        return [f"JSON parse error: {e}"], warns, infos
    if not isinstance(graph, dict):
        return ["top level is not an object"], warns, infos

    meta = graph.get("_meta") or {}
    # keys may be slash-combined shorthands sharing the first segment's
    # prefix — "ACESTEP_UNET/CLIP1/CLIP2/VAE" declares ACESTEP_CLIP1 etc.
    declared = set()
    for key in (meta.get("placeholders") or {}):
        parts = [p for p in key.split("/") if p]
        if not parts:
            continue
        declared.add(parts[0])
        prefix = parts[0][: parts[0].rfind("_") + 1] if "_" in parts[0] else ""
        for p in parts[1:]:
            declared.add(p if ("_" in p or not prefix) else prefix + p)
    optional = set(meta.get("optional") or [])
    requires = meta.get("requires") or []
    drop_outputs = set(meta.get("drop_outputs") or [])

    node_ids = {k for k in graph if k != "_meta"}
    used_ph = {}   # name -> [node ids]
    for nid, node in graph.items():
        if nid == "_meta":
            continue
        if not isinstance(node, dict) or "class_type" not in node:
            errors.append(f"node {nid}: missing class_type")
            continue
        ct = node["class_type"]
        if ct not in node_names:
            errors.append(f"node {nid}: unknown class_type '{ct}'")
        inputs = node.get("inputs") or {}
        if not isinstance(inputs, dict):
            errors.append(f"node {nid}: inputs is not an object")
            continue

        for k, v in inputs.items():
            # (c) links
            if is_link(v):
                src_id, slot = v
                if src_id not in node_ids:
                    errors.append(f"node {nid} input {k}: link to missing node '{src_id}'")
                else:
                    src_ct = graph[src_id].get("class_type")
                    n_out = out_counts.get(src_ct)
                    if n_out is not None and not (0 <= slot < n_out):
                        errors.append(
                            f"node {nid} input {k}: slot {slot} out of range for "
                            f"{src_ct} ({n_out} outputs)")
            # (d) placeholders
            if isinstance(v, str) and "{{" in v:
                if PH_WHOLE.match(v):
                    key = v[2:-2]
                    used_ph.setdefault(key, []).append(nid)
                    if key not in declared:
                        hint = (" (engine binds this key — _meta doc gap, not a "
                                "submit blocker)" if key in bound else
                                " (not engine-bound — submit fails 'missing "
                                "placeholders' when no param supplies it)")
                        errors.append(
                            f"node {nid} input {k}: undeclared placeholder {v}{hint}")
                    if key in optional:
                        infos.append(
                            f"node {nid} ({ct}): dropped when optional {key} is unset")
                else:
                    for tok in PH_TOKEN.findall(v):
                        if PH_WHOLE.match(tok):
                            note = ("; node is in _meta.drop_outputs so the "
                                    "literal only stains a discarded artifact"
                                    if nid in drop_outputs else "")
                            errors.append(
                                f"node {nid} input {k}: embedded {tok} is never "
                                f"substituted (engine only replaces whole-value "
                                f"placeholders) — literal text reaches ComfyUI{note}")
                        else:
                            errors.append(
                                f"node {nid} input {k}: malformed placeholder {tok}")
            # (g) loader widget filenames
            if isinstance(v, str) and MODEL_EXT.search(v) and "{{" not in v:
                base = v.split("/")[-1].split("\\")[-1]
                if v not in manifest and base not in manifest and \
                   v not in license_names and base not in license_names:
                    warns.append(
                        f"node {nid} ({ct}) input {k}: '{v}' not in "
                        f"models.cloud.json / license catalog — local-only asset?")

    # (d) declared-but-unused
    for name in sorted(declared - set(used_ph)):
        warns.append(f"declared placeholder '{{{{{name}}}}}' never used in inputs")

    # (e) optional ⊆ placeholders
    for name in sorted(optional - declared):
        errors.append(f"_meta.optional: '{name}' is not a declared placeholder")
    for name in sorted(optional - set(used_ph) & declared):
        infos.append(f"optional placeholder '{name}' declared but never used in inputs")

    # (f) requires — filename tokens in the bare text are hard requirements;
    # tokens only inside parenthetical annotations are soft references
    for req in requires:
        bare = re.sub(r"\s*\(.*?\)\s*", " ", req).strip()
        bare = re.sub(r"^custom-nodes:\s*", "", bare)
        inner = " ".join(m.group(1) for m in re.finditer(r"\((.*?)\)", req))
        bare_files = set(FILE_TOKEN.findall(bare))
        inner_files = set(FILE_TOKEN.findall(inner)) - bare_files
        if not bare_files and not inner_files:
            infos.append(f"non-file requires entry: '{req[:80]}'")
            continue
        for f in sorted(bare_files):
            base = f.split("/")[-1]
            if f not in manifest and base not in manifest and \
               f not in license_names and base not in license_names:
                errors.append(
                    f"_meta.requires: '{f}' not found in models.cloud.json "
                    f"or license catalog (from '{req[:80]}')")
        for f in sorted(inner_files):
            base = f.split("/")[-1]
            if f not in manifest and base not in manifest and \
               f not in license_names and base not in license_names:
                warns.append(
                    f"_meta.requires annotation references '{f}' — not in "
                    f"models.cloud.json / license catalog (from '{req[:80]}')")

    return errors, warns, infos


def main():
    node_names, sources = load_node_names()
    out_counts = load_of_output_counts()
    manifest = load_manifest_names()
    license_names = load_license_filenames()
    bound = load_engine_bound_keys()

    lines = []
    lines.append("MotionField workflow lint — " + str(WORKFLOWS))
    lines.append("node-name sources: " + "; ".join(sources))
    lines.append(f"known node types: {len(node_names)} | "
                 f"OF output counts: {len(out_counts)} | "
                 f"manifest names: {len(manifest)} | catalog filenames: {len(license_names)} | "
                 f"engine-bound placeholders: {len(bound)}")
    lines.append("=" * 100)

    files = sorted(WORKFLOWS.glob("*.json"))
    total_e = total_w = total_i = 0
    error_report = []
    for f in files:
        errors, warns, infos = lint_file(f, node_names, out_counts, manifest, license_names, bound)
        total_e += len(errors)
        total_w += len(warns)
        total_i += len(infos)
        status = "FAIL" if errors else ("warn" if warns else "ok")
        lines.append(f"\n### {f.name}  [{status}]  ({len(errors)}E/{len(warns)}W/{len(infos)}I)")
        for e in errors:
            lines.append(f"  ERROR   {e}")
            error_report.append(f"{f.name}: {e}")
        for w in warns:
            lines.append(f"  warn    {w}")
        for i in infos:
            lines.append(f"  info    {i}")

    lines.append("\n" + "=" * 100)
    lines.append(f"SUMMARY: {len(files)} workflows | {total_e} errors | "
                 f"{total_w} warnings | {total_i} info")
    lines.append("\nALL ERRORS:")
    lines.extend(f"  {e}" for e in error_report)

    REPORT.write_text("\n".join(lines) + "\n")

    # stdout: summary + errors only
    print(f"scanned {len(files)} workflows -> {total_e} errors, "
          f"{total_w} warnings, {total_i} info  (full report: {REPORT})")
    if error_report:
        print("\nERRORS:")
        for e in error_report:
            print(f"  {e}")


if __name__ == "__main__":
    sys.exit(main())
