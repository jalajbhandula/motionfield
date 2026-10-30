/**
 * CameraRig e2e (GENERATION_PROVIDER=mock via playwright.config):
 *  - motionfield/camera/image-to-video takes the move stack as params.moves -
 *    a "+"-joined string or id array, normalised to "a+b" on the stored job
 *    (a legacy params.trajectory is accepted and consumed). Core pose-only
 *    ids run; rig-mode ids, hidden ids, unknown ids, >3-id stacks and
 *    out-of-range strength/duration/distance/fov are refused with a 400
 *    before any charge. On non-executing endpoints the same values stay
 *    prompt-guided (accepted, never promised as executed motion).
 *  - on /generate?model=camera-rig the picker disables rig-mode and no-stack
 *    rows with the reason visible, labels Auto "Static", shows core rows'
 *    chips + honest notes, marks orbit rows "partial" with the near-static
 *    note, and submits the stack as params.moves with no motion preset_id
 *    (no prompt fragment). On Wan 2.1 every row is prompt-guided.
 *  - switching models in the dropdown re-keys on the endpoint id: a rig-mode
 *    or no-stack pick snaps back to Static on camera-rig, and aspect values
 *    outside the new enum snap to its first entry (Lens 4:3 → rig 16:9).
 */
import { test, expect } from "@playwright/test";

// sign-up fires a profile-insert hook that can't see a concurrently-committing
// user row on PGlite - keep the sign-ups serial.
test.describe.configure({ mode: "serial" });

const EP = "motionfield/camera/image-to-video";
// 8×8 opaque PNG - enough for the /api/uploads mime check on the mock provider
const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAACXBIWXMAAAsTAAALEwEAmpwYAAAAEklEQVR4nGP8//8/AzGAiShVADsKBP8IUFc6AAAAAElFTkSuQmCC",
  "base64",
);

async function signUp(request: import("@playwright/test").APIRequestContext, tag: string) {
  const email = `ws3cam-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.local`;
  const su = await request.post("/api/auth/sign-up/email", {
    data: { email, password: "test-pass-1234", name: "WS3 Cam" },
  });
  expect(su.ok(), `signup: ${su.status()}`).toBeTruthy();
}

