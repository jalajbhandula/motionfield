"""OF_ProvTag — the PNG the face-swap graph writes carries the provenance
tag: an iTXt 'prov' receipt and an XMP packet, both readable by Pillow."""

import io
import json
import tempfile
import types


def test_prov_metadata_shapes():
    from motionfield_nodes.nodes_provenance import prov_metadata

    meta, xmp = prov_metadata("photo-face-swap", 7, "flux2-klein-4b")
    assert meta["feature"] == "photo-face-swap"
    assert meta["seed"] == 7 and meta["model"] == "flux2-klein-4b"
    assert meta["ts"] > 0
    assert "prov:feature=" in xmp and "photo-face-swap" in xmp
    assert "prov:photo-face-swap" in xmp


def test_png_carries_itxt_and_xmp():
    import numpy as np
    from PIL import Image
    from motionfield_nodes.nodes_provenance import prov_metadata, tag_png

    img = np.random.rand(16, 16, 3).astype(np.float32)
    meta, xmp = prov_metadata("photo-face-swap", 1, "flux2-klein-4b")
    png = tag_png(img, meta, xmp)
    back = Image.open(io.BytesIO(png))
    assert back.format == "PNG"
    prov = json.loads(back.info["prov"])
    assert prov["feature"] == "photo-face-swap" and prov["model"] == "flux2-klein-4b"
    assert "prov:photo-face-swap" in back.info["XML:com.adobe.xmp"]


def test_node_writes_tagged_files():
    import os
    import torch
    from PIL import Image
    from motionfield_nodes import nodes_provenance

    out_dir = tempfile.mkdtemp(prefix="of-prov-")
    orig = nodes_provenance._folder_paths
    nodes_provenance._folder_paths = types.SimpleNamespace(
        get_output_directory=lambda: out_dir)
    try:
        result = nodes_provenance.OF_ProvTag().save(
            torch.rand(2, 16, 16, 3), "photo-face-swap", "9", "flux2-klein-4b", "test")
    finally:
        nodes_provenance._folder_paths = orig

    names = [i["filename"] for i in result["ui"]["images"]]
    assert len(names) == 2
    for n in names:
        path = os.path.join(out_dir, n)
        assert os.path.exists(path), f"{n} not written"
        prov = json.loads(Image.open(path).info["prov"])
        assert prov["feature"] == "photo-face-swap" and prov["seed"] == 9


def test_face_mask_covers_the_face():
    """The whole-face hull covers brow→chin plus the forehead strip."""
    from motionfield_nodes.core.face import face_mask_from_landmarks
    from test_mask import _synthetic_face

    face = _synthetic_face()
    mask = face_mask_from_landmarks(face, 128, 128, dilate_px=0, feather_px=0)
    brow_y = int(face[24, 1])
    chin_y = int(face[8, 1])
    cx = int(face[8, 0])
    assert mask[brow_y, cx] > 0.5, "brow line is inside"
    assert mask[chin_y, cx] > 0.5, "chin is inside"
    # forehead — above the brows the mouth mask never reached
    assert mask[max(0, brow_y - 8), cx] > 0.5, "the forehead strip is inside"
    # the far background stays out
    assert mask[2, 2] == 0.0
    assert mask[127, 127] == 0.0


def test_face_mask_empty_without_a_face():
    import numpy as np
    from motionfield_nodes.core.face import face_mask_from_landmarks
    from test_mask import _synthetic_face

    face = _synthetic_face()
    face[:, 2] = 0.0
    assert face_mask_from_landmarks(face, 128, 128).sum() == 0.0
    face = _synthetic_face()
    face[:, :2] = np.nan
    assert face_mask_from_landmarks(face, 128, 128).sum() == 0.0


def test_face_mask_node_clips_to_matte():
    """OF_FaceMask intersects the face hull with the person matte — forehead
    pixels outside the silhouette stay 0."""
    import numpy as np
    import torch
    import motionfield_nodes.nodes_mask as nodes_mask
    from test_mask import _synthetic_face

    face = _synthetic_face()
    kp = np.zeros((1, 134, 2), dtype=np.float32)
    sc = np.zeros((1, 134), dtype=np.float32)
    kp[0, 24:92] = face[:, :2]
    sc[0, 24:92] = face[:, 2]

    orig_wb, orig_detect = nodes_mask._wholebody, nodes_mask._detect
    nodes_mask._wholebody = lambda providers=None: object()
    nodes_mask._detect = lambda detector, _img: (detector, kp, sc)
    # a matte that excludes the top half of the frame — the forehead strip
    # must be clipped to it
    matte = torch.zeros((1, 128, 128))
    matte[0, 40:] = 1.0
    try:
        # resolution=128 → scale 1.0, so the stubbed 128-space keypoints land
        # where the mask is drawn (the node rescales keypoints by `scale`)
        (mask,) = nodes_mask.OF_FaceMask().run(
            torch.zeros((1, 128, 128, 3)), 0, 0, 128, matte)
    finally:
        nodes_mask._wholebody, nodes_mask._detect = orig_wb, orig_detect

    brow_y = int(face[24, 1])
    cx = int(face[8, 0])
    assert mask[0, brow_y, cx] > 0.5, "the face inside the matte survives"
    assert mask[0, :20].sum() == 0.0, "the forehead outside the matte is clipped"
