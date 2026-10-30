"""OF_MouthMask — CPU tests on synthetic face landmarks.

The mask must cover the mouth, stay empty with no face, and the node must
import nothing from the BiSeNet face-parse it replaces.
"""

import numpy as np


def _synthetic_face(cx=64.0, cy=64.0, w=30.0, h=44.0):
    """A plausible 68-pt face on a 128x128 frame — jaw ellipse + mouth cluster."""
    pts = np.zeros((68, 2), dtype=np.float64)
    # 0-16: jaw line — an arc across the lower face
    t = np.linspace(np.pi * 0.85, np.pi * 0.15, 17)
    pts[:17] = np.stack([cx + w * np.cos(t), cy + h * 0.55 + h * 0.45 * np.sin(t)], axis=1)
    # 17-26: two brow arcs above the nose (the whole-face hull needs them)
    b = np.linspace(-1.0, 1.0, 5)
    pts[17:22] = np.stack([cx - w * 0.1 - b * w * 0.42, cy - h * 0.35 - 0.05 * h * (1 - b * b)], axis=1)
    pts[22:27] = np.stack([cx + w * 0.1 + b * w * 0.42, cy - h * 0.35 - 0.05 * h * (1 - b * b)], axis=1)
    # 27-30: nose ridge down to the philtrum
    pts[27:31] = [[cx, cy - h * 0.1], [cx, cy], [cx, cy + h * 0.08], [cx, cy + h * 0.16]]
    # 48-59: outer mouth contour — a small ellipse below the nose
    m = np.linspace(0, 2 * np.pi, 12, endpoint=False)
    pts[48:60] = np.stack([cx + w * 0.35 * np.cos(m), cy + h * 0.28 + h * 0.09 * np.sin(m)], axis=1)
    # 60-67: inner mouth
    pts[60:68] = np.stack([cx + w * 0.2 * np.cos(m[:8]), cy + h * 0.28 + h * 0.03 * np.sin(m[:8])], axis=1)
    scores = np.full((68,), 0.9, dtype=np.float64)
    return np.concatenate([pts, scores[:, None]], axis=1)


def test_mouth_mask_covers_the_mouth():
    from motionfield_nodes.core.mouth import mouth_mask_from_landmarks

    face = _synthetic_face()
    mask = mouth_mask_from_landmarks(face, 128, 128, dilate_px=2, feather_px=3)
    assert mask.shape == (128, 128) and mask.dtype == np.float32
    mouth_y, mouth_x = int(round(face[51, 1])), int(round(face[51, 0]))  # upper-lip top
    assert mask[mouth_y, mouth_x] > 0.8, "the mask must cover the mouth"
    assert mask[int(face[8, 1]), int(face[8, 0])] > 0.8, "and reach the chin"
    # forehead stays out — the blend region is lower-face only
    assert mask[10, 64] == 0.0


def test_mouth_mask_empty_without_a_face():
    from motionfield_nodes.core.mouth import mouth_mask_from_landmarks

    face = _synthetic_face()
    face[:, 2] = 0.0  # every point under the score bar
    assert mouth_mask_from_landmarks(face, 128, 128).sum() == 0.0
    face = _synthetic_face()
    face[:60] = np.nan  # mouth + jaw unreadable
    assert mouth_mask_from_landmarks(face, 128, 128).sum() == 0.0


def test_node_emits_mask_per_frame():
    """OF_MouthMask.run with a stubbed detector: face frame → mask, empty → zeros."""
    import torch
    import motionfield_nodes.nodes_mask as nodes_mask

    face = _synthetic_face()
    kp = np.zeros((1, 134, 2), dtype=np.float32)
    sc = np.zeros((1, 134), dtype=np.float32)
    kp[0, 24:92] = face[:, :2]
    sc[0, 24:92] = face[:, 2]
    empty = (np.zeros((0, 134, 2), dtype=np.float32), np.zeros((0, 134), dtype=np.float32))

    calls = [0]
    def fake_detect(detector, _img):
        calls[0] += 1
        return (detector, kp, sc) if calls[0] == 1 else (detector, *empty)

    orig_wb, orig_detect = nodes_mask._wholebody, nodes_mask._detect
    nodes_mask._wholebody = lambda providers=None: object()
    nodes_mask._detect = fake_detect
    try:
        frames = torch.zeros((2, 128, 128, 3))
        (masks,) = nodes_mask.OF_MouthMask().run(frames, 2, 3, 512)
    finally:
        nodes_mask._wholebody, nodes_mask._detect = orig_wb, orig_detect

    assert tuple(masks.shape) == (2, 128, 128)
    assert masks[0].sum() > 0, "a frame with a face must yield a mask"
    assert masks[1].sum() == 0, "a frame without a face yields an empty mask"


