"""Relight math — depth → camera-space normals, then a small shading model.

The same model runs in the browser (src/lib/relight/shade.ts) for the live
preview, so keep the two in step:

  normal map   rgb = n * 0.5 + 0.5, n = (x right, y up, z toward the viewer)
  light dir    d = (sin az · cos el, sin el, cos az · cos el)
               az 0 = from the camera side, 90 = frame right, 180 = behind,
               270 = frame left; el 0 = horizon, 90 = overhead
  diffuse      clamp((n·d + soft) / (1 + soft), 0, 1)        (wrap Lambert)
  rim          clamp(-d.z, 0, 1) · (1 - clamp(n.z, 0, 1))² · facing
               facing = mix(1, clamp(n̂xy·d̂xy, 0, 1), |dxy|) — a light straight
               behind rims the whole silhouette, a side-back light one edge
  shade        ambient · ambient_rgb + Σ power · rgb · (diffuse + 0.8 · rim)
  delight      photo / (L_blur / mean L_blur) ^ (0.6 · strength)  (flattens
               the old light first; L_blur = luminance at 64 px wide, blurred)
  out          delit · mix(1, shade, strength), soft shoulder above 0.8

All colour maths in linear light. Pure numpy — no torch, no model weights.
"""

from __future__ import annotations

import json
import math
from typing import Iterable

import numpy as np

MAX_LIGHTS = 3


def srgb_to_linear(c: np.ndarray) -> np.ndarray:
    c = np.clip(c, 0.0, 1.0)
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def linear_to_srgb(c: np.ndarray) -> np.ndarray:
    c = np.clip(c, 0.0, None)
    return np.clip(np.where(c <= 0.0031308, 12.92 * c, 1.055 * np.power(c, 1 / 2.4) - 0.055), 0.0, 1.0)


def hex_to_linear(h: str) -> np.ndarray:
    h = h.lstrip("#")
    if len(h) != 6:
        raise ValueError(f'colour must be #rrggbb, got "{h}"')
    rgb = np.array([int(h[i:i + 2], 16) / 255.0 for i in (0, 2, 4)])
    return srgb_to_linear(rgb)


def _blur1d(a: np.ndarray, sigma: float, axis: int) -> np.ndarray:
    if sigma <= 0:
        return a
    r = max(1, int(math.ceil(sigma * 3)))
    x = np.arange(-r, r + 1, dtype=np.float64)
    k = np.exp(-(x * x) / (2 * sigma * sigma))
    k /= k.sum()
    pad = [(0, 0)] * a.ndim
    pad[axis] = (r, r)
    p = np.pad(a, pad, mode="edge")
    out = np.zeros_like(a, dtype=np.float64)
    n = a.shape[axis]
    for i, w in enumerate(k):
        sl = [slice(None)] * a.ndim
        sl[axis] = slice(i, i + n)
        out += w * p[tuple(sl)]
    return out


def blur(a: np.ndarray, sigma: float) -> np.ndarray:
    return _blur1d(_blur1d(a, sigma, 0), sigma, 1)


def _resize(a: np.ndarray, h: int, w: int) -> np.ndarray:
    """Bilinear resize of a 2-D array (no scipy/cv2 dependency)."""
    H, W = a.shape
    ys = np.clip((np.arange(h) + 0.5) * H / h - 0.5, 0, H - 1)
    xs = np.clip((np.arange(w) + 0.5) * W / w - 0.5, 0, W - 1)
    y0 = np.floor(ys).astype(int); x0 = np.floor(xs).astype(int)
    y1 = np.minimum(y0 + 1, H - 1); x1 = np.minimum(x0 + 1, W - 1)
    fy = (ys - y0)[:, None]; fx = (xs - x0)[None, :]
    top = a[y0][:, x0] * (1 - fx) + a[y0][:, x1] * fx
    bot = a[y1][:, x0] * (1 - fx) + a[y1][:, x1] * fx
    return top * (1 - fy) + bot * fy


def normals_from_depth(depth: np.ndarray, fov_deg: float = 50.0, smooth: float = 2.0) -> np.ndarray:
    """(H,W) depth (larger = farther) → (H,W,3) unit normals, z toward the viewer."""
    d = np.asarray(depth, dtype=np.float64)
    if d.ndim == 3:
        d = d[..., :3].mean(axis=-1)
    d = np.where(np.isfinite(d), d, np.nanmax(d[np.isfinite(d)]) if np.isfinite(d).any() else 1.0)
    d = np.maximum(d, 1e-4)
    # smoothing scales with size so a 1 MP map and a 256 px preview agree
    d = blur(d, smooth * max(d.shape) / 1024.0)
    h, w = d.shape
    f = (w / 2.0) / math.tan(math.radians(fov_deg) / 2.0)
    u = (np.arange(w) - (w - 1) / 2.0)[None, :]
    v = (np.arange(h) - (h - 1) / 2.0)[:, None]
    X = u / f * d
    Y = -v / f * d
    Z = -d
    P = np.stack([X, Y, Z], axis=-1)
    dPdu = np.gradient(P, axis=1)
    dPdv = np.gradient(P, axis=0)
    n = np.cross(dPdv, dPdu)
    n /= np.maximum(np.linalg.norm(n, axis=-1, keepdims=True), 1e-9)
    # a normal facing away from the camera is a depth discontinuity artefact
    n[..., 2] = np.abs(n[..., 2])
    return n


