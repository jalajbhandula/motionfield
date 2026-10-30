"""Re-shoot path — DA3 geometry decode, trajectory anchoring, and the
video-mode rig pass, all CPU-verified against an analytic scene.

The synthetic "source clip" is an infinite textured plane at z=D shot by a
camera that pans right: per-pixel depth and hit-point colour have closed
forms, so the recovered render can be compared numerically — the S2 smoke
asserts the same numbers on real DA3 output.

Run via comfy-nodes/tests/run.py.
"""
import json
import math

import numpy as np

from motionfield_nodes.core import camera_da3 as da3
from motionfield_nodes.core import camera_rig as rig
from motionfield_nodes.core import camera_splat as splat
from motionfield_nodes.core import camera_trajectory as cam

DEG = math.pi / 180.0
W, H, FOV, D = 160, 90, 40.0, 4.0
N = 9


def test_no_dead_processing_dims():
    # the processing dims are DA3's own (the recovered K carries them — see
    # geometry_to_poses); this module must not reimplement the resize. Keep
    # the helper deleted — a second copy drifted out of sync once already.
    assert not hasattr(da3, "processing_dims")


def test_basis_to_pose_roundtrip():
    rng = np.random.default_rng(3)
    for _ in range(20):
        p = {"pos": list(rng.normal(0, 2, 3)), "yaw": float(rng.uniform(-170, 170)),
             "pitch": float(rng.uniform(-80, 80)), "roll": float(rng.uniform(-40, 40)),
             "fov": float(rng.uniform(15, 120))}
        b = splat.rotation(p)
        q = da3.basis_to_pose(b[0], b[1], b[2], p["pos"], 0.0, p["fov"])
        for k in ("yaw", "pitch", "roll"):
            assert abs(q[k] - p[k]) < 1e-6, (k, q[k], p[k])
        assert np.allclose(q["pos"], p["pos"]) and abs(q["fov"] - p["fov"]) < 1e-9


def _pose_of(pos=(0, 0, 0), yaw=0.0, pitch=0.0, roll=0.0, fov=FOV):
    return {"t": 0.0, "pos": list(pos), "yaw": yaw, "pitch": pitch,
            "roll": roll, "fov": fov}


def _da3_geometry(poses, img_shape=(H, W), depth_val=D, fov=FOV, res=504):
    """Build a DA3_GEOMETRY dict from OUR pose list — extrinsics are the
    OpenCV world-to-camera [R|t], intrinsics the processing-dim K (computed
    here: longest side → res, dims rounded to a multiple of DA3's 14-px
    patch)."""
    s = len(poses)
    h_src, w_src = img_shape
    scale = res / float(max(h_src, w_src))
    ph = max(14, int(round(h_src * scale / 14)) * 14)
    pw = max(14, int(round(w_src * scale / 14)) * 14)
    ext = np.zeros((1, s, 3, 4))
    intr = np.zeros((1, s, 3, 3))
    flip = np.diag([1.0, -1.0, 1.0])
    for i, p in enumerate(poses):
        B = np.stack(splat.rotation(p))          # rows: our axes in world
        # a REAL w2c is a proper rotation: ours→OpenCV conjugates both
        # frames by the y flip — flip·B·flip (det +1). flip·B alone is a
        # reflection, not a w2c any estimator could emit.
        R_cv = flip @ B @ flip
        c_cv = flip @ np.asarray(p["pos"], dtype=np.float64)
        ext[0, i] = np.concatenate([R_cv, (-R_cv @ c_cv)[:, None]], axis=1)
        f = (pw / 2.0) / math.tan(p["fov"] * DEG / 2.0)
        intr[0, i] = [[f, 0, pw / 2.0], [0, f, ph / 2.0], [0, 0, 1]]
    return {"mode": "multiview",
            "depth": np.full((s, h_src, w_src), depth_val, np.float64),
            "image": np.zeros((s, h_src, w_src, 3)),
            "extrinsics": ext, "intrinsics": intr}


