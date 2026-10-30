"""OF_PlateAudio — the silent-plate fallback.

The node wraps VHS's get_audio: a plate with no audio stream must yield
(None,) so VHS_VideoCombine writes video-only instead of the whole run
dying mid-execute. A real audio clip yields the audio dict.
"""

import sys
import types


def _fake_vhs(get_audio):
    mod = types.ModuleType("ComfyUI-VideoHelperSuite.videohelpersuite.utils")
    mod.get_audio = get_audio
    sys.modules["ComfyUI-VideoHelperSuite.videohelpersuite.utils"] = mod


class _Fp:
    @staticmethod
    def get_annotated_filepath(v):
        return f"/input/{v}"


def _node():
    import motionfield_nodes

    cls = motionfield_nodes.NODE_CLASS_MAPPINGS["OF_PlateAudio"]
    return cls()


def test_silent_clip_returns_none():
    import motionfield_nodes.nodes_audio as na

    def boom(path, start, dur):
        raise Exception("VHS failed to extract audio")

    _fake_vhs(boom)
    na.folder_paths = _Fp
    assert _node().load("plate.mp4") == (None,)


def test_audio_clip_passes_audio_through():
    import motionfield_nodes.nodes_audio as na

    def ok(path, start, dur):
        assert path == "/input/plate.mp4"
        return {"waveform": object(), "sample_rate": 44100}

    _fake_vhs(ok)
    na.folder_paths = _Fp
    out = _node().load("plate.mp4")
    assert len(out) == 1 and out[0]["sample_rate"] == 44100


def test_empty_waveform_is_silence():
    import motionfield_nodes.nodes_audio as na

    def empty(path, start, dur):
        return {"waveform": type("W", (), {"shape": (1, 2, 0)})(), "sample_rate": 44100}

    _fake_vhs(empty)
    na.folder_paths = _Fp
    assert _node().load("plate.mp4") == (None,)


def test_missing_vhs_fails_clearly():
    import motionfield_nodes.nodes_audio as na

    sys.modules.pop("ComfyUI-VideoHelperSuite.videohelpersuite.utils", None)
    na.folder_paths = _Fp
    try:
        _node().load("plate.mp4")
    except RuntimeError as e:
        assert "VideoHelperSuite" in str(e)
    else:
        raise AssertionError("missing VHS must raise, not emit silence")