def encode_normals(n: np.ndarray) -> np.ndarray:
    return np.clip(n * 0.5 + 0.5, 0.0, 1.0)


def decode_normals(rgb: np.ndarray) -> np.ndarray:
    n = np.asarray(rgb, dtype=np.float64)[..., :3] * 2.0 - 1.0
    return n / np.maximum(np.linalg.norm(n, axis=-1, keepdims=True), 1e-9)


def light_dir(az: float, el: float) -> np.ndarray:
    a, e = math.radians(az), math.radians(el)
    return np.array([math.sin(a) * math.cos(e), math.sin(e), math.cos(a) * math.cos(e)])


def parse_lights(spec: str | Iterable[dict]) -> list[dict]:
    """JSON list of {az, el, color, power, soft} → validated lights (≤3)."""
    raw = json.loads(spec) if isinstance(spec, str) else list(spec)
    if not isinstance(raw, list):
        raise ValueError("lights must be a JSON list")
    out = []
    for l in raw[:MAX_LIGHTS]:
        az = float(l.get("az", 0)) % 360.0
        el = min(90.0, max(-30.0, float(l.get("el", 30))))
        power = min(3.0, max(0.0, float(l.get("power", 1.0))))
        soft = min(1.0, max(0.0, float(l.get("soft", 0.4))))
        out.append({"az": az, "el": el, "rgb": hex_to_linear(str(l.get("color", "#ffffff"))), "power": power, "soft": soft})
    return out


def shade(n: np.ndarray, lights: list[dict], ambient: float = 0.35, ambient_rgb: np.ndarray | None = None) -> np.ndarray:
    amb = (ambient_rgb if ambient_rgb is not None else np.ones(3)) * ambient
    s = np.broadcast_to(amb, n.shape).astype(np.float64).copy()
    nz = np.clip(n[..., 2], 0.0, 1.0)
    nxy = n[..., :2]
    nxy_len = np.maximum(np.linalg.norm(nxy, axis=-1), 1e-6)
    for l in lights:
        d = light_dir(l["az"], l["el"])
        ndl = n @ d
        diffuse = np.clip((ndl + l["soft"]) / (1.0 + l["soft"]), 0.0, 1.0)
        dxy = d[:2]
        dxy_len = max(float(np.linalg.norm(dxy)), 1e-6)
        side = np.clip((nxy @ dxy) / (nxy_len * dxy_len), 0.0, 1.0)
        facing = 1.0 + (side - 1.0) * min(1.0, dxy_len)
        rim = max(0.0, -float(d[2])) * (1.0 - nz) ** 2 * facing
        s += (l["power"] * (diffuse + 0.8 * rim))[..., None] * l["rgb"][None, None, :]
    return s


def _illumination(lin: np.ndarray) -> np.ndarray:
    """Large-scale luminance of the photo, normalised to mean 1."""
    L = lin @ np.array([0.2126, 0.7152, 0.0722])
    h, w = L.shape
    sw = 64
    sh = max(1, round(h * sw / w))
    small = _resize(L, sh, sw)
    small = blur(small, 2.0)
    big = _resize(small, h, w)
    return big / max(float(big.mean()), 1e-6)


def relight(img: np.ndarray, normals: np.ndarray, lights: list[dict], ambient: float = 0.35,
            ambient_color: str = "#ffffff", strength: float = 0.85) -> np.ndarray:
    """sRGB (H,W,3) 0..1 + normals (H,W,3) → relit sRGB guide."""
    k = min(1.0, max(0.0, float(strength)))
    lin = srgb_to_linear(np.asarray(img, dtype=np.float64)[..., :3])
    if normals.shape[:2] != lin.shape[:2]:
        normals = np.stack([_resize(normals[..., c], *lin.shape[:2]) for c in range(3)], axis=-1)
        normals /= np.maximum(np.linalg.norm(normals, axis=-1, keepdims=True), 1e-9)
    illum = _illumination(lin)
    delit = lin / np.power(np.maximum(illum, 0.05), 0.6 * k)[..., None]
    s = shade(normals, lights, ambient, hex_to_linear(ambient_color))
    out = delit * (1.0 - k + k * s)
    # soft shoulder: values above 0.8 roll off instead of clipping
    over = np.maximum(out - 0.8, 0.0)
    out = np.where(out > 0.8, 0.8 + over / (1.0 + over / 0.2), out)
    return linear_to_srgb(out)
