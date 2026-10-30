# SPDX-License-Identifier: GPL-2.0-or-later
"""MotionField — Blender extension (GPL-2.0-or-later).

The bpy half: preferences, the 3D-View "MotionField" sidebar panel, operators
and the non-blocking job runner. ALL network, file and parameter rules live
in core.py (no bpy) — this file only wires them into Blender.

Key hygiene: the API key lives ONLY in add-on preferences (Blender's user
prefs) — never on a scene property (those serialize into .blend), never in
the Info log, never in a filename, never printed."""

import os
import queue
import tempfile
import threading

import bpy

from . import core

# --------------------------------------------------------------------------
# module state — models cache, the single in-flight job, and its queue
# --------------------------------------------------------------------------

_models_cache = []          # list[dict] — /api/v1/models payloads
_models_error = ""
_job_queue = queue.Queue()  # events from the worker thread
_worker = None              # threading.Thread | None
_cancel_flag = threading.Event()
_last_outputs = []          # [paths] from the last completed job


def _prefs(context):
    return context.preferences.addons[__package__].preferences


def _client(context, timeout=60.0):
    p = _prefs(context)
    return core.make_client(p.base_url, p.api_key,
                            allow_insecure=p.allow_insecure, timeout=timeout,
                            online_access=bpy.app.online_access)


def _report_error(self, e, context=None):
    key = _prefs(context).api_key if context is not None else None
    return core._map_error(e, key)


# --------------------------------------------------------------------------
# preferences
# --------------------------------------------------------------------------

class MOTIONFIELD_OT_check(bpy.types.Operator):
    """Call /api/v1/me and show who the key belongs to."""
    bl_idname = "motionfield.check_connection"
    bl_label = "Check connection"
    bl_description = "Verify the base URL and key against the server"
    bl_options = {"INTERNAL"}

    def execute(self, context):
        p = _prefs(context)
        try:
            me = core.check_connection(p.base_url, p.api_key,
                                       allow_insecure=p.allow_insecure,
                                       online_access=bpy.app.online_access)
        except Exception as e:  # noqa: BLE001 — errors surface as code+message
            err = _report_error(self, e, context)
            self.report({"ERROR"}, err.display())
            return {"CANCELLED"}
        # the key itself is never part of the message — only account fields
        self.report({"INFO"},
                    f"connected — {me['email']} · plan {me['plan'] or 'free'} · "
                    f"{me['credits']} credits")
        return {"FINISHED"}


class MotionFieldPreferences(bpy.types.AddonPreferences):
    bl_idname = __package__

    base_url: bpy.props.StringProperty(
        name="Server URL", default=core.DEFAULT_BASE_URL,
        description="Your MotionField server (origin only)")
    api_key: bpy.props.StringProperty(
        name="API key", subtype="PASSWORD", default="",
        description="An of_… key from Settings → API keys — stored only in "
                    "Blender's own preferences, never in the .blend")
    allow_insecure: bpy.props.BoolProperty(
        name="Allow insecure", default=False,
        description="Permit plain http to a non-loopback host — the key "
                    "travels in cleartext")

    def draw(self, context):
        col = self.layout.column(align=True)
        col.prop(self, "base_url")
        col.prop(self, "api_key")
        col.prop(self, "allow_insecure")
        col.operator(MOTIONFIELD_OT_check.bl_idname, icon="PLUGIN")


# --------------------------------------------------------------------------
# scene properties
# --------------------------------------------------------------------------

class OF_ParamOption(bpy.types.PropertyGroup):
    name: bpy.props.StringProperty()


class OF_Param(bpy.types.PropertyGroup):
    """One schema-declared field drawn in the panel — value is the scalar
    (or the enum's selected item as a string; core._coerce snaps it),
    bval drives booleans, and media fields take a filepath."""
    name: bpy.props.StringProperty()
    kind: bpy.props.StringProperty()       # string|integer|number|boolean|enum|media|other
    required: bpy.props.BoolProperty()
    value: bpy.props.StringProperty()
    bval: bpy.props.BoolProperty()
    opts: bpy.props.CollectionProperty(type=OF_ParamOption)


