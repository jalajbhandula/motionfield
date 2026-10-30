"""OF_BoxPlace — CPU tests on synthetic frames.

The node must paste the overlay only inside the box, keep the source pixels
elsewhere, preserve the overlay's aspect (contain-fit), and emit a grown mask
whose edge feathers out over the requested distance. The third output is the
placed alpha in frame coordinates — the matte inside the fitted rect, zero
outside it.
"""

import numpy as np


def _scene(w=200, h=160):
    img = np.zeros((h, w, 3), np.float32)
    img[..., 0] = 0.2  # dark red plate
    return img


def _overlay(w=40, h=40, color=(0.0, 0.9, 0.2)):
    ov = np.zeros((h, w, 4), np.float32)
    ov[..., :3] = color
    ov[..., 3] = 1.0  # fully opaque square
    return ov


def _fit(box, w, h, ow, oh):
    """The node's own fitted-rect math, mirrored for assertions."""
    x0 = int(round(box[0] * w)); y0 = int(round(box[1] * h))
    x1 = int(round((box[0] + box[2]) * w)); y1 = int(round((box[1] + box[3]) * h))
    s = min((x1 - x0) / ow, (y1 - y0) / oh)
    tw, th = max(1, round(ow * s)), max(1, round(oh * s))
    return x0 + (x1 - x0 - tw) // 2, y0 + (y1 - y0 - th) // 2, tw, th


def test_places_overlay_inside_box_only():
    from motionfield_nodes.core.box import place_overlay

    scene, ov = _scene(), _overlay()
    comp, mask, _ = place_overlay(scene, ov, (0.25, 0.25, 0.5, 0.5), grow_px=0, feather_px=0)
    cx, cy = scene.shape[1] // 2, scene.shape[0] // 2
    assert comp[cy, cx, 1] > 0.8, "the box centre must carry the overlay colour"
    assert comp[5, 5, 1] == 0.0, "outside the box stays the source"
    np.testing.assert_allclose(comp[5, 5], scene[5, 5])
    # mask is 1 across the box, 0 outside
    assert mask[cy, cx] == 1.0
    assert mask[5, 5] == 0.0


def test_contain_fit_preserves_aspect():
    from motionfield_nodes.core.box import place_overlay

    scene = _scene()
    ov = _overlay(w=80, h=20)  # 4:1 overlay into a square box
    comp, _, _ = place_overlay(scene, ov, (0.1, 0.1, 0.8, 0.8), grow_px=0, feather_px=0)
    green = (comp[..., 1] > 0.5)
    ys, xs = np.nonzero(green)
    # pasted region: box width (160) x ~40 tall — not the full 128-tall box
    assert (xs.max() - xs.min()) > 120
    assert (ys.max() - ys.min()) < 70


def test_grow_and_feather_edges():
    from motionfield_nodes.core.box import place_overlay

    scene, ov = _scene(), _overlay()
    # box 0.4–0.6 of a 200x160 frame → x 80..120, y 64..96
    _, mask, _ = place_overlay(scene, ov, (0.4, 0.4, 0.2, 0.2), grow_px=10, feather_px=10)
    assert mask[80, 110] == 1.0                      # grown edge still solid inside
    assert 0.0 < mask[80, 133] < 1.0 or mask[80, 134] < 1.0  # feathered falloff
    assert mask[80, 150] == 0.0                      # far outside stays 0


def test_partially_out_of_frame_box_clips_and_still_pastes():
    from motionfield_nodes.core.box import place_overlay

    scene, ov = _scene(), _overlay()
    # (0.95,0.95)+0.5 runs off the corner — the visible 10×8 sliver still pastes
    comp, mask, _ = place_overlay(scene, ov, (0.95, 0.95, 0.5, 0.5), grow_px=8, feather_px=4)
    assert comp[156, 195, 1] > 0.5                      # overlay colour in the clipped box
    np.testing.assert_allclose(comp[:100], scene[:100])  # everything far above stays source
    assert mask.sum() > 0                               # the clipped box corner still masks


def test_fully_out_of_frame_box_is_a_passthrough():
    from motionfield_nodes.core.box import place_overlay

    scene, ov = _scene(), _overlay()
    # the catalog validator rejects x/y > 1 before this ever runs, but the node
    # must stay total: no paste, empty masks, no exception
    comp, mask, pmask = place_overlay(scene, ov, (1.1, 1.1, 0.5, 0.5), grow_px=8, feather_px=4)
    np.testing.assert_allclose(comp, scene)
    assert mask.sum() == 0
    assert pmask.sum() == 0


def test_product_mask_is_the_placed_alpha():
    from motionfield_nodes.core.box import place_overlay

    scene, ov = _scene(), _overlay(w=40, h=40)
    box = (0.25, 0.25, 0.5, 0.5)  # 100×80 box; 40² contain-fits to 80×80
    _, _, pm = place_overlay(scene, ov, box, grow_px=0, feather_px=0)
    ox, oy, tw, th = _fit(box, 200, 160, 40, 40)
    # matte inside the box, zero outside the fitted rect
    assert pm[oy + th // 2, ox + tw // 2] == 1.0
    assert pm[5, 5] == 0.0
    assert pm.sum() == float(tw * th)
    nz = np.nonzero(pm)
    assert (nz[1].min(), nz[0].min(), nz[1].max(), nz[0].max()) == (ox, oy, ox + tw - 1, oy + th - 1)
    # sums track the placed alpha — a half-alpha overlay sums to half the rect
    ov2 = _overlay(w=40, h=40); ov2[..., 3] = 0.5
    _, _, pm2 = place_overlay(scene, ov2, box, grow_px=0, feather_px=0)
    np.testing.assert_allclose(pm2.sum(), 0.5 * tw * th, rtol=1e-3)


def test_node_class_contract():
    import torch
    from motionfield_nodes.nodes_box import OF_BoxPlace

    node = OF_BoxPlace()
    scene = torch.from_numpy(_scene()).unsqueeze(0)
    ov = torch.from_numpy(_overlay()).unsqueeze(0)
    img, mask, pmask = node.run(scene, ov, 0.25, 0.25, 0.5, 0.5, 24, 24)
    assert img.shape == (1, 160, 200, 3) and mask.shape == (1, 160, 200) and pmask.shape == (1, 160, 200)
    assert img[0, 80, 100, 1] > 0.8
    assert float(mask[0, 5, 5]) < 0.05  # feather spill is ~0 this far out
    assert float(pmask[0, 80, 100]) == 1.0 and pmask[0, 5, 5] == 0.0
