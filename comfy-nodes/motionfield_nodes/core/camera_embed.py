"""Plücker ray conditioning for camera-controlled video models.

Each pose becomes a per-pixel ray map: the camera origin o and ray direction
d of that pixel, expressed in the frame-0 camera frame (the video's
reference frame), packed as six channels [o×d, d]. The Wan camera adapter
(WanCamAdapter, in_dim=24 = 6 channels × 4 packed frames) consumes it.
OF_CameraEmbed wraps this for ComfyUI; motion_check/run.py exercise it on
CPU — no model needed.
"""
import math

import numpy as np

from .camera_splat import rotation

DEG = math.pi / 180.0


def _c2w_cv(pose, translation_scale):
    """Pose {pos, yaw, pitch, roll} → camera-to-world 4×4 in the CV frame the
    ray grid is indexed in (+x right, +y DOWN, +z forward). Our pose basis is
    +x right/+y up/+z forward, so the CV columns are (right, −up, fwd).
    `translation_scale` rescales world positions — the conditioning signal is
    trained on a canonical translation range rather than metres."""
    right, up, fwd = rotation(pose)
    m = np.eye(4, dtype=np.float64)
    m[:3, :3] = np.stack([np.asarray(right), -np.asarray(up), np.asarray(fwd)], axis=1)
    m[:3, 3] = np.asarray(pose["pos"], dtype=np.float64) * float(translation_scale)
    return m


def plucker_embedding(poses, width, height, translation_scale=1.0):
    """Pose stream → (F, H, W, 6) float32: channels [o×d moment, d direction].

    Every pose is expressed relative to frame 0 (rel = c2w0⁻¹ · c2w) — the
    reference frame the model generates from. Ray directions back-project the
    pixel grid through the pose's own fov and are unit length — the Plücker
    convention, and what the native WanCameraEmbedding produces.
    """
    if not poses:
        raise ValueError("plucker_embedding needs at least one pose")
    px, py = np.meshgrid(np.arange(width, dtype=np.float64) + 0.5,
                         np.arange(height, dtype=np.float64) + 0.5)
    mats = [_c2w_cv(p, translation_scale) for p in poses]
    inv0 = np.linalg.inv(mats[0])
    out = np.empty((len(poses), height, width, 6), dtype=np.float64)
    for i, (pose, m) in enumerate(zip(poses, mats)):
        rel = inv0 @ m
        f = width * 0.5 / math.tan(pose["fov"] * DEG * 0.5)
        dx = (px - width * 0.5) / f
        dy = (py - height * 0.5) / f
        d = np.stack([dx, dy, np.ones_like(dx)], axis=-1) @ rel[:3, :3].T
        d /= np.linalg.norm(d, axis=-1, keepdims=True)
        out[i, ..., :3] = np.cross(rel[:3, 3], d)
        out[i, ..., 3:] = d
    return out.astype(np.float32)
