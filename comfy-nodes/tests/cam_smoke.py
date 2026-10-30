#!/usr/bin/env python3
"""cam-i2v GPU smoke — submit the catalog's camera graph to a live ComfyUI
with a trajectory stack and report the produced video.

  cam_smoke.py <moves> [--secs 1-5] [--steps 8] [--strength 1] [--image cam_start.png]
                       [--out /tmp] [--port 8188] [--graph cam-i2v.json]
                       [--comfy-out DIR] [--save-control] [--set KEY=VAL]...

Fills the workflow's {{PLACEHOLDER}}s the same way comfy.ts does (MOVES,
CAM_*, media refs), POSTs /prompt, polls /history, then prints a JSON line
with the output file path and elapsed seconds so the caller can feed it to
motion_check.py. --graph swaps the workflow file (baseline comparisons);
--set overrides/adds any placeholder (e.g. WIDTH/HEIGHT/FRAMES/PREFIX).

ComfyUI's output dir is required: pass --comfy-out DIR or set
COMFY_OUTPUT_DIR (there is no default — a machine-specific path baked into
the script would silently break elsewhere; missing it exits 2).
--save-control replaces the graph IN MEMORY with just the control
pipeline (LoadImage→DA3→OF_Trajectory→OF_CameraRig + SaveImage on the rgb,
holes and control outputs) — no sampler, no model; the shipped catalog JSON
is never touched. Every run also writes a <prefix>_sheet.png contact sheet
(one tile per sampled frame) next to the mp4.
"""
import json, os, subprocess, sys, time, urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent

# the control pipeline inside cam-i2v.json / director-wan.json: start frame
# → depth → rig (OF_DirectorRig is the director lane's splat variant)
CONTROL_NODES = {
    "6": "LoadImage", "7": "OF_Trajectory",
    "8": "LoadDA3Model", "9": "DA3Inference", "10": "DA3Render",
    "11": ("OF_CameraRig", "OF_DirectorRig"),
}


def substitute(graph: dict, vals: dict) -> dict:
    def walk(v):
        if isinstance(v, str) and v.startswith("{{") and v.endswith("}}"):
            k = v[2:-2]
            if k not in vals:
                raise SystemExit(f"missing placeholder {k}")
            x = vals[k]
            if isinstance(x, str):
                try:
                    return int(x)
                except ValueError:
                    try:
                        return float(x)
                    except ValueError:
                        return x
            return x
        if isinstance(v, list):
            return [walk(x) for x in v]
        if isinstance(v, dict):
            return {k: walk(x) for k, x in v.items()}
        return v
    return {k: walk(v) for k, v in graph.items()}


def control_only(graph: dict, prefix: str) -> dict:
    """Prune the substituted graph to the rig's control pipeline and append
    savers for its three outputs — the catalog JSON on disk is untouched."""
    keep = {nid: n for nid, n in graph.items()
            if n.get("class_type") in (
                CONTROL_NODES[nid] if isinstance(CONTROL_NODES.get(nid), tuple)
                else (CONTROL_NODES.get(nid),))}
    if set(keep) != set(CONTROL_NODES):
        raise SystemExit(f"control pipeline not found in graph (got {sorted(keep)})")
    keep["c1"] = {"class_type": "MaskToImage", "inputs": {"mask": ["11", 1]}}
    for nid, out_i, suffix in (
        ("c2", 1, "holes"), ("c3", 0, "rgb"), ("c4", 2, "control"),
    ):
        keep[nid] = {"class_type": "SaveImage", "inputs": {
            "filename_prefix": f"{prefix}_{suffix}",
            "images": ["c1", 0] if nid == "c2" else ["11", out_i],
        }}
    return keep


def contact_sheet(mp4: Path, png: Path) -> None:
    """One PNG row-per-shot grid: ~12 tiles, 4 per row, via the host ffmpeg."""
    subprocess.run([
        "ffmpeg", "-v", "error", "-y", "-i", str(mp4),
        "-vf", "select='not(mod(n\\,4))',scale=240:-2,tile=4x3",
        "-frames:v", "1", str(png),
    ], check=True)


