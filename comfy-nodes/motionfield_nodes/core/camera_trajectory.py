"""Camera trajectory engine — Python mirror of src/lib/camera/trajectory.ts.

Same world frame (metres, +x right, +y up, +z forward), same conventions
(yaw right+, pitch up+, roll clockwise+, fov = horizontal degrees), same
seeded noise — the golden fixture pins both sides to 1e-6.
"""
import math

TRAJECTORY_TARGETS = ("eyes", "mouth", "head", "subject")
TRAJECTORY_LAYERS = ("scene", "subject_locked")
TRAJECTORY_POSTS = ("lens", "shutter", "time_sample")
SUBJECT_CLASSES = ("person", "product", "landscape", "vehicle")

DEG = math.pi / 180.0

# ---------------------------------------------------------------- noise


def _i32(x):
    x &= 0xFFFFFFFF
    return x - (1 << 32) if x & 0x80000000 else x


def _imul(a, b):
    return _i32(_i32(a) * _i32(b))


def mulberry32(seed):
    """Mirrors the JS Math.imul-based mulberry32 exactly."""
    s = [seed & 0xFFFFFFFF]

    def rnd():
        s[0] = (s[0] + 0x6D2B79F5) & 0xFFFFFFFF
        t = s[0]
        r = _imul(t ^ (t >> 15), t | 1)
        r = _i32(r ^ _i32(r + _imul(r ^ ((r & 0xFFFFFFFF) >> 7), r | 61)))
        r = (r ^ ((r & 0xFFFFFFFF) >> 14)) & 0xFFFFFFFF
        return r / 4294967296.0

    return rnd


def make_noise(seed, freq_scale=1.0, octaves=4):
    rnd = mulberry32((seed ^ 0x9E3779B9) & 0xFFFFFFFF)
    comp = [
        ((i + 1) * freq_scale * (0.9 + rnd() * 0.4), rnd() * math.pi * 2, 1.0 / (i + 1))
        for i in range(octaves)
    ]
    norm = sum(a for _, _, a in comp)

    def n(u):
        return sum(a * math.sin(2 * math.pi * f * u + p) for f, p, a in comp) / norm

    return n


# ---------------------------------------------------------------- deltas


def _d0():
    return {"pos": [0.0, 0.0, 0.0], "yaw": 0.0, "pitch": 0.0, "roll": 0.0, "fovRatio": 1.0}


def lin(u):
    return u


def s3(u):
    return u * u * (3 - 2 * u)


def s5(u):
    return u * u * u * (6 * u * u - 15 * u + 10)


def eo(u):
    return 1 - (1 - u) ** 3


def ei(u):
    return u * u * u


def _orbit(u, c, theta_deg, env=lin):
    th = theta_deg * env(u) * DEG
    D = c["distance"]
    d = _d0()
    d["pos"] = [-D * math.sin(th), 0.0, D - D * math.cos(th)]
    return d


def _shove(u, c, depth, env=s3):
    d = _d0()
    d["pos"][2] = depth * c["distance"] * c["strength"] * env(u)
    return d


def _shake(u, c, pos_amp, ang_amp, freq=1.0, slot=0):
    n1 = make_noise(c["seed"] + slot * 101 + 1, freq)
    n2 = make_noise(c["seed"] + slot * 101 + 2, freq)
    n3 = make_noise(c["seed"] + slot * 101 + 3, freq)
    n4 = make_noise(c["seed"] + slot * 101 + 4, freq)
    n5 = make_noise(c["seed"] + slot * 101 + 5, freq)
    n6 = make_noise(c["seed"] + slot * 101 + 6, freq)
    d = _d0()
    p = pos_amp * c["distance"] * c["strength"]
    d["pos"] = [p * n1(u), p * n2(u), p * n3(u)]
    d["yaw"] = ang_amp * c["strength"] * n4(u)
    d["pitch"] = ang_amp * c["strength"] * n5(u)
    d["roll"] = 0.6 * ang_amp * c["strength"] * n6(u)
    return d


