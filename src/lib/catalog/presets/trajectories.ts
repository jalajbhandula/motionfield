/** Trajectory library - the 83-entry camera-move table.
 *
 *  Every id has a deterministic pose recipe in `src/lib/camera/trajectory.ts`
 *  (MOVES) mirrored by the Comfy node pack; the rows below are the catalog
 *  surface: display label, group, mechanism summary, which inputs the move
 *  applies to, and honest notes where the model has to invent content.
 *
 *  Wording is original to MotionField - ids are generic cinematography names.
 */
import type { PresetDef } from "../types";
import { isRigMove } from "@/lib/camera/trajectory";
import { posterFor } from "./poster";

export const TRAJECTORY_GROUPS = ["basic", "cinematic", "energetic", "lens", "time", "transition"] as const;
export type TrajectoryGroup = (typeof TRAJECTORY_GROUPS)[number];
export const TRAJECTORY_GROUP_LABELS: Record<TrajectoryGroup, string> = {
  basic: "Basic",
  cinematic: "Cinematic",
  energetic: "Energetic",
  lens: "Lens",
  time: "Time",
  transition: "Transition",
};

export interface TrajectoryDef {
  id: string;
  group: TrajectoryGroup;
  /** short picker label */
  label: string;
  /** how the move is computed */
  mechanism: string;
  /** which source inputs the move supports */
  inputs: readonly ("image" | "video")[];
  /** shown when the model must invent part of the shot */
  honest_note?: string;
  /** in the library but not offered in pickers */
  hidden?: boolean;
}

const t = (
  id: string,
  group: TrajectoryGroup,
  label: string,
  mechanism: string,
  extra: Partial<Pick<TrajectoryDef, "inputs" | "honest_note" | "hidden">> = {},
): TrajectoryDef => ({ id, group, label, mechanism, inputs: ["image", "video"], ...extra });

const GENERATED_TIME = "time passing is generated - the model invents the motion between beats";
const GENERATED_BACK = "the unseen side is generated - the model invents what's behind the subject";
const GENERATED_VIEW = "part of the new view is generated - the model invents what the source never showed";
const GENERATED_WIDE = "the widened frame is generated - the source never photographed it";

