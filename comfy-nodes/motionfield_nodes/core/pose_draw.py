"""Render whole-body pose keypoints to a control image.

Input layout (134 keypoints per person, produced by ``dwpose_onnx.Wholebody``)::

    body  [0:18]    feet   [18:24]   face        [24:92]
    lhand [92:113]  rhand  [113:134]

The canvas is black; the body is drawn as COCO-18 limbs in the conventional
OpenPose colour coding (limbs dimmed, joints bright), hands as 21-point
skeletons, and the face as point markers. Feet markers are drawn only when
``draw_feet`` is set. Only keypoints whose score exceeds ``score_thr`` are
drawn.
"""

import colorsys

import cv2
import numpy as np

NUM_KEYPOINTS = 134
BODY = slice(0, 18)
FEET = slice(18, 24)
FACE = slice(24, 92)
HAND_LEFT = slice(92, 113)
HAND_RIGHT = slice(113, 134)

# COCO-18 limb pairs, 0-indexed, in the conventional OpenPose render order:
# arms, then torso/legs, then head. Ear->shoulder links are BODY_25 extras
# and are not drawn for the 18-point body.
BODY_LIMBS = (
    (1, 2), (1, 5), (2, 3), (3, 4), (5, 6), (6, 7), (1, 8), (8, 9), (9, 10),
    (1, 11), (11, 12), (12, 13), (1, 0), (0, 14), (14, 16), (0, 15), (15, 17),
)
# Conventional per-part colours: limb i is drawn in BODY_COLORS[i] dimmed to
# 60%, joint i in BODY_COLORS[i] at full brightness.
BODY_COLORS = (
    (255, 0, 0), (255, 85, 0), (255, 170, 0), (255, 255, 0), (170, 255, 0),
    (85, 255, 0), (0, 255, 0), (0, 255, 85), (0, 255, 170), (0, 255, 255),
    (0, 170, 255), (0, 85, 255), (0, 0, 255), (85, 0, 255), (170, 0, 255),
    (255, 0, 255), (255, 0, 170), (255, 0, 85),
)
BODY_LIMB_COLORS = tuple(
    tuple(int(round(v * 0.6)) for v in color) for color in BODY_COLORS
)

# 21-keypoint hand skeleton, 0-indexed.
HAND_EDGES = (
    (0, 1), (1, 2), (2, 3), (3, 4), (0, 5), (5, 6), (6, 7), (7, 8), (0, 9),
    (9, 10), (10, 11), (11, 12), (0, 13), (13, 14), (14, 15), (15, 16),
    (0, 17), (17, 18), (18, 19), (19, 20),
)


def _hand_color(index, total):
    r, g, b = colorsys.hsv_to_rgb(index / float(total), 1.0, 1.0)
    return int(r * 255), int(g * 255), int(b * 255)


def _visible(points, scores, i, score_thr):
    return scores[i] > score_thr and np.isfinite(points[i]).all()


def _draw_limbs(canvas, points, scores, pairs, colors, thickness, score_thr):
    for i, (a, b) in enumerate(pairs):
        if not (_visible(points, scores, a, score_thr) and _visible(points, scores, b, score_thr)):
            continue
        color = colors[i % len(colors)]
        ax, ay = int(round(points[a][0])), int(round(points[a][1]))
        bx, by = int(round(points[b][0])), int(round(points[b][1]))
        cv2.line(canvas, (ax, ay), (bx, by), color, thickness, cv2.LINE_AA)


def _draw_points(canvas, points, scores, color, radius, score_thr):
    """``color``: a single (r, g, b) tuple, or a sequence cycled per keypoint."""
    if isinstance(color[0], int):
        color = (color,)
    for i in range(len(points)):
        if not _visible(points, scores, i, score_thr):
            continue
        x, y = int(round(points[i][0])), int(round(points[i][1]))
        cv2.circle(canvas, (x, y), radius, color[i % len(color)], -1, cv2.LINE_AA)


def draw_pose(keypoints, scores, height, width, score_thr=0.3, draw_feet=False):
    """Draw every detected person into one pose image.

    ``keypoints``: (N, 134, 2) array-like of x/y coordinates in image space.
    ``scores``: (N, 134) array-like of per-keypoint confidences.
    ``draw_feet``: also mark the six foot keypoints (off by default — the
    conventional render keeps the feet black).
    Returns an RGB uint8 array of shape ``(height, width, 3)``.
    """
    canvas = np.zeros((height, width, 3), dtype=np.uint8)
    keypoints = np.asarray(keypoints, dtype=np.float32)
    scores = np.asarray(scores, dtype=np.float32)
    if keypoints.ndim == 2:
        keypoints = keypoints[None]
        scores = scores[None]

    scale = min(height, width) / 512.0
    limb_t = max(2, int(round(8 * scale)))
    joint_r = max(1, int(round(4 * scale)))
    dot_r = max(1, int(round(3 * scale)))
    hand_t = max(1, int(round(2 * scale)))
    hand_colors = [_hand_color(i, len(HAND_EDGES)) for i in range(len(HAND_EDGES))]

    persons = list(zip(keypoints, scores))
    for person_kp, _ in persons:
        if person_kp.shape[0] < NUM_KEYPOINTS:
            raise ValueError(f"expected >= {NUM_KEYPOINTS} keypoints, got {person_kp.shape[0]}")

    # limbs for every person first, then joints — an overlapped person's
    # skeleton must not paint over a foreground person's joints
    for person_kp, person_sc in persons:
        _draw_limbs(canvas, person_kp[BODY], person_sc[BODY],
                    BODY_LIMBS, BODY_LIMB_COLORS, limb_t, score_thr)
        for sl in (HAND_LEFT, HAND_RIGHT):
            _draw_limbs(canvas, person_kp[sl], person_sc[sl],
                        HAND_EDGES, hand_colors, hand_t, score_thr)
    for person_kp, person_sc in persons:
        _draw_points(canvas, person_kp[BODY], person_sc[BODY],
                     BODY_COLORS, joint_r, score_thr)
        if draw_feet:
            _draw_points(canvas, person_kp[FEET], person_sc[FEET],
                         (255, 200, 200), dot_r, score_thr)
        _draw_points(canvas, person_kp[FACE], person_sc[FACE],
                     (255, 255, 255), dot_r, score_thr)
        for sl in (HAND_LEFT, HAND_RIGHT):
            _draw_points(canvas, person_kp[sl], person_sc[sl],
                         (0, 0, 255), joint_r, score_thr)
    return canvas
