import { expect, test } from "@playwright/test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, existsSync, readdirSync, statSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The whole CLI loop against the real app: UI sign-up → API key
 * from /settings/keys → install-cli into a temp prefix → login (verified
 * against /api/v1/me before anything is written) → the plan's exact
 * generate --wait --json check → download → whoami/status/skills.
 */
test("[OF-0824] cli: signup → key → login → generate --wait --json → download", async ({ page, baseURL }) => {
  test.setTimeout(300_000);
  const email = `cli-${Date.now()}@e2e.test`;

  // UI sign-up (headless)
  await page.goto("/signup");
  await page.getByPlaceholder("Display name").fill("CLI E2E");
  await page.getByPlaceholder("you@email.com").fill(email);
  await page.getByPlaceholder(/Password/).fill("e2e-password-123");
  await page.getByRole("button", { name: /Get 50 credits/ }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/signup"), { timeout: 30_000 });

  // create a key through the keys panel - the token appears once
  await page.goto("/settings/keys");
  await page.getByTestId("key-label").fill("cli-e2e");
  await page.getByTestId("create-key").click();
  const keyEl = page.getByTestId("key-value");
  await expect(keyEl).toBeVisible({ timeout: 15_000 });
  const key = (await keyEl.textContent())!.trim();
  expect(key).toMatch(/^of_/);

  // install the CLI into a throwaway prefix - same path a user runs
  const prefix = mkdtempSync(join(tmpdir(), "of-cli-e2e-prefix-"));
  const cfgDir = mkdtempSync(join(tmpdir(), "of-cli-e2e-cfg-"));
  execFileSync("scripts/install-cli.sh", [], {
    env: { ...process.env, PREFIX: prefix }, stdio: "pipe",
  });
  const motionfield = join(prefix, "bin", "motionfield");
  const env = { ...process.env, MOTIONFIELD_CONFIG_DIR: cfgDir };
  const cli = (args: string[]) =>
    execFileSync(motionfield, args, { env, encoding: "utf8", timeout: 240_000 });

  // a bad key fails the /api/v1/me verification - exit 1, nothing written
  const badLogin = spawnSync(motionfield,
    ["login", "--url", baseURL!, "--key", "of_nope_badsecret"], {
      env, encoding: "utf8", timeout: 60_000,
    });
  expect(badLogin.status).toBe(1);
  expect(badLogin.stderr).toContain("unauthorized");
  expect(existsSync(join(cfgDir, "config.json"))).toBe(false);

  // login → config.json; the key is never echoed
  const login = cli(["login", "--url", baseURL!, "--key", key]);
  expect(login).toContain("logged in");
  expect(login).not.toContain(key);

  // whoami - the real user, from the stored config
  const meOut = cli(["whoami", "--json"]);
  const me = JSON.parse(meOut);
  expect(me.email).toBe(email);
  expect(me.key.label).toBe("cli-e2e");
  expect(meOut).not.toContain(key);

  // MOTIONFIELD_API_KEY alone resolves against the default
  // http://localhost:3000 - a connection result, not a usage error
  const envOnly: NodeJS.ProcessEnv = {
    ...process.env,
    MOTIONFIELD_CONFIG_DIR: mkdtempSync(join(tmpdir(), "of-cli-e2e-envonly-")),
    MOTIONFIELD_API_KEY: key,
  };
  delete envOnly.MOTIONFIELD_URL;
  const envStatus = spawnSync(motionfield, ["status", "--json"], {
    env: envOnly, encoding: "utf8", timeout: 60_000,
  });
  expect(envStatus.status).not.toBe(2);

  // catalog + estimate
  const models = JSON.parse(cli(["models", "--json"]));
  const image = models.models.find((m: { kind: string }) => m.kind === "image");
  expect(image).toBeTruthy();
  const est = JSON.parse(cli(["estimate", image.id, "-p", "prompt=lighthouse", "--json"]));
  expect(est.credits).toBeGreaterThan(0);

  // the money shot - the plan's literal check, submit + poll over the real API
  const jobOut = cli([
    "generate", "motionfield/z-image-turbo/text-to-image",
    "-p", "prompt=cat",
    "--wait", "--json",
  ]);
  const job = JSON.parse(jobOut); // stdout is the job object, nothing else
  expect(job.id).toBeTruthy();
  expect(job.status).toBe("completed");
  expect(job.outputs.length).toBeGreaterThan(0);
  expect(job.outputs[0].type).toMatch(/^image\//);
  expect(jobOut).not.toContain(key);

  // download every output into a fresh dir - each file has real bytes
  const outDir = mkdtempSync(join(tmpdir(), "of-cli-e2e-out-")) + "/";
  const dl = JSON.parse(cli(["download", job.id, "-o", outDir, "--json"]));
  expect(dl.files.length).toBeGreaterThan(0);
  for (const f of dl.files) {
    expect(existsSync(f)).toBe(true);
    expect(statSync(f).size).toBeGreaterThan(0);
  }
  expect(readdirSync(outDir).length).toBeGreaterThan(0);

  // [OF-0835] -i 0 writes the first output to a single named file - index 0
  // is valid, and the bytes are the ones the result endpoint served
  const oneDir = mkdtempSync(join(tmpdir(), "of-cli-e2e-one-"));
  const oneFile = join(oneDir, "one.png");
  const dlOne = JSON.parse(cli(["download", job.id, "-i", "0", "-o", oneFile, "--json"]));
  expect(dlOne.files).toEqual([oneFile]);
  expect(statSync(oneFile).size).toBeGreaterThan(0);
  expect(readFileSync(oneFile)).toEqual(readFileSync(dl.files[0]));

  // a negative or non-numeric index is a usage error - rejected before any API call
  for (const bad of ["-1", "x"]) {
    const r = spawnSync(motionfield,
      ["download", job.id, "-i", bad, "-o", join(oneDir, `bad-${bad}.png`)], {
        env, encoding: "utf8", timeout: 60_000,
      });
    expect(r.status).toBe(2);
  }

  // list / status / system / skills round-trip
  const list = JSON.parse(cli(["list", "--limit", "5", "--json"]));
  expect(list.jobs.some((j: { id: string }) => j.id === job.id)).toBe(true);

  const sys = JSON.parse(cli(["status", "--json"]));
  expect(sys).toHaveProperty("queue");
  expect(sys).toHaveProperty("gpu");
  expect(sys).toHaveProperty("tier");

  const skills = JSON.parse(cli(["skills", "list", "--json"]));
  expect(skills.skills.length).toBeGreaterThan(0);

  /* ---- runs over the same key: plan file → wait → done; edit rev; cancel ---- */

  const runPlan = join(mkdtempSync(join(tmpdir(), "of-cli-e2e-run-")), "plan.json");
  writeFileSync(runPlan, JSON.stringify({
    title: "cli run e2e",
    steps: [{ id: "s1", title: "frame", endpoint_id: image.id,
      params: { prompt: "cli run cat" }, depends_on: [] }],
  }));

  // create --plan --wait --json: the whole loop through the installed bin
  const runOut = cli(["runs", "create", "--plan", runPlan, "--wait", "--json"]);
  const run = JSON.parse(runOut);
  expect(run.id).toMatch(/^[0-9a-f-]{36}$/);
  expect(run.status).toBe("done");
  expect(run.steps).toHaveLength(1);
  expect(run.steps[0].id).toBe("s1");
  expect(run.steps[0].outputs[0].url).toMatch(/^\/files\//);
  expect(run.steps[0].outputs[0].type).toMatch(/^image\//);
  expect(run.steps[0].outputs[0].bytes).toBeGreaterThan(0);
  expect(runOut).not.toContain(key);

  // an ask_first run parks - edits take step id + --rev, a stale rev is a
  // clean error (exit 1, the code on stderr), never a silent retry
  const parked = JSON.parse(cli(["runs", "create", "--plan", runPlan, "--ask-first", "--json"]));
  expect(parked.status).toBe("awaiting_approval");
  const rev = parked.steps[0].rev;
  const edited = JSON.parse(cli([
    "runs", "edit", parked.id, "s1", "--rev", String(rev),
    "-p", "prompt=a second pass", "--json",
  ]));
  expect(edited.steps[0].rev).toBeGreaterThan(rev);
  const stale = spawnSync(motionfield, [
    "runs", "edit", parked.id, "s1", "--rev", String(rev), "-p", "prompt=again",
  ], { env, encoding: "utf8", timeout: 60_000 });
  expect(stale.status).toBe(1);
  expect(stale.stderr).toContain("stale_revision");
  // human mode names the head rev too - the retry isn't guesswork
  expect(stale.stderr).toContain(`head rev ${edited.steps[0].rev}`);

  // cancel is the user-facing alias - control sees stop
  const stopped = JSON.parse(cli(["runs", "control", parked.id, "cancel", "--json"]));
  expect(stopped.status).toBe("stopped");

  // non-uuid ids are refused before any request - exit 2 usage
  const bad = spawnSync(motionfield, ["runs", "get", "r_123"], {
    env, encoding: "utf8", timeout: 30_000,
  });
  expect(bad.status).toBe(2);
});