def _dolly_zoom(u, c, into):
    travel = 0.5 * c["distance"] * c["strength"] * s3(u)
    z = travel if into else -travel
    dist = max(c["distance"] - z, c["distance"] * 0.1)
    d = _d0()
    d["pos"][2] = z
    d["fovAbs"] = 2 * math.atan(math.tan(c["fov"] * math.pi / 360) * (c["distance"] / dist)) / DEG
    return d


def _pull_back(u, c):
    d = _shove(u, c, -0.35)
    d["pos"][1] = 0.12 * c["distance"] * c["strength"] * s3(u)
    d["pitch"] = -3 * c["strength"] * s3(u)
    return d


def _fpv(u, c, up):
    d = _shove(u, c, 0.9, ei)
    sgn = 1 if up else -1
    d["pos"][1] = sgn * 0.3 * c["distance"] * c["strength"] * ei(u)
    d["pitch"] = sgn * (10 if up else 15) * c["strength"] * ei(u)
    return d


def _jib_foreground(u, c):
    d = _d0()
    d["pos"] = [
        0.0,
        0.25 * c["distance"] * c["strength"] * math.sin(math.pi * u),
        0.3 * c["distance"] * c["strength"] * lin(u),
    ]
    d["pitch"] = -6 * c["strength"] * math.sin(math.pi * u)
    return d


def _impact_shake(u, c):
    rnd = mulberry32((c["seed"] ^ 0x51AB00) & 0xFFFFFFFF)
    ph = rnd() * math.pi * 2
    env = math.exp(-3 * u)
    d = _d0()
    d["yaw"] = 4 * c["strength"] * env * math.sin(6 * math.pi * u + ph)
    d["pitch"] = 3 * c["strength"] * env * math.sin(5.4 * math.pi * u)
    d["roll"] = 2.5 * c["strength"] * env * math.sin(4.2 * math.pi * u + ph)
    d["pos"][1] = 0.008 * c["distance"] * c["strength"] * env * math.sin(5 * math.pi * u)
    return d


def _mouth_snap(u, c):
    d = _shove(u, c, 0.3)
    d["fovRatio"] = 1 / (1 + 0.9 * c["strength"] * u**4)
    return d


def _chase(u, c):
    d = _shove(u, c, 0.9, lin)
    d["pos"][0] = 0.08 * c["distance"] * c["strength"] * math.sin(2 * math.pi * u)
    d["yaw"] = 3 * c["strength"] * math.sin(2 * math.pi * u + 0.6)
    return d


def _ground_rush(u, c):
    d = _shove(u, c, 1.3, lambda u: u**1.5)
    d["pos"][1] = -0.25 * c["distance"] * c["strength"]
    d["pitch"] = -8 * c["strength"] * lin(u)
    return d


def _making_of(u, c):
    d = _shove(u, c, -0.55, lin)
    n = _shake(u, c, 0.006, 0.5, 1.2, 8)  # handheld-band wobble over the drift
    d["pos"][1] = 0.3 * c["distance"] * c["strength"] * lin(u) + n["pos"][1]
    d["pos"][0] += n["pos"][0]
    d["pos"][2] += n["pos"][2]
    d["yaw"] = 12 * c["strength"] * lin(u) + n["yaw"]
    d["pitch"] = n["pitch"]
    d["roll"] = n["roll"]
    return d


def _cabin_jolt(u, c):
    rnd = mulberry32((c["seed"] ^ 0x0C4B1A) & 0xFFFFFFFF)
    ph = rnd() * math.pi * 2
    a = sum(math.exp(-14 * abs(u - b)) * math.sin(28 * math.pi * u + ph) for b in (0.3, 0.65, 0.9))
    d = _d0()
    d["yaw"] = 3 * c["strength"] * a
    d["pitch"] = 2 * c["strength"] * a
    d["pos"][1] = 0.01 * c["distance"] * c["strength"] * a
    return d


def _two_stage(u, c):
    D = c["distance"] * c["strength"]
    z = 0.12 * D * (u / 0.45) if u < 0.45 else 0.12 * D + 0.38 * D * s3((u - 0.45) / 0.55)
    d = _d0()
    d["pos"][2] = z
    return d


