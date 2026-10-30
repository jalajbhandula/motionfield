import { expect, request as playwrightRequest, test, type APIRequestContext } from "@playwright/test";

const base = `http://localhost:${process.env.PORT || "3100"}`;

// sign-ups serialize (PGlite profile hook)
test.describe.configure({ mode: "serial" });

async function signupCtx(label: string): Promise<APIRequestContext> {
  const ctx = await playwrightRequest.newContext({ baseURL: base, extraHTTPHeaders: { origin: base } });
  const email = `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.local`;
  const password = "test-pass-1234";
  for (let i = 0; i < 5; i++) {
    if ((await ctx.post("/api/auth/sign-up/email", { data: { email, password, name: "Games" } })).ok()
      || (await ctx.post("/api/auth/sign-in/email", { data: { email, password } })).ok()) return ctx;
    await new Promise((r) => setTimeout(r, 400 * (i + 1)));
  }
  throw new Error(`signup/signin failed for ${email}`);
}

type GameJson = { game: { id: string; via: string; public: boolean; mine: boolean; prompt?: string; spec: { genre: string; seed: number; title: string } } };

test("games API - template path, owner-only until shared, locked-down play frame", async () => {
  test.setTimeout(180_000);
  const a = await signupCtx("games-a");
  const b = await signupCtx("games-b");
  const anon = await playwrightRequest.newContext({ baseURL: base });

  expect((await a.post("/api/games", { data: { prompt: "x" } })).status()).toBe(400);
  expect((await a.post("/api/games", { data: { prompt: "a frog", genre: "chess" } })).status()).toBe(400);
  expect((await anon.post("/api/games", { data: { prompt: "a frog on lily pads" } })).status()).toBe(401);

  const made = await a.post("/api/games", { data: { prompt: "a tiny frog hopping across lily pads" } });
  expect(made.status()).toBe(201);
  const { game } = (await made.json()) as GameJson;
  expect(game.via).toBe("template");
  expect(game.spec.genre).toBe("platformer");
  expect(game.public).toBe(false);

  // private: the owner sees it, nobody else does
  expect((await a.get(`/api/games/${game.id}`)).status()).toBe(200);
  for (const ctx of [b, anon]) {
    expect((await ctx.get(`/api/games/${game.id}`)).status()).toBe(404);
    expect((await ctx.get(`/api/games/${game.id}/play`)).status()).toBe(404);
  }
  expect((await b.patch(`/api/games/${game.id}`, { data: { public: true } })).status()).toBe(404);
  expect((await b.delete(`/api/games/${game.id}`)).status()).toBe(404);
  expect((await a.get("/api/games/not-a-uuid")).status()).toBe(404);
  expect((await a.get("/api/games/not-a-uuid/play")).status()).toBe(404);

  // the play document: CSP pins scripts to our runtime
  const play = await a.get(`/api/games/${game.id}/play`);
  expect(play.status()).toBe(200);
  const csp = play.headers()["content-security-policy"];
  expect(csp).toContain("default-src 'none'");
  expect(csp).toContain(`script-src ${base}/games/runtime.js`);
  expect(play.headers()["x-content-type-options"]).toBe("nosniff");
  expect(play.headers()["cache-control"]).toContain("no-store");

  // edits: bad drafts bounce, reseed keeps the design and changes the layout
  expect((await a.patch(`/api/games/${game.id}`, { data: {} })).status()).toBe(400);
  expect((await a.patch(`/api/games/${game.id}`, { data: { draft: { genre: "platformer" } } })).status()).toBe(400);
  const reseeded = (await (await a.patch(`/api/games/${game.id}`, { data: { reseed: true } })).json()) as GameJson;
  expect(reseeded.game.spec.title).toBe(game.spec.title);
  expect(reseeded.game.spec.seed).not.toBe(game.spec.seed);

  // no local model in the e2e env → refine says so before doing any work
  const refine = await a.post(`/api/games/${game.id}/refine`, { data: { instruction: "make it night" } });
  expect(refine.status()).toBe(503);
  expect((await refine.json()).code).toBe("NEEDS_LLM");
  expect((await b.post(`/api/games/${game.id}/refine`, { data: { instruction: "make it night" } })).status()).toBe(404);

  // shared: anyone can view and play, but the prompt stays the owner's
  expect((await a.patch(`/api/games/${game.id}`, { data: { public: true } })).status()).toBe(200);
  const seen = (await (await anon.get(`/api/games/${game.id}`)).json()) as GameJson;
  expect(seen.game.mine).toBe(false);
  expect(seen.game.prompt).toBeUndefined();
  expect((await anon.get(`/api/games/${game.id}/play`)).status()).toBe(200);
  expect((await b.get("/api/games")).ok()).toBe(true);
  expect(((await (await b.get("/api/games")).json()) as { games: unknown[] }).games).toHaveLength(0);

  expect((await a.delete(`/api/games/${game.id}`)).status()).toBe(200);
  expect((await anon.get(`/api/games/${game.id}/play`)).status()).toBe(404);
  await Promise.all([a.dispose(), b.dispose(), anon.dispose()]);
});

test("every genre plays in the sandboxed frame without errors", async ({ page: p }) => {
  test.setTimeout(240_000);
  const email = `games-ui-${Date.now()}@test.local`;
  expect((await p.request.post("/api/auth/sign-up/email", { data: { email, password: "test-pass-1234", name: "Games UI" }, headers: { origin: base } })).ok()).toBe(true);

  for (const genre of ["platformer", "runner", "shooter", "adventure", "puzzle", "racer"]) {
    const r = await p.request.post("/api/games", { data: { prompt: `a quick ${genre} test game`, genre }, headers: { origin: base } });
    expect(r.status()).toBe(201);
    const { game } = (await r.json()) as GameJson;
    expect(game.spec.genre).toBe(genre);
    const errors: string[] = [];
    const q = await p.context().newPage();
    q.on("pageerror", (e) => errors.push(e.message));
    await q.goto(`${base}/api/games/${game.id}/play`);
    await q.locator("canvas#game").click();
    await expect.poll(() => q.evaluate(() => (window as unknown as { __ofGame?: { state: string } }).__ofGame?.state)).toBe("play");
    await q.keyboard.press("Space");
    await q.waitForTimeout(400);
    expect(errors).toEqual([]);
    await q.close();
  }

  await p.goto("/games");
  await expect(p.getByTestId("games-template-note")).toBeVisible();
  await p.getByTestId("game-prompt").fill("a ninja running across neon rooftops");
  await p.getByTestId("game-create").click();
  await expect(p.getByTestId("game-title")).toHaveText(/Ninja Running/);
  await expect(p.getByTestId("game-via")).toHaveText(/template/i);
  await expect(p.getByTestId("game-frame")).toHaveAttribute("sandbox", "allow-scripts");
  await expect(p.getByTestId("games-list").locator("button").first()).toContainText("Ninja Running");
});
