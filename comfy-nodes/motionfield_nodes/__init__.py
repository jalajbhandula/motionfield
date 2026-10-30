"""MotionField ComfyUI node pack.

Discovers sibling ``nodes_*.py`` modules, imports each via importlib, and merges
their ``NODE_CLASS_MAPPINGS`` / ``NODE_DISPLAY_NAME_MAPPINGS``. A module that
fails to import is logged and skipped so one bad node never breaks the pack.
"""

import importlib
import logging
import pkgutil

logger = logging.getLogger("motionfield_nodes")

NODE_CLASS_MAPPINGS: dict = {}
NODE_DISPLAY_NAME_MAPPINGS: dict = {}

for _info in pkgutil.iter_modules(__path__):
    if not _info.name.startswith("nodes_"):
        continue
    try:
        _mod = importlib.import_module(f"{__name__}.{_info.name}")
    except Exception:
        logger.exception("motionfield_nodes: skipping %s (import failed)", _info.name)
        continue
    NODE_CLASS_MAPPINGS.update(getattr(_mod, "NODE_CLASS_MAPPINGS", {}))
    NODE_DISPLAY_NAME_MAPPINGS.update(getattr(_mod, "NODE_DISPLAY_NAME_MAPPINGS", {}))

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