def _overhead_crane_pass(u, c):
    d = _shove(u, c, 1.1, lin)
    d["pos"][1] = 0.45 * c["distance"] * c["strength"] * lin(u)
    d["pitch"] = -80 * c["strength"] * math.sin(math.pi * u)
    return d


def _beauty_arc(u, c):
    d = _orbit(u, c, 25 * c["strength"], s3)
    d["pos"][1] = 0.06 * c["distance"] * c["strength"] * lin(u)
    d["fovRatio"] = 1 / (1 + 0.12 * c["strength"] * lin(u))
    return d


def _object_pov(u, c):
    d = _shove(u, c, 1.0, s3)
    d["pos"][1] = 0.05 * lin(u)
    d["yaw"] = 20 * c["strength"] * math.sin(4 * math.pi * u) * u
    d["pitch"] = -5 * c["strength"] * u
    return d


def _hyperlapse(u, c):
    d = _shove(u, c, 0.7, lin)
    d["pos"][0] = 0.1 * c["distance"] * c["strength"] * math.sin(4 * math.pi * u)
    return d


def _spiral_up(u, c):
    d = _orbit(u, c, 150, s3)
    d["pos"][1] = 0.25 * c["distance"] * c["strength"] * lin(u)
    return d


def _corkscrew(u, c):
    d = _orbit(u, c, -150, s3)
    d["pos"][1] = -0.25 * c["distance"] * c["strength"] * lin(u)
    d["roll"] = 12 * c["strength"] * math.sin(4 * math.pi * u)
    return d


def _low_angle_push(u, c):
    d = _shove(u, c, 0.45)
    d["pos"][1] = -0.18 * c["distance"] * c["strength"] * (1 - lin(u))
    d["pitch"] = 10 * c["strength"] * (1 - lin(u))
    return d


def _high_angle_pull(u, c):
    d = _shove(u, c, -0.35)
    d["pos"][1] = 0.2 * c["distance"] * c["strength"] * (1 - lin(u))
    d["pitch"] = -12 * c["strength"] * (1 - lin(u))
    return d


def _drone_flyover(u, c):
    d = _shove(u, c, 0.9, lin)
    d["pos"][1] = 0.35 * c["distance"] * c["strength"] * s3(u)
    d["pitch"] = -50 * c["strength"] * lin(u)
    return d


def _shutter_drag(u, c):
    d = _d0()
    d["yaw"] = 8 * c["strength"] * lin(u)
    d["pos"][0] = 0.04 * c["distance"] * c["strength"] * lin(u)
    return d