test.describe("ws3 camera rig", () => {
  test("[OF-0136] moves gate: core stacks run; rig/hidden/unknown/oversize stacks and out-of-range strength refuse with a 400 and no charge", async ({ request }) => {
    await signUp(request, "gate");
    // settle the daily-grant so the balance check measures only job charges
    const me0 = await (await request.get("/api/me")).json();
    const before = Number(me0.profile.credits);

    const cases: { name: string; params: Record<string, unknown>; match: RegExp }[] = [
      { name: "rig-mode move", params: { image_url: "/files/start.png", moves: "body-mount" }, match: /rig|pose|moves/i },
      { name: "hidden move", params: { image_url: "/files/start.png", moves: "cabin-jolt" }, match: /cabin-jolt is not available on this endpoint/i },
      { name: "unknown move", params: { image_url: "/files/start.png", moves: "bogus-move" }, match: /unknown/i },
      { name: "4-id stack", params: { image_url: "/files/start.png", moves: "dolly-in+pan-left+arc-left-45+tilt-up" }, match: /1-3|1-3/ },
      { name: "strength over max", params: { image_url: "/files/start.png", moves: "dolly-in", strength: 3 }, match: /strength/i },
      { name: "strength under min", params: { image_url: "/files/start.png", moves: "dolly-in", strength: 0.1 }, match: /strength/i },
      { name: "rig via legacy trajectory", params: { image_url: "/files/start.png", trajectory: ["body-mount"] }, match: /rig|pose|moves/i },
      { name: "fun path hidden", params: { image_url: "/files/start.png", moves: "dolly-in", camera_path: "fun" }, match: /camera_path.*not available/i },
      { name: "missing start frame", params: { moves: "dolly-in" }, match: /image_url|required|missing/i },
    ];
    for (const c of cases) {
      const r = await request.post("/api/jobs", {
        data: { endpoint_id: EP, params: { duration: 3, ...c.params } },
      });
      expect(r.status(), c.name).toBe(400);
      const err = (await r.json()).error;
      expect(String(typeof err === "string" ? err : err?.message ?? JSON.stringify(err)), c.name).toMatch(c.match);
    }

    const me1 = await (await request.get("/api/me")).json();
    expect(Number(me1.profile.credits), "rejections must not charge").toBe(before);

    // a core move runs - open license, no opt-in needed
    let r = await request.post("/api/jobs", {
      data: { endpoint_id: EP, params: { image_url: "/files/start.png", prompt: "a lighthouse at dusk", moves: "dolly-in", duration: 3 } },
    });
    expect(r.status()).toBe(201);
    const job = (await r.json()).job;
    expect(job.params.moves).toBe("dolly-in");
    if (job?.id) await request.post(`/api/jobs/${job.id}/cancel`);

    // the same rig stack on a prompt-guided endpoint is accepted - it only
    // reaches the prompt there (open Apache-2.0 endpoint, job then canceled)
    r = await request.post("/api/jobs", {
      data: { endpoint_id: "motionfield/wan-2.1/text-to-video", params: { prompt: "a forest clearing", trajectory: ["body-mount"], duration: 3, resolution: "480p" } },
    });
    expect([201, 202]).toContain(r.status());
    const guided = (await r.json()).job;
    if (guided?.id) await request.post(`/api/jobs/${guided.id}/cancel`).catch(() => {});
  });

  test("[OF-0143] moves normalization: '+'-joined string, id array and legacy trajectory array all store params.moves as 'a+b'", async ({ request }) => {
    await signUp(request, "norm");

    const submit = async (params: Record<string, unknown>) => {
      const r = await request.post("/api/jobs", {
        data: { endpoint_id: EP, params: { image_url: "/files/start.png", duration: 2, ...params } },
      });
      expect(r.status()).toBe(201);
      const job = (await r.json()).job;
      if (job?.id) await request.post(`/api/jobs/${job.id}/cancel`);
      return job;
    };

    let job = await submit({ moves: "dolly-in+pan-left" });
    expect(job.params.moves).toBe("dolly-in+pan-left");
    expect(job.params.trajectory).toBeUndefined();

    job = await submit({ moves: ["arc-left-45", "dutch-roll-cw"] });
    expect(job.params.moves).toBe("arc-left-45+dutch-roll-cw");

    job = await submit({ trajectory: ["dolly-in", "pan-left"] });
    expect(job.params.moves).toBe("dolly-in+pan-left");

    job = await submit({ trajectory: "crane-up+tilt-down" });
    expect(job.params.moves).toBe("crane-up+tilt-down");
  });

  test("[OF-0138] picker: rig/no-stack rows disabled on camera-rig, Auto reads Static, core rows show chips; Wan 2.1 stays prompt-guided", async ({ page }) => {
    await page.goto("/generate?model=camera-rig");

    // the model pill lands on CameraRig, the Start frame control shows, and
    // Auto is labelled Static (a locked-off shot) on the executing endpoint
    await expect(page.getByRole("button", { name: /CameraRig/ })).toBeVisible();
    await expect(page.getByText("Start frame")).toBeVisible();
    await expect(page.getByRole("button", { name: /GENERATE/i })).toBeDisabled();
    const trigger = page.getByRole("button", { name: /Camera\s+Static/ });
    await expect(trigger).toBeVisible();
    await trigger.click();

    // rig-mode rows are disabled with the reason visible - not "prompt-guided"
    for (const name of [/^Body Mount/, /^Frozen Orbit/, /^Rack Focus/]) {
      const row = page.getByRole("button", { name });
      await expect(row, `${name}`).toBeDisabled();
      await expect(row.getByText("not on this model - needs rig modes")).toBeVisible();
    }

    // a no-stack preset row is disabled with its own reason
    const pov = page.getByRole("button", { name: /^POV/ });
    await expect(pov).toBeDisabled();
    await expect(pov.getByText("not on this model - needs rig modes")).toBeVisible();

    // core rows stay enabled with their stack chips rendered under the row -
    // Barrel Roll is a two-move core stack (arc-left-45 + dutch-roll-cw)
    const barrel = page.getByRole("button", { name: /^Barrel Roll/ });
    await expect(barrel).toBeEnabled();
    await expect(barrel.getByText("Arc Left 45°")).toBeVisible();
    await expect(barrel.getByText("Dutch Roll CW")).toBeVisible();

    // the Static auto row carries its locked-off hint
    await expect(page.getByText("locked-off").first()).toBeVisible();

    // duration options come from the workflow's own enum (2-5s, not 1s/10s/15s)
    // - and the trigger lands on the endpoint's declared default, 3s
    await page.getByRole("button", { name: /Camera\s+Static/ }).click(); // close picker
    const dur = page.getByRole("button", { name: /^3s\s+▾$/ });
    await dur.click();
    await expect(page.getByRole("button", { name: "2s", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "3s", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "1s", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "10s", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "15s", exact: true })).toHaveCount(0);

    // on Wan 2.1 nothing executes - Auto stays Auto and every row is
    // prompt-guided (and clickable)
    await page.goto("/generate?model=wan-2-1");
    const t2 = page.getByRole("button", { name: /Camera\s+Auto/ });
    await expect(t2).toBeVisible();
    await t2.click();
    const guided = page.getByText("prompt-guided");
    await expect(guided.first(), "prompt-guided labels").toBeVisible();
    expect(await guided.count()).toBeGreaterThan(30);
    await expect(page.getByRole("button", { name: /^Body Mount/ })).toBeEnabled();
    await expect(page.getByRole("button", { name: /^POV/ })).toBeEnabled();
  });

  test("[OF-0183] orbit stacks run but flag 'partial' + the near-static note; non-orbit rows execute fully", async ({ page }) => {
    await page.goto("/generate?model=camera-rig");
    await page.getByRole("button", { name: /Camera\s+Static/ }).click();

    // orbit stacks execute but stay flagged - the swing barely reaches the
    // video on this model: a visible "partial" chip, a "cloud-recommended"
    // chip pointing at the conditioned path, plus the near-static note under
    // the row (not just a tooltip)
    for (const name of [/^Arc Left/, /^Barrel Roll/, /^360 Orbit/]) {
      const row = page.getByRole("button", { name });
      await expect(row, `${name}`).toBeEnabled();
      await expect(row.getByText("partial", { exact: true }), `${name} partial chip`).toBeVisible();
      await expect(row.getByText("cloud-recommended", { exact: true }), `${name} cloud chip`).toBeVisible();
      await expect(row.getByText(/near-static background/), `${name} orbit note`).toBeVisible();
    }
    const arc = page.getByRole("button", { name: /^Arc Left/ });
    await expect(arc.getByText("Arc Left 45°")).toBeVisible();
    const orbit = page.getByRole("button", { name: /^360 Orbit/ });
    await expect(orbit.getByText(/the unseen side is generated/)).toBeVisible();

    // non-orbit core rows execute fully - no partial label, no cloud chip,
    // no orbit note
    const dolly = page.getByRole("button", { name: /^Dolly In/ });
    await expect(dolly).toBeEnabled();
    await expect(dolly.getByText("partial", { exact: true })).toHaveCount(0);
    await expect(dolly.getByText("cloud-recommended", { exact: true })).toHaveCount(0);
    await expect(dolly.getByText(/near-static background/)).toHaveCount(0);
  });

  test("[OF-0136] model switch snaps stale picks: Body Mount on Wan 2.1 → Camera Static on camera-rig; Lens 4:3 → rig 16:9", async ({ page }) => {
    // Wan 2.1 is prompt-guided - the rig-mode row stays pickable there
    await page.goto("/generate?model=wan-2-1");
    await page.getByRole("button", { name: /Camera\s+Auto/ }).click();
    await page.getByRole("button", { name: /^Body Mount/ }).click();
    await expect(page.getByRole("button", { name: /Camera\s+Body Mount/ })).toBeVisible();

    // switching models keeps wfId "image-to-video" only on some paths - the
    // snap must key on the endpoint: a rig-mode pick resets to Static rather
    // than showing a label whose submit would send locked-off
    await page.getByRole("button", { name: /^Wan 2\.1/ }).click();
    await page.getByRole("button", { name: /CameraRig · Wan VACE/ }).click();
    await expect(page.getByRole("button", { name: /Camera\s+Static/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /Camera\s+Body Mount/ })).toHaveCount(0);

    // same stale-value class on the aspect enum: the Director offers 4:3
    // while the rig renders 16:9/9:16/1:1 - the pick snaps to the new
    // endpoint's first enum entry (the LTX Lens skin used to be the fixture
    // here; it's a restricted opt-in now, so the open Director stands in)
    await page.getByRole("button", { name: /CameraRig · Wan VACE/ }).click();
    await page.getByRole("button", { name: /Camera Control · Wan VACE/ }).click();
    await page.getByRole("button", { name: /^16:9\s+▾$/ }).click();
    await page.getByRole("button", { name: /^4:3$/ }).click();
    await expect(page.getByRole("button", { name: /^4:3\s+▾$/ })).toBeVisible();
    await page.getByRole("button", { name: /Camera Control · Wan VACE/ }).click();
    await page.getByRole("button", { name: /CameraRig · Wan VACE/ }).click();
    await expect(page.getByRole("button", { name: /^16:9\s+▾$/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /^4:3\s+▾$/ })).toHaveCount(0);
  });

  test("[OF-0143] UI submit: uploaded start frame + Barrel Roll → params.moves 'a+b', no motion preset_id, prompt carries no fragment", async ({ page }) => {
    const email = `ws3cam-ui-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.local`;
    await page.goto("/signup");
    await page.getByPlaceholder("Display name").fill("WS3 Cam UI");
    await page.getByPlaceholder("you@email.com").fill(email);
    await page.getByPlaceholder("Password (8+ chars)").fill("test-pass-1234");
    await page.getByRole("button", { name: /Get 50 credits/ }).click();
    await page.waitForURL("**/onboarding", { timeout: 30_000 });

    await page.goto("/generate?model=camera-rig");
    await expect(page.getByText("Start frame")).toBeVisible();

    // upload the start frame through the real control
    await page.locator('input[type="file"]').setInputFiles({
      name: "start.png", mimeType: "image/png", buffer: PNG_1PX,
    });
    await expect(page.locator('img[alt="start frame"]')).toBeVisible();

    // Barrel Roll - a two-move core stack (arc-left-45 + dutch-roll-cw)
    await page.getByRole("button", { name: /Camera\s+Static/ }).click();
    await page.getByRole("button", { name: /^Barrel Roll/ }).click();
    await expect(page.getByRole("button", { name: /Camera\s+Barrel Roll/ })).toBeVisible();

    await page.getByPlaceholder(/Describe your scene/).fill("a boat on the water");

    const reqP = page.waitForRequest((r) => r.url().includes("/api/jobs") && r.method() === "POST");
    const resP = page.waitForResponse((r) => r.url().includes("/api/jobs") && r.request().method() === "POST");
    await page.getByRole("button", { name: /GENERATE/i }).click();
    const req = await reqP;
    const res = await resP;
    expect(res.status()).toBe(201);

    const body = req.postDataJSON() as {
      preset_id: string | null; preset_kind: string | null;
      params: Record<string, unknown>;
    };
    expect(body.params.moves).toBe("arc-left-45+dutch-roll-cw");
    expect(body.preset_id).toBeNull();
    expect(body.preset_kind).toBeNull();
    expect(body.params.duration).toBe(3);
    expect(body.params.camera_path).toBeUndefined();
    expect(body.params.prompt).toBe("a boat on the water");
    expect(String(body.params.prompt)).not.toContain("barrel");
    expect(String(body.params.image_url)).toMatch(/^\/files\//);
  });
});
