"""Camera rig — re-renders a source image along a camera trajectory (numpy only).

The source frame is unprojected to a world-space point cloud with a depth map
and a pinhole camera at the pose stream's frame-0 fov. Each pose then
z-buffer-splats the cloud (camera_splat.project's convention — the trajectory
engine's world frame); the nearest point wins. Pixels nothing lands on come
back as the hole mask — downstream (WanVaceToVideo) fills those.

Depth handling: the "most direct" read wins — DA3Mono raw output is already
depth (larger = farther); a disparity-style map (larger = nearer) is inverted
first. Units don't matter: the cloud is scaled so the median depth of the
centre 20% equals the trajectory distance — use the pose distance only for
scale.
"""
import json
import math

import numpy as np

from . import camera_splat as splat

DEG = math.pi / 180.0
SPLAT_MIN, SPLAT_MAX = 1, 4  # splat radius bounds, px
REF_RADIUS = 2.0             # radius a point at the trajectory distance lands


def load_poses(poses_json):
    frames = json.loads(poses_json)
    if not isinstance(frames, list) or not frames:
        raise ValueError("poses_json must decode to a non-empty frame list")
    for f in frames:
        for k in ("pos", "yaw", "pitch", "roll", "fov"):
            if k not in f:
                raise ValueError(f'pose is missing "{k}"')
    return frames


def _grey(depth_img):
    d = np.asarray(depth_img, dtype=np.float64)
    if d.ndim == 4:
        d = d[0]
    if d.ndim == 3:
        d = d[..., :3].mean(axis=-1)
    if d.ndim != 2:
        raise ValueError(f"depth must be (H,W) or (H,W,3); got {d.shape}")
    return d


