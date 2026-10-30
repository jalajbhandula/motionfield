"""Relight core — normals from depth and the shading model, CPU only."""

import numpy as np

from motionfield_nodes.core import relight as rl


def _sphere(h=96, w=96, r=0.8):
    """Depth of a sphere in front of a far wall (larger = farther)."""
    ys, xs = np.mgrid[-1:1:h * 1j, -1:1:w * 1j]
    rr = xs * xs + ys * ys
    inside = rr < r * r
    d = np.full((h, w), 10.0)
    d[inside] = 3.0 - np.sqrt(r * r - rr[inside])
    return d, inside


def test_flat_wall_faces_the_camera():
    n = rl.normals_from_depth(np.full((40, 60), 5.0), smooth=0)
    assert np.allclose(n[..., 2], 1.0, atol=1e-6)


def test_sphere_normals_point_outward():
    d, inside = _sphere()
    n = rl.normals_from_depth(d, smooth=0.5)
    h, w = d.shape
    left = n[h // 2, int(w * 0.18)]
    right = n[h // 2, int(w * 0.82)]
    top = n[int(h * 0.18), w // 2]
    assert left[0] < -0.3 and right[0] > 0.3, (left, right)
    assert top[1] > 0.3, top


def test_light_from_frame_right_brightens_the_right_side():
    d, inside = _sphere()
    n = rl.normals_from_depth(d, smooth=0.5)
    img = np.full(d.shape + (3,), 0.5)
    lights = rl.parse_lights('[{"az":90,"el":10,"color":"#ffffff","power":1.5,"soft":0.2}]')
    out = rl.relight(img, n, lights, ambient=0.2, strength=1.0)
    h, w = d.shape
    assert out[h // 2, int(w * 0.75)].mean() > out[h // 2, int(w * 0.25)].mean() + 0.1


def test_warm_light_warms():
    n = rl.normals_from_depth(np.full((20, 20), 5.0), smooth=0)
    img = np.full((20, 20, 3), 0.5)
    out = rl.relight(img, n, rl.parse_lights('[{"az":0,"el":20,"color":"#ff9a40","power":1,"soft":0.4}]'), ambient=0.1)
    r, g, b = out[10, 10]
    assert r > b + 0.1


def test_backlight_rims_the_silhouette_only():
    d, inside = _sphere()
    n = rl.normals_from_depth(d, smooth=0.5)
    s = rl.shade(n, rl.parse_lights('[{"az":180,"el":5,"color":"#ffffff","power":1,"soft":0}]'), ambient=0.0)
    h, w = d.shape
    centre = s[h // 2, w // 2].mean()
    edge = s[h // 2, int(w * 0.13)].mean()
    assert edge > centre + 0.05, (edge, centre)


def test_normal_encoding_round_trips_and_lights_are_bounded():
    n = rl.normals_from_depth(_sphere()[0], smooth=0.5)
    back = rl.decode_normals(rl.encode_normals(n))
    assert np.allclose(back, n, atol=1e-6)
    ls = rl.parse_lights('[{"az":400,"el":200,"power":9,"soft":-1},{},{},{},{}]')
    assert len(ls) == 3 and ls[0]["az"] == 40 and ls[0]["el"] == 90 and ls[0]["power"] == 3 and ls[0]["soft"] == 0
