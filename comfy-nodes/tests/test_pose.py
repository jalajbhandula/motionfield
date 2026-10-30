"""Tests for the pose-draw renderer and the OF_DWPose node.

Runs under ``python -I`` via tests/run.py — imports resolve through the pack
root that the runner puts on sys.path.
"""

import numpy as np


def _synthetic_person():
    """One plausible stick figure inside a 128x128 frame, 134 keypoints."""
    kp = np.full((134, 2), -1.0, dtype=np.float32)
    sc = np.zeros(134, dtype=np.float32)
    # body-18 (OpenPose order): nose, neck, shoulders, elbows, wrists,
    # hips, knees, ankles, eyes, ears — a T-pose figure
    body = [
        (64, 20), (64, 30), (48, 34), (36, 48), (28, 62),
        (80, 34), (92, 48), (100, 62), (52, 78), (52, 98), (52, 118),
        (76, 78), (76, 98), (76, 118), (60, 16), (68, 16), (56, 20), (72, 20),
    ]
    kp[:18] = body
    sc[:18] = 0.95
    # feet: big toe / small toe / heel per foot
    kp[18:24] = [(48, 122), (56, 122), (52, 118), (72, 122), (80, 122), (76, 118)]
    sc[18:24] = 0.9
    # face: 68 points on a small ellipse around the nose
    t = np.linspace(0, 2 * np.pi, 68, endpoint=False)
    kp[24:92] = np.stack([64 + 9 * np.cos(t), 22 + 7 * np.sin(t)], axis=1)
    sc[24:92] = 0.85
    # hands: 21 points in a small fan at each wrist
    kp[92:113] = np.stack([28 + 4 * np.cos(t[:21]), 66 + 4 * np.sin(t[:21])], axis=1)
    kp[113:134] = np.stack([100 + 4 * np.cos(t[:21]), 66 + 4 * np.sin(t[:21])], axis=1)
    sc[92:134] = 0.8
    return kp, sc


def test_draw_pose_size_and_skeleton():
    from motionfield_nodes.core.pose_draw import draw_pose

    kp, sc = _synthetic_person()
    img = draw_pose(kp[None], sc[None], 128, 128)
    assert img.shape == (128, 128, 3) and img.dtype == np.uint8
    assert img.sum() > 0, "skeleton should draw non-black pixels"


def test_draw_pose_hides_low_scores():
    from motionfield_nodes.core.pose_draw import draw_pose

    kp, sc = _synthetic_person()
    img = draw_pose(kp[None], np.zeros_like(sc)[None], 128, 128)
    assert img.sum() == 0


def test_draw_pose_openpose_colours():
    """Conventional render coding: limb i at BODY_COLORS[i] x 0.6, joint i at
    BODY_COLORS[i] full brightness; no ear->shoulder limbs, no feet."""
    from motionfield_nodes.core.pose_draw import BODY_COLORS, draw_pose

    kp, sc = _synthetic_person()
    img = draw_pose(kp[None], sc[None], 128, 128)

    def midpoint(a, b):
        x = int(round((kp[a][0] + kp[b][0]) / 2.0))
        y = int(round((kp[a][1] + kp[b][1]) / 2.0))
        return img[y, x]

    np.testing.assert_allclose(midpoint(1, 2), (153, 0, 0), atol=10)
    np.testing.assert_allclose(midpoint(1, 8), (0, 153, 0), atol=10)
    jx, jy = int(round(kp[4][0])), int(round(kp[4][1]))
    np.testing.assert_array_equal(img[jy, jx], BODY_COLORS[4])
    assert (midpoint(2, 16) == 0).all(), "ear->shoulder limb must not be drawn"
    # toe/heel markers stay black unless draw_feet is set (the two heel points
    # coincide with the ankle joints, so only the four toe tips are checked)
    for i in (18, 19, 21, 22):
        fx, fy = int(round(kp[i][0])), int(round(kp[i][1]))
        assert (img[fy, fx] == 0).all(), f"foot keypoint {i} should be black"


def test_wholebody_inserts_neck_and_reorders_134():
    """The vendored Wholebody post-processing must yield the documented 134-point
    layout: input[23:91] (mmpose face) -> output[24:92]."""
    import motionfield_nodes.dwpose_onnx.wholebody as wb_mod

    kp_in = (np.arange(133 * 2, dtype=np.float32).reshape(1, 133, 2)) * 0.5
    sc_in = np.full((1, 133), 0.9, dtype=np.float32)

    orig_det, orig_pose = wb_mod.inference_detector, wb_mod.inference_pose
    wb_mod.inference_detector = lambda sess, img: np.zeros((0, 4), dtype=np.float32)
    wb_mod.inference_pose = lambda sess, det, img: (kp_in, sc_in)
    try:
        wb = wb_mod.Wholebody.__new__(wb_mod.Wholebody)
        wb.session_det = wb.session_pose = None
        kp_out, sc_out = wb(np.zeros((8, 8, 3), dtype=np.uint8))
    finally:
        wb_mod.inference_detector, wb_mod.inference_pose = orig_det, orig_pose

    assert kp_out.shape == (1, 134, 2)
    assert sc_out.shape == (1, 134)
    np.testing.assert_array_equal(kp_out[0, 24:92], kp_in[0, 23:91])
    neck = kp_out[0, 1]
    np.testing.assert_allclose(neck, (kp_in[0, 5] + kp_in[0, 6]) / 2.0)
    # OpenPose r_shoulder (idx 2) <- mmpose idx 6
    np.testing.assert_array_equal(kp_out[0, 2], kp_in[0, 6])