# Dynamic enum `items` results MUST stay referenced (Blender docs — a
# garbage-collected list corrupts the enum and can crash). Each callback
# owns a slot in this dict and replaces its list on every call.
_enum_items_keepalive = {}


def _endpoint_items(get_models, get_default):
    """An `items` callback listing `get_models()` endpoints with the
    preferred default first — an unset enum then selects it. When no
    non-LTX default exists the list leads with an empty "(pick an
    endpoint)" row instead of silently preselecting a restricted one."""
    slot = len(_enum_items_keepalive)
    _enum_items_keepalive[slot] = []

    def items(self, context):
        models = get_models()
        default = get_default()
        ids = [m.get("id") for m in models]
        first = default if default in ids else None
        out = []
        for m in models:
            out.append((m.get("id", ""), m.get("label") or m.get("id", ""),
                        m.get("description") or ""))
        out.sort(key=lambda e: 0 if e[0] == first else 1)
        if not out:
            out.append(("", "(no endpoints — refresh)", ""))
        elif first is None:
            out.insert(0, ("", "(pick an endpoint)", ""))
        _enum_items_keepalive[slot] = out
        return out
    return items


def _render_media_kind(scene):
    return "image" if scene.of_render_kind == "STILL" else "video"


def _sync_params(context):
    """Rebuild the dynamic param list for the currently picked endpoint —
    only the fields its input schema declares (enums as dropdowns)."""
    scene = context.scene
    model = None
    for m in _models_cache:
        if m.get("id") == scene.of_endpoint:
            model = m
            break
    scene.of_params.clear()
    if not model:
        return
    pick = core.required_media_field(model, _render_media_kind(scene))
    media_field = pick[0] if pick else None
    for f in core.schema_params(model):
        if f["name"] == media_field:
            continue                      # the render itself fills this
        it = scene.of_params.add()
        it.name = f["name"]
        it.kind = f["type"]
        it.required = f["required"]
        if f["type"] == "enum":
            for v in f["enum"] or []:
                o = it.opts.add()
                o.name = str(v)
            if f["default"] is not None:
                it.value = str(f["default"])
            elif it.opts:
                it.value = it.opts[0].name
        elif f["type"] == "boolean":
            it.bval = bool(f["default"])
        elif f["default"] is not None:
            it.value = str(f["default"])


def _on_endpoint_change(self, context):
    _sync_params(context)


def _on_kind_change(self, context):
    # re-pick the endpoint default for the new render kind, then re-sync —
    # an LTX endpoint is never the default (core.default_endpoint)
    scene = context.scene
    pick = core.pick_video_endpoint(_models_cache, _render_media_kind(scene))
    if pick:
        scene.of_endpoint = pick
    _sync_params(context)


def _collect_values(scene):
    """Scene of_params → {name: value} for core.build_params; media fields
    go to a second dict as local paths to upload."""
    values, media_paths = {}, {}
    for it in scene.of_params:
        if it.kind == "media":
            if it.value:
                media_paths[it.name] = it.value
        elif it.kind == "boolean":
            values[it.name] = it.bval
        else:
            values[it.name] = it.value
    return values, media_paths