def main() -> None:
    args = sys.argv[1:]
    moves = args[0] if args else "dolly-in"
    opt = lambda n, d: args[args.index(n) + 1] if n in args else d
    secs = int(opt("--secs", "1"))
    if not 1 <= secs <= 5:
        raise SystemExit("--secs must be 1-5")
    steps = int(opt("--steps", "8"))
    image = opt("--image", "cam_start.png")
    out_dir = Path(opt("--out", "/tmp"))
    port = int(opt("--port", "8188"))
    graph_file = opt("--graph", "cam-i2v.json")
    comfy_out_raw = opt("--comfy-out", os.environ.get("COMFY_OUTPUT_DIR", ""))
    if not comfy_out_raw:
        print("cam_smoke: ComfyUI's output dir is required — pass --comfy-out DIR "
              "or set COMFY_OUTPUT_DIR", file=sys.stderr)
        sys.exit(2)
    comfy_out = Path(comfy_out_raw)
    save_control = "--save-control" in args

    vals = {
        "INPUT_IMAGE": image,
        "MOVES": moves,
        "PROMPT": "a lone figure standing in a field at golden hour, cinematic",
        "NEGATIVE": "worst quality, inconsistent motion, blurry, jittery",
        "DURATION": str(secs),
        "STRENGTH": opt("--strength", "1"),
        "DISTANCE": "4",
        "FOV": "40",
        "CAM_W": "480", "CAM_H": "272",
        "CAM_FRAMES": str(secs * 16 + 1),
        "SEED": "7", "STEPS": str(steps), "FPS": "16", "CAM_SCALE": "1",
        "PREFIX": f"of_cam_{moves.replace('+', '_')}",
    }
    while "--set" in args:
        i = args.index("--set")
        k, v = args[i + 1].split("=", 1)
        vals[k] = v
        del args[i:i + 2]
    prefix = vals["PREFIX"]
    graph = substitute(json.loads((ROOT / "workflows" / graph_file).read_text()), vals)
    graph.pop("_meta", None)
    if save_control:
        graph = control_only(graph, prefix)
    body = json.dumps({"prompt": graph, "client_id": "cam-smoke"}).encode()
    req = urllib.request.Request(f"http://127.0.0.1:{port}/prompt", data=body,
                                 headers={"Content-Type": "application/json"})
    t0 = time.time()
    try:
        pid = json.loads(urllib.request.urlopen(req, timeout=30).read())["prompt_id"]
    except urllib.error.HTTPError as e:
        print(e.read().decode(), file=sys.stderr)
        sys.exit(1)
    print(f"submitted {moves}{' (control-only)' if save_control else ''} → {pid}", flush=True)
    while True:
        h = json.loads(urllib.request.urlopen(
            f"http://127.0.0.1:{port}/history/{pid}", timeout=30).read())
        if pid in h:
            break
        time.sleep(3)
    hist = h[pid]
    st = hist.get("status", {})
    if st.get("status_str") == "error" or not hist.get("outputs"):
        print(json.dumps({"moves": moves, "pass": False, "status": st}))
        sys.exit(1)
    files = [v for out in hist["outputs"].values() for k, vs in out.items()
             if k == "gifs" for v in vs]
    if not files:
        files = [v for out in hist["outputs"].values() for v in
                 out.get("videos", [])]
    if not files:
        files = [v for out in hist["outputs"].values() for v in
                 out.get("images", [])]
    out_dir.mkdir(parents=True, exist_ok=True)
    copied = []
    for i, p in enumerate(files):
        src = comfy_out / (p.get("subfolder") or "") / p["filename"]
        suffix = Path(p["filename"]).suffix or ".png"
        name = p["filename"] if len(files) > 1 else f"{prefix}{suffix}"
        if len(files) > 1:
            name = f"{prefix}_{i}_{p['filename']}"
        dst = out_dir / name
        dst.write_bytes(src.read_bytes())
        copied.append(str(dst))
    main_file = copied[0]
    sheet = None
    if main_file.lower().endswith((".mp4", ".webm", ".mov")):
        sheet = out_dir / f"{prefix}_sheet.png"
        try:
            contact_sheet(Path(main_file), sheet)
        except Exception as e:
            print(f"contact sheet failed: {e}", file=sys.stderr)
            sheet = None
    print(json.dumps({"moves": moves, "file": main_file, "files": copied,
                      "sheet": str(sheet) if sheet else None,
                      "control_only": save_control,
                      "secs": round(time.time() - t0, 1), "pass": True}))


if __name__ == "__main__":
    main()
