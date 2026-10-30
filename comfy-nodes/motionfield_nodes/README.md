# MotionField nodes for ComfyUI

Custom nodes powering the [MotionField](https://github.com/jalajbhandula/motionfield)
cinematic workflows — the local, open-weights implementation of camera-move
directing, re-shoot, identity replacement and VFX plating.

## Nodes

| Node | What it does |
| --- | --- |
| `OF_Trajectory` | Turns named camera moves (dolly-in, arc-left-45, locked-off, …) into a per-frame pose stack. |
| `OF_CameraRig` | Reprojects a DA3 depth/geometry estimate along the trajectory into control frames for Wan VACE. |
| `OF_DA3Poses` | Estimates per-frame camera poses from a source clip (multiview DA3). |
| `OF_DWPose` | DWPose body/hand/keypoint extraction for identity windows. |
| `OF_DepthBlur` | Depth-of-field render from DA3 geometry. |
| `OF_MatteCoverage` | Matte quality/coverage guard for identity regions. |
| `OF_PlateAudio` | Pulls the audio stream off a plate clip so VFX output stays in sync. |
| `OF_Splat` / `OF_Box` / misc. | Camera-region boxing, 3D splatting helpers, provenance nodes. |

## Example workflows (ComfyUI Apps)

`example_workflows/` ships five `.app.json` files — real, runnable ComfyUI
Apps (linear mode) generated from the MotionField API graphs and validated
against `/object_info`:

| App | Graph | Runs on a 32 GB Mac |
| --- | --- | --- |
| **MotionField Image** | Z-Image Turbo txt2img (int8) | yes (~2 min) |
| **MotionField Director** | Start frame → directed camera move, Wan VACE 1.3B + DA3 rig | yes |
| **MotionField Re-shoot** | Clip → new camera path, DA3 multiview + Wan VACE 1.3B | yes (short clips) |
| **MotionField PersonSwap** | Identity replacement window, masked Wan VACE 1.3B | yes |
| **MotionField VFX Lab** | LTX-Video 2B 0.9.5 plate pass (partial denoise) | yes |

Install with `scripts/comfy-apps/install.sh` from the repo root — it links
this pack into `custom_nodes/` and copies the apps into
`user/default/workflows/MotionField/`. The apps expect the model files listed
in each source workflow's `_meta.requires` (Wan VACE 1.3B, umt5, wan_2.1_vae,
Z-Image Turbo, LTX-Video 0.9.5, DA3 weights, birefnet).

## License

MIT — see `LICENSE`.