def _register_scene_props():
    bpy.types.Scene.of_tex_prompt = bpy.props.StringProperty(
        name="Prompt", description="What the texture should look like")
    bpy.types.Scene.of_tex_endpoint = bpy.props.EnumProperty(
        name="Endpoint", items=_endpoint_items(
            lambda: core.texture_endpoints(_models_cache),
            lambda: core.pick_texture_endpoint(_models_cache)))
    bpy.types.Scene.of_render_kind = bpy.props.EnumProperty(
        name="Source", items=[("STILL", "Still frame", "Render the scene camera as a PNG"),
                              ("CLIP", "Frame range", "Render ≤81 frames and encode to MP4")],
        default="STILL", update=_on_kind_change)
    bpy.types.Scene.of_endpoint = bpy.props.EnumProperty(
        name="Endpoint", update=_on_endpoint_change,
        items=_endpoint_items(
            lambda: core.video_endpoints(_models_cache, _render_media_kind(bpy.context.scene)),
            lambda: core.pick_video_endpoint(_models_cache, _render_media_kind(bpy.context.scene))))
    bpy.types.Scene.of_params = bpy.props.CollectionProperty(type=OF_Param)
    bpy.types.Scene.of_import_as = bpy.props.EnumProperty(
        name="Import video as", items=[("PLANE", "Plane", "Camera-facing plane with a movie texture"),
                                       ("VSE", "VSE strip", "A strip in the Video Sequence Editor")],
        default="PLANE")
    bpy.types.Scene.of_status = bpy.props.StringProperty(name="Status", default="idle")
    bpy.types.Scene.of_progress = bpy.props.FloatProperty(
        name="Progress", subtype="PERCENTAGE", min=0, max=100, default=0)


# --------------------------------------------------------------------------
# the non-blocking job runner
# --------------------------------------------------------------------------

def _push(evt):
    _job_queue.put(evt)


def _run_job(context_snapshot, work):
    """Worker-thread entry: `work(client, push)` does submit→wait→download.
    Only plain data crosses the queue — never bpy objects, never the key."""
    global _worker
    try:
        client = core.make_client(
            context_snapshot["base_url"], context_snapshot["api_key"],
            allow_insecure=context_snapshot["allow_insecure"], timeout=120.0,
            online_access=context_snapshot.get("online_access", True))
        work(client, _push)
    except Exception as e:  # noqa: BLE001
        err = core._map_error(e, context_snapshot["api_key"])
        _push(("error", err.code, err.message))
    finally:
        _worker = None
        _push(("idle",))


def _start_job(context, work):
    global _worker
    if _worker is not None:
        return False
    _cancel_flag.clear()
    p = _prefs(context)
    snap = {"base_url": p.base_url, "api_key": p.api_key,
            "allow_insecure": p.allow_insecure,
            "online_access": bpy.app.online_access}
    _worker = threading.Thread(target=_run_job, args=(snap, work), daemon=True)
    _worker.start()
    return True


def _pump():
    """bpy.app.timers pump — drains worker events on the main thread (the
    only thread allowed to touch bpy data)."""
    scene = bpy.context.scene
    for _ in range(32):
        try:
            evt = _job_queue.get_nowait()
        except queue.Empty:
            break
        if scene is None:
            continue
        kind = evt[0]
        if kind == "status":
            scene.of_status = f"{evt[1]}…" if evt[1] else "working…"
            if evt[2] is not None:
                scene.of_progress = float(evt[2])
        elif kind == "submitted":
            scene.of_status = f"job {evt[1]} submitted"
        elif kind == "done":
            scene.of_status = "done"
            scene.of_progress = 100.0
            try:
                _apply_outputs(evt[1], evt[2])
            except Exception as e:  # noqa: BLE001
                err = core._map_error(e)
                scene.of_status = err.display()
        elif kind == "error":
            scene.of_status = f"{evt[1]}: {evt[2]}"
        elif kind == "idle":
            pass
    # this runs from a timer, not a draw — tag the 3D views so status,
    # progress and the new planes repaint without the user moving the mouse
    # (bpy.context.screen is None inside timers; walk the windows instead)
    try:
        for window in bpy.context.window_manager.windows:
            for area in (window.screen.areas if window.screen else ()):
                if area.type == "VIEW_3D":
                    area.tag_redraw()
    except Exception:  # noqa: BLE001 — a redraw hint is never worth a crash
        pass
    return 0.5


