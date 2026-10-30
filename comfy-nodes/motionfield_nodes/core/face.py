"""Whole-face mask built from 68-point face landmarks.

The face-swap edit region is the jaw line plus the brow span, extended above
the brows by ~55% of the brow-to-chin height — convex-hulled, dilated and
feathered so the composite has no hard edge. A frame with too few confident
landmarks gets an empty mask, exactly like the mouth variant.
"""

import cv2
import numpy as np

# 68-pt face layout: 0–16 jaw, 17–26 brows. The swap region is their hull
# plus a forehead strip the landmarks don't cover.
_JAW = range(0, 17)
_BROWS = range(17, 27)

MIN_KP_SCORE = 0.3
_MIN_POINTS = 8

# forehead ≈ this fraction of the brow→chin height, added above the brow line
_FOREHEAD_FRACTION = 0.55
# forehead strip half-width as a fraction of the face's jaw width
_FOREHEAD_HALF_WIDTH = 0.38


def _valid_points(points, indices):
    pts = np.asarray(points, dtype=np.float64)
    xy = []
    for i in indices:
        x, y = pts[i][0], pts[i][1]
        score = pts[i][2] if pts.shape[1] > 2 else 1.0
        if np.isfinite(x) and np.isfinite(y) and score >= MIN_KP_SCORE:
            xy.append([x, y])
    return xy


def face_mask_from_landmarks(points, width, height, dilate_px=10, feather_px=12):
    """One frame's whole-face mask — float32 HxW, 0..1.

    ``points`` is the 68-pt face array: (x, y) or (x, y, score) rows. Jaw +
    brow points hull the lower face; two forehead points extend the region
    above the brows. Returns an all-zero mask when the face isn't there.
    """
    mask = np.zeros((int(height), int(width)), dtype=np.float32)
    jaw = _valid_points(points, _JAW)
    brow = _valid_points(points, _BROWS)
    if len(jaw) + len(brow) < _MIN_POINTS:
        return mask
    jaw_arr = np.asarray(jaw, dtype=np.float64)
    brow_arr = np.asarray(brow, dtype=np.float64)
    chin_y = float(jaw_arr[:, 1].max())
    brow_y = float(brow_arr[:, 1].mean())
    face_h = max(1.0, chin_y - brow_y)
    face_w = float(jaw_arr[:, 0].max() - jaw_arr[:, 0].min())
    brow_x = float(brow_arr[:, 0].mean())
    top_y = brow_y - _FOREHEAD_FRACTION * face_h
    forehead = [
        [brow_x - _FOREHEAD_HALF_WIDTH * face_w, top_y],
        [brow_x + _FOREHEAD_HALF_WIDTH * face_w, top_y],
    ]
    hull_pts = np.asarray(jaw + brow + forehead, dtype=np.float32).reshape(-1, 1, 2)
    hull = cv2.convexHull(hull_pts)
    cv2.fillConvexPoly(mask, np.rint(hull).astype(np.int32), 1.0)
    if dilate_px > 0:
        k = 2 * int(dilate_px) + 1
        mask = cv2.dilate(mask, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k)))
    if feather_px > 0:
        k = int(feather_px) | 1  # gaussian kernels must be odd
        mask = cv2.GaussianBlur(mask, (k, k), 0)
    return np.clip(mask, 0.0, 1.0)
