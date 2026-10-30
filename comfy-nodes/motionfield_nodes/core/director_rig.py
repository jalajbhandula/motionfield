"""Director rig — the still-image re-render tuned for the VACE fill contract.

camera_rig.render() z-buffer-splats the unprojected source and marks every
uncovered pixel a hole. On a real DA3 depth map that produces two failure
kinds that the diffusion fill then has to absorb:

  * specks — source pixels whose depth disagrees with every neighbour
    (monocular noise on sky/haze and 1-px structures like railings). They
    splat to scattered pixels in bright regions and read as dark blobs.
  * checkerboard — a translating camera spreads near geometry past its
    splat-radius coverage, so solid foreground dissolves into a porous
    pattern of true holes; on a push-in the hole mask can reach most of
    the frame and the generator re-invents the subject inside it.

This module renders the same contract (rgb, holes, control) with three
added passes, all numpy:

  1. cloud filter — in SOURCE space, drop pixels that are the far side of a
     depth discontinuity (d > edge_ratio · min neighbour) or an isolated
     near spike (d < min neighbour / spike_ratio). Their removal lands in
     the hole mask, where the fill model does better than their splat did.
  2. wider splat — radius_max is a parameter instead of the 4-px constant,
     so near points get the disc they need at the Director's 832-wide dims.
  3. pinhole fill — after splatting, holes a few px across are flood-filled
     from their rim (iterative neighbour mean, `fill_iters` deep) and stay
     out of the mask; only disocclusions wider than the fill reach VACE.
  4. island + colour-ghost drops — small filled components adrift in the
     hole sea, and compact dark splat clusters fused inside consistent
     bright content (depth-map edge bleeds), become reactive instead of
     feeding VACE blob seeds.
  5. diffused control prior — the reactive sea in the control video is
     painted with rim-diffused colour (pinhole_fill run to closure), not
     flat grey; VACE generates *from* a plausible extension of the frame
     instead of inventing objects on a mid-grey canvas.
"""
import numpy as np

from . import camera_rig as _rig


def cloud_keep_mask(depth_m, edge_ratio=1.8, spike_ratio=2.2):
    """(H,W) metres → bool keep mask: False where a source pixel would splat
    as a speck — the far side of a depth jump (it smears a wall between the
    two surfaces) or an isolated near outlier amid far neighbours."""
    d = np.asarray(depth_m, dtype=np.float64)
    inf = np.inf
    up = np.pad(d, ((1, 0), (0, 0)), mode="constant", constant_values=inf)[:-1]
    dn = np.pad(d, ((0, 1), (0, 0)), mode="constant", constant_values=inf)[1:]
    lf = np.pad(d, ((0, 0), (1, 0)), mode="constant", constant_values=inf)[:, :-1]
    rt = np.pad(d, ((0, 0), (0, 1)), mode="constant", constant_values=inf)[:, 1:]
    nmin = np.minimum(np.minimum(up, dn), np.minimum(lf, rt))
    keep = np.isfinite(d)
    keep &= ~(d > edge_ratio * nmin)        # far side of a discontinuity
    keep &= ~(d * spike_ratio < nmin)       # lone near speck on a far surround
    return keep


def pinhole_fill(img, hole, iters=8):
    """Flood small holes from their rim: each pass paints hole pixels that
    touch filled pixels with the 4-neighbour mean. A hole needs `iters` rims
    to close fully — checkerboard pinholes (≤2 px) vanish on pass one while
    true disocclusion bands stay open. Returns (img, remaining_holes)."""
    img = np.asarray(img, dtype=np.float64).copy()
    hole = np.asarray(hole, dtype=bool).copy()
    for _ in range(max(0, int(iters))):
        if not hole.any():
            break
        filled = ~hole
        acc = np.zeros_like(img)
        cnt = np.zeros(hole.shape, dtype=np.float64)
        for sl_f, sl_t in (  # (filled-view, target-view) per direction
            ((slice(1, None), slice(None)), (slice(None, -1), slice(None))),
            ((slice(None, -1), slice(None)), (slice(1, None), slice(None))),
            ((slice(None), slice(1, None)), (slice(None), slice(None, -1))),
            ((slice(None), slice(None, -1)), (slice(None), slice(1, None))),
        ):
            f = filled[sl_f]
            acc[sl_t] += img[sl_f] * f[..., None] if img.ndim == 3 else img[sl_f] * f
            cnt[sl_t] += f
        can = hole & (cnt > 0)
        if img.ndim == 3:
            img[can] = acc[can] / cnt[can, None]
        else:
            img[can] = acc[can] / cnt[can]
        hole[can] = False
    return img, hole


def _components(mask):
    """4-conn component labels via max-label flood — no scipy."""
    lab = np.where(mask, np.arange(mask.size, dtype=np.int64)
                   .reshape(mask.shape) + 1, 0)
    while True:
        p = np.pad(lab, 1)
        m = np.maximum.reduce([lab, p[:-2, 1:-1], p[2:, 1:-1],
                               p[1:-1, :-2], p[1:-1, 2:]])
        m = np.where(mask, m, 0)
        if (m == lab).all():
            break
        lab = m
    return lab


