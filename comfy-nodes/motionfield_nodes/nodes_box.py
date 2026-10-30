"""OF_BoxPlace — paste an RGBA overlay into a normalised box on the scene.

The product-placement graph's geometric stage: a BiRefNet cutout of the product
is fit into the user-drawn box (normalised 0–1 fractions, so the API contract
never depends on pixel size), alpha-composited onto the scene, and the grown +
feathered box comes back as the mask the harmonise pass works inside. The third
output is the placed product alpha in frame coordinates — the graph erodes it a
couple of pixels and pastes the composite back inside it after harmonising, so
the product's own pixels survive verbatim and the model only supplies contact
shadow, edge blend and surrounding light.
"""

import numpy as np
import torch

from .core.box import place_overlay


class OF_BoxPlace:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE",),
                "overlay": ("IMAGE",),
                "bbox_x": ("FLOAT", {"default": 0.25, "min": 0.0, "max": 1.0, "step": 0.01}),
                "bbox_y": ("FLOAT", {"default": 0.25, "min": 0.0, "max": 1.0, "step": 0.01}),
                "bbox_w": ("FLOAT", {"default": 0.5, "min": 0.0, "max": 1.0, "step": 0.01}),
                "bbox_h": ("FLOAT", {"default": 0.5, "min": 0.0, "max": 1.0, "step": 0.01}),
                "grow": ("INT", {"default": 24, "min": 0, "max": 512, "step": 1}),
                "feather": ("INT", {"default": 24, "min": 0, "max": 256, "step": 1}),
            }
        }

    RETURN_TYPES = ("IMAGE", "MASK", "MASK")
    RETURN_NAMES = ("composite", "region_mask", "product_mask")
    FUNCTION = "run"
    CATEGORY = "MotionField/composite"
    DESCRIPTION = "Fit an RGBA overlay into a normalised box (x/y/w/h 0–1), centred and aspect-preserved; emits the grown+feathered box mask plus the placed overlay alpha in frame coordinates (0 outside the fitted rect)."

    def run(self, image, overlay, bbox_x, bbox_y, bbox_w, bbox_h, grow, feather):
        scenes = image.detach().float().cpu().clamp(0, 1)
        ol = overlay.detach().float().cpu().clamp(0, 1)[0]
        out_img, out_mask, out_product = [], [], []
        for i in range(scenes.shape[0]):
            c, m, pm = place_overlay(
                scenes[i].numpy(), ol.numpy(),
                (float(bbox_x), float(bbox_y), float(bbox_w), float(bbox_h)),
                int(grow), int(feather),
            )
            out_img.append(torch.from_numpy(c))
            out_mask.append(torch.from_numpy(m))
            out_product.append(torch.from_numpy(pm))
        return (torch.stack(out_img, 0), torch.stack(out_mask, 0), torch.stack(out_product, 0))


NODE_CLASS_MAPPINGS = {"OF_BoxPlace": OF_BoxPlace}
NODE_DISPLAY_NAME_MAPPINGS = {"OF_BoxPlace": "Place overlay in box (normalised)"}
