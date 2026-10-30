"""Motion checks for rendered clips — prove the video actually moved the way
its trajectory label claims. numpy + ffmpeg only.

Usage (run through the ComfyUI venv interpreter, -I is fine):
    motion_check.py <video.mp4> dolly-in      # centre-crop scale grows ≥1.1×
    motion_check.py <video.mp4> dolly-out     # centre-crop scale shrinks ≤0.9
    motion_check.py <video.mp4> truck-left    # bg slides right (sign check)
    motion_check.py <video.mp4> crane-up      # bg sinks under the lock (sign)
    motion_check.py <video.mp4> arc-left-45 [--strength S] [--ref CONTROL]
                                              # bg parallaxes vs a locked
                                              #   centre, ≥25% of the reference
                       [--frames all]         # score every frame against
                                              #   frame 0 (default: first 8)
    motion_check.py <video.mp4> pan-left      # bg slides right
    motion_check.py --selftest                # OF_CameraRig on a synthetic
                                              #   fronto-parallel plane (CPU)

Flags:
    --strength S   move strength (reference scaling)
    --ref PATH     reference drift measured on THAT run's own control frames
                   (a control.mp4, a directory of PNGs, a glob, or one image).
                   Without it the reference is the CPU rig's synthetic
                   two-plane scene — both numbers print either way.
    --holes PATH   per-frame hole share for a saved holes sequence/video.
"""
import glob as _glob
import json
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np

# -I-safe path wiring: comfy-nodes/ for the pack, this dir for sibling modules
_TESTS = Path(__file__).resolve().parent
for _p in (str(_TESTS.parent), str(_TESTS)):
    if _p not in sys.path:
        sys.path.insert(0, _p)


# ------------------------------------------------------------------ frames


def read_video(path, max_frames=64):
    """mp4 → (n, h, w, 3) float64 frames decoded through ffmpeg rawvideo."""
    probe = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=width,height", "-of", "csv=p=0", path],
        capture_output=True, text=True, check=True)
    w, h = (int(x) for x in probe.stdout.strip().split(",")[:2])
    raw = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", path, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
        capture_output=True, check=True).stdout
    n = len(raw) // (w * h * 3)
    frames = np.frombuffer(raw[:n * w * h * 3], dtype=np.uint8)
    frames = frames.reshape(n, h, w, 3).astype(np.float64) / 255.0
    return frames[:max_frames]


