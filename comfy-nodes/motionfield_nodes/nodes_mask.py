"""OF_MouthMask — per-frame lower-face/mouth mask.

Runs the same DWPose ONNX wholebody pass as OF_DWPose on each IMAGE frame
and turns the 68 face keypoints into a soft mask over the mouth + lower jaw
(see ``core/mouth.py``). The patched MuseTalk pack consumes it as the
lip-sync blend region — the legacy face segmenter it replaces is gone
from the pipeline entirely. A frame with no confident face emits an empty
mask, so an off-face stretch just stays untouched.
"""

import math

import numpy as np
import torch

from .core.face import face_mask_from_landmarks
from .core.mouth import MIN_KP_SCORE, mouth_mask_from_landmarks
from .core.pose_draw import FACE
from .nodes_pose import _detect, _wholebody

try:
    import comfy.utils as _comfy_utils
    import comfy.model_management as _model_management
except ImportError:
    _comfy_utils = None
    _model_management = None


def _best_face(keypoints, scores):
    """The person whose face is most confidently seen — a talking-head clip
    often crops the body, so face score (not body) picks the subject.
    Returns the 68 points with their scores as an (68, 3) array."""
    best, best_score = None, 0.0
    for kp, sc in zip(keypoints, scores):
        s = float(np.mean(sc[FACE])) if len(sc[FACE]) else 0.0
        if s > best_score:
            best, best_score = np.concatenate(
                [kp[FACE], sc[FACE, None]], axis=1), s
    return best if best_score >= MIN_KP_SCORE else None


class OF_MouthMask:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE",),
                "dilate": ("INT", {"default": 6, "min": 0, "max": 64, "step": 1}),
                "feather": ("INT", {"default": 9, "min": 0, "max": 63, "step": 2}),
                "resolution": ("INT", {"default": 512, "min": 64, "max": 4096, "step": 1}),
            }
        }

    RETURN_TYPES = ("MASK",)
    RETURN_NAMES = ("mouth_mask",)
    FUNCTION = "run"
    CATEGORY = "MotionField/pose"
    DESCRIPTION = "Lower-face mouth mask from DWPose face keypoints — the MuseTalk blend region."

    def run(self, image, dilate, feather, resolution):
        import cv2

        frames = image.detach().float().cpu().clamp(0, 1)
        total = frames.shape[0]
        pbar = _comfy_utils.ProgressBar(total) if _comfy_utils is not None else None
        detector = _wholebody()
        masks = []
        for i in range(total):
            if _model_management is not None:
                _model_management.throw_exception_if_processing_interrupted()
            rgb = (frames[i].numpy() * 255.0).round().astype(np.uint8)
            h, w = rgb.shape[:2]
            scale = resolution / float(min(h, w))
            if abs(scale - 1.0) > 1e-3:
                proc = cv2.resize(rgb, (max(1, round(w * scale)), max(1, round(h * scale))),
                                  interpolation=cv2.INTER_AREA)
            else:
                proc = rgb
            detector, keypoints, scores = _detect(detector, proc)
            face = _best_face(keypoints, scores)
            if face is None:
                masks.append(torch.zeros((h, w), dtype=torch.float32))
            else:
                pts = np.asarray(face, dtype=np.float64)
                pts[:, :2] /= scale  # scores stay scores
                masks.append(torch.from_numpy(
                    mouth_mask_from_landmarks(pts, w, h, dilate, feather)))
            if pbar is not None:
                pbar.update_absolute(i + 1)
        return (torch.stack(masks, dim=0),)