export const TRAJECTORIES: readonly TrajectoryDef[] = [
  /* ------------------------------------------------------------ basic */
  t("locked-off", "basic", "Locked Off", "static camera - no position or angle deltas"),
  t("dolly-in", "basic", "Dolly In", "smooth push toward the subject, ease in/out"),
  t("dolly-out", "basic", "Dolly Out", "smooth pull away from the subject, ease in/out"),
  t("slow-creep-in", "basic", "Slow Creep In", "constant slow push at fixed velocity"),
  t("pull-back-reveal", "cinematic", "Pull-Back Reveal", "pull back and rise a touch, easing into a wider frame"),
  t("truck-left", "basic", "Truck Left", "lateral slide left - foreground/background parallax"),
  t("truck-right", "basic", "Truck Right", "lateral slide right - foreground/background parallax"),
  t("pedestal-up", "basic", "Pedestal Up", "vertical rise, camera keeps level"),
  t("pedestal-down", "basic", "Pedestal Down", "vertical drop, camera keeps level"),
  t("pan-left", "basic", "Pan Left", "yaw sweep left on a fixed head"),
  t("pan-right", "basic", "Pan Right", "yaw sweep right on a fixed head"),
  t("tilt-up", "basic", "Tilt Up", "pitch sweep up on a fixed head"),
  t("tilt-down", "basic", "Tilt Down", "pitch sweep down on a fixed head"),
  t("dutch-roll-cw", "basic", "Dutch Roll CW", "clockwise roll of the frame"),
  t("dutch-roll-ccw", "basic", "Dutch Roll CCW", "counter-clockwise roll of the frame"),
  t("follow-behind", "basic", "Follow Behind", "steady trailing pace behind the subject"),
  t("lead-backward", "basic", "Lead Backward", "walk backward ahead of the subject at a steady pace"),
  t("side-track-left", "basic", "Side Track Left", "lateral tracking left alongside the subject"),
  t("side-track-right", "basic", "Side Track Right", "lateral tracking right alongside the subject"),
  t("auto-move", "basic", "Auto Move", "pick the move from the subject class - deterministic table, not a guess"),

  /* --------------------------------------------------------- cinematic */
  t("arc-left-45", "cinematic", "Arc Left 45°", "45° orbit left around the subject, subject locked", { honest_note: GENERATED_VIEW }),
  t("arc-right-45", "cinematic", "Arc Right 45°", "45° orbit right around the subject, subject locked", { honest_note: GENERATED_VIEW }),
  t("orbit-360", "cinematic", "Orbit 360°", "full circle around the subject, subject locked", { honest_note: GENERATED_BACK }),
  t("turntable-180", "cinematic", "Turntable 180°", "half-circle orbit - the subject reads as rotating", { honest_note: GENERATED_BACK }),
  t("crane-up", "cinematic", "Crane Up", "rise while drifting in, camera re-aims at the subject", { honest_note: GENERATED_VIEW }),
  t("crane-down", "cinematic", "Crane Down", "descend from height onto the subject, camera re-aims", { honest_note: GENERATED_VIEW }),
  t("jib-over-foreground", "cinematic", "Jib Over Foreground", "swoop up over a foreground layer, settle on the subject", { honest_note: GENERATED_VIEW }),
  t("overhead-rise", "cinematic", "Overhead Rise", "climb straight up, camera tipping down toward the subject", { honest_note: GENERATED_VIEW }),
  t("overhead-drop", "cinematic", "Overhead Drop", "fall from overhead onto the subject, camera tipping level", { honest_note: GENERATED_VIEW }),
  t("handheld-subtle", "cinematic", "Handheld Subtle", "seeded low-amplitude position and angle noise"),
  t("low-angle-push", "cinematic", "Low Angle Push", "start low looking up, push in while the camera levels"),
  t("high-angle-pull", "cinematic", "High Angle Pull", "start high looking down, pull back while the camera levels", { honest_note: GENERATED_VIEW }),
  t("parallax-slide", "cinematic", "Parallax Slide", "lateral track while re-aiming - background sweeps past the subject", { honest_note: GENERATED_VIEW }),
  t("eye-push", "cinematic", "Eye Push", "push toward the eyes, camera re-aims each frame - eyes hold centre"),
  t("mouth-push", "cinematic", "Mouth Push", "push toward the mouth, camera re-aims each frame"),
  t("head-lock-follow", "cinematic", "Head Lock Follow", "subject-locked mount aimed at the head - head stays pinned"),
  t("motion-control-sweep", "cinematic", "Motion Control Sweep", "precise repeatable orbit sweep, subject locked"),
  t("body-mount", "cinematic", "Body Mount", "camera rigid on the subject - subject frozen, world flows"),
  t("car-mount", "cinematic", "Car Mount", "low rigid mount with rumble - subject frozen, world flows"),
  t("making-of-pullback", "cinematic", "Making-Of Pullback", "pull back, rise and drift - reveals the set around the shot", { honest_note: GENERATED_VIEW }),
  t("two-stage-push", "cinematic", "Two-Stage Push", "slow creep then a harder push in the second half", { hidden: true }),
  t("overhead-crane-pass", "cinematic", "Overhead Crane Pass", "rise and travel over the subject, pitching down through the pass", { honest_note: GENERATED_VIEW }),
  t("beauty-arc", "cinematic", "Beauty Arc", "short orbit with a slight rise and a gentle zoom", { honest_note: GENERATED_VIEW }),
  t("tilt-rise", "cinematic", "Tilt Rise", "rise while tilting up - finds the subject overhead", { honest_note: GENERATED_VIEW }),
  t("jib-up", "cinematic", "Jib Up", "up and across with a swing, camera re-aims at the subject", { honest_note: GENERATED_VIEW }),
  t("jib-down", "cinematic", "Jib Down", "down and across from height, camera re-aims at the subject", { honest_note: GENERATED_VIEW }),
  t("turntable-360", "cinematic", "Turntable 360°", "full product-table rotation", { honest_note: GENERATED_BACK }),
  t("object-pov", "cinematic", "Prop's-Eye View", "camera lands on the subject and looks outward"),
  t("spiral-up", "cinematic", "Spiral Up", "150° orbit climbing around the subject, subject locked", { honest_note: GENERATED_VIEW }),

  /* --------------------------------------------------------- energetic */
  t("crash-zoom-in", "energetic", "Crash Zoom In", "hard accelerating zoom that lands at the end"),
  t("crash-zoom-out", "energetic", "Crash Zoom Out", "hard accelerating zoom out at the end", { honest_note: GENERATED_WIDE }),
  t("handheld-run", "energetic", "Handheld Run", "seeded high-amplitude noise - running camera"),
  t("fpv-dive", "energetic", "FPV Dive", "accelerating forward dive, pitching down", { honest_note: GENERATED_VIEW }),
  t("fpv-rise", "energetic", "FPV Rise", "accelerating forward climb, pitching up", { honest_note: GENERATED_VIEW }),
  t("drone-flyover", "energetic", "Drone Flyover", "forward pass over the subject, tipping down on the way"),
  t("corkscrew-down", "energetic", "Corkscrew Down", "descending orbit with a rolling wobble", { honest_note: GENERATED_VIEW }),
  t("snap-tilt-down", "energetic", "Snap Tilt Down", "fast pitch snap that settles immediately"),
  t("impact-shake", "energetic", "Impact Shake", "one decaying shake burst, seeded"),
  t("mouth-snap-zoom", "energetic", "Mouth Snap Zoom", "push plus a snap zoom aimed at the mouth"),
  t("chase-follow", "energetic", "Chase Follow", "fast follow with a lateral weave"),
  t("ground-rush", "energetic", "Ground Rush", "low fast skim across the ground"),
  t("cabin-jolt", "energetic", "Cabin Jolt", "repeated seeded jolt bursts", { hidden: true }),
  t("dolly-in-max", "energetic", "Dolly In Max", "push hard to the closest framing"),
  t("dolly-out-max", "energetic", "Dolly Out Max", "pull hard back to the widest framing"),
  t("jitter-shake", "energetic", "Jitter Shake", "high-frequency seeded angle jitter"),

  /* -------------------------------------------------------------- lens */
  t("zoom-in", "lens", "Zoom In", "focal-length sweep in - framing tightens, no parallax"),
  t("zoom-out", "lens", "Zoom Out", "focal-length sweep out - framing widens, no parallax", { honest_note: GENERATED_WIDE }),
  t("dolly-zoom-in", "lens", "Dolly Zoom In", "push in while the lens zooms out - subject holds, background stretches", { honest_note: GENERATED_WIDE }),
  t("dolly-zoom-out", "lens", "Dolly Zoom Out", "pull out while the lens zooms in - subject holds, background squeezes"),
  t("rack-focus-near-to-far", "lens", "Rack Focus Near→Far", "camera holds; the focus plane sweeps near to far"),
  t("fisheye-lens", "lens", "Fisheye", "gentle drift under a strong barrel-distortion lens"),
  t("shutter-drag", "lens", "Shutter Drag", "slow pan under a long-exposure shutter - motion smears"),
  t("zoom-pulse", "lens", "Zoom Pulse", "fov breathes in and out three times"),

  /* -------------------------------------------------------------- time */
  t("frozen-moment-arc", "time", "Frozen Moment Arc", "60° arc while the subject hangs frozen", { inputs: ["image"], honest_note: GENERATED_BACK }),
  t("hyperlapse", "time", "Hyperlapse", "fast travel with a light weave, time-sampled", { honest_note: GENERATED_TIME }),
  t("timelapse-studio", "time", "Timelapse Studio", "locked camera, time-sampled", { honest_note: GENERATED_TIME }),
  t("timelapse-crowd", "time", "Timelapse Crowd", "gentle drift, time-sampled", { honest_note: GENERATED_TIME }),
  t("timelapse-landscape", "time", "Landscape Time-lapse", "very slow pan, time-sampled", { honest_note: GENERATED_TIME }),

  /* -------------------------------------------------------- transition */
  t("whip-pan-left", "transition", "Whip Pan Left", "violent yaw left with soft ends - lands on the next shot"),
  t("whip-pan-right", "transition", "Whip Pan Right", "violent yaw right with soft ends - lands on the next shot"),
  t("fly-through-transition", "transition", "Fly Through", "drive straight through the subject plane into the next shot"),
  t("pass-through-in", "transition", "Pass Through In", "accelerate through the subject plane"),
  t("pass-through-out", "transition", "Pass Through Out", "emerge back out through the subject plane"),
] as const;

