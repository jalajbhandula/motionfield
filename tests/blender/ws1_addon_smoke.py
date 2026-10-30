"""Blender headless smoke for the MotionField extension - runs INSIDE Blender:

    blender --background --factory-startup --python tests/blender/ws1_addon_smoke.py

Env:  OF_ZIP             the built dist/motionfield_blender-*.zip
      MOTIONFIELD_URL      the dev server (e.g. http://localhost:3110)
      MOTIONFIELD_API_KEY  of_… key

Installs the zip into the user_default repo via
bpy.ops.extensions.package_install_files (the real install path), then
drives the panel's own flow: refresh_models, a still render off the scene
camera, bpy.ops.motionfield.render_submit() - the operator renders, submits,
and its worker downloads while the script pumps addon._pump() (registered
timers don't fire while a --python script blocks). The downloaded MP4 is
checked for an ftyp box.
"""

import os
import sys
import tempfile
import time

import bpy

EXT_MODULE = "bl_ext.user_default.motionfield_blender"


def main():
    zip_path = os.environ["OF_ZIP"]
    url = os.environ["MOTIONFIELD_URL"]
    key = os.environ["MOTIONFIELD_API_KEY"]

    bpy.ops.extensions.package_install_files(
        filepath=zip_path, repo="user_default", enable_on_install=True)

    import importlib
    addon = importlib.import_module(EXT_MODULE)

    prefs = bpy.context.preferences.addons[EXT_MODULE].preferences
    prefs.base_url = url
    prefs.api_key = key

    # a scene that renders: camera + a lit cube, software engine so no
    # headless GPU is needed
    scene = bpy.context.scene
    if scene.camera is None:
        cam = bpy.data.cameras.new("Smoke Cam")
        cam_ob = bpy.data.objects.new("Smoke Cam", cam)
        scene.collection.objects.link(cam_ob)
        cam_ob.location = (5.0, -5.0, 4.0)
        cam_ob.rotation_euler = (1.05, 0.0, 0.785)
        scene.camera = cam_ob
    scene.render.engine = "BLENDER_WORKBENCH"
    scene.render.resolution_x = 64
    scene.render.resolution_y = 64
    scene.render.resolution_percentage = 100

    # the panel's real path - refresh fills the enums; pick what its own
    # default rule picks (never an LTX endpoint)
    bpy.ops.motionfield.refresh_models()
    assert addon._models_cache, "refresh_models listed no endpoints"
    endpoint = addon.core.pick_video_endpoint(addon._models_cache, "image")
    assert endpoint, "no image-in → video endpoint in the refreshed list"
    assert "ltx" not in endpoint.lower(), f"restricted endpoint picked: {endpoint}"
    scene.of_render_kind = "STILL"
    scene.of_endpoint = endpoint
    for it in scene.of_params:
        if it.name == "prompt":
            it.value = "slow cinematic orbit"

    # render + submit through the operator; the worker thread only talks to
    # the main thread through the queue _pump drains
    res = bpy.ops.motionfield.render_submit()
    assert "FINISHED" in res, f"render_submit returned {res}"
    deadline = time.monotonic() + 180.0
    while addon._busy() and time.monotonic() < deadline:
        addon._pump()
        time.sleep(0.05)
    assert not addon._busy(), "render_submit job did not finish"
    for _ in range(8):
        addon._pump()  # drain trailing done/idle events

    paths = list(addon._last_outputs)
    assert paths, f"no downloads - status: {scene.of_status!r}"
    data = open(paths[0], "rb").read()
    assert data and b"ftyp" in data[:16], "downloaded output is not an MP4"
    print("SMOKE-OK", endpoint, paths[0])
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:  # noqa: BLE001 - a smoke failure prints code+message
        try:
            from bl_ext.user_default.motionfield_blender import core as _core
            err = _core._map_error(e, os.environ.get("MOTIONFIELD_API_KEY"))
            print(f"SMOKE-FAIL {err.code}: {err.message}", file=sys.stderr)
        except Exception:  # noqa: BLE001
            print(f"SMOKE-FAIL {e}", file=sys.stderr)
        sys.exit(1)
