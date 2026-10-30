#!/usr/bin/env python3
"""reshoot_smoke.py <video.mp4> — drive workflows/reshoot-video.json (or
--graph reshoot-uni3c.json) on the local ComfyUI; collect outputs + the
motion numbers the re-shoot evidence needs.

    reshoot_smoke.py <video> [--moves locked-off] [--steps 4] [--port 8188]
                     [--graph reshoot-video.json] [--comfy-out DIR] [--out DIR]
                     [--control-only] [--anchor src|none] [--da3-res 504]
                     [--strength 1] [--distance 4] [--seed 7]
                     [--app PORT]      # drive the real app: sign-up → upload
                                       # → /api/reshoot/probe → submit → poll
                                       # → fetch output over HTTP
                     [--dump-poses]   # no server — DA3 in this venv

--control-only prunes the substituted graph to the load→DA3→trajectory→rig
chain and muxes the rig's rgb output — the catalog JSON is untouched; the
full sampler never runs. --anchor none replaces the trajectory's anchor
link with "" (the unanchored A/B for the evidence run).

--dump-poses skips the server entirely: DA3-Base loads in THIS venv
(ComfyUI core is consumed at runtime only — the GPL boundary is the import,
nothing is vendored), multiview inference runs on the decoded frames, and
the same camera_da3.geometry_to_poses OF_DA3Poses calls inside the graph
converts the geometry. Prints {src_poses:[...]} — the sign check the
re-shoot evidence needs (a pan source must recover a same-sign pose path).

ComfyUI's output dir is required unless --dump-poses: pass --comfy-out DIR
or set COMFY_OUTPUT_DIR (ComfyUI stores outputs, the script copies them back
out). COMFY_ROOT overrides the ComfyUI checkout for --dump-poses.
"""
import json
import os
import subprocess
import sys
import time
import urllib.request
import urllib.error
import urllib.parse
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent


def ffprobe(file: Path) -> dict:
    meta = json.loads(subprocess.check_output([
        "ffprobe", "-v", "error", "-print_format", "json",
        "-show_format", "-show_streams", "-count_frames", str(file),
    ]))
    v = next(s for s in meta["streams"] if s["codec_type"] == "video")
    rn, rd = (v.get("avg_frame_rate") or "0/1").split("/")
    return {
        "fps": float(rn) / float(rd or 1),
        "frames": int(v.get("nb_read_frames") or v.get("nb_frames") or 0),
        "duration": float(meta["format"]["duration"]),
        "width": int(v["width"]), "height": int(v["height"]),
        "audio": any(s["codec_type"] == "audio" for s in meta["streams"]),
    }


def substitute(obj, vals):
    if isinstance(obj, str):
        if not (obj.startswith("{{") and obj.endswith("}}")):
            return obj
        k = obj[2:-2]
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
    if isinstance(obj, list):
        return [substitute(v, vals) for v in obj]
    if isinstance(obj, dict):
        return {k: substitute(v, vals) for k, v in obj.items()}
    return obj


def control_only(graph: dict, prefix: str) -> dict:
    """Prune the substituted graph to the rig pipeline (VHS load → DA3 →
    poses → trajectory → rig) and mux the rig's rgb to an mp4 — no sampler."""
    keep = {nid: n for nid, n in graph.items()
            if n.get("class_type") in {
                "VHS_LoadVideo", "LoadDA3Model", "OF_DA3Windowed",
                "OF_DA3Poses", "OF_Trajectory", "OF_CameraRig",
                # the matte chain — the rig's subject_mask link must not
                # dangle when the sampler branch is pruned
                "LoadBackgroundRemovalModel", "RemoveBackground"}}
    if not any(n.get("class_type") == "OF_CameraRig" for n in keep.values()):
        raise SystemExit("rig pipeline not found in graph")
    rig_id = next(nid for nid, n in keep.items() if n.get("class_type") == "OF_CameraRig")
    keep["c1"] = {"class_type": "VHS_VideoCombine", "inputs": {
        "images": [rig_id, 0], "frame_rate": 24,
        "loop_count": 0, "filename_prefix": f"{prefix}_rig",
        "format": "video/h264-mp4", "save_output": True, "pingpong": False,
    }}
    # the hole-mask stream too — the disocclusion share is the evidence
    # that says how much of the move VACE has to invent
    keep["m1"] = {"class_type": "MaskToImage", "inputs": {"mask": [rig_id, 1]}}
    keep["c2"] = {"class_type": "VHS_VideoCombine", "inputs": {
        "images": ["m1", 0], "frame_rate": 24,
        "loop_count": 0, "filename_prefix": f"{prefix}_holes",
        "format": "video/h264-mp4", "save_output": True, "pingpong": False,
    }}
    keep["c3"] = {"class_type": "VHS_VideoCombine", "inputs": {
        "images": [rig_id, 2], "frame_rate": 24,
        "loop_count": 0, "filename_prefix": f"{prefix}_ctl",
        "format": "video/h264-mp4", "save_output": True, "pingpong": False,
    }}
    return keep