export const TRAJECTORY_IDS: readonly string[] = TRAJECTORIES.map((r) => r.id);
export const TRAJECTORY: ReadonlyMap<string, TrajectoryDef> = new Map(TRAJECTORIES.map((r) => [r.id, r]));

/** Every catalog id must have a matching pose recipe - asserted in tests. */
export function trajectoryOf(id: string): TrajectoryDef | undefined {
  return TRAJECTORY.get(id);
}

/** Visible, pose-only moves - the set the CameraRig image-to-video endpoint
 *  actually executes. Rig-mode rows (subject-locked, facial-anchor targets,
 *  post tags, plane crossings) are excluded: they belong to the rig
 *  extensions, not the pose path. The Python mirror's list must agree -
 *  run.py pins it. */
export const CORE_TRAJECTORY_IDS: readonly string[] =
  TRAJECTORIES.filter((r) => !r.hidden && !isRigMove(r.id)).map((r) => r.id);
const CORE_SET: ReadonlySet<string> = new Set(CORE_TRAJECTORY_IDS);

/** Visible rig-mode rows - still pickable where a trajectory is prompt text,
 *  but the picker flags them so the UI never sells them as executed moves. */
export const RIG_TRAJECTORY_IDS: readonly string[] =
  TRAJECTORIES.filter((r) => !r.hidden && isRigMove(r.id)).map((r) => r.id);
