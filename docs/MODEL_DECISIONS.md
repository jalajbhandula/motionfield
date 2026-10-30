# Model decisions and completion checkpoint

Checked 2026-10-27 (India). No cloud resources or paid model downloads created.
This is the authoritative reconciliation of the requested stack. RUNPOD_PLAN.md
is only the existing base-stack rehearsal; its $25 reservation does not cover
all the upgrades below. A filename in a manifest is not an integration.

## Preserve the intended models

| Purpose | Target | Current app evidence / work remaining |
|---|---|---|
| Assistant, planning, tool calls, vision | `qwen3.8:27b-q4_K_M` | Exact Ollama tag restored in local environment. Official download is 18 GB. Not installed or benchmarked; installed Qwen3.5 9B remains a useful fallback. Mac has 32 GiB RAM and about 15 GiB free disk at this checkpoint; the 18 GB download cannot fit safely. Confirm runtime/context headroom and storage before downloading. |
| Expressive, multi-character speech / cloning | Fish Audio Drama 3 | Not installed, catalogued or integrated. Needs a separate CUDA serving environment and adapter, output persistence, cancellation/error handling, voice consent, licensing and UI/API/CLI/MCP coverage. Existing Kokoro/Chatterbox remain useful. |
| Fast image generation / editing | FLUX.2 Klein 4B | Existing working graphs and outputs; retain. Two Klein renders are not a proven photo identity swap. Only obsolete FLUX.1 Schnell was removed. |
| Image generation / editing / angle changes | Qwen Image 2512 and Image Edit 2511 | Graphs/catalog exist; selected Edit graph dependencies are in base manifest. Actual cloud renders and quality remain unverified. Separate model family from the Qwen assistant. |
| New video / audio-video workflows | LTX-2.5 | Not integrated. Use official INT8 ConvRot transformer + matching Gemma4-12B encoder + Conv video VAE and audio VAE; add upscaler only when the actual graph requires it. Gated access, new nodes/runtime and license mapping required. Old LTX0.9.5 remains for existing recipes until replacements pass. |
| High-capacity video and character animation | Wan2.2 A14B I2V/T2V and Animate14B | App graphs exist; CUDA installation and real outputs remain unverified. Keep existing proven Wan VACE recipes until replacements pass. |

No claim that a newer candidate is better for every app task is warranted
before measuring the same prompts, tool calls, latency and output quality.
Do not silently substitute Qwen9B or old LTX for the requested targets.

## Runtime and licensing constraints

Fish's current LICENSE is the Fish Audio Community License v1.0, despite the
repository metadata showing the older research-license tag. It permits research,
noncommercial use and conditional commercial use below $500,000 aggregate annual
revenue; hosted audio-service restrictions still apply. Inspect the complete
terms for the intended deployment. The prior blanket "noncommercial only" claim
was incorrect. A public self-service production audio service is not cleared
by a private prototype test.

The vLLM-Omni Drama3 recipe requires vLLM >=0.31 and a CUDA GPU with at least
48 GB; its reference run uses H10080GB. A100 compatibility has not been proved
here. Fish must unload before large video jobs; ComfyUI and Fish must not both
assume exclusive access to GPU memory. Use separate virtual environments and
one heavy job at a time.

LTX2.5 uses the LTX2.x Community License, not Apache2. Its repository requires
account access/acceptance and disclosure of Hugging Face account information.
The user must handle that access decision. Native NVFP4 targets Blackwell;
it is not the A100/H100 choice. The current pinned ComfyUI base has not been
validated for 2.5. Pin a compatible runtime in isolation and regression-test
existing workflows before replacing the base installation.

Apple MLX sound effects stay on the Mac. The app now supports separate main
and audio Comfy backends, with independent credentials and persisted routing.
Fish speech will require its own service adapter; this routing change alone
is not Fish support.

## What MCP, CLI and plugins actually cover

Core API/SDK/CLI/MCP implementations exist. Eight MCP tools explicitly remain
pending: `anim_clips`, `shorts`, `podcast_edit`, `video_analyze`, `ad_lab`,
`characters`, `virality_score`, `clipper`. `voices.list` and `skills.import` also
have unavailable branches. Do not advertise these as implemented.