def read_frames(src, max_frames=64):
    """A video file OR an image sequence (directory / glob / single image)
    → (n, h, w, 3) float64 frames. The control runs save per-frame PNGs. """
    p = Path(src)
    if p.is_file() and p.suffix.lower() in (".mp4", ".webm", ".mov", ".mkv"):
        return read_video(src, max_frames)
    if p.is_dir():
        pat = str(p / "*.png")
    elif "*" in str(src):
        pat = str(src)
    elif p.is_file() and p.suffix.lower() in (".png", ".jpg", ".jpeg"):
        pat = str(p)
    else:
        raise SystemExit(f"don't know how to read frames from {src}")
    first = sorted(_glob.glob(pat)) if "*" in pat else [pat]
    if not first:
        raise SystemExit(f"no frames match {pat}")
    probe = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=width,height", "-of", "csv=p=0", first[0]],
        capture_output=True, text=True, check=True)
    w, h = (int(x) for x in probe.stdout.strip().split(",")[:2])
    inputs = (["-f", "image2", "-pattern_type", "glob", "-i", pat]
              if "*" in pat else ["-loop", "1", "-i", pat])
    raw = subprocess.run(
        ["ffmpeg", "-v", "error", *inputs, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
        capture_output=True, check=True).stdout
    n = len(raw) // (w * h * 3)
    frames = np.frombuffer(raw[:n * w * h * 3], dtype=np.uint8)
    frames = frames.reshape(n, h, w, 3).astype(np.float64) / 255.0
    return frames[:max_frames]


def hole_percents(src, max_frames=64):
    """per-frame hole share of a saved holes sequence (white mask on black)."""
    frames = read_frames(src, max_frames)
    return [float(np.mean(np.max(f, axis=-1) > 0.5)) for f in frames]


def _norm_corr(a, b):
    a = a.ravel() - a.mean()
    b = b.ravel() - b.mean()
    d = np.linalg.norm(a) * np.linalg.norm(b)
    return float(np.dot(a, b) / d) if d > 0 else -1.0


def _resize(a, w, h):
    """bilinear (H,W[,C]) resize — local copy of camera_rig's helper so the
    checker runs without importing the pack."""
    ih, iw = a.shape[:2]
    if (iw, ih) == (w, h):
        return a.astype(np.float64)
    a = a.astype(np.float64)
    ys = np.clip((np.arange(h) + 0.5) * ih / h - 0.5, 0, ih - 1)
    xs = np.clip((np.arange(w) + 0.5) * iw / w - 0.5, 0, iw - 1)
    y0, x0 = np.floor(ys).astype(np.int64), np.floor(xs).astype(np.int64)
    y1, x1 = np.clip(y0 + 1, 0, ih - 1), np.clip(x0 + 1, 0, iw - 1)
    wy = (ys - y0)[:, None]
    wx = (xs - x0)[None, :]
    if a.ndim == 3:
        wy = wy[..., None]
        wx = wx[..., None]
    return ((a[y0][:, x0] * (1 - wx) + a[y0][:, x1] * wx) * (1 - wy)
            + (a[y1][:, x0] * (1 - wx) + a[y1][:, x1] * wx) * wy)


def scale_match(f0, f1):
    """Multi-scale match: zoom factor that best maps f0's centre patch onto
    f1's centre. Returns (scale, correlation)."""
    h, w = f0.shape[:2]
    ch, cw = max(8, int(0.3 * h)), max(8, int(0.3 * w))
    p0 = f0[h // 2 - ch // 2:h // 2 + ch // 2, w // 2 - cw // 2:w // 2 + cw // 2]
    best_s, best_c = 1.0, -1.0
    for s in np.linspace(0.6, 2.6, 81):
        sc = _resize(p0, int(round(cw * s)), int(round(ch * s)))
        if sc.shape[0] > h or sc.shape[1] > w:
            continue
        y0, x0 = (h - sc.shape[0]) // 2, (w - sc.shape[1]) // 2
        c = _norm_corr(sc, f1[y0:y0 + sc.shape[0], x0:x0 + sc.shape[1]])
        if c > best_c:
            best_c, best_s = c, float(s)
    return best_s, best_c


def scale_match_grid(f0, f1):
    """Zoom estimate for horizon/rule-of-thirds scenes where the 30% centre
    patch lands on far sea/sky: take each 40% patch on a 3x3 grid as a
    template, and for candidate scales resize it and correlate it against f1
    at the patch's own centre (a dolly grows near content in place, it does
    not re-centre it). Returns (scale, corr, centre) of the best-correlated
    anchor patch."""
    h, w = f0.shape[:2]
    ph, pw = int(0.4 * h), int(0.4 * w)
    rows = []
    for fy in (0.0, 0.5, 1.0):
        for fx in (0.0, 0.5, 1.0):
            y0, x0 = int(fy * (h - ph)), int(fx * (w - pw))
            p0 = f0[y0:y0 + ph, x0:x0 + pw]
            cy, cx = y0 + ph // 2, x0 + pw // 2
            energy = float(np.abs(np.gradient(p0)).mean())
            best_s, best_c = 1.0, -1.0
            for s in np.linspace(0.6, 2.6, 81):
                sh, sw = int(round(ph * s)), int(round(pw * s))
                ty, tx = cy - sh // 2, cx - sw // 2
                if ty < 0 or tx < 0 or ty + sh > h or tx + sw > w:
                    continue
                c = _norm_corr(_resize(p0, sw, sh),
                               f1[ty:ty + sh, tx:tx + sw])
                if c > best_c:
                    best_c, best_s = c, float(s)
            rows.append((best_s, best_c, (cx, cy), energy))
    # a dolly's signature is differential zoom: near patches grow, far
    # patches sit at ~1.0 with trivially high corr. Report the largest
    # confident zoom; fall back to the best-correlated patch.
    conf = [r for r in rows if r[1] >= 0.4]
    s, c, xy, _e = max(conf or rows, key=lambda r: r[0])
    return (s, c, xy)


def phase_shift(a, b):
    """2-D phase correlation: returns the offset that aligns b onto a —
    b's content having slid +dx on screen reports as -dx here (verified:
    np.roll(a, +7, axis=1) reads dx=-7). So a negative return means the
    background moved RIGHT; positive means it moved LEFT."""
    fa = np.fft.fft2(a)
    fb = np.fft.fft2(b)
    r = fa * np.conj(fb)
    r /= np.abs(r) + 1e-12
    pk = np.unravel_index(np.argmax(np.abs(np.fft.ifft2(r))), a.shape)
    dy, dx = pk
    if dy > a.shape[0] // 2:
        dy -= a.shape[0]
    if dx > a.shape[1] // 2:
        dx -= a.shape[1]
    return float(dx), float(dy)


# ------------------------------------------------------------------ checks


def check_dolly_in(frames, **_kw):
    """Dolly zoom between first and last frame ≥ 1.1. Reports both the
    dead-centre 30% patch estimate and the grid-anchored estimate (for
    horizon/rule-of-thirds scenes where the centre lands on far sea/sky);
    pass uses the grid anchor, which keys on near content."""
    s, c = scale_match(frames[0], frames[-1])
    gs, gc, gxy = scale_match_grid(frames[0], frames[-1])
    return {"move": "dolly-in", "scale": gs, "corr": round(gc, 4),
            "patch": gxy, "centre_scale": s, "centre_corr": round(c, 4),
            "pass": bool(gs >= 1.1 and gc > 0.15)}


def _band_dx(f0, f1, bands=5):
    """Gradient-weighted mean horizontal drift of the frame: split it into
    `bands` full-width horizontal strips, phase-correlate each, and weight by
    frame0's mean |dI/dx| — a textureless band (flat sky, dead pixels)
    contributes ~nothing instead of voting with noise. Full-width strips keep
    phase correlation unaliased up to ±w/2 px, which the early arc frames
    stay under."""
    h = f0.shape[0]
    acc = wsum = 0.0
    for i in range(bands):
        y0, y1 = i * h // bands, (i + 1) * h // bands
        t0, t1 = f0[y0:y1, :, 0], f1[y0:y1, :, 0]
        w = float(np.abs(np.gradient(t0, axis=1)).mean())
        dx, _ = phase_shift(t0, t1)
        acc += w * dx
        wsum += w
    return acc / wsum if wsum > 1e-9 else 0.0


def _band_dy(f0, f1, bands=5):
    """Vertical sibling of _band_dx: `bands` full-height column strips,
    phase-correlated for dy, weighted by frame0's mean |dI/dy|. Full-height
    strips keep phase correlation unaliased for the ±h/2 px range a crane
    sweep spans — a short top band aliases once the drift exceeds it."""
    w = f0.shape[1]
    acc = wsum = 0.0
    for i in range(bands):
        x0, x1 = i * w // bands, (i + 1) * w // bands
        t0, t1 = f0[:, x0:x1, 0], f1[:, x0:x1, 0]
        wt = float(np.abs(np.gradient(t0, axis=0)).mean())
        _, dy = phase_shift(t0, t1)
        acc += wt * dy
        wsum += wt
    return acc / wsum if wsum > 1e-9 else 0.0


def _centre_dx(f0, f1):
    """Subject drift — phase correlation on the central 30%w × 45%h patch.
    On an aimed orbit the pose stream pins the subject to frame centre, so
    this is the lock the check gates on."""
    h, w = f0.shape[:2]
    y0, y1, x0, x1 = int(0.3 * h), int(0.75 * h), int(0.35 * w), int(0.65 * w)
    dx, _ = phase_shift(f0[y0:y1, x0:x1, 0], f1[y0:y1, x0:x1, 0])
    return dx


def rel_bg_dx(frames, i):
    """(centre dx, background dx) at frame i — the orbit's parallax is
    background-vs-subject, so the centre patch's drift is the reference."""
    return _centre_dx(frames[0], frames[i]), _band_dx(frames[0], frames[i])


def rig_relative_dx(w, h, n, moves, strength=1.0, distance=4.0, fov=40.0, seed=7, last=None):
    """The same poses rendered by OF_CameraRig on a two-plane scene (subject
    block at `distance`, far plane at 20 m) — CPU numpy, no GPU. Returns the
    mean background-vs-centre drift the move *should* produce on screen, in
    px at (w, h), over the same window check_arc_left measures (frames 1–8,
    or the whole clip when `last` is set)."""
    from motionfield_nodes.core import camera_rig as rig
    from motionfield_nodes.core import camera_trajectory as cam

    rng = np.random.default_rng(11)
    img = rng.random((h, w, 3))
    depth = np.full((h, w), 20.0)
    depth[int(0.3 * h):int(0.75 * h), int(0.35 * w):int(0.65 * w)] = float(distance)
    spec = {"moves": list(moves), "strength": strength, "duration": (n - 1) / 16.0,
            "fps": 16.0, "seed": seed, "distance": distance, "fov": fov}
    poses = cam.compose_trajectory(spec)["frames"][:n]
    frames, _holes, _ctl = rig.render(img, depth, poses, out_size=(w, h))
    rframes = np.asarray(frames)
    upto = last if last is not None else 8
    rel = []
    for i in range(1, min(upto, len(rframes) - 1) + 1):
        cx, bg = rel_bg_dx(rframes, i)
        rel.append(bg - cx)
    return float(np.mean(rel)) if rel else 0.0


def check_arc_left(frames, strength=1.0, ref_frames=None, all_frames=False, **_kw):
    """arc-left-45: the camera orbits left around the subject — the subject
    must stay put (mean |centre dx| ≤ 4 px over frames 1–8, or the whole clip
    with --frames all) while the background parallaxes past it by ≥25% of the
    reference drift. With --ref the reference is measured on that run's OWN
    control frames (real DA3 depth); without it the CPU rig's synthetic
    two-plane scene supplies it — both numbers always print. A flat +dx on a
    textureless sky band no longer counts — band weight is frame0's gradient,
    and the centre patch's drift is subtracted, so global VACE wander cancels
    out. --frames all keeps the SAME matching (every frame vs frame 0) but
    spans the whole clip, and the reference is measured over that window too."""
    h, w = frames.shape[1:3]
    last = (len(frames) - 1) if all_frames else min(8, len(frames) - 1)
    cx_all, rel_all = [], []
    for i in range(1, last + 1):
        cx, bg = rel_bg_dx(frames, i)
        cx_all.append(cx)
        rel_all.append(bg - cx)
    centre = float(np.mean(np.abs(cx_all)))
    centre_max = float(np.max(np.abs(cx_all))) if cx_all else 0.0
    rel = float(np.mean(rel_all))
    rig = rig_relative_dx(w, h, len(frames), ["arc-left-45"], strength=strength,
                          last=last)
    ref = None
    if ref_frames is not None and len(ref_frames) > 1:
        vals = [rel_bg_dx(ref_frames, i)
                for i in range(1, min(last, len(ref_frames) - 1) + 1)]
        ref = float(np.mean([bg - cx for cx, bg in vals])) if vals else 0.0
    bench = ref if ref is not None else rig
    # magnitude vs the reference; with --ref the render must also drift the
    # SAME direction the control did (the synthetic ref's sign isn't portable
    # across scenes — it only anchors magnitude).
    same_dir = rel * bench > 0
    # centre lock ≤4 px of mean drift — the aim point is pixel-exact, but the
    # patch measures content: an orbited subject shows its side, so a flat
    # silhouette slides a few px inside the window while staying locked.
    ok = (centre <= 4.0 and abs(rel) >= 0.25 * abs(bench) and abs(bench) > 1.0
          and (same_dir or ref is None))
    out = {"move": "arc-left-45", "strength": strength, "frames_scored": last,
           "centre_dx_px": round(centre, 3), "centre_dx_max": round(centre_max, 3),
           "rel_bg_dx_px": round(rel, 3),
           "rig_dx_px": round(rig, 3), "pass": bool(ok)}
    if ref is not None:
        out["ref_dx_px"] = round(ref, 3)
        out["same_dir"] = bool(same_dir)
    return out


def check_pan_left(frames, **_kw):
    """pan-left: the camera yaws left — bg slides right on screen, which
    phase_shift reports as negative dx."""
    band = max(8, frames.shape[1] // 4)
    dxs = []
    for i in range(1, len(frames) // 2 + 1):
        dx, _ = phase_shift(frames[0, :band, :, 0], frames[i, :band, :, 0])
        dxs.append(dx)
    v = float(np.mean(dxs))
    return {"move": "pan-left", "bg_dx_px": round(v, 3), "pass": bool(v < -1.0)}


def check_truck_left(frames, **_kw):
    """truck-left: camera slides −x without re-aiming — the whole scene,
    background dominated, slides RIGHT on screen → mean band dx < −1 px.
    (Same drift signature as pan-left; this checks direction, not the lever.)"""
    v = float(np.mean([_band_dx(frames[0], frames[i])
                       for i in range(1, min(8, len(frames)))]))
    return {"move": "truck-left", "bg_dx_px": round(v, 3),
            "pass": bool(v < -1.0)}


def check_crane_up(frames, **_kw):
    """crane-up: camera rises and re-aims at the subject — the centre holds
    while the far background RISES in frame (smaller screen y), which
    phase_shift reports as positive dy. Mean band dy > +1 px wins."""
    v = float(np.mean([_band_dy(frames[0], frames[i])
                       for i in range(1, min(8, len(frames)))]))
    return {"move": "crane-up", "bg_dy_px": round(v, 3),
            "pass": bool(v > 1.0)}


def check_dolly_out(frames, **_kw):
    """dolly-out: the camera pulls back — the whole frame contracts toward
    its centre, the inverse homothety of dolly-in. scale_match sweeps <1;
    ≤0.9 wins (a locked-off render reads ~1.0 and fails)."""
    s, c = scale_match(frames[0], frames[-1])
    return {"move": "dolly-out", "scale": s, "corr": round(c, 4),
            "pass": bool(s <= 0.9 and c > 0.15)}


# camera_dx → expected on-screen background drift (sign of phase-shift dx)
CHECKS = {
    "dolly-in": check_dolly_in,
    "dolly-in-mid": check_dolly_in,
    "dolly-out": check_dolly_out,
    "arc-left-45": check_arc_left,
    "pan-left": check_pan_left,
    "truck-left": check_truck_left,
    "crane-up": check_crane_up,
}


# ------------------------------------------------------- rig CPU selftest


def rig_selftest(w=160, h=90, distance=4.0):
    """OF_CameraRig on a synthetic textured fronto-parallel plane at
    z=distance — no model, no GPU:
      * dolly-in grows the centre crop ≥1.1× (scale_match)
      * a locked-off pose leaves an empty hole mask (2 px border excluded)
    """
    from motionfield_nodes.core import camera_rig as rig
    from motionfield_nodes.core import camera_trajectory as cam

    rng = np.random.default_rng(7)
    img = rng.random((h, w, 3))
    depth = np.full((h, w), float(distance))
    spec = {"moves": ["dolly-in"], "duration": 1.0, "fps": 16.0, "seed": 3,
            "distance": distance, "fov": 40.0}
    poses = cam.compose_trajectory(spec)["frames"]
    frames, holes, _ctl = rig.render(img, depth, poses)
    s, c = scale_match(np.asarray(frames[0]), np.asarray(frames[-1]))
    zero = cam.compose_trajectory({**spec, "moves": ["locked-off"]})["frames"]
    _f, holes0, _ = rig.render(img, depth, zero)
    interior = holes0[0][2:-2, 2:-2]
    return {"dolly_scale": round(s, 4), "dolly_corr": round(c, 4),
            "locked_hole_frac": float(interior.mean()), "frames": len(frames),
            "pass": bool(s >= 1.1 and interior.mean() < 1e-6)}


def main():
    args = sys.argv[1:]
    if args and args[0] == "--selftest":
        print(json.dumps(rig_selftest()))
        return
    if len(args) < 2 or args[1] not in CHECKS:
        raise SystemExit(f"usage: motion_check.py <video.mp4> {'|'.join(CHECKS)} [--strength 1.0] [--ref CONTROL] [--holes SEQ] [--frames all] | --selftest")
    kw = {}
    if "--strength" in args:
        kw["strength"] = float(args[args.index("--strength") + 1])
    if "--frames" in args:
        if args[args.index("--frames") + 1] != "all":
            raise SystemExit("--frames only takes 'all'")
        kw["all_frames"] = True
    frames = read_frames(args[0])  # video file, dir, glob, or single image
    if "--ref" in args:
        kw["ref_frames"] = read_frames(args[args.index("--ref") + 1])
    check = CHECKS[args[1]](frames, **kw)
    if "--holes" in args:
        check["holes_pct"] = [round(100 * x, 1)
                              for x in hole_percents(args[args.index("--holes") + 1])]
    print(json.dumps(check))
    sys.stdout.flush()
    # os._exit: a teardown segfault seen after the report must not corrupt
    # the check's exit code for scripted callers
    import os
    os._exit(0 if check["pass"] else 1)


if __name__ == "__main__":
    main()
