"""OF_DWPose — MotionField whole-body pose estimator.

Runs the vendored Apache-2.0 DWPose ONNX pipeline (``dwpose_onnx``) on an
IMAGE batch and renders a pose-control frame per input frame. Emits a
second ``OF_POSE_KEYPOINTS`` output: a Python list with one entry per
frame ``{width, height, persons: [{body, feet, face, hand_left,
hand_right}]}`` so hosts can reuse the keypoints without re-running
detection. Parts whose ``detect_*`` flag is off are left out of each
person dict. Persons whose best body-keypoint score is under 0.3 are
dropped (the detector falls back to a full-frame box when it finds
nobody, which otherwise emits a garbage pose).

Weights (``yolox_l.onnx`` + ``dw-ll_ucoco_384.onnx``) are resolved from
``<comfy models>/motionfield/dwpose/`` first, then
``<comfy models>/diffusers/TMElyralab/MuseTalk/dwpose/``. Set
``OF_DWPOSE_DIR`` to point at a directory containing both files directly.
"""

import os

import cv2
import numpy as np
import torch

from .core.pose_draw import BODY, FEET, FACE, HAND_LEFT, HAND_RIGHT, draw_pose
from .dwpose_onnx import Wholebody

try:
    import folder_paths
except ImportError:
    folder_paths = None

try:
    import comfy.utils as _comfy_utils
    import comfy.model_management as _model_management
except ImportError:
    _comfy_utils = None
    _model_management = None

_DET_ONNX = "yolox_l.onnx"
_POSE_ONNX = "dw-ll_ucoco_384.onnx"
_WEIGHT_DIRS = (
    os.path.join("motionfield", "dwpose"),
    os.path.join("diffusers", "TMElyralab", "MuseTalk", "dwpose"),
)
# a detected person's best body score must clear this to be kept
_PERSON_SCORE_THR = 0.3

_sessions = {}


def _model_roots():
    roots = []
    if folder_paths is not None:
        roots.append(folder_paths.models_dir)
    env = os.environ.get("COMFYUI_MODELS_DIR")
    if env:
        roots.extend(env.split(os.pathsep))
    roots.append(os.path.expanduser(os.path.join("~", "comfy", "ComfyUI", "models")))
    return roots


def find_weights():
    candidates = []
    explicit = os.environ.get("OF_DWPOSE_DIR")
    if explicit:
        candidates.append(explicit)
    for root in _model_roots():
        candidates.extend(os.path.join(root, d) for d in _WEIGHT_DIRS)
    for d in candidates:
        det = os.path.join(d, _DET_ONNX)
        pose = os.path.join(d, _POSE_ONNX)
        if os.path.isfile(det) and os.path.isfile(pose):
            return det, pose
    raise FileNotFoundError(
        "OF_DWPose: DWPose ONNX weights not found. Expected both "
        f"{_DET_ONNX} and {_POSE_ONNX} under one of: "
        + ", ".join(candidates)
        + ". Download them from https://huggingface.co/yzd-v/DWPose (Apache-2.0)."
    )


def _providers():
    import onnxruntime as ort

    override = os.environ.get("OF_DWPOSE_PROVIDER")
    if override:
        return [p.strip() for p in override.split(",") if p.strip()]
    have = ort.get_available_providers()
    if "CUDAExecutionProvider" in have and hasattr(ort, "preload_dlls"):
        try:  # reuse the CUDA/cuDNN torch already loaded (onnxruntime-gpu >= 1.21)
            ort.preload_dlls()
        except Exception:
            pass
    # CUDA first: on a GPU box the CPU path left the GPU idle for minutes per
    # clip (two DWPose passes x 81 frames of yolox_l) before sampling started
    return [p for p in ("CUDAExecutionProvider", "CoreMLExecutionProvider", "CPUExecutionProvider") if p in have]


def _wholebody(providers=None):
    det, pose = find_weights()
    key = (det, pose)
    if providers is not None:
        _sessions[key] = Wholebody(det, pose, providers=providers)
        _sessions[key]._of_providers = providers
    elif key not in _sessions:
        wanted = _providers()
        try:
            _sessions[key] = Wholebody(det, pose, providers=wanted)
        except Exception:
            if wanted == ["CPUExecutionProvider"]:
                raise
            wanted = ["CPUExecutionProvider"]
            _sessions[key] = Wholebody(det, pose, providers=wanted)
        _sessions[key]._of_providers = wanted
    return _sessions[key]


