"""Motion signatures — every visible trajectory id gets a measurable check on
a synthetic scene rendered through the pose stream.

Scene: a background grid at z=10 m and a subject quad at z=3 m carrying
eye/mouth/head keypoints. Rendering is a z-buffered point splat; geometry
measurements use the same analytic projection the renderer does, so the
signatures are deterministic. Hole coverage is measured on a second scene
whose background is a dense full plane just behind the subject — a locked
shot renders solid there, so holes only appear when the camera passes
through the plane.

Every check must FAIL on locked-off frames (control test at the bottom) —
a signature that a static pose satisfies proves nothing.

Run via comfy-nodes/tests/run.py. Writes tests/fixtures/trajectory-verify.json.
"""
import json
import math
import re
from pathlib import Path

import numpy as np

from motionfield_nodes.core import camera_splat as splat
from motionfield_nodes.core import camera_post as post
from motionfield_nodes.core import camera_trajectory as cam

REPO_ROOT = Path(__file__).resolve().parents[2]
VERIFY = REPO_ROOT / "tests" / "fixtures" / "trajectory-verify.json"

W, H = 320, 180
FOV = 40.0
DIST = 3.0
NEAR = 0.05

# ---------------------------------------------------------------- scene

def _scene():
    pts, cols = [], []

    def add(p, c):
        pts.append(p); cols.append(c)

    # background grid at z = 10
    for gx in np.linspace(-6, 6, 17):
        for gy in np.linspace(-3.4, 3.4, 12):
            add((gx, gy, 10.0), (0.22, 0.24, 0.28))
    # subject quad at z = DIST (a denser patch so it covers real pixels)
    for sx in np.linspace(-0.5, 0.5, 15):
        for sy in np.linspace(-0.75, 0.75, 19):
            add((sx, sy, float(DIST)), (0.85, 0.62, 0.30))
    return np.array(pts), np.array(cols)


POINTS, COLORS = _scene()


def _hole_scene():
    """Scene for hole coverage: the sparse grid can't measure holes (a static
    frame is already ~90% holes), so the backdrop is a dense full plane at
    z=3.5 m — just behind the subject — with the far grid kept for texture.
    Rendered with a fatter splat so the plane tiles solidly."""
    pts, cols = [], []
    for gx in np.arange(-2.0, 2.0 + 1e-9, 0.05):
        for gy in np.arange(-1.3, 1.3 + 1e-9, 0.05):
            pts.append((gx, gy, 3.5)); cols.append((0.22, 0.24, 0.28))
    for sx in np.linspace(-0.5, 0.5, 15):
        for sy in np.linspace(-0.75, 0.75, 19):
            pts.append((sx, sy, float(DIST))); cols.append((0.85, 0.62, 0.30))
    for gx in np.linspace(-6, 6, 17):
        for gy in np.linspace(-3.4, 3.4, 12):
            pts.append((gx, gy, 10.0)); cols.append((0.22, 0.24, 0.28))
    return np.array(pts), np.array(cols)


HOLE_POINTS, HOLE_COLORS = _hole_scene()

# subject anchors in world coordinates (subject at rest)
ANCHORS = {name: np.array(cam.subj_to_world({"pos": (0.0, 0.0, DIST), "yaw": 180.0}, loc)) for name, loc in cam.ANCHOR_LOCAL.items()}
QUAD = np.array([(-0.5, 0.75, DIST), (0.5, 0.75, DIST), (-0.5, -0.75, DIST), (0.5, -0.75, DIST)])
BG_LEFT = np.array([[-4.0, 0.0, 10.0]])
BG_RIGHT = np.array([[4.0, 0.0, 10.0]])
BG_TOP = np.array([[0.0, 3.0, 10.0]])
BG_BEHIND = np.array([[0.0, 0.0, 10.0]])
CENTRE = np.array([W / 2.0, H / 2.0])


# ---------------------------------------------------------------- helpers


def traj(mid, duration=1.5, seed=11, strength=1.0, **kw):
    spec = {"moves": [mid], "duration": duration, "fps": 24.0, "seed": seed,
            "strength": strength, "distance": DIST, "fov": FOV}
    spec.update(kw)
    return cam.compose_trajectory(spec)


def frames(mid, duration=1.5, seed=11, strength=1.0, **kw):
    return traj(mid, duration=duration, seed=seed, strength=strength, **kw)["frames"]


def proj(pts, fr):
    sx, sy, qz = splat.project(np.asarray(pts, dtype=np.float64), fr, W, H, fr["fov"])
    return sx, sy, qz


def subject_height(fr):
    sx, sy, qz = proj(QUAD, fr)
    return max(abs(sy[0] - sy[2]), abs(sy[1] - sy[3]))


def subject_x(fr):
    sx, _, _ = proj(QUAD, fr)
    return float(np.mean(sx))


def bg_flow(fr0, fr1, pt=BG_RIGHT):
    s0, t0, q0 = proj(pt, fr0)
    s1, t1, q1 = proj(pt, fr1)
    return np.array([s1[0] - s0[0], t1[0] - t0[0]]), bool(q0[0] > 0 and q1[0] > 0)


def anchor_screen(fr, name):
    sx, sy, qz = proj(ANCHORS[name][None, :], fr)
    return np.array([sx[0], sy[0]]), qz[0]


def render_at(fr, pts=POINTS, cols=COLORS, radius=2.6):
    return splat.render(pts, cols, fr, W, H, fr["fov"], radius=radius, near=NEAR)


def hole_fraction(fr):
    _, holes, _ = render_at(fr, HOLE_POINTS, HOLE_COLORS, radius=5.0)
    return float(np.mean(holes))


def per_frame_poses(fs):
    """per-frame delta magnitudes between consecutive poses."""
    out = []
    for a, b in zip(fs, fs[1:]):
        dp = float(np.linalg.norm(np.subtract(b["pos"], a["pos"])))
        da = abs(b["yaw"] - a["yaw"]) + abs(b["pitch"] - a["pitch"]) + abs(b["roll"] - a["roll"])
        out.append((dp, da))
    return out


# ---------------------------------------------------------------- metrics
# each returns (ok, metric_value)


def m_static(fs):
    d = per_frame_poses(fs)
    v = max((p + a) for p, a in d)
    return v < 1e-9, v


def m_grow(fs, lo=1.15):
    r = subject_height(fs[-1]) / subject_height(fs[0])
    return r > lo, r


def m_shrink(fs, hi=0.85):
    r = subject_height(fs[-1]) / subject_height(fs[0])
    return r < hi, r