def _import_path(path):
    """One downloaded file → the importer matching its extension — the same
    dispatch MOTIONFIELD_OT_import uses."""
    ext = os.path.splitext(path)[1].lower()
    scene = bpy.context.scene
    if ext in (".mp4", ".mov", ".webm"):
        if scene and scene.of_import_as == "VSE":
            _import_vse(path)
        else:
            _import_video_plane(path)
    else:
        _import_image_plane(path)


def _apply_outputs(kind, paths):
    global _last_outputs
    _last_outputs = list(paths)
    if kind == "texture" and paths:
        _wire_texture(paths[0])
    elif paths:
        for p in paths:
            _import_path(p)


def _busy():
    return _worker is not None


# --------------------------------------------------------------------------
# Blender-side helpers (no rules — bpy calls only)
# --------------------------------------------------------------------------

def _output_dir():
    fp = bpy.data.filepath
    return core.output_dir(fp if fp else None)


def _wire_texture(image_path):
    """Downloaded image → Image Texture node → Base Color of the active
    object's material (created when missing)."""
    obj = bpy.context.active_object
    if obj is None:
        raise core.AddonError("no_object", "no active object to texture")
    mat = obj.active_material
    if mat is None:
        mat = bpy.data.materials.new(name="MotionField Texture")
        mat.use_nodes = True
        if obj.data and hasattr(obj.data, "materials"):
            obj.data.materials.append(mat)
        else:
            raise core.AddonError("no_material", "active object can't hold a material")
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    links = mat.node_tree.links
    bsdf = next((n for n in nodes if n.type == "BSDF_PRINCIPLED"), None)
    if bsdf is None:
        bsdf = nodes.new("ShaderNodeBsdfPrincipled")
        out = next((n for n in nodes if n.type == "OUTPUT_MATERIAL"), None) \
            or nodes.new("ShaderNodeOutputMaterial")
        links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])
    tex = nodes.new("ShaderNodeTexImage")
    tex.image = bpy.data.images.load(image_path, check_existing=True)
    links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])


def _camera_quat():
    cam = bpy.context.scene.camera
    return cam.matrix_world.to_quaternion() if cam else None


def _new_plane(name, aspect=1.0):
    """A camera-facing quad built with bpy.data only — safe from the timer
    pump and operator context alike (primitive_plane_add needs an object
    mode it doesn't always get)."""
    sx = aspect if aspect >= 1 else 1.0
    sy = 1.0 if aspect >= 1 else 1.0 / aspect
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(
        [(-sx, -sy, 0.0), (sx, -sy, 0.0), (sx, sy, 0.0), (-sx, sy, 0.0)],
        [], [(0, 1, 2, 3)])
    mesh.update()
    plane = bpy.data.objects.new(name, mesh)
    scene = bpy.context.scene
    collection = getattr(bpy.context, "collection", None) or (scene.collection if scene else None)
    if collection is None:
        raise core.AddonError("no_scene", "no scene/collection to import into")
    collection.objects.link(plane)
    quat = _camera_quat()
    if quat:
        plane.rotation_euler = quat.to_euler()
    return plane


def _aspect_of(img):
    size = getattr(img, "size", None)
    if size and len(size) >= 2 and size[1]:
        return size[0] / size[1]
    return 1.0


