# Camera benchmarks - trajectory → motion on video

Measured on the M1 Pro Mac (ComfyUI `127.0.0.1:8188`, wan 1.3B fp16 weights,
8 sampler steps, 480×272 @ 16 fps). Harness: `comfy-nodes/tests/cam_smoke.py`
submits the bundled workflow; `--save-control` prunes the same graph to the
control branch (`LoadImage → DA3 → OF_Trajectory → OF_CameraRig → saves`) so
the rig's own output is measured on the real depth estimate.
`comfy-nodes/tests/motion_check.py` measures the video against that
reference (`--ref`) - drift magnitude ≥25 % of the control's, same
direction, subject-centre lock ≤4 px mean.

## Control truth (rig on real DA3 depth - the commanded motion)

| run | metric | result |
|---|---|---|
| arc-left-45 1 s | bg-vs-centre drift | **−24.0 px** (real orbit); centre drift 4.6 px; holes grow to 69 % |
| arc-left-45 3 s | drift | **−14.95 px**, centre lock 0.38 px |
| dolly-in 1 s | centre scale | **1.525×** (corr 0.93), holes ≈2 % |
| dolly-out 1 s | centre scale | **0.75×** (corr 0.89), holes to 27 % |

The rig produces real, measurable camera motion on real depth - the moved
view is in the control frames. Hole share is the honest disocclusion cost of
a 45° orbit (69 % of late pixels are generated).

## VACE rig path (`cam-i2v.json`, `camera_path=rig`)

| run | vs control | verdict |
|---|---|---|
| arc-left-45 3 s s1 | −2.75 px vs −14.95 px (18 %), centre locked | **near-static** - most of the orbit is swallowed |
| arc-left-45 1 s s0.5, DISTANCE=2 / 8 | 0.47 px both - pixel-identical output | lever inert: distance cancels (pose deltas and rig depth scale together) |
| arc-left-45 1 s s0.5, FOV=60 | 0.97 px | no help |
| arc-left-45 1 s s0.5, CAM_W/H=640×360 | - | **fails**: VACE latent-token count mismatch at that size (5280 vs 5520) |
| dolly-out 1 s s1 | scale 0.75× matches the control's 0.75× | **passes** - push/pull moves execute |

So on the rig path: dolly in/out execute - and they are the only moves
measured end-to-end on the GPU; pan, truck and crane were checked on the
CPU rig only, not through VACE. Orbit stacks survive at ≲18 % - hence
the "partial" chip + near-static note in the picker. Honest, and stays.

Whole-clip re-score (`motion_check.py --frames all`, every frame matched
against frame 0 - 48 frames scored on `i2v_arc3s1` vs its `ctl_arc3` rgb
control): **−8.94 px** bg-vs-centre drift vs the control's **−3.01 px**
measured over the same window (the control's own first-8 value is
−14.95 px - late frames re-converge), subject-centre mean drift 6.46 px,
max 17 px - the centre lock fails over the full clip. Verdict unchanged:
**near-static orbit, partial**.

## Wan2.1-Fun camera path (`cam-i2v-fun.json`, `camera_path=fun`)

Capability probe - the native `WanCameraEmbedding` presets, same Wan-Fun
`wan2.1_fun_camera_v1.1_1.3B_bf16` DiT the workflow loads (Apache-2.0,
sha256 `1a648f6fbb543dd6ac9f2f9af1ca4bc1bbe460482ee4d7984d50565699e97398`,
3,232,727,784 B). Rows below are labelled by the move the preset actually
commands (the native presets are coarse: no 45° arc, no aim point, no
stacks - Pan Left is a lateral translation, Zoom In a push, Anti
Clockwise an on-axis roll):