def test_no_bisenet_anywhere():
    """The node + geometry must not import or name the BiSeNet face-parse."""
    import pathlib

    root = pathlib.Path(__file__).resolve().parents[1] / "motionfield_nodes"
    banned = ("bisenet", "face_parsing", "face-parse", "79999", "resnet18")
    for src in [root / "nodes_mask.py", root / "core" / "mouth.py"]:
        text = src.read_text().lower()
        for b in banned:
            assert b not in text, f"{src.name} references {b}"


def test_matte_coverage_strip():
    """OF_MatteCoverage passes the mask through and reports per-frame
    coverage in a 1xN IMAGE strip — the value each column carries equals the
    fraction of pixels above 0.5 on that frame."""
    import torch
    import motionfield_nodes.nodes_mask as nodes_mask

    mask = torch.zeros((4, 32, 32))
    mask[0] = 1.0                      # full frame
    mask[1, :16] = 1.0                 # half
    mask[2, :8, :8] = 0.4              # soft patch below the 0.5 bar → not covered
    # mask[3] stays empty
    out_mask, strip = nodes_mask.OF_MatteCoverage().run(mask)

    assert out_mask is mask, "the mask must pass through untouched"
    assert tuple(strip.shape) == (1, 1, 4, 3)
    got = strip[0, 0, :, 0].tolist()
    assert got[0] > 0.95 and abs(got[1] - 0.5) < 0.02
    assert got[2] < 0.02 and got[3] == 0.0


def test_matte_coverage_single_frame():
    """A single 2-D mask (no batch dim) still yields a 1x1 strip."""
    import torch
    import motionfield_nodes.nodes_mask as nodes_mask

    mask = torch.zeros((16, 16))
    mask[:, :8] = 1.0
    _m, strip = nodes_mask.OF_MatteCoverage().run(mask)
    assert tuple(strip.shape) == (1, 1, 1, 3)
    assert abs(strip[0, 0, 0, 0].item() - 0.5) < 0.02


def test_mask_track_follows_the_pick():
    """OF_MaskTrack keeps the matte region that overlaps the pick and lets it
    drift — a second, far-away blob never joins the track."""
    import torch
    import motionfield_nodes.nodes_mask as nodes_mask

    matte = torch.zeros((4, 64, 64))
    # a drifting blob: 20px square sliding right, 3px per frame (inside the
    # 4px overlap tolerance — the track follows it)
    for i in range(4):
        matte[i, 20:40, 8 + i * 3:28 + i * 3] = 1.0
    # a stationary second blob the pick never touched
    matte[:, 45:60, 45:60] = 1.0
    pick = torch.zeros((1, 64, 64))
    pick[0, 15:45, 5:35] = 1.0  # boxed on frame 0 around the first blob

    mask, strip = nodes_mask.OF_MaskTrack().run(matte, pick, 0.01, 4, pick_image="ignored.png")
    assert tuple(mask.shape) == (4, 64, 64)
    # the track follows the drift — frame 3 covers the moved blob
    assert mask[3, 30, 35] > 0.5
    # and the untouched second blob stays out of every frame
    assert mask[:, 45:60, 45:60].sum() == 0.0
    cov = strip[0, 0, :, 0]
    assert (cov > 0.0).all(), "a healthy track reports coverage on every frame"


def test_mask_track_refuses_a_lost_track():
    """A pick that never overlaps the matte means coverage 0 — the node
    refuses instead of letting VACE regenerate at random."""
    import torch
    import motionfield_nodes.nodes_mask as nodes_mask

    matte = torch.zeros((3, 64, 64))
    matte[:, 40:60, 40:60] = 1.0
    pick = torch.zeros((1, 64, 64))
    pick[0, 0:10, 0:10] = 1.0  # boxed somewhere with no object

    try:
        nodes_mask.OF_MaskTrack().run(matte, pick, 0.01, 4)
    except Exception as e:
        assert "track lost" in str(e) or "coverage" in str(e), f"wrong refuse message: {e}"
    else:
        raise AssertionError("a lost track must refuse, not return a mask")


def test_draw_mask_keeps_only_the_stroke():
    """A localized stroke becomes the mask. A whole-frame tint under the
    threshold does not — that is a regrade, not ink."""
    import torch
    import motionfield_nodes.nodes_mask as nodes_mask

    base = torch.zeros((1, 32, 48, 3))
    edited = base.clone()
    edited[0, 8:12, 10:18, 0] = 1.0
    mask, = nodes_mask.OF_DrawMask().run(edited, base, 5, 0.08, 0)
    assert tuple(mask.shape) == (5, 32, 48)
    assert mask[:, 8:12, 10:18].min().item() == 1.0
    # thin strokes are expanded to a repaintable footprint (>=6% of the
    # frame) but still stay local — the far corners are untouched
    assert mask[0].mean().item() >= 0.06
    assert mask[0, 0, 0].item() == 0.0
    assert mask[0, 31, 47].item() == 0.0

    tint = base + 0.02
    quiet, = nodes_mask.OF_DrawMask().run(tint, base, 3, 0.08, 0)
    assert quiet.sum().item() == 0.0


