"""Director lane nodes — the still-image re-render Wan VACE fills.

OF_DirectorRig shares OF_CameraRig's unproject-then-splat contract (rgb,
holes, control → WanVaceToVideo) but renders the frame through
core.director_rig: depth-edge filtering drops the specks a raw splat turns
into floating blobs, a wider splat cap keeps near geometry solid under
translation, and a rim-fill closes checkerboard pinholes so the hole mask
only carries real disocclusion. Clip re-shoot keeps OF_CameraRig — this
node is the Director's still-frame path.
"""
import numpy as np
import torch

from .core import camera_rig as _rig
from .core import director_rig as _drig


class OF_DirectorRig:
    """Unproject the start frame with its depth map and re-render it along
    the pose stream — the control Wan VACE in-fills.

    Same outputs as OF_CameraRig (rgb, holes, control) plus the Director's
    quality passes:
      edge_ratio  — drop the far pixel at depth jumps (smear source)
      spike_ratio — drop lone near pixels amid far neighbours (specks)
      fill_iters  — rim-fill holes up to ~2×this px wide; wider stays a hole
      radius_max  — splat cap; near points translate past the 4-px default
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "source": ("IMAGE",),
                "depth": ("IMAGE",),
                "poses_json": ("STRING", {"multiline": True}),
            },
            "optional": {
                "near": ("FLOAT", {"default": 0.05, "min": 0.001, "max": 10.0, "step": 0.01}),
                "hole_dilate": ("INT", {"default": 2, "min": 0, "max": 32}),
                "distance": ("FLOAT", {"default": 4.0, "min": 0.1, "max": 1000.0, "step": 0.1}),
                "width": ("INT", {"default": 832, "min": 16, "max": 4096, "step": 8}),
                "height": ("INT", {"default": 480, "min": 16, "max": 4096, "step": 8}),
                "depth_mode": (("auto", "depth", "disparity", "metres"),),
                "edge_ratio": ("FLOAT", {"default": 1.8, "min": 1.0, "max": 10.0, "step": 0.1}),
                "spike_ratio": ("FLOAT", {"default": 2.2, "min": 1.0, "max": 10.0, "step": 0.1}),
                "fill_iters": ("INT", {"default": 8, "min": 0, "max": 64}),
                "radius_max": ("INT", {"default": 10, "min": 1, "max": 64}),
                "pad_to": ("INT", {"default": 0, "min": 0, "max": 8192}),
            },
        }

    RETURN_TYPES = ("IMAGE", "MASK", "IMAGE")
    RETURN_NAMES = ("rgb", "holes", "control")
    FUNCTION = "run"
    CATEGORY = "MotionField/camera"

    def run(self, source, depth, poses_json, near=0.05, hole_dilate=2,
            distance=4.0, width=832, height=480, depth_mode="auto",
            edge_ratio=1.8, spike_ratio=2.2, fill_iters=8, radius_max=10,
            pad_to=0):
        poses = _rig.load_poses(poses_json)
        src = source[0].detach().cpu().numpy().astype(np.float64)[..., :3]
        dep = _rig.depth_to_metres(depth.detach().cpu().numpy(), distance, depth_mode)
        frames, holes, control = _drig.render_still(
            src, dep, poses, near=near, hole_dilate_px=hole_dilate,
            out_size=(width, height) if width and height else None,
            edge_ratio=edge_ratio, spike_ratio=spike_ratio,
            fill_iters=fill_iters, radius_max=radius_max)
        if pad_to > len(frames):
            frames, holes, control = _rig.pad_frames(frames, holes, control, pad_to)
        rgb = torch.from_numpy(np.stack(frames)).float()
        hole = torch.from_numpy(np.stack(holes)).float()
        ctl = torch.from_numpy(np.stack(control)).float()
        return (rgb, hole, ctl)


NODE_CLASS_MAPPINGS = {"OF_DirectorRig": OF_DirectorRig}
NODE_DISPLAY_NAME_MAPPINGS = {"OF_DirectorRig": "OF Director Rig"}