export const isCoreTrajectory = (id: string): boolean => CORE_SET.has(id);

const GENERATED_TIME_IDS: ReadonlySet<string> = new Set([
  "hyperlapse", "timelapse-studio", "timelapse-crowd", "timelapse-landscape",
]);

/** The honest note for a (move, source) pair - "time passing is generated"
 *  applies to stills only; video inputs already carry their motion. */
export function honestNote(id: string, input: "image" | "video"): string | undefined {
  const r = TRAJECTORY.get(id);
  if (!r?.honest_note) return undefined;
  if (input !== "image" && GENERATED_TIME_IDS.has(id)) return undefined;
  return r.honest_note;
}

/* ------------------------------------------------------------------ */
/* preset picker surface - motion presets carry a trajectory stack      */
/* ------------------------------------------------------------------ */

const m = (id: string, title: string, description: string, camera_movement: string, fragment: string, trajectory: readonly string[]): PresetDef => ({
  id,
  title,
  description,
  kind: "motion",
  category: "camera",
  apply: { camera_movement, trajectory: [...trajectory] },
  promptFragment: fragment,
  inputRequired: "any",
  posterHue: Math.abs([...id].reduce((x, c) => x + c.charCodeAt(0), 0)) % 360,
  poster: posterFor("motion", id),
});

