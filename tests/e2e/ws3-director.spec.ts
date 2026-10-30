/**
 * Director e2e (GENERATION_PROVIDER=mock via playwright.config):
 *  - the endpoint defaults to Wan VACE - a full control set submits open:
 *    moves stack, lens/sensor/aperture/body, era/genre/pacing, emotion,
 *    lights and ≤50 refs (the first 3 feed VACE)
 *  - backend:"ltx" is the restricted opt-in - 403 before opt-in, accepted after
 *  - every advertised control is enforced: >3-move stacks, >2 lights, unknown
 *    lights, >50 refs, out-of-range strength/distance and unknown backends
 *    all refuse 400 before any charge
 *  - a typed move phrase is accepted (prompt-guided - it steers the prompt)
 *  - on /generate?model=director the control row renders, a typed move shows
 *    the prompt-guided chip, ltx carries a restricted badge, and restricted
 *    models stay out of the picker until the opt-in
 */
import { test, expect } from "@playwright/test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

// sign-up fires a profile-insert hook that can't see a concurrently-committing
// user row on PGlite - keep the sign-ups serial.
test.describe.configure({ mode: "serial" });

const EP = "motionfield/director/generate";

async function signUp(request: import("@playwright/test").APIRequestContext, tag: string) {
  const email = `ws3dir-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.local`;
  const su = await request.post("/api/auth/sign-up/email", {
    data: { email, password: "test-pass-1234", name: "WS3 Director" },
  });
  expect(su.ok(), `signup: ${su.status()}`).toBeTruthy();
}

