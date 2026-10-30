import { expect, test, request as pwRequest } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { existsSync, statSync, readFileSync } from "node:fs";
import { NAV_ENTRIES } from "../../src/lib/nav";

/**
 * Platform launch smoke - the judge's path.
 *  - start.sh / start.command / npm run start:local are wired and parse clean
 *  - every live nav page answers <400 (no 404s, no 500s) unauthenticated
 *  - the headline studio pages render with zero console errors under a real
 *    signed-up session
 *  - the bearer API surface 401s without a key and never leaks the key or an
 *    absolute server path in an error body
 */

test.describe.configure({ mode: "serial" });
test.beforeEach(() => { test.setTimeout(180_000); });

const base = () => `http://localhost:${process.env.PORT || "3100"}`;

const LIVE_HREFS: string[] = [
  ...new Set(
    NAV_ENTRIES.flatMap((e) => [e, ...(e.children ?? [])])
      .filter((e) => e.ready)
      .map((e) => e.href.split("?")[0])),
];

test("one-command start is wired: start.sh parses, is executable, npm script exists", () => {
  expect(existsSync("start.sh")).toBe(true);
  expect(existsSync("start.command")).toBe(true);
  expect((statSync("start.sh").mode & 0o111) !== 0).toBe(true);
  expect((statSync("start.command").mode & 0o111) !== 0).toBe(true);
  execFileSync("sh", ["-n", "start.sh"]);          // exits non-zero on a parse error
  execFileSync("sh", ["-n", "start.command"]);
  const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> };
  expect(pkg.scripts["start:local"]).toBe("sh start.sh");
  // the script really does the lane's five steps
  const sh = readFileSync("start.sh", "utf8");
  for (const needle of ["scripts/migrate.ts", "scripts/seed.ts", "pnpm run build", "next start", "8189"])
    expect(sh).toContain(needle);
});

test("every live nav page answers <400 unauthenticated", async () => {
  const api = await pwRequest.newContext({ baseURL: base() });
  try {
    for (const href of LIVE_HREFS) {
      const r = await api.get(href);
      expect(r.status(), `${href} → ${r.status()}`).toBeLessThan(400);
    }
  } finally {
    await api.dispose();
  }
});

test("headline studio pages render with zero console errors", async ({ page }) => {
  const email = `nav-${Date.now()}@e2e.test`;
  await page.goto("/signup");
  await page.getByPlaceholder("Display name").fill("Nav Smoke");
  await page.getByPlaceholder("you@email.com").fill(email);
  await page.getByPlaceholder(/Password/).fill("e2e-password-123");
  await page.getByRole("button", { name: /Get 50 credits/ }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/signup"), { timeout: 30_000 });

  for (const href of ["/generate", "/person-swap", "/effects", "/ai/image", "/ai/video"]) {
    const errors: string[] = [];
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
    const r = await page.goto(href);
    expect(r?.status(), `${href} → ${r?.status()}`).toBeLessThan(400);
    await page.waitForLoadState("networkidle");
    expect(errors, `${href} console errors: ${errors.join(" | ")}`).toEqual([]);
    page.removeAllListeners("console");
  }
});

test("v1 API: 401 without a key, 401 with a bogus key, no path leak on a bad clip", async ({ page }) => {
  const api = await pwRequest.newContext({ baseURL: base() });
  try {
    let r = await api.post("/api/v1/probe", { data: { video_url: "/files/x.mp4" } });
    expect(r.status()).toBe(401);
    r = await api.post("/api/v1/probe", {
      headers: { authorization: "Bearer of_bogus" },
      data: { video_url: "/files/x.mp4" },
    });
    expect(r.status()).toBe(401);
    r = await api.post("/api/v1/jobs", { data: { endpoint: "motionfield/z-image-turbo/text-to-image", params: {} } });
    expect(r.status()).toBe(401);
  } finally {
    await api.dispose();
  }

  // signed-up user + real key → ownership/traversal guards, then a readable
  // error that never contains the server's absolute storage path
  const email = `probe-${Date.now()}@e2e.test`;
  await page.goto("/signup");
  await page.getByPlaceholder("Display name").fill("Probe Guard");
  await page.getByPlaceholder("you@email.com").fill(email);
  await page.getByPlaceholder(/Password/).fill("e2e-password-123");
  await page.getByRole("button", { name: /Get 50 credits/ }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/signup"), { timeout: 30_000 });
  const kr = await page.request.post("/api/keys", { data: { label: "probe-e2e" } });
  expect(kr.status()).toBe(201);
  const key = ((await kr.json()) as { key: string }).key;
  const auth = { authorization: `Bearer ${key}` };

  let r = await page.request.post("/api/v1/probe", {
    headers: auth, data: { video_url: "https://evil.example/clip.mp4" },
  });
  expect(r.status()).toBe(400);                       // external urls refused
  r = await page.request.post("/api/v1/probe", {
    headers: auth, data: { video_url: "/files/../secret.txt" },
  });
  expect([400, 404]).toContain(r.status());            // traversal never resolves
  r = await page.request.post("/api/v1/probe", {
    headers: auth, data: { video_url: "/files/not-mine.mp4" },
  });
  expect(r.status()).toBe(404);                        // unowned → 404, no existence leak
  const body = await r.text();
  expect(body).not.toContain(key);
  expect(body).not.toMatch(/\/Users\/|\/var\/|\/tmp\//); // no absolute server path
});