Chrome and Blender integrations exist. Automated mock-backed checks prove
contracts and plugin flows, not model quality or every desktop interaction.
Blender's interactive GUI has not been verified in this completion pass.
Figma, Photoshop, Premiere, DaVinci and After Effects plugins are not present;
Telegram integration is planned, not built. No claim of complete plugin coverage.

## Budget reconciliation - provisional envelope, not permission to rent

Existing account credit: $60. No top-up is needed to prepare the code.
The base model files total exactly 180,474,934,069 bytes, before Fish, LTX2.5,
software, caches, temporary downloads, inputs and outputs. The 250 GB base volume
cannot be called a final full-stack allocation.

Planning envelope: at most four hours on one H100 PCIe80GB at the published
$2.89/hour, with a provisional 350 GB standard network volume at $0.07/GB/month:

| Item | Reservation |
|---|---:|
| Four GPU hours (setup included) | $11.56 |
| 350 GB network storage, full 30-day reservation | $24.50 |
| 20 GB container disk for four hours, approximately | $0.012 |
| Total rounded upward | $36.08 |
| Remaining from $60 | $23.92 |

This is an estimate, not a quote or a final assertion that 350 GB fits. Obtain
exact selected LTX2.5 file bytes/hashes, Fish dependency footprint and cache
layout before committing storage. Avoid duplicate Hugging Face caches. If the
full set exceeds this envelope, stage model downloads and back up outputs;
do not remove capabilities or silently increase the spending cap. Actual region,
stock, price and account auto-recharge state still need read-only confirmation.
A10080GB at $1.79/hour remains an economical option only if Fish's chosen
runtime is proved compatible; no automatic switch to more expensive hardware.

Stop after ten idle minutes or four hours total; verify actual stopped state.
Storage continues charging while the GPU is stopped ($0.817/day for 350 GB).
The watchdog is a safeguard, not a billing guarantee. Retaining storage beyond
the reservation requires another cost decision.

## Full capability acceptance scope

[CAPABILITY_PROOF.md](CAPABILITY_PROOF.md) preserves all named capabilities,
UI/UX requirements, real-output criteria and incomplete integrations. The user
clarified that proving all workflows remains the goal within the $60 budget.
A small initial demo batch is not a reduction of that acceptance scope.

## Economical demo priority (latest user steering)

Finish cheap app fixes and integration checks first; model upgrades must not
block preparing a real demo. Use the existing tested Klein image and Wan VACE
Director/re-shoot paths, plus local Kokoro speech. Showcase a short generation,
one controlled camera move, the app's output and one CLI/MCP job. Do not base
the demo on unproved photo identity transfer or the person-swap quality issues.

`bash scripts/runpod/setup-studio.sh --demo --dry-run` selects seven manifest
files totalling **24,804,289,806 bytes**, plus only six existing files in
`scripts/runpod/demo-files.txt` (**9,163,030,569 bytes**):
**33,967,320,375 bytes total** before software/caches/output. A 100 GB working
disk leaves about 66.03 GB for those. Confirm the installed footprint before
generation. The first profile skips remote Kokoro/MuseTalk software and the
unused LTX/T5/Wan-T2V files; those remain locally intact and in the wider
studio profile for subsequent capability batches. Audio stays on the Mac.
This saves **18,851,567,585 bytes** of transfer relative to the earlier demo
copy list. New Wan2.2, Qwen Image and LTX/Fish remain intended upgrades in the
complete-feature backlog; the first batch alone is not full acceptance.

Stage 1 recommendation: one L40S48GB at at most the published $1.09/hour for
a two-hour maximum session, including setup; 100 GB standard network volume,
10 GB container disk, and storage retained for at most one day for retry.
Confirm host/region support and exact checkout price before provisioning.
The existing-workflow CUDA runtime still requires preflight; Mac success is
not proof of CUDA success. Keep app, audio and Qwen9B fallback on the Mac.

Cost estimate (30-day / 720-hour approximation):