def m_parallax(fs, axis="x"):
    """foreground shifts more than background — near/far screen split ≥ 10 px."""
    i = len(fs) // 2
    sj0, sj1 = subject_x(fs[0]), subject_x(fs[i])
    fl, okl = bg_flow(fs[0], fs[i], BG_LEFT)
    fr_, okr = bg_flow(fs[0], fs[i], BG_RIGHT)
    if not (okl and okr):
        fl, ok = bg_flow(fs[0], fs[i], BG_TOP)
        d_bg = abs(fl[1])
        d_fg = abs(subject_height(fs[0]) - subject_height(fs[i]))
        v = abs(d_fg - d_bg)
        return v > 2, v
    bg_dx = (fl[0] + fr_[0]) / 2
    v = abs((sj1 - sj0) - bg_dx)
    return v > 10, v


def m_flow(fs, axis, sign):
    """mean signed background screen flow over the middle frames."""
    i = len(fs) // 2
    tot = np.array([0.0, 0.0])
    for a, b in zip(fs[:i], fs[1:i + 1]):
        f, ok = bg_flow(a, b, BG_TOP if axis == "y" else BG_RIGHT)
        if ok:
            tot += f
    v = float(tot[1] if axis == "y" else tot[0])
    return (v * sign) > 2.0, v


def m_roll(fs, sign):
    """background point above centre slides sideways under a roll."""
    i = len(fs) // 2
    d, ok = bg_flow(fs[0], fs[i], BG_TOP)
    v = float(d[0])
    return ok and (v * sign) > 1.0, v


def m_zoom(fs, grow=True):
    """scale change with near:far scale ratio within 6% — a pure zoom."""
    s0, s1 = subject_height(fs[0]), subject_height(fs[-1])
    r = s1 / s0
    # background point scale factor: radial distance from centre
    f0 = proj(BG_TOP, fs[0]); f1 = proj(BG_TOP, fs[-1])
    import numpy.linalg as la
    d0 = la.norm(np.array([f0[0][0], f0[1][0]]) - CENTRE)
    d1 = la.norm(np.array([f1[0][0], f1[1][0]]) - CENTRE)
    parallax_diff = abs((d1 / d0) / r - 1) if d0 > 0 else 1.0
    return (r > 1.15 if grow else r < 0.85) and parallax_diff < 0.06, {"scale": r, "parallax_diff": parallax_diff}


def m_orbit(fs, min_yaw=20.0):
    """subject roughly held in frame while the camera sweeps yaw."""
    drifts, yaws = [], []
    for fr in fs:
        sx, sy, qz = proj(QUAD[0][None, :], fr)
        # centroid of the visible quad corners
        sxs, sys_, qzs = proj(QUAD, fr)
        vis = qzs > NEAR
        if vis.any():
            drifts.append(abs(np.mean(sxs[vis]) - W / 2) / (W / 2))
        yaws.append(fr["yaw"])
    sweep = max(yaws) - min(yaws)
    drift = max(drifts) if drifts else 1.0
    return sweep >= min_yaw and drift <= 0.35, {"sweep": sweep, "drift": drift}


def m_target(fs, name, tol_frac=0.03):
    """anchor holds within `tol_frac` of frame centre."""
    worst = 0.0
    for fr in fs:
        p, qz = anchor_screen(fr, name)
        if qz <= NEAR:
            continue
        worst = max(worst, float(np.linalg.norm((p - CENTRE) / CENTRE)))
    return worst <= tol_frac, worst


def m_holes(fs):
    v = max(hole_fraction(fr) for fr in fs)
    return v > 0.30, v


def m_focus(fs):
    f0, f1 = fs[0].get("focus", 0), fs[-1].get("focus", 0)
    return f1 > f0 > 0, {"from": f0, "to": f1}


def m_travel(fs, frac=0.3):
    d = np.subtract(fs[-1]["pos"], fs[0]["pos"])
    v = float(np.linalg.norm(d))
    return v > frac * DIST, v


def m_cross(fs):
    """the camera ends up on the far side of the subject plane."""
    z0, z1 = fs[0]["pos"][2], fs[-1]["pos"][2]
    crossed = (z0 - DIST) * (z1 - DIST) < 0 or z1 > DIST or any(
        f["pos"][2] > DIST - NEAR for f in fs)
    return crossed, {"z0": z0, "z1": z1}


