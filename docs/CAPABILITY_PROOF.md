# Full capability proof matrix

Updated 2026-10-27 (India). This checklist preserves the full requested scope.
A small paid batch is a scheduling/budget choice, not a reduced acceptance bar.
Rows describe requested behaviour in plain terms; no claim of measured
equivalence to proprietary executors is made. Existing public UI uses
plain MotionField names. Mark a row complete only when its required evidence is
saved; a working page or a mock job is insufficient.

Status meanings: **historical** = recorded earlier real output, not a current
end-to-end pass; **mock** = plumbing only; **pending** = no satisfactory proof;
**quality fail** = output exists but fails the stated requirement.

| Requested reference behaviour | MotionField equivalent | Missing / limitation | Local checks / existing test source | Real-output evidence now | Quality verdict | Next action and acceptance criterion |
|---|---|---|---|---|---|---|
| Person replacement | Person Swap / Quick | Halo, eye band and lip restoration unresolved; gallery empty | ws4-person-swap, ws4-person-swap-quick, ws4-swap; consent/ownership/cancel | Historical job `09780b5d`, 1223 s, 2.5 s video | Quality fail | Authenticated upload → job → preview/download; preserve source identity replacement, face, background, temporal continuity and intelligible lip motion; inspect every frame |
| Object replacement | Object Swap | Real quality not proved in this pass | ws4-swap mask/consent/ownership gates | Pending | Not assessed | Real masked replacement, object follows motion, outside-mask content stable |
| Photo identity swap | Face edit / Klein | Current two-render method does not prove identity transfer | ws4-swap verification/consent gate | Prior failure; hidden behind gate | Quality fail | Implement a valid identity-transfer executor; compare identity and untouched background; do not advertise until passed |
| 3D scene manipulation to video | 3D Scene | Scene rendering end-to-end not proved; advanced mesh pipelines optional | ws5-stage-editor, ws5-stage-render, stage-lane, MCP stage | Historical work reached sampling; no accepted final proof here | Inconclusive | Save/edit scene, camera/keyframes → authenticated render → playable final video matching scene/camera; exercise MCP stage too |
| Image studio | Image / Klein / Qwen Image | New Qwen cloud outputs unverified | ws4-klein, ws4-catalog | Historical Klein real images | Historical pass only | New authenticated T2I + edit with job IDs, seed/settings/history and downloaded image; compare prompt adherence/details |
| Canvas graph composition | Canvas | Real chained output not yet captured | Four new/updated browser checks passed: latest prompt/edges, media, auth, poll retry | Mock graph evidence only | Plumbing pass | Image → video → speech/media chain through actual executor; verify current values and upstream output propagation |
| Reference-driven editing | Re-edit Video / ReEdit | Per-shot reference fidelity and pacing need real proof | ws4-re-edit, extras-beat-cut | Pending accepted final proof | Not assessed | Owned clip + reference + edit instruction → actual output; cuts/content/reference match, audio remains synchronized |
| Plan to output | AI Assistant / runs | Qwen27B not installed; some tools pending | ws2-assistant, agent-tools, modes, runs/tree | Historical partial chains; not full current accepted run | Inconclusive | One real prompt → inspectable plan → approved run → artifacts/history; truthful error propagation and resumability |
| AI influencer identity consistency | Character Studio / Creator / refs | Stable appearance across multiple outputs unproved; characters MCP wrapper pending | ws4-character, extras-character-builder | Pending current same-identity set | Not assessed | Three materially different scenes/outfits with consistent face/body; save/reopen refs, consent, repeat via API/MCP |
| UGC ads / ad influencer | Product Ads + silent UGC skill + character/video/audio composition | Silent `ugc-ad` and `product-review-clip` skills exist; Product Ads is image placement, not a complete talking influencer campaign; ad_lab MCP pending | Product Ads UI/API; no completed full UGC check | Pending | Missing functionality | Product + character + brief → branded speech/video ad with product fidelity, consent, usable audio and export |
| Marketing / campaign kit | Campaigns / skills / assets | Entire reusable campaign flow and brand fidelity unproved | skills/run/asset APIs; platform-launch | Pending current full campaign | Not assessed | Generate coordinated image/video/copy assets; reopen campaign and export usable owned files |
| Camera controls / Director | Camera Control | Orbit smoothing needs real rerun; edge/detail nits remain | ws3-director/camera/trajectory | Historical pan-left `of_smoke-43_00001.mp4`, motion −24.1 px; earlier dolly/pan passes in SMOKE | Historical pass for pan; orbit pending | Authenticated pan and orbit with new job IDs, measure commanded motion/subject lock, inspect ghosting |
| New camera move | New Camera Move / re-shoot | Uni3C alternative unverified; route hidden in nav | ws3-reshoot | Historical pan test 1301 s, measured −28.5 px | Historical pass only | New authenticated user clip → camera path → final; inspect geometry/disocclusion/content preservation |
| Image/video effects | Effects / Visual Effects / Restyle | Some graph/preset quality unverified; fixtures are fabricated in browser tests | ws3-vfx-lab, ws4-swap; real preset verification gates | Some historical VFX outputs; no blanket pass | Partial | One real output per advertised executor/preset; keep unverified choices gated; inspect temporal artifacts |
| Relight / color / layers | Relight, Color Grade, Image Editor | Feature set present; mask/control fidelity not measured | extras-relight, extras-palette, render/editor tests | Pending current visual proof | Not assessed | Edit saved asset → visible controlled change → exported result; compare unchanged regions |
| Speech / music / sound effects | Audio / Kokoro, Chatterbox, ACE, MOSS | Fish Drama3 unintegrated; MLX sound effects require Mac | Audio backend unit tests; ws5-sound | Real Kokoro `01b75576-b701-4446-b208-792e4af6f1d6.flac`, 2.218667 s | Routing pass; others pending | Authenticated TTS, cloning with consent, music and SFX; intelligibility, duration, reference fidelity, playable output |
| Dub / translate / lip sync | Dub & Translate / MuseTalk | Real translation + restored lip sync unproved; prior size mismatch correction awaits rerun | extras-dub; MCP consent/language tests passed | Prior MuseTalk dimension failure | Quality/runtime unresolved | Spoken source → selected-language voice + synced lips, preserve face/audio timing; inspect all frames |
| Motion graphics | Motion Graphics / render | Full current visual output not accepted here | ws5-motion/render/export; MCP motion check passed with mock job | Local render history in repository; not current full proof | Pending current proof | Template and LLM-directed scene → rendered video with correct duration/text/audio/export |
| Game builder | Game Builder | Behaviour, controls and exported playable result not verified in this pass | extras-games | Pending | Not assessed | Create/open playable game, controls work, save/reopen/export; no static screenshot accepted as gameplay |
| Finishing / upscale / interpolation | Job finishing | Order/quality and lip preservation need GPU measurements | ux-finish; provider and custom-node tests | GPU ordering/quality checks pending | Inconclusive | Compare raw/finished output, correct step order, frame count/audio sync, no seam regression |
| MCP | Core/studio/3D toolsets | Eight wrappers pending; voices.list / skills.import unavailable | MCP stdio/HTTP/studio suites passed in 50-check integration selection | Real model calls through MCP still pending | Contract pass only | Real owned upload → generate/run → wait/download for applicable capabilities; structured errors/consent/gates |
| CLI / SDK | motionfield CLI / TS SDK | Real executor equivalence not proved by mocks | CLI/SDK checks passed in same selection | Pending current real job | Contract pass only | Execute actual selected jobs and compare params/output/history with UI; cancellation/download/errors |
| Plugins | Chrome / Blender | Interactive Blender GUI unverified; Figma/Adobe/DaVinci/AE/Telegram integrations absent | Chrome/Blender automated selection passed | No current live plugin-to-GPU output | Partial implementation | Chrome source upload → real owned output; Blender scene/image exchange and real output; missing integrations stay explicit backlog |
| Common UI/UX | Auth, upload, job progress, assets/history/Recreate, projects, errors | Full UI quality/accessibility and all happy/error paths need audit | platform-launch/API/keys + Canvas passed; other suites mapped above | Current real app flow pending | Partial | Desktop/mobile + keyboard: auth/ownership, uploads, progress/cancel/retry, saved params/Recreate, preview/download and history all truthful |

