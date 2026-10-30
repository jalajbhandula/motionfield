#!/usr/bin/env python3
"""MotionField node-pack test runner — plain asserts, no pytest.

Discovers test_*.py files next to this script, imports each, and runs every
top-level test_* function. Exits non-zero if any import or test fails.
Runs under `python -I`, so paths are wired up explicitly below.
"""

import importlib.util
import sys
import traceback
from pathlib import Path

TESTS_DIR = Path(__file__).resolve().parent
PACK_ROOT = TESTS_DIR.parent

for _p in (str(TESTS_DIR), str(PACK_ROOT)):
    if _p not in sys.path:
        sys.path.insert(0, _p)


def main() -> int:
    failures = 0
    for test_file in sorted(TESTS_DIR.glob("test_*.py")):
        spec = importlib.util.spec_from_file_location(test_file.stem, test_file)
        mod = importlib.util.module_from_spec(spec)
        try:
            spec.loader.exec_module(mod)
        except Exception:
            failures += 1
            print(f"FAIL {test_file.name} (import)")
            traceback.print_exc()
            continue
        for name in sorted(dir(mod)):
            if not name.startswith("test_"):
                continue
            fn = getattr(mod, name)
            if not callable(fn):
                continue
            try:
                fn()
            except Exception:
                failures += 1
                print(f"FAIL {test_file.name}::{name}")
                traceback.print_exc()
            else:
                print(f"PASS {test_file.name}::{name}")
    print(f"{'FAILED' if failures else 'OK'} ({failures} failure{'s' if failures != 1 else ''})")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
