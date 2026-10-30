"""OF_Trajectory — emits a trajectory's per-frame camera poses as JSON;
OF_DA3Poses — recovers the source camera's poses + depth from a DA3
multiview pass; OF_CameraRig — re-renders a source image (or a whole clip,
one source pose per frame) along those poses (rgb + hole mask + 0.5-grey
control for WanVaceToVideo); OF_DepthBlur — aperture/focus depth of field
from the rig's depth.

The pose list feeds downstream consumers (e.g. a camera-conditioned video
graph): each frame is {t, pos:[x,y,z], yaw, pitch, roll, fov} — plus `focus`
for focus pulls — matching src/lib/camera/trajectory.ts exactly.
"""
import json

import numpy as np
import torch

from .core.camera_trajectory import MOVES, SUBJECT_CLASSES, TRAJECTORY_LAYERS, TRAJECTORY_POSTS, TRAJECTORY_TARGETS, compose_trajectory
from .core import camera_rig as _rig
from .core import camera_da3 as _da3
from .core import camera_embed as _embed


class OF_Trajectory:
    """Trajectory id + shot params → per-frame pose list (JSON)."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "trajectory": (sorted(MOVES),),
                "strength": ("FLOAT", {"default": 1.0, "min": 0.25, "max": 2.0, "step": 0.05}),
                "duration": ("FLOAT", {"default": 3.0, "min": 0.25, "max": 120.0, "step": 0.25}),
                "fps": ("FLOAT", {"default": 24.0, "min": 1.0, "max": 240.0, "step": 1.0}),
                "seed": ("INT", {"default": 0, "min": 0, "max": 0xFFFFFFFF}),
            },
            "optional": {
                # a "+"-joined stack (1–3 ids) — overrides the dropdown
                "moves": ("STRING", {"default": ""}),
                # "auto" keeps the move's own setting; post "none" strips it
                "target": (("auto", *TRAJECTORY_TARGETS),),
                "layer": (("auto", *TRAJECTORY_LAYERS),),
                "post": (("auto", "none", *TRAJECTORY_POSTS),),
                "subject_class": (SUBJECT_CLASSES,),
                "distance": ("FLOAT", {"default": 4.0, "min": 0.1, "max": 1000.0, "step": 0.1}),
                "fov": ("FLOAT", {"default": 40.0, "min": 1.0, "max": 170.0, "step": 0.5}),
                # exact pose count — 0 derives it from duration×fps. Re-shoot
                # wires the decoded frame count here so the path can't run
                # past the frames the loader produced.
                "frames": ("INT", {"default": 0, "min": 0, "max": 8192, "step": 1}),
                # re-shoot anchor — a JSON pose (or pose list; [0] is used).
                # Set: the composed path is rigidly re-based so frame 0 is
                # this pose; the new camera starts where the source camera
                # started, and its fov becomes the stack's lens baseline.
                "anchor": ("STRING", {"default": "", "multiline": True}),
            },
        }

    RETURN_TYPES = ("STRING", "INT")
    RETURN_NAMES = ("poses_json", "frame_count")
    FUNCTION = "run"
    CATEGORY = "MotionField/camera"

    def run(self, trajectory, strength, duration, fps, seed,
            moves="", target="auto", layer="auto", post="auto", subject_class="person",
            distance=4.0, fov=40.0, frames=0, anchor=""):
        ids = [s.strip() for s in str(moves).split("+") if s.strip()]
        if not ids:
            ids = [s.strip() for s in str(trajectory).split("+") if s.strip()]
        if not 1 <= len(ids) <= 3:
            raise ValueError(f"moves takes 1-3 '+'-joined ids, got {len(ids)}")
        for mid in ids:
            if mid not in MOVES:
                raise ValueError(f'unknown move "{mid}"')
        if frames:
            # compose emits round(duration·fps)+1 poses — the exact frame
            # count lands by expressing it back as a duration
            duration = (frames - 1) / fps
        result = compose_trajectory({
            "moves": ids,
            "strength": strength,
            "duration": duration,
            "fps": fps,
            "seed": seed,
            "distance": distance,
            "fov": fov,
            "subjectClass": subject_class,
            "target": target,
            "layer": layer,
            "post": post,
        })
        frames = result["frames"]
        if (anchor or "").strip():
            frames = _da3.anchor_frames(frames, json.loads(anchor))
        return (json.dumps(frames, separators=(",", ":")), len(frames))


class OF_DA3Poses:
    """DA3 multiview geometry → the source camera's recovered pose stream.

    Emits src_poses_json (one pose per clip frame, OpenCV→our-frame
    converted, rescaled to metres so `distance` is the subject's range),
    the depth batch in the same units, and the frame count. Wire
    src_poses_json into OF_Trajectory's `anchor` and OF_CameraRig's
    `src_poses_json` — the new path then replaces the source camera's move.

    process_res + resize_method must match the upstream DA3Inference — the
    recovered intrinsics are expressed in those processing dims."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "da3_geometry": ("DA3_GEOMETRY",),
                "fps": ("FLOAT", {"default": 24.0, "min": 1.0, "max": 240.0, "step": 1.0}),
                "distance": ("FLOAT", {"default": 4.0, "min": 0.1, "max": 1000.0, "step": 0.1}),
            },
            "optional": {
                "process_res": ("INT", {"default": 504, "min": 140, "max": 2520, "step": 14}),
                "resize_method": (("upper_bound_resize", "lower_bound_resize"),),
                # pixels below this DA3 confidence splat nowhere — they land
                # in the hole mask instead of smearing wrong geometry
                "min_confidence": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 1.0, "step": 0.05}),
            },
        }

    RETURN_TYPES = ("STRING", "IMAGE", "INT")
    RETURN_NAMES = ("src_poses_json", "depth_m", "frame_count")
    FUNCTION = "run"
    CATEGORY = "MotionField/camera"

    def run(self, da3_geometry, fps, distance, process_res=504,
            resize_method="upper_bound_resize", min_confidence=0.0):
        poses, depth_m, _n = _da3.geometry_to_poses(
            da3_geometry, fps, distance, process_res, resize_method, min_confidence)
        depth = torch.from_numpy(np.repeat(depth_m[..., None], 3, axis=-1)).float()
        return (json.dumps(poses, separators=(",", ":")), depth, len(poses))


