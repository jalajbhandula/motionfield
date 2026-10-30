"""Unit tests for the trajectory mirror — math, seeds, stacking, lens, and the
TS↔Python golden fixture (agreement within 1e-6).

Run via comfy-nodes/tests/run.py (plain asserts — no pytest)."""
import json
import math
from pathlib import Path

from motionfield_nodes.core import camera_lens as lens
from motionfield_nodes.core import camera_trajectory as cam

REPO_ROOT = Path(__file__).resolve().parents[2]
GOLDEN = REPO_ROOT / "tests" / "fixtures" / "trajectory-golden.json"

SPEC = {"moves": ["dolly-in"], "duration": 2.0, "fps": 24.0, "seed": 7}


def _close(a, b, tol=1e-9):
    return abs(a - b) <= tol


def test_lens_hfov_matches_reference_sensor():
    # 50 mm on Super 35 ≈ 27.95°
    assert abs(lens.h_fov(50, "super35") - 27.95) < 0.1
    assert abs(lens.h_fov(50, "full_frame") - 39.6) < 0.1
    f = lens.focal_for_h_fov(40, "super35")
    assert _close(lens.h_fov(f, "super35"), 40.0)


def test_dolly_zoom_holds_subject_size():
    # d · tan(fov/2) stays constant
    d0, h0 = 4.0, 40.0
    for dist in (3.0, 2.5, 2.0):
        f = lens.dolly_zoom_fov(d0, dist, h0)
        got = dist * math.tan(math.radians(f) / 2)
        want = d0 * math.tan(math.radians(h0) / 2)
        assert _close(got, want, 1e-7)


def test_compose_is_deterministic_per_seed():
    a = cam.compose_trajectory({**SPEC, "moves": ["handheld-run"]})
    b = cam.compose_trajectory({**SPEC, "moves": ["handheld-run"]})
    c = cam.compose_trajectory({**SPEC, "moves": ["handheld-run"], "seed": 8})
    assert a["frames"] == b["frames"]
    assert a["frames"] != c["frames"]


def test_stacking_adds_deltas_and_multiplies_fov():
    push = cam.compose_trajectory({**SPEC, "moves": ["dolly-in"]})
    zoom = cam.compose_trajectory({**SPEC, "moves": ["zoom-in"]})
    both = cam.compose_trajectory({**SPEC, "moves": ["dolly-in", "zoom-in"]})
    for fp, fz, fb in zip(push["frames"], zoom["frames"], both["frames"]):
        assert _close(fb["pos"][2], fp["pos"][2])
        assert _close(fb["fov"], fz["fov"])


def test_aimed_stack_keeps_untargeted_angle_deltas():
    # crane-up aims at the subject; tilt-down's pitch must still land —
    # final pitch = crane's aim pitch + tilt's pitch, within 1e-9
    crane = cam.compose_trajectory({**SPEC, "moves": ["crane-up"]})
    tilt = cam.compose_trajectory({**SPEC, "moves": ["tilt-down"]})
    both = cam.compose_trajectory({**SPEC, "moves": ["crane-up", "tilt-down"]})
    for fc, ft, fb in zip(crane["frames"], tilt["frames"], both["frames"]):
        assert _close(fb["pitch"], fc["pitch"] + ft["pitch"], 1e-9)


def test_aimed_stack_keeps_untargeted_noise():
    arc = cam.compose_trajectory({**SPEC, "moves": ["arc-left-45"], "seed": 9})
    both = cam.compose_trajectory({**SPEC, "moves": ["arc-left-45", "handheld-subtle"], "seed": 9})
    dy = (abs(both["frames"][-1]["yaw"] - arc["frames"][-1]["yaw"])
          + abs(both["frames"][-1]["pitch"] - arc["frames"][-1]["pitch"]))
    assert dy > 1e-6


def test_auto_move_maps_each_subject_class():
    for cls, mid in cam.AUTO_MOVE.items():
        got = cam.compose_trajectory({**SPEC, "moves": ["auto-move"], "subjectClass": cls})
        want = cam.compose_trajectory({**SPEC, "moves": [mid]})
        assert got["moves"] == [mid]
        assert got["frames"] == want["frames"]


def test_unknown_move_and_bad_strength_raise():
    for spec, frag in (
        ({**SPEC, "moves": ["no-such-move"]}, "unknown trajectory"),
        ({**SPEC, "strength": 9}, "strength"),
        ({**SPEC, "moves": ["a", "b", "c", "d"]}, "1-3"),
    ):
        try:
            cam.compose_trajectory(spec)
        except ValueError as e:
            assert frag in str(e), (spec, e)
        else:
            raise AssertionError(f"expected ValueError for {spec}")


def test_locked_off_is_exactly_static():
    t = cam.compose_trajectory({**SPEC, "moves": ["locked-off"]})
    for f in t["frames"]:
        assert f["pos"] == [0.0, 0.0, 0.0]
        assert f["yaw"] == f["pitch"] == f["roll"] == 0.0
        assert _close(f["fov"], 40.0)


def test_every_move_has_a_frame_per_output_frame():
    for mid in cam.MOVES:
        t = cam.compose_trajectory({**SPEC, "moves": [mid], "subjectClass": "product"})
        assert len(t["frames"]) == int(round(2.0 * 24)) + 1
        for f in t["frames"]:
            assert all(math.isfinite(v) for v in (*f["pos"], f["yaw"], f["pitch"], f["roll"], f["fov"]))


def test_golden_fixture_matches_ts():
    golden = json.loads(GOLDEN.read_text())
    for case in golden["cases"]:
        got = cam.compose_trajectory(case["spec"])
        want = case["result"]["frames"]
        assert len(got["frames"]) == len(want), case["spec"]
        for g, w in zip(got["frames"], want):
            for key in ("t", "yaw", "pitch", "roll", "fov"):
                assert _close(g[key], w[key], 1e-6), (case["spec"], key, g[key], w[key])
            for i in range(3):
                assert _close(g["pos"][i], w["pos"][i], 1e-6), (case["spec"], i, g["pos"], w["pos"])
