"""OF_BoxPlace geometry — normalised-box overlay compositing.

Pure numpy/torch helpers so the node class stays a thin wrapper and the math
is testable under `python -I` (no comfy imports):

  place_overlay(scene, overlay, box, grow_px, feather_px)
      scene   — HxWx3 float32 numpy, the background plate
      overlay — HxWx3 or HxWx4 float32 numpy (alpha = subject matte)
      box     — (x, y, w, h) normalised 0–1
    → (composite[H,W,3], mask[H,W], product_mask[H,W])

The overlay is fit-CONTAINED into the box (aspect preserved, centred — never
squashed). The returned mask is the box rect grown by grow_px with a feather_px
soft edge: 1 inside the harmonise region, 0 outside. product_mask is the placed
alpha in frame coordinates — 0 outside the fitted rect — so a downstream
composite can restore the product's own pixels verbatim after harmonising.
"""

import numpy as np
import torch
import torch.nn.functional as F


def _resize(img: np.ndarray, w: int, h: int) -> np.ndarray:
    t = torch.from_numpy(img).permute(2, 0, 1).unsqueeze(0)
    t = F.interpolate(t, size=(h, w), mode="bilinear", align_corners=False, antialias=True)
    return t.squeeze(0).permute(1, 2, 0).numpy()


def _fit_rect(src_w: int, src_h: int, box_w: int, box_h: int) -> tuple[int, int]:
    """Contain-fit target size: the largest source-aspect rect inside the box."""
    s = min(box_w / max(1, src_w), box_h / max(1, src_h))
    return max(1, round(src_w * s)), max(1, round(src_h * s))


def _feather(mask: np.ndarray, px: int) -> np.ndarray:
    """Soft mask edge, ~px wide. Box-blurred twice so the interior stays 1."""
    if px <= 0:
        return mask
    r = max(1, px // 2)
    t = torch.from_numpy(mask)[None, None]
    k = torch.ones(1, 1, r * 2 + 1, r * 2 + 1) / float((r * 2 + 1) ** 2)
    for _ in range(2):
        t = F.conv2d(F.pad(t, (r, r, r, r), mode="replicate"), k)
    return np.clip(t[0, 0].numpy(), 0.0, 1.0)


def place_overlay(
    scene: np.ndarray,
    overlay: np.ndarray,
    box: tuple[float, float, float, float],
    grow_px: int = 24,
    feather_px: int = 24,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    h, w = scene.shape[:2]
    bx, by, bw, bh = box
    x0 = int(round(max(0.0, bx) * w)); y0 = int(round(max(0.0, by) * h))
    x1 = int(round(min(1.0, bx + bw) * w)); y1 = int(round(min(1.0, by + bh) * h))

    composite = scene.copy()
    product_mask = np.zeros((h, w), np.float32)
    if x1 > x0 and y1 > y0 and overlay.size:
        rgb = overlay[..., :3]
        alpha = overlay[..., 3:4] if overlay.shape[2] >= 4 else np.ones((*overlay.shape[:2], 1), np.float32)
        tw, th = _fit_rect(overlay.shape[1], overlay.shape[0], x1 - x0, y1 - y0)
        ox = x0 + (x1 - x0 - tw) // 2
        oy = y0 + (y1 - y0 - th) // 2
        rgb = _resize(rgb, tw, th)
        alpha = np.clip(_resize(alpha, tw, th), 0.0, 1.0)
        roi = composite[oy:oy + th, ox:ox + tw]
        composite[oy:oy + th, ox:ox + tw] = rgb * alpha + roi * (1.0 - alpha)
        product_mask[oy:oy + th, ox:ox + tw] = alpha[..., 0]

    # region mask: the requested box, grown, then feathered at the edge
    mask = np.zeros((h, w), np.float32)
    gx0 = max(0, x0 - grow_px); gy0 = max(0, y0 - grow_px)
    gx1 = min(w, x1 + grow_px); gy1 = min(h, y1 + grow_px)
    if gx1 > gx0 and gy1 > gy0:
        mask[gy0:gy1, gx0:gx1] = 1.0
    return composite, _feather(mask, feather_px), product_mask