def test_geometry_to_poses_recovers_motion():
    # a source camera that pans right (yaw increasing) — DA3 reports w2c;
    # recovered poses must carry the same positive yaw sweep (sign check)
    degs = np.linspace(0.0, 12.0, N)
    src = [_pose_of(yaw=t) for t in degs]
    poses, depth_m, n = da3.geometry_to_poses(_da3_geometry(src), 24.0, 4.0)
    assert n == N and len(poses) == N and depth_m.shape == (N, H, W)
    yaws = [p["yaw"] for p in poses]
    assert np.allclose(yaws, degs, atol=1e-3), yaws
    for p in poses:
        assert np.allclose(p["pos"], [0, 0, 0], atol=1e-6)
        assert abs(p["fov"] - FOV) < 0.5


def test_geometry_rescale_and_confidence():
    src = [_pose_of(pos=(0, 0, t), yaw=0.0) for t in np.linspace(0, 1, N)]
    g = _da3_geometry(src)
    g["depth"] = np.full((N, H, W), 8.0)   # raw 8 m → distance 4 → s=0.5
    g["confidence"] = np.ones((N, H, W))
    g["confidence"][:, :, :4] = 0.0        # left edge untrusted
    poses, depth_m, _ = da3.geometry_to_poses(g, 24.0, 4.0, min_confidence=0.5)
    assert np.allclose([p["pos"][2] for p in poses],
                       np.linspace(0, 0.5, N), atol=1e-6)
    assert np.isinf(depth_m[:, :, :4]).all()
    assert np.isfinite(depth_m[:, :, 4:]).all()


def test_anchor_frames():
    spec = {"moves": ["dolly-in"], "strength": 1.0, "duration": (N - 1) / 16.0,
            "fps": 16.0, "seed": 0, "distance": 4.0, "fov": 40.0}
    frames = cam.compose_trajectory(spec)["frames"]
    a = _pose_of(pos=(1.0, 2.0, 3.0), yaw=30.0, fov=55.0)
    out = da3.anchor_frames(frames, a)
    p0 = out[0]
    assert np.allclose(p0["pos"], a["pos"], atol=1e-9)
    assert abs(p0["yaw"] - 30.0) < 1e-6 and abs(p0["fov"] - 55.0) < 1e-6
    # the dolly travels along the ANCHOR's forward, not world +z
    dz = frames[-1]["pos"][2] - frames[0]["pos"][2]
    fwd = np.array([math.sin(30 * DEG), 0.0, math.cos(30 * DEG)])
    assert np.allclose(out[-1]["pos"], np.asarray(a["pos"]) + dz * fwd, atol=1e-9)


def _shift_dx(f0, f1, rng=30, valid=None):
    """Horizontal translation f0→f1 via exhaustive best-match over ±rng px —
    positive = content moved RIGHT on screen. (fft phase correlation aliases
    on near-periodic textures; the mse minimum doesn't. `valid` masks the
    columns f1 actually covers — hole columns would fake a shifted match,
    and the coverage penalty stops near-empty overlaps from winning.)"""
    a, b = f0[:, :, 0], f1[:, :, 0]
    if valid is not None:
        a, b = a[:, valid], b[:, valid]
    w = a.shape[1]
    best_d, best_e = 0, np.inf
    for d in range(-rng, rng + 1):
        xa, xb = (slice(0, -d or None), slice(d, None)) if d >= 0 \
            else (slice(-d, None), slice(0, d or None))
        na = w - abs(d)
        if na < w // 2:
            continue
        e = float(((a[:, xa] - b[:, xb]) ** 2).mean()) + 0.02 * (1 - na / w)
        if e < best_e:
            best_e, best_d = e, d
    return float(best_d)


