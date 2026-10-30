"""Camera rig - a DA3-style blurred silhouette must not smear a curtain of
subject colour into the disocclusion; those pixels must be holes.

Run via comfy-nodes/tests/run.py.
"""
import numpy as np

from motionfield_nodes.core import camera_rig as rig

W, H, FOV = 96, 64, 40.0


def _scene(blur=4):
    """A 3 m red block on a 4 m grey wall, depth ramped over `blur` px."""
    depth = np.full((H, W), 4.0)
    depth[16:48, 30:60] = 3.0
    for _ in range(blur):  # box-blur the depth like a monocular estimator
        p = np.pad(depth, 1, mode="edge")
        depth = (p[1:-1, 1:-1] + p[:-2, 1:-1] + p[2:, 1:-1] + p[1:-1, :-2] + p[1:-1, 2:]) / 5
    img = np.full((H, W, 3), 0.5)
    img[16:48, 30:60] = (1.0, 0.0, 0.0)
    return img, depth


def _poses(dx=0.5):
    return [{"pos": [0.0, 0.0, 0.0], "yaw": 0.0, "pitch": 0.0, "roll": 0.0, "fov": FOV},
            {"pos": [dx, 0.0, 0.0], "yaw": 0.0, "pitch": 0.0, "roll": 0.0, "fov": FOV}]


def test_edge_mask_drops_the_blurred_band_keeps_flat_surfaces():
    _, depth = _scene()
    keep = rig.depth_edge_keep(depth)
    assert keep[:5, :].all() and keep[-5:, :].all()      # flat wall kept
    assert keep[30:34, 42:48].all()                      # block interior kept
    assert not keep[32, 28:32].any()                     # silhouette band dropped


def test_no_red_curtain_in_the_disocclusion():
    img, depth = _scene()
    frames, holes, _ = rig.render(img, depth, _poses(), hole_dilate_px=0)
    fr, hole = frames[1], holes[1]
    red = (fr[..., 0] > 0.6) & (fr[..., 1] < 0.3)
    # the block moved left in view; every red pixel must belong to one
    # compact block - count red pixels per row outside the block's span
    cols = np.nonzero(red[32])[0]
    assert cols.size and cols.max() - cols.min() <= 32, "red smeared into a curtain"
    assert hole.any(), "the disocclusion must surface as holes for VACE"