def test_draw_mask_empty_when_the_frames_match():
    import torch
    import motionfield_nodes.nodes_mask as nodes_mask

    frame = torch.rand((1, 16, 16, 3))
    mask, = nodes_mask.OF_DrawMask().run(frame, frame.clone(), 4, 0.08, 2)
    assert tuple(mask.shape) == (4, 16, 16)
    assert mask.sum().item() == 0.0


def test_draw_mask_matches_the_source_frame_size():
    """The mask is repeated to ``frames`` and sized to the source frame,
    even when the uploaded edit is a different resolution."""
    import torch
    import motionfield_nodes.nodes_mask as nodes_mask

    edited = torch.ones((1, 8, 8, 3))
    base = torch.zeros((1, 16, 24, 3))
    mask, = nodes_mask.OF_DrawMask().run(edited, base, 7, 0.08, 0)
    assert tuple(mask.shape) == (7, 16, 24)
    # edges feather below 1.0 but the interior stays fully masked
    assert mask.max().item() == 1.0
    assert mask[0, 8, 12].item() == 1.0


def test_draw_mask_grows_the_stroke():
    import torch
    import motionfield_nodes.nodes_mask as nodes_mask

    base = torch.zeros((1, 32, 32, 3))
    edited = base.clone()
    edited[0, 16, 16, :] = 1.0
    mask, = nodes_mask.OF_DrawMask().run(edited, base, 1, 0.08, 2)
    # the grow radius applies, then a single pixel is still too thin to
    # repaint — it expands to at least 6% of the frame, centered on the dot
    assert mask[0, 16, 16].item() == 1.0
    assert mask[0, 16, 18].item() == 1.0
    assert mask[0, 14, 16].item() == 1.0
    assert mask[0].mean().item() >= 0.06
    far = mask.clone()
    far[:, 8:25, 8:25] = 0
    assert far.sum().item() == 0.0


def test_crop_to_mask_bounds_and_rect():
    """OF_CropToMask returns the padded bounding-box crop plus the rect it
    came from — a paste-back at (x, y) with (w, h) covers exactly the
    masked region."""
    import torch
    import motionfield_nodes.nodes_mask as nodes_mask

    image = torch.rand((1, 100, 200, 3))
    mask = torch.zeros((1, 100, 200))
    mask[0, 30:50, 60:100] = 1.0          # 20x40 box
    crop, x, y, w, h = nodes_mask.OF_CropToMask().run(image, mask, 0.5)
    # pad = 0.5 * max(40, 20) = 20 → x 40..120, y 10..70
    assert (x, y, w, h) == (40, 10, 80, 60)
    assert tuple(crop.shape) == (1, 60, 80, 3)
    # the crop carries the source's pixels
    assert torch.equal(crop[0, 20:40, 20:60, :], image[0, 30:50, 60:100, :])


def test_crop_to_mask_clamps_and_empty():
    """A mask at the frame edge clamps the pad; an empty mask returns the
    whole frame at origin 0,0 (never a crash mid-run)."""
    import torch
    import motionfield_nodes.nodes_mask as nodes_mask

    image = torch.rand((1, 64, 64, 3))
    mask = torch.zeros((1, 64, 64))
    mask[0, 0:20, 0:20] = 1.0
    crop, x, y, w, h = nodes_mask.OF_CropToMask().run(image, mask, 1.0)
    assert (x, y) == (0, 0) and (w, h) == (40, 40)
    assert tuple(crop.shape) == (1, 40, 40, 3)

    empty = torch.zeros((1, 64, 64))
    crop2, x2, y2, w2, h2 = nodes_mask.OF_CropToMask().run(image, empty, 0.4)
    assert (x2, y2, w2, h2) == (0, 0, 64, 64)
    assert crop2.shape == image.shape


def test_mask_track_clips_pick_to_frame0_matte():
    """Frame 0's track is the pick clipped to the matte — boxing a region
    bigger than the object keeps only the object, not the whole box."""
    import torch
    import motionfield_nodes.nodes_mask as nodes_mask

    matte = torch.zeros((3, 64, 64))
    matte[:, 20:30, 20:30] = 1.0
    pick = torch.zeros((1, 64, 64))
    pick[0, 10:50, 10:50] = 1.0  # a loose box around the small blob

    mask, strip = nodes_mask.OF_MaskTrack().run(matte, pick, 0.01, 2)
    # frame 0 = pick ∩ matte, grown only by the overlap tolerance — the
    # boxed but non-matte area is not regenerated
    inside = mask[0, 25, 25]
    outside = mask[0, 12, 12]  # inside the box, far outside the matte
    assert inside > 0.5 and outside == 0.0
