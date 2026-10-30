"""Director rig — cloud filtering, pinhole fill, and the still-render
contract, CPU-verified on synthetic depth.

Run via comfy-nodes/tests/run.py.
"""
import numpy as np

from motionfield_nodes.core import camera_rig as rig
from motionfield_nodes.core import director_rig as drig

W, H, FOV = 96, 64, 40.0


def _poses(dx=0.4):
    return [
        {"pos": [0.0, 0.0, 0.0], "yaw": 0.0, "pitch": 0.0, "roll": 0.0, "fov": FOV},
        {"pos": [dx / 2, 0.0, 0.0], "yaw": 0.0, "pitch": 0.0, "roll": 0.0, "fov": FOV},
        {"pos": [dx, 0.0, 0.0], "yaw": 0.0, "pitch": 0.0, "roll": 0.0, "fov": FOV},
    ]


def _scene():
    """Flat ground at 4 m, a near block on the left, specks in the sky."""
    rng = np.random.default_rng(7)
    img = rng.uniform(0.3, 0.7, (H, W, 3))
    depth = np.full((H, W), 4.0)
    depth[:, : W // 3] = 1.0                       # near block — step edge at W/3
    depth[4, W // 2] = 0.2                       # lone near speck amid far
    depth[8, W // 2 + 6] = 0.25
    return img, depth


def test_cloud_keep_mask_drops_specks_and_far_edges():
    _, depth = _scene()
    keep = drig.cloud_keep_mask(depth)
    assert not keep[4, W // 2]                    # near spike dropped
    assert not keep[8, W // 2 + 6]
    assert keep[20, 20]                           # interior of near block kept
    assert keep[20, W - 10]                       # flat ground kept
    # far side of the 1.0→4.0 step (first far column) is dropped, near kept
    edge = W // 3
    assert keep[20, edge - 1]
    assert not keep[20, edge]


def test_pinhole_fill_closes_checkerboard_leaves_band():
    img = np.zeros((H, W, 3))
    hole = np.zeros((H, W), dtype=bool)
    hole[::2, ::2] = True                         # 1-px checkerboard
    hole[:, W - 12:] = True                       # 12-px disocclusion band
    filled, left = drig.pinhole_fill(img, hole, iters=4)
    assert not left[:, : W - 12].any()            # pinholes closed
    assert left[:, W - 6:].all()                  # band core still open


def test_sky_islands_drop_blobs_keep_surfaces():
    hole = np.ones((H, W), dtype=bool)
    hole[10:H - 10, 10:W - 10] = False          # main mass
    hole[2:9, W - 12:W - 4] = False             # 63-px blob adrift in hole-sea
    out = drig._drop_sky_islands(hole.copy())
    assert out[5, W - 8]                        # blob marked reactive
    assert not out[H // 2, W // 2]              # mass untouched
    big = np.ones((H, W), dtype=bool)
    big[20:50, 20:90] = False                   # 30-px-tall detached slab
    big[5:15, 30:80] = False                    # another, both >2% of frame
    out2 = drig._drop_sky_islands(big.copy())
    assert not out2[8, 50]                      # large detached surface stays


def test_render_still_contract_and_fewer_holes():
    img, depth = _scene()
    poses = _poses()
    frames, holes, control = drig.render_still(img, depth, poses)
    raw_frames, raw_holes, _ = rig.render(img, depth, poses)
    assert len(frames) == len(holes) == len(control) == len(poses)
    assert frames[0].shape == (H, W, 3)
    # last-frame hole coverage must drop vs the raw splat
    assert holes[-1].mean() < raw_holes[-1].mean()
    # control diffuses rim colours through the reactive sea (no flat 0.5)
    ctl = control[-1][holes[-1]]
    if ctl.size:
        assert not np.allclose(ctl, 0.5)
        assert ctl.min() >= 0 and ctl.max() <= 1
    # a dark ghost blob fused inside a bright field is masked reactive
    sky = np.zeros((H, W), dtype=bool)           # fully filled field
    ghost_img = np.full((H, W, 3), 0.6)
    ghost_img[10:16, 10:16] = 0.1                # dark pill fused in sky
    _, gh = drig._drop_color_ghosts(ghost_img, sky)
    assert gh[10:16, 10:16].all()                # pill → reactive
    lamp_img = np.full((H, W, 3), 0.1)
    lamp_img[10:16, 10:16] = 0.9                 # bright lamp on dark tower
    _, gh2 = drig._drop_color_ghosts(lamp_img, sky.copy())
    assert not gh2[10:16, 10:16].any()           # bright-on-dark untouched
