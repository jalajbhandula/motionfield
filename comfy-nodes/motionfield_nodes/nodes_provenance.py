"""OF_ProvTag — write the finished PNG with provenance stamped into it.

A consented face swap marks its output: an iTXt ``prov`` block carries a
JSON receipt (feature, seed, model, timestamp) and a small XMP packet
carries the same tag so provenance survives readers that only look at one
slot. Pure-python and offline — the tag goes into the PNG bytes at save
time; nothing phones home and nothing external is consulted.
"""

import io
import itertools
import json
import os
import time
from xml.sax.saxutils import quoteattr

import numpy as np
import torch
from PIL import Image
from PIL.PngImagePlugin import PngInfo

try:
    import folder_paths as _folder_paths
except ImportError:
    _folder_paths = None

FEATURE = "photo-face-swap"
_counter = itertools.count(1)


def prov_metadata(feature, seed, model):
    """The receipt — the iTXt dict + a minimal XMP packet carrying prov:feature."""
    meta = {"feature": feature, "seed": int(seed), "model": model, "ts": int(time.time())}
    xmp = (
        '<x:xmpmeta xmlns:x="adobe:ns:meta/">'
        '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">'
        '<rdf:Description xmlns:prov="https://motionfield.local/prov/1.0/"'
        f" prov:feature={quoteattr(feature)} prov:tag={quoteattr(f'prov:{feature}')}"
        f" prov:model={quoteattr(model)}/>"
        "</rdf:RDF></x:xmpmeta>"
    )
    return meta, xmp


def tag_png(image, meta, xmp):
    """One float image (H,W,C 0..1) → PNG bytes with iTXt 'prov' + XMP."""
    arr = image.detach().float().cpu().numpy() if hasattr(image, "detach") else np.asarray(image)
    arr = (arr.clip(0, 1) * 255).round().astype(np.uint8)
    info = PngInfo()
    info.add_text("prov", json.dumps(meta, separators=(",", ":")))
    info.add_text("XML:com.adobe.xmp", xmp)
    buf = io.BytesIO()
    Image.fromarray(arr).save(buf, format="PNG", pnginfo=info)
    return buf.getvalue()


class OF_ProvTag:
    """Save a PNG carrying the provenance tag — on every consented swap."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "images": ("IMAGE",),
                "feature": ("STRING", {"default": FEATURE}),
                "seed": ("STRING", {"default": "0"}),
                "model": ("STRING", {"default": "flux2-klein-4b"}),
                "filename_prefix": ("STRING", {"default": "motionfield"}),
            }
        }

    RETURN_TYPES = ()
    FUNCTION = "save"
    OUTPUT_NODE = True
    CATEGORY = "MotionField/provenance"
    DESCRIPTION = "Save a PNG with an iTXt 'prov' receipt + XMP tag — provenance on the output file."

    def save(self, images, feature, seed, model, filename_prefix):
        meta, xmp = prov_metadata(feature, seed, model)
        out_dir = _folder_paths.get_output_directory() if _folder_paths is not None else "."
        files = []
        for i in range(images.shape[0]):
            # -prov marks the tagged file so evidence saves sharing the prefix
            # (a mask written by a plain SaveImage) can't overwrite it
            name = f"{filename_prefix}-prov_{next(_counter):05d}_.png"
            path = os.path.join(out_dir, name)
            with open(path, "wb") as f:
                f.write(tag_png(images[i], meta, xmp))
            files.append(name)
        return {"ui": {"images": [{"filename": n, "subfolder": "", "type": "output"} for n in files]}}


NODE_CLASS_MAPPINGS = {"OF_ProvTag": OF_ProvTag}
NODE_DISPLAY_NAME_MAPPINGS = {"OF_ProvTag": "Save with provenance tag"}