def upload_video(port: int, file: Path) -> str:
    """POST /upload/image — ComfyUI's generic input uploader (name field is
    'image' regardless of media type). Returns the input-side filename."""
    boundary = "----ofreshoot"
    body = (
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"image\"; "
        f"filename=\"{file.name}\"\r\nContent-Type: video/mp4\r\n\r\n"
    ).encode() + file.read_bytes() + f"\r\n--{boundary}--\r\n".encode()
    req = urllib.request.Request(
        f"http://127.0.0.1:{port}/upload/image", data=body,
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})
    res = json.loads(urllib.request.urlopen(req, timeout=120).read())
    if "name" not in res:
        raise SystemExit(f"upload failed: {res}")
    return res["name"]


def bg_drift(mp4: Path, frames: int = 16) -> list[float]:
    """Per-frame x-drift via phase correlation on downscaled luminance —
    np.fft only, no cv2. Returns cumulative px offsets (frame units of the
    160px-wide proxy)."""
    raw = subprocess.check_output([
        "ffmpeg", "-v", "error", "-i", str(mp4),
        "-vf", "scale=160:90,format=gray", "-f", "rawvideo", "-",
    ])
    w, h = 160, 90
    n = len(raw) // (w * h)
    a = [b for b in (raw[i * w * h:(i + 1) * w * h] for i in range(min(n, frames)))]
    import numpy as np
    frames_np = [np.frombuffer(b, dtype=np.uint8).reshape(h, w).astype(np.float32) for b in a]
    if len(frames_np) < 2:
        return [0.0]
    drifts = [0.0]
    for i in range(1, len(frames_np)):
        fa = np.fft.fft2(frames_np[i - 1]); fb = np.fft.fft2(frames_np[i])
        r = fa * np.conj(fb)
        r /= np.abs(r) + 1e-8
        peak = np.unravel_index(np.argmax(np.abs(np.fft.ifft2(r))), (h, w))
        dy, dx = peak[0], peak[1]
        if dx > w // 2: dx -= w
        drifts.append(drifts[-1] + float(dx))
    return drifts


def contact_sheet(mp4: Path, png: Path) -> None:
    subprocess.run([
        "ffmpeg", "-v", "error", "-y", "-i", str(mp4),
        "-vf", "select='not(mod(n\\,4))',scale=240:-2,tile=4x3",
        "-frames:v", "1", str(png),
    ], check=True)


def app_drive(video: Path, port: int, moves: str, out_dir: Path,
              strength: str, distance: str, steps: str, seed: str) -> None:
    """The real app path — better-auth sign-up (session cookie) →
    /api/uploads → /api/reshoot/probe → /api/reshoot/submit → poll
    /api/jobs/<id> → fetch the output over HTTP. No /prompt direct submit:
    this is the path a user actually takes (GENERATION_PROVIDER=comfy behind
    it — the job still lands on the local ComfyUI)."""
    import http.cookiejar
    jar = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
    base = f"http://127.0.0.1:{port}"

    def post(path, data=None, raw=None, ctype="application/json"):
        body = raw if raw is not None else json.dumps(data).encode()
        req = urllib.request.Request(base + path, data=body,
                                     headers={"Content-Type": ctype})
        return urllib.request.urlopen(req, timeout=120)

    # fresh account — the upload/job rows must belong to this session
    email = f"rs-{int(time.time())}@smoke.test"
    res = post("/api/auth/sign-up/email",
               {"email": email, "password": "smoke-pass-123", "name": "reshoot smoke"})
    assert res.status in (200, 201), res.status

    # upload — /api/uploads takes a 'file' field, returns {url:/files/uploads/…}
    boundary = "----ofreshootapp"
    body = (
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; "
        f"filename=\"{video.name}\"\r\nContent-Type: video/mp4\r\n\r\n"
    ).encode() + video.read_bytes() + f"\r\n--{boundary}--\r\n".encode()
    up = json.loads(post("/api/uploads", raw=body,
                         ctype=f"multipart/form-data; boundary={boundary}").read())
    video_url = up["url"]

    pb = json.loads(post("/api/reshoot/probe", {"video_url": video_url}).read())
    probe = pb["probe"]

    src = ffprobe(video)
    sub = json.loads(post("/api/reshoot/submit", {
        "video_url": video_url, "moves": moves,
        "prompt": "the same action, cinematic",
        "backend": "local",
        "strength": float(strength), "distance": float(distance),
        "steps": int(steps), "seed": int(seed),
    }).read())
    job = sub["job"]
    t0 = time.time()
    while job["status"] in ("queued", "in_progress"):
        time.sleep(3)
        job = json.loads(opener.open(f"{base}/api/jobs/{job['id']}",
                                     timeout=30).read())["job"]
    if job["status"] != "completed":
        print(json.dumps({"moves": moves, "pass": False, "job": job}))
        sys.exit(1)

    out_url = job["outputs"][0]["url"]
    out_dir.mkdir(parents=True, exist_ok=True)
    out_file = out_dir / f"of_rs_app_{moves.replace('+', '_')}.mp4"
    out_file.write_bytes(opener.open(base + out_url, timeout=120).read())

    evidence = {"moves": moves, "via": "app", "video_url": video_url,
                "src": src, "probe": probe, "file": str(out_file),
                "secs": round(time.time() - t0, 1), "pass": True}
    out = ffprobe(out_file)
    evidence["out"] = out
    evidence["frames_match"] = out["frames"] == src["frames"]
    evidence["fps_match"] = abs(out["fps"] - src["fps"]) < 0.01
    # the graph muxes the source audio back on — a silent source still gets
    # a container with a silent track, so the check only bites when the
    # source carried audio
    evidence["audio_kept"] = out["audio"] if src["audio"] else True
    evidence["src_drift_px"] = bg_drift(video)[-1]
    evidence["out_drift_px"] = bg_drift(out_file)[-1]
    sheet = out_dir / "of_rs_app_sheet.png"
    try:
        contact_sheet(out_file, sheet)
        evidence["sheet"] = str(sheet)
    except Exception as e:
        print(f"contact sheet failed: {e}", file=sys.stderr)
    print(json.dumps(evidence))