class OF_FaceMask:
    """Whole-face mask — the face-swap edit region.

    Same wholebody pass as OF_MouthMask but the region is the whole face:
    jaw + brows hull plus a forehead strip. An optional ``matte`` input
    (BiRefNet person matte) clips the mask to the person's silhouette so the
    forehead can't spill into the background; a frame with no confident
    face emits an empty mask, so a faceless photo just stays untouched.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE",),
                "dilate": ("INT", {"default": 10, "min": 0, "max": 64, "step": 1}),
                "feather": ("INT", {"default": 12, "min": 0, "max": 63, "step": 2}),
                "resolution": ("INT", {"default": 512, "min": 64, "max": 4096, "step": 1}),
            },
            "optional": {
                "matte": ("MASK",),
            },
        }

    RETURN_TYPES = ("MASK",)
    RETURN_NAMES = ("face_mask",)
    FUNCTION = "run"
    CATEGORY = "MotionField/pose"
    DESCRIPTION = "Whole-face mask from DWPose landmarks — the photo face-swap region."

    def run(self, image, dilate, feather, resolution, matte=None):
        import cv2

        frames = image.detach().float().cpu().clamp(0, 1)
        total = frames.shape[0]
        pbar = _comfy_utils.ProgressBar(total) if _comfy_utils is not None else None
        detector = _wholebody()
        clip = None
        if matte is not None:
            m = matte.detach().float().cpu()
            if m.dim() == 2:
                m = m.unsqueeze(0)
            clip = (m > 0.5).float()
        masks = []
        for i in range(total):
            if _model_management is not None:
                _model_management.throw_exception_if_processing_interrupted()
            rgb = (frames[i].numpy() * 255.0).round().astype(np.uint8)
            h, w = rgb.shape[:2]
            scale = resolution / float(min(h, w))
            if abs(scale - 1.0) > 1e-3:
                proc = cv2.resize(rgb, (max(1, round(w * scale)), max(1, round(h * scale))),
                                  interpolation=cv2.INTER_AREA)
            else:
                proc = rgb
            detector, keypoints, scores = _detect(detector, proc)
            face = _best_face(keypoints, scores)
            if face is None:
                masks.append(torch.zeros((h, w), dtype=torch.float32))
            else:
                pts = np.asarray(face, dtype=np.float64)
                pts[:, :2] /= scale  # scores stay scores
                mask = torch.from_numpy(
                    face_mask_from_landmarks(pts, w, h, dilate, feather))
                if clip is not None:
                    c = clip[min(i, clip.shape[0] - 1)]
                    if c.shape[-2:] != (h, w):
                        import torch.nn.functional as F
                        c = F.interpolate(c[None, None], size=(h, w),
                                          mode="bilinear", align_corners=False)[0, 0]
                    mask = mask * c
                masks.append(mask)
            if pbar is not None:
                pbar.update_absolute(i + 1)
        return (torch.stack(masks, dim=0),)


class OF_MatteCoverage:
    """Matte passthrough plus a per-frame coverage strip.

    The mask flows out untouched; alongside it the node emits a 1xN IMAGE
    strip where each column is that frame's coverage fraction (pixels > 0.5).
    The strip survives a SaveImage round-trip, so the job-side recipe can read
    exact per-frame coverage back — a refusal report gets real numbers and a
    matte frame for evidence instead of vibes. Used by the person-swap graphs to
    gate "person actually detected" before/as the VACE pass runs.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"mask": ("MASK",)}}

    RETURN_TYPES = ("MASK", "IMAGE")
    RETURN_NAMES = ("mask", "coverage")
    FUNCTION = "run"
    CATEGORY = "MotionField/mask"
    DESCRIPTION = "Matte passthrough + 1xN per-frame coverage strip (for SaveImage/readback)."

    def run(self, mask):
        m = mask.detach().float().cpu()
        if m.dim() == 2:
            m = m.unsqueeze(0)
        cov = (m > 0.5).float().mean(dim=(1, 2))          # (B,) fraction covered
        n = int(m.shape[0])
        strip = cov.reshape(1, 1, n, 1).expand(1, 1, n, 3).contiguous()
        return (mask, strip)