class OF_DA3Windowed:
    """Long-clip DA3 multiview for re-shoot sources that don't fit one pass.

    Comfy's DA3Inference runs the whole frame batch through one DINO2
    forward — a 73-frame clip wants ~140 GB at res 504 on this Mac. This
    node chunks the batch into overlapping windows, runs the builtin pass
    per window, and chains each window's world frame onto the first via the
    similarity fit on the shared views' camera centres (depth scales by the
    same factor). Output is a drop-in DA3_GEOMETRY: one extrinsic + K per
    source frame, averaged depth/confidence, anchored to the first window.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "da3_model": ("DA3_MODEL",),
                "image": ("IMAGE",),
            },
            "optional": {
                "resolution": ("INT", {"default": 504, "min": 140, "max": 2520, "step": 14}),
                "resize_method": (("upper_bound_resize", "lower_bound_resize"),),
                "ref_view_strategy": (("saddle_balanced", "first", "middle"),),
                "pose_method": (("cam_dec", "homography", "essential", "pnp"),),
                "window": ("INT", {"default": 12, "min": 2, "max": 128}),
                "overlap": ("INT", {"default": 4, "min": 0, "max": 64}),
            },
        }

    RETURN_TYPES = ("DA3_GEOMETRY",)
    FUNCTION = "run"
    CATEGORY = "MotionField/camera"

    _cache_key = None
    _cache_val = None

    def run(self, da3_model, image, resolution=504,
            resize_method="upper_bound_resize",
            ref_view_strategy="saddle_balanced", pose_method="cam_dec",
            window=12, overlap=4):
        from comfy_extras.nodes_depth_anything_3 import DA3Inference
        n = image.shape[0]
        # same clip, same params → same geometry; re-shoot graphs re-submit
        # per move and the windows cost minutes each, so cache — session for
        # the live process, an npz under ~/.motionfield/cache/da3 (not Comfy's
        # temp: that is wiped on every startup) so a Comfy restart still hits
        import hashlib
        h = hashlib.sha1(image.numpy().tobytes()).hexdigest()[:16]
        key = (n, resolution, resize_method, ref_view_strategy, pose_method,
               window, overlap, h)
        if key == OF_DA3Windowed._cache_key:
            return (OF_DA3Windowed._cache_val,)
        # sv2 — stitched scale moved off the centre fit (locked-off cameras
        # made it collapse); entries written before this are wrong geometry
        npz_key = (f"{h}_{n}_{resolution}_{resize_method[:4]}"
                   f"_{ref_view_strategy}_{pose_method}_{window}x{overlap}_sv2")
        z = _da3.da3_cache_get(npz_key)
        if z is not None:
            out = {"depth": torch.from_numpy(z["depth"]).float(),
                   "image": torch.from_numpy(z["image"]).float(),
                   "mode": "multiview",
                   "extrinsics": torch.from_numpy(z["extrinsics"]).float(),
                   "intrinsics": torch.from_numpy(z["intrinsics"]).float()}
            if "confidence" in z:
                out["confidence"] = torch.from_numpy(z["confidence"]).float()
            OF_DA3Windowed._cache_key = key
            OF_DA3Windowed._cache_val = out
            return (out,)
        starts = _da3.window_starts(n, window, overlap)
        windows = []
        for s in starts:
            geo = DA3Inference._execute_multiview(
                da3_model, image[s:s + window], resolution, resize_method,
                ref_view_strategy, pose_method).result[0]
            wgeo = {}
            for k in ("depth", "image", "extrinsics", "intrinsics", "confidence"):
                if geo.get(k) is None:
                    continue
                v = _da3._as_numpy(geo[k])
                wgeo[k] = v[0] if k in ("extrinsics", "intrinsics") else v
            windows.append((s, wgeo))
        stitched = _da3.stitch_windows(windows, n)
        out = {"depth": torch.from_numpy(stitched["depth"]).float(),
               "image": torch.from_numpy(stitched["image"]).float(),
               "mode": "multiview",
               "extrinsics": torch.from_numpy(stitched["extrinsics"]).float(),
               "intrinsics": torch.from_numpy(stitched["intrinsics"]).float()}
        if stitched.get("confidence") is not None:
            out["confidence"] = torch.from_numpy(stitched["confidence"]).float()
        save = {k: v.numpy() for k, v in out.items() if hasattr(v, "numpy")}
        _da3.da3_cache_put(npz_key, save)
        OF_DA3Windowed._cache_key = key
        OF_DA3Windowed._cache_val = out
        return (out,)


class OF_CameraRig:
    """Unproject the source image with its depth map, then z-buffer-splat it
    through each pose — a cheap re-render that real camera motion rides on.

    With `src_poses_json` set (a pose per source frame, e.g. OF_DA3Poses),
    frame t unprojects ITS OWN depth through the source camera's pose t —
    the new path replaces the source camera's move; without it the single
    frame-0 re-render keeps the old behaviour.

    Outputs: the re-rendered rgb batch, the hole mask (disocclusions the rig
    can't know, dilated; soft-edged when hole_feather > 0), and a control
    batch with the holes flat at 0.5 grey — wire all three into
    WanVaceToVideo's control_video/control_masks.
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
                "hole_dilate": ("INT", {"default": 3, "min": 0, "max": 32}),
                "distance": ("FLOAT", {"default": 4.0, "min": 0.1, "max": 1000.0, "step": 0.1}),
                "width": ("INT", {"default": 480, "min": 16, "max": 4096, "step": 8}),
                "height": ("INT", {"default": 272, "min": 16, "max": 4096, "step": 8}),
                "depth_mode": (("auto", "depth", "disparity", "metres"),),
                # a pose per source frame (OF_DA3Poses) — clip re-shoot mode
                "src_poses_json": ("STRING", {"multiline": True, "default": ""}),
                # repeat the last frame until the batch reaches this length
                # (the 4n+1 latent count); 0 = off
                "pad_to": ("INT", {"default": 0, "min": 0, "max": 8192}),
                # moving-subject matte (BiRefNet RemoveBackground) — matte
                # pixels copy the source through and leave the hole mask:
                # a depth-projected moving subject smears without this
                "subject_mask": ("MASK",),
                # billboard re-places the subject where the new camera puts
                # it (centre, scale, roll, foreshortening); pin keeps the
                # legacy same-coords copy; splat depth-projects it with the
                # world; hole sends it to VACE outright
                "subject_mode": (("billboard", "pin", "splat", "hole"),),
                # soft edge on the returned hole mask (control grey still
                # thresholds at 0.5) — VACE blends the fill at the seam
                "hole_feather": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 16.0, "step": 0.5}),
                # per-frame disocclusion cap — over it the pose step halves
                # toward the last executed pose (the camera slows instead
                # of handing VACE a black frame); 0 = off
                "hole_clamp": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 1.0, "step": 0.05}),
            },
        }

    RETURN_TYPES = ("IMAGE", "MASK", "IMAGE")
    RETURN_NAMES = ("rgb", "holes", "control")
    FUNCTION = "run"
    CATEGORY = "MotionField/camera"

    def run(self, source, depth, poses_json, near=0.05, hole_dilate=3,
            distance=4.0, width=480, height=272, depth_mode="auto",
            src_poses_json="", pad_to=0, subject_mask=None,
            subject_mode="billboard", hole_feather=0.0, hole_clamp=0.0):
        poses = _rig.load_poses(poses_json)
        src_poses = _rig.load_poses(src_poses_json) if (src_poses_json or "").strip() else None
        if src_poses is not None:
            deps = _rig.depths_to_metres(depth.detach().cpu().numpy(), distance, depth_mode)
            frames, holes, control = _rig.render_video(
                source.detach().cpu().numpy().astype(np.float64)[..., :3], deps,
                src_poses, poses, near=near, hole_dilate_px=hole_dilate,
                out_size=(width, height) if width and height else None,
                subject_masks=subject_mask.detach().cpu().numpy() if subject_mask is not None else None,
                subject_mode=subject_mode, hole_feather_px=hole_feather,
                hole_clamp=hole_clamp)
        else:
            src = source[0].detach().cpu().numpy().astype(np.float64)[..., :3]
            dep = _rig.depth_to_metres(depth.detach().cpu().numpy(), distance, depth_mode)
            frames, holes, control = _rig.render(
                src, dep, poses, near=near, hole_dilate_px=hole_dilate,
                out_size=(width, height) if width and height else None)
        if pad_to > len(frames):
            frames, holes, control = _rig.pad_frames(frames, holes, control, pad_to)
        rgb = torch.from_numpy(np.stack(frames)).float()
        hole = torch.from_numpy(np.stack(holes)).float()
        ctl = torch.from_numpy(np.stack(control)).float()
        return (rgb, hole, ctl)