| run | move | measured | verdict |
|---|---|---|---|
| 1 s | truck | bg drift **+11.5 px** | real lateral move |
| 1 s | dolly | strong push-in (visual: figure ~1.4× at end; centre-scale metric noisy on the flat subject) | real push |
| 1 s | roll | on-axis rotation - subject slides as bg sweeps | real roll, **no aim lock** (centre drift 42 px - the preset doesn't look at the subject) |
| 3 s | dolly | scale **1.10×**, corr 0.70 | real push-in |
| 3 s | truck | bg drift **−8.67 px** | real lateral move - the truck sign flips between 1 s (+11.5 px) and 3 s (−8.67 px) |
| 3 s | roll | rel drift **+32.6 px** | real rotation sweep |

The Fun camera conditioning demonstrably moves the camera on dolly, truck
and roll. **Orbit not measured on Fun** - no probe row exercised an orbit,
so nothing is claimed for orbits there either. `OF_CameraEmbed`
(`core/camera_embed.py` - own Plücker implementation, CPU-tested in
`test_camera_embed_plucker_layout`) feeds the real pose stream through the
same `camera_conditions` slot. It registers with the node pack on the next
ComfyUI start; the poses end-to-end through the model are the remaining
verification.

**C1 decision**: `camera_path` wiring lands on the CameraRig endpoint -
`rig` (default, verified) stays the only selectable path; `fun`
(cam-i2v-fun.json, conditioned by the pose stream once OF_CameraEmbed is
registered on the host) is refused at the endpoint's validate gate until
the poses-through-Fun measurement lands. Orbit rows keep "partial" -
nothing is claimed unexecuted.

## Director smokes (Wan VACE 1.3B, ws3)

`pnpm exec tsx scripts/director-smoke.ts "<prompt>" [--image <start.png>] [--ref a.png --ref2 b.png --ref3 c.png] [--dims WxH] --params '{...}' --out <evidence.json>`
submits the real catalog workflow (`DIRECTOR.workflows[0]`) - `validate` →
`workflowFor` → `map` → `substitute` → `post` all run. Inputs come from
`/tmp` and upload through the SDK's asset path; outputs download under
`/tmp/of-evidence/media` - nothing touches `public/files`. Motion evidence is
`comfy-nodes/tests/motion_check.py` run on the downloaded MP4; the poses JSON
the rig consumed is regenerated host-side (same
`camera_trajectory.compose_trajectory`, seed-pinned) under
`/tmp/of-evidence/` and embedded in the evidence JSON.

| Case | Result | Wall time | Notes |
|---|---|---|---|
| **A′** (s5fix): `--image frame.png --params '{"moves":"dolly-in+pan-left","camera_aperture":"f1.4","camera_lens":"wide-24","steps":6}' --dims 480x272` | ✅ pass | **118 s** (cold) | `director-wan.json` at the 480×272 cap - DA3 depth → `OF_Trajectory` (dolly+pan stack, fov 73.74° from 24 mm/FF) → `OF_CameraRig` → `WanVaceToVideo` → `OF_DepthBlur` → VHS → 480×272×17 h264 **19.8 KB** `generated/83f8fa9c-….mp4`, sha256 `3006594bd230…`, ffprobe 17 f / 1.0625 s. `motion_check.py`: `{"move":"dolly-in","scale":1.225,"corr":0.9532,"pass":true}`, `{"move":"pan-left","bg_dx_px":-2.625,"pass":true}` - both halves of the stack verified. Poses: `tests/artifacts/director-poses-345992f1.json`. |
| **B′** (s5fix): `--image frame.png --ref a.png --ref2 b.png --params '{"moves":"truck-right","camera_aperture":"f2.8","color_palette":"cinema-amber","camera_body":"35mm-film","steps":6}' --dims 480x272` | ✅ pass | **106 s** (warm) | `director-wan.json`, 2 refs - the ref grid ran end-to-end: `tests/artifacts/director-refgrid-b.png` (480×272 padded composite, sha256 `e62da4655ab5…`) shows `[start refA / start refB]` - every supplied ref + the start anchor at quarter-frame, nothing centre-cropped. Post `{body:"35mm-film",palette:"cinema-amber"}` → 480×272×17 h264 **80.7 KB** `generated/1b70c6f9-….mp4`, sha256 `6e8b62a56665…`, ffprobe 17 f / 1.0625 s. LUT `.cube` sha256 `5677ea4f2fcf0f05…` - byte-identical to the earlier run, the content-addressed cache holds. Poses: `tests/artifacts/director-poses-90369c2d.json`. **⚠ graded-file colours invalid**: this `.cube` was written under the pre-`e31bbc9` blue-fastest bug - ffmpeg `lut3d` read rows red-fastest, so the graded mp4 swapped red↔blue (the "warm" cast actually leaned blue). Ungraded render/refgrid/motion evidence unaffected. Corrected re-grade under the fixed LUT: see **P-LUT** below. |

**Wan VACE 1.3B warm render ≈ 106 s** for a 17-frame 480×272 6-step shot
(cold ≈ 118 s) - the number ws4's verification caps should scale from
(1.5× → ~160 s for this size; scale for frames/steps/dims).

Every control is exercised through the same params the UI sends; `modern`
body + no palette produces `vf:null` (no grade) by design. Temporary run
outputs (the two generated mp4s, the `{{PREFIX}}-refgrid` files in Comfy's
output dir - now `{{REFGRID_PREFIX}}`/`{{KEYFRAME_PREFIX}}` after s11's
prefix split) were deleted after evidence capture - artifacts kept: poses
JSONs + the padded refgrid composite under `tests/artifacts/`.

## s7 re-shoot smokes (`reshoot-video.json`, local MPS)

`comfy-nodes/tests/reshoot_smoke.py <clip> --moves <m> --steps 4 --da3-res 504`
uploads the clip and submits the shipped Mac graph (`VHS_LoadVideo → DA3-Base
multiview → OF_DA3Poses → OF_Trajectory (anchored at source frame 0) →
OF_CameraRig → Wan VACE 1.3B → VHS`). Sources are built with ffmpeg from
`tests/fixtures/verify/street.png`. Evidence: `tests/artifacts/reshoot-*`.

| Case | Result | Wall time | Notes |
|---|---|---|---|
| **S1**: static 17 f @24 fps 320×180 + `dolly-in` | ✅ pass | **70 s** | `motion_check dolly-in`: `scale 1.65, corr 0.891` (≥1.1×). Out 17 f/24 fps/320×176 **silent** (source aac dropped) - `tests/artifacts/reshoot-s1.mp4`, side-by-side `reshoot-s1-side.png` 31 KB |
| **S2**: sliding-crop pan 17 f + `locked-off` | ✅ pass | **48 s** | source band-drift **+51 px** → residual **−2.5 px (4.9 % ≤ 30 %)** - the new path replaced the source's own move. DA3 recovered yaw **+4.76°** rightward = the known pan's sign; roll ≤0.45°. `tests/artifacts/reshoot-s2.mp4`, side-by-side `reshoot-s2-side.png` 30 KB |
| **S3** (s7fix, real app path): 17 f @30 fps 1920×1080 (`street.png` crop, aac +0.1 s over video) + `dolly-in`, steps 4 | ✅ pass | **328 s** | driven through the app on :3130: sign-up → upload → probe → submit → poll → output fetched over HTTP. `probe.frames=17` is the **packet count** (container dur 0.666 s ×30 would read 20); params `832×464` came from the aspect fit - job ran end-to-end. Out 17 f/30 fps/832×464 **silent**. `motion_check dolly-in`: `scale 1.65, corr 0.769`, monotonic 1.0→1.65 across all 17 f (≥1.1). ETA rate `1.25e-5` s/frame·px·step. `tests/artifacts/reshoot-s7fix.mp4`, side-by-side `reshoot-s7fix-side.png` 37 KB. An earlier run on a synthetic `testsrc2` clip passed every timing assert but scored `scale 0.85` - the repeating bars alias the centre-crop matcher (mid-clip zoom reached 1.6 then folded); the rig render itself was CPU-verified zoom-in (0.95→1.45). Not a pipeline regression. |

Pose-recovery sweep (CPU residual vs 51 px source, `cam_dec` unless noted):
res 504/`saddle_balanced` **5.7 %** · 504/`first` 5.4 % · 280/`saddle_balanced`
35.7 % · `ray_pose` does not converge on the near-planar scene (SVD) -
`cam_dec` is the shipped choice; res 504 is the graph default.

**s8 - long-clip re-shoot (73 f @832×480, LTX-generated street clip of a
synthetic woman in a red coat walking toward camera)** - the graph now runs
`OF_DA3Windowed` (overlapping-window DA3 chained by camera-centre
similarity; a 73 f single pass needs ~140 GB and dies on this Mac) →
`OF_DA3Poses` → `OF_Trajectory` → `OF_CameraRig` (`subject_mode=billboard`:
the subject is projected through the new pose - translate/scale/roll/
foreshorten - instead of pinned at source screen coords) → Wan VACE.
Source audio wires `VHS_LoadVideo` out 2 into `VHS_VideoCombine`.

| Case | Result | Wall time | Notes |
|---|---|---|---|
| **S8-ctl-arc**: 73 f + `arc-left-45`, control-only (rig render, no VACE) | ✅ pass | **745 s** | 73 f/24 fps/832×480 exact match. Hole share mean **75 %** (8 % first 10 f → 92 % last 10 f) - the 45° arc exits the captured geometry, so the picker labels it `partial` (VACE invents the majority). Subject stays coherent while geometry holds - sheet `tests/artifacts/reshoot-s8-ctl-arc.jpg`. DA3 windowed: 8×10 f windows @504 + stitch, ~10 min of the wall |
| **S9-pan-final**: 49 f + `pan-left`, full VACE @steps=2 (gpu-run 1500 s slot: ~12.5 min cold preamble + ~227 s/step leaves 2; app default is 8) | ✅ pass | **1301 s** | 49 f/24 fps/832×480/2.04 s, source AAC muxed. `motion_check pan-left` **−28.5 px pass** - commanded 12° yaw ≈ 95 px sweep at f=447; envelope-mean expects 18.8 px, measured 28.5 = **152 % of commanded** (≥70 % bar). qwen3.5 judge on the 6-tile strip: dupes/stripes **clean**; identity read "different head/hat" - a 15-px-head artifact: the subject-crop pair `reshoot-s9-pan-left-subj.png` shows the same red-coat walker mid-stride; direction read "static" - contradicted by the measured drift (first/last pair `reshoot-s9-pan-left-firstlast.png` shows the re-projected view). Video `reshoot-s9-pan-left.mp4`, strip `reshoot-s9-pan-left-strip.png`. Record in `tests/artifacts/reshoot-evidence.json` → `s9` |
| **S9-ctl-arc (sv2 verify)**: 49 f + `arc-left-45`, control-only | ✅ pass | **582 s** | hole mean **28.6 %**, max 37.4 %, last-10 36.5 % - the stitch fix (`ca63f61`) vs **100 % black** pre-fix: camera-centre Umeyama scale collapsed 275× on the locked-off source; scale now comes from shared-view depth ratios (rigid per-view R,t deltas), `_sv2` cache key. Depth medians flat 1.096→1.081 over all 49 f. `hole_clamp=0.35` holds the camera at the disocclusion boundary |
| **S8/S9 remaining moves**: `dolly-in`, `arc-left-45`, `locked-off`, `truck-left`, `crane-up` full VACE | ⏳ queued | - | slot-capped: VACE 1.3B needs ~227 s/step @832×480×49 f; finals land one per gpu-run slot as the shared queue frees |

Picker honesty (CPU rig sweep, `tests/artifacts/reshoot-move-sweep.json`):
five moves whose final frames are ~100 % holes are dropped from
`RESHOOT_TRAJECTORY_IDS` (`whip-pan-left/right`, `snap-tilt-down`,
`drone-flyover`, `motion-control-sweep`); 22 high-disocclusion moves carry a
`partial` badge - the chip explains part of the new view is generated.

**Fix logged during s7 verification**: `camera_da3.geometry_to_poses`
converted OpenCV extrinsics with a one-sided y-flip (`flip·R` - a reflection,
det −1). Every recovered pose read roll≈±180° and the reprojection
conjugated the source move (residual ≈175 % of the pan). The change of basis
must conjugate both frames - `flip·R·flip` - which is what now ships.

## s10 VFX Lab smokes (`/visual-effects`, local MPS)

`pnpm exec tsx scripts/vfx-verify.ts --id <preset> --engine <ltx095|wan>
[--image] [--structure <depth|pose|edges|image>] --write` - verifies through
the real job path (`createJob` → comfy provider → output sha256 → side-by-side
sheet under `tests/artifacts/`), then stamps the preset record in
`tests/fixtures/vfx-verify.json`. Plate source: `tests/fixtures/verify/clip-2s.mp4`
(480×320, 24 fps, 2 s, silent - `OF_PlateAudio` carries it without erroring).

**s11 honesty fix** - completing ≠ verified. Two review rounds found records
whose outputs just re-render the plate. `vfx-verify` now diffs ~6 mid-span
output frames (past the pinned HOLD head, before the pinned tail; ~9 skip on
still runs) against the plate at the same timestamps on a 64×36 luma plane -
the `effect_diff` metric (mean |Δ| 0-255) lands in the record, and a run under
the `EFFECT_DIFF_MIN` floor (12) stamps `weak`, never `verified` - and the
grid gate (`vfxPresetVerified`) also wants the metric present, so pre-s11
stamps don't count. Measured: s10 cosmetic rows 5.4-7.4, landed effects 15+.
The side-sheet is now the sampled span itself (output over plate at the same
times), not a head-frame pair.

| Preset / engine | Result | Wall time | Notes |
|---|---|---|---|
| `vfx-frostbite` · ltx095 (plate) | ✅ verified Δ**15.3** | **85 s** warm | 49 f @24 fps 480×320, lock `strong` hold `9`, **8 steps** (the page default). Street section unmistakably frozen - icicles, snow, frosted trees; portrait/product keep identity under the face prior. `tests/artifacts/vfx-frostbite-side.png`. |
| `vfx-molten` · ltx095 (plate) | ✅ verified Δ**16.26** | **55 s** | 49 f @24 fps 480×320, lock `strong` hold `9`, 8 steps - building runs molten-orange on the street section. `tests/artifacts/vfx-molten-side.png`. |
| `vfx-ashfall` · ltx095 (plate) | ✅ verified Δ**15.4** | **58 s** | 49 f @24 fps 480×320, lock `strong` hold `9`, 8 steps - grey ash blanket on the street section. `tests/artifacts/vfx-ashfall-side.png`. |
| `vfx-frostbite` · ltx095 (plate, lock `full` probe) | ✅ Δ**77.43** | **70 s** | s11 graph proof: denoise 1.0 re-noises hard off the plate (a different portrait renders) - SplitSigmasDenoise → SamplerCustom `add_noise` wiring is sound; the s10 weakness was lock strength + prompt, not the graph. Scratch record only. |
| `vfx-overgrowth` · wan alt (depth) | ✅ verified Δ**93.55** | **266 s** | 33 f @16 fps 480×320 - DA3 depth control; foliage claiming the portrait/product sections (some depth-grid shimmer in dark regions). `tests/artifacts/vfx-overgrowth-side.png`. |
| `vfx-overgrowth` · wan alt (pose) | ⚠️ weak-by-eye | **347 s** | s10 record - completes but the "green" is DWPose skeleton/grid bleed, not foliage. Dropped: re-verified on depth above; `alt_structure` now pins `depth`. |
| `vfx-frostbite` · ltx095 (image) | ⚠️ would-be-weak | **158 s** | s10 image-plate record - still `street.png` → 65 f, diff vs still ~7.4 (cosmetic). Record superseded by the plate run above. |
| `vfx-frostbite` · ltx095 (plate, s10) | ⚠️ would-be-weak | **525 s** | s10 first run - diff ~5.5 vs plate (cosmetic), `b5bc2308…` artifact kept on disk. |
| `vfx-molten` · ltx095 (plate, s10) | ⚠️ would-be-weak | **378 s** | diff ~5.4 - cosmetic. |
| `vfx-ashfall` · ltx095 (plate, s10) | ⚠️ would-be-weak | **33 s** | diff ~5.4 - cosmetic. |

## s11 - cloud-GPU smokes (local proxy `127.0.0.1:8189`; the remote-GPU tunnel `18189` was down)

The rewritten smoke went through the SDK's asset upload + job poll - inputs
from `/tmp`, outputs to `/tmp/of-evidence/media`, evidence JSONs committed
under `tests/artifacts/director-s11-*.json`. The aux-prefix split is proven
on the wire: refgrid/keyframe outputs land under `of_dir_<id>-refgrid` /
`of_dir_<id>-keyframe`, never under the video's `{{PREFIX}}`.

| Case | Result | Wall time | Notes |
|---|---|---|---|
| **T** (text→video, `director-wan-txt.json`, s11fix): `"a lighthouse on a cliff at dusk"` `--params '{"moves":"dolly in then pan left","camera_aperture":"f1.4","camera_lens":"wide-24","steps":6}' --dims 480x272` | ✅ pass | **261 s** | The phrase resolves to `dolly-in+pan-left` (`resolveMoves` - the prior s11-T passed `"orbit-right"`, not a catalog id, so that run stayed locked-off). Z-Image keyframe (`of_dir_be59aee0-keyframe_*.png`, 643 KB, sha256 `52ebb209…`) → refgrid (`of_dir_3a876841-refgrid_*.png`, 109 KB, sha256 `1861a6fc…`) → VACE 480×272×17 h264 **82.5 KB** `of_smoke-9a_00001.mp4`, sha256 `fbb82cae…`. `motion_check.py`: `{"move":"dolly-in","scale":2.6,"corr":0.6364,"pass":true}` + `{"move":"pan-left","bg_dx_px":-4.875,"pass":true}` - **both halves of the stack execute on the text path**. Committed PNGs ≤100 KB: `tests/artifacts/director-s11-keyframe-T.png` (62 KB), `director-s11-refgrid-T.png` (37 KB). Evidence `tests/artifacts/director-s11fix-T.json` (poses embedded), motion JSON `tests/artifacts/director-s11fix-motioncheck.json`. |
| **R** (i2v + 3 mixed-aspect refs, `director-wan.json`): `--image start.png --ref ref-16x9.png --ref2 ref-4x3.png --ref3 ref-portrait.png --params '{"moves":"truck-right","steps":6,"camera_body":"35mm-film","color_palette":"cinema-amber"}' --dims 480x272` | ✅ pass | **124 s** | 3 refs (16:9 / 4:3 / portrait) → padded refgrid 480×272 `of_dir_2eda7d93-refgrid_*.png` (46 KB, sha256 `9db81803…`); post `{body:"35mm-film",palette:"cinema-amber"}` graded host-side via `postSpecFor`+`ffmpegVideo` → `of_smoke-ec_00003.graded.mp4` 480×272×17 h264 **112 KB**, sha256 `27b19324…`. `motion_check.py` truck-left signature on the truck-right clip: `bg_dx_px +20.06` - inverted sign convention ⇒ the scene slid left, truck-right direction confirmed. `.cube` sha256 `5677ea4f2fcf0f0552e3d2e0bb8c3aed352f3d115a0ea26b2ebab4fee077a12e` (content-addressed, `lutSha("cinema-amber")`). **⚠ graded-file colours invalid** - same pre-`e31bbc9` blue-fastest `.cube` bug as B′; the 112 KB graded mp4 is red↔blue swapped. Refgrid + motion evidence unaffected. Corrected re-grade: **P-LUT** below. |
| **Z** (0-ref i2v, `director-wan.json`): `--image start.png --params '{"moves":"dolly-in","steps":6}' --dims 480x272` | ✅ pass | **101 s** | Zero refs - every stitch's image1 is the start frame, so the refgrid lands as **the start frame twice, letterboxed** (`of_dir_095650cf-refgrid_*.png`, 27 KB). `motion_check.py` dolly-in: `scale 1.675, corr 0.9968, pass:true`. 480×272×17 h264 **118 KB** `of_smoke-5e_00003.mp4`, sha256 `9ff77135…`. |
| **Z A/B** (0-ref `reference_image`): (i) existing Z run fed the doubled letterboxed grid; (ii) re-run same start + seed on a serial-collapse candidate graph feeding the **plain start frame** | decided - **no graph change** | **131 s** | Frames 0/8/16 contact sheet `tests/artifacts/director-s11fix-ZAB.png` + border-luma diff: every edge within ~1-2/255 and identical motion (`{"move":"dolly-in","scale":1.675,"corr":0.9966,"pass":true}` vs `0.9968`) ⇒ the doubled grid produces no measurable artefact - VACE's centre-crop absorbs it. The serial-collapse rewrite (0 refs → plain start) was **reverted, not landed**: the 2-col grid keeps more pixels per ref when refs exist. Evidence `director-s11fix-Z2.json`, `director-s11fix-motioncheck.json`. |
| **default render** (3 s, 832×480, 8 steps - the shipped default) | - | **~26 min (extrapolated, unmeasured - lower bound)** | Scaled from the 131 s warm 480×272×17 @ 6-step render: ×2.88 frames (49/17), ×3.06 pixels, ×1.33 steps. Honest estimate for the verify budget - no GPU run was spent on it (the 480×272 cap stands). |

## s11 cloud workflows - no cloud GPU reachable

`ssh -N -L 18189:127.0.0.1:8189` was not up; no cloud GPU host was provisioned
this session. The new cloud graphs are therefore **validated structurally
only** - the license audit, placeholder resolution and catalog submit path are
e2e-proven (`ws3-cloud.spec.ts`), but no GPU evidence exists for them yet.
Honest status: **inconclusive - untested; needs your own ComfyUI GPU**.

| Workflow | Validation | Evidence |
|---|---|---|
| `wan22a14b-t2v.json` | substitute passes; license open; endpoint submits | inconclusive - no cloud GPU |
| `wan22a14b-i2v.json` | substitute passes; SD3-shift experts wired per card | inconclusive - no cloud GPU |
| `flf2v-14b.json` | substitute passes; license open | inconclusive - no cloud GPU |
| `qwenimg2512-t2i.json` | substitute passes; license open | inconclusive - no cloud GPU |
| `qwenedit2511-edit.json` / `qwenedit2511-angles.json` | substitute passes; `TextEncodeQwenImageEditPlus` path | inconclusive - no cloud GPU |
| `reshoot-uni3c.json` / `cam-i2v-uni3c.json` | substitute passes; `model_patches` target | inconclusive - no cloud GPU |
| `bernini-r2v.json` | substitute passes; license open | inconclusive - no cloud GPU |
| `hidream-t2i.json` | substitute passes; license open | inconclusive - no cloud GPU |

Re-run against a cloud GPU host with
`COMFY_BASE_URL=http://127.0.0.1:18189 pnpm exec tsx scripts/runpod/validate.ts --workflow <file>.json [--ref X=path] --params '{...}' --out <evidence.json>`.

<details><summary>Superseded s5 rows (832×480, pre-MF1 graph)</summary>

| Case | Result | Wall time | Notes |
|---|---|---|---|
| **A** (pre-FOV-wire poses): `--image frame.png --params '{"moves":"dolly-in+pan-left","camera_aperture":"f1.4","camera_lens":"wide-24","steps":6}'` | ✅ pass | 488 s | 1280×720 start → 832×480×17 h264 **55.5 KB** `generated/a1966a69-….mp4`, sha256 `5288c3fed3ba…`. Caught the `_box_blur` cumsum broadcast bug - fixed (asymmetric pad) and re-verified. |
| **B** (refs centre-cropped pre-MF1): `--image frame.png --ref a.png --ref2 b.png --params '{"moves":"truck-right","camera_aperture":"f2.8","color_palette":"cinema-amber","camera_body":"35mm-film","steps":6}'` | ✅ pass | 438 s | Ref chain live but the wide strip lost refs to VACE's crop - the s5fix grid+pad fixes it (B′ above). 832×480×17 h264 **281.5 KB** `generated/7ddcadeb-….mp4`, sha256 `dee232e5a0ff…`. |

</details>

## s11 cloud-GPU notes

- Wan-Fun camera DiT (`wan2.1_fun_camera_v1.1_1.3B_bf16.safetensors`,
  3.2 GB bf16) sits in `models/diffusion_models/` - same Comfy-Org byte as
  alibaba-pai's card; `clip_vision_h.safetensors` is always loaded -
  `cam-i2v-fun.json` wires CLIPVisionLoader→CLIPVisionEncode into
  WanCameraImageToVideo's `clip_vision_output` unconditionally.
- `OF_CameraEmbed` must exist in the deployed `custom_nodes/motionfield_nodes`
  before `cam-i2v-fun.json` can run (nodes pack registration happens at
  ComfyUI start).
- GPU serialisation here is `~/.motionfield/gpu-run` (one job, 1800 s cap);
  warm 49-frame Wan-Fun renders take ~8 min at 8 steps/480×272.

## s12 - Director rig fix (`OF_DirectorRig`), ws3 branch `t3/inspect-keyframe-rig-controls`

Real-output failure that motivated the work: a 480×272×33 f Director
render showed a **duplicated lighthouse mid-pan plus floating black
blobs** in the sky, and the prior arc/orbit stack realised only ~18% of
the commanded drift. Control-only passes (`cam_smoke.py --save-control`)
isolated the rig, not VACE, as the fault layer.

Root causes found and fixed:

1. **Refgrid self-duplication** - with zero `--ref` images the optional
   `LoadImage` placeholders dropped out and the stitch chain collapsed
   onto the start frame, so `WanVaceToVideo.reference_image` received a
   ~5-copy stack of the keyframe (a 2-col grid on the txt path). VACE
   painted a second subject from its own conditioning. Fixed by a linear
   right-chain `start → ref1 → ref2 → ref3`: 0 refs now yield the plain
   start frame; supplied refs still land side-by-side (supersedes the
   s11 **Z A/B** revert - that A/B compared at 480×272 where the crop
   absorbed the duplicate; the failure reproduced at 832×480).
2. **Porous splat holes** - `OF_CameraRig` capped splat radius at 4 px
   and kept every unprojected point, so depth-discontinuity specks
   (sky-side pixels one step past the tower edge, isolated near spikes)
   seeded scattered 1-3 px holes VACE could not fill (the black blobs).
   `OF_DirectorRig` adds a source-space depth-discontinuity filter
   (`cloud_keep_mask`), a Director-scale radius cap of 10 px, and
   iterative `pinhole_fill` that paints only small holes from filled
   4-neighbour rims - meaningful disocclusion bands are left as the
   `0.5`-grey fill contract VACE is designed for.

Control-pass measurements (49 f, dolly-in+pan-left, `--save-control` -
deterministic renders of the commanded poses, no DiT):

| Rig | Res | Peak holes | End holes | Hole character |
|---|---|---|---|---|
| `OF_CameraRig` (v1) | 480×272 | 36.2 % | 1.2 % | porous speckle scatter across sky + foreground |
| `OF_DirectorRig` (v2) | 832×480 | 30.7 % mid-move | 0.1 % | coherent disocclusion bands; far-edge specks gone |

Commanded-vs-realised on the v2 control frames (no DiT - pure rig
geometry): `pan-left` `bg_dx_px` **−56.4 px** (pass); `dolly-in`
full-frame scale fit reads 0.975 (corr 0.916) - the homothety metric
under-reads a horizon scene where the far sea/sky dominate the frame
while near content grows (1.6 m push at distance 4 ⇒ ~1.67× expected
near growth; the tower visibly enlarges on the strip). Reported as-is -
the metric is weak for this composition, not evidence the push failed.
Evidence: `/tmp/of-evidence/dir-rig/` (rgb/holes/control strips + mean
hole fractions).

Wan2.1-Fun camera path (`director-wan-fun*.json`): graphs ship and lint
clean against live `object_info`; `WanCameraImageToVideo`'s
`clip_vision_output` is optional and the local
`clip_vision_h.safetensors` is absent, so the Director fun graphs omit
the CLIPVision stage - the pose stream (`OF_Trajectory` →
`OF_CameraEmbed` Plücker) still carries the motion. No local Fun render
evidence yet (pod-proven truck/dolly/roll rows stand; identity hint
missing is documented in graph `_meta`).

| Case | Result | Wall time | Notes |
|---|---|---|---|
| v3 full render (VACE 832×480, 33 f, 5 steps, `dolly-in+pan-left`, f1.4, seed 42) | ⚠ landed - quality-fail | 902 s | `of_smoke-b9_00001.mp4` (2.06 s). Wins: no duplicate tower (island filter + `hole_dilate` 2→1), no blur-band mush (DoF table halved: f1.4 18 px→9 px), visible dolly+pan. Fail: transient dark sky-pill ~f13-16 + left-edge specks. Post-mortem on saved masks: the pill pixels were already marked **reactive** - VACE invented the object inside the flat-0.5 grey sea, so the fix is guidance, not masking. `motion_check` NCC on generated output: dolly scale 1.0/centre 0.6 - NCC can't lock re-synthesised texture (documented limitation; control-frame metric stands). Tower-top rises 59→0 px (exits frame) - dolly real. |
| v4 full render - diffused-prior control + colour-ghost drop (`16795e5`) | ✅ **pass** | 1076 s | `of_smoke-fb_00001.mp4` 832×480 33 f 2.06 s. qwen3.5:9b judge on 6-frame strip: `duplicates:false, blobs:false, motion:"dolly+pan"`. `motion_check` on the real output: dolly-in grid-patch scale **2.5×** @tower patch (416,240), corr 0.747 (centre 2.3×/0.708) **pass**; pan-left bg_dx **−4.69 px** **pass**. Remaining nits (honest): tower desaturates to pale wash mid-clip; f4 zoom transition shows a transient edge ghost; foreground stays defocus-soft (f1.4 grade) |
| `arc-left-45` fidelity (VACE 832×480, 33 f, 5 steps) | ✅ motion pass - visual degraded | 1054 s | `of_smoke-03_00001.mp4`. `motion_check arc-left-45`: centre lock 0.875 px mean (≤4 px bar), rel_bg −31.2 px vs rig 28.7 px → **109 % of commanded drift** (pass). Visual: rim-march fill imprinted vertical smear columns in the deep edge seas; tower washes pale → fixed by masked blur smoothing of the diffused prior (`fb29bd5`) - pan render below ran with it |
| `pan-left` fidelity (VACE 832×480, 33 f, 5 steps, smoothed prior) | ✅ **pass** | 1017 s | `of_smoke-43_00001.mp4`. `motion_check pan-left`: bg_dx **−24.1 px** pass. Visual strip `/tmp/of-evidence/dir-pan-strip.png`: single striped lighthouse, lamp lit, no pills/blobs/duplicates - cleanest output yet |
| **P-LUT** - post-merge `e31bbc9` palette re-grades on the v4 render (`of_smoke-fb_00001.mp4` bytes through `postSpecFor`→`ffmpegVideo`, same path `comfy.ts` runs on a `color_palette` job) | ✅ **pass** | ~10 s each (ffmpeg only, no GPU) | `sunset-burn` (warm): frame-16 mean R−B **+56.8**, strip `dir-fuel-sunset-strip.png` - golden-amber cast, warm stays warm. `cinema-amber` (the B′/R palette): R−B **+37.4**, `.cube` sha `830ebea6…` (replaces the buggy `5677ea4f…`), strip `dir-cinema-amber-strip.png`. `cool-cast` (cool): R−B **−38.1**, strip `dir-harbor-blue-strip.png` - slate cast, cool stays cool. Under the pre-fix blue-fastest rows each of these would have read on the opposite axis. Unit gold: `tests/unit/grade-lut-order.test.ts` (trunk's, kept) asserts every non-grey palette keeps primaries on their own channel |

## ws4-person-swap - person draft path (local MPS, Wan VACE 1.3B)

| run | clip | workload | result |
|---|---|---|---|
| draft `a765507b` | 5.56 s 480×832@16 (89 f), window 0, steps 4 | gen box 256×480 | **stalled** at 72 % - post-sample `RemoveBackground` (BiRefNet) on 89 f @480×832 under ~87 % mem pressure; killed at 1513 s |
| draft `8b7983be` | same | same | **stalled** at the same 72 % point - smoke timeout 1100 s (structural, not transient) |
| draft `1adc9df0` on light clip | 5.5 s 384×672@8 (44 f; window 0 = 40 f) | same 256×480 box, ~28 % of the stalled post-pass load | smoke timeout at 980 s (72 % at 555 s) - **prompt finished detached at ~21 min**, wrote `of_1adc9df0_00008.mp4` (256×480, 44 f): ref↔output judge **YES**, src↔output **NO** - see `docs/SMOKE.md` ws4-person-swap S2 |
| **draft `b79ad2ca` - completed job row** | 5.46 s 384×672@6 (33 f; window 0 = 16 f) | same box, steps 4, n37 erode live | **1305 s total** (window pass 1188 s: preflight ~115 s, sample ~450 s @112 s/step, post-pass ~600 s; recipe tail ~90 s) - output 384×672, 16 f, video+audio; judge ref↔output **YES**, halo **NO** |
| final `cd524811` (approve→final attempt) | same clip | 2 windows × ~1100 s + lip | **failed at 722 s** - window pass stalled under contention; a 2-window final ≈ 2400 s+ does **not** fit a 25-min slot at this frame rate - retry on a 1-window clip |
| approve→final (1-window sizing) | 2.5 s 384×672@6 (15 f source → ~40 f internal @16 fps) | 1 window ≈ draft window cost + lip | NOTE: internal frames = span×16 fps, so a "4 s 1-window" clip (64 f) would have cost **more** than the draft's 43 f window - the clip must be ≤2.7 s to stay inside the slot |
| **final `09780b5d` - completed job row** | 2.5 s 384×672@6 (15 f; 1 window, steps 5) | window pass + lip attempt | **1223 s total in-slot** (window 1021 s, tail ~200 s incl. failed lip pass) - output 384×672, 15 f, video+audio; `draft_of`→`b79ad2ca`; judge ref↔output YES, src↔output NO, **halo YES** + persistent eye-band artifact (generation-side at steps 5 - draft steps-4 clean, mattes/composite identical). Lip: `MuseTalkRun Expected 672 got 640` - root-caused to mask/video dim mismatch (`lipsyncMaskPlaceholders` emitted 512-wide masks vs native frames); fixed to native dims, unverified |

Reference points the workload is scaled against: the proven ws4-s5fix2
warm person window was 617.5 s for a 50 f @360×640 output; the post-pass
(decoded-frame BiRefNet + VideoCombine) is the tail the two stalls hit -
it scales with output frames × pixels, which the 480×832@16 input set ≈5×
above proven. The retry's 40 f @384×672 window lands ≈1.4× above proven.

## Stage blockout → VACE (M1 Pro, Wan VACE 1.3B fp16, 832×480 @16 fps)

| measure | result |
|---|---|
| walker bbox, projected frame height | **56 % → 88 %** over the 3 s dolly-in |
| subject centre | inside middle 60 % whole clip (x 49-51 %, y 66-75 %) |
| depth control normalisation | near 2.88 m / far 20.56 m (p2-p98, linear view depth) |
| control luminance, figure vs far bg | **73.1 vs 0.0** mean gray |
| VACE 1.3B, 49 f steps=12 | window submitted 13:44; final timing on completion |
