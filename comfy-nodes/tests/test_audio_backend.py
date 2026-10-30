import importlib.util

from motionfield_nodes import nodes_audio


def test_linux_uses_cuda_even_when_mlx_package_is_installed(monkeypatch):
    monkeypatch.setattr(nodes_audio.sys, "platform", "linux")
    monkeypatch.setattr(importlib.util, "find_spec", lambda name: object())
    assert nodes_audio._mlx_available() is False


def test_macos_can_select_installed_mlx(monkeypatch):
    monkeypatch.setattr(nodes_audio.sys, "platform", "darwin")
    monkeypatch.setattr(importlib.util, "find_spec", lambda name: object())
    assert nodes_audio._mlx_available() is True