## Evidence record for every real run

Append one row per actual executed workflow (the family table above is not a
substitute for every graph/executor): workflow file + hash, endpoint, source
interface (UI/API/MCP/CLI/plugin), authenticated owner, input refs, exact params,
model/runtime hashes, job/run IDs, output paths, elapsed GPU time/cost, objective
checks, visual/audio verdict, failure and next action. Keep only nonsecret
metadata. Reuse accepted outputs for the demo; do not pay to recreate them.
A raw Comfy prompt proves the graph, not the complete app flow.

## Budgeted execution order - full target, staged spending

1. Local: finish browser/API/permission/upload/history/Recreate/Canvas and
   integration checks, fix meaningful failures; render CPU-capable operations
   locally. Baseline already includes 1178 passing unit tests, four TS checks,
   build and 50 MCP/CLI/SDK/Chrome/Blender mock integration checks. The broader cross-capability selection initially had 24 passing checks,
   seven failures and 29 not run due to serial-suite failure. All seven failed
   checks subsequently passed targeted reruns. The 29 unrun checks are still
   pending; this is not a green 60-check full run.
2. First paid batch: existing image, Director/re-shoot and relevant swap/edit
   dependencies. The small --demo profile is a first batch, not full coverage.
   Proposed $5 reserve, two-hour watchdog, approximately $2.42 for two hours
   GPU plus a day of 100 GB storage; no provisioning approved.