class OF_MaskTrack:
    """Frame-0 pick → per-frame tracked matte.

    ``pick`` is the region the user painted/boxed on frame 0. Frame 0's
    track is the pick clipped to that frame's matte; every later frame
    keeps only the part of the per-frame BiRefNet matte that still overlaps
    the previous frame's track (dilated ``overlap_px`` for drift). The
    tracked region follows the picked object while unrelated salient blobs
    never join the regen zone; a frame that loses the track keeps the last
    position so a brief occlusion doesn't kill it.

    A mean coverage under ``min_coverage`` raises — an object the track
    lost fails the job with a clear message instead of regenerating the
    whole frame at random. The second output is the same 1xN per-frame
    coverage strip OF_MatteCoverage emits, so evidence readback is shared.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "matte": ("MASK",),
                "pick": ("MASK",),
                "min_coverage": ("FLOAT", {"default": 0.01, "min": 0.0, "max": 1.0, "step": 0.005}),
                "overlap_px": ("INT", {"default": 12, "min": 0, "max": 128, "step": 1}),
            },
            # pick_image is not read. Graphs put an optional {{MASK_IMAGE}}
            # placeholder here so the whole node drops when the caller sent
            # no still mask — consumers then lose the link instead of
            # tracking a missing pick.
            "optional": {
                "pick_image": ("STRING", {"default": ""}),
            },
        }

    RETURN_TYPES = ("MASK", "IMAGE")
    RETURN_NAMES = ("mask", "coverage")
    FUNCTION = "run"
    CATEGORY = "MotionField/mask"
    DESCRIPTION = "Track the frame-0 pick through the per-frame matte; refuse when coverage collapses."

    def run(self, matte, pick, min_coverage, overlap_px, pick_image=""):
        # The string is only a graph drop-switch (see INPUT_TYPES). Reading it
        # would keep this node when the caller never sent a still mask.
        del pick_image
        import torch.nn.functional as F

        m = matte.detach().float().cpu()
        if m.dim() == 2:
            m = m.unsqueeze(0)
        p = pick.detach().float().cpu()
        if p.dim() == 2:
            p = p.unsqueeze(0)
        p = p[:1]
        if p.shape[-2:] != m.shape[-2:]:
            p = F.interpolate(p.unsqueeze(1), size=m.shape[-2:],
                              mode="bilinear", align_corners=False).squeeze(1)
        r = max(0, int(overlap_px))

        def dilate(x):
            if r == 0:
                return x
            return F.max_pool2d(x.float()[None, None],
                                kernel_size=2 * r + 1, stride=1, padding=r)[0, 0] > 0.5

        prev = p[0] > 0.5
        out, cov = [], []
        for i in range(m.shape[0]):
            tracked = (m[i] > 0.5) & dilate(prev)
            out.append(tracked.float())
            cov.append(float(tracked.float().mean()))
            if tracked.any():
                prev = tracked
        mean_cov = sum(cov) / max(1, len(cov))
        if mean_cov < float(min_coverage):
            raise ValueError(
                f"object track lost — mean coverage {mean_cov * 100:.1f}% under the "
                f"{min_coverage * 100:.0f}% floor; re-pick a region the matte can follow")
        n = len(cov)
        cov_t = torch.tensor(cov, dtype=torch.float32)
        strip = cov_t.reshape(1, 1, n, 1).expand(1, 1, n, 3).contiguous()
        return (torch.stack(out, dim=0), strip)


class OF_DrawMask:
    """Ink mask for draw-to-video.

    The edited frame is the clean frame plus a stroke. Pixels that differ
    become the regen mask; the edited frame itself is never a VACE reference
    image, so the stroke color cannot take over the clip. The mask is dilated
    and repeated to ``frames`` so control_masks matches the loaded clip.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "edited": ("IMAGE",),
            "base": ("IMAGE",),
            "frames": ("INT", {"default": 81, "min": 1, "max": 10000}),
            "threshold": ("FLOAT", {"default": 0.08, "min": 0.0, "max": 1.0, "step": 0.01}),
            "grow": ("INT", {"default": 16, "min": 0, "max": 128}),
        }}

    RETURN_TYPES = ("MASK",)
    RETURN_NAMES = ("mask",)
    FUNCTION = "run"
    CATEGORY = "MotionField/mask"
    DESCRIPTION = "Stroke mask from an edited frame versus the clean frame under it."

    def run(self, edited, base, frames, threshold, grow):
        import torch.nn.functional as F

        e = edited.detach().float().cpu()[:1]
        b = base.detach().float().cpu()[:1]
        if e.ndim != 4 or b.ndim != 4:
            raise ValueError("OF_DrawMask expects IMAGE batches [B,H,W,C]")
        # the mask has to match the source frames (base), not the upload
        if e.shape[1:3] != b.shape[1:3]:
            e = F.interpolate(
                e.permute(0, 3, 1, 2), size=b.shape[1:3],
                mode="bilinear", align_corners=False,
            ).permute(0, 2, 3, 1)
        # mean absolute difference across channels — ink, not a whole-frame regrade
        diff = (e - b).abs().mean(dim=-1)
        mask = (diff > float(threshold)).float()
        r = max(0, int(grow))
        if r:
            mask = (F.max_pool2d(mask[:, None], kernel_size=2 * r + 1, stride=1, padding=r)[:, 0] > 0.5).float()
        # a thin stroke plus a fixed grow leaves ~3-4% of the frame - below
        # what VACE 1.3B will actually repaint (object-swap's tracked matte is
        # 4-6x that). Expand the stroke's bounding box until the mask covers
        # MIN_FRAC so the model gets a region it can draw the object in.
        MIN_FRAC = 0.06
        h, w = mask.shape[-2:]
        nz = mask[0].nonzero()
        if nz.numel():
            y0, x0 = nz.min(dim=0).values.tolist()
            y1, x1 = nz.max(dim=0).values.tolist()
            cover = mask[0].mean().item()
            if cover < MIN_FRAC:
                area = (y1 - y0 + 1) * (x1 - x0 + 1)
                scale = max(1.0, (MIN_FRAC * h * w / max(1, area)) ** 0.5)
                cy, cx = (y0 + y1) / 2, (x0 + x1) / 2
                bh = min(h, int(math.ceil((y1 - y0 + 1) * scale / 2) * 2))
                bw = min(w, int(math.ceil((x1 - x0 + 1) * scale / 2) * 2))
                ny0 = max(0, min(h - bh, int(round(cy - bh / 2))))
                nx0 = max(0, min(w - bw, int(round(cx - bw / 2))))
                grown = torch.zeros_like(mask[0])
                grown[ny0:ny0 + bh, nx0:nx0 + bw] = 1.0
                mask = grown[None]
        # feather the edge so the paste-back blends instead of leaving a hard
        # seam (object-swap feathers its matte; a hard box reads as a cut-out)
        k = max(3, (r // 2) * 2 + 1)
        mask = F.avg_pool2d(mask[:, None], kernel_size=k, stride=1, padding=k // 2)[:, 0].clamp(0, 1)
        n = max(1, int(frames))
        mask = mask.expand(n, -1, -1).contiguous()
        return (mask,)


class OF_CropToMask:
    """Crop an image to a mask's bounding box, padded by a fraction of the
    box size.

    Returns the crop plus the rect it came from as plain ints, so a graph
    can edit the tight region and paste the result back at the same offset
    (ImageCompositeMasked takes x/y). The face-swap graph feeds the model a
    face-tight canvas instead of a mostly-background photo — the identity
    signal fills the latent instead of being a small region of it. An empty
    mask returns the frame whole (origin 0,0) — a faceless photo degrades
    to the old full-frame edit rather than crashing the run.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE",),
                "mask": ("MASK",),
                "pad_frac": ("FLOAT", {"default": 0.4, "min": 0.0, "max": 2.0, "step": 0.05}),
            }
        }

    RETURN_TYPES = ("IMAGE", "INT", "INT", "INT", "INT")
    RETURN_NAMES = ("image", "x", "y", "width", "height")
    FUNCTION = "run"
    CATEGORY = "MotionField/mask"
    DESCRIPTION = "Crop to the mask's padded bounding box; emits the rect so the edit can be pasted back."

    def run(self, image, mask, pad_frac):
        m = mask.detach().float().cpu()
        if m.dim() == 2:
            m = m.unsqueeze(0)
        cover = (m > 0.5).any(dim=0)                    # union over the batch
        ys, xs = torch.nonzero(cover, as_tuple=True)
        _, h, w, _ = image.shape
        if xs.numel() == 0:
            return (image, 0, 0, w, h)
        x0, x1 = int(xs.min()), int(xs.max()) + 1
        y0, y1 = int(ys.min()), int(ys.max()) + 1
        pad = round(max(x1 - x0, y1 - y0) * float(pad_frac))
        x0 = max(0, x0 - pad)
        y0 = max(0, y0 - pad)
        x1 = min(w, x1 + pad)
        y1 = min(h, y1 + pad)
        return (image[:, y0:y1, x0:x1, :], x0, y0, x1 - x0, y1 - y0)


NODE_CLASS_MAPPINGS = {
    "OF_MouthMask": OF_MouthMask,
    "OF_FaceMask": OF_FaceMask,
    "OF_MatteCoverage": OF_MatteCoverage,
    "OF_MaskTrack": OF_MaskTrack,
    "OF_DrawMask": OF_DrawMask,
    "OF_CropToMask": OF_CropToMask,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "OF_MouthMask": "Mouth mask (DWPose landmarks)",
    "OF_FaceMask": "Whole-face mask (DWPose landmarks)",
    "OF_MatteCoverage": "Matte coverage strip",
    "OF_MaskTrack": "Frame-0 pick mask track",
    "OF_DrawMask": "Draw stroke mask",
    "OF_CropToMask": "Crop to mask bounds",
}