def dump_poses(video: Path, res: int, fps: float, distance: float,
               ref_view: str = "saddle_balanced", pose_method: str = "cam_dec") -> None:
    """DA3-Base multiview in this venv → the recovered source pose stream
    (the same conversion OF_DA3Poses runs inside the graph)."""
    comfy_root = os.environ.get("COMFY_ROOT", os.path.expanduser("~/comfy/ComfyUI"))
    sys.path.insert(0, comfy_root)
    sys.path.insert(0, str(ROOT / "comfy-nodes"))
    os.chdir(comfy_root)
    import numpy as np
    import torch
    from comfy_extras.nodes_depth_anything_3 import DA3Inference, LoadDA3Model
    from motionfield_nodes.core.camera_da3 import geometry_to_poses

    probe = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=width,height", "-of", "csv=p=0", str(video)],
        capture_output=True, text=True, check=True)
    w, h = (int(x) for x in probe.stdout.strip().split(",")[:2])
    raw = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", str(video),
         "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
        capture_output=True, check=True).stdout
    n = len(raw) // (w * h * 3)
    frames = np.frombuffer(raw[:n * w * h * 3], dtype=np.uint8)
    img = torch.from_numpy(frames.reshape(n, h, w, 3).astype(np.float32) / 255.0)

    model = LoadDA3Model.execute(
        "depth_anything_3_base.safetensors", "default").result[0]
    geometry = DA3Inference._execute_multiview(
        model, img, res, "upper_bound_resize",
        ref_view, pose_method).result[0]
    poses, _depth_m, _n = geometry_to_poses(
        geometry, fps, distance, process_res=res)
    print(json.dumps({"frames": n, "da3_res": res, "src_poses": poses}))