def _looks_disparity(g):
    """Sky prior: far content sits high in the frame, so a map whose top rows
    read clearly *smaller* than its bottom rows is likely disparity."""
    band = max(1, g.shape[0] // 8)
    top = float(np.median(g[:band]))
    bot = float(np.median(g[-band:]))
    return top < 0.5 * bot


def depth_to_metres(depth_img, distance, mode="auto"):
    """Depth map → metres. `mode` is auto/depth/disparity/metres; the first
    three are scaled so the median depth of the centre 20% equals the
    trajectory distance. "metres" trusts the values (DA3 poses are emitted
    in the same rescaled frame)."""
    if mode not in ("auto", "depth", "disparity", "metres"):
        raise ValueError(f'unknown depth_mode "{mode}"')
    g = _grey(depth_img)
    if mode == "metres":
        return np.clip(np.where(np.isfinite(g), g, 1e6), 1e-4, 1e6)
    if mode == "disparity" or (mode == "auto" and _looks_disparity(g)):
        span = float(np.ptp(g)) or 1.0
        g = 1.0 / np.maximum(g - float(np.percentile(g, 1.0)) + 0.05 * span, 1e-6)
    g = np.where(np.isfinite(g), g, np.inf)
    h, w = g.shape
    cy0, cx0 = int(0.4 * h), int(0.4 * w)
    centre = g[cy0:max(cy0 + 1, int(0.6 * h)), cx0:max(cx0 + 1, int(0.6 * w))]
    centre = centre[np.isfinite(centre)]
    med = float(np.median(centre)) if centre.size else 0.0
    if not np.isfinite(med) or med <= 1e-9:
        med = 1.0
    z = g * (float(distance) / med)
    return np.clip(z, 1e-4, 1e6)


def depths_to_metres(depth_stack, distance, mode="auto"):
    """(N,H,W[,C]) clip depth → (N,H,W) metres. ONE scale for the whole clip —
    frame 0's centre median sets it (per-frame rescaling would make the world
    breathe against the fixed trajectory). mode "metres" trusts the values."""
    ds = np.asarray(depth_stack, dtype=np.float64)
    if ds.ndim == 4:
        ds = ds[..., :3].mean(axis=-1)
    if ds.ndim != 3:
        raise ValueError(f"depth stack must be (N,H,W[,C]); got {ds.shape}")
    if mode == "metres":
        return np.clip(np.where(np.isfinite(ds), ds, 1e6), 1e-4, 1e6)
    if mode == "disparity" or (mode == "auto" and _looks_disparity(ds[0])):
        g0 = ds[0]
        span = float(np.ptp(g0)) or 1.0
        ds = 1.0 / np.maximum(ds - float(np.percentile(g0, 1.0)) + 0.05 * span, 1e-6)
    ds = np.where(np.isfinite(ds), ds, np.inf)
    h, w = ds.shape[1:3]
    cy0, cx0 = int(0.4 * h), int(0.4 * w)
    centre = ds[0][cy0:max(cy0 + 1, int(0.6 * h)), cx0:max(cx0 + 1, int(0.6 * w))]
    centre = centre[np.isfinite(centre)]
    med = float(np.median(centre)) if centre.size else 0.0
    if not np.isfinite(med) or med <= 1e-9:
        med = 1.0
    return np.clip(ds * (float(distance) / med), 1e-4, 1e6)


def unproject(depth_m, pose0, fov0):
    """Depth map → world-space cloud through the frame-0 pinhole camera.

    The inverse of camera_splat.project: q = ((u - W/2)·z/f, (H/2 - v)·z/f, z)
    in the frame-0 camera frame, rotated out by the frame-0 basis."""
    h, w = depth_m.shape
    f = w * 0.5 / math.tan(fov0 * DEG * 0.5)
    u, v = np.meshgrid(np.arange(w, dtype=np.float64), np.arange(h, dtype=np.float64))
    q = np.stack([(u - w * 0.5) * depth_m / f,
                  (h * 0.5 - v) * depth_m / f,
                  depth_m], axis=-1)
    basis = np.stack(splat.rotation(pose0))  # rows: right, up, fwd
    world = q @ basis + np.asarray(pose0["pos"], dtype=np.float64)
    return world.reshape(-1, 3)


EDGE_REL = 0.08     # relative depth range that marks a depth edge
EDGE_RADIUS = 3     # window half-size (px) - spans a DA3-blurred silhouette


def depth_edge_keep(depth_m, rel=EDGE_REL, radius=EDGE_RADIUS):
    """(H,W) metres -> bool keep mask. Monocular depth blurs a silhouette over
    several pixels, so the pixels between a subject and the wall behind it
    unproject to in-between depths: a "curtain" that smears subject colours
    into the disocclusion as the camera moves - and since the curtain is
    covered, it never becomes a hole for VACE to fill. A pixel whose local
    (2r+1)^2 window spans more than `rel` relative depth is dropped; flat
    walls, floors and clothing folds stay well under it."""
    d = np.asarray(depth_m, dtype=np.float64)
    fin = np.isfinite(d)
    lo = np.where(fin, d, np.inf)
    hi = np.where(fin, d, -np.inf)
    r = max(0, int(radius))
    for axis in (0, 1):
        pl = np.pad(lo, [(r, r) if a == axis else (0, 0) for a in (0, 1)], mode="edge")
        ph = np.pad(hi, [(r, r) if a == axis else (0, 0) for a in (0, 1)], mode="edge")
        n = d.shape[axis]
        lo = np.min([np.take(pl, range(k, k + n), axis=axis) for k in range(2 * r + 1)], axis=0)
        hi = np.max([np.take(ph, range(k, k + n), axis=axis) for k in range(2 * r + 1)], axis=0)
    with np.errstate(invalid="ignore", divide="ignore"):
        spread = (hi - lo) / np.maximum(lo, 1e-6)
    return fin & (spread <= float(rel))


def drop_depth_edges(pts, depth_m, rel=EDGE_REL, radius=EDGE_RADIUS):
    """NaN the world points on depth edges - splat_frame skips non-finite
    projections, so those pixels read as holes (VACE fills them)."""
    if rel <= 0:
        return pts
    keep = depth_edge_keep(depth_m, rel, radius).reshape(-1)
    pts = np.array(pts, dtype=np.float64, copy=True)
    pts[~keep] = np.nan
    return pts


_DISC_OFFSETS = {}


def _disc_offsets(radius):
    offs = _DISC_OFFSETS.get(radius)
    if offs is None:
        r = int(math.ceil(radius))
        offs = [(dx, dy) for dy in range(-r, r + 1) for dx in range(-r, r + 1)
                if dx * dx + dy * dy <= radius * radius]
        _DISC_OFFSETS[radius] = offs
    return offs


def splat_frame(pts, cols, pose, width, height, fov_deg, near, ref_depth,
                radius_min=SPLAT_MIN, radius_max=SPLAT_MAX):
    """Z-buffered splat with a per-point disc radius ∝ 1/depth (clamped to
    radius_min..radius_max). Returns (img, holes) — holes are pixels no splat
    covered."""
    sx, sy, qz = splat.project(pts, pose, width, height, fov_deg)
    img = np.zeros((height, width, 3), np.float64)
    zbuf = np.full((height, width), np.inf, np.float64)
    inside = (qz > near) & np.isfinite(sx) & np.isfinite(sy)
    idx = np.nonzero(inside)[0]
    if not idx.size:
        return img, np.ones((height, width), bool)
    cx, cy, z = sx[idx], sy[idx], qz[idx]
    radii = np.clip(np.rint(REF_RADIUS * ref_depth / z).astype(np.int64),
                    radius_min, radius_max)
    ix, iy = np.rint(cx).astype(np.int64), np.rint(cy).astype(np.int64)

    # depth pass grouped by splat radius — one scatter per disc offset
    for r in range(radius_min, radius_max + 1):
        sel = radii == r
        if not sel.any():
            continue
        px_, py_, pz_ = ix[sel], iy[sel], z[sel]
        pxc, pyc = cx[sel], cy[sel]
        for dx, dy in _disc_offsets(r):
            tx, ty = px_ + dx, py_ + dy
            m = ((tx - pxc) ** 2 + (ty - pyc) ** 2 <= r * r
                 ) & (tx >= 0) & (tx < width) & (ty >= 0) & (ty < height)
            if m.any():
                np.minimum.at(zbuf, (ty[m], tx[m]), pz_[m])
    # colour pass — a point only paints pixels it still owns in the z-buffer
    for r in range(radius_min, radius_max + 1):
        sel = radii == r
        if not sel.any():
            continue
        px_, py_, pz_ = ix[sel], iy[sel], z[sel]
        pxc, pyc, pc_ = cx[sel], cy[sel], cols[idx[sel]]
        for dx, dy in _disc_offsets(r):
            tx, ty = px_ + dx, py_ + dy
            m = ((tx - pxc) ** 2 + (ty - pyc) ** 2 <= r * r
                 ) & (tx >= 0) & (tx < width) & (ty >= 0) & (ty < height)
            if not m.any():
                continue
            ty2, tx2 = ty[m], tx[m]
            own = zbuf[ty2, tx2] == pz_[m]
            img[ty2[own], tx2[own]] = pc_[m][own]
    return img, zbuf == np.inf


def dilate(mask, px):
    """4-neighbour binary dilation — grows the hole mask over splat seams."""
    m = np.asarray(mask, dtype=bool)
    for _ in range(max(0, int(px))):
        p = np.pad(m, 1, mode="constant")
        m = p[1:-1, 1:-1] | p[:-2, 1:-1] | p[2:, 1:-1] | p[1:-1, :-2] | p[1:-1, 2:]
    return m


def _resize_cover(a, w, h):
    """Centre-crop to the target aspect, then bilinear-resize — a direct
    stretch to (w,h) would skew the world when the source aspect differs.
    Depth gets the same crop as the image because it shares the aspect."""
    a = np.asarray(a, dtype=np.float64)
    ih, iw = a.shape[:2]
    src_ar = iw / ih
    dst_ar = w / h
    if src_ar > dst_ar + 1e-9:           # too wide — crop the sides
        cw = int(round(ih * dst_ar))
        x0 = (iw - cw) // 2
        a = a[:, x0:x0 + cw]
    elif src_ar < dst_ar - 1e-9:         # too tall — crop top/bottom
        ch = int(round(iw / dst_ar))
        y0 = (ih - ch) // 2
        a = a[y0:y0 + ch, :]
    return _resize_bilinear(a, w, h)


def _resize_bilinear(a, w, h):
    """(H,W[,C]) → (h,w) bilinear via separable interpolation."""
    a = np.asarray(a, dtype=np.float64)
    ih, iw = a.shape[:2]
    if (iw, ih) == (w, h):
        return a
    ys = (np.arange(h) + 0.5) * ih / h - 0.5
    xs = (np.arange(w) + 0.5) * iw / w - 0.5
    y0 = np.clip(np.floor(ys).astype(np.int64), 0, ih - 1)
    y1 = np.clip(y0 + 1, 0, ih - 1)
    x0 = np.clip(np.floor(xs).astype(np.int64), 0, iw - 1)
    x1 = np.clip(x0 + 1, 0, iw - 1)
    wy = (ys - np.floor(ys)).clip(0, 1)[:, None]
    wx = (xs - np.floor(xs)).clip(0, 1)[None, :]
    if a.ndim == 3:
        wy = wy[..., None]
        wx = wx[..., None]
    top = a[y0][:, x0] * (1 - wx) + a[y0][:, x1] * wx
    bot = a[y1][:, x0] * (1 - wx) + a[y1][:, x1] * wx
    return top * (1 - wy) + bot * wy


def render(source_rgb, depth_m, poses, near=0.05, hole_dilate_px=3,
           out_size=None):
    """Full rig pass: unproject the source, splat every pose.

    `source_rgb` is (H,W,3) float in [0,1]; `depth_m` is metres (same aspect).
    Returns (frames, holes, control): frames and control are lists of
    (H,W,3) float32, holes a list of bool (H,W); holes are dilated by
    hole_dilate_px before both masks and the 0.5-grey control use them."""
    pose0 = poses[0]
    img = np.asarray(source_rgb, dtype=np.float64)
    depth = np.asarray(depth_m, dtype=np.float64)
    if out_size is not None:
        ow, oh = int(out_size[0]), int(out_size[1])
        img = _resize_cover(img, ow, oh)
        depth = _resize_cover(depth, ow, oh)
    h, w = img.shape[:2]
    if depth.shape != (h, w):
        depth = _resize_bilinear(depth, w, h)
    pts = drop_depth_edges(unproject(depth, pose0, pose0["fov"]), depth)
    cols = img.reshape(-1, 3)
    ref_depth = float(np.median(depth[np.isfinite(depth)]))

    frames, holes, control = [], [], []
    for pose in poses:
        fr, hole = splat_frame(pts, cols, pose, w, h, pose["fov"], near, ref_depth)
        hole = dilate(hole, hole_dilate_px)
        ctl = fr.copy()
        ctl[hole] = 0.5
        frames.append(fr.astype(np.float32))
        holes.append(hole)
        control.append(ctl.astype(np.float32))
    return frames, holes, control


def _sample_affine(img, matte, A, centre_src, centre_dst, bbox):
    """Inverse-map the bbox through affine A (target→source around the two
    centres); bilinear-sample img, threshold the matte. Returns
    (footprint, rgb) local to bbox."""
    tx0, ty0, tx1, ty1 = bbox
    yy, xx = np.mgrid[ty0:ty1 + 1, tx0:tx1 + 1]
    rel = np.stack([xx - centre_dst[0], yy - centre_dst[1]], axis=-1)
    src = rel @ A.T + np.asarray(centre_src, dtype=np.float64)
    sx, sy = src[..., 0], src[..., 1]
    ih, iw = img.shape[:2]
    inside = (sx >= 0) & (sx <= iw - 1) & (sy >= 0) & (sy <= ih - 1)
    x0 = np.clip(np.floor(sx).astype(np.int64), 0, iw - 1)
    x1 = np.clip(x0 + 1, 0, iw - 1)
    y0 = np.clip(np.floor(sy).astype(np.int64), 0, ih - 1)
    y1 = np.clip(y0 + 1, 0, ih - 1)
    wx = (sx - np.floor(sx)).clip(0, 1)
    wy = (sy - np.floor(sy)).clip(0, 1)
    m = (matte[y0, x0] * (1 - wx) * (1 - wy) + matte[y0, x1] * wx * (1 - wy)
         + matte[y1, x0] * (1 - wx) * wy + matte[y1, x1] * wx * wy)
    foot = inside & (m > 0.5)
    wxf = np.where(foot, wx, 0.0)[..., None]
    wyf = np.where(foot, wy, 0.0)[..., None]
    rgb = (img[y0, x0] * (1 - wxf) * (1 - wyf) + img[y0, x1] * wxf * (1 - wyf)
           + img[y1, x0] * (1 - wxf) * wyf + img[y1, x1] * wxf * wyf)
    return foot, rgb


def _billboard(sub, depth_m, src_pose, new_pose, w, h, near):
    """Where the new camera puts the matte'd subject, and how big it reads.

    The matte centroid unprojects through the SOURCE pose at its own depth,
    then projects through the NEW pose — the subject's screen centre, scale,
    roll and foreshortening all follow the commanded path (a pin-at-coords
    copy can't: a dolly leaves a pinned subject the same size while the
    world grows around it). Foreshortening is the view-direction cosine —
    a flat billboard approximation of the subject's unseen side; past a
    ~65° azimuth swing the approximation stops reading, and the caller
    sends the subject to the hole mask for VACE to invent instead.
    Returns (A, centre_src, centre_dst, bbox) or None when the projection
    is implausible (behind the camera, absurd scale, back-facing)."""
    ys, xs = np.nonzero(sub)
    if xs.size < 16:
        return None
    uc, vc = float(xs.mean()), float(ys.mean())
    dvals = depth_m[sub]
    dvals = dvals[np.isfinite(dvals)]
    if not dvals.size:
        return None
    d = float(np.median(dvals))
    f_src = w * 0.5 / math.tan(src_pose["fov"] * DEG * 0.5)
    q = np.array([(uc - w * 0.5) * d / f_src,
                  (h * 0.5 - vc) * d / f_src, d])
    basis = np.stack(splat.rotation(src_pose))
    W = q @ basis + np.asarray(src_pose["pos"], dtype=np.float64)
    sx_, sy_, qz = splat.project(W.reshape(1, 3), new_pose, w, h, new_pose["fov"])
    z2 = float(qz[0])
    if z2 <= near or not np.isfinite(sx_[0]) or not np.isfinite(sy_[0]):
        return None
    du, dv = float(sx_[0]), float(sy_[0])
    f_new = w * 0.5 / math.tan(new_pose["fov"] * DEG * 0.5)
    k = (f_new / f_src) * (d / z2)
    if not 0.25 <= k <= 4.0:
        return None
    # view-direction change → flat-billboard foreshortening
    v_src = W - np.asarray(src_pose["pos"], dtype=np.float64)
    v_new = W - np.asarray(new_pose["pos"], dtype=np.float64)
    az = math.atan2(v_new[0], v_new[2]) - math.atan2(v_src[0], v_src[2])
    az = (az + math.pi) % (2 * math.pi) - math.pi
    if abs(az) > 65 * DEG:
        return None
    el = (math.atan2(v_new[1], math.hypot(v_new[0], v_new[2]))
          - math.atan2(v_src[1], math.hypot(v_src[0], v_src[2])))
    roll = (new_pose["roll"] - src_pose["roll"]) * DEG
    cs, sn = math.cos(roll), math.sin(roll)
    kx = max(0.3, k * max(0.5, abs(math.cos(az))))
    ky = max(0.3, k * max(0.5, abs(math.cos(el))))
    A = np.array([[cs / kx, sn / kx], [-sn / ky, cs / ky]])
    corners = np.array([[xs.min() - uc, ys.min() - vc], [xs.max() - uc, ys.min() - vc],
                        [xs.min() - uc, ys.max() - vc], [xs.max() - uc, ys.max() - vc]])
    fwd = np.linalg.inv(A)
    tc = corners @ fwd.T + np.array([du, dv])
    tx0 = max(0, int(math.floor(tc[:, 0].min())))
    tx1 = min(w - 1, int(math.ceil(tc[:, 0].max())))
    ty0 = max(0, int(math.floor(tc[:, 1].min())))
    ty1 = min(h - 1, int(math.ceil(tc[:, 1].max())))
    if tx1 <= tx0 or ty1 <= ty0:
        return None
    return A, (uc, vc), (du, dv), (tx0, ty0, tx1, ty1)


def feather(mask, px):
    """Soft-edged version of a binary hole mask — a box blur over a px-wide
    band. WanVaceToVideo's control_masks take a continuous weight: a feather
    blends the generated fill into the kept splat instead of cutting at a
    binary edge."""
    if px <= 0:
        return np.asarray(mask, dtype=bool)
    m = np.asarray(mask, dtype=np.float64)
    return np.clip(_box_blur(m[..., None], max(1, int(round(px))))[..., 0], 0.0, 1.0)


def _lerp_pose(a, b, t):
    """Linear pose interpolation — position, angles and fov all lerp toward
    `b` (the clamp's per-frame step lives entirely inside this move)."""
    out = dict(b)
    out["pos"] = [a["pos"][i] + (b["pos"][i] - a["pos"][i]) * t for i in range(3)]
    for k in ("yaw", "pitch", "roll", "fov"):
        out[k] = float(a[k]) + (float(b[k]) - float(a[k])) * t
    return out


def render_video(frames_rgb, depth_m, src_poses, new_poses, near=0.05,
                 hole_dilate_px=3, out_size=None, subject_masks=None,
                 subject_mode="billboard", hole_feather_px=0.0,
                 hole_clamp=0.0):
    """Re-shoot a clip: frame t unprojects its OWN depth through the source
    camera's recovered pose t, then splats through the NEW pose t — the
    composed path replaces the source camera's move outright.

    `frames_rgb` is (N,H,W,3) in [0,1], `depth_m` (N,H,W) metres; src_poses
    and new_poses are pose-dict lists. Exactly N frames render — a path that
    runs long is clipped at the decoded batch, but FEWER poses than frames
    is a hard error (the spec lied about timing). Returns (frames, holes,
    control) — the same list shapes as render(); holes are float (feathered
    when hole_feather_px > 0).

    `subject_masks` (N,H,W) bool is the moving-subject matte (BiRefNet on
    the source frames). A moving subject is non-rigid — depth-projecting it
    smears it across the frame. subject_mode picks the treatment:
      "billboard" — the matte is re-placed where the new camera puts the
                    subject (projected centre, scale, roll, foreshortening);
                    a ~2 px ring around it stays a hole so VACE blends the
                    seam. Implausible projections (past ~65° of orbit, out
                    of frame, extreme scale) send the subject to the holes.
      "pin"       — legacy: matte pixels copy through at identical coords.
      "splat"     — the subject depth-projects like the world (VACE keeps
                    the smear — it is not a hole).
      "hole"      — the subject is always a hole: VACE regenerates it.

    `hole_clamp` (0 = off) caps each frame's raw hole fraction: when a pose
    disoccludes more than that share of the frame, the per-frame step is
    halved toward the last EXECUTED pose (≤6 halvings) until it fits — the
    camera slows rather than asking VACE to invent most of a black frame.
    Executed coverage then honestly drops below the commanded drift."""
    imgs = np.asarray(frames_rgb, dtype=np.float64)
    deps = np.asarray(depth_m, dtype=np.float64)
    subs = None
    if subject_masks is not None:
        subs = np.asarray(subject_masks)
        if subs.shape[:1] != imgs.shape[:1]:
            raise ValueError(
                f"subject_mask has {subs.shape[0]} frames for a {imgs.shape[0]}-frame clip")
        if subs.ndim == 4:  # (N,H,W,1+) — single-channel mask squeezed
            subs = subs[..., 0]
        subs = subs > 0.5
    n = imgs.shape[0]
    if deps.shape[0] < n or len(src_poses) < n or len(new_poses) < n:
        raise ValueError(
            f"video rig wants {n} of everything — got {deps.shape[0]} depth, "
            f"{len(src_poses)} source poses, {len(new_poses)} path poses")
    if out_size is not None:
        ow, oh = int(out_size[0]), int(out_size[1])
        imgs = np.stack([_resize_cover(f, ow, oh) for f in imgs])
        deps = np.stack([_resize_cover(d, ow, oh) for d in deps])
    h, w = imgs.shape[1:3]
    if deps.shape[1:3] != (h, w):
        deps = np.stack([_resize_bilinear(d, w, h) for d in deps])
    if subs is not None and subs.shape[1:3] != (h, w):
        subs = np.stack([_resize_bilinear(s.astype(np.float64), w, h) > 0.5 for s in subs])

    frames, holes, control = [], [], []
    executed = []
    for i in range(n):
        pose = new_poses[i]
        src = src_poses[i]
        di = deps[i]
        pts = drop_depth_edges(unproject(di, src, src["fov"]), di)
        if subs is not None and subject_mode != "splat":
            # billboard/pin/hole place or regenerate the subject on their own;
            # its world copy would splat unmasked at the old depth and VACE
            # paints that smear as a dark ghost beside the subject - drop it
            # so the area behind the subject is an honest disocclusion
            pts[subs[i].reshape(-1)] = np.nan
        finite = di[np.isfinite(di)]
        ref_depth = float(np.median(finite)) if finite.size else 1.0
        # re-shoot splats a dense per-pixel cloud through a warped lattice —
        # the radius-1 plus disc leaves diagonal gaps, so floor at 2
        fr, hole = splat_frame(pts, imgs[i].reshape(-1, 3), pose, w, h,
                               pose["fov"], near, ref_depth, radius_min=2)
        hole = dilate(hole, hole_dilate_px)
        if hole_clamp > 0.0 and executed:
            step = 1.0
            while float(hole.mean()) > hole_clamp and step > 1.0 / 64:
                step *= 0.5
                pose = _lerp_pose(executed[-1], new_poses[i], step)
                fr, hole = splat_frame(pts, imgs[i].reshape(-1, 3), pose, w, h,
                                       pose["fov"], near, ref_depth, radius_min=2)
                hole = dilate(hole, hole_dilate_px)
            if float(hole.mean()) > hole_clamp:
                # even the smallest step overflows — the camera holds its
                # last pose rather than handing VACE a mostly-black frame
                pose = executed[-1]
                fr, hole = splat_frame(pts, imgs[i].reshape(-1, 3), pose, w, h,
                                       pose["fov"], near, ref_depth, radius_min=2)
                hole = dilate(hole, hole_dilate_px)
        if subs is not None:
            sub = subs[i]
            if subject_mode == "pin":
                fr[sub] = imgs[i][sub]
                hole[sub] = False
            elif subject_mode == "hole":
                hole[sub] = True
            elif subject_mode == "billboard":
                placed = _billboard(sub, di, src, pose, w, h, near)
                if placed is None:
                    # can't place it honestly — VACE invents it
                    hole[sub] = True
                else:
                    A, cs_, cd, (tx0, ty0, tx1, ty1) = placed
                    foot, rgb = _sample_affine(imgs[i], sub.astype(np.float64),
                                               A, cs_, cd, (tx0, ty0, tx1, ty1))
                    region = fr[ty0:ty1 + 1, tx0:tx1 + 1]
                    region[foot] = rgb[foot]
                    fp = np.zeros((h, w), bool)
                    fp[ty0:ty1 + 1, tx0:tx1 + 1] = foot
                    hole[fp] = False
                    # a thin ring around the billboard stays a hole — VACE
                    # blends the seam instead of cutting at the matte edge
                    hole[dilate(fp, 2) & ~fp] = True
            # "splat": nothing to do — the subject already rendered with the
            # world (its own depth decided where it lands)
        hole_soft = feather(hole, hole_feather_px)
        ctl = fr.copy()
        ctl[hole_soft >= 0.5] = 0.5
        frames.append(fr.astype(np.float32))
        holes.append(hole_soft)
        control.append(ctl.astype(np.float32))
        executed.append(pose)
    return frames, holes, control


def pad_frames(frames, holes, control, pad_to):
    """Repeat the last rendered frame until len == pad_to (the 4n+1 latent
    count). Deliberate — a repeated frame keeps frame-exact timing with the source;
    nothing is silently dropped."""
    while len(frames) < pad_to:
        frames.append(frames[-1])
        holes.append(holes[-1])
        control.append(control[-1])
    return frames, holes, control


def _box_blur(img, radius):
    """separable box blur — keeps the checker free of heavy deps."""
    if radius <= 0:
        return img
    k = 2 * int(radius) + 1
    # asymmetric pad: the cumsum window reads k cells, so the padded length
    # must be N+k (k//2+1 leading, k//2 trailing) or the output loses a pixel
    acc = np.cumsum(np.pad(img, ((k // 2 + 1, k // 2), (0, 0), (0, 0)), mode="edge"), axis=0)
    img = (acc[k:] - acc[:-k]) / k
    acc = np.cumsum(np.pad(img, ((0, 0), (k // 2 + 1, k // 2), (0, 0)), mode="edge"), axis=1)
    return (acc[:, k:] - acc[:, :-k]) / k


def depth_of_field(img, depth_m, aperture_px=6.0, focus=None):
    """Depth of field: blur radius grows with |1 - focus/depth|. `focus` is the
    in-focus distance in metres (per-frame values come from the pose's `focus`
    field upstream)."""
    img = np.asarray(img, dtype=np.float64)
    z = np.asarray(depth_m, dtype=np.float64)
    if z.shape != img.shape[:2]:
        z = _resize_bilinear(z, img.shape[1], img.shape[0])
    finite = np.isfinite(z) & (z > 1e-9)
    if focus is None:
        focus = float(np.median(z[finite])) if finite.any() else 1.0
    # circle of confusion ∝ aperture · |1 − focus/z|; non-finite depth blurs fully
    coc = np.clip(aperture_px * 0.25 * np.abs(1.0 - focus / np.maximum(z, 1e-4)), 0.0, 1.0)
    coc = np.where(finite, coc, 1.0)
    radius = max(1, int(round(aperture_px)))
    blurred = _box_blur(img, radius)
    if img.ndim == 3:
        out = img * (1 - coc[..., None]) + blurred * coc[..., None]
    else:
        out = img * (1 - coc) + blurred * coc
    return out