MOVES = {
    # ------------------------------------------------------- base 50 ---
    "locked-off": {"fn": lambda u, c: _d0()},
    "dolly-in": {"fn": lambda u, c: _shove(u, c, 0.4)},
    "dolly-out": {"fn": lambda u, c: _shove(u, c, -0.4)},
    "slow-creep-in": {"fn": lambda u, c: _shove(u, c, 0.15, lin)},
    "pull-back-reveal": {"fn": _pull_back},
    "truck-left": {"fn": lambda u, c: {**_d0(), "pos": [-0.25 * c["distance"] * c["strength"] * s3(u), 0, 0]}},
    "truck-right": {"fn": lambda u, c: {**_d0(), "pos": [0.25 * c["distance"] * c["strength"] * s3(u), 0, 0]}},
    "pedestal-up": {"fn": lambda u, c: {**_d0(), "pos": [0, 0.3 * c["distance"] * c["strength"] * s3(u), 0]}},
    "pedestal-down": {"fn": lambda u, c: {**_d0(), "pos": [0, -0.3 * c["distance"] * c["strength"] * s3(u), 0]}},
    "pan-left": {"fn": lambda u, c: {**_d0(), "yaw": -12 * c["strength"] * s3(u)}},
    "pan-right": {"fn": lambda u, c: {**_d0(), "yaw": 12 * c["strength"] * s3(u)}},
    "tilt-up": {"fn": lambda u, c: {**_d0(), "pitch": 10 * c["strength"] * s3(u)}},
    "tilt-down": {"fn": lambda u, c: {**_d0(), "pitch": -10 * c["strength"] * s3(u)}},
    "dutch-roll-cw": {"fn": lambda u, c: {**_d0(), "roll": 8 * c["strength"] * s3(u)}},
    "dutch-roll-ccw": {"fn": lambda u, c: {**_d0(), "roll": -8 * c["strength"] * s3(u)}},
    "zoom-in": {"fn": lambda u, c: {**_d0(), "fovRatio": 1 / (1 + 0.6 * c["strength"] * s3(u))}},
    "zoom-out": {"fn": lambda u, c: {**_d0(), "fovRatio": 1 + 0.6 * c["strength"] * s3(u)}},
    "crash-zoom-in": {"fn": lambda u, c: {**_d0(), "fovRatio": 1 / (1 + 1.4 * c["strength"] * u**4)}},
    "crash-zoom-out": {"fn": lambda u, c: {**_d0(), "fovRatio": 1 + 1.4 * c["strength"] * u**4}},
    "dolly-zoom-in": {"fn": lambda u, c: _dolly_zoom(u, c, True)},
    "dolly-zoom-out": {"fn": lambda u, c: _dolly_zoom(u, c, False)},
    "arc-left-45": {"target": "subject", "fn": lambda u, c: _orbit(u, c, 45 * c["strength"], s3)},
    "arc-right-45": {"target": "subject", "fn": lambda u, c: _orbit(u, c, -45 * c["strength"], s3)},
    "orbit-360": {"target": "subject", "fn": lambda u, c: _orbit(u, c, 360)},
    "turntable-180": {"target": "subject", "fn": lambda u, c: _orbit(u, c, 180 * c["strength"], s3)},
    "crane-up": {"target": "subject", "fn": lambda u, c: {**_d0(), "pos": [0, 0.35 * c["distance"] * c["strength"] * s3(u), 0.1 * c["distance"] * c["strength"] * s3(u)]}},
    "crane-down": {"target": "subject", "fn": lambda u, c: {**_d0(), "pos": [0, 0.35 * c["distance"] * c["strength"] * (1 - s3(u)), 0.1 * c["distance"] * c["strength"] * s3(u)]}},
    "jib-over-foreground": {"target": "subject", "fn": _jib_foreground},
    "overhead-rise": {"target": "subject", "fn": lambda u, c: {**_d0(), "pos": [0, 0.5 * c["distance"] * c["strength"] * lin(u), 0]}},
    "overhead-drop": {"target": "subject", "fn": lambda u, c: {**_d0(), "pos": [0, 0.5 * c["distance"] * c["strength"] * (1 - lin(u)), 0]}},
    "whip-pan-left": {"fn": lambda u, c: {**_d0(), "yaw": -90 * c["strength"] * s5(u)}},
    "whip-pan-right": {"fn": lambda u, c: {**_d0(), "yaw": 90 * c["strength"] * s5(u)}},
    "handheld-subtle": {"fn": lambda u, c: _shake(u, c, 0.012, 0.6, 1, 1)},
    "handheld-run": {"fn": lambda u, c: _shake(u, c, 0.06, 2.2, 3, 2)},
    "follow-behind": {"fn": lambda u, c: _shove(u, c, 0.8, lin)},
    "lead-backward": {"fn": lambda u, c: _shove(u, c, -0.8, lin)},
    "side-track-left": {"fn": lambda u, c: {**_d0(), "pos": [-0.5 * c["distance"] * c["strength"] * lin(u), 0, 0]}},
    "side-track-right": {"fn": lambda u, c: {**_d0(), "pos": [0.5 * c["distance"] * c["strength"] * lin(u), 0, 0]}},
    "fpv-dive": {"fn": lambda u, c: _fpv(u, c, False)},
    "fpv-rise": {"fn": lambda u, c: _fpv(u, c, True)},
    "drone-flyover": {"fn": _drone_flyover},
    "spiral-up": {"target": "subject", "fn": _spiral_up},
    "corkscrew-down": {"target": "subject", "fn": _corkscrew},
    "low-angle-push": {"fn": _low_angle_push},
    "high-angle-pull": {"fn": _high_angle_pull},
    "parallax-slide": {"target": "subject", "fn": lambda u, c: {**_d0(), "pos": [0.35 * c["distance"] * c["strength"] * lin(u), 0, 0]}},
    "snap-tilt-down": {"fn": lambda u, c: {**_d0(), "pitch": -40 * c["strength"] * eo(u)}},
    "impact-shake": {"fn": _impact_shake},
    "frozen-moment-arc": {"target": "subject", "post": "time_sample", "fn": lambda u, c: _orbit(u, c, 60 * c["strength"], s3)},
    "rack-focus-near-to-far": {
        "post": "lens", "postArg": {"lens": "focus_pull"},
        "fn": lambda u, c: {**_d0(), "focus": 0.9 + (1.8 * c["distance"] - 0.9) * s3(u)},
    },
    # -------------------------------------------------------- new 33 ---
    "auto-move": {"fn": lambda u, c: _d0()},  # resolved via AUTO_MOVE first
    "eye-push": {"target": "eyes", "fn": lambda u, c: _shove(u, c, 0.45)},
    "mouth-push": {"target": "mouth", "fn": lambda u, c: _shove(u, c, 0.5)},
    "mouth-snap-zoom": {"target": "mouth", "fn": _mouth_snap},
    "head-lock-follow": {
        "layer": "subject_locked", "target": "head", "mount": [0, 0.14, 0.9],
        "fn": lambda u, c: _shake(u, c, 0.004, 0.25, 2, 3),
    },
    "motion-control-sweep": {"target": "subject", "fn": lambda u, c: _orbit(u, c, 95 * c["strength"], s3)},
    "body-mount": {
        "layer": "subject_locked", "target": "subject", "mount": [0, 0.02, 0.45],
        "fn": lambda u, c: _shake(u, c, 0.002, 0.1, 6, 4),
    },
    "car-mount": {
        "layer": "subject_locked", "target": "subject", "mount": [0, -0.15, 0.65],
        "fn": lambda u, c: _shake(u, c, 0.005, 0.4, 9, 5),
    },
    "chase-follow": {"fn": _chase},
    "ground-rush": {"fn": _ground_rush},
    "making-of-pullback": {"fn": _making_of},
    "cabin-jolt": {"fn": _cabin_jolt},
    "two-stage-push": {"fn": _two_stage},
    "overhead-crane-pass": {"fn": _overhead_crane_pass},
    "fisheye-lens": {"post": "lens", "postArg": {"lens": "fisheye", "k": 0.5}, "fn": lambda u, c: {**_d0(), "pos": [0.05 * c["distance"] * c["strength"] * lin(u), 0, 0]}},
    "shutter-drag": {"post": "shutter", "postArg": {"exposure": 0.55}, "fn": _shutter_drag},
    "fly-through-transition": {"fn": lambda u, c: _shove(u, c, 1.35, lambda u: u**1.4)},
    "beauty-arc": {"target": "subject", "fn": _beauty_arc},
    "tilt-rise": {"fn": lambda u, c: {**_d0(), "pos": [0, 0.22 * c["distance"] * c["strength"] * s3(u), 0], "pitch": 14 * c["strength"] * lin(u)}},
    "jib-up": {"target": "subject", "fn": lambda u, c: {**_d0(), "pos": [0.12 * c["distance"] * c["strength"] * s3(u), 0.3 * c["distance"] * c["strength"] * s3(u), 0.08 * c["distance"] * c["strength"] * s3(u)]}},
    "jib-down": {"target": "subject", "fn": lambda u, c: {**_d0(), "pos": [0.12 * c["distance"] * c["strength"] * s3(u), 0.3 * c["distance"] * c["strength"] * (1 - s3(u)), 0.08 * c["distance"] * c["strength"] * s3(u)]}},
    "turntable-360": {"target": "subject", "fn": lambda u, c: _orbit(u, c, 360 * c["strength"], s3)},
    "object-pov": {"fn": _object_pov},
    "pass-through-in": {"fn": lambda u, c: _shove(u, c, 1.4, lin)},
    "pass-through-out": {"fn": lambda u, c: _shove(u, c, 1.4, lambda u: 1 - lin(u))},
    "dolly-in-max": {"fn": lambda u, c: _shove(u, c, 0.8, s3)},
    "dolly-out-max": {"fn": lambda u, c: _shove(u, c, -1.2, s3)},
    "hyperlapse": {"post": "time_sample", "fn": _hyperlapse},
    "timelapse-studio": {"post": "time_sample", "fn": lambda u, c: _d0()},
    "timelapse-crowd": {
        "post": "time_sample",
        "fn": lambda u, c: {**_shove(u, c, 0.12, lin), "yaw": 2 * c["strength"] * lin(u)},
    },
    "timelapse-landscape": {"post": "time_sample", "fn": lambda u, c: {**_d0(), "yaw": 4 * c["strength"] * lin(u)}},
    "jitter-shake": {"fn": lambda u, c: _shake(u, c, 0.008, 2.8, 8, 6)},
    "zoom-pulse": {"fn": lambda u, c: {**_d0(), "fovRatio": 1 / (1 + 0.18 * c["strength"] * (0.5 - 0.5 * math.cos(6 * math.pi * u)))}},
}