def main() -> None:
    args = sys.argv[1:]
    video = Path(args[0])
    opt = lambda n, d: args[args.index(n) + 1] if n in args else d
    port = int(opt("--port", "8188"))
    app_port = opt("--app", None)
    if app_port is not None:
        app_drive(video, int(app_port), opt("--moves", "locked-off"),
                  Path(opt("--out", "/tmp")), opt("--strength", "1"),
                  opt("--distance", "4"), opt("--steps", "4"),
                  opt("--seed", "7"))
        return
    graph_file = opt("--graph", "reshoot-video.json")
    moves = opt("--moves", "locked-off")
    out_dir = Path(opt("--out", "/tmp"))
    anchor = opt("--anchor", "src")
    if "--dump-poses" in args:
        src = ffprobe(video)
        dump_poses(video, int(opt("--da3-res", "504")), src["fps"],
                   float(opt("--distance", "4")),
                   opt("--ref-view", "saddle_balanced"), opt("--pose-method", "cam_dec"))
        return
    comfy_out_raw = opt("--comfy-out", os.environ.get("COMFY_OUTPUT_DIR", ""))
    if not comfy_out_raw:
        print("reshoot_smoke: ComfyUI's output dir is required — pass --comfy-out DIR "
              "or set COMFY_OUTPUT_DIR", file=sys.stderr)
        sys.exit(2)
    comfy_out = Path(comfy_out_raw)
    control = "--control-only" in args

    src = ffprobe(video)
    if not src["frames"]:
        raise SystemExit("source clip has no readable frame count")
    fps = src["fps"]
    n = src["frames"]
    pad = n + ((4 - ((n - 1) % 4)) % 4)
    r16 = lambda x: max(16, round(x / 16) * 16)
    name = upload_video(port, video)

    vals = {
        "INPUT_VIDEO": name,
        "MOVES": moves,
        "PROMPT": "the same action, cinematic",
        "NEGATIVE": "worst quality, inconsistent motion, blurry, jittery, distorted",
        "STRENGTH": opt("--strength", "1"),
        "DISTANCE": opt("--distance", "4"),
        "DURATION": f"{(n - 1) / fps:.6f}",
        "WIDTH": str(r16(src["width"])), "HEIGHT": str(r16(src["height"])),
        "FPS": f"{fps:.6f}", "FRAMES": str(n), "PAD_FRAMES": str(pad),
        "DA3_RES": opt("--da3-res", "504"),
        "SEED": opt("--seed", "7"), "STEPS": opt("--steps", "4"),
        "PREFIX": f"of_rs_{moves.replace('+', '_')}_{anchor}_{'ctl' if control else 'full'}",
    }
    if anchor == "none":
        vals["_ANCHOR_NONE"] = "1"
    prefix = vals["PREFIX"]

    graph = substitute(json.loads((ROOT / "workflows" / graph_file).read_text()), vals)
    graph.pop("_meta", None)
    if anchor == "none":
        for nid, node in graph.items():
            if node.get("class_type") == "OF_Trajectory":
                node["inputs"]["anchor"] = ""
    if control:
        # mux the rig rgb at the SOURCE rate — honest frame-exact evidence
        rig_fps = float(fps)
        graph = control_only(graph, prefix)
        graph["c1"]["inputs"]["frame_rate"] = rig_fps

    body = json.dumps({"prompt": graph, "client_id": "reshoot-smoke"}).encode()
    req = urllib.request.Request(f"http://127.0.0.1:{port}/prompt", data=body,
                                 headers={"Content-Type": "application/json"})
    t0 = time.time()
    try:
        pid = json.loads(urllib.request.urlopen(req, timeout=30).read())["prompt_id"]
    except urllib.error.HTTPError as e:
        print(e.read().decode(), file=sys.stderr)
        sys.exit(1)
    print(f"submitted {moves} {'(control-only)' if control else ''} anchor={anchor} → {pid}", flush=True)
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
             if k in ("gifs", "videos", "images") for v in vs]
    if not files:
        print(json.dumps({"moves": moves, "pass": False, "err": "no outputs"}))
        sys.exit(1)
    out_dir.mkdir(parents=True, exist_ok=True)
    copied = []
    for i, p in enumerate(files):
        srcf = comfy_out / (p.get("subfolder") or "") / p["filename"]
        suffix = Path(p["filename"]).suffix or ".png"
        name2 = p["filename"] if len(files) == 1 else f"{prefix}_{i}_{p['filename']}"
        if len(files) == 1:
            name2 = f"{prefix}{suffix}"
        dst = out_dir / name2
        dst.write_bytes(srcf.read_bytes())
        copied.append(str(dst))
    main_file = copied[0]

    evidence = {"moves": moves, "control_only": control, "anchor": anchor,
                "src": src, "file": main_file, "files": copied,
                "secs": round(time.time() - t0, 1), "pass": True}
    if main_file.lower().endswith((".mp4", ".webm", ".mov")):
        out = ffprobe(Path(main_file))
        evidence["out"] = out
        evidence["frames_match"] = out["frames"] == n
        evidence["fps_match"] = abs(out["fps"] - fps) < 0.01
        # see app_drive: the mux now puts the source track back on
        evidence["audio_kept"] = out["audio"] if src["audio"] else True
        evidence["src_drift_px"] = bg_drift(video)[-1]
        evidence["out_drift_px"] = bg_drift(Path(main_file))[-1]
        sheet = out_dir / f"{prefix}_sheet.png"
        try:
            contact_sheet(Path(main_file), sheet)
            evidence["sheet"] = str(sheet)
        except Exception as e:
            print(f"contact sheet failed: {e}", file=sys.stderr)
    print(json.dumps(evidence))


if __name__ == "__main__":
    main()