def _to_list(points, scores):
    return [
        [round(float(x), 2), round(float(y), 2), round(float(s), 3)]
        for (x, y), s in zip(points, scores)
    ]


def _frame_keypoints(keypoints, scores, width, height,
                     detect_body, detect_hands, detect_face):
    persons = []
    for kp, sc in zip(keypoints, scores):
        person = {}
        if detect_body:
            person["body"] = _to_list(kp[BODY], sc[BODY])
            person["feet"] = _to_list(kp[FEET], sc[FEET])
        if detect_face:
            person["face"] = _to_list(kp[FACE], sc[FACE])
        if detect_hands:
            person["hand_left"] = _to_list(kp[HAND_LEFT], sc[HAND_LEFT])
            person["hand_right"] = _to_list(kp[HAND_RIGHT], sc[HAND_RIGHT])
        persons.append(person)
    return {"width": int(width), "height": int(height), "persons": persons}


def _mask_scores(scores, detect_body, detect_hands, detect_face):
    masked = np.array(scores, dtype=np.float32, copy=True)
    if not detect_body:
        masked[:, :FEET.stop] = 0.0
    if not detect_hands:
        masked[:, HAND_LEFT] = 0.0
        masked[:, HAND_RIGHT] = 0.0
    if not detect_face:
        masked[:, FACE] = 0.0
    return masked


def _detect(detector, frame):
    """One detector call; on the first inference failure rebuild the sessions
    on CPU once and retry (CoreML EP can fail at run time, not session build).
    Returns the detector that answered so later frames skip the broken one."""
    try:
        keypoints, scores = detector(frame)
        return detector, keypoints, scores
    except Exception:
        if getattr(detector, "_of_providers", None) == ["CPUExecutionProvider"]:
            raise
        rebuilt = _wholebody(providers=["CPUExecutionProvider"])
        keypoints, scores = rebuilt(frame)
        return rebuilt, keypoints, scores


def _drop_low_persons(keypoints, scores):
    keep = [i for i, sc in enumerate(scores)
            if sc.size and float(np.max(sc[BODY])) >= _PERSON_SCORE_THR]
    return keypoints[keep], scores[keep]


class OF_DWPose:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE",),
                "detect_body": ("BOOLEAN", {"default": True}),
                "detect_hands": ("BOOLEAN", {"default": True}),
                "detect_face": ("BOOLEAN", {"default": True}),
                "resolution": ("INT", {"default": 512, "min": 64, "max": 4096, "step": 1}),
            }
        }

    RETURN_TYPES = ("IMAGE", "OF_POSE_KEYPOINTS")
    RETURN_NAMES = ("pose_image", "pose_keypoints")
    FUNCTION = "run"
    CATEGORY = "MotionField/pose"
    DESCRIPTION = "DWPose whole-body pose (ONNX): renders body/hands/face keypoints per frame."

    def run(self, image, detect_body, detect_hands, detect_face, resolution):
        frames = image.detach().float().cpu().clamp(0, 1)
        total = frames.shape[0]
        pbar = _comfy_utils.ProgressBar(total) if _comfy_utils is not None else None
        detector = _wholebody()
        out_images = []
        out_keypoints = []
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
            keypoints = np.asarray(keypoints, dtype=np.float32) / scale
            scores = np.asarray(scores, dtype=np.float32)
            keypoints, scores = _drop_low_persons(keypoints, scores)
            canvas = draw_pose(
                keypoints,
                _mask_scores(scores, detect_body, detect_hands, detect_face),
                h, w,
            )
            out_images.append(torch.from_numpy(canvas.astype(np.float32) / 255.0))
            out_keypoints.append(
                _frame_keypoints(keypoints, scores, w, h,
                                 detect_body, detect_hands, detect_face)
            )
            if pbar is not None:
                pbar.update_absolute(i + 1)
        return (torch.stack(out_images, dim=0), out_keypoints)


NODE_CLASS_MAPPINGS = {"OF_DWPose": OF_DWPose}
NODE_DISPLAY_NAME_MAPPINGS = {"OF_DWPose": "Pose (DWPose ONNX)"}