def _drop_sky_islands(hole, ring_px=3, ring_fill_max=0.1, max_frac=0.02):
    """Splat islands: small filled clumps fully adrift in the hole sea (depth
    specks that survived the source filter and painted a detached blob into
    open sky — VACE materialises them as ghost objects). A component drops
    when its `ring_px` outer ring holds < `ring_fill_max` filled neighbours
    AND it covers < `max_frac` of the frame — a detached near *surface* (a
    foreground block separating under parallax) is real content and stays."""
    filled = ~hole
    if not filled.any():
        return hole
    lab = _components(filled)
    ids, cnt = np.unique(lab[lab > 0], return_counts=True)
    drop = np.zeros_like(hole)
    for cid in ids[(cnt >= 8) & (cnt < max_frac * filled.size)]:
        comp = lab == cid
        ring = _rig.dilate(comp, ring_px) & ~comp
        if ring.any() and (ring & filled).sum() / ring.sum() < ring_fill_max:
            drop |= comp
    return hole | drop


def _drop_color_ghosts(img, hole, lum_delta=0.18, mean_r=32, ring_px=4,
                       max_frac=0.02, ring_fill_min=0.5, ring_out_max=0.3):
    """Depth-map edge bleeds: a cluster of dark source pixels carrying a
    far-depth estimate splats into bright far field (open sky) and paints
    a compact ghost *fused inside* otherwise consistent content — no mask
    island to find, and VACE materialises it as a floating object. A
    filled pixel is an outlier when its luminance sits `lum_delta` below
    the local filled mean (box radius `mean_r` — wide enough that a
    ghost's core still reads the surrounding field, not itself); a small
    coherent outlier component resting on a mostly-filled, consistent
    ring is a ghost — mark it hole and repaint `img` from the local mean.
    Dark-on-dark and bright features (lamp glow, windows, gulls) are
    untouched."""
    filled = ~hole
    if not filled.any():
        return img, hole
    lum = img[..., :3].mean(-1) if img.ndim == 3 else img
    den = _rig._box_blur(filled.astype(np.float64)[..., None], mean_r)[..., 0]
    lmean = (_rig._box_blur((lum * filled)[..., None], mean_r)[..., 0]
             / np.maximum(den, 1e-6))
    out = filled & (den > 0.3) & (lum < lmean - lum_delta)
    if not out.any():
        return img, hole
    lab = _components(out)
    ids, cnt = np.unique(lab[lab > 0], return_counts=True)
    img = img.copy()
    drop = np.zeros_like(hole)
    for cid in ids[(cnt >= 8) & (cnt < max_frac * filled.size)]:
        comp = lab == cid
        ring = _rig.dilate(comp, ring_px) & ~comp
        if (ring.any() and (ring & filled).sum() / ring.sum() >= ring_fill_min
                and (ring & out).sum() / ring.sum() <= ring_out_max):
            drop |= comp
            img[comp] = lmean[comp][..., None] if img.ndim == 3 else lmean[comp]
    return img, hole | drop


def render_still(source_rgb, depth_m, poses, near=0.05, hole_dilate_px=3,
                 out_size=None, edge_ratio=1.8, spike_ratio=2.2,
                 fill_iters=8, radius_max=10):
    """The Director's still re-render — same (frames, holes, control)
    contract as camera_rig.render, with the cloud filter, a wider splat cap
    and the pinhole fill applied per frame."""
    pose0 = poses[0]
    img = np.asarray(source_rgb, dtype=np.float64)
    depth = np.asarray(depth_m, dtype=np.float64)
    if out_size is not None:
        ow, oh = int(out_size[0]), int(out_size[1])
        img = _rig._resize_cover(img, ow, oh)
        depth = _rig._resize_cover(depth, ow, oh)
    h, w = img.shape[:2]
    if depth.shape != (h, w):
        depth = _rig._resize_bilinear(depth, w, h)

    keep = cloud_keep_mask(depth, edge_ratio, spike_ratio)
    keep &= _rig.depth_edge_keep(depth)  # DA3-blurred silhouettes (see camera_rig)
    flat = keep.reshape(-1)
    pts = _rig.unproject(depth, pose0, pose0["fov"])[flat]
    cols = img.reshape(-1, 3)[flat]
    ref_depth = float(np.median(depth[keep])) if keep.any() else 1.0

    frames, holes, control = [], [], []
    for pose in poses:
        fr, hole = _rig.splat_frame(pts, cols, pose, w, h, pose["fov"], near,
                                    ref_depth, radius_max=int(radius_max))
        fr, hole = pinhole_fill(fr, hole, fill_iters)
        hole = _drop_sky_islands(hole)
        fr, hole = _drop_color_ghosts(fr, hole)
        hole = _rig.dilate(hole, hole_dilate_px)
        # reactive regions stay masked for VACE, but the control feeds a
        # rim-diffused prior instead of flat grey — a mid-grey sea invites
        # the fill model to invent objects (the f13 sky-pill), a plausible
        # blurry extension of the rim's own colours does not. Rim-marching
        # leaves 1-px-wide columns on deep seas, so smooth the filled area
        # afterwards — blur passes restricted to the ex-hole mask soften
        # the columns without touching real rim content.
        ctl, _ = pinhole_fill(fr, hole, iters=max(w, h))
        if hole.any():
            for _ in range(10):
                soft = _rig._box_blur(ctl, 4)
                ctl[hole] = soft[hole]
        frames.append(fr.astype(np.float32))
        holes.append(hole)
        control.append(ctl.astype(np.float32))
    return frames, holes, control