AUTO_MOVE = {
    "person": "eye-push",
    "product": "turntable-180",
    "landscape": "drone-flyover",
    "vehicle": "side-track-left",
}

ANCHOR_LOCAL = {
    "eyes": (0.0, 0.08, 0.08),
    "mouth": (0.0, 0.02, 0.08),
    "head": (0.0, 0.14, 0.04),
    "subject": (0.0, 0.0, 0.0),
}


def subj_to_world(subj, local):
    s, co = math.sin(subj["yaw"] * DEG), math.cos(subj["yaw"] * DEG)
    return [
        subj["pos"][0] + co * local[0] + s * local[2],
        subj["pos"][1] + local[1],
        subj["pos"][2] - s * local[0] + co * local[2],
    ]


def aim_at(pos, target):
    dx, dy, dz = target[0] - pos[0], target[1] - pos[1], target[2] - pos[2]
    return math.atan2(dx, dz) / DEG, math.atan2(dy, math.sqrt(dx * dx + dz * dz)) / DEG


def resolve_moves(moves, subject_class="person"):
    out = []
    for mid in moves:
        resolved = AUTO_MOVE[subject_class] if mid == "auto-move" else mid
        if resolved not in MOVES:
            raise ValueError(f'unknown trajectory "{mid}"')
        out.append(resolved)
    return out


