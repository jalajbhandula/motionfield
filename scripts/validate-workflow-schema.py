#!/usr/bin/env python3
"""Workflow schema validator — validates workflows/*.json against the real
node INPUT_TYPES of the pinned ComfyUI + custom-node classes.

This is a faithful port of the server's prompt validation:

  * class_type must exist in the schema fixture (native ComfyUI classes +
    custom-node packs, dumped by scripts/dump-node-schemas.py at the exact
    pinned commits the pod installs)
  * inputs are expanded exactly like the server's
    comfy_api.latest._io.get_finalized_class_inputs / build_nested_inputs:
    - DynamicCombo:   "<id>" holds the option key; the selected option's
                      sub-inputs live at "<id>.<sub>" (dotted keys).
    - Autogrow:       template names expand to "<id>.<name>"; the first
                      `min` are required when the template input is required.
    - DynamicSlot:    when "<id>" is present its inner inputs expand to
                      "<id>.<sub>".
    - DynamicGroup:   keys "<id>.<row>.<field>", row < max, field in the
                      template; present rows bounded by min/max.
  * every required input must be present; every provided key must be a
    valid (post-expansion) input — the flat-sibling-key bug
    ("qef" instead of "sign_mode.qef") is caught here
  * enum membership for COMBO inputs and DynamicCombo option keys
  * INT/FLOAT range checks where the schema declares min/max
  * links resolve to a node in the same graph, the slot index is inside the
    source node's output count, and the source output's io_type is accepted
    by the input's io_type (comma-union + "*" wildcard aware)

Usage:
    python3 scripts/validate-workflow-schema.py [--fixtures <file>] \
        [--workflows <dir>] [--quiet]

Reads tests/fixtures/node-schemas.json by default (committed; regenerate
with scripts/dump-node-schemas.py under the ComfyUI venv). Exit 1 on any
error — this is a gate, not a report.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FIXTURE = ROOT / "tests" / "fixtures" / "node-schemas.json"
WORKFLOWS = ROOT / "workflows"

WILDCARDS = {"*", "ANY", "COMFY_ANYTYPE_V3", "COMFY_MULTITYPED_V3", "COMFY_MATCHTYPE_V3"}
DYNAMIC_IO = {
    "COMFY_DYNAMICCOMBO_V3",
    "COMFY_AUTOGROW_V3",
    "COMFY_DYNAMICSLOT_V3",
    "COMFY_DYNAMICGROUP_V3",
    "COMFY_MULTIBUNDLE_V3",
    "COMFY_MATCHTYPE_V3",
}
SCALAR_IO = {"INT", "FLOAT", "BOOLEAN", "COMBO", "STRING", "SEED"}
PH_WHOLE = re.compile(r"^\{\{[A-Z_0-9]+\}\}$")


def is_link(v) -> bool:
    return isinstance(v, list) and len(v) == 2 and isinstance(v[0], str) and isinstance(v[1], int)


def is_ph(v) -> bool:
    return isinstance(v, str) and bool(PH_WHOLE.match(v))


def accepted(io_type: str) -> set[str]:
    return {t.strip() for t in str(io_type).split(",") if t.strip()}


def types_ok(in_type: str, out_type: str | None) -> bool:
    if out_type is None:
        return True  # unknown output spec — don't guess
    a, b = accepted(in_type), accepted(out_type)
    return bool(a & b) or bool(a & WILDCARDS) or bool(b & WILDCARDS)


class NodeSchema:
    """Expand one class's INPUT_TYPES against live inputs — port of
    parse_class_inputs + the three _expand_schema_for_dynamic handlers."""

    def __init__(self, spec: dict):
        self.spec = spec or {}
        self.outputs = (spec or {}).get("outputs")

    def finalize(self, live: dict) -> tuple[dict, dict]:
        """returns (valid: name->spec_entry, required: set)."""
        valid: dict[str, object] = {}
        required: set[str] = set()
        self._parse(self.spec.get("inputs") or {}, live, None, valid, required)
        return valid, required

    def _parse(self, curr: dict, live: dict, prefix: list | None,
               valid: dict, required: set):
        for section in ("required", "optional", "hidden"):
            inner = curr.get(section)
            if not isinstance(inner, dict):
                continue
            for iid, entry in inner.items():
                if not (isinstance(entry, (list, tuple)) and entry):
                    continue
                if isinstance(entry[0], (list, tuple)):
                    # V1 combo shorthand: ("opt1","opt2",...) or ([opts], {meta})
                    io_type, meta = "COMBO", (entry[1] if len(entry) > 1 and isinstance(entry[1], dict) else {})
                    meta = dict(meta)
                    meta.setdefault("options", list(entry[0]))
                else:
                    io_type, meta = entry[0], (entry[1] if len(entry) > 1 else {})
                path = (prefix or []) + [iid]
                fid = ".".join(path)
                if io_type in DYNAMIC_IO:
                    self._dynamic(io_type, iid, meta, section, path, live, valid, required)
                else:
                    valid[fid] = (io_type, meta, section)
                    if section == "required":
                        required.add(fid)

    def _dynamic(self, io_type, iid, meta, section, path, live, valid, required):
        meta = meta or {}
        fid = ".".join(path)
        if io_type == "COMFY_DYNAMICCOMBO_V3":
            # the combo input itself is valid/required; the selected option's
            # sub-inputs expand at "<id>.<sub>"
            valid[fid] = (io_type, meta, section)
            if section == "required":
                required.add(fid)
            key = live.get(fid)
            opts = meta.get("options") or []
            if is_ph(key) or key is None:
                # undetermined selection — accept any sub-key of any option,
                # none required (can't know which option will be picked)
                for opt in opts:
                    for sec in ("required", "optional"):
                        for sub in (opt.get("inputs") or {}).get(sec, {}):
                            valid[f"{fid}.{sub}"] = (None, None, sec)
                return
            for opt in opts:
                if opt.get("key") == key:
                    self._parse(opt.get("inputs") or {}, live, path, valid, required)
                    return
            # unknown option key — reported by the caller (it sees the valid set)
            valid[fid] = (io_type, meta, section)

        elif io_type == "COMFY_AUTOGROW_V3":
            tpl = meta.get("template") or {}
            tpl_input = tpl.get("input") or {}
            tpl_entry = None
            tpl_required = False
            for sec in ("required", "optional"):
                d = tpl_input.get(sec)
                if d:
                    tpl_entry = list(d.values())[0]
                    tpl_required = sec == "required"
                    break
            if "names" in tpl:
                names = list(tpl.get("names") or [])
                mn = tpl.get("min", 0)
            else:
                mx = tpl.get("max", 10)
                mn = tpl.get("min", 0)
                names = [f"{tpl.get('prefix', '')}{i}" for i in range(mx)]
            for i, name in enumerate(names):
                eid = f"{fid}.{name}"
                valid[eid] = tpl_entry
                if i < mn and tpl_required:
                    required.add(eid)

        elif io_type == "COMFY_DYNAMICSLOT_V3":
            valid[fid] = (io_type, meta, section)
            if fid in live:
                self._parse(meta.get("inputs") or {}, live, path, valid, required)

        elif io_type == "COMFY_DYNAMICGROUP_V3":
            mx = meta.get("max", 20)
            fields = {}
            for sec in ("required", "optional"):
                for f, fe in (meta.get("template") or {}).get(sec, {}).items():
                    fields[f] = (fe, sec)
            prefix = fid + "."
            rows = set()
            for key in live:
                if not key.startswith(prefix):
                    continue
                rest = key[len(prefix):]
                idx, sep, field = rest.partition(".")
                if not sep or not idx.isdigit() or (len(idx) > 1 and idx.startswith("0")) \
                        or field not in fields:
                    # invalid shape — caller flags it as an unknown input
                    continue
                rows.add(int(idx))
            for r in rows:
                if r >= mx:
                    continue  # caller flags: row index over max
                for f, (fe, sec) in fields.items():
                    eid = f"{fid}.{r}.{f}"
                    valid[eid] = fe
                    if sec == "required":
                        required.add(eid)

        else:
            # unknown dynamic io type — accept the id and any sub-key so a
            # newer ComfyUI type doesn't produce false errors
            valid[fid] = (io_type, meta, section)


def check_scalar(io_type, meta, key, val, errs, warns, nid):
    if is_ph(val):
        return
    if io_type == "COMBO":
        opts = (meta or {}).get("options")
        # filename-loader combos are directory scans — env-dependent; the
        # manifest lint owns filename correctness, not the enum check
        file_val = isinstance(val, str) and bool(
            re.search(r"\.(safetensors|pth|pt|onnx|bin|ckpt|gguf|onnx|json)$", val, re.I))
        if isinstance(opts, list) and opts and val not in opts and not file_val:
            errs.append(f"node {nid} input {key}: '{val}' not in options {opts[:8]}{'…' if len(opts) > 8 else ''}")
    elif io_type == "INT" or io_type == "SEED":
        if not isinstance(val, int) or isinstance(val, bool):
            errs.append(f"node {nid} input {key}: expected INT, got {val!r}")
    elif io_type == "FLOAT":
        if not isinstance(val, (int, float)) or isinstance(val, bool):
            errs.append(f"node {nid} input {key}: expected FLOAT, got {val!r}")
    elif io_type == "BOOLEAN":
        if not isinstance(val, bool):
            errs.append(f"node {nid} input {key}: expected BOOLEAN, got {val!r}")
    if isinstance(val, (int, float)) and not isinstance(val, bool) and isinstance(meta, dict):
        lo, hi = meta.get("min"), meta.get("max")
        if isinstance(lo, (int, float)) and val < lo:
            errs.append(f"node {nid} input {key}: {val} below min {lo}")
        if isinstance(hi, (int, float)) and val > hi:
            errs.append(f"node {nid} input {key}: {val} above max {hi}")


def validate(path: Path, nodes: dict) -> tuple[list, list]:
    errs, warns = [], []
    try:
        graph = json.loads(path.read_text())
    except Exception as e:
        return [f"JSON parse error: {e}"], warns
    schemas = {nid: NodeSchema(nodes.get(graph[nid].get("class_type", ""), {}))
               for nid in graph if nid != "_meta" and isinstance(graph.get(nid), dict)}

    for nid, node in graph.items():
        if nid == "_meta":
            continue
        ct = node.get("class_type")
        spec = nodes.get(ct)
        if spec is None:
            errs.append(f"node {nid}: unknown class_type '{ct}'")
            continue
        inputs = node.get("inputs") or {}
        sch = schemas[nid]
        valid, required = sch.finalize(inputs)

        # VHS-style pseudo-dynamic: a COMBO input whose meta carries
        # "formats": {"<format>": [[name, type|options, meta?], ...]} exposes
        # per-format widget inputs, delivered to the node via **kwargs.
        for key, val in inputs.items():
            entry = valid.get(key)
            if not (isinstance(entry, tuple) and entry and entry[0] == "COMBO"):
                continue
            meta = entry[1] if isinstance(entry, tuple) and len(entry) > 1 else None
            fmts = (meta or {}).get("formats")
            if isinstance(fmts, dict) and isinstance(val, str) and val in fmts:
                widgets = fmts[val]
                if isinstance(widgets, list):
                    for w in widgets:
                        if isinstance(w, list) and w and isinstance(w[0], str):
                            wname = w[0]
                            wspec = w[1] if len(w) > 1 else None
                            wmeta = w[2] if len(w) > 2 and isinstance(w[2], dict) else {}
                            if isinstance(wspec, list):
                                wmeta = dict(wmeta)
                                wmeta.setdefault("options", wspec)
                                wspec = "COMBO"
                            valid.setdefault(wname, (wspec, wmeta, "optional"))

        for key, val in inputs.items():
            if key not in valid:
                # dotted key that never registered, or a bare sibling of a
                # dynamic input (the sign_mode.qef bug shape)
                if "." in key:
                    root = key.split(".", 1)[0]
                    if root in valid or any(k.startswith(root + ".") for k in valid):
                        errs.append(
                            f"node {nid} ({ct}) input '{key}': not a declared input "
                            f"(dynamic sub-input keys must match the schema)")
                        continue
                errs.append(f"node {nid} ({ct}): unknown input '{key}'")
                continue
            entry = valid[key]
            io_type = entry[0] if isinstance(entry, tuple) else None
            meta = entry[1] if isinstance(entry, tuple) and len(entry) > 1 else None
            if is_link(val):
                src, slot = val
                if src not in graph or src == "_meta" or not isinstance(graph.get(src), dict):
                    errs.append(f"node {nid} input {key}: link to missing node '{src}'")
                    continue
                sct = graph[src].get("class_type")
                outs = (nodes.get(sct) or {}).get("outputs")
                if outs is not None and not (0 <= slot < len(outs)):
                    errs.append(f"node {nid} input {key}: slot {slot} out of range "
                                f"for {sct} ({len(outs)} outputs)")
                    continue
                if outs is not None and io_type and slot < len(outs):
                    if not types_ok(io_type, outs[slot]):
                        errs.append(f"node {nid} input {key}: {sct} output {slot} "
                                    f"type '{outs[slot]}' not accepted by '{io_type}'")
            elif io_type == "COMFY_DYNAMICCOMBO_V3":
                if not is_ph(val):
                    keys = {o.get("key") for o in (meta or {}).get("options") or []}
                    if keys and val not in keys:
                        errs.append(f"node {nid} input {key}: '{val}' not a "
                                    f"{key} option {sorted(keys)}")
            elif io_type in SCALAR_IO:
                check_scalar(io_type, meta, key, val, errs, warns, nid)
            elif io_type:
                # link-type input carrying a constant — legal only for
                # widget-convertible scalars; placeholders exempt
                if not is_ph(val) and io_type not in WILDCARDS:
                    warns.append(f"node {nid} input {key}: constant {val!r} on "
                                 f"link-type input '{io_type}'")
            else:
                # expanded sub-input whose spec we didn't capture — don't guess
                if is_ph(val) or is_link(val):
                    continue

        for key in sorted(required - set(inputs)):
            errs.append(f"node {nid} ({ct}): required input '{key}' missing")

        # DynamicCombo sub-inputs of a *non-selected* option are invalid —
        # covered by the unknown-input check above since only the selected
        # option's subs register.

    return errs, warns


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--fixtures", default=str(FIXTURE))
    ap.add_argument("--workflows", default=str(WORKFLOWS))
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args()

    fx = json.loads(Path(args.fixtures).read_text())
    nodes = fx.get("nodes", {})
    total_e = total_w = 0
    files = sorted(Path(args.workflows).glob("*.json"))
    report = []
    for f in files:
        errs, warns = validate(f, nodes)
        total_e += len(errs)
        total_w += len(warns)
        for e in errs:
            report.append(f"{f.name}: {e}")
        if not args.quiet:
            tag = "FAIL" if errs else ("warn" if warns else "ok")
            print(f"{f.name:<52} [{tag}] {len(errs)}E/{len(warns)}W")
            for e in errs:
                print(f"    ERROR {e}")
            for w in warns:
                print(f"    warn  {w}")

    print(f"\nschema validation: {len(files)} workflows, {total_e} errors, {total_w} warnings")
    if report:
        print("\nERRORS:")
        for e in report:
            print(f"  {e}")
    return 1 if total_e else 0


if __name__ == "__main__":
    sys.exit(main())