def _pan_clip(n=N, yaw_end=8.0):
    """A closed-form clip: the camera pans right over an infinite textured
    plane at z=D. Returns (frames, depth_m, src_poses) — depth in metres."""
    f = W * 0.5 / math.tan(FOV * DEG * 0.5)
    rng = np.random.default_rng(11)
    # a smooth-gradient texture, not white noise — closer to real footage,
    # so the round-trip correlation measures the path, not splat speckle
    tx, ty = np.meshgrid(np.arange(64), np.arange(64))
    tex = np.stack([0.5 + 0.4 * np.sin(tx / 5.0) * np.cos(ty / 4.0),
                    0.5 + 0.4 * np.sin((tx + ty) / 7.0),
                    0.5 + 0.4 * np.cos(tx / 6.0) * np.sin(ty / 3.0)], axis=-1)
    tex += 0.12 * (rng.random((64, 64, 3)) - 0.5)
    tex = np.clip(tex, 0, 1)
    u, v = np.meshgrid(np.arange(W), np.arange(H))
    rays0 = np.stack([(u - W / 2) / f, (H / 2 - v) / f, np.ones_like(u)], axis=-1)
    poses = [_pose_of(yaw=t) for t in np.linspace(0.0, yaw_end, n)]
    frames = np.zeros((n, H, W, 3))
    depth = np.zeros((n, H, W))
    for i, p in enumerate(poses):
        B = np.stack(splat.rotation(p))
        rays = rays0 @ B                       # cam space → world
        t = D / rays[..., 2]                   # plane z=D hit distance = cam z
        pt = t[..., None] * rays               # pos is the origin
        frames[i] = tex[np.mod(np.rint(pt[..., 1] * 8).astype(int), 64),
                        np.mod(np.rint(pt[..., 0] * 8).astype(int), 64)]
        depth[i] = t
    return frames, depth, poses


