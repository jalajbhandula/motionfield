"""Lower-face mouth mask built from 68-point face landmarks.

The mask covers the region lip-sync actually rewrites — the outer mouth
contour plus the lower jaw line — as a filled convex hull, dilated and
feathered so the blend has no hard edge. A frame with too few confident
landmarks gets an empty mask: the caller blends nothing there.

Keep in sync with the copy the MuseTalk patch vendors
(scripts/patches/comfyui-musetalk-mps.patch → musetalk/utils/mouth_mask.py).
"""

import cv2
import numpy as np

# 68-pt face layout: 0–16 is the jaw line, 48–59 the outer mouth contour,
# 60–67 the inner mouth. The mask hull is the outer contour plus the front
# jaw span (3–13 — the ear-adjacent points would pull the hull up the cheeks).
_MOUTH_OUTER = range(48, 60)
_LOWER_JAW = range(3, 14)

# a landmark under this score (or NaN) is treated as missing — same bar the
# pose path uses
MIN_KP_SCORE = 0.3
# fewer valid points than this is "no face" — the mask stays empty
_MIN_POINTS = 6


def _valid_points(points, indices):
    pts = np.asarray(points, dtype=np.float64)
    xy = []
    for i in indices:
        x, y = pts[i][0], pts[i][1]
        score = pts[i][2] if pts.shape[1] > 2 else 1.0
        if np.isfinite(x) and np.isfinite(y) and score >= MIN_KP_SCORE:
            xy.append([x, y])
    return xy


def mouth_mask_from_landmarks(points, width, height, dilate_px=6, feather_px=9):
    """One frame's lower-face mask — float32 HxW, 0..1.

    ``points`` is the 68-pt face array for the frame's person: (x, y) or
    (x, y, score) rows; NaN coordinates or scores under MIN_KP_SCORE are
    missing. Returns an all-zero mask when the face isn't really there.
    """
    mask = np.zeros((int(height), int(width)), dtype=np.float32)
    xy = _valid_points(points, _MOUTH_OUTER)
    xy += _valid_points(points, _LOWER_JAW)
    if len(xy) < _MIN_POINTS:
        return mask
    hull = cv2.convexHull(np.asarray(xy, dtype=np.float32).reshape(-1, 1, 2))
    cv2.fillConvexPoly(mask, np.rint(hull).astype(np.int32), 1.0)
    if dilate_px > 0:
        k = 2 * int(dilate_px) + 1
        mask = cv2.dilate(mask, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k)))
    if feather_px > 0:
        k = int(feather_px) | 1  # gaussian kernels must be odd
        mask = cv2.GaussianBlur(mask, (k, k), 0)
    return np.clip(mask, 0.0, 1.0)