test.describe("ws3 director", () => {
  test("[OF-0144] default is Wan VACE - a full control set submits open and stores every control", async ({ request }) => {
    await signUp(request, "full");

    // every advertised control in one shot - proves each param is accepted
    // and lands on the stored job (no control without a consumer)
    const params = {
      prompt: "a saxophonist under a streetlamp",
      image_url: "/files/start.png",
      duration: 3,
      aspect_ratio: "16:9",
      resolution: "480p",
      moves: "dolly-in+pan-left",
      strength: 1.4,
      distance: 6,
      camera_lens: "portrait-85",
      camera_sensor: "super35",
      camera_aperture: "f1.4",
      camera_body: "35mm-film",
      era: "1980s",
      genre: "noir",
      pacing: "contemplative",
      color_palette: "cinema-amber",
      emotion: "sorrow",
      emotion_intensity: "moderate",
      lights: "az45:el30:warm:soft+az200:el10:cool:hard",
      image_urls: ["/files/ref-a.png", "/files/ref-b.png"],
      seed: 1234,
      negative_prompt: "blur, jitter",
    };
    const r = await request.post("/api/jobs", { data: { endpoint_id: EP, params } });
    expect(r.status()).toBe(201);
    const job = (await r.json()).job;
    for (const [k, v] of Object.entries(params))
      expect(job.params, k).toEqual(expect.objectContaining({ [k]: v }));
    if (job?.id) await request.post(`/api/jobs/${job.id}/cancel`);
  });

  test("[OF-0145] backend ltx is the restricted opt-in - 403 without opt-in, accepted after; wan-vace stays open", async ({ request }) => {
    await signUp(request, "gate");

    // default (no backend) → open Wan VACE path
    let r = await request.post("/api/jobs", {
      data: { endpoint_id: EP, params: { prompt: "a red door", duration: 2 } },
    });
    expect(r.status()).toBe(201);
    const job = (await r.json()).job;
    if (job?.id) await request.post(`/api/jobs/${job.id}/cancel`);

    // backend:"ltx" → restricted, structured 403
    r = await request.post("/api/jobs", {
      data: { endpoint_id: EP, params: { prompt: "a red door", duration: 2, backend: "ltx" } },
    });
    expect(r.status()).toBe(403);
    const body = await r.json();
    expect(body.error.code).toBe("restricted_license");
    expect(body.error.license).toContain("LTX-2.x Community");
    expect(body.error.enable_at).toBe("/settings/licenses");

    // ltx variant with a start frame → also 403 (ltx-img2video)
    r = await request.post("/api/jobs", {
      data: { endpoint_id: EP, params: { prompt: "a red door", duration: 2, backend: "ltx", image_url: "/files/start.png" } },
    });
    expect(r.status()).toBe(403);

    // opt in → ltx submits
    r = await request.post("/api/licenses/opt-in", { data: {} });
    expect(r.status()).toBe(200);
    r = await request.post("/api/jobs", {
      data: { endpoint_id: EP, params: { prompt: "a red door", duration: 2, backend: "ltx" } },
    });
    expect(r.status()).toBe(201);
    const j2 = (await r.json()).job;
    if (j2?.id) await request.post(`/api/jobs/${j2.id}/cancel`);
  });

  test("[OF-0146] control bounds refuse 400 with no charge: >3-move stacks, >2 lights, unknown lights, >50 refs, out-of-range sliders, unknown backend", async ({ request }) => {
    await signUp(request, "bounds");
    const me0 = await (await request.get("/api/me")).json();
    const before = Number(me0.profile.credits);

    const cases: { name: string; params: Record<string, unknown>; match: RegExp }[] = [
      { name: "4-move stack", params: { moves: "dolly-in+pan-left+tilt-up+arc-left" }, match: /1-3|1-3/ },
      { name: "3 lights", params: { lights: "az45:el30:warm:soft+az200:el10:cool:hard+az0:el0:warm:soft" }, match: /at most 2/i },
      { name: "bad light spec", params: { lights: "stage-spot" }, match: /bad light spec/i },
      { name: "light az out of range", params: { lights: "az400:el30:warm:soft" }, match: /bad light spec/i },
      { name: "51 refs", params: { image_urls: Array.from({ length: 51 }, (_, i) => `/files/r${i}.png`) }, match: /50/i },
      { name: "strength over", params: { strength: 3 }, match: /strength/i },
      { name: "strength under", params: { strength: 0.1 }, match: /strength/i },
      { name: "distance over", params: { distance: 200 }, match: /distance/i },
      { name: "unknown backend", params: { backend: "wan2.2" }, match: /unknown backend/i },
    ];
    for (const c of cases) {
      const r = await request.post("/api/jobs", {
        data: { endpoint_id: EP, params: { prompt: "a red door", duration: 2, ...c.params } },
      });
      expect(r.status(), c.name).toBe(400);
      const err = (await r.json()).error;
      expect(String(typeof err === "string" ? err : err?.message ?? JSON.stringify(err)), c.name).toMatch(c.match);
    }
    const me1 = await (await request.get("/api/me")).json();
    expect(Number(me1.profile.credits), "rejections must not charge").toBe(before);
  });

  test("[OF-0147] typed move phrases + catalog stacks are accepted; ≤50 refs submit", async ({ request }) => {
    await signUp(request, "moves");

    // typed phrase → prompt-guided, still a valid submission
    let r = await request.post("/api/jobs", {
      data: { endpoint_id: EP, params: { prompt: "a red door", duration: 2, moves: "sweep low across the table" } },
    });
    expect(r.status()).toBe(201);
    let job = (await r.json()).job;
    expect(job.params.moves).toBe("sweep low across the table");
    if (job?.id) await request.post(`/api/jobs/${job.id}/cancel`);

    // catalog stack executes - the focus pull runs on this rig (DepthBlur)
    r = await request.post("/api/jobs", {
      data: { endpoint_id: EP, params: { prompt: "a red door", duration: 2, moves: "dolly-in+rack-focus-near-to-far" } },
    });
    expect(r.status()).toBe(201);
    job = (await r.json()).job;
    if (job?.id) await request.post(`/api/jobs/${job.id}/cancel`);

    // exactly 50 refs submit (the first 3 condition VACE)
    r = await request.post("/api/jobs", {
      data: {
        endpoint_id: EP,
        params: { prompt: "a red door", duration: 2, image_urls: Array.from({ length: 50 }, (_, i) => `/files/r${i}.png`) },
      },
    });
    expect(r.status()).toBe(201);
    job = (await r.json()).job;
    if (job?.id) await request.post(`/api/jobs/${job.id}/cancel`);
  });

  test("[OF-0148] /generate?model=director - control row, prompt-guided chip, restricted ltx badge, hidden models", async ({ page }) => {
    await page.goto("/generate?model=director");

    // the director model lands; the control row carries its controls
    const modelBtn = page.locator("button", { hasText: "Camera Control · Wan VACE" }).first();
    await expect(modelBtn).toBeVisible();
    await expect(page.getByRole("button", { name: /Backend.*auto/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /Lens.*standard-35/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /Aperture.*f8/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /Body.*modern/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /Sensor.*full_frame/ })).toBeVisible();

    // restricted models are hidden without opt-in - neither LTX-Video nor the
    // LTX lens skin appears in the model dropdown
    await modelBtn.click();
    await expect(page.getByRole("button", { name: /LTX-2.5/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Camera Motion \(opt-in\)/ })).toHaveCount(0);
    // the open models remain
    await expect(page.getByRole("button", { name: /CameraRig/ })).toBeVisible();
    await modelBtn.click(); // close (Drop toggles)

    // the backend dropdown hides restricted values before the opt-in - auto,
    // wan-vace and wan-fun are offered (ltx appears badged after opt-in - see OF-0149)
    await page.getByRole("button", { name: /Backend.*auto/ }).click();
    await expect(page.getByRole("button", { name: /^wan-vace/ }).getByText(/Open ·/)).toBeVisible();
    await expect(page.getByRole("button", { name: /^wan-fun/ }).getByText(/Open ·/)).toBeVisible();
    await expect(page.getByRole("button", { name: /^ltx/ })).toHaveCount(0);
    await page.getByRole("button", { name: /Backend.*auto/ }).click(); // close

    // a typed move shows the prompt-guided chip before submit
    await page.getByPlaceholder(/or type a move/).fill("float above the rooftops");
    await expect(page.getByText("prompt-guided")).toBeVisible();

    // a catalog stack typed in clears the chip - it executes
    await page.getByPlaceholder(/or type a move/).fill("dolly-in");
    await expect(page.getByText("prompt-guided")).toHaveCount(0);

    // a mixed phrase - one runnable id + one unrunnable chunk - shows the
    // "partly prompt-guided" chip, not the flat prompt-guided one
    await page.getByPlaceholder(/or type a move/).fill("dolly in then swoop low");
    await expect(page.getByText("partly prompt-guided")).toBeVisible();
    await expect(page.getByText("Dolly In", { exact: true })).toBeVisible();

    // a "+"-joined stack with an unrunnable catalog id resolves the same way -
    // the runnable half chips by label, the rest steers the prompt. Clear the
    // field first: the Dolly In chip from the previous fill must be gone, or
    // the assertions below can't tell the new resolution from the old.
    await page.getByPlaceholder(/or type a move/).fill("");
    await expect(page.getByText("Dolly In", { exact: true })).toHaveCount(0);
    await page.getByPlaceholder(/or type a move/).fill("dolly-in+eye-push");
    await expect(page.getByText("Dolly In", { exact: true })).toBeVisible();
    await expect(page.getByText("partly prompt-guided")).toBeVisible();
  });

  test("[OF-0151] POV on the director rides out as its title - the zero-stack pick stays an honest prompt-guided move", async ({ page }) => {
    const email = `ws3dir-pov-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@test.local`;
    const su = await page.request.post("/api/auth/sign-up/email", {
      data: { email, password: "test-pass-1234", name: "WS3 POV" },
    });
    expect(su.ok()).toBeTruthy();

    await page.goto("/generate?model=director");
    // POV carries no executable stack - on the director it stays pickable as
    // a guided row, and its title is what the submit sends as params.moves
    await page.getByRole("button", { name: /Camera\s+Static/ }).click();
    const pov = page.getByRole("button", { name: /^POV/ });
    await expect(pov).toBeEnabled();
    await expect(pov.getByText(/steers the prompt/)).toBeVisible();
    await pov.click();
    await expect(page.getByRole("button", { name: /Camera\s+POV/ })).toBeVisible();

    await page.getByPlaceholder(/Describe your scene/).fill("crow's-eye over a street market");
    const req = page.waitForRequest((r) => r.url().includes("/api/jobs") && r.method() === "POST");
    await page.getByRole("button", { name: /GENERATE/i }).click();
    const body = (await req).postDataJSON() as { params: Record<string, unknown> };
    // the title goes out verbatim - the server resolves it to a prompt-guided
    // clause, never silently locked-off
    expect(body.params.moves).toBe("object-pov");
  });

  test("[OF-0149] UI drives every control - the job payload carries them all; >3 refs pick one per @element; ltx absent→badged", async ({ page }) => {
    // sign up through the context-bound request so the session cookie lands
    const email = `ws3dir-ui-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@test.local`;
    const su = await page.request.post("/api/auth/sign-up/email", {
      data: { email, password: "test-pass-1234", name: "WS3 UI" },
    });
    expect(su.ok(), `signup: ${su.status()}`).toBeTruthy();

    // four prop refs, two images each - the interleave promise is "one per
    // @element": the first image of each element leads the reference list
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
    const names = ["alley-cat", "neon-sign", "rain-coat", "taxi-cab"];
    const first: string[] = [];
    for (const n of names) {
      const elImgs: string[] = [];
      for (let i = 0; i < 2; i++) {
        const up = await page.request.post("/api/uploads", {
          multipart: { file: { name: `${n}-${i}.png`, mimeType: "image/png", buffer: png } },
        });
        expect(up.ok()).toBeTruthy();
        elImgs.push((await up.json()).url as string);
      }
      first.push(elImgs[0]);
      const ref = await page.request.post("/api/refs", {
        data: { name: n, category: "prop", kind: "prop", images: elImgs },
      });
      expect(ref.ok(), `ref ${n}: ${ref.status()}`).toBeTruthy();
    }

    await page.goto("/generate?model=director");
    await expect(page.getByRole("button", { name: /Backend.*auto/ })).toBeVisible();

    // no audio or video-ref inputs exist on the director surface - the only
    // file input is the optional image start frame
    const files = page.locator('input[type="file"]');
    await expect(files).toHaveCount(1);
    await expect(files).toHaveAttribute("accept", "image/*");

    const drop = async (labelRe: RegExp, optionRe: RegExp) => {
      await page.getByRole("button", { name: labelRe }).first().click();
      await page.getByRole("button", { name: optionRe }).first().click();
    };

    // camera rig controls
    await drop(/^Lens/, /^portrait-85/);
    await drop(/^Sensor/, /^super35/);
    await drop(/^Aperture/, /^f1\.4/);
    await drop(/^Body/, /^35mm-film/);
    // distance + strength sliders
    await page.locator('input[type="number"]').fill("6");
    await page.locator('input[type="range"]').fill("1.4");

    // look picks - style panel + palette
    await drop(/^Color palette/, /^cinema amber/);
    await page.getByRole("button", { name: /Style & lights/ }).click();
    await drop(/^Era/, /^1980s/);
    await drop(/^Genre/, /^noir/);
    await drop(/^Pacing/, /^contemplative/);

    // emotion wheel - sorrow × moderate
    await page.locator('[data-emotion="sorrow"][data-intensity="moderate"]').click();

    // light dome - click two positions (az≈45/el≈30, az≈200/el≈10), then set
    // the second light cool+hard (it auto-selects after placement)
    const dome = page.locator("svg[data-lightdome]");
    await dome.click({ position: { x: 124, y: 124 } });
    await dome.click({ position: { x: 65, y: 24 } });
    await page.getByTitle("cool", { exact: true }).click();
    await page.getByRole("button", { name: "hard", exact: true }).click();

    // aspect drop shows "16:9" - switch to 4:3
    await drop(/^16:9/, /^4:3/);

    // camera preset - "Barrel Roll" carries a 2-move core stack
    await page.getByRole("button", { name: /Camera/ }).first().click();
    await page.getByRole("button", { name: /^Barrel Roll/ }).click();

    // refs via @-mentions - all four elements
    const ta = page.getByPlaceholder(/Describe your scene/);
    await ta.fill("a saxophonist under a streetlamp ");
    for (const n of names) {
      await ta.pressSequentially(`@${n}`);
      // the mention row's accessible name splits "@ name category" - the
      // @ lives in its own span
      await page.getByRole("button", { name: new RegExp(`@ ?${n}`) }).first().click();
    }
    // the honest pick label sits next to the chips
    await expect(page.getByText(/we pick the best few \(one per @element, max 3\)/)).toBeVisible();

    // submit 1 - every control lands in the request payload
    const req1 = page.waitForRequest((r) => r.url().includes("/api/jobs") && r.method() === "POST");
    await page.getByRole("button", { name: /GENERATE/i }).click();
    const body1 = (await req1).postDataJSON() as { endpoint_id: string; params: Record<string, unknown> };
    expect(body1.endpoint_id).toBe(EP);
    expect(body1.params).toMatchObject({
      camera_lens: "portrait-85",
      camera_sensor: "super35",
      camera_aperture: "f1.4",
      camera_body: "35mm-film",
      era: "1980s",
      genre: "noir",
      pacing: "contemplative",
      color_palette: "cinema-amber",
      emotion: "sorrow",
      emotion_intensity: "moderate",
      aspect_ratio: "4:3",
      duration: 3,
      distance: 6,
      strength: 1.4,
      // the 2-move preset stack reaches params.moves as a 2-element stack
      moves: "arc-left-45+dutch-roll-cw",
    });
    expect(String(body1.params.prompt)).toContain("saxophonist");
    expect(String(body1.params.lights)).toMatch(/^az\d{1,3}:el\d{1,2}:warm:soft\+az\d{1,3}:el\d{1,2}:cool:hard$/);
    // 8 refs sent; the first 3 (what VACE conditions on) are the FIRST image
    // of three different elements - the round-robin leads one-per-element
    const urls = body1.params.image_urls as string[];
    expect(urls).toHaveLength(8);
    expect(urls.slice(0, 4)).toEqual(first);
    expect(urls.slice(0, 3)).toEqual(first.slice(0, 3));
    expect(new Set(urls.slice(0, 3)).size).toBe(3);

    // typed move - "dolly in" parses to an id chip; the tail goes prompt-guided
    await page.getByPlaceholder(/or type a move/).fill("dolly in then swoop low");
    await expect(page.getByText("Dolly In", { exact: true })).toBeVisible();
    await expect(page.getByText("prompt-guided")).toBeVisible();
    const req2 = page.waitForRequest((r) => r.url().includes("/api/jobs") && r.method() === "POST");
    await page.getByRole("button", { name: /GENERATE/i }).click();
    const body2 = (await req2).postDataJSON() as { params: Record<string, unknown> };
    expect(body2.params.moves).toBe("dolly in then swoop low");

    // ltx stays hidden until opt-in, then shows with its restricted badge
    const opt = await page.request.post("/api/licenses/opt-in", { data: {} });
    expect(opt.status()).toBe(200);
    await page.reload();
    await page.getByRole("button", { name: /Backend.*auto/ }).click();
    const ltxOpt = page.getByRole("button", { name: /^ltx/ });
    await expect(ltxOpt).toBeVisible();
    await expect(ltxOpt.getByText(/Restricted · opt-in/)).toBeVisible();
  });

  test("[OF-0150] /ai/video opens on LTX-2.5 with its license shown; Wan 2.2 5B (Apache-2.0) is the next pick", async ({ page }) => {
    await page.goto("/ai/video");
    await expect(page.getByTestId("studio-model")).toHaveAttribute("data-value", "ltx-video");
    await expect(page.getByText(/Restricted · opt-in/).first()).toBeVisible();

    // ?model=wan-2-2 lands on the TI2V-5B workflow (the default chip) - the
    // A14B rows sit behind "(cloud quality)" chips + the heavy warning, never
    // the default pick
    await page.goto("/ai/video?model=wan-2-2");
    await expect(page.getByTestId("studio-model")).toHaveAttribute("data-value", "wan-2-2");
    await expect(page.getByRole("button", { name: /^Image to video/ })).toHaveClass(/chip-on/);
    const a14bI2v = page.getByRole("button", { name: /^A14B I2V \(cloud quality\)/ });
    const a14bT2v = page.getByRole("button", { name: /^A14B T2V \(cloud quality\)/ });
    await expect(a14bI2v).toBeVisible();
    await expect(a14bT2v).toBeVisible();
    await expect(a14bI2v).not.toHaveClass(/chip-on/);
    await expect(a14bT2v).not.toHaveClass(/chip-on/);
    await a14bT2v.click();
    await expect(page.getByText(/Heavy workflow - Cloud quality tier/)).toBeVisible();

    // /generate never opens on a cloud tier either - the Director leads there
    await page.goto("/generate");
    await expect(page.getByRole("button", { name: /Camera Control · Wan VACE/ }).first()).toBeVisible();
  });

  test("[OF-0152] backend routing - wan-fun submits open; refs/aperture on wan-fun refuse 400; auto + add_sound + seed land", async ({ request }) => {
    await signUp(request, "route");

    // wan-fun is an open path (Apache-2.0 weights) - a plain submit works
    let r = await request.post("/api/jobs", {
      data: { endpoint_id: EP, params: { prompt: "a red door", duration: 2, backend: "wan-fun" } },
    });
    expect(r.status()).toBe(201);
    let job = (await r.json()).job;
    if (job?.id) await request.post(`/api/jobs/${job.id}/cancel`);

    // controls with no consumer on wan-fun refuse - never silently dropped
    r = await request.post("/api/jobs", {
      data: { endpoint_id: EP, params: { prompt: "a red door", duration: 2, backend: "wan-fun", image_urls: ["/files/r.png"] } },
    });
    expect(r.status()).toBe(400);
    expect(String((await r.json()).error)).toMatch(/references|wan-vace/i);

    r = await request.post("/api/jobs", {
      data: { endpoint_id: EP, params: { prompt: "a red door", duration: 2, backend: "wan-fun", camera_aperture: "f1.4" } },
    });
    expect(r.status()).toBe(400);
    expect(String((await r.json()).error)).toMatch(/aperture|wan-vace/i);

    // auto + refs reroutes to the VACE rig instead of refusing
    r = await request.post("/api/jobs", {
      data: {
        endpoint_id: EP,
        params: { prompt: "a red door", duration: 2, backend: "auto", image_urls: ["/files/r.png"], add_sound: true, seed: 4242 },
      },
    });
    expect(r.status()).toBe(201);
    job = (await r.json()).job;
    expect(job.params.add_sound).toBe(true);
    expect(job.params.seed).toBe(4242);
    if (job?.id) await request.post(`/api/jobs/${job.id}/cancel`);
  });

  test("[OF-0153] Enhance rewrites via the enhancer route (stub LLM); the Sound toggle chains a post-mix sfx job", async ({ page }) => {
    test.setTimeout(240_000);
    // one stub OpenAI server answers both tasks - enhancer text for the
    // director rewrite, a cue envelope for the video→sfx vision plan
    const calls: string[] = [];
    const stub = createServer((req, res) => {
      if (req.method === "POST" && req.url === "/v1/chat/completions") {
        let body = "";
        req.on("data", (d) => { body += d; });
        req.on("end", () => {
          calls.push(body);
          const isEnhancer = body.includes("cinematography");
          const content = isEnhancer
            ? "A lone saxophonist beneath a sodium streetlamp, breath fogging in the cold, amber puddle-light on wet asphalt, slow dolly in"
            : JSON.stringify({ cues: [{ t_start: 0, t_end: 2, prompt: "soft vinyl crackle" }] });
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({
            choices: [{ message: { role: "assistant", content } }],
            usage: { prompt_tokens: 20, completion_tokens: 30 },
          }));
        });
        return;
      }
      res.writeHead(404); res.end();
    });
    await new Promise<void>((r) => stub.listen(0, "127.0.0.1", r));
    const stubPort = (stub.address() as AddressInfo).port;

    try {
      // page.request shares the browser cookie jar - sign up through it so
      // the page itself is authed when it calls /api/director/enhance
      const email = `ws3dir-sound-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@test.local`;
      const su = await page.request.post("/api/auth/sign-up/email", {
        data: { email, password: "test-pass-1234", name: "WS3 Sound" },
      });
      expect(su.ok()).toBeTruthy();

      // Settings-saved provider + routes for enhancer and vision
      const prov = await page.request.put("/api/llm/providers/custom", {
        data: { baseUrl: `http://127.0.0.1:${stubPort}/v1` },
      });
      expect(prov.status(), await prov.text()).toBe(200);
      for (const task of ["enhancer", "vision"]) {
        const route = await page.request.put(`/api/llm/routes/${task}`, {
          data: { providerId: "custom", model: "stub-1" },
        });
        expect(route.status(), await route.text()).toBe(200);
      }
      // video→sfx is a license-gated recipe - opt in like a real user
      expect((await page.request.post("/api/licenses/opt-in", { data: {} })).ok()).toBeTruthy();

      await page.goto("/generate?model=director");
      await expect(page.getByRole("button", { name: /Backend.*auto/ })).toBeVisible();

      // a typed two-move stack + the sound toggle
      await page.getByPlaceholder(/or type a move/).fill("dolly-in+pan-left");
      await page.getByRole("button", { name: /Sound off/ }).click();
      await expect(page.getByRole("button", { name: /Sound on/ })).toBeVisible();

      // Enhance → the draft box shows the stub rewrite, never auto-applies
      await page.getByPlaceholder(/Describe your scene/).fill("a saxophonist under a streetlamp");
      await page.getByRole("button", { name: /Enhance/ }).click();
      const draft = page.locator("[data-enhanced-draft]");
      await expect(draft).toBeVisible({ timeout: 30_000 });
      await expect(draft).toContainText("saxophonist");
      // Dismiss would drop it - accept replaces the scene text
      await page.getByRole("button", { name: "Use this" }).click();
      await expect(page.getByPlaceholder(/Describe your scene/)).toHaveValue(/sodium streetlamp/);

      // submit - the payload carries the enhanced prompt + moves + add_sound
      const req = page.waitForRequest((r) => r.url().includes("/api/jobs") && r.method() === "POST");
      await page.getByRole("button", { name: /GENERATE/i }).click();
      const body = (await req).postDataJSON() as { params: Record<string, unknown> };
      expect(body.params.prompt).toContain("sodium streetlamp");
      expect(body.params.moves).toBe("dolly-in+pan-left");
      expect(body.params.add_sound).toBe(true);
      expect(typeof body.params.seed).toBe("number");

      // the take completes under mock; the chain posts a video→sfx job -
      // the parent card shows the mix state and the job list carries the child
      await expect(page.getByText(/sound:/)).toBeVisible({ timeout: 90_000 });
      const deadline = Date.now() + 90_000;
      let sfx: { id: string; status: string } | undefined;
      while (Date.now() < deadline) {
        const jobs = (await (await page.request.get("/api/jobs?limit=20")).json()).jobs as { id: string; status: string; endpointId: string }[];
        sfx = jobs.find((j) => j.endpointId === "motionfield/moss/video-sfx");
        if (sfx && !["queued", "in_progress"].includes(sfx.status)) break;
        await new Promise((r) => setTimeout(r, 1500));
      }
      expect(sfx, "a chained video→sfx job must exist once the take completes").toBeTruthy();
      expect(sfx!.status).toBe("completed");
    } finally {
      stub.close();
    }
  });

  test("[OF-0154] enhance endpoint - logged out 401; no enhancer route 503 NEEDS_LLM", async ({ request }) => {
    let r = await request.post("/api/director/enhance", { data: { prompt: "a boat" } });
    expect(r.status()).toBe(401);
    await signUp(request, "enh");
    r = await request.post("/api/director/enhance", { data: { prompt: "a boat" } });
    expect(r.status()).toBe(503);
    const body = await r.json();
    expect(body.code).toBe("NEEDS_LLM");
  });
});