3. Reconcile each remaining matrix row to its executor and minimal dependency
   set. Sequential small batches: stop on runtime/quality failure, diagnose
   locally, then retry. Do not install every new model before testing existing
   executors. Qwen27B/Fish/LTX2.5/Wan2.2 remain explicit intended upgrades.
4. Before every further paid batch: actual spend + ongoing storage + worst-case
   next session must remain within the original $60. Auto-recharge stays off.
   Full high-quality proof of all capabilities within $60 is a target, not a
   guarantee; missing implementations cannot be solved by renting more GPU.
5. Full completion requires every applicable row's real proof and UI behaviour;
   disclose unsupported proprietary features and missing plugins explicitly.
   Unknown external product quality is not evidence that equivalent capability
   is achieved.

## Fixes and targeted follow-up in this checkpoint

- Dubbing subtitle download now resolves the original dub sidecar even when
  the preview uses the finished video. Browser regression fetches actual SRT,
  checks its text/timestamps and verifies video audio and source duration.
- Mock finishing now passes through the source media rather than replacing it
  with a fixed three-second test pattern. This is test-provider behaviour, not
  evidence of real GPU upscaling/interpolation.
- Object clip upload has an accessible name. Tests check visible upload
  surfaces and named hidden file inputs separately.
- Character Studio and scene fallback tests use current labels/routes.
- Re-edit regeneration waits for the parent's finishing phase to complete;
  the free-plan concurrency safeguard remains enforced.
- Canvas rewiring is asserted by actual graph endpoints; pointer drag grabs
  the exposed updater circle rather than the overlapping node handle.
- Final focused dubbing/finishing run: three tests passed. Canvas pointer
  regression passed separately. Four TypeScript projects passed after code
  changes. No entire-suite or real-GPU quality pass is claimed.

## Continuation pass (GPT-6.1-sol audit finished here)

- `/jobs/[id]` previously polled forever on a non-OK response - a 401 left the
  page on "Loading…" indefinitely. It now parses the response, stops polling,
  renders `ErrNote`, and offers Retry; StrictMode double-fetch is deduped.
- Planner prompt: a video brief let eight video-adjacent tools tie on the
  "video" token and alphabetically crowd out every canonical text-to-video /
  text-to-image endpoint for fresh users. `plannerTools` now keeps ranked hits
  first, then appends one representative per missing canonical generation
  kind; restricted (opt-in) endpoints still only appear for opted-in users.
- Stale assertions updated to current product names/behaviour: `Agent mode`
  → `Autonomy`, `GENERATE` → `Generate`, `/person-swap` → `/person-swap` route,
  "characters" → "characters" copy, `p[role=alert]` → `role="alert"` (ErrNote),
  runtime note `min per second` → `min local`, `♪` glyph → accessible names,
  and mock finishing now preserving source dimensions (360×640/640×360).
- Verified after fixes: 1179 unit tests pass (8 skipped), four TypeScript
  projects clean, `next build` clean, focused e2e rerun of the previously
  failing specs passed (person-swap UI + serial draft/approve/refs chain,
  planner resolution prompt, Autonomy menu, director Enhance/♪→labels,
  history 401 retry, person-swap dims, catalog camera disambiguation).
- Still pending: a small number of e2e specs never reached in this pass
  (e.g. `ws1-demo`, some orchestration/tree serials) and - unchanged - every
  real-GPU quality verdict in the matrix above. Mock-provider passes prove
  plumbing and product behaviour only.

## Internal naming sweep (continuation)

- Retired codenames renamed to public names everywhere: `doppel` →
  `person-swap` (endpoint `motionfield/person-swap/v1.0`, `/api/person-swap`,
  recipes, workflow files, MCP `person_swap`), `persona` → `character`
  (endpoint `motionfield/character/generate`, model, components, MCP
  `characters`), `orchestrator` → `assistant`, `recut` → `re-edit` (endpoint,
  `/api/re-edit`, `recut_chains` → `re_edit_chains` via migration 0601, MCP
  `re_edit`, recipe). Intentional keeps: `persona`/`location` legacy ref
  aliases, user-language regex matchers, `palette`/`dub` (real domain
  vocabulary, not stale names). License artifacts + name baseline
  regenerated; 1179 unit tests pass post-rename.
