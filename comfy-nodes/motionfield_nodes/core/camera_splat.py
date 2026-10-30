"""Z-buffered point splat renderer for the trajectory harness.

Renders a 3-D point scene through a camera pose — enough to measure a move's
motion signature (parallax, scale, hole coverage) without a full rasterizer.
Projection mirrors the trajectory frame: +z forward, yaw right+, pitch up+.

    R = Ry(yaw) · Rx(-pitch) · Rz(roll)     (world-from-camera)

cam-space q = Rᵀ·(p - pos);  screen = (f·qx/qz, W/2 + f·qx/qz, H/2 - f·qy/qz)
with f = (W/2) / tan(hfov/2).  Pixels a splat never writes stay in the
hole mask.
"""
import math

import numpy as np

DEG = math.pi / 180.0


def rotation(pose):
    """world-from-camera basis vectors: (right, up, forward)."""
    cy, sy = math.cos(pose["yaw"] * DEG), math.sin(pose["yaw"] * DEG)
    cp, sp = math.cos(pose["pitch"] * DEG), math.sin(pose["pitch"] * DEG)
    cr, sr = math.cos(pose["roll"] * DEG), math.sin(pose["roll"] * DEG)
    # R = Ry·Rx(-p)·Rz(r); columns = basis vectors
    right = np.array([cy * cr - sy * sp * sr, cp * sr, -sy * cr - cy * sp * sr])
    up = np.array([-cy * sr - sy * sp * cr, cp * cr, sy * sr - cy * sp * cr])
    fwd = np.array([sy * cp, sp, cy * cp])
    return right, up, fwd


def project(points, pose, width, height, fov_deg):
    """World points → (sx, sy, qz). qz ≤ 0 sits behind the camera."""
    right, up, fwd = rotation(pose)
    d = np.asarray(points, dtype=np.float64) - np.asarray(pose["pos"], dtype=np.float64)
    qx, qy, qz = d @ right, d @ up, d @ fwd
    f = (width / 2.0) / math.tan(fov_deg * DEG / 2.0)
    with np.errstate(divide="ignore", invalid="ignore"):
        sx = np.where(np.abs(qz) > 1e-12, f * qx / qz + width / 2.0, np.inf)
        sy = np.where(np.abs(qz) > 1e-12, height / 2.0 - f * qy / qz, np.inf)
    return sx, sy, qz


def render(points, colors, pose, width, height, fov_deg, radius=2.0, near=0.05):
    """Disc splats at a fixed screen radius, z-buffered by nearest depth.
    Returns (img, holes, depth): img float32 H×W×3 in [0,1], holes bool H×W,
    depth float32 H×W (inf where nothing landed)."""
    pts = np.asarray(points, dtype=np.float64)
    cols = np.asarray(colors, dtype=np.float64)
    sx, sy, qz = project(pts, pose, width, height, fov_deg)
    img = np.zeros((height, width, 3), np.float64)
    depth = np.full((height, width), np.inf, np.float64)

    inside = (qz > near) & np.isfinite(sx) & np.isfinite(sy)
    idx = np.nonzero(inside)[0]
    if not idx.size:
        return img.astype(np.float32), np.ones((height, width), bool), depth.astype(np.float32)
    cx, cy, z = sx[idx], sy[idx], qz[idx]
    ix, iy = np.rint(cx).astype(np.int64), np.rint(cy).astype(np.int64)
    r = int(math.ceil(radius))
    r2 = radius * radius
    r2f = float(r2)
    for dy in range(-r, r + 1):
        for dx in range(-r, r + 1):
            tx, ty = ix + dx, iy + dy
            m = ((tx - cx) ** 2 + (ty - cy) ** 2 <= r2f
                 ) & (tx >= 0) & (tx < width) & (ty >= 0) & (ty < height)
            if m.any():
                np.minimum.at(depth, (ty[m], tx[m]), z[m])
    for dy in range(-r, r + 1):
        for dx in range(-r, r + 1):
            tx, ty = ix + dx, iy + dy
            m = ((tx - cx) ** 2 + (ty - cy) ** 2 <= r2f
                 ) & (tx >= 0) & (tx < width) & (ty >= 0) & (ty < height)
            if not m.any():
                continue
            ty2, tx2, z2 = ty[m], tx[m], z[m]
            own = depth[ty2, tx2] == z2
            img[ty2[own], tx2[own]] = cols[idx[m][own]]
    return img.astype(np.float32), depth == np.inf, depth.astype(np.float32)