| Item | Expected charge |
|---|---:|
| Two GPU hours | $2.18 |
| 100 GB network volume, two hours only | $0.0194 |
| 100 GB network volume retained a full day instead | $0.2333 |
| 10 GB container disk, two hours | $0.0028 |
| Total if volume removed after two hours | about $2.21 |
| Total if volume retained a full day | about $2.42 |

The $7/month network storage figure is a rate, not an upfront $7 fee.
Three days costs about $0.70; 30 days costs $7. Billing continues hourly while
the volume exists. Back up outputs locally, then remove the cloud storage at
the end of the agreed retention period. Stopping a pod alone is insufficient.
Temporary container data is erased on stop, so keep valuable files on the
network volume and copy them locally promptly.

Reserve **$5**, keeping at least $55 untouched for now. This is not a guarantee
that the full demo will finish within two hours. Start with
MAX_RUNTIME_SECS=7200, EMPTY_LIMIT_SECS=600 and
UNREACHABLE_LIMIT_SECS=600; if setup consumes the window,
stop and assess before extending. A four-hour session plus one day of network
storage would be about $4.60, but no extension is automatic or authorized.
Slow transfer/install, stock, checkout price and additional host charges may
change the estimate. No resource creation or deletion is authorized by this
document. Do not bulk-download models during this session.

Stage 2: assess actual demo shortcomings, then integrate and benchmark one
upgrade at a time. Qwen27B is for assistant quality, Fish for expressive/multiple
speakers, LTX2.5 for audiovisual generation, Wan2.2 for video quality, Qwen Image
for editing. No bulk installation and no H100/350 GB rental merely because a
new version exists. Keep at least $55 of the $60 balance outside the initial
$5 reservation. The larger budget above is a capacity estimate, superseded as
the first-session recommendation.

## Required sequence before full completion

1. Finish the Fish service adapter and LTX2.5 catalog/API graphs, matching
   dependencies and license gates; preserve the fallback workflows.
2. Finish the eight pending MCP capabilities and unavailable branches against
   real app functionality, with matching CLI/SDK behaviour. Resolve missing plugin scope
   explicitly; no empty stubs presented as integrations.
3. Verify local Qwen27B headroom and tools/vision against representative tasks.
4. Generate a final exact file manifest and compatible runtime pins, then
   present the concrete cloud resource/cost proposal for explicit approval.
5. Only after approval: provision once, run bounded real-output checks through
   authenticated app, CLI and MCP; inspect identity, lip sync, seams, camera
   motion, image edits, LTX audio-video and Fish multi-speaker speech.
6. Save genuine output evidence, stop GPU, verify charges and storage retention.

Photo identity transfer, person-swap halo/eye-band/lip restoration, Director
orbit after smoothing, scene render and finishing still need real quality checks.
An empty Quick gallery remains empty until verified media is available.

## Sources

- Qwen exact tag: https://ollama.com/library/qwen3.8:27b-q4_K_M
- Fish model: https://huggingface.co/fishaudio/drama-3
- Fish license: https://huggingface.co/fishaudio/drama-3/blob/main/LICENSE
- Fish runtime: https://recipes.vllm.ai/fishaudio/drama-3
- LTX model/access: https://huggingface.co/Lightricks/LTX-2.5
- LTX Comfy files/templates: https://docs.ltx.io/open-source-model/integration-tools/comfy-ui
- RunPod prices: https://www.runpod.io/pricing
- Storage billing: https://docs.runpod.io/pods/pricing

## Follow-up validation

The MCP (stdio and HTTP), CLI, SDK, Chrome and Blender integration selection
now has 50 passing checks across two runs: 42 passed in the broad run; the
eight studio checks passed after isolating the test server from local .env
LLM configuration. Two old fixture assumptions were corrected (dub is live;
motion tests must not inherit a live Qwen route). These are mock-backed
contract checks. An additional 43 targeted LLM/audio-backend unit tests passed.

Full-scope local follow-up and exact remaining browser coverage are recorded
in CAPABILITY_PROOF.md. The broader run was not fully green; all seven initial
failures passed targeted follow-up after meaningful code/test corrections,
with 29 serial-suite checks still unrun. Real model proof remains pending.
