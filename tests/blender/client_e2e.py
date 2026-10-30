#!/usr/bin/env python3
"""MotionField Blender add-on e2e driver - runs OUTSIDE Blender.

    python3 -I tests/blender/client_e2e.py <unpacked-extension-dir> <command> [arg]

The Playwright spec builds plugins/blender/dist/motionfield_blender-*.zip,
unpacks it into a temp dir and passes that dir here; this script inserts it
onto sys.path itself (-I keeps the ambient path empty) and drives the same
core.py the panel's worker thread calls - every flow below is the add-on's
own code, not a reimplementation.

Env:  MOTIONFIELD_URL      server base (e.g. http://localhost:3110)
      MOTIONFIELD_API_KEY  of_… - never printed; failures come back as the v1
                         envelope's code + message only.

Commands:
  texture                 prompt → image endpoint → wait → download → PNG check
  render-video <file> [still|clip]
                          still (default): fixture PNG → upload → i2v
                          clip: fixture MP4 → upload → restyle - both wait,
                          download and check for an ftyp box
  me                      check_connection → email/plan/credits (bad keys →
                          the envelope error, exit 1)
  insecure                http://example.com refused unless allow-insecure
"""

import json
import os
import sys
import tempfile

PNG_MAGIC = b"\x89PNG\r\n\x1a\n"


def main():
    ext_dir, cmd = sys.argv[1], sys.argv[2]
    sys.path.insert(0, os.path.join(ext_dir, "vendor"))
    sys.path.insert(0, ext_dir)
    import core  # noqa: E402 - path set above on purpose

    url = os.environ["MOTIONFIELD_URL"]
    key = os.environ.get("MOTIONFIELD_API_KEY", "")
    # OF_E2E_OUT lets the spec own the temp root (it removes it after the
    # byte checks); unset → a scratch dir under the system temp. Only the
    # download flows build it.
    out_root = os.environ.get("OF_E2E_OUT") or tempfile.mkdtemp(prefix="of-blender-e2e-")
    out_dir = os.path.join(out_root, "motionfield")

    def client():
        return core.make_client(url, key)

    if cmd == "me":
        try:
            me = core.check_connection(url, key)
        except core.AddonError as e:
            # the v1 envelope, redacted - the only thing a bad key may print
            print(f"ERR {e.code}: {e.message}", file=sys.stderr)
            return 1
        print(json.dumps({"email": me["email"], "plan": me["plan"],
                          "credits": me["credits"]}))
        return 0

    if cmd == "texture":
        os.makedirs(out_dir, exist_ok=True)
        try:
            c = client()
            ep = core.pick_texture_endpoint(core.list_models(c, api_key=key))
            job = core.submit_texture(c, "a seamless lava-rock texture",
                                      endpoint=ep, api_key=key)
            done, paths = core.run_job(client(), job, out_dir, interval=0.5,
                                       api_key=key)
        except core.AddonError as e:
            print(f"ERR {e.code}: {e.message}", file=sys.stderr)
            return 1
        data = open(paths[0], "rb").read()
        if not data or not data.startswith(PNG_MAGIC):
            print("ERR bad_download: not a PNG", file=sys.stderr)
            return 1
        print(f"ENDPOINT {ep}")
        print("PATH " + paths[0])
        return 0

    if cmd == "render-video":
        fixture = sys.argv[3]
        clip = len(sys.argv) > 4 and sys.argv[4] == "clip"
        media_type, prompt = ("video", "cinematic grade, shallow depth") \
            if clip else ("image", "slow dolly-in")
        os.makedirs(out_dir, exist_ok=True)
        try:
            c = client()
            ep = core.pick_video_endpoint(
                core.list_models(c, api_key=key), media_type)
            job = core.submit_render(c, fixture, media_type,
                                     endpoint=ep, values={"prompt": prompt},
                                     api_key=key)
            done, paths = core.run_job(client(), job, out_dir, interval=0.5,
                                       api_key=key)
        except core.AddonError as e:
            print(f"ERR {e.code}: {e.message}", file=sys.stderr)
            return 1
        data = open(paths[0], "rb").read()
        if not data or b"ftyp" not in data[:16]:
            print("ERR bad_download: no ftyp box", file=sys.stderr)
            return 1
        print(f"ENDPOINT {ep}")
        print("PATH " + paths[0])
        return 0

    if cmd == "insecure":
        try:
            core.normalize_base_url("http://example.com")
        except core.AddonError as e:
            if e.code != "insecure_url":
                print(f"ERR wrong refusal: {e.display()}", file=sys.stderr)
                return 1
        else:
            print("ERR http://example.com was NOT refused", file=sys.stderr)
            return 1
        ok = core.normalize_base_url("http://example.com", allow_insecure=True)
        if ok != "http://example.com":
            print(f"ERR allow-insecure normalized to {ok}", file=sys.stderr)
            return 1
        print("OK insecure guard")
        return 0

    print(f"ERR unknown command {cmd}", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main())