class OF_DepthBlur:
    """Depth of field on a frame batch: aperture + focus distance, or the
    per-frame `focus` carried inside a poses_json. Node only — s5 wires it."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE",),
                "depth": ("IMAGE",),
            },
            "optional": {
                "aperture": ("FLOAT", {"default": 6.0, "min": 0.0, "max": 24.0, "step": 0.5}),
                "focus_distance": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 1000.0, "step": 0.1}),
                # metres the depth map is scaled to (its own input — no longer
                # borrowed from focus_distance)
                "distance": ("FLOAT", {"default": 4.0, "min": 0.1, "max": 1000.0, "step": 0.1}),
                "poses_json": ("STRING", {"multiline": True, "default": ""}),
            },
        }

    RETURN_TYPES = ("IMAGE",)
    FUNCTION = "run"
    CATEGORY = "MotionField/camera"

    def run(self, image, depth, aperture=6.0, focus_distance=0.0, distance=4.0,
            poses_json=""):
        # metres — same unit the pose `focus` fields and focus_distance carry
        dep = _rig.depth_to_metres(depth.detach().cpu().numpy(), distance)
        foci = None
        if (poses_json or "").strip():
            foci = [f.get("focus") for f in _rig.load_poses(poses_json)]
        out = []
        for i in range(image.shape[0]):
            f = foci[i] if foci and i < len(foci) and isinstance(foci[i], (int, float)) else None
            if f is None and focus_distance > 0:
                f = float(focus_distance)
            frame = image[i].detach().cpu().numpy().astype(np.float64)[..., :3]
            out.append(_rig.depth_of_field(frame, dep, aperture, f))
        return (torch.from_numpy(np.stack(out)).float(),)


def _intermediate_device():
    """ComfyUI's intermediate device when running inside it, else CPU — the
    camera-embedding tensor is a conditioning input the model moves itself."""
    try:
        from comfy import model_management
        return model_management.intermediate_device()
    except ImportError:
        return torch.device("cpu")


class OF_CameraEmbed:
    """Pose stream → Wan camera conditioning: a Plücker ray map per frame,
    packed [1, 24, (F+3)/4, H, W] for WanCameraImageToVideo's
    camera_conditions (frame 0 repeated to fill the reference latent slot;
    4n+1 frame counts only)."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "poses_json": ("STRING", {"multiline": True}),
                "width": ("INT", {"default": 480, "min": 16, "max": 4096, "step": 16}),
                "height": ("INT", {"default": 272, "min": 16, "max": 4096, "step": 16}),
            },
            "optional": {
                # pose positions are metres; the conditioning signal is trained
                # on a canonical range — rescale the deltas if the move reads
                # too weak/strong
                "translation_scale": ("FLOAT", {"default": 1.0, "min": 0.01, "max": 100.0, "step": 0.01}),
            },
        }

    RETURN_TYPES = ("WAN_CAMERA_EMBEDDING", "INT", "INT", "INT")
    RETURN_NAMES = ("camera_embedding", "width", "height", "length")
    FUNCTION = "run"
    CATEGORY = "MotionField/camera"

    def run(self, poses_json, width, height, translation_scale=1.0):
        poses = _rig.load_poses(poses_json)
        if (len(poses) - 1) % 4:
            raise ValueError(f"camera embedding needs a 4n+1 frame count, got {len(poses)}")
        emb = _embed.plucker_embedding(poses, width, height, translation_scale)
        # [F,H,W,6] → [1,6,F,H,W]; frame 0 ×4 fills the reference latent slot
        t = torch.from_numpy(emb).permute(3, 0, 1, 2).unsqueeze(0)
        t = torch.cat([t[:, :, :1].expand(-1, -1, 4, -1, -1), t[:, :, 1:]], dim=2)
        # Layout spec: [1,6,F+3,H,W] → group frames [(F+3)/4,4] → channel-major
        # 24 = 6 ray channels × the 4 frames of each group → [1,24,(F+3)/4,H,W]
        b, c, f, h, w = t.shape
        t = t.reshape(b, c, f // 4, 4, h, w).permute(0, 1, 3, 2, 4, 5)
        t = t.reshape(b, c * 4, f // 4, h, w)
        return (t.contiguous().to(_intermediate_device()), width, height, len(poses))


NODE_CLASS_MAPPINGS = {
    "OF_Trajectory": OF_Trajectory,
    "OF_DA3Poses": OF_DA3Poses,
    "OF_DA3Windowed": OF_DA3Windowed,
    "OF_CameraRig": OF_CameraRig,
    "OF_DepthBlur": OF_DepthBlur,
    "OF_CameraEmbed": OF_CameraEmbed,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "OF_Trajectory": "Trajectory",
    "OF_DA3Poses": "DA3 Poses",
    "OF_DA3Windowed": "DA3 Windowed",
    "OF_CameraRig": "Camera Rig",
    "OF_DepthBlur": "Depth Blur",
    "OF_CameraEmbed": "Camera Embed",
}