def m_decay(fs):
    """amplitude late < amplitude early (a burst that dies)."""
    d = [p + a for p, a in per_frame_poses(fs)]
    early = max(d[: len(d) // 4])
    late = max(d[-len(d) // 4:])
    return late < early * 0.5, {"early": early, "late": late}


def m_noisy(fs, lo=1e-6):
    """seeded noise — nonzero pose deltas, bounded."""
    d = [p + a for p, a in per_frame_poses(fs)]
    v = max(d)
    return lo < v < 60, v


def m_yaw_sweep(fs, min_deg=60.0):
    yaws = [f["yaw"] for f in fs]
    v = max(yaws) - min(yaws)
    return v >= min_deg, v


def m_subject_dx(fs, sign):
    """subject centroid screen-x drift with the expected sign — splits
    left/right lateral pairs (truck, side-track)."""
    v = subject_x(fs[-1]) - subject_x(fs[0])
    return v * sign > 20.0, v


def m_parallax_dir(fs, sign, at=0.3):
    """horizontal parallax sign for aimed moves — the behind-subject
    background point's screen-x drift relative to the subject's, measured
    partway through the sweep (late frames of full orbits put it behind
    the camera)."""
    i = min(len(fs) - 1, int((len(fs) - 1) * at))
    b0, _, q0 = proj(BG_BEHIND, fs[0])
    b1, _, q1 = proj(BG_BEHIND, fs[i])
    if not (q0[0] > NEAR and q1[0] > NEAR):
        return False, {"qz": [float(q0[0]), float(q1[0])]}
    v = (b1[0] - subject_x(fs[i])) - (b0[0] - subject_x(fs[0]))
    return v * sign > 10.0, v


def m_height(fs, sign):
    """camera height delta sign — crane/jib/overhead up vs down."""
    v = fs[-1]["pos"][1] - fs[0]["pos"][1]
    return v * sign > 0.5, v


def m_vflow_rel(fs, sign):
    """vertical parallax sign — the high background point's screen-y drift
    relative to the subject's (camera rises → the far background sinks on
    screen relative to the near subject → sy drifts positive)."""
    _, t0, q0 = proj(BG_TOP, fs[0])
    _, t1, q1 = proj(BG_TOP, fs[-1])
    if not (q0[0] > NEAR and q1[0] > NEAR):
        return False, {"qz": [float(q0[0]), float(q1[0])]}
    sj0 = float(np.mean(proj(QUAD, fs[0])[1]))
    sj1 = float(np.mean(proj(QUAD, fs[-1])[1]))
    v = (t1[0] - sj1) - (t0[0] - sj0)
    return v * sign > 5.0, v


def m_height_bump(fs, min_h=0.5):
    """a rise-and-return vertical bump — jib-over-foreground arcs up through
    the middle and lands back near its start height."""
    ys = [f["pos"][1] for f in fs]
    amp = max(ys) - min(ys)
    net = abs(ys[-1] - ys[0])
    return amp > min_h and net < 0.2, {"amp": amp, "net": net}


def m_layer_parallax(fs, lo=0.1):
    """near:far parallax — the foreground scales by more than the background
    recedes under a push. Ratio of scale factors, ≥ lo."""
    r_fg = subject_height(fs[-1]) / subject_height(fs[0])

    def rad(fr):
        sx, sy, _ = proj(BG_TOP, fr)
        return float(np.linalg.norm(np.array([sx[0], sy[0]]) - CENTRE))
    r_bg = rad(fs[-1]) / rad(fs[0])
    v = r_fg - r_bg
    return v > lo, v


def m_all(*checks):
    """every check must pass; report the individual values."""
    def run(fs):
        vals, ok = {}, True
        for i, c in enumerate(checks):
            o, v = c(fs)
            ok = ok and o
            vals[f"c{i}"] = v
        return ok, vals
    return run


def _band_frac(series, fps, lo_hz, hi_hz):
    """share of spectral energy the pose channel carries inside (lo,hi) Hz —
    the noise-band signature for shake/jitter checks."""
    x = np.asarray(series, dtype=np.float64)
    x = x - x.mean()
    p = np.abs(np.fft.rfft(x)) ** 2
    f = np.fft.rfftfreq(len(x), d=1.0 / fps)
    tot = float(p[1:].sum())
    if tot <= 0:
        return 0.0
    return float(p[(f > lo_hz) & (f < hi_hz)].sum() / tot)


# per-id signature table — one check per visible id
SIGNATURES = {
    # basic
    "locked-off": ("static", m_static),
    "dolly-in": ("grow+parallax", m_all(
        m_grow, lambda fs: m_layer_parallax(fs, 0.1))),
    "dolly-out": ("shrink", lambda fs: m_shrink(fs)),
    "slow-creep-in": ("grow", lambda fs: m_grow(fs, 1.1)),
    "pull-back-reveal": ("shrink", lambda fs: m_shrink(fs)),
    "truck-left": ("parallax+dx", m_all(
        m_parallax, lambda fs: m_subject_dx(fs, 1))),
    "truck-right": ("parallax+dx", m_all(
        m_parallax, lambda fs: m_subject_dx(fs, -1))),
    "pedestal-up": ("flow-y", lambda fs: m_flow(fs, "y", 1)),
    "pedestal-down": ("flow-y", lambda fs: m_flow(fs, "y", -1)),
    "pan-left": ("flow-x", lambda fs: m_flow(fs, "x", 1)),
    "pan-right": ("flow-x", lambda fs: m_flow(fs, "x", -1)),
    "tilt-up": ("flow-y", lambda fs: m_flow(fs, "y", 1)),
    "tilt-down": ("flow-y", lambda fs: m_flow(fs, "y", -1)),
    "dutch-roll-cw": ("roll", lambda fs: m_roll(fs, 1)),
    "dutch-roll-ccw": ("roll", lambda fs: m_roll(fs, -1)),
    "follow-behind": ("grow", lambda fs: m_grow(fs)),
    "lead-backward": ("shrink", lambda fs: m_shrink(fs)),
    "side-track-left": ("parallax+dx", m_all(
        m_parallax, lambda fs: m_subject_dx(fs, 1))),
    "side-track-right": ("parallax+dx", m_all(
        m_parallax, lambda fs: m_subject_dx(fs, -1))),
    "auto-move": ("auto", None),
    # cinematic
    "arc-left-45": ("orbit+parallax", m_all(
        lambda fs: m_orbit(fs, 30), lambda fs: m_parallax_dir(fs, -1))),
    "arc-right-45": ("orbit+parallax", m_all(
        lambda fs: m_orbit(fs, 30), lambda fs: m_parallax_dir(fs, 1))),
    "orbit-360": ("orbit+parallax", m_all(
        lambda fs: m_orbit(fs, 300), lambda fs: m_parallax_dir(fs, -1))),
    "turntable-180": ("orbit+parallax", m_all(
        lambda fs: m_orbit(fs, 150), lambda fs: m_parallax_dir(fs, -1))),
    "crane-up": ("height+vflow", m_all(
        lambda fs: m_height(fs, 1), lambda fs: m_vflow_rel(fs, -1))),
    "crane-down": ("height+vflow", m_all(
        lambda fs: m_height(fs, -1), lambda fs: m_vflow_rel(fs, 1))),
    "jib-over-foreground": ("height-bump", lambda fs: m_height_bump(fs)),
    "overhead-rise": ("height+vflow", m_all(
        lambda fs: m_height(fs, 1), lambda fs: m_vflow_rel(fs, -1))),
    "overhead-drop": ("height+vflow", m_all(
        lambda fs: m_height(fs, -1), lambda fs: m_vflow_rel(fs, 1))),
    "handheld-subtle": ("noise", m_noisy),
    "low-angle-push": ("low+grow", None),
    "high-angle-pull": ("shrink", lambda fs: m_shrink(fs)),
    "parallax-slide": ("parallax+dir", m_all(
        m_parallax, lambda fs: m_parallax_dir(fs, 1))),
    "eye-push": ("target-eyes", None),
    "mouth-push": ("target-mouth", m_all(
        lambda fs: m_target(fs, "mouth"), m_travel)),
    "head-lock-follow": ("locked", None),
    "motion-control-sweep": ("sweep", None),
    "body-mount": ("locked", None),
    "car-mount": ("locked", None),
    "making-of-pullback": ("shrink+hh-band", None),
    "overhead-crane-pass": ("crane-pass", None),
    "beauty-arc": ("orbit+grow", m_all(
        lambda fs: m_orbit(fs, 15), lambda fs: m_grow(fs, 1.1))),
    "tilt-rise": ("tilt+y", m_all(
        lambda fs: m_flow(fs, "y", 1), lambda fs: m_height(fs, 1))),
    "jib-up": ("height+vflow", m_all(
        lambda fs: m_height(fs, 1), lambda fs: m_vflow_rel(fs, -1))),
    "jib-down": ("height+vflow", m_all(
        lambda fs: m_height(fs, -1), lambda fs: m_vflow_rel(fs, 1))),
    "turntable-360": ("orbit+parallax", m_all(
        lambda fs: m_orbit(fs, 300), lambda fs: m_parallax_dir(fs, -1))),
    "object-pov": ("cross", m_cross),
    # energetic
    "crash-zoom-in": ("zoom", lambda fs: m_zoom(fs, True)),
    "crash-zoom-out": ("zoom", lambda fs: m_zoom(fs, False)),
    "handheld-run": ("noise", m_noisy),
    "fpv-dive": ("grow", lambda fs: m_grow(fs)),
    "fpv-rise": ("grow", lambda fs: m_grow(fs)),
    "drone-flyover": ("travel", lambda fs: m_travel(fs)),
    "spiral-up": ("orbit+parallax", m_all(
        lambda fs: m_orbit(fs, 100), lambda fs: m_parallax_dir(fs, -1))),
    "corkscrew-down": ("orbit+parallax", m_all(
        lambda fs: m_orbit(fs, 100), lambda fs: m_parallax_dir(fs, 1))),
    "snap-tilt-down": ("flow-y", lambda fs: m_flow(fs, "y", -1)),
    "impact-shake": ("decay", m_decay),
    "mouth-snap-zoom": ("target-mouth", m_all(
        lambda fs: m_target(fs, "mouth"), lambda fs: m_grow(fs, 1.2))),
    "chase-follow": ("chase", None),
    "ground-rush": ("rush", None),
    "dolly-in-max": ("grow", lambda fs: m_grow(fs, 2.0)),
    "dolly-out-max": ("shrink", lambda fs: m_shrink(fs, 0.5)),
    "jitter-shake": ("hf-noise", None),
    # lens
    "zoom-in": ("zoom", lambda fs: m_zoom(fs, True)),
    "zoom-out": ("zoom", lambda fs: m_zoom(fs, False)),
    "dolly-zoom-in": ("dolly-zoom", None),
    "dolly-zoom-out": ("dolly-zoom", None),
    "rack-focus-near-to-far": ("focus", m_focus),
    "fisheye-lens": ("curve", None),
    "shutter-drag": ("blur", None),
    "zoom-pulse": ("fov-dips", None),
    # time
    "frozen-moment-arc": ("orbit", lambda fs: m_orbit(fs, 40)),
    "hyperlapse": ("travel", lambda fs: m_travel(fs)),
    "timelapse-studio": ("static", m_static),
    "timelapse-crowd": ("travel", lambda fs: m_travel(fs, 0.05)),
    "timelapse-landscape": ("flow-x", lambda fs: m_flow(fs, "x", -1)),
    # transition
    "whip-pan-left": ("whip-x", None),
    "whip-pan-right": ("whip-x", None),
    "fly-through-transition": ("holes", m_holes),
    "pass-through-in": ("holes", m_holes),
    "pass-through-out": ("holes", m_holes),
}

HIDDEN = {"cabin-jolt", "two-stage-push"}  # hidden in the catalog — no signature

# spec-item ledger — every signature check reports the requirement ids it
# satisfies (written into trajectory-verify.json per case). A move can carry
# several spec rows when the spec lists the same move twice under
# different wording.
LEDGER = {
    "auto-move": ["OF-0179"], "eye-push": ["OF-0180"],
    "frozen-moment-arc": ["OF-0181"], "pull-back-reveal": ["OF-0182"],
    "arc-left-45": ["OF-0183"], "arc-right-45": ["OF-0183"],
    "making-of-pullback": ["OF-0184"], "chase-follow": ["OF-0186"],
    "car-mount": ["OF-0187"], "crane-up": ["OF-0188"], "crane-down": ["OF-0188"],
    "overhead-crane-pass": ["OF-0189"],
    "crash-zoom-in": ["OF-0190", "OF-0214"], "crash-zoom-out": ["OF-0190", "OF-0214"],
    "dolly-in": ["OF-0191"], "dolly-out": ["OF-0191"],
    "truck-left": ["OF-0192"], "truck-right": ["OF-0192"],
    "dolly-zoom-in": ["OF-0193"], "dolly-zoom-out": ["OF-0193"],
    "dutch-roll-cw": ["OF-0195"], "dutch-roll-ccw": ["OF-0195"],
    "mouth-snap-zoom": ["OF-0196"], "fisheye-lens": ["OF-0197"],
    "fly-through-transition": ["OF-0198"], "rack-focus-near-to-far": ["OF-0199"],
    "fpv-dive": ["OF-0200"], "fpv-rise": ["OF-0200"],
    "beauty-arc": ["OF-0201"], "handheld-subtle": ["OF-0202"],
    "handheld-run": ["OF-0202"], "head-lock-follow": ["OF-0203"],
    "low-angle-push": ["OF-0204"], "hyperlapse": ["OF-0205"],
    "tilt-rise": ["OF-0206"], "jib-up": ["OF-0207"], "jib-down": ["OF-0207"],
    "turntable-360": ["OF-0208"], "shutter-drag": ["OF-0209"],
    "mouth-push": ["OF-0210"], "object-pov": ["OF-0211"],
    "overhead-rise": ["OF-0212"], "overhead-drop": ["OF-0212"],
    "pan-left": ["OF-0213"], "pan-right": ["OF-0213"],
    "ground-rush": ["OF-0215"], "motion-control-sweep": ["OF-0216"],
    "body-mount": ["OF-0217"], "locked-off": ["OF-0218"],
    "dolly-in-max": ["OF-0219"], "dolly-out-max": ["OF-0219"],
    "pass-through-in": ["OF-0220"], "pass-through-out": ["OF-0220"],
    "tilt-up": ["OF-0221"], "tilt-down": ["OF-0221"],
    "timelapse-studio": ["OF-0222"], "timelapse-crowd": ["OF-0223"],
    "timelapse-landscape": ["OF-0224"],
    "whip-pan-left": ["OF-0225"], "whip-pan-right": ["OF-0225"],
    "jitter-shake": ["OF-0226"], "zoom-pulse": ["OF-0227"],
    "orbit-360": ["OF-0228", "OF-0230"], "zoom-in": ["OF-0229"],
    "zoom-out": ["OF-0229"],
}
# OF-0185 (cabin-jolt) and OF-0194 (two-stage-push) stay hidden — no signature
# runs for them. Every other visible id without a named row above still
# satisfies the camera-move-library item.
LIBRARY_ROW = "OF-0139"

_REPORT = {}


def _record(mid, metric, ok, value):
    _REPORT[mid] = {"metric": metric, "pass": bool(ok), "value": value,
                    "ledger": LEDGER.get(mid, [LIBRARY_ROW])}
    return ok


def _locked_frames(mid):
    """subject_locked check with the subject itself translating — the camera
    is rigid on it, so the subject must hold while the world slides past."""
    speed = 3.0
    return frames(mid, subjectAt=lambda t: {"pos": (speed * t, 0.0, DIST), "yaw": 180.0})


def _check_locked(mid):
    # subject translates at 3 m/s; the locked camera rides with it —
    # the tracked anchor must hold to ≤1px while the background flows >5px/frame
    fs = _locked_frames(mid)
    key = cam.MOVES[mid].get("target", "subject")
    mean_bg = []
    drift_px = 0.0
    base = None
    for i, fr in enumerate(fs):
        subj = {"pos": (3.0 * fr["t"], 0.0, DIST), "yaw": 180.0}
        w = np.array(cam.subj_to_world(subj, cam.ANCHOR_LOCAL[key]))
        sx, sy, qz = splat.project(w[None, :], fr, W, H, fr["fov"])
        if base is None:
            base = np.array([sx[0], sy[0]])
        drift_px = max(drift_px, float(np.linalg.norm(np.array([sx[0], sy[0]]) - base)))
        if i:
            d, ok = bg_flow(fs[i - 1], fr, BG_RIGHT)
            if ok:
                mean_bg.append(float(np.linalg.norm(d)))
    bgv = float(np.mean(mean_bg)) if mean_bg else 0.0
    ok = drift_px <= 1.0 and bgv > 5.0
    return _record(mid, "locked", ok, {"subject_drift_px": drift_px, "bg_flow_px": bgv})


def _check_dolly_zoom(mid):
    fs = frames(mid, strength=1.0)
    s0, s1 = subject_height(fs[0]), subject_height(fs[-1])
    # background apparent size: radial distance of a bg point from centre
    def rad(fr):
        sx, sy, qz = proj(BG_TOP, fr)
        return float(np.linalg.norm(np.array([sx[0], sy[0]]) - CENTRE))
    b0, b1 = rad(fs[0]), rad(fs[-1])
    subj_dev = abs(s1 / s0 - 1)
    bg_dev = abs(b1 / b0 - 1)
    ok = subj_dev <= 0.01 and bg_dev >= 0.15
    return _record(mid, "dolly-zoom", ok, {"subject_scale_dev": subj_dev, "bg_scale_dev": bg_dev})


def _check_whip(mid, sign):
    fs = frames(mid, duration=1.5)
    d = [abs(b["yaw"] - a["yaw"]) for a, b in zip(fs, fs[1:])]
    yaws = [f["yaw"] for f in fs]
    sweep = max(yaws) - min(yaws)
    peak = max(d)
    ok = sweep >= 60 and peak >= 2.0 and (yaws[-1] - yaws[0]) * sign > 0
    return _record(mid, "whip", ok, {"sweep": sweep, "peak_dps_frame": peak})


def _check_auto(mid):
    ok = True
    vals = {}
    for cls, want in cam.AUTO_MOVE.items():
        got = traj(mid, subjectClass=cls)["moves"]
        vals[cls] = got
        ok = ok and got == [want]
    return _record(mid, "auto", ok, vals)


def _check_sweep(mid):
    # yaw ≥60° in ≤1.5 s, centroid drift ≤5%
    fs = frames(mid, duration=1.5)
    yaws = [f["yaw"] for f in fs]
    sweep = max(yaws) - min(yaws)
    drift = 0.0
    for fr in fs:
        sxs, sys_, qzs = proj(QUAD, fr)
        vis = qzs > NEAR
        if vis.any():
            drift = max(drift, abs(float(np.mean(sxs[vis]) - W / 2)) / (W / 2))
    ok = sweep >= 60 and drift <= 0.05
    return _record(mid, "sweep", ok, {"yaw_sweep": sweep, "centroid_drift": drift})


def _check_eyes(mid):
    # eyes ≤3% from centre while subject scale ≥1.4×
    fs = frames(mid)
    worst = 0.0
    for fr in fs:
        p, qz = anchor_screen(fr, "eyes")
        if qz > NEAR:
            worst = max(worst, float(np.linalg.norm((p - CENTRE) / CENTRE)))
    scale = subject_height(fs[-1]) / subject_height(fs[0])
    ok = worst <= 0.03 and scale >= 1.4
    return _record(mid, "eye-push", ok, {"max_off_centre": worst, "scale": scale})


def _check_holes(mid):
    # the dense backdrop means only a genuine plane crossing leaves holes:
    # the end of the move on the camera's own side must stay <5%, a crossing
    # frame must exceed 30%, and locked-off must stay <5% too.
    fs = frames(mid)
    hs = [hole_fraction(fr) for fr in fs]
    cross = max(hs)
    h_edge = min(hs[0], hs[-1])
    h_locked = max(hole_fraction(fr) for fr in frames("locked-off"))
    ok = cross > 0.30 and h_edge < 0.05 and h_locked < 0.05
    return _record(mid, "holes", ok,
                 {"crossing": cross, "edge": h_edge, "locked_off": h_locked})


def _check_blur(mid):
    # the smear must come from this move's own shutter post — not just any
    # motion blurred after the fact
    tagged = post_tag(mid) == "shutter"
    fs = frames(mid)
    raw = [render_at(fr)[0] for fr in fs]
    dragged = post.post_shutter(raw, exposure=0.55)
    v = float(np.mean([np.abs(d - r).mean() for d, r in zip(dragged[1:], raw[1:])]))
    return _record(mid, "blur", tagged and v > 0.002,
                 {"tag": post_tag(mid), "smear": v})


def _check_curve(mid):
    # curvature measured on post.fisheye(render): the move must carry the
    # lens/fisheye post, and the subject's straight edge must visibly bow
    # in the warped frame
    spec = traj(mid, duration=0.5)
    pa = spec.get("postArg") or {}
    tagged = spec.get("post") == "lens" and pa.get("lens") == "fisheye"
    fs = frames(mid)
    fr = fs[len(fs) // 2]
    img, _, _ = render_at(fr)
    warped = post.fisheye(img, k=float(pa.get("k", 0.5)))
    mask = warped[..., 0] > 0.5  # the warm subject quad vs the grey grid
    left = np.array([np.nonzero(mask[y])[0].min() if mask[y].any() else np.nan
                     for y in range(10, H - 10)])
    bend = float(np.nanmax(left) - np.nanmin(left)) if np.isfinite(left).any() else 0.0
    ok = tagged and bend > 5.0
    return _record(mid, "curve", ok,
                   {"tag": spec.get("post"), "edge_bend": bend})


def _check_chase(mid):
    """chase-follow: forward travel plus a lateral weave — the x velocity
    must change sign at least twice."""
    fs = frames(mid)
    travel = float(np.linalg.norm(np.subtract(fs[-1]["pos"], fs[0]["pos"])))
    xs = np.array([f["pos"][0] for f in fs])
    vel = np.diff(xs)
    signs = np.sign(vel[np.abs(vel) > 1e-9])
    changes = int((signs[1:] != signs[:-1]).sum()) if len(signs) > 1 else 0
    ok = travel > 0.5 * DIST and changes >= 2
    return _record(mid, "chase", ok, {"travel": travel, "sway_sign_changes": changes})


def _check_ground_rush(mid):
    """ground-rush: stays near ground level (height span ≤0.2 m) while
    travelling at least half the subject distance."""
    fs = frames(mid)
    ys = [f["pos"][1] for f in fs]
    span = max(ys) - min(ys)
    travel = float(np.linalg.norm(np.subtract(fs[-1]["pos"], fs[0]["pos"])))
    ok = span <= 0.2 and travel >= 0.5 * DIST
    return _record(mid, "rush", ok, {"height_span": span, "travel": travel})


def _check_crane_pass(mid):
    """overhead-crane-pass: the pass pitches ≥75° down through the middle of
    the move while covering real ground."""
    fs = frames(mid)
    pitches = [f["pitch"] for f in fs]
    i_min = int(np.argmin(pitches))
    mid_pass = len(fs) // 4 <= i_min <= 3 * len(fs) // 4
    travel = float(np.linalg.norm(np.subtract(fs[-1]["pos"], fs[0]["pos"])))
    ok = min(pitches) <= -75.0 and mid_pass and travel >= 0.5 * DIST
    return _record(mid, "crane-pass", ok,
                 {"pitch_min": min(pitches), "mid_pass": mid_pass, "travel": travel})


def _check_low_angle(mid):
    """low-angle-push: opens below the eye-line anchor, rises as it pushes in
    and the subject grows."""
    fs = frames(mid)
    eye_y = float(ANCHORS["eyes"][1])
    start_y, end_y = fs[0]["pos"][1], fs[-1]["pos"][1]
    r = subject_height(fs[-1]) / subject_height(fs[0])
    ok = start_y < eye_y and end_y > start_y + 0.1 and r >= 1.15
    return _record(mid, "low-angle", ok, {"start_y": start_y, "end_y": end_y, "scale": r})


def _check_making_of(mid):
    """making-of-pullback: shrinks off the subject with the operator's
    handheld-band wobble on top (pose energy concentrated in 0.5–5 Hz)."""
    fs = frames(mid, fps=48.0, duration=1.0)
    shrink_ok, r = m_shrink(fs)
    frac = _band_frac([f["roll"] for f in fs], 48.0, 0.5, 5.0)
    return _record(mid, "shrink+hh-band", bool(shrink_ok) and frac > 0.5,
                 {"scale": r, "band_frac": frac})


def _check_jitter(mid):
    """jitter-shake: a high-frequency shake — most pose energy sits above
    4 Hz, not in the walk/handheld band."""
    fs = frames(mid, fps=48.0, duration=1.0)
    frac = max(_band_frac([f["roll"] for f in fs], 48.0, 4.0, 1e9),
               _band_frac([f["yaw"] for f in fs], 48.0, 4.0, 1e9))
    return _record(mid, "hf-noise", frac > 0.6, frac)


def _check_pulse(mid):
    """zoom-pulse: fov breathes — at least two interior dips in the series."""
    fs = frames(mid)
    fovs = np.array([f["fov"] for f in fs])
    dips = int(((fovs[1:-1] < fovs[:-2]) & (fovs[1:-1] < fovs[2:])).sum())
    return _record(mid, "fov-dips", dips >= 2, dips)


def post_tag(mid):
    return traj(mid, duration=0.5).get("post")


# custom check dispatch — everything not listed runs the SIGNATURES table
CUSTOM = {
    "auto-move": _check_auto,
    "head-lock-follow": lambda mid: _check_locked(mid),
    "body-mount": lambda mid: _check_locked(mid),
    "car-mount": lambda mid: _check_locked(mid),
    "dolly-zoom-in": _check_dolly_zoom,
    "dolly-zoom-out": _check_dolly_zoom,
    "whip-pan-left": lambda mid: _check_whip(mid, -1),
    "whip-pan-right": lambda mid: _check_whip(mid, 1),
    "motion-control-sweep": _check_sweep,
    "eye-push": _check_eyes,
    "fly-through-transition": _check_holes,
    "pass-through-in": _check_holes,
    "pass-through-out": _check_holes,
    "shutter-drag": _check_blur,
    "fisheye-lens": _check_curve,
    "chase-follow": _check_chase,
    "ground-rush": _check_ground_rush,
    "overhead-crane-pass": _check_crane_pass,
    "low-angle-push": _check_low_angle,
    "making-of-pullback": _check_making_of,
    "jitter-shake": _check_jitter,
    "zoom-pulse": _check_pulse,
    "frozen-moment-arc": lambda mid: _record(mid, "post+orbit+parallax",
        (post_tag(mid) == "time_sample") and m_orbit(frames(mid), 40)[0]
        and m_parallax_dir(frames(mid), -1)[0],
        post_tag(mid)),
    "hyperlapse": lambda mid: _record(mid, "post+travel",
        (post_tag(mid) == "time_sample") and m_travel(frames(mid))[0],
        post_tag(mid)),
    "timelapse-studio": lambda mid: _record(mid, "post+static",
        (post_tag(mid) == "time_sample") and m_static(frames(mid))[0],
        post_tag(mid)),
    "timelapse-crowd": lambda mid: _record(mid, "post+travel",
        (post_tag(mid) == "time_sample") and m_travel(frames(mid), 0.05)[0],
        post_tag(mid)),
    "timelapse-landscape": lambda mid: _record(mid, "post+pan",
        (post_tag(mid) == "time_sample") and m_flow(frames(mid), "x", -1)[0],
        post_tag(mid)),
}


def test_ledger_covers_camera_rows():
    """every camera-move spec row OF-0179…OF-0230 that a visible id can
    satisfy is claimed by one — OF-0185 (cabin-jolt) and OF-0194
    (two-stage-push) stay hidden, so they claim nothing. Ledger keys must
    also be real visible moves, else a typo silently reports the library row."""
    visible = set(cam.MOVES) - HIDDEN
    stray = [m for m in LEDGER if m not in visible]
    assert not stray, f"ledger keys that aren't visible moves: {stray}"
    claimed = set()
    for mid in visible:
        claimed.update(LEDGER.get(mid, [LIBRARY_ROW]))
    want = {f"OF-{n:04d}" for n in range(179, 231)} - {"OF-0185", "OF-0194"}
    missing = sorted(want - claimed)
    assert not missing, f"spec rows no visible move claims: {missing}"


def test_motion_signatures_cover_every_visible_id():
    visible = sorted(set(cam.MOVES) - HIDDEN)
    assert len(visible) == 81, len(visible)
    missing = [i for i in visible if i not in SIGNATURES]
    assert not missing, f"no signature for: {missing}"


def test_motion_signatures():
    failures = []
    for mid in sorted(set(cam.MOVES) - HIDDEN):
        metric, _ = SIGNATURES[mid]
        try:
            if mid in CUSTOM:
                ok = CUSTOM[mid](mid)
            else:
                fs = frames(mid)
                res = SIGNATURES[mid][1](fs)
                ok, val = res if isinstance(res, tuple) else (bool(res), res)
                _record(mid, metric, ok, val)
            if not ok:
                failures.append(mid)
        except Exception as e:  # surface the id, keep going to fill the report
            _record(mid, metric, False, f"{type(e).__name__}: {e}")
            failures.append(mid)
    assert not failures, f"signature failures: {failures}"


def test_signatures_fail_on_locked_off_frames():
    """control: a signature that a static pose satisfies proves nothing —
    every check must fail on locked-off frames. Exempt: locked-off itself
    (static is its signature), timelapse-studio (also a static move), and
    auto-move (its check is dispatch, not motion)."""
    saved = dict(_REPORT)  # custom checks record under their mid arg — restore
    locked = frames("locked-off")
    passing = []
    try:
        for mid in sorted(set(cam.MOVES) - HIDDEN - {"locked-off", "timelapse-studio", "auto-move"}):
            try:
                if mid in CUSTOM:
                    ok = CUSTOM[mid]("locked-off")
                else:
                    res = SIGNATURES[mid][1](locked)
                    ok = res[0] if isinstance(res, tuple) else bool(res)
                if ok:
                    passing.append(mid)
            except Exception:
                pass  # raised on static input — counts as a failing check
    finally:
        _REPORT.clear()
        _REPORT.update(saved)
    assert not passing, f"signatures that pass on locked-off frames: {passing}"


# ------------------------------------------------------------------ extras
# non-move records — stack-order semantics, the lock base-heading rule, the
# TS↔PY core/rig split, and the CPU rig smoke. Written next to the per-move
# cases in trajectory-verify.json.

_EXTRAS = {}


def _extra(key, ledger, ok, value):
    _EXTRAS[key] = {"ledger": ledger, "pass": bool(ok), "value": value}
    return ok


def test_stack_order_recorded():
    """[OF-0143] additive parts (position, yaw/pitch/roll, fov ratio) don't
    depend on stack order; last-wins fields (target/layer/post/fovAbs/focus)
    follow the last move that sets them. Both orders recorded."""
    kw = {"duration": 2.0, "fps": 24.0, "seed": 5, "distance": DIST, "fov": FOV}
    a = cam.compose_trajectory({"moves": ["dolly-in", "pan-left"], **kw})
    b = cam.compose_trajectory({"moves": ["pan-left", "dolly-in"], **kw})
    err = 0.0
    for fa, fb in zip(a["frames"], b["frames"]):
        err = max(err, max(abs(x - y) for x, y in zip(fa["pos"], fb["pos"])),
                  abs(fa["yaw"] - fb["yaw"]), abs(fa["pitch"] - fb["pitch"]),
                  abs(fa["roll"] - fb["roll"]), abs(fa["fov"] - fb["fov"]))
    # last-wins: the later targeted move owns the aim either way
    c1 = cam.compose_trajectory({"moves": ["mouth-push", "eye-push"], **kw})
    c2 = cam.compose_trajectory({"moves": ["eye-push", "mouth-push"], **kw})
    ok = err <= 1e-9 and c1.get("target") == "eyes" and c2.get("target") == "mouth"
    assert _extra("stack_order", ["OF-0143"], ok, {
        "additive_max_err": err,
        "orders": [["dolly-in", "pan-left"], ["pan-left", "dolly-in"]],
        "last_wins": {"mouth_then_eye": c1.get("target"), "eye_then_mouth": c2.get("target")},
    })


def test_lock_delta_under_aimed_stack():
    """[OF-0143] a subject_locked move without its own target contributes only
    deltas when the stack is aimed — the subject's base heading (yaw+180) must
    not be double-counted. 90°-yawed subject recorded."""
    subj = {"pos": (0.0, 0.0, DIST), "yaw": 90.0}
    res = cam.compose_trajectory({
        "moves": ["arc-left-45", "pan-left"], "duration": 1.0, "fps": 24.0,
        "seed": 7, "distance": DIST, "fov": FOV,
        "subjectAt": lambda t: subj, "layer": "subject_locked"})
    n = len(res["frames"])
    yaw_err = pos_err = 0.0
    for i, fr in enumerate(res["frames"]):
        u = i / (n - 1)
        c = {"strength": 1.0, "duration": 1.0, "fps": 24.0, "seed": 7,
             "distance": DIST, "fov": FOV, "frames": n}
        dl_arc = cam.MOVES["arc-left-45"]["fn"](u, c)
        dl_pan = cam.MOVES["pan-left"]["fn"](u, c)
        anchor = cam.subj_to_world(subj, [dl_pan["pos"][0], dl_pan["pos"][1], DIST + dl_pan["pos"][2]])
        pos = [anchor[0] + dl_arc["pos"][0], anchor[1] + dl_arc["pos"][1], anchor[2] + dl_arc["pos"][2]]
        ay, _ap = cam.aim_at(pos, subj["pos"])
        want = (ay + dl_pan["yaw"] + 180) % 360 - 180
        yaw_err = max(yaw_err, abs(fr["yaw"] - want))
        pos_err = max(pos_err, max(abs(x - y) for x, y in zip(fr["pos"], pos)))
    ok = yaw_err <= 1e-9 and pos_err <= 1e-9
    assert _extra("lock_base_heading_90", ["OF-0143"], ok,
                  {"subject_yaw": 90.0, "max_yaw_err": yaw_err, "max_pos_err": pos_err})


def test_core_rig_split_matches_ts_catalog():
    """[OF-0136] the core/rig split — the TS catalog rows (order + hidden
    flags parsed from the source) split by the Python mirror's rig predicate
    must equal the split over the Python-visible surface. run.py is the
    cross-check gate for the two lists; the committed fixture pins the result."""
    src = (REPO_ROOT / "src" / "lib" / "catalog" / "presets" / "trajectories.ts").read_text()
    ts_visible = []
    for line in src.splitlines():
        m = re.match(r'\s*t\("([a-z0-9-]+)"', line)
        if m and "hidden: true" not in line:
            ts_visible.append(m.group(1))
    py_visible = [mid for mid in cam.MOVES if mid not in HIDDEN]
    core_ts, rig_ts = cam.split_ids(ts_visible)
    core_py, rig_py = cam.split_ids(py_visible)
    # catalog order ≠ MOVES order — the lists agree as sets; the recorded
    # ordered lists are what the TS side pins itself against
    ok = (set(ts_visible) == set(py_visible)
          and set(core_ts) == set(core_py) and set(rig_ts) == set(rig_py)
          and len(core_ts) + len(rig_ts) == len(ts_visible))
    _extra("core_rig_split", ["OF-0136"], ok,
           {"core": core_ts, "rig": rig_ts, "counts": [len(core_ts), len(rig_ts)]})
    assert ok


def test_rig_cpu_synthetic_plane():
    """[OF-0191] OF_CameraRig on a synthetic textured fronto-parallel plane:
    dolly-in grows the centre crop ≥1.1× and a zero-motion pose leaves an
    empty hole mask (2 px border excluded). Numpy only."""
    from motion_check import rig_selftest
    got = rig_selftest()
    ok = got["dolly_scale"] >= 1.1 and got["locked_hole_frac"] < 1e-6
    assert _extra("rig_cpu", ["OF-0191"], ok, got)


def _reference_pack(emb):
    """The packing OF_CameraEmbed originally shipped, kept verbatim as the
    equivalence oracle for the layout-spec rewrite. CPU torch only."""
    import torch
    t = torch.from_numpy(emb).permute(3, 0, 1, 2).unsqueeze(0)
    t = torch.cat([t[:, :, :1].repeat_interleave(4, dim=2), t[:, :, 1:]], dim=2).transpose(1, 2)
    b, f, c, h, w = t.shape
    t = t.reshape(b, f // 4, 4, c, h, w).transpose(2, 3)
    t = t.reshape(b, f // 4, c * 4, h, w).transpose(1, 2)
    return t.contiguous()


def test_camera_embed_plucker_layout():
    """OF_CameraEmbed's Plücker maps: frame 0 is the canonical
    identity frame — its ray directions are the pinhole back-projection
    (centre ray = +z) and its moment channels are ~0 (camera at the rel
    origin). truck-left moves the camera −x, so later frames carry a nonzero
    moment block proportional to translation_scale. The node's packed output
    is compared bitwise against the original packing on the same 17-frame
    stream. Recorded CPU-side — this is not on-video truck evidence, so the
    record carries no ledger tag."""
    from motionfield_nodes.core import camera_embed as emb

    # odd dims put a pixel exactly on the optical axis (centre ray = +z)
    w, h, n = 49, 33, 17
    poses = cam.compose_trajectory({"moves": ["truck-left"], "duration": 1.0,
                                    "fps": 16.0, "seed": 3, "distance": DIST,
                                    "fov": FOV})["frames"][:n]
    e = emb.plucker_embedding(poses, w, h, translation_scale=2.0)
    ok = e.shape == (n, h, w, 6)
    # frame 0: identity rel pose → origin 0 → moment (o×d) ≈ 0; centre dir = +z
    ok &= float(np.abs(e[0, :, :, :3]).max()) < 1e-6
    ok &= float(np.linalg.norm(e[0, h // 2, w // 2, 3:] - [0.0, 0.0, 1.0])) < 1e-4
    # truck-left moves −x: frame 8's moments are nonzero and scale with the
    # translation lever (2.0 here — twice the metre displacement)
    e1 = emb.plucker_embedding(poses, w, h, translation_scale=1.0)
    m1 = float(np.abs(e1[8, :, :, :3]).mean())
    m2 = float(np.abs(e[8, :, :, :3]).mean())
    ok &= m1 > 1e-6 and abs(m2 / m1 - 2.0) < 0.01
    # packed layout the Wan camera adapter consumes: [1,24,(F+3)/4,H,W]
    f4 = (n - 1) + 4
    ok &= f4 % 4 == 0
    value = {"shape": list(e.shape), "f0_moment_max": float(np.abs(e[0, :, :, :3]).max()),
             "truck_moment_s1": m1, "truck_moment_s2": m2,
             "packed": [1, 24, f4 // 4, h, w]}
    # pack-equality record: the node's layout-spec packing must equal the
    # original packing bitwise on this 17-frame stream (CPU, no model) —
    # a torch import failure is a test failure, never a silent skip
    import json as _json
    import torch  # noqa: F401
    from motionfield_nodes.nodes_camera import OF_CameraEmbed
    node_out, ow, oh, ol = OF_CameraEmbed().run(_json.dumps(poses), w, h, 2.0)
    ref = _reference_pack(e)
    diff = float((node_out.cpu() - ref).abs().max())
    ok &= (ow, oh, ol) == (w, h, n) and tuple(node_out.shape) == tuple(ref.shape) and diff == 0.0
    value["pack_eq_max_abs_diff"] = diff
    assert _extra("camera_embed", [], ok, value)


def test_zzz_write_verify_report():
    VERIFY.write_text(json.dumps({
        "cases": _REPORT,
        "extras": _EXTRAS,
        "summary": {"checked": len(_REPORT), "passed": sum(1 for v in _REPORT.values() if v["pass"]),
                    "extras": {k: v["pass"] for k, v in _EXTRAS.items()}},
    }, indent=2, sort_keys=True))
    assert _REPORT, "report must not be empty"
