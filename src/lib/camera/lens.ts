/** Thin lens model - horizontal FOV math shared by the trajectory engine,
 *  the catalog, and the Python mirror (core/camera_lens.py). Kept dependency-
 *  free so both implementations stay numerically identical.
 *
 *      hFOV = 2 · atan(sensorWidth / (2 · focalMM))
 *
 *  Mirrored by comfy-nodes/motionfield_nodes/core/camera_lens.py.
 */

export interface SensorFormat { w: number; h: number; label: string }

export const SENSORS = {
  full_frame: { w: 36, h: 24, label: "Full Frame" },
  super35: { w: 24.89, h: 18.66, label: "Super 35" },
  apsc: { w: 23.5, h: 15.6, label: "APS-C" },
  mft: { w: 17.3, h: 13, label: "MFT" },
  inch_1: { w: 13.2, h: 8.8, label: "1-inch" },
} as const satisfies Record<string, SensorFormat>;
export type SensorName = keyof typeof SENSORS;

const DEG = 180 / Math.PI;

/** Horizontal FOV in degrees for `focalMM` on `sensor` (name or format). */
export function hFov(focalMM: number, sensor: SensorName | SensorFormat = "full_frame"): number {
  const s = typeof sensor === "string" ? SENSORS[sensor] : sensor;
  if (!s) throw new Error(`unknown sensor "${sensor}"`);
  if (focalMM <= 0) throw new Error("focal length must be positive");
  return 2 * Math.atan(s.w / (2 * focalMM)) * DEG;
}

/** Vertical FOV in degrees. */
export function vFov(focalMM: number, sensor: SensorName | SensorFormat = "full_frame"): number {
  const s = typeof sensor === "string" ? SENSORS[sensor] : sensor;
  if (!s) throw new Error(`unknown sensor "${sensor}"`);
  if (focalMM <= 0) throw new Error("focal length must be positive");
  return 2 * Math.atan(s.h / (2 * focalMM)) * DEG;
}

/** Focal length (mm) that yields `hfovDeg` on `sensor`. */
export function focalForHFov(hfovDeg: number, sensor: SensorName | SensorFormat = "full_frame"): number {
  const s = typeof sensor === "string" ? SENSORS[sensor] : sensor;
  if (!s) throw new Error(`unknown sensor "${sensor}"`);
  if (hfovDeg <= 0 || hfovDeg >= 180) throw new Error("hfov must be in (0,180)");
  return s.w / (2 * Math.tan(hfovDeg / DEG / 2));
}

/** Dolly-zoom: the FOV at `dist` metres of subject distance that keeps
 *  `dist · tan(hfov/2)` at the `dist0`/`hfov0` product - the subject holds
 *  its size while the background stretches (dist < dist0) or squeezes. */
export function dollyZoomFov(dist0: number, dist: number, hfov0Deg: number): number {
  if (dist0 <= 0 || dist <= 0) throw new Error("distances must be positive");
  if (hfov0Deg <= 0 || hfov0Deg >= 180) throw new Error("hfov must be in (0,180)");
  const tan0 = Math.tan(hfov0Deg / DEG / 2);
  return 2 * Math.atan(tan0 * (dist0 / dist)) * DEG;
}
