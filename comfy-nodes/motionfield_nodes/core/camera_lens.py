"""Lens model — Python mirror of src/lib/camera/lens.ts.

    hFOV = 2 · atan(sensorWidth / (2 · focalMM))
"""
import math

SENSORS = {
    "full_frame": {"w": 36.0, "h": 24.0, "label": "Full Frame"},
    "super35": {"w": 24.89, "h": 18.66, "label": "Super 35"},
    "apsc": {"w": 23.5, "h": 15.6, "label": "APS-C"},
    "mft": {"w": 17.3, "h": 13.0, "label": "MFT"},
    "inch_1": {"w": 13.2, "h": 8.8, "label": "1-inch"},
}

DEG = 180.0 / math.pi


def _sensor(sensor):
    if isinstance(sensor, str):
        if sensor not in SENSORS:
            raise ValueError(f'unknown sensor "{sensor}"')
        return SENSORS[sensor]
    return sensor


def h_fov(focal_mm, sensor="full_frame"):
    s = _sensor(sensor)
    if focal_mm <= 0:
        raise ValueError("focal length must be positive")
    return 2 * math.atan(s["w"] / (2 * focal_mm)) * DEG


def v_fov(focal_mm, sensor="full_frame"):
    s = _sensor(sensor)
    if focal_mm <= 0:
        raise ValueError("focal length must be positive")
    return 2 * math.atan(s["h"] / (2 * focal_mm)) * DEG


def focal_for_h_fov(hfov_deg, sensor="full_frame"):
    s = _sensor(sensor)
    if not 0 < hfov_deg < 180:
        raise ValueError("hfov must be in (0,180)")
    return s["w"] / (2 * math.tan(hfov_deg / DEG / 2))


def dolly_zoom_fov(dist0, dist, hfov0_deg):
    if dist0 <= 0 or dist <= 0:
        raise ValueError("distances must be positive")
    if not 0 < hfov0_deg < 180:
        raise ValueError("hfov must be in (0,180)")
    tan0 = math.tan(hfov0_deg / DEG / 2)
    return 2 * math.atan(tan0 * (dist0 / dist)) * DEG