def _fake_detector(persons):
    """A detector stub: ``persons`` is a list of (keypoints, scores) pairs."""
    kp = np.stack([p[0] for p in persons], axis=0) if persons else np.zeros((0, 134, 2), dtype=np.float32)
    sc = np.stack([p[1] for p in persons], axis=0) if persons else np.zeros((0, 134), dtype=np.float32)
    return lambda _img: (kp.astype(np.float32), sc.astype(np.float32))


def _run_with_detector(persons, detect_body=True, detect_hands=True, detect_face=True):
    """OF_DWPose.run with a stubbed detector — no weights needed."""
    import torch
    import motionfield_nodes.nodes_pose as nodes_pose

    frames = np.zeros((2, 128, 128, 3), dtype=np.float32)
    orig = nodes_pose._wholebody
    nodes_pose._wholebody = lambda providers=None: _fake_detector(persons)
    try:
        return nodes_pose.OF_DWPose().run(
            torch.from_numpy(frames), detect_body, detect_hands, detect_face, 512)
    finally:
        nodes_pose._wholebody = orig


def test_of_dwpose_empty_detector_gives_zero_persons():
    try:
        from motionfield_nodes.nodes_pose import OF_DWPose  # noqa: F401
    except Exception as e:
        print(f"SKIP test_of_dwpose_empty_detector_gives_zero_persons: import failed ({e})")
        return
    out_img, out_kp = _run_with_detector([])
    assert out_img.shape[0] == 2
    assert isinstance(out_kp, list) and len(out_kp) == 2
    for entry in out_kp:
        assert entry["persons"] == []
        assert entry["width"] == 128 and entry["height"] == 128
    assert float(out_img.abs().sum()) == 0.0, "no persons must render a black frame"


def test_of_dwpose_drops_low_score_person():
    """The full-frame fallback pose (scores ~0) must be dropped."""
    try:
        from motionfield_nodes.nodes_pose import OF_DWPose  # noqa: F401
    except Exception as e:
        print(f"SKIP test_of_dwpose_drops_low_score_person: import failed ({e})")
        return
    kp, sc = _synthetic_person()
    _, out_kp = _run_with_detector([(kp, np.zeros_like(sc))])
    assert out_kp[0]["persons"] == []


def test_of_dwpose_keypoints_list_and_detect_flags():
    try:
        from motionfield_nodes.nodes_pose import OF_DWPose  # noqa: F401
    except Exception as e:
        print(f"SKIP test_of_dwpose_keypoints_list_and_detect_flags: import failed ({e})")
        return
    kp, sc = _synthetic_person()
    _, out_kp = _run_with_detector([(kp, sc)], detect_face=False)
    assert isinstance(out_kp, list) and len(out_kp) == 2
    for entry in out_kp:
        assert len(entry["persons"]) == 1
        person = entry["persons"][0]
        assert "face" not in person, "detect_face=False must leave face out"
        assert len(person["body"]) == 18
        assert len(person["hand_left"]) == 21


def test_of_dwpose_batch():
    import torch

    try:
        from motionfield_nodes.nodes_pose import OF_DWPose, find_weights
    except Exception as e:  # missing cv2/ort in a bare env
        print(f"SKIP test_of_dwpose_batch: import failed ({e})")
        return
    try:
        det, pose = find_weights()
    except FileNotFoundError as e:
        print(f"SKIP test_of_dwpose_batch: {e}")
        return
    print(f"weights: {det} + {pose}")

    rng = np.random.default_rng(0)
    # a bright blob on a dark field gives the detector something to look at
    frames = rng.random((4, 96, 96, 3), dtype=np.float32) * 0.2
    frames[:, 24:72, 32:64] = 0.9
    image = torch.from_numpy(frames)

    out_img, out_kp = OF_DWPose().run(image, True, True, True, 512)
    assert tuple(out_img.shape) == (4, 96, 96, 3)
    assert out_img.dtype == torch.float32
    assert isinstance(out_kp, list) and len(out_kp) == 4
    for entry in out_kp:
        assert entry["width"] == 96 and entry["height"] == 96
        assert isinstance(entry["persons"], list)
        for person in entry["persons"]:
            assert len(person["body"]) == 18
            assert len(person["feet"]) == 6
            assert len(person["face"]) == 68
            assert len(person["hand_left"]) == 21
            assert len(person["hand_right"]) == 21