def compose_trajectory(spec):
    """spec: {moves[1..3], strength?, duration, fps, seed?, distance?, fov?,
    subjectClass?, subjectAt?(t)->{pos,yaw}, anchors?, target?, layer?, post?}
    subjectAt is a callable returning {"pos": (x,y,z), "yaw": deg}."""
    moves = list(spec["moves"])
    if not 1 <= len(moves) <= 3:
        raise ValueError("a trajectory stack is 1-3 moves")
    strength = spec.get("strength", 1.0)
    if not 0.25 <= strength <= 2.0:
        raise ValueError("strength must be within 0.25-2.0")
    distance = spec.get("distance", 4.0)
    fov0 = spec.get("fov", 40.0)
    ids = resolve_moves(moves, spec.get("subjectClass", "person"))
    c = {
        "strength": strength, "distance": distance, "fov": fov0,
        "fps": spec["fps"], "duration": spec["duration"],
        "frames": max(2, round(spec["duration"] * spec["fps"]) + 1),
        "seed": int(spec.get("seed", 0)),
    }
    defs = [MOVES[i] for i in ids]
    subject_at = spec.get("subjectAt") or (lambda t: {"pos": (0.0, 0.0, distance), "yaw": 180.0})

    target_override = spec.get("target")
    target = (target_override if target_override not in (None, "auto") else None) or next(
        (d["target"] for d in reversed(defs) if d.get("target")), None)

    layer_override = spec.get("layer")
    if layer_override == "subject_locked":
        lock = defs[-1]
    elif layer_override == "scene":
        lock = None
    else:
        lock = next((d for d in reversed(defs) if d.get("layer") == "subject_locked"), None)

    post_override = spec.get("post")
    if post_override not in (None, "auto"):
        post = None if post_override == "none" else post_override
    else:
        post = next((d["post"] for d in reversed(defs) if d.get("post")), None)
    post_arg = next((d["postArg"] for d in reversed(defs) if d.get("postArg")), None)

    frames = []
    for i in range(c["frames"]):
        u = i / (c["frames"] - 1) if c["frames"] > 1 else 0.0
        t = i / c["fps"]
        subj = subject_at(t)

        px = py = pz = yaw = pitch = roll = 0.0
        fov_ratio = 1.0
        fov_abs = focus = None
        for d in defs:
            dl = d["fn"](u, c)
            if d is lock:
                continue
            px += dl["pos"][0]; py += dl["pos"][1]; pz += dl["pos"][2]
            if not d.get("target"):
                yaw += dl["yaw"]; pitch += dl["pitch"]
            roll += dl["roll"]
            fov_ratio *= dl["fovRatio"]
            if dl.get("fovAbs") is not None:
                fov_abs = dl["fovAbs"]
            if dl.get("focus") is not None:
                focus = dl["focus"]

        if lock is not None:
            dl = lock["fn"](u, c)
            mount = lock.get("mount") or [0, 0, distance]
            anchor = subj_to_world(subj, [mount[0] + dl["pos"][0], mount[1] + dl["pos"][1], mount[2] + dl["pos"][2]])
            pos = [anchor[0] + px, anchor[1] + py, anchor[2] + pz]
            if not lock.get("target"):
                # base heading only when nothing else aims — stacked with an
                # aimed move the lock contributes deltas alone, otherwise the
                # subject's yaw would be counted twice
                if target is None:
                    yaw += subj["yaw"] + 180
                yaw += dl["yaw"]
                pitch += dl["pitch"]
            roll += dl["roll"]
            fov_ratio *= dl["fovRatio"]
            if dl.get("fovAbs") is not None:
                fov_abs = dl["fovAbs"]
            if dl.get("focus") is not None:
                focus = dl["focus"]
        else:
            pos = [px, py, pz]

        if target is not None:
            anchor_pt = (spec.get("anchors") or {}).get(target) or subj_to_world(subj, ANCHOR_LOCAL[target])
            ay, ap = aim_at(pos, anchor_pt)
            yaw += ay
            pitch += ap

        frame = {
            "t": t, "pos": pos,
            "yaw": (yaw + 180) % 360 - 180,
            "pitch": pitch, "roll": roll,
            "fov": (fov_abs if fov_abs is not None else fov0) * fov_ratio,
        }
        if focus is not None:
            frame["focus"] = focus
        frames.append(frame)

    out = {"moves": ids, "frames": frames, "layer": "subject_locked" if lock is not None else "scene"}
    if target is not None:
        out["target"] = target
    if post is not None:
        out["post"] = post
        if post_arg is not None:
            out["postArg"] = post_arg
    return out


# --------------------------------------------------------------------- #
# rig-mode split — mirrors src/lib/camera/trajectory.ts                   #
# --------------------------------------------------------------------- #

# Moves that cross the subject plane. The pose-only rig re-renders one side
# of the scene — past the plane the camera looks at content that was never
# photographed (object-pov lands on the plane itself).
PLANE_CROSSING_IDS = frozenset((
    "pass-through-in", "pass-through-out", "fly-through-transition", "object-pov",
))


def is_rig_move(mid):
    """Rig-mode: subject-locked, aims at a facial anchor (eyes/mouth/head),
    carries a post tag, or crosses the subject plane. The pose-only
    image-to-video path executes none of those."""
    d = MOVES.get(mid)
    if d is None:
        return False
    return (
        d.get("layer") == "subject_locked"
        or (d.get("target") is not None and d.get("target") != "subject")
        or d.get("post") is not None
        or mid in PLANE_CROSSING_IDS
    )


def split_ids(visible_ids):
    """Partition catalog-visible ids into (core, rig) preserving order."""
    core = [m for m in visible_ids if not is_rig_move(m)]
    rig = [m for m in visible_ids if is_rig_move(m)]
    return core, rig
