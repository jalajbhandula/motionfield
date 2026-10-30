"""Relight nodes — DA3 depth → normal map, and the shaded "light guide".

OF_RelightNormals feeds the app's live preview (the browser shades the photo
with the same model as core/relight.py while you move the lights);
OF_Relight renders that guide at full size for the FLUX.2 klein harmonise
pass in workflows/relight-klein.json.
"""

import numpy as np
import torch

from .core import relight as _rl


class OF_RelightNormals:
    """Depth (DA3Render raw, any scale) → camera-space normal map (rgb = n·0.5+0.5)."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "depth": ("IMAGE",),
            },
            "optional": {
                "fov": ("FLOAT", {"default": 50.0, "min": 10.0, "max": 120.0, "step": 1.0}),
                "smooth": ("FLOAT", {"default": 2.0, "min": 0.0, "max": 16.0, "step": 0.5}),
                "depth_mode": (("auto", "depth", "disparity"),),
            },
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("normals",)
    FUNCTION = "run"
    CATEGORY = "MotionField/relight"

    def run(self, depth, fov=50.0, smooth=2.0, depth_mode="auto"):
        from .core import camera_rig as _rig
        out = []
        for i in range(depth.shape[0]):
            d = _rig.depth_to_metres(depth[i:i + 1].detach().cpu().numpy(), 4.0, depth_mode)
            out.append(_rl.encode_normals(_rl.normals_from_depth(d, fov, smooth)))
        return (torch.from_numpy(np.stack(out)).float(),)


class OF_Relight:
    """Photo + normals + lights → the relit guide image (no model involved)."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE",),
                "normals": ("IMAGE",),
                "lights": ("STRING", {"multiline": True, "default": '[{"az":300,"el":35,"color":"#ffd2a0","power":1.2,"soft":0.4}]'}),
            },
            "optional": {
                "ambient": ("FLOAT", {"default": 0.35, "min": 0.0, "max": 2.0, "step": 0.05}),
                "ambient_color": ("STRING", {"default": "#ffffff"}),
                "strength": ("FLOAT", {"default": 0.85, "min": 0.0, "max": 1.0, "step": 0.05}),
            },
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("guide",)
    FUNCTION = "run"
    CATEGORY = "MotionField/relight"

    def run(self, image, normals, lights, ambient=0.35, ambient_color="#ffffff", strength=0.85):
        ls = _rl.parse_lights(lights)
        out = []
        for i in range(image.shape[0]):
            img = image[i].detach().cpu().numpy().astype(np.float64)[..., :3]
            n = _rl.decode_normals(normals[min(i, normals.shape[0] - 1)].detach().cpu().numpy())
            out.append(_rl.relight(img, n, ls, ambient, ambient_color or "#ffffff", strength))
        return (torch.from_numpy(np.stack(out)).float(),)


NODE_CLASS_MAPPINGS = {
    "OF_RelightNormals": OF_RelightNormals,
    "OF_Relight": OF_Relight,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "OF_RelightNormals": "MotionField Relight · normals from depth",
    "OF_Relight": "MotionField Relight · light guide",
}