def test_render_video_replaces_source_motion():
    frames, depth, src = _pan_clip()
    spec = {"moves": ["locked-off"], "strength": 1.0, "duration": (N - 1) / 16.0,
            "fps": 16.0, "seed": 0, "distance": 4.0, "fov": FOV}
    new = cam.compose_trajectory(spec)["frames"]
    out, holes, _ctl = rig.render_video(frames, depth, src, new)
    out, holes = np.asarray(out), np.asarray(holes)
    # the pan is GONE — the source really drifts (pan right → content slides
    # left, negative dx); the locked-off re-render's residual drift, measured
    # only over columns the new frame actually covers, is ≤30% of it
    src_dx = np.mean([_shift_dx(frames[0], frames[i]) for i in range(1, 6)])
    out_dx = np.mean([_shift_dx(out[0], out[i],
                              valid=~holes[i].any(axis=0)) for i in range(1, 6)])
    assert src_dx < -5.0, src_dx                     # the source really pans
    assert abs(out_dx) <= 0.3 * abs(src_dx), (out_dx, src_dx)
    # the covered region reproduces frame 0's view; the region the panned
    # camera never saw (left edge) is holes — disocclusion, flagged for VACE
    i = 8
    covered = ~holes[i]
    assert float(np.mean((out[i][covered] - frames[0][covered]) ** 2)) < 0.02
    left, right = holes[i][:, : W // 6].mean(), holes[i][:, -W // 6:].mean()
    assert left > 10 * right and left > 0.3, (left, right)


def test_render_video_roundtrip():
    frames, depth, src = _pan_clip()
    out, holes, _ctl = rig.render_video(frames, depth, src, src)
    out = np.asarray(out)
    # identity path reproduces the clip — the splat's minimum disc radius
    # bleeds a pixel into a random texture, so compare the interior patch
    # and its correlation, not exact bytes
    y, x = slice(8, -8), slice(8, -8)
    mse = float(np.mean((out[:, y, x] - frames[:, y, x]) ** 2))
    a = out[:, y, x].ravel() - out[:, y, x].mean()
    b = frames[:, y, x].ravel() - frames[:, y, x].mean()
    corr = float(a @ b / (np.linalg.norm(a) * np.linalg.norm(b)))
    assert mse < 0.08 and corr > 0.9, (mse, corr)
    assert np.asarray(holes)[:, 2:-2, 2:-2].mean() < 1e-3


def test_trajectory_frames_override():
    # frames wins over duration — the re-shoot graphs wire the decoded
    # packet count in so the path can never run past the batch
    from motionfield_nodes.nodes_camera import OF_Trajectory
    poses = json.loads(OF_Trajectory().run(
        "dolly-in", 1.0, 9.0, 24.0, 0, frames=7)[0])
    assert len(poses) == 7
    assert OF_Trajectory().run("dolly-in", 1.0, 9.0, 24.0, 0, frames=7)[1] == 7
    # 0 falls back to duration×fps
    assert len(json.loads(OF_Trajectory().run(
        "dolly-in", 1.0, 0.5, 24.0, 0, frames=0)[0])) == 13


def test_geometry_refuses_identity_and_missing_camera_heads():
    src = [_pose_of()]
    g = _da3_geometry(src)
    del g["extrinsics"]
    try:
        da3.geometry_to_poses(g, 24.0, 4.0)
        assert False, "missing extrinsics must raise"
    except ValueError as e:
        assert "extrinsics" in str(e) and "intrinsics" in str(e)
    g = _da3_geometry(src)
    g["intrinsics"] = np.tile(np.eye(3), (1, 1, 1, 1))  # fx=1 — no head ran
    try:
        da3.geometry_to_poses(g, 24.0, 4.0)
        assert False, "identity K must raise"
    except ValueError as e:
        assert "no camera head" in str(e)


def test_render_video_pose_counts():
    frames, depth, src = _pan_clip()
    # more poses than frames → clip, never extend past the batch
    extra = src + [_pose_of(yaw=9.0) for _ in range(3)]
    out, holes, _ = rig.render_video(frames, depth, src + src[:3], extra)
    assert len(out) == N and len(holes) == N
    # fewer poses than frames → the spec lied; hard error
    for cut in (src[: N - 1],):
        try:
            rig.render_video(frames, depth, cut, src)
            assert False, "short src_poses must raise"
        except ValueError as e:
            assert "source poses" in str(e)
    try:
        rig.render_video(frames, depth, src, src[: N - 1])
        assert False, "short new_poses must raise"
    except ValueError as e:
        assert "path poses" in str(e)


def test_depths_to_metres_modes():
    d = np.full((4, H, W), 6.0)
    m = rig.depths_to_metres(d, 4.0, "metres")
    assert np.allclose(m, 6.0) and m.shape == (4, H, W)
    # auto: a 0..1 map centres at 0.5 → distance 4
    m = rig.depths_to_metres(np.full((2, H, W), 0.5), 4.0, "auto")
    assert np.allclose(m, 4.0)
    # metres mode keeps non-finite pixels from splatting (depth +inf → hole)
    d2 = d.copy(); d2[:, :, :3] = np.inf
    m = rig.depths_to_metres(d2, 4.0, "metres")
    assert (m[:, :, :3] > 1e5).all()


def test_render_video_hole_clamp():
    """A move too big for the frame would splat mostly-black — the clamp
    halves the per-frame step toward the last executed pose until the raw
    hole fraction fits, so coverage drops instead of VACE inventing it."""
    frames, depth, src = _pan_clip(n=N, yaw_end=0.0)
    # an 8°/frame pan — way past what an 160px 40° view can show
    fast = [_pose_of(yaw=8.0 * i) for i in range(N)]
    _f, holes_off, _c = rig.render_video(frames, depth, src, fast,
                                         hole_dilate_px=2)
    _f2, holes_on, _c2 = rig.render_video(frames, depth, src, fast,
                                          hole_dilate_px=2, hole_clamp=0.30)
    raw_off = np.asarray([np.asarray(h).mean() for h in holes_off])
    raw_on = np.asarray([np.asarray(h).mean() for h in holes_on])
    assert raw_off[-1] > 0.6, raw_off           # unclamped really is broken
    assert (raw_on <= 0.31).all(), raw_on       # clamped frames all fit
    assert raw_on.mean() < 0.5 * raw_off.mean()


def test_pad_frames():
    f = [np.zeros((2, 2, 3), np.float32) + i for i in range(3)]
    h = [np.zeros((2, 2)) for _ in range(3)]
    c = [np.zeros((2, 2, 3), np.float32) for _ in range(3)]
    f, h, c = rig.pad_frames(f, h, c, 5)
    assert len(f) == 5 and np.allclose(f[4], f[2])
    # shorter pad_to is a no-op, never a silent trim
    assert len(rig.pad_frames(f, h, c, 3)[0]) == 5


def test_window_starts_covers_exactly():
    from motionfield_nodes.core.camera_da3 import window_starts
    assert window_starts(5, 12, 4) == [0]
    st = window_starts(73, 12, 4)
    assert st[0] == 0 and st[-1] + 12 >= 73
    assert all(b - a <= 8 for a, b in zip(st, st[1:]))


def test_stitch_windows_recovers_global_poses():
    """Random per-window similarity → stitched w2c must equal ground truth."""
    rng = np.random.default_rng(0)
    n = 37

    def make_ext(ang, r):
        c = np.array([r * np.sin(ang), 0.5, r * np.cos(ang)])
        fwd = -c / np.linalg.norm(c)
        right = np.cross(fwd, [0, 1, 0]); right /= np.linalg.norm(right)
        up = np.cross(right, fwd)
        e = np.zeros((3, 4)); e[:, :3] = np.stack([right, -up, -fwd])
        e[:, 3] = -e[:, :3] @ c
        return e

    def transform(exts, s, R, t):
        out = exts.copy()
        for i in range(len(out)):
            Ro, to = exts[i][:, :3].copy(), exts[i][:, 3].copy()
            out[i][:, :3] = Ro @ R.T
            out[i][:, 3] = s * to - Ro @ R.T @ t
        return out

    gt = np.stack([make_ext(0.03 * t, 4.0) for t in range(n)])
    base_depth = rng.uniform(1, 6, (n, H, W))
    windows = []
    for j, s in enumerate(da3.window_starts(n, 10, 4)):
        w = min(10, n - s)
        exts = gt[s:s + w].copy()
        depth = base_depth[s:s + w].copy()
        if j:
            th = rng.uniform(-0.4, 0.4, 3)
            cx, sx = np.cos(th), np.sin(th)
            R = (np.array([[1, 0, 0], [0, cx[0], -sx[0]], [0, sx[0], cx[0]]])
                 @ np.array([[cx[1], 0, sx[1]], [0, 1, 0], [-sx[1], 0, cx[1]]])
                 @ np.array([[cx[2], -sx[2], 0], [sx[2], cx[2], 0], [0, 0, 1]]))
            sc, tv = rng.uniform(0.8, 1.25), rng.uniform(-0.3, 0.3, 3)
            exts = transform(exts, 1.0 / sc, R.T, -(R.T @ tv) / sc)
            depth = depth / sc     # a window's world scale scales its depth
        windows.append((s, {
            "depth": depth,
            "image": rng.uniform(0, 1, (w, H, W, 3)),
            "extrinsics": exts,
            "intrinsics": np.tile(np.eye(3), (w, 1, 1)),
        }))
    st = da3.stitch_windows(windows, n)
    ext = st["extrinsics"][0]
    for g in range(n):
        C_hat = -ext[g][:, :3].T @ ext[g][:, 3]
        C_gt = -gt[g][:, :3].T @ gt[g][:, 3]
        assert np.linalg.norm(C_hat - C_gt) < 1e-6
        assert np.linalg.norm(ext[g][:, :3] - gt[g][:, :3]) < 1e-6
    assert st["depth"].shape[0] == n and st["image"].shape[0] == n


def test_stitch_static_camera_keeps_depth_scale():
    """Locked-off source: shared camera centres coincide, so the stitch's
    scale must come from the shared views' depth ratio — not a centre fit.
    Regression for the r4 ctl-arc run, where the compounded centre-fit
    scale collapsed the world ~275x by the last window."""
    rng = np.random.default_rng(1)
    n, w, overlap = 24, 10, 4
    H, W = 8, 12
    ext = np.tile(np.array([[1, 0, 0, 0.01], [0, 1, 0, -0.02],
                            [0, 0, 1, 0.30]]), (w, 1, 1)).astype(np.float64)
    depth0 = rng.uniform(0.5, 4.0, (n, H, W)).astype(np.float32)
    img = rng.uniform(0, 1, (w, H, W, 3)).astype(np.float32)
    K = np.tile(np.eye(3), (w, 1, 1))
    windows = []
    for j, s in enumerate(da3.window_starts(n, w, overlap)):
        m = min(w, n - s)
        sc = 1.0 if j == 0 else 0.5 ** j      # DA3's own per-window scale
        windows.append((s, {
            "depth": depth0[s:s + m] * sc,
            "image": img[:m],
            "extrinsics": ext[:m].copy(),      # identical — static camera
            "intrinsics": K[:m].copy(),
        }))
    st = da3.stitch_windows(windows, n)
    med = [float(np.median(st["depth"][g])) for g in range(n)]
    # no exponential collapse: the tail stays within a factor of frame 0
    assert min(med) > 0.4 * max(med)


# ------------------------------------------------------------ disk cache

def _cache_env():
    """MOTIONFIELD_CACHE_DIR → a fresh mkdtemp; returns (root, restore)."""
    import os
    import tempfile
    root = tempfile.mkdtemp()
    old = os.environ.get("MOTIONFIELD_CACHE_DIR")
    os.environ["MOTIONFIELD_CACHE_DIR"] = root

    def restore():
        if old is None:
            os.environ.pop("MOTIONFIELD_CACHE_DIR", None)
        else:
            os.environ["MOTIONFIELD_CACHE_DIR"] = old
    return root, restore


def test_da3_cache_traversal_stays_inside():
    """A hostile cache key must resolve inside the cache dir and write
    nothing outside it — the npz filename is sanitised, never concatenated
    raw."""
    import os
    root, restore = _cache_env()
    try:
        base = os.path.realpath(da3.da3_cache_dir())
        for key in ("../../etc/evil", "..\\win\\x", "a/b/c", "..%2f..%2fx",
                    ".", "..", "", "x/../../y"):
            p = da3.da3_cache_path(key)
            assert os.path.realpath(p).startswith(base + os.sep), (key, p)
        da3.da3_cache_put("../../outside", {"depth": np.zeros((2, 2))})
        for dirpath, _dirs, files in os.walk(root):
            for f in files:
                full = os.path.join(dirpath, f)
                assert os.path.realpath(full).startswith(base + os.sep), full
                assert f.startswith("of_da3win_") and f.endswith(".npz"), f
    finally:
        restore()


def test_da3_cache_corrupt_npz_recovers():
    """Corrupt/truncated entries read as a miss and are unlinked — a
    poisoned cache file must not crash the node or be served twice."""
    import os
    _root, restore = _cache_env()
    try:
        path = da3.da3_cache_path("clip_a")
        with open(path, "wb") as f:
            f.write(b"this is not an npz archive")
        assert da3.da3_cache_get("clip_a") is None
        assert not os.path.exists(path)
        # a valid entry round-trips
        da3.da3_cache_put("clip_a", {"depth": np.ones((2, 3), np.float32),
                                     "mode_flag": np.int64(7)})
        got = da3.da3_cache_get("clip_a")
        assert got is not None and np.allclose(got["depth"], 1.0)
        assert int(got["mode_flag"]) == 7
        # a truncated real archive is also a miss
        with open(path, "rb") as f:
            head = f.read(48)
        with open(path, "wb") as f:
            f.write(head)
        assert da3.da3_cache_get("clip_a") is None
        assert not os.path.exists(path)
        # missing key is a plain miss
        assert da3.da3_cache_get("never_written") is None
    finally:
        restore()


def test_da3_cache_cap_evicts_lru():
    """The byte cap evicts least-recently-used entries first; a fresh read
    protects an old entry, and the newest write always lands."""
    import os
    import time
    _root, restore = _cache_env()
    try:
        for i in range(3):
            da3.da3_cache_put(f"k{i}", {"d": np.zeros(64, np.float32)})
            time.sleep(0.02)          # mtime granularity
        assert da3.da3_cache_get("k0") is not None   # k0 is now freshest-used
        size = os.path.getsize(da3.da3_cache_path("k2"))
        # cap fits ~2 entries → the two oldest untouched go, k0 and k4 stay
        da3.da3_cache_put("k4", {"d": np.zeros(64, np.float32)},
                          cap_bytes=2 * size + 1)
        names = {e.name for e in os.scandir(da3.da3_cache_dir())}
        assert "of_da3win_k1.npz" not in names and "of_da3win_k2.npz" not in names
        assert "of_da3win_k0.npz" in names and "of_da3win_k4.npz" in names
        # an entry larger than the cap still lands — the cap bounds the
        # directory, never the single clip being cached
        big = {"d": np.zeros(4096, np.float64)}
        da3.da3_cache_put("big", big, cap_bytes=1)
        assert da3.da3_cache_get("big") is not None
    finally:
        restore()