def _import_image_plane(path):
    """A downloaded image → a camera-facing plane with the image textured."""
    img = bpy.data.images.load(path, check_existing=True)
    plane = _new_plane("MotionField Image", _aspect_of(img))
    mat = bpy.data.materials.new(name="MotionField Image")
    mat.use_nodes = True
    bsdf = next((n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED"), None)
    tex = mat.node_tree.nodes.new("ShaderNodeTexImage")
    tex.image = img
    if bsdf:
        mat.node_tree.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
    plane.data.materials.append(mat)


def _import_video_plane(path):
    """A downloaded video → a camera-facing plane with a movie texture."""
    img = bpy.data.images.load(path, check_existing=True)
    img.source = "MOVIE"
    plane = _new_plane("MotionField Video", _aspect_of(img))
    mat = bpy.data.materials.new(name="MotionField Video")
    mat.use_nodes = True
    bsdf = next((n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED"), None)
    tex = mat.node_tree.nodes.new("ShaderNodeTexImage")
    tex.image = img
    iu = getattr(tex, "image_user", None)
    if iu is not None:
        iu.use_auto_refresh = True
        dur = getattr(img, "frame_duration", 0) or 0
        if dur:
            iu.frame_duration = dur
    if bsdf:
        mat.node_tree.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
    plane.data.materials.append(mat)


def _import_vse(path):
    """A downloaded video → a movie strip in the Video Sequence Editor.
    Blender 5.x renamed `sequences` to `strips`; an empty strips collection
    is falsy, so the fallback has to test for None explicitly."""
    scene = bpy.context.scene
    if scene is None:
        raise core.AddonError("no_scene", "no scene to import into")
    se = scene.sequence_editor or scene.sequence_editor_create()
    coll = getattr(se, "strips", None)
    if coll is None:
        coll = se.sequences
    coll.new_movie(
        name=os.path.basename(path), filepath=path, channel=1,
        frame_start=scene.frame_start)


def _render_still(path):
    scene = bpy.context.scene
    if scene.camera is None:
        raise core.AddonError("no_camera", "the scene has no active camera")
    old = (scene.render.filepath, scene.render.image_settings.file_format,
           scene.render.resolution_percentage)
    try:
        scene.render.filepath = path
        scene.render.image_settings.file_format = "PNG"
        bpy.ops.render.render(write_still=True)
    finally:
        (scene.render.filepath, scene.render.image_settings.file_format,
         scene.render.resolution_percentage) = old
    return path


def _render_clip(path):
    """scene frame range → MP4 through Blender's own FFMPEG encoder. The
    ≤81-frame rule is enforced by core before we ever get here.
    `image_settings.media_type` must be VIDEO before file_format=FFMPEG
    (4.2+ validates the pair); restored with the rest in `finally`."""
    scene = bpy.context.scene
    if scene.camera is None:
        raise core.AddonError("no_camera", "the scene has no active camera")
    frames = scene.frame_end - scene.frame_start + 1
    if frames < 1 or frames > core.MAX_CLIP_FRAMES:
        raise core.AddonError(
            "bad_range", f"frame range must be 1–{core.MAX_CLIP_FRAMES} frames")
    isets = scene.render.image_settings
    old = (scene.render.filepath, isets.file_format, scene.render.ffmpeg.format,
           getattr(isets, "media_type", None))
    try:
        if old[3] is not None:
            isets.media_type = "VIDEO"
        scene.render.filepath = path
        isets.file_format = "FFMPEG"
        scene.render.ffmpeg.format = "MPEG4"
        scene.render.ffmpeg.constant_rate_factor = "MEDIUM"
        bpy.ops.render.render(animation=True)
    finally:
        if old[3] is not None:
            isets.media_type = old[3]
        scene.render.filepath, isets.file_format, scene.render.ffmpeg.format = \
            old[0], old[1], old[2]
    return path


# --------------------------------------------------------------------------
# operators
# --------------------------------------------------------------------------

class MOTIONFIELD_OT_refresh(bpy.types.Operator):
    """Fetch /api/v1/models into the endpoint lists."""
    bl_idname = "motionfield.refresh_models"
    bl_label = "Refresh endpoints"
    bl_description = "Reload the endpoint list from the server"
    bl_options = {"INTERNAL"}

    def execute(self, context):
        global _models_error
        try:
            _models_cache[:] = core.list_models(_client(context))
            _models_error = ""
        except Exception as e:  # noqa: BLE001
            err = _report_error(self, e, context)
            _models_error = err.display()
            self.report({"ERROR"}, _models_error)
            return {"CANCELLED"}
        _sync_params(context)
        self.report({"INFO"}, f"{len(_models_cache)} endpoints")
        return {"FINISHED"}


class MOTIONFIELD_OT_texture(bpy.types.Operator):
    """prompt → image endpoint → wait → download → wire into Base Color."""
    bl_idname = "motionfield.texture_generate"
    bl_label = "Generate texture"
    bl_description = "Generate an image on MotionField and wire it into the active material"
    bl_options = {"INTERNAL"}

    @classmethod
    def poll(cls, context):
        return not _busy()

    def execute(self, context):
        scene = context.scene
        prompt = scene.of_tex_prompt.strip()
        if not prompt:
            self.report({"ERROR"}, "missing_param: give the texture a prompt")
            return {"CANCELLED"}
        # read on the MAIN thread — scene properties are off-limits to the
        # worker; an empty pick refuses locally rather than silently
        # preselecting a restricted (LTX) endpoint
        endpoint = scene.of_tex_endpoint or None
        if not endpoint:
            self.report({"ERROR"}, "no_endpoint: pick an endpoint — refresh the list")
            return {"CANCELLED"}
        out_dir = _output_dir()

        def work(client, push):
            job = core.submit_texture(client, prompt, endpoint=endpoint)
            push(("submitted", job["id"]))
            done, paths = core.run_job(
                client, job, out_dir,
                on_status=lambda s, p: push(("status", s, p)),
                cancelled=_cancel_flag.is_set)
            push(("done", "texture", paths))

        if not _start_job(context, work):
            self.report({"ERROR"}, "a job is already running")
            return {"CANCELLED"}
        scene.of_status = "submitted"
        return {"FINISHED"}


class MOTIONFIELD_OT_render_submit(bpy.types.Operator):
    """Render the scene camera → upload → picked endpoint → wait → download."""
    bl_idname = "motionfield.render_submit"
    bl_label = "Render to video"
    bl_description = "Render this scene and submit it as a video job on MotionField"
    bl_options = {"INTERNAL"}

    @classmethod
    def poll(cls, context):
        return not _busy()

    def execute(self, context):
        scene = context.scene
        kind = "image" if scene.of_render_kind == "STILL" else "video"
        tmp = tempfile.mkdtemp(prefix="of-render-")
        path = os.path.join(tmp, "render.png" if kind == "image" else "render.mp4")
        try:
            # render on the main thread — bpy.ops.render is not thread-safe
            if kind == "image":
                _render_still(path)
            else:
                _render_clip(path)
        except Exception as e:  # noqa: BLE001
            err = _report_error(self, e, context)
            self.report({"ERROR"}, err.display())
            return {"CANCELLED"}

        values, media_paths = _collect_values(scene)
        out_dir = _output_dir()
        endpoint = scene.of_endpoint or None
        if not endpoint:
            self.report({"ERROR"}, "no_endpoint: pick an endpoint — refresh the list")
            return {"CANCELLED"}

        def work(client, push):
            job = core.submit_render(client, path, kind, endpoint=endpoint,
                                     values=values, extra_media_paths=media_paths)
            push(("submitted", job["id"]))
            done, paths = core.run_job(
                client, job, out_dir,
                on_status=lambda s, p: push(("status", s, p)),
                cancelled=_cancel_flag.is_set)
            push(("done", "render", paths))

        if not _start_job(context, work):
            self.report({"ERROR"}, "a job is already running")
            return {"CANCELLED"}
        scene.of_status = "submitted"
        return {"FINISHED"}


class MOTIONFIELD_OT_cancel(bpy.types.Operator):
    """POST /api/v1/jobs/{id}/cancel through the worker's flag."""
    bl_idname = "motionfield.cancel_job"
    bl_label = "Cancel"
    bl_description = "Cancel the running job on the server"
    bl_options = {"INTERNAL"}

    @classmethod
    def poll(cls, context):
        return _busy()

    def execute(self, context):
        _cancel_flag.set()
        return {"FINISHED"}


class MOTIONFIELD_OT_import(bpy.types.Operator):
    """Import the last download — image → camera-facing plane; video →
    movie-texture plane or a VSE strip (the user's pick)."""
    bl_idname = "motionfield.import_last"
    bl_label = "Import last output"
    bl_options = {"INTERNAL"}

    def execute(self, context):
        if not _last_outputs:
            self.report({"ERROR"}, "nothing downloaded yet")
            return {"CANCELLED"}
        for path in _last_outputs:
            try:
                _import_path(path)
            except Exception as e:  # noqa: BLE001
                err = _report_error(self, e, context)
                self.report({"ERROR"}, err.display())
                return {"CANCELLED"}
        return {"FINISHED"}


# --------------------------------------------------------------------------
# the sidebar panel
# --------------------------------------------------------------------------

class MOTIONFIELD_PT_panel(bpy.types.Panel):
    bl_label = "MotionField"
    bl_space_type = "VIEW_3D"
    bl_region_type = "UI"
    bl_category = "MotionField"

    def draw(self, context):
        scene = context.scene
        layout = self.layout

        box = layout.box()
        box.label(text="Texture", icon="TEXTURE")
        box.prop(scene, "of_tex_prompt")
        box.prop(scene, "of_tex_endpoint")
        box.operator(MOTIONFIELD_OT_texture.bl_idname, icon="PLAY")

        box = layout.box()
        box.label(text="Render to video", icon="RENDER_ANIMATION")
        box.prop(scene, "of_render_kind", expand=True)
        box.prop(scene, "of_endpoint")
        for it in scene.of_params:
            if it.kind == "enum":
                box.prop_search(it, "value", it, "opts", text=it.name)
            elif it.kind == "boolean":
                box.prop(it, "bval", text=it.name)
            elif it.kind == "media":
                box.prop(it, "value", text=it.name)
            else:
                box.prop(it, "value", text=it.name)
        box.operator(MOTIONFIELD_OT_render_submit.bl_idname, icon="PLAY")

        box = layout.box()
        box.label(text="Import", icon="IMPORT")
        box.prop(scene, "of_import_as")
        box.operator(MOTIONFIELD_OT_import.bl_idname)

        row = layout.row(align=True)
        row.operator(MOTIONFIELD_OT_refresh.bl_idname, icon="FILE_REFRESH")
        row.operator(MOTIONFIELD_OT_cancel.bl_idname, icon="CANCEL")
        layout.prop(scene, "of_progress", slider=True)
        layout.label(text=scene.of_status)
        if _models_error:
            layout.label(text=_models_error, icon="ERROR")


# --------------------------------------------------------------------------
# registration
# --------------------------------------------------------------------------

CLASSES = (
    OF_ParamOption,
    OF_Param,
    MotionFieldPreferences,
    MOTIONFIELD_OT_check,
    MOTIONFIELD_OT_refresh,
    MOTIONFIELD_OT_texture,
    MOTIONFIELD_OT_render_submit,
    MOTIONFIELD_OT_cancel,
    MOTIONFIELD_OT_import,
    MOTIONFIELD_PT_panel,
)


def register():
    for c in CLASSES:
        bpy.utils.register_class(c)
    _register_scene_props()
    bpy.app.timers.register(_pump, persistent=True)


def unregister():
    _cancel_flag.set()
    try:
        bpy.app.timers.unregister(_pump)
    except Exception:  # noqa: BLE001
        pass
    for c in reversed(CLASSES):
        bpy.utils.unregister_class(c)
    for p in ("of_tex_prompt", "of_tex_endpoint", "of_render_kind",
              "of_endpoint", "of_params", "of_import_as", "of_status", "of_progress"):
        if hasattr(bpy.types.Scene, p):
            delattr(bpy.types.Scene, p)


if __name__ == "__main__":
    register()