export const MOTION_PRESETS: PresetDef[] = [
  m("snap-zoom-in", "Snap Zoom In", "A sudden punch-in that lands hard on the subject.", "crush-zoom", "fast snap zoom in on the subject", ["crash-zoom-in"]),
  m("snap-zoom-out", "Snap Zoom Out", "A sudden pull-back that reveals the whole scene at once.", "slow-zoom-out", "fast snap zoom out revealing the whole scene", ["crash-zoom-out"]),
  m("pull-back-to-planet", "Pull Back to Planet", "The camera retreats from the subject to the skyline, then out to the whole planet.", "aerial-pullback", "continuous pull-back from the subject to the city skyline, then the continent, then the planet", ["dolly-out-max"]),
  m("dive-from-orbit", "Dive From Orbit", "One continuous dive from space through the cloud layer down to the subject.", "crush-zoom", "dive from orbit through the clouds down to the subject", ["fpv-dive"]),
  m("dolly-in", "Dolly In", "A smooth push toward the subject, closing distance.", "dolly-in", "slow dolly in toward the subject", ["dolly-in"]),
  m("dolly-out", "Dolly Out", "A slow retreat that widens the frame around the subject.", "dolly-out", "slow dolly out widening the frame", ["dolly-out"]),
  m("dolly-zoom", "Dolly Zoom", "The subject holds still while the background stretches - the classic push-pull.", "dolly-zoom", "dolly zoom, background stretching and warping behind the fixed subject", ["dolly-zoom-in"]),
  m("360-orbit", "360 Orbit", "A full circle around the subject in one continuous move.", "drone-orbit", "camera circles a full 360 degrees around the subject", ["orbit-360"]),
  m("frozen-orbit", "Frozen Orbit", "The subject hangs mid-motion while the camera sweeps around them.", "frozen-orbit", "time-frozen subject, camera sweeping around them mid-action", ["frozen-moment-arc"]),
  m("arc-left", "Arc Left", "A curved pass around the subject, drifting left.", "arc-left", "camera arcs left around the subject", ["arc-left-45"]),
  m("arc-right", "Arc Right", "A curved pass around the subject, drifting right.", "arc-right", "camera arcs right around the subject", ["arc-right-45"]),
  m("pan-left", "Pan Left", "A sideways sweep to the left from a fixed position.", "pan-left", "camera pans left", ["pan-left"]),
  m("pan-right", "Pan Right", "A sideways sweep to the right from a fixed position.", "pan-right", "camera pans right", ["pan-right"]),
  m("tilt-up", "Tilt Up", "The frame tilts upward - feet to sky.", "tilt-up", "camera tilts upward", ["tilt-up"]),
  m("tilt-down", "Tilt Down", "The frame tilts down to ground level.", "tilt-down", "camera tilts downward", ["tilt-down"]),
  m("crane-up", "Crane Up", "A rising reveal on a crane arm.", "crane-up", "crane shot rising above the subject", ["crane-up"]),
  m("crane-down", "Crane Down", "A descending crane that settles on the subject.", "crane-down", "crane shot descending to the subject", ["crane-down"]),
  m("pedestal-up", "Pedestal Up", "A straight vertical lift with no tilt.", "pedestal-up", "camera rises vertically", ["pedestal-up"]),
  m("pedestal-down", "Pedestal Down", "A straight vertical drop with no tilt.", "pedestal-down", "camera lowers vertically", ["pedestal-down"]),
  m("truck-left", "Truck Left", "A lateral slide to the left, parallel to the subject.", "truck-left", "camera trucks left", ["truck-left"]),
  m("truck-right", "Truck Right", "A lateral slide to the right, parallel to the subject.", "truck-right", "camera trucks right", ["truck-right"]),
  m("tracking", "Tracking Shot", "The camera travels alongside the subject.", "tracking", "tracking shot following the subject", ["side-track-right"]),
  m("side-tracking", "Side Tracking", "A parallel move that keeps pace with the subject.", "side-tracking", "side tracking shot moving parallel to the subject", ["side-track-left"]),
  m("handheld", "Handheld", "Loose, organic camera shake - documentary energy.", "handheld", "handheld camera with organic shake", ["handheld-subtle"]),
  m("whip-pan", "Whip Pan", "A fast blur pan that snaps across the scene.", "whip-pan", "fast whip pan blur", ["whip-pan-right"]),
  m("rack-focus", "Rack Focus", "Focus shifts between the foreground and the subject.", "rack-focus", "rack focus shifting depth between planes", ["rack-focus-near-to-far"]),
  m("body-mount", "Body Mount", "A rig bolted to the subject: they hold steady at frame centre and the background swings around them.", "body-mount", "body-mounted camera, subject fixed in frame, background swinging", ["body-mount"]),
  m("robot-arm", "Robot Arm", "A precise, high-speed robotic camera move.", "robot-arm", "ultra-precise robotic arm camera move", ["motion-control-sweep"]),
  m("pov", "POV", "A first-person view through the subject's eyes.", "pov", "first-person POV shot", ["object-pov"]),
  m("helicopter", "Helicopter Shot", "A sweeping aerial pass over the scene.", "helicopter-shot", "aerial helicopter shot sweeping over the scene", ["drone-flyover"]),
  m("drone-orbit", "Drone Orbit", "An agile FPV-style circle around the subject.", "drone-orbit", "fpv drone orbit around the subject", ["orbit-360"]),
  m("slow-zoom-in", "Slow Zoom In", "A creeping zoom that builds quiet tension.", "slow-zoom-in", "slow creeping zoom in", ["zoom-in"]),
  m("slow-zoom-out", "Slow Zoom Out", "A creeping retreat that lets the scene breathe.", "slow-zoom-out", "slow creeping zoom out", ["zoom-out"]),
  m("static", "Static", "A locked-off frame - the subject moves, the camera doesn't.", "static-shot", "locked static shot", ["locked-off"]),
  m("fpv-dive", "FPV Dive", "A first-person drone dive that rushes past the subject.", "drone-orbit", "fpv drone diving past the subject", ["fpv-dive"]),
  m("low-angle-hero", "Low-Angle Hero", "A ground-level frame that rises slowly onto the subject.", "pedestal-up", "low angle shot slowly rising on the heroic subject", ["low-angle-push"]),
  m("overhead-topdown", "Overhead Top-Down", "A straight-down, bird's-eye view.", "helicopter-shot", "top-down overhead shot looking straight at the subject", ["overhead-rise"]),
  m("shoulder-follow", "Shoulder Follow", "An over-the-shoulder shot that trails the subject.", "tracking", "over-the-shoulder tracking shot following the subject", ["follow-behind", "handheld-subtle"]),
  m("barrel-roll", "Barrel Roll", "The camera rolls on its axis mid-move.", "arc-left", "camera barrel-rolls around the subject", ["arc-left-45", "dutch-roll-cw"]),
  m("rising-reveal", "Rising Reveal", "A slow rise from below eye level into a reveal.", "crane-up", "camera rises slowly revealing the scene", ["crane-up", "tilt-down"]),
];

/** The trajectory stack a motion preset carries (stored with the job via
 *  params - `apply` merges into the job row). */
export function presetTrajectories(p: PresetDef): string[] {
  const v = p.apply.trajectory;
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/** Picker group for a motion preset - the group of its first trajectory id;
 *  presets without a stack fall back to "basic". */
export function presetGroup(p: PresetDef): TrajectoryGroup {
  return TRAJECTORY.get(presetTrajectories(p)[0] ?? "")?.group ?? "basic";
}
