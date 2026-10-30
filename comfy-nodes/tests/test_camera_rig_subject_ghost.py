"""Re-shoot - a matted subject must not also splat with the world: that copy
lands unmasked beside the subject and VACE turns it into a dark ghost.

Run via comfy-nodes/tests/run.py.
"""
import numpy as np

from motionfield_nodes.core import camera_rig as rig

W, H, FOV = 96, 64, 40.0


def _clip():
    depth = np.full((1, H, W), 4.0)
    depth[0, 16:48, 40:56] = 2.0                 # subject 2 m in front of a 4 m wall
    img = np.full((1, H, W, 3), 0.5)
    img[0, 16:48, 40:56] = (1.0, 0.0, 0.0)       # red subject on grey
    sub = np.zeros((1, H, W), bool)
    sub[0, 16:48, 40:56] = True
    return img, depth, sub


def _pose(dx):
    return {"pos": [dx, 0.0, 0.0], "yaw": 0.0, "pitch": 0.0, "roll": 0.0, "fov": FOV}


def test_hole_mode_leaves_no_unmasked_subject_copy():
    img, depth, sub = _clip()
    frames, holes, _ = rig.render_video(img, depth, [_pose(0.0)], [_pose(0.6)],
                                        hole_dilate_px=0, subject_masks=sub,
                                        subject_mode="hole")
    fr, hole = frames[0], holes[0] >= 0.5
    red = (fr[..., 0] > 0.6) & (fr[..., 1] < 0.3)
    assert not (red & ~hole).any(), "subject colour splatted outside the hole mask (ghost)"


def test_behind_the_subject_is_a_hole_in_billboard_mode():
    img, depth, sub = _clip()
    frames, holes, _ = rig.render_video(img, depth, [_pose(0.0)], [_pose(0.6)],
                                        hole_dilate_px=0, subject_masks=sub,
                                        subject_mode="billboard")
    fr, hole = frames[0], holes[0] >= 0.5
    red = (fr[..., 0] > 0.6) & (fr[..., 1] < 0.3)
    # every red pixel is the one placed billboard: a single compact block
    cols = np.nonzero(red.any(axis=0))[0]
    assert cols.size and cols.max() - cols.min() <= 24, "a second subject copy was splatted"
    assert hole.any()
