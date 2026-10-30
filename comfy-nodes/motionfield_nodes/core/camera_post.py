"""Post filters for the trajectory harness — the cheap, honest versions of
the "post" tags moves can request (`lens`, `shutter`, `time_sample`).

  lens         — fisheye barrel warp, or a focus pull that blurs by depth
  shutter      — long-exposure temporal accumulation (motion smears)
  time_sample  — retime: return every Nth frame
"""
import math

import numpy as np


def _box_blur(img, iters=1, radius=2):
    out = img.astype(np.float64)
    for _ in range(iters):
        acc = np.zeros_like(out)
        cnt = np.zeros(out.shape[:2], np.float64)
        for dy in range(-radius, radius + 1):
            for dx in range(-radius, radius + 1):
                acc += np.roll(np.roll(out, dy, 0), dx, 1)
                cnt += 1
        out = acc / cnt[..., None]
    return out


def fisheye(img, k=0.5):
    """Barrel warp: r' = r·(1 + k·r²) in normalised screen coords."""
    h, w = img.shape[:2]
    yy, xx = np.mgrid[0:h, 0:w]
    nx = (xx - w / 2.0) / (w / 2.0)
    ny = (yy - h / 2.0) / (h / 2.0)
    r = np.sqrt(nx * nx + ny * ny)
    scale = 1 + k * r * r
    sx = nx * scale * (w / 2.0) + w / 2.0
    sy = ny * scale * (h / 2.0) + h / 2.0
    xi = np.clip(np.rint(sx).astype(np.int64), 0, w - 1)
    yi = np.clip(np.rint(sy).astype(np.int64), 0, h - 1)
    return img[yi, xi]


def focus_pull(img, depth, focus_m, dof=0.35):
    """Blur grows with |depth - focus| — a stand-in for a shallow-focus pull."""
    far = np.abs(depth.astype(np.float64) - focus_m) / max(focus_m, 1e-6) > dof
    far &= np.isfinite(depth)
    blurred = _box_blur(img, iters=2, radius=3)
    out = img.astype(np.float64).copy()
    out[far] = blurred[far]
    return out.astype(img.dtype)


def post_lens(img, depth, post_arg):
    kind = (post_arg or {}).get("lens", "fisheye")
    if kind == "fisheye":
        return fisheye(img, float(post_arg.get("k", 0.5)))
    if kind == "focus_pull":
        # focus distance arrives per-frame via the pose's `focus` field
        return focus_pull(img, depth, float(post_arg.get("focus", depth[np.isfinite(depth)].mean() if np.isfinite(depth).any() else 1.0)))
    return img


def post_shutter(frames, exposure=0.55):
    """Long-exposure accumulation: out_t mixes the past `exposure`·len window."""
    n = len(frames)
    acc = np.zeros_like(frames[0], dtype=np.float64)
    decay = 0.45
    out = []
    for i in range(n):
        acc = acc * decay + frames[i].astype(np.float64)
        out.append(acc / (1 - decay ** (i + 1)) if i < 12 else acc / (1 - decay ** 12))
    return out


def post_time_sample(frames, factor=3):
    return list(frames)[:: max(1, int(factor))]
